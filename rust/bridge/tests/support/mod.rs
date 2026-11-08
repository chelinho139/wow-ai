use wow_ai_reforged::slots::{Reply, Snapshot, Status};
pub fn snapshot() -> Snapshot {
    Snapshot {
        online: None,
        timestamp: "2023-11-14T22:13:20.123Z".into(),
        now_seconds: 1700000000,
        cwd: "C:\\My Project".into(),
        agent: "codex".into(),
        agents: vec![
            "claude".into(),
            "codex".into(),
            "grok".into(),
            "agy".into(),
            "hermes".into(),
            "gemini".into(),
        ],
        replies: [Status::Working, Status::Done, Status::Error]
            .into_iter()
            .enumerate()
            .map(|(i, status)| Reply {
                chat: format!("chat{i}"),
                id: i as u64 + 1,
                status,
                text: "Hello 世界 🐉\n\"quoted\" \\ \0".into(),
                cwd: String::new(),
                session: "session".into(),
                agent: "codex".into(),
                summary: (i == 1).then(|| "short reply".into()),
                denied: if i == 2 {
                    vec!["WebSearch".into(), "Bash(git:*)".into()]
                } else {
                    vec![]
                },
            })
            .collect(),
    }
}
