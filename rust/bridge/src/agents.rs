//! Pure command construction and output parsing for supported agent CLIs.
//!
//! This module never launches a process. The runtime owns output limits,
//! timeouts, process-tree cleanup, current-directory selection, and exit codes.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    ffi::OsString,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentKind {
    Claude,
    Codex,
    Grok,
    Agy,
    Hermes,
    Gemini,
}

impl AgentKind {
    pub const fn id(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Grok => "grok",
            Self::Agy => "agy",
            Self::Hermes => "hermes",
            Self::Gemini => "gemini",
        }
    }

    pub fn parse_name(value: &str) -> Result<Self, String> {
        match value.trim().to_ascii_lowercase().as_str() {
            "claude" => Ok(Self::Claude),
            "codex" => Ok(Self::Codex),
            "grok" => Ok(Self::Grok),
            "agy" => Ok(Self::Agy),
            "hermes" => Ok(Self::Hermes),
            "gemini" => Ok(Self::Gemini),
            _ => Err(format!("unknown agent: {value}")),
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum PermissionMode {
    #[default]
    #[serde(rename = "default")]
    Default,
    #[serde(rename = "acceptEdits")]
    AcceptEdits,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentSettings {
    pub executable: PathBuf,
    #[serde(default)]
    pub launcher_args: Vec<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub permission_mode: PermissionMode,
    #[serde(default)]
    pub allowed_tools: Vec<String>,
    #[serde(default)]
    pub denied_tools: Vec<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Invocation {
    pub program: PathBuf,
    pub args: Vec<OsString>,
    pub stdin: Option<Vec<u8>>,
    pub prompt_file: Option<Vec<u8>>,
    /// `None` removes an inherited variable; `Some` sets it.
    pub env: Vec<(OsString, Option<OsString>)>,
}

#[derive(Debug, Default, PartialEq, Eq, Serialize)]
pub struct AgentOutput {
    pub text: String,
    pub session: Option<String>,
    pub denied: Vec<String>,
    pub progress: Vec<String>,
}

pub fn build(
    kind: AgentKind,
    settings: &AgentSettings,
    cwd: &Path,
    prompt: &str,
    resume: Option<&str>,
    prompt_file: &Path,
) -> Result<Invocation, String> {
    if settings.executable.as_os_str().is_empty() {
        return Err("agent executable must not be empty".into());
    }
    if settings.launcher_args.iter().any(|value| value.is_empty()) {
        return Err("launcher arguments must not be empty".into());
    }
    if settings.model.as_deref() == Some("") {
        return Err("agent model must not be empty when configured".into());
    }
    validate_rules(kind, settings)?;
    if resume.is_some_and(str::is_empty) {
        return Err("resume session must not be empty".into());
    }
    if kind == AgentKind::Grok && prompt_file.as_os_str().is_empty() {
        return Err("Grok prompt file path must not be empty".into());
    }
    if kind == AgentKind::Agy && prompt.len() > 24_000 {
        return Err("Agy prompt exceeds the 24000-byte command-line limit".into());
    }

    let mut invocation = Invocation {
        program: settings.executable.clone(),
        args: settings.launcher_args.iter().map(OsString::from).collect(),
        stdin: None,
        prompt_file: None,
        env: Vec::new(),
    };
    match kind {
        AgentKind::Claude => build_claude(&mut invocation, settings, prompt, resume),
        AgentKind::Codex => build_codex(&mut invocation, settings, cwd, prompt, resume),
        AgentKind::Grok => build_grok(&mut invocation, settings, cwd, prompt, resume, prompt_file),
        AgentKind::Agy => build_agy(&mut invocation, settings, cwd, prompt, resume),
        AgentKind::Hermes => build_hermes(&mut invocation, settings, cwd, prompt, resume),
        AgentKind::Gemini => build_gemini(&mut invocation, settings, prompt, resume),
    }
    Ok(invocation)
}

fn validate_rules(kind: AgentKind, settings: &AgentSettings) -> Result<(), String> {
    if matches!(
        kind,
        AgentKind::Codex | AgentKind::Agy | AgentKind::Hermes | AgentKind::Gemini
    ) && (!settings.allowed_tools.is_empty() || !settings.denied_tools.is_empty())
    {
        return Err(format!(
            "{kind:?} does not have a verified allowed_tools/denied_tools mapping"
        ));
    }
    if settings
        .allowed_tools
        .iter()
        .chain(&settings.denied_tools)
        .any(|rule| rule.trim().is_empty())
    {
        return Err("tool rules must not be empty".into());
    }
    Ok(())
}

fn args(invocation: &mut Invocation, values: impl IntoIterator<Item = impl Into<OsString>>) {
    invocation.args.extend(values.into_iter().map(Into::into));
}

fn model(invocation: &mut Invocation, settings: &AgentSettings, flag: &str) {
    if let Some(value) = settings.model.as_deref().filter(|value| !value.is_empty()) {
        args(invocation, [flag, value]);
    }
}

fn build_claude(
    invocation: &mut Invocation,
    settings: &AgentSettings,
    prompt: &str,
    resume: Option<&str>,
) {
    let permission = match settings.permission_mode {
        PermissionMode::Default => "default",
        PermissionMode::AcceptEdits => "acceptEdits",
    };
    args(
        invocation,
        [
            "-p",
            "--output-format",
            "stream-json",
            "--verbose",
            "--permission-mode",
            permission,
        ],
    );
    if !settings.allowed_tools.is_empty() {
        invocation.args.push("--allowedTools".into());
        invocation
            .args
            .extend(settings.allowed_tools.iter().map(Into::into));
    }
    if !settings.denied_tools.is_empty() {
        invocation.args.push("--disallowedTools".into());
        invocation
            .args
            .extend(settings.denied_tools.iter().map(Into::into));
    }
    model(invocation, settings, "--model");
    if let Some(session) = resume {
        args(invocation, ["--resume", session]);
    }
    invocation.stdin = Some(prompt.as_bytes().to_vec());
    invocation.env.push(("CLAUDECODE".into(), None));
}

fn build_codex(
    invocation: &mut Invocation,
    settings: &AgentSettings,
    cwd: &Path,
    prompt: &str,
    resume: Option<&str>,
) {
    args(
        invocation,
        [
            OsString::from("exec"),
            "--json".into(),
            "--skip-git-repo-check".into(),
            "-C".into(),
            cwd.as_os_str().to_owned(),
            "--sandbox".into(),
            match settings.permission_mode {
                PermissionMode::Default => "read-only".into(),
                PermissionMode::AcceptEdits => "workspace-write".into(),
            },
        ],
    );
    model(invocation, settings, "-m");
    if let Some(session) = resume {
        args(invocation, ["resume", session]);
    }
    invocation.args.push("-".into());
    invocation.stdin = Some(prompt.as_bytes().to_vec());
}

fn build_grok(
    invocation: &mut Invocation,
    settings: &AgentSettings,
    cwd: &Path,
    prompt: &str,
    resume: Option<&str>,
    prompt_file: &Path,
) {
    args(
        invocation,
        [
            OsString::from("--no-auto-update"),
            "--output-format".into(),
            "streaming-json".into(),
            "--cwd".into(),
            cwd.as_os_str().to_owned(),
            "--prompt-file".into(),
            prompt_file.as_os_str().to_owned(),
            "--permission-mode".into(),
            "dontAsk".into(),
        ],
    );
    let mut allowed = Vec::new();
    if settings.permission_mode == PermissionMode::AcceptEdits {
        allowed.extend(["Edit".to_owned(), "Read".to_owned(), "Grep".to_owned()]);
    }
    for rule in &settings.allowed_tools {
        allowed.extend(grok_rules(rule));
    }
    for rule in dedup(allowed) {
        args(invocation, ["--allow", &rule]);
    }
    for rule in dedup(
        settings
            .denied_tools
            .iter()
            .flat_map(|rule| grok_rules(rule))
            .collect(),
    ) {
        args(invocation, ["--deny", &rule]);
    }
    model(invocation, settings, "-m");
    if let Some(session) = resume {
        args(invocation, ["-r", session]);
    }
    invocation.prompt_file = Some(prompt.as_bytes().to_vec());
    invocation
        .env
        .push(("GROK_DISABLE_AUTOUPDATER".into(), Some("1".into())));
}

fn build_agy(
    invocation: &mut Invocation,
    settings: &AgentSettings,
    cwd: &Path,
    prompt: &str,
    resume: Option<&str>,
) {
    invocation.args.push(format!("-p={prompt}").into());
    args(
        invocation,
        [
            OsString::from("--output-format"),
            "stream-json".into(),
            "--add-dir".into(),
            cwd.as_os_str().to_owned(),
            "--print-timeout".into(),
            "1800s".into(),
            "--mode".into(),
            match settings.permission_mode {
                PermissionMode::Default => "plan".into(),
                PermissionMode::AcceptEdits => "accept-edits".into(),
            },
        ],
    );
    if settings.permission_mode == PermissionMode::AcceptEdits {
        invocation.args.push("--disable-slash-commands".into());
    }
    if let Some(session) = resume {
        args(invocation, ["--conversation", session]);
    }
    model(invocation, settings, "--model");
}

fn build_hermes(
    invocation: &mut Invocation,
    settings: &AgentSettings,
    cwd: &Path,
    prompt: &str,
    resume: Option<&str>,
) {
    args(
        invocation,
        [
            OsString::from("chat"),
            "--query-file".into(),
            "-".into(),
            "-Q".into(),
            "--in".into(),
            cwd.as_os_str().to_owned(),
            "--source".into(),
            "tool".into(),
        ],
    );
    if let Some(session) = resume {
        args(invocation, ["--resume", session]);
    }
    model(invocation, settings, "-m");
    invocation.stdin = Some(prompt.as_bytes().to_vec());
}

fn build_gemini(
    invocation: &mut Invocation,
    settings: &AgentSettings,
    prompt: &str,
    resume: Option<&str>,
) {
    args(
        invocation,
        [
            "--prompt",
            prompt,
            "--output-format",
            "stream-json",
            "--approval-mode",
            match settings.permission_mode {
                PermissionMode::Default => "default",
                PermissionMode::AcceptEdits => "auto_edit",
            },
        ],
    );
    model(invocation, settings, "--model");
    if let Some(session) = resume {
        args(invocation, ["--resume", session]);
    }
}

fn grok_rules(rule: &str) -> Vec<String> {
    let rule = rule.trim();
    if let Some(command) = rule
        .strip_prefix("Bash(")
        .and_then(|rule| rule.strip_suffix(":*)"))
        .filter(|command| !command.is_empty() && !command.chars().any(char::is_whitespace))
    {
        vec![format!("Bash({command} *)"), format!("Bash({command})")]
    } else {
        vec![rule.to_owned()]
    }
}

fn dedup(values: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .filter(|value| seen.insert(value.clone()))
        .collect()
}

pub fn parse(kind: AgentKind, stdout: &[u8]) -> Result<AgentOutput, String> {
    if kind == AgentKind::Hermes {
        // Hermes' legacy session marker is written to stderr. This pure stdout
        // parser intentionally returns no newly discovered session id.
        let text = std::str::from_utf8(stdout)
            .map_err(|error| format!("Hermes output is not UTF-8: {error}"))?
            .trim()
            .to_owned();
        if text.is_empty() {
            return Err("Hermes returned an empty reply".into());
        }
        return Ok(AgentOutput {
            text,
            ..AgentOutput::default()
        });
    }
    let events = json_lines(stdout)?;
    match kind {
        AgentKind::Claude => parse_claude(events),
        AgentKind::Codex => parse_codex(events),
        AgentKind::Grok => parse_grok(events),
        AgentKind::Agy => parse_agy(events),
        AgentKind::Gemini => parse_gemini(events),
        AgentKind::Hermes => unreachable!(),
    }
}

/// Parses an agent reply and includes metadata emitted on stderr by legacy
/// text-stream agents. JSON-stream agents intentionally ignore stderr here.
pub fn parse_with_stderr(
    kind: AgentKind,
    stdout: &[u8],
    stderr: &[u8],
) -> Result<AgentOutput, String> {
    let mut output = parse(kind, stdout)?;
    if kind == AgentKind::Hermes {
        output.session = hermes_session(stderr);
    }
    Ok(output)
}

fn hermes_session(stderr: &[u8]) -> Option<String> {
    let clean = strip_ansi_csi(&String::from_utf8_lossy(stderr));
    clean.lines().find_map(|line| {
        let marker = "session_id:";
        let start = line.to_ascii_lowercase().find(marker)? + marker.len();
        let token = line[start..].split_whitespace().next().unwrap_or_default();
        if token.is_empty() {
            return None;
        }
        let mut end = token.len().min(256);
        while !token.is_char_boundary(end) {
            end -= 1;
        }
        Some(token[..end].to_owned())
    })
}

fn strip_ansi_csi(value: &str) -> String {
    let mut clean = String::with_capacity(value.len());
    let mut chars = value.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '\u{1b}' {
            clean.push(ch);
            continue;
        }
        if chars.next_if_eq(&'[').is_some() {
            for byte in chars.by_ref() {
                if ('@'..='~').contains(&byte) {
                    break;
                }
            }
        }
    }
    clean
}

fn json_lines(stdout: &[u8]) -> Result<Vec<Value>, String> {
    let text = std::str::from_utf8(stdout)
        .map_err(|error| format!("agent output is not UTF-8: {error}"))?;
    text.lines()
        .enumerate()
        .filter(|(_, line)| !line.trim().is_empty())
        .map(|(index, line)| {
            serde_json::from_str(line)
                .map_err(|error| format!("invalid JSON on output line {}: {error}", index + 1))
        })
        .collect()
}

fn parse_claude(events: Vec<Value>) -> Result<AgentOutput, String> {
    let mut out = AgentOutput::default();
    let mut terminal = false;
    for event in events {
        ensure_before_terminal(terminal)?;
        set_session(&mut out, event.get("session_id"));
        match string(&event, "type") {
            Some("assistant") => {
                if let Some(blocks) = event.pointer("/message/content").and_then(Value::as_array) {
                    for block in blocks {
                        if string(block, "type") == Some("text") {
                            push_progress(&mut out, string(block, "text").unwrap_or_default());
                        } else if string(block, "type") == Some("tool_use") {
                            push_progress(
                                &mut out,
                                &format!("tool: {}", string(block, "name").unwrap_or("unknown")),
                            );
                        }
                    }
                }
            }
            Some("result") => {
                terminal = true;
                if event
                    .get("is_error")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    return Err(format!(
                        "Claude failed: {}",
                        value_text(event.get("result"))
                    ));
                }
                out.text = value_text(event.get("result"));
                if let Some(denials) = event.get("permission_denials").and_then(Value::as_array) {
                    for denial in denials {
                        let tool = string(denial, "tool_name").unwrap_or("Tool");
                        let command = denial
                            .pointer("/tool_input/command")
                            .and_then(Value::as_str);
                        out.denied.push(rule_for(tool, command));
                    }
                    out.denied = dedup(out.denied);
                }
            }
            _ => {}
        }
    }
    finish(out, terminal, "Claude")
}

fn parse_codex(events: Vec<Value>) -> Result<AgentOutput, String> {
    let mut out = AgentOutput::default();
    let mut last = None;
    let mut terminal = false;
    for event in events {
        ensure_before_terminal(terminal)?;
        match string(&event, "type") {
            Some("thread.started") => set_session(&mut out, event.get("thread_id")),
            Some("item.completed") => {
                let item = &event["item"];
                match string(item, "type") {
                    Some("agent_message") => {
                        let text = string(item, "text").unwrap_or_default().to_owned();
                        push_progress(&mut out, &text);
                        last = Some(text);
                    }
                    Some("reasoning") => push_progress(
                        &mut out,
                        &format!("~ {}", string(item, "text").unwrap_or_default()),
                    ),
                    Some("command_execution") => {
                        let command = string(item, "command").unwrap_or_default();
                        push_progress(&mut out, &format!("$ {}", first_line(command)));
                        if string(item, "status") == Some("declined") {
                            out.denied.push(rule_for("Bash", Some(command)));
                        }
                    }
                    _ => {}
                }
            }
            Some("turn.completed") => {
                terminal = true;
                out.text = last.take().unwrap_or_default();
            }
            Some("turn.failed") => {
                return Err(format!(
                    "Codex failed: {}",
                    event
                        .pointer("/error/message")
                        .and_then(Value::as_str)
                        .unwrap_or("turn failed")
                ));
            }
            Some("error") => {
                return Err(format!(
                    "Codex failed: {}",
                    string(&event, "message").unwrap_or("unknown error")
                ));
            }
            _ => {}
        }
    }
    finish(out, terminal, "Codex")
}

fn parse_grok(events: Vec<Value>) -> Result<AgentOutput, String> {
    let mut out = AgentOutput::default();
    let mut current = String::new();
    let mut previous = String::new();
    let mut calls = HashMap::new();
    let mut terminal = false;
    for event in events {
        ensure_before_terminal(terminal)?;
        match string(&event, "type") {
            Some("text") => current.push_str(event_chunk(&event)),
            Some("thought") => push_progress(&mut out, &format!("~ {}", event_chunk(&event))),
            Some("tool_call") => {
                if !current.trim().is_empty() {
                    previous = current.clone();
                    push_progress(&mut out, &current);
                    current.clear();
                }
                let (line, rule) = grok_call(&event);
                push_progress(&mut out, &line);
                if let (Some(id), Some(rule)) = (string(&event, "toolCallId"), rule) {
                    calls.insert(id.to_owned(), rule);
                }
            }
            Some("tool_call_update") => {
                let status = string(&event, "status").unwrap_or_default();
                if ["denied", "rejected", "refused"].contains(&status)
                    && let Some(rule) = string(&event, "toolCallId").and_then(|id| calls.get(id))
                {
                    out.denied.push(rule.clone());
                }
            }
            Some("end") => {
                terminal = true;
                set_session(
                    &mut out,
                    event.get("sessionId").or_else(|| event.get("session_id")),
                );
                out.text = if current.trim().is_empty() {
                    previous.trim().to_owned()
                } else {
                    current.trim().to_owned()
                };
            }
            Some("error") => {
                return Err(format!(
                    "Grok failed: {}",
                    string(&event, "message").unwrap_or("unknown error")
                ));
            }
            _ => {}
        }
    }
    out.denied = dedup(out.denied);
    finish(out, terminal, "Grok")
}

fn parse_agy(events: Vec<Value>) -> Result<AgentOutput, String> {
    let mut out = AgentOutput::default();
    let mut response = String::new();
    let mut terminal = false;
    for event in events {
        ensure_before_terminal(terminal)?;
        if string(&event, "event") == Some("init") {
            set_session(&mut out, event.get("conversation_id"));
        } else if string(&event, "event") == Some("step_update") {
            let step = &event["step_update"];
            if string(step, "step_type") == Some("agent_response") {
                response.push_str(string(step, "text_delta").unwrap_or_default());
            } else if string(step, "step_type") == Some("tool")
                && string(step, "state") == Some("ACTIVE")
            {
                push_progress(
                    &mut out,
                    &format!("tool: {}", string(step, "tool_name").unwrap_or("unknown")),
                );
            }
        } else if string(&event, "event") == Some("result") {
            terminal = true;
            let result = &event["result"];
            set_session(&mut out, result.get("conversation_id"));
            if string(result, "status") != Some("SUCCESS") {
                return Err(format!(
                    "agy failed: {}",
                    string(result, "status").unwrap_or("unknown status")
                ));
            }
            out.text = string(result, "response")
                .map(str::to_owned)
                .unwrap_or_else(|| std::mem::take(&mut response));
        }
    }
    finish(out, terminal, "agy")
}

fn parse_gemini(events: Vec<Value>) -> Result<AgentOutput, String> {
    let mut out = AgentOutput::default();
    let mut terminal = false;
    for event in events {
        ensure_before_terminal(terminal)?;
        match string(&event, "type") {
            Some("init") => set_session(&mut out, event.get("session_id")),
            Some("message") if string(&event, "role") == Some("assistant") => {
                let content = string(&event, "content").unwrap_or_default();
                if event.get("delta").and_then(Value::as_bool).unwrap_or(false) {
                    out.text.push_str(content);
                } else {
                    out.text = content.to_owned();
                }
            }
            Some("tool_use") => push_progress(
                &mut out,
                &format!("tool: {}", string(&event, "tool_name").unwrap_or("unknown")),
            ),
            Some("error") => {
                let message = string(&event, "message").unwrap_or("unknown error");
                if string(&event, "severity") == Some("warning") {
                    push_progress(&mut out, &format!("warning: {message}"));
                } else {
                    return Err(format!("Gemini failed: {message}"));
                }
            }
            Some("result") => {
                terminal = true;
                if string(&event, "status") != Some("success") {
                    return Err(format!(
                        "Gemini failed: {}",
                        string(&event, "status").unwrap_or("unknown status")
                    ));
                }
            }
            _ => {}
        }
    }
    finish(out, terminal, "Gemini")
}

fn finish(out: AgentOutput, terminal: bool, agent: &str) -> Result<AgentOutput, String> {
    if !terminal {
        return Err(format!("{agent} output ended without a terminal result"));
    }
    if out.text.trim().is_empty() {
        return Err(format!("{agent} returned an empty reply"));
    }
    Ok(out)
}

fn ensure_before_terminal(terminal: bool) -> Result<(), String> {
    if terminal {
        Err("agent emitted output after its terminal result".into())
    } else {
        Ok(())
    }
}

fn string<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn set_session(out: &mut AgentOutput, value: Option<&Value>) {
    if let Some(session) = value
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        out.session = Some(session.to_owned());
    }
}

fn value_text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(value) => serde_json::to_string_pretty(value).unwrap_or_default(),
        None => String::new(),
    }
}

