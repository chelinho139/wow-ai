use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
    sync::atomic::{AtomicU64, Ordering},
};
static SEQUENCE: AtomicU64 = AtomicU64::new(0);
const BINARY: &str = env!("CARGO_BIN_EXE_wow-ai-reforged");
struct Workspace(PathBuf);
impl Workspace {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "reforged pipeline é {} {}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        fs::create_dir(path.join("project")).unwrap();
        fs::write(
            path.join("project/state.json"),
            "legacy state stays unchanged",
        )
        .unwrap();
        fs::write(
            path.join("project/transcripts.json"),
            "legacy history stays unchanged",
        )
        .unwrap();
        Self(path)
    }
    fn config(&self, scenario: &str, timeout: u64, limit: usize) -> PathBuf {
        let mut agents = serde_json::Map::new();
        for name in ["claude", "codex", "grok", "agy", "hermes", "gemini"] {
            agents.insert(
                name.into(),
                json!({"executable":BINARY,"launcher_args":["__fixture-agent",name,scenario]}),
            );
        }
        let config = json!({"schema_version":1,"project_dir":self.0.join("project"),"data_dir":self.0.join("data"),"agent":"codex","timeout_ms":timeout,"max_output_bytes":limit,"agents":agents});
        let path = self.0.join("config.json");
        fs::write(&path, serde_json::to_vec(&config).unwrap()).unwrap();
        path
    }
    fn invoke(&self, config: &Path, agent: &str, extra: &[&str]) -> Output {
        Command::new(BINARY)
            .args(["inject", "--config"])
            .arg(config)
            .args([
                "--agent",
                agent,
                "--chat",
                "chat",
                "--prompt",
                "Hello 世界 & $(literal) \"quoted\"",
            ])
            .args(extra)
            .output()
            .unwrap()
    }
    fn state(&self) -> Value {
        serde_json::from_slice(&fs::read(self.0.join("data/reforged-state.json")).unwrap()).unwrap()
    }
    fn legacy_unchanged(&self) {
        assert_eq!(
            fs::read_to_string(self.0.join("project/state.json")).unwrap(),
            "legacy state stays unchanged"
        );
        assert_eq!(
            fs::read_to_string(self.0.join("project/transcripts.json")).unwrap(),
            "legacy history stays unchanged"
        );
    }
}
impl Drop for Workspace {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
#[test]
fn every_adapter_runs_to_private_lua_and_preserves_legacy_data() {
    let w = Workspace::new();
    let config = w.config("echo", 10000, 65536);
    for name in ["claude", "codex", "grok", "agy", "hermes", "gemini"] {
        let output = w.invoke(&config, name, &[]);
        assert!(
            output.status.success(),
            "{name}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert!(
            result["text"]
                .as_str()
                .unwrap()
                .contains("Hello 世界 & $(literal) \"quoted\"")
        );
        assert_eq!(result["agent"], name);
        assert_eq!(result["session"], format!("fake-{name}-session"));
        let lua = fs::read_to_string(w.0.join("data/outbox/WoWAI_S001/Inbox.lua")).unwrap();
        assert!(lua.contains("status = \"done\""));
        assert!(lua.contains(&format!("agent = \"{name}\"")));
        assert!(!w.0.join("data/agent-prompt.txt").exists());
    }
    assert_eq!(w.state()["next_id"], 7);
    w.legacy_unchanged();
}
#[test]
fn own_sessions_resume_and_new_session_and_provider_switch_reset() {
    let w = Workspace::new();
    let config = w.config("echo", 10000, 65536);
    assert!(w.invoke(&config, "codex", &[]).status.success());
    let result: Value = serde_json::from_slice(&w.invoke(&config, "codex", &[]).stdout).unwrap();
    assert!(
        result["text"]
            .as_str()
            .unwrap()
            .contains("resume=fake-codex-session")
    );
    let result: Value =
        serde_json::from_slice(&w.invoke(&config, "codex", &["--fresh-session"]).stdout).unwrap();
    assert!(!result["text"].as_str().unwrap().contains("resume="));
    let result: Value = serde_json::from_slice(&w.invoke(&config, "claude", &[]).stdout).unwrap();
    assert!(!result["text"].as_str().unwrap().contains("resume="));
    w.legacy_unchanged();
}
#[test]
fn timeout_overflow_bad_stream_and_nonzero_exit_become_error_replies() {
    for scenario in ["hang", "flood", "malformed", "exit", "model-error"] {
        let w = Workspace::new();
        let config = w.config(scenario, if scenario == "hang" { 300 } else { 10000 }, 1024);
        let start = std::time::Instant::now();
        let output = w.invoke(&config, "codex", &[]);
        assert!(!output.status.success(), "{scenario}");
        assert!(
            start.elapsed().as_secs() < 15,
            "{scenario} failed to finish promptly"
        );
        let state = w.state();
        assert_eq!(state["next_id"], 2);
        assert_eq!(state["history"]["chat"][1]["role"], "error");
        let lua = fs::read_to_string(w.0.join("data/outbox/WoWAI_S001/Inbox.lua")).unwrap();
        assert!(lua.contains("status = \"error\""));
        w.legacy_unchanged();
    }
}
#[test]
fn refuses_nonprivate_data_and_corrupt_state_without_overwriting() {
    let w = Workspace::new();
    let config = w.config("echo", 10000, 65536);
    fs::create_dir(w.0.join("data")).unwrap();
    fs::write(w.0.join("data/state.json"), "legacy").unwrap();
    assert!(!w.invoke(&config, "codex", &[]).status.success());
    assert_eq!(
        fs::read_to_string(w.0.join("data/state.json")).unwrap(),
        "legacy"
    );
    assert_eq!(fs::read_dir(w.0.join("data")).unwrap().count(), 1);
    assert!(!w.0.join("data/reforged-state.json").exists());
    fs::remove_file(w.0.join("data/state.json")).unwrap();
    assert!(w.invoke(&config, "codex", &[]).status.success());
    fs::write(w.0.join("data/reforged-state.json"), "broken JSON").unwrap();
    assert!(!w.invoke(&config, "codex", &[]).status.success());
    assert_eq!(
        fs::read_to_string(w.0.join("data/reforged-state.json")).unwrap(),
        "broken JSON"
    );
}
#[test]
fn self_test_needs_no_configuration_or_agent_installation() {
    let output = Command::new(BINARY).arg("self-test").output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let text = String::from_utf8(output.stdout).unwrap();
    assert_eq!(text.matches("PASS ").count(), 6);
    // Clean up the intentionally retained demo workspace after this automated test.
    let path = text
        .lines()
        .find_map(|l| l.strip_prefix("Workspace: "))
        .unwrap();
    fs::remove_dir_all(path).unwrap();
}
#[test]
fn strict_config_and_cli_errors_do_not_start_a_job() {
    let w = Workspace::new();
    let path = w.config("echo", 10000, 65536);
    let mut config: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    config["schema_version"] = json!(2);
    fs::write(&path, serde_json::to_vec(&config).unwrap()).unwrap();
    assert!(!w.invoke(&path, "codex", &[]).status.success());
    assert!(!w.0.join("data").exists());
    assert!(
        !Command::new(BINARY)
            .args(["inject", "--bogus"])
            .status()
            .unwrap()
            .success()
    );
}

#[test]
fn failed_completion_publication_recovers_without_reinvoking_agent() {
    let w = Workspace::new();
    let path = w.config("block-publish", 10000, 65536);
    let mut cfg: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    let target = w.0.join("data/outbox/WoWAI/Inbox.lua");
    cfg["agents"]["codex"]["launcher_args"] = json!([
        "__fixture-agent",
        "codex",
        "block-publish",
        "--block-path",
        target
    ]);
    fs::write(&path, serde_json::to_vec(&cfg).unwrap()).unwrap();
    let result = w.invoke(&path, "codex", &[]);
    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr).contains("use recover"));
    assert!(w.state()["pending"].is_object());
    assert!(!w.invoke(&path, "codex", &[]).status.success());
    assert_eq!(w.state()["next_id"], 2);
    fs::remove_dir(&target).unwrap();
    fs::write(&target, "old").unwrap();
    let result = Command::new(BINARY)
        .args(["recover", "--config"])
        .arg(&path)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(w.state()["pending"].is_null());
    assert_eq!(w.state()["next_id"], 2);
    assert!(
        fs::read_to_string(target)
            .unwrap()
            .contains("status = \"done\"")
    );
}
#[test]
fn original_agent_failure_survives_secondary_publication_failure() {
    let w = Workspace::new();
    let path = w.config("block-error", 10000, 65536);
    let mut cfg: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    let target = w.0.join("data/outbox/WoWAI/Inbox.lua");
    cfg["agents"]["codex"]["launcher_args"] = json!([
        "__fixture-agent",
        "codex",
        "block-error",
        "--block-path",
        target
    ]);
    fs::write(&path, serde_json::to_vec(&cfg).unwrap()).unwrap();
    let result = w.invoke(&path, "codex", &[]);
    let diagnostic = String::from_utf8_lossy(&result.stderr);
    assert!(diagnostic.contains("fake primary failure"), "{diagnostic}");
    assert!(
        diagnostic.contains("could not publish error"),
        "{diagnostic}"
    );
}
#[test]
fn timeout_stops_a_child_that_inherits_output_pipes() {
    let w = Workspace::new();
    let path = w.config("spawn-child", 1000, 65536);
    let heartbeat = w.0.join("heartbeat.txt");
    let mut cfg: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    cfg["agents"]["codex"]["launcher_args"] = json!([
        "__fixture-agent",
        "codex",
        "spawn-child",
        "--heartbeat-file",
        heartbeat
    ]);
    fs::write(&path, serde_json::to_vec(&cfg).unwrap()).unwrap();
    let started = std::time::Instant::now();
    let result = w.invoke(&path, "codex", &[]);
    assert!(!result.status.success());
    assert!(started.elapsed().as_secs() < 8);
    let diagnostic = String::from_utf8_lossy(&result.stderr);
    assert!(!diagnostic.contains("did not settle"), "{diagnostic}");
    let before = fs::read(&heartbeat).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(150));
    assert_eq!(fs::read(&heartbeat).unwrap(), before);
}

