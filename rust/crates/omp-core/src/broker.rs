use std::io::Read;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use serde_json::{Value, json};
use tiny_http::{Header, Response, Server};

use crate::error::{CoreError, Result};

pub struct BrokerHandle {
    pub url: String,
    pub token: String,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl BrokerHandle {
    pub fn shutdown(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for BrokerHandle {
    fn drop(&mut self) {
        self.shutdown();
    }
}

pub fn random_token() -> String {
    use base64::Engine;
    let mut bytes = Vec::with_capacity(32);
    bytes.extend_from_slice(uuid::Uuid::new_v4().as_bytes());
    bytes.extend_from_slice(uuid::Uuid::new_v4().as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

pub fn start<F>(handler: F) -> Result<BrokerHandle>
where
    F: Fn(&str, &Value) -> Result<Value> + Send + Sync + 'static,
{
    let server = Server::http("127.0.0.1:0").map_err(|error| {
        CoreError::new(
            "Error",
            format!("Could not start the loopback broker: {error}"),
        )
    })?;
    let address = server
        .server_addr()
        .to_ip()
        .ok_or_else(|| CoreError::new("Error", "The loopback broker did not bind a TCP address"))?;
    let url = format!("http://127.0.0.1:{}/", address.port());
    let token = random_token();
    let server = Arc::new(server);
    let stop = Arc::new(AtomicBool::new(false));
    let handler = Arc::new(handler);
    let thread_server = Arc::clone(&server);
    let thread_stop = Arc::clone(&stop);
    let thread_token = token.clone();
    let thread = thread::spawn(move || {
        while !thread_stop.load(Ordering::SeqCst) {
            match thread_server.recv_timeout(Duration::from_millis(100)) {
                Ok(Some(request)) => handle_request(request, &thread_token, &*handler),
                Ok(None) => {}
                Err(_) => break,
            }
        }
    });
    Ok(BrokerHandle {
        url,
        token,
        stop,
        thread: Some(thread),
    })
}

fn header_value(request: &tiny_http::Request, name: &str) -> Option<String> {
    request
        .headers()
        .iter()
        .find(|header| header.field.as_str().to_string().eq_ignore_ascii_case(name))
        .map(|header| header.value.as_str().to_string())
}

fn handle_request<F>(mut request: tiny_http::Request, token: &str, handler: &F)
where
    F: Fn(&str, &Value) -> Result<Value>,
{
    if request.method().as_str() != "POST" {
        let _ = request.respond(Response::from_string("method not allowed").with_status_code(405));
        return;
    }
    if header_value(&request, "Origin").is_some() {
        let _ = request.respond(Response::from_string("origin not allowed").with_status_code(403));
        return;
    }
    let authorization = header_value(&request, "Authorization").unwrap_or_default();
    if authorization != format!("Bearer {token}") {
        let _ = request.respond(Response::from_string("unauthorized").with_status_code(401));
        return;
    }
    let mut body = String::new();
    if request
        .as_reader()
        .take(1024 * 1024)
        .read_to_string(&mut body)
        .is_err()
    {
        let _ = request.respond(Response::from_string("bad request").with_status_code(400));
        return;
    }
    let parsed: Value = match serde_json::from_str(&body) {
        Ok(value) => value,
        Err(_) => {
            let _ = request.respond(Response::from_string("bad request").with_status_code(400));
            return;
        }
    };
    let method = parsed
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let params = parsed.get("params").cloned().unwrap_or_else(|| json!({}));
    match handler(method, &params) {
        Ok(result) => {
            let payload = json!({ "ok": true, "result": result });
            let response = Response::from_string(payload.to_string()).with_header(
                Header::from_bytes("Content-Type", "application/json").expect("static header"),
            );
            let _ = request.respond(response);
        }
        Err(error) => {
            let payload =
                json!({ "ok": false, "error": { "code": error.code, "message": error.message } });
            let response = Response::from_string(payload.to_string())
                .with_status_code(400)
                .with_header(
                    Header::from_bytes("Content-Type", "application/json").expect("static header"),
                );
            let _ = request.respond(response);
        }
    }
}
