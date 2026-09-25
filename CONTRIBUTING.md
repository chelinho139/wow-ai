# Contributing

Thanks for looking at this. Bug reports, questions and pull requests are all welcome. This page covers how the repo is laid out, how to run the tests, and what a good change looks like.

## Layout

```
addon/WoWAI/     the in-game addon (Lua 5.1, WoW API)
  WoWAI.lua        everything: strip, slots, chats, UI, slash commands
  Codec.lua             pixel-strip encoder, pure Lua, no WoW calls
  Inbox.lua             placeholder the bridge overwrites at runtime
  WoWAI.toc
bridge/               the companion process (Node.js, no runtime dependencies)
  bridge.js             I/O, processes, publishing
  protocol.js           pure functions: strip records, slot files, folders, dedup
  agents.js             one entry per agent (Claude, Codex, Grok, Antigravity, Hermes): command line, prompt delivery, stream parser
  capture.ps1           screen capture and strip decoder (PowerShell)
  install-slots.js      creates the slot addons and signal files
  supervisor.js         restarts bridge.js on crash; the `wow-ai` command
  config.example.json   template setup.js copies to config.json
setup.js              one-shot installer
tests/                see below
docs/                 ARCHITECTURE.md, AGENTS.md, CONFIGURATION.md, INSTALL-WINDOWS.md
```

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) first. The two transports (pixels out, load-on-demand slots in) follow from three facts about the WoW sandbox, and most design choices make sense only in that light.

## Setting up for development

```powershell
git clone https://github.com/chelinho139/wow-ai
cd wow-ai
npm install          # test tooling only: fengari (Lua VM) and luaparse
npm test
```

`npm test` runs the portable suite on every platform. The codec round-trip decodes through `capture.ps1` on Windows and through `capture_x11.py` (python3) elsewhere. CI runs the full command on `windows-latest` and `ubuntu-latest` (`.github/workflows/test.yml`).

To try changes in the game, run `node setup.js` (it re-copies the addon into `Interface\AddOns\WoWAI`) and `/reload`. Bridge changes take effect on the next `npm start`.

## Tests

| Command | What it checks |
|---|---|
| `node tests/order_check.js` | The addon parses as Lua 5.1 and no top-level `local` is used before it is declared. |
| `node --test tests/addon_test.js` | The real addon in a Lua VM with a stub client (`tests/wow_stub.lua`): login, hello, a message decoded off the strip, a slot reply, Allow, `/wow-ai reset`, restore, chat commands, minimize, reload mode. |
| `node --test tests/bridge_test.js` | `bridge/protocol.js`: strip records, flags (including `agent=`), the SavedVariables outbox, folder resolution, permission rules, dedup and pruning. |
| `node --test tests/agents_test.js` | `bridge/agents.js`: the command line built for each agent and permission mode, the prompt delivery (stdin, prompt file, context block), a sample of each CLI's real stream (Claude stream-json, Codex `exec --json`, Grok streaming-json, agy stream-json, Hermes plain text) read back into progress lines, session id, denials and reply, and the unwrapping of npm's Windows launchers. |
| `node --test tests/restore_test.js` | Slot files are valid Lua and read back field by field, including a restore bundle. |
| `node --test tests/map_test.js` | The map protocol in `protocol.js`: command validation and sanitizing, versioned application and budgets, ```` ```wowmap ```` blocks and map files, and the `map` table in slot files read back in a Lua VM. |
| `node --test tests/map_addon_test.js` | The real `Map.lua` (with `WoWAI.lua`) in a Lua VM: sync and versions, pin projection on zone and continent maps, the navigator's yards, bearing and auto-advance, herb/ore nodes filtered by skill, and `/wow-ai map`. |
| `node tests/codec_test.js` | `Codec.lua` in a Lua VM, rendered to PNG with noise and gamma, decoded by `capture.ps1` (Windows) or `capture_x11.py` (elsewhere). Writes scratch images to `tests/tmp/` (gitignored). |
| `npm run test:live` | Not part of `npm test`. Builds a sandbox under `tests/tmp/inject/` with a 5-slot pool and runs the bridge with `--inject` against a real agent CLI: Claude by default, `-- --agent codex` or `-- --agent grok` for the others. Needs that CLI installed and logged in. |

When you change behaviour, add or extend a test in the matching file. Pure logic belongs in `protocol.js` where `bridge_test.js` can reach it without spawning anything.

## Conventions

- **Lua** uses tabs, `local` everything, and only APIs present in the Forever client. Check against the `forever` branch of [Gethe/wow-ui-source](https://github.com/Gethe/wow-ui-source) before using a new API.
- **JavaScript** uses two-space indent, single quotes, `'use strict'`, CommonJS. The bridge must stay dependency-free: it is installed with `npm link` on machines that may never run `npm install`.
- **Transport constants** (`slots`, `actMax`, `presenceMax`, strip cell size and row counts) live in three places that must agree: `config.example.json`, the top of `WoWAI.lua`, and `Codec.lua`. See [docs/CONFIGURATION.md](docs/CONFIGURATION.md).
- **Compatibility:** the bridge accepts older strip record formats, older `state.json` layouts, a `config.json` with Claude's settings at the top level, and history with role `claude`. Keep that when changing a format, and note it in `CHANGELOG.md`.
- **Agents:** everything an agent needs is its entry in `bridge/agents.js` (see "Adding an agent" in [docs/AGENTS.md](docs/AGENTS.md)); `bridge.js` must not know one agent from another. Permission rules are written in Claude Code's syntax everywhere and translated in the agent's `args`. A parser is fed each line of the CLI's stream as parsed JSON and must ignore what it doesn't know: the CLIs add event types between releases.
- Comments explain why, not what. Keep the section banners in `WoWAI.lua` and `bridge.js` in order.

## Pull requests

1. Open an issue first for anything larger than a fix, so the approach can be discussed before you spend time on it.
2. One change per PR. Include the test that shows it works.
3. `npm test` must pass. Say in the PR whether you tried it in the game and on which client build.
4. Update `README.md`, `docs/`, and `CHANGELOG.md` when user-visible behaviour changes.

## Reporting bugs

Use the bug-report template. The useful details are the client build (shown on the login screen), the last lines of `bridge/bridge.log`, and the output of `/wow-ai diag` in game.
