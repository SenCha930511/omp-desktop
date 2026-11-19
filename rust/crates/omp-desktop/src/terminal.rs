//! The bottom terminal panel's shell session.
//!
//! The shell runs in a real pseudo terminal (`portable-pty`). A background
//! thread reads its bytes and feeds them to a `vt100` parser, so the panel can
//! draw plain screen text without interpreting ANSI escapes itself. The panel
//! is independent of the transcript and of the side-question runtime: closing
//! it kills the shell, and nothing here touches `omp-core` state.

use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;

use async_channel::{Receiver, Sender};
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use vt100::Parser;

/// Rows requested from the PTY. The panel body is sized for this many lines.
pub const DEFAULT_ROWS: u16 = 14;
/// Columns used before the first frame knows the center column's width.
pub const DEFAULT_COLS: u16 = 80;
/// Narrowest/widest column count the panel asks a shell to use.
const MIN_COLS: u16 = 20;
const MAX_COLS: u16 = 200;
/// Horizontal space reserved for padding and the scrollbar gutter.
const HORIZONTAL_PADDING: f64 = 32.0;
/// Advance width of one cell at the panel's 11 px monospace size.
const CHAR_WIDTH: f64 = 6.7;
/// Read size for the PTY reader thread.
const READ_BUFFER: usize = 16 * 1024;

/// The monospace family used by the screen and the input line.
pub fn monospace_font() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "Menlo"
    }
    #[cfg(target_os = "windows")]
    {
        "Consolas"
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        "monospace"
    }
}

/// The shell a new terminal starts: the login shell on Unix, `COMSPEC` on
/// Windows. A missing variable falls back to a shell that is always present.
fn default_shell() -> String {
    #[cfg(windows)]
    {
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string())
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL")
            .ok()
            .filter(|shell| !shell.trim().is_empty())
            .unwrap_or_else(|| "/bin/sh".to_string())
    }
}

/// Clamps a PTY dimension to a usable value; zero would make the parser panic.
pub fn clamp_dimension(value: u16, fallback: u16) -> u16 {
    if value == 0 { fallback } else { value }
}

/// Picks the PTY size for a panel inside `center_width` logical pixels.
pub fn size_for_width(center_width: f64) -> (u16, u16) {
    let usable = (center_width - HORIZONTAL_PADDING).max(0.0);
    let cols = (usable / CHAR_WIDTH).floor();
    let cols = cols.clamp(f64::from(MIN_COLS), f64::from(MAX_COLS)) as u16;
    (DEFAULT_ROWS, cols)
}

/// Encodes one submitted input line for the shell: the trailing newline the
/// user's Enter implies becomes a carriage return, which is what a terminal in
/// canonical mode expects.
pub fn encode_input(line: &str) -> Vec<u8> {
    let mut bytes = line.trim_end_matches(['\r', '\n']).as_bytes().to_vec();
    bytes.push(b'\r');
    bytes
}

/// Turns a `vt100` screen dump into the panel's plain text: trailing padding
/// and trailing blank rows are dropped, leading indentation is kept so columns
/// stay aligned.
pub fn normalize_screen_text(contents: &str) -> String {
    let mut lines: Vec<&str> = contents.split('\n').map(str::trim_end).collect();
    while lines.last().is_some_and(|line| line.is_empty()) {
        lines.pop();
    }
    lines.join("\n")
}

/// Parser state shared between the reader thread and the UI thread.
struct TerminalState {
    parser: Parser,
    running: bool,
    error: Option<String>,
}

impl TerminalState {
    fn lock(shared: &Arc<Mutex<Self>>) -> MutexGuard<'_, Self> {
        // A poisoned lock only means a previous holder panicked; the parser
        // stays usable, so recover the guard instead of panicking again.
        shared
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// One shell process in a PTY, plus the parser that mirrors its screen.
///
/// Output is read on a dedicated thread; the panel waits on [`Self::notifications`]
/// instead of polling. Dropping the session kills the child.
pub struct TerminalSession {
    shared: Arc<Mutex<TerminalState>>,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Option<Box<dyn Child + Send + Sync>>,
    notifications: Receiver<()>,
    shell: String,
    cwd: Option<PathBuf>,
    rows: u16,
    cols: u16,
}

impl TerminalSession {
    /// Starts `shell` in `cwd` (the process's own directory when `None`) on a
    /// new PTY. Every failure is returned as a message the panel can show; no
    /// path here panics on a missing shell or an unavailable PTY.
    pub fn spawn(cwd: Option<&Path>, rows: u16, cols: u16) -> Result<Self, String> {
        let rows = clamp_dimension(rows, DEFAULT_ROWS);
        let cols = clamp_dimension(cols, DEFAULT_COLS);
        let pty = native_pty_system()
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| format!("Could not open a pseudo terminal: {error}"))?;

