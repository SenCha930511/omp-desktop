use chrono::{DateTime, Datelike, SecondsFormat, TimeZone, Utc};
use serde::de::{self, DeserializeSeed, Deserializer, MapAccess, SeqAccess, Visitor};
use serde_json::value::RawValue;
use serde_json::{json, Value};
use std::alloc::{alloc as rust_alloc, dealloc as rust_dealloc, Layout};
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::rc::Rc;
use std::slice;

const MAX_RECORDS: usize = 200_000;
const MAX_RECORD_BYTES: usize = 64 * 1024 * 1024;
const MAX_TEXT_CHARS: usize = 4_096;
const MAX_LINEAGE_CHARS: usize = 4_096;
const MAX_PREVIOUS_FILES: usize = 32;
const TRUNCATION_MARKER: &str = "\n… [truncated] …\n";
const MAX_DATE_MS: f64 = 8.64e15;
const IO_BUF_CAP: usize = 256 * 1024;
const MAX_RETAINED_RESULT_CAP: usize = 65_536;
const MAX_RETAINED_LINE_CAP: usize = 65_536;

const MAX_TRANSCRIPT_GRAPH_BYTES: usize = 16 * 1024 * 1024;
const MAX_TRANSCRIPT_GRAPH_RECORDS: usize = 10_000;
const MAX_PARENT_EDGES: usize = MAX_TRANSCRIPT_GRAPH_RECORDS * 4;
const MAX_EVICTED_RENDERABLE_IDS: usize = 10_000;
const MAX_EVICTED_RENDERABLE_ID_CHARS: usize = 1_000_000;
const MAX_ID_CHARS: usize = 1_024;
const MAX_TRANSCRIPT_MESSAGES: usize = 400;
const MAX_TRANSCRIPT_PARTS: usize = 2_000;
const MAX_TRANSCRIPT_TEXT_CHARS: usize = 1024 * 1024;
const MAX_TRANSCRIPT_TOOL_CHARS: usize = 512 * 1024;
const MAX_TRANSCRIPT_ARGS_CHARS: usize = 256 * 1024;
const MAX_PART_TEXT_CHARS: usize = 256 * 1024;
const MAX_PART_TOOL_CHARS: usize = 128 * 1024;
const MAX_PART_ARGS_CHARS: usize = 128 * 1024;
const MAX_PARTS_PER_RECORD: usize = 200;

const STATUS_OK: u32 = 0;
const STATUS_FALLBACK: u32 = 1;
const STATUS_ERROR: u32 = 2;

thread_local! {
    static RESULT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static IO_BUF: RefCell<Vec<u8>> = RefCell::new(vec![0u8; IO_BUF_CAP]);
    static META_STREAM: RefCell<Option<MetaStream>> = const { RefCell::new(None) };
    static TRANSCRIPT_STREAM: RefCell<Option<TranscriptStream>> = const { RefCell::new(None) };
}

#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    if len == 0 {
        return std::ptr::null_mut();
    }
    unsafe {
        let layout = Layout::from_size_align_unchecked(len, 1);
        rust_alloc(layout)
    }
}

#[no_mangle]
pub extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    if len == 0 || ptr.is_null() {
        return;
    }
    unsafe {
        let layout = Layout::from_size_align_unchecked(len, 1);
        rust_dealloc(ptr, layout);
    }
}

#[no_mangle]
pub extern "C" fn io_buf_ptr() -> *mut u8 {
    IO_BUF.with(|buf| {
        let mut guard = buf.borrow_mut();
        if guard.len() != IO_BUF_CAP {
            guard.resize(IO_BUF_CAP, 0);
        }
        guard.as_mut_ptr()
    })
}

#[no_mangle]
pub extern "C" fn io_buf_cap() -> usize {
    IO_BUF_CAP
}

#[no_mangle]
pub extern "C" fn result_ptr() -> *const u8 {
    RESULT.with(|result| result.borrow().as_ptr())
}

#[no_mangle]
pub extern "C" fn result_len() -> usize {
    RESULT.with(|result| result.borrow().len())
}

#[no_mangle]
pub extern "C" fn clear_result() {
    RESULT.with(|result| {
        let mut guard = result.borrow_mut();
        if guard.capacity() > MAX_RETAINED_RESULT_CAP {
            *guard = Vec::new();
        } else {
            guard.clear();
        }
    });
}

fn set_result(value: Value) {
    let bytes = serde_json::to_vec(&value)
        .unwrap_or_else(|_| b"{\"status\":\"fallback\",\"reason\":\"serialize\"}".to_vec());
    RESULT.with(|result| *result.borrow_mut() = bytes);
}

fn set_result_bytes(bytes: Vec<u8>) {
    RESULT.with(|result| *result.borrow_mut() = bytes);
}

fn fallback(reason: &str) -> Value {
    json!({ "status": "fallback", "reason": reason })
}

fn error(reason: &str) -> Value {
    json!({ "status": "error", "reason": reason })
}

fn string_arg(ptr: *const u8, len: usize) -> Option<String> {
    if len == 0 {
        return Some(String::new());
    }
    if ptr.is_null() {
        return None;
    }
    let bytes = unsafe { slice::from_raw_parts(ptr, len) };
    std::str::from_utf8(bytes).ok().map(str::to_string)
}

#[no_mangle]
pub extern "C" fn scan(
    bytes_ptr: *const u8,
    bytes_len: usize,
    id_ptr: *const u8,
    id_len: usize,
    created_ptr: *const u8,
    created_len: usize,
    updated_ptr: *const u8,
    updated_len: usize,
    title_slot_len: usize,
) -> usize {
    let bytes: &[u8] = if bytes_len == 0 {
        &[]
    } else {
        unsafe { slice::from_raw_parts(bytes_ptr, bytes_len) }
    };
    let Some(id) = string_arg(id_ptr, id_len) else {
        set_result(fallback("id"));
        return result_len();
    };
    let Some(created_at) = string_arg(created_ptr, created_len) else {
        set_result(fallback("created"));
        return result_len();
    };
    let Some(updated_at) = string_arg(updated_ptr, updated_len) else {
        set_result(fallback("updated"));
        return result_len();
    };
    set_result(scan_inner(bytes, id, created_at, updated_at, title_slot_len));
    result_len()
}

#[no_mangle]
pub extern "C" fn meta_begin(
    id_ptr: *const u8,
    id_len: usize,
    created_ptr: *const u8,
    created_len: usize,
    updated_ptr: *const u8,
    updated_len: usize,
    title_slot_len: usize,
) -> u32 {
    let Some(id) = string_arg(id_ptr, id_len) else {
        set_result(fallback("id"));
        return STATUS_FALLBACK;
    };
    let Some(created_at) = string_arg(created_ptr, created_len) else {
        set_result(fallback("created"));
        return STATUS_FALLBACK;
    };
    let Some(updated_at) = string_arg(updated_ptr, updated_len) else {
        set_result(fallback("updated"));
        return STATUS_FALLBACK;
    };
    META_STREAM.with(|cell| {
        *cell.borrow_mut() = Some(MetaStream::new(id, created_at, updated_at, title_slot_len));
    });
    STATUS_OK
}

#[no_mangle]
pub extern "C" fn meta_chunk(len: usize) -> u32 {
    if len > IO_BUF_CAP {
        META_STREAM.with(|cell| *cell.borrow_mut() = None);
        set_result(fallback("chunk-len"));
        return STATUS_FALLBACK;
    }
    if len == 0 {
        return STATUS_OK;
    }
    IO_BUF.with(|buf| {
        let guard = buf.borrow();
        let data = &guard[..len];
        META_STREAM.with(|cell| {
            let mut stream_opt = cell.borrow_mut();
            let Some(stream) = stream_opt.as_mut() else {
                set_result(fallback("not-started"));
                return STATUS_FALLBACK;
            };
            match stream.push_chunk(data) {
                Ok(()) => STATUS_OK,
                Err(StreamFailure::Fallback(reason)) => {
                    *stream_opt = None;
                    set_result(fallback(reason));
                    STATUS_FALLBACK
                }
                Err(StreamFailure::Error(reason)) => {
                    *stream_opt = None;
                    set_result(error(reason));
                    STATUS_ERROR
                }
            }
        })
    })
}

#[no_mangle]
pub extern "C" fn meta_finish() -> usize {
    META_STREAM.with(|cell| {
        let Some(stream) = cell.borrow_mut().take() else {
            set_result(fallback("not-started"));
            return result_len();
        };
        set_result(stream.finish());
        result_len()
    })
}

#[no_mangle]
pub extern "C" fn meta_reset() {
    META_STREAM.with(|cell| *cell.borrow_mut() = None);
}

#[no_mangle]
pub extern "C" fn transcript_begin(dialect_mode: u32) -> u32 {
    if dialect_mode > 1 {
        set_result(fallback("dialect"));
        return STATUS_FALLBACK;
    }
    TRANSCRIPT_STREAM.with(|cell| {
        *cell.borrow_mut() = Some(TranscriptStream::new(dialect_mode));
    });
    STATUS_OK
}

#[no_mangle]
pub extern "C" fn transcript_chunk(len: usize) -> u32 {
    if len > IO_BUF_CAP {
        TRANSCRIPT_STREAM.with(|cell| *cell.borrow_mut() = None);
        set_result(fallback("chunk-len"));
        return STATUS_FALLBACK;
    }
    if len == 0 {
        return STATUS_OK;
    }
    IO_BUF.with(|buf| {
        let guard = buf.borrow();
        let data = &guard[..len];
        TRANSCRIPT_STREAM.with(|cell| {
            let mut stream_opt = cell.borrow_mut();
            let Some(stream) = stream_opt.as_mut() else {
                set_result(fallback("not-started"));
                return STATUS_FALLBACK;
            };
            match stream.push_chunk(data) {
                Ok(()) => STATUS_OK,
                Err(StreamFailure::Fallback(reason)) => {
                    *stream_opt = None;
                    set_result(fallback(reason));
                    STATUS_FALLBACK
                }
                Err(StreamFailure::Error(reason)) => {
                    *stream_opt = None;
                    set_result(error(reason));
                    STATUS_ERROR
                }
            }
        })
    })
}

#[no_mangle]
pub extern "C" fn transcript_finish() -> usize {
    TRANSCRIPT_STREAM.with(|cell| {
        let Some(stream) = cell.borrow_mut().take() else {
            set_result(fallback("not-started"));
            return result_len();
        };
        match stream.finish() {
            Ok(bytes) => set_result_bytes(bytes),
            Err(StreamFailure::Fallback(reason)) => set_result(fallback(reason)),
            Err(StreamFailure::Error(reason)) => set_result(error(reason)),
        }
        result_len()
    })
}

#[no_mangle]
pub extern "C" fn transcript_reset() {
    TRANSCRIPT_STREAM.with(|cell| *cell.borrow_mut() = None);
}

