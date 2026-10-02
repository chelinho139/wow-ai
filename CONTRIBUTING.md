# Contributing

Thanks for looking at this. Bug reports, questions and pull requests are all welcome. This page covers how the repo is laid out, how to run the tests, and what a good change looks like.

## Layout

```
addon/ClaudeWoW/     the in-game addon (Lua 5.1, WoW API)
  ClaudeWoW.lua        everything: strip, slots, chats, UI, slash commands
  Codec.lua             pixel-strip encoder, pure Lua, no WoW calls
  Inbox.lua             placeholder the bridge overwrites at runtime
  Widgets.lua           live UI widgets from the agent, sandboxed, /claude config ui list|remove|run
  Window.lua            the workspace window's behaviour: dodging Blizzard panels, dimming, per-character layout
  Bindings.xml          the "open or close the workspace" key binding
  ClaudeWoW.toc
bridge/               the companion process (Node.js, no runtime dependencies)
  bridge.js             I/O, processes, publishing
  protocol.js           pure functions: strip records, slot files, folders, dedup
  agents.js             one entry per agent (Claude, Codex, Grok, Antigravity, Hermes): command line, prompt delivery, stream parser
  capture.ps1           screen capture and strip decoder (PowerShell)
  install-slots.js      creates the slot addons and signal files
  gamefs.js             writes into the game folder with the game's own 0777 mode
  channel.js            the live-session channel server Claude Code spawns (MCP over stdio, by hand); liveproto.js holds what it shares with plugins/live.js
  sessions.js           the sessions /claude -r lists and resumes: the bridge's own, Claude Code's history and project folders, running ones by pid
  supervisor.js         restarts bridge.js on crash; the `claude-wow` command (and `claude-wow setup` / `claude-wow service` / `claude-wow bridge`)
  service.js            `claude-wow service`: LaunchAgent / systemd unit / Startup launcher, log rotation, pid file
  runtime.js            node, bun or the compiled binary: how the bridge runs its own scripts on each
  assets.js             the capture scripts, the addon, the config template and the primer by path, from a checkout or out of the binary
  config.example.json   template setup.js copies to config.json
setup.js              one-shot installer (the game side: addon, config.json, slot pool)
build.js, build/      the binaries: `bun build --compile`, one self-contained file per platform, assets embedded (build/entry.js)
install.sh, install.ps1  the one-line installers (curl | sh, irm | iex): the binary (or Node + source), command, setup, service
homebrew/             the Homebrew tap layout (Formula/claude-wow.rb) and why it is the secondary route
tests/                see below
docs/                 INSTALL.md, ARCHITECTURE.md, AGENTS.md, CONFIGURATION.md, platform notes
```

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) first. The two transports (pixels out, load-on-demand slots in) follow from three facts about the WoW sandbox, and most design choices make sense only in that light.

## Setting up for development

```powershell
git clone https://github.com/rdimascio/claude-wow
cd claude-wow
npm install          # test tooling only: fengari (Lua VM) and luaparse
npm test
```

