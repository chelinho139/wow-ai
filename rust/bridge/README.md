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

See the **[complete Rust configuration reference](../CONFIGURATION.md)** for every
JSON option, defaults, model/effort choices, permissions and examples.
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
- `inject` and its `recover` path publish to `data_dir/outbox`, not the installed game. Live `run` publishes to the selected addon installation. A private snapshot is
  written to the main private Inbox and a private slot, using atomic file replacement.
- IDs are reserved before launching; interrupted attempts are not automatically
  replayed. If completion publication fails, the saved pending reply blocks new
  injections. `recover` republishes it without calling the agent again.
- Requests are limited to 64 KiB; replies to 64 KiB; combined stdout/stderr to the
  configured budget (1 MiB default). The configured execution timeout is followed
  by at most three one-second cleanup grace periods. Cleanup reports unsettled
  workers instead of claiming success. It uses Windows `taskkill.exe` or a Unix
  process group. Live Ctrl+C triggers cleanup and offline publication; crashes rely
  on heartbeat expiry. Detached subprocesses require stronger supervision.
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
sandbox. Unverified allow/deny mappings are rejected. No bypass/yolo permission mode is
exposed. Codex `extra_args` are trusted local CLI arguments; other adapters do not
consume that field. Trusted `launcher_args` exist only to
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
Presence ticks also run while waiting for agent output. Per-chat working folders
are supported; in-game permission grants remain explicitly rejected.

## Fast edit loop

Install the Bacon watcher once with `cargo install --locked bacon`. From the
repository root, run `bacon` to watch the default `check` job. Use `bacon clippy`,
`bacon test`, `bacon test-live`, `bacon fmt`, `bacon self-test`, or `bacon release`
for the other project jobs configured in the root `bacon.toml`.

## Per-chat header configuration

Reforged bridge development targets this Rust implementation. The JavaScript
`bridge/` directory is retained for upstream fork synchronization.

The addon header reads versioned capabilities from Rust snapshots. Each agent
advertises its configured default, allowed model alternatives, and installation
availability. These lists are configured locally; they do not query provider
accounts. Configure them in the JSON file passed to `--config`, for example:

```json
{
  "model": "gpt-6.1-terra",
  "models": [
    { "id": "gpt-6.1-terra", "reasoningEfforts": ["low", "high"] }
  ],
  "reasoningEffort": "low"
}
```

Place this block under `agents.codex` alongside existing executable and permission
settings. `reasoningEfforts` on the agent supplies a shared list; a model's own
list takes precedence. Reasoning overrides are supported by the Codex adapter.
Other adapters advertise model choices only. The configured model is included as
a choice automatically. Codex defaults in `extraArgs` using
`model_reasoning_effort` are recognized and replaced when an effort is selected.

The addon sends `model=` and `effort=` flags per request. Rust validates the
selected model and effective effort together before invoking a backend, and
returns the effective model/effort with replies. Unsupported combinations return
an actionable error. No UI-supplied value is interpreted as a command line.
Changes start a fresh backend session on the next request and retain the visible
transcript. Existing requests and saved completed replies keep their settings.
Reset removes chat overrides and inherits Rust configuration defaults.

The existing Rust live transport receives pixel records and publishes replies to
slots and Inbox.lua, with optional SavedVariables reload input described below.
Older bridges without capabilities expose agent selection only.


### Opt-in reload recovery preview

Set `saved_variables` in the Rust JSON config to the explicit account file, for
example `C:/Games/WoW/WTF/Account/MYACCOUNT/SavedVariables/WoWAI.lua`. Relative paths
resolve against the config directory. It is optional; account discovery is not
implemented. This is Rust configuration, not legacy `bridge/config.json`.

The existing live loop checks that file every 750 ms using bounded data-only
parsing. A save must be newer than bridge startup and match a session seen in a
pixel hello during this run. After restarting the bridge, reconnect in the addon
and `/reload` again if recovery is needed; an old disk snapshot is not dispatched
at startup. Pixel and reload requests share durable admission by addon token and
message ID, preserving model/effort and normal adapter validation.

New admissions are retained as exact compressed ID intervals, including holes for
out-of-order requests. They are never pruned; limits of 256 sessions and 8,192
intervals fail closed. Do not delete Rust state to resolve a capacity error without
considering replay risk. Upgrade imports retained legacy dedup IDs, but cannot
reconstruct IDs already evicted by older versions. Guarantees apply to retained
and newly admitted requests, not unknown historical requests.