        let shell = default_shell();
        let mut command = CommandBuilder::new(&shell);
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        if let Some(dir) = cwd {
            command.cwd(dir);
        }
        let mut child = pty
            .slave
            .spawn_command(command)
            .map_err(|error| format!("Could not start {shell}: {error}"))?;
        // The slave side must be closed in the parent, or the reader never
        // sees EOF when the shell exits.
        drop(pty.slave);
        let reader = match pty.master.try_clone_reader() {
            Ok(reader) => reader,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("Could not read from the terminal: {error}"));
            }
        };
        let writer = match pty.master.take_writer() {
            Ok(writer) => writer,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("Could not write to the terminal: {error}"));
            }
        };

        let shared = Arc::new(Mutex::new(TerminalState {
            parser: Parser::new(rows, cols, 0),
            running: true,
            error: None,
        }));
        let (sender, notifications) = async_channel::bounded(1);
        let reader_shared = Arc::clone(&shared);
        let spawned = thread::Builder::new()
            .name("omp-terminal-reader".to_string())
            .spawn(move || read_loop(reader, reader_shared, sender));
        if let Err(error) = spawned {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("Could not start the terminal reader: {error}"));
        }

        Ok(Self {
            shared,
            master: pty.master,
            writer,
            child: Some(child),
            notifications,
            shell,
            cwd: cwd.map(Path::to_path_buf),
            rows,
            cols,
        })
    }

    /// Wakes once per burst of terminal output; the panel re-reads the screen
    /// when this resolves. The channel closes when the session is dropped.
    pub fn notifications(&self) -> Receiver<()> {
        self.notifications.clone()
    }

    /// The current screen as plain text, without ANSI formatting.
    pub fn screen_text(&self) -> String {
        let state = TerminalState::lock(&self.shared);
        normalize_screen_text(&state.parser.screen().contents())
    }

    /// False once the shell exited or its output could no longer be read.
    pub fn is_running(&self) -> bool {
        TerminalState::lock(&self.shared).running
    }

    /// The last read/write failure, if any.
    pub fn error(&self) -> Option<String> {
        TerminalState::lock(&self.shared).error.clone()
    }

    /// The program this session started.
    pub fn shell(&self) -> &str {
        &self.shell
    }

    /// The directory this session started in, when one was requested.
    pub fn cwd(&self) -> Option<&Path> {
        self.cwd.as_deref()
    }

    /// Sends one line to the shell, as if the user typed it and pressed Enter.
    pub fn send_line(&mut self, line: &str) -> Result<(), String> {
        let bytes = encode_input(line);
        self.writer
            .write_all(&bytes)
            .and_then(|()| self.writer.flush())
            .map_err(|error| self.record_error(format!("Could not write to the terminal: {error}")))
    }

    /// Resizes the PTY and its screen mirror. Unchanged sizes are a no-op.
    pub fn resize(&mut self, rows: u16, cols: u16) -> Result<(), String> {
        let rows = clamp_dimension(rows, DEFAULT_ROWS);
        let cols = clamp_dimension(cols, DEFAULT_COLS);
        if (rows, cols) == (self.rows, self.cols) {
            return Ok(());
        }
        self.master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| format!("Could not resize the terminal: {error}"))?;
        TerminalState::lock(&self.shared)
            .parser
            .screen_mut()
            .set_size(rows, cols);
        self.rows = rows;
        self.cols = cols;
        Ok(())
    }

    fn record_error(&self, message: String) -> String {
        TerminalState::lock(&self.shared).error = Some(message.clone());
        message
    }
}

impl Drop for TerminalSession {
    fn drop(&mut self) {
        // Kill and reap off the UI thread: `Child::kill` can wait out a short
        // grace period before the process actually dies.
        if let Some(mut child) = self.child.take() {
            let _ = thread::Builder::new()
                .name("omp-terminal-reaper".to_string())
                .spawn(move || {
                    let _ = child.kill();
                    let _ = child.wait();
                });
        }
        TerminalState::lock(&self.shared).running = false;
    }
}

/// Reads PTY output until EOF or an error, mirroring it into the parser and
/// waking the panel once per chunk.
fn read_loop(mut reader: Box<dyn Read + Send>, shared: Arc<Mutex<TerminalState>>, sender: Sender<()>) {
    let mut buffer = [0u8; READ_BUFFER];
    let mut read_error = None;
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => {
                TerminalState::lock(&shared).parser.process(&buffer[..count]);
                // A full channel already holds a wake-up for the panel.
                let _ = sender.try_send(());
            }
            Err(error) if error.kind() == ErrorKind::Interrupted => continue,
            Err(error) => {
                read_error = Some(format!("Could not read from the terminal: {error}"));
                break;
            }
        }
    }
    let mut state = TerminalState::lock(&shared);
    state.running = false;
    if read_error.is_some() {
        state.error = read_error;
    }
    drop(state);
    let _ = sender.try_send(());
}

#[cfg(test)]
mod tests {
    use super::{clamp_dimension, encode_input, normalize_screen_text, size_for_width};

    #[test]
    fn input_lines_end_in_a_carriage_return() {
        assert_eq!(encode_input("ls -la"), b"ls -la\r");
        assert_eq!(encode_input("ls\r\n"), b"ls\r");
        assert_eq!(encode_input(""), b"\r");
    }

    #[test]
    fn screen_text_keeps_indentation_and_drops_padding() {
        let contents = "  total 4\n  file.txt     \n\n\n";
        assert_eq!(
            normalize_screen_text(contents),
            "  total 4\n  file.txt"
        );
        assert_eq!(normalize_screen_text("\n \n\t\n"), "");
        assert_eq!(normalize_screen_text("one\ntwo"), "one\ntwo");
    }

    #[test]
    fn terminal_size_follows_the_center_column() {
        assert_eq!(size_for_width(0.0), (14, 20));
        assert_eq!(size_for_width(32.0 + 6.7 * 100.0), (14, 100));
        assert_eq!(size_for_width(100_000.0), (14, 200));
    }

    #[test]
    fn dimensions_never_reach_zero() {
        assert_eq!(clamp_dimension(0, 14), 14);
        assert_eq!(clamp_dimension(1, 14), 1);
    }
}