`npm test` runs the portable suite on every platform. The codec round-trip decodes through `capture.ps1` on Windows and through `capture_x11.py` (python3) elsewhere. `npm run test:bun` runs the same suite under [Bun](https://bun.sh) (`bun test` runs the `node:test` files as they are; the two scripts list the same files, so a new test file goes into both): Node is the runtime the checkout is written for and the fallback install, Bun is what the shipped binary is built with, and the bridge must keep working on both. CI runs both on `windows-latest`, `ubuntu-latest` and `macos-latest` (`.github/workflows/test.yml`).

To try changes in the game, run `node setup.js` (it re-copies the addon into `Interface\AddOns\ClaudeWoW`) and `/reload`. Bridge changes take effect on the next `npm start`.

## Tests

| Command | What it checks |
|---|---|
| `node tests/order_check.js` | The addon parses as Lua 5.1 and no top-level `local` is used before it is declared. |
| `node --test tests/addon_test.js` | The real addon in a Lua VM with a stub client (`tests/wow_stub.lua`): login, hello, a message decoded off the strip, a slot reply, Allow, `/claude reset`, restore, chat commands, minimize, reload mode, the screenshot transport (shots per message, retries, the timeout, CVar save/restore, the dark palette), and `/claude`, `/r` and whisper tabs typed into a model of the game's chat edit box (`STUB.ChatEditBox`), where a protected call made after addon code ran in the same Enter counts as tainted and no game function may be replaced; and the `/claude` surface: the flag parser (short and long flags, `--flag=value`, quotes, text that only looks like a flag), per-chat settings on the strip and in the outbox, `-r` against running, recent and unknown sessions with the picker and ambiguity, `/claude config`, and the hidden `/claude-wow` alias. |
| `node --test tests/bridge_test.js` | `bridge/protocol.js`: strip records, flags (including `agent=`), the SavedVariables outbox, folder resolution, permission rules, dedup and pruning. |
| `node --test tests/agents_test.js` | `bridge/agents.js`: the command line built for each agent and permission mode, the prompt delivery (stdin, prompt file, context block), a sample of each CLI's real stream (Claude stream-json, Codex `exec --json`, Grok streaming-json, agy stream-json, Hermes plain text) read back into progress lines, session id, denials and reply, and the unwrapping of npm's Windows launchers. |
| `node --test tests/restore_test.js` | Slot files are valid Lua and read back field by field, including a restore bundle. |
| `node --test tests/map_test.js` | The map protocol in `protocol.js`: command validation and sanitizing, versioned application and budgets, ```` ```wowmap ```` blocks and map files, and the `map` table in slot files read back in a Lua VM. |
| `node --test tests/map_addon_test.js` | The real `Map.lua` (with `ClaudeWoW.lua`) in a Lua VM: sync and versions, pin projection on zone and continent maps, the navigator's yards, bearing and auto-advance, herb/ore nodes filtered by skill, and `/claude config map`. |
| `node --test tests/voice_test.js` | The real `Voice.lua` (with `ClaudeWoW.lua`) in a Lua VM: every classic race and gender has every line, each pack covers every event, the lines played on send, pick-up, reply, error and permission, the throttle, and `/claude config voice`. |
| `node --test tests/decode_test.js` | `bridge/decode.js`, the screenshot transport's reader: `Codec.lua` in a Lua VM, rendered inside a 1920x1080 frame as PNG (every filter type, RGB and RGBA) and TGA (raw and RLE, 24 and 32 bit, both row orders), bright and dark palettes, offsets, bad checksum, truncation and an oversized length field. |
| `node --test tests/gamefs_test.js` | `bridge/gamefs.js`: writes, atomic replaces, copies and new folders in the game folder end up `0777` like the rest of the install whatever the umask (Battle.net error 2113 otherwise), existing parents are left alone, and the repair pass fixes the ClaudeWoW addon folders and nothing else. |
| `node --test tests/screenshots_test.js` | `bridge/screenshots.js`: the client's `Screenshots` folder derived from `addonDir`, the file-name filter, and the watcher reporting a new file once its size settles while ignoring files from before it started. |
| `node --test tests/service_test.js` | `bridge/service.js`: the LaunchAgent plist (and `plutil -lint` on macOS), the systemd unit and the Windows launcher it writes, `claude-wow service` argument parsing, log rotation and the self-rotating writer, the pid file, the launchctl output parser, and `status` on a clean machine. |
| `node --test tests/datasync_test.js` | `bridge/datasync.js`, `claude-wow data sync`: synthetic CSV fixtures in `tests/fixtures/wago/` through a fake fetch (the real `fetch` throws in this file), CSV quoting, row checks and drop counts, build-string checks before any path or URL, uiMap percent placement, the atomic `<build>.tmp` swap and `current` pointer, a failed sync that leaves the old build alone, the lock, and the table hashes between two builds of one family. |
| `node --test tests/datamcp_test.js` | `bridge/datamcp.js`, `bridge/gamedata.js` and `bridge/gamerefs.js` over a home synced from the same fixtures: each `wowdata` tool's answer with `source`, `build` and `trust`, name ranking, quests with no titles, flight paths on a map, map parents and children, bad input, no data, the client build check, tables loaded on first use with the `current` pointer read once, the MCP surface in process and over real stdio, the launch config and Claude arguments for an `ask` run, and reference-token expansion and rejection. `tests/e2e/gamedata_test.js` checks the same wiring through a sandbox bridge. |
| `node --test tests/install_test.js` | `install.sh` and `install.ps1`: they parse, the Node 22.2 gate accepts and rejects the right versions, unknown options and a missing Node fail with a hint, and `install.sh` runs nothing until fully read. |
| `node --test tests/runtime_test.js` | `bridge/runtime.js`: the command that runs each of the bridge's own scripts from a checkout (this node and the script) and from the compiled binary (the binary and a subcommand), and where a JavaScript launcher finds a node in each case. |
| `node --test tests/assets_test.js` | `bridge/assets.js`: every embedded file exists and the addon folder is covered in full, `build/entry.js` embeds exactly that list, an embedded set is written out once and rewritten only where it differs, and `build.js` names one binary per target. |
| `node --test tests/widget_test.js` | The widget protocol in `protocol.js`: validation and the display-only deny-list, versioned application and budgets, ```` ```wowui ```` blocks and widget files, the hint only for a plugin with the `ui` surface, the `widgets` table in slot files read back in a Lua VM, and that the addon blocks the same names. |
| `node --test tests/widget_addon_test.js` | The real `Widgets.lua` (with `ClaudeWoW.lua`) in a Lua VM: a widget running live from slot data, errors surfaced to the chat window, blocked calls in the sandbox, `/claude config ui` list, remove and run, restart at login, and the reload path. |
| `node --test tests/window_addon_test.js` | The real `Window.lua` (with `ClaudeWoW.lua`) in a Lua VM with Blizzard panels stubbed at fixed places (`STUB.Panel`): the window steps aside for the character sheet and the bags and goes home when they close (through the `ShowUIPanel` hook and through the poll), stays home when there is no room, hides under the game menu and the maximized map and comes back, dims while moving and in combat and fades back, is opaque under the mouse and while typing, keeps working in combat without touching a protected frame (`STUB.blocked`) or calling a panel function, remembers its place per character, snaps to the edges, respects a panel's scale and a smaller UI, and replaces no Blizzard function or frame script. |
| `node --test tests/live_test.js` | The live-session link: the socket endpoint, the newline-delimited JSON framing, the token handshake both ways, owner-only socket permissions, the channel server's MCP surface (`initialize`, `tools/list`, `tools/call`), the channel notification's shape, reply routing through `wow_reply`, the no-session message, and the permission relay as a Need/Greed roll, against `bridge/plugins/live.js` with a fake core. |
| `node --test tests/goalsmcp_test.js` | `bridge/goalsmcp.js`, the per-run `wowgoals` server for in-game `ask` runs: the tool list without the vote tools, the launch config, the run-only rules and the `mcp__wowgoals` prefix a roll may never save, run grants (the run's own HMAC proof, one hello ever (a spoofed pid gives nothing, a dropped connection is never replaced), the eager connection holding the slot, the socket named before the listen event and dropped on a listen error, the character bound at grant time, refusal of a vote tool, an ended run or an unknown run before any store, revoke closing the connection), and calls through the real live socket into a real goal store: a write by the bridge, an unbacked name refused with nothing written, a wrong token refused at hello. `tests/e2e/goaltools_test.js` drives the server from the fake Claude through a sandbox bridge, shows the token is never on the command line and the private config file is gone after the run, refuses the live token from a second connection, denies interpreter and broad Bash rules while a run holds a token, empties stale config files at startup, revokes on cancel before the process ends, and shows a coding run and `config.json` never get it. |
| `node --test tests/goals_test.js` | `bridge/goals.js`: the profession IDs mirror the addon table, context parsing (a Professions entry cut at the addon's 900-byte cap is dropped), the order-text allowlist (characters, words in any case, reported names, the vocabulary file, and the reviewers' bypass strings: lowercase names, symbol and fullwidth letters, accents, hidden characters, slash commands), reference tokens in orders over the small data dir in `tests/fixtures/wowdata` (expansion and stored refs, map names without coordinates, unknown IDs, kinds with no name source, unsafe names in the data, glued tokens, the character set on the expanded text, the 90-character cap after expansion, raw and spaced-out names next to a valid token, the phrase check against the data and the built-in list with its exemptions and its no-data note, the data never opened for an order refused by its words, no data, another build family or an unknown client build, the phrase index never built from a damaged table and rebuilt on a re-sync, and the store `bridge.js` builds over its injected home), goals and orders saved per character with their limits, the 15-minute context guard, a store that cannot be read is never overwritten, the exact overlay payload and when it is sent, the bridge stamping when the game last confirmed its context, and an in-game `ask` run through the real bridge: goal write tools, the token and the goal folder are denied, the tools are never granted or kept by a roll, and never offered. |
| `CLAUDE_WOW_HOME=~/.claude-wow node --test --test-name-pattern "real synced data" tests/roast_test.js` | Opt-in, read-only: runs the ordinary and idiom roast lines and known game phrases against your synced game data. Skipped in `npm test` when `CLAUDE_WOW_HOME` is not set. |
| `node --test tests/orders_addon_test.js` | The real `Orders.lua` (with `ClaudeWoW.lua`) in a Lua VM, driven only by `STUB.Tick()` slot loads: the card appears after the slot read that carries `goals`, redraws on a change and not on the same data, hides when the order clears, never loads a slot of its own (counted against a session without goals), follows the quest tracker, uses the Blizzard templates or falls back, bounds and escapes the data, `/claude orders` and the gear-menu toggle, and sends nothing. `goals_test.js` covers the bridge side of the `goals` field. |
| `node --test tests/campaign_test.js` | `bridge/campaign.js`: the story text check (a corpus of ordinary lines passes; names, links, handles, ad words, unknown IDs and kinds with no name source are refused), trigger IDs against fixture data with a quests table, the five tools and their limits, beats firing from telemetry events and quest-log diffs (only the armed beat, one per update, never for a cut context or another character), `/dm next` for a manual beat only, the `dm` slot field (explicit empty value, text checked again, 1,600-byte cap), and the tools on the channel server and in the in-game deny list. |
| `node --test tests/dm_addon_test.js` | The real `DM.lua` (with `ClaudeWoW.lua` and `Orders.lua`) driven by `STUB.Tick()`: the frame on the slot read that carries a beat, the parchment and templates with fallbacks, redraws, combat, the explicit empty field, an old bridge, another character, `Inbox.lua` age, bounds and escapes, draw errors, and the `/dm next` round trip (capability gate, one record in flight, one slot load after the ack, drop after its tries), and no chat sends. `tests/e2e/dm_test.js` runs `/dm next` and a zone beat through the real bridge. |
| `node --test tests/telemetry_test.js` | `bridge/telemetry.js`: `submit()` branches on `kind=gs` before any dedupe, ack, sig or `lastId`, the record parser, the snapshot merge (baselines, newer sequences only, `handled.gs` per session), event importance and watched-count thresholds, the capability log, records filed by the character they name, `goal_complete`, a malformed `snapshot.json`, `events.jsonl` rotation, and the `gs` slot field read back in Lua. |
| `node --test tests/telemetry_addon_test.js` | The real `Telemetry.lua` (with `ClaudeWoW.lua`) driven by `STUB.Tick()`: nothing before the bridge advertises `gs`, every section, no retry or `ArmAutoRefresh`, the 2-minute, 30 s and 120-an-hour limits, importance-3 events, the frame room, paused shots, hash resends, the capability probe, per-character bounded saved data, failed and called-off shots handing their sections back, no rider on a retry, `Inbox.lua` hashes at login, change-event gating, no shot while typing. |
| `node --test tests/events_test.js` | `bridge/events.js`, `claude-wow events`: 10 s burst merging, the 40-wakes-an-hour cap, `--min`, rotation (the old file drained first), switching to the newest character, and the command line. |
| `node --test tests/sessions_test.js` | `bridge/sessions.js`: Claude Code's folder, recent sessions from a fake `history.jsonl` named by their titles, an id or prefix found in `projects/` with its folder, a running session from its pid file, the bridge's own sessions, the merged list, and resolving a reference (exact id, name, id prefix, name prefix, ambiguity). |
| `npm run test:live-session` | Not part of `npm test`. A sandbox bridge (its own `CLAUDE_WOW_HOME`) and a real interactive `claude --dangerously-load-development-channels server:claude-wow` in a detached tmux session (Haiku, `--permission-mode manual`): the no-session message, a reply, a Greed and a Pass, read back from the slot files. Needs tmux and a logged-in Claude Code. |
| `node tests/codec_test.js` | `Codec.lua` in a Lua VM, rendered to PNG with noise and gamma, decoded by `capture.ps1` (Windows) or `capture_x11.py` (elsewhere). Writes scratch images to `tests/tmp/` (gitignored). |
| `npm run test:live` | Not part of `npm test`. Builds a temporary sandbox (its own `CLAUDE_WOW_HOME`, removed on exit; it aborts if the home would be `~/.claude-wow`) with a 5-slot pool and runs the bridge with `--inject` against a real agent CLI: Claude by default, `-- --agent codex` or `-- --agent grok` for the others. Needs that CLI installed and logged in. |

When you change behaviour, add or extend a test in the matching file. Pure logic belongs in `protocol.js` where `bridge_test.js` can reach it without spawning anything.

## Building the binary

The bridge ships as one self-contained file per platform, built with [Bun](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`, no sudo; Windows: `irm bun.sh/install.ps1 | iex`):

```sh
npm run build                       # dist/claude-wow-{darwin-arm64,darwin-x64,linux-x64,windows-x64.exe} + dist/SHA256SUMS
node build.js --host                # only this machine's
node build.js --target bun-linux-x64
```

`build.js` runs `bun build --compile` on `build/entry.js`, which imports the non-JavaScript files the bridge hands to other programs (the capture scripts, the addon, `config.example.json`, the primer) with `{ type: 'file' }` so they travel inside the binary, and then requires the supervisor. Cross-compiling downloads the target's Bun runtime once (about 30 MB each). The result is 60 to 85 MB, most of it Bun's runtime; it needs no Node, no npm and no checkout, finds its config through `CLAUDE_WOW_HOME` like the checkout does, and writes the embedded files out under `~/.claude-wow/assets` on first use (`bridge/assets.js`). `build.js` runs the binary for the building machine once (`service help`) to prove it starts. CI builds all four on every push and runs the Linux one. Releases attach the four files and `SHA256SUMS`; `install.sh`, `install.ps1` and the Homebrew formula fetch them from there.

Two things are different inside the binary, and `bridge/runtime.js` is the one place that knows them (see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)): `process.execPath` is the bridge itself, not a node, and `__dirname` is the folder the sources were built from. So: never spawn `process.execPath` with a script path (use `R.scriptCommand`), never hand a `__dirname`-relative file to another program (use `AS.file`), and require modules by literal path so the bundler sees them. A new non-JavaScript file the bridge needs goes into `assets.FILES` and `build/entry.js`; `tests/assets_test.js` fails until it is in both.

## Conventions

- **Lua** uses tabs, `local` everything, and only APIs present in the Forever client. Check against the `forever` branch of [Gethe/wow-ui-source](https://github.com/Gethe/wow-ui-source) before using a new API.
- **JavaScript** uses two-space indent, single quotes, `'use strict'`, CommonJS. The bridge must stay dependency-free: it is installed with `npm link` on machines that may never run `npm install`.
- **Transport constants** (`slots`, `actMax`, `presenceMax`, strip cell size and row counts) live in three places that must agree: `config.example.json`, the top of `ClaudeWoW.lua`, and `Codec.lua`. See [docs/CONFIGURATION.md](docs/CONFIGURATION.md).
- **Compatibility:** the bridge accepts older strip record formats, older `state.json` layouts, a `config.json` with Claude's settings at the top level, and history with role `claude`. Keep that when changing a format, and note it in `CHANGELOG.md`.
- **Agents:** everything an agent needs is its entry in `bridge/agents.js` (see "Adding an agent" in [docs/AGENTS.md](docs/AGENTS.md)); `bridge.js` must not know one agent from another. Permission rules are written in Claude Code's syntax everywhere and translated in the agent's `args`. A parser is fed each line of the CLI's stream as parsed JSON and must ignore what it doesn't know: the CLIs add event types between releases.
- Comments explain why, not what. Keep the section banners in `ClaudeWoW.lua` and `bridge.js` in order.

## Pull requests

1. Open an issue first for anything larger than a fix, so the approach can be discussed before you spend time on it.
2. One change per PR. Include the test that shows it works.
3. `npm test` must pass. Say in the PR whether you tried it in the game and on which client build.
4. Update `README.md`, `docs/`, and `CHANGELOG.md` when user-visible behaviour changes.

## Reporting bugs

Use the bug-report template. The useful details are the client build (shown on the login screen), the last lines of `~/.claude-wow/bridge.log`, and the output of `/claude diag` in game.
