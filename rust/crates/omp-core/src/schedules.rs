use chrono::{DateTime, NaiveDateTime, SecondsFormat, TimeZone, Utc};
use rrule::{RRule, RRuleSet, Tz, Unvalidated};
use serde_json::{Map, Value, json};
use uuid::Uuid;

use crate::agent::assert_no_mcp_authentication_command;
use crate::error::{CoreError, Result};
use crate::state::{
    AutomationScheduleRecord, ScheduleExecution, ScheduleTarget, ScheduleTiming, StateStore,
    now_iso, parse_schedule_execution,
};

fn parse_rrule_timing(timing: &Value) -> Result<(DateTime<Tz>, RRule)> {
    let dtstart_local = timing
        .get("dtstartLocal")
        .and_then(Value::as_str)
        .ok_or_else(|| CoreError::invalid("Schedule timing requires dtstartLocal"))?;
    let time_zone = timing
        .get("timeZone")
        .and_then(Value::as_str)
        .ok_or_else(|| CoreError::invalid("Schedule timing requires timeZone"))?;
    let rrule_text = timing
        .get("rrule")
        .and_then(Value::as_str)
        .ok_or_else(|| CoreError::invalid("Schedule timing requires rrule"))?;
    let parsed_zone: chrono_tz::Tz = time_zone
        .parse()
        .map_err(|_| CoreError::invalid(format!("Unknown time zone: {time_zone}")))?;
    let timezone: Tz = parsed_zone.into();
    let naive = NaiveDateTime::parse_from_str(dtstart_local, "%Y-%m-%dT%H:%M:%S")
        .or_else(|_| NaiveDateTime::parse_from_str(dtstart_local, "%Y-%m-%dT%H:%M"))
        .map_err(|_| CoreError::invalid("Schedule dtstartLocal is invalid"))?;
    let start = timezone
        .from_local_datetime(&naive)
        .single()
        .ok_or_else(|| CoreError::invalid("Schedule dtstartLocal is ambiguous"))?;
    let rule: RRule<Unvalidated> = rrule_text
        .parse()
        .map_err(|error| CoreError::invalid(format!("Schedule rrule is invalid: {error}")))?;
    let rule = rule
        .validate(start)
        .map_err(|error| CoreError::invalid(format!("Schedule rrule is invalid: {error}")))?;
    Ok((start, rule))
}

pub fn preview(timing: &Value, count: usize) -> Result<Vec<String>> {
    let kind = timing
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let limit = count.clamp(1, 100);
    match kind {
        "once" => {
            let at = timing
                .get("at")
                .and_then(Value::as_str)
                .ok_or_else(|| CoreError::invalid("Schedule timing requires at"))?;
            Ok(vec![at.to_string()])
        }
        "rrule" => {
            let (start, rule) = parse_rrule_timing(timing)?;
            let result = RRuleSet::new(start).rrule(rule).all(limit as u16);
            Ok(result
                .dates
                .iter()
                .map(|date| date.to_rfc3339_opts(SecondsFormat::Millis, true))
                .collect())
        }
        _ => Err(CoreError::invalid(
            "Schedule timing kind must be once or rrule",
        )),
    }
}

/// Returns the first occurrence strictly after `now`, formatted like [`preview`].
pub fn next_occurrence_after(timing: &Value, now: DateTime<Utc>) -> Result<Option<String>> {
    match timing
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default()
    {
        "once" => {
            let at = timing
                .get("at")
                .and_then(Value::as_str)
                .ok_or_else(|| CoreError::invalid("Schedule timing requires at"))?;
            let at = DateTime::parse_from_rfc3339(at)
                .map_err(|_| CoreError::invalid("Schedule timing requires a valid at"))?
                .with_timezone(&Utc);
            Ok((at > now).then(|| at.to_rfc3339_opts(SecondsFormat::Millis, true)))
        }
        "rrule" => {
            let (start, rule) = parse_rrule_timing(timing)?;
            let zone = start.timezone();
            let cursor = now.with_timezone(&zone);
            let dates = RRuleSet::new(start).rrule(rule).after(cursor).all(2).dates;
            Ok(dates
                .iter()
                .find(|date| **date > cursor)
                .map(|date| date.to_rfc3339_opts(SecondsFormat::Millis, true)))
        }
        _ => Err(CoreError::invalid(
            "Schedule timing kind must be once or rrule",
        )),
    }
}

