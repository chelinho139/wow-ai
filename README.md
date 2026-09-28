# wow-ai

<p align="center">
  <img src="docs/screenshot.jpg" alt="The WoW AI chat window open in Goldshire, with a message on its way to a coding agent" width="900">
</p>

Chat with your local coding agents from inside **World of Warcraft: Forever**: [Claude Code](https://claude.com/claude-code), [OpenAI Codex](https://developers.openai.com/codex), [xAI's Grok Build](https://docs.x.ai/build/overview), Google's Antigravity CLI and Hermes Agent. Send a task, go back to questing, get pinged in-game when the answer lands. No alt-tabbing, no `/reload` per message.

- Multiple chats, each its own persistent agent session (like separate terminals), running in parallel. Each chat picks its agent and its folder
- Live progress while the agent works: action count, elapsed time, the files it's editing and commands it's running
- Replies echoed into the game chat; `/r` replies to the agent when it was the last to message you
- The agent knows your character, level, zone, talents, professions and quest log (optional), and you can shift-click items, spells and quests into a message
- The agent can draw on your world map: numbered routes, quest stops and marks, with a navigator arrow that walks you from stop to stop
- Herb and ore spawns on the world map, filtered by your gathering skill (`/wow-ai map ore`, `/wow-ai map herb`)
- Ready-made macros: ask for one and the reply carries a **Create macro** button that saves it and puts it on your cursor, ready to drop on an action bar (`/wow-ai macro undo` reverts it)
- An **Allow & retry** button when Claude or Grok needs a command outside your allowlist
- A status light for the bridge, automatic retries, and recovery of your chats (and map layers) if the beta client wipes addon data
- Runs on Windows, on Linux with the game under Wine, and on macOS with a native client

Nothing here injects code, reads game memory, or generates input. The addon uses documented addon APIs only; the companion reads your screen and writes ordinary files.

## How it works, in one paragraph

WoW addons are sandboxed: no network, no file reads at runtime. Two doors remain. **Out:** the addon draws your message as a strip of colored 4-pixel squares in the top-left corner of the screen; the bridge screen-captures that corner four times a second, decodes it, and runs the chat's agent headless in the chat's folder. **In:** a load-on-demand addon reads its files from disk at the moment it is loaded, so the bridge writes the reply into a pool of 200 pre-made slot addons and the game loads a fresh one from a timer. Cheap "is it ready yet" checks ride on a third trick: an empty `.wav` won't play and a valid one will. Map layers travel the same way: the agent's tools hand them to the bridge, which keeps them versioned and ships them inside the slot files. Details in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/MAP.md](docs/MAP.md).

## Plugins

What a chat *does* with your message is a plugin's business; the window, the whisper tabs, the game-chat echo, the map, macros, your character context and the transcripts are the same whatever the chat is bound to ([docs/PLATFORM.md](docs/PLATFORM.md)).

| Plugin | What it is |
|---|---|
| `ask` (default) | General in-game AI chat: game questions, quest research, routes on the map, macros. No project, no folder: the agent runs in a scratch folder of its own and is told it is your in-game assistant, not a coding session. |
| `claude-code` | An agent session in a folder, what the bridge was before plugins: `/wow-ai cd` picks the project, the agent edits and runs things there. |

A chat is bound to a plugin the way it is bound to an agent: `/wow-ai plugin claude-code`, or right-click the chat and pick **Plugin...**; a chat bound to nothing follows the bridge's default (`plugins.default` in `bridge/config.json`, `ask` unless you change it). Chats you made before plugins existed stay bound to `claude-code`, so nothing changes for them; a new chat inherits the binding of the chat you were in. A message that starts with `@ask ` or `@claude ` (in the window or a whisper tab) goes to that plugin whatever the chat is bound to. Either plugin runs whichever agent the chat picked.

## Agents

The bridge drives whichever of these you have installed; each chat can use a different one.

