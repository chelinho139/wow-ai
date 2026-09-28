# Outbound transport alternatives (game -> bridge)

Why this exists: the current outbound channel draws the message as a strip of 4 px coloured cells in the top-left corner (`addon/WoWAI/WoWAI.lua:320-366`), and `bridge/capture_mac.py` screen-captures that corner four times a second (`--interval-ms` default 250, line 42). The strip stays up until the bridge acks it, and the player finds it ugly. This document lists every outbound channel a sandboxed addon could plausibly use on WoW: Forever (TOC 16001, macOS native client), says which ones are actually possible, and ends with one recommendation.

Ground rules every option is judged against (from `docs/ARCHITECTURE.md:25-33`, confirmed against the addon code):

- Addon Lua has no `io`, `os`, sockets, `require` or `loadfile`. The only ways bytes leave the sandbox are pixels on screen, files the *client* chooses to write, and sound the client plays.
- The client writes SavedVariables, macros, bindings and CVars only on `/reload`, logout or exit. `ReloadUI()`/`C_UI.Reload()` need a hardware event (wiki `API C_UI.Reload`, `#hwevent`); the addon piggybacks on the player's next keypress (`WoWAI.lua:284-296`).
- Files the addon *reads* (LoD slots, `.wav` probes) must exist at launch; that is the inbound side and is not the problem here.

> **Correction, and how the rest of this document should be read.** Everything below that
> was judged from a `/run` probe was judged on bad evidence. **`/run` is blocked on this
> client** once WoWAI is loaded: even `/run print("hello")` raises `ADDON_ACTION_BLOCKED`,
> because the addon taints the chat frame's execution path and `RunScript` is refused from
> tainted code. It is not the API being probed that was blocked. Re-probed from real addon
> code (a slash handler inside WoWAI) the results were the opposite of what is written below:
>
> - `Screenshot()` — **works.** `pcall` returns `ok=true` and a file appears, with no keypress.
>   It is not protected. Option 3 is therefore LIVE, and is what the bridge now ships.
> - `SetCVar("screenshotFormat", "png"|"tga")` — works; `"bmp"` is refused.
> - TGA and PNG screenshots round-trip pixel values **bit-exactly** (0/20/40/60/90/120/180/255
>   all came back unchanged), so the strip can be drawn near-black and still decode. JPEG does
>   not: saturated cells came back as 253 and 247.
> - `C_Log.LogMessage`, `taintLog`, chat logging and combat logging — all called successfully
>   from addon code, and **none** of them put addon-chosen text on disk. Options 2 and 6 are dead.
>
> The ranking below is left as written, with row 3 corrected, so the reasoning that led to the
> wrong conclusion stays visible. The lesson worth keeping: probe from addon code, never `/run`.

"Verified" means present in Blizzard's `forever` UI source (Gethe/wow-ui-source) or listed by warcraft.wiki.gg for WoW Forever 1.60; "unverified" means it needs a `/run` in game.

## Ranked table

