# Rust bridge preview

The executable now has a one-shot message → agent → saved reply → Lua outbox
pipeline, native embedded setup, and a Windows live capture loop. In-game behavior
still requires live Windows validation; synthetic tests alone do not establish it.

```sh
cargo run -- self-test
cargo run -- setup --wow /path/to/_forever_
cargo run -- run --config config.json
cargo run -- inject --config rust/config.local.json --prompt "Hello" --agent codex
cargo run -- recover --config rust/config.local.json
```

`self-test` launches six explicitly fake agent processes in a new temporary
workspace, exercises the adapters and prints the workspace/reply path. It requires
no accounts, Node, Python or running game. It deliberately leaves its workspace for
inspection. `inject` uses the configured real executable and its existing login;
it may consume provider credits and use tools according to that agent's settings.

Copy `rust/config.example.json` and set your project path. Run
`wow-ai-reforged agents` to list detected agents, or
`wow-ai-reforged agents --config config.json` to include configured overrides.
Detection only reads files; it does not install agents or check their login.

Omit `executable` (or set it to an empty string) for automatic discovery. Rust checks
`PATH`, platform-specific install folders, Windows `%APPDATA%/npm` launchers and
`CODEX_BIN`. Native npm-packaged Codex/Grok binaries are preferred when present;
otherwise JS entry points use the existing Node installation required by that agent.
No npm launcher is executed through `cmd.exe` or PowerShell.

Explicit executable paths take precedence. A missing explicit path is reported
instead of silently choosing another installation. Configured `.cmd`/`.bat` npm
wrappers and `.js`/`.mjs`/`.cjs` entry points are resolved to the underlying command.
`.ps1` wrappers are not executed: omit the executable for discovery or select the npm
`.cmd` file. `launcher_args` still supports an explicitly selected executable/script.
Existing config files are preserved. New setup config uses JSON serialization,
records detected paths, and leaves missing agents set to auto-discovery; startup
searches again after you install them. The default agent must be found to start.

## Runtime boundaries

- JSON configuration is strict and schema-versioned. `serde` and `serde_json` are
  the two directly selected dependencies, explicitly approved for this project.
- `data_dir` must be empty or already marked as Rust-owned. An OS file lock prevents
  concurrent Rust processes from owning it. No PID-based stale-lock theft is used.
- `reforged-state.json` stores new Rust sessions and capped history (16 chats,
  40 messages/chat, 4000 UTF-8 bytes/message, with a truncation marker and a 2 MB serialized-history budget). No legacy
  history is imported. Changing provider/project or `--fresh-session` starts fresh.
- Replies go to `data_dir/outbox`, never the installed game. A single snapshot is
  written to the main private Inbox and a private slot, using atomic file replacement.
- IDs are reserved before launching; interrupted attempts are not automatically
  replayed. If completion publication fails, the saved pending reply blocks new
  injections. `recover` republishes it without calling the agent again.
- Requests are limited to 64 KiB; replies to 64 KiB; combined stdout/stderr to the
  configured budget (1 MiB default). The configured execution timeout is followed
  by at most three one-second cleanup grace periods. Cleanup reports unsettled
  workers instead of claiming success. It uses Windows `taskkill.exe` or a Unix
  process group. Abrupt termination of the bridge itself and already-detached
  subprocesses still need stronger supervision before a persistent live runtime.
- Native Windows argument length is checked conservatively; Agy prompts over
  24,000 bytes are rejected rather than silently truncated.

## Agent contracts

All six adapters have deterministic fixture/process coverage. This is not a claim
that every installed CLI version has passed authenticated live tests.

| Agent | Output | Session source | Permissions |
| --- | --- | --- | --- |
| Claude | stream-json | session_id | default / acceptEdits; native tool rules |
| Codex | JSONL | thread.started | read-only / workspace-write sandbox |
| Grok | streaming-json | end event | dontAsk; translated tool rules |
| Antigravity (agy) | stream-json | conversation_id | plan / accept-edits |
| Hermes | legacy text | stderr session_id | provider defaults; never yolo |
| Gemini | stream-json | init session_id | default / auto_edit |

Permission modes are provider-specific; `default` is not a universal filesystem
sandbox. Unverified allow/deny mappings are rejected. No bypass/yolo mode or
arbitrary agent extra arguments are exposed. Trusted `launcher_args` exist only to
select an underlying executable/script; review your config as executable authority.

The Node adapter behavior remains the reference in `bridge/agents.js`. Additional
Gemini evidence: [headless CLI](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/headless.md),
[CLI configuration](https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/configuration.md).

## Validation

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
cargo build --release --locked
```

With `npm ci` for development tooling only:

```sh
node rust/bridge/tests/validate-slot.cjs
node rust/bridge/tests/validate-pipeline.cjs
```

Golden protocol/slot/WAV fixtures come from the unchanged Node implementation;
frame fixtures come from the actual Lua encoder. Regenerate after reviewing upstream
changes with `generate-fixtures.cjs` and `generate-frame-fixtures.cjs` under `tests/`.
CI checks fixture drift. Pure frame decoding accepts top-down RGB with padded rows,
validates magic/length/Fletcher checksum, and searches the legacy offset window.

Slot/WAV helpers require preinstalled regular files and report per-file failures;
a broadcast is not a multi-file transaction. Timed presence is connected to the
live loop. Activity-stream progress, coordination with the legacy Node backend,
full feature parity, and live game validation remain pending. See [Windows testing](../WINDOWS-TESTING.md) and
[the roadmap](../ROADMAP.md).

## Live-loop validation

`tests/live_transport.rs` drives the same owned bridge session used by `run` with
synthetic frames. It covers hello snapshots, configured agent lists, persistent
presence counters, strict routing, failed publication, restart recovery and context.
The live loop reserves message identities before provider invocation so recent
repeated frames/restarts do not rerun work. Pending results record their addon target;
private injected replies are never automatically published to a different game tree.
Presence ticks also run while waiting for agent output. Per-chat folder overrides
and in-game permission grants are rejected explicitly in this preview.
