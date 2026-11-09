//! Read-only agent discovery. npm launchers are inspected, never executed.
use crate::{
    agents::{AgentKind, AgentSettings},
    config::read_bounded,
};
use serde::Serialize;
use std::{
    collections::BTreeMap,
    env, io,
    path::{Path, PathBuf},
};

pub const AGENTS: [AgentKind; 6] = [
    AgentKind::Claude,
    AgentKind::Codex,
    AgentKind::Grok,
    AgentKind::Agy,
    AgentKind::Hermes,
    AgentKind::Gemini,
];
#[derive(Clone)]
pub struct Environment {
    pub windows: bool,
    pub arm64: bool,
    pub paths: Vec<PathBuf>,
    pub home: Option<PathBuf>,
    pub appdata: Option<PathBuf>,
    pub local_appdata: Option<PathBuf>,
    pub codex_bin: Option<PathBuf>,
    pub grok_home: Option<PathBuf>,
}
impl Environment {
    pub fn current() -> Self {
        Self {
            windows: cfg!(windows),
            arm64: cfg!(target_arch = "aarch64"),
            paths: env::var_os("PATH")
                .map(|p| {
                    env::split_paths(&p)
                        .filter(|p| !p.as_os_str().is_empty())
                        .collect()
                })
                .unwrap_or_default(),
            home: env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(Into::into),
            appdata: env::var_os("APPDATA").map(Into::into),
            local_appdata: env::var_os("LOCALAPPDATA").map(Into::into),
            codex_bin: env::var_os("CODEX_BIN")
                .filter(|p| !p.is_empty())
                .map(Into::into),
            grok_home: env::var_os("GROK_HOME").map(Into::into),
        }
    }
    fn paths(&self) -> Vec<PathBuf> {
        let mut paths = self.paths.clone();
        if self.windows
            && let Some(root) = &self.appdata
        {
            paths.push(root.join("npm"));
        }
        paths
    }
    fn known(&self, kind: AgentKind) -> Vec<PathBuf> {
        let mut out = Vec::new();
        if let Some(home) = &self.home {
            if kind == AgentKind::Claude {
                out.push(home.join(if self.windows {
                    ".local/bin/claude.exe"
                } else {
                    ".local/bin/claude"
                }));
            }
            if kind == AgentKind::Grok {
                out.push(
                    self.grok_home
                        .clone()
                        .unwrap_or_else(|| home.join(".grok"))
                        .join(if self.windows {
                            "bin/grok.exe"
                        } else {
                            "bin/grok"
                        }),
                );
            }
        } else if kind == AgentKind::Grok
            && let Some(root) = &self.grok_home
        {
            out.push(root.join(if self.windows {
                "bin/grok.exe"
            } else {
                "bin/grok"
            }));
        }
        if self.windows
            && let Some(root) = &self.local_appdata
        {
            match kind {
                AgentKind::Codex => out.push(root.join("Programs/OpenAI/Codex/bin/codex.exe")),
                AgentKind::Agy => out.push(root.join("agy/bin/agy.exe")),
                _ => {}
            }
        }
        out
    }
}
#[derive(Debug, Serialize)]
pub struct Resolved {
    pub executable: PathBuf,
    pub launcher_args: Vec<String>,
}
#[derive(Serialize)]
pub struct Detection {
    pub agent: &'static str,
    pub found: bool,
    pub executable: Option<PathBuf>,
    pub launcher_args: Vec<String>,
    pub note: String,
}

fn candidate(path: &Path) -> bool {
    path.is_file()
}

