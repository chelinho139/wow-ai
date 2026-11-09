//! One-shot injected chat pipeline. All publication stays in Rust-private data;
//! this intentionally does not acquire or write the shared live addon tree.
use crate::{
    agents::{self, AgentKind},
    config::Config,
    ownership::OwnershipGuard,
    process, publication,
    slots::{Reply, Snapshot, Status},
    state::{PendingReply, Session, State},
};
use serde::Serialize;
use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const MARKER: &str = ".wow-ai-reforged-data";

#[derive(Serialize)]
pub struct Injection {
    pub id: u64,
    pub agent: String,
    pub text: String,
    pub session: Option<String>,
    pub outbox: PathBuf,
}

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
fn directory(path: &Path) -> io::Result<()> {
    match fs::create_dir(path) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(e),
    }
    if !fs::symlink_metadata(path)?.file_type().is_dir() {
        return Err(io::Error::other(
            "Rust output directory is not a regular directory",
        ));
    }
    Ok(())
}
pub(crate) fn prepare_outbox(dir: &Path) -> io::Result<PathBuf> {
    let outbox = dir.join("outbox");
    directory(&outbox)?;
    for addon in ["WoWAI", "WoWAI_S001"] {
        let folder = outbox.join(addon);
        directory(&folder)?;
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(folder.join("Inbox.lua"))
        {
            Ok(mut file) => file.write_all(b"-- Rust private outbox\n")?,
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e),
        }
    }
    Ok(outbox)
}

pub fn utc_timestamp(seconds: u64) -> io::Result<String> {
    if seconds >= 253402300800 {
        return Err(io::Error::other("timestamp out of range"));
    }
    let mut days = seconds / 86400;
    let mut year = 1970;
    let leap = |y| y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
    loop {
        let n = if leap(year) { 366 } else { 365 };
        if days < n {
            break;
        }
        days -= n;
        year += 1;
    }
    let months = [
        31,
        if leap(year) { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let mut month = 0;
    while days >= months[month] {
        days -= months[month];
        month += 1;
    }
    Ok(format!(
        "{year:04}-{:02}-{:02}T{:02}:{:02}:{:02}.000Z",
        month + 1,
        days + 1,
        seconds / 3600 % 24,
        seconds / 60 % 60,
        seconds % 60
    ))
}

struct Publisher<'a> {
    outbox: &'a Path,
    project: &'a Path,
    kind: AgentKind,
    chat: &'a str,
    id: u64,
    model: &'a str,
    effort: &'a str,
}
impl Publisher<'_> {
    fn publish(
        &self,
        status: Status,
        text: &str,
        session: &str,
        denied: Vec<String>,
    ) -> io::Result<()> {
        let Self {
            outbox,
            project,
            kind,
            chat,
            id,
            model,
            effort,
        } = *self;
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(io::Error::other)?
            .as_secs();
        let snapshot = Snapshot {
            online: None,
            timestamp: utc_timestamp(now)?,
            now_seconds: now,
            cwd: project.to_string_lossy().into_owned(),
            agent: kind.id().into(),
            agents: vec![kind.id().into()],
            capabilities: None,
            replies: vec![Reply {
                chat: chat.into(),
                id,
                status,
                text: text.into(),
                cwd: project.to_string_lossy().into_owned(),
                session: session.into(),
                agent: kind.id().into(),
                model: model.into(),
                effort: effort.into(),
                summary: None,
                denied,
            }],
        };
        let report = publication::publish(outbox, 1, &snapshot)?;
        if let Some((path, error)) = report.failed.first() {
            return Err(io::Error::other(format!(
                "publication failed at {}: {error}",
                path.display()
            )));
        }
        Ok(())
    }
}

