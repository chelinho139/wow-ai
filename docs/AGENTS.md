# Agents

The bridge can drive three coding agents: Claude Code, OpenAI Codex and xAI's Grok Build. This page is the reference for each: what to install, how the bridge starts it, what its permission settings mean, and what it cannot do. The code is `bridge/agents.js`, one entry per agent; `bridge.js` only knows the interface (build the arguments, hand over the prompt, read the stream).

## Choosing one

- `agent` in `bridge/config.json` is the default for every chat (`claude` unless you change it). The bridge refuses to start on a name it doesn't know.
- A chat can pick its own with `/wow-ai agent codex`, or right-click the chat in the left panel and choose **Agent...**. `/wow-ai agent default` goes back to the bridge's. A new chat inherits the agent of the chat you were in, like the folder.
- The choice travels with each message as an `agent=` flag in the strip record, so the bridge needs no restart, and the reply comes back tagged with the agent that wrote it: the bubble label, the `[Codex · chat]` prefix in the game chat and the `To Grok [chat]:` header of `/r` all follow it.
- A session belongs to the agent (and the folder) that made it. A chat that changes agent starts a fresh session with the new one; the transcript in the window stays.
- The bridge's banner lists every agent with the executable it found, or what to install. A chat whose agent is missing gets a reply saying so instead of a hang.

All three run headless on the bridge PC, so log in once by hand in a terminal there (`claude`, `codex`, `grok login`); the bridge reuses the cached login.

## The shared vocabulary

Every agent's block in `config.json` has the same keys, and the bridge maps them to that agent's own switches:

| Key | Meaning |
|---|---|
| `permissionMode` | `acceptEdits` (default): edits inside the project are fine, commands need a rule. `default`: nothing is pre-approved beyond reading. `bypassPermissions`: everything is allowed. |
| `allowedTools` | Rules in Claude Code's syntax: `WebSearch` allows a tool, `Bash(git:*)` any command starting with `git`, `Bash(npm test)` that exact command. The **Allow & retry** button appends to this list. Ignored by Codex. |
| `deniedTools` | Rules the agent may never use, same syntax. Claude gets them as `--disallowedTools`, Grok as `--deny` (which wins over everything, `bypassPermissions` included). Ignored by Codex. |
| `model` | Passed through to the CLI when non-empty. |
| `path` | The executable, when the bridge can't find it on its own. A `.js` path is run with the bridge's own Node; a Windows `.cmd` npm shim is unwrapped. |
| `extraArgs` | Anything else to put on the command line, verbatim. |

