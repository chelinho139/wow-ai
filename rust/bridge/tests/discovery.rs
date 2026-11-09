use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};
use wow_ai_reforged::{
    agents::{AgentKind, AgentSettings},
    discovery::{self, Environment},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Tree(PathBuf);
impl Tree {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!(
            "reforged discovery é {} {}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&p).unwrap();
        Self(p)
    }
    fn file(&self, relative: &str, body: &[u8]) -> PathBuf {
        let p = self.0.join(relative);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(&p, body).unwrap();
        p
    }
    fn context(&self) -> Environment {
        Environment {
            windows: true,
            arm64: false,
            paths: vec![self.0.join("bin")],
            home: Some(self.0.join("home")),
            appdata: Some(self.0.join("appdata")),
            local_appdata: Some(self.0.join("local")),
            codex_bin: None,
            grok_home: None,
        }
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
#[test]
fn finds_all_six_agents_on_windows_path_without_running_them() {
    let tree = Tree::new();
    let context = tree.context();
    for kind in discovery::AGENTS {
        let exe = tree.file(
            &format!("bin/{}.exe", kind.id()),
            b"not executable, must not be run during detection",
        );
        let result =
            discovery::resolve(kind, &AgentSettings::default(), &tree.0, &context).unwrap();
        assert_eq!(result.executable, exe.canonicalize().unwrap());
        assert!(result.launcher_args.is_empty());
    }
}
#[test]
fn explicit_override_wins_and_an_invalid_override_does_not_fall_back() {
    let tree = Tree::new();
    tree.file("bin/codex.exe", b"PATH");
    let explicit = tree.file("chosen.exe", b"explicit");
    let settings = AgentSettings {
        executable: PathBuf::from("chosen.exe"),
        launcher_args: vec!["custom-prefix".into()],
        ..Default::default()
    };
    let result = discovery::resolve(AgentKind::Codex, &settings, &tree.0, &tree.context()).unwrap();
    assert_eq!(result.executable, explicit.canonicalize().unwrap());
    assert_eq!(result.launcher_args, ["custom-prefix"]);
    let bad = AgentSettings {
        executable: PathBuf::from("missing.exe"),
        ..Default::default()
    };
    assert!(discovery::resolve(AgentKind::Codex, &bad, &tree.0, &tree.context()).is_err());
}
#[test]
fn codex_env_and_known_install_locations_are_detected() {
    let tree = Tree::new();
    let mut context = tree.context();
    let override_path = tree.file("env/codex.exe", b"env");
    tree.file("bin/codex.exe", b"PATH");
    context.codex_bin = Some(override_path.clone());
    assert_eq!(
        discovery::resolve(
            AgentKind::Codex,
            &AgentSettings::default(),
            &tree.0,
            &context
        )
        .unwrap()
        .executable,
        override_path.canonicalize().unwrap()
    );
    context.codex_bin = None;
    let standalone = tree.file("local/Programs/OpenAI/Codex/bin/codex.exe", b"native");
    assert_eq!(
        discovery::resolve(
            AgentKind::Codex,
            &AgentSettings::default(),
            &tree.0,
            &context
        )
        .unwrap()
        .executable,
        standalone.canonicalize().unwrap()
    );
    tree.file("home/.local/bin/claude.exe", b"claude");
    tree.file("home/.grok/bin/grok.exe", b"grok");
    tree.file("local/agy/bin/agy.exe", b"agy");
    for kind in [AgentKind::Claude, AgentKind::Grok, AgentKind::Agy] {
        assert!(discovery::resolve(kind, &AgentSettings::default(), &tree.0, &context).is_ok());
    }
}
#[test]
fn npm_codex_shim_prefers_native_binary_for_both_architectures_without_node() {
    for arm in [false, true] {
        let tree = Tree::new();
        let mut context = tree.context();
        context.arm64 = arm;
        tree.file("appdata/npm/codex.cmd",b"@echo off\r\n\"%dp0%\\node.exe\" \"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js\" %*\r\necho must-not-run\r\n");
        tree.file(
            "appdata/npm/node_modules/@openai/codex/bin/codex.js",
            b"// JS entry point",
        );
        let arch = if arm { "arm64" } else { "x64" };
        let triple = if arm {
            "aarch64-pc-windows-msvc"
        } else {
            "x86_64-pc-windows-msvc"
        };
        let exe=tree.file(&format!("appdata/npm/node_modules/@openai/codex-win32-{arch}/vendor/{triple}/codex/codex.exe"),b"native");
        let result = discovery::resolve(
            AgentKind::Codex,
            &AgentSettings::default(),
            &tree.0,
            &context,
        )
        .unwrap();
        assert_eq!(result.executable, exe.canonicalize().unwrap());
        assert!(result.launcher_args.is_empty());
    }
}
#[test]
fn npm_js_wrappers_use_node_and_keep_paths_with_spaces_as_single_arguments() {
    let tree = Tree::new();
    let context = tree.context();
    let shim = tree.file(
        "appdata/npm/gemini.cmd",
        b"\"%~dp0\\node.exe\" \"%~dp0\\node_modules\\gemini package\\entry.js\" %*\n",
    );
    let script = tree.file("appdata/npm/node_modules/gemini package/entry.js", b"// JS");
    assert!(
        discovery::resolve(
            AgentKind::Gemini,
            &AgentSettings::default(),
            &tree.0,
            &context
        )
        .is_err()
    );
    let node = tree.file("appdata/npm/node.exe", b"native node");
    let result = discovery::resolve(
        AgentKind::Gemini,
        &AgentSettings {
            executable: shim,
            ..Default::default()
        },
        &tree.0,
        &context,
    )
    .unwrap();
    assert_eq!(result.executable, node.canonicalize().unwrap());
    assert_eq!(
        result.launcher_args,
        [script.canonicalize().unwrap().to_string_lossy()]
    );
}
#[test]
fn missing_agents_have_install_guidance_and_report_does_not_mutate_config() {
    let tree = Tree::new();
    let report = discovery::report(&BTreeMap::new(), &tree.0, &tree.context());
    assert_eq!(report.len(), 6);
    assert!(
        report
            .iter()
            .all(|r| !r.found && r.note.contains("Install"))
    );
    let exe = env!("CARGO_BIN_EXE_wow-ai-reforged");
    let path = tree.file(
        "config.json",
        serde_json::to_string(&serde_json::json!({"agents":{"codex":{"executable":exe}}}))
            .unwrap()
            .as_bytes(),
    );
    let original = fs::read(&path).unwrap();
    let result = Command::new(exe)
        .args(["agents", "--config"])
        .arg(&path)
        .output()
        .unwrap();
    assert!(result.status.success());
    let report: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(
        report
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["agent"] == "codex")
            .unwrap()["found"],
        true
    );
    assert_eq!(fs::read(path).unwrap(), original);
}
#[test]
fn supports_posix_path_and_explicit_javascript_entry_points() {
    let tree = Tree::new();
    let mut context = tree.context();
    context.windows = false;
    let program = tree.file("bin/hermes", b"#!/bin/sh\n");
    let result = discovery::resolve(
        AgentKind::Hermes,
        &AgentSettings::default(),
        &tree.0,
        &context,
    )
    .unwrap();
    assert_eq!(result.executable, program.canonicalize().unwrap());
    let node = tree.file("bin/node", b"node");
    let script = tree.file("some cli.mjs", b"// JS");
    let result = discovery::resolve(
        AgentKind::Gemini,
        &AgentSettings {
            executable: script.clone(),
            ..Default::default()
        },
        Path::new("/"),
        &context,
    )
    .unwrap();
    assert_eq!(result.executable, node.canonicalize().unwrap());
    assert_eq!(result.launcher_args.len(), 1);
}

#[test]
fn config_startup_uses_codex_bin_when_executable_is_omitted() {
    let tree = Tree::new();
    let path=tree.file("auto-config.json",serde_json::to_string(&serde_json::json!({
        "schema_version":1,"project_dir":tree.0,"data_dir":tree.0.join("data"),"agent":"codex","agents":{"codex":{}}
    })).unwrap().as_bytes());
    let fake = tree.file("detected-agent.exe", b"not executed by run --once");
    let result = Command::new(env!("CARGO_BIN_EXE_wow-ai-reforged"))
        .args(["run", "--config"])
        .arg(&path)
        .arg("--once")
        .env("CODEX_BIN", &fake)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(String::from_utf8_lossy(&result.stdout).contains("detected-agent.exe"));
}
