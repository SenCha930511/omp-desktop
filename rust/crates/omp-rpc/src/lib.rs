use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use base64::Engine;
use serde_json::Value;

const MAX_CHUNK_BYTES: usize = 64 * 1024 * 1024;
const MAX_CHUNKS: usize = 4_096;
const MAX_TOTAL_CHUNK_BYTES: usize = 128 * 1024 * 1024;
const MAX_LINE_BYTES: usize = 16 * 1024 * 1024;
const CHUNK_TTL: Duration = Duration::from_secs(30);

#[derive(Debug)]
pub enum RpcError {
    Spawn(String),
    Closed(String),
    Timeout(String),
    Protocol(String),
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Spawn(message)
            | Self::Closed(message)
            | Self::Timeout(message)
            | Self::Protocol(message) => write!(formatter, "{message}"),
        }
    }
}

impl std::error::Error for RpcError {}

pub type Result<T> = std::result::Result<T, RpcError>;

struct ChunkAssembly {
    count: usize,
    parts: Vec<Option<Vec<u8>>>,
    received: usize,
    bytes: usize,
    created_at: Instant,
}

struct Shared {
    pending: Mutex<HashMap<u64, Sender<Value>>>,
    events: Mutex<Vec<Value>>,
    chunks: Mutex<HashMap<String, ChunkAssembly>>,
    closed: AtomicBool,
    stderr: Mutex<String>,
}

impl Shared {
    fn fail_all(&self, reason: &str) {
        self.closed.store(true, Ordering::SeqCst);
        let mut pending = self.pending.lock().expect("pending lock");
        for (_, sender) in pending.drain() {
            let _ = sender.send(serde_json::json!({ "__closed": true, "message": reason }));
        }
    }

    fn push_event(&self, event: Value) {
        let mut events = self.events.lock().expect("events lock");
        if events.len() < 100_000 {
            events.push(event);
        }
    }
}

pub struct RpcClient {
    child: Mutex<Child>,
    writer: mpsc::SyncSender<String>,
    shared: Arc<Shared>,
    next_id: AtomicU64,
}