fn parse_target(store: &StateStore, value: &Value) -> Result<ScheduleTarget> {
    let object = value
        .as_object()
        .ok_or_else(|| CoreError::invalid("Schedule target must be an object"))?;
    let kind = object
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let project_id = object
        .get("projectId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| CoreError::invalid("Schedule target requires projectId"))?;
    if !store
        .state()
        .projects
        .iter()
        .any(|project| project.id == project_id)
    {
        return Err(CoreError::invalid("Schedule target project is not granted"));
    }
    match kind {
        "project" => Ok(ScheduleTarget {
            kind: "project".to_string(),
            project_id: project_id.to_string(),
            session_id: None,
            unknown: Default::default(),
        }),
        "session" => {
            let session_id = object
                .get("sessionId")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .ok_or_else(|| CoreError::invalid("Schedule session target requires sessionId"))?;
            Ok(ScheduleTarget {
                kind: "session".to_string(),
                project_id: project_id.to_string(),
                session_id: Some(session_id.to_string()),
                unknown: Default::default(),
            })
        }
        _ => Err(CoreError::invalid(
            "Schedule target kind must be project or session",
        )),
    }
}

fn parse_timing(value: &Value) -> Result<ScheduleTiming> {
    let object = value
        .as_object()
        .ok_or_else(|| CoreError::invalid("Schedule timing must be an object"))?;
    match object.get("kind").and_then(Value::as_str) {
        Some("once") => Ok(ScheduleTiming {
            kind: "once".to_string(),
            at: Some(
                object
                    .get("at")
                    .and_then(Value::as_str)
                    .filter(|at| chrono::DateTime::parse_from_rfc3339(at).is_ok())
                    .ok_or_else(|| CoreError::invalid("Schedule timing requires a valid at"))?
                    .to_string(),
            ),
            dtstart_local: None,
            time_zone: None,
            rrule: None,
            unknown: Default::default(),
        }),
        Some("rrule") => {
            let dtstart_local = object
                .get("dtstartLocal")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty() && value.len() <= 64)
                .ok_or_else(|| CoreError::invalid("Schedule timing requires dtstartLocal"))?;
            let time_zone = object
                .get("timeZone")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty() && value.len() <= 128)
                .ok_or_else(|| CoreError::invalid("Schedule timing requires timeZone"))?;
            let rrule = object
                .get("rrule")
                .and_then(Value::as_str)
                .filter(|value| value.len() >= 2 && value.len() <= 2_048)
                .ok_or_else(|| CoreError::invalid("Schedule timing requires rrule"))?;
            Ok(ScheduleTiming {
                kind: "rrule".to_string(),
                at: None,
                dtstart_local: Some(dtstart_local.to_string()),
                time_zone: Some(time_zone.to_string()),
                rrule: Some(rrule.to_string()),
                unknown: Default::default(),
            })
        }
        _ => Err(CoreError::invalid(
            "Schedule timing kind must be once or rrule",
        )),
    }
}

fn parse_execution(value: &Value) -> Result<ScheduleExecution> {
    parse_schedule_execution(value)
        .ok_or_else(|| CoreError::invalid("Schedule execution is invalid"))
}

fn validate_title(value: Option<&Value>) -> Result<String> {
    value
        .and_then(Value::as_str)
        .filter(|title| !title.trim().is_empty() && title.chars().count() <= 200)
        .map(str::to_string)
        .ok_or_else(|| CoreError::invalid("Schedule title is required"))
}

fn validate_prompt(value: Option<&Value>) -> Result<String> {
    let prompt = value
        .and_then(Value::as_str)
        .filter(|prompt| !prompt.trim().is_empty() && prompt.len() <= 1024 * 1024)
        .ok_or_else(|| CoreError::invalid("Schedule prompt is required"))?;
    assert_no_mcp_authentication_command(prompt)?;
    Ok(prompt.to_string())
}

