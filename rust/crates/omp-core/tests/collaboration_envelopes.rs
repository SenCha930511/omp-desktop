use base64::Engine;
use omp_core::collaboration::{encode, verify};
use serde_json::Value;

#[test]
fn verifies_node_generated_v1_v2_v3_envelopes_and_rejects_tampering() {
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/agent-envelopes.json")).expect("fixture");
    let key = base64::engine::general_purpose::STANDARD
        .decode(fixture["key"].as_str().expect("key"))
        .expect("decode key");
    let expected_id = fixture["fromSessionId"].as_str().expect("fromSessionId");
    let expected_text = fixture["text"].as_str().expect("text");
    for case in fixture["cases"].as_array().expect("cases") {
        let name = case["name"].as_str().expect("name");
        let envelope = case["envelope"].as_str().expect("envelope");
        let parsed = verify(&key, envelope).unwrap_or_else(|| panic!("{name} must verify"));
        assert_eq!(parsed["fromSessionId"], expected_id, "{name}");
        assert_eq!(parsed["text"], expected_text, "{name}");
        let tampered = envelope.replace(expected_text, "Malicious edit");
        assert!(
            verify(&key, &tampered).is_none(),
            "{name} tampering must fail"
        );
    }
}

#[test]
fn encodes_v3_envelopes_that_round_trip() {
    let key = [7u8; 32];
    let envelope =
        encode(&key, "019fdf24-1111-7000-8000-000000000001", "Hello peer").expect("encode");
    let parsed = verify(&key, &envelope).expect("verify");
    assert_eq!(
        parsed["fromSessionId"],
        "019fdf24-1111-7000-8000-000000000001"
    );
    assert_eq!(parsed["text"], "Hello peer");
    assert!(verify(&[8u8; 32], &envelope).is_none());
}
