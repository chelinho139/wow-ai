# Live session: a whisper tab into a running Claude Code session

The `live` plugin connects an in-game chat to a Claude Code session that is already open in a terminal. You type in the whisper tab; the text lands in that session as a channel event; the session answers with a tool call; the answer comes back to the tab like any other reply (window, whisper tab, game-chat echo, voice line).

It uses Claude Code [channels](https://code.claude.com/docs/en/channels), a research preview. A session only receives channel events if it was **started** with the channel. A running session cannot opt in later: you restart it with the flag, and `--resume` keeps its conversation.

## Start a session with the channel

From this repository (its `.mcp.json` registers the `claude-wow` channel server):

```sh
cd /path/to/claude-wow
claude --dangerously-load-development-channels server:claude-wow
```

To reattach an existing conversation, resume it with the same flag:

```sh
cd /path/to/claude-wow
claude --resume <session-id> --dangerously-load-development-channels server:claude-wow
```

`claude --resume --dangerously-load-development-channels server:claude-wow` with no id opens a picker of recent sessions in that folder.

### Restarting a session that is not listening

Every Claude Code session opened in this repository starts the channel server, because `.mcp.json` registers it. Only a session started with the channel flag receives the messages. The channel server reads its parent's command line at startup (see [How listening is detected](#how-listening-is-detected)); without the flag, or in a `-p`/`--print` run, it stays idle: it lists no tools, declares no channel, sends no instructions and does not connect to the bridge. The bridge checks again on its side and never offers a session without the flag as live.

To make such a session live, quit it in its terminal and start it again with its own session id. The exact command, as the bridge and `/claude -r` print it:

```sh
cd <session folder> && claude --resume <session-id> --dangerously-load-development-channels server:claude-wow
```

For example:

```sh
cd /Users/me/wow-ai && claude --resume 6624f327-7126-423e-a653-d7cf7a4e492b --dangerously-load-development-channels server:claude-wow
```

When the bridge uses a home folder other than `~/.claude-wow`, the command also carries `CLAUDE_WOW_HOME=<home>` before `claude`. `--resume` keeps the conversation; only the flag is new.

Claude Code shows two prompts the first time:

1. "WARNING: Loading development channels": choose **I am using this for local development**. The flag is needed because a custom channel is not on Anthropic's channel allowlist during the preview.
2. "New MCP server found in this project: claude-wow": choose **Use this MCP server** (or set `enableAllProjectMcpServers` in the project's `.claude/settings.json`).

A dim line under the banner confirms it: `Channels (experimental) messages from server:claude-wow inject directly in this session`.

If the bridge uses a home folder other than `~/.claude-wow`, start Claude Code with the same `CLAUDE_WOW_HOME`, or the channel server cannot find the bridge. The bridge prints the exact command, and so does `/claude -r` in game.

### From another folder

The channel server is `bridge/channel.js` (or `claude-wow channel` with the compiled binary). To use it outside this repository, register it in that project's `.mcp.json` with an absolute path:

```json
{ "mcpServers": { "claude-wow": { "command": "node", "args": ["/path/to/claude-wow/bridge/channel.js"], "alwaysLoad": true } } }
```

`alwaysLoad` keeps `wow_reply` in the session's tool list from the start. Without it Claude Code defers MCP tools behind tool search, and in testing Haiku then answered in the terminal instead of calling `wow_reply`.

and start Claude Code there with the same flag. The name must be `claude-wow`.

### Use it from every session

Register the channel server once at user scope, with absolute paths:

```sh
claude mcp add-json --scope user claude-wow '{"type":"stdio","command":"/usr/local/bin/node","args":["/path/to/claude-wow/bridge/channel.js"],"alwaysLoad":true}'
```

Then start interactive sessions with the flag from your shell, for example in `~/.zshrc`:

```sh
claude() {
  command claude --dangerously-load-development-channels server:claude-wow "$@"
}
```

Every Claude Code process now starts the channel server, including `claude -p` jobs, sub-agents and sessions started without the wrapper. In those the server stays idle: no `wow_reply`, no instructions, no bridge connection, so it costs no context. `/claude -r` never lists a `-p`/`--print` process.

The "WARNING: Loading development channels" dialog appears at every start of a session with the flag. This is by design during the channels preview.

## In game

```
/claude -r                     the sessions, as a short list of clickable rows
/claude -r more                the whole list
/claude -r <n> [text]          attach a chat to row n (or give a session id, a prefix of it, its title or its folder name)
```

Each row shows a number, the session's title (its Claude Code title, else its first prompt), the folder and git branch, its age, and a state:

| State | Meaning | A click |
|---|---|---|
| `live` | running and started with the channel | attaches the chat live: the text goes into that terminal |
| `running, not listening` | running, but started without the channel flag | shows the exact restart command and a `[resume headless]` link |
| `resume` | not running (or a chat of your own) | resumes it headless with `claude -p --resume <id>` in its folder |

Live sessions come first, the same session never shows twice, and the list stops at 8 rows with a `[more]` link. The row for the current chat says `(this chat)`. Every row is a link in the whisper tab and a button in the workspace window, so you never copy an id. `/claude -r <n>` still works. You never name the plugin; `/claude config plugin live` is still there for a chat you want pinned to whichever listening session connected last.

### How listening is detected

The channel server sends the bridge its parent pid, which is the Claude Code process that started it, and the session id from `CLAUDE_CODE_SESSION_ID` (the bridge prefers `sessions/<pid>.json` in the Claude Code folder, which follows a `/resume` inside the session). It does not use `CLAUDE_PID`: a Claude Code started from inside another session inherits the outer session's value. The bridge reads that process's command line once, when the server connects (`ps -ww -o args= -p <pid>` on macOS and Linux, `Win32_Process.CommandLine` through PowerShell on Windows). The read does not block the bridge; a message for that session waits until it is done. The session is `listening` only when the command line has `--dangerously-load-development-channels` or `--channels` with `server:claude-wow` (or `plugin:claude-wow@...`) among its values, and no `-p`/`--print`. Another server name, no flag, a print run, or a command line that cannot be read counts as not listening. The channel server applies the same rule to its parent at startup, before it answers `initialize`; only when it cannot read the command line does it keep the full server and leave the decision to the bridge. The bridge log says which: `session "wow-ai" connected from /Users/me/wow-ai, pid 3460, not listening (Claude Code pid 3421 was started without --dangerously-load-development-channels server:claude-wow)`.

The MCP `initialize` request carries no channel signal. Claude Code 2.1.285 sends the same `initialize` (protocol `2025-11-25`, capabilities `roots` and `elicitation`, the same `clientInfo`) with and without the flag, and the server's environment is the same too, so the command line is the only signal.

### When the session does not pick a message up

After a message goes to a live session, the bridge watches the session's transcript for it (`chat_id="..." message_id="..."`). A `wow_reply` or a relayed permission prompt counts too. When none of these arrives within 45 s (`plugins.live.pickupMs`), the chat gets one line and stops waiting: `The session "wow-ai" did not pick it up — it may be busy or not listening. A late reply still lands here.` If the session answers later, the reply still arrives in that chat: the addon checks for it for 5 minutes, and after that it comes with the next slot the addon reads.

The bridge matches a running session by the Claude Code session id (the channel server tells it the pid of the Claude Code process that started it, and Claude Code's `sessions/<pid>.json` names the session), by the session's name in Claude Code, or by the name the channel server gives it (`CLAUDE_WOW_LIVE_NAME`, else the folder's name). If that session is gone when a message is sent, the chat says so; `/claude -r <id>` then resumes it headless.

With whisper tabs on (the default; `/claude config ui whisper on|off`), each chat is a tab: type there and the text goes to the session. The session sees:

```
<channel source="claude-wow" chat_id="..." message_id="12" chat_name="Live" character="Thrall, level 12 Orc Shaman" zone="Durotar (Razor Hill) 52.1, 43.0">
[In-game situation ...]
where is the flight master?

(The player reads your answer in game: send it with wow_reply, chat_id "...".)
</channel>
```

and answers by calling `wow_reply` with that `chat_id`. The server's instructions tell it to keep in-game replies to one to four short sentences, and to end with a `TL;DR:` line when a reply runs longer, which is what the game-chat echo prints. Text the session writes in its terminal never reaches the game.

The repository's `.mcp.json` sets `alwaysLoad` so `wow_reply` is never deferred behind tool search; the instructions also name the full tool, `mcp__claude-wow__wow_reply`. A model can still be wary of instructions that arrive inside a channel event. If the session answers in the terminal instead of in game, tell it once, in the terminal: "My World of Warcraft client is attached through the claude-wow channel. Answer each claude-wow channel message with the wow_reply tool."

With no session connected, the chat answers at once: "No live Claude Code session is connected. Start one with: ..." and the exact command.

## Permissions

When the session needs approval for a tool (a `Bash` command, a `Write`), the prompt is relayed to the chat that is waiting on that session, as the usual Need/Greed/Pass roll:

- **Need** or **Greed**: allow this one call.
- **Pass** (or letting the roll time out): deny it.

The terminal dialog stays open at the same time. Whichever answer comes first wins. A prompt with no in-game chat waiting stays in the terminal only. If nobody answers in game, the bridge denies it after `plugins.live.permissionTimeoutMs` (2 minutes).

Only tool approvals relay. The folder trust dialog and the MCP server consent dialog are terminal-only.

## How it fits together

```
WoW whisper tab -> addon -> strip/screenshot -> bridge (plugin "live")
     -> Unix socket <CLAUDE_WOW_HOME>/live.sock (a named pipe on Windows)
     -> bridge/channel.js, spawned by Claude Code over stdio
     -> notifications/claude/channel -> the running session
session -> wow_reply tool -> channel.js -> socket -> bridge -> slot files -> addon
```

- `bridge/channel.js` is a small MCP server written by hand (no npm dependency): `initialize`, `tools/list`, `tools/call`, `ping`, and the channel notifications. It declares `claude/channel` and `claude/channel/permission`.
- The bridge listens on the socket while it runs (`bridge/plugins/live.js`). When the home path is too long for a Unix socket, the socket goes to `/tmp/claude-wow-<uid>-<hash>.sock`.
- Only the local bridge can talk to the channel server. The socket is created with mode `0600`, and the channel server refuses a socket that other users can reach. The bridge writes a fresh random token to `<CLAUDE_WOW_HOME>/live.token` (mode `0600`) on every start. Both sides prove they hold it (HMAC over a nonce) before any message is accepted; the channel server drops every frame from a peer that has not.
- A chat attached with `/claude -r` goes only to that session. A chat pinned with `/claude config plugin live` sticks to the session it first talked to while that session stays connected; otherwise it goes to the most recently connected session.

## Goals and orders (Phase 0)

A listening session also gets three goal tools from the channel server: `goal_set`, `goal_list` and `order_issue`. The channel server does not touch any file. It forwards each call over the same socket, and the bridge (`bridge/goals.js`) is the only writer.

- **Store:** `<CLAUDE_WOW_HOME>/goals/<Name-Realm>/goals.json`, one file per character, named from the `Character:` line of the last game context (`Bone-ClassicBetaPvP2`). It is written to a temporary file and renamed. A file the bridge cannot read or parse is never overwritten; the tool says so.
- **Goals:** one type, `profession`, with a target rank. At most 8. The profession must be in the context's `Professions:` line. Names map to skill IDs with the table that mirrors `PROFESSION_SKILL_IDS` in `ClaudeWoW.lua` (English names only; a localized name the table does not know is refused). Progress is the reported rank over the target, read from the latest context on every call, never typed in.
- **Orders:** one current order and the last 20. The order text is an allowlist, checked in the bridge, in any letter case:
  - The text is NFKC-normalized, then every character must be one of `A-Z a-z 0-9`, space, or `, . ' - : ! ? %`. Accents, symbol letters, zero-width and other hidden characters, `/`, `|`, `{ }`, `< >` and line breaks are refused, so no slash commands, macros or markup.
  - Every word must be a number (`30`, `2g`, `5th`), the character's name, a profession in the `Professions:` line (whole names first, so `First Aid` counts and a lone `aid` does not), or a plain English word from `bridge/order-words.json` (verbs and function words such as `raise`, `train`, `vendor`, `until`). The list holds no WoW proper names, profession names, races, classes or materials.
  - A game name goes in only as a reference token: `{item:ID}`, `{skill:ID}` or `{map:ID,x,y}` (x and y from 0 to 100), with a space or punctuation on both sides. The bridge expands each one to the canonical name from the synced Forever data (`claude-wow data sync`), for example `Buy 20 {item:ID}` becomes `Buy 20 <the item's name>`, and stores the expanded text plus `refs` (kind, ID, name, trust, build) with the order. A map token shows only the map's name; its x and y are the model's estimate and are kept in the ref as `point` with `trust: "model"`, never shown. Only rows the data serves as `client-data` for the client's build family count. An ID the data does not have, a malformed token, coordinates over 100, a token glued to a letter, a digit or another token, a data name with any character outside the order set below, or `{npc:ID}`, `{quest:ID}` and `{faction:ID}` (no name source yet) refuse the whole order, and the tool error names the token.
  - Without synced data, with data for another build family, or before the game reported its client build, no token expands: the order is refused and the error says so. Plain orders work as before (only names the game reported).
  - The words around the tokens go through the same allowlist, so a typed name is refused even next to a valid token. The error names each refused word.
  - Phrase check: once the words pass, every run of 2 to 4 words inside one clause (runs stop at `. ! ? ; ,` followed by a space or the end, never at `:`, `-` or a mark glued to the next word) is refused when it is a name in the synced data or in `bridge/game-phrases.json`, a short list of well-known ability and place phrases made of plain words ("old town", "back stab", "mark of the wild"), unless a token or a reported name supplied it. The data names used are areas, maps, flight paths and skill lines, plus the spell a spell-book, recipe, pattern, rune or tablet item teaches ("Book: Mark of the Wild" gives "mark of the wild"; a rune or tablet remainder that starts with "the" or is only stop words is skipped). A phrase that is a real area name, such as "gold mine", stays refused even when it reads as plain English; item names themselves are not used, because many are ordinary English, and rows marked test, unused or deprecated are skipped. The index is built once per data build and table hash, and never from a missing or damaged table. The refusal names where each run came from and offers a token only for maps and skills. The data is opened for every order that passes the word check. Without complete synced data only the built-in list applies, and the reply says why. This does not close the class: the synced data has no spell or NPC names, so an ability or NPC phrase made of plain words that is missing from the list still gets through.
  - The text sent may be up to 400 characters with its tokens (90 without); the order as shown is at most 90 characters after expansion. `order_issue` is refused when the game has not confirmed its context in the last 15 minutes (any message from the game confirms it); clearing an order always works.
- **Overlay:** every change POSTs `{"action":"orders","orders":{...}}` to `plugins.stream.url` `/control` (3 s timeout): the current order (text, goal title, goal percent or `null`), up to 3 other goals with a known percent (the order's own goal is left out of the list), and `asOf` (when the bridge got that context text, epoch ms, or `null` when it does not know; never the current time). `goal_list` also shows `contextReceivedAt`, the last time the game confirmed the context. If the addon cut the context at its 900-byte limit and the `Professions:` line is last, the last profession is dropped, so a cut rank never counts. `plugins.stream.enabled: false` (sandboxes and e2e runs) sends nothing. A stream service that is down does not undo the write.
- **In-game runs never get them.** Every Claude run the bridge starts from the game passes `--disallowedTools` with `mcp__claude-wow__goal_set`, `mcp__claude-wow__order_issue`, `Read(//<home>/live.token)` and `Edit(//<home>/goals/**)` (for the home path and its resolved real path; Edit rules also cover Write). A Need or Greed click cannot grant the goal tools, `config.json` never keeps them, and the roll never offers them. The channel server lists no tools in a `-p` run, and the bridge refuses a goal call from a session that is not listening, from a channel server whose pid is not really a child of the Claude Code pid it named (`ps`), and from any process under an agent run the bridge started.
- **What is not covered:** the pid in the hello is reported by the peer. A run that holds the token can name another process's pid. Read rules do not stop shell commands, so an in-game run granted `Bash` (or a Codex run, which ignores deny rules) can still read `live.token` or write `goals/` with a shell command. Do not grant broad `Bash` to in-game chats while the overlay is live.

The in-game Orders card is the next step; until then the order shows on the stream overlay only.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `plugins.live.enabled` | `true` | `false` stops the bridge from opening the socket. |
| `plugins.live.waitMs` | `3000` | How long a message waits for a session to connect before the chat is told there is none. |
| `plugins.live.timeoutMs` | `timeoutMs` | How long a message waits for `wow_reply`. |
| `plugins.live.permissionTimeoutMs` | `120000` | How long a relayed permission roll waits before it is denied. |
| `plugins.live.pickupMs` | `45000` | How long a message may show no sign of pickup before the chat is told. `0` turns the watchdog off. |

## Testing it

`npm test` covers the framing, the notification shape, reply routing, the no-session message, socket permissions and the handshake (`tests/live_test.js`) with a fake session. `npm run test:live-session` runs the real thing in a sandbox: its own `CLAUDE_WOW_HOME`, a bridge, and an interactive `claude` in a detached tmux session (Haiku, `--permission-mode manual`, only `wow_reply` pre-approved). It drives the startup dialogs, checks the no-session message, a reply, a Greed and a Pass, and cleans up. Options: `-- --evidence <dir>` keeps the pane and the logs, `--prime` types the one-line opt-in above into the session first, `--model`, `--claude <path>`, `--dir`, `--keep`.
