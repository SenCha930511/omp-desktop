use std::time::Duration;

use gpui_kit::base::{ReduceMotionPreference, set_reduce_motion_preference};
use gpui_kit::{Animation, App, Keystroke};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum WorkspaceCommand {
    OpenPalette,
    NewSession,
    OpenProjects,
    OpenActivity,
    OpenSchedules,
    OpenCapabilities,
    OpenBrowser,
    ToggleSidebar,
    OpenSettings,
    Dismiss,
}

impl WorkspaceCommand {
    pub(super) const PALETTE: [Self; 8] = [
        Self::NewSession,
        Self::OpenProjects,
        Self::OpenActivity,
        Self::OpenSchedules,
        Self::OpenCapabilities,
        Self::OpenBrowser,
        Self::ToggleSidebar,
        Self::OpenSettings,
    ];

    pub(super) fn from_keystroke(keystroke: &Keystroke) -> Option<Self> {
        let modifiers = keystroke.modifiers;
        if modifiers.alt || modifiers.function {
            return None;
        }
        let key = keystroke.key.to_lowercase();
        if key == "escape" && !modifiers.modified() {
            return Some(Self::Dismiss);
        }
        let primary = modifiers.control || modifiers.platform;
        if !primary {
            return None;
        }
        match (key.as_str(), modifiers.shift) {
            ("k", false) => Some(Self::OpenPalette),
            ("n", false) => Some(Self::NewSession),
            ("b", true) => Some(Self::OpenBrowser),
            ("b", false) => Some(Self::ToggleSidebar),
            (",", false) => Some(Self::OpenSettings),
            _ => None,
        }
    }

    pub(super) fn id(self) -> &'static str {
        match self {
            Self::NewSession => "new-session",
            Self::OpenProjects => "projects",
            Self::OpenActivity => "activity",
            Self::OpenSchedules => "schedules",
            Self::OpenCapabilities => "capabilities",
            Self::OpenBrowser => "browser",
            Self::ToggleSidebar => "sidebar",
            Self::OpenSettings => "settings",
            Self::OpenPalette | Self::Dismiss => unreachable!("not a palette command"),
        }
    }

    pub(super) fn label_key(self) -> &'static str {
        match self {
            Self::NewSession => "sidebar.newSession",
            Self::OpenProjects => "sidebar.projects",
            Self::OpenActivity => "sidebar.activity",
            Self::OpenSchedules => "sidebar.schedules",
            Self::OpenCapabilities => "sidebar.capabilities",
            Self::OpenBrowser => "rightPane.browser",
            Self::ToggleSidebar => "commandPalette.toggleSidebar",
            Self::OpenSettings => "sidebar.settings",
            Self::OpenPalette | Self::Dismiss => unreachable!("not a palette command"),
        }
    }
}

