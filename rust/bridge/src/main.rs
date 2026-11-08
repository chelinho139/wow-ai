use std::{
    collections::BTreeMap,
    env, fs,
    path::{Path, PathBuf},
    process::ExitCode,
    time::{SystemTime, UNIX_EPOCH},
};
use wow_ai_reforged::{agents::AgentKind, config::Config, runtime};

const HELP: &str = "WoW AI Reforged — Rust backend (in development)\n\nUsage:\n  wow-ai-reforged self-test\n  wow-ai-reforged inject --config <file.json> --prompt <text> [--agent <id>] [--chat <id>] [--fresh-session]\n  wow-ai-reforged recover --config <file.json>\n  wow-ai-reforged --help | --version\n\nAgents: claude, codex, grok, agy, hermes, gemini\n\nself-test runs fake agents in a new temporary workspace; no login or game needed.\ninject runs a configured agent and writes replies to its private Rust outbox.\nLive game capture is not connected yet. Use npm start for legacy live chat.";

fn main() -> ExitCode {
    match execute(env::args().skip(1).collect()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}
fn execute(args: Vec<String>) -> Result<(), String> {
    match args.as_slice() {
        [arg] if arg == "--help" || arg == "-h" => { println!("{HELP}"); Ok(()) }
        [arg] if arg == "--version" || arg == "-V" => { println!("wow-ai-reforged {}", env!("CARGO_PKG_VERSION")); Ok(()) }
        [arg] if arg == "self-test" => self_test(),
        [command, rest @ ..] if command == "__fixture-agent" => wow_ai_reforged::fixture::run(rest),
        [command, rest @ ..] if command == "inject" => inject(rest),
        [command, flag, config] if command == "recover" && flag == "--config" => {
            let cfg = Config::load(Path::new(config)).map_err(|e| e.to_string())?;
            let result = runtime::recover(&cfg).map_err(|e| e.to_string())?;
            println!("{}", serde_json::to_string_pretty(&result).map_err(|e| e.to_string())?); Ok(())
        },
        [] => Err("Choose self-test or inject. Live WoW capture is not connected yet. Use --help for usage.".into()),
        _ => Err("Unknown arguments. Use --help for usage.".into()),
    }
}
fn inject(args: &[String]) -> Result<(), String> {
    let mut options = BTreeMap::new();
    let mut fresh = false;
    let mut i = 0;
    while i < args.len() {
        let key = &args[i];
        if key == "--fresh-session" {
            if fresh {
                return Err("duplicate --fresh-session".into());
            }
            fresh = true;
            i += 1;
            continue;
        }
        if !["--config", "--prompt", "--agent", "--chat"].contains(&key.as_str()) {
            return Err(format!("unknown argument {key}"));
        }
        let value = args
            .get(i + 1)
            .ok_or_else(|| format!("missing value for {key}"))?;
        if options.insert(key.as_str(), value.as_str()).is_some() {
            return Err(format!("duplicate {key}"));
        }
        i += 2;
    }
    let config = options.get("--config").ok_or("--config is required")?;
    let prompt = options.get("--prompt").ok_or("--prompt is required")?;
    let cfg = Config::load(Path::new(config)).map_err(|e| e.to_string())?;
    let kind = options
        .get("--agent")
        .map(|name| AgentKind::parse_name(name))
        .transpose()?
        .unwrap_or(cfg.agent);
    let result = runtime::inject(
        &cfg,
        kind,
        options.get("--chat").copied().unwrap_or("default"),
        prompt,
        fresh,
    )
    .map_err(|e| e.to_string())?;
    println!(
        "{}",
        serde_json::to_string_pretty(&result).map_err(|e| e.to_string())?
    );
    Ok(())
}
fn self_test() -> Result<(), String> {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let root: PathBuf = env::temp_dir().join(format!(
        "wow-ai-reforged-demo-{}-{unique}",
        std::process::id()
    ));
    fs::create_dir(&root).map_err(|e| e.to_string())?;
    let executable = env::current_exe().map_err(|e| e.to_string())?;
    let mut agents = serde_json::Map::new();
    for kind in ["claude", "codex", "grok", "agy", "hermes", "gemini"] {
        agents.insert(kind.into(), serde_json::json!({"executable":executable, "launcher_args":["__fixture-agent",kind,"echo"]}));
    }
    let config = serde_json::json!({"schema_version":1,"project_dir":root,"data_dir":root.join("data"),"agent":"codex","timeout_ms":10000,"agents":agents});
    let path = root.join("demo-config.json");
    fs::write(&path, serde_json::to_vec_pretty(&config).unwrap()).map_err(|e| e.to_string())?;
    let cfg = Config::load(&path).map_err(|e| e.to_string())?;
    for name in ["claude", "codex", "grok", "agy", "hermes", "gemini"] {
        let result = runtime::inject(
            &cfg,
            AgentKind::parse_name(name)?,
            name,
            "Hello from the Rust pipeline",
            false,
        )
        .map_err(|e| e.to_string())?;
        if !result.text.starts_with("Fake ") {
            return Err("self-test returned an unexpected response".into());
        }
        println!("PASS {name}: {}", result.text);
    }
    println!(
        "Self-test passed for all six fake agents. No real model was contacted.\nWorkspace: {}\nReply file: {}",
        root.display(),
        root.join("data/outbox/WoWAI_S001/Inbox.lua").display()
    );
    Ok(())
}