How each one finds its executable on Windows: a configured `path`; else the installer's folder (`%UserProfile%\.local\bin\claude.exe`, `%UserProfile%\.grok\bin\grok.exe`); else `<name>.exe` on the `PATH`; else npm's `<name>.cmd` launcher, which the bridge unwraps (Node can't spawn `.cmd` files, and going through `cmd.exe` would mangle a system prompt) into the script it runs or the native binary next to it.

Codex also checks `CODEX_BIN` before searching `PATH`, so a newer launcher can override an older `codex.exe` earlier on `PATH`.

## Claude Code

- **Install:** [claude.com/claude-code](https://claude.com/claude-code). Run `claude` once and log in. `claude --version` must work in a terminal.
- **Command line:** `claude -p --output-format stream-json --verbose --permission-mode <mode> --allowedTools <rules…> [--model <m>] [--resume <session>] [--append-system-prompt <context>]`, prompt on stdin. The `CLAUDECODE` variable is removed from the environment so a bridge started from inside a Claude Code session can still launch it.
- **Permissions:** `permissionMode` and `allowedTools` are Claude's own concepts, passed as they are. Denied tools come back in the result as `permission_denials`; the bridge turns them into rules (`Bash(cargo:*)`, `WebSearch`) for the **Allow & retry** button.
- **Session:** the `session_id` on the stream; `--resume` on later runs. Claude keeps sessions per folder.
- **Progress:** one line per `tool_use` block (`edit player.gd`, `$ npm test`, `search: …`) and each text block as a snippet.
- **Context:** the game context and primer go in as a system prompt, on every run.

## Codex

- **Install:** `npm install -g @openai/codex`, then `codex` once to log in (ChatGPT account or API key). On Windows npm installs a `codex.cmd` launcher; the bridge finds the native `codex.exe` inside the package and runs that directly.
- **Command line:** `codex [-c sandbox_workspace_write.network_access=true] exec --json --skip-git-repo-check -C <folder> (--sandbox read-only|workspace-write | --dangerously-bypass-approvals-and-sandbox) [-m <model>] [resume <thread>] -`, prompt on stdin (the `-` at the end). `--skip-git-repo-check` because a chat's folder need not be a repository. The `-c` override goes before `exec` and is only added with `networkAccess`.
- **Permissions:** Codex has no per-tool allowlist; in `exec` mode it never asks and relies on its sandbox. So `permissionMode` picks the sandbox: `default` → `read-only`, `acceptEdits` → `workspace-write` (it may write the chat's folder and temp; the network is off for commands unless `networkAccess: true`), `bypassPermissions` → no sandbox at all. `allowedTools` and `deniedTools` are ignored. Measured on codex 0.156: a command the sandbox blocks produces no event at all in the `--json` stream; the model gets the failure and says so in its own words ("`touch x` failed: operation not permitted"). Should a `command_execution` with status `declined` ever appear, the bridge names it at the end of the reply. There is no **Allow** button because there is no rule to add: raise `permissionMode` instead.
- **Session:** the `thread_id` of the `thread.started` event; later runs use `codex exec … resume <thread_id> -`.
- **Progress:** `command_execution` → `$ command` (the shell wrapper Codex adds, `/bin/zsh -lc '…'`, is stripped), `file_change` → `edit a.js, b.js` (or `write`/`delete`), `web_search`, `mcp_tool_call` → `tool: server.name`, reasoning summaries as `~ …`, and each `agent_message` as a snippet. The reply is the last `agent_message` of the turn (what `codex exec -o` would write).
- **Context:** Codex has no system-prompt flag, so the game context and primer ride at the top of the prompt in a block marked as context from the bridge. A new session gets the full block; a resumed one only the short context lines (the primer is already in the thread). Codex also reads `AGENTS.md` in the chat's folder on its own.

## Grok Build

- **Install:** `irm https://x.ai/cli/install.ps1 | iex` in PowerShell (or `npm install -g @xai-official/grok`), then `grok login`; needs a SuperGrok or X Premium+ subscription, or `XAI_API_KEY` in the environment. The installer puts `grok.exe` in `%UserProfile%\.grok\bin`.
- **Command line:** `grok --no-auto-update --output-format streaming-json --cwd <folder> --prompt-file <file> (--permission-mode dontAsk --allow <rule>… | --always-approve) [-m <model>] [-r <session>] [--append-system-prompt <context>]`. The prompt goes through a file (`bridge/tmp/prompt-NNN.txt`, deleted afterwards) so its length and characters never touch the command line. `GROK_DISABLE_AUTOUPDATER=1` is set as well.
- **Permissions:** `acceptEdits` → `--permission-mode dontAsk` plus `--allow Edit`, `--allow Read`, `--allow Grep` and your `allowedTools`; `default` → `dontAsk` plus your `allowedTools` only; `bypassPermissions` → `--always-approve`; `deniedTools` → `--deny` rules in every mode. Rules are translated from Claude's syntax to Grok's globs: `Bash(git:*)` becomes `Bash(git *)` and `Bash(git)`; `WebSearch`, `WebFetch`, `Read`, `Edit`, `Grep`, `Bash` pass through (Grok accepts the same tool names). What Grok Build 1.0.41 actually does headless, measured rather than read off the docs: `dontAsk` and `default` both behave like its auto mode. Ordinary actions run without any rule (listing, reading, editing, `touch`, a file write); dangerous ones are blocked by its classifier (`rm` of a project file: "Auto mode blocked this action"), an allow rule naming the command lets them through, and a deny rule always blocks. So `allowedTools` only matters for the dangerous commands, and `deniedTools` is the way to keep Grok off something. A refused call comes back as a `tool_call_update` with status `failed` and a content line "Tool `run_terminal_command` was not executed: …"; the bridge turns it into a rule for the **Allow & retry** button (`Bash(rm:*)` for a blocked `rm victim.txt`) and quotes the reason in the reply. A command that merely failed (non-zero exit) is not mistaken for one.
- **Session:** the `sessionId` in the `end` event; later runs pass `-r <id>`. Grok stores sessions under `%UserProfile%\.grok\sessions`.
- **Progress:** `tool_call` events by their `toolName` (`run_terminal_command` → `$ npm test`, `read_file` → `read main.rs`, `write`/`search_replace` → `edit b.lua`, `grep`, `list_dir` → `ls src`, `web_search`, `web_fetch`, `spawn_subagent` → `agent: …`; anything else by its ACP `kind`, then its name), `thought` chunks as one `~ …` line, and each stretch of `text` before a tool call as a snippet. The reply is the text streamed after the last tool call (or the last text there was, when the turn ends on a tool call). A `stopReason` other than `end_turn` is noted in the reply.
- **Context:** the game context and primer go in with `--append-system-prompt` (Grok accepts Claude Code's flag names), on every run. Grok also reads `AGENTS.md`, `CLAUDE.md` and `.grok/rules/` in the chat's folder on its own.

## Google Antigravity CLI

- **Install:** Install Google Antigravity CLI (agy) and run `agy` once to log in. On Windows the bridge checks `%LOCALAPPDATA%\agy\bin\agy.exe`.
- **Command line:** `agy -p=<prompt> --output-format stream-json --add-dir <folder> --print-timeout <seconds>s [--conversation <id>] [--model <m>] ...`. The prompt must be attached to `-p=`. The bridge sets both the process cwd and `--add-dir` to the chat folder.
- **Permissions:** `acceptEdits` uses `--mode accept-edits --disable-slash-commands`; `default` uses `--mode plan`; `bypassPermissions` uses `--dangerously-skip-permissions --disable-slash-commands`.
- **Session and progress:** the `conversation_id` from `init` is resumed with `--conversation`. Active tool steps become progress lines, and `result` supplies the final reply. The context block goes at the top of the prompt. When needed, the user prompt is truncated to keep context under the Windows command-line limit.

## Hermes Agent

- **Install:** Install Hermes Agent and run `hermes setup` once.
- **Command line:** `hermes chat --query-file - -Q --in <folder> --source tool [--resume <id>] [-m <model>] [--image <path>]`; the prompt is sent on stdin. Hermes writes plain reply text to stdout and `session_id: <id>` to stderr.
- **Permissions:** `acceptEdits` is the default. `bypassPermissions` falls back to default; the bridge never passes `--yolo` and appends a note to the reply.
- **Images and context:** the first image is passed with `--image`; additional paths are included in the prompt. The context block goes at the top of the prompt.

## Known limits

- One agent CLI can only be as headless as it is. If an agent hangs waiting for something interactive (a first-run login, an update prompt), the run ends when `timeoutMs` (30 minutes) expires; run the CLI by hand once on the bridge PC to get past it.
- The **Allow** button needs the agent to report what it refused. Claude always does; Grok marks the refused call `failed` with a "was not executed" line, which the bridge reads; Codex says it in its own words and has no rule to add anyway.
- The bridge's own transcript (`bridge/transcripts.json`) and the addon's history record which agent wrote each reply, so a restored chat keeps its labels. Chats saved before agents existed show their replies as Claude's.
- Codex and Grok were tested live against codex 0.156.1 and Grok Build 1.0.41 (the inject test, plus captured streams in `tests/agents_test.js`). Unknown event types are ignored; a stream that ends without a result is reported as an error with the exit code and the tail of stderr.

## Trying one without the game

```powershell
npm run test:live -- --agent codex     # or claude, grok
```

builds a sandbox with a 5-slot pool and runs the bridge with `--inject`, which pretends the strip said "Reply with exactly the word PONG"; the reply must land in every slot and `Inbox.lua`. `node bridge/bridge.js --inject "hello" --agent grok` does the same against your real config.

## Adding an agent

1. An entry in `AGENTS` in `bridge/agents.js`: `name`, `command`, `install` (one line telling the user what to do), `windowsPaths`/`posixPaths` (where its installer puts it), `npmPackage` if it ships one, `args(…)` (the command line for a run: folder, resume id, permissions, model, system prompt), `input(…)` (the prompt on `stdin` or in a `promptFile`), `env(…)` (the bridge then adds `WOW_AI_MAP_FILE` for the map layers, see [MAP.md](MAP.md)), and a `parser()` whose `feed(event)` returns progress lines, the session id, denied rules, notes and the final `done`. Plain-text CLIs may declare `stream: 'text'` and implement `parser().finish({ stdout, stderr, code })`.
2. A block under `agents` in `bridge/config.example.json`, and the same keys documented in `docs/CONFIGURATION.md`.
3. A section on this page, and the id in the README's table and the addon's `AGENT_NAMES` (only for its display name; unknown ids are capitalized).
4. Tests in `tests/agents_test.js`: the arguments for each permission mode, and a sample of the CLI's real stream through the parser.
