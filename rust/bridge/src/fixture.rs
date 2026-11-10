//! Explicit development-only fake agent used by self-test. Never authenticates or
//! invokes an actual agent; every generated reply is labeled as fake.
use serde_json::json;
use std::io::{self, Read, Write};

pub fn run(args: &[String]) -> Result<(), String> {
    let kind = args.first().ok_or("missing fake agent format")?;
    let scenario = args.get(1).ok_or("missing fake scenario")?;
    let arguments = &args[2..];
    let option = |name: &str| {
        arguments
            .windows(2)
            .find(|pair| pair[0] == name)
            .map(|pair| pair[1].clone())
    };
    if scenario == "spawn-child" {
        let file = option("--heartbeat-file").ok_or("missing heartbeat file")?;
        let mut child =
            std::process::Command::new(std::env::current_exe().map_err(|e| e.to_string())?)
                .args([
                    "__fixture-agent",
                    kind,
                    "child-heartbeat",
                    "--heartbeat-file",
                    &file,
                ])
                .spawn()
                .map_err(|e| e.to_string())?;
        if let Some(path) = option("--pid-file") {
            crate::publication::atomic_write(
                std::path::Path::new(&path),
                format!("{} {}", std::process::id(), child.id()).as_bytes(),
            )
            .map_err(|e| e.to_string())?;
        }
        let _ = child.wait();
        return Ok(());
    }
    if scenario == "child-heartbeat" {
        let file = option("--heartbeat-file").ok_or("missing heartbeat file")?;
        for n in 0..3000 {
            std::fs::write(&file, n.to_string()).map_err(|e| e.to_string())?;
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        return Ok(());
    }
    if scenario == "record-cwd" || scenario == "record-cwd-error" {
        let file = option("--record-path").ok_or("missing cwd record path")?;
        let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
        std::fs::write(file, cwd.to_string_lossy().as_bytes()).map_err(|e| e.to_string())?;
    }
    if scenario == "record-cwd-error" {
        return Err("fake recorded failure".into());
    }
    if scenario == "block-publish" || scenario == "block-error" {
        let path = option("--block-path").ok_or("missing fake blocking path")?;
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
        std::fs::create_dir(&path).map_err(|e| e.to_string())?;
        if scenario == "block-error" {
            println!(
                "{}",
                json!({"type":"error","message":"fake primary failure"})
            );
            return Ok(());
        }
    }
    if scenario == "hang" {
        std::thread::sleep(std::time::Duration::from_secs(60));
        return Ok(());
    }
    if scenario == "large-error" {
        io::stderr()
            .write_all("é".repeat(100_000).as_bytes())
            .map_err(|e| e.to_string())?;
        return Err("fake large failure".into());
    }
    if scenario == "flood" {
        loop {
            if io::stdout().write_all(&[b'x'; 4096]).is_err() {
                return Ok(());
            }
        }
    }
    if scenario == "exit" {
        return Err("fake agent failed".into());
    }
    if scenario == "malformed" {
        println!("not JSON");
        return Ok(());
    }
    if scenario == "model-error" {
        println!(
            "{}",
            json!({"type":"error", "message":"fake model failure"})
        );
        return Ok(());
    }
    let prompt = if let Some(path) = option("--prompt-file") {
        std::fs::read_to_string(path).map_err(|e| e.to_string())?
    } else if let Some(prompt) = option("--prompt") {
        prompt
    } else if let Some(prompt) = arguments.iter().find_map(|arg| arg.strip_prefix("-p=")) {
        prompt.into()
    } else {
        let mut prompt = String::new();
        io::stdin()
            .read_to_string(&mut prompt)
            .map_err(|e| e.to_string())?;
        prompt
    };
    let resume = option("--resume")
        .or_else(|| option("-r"))
        .or_else(|| option("--conversation"))
        .or_else(|| {
            arguments
                .windows(2)
                .find(|a| a[0] == "resume")
                .map(|a| a[1].clone())
        });
    let reply = format!(
        "Fake {kind} reply: {prompt}{}",
        resume.map(|s| format!(" [resume={s}]")).unwrap_or_default()
    );
    let session = if scenario == "oversized-metadata" {
        "x".repeat(8192)
    } else {
        format!("fake-{kind}-session")
    };
    match kind.as_str() {
        "claude" => println!(
            "{}",
            json!({"type":"result", "result":reply,"session_id":session,"is_error":false})
        ),
        "codex" => {
            println!("{}", json!({"type":"thread.started","thread_id":session}));
            println!(
                "{}",
                json!({"type":"item.completed","item":{"type":"agent_message","text":reply}})
            );
            println!("{}", json!({"type":"turn.completed"}));
        }
        "grok" => {
            println!("{}", json!({"type":"text","data":reply}));
            println!(
                "{}",
                json!({"type":"end","sessionId":session,"stopReason":"end_turn"})
            );
        }
        "agy" => {
            println!("{}", json!({"event":"init","conversation_id":session}));
            println!(
                "{}",
                json!({"event":"result","result":{"status":"SUCCESS","response":reply},"conversation_id":session})
            );
        }
        "gemini" => {
            println!("{}", json!({"type":"init","session_id":session}));
            println!(
                "{}",
                json!({"type":"message","role":"assistant","content":reply,"delta":true})
            );
            println!("{}", json!({"type":"result","status":"success"}));
        }
        "hermes" => {
            eprintln!("session_id: {session}");
            println!("{reply}");
        }
        _ => return Err("unknown fake agent format".into()),
    }
    Ok(())
}
