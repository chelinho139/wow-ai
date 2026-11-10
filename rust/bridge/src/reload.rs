//! Bounded parser for the addon's SavedVariables reload outbox.
//!
//! This deliberately recognizes a small data-only subset of Lua. It never
//! evaluates SavedVariables content or searches for fields with regular
//! expressions, so strings, comments, and nested tables cannot impersonate the
//! addon's top-level `WoWAIDB["outbox"]` value.

use crate::protocol::{Flags, Job};
use std::{collections::BTreeMap, io};

const MAX_SOURCE_BYTES: usize = 16 * 1024 * 1024;
const MAX_DEPTH: usize = 64;
const MAX_TOKENS: usize = 1_000_000;
const MAX_SAFE_ID: u64 = (1_u64 << 53) - 1;

#[derive(Clone, Debug, PartialEq, Eq)]
enum Token {
    Ident(String),
    String(String),
    Number(String),
    True,
    False,
    Nil,
    LBrace,
    RBrace,
    LBracket,
    RBracket,
    Eq,
    Comma,
    Semicolon,
}

#[derive(Clone, Debug)]
enum Value {
    String(String),
    Number(String),
    Bool(bool),
    Nil,
    Table(BTreeMap<String, Value>),
}

fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}

fn lex(source: &str) -> io::Result<Vec<Token>> {
    if source.len() > MAX_SOURCE_BYTES {
        return Err(invalid("SavedVariables file exceeds parsing limit"));
    }
    let bytes = source.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if out.len() >= MAX_TOKENS {
            return Err(invalid("SavedVariables token count exceeds parsing limit"));
        }
        match bytes[i] {
            b if b.is_ascii_whitespace() => i += 1,
            b'-' if bytes.get(i + 1) == Some(&b'-') => {
                i += 2;
                if bytes.get(i..i + 2) == Some(b"[[") {
                    i += 2;
                    let end = source[i..]
                        .find("]]")
                        .ok_or_else(|| invalid("unterminated block comment"))?;
                    i += end + 2;
                } else {
                    while i < bytes.len() && bytes[i] != b'\n' {
                        i += 1;
                    }
                }
            }
            b'{' => {
                out.push(Token::LBrace);
                i += 1;
            }
            b'}' => {
                out.push(Token::RBrace);
                i += 1;
            }
            b'[' => {
                out.push(Token::LBracket);
                i += 1;
            }
            b']' => {
                out.push(Token::RBracket);
                i += 1;
            }
            b'=' => {
                out.push(Token::Eq);
                i += 1;
            }
            b',' => {
                out.push(Token::Comma);
                i += 1;
            }
            b';' => {
                out.push(Token::Semicolon);
                i += 1;
            }
            quote @ (b'"' | b'\'') => {
                i += 1;
                let mut value = Vec::new();
                let mut closed = false;
                while i < bytes.len() {
                    let b = bytes[i];
                    i += 1;
                    if b == quote {
                        closed = true;
                        break;
                    }
                    if b != b'\\' {
                        value.push(b);
                        continue;
                    }
                    let escaped = *bytes
                        .get(i)
                        .ok_or_else(|| invalid("unterminated string escape"))?;
                    i += 1;
                    match escaped {
                        b'a' => value.push(7),
                        b'b' => value.push(8),
                        b'f' => value.push(12),
                        b'n' => value.push(b'\n'),
                        b'r' => value.push(b'\r'),
                        b't' => value.push(b'\t'),
                        b'v' => value.push(11),
                        b'\\' | b'"' | b'\'' => value.push(escaped),
                        b'\n' => {}
                        b'0'..=b'9' => {
                            let mut number = u16::from(escaped - b'0');
                            for _ in 0..2 {
                                if let Some(next @ b'0'..=b'9') = bytes.get(i).copied() {
                                    number = number * 10 + u16::from(next - b'0');
                                    i += 1;
                                } else {
                                    break;
                                }
                            }
                            if number > 255 {
                                return Err(invalid("Lua decimal escape exceeds one byte"));
                            }
                            value.push(number as u8);
                        }
                        _ => return Err(invalid("unsupported Lua string escape")),
                    }
                }
                if !closed {
                    return Err(invalid("unterminated Lua string"));
                }
                out.push(Token::String(
                    String::from_utf8(value).map_err(|_| invalid("Lua string is not UTF-8"))?,
                ));
            }
            b if b.is_ascii_digit()
                || (b == b'-' && bytes.get(i + 1).is_some_and(u8::is_ascii_digit)) =>
            {
                let start = i;
                if bytes[i] == b'-' {
                    i += 1;
                }
                while bytes.get(i).is_some_and(u8::is_ascii_digit) {
                    i += 1;
                }
                if bytes.get(i) == Some(&b'.') {
                    i += 1;
                    while bytes.get(i).is_some_and(u8::is_ascii_digit) {
                        i += 1;
                    }
                }
                if matches!(bytes.get(i), Some(b'e' | b'E')) {
                    i += 1;
                    if matches!(bytes.get(i), Some(b'+' | b'-')) {
                        i += 1;
                    }
                    let exponent = i;
                    while bytes.get(i).is_some_and(u8::is_ascii_digit) {
                        i += 1;
                    }
                    if i == exponent {
                        return Err(invalid("malformed numeric exponent"));
                    }
                }
                out.push(Token::Number(source[start..i].to_owned()));
            }
            b if b.is_ascii_alphabetic() || b == b'_' => {
                let start = i;
                i += 1;
                while bytes
                    .get(i)
                    .is_some_and(|b| b.is_ascii_alphanumeric() || *b == b'_')
                {
                    i += 1;
                }
                out.push(match &source[start..i] {
                    "true" => Token::True,
                    "false" => Token::False,
                    "nil" => Token::Nil,
                    value => Token::Ident(value.to_owned()),
                });
            }
            _ => return Err(invalid(format!("unsupported Lua syntax at byte {i}"))),
        }
    }
    Ok(out)
}