| Agent | CLI the bridge runs | Permissions | Allow & retry |
|---|---|---|---|
| **Claude Code** (`claude`) | `claude -p --output-format stream-json`, resumed with `--resume` | `permissionMode` + `allowedTools` rules | yes |
| **Codex** (`codex`) | `codex exec --json`, resumed with `codex exec resume` | a sandbox chosen from `permissionMode` (read-only, workspace-write, or none) | no: a command the sandbox declined is reported in the reply |
| **Grok Build** (`grok`) | `grok --prompt-file … --output-format streaming-json`, resumed with `-r` | `permissionMode` + the same `allowedTools` rules, translated to Grok's globs | yes, when Grok reports a refused tool |
| **Antigravity** (`agy`) | `agy -p=<prompt> --output-format stream-json`, resumed with `--conversation` | Antigravity permission switches | no |
| **Hermes** (`hermes`) | `hermes chat --query-file -`, resumed with `--resume` | default only; the bridge never uses `--yolo` | no |

`agent` in `bridge/config.json` is the default (`claude`). `/wow-ai agent codex` switches the current chat, or right-click a chat in the left panel and pick **Agent...**; the reply bubbles and the game-chat echo are labelled with whoever answered. A session belongs to the agent that made it, so a chat that changes agent starts a fresh session there (its transcript stays). Install notes, the exact command lines, what each permission mode means per agent, and known limits are in [docs/AGENTS.md](docs/AGENTS.md).

## Requirements

