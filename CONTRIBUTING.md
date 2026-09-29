# Contributing

Thanks for looking at this. Bug reports, questions and pull requests are all welcome. This page covers how the repo is laid out, how to run the tests, and what a good change looks like.

## Layout

```
addon/ClaudeWoW/     the in-game addon (Lua 5.1, WoW API)
  ClaudeWoW.lua        everything: strip, slots, chats, UI, slash commands
  Codec.lua             pixel-strip encoder, pure Lua, no WoW calls
  Inbox.lua             placeholder the bridge overwrites at runtime
  Widgets.lua           live UI widgets from the agent, sandboxed, /claude-wow ui
  ClaudeWoW.toc
bridge/               the companion process (Node.js, no runtime dependencies)
  bridge.js             I/O, processes, publishing
  protocol.js           pure functions: strip records, slot files, folders, dedup
  agents.js             one entry per agent (Claude, Codex, Grok, Antigravity, Hermes): command line, prompt delivery, stream parser
  capture.ps1           screen capture and strip decoder (PowerShell)
  install-slots.js      creates the slot addons and signal files
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
| `node --test tests/addon_test.js` | The real addon in a Lua VM with a stub client (`tests/wow_stub.lua`): login, hello, a message decoded off the strip, a slot reply, Allow, `/claude-wow reset`, restore, chat commands, minimize, reload mode, and the screenshot transport (shots per message, retries, the timeout, CVar save/restore, the dark palette). |
| `node --test tests/bridge_test.js` | `bridge/protocol.js`: strip records, flags (including `agent=`), the SavedVariables outbox, folder resolution, permission rules, dedup and pruning. |
| `node --test tests/agents_test.js` | `bridge/agents.js`: the command line built for each agent and permission mode, the prompt delivery (stdin, prompt file, context block), a sample of each CLI's real stream (Claude stream-json, Codex `exec --json`, Grok streaming-json, agy stream-json, Hermes plain text) read back into progress lines, session id, denials and reply, and the unwrapping of npm's Windows launchers. |
| `node --test tests/restore_test.js` | Slot files are valid Lua and read back field by field, including a restore bundle. |
| `node --test tests/map_test.js` | The map protocol in `protocol.js`: command validation and sanitizing, versioned application and budgets, ```` ```wowmap ```` blocks and map files, and the `map` table in slot files read back in a Lua VM. |
| `node --test tests/map_addon_test.js` | The real `Map.lua` (with `ClaudeWoW.lua`) in a Lua VM: sync and versions, pin projection on zone and continent maps, the navigator's yards, bearing and auto-advance, herb/ore nodes filtered by skill, and `/claude-wow map`. |
| `node --test tests/voice_test.js` | The real `Voice.lua` (with `ClaudeWoW.lua`) in a Lua VM: every classic race and gender has every line, each pack covers every event, the lines played on send, pick-up, reply, error and permission, the throttle, and `/claude-wow voice`. |
| `node --test tests/decode_test.js` | `bridge/decode.js`, the screenshot transport's reader: `Codec.lua` in a Lua VM, rendered inside a 1920x1080 frame as PNG (every filter type, RGB and RGBA) and TGA (raw and RLE, 24 and 32 bit, both row orders), bright and dark palettes, offsets, bad checksum, truncation and an oversized length field. |
| `node --test tests/screenshots_test.js` | `bridge/screenshots.js`: the client's `Screenshots` folder derived from `addonDir`, the file-name filter, and the watcher reporting a new file once its size settles while ignoring files from before it started. |
| `node --test tests/service_test.js` | `bridge/service.js`: the LaunchAgent plist (and `plutil -lint` on macOS), the systemd unit and the Windows launcher it writes, `claude-wow service` argument parsing, log rotation and the self-rotating writer, the pid file, the launchctl output parser, and `status` on a clean machine. |
| `node --test tests/install_test.js` | `install.sh` and `install.ps1`: they parse, the Node 22.2 gate accepts and rejects the right versions, unknown options and a missing Node fail with a hint, and `install.sh` runs nothing until fully read. |
| `node --test tests/runtime_test.js` | `bridge/runtime.js`: the command that runs each of the bridge's own scripts from a checkout (this node and the script) and from the compiled binary (the binary and a subcommand), and where a JavaScript launcher finds a node in each case. |
| `node --test tests/assets_test.js` | `bridge/assets.js`: every embedded file exists and the addon folder is covered in full, `build/entry.js` embeds exactly that list, an embedded set is written out once and rewritten only where it differs, and `build.js` names one binary per target. |
| `node --test tests/widget_test.js` | The widget protocol in `protocol.js`: validation and the display-only deny-list, versioned application and budgets, ```` ```wowui ```` blocks and widget files, the hint only for a plugin with the `ui` surface, the `widgets` table in slot files read back in a Lua VM, and that the addon blocks the same names. |
| `node --test tests/widget_addon_test.js` | The real `Widgets.lua` (with `ClaudeWoW.lua`) in a Lua VM: a widget running live from slot data, errors surfaced to the chat window, blocked calls in the sandbox, `/claude-wow ui` list, remove and run, restart at login, and the reload path. |
| `node tests/codec_test.js` | `Codec.lua` in a Lua VM, rendered to PNG with noise and gamma, decoded by `capture.ps1` (Windows) or `capture_x11.py` (elsewhere). Writes scratch images to `tests/tmp/` (gitignored). |
| `npm run test:live` | Not part of `npm test`. Builds a sandbox under `tests/tmp/inject/` with a 5-slot pool and runs the bridge with `--inject` against a real agent CLI: Claude by default, `-- --agent codex` or `-- --agent grok` for the others. Needs that CLI installed and logged in. |

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

Use the bug-report template. The useful details are the client build (shown on the login screen), the last lines of `~/.claude-wow/bridge.log`, and the output of `/claude-wow diag` in game.
