use std::time::{Duration, Instant};

pub const IME_POST_COMPOSITION_GUARD_MS: u64 = 50;

#[derive(Debug, Default)]
pub struct CompositionGuard {
    composing: bool,
    composition_ended_at: Option<Instant>,
}

impl CompositionGuard {
    pub fn composition_started(&mut self) {
        self.composing = true;
        self.composition_ended_at = None;
    }

    pub fn composition_ended(&mut self, now: Instant) {
        self.composing = false;
        self.composition_ended_at = Some(now);
    }

    pub fn is_composing(&self) -> bool {
        self.composing
    }

    /// Enter and Escape must not reach the send/close paths while an IME
    /// composition is active or within the 50ms settle window after it ends.
    pub fn blocks_commit_key(&self, now: Instant) -> bool {
        if self.composing {
            return true;
        }
        match self.composition_ended_at {
            Some(ended) => {
                now.saturating_duration_since(ended)
                    < Duration::from_millis(IME_POST_COMPOSITION_GUARD_MS)
            }
            None => false,
        }
    }
}

/// Converts a UTF-8 byte offset into a UTF-16 code-unit offset for the
/// `predict_word` RPC cursor. Byte offsets inside a code point clamp to its
/// start so the conversion is always total.
pub fn utf8_byte_to_utf16_offset(text: &str, byte_index: usize) -> usize {
    let clamped = byte_index.min(text.len());
    let mut boundary = clamped;
    while boundary > 0 && !text.is_char_boundary(boundary) {
        boundary -= 1;
    }
    text[..boundary].encode_utf16().count()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_enter_through_the_post_composition_window() {
        let mut guard = CompositionGuard::default();
        let start = Instant::now();
        guard.composition_started();
        assert!(guard.blocks_commit_key(start));
        guard.composition_ended(start);
        assert!(guard.blocks_commit_key(start + Duration::from_millis(49)));
        assert!(!guard.blocks_commit_key(start + Duration::from_millis(50)));
    }

    #[test]
    fn converts_utf8_bytes_to_utf16_code_units() {
        assert_eq!(utf8_byte_to_utf16_offset("hello", 5), 5);
        assert_eq!(utf8_byte_to_utf16_offset("你好", 3), 1);
        assert_eq!(utf8_byte_to_utf16_offset("你好", 6), 2);
        assert_eq!(utf8_byte_to_utf16_offset("a😀b", 1), 1);
        assert_eq!(utf8_byte_to_utf16_offset("a😀b", 5), 3);
        assert_eq!(utf8_byte_to_utf16_offset("a😀b", 2), 1);
        assert_eq!(utf8_byte_to_utf16_offset("a😀b", 99), 4);
    }
}
