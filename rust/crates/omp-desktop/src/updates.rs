//! Update checks for the desktop app.
//!
//! This is check-and-notify only, like the Electron shell (`autoDownload=false`):
//! the app reads the release feed, verifies its minisign signature, and tells the
//! user a newer version exists. Nothing is ever downloaded or installed from here.
//!
//! The release pipeline does not publish a feed or a signing key yet, so most
//! builds have no `OMP_UPDATER_PUBKEY` baked in. Those builds report
//! [`UpdateCheckState::Unconfigured`] and [`check`] returns without opening a
//! socket, instead of failing against a feed that does not exist.

use std::time::Duration;

use cargo_packager_updater::{Update, UpdaterBuilder, semver::Version, url::Url};

/// Where the release workflow is expected to publish its feed. The `latest`
/// alias means the URL never changes across releases.
const DEFAULT_ENDPOINT: &str =
    "https://github.com/SenCha930511/omp-desktop/releases/latest/download/updates.json";

/// Minisign public key baked in at build time. `None` means this build cannot
/// verify a feed, so it must not try to read one.
const PUBKEY: Option<&str> = option_env!("OMP_UPDATER_PUBKEY");

/// The feed is one small JSON document; a check must not hold the background
/// executor for longer than this.
const CHECK_TIMEOUT: Duration = Duration::from_secs(20);

/// The version this binary was built as, compared against the feed's version.
const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Longest failure message shown in the Settings row.
const MAX_ERROR_CHARS: usize = 120;

/// What the Settings "Check for updates" row shows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpdateCheckState {
    /// No check has run in this session.
    Idle,
    /// A check is running on the background executor.
    Checking,
    /// The installed version is the newest published one.
    UpToDate,
    /// A newer release exists; `url` is the feed's download URL.
    Available { version: String, url: String },
    /// The check could not complete (network, signature, malformed feed).
    Failed(String),
    /// This build has no feed or public key, so checking is a no-op.
    Unconfigured,
}

impl UpdateCheckState {
    /// Short, single-line text for the row's value.
    pub fn label(&self) -> String {
        match self {
            Self::Idle => "not checked".to_string(),
            Self::Checking => "checking…".to_string(),
            Self::UpToDate => "up to date".to_string(),
            Self::Available { version, .. } => format!("{version} available"),
            Self::Failed(message) => format!("check failed: {message}"),
            Self::Unconfigured => "not configured".to_string(),
        }
    }
}

/// The parts of an announced release the Settings row needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateSummary {
    pub version: String,
    pub url: String,
}

impl UpdateSummary {
    fn from_update(update: &Update) -> Self {
        Self {
            version: update.version.clone(),
            url: update.download_url.to_string(),
        }
    }
}

/// Whether this build carries the feed URL and signing key needed to check.
pub fn is_configured() -> bool {
    PUBKEY.is_some_and(|key| !key.trim().is_empty())
}

/// The state a freshly opened Settings page starts in.
pub fn initial_state() -> UpdateCheckState {
    if is_configured() {
        UpdateCheckState::Idle
    } else {
        UpdateCheckState::Unconfigured
    }
}

/// Run one blocking update check.
///
/// Returns `Ok(None)` when this build is unconfigured (see [`is_configured`]) or
/// when the installed version is current; `Ok(Some(..))` when a newer release
/// was announced. Call this from a background thread — it blocks on the network.
pub fn check() -> Result<Option<UpdateSummary>, String> {
    let Some(pubkey) = PUBKEY else {
        return Ok(None);
    };
    let endpoint =
        Url::parse(DEFAULT_ENDPOINT).map_err(|error| summarize_error(&error.to_string()))?;
    let version =
        Version::parse(CURRENT_VERSION).map_err(|error| format!("invalid app version: {error}"))?;
    let updater = UpdaterBuilder::new(version, Default::default())
        .pub_key(pubkey)
        .endpoints(vec![endpoint])
        .timeout(CHECK_TIMEOUT)
        .build()
        .map_err(|error| summarize_error(&error.to_string()))?;
    let update = updater
        .check()
        .map_err(|error| summarize_error(&error.to_string()))?;
    Ok(update.as_ref().map(UpdateSummary::from_update))
}

