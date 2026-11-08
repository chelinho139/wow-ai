use std::{
    fs,
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};

static SEQUENCE: AtomicU64 = AtomicU64::new(0);

struct TestEnv {
    dir: PathBuf,
    config: PathBuf,
}

impl TestEnv {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "reforged-live-test-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).unwrap();
        let project = dir.join("project");
        let data = dir.join("data");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(&data).unwrap();

        let config = dir.join("config.json");
        let fake_exe = dir.join("fake-agent");
        fs::write(&fake_exe, b"fake").unwrap();

        let json = format!(
            r#"{{
  "schema_version": 1,
  "project_dir": "{}",
  "data_dir": "{}",
  "agent": "codex",
  "agents": {{
    "codex": {{
      "executable": "{}"
    }}
  }}
}}"#,
            project.display().to_string().replace('\\', "/"),
            data.display().to_string().replace('\\', "/"),
            fake_exe.display().to_string().replace('\\', "/")
        );
        fs::write(&config, json).unwrap();
        Self { dir, config }
    }
}

impl Drop for TestEnv {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

#[test]
fn run_once_initializes_and_exits_cleanly() {
    let env = TestEnv::new();
    let binary = env!("CARGO_BIN_EXE_wow-ai-reforged");
    let output = Command::new(binary)
        .args(["run", "--config", env.config.to_str().unwrap(), "--once"])
        .output()
        .unwrap();

    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(output.status.success(), "run --once failed: {stdout}");
    assert!(stdout.contains("WoW AI Reforged — Live Bridge"));
    assert!(stdout.contains("agent    : codex"));
}

#[test]
fn run_requires_config_and_rejects_missing_values() {
    let binary = env!("CARGO_BIN_EXE_wow-ai-reforged");
    let missing_cfg = Command::new(binary).args(["run"]).output().unwrap();
    assert!(!missing_cfg.status.success());

    let missing_val = Command::new(binary)
        .args(["run", "--config"])
        .output()
        .unwrap();
    assert!(!missing_val.status.success());
}

#[test]
fn run_with_wow_validates_addons_directory() {
    let env = TestEnv::new();
    let binary = env!("CARGO_BIN_EXE_wow-ai-reforged");

    let fake_wow = env.dir.join("fake_wow");
    fs::create_dir_all(&fake_wow).unwrap();
    fs::write(fake_wow.join("Wow.exe"), b"fake").unwrap();

    // Before setup: Interface/AddOns does not exist
    let output_before = Command::new(binary)
        .args([
            "run",
            "--config",
            env.config.to_str().unwrap(),
            "--wow",
            fake_wow.to_str().unwrap(),
            "--once",
        ])
        .output()
        .unwrap();
    assert!(!output_before.status.success());
    let stderr = String::from_utf8_lossy(&output_before.stderr);
    assert!(stderr.contains("Addons directory does not exist"));

    // Now install addons via setup
    let setup = Command::new(binary)
        .args(["setup", "--wow", fake_wow.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(setup.status.success());

    // After setup: run --once should succeed with addons attached!
    let output_after = Command::new(binary)
        .args([
            "run",
            "--config",
            env.config.to_str().unwrap(),
            "--wow",
            fake_wow.to_str().unwrap(),
            "--once",
        ])
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&output_after.stdout);
    assert!(output_after.status.success(), "failed: {stdout}");
    assert!(stdout.contains("addons   :"));
}
