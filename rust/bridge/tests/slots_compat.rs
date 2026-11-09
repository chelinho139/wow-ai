mod support;
use wow_ai_reforged::agents::{AgentCapability, ModelCapability};
use wow_ai_reforged::slots::{Target, serialize};
#[test]
fn matches_node_slot_schema_for_every_status_and_optional_fields() {
    for (target, expected) in [
        (Target::Inbox, include_str!("fixtures/WoWAI_Inbox.lua")),
        (Target::Slot, include_str!("fixtures/WoWAI_SlotData.lua")),
    ] {
        let actual = serialize(target, &support::snapshot()).unwrap();
        // Only the generator attribution comment intentionally differs.
        assert_eq!(
            actual.lines().skip(1).collect::<Vec<_>>(),
            expected.lines().skip(1).collect::<Vec<_>>()
        );
    }
}
#[test]
fn empty_snapshot_and_unsafe_numbers() {
    let mut s = support::snapshot();
    s.replies.clear();
    s.agents.clear();
    let output = serialize(Target::Inbox, &s).unwrap();
    assert!(output.contains("agents = {  }"));
    assert!(!output.contains("restore ="));
    assert!(!output.contains("denied ="));
    s.now_seconds = 1_u64 << 53;
    assert!(serialize(Target::Slot, &s).is_err());
    let mut s = support::snapshot();
    s.replies[0].id = 1_u64 << 53;
    assert!(serialize(Target::Slot, &s).is_err());
}

#[test]
fn serializes_versioned_capabilities_and_effective_reply_configuration() {
    let mut snapshot = support::snapshot();
    snapshot.capabilities = Some(vec![AgentCapability {
        id: "codex".into(),
        name: "Codex".into(),
        available: true,
        reason: String::new(),
        default_model: "terra".into(),
        default_effort: "low".into(),
        models: vec![ModelCapability {
            id: "terra".into(),
            efforts: vec!["low".into(), "high".into()],
        }],
    }]);
    snapshot.replies[0].model = "terra".into();
    snapshot.replies[0].effort = "low".into();

    let output = serialize(Target::Slot, &snapshot).unwrap();
    assert!(output.contains("capabilities = {\n\t\tversion = 1,"));
    assert!(output.contains("defaultModel = \"terra\""));
    assert!(output.contains("efforts = { \"low\", \"high\" }"));
    assert!(output.contains("model = \"terra\""));
    assert!(output.contains("effort = \"low\""));
}