pub fn create(store: &mut StateStore, input: &Value, created_by: &str) -> Result<Value> {
    let object = input
        .as_object()
        .ok_or_else(|| CoreError::invalid("Schedule input must be an object"))?;
    let title = validate_title(object.get("title"))?;
    let prompt = validate_prompt(object.get("prompt"))?;
    let target = parse_target(
        store,
        object
            .get("target")
            .ok_or_else(|| CoreError::invalid("Schedule target is required"))?,
    )?;
    let timing = parse_timing(
        object
            .get("timing")
            .ok_or_else(|| CoreError::invalid("Schedule timing is required"))?,
    )?;
    let execution = parse_execution(
        object
            .get("execution")
            .ok_or_else(|| CoreError::invalid("Schedule execution is required"))?,
    )?;
    let next_run_at = preview(
        &serde_json::to_value(&timing)
            .map_err(|error| CoreError::new("Error", error.to_string()))?,
        1,
    )
    .ok()
    .and_then(|occurrences| occurrences.first().cloned());
    let now = now_iso();
    let record = AutomationScheduleRecord {
        schema_version: 1,
        id: Uuid::new_v4().to_string(),
        harness: "omp".to_string(),
        revision: 1,
        title,
        prompt,
        target,
        timing,
        execution,
        status: "active".to_string(),
        created_by: created_by.to_string(),
        created_at: now.clone(),
        updated_at: now,
        next_run_at,
        blocked_reason: None,
        runs: Vec::new(),
        unknown: Default::default(),
    };
    let value = serde_json::to_value(&record)
        .map_err(|error| CoreError::new("Error", error.to_string()))?;
    store.update(|state| {
        state.schedules.push(record);
        Ok(())
    })?;
    Ok(value)
}

pub fn list(store: &StateStore) -> Vec<Value> {
    store
        .state()
        .schedules
        .iter()
        .filter_map(|schedule| serde_json::to_value(schedule).ok())
        .collect()
}

pub fn update(store: &mut StateStore, id: &str, patch: &Value) -> Result<Value> {
    let object = patch
        .as_object()
        .ok_or_else(|| CoreError::invalid("Schedule patch must be an object"))?;
    let revision = object
        .get("revision")
        .and_then(Value::as_u64)
        .ok_or_else(|| CoreError::invalid("Schedule patch requires revision"))?;
    let current = store
        .state()
        .schedules
        .iter()
        .find(|schedule| schedule.id == id)
        .cloned()
        .ok_or_else(|| CoreError::invalid("Unknown schedule id"))?;
    if current.revision != revision {
        return Err(CoreError::invalid("Schedule revision is stale"));
    }
    let mut next = current.clone();
    if let Some(title) = object.get("title") {
        next.title = validate_title(Some(title))?;
    }
    if let Some(prompt) = object.get("prompt") {
        next.prompt = validate_prompt(Some(prompt))?;
    }
    if let Some(target) = object.get("target") {
        next.target = parse_target(store, target)?;
    }
    if let Some(timing) = object.get("timing") {
        next.timing = parse_timing(timing)?;
        next.next_run_at = preview(&serde_json::to_value(&next.timing)?, 1)
            .ok()
            .and_then(|occurrences| occurrences.first().cloned());
    }
    if let Some(execution) = object.get("execution") {
        next.execution = parse_execution(execution)?;
    }
    if let Some(status) = object.get("status").and_then(Value::as_str) {
        if !["active", "paused", "completed", "blocked"].contains(&status) {
            return Err(CoreError::invalid("Schedule status is invalid"));
        }
        next.status = status.to_string();
    }
    next.revision = current.revision + 1;
    next.updated_at = now_iso();
    let value = serde_json::to_value(&next)?;
    store.update(|state| {
        if let Some(schedule) = state
            .schedules
            .iter_mut()
            .find(|schedule| schedule.id == id)
        {
            *schedule = next;
        }
        Ok(())
    })?;
    Ok(value)
}