#[derive(Debug)]
enum StreamFailure {
    Fallback(&'static str),
    Error(&'static str),
}

struct LineSplitter {
    pending: Vec<u8>,
    pending_offset: u64,
    offset: u64,
}

impl LineSplitter {
    fn new() -> Self {
        Self {
            pending: Vec::new(),
            pending_offset: 0,
            offset: 0,
        }
    }

    fn feed<F>(&mut self, chunk: &[u8], mut on_line: F) -> Result<(), StreamFailure>
    where
        F: FnMut(u64, &[u8]) -> Result<(), StreamFailure>,
    {
        let mut pos = 0;
        while pos < chunk.len() {
            if let Some(rel_nl) = memchr::memchr(b'\n', &chunk[pos..]) {
                let seg = &chunk[pos..pos + rel_nl];
                if self.pending.is_empty() {
                    let line = seg.strip_suffix(b"\r").unwrap_or(seg);
                    if !line.is_empty() {
                        if line.len() > MAX_RECORD_BYTES {
                            return Err(StreamFailure::Error("record-too-large"));
                        }
                        on_line(self.offset + pos as u64, line)?;
                    }
                } else {
                    if self.pending.len().saturating_add(seg.len()) > MAX_RECORD_BYTES + 1 {
                        self.clear_pending();
                        return Err(StreamFailure::Error("record-too-large"));
                    }
                    self.pending.extend_from_slice(seg);
                    let line_offset = self.pending_offset;
                    let line_len = {
                        let stripped = self.pending.strip_suffix(b"\r").unwrap_or(&self.pending);
                        stripped.len()
                    };
                    if line_len > 0 {
                        if line_len > MAX_RECORD_BYTES {
                            self.clear_pending();
                            return Err(StreamFailure::Error("record-too-large"));
                        }
                        on_line(line_offset, &self.pending[..line_len])?;
                    }
                    self.clear_pending();
                }
                pos += rel_nl + 1;
            } else {
                let rest = &chunk[pos..];
                if self.pending.is_empty() {
                    self.pending_offset = self.offset + pos as u64;
                }
                if self.pending.len().saturating_add(rest.len()) > MAX_RECORD_BYTES + 1 {
                    self.clear_pending();
                    return Err(StreamFailure::Error("record-too-large"));
                }
                self.pending.extend_from_slice(rest);
                break;
            }
        }
        self.offset += chunk.len() as u64;
        Ok(())
    }

    fn finish<F>(&mut self, mut on_line: F) -> Result<(), StreamFailure>
    where
        F: FnMut(u64, &[u8]) -> Result<(), StreamFailure>,
    {
        if !self.pending.is_empty() {
            let line_offset = self.pending_offset;
            let line_len = {
                let stripped = self.pending.strip_suffix(b"\r").unwrap_or(&self.pending);
                stripped.len()
            };
            if line_len > 0 {
                if line_len > MAX_RECORD_BYTES {
                    self.clear_pending();
                    return Err(StreamFailure::Error("record-too-large"));
                }
                on_line(line_offset, &self.pending[..line_len])?;
            }
            self.clear_pending();
        }
        Ok(())
    }

    fn clear_pending(&mut self) {
        self.pending.clear();
        if self.pending.capacity() > MAX_RETAINED_LINE_CAP {
            self.pending.shrink_to(0);
        }
    }
}

struct Accumulator {
    id: String,
    project_path: String,
    created_at: String,
    updated_at: String,
    saw_record_timestamp: bool,
    last_user_message_at: Option<String>,
    model: Option<String>,
    provider: Option<String>,
    thinking_level: Option<String>,
    display_name: Option<String>,
    parent_session: Option<String>,
    previous_session_files: Vec<String>,
    first_user: String,
    preview: String,
    last_user_texts: Vec<String>,
    last_role: Option<String>,
    stop_reason: Option<String>,
    records: usize,
}

impl Accumulator {
    fn new(id: String, created_at: String, updated_at: String) -> Self {
        Self {
            id,
            project_path: String::new(),
            created_at,
            updated_at,
            saw_record_timestamp: false,
            last_user_message_at: None,
            model: None,
            provider: None,
            thinking_level: None,
            display_name: None,
            parent_session: None,
            previous_session_files: Vec::new(),
            first_user: String::new(),
            preview: String::new(),
            last_user_texts: Vec::new(),
            last_role: None,
            stop_reason: None,
            records: 0,
        }
    }

    fn into_json(self) -> Value {
        json!({
            "status": "ok",
            "accumulator": {
                "id": self.id,
                "projectPath": self.project_path,
                "createdAt": self.created_at,
                "updatedAt": self.updated_at,
                "sawRecordTimestamp": self.saw_record_timestamp,
                "lastUserMessageAt": self.last_user_message_at,
                "model": self.model,
                "provider": self.provider,
                "thinkingLevel": self.thinking_level,
                "displayName": self.display_name,
                "parentSession": self.parent_session,
                "previousSessionFiles": self.previous_session_files,
                "firstUser": self.first_user,
                "preview": self.preview,
                "lastUserTexts": self.last_user_texts,
                "lastRole": self.last_role,
                "stopReason": self.stop_reason,
                "records": self.records
            }
        })
    }
}

struct MetaStream {
    state: Accumulator,
    title_slot_len: usize,
    title_slot_buf: Vec<u8>,
    title_slot_done: bool,
    title_slot_title: Option<String>,
    splitter: LineSplitter,
}

impl MetaStream {
    fn new(id: String, created_at: String, updated_at: String, title_slot_len: usize) -> Self {
        Self {
            state: Accumulator::new(id, created_at, updated_at),
            title_slot_len,
            title_slot_buf: Vec::with_capacity(title_slot_len.min(4_096)),
            title_slot_done: title_slot_len == 0,
            title_slot_title: None,
            splitter: LineSplitter::new(),
        }
    }

    fn push_chunk(&mut self, mut chunk: &[u8]) -> Result<(), StreamFailure> {
        if !self.title_slot_done {
            let need = self.title_slot_len.saturating_sub(self.title_slot_buf.len());
            let take = need.min(chunk.len());
            self.title_slot_buf.extend_from_slice(&chunk[..take]);
            chunk = &chunk[take..];
            if self.title_slot_buf.len() == self.title_slot_len {
                self.title_slot_done = true;
                self.title_slot_title = parse_title_slot(&self.title_slot_buf)?;
                self.title_slot_buf.clear();
                self.title_slot_buf.shrink_to(0);
            }
        }
        if chunk.is_empty() {
            return Ok(());
        }
        let state = &mut self.state;
        self.splitter.feed(chunk, |_, line| ingest_meta_line(state, line))
    }

    fn finish(mut self) -> Value {
        if !self.title_slot_done {
            match parse_title_slot(&self.title_slot_buf) {
                Ok(title) => self.title_slot_title = title,
                Err(StreamFailure::Fallback(reason)) => return fallback(reason),
                Err(StreamFailure::Error(reason)) => return error(reason),
            }
        }
        let state = &mut self.state;
        if let Err(failure) = self.splitter.finish(|_, line| ingest_meta_line(state, line)) {
            return match failure {
                StreamFailure::Fallback(reason) => fallback(reason),
                StreamFailure::Error(reason) => error(reason),
            };
        }
        if let Some(title) = self.title_slot_title {
            self.state.display_name = Some(title);
        }
        self.state.into_json()
    }
}

fn scan_inner(bytes: &[u8], id: String, created_at: String, updated_at: String, title_slot_len: usize) -> Value {
    let mut state = Accumulator::new(id, created_at, updated_at);

    let mut record_start = 0;
    let mut title_slot_title: Option<String> = None;
    if title_slot_len > 0 {
        record_start = title_slot_len.min(bytes.len());
        match parse_title_slot(&bytes[..record_start]) {
            Ok(title) => title_slot_title = title,
            Err(StreamFailure::Fallback(reason)) => return fallback(reason),
            Err(StreamFailure::Error(reason)) => return error(reason),
        }
    }

    let tail = &bytes[record_start..];
    let mut pos = 0;
    while pos <= tail.len() {
        let end = match memchr::memchr(b'\n', &tail[pos..]) {
            Some(rel) => pos + rel,
            None => tail.len(),
        };
        let raw_line = &tail[pos..end];
        let line = raw_line.strip_suffix(b"\r").unwrap_or(raw_line);
        if !line.is_empty() {
            if line.len() > MAX_RECORD_BYTES {
                return error("record-too-large");
            }
            if let Err(failure) = ingest_meta_line(&mut state, line) {
                return match failure {
                    StreamFailure::Fallback(reason) => fallback(reason),
                    StreamFailure::Error(reason) => error(reason),
                };
            }
        }
        if end == tail.len() {
            break;
        }
        pos = end + 1;
    }

    if let Some(title) = title_slot_title {
        state.display_name = Some(title);
    }

    state.into_json()
}

fn parse_title_slot(slot: &[u8]) -> Result<Option<String>, StreamFailure> {
    let Some(newline) = memchr::memchr(b'\n', slot) else {
        return Ok(None);
    };
    let line = slot[..newline].strip_suffix(b"\r").unwrap_or(&slot[..newline]);
    let Ok(text) = std::str::from_utf8(line) else {
        return Err(StreamFailure::Fallback("title-utf8"));
    };
    if is_blank(text) {
        return Ok(None);
    }
    let mut de = serde_json::Deserializer::from_str(text);
    let parsed = TitleSlotVisitor.deserialize(&mut de);
    let Ok(parsed) = parsed else {
        return Err(StreamFailure::Fallback("title-json"));
    };
    if de.end().is_err() {
        return Err(StreamFailure::Fallback("title-json"));
    }
    Ok(parsed)
}

struct TitleSlotVisitor;

impl<'de> DeserializeSeed<'de> for TitleSlotVisitor {
    type Value = Option<String>;

    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<Self::Value, D::Error> {
        deserializer.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for TitleSlotVisitor {
    type Value = Option<String>;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("title slot JSON")
    }

    fn visit_bool<E: de::Error>(self, _: bool) -> Result<Self::Value, E> { Ok(None) }
    fn visit_i64<E: de::Error>(self, _: i64) -> Result<Self::Value, E> { Ok(None) }
    fn visit_u64<E: de::Error>(self, _: u64) -> Result<Self::Value, E> { Ok(None) }
    fn visit_f64<E: de::Error>(self, _: f64) -> Result<Self::Value, E> { Ok(None) }
    fn visit_str<E: de::Error>(self, _: &str) -> Result<Self::Value, E> { Ok(None) }
    fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> { Ok(None) }
    fn visit_none<E: de::Error>(self) -> Result<Self::Value, E> { Ok(None) }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
        while seq.next_element_seed(StrictSkipSeed)?.is_some() {}
        Ok(None)
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let mut is_title_type = false;
        let mut title: Option<String> = None;
        while let Some(key) = map.next_key_seed(TitleSlotKeySeed)? {
            match key {
                TitleSlotKey::Type => {
                    is_title_type = matches!(map.next_value_seed(StringOnlySeed)?.as_deref(), Some("title"));
                }
                TitleSlotKey::Title => {
                    title = map.next_value_seed(StringOnlySeed)?;
                }
                TitleSlotKey::Other => {
                    map.next_value_seed(StrictSkipSeed)?;
                }
            }
        }
        if is_title_type {
            if let Some(t) = title {
                if !is_blank(&t) {
                    return Ok(Some(t));
                }
            }
        }
        Ok(None)
    }
}

enum TitleSlotKey {
    Type,
    Title,
    Other,
}

struct TitleSlotKeySeed;

impl<'de> DeserializeSeed<'de> for TitleSlotKeySeed {
    type Value = TitleSlotKey;
    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<Self::Value, D::Error> {
        deserializer.deserialize_str(self)
    }
}

impl<'de> Visitor<'de> for TitleSlotKeySeed {
    type Value = TitleSlotKey;
    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("title key")
    }
    fn visit_str<E: de::Error>(self, key: &str) -> Result<Self::Value, E> {
        Ok(match key {
            "type" => TitleSlotKey::Type,
            "title" => TitleSlotKey::Title,
            _ => TitleSlotKey::Other,
        })
    }
}

#[derive(Copy, Clone)]
struct StrictSkipSeed;

impl<'de> DeserializeSeed<'de> for StrictSkipSeed {
    type Value = ();

    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<Self::Value, D::Error> {
        deserializer.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for StrictSkipSeed {
    type Value = ();

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("any JSON value")
    }

    fn visit_bool<E: de::Error>(self, _: bool) -> Result<Self::Value, E> { Ok(()) }
    fn visit_i64<E: de::Error>(self, _: i64) -> Result<Self::Value, E> { Ok(()) }
    fn visit_u64<E: de::Error>(self, _: u64) -> Result<Self::Value, E> { Ok(()) }
    fn visit_f64<E: de::Error>(self, _: f64) -> Result<Self::Value, E> { Ok(()) }
    fn visit_str<E: de::Error>(self, _: &str) -> Result<Self::Value, E> { Ok(()) }
    fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> { Ok(()) }
    fn visit_none<E: de::Error>(self) -> Result<Self::Value, E> { Ok(()) }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
        while seq.next_element_seed(StrictSkipSeed)?.is_some() {}
        Ok(())
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        while map.next_key_seed(StrictSkipKeySeed)?.is_some() {
            map.next_value_seed(StrictSkipSeed)?;
        }
        Ok(())
    }
}

struct StrictSkipKeySeed;

impl<'de> DeserializeSeed<'de> for StrictSkipKeySeed {
    type Value = ();

    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<Self::Value, D::Error> {
        deserializer.deserialize_str(self)
    }
}

impl<'de> Visitor<'de> for StrictSkipKeySeed {
    type Value = ();
    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("JSON key")
    }
    fn visit_str<E: de::Error>(self, _: &str) -> Result<Self::Value, E> { Ok(()) }
}

struct StringOnlySeed;

impl<'de> DeserializeSeed<'de> for StringOnlySeed {
    type Value = Option<String>;

    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<Self::Value, D::Error> {
        deserializer.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for StringOnlySeed {
    type Value = Option<String>;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("any JSON value")
    }

    fn visit_bool<E: de::Error>(self, _: bool) -> Result<Self::Value, E> { Ok(None) }
    fn visit_i64<E: de::Error>(self, _: i64) -> Result<Self::Value, E> { Ok(None) }
    fn visit_u64<E: de::Error>(self, _: u64) -> Result<Self::Value, E> { Ok(None) }
    fn visit_f64<E: de::Error>(self, _: f64) -> Result<Self::Value, E> { Ok(None) }
    fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> { Ok(None) }
    fn visit_none<E: de::Error>(self) -> Result<Self::Value, E> { Ok(None) }
    fn visit_str<E: de::Error>(self, v: &str) -> Result<Self::Value, E> { Ok(Some(v.to_string())) }
    fn visit_string<E: de::Error>(self, v: String) -> Result<Self::Value, E> { Ok(Some(v)) }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
        while seq.next_element_seed(StrictSkipSeed)?.is_some() {}
        Ok(None)
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        while map.next_key_seed(StrictSkipKeySeed)?.is_some() {
            map.next_value_seed(StrictSkipSeed)?;
        }
        Ok(None)
    }
}

struct BoolOnlySeed;

impl<'de> DeserializeSeed<'de> for BoolOnlySeed {
    type Value = Option<bool>;

    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<Self::Value, D::Error> {
        deserializer.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for BoolOnlySeed {
    type Value = Option<bool>;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("any JSON value")
    }

    fn visit_bool<E: de::Error>(self, v: bool) -> Result<Self::Value, E> { Ok(Some(v)) }
    fn visit_i64<E: de::Error>(self, _: i64) -> Result<Self::Value, E> { Ok(None) }
    fn visit_u64<E: de::Error>(self, _: u64) -> Result<Self::Value, E> { Ok(None) }
    fn visit_f64<E: de::Error>(self, _: f64) -> Result<Self::Value, E> { Ok(None) }
    fn visit_str<E: de::Error>(self, _: &str) -> Result<Self::Value, E> { Ok(None) }
    fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> { Ok(None) }
    fn visit_none<E: de::Error>(self) -> Result<Self::Value, E> { Ok(None) }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
        while seq.next_element_seed(StrictSkipSeed)?.is_some() {}
        Ok(None)
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        while map.next_key_seed(StrictSkipKeySeed)?.is_some() {
            map.next_value_seed(StrictSkipSeed)?;
        }
        Ok(None)
    }
}

#[derive(Clone)]
enum TimestampField {
    Absent,
    Valid(String),
    Invalid,
    Other,
}

struct TimestampSeed;

impl<'de> DeserializeSeed<'de> for TimestampSeed {
    type Value = TimestampField;

    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<Self::Value, D::Error> {
        deserializer.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for TimestampSeed {
    type Value = TimestampField;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("timestamp")
    }

    fn visit_bool<E: de::Error>(self, _: bool) -> Result<Self::Value, E> { Ok(TimestampField::Other) }
    fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> { Ok(TimestampField::Other) }
    fn visit_none<E: de::Error>(self) -> Result<Self::Value, E> { Ok(TimestampField::Other) }

    fn visit_i64<E: de::Error>(self, v: i64) -> Result<Self::Value, E> {
        Ok(valid_timestamp_f64(v as f64))
    }

    fn visit_u64<E: de::Error>(self, v: u64) -> Result<Self::Value, E> {
        Ok(valid_timestamp_f64(v as f64))
    }

    fn visit_f64<E: de::Error>(self, v: f64) -> Result<Self::Value, E> {
        Ok(valid_timestamp_f64(v))
    }

    fn visit_str<E: de::Error>(self, v: &str) -> Result<Self::Value, E> {
        Ok(valid_timestamp_str(v))
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
        while seq.next_element_seed(StrictSkipSeed)?.is_some() {}
        Ok(TimestampField::Other)
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        while map.next_key_seed(StrictSkipKeySeed)?.is_some() {
            map.next_value_seed(StrictSkipSeed)?;
        }
        Ok(TimestampField::Other)
    }
}

struct PreviousSessionFilesSeed;

impl<'de> DeserializeSeed<'de> for PreviousSessionFilesSeed {
    type Value = Option<Vec<String>>;

    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<Self::Value, D::Error> {
        deserializer.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for PreviousSessionFilesSeed {
    type Value = Option<Vec<String>>;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("previousSessionFiles")
    }

    fn visit_bool<E: de::Error>(self, _: bool) -> Result<Self::Value, E> { Ok(None) }
    fn visit_i64<E: de::Error>(self, _: i64) -> Result<Self::Value, E> { Ok(None) }
    fn visit_u64<E: de::Error>(self, _: u64) -> Result<Self::Value, E> { Ok(None) }
    fn visit_f64<E: de::Error>(self, _: f64) -> Result<Self::Value, E> { Ok(None) }
    fn visit_str<E: de::Error>(self, _: &str) -> Result<Self::Value, E> { Ok(None) }
    fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> { Ok(None) }
    fn visit_none<E: de::Error>(self) -> Result<Self::Value, E> { Ok(None) }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        while map.next_key_seed(StrictSkipKeySeed)?.is_some() {
            map.next_value_seed(StrictSkipSeed)?;
        }
        Ok(None)
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
        let mut items: Vec<String> = Vec::new();
        while let Some(raw) = seq.next_element_seed(StringOnlySeed)? {
            let Some(value) = raw else {
                continue;
            };
            if value.is_empty() || utf16_len(&value) > MAX_LINEAGE_CHARS {
                continue;
            }
            if items.len() >= MAX_PREVIOUS_FILES {
                // Keep validating remaining array elements with zero allocation.
                while seq.next_element_seed(StrictSkipSeed)?.is_some() {}
                break;
            }
            if !items.iter().any(|existing| existing == &value) {
                items.push(value);
            }
        }
        Ok(Some(items))
    }
}

enum BoundedTextSlice {
    Empty,
    Full(String),
    Split {
        head: String,
        tail: String,
        truncation_err: bool,
    },
}

impl BoundedTextSlice {
    fn from_str(s: &str) -> Self {
        if s.is_empty() {
            return Self::Empty;
        }
        // Only slice head/tail without cloning the full string if it could exceed MAX_TEXT_CHARS.
        if s.len() <= MAX_TEXT_CHARS * 3 && utf16_len(s) <= MAX_TEXT_CHARS {
            return Self::Full(s.to_string());
        }
        let len = utf16_len(s);
        if len <= MAX_TEXT_CHARS {
            return Self::Full(s.to_string());
        }
        let marker_len = utf16_len(TRUNCATION_MARKER);
        let available = MAX_TEXT_CHARS - marker_len;
        let head_units = available / 3;
        let tail_units = available - head_units;
        let head = match prefix_utf16(s, head_units) {
            Some(h) => h,
            None => {
                return Self::Split {
                    head: String::new(),
                    tail: String::new(),
                    truncation_err: true,
                };
            }
        };
        let tail = match suffix_utf16(s, tail_units) {
            Some(t) => t,
            None => {
                return Self::Split {
                    head: String::new(),
                    tail: String::new(),
                    truncation_err: true,
                };
            }
        };
        Self::Split {
            head,
            tail,
            truncation_err: false,
        }
    }

