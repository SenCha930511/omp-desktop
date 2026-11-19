use std::fs;

use omp_core::state::{Platform, StateStore};
use serde_json::{Value, json};
use tempfile::TempDir;

fn state_fixture() -> Value {
    json!({
        "version": 4,
        "projects": [{
            "id": "p-1",
            "harness": "omp",
            "name": "Original",
            "path": "/tmp/project",
            "folders": ["/tmp/project"],
            "primaryFolder": "/tmp/project",
            "pinned": false,
            "createdAt": "2026-01-01T00:00:00.000Z",
            "lastOpenedAt": "2026-01-01T00:00:00.000Z",
            "folderIdentities": {
                "/tmp/project": { "dev": "1", "ino": "2", "birthtimeNs": "3", "_futureIdentity": { "keep": true } }
            },
            "scripts": { "setup": "echo setup", "run": "echo run", "_futureScript": ["keep"] },
            "_futureProject": { "keep": true }
        }],
        "settings": {
            "theme": "dark",
            "runtimePaths": { "omp": "", "_futureRuntime": "/future/omp" },
            "lastSelectedModels": { "omp": "", "_futureModel": "future/model" },
            "_futureSetting": { "keep": true }
        },
        "archivedSessions": [],
        "pinnedSessions": [],
        "dismissedProjectPaths": [],
        "schedules": [{
            "schemaVersion": 1,
            "id": "s-1",
            "harness": "omp",
            "revision": 1,
            "title": "Schedule",
            "prompt": "Do work",
            "target": { "kind": "project", "projectId": "p-1", "_futureTarget": 1 },
            "timing": { "kind": "rrule", "dtstartLocal": "2030-01-01T09:00:00", "timeZone": "UTC", "rrule": "FREQ=DAILY", "_futureTiming": 2 },
            "execution": { "model": "auto", "thinking": "auto", "speed": "normal", "_futureExecution": 3 },
            "status": "active",
            "createdBy": "user",
            "createdAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": "2026-01-01T00:00:00.000Z",
            "runs": [{
                "id": "r-1",
                "taskId": "s-1",
                "taskRevision": 1,
                "trigger": "manual",
                "scheduledFor": "2026-01-01T00:00:00.000Z",
                "queuedAt": "2026-01-01T00:00:00.000Z",
                "status": "succeeded",
                "execution": { "model": "auto", "thinking": "auto", "speed": "normal", "_futureRunExecution": 5 },
                "_futureRun": 4
            }],
            "_futureSchedule": { "keep": true }
        }],
        "_futureTop": { "keep": true }
    })
}

#[test]
fn deep_unknown_fields_survive_a_load_modify_save_round_trip() {
    let temp = TempDir::new().expect("temp dir");
    let user_data = temp.path().join("user-data");
    fs::create_dir_all(&user_data).expect("user data");
    let state_path = user_data.join(omp_core::state::CURRENT_DESKTOP_STATE_FILENAME);
    fs::write(
        &state_path,
        serde_json::to_string_pretty(&state_fixture()).expect("serialize"),
    )
    .expect("write state");

    let mut store =
        StateStore::open(state_path.clone(), None, Platform::Linux).expect("open state");
    store
        .update(|state| {
            state.projects[0].name = "Renamed".to_string();
            Ok(())
        })
        .expect("update project");

    let saved: Value = serde_json::from_str(&fs::read_to_string(&state_path).expect("read state"))
        .expect("parse state");
    assert_eq!(saved["projects"][0]["name"], "Renamed");
    assert_eq!(saved["_futureTop"], json!({ "keep": true }));
    assert_eq!(saved["settings"]["_futureSetting"], json!({ "keep": true }));
    assert_eq!(
        saved["settings"]["runtimePaths"]["_futureRuntime"],
        "/future/omp"
    );
    assert_eq!(
        saved["settings"]["lastSelectedModels"]["_futureModel"],
        "future/model"
    );
    assert_eq!(
        saved["projects"][0]["_futureProject"],
        json!({ "keep": true })
    );
    assert_eq!(
        saved["projects"][0]["scripts"]["_futureScript"],
        json!(["keep"])
    );
    assert_eq!(
        saved["projects"][0]["folderIdentities"]["/tmp/project"]["_futureIdentity"],
        json!({ "keep": true })
    );
    assert_eq!(
        saved["schedules"][0]["_futureSchedule"],
        json!({ "keep": true })
    );
    assert_eq!(saved["schedules"][0]["target"]["_futureTarget"], 1);
    assert_eq!(saved["schedules"][0]["timing"]["_futureTiming"], 2);
    assert_eq!(saved["schedules"][0]["execution"]["_futureExecution"], 3);
    assert_eq!(saved["schedules"][0]["runs"][0]["_futureRun"], 4);
    assert_eq!(
        saved["schedules"][0]["runs"][0]["execution"]["_futureRunExecution"],
        5
    );
}
