# Changelog

All notable changes to this project are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Linux support: the game under Wine on an X11 session. `bridge/capture_x11.py` (python3 + libX11 through ctypes, no packages) does what `capture.ps1` does, finding the game window by its Wine WM_CLASS (`wowb.exe`) and tolerating a few pixels of misalignment. `npm run probe` saves what the capture sees to `bridge/probe.png`. New `capture` keys: `python`, `windowName`, `keepComposited`. `setup.js` looks for the client inside Wine prefixes. See [docs/INSTALL-LINUX.md](docs/INSTALL-LINUX.md).
- Map layers drawn by the agent: numbered route pins joined by lines, quest stops and marks on the world map (zone and continent views), plus a navigator with an arrow and the distance in yards to the next stop that advances as you arrive. The agent's tools append commands to the file in `WOW_AI_MAP_FILE` (set per run), or the agent ends its reply with a ```` ```wowmap ```` block; the system prompt explains both. The bridge validates them, keeps the layers versioned in `state.json` and ships the whole set in the slot files, so nothing is applied twice and a client that lost its saved data gets them back on its next hello. See [docs/MAP.md](docs/MAP.md).
- Herb and ore spawns on the world map from an optional `WoWAI_Nodes` data addon, filtered by your gathering skill. `/wow-ai map` (or `/aimap`) toggles them (`ore`, `herb`, `filter all|skill`) and controls layers and navigation (`show`, `hide`, `nav`, `next`, `prev`, `stop`).
- The game context includes the quest log (quest ids, `*` when ready to turn in); its cap goes from 700 to 900 bytes.
- Ready-made macros: when you ask for a macro, the agent writes it in a ```` ```wowmacro <Name> ```` block and the reply gets a **Create macro** button (or **Update macro** when one with that name exists). A click saves it as an account or character macro and puts it on your cursor to drop on an action bar. It asks before replacing a different macro of yours or saving one that runs code (`/run`, `/script`, `/click`); `/wow-ai macro undo` reverts the last one. The bridge validates the blocks (name up to 16 characters, body up to 255 bytes, 6 per reply), sends them as `macros` on the reply record and keeps a readable copy in the text; blocks after the `TL;DR:` never reach the game-chat summary. Nothing is saved in combat, and the addon never runs a macro.
- Quest state for the agent. The context's quest line lists every quest in the log with each objective's progress (`have/need` or `done`, `*` ready to turn in, `!` failed), trimmed without cutting an entry, plus the quests turned in since login. The character's completed quests (`C_QuestLog.GetAllCompletedQuestIDs`, `GetQuestsCompleted` as fallback) go into saved data per character as base-36 ranges; the bridge reads them whenever the saved-data file changes, keeps them in `state.json`, and before each run writes `bridge/gamestate.json` (character, position, XP, professions, quest log, completed = saved history plus this login) and passes it as `WOW_AI_GAME_STATE`. The system prompt explains both, and the context says when the history isn't on disk yet (a `/reload` writes it).
- The navigator follows quest steps. Map points can carry `q`, `step` (`accept`, `objective`, `turnin`) and `obj`; the navigator moves past every done step when the game reports it (quest accepted, objective line finished or quest complete, quest turned in), several at once with one message, also when a route arrives. Quest stops no longer advance on arrival, a stop the player picks is never overridden, and done steps leave the world map.

### Fixed

- Objective names in the context kept the leading `4/4` this client puts in objective text.
- Professions in the game context were always empty on Forever: the client only has `C_SkillInfo` (one table per skill line), not the classic `GetNumSkillLines`/`GetSkillLineInfo` globals, which stay as fallback. Child lines that repeat their parent are skipped.

## [0.4.0] - 2026-09-24

This release renames the project from **wow-claude** to **WoW AI** (`wow-ai`) and adds two more agents next to Claude Code. Existing installs: `git pull`, `node setup.js` (it migrates the saved data, removes the old addon and updates `config.json`), then quit and relaunch the game. See "Upgrading from wow-claude" in `docs/INSTALL-WINDOWS.md`.

### Added

- **Short replies in the game chat, the full reply in the window.** The system prompt now goes out on every run (game context or not) and asks the agent to end each reply with a `TL;DR:` block of one or two lines; the bridge splits it off (`protocol.splitSummary`) and sends it as `summary` in the slot record next to the full `text`. The new `/wow-ai echo summary` mode, now the default, prints only those lines under `[Claude · chat]` with the `[open]` link to the whole reply; a reply without the block shows its first two lines and a hint to open the rest. Installs that still had the old `full` default saved move to `summary` once; `/wow-ai echo full` brings the old behaviour back.
- **Codex and Grok Build** next to Claude Code. `bridge/agents.js` holds one entry per agent (its command line, how the prompt is handed over, a parser for its output stream), `agent` in `config.json` is the default, and each chat can pick its own with `/wow-ai agent <name>` or the **Agent...** item in the chat's right-click menu (an `agent=` flag on the strip record and in the reload-path outbox). Bubbles, the game-chat echo and the `/r` header name the agent that answered; sessions are kept per agent and folder, so a chat that switches agent starts a fresh session. Per-agent settings live under `agents.<id>` (`permissionMode`, `allowedTools`, `model`, `path`, `extraArgs`; `networkAccess` for Codex). Codex runs `codex exec --json` in a sandbox chosen from `permissionMode`, with the game context at the top of the prompt since it has no system-prompt flag; Grok runs `grok --prompt-file … --output-format streaming-json` with `--permission-mode dontAsk` and the allowlist translated to its globs (headless Grok runs ordinary commands on its own and blocks dangerous ones unless a rule allows them), or `--always-approve`; `deniedTools` adds deny rules for Claude and Grok. Grok's refused tool calls feed the Allow button like Claude's denials; Codex explains a sandbox-blocked command in its own words. Both were tested live against codex 0.156.1 and Grok Build 1.0.41. The banner lists each agent's executable or what to install, `--agent` picks one for `--inject`, and `npm run test:live -- --agent codex` tries one without the game.
- On Windows the bridge unwraps npm's `.cmd` launchers (Codex, or Claude installed with npm) into the script or native binary they run, instead of spawning through `cmd.exe`, and a run that hits `timeoutMs` is killed together with its child processes.
- `docs/AGENTS.md`: per-agent install, command lines, what each permission mode means, limits, and how to add another agent. `tests/agents_test.js` covers the command lines and each CLI's stream format.
- Claude is told which game and client you are on, your character (name, realm, level, race, class, faction, guild), zone and map coordinates, money, talents and professions. The addon sends these few lines with its hello and again when they change (a `c` flag and an extra field in the strip record), the bridge keeps the latest in `state.json` and passes it to every run with `--append-system-prompt`. `/wow-ai context` shows it, `/wow-ai context off` stops it (and clears the bridge's copy), `"gameContext": false` in `config.json` disables it on the bridge side.
- `docs/WOW-ADDON-PRIMER.md`, a short reference on writing addons and macros for the Forever client, goes into the system prompt with the game context on every run, whatever folder the chat works in. `primerFile` in `config.json` points elsewhere or (`""`) drops it; edits are picked up without a restart.
- Shift-click an item, spell, quest or name while the addon's input box has focus to link it into the message, as in the game chat (hooked on `ChatFrameUtil.InsertLink`, the modern chat code the Forever client runs; the old `ChatEdit_InsertLink` global is used only where that is missing). On send, each link becomes `[Name]` in the text and its tooltip is appended in a "Linked from the game" block, so Claude can read an item's stats or a spell's description. Links typed in the game chat (`/ai … [item]`) get the same treatment.

### Changed

- **Renamed to WoW AI.** The addon is `WoWAI` (saved data `WoWAIDB`, slot addons `WoWAI_S###`, signal files under `Interface\AddOns\WoWAI`), the slash command `/wow-ai` (`/ai`, `/ask`, `/wowai` and the old `/wow-claude` are aliases of it, so `/ai agent codex` works; `/claude` is gone; `/r` stays), the bridge command `wow-ai`, the environment variable `WOW_AI_PROJECT`, the repository `chelinho139/wow-ai`. `node setup.js` migrates an install of the old name: it copies the saved data (chats, settings, session token) to `WoWAI.lua`, removes the `WoWClaude` addon and its slot folders, and rewrites `bridge/config.json` (paths, and Claude's `claudePath`/`model`/`permissionMode`/`allowedTools` moved under `agents.claude`). The bridge still reads a config in the old layout. Re-run `npm link` (after `npm unlink -g wow-claude`) and `/wow-ai bind` if you used them.
- A message typed after `/ai` or `/wow-ai` that starts with a command word (`/ai help me write a macro`, `/ai delete the unused imports`) is sent as a message unless the rest of the line fits that command; before, `delete` would have deleted the chat and `help` printed the help.
- Replies are stored with role `assistant` plus the agent that wrote them, in the addon's history and the bridge's `transcripts.json`; older entries with role `claude` are read as Claude's. The `[reply]`/`[open]` hyperlinks in the game chat use the `wowai:` prefix, and the window's cwd line shows the chat's agent.
- Rename and Folder moved off the bottom row into a small menu that opens when you right-click a chat in the left panel.
- Each chat row has a trash can that deletes the chat after an OK/Cancel confirm; `/wow-ai delete` still deletes without asking.
- Send sits at the right end of the input box instead of at the left of the bottom row.
- The bridge no longer exits when the addon folder is missing from `Interface\AddOns`; it logs one warning and the banner shows `addon : NOT INSTALLED`.

