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

// Fault injection is absent from release builds. Tests run each crash in its own
// process, so locks and stack cleanup cannot hide restart behavior.
#[inline]
fn crash_point(point: &str) {
    #[cfg(debug_assertions)]
    if std::env::var("WOW_AI_TEST_CRASH_POINT").as_deref() == Ok(point) {
        std::process::exit(86);
    }
    #[cfg(not(debug_assertions))]
    let _ = point;
}

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

#[derive(Default)]
struct Heartbeat {
    presence: Option<Instant>,
    slots: Option<Instant>,
}
#[derive(PartialEq, Eq)]
struct ReloadVersion {
    path: PathBuf,
    modified: SystemTime,
    length: u64,
    session: String,
}

pub struct LiveBridge<'a> {
    cfg: &'a Config,
    data_guard: OwnershipGuard,
    _addon_guard: Option<OwnershipGuard>,
    addon_dir: Option<PathBuf>,
    signals: Option<Signals>,
    handled_jobs: HashSet<(String, u64)>,
    last_presence: Heartbeat,
    active_addon_session: Option<String>,
    reload_version: Option<ReloadVersion>,
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

        let addon_dir = addon_dir.map(fs::canonicalize).transpose()?;
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

        let pending = State::load(data_guard.data_dir())?.pending;
        if pending.as_ref().is_some_and(|p| p.addon_dir != addon_dir) {
            return Err(io::Error::other(
                "pending reply belongs to a different publication target; recover it using its original config",
            ));
        }
        recover_deletions(cfg, data_guard.data_dir(), addon_dir.as_deref(), false)?;
        let recovering = pending.as_ref().map(|p| (p.chat.as_str(), p.id));
        if crate::live_replies::interrupt_orphans(
            data_guard.data_dir(),
            addon_dir.as_deref(),
            recovering,
        )? {
            publish_connection(cfg, data_guard.data_dir(), addon_dir.as_deref(), true)?;
        }
        Ok(Self {
            cfg,
            data_guard,
            _addon_guard,
            addon_dir,
            signals,
            handled_jobs: HashSet::new(),
            last_presence: Heartbeat::default(),
            active_addon_session: None,
            reload_version: None,
        })
    }
    pub fn shutdown(&mut self) -> io::Result<()> {
        let target = self
            .addon_dir
            .clone()
            .unwrap_or_else(|| self.data_guard.data_dir().join("outbox"));
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(io::Error::other)?
            .as_secs();
        if let Some(report) = publication::refresh_lifecycle(
            &target,
            if self.addon_dir.is_some() { 200 } else { 1 },
            now,
            false,
        )? {
            return check_report(report);
        }
        publish_connection(
            self.cfg,
            self.data_guard.data_dir(),
            self.addon_dir.as_deref(),
            false,
        )
    }
    pub fn tick(&mut self, now: Instant) -> io::Result<()> {
        recover_deletions(
            self.cfg,
            self.data_guard.data_dir(),
            self.addon_dir.as_deref(),
            true,
        )?;
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
                status: pending.status,
                text: &pending.text,
                session: pending.session.as_deref().unwrap_or(""),
                model: &pending.model,
                effort: &pending.effort,
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
            self.addon_dir.as_deref(),
            &mut state,
            self.data_guard.data_dir(),
            &mut self.last_presence,
            now,
            false,
        )
    }
    fn accept_job(&mut self, job: &Job) -> io::Result<()> {
        recover_deletions(
            self.cfg,
            self.data_guard.data_dir(),
            self.addon_dir.as_deref(),
            true,
        )?;
        let key = (job.session.clone(), job.id);
        let mut state = State::load(self.data_guard.data_dir())?;
        // Upgrade retained legacy IDs before accepting new work. Never prune the ledger.
        let mut migrated = false;
        for (session, id) in &state.handled_live {
            if !state.live_admissions.contains(session, *id) {
                state.live_admissions.insert(session, *id)?;
                migrated = true;
            }
        }
        if migrated {
            state.save(self.data_guard.data_dir())?;
        }
        if !job.flags.hello && !job.flags.forget && state.deleted_chats.contains_key(&job.chat) {
            // The durable tombstone consumes stale input without republishing it.
            return Ok(());
        }
        if !job.flags.forget
            && (self.handled_jobs.contains(&key)
                || state.handled_live.contains(&key)
                || state.live_admissions.contains(&job.session, job.id))
        {
            return Ok(());
        }
        if job.flags.hello {
            self.active_addon_session = Some(job.session.clone());
        }
        execute_job(
            self.cfg,
            self.data_guard.data_dir(),
            self.addon_dir.as_deref(),
            self.signals.as_ref(),
            job,
            &mut self.last_presence,
        )?;
        if self.handled_jobs.len() >= 1000 {
            self.handled_jobs.clear();
        }
        self.handled_jobs.insert(key);
        Ok(())
    }

    /// Poll only fresh saves belonging to a session observed through pixel hello.
    pub fn poll_saved_variables(&mut self, path: &Path, started_at: SystemTime) -> io::Result<()> {
        let Some(session) = self.active_addon_session.clone() else {
            return Ok(());
        };
        let meta = match fs::symlink_metadata(path) {
            Ok(meta) => meta,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e),
        };
        if !meta.file_type().is_file() {
            return Err(io::Error::other("SavedVariables must be a regular file"));
        }
        let modified = meta.modified()?;
        if modified < started_at {
            return Ok(());
        }
        let version = ReloadVersion {
            path: path.to_path_buf(),
            modified,
            length: meta.len(),
            session,
        };
        if self.reload_version.as_ref() == Some(&version) {
            return Ok(());
        }
        let bytes = crate::config::read_bounded(path, 16 * 1024 * 1024)?;
        let source = std::str::from_utf8(&bytes).map_err(io::Error::other)?;
        if let Some(job) = crate::reload::parse_outbox(source)?
            && self.active_addon_session.as_deref() == Some(job.session.as_str())
        {
            self.accept_job(&job)?;
        }
        self.reload_version = Some(version);
        Ok(())
    }

    /// Reload and pixel records share the same durable admission path.
    pub fn accept_saved_variables(&mut self, source: &str) -> io::Result<()> {
        if let Some(job) = crate::reload::parse_outbox(source)? {
            self.accept_job(&job)?;
        }
        Ok(())
    }

    pub fn accept_frame(&mut self, frame: &crate::frame::Frame) -> io::Result<()> {
        let mut failure = None;
        for job in protocol::jobs_from_strip(u64::from(frame.id), &frame.text) {
            if crate::shutdown::requested() {
                break;
            }
            if let Err(error) = self.accept_job(&job)
                && failure.is_none()
            {
                failure = Some(error);
            }
        }
        failure.map_or(Ok(()), Err)
    }
}

