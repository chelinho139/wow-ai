use serde_json::json;
use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant},
};
use wow_ai_reforged::{config::Config, frame::Frame, live::LiveBridge, state::State};
#[path = "parity/mod.rs"]
mod parity;
static N: AtomicU64 = AtomicU64::new(0);
struct Fixture {
    root: PathBuf,
    cfg: Config,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "reforged-transport-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        let addons = root.join("AddOns");
        fs::create_dir_all(addons.join("WoWAI")).unwrap();
        fs::write(addons.join("WoWAI/Inbox.lua"), b"old").unwrap();
        for n in 1..=200 {
            let dir = addons.join(format!("WoWAI_S{n:03}"));
            fs::create_dir(&dir).unwrap();
            fs::write(dir.join("Inbox.lua"), b"old").unwrap();
        }
        for dir in ["ack", "sig", "presence"] {
            fs::create_dir(addons.join("WoWAI").join(dir)).unwrap();
        }
        for n in 1..=2000 {
            fs::write(addons.join(format!("WoWAI/presence/{n:04}.wav")), b"").unwrap();
        }
        for n in 1..=10 {
            for kind in ["ack", "sig"] {
                fs::write(addons.join(format!("WoWAI/{kind}/{n:03}.wav")), b"").unwrap();
            }
            let dir = addons.join(format!("WoWAI/act/{n:03}"));
            fs::create_dir_all(&dir).unwrap();
            for k in 1..=60 {
                fs::write(dir.join(format!("{k:02}.wav")), b"").unwrap();
            }
        }
        let exe = env!("CARGO_BIN_EXE_wow-ai-reforged");
        let data = json!({"schema_version":1,"project_dir":root,"data_dir":root.join("data"),"addon_dir":addons,"agent":"codex","timeout_ms":10000,"agents":{
            "codex":{"executable":exe,"launcher_args":["__fixture-agent","codex","echo"]},
            "gemini":{"executable":exe,"launcher_args":["__fixture-agent","gemini","echo"]}
        }});
        let path = root.join("cfg.json");
        fs::write(&path, serde_json::to_vec(&data).unwrap()).unwrap();
        let cfg = Config::load(&path).unwrap();
        Self { root, cfg }
    }
    fn frame(&self, id: u16, flags: &str, text: &str) -> Frame {
        Frame {
            id,
            text: format!("addon-token\x1fchat\x1f{id}\x1f\x1f{flags}\x1fname\x1f{text}"),
        }
    }
    fn inbox(&self) -> String {
        fs::read_to_string(self.cfg.addon_dir.as_ref().unwrap().join("WoWAI/Inbox.lua")).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
#[test]
fn hello_publishes_connection_clock_and_all_configured_agents_without_running_agent() {
    let f = Fixture::new();
    let mut bridge = LiveBridge::start(&f.cfg, None).unwrap();
    bridge.accept_frame(&f.frame(1, "h", "")).unwrap();
    let text = f.inbox();
    assert!(text.contains("now = "));
    assert!(text.contains("agent = \"codex\""));
    assert!(
        text.contains(
            "agents = { \"agy\", \"claude\", \"codex\", \"gemini\", \"grok\", \"hermes\" }"
        )
    );
    assert!(!text.contains("status ="));
    let state = State::load(&f.cfg.data_dir).unwrap();
    assert!(state.history.is_empty());
}
#[test]
fn periodic_presence_advances_and_survives_restart() {
    let f = Fixture::new();
    let now = Instant::now();
    {
        let mut bridge = LiveBridge::start(&f.cfg, None).unwrap();
        bridge.tick(now).unwrap();
        bridge.tick(now + Duration::from_secs(31)).unwrap();
    }
    let mut bridge = LiveBridge::start(&f.cfg, None).unwrap();
    bridge.tick(Instant::now()).unwrap();
    assert_eq!(State::load(&f.cfg.data_dir).unwrap().presence_counter, 3);
    assert_eq!(
        fs::read(
            f.cfg
                .addon_dir
                .as_ref()
                .unwrap()
                .join("WoWAI/presence/0003.wav")
        )
        .unwrap(),
        wow_ai_reforged::signals::silent_wav()
    );
}
#[test]
fn unknown_agent_publishes_error_instead_of_running_default_agent() {
    let f = Fixture::new();
    let mut bridge = LiveBridge::start(&f.cfg, None).unwrap();
    assert!(
        bridge
            .accept_frame(&f.frame(2, "agent=typo", "must not run"))
            .is_err()
    );
    assert!(f.inbox().contains("status = \"error\""));
    assert!(State::load(&f.cfg.data_dir).unwrap().sessions.is_empty());
}
#[test]
fn alternate_agent_keeps_global_default_and_duplicate_frames_are_not_rerun() {
    let f = Fixture::new();
    let mut bridge = LiveBridge::start(&f.cfg, None).unwrap();
    let frame = f.frame(3, "agent=gemini", "hello");
    bridge.accept_frame(&frame).unwrap();
    bridge.accept_frame(&frame).unwrap();
    let text = f.inbox();
    assert!(text.contains("\n\tagent = \"codex\""));
    assert!(text.contains("Fake gemini reply"));
    assert_eq!(
        State::load(&f.cfg.data_dir).unwrap().history["chat"].len(),
        2
    );
}
#[test]
fn missing_slot_stops_work_before_an_agent_is_invoked() {
    let f = Fixture::new();
    let mut bridge = LiveBridge::start(&f.cfg, None).unwrap();
    let slot = f
        .cfg
        .addon_dir
        .as_ref()
        .unwrap()
        .join("WoWAI_S200/Inbox.lua");
    fs::remove_file(&slot).unwrap();
    fs::create_dir(&slot).unwrap();
    assert!(bridge.accept_frame(&f.frame(4, "", "hello")).is_err());
    // Working publication must fail before a provider is invoked.
    assert!(State::load(&f.cfg.data_dir).unwrap().sessions.is_empty());
}

#[test]
fn completed_reply_recovers_after_restart_without_rerunning_the_agent() {
    let mut f = Fixture::new();
    let path = f.cfg.addon_dir.as_ref().unwrap().join("WoWAI/Inbox.lua");
    f.cfg.agents.get_mut("codex").unwrap().launcher_args = vec![
        "__fixture-agent".into(),
        "codex".into(),
        "block-publish".into(),
        "--block-path".into(),
        path.to_string_lossy().into_owned(),
    ];
    let frame = f.frame(5, "", "only once");
    {
        let mut bridge = LiveBridge::start(&f.cfg, None).unwrap();
        assert!(bridge.accept_frame(&frame).is_err());
    }
    assert!(State::load(&f.cfg.data_dir).unwrap().pending.is_some());
    fs::remove_dir(&path).unwrap();
    fs::write(&path, b"old").unwrap();
    let mut bridge = LiveBridge::start(&f.cfg, None).unwrap();
    bridge.tick(Instant::now()).unwrap();
    bridge.accept_frame(&frame).unwrap();
    let state = State::load(&f.cfg.data_dir).unwrap();
    assert!(state.pending.is_none());
    assert_eq!(state.history["chat"].len(), 2);
    assert!(f.inbox().contains("Fake codex reply: only once"));
}
#[test]
fn hello_context_is_available_to_later_messages_and_forget_removes_history() {
    let f = Fixture::new();
    let mut bridge = LiveBridge::start(&f.cfg, None).unwrap();
    let hello = Frame {
        id: 6,
        text: "token\x1fchat\x1f6\x1f\x1fh;c\x1fname\x1fCharacter: Mage\x1f".into(),
    };
    bridge.accept_frame(&hello).unwrap();
    bridge.accept_frame(&f.frame(7, "", "hello")).unwrap();
    assert!(f.inbox().contains("Character: Mage"));
    bridge.accept_frame(&f.frame(8, "d", "")).unwrap();
    let state = State::load(&f.cfg.data_dir).unwrap();
    assert!(!state.history.contains_key("chat"));
    assert!(!state.sessions.contains_key("chat"));
}

#[test]
fn an_uninstalled_optional_agent_does_not_block_the_default_agent() {
    let f = Fixture::new();
    let path = f.root.join("cfg.json");
    let mut config: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    config["agents"]["gemini"]["executable"] = json!(f.root.join("missing-agent.exe"));
    fs::write(&path, serde_json::to_vec(&config).unwrap()).unwrap();
    let cfg = Config::load(&path).unwrap();
    let mut bridge = LiveBridge::start(&cfg, None).unwrap();
    assert!(
        bridge
            .accept_frame(&f.frame(9, "agent=gemini", "hello"))
            .is_err()
    );
    assert!(f.inbox().contains("status = \"error\""));
    assert!(State::load(&cfg.data_dir).unwrap().sessions.is_empty());
}

#[test]
fn shutdown_publishes_offline_to_every_slot_and_hello_reconnects() {
    let f = Fixture::new();
    {
        let mut bridge = LiveBridge::start(&f.cfg, None).unwrap();
        bridge.accept_frame(&f.frame(1, "h", "")).unwrap();
        assert!(f.inbox().contains("bridgeOnline = true"));
        bridge.shutdown().unwrap();
        assert!(f.inbox().contains("bridgeOnline = false"));
        for n in 1..=200 {
            let path = f
                .cfg
                .addon_dir
                .as_ref()
                .unwrap()
                .join(format!("WoWAI_S{n:03}/Inbox.lua"));
            assert!(
                fs::read_to_string(path)
                    .unwrap()
                    .contains("bridgeOnline = false")
            );
        }
    }
    let mut bridge = LiveBridge::start(&f.cfg, None).unwrap();
    bridge.accept_frame(&f.frame(2, "h", "")).unwrap();
    assert!(f.inbox().contains("bridgeOnline = true"));
}

#[test]
fn heartbeats_and_shutdown_preserve_an_unread_reply() {
    let f = Fixture::new();
    let mut bridge = LiveBridge::start(&f.cfg, None).unwrap();
    bridge
        .accept_frame(&f.frame(3, "agent=codex", "unread answer"))
        .unwrap();
    let original = f.inbox();
    assert!(original.contains("status = \"done\""));
    let replies = original.split_once("\n\treplies = {").unwrap().1.to_owned();
    let now_line = original
        .lines()
        .find(|line| line.starts_with("\tnow = "))
        .unwrap();
    let stale = original.replacen(now_line, "\tnow = 1,", 1);
    fs::write(
        f.cfg.addon_dir.as_ref().unwrap().join("WoWAI/Inbox.lua"),
        stale,
    )
    .unwrap();
    bridge
        .tick(Instant::now() + Duration::from_secs(301))
        .unwrap();
    let fresh = f.inbox();
    assert!(!fresh.contains("\tnow = 1,"));
    assert_eq!(fresh.split_once("\n\treplies = {").unwrap().1, replies);
    bridge.shutdown().unwrap();
    bridge.shutdown().unwrap(); // Repeated shutdown must also retain the reply.
    let offline = f.inbox();
    assert!(offline.contains("bridgeOnline = false"));
    assert_eq!(offline.split_once("\n\treplies = {").unwrap().1, replies);
    let slot = fs::read_to_string(
        f.cfg
            .addon_dir
            .as_ref()
            .unwrap()
            .join("WoWAI_S200/Inbox.lua"),
    )
    .unwrap();
    assert_eq!(slot.split_once("\n\treplies = {").unwrap().1, replies);
    assert!(slot.contains("bridgeOnline = false"));
}

#[test]
fn replies_from_multiple_records_and_frames_survive_later_publications() {
    let f = Fixture::new();
    {
        let mut bridge = LiveBridge::start(&f.cfg, None).unwrap();
        let a = f.frame(2, "", "first");
        let b = f.frame(3, "", "second");
        // Use distinct chats as the addon permits one outstanding request per chat.
        let text_b = b.text.replacen("chat", "other", 1);
        bridge
            .accept_frame(&Frame {
                id: 3,
                text: format!("{}\x1e{}", a.text, text_b),
            })
            .unwrap();
        let inbox = f.inbox();
        assert!(inbox.contains("Fake codex reply: first"));
        assert!(inbox.contains("Fake codex reply: second"));
        let c = f.frame(4, "", "third");
        bridge
            .accept_frame(&Frame {
                id: 4,
                text: c.text.replacen("chat", "third-chat", 1),
            })
            .unwrap();
        assert!(f.inbox().contains("Fake codex reply: first"));
        bridge.shutdown().unwrap();
    }
    let mut bridge = LiveBridge::start(&f.cfg, None).unwrap();
    bridge.accept_frame(&f.frame(5, "h", "")).unwrap();
    let inbox = f.inbox();
    for text in ["first", "second", "third"] {
        assert!(inbox.contains(&format!("Fake codex reply: {text}")));
    }
}
#[test]
fn idle_slot_clock_broadcasts_are_less_frequent_than_presence_beats() {
    let f = Fixture::new();
    let mut bridge = LiveBridge::start(&f.cfg, None).unwrap();
    bridge.accept_frame(&f.frame(1, "h", "")).unwrap();
    let inbox = f.cfg.addon_dir.as_ref().unwrap().join("WoWAI/Inbox.lua");
    let text = f.inbox();
    let now_line = text
        .lines()
        .find(|line| line.starts_with("\tnow = "))
        .unwrap();
    fs::write(&inbox, text.replacen(now_line, "\tnow = 1,", 1)).unwrap();
    let now = Instant::now();
    bridge.tick(now + Duration::from_secs(31)).unwrap();
    assert!(f.inbox().contains("\tnow = 1,"));
    bridge.tick(now + Duration::from_secs(301)).unwrap();
    assert!(!f.inbox().contains("\tnow = 1,"));
}

#[test]
fn nonzero_agent_diagnostics_are_bounded_before_broadcast() {
    let mut f = Fixture::new();
    f.cfg.max_output_bytes = 1_048_576;
    f.cfg.agents.get_mut("codex").unwrap().launcher_args = vec![
        "__fixture-agent".into(),
        "codex".into(),
        "large-error".into(),
    ];
    let mut bridge = LiveBridge::start(&f.cfg, None).unwrap();
    assert!(bridge.accept_frame(&f.frame(7, "", "fail safely")).is_err());
    let inbox = f.inbox();
    assert!(inbox.contains("diagnostic truncated"));
    assert!(inbox.len() < 20_000);
    for n in 1..=200 {
        assert!(
            fs::metadata(
                f.cfg
                    .addon_dir
                    .as_ref()
                    .unwrap()
                    .join(format!("WoWAI_S{n:03}/Inbox.lua"))
            )
            .unwrap()
            .len()
                < 20_000
        );
    }
}

#[test]
fn restart_turns_orphaned_work_into_error_without_rerunning() {
    let f = Fixture::new();
    let frame = f.frame(3, "", "only once");
    {
        let mut bridge = LiveBridge::start(&f.cfg, None).unwrap();
        bridge.accept_frame(&frame).unwrap();
    }
    let path = f.cfg.data_dir.join("reforged-live-replies.json");
    let mut cache: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    cache["replies"][0]["status"] = json!("Working");
    fs::write(path, serde_json::to_vec(&cache).unwrap()).unwrap();
    let mut bridge = LiveBridge::start(&f.cfg, None).unwrap();
    assert!(f.inbox().contains("status = \"error\""));
    assert!(f.inbox().contains("will not be resent automatically"));
    bridge.accept_frame(&frame).unwrap();
    assert_eq!(
        State::load(&f.cfg.data_dir).unwrap().history["chat"].len(),
        2
    );
    assert!(f.inbox().contains("status = \"error\""));
}

#[test]
fn chat_configuration_is_validated_published_and_resets_sessions() {
    let mut f = Fixture::new();
    let mut settings = serde_json::to_value(f.cfg.agents.get("codex").unwrap()).unwrap();
    settings["model"] = json!("terra");
    settings["models"] = json!([
        {"id":"terra","reasoningEfforts":["low","high"]},
        {"id":"sol","reasoningEfforts":["high"]}
    ]);
    settings["reasoning_effort"] = json!("low");
    f.cfg
        .agents
        .insert("codex".into(), serde_json::from_value(settings).unwrap());
    let mut bridge = LiveBridge::start(&f.cfg, None).unwrap();
    bridge.accept_frame(&f.frame(1, "h", "")).unwrap();
    let hello = f.inbox();
    assert!(hello.contains("capabilities ="));
    assert!(hello.contains("defaultModel = \"terra\""));
    bridge
        .accept_frame(&f.frame(2, "model=terra;effort=low", "first"))
        .unwrap();
    assert!(f.inbox().contains("model = \"terra\""));
    assert!(f.inbox().contains("effort = \"low\""));
    bridge
        .accept_frame(&f.frame(3, "model=terra;effort=low", "same"))
        .unwrap();
    assert!(f.inbox().contains("[resume=fake-codex-session]"));
    bridge
        .accept_frame(&f.frame(4, "model=sol;effort=high", "changed"))
        .unwrap();
    assert!(!f.inbox().contains("[resume="));
    assert!(f.inbox().contains("model = \"sol\""));
    assert!(
        bridge
            .accept_frame(&f.frame(5, "model=sol", "invalid inherited effort"))
            .is_err()
    );
    assert!(f.inbox().contains("status = \"error\""));
    assert!(
        bridge
            .accept_frame(&f.frame(6, "model=unknown", "invalid model"))
            .is_err()
    );
    bridge.accept_frame(&f.frame(7, "", "reset")).unwrap();
    assert!(f.inbox().contains("model = \"terra\""));
    assert!(!f.inbox().contains("[resume="));
    // Different chats retain independent backend sessions and settings.
    let other = Frame {
        id: 8,
        text: "addon-token\x1fother\x1f8\x1f\x1fmodel=sol;effort=high\x1fname\x1fother chat".into(),
    };
    bridge.accept_frame(&other).unwrap();
    bridge
        .accept_frame(&f.frame(9, "", "back to first"))
        .unwrap();
    assert!(f.inbox().contains("[resume=fake-codex-session]"));
    assert_eq!(State::load(&f.cfg.data_dir).unwrap().sessions.len(), 2);
}

#[test]
fn per_chat_folder_selection_is_known_gap() {
    let mut f = Fixture::new();
    let selected = f.root.join("selected-project");
    fs::create_dir(&selected).unwrap();
    let selected = selected.canonicalize().unwrap();
    let cwd_record = f.root.join("agent-cwd.txt");
    f.cfg.agents.get_mut("codex").unwrap().launcher_args = vec![
        "__fixture-agent".into(),
        "codex".into(),
        "record-cwd".into(),
        "--record-path".into(),
        cwd_record.to_string_lossy().into_owned(),
    ];
    let frame = Frame {
        id: 7,
        text: "addon-token\x1fchat\x1f7\x1fselected-project\x1f\x1fname\x1fhello".into(),
    };
    let mut bridge = LiveBridge::start(&f.cfg, None).unwrap();
    const UNSUPPORTED: &str =
        "Per-chat folder changes are not supported by this live preview; set project_dir in config";
    let before = f.inbox();
    let request = bridge.accept_frame(&frame);
    let inbox = f.inbox();
    let state = State::load(&f.cfg.data_dir).unwrap();
    let result = match request {
        Ok(()) => {
            if inbox.contains("Fake codex reply: hello")
                && fs::read_to_string(&cwd_record).ok().as_deref()
                    == Some(selected.to_string_lossy().as_ref())
                && state.sessions.get("chat").is_some_and(|session| session.project == selected)
            {
                parity::ContractResult::Satisfied
            } else {
                parity::ContractResult::UnexpectedFailure {
                    diagnostics: format!("request succeeded without the requested folder contract: {inbox}"),
                }
            }
        }
        Err(error) if error.to_string() == UNSUPPORTED
            && inbox != before
            && inbox.contains(&format!("text = {},", wow_ai_reforged::protocol::lua_string(UNSUPPORTED)))
            && inbox.contains("id = 7,")
            && inbox.contains("chat = \"chat\",")
            && inbox.contains("status = \"error\",")
            && !cwd_record.exists()
            && state.sessions.is_empty()
            && state.history.is_empty()
            && state.pending.is_none() =>
        {
            parity::ContractResult::KnownGap {
                contract_id: "folder_selection".into(),
                reason_code: "unsupported_folder".into(),
                evidence: "Current request returned the exact unsupported-folder error and published its matching error reply; no provider invocation, session, history or pending reply".into(),
            }
        }
        Err(error) => parity::ContractResult::UnexpectedFailure {
            diagnostics: format!("{error}; published inbox: {inbox}"),
        },
    };
    let inventory = parity::load_inventory().unwrap();
    let expectation = parity::expectation_for(&inventory, "folder_selection").unwrap();
    parity::assert_contract("folder_selection", &expectation, &result);
}