    fn resolve_single(&self) -> Result<String, ()> {
        match self {
            Self::Empty => Ok(String::new()),
            Self::Full(s) => Ok(s.clone()),
            Self::Split {
                head,
                tail,
                truncation_err,
            } => {
                if *truncation_err {
                    Err(())
                } else {
                    Ok(format!("{head}{TRUNCATION_MARKER}{tail}"))
                }
            }
        }
    }
}

fn append_bounded_slice(
    acc: &mut String,
    acc_utf16: &mut usize,
    slice: &BoundedTextSlice,
) -> Result<bool, ()> {
    match slice {
        BoundedTextSlice::Empty => Ok(false),
        BoundedTextSlice::Full(addition) => {
            let add_units = utf16_len(addition);
            let sep_units = usize::from(!acc.is_empty());
            if *acc_utf16 + sep_units + add_units <= MAX_TEXT_CHARS {
                if sep_units > 0 {
                    acc.push('\n');
                }
                acc.push_str(addition);
                *acc_utf16 += sep_units + add_units;
                return Ok(false);
            }
            if !acc.is_empty() {
                acc.push('\n');
            }
            acc.push_str(addition);
            *acc = bounded_string(acc, MAX_TEXT_CHARS)?;
            Ok(true)
        }
        BoundedTextSlice::Split {
            head: add_head,
            tail: add_tail,
            truncation_err,
        } => {
            if *truncation_err && acc.is_empty() {
                return Err(());
            }
            let marker_len = utf16_len(TRUNCATION_MARKER);
            let available = MAX_TEXT_CHARS - marker_len;
            let head_units = available / 3;
            if *acc_utf16 >= head_units {
                if *truncation_err {
                    return Err(());
                }
                let head = prefix_utf16(acc, head_units).ok_or(())?;
                *acc = format!("{head}{TRUNCATION_MARKER}{add_tail}");
                return Ok(true);
            }
            // Note: `acc` + '\n' consumes part of `head_units`, leaving a shorter
            // prefix needed from `add_head` (which already holds `head_units` units).
            if *truncation_err {
                // `add_head` wasn't extracted because `add_head` itself failed at `head_units`;
                // since `acc_utf16 < head_units`, fallback cleanly so TS computes exact offset if needed.
                return Err(());
            }
            let sep_units = usize::from(!acc.is_empty());
            let mut head = acc.clone();
            if sep_units > 0 {
                head.push('\n');
            }
            let rem = head_units - *acc_utf16 - sep_units;
            head.push_str(&prefix_utf16(add_head, rem).ok_or(())?);
            *acc = format!("{head}{TRUNCATION_MARKER}{add_tail}");
            Ok(true)
        }
    }
}

struct CompactTextSeed;

impl<'de> DeserializeSeed<'de> for CompactTextSeed {
    type Value = Option<BoundedTextSlice>;

    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<Self::Value, D::Error> {
        deserializer.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for CompactTextSeed {
    type Value = Option<BoundedTextSlice>;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("string or any")
    }

    fn visit_bool<E: de::Error>(self, _: bool) -> Result<Self::Value, E> { Ok(None) }
    fn visit_i64<E: de::Error>(self, _: i64) -> Result<Self::Value, E> { Ok(None) }
    fn visit_u64<E: de::Error>(self, _: u64) -> Result<Self::Value, E> { Ok(None) }
    fn visit_f64<E: de::Error>(self, _: f64) -> Result<Self::Value, E> { Ok(None) }
    fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> { Ok(None) }
    fn visit_none<E: de::Error>(self) -> Result<Self::Value, E> { Ok(None) }

    fn visit_str<E: de::Error>(self, v: &str) -> Result<Self::Value, E> {
        Ok(Some(BoundedTextSlice::from_str(v)))
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
        while seq.next_element_seed(StrictSkipSeed)?.is_some() {}
        Ok(None)
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        while map.next_key_seed(StrictSkipKeySeed)?.is_some() {
            map.next_value_seed(StrictSkipSeed)?;
        }
        Ok(None)
    }
}

enum MetaKey {
    Type,
    Timestamp,
    Id,
    Cwd,
    ParentSession,
    PreviousSessionFiles,
    Configured,
    ThinkingLevel,
    Role,
    Model,
    Title,
    Message,
    Other,
}

struct MetaKeySeed;

impl<'de> DeserializeSeed<'de> for MetaKeySeed {
    type Value = MetaKey;

    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<Self::Value, D::Error> {
        deserializer.deserialize_str(self)
    }
}

impl<'de> Visitor<'de> for MetaKeySeed {
    type Value = MetaKey;
    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("field key")
    }
    fn visit_str<E: de::Error>(self, key: &str) -> Result<Self::Value, E> {
        Ok(match key {
            "type" => MetaKey::Type,
            "timestamp" => MetaKey::Timestamp,
            "id" => MetaKey::Id,
            "cwd" => MetaKey::Cwd,
            "parentSession" => MetaKey::ParentSession,
            "previousSessionFiles" => MetaKey::PreviousSessionFiles,
            "configured" => MetaKey::Configured,
            "thinkingLevel" => MetaKey::ThinkingLevel,
            "role" => MetaKey::Role,
            "model" => MetaKey::Model,
            "title" => MetaKey::Title,
            "message" => MetaKey::Message,
            _ => MetaKey::Other,
        })
    }
}

enum BlockKey {
    Type,
    Text,
    Thinking,
    Other,
}

struct BlockKeySeed;

impl<'de> DeserializeSeed<'de> for BlockKeySeed {
    type Value = BlockKey;
    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<Self::Value, D::Error> {
        deserializer.deserialize_str(self)
    }
}

impl<'de> Visitor<'de> for BlockKeySeed {
    type Value = BlockKey;
    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("block key")
    }
    fn visit_str<E: de::Error>(self, key: &str) -> Result<Self::Value, E> {
        Ok(match key {
            "type" => BlockKey::Type,
            "text" => BlockKey::Text,
            "thinking" => BlockKey::Thinking,
            _ => BlockKey::Other,
        })
    }
}

enum MessageKey {
    Role,
    StopReason,
    Timestamp,
    Content,
    Other,
}

struct MessageKeySeed;

impl<'de> DeserializeSeed<'de> for MessageKeySeed {
    type Value = MessageKey;
    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<Self::Value, D::Error> {
        deserializer.deserialize_str(self)
    }
}

impl<'de> Visitor<'de> for MessageKeySeed {
    type Value = MessageKey;
    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("message key")
    }
    fn visit_str<E: de::Error>(self, key: &str) -> Result<Self::Value, E> {
        Ok(match key {
            "role" => MessageKey::Role,
            "stopReason" => MessageKey::StopReason,
            "timestamp" => MessageKey::Timestamp,
            "content" => MessageKey::Content,
            _ => MessageKey::Other,
        })
    }
}

#[derive(Copy, Clone, Eq, PartialEq)]
enum BlockKind {
    Text,
    Thinking,
    Other,
}

struct ContentBlockSeed;

impl<'de> DeserializeSeed<'de> for ContentBlockSeed {
    type Value = Option<BoundedTextSlice>;

    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<Self::Value, D::Error> {
        deserializer.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for ContentBlockSeed {
    type Value = Option<BoundedTextSlice>;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("content block")
    }

    fn visit_bool<E: de::Error>(self, _: bool) -> Result<Self::Value, E> { Ok(None) }
    fn visit_i64<E: de::Error>(self, _: i64) -> Result<Self::Value, E> { Ok(None) }
    fn visit_u64<E: de::Error>(self, _: u64) -> Result<Self::Value, E> { Ok(None) }
    fn visit_f64<E: de::Error>(self, _: f64) -> Result<Self::Value, E> { Ok(None) }
    fn visit_str<E: de::Error>(self, _: &str) -> Result<Self::Value, E> { Ok(None) }
    fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> { Ok(None) }
    fn visit_none<E: de::Error>(self) -> Result<Self::Value, E> { Ok(None) }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
        while seq.next_element_seed(StrictSkipSeed)?.is_some() {}
        Ok(None)
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let mut kind: Option<BlockKind> = None;
        let mut text: Option<BoundedTextSlice> = None;
        let mut thinking: Option<BoundedTextSlice> = None;

        while let Some(key) = map.next_key_seed(BlockKeySeed)? {
            match key {
                BlockKey::Type => {
                    kind = Some(match map.next_value_seed(StringOnlySeed)? {
                        Some(s) if s == "text" => BlockKind::Text,
                        Some(s) if s == "thinking" => BlockKind::Thinking,
                        _ => BlockKind::Other,
                    });
                }
                BlockKey::Text => {
                    text = map.next_value_seed(CompactTextSeed)?;
                }
                BlockKey::Thinking => {
                    thinking = map.next_value_seed(CompactTextSeed)?;
                }
                BlockKey::Other => {
                    map.next_value_seed(StrictSkipSeed)?;
                }
            }
        }

        Ok(match kind {
            Some(BlockKind::Text) => text,
            Some(BlockKind::Thinking) => thinking,
            _ => None,
        })
    }
}

struct MessageContentSeed;

