use crate::{
    agents::{AgentKind, AgentSettings},
    process::{resolve_path, validate_program},
};
use serde::Deserialize;
use std::{
    collections::BTreeMap,
    fs::File,
    io::{self, Read},
    path::{Path, PathBuf},
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub schema_version: u32,
    pub project_dir: PathBuf,
    pub data_dir: PathBuf,
    #[serde(default)]
    pub addon_dir: Option<PathBuf>,
    pub agent: AgentKind,
    #[serde(default = "timeout")]
    pub timeout_ms: u64,
    #[serde(default = "output_limit")]
    pub max_output_bytes: usize,
    pub agents: BTreeMap<String, AgentSettings>,
}
fn timeout() -> u64 {
    1_800_000
}
fn output_limit() -> usize {
    1_048_576
}

pub fn read_bounded(path: &Path, limit: usize) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    File::open(path)?
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > limit {
        return Err(io::Error::other(format!(
            "file exceeds {limit} bytes: {}",
            path.display()
        )));
    }
    Ok(bytes)
}
impl Config {
    pub fn load(path: &Path) -> io::Result<Self> {
        let path = path.canonicalize()?;
        let mut cfg: Self =
            serde_json::from_slice(&read_bounded(&path, 65536)?).map_err(io::Error::other)?;
        if cfg.schema_version != 1 {
            return Err(io::Error::other("unsupported config schema_version"));
        }
        if !(1..=1_800_000).contains(&cfg.timeout_ms)
            || !(1024..=16_777_216).contains(&cfg.max_output_bytes)
        {
            return Err(io::Error::other("process limits outside supported range"));
        }
        let base = path.parent().unwrap();
        cfg.project_dir = resolve_path(base, &cfg.project_dir).canonicalize()?;
        if cfg.project_dir.as_os_str().len() > 32768 {
            return Err(io::Error::other("project path exceeds supported bound"));
        }
        if !cfg.project_dir.is_dir() {
            return Err(io::Error::other("project_dir is not a directory"));
        }
        cfg.data_dir = resolve_path(base, &cfg.data_dir);
        if let Some(ref addon_dir) = cfg.addon_dir {
            let resolved = resolve_path(base, addon_dir).canonicalize()?;
            if !resolved.is_dir() {
                return Err(io::Error::other("addon_dir is not a directory"));
            }
            cfg.addon_dir = Some(resolved);
        }
        for (name, agent) in &mut cfg.agents {
            let kind = AgentKind::parse_name(name).map_err(io::Error::other)?;
            if kind.id() != name {
                return Err(io::Error::other(
                    "agent configuration keys must use canonical lowercase names",
                ));
            }
            agent.executable = resolve_path(base, &agent.executable).canonicalize()?;
            validate_program(&agent.executable)?;
        }
        if !cfg.agents.contains_key(cfg.agent.id()) {
            return Err(io::Error::other(
                "default agent has no executable configuration",
            ));
        }
        Ok(cfg)
    }
}
