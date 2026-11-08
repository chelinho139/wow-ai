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

pub struct LiveBridge<'a> {
    cfg: &'a Config,
    data_guard: OwnershipGuard,
    _addon_guard: Option<OwnershipGuard>,
    addon_dir: Option<PathBuf>,
    signals: Option<Signals>,
    handled_jobs: HashSet<(String, u64)>,
    last_presence: Option<Instant>,
}
impl<'a> LiveBridge<'a> {
    pub fn start(cfg: &'a Config, wow_dir: Option<&Path>) -> io::Result<Self> {
        fs::create_dir_all(&cfg.data_dir)?;
        let private_dir = cfg.data_dir.canonicalize()?;
        ensure_private_data(&private_dir)?;
        let data_guard = OwnershipGuard::acquire(&private_dir)?;

        // Determine target addon directory: CLI --wow takes precedence over config
        let addon_dir = if let Some(client) = wow_dir {
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

        if addon_dir
            .as_ref()
            .is_some_and(|p| p.canonicalize().ok().as_deref() == Some(data_guard.data_dir()))
        {
            return Err(io::Error::other(
                "addon_dir and data_dir must be different directories",
            ));
        }
        let (_addon_guard, signals) = if let Some(ref addons) = addon_dir {
            let guard = OwnershipGuard::acquire(addons)?;
            let sig = Signals::new(addons.join("WoWAI"), 200, 60, 2000)?;
            (Some(guard), Some(sig))
        } else {
            (None, None)
        };

        Ok(Self {
            cfg,
            data_guard,
            _addon_guard,
            addon_dir,
            signals,
            handled_jobs: HashSet::new(),
            last_presence: None,
        })
    }
    pub fn tick(&mut self, now: Instant) -> io::Result<()> {
        let mut state = State::load(self.data_guard.data_dir())?;
        if let Some(pending) = state.pending.clone() {
            if pending.addon_dir != self.addon_dir {
                return Err(io::Error::other(
                    "pending reply belongs to a different publication target; recover it using its original config",
                ));
            }
            publish_reply(ReplyPublication {
                cfg: self.cfg,
                addon_dir: self.addon_dir.as_deref(),
                data_dir: self.data_guard.data_dir(),
                project: &pending.project,
                kind: pending.agent,
                chat: &pending.chat,
                id: pending.id,
                status: Status::Done,
                text: &pending.text,
                session: pending.session.as_deref().unwrap_or(""),
                denied: pending.denied,
            })?;
            if let Some(sig) = &self.signals {
                check_report(sig.set(SignalKind::ReplyReady, pending.id, true)?)?;
            }
            state.pending = None;
            state.save(self.data_guard.data_dir())?;
        }
        heartbeat(
            self.signals.as_ref(),
            &mut state,
            self.data_guard.data_dir(),
            &mut self.last_presence,
            now,
        )
    }
    pub fn accept_frame(&mut self, frame: &crate::frame::Frame) -> io::Result<()> {
        let mut failure = None;
        for job in protocol::jobs_from_strip(u64::from(frame.id), &frame.text) {
            let key = (job.session.clone(), job.id);
            if self.handled_jobs.contains(&key)
                || State::load(self.data_guard.data_dir())?
                    .handled_live
                    .contains(&key)
            {
                continue;
            }
            match execute_job(
                self.cfg,
                self.data_guard.data_dir(),
                self.addon_dir.as_deref(),
                self.signals.as_ref(),
                &job,
                &mut self.last_presence,
            ) {
                Ok(()) => {
                    if self.handled_jobs.len() >= 1000 {
                        self.handled_jobs.clear();
                    }
                    self.handled_jobs.insert(key);
                }
                Err(e) => {
                    if failure.is_none() {
                        failure = Some(e);
                    }
                }
            }
        }
        failure.map_or(Ok(()), Err)
    }
}

pub fn run(cfg: &Config, options: BridgeOptions) -> io::Result<()> {
    let mut bridge = LiveBridge::start(cfg, options.wow_dir.as_deref())?;
    let data_dir = bridge.data_guard.data_dir();
    let addon_dir = &bridge.addon_dir;
    println!("WoW AI Reforged — Live Bridge");
    println!("  project  : {}", cfg.project_dir.display());
    println!("  data     : {}", data_dir.display());
    if let Some(addons) = addon_dir {
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
    let mut last_waiting_log = Instant::now() - Duration::from_secs(10);
    let mut last_warn_log = Instant::now() - Duration::from_secs(10);

    loop {
        if let Err(e) = bridge.tick(Instant::now()) {
            eprintln!("[presence] {e}");
        }
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
                if let Err(e) = bridge.accept_frame(&frame) {
                    eprintln!("[job] execution error: {e}");
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
    last_presence: &mut Option<Instant>,
) -> io::Result<()> {
    let mut state = State::load(data_dir)?;
    if job.id == 0 || job.id > (1_u64 << 53) - 1 || job.session.len() > 256 || job.chat.len() > 128
    {
        return Err(io::Error::other("invalid addon message identity"));
    }
    if let Some(ctx) = &job.context {
        state.game_context = if ctx.is_empty() {
            None
        } else {
            Some(ctx.clone())
        };
    }

    if job.flags.forget {
        println!("[job #{}] forget chat {}", job.id, job.chat);
        state.sessions.remove(&job.chat);
        state.history.remove(&job.chat);
        state.save(data_dir)?;
        if let Some(sig) = signals {
            let _ = sig.set(SignalKind::Acknowledgement, job.id, true);
        }
        return Ok(());
    }

    if job.flags.hello {
        println!("[job #{}] hello from session {}", job.id, job.session);
        publish_connection(cfg, data_dir, addon_dir)?;
        *last_presence = None;
        heartbeat(signals, &mut state, data_dir, last_presence, Instant::now())?;
        state.save(data_dir)?;
        if let Some(sig) = signals {
            check_report(sig.set(SignalKind::Acknowledgement, job.id, true)?)?;
        }
        return Ok(());
    }

    // Determine target agent
    let kind = if !job.flags.agent.is_empty() {
        match AgentKind::parse_name(&job.flags.agent) {
            Ok(k) => k,
            Err(_) => {
                return publish_request_error(
                    cfg,
                    data_dir,
                    addon_dir,
                    signals,
                    job,
                    &format!("Unknown requested agent: {}", job.flags.agent),
                );
            }
        }
    } else {
        cfg.agent
    };

    let Some(settings) = cfg.agents.get(kind.id()) else {
        return publish_request_error(
            cfg,
            data_dir,
            addon_dir,
            signals,
            job,
            &format!("Agent '{}' is not configured", kind.id()),
        );
    };
    if state.pending.is_some() {
        return Err(io::Error::other(
            "a completed reply is awaiting publication; recover it before accepting another request",
        ));
    }
    if !job.cwd.is_empty() {
        return publish_request_error(
            cfg,
            data_dir,
            addon_dir,
            signals,
            job,
            "Per-chat folder changes are not supported by this live preview; set project_dir in config",
        );
    }
    if !job.flags.allow.is_empty() {
        return publish_request_error(
            cfg,
            data_dir,
            addon_dir,
            signals,
            job,
            "In-game permission changes are not supported by this live preview; edit agent settings in config",
        );
    }
    publish_reply(ReplyPublication {
        cfg,
        addon_dir,
        data_dir,
        project: &cfg.project_dir,
        kind,
        chat: &job.chat,
        id: job.id,
        status: Status::Working,
        text: "Agent is running",
        session: "",
        denied: vec![],
    })?;

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
    let full_prompt = if let Some(ref ctx) = state.game_context {
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
    );
    let invocation = match invocation {
        Ok(invocation) => invocation,
        Err(e) => return publish_request_error(cfg, data_dir, addon_dir, signals, job, &e),
    };
    if let Err(e) = process::validate_program(&invocation.program) {
        return publish_request_error(cfg, data_dir, addon_dir, signals, job, &e.to_string());
    }

    state.record(&job.chat, "user", &job.text, job.id, kind.id())?;
    if state.handled_live.len() >= 1000 {
        state.handled_live.remove(0);
    }
    state.handled_live.push((job.session.clone(), job.id));
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
        let output = process::run_with_tick(
            process::Request {
                program: &invocation.program,
                args: &invocation.args,
                cwd: &cfg.project_dir,
                input: invocation.stdin.as_deref(),
                env: &invocation.env,
                timeout: Duration::from_millis(cfg.timeout_ms),
                max_output: cfg.max_output_bytes,
            },
            || {
                if let Err(e) =
                    heartbeat(signals, &mut state, data_dir, last_presence, Instant::now())
                {
                    eprintln!("[presence] {e}");
                }
                Ok(())
            },
        )?;

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
        if parsed
            .session
            .as_ref()
            .is_some_and(|s| s.len() > 256 || s.chars().any(char::is_control))
            || parsed.denied.len() > 32
            || parsed.denied.iter().any(|s| s.len() > 256)
        {
            return Err(io::Error::other(
                "agent result metadata exceeds supported bounds",
            ));
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
                addon_dir: addon_dir.map(Path::to_path_buf),
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
                cfg,
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

            if let Some(sig) = signals {
                check_report(sig.set(SignalKind::ReplyReady, job.id, true)?)?;
                if let Err(e) = sig.activity(job.id, 1).and_then(check_report) {
                    eprintln!("[activity] {e}");
                }
            }
            state.pending = None;
            state.save(data_dir)?;

            println!(
                "[job #{}] reply published ({} bytes)",
                job.id,
                output.text.len()
            );
        }
        Err(err) => {
            let message = format!("Error: {err}");
            eprintln!("[job #{}] failed: {err}", job.id);
            let mut failures = Vec::new();
            if let Err(e) = state
                .record(&job.chat, "error", &message, job.id, kind.id())
                .and_then(|()| state.save(data_dir))
            {
                failures.push(format!("could not save error: {e}"));
            }
            if let Err(e) = publish_reply(ReplyPublication {
                cfg,
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
            }) {
                failures.push(format!("could not publish error: {e}"));
            }
            if let Some(sig) = signals
                && let Err(e) = sig
                    .set(SignalKind::ReplyReady, job.id, true)
                    .and_then(check_report)
            {
                failures.push(format!("could not signal reply: {e}"));
            }
            if !failures.is_empty() {
                return Err(io::Error::other(format!(
                    "{message}; additionally {}",
                    failures.join("; ")
                )));
            }
            return Err(err);
        }
    }

    Ok(())
}

struct ReplyPublication<'a> {
    cfg: &'a Config,
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
        agent: req.cfg.agent.id().into(),
        agents: req.cfg.agents.keys().cloned().collect(),
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
        check_report(publication::publish(addons, 200, &snapshot)?)?;
    } else {
        let outbox = crate::runtime::prepare_outbox(req.data_dir)?;
        check_report(publication::publish(&outbox, 1, &snapshot)?)?;
    }

    Ok(())
}

fn check_report(report: publication::Report) -> io::Result<()> {
    if let Some((path, e)) = report.failed.first() {
        return Err(io::Error::other(format!(
            "file publication failed at {}: {e}",
            path.display()
        )));
    }
    Ok(())
}
fn heartbeat(
    signals: Option<&Signals>,
    state: &mut State,
    data_dir: &Path,
    last: &mut Option<Instant>,
    now: Instant,
) -> io::Result<()> {
    if last.is_some_and(|t| now.saturating_duration_since(t) < Duration::from_secs(30)) {
        return Ok(());
    }
    *last = Some(now);
    if let Some(signals) = signals {
        let (next, report) = signals.presence(state.presence_counter)?;
        check_report(report)?;
        state.presence_counter = next;
        state.save(data_dir)?;
    }
    *last = Some(now);
    Ok(())
}
fn publish_connection(cfg: &Config, data_dir: &Path, addon_dir: Option<&Path>) -> io::Result<()> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(io::Error::other)?
        .as_secs();
    let snapshot = Snapshot {
        timestamp: utc_timestamp(now)?,
        now_seconds: now,
        cwd: cfg.project_dir.to_string_lossy().into_owned(),
        agent: cfg.agent.id().into(),
        agents: cfg.agents.keys().cloned().collect(),
        replies: vec![],
    };
    if let Some(addons) = addon_dir {
        check_report(publication::publish(addons, 200, &snapshot)?)?;
    } else {
        crate::runtime::prepare_outbox(data_dir)?;
        check_report(publication::publish(
            &data_dir.join("outbox"),
            1,
            &snapshot,
        )?)?;
    }
    Ok(())
}
fn publish_request_error(
    cfg: &Config,
    data_dir: &Path,
    addon_dir: Option<&Path>,
    signals: Option<&Signals>,
    job: &Job,
    message: &str,
) -> io::Result<()> {
    publish_reply(ReplyPublication {
        cfg,
        addon_dir,
        data_dir,
        project: &cfg.project_dir,
        kind: cfg.agent,
        chat: &job.chat,
        id: job.id,
        status: Status::Error,
        text: message,
        session: "",
        denied: vec![],
    })?;
    if let Some(sig) = signals {
        check_report(sig.set(SignalKind::Acknowledgement, job.id, true)?)?;
        check_report(sig.set(SignalKind::ReplyReady, job.id, true)?)?;
    }
    Err(io::Error::other(message.to_owned()))
}