impl<'de> DeserializeSeed<'de> for MessageContentSeed {
    type Value = Result<String, ()>;

    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<Self::Value, D::Error> {
        deserializer.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for MessageContentSeed {
    type Value = Result<String, ()>;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("message content")
    }

    fn visit_bool<E: de::Error>(self, _: bool) -> Result<Self::Value, E> { Ok(Ok(String::new())) }
    fn visit_i64<E: de::Error>(self, _: i64) -> Result<Self::Value, E> { Ok(Ok(String::new())) }
    fn visit_u64<E: de::Error>(self, _: u64) -> Result<Self::Value, E> { Ok(Ok(String::new())) }
    fn visit_f64<E: de::Error>(self, _: f64) -> Result<Self::Value, E> { Ok(Ok(String::new())) }
    fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> { Ok(Ok(String::new())) }
    fn visit_none<E: de::Error>(self) -> Result<Self::Value, E> { Ok(Ok(String::new())) }

    fn visit_str<E: de::Error>(self, v: &str) -> Result<Self::Value, E> {
        Ok(BoundedTextSlice::from_str(v).resolve_single())
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        while map.next_key_seed(StrictSkipKeySeed)?.is_some() {
            map.next_value_seed(StrictSkipSeed)?;
        }
        Ok(Ok(String::new()))
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
        let mut text = String::new();
        let mut text_utf16 = 0usize;
        let mut done = false;
        let mut trunc_err = false;
        while !done {
            let Some(block_opt) = seq.next_element_seed(ContentBlockSeed)? else {
                return Ok(Ok(text));
            };
            if let Some(slice) = block_opt {
                match append_bounded_slice(&mut text, &mut text_utf16, &slice) {
                    Ok(true) => done = true,
                    Ok(false) => {}
                    Err(()) => {
                        trunc_err = true;
                        done = true;
                    }
                }
            }
        }
        // Validate remaining array elements with zero heap allocations.
        while seq.next_element_seed(StrictSkipSeed)?.is_some() {}
        if trunc_err {
            Ok(Err(()))
        } else {
            Ok(Ok(text))
        }
    }
}

struct MessagePayload {
    role: Option<String>,
    stop_reason: Option<String>,
    timestamp: TimestampField,
    content_text: Result<String, ()>,
}

struct MessageFieldSeed;

impl<'de> DeserializeSeed<'de> for MessageFieldSeed {
    type Value = Option<MessagePayload>;

    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<Self::Value, D::Error> {
        deserializer.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for MessageFieldSeed {
    type Value = Option<MessagePayload>;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("message object")
    }

    fn visit_bool<E: de::Error>(self, _: bool) -> Result<Self::Value, E> { Ok(None) }
    fn visit_i64<E: de::Error>(self, _: i64) -> Result<Self::Value, E> { Ok(None) }
    fn visit_u64<E: de::Error>(self, _: u64) -> Result<Self::Value, E> { Ok(None) }
    fn visit_f64<E: de::Error>(self, _: f64) -> Result<Self::Value, E> { Ok(None) }
    fn visit_str<E: de::Error>(self, _: &str) -> Result<Self::Value, E> { Ok(None) }
    fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> { Ok(None) }
    fn visit_none<E: de::Error>(self) -> Result<Self::Value, E> { Ok(None) }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
        while seq.next_element_seed(StrictSkipSeed)?.is_some() {}
        Ok(None)
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let mut payload = MessagePayload {
            role: None,
            stop_reason: None,
            timestamp: TimestampField::Absent,
            content_text: Ok(String::new()),
        };
        while let Some(key) = map.next_key_seed(MessageKeySeed)? {
            match key {
                MessageKey::Role => payload.role = map.next_value_seed(StringOnlySeed)?,
                MessageKey::StopReason => payload.stop_reason = map.next_value_seed(StringOnlySeed)?,
                MessageKey::Timestamp => payload.timestamp = map.next_value_seed(TimestampSeed)?,
                MessageKey::Content => payload.content_text = map.next_value_seed(MessageContentSeed)?,
                MessageKey::Other => {
                    map.next_value_seed(StrictSkipSeed)?;
                }
            }
        }
        Ok(Some(payload))
    }
}

#[derive(Copy, Clone, Eq, PartialEq)]
enum RoleField {
    Absent,
    Default,
    Other,
}

struct RoleFieldSeed;

impl<'de> DeserializeSeed<'de> for RoleFieldSeed {
    type Value = RoleField;

    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<Self::Value, D::Error> {
        deserializer.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for RoleFieldSeed {
    type Value = RoleField;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("model role")
    }

    fn visit_bool<E: de::Error>(self, _: bool) -> Result<Self::Value, E> { Ok(RoleField::Other) }
    fn visit_i64<E: de::Error>(self, _: i64) -> Result<Self::Value, E> { Ok(RoleField::Other) }
    fn visit_u64<E: de::Error>(self, _: u64) -> Result<Self::Value, E> { Ok(RoleField::Other) }
    fn visit_f64<E: de::Error>(self, _: f64) -> Result<Self::Value, E> { Ok(RoleField::Other) }
    fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> { Ok(RoleField::Other) }
    fn visit_none<E: de::Error>(self) -> Result<Self::Value, E> { Ok(RoleField::Other) }

    fn visit_str<E: de::Error>(self, v: &str) -> Result<Self::Value, E> {
        Ok(if v == "default" {
            RoleField::Default
        } else {
            RoleField::Other
        })
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
        while seq.next_element_seed(StrictSkipSeed)?.is_some() {}
        Ok(RoleField::Other)
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        while map.next_key_seed(StrictSkipKeySeed)?.is_some() {
            map.next_value_seed(StrictSkipSeed)?;
        }
        Ok(RoleField::Other)
    }
}

struct MetaRecord {
    record_type: Option<String>,
    timestamp: TimestampField,
    id: Option<String>,
    cwd: Option<String>,
    parent_session: Option<String>,
    previous_session_files: Option<Vec<String>>,
    configured: Option<String>,
    thinking_level: Option<String>,
    role: RoleField,
    model: Option<String>,
    title: Option<String>,
    message: Option<MessagePayload>,
}

struct MetaRecordSeed;

impl<'de> DeserializeSeed<'de> for MetaRecordSeed {
    type Value = Option<MetaRecord>;

    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<Self::Value, D::Error> {
        deserializer.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for MetaRecordSeed {
    type Value = Option<MetaRecord>;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("JSONL metadata record")
    }

    fn visit_bool<E: de::Error>(self, _: bool) -> Result<Self::Value, E> { Ok(None) }
    fn visit_i64<E: de::Error>(self, _: i64) -> Result<Self::Value, E> { Ok(None) }
    fn visit_u64<E: de::Error>(self, _: u64) -> Result<Self::Value, E> { Ok(None) }
    fn visit_f64<E: de::Error>(self, _: f64) -> Result<Self::Value, E> { Ok(None) }
    fn visit_str<E: de::Error>(self, _: &str) -> Result<Self::Value, E> { Ok(None) }
    fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> { Ok(None) }
    fn visit_none<E: de::Error>(self) -> Result<Self::Value, E> { Ok(None) }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
        while seq.next_element_seed(StrictSkipSeed)?.is_some() {}
        Ok(None)
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let mut record = MetaRecord {
            record_type: None,
            timestamp: TimestampField::Absent,
            id: None,
            cwd: None,
            parent_session: None,
            previous_session_files: None,
            configured: None,
            thinking_level: None,
            role: RoleField::Absent,
            model: None,
            title: None,
            message: None,
        };
        while let Some(key) = map.next_key_seed(MetaKeySeed)? {
            match key {
                MetaKey::Type => record.record_type = map.next_value_seed(StringOnlySeed)?,
                MetaKey::Timestamp => record.timestamp = map.next_value_seed(TimestampSeed)?,
                MetaKey::Id => record.id = map.next_value_seed(StringOnlySeed)?,
                MetaKey::Cwd => record.cwd = map.next_value_seed(StringOnlySeed)?,
                MetaKey::ParentSession => record.parent_session = map.next_value_seed(StringOnlySeed)?,
                MetaKey::PreviousSessionFiles => record.previous_session_files = map.next_value_seed(PreviousSessionFilesSeed)?,
                MetaKey::Configured => record.configured = map.next_value_seed(StringOnlySeed)?,
                MetaKey::ThinkingLevel => record.thinking_level = map.next_value_seed(StringOnlySeed)?,
                MetaKey::Role => record.role = map.next_value_seed(RoleFieldSeed)?,
                MetaKey::Model => record.model = map.next_value_seed(StringOnlySeed)?,
                MetaKey::Title => record.title = map.next_value_seed(StringOnlySeed)?,
                MetaKey::Message => record.message = map.next_value_seed(MessageFieldSeed)?,
                MetaKey::Other => {
                    map.next_value_seed(StrictSkipSeed)?;
                }
            }
        }
        Ok(Some(record))
    }
}

fn ingest_meta_line(state: &mut Accumulator, line: &[u8]) -> Result<(), StreamFailure> {
    state.records += 1;
    if state.records > MAX_RECORDS {
        return Err(StreamFailure::Error("too-many-records"));
    }
    let Ok(text) = std::str::from_utf8(line) else {
        return Err(StreamFailure::Fallback("utf8"));
    };
    let mut de = serde_json::Deserializer::from_str(text);
    let Ok(record_opt) = MetaRecordSeed.deserialize(&mut de) else {
        return Err(StreamFailure::Fallback("json"));
    };
    if de.end().is_err() {
        return Err(StreamFailure::Fallback("json"));
    }
    let Some(record) = record_opt else {
        return Ok(());
    };
    match &record.timestamp {
        TimestampField::Valid(parsed) => {
            state.updated_at = parsed.clone();
            state.saw_record_timestamp = true;
        }
        TimestampField::Invalid => return Err(StreamFailure::Fallback("timestamp")),
        TimestampField::Absent | TimestampField::Other => {}
    }

    match record.record_type.as_deref() {
        Some("session") => {
            if let Some(id) = record.id {
                state.id = id;
            }
            if let Some(cwd) = record.cwd {
                state.project_path = cwd;
            }
            match &record.timestamp {
                TimestampField::Valid(parsed) => state.created_at = parsed.clone(),
                TimestampField::Invalid => return Err(StreamFailure::Fallback("timestamp")),
                TimestampField::Absent | TimestampField::Other => {}
            }
            if let Some(parent) = record.parent_session {
                if !parent.is_empty() && utf16_len(&parent) <= MAX_LINEAGE_CHARS {
                    state.parent_session = Some(parent);
                }
            }
            if let Some(previous) = record.previous_session_files {
                for value in previous {
                    if state.previous_session_files.len() >= MAX_PREVIOUS_FILES {
                        break;
                    }
                    if !state.previous_session_files.iter().any(|existing| existing == &value) {
                        state.previous_session_files.push(value);
                    }
                }
            }
        }
        Some("thinking_level_change") => {
            if record.configured.as_deref() == Some("auto") {
                state.thinking_level = Some("auto".to_string());
            } else if let Some(level) = record.thinking_level {
                state.thinking_level = Some(level);
            }
        }
        Some("message") => {
            let Some(message) = record.message else {
                return Ok(());
            };
            if let Some(role) = &message.role {
                state.last_role = Some(role.clone());
            }
            if let Some(stop_reason) = message.stop_reason {
                state.stop_reason = Some(stop_reason);
            }
            let Ok(text) = message.content_text else {
                return Err(StreamFailure::Fallback("truncation"));
            };
            let is_user = message.role.as_deref() == Some("user");
            let is_assistant = message.role.as_deref() == Some("assistant");
            if is_user {
                if state.first_user.is_empty() && !text.is_empty() {
                    state.first_user = text.clone();
                }
                if !text.is_empty() {
                    state.last_user_texts.push(text.clone());
                    if state.last_user_texts.len() > 3 {
                        state.last_user_texts.remove(0);
                    }
                }
                let message_ts = match message.timestamp {
                    TimestampField::Valid(parsed) => Some(parsed),
                    TimestampField::Invalid => return Err(StreamFailure::Fallback("timestamp")),
                    TimestampField::Absent | TimestampField::Other => None,
                };
                let record_ts = match record.timestamp {
                    TimestampField::Valid(parsed) => Some(parsed),
                    TimestampField::Invalid => return Err(StreamFailure::Fallback("timestamp")),
                    TimestampField::Absent | TimestampField::Other => None,
                };
                let fallback_ts = state
                    .last_user_message_at
                    .clone()
                    .unwrap_or_else(|| state.created_at.clone());
                state.last_user_message_at = Some(message_ts.or(record_ts).unwrap_or(fallback_ts));
            }
            if (is_assistant || is_user) && !text.is_empty() {
                state.preview = text;
            }
        }
        Some("model_change") => {
            if record.role == RoleField::Other {
                return Ok(());
            }
            let Some(model) = record.model else {
                return Ok(());
            };
            if let Some(separator) = model.find('/') {
                if separator > 0 {
                    state.provider = Some(model[..separator].to_string());
                    state.model = Some(model[separator + 1..].to_string());
                    return Ok(());
                }
            }
            state.provider = None;
            state.model = Some(model);
        }
        Some("title_change") | Some("title") => {
            if let Some(title) = record.title {
                state.display_name = Some(title);
            }
        }
        _ => {}
    }

    Ok(())
}

fn is_blank(value: &str) -> bool {
    value
        .chars()
        .all(|character| character.is_whitespace() || character == '\u{FEFF}')
}

fn js_trim(value: &str) -> &str {
    value.trim_matches(|character: char| character.is_whitespace() || character == '\u{FEFF}')
}

fn valid_timestamp_f64(number: f64) -> TimestampField {
    if !number.is_finite() || number.abs() > MAX_DATE_MS {
        return TimestampField::Other;
    }
    let millis = number.trunc() as i64;
    let Some(date) = Utc.timestamp_millis_opt(millis).single() else {
        return TimestampField::Invalid;
    };
    if !(0..=9999).contains(&date.year()) {
        return TimestampField::Invalid;
    }
    TimestampField::Valid(date.to_rfc3339_opts(SecondsFormat::Millis, true))
}

fn valid_timestamp_str(text: &str) -> TimestampField {
    let Ok(date) = DateTime::parse_from_rfc3339(text) else {
        return TimestampField::Invalid;
    };
    let utc = date.with_timezone(&Utc);
    if !(0..=9999).contains(&utc.year()) {
        return TimestampField::Invalid;
    }
    TimestampField::Valid(utc.to_rfc3339_opts(SecondsFormat::Millis, true))
}

fn utf16_len(value: &str) -> usize {
    if value.is_ascii() {
        return value.len();
    }
    value.chars().map(char::len_utf16).sum()
}

/// Per-edge recovery charge shared with the TypeScript reader: retained UTF-16
/// id/parent strings plus a fixed per-edge allowance. Both readers must charge
/// identically or one could accept a recovery the other rejects.
fn edge_charge(id: &str, parent: Option<&str>) -> usize {
    (utf16_len(id) + parent.map(utf16_len).unwrap_or(0)) * 2 + 64
}

fn prefix_utf16(value: &str, units: usize) -> Option<String> {
    let mut used = 0;
    for (index, character) in value.char_indices() {
        let length = character.len_utf16();
        if used + length > units {
            return if used == units {
                Some(value[..index].to_string())
            } else {
                None
            };
        }
        used += length;
    }
    Some(value.to_string())
}

fn suffix_utf16(value: &str, units: usize) -> Option<String> {
    let total = utf16_len(value);
    if units >= total {
        return Some(value.to_string());
    }
    let start = total - units;
    let mut used = 0;
    for (index, character) in value.char_indices() {
        let length = character.len_utf16();
        if used + length > start {
            return if used == start {
                Some(value[index..].to_string())
            } else {
                None
            };
        }
        used += length;
    }
    Some(String::new())
}

fn bounded_string(value: &str, max: usize) -> Result<String, ()> {
    if max == 0 {
        return Ok(String::new());
    }
    let length = utf16_len(value);
    if length <= max {
        return Ok(value.to_string());
    }
    let marker_length = utf16_len(TRUNCATION_MARKER);
    if max <= marker_length {
        return suffix_utf16(value, max).ok_or(());
    }
    let available = max - marker_length;
    let head_units = available / 3;
    let tail_units = available - head_units;
    let head = prefix_utf16(value, head_units).ok_or(())?;
    let tail = suffix_utf16(value, tail_units).ok_or(())?;
    Ok(format!("{head}{TRUNCATION_MARKER}{tail}"))
}

// ---------------------------------------------------------------------------
// Streaming Transcript Active-Branch Graph Indexer
// ---------------------------------------------------------------------------

// Linked insertion-ordered map storing Option<V> so unlink never needs Default.
struct MapSlot<V> {
    key: Option<Rc<str>>,
    value: Option<V>,
    prev: Option<usize>,
    next: Option<usize>,
}

struct LinkedMap<V> {
    slots: Vec<MapSlot<V>>,
    free: Vec<usize>,
    index: HashMap<Rc<str>, usize>,
    head: Option<usize>,
    tail: Option<usize>,
}

impl<V> LinkedMap<V> {
    fn new() -> Self {
        Self {
            slots: Vec::new(),
            free: Vec::new(),
            index: HashMap::new(),
            head: None,
            tail: None,
        }
    }

    fn len(&self) -> usize {
        self.index.len()
    }

    fn is_empty(&self) -> bool {
        self.index.is_empty()
    }

    fn contains_key(&self, key: &str) -> bool {
        self.index.contains_key(key)
    }

    fn get(&self, key: &str) -> Option<&V> {
        let &idx = self.index.get(key)?;
        self.slots[idx].value.as_ref()
    }

    fn last_key(&self) -> Option<&Rc<str>> {
        self.tail.and_then(|idx| self.slots[idx].key.as_ref())
    }

    fn remove(&mut self, key: &str) -> Option<V> {
        let idx = self.index.remove(key)?;
        Some(self.unlink(idx).1)
    }

    fn pop_front(&mut self) -> Option<(Rc<str>, V)> {
        let head_idx = self.head?;
        let key_ref = self.slots[head_idx].key.as_ref()?.clone();
        self.index.remove(key_ref.as_ref());
        Some(self.unlink(head_idx))
    }

    fn insert_back(&mut self, key: Rc<str>, value: V) -> Option<V> {
        let old = self.remove(key.as_ref());
        let old_tail = self.tail;
        let slot = MapSlot {
            key: Some(key.clone()),
            value: Some(value),
            prev: old_tail,
            next: None,
        };
        let idx = if let Some(recycled) = self.free.pop() {
            self.slots[recycled] = slot;
            recycled
        } else {
            let i = self.slots.len();
            self.slots.push(slot);
            i
        };
        if let Some(t) = old_tail {
            self.slots[t].next = Some(idx);
        } else {
            self.head = Some(idx);
        }
        self.tail = Some(idx);
        self.index.insert(key, idx);
        old
    }

