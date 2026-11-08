-- Written by the wow-ai bridge (bridge/bridge.js). Do not edit by hand.
WoWAI_Inbox = {
	ts = "2023-11-14T22:13:20.123Z",
	now = 1700000000,
	cwd = "C:\\My Project",
	agent = "codex",
	agents = { "claude", "codex", "grok", "agy", "hermes", "gemini" },
	replies = {
		{
			chat = "chat0",
			id = 1,
			status = "working",
			text = "Hello 世界 🐉\n\"quoted\" \\ \000",
			cwd = "",
			session = "session",
			agent = "codex",
		},
		{
			chat = "chat1",
			id = 2,
			status = "done",
			text = "Hello 世界 🐉\n\"quoted\" \\ \000",
			cwd = "",
			session = "session",
			agent = "codex",
			summary = "short reply",
		},
		{
			chat = "chat2",
			id = 3,
			status = "error",
			text = "Hello 世界 🐉\n\"quoted\" \\ \000",
			cwd = "",
			session = "session",
			agent = "codex",
			denied = { "WebSearch", "Bash(git:*)" },
		},
	},
}
