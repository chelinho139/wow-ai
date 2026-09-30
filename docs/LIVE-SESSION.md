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

## In game

```
/claude -r                     the running and recent sessions; running ones are marked [running]
/claude -r wow-ai [text]       attach a chat to the running session named wow-ai (or give its id, a prefix of it, or its number in the list)
```

`/claude -r` picks the kind of attachment for you. A session that is running with the channel gets the chat live: the text goes into that terminal, as below. Any other session is resumed headless with `claude -p --resume <id>` in its own folder, like any other chat. You never name the plugin; `/claude config plugin live` is still there for a chat you want pinned to whichever session connected last.

The bridge matches a running session by the Claude Code session id (the channel server tells it the pid of the Claude Code process that started it, and Claude Code's `sessions/<pid>.json` names the session), by the session's name in Claude Code, or by the name the channel server gives it (`CLAUDE_WOW_LIVE_NAME`, else the folder's name). If that session is gone when a message is sent, the chat says so; `/claude -r <id>` then resumes it headless.

With whisper tabs on (`/claude config whisper on`), each chat is a tab: type there and the text goes to the session. The session sees:

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

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `plugins.live.enabled` | `true` | `false` stops the bridge from opening the socket. |
| `plugins.live.waitMs` | `3000` | How long a message waits for a session to connect before the chat is told there is none. |
| `plugins.live.timeoutMs` | `timeoutMs` | How long a message waits for `wow_reply`. |
| `plugins.live.permissionTimeoutMs` | `120000` | How long a relayed permission roll waits before it is denied. |

## Testing it

`npm test` covers the framing, the notification shape, reply routing, the no-session message, socket permissions and the handshake (`tests/live_test.js`) with a fake session. `npm run test:live-session` runs the real thing in a sandbox: its own `CLAUDE_WOW_HOME`, a bridge, and an interactive `claude` in a detached tmux session (Haiku, `--permission-mode manual`, only `wow_reply` pre-approved). It drives the startup dialogs, checks the no-session message, a reply, a Greed and a Pass, and cleans up. Options: `-- --evidence <dir>` keeps the pane and the logs, `--prime` types the one-line opt-in above into the session first, `--model`, `--claude <path>`, `--dir`, `--keep`.
