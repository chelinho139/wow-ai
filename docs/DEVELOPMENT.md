# Local development

Develop and test the whole loop — addon, screenshot transport, bridge, agent,
slot delivery — on your machine, without World of Warcraft and without touching
a live install.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Starts a sandbox, a real bridge, and a headless game client. Type messages; watch replies. `:help` lists the console commands. |
| `npm run dev -- --fresh` | The same, from a clean sandbox. |
| `npm run dev -- --speed 8` | The game clock runs 8× faster, so the addon's 40 s retries and 120 s give-ups happen in seconds. |
| `npm run dev -- --real-agent` | Uses your real `claude` CLI in the sandbox project, with your real `HOME` so it can log in. It uses your plan quota and writes its session files to `~/.claude`. |
| `npm test` | Unit tests (Node). `npm run test:bun` runs them on Bun. |
| `npm run test:e2e` | End-to-end scenarios: the real addon and the real bridge, in a sandbox. |
| `npm run check` | Both suites. Run it before you push. |
| `npm run doctor` | A read-only health check of the **live** install. `--json` for machines. Exit 0 healthy, 1 warnings, 2 failures. |

## What runs

```
dev/wow/client.js ── the real addon Lua (fengari) ──► PNG screenshot ──► Screenshots/
        ▲                                                                   │
        │ LoadAddOn reads slot files, PlaySoundFile checks .wav files       ▼
AddOns/ClaudeWoW_S###/Inbox.lua ◄── bridge/bridge.js (a real process) ◄── decode
                                            │
                                            ▼
                                   dev/fake-claude.js (stream-json)
```

- **Sandbox** (`dev/sandbox.js`): a game client folder, a bridge home, a project
  folder and a fake user home, all under `.dev/sandboxes/<name>` (tests use the
  OS temp folder). The addon files are copied the way `setup.js` does it, and
  the 200 slots go in through the real `bridge/install-slots.js`.
- **Safety**: a sandbox name is letters, digits, `.`, `-` and `_` only, and
  its folder must be inside the sandbox root. `assertSafe` refuses any path
  that overlaps `~/.claude-wow`, `~/.claude`, `~/Library/LaunchAgents`,
  `~/Library/Logs/claude-wow`, the game folder, or the checkout the live
  LaunchAgent runs. The bridge runs with `HOME` and `CLAUDE_WOW_HOME` set to
  the sandbox and without `CLAUDE_WOW_SERVICE` (except `--real-agent`, above).
- **Game client** (`dev/wow/client.js`, `dev/wow/prelude.lua`): runs the
  addon's files in the order of its `.toc`, loads SavedVariables before
  `ADDON_LOADED`, and runs frames, timers and tickers on a real (or scaled)
  clock. It models the parts of the client the transport depends on:
  - `Screenshot()` renders the strip into a 1920×1080 PNG (or TGA) with the
    client's file name, then fires `SCREENSHOT_SUCCEEDED`.
  - `LoadAddOn` reads the slot's `.toc` and files from disk, once per UI
    session. It reports `MISSING`, `DISABLED` (client option `disabled`) and
    `INTERFACE_VERSION` like the client. Addon folders are indexed at launch,
    not at `/reload`.
  - Alt+Z (`:hide`) hides `UIParent`, so the strip and its `OnUpdate` stop.
  - `PlaySoundFile` is true only when the `.wav` file exists.
  - `/reload` and logout write SavedVariables in the client's format. A crash
    does not.
- **Fake agent** (`dev/fake-claude.js`): speaks Claude Code's stream-json. Its
  usage totals carry across `--resume`, like the real CLI. Directives in a
  message change its behaviour:

| Directive | Effect |
|---|---|
| `[[sleep 5]]` | Answers after 5 s. |
| `[[tools 3]]` | Emits 3 tool calls first (heartbeats in game). |
| `[[hang]]` | Never answers. |
| `[[crash]]` | Exits after start with no result. |
| `[[error]]` / `[[error text]]` | An error result, with or without text. |
| `[[rate-limit]]` / `[[auth]]` | The usage-limit and login errors. |
| `[[reply text]]` / `[[long 200]]` | A fixed reply, or a long one. |

Every call is logged to `<sandbox>/agent/calls.jsonl`.

## Writing a scenario

```js
const H = require('../../dev/harness');
const h = await H.start('my-case', { root: os.tmpdir(), client: { speed: 8 } });
const reply = await h.client.say('hello [[sleep 2]]');
await h.bridge.crash(); h.bridge.start(); await h.bridge.ready();
h.client.reload();
await h.close();
```

`beforeLaunch(sb)` prepares disk state before the bridge and the game start:
seed SavedVariables, stale signal files (`SB.seedStaleSignals`), a corrupt
`state.json`. A known gap is a test with `{ todo: 'why' }`: it runs, it
reports, and it does not fail the suite. When the gap is fixed, remove `todo`.

## Limits of the model

- fengari is Lua 5.3; the client is Lua 5.1. `tests/order_check.js` parses the
  addon as 5.1, but a 5.3-only call can still pass here and fail in game.
- Frame timing is 20 frames a second, not the client's frame rate.
- Timers, tickers and `OnUpdate` run in a simplified order.
- SavedVariables are written in the client's shape, but not byte for byte
  (no `-- [n]` markers).
- `--speed` scales only the game clock. The bridge and the fake agent run in
  real time.
- WoW's own file caching and its handling of two screenshots in one second are
  modelled on a best guess. Confirm transport changes in game.