Before acknowledgement or launch, admission and an interruption reply are saved
together. A crash at that point conservatively reports an uncertain outcome and
requires a new request; it never automatically relaunches that ID. Completed and
error replies are saved before publication and can be republished after restart.
This does not promise exactly-once provider side effects. Windows process lifetime
containment is described below; cleanup of pre-existing or Unix orphans remains open.
Windows in-game fallback, caching and process cleanup still require validation.

### Windows provider lifetime

Before launching any provider, the Windows bridge joins a private, unnamed native
Job Object with kill-on-close enabled and breakaway disabled. Future providers
and descendants inherit membership when they are created. The sole job handle
is non-inheritable and stays open for the bridge process lifetime; Windows closes
it on abrupt bridge death and terminates remaining members. Failure to establish
containment returns an error before provider launch. No persisted PID is used to
kill a process after restart, avoiding PID-reuse hazards.

This covers descendants launched after containment, including nested jobs where
Windows permits the hierarchy. It can affect provider tools that expect background
processes to outlive the bridge. Host job restrictions can prevent assignment; the
bridge fails closed instead of silently running without containment. Tests on
Windows observe native handles for a running fake provider and its child while
forcibly terminating their bridge owner.

macOS/Linux retain existing timeout/shutdown cleanup while the bridge is alive;
abrupt bridge death containment is not implemented there. Compile checks from
macOS do not establish Windows runtime correctness or in-game behavior.

### Durable chat deletion

Deleting an addon chat now persists a tombstone and removes its private history,
session reference and pending reply in one atomic state update. Only then does
Rust remove the retained reply and republish the Inbox and every reply slot. The
tombstone is marked complete before the exact deletion acknowledgment is raised.
Startup and ticks resume incomplete cleanup before accepting work. Unavailable
files leave cleanup retryable and unacknowledged; startup cleanup stays offline
until the bridge finishes validation.

Tombstones are retained permanently (maximum 4,096 chat IDs; overflow fails closed)
so old pixel requests and freshly saved stale outboxes are consumed without
recreating deleted chats. They retain operation identity and publication target,
not message contents. Do not discard Rust state to bypass capacity or replay
protection. Private `inject` calls also cannot record messages for a deleted ID.
The addon retains retired identities, rejects stale restore entries for them,
and gives new/cleared chats collision-safe identities. It clears old outgoing
requests, and keeps the deletion queued until an explicit acknowledgment. Rust publishes completed deletion receipts
in Inbox and slot snapshots, keyed by chat, session and stable operation ID; they
work with sound disabled. Receipt-capable peers ignore old WAV signals for deletion.
Older peers retain their sound acknowledgment path; presence never proves cleanup. Older addons that reuse a deleted chat ID must create a new chat.

This is a recoverable deletion journal, not simultaneous replacement of every
file. Until recovery completes, existing cached files can still contain an old
reply; an unacknowledged operation is not complete. It does not erase an external
provider's own history, cancel a provider already running, import/delete legacy
Node state, or interpret missing backend files as a user deletion. Windows/WoW
sound and slot caching still need in-game acceptance.


### Per-chat working folders

Use the conversation menu's Working folder action or `/wow-ai cd <directory>`.
An empty folder inherits `project_dir` from the Rust config. Absolute paths select
that directory; relative paths resolve against `project_dir`, including `..`.
`~`, `~/...` and `~\...` expand from HOME (Unix) or USERPROFILE (Windows);
missing/nonabsolute home settings produce an actionable error. Folder paths are
not restricted to the configured default directory. Existing configured provider
permissions still apply; selecting a folder does not grant extra permissions.

Rust canonicalizes the path and requires an existing directory before launching
anything. Missing paths, files, NUL bytes, oversized input and ambiguous Windows
`C:relative` paths return an actionable error. Spaces and Unicode are supported;
paths are passed as process arguments and cwd, without shell interpolation.

The canonical folder belongs to the chat's provider session. The same folder or
an equivalent alias can resume it, including after restart; a different folder
starts a fresh session while preserving the visible transcript. Resetting to the
bridge default is also a folder change when it resolves differently. A chat keeps
only its current backend session, so switching back to an earlier folder starts
fresh rather than restoring an older folder's session.

Admitted requests and saved replies retain their original folder through retries
and publication recovery. A folder change applies to the next new request ID;
retrying a rejected ID does not reconsider it. Pixel and reload delivery use the
same validation and dispatch path. Fake-agent tests cover all six adapters;
authenticated providers and the in-game folder menu still need client acceptance.
