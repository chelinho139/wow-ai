use crate::{config::read_bounded, publication::atomic_write};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    io,
    path::{Path, PathBuf},
};

#[derive(Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct State {
    pub schema_version: u32,
    pub next_id: u64,
    #[serde(default)]
    pub history_pruned: bool,
    #[serde(default)]
    pub presence_counter: u16,
    #[serde(default)]
    pub handled_live: Vec<(String, u64)>,
    #[serde(default)]
    pub game_context: Option<String>,
    pub sessions: BTreeMap<String, Session>,
    pub history: BTreeMap<String, Vec<Message>>,
    #[serde(default)]
    pub pending: Option<PendingReply>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PendingReply {
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub effort: String,
    #[serde(default)]
    pub addon_dir: Option<PathBuf>,
    pub chat: String,
    pub id: u64,
    pub agent: crate::agents::AgentKind,
    pub project: PathBuf,
    pub text: String,
    pub session: Option<String>,
    pub denied: Vec<String>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Session {
    #[serde(default)]
    pub config_fingerprint: String,
    pub agent: String,
    pub project: PathBuf,
    pub id: String,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Message {
    pub role: String,
    pub text: String,
    pub truncated: bool,
    pub id: u64,
    pub agent: String,
}
impl State {
    pub fn load(dir: &Path) -> io::Result<Self> {
        let path = dir.join("reforged-state.json");
        if let Ok(meta) = std::fs::symlink_metadata(&path)
            && !meta.file_type().is_file()
        {
            return Err(io::Error::other("Rust state must be a regular file"));
        }
        let bytes = match read_bounded(&path, 4_194_304) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                return Ok(Self {
                    schema_version: 1,
                    next_id: 1,
                    ..Self::default()
                });
            }
            Err(e) => return Err(e),
        };
        let state: Self = serde_json::from_slice(&bytes).map_err(io::Error::other)?;
        if state.schema_version != 1
            || state.next_id == 0
            || state.next_id >= (1_u64 << 53)
            || state.history.len() > 16
        {
            return Err(io::Error::other("invalid Rust state schema or bounds"));
        }
        Ok(state)
    }
    pub fn save(&self, dir: &Path) -> io::Result<()> {
        let bytes = serde_json::to_vec_pretty(self).map_err(io::Error::other)?;
        if bytes.len() > 4_194_304 {
            return Err(io::Error::other("Rust history exceeds storage budget"));
        }
        atomic_write(&dir.join("reforged-state.json"), &bytes)
    }
    pub fn record(
        &mut self,
        chat: &str,
        role: &str,
        text: &str,
        id: u64,
        agent: &str,
    ) -> io::Result<()> {
        if !self.history.contains_key(chat) && self.history.len() >= 16 {
            return Err(io::Error::other("maximum 16 stored chats reached"));
        }
        let mut end = text.len().min(4000);
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        let messages = self.history.entry(chat.into()).or_default();
        messages.push(Message {
            role: role.into(),
            text: text[..end].into(),
            truncated: end < text.len(),
            id,
            agent: agent.into(),
        });
        if messages.len() > 40 {
            messages.drain(..messages.len() - 40);
        }
        // Reserve room for sessions and a worst-case escaped pending reply.
        while serde_json::to_vec_pretty(&self.history)
            .map_err(io::Error::other)?
            .len()
            > 2_000_000
        {
            let oldest = self
                .history
                .iter()
                .filter_map(|(chat, messages)| messages.first().map(|m| (m.id, chat.clone())))
                .min();
            if let Some((_, chat)) = oldest {
                self.history.get_mut(&chat).unwrap().remove(0);
                self.history_pruned = true;
            } else {
                return Err(io::Error::other("history budget cannot be satisfied"));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn serialized_history_budget_accounts_for_control_character_escaping() {
        let mut state = State::default();
        state.history.insert(
            "old".into(),
            vec![Message {
                role: "user".into(),
                text: "\0".repeat(400000),
                truncated: false,
                id: 1,
                agent: "codex".into(),
            }],
        );
        state
            .record("new", "assistant", "reply", 2, "codex")
            .unwrap();
        assert!(state.history_pruned);
        assert!(serde_json::to_vec_pretty(&state.history).unwrap().len() <= 2_000_000);
        assert_eq!(state.history["new"][0].text, "reply");
    }
}
