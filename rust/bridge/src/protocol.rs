//! The addon's pixel payload protocol, matching `bridge/protocol.js`.

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Flags {
    pub new_session: bool,
    pub hello: bool,
    pub forget: bool,
    pub context: bool,
    pub allow: Vec<String>,
    pub agent: String,
    pub model: String,
    pub effort: String,
}

pub fn parse_flags(input: &str) -> Flags {
    let mut flags = Flags::default();
    for token in input.split(';') {
        match token {
            "n" => flags.new_session = true,
            "h" => flags.hello = true,
            "d" => flags.forget = true,
            "c" => flags.context = true,
            _ => {
                if let Some(rules) = token.strip_prefix("allow=") {
                    flags.allow.extend(
                        rules
                            .split(',')
                            .map(str::trim)
                            .filter(|rule| !rule.is_empty())
                            .map(str::to_owned),
                    );
                } else if let Some(agent) = token.strip_prefix("agent=") {
                    flags.agent = agent.trim().to_lowercase();
                } else if let Some(model) = token.strip_prefix("model=") {
                    flags.model = model.trim().to_owned();
                } else if let Some(effort) = token.strip_prefix("effort=") {
                    flags.effort = effort.trim().to_lowercase();
                }
            }
        }
    }
    flags
}

#[derive(Debug, PartialEq, Eq)]
pub struct Job {
    pub session: String,
    pub chat: String,
    pub id: u64,
    pub cwd: String,
    pub flags: Flags,
    /// Absent in the oldest pre-chat format; empty in the unnamed-chat format.
    pub name: Option<String>,
    pub text: String,
    /// `Some("")` clears context; `None` leaves existing context unchanged.
    pub context: Option<String>,
}

// JavaScript represents IDs as numbers. Reject values that cannot round-trip
// exactly instead of silently routing a rounded ID to another message.
const MAX_SAFE_ID: u64 = (1_u64 << 53) - 1;

fn message_id(value: &str) -> Option<u64> {
    if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    value.parse::<u64>().ok().filter(|id| *id <= MAX_SAFE_ID)
}

/// Parse current and historical record layouts. Malformed records are skipped.
/// Length/checksum validation belongs to the capture frame decoder, not this layer.
pub fn jobs_from_strip(header_id: u64, payload: &str) -> Vec<Job> {
    payload
        .split('\x1e')
        .filter_map(|record| {
            let fields: Vec<&str> = record.split('\x1f').collect();
            if fields.len() >= 6 {
                let id = message_id(fields[2])?;
                let flags = parse_flags(fields[4]);
                let named = fields.len() >= 7;
                let has_context = named && flags.context && fields.len() >= 8;
                let text_start = if has_context {
                    7
                } else if named {
                    6
                } else {
                    5
                };
                Some(Job {
                    session: fields[0].into(),
                    chat: fields[1].into(),
                    id,
                    cwd: fields[3].into(),
                    flags,
                    name: Some(if named {
                        fields[5].into()
                    } else {
                        String::new()
                    }),
                    text: fields[text_start..].join("\x1f"),
                    context: has_context.then(|| fields[6].into()),
                })
            } else if fields.len() == 4 && header_id <= MAX_SAFE_ID {
                Some(Job {
                    session: fields[0].into(),
                    chat: String::new(),
                    id: header_id,
                    cwd: fields[1].into(),
                    flags: parse_flags(fields[2]),
                    name: None,
                    text: fields[3].into(),
                    context: None,
                })
            } else {
                None
            }
        })
        .collect()
}

/// Escape a UTF-8 string as a Lua 5.1 double-quoted literal.
/// Three-digit escapes prevent a following digit from changing the escape value.
pub fn lua_string(input: &str) -> String {
    use std::fmt::Write;
    let mut out = String::from("\"");
    for ch in input.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\r' => {}
            '\n' => out.push_str("\\n"),
            '\x00'..='\x08' | '\x0b'..='\x1f' | '\x7f' => {
                write!(out, "\\{:03}", ch as u32).expect("writing to a String cannot fail");
            }
            _ => out.push(ch),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unrepresentable_and_malformed_ids() {
        for id in [
            "9007199254740992",
            "18446744073709551616",
            "-1",
            "1.2",
            "",
            "１",
        ] {
            assert!(
                jobs_from_strip(1, &format!("s\x1fc\x1f{id}\x1f\x1f\x1fname\x1ftext")).is_empty()
            );
        }
    }

    #[test]
    fn context_absent_and_explicitly_cleared_are_distinct() {
        let jobs = jobs_from_strip(
            1,
            "s\x1fc\x1f1\x1f\x1fc\x1fname\x1f\x1ftext\x1es\x1fc\x1f2\x1f\x1f\x1fname\x1ftext",
        );
        assert_eq!(jobs[0].context.as_deref(), Some(""));
        assert_eq!(jobs[1].context, None);
    }

    #[test]
    fn parses_per_chat_model_and_effort_flags() {
        let flags = parse_flags("agent=CODEX;model=gpt-6.1-terra;effort=LOW");
        assert_eq!(flags.agent, "codex");
        assert_eq!(flags.model, "gpt-6.1-terra");
        assert_eq!(flags.effort, "low");
    }
}
