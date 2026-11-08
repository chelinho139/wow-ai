use std::{
    collections::BTreeMap,
    env, fs,
    path::{Path, PathBuf},
    process::ExitCode,
    time::{SystemTime, UNIX_EPOCH},
};
use wow_ai_reforged::{agents::AgentKind, config::Config, runtime};

const HELP: &str = "WoW AI Reforged — Rust backend (in development)\n\nUsage:\n  wow-ai-reforged self-test\n  wow-ai-reforged setup --wow <client-directory>\n  wow-ai-reforged run --config <file.json> [--wow <client-directory>] [--once]\n  wow-ai-reforged inject --config <file.json> --prompt <text> [--agent <id>] [--chat <id>] [--fresh-session]\n  wow-ai-reforged recover --config <file.json>\n  wow-ai-reforged --help | --version\n\nAgents: claude, codex, grok, agy, hermes, gemini\n\nself-test runs fake agents in a new temporary workspace; no login or game needed.\nsetup extracts embedded addon files and reply slots into your World of Warcraft client.\nrun connects live screen capture to the game addon and agent execution loop.\ninject runs a configured agent and writes replies to its private Rust outbox.\nrecover republishes a completed reply if publication was previously interrupted.\n";

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
        [arg] if arg == "--help" || arg == "-h" => {
            println!("{HELP}");
            Ok(())
        }
        [arg] if arg == "--version" || arg == "-V" => {
            println!("wow-ai-reforged {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        [arg] if arg == "self-test" => self_test(),
        [command, rest @ ..] if command == "setup" => setup_command(rest),
        [command, rest @ ..] if command == "__fixture-agent" => wow_ai_reforged::fixture::run(rest),
        [command, rest @ ..] if command == "run" => run_bridge(rest),
        [command, rest @ ..] if command == "inject" => inject(rest),
        [command, flag, config] if command == "recover" && flag == "--config" => {
            let cfg = Config::load(Path::new(config)).map_err(|e| e.to_string())?;
            let result = runtime::recover(&cfg).map_err(|e| e.to_string())?;
            println!(
                "{}",
                serde_json::to_string_pretty(&result).map_err(|e| e.to_string())?
            );
            Ok(())
        }
        [] => Err("Choose self-test, setup, run, or inject. Use --help for usage.".into()),
        _ => Err("Unknown arguments. Use --help for usage.".into()),
    }
}
fn setup_command(args: &[String]) -> Result<(), String> {
    let mut wow_client: Option<&str> = None;
    let mut config_path = PathBuf::from("config.json");
    let mut skip_config = false;
    let mut cursor = 0;
    while cursor < args.len() {
        match args[cursor].as_str() {
            "--wow" => {
                cursor += 1;
                wow_client = Some(args.get(cursor).ok_or("missing value for --wow")?);
            }
            "--config" => {
                cursor += 1;
                let val = args.get(cursor).ok_or("missing value for --config")?;
                config_path = PathBuf::from(val);
            }
            "--no-config" => {
                skip_config = true;
            }
            unknown => return Err(format!("unknown option for setup: {unknown}")),
        }
        cursor += 1;
    }
    let wow_client = wow_client.ok_or("--wow <client-directory> is required")?;
    let report =
        wow_ai_reforged::install::install(Path::new(wow_client)).map_err(|e| e.to_string())?;
    println!(
        "{}",
        serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?
    );

    if !skip_config {
        match wow_ai_reforged::install::init_starter_config(&config_path, &report.addons_dir) {
            Ok(true) => println!(
                "Created starter {} with your addon path. Edit it to set your agent executable path.",
                config_path.display()
            ),
            Ok(false) => println!("Existing {} was preserved.", config_path.display()),
            Err(e) => eprintln!("Could not create {}: {e}", config_path.display()),
        }
    }

    println!(
        "Setup completed. Fully quit and relaunch WoW to discover the addon files. Use 'wow-ai-reforged run --config {}' to start the live bridge.",
        config_path.display()
    );
    Ok(())
}
fn run_bridge(args: &[String]) -> Result<(), String> {
    let mut config_path: Option<&str> = None;
    let mut wow_dir: Option<PathBuf> = None;
    let mut once = false;
    let mut cursor = 0;
    while cursor < args.len() {
        match args[cursor].as_str() {
            "--config" => {
                cursor += 1;
                config_path = Some(args.get(cursor).ok_or("missing value for --config")?);
            }
            "--wow" => {
                cursor += 1;
                let val = args.get(cursor).ok_or("missing value for --wow")?;
                wow_dir = Some(PathBuf::from(val));
            }
            "--once" => {
                once = true;
            }
            unknown => return Err(format!("unknown option: {unknown}")),
        }
        cursor += 1;
    }
    let config_path = config_path.ok_or("--config <file.json> is required")?;
    let cfg = Config::load(Path::new(config_path)).map_err(|e| e.to_string())?;
    wow_ai_reforged::live::run(&cfg, wow_ai_reforged::live::BridgeOptions { once, wow_dir })
        .map_err(|e| e.to_string())
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