    fn unlink(&mut self, idx: usize) -> (Rc<str>, V) {
        let prev = self.slots[idx].prev;
        let next = self.slots[idx].next;
        if let Some(p) = prev {
            self.slots[p].next = next;
        } else {
            self.head = next;
        }
        if let Some(n) = next {
            self.slots[n].prev = prev;
        } else {
            self.tail = prev;
        }
        self.slots[idx].prev = None;
        self.slots[idx].next = None;
        let key = self.slots[idx].key.take().expect("occupied slot key");
        let val = self.slots[idx].value.take().expect("occupied slot value");
        self.free.push(idx);
        (key, val)
    }
}

#[derive(Clone)]
enum RawTimestamp {
    Str(String),
    Int(i64),
    Uint(u64),
    Float(f64),
}

struct RawTimestampSeed;

impl<'de> DeserializeSeed<'de> for RawTimestampSeed {
    type Value = Option<RawTimestamp>;

    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<Self::Value, D::Error> {
        deserializer.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for RawTimestampSeed {
    type Value = Option<RawTimestamp>;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("raw timestamp")
    }

    fn visit_bool<E: de::Error>(self, _: bool) -> Result<Self::Value, E> { Ok(None) }
    fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> { Ok(None) }
    fn visit_none<E: de::Error>(self) -> Result<Self::Value, E> { Ok(None) }
    fn visit_i64<E: de::Error>(self, v: i64) -> Result<Self::Value, E> { Ok(Some(RawTimestamp::Int(v))) }
    fn visit_u64<E: de::Error>(self, v: u64) -> Result<Self::Value, E> { Ok(Some(RawTimestamp::Uint(v))) }
    fn visit_f64<E: de::Error>(self, v: f64) -> Result<Self::Value, E> {
        Ok(if v.is_finite() { Some(RawTimestamp::Float(v)) } else { None })
    }
    fn visit_str<E: de::Error>(self, v: &str) -> Result<Self::Value, E> {
        Ok(Some(RawTimestamp::Str(v.to_string())))
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
        while seq.next_element_seed(StrictSkipSeed)?.is_some() {}
        Ok(None)
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        while map.next_key_seed(StrictSkipKeySeed)?.is_some() {
            map.next_value_seed(StrictSkipSeed)?;
        }
        Ok(None)
    }
}

struct FiniteNonNegSeed;

impl<'de> DeserializeSeed<'de> for FiniteNonNegSeed {
    type Value = Option<RawTimestamp>;

    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<Self::Value, D::Error> {
        deserializer.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for FiniteNonNegSeed {
    type Value = Option<RawTimestamp>;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("non-negative number")
    }

    fn visit_bool<E: de::Error>(self, _: bool) -> Result<Self::Value, E> { Ok(None) }
    fn visit_str<E: de::Error>(self, _: &str) -> Result<Self::Value, E> { Ok(None) }
    fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> { Ok(None) }
    fn visit_none<E: de::Error>(self) -> Result<Self::Value, E> { Ok(None) }
    fn visit_i64<E: de::Error>(self, v: i64) -> Result<Self::Value, E> {
        Ok(if v >= 0 { Some(RawTimestamp::Int(v)) } else { None })
    }
    fn visit_u64<E: de::Error>(self, v: u64) -> Result<Self::Value, E> { Ok(Some(RawTimestamp::Uint(v))) }
    fn visit_f64<E: de::Error>(self, v: f64) -> Result<Self::Value, E> {
        Ok(if v.is_finite() && v >= 0.0 { Some(RawTimestamp::Float(v)) } else { None })
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
        while seq.next_element_seed(StrictSkipSeed)?.is_some() {}
        Ok(None)
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        while map.next_key_seed(StrictSkipKeySeed)?.is_some() {
            map.next_value_seed(StrictSkipSeed)?;
        }
        Ok(None)
    }
}

#[derive(Clone)]
enum ToolArgs {
    Str(String),
    Raw { json: Box<RawValue>, utf16_len: usize },
}

fn has_non_canonical_json(raw: &str) -> bool {
    let bytes = raw.as_bytes();
    let mut in_str = false;
    let mut escape = false;
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if in_str {
            if escape {
                if b == b'/' || b == b'u' {
                    return true;
                }
                escape = false;
            } else if b == b'\\' {
                escape = true;
            } else if b == b'"' {
                in_str = false;
            }
        } else {
            match b {
                b'"' => in_str = true,
                b' ' | b'\t' | b'\n' | b'\r' | b'e' | b'E' => return true,
                b'-' => {
                    if bytes.get(i + 1) == Some(&b'0') && !matches!(bytes.get(i + 2), Some(b'.' | b'0'..=b'9')) {
                        return true;
                    }
                }
                b'.' => {
                    let mut j = i + 1;
                    while j < bytes.len() && bytes[j].is_ascii_digit() {
                        j += 1;
                    }
                    if j > i + 1 && bytes[j - 1] == b'0' {
                        return true;
                    }
                }
                _ => {}
            }
        }
        i += 1;
    }
    false
}

fn normalize_tool_args(raw_opt: Option<Box<RawValue>>) -> Result<Option<ToolArgs>, &'static str> {
    let Some(raw) = raw_opt else {
        return Ok(None);
    };
    let s = raw.get();
    if s == "null" {
        return Ok(None);
    }
    if s.starts_with('"') {
        let Ok(unescaped) = serde_json::from_str::<String>(s) else {
            return Err("args-str");
        };
        let bounded = bounded_string(&unescaped, MAX_PART_ARGS_CHARS).map_err(|_| "truncation")?;
        return Ok(Some(ToolArgs::Str(bounded)));
    }
    if has_non_canonical_json(s) {
        return Err("args-format");
    }
    let len = utf16_len(s);
    if len <= MAX_PART_ARGS_CHARS {
        Ok(Some(ToolArgs::Raw { json: raw, utf16_len: len }))
    } else {
        let bounded = bounded_string(s, MAX_PART_ARGS_CHARS).map_err(|_| "truncation")?;
        Ok(Some(ToolArgs::Str(bounded)))
    }
}

#[derive(Clone)]
enum RawPart {
    Text(String),
    Thinking(String),
    ToolCall {
        id: Option<String>,
        name: String,
        args: Option<ToolArgs>,
    },
    ToolResult {
        name: Option<String>,
        text: String,
        is_error: bool,
    },
    Compaction {
        status: &'static str,
        tokens_before: Option<RawTimestamp>,
        tokens_after: Option<RawTimestamp>,
        summary: Option<String>,
        first_kept_entry_id: Option<String>,
        custom_instructions: Option<String>,
    },
}

enum TranscriptContentBlock {
    Skip,
    Text(String),
    Thinking(String),
    ToolCall {
        id: Option<String>,
        name: String,
        args: Option<ToolArgs>,
    },
    Fallback(&'static str),
}

enum BlockTypeValue {
    Absent,
    NonString,
    Text,
    Thinking,
    ToolCall,
    Other,
}

enum TranscriptBlockKey {
    Type,
    Text,
    Thinking,
    Id,
    Name,
    Arguments,
    Args,
    Other,
}

struct TranscriptBlockKeySeed;

impl<'de> DeserializeSeed<'de> for TranscriptBlockKeySeed {
    type Value = TranscriptBlockKey;
    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<Self::Value, D::Error> {
        deserializer.deserialize_str(self)
    }
}

impl<'de> Visitor<'de> for TranscriptBlockKeySeed {
    type Value = TranscriptBlockKey;
    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("block key")
    }
    fn visit_str<E: de::Error>(self, key: &str) -> Result<Self::Value, E> {
        Ok(match key {
            "type" => TranscriptBlockKey::Type,
            "text" => TranscriptBlockKey::Text,
            "thinking" => TranscriptBlockKey::Thinking,
            "id" => TranscriptBlockKey::Id,
            "name" => TranscriptBlockKey::Name,
            "arguments" => TranscriptBlockKey::Arguments,
            "args" => TranscriptBlockKey::Args,
            _ => TranscriptBlockKey::Other,
        })
    }
}

struct TranscriptContentBlockSeed;

impl<'de> DeserializeSeed<'de> for TranscriptContentBlockSeed {
    type Value = TranscriptContentBlock;

    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<Self::Value, D::Error> {
        deserializer.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for TranscriptContentBlockSeed {
    type Value = TranscriptContentBlock;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("transcript content block")
    }

    fn visit_bool<E: de::Error>(self, _: bool) -> Result<Self::Value, E> { Ok(TranscriptContentBlock::Skip) }
    fn visit_i64<E: de::Error>(self, _: i64) -> Result<Self::Value, E> { Ok(TranscriptContentBlock::Skip) }
    fn visit_u64<E: de::Error>(self, _: u64) -> Result<Self::Value, E> { Ok(TranscriptContentBlock::Skip) }
    fn visit_f64<E: de::Error>(self, _: f64) -> Result<Self::Value, E> { Ok(TranscriptContentBlock::Skip) }
    fn visit_str<E: de::Error>(self, _: &str) -> Result<Self::Value, E> { Ok(TranscriptContentBlock::Skip) }
    fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> { Ok(TranscriptContentBlock::Skip) }
    fn visit_none<E: de::Error>(self) -> Result<Self::Value, E> { Ok(TranscriptContentBlock::Skip) }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
        while seq.next_element_seed(StrictSkipSeed)?.is_some() {}
        Ok(TranscriptContentBlock::Skip)
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let mut block_type = BlockTypeValue::Absent;
        let mut text: Option<String> = None;
        let mut thinking: Option<String> = None;
        let mut id: Option<String> = None;
        let mut name: Option<String> = None;
        let mut arguments: Option<Box<RawValue>> = None;
        let mut args: Option<Box<RawValue>> = None;

        while let Some(key) = map.next_key_seed(TranscriptBlockKeySeed)? {
            match key {
                TranscriptBlockKey::Type => {
                    block_type = match map.next_value_seed(StringOnlySeed)? {
                        Some(s) if s == "text" => BlockTypeValue::Text,
                        Some(s) if s == "thinking" => BlockTypeValue::Thinking,
                        Some(s) if s == "toolCall" || s == "tool_call" => BlockTypeValue::ToolCall,
                        Some(_) => BlockTypeValue::Other,
                        None => BlockTypeValue::NonString,
                    };
                }
                TranscriptBlockKey::Text => text = map.next_value_seed(StringOnlySeed)?,
                TranscriptBlockKey::Thinking => thinking = map.next_value_seed(StringOnlySeed)?,
                TranscriptBlockKey::Id => id = map.next_value_seed(StringOnlySeed)?,
                TranscriptBlockKey::Name => name = map.next_value_seed(StringOnlySeed)?,
                TranscriptBlockKey::Arguments => {
                    arguments = map.next_value::<Option<Box<RawValue>>>()?;
                }
                TranscriptBlockKey::Args => {
                    args = map.next_value::<Option<Box<RawValue>>>()?;
                }
                TranscriptBlockKey::Other => {
                    map.next_value_seed(StrictSkipSeed)?;
                }
            }
        }

        Ok(match block_type {
            BlockTypeValue::Absent | BlockTypeValue::NonString => TranscriptContentBlock::Skip,
            BlockTypeValue::Other => TranscriptContentBlock::Fallback("unsupported-block"),
            BlockTypeValue::Text => match text {
                Some(t) => match bounded_string(&t, MAX_PART_TEXT_CHARS) {
                    Ok(b) => TranscriptContentBlock::Text(b),
                    Err(()) => TranscriptContentBlock::Fallback("truncation"),
                },
                None => TranscriptContentBlock::Fallback("unsupported-block"),
            },
            BlockTypeValue::Thinking => match thinking {
                Some(t) => match bounded_string(&t, MAX_PART_TEXT_CHARS) {
                    Ok(b) => TranscriptContentBlock::Thinking(b),
                    Err(()) => TranscriptContentBlock::Fallback("truncation"),
                },
                None => TranscriptContentBlock::Fallback("unsupported-block"),
            },
            BlockTypeValue::ToolCall => match name {
                Some(n) => {
                    let bounded_name = match bounded_string(&n, 512) {
                        Ok(b) => b,
                        Err(()) => return Ok(TranscriptContentBlock::Fallback("truncation")),
                    };
                    let bounded_id = match id {
                        Some(raw_id) => match bounded_string(&raw_id, MAX_ID_CHARS) {
                            Ok(b) => Some(b),
                            Err(()) => return Ok(TranscriptContentBlock::Fallback("truncation")),
                        },
                        None => None,
                    };
                    let chosen_raw = arguments.or(args);
                    let parsed_args = match normalize_tool_args(chosen_raw) {
                        Ok(a) => a,
                        Err(reason) => return Ok(TranscriptContentBlock::Fallback(reason)),
                    };
                    TranscriptContentBlock::ToolCall {
                        id: bounded_id,
                        name: bounded_name,
                        args: parsed_args,
                    }
                }
                None => TranscriptContentBlock::Fallback("unsupported-block"),
            },
        })
    }
}

enum TranscriptContentValue {
    Empty,
    Str(String),
    Array(Result<Vec<TranscriptContentBlock>, &'static str>),
    ObjectFallback,
}

struct TranscriptContentSeed;

impl<'de> DeserializeSeed<'de> for TranscriptContentSeed {
    type Value = TranscriptContentValue;

    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<Self::Value, D::Error> {
        deserializer.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for TranscriptContentSeed {
    type Value = TranscriptContentValue;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("message content")
    }

    fn visit_bool<E: de::Error>(self, _: bool) -> Result<Self::Value, E> { Ok(TranscriptContentValue::Empty) }
    fn visit_i64<E: de::Error>(self, _: i64) -> Result<Self::Value, E> { Ok(TranscriptContentValue::Empty) }
    fn visit_u64<E: de::Error>(self, _: u64) -> Result<Self::Value, E> { Ok(TranscriptContentValue::Empty) }
    fn visit_f64<E: de::Error>(self, _: f64) -> Result<Self::Value, E> { Ok(TranscriptContentValue::Empty) }
    fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> { Ok(TranscriptContentValue::Empty) }
    fn visit_none<E: de::Error>(self) -> Result<Self::Value, E> { Ok(TranscriptContentValue::Empty) }

    fn visit_str<E: de::Error>(self, v: &str) -> Result<Self::Value, E> {
        Ok(TranscriptContentValue::Str(v.to_string()))
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        while map.next_key_seed(StrictSkipKeySeed)?.is_some() {
            map.next_value_seed(StrictSkipSeed)?;
        }
        Ok(TranscriptContentValue::ObjectFallback)
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
        let mut blocks = Vec::new();
        let mut count = 0usize;
        let mut fallback_reason: Option<&'static str> = None;
        while let Some(block) = seq.next_element_seed(TranscriptContentBlockSeed)? {
            count += 1;
            if count > MAX_PARTS_PER_RECORD {
                fallback_reason = Some("many-parts");
                break;
            }
            if let TranscriptContentBlock::Fallback(reason) = block {
                fallback_reason = Some(reason);
                break;
            }
            if !matches!(block, TranscriptContentBlock::Skip) {
                blocks.push(block);
            }
        }
        if let Some(reason) = fallback_reason {
            while seq.next_element_seed(StrictSkipSeed)?.is_some() {}
            return Ok(TranscriptContentValue::Array(Err(reason)));
        }
        Ok(TranscriptContentValue::Array(Ok(blocks)))
    }
}

enum TranscriptMessageKey {
    Role,
    Content,
    Timestamp,
    ToolName,
    IsError,
    ToolCallId,
    StopReason,
    ErrorMessage,
    Other,
}

struct TranscriptMessageKeySeed;

impl<'de> DeserializeSeed<'de> for TranscriptMessageKeySeed {
    type Value = TranscriptMessageKey;
    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<Self::Value, D::Error> {
        deserializer.deserialize_str(self)
    }
}

impl<'de> Visitor<'de> for TranscriptMessageKeySeed {
    type Value = TranscriptMessageKey;
    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("message key")
    }
    fn visit_str<E: de::Error>(self, key: &str) -> Result<Self::Value, E> {
        Ok(match key {
            "role" => TranscriptMessageKey::Role,
            "content" => TranscriptMessageKey::Content,
            "timestamp" => TranscriptMessageKey::Timestamp,
            "toolName" => TranscriptMessageKey::ToolName,
            "isError" => TranscriptMessageKey::IsError,
            "toolCallId" => TranscriptMessageKey::ToolCallId,
            "stopReason" => TranscriptMessageKey::StopReason,
            "errorMessage" => TranscriptMessageKey::ErrorMessage,
            _ => TranscriptMessageKey::Other,
        })
    }
}

struct TranscriptMessageRaw {
    role: Option<String>,
    content: TranscriptContentValue,
    timestamp: Option<RawTimestamp>,
    tool_name: Option<String>,
    is_error: Option<bool>,
    tool_call_id: Option<String>,
    stop_reason: Option<String>,
    error_message: Option<String>,
}

struct TranscriptMessageSeed;

impl<'de> DeserializeSeed<'de> for TranscriptMessageSeed {
    type Value = Option<TranscriptMessageRaw>;

    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<Self::Value, D::Error> {
        deserializer.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for TranscriptMessageSeed {
    type Value = Option<TranscriptMessageRaw>;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("transcript message object")
    }

    fn visit_bool<E: de::Error>(self, _: bool) -> Result<Self::Value, E> { Ok(None) }
    fn visit_i64<E: de::Error>(self, _: i64) -> Result<Self::Value, E> { Ok(None) }
    fn visit_u64<E: de::Error>(self, _: u64) -> Result<Self::Value, E> { Ok(None) }
    fn visit_f64<E: de::Error>(self, _: f64) -> Result<Self::Value, E> { Ok(None) }
    fn visit_str<E: de::Error>(self, _: &str) -> Result<Self::Value, E> { Ok(None) }
    fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> { Ok(None) }
    fn visit_none<E: de::Error>(self) -> Result<Self::Value, E> { Ok(None) }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
        while seq.next_element_seed(StrictSkipSeed)?.is_some() {}
        Ok(None)
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let mut msg = TranscriptMessageRaw {
            role: None,
            content: TranscriptContentValue::Empty,
            timestamp: None,
            tool_name: None,
            is_error: None,
            tool_call_id: None,
            stop_reason: None,
            error_message: None,
        };
        while let Some(key) = map.next_key_seed(TranscriptMessageKeySeed)? {
            match key {
                TranscriptMessageKey::Role => msg.role = map.next_value_seed(StringOnlySeed)?,
                TranscriptMessageKey::Content => msg.content = map.next_value_seed(TranscriptContentSeed)?,
                TranscriptMessageKey::Timestamp => msg.timestamp = map.next_value_seed(RawTimestampSeed)?,
                TranscriptMessageKey::ToolName => msg.tool_name = map.next_value_seed(StringOnlySeed)?,
                TranscriptMessageKey::IsError => msg.is_error = map.next_value_seed(BoolOnlySeed)?,
                TranscriptMessageKey::ToolCallId => msg.tool_call_id = map.next_value_seed(StringOnlySeed)?,
                TranscriptMessageKey::StopReason => msg.stop_reason = map.next_value_seed(StringOnlySeed)?,
                TranscriptMessageKey::ErrorMessage => msg.error_message = map.next_value_seed(StringOnlySeed)?,
                TranscriptMessageKey::Other => {
                    map.next_value_seed(StrictSkipSeed)?;
                }
            }
        }
        Ok(Some(msg))
    }
}

#[derive(Copy, Clone, Eq, PartialEq)]
enum MsgRole {
    User,
    Assistant,
    System,
    Tool,
}

#[derive(Clone)]
enum RetainedPayload {
    Compaction {
        timestamp: Option<String>,
        tokens_before: Option<RawTimestamp>,
        tokens_after: Option<RawTimestamp>,
        summary: Option<String>,
        first_kept_entry_id: Option<String>,
        custom_instructions: Option<String>,
    },
    StandaloneText {
        timestamp: Option<String>,
        text: String,
    },
    Message {
        entry_timestamp: Option<String>,
        timestamp: Option<RawTimestamp>,
        completed_at: Option<RawTimestamp>,
        role: MsgRole,
        tool_call_id: Option<String>,
        stop_reason: Option<String>,
        error_message: Option<String>,
        parts: Vec<RawPart>,
    },
    Fallback(&'static str),
}

struct RetainedEntry {
    bytes: usize,
    payload: RetainedPayload,
}

enum ActiveLeafField {
    Absent,
    Null,
    Str(String),
    Other,
}

struct TranscriptRecord {
    record_type: Option<String>,
    id: Option<String>,
    parent_id: Option<String>,
    active_leaf: ActiveLeafField,
    display: Option<bool>,
    to: Option<String>,
    model: Option<String>,
    resolved_model_is_fallback: Option<bool>,
    timestamp: Option<String>,
    tokens_before: Option<RawTimestamp>,
    tokens_after: Option<RawTimestamp>,
    summary: Option<String>,
    first_kept_entry_id: Option<String>,
    custom_instructions: Option<String>,
    content: Option<TranscriptContentValue>,
    message: Option<TranscriptMessageRaw>,
}

struct ActiveLeafSeed;

impl<'de> DeserializeSeed<'de> for ActiveLeafSeed {
    type Value = ActiveLeafField;

    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<Self::Value, D::Error> {
        deserializer.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for ActiveLeafSeed {
    type Value = ActiveLeafField;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("activeLeafId")
    }

    fn visit_bool<E: de::Error>(self, _: bool) -> Result<Self::Value, E> { Ok(ActiveLeafField::Other) }
    fn visit_i64<E: de::Error>(self, _: i64) -> Result<Self::Value, E> { Ok(ActiveLeafField::Other) }
    fn visit_u64<E: de::Error>(self, _: u64) -> Result<Self::Value, E> { Ok(ActiveLeafField::Other) }
    fn visit_f64<E: de::Error>(self, _: f64) -> Result<Self::Value, E> { Ok(ActiveLeafField::Other) }
    fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> { Ok(ActiveLeafField::Null) }
    fn visit_none<E: de::Error>(self) -> Result<Self::Value, E> { Ok(ActiveLeafField::Null) }
    fn visit_str<E: de::Error>(self, v: &str) -> Result<Self::Value, E> {
        Ok(ActiveLeafField::Str(v.to_string()))
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
        while seq.next_element_seed(StrictSkipSeed)?.is_some() {}
        Ok(ActiveLeafField::Other)
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        while map.next_key_seed(StrictSkipKeySeed)?.is_some() {
            map.next_value_seed(StrictSkipSeed)?;
        }
        Ok(ActiveLeafField::Other)
    }
}

enum TranscriptKey {
    Type,
    Id,
    ParentId,
    ActiveLeafId,
    Display,
    To,
    Model,
    ResolvedModelIsFallback,
    Timestamp,
    TokensBefore,
    TokensAfter,
    Summary,
    FirstKeptEntryId,
    CustomInstructions,
    Content,
    Message,
    Other,
}

struct TranscriptKeySeed;

impl<'de> DeserializeSeed<'de> for TranscriptKeySeed {
    type Value = TranscriptKey;
    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<Self::Value, D::Error> {
        deserializer.deserialize_str(self)
    }
}

impl<'de> Visitor<'de> for TranscriptKeySeed {
    type Value = TranscriptKey;
    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("transcript key")
    }
    fn visit_str<E: de::Error>(self, key: &str) -> Result<Self::Value, E> {
        Ok(match key {
            "type" => TranscriptKey::Type,
            "id" => TranscriptKey::Id,
            "parentId" => TranscriptKey::ParentId,
            "activeLeafId" => TranscriptKey::ActiveLeafId,
            "display" => TranscriptKey::Display,
            "to" => TranscriptKey::To,
            "model" => TranscriptKey::Model,
            "resolvedModelIsFallback" => TranscriptKey::ResolvedModelIsFallback,
            "timestamp" => TranscriptKey::Timestamp,
            "tokensBefore" => TranscriptKey::TokensBefore,
            "tokensAfter" => TranscriptKey::TokensAfter,
            "summary" => TranscriptKey::Summary,
            "firstKeptEntryId" => TranscriptKey::FirstKeptEntryId,
            "customInstructions" => TranscriptKey::CustomInstructions,
            "content" => TranscriptKey::Content,
            "message" => TranscriptKey::Message,
            _ => TranscriptKey::Other,
        })
    }
}

struct TranscriptLineSeed {
    dialect_mode: u32,
}

impl<'de> DeserializeSeed<'de> for TranscriptLineSeed {
    type Value = Option<TranscriptRecord>;

    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<Self::Value, D::Error> {
        deserializer.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for TranscriptLineSeed {
    type Value = Option<TranscriptRecord>;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("transcript JSONL record")
    }

    fn visit_bool<E: de::Error>(self, _: bool) -> Result<Self::Value, E> { Ok(None) }
    fn visit_i64<E: de::Error>(self, _: i64) -> Result<Self::Value, E> { Ok(None) }
    fn visit_u64<E: de::Error>(self, _: u64) -> Result<Self::Value, E> { Ok(None) }
    fn visit_f64<E: de::Error>(self, _: f64) -> Result<Self::Value, E> { Ok(None) }
    fn visit_str<E: de::Error>(self, _: &str) -> Result<Self::Value, E> { Ok(None) }
    fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> { Ok(None) }
    fn visit_none<E: de::Error>(self) -> Result<Self::Value, E> { Ok(None) }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
        while seq.next_element_seed(StrictSkipSeed)?.is_some() {}
        Ok(None)
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let mut record = TranscriptRecord {
            record_type: None,
            id: None,
            parent_id: None,
            active_leaf: ActiveLeafField::Absent,
            display: None,
            to: None,
            model: None,
            resolved_model_is_fallback: None,
            timestamp: None,
            tokens_before: None,
            tokens_after: None,
            summary: None,
            first_kept_entry_id: None,
            custom_instructions: None,
            content: None,
            message: None,
        };
        while let Some(key) = map.next_key_seed(TranscriptKeySeed)? {
            match key {
                TranscriptKey::Type => record.record_type = map.next_value_seed(StringOnlySeed)?,
                TranscriptKey::Id => record.id = map.next_value_seed(StringOnlySeed)?,
                TranscriptKey::ParentId => record.parent_id = map.next_value_seed(StringOnlySeed)?,
                TranscriptKey::ActiveLeafId => record.active_leaf = map.next_value_seed(ActiveLeafSeed)?,
                TranscriptKey::Display => record.display = map.next_value_seed(BoolOnlySeed)?,
                TranscriptKey::To if self.dialect_mode == 1 => record.to = map.next_value_seed(StringOnlySeed)?,
                TranscriptKey::Model if self.dialect_mode == 1 => record.model = map.next_value_seed(StringOnlySeed)?,
                TranscriptKey::ResolvedModelIsFallback if self.dialect_mode == 1 => {
                    record.resolved_model_is_fallback = map.next_value_seed(BoolOnlySeed)?;
                }
                TranscriptKey::Timestamp => record.timestamp = map.next_value_seed(StringOnlySeed)?,
                TranscriptKey::TokensBefore => record.tokens_before = map.next_value_seed(FiniteNonNegSeed)?,
                TranscriptKey::TokensAfter => record.tokens_after = map.next_value_seed(FiniteNonNegSeed)?,
                TranscriptKey::Summary => record.summary = map.next_value_seed(StringOnlySeed)?,
                TranscriptKey::FirstKeptEntryId => record.first_kept_entry_id = map.next_value_seed(StringOnlySeed)?,
                TranscriptKey::CustomInstructions => record.custom_instructions = map.next_value_seed(StringOnlySeed)?,
                TranscriptKey::Content if self.dialect_mode == 1 => {
                    record.content = Some(map.next_value_seed(TranscriptContentSeed)?);
                }
                TranscriptKey::Message => record.message = map.next_value_seed(TranscriptMessageSeed)?,
                _ => {
                    map.next_value_seed(StrictSkipSeed)?;
                }
            }
        }
        Ok(Some(record))
    }
}

fn fallback_model_label(record: &TranscriptRecord) -> Option<String> {
    let candidate = match record.record_type.as_deref() {
        Some("retry_fallback_applied") => record.to.as_deref(),
        Some("retry_fallback_succeeded") => record.model.as_deref(),
        Some("model_change") if record.resolved_model_is_fallback == Some(true) => {
            record.model.as_deref()
        }
        _ => None,
    };
    let single_model = js_trim(candidate?);
    if single_model.is_empty() {
        return None;
    }
    if let Some(sep) = single_model.find('/') {
        if sep > 0 {
            let provider = js_trim(&single_model[..sep]);
            let id = js_trim(&single_model[sep + 1..]);
            if id.is_empty() {
                return None;
            }
            return Some(if provider.is_empty() {
                id.to_string()
            } else {
                format!("{provider}/{id}")
            });
        }
    }
    Some(single_model.to_string())
}

fn build_retained_payload(dialect_mode: u32, record: TranscriptRecord) -> Option<RetainedPayload> {
    let bound_opt = |opt: Option<String>, max: usize| -> Result<Option<String>, &'static str> {
        match opt {
            Some(s) => bounded_string(&s, max).map(Some).map_err(|_| "truncation"),
            None => Ok(None),
        }
    };
    match record.record_type.as_deref() {
        Some("compaction") => {
            let timestamp = match bound_opt(record.timestamp, 128) {
                Ok(t) => t,
                Err(r) => return Some(RetainedPayload::Fallback(r)),
            };
            let summary = match bound_opt(record.summary, MAX_PART_TEXT_CHARS) {
                Ok(s) => s,
                Err(r) => return Some(RetainedPayload::Fallback(r)),
            };
            let first_kept_entry_id = match bound_opt(record.first_kept_entry_id, MAX_ID_CHARS) {
                Ok(f) => f,
                Err(r) => return Some(RetainedPayload::Fallback(r)),
            };
            let custom_instructions = match bound_opt(record.custom_instructions, MAX_PART_TEXT_CHARS) {
                Ok(c) => c,
                Err(r) => return Some(RetainedPayload::Fallback(r)),
            };
            Some(RetainedPayload::Compaction {
                timestamp,
                tokens_before: record.tokens_before,
                tokens_after: record.tokens_after,
                summary,
                first_kept_entry_id,
                custom_instructions,
            })
        }
        Some("custom_message") if record.display == Some(true) => {
            Some(RetainedPayload::Fallback("custom-message"))
        }
        Some("branch_summary") if dialect_mode == 1 => {
            let timestamp = match bound_opt(record.timestamp, 128) {
                Ok(t) => t,
                Err(r) => return Some(RetainedPayload::Fallback(r)),
            };
            let text = if let Some(s) = record.summary {
                s
            } else if let Some(TranscriptContentValue::Str(s)) = record.content {
                s
            } else if matches!(record.content, None | Some(TranscriptContentValue::Empty)) {
                String::new()
            } else {
                return Some(RetainedPayload::Fallback("branch-summary"));
            };
            let Ok(bounded) = bounded_string(&text, MAX_PART_TEXT_CHARS) else {
                return Some(RetainedPayload::Fallback("truncation"));
            };
            Some(RetainedPayload::StandaloneText { timestamp, text: bounded })
        }
        Some("message") => {
            let Some(msg) = record.message else {
                return Some(RetainedPayload::Fallback("missing-message"));
            };
            let (role, is_tool_result_shape) = match msg.role.as_deref() {
                Some("user") => (MsgRole::User, false),
                Some("assistant") => (MsgRole::Assistant, false),
                Some("system") => (MsgRole::System, false),
                Some("tool") | Some("toolResult") => (MsgRole::Tool, true),
                _ => return Some(RetainedPayload::Fallback("message-role")),
            };
            if role == MsgRole::User {
                match &msg.content {
                    TranscriptContentValue::Str(s) if s.starts_with("===== BEGIN GOOEYPI AGENT MESSAGE =====\n") => {
                        return Some(RetainedPayload::Fallback("collab-message"));
                    }
                    TranscriptContentValue::Array(Ok(blocks)) => {
                        let mut first_line = String::new();
                        for block in blocks {
                            let piece = match block {
                                TranscriptContentBlock::Text(t) | TranscriptContentBlock::Thinking(t) => t.as_str(),
                                _ => "",
                            };
                            if piece.is_empty() { continue; }
                            if !first_line.is_empty() { first_line.push('\n'); }
                            first_line.push_str(piece);
                            if first_line.len() >= 40 { break; }
                        }
                        if first_line.starts_with("===== BEGIN GOOEYPI AGENT MESSAGE =====") {
                            return Some(RetainedPayload::Fallback("collab-message"));
                        }
                    }
                    _ => {}
                }
            }
            let entry_timestamp = match bound_opt(record.timestamp, 128) {
                Ok(t) => t,
                Err(r) => return Some(RetainedPayload::Fallback(r)),
            };
            let timestamp = match msg.timestamp {
                Some(RawTimestamp::Str(s)) => match bounded_string(&s, 128) {
                    Ok(b) => Some(RawTimestamp::Str(b)),
                    Err(()) => return Some(RetainedPayload::Fallback("truncation")),
                },
                Some(num) => Some(num),
                None => entry_timestamp.clone().map(RawTimestamp::Str),
            };
            let completed_at = entry_timestamp.clone().map(RawTimestamp::Str).or_else(|| timestamp.clone());
            let parts = if is_tool_result_shape {
                let joined = match msg.content {
                    TranscriptContentValue::Str(s) => match bounded_string(&s, MAX_PART_TEXT_CHARS) {
                        Ok(b) => b,
                        Err(()) => return Some(RetainedPayload::Fallback("truncation")),
                    },
                    TranscriptContentValue::Empty => String::new(),
                    TranscriptContentValue::ObjectFallback => return Some(RetainedPayload::Fallback("tool-object")),
                    TranscriptContentValue::Array(Err(reason)) => return Some(RetainedPayload::Fallback(reason)),
                    TranscriptContentValue::Array(Ok(blocks)) => {
                        let mut out = String::new();
                        for block in blocks {
                            if let TranscriptContentBlock::Text(t) = block {
                                if !out.is_empty() {
                                    out.push('\n');
                                }
                                out.push_str(&t);
                            }
                        }
                        out
                    }
                };
                let Ok(text) = bounded_string(&joined, MAX_PART_TOOL_CHARS) else {
                    return Some(RetainedPayload::Fallback("truncation"));
                };
                let tool_name = match bound_opt(msg.tool_name, 512) {
                    Ok(n) => n,
                    Err(r) => return Some(RetainedPayload::Fallback(r)),
                };
                vec![RawPart::ToolResult {
                    name: tool_name,
                    text,
                    is_error: msg.is_error == Some(true),
                }]
            } else {
                let mut parts = match msg.content {
                    TranscriptContentValue::Empty | TranscriptContentValue::ObjectFallback => Vec::new(),
                    TranscriptContentValue::Str(s) => match bounded_string(&s, MAX_PART_TEXT_CHARS) {
                        Ok(b) => vec![RawPart::Text(b)],
                        Err(()) => return Some(RetainedPayload::Fallback("truncation")),
                    },
                    TranscriptContentValue::Array(Err(reason)) => return Some(RetainedPayload::Fallback(reason)),
                    TranscriptContentValue::Array(Ok(blocks)) => blocks
                        .into_iter()
                        .filter_map(|b| match b {
                            TranscriptContentBlock::Text(t) => Some(RawPart::Text(t)),
                            TranscriptContentBlock::Thinking(t) => Some(RawPart::Thinking(t)),
                            TranscriptContentBlock::ToolCall { id, name, args } => Some(RawPart::ToolCall { id, name, args }),
                            TranscriptContentBlock::Skip | TranscriptContentBlock::Fallback(_) => None,
                        })
                        .collect(),
                };
                if parts.is_empty() {
                    parts.push(RawPart::Text(String::new()));
                }
                parts
            };
            let tool_call_id = match bound_opt(msg.tool_call_id, MAX_ID_CHARS) {
                Ok(id) => id,
                Err(r) => return Some(RetainedPayload::Fallback(r)),
            };
            let error_message = match msg.error_message {
                Some(raw) if !js_trim(&raw).is_empty() => match bounded_string(&raw, MAX_PART_TEXT_CHARS) {
                    Ok(b) => Some(b),
                    Err(()) => return Some(RetainedPayload::Fallback("truncation")),
                },
                _ => None,
            };
            Some(RetainedPayload::Message {
                entry_timestamp,
                timestamp,
                completed_at,
                role,
                tool_call_id,
                stop_reason: msg.stop_reason,
                error_message,
                parts,
            })
        }
        _ if dialect_mode == 1 => {
            if let Some(label) = fallback_model_label(&record) {
                let timestamp = match bound_opt(record.timestamp, 128) {
                    Ok(t) => t,
                    Err(r) => return Some(RetainedPayload::Fallback(r)),
                };
                let notice = format!("Switched to {label} due to a provider fallback");
                let Ok(text) = bounded_string(&notice, MAX_PART_TEXT_CHARS) else {
                    return Some(RetainedPayload::Fallback("truncation"));
                };
                Some(RetainedPayload::StandaloneText { timestamp, text })
            } else {
                None
            }
        }
        _ => None,
    }
}

struct DraftNode {
    part: RawPart,
    next: Option<usize>,
}

struct AssistantDraft {
    message_idx: usize,
    head: Option<usize>,
    tail: Option<usize>,
    nodes: Vec<DraftNode>,
    tool_calls: HashMap<String, usize>,
}

impl AssistantDraft {
    fn insert_part(&mut self, after: Option<usize>, part: RawPart) -> usize {
        let next = match after {
            Some(a) => self.nodes[a].next,
            None => self.head,
        };
        let idx = self.nodes.len();
        if let RawPart::ToolCall { id: Some(ref call_id), .. } = part {
            self.tool_calls.entry(call_id.clone()).or_insert(idx);
        }
        self.nodes.push(DraftNode { part, next });
        if let Some(a) = after {
            self.nodes[a].next = Some(idx);
        } else {
            self.head = Some(idx);
        }
        if next.is_none() {
            self.tail = Some(idx);
        }
        idx
    }

