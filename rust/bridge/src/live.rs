//! Live bridge runtime connecting native screen capture to agent execution
//! and addon slot/signal publication.

use crate::{
    agents::{self, AgentKind},
    capture::{CaptureEvent, CaptureSession, CaptureTarget},
    config::Config,
    ownership::OwnershipGuard,
    process,
    protocol::{self, Job},
    publication,
    signals::{Kind as SignalKind, Signals},
    slots::{Reply, Snapshot, Status},
    state::{PendingReply, Session, State},
};
use std::{
    collections::HashSet,
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const MARKER: &str = ".wow-ai-reforged-data";

fn ensure_private_data(dir: &Path) -> io::Result<()> {
    let marker = dir.join(MARKER);
    match fs::symlink_metadata(&marker) {
        Ok(m) => {
            if !m.file_type().is_file() || fs::read(&marker)? != b"wow-ai-reforged-data-v1\n" {
                return Err(io::Error::other("invalid Rust data directory marker"));
            }
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            for entry in fs::read_dir(dir)? {
                if entry?.file_name() != ".wow-ai-reforged.lock" {
                    return Err(io::Error::other(
                        "data_dir must be empty or an existing Rust-owned data directory",
                    ));
                }
            }
            match OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&marker)
            {
                Ok(mut file) => {
                    file.write_all(b"wow-ai-reforged-data-v1\n")?;
                    file.sync_all()?;
                }
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
                    return ensure_private_data(dir);
                }
                Err(e) => return Err(e),
            }
        }
        Err(e) => return Err(e),
    }
    Ok(())
}

fn utc_timestamp(seconds: u64) -> io::Result<String> {
    crate::runtime::utc_timestamp(seconds)
}

pub struct BridgeOptions {
    pub once: bool,
    pub wow_dir: Option<PathBuf>,
}

pub fn run(cfg: &Config, options: BridgeOptions) -> io::Result<()> {
    fs::create_dir_all(&cfg.data_dir)?;
    let private_dir = cfg.data_dir.canonicalize()?;
    ensure_private_data(&private_dir)?;
    let data_guard = OwnershipGuard::acquire(&private_dir)?;
    let data_dir = data_guard.data_dir();

    // Determine target addon directory: CLI --wow takes precedence over config
    let addon_dir = if let Some(ref client) = options.wow_dir {
        let client = client.canonicalize()?;
        let addons = client.join("Interface/AddOns");
        if !addons.is_dir() {
            return Err(io::Error::other(format!(
                "Addons directory does not exist: {}. Run 'wow-ai-reforged setup --wow <path>' first.",
                addons.display()
            )));
        }
        Some(addons)
    } else {
        cfg.addon_dir.clone()
    };

    let (_addon_guard, signals) = if let Some(ref addons) = addon_dir {
        let guard = OwnershipGuard::acquire(addons)?;
        let sig = Signals::new(addons.join("WoWAI"), 200, 60, 2000)?;
        (Some(guard), Some(sig))
    } else {
        (None, None)
    };

    println!("WoW AI Reforged — Live Bridge");
    println!("  project  : {}", cfg.project_dir.display());
    println!("  data     : {}", data_dir.display());
    if let Some(ref addons) = addon_dir {
        println!("  addons   : {}", addons.display());
    } else {
        println!("  addons   : None (private outbox only)");
    }
    println!("  agent    : {} (default)", cfg.agent.id());
    for (name, settings) in &cfg.agents {
        println!("    {:<7}: {}", name, settings.executable.display());
    }
    println!("Press Ctrl+C to stop.\n");

    let mut capture = CaptureSession::new(CaptureTarget::default());
    let mut handled_jobs: HashSet<(String, u64)> = HashSet::new();
    let mut last_waiting_log = Instant::now() - Duration::from_secs(10);
    let mut last_warn_log = Instant::now() - Duration::from_secs(10);
    let mut presence_counter: u16 = 1;

    loop {
        match capture.poll() {
            Ok(Some(CaptureEvent::Attached(info))) => {
                println!("[capture] attached to '{}' (pid {})", info.title, info.pid);
            }
            Ok(Some(CaptureEvent::Waiting { process, folder })) => {
                if last_waiting_log.elapsed() >= Duration::from_secs(5) {
                    last_waiting_log = Instant::now();
                    if let Some(ref folder) = folder {
                        println!("[capture] waiting for {process} window in {folder}...");
                    } else {
                        println!("[capture] waiting for {process} window...");
                    }
                }
            }
            Ok(Some(CaptureEvent::Minimized)) => {
                thread::sleep(Duration::from_millis(500));
            }
            Ok(Some(CaptureEvent::StripRejected(err))) => {
                if last_warn_log.elapsed() >= Duration::from_secs(5) {
                    last_warn_log = Instant::now();
                    eprintln!("[capture warn] strip rejected: {err}");
                }
            }
            Ok(Some(CaptureEvent::Frame(frame))) => {
                let jobs = protocol::jobs_from_strip(frame.id as u64, &frame.text);
                for job in jobs {
                    let key = (job.session.clone(), job.id);
                    if handled_jobs.contains(&key) {
                        continue;
                    }
                    handled_jobs.insert(key);
                    if let Err(e) = execute_job(
                        cfg,
                        data_dir,
                        addon_dir.as_deref(),
                        signals.as_ref(),
                        &job,
                        &mut presence_counter,
                    ) {
                        eprintln!("[job #{}] execution error: {e}", job.id);
                    }
                }
            }
            Ok(None) => {}
            Err(e) => {
                eprintln!("[capture error] {e}");
            }
        }

        if options.once {
            break;
        }

        thread::sleep(Duration::from_millis(250));
    }

    Ok(())
}