pub fn run(cfg: &Config, options: BridgeOptions) -> io::Result<()> {
    let _shutdown = crate::shutdown::install()?;
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

    let target = if let Some(addons) = &bridge.addon_dir {
        let client = addons.parent().and_then(Path::parent).ok_or_else(|| {
            io::Error::other("addon_dir must point to the client Interface/AddOns directory")
        })?;
        CaptureTarget::for_executable(client.join("Wow.exe").canonicalize()?)
    } else {
        CaptureTarget::default()
    };
    let mut capture = CaptureSession::new(target);
    let started_at = SystemTime::now();
    let mut last_reload_poll = Instant::now();
    let mut last_waiting_log = Instant::now() - Duration::from_secs(10);
    let mut last_warn_log = Instant::now() - Duration::from_secs(10);

    loop {
        if crate::shutdown::requested() {
            break;
        }
        if let Err(e) = bridge.tick(Instant::now()) {
            eprintln!("[presence] {e}");
        }
        if last_reload_poll.elapsed() >= Duration::from_millis(750) {
            last_reload_poll = Instant::now();
            if let Some(path) = &cfg.saved_variables {
                let result = bridge.poll_saved_variables(path, started_at);
                if let Err(error) = result {
                    eprintln!("[reload] {error}");
                }
            }
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

    bridge.shutdown()?;
    Ok(())
}

/// Resume every unfinished deletion before publishing or accepting new work.
fn recover_deletions(
    cfg: &Config,
    data: &Path,
    target: Option<&Path>,
    online: bool,
) -> io::Result<()> {
    let mut state = State::load(data)?;
    let pending: Vec<_> = state
        .deleted_chats
        .iter()
        .filter(|(_, d)| !d.complete)
        .map(|(chat, d)| (chat.clone(), d.clone()))
        .collect();
    for (chat, deletion) in pending {
        if deletion.addon_dir.as_deref() != target {
            return Err(io::Error::other(
                "unfinished deletion belongs to another addon target; recover using its original config",
            ));
        }
        crate::live_replies::forget(data, target, &chat)?;
        crash_point("after_delete_cache");
        publish_connection(cfg, data, target, online)?;
        crash_point("after_delete_publication");
        state.deleted_chats.get_mut(&chat).unwrap().complete = true;
        state.save(data)?;
        crash_point("after_delete_complete");
        publish_connection(cfg, data, target, online)?;
    }
    Ok(())
}

/// Relative chat folders are rooted at the configured project, never the
/// bridge process cwd. Canonical identities also normalize symlink aliases.
fn requested_project(default: &Path, requested: &str) -> io::Result<PathBuf> {
    let environment = crate::discovery::Environment::current();
    resolve_chat_project(default, requested, environment.home.as_deref())
}

fn resolve_chat_project(
    default: &Path,
    requested: &str,
    home: Option<&Path>,
) -> io::Result<PathBuf> {
    if requested.len() > 32768 || requested.contains('\0') {
        return Err(io::Error::other(
            "Invalid working folder: path is too long or contains a NUL byte",
        ));
    }
    let requested_path = Path::new(requested);
    if matches!(
        requested_path.components().next(),
        Some(std::path::Component::Prefix(_))
    ) && !requested_path.is_absolute()
    {
        return Err(io::Error::other(
            "Ambiguous drive-relative working folder. Use an absolute path or a relative path without a drive prefix.",
        ));
    }
    let path = if requested == "~" || requested.starts_with("~/") || requested.starts_with("~\\") {
        let home = home.filter(|p| p.is_absolute()).ok_or_else(|| io::Error::other("Cannot expand ~: configure an absolute HOME or USERPROFILE, or choose an absolute working folder."))?;
        // Both separators are advertised by the shared addon/upstream contract.
        let tail = requested[1..].trim_start_matches(['/', '\\']);
        home.join(tail)
    } else if requested.is_empty() {
        default.to_path_buf()
    } else {
        crate::process::resolve_path(default, requested_path)
    };
    let project = path.canonicalize().map_err(|error| io::Error::new(error.kind(),
        format!("Cannot use working folder {}: {error}. Choose an existing directory or reset to the bridge default.", path.display())))?;
    if !project.is_dir() {
        return Err(io::Error::other(format!(
            "Working folder {} is not a directory. Choose a directory or reset to the bridge default.",
            project.display()
        )));
    }
    Ok(project)
}

fn execute_job(
    cfg: &Config,
    data_dir: &Path,
    addon_dir: Option<&Path>,
    signals: Option<&Signals>,
    job: &Job,
    last_presence: &mut Heartbeat,
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
        if !state.deleted_chats.contains_key(&job.chat) {
            if job.chat.is_empty() {
                return Err(io::Error::other("cannot delete an unnamed chat"));
            }
            state.deleted_chats.insert(
                job.chat.clone(),
                crate::state::Deletion {
                    session: job.session.clone(),
                    id: job.id,
                    addon_dir: addon_dir.map(Path::to_path_buf),
                    complete: false,
                },
            );
            state.sessions.remove(&job.chat);
            state.history.remove(&job.chat);
            if state
                .pending
                .as_ref()
                .is_some_and(|pending| pending.chat == job.chat)
            {
                state.pending = None;
            }
            state.live_admissions.insert(&job.session, job.id)?;
            // Intent and private cleanup are one atomic state update. No ack yet.
            crash_point("before_delete_intent");
            state.save(data_dir)?;
            crash_point("after_delete_intent");
        }
        recover_deletions(cfg, data_dir, addon_dir, true)?;
        let mut completed = State::load(data_dir)?;
        let receipt = completed.deleted_chats.get_mut(&job.chat).unwrap();
        if receipt.session != job.session || receipt.id != job.id {
            receipt.session = job.session.clone();
            receipt.id = job.id;
            completed.save(data_dir)?;
        }
        publish_connection(cfg, data_dir, addon_dir, true)?;
        if let Some(sig) = signals {
            check_report(sig.set(SignalKind::Acknowledgement, job.id, true)?)?;
        }
        crash_point("after_delete_ack");
        return Ok(());
    }

    if job.flags.hello {
        println!("[job #{}] hello from session {}", job.id, job.session);
        publish_connection(cfg, data_dir, addon_dir, true)?;
        *last_presence = Heartbeat::default();
        heartbeat(
            signals,
            addon_dir,
            &mut state,
            data_dir,
            last_presence,
            Instant::now(),
            false,
        )?;
        state.save(data_dir)?;
        if let Some(sig) = signals {
            check_report(sig.set(SignalKind::Acknowledgement, job.id, true)?)?;
        }
        return Ok(());
    }

    if state.pending.is_some() {
        return Err(io::Error::other(
            "a reply is awaiting publication; recover it before accepting another request",
        ));
    }

    let mut rejection = ErrorContext {
        cfg,
        project: &cfg.project_dir,
        kind: cfg.agent,
    };
    // Determine target agent
    let kind = if !job.flags.agent.is_empty() {
        match AgentKind::parse_name(&job.flags.agent) {
            Ok(k) => k,
            Err(_) => {
                return publish_request_error(
                    rejection,
                    data_dir,
                    addon_dir,
                    signals,
                    &mut state,
                    job,
                    &format!("Unknown requested agent: {}", job.flags.agent),
                );
            }
        }
    } else {
        cfg.agent
    };

    rejection.kind = kind;
    let project = match requested_project(&cfg.project_dir, &job.cwd) {
        Ok(project) => project,
        Err(error) => {
            return publish_request_error(
                rejection,
                data_dir,
                addon_dir,
                signals,
                &mut state,
                job,
                &error.to_string(),
            );
        }
    };
    rejection.project = &project;
    let Some(settings) = cfg.agents.get(kind.id()) else {
        return publish_request_error(
            rejection,
            data_dir,
            addon_dir,
            signals,
            &mut state,
            job,
            &format!("Agent '{}' is not configured", kind.id()),
        );
    };
    if !job.flags.allow.is_empty() {
        return publish_request_error(
            rejection,
            data_dir,
            addon_dir,
            signals,
            &mut state,
            job,
            "In-game permission changes are not supported by this live preview; edit agent settings in config",
        );
    }
    let effective =
        match agents::effective_settings(kind, settings, &job.flags.model, &job.flags.effort) {
            Ok(value) => value,
            Err(error) => {
                return publish_request_error(
                    rejection, data_dir, addon_dir, signals, &mut state, job, &error,
                );
            }
        };
    let settings = &effective.settings;
    let session = state
        .sessions
        .get(&job.chat)
        .filter(|s| {
            !job.flags.new_session
                && s.agent == kind.id()
                && s.project == project
                && (s.config_fingerprint == effective.fingerprint
                    || (s.config_fingerprint.is_empty()
                        && job.flags.model.is_empty()
                        && job.flags.effort.is_empty()))
        })
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
        &project,
        &full_prompt,
        session.as_deref(),
        &prompt_file,
    );
    let invocation = match invocation {
        Ok(invocation) => invocation,
        Err(e) => {
            return publish_request_error(
                rejection, data_dir, addon_dir, signals, &mut state, job, &e,
            );
        }
    };
    if let Err(e) = process::validate_program(&invocation.program) {
        return publish_request_error(
            rejection,
            data_dir,
            addon_dir,
            signals,
            &mut state,
            job,
            &e.to_string(),
        );
    }

    state.live_admissions.insert(&job.session, job.id)?;
    state.pending = Some(PendingReply {
        status: Status::Error,
        model: effective.model.clone(), effort: effective.effort.clone(),
        addon_dir: addon_dir.map(Path::to_path_buf), chat: job.chat.clone(),
        id: job.id, agent: kind, project: project.clone(),
        text: "The bridge stopped after accepting this request. Its outcome is unknown; it will not be resent automatically. Send a new request to retry.".into(),
        session: None, denied: vec![],
    });
    state.record(&job.chat, "user", &job.text, job.id, kind.id())?;
    if state.handled_live.len() >= 1000 {
        state.handled_live.remove(0);
    }
    state.handled_live.push((job.session.clone(), job.id));
    crash_point("before_admission_save");
    state.save(data_dir)?;
    crash_point("after_admission_save");

    publish_reply(ReplyPublication {
        cfg,
        addon_dir,
        data_dir,
        project: &project,
        kind,
        chat: &job.chat,
        id: job.id,
        model: &effective.model,
        effort: &effective.effort,
        status: Status::Working,
        text: "Agent is running",
        session: "",
        denied: vec![],
    })?;

    crash_point("after_working_publication");
    if let Some(sig) = signals {
        let _ = sig.set(SignalKind::Acknowledgement, job.id, true);
        let _ = sig.set(SignalKind::ReplyReady, job.id, false);
        let _ = sig.reset_activity(job.id);
    }

    crash_point("after_acknowledgement");
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
        // Publish the initial heartbeat before spawning the agent. Later beats
        // are driven by the wait callback, at the normal 30-second interval.
        if let Err(e) = heartbeat(
            signals,
            addon_dir,
            &mut state,
            data_dir,
            last_presence,
            Instant::now(),
            true,
        ) {
            eprintln!("[presence] {e}");
        }
        let output = process::run_with_tick(
            process::Request {
                program: &invocation.program,
                args: &invocation.args,
                cwd: &project,
                input: invocation.stdin.as_deref(),
                env: &invocation.env,
                timeout: Duration::from_millis(cfg.timeout_ms),
                max_output: cfg.max_output_bytes,
            },
            || {
                if crate::shutdown::requested() {
                    return Err(io::Error::new(
                        io::ErrorKind::Interrupted,
                        "bridge is stopping",
                    ));
                }
                if let Err(e) = heartbeat(
                    signals,
                    addon_dir,
                    &mut state,
                    data_dir,
                    last_presence,
                    Instant::now(),
                    true,
                ) {
                    eprintln!("[presence] {e}");
                }
                Ok(())
            },
        )?;

        crash_point("after_agent_exit");
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
                        config_fingerprint: effective.fingerprint.clone(),
                        agent: kind.id().into(),
                        project: project.clone(),
                        id: new_session.clone(),
                    },
                );
            } else {
                state.sessions.remove(&job.chat);
            }
            state.record(&job.chat, "assistant", &output.text, job.id, kind.id())?;
            state.pending = Some(PendingReply {
                status: Status::Done,
                model: effective.model.clone(),
                effort: effective.effort.clone(),
                addon_dir: addon_dir.map(Path::to_path_buf),
                chat: job.chat.clone(),
                id: job.id,
                agent: kind,
                project: project.clone(),
                text: output.text.clone(),
                session: output.session.clone(),
                denied: output.denied.clone(),
            });
            state.save(data_dir)?;
            crash_point("after_completion_save");

            publish_reply(ReplyPublication {
                cfg,
                addon_dir,
                data_dir,
                project: &project,
                kind,
                chat: &job.chat,
                id: job.id,
                status: Status::Done,
                text: &output.text,
                session: output.session.as_deref().unwrap_or(""),
                model: &effective.model,
                effort: &effective.effort,
                denied: output.denied,
            })?;

            crash_point("after_reply_publication");
            if let Some(sig) = signals {
                check_report(sig.set(SignalKind::ReplyReady, job.id, true)?)?;
                if let Err(e) = sig.activity(job.id, 1).and_then(check_report) {
                    eprintln!("[activity] {e}");
                }
            }
            crash_point("after_completion_signal");
            state.pending = None;
            state.save(data_dir)?;
            crash_point("after_pending_clear");

            println!(
                "[job #{}] reply published ({} bytes)",
                job.id,
                output.text.len()
            );
        }
        Err(err) => {
            let mut message = format!("Error: {err}");
            if message.len() > 16000 {
                let mut end = 16000;
                while !message.is_char_boundary(end) {
                    end -= 1;
                }
                message.truncate(end);
                message.push_str(" [diagnostic truncated]");
            }
            eprintln!("[job #{}] {message}", job.id);
            let mut failures = Vec::new();
            if let Some(pending) = &mut state.pending {
                pending.text = message.clone();
            }
            if let Err(e) = state
                .record(&job.chat, "error", &message, job.id, kind.id())
                .and_then(|()| state.save(data_dir))
            {
                failures.push(format!("could not save error: {e}"));
            }
            crash_point("after_error_save");
            if let Err(e) = publish_reply(ReplyPublication {
                cfg,
                addon_dir,
                data_dir,
                project: &project,
                kind,
                chat: &job.chat,
                id: job.id,
                status: Status::Error,
                text: &message,
                session: session.as_deref().unwrap_or(""),
                model: &effective.model,
                effort: &effective.effort,
                denied: vec![],
            }) {
                failures.push(format!("could not publish error: {e}"));
            }
            crash_point("after_error_publication");
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
            state.pending = None;
            state.save(data_dir)?;
            return Err(io::Error::new(err.kind(), message));
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
    model: &'a str,
    effort: &'a str,
}