    fn append_parts(&mut self, parts: Vec<RawPart>) {
        for part in parts {
            let tail = self.tail;
            self.insert_part(tail, part);
        }
    }

    fn materialize(self) -> Vec<RawPart> {
        let mut out = Vec::with_capacity(self.nodes.len());
        let mut cur = self.head;
        while let Some(idx) = cur {
            out.push(self.nodes[idx].part.clone());
            cur = self.nodes[idx].next;
        }
        out
    }
}

struct OutMessage {
    id: String,
    role: &'static str,
    timestamp: Option<RawTimestamp>,
    started_at: Option<RawTimestamp>,
    completed_at: Option<RawTimestamp>,
    outcome: Option<&'static str>,
    parts: Vec<RawPart>,
}

enum BoundedPart {
    Text { kind: &'static str, text: String },
    ToolResult { name: Option<String>, text: String, is_error: bool },
    ToolCall { id: Option<String>, name: String, args: Option<ToolArgs> },
    Compaction {
        status: &'static str,
        tokens_before: Option<RawTimestamp>,
        tokens_after: Option<RawTimestamp>,
        summary: Option<String>,
        first_kept_entry_id: Option<String>,
        custom_instructions: Option<String>,
    },
}

struct BoundedMessage {
    id: String,
    role: &'static str,
    timestamp: Option<RawTimestamp>,
    started_at: Option<RawTimestamp>,
    completed_at: Option<RawTimestamp>,
    outcome: Option<&'static str>,
    parts: Vec<BoundedPart>,
}

struct TranscriptStream {
    dialect_mode: u32,
    entries: LinkedMap<RetainedEntry>,
    parent_edges: LinkedMap<Option<Rc<str>>>,
    parent_edges_evicted: bool,
    parent_edge_bytes: usize,
    graph_bytes: usize,
    payload_eviction_occurred: bool,
    evicted_renderable_ids: HashSet<Rc<str>>,
    evicted_renderable_id_chars: usize,
    evicted_renderable_ids_overflow: bool,
    last_record_id: Option<Rc<str>>,
    last_record_active_leaf: Option<Option<Rc<str>>>,
    self_selected_leaf_id: Option<Rc<str>>,
    record_count: usize,
    splitter: LineSplitter,
}

impl TranscriptStream {
    fn new(dialect_mode: u32) -> Self {
        Self {
            dialect_mode,
            entries: LinkedMap::new(),
            parent_edges: LinkedMap::new(),
            parent_edges_evicted: false,
            parent_edge_bytes: 0,
            graph_bytes: 0,
            payload_eviction_occurred: false,
            evicted_renderable_ids: HashSet::new(),
            evicted_renderable_id_chars: 0,
            evicted_renderable_ids_overflow: false,
            last_record_id: None,
            last_record_active_leaf: None,
            self_selected_leaf_id: None,
            record_count: 0,
            splitter: LineSplitter::new(),
        }
    }

