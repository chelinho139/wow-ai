use serde_json::json;
use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant},
};
use wow_ai_reforged::{config::Config, frame::Frame, live::LiveBridge, state::State};
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
        .tick(Instant::now() + Duration::from_secs(31))
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
