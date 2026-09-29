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
- **`SetCVar("screenshotFormat")`** changes a player-facing setting. The addon keeps
  the player's own value in its saved settings from the first change and restores it
  on logout and, since a client crash skips that, on load too (`ADDON_LOADED` and
  `PLAYER_LOGIN`), when the value is still the addon's. A stored original is never
  overwritten with the addon's own `png`/`tga`, and a value the player set by hand in
  between is theirs and stays.

## Transports

**Screenshot is the default; pixel is deprecated.** A new install, and any `config.json`
without a `capture.mode`, starts on the screenshot transport: no screen capture, no
Screen Recording or Automation permission, no window discovery, no python. It is
verified end to end on macOS. The pixel capture (`capture.ps1`, `capture_mac.py`,
`capture_x11.py` and the CoreGraphics layer) stays in the tree for one reason: `Screenshot()`
has not yet been confirmed on Windows or on Linux under Wine. Once it is, the pixel
path goes. Until then an explicit `"mode": "pixel"` keeps working and is reported as
deprecated by `setup.js` and the bridge's banner.

**Nobody is left without a transport.** A client without `Screenshot()`, or one whose
shots all come back `SCREENSHOT_FAILED`, cannot use the default. The addon then puts
`shot=missing` or `shot=failed` on its records (the strip's flags and the reload
outbox), tells the player once in the game chat, and the bridge, on the first record
that carries it, switches to the pixel capture, logs `TRANSPORT FALLBACK: ...` with
the reason and what the fallback needs, writes `transportFallback` to `state.json`
(the next start goes straight to pixels; the banner says why), and names the reason
in its slot files, where `/claude-wow diag` shows it (`transport: pixel (bridge: pixel
transport, fallen back to since ... because ...)`). The first report takes the slow road:
a bridge waiting for screenshots is not watching the screen, so it arrives through the
reload fallback, about two minutes after the first message. An explicit `capture.mode`
always wins over the memory: `"pixel"` ends the note, `"screenshot"` tries again at
every start (and falls back again, that run, if the addon still cannot shoot).

## Edge cases

**Screenshots pile up when the bridge is down.** The addon shoots on every send; the
bridge is what deletes them. Bridge stopped, game still running, player still typing
→ the folder grows by a full-screen PNG per message, and at the default TGA it is
~8 MB each. Handled on both ends: the addon stops shooting once the bridge has been
silent for as long as its light takes to go red (5 minutes with the presence beats,
22 without), says so once in the game chat, and puts the strip up pixel-style instead
so the usual retries and the reload fallback carry the message; it says when shooting
resumes, and the Connect button still takes exactly one shot by hand, which is how a
bridge that came back is found when the beats can't say so. The bridge sweeps the
folder at startup and every 5 minutes, deleting only client-named files whose pixels
hold a decodable strip (the magic header and checksum nothing but the addon draws)
and older than a minute; a file without a strip is the player's and is never touched.

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
expensive per message — 312k tokens of context per "hey" is real (measured: 106,863
tokens after 8 turns, 312,458 after 213). So the bridge reads each run's usage
(Claude Code's `stream-json`: input + cache_read + cache_creation of the last
assistant message is what the next turn carries; the result's usage is the turn's
sum and prices the run at `CLAUDE_RATES` in `bridge/agents.js`), keeps it per chat
in `state.json` (`sessionUsage`) and ships it on the reply record; the addon's
footer shows it like Claude Code's status line (`11m 58s · ↓ 106.9k tokens ·
≈$2.41 API` — the dollar figure is the API-list-price equivalent, a comparison,
since a subscription is not billed per token), `/claude-wow context` and `diag`
report it, and past `/claude-wow context <n>` (100k by default: half of a 200k
window, about eight messages in) the chat says so once, with a **New chat**
button. Codex, Grok, agy and Hermes report nothing the bridge can trust, so those
chats show turns and elapsed time only.

**Unreviewed work.** The coding plugin runs with `acceptEdits`. An agent editing a
repo while the player is questing is the whole point, but it means diffs land
unwatched. Keep it to branches, never to a default branch, and never auto-push.