    fn note_evicted_renderable(&mut self, id: &Rc<str>) {
        if self.evicted_renderable_ids.contains(id) {
            return;
        }
        let id_chars = utf16_len(id);
        if self.evicted_renderable_ids.len() >= MAX_EVICTED_RENDERABLE_IDS
            || self.evicted_renderable_id_chars + id_chars > MAX_EVICTED_RENDERABLE_ID_CHARS
        {
            self.evicted_renderable_ids_overflow = true;
            return;
        }
        self.evicted_renderable_id_chars += id_chars;
        self.evicted_renderable_ids.insert(id.clone());
    }

    fn ingest_line(&mut self, _offset: u64, line: &[u8]) -> Result<(), StreamFailure> {
        self.record_count += 1;
        if self.record_count > MAX_RECORDS {
            return Err(StreamFailure::Error("too-many-records"));
        }
        let Ok(text) = std::str::from_utf8(line) else {
            return Err(StreamFailure::Fallback("utf8"));
        };
        let mut de = serde_json::Deserializer::from_str(text);
        let Ok(record_opt) = (TranscriptLineSeed {
            dialect_mode: self.dialect_mode,
        })
        .deserialize(&mut de) else {
            return Err(StreamFailure::Fallback("json"));
        };
        if de.end().is_err() {
            return Err(StreamFailure::Fallback("json"));
        }
        let Some(record) = record_opt else {
            return Ok(());
        };
        if record.record_type.as_deref() == Some("session") {
            return Ok(());
        }
        let Some(raw_id) = record.id.as_deref() else {
            return Ok(());
        };
        if utf16_len(raw_id) > MAX_ID_CHARS {
            return Ok(());
        }

        let id_rc: Rc<str> = Rc::from(raw_id);
        let parent_id = record
            .parent_id
            .as_deref()
            .filter(|p| utf16_len(p) <= MAX_ID_CHARS)
            .map(Rc::from);

        if self.evicted_renderable_ids.remove(id_rc.as_ref()) {
            self.evicted_renderable_id_chars -= utf16_len(&id_rc);
        }
        let previous_parent = self.parent_edges.insert_back(id_rc.clone(), parent_id.clone());
        if let Some(previous) = previous_parent {
            self.parent_edge_bytes -= edge_charge(id_rc.as_ref(), previous.as_deref());
        }
        self.parent_edge_bytes += edge_charge(id_rc.as_ref(), parent_id.as_deref());
        // The retained edge window doubles as the recovery index. The TypeScript
        // reader charges the same per-edge cost over every unique id before it
        // walks a dangling capture and rejects past the 16 MiB budget instead of
        // guessing a branch; charge the identical amount here and mark the index
        // incomplete so a miss falls back to that exact bounded recovery.
        if self.parent_edge_bytes > MAX_TRANSCRIPT_GRAPH_BYTES {
            self.parent_edges_evicted = true;
        }
        while self.parent_edges.len() > MAX_PARENT_EDGES {
            self.parent_edges.pop_front();
            self.parent_edges_evicted = true;
        }

        self.last_record_id = Some(id_rc.clone());
        self.last_record_active_leaf = match &record.active_leaf {
            ActiveLeafField::Absent | ActiveLeafField::Other => None,
            ActiveLeafField::Null => Some(None),
            ActiveLeafField::Str(s) => {
                let Ok(bounded) = bounded_string(s, MAX_ID_CHARS) else {
                    return Err(StreamFailure::Fallback("truncation"));
                };
                Some(Some(Rc::from(bounded)))
            }
        };
        let self_selects = match &self.last_record_active_leaf {
            None => true,
            Some(Some(captured)) => captured.as_ref() == id_rc.as_ref(),
            Some(None) => false,
        };
        if self_selects {
            self.self_selected_leaf_id = Some(id_rc.clone());
        }

        if let Some(existing) = self.entries.remove(id_rc.as_ref()) {
            self.graph_bytes -= existing.bytes;
        }
        let Some(payload) = build_retained_payload(self.dialect_mode, record) else {
            return Ok(());
        };

        let bytes = line.len();
        self.entries
            .insert_back(id_rc, RetainedEntry { bytes, payload });
        self.graph_bytes += bytes;
        while self.entries.len() > MAX_TRANSCRIPT_GRAPH_RECORDS
            || self.graph_bytes > MAX_TRANSCRIPT_GRAPH_BYTES
        {
            let Some((oldest_id, oldest)) = self.entries.pop_front() else {
                break;
            };
            self.payload_eviction_occurred = true;
            self.note_evicted_renderable(&oldest_id);
            self.graph_bytes -= oldest.bytes;
        }
        Ok(())
    }

    fn push_chunk(&mut self, chunk: &[u8]) -> Result<(), StreamFailure> {
        let mut splitter = std::mem::replace(&mut self.splitter, LineSplitter::new());
        let res = splitter.feed(chunk, |offset, line| self.ingest_line(offset, line));
        self.splitter = splitter;
        res
    }

    fn walk_branch(&self, start_id: &Rc<str>) -> Result<Vec<Rc<str>>, &'static str> {
        let mut collected = Vec::new();
        let mut visited: HashSet<Rc<str>> = HashSet::new();
        let mut current: Option<Rc<str>> = Some(start_id.clone());
        while let Some(id) = current {
            if !visited.insert(id.clone()) {
                break;
            }
            let node = self.entries.get(id.as_ref());
            if node.is_some() {
                collected.push(id.clone());
            }
            if node.is_none() && self.evicted_renderable_ids_overflow {
                return Err("recover-edges");
            }
            let Some(parent_opt) = self.parent_edges.get(id.as_ref()) else {
                if self.parent_edges_evicted {
                    return Err("recover-edges");
                }
                break;
            };
            current = parent_opt.clone();
        }
        Ok(collected)
    }

