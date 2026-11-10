//! Basic-chat slot schema. Maps, macros and history restoration are deferred.
use crate::{agents::AgentCapability, protocol::lua_string};
use std::fmt::Write;

#[derive(Debug, Clone, Copy)]
pub enum Target {
    Inbox,
    Slot,
}

#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize)]
pub enum Status {
    Working,
    Done,
    Error,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Reply {
    pub chat: String,
    pub id: u64,
    pub status: Status,
    pub text: String,
    pub cwd: String,
    pub session: String,
    pub agent: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub effort: String,
    pub summary: Option<String>,
    pub denied: Vec<String>,
}

#[derive(Clone)]
pub struct DeletionAck {
    pub chat: String,
    pub session: String,
    pub id: u64,
}

/// Clock values are supplied by the runtime so publication is deterministic.
/// `timestamp` is the UTC ISO-8601 representation of `now_seconds`.
pub struct Snapshot {
    /// Omitted for legacy-compatible private snapshots; live Rust publishes lifecycle.
    pub online: Option<bool>,
    pub deletions: Option<Vec<DeletionAck>>,
    pub timestamp: String,
    pub now_seconds: u64,
    pub cwd: String,
    pub agent: String,
    pub agents: Vec<String>,
    /// Versioned configuration choices advertised to capable addon clients.
    /// `None` preserves the legacy slot schema for compatibility snapshots.
    pub capabilities: Option<Vec<AgentCapability>>,
    pub replies: Vec<Reply>,
}

fn strings(values: &[String]) -> String {
    values
        .iter()
        .map(|s| lua_string(s))
        .collect::<Vec<_>>()
        .join(", ")
}

pub fn serialize(target: Target, snapshot: &Snapshot) -> Result<String, &'static str> {
    if snapshot.now_seconds > (1_u64 << 53) - 1
        || snapshot.replies.iter().any(|r| r.id > (1_u64 << 53) - 1)
    {
        return Err("numeric value exceeds Lua/JavaScript safe integer range");
    }
    let name = match target {
        Target::Inbox => "WoWAI_Inbox",
        Target::Slot => "WoWAI_SlotData",
    };
    let mut out = format!(
        "-- Written by WoW AI Reforged. Do not edit by hand.\n{name} = {{\n\tts = {},\n\tnow = {},\n\tcwd = {},\n\tagent = {},\n\tagents = {{ {} }},\n",
        lua_string(&snapshot.timestamp),
        snapshot.now_seconds,
        lua_string(&snapshot.cwd),
        lua_string(&snapshot.agent),
        strings(&snapshot.agents)
    );
    if let Some(deletions) = &snapshot.deletions {
        if deletions.len() > 4096 || deletions.iter().any(|d| d.id == 0 || d.id >= (1_u64 << 53)) {
            return Err("invalid deletion acknowledgments");
        }
        out.push_str("\tdeletionAcks = {\n");
        for d in deletions {
            writeln!(
                out,
                "\t\t{{ chat = {}, session = {}, id = {} }},",
                lua_string(&d.chat),
                lua_string(&d.session),
                d.id
            )
            .unwrap();
        }
        out.push_str("\t},\n");
    }
    if let Some(online) = snapshot.online {
        writeln!(out, "\tbridgeOnline = {online},").unwrap();
    }
    if let Some(capabilities) = &snapshot.capabilities {
        out.push_str("\tcapabilities = {\n\t\tversion = 1,\n\t\tagents = {\n");
        for capability in capabilities {
            writeln!(
                out,
                "\t\t\t{{ id = {}, name = {}, available = {}, reason = {}, defaultModel = {}, defaultEffort = {}, models = {{",
                lua_string(&capability.id),
                lua_string(&capability.name),
                capability.available,
                lua_string(&capability.reason),
                lua_string(&capability.default_model),
                lua_string(&capability.default_effort),
            )
            .unwrap();
            for model in &capability.models {
                writeln!(
                    out,
                    "\t\t\t\t{{ id = {}, efforts = {{ {} }} }},",
                    lua_string(&model.id),
                    strings(&model.efforts),
                )
                .unwrap();
            }
            out.push_str("\t\t\t}, },\n");
        }
        out.push_str("\t\t},\n\t},\n");
    }
    out.push_str("\treplies = {\n");
    for r in &snapshot.replies {
        let status = match r.status {
            Status::Working => "working",
            Status::Done => "done",
            Status::Error => "error",
        };
        writeln!(out, "\t\t{{\n\t\t\tchat = {},\n\t\t\tid = {},\n\t\t\tstatus = {},\n\t\t\ttext = {},\n\t\t\tcwd = {},\n\t\t\tsession = {},\n\t\t\tagent = {},", lua_string(&r.chat), r.id, lua_string(status), lua_string(&r.text), lua_string(&r.cwd), lua_string(&r.session), lua_string(&r.agent)).unwrap();
        if !r.model.is_empty() {
            writeln!(out, "\t\t\tmodel = {},", lua_string(&r.model)).unwrap();
        }
        if !r.effort.is_empty() {
            writeln!(out, "\t\t\teffort = {},", lua_string(&r.effort)).unwrap();
        }
        if let Some(summary) = &r.summary
            && !summary.is_empty()
        {
            writeln!(out, "\t\t\tsummary = {},", lua_string(summary)).unwrap();
        }
        if !r.denied.is_empty() {
            writeln!(out, "\t\t\tdenied = {{ {} }},", strings(&r.denied)).unwrap();
        }
        out.push_str("\t\t},\n");
    }
    out.push_str("\t},\n}\n");
    Ok(out)
}