struct Parser {
    tokens: Vec<Token>,
    pos: usize,
}

impl Parser {
    fn value(&mut self, depth: usize) -> io::Result<Value> {
        if depth > MAX_DEPTH {
            return Err(invalid("SavedVariables nesting exceeds parsing limit"));
        }
        let token = self
            .tokens
            .get(self.pos)
            .cloned()
            .ok_or_else(|| invalid("missing value"))?;
        self.pos += 1;
        match token {
            Token::String(value) => Ok(Value::String(value)),
            Token::Number(value) => Ok(Value::Number(value)),
            Token::True => Ok(Value::Bool(true)),
            Token::False => Ok(Value::Bool(false)),
            Token::Nil => Ok(Value::Nil),
            Token::LBrace => self.table(depth + 1),
            _ => Err(invalid("unsupported SavedVariables value")),
        }
    }

    fn table(&mut self, depth: usize) -> io::Result<Value> {
        let mut keyed = BTreeMap::new();
        loop {
            while matches!(
                self.tokens.get(self.pos),
                Some(Token::Comma | Token::Semicolon)
            ) {
                self.pos += 1;
            }
            if matches!(self.tokens.get(self.pos), Some(Token::RBrace)) {
                self.pos += 1;
                return Ok(Value::Table(keyed));
            }
            let key = match self.tokens.get(self.pos).cloned() {
                Some(Token::LBracket) => {
                    self.pos += 1;
                    let key = match self.tokens.get(self.pos).cloned() {
                        Some(Token::String(key) | Token::Number(key)) => key,
                        _ => return Err(invalid("table key must be a string or integer")),
                    };
                    self.pos += 1;
                    if !matches!(self.tokens.get(self.pos), Some(Token::RBracket)) {
                        return Err(invalid("missing closing table-key bracket"));
                    }
                    self.pos += 1;
                    if !matches!(self.tokens.get(self.pos), Some(Token::Eq)) {
                        return Err(invalid("missing table-key assignment"));
                    }
                    self.pos += 1;
                    Some(key)
                }
                Some(Token::Ident(key))
                    if matches!(self.tokens.get(self.pos + 1), Some(Token::Eq)) =>
                {
                    self.pos += 2;
                    Some(key)
                }
                Some(_) => None,
                None => return Err(invalid("unterminated table")),
            };
            let value = self.value(depth)?;
            if let Some(key) = key {
                if keyed.insert(key.clone(), value).is_some() {
                    return Err(invalid(format!("duplicate table key {key:?}")));
                }
            } else {
                let _ = value;
            }
        }
    }
}

