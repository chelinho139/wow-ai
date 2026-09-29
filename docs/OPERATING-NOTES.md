# Operating notes: real use, edge cases, and the rules

## Blizzard's rules

The addon stays inside the documented API: it draws frames, reads the player's own
state, writes its saved variables, calls `Screenshot()` and `SetCVar`. It does not
read memory, inject code, generate input, or make a decision the player did not ask
for. That is the line the UI policy actually draws, and this side of it is where
Questie, TomTom, WeakAuras and every route addon already live.

**The one rule that matters: never automate play.** Not movement, not casting, not
targeting, not looting, not accepting a quest. The moment anything here presses a
key for the player it is a bot, whatever the intent. The agent advises; the player
acts. Keep it that way, and refuse feature requests that cross it — an "auto-run
this route" button is the obvious one to say no to.

Two softer points, worth knowing:

- **`Screenshot()` on a timer** is fine but writes real files. Left unattended with a
  dead bridge it fills a disk (below).
- **`SetCVar("screenshotFormat")`** changes a player-facing setting. The addon restores
  it on logout; a client crash skips that, so the player's own screenshots silently
  change format until the addon next runs. Restore on load as well as on logout.

## Edge cases

**Screenshots pile up when the bridge is down.** The addon shoots on every send; the
bridge is what deletes them. Bridge stopped, game still running, player still typing
→ the folder grows by a full-screen PNG per message, and at the default TGA it is
~8 MB each. The addon should stop shooting when presence has been dark for a while,
and the bridge should sweep leftovers at startup.

**A screenshot is a screenshot.** With vision on, whatever is on screen goes to the
model: other players' names, guild chat, whispers, an alt-tabbed window caught in a
full-screen grab. Fine for the player's own use; not fine to assume. Keep vision
off by default (it is), say plainly in the UI when it is on, and never attach one
to anything that leaves the machine.

**Loading screens, death, cinematics.** The strip cannot be drawn, so the shot has no
payload. The transport already retries and times out; the thing to avoid is a retry
storm during a long zone load.

**Combat.** Typing in the addon window during a fight steals the keyboard. Protected
actions are unavailable in combat too, so anything that touches a secure frame must
defer to `PLAYER_REGEN_ENABLED`. The whisper tab inherits the chat frame's behaviour,
which is the safe path.

**Character switch and relog.** The game context (level, zone, quests) is per
character, and the bridge holds the last one it was told. Switching characters
without a new hello leaves the agent advising the wrong toon. Send context on
`PLAYER_ENTERING_WORLD`, not only at load.

**Multiple clients.** Two WoW windows, or a second account, both write to the same
addon folder and the same Screenshots folder. Nothing today distinguishes them.

**Long replies.** The window scrolls, but the game chat echo is one line and the chat
box caps at 255 characters unless `longchat` is on. That is why the summary is capped
and why replies should be short.

**Slot exhaustion.** Replies cycle 200 load-on-demand slots. Several chats working at
once, with progress publishes, will wrap sooner than a single chat; the addon reports
`slots exhausted` and falls back, but it is worth watching with parallel agents.

**Cost and rate limits.** Every message resumes the chat's agent session, so context
grows monotonically until the chat is new. A long-lived chat silently gets more
expensive per message — 312k tokens of context per "hey" is real. The addon should
show context size, and offer to start fresh past a threshold.

**Unreviewed work.** The coding plugin runs with `acceptEdits`. An agent editing a
repo while the player is questing is the whole point, but it means diffs land
unwatched. Keep it to branches, never to a default branch, and never auto-push.