#[test]
fn hermes_stderr_session_resumes_on_next_invocation() {
    let w = Workspace::new();
    let config = w.config("echo", 10000, 65536);
    assert!(w.invoke(&config, "hermes", &[]).status.success());
    let output = w.invoke(&config, "hermes", &[]);
    assert!(output.status.success());
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(
        result["text"]
            .as_str()
            .unwrap()
            .contains("resume=fake-hermes-session")
    );
}

#[test]
fn oversized_provider_metadata_is_rejected_before_accepting_a_result() {
    let w = Workspace::new();
    let config = w.config("oversized-metadata", 10000, 65536);
    let result = w.invoke(&config, "codex", &[]);
    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr).contains("metadata exceeds supported bounds"));
    let state = w.state();
    assert!(state["pending"].is_null());
    assert!(state["sessions"]["chat"].is_null());
    assert_eq!(state["history"]["chat"][1]["role"], "error");
    assert!(
        fs::metadata(w.0.join("data/reforged-state.json"))
            .unwrap()
            .len()
            < 65536
    );
}

#[test]
fn process_ticks_continue_while_an_agent_is_running() {
    use std::{ffi::OsString, time::Duration};
    let w = Workspace::new();
    let mut ticks = 0;
    let args: Vec<OsString> = ["__fixture-agent", "codex", "hang"]
        .into_iter()
        .map(Into::into)
        .collect();
    let result = wow_ai_reforged::process::run_with_tick(
        wow_ai_reforged::process::Request {
            program: Path::new(BINARY),
            args: &args,
            cwd: &w.0,
            input: None,
            env: &[],
            timeout: Duration::from_millis(100),
            max_output: 1024,
        },
        || {
            ticks += 1;
            Ok(())
        },
    );
    assert!(result.is_err());
    assert!(ticks > 0);
}