fn push_progress(out: &mut AgentOutput, value: &str) {
    let compact = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.is_empty() {
        return;
    }
    let mut end = compact.len().min(140);
    while !compact.is_char_boundary(end) {
        end -= 1;
    }
    let suffix = if end < compact.len() { "..." } else { "" };
    out.progress.push(format!("{}{suffix}", &compact[..end]));
}

fn first_line(value: &str) -> &str {
    value.lines().next().unwrap_or_default().trim()
}

fn rule_for(tool: &str, command: Option<&str>) -> String {
    if tool == "Bash"
        && let Some(command) = command
        && let Some(program) = command.split_whitespace().next()
    {
        return format!("Bash({program}:*)");
    }
    tool.to_owned()
}

fn event_chunk(event: &Value) -> &str {
    event
        .get("data")
        .and_then(|data| data.as_str().or_else(|| string(data, "text")))
        .or_else(|| string(event, "text"))
        .unwrap_or_default()
}

fn grok_call(event: &Value) -> (String, Option<String>) {
    let tool = string(event, "toolName")
        .or_else(|| string(event, "title"))
        .unwrap_or("tool");
    let input = &event["rawInput"];
    if tool.contains("bash") || tool.contains("terminal") || tool == "run_terminal_command" {
        let command = string(input, "command").unwrap_or_default();
        return (
            format!("$ {}", first_line(command)),
            Some(rule_for("Bash", Some(command))),
        );
    }
    if tool == "web_search" {
        return (
            format!("search: {}", string(input, "query").unwrap_or_default()),
            Some("WebSearch".into()),
        );
    }
    if tool == "web_fetch" {
        return (
            format!("fetch {}", string(input, "url").unwrap_or_default()),
            Some("WebFetch".into()),
        );
    }
    if tool.contains("write") || tool.contains("edit") || tool.contains("replace") {
        return (format!("edit {tool}"), Some("Edit".into()));
    }
    if tool.contains("read") || tool.contains("list") {
        return (format!("read {tool}"), Some("Read".into()));
    }
    (format!("tool: {tool}"), None)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings() -> AgentSettings {
        AgentSettings {
            executable: "agent.exe".into(),
            launcher_args: vec!["launcher".into()],
            model: Some("model".into()),
            permission_mode: PermissionMode::AcceptEdits,
            allowed_tools: Vec::new(),
            denied_tools: Vec::new(),
        }
    }

    fn strings(invocation: &Invocation) -> Vec<String> {
        invocation
            .args
            .iter()
            .map(|value| value.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn settings_are_strict_and_permission_names_match_existing_json() {
        assert_eq!(
            serde_json::from_str::<AgentSettings>(r#"{"executable":"agent"}"#)
                .unwrap()
                .permission_mode,
            PermissionMode::Default
        );
        let parsed: AgentSettings =
            serde_json::from_str(r#"{"executable":"agent","permission_mode":"acceptEdits"}"#)
                .unwrap();
        assert_eq!(parsed.permission_mode, PermissionMode::AcceptEdits);
        assert!(
            serde_json::from_str::<AgentSettings>(
                r#"{"executable":"agent","permission_mode":"bypassPermissions"}"#
            )
            .is_err()
        );
        assert!(
            serde_json::from_str::<AgentSettings>(r#"{"executable":"agent","extra_args":[]}"#)
                .is_err()
        );
        for (name, expected) in [
            ("claude", AgentKind::Claude),
            ("CODEX", AgentKind::Codex),
            ("grok", AgentKind::Grok),
            ("agy", AgentKind::Agy),
            ("hermes", AgentKind::Hermes),
            ("gemini", AgentKind::Gemini),
        ] {
            assert_eq!(AgentKind::parse_name(name).unwrap(), expected);
            assert_eq!(expected.id(), name.to_ascii_lowercase());
        }
        assert!(AgentKind::parse_name("unknown").is_err());
    }

    #[test]
    fn builds_all_six_safe_invocations() {
        let cwd = Path::new("C:/project");
        let prompt_file = Path::new("C:/data/prompt.txt");
        for kind in [
            AgentKind::Claude,
            AgentKind::Codex,
            AgentKind::Grok,
            AgentKind::Agy,
            AgentKind::Hermes,
            AgentKind::Gemini,
        ] {
            let built = build(
                kind,
                &settings(),
                cwd,
                "hello",
                Some("session"),
                prompt_file,
            )
            .unwrap();
            assert_eq!(built.program, Path::new("agent.exe"));
            assert_eq!(strings(&built)[0], "launcher");
            assert!(strings(&built).iter().any(|value| value == "model"));
            assert!(strings(&built).iter().any(|value| value == "session"));
        }
        let gemini = build(
            AgentKind::Gemini,
            &settings(),
            cwd,
            "hello",
            None,
            prompt_file,
        )
        .unwrap();
        assert!(
            strings(&gemini)
                .windows(2)
                .any(|v| v == ["--approval-mode", "auto_edit"])
        );
        assert!(
            strings(&gemini)
                .windows(2)
                .any(|v| v == ["--output-format", "stream-json"])
        );

        let max_prompt = "x".repeat(24_000);
        assert!(
            build(
                AgentKind::Agy,
                &settings(),
                cwd,
                &max_prompt,
                None,
                prompt_file,
            )
            .is_ok()
        );
        assert!(
            build(
                AgentKind::Agy,
                &settings(),
                cwd,
                &(max_prompt + "x"),
                None,
                prompt_file,
            )
            .unwrap_err()
            .contains("24000-byte")
        );
    }

    #[test]
    fn permissions_are_restrictive_and_unsupported_rules_fail() {
        let mut configured = settings();
        configured.allowed_tools = vec!["WebSearch".into(), "Bash(git:*)".into()];
        configured.denied_tools = vec!["WebFetch".into()];
        let claude = build(
            AgentKind::Claude,
            &configured,
            Path::new("."),
            "p",
            None,
            Path::new("p"),
        )
        .unwrap();
        assert!(strings(&claude).contains(&"--disallowedTools".into()));
        let grok = build(
            AgentKind::Grok,
            &configured,
            Path::new("."),
            "p",
            None,
            Path::new("p"),
        )
        .unwrap();
        assert!(strings(&grok).contains(&"Bash(git *)".into()));
        assert!(strings(&grok).contains(&"--deny".into()));
        for kind in [
            AgentKind::Codex,
            AgentKind::Agy,
            AgentKind::Hermes,
            AgentKind::Gemini,
        ] {
            assert!(build(kind, &configured, Path::new("."), "p", None, Path::new("p")).is_err());
        }
        configured.allowed_tools.clear();
        configured.denied_tools.clear();
        configured.permission_mode = PermissionMode::Default;
        let codex = build(
            AgentKind::Codex,
            &configured,
            Path::new("."),
            "p",
            None,
            Path::new("p"),
        )
        .unwrap();
        assert!(strings(&codex).contains(&"read-only".into()));
        let agy = build(
            AgentKind::Agy,
            &configured,
            Path::new("."),
            "p",
            None,
            Path::new("p"),
        )
        .unwrap();
        assert!(strings(&agy).contains(&"plan".into()));
    }

    #[test]
    fn parses_success_for_all_six_agents() {
        let cases = [
            (
                AgentKind::Claude,
                "{\"type\":\"system\",\"session_id\":\"c1\"}\n{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"working\"}]}}\n{\"type\":\"result\",\"result\":\"done\",\"is_error\":false}\n",
            ),
            (
                AgentKind::Codex,
                "{\"type\":\"thread.started\",\"thread_id\":\"x1\"}\n{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"draft\"}}\n{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"done\"}}\n{\"type\":\"turn.completed\"}\n",
            ),
            (
                AgentKind::Grok,
                "{\"type\":\"text\",\"data\":\"do\"}\n{\"type\":\"text\",\"data\":\"ne\"}\n{\"type\":\"end\",\"sessionId\":\"g1\"}\n",
            ),
            (
                AgentKind::Agy,
                "{\"event\":\"init\",\"conversation_id\":\"a1\"}\n{\"event\":\"result\",\"result\":{\"status\":\"SUCCESS\",\"response\":\"done\"}}\n",
            ),
            (
                AgentKind::Gemini,
                "{\"type\":\"init\",\"session_id\":\"m1\"}\n{\"type\":\"message\",\"role\":\"assistant\",\"content\":\"do\",\"delta\":true}\n{\"type\":\"message\",\"role\":\"assistant\",\"content\":\"ne\",\"delta\":true}\n{\"type\":\"result\",\"status\":\"success\"}\n",
            ),
            (AgentKind::Hermes, "done\n"),
        ];
        for (kind, stream) in cases {
            let output = parse(kind, stream.as_bytes()).unwrap();
            assert_eq!(output.text, "done", "{kind:?}");
        }

        let hermes = parse_with_stderr(
            AgentKind::Hermes,
            b"done\n",
            b"\x1b[33mSESSION_ID:\x1b[0m 20260925_134414_e62607\n",
        )
        .unwrap();
        assert_eq!(hermes.session.as_deref(), Some("20260925_134414_e62607"));
    }

    #[test]
    fn extracts_denials_and_progress() {
        let claude = parse(AgentKind::Claude, br#"{"type":"result","result":"done","permission_denials":[{"tool_name":"Bash","tool_input":{"command":"cargo test"}},{"tool_name":"WebSearch"}]}
"#).unwrap();
        assert_eq!(claude.denied, ["Bash(cargo:*)", "WebSearch"]);
        let grok = parse(AgentKind::Grok, br#"{"type":"tool_call","toolCallId":"1","toolName":"bash","rawInput":{"command":"git status"}}
{"type":"tool_call_update","toolCallId":"1","status":"denied"}
{"type":"text","data":"done"}
{"type":"end"}
"#).unwrap();
        assert_eq!(grok.denied, ["Bash(git:*)"]);
        assert_eq!(grok.progress, ["$ git status"]);
    }

    #[test]
    fn malformed_missing_terminal_trailing_and_provider_errors_fail() {
        assert!(parse(AgentKind::Codex, b"not json\n").is_err());
        assert!(parse(AgentKind::Claude, b"{\"type\":\"assistant\"}\n").is_err());
        assert!(parse(AgentKind::Grok, b"{\"type\":\"end\"}\nnot json\n").is_err());
        assert!(
            parse(
                AgentKind::Gemini,
                b"{\"type\":\"result\",\"status\":\"success\"}\n{\"type\":\"message\"}\n"
            )
            .is_err()
        );
        assert!(
            parse(
                AgentKind::Codex,
                b"{\"type\":\"turn.failed\",\"error\":{\"message\":\"boom\"}}\n"
            )
            .unwrap_err()
            .contains("boom")
        );
        assert!(
            parse(
                AgentKind::Claude,
                b"{\"type\":\"result\",\"is_error\":true,\"result\":\"boom\"}\n"
            )
            .is_err()
        );
        assert!(
            parse(
                AgentKind::Grok,
                b"{\"type\":\"error\",\"message\":\"boom\"}\n"
            )
            .is_err()
        );
        assert!(
            parse(
                AgentKind::Agy,
                b"{\"event\":\"result\",\"result\":{\"status\":\"FAILED\"}}\n"
            )
            .is_err()
        );
        assert!(
            parse(
                AgentKind::Gemini,
                b"{\"type\":\"error\",\"severity\":\"error\",\"message\":\"boom\"}\n"
            )
            .is_err()
        );
        assert!(parse(AgentKind::Hermes, b"\xff").is_err());
        assert!(parse(AgentKind::Hermes, b"  \n").is_err());
    }
}