pub(super) fn cyclic_index(active: usize, count: usize, forward: bool) -> Option<usize> {
    if count == 0 {
        return None;
    }
    let active = active.min(count - 1);
    Some(if forward {
        (active + 1) % count
    } else {
        (active + count - 1) % count
    })
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum Motion {
    UserEnter,
    AssistantEnter,
    Disclosure,
    Timeline,
    JumpLatest,
    RightPane,
    DetailsOverlay,
    OverviewPopover,
    SessionMenu,
    ModalBackdrop,
    ModalCard,
    Attachment,
    ProjectPulse,
    TodoPulse,
    StreamPulse,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum Easing {
    Linear,
    EaseOut,
    Overshoot,
    Expand,
    EaseInOut,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum Playback {
    Once,
    RepeatSynced,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct MotionSpec {
    duration: Duration,
    easing: Easing,
    playback: Playback,
}

pub(super) fn motion_spec(motion: Motion) -> MotionSpec {
    let (milliseconds, easing, playback) = match motion {
        Motion::UserEnter => (400, Easing::Overshoot, Playback::Once),
        Motion::AssistantEnter => (450, Easing::Overshoot, Playback::Once),
        Motion::Disclosure => (200, Easing::Expand, Playback::Once),
        Motion::Timeline => (200, Easing::EaseOut, Playback::Once),
        Motion::JumpLatest => (130, Easing::EaseOut, Playback::Once),
        Motion::RightPane => (150, Easing::EaseOut, Playback::Once),
        Motion::DetailsOverlay => (160, Easing::EaseOut, Playback::Once),
        Motion::OverviewPopover => (140, Easing::EaseOut, Playback::Once),
        Motion::SessionMenu => (140, Easing::EaseOut, Playback::Once),
        Motion::ModalBackdrop => (130, Easing::EaseOut, Playback::Once),
        Motion::ModalCard => (150, Easing::EaseOut, Playback::Once),
        Motion::Attachment => (220, Easing::Overshoot, Playback::Once),
        Motion::ProjectPulse => (2_400, Easing::EaseInOut, Playback::RepeatSynced),
        Motion::TodoPulse => (2_400, Easing::EaseInOut, Playback::RepeatSynced),
        Motion::StreamPulse => (2_200, Easing::Linear, Playback::RepeatSynced),
    };
    MotionSpec {
        duration: Duration::from_millis(milliseconds),
        easing,
        playback,
    }
}

impl MotionSpec {
    pub(super) fn animation(self) -> Animation {
        let animation =
            Animation::new(self.duration).with_easing(move |delta| self.easing.evaluate(delta));
        match self.playback {
            Playback::Once => animation,
            Playback::RepeatSynced => animation.repeat_synced(),
        }
    }
}

impl Easing {
    fn evaluate(self, delta: f32) -> f32 {
        match self {
            Self::Linear => gpui_kit::linear(delta),
            Self::EaseOut => cubic_bezier(delta, 0.165, 0.84, 0.44, 1.0),
            Self::Overshoot => cubic_bezier(delta, 0.34, 1.3, 0.64, 1.0),
            Self::Expand => cubic_bezier(delta, 0.19, 1.0, 0.22, 1.0),
            Self::EaseInOut => gpui_kit::ease_in_out(delta),
        }
    }
}

fn cubic_bezier(delta: f32, x1: f32, y1: f32, x2: f32, y2: f32) -> f32 {
    if delta <= 0.0 {
        return 0.0;
    }
    if delta >= 1.0 {
        return 1.0;
    }

    let sample = |t: f32, a: f32, b: f32| {
        let inverse = 1.0 - t;
        3.0 * inverse * inverse * t * a + 3.0 * inverse * t * t * b + t * t * t
    };
    let derivative = |t: f32| {
        let inverse = 1.0 - t;
        3.0 * inverse * inverse * x1 + 6.0 * inverse * t * (x2 - x1) + 3.0 * t * t * (1.0 - x2)
    };

    let mut lower = 0.0;
    let mut upper = 1.0;
    let mut t = delta;
    for _ in 0..8 {
        let error = sample(t, x1, x2) - delta;
        if error.abs() <= 0.000_001 {
            return sample(t, y1, y2);
        }
        if error > 0.0 {
            upper = t;
        } else {
            lower = t;
        }
        let slope = derivative(t);
        let next = t - error / slope;
        t = if slope.abs() > 0.000_001 && next > lower && next < upper {
            next
        } else {
            (lower + upper) * 0.5
        };
    }
    for _ in 0..16 {
        t = (lower + upper) * 0.5;
        let error = sample(t, x1, x2) - delta;
        if error.abs() <= 0.000_000_1 {
            break;
        }
        if error > 0.0 {
            upper = t;
        } else {
            lower = t;
        }
    }
    sample(t, y1, y2)
}

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
    use std::time::Duration;

    use super::{
        Easing, Motion, Playback, StreamFeedback, WorkspaceCommand, cyclic_index, motion_spec,
    };

    fn assert_close(actual: f32, expected: f32) {
        assert!(
            (actual - expected).abs() <= 0.000_01,
            "expected {expected}, got {actual}"
        );
    }

    #[test]
    fn workspace_shortcuts_match_only_owned_combinations() {
        let cases = [
            ("cmd-k", WorkspaceCommand::OpenPalette),
            ("ctrl-k", WorkspaceCommand::OpenPalette),
            ("cmd-n", WorkspaceCommand::NewSession),
            ("ctrl-shift-b", WorkspaceCommand::OpenBrowser),
            ("cmd-b", WorkspaceCommand::ToggleSidebar),
            ("cmd-,", WorkspaceCommand::OpenSettings),
            ("escape", WorkspaceCommand::Dismiss),
        ];
        for (key, expected) in cases {
            let key = gpui_kit::Keystroke::parse(key).expect("valid keystroke");
            assert_eq!(WorkspaceCommand::from_keystroke(&key), Some(expected));
        }
        for key in ["k", "n", "b", "ctrl-p", "cmd-p", "alt-cmd-k"] {
            let key = gpui_kit::Keystroke::parse(key).expect("valid keystroke");
            assert_eq!(WorkspaceCommand::from_keystroke(&key), None);
        }
    }

    #[test]
    fn palette_indices_wrap_and_clamp_without_an_empty_panic() {
        assert_eq!(cyclic_index(0, 8, false), Some(7));
        assert_eq!(cyclic_index(7, 8, true), Some(0));
        assert_eq!(cyclic_index(99, 2, true), Some(0));
        assert_eq!(cyclic_index(0, 0, true), None);
    }

    #[test]
    fn motion_specs_match_published_tokens() {
        let cases = [
            (Motion::UserEnter, 400, Easing::Overshoot, Playback::Once),
            (
                Motion::AssistantEnter,
                450,
                Easing::Overshoot,
                Playback::Once,
            ),
            (Motion::Disclosure, 200, Easing::Expand, Playback::Once),
            (Motion::Timeline, 200, Easing::EaseOut, Playback::Once),
            (Motion::JumpLatest, 130, Easing::EaseOut, Playback::Once),
            (Motion::RightPane, 150, Easing::EaseOut, Playback::Once),
            (Motion::DetailsOverlay, 160, Easing::EaseOut, Playback::Once),
            (
                Motion::OverviewPopover,
                140,
                Easing::EaseOut,
                Playback::Once,
            ),
            (Motion::SessionMenu, 140, Easing::EaseOut, Playback::Once),
            (Motion::ModalBackdrop, 130, Easing::EaseOut, Playback::Once),
            (Motion::ModalCard, 150, Easing::EaseOut, Playback::Once),
            (Motion::Attachment, 220, Easing::Overshoot, Playback::Once),
            (
                Motion::ProjectPulse,
                2_400,
                Easing::EaseInOut,
                Playback::RepeatSynced,
            ),
            (
                Motion::TodoPulse,
                2_400,
                Easing::EaseInOut,
                Playback::RepeatSynced,
            ),
            (
                Motion::StreamPulse,
                2_200,
                Easing::Linear,
                Playback::RepeatSynced,
            ),
        ];

        for (motion, milliseconds, easing, playback) in cases {
            let spec = motion_spec(motion);
            assert_eq!(spec.duration, Duration::from_millis(milliseconds));
            assert_eq!(spec.easing, easing);
            assert_eq!(spec.playback, playback);

            let animation = spec.animation();
            assert_eq!(animation.duration, spec.duration);
            assert_eq!(animation.oneshot, playback == Playback::Once);
            assert_eq!(animation.synced, playback == Playback::RepeatSynced);
            assert_close((animation.easing)(0.37), easing.evaluate(0.37));
        }
    }

    #[test]
    fn role_specific_motion_tokens_remain_distinct() {
        assert_eq!(motion_spec(Motion::UserEnter).duration.as_millis(), 400);
        assert_eq!(
            motion_spec(Motion::AssistantEnter).duration.as_millis(),
            450
        );
        assert_eq!(motion_spec(Motion::ProjectPulse).easing, Easing::EaseInOut);
        assert_eq!(motion_spec(Motion::TodoPulse).easing, Easing::EaseInOut);
        assert_eq!(motion_spec(Motion::StreamPulse).easing, Easing::Linear);
    }

    #[test]
    fn every_easing_has_exact_endpoints() {
        for easing in [
            Easing::Linear,
            Easing::EaseOut,
            Easing::Overshoot,
            Easing::Expand,
            Easing::EaseInOut,
        ] {
            assert_eq!(easing.evaluate(0.0), 0.0);
            assert_eq!(easing.evaluate(1.0), 1.0);
        }
    }

    #[test]
    fn css_cubic_bezier_matches_reference_values() {
        assert_close(Easing::EaseOut.evaluate(0.25), 0.698_242_9);
        assert_close(Easing::EaseOut.evaluate(0.5), 0.914_569_2);
        assert_close(Easing::EaseOut.evaluate(0.75), 0.985_256_55);
        assert_close(Easing::Overshoot.evaluate(0.25), 0.706_462_5);
        assert_close(Easing::Overshoot.evaluate(0.5), 0.991_423);
        assert_close(Easing::Overshoot.evaluate(0.75), 1.025_552_4);
        assert_close(Easing::Expand.evaluate(0.25), 0.843_514_3);
        assert_close(Easing::Expand.evaluate(0.5), 0.977_824_6);
        assert_close(Easing::Expand.evaluate(0.75), 0.998_271_35);
    }

    #[test]
    fn overshoot_is_not_clamped() {
        let value = Easing::Overshoot.evaluate(0.75);
        assert!(value > 1.0);
        assert_close(value, 1.025_552_4);
    }

    #[test]
    fn cubic_bezier_is_total_outside_the_unit_interval() {
        for easing in [Easing::EaseOut, Easing::Overshoot, Easing::Expand] {
            assert_eq!(easing.evaluate(-0.5), 0.0);
            assert_eq!(easing.evaluate(1.5), 1.0);
        }
    }

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
