# Task: addon <-> bridge version handshake (distribution step 3)

Repo: rdimascio/wow-ai. Live checkout `/Users/ryan/wow-ai` runs the bridge (LaunchAgent `io.claudewow.bridge`); never develop there. Make your own worktree from `origin/main`.

## Goal
The player and the bridge both learn, at every hello, whether the in-game addon and the running bridge are compatible, and the side that is out of date is named in plain words. This must exist before the first CurseForge release: once CurseForge updates the addon on its own schedule and the bridge updates separately, mismatches become normal.

## Context (already done)
- Step 1 (PR #52, draft): `.pkgmeta` + `.github/workflows/release.yml`. A `v*` tag packages `ClaudeWoW/` for CurseForge (Classic and Forever) and attaches the bridge binaries. The `version` job checks `package.json` version == `ClaudeWoW.toc` `## Version` == tag.
- Step 2 (PR #53, merged): bridge-written files live in `Interface/AddOns/ClaudeWoW_Runtime/`; `ClaudeWoW/` is pristine.
- PR #46: the slot file carries an `acks` list; hello/forget/cancel are acked from it on clients whose signal files do not work (Classic Era).

## Design
- Two numbers:
  - **semver**: `package.json` version, also `## Version` in `ClaudeWoW.toc` (one source of truth, already CI-checked).
  - **PROTO**: an integer for the wire protocol between addon and bridge. Bump it only when a change breaks the other side. One constant in `bridge/protocol.js`, one in the addon (a field on an existing table: `ClaudeWoW.lua`'s main chunk is at Lua's 200-local limit; `tests/order_check.js` prints the count).
- **Addon -> bridge:** the hello record carries the addon's semver and PROTO as a new flag token. Read the semver with `C_AddOns.GetAddOnMetadata("ClaudeWoW", "Version")` (strings-check that Forever and Classic Era export it before relying on it; fall back to a constant the build keeps in sync, and test that the constant equals the toc).
  - Pick a token no existing flag uses. `v` is already the vision flag; read `parseFlags` in `bridge/protocol.js` and memory `claudewow-transport-budgets` before choosing.
  - An older bridge must ignore the token safely: check what `parseFlags` does with unknown tokens on a hello (a hello never reaches `runJob`, but verify).
- **Bridge -> addon:** every slot file and `Inbox.lua` gets `bridge = { version = "x.y.z", protoMin = N, protoMax = M }`. A missing field means an old bridge: say nothing, change nothing.
- **Verdicts:**
  - PROTO outside `[protoMin, protoMax]`: the bridge refuses that session's jobs with one clear error reply naming which side to update and how (CurseForge update / `claude-wow update` or `brew upgrade claude-wow`). The addon shows the same in the chat once per session.
  - Only semver differs: one soft line, once per session, no refusal.
  - Equal: silent.
- `/claude diag`, `claude-wow service status` and `npm run doctor` show both versions and the verdict.

## Rules
- Read first: memories `addon-bridge-roundtrip-rules`, `claudewow-transport-budgets`, `forever-client-modern-apis`, `classic-era-client`, `no-hot-installs`, `mutation-check-negative-tests`, `wow-ai-pr-checklist`, `flaky-e2e-gs-telemetry` (in `/Users/ryan/.claude/projects/-Users-ryan-wow-ai/memory/`).
- New slot field: add it to BOTH `TryLoadSlot` and the `Inbox.lua` path, with the 5-minute age rule on `Inbox.lua`.
- No slot load of its own: the verdict rides on the hello poll the addon already does.
- No code comments. One shell command per call. Conventional single-line commits, no attribution trailers.
- Tests: unit tests for the flag round trip, the slot field, all three verdicts, an old bridge (no field) and an old addon (no token); drive addon tests with `STUB.Tick()` only. Mutation-check each guard. Keep stub return counts equal to the real client's.
- CHANGELOG `[Unreleased]` entry and a docs/ARCHITECTURE.md update (hello flags, slot fields).
- Ship only through a merged PR, then update `/Users/ryan/wow-ai` to `origin/main` and run `node setup.js --wow <client>`. Never copy files into the game folder by hand. Ask Ryan before restarting the bridge or merging.
- Run a fresh-eyes review before you call it done.

## Done when
- PR open with CI green (rerun a macOS-only e2e flake once), the review findings fixed, and the merge left for Ryan to approve.