| # | Channel | Possible? | Visible to player | Latency | Capacity / send | Player action per message | Verdict |
|---|---|---|---|---|---|---|---|
| 1 | Unobtrusive pixel strip: ack poll at 0.1 s, 2 px cells, near-black palette with an adaptive threshold, shown only during send | Yes (all pieces exist today) | A faint dark rectangle for ~0.3 s | ~0.3 s | 3.2 KB | None | Good fallback; superseded by row 3 |
| 2 | `C_Log.LogMessage` -> `Logs/*.log` | Callable, but **writes no file** with addon-chosen text (verified) | - | - | - | - | Dead |
| 3 | **`Screenshot()`-triggered strip** | **Yes — verified live from addon code.** The earlier "disproven" verdict came from a `/run` probe, and `/run` itself is blocked | The strip for 1-3 frames, near-black | ~1 s | 3.6 KB | None | **Shipped.** Removes screen capture, and with it the Screen Recording permission, window discovery and the polling loop |
| 4 | SavedVariables + `/reload` (today's fallback) | Yes | A full UI reload | 2-10 s + a keypress | Unlimited | One keypress (piggybacked) | Fallback only |
| 5 | `/logout` / exit-driven saves | Yes | Character select | 10+ s | Unlimited | Yes | No |
| 6 | Chat log: `LoggingChat(true)` + whisper-to-self | Probably (APIs verified; echo and flush unverified) | Chat lines | 0.5-2 s | 255 chars, server-throttled | None | No: routes traffic through Blizzard's chat servers |
| 7 | Combat log (`LoggingCombat`) | No Lua path produces a combat log event | - | - | - | - | Impossible |
| 8 | Addon messages (`C_ChatInfo.SendAddonMessage`) | Never written to disk | - | - | - | - | Impossible |
| 9-11 | Macros / key bindings / CVars (`macros-cache.txt`, `bindings-cache.wtf`, `config-cache.wtf`) | Written at reload/logout/exit; server-synced account data | None | Same as #4 or worse | Small | Keypress | No |
| 12 | Audio symbol files + system-audio capture | In principle | Audible | Seconds | Bytes/s | None | No |
| 13 | Strip off-screen, behind UI, or alpha < 1 | No: capture sees only the composited framebuffer | - | - | - | - | Impossible |
| 14 | Temporal channel (one cell per capture) | Yes | A blinking dot | 3.2 KB in ~35 min | 12 bit/s | None | No |
| 15 | Cursor texture, window title, clipboard, `ConsoleExec` | Cursor: tiny and visible; title/clipboard: no API; `ConsoleExec` exists but no file-writing command known | - | - | - | - | No |

## 3. `Screenshot()` -- LIVE (this section's original reasoning was wrong; see the correction at the top)

**Evidence.** Running `/run print(type(Screenshot))` in game on WoW: Forever (TOC 16001) produced the `ADDON_ACTION_BLOCKED` popup ("WoWAI has been blocked from an action only available to the Blizzard UI"). Blizzard's own UI only ever calls `Screenshot()` inside `OnKeyDown` handlers for PRINTSCREEN (`Blizzard_AddOnList/AddonList.lua:99-103` and `:554-557`, `forever` branch), never from a timer or event, which is consistent with the function being either hardware-event gated or Blizzard-only. Note that `type(Screenshot)` alone reads a global and cannot raise the popup; the block must have come from an actual call, most likely the `C_Timer.After(1, Screenshot)` probe this document originally suggested, which runs with no hardware event.

**Why no taint-safe path exists.** Protected functions run only from untainted execution. Everything an addon touches is tainted, `securecall` and `hooksecurefunc` do not remove taint, macros (`/run`) execute insecurely, and `RunBinding` "cannot be used to call a Protected Function from insecure execution paths" (wiki `API RunBinding`), so `RunBinding("SCREENSHOT")` is not a laundering route. The only secure execution an addon can borrow is a `SecureActionButtonTemplate` click, whose `type` attribute is a fixed list in `Blizzard_FrameXML/SecureTemplates.lua` (`menu, togglemenu, actionbar, action, actionrelease, pet, flyout, multispell, spell, toy, item, equipmentset, macro, cancelaura, leavevehicle, destroytotem, stop, target, focus, assist, maintank, mainassist, click, attribute, raidtarget, worldmarker, teleporthome, returnhome, visithouse, outfit`; lines 262-650). There is no screenshot action, and `macro`/`macrotext` runs `/run` insecurely. The restricted environment (`SecureHandlers.lua`) cannot call arbitrary globals either. Conclusion: if `Screenshot()` is Blizzard-only, there is no path at all.

**The one distinction still worth one probe.** Hardware-event gating (like `C_UI.Reload`) and Blizzard-only protection produce the same popup. Typed directly, `/run Screenshot()` executes inside the Enter keypress. If *that* is also blocked, the function is Blizzard-only and this row is closed for good. If it works, the function is only hw-gated, and then no extra player action would be needed: `WoWAI.Send` already runs inside a hardware event (Enter in the input box or a click on Send), so `ShowStrip()` followed by `Screenshot()` in the same handler would be legal, and timer-driven sends (hello at login, forgets) would ride the existing key-catcher (`WoWAI.lua:284-296`). Whether a same-handler screenshot includes UI shown in that handler is a second unknown. Given the live evidence, treat this as closed unless that single probe passes.

## 1. Unobtrusive pixel strip (recommended)

Everything here uses the machinery that already works on this machine (1920x1080, scale 1, native CoreGraphics backend in `capture_mac.py`, `CGWindowListCreateImage` at line 511). Four independent changes:

**a. Ack faster (biggest visible win, ~10 lines).** The strip is removed when `ack/NNN.wav` becomes valid, and that check runs on the 2 s tick (`TICK_SECONDS`, `WoWAI.lua:37`; `Tick()` at `:836`; `C_Timer.NewTicker` at `:3141`). The bridge raises the ack the moment it decodes (`bridge/bridge.js:328`, `signal()`), so today the strip lingers 0.25-2.5 s purely from the addon's polling. A `C_Timer.NewTicker(0.1, ...)` active only while `run.stripShown` brings the visible time to roughly the capture interval (250 ms, could drop to 100 ms with the in-process backend) plus 100 ms.

**b. Smaller cells.** The decoder samples one pixel at each cell centre (`capture_mac.py:82-84`), and the native backend is an exact framebuffer copy, so 2 px cells decode identically. Same 200 cells per row, half the height and width: a 300-byte message becomes 400 x 4 px. 1 px cells would work on the exact copy too but leave no tolerance for the window-offset search (`find_and_decode`, line 131). `CELL` is a constant in both the addon (`WoWAI.lua:33`) and the capture args (`bridge/bridge.js:97`, `cellPx`).

**c. Contrast.** Today's decoder rule is fixed: a channel is "on" when the sampled value is >= 128 (`cell_value`, line 82-84; identical in `capture.ps1` and `capture_x11.py`). With that rule the palette can be anything whose "on" level lands >= 128 and "off" level < 128 *after* whatever the client does to the frame. Facts that bound this:

- On this macOS setup the capture is an exact copy, so the only transforms are the game's own Gamma/Contrast/Brightness settings (post-process on the whole frame, UI included). `docs/ARCHITECTURE.md:37` records that the first codec, with four levels per channel, misread under some display settings on Windows GDI; the safe assumption is a monotonic curve that keeps 0 at 0 and 1 at 1 but moves anything in between by tens of levels.
- With the fixed 128 threshold, the safest low-contrast palette is symmetric around it: on = 0.65 (166), off = 0.35 (89). That survives roughly +/-38 levels of curve shift. It looks like a mid-grey mosaic: less garish than the rainbow, still clearly visible. Going closer (0.55/0.45) leaves +/-12 levels, which a Gamma slider can eat. So **with the current decoder, nothing darker than grey is reliable**.
- **Narrower range needs an adaptive threshold, and the codec already carries the calibration for free.** The first six cells encode the magic `0xC7 0x1A` (`Codec.lua:14`, `capture_mac.py:87-91`), whose per-channel on/off pattern is known to both sides (values 6,1,6,1,3,2 -> R on in cells 1,3,5; G on in 1,3,5,6; B on in 2,4,5). The decoder can read the actual "on" and "off" levels per channel from those cells and threshold at their midpoint. Then the palette can be off = 0 and on = 0.16 (about 40/255) drawn over a black backdrop: 0 stays 0 under any monotonic curve, 40 stays clearly above it, and there is no noise in a framebuffer copy. That is a near-black rectangle, effectively invisible on the usually dark top-left corner. Change in `Codec.CellColor` (`Codec.lua:59-65`, returns 0/1 per channel; scale the 1 to the chosen level) plus the threshold rule in all three capture scripts; `tests/codec_test.js` already round-trips `Codec.Encode` through the Python decoders with noise and gamma and is the place to prove it. Do not use alpha: `SetColorTexture(r, g, b, a)` with `a < 1` blends with unknown pixels behind the strip.
- Windows GDI and Wine/X11 captures are also exact copies of the composited frame, so the same palette should hold there; the only platform where a dark palette would fail is one applying a display colour transform to the capture (HDR, colour management), which the existing `--probe` shows immediately.

**d. Position and duration.** "Under existing UI" is impossible: an occluded pixel is overdrawn and the capture only sees the result. "Only during send" is already the case (`RefreshStrip` hides the frame when nothing is outstanding, `WoWAI.lua:385-393`); (a) shortens it. The biggest strip the player sees is the login hello carrying the 900-byte game context (12 rows); it could be split into a tiny hello and a separate context record, or the context could go only on the first real message.

Estimated visible result after a-c: a ~400 x 4 px near-black rectangle for ~300 ms per send, ~400 x 24 px for the hello. Effort: an afternoon, no new permissions, no protocol change, all three platforms.

## 2. `C_Log.LogMessage` (wildcard, one probe)

`C_Log.LogMessage`, `LogWarningMessage`, `LogErrorMessage`, `LogMessageWithPriority` exist in this client's API docs (`Blizzard_APIDocumentationGenerated/LogDocumentation.lua`, `Environment = "All"`, `SecretArguments = "AllowedWhenUntainted"`, not protected) and the wiki lists them for WoW Forever 1.60. Blizzard uses them for debug output (`AnchorUtil.PrintAnchorGraph -> C_Log.LogMessage`). Nothing documents where the text goes. The client keeps per-system logs in `_classic_beta_/Logs/` (`General.log`, `DeveloperLog.log`, `Client.log`, ... all 0 bytes here) and none contains addon text today. If `LogMessage` lands in any file with a prompt flush, it is the ideal channel: invisible, text, unlimited, no permissions, one `fs.watch`. If it only feeds the in-game console, it is useless.

Probe (no player action needed for the channel itself; the probe is typed once):

```
/run C_Log.LogMessage("WOWAI-PROBE-" .. time()); C_Log.LogWarningMessage("WOWAI-PROBE-W"); C_Log.LogErrorMessage("WOWAI-PROBE-E")
```

then, in a terminal, `grep -rl WOWAI-PROBE "/Applications/World of Warcraft/_classic_beta_/Logs"` immediately, again after 30 s, after `/reload`, and after logout, to learn destination and flush timing. Also try `/run C_Log.LogMessageWithPriority(0, "WOWAI-PROBE-P")` (the `LogPriority` enum values are in the same doc file).

## 4-15. The rest, briefly

- **SavedVariables + `/reload`** is implemented (`db.outbox`, `WoWAI.lua:1242`; `readOutbox`, `bridge/bridge.js:374`, polled by mtime at `:710`). Invisible strip, but a UI reload per send and a wait for the player's next keypress. Fallback only.
- **Logout** is the same file write via the character-select screen. No.
- **Chat log.** `LoggingChat(true)` writes `Logs/WoWChatLog.txt` (verified: `Blizzard_ChatFrameBase/Shared/SlashCommands.lua:845-853` implements `/chatlog` with it). Lua `print`/`AddMessage` are not chat events and are believed not to be logged (unverified), so the addon would have to whisper itself (`SendChatMessage` WHISPER is not hw-gated; SAY/YELL/CHANNEL are outdoors since 8.2.5). 255 characters per message, server throttling, lines in the player's chat, unknown flush timing, `SendChatMessage` deprecated in 11.2, and it pushes this project's traffic through Blizzard's chat servers, which is the automation line the README promises not to cross. No.
- **Combat log.** No Lua API produces a combat log event. Impossible.
- **Addon messages.** Server round trip to clients; never on disk; not in the chat log. Impossible.
- **Macros, bindings, CVars.** Written at reload/logout/exit (so never better than the fallback) and synced to Blizzard as account data (`Logs/AccountData.log` shows the periodic cache downloads; `macros-cache.txt`, `bindings-cache.wtf`, `config-cache.wtf` under `WTF/Account/<id>/`). Capacity 120 + 30 macros x 255 B (`MacroConstantsDocumentation.lua`). No.
- **Audio.** `PlaySoundFile` of pre-made symbol files, recorded from system audio: audible, needs ScreenCaptureKit or a virtual device, bytes per second. No.
- **Off-screen / behind UI / transparent.** Not rasterised, overdrawn, or blended with unknown pixels. Impossible.
- **Temporal, cursor, title, clipboard, console.** 12 bit/s; small and visible; no API; no API; `ConsoleExec` exists (`ConsoleDocumentation.lua:43`) but no console command writes user bytes to a file. No.

## Recommendation

Build **#1, the unobtrusive strip**: fast ack polling, 2 px cells, a near-black palette with the threshold calibrated from the magic cells. It is the only option that is certain to work, needs no player action, changes no protocol, and lands on all three platforms.

Before starting, spend two minutes on two probes, in this order:

1. `/run C_Log.LogMessage("WOWAI-PROBE-" .. time())` then grep `Logs/` (above). A hit makes #2 the transport and #1 unnecessary.
2. `/run Screenshot()` typed directly (inside the Enter keypress). Blocked: #3 is Blizzard-only, closed. Works: it is hw-gated only, and a same-handler `ShowStrip()+Screenshot()` on Send becomes a candidate again, pending a test that the shot includes UI shown in that handler.

Then, for #1: raise the ack poll to 0.1 s while `run.stripShown`; set `CELL = 2` in the addon and `cellPx` in `bridge/config.json`; change `Codec.CellColor` to return 0 / 0.16 and add a black backdrop texture under the cells; in `capture_mac.py`, `capture_x11.py` and `capture.ps1` replace the fixed 128 rule with per-channel midpoints measured on the six magic cells; extend `tests/codec_test.js` with the new palette under its gamma/noise simulation; confirm with `npm run probe:mac`.

## Addendum (second opinion, 2026-09-28): three channels the table missed

Source of evidence: `strings` over `_classic_beta_/World of Warcraft Beta.app/Contents/MacOS/World of Warcraft` (the live 16001 build) plus mtimes in `_classic_beta_/Logs` and `WTF`. Nothing below has been run in game yet; each row ends with its probe.

**A. `Logs/taint.log` via the `taintLog` CVar (new, strongest).** The binary carries the CVar with its help text ("2: Log tainted reads and writes of global variables") and the write-side line format `Tainted value written to %s %s by %s - %s`, i.e. `Tainted value written to global <NAME> by WoWAI - Interface/AddOns/WoWAI/WoWAI.lua:N`. Every global write from addon code is tainted, and the *name* of the global is any Lua string, so the payload is the variable name. No server, no chat line, no pixels, nothing the player sees. Flush timing looks prompt: this logger family (`gx.log`, `QuestCache.log`, `taint.log` all use the same "Opened for Append" writer) put "App is background 09:55:49.912" on disk with file mtime 09:55:50 while the client was still running. Unverified: whether `SetCVar("taintLog")` is allowed from addon code (fallback: the player sets `/console taintLog 2` once and lives with the noise from every addon's global writes), the maximum name length one line will carry, and whether the bridge can `fs.watch` the file while the client holds it open. Newlines must be escaped (one line per write). Probe:

```
/run SetCVar("taintLog","2"); _G["WOWAI-PROBE-"..time().."-"..string.rep("x",3000)]=1; SetCVar("taintLog","0")
```

then `grep -c WOWAI-PROBE "/Applications/World of Warcraft/_classic_beta_/Logs/taint.log"` immediately and check the line is intact at 3 KB.

**B. Chat log without the server: `LoggingChat(true)` + `SendSystemMessage("...")`.** Row 6 rejected the chat log because whispering yourself routes through Blizzard. `SendSystemMessage` (present in this binary, `Usage: SendSystemMessage("message")`) injects a CHAT_MSG_SYSTEM locally and never leaves the machine. Unverified: whether system messages are written to `Logs/WoWChatLog.txt` (the file does not exist here yet, so chat logging has never been on), the flush cadence (combat-log live logging suggests seconds), the per-line size cap, and whether a `ChatFrame_AddMessageEventFilter` that hides the line from the chat frame also hides it from the log (the C-side logger probably runs first). The line is visible in chat unless filtered. Probe:

```
/run LoggingChat(true); SendSystemMessage("WOWAI-PROBE-"..time().."-"..string.rep("y",1000))
```

then `tail -c 300 "/Applications/World of Warcraft/_classic_beta_/Logs/WoWChatLog.txt"` at 1 s, 5 s, 30 s.

**C. `Logs/AddOnLoad.log` via `addonLoadDebugging` (weak).** CVar help text: "1: Enable addon load logging to AddOnLoad.log"; line formats `Loading AddOn (Mode: %s, Chain: %s): %s` and `Error(%s): %s`. If a `C_AddOns.LoadAddOn("<any string>")` for a missing addon logs the requested name, the name is the payload. Unverified whether a missing addon is logged at all. Probe: `/run SetCVar("addonLoadDebugging","1"); C_AddOns.LoadAddOn("WOWAI-PROBE-"..time())` then grep `Logs/AddOnLoad.log`.

**Confirmations of the table from the binary and the file system.** `LoggingCombat`/`LoggingChat`, `SaveBindings(1||2)`, `SetBinding("KEY"[,"COMMAND","CONTEXT"])`, `CreateMacro(name, iconFileName, body, perCharacter)`, `C_CVar.RegisterCVar`, `C_EditMode.SaveLayouts`, `SetChatWindowName` all exist. `Errors/*.txt` are crash dumps from `Blizzard Error.app` (C++ asserts), not Lua errors; no Lua error file exists. Every AccountData cache (`config-cache.wtf`, `bindings-cache.wtf`, `chat-cache.txt`, `layout-local.txt`, `click-bindings-cache.txt`, Edit Mode) carries an mtime equal to a `/reload` or logout instant (the `EditMode.log` "Saving" timestamps and `QuestCache.log` "Opened for Append" lines are the same list), so none of them flush mid-session; `Config.wtf` likewise. `QuestCache.log` is written live with the quest ID of every uncached `C_QuestLog` lookup (`id=N r=IsComplete`), which is technically an addon-chosen integer per line, but it spams the server and carries a few bytes per call: not a transport. `C_Log.LogMessage` remains as row 2 describes; note `DeveloperLog.log` (its likely sink, `Blizzard_DeveloperLog`) is 0 bytes here and the binary contains "Developer Log encountered an error and was prevented from opening", which may be the error the user saw.