fn execute_job(
    cfg: &Config,
    data_dir: &Path,
    addon_dir: Option<&Path>,
    signals: Option<&Signals>,
    job: &Job,
    presence_counter: &mut u16,
) -> io::Result<()> {
    let mut state = State::load(data_dir)?;

    if job.flags.forget {
        println!("[job #{}] forget chat {}", job.id, job.chat);
        state.sessions.remove(&job.chat);
        state.save(data_dir)?;
        if let Some(sig) = signals {
            let _ = sig.set(SignalKind::Acknowledgement, job.id, true);
        }
        return Ok(());
    }

    if job.flags.hello {
        println!("[job #{}] hello from session {}", job.id, job.session);
        state.save(data_dir)?;
        if let Some(sig) = signals {
            let _ = sig.set(SignalKind::Acknowledgement, job.id, true);
            let (next_counter, _) = sig.presence(*presence_counter)?;
            *presence_counter = next_counter;
        }
        return Ok(());
    }

    // Determine target agent
    let kind = if !job.flags.agent.is_empty() {
        match AgentKind::parse_name(&job.flags.agent) {
            Ok(k) => k,
            Err(_) => {
                eprintln!(
                    "[job #{}] unknown requested agent '{}', using default '{}'",
                    job.id,
                    job.flags.agent,
                    cfg.agent.id()
                );
                cfg.agent
            }
        }
    } else {
        cfg.agent
    };

    let settings = cfg
        .agents
        .get(kind.id())
        .ok_or_else(|| io::Error::other(format!("agent '{}' is not configured", kind.id())))?;

    if let Some(sig) = signals {
        let _ = sig.set(SignalKind::Acknowledgement, job.id, true);
        let _ = sig.set(SignalKind::ReplyReady, job.id, false);
        let _ = sig.reset_activity(job.id);
    }

    let session = state
        .sessions
        .get(&job.chat)
        .filter(|s| !job.flags.new_session && s.agent == kind.id() && s.project == cfg.project_dir)
        .map(|s| s.id.clone());

    if session.is_none() {
        state.sessions.remove(&job.chat);
    }

    // Wrap prompt with game context if provided
    let full_prompt = if let Some(ref ctx) = job.context {
        if !ctx.is_empty() {
            format!("[Game Context]\n{ctx}\n\n[Message]\n{}", job.text)
        } else {
            job.text.clone()
        }
    } else {
        job.text.clone()
    };

    let prompt_file = data_dir.join("agent-prompt.txt");
    let invocation = agents::build(
        kind,
        settings,
        &cfg.project_dir,
        &full_prompt,
        session.as_deref(),
        &prompt_file,
    )
    .map_err(io::Error::other)?;

    process::validate_program(&invocation.program)?;

    state.record(&job.chat, "user", &job.text, job.id, kind.id())?;
    state.save(data_dir)?;

    println!(
        "[job #{}] running {} for chat '{}'",
        job.id,
        kind.id(),
        job.chat
    );

    let outcome = (|| {
        if let Some(bytes) = &invocation.prompt_file {
            publication::atomic_write(&prompt_file, bytes)?;
        }
        let output = process::run(process::Request {
            program: &invocation.program,
            args: &invocation.args,
            cwd: &cfg.project_dir,
            input: invocation.stdin.as_deref(),
            env: &invocation.env,
            timeout: Duration::from_millis(cfg.timeout_ms),
            max_output: cfg.max_output_bytes,
        })?;

        if !output.status.success() {
            return Err(io::Error::other(format!(
                "{} exited with {}: {}",
                kind.id(),
                output.status,
                String::from_utf8_lossy(&output.stderr)
            )));
        }

        let parsed = agents::parse_with_stderr(kind, &output.stdout, &output.stderr)
            .map_err(io::Error::other)?;
        if parsed.text.len() > 65536 {
            return Err(io::Error::other("agent reply exceeds 65536 bytes"));
        }
        Ok(parsed)
    })();

    if invocation.prompt_file.is_some() {
        let _ = fs::remove_file(&prompt_file);
    }

    match outcome {
        Ok(output) => {
            if let Some(new_session) = &output.session {
                state.sessions.insert(
                    job.chat.clone(),
                    Session {
                        agent: kind.id().into(),
                        project: cfg.project_dir.clone(),
                        id: new_session.clone(),
                    },
                );
            } else {
                state.sessions.remove(&job.chat);
            }
            state.record(&job.chat, "assistant", &output.text, job.id, kind.id())?;
            state.pending = Some(PendingReply {
                chat: job.chat.clone(),
                id: job.id,
                agent: kind,
                project: cfg.project_dir.clone(),
                text: output.text.clone(),
                session: output.session.clone(),
                denied: output.denied.clone(),
            });
            state.save(data_dir)?;

            publish_reply(ReplyPublication {
                addon_dir,
                data_dir,
                project: &cfg.project_dir,
                kind,
                chat: &job.chat,
                id: job.id,
                status: Status::Done,
                text: &output.text,
                session: output.session.as_deref().unwrap_or(""),
                denied: output.denied,
            })?;

            state.pending = None;
            state.save(data_dir)?;

            if let Some(sig) = signals {
                let _ = sig.set(SignalKind::ReplyReady, job.id, true);
                let _ = sig.activity(job.id, 1);
            }

            println!(
                "[job #{}] reply published ({} bytes)",
                job.id,
                output.text.len()
            );
        }
        Err(err) => {
            let message = format!("Error: {err}");
            eprintln!("[job #{}] failed: {err}", job.id);
            let _ = state.record(&job.chat, "error", &message, job.id, kind.id());
            let _ = state.save(data_dir);

            let _ = publish_reply(ReplyPublication {
                addon_dir,
                data_dir,
                project: &cfg.project_dir,
                kind,
                chat: &job.chat,
                id: job.id,
                status: Status::Error,
                text: &message,
                session: session.as_deref().unwrap_or(""),
                denied: vec![],
            });

            if let Some(sig) = signals {
                let _ = sig.set(SignalKind::ReplyReady, job.id, true);
            }
        }
    }

    Ok(())
}