fn native(path: &Path, _context: &Environment) -> Option<PathBuf> {
    candidate(path).then(|| path.canonicalize().ok()).flatten()
}
fn extension(path: &Path, ext: &str) -> bool {
    path.extension()
        .is_some_and(|s| s.eq_ignore_ascii_case(ext))
}
fn node(context: &Environment, beside: &Path) -> Option<PathBuf> {
    if context.windows
        && let Some(path) = native(&beside.join("node.exe"), context)
    {
        return Some(path);
    }
    context.paths().into_iter().find_map(|dir| {
        native(
            &dir.join(if context.windows { "node.exe" } else { "node" }),
            context,
        )
    })
}
fn native_next_to(script: &Path, kind: AgentKind, context: &Environment) -> Vec<PathBuf> {
    let Some(pkg) = script.parent().and_then(Path::parent) else {
        return vec![];
    };
    let Some(scope) = pkg.parent() else {
        return vec![];
    };
    let arch = if context.arm64 { "arm64" } else { "x64" };
    let triple = if context.arm64 {
        "aarch64-pc-windows-msvc"
    } else {
        "x86_64-pc-windows-msvc"
    };
    match kind {
        AgentKind::Codex => {
            let mut paths = Vec::new();
            for base in [
                scope.join(format!("codex-win32-{arch}")),
                pkg.join("node_modules/@openai")
                    .join(format!("codex-win32-{arch}")),
                pkg.into(),
            ] {
                for folder in ["bin", "codex", ""] {
                    paths.push(
                        base.join("vendor")
                            .join(triple)
                            .join(folder)
                            .join("codex.exe"),
                    );
                }
            }
            paths
        }
        AgentKind::Grok => vec![scope.join(format!("grok-win32-{arch}/bin/grok.exe"))],
        _ => vec![],
    }
}
fn script_target(shim: &Path) -> Result<PathBuf, String> {
    let bytes = read_bounded(shim, 65536).map_err(|e| e.to_string())?;
    let source = std::str::from_utf8(&bytes).map_err(|_| "npm launcher is not UTF-8")?;
    for quoted in source.split('"').skip(1).step_by(2) {
        let lower = quoted.to_ascii_lowercase();
        for prefix in ["%~dp0%", "%dp0%", "%~dp0"] {
            if lower.starts_with(prefix) {
                let relative = &quoted[prefix.len()..];
                let Some(relative) = relative
                    .strip_prefix('\\')
                    .or_else(|| relative.strip_prefix('/'))
                else {
                    continue;
                };
                let parts: PathBuf = relative.split(['\\', '/']).collect();
                if parts
                    .file_name()
                    .is_some_and(|p| p.eq_ignore_ascii_case("node.exe"))
                {
                    continue;
                }
                let path = shim.parent().ok_or("launcher has no parent")?.join(parts);
                if path.is_file() {
                    return path.canonicalize().map_err(|e| e.to_string());
                }
            }
        }
    }
    Err(
        "could not resolve npm launcher; configure the underlying executable or JS entry point"
            .into(),
    )
}
fn from_path(path: &Path, kind: AgentKind, context: &Environment) -> Result<Resolved, String> {
    if !path.is_file() {
        return Err(format!("file does not exist: {}", path.display()));
    }
    if extension(path, "ps1") {
        return Err("PowerShell launchers are not executed; omit executable for auto-detection or select the npm .cmd launcher".into());
    }
    if extension(path, "cmd") || extension(path, "bat") {
        let script = script_target(path)?;
        for exe in native_next_to(&script, kind, context) {
            if let Some(executable) = native(&exe, context) {
                return Ok(Resolved {
                    executable,
                    launcher_args: vec![],
                });
            }
        }
        if extension(&script, "exe") {
            return from_path(&script, kind, context);
        }
        let executable = node(context, path.parent().unwrap()).ok_or(
            "npm agent requires Node to launch its script; Node is not installed or not on PATH",
        )?;
        return Ok(Resolved {
            executable,
            launcher_args: vec![script.to_string_lossy().into_owned()],
        });
    }
    if ["js", "mjs", "cjs"].iter().any(|ext| extension(path, ext)) {
        let executable = node(context, path.parent().unwrap())
            .ok_or("configured JS agent requires Node; configure node.exe or add Node to PATH")?;
        return Ok(Resolved {
            executable,
            launcher_args: vec![
                path.canonicalize()
                    .map_err(|e| e.to_string())?
                    .to_string_lossy()
                    .into_owned(),
            ],
        });
    }
    let executable = native(path, context)
        .ok_or_else(|| format!("agent is not executable: {}", path.display()))?;
    Ok(Resolved {
        executable,
        launcher_args: vec![],
    })
}