### Fixed

- Reload-mode messages now preserve permission grants for the bridge.
- Outbound wire fields now replace record separators inside user text and context.
- State, transcript, and permission-config writes now use the existing atomic writer.
- Agent parser failures now return a bridge error instead of terminating the bridge.
- Windows paths now keep their drive roots in portable protocol tests and progress labels.
- Non-Windows test runs now skip the PowerShell codec check with a clear message.
- Deleting a chat in game now tells the bridge to forget its transcript and agent session (a `d` strip record), so a later restore no longer brings the chat back. Deletions made while the bridge was away are resent with the next hello.
- On clients where the sound-file self-test fails (an empty `.wav` reports as playable), the addon can't hear the bridge's 30-second presence beats, and the status light went yellow 90 s after every reply, so each new message needed a Reconnect click and burned a slot. In that mode the light now allows for the 10-minute idle slot poll (green up to 12 min without news, "down" after 22), so it stays green while the bridge is running.
- A message sent while the light is not green is now sent automatically once the bridge answers the reconnect, instead of waiting for a second click on Send.

## [0.3.0] - 2026-09-22

First public release.

### Added

- In-game chat window (`/wow-claude`) with multiple chats, each backed by its own persistent Claude Code session, running in parallel up to `maxParallel`.
- Outbound transport: messages drawn as a pixel strip in the top-left corner and decoded by a PowerShell screen capture.
- Inbound transport: a pool of 200 load-on-demand slot addons the bridge writes replies into, plus `Inbox.lua` for the `/reload` fallback.
- Empty-wav signal files for acknowledgements, reply readiness, per-action heartbeats, and a 30-second presence beat that drives the status light.
- Live progress in the working bubble: action count, elapsed time, and the files and commands Claude is touching.
- Replies echoed into the game chat; `/r` replies to Claude when it was the last to message you; `/ai <text>` sends from the chat box.
- **Allow & retry** button when Claude is denied a tool, which appends the rule to `allowedTools` and resumes.
- Per-chat working folder (`/wow-claude cd`, **Folder** button) resolved against the bridge's default folder.
- Bridge-side transcripts and automatic restore of chats after the client wipes addon saved data.
- `wow-claude` command (`npm link`) that uses the folder it is started from as the default project.
- `setup.js` installer: finds the client, copies the addon, writes `config.json`, builds the slot pool.
- Test suite: addon in a Lua VM with a stub client, protocol unit tests, slot-file round trip, codec-to-decoder round trip, and a live inject test.

[Unreleased]: https://github.com/chelinho139/wow-ai/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/chelinho139/wow-ai/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/chelinho139/wow-ai/releases/tag/v0.3.0
