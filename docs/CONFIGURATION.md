# Configuration reference

Everything the bridge reads: `config.json` in its home folder (`~/.claude-wow`, see [Where the bridge keeps its files](#where-the-bridge-keeps-its-files)), command-line flags, environment variables, and the files it writes there. `node setup.js` writes a working `config.json` from `bridge/config.example.json` (and brings an older one up to date); this page explains each key so you can tune it by hand.

The bridge reads `config.json` once at start. Restart it after editing, except for an agent's `allowedTools`, which the **Allow & retry** button updates live.

## Paths

| Key | Default (from `config.example.json`) | Meaning |
|---|---|---|
| `addonDir` | `…\World of Warcraft\_classic_beta_\Interface\AddOns` | The game's AddOns folder. The bridge writes the slot addons, `Inbox.lua` and every signal file under it. `setup.js` fills this in from the client it finds. |
| `inboxFile` | `<addonDir>\ClaudeWoW\Inbox.lua` | The file the game reads on `/reload` (fallback path). Normally derived from `addonDir`; only change it if you moved the addon. A value still naming an old addon (`WoWAI`, `WoWClaude`) is ignored in favour of the derived one. |
| `savedVariablesFile` | `…\WTF\Account\<account>\SavedVariables\ClaudeWoW.lua` | The addon's saved data. The bridge polls it for the reload-path outbox. `setup.js` picks the first account under `WTF\Account`; pass `--account <name>` to choose another. |
| `defaultCwd` | `C:\path\to\your\project` | Folder for chats that have not chosen one with `/claude-wow cd`, when the bridge is started from inside this repo (`npm start`). See [Which folder the agent works in](#which-folder-the-agent-works-in). |

## Agents

| Key | Default | Meaning |
|---|---|---|
| `agent` | `"claude"` | The agent for chats that have not picked one with `/claude-wow agent`. One of `claude`, `codex`, `grok`, `agy`, `hermes`; the bridge refuses to start on anything else. |
| `agents.<id>` | one block per agent | That agent's settings, below. A missing block means the defaults. |

Keys under `agents.claude`, `agents.codex`, `agents.grok`, `agents.agy` and `agents.hermes` (what each one means per agent is spelled out in [AGENTS.md](AGENTS.md)):

| Key | Default | Meaning |
|---|---|---|
| `permissionMode` | `"acceptEdits"` | `acceptEdits` auto-approves file edits inside the working folder; `bypassPermissions` approves everything; `default` approves nothing beyond what `allowedTools` names. Claude gets it as `--permission-mode`; for Codex it picks the sandbox (`read-only` / `workspace-write` / none); for Grok it becomes `--permission-mode dontAsk` plus allow rules, or `--always-approve` (headless Grok runs ordinary commands on its own and blocks dangerous ones unless a rule allows them; see [AGENTS.md](AGENTS.md)). |
| `allowedTools` | git, npm, npx, node, python, pip, pytest, ls, dir, WebSearch, WebFetch | Rules in Claude Code's syntax: `Bash(git:*)` allows any command starting with `git`, `WebSearch` a tool. Passed to Claude as `--allowedTools`, translated to Grok's `--allow` globs, ignored by Codex. The **Allow & retry** button in game appends rules here permanently. |
| `deniedTools` | `[]` | Rules the agent may never use, same syntax. Claude: `--disallowedTools`; Grok: `--deny`, which wins over everything, `bypassPermissions` included; ignored by Codex. |
| `model` | `""` | Passed to the CLI (`--model` / `-m`) when non-empty. Empty uses the CLI's default. |
| `path` | `""` | Full path to the executable. Empty means: look in the installer's folder, then (for Codex) `CODEX_BIN`, then `PATH`, then npm's launcher. A `.js` path is run with the bridge's Node (from the binary: the `node` on the `PATH`, so an npm-installed CLI still works). |
| `extraArgs` | `[]` | More command-line arguments, added verbatim (before Codex's `resume` subcommand). |
| `networkAccess` (codex only) | `false` | `true` lets commands inside Codex's `workspace-write` sandbox reach the network (`-c sandbox_workspace_write.network_access=true`). |

A `config.json` from before agents existed kept Claude's settings at the top level (`claudePath`, `model`, `permissionMode`, `allowedTools`). The bridge still reads them, under anything in `agents.claude`; `setup.js` moves them down.

## Plugins

| Key | Default | Meaning |
|---|---|---|
| `plugins.default` | `"ask"` | The plugin for chats that are not bound to one (`plugin=` flag): `ask` (general in-game chat) or `claude-code` (an agent session in a folder). The bridge refuses to start on a name it does not have; `--help` lists them. |
| `plugins.ask.cwd` | `""` | The scratch folder the `ask` plugin runs the agent in (it has no project). Empty = the per-user application data folder (`~/Library/Application Support/claude-wow/ask` on macOS, `%LOCALAPPDATA%\claude-wow\ask` on Windows, `~/.local/share/claude-wow/ask` on Linux), created on demand. |

A `config.json` without a `plugins` block keeps working: the default applies. Chats made before plugins existed are bound to `claude-code` by the addon, so they behave as before whatever the default is.

## Runs

| Key | Default | Meaning |
|---|---|---|
| `gameContext` | `true` | Put the character/zone context the addon sends into the agent's system prompt. `false` ignores it, for a bridge only ever used on unrelated projects. The addon has its own switch, `/claude-wow context off`, which also clears what the bridge holds. |
| `primerFile` | `"docs/WOW-ADDON-PRIMER.md"` | A markdown file appended to the system prompt together with the game context, whatever folder the chat works in: how to write addons and macros for this client. Relative to the claude-wow folder (from the binary: to `~/.claude-wow/assets`, where the binary writes its copy, so an edit there lasts until a new binary replaces it), or absolute. Re-read on every run, so edits count at once. `""` sends none. Off whenever the context is off. |
| `maxParallel` | `3` | How many chats may run an agent at the same time. Further messages queue per chat. |
| `timeoutMs` | `1800000` (30 min) | A run longer than this is killed (with its children) and reported as an error in game. |
| `progressWriteMs` | `3000` | Minimum gap between progress writes to the slot files. Final replies are written immediately. |
| `pollMs` | `750` | How often the bridge checks the SavedVariables file for a reload-path message. |

## Screen capture

Keys under `capture`:

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Run the outbound transport below. With `false` only the reload path works (`/claude-wow mode reload` in game). |
| `mode` | `"screenshot"` | Outbound transport. `screenshot` (the default; a config from before this key existed gets it too): no screen capture; the addon calls `Screenshot()` with the strip up for two frames and the bridge decodes the PNG/TGA the client writes to its `Screenshots` folder, then deletes it (files without a strip, i.e. your own screenshots, are left alone; strip-bearing leftovers from a bridge that was down are swept at startup and every 5 minutes). `pixel` (**deprecated**, kept only until `Screenshot()` is confirmed on Windows and on Linux under Wine): `capture.ps1` (Windows), `capture_mac.py` (macOS) or `capture_x11.py` (Linux) screen-captures the strip four times a second. The bridge names the mode in every slot file and the addon follows it; while the screenshot mode is on, the addon sets `screenshotFormat` to `png` and restores your value when it leaves the mode, when you log out, and at the next load if a crash skipped that. When the addon reports that it cannot shoot (`shot=missing`: no `Screenshot()`; `shot=failed`: every shot failed), the bridge falls back to `pixel` on its own, logs `TRANSPORT FALLBACK`, records `transportFallback` (`reason`, `at`, `session`) in `state.json` so the next start goes straight to pixels when `mode` is unset, and ships the reason as `transportNote` in the slot files for `/claude-wow diag`. An explicit `mode` always wins over that memory. |
| `screenshotLevels` | `{ "off": 0, "on": 60 }` | `screenshot` mode only: the two levels (0-255) each colour channel of a strip cell is drawn at. A screenshot is bit-exact, so dark levels read as well as bright ones and the strip is nearly invisible for the two frames it is up; the bridge decodes at the threshold halfway between them. `on - off` must be at least 8 or the default is used. The pixel transport ignores this and always draws full primaries. |
| `screenshotDir` | *(derived)* | `screenshot` mode: the client's `Screenshots` folder. Derived from `addonDir` (`<client>/Interface/AddOns` -> `<client>/Screenshots`) unless set. |
| `processName` | `"WowB"` | The game executable without `.exe`. `setup.js` sets it from the `Wow*.exe` it finds in the client folder (on macOS, from the binary inside the `.app` bundle). |
| `cellPx` | `4` | Pixel size of one strip cell. Must match `CELL` in `addon/ClaudeWoW/Codec.lua`. |
| `cellsPerRow` | `200` | Cells per strip row. Must match the addon. |
| `maxRows` | `48` | Maximum strip rows captured. Must match the addon. |
| `intervalMs` | `250` | Capture period. Lower is more responsive and costs a little more CPU. |
| `python` | `"python3"` | Linux and macOS: interpreter for `capture_x11.py` / `capture_mac.py`, i.e. only the deprecated pixel transport (and the fallback to it). |
| `windowName` | `""` | Linux and macOS: find the game window by title substring instead of by process name (on Linux, by WM_CLASS `<processName>.exe`). |
| `keepComposited` | `false` | Linux: set `_NET_WM_BYPASS_COMPOSITOR=2` on the game window so the compositor keeps drawing it. Try it if `npm run probe` sees a black or stale strip in borderless fullscreen. |

The capture region is `cellsPerRow × cellPx` by `maxRows × cellPx` pixels (800 × 192 by default) at the top-left of the game's client area. In `screenshot` mode the same cells are read from the top-left of the screenshot, which is the rendered frame, so it works on any display (a Retina display, where the screen capture cannot read the strip, included).

## Vision

| Key | Default | Meaning |
|---|---|---|
| `vision.maxWidth` | `1280` | `screenshot` mode only. When a chat has `/claude-wow vision on` (or sends `/claude-wow look ...`), the bridge cuts the strip's rows off the screenshot it decoded, scales the rest down to at most this many pixels wide (area averaging, so UI text stays readable) and attaches it to the run as a PNG. A 1080p frame becomes 1280x712, 1.5-2 MB; the Anthropic API takes images up to 5 MB and itself downscales anything past 1568 pixels on the long edge, so higher values buy little. |
| `vision.keep` | `6` | How many of those PNGs may sit in `~/.claude-wow/tmp` at once: one per message that asked, deleted when its run ends, so only runs that never started (a bridge killed mid-queue) leave one. The oldest beyond this are removed, and all of them when the bridge starts. |

## Slot pool and signal files

These sizes are baked into the files `install-slots.js` creates, and the addon has matching constants at the top of `addon/ClaudeWoW/ClaudeWoW.lua` (`SLOT_COUNT`, `ACT_MAX`, `PRESENCE_MAX`). Change all three places together, re-run `node bridge/install-slots.js`, and restart the game.

| Key | Default | Meaning |
|---|---|---|
| `slots` | `200` | Reply-slot addons `ClaudeWoW_S001` … `ClaudeWoW_S200`. Each slot can be loaded once per UI session; `/reload` frees them all. |
| `actMax` | `60` | Heartbeat files per message (`act/NNN/01..60.wav`). One flips per agent action. |
| `presenceMax` | `2000` | Presence files (`presence/0001..2000.wav`). One flips per `presenceIntervalMs`. |
| `presenceIntervalMs` | `30000` | How often the bridge flips a presence file so the in-game light stays green. |
| `tocInterface` | `"16001"` | `## Interface:` version written into every slot addon's `.toc`. Bump it when the client's TOC version changes. |

## Command line

`claude-wow` (the installer's binary or shim, `npm link`, or the Homebrew formula) and `node bridge/bridge.js` take the same flags. `npm start` runs `bridge/supervisor.js`, which restarts the bridge on crash and passes flags through. The subcommands are handled by the supervisor itself:

| Subcommand | Meaning |
|---|---|
| `claude-wow setup [...]` | Runs `setup.js` with the given flags (see [`setup.js` flags](#setupjs-flags)). |
| `claude-wow service install\|uninstall\|start\|stop\|restart\|status\|logs [-n N] [-f]` | The bridge as a per-user background service that starts at login and comes back after a crash: a LaunchAgent on macOS, a systemd `--user` unit on Linux, a Startup-folder launcher on Windows. `status` exits 0 when running, 3 when not. See [INSTALL.md](INSTALL.md#running-the-bridge). |
| `claude-wow bridge [...]` | `bridge.js` alone, in this process, with the flags below and no restarts. This is how the supervisor runs the bridge from the compiled binary, which has no node to hand a script path to (`bridge/runtime.js`); it works from a checkout too. |
| `claude-wow install-slots` | `install-slots.js` alone (setup runs it for you); from the binary, how setup runs it. |
| `claude-wow --version` | The version and the runtime: `claude-wow 0.4.0 (node 24.21.0)`, `(bun 1.4.2)` or `(claude-wow binary (bun 1.4.2))`. |

Environment: `CLAUDE_WOW_SERVICE=1` is set by the service definitions and tells the supervisor to write its output to the service log and a pid file instead of a terminal; `CLAUDE_WOW_HOME` (below) is passed through to the service when set.

| Flag | Meaning |
|---|---|
| `--project <dir>` | Default working folder for this run. Overrides everything else. |
| `--once` | Handle one pending reload-path message and exit. |
| `--inject "<text>"` | Pretend the strip said this, run the agent, publish the result, exit. Handy for checking a setup without the game. |
| `--agent <id>` | Which agent `--inject` uses (default: `agent` from the config). |
| `--help`, `-h` | Print usage. |

Exit codes: `0` normal, `1` the injected or one-shot job failed, `2` config missing, unreadable or naming an unknown agent. The supervisor only restarts on codes other than `0` and `2`.

## Environment

| Variable | Meaning |
|---|---|
| `CLAUDE_WOW_HOME` | Where `config.json`, `state.json`, `transcripts.json`, `bridge.log`, `tmp/` and `mapjobs/` live. Default `~/.claude-wow`; see [Where the bridge keeps its files](#where-the-bridge-keeps-its-files). |
| `CLAUDE_WOW_PROJECT` | Default working folder, below `--project` and above the start folder in precedence. The old name `WOW_AI_PROJECT` is still read. |
| `CLAUDE_WOW_MAC_BACKEND` | macOS pixel capture: `native`, `screencapture` or `auto` (`capture_mac.py --backend`). The old name `WOWAI_MAC_BACKEND` is still read. |
| `CLAUDECODE` | Removed from Claude's environment so a bridge started from inside a Claude Code session can still launch `claude -p`. |
| `GROK_DISABLE_AUTOUPDATER` | Set to `1` for Grok runs, so a headless run never stops for an update. |
| `GROK_HOME` | Honoured when looking for `grok.exe` (`<GROK_HOME>\bin`); Grok's own setting. |
| `CLAUDE_WOW_MAP_FILE` | Set by the bridge for each run, whatever the agent: a file where the agent's tools append map commands, one JSON object per line (see [MAP.md](MAP.md)). |

## Which folder the agent works in

Each chat can pick its own folder with `/claude-wow cd` or **Folder...** in the menu that opens when you right-click the chat in the left panel. Chats that have not are given the bridge's default folder, chosen in this order:

1. `--project <dir>`
2. `CLAUDE_WOW_PROJECT`
3. The folder the bridge was started from, unless that is inside this repo
4. `defaultCwd` in `config.json`
5. The current folder

A relative `/claude-wow cd` path is resolved against that default. `~` expands to your home folder. The agents keep sessions per folder, so a chat that changes folder starts a fresh session there; the same happens when a chat changes agent.

## Where the bridge keeps its files

The bridge separates what it runs from what it remembers. The code can be replaced (`git pull`, `brew upgrade`, the installer run again) without touching any of the files below, which live in a home folder chosen in this order:

1. `CLAUDE_WOW_HOME`, when set (a leading `~` expands).
2. `~/.claude-wow`, once it holds a `config.json`.
3. The checkout's `bridge/` folder, while it holds a `config.json`: the layout from before there was a home folder. The next `node setup.js` copies `config.json`, `state.json` and `transcripts.json` from there to `~/.claude-wow` (copies, never moves: an older checkout still reads `bridge/`), and the bridge reads them in `~/.claude-wow` from then on. Nothing is ever copied into an explicit `CLAUDE_WOW_HOME`.
4. `~/.claude-wow` otherwise (a fresh install; setup writes the config there).

The bridge's banner prints the folder it chose (`home :`). The one-line installer puts the code in `~/.claude-wow/app`, next to these files; Homebrew keeps the code in its keg and only these files in `~/.claude-wow`.

| File | Contents |
|---|---|
| `~/.claude-wow/config.json` | Your configuration. |
| `~/.claude-wow/state.json` | Agent session ids per chat, the folder and the agent each session ran with, handled message ids per addon session token, the presence counter, and the latest game context the addon sent (`context`). Delete it to forget all sessions. |
| `~/.claude-wow/transcripts.json` | The last 200 messages of every chat, with the agent that wrote each reply, so the addon can recover its chats after the client wipes saved data. |
| `~/.claude-wow/mapjobs/` | One map command file per running job (`CLAUDE_WOW_MAP_FILE`), read and deleted when the job ends. Map layers themselves live in `state.json` (`map`). |
| `~/.claude-wow/bridge.log` | Every line the bridge logs, with timestamps. Rotated by the supervisor at 5 MB (`bridge.log.1` … `.5` kept), so it never grows without bound. Under the background service the bridge's full output (banner, log lines, crashes) also goes to the service log: `~/Library/Logs/claude-wow/bridge.log` on macOS, `$XDG_STATE_HOME/claude-wow/bridge.log` (default `~/.local/state/claude-wow`) on Linux, `%LocalAppData%\claude-wow\logs\bridge.log` on Windows, rotated the same way; `claude-wow service logs` shows whichever applies. |
| `~/.claude-wow/tmp/` | Prompt files for agents that read the prompt from disk (Grok). Each is deleted when its run ends. |

## `setup.js` flags

| Flag | Meaning |
|---|---|
| `--wow "<client folder>"` | The folder containing `Wow*.exe` and `Interface\`, when auto-detection fails. |
| `--project "<dir>"` | Written to `defaultCwd`. Defaults to the folder you ran setup from. |
| `--account <name>` | Which `WTF\Account\<name>` to use when there are several. |

Re-running `setup.js` re-copies the addon (except `Inbox.lua`, which the bridge owns once running), keeps an existing `config.json` (adding the `agents` blocks and fixing paths if it predates them), and only creates slot and signal files that are missing. An install under one of the project's old names (the `WoWAI` addon, or `WoWClaude` before it) is migrated: its saved data is copied to `ClaudeWoW.lua` with the globals renamed so chats survive (the old file is kept), the old addon and slot folders are removed, and `inboxFile` / `savedVariablesFile` in an old `config.json` are rewritten.