struct ReplyPublication<'a> {
    addon_dir: Option<&'a Path>,
    data_dir: &'a Path,
    project: &'a Path,
    kind: AgentKind,
    chat: &'a str,
    id: u64,
    status: Status,
    text: &'a str,
    session: &'a str,
    denied: Vec<String>,
}

fn publish_reply(req: ReplyPublication<'_>) -> io::Result<()> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(io::Error::other)?
        .as_secs();

    let snapshot = Snapshot {
        timestamp: utc_timestamp(now)?,
        now_seconds: now,
        cwd: req.project.to_string_lossy().into_owned(),
        agent: req.kind.id().into(),
        agents: vec![req.kind.id().into()],
        replies: vec![Reply {
            chat: req.chat.into(),
            id: req.id,
            status: req.status,
            text: req.text.into(),
            cwd: req.project.to_string_lossy().into_owned(),
            session: req.session.into(),
            agent: req.kind.id().into(),
            summary: None,
            denied: req.denied,
        }],
    };

    if let Some(addons) = req.addon_dir {
        publication::publish(addons, 200, &snapshot)?;
    } else {
        let outbox = req.data_dir.join("outbox");
        let _ = fs::create_dir_all(outbox.join("WoWAI"));
        let _ = fs::create_dir_all(outbox.join("WoWAI_S001"));
        publication::publish(&outbox, 1, &snapshot)?;
    }

    Ok(())
}