impl Drop for RpcClient {
    fn drop(&mut self) {
        self.shared.closed.store(true, Ordering::SeqCst);
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

pub struct RpcOptions {
    pub executable: std::path::PathBuf,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub remove_env: Vec<String>,
    pub cwd: Option<std::path::PathBuf>,
}

impl RpcClient {
    pub fn spawn(options: RpcOptions) -> Result<Self> {
        let mut command = Command::new(&options.executable);
        command.args(&options.args);
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(cwd) = &options.cwd {
            command.current_dir(cwd);
        }
        for key in &options.remove_env {
            command.env_remove(key);
        }
        command.env("NO_COLOR", "1");
        for (key, value) in &options.env {
            command.env(key, value);
        }
        let mut child = command.spawn().map_err(|error| {
            RpcError::Spawn(format!("Could not spawn the OMP runtime: {error}"))
        })?;
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| RpcError::Spawn("OMP runtime stdin is unavailable".to_string()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| RpcError::Spawn("OMP runtime stdout is unavailable".to_string()))?;
        let stderr = child.stderr.take();
        let shared = Arc::new(Shared {
            pending: Mutex::new(HashMap::new()),
            events: Mutex::new(Vec::new()),
            chunks: Mutex::new(HashMap::new()),
            closed: AtomicBool::new(false),
            stderr: Mutex::new(String::new()),
        });
        if let Some(stderr) = stderr {
            let shared = Arc::clone(&shared);
            thread::spawn(move || {
                let reader = BufReader::new(stderr);
                for line in reader.lines().map_while(std::result::Result::ok) {
                    let mut tail = shared.stderr.lock().expect("stderr lock");
                    tail.push_str(&line);
                    tail.push('\n');
                    if tail.len() > 16 * 1024 {
                        let keep = tail.len() - 16 * 1024;
                        tail.drain(0..keep);
                    }
                }
            });
        }
        let reader_shared = Arc::clone(&shared);
        thread::spawn(move || read_loop(stdout, reader_shared));
        let (writer, receiver) = mpsc::sync_channel::<String>(64);
        thread::spawn(move || {
            for line in receiver {
                if stdin
                    .write_all(line.as_bytes())
                    .and_then(|_| stdin.flush())
                    .is_err()
                {
                    break;
                }
            }
        });
        Ok(Self {
            child: Mutex::new(child),
            writer,
            shared,
            next_id: AtomicU64::new(1),
        })
    }

    pub fn wait_for_event(
        &self,
        predicate: impl Fn(&Value) -> bool,
        timeout: Duration,
    ) -> Option<Value> {
        let deadline = Instant::now() + timeout;
        loop {
            {
                let mut events = self.shared.events.lock().expect("events lock");
                if let Some(index) = events.iter().position(&predicate) {
                    return Some(events.remove(index));
                }
            }
            if self.shared.closed.load(Ordering::SeqCst) || Instant::now() >= deadline {
                return None;
            }
            thread::sleep(Duration::from_millis(5));
        }
    }

    pub fn request(&self, command: Value, timeout: Duration) -> Result<Value> {
        if self.shared.closed.load(Ordering::SeqCst) {
            return Err(RpcError::Closed(
                "The OMP runtime is not running".to_string(),
            ));
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let mut command = command;
        if let Some(object) = command.as_object_mut() {
            object.insert("id".to_string(), Value::Number(id.into()));
        }
        let (sender, receiver): (Sender<Value>, Receiver<Value>) = mpsc::channel();
        self.shared
            .pending
            .lock()
            .expect("pending lock")
            .insert(id, sender);
        let line = format!(
            "{}\n",
            serde_json::to_string(&command)
                .map_err(|error| RpcError::Protocol(error.to_string()))?
        );
        if self.writer.try_send(line).is_err() {
            self.shared
                .pending
                .lock()
                .expect("pending lock")
                .remove(&id);
            return Err(RpcError::Timeout(
                "The OMP runtime is not accepting commands".to_string(),
            ));
        }
        match receiver.recv_timeout(timeout) {
            Ok(value) => {
                if value.get("__closed").and_then(Value::as_bool) == Some(true) {
                    return Err(RpcError::Closed(
                        value
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("The OMP runtime closed")
                            .to_string(),
                    ));
                }
                Ok(value)
            }
            Err(RecvTimeoutError::Timeout) => {
                self.shared
                    .pending
                    .lock()
                    .expect("pending lock")
                    .remove(&id);
                Err(RpcError::Timeout(format!(
                    "The OMP runtime did not answer in {}ms",
                    timeout.as_millis()
                )))
            }
            Err(RecvTimeoutError::Disconnected) => Err(RpcError::Closed(
                "The OMP runtime closed the request channel".to_string(),
            )),
        }
    }

    pub fn inject_event(&self, event: Value) {
        self.shared.push_event(event);
    }

    pub fn drain_events(&self) -> Vec<Value> {
        std::mem::take(&mut *self.shared.events.lock().expect("events lock"))
    }

    pub fn stderr_tail(&self) -> String {
        self.shared.stderr.lock().expect("stderr lock").clone()
    }

    pub fn is_running(&mut self) -> bool {
        matches!(self.child.lock().expect("child lock").try_wait(), Ok(None))
    }

    pub fn pid(&mut self) -> Option<u32> {
        self.child.lock().expect("child lock").id().into()
    }

    pub fn close(&mut self) -> bool {
        self.shared.closed.store(true, Ordering::SeqCst);
        {
            let mut child = self.child.lock().expect("child lock");
            let _ = child.kill();
            let _ = child.wait();
        }
        self.shared.fail_all("The OMP runtime was closed");
        true
    }
}

fn read_loop(stdout: impl Read, shared: Arc<Shared>) {
    let mut reader = BufReader::new(stdout);
    let mut buffer = Vec::new();
    loop {
        buffer.clear();
        let read = match reader.read_until(b'\n', &mut buffer) {
            Ok(read) => read,
            Err(_) => break,
        };
        if read == 0 {
            break;
        }
        if buffer.len() > MAX_LINE_BYTES {
            shared.fail_all("The OMP runtime emitted an oversized frame");
            return;
        }
        let line = String::from_utf8_lossy(&buffer);
        if line.trim().is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if value.get("type").and_then(Value::as_str) == Some("rpc_chunk") {
            if let Some(event) = reassemble(&shared, &value) {
                shared.push_event(event);
            }
            continue;
        }
        if value.get("type").and_then(Value::as_str) == Some("response")
            && let Some(id) = value.get("id").and_then(Value::as_u64)
            && let Some(sender) = shared.pending.lock().expect("pending lock").remove(&id)
        {
            let _ = sender.send(value);
            continue;
        }
        shared.push_event(value);
    }
    shared.fail_all("The OMP runtime exited unexpectedly");
}

fn reassemble(shared: &Shared, frame: &Value) -> Option<Value> {
    let chunk_id = frame.get("chunkId").and_then(Value::as_str)?.to_string();
    let index = frame.get("index").and_then(Value::as_u64)? as usize;
    let count = frame.get("count").and_then(Value::as_u64)? as usize;
    let data = frame.get("data").and_then(Value::as_str)?;
    if count == 0 || count > MAX_CHUNKS || index >= count {
        return None;
    }
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(data)
        .ok()?;
    let now = Instant::now();
    let mut chunks = shared.chunks.lock().expect("chunks lock");
    chunks.retain(|_, assembly| now.duration_since(assembly.created_at) < CHUNK_TTL);
    let total: usize = chunks.values().map(|assembly| assembly.bytes).sum();
    if total + decoded.len() > MAX_TOTAL_CHUNK_BYTES {
        chunks.remove(&chunk_id);
        return None;
    }
    let assembly = chunks
        .entry(chunk_id.clone())
        .or_insert_with(|| ChunkAssembly {
            count,
            parts: vec![None; count],
            received: 0,
            bytes: 0,
            created_at: now,
        });
    if assembly.count != count || assembly.parts[index].is_some() {
        return None;
    }
    assembly.bytes += decoded.len();
    if assembly.bytes > MAX_CHUNK_BYTES {
        chunks.remove(&chunk_id);
        return None;
    }
    assembly.parts[index] = Some(decoded);
    assembly.received += 1;
    if assembly.received != assembly.count {
        return None;
    }
    let assembly = chunks.remove(&chunk_id)?;
    let mut payload = Vec::with_capacity(assembly.bytes);
    for part in assembly.parts.into_iter().flatten() {
        payload.extend_from_slice(&part);
    }
    serde_json::from_slice(&payload).ok()
}
