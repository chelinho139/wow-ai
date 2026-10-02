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

A listening session also gets the goal tools from the channel server: `goal_set`, `goal_list`, `order_issue`, `goal_vote_open` and `goal_vote_close`. The channel server does not touch any file. It forwards each call over the same socket, and the bridge (`bridge/goals.js`) is the only writer.

- **Store:** `<CLAUDE_WOW_HOME>/goals/<Name-Realm>/goals.json`, one file per character, named from the `Character:` line of the last game context (`Bone-ClassicBetaPvP2`). It is written to a temporary file and renamed. A file the bridge cannot read or parse is never overwritten; the tool says so.
- **Goals:** `profession` with a target rank, or one `gearset` (see Phase 3 below). At most 8. The profession must be in the context's `Professions:` line. Names map to skill IDs with the table that mirrors `PROFESSION_SKILL_IDS` in `ClaudeWoW.lua` (English names only; a localized name the table does not know is refused). Progress is the reported rank over the target, read from the latest context on every call, never typed in.
- **Orders:** one current order and the last 20. The order text is an allowlist, checked in the bridge, in any letter case:
  - The text is NFKC-normalized, then every character must be one of `A-Z a-z 0-9`, space, or `, . ' - : ! ? %`. Accents, symbol letters, zero-width and other hidden characters, `/`, `|`, `{ }`, `< >` and line breaks are refused, so no slash commands, macros or markup.
  - Every word must be a number (`30`, `2g`, `5th`), the character's name, a profession in the `Professions:` line (whole names first, so `First Aid` counts and a lone `aid` does not), or a plain English word from `bridge/order-words.json` (verbs and function words such as `raise`, `train`, `vendor`, `until`). The list holds no WoW proper names, profession names, races, classes or materials.
  - A game name goes in only as a reference token: `{item:ID}`, `{skill:ID}` or `{map:ID,x,y}` (x and y from 0 to 100), with a space or punctuation on both sides. The bridge expands each one to the canonical name from the synced data of the client's game, Forever or Classic Era (`claude-wow data sync`, `--flavor classic_era` for Era), for example `Buy 20 {item:ID}` becomes `Buy 20 <the item's name>`, and stores the expanded text plus `refs` (kind, ID, name, trust, build) with the order. A map token shows only the map's name; its x and y are the model's estimate and are kept in the ref as `point` with `trust: "model"`, never shown. Only rows the data serves as `client-data` for the client's build family count. An ID the data does not have, a malformed token, coordinates over 100, a token glued to a letter, a digit or another token, a data name with any character outside the order set below, or `{npc:ID}`, `{quest:ID}` and `{faction:ID}` (no name source yet) refuse the whole order, and the tool error names the token.
  - Without synced data, with data for another build family, or before the game reported its client build, no token expands: the order is refused and the error says so. Plain orders work as before (only names the game reported).
  - The words around the tokens go through the same allowlist, so a typed name is refused even next to a valid token. The error names each refused word.
  - Phrase check: once the words pass, every run of 2 to 4 words inside one clause (runs stop at `. ! ? ; ,` followed by a space or the end, never at `:`, `-` or a mark glued to the next word) is refused when it is a name in the synced data or in `bridge/game-phrases.json`, a short list of well-known ability and place phrases made of plain words ("old town", "back stab", "mark of the wild"), unless a token or a reported name supplied it. The data names used are areas, maps, flight paths and skill lines, plus the spell a spell-book, recipe, pattern, rune or tablet item teaches ("Book: Mark of the Wild" gives "mark of the wild"; a rune or tablet remainder that starts with "the" or is only stop words is skipped). A phrase that is a real area name, such as "gold mine", stays refused even when it reads as plain English; item names themselves are not used, because many are ordinary English, and rows marked test, unused or deprecated are skipped. The index is built once per data build and table hash, and never from a missing or damaged table. The refusal names where each run came from and offers a token only for maps and skills. The data is opened for every order that passes the word check. Without complete synced data only the built-in list applies, and the reply says why. This does not close the class: the synced data has no spell or NPC names, so an ability or NPC phrase made of plain words that is missing from the list still gets through.
  - The text sent may be up to 400 characters with its tokens (90 without); the order as shown is at most 90 characters after expansion. `order_issue` is refused when the game has not confirmed its context in the last 15 minutes (any message from the game confirms it); clearing an order always works.
- **Overlay:** every change POSTs `{"action":"orders","orders":{...}}` to `plugins.stream.url` `/control` (3 s timeout): the current order (text, goal title, goal percent or `null`), up to 3 other goals with a known percent (the order's own goal is left out of the list), and `asOf` (when the bridge got that context text, epoch ms, or `null` when it does not know; never the current time). `goal_list` also shows `contextReceivedAt`, the last time the game confirmed the context. If the addon cut the context at its 900-byte limit and the `Professions:` line is last, the last profession is dropped, so a cut rank never counts. `plugins.stream.enabled: false` (sandboxes and e2e runs) sends nothing. A stream service that is down does not undo the write.
- **In-game runs never get the channel's copies.** Every Claude run the bridge starts from the game passes `--disallowedTools` with the channel's write tools (`mcp__claude-wow__goal_set`, `mcp__claude-wow__order_issue`, the vote, route and campaign tools), `Read(//<home>/live.token)` and `Edit(//<home>/goals/**)` (for the home path and its resolved real path; Edit rules also cover Write). The channel server lists no tools in a `-p` run, and the bridge refuses a goal call on the channel from a session that is not listening, from a channel server whose pid is not really a child of the Claude Code pid it named (`ps`), and from any process under an agent run the bridge started. In-game `ask` runs get goals, orders and campaigns another way, per run only: see [below](#goals-orders-and-campaigns-from-in-game-chats).
- **What is not covered:** the pid in the hello is reported by the peer. A run that holds the token can name another process's pid. Read rules do not stop shell commands, so an in-game run granted `Bash` (or a Codex run, which ignores deny rules) can still read `live.token` or write `goals/` with a shell command. Do not grant broad `Bash` to in-game chats while the overlay is live.

### Goals, orders and campaigns from in-game chats

Owner decision of 2026-10-01: an in-game `ask` chat may set goals, issue orders and run campaigns, for one run at a time. This replaces the old rule that in-game runs never get these tools. Votes stay with the live session.

- **The server:** each Claude `ask` run gets a second MCP server next to `wowdata`, named `wowgoals` (`bridge/goalsmcp.js`, `claude-wow goals-mcp` in the binary). It lists `goal_set`, `goal_list`, `order_issue`, `farm_spot_lookup`, `market_price`, `route_draw`, `campaign_start`, `campaign_end`, `beat_add`, `beat_trigger` and `narrate`, with the same schemas as the channel. It writes no file. Each call goes over the bridge's live socket to the same goal, observed and campaign stores the channel uses, so every check is the same: the order and story allowlists, reference tokens from the synced data of the client's flavor, the phrase check, the 15-minute context gate and the single writer.
- **The grant:** the bridge makes a random run id and token for each run. The MCP config (both servers) goes to a mode `0600` file in `<home>/tmp/mcp/`, and `--mcp-config` gets only its path, so the token is never on a command line. The file is deleted when the run ends, the folder is emptied when the bridge that holds `bridge.lock` starts (a crash can leave a file behind; `--once` and `--inject` leave it alone), and in-game runs get `Read(//<home>/tmp/mcp/**)` in `--disallowedTools`. Claude passes the token to the server in its environment (`CLAUDE_WOW_RUN_TOKEN`). The server proves it holds the token (HMAC over a nonce, the same proof as the channel hello, with its own message type), and the bridge proves it back.
- **The boundary:** the token lives only in the private config file and in the MCP child's environment, and the grant takes exactly one connection. The server connects and says hello as soon as Claude starts it, before the first turn, so it holds that one slot. A second hello is refused, also after the first connection drops: a dropped connection is never replaced, the run's goal tools fail closed and the bridge logs it. If the server cannot reach the socket at startup, the tools are off for the run and it never tries again. There is no pid check: a peer reports its own pid, so it proves nothing. While a run holds goal tools it has no shell: `Bash` is in `--disallowedTools`, one rule for every command.
- **Every Claude run from the game, with or without goal tools:** `Read(//<home>/**)` is denied for the home path and its real path, so the run cannot read `~/.claude-wow` (the config file, `live.token`, state). Claude Code applies Read rules to Grep and Glob only best effort (to the folder searched), so `Grep`, `Glob`, `LS` and `NotebookRead` are off outright for every plugin except `claude-code` (`ask`, `roast`, and any plugin without `searchesFiles: true`). A coding run keeps them for its project folder. Claude Code has no path rule for `Grep` or `Glob` (a `Glob(path)` rule is accepted and never checked), so a coding run that greps a folder above the home can still reach it. Other agents get no home rule: Grok reads the screenshot from `<home>/tmp`. A tool the run is denied is never offered as a Need or Greed roll, and a roll can never save a rule the run denies.
- **Bound to the character:** the grant keeps the character the game reported when the run started; a call is refused when the game now reports another character, or none. A run that starts with no character in the game context gets no server at all, and the bridge logs why once.
- **Revocation:** a cancel from the game, the run timeout and a bridge shutdown revoke the grant before they end the process; the run's end revokes it too. Revoking closes the run's connection, so a later call from that server is refused. A run connection is not a live session and never shows in `/claude -r`; `plugins.live` closes them when it stops.
- **Run-only rules:** the eleven `mcp__wowgoals__<tool>` names go to `--allowedTools` for that run only, and `mcp__wowgoals__goal_vote_open` and `mcp__wowgoals__goal_vote_close` go to `--disallowedTools`. Nothing is written to `config.json`. A Need or Greed click can never grant or keep any rule whose name starts with `mcp__wowgoals` (the server rule, a wildcard, a tool name with or without arguments), and the roll never offers one.
- **Who gets it:** Claude `ask` runs only, while the live socket exists and the game context names a character. Coding (`claude-code`) runs, the other agents and a bridge with `plugins.live.enabled: false` or `--once`, and a run with no reported character get `mcp__wowgoals` in `--disallowedTools` and no server; the bridge logs once why the tools are off.
- **Prompt:** the `ask` plugin's lines tell the agent it may use these tools when they are in its tool list and must name game things only with reference tokens, that Grep, Glob, LS and NotebookRead are off, and that Bash is off while it holds goal tools (map marks and widgets go in fenced `wowmap` and `wowui` blocks). A chat resumed from before this change keeps its first system prompt; the tool descriptions and the server's instructions still reach it.

### Gear sets and Twitch votes (Phase 3)

- **Gear set goals:** `goal_set {"type": "gearset", "slots": {"16": <itemID>, "17": <itemID>}}`. Slots are the equipment slot numbers 1 to 19. Every item ID must be a `client-data` row in the synced data for the client's build family; without synced data, with another build family or before the game reported its build, the goal is refused. The item must fit the slot by the row's `inventoryType` (a ring goes in 11 or 12, a one-hand weapon in 16 or 17); a row without one is refused (`claude-wow data sync --force`), and slot 17 is refused when slot 16 holds a two-hand item. One gear set per character (`g_gearset`); a new `goal_set` replaces it and `drop: true` removes it. The item names are kept in the goal's `refs`. The title is written by the bridge from those checked names (`Gear set: 2x Fixture Blade, Rending Claw`); past 60 characters the last names become `and N more` (N counts items). When a synced name cannot be shown, the title is the count (`Gear set: 1 item`, `Gear set: 3 items`). The Orders card and the report allow a goal's stored ref names in its title, as they do for an order. Progress is the share of the set's items that the telemetry's `equip` section reports worn, each worn item counted once and in any slot. Without that section there is no bar, never a 0.
- **No playstyle goals:** the only talent source, the `Talents:` context line, has not been seen in the game yet, and nothing reports gear stats.
- **Votes:** `goal_vote_open {"options": [<goal_set args>, ...], "seconds": 15..900}` takes 2 or 3 options. Each one goes through the same checks as `goal_set` (a vote cannot drop a goal, two equal options or two options with the same title are refused, and an option that would be a new goal when 8 already exist is refused); its title is the one the bridge would write, checked again by the order text validator and at most 60 characters. The vote remembers the character it was opened for. Nothing is written. While the vote is open the bridge reads the configured Twitch channel (`votes.channel`) as an anonymous `justinfan` user over TLS to `irc.chat.twitch.tv:6697`: no token, no capability request, and it never sends a chat line (only `NICK`, `JOIN` and `PONG`). A chat line counts when it is exactly `!1`, `!2` or `!3` (up to the option count, trailing spaces allowed). One vote per Twitch name, and the first one counts. At most 10,000 voters; later names are not counted and the result says so. The connection must join the channel (`JOIN` or the end of `NAMES`) (or any chat line from that channel) within 10 s and must not go 6 minutes without data (Twitch pings every 5); either one, or a closed connection, drops it and reconnects, at most 5 times, 5 s apart. A vote whose chat was not connected for part of its time says so in its result, and the bridge logs it once. The vote closes at the end of its time or on `goal_vote_close`.
- **Adopting:** `goal_vote_close {"adopt": true}` closes the vote (or takes the result of one that timed out) and writes the single winner as a goal (`createdBy: "vote"`), after the `goal_set` checks run again against the context at that moment. It is refused when the game now reports another character than the one the vote was opened for. Closing without `adopt` needs neither `goals.json` nor a reported character, so a damaged store cannot keep a vote open; only adopting needs them. A tie or no votes adopts nothing. A result is adopted once. Without `adopt` it only returns the counts.
- **Overlay:** at the open, at most every 2 s while counts change, and at the close the bridge POSTs `{"action":"vote","vote":{"open","options":[{"n","title","votes"}],"total","endsAt","winner"}}` to `plugins.stream.url` `/control`. No voter names leave the bridge, and nothing is read back from the stream service. On bridge shutdown an open vote is pushed once more as closed, with no winner, and the bridge waits up to 1 s for that push before it exits. The overlay shows it only with a wow-stream that has the `vote` control action; an older one answers "Unknown action", which the bridge logs once while it keeps counting. `tests/fixtures/stream/vote.json` is the fixture both repositories test the payload against.

### The in-game Orders card

The current order also shows in the game, on a card under the quest tracker (`addon/ClaudeWoW/Orders.lua`).

- **Transport:** the bridge puts `goals = { rev, char, order = { id, text, pct }, goals = { { title, pct }, ... } }` in every slot file and in `Inbox.lua`, next to `map` and `achievements`. `char` is the character key from the context (`Bone-ClassicBetaPvP2`). The field is left out in two cases only: the context names no character, or the bridge is older than the card. It spends no slot load of its own: the card changes on the next slot the addon reads anyway (a reply poll, the hello, the idle check, or a `/reload`). Every goal write republishes the slot files at once, as urgent, so a large map or widget set stays in them. The stream overlay still gets the order at once.
- **Only checked text:** the order text and every goal title go through the order validator again, against the latest context, before they are written. A store file edited by hand cannot put a zone, NPC or item name on the card. An order issued with reference tokens shows its expanded names, the same text the overlay shows: `order_issue` checked them against the synced data and stored them in the order's `refs`, and only those names are allowed besides the reported ones. Publishing opens no game data. An order the check refuses stays off the card and the bridge logs why, once. Without the data's phrase index, a name made only of plain words passes the plain-word check, as it would in a plain order. `pct` is a whole number from 0 to 100.
- **Size:** at most 3 goals (the order's own goal is shown as the order's bar, not in the list), and the field is at most 640 bytes; goals are dropped from the end first. A store the bridge cannot read sends the empty field (`rev = 0`, no order), so the card hides instead of keeping an old order; the bridge logs it once.
- **No order, no card:** a field without `order` hides the card. A slot file without the field changes nothing. The addon also hides the card when the field names another character than the one logged in (an alt reading the main's `Inbox.lua` after a `/reload`), when the client cannot name its own character, when an `Inbox.lua` read at login or `/reload` was written more than 5 minutes before it is read, in a pet battle and in a vehicle UI. A slot file written more than 5 minutes before it is read is ignored: the card stays as it is, neither hidden nor changed, so the old slots a stopped bridge leaves behind cannot bring back an order. The addon compares the character key without ASCII punctuation and spaces and keeps every other byte, so non-Latin and accented names stay distinct. A realm or name with a non-letter symbol outside ASCII (`Foo·Bar`) never matches, because the bridge drops the symbol: the card stays hidden there. Known limit: the key holds only the first part of a Forever name (`UnitName`), so two characters on one realm that share it (`Bone Sleeve` and `Bone Marrow`) also share the store and the card. It redraws only when something it shows changed, not on a new `rev` alone. A drawing error hides the card and is said once in the chat. It is said again after a later good draw, a slot read with no order, or an explicit `/claude orders on`; a pet battle or vehicle refresh that fails again stays quiet, and the same data is tried again on the next read; the rest of the slot read goes on. If the card frame was made but its parts failed, it is not made again until `/reload`.
- **Look:** the objective tracker's module header (`ObjectiveTrackerModuleHeaderTemplate`), its progress bars (`ObjectiveTrackerProgressBarTemplate`), `ObjectiveTrackerHeaderFont` and `ObjectiveTrackerLineFont`. Each is checked with `C_XMLUtil.GetTemplateInfo` or `C_Texture.GetAtlasExists` and has a plain fallback. The card anchors under the tracker's background and moves when the tracker hides. Classic Era has no objective tracker: when the client has `QuestWatchFrame` and no `ObjectiveTrackerFrame`, the card follows Era's quest watch list instead (`classic_era` UI source, `Vanilla/QuestLogFrame.lua` `QuestWatch_Update`): the order as a watched quest title in `GameFontHighlight` and gold (`0.75, 0.61, 0`), then ` - 71%` and ` - <goal>: 83%` lines in grey (`0.8`), bright when done, 13 px rows and no bars, with the quest log's `UI-PlusButton-Up`/`UI-MinusButton-Up` button. It asks for no tracker template or atlas there: Era reports some atlases as present that draw green. It sits 4 px under `QuestWatchFrame`, or in its place when the watch list is hidden.
- **Player control:** `/claude orders on|off` (or `/claude config orders`) and **Show the Orders card** in the chat list's gear menu. The header's button collapses it. Both settings are booleans in `ClaudeWoWDB.settings`. The card sends nothing and runs nothing.

## Observed data and routes (Phase 2)

The same channel server lists three more tools, forwarded the same way: `farm_spot_lookup`, `market_price` and `route_draw`. The bridge answers them (`bridge/observedtools.js`); only `route_draw` writes.

- **Data:** only what the game reported to this bridge, in `goals/<Name-Realm>/observed.jsonl` ([ARCHITECTURE.md](ARCHITECTURE.md#game-state-records-kindgs)): vendor windows and auction search results the player opened, and loot windows. A line whose `trust` is not `observed` is skipped, so a web or hand-written price or rate never backs a number. Item and map names come from the synced data of the client's game (Forever or Classic Era) through the same token expander `order_issue` uses; an item ID or map ID the data does not have, or no synced data for the client's build family, refuses the call. NPC and object sources come back as IDs with `ref: null` and `name: null`: no verified name source exists yet, so no token can name them.
- **`farm_spot_lookup {itemID}`:** for each loot source (NPC, gathering object, or fishing in a zone, and the gather spell cast just before the window when there was one), the drop rate `k/n` over the loot windows of that source (rate 0 for a source looted 10 or more times without it), the mean quantity, `n`, `asOf` (the newest loot window of that source) and up to 3 maps, each with one real loot position, the medoid of the samples there (`trust: "observed"`). Sources are never added together. A source with fewer than 10 loot windows shows only its `n`. A kill whose corpse was never opened is not a sample, so a rate is per loot window, not per kill (the client has no kill source).
- **`market_price {itemID}`:** the auction prices from searches the player ran (latest, `n`, `asOf`, and low and high over the 24 hours before the latest quote with their own `n`, `from` and `asOf`, copper per item; suffix variants are not recorded) and the vendors seen selling it (price, stack, `n`, `asOf`). The bridge and the addon never search the auction house. A quote means a different thing on each client, and the answer says which on Era:

  | Client | `price` | `quantity` | `rows` and `stack` |
  |---|---|---|---|
  | Forever, browse result | `minPrice` of the result | `totalQuantity` of the result | not given |
  | Forever, commodity search | `unitPrice` of the cheapest row | quantity of that row | not given |
  | Classic Era | lowest buyout per item in the whole result, rounded up to whole copper; bid-only auctions give no price | every item listed in the result, bid-only auctions included | the auctions behind the quote, and the stack size of the auction that set the price |

  On Classic Era a quote exists only for a search with text sent through the Blizzard browse function, whose whole result fit on one page and whose every unsuffixed row name contains the search text (ASCII case only). A result on more pages, a throttled search, a list after another addon's query or a bid, and a list with an uncached row give no quote. A query from an addon that kept its own copy of `QueryAuctionItems` from before ClaudeWoW loaded is not counted; the name check and the one-page limit still stop most such results.
- **`route_draw {points, loop?, clear?}`:** 1 to 40 `{map:ID,x,y}` tokens, checked against the synced uimaps; one bad point refuses the whole route. The bridge draws one ordered layer, `claude-route`, titled "<map name> route, model estimate", each stop labeled "Stop N of M, model estimate": the x and y are the model's and are never shown as fact. The bridge applies the route itself, republishes the slot files and keeps the map in them until the next reply is published or the game says hello ([MAP.md](MAP.md)); no slot is loaded for it. Advice only: a pin moves nothing.
- **In-game runs:** the channel's `route_draw` is in the same `--disallowedTools` list as `goal_set` and `order_issue`. An `ask` run gets all three tools from its own `wowgoals` server for that run only ([above](#goals-orders-and-campaigns-from-in-game-chats)); a Need roll can never grant or keep them.

## Dungeon Master: the solo arc (Phase 4a)

A listening session also gets five campaign tools: `campaign_start`, `campaign_end`, `beat_add`, `beat_trigger` and `narrate`. They take the same path as the goal tools (channel server, bridge socket, the same caller checks), and the bridge (`bridge/campaign.js`) is the only writer. Every one is a write tool, so every in-game run gets the channel's copy in `--disallowedTools`. An `ask` run gets them from its own `wowgoals` server for that run only ([above](#goals-orders-and-campaigns-from-in-game-chats)), and a Need roll can never grant or keep them.

- **Store:** `<CLAUDE_WOW_HOME>/goals/<Name-Realm>/campaign.json`, one campaign per character, written to a temporary file and renamed. A file the bridge cannot read is never overwritten. At most 12 beats; a beat has 1 to 5 narration lines, at most 400 characters in all; the last 3 `narrate` lines are kept; the fired list keeps the last 24.
- **Beats:** `{ title, narration: [lines], trigger }`. The bridge gives each beat its id (`b1`, `b2`, ...) and stores the refs its tokens and trigger resolved. Only the next unfired beat is armed. The events of one game update are checked in order, each against the beat armed at that moment, so one update can fire several beats. Triggers are only what the game reports today:
  - `zone {mapID}`: the character is on that uiMapID (telemetry `zone`). It fires on entering the map, and also when the beat is armed while the character is already there: at once from `campaign_start` or `beat_add`, else on the next game update. A beat armed by another beat that just fired waits for the next update, so two beats for the same map fire one update apart. The ID must be a map in the synced data for the client's build family.
  - `quest_turnin {questID}`: the game's own `QUEST_TURNED_IN` event for that quest. The addon keeps the last 8 turn-ins per character and sends them in a new telemetry section, `quests` (`questID@time`); the bridge makes a `quest_turnin` event (importance 3) for each new one. A quest that only leaves the quest log (abandoned, under a collapsed header, past entry 40) fires nothing. The ID must be a quest in the synced data.
  - `level {level}` (2 to 100): the character is at that level or higher, on a level-up or when armed, the same way as `zone`.
  - `death`: the telemetry death count goes up.
  - `manual`: the player types `/dm next`.
  `beat_trigger {id}` fires any beat at once. A fired beat is one importance-3 `beat` event in `events.jsonl` (`{ n, of }`, no text), so `claude-wow events --follow` can wake the session.
- **Story text** (campaign title, beat titles, narration): checked in the bridge like an order, with a story vocabulary: NFKC; only `A-Z a-z 0-9`, space and `, . ' - : ! ? %` (so no links, handles or slash commands); every word a number, the character's name or a word from `bridge/order-words.json` and `bridge/roast-words.json`, minus ad and call-to-action words (`tip`, `donation`, `click`, `stream`, `viewers`, `chat`, ...); the phrase check against the synced data and the built-in list. A game thing is named only with `{item:ID}`, `{skill:ID}` or `{map:ID,x,y}`, expanded from the synced data; `{npc:ID}` and `{quest:ID}` have no name source yet and are refused. The text is checked again (without tokens, with the beat's stored ref names allowed) every time it goes into a slot file; a line that fails stays out and the bridge logs it once. A write is refused when the phrase check cannot run on complete synced data for the client's build family (no data, another build family, a damaged table), because stored text is shown again later. Campaign writes, except `campaign_end`, also need a game context confirmed in the last 15 minutes, like orders; a game state record for the character the context names confirms it too, so narration keeps working while the player only plays. With `telemetry.enabled: false` in the bridge, only `manual` beats are taken, since no other trigger could fire (a player who turns telemetry off in game is not seen by the bridge). The vocabulary is the roast's everyday list, so story words such as "trail" or "woods" are refused for now.
- **Transport:** the bridge puts `dm = { rev, char, now, manual, beat = { id, title, lines } }` in every slot file and in `Inbox.lua`. `lines` is the beat's narration and then its live lines. The field is always there: with no character or no campaign it is the empty value (no `beat`), so the frame hides. `manual = true` means the next beat waits for `/dm next`. The bridge budgets the lines for the page: 21 lines of 36 characters at most. The newest live line always shows; older live lines go first, then narration from the end. The field stays under 1,600 bytes. A store the bridge cannot read sends the empty field. A beat that fires republishes the slot files at once; the frame changes on the next slot the addon reads. The stream overlay gets nothing yet: wow-stream has no control action for narration.
- **The frame** (`addon/ClaudeWoW/DM.lua`): the quest detail look. `ButtonFrameTemplate` with the Claude portrait, the `QuestBG-Parchment` atlas where `QuestFramePanelTemplate` puts it, `QuestTitleFont` for the beat title, `QuestFont` for the lines and `QuestFontNormalSmall` for the hint, each checked with a fallback (verified in Gethe/wow-ui-source branches `forever` and `classic_era`; every API and event it uses, `QUEST_TURNED_IN` included, is in both client binaries). Without `ButtonFrameTemplate` it is a plain frame, with `BackdropTemplate` and `UIPanelCloseButton` only when the client has them. The parchment is painted by the chat window's own helper (`ClaudeWoW.PaintParchment`), at one fixed size for any art: the atlas, else on Classic Era the four-piece Vanilla quest log page (`Interface\QuestFrame\UI-QuestLog-*`) that the chat window uses there, built inside the parchment area only (the Classic Era path: that client has no `QuestBG-Parchment` atlas), else a color; `ClaudeWoWDM.debug` records which. The body is 320 pixels tall and at most 21 lines, so the largest beat stays on the parchment; the client cuts longer text with an ellipsis. Lines are separated by one line break. A new beat opens it with the quest sound; in combat it waits for the end of combat, and `/dm` in combat says "shows after combat". New live lines never reopen a frame the player closed. Escape closes it. It follows the Orders card's rules: the character key, the 5-minute age rule for `Inbox.lua` (an old slot file is ignored), a drawing error said once, and nothing kept in saved variables.
- **`/dm`** shows or hides the frame. With no beat it opens the same frame with an empty state: "The Dungeon Master has no story for you yet." and one hint line, or "Type /dm next to begin." when the next beat is `manual`. `/dm` lines that must be printed (`/dm next` replies, errors) go to the chat frame of the edit box the player typed in, else `DEFAULT_CHAT_FRAME`, never through `ClaudeWoW.Print` (which picks the Claude whisper tab). **`/dm next`** sends one `kind=dm` control record (text `next`, the character key in the name field) when the next beat is `manual`, only to a bridge that sends the `dm` field in a slot file or in an `Inbox.lua` written in the last 5 minutes (an older bridge would run it as an empty prompt), one at a time and at most one every 5 s. The bridge handles it before the record could touch the context time, acks it like a cancel (the ack list in the slot files and the ack file), publishes the slot files once, and never runs an agent for it. A slot read that carries the ack carries the beat too; an ack seen through the ack file makes the addon read one slot a second later, unless the chat log transport's own ack poll is already due. A record that is never acked is dropped after its tries without marking the transport failed. Nothing in this module sends to the game chat.
- **No demo yet:** a Horde demo campaign for Classic Era is still to be written. Era data is synced now (`claude-wow data sync --flavor classic_era`), so its trigger IDs and tokens can be checked.

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