- Windows (NTFS), or Linux with the game under Wine (see [docs/INSTALL-LINUX.md](docs/INSTALL-LINUX.md)), or macOS with a native client; python3 for the pixel-capture transport off Windows
- World of Warcraft: Forever (tested on 1.60.1.69913 and 1.60.1.69977, TOC 16001), **windowed or borderless** (exclusive fullscreen blocks screen capture)
- [Node.js](https://nodejs.org) 22.2 or newer
- At least one agent CLI, installed and logged in:
  - [Claude Code](https://claude.com/claude-code): `claude --version` works
  - [Codex](https://developers.openai.com/codex): `npm install -g @openai/codex`, then `codex` once to log in
  - [Grok Build](https://docs.x.ai/build/overview): `irm https://x.ai/cli/install.ps1 | iex`, then `grok login`
  - Antigravity (`agy`): install Google's Antigravity CLI, then run `agy` once to log in
  - Hermes Agent (`hermes`): install it, then run `hermes setup` once

## Install

One line, then a game relaunch. Full detail, every route and the background service: [docs/INSTALL.md](docs/INSTALL.md).

macOS and Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/rdimascio/wow-ai/main/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/rdimascio/wow-ai/main/install.ps1 | iex
```

The installer checks for Node 22.2+, puts the code in `~/.wow-ai` (Windows: `%LocalAppData%\Programs\wow-ai`) and a `wow-ai` command on your PATH, runs the game-side setup (addon into `Interface/AddOns/WoWAI`, `bridge/config.json`, the slot pool: ≈15,000 tiny files, which is normal since the client only discovers addon files at launch), and offers to run the bridge in the background from now on. It never uses sudo, is safe to re-run (that is how you update), and stops with a message saying what to do if anything is missing. Pass `--wow "<client folder>"` if setup cannot find the client and `--project <folder>` for the default folder the agents work in (after `sh -s --`; on Windows through `$env:WOW_AI_WOW` and `$env:WOW_AI_PROJECT`).

Then **fully quit and relaunch WoW**, enable *WoW AI* on the AddOns screen, and:

```
wow-ai                    # the bridge in this terminal; Ctrl+C stops it, it restarts itself after a crash
wow-ai service install    # or: in the background, now and at every login
wow-ai service status     # running? pid, uptime, last log lines   (also: logs, stop, start, restart, uninstall)
```

In game: `/wow-ai`. The bridge's banner lists every agent with where its executable was found, or what to install.

Other routes: `brew tap rdimascio/wow-ai && brew install --HEAD wow-ai` then `wow-ai setup` (Homebrew cannot install the addon; see the caveat in [docs/INSTALL.md](docs/INSTALL.md#route-2-homebrew-macos)), or `git clone` and `node setup.js` then `npm start` by hand. Platform notes: [docs/INSTALL-WINDOWS.md](docs/INSTALL-WINDOWS.md), [docs/INSTALL-LINUX.md](docs/INSTALL-LINUX.md), and the macOS section below.

### macOS (native client)

Setup looks for the client under `/Applications/World of Warcraft` and `~/Applications/World of Warcraft` (pass `--wow "<client folder>"` otherwise). Two transports: with `"mode": "screenshot"` under `capture` in `bridge/config.json`, the addon takes a screenshot with the strip up and the bridge reads the file from the client's `Screenshots` folder; no screen capture, no permissions, works on Retina displays, and the only configuration that makes sense for the background service (a background process cannot ask for Screen Recording). The default `pixel` transport captures the game window with `bridge/capture_mac.py` (python3 only) and needs **Automation** (System Events) and **Screen & System Audio Recording** for the terminal the bridge runs in; macOS does not always prompt, so `setup.js` checks both and names whichever is missing (`npm run check:mac` re-runs that check; `npm run probe:mac` saves what the capture sees to `bridge/probe.png`). Grant a permission, then quit and reopen the terminal. The pixel decoder reads one image pixel per addon pixel, so on a Retina display it never decodes; use the screenshot transport there (see [docs/CONFIGURATION.md](docs/CONFIGURATION.md)).

### Upgrading from wow-claude

This project used to be called wow-claude, with a `WoWClaude` addon and a `/wow-claude` command. Run the installer, or `git pull` and `node setup.js`: it copies your chats and settings from the old addon's saved data, removes the old `WoWClaude` addon and its slot folders so the two don't fight over `/ai` and `/r`, and rewrites the paths and the Claude settings in `bridge/config.json` into the new layout. Then quit and relaunch WoW. If you had installed the command with `npm link`, run `npm unlink -g wow-claude` and `npm link` again, and re-do `/wow-ai bind <key>` if you had a hotkey. Your agent sessions carry on: the bridge keeps them per chat.

### `wow-ai`: start it from the project folder

Like the agent CLIs themselves, the bridge works in the folder you start it from:

```
cd ~/code/realms
wow-ai
```

Every chat that hasn't picked its own folder now works in `realms`, and the panel's cwd line shows it. `wow-ai --project <dir>` names the folder explicitly; the background service and `npm start` inside the repo fall back to `defaultCwd` in the config (`wow-ai setup --project <dir>` sets it). Only one bridge can run at a time (two would fight over the screen and the slot files), so this sets the default folder rather than giving you one bridge per project.

## Use

In game: `/wow-ai` opens the window. Until the bridge has answered, a **Connect** button sits where Send would be: start the bridge, click it, and the light turns green (a message typed before that stays in the box). Then click the input box, type, Enter. The reply arrives with the whisper sound; the window's light shows the bridge state (green/yellow/red, hover for details), and **Reconnect** shows up if the bridge goes quiet.

Right-clicking a chat in the left panel opens a small menu with **Rename...**, **Folder...**, **Agent...** and **Plugin...** (right-click again to close it); the trash can on the row deletes the chat after an OK/Cancel confirm. **Folder...** sets the folder this chat's agent works in (same as `/wow-ai cd` below), **Agent...** which agent answers it (same as `/wow-ai agent`), **Plugin...** what the chat is for, `ask` or `claude-code` (same as `/wow-ai plugin`); each chat keeps its own, so you can have a general chat next to chats on different projects, with different agents, side by side. The window's footer shows all three, and `/wow-ai diag` the plugin.

| Command | What it does |
|---|---|
| `/wow-ai` | toggle the window (`/ai`, `/wowai` and the old `/wow-claude` are the same command); the minimize button (top right) or Esc collapses it to a small bar, click the bar to expand |
| `/ai <text>` | send from the normal chat box (`/wow-ai <text>` is the same). `/ai` is a full alias, so `/ai agent grok` or `/ai cd realms` work too; a message that merely starts with a command word, like `/ai help me with this macro` or `/ai delete the unused imports`, is still sent as a message because the rest of the line doesn't fit that command |
| `/r <text>` | replies to the agent when it was the last to message you; otherwise the normal whisper reply |
| `/wow-ai whisper on\|off` | each chat as a native whisper tab in the chat dock (off by default): replies arrive there as whispers and flash the tab, what you type there goes to the agent, never to the server. The window stays the full record |
| `/wow-ai new [name]` | new chat = new agent session. Unnamed chats take their title from your first message |
| `/wow-ai chat <n\|name>` | switch chats (or click the left panel; right-click a row for Rename, Folder and Agent, its trash can deletes it) |
| `/wow-ai agent [claude\|codex\|grok\|agy\|hermes]` | which agent this chat talks to; no name shows the current one and the bridge's default, `default` goes back to the bridge's. A chat that changes agent starts a fresh session with it |
| `/wow-ai cd <folder>` | folder this chat's agent works in (**Folder...** after right-clicking the chat opens the same thing as a dialog). Relative to the bridge's folder (`/wow-ai cd realms`, `/wow-ai cd ../other`), `~` works, a full path too; `/wow-ai cd` alone goes back to the bridge's default. A chat that changes folder starts a fresh session there |
| `/wow-ai reset` | wipe this chat's agent memory, keep the transcript |
| `/wow-ai context [on\|off]` | show what the agent is told about your character and location, or turn it on/off |
| `/wow-ai vision [on\|off]` | send a picture of your screen with each message, so the agent sees what you see: "what is this item?", "why is this boss killing me?", "read this quest" (off by default; needs the screenshot transport) |
| `/wow-ai look <question>` | one message with a picture of your screen, whatever the setting (`/ai look what is this?` from the chat box too) |
| `/wow-ai rename`, `/wow-ai delete`, `/wow-ai clear` | manage the current chat |
| `/wow-ai echo summary\|full\|short\|off\|<chars>` | how much of each reply to print into the game chat. `summary` (the default) prints only the agent's closing TL;DR lines, the full reply is in the window behind `[open]`; `full` prints up to 4000 chars, `short` one preview line |
| `/wow-ai longchat on` | let the game chat box take 4000 characters, for long `/ai` messages |
| `/wow-ai bind <key>` | hotkey: checks for a reply while waiting, otherwise toggles the window |
| `/wow-ai cancel` | stop waiting on this chat's reply |
| `/wow-ai resend` | show the strip again if the bridge missed it |
| `/wow-ai reload` | reload the UI now (also frees the slot pool) |
| `/wow-ai mode reload` | fallback transport that costs a `/reload` per step, if pixels or slots can't work |
| `/wow-ai diag`, `/wow-ai slots` | transport diagnostics |
| `/wow-ai help` | the full list |

Click any message, or `/wow-ai copy` for the last reply, to open it in a selectable box for Ctrl+C.

### Short in the chat, full in the window

Every run tells the agent that only a short summary of its reply is printed in the game chat, and asks it to end each reply with a `TL;DR:` block of one or two lines. The bridge splits that block off and the addon prints just those lines under `[Claude · chat]`, with the `[open]` link to the whole reply in the window (the window keeps the full text, TL;DR included). When an agent forgets the block, the first two lines of the reply are printed instead, with a hint to open the rest. `/wow-ai echo full` goes back to printing the whole reply.

### The agent knows where you are

The addon tells the agent which game and client you are on, your character (name, realm, level, race, class, faction, guild), where you are (zone, subzone and the map coordinates the minimap shows), your money, talents, professions with their skill, and your quest log (quest ids, marking the ones ready to turn in). A few lines, sent with the addon's hello and again whenever they change, and put into the agent's system prompt by the bridge (Claude and Grok take a system prompt; for Codex the bridge puts it at the top of the message, marked as context), so you can ask "what should I be doing at my level around here?" or "write me a macro for my class" without explaining yourself first. It is only a hint: for a chat about an unrelated project it changes nothing. `/wow-ai context` shows exactly what is sent; `/wow-ai context off` stops sending it (the bridge forgets it too), and `"gameContext": false` in `bridge/config.json` turns it off for good.

Along with it, every run gets [docs/WOW-ADDON-PRIMER.md](docs/WOW-ADDON-PRIMER.md): a short reference on writing addons and macros for this client (TOC layout, sandbox rules, common frames and events, where to verify an API), so "write me an addon that..." works from any folder, not just this repo. Edit the file to suit your setup; the bridge re-reads it on every run. `"primerFile": ""` in the config drops it, and `/wow-ai context off` turns it off together with the character context.

### Link items, spells and quests

Click the input box, then **shift-click** an item in your bags, a spell in the spellbook, a quest in the log, or a link in the chat: it lands in your message the way it would in the game chat. When you send, each link becomes `[Name]` in the text and its tooltip (an item's stats, a spell's description) is attached below, so the agent sees what you see when hovering it. This works from the game chat box too (`/ai is this an upgrade? [Fine Longsword]`). Without a box focused, shift-click keeps its normal meaning.

### The agent sees your screen

On the screenshot transport (`capture.mode: "screenshot"`) the game already takes a screenshot of the whole screen for every message you send; the strip is only its top-left corner. `/wow-ai vision on` tells the bridge to keep the rest: it crops the strip's rows off, scales the frame down (1280 pixels wide by default, 1-2 MB as PNG) and attaches it to the agent's message as an image, with a line in the system prompt saying an image of your screen is attached and what it is (only when one is). So "what is this item, should I equip it?", "why does this boss keep killing me?" or "read me this quest text" are answered from what is actually on your screen, tooltips and open windows included. `/wow-ai look <question>` does it for one message with the setting off. Off by default; the window's footer and `/wow-ai diag` show the state. Claude Code gets the pixels inline (an `image` block in a stream-json user message, no tool call); Codex, Grok and Hermes get the PNG's path in `bridge/tmp`, where it is deleted after the run. With it off nothing changes, and the pixel transport never sees more than the strip.

### Macros, ready to use

Ask for a macro (*"a Charge macro that uses Intercept in combat"*, *"a mouseover heal"*) and the reply comes with a **Create macro: <name>** button under it. A click saves it (an account macro, or a character one if the agent says so) and puts it on your cursor: click an action bar slot to place it. It is also in `/macro` as usual.

- A macro with that name already there? The button says **Update**, and it asks before replacing a different one of yours. `/wow-ai macro undo` brings back what was there (or removes the macro the button created).
- Macros that run code (`/run`, `/script`, `/click`) are marked on the button and ask before being saved.
- Nothing is saved in combat, and the addon never runs a macro: only your own click on the bar does.

The agent writes each macro in a ```` ```wowmacro <Name> ```` block (optional `icon=` and `scope=character` after the name); the bridge checks the game's limits (name up to 16 characters, text up to 255 bytes) and keeps a readable copy in the reply. The buttons live with the message in the addon's saved data, so they don't come back after the beta wipes it (the macro text does).

### Map, routes and gathering nodes

The agent can draw on your world map. Ask *"route me through copper and tin around here"*, *"plan the quests I can do in Westfall"* or *"where is the nearest mining trainer?"*, and the answer arrives with:

- **Layers on the world map:** numbered pins joined by lines for routes, and pins for quest givers, objectives, turn-ins, trainers, dungeon entrances or any mark. They show on the zone map and on the continent map; hover a pin for its label, click it to navigate there.
- **A navigator:** a small frame with an arrow and the distance in yards to the current stop. It starts as soon as a route on your continent arrives (unless you are already following one), advances when you get within 12 yards, and loops on farming circuits. Drag it to move it; right-click skips a stop.
- **Herb and ore spawns:** with an optional `WoWAI_Nodes` data addon installed, every gathering spawn point of the zone you are looking at, filtered to what your skill can gather.

The system prompt tells every agent how to hand marks to the bridge: append commands to the file named in `WOW_AI_MAP_FILE` (set for every run), or end the reply with a small ```` ```wowmap ```` block. The bridge validates the marks, keeps them in `state.json` and ships them to the game, so they survive a UI reload and the beta's saved-data wipes. Where the agent gets its coordinates from is up to the folder the chat works in: [docs/MAP.md](docs/MAP.md) describes the command format and how to feed it game data.

| Command | What it does |
|---|---|
| `/wow-ai map` | list the layers, navigation and node settings |
| `/wow-ai map ore [on\|off]`, `/wow-ai map herb [on\|off]` | show or hide mining / herbalism spawns on the world map |
| `/wow-ai map filter all\|skill` | every spawn, or only what your skill can gather (default) |
| `/wow-ai map hide <layer>`, `/wow-ai map show <layer>` | hide or show one of the agent's layers |
| `/wow-ai map nav <layer> [n]`, `next`, `prev`, `stop` | drive the navigator |

`/aimap` is a shorter alias. To remove layers for good, ask the agent ("clear the map", "remove the mining route").

### Permissions

The agents run headless, so they can't ask you to approve a tool. Each agent's block in `bridge/config.json` has a `permissionMode`, `acceptEdits` by default: file edits inside the project are auto-approved, `allowedTools` lists the commands it may run (`Bash(git:*)` is any command starting with `git`; the same rule syntax for every agent, translated for Grok), and `deniedTools` the ones it never may. What happens to anything else differs. Claude denies it. Codex has no allowlist: it runs commands in a sandbox that can write the project folder but not reach the network (unless `networkAccess` is on), and explains a blocked command in its reply. Grok's headless mode runs ordinary commands on its own and blocks the dangerous ones (deleting a project file, pushing) unless a rule allows them. With Claude and Grok the reply then grows an **Allow WebSearch, Bash(cargo:*) & retry** button: click it, the rules are added to that agent's list in your config permanently, and the agent resumes where it stopped. The rule is a prefix (`Bash(rm:*)` allows any `rm`), so read the button before clicking. `bypassPermissions` gives any agent full autonomy; you decide. The mapping per agent, as measured against the real CLIs, is in [docs/AGENTS.md](docs/AGENTS.md).

## Configuration (`bridge/config.json`)

The keys you are most likely to touch. Every key, flag and environment variable is in [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

| Key | Meaning |
|---|---|
| `defaultCwd` | folder for chats that haven't been given one with `/wow-ai cd` |
| `agent` | the agent for chats that haven't picked one with `/wow-ai agent` (`claude`, `codex`, `grok`, `agy` or `hermes`) |
| `agents.<id>.permissionMode`, `.allowedTools`, `.deniedTools`, `.model` | that agent's permissions, allowlist, denylist and model; `.path` where its executable is if the bridge can't find it, `.extraArgs` anything else to pass it |
| `agents.codex.networkAccess` | let Codex's sandbox reach the network (default `false`) |
| `maxParallel` | how many chats may run an agent at once (default 3) |
| `gameContext` | `false` never tells the agent about your character, whatever the addon sends (default `true`) |
| `primerFile` | the addon/macro primer appended with the context (default `docs/WOW-ADDON-PRIMER.md`; `""` = none) |
| `capture.processName` | the game exe without `.exe` (`WowB` for Forever); set by `setup.js` |
| `capture.mode` | `pixel` (screen capture, default) or `screenshot` (the addon calls `Screenshot()`; the bridge reads the file from the client's `Screenshots` folder) |
| `vision.maxWidth`, `vision.keep` | screenshot mode: how wide the picture of your screen is scaled to before it goes to the agent (default 1280), and how many may wait in `bridge/tmp` at once (default 6) |
| `capture.keepComposited`, `capture.windowName` | Linux: keep the compositor drawing the game window (if the probe sees black), or find the window by title |
| `slots`, `actMax`, `presenceMax` | pool sizes; must match the constants at the top of `WoWAI.lua` if you change them |
| `timeoutMs` | kill a run that takes longer than this (default 30 min) |

## Troubleshooting

- **Connect says "No answer from the bridge" / light stays red** — is the bridge running (`wow-ai service status`, or the terminal it runs in)? Is the game window on screen and not minimized? Exclusive fullscreen blocks capture. `bridge.log` shows `strip #N` when a message is decoded and `strip seen but rejected: ...` when one is misread.
- **Linux: `bridge.log` keeps saying `waiting for WowB window`** — the game isn't running or its window has another name: set `capture.processName` to the exe name, or `capture.windowName` to part of the window title. On Wayland the capture can't see other windows; use an X11 session.
- **Linux: `npm run probe` shows a black or stale picture** — the compositor is letting the game present on its own. Try `"keepComposited": true` under `capture`, then windowed mode, then `nvidia-settings -a AllowFlipping=0` on NVIDIA; `/wow-ai mode reload` works without any capture.
- **No herb/ore pins after `/wow-ai map ore`** — `/wow-ai map` says whether the `WoWAI_Nodes` data addon is installed; pins show on zone maps only, and with `filter skill` only what your skill can gather.
- **The reply says "X is not installed on the bridge PC"** — the bridge's banner shows where it looked for each agent. Install the CLI, or put the full path of its executable in `agents.<id>.path` in `bridge/config.json` and restart the bridge.
- **A reply says the agent is not logged in, or asks for a login** — run the CLI once by hand on the bridge PC (`claude`, `codex`, or `grok login`) and log in; the bridge reuses that.
- **Reply never appears but `bridge.log` says `done`** — `/wow-ai slots`; if the pool is empty, `/wow-ai reload` frees it and picks the reply up via the fallback path.
- **"Reply slots not installed"** — `node bridge/install-slots.js`, then restart WoW.
- **Chats vanished after a reload** — the beta client sometimes wipes addon saved data. The bridge keeps `transcripts.json` and sends your chats back automatically on the next message.
- **`/wow-ai diag` says the sound channel is unusable** — the cheap readiness checks and heartbeat are off; everything still works through slot polls, just with coarser progress. If it says a valid file reports as unplayable, WoW hasn't been restarted since the files were created.

## Documentation

- [docs/INSTALL.md](docs/INSTALL.md): every install route (one-line installer, Homebrew, git), the background service, updating and uninstalling
- [docs/INSTALL-WINDOWS.md](docs/INSTALL-WINDOWS.md): Windows notes and troubleshooting
- [docs/AGENTS.md](docs/AGENTS.md): each agent's install, how the bridge drives it, permissions per agent, limits, and how to add another
- [docs/CONFIGURATION.md](docs/CONFIGURATION.md): every config key, command-line flag and environment variable
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how the pixel strip, slot pool and signal files work, and why
- [docs/INSTALL-LINUX.md](docs/INSTALL-LINUX.md): Linux + Wine notes, systemd, and how to check the screen capture
- [docs/MAP.md](docs/MAP.md): map layers, the navigator and herb/ore nodes
- [CONTRIBUTING.md](CONTRIBUTING.md): repo layout, running the tests, conventions
- [CHANGELOG.md](CHANGELOG.md): release notes

## Development

```
npm install
npm test          # everything except the live test; CI runs it on Windows (.github/workflows/test.yml), and it runs on Linux and macOS too
npm run test:live # runs the bridge in a sandbox with a real agent call (add -- --agent codex or grok)
```

Layout: `addon/WoWAI` is the addon (`WoWAI.lua` the chat and transport, `Map.lua` the map layers, navigator and nodes), `bridge/` the companion (`bridge.js` does I/O and processes, `protocol.js` is the pure part, `agents.js` knows how to launch and read each agent, `capture.ps1` / `capture_x11.py` the screen capture per platform), `docs/` the design and reference, `tests/` the checks (`map_test.js` and `map_addon_test.js` cover the map protocol and `Map.lua` in a Lua VM). After editing the addon, copy it into the game folder (`node setup.js` does that too) and `/reload`. What each test covers, and the conventions for changes, are in [CONTRIBUTING.md](CONTRIBUTING.md).

## Credits

- [0xInuarashi's wow-forever-codex](https://github.com/0xinuarashi/wow-forever-codex) measured the client's file-loading rules on a live Forever build (files must exist at launch; a not-yet-loaded file is read fresh on first use) and pioneered the pixel-out channel for Codex, with a font-metrics return channel. This project uses the same rules with load-on-demand addons instead of fonts.
- [Gethe/wow-ui-source](https://github.com/Gethe/wow-ui-source) — Blizzard's UI code, `forever` branch, used to verify every API this addon calls.
- [Questie](https://github.com/Questie/Questie) and [QuestieDB](https://github.com/Questie/QuestieDB) documented how Forever's maps work (Classic uiMapIDs, re-projected zones), which the map layer relies on.

## License

MIT — see [LICENSE](LICENSE).
