use std::collections::BTreeSet;

use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::Value;
use uuid::Uuid;

use crate::error::{CoreError, Result};
use crate::schedules;
use crate::state::{AutomationScheduleRecord, ScheduleRunRecord, StateStore};

const MAX_SCHEDULE_RUNS: usize = 50;
const MAX_RUN_ERROR_CHARS: usize = 4_000;
const RUN_STATUSES: [&str; 7] = [
    "queued",
    "running",
    "succeeded",
    "failed",
    "skipped",
    "interrupted",
    "cancelled",
];

/// The result of one execution attempt handed back by a [`ScheduleExecutor`].
#[derive(Debug, Clone)]
pub struct ScheduleRunOutcome {
    pub status: String,
    pub session_id: Option<String>,
    pub error: Option<String>,
}

/// Runs a single scheduled task. The app supplies the implementation that
/// owns the agent manager; the core only decides when a task is due.
pub trait ScheduleExecutor {
    fn execute(&self, schedule: &AutomationScheduleRecord) -> Result<ScheduleRunOutcome>;
}

fn iso(now: DateTime<Utc>) -> String {
    now.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn parse_utc(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|date| date.with_timezone(&Utc))
}

/// Active schedules whose `nextRunAt` is at or before `now`, earliest first.
pub fn due(store: &StateStore, now: DateTime<Utc>) -> Vec<AutomationScheduleRecord> {
    let mut pending: Vec<(DateTime<Utc>, AutomationScheduleRecord)> = Vec::new();
    let mut seen = BTreeSet::new();
    for schedule in &store.state().schedules {
        if schedule.status != "active" || !seen.insert(schedule.id.clone()) {
            continue;
        }
        let Some(next_run_at) = schedule.next_run_at.as_deref().and_then(parse_utc) else {
            continue;
        };
        if next_run_at <= now {
            pending.push((next_run_at, schedule.clone()));
        }
    }
    pending.sort_by(|left, right| {
        left.0
            .cmp(&right.0)
            .then_with(|| left.1.id.cmp(&right.1.id))
    });
    pending.into_iter().map(|(_, schedule)| schedule).collect()
}

/// Appends a run for `schedule_id`, advances `nextRunAt` (or completes the
/// schedule), bumps the revision and returns the updated schedule.
///
/// Runs are retained newest-last and capped at 50 runs. A run
/// status outside the persisted run statuses is recorded as `failed` so the
/// run survives a state round-trip.
pub fn record(
    store: &mut StateStore,
    schedule_id: &str,
    scheduled_for: &str,
    outcome: &ScheduleRunOutcome,
    now: DateTime<Utc>,
) -> Result<Value> {
    let timestamp = iso(now);
    let scheduled_for = match parse_utc(scheduled_for) {
        Some(_) => scheduled_for.to_string(),
        None => timestamp.clone(),
    };
    let current = store
        .state()
        .schedules
        .iter()
        .find(|schedule| schedule.id == schedule_id)
        .cloned()
        .ok_or_else(|| CoreError::invalid("Unknown schedule id"))?;
    let mut status = outcome.status.trim().to_string();
    let mut error = outcome.error.clone();
    if !RUN_STATUSES.contains(&status.as_str()) {
        error.get_or_insert_with(|| {
            format!("Executor returned an unsupported run status: {status}")
        });
        status = "failed".to_string();
    }
    let mut runs = current.runs.clone();
    runs.push(ScheduleRunRecord {
        id: Uuid::new_v4().to_string(),
        task_id: current.id.clone(),
        task_revision: current.revision,
        trigger: "scheduled".to_string(),
        scheduled_for,
        queued_at: timestamp.clone(),
        started_at: Some(timestamp.clone()),
        finished_at: Some(timestamp.clone()),
        status,
        execution: current.execution.clone(),
        session_id: outcome.session_id.clone(),
        session_file: None,
        error: error.map(|error| error.chars().take(MAX_RUN_ERROR_CHARS).collect()),
        skipped_count: None,
        unknown: Default::default(),
    });
    if runs.len() > MAX_SCHEDULE_RUNS {
        runs.drain(..runs.len() - MAX_SCHEDULE_RUNS);
    }
    let mut next = current.clone();
    next.runs = runs;
    next.revision = current.revision + 1;
    next.updated_at = timestamp;
    if current.status == "active" {
        next.next_run_at = match current.timing.kind.as_str() {
            // A timing that can no longer produce an occurrence (a spent
            // `once` time, an exhausted `COUNT`, or an unparseable rule) ends
            // the schedule instead of leaving it due forever.
            "rrule" => serde_json::to_value(&current.timing)
                .ok()
                .and_then(|timing| {
                    schedules::next_occurrence_after(&timing, now)
                        .ok()
                        .flatten()
                }),
            _ => None,
        };
        if next.next_run_at.is_none() {
            next.status = "completed".to_string();
        }
    }
    store.update(|state| {
        let schedule = state
            .schedules
            .iter_mut()
            .find(|schedule| schedule.id == schedule_id)
            .ok_or_else(|| CoreError::invalid("Unknown schedule id"))?;
        *schedule = next;
        serde_json::to_value(&*schedule).map_err(|error| CoreError::new("Error", error.to_string()))
    })
}

