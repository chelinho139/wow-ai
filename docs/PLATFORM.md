# claude-wow as a platform: core + plugins

Today claude-wow is one thing: a chat window wired to a coding agent. The goal is two
things — a general in-game AI client that stands on its own, and coding work as one
plugin among several.

## The split

**Core** owns everything that is true whatever you are talking to:

- Transport in and out (screenshot strip out, load-on-demand slots in).
- Chats, sessions, transcripts, restore.
- Surfaces: the addon window, whisper tabs, the game-chat echo, map layers, macros, live UI widgets.
- Game context: character, zone, position, quest log, professions, shift-click links.
- A plugin registry, and the routing that decides which plugin a message belongs to.

Core knows nothing about PRs, tickets or repositories.

**Plugins** are named capabilities the core routes to. Each declares:

```
id                 "claude-code"
label              shown in the bridge's banner and logs (the addon shows the id)
aliases            other names a message may address it by: "@claude …"
match(msg)         when a bare message on a chat bound to nothing belongs to it
tools              extra instructions placed in the system prompt after the reply rules
surfaces           which of the core's surfaces its replies may use: "map", "macro", "ui"
                   (the window, the echo and the tab are how every reply reaches the player)
handle(msg, core)  what to actually do; `core` lends it the agent runner, the
                   bridge's folder and the chat's session
```

A chat is bound to a plugin the way it is bound to an agent today (a `plugin=`
flag on the record). `@claude …` or `/claude …` at the start of a message
addresses the coding plugin whatever the chat is bound to; a bare message goes to
whichever plugin the chat is bound to, defaulting to the general one. Chats from
before the split stay bound to the coding plugin. The agent CLIs (`agents.js`)
are the core's model runner, shared by every plugin: `ask` runs the same CLI as
`claude-code`, in a scratch folder instead of a project.

Players never have to name a plugin. The addon picks one from the chat: a chat
attached to a running session with `/claude -r` is `live`, a chat with a folder
(`/claude cd`) is `claude-code`, and any other chat goes to the bridge's default
(`ask`). `/claude -r` also decides between `live` and a headless resume: a session
that is connected over the channel gets the chat live, any other one is resumed
with `--resume` in its folder by `claude-code`. `/claude config plugin <name>`
stays as an advanced setting that pins a chat by hand.

## The plugins

| Plugin | What it is | Comes from |
|---|---|---|
| `ask` | General AI chat. Game questions, quest research, map routes, macros. The default. | Core behaviour today, minus the coding assumptions |
| `claude-code` | Agent sessions in a folder. What the bridge does now. | Existing bridge |
| `live` | A Claude Code session already open in a terminal, reached through a Claude Code channel ([LIVE-SESSION.md](LIVE-SESSION.md)). No agent run: the plugin forwards the message and waits for the session's `wow_reply`. | `bridge/plugins/live.js`, `bridge/channel.js` |
| `factory` | The approval queue: drafts waiting on a stamp, judge holds, merge-ready PRs | `factory-inbox`, `factory-ledger` |
| `studio` | The task board: what is in flight, what is blocked | `studio-board`, `studio-orchestrator` |
| `vision` | Answers about what is on screen | New; see below |

## Why the factory belongs in game

`factory-inbox` is the one station that runs attended — it exists because some
decisions need a person. That is a bad fit for a terminal you are not looking at,
and a good fit for a whisper that flashes while you quest:

```
[factory] whispers: PR #17999 is merge-ready. approve / hold / look?
```

Answering in the tab runs the station. The queue is already a durable file, so the
addon is a view over it, not a second source of truth.

The same holds for `studio`: the board is already the state, and the in-game frame
is one more reader of it.

## Vision

The transport already screenshots the whole screen once per message and throws away
everything outside the strip. The rest of that image is the game. Attaching it to the
message makes questions like "should I equip this?" or "why is this boss killing me?"
answerable, with no new mechanism — only a decision about when to attach it and how to
keep the file small.

This is the one capability that has no equivalent outside the game.

## Order of work

1. **Vision** — independent of the re-architecture, highest payoff per line.
2. **Plugin seam** — extract the registry and routing from what is already there; move
   the coding path behind `claude-code` with no behaviour change.
3. **`ask`** — the general plugin, so the product works for someone who does not code.
4. **`factory`** — the approval queue as whisper prompts.
5. **`studio`** — the board as an in-game frame.

Steps 2 and 3 are what make it a product rather than a developer toy; step 1 is what
makes it a demo.