    fn finish(mut self) -> Result<Vec<u8>, StreamFailure> {
        let mut splitter = std::mem::replace(&mut self.splitter, LineSplitter::new());
        splitter.finish(|offset, line| self.ingest_line(offset, line))?;

        let leaf_id: Option<Rc<str>> = match &self.last_record_id {
            None => None,
            Some(last_id) => match &self.last_record_active_leaf {
                Some(None) => None,
                Some(Some(captured)) => {
                    if captured.as_ref() == last_id.as_ref()
                        || self.parent_edges.contains_key(captured.as_ref())
                    {
                        Some(captured.clone())
                    } else if !self.parent_edges_evicted {
                        self.self_selected_leaf_id.clone()
                    } else {
                        return Err(StreamFailure::Fallback("recover-leaf"));
                    }
                }
                None => Some(last_id.clone()),
            },
        };

        let mut branch_ids = if let Some(ref leaf) = leaf_id {
            self.walk_branch(leaf).map_err(StreamFailure::Fallback)?
        } else {
            Vec::new()
        };

        if branch_ids.is_empty() && !self.entries.is_empty() && leaf_id.is_some() {
            if self.payload_eviction_occurred && leaf_id != self.self_selected_leaf_id {
                return Err(StreamFailure::Error("active-branch-too-large"));
            }
            let fallback_id = self.entries.last_key().expect("non-empty entries").clone();
            branch_ids = self
                .walk_branch(&fallback_id)
                .map_err(StreamFailure::Fallback)?;
        }

        branch_ids.reverse();

        for id in &branch_ids {
            if let Some(entry) = self.entries.get(id.as_ref()) {
                if let RetainedPayload::Fallback(reason) = entry.payload {
                    return Err(StreamFailure::Fallback(reason));
                }
            }
        }

        let mut transcript: Vec<OutMessage> = Vec::with_capacity(branch_ids.len());
        let mut active_assistant: Option<AssistantDraft> = None;

        let finish_assistant = |draft_opt: &mut Option<AssistantDraft>, out: &mut Vec<OutMessage>| {
            if let Some(draft) = draft_opt.take() {
                let idx = draft.message_idx;
                out[idx].parts = draft.materialize();
            }
        };

        for id in branch_ids {
            let Some(entry) = self.entries.remove(id.as_ref()) else {
                continue;
            };
            let safe_id = bounded_string(id.as_ref(), MAX_ID_CHARS).map_err(|_| StreamFailure::Fallback("truncation"))?;
            match entry.payload {
                RetainedPayload::Fallback(reason) => return Err(StreamFailure::Fallback(reason)),
                RetainedPayload::Compaction {
                    timestamp,
                    tokens_before,
                    tokens_after,
                    summary,
                    first_kept_entry_id,
                    custom_instructions,
                } => {
                    let ts = timestamp.map(RawTimestamp::Str);
                    transcript.push(OutMessage {
                        id: safe_id,
                        role: "system",
                        timestamp: ts.clone(),
                        started_at: ts.clone(),
                        completed_at: ts,
                        outcome: None,
                        parts: vec![RawPart::Compaction {
                            status: "done",
                            tokens_before,
                            tokens_after,
                            summary,
                            first_kept_entry_id,
                            custom_instructions,
                        }],
                    });
                    finish_assistant(&mut active_assistant, &mut transcript);
                }
                RetainedPayload::StandaloneText { timestamp, text } => {
                    let ts = timestamp.map(RawTimestamp::Str);
                    transcript.push(OutMessage {
                        id: safe_id,
                        role: "system",
                        timestamp: ts.clone(),
                        started_at: ts.clone(),
                        completed_at: ts,
                        outcome: None,
                        parts: vec![RawPart::Text(text)],
                    });
                    finish_assistant(&mut active_assistant, &mut transcript);
                }
                RetainedPayload::Message {
                    entry_timestamp,
                    timestamp,
                    completed_at,
                    role,
                    tool_call_id,
                    stop_reason,
                    error_message,
                    parts,
                } => {
                    if role == MsgRole::Tool {
                        if let Some(draft) = active_assistant.as_mut() {
                            let call_node = tool_call_id.as_ref().and_then(|cid| draft.tool_calls.get(cid).copied());
                            let mut cursor = call_node;
                            for part in parts {
                                let target = if call_node.is_some() { cursor } else { draft.tail };
                                cursor = Some(draft.insert_part(target, part));
                            }
                            if completed_at.is_some() {
                                transcript[draft.message_idx].completed_at = completed_at;
                            }
                            continue;
                        }
                    }
                    if role == MsgRole::Assistant {
                        let failed = stop_reason.as_deref() == Some("error");
                        let outcome = if failed { Some("failed") } else { None };
                        if let Some(draft) = active_assistant.as_mut() {
                            draft.append_parts(parts);
                            if completed_at.is_some() {
                                transcript[draft.message_idx].completed_at = completed_at.clone();
                            }
                            if outcome.is_some() {
                                transcript[draft.message_idx].outcome = outcome;
                            }
                        } else {
                            let msg_idx = transcript.len();
                            transcript.push(OutMessage {
                                id: safe_id.clone(),
                                role: "assistant",
                                timestamp: timestamp.clone(),
                                started_at: timestamp.clone(),
                                completed_at: completed_at.clone(),
                                outcome,
                                parts: Vec::new(),
                            });
                            let mut draft = AssistantDraft {
                                message_idx: msg_idx,
                                head: None,
                                tail: None,
                                nodes: Vec::new(),
                                tool_calls: HashMap::new(),
                            };
                            draft.append_parts(parts);
                            active_assistant = Some(draft);
                        }
                        if failed {
                            let failure = error_message.unwrap_or_else(|| "The turn failed.".to_string());
                            transcript.push(OutMessage {
                                id: format!("error-{safe_id}"),
                                role: "system",
                                timestamp: entry_timestamp.map(RawTimestamp::Str).or(timestamp),
                                started_at: None,
                                completed_at: None,
                                outcome: None,
                                parts: vec![RawPart::Text(failure)],
                            });
                            finish_assistant(&mut active_assistant, &mut transcript);
                        }
                        continue;
                    }
                    let role_str = match role {
                        MsgRole::User => "user",
                        MsgRole::System => "system",
                        MsgRole::Tool => "tool",
                        MsgRole::Assistant => "assistant",
                    };
                    transcript.push(OutMessage {
                        id: safe_id,
                        role: role_str,
                        timestamp,
                        started_at: None,
                        completed_at: None,
                        outcome: None,
                        parts,
                    });
                    finish_assistant(&mut active_assistant, &mut transcript);
                }
            }
        }
        finish_assistant(&mut active_assistant, &mut transcript);

        let mut text_budget = MAX_TRANSCRIPT_TEXT_CHARS;
        let mut tool_budget = MAX_TRANSCRIPT_TOOL_CHARS;
        let mut args_budget = MAX_TRANSCRIPT_ARGS_CHARS;
        let mut part_budget = MAX_TRANSCRIPT_PARTS;
        let mut bounded: Vec<BoundedMessage> = Vec::with_capacity(transcript.len().min(MAX_TRANSCRIPT_MESSAGES));

        for message in transcript.into_iter().rev().take(MAX_TRANSCRIPT_MESSAGES) {
            let mut bounded_parts: Vec<BoundedPart> = Vec::with_capacity(message.parts.len());
            for part in message.parts.into_iter().rev() {
                if part_budget == 0 {
                    break;
                }
                let next_part: Option<BoundedPart> = match part {
                    RawPart::Text(t) => {
                        if text_budget > 0 {
                            let bounded_t = bounded_string(&t, text_budget).map_err(|_| StreamFailure::Fallback("truncation"))?;
                            text_budget -= utf16_len(&bounded_t);
                            Some(BoundedPart::Text { kind: "text", text: bounded_t })
                        } else {
                            None
                        }
                    }
                    RawPart::Thinking(t) => {
                        if text_budget > 0 {
                            let bounded_t = bounded_string(&t, text_budget).map_err(|_| StreamFailure::Fallback("truncation"))?;
                            text_budget -= utf16_len(&bounded_t);
                            Some(BoundedPart::Text { kind: "thinking", text: bounded_t })
                        } else {
                            None
                        }
                    }
                    RawPart::ToolResult { name, text, is_error } => {
                        if tool_budget > 0 {
                            let bounded_t = bounded_string(&text, tool_budget).map_err(|_| StreamFailure::Fallback("truncation"))?;
                            tool_budget -= utf16_len(&bounded_t);
                            Some(BoundedPart::ToolResult { name, text: bounded_t, is_error })
                        } else {
                            None
                        }
                    }
                    RawPart::ToolCall { id, name, args } => {
                        let next_args = match args {
                            Some(ToolArgs::Str(s)) if args_budget > 0 => {
                                let len = utf16_len(&s);
                                let result_s = if len <= args_budget {
                                    s
                                } else {
                                    bounded_string(&s, args_budget).map_err(|_| StreamFailure::Fallback("truncation"))?
                                };
                                args_budget -= len.min(args_budget);
                                Some(ToolArgs::Str(result_s))
                            }
                            Some(ToolArgs::Raw { json, utf16_len: len }) if args_budget > 0 => {
                                let res = if len <= args_budget {
                                    ToolArgs::Raw { json, utf16_len: len }
                                } else {
                                    let truncated = bounded_string(json.get(), args_budget).map_err(|_| StreamFailure::Fallback("truncation"))?;
                                    ToolArgs::Str(truncated)
                                };
                                args_budget -= len.min(args_budget);
                                Some(res)
                            }
                            _ => None,
                        };
                        Some(BoundedPart::ToolCall { id, name, args: next_args })
                    }
                    RawPart::Compaction {
                        status,
                        tokens_before,
                        tokens_after,
                        summary,
                        first_kept_entry_id,
                        custom_instructions,
                    } => {
                        let mut bound_compaction = |opt: Option<String>| -> Result<Option<String>, StreamFailure> {
                            let Some(v) = opt else { return Ok(None); };
                            if v.is_empty() || text_budget == 0 {
                                return Ok(None);
                            }
                            let b = bounded_string(&v, text_budget).map_err(|_| StreamFailure::Fallback("truncation"))?;
                            text_budget -= utf16_len(&b);
                            Ok(Some(b))
                        };
                        let s = bound_compaction(summary)?;
                        let c = bound_compaction(custom_instructions)?;
                        Some(BoundedPart::Compaction {
                            status,
                            tokens_before,
                            tokens_after,
                            summary: s,
                            first_kept_entry_id,
                            custom_instructions: c,
                        })
                    }
                };
                if let Some(p) = next_part {
                    bounded_parts.push(p);
                    part_budget -= 1;
                }
            }
            if !bounded_parts.is_empty() {
                bounded_parts.reverse();
                bounded.push(BoundedMessage {
                    id: message.id,
                    role: message.role,
                    timestamp: message.timestamp,
                    started_at: message.started_at,
                    completed_at: message.completed_at,
                    outcome: message.outcome,
                    parts: bounded_parts,
                });
            }
        }
        bounded.reverse();

        let mut out = Vec::with_capacity(4096);
        out.extend_from_slice(b"{\"status\":\"ok\",\"messages\":[");
        for (msg_idx, msg) in bounded.iter().enumerate() {
            if msg_idx > 0 {
                out.push(b',');
            }
            out.extend_from_slice(b"{\"id\":");
            push_json_str(&mut out, &msg.id)?;
            out.extend_from_slice(b",\"role\":");
            push_json_str(&mut out, msg.role)?;
            if let Some(ref ts) = msg.timestamp {
                out.extend_from_slice(b",\"timestamp\":");
                push_raw_timestamp(&mut out, ts)?;
            }
            if let Some(ref ts) = msg.started_at {
                out.extend_from_slice(b",\"startedAt\":");
                push_raw_timestamp(&mut out, ts)?;
            }
            if let Some(ref ts) = msg.completed_at {
                out.extend_from_slice(b",\"completedAt\":");
                push_raw_timestamp(&mut out, ts)?;
            }
            if let Some(outcome) = msg.outcome {
                out.extend_from_slice(b",\"outcome\":");
                push_json_str(&mut out, outcome)?;
            }
            out.extend_from_slice(b",\"parts\":[");
            for (part_idx, part) in msg.parts.iter().enumerate() {
                if part_idx > 0 {
                    out.push(b',');
                }
                match part {
                    BoundedPart::Text { kind, text } => {
                        out.extend_from_slice(b"{\"type\":");
                        push_json_str(&mut out, kind)?;
                        out.extend_from_slice(b",\"text\":");
                        push_json_str(&mut out, text)?;
                        out.push(b'}');
                    }
                    BoundedPart::ToolResult { name, text, is_error } => {
                        out.extend_from_slice(b"{\"type\":\"toolResult\"");
                        if let Some(ref n) = name {
                            out.extend_from_slice(b",\"name\":");
                            push_json_str(&mut out, n)?;
                        }
                        out.extend_from_slice(b",\"text\":");
                        push_json_str(&mut out, text)?;
                        out.extend_from_slice(b",\"isError\":");
                        out.extend_from_slice(if *is_error { b"true}" } else { b"false}" });
                    }
                    BoundedPart::ToolCall { id, name, args } => {
                        out.extend_from_slice(b"{\"type\":\"toolCall\"");
                        if let Some(ref i) = id {
                            out.extend_from_slice(b",\"id\":");
                            push_json_str(&mut out, i)?;
                        }
                        out.extend_from_slice(b",\"name\":");
                        push_json_str(&mut out, name)?;
                        match args {
                            Some(ToolArgs::Str(s)) => {
                                out.extend_from_slice(b",\"args\":");
                                push_json_str(&mut out, s)?;
                            }
                            Some(ToolArgs::Raw { json, .. }) => {
                                out.extend_from_slice(b",\"args\":");
                                out.extend_from_slice(json.get().as_bytes());
                            }
                            None => {}
                        }
                        out.push(b'}');
                    }
                    BoundedPart::Compaction {
                        status,
                        tokens_before,
                        tokens_after,
                        summary,
                        first_kept_entry_id,
                        custom_instructions,
                    } => {
                        out.extend_from_slice(b"{\"type\":\"compaction\",\"status\":");
                        push_json_str(&mut out, status)?;
                        if let Some(ref tb) = tokens_before {
                            out.extend_from_slice(b",\"tokensBefore\":");
                            push_raw_timestamp(&mut out, tb)?;
                        }
                        if let Some(ref ta) = tokens_after {
                            out.extend_from_slice(b",\"tokensAfter\":");
                            push_raw_timestamp(&mut out, ta)?;
                        }
                        if let Some(ref s) = summary {
                            out.extend_from_slice(b",\"summary\":");
                            push_json_str(&mut out, s)?;
                        }
                        if let Some(ref f) = first_kept_entry_id {
                            out.extend_from_slice(b",\"firstKeptEntryId\":");
                            push_json_str(&mut out, f)?;
                        }
                        if let Some(ref c) = custom_instructions {
                            out.extend_from_slice(b",\"customInstructions\":");
                            push_json_str(&mut out, c)?;
                        }
                        out.push(b'}');
                    }
                }
            }
            out.extend_from_slice(b"]}");
        }
        out.extend_from_slice(b"]}");
        Ok(out)
    }
}

fn push_json_str(out: &mut Vec<u8>, s: &str) -> Result<(), StreamFailure> {
    serde_json::to_writer(&mut *out, s).map_err(|_| StreamFailure::Fallback("serialize"))
}

fn push_raw_timestamp(out: &mut Vec<u8>, ts: &RawTimestamp) -> Result<(), StreamFailure> {
    match ts {
        RawTimestamp::Str(s) => push_json_str(out, s),
        RawTimestamp::Int(v) => serde_json::to_writer(&mut *out, v).map_err(|_| StreamFailure::Fallback("serialize")),
        RawTimestamp::Uint(v) => serde_json::to_writer(&mut *out, v).map_err(|_| StreamFailure::Fallback("serialize")),
        RawTimestamp::Float(v) => serde_json::to_writer(&mut *out, v).map_err(|_| StreamFailure::Fallback("serialize")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncates_by_utf16_units() {
        assert_eq!(bounded_string("abc", 4).unwrap(), "abc");
        assert_eq!(bounded_string("abcdef", 4).unwrap(), "cdef");
        assert_eq!(utf16_len("😀"), 2);
        assert_eq!(bounded_string("a😀bcdef", 4).unwrap(), "cdef");
        assert_eq!(
            bounded_string(&"a".repeat(30), 20).unwrap(),
            format!("a{}aa", TRUNCATION_MARKER)
        );
    }

    #[test]
    fn parses_a_basic_session_and_chunked_meta_matches() {
        let base_slot = r#"{"type":"title","title":"Slot Title","pad":""}"#;
        let pad_len = 255 - base_slot.len();
        let slot_line = format!(r#"{{"type":"title","title":"Slot Title","pad":"{}"}}"#, " ".repeat(pad_len));
        assert_eq!(slot_line.len(), 255);
        let payload = format!(
            "{slot_line}\n{}\n{}\n{}\n",
            r#"{"type":"session","id":"s1","cwd":"/p","timestamp":"2026-01-01T00:00:00.000Z"}"#,
            r#"{"type":"message","timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"user","content":"hello"}}"#,
            r#"{"type":"message","timestamp":"2026-01-01T00:00:02.000Z","message":{"role":"assistant","content":[{"type":"toolCall","name":"bash","arguments":{"huge":123}},{"type":"text","text":"world"}],"stopReason":"end"}}"#,
        );
        let bytes = payload.as_bytes();
        let single = scan_inner(
            bytes,
            "fallback".to_string(),
            "2026-01-01T00:00:00.000Z".to_string(),
            "2026-01-01T00:00:00.000Z".to_string(),
            256,
        );
        assert_eq!(single["status"], "ok");
        assert_eq!(single["accumulator"]["id"], "s1");
        assert_eq!(single["accumulator"]["displayName"], "Slot Title");
        assert_eq!(single["accumulator"]["firstUser"], "hello");
        assert_eq!(single["accumulator"]["preview"], "world");

        let mut stream = MetaStream::new(
            "fallback".to_string(),
            "2026-01-01T00:00:00.000Z".to_string(),
            "2026-01-01T00:00:00.000Z".to_string(),
            256,
        );
        for chunk in bytes.chunks(7) {
            stream.push_chunk(chunk).unwrap();
        }
        let streamed = stream.finish();
        assert_eq!(streamed, single);
    }

    #[test]
    fn preserves_duplicate_key_last_wins_and_large_text_truncation() {
        let huge_tail = format!("{}{}", "a".repeat(5_000), "XYZ");
        let line = format!(
            "{{\"type\":\"message\",\"type\":\"message\",\"message\":{{\"role\":\"assistant\",\"role\":\"user\",\"content\":[{{\"type\":\"text\",\"text\":\"first\"}},{{\"type\":\"text\",\"text\":\"{huge_tail}\"}}]}}}}\n"
        );
        let value = scan_inner(
            line.as_bytes(),
            "id".to_string(),
            "2026-01-01T00:00:00.000Z".to_string(),
            "2026-01-01T00:00:00.000Z".to_string(),
            0,
        );
        assert_eq!(value["status"], "ok");
        let expected_full = format!("first\n{huge_tail}");
        assert_eq!(
            value["accumulator"]["firstUser"].as_str().unwrap(),
            bounded_string(&expected_full, MAX_TEXT_CHARS).unwrap()
        );
    }

    #[test]
    fn transcript_builder_coalesces_tool_results_and_respects_active_leaf() {
        let lines = [
            r#"{"type":"session","id":"s1","cwd":"/p","timestamp":"2026-01-01T00:00:00.000Z"}"#,
            r#"{"type":"message","id":"m1","parentId":null,"timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"user","content":"hi"}}"#,
            r#"{"type":"message","id":"m2","parentId":"m1","timestamp":"2026-01-01T00:00:02.000Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"c1","name":"bash","arguments":{"command":"ls"}},{"type":"text","text":"done"}]}}"#,
            r#"{"type":"message","id":"t1","parentId":"m2","timestamp":"2026-01-01T00:00:03.000Z","message":{"role":"tool","toolCallId":"c1","toolName":"bash","content":"ok"}}"#,
            r#"{"type":"message","id":"m3","parentId":"m1","message":{"role":"assistant","content":"other branch"}}"#,
            r#"{"type":"model_change","id":"mc1","parentId":"m3","model":"x/y","activeLeafId":"t1"}"#,
        ];
        let payload = format!("{}\n", lines.join("\n"));
        let mut stream = TranscriptStream::new(1);
        for chunk in payload.as_bytes().chunks(13) {
            stream.push_chunk(chunk).unwrap();
        }
        let result_bytes = stream.finish().unwrap();
        let parsed: Value = serde_json::from_slice(&result_bytes).unwrap();
        assert_eq!(parsed["status"], "ok");
        let msgs = parsed["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0]["id"], "m1");
        assert_eq!(msgs[1]["id"], "m2");
        assert_eq!(msgs[1]["completedAt"], "2026-01-01T00:00:03.000Z");
        let parts = msgs[1]["parts"].as_array().unwrap();
        assert_eq!(parts[0]["type"], "toolCall");
        assert_eq!(parts[1]["type"], "toolResult");
        assert_eq!(parts[1]["text"], "ok");
        assert_eq!(parts[2]["type"], "text");
        assert_eq!(parts[2]["text"], "done");
    }

    #[test]
    fn handles_crlf_split_across_chunks_and_rewrites_in_transcript_builder() {
        let l1 = r#"{"type":"message","id":"m1","parentId":null,"message":{"role":"user","content":"u"}}"#;
        let l2 = r#"{"type":"message","id":"m2","parentId":"m1","message":{"role":"assistant","content":"a"}}"#;
        let l3 = r#"{"type":"title_change","id":"m2","parentId":"m1","title":"now non-renderable"}"#;
        let payload = format!("{l1}\r\n{l2}\r\n{l3}\r\n");
        let split_at = l1.len() + 1;
        let mut stream = TranscriptStream::new(0);
        stream.push_chunk(&payload.as_bytes()[..split_at]).unwrap();
        stream.push_chunk(&payload.as_bytes()[split_at..]).unwrap();
        let parsed: Value = serde_json::from_slice(&stream.finish().unwrap()).unwrap();
        assert_eq!(parsed["status"], "ok");
        let msgs = parsed["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0]["id"], "m1");
    }

    #[test]
    fn transcript_cleared_active_leaf_returns_empty_messages() {
        let payload = concat!(
            r#"{"type":"message","id":"m1","parentId":null,"message":{"role":"user","content":"u"}}"#, "\n",
            r#"{"type":"label","id":"l1","parentId":"m1","activeLeafId":null}"#, "\n",
        );
        let mut stream = TranscriptStream::new(0);
        stream.push_chunk(payload.as_bytes()).unwrap();
        let parsed: Value = serde_json::from_slice(&stream.finish().unwrap()).unwrap();
        assert_eq!(parsed["status"], "ok");
        assert_eq!(parsed["messages"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn rejects_trailing_json_tokens_with_fallback() {
        let payload = b"{\"type\":\"session\",\"id\":\"s1\"}{\"extra\":1}\n";
        let res = scan_inner(
            payload,
            "id".to_string(),
            "2026-01-01T00:00:00.000Z".to_string(),
            "2026-01-01T00:00:00.000Z".to_string(),
            0,
        );
        assert_eq!(res["status"], "fallback");
    }
}
