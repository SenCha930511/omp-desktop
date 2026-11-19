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

/// The text `Send selection` offers for a screen: the last non-empty visible
/// line, with trailing padding dropped and leading indentation kept.
///
/// The `vt100` mirror tracks no mouse selection, so the last output row is the
/// closest thing to a selection the panel has; a blank screen yields nothing.
pub fn last_visible_line(contents: &str) -> String {
    normalize_screen_text(contents)
        .lines()
        .rev()
        .map(str::trim_end)
        .find(|line| !line.is_empty())
        .unwrap_or_default()
        .to_string()
}

/// The label one tab shows: the shell it started and the directory it is in.
pub fn tab_label(shell: &str, cwd: Option<&Path>) -> String {
    format!(
        "{shell} · {}",
        cwd.map(|path| path.display().to_string())
            .unwrap_or_else(|| "home".to_string())
    )
}

/// The tab that becomes active after `closing` leaves `len` tabs.
///
/// Closing the active tab selects the one that slides into its place, or the
/// one before it when the last tab was active. Closing another tab keeps the
/// active one, shifted down when an earlier tab went away. `None` means no tab
/// is left and the panel should close.
pub fn tab_after_close(active: usize, closing: usize, len: usize) -> Option<usize> {
    if len <= 1 {
        return None;
    }
    let remaining = len - 1;
    let next = if closing < active {
        active - 1
    } else if closing == active {
        active.min(remaining - 1)
    } else {
        active
    };
    Some(next.min(remaining - 1))
}

/// What one tab remembers while its session is not selected.
///
/// A live PTY cannot be serialized, so switching sessions stops the shells and
/// keeps this instead: the program to start again and the directory to start
/// it in. Switching back reopens a fresh shell from the spec rather than
/// handing the previous session's shell to the new one.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TerminalTabSpec {
    /// The directory the shell started in, when one was requested.
    pub cwd: Option<PathBuf>,
    /// The program the shell ran, as the tab labels it.
    pub shell: String,
}

impl TerminalTabSpec {
    /// The spec that reopens `session`'s shell in its directory.
    pub fn from_session(session: &TerminalSession) -> Self {
        Self {
            cwd: session.cwd().map(Path::to_path_buf),
            shell: session.shell().to_string(),
        }
    }

    /// The label this tab shows once its shell has been reopened.
    pub fn label(&self) -> String {
        tab_label(&self.shell, self.cwd.as_deref())
    }
}

/// The tab specs one session remembers, plus the tab that was active.
///
/// The panel keeps this per session id; a switch replays it into fresh shells.
/// `active` always indexes an existing tab, or is zero while there is none.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TerminalTabSpecs {
    tabs: Vec<TerminalTabSpec>,
    active: usize,
}

impl TerminalTabSpecs {
    /// The specs to reopen, in tab order.
    pub fn tabs(&self) -> &[TerminalTabSpec] {
        &self.tabs
    }

    /// How many tabs this session remembers.
    pub fn len(&self) -> usize {
        self.tabs.len()
    }

    /// True when the session has no tabs, so the panel draws its empty state.
    pub fn is_empty(&self) -> bool {
        self.tabs.is_empty()
    }

    /// The tab that should be active after a reopen.
    pub fn active(&self) -> usize {
        self.active
    }

    /// Files a tab at the end and makes it the active one.
    pub fn add(&mut self, spec: TerminalTabSpec) -> usize {
        self.tabs.push(spec);
        self.active = self.tabs.len() - 1;
        self.active
    }

    /// Makes `index` the active tab. A stale index is rejected and leaves the
    /// current tab selected.
    pub fn select(&mut self, index: usize) -> bool {
        if index >= self.tabs.len() {
            return false;
        }
        self.active = index;
        true
    }

    /// Drops one tab and returns the tab that is active afterwards, or `None`
    /// when no tab is left. Closing a stale index is a no-op.
    pub fn close(&mut self, index: usize) -> Option<usize> {
        if index >= self.tabs.len() {
            return (!self.tabs.is_empty()).then_some(self.active);
        }
        let len = self.tabs.len();
        self.tabs.remove(index);
        match tab_after_close(self.active, index, len) {
            Some(next) => {
                self.active = next;
                Some(next)
            }
            None => {
                self.active = 0;
                None
            }
        }
    }
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
///
/// A session may also be [`Self::detached`]: a screen mirror with no process
/// behind it, which the parity harness feeds so the selection and copy paths
/// can be exercised without spawning a shell.
pub struct TerminalSession {
    shared: Arc<Mutex<TerminalState>>,
    master: Option<Box<dyn MasterPty + Send>>,
    writer: Option<Box<dyn Write + Send>>,
    child: Option<Box<dyn Child + Send + Sync>>,
    notifications: Receiver<()>,
    shell: String,
    cwd: Option<PathBuf>,
    rows: u16,
    cols: u16,
}

impl TerminalSession {
    /// Starts the user's shell in `cwd` (the process's own directory when
    /// `None`) on a new PTY. Every failure is returned as a message the panel
    /// can show; no path here panics on a missing shell or an unavailable PTY.
    pub fn spawn(cwd: Option<&Path>, rows: u16, cols: u16) -> Result<Self, String> {
        Self::spawn_with_shell(&default_shell(), cwd, rows, cols)
    }