pub fn set_status(store: &mut StateStore, id: &str, status: &str) -> Result<Value> {
    let value = store.update(|state| {
        let schedule = state
            .schedules
            .iter_mut()
            .find(|schedule| schedule.id == id)
            .ok_or_else(|| CoreError::invalid("Unknown schedule id"))?;
        schedule.status = status.to_string();
        schedule.updated_at = now_iso();
        schedule.revision += 1;
        serde_json::to_value(&*schedule).map_err(|error| CoreError::new("Error", error.to_string()))
    })?;
    Ok(value)
}

pub fn delete(store: &mut StateStore, id: &str) -> Result<bool> {
    let removed = store.update(|state| {
        let before = state.schedules.len();
        state.schedules.retain(|schedule| schedule.id != id);
        Ok(state.schedules.len() != before)
    })?;
    Ok(removed)
}

pub fn broker_create(store: &mut StateStore, project_id: &str, input: &Value) -> Result<Value> {
    let mut input = input.clone();
    if let Some(object) = input.as_object_mut() {
        object.insert(
            "target".to_string(),
            json!({ "kind": "project", "projectId": project_id }),
        );
    }
    create(store, &input, "agent")
}

pub fn broker_list(store: &StateStore, project_id: &str) -> Value {
    Value::Array(
        store
            .state()
            .schedules
            .iter()
            .filter(|schedule| schedule.target_project_id() == Some(project_id))
            .filter_map(|schedule| serde_json::to_value(schedule).ok())
            .collect(),
    )
}

pub fn broker_delete(store: &mut StateStore, project_id: &str, id: &str) -> Result<Value> {
    let in_scope = store
        .state()
        .schedules
        .iter()
        .any(|schedule| schedule.id == id && schedule.target_project_id() == Some(project_id));
    if !in_scope {
        return Err(CoreError::invalid(
            "Scheduled task is outside this agent capability",
        ));
    }
    Ok(json!({ "ok": delete(store, id)? }))
}

pub fn empty_patch() -> Map<String, Value> {
    Map::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(value: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(value)
            .expect("timestamp")
            .with_timezone(&Utc)
    }

    fn daily(rrule: &str) -> Value {
        json!({
            "kind": "rrule",
            "dtstartLocal": "2030-01-01T09:00:00",
            "timeZone": "Asia/Taipei",
            "rrule": rrule
        })
    }

    #[test]
    fn next_occurrence_is_strictly_after_now() {
        let timing = daily("FREQ=DAILY");
        assert_eq!(
            next_occurrence_after(&timing, at("2030-01-01T01:00:00.000Z"))
                .expect("next")
                .as_deref(),
            Some("2030-01-02T09:00:00.000+08:00")
        );
        assert_eq!(
            next_occurrence_after(&timing, at("2030-01-01T00:59:59.999Z"))
                .expect("next")
                .as_deref(),
            Some("2030-01-01T09:00:00.000+08:00")
        );
    }

    #[test]
    fn next_occurrence_is_none_when_the_timing_is_exhausted() {
        let exhausted = daily("FREQ=DAILY;COUNT=1");
        assert!(
            next_occurrence_after(&exhausted, at("2030-01-01T01:00:00.000Z"))
                .expect("next")
                .is_none()
        );
        let once = json!({ "kind": "once", "at": "2030-01-01T09:00:00.000Z" });
        assert!(
            next_occurrence_after(&once, at("2030-01-01T09:00:00.000Z"))
                .expect("next")
                .is_none()
        );
        assert_eq!(
            next_occurrence_after(&once, at("2030-01-01T08:00:00.000Z"))
                .expect("next")
                .as_deref(),
            Some("2030-01-01T09:00:00.000Z")
        );
    }

    #[test]
    fn next_occurrence_rejects_unknown_timing_kinds() {
        assert!(
            next_occurrence_after(&json!({ "kind": "cron" }), at("2030-01-01T00:00:00.000Z"))
                .is_err()
        );
    }
}
