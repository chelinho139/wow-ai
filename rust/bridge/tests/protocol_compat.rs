use wow_ai_reforged::protocol::{jobs_from_strip, lua_string};

fn unhex(value: &str) -> String {
    let bytes = (0..value.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&value[i..i + 2], 16).unwrap())
        .collect();
    String::from_utf8(bytes).unwrap()
}

#[test]
fn matches_legacy_node_protocol_fixtures() {
    for (index, line) in include_str!("fixtures/protocol.tsv").lines().enumerate() {
        let fields: Vec<_> = line.split('\t').collect();
        assert_eq!(fields.len(), 3);
        let input = unhex(fields[1]);
        let expected = unhex(fields[2]);
        let actual = match fields[0] {
            "lua" => lua_string(&input),
            "jobs" => jobs_from_strip(42, &input)
                .iter()
                .map(|j| {
                    [
                        j.session.clone(),
                        j.chat.clone(),
                        j.id.to_string(),
                        j.cwd.clone(),
                        j.flags.new_session.to_string(),
                        j.flags.hello.to_string(),
                        j.flags.forget.to_string(),
                        j.flags.context.to_string(),
                        j.flags.allow.join("\x1f"),
                        j.flags.agent.clone(),
                        j.name.clone().unwrap_or_else(|| "~".into()),
                        j.text.clone(),
                        j.context.clone().unwrap_or_else(|| "~".into()),
                    ]
                    .join("\t")
                })
                .collect::<Vec<_>>()
                .join("\n"),
            other => panic!("unknown fixture kind: {other}"),
        };
        assert_eq!(actual, expected, "fixture {} ({})", index + 1, fields[0]);
    }
}
