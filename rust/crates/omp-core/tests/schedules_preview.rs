use omp_core::schedules::preview;
use serde_json::json;

#[test]
fn previews_daily_rrules_in_the_requested_time_zone() {
    let occurrences = preview(
        &json!({
            "kind": "rrule",
            "dtstartLocal": "2030-01-01T09:00:00",
            "timeZone": "Asia/Taipei",
            "rrule": "FREQ=DAILY;COUNT=5"
        }),
        3,
    )
    .expect("preview");
    assert_eq!(occurrences.len(), 3);
    assert!(occurrences[0].starts_with("2030-01-01T09:00:00"));
    assert!(occurrences[0].ends_with("+08:00"));
}

#[test]
fn previews_weekly_rrules_and_rejects_invalid_timing() {
    let occurrences = preview(
        &json!({
            "kind": "rrule",
            "dtstartLocal": "2030-01-01T09:00:00",
            "timeZone": "UTC",
            "rrule": "FREQ=WEEKLY;COUNT=3"
        }),
        3,
    )
    .expect("preview");
    assert_eq!(occurrences.len(), 3);
    assert!(preview(&json!({ "kind": "rrule", "rrule": "FREQ=DAILY" }), 3).is_err());
}