fn required_string(fields: &mut BTreeMap<String, Value>, name: &str) -> io::Result<String> {
    match fields.remove(name) {
        Some(Value::String(value)) => Ok(value),
        Some(_) => Err(invalid(format!("outbox field {name:?} must be a string"))),
        None => Err(invalid(format!("outbox field {name:?} is missing"))),
    }
}

fn optional_string(fields: &mut BTreeMap<String, Value>, name: &str) -> io::Result<Option<String>> {
    match fields.remove(name) {
        Some(Value::String(value)) => Ok(Some(value)),
        Some(Value::Nil) | None => Ok(None),
        Some(_) => Err(invalid(format!("outbox field {name:?} must be a string"))),
    }
}

fn decode_hex(value: &str, field: &str) -> io::Result<String> {
    if !value.len().is_multiple_of(2) || !value.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(invalid(format!("outbox field {field:?} is not valid hex")));
    }
    let mut bytes = Vec::with_capacity(value.len() / 2);
    let (pairs, remainder) = value.as_bytes().as_chunks::<2>();
    debug_assert!(remainder.is_empty());
    for pair in pairs {
        let digit = |b: u8| match b {
            b'0'..=b'9' => b - b'0',
            b'a'..=b'f' => b - b'a' + 10,
            b'A'..=b'F' => b - b'A' + 10,
            _ => unreachable!(),
        };
        bytes.push(digit(pair[0]) * 16 + digit(pair[1]));
    }
    String::from_utf8(bytes).map_err(|_| invalid(format!("outbox field {field:?} is not UTF-8")))
}