    /// Starts `shell` in `cwd` on a new PTY.
    ///
    /// A restored tab reopens through this: the saved spec names the program
    /// and directory, so the reopened shell matches the one it replaced.
    pub fn spawn_with_shell(
        shell: &str,
        cwd: Option<&Path>,
        rows: u16,
        cols: u16,
    ) -> Result<Self, String> {
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

        let shell = shell.to_string();
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
            master: Some(pty.master),
            writer: Some(writer),
            child: Some(child),
            notifications,
            shell,
            cwd: cwd.map(Path::to_path_buf),
            rows,
            cols,
        })
    }

    /// A screen mirror with no shell behind it.
    ///
    /// The parity harness feeds it terminal output so the selection and copy
    /// paths run against a real `vt100` screen without opening a PTY. Nothing
    /// here reads or writes a process: `send_line` reports the missing shell
    /// instead, and `resize` only resizes the mirror.
    #[doc(hidden)]
    pub fn detached(rows: u16, cols: u16) -> Self {
        let rows = clamp_dimension(rows, DEFAULT_ROWS);
        let cols = clamp_dimension(cols, DEFAULT_COLS);
        // The sender is dropped on return, so the panel's wake-up channel is
        // closed from the start: a watcher ends immediately, as it would for
        // a shell that already exited.
        let (_sender, notifications) = async_channel::bounded(1);
        Self {
            shared: Arc::new(Mutex::new(TerminalState {
                parser: Parser::new(rows, cols, 0),
                running: false,
                error: None,
            })),
            master: None,
            writer: None,
            child: None,
            notifications,
            shell: "detached".to_string(),
            cwd: None,
            rows,
            cols,
        }
    }

    /// Parses `bytes` into the screen mirror as if the shell had printed them.
    ///
    /// Only a detached session accepts output; a live shell's screen is fed by
    /// its reader thread. Returns false when a shell is attached, so a caller
    /// cannot fake output into a real terminal.
    #[doc(hidden)]
    pub fn feed(&mut self, bytes: &[u8]) -> bool {
        if self.writer.is_some() {
            return false;
        }
        TerminalState::lock(&self.shared).parser.process(bytes);
        true
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

    /// The text `Send selection` hands to the composer.
    ///
    /// The mirror keeps no mouse selection, so this is the last non-empty
    /// visible line — the output row a user would point at — and an empty
    /// screen yields nothing at all.
    pub fn selection_text(&self) -> String {
        let state = TerminalState::lock(&self.shared);
        last_visible_line(&state.parser.screen().contents())
    }

    /// Resets the screen mirror without touching the shell.
    ///
    /// The running program keeps its PTY and its own state; the panel simply
    /// draws a blank screen until the next output arrives, which is what a
    /// terminal's "clear screen" action does.
    pub fn clear(&mut self) {
        let mut state = TerminalState::lock(&self.shared);
        state.parser = Parser::new(self.rows, self.cols, 0);
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
        let Some(writer) = self.writer.as_mut() else {
            return Err(self.record_error("This terminal has no shell to send to.".to_string()));
        };
        writer
            .write_all(&bytes)
            .and_then(|()| writer.flush())
            .map_err(|error| self.record_error(format!("Could not write to the terminal: {error}")))
    }

    /// Resizes the PTY and its screen mirror. Unchanged sizes are a no-op.
    ///
    /// A detached session has no PTY to resize; only its mirror changes.
    pub fn resize(&mut self, rows: u16, cols: u16) -> Result<(), String> {
        let rows = clamp_dimension(rows, DEFAULT_ROWS);
        let cols = clamp_dimension(cols, DEFAULT_COLS);
        if (rows, cols) == (self.rows, self.cols) {
            return Ok(());
        }
        if let Some(master) = self.master.as_mut() {
            master
                .resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|error| format!("Could not resize the terminal: {error}"))?;
        }
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
fn read_loop(
    mut reader: Box<dyn Read + Send>,
    shared: Arc<Mutex<TerminalState>>,
    sender: Sender<()>,
) {
    let mut buffer = [0u8; READ_BUFFER];
    let mut read_error = None;
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => {
                TerminalState::lock(&shared)
                    .parser
                    .process(&buffer[..count]);
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
    use std::path::{Path, PathBuf};

    use super::{
        TerminalSession, TerminalTabSpec, TerminalTabSpecs, clamp_dimension, encode_input,
        last_visible_line, normalize_screen_text, size_for_width, tab_after_close, tab_label,
    };

    #[test]
    fn input_lines_end_in_a_carriage_return() {
        assert_eq!(encode_input("ls -la"), b"ls -la\r");
        assert_eq!(encode_input("ls\r\n"), b"ls\r");
        assert_eq!(encode_input(""), b"\r");
    }

    #[test]
    fn screen_text_keeps_indentation_and_drops_padding() {
        let contents = "  total 4\n  file.txt     \n\n\n";
        assert_eq!(normalize_screen_text(contents), "  total 4\n  file.txt");
        assert_eq!(normalize_screen_text("\n \n\t\n"), "");
        assert_eq!(normalize_screen_text("one\ntwo"), "one\ntwo");
    }

    /// The selection fallback is the last output row: trailing padding goes,
    /// leading indentation stays, and blank rows above it are skipped.
    #[test]
    fn selection_takes_the_last_non_empty_line() {
        assert_eq!(last_visible_line("one\ntwo\n\n\n"), "two");
        assert_eq!(
            last_visible_line("  total 4\n  file.txt     \n\n"),
            "  file.txt"
        );
        assert_eq!(last_visible_line("single"), "single");
        assert_eq!(last_visible_line("\n \n\t\n"), "");
        assert_eq!(last_visible_line(""), "");
    }

    /// A detached session parses fed output into a real screen, so selection
    /// and copy read the same text a live shell would produce; an empty feed
    /// leaves the screen blank.
    #[test]
    fn detached_session_mirrors_fed_output_without_a_shell() {
        let mut session = TerminalSession::detached(4, 40);
        assert!(session.selection_text().is_empty());
        assert!(session.screen_text().is_empty());
        assert!(!session.is_running());

        assert!(session.feed(b"npm run build\r\n"));
        assert_eq!(session.screen_text(), "npm run build");
        assert_eq!(session.selection_text(), "npm run build");

        // A later row becomes the selection; the earlier rows stay on screen.
        assert!(session.feed(b"ok\r\n"));
        assert_eq!(session.screen_text(), "npm run build\nok");
        assert_eq!(session.selection_text(), "ok");

        // There is no shell behind a detached session to write to.
        assert!(session.send_line("echo hi").is_err());
        assert!(session.error().is_some());
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

    #[test]
    fn closing_a_tab_selects_its_neighbour() {
        // The active middle tab gives way to the one that slides into place.
        assert_eq!(tab_after_close(1, 1, 3), Some(1));
        // Closing the active last tab falls back to the one before it.
        assert_eq!(tab_after_close(2, 2, 3), Some(1));
        // Closing an earlier tab shifts the active index down with it.
        assert_eq!(tab_after_close(2, 0, 3), Some(1));
        // Closing a later tab leaves the active index alone.
        assert_eq!(tab_after_close(0, 2, 3), Some(0));
        assert_eq!(tab_after_close(0, 1, 2), Some(0));
        // The last tab closes the panel.
        assert_eq!(tab_after_close(0, 0, 1), None);
        assert_eq!(tab_after_close(0, 0, 0), None);
    }

    #[test]
    fn tab_labels_name_the_shell_and_its_directory() {
        assert_eq!(tab_label("/bin/zsh", None), "/bin/zsh · home");
        assert_eq!(
            tab_label("/bin/zsh", Some(Path::new("/tmp/project"))),
            "/bin/zsh · /tmp/project"
        );
    }

    /// The per-session tab specs add, select and close exactly like the live
    /// tabs do: no PTY is opened, and the active index never dangles.
    #[test]
    fn tab_specs_add_select_and_close_without_a_shell() {
        let mut specs = TerminalTabSpecs::default();
        assert!(specs.is_empty());
        assert_eq!(specs.len(), 0);
        assert_eq!(specs.active(), 0);

        let first = specs.add(TerminalTabSpec {
            cwd: Some(PathBuf::from("/tmp/one")),
            shell: "/bin/sh".to_string(),
        });
        assert_eq!(first, 0);
        assert_eq!(specs.active(), 0);

        let second = specs.add(TerminalTabSpec {
            cwd: None,
            shell: "/bin/zsh".to_string(),
        });
        assert_eq!(second, 1);
        assert_eq!(specs.len(), 2);
        // Adding a tab makes it the active one.
        assert_eq!(specs.active(), 1);

        // Selecting moves the marker; a stale index leaves it alone.
        assert!(specs.select(0));
        assert_eq!(specs.active(), 0);
        assert!(!specs.select(9));
        assert_eq!(specs.active(), 0);

        // Closing the active first tab activates the one that slid into place.
        assert_eq!(specs.close(0), Some(0));
        assert_eq!(specs.len(), 1);
        assert_eq!(specs.active(), 0);
        assert_eq!(specs.tabs()[0].shell, "/bin/zsh");
        assert_eq!(specs.tabs()[0].label(), "/bin/zsh · home");

        // The last tab leaves nothing to activate.
        assert_eq!(specs.close(0), None);
        assert!(specs.is_empty());
        assert_eq!(specs.active(), 0);

        // A stale close is a no-op rather than a panic.
        assert_eq!(specs.close(3), None);
        assert_eq!(specs.tabs().first().map(TerminalTabSpec::label), None);
    }
}
