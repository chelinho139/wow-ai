use std::{
    fs,
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};
use wow_ai_reforged::install;
static SEQUENCE: AtomicU64 = AtomicU64::new(0);
struct Client(PathBuf);
impl Client {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "reforged install é {} {}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        fs::write(path.join("Wow.exe"), b"fake client for tests").unwrap();
        Self(path)
    }
    fn addons(&self) -> PathBuf {
        self.0.join("Interface/AddOns")
    }
}
impl Drop for Client {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
#[test]
fn embedded_setup_and_rerun_preserve_runtime_data_and_other_addons() {
    let client = Client::new();
    let other = client.addons().join("OtherAddon");
    fs::create_dir_all(&other).unwrap();
    fs::write(other.join("Other.lua"), b"keep other addon").unwrap();
    let report = install::install(&client.0).unwrap();
    assert_eq!(report.created, 14809);
    assert_eq!(report.preserved, 0);
    assert_eq!(
        fs::read(client.addons().join("WoWAI/WoWAI.lua")).unwrap(),
        include_bytes!("../../../addon/WoWAI/WoWAI.lua")
    );
    assert_eq!(
        fs::read(client.addons().join("WoWAI/ctl/valid.wav")).unwrap(),
        wow_ai_reforged::signals::silent_wav()
    );
    assert!(client.addons().join("WoWAI_S200/WoWAI_S200.toc").is_file());
    assert!(client.addons().join("WoWAI/act/200/60.wav").is_file());
    assert!(client.addons().join("WoWAI/presence/2000.wav").is_file());
    let inbox = client.addons().join("WoWAI/Inbox.lua");
    let signal = client.addons().join("WoWAI/ack/001.wav");
    fs::write(&inbox, b"legacy reply").unwrap();
    fs::write(&signal, b"already raised").unwrap();
    let rerun = install::install(&client.0).unwrap();
    assert_eq!(rerun.created, 0);
    assert_eq!(rerun.preserved, 14809);
    assert_eq!(fs::read(inbox).unwrap(), b"legacy reply");
    assert_eq!(fs::read(signal).unwrap(), b"already raised");
    assert_eq!(
        fs::read(other.join("Other.lua")).unwrap(),
        b"keep other addon"
    );
    // Resume an interrupted install by adding only the missing file.
    fs::remove_file(client.addons().join("WoWAI/presence/2000.wav")).unwrap();
    let rerun = install::install(&client.0).unwrap();
    assert_eq!(rerun.created, 1);
}
#[test]
fn differing_static_asset_fails_before_modifying_the_tree() {
    let client = Client::new();
    let folder = client.addons().join("WoWAI");
    fs::create_dir_all(&folder).unwrap();
    fs::write(folder.join("WoWAI.lua"), b"custom addon").unwrap();
    assert!(install::install(&client.0).is_err());
    assert_eq!(fs::read(folder.join("WoWAI.lua")).unwrap(), b"custom addon");
    assert_eq!(fs::read_dir(&folder).unwrap().count(), 1);
    assert_eq!(fs::read_dir(client.addons()).unwrap().count(), 1);
}
#[test]
fn wrong_client_and_non_directory_components_fail_without_installing() {
    let client = Client::new();
    fs::remove_file(client.0.join("Wow.exe")).unwrap();
    assert!(install::install(&client.0).is_err());
    assert!(!client.0.join("Interface").exists());
    fs::write(client.0.join("Wow.exe"), b"fake").unwrap();
    fs::write(client.0.join("Interface"), b"keep file").unwrap();
    assert!(install::install(&client.0).is_err());
    assert_eq!(fs::read(client.0.join("Interface")).unwrap(), b"keep file");
}
#[cfg(unix)]
#[test]
fn rejects_linked_output_directories_and_files_without_writing_targets() {
    use std::os::unix::fs::symlink;
    let client = Client::new();
    let external = Client::new();
    fs::create_dir(client.0.join("Interface")).unwrap();
    symlink(&external.0, client.0.join("Interface/AddOns")).unwrap();
    assert!(install::install(&client.0).is_err());
    assert_eq!(fs::read_dir(&external.0).unwrap().count(), 1);
    fs::remove_file(client.0.join("Interface/AddOns")).unwrap();
    fs::create_dir_all(client.addons().join("WoWAI")).unwrap();
    let source = external.0.join("original.lua");
    fs::write(&source, b"keep external").unwrap();
    symlink(&source, client.addons().join("WoWAI/Inbox.lua")).unwrap();
    assert!(install::install(&client.0).is_err());
    assert_eq!(fs::read(source).unwrap(), b"keep external");
    assert_eq!(
        fs::read_dir(client.addons().join("WoWAI")).unwrap().count(),
        1
    );
}
#[test]
fn setup_creates_and_preserves_starter_config() {
    let client = Client::new();
    let config_path = client.0.join("test-config.json");
    let binary = env!("CARGO_BIN_EXE_wow-ai-reforged");

    // First setup run: creates starter config
    let output = Command::new(binary)
        .args([
            "setup",
            "--wow",
            client.0.to_str().unwrap(),
            "--config",
            config_path.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert!(output.status.success());
    assert!(config_path.is_file());
    let content = fs::read_to_string(&config_path).unwrap();
    assert!(content.contains("\"schema_version\": 1"));
    assert!(content.contains("Interface/AddOns"));

    // Modify config and rerun setup: must preserve customized config!
    let mut custom: serde_json::Value = serde_json::from_str(&content).unwrap();
    custom["timeout_ms"] = serde_json::json!(12345);
    let custom = serde_json::to_vec_pretty(&custom).unwrap();
    fs::write(&config_path, &custom).unwrap();
    let rerun = Command::new(binary)
        .args([
            "setup",
            "--wow",
            client.0.to_str().unwrap(),
            "--config",
            config_path.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert!(rerun.status.success());
    assert_eq!(fs::read(&config_path).unwrap(), custom);
}
#[test]
fn setup_cli_rejects_missing_or_extra_arguments() {
    let binary = env!("CARGO_BIN_EXE_wow-ai-reforged");
    for args in [
        vec!["setup"],
        vec!["setup", "--wow"],
        vec!["setup", "--wow", "missing", "--force"],
    ] {
        assert!(
            !Command::new(binary)
                .args(args)
                .output()
                .unwrap()
                .status
                .success()
        );
    }
}

#[test]
fn explicit_update_backs_up_static_assets_and_preserves_runtime() {
    let client = Client::new();
    install::install(&client.0).unwrap();
    let addon = client.addons().join("WoWAI/WoWAI.lua");
    let inbox = client.addons().join("WoWAI/Inbox.lua");
    let signal = client.addons().join("WoWAI/ack/001.wav");
    fs::write(&addon, b"previous addon version").unwrap();
    fs::write(&inbox, b"keep replies").unwrap();
    fs::write(&signal, b"keep signal").unwrap();
    let report = install::update(&client.0).unwrap();
    assert_eq!(report.updated, 1);
    assert_eq!(report.created, 0);
    assert_eq!(report.preserved, 14808);
    let backup = report.backup_dir.unwrap();
    assert_eq!(
        fs::read(backup.join("WoWAI/WoWAI.lua")).unwrap(),
        b"previous addon version"
    );
    assert_eq!(
        fs::read(&addon).unwrap(),
        include_bytes!("../../../addon/WoWAI/WoWAI.lua")
    );
    assert_eq!(fs::read(inbox).unwrap(), b"keep replies");
    assert_eq!(fs::read(signal).unwrap(), b"keep signal");
    let rerun = install::update(&client.0).unwrap();
    assert_eq!(rerun.updated, 0);
    assert!(rerun.backup_dir.is_none());
}

#[test]
fn setup_reports_configuration_failures_and_supports_addon_only_mode() {
    let client = Client::new();
    let binary = env!("CARGO_BIN_EXE_wow-ai-reforged");
    let config = client.0.join("missing/config.json");
    let setup = |path: &std::path::Path, no_config: bool| {
        let mut command = Command::new(binary);
        command.args([
            "setup",
            "--wow",
            client.0.to_str().unwrap(),
            "--config",
            path.to_str().unwrap(),
        ]);
        if no_config {
            command.arg("--no-config");
        }
        command.output().unwrap()
    };
    let missing = setup(&config, false);
    assert!(!missing.status.success());
    assert!(!config.exists());
    assert!(String::from_utf8_lossy(&missing.stderr).contains("configuration"));
    assert!(!String::from_utf8_lossy(&missing.stdout).contains("Setup completed."));
    let invalid = client.0.join("invalid.json");
    fs::write(&invalid, b"invalid config").unwrap();
    assert!(!setup(&invalid, false).status.success());
    assert_eq!(fs::read(&invalid).unwrap(), b"invalid config");
    assert!(!setup(&client.0, false).status.success());
    let addon_only = setup(&config, true);
    assert!(addon_only.status.success());
    let stdout = String::from_utf8_lossy(&addon_only.stdout);
    assert!(stdout.contains("Addon-only setup completed"));
    assert!(!stdout.contains("run --config"));
}