/// Map a finished check onto the row state.
///
/// Kept pure so the unconfigured and failure paths are covered without a
/// network call. `configured` comes from [`is_configured`]; an unconfigured
/// build is never reported as "up to date" just because `check` returned
/// `Ok(None)` without contacting anything.
pub fn state_for_result(
    configured: bool,
    result: Result<Option<UpdateSummary>, String>,
) -> UpdateCheckState {
    match (configured, result) {
        (false, _) => UpdateCheckState::Unconfigured,
        (true, Ok(None)) => UpdateCheckState::UpToDate,
        (true, Ok(Some(summary))) => UpdateCheckState::Available {
            version: summary.version,
            url: summary.url,
        },
        (true, Err(message)) => UpdateCheckState::Failed(message),
    }
}

/// Feed errors (mostly `reqwest`) can span several lines and hundreds of
/// characters; the Settings row only has room for one short sentence.
fn summarize_error(message: &str) -> String {
    let line = message.lines().next().unwrap_or_default().trim();
    if line.is_empty() {
        return "unknown error".to_string();
    }
    if line.chars().count() <= MAX_ERROR_CHARS {
        return line.to_string();
    }
    let mut truncated: String = line.chars().take(MAX_ERROR_CHARS).collect();
    truncated.push('…');
    truncated
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_are_short_and_single_line() {
        assert_eq!(UpdateCheckState::Idle.label(), "not checked");
        assert_eq!(UpdateCheckState::Checking.label(), "checking…");
        assert_eq!(UpdateCheckState::UpToDate.label(), "up to date");
        assert_eq!(
            UpdateCheckState::Available {
                version: "2.1.0".to_string(),
                url: "https://example.invalid/OMP-Desktop-2.1.0.app.tar.gz".to_string(),
            }
            .label(),
            "2.1.0 available"
        );
        assert_eq!(
            UpdateCheckState::Failed("network unreachable".to_string()).label(),
            "check failed: network unreachable"
        );
        assert_eq!(UpdateCheckState::Unconfigured.label(), "not configured");
    }

    #[test]
    fn unconfigured_builds_never_contact_the_network() {
        if is_configured() {
            // A build that baked in `OMP_UPDATER_PUBKEY` has a real feed; the
            // unit suite stays offline, and `state_for_result` covers the rest.
            return;
        }
        assert_eq!(check(), Ok(None));
        assert_eq!(initial_state(), UpdateCheckState::Unconfigured);
        assert_eq!(
            state_for_result(is_configured(), check()),
            UpdateCheckState::Unconfigured
        );
    }

    #[test]
    fn configured_builds_start_idle() {
        if !is_configured() {
            return;
        }
        assert_eq!(initial_state(), UpdateCheckState::Idle);
    }

    #[test]
    fn results_map_onto_states() {
        assert_eq!(state_for_result(true, Ok(None)), UpdateCheckState::UpToDate);
        assert_eq!(
            state_for_result(
                true,
                Ok(Some(UpdateSummary {
                    version: "2.1.0".to_string(),
                    url: "https://example.invalid/app.tar.gz".to_string(),
                })),
            ),
            UpdateCheckState::Available {
                version: "2.1.0".to_string(),
                url: "https://example.invalid/app.tar.gz".to_string(),
            }
        );
        assert_eq!(
            state_for_result(true, Err("signature mismatch".to_string())),
            UpdateCheckState::Failed("signature mismatch".to_string())
        );
        // An unconfigured build reports "not configured" even if a stray
        // `Ok(None)` says otherwise.
        assert_eq!(
            state_for_result(false, Ok(None)),
            UpdateCheckState::Unconfigured
        );
    }

    #[test]
    fn errors_are_reduced_to_one_short_line() {
        assert_eq!(summarize_error(""), "unknown error");
        assert_eq!(
            summarize_error("error sending request\n\ncaused by: connection refused"),
            "error sending request"
        );
        assert_eq!(summarize_error("  trimmed  "), "trimmed");
        let long = "x".repeat(MAX_ERROR_CHARS + 50);
        let summary = summarize_error(&long);
        assert_eq!(summary.chars().count(), MAX_ERROR_CHARS + 1);
        assert!(summary.ends_with('…'));
        // Multi-byte input must not be split mid-character.
        let wide = "更".repeat(MAX_ERROR_CHARS + 10);
        let summary = summarize_error(&wide);
        assert_eq!(summary.chars().count(), MAX_ERROR_CHARS + 1);
    }
}