/// Executes up to `max_concurrent` due schedules and returns the updated
/// schedule records.
///
/// Each due schedule is executed at most once per tick. An executor error is
/// recorded as a failed run instead of aborting the remaining work.
pub fn tick(
    store: &mut StateStore,
    now: DateTime<Utc>,
    executor: &dyn ScheduleExecutor,
    max_concurrent: usize,
) -> Result<Vec<Value>> {
    let mut updated = Vec::new();
    for schedule in due(store, now).into_iter().take(max_concurrent) {
        let scheduled_for = schedule.next_run_at.clone().unwrap_or_else(|| iso(now));
        let outcome = match executor.execute(&schedule) {
            Ok(outcome) => outcome,
            Err(error) => ScheduleRunOutcome {
                status: "failed".to_string(),
                session_id: None,
                error: Some(error.to_string()),
            },
        };
        updated.push(record(store, &schedule.id, &scheduled_for, &outcome, now)?);
    }
    Ok(updated)
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use tempfile::TempDir;

    use super::*;
    use crate::state::{
        CURRENT_DESKTOP_STATE_FILENAME, Platform, ScheduleExecution, ScheduleTarget, ScheduleTiming,
    };

    fn at(value: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(value)
            .expect("timestamp")
            .with_timezone(&Utc)
    }

    fn execution() -> ScheduleExecution {
        ScheduleExecution {
            model: "gpt-5.6-sol".to_string(),
            thinking: "high".to_string(),
            speed: "normal".to_string(),
            unknown: Default::default(),
        }
    }

    fn once_timing(at: &str) -> ScheduleTiming {
        ScheduleTiming {
            kind: "once".to_string(),
            at: Some(at.to_string()),
            dtstart_local: None,
            time_zone: None,
            rrule: None,
            unknown: Default::default(),
        }
    }

    fn daily_timing(rrule: &str) -> ScheduleTiming {
        ScheduleTiming {
            kind: "rrule".to_string(),
            at: None,
            dtstart_local: Some("2030-01-01T09:00:00".to_string()),
            time_zone: Some("Asia/Taipei".to_string()),
            rrule: Some(rrule.to_string()),
            unknown: Default::default(),
        }
    }

    fn schedule(
        id: &str,
        timing: ScheduleTiming,
        next_run_at: Option<&str>,
    ) -> AutomationScheduleRecord {
        AutomationScheduleRecord {
            schema_version: 1,
            id: id.to_string(),
            harness: "omp".to_string(),
            revision: 1,
            title: "Nightly review".to_string(),
            prompt: "Review the repository".to_string(),
            target: ScheduleTarget {
                kind: "project".to_string(),
                project_id: "project-1".to_string(),
                session_id: None,
                unknown: Default::default(),
            },
            timing,
            execution: execution(),
            status: "active".to_string(),
            created_by: "user".to_string(),
            created_at: "2029-12-31T00:00:00.000Z".to_string(),
            updated_at: "2029-12-31T00:00:00.000Z".to_string(),
            next_run_at: next_run_at.map(str::to_string),
            blocked_reason: None,
            runs: Vec::new(),
            unknown: Default::default(),
        }
    }

    fn stored_run(index: usize) -> ScheduleRunRecord {
        ScheduleRunRecord {
            id: format!("run-{index}"),
            task_id: "once-1".to_string(),
            task_revision: 1,
            trigger: "scheduled".to_string(),
            scheduled_for: "2029-12-31T00:00:00.000Z".to_string(),
            queued_at: "2029-12-31T00:00:00.000Z".to_string(),
            started_at: Some("2029-12-31T00:00:00.000Z".to_string()),
            finished_at: Some("2029-12-31T00:00:01.000Z".to_string()),
            status: "succeeded".to_string(),
            execution: execution(),
            session_id: None,
            session_file: None,
            error: None,
            skipped_count: None,
            unknown: Default::default(),
        }
    }

    fn store_with(schedules: Vec<AutomationScheduleRecord>) -> (TempDir, StateStore) {
        let temp = TempDir::new().expect("temp");
        let mut store = StateStore::open(
            temp.path().join(CURRENT_DESKTOP_STATE_FILENAME),
            None,
            Platform::Linux,
        )
        .expect("store");
        store
            .update(|state| {
                state.schedules = schedules;
                Ok(())
            })
            .expect("seed");
        (temp, store)
    }

    fn schedule_by_id(store: &StateStore, id: &str) -> AutomationScheduleRecord {
        store
            .state()
            .schedules
            .iter()
            .find(|schedule| schedule.id == id)
            .cloned()
            .expect("schedule")
    }

    struct FakeExecutor {
        calls: RefCell<Vec<String>>,
        outcomes: RefCell<Vec<Result<ScheduleRunOutcome>>>,
    }

    impl FakeExecutor {
        fn new(outcomes: Vec<Result<ScheduleRunOutcome>>) -> Self {
            Self {
                calls: RefCell::new(Vec::new()),
                outcomes: RefCell::new(outcomes),
            }
        }

        fn succeeding() -> Self {
            Self::new(Vec::new())
        }

        fn calls(&self) -> Vec<String> {
            self.calls.borrow().clone()
        }
    }

    impl ScheduleExecutor for FakeExecutor {
        fn execute(&self, schedule: &AutomationScheduleRecord) -> Result<ScheduleRunOutcome> {
            self.calls.borrow_mut().push(schedule.id.clone());
            let mut outcomes = self.outcomes.borrow_mut();
            if outcomes.is_empty() {
                Ok(ScheduleRunOutcome {
                    status: "succeeded".to_string(),
                    session_id: Some(format!("session-{}", schedule.id)),
                    error: None,
                })
            } else {
                outcomes.remove(0)
            }
        }
    }

    #[test]
    fn executes_a_due_once_schedule_and_marks_it_completed() {
        let now = at("2030-01-01T00:00:05.000Z");
        let due_at = "2030-01-01T00:00:00.000Z";
        let (temp, mut store) =
            store_with(vec![schedule("once-1", once_timing(due_at), Some(due_at))]);
        let executor = FakeExecutor::succeeding();
        let updated = tick(&mut store, now, &executor, 2).expect("tick");
        assert_eq!(updated.len(), 1);
        assert_eq!(updated[0]["id"], "once-1");
        assert_eq!(executor.calls(), vec!["once-1".to_string()]);
        let schedule = schedule_by_id(&store, "once-1");
        assert_eq!(schedule.status, "completed");
        assert!(schedule.next_run_at.is_none());
        assert_eq!(schedule.revision, 2);
        assert_eq!(schedule.updated_at, "2030-01-01T00:00:05.000Z");
        assert_eq!(schedule.runs.len(), 1);
        let run = &schedule.runs[0];
        assert_eq!(run.task_id, "once-1");
        assert_eq!(run.task_revision, 1);
        assert_eq!(run.trigger, "scheduled");
        assert_eq!(run.scheduled_for, due_at);
        assert_eq!(run.queued_at, "2030-01-01T00:00:05.000Z");
        assert_eq!(run.started_at.as_deref(), Some("2030-01-01T00:00:05.000Z"));
        assert_eq!(run.finished_at.as_deref(), Some("2030-01-01T00:00:05.000Z"));
        assert_eq!(run.status, "succeeded");
        assert_eq!(run.session_id.as_deref(), Some("session-once-1"));
        assert_eq!(run.execution.model, "gpt-5.6-sol");
        assert!(run.error.is_none());
        drop(store);
        let reopened = StateStore::open(
            temp.path().join(CURRENT_DESKTOP_STATE_FILENAME),
            None,
            Platform::Linux,
        )
        .expect("reopen");
        let persisted = schedule_by_id(&reopened, "once-1");
        assert_eq!(persisted.status, "completed");
        assert_eq!(persisted.runs.len(), 1);
        assert_eq!(persisted.runs[0].status, "succeeded");
        assert_eq!(persisted.runs[0].scheduled_for, due_at);
    }

    #[test]
    fn executes_a_due_rrule_schedule_and_advances_past_now() {
        let now = at("2030-01-01T01:00:05.000Z");
        let due_at = "2030-01-01T09:00:00.000+08:00";
        let (_temp, mut store) = store_with(vec![schedule(
            "daily-1",
            daily_timing("FREQ=DAILY"),
            Some(due_at),
        )]);
        let executor = FakeExecutor::succeeding();
        let updated = tick(&mut store, now, &executor, 2).expect("tick");
        assert_eq!(updated.len(), 1);
        assert_eq!(updated[0]["nextRunAt"], "2030-01-02T09:00:00.000+08:00");
        let schedule = schedule_by_id(&store, "daily-1");
        assert_eq!(schedule.status, "active");
        assert_eq!(
            schedule.next_run_at.as_deref(),
            Some("2030-01-02T09:00:00.000+08:00")
        );
        assert_eq!(schedule.revision, 2);
        assert_eq!(schedule.runs[0].scheduled_for, due_at);
    }

    #[test]
    fn advances_to_an_occurrence_strictly_after_now() {
        let now = at("2030-01-01T01:00:00.000Z");
        let due_at = "2030-01-01T09:00:00.000+08:00";
        let (_temp, mut store) = store_with(vec![schedule(
            "daily-1",
            daily_timing("FREQ=DAILY"),
            Some(due_at),
        )]);
        tick(&mut store, now, &FakeExecutor::succeeding(), 2).expect("tick");
        let schedule = schedule_by_id(&store, "daily-1");
        assert_eq!(
            schedule.next_run_at.as_deref(),
            Some("2030-01-02T09:00:00.000+08:00")
        );
    }

    #[test]
    fn marks_an_exhausted_rrule_completed() {
        let now = at("2030-01-01T01:00:05.000Z");
        let due_at = "2030-01-01T09:00:00.000+08:00";
        let (_temp, mut store) = store_with(vec![schedule(
            "daily-1",
            daily_timing("FREQ=DAILY;COUNT=1"),
            Some(due_at),
        )]);
        tick(&mut store, now, &FakeExecutor::succeeding(), 2).expect("tick");
        let schedule = schedule_by_id(&store, "daily-1");
        assert_eq!(schedule.status, "completed");
        assert!(schedule.next_run_at.is_none());
        assert_eq!(schedule.runs.len(), 1);
    }

    #[test]
    fn skips_schedules_that_are_not_due() {
        let now = at("2030-01-01T00:00:05.000Z");
        let (_temp, mut store) = store_with(vec![schedule(
            "future-1",
            once_timing("2030-01-01T01:00:00.000Z"),
            Some("2030-01-01T01:00:00.000Z"),
        )]);
        let executor = FakeExecutor::succeeding();
        let updated = tick(&mut store, now, &executor, 2).expect("tick");
        assert!(updated.is_empty());
        assert!(executor.calls().is_empty());
        let schedule = schedule_by_id(&store, "future-1");
        assert_eq!(schedule.revision, 1);
        assert!(schedule.runs.is_empty());
        assert_eq!(schedule.status, "active");
    }

    #[test]
    fn skips_paused_completed_and_blocked_schedules() {
        let now = at("2030-01-01T00:00:05.000Z");
        let due_at = "2030-01-01T00:00:00.000Z";
        let mut schedules = Vec::new();
        for (id, status) in [
            ("paused-1", "paused"),
            ("completed-1", "completed"),
            ("blocked-1", "blocked"),
        ] {
            let mut schedule = schedule(id, once_timing(due_at), Some(due_at));
            schedule.status = status.to_string();
            schedules.push(schedule);
        }
        let (_temp, mut store) = store_with(schedules);
        let executor = FakeExecutor::succeeding();
        let updated = tick(&mut store, now, &executor, 4).expect("tick");
        assert!(updated.is_empty());
        assert!(executor.calls().is_empty());
        for id in ["paused-1", "completed-1", "blocked-1"] {
            let schedule = schedule_by_id(&store, id);
            assert_eq!(schedule.revision, 1);
            assert!(schedule.runs.is_empty());
        }
    }

    #[test]
    fn records_a_failed_run_when_the_executor_fails() {
        let now = at("2030-01-01T00:00:05.000Z");
        let due_at = "2030-01-01T00:00:00.000Z";
        let (_temp, mut store) =
            store_with(vec![schedule("once-1", once_timing(due_at), Some(due_at))]);
        let executor = FakeExecutor::new(vec![Err(CoreError::new(
            "Error",
            "agent manager unavailable",
        ))]);
        let updated = tick(&mut store, now, &executor, 2).expect("tick");
        assert_eq!(updated.len(), 1);
        let schedule = schedule_by_id(&store, "once-1");
        assert_eq!(schedule.status, "completed");
        assert_eq!(schedule.runs.len(), 1);
        let run = &schedule.runs[0];
        assert_eq!(run.status, "failed");
        assert_eq!(run.error.as_deref(), Some("agent manager unavailable"));
        assert!(run.session_id.is_none());
        assert_eq!(run.finished_at.as_deref(), Some("2030-01-01T00:00:05.000Z"));
    }

    #[test]
    fn caps_retained_runs_at_fifty() {
        let now = at("2030-01-01T00:00:05.000Z");
        let due_at = "2030-01-01T00:00:00.000Z";
        let mut schedule = schedule("once-1", once_timing(due_at), Some(due_at));
        schedule.runs = (0..50).map(stored_run).collect();
        let (_temp, mut store) = store_with(vec![schedule]);
        tick(&mut store, now, &FakeExecutor::succeeding(), 2).expect("tick");
        let schedule = schedule_by_id(&store, "once-1");
        assert_eq!(schedule.runs.len(), 50);
        assert_eq!(schedule.runs[0].id, "run-1");
        assert_eq!(schedule.runs[49].trigger, "scheduled");
        assert_eq!(schedule.runs[49].status, "succeeded");
    }

    #[test]
    fn caps_executions_at_max_concurrent() {
        let now = at("2030-01-01T00:00:05.000Z");
        let (_temp, mut store) = store_with(vec![
            schedule(
                "later-1",
                once_timing("2030-01-01T00:00:04.000Z"),
                Some("2030-01-01T00:00:04.000Z"),
            ),
            schedule(
                "earlier-1",
                once_timing("2030-01-01T00:00:01.000Z"),
                Some("2030-01-01T00:00:01.000Z"),
            ),
        ]);
        let executor = FakeExecutor::succeeding();
        let updated = tick(&mut store, now, &executor, 1).expect("tick");
        assert_eq!(updated.len(), 1);
        assert_eq!(executor.calls(), vec!["earlier-1".to_string()]);
        assert_eq!(schedule_by_id(&store, "later-1").revision, 1);
        let executor = FakeExecutor::succeeding();
        let updated = tick(&mut store, now, &executor, 0).expect("tick");
        assert!(updated.is_empty());
        assert!(executor.calls().is_empty());
    }

    #[test]
    fn due_returns_active_schedules_ordered_by_next_run() {
        let now = at("2030-01-01T00:00:05.000Z");
        let mut paused = schedule(
            "paused-1",
            once_timing("2030-01-01T00:00:02.000Z"),
            Some("2030-01-01T00:00:02.000Z"),
        );
        paused.status = "paused".to_string();
        let (_temp, store) = store_with(vec![
            schedule(
                "later-1",
                once_timing("2030-01-01T00:00:04.000Z"),
                Some("2030-01-01T00:00:04.000Z"),
            ),
            paused,
            schedule(
                "earlier-1",
                once_timing("2030-01-01T00:00:01.000Z"),
                Some("2030-01-01T00:00:01.000Z"),
            ),
            schedule(
                "future-1",
                once_timing("2030-01-01T01:00:00.000Z"),
                Some("2030-01-01T01:00:00.000Z"),
            ),
        ]);
        let ids: Vec<String> = due(&store, now)
            .into_iter()
            .map(|schedule| schedule.id)
            .collect();
        assert_eq!(ids, vec!["earlier-1".to_string(), "later-1".to_string()]);
    }

    #[test]
    fn record_appends_a_run_and_advances_the_rrule() {
        let now = at("2030-01-01T01:00:05.000Z");
        let due_at = "2030-01-01T09:00:00.000+08:00";
        let (_temp, mut store) = store_with(vec![schedule(
            "daily-1",
            daily_timing("FREQ=DAILY"),
            Some(due_at),
        )]);
        let outcome = ScheduleRunOutcome {
            status: "succeeded".to_string(),
            session_id: Some("session-1".to_string()),
            error: None,
        };
        let value = record(&mut store, "daily-1", due_at, &outcome, now).expect("record");
        assert_eq!(value["revision"], 2);
        assert_eq!(value["status"], "active");
        assert_eq!(value["nextRunAt"], "2030-01-02T09:00:00.000+08:00");
        assert_eq!(value["updatedAt"], "2030-01-01T01:00:05.000Z");
        let schedule = schedule_by_id(&store, "daily-1");
        assert_eq!(schedule.runs.len(), 1);
        assert_eq!(schedule.runs[0].scheduled_for, due_at);
        assert_eq!(schedule.runs[0].session_id.as_deref(), Some("session-1"));
    }

    #[test]
    fn record_leaves_a_paused_schedule_paused() {
        let now = at("2030-01-01T01:00:05.000Z");
        let due_at = "2030-01-01T09:00:00.000+08:00";
        let mut paused = schedule("daily-1", daily_timing("FREQ=DAILY"), Some(due_at));
        paused.status = "paused".to_string();
        let (_temp, mut store) = store_with(vec![paused]);
        let outcome = ScheduleRunOutcome {
            status: "succeeded".to_string(),
            session_id: None,
            error: None,
        };
        record(&mut store, "daily-1", due_at, &outcome, now).expect("record");
        let schedule = schedule_by_id(&store, "daily-1");
        assert_eq!(schedule.status, "paused");
        assert_eq!(schedule.next_run_at.as_deref(), Some(due_at));
        assert_eq!(schedule.revision, 2);
        assert_eq!(schedule.runs.len(), 1);
    }

    #[test]
    fn record_rejects_unknown_schedules() {
        let now = at("2030-01-01T00:00:05.000Z");
        let (_temp, mut store) = store_with(Vec::new());
        let outcome = ScheduleRunOutcome {
            status: "succeeded".to_string(),
            session_id: None,
            error: None,
        };
        assert!(
            record(
                &mut store,
                "missing-1",
                "2030-01-01T00:00:00.000Z",
                &outcome,
                now
            )
            .is_err()
        );
        assert!(store.state().schedules.is_empty());
    }

    #[test]
    fn record_marks_unsupported_statuses_as_failed() {
        let now = at("2030-01-01T00:00:05.000Z");
        let due_at = "2030-01-01T00:00:00.000Z";
        let (_temp, mut store) =
            store_with(vec![schedule("once-1", once_timing(due_at), Some(due_at))]);
        let outcome = ScheduleRunOutcome {
            status: "done".to_string(),
            session_id: None,
            error: None,
        };
        record(&mut store, "once-1", due_at, &outcome, now).expect("record");
        let schedule = schedule_by_id(&store, "once-1");
        assert_eq!(schedule.runs[0].status, "failed");
        assert_eq!(
            schedule.runs[0].error.as_deref(),
            Some("Executor returned an unsupported run status: done")
        );
    }

    #[test]
    fn record_truncates_long_errors() {
        let now = at("2030-01-01T00:00:05.000Z");
        let due_at = "2030-01-01T00:00:00.000Z";
        let (_temp, mut store) =
            store_with(vec![schedule("once-1", once_timing(due_at), Some(due_at))]);
        let outcome = ScheduleRunOutcome {
            status: "failed".to_string(),
            session_id: None,
            error: Some("x".repeat(5_000)),
        };
        record(&mut store, "once-1", due_at, &outcome, now).expect("record");
        let schedule = schedule_by_id(&store, "once-1");
        assert_eq!(schedule.runs[0].error.as_deref().map(str::len), Some(4_000));
    }
}