pub fn inject(
    cfg: &Config,
    kind: AgentKind,
    chat: &str,
    prompt: &str,
    fresh_session: bool,
) -> io::Result<Injection> {
    if chat.is_empty() || chat.len() > 128 || chat.chars().any(char::is_control) {
        return Err(io::Error::other(
            "chat must be 1..128 bytes without control characters",
        ));
    }
    if prompt.trim().is_empty() || prompt.len() > 65536 {
        return Err(io::Error::other(
            "prompt must be nonempty and at most 65536 bytes",
        ));
    }
    let settings = cfg
        .agents
        .get(kind.id())
        .ok_or_else(|| io::Error::other("selected agent is not configured"))?;
    fs::create_dir_all(&cfg.data_dir)?;
    let private_dir = cfg.data_dir.canonicalize()?;
    ensure_private_data(&private_dir)?;
    let guard = OwnershipGuard::acquire(&private_dir)?;
    let dir = guard.data_dir();
    let mut state = State::load(dir)?;
    if state.pending.is_some() {
        return Err(io::Error::other(
            "a completed reply is awaiting publication; run recover --config <file> before injecting another prompt",
        ));
    }
    let effective = agents::effective_settings(kind, settings, "", "").map_err(io::Error::other)?;
    let settings = &effective.settings;
    let session = state
        .sessions
        .get(chat)
        .filter(|s| {
            !fresh_session
                && s.agent == kind.id()
                && s.project == cfg.project_dir
                && (s.config_fingerprint.is_empty()
                    || s.config_fingerprint == effective.fingerprint)
        })
        .map(|s| s.id.clone());
    if session.is_none() {
        state.sessions.remove(chat);
    }
    let prompt_file = dir.join("agent-prompt.txt");
    let invocation = agents::build(
        kind,
        settings,
        &cfg.project_dir,
        prompt,
        session.as_deref(),
        &prompt_file,
    )
    .map_err(io::Error::other)?;
    process::validate_program(&invocation.program)?;
    let outbox = prepare_outbox(dir)?;
    let id = state.next_id;
    state.next_id += 1;
    state.record(chat, "user", prompt, id, kind.id())?;
    // Reserve the ID before spawning. An interrupted attempt is never auto-replayed.
    state.save(dir)?;
    let publisher = Publisher {
        outbox: &outbox,
        project: &cfg.project_dir,
        kind,
        chat,
        id,
        model: &effective.model,
        effort: &effective.effort,
    };
    publisher.publish(
        Status::Working,
        "Agent is running",
        session.as_deref().unwrap_or(""),
        vec![],
    )?;
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
        if parsed
            .session
            .as_ref()
            .is_some_and(|s| s.len() > 256 || s.chars().any(char::is_control))
            || parsed.denied.len() > 32
            || parsed.denied.iter().any(|s| s.len() > 256)
        {
            return Err(io::Error::other(
                "agent result rejected: session/denial metadata exceeds supported bounds",
            ));
        }
        Ok(parsed)
    })();
    if invocation.prompt_file.is_some() {
        let _ = fs::remove_file(&prompt_file);
    }
    match outcome {
        Ok(output) => {
            if let Some(session) = &output.session {
                state.sessions.insert(
                    chat.into(),
                    Session {
                        config_fingerprint: effective.fingerprint.clone(),
                        agent: kind.id().into(),
                        project: cfg.project_dir.clone(),
                        id: session.clone(),
                    },
                );
            } else {
                state.sessions.remove(chat);
            }
            state.record(chat, "assistant", &output.text, id, kind.id())?;
            state.pending = Some(PendingReply {
                model: effective.model.clone(),
                effort: effective.effort.clone(),
                addon_dir: None,
                chat: chat.into(),
                id,
                agent: kind,
                project: cfg.project_dir.clone(),
                text: output.text.clone(),
                session: output.session.clone(),
                denied: output.denied.clone(),
            });
            state.save(dir)?;
            publisher.publish(Status::Done, &output.text, output.session.as_deref().unwrap_or(""), output.denied)
                .map_err(|e| io::Error::other(format!("agent completed and reply was saved, but publication failed: {e}; use recover --config <file>, do not rerun the prompt")))?;
            state.pending = None;
            state.save(dir)?;
            Ok(Injection {
                id,
                agent: kind.id().into(),
                text: output.text,
                session: output.session,
                outbox,
            })
        }
        Err(error) => {
            let mut message = error.to_string();
            if message.len() > 16000 {
                let mut end = 16000;
                while !message.is_char_boundary(end) {
                    end -= 1;
                }
                message.truncate(end);
                message.push_str(" [diagnostic truncated]");
            }
            let mut failures = Vec::new();
            if let Err(e) = state
                .record(chat, "error", &message, id, kind.id())
                .and_then(|()| state.save(dir))
            {
                failures.push(format!("could not save error: {e}"));
            }
            if let Err(e) = publisher.publish(
                Status::Error,
                &message,
                session.as_deref().unwrap_or(""),
                vec![],
            ) {
                failures.push(format!("could not publish error: {e}"));
            }
            if !failures.is_empty() {
                return Err(io::Error::new(
                    error.kind(),
                    format!("{message}; additionally {}", failures.join("; ")),
                ));
            }
            Err(error)
        }
    }
}

/// Republish an already saved successful result without invoking any agent.
pub fn recover(cfg: &Config) -> io::Result<Injection> {
    ensure_private_data(&cfg.data_dir)?;
    let guard = OwnershipGuard::acquire(&cfg.data_dir)?;
    let dir = guard.data_dir();
    let mut state = State::load(dir)?;
    let pending = state
        .pending
        .clone()
        .ok_or_else(|| io::Error::other("no completed reply awaits publication"))?;
    if pending.addon_dir.is_some() {
        return Err(io::Error::other(
            "a live reply must be recovered by run with the same addon_dir",
        ));
    }
    let outbox = prepare_outbox(dir)?;
    Publisher {
        outbox: &outbox,
        project: &pending.project,
        kind: pending.agent,
        chat: &pending.chat,
        id: pending.id,
        model: &pending.model,
        effort: &pending.effort,
    }
    .publish(
        Status::Done,
        &pending.text,
        pending.session.as_deref().unwrap_or(""),
        pending.denied,
    )?;
    state.pending = None;
    state.save(dir)?;
    Ok(Injection {
        id: pending.id,
        agent: pending.agent.id().into(),
        text: pending.text,
        session: pending.session,
        outbox,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn utc_epoch_leap_day_and_bounds() {
        assert_eq!(utc_timestamp(0).unwrap(), "1970-01-01T00:00:00.000Z");
        assert_eq!(
            utc_timestamp(1700000000).unwrap(),
            "2023-11-14T22:13:20.000Z"
        );
        assert_eq!(
            utc_timestamp(951782400).unwrap(),
            "2000-02-29T00:00:00.000Z"
        );
        assert!(utc_timestamp(253402300800).is_err());
    }
}