/// Parse the addon's persisted reload request without evaluating Lua.
pub fn parse_outbox(source: &str) -> io::Result<Option<Job>> {
    let tokens = lex(source)?;
    let mut root = None;
    let mut depth = 0usize;
    let mut i = 0;
    while i < tokens.len() {
        match &tokens[i] {
            Token::LBrace => depth += 1,
            Token::RBrace => depth = depth.saturating_sub(1),
            Token::Ident(name)
                if depth == 0
                    && name == "WoWAIDB"
                    && matches!(tokens.get(i + 1), Some(Token::Eq)) =>
            {
                if root.is_some() {
                    return Err(invalid("duplicate WoWAIDB assignment"));
                }
                let mut parser = Parser {
                    tokens: tokens.clone(),
                    pos: i + 2,
                };
                root = Some(parser.value(0)?);
                i = parser.pos;
                continue;
            }
            _ => {}
        }
        i += 1;
    }
    let Some(Value::Table(mut root)) = root else {
        return Ok(None);
    };
    let Some(outbox) = root.remove("outbox") else {
        return Ok(None);
    };
    let Value::Table(mut fields) = outbox else {
        return Err(invalid("WoWAIDB outbox must be a table"));
    };

    let id = match fields.remove("id") {
        Some(Value::Number(value)) => value
            .parse::<u64>()
            .ok()
            .filter(|id| *id > 0 && *id <= MAX_SAFE_ID),
        Some(_) => return Err(invalid("outbox field \"id\" must be an integer")),
        None => return Err(invalid("outbox field \"id\" is missing")),
    }
    .ok_or_else(|| invalid("outbox message id is invalid"))?;
    let text = decode_hex(&required_string(&mut fields, "text")?, "text")?;
    let cwd = decode_hex(&required_string(&mut fields, "cwd")?, "cwd")?;
    let session = optional_string(&mut fields, "session")?.unwrap_or_default();
    let chat = optional_string(&mut fields, "chat")?.unwrap_or_default();
    let context = optional_string(&mut fields, "ctx")?
        .map(|value| decode_hex(&value, "ctx"))
        .transpose()?;
    let agent = optional_string(&mut fields, "agent")?
        .unwrap_or_default()
        .to_lowercase();
    let model = optional_string(&mut fields, "model")?.unwrap_or_default();
    let effort = optional_string(&mut fields, "effort")?
        .unwrap_or_default()
        .to_lowercase();
    let allow = optional_string(&mut fields, "allow")?
        .map(|value| decode_hex(&value, "allow"))
        .transpose()?
        .map(|value| {
            value
                .split('\x1f')
                .filter(|rule| !rule.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let new_session = match fields.remove("newSession") {
        Some(Value::Bool(value)) => value,
        Some(Value::Nil) | None => false,
        Some(_) => return Err(invalid("outbox field \"newSession\" must be boolean")),
    };

    Ok(Some(Job {
        session,
        chat,
        id,
        cwd,
        flags: Flags {
            new_session,
            context: context.is_some(),
            allow,
            agent,
            model,
            effort,
            ..Flags::default()
        },
        name: None,
        text,
        context,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    const ACTUAL: &str = r#"WoWAIDB = {
["chats"] = { { ["history"] = {}, }, },
["outbox"] = {
["id"] = 7,
["session"] = "abc123",
["chat"] = "c1",
["text"] = "68c3a96c6c6f",
["cwd"] = "7265616c6d73",
["ctx"] = "4368617261637465723a204d616765",
["agent"] = "CODEX",
["model"] = "gpt-6.1-terra",
["effort"] = "LOW",
["allow"] = "5765625365617263681f42617368286769743a2a29",
["newSession"] = true,
["t"] = 123,
},
["settings"] = {},
}"#;

    #[test]
    fn parses_actual_addon_outbox_shape_and_overrides() {
        let job = parse_outbox(ACTUAL).unwrap().unwrap();
        assert_eq!(
            (job.id, job.session.as_str(), job.chat.as_str()),
            (7, "abc123", "c1")
        );
        assert_eq!((job.text.as_str(), job.cwd.as_str()), ("héllo", "realms"));
        assert_eq!(job.context.as_deref(), Some("Character: Mage"));
        assert!(job.flags.new_session && job.flags.context);
        assert_eq!(job.flags.agent, "codex");
        assert_eq!(job.flags.model, "gpt-6.1-terra");
        assert_eq!(job.flags.effort, "low");
        assert_eq!(job.flags.allow, ["WebSearch", "Bash(git:*)"]);
    }

    #[test]
    fn ignores_comment_string_and_nested_outbox_lookalikes() {
        let source = r#"-- ["outbox"] = { ["id"] = 1 }
fake = "[\"outbox\"] = { [\"id\"] = 2 }"
Other = { ["outbox"] = { ["id"] = 3, }, }
WoWAIDB = { ["note"] = "outbox", ["nested"] = { ["outbox"] = {}, }, }
"#;
        assert!(parse_outbox(source).unwrap().is_none());
    }

    #[test]
    fn accepts_realistic_saved_state_around_the_outbox() {
        let source = ACTUAL.replace(
            "[\"chats\"] = { { [\"history\"] = {}, }, },",
            r#"["width"] = 780.5,
["position"] = -42,
["scale"] = 1.25e-1,
["chats"] = {
  { ["created"] = 1731170000, ["history"] = {
    { ["role"] = "user", ["text"] = "hello { world }", ["t"] = -1.5, },
  }, },
},"#,
        );
        assert_eq!(parse_outbox(&source).unwrap().unwrap().id, 7);
    }

    #[test]
    fn rejects_duplicate_fields_and_unsafe_ids() {
        let duplicate = ACTUAL.replace("[\"id\"] = 7,", "[\"id\"] = 7, [\"id\"] = 8,");
        assert!(
            parse_outbox(&duplicate)
                .unwrap_err()
                .to_string()
                .contains("duplicate")
        );
        let unsafe_id = ACTUAL.replace("[\"id\"] = 7,", "[\"id\"] = 9007199254740992,");
        assert!(
            parse_outbox(&unsafe_id)
                .unwrap_err()
                .to_string()
                .contains("id")
        );
    }

    #[test]
    fn rejects_malformed_hex_and_non_utf8() {
        for replacement in ["abc", "zz", "ff"] {
            let source = ACTUAL.replace("68c3a96c6c6f", replacement);
            assert!(parse_outbox(&source).is_err());
        }
    }

    #[test]
    fn rejects_excessive_nesting_and_source_size() {
        let nested = format!(
            "WoWAIDB = {{ [\"x\"] = {}1{}, }}",
            "{".repeat(MAX_DEPTH + 1),
            "}".repeat(MAX_DEPTH + 1)
        );
        assert!(
            parse_outbox(&nested)
                .unwrap_err()
                .to_string()
                .contains("nesting")
        );
        assert!(
            parse_outbox(&" ".repeat(MAX_SOURCE_BYTES + 1))
                .unwrap_err()
                .to_string()
                .contains("limit")
        );
    }
}