fn publish_reply(req: ReplyPublication<'_>) -> io::Result<()> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(io::Error::other)?
        .as_secs();

    let snapshot = Snapshot {
        deletions: Some(deletion_acks(req.data_dir)?),
        online: Some(true),
        timestamp: utc_timestamp(now)?,
        now_seconds: now,
        cwd: req.cfg.project_dir.to_string_lossy().into_owned(),
        agent: req.cfg.agent.id().into(),
        agents: req.cfg.agents.keys().cloned().collect(),
        capabilities: Some(req.cfg.capabilities()),
        replies: crate::live_replies::put(
            req.data_dir,
            req.addon_dir,
            Reply {
                chat: req.chat.into(),
                id: req.id,
                status: req.status,
                text: req.text.into(),
                cwd: req.project.to_string_lossy().into_owned(),
                session: req.session.into(),
                agent: req.kind.id().into(),
                model: req.model.into(),
                effort: req.effort.into(),
                summary: None,
                denied: req.denied,
            },
        )?,
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
    addon_dir: Option<&Path>,
    state: &mut State,
    data_dir: &Path,
    last: &mut Heartbeat,
    now: Instant,
    busy: bool,
) -> io::Result<()> {
    let slot_interval = Duration::from_secs(if busy { 30 } else { 300 });
    if last
        .slots
        .is_none_or(|t| now.saturating_duration_since(t) >= slot_interval)
    {
        // Rate-limit failures as well as successful broadcasts.
        last.slots = Some(now);
        if let Some(addons) = addon_dir {
            let seconds = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(io::Error::other)?
                .as_secs();
            if let Some(report) = publication::refresh_lifecycle(addons, 200, seconds, true)? {
                check_report(report)?;
            }
        }
    }
    if last
        .presence
        .is_none_or(|t| now.saturating_duration_since(t) >= Duration::from_secs(30))
    {
        last.presence = Some(now);
        if let Some(signals) = signals {
            let (next, report) = signals.presence(state.presence_counter)?;
            check_report(report)?;
            state.presence_counter = next;
            state.save(data_dir)?;
        }
    }
    Ok(())
}
fn deletion_acks(data: &Path) -> io::Result<Vec<crate::slots::DeletionAck>> {
    Ok(State::load(data)?
        .deleted_chats
        .into_iter()
        .filter(|(_, d)| d.complete)
        .map(|(chat, d)| crate::slots::DeletionAck {
            chat,
            session: d.session,
            id: d.id,
        })
        .collect())
}

fn publish_connection(
    cfg: &Config,
    data_dir: &Path,
    addon_dir: Option<&Path>,
    online: bool,
) -> io::Result<()> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(io::Error::other)?
        .as_secs();
    let snapshot = Snapshot {
        deletions: Some(deletion_acks(data_dir)?),
        online: Some(online),
        timestamp: utc_timestamp(now)?,
        now_seconds: now,
        cwd: cfg.project_dir.to_string_lossy().into_owned(),
        agent: cfg.agent.id().into(),
        agents: cfg.agents.keys().cloned().collect(),
        capabilities: Some(cfg.capabilities()),
        replies: crate::live_replies::all(data_dir, addon_dir)?,
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
#[derive(Clone, Copy)]
struct ErrorContext<'a> {
    cfg: &'a Config,
    project: &'a Path,
    kind: AgentKind,
}

fn publish_request_error(
    context: ErrorContext<'_>,
    data_dir: &Path,
    addon_dir: Option<&Path>,
    signals: Option<&Signals>,
    state: &mut State,
    job: &Job,
    message: &str,
) -> io::Result<()> {
    let ErrorContext { cfg, project, kind } = context;
    if state.pending.is_some() {
        return Err(io::Error::other(
            "recover pending reply before rejecting another request",
        ));
    }
    state.live_admissions.insert(&job.session, job.id)?;
    state.pending = Some(PendingReply {
        status: Status::Error,
        model: String::new(),
        effort: String::new(),
        addon_dir: addon_dir.map(Path::to_path_buf),
        chat: job.chat.clone(),
        id: job.id,
        agent: kind,
        project: project.to_path_buf(),
        text: message.to_owned(),
        session: None,
        denied: vec![],
    });
    state.save(data_dir)?;
    publish_reply(ReplyPublication {
        cfg,
        addon_dir,
        data_dir,
        project,
        kind,
        chat: &job.chat,
        id: job.id,
        model: "",
        effort: "",
        status: Status::Error,
        text: message,
        session: "",
        denied: vec![],
    })?;
    if let Some(sig) = signals {
        check_report(sig.set(SignalKind::Acknowledgement, job.id, true)?)?;
        check_report(sig.set(SignalKind::ReplyReady, job.id, true)?)?;
    }
    state.pending = None;
    state.save(data_dir)?;
    Err(io::Error::other(message.to_owned()))
}

#[cfg(all(test, windows))]
mod folder_tests {
    #[test]
    fn rejects_drive_relative_paths_before_using_process_drive_state() {
        for path in ["C:relative", "D:"] {
            assert!(
                super::requested_project(std::path::Path::new("."), path)
                    .unwrap_err()
                    .to_string()
                    .contains("drive-relative")
            );
        }
    }
}

#[cfg(test)]
mod project_resolution_tests {
    #[test]
    fn advertised_home_forms_expand_without_using_the_default_project() {
        let home = std::env::current_dir().unwrap().canonicalize().unwrap();
        for input in ["~", "~/", "~/.", "~\\", "~\\."] {
            assert_eq!(
                super::resolve_chat_project(&std::env::temp_dir(), input, Some(&home)).unwrap(),
                home
            );
        }
        assert!(
            super::resolve_chat_project(&home, "~", None)
                .unwrap_err()
                .to_string()
                .contains("Cannot expand ~")
        );
        assert!(
            super::resolve_chat_project(&home, "~", Some(std::path::Path::new("relative-home")))
                .is_err()
        );
    }
}
