use gpui_kit::App;
use gpui_kit::base::{ReduceMotionPreference, set_reduce_motion_preference};

pub(super) fn apply_reduce_motion(reduce: bool, cx: &mut App) {
    let preference = if reduce {
        ReduceMotionPreference::Reduce
    } else {
        ReduceMotionPreference::System
    };
    set_reduce_motion_preference(preference, cx);
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum StreamFeedback {
    Idle,
    AwaitingFirstDelta,
    Receiving,
}

impl StreamFeedback {
    pub(super) fn derive(running: bool, has_streaming_row: bool) -> Self {
        match (running, has_streaming_row) {
            (false, _) => Self::Idle,
            (true, false) => Self::AwaitingFirstDelta,
            (true, true) => Self::Receiving,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::StreamFeedback;

    #[test]
    fn stream_feedback_follows_the_turn_not_a_late_row_cursor() {
        assert_eq!(StreamFeedback::derive(false, false), StreamFeedback::Idle);
        assert_eq!(StreamFeedback::derive(false, true), StreamFeedback::Idle);
        assert_eq!(
            StreamFeedback::derive(true, false),
            StreamFeedback::AwaitingFirstDelta
        );
        assert_eq!(
            StreamFeedback::derive(true, true),
            StreamFeedback::Receiving
        );
    }
}
