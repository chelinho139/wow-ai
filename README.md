# claude-wow

<p align="center">
  <img src="docs/screenshot.jpg" alt="The Claude WoW chat window open in Goldshire, with a message on its way to a coding agent" width="900">
</p>

Chat with your local coding agents from inside **World of Warcraft: Forever**: [Claude Code](https://claude.com/claude-code), [OpenAI Codex](https://developers.openai.com/codex), [xAI's Grok Build](https://docs.x.ai/build/overview), Google's Antigravity CLI and Hermes Agent. Send a task, go back to questing, get pinged in-game when the answer lands. No alt-tabbing, no `/reload` per message.

- Multiple chats, each its own persistent agent session (like separate terminals), running in parallel. Each chat picks its agent and its folder
- Live progress while the agent works: action count, elapsed time, the files it's editing and commands it's running
- Replies echoed into the game chat; `/r` replies to the agent when it was the last to message you
- The agent knows your character, level, zone, talents, professions and quest log (optional), and you can shift-click items, spells and quests into a message
- The agent can draw on your world map: numbered routes, quest stops and marks, with a navigator arrow that walks you from stop to stop
- Herb and ore spawns on the world map, filtered by your gathering skill (`/claude config map ore`, `/claude config map herb`)
- Ready-made macros: ask for one and the reply carries a **Create macro** button that saves it and puts it on your cursor, ready to drop on an action bar (`/claude config macro undo` reverts it)
- Live UI widgets: ask for *"a DPS meter"* or *"a timer bar for my buffs"* and the agent's Lua loads in the game at once, no `/reload`; display-only, listed and removed with `/claude config ui`
- **Need / Greed / Pass** on permissions: when Claude or Grok needs a command outside your allowlist, it drops as an epic item in a group-loot roll frame
- A status light for the bridge, automatic retries, and recovery of your chats (and map layers) if the beta client wipes addon data
- Runs on Windows, on Linux with the game under Wine, and on macOS with a native client

Nothing here injects code, reads game memory, or generates input. The addon uses documented addon APIs only; the companion reads your screen and writes ordinary files.

## How it works, in one paragraph

WoW addons are sandboxed: no network, no file reads at runtime. Two doors remain. **Out:** the addon draws your message as a strip of colored 4-pixel squares in the top-left corner of the screen and calls `Screenshot()`; the bridge decodes the file the game writes to its `Screenshots` folder, deletes it, and runs the chat's agent headless in the chat's folder. (The deprecated `pixel` mode screen-captured that corner four times a second instead; see [Transports](#transports).) **In:** a load-on-demand addon reads its files from disk at the moment it is loaded, so the bridge writes the reply into a pool of 200 pre-made slot addons and the game loads a fresh one from a timer. Cheap "is it ready yet" checks ride on a third trick: an empty `.wav` won't play and a valid one will. Map layers travel the same way: the agent's tools hand them to the bridge, which keeps them versioned and ships them inside the slot files. Details in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/MAP.md](docs/MAP.md).

## What a chat is

What a chat *does* with your message depends on how you started it; the window, the whisper tabs, the game-chat echo, the map, macros, your character context and the transcripts are the same either way ([docs/PLATFORM.md](docs/PLATFORM.md) has the design).

| Chat | What it is |
|---|---|
| no folder (the default) | General in-game AI chat: game questions, quest research, routes on the map, macros. No project: the agent runs in a scratch folder of its own and is told it is your in-game assistant, not a coding session. |
| a folder (`/claude cd realms`) | An agent session in that folder, like `claude` in a terminal there: the agent edits and runs things in the project. |
| a running terminal session (`/claude -r <name>`) | A Claude Code session you already have open in a terminal: the chat talks straight into it through a Claude Code channel, its answers come back here, and its permission prompts come up as a Need/Greed roll. Start the session with `claude --dangerously-load-development-channels server:claude-wow` from this repo; see [docs/LIVE-SESSION.md](docs/LIVE-SESSION.md). |

A message that starts with `@ask ` or `@claude ` (in the window or a whisper tab) goes to general chat or to the coding session whatever the chat is. Both run whichever agent the chat picked. `/claude config plugin <name>` pins a chat to one of these by hand (`ask`, `claude-code`, `live`); you should not need it.

## Agents

The bridge drives whichever of these you have installed; each chat can use a different one.

| Agent | CLI the bridge runs | Permissions | Allow & retry |
|---|---|---|---|
| **Claude Code** (`claude`) | `claude -p --output-format stream-json`, resumed with `--resume` | `permissionMode` + `allowedTools` rules | yes |
| **Codex** (`codex`) | `codex exec --json`, resumed with `codex exec resume` | a sandbox chosen from `permissionMode` (read-only, workspace-write, or none) | no: a command the sandbox declined is reported in the reply |
| **Grok Build** (`grok`) | `grok --prompt-file … --output-format streaming-json`, resumed with `-r` | `permissionMode` + the same `allowedTools` rules, translated to Grok's globs | yes, when Grok reports a refused tool |
| **Antigravity** (`agy`) | `agy -p=<prompt> --output-format stream-json`, resumed with `--conversation` | Antigravity permission switches | no |
| **Hermes** (`hermes`) | `hermes chat --query-file -`, resumed with `--resume` | default only; the bridge never uses `--yolo` | no |

`agent` in `~/.claude-wow/config.json` is the default (`claude`). `/claude -c --agent codex` switches the current chat, or right-click a chat in the left panel and pick **Agent...**; the reply bubbles and the game-chat echo are labelled with whoever answered. A session belongs to the agent that made it, so a chat that changes agent starts a fresh session there (its transcript stays). Install notes, the exact command lines, what each permission mode means per agent, and known limits are in [docs/AGENTS.md](docs/AGENTS.md).

## Requirements

- Windows (NTFS), or Linux with the game under Wine (see [docs/INSTALL-LINUX.md](docs/INSTALL-LINUX.md)), or macOS with a native client. python3 only if you use the deprecated pixel-capture fallback off Windows; the default screenshot transport needs nothing
- World of Warcraft: Forever (tested on 1.60.1.69913 and 1.60.1.69977, TOC 16001), **windowed or borderless** (exclusive fullscreen blocks screen capture)
- Nothing else for the installer and the Homebrew route: the bridge ships as one self-contained binary (macOS arm64 and x64, Linux x64, Windows x64). From a checkout it runs on [Node.js](https://nodejs.org) 22.2 or newer, or on [Bun](https://bun.sh)
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
curl -fsSL https://raw.githubusercontent.com/rdimascio/claude-wow/main/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/rdimascio/claude-wow/main/install.ps1 | iex
```

The installer downloads the `claude-wow` binary for your machine into `~/.local/bin` (Windows: `%LocalAppData%\Programs\claude-wow\bin`, on your user PATH), checks it against the release's checksums, runs the game-side setup (addon into `Interface/AddOns/ClaudeWoW`, `~/.claude-wow/config.json`, the slot pool: ≈15,000 tiny files, which is normal since the client only discovers addon files at launch), and offers to run the bridge in the background from now on. It never uses sudo, is safe to re-run (that is how you update), and stops with a message saying what to do if anything is missing. Pass `--wow "<client folder>"` if setup cannot find the client and `--project <folder>` for the default folder the agents work in (after `sh -s --`; on Windows through `$env:CLAUDE_WOW_WOW` and `$env:CLAUDE_WOW_PROJECT`). Where there is no binary for your machine (another platform, or no release yet), or with `--from-source` (`$env:CLAUDE_WOW_SOURCE = "1"`), it installs the source into `~/.claude-wow/app` (Windows: `%LocalAppData%\Programs\claude-wow`) and runs it with Node.js 22.2+, which it then checks for.

Then **fully quit and relaunch WoW**, enable *Claude WoW* on the AddOns screen, and:

```
claude-wow                    # the bridge in this terminal; Ctrl+C stops it, it restarts itself after a crash
claude-wow service install    # or: in the background, now and at every login
claude-wow service status     # running? pid, uptime, last log lines   (also: logs, stop, start, restart, uninstall)
```

In game: `/claude hello`. The bridge's banner lists every agent with where its executable was found, or what to install.

Other routes: `brew tap rdimascio/claude-wow && brew install claude-wow` (the binary; `--HEAD` for the checkout with Homebrew's node) then `claude-wow setup` (Homebrew cannot install the addon; see [docs/INSTALL.md](docs/INSTALL.md#route-2-homebrew-macos)), or `git clone` and `node setup.js` then `npm start` by hand (Node 22.2+ or Bun). Platform notes: [docs/INSTALL-WINDOWS.md](docs/INSTALL-WINDOWS.md), [docs/INSTALL-LINUX.md](docs/INSTALL-LINUX.md), and the macOS section below.

### macOS (native client)

Setup looks for the client under `/Applications/World of Warcraft` and `~/Applications/World of Warcraft` (pass `--wow "<client folder>"` otherwise). The default screenshot transport is all a Mac needs: the addon takes a screenshot with the strip up and the bridge reads the file from the client's `Screenshots` folder; no screen capture, no Screen Recording or Automation permission, no python, works on Retina displays, and the right configuration for the background service (a background process cannot ask for a permission). The deprecated `pixel` transport (`"mode": "pixel"` under `capture` in `~/.claude-wow/config.json`) captures the game window with `bridge/capture_mac.py` (python3) and needs **Automation** (System Events) and **Screen & System Audio Recording** for the terminal the bridge runs in; macOS does not always prompt, so on that transport `setup.js` checks both and names whichever is missing (`npm run check:mac` re-runs that check; `npm run probe:mac` saves what the capture sees to `bridge/probe.png`). Grant a permission, then quit and reopen the terminal. The pixel decoder reads one image pixel per addon pixel, so on a Retina display it never decodes. See [Transports](#transports).

### Renamed from wow-ai

This project was called wow-ai (and wow-claude before that): the addon was `WoWAI`, the command `wow-ai`, the slash command `/wow-ai` with `/ai`, `/ask`, `/wowai` and `/wow-claude` as aliases. It is claude-wow now, and the old names are gone rather than aliased: the addon is `ClaudeWoW`, the command `claude-wow`, the slash command `/claude`, the service `io.claudewow.bridge`, the environment variables `CLAUDE_WOW_*`. Nothing of yours is lost:

- **Chats.** Run the installer again, or `git pull` and `node setup.js`. Setup copies your chats and settings from the old addon's saved data (`WoWAI.lua`, or `WoWClaude.lua`) to `ClaudeWoW.lua` with the globals renamed, removes the old addon and its 200 slot folders so two addons do not fight over `/r` and the shift-click hook, and rewrites the paths in `config.json`. The old saved file is left where it was. Then **fully quit and relaunch WoW** and enable *Claude WoW* on the AddOns screen (the old *WoW AI* entry is gone).
- **Agent sessions.** The bridge keys them by chat id in `state.json`, so they follow the chats. Config, state and transcripts move from `bridge/` in the checkout to `~/.claude-wow` (`CLAUDE_WOW_HOME`, see [docs/CONFIGURATION.md](docs/CONFIGURATION.md#where-the-bridge-keeps-its-files)); setup and the installer copy them there once and leave the originals.
- **The service and the command.** `claude-wow service install` (and `uninstall`) remove the old `io.wowai.bridge` / `wow-ai-bridge` / *WoW AI bridge.vbs* service first, so two bridges do not start at login. The installer removes the old `wow-ai` shim; `npm unlink -g wow-ai` if you had linked it by hand. A hotkey set with `/wow-ai bind` needs `/claude config bind <key>` again, and macros that typed `/ai ...` need `/claude ...`.

### `claude-wow`: start it from the project folder

Like the agent CLIs themselves, the bridge works in the folder you start it from:

```
cd ~/code/realms
claude-wow
```

Every chat that hasn't picked its own folder now works in `realms`, and the panel's cwd line shows it. `claude-wow --project <dir>` names the folder explicitly; the background service and `npm start` inside the repo fall back to `defaultCwd` in the config (`claude-wow setup --project <dir>` sets it). Only one bridge can run at a time (two would fight over the screen and the slot files), so this sets the default folder rather than giving you one bridge per project.

## Use

In game: `/claude` opens the window on a new chat (`/claude -c` on the current one). Until the bridge has answered, a **Connect** button sits where Send would be: start the bridge, click it, and the light turns green (a message typed before that stays in the box). Then click the input box, type, Enter. The reply arrives with the whisper sound; the window's light shows the bridge state (green/yellow/red, hover for details), and **Reconnect** shows up if the bridge goes quiet.

Right-clicking a chat in the left panel opens a small menu with **Rename...**, **Folder...**, **Agent...** and **Plugin...** (right-click again to close it); the trash can on the row deletes the chat after an OK/Cancel confirm. **Folder...** sets the folder this chat's agent works in (same as `/claude cd` below), **Agent...** which agent answers it (same as `/claude -c --agent`), **Plugin...** the advanced binding (same as `/claude config plugin`); each chat keeps its own, so you can have a general chat next to chats on different projects, with different agents, side by side. The window's footer shows them.

`/claude` works like the `claude` command in a terminal: a message starts a new chat, `-c` continues the current one, `-r` resumes a session, and the same flags set the model, the effort and the rest for that chat.

| In game | Like | What it does |
|---|---|---|
| `/claude <text>` | `claude "<text>"` | start a new chat and send `<text>` there, straight from the normal chat box. At the chat limit (16) the game chat says so and the text waits in the window's input box. Bare `/claude` opens an empty new chat |
| `/claude -c <text>` | `claude -c` | continue the current chat (`--continue`); alone it opens the window on it |
| `/claude -r <id\|name\|n> [text]` | `claude -r` | resume a session (`--resume`). A Claude Code session that is running in a terminal with the claude-wow channel gets the chat live; any other session (one of your chats, or a Claude Code session from its history) is resumed headless with `claude -p --resume <id>` in its own folder. Names match chat and session names, ids match by prefix; a prefix two sessions share lists both |
| `/claude -r` | `/resume` | list the running and recent sessions (id, name, folder, age) in the window and the game chat; click one, or `/claude -r <n>` |
| `/claude -n <name> [text]` | `claude -n` | name the new chat; with `-c` it renames the current one |
| `/claude --model <model> [text]` | `claude --model` | the model for the chat (`opus`, `sonnet`, a full model name) |
| `/claude --effort <level> [text]` | `claude --effort` | `low`, `medium`, `high`, `xhigh` or `max` |
| `/claude --permission-mode <mode> [text]` | `claude --permission-mode` | `acceptEdits`, `auto`, `plan`, `manual`, `dontAsk` or `bypassPermissions` |
| `/claude --add-dir <path> [text]` | `claude --add-dir` | one more folder the agent may use; repeat it for more |
| `/claude --agent <name> [text]` | | which CLI runs the chat: `claude`, `codex`, `grok`, `agy` or `hermes`. A chat that changes agent starts a fresh session with it |
| `/claude config [key] [value]` | `claude config` | the addon's settings (below); alone it lists them with their values |

Flags come before the text and combine: `/claude --model opus fix the build` starts a new chat on Opus with that message, and `/claude -c --effort high` changes the current chat. `--flag=value` and `"quoted values"` work, a value of `-` (or `default`) clears a setting, and a flag with no value shows it. The settings stay with the chat and go to the agent on every message; each agent gets them in its own spelling (Codex `-m`, `-c model_reasoning_effort=`, `--add-dir`; Grok `-m`), and when an agent has no such option the reply says so and the run goes on without it. A message that starts with something that only looks like a flag (`/claude --verbose output is too long, why?`) is a message.

The client's own commands, with the same rule: a command word followed by something it does not take is a message for a new chat, so `/claude delete the unused imports` is a message.

| Command | What it does |
|---|---|
| `/claude cd <folder>` | folder this chat's agent works in, which makes it a coding session there (**Folder...** after right-clicking the chat opens the same thing as a dialog). Relative to the bridge's folder (`/claude cd realms`, `/claude cd ../other`), `~` works, a full path too; `/claude cd` alone goes back to general chat in the bridge's default. A chat that changes folder starts a fresh session there |
| `/claude look <question>` | one message to the current chat with a picture of your screen, whatever the vision setting |
| `/claude rename [name]`, `/claude delete`, `/claude clear` | manage the current chat |
| `/claude reset` | wipe this chat's agent memory, keep the transcript |
| `/claude cancel` | stop waiting on this chat's reply |
| `/claude resend` | show the strip again if the bridge missed it |
| `/claude reload` | reload the UI now (also frees the slot pool) |
| `/claude diag`, `/claude slots` | transport diagnostics |
| `/claude hide`, `/claude mini` | hide the window, or collapse it to the small bar (the minimize button or Esc does the same; click the bar to expand) |
| `/claude help` | the full list |
| `/r <text>` | replies to the agent when it was the last to message you; otherwise the normal whisper reply |

Settings, with `/claude config <key> [value]`:

| Key | What it does |
|---|---|
| `whisper on\|off` | each chat as a native whisper tab in the chat dock (off by default): replies arrive there as whispers and flash the tab, what you type there goes to the agent, never to the server, and slash commands typed there (`/claude ...`, `/cast ...`) run as usual, so `/claude -c ...` in a tab continues that tab's chat. The window stays the full record |
| `context [on\|off]` | show what the agent is told about your character and location, or turn it on/off. Bare, it first prints this chat's context growth: the tokens your next message re-reads, the turns in the session, how long it has run and what it comes to at API list prices |
| `context <n>` | warn once, with a **New chat** button, when a chat's context passes `n` tokens (`100k` by default, `0` = never). Every message resumes the chat's agent session, so its context only grows and each reply costs more than the last; the window's footer shows it like Claude Code's own status line (`11m 58s · ↓ 106.9k tokens · ≈$2.41 API`: time since the session started, the context, the session at API list prices, a comparison and not a bill), and `/claude diag` lists it per chat |
| `vision [on\|off]` | send a picture of your screen with each message, so the agent sees what you see: "what is this item?", "why is this boss killing me?", "read this quest" (off by default; needs the screenshot transport) |
| `roast [on\|off]` | when you die, the agent gets a recap of what killed you and writes a short roast in the **Death roasts** chat (off by default; at most one every 2 minutes). See [Death roast](#death-roast) |
| `achievements [on\|off\|test]` | list the achievements your agents earned; `on`/`off` turns the toasts on or off, `test` shows a sample (see [Achievement toasts](#achievement-toasts)) |
| `echo summary\|full\|short\|off\|<chars>` | how much of each reply to print into the game chat. `summary` (the default) prints only the agent's closing TL;DR lines, the full reply is in the window behind `[open]`; `full` prints up to 4000 chars, `short` one preview line |
| `voice ...`, `map ...`, `ui ...`, `macro undo`, `roll on\|off` | see [Voice lines](#voice-lines), [Map](#map-routes-and-gathering-nodes), [Live UI widgets](#live-ui-widgets), [Macros](#macros-ready-to-use) and [Need, Greed or Pass](#need-greed-or-pass) |
| `longchat on` | let the game chat box take 4000 characters, for long `/claude` messages |
| `bind <key>` | hotkey: checks for a reply while waiting, otherwise toggles the window |
| `mode reload` | fallback transport that costs a `/reload` per step, if pixels or slots can't work |
| `signal on\|off`, `auto on\|off\|<seconds>` | the sound-file readiness check, and the reload-mode auto refresh |
| `plugin <name>\|default` | advanced: pin the chat to `ask`, `claude-code` or `live` by hand |

Click any message, or `/claude copy` for the last reply, to open it in a selectable box for Ctrl+C.

### Short in the chat, full in the window

Every run tells the agent that only a short summary of its reply is printed in the game chat, and asks it to end each reply with a `TL;DR:` block of one or two lines. The bridge splits that block off and the addon prints just those lines under `[Claude · chat]`, with the `[open]` link to the whole reply in the window (the window keeps the full text, TL;DR included). When an agent forgets the block, the first two lines of the reply are printed instead, with a hint to open the rest. `/claude config echo full` goes back to printing the whole reply.

### The agent knows where you are

The addon tells the agent which game and client you are on, your character (name, realm, level, race, class, faction, guild), where you are (zone, subzone and the map coordinates the minimap shows), your money, talents, professions with their skill, and your quest log (quest ids, marking the ones ready to turn in). A few lines, sent with the addon's hello and again whenever they change, and put at the top of every message by the bridge as a marked situation block (the rules for reading it, and the addon primer, go in the agent's system prompt, which stays the same for the life of a chat so it is cached and, with Claude Code, recorded once), so you can ask "what should I be doing at my level around here?" or "write me a macro for my class" without explaining yourself first. It is only a hint: for a chat about an unrelated project it changes nothing. `/claude config context` shows exactly what is sent; `/claude config context off` stops sending it (the bridge forgets it too), and `"gameContext": false` in `~/.claude-wow/config.json` turns it off for good.

Along with it, every run gets [docs/WOW-ADDON-PRIMER.md](docs/WOW-ADDON-PRIMER.md): a short reference on writing addons and macros for this client (TOC layout, sandbox rules, common frames and events, where to verify an API), so "write me an addon that..." works from any folder, not just this repo. Edit the file to suit your setup; the bridge re-reads it on every run. `"primerFile": ""` in the config drops it, and `/claude config context off` turns it off together with the character context.

### Link items, spells and quests

Click the input box, then **shift-click** an item in your bags, a spell in the spellbook, a quest in the log, or a link in the chat: it lands in your message the way it would in the game chat. When you send, each link becomes `[Name]` in the text and its tooltip (an item's stats, a spell's description) is attached below, so the agent sees what you see when hovering it. This works from the game chat box too (`/claude is this an upgrade? [Fine Longsword]`). Without a box focused, shift-click keeps its normal meaning.

### The agent sees your screen

On the screenshot transport (`capture.mode: "screenshot"`) the game already takes a screenshot of the whole screen for every message you send; the strip is only its top-left corner. `/claude config vision on` tells the bridge to keep the rest: it crops the strip's rows off, scales the frame down (1280 pixels wide by default, 1-2 MB as PNG) and attaches it to the agent's message as an image, with a paragraph at the top of the message saying an image of your screen is attached and what it is (only when one is). So "what is this item, should I equip it?", "why does this boss keep killing me?" or "read me this quest text" are answered from what is actually on your screen, tooltips and open windows included. `/claude look <question>` does it for one message with the setting off. Off by default; the window's footer and `/claude diag` show the state. Claude Code gets the pixels inline (an `image` block in a stream-json user message, no tool call); Codex, Grok and Hermes get the PNG's path in `~/.claude-wow/tmp`, where it is deleted after the run. With it off nothing changes, and the pixel transport never sees more than the strip.

### Death roast

`/claude config roast on` (off by default) turns your deaths into content. When you die, the addon takes the last 10 seconds of the combat log that hit you (who, with what, how much, crits, overkill, the killing blow), adds your level, zone and the attackers' levels when it can see them, and sends that recap to the agent in a **Death roasts** chat of its own. The reply is a two or three sentence roast, affectionate and aimed at the play, never the person, and it lands in the window and the game chat like any other reply. With vision on, the agent also sees your screen at the moment of death.

- At most one roast every 2 minutes, so a wipe does not spam the agent. A death while the last roast is still being written, or while the bridge is not connected, is skipped.
- The recap stays under 900 bytes, so it fits the strip with the game context next to it.
- The chat is bound to the bridge's `roast` plugin and runs in the same scratch folder as `ask` (`plugins.roast.cwd` to change it). Type in that chat to talk back.
- `/claude config roast` shows the state, the cooldown, and why the last death was not roasted.

### Transports

How a message leaves the game. The bridge listens on one of two, named in `capture.mode` in `~/.claude-wow/config.json` and told to the addon in every slot file:

- **`screenshot`, the default.** The addon draws the strip, waits two frames and calls `Screenshot()`; the bridge decodes the PNG the client writes to its `Screenshots` folder and deletes it. No screen capture, no Screen Recording or Automation permission, no window discovery, no python; works on Retina displays, under Wayland, and from a background service. Verified end to end on macOS.
- **`pixel`, deprecated.** `capture.ps1` (Windows), `capture_mac.py` (macOS) or `capture_x11.py` (Linux) screen-captures the strip four times a second. It exists only until `Screenshot()` is confirmed on Windows and on Linux under Wine, and will be removed then. It needs python3 off Windows, the two permissions on macOS, and an X11 session on Linux.

A new install starts on `screenshot`; an existing `config.json` with an explicit `mode` keeps it. **If the screenshot transport cannot work on your client, the bridge falls back on its own:** when the addon reports that the client has no `Screenshot()` function, or that every shot failed (`SCREENSHOT_FAILED`), the bridge switches to the pixel capture, says so in its log and terminal (`TRANSPORT FALLBACK: ...`), remembers it in `state.json` so the next start goes straight to pixels, and names the reason in its slot files, where `/claude diag` in game shows it as `transport: pixel (bridge: pixel transport, fallen back to since ... because ...)`. The addon says once in the game chat that the report is on its way; the first time, that report reaches the bridge through the reload fallback (a couple of minutes), because a bridge waiting for screenshots is not watching the screen. To settle it for good, set `capture.mode` to `"pixel"` (no more note) or `"screenshot"` (try again; an explicit value always wins over the memory). Nobody is left without a transport.

### Achievement toasts

Dev milestones pop an achievement-style toast in game: a gold banner with an icon, a title, points and the achievement sound. The bridge watches the shell commands the agent runs and their results (Claude Code and Codex), so every award is a fact, not a guess:

| Achievement | When |
|---|---|
| Hello, World / Questing Buddy / Loremaster of the Repo | 1, 10 and 100 finished tasks |
| Back From the Dead | the tests pass after failing (npm, yarn, pnpm, bun, jest, vitest, pytest, go, cargo, `node --test` and more); every time it happens |
| Signed and Sealed / Commit Streak / Centurion | 1, 10 and 100 git commits by the agent |
| Ship It / Frequent Flyer | 1 and 10 pushes |
| Merged on a Friday | a commit or push on a Friday |
| Night Owl | a task finished after midnight (before 5 a.m.) |
| It Works On My Machine | a push in a run that never ran the tests |
| Rubber Duck | 50 messages in one chat |
| Leeroy Jenkins | the agent ran a command with `--force` (or `git push -f`) |

Each one-time award is given once and kept in the bridge's `state.json`, so it survives restarts and the beta's saved-data wipes. `/claude config achievements` lists what you earned; `/claude config achievements off` (or `toasts off`) keeps them quiet; `/claude config achievements test` shows a sample toast. `"achievements": false` in `~/.claude-wow/config.json` turns the detection off. The banner uses client textures and plays the sound by its FileDataID; no Blizzard asset ships with the addon.

### Macros, ready to use

Ask for a macro (*"a Charge macro that uses Intercept in combat"*, *"a mouseover heal"*) and the reply comes with a **Create macro: <name>** button under it. A click saves it (an account macro, or a character one if the agent says so) and puts it on your cursor: click an action bar slot to place it. It is also in `/macro` as usual.

- A macro with that name already there? The button says **Update**, and it asks before replacing a different one of yours. `/claude config macro undo` brings back what was there (or removes the macro the button created).
- Macros that run code (`/run`, `/script`, `/click`) are marked on the button and ask before being saved.
- Nothing is saved in combat, and the addon never runs a macro: only your own click on the bar does.

The agent writes each macro in a ```` ```wowmacro <Name> ```` block (optional `icon=` and `scope=character` after the name); the bridge checks the game's limits (name up to 16 characters, text up to 255 bytes) and keeps a readable copy in the reply. The buttons live with the message in the addon's saved data, so they don't come back after the beta wipes it (the macro text does).

### Map, routes and gathering nodes

The agent can draw on your world map. Ask *"route me through copper and tin around here"*, *"plan the quests I can do in Westfall"* or *"where is the nearest mining trainer?"*, and the answer arrives with:

- **Layers on the world map:** numbered pins joined by lines for routes, and pins for quest givers, objectives, turn-ins, trainers, dungeon entrances or any mark. They show on the zone map and on the continent map; hover a pin for its label, click it to navigate there.
- **A navigator:** a small frame with an arrow and the distance in yards to the current stop. It starts as soon as a route on your continent arrives (unless you are already following one), advances when you get within 12 yards, and loops on farming circuits. Drag it to move it; right-click skips a stop.
- **Herb and ore spawns:** with an optional `ClaudeWoW_Nodes` data addon installed, every gathering spawn point of the zone you are looking at, filtered to what your skill can gather.

The system prompt tells every agent how to hand marks to the bridge: append commands to the file named in `CLAUDE_WOW_MAP_FILE` (set for every run), or end the reply with a small ```` ```wowmap ```` block. The bridge validates the marks, keeps them in `state.json` and ships them to the game, so they survive a UI reload and the beta's saved-data wipes. Where the agent gets its coordinates from is up to the folder the chat works in: [docs/MAP.md](docs/MAP.md) describes the command format and how to feed it game data.

| Command | What it does |
|---|---|
| `/claude config map` | list the layers, navigation and node settings |
| `/claude config map ore [on\|off]`, `/claude config map herb [on\|off]` | show or hide mining / herbalism spawns on the world map |
| `/claude config map filter all\|skill` | every spawn, or only what your skill can gather (default) |
| `/claude config map hide <layer>`, `/claude config map show <layer>` | hide or show one of the agent's layers |
| `/claude config map nav <layer> [n]`, `next`, `prev`, `stop` | drive the navigator |

`/aimap` is a shorter alias. To remove layers for good, ask the agent ("clear the map", "remove the mining route").

### Voice lines

Your character talks back while the agent works. By default the lines are your own race and gender's emote and error voices: a *yes* when a message goes out, a *hello* when the bridge picks it up, a *cheer* when the reply lands, the "can't use that item" error voice when a run fails, and the "ability not ready yet" error voice when a reply waits on **Allow & retry**. Two other packs swap in the Warcraft III workers: `peasant` (*"Ready to work"*, *"More work?"*) and `peon` (*"Work work"*, *"Work complete"*). Lines closer than 2 seconds apart are dropped, except that a reply cuts off an ack.

Nothing is shipped: the addon plays sounds the game client already has, by FileDataID. The WoW client has no *"Job's done!"* recording, so the peasant's done line is *"More work?"*.

| Command | What it does |
|---|---|
| `/claude config voice` | show the pack and the line for each event (`sent`, `started`, `done`, `error`, `permission`) |
| `/claude config voice race\|peasant\|peon\|off` | pick the pack; `race` follows the character you are logged in on |
| `/claude config voice set <event> <line>` | override one event: a line of the current pack (`cheer`), of a named pack (`peon:workcomplete`), `off`, or `default` |
| `/claude config voice lines [pack]` | the line names a pack has |
| `/claude config voice test <event\|line>` | play it now |
| `/claude config voice reset` | back to the race pack with no overrides |

The settings are saved with the addon's other settings (`ClaudeWoWDB.voice`).

### Live UI widgets

Ask for a small UI element (*"give me a DPS meter"*, *"a timer bar for my buffs"*) and it shows up in the game a moment later, without `/reload`. The agent writes addon Lua in a ```` ```wowui <name> ```` block (or appends it to the file in `CLAUDE_WOW_UI_FILE`). The bridge refuses anything that names a protected or outward action (casting, targeting, movement, chat, macros, bindings, secure templates), keeps the rest versioned in `state.json` and ships it in the slot files, like map layers. The addon runs each widget in its own sandbox inside a `pcall`; an error stops the widget and shows up in the chat window.

| Command | What it does |
|---|---|
| `/claude config ui` | list the widgets and their state (running, removed, failed) |
| `/claude config ui remove <name>` | stop a widget and keep it off after login, until the agent sends a new version |
| `/claude config ui run <name>` | start a widget again |

Widgets start again at login. The contract, the deny-list and the limits are in [docs/UI-WIDGETS.md](docs/UI-WIDGETS.md).

### Permissions

The agents run headless, so they can't ask you to approve a tool. Each agent's block in `~/.claude-wow/config.json` has a `permissionMode`, `acceptEdits` by default: file edits inside the project are auto-approved, `allowedTools` lists the commands it may run (`Bash(git:*)` is any command starting with `git`; the same rule syntax for every agent, translated for Grok), and `deniedTools` the ones it never may. What happens to anything else differs. Claude denies it. Codex has no allowlist: it runs commands in a sandbox that can write the project folder but not reach the network (unless `networkAccess` is on), and explains a blocked command in its reply. Grok's headless mode runs ordinary commands on its own and blocks the dangerous ones (deleting a project file, pushing) unless a rule allows them. With Claude and Grok the reply then grows an **Allow WebSearch, Bash(cargo:*) & retry** button: click it, the rules are added to that agent's list in your config permanently, and the agent resumes where it stopped. The rule is a prefix (`Bash(rm:*)` allows any `rm`), so read the button before clicking. `bypassPermissions` gives any agent full autonomy; you decide. The mapping per agent, as measured against the real CLIs, is in [docs/AGENTS.md](docs/AGENTS.md).

#### Need, Greed or Pass

By default a denial does not show that button. It pops a frame in the style of the group loot roll instead. The denied command is the item, in epic purple: a scroll for a shell command, a gear for any other tool. Hover the icon to read the exact rules.

| Button | What it does |
|---|---|
| **Need** (dice) | Allow & retry: the rules go into your config for good |
| **Greed** (coin) | Allow for this one retry only: the bridge passes the rules to that run and saves nothing |
| **Pass** (X) | Deny: nothing is sent, the agent is not retried |

The bar under the item counts down 60 seconds. When it runs out, that is a Pass. Each choice plays the game's own loot sounds. `/claude config roll off` brings back the **Allow & retry** button, and `/claude config roll on` returns to the roll frame.

## Configuration (`~/.claude-wow/config.json`)

The keys you are most likely to touch. Every key, flag and environment variable is in [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

| Key | Meaning |
|---|---|
| `defaultCwd` | folder for chats that haven't been given one with `/claude cd` |
| `agent` | the agent for chats that haven't picked one with `/claude -c --agent` (`claude`, `codex`, `grok`, `agy` or `hermes`) |
| `claudeDir`, `claudeSessions` | where Claude Code keeps its sessions for `/claude -r` (default `$CLAUDE_CONFIG_DIR`, else `~/.claude`), and `false` to list only the bridge's own chats and the running sessions |
| `agents.<id>.permissionMode`, `.allowedTools`, `.deniedTools`, `.model` | that agent's permissions, allowlist, denylist and model; `.path` where its executable is if the bridge can't find it, `.extraArgs` anything else to pass it |
| `agents.codex.networkAccess` | let Codex's sandbox reach the network (default `false`) |
| `maxParallel` | how many chats may run an agent at once (default 3) |
| `gameContext` | `false` never tells the agent about your character, whatever the addon sends (default `true`) |
| `primerFile` | the addon/macro primer appended with the context (default `docs/WOW-ADDON-PRIMER.md`; `""` = none) |
| `capture.processName` | the game exe without `.exe` (`WowB` for Forever); set by `setup.js` |
| `capture.mode` | `screenshot` (default: the addon calls `Screenshot()`; the bridge reads the file from the client's `Screenshots` folder) or `pixel` (deprecated screen capture; see [Transports](#transports)) |
| `vision.maxWidth`, `vision.keep` | screenshot mode: how wide the picture of your screen is scaled to before it goes to the agent (default 1280), and how many may wait in `~/.claude-wow/tmp` at once (default 6) |
| `capture.keepComposited`, `capture.windowName` | Linux: keep the compositor drawing the game window (if the probe sees black), or find the window by title |
| `slots`, `actMax`, `presenceMax` | pool sizes; must match the constants at the top of `ClaudeWoW.lua` if you change them |
| `timeoutMs` | kill a run that takes longer than this (default 30 min) |
| `killGraceMs` | how long a run's process group gets after `SIGTERM` before `SIGKILL`, on a timeout or when the bridge stops (default 5 s) |

## Troubleshooting

- **Connect says "No answer from the bridge" / light stays red** — is the bridge running (`claude-wow service status`, or the terminal it runs in)? Is the game window on screen and not minimized? Exclusive fullscreen blocks capture. `bridge.log` shows `strip #N` when a message is decoded and `strip seen but rejected: ...` when one is misread.
- **Linux: `bridge.log` keeps saying `waiting for WowB window`** — the game isn't running or its window has another name: set `capture.processName` to the exe name, or `capture.windowName` to part of the window title. On Wayland the capture can't see other windows; use an X11 session.
- **Linux: `npm run probe` shows a black or stale picture** — the compositor is letting the game present on its own. Try `"keepComposited": true` under `capture`, then windowed mode, then `nvidia-settings -a AllowFlipping=0` on NVIDIA; `/claude config mode reload` works without any capture.
- **No herb/ore pins after `/claude config map ore`** — `/claude config map` says whether the `ClaudeWoW_Nodes` data addon is installed; pins show on zone maps only, and with `filter skill` only what your skill can gather.
- **The reply says "X is not installed on the bridge PC"** — the bridge's banner shows where it looked for each agent. Install the CLI, or put the full path of its executable in `agents.<id>.path` in `~/.claude-wow/config.json` and restart the bridge.
- **A reply says the agent is not logged in, or asks for a login** — run the CLI once by hand on the bridge PC (`claude`, `codex`, or `grok login`) and log in; the bridge reuses that.
- **Reply never appears but `bridge.log` says `done`** — `/claude slots`; if the pool is empty, `/claude reload` frees it and picks the reply up via the fallback path.
- **"Reply slots not installed"** — `node bridge/install-slots.js`, then restart WoW.
- **Chats vanished after a reload** — the beta client sometimes wipes addon saved data. The bridge keeps `transcripts.json` and sends your chats back automatically on the next message.
- **`/claude diag` says the sound channel is unusable** — the cheap readiness checks and heartbeat are off; everything still works through slot polls, just with coarser progress. If it says a valid file reports as unplayable, WoW hasn't been restarted since the files were created.

## Documentation

- [docs/INSTALL.md](docs/INSTALL.md): every install route (one-line installer, Homebrew, git), the background service, updating and uninstalling
- [docs/INSTALL-WINDOWS.md](docs/INSTALL-WINDOWS.md): Windows notes and troubleshooting
- [docs/AGENTS.md](docs/AGENTS.md): each agent's install, how the bridge drives it, permissions per agent, limits, and how to add another
- [docs/CONFIGURATION.md](docs/CONFIGURATION.md): every config key, command-line flag and environment variable
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how the pixel strip, slot pool and signal files work, and why
- [docs/INSTALL-LINUX.md](docs/INSTALL-LINUX.md): Linux + Wine notes, systemd, and how to check the screen capture
- [docs/MAP.md](docs/MAP.md): map layers, the navigator and herb/ore nodes
- [docs/UI-WIDGETS.md](docs/UI-WIDGETS.md): live UI widgets the agent writes, their contract and the display-only checks
- [CONTRIBUTING.md](CONTRIBUTING.md): repo layout, running the tests, conventions
- [CHANGELOG.md](CHANGELOG.md): release notes

## Development

```
npm install
npm test          # everything except the live test; CI runs it on Windows (.github/workflows/test.yml), and it runs on Linux and macOS too
npm run test:live # runs the bridge in a sandbox with a real agent call (add -- --agent codex or grok)
```

Layout: `addon/ClaudeWoW` is the addon (`ClaudeWoW.lua` the chat and transport, `Map.lua` the map layers, navigator and nodes), `bridge/` the companion (`bridge.js` does I/O and processes, `protocol.js` is the pure part, `agents.js` knows how to launch and read each agent, `capture.ps1` / `capture_x11.py` the screen capture per platform), `docs/` the design and reference, `tests/` the checks (`map_test.js` and `map_addon_test.js` cover the map protocol and `Map.lua` in a Lua VM). After editing the addon, copy it into the game folder (`node setup.js` does that too) and `/reload`. What each test covers, and the conventions for changes, are in [CONTRIBUTING.md](CONTRIBUTING.md).

## Credits

- [0xInuarashi's wow-forever-codex](https://github.com/0xinuarashi/wow-forever-codex) measured the client's file-loading rules on a live Forever build (files must exist at launch; a not-yet-loaded file is read fresh on first use) and pioneered the pixel-out channel for Codex, with a font-metrics return channel. This project uses the same rules with load-on-demand addons instead of fonts.
- [Gethe/wow-ui-source](https://github.com/Gethe/wow-ui-source) — Blizzard's UI code, `forever` branch, used to verify every API this addon calls.
- [Questie](https://github.com/Questie/Questie) and [QuestieDB](https://github.com/Questie/QuestieDB) documented how Forever's maps work (Classic uiMapIDs, re-projected zones), which the map layer relies on.

## License

MIT — see [LICENSE](LICENSE).
