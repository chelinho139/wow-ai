use serde::Deserialize;
use wow_ai_reforged::reload::parse_outbox;

#[derive(Deserialize)]
struct Case {
    source: String,
    expected: serde_json::Value,
}

#[test]
fn saved_variables_match_legacy_outbox_contract() {
    // Golden results from the unchanged bridge/protocol.js parseOutbox.
    let cases: Vec<Case> = serde_json::from_str(include_str!("fixtures/reload.json")).unwrap();
    for case in cases {
        let job = parse_outbox(&case.source).unwrap().unwrap();
        let expected = case.expected;
        assert_eq!(job.id, expected["id"].as_u64().unwrap());
        assert_eq!(job.session, expected["session"]);
        assert_eq!(job.chat, expected["chat"]);
        assert_eq!(job.text, expected["text"]);
        assert_eq!(job.cwd, expected["cwd"]);
        assert_eq!(job.flags.new_session, expected["newSession"]);
        assert_eq!(
            job.context.as_deref(),
            expected.get("ctx").and_then(|v| v.as_str())
        );
        assert_eq!(
            job.flags.agent,
            expected.get("agent").and_then(|v| v.as_str()).unwrap_or("")
        );
        let allow: Vec<String> = expected
            .get("allow")
            .map(|v| serde_json::from_value(v.clone()).unwrap())
            .unwrap_or_default();
        assert_eq!(job.flags.allow, allow);
    }
}