/// Configured paths take precedence and never silently fall back to another agent.
pub fn resolve(
    kind: AgentKind,
    settings: &AgentSettings,
    base: &Path,
    context: &Environment,
) -> Result<Resolved, String> {
    if !settings.executable.as_os_str().is_empty() {
        let path = crate::process::resolve_path(base, &settings.executable);
        let mut found = from_path(&path, kind, context)?;
        found.launcher_args.extend(settings.launcher_args.clone());
        return Ok(found);
    }
    if !settings.launcher_args.is_empty() {
        return Err("launcher_args requires an explicit executable".into());
    }
    if kind == AgentKind::Codex
        && let Some(path) = &context.codex_bin
        && let Ok(found) = from_path(path, kind, context)
    {
        return Ok(found);
    }
    for path in context.known(kind) {
        if let Ok(found) = from_path(&path, kind, context) {
            return Ok(found);
        }
    }
    let paths = context.paths();
    let filename = if context.windows {
        format!("{}.exe", kind.id())
    } else {
        kind.id().into()
    };
    for dir in &paths {
        if let Ok(found) = from_path(&dir.join(&filename), kind, context) {
            return Ok(found);
        }
    }
    let mut launcher_error = None;
    if context.windows {
        for dir in &paths {
            let path = dir.join(format!("{}.cmd", kind.id()));
            if !path.is_file() {
                continue;
            }
            match from_path(&path, kind, context) {
                Ok(found) => return Ok(found),
                Err(error) => {
                    if launcher_error.is_none() {
                        launcher_error = Some(error);
                    }
                }
            }
        }
    }
    if let Some(error) = launcher_error {
        return Err(format!(
            "{} launcher was found but cannot be resolved: {error}",
            kind.id()
        ));
    }
    Err(format!(
        "{} was not found. {}",
        kind.id(),
        install_hint(kind)
    ))
}
pub fn install_hint(kind: AgentKind) -> &'static str {
    match kind {
        AgentKind::Codex => {
            "Install Codex CLI (https://learn.chatgpt.com/docs/codex/cli), run codex to sign in, then retry."
        }
        AgentKind::Claude => {
            "Install Claude Code (https://code.claude.com/docs/en/setup), run claude to sign in, then retry."
        }
        AgentKind::Grok => {
            "Install Grok Build (https://docs.x.ai/build), run grok login, then retry."
        }
        AgentKind::Agy => "Install Antigravity CLI (agy) and sign in, then retry.",
        AgentKind::Hermes => "Install Hermes Agent and run hermes setup, then retry.",
        AgentKind::Gemini => {
            "Install Gemini CLI (https://geminicli.com), run gemini to sign in, then retry."
        }
    }
}
pub fn report(
    settings: &BTreeMap<String, AgentSettings>,
    base: &Path,
    context: &Environment,
) -> Vec<Detection> {
    AGENTS
        .into_iter()
        .map(|kind| {
            let default = AgentSettings::default();
            match resolve(
                kind,
                settings.get(kind.id()).unwrap_or(&default),
                base,
                context,
            ) {
                Ok(found) => Detection {
                    agent: kind.id(),
                    found: true,
                    executable: Some(found.executable),
                    launcher_args: found.launcher_args,
                    note: String::new(),
                },
                Err(note) => Detection {
                    agent: kind.id(),
                    found: false,
                    executable: None,
                    launcher_args: vec![],
                    note: format!(
                        "{note} Set agents.{}.executable to override detection.",
                        kind.id()
                    ),
                },
            }
        })
        .collect()
}
pub fn inspect(path: Option<&Path>) -> io::Result<Vec<Detection>> {
    let (settings, base) = if let Some(path) = path {
        let path = path.canonicalize()?;
        let json: serde_json::Value =
            serde_json::from_slice(&read_bounded(&path, 65536)?).map_err(io::Error::other)?;
        let settings: BTreeMap<String, AgentSettings> = serde_json::from_value(
            json.get("agents")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({})),
        )
        .map_err(io::Error::other)?;
        for key in settings.keys() {
            let kind = AgentKind::parse_name(key).map_err(io::Error::other)?;
            if kind.id() != key {
                return Err(io::Error::other(
                    "agent configuration keys must use canonical lowercase names",
                ));
            }
        }
        (settings, path.parent().unwrap().to_path_buf())
    } else {
        (BTreeMap::new(), env::current_dir()?)
    };
    Ok(report(&settings, &base, &Environment::current()))
}
