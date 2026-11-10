# Rust backend execution roadmap

Status: the Rust bridge preview implements native setup/capture, the live adapter
pipeline, durable pixel/SavedVariables reload admission and crash-safe acknowledged
chat deletion and validated per-chat project-folder selection.
Initial in-game chat was user-reported, and Windows CI runtime evidence is recorded
below; full Windows in-game fallback/reconnect acceptance, broad feature parity and
performance measurement remain open. Updated 2026-11-10.

Current verified summary:
- Working folders resolve from the configured project or home directory, are
  canonicalized before launch, and participate in per-chat session identity. Fake
  provider tests cover all six adapters, restart, invalid paths, default reset,
  and original-folder recovery through pixel/reload retries.
- Reload and pixel delivery share exact durable admission after recent-ID pruning;
  crash-boundary recovery republishes terminal state without rerunning providers.
- Deletion survives every tested cross-file transaction crash boundary without
  resurrection, preserves unrelated chats and uses explicit operation receipts.
- PR #6 merged as `d7385a8`. Its Windows job passed the Job Object owner/descendant
  runtime test (`abrupt_bridge_death_terminates_agent_and_descendant`):
  <https://github.com/leozitor/wow-ai-reforged/actions/runs/42815209010/job/129826435044>.
- That CI evidence proves Windows process containment, not live WoW capture,
  fallback, handoff or reconnect behavior; those remain manual acceptance work.

Canonical repository roadmap: rust/ROADMAP.md. Technical proposals below remain
subject to validation during implementation; this document is not a claim of
completed implementation, independent review, or measured performance.

## Requirements summary

Confirmed by the user:
- Develop an independent Rust backend while preserving a working legacy Node implementation.
- Keep receiving changes from the original wow-ai repository.
- First release target: Windows 11 x64 (Intel/AMD). The user has a matching PC available for live WoW testing; no remote access or completed live validation is implied. Structure shared logic so Linux/macOS can follow.
- First usable Rust milestone: Windows and basic chat with every existing Node agent: Claude Code, Codex, Grok, Antigravity (agy), and Hermes.
- Gemini is also requested. Google Gemini CLI is the proposed interpretation; it is a new adapter, not part of existing Node parity. Confirm its exact CLI contract from official documentation before implementation.
- Other features can be added incrementally.
- The Windows Rust backend must install and run as a standalone executable without Node, Python, or PowerShell helper scripts. External agent CLIs retain their own prerequisites.
- Start with fresh Rust chat history and agent sessions. Preserve legacy configuration,
  history, and sessions; no legacy data import is included in the first release.
- Aim for lower resource use; no measured baseline or numerical target exists yet.

Historical starting point: the initial scaffold contained root Cargo.toml,
rust/bridge/src/main.rs, separate Rust CI, upstream remote configuration, and
FORK.md sync guidance. The implementation milestones later in this document
supersede that scaffold-only state.

First-release contract and technical approach:
- Keep the shared Lua addon and current pixel-out / slot-file-in transport, including
  its automatic SavedVariables/Inbox.lua reload recovery when pixel retries fail.
- Support connect/hello, all required agent selections, send/reply, acknowledgement and presence,
  agent errors, timeout/shutdown, and deduplication across retries and transports.
  Interrupted runs must not be relaunched automatically when agent side effects are
  uncertain; exactly-once external agent side effects are not promised.
- Provide native Rust setup/slot generation, screen capture, process management, and
  configuration commands. No Node, Python, or PowerShell helper scripts may be required
  for backend installation or runtime. Automatic game-location discovery can follow.
- Bundle required addon assets and the primer into the executable so setup can extract
  them without a source checkout or separately installed scripting runtime.
- Reject unsupported options/agent selections clearly; do not silently drop user requests.
- Persist new Rust conversations and their agent/session identity across bridge restarts,
  using Rust-owned files. Start fresh sessions when switching agent or project folder.
  Never resume a legacy session automatically.
- Do not label maps, macros, multiple concurrent chats, addon history restoration, permission
  escalation UI as supported until their acceptance tests pass. Agent selection and
  adapter-specific permission enforcement are part of the initial release contract.
- Existing upstream addon behavior must be checked for safe handling of the reduced
  capability set. Any unavoidable addon change needs a separate compatibility decision.

## Evidence and implementation boundaries

- Legacy runtime: bridge/bridge.js:450 (submission), :487 (queue), :496 (agent run),
  :692 (completion), :755 (capture). Preserve npm start throughout migration.
- Wire semantics: bridge/protocol.js:117 (flags), :135 (pixel records), :156 (reload
  outbox), :293 (Lua escaping), :306 (slot payloads). These are compatibility references.
- Agent behavior: bridge/agents.js:63, :109, :223, :279, :316 (stream parsers),
  :567 (executable resolution). The AGENTS registry at bridge/agents.js:342 lists
  claude, codex, grok, agy and hermes; there is no Gemini adapter. Port all five
  existing adapters and add Gemini separately against its documented CLI contract.
- Publication and persistence: bridge/bridge.js:128 (transcripts), :223 (atomic
  writes), :309 (publication), :341 (signals), :370 (presence).
- Current Windows capture: bridge/capture.ps1. Installer: setup.js and
  bridge/install-slots.js. Use these as behavior references, not a requirement to keep
  their runtimes in the eventual Rust distribution.
- Existing validation: tests/bridge_test.js, tests/agents_test.js,
  tests/restore_test.js, tests/codec_test.js, tests/setup_test.js.
- Legacy live injection calls a real agent (tests/inject_test.js:33); add deterministic
  fake-agent integration coverage for Rust instead of requiring login in ordinary CI.

Proposed Rust modules under rust/bridge/src/: protocol, config, storage, runtime,
agents, capture, install. Keep main.rs limited to command entry and lifecycle.
Do not pre-create module hierarchies that are not used. Choose libraries from actual
requirements and official documentation during each stage; dependencies remain an
explicit decision, not an assumption in this plan.

## Execution stages and acceptance gates

### 1. Freeze the Windows MVP contract and record a baseline

Validate the proposed Google Gemini CLI integration and record the live WoW client build.
Fresh Rust state with no legacy import is the agreed migration policy. Windows 11 x64 is the selected initial target; use the available user PC for
live validation when the implementation is ready. Standalone installation/runtime is
already required. Define supported vs deferred addon flows in a compatibility checklist
under rust/, including how existing addon chats behave when changing backends without
importing or deleting legacy history.
Include automatic pixel-to-reload recovery in the MVP checklist. Define a backend
handoff procedure: stop accepting work, drain or explicitly interrupt pending runs,
stop the previous bridge and its capture process, then start the next backend.
Specify how shared Inbox/slot, acknowledgement, completion and presence files are
reconciled before accepting fresh work. Preserve each backend's private state; do
not import legacy sessions to solve transport handoff. Document whether a reload or
full game restart is required if live switching cannot safely clear cached signals.

Record legacy bridge plus capture CPU, total working set, startup time, and local
message-to-dispatch / completion-to-publication latency. Exclude agent process cost
from bridge metrics and report it separately. Use the same machine, client, capture
interval, idle duration, and fake-agent workload for later comparison. Record p50/p95
latency with sample counts; agree numeric budgets after baseline collection.

Gate: written capability checklist, repeatable benchmark recipe, baseline results,
and agreed performance budgets. The user has a Windows 11 x64 test PC available, but measurements have not been
collected. Leave the measurement gate pending until results are captured; local
macOS checks cannot substitute for it. Protocol and fake-agent implementation may
proceed after the contract and benchmark recipe are defined; pending Windows baseline
measurements block performance claims and release evaluation, not independent local work.

### 2. Port the minimum protocol and file publication

Implement parsing, validation, Lua serialization, dedup identifiers, slot selection,
and acknowledgement/presence files. Include safe SavedVariables outbox parsing and
Inbox.lua publication for reload recovery. Use one idempotency key across pixel and
reload delivery, scoped to the addon session token and message ID; keep the agent's
session identity separate. Define retention and stale-outbox rejection so an old
request cannot become runnable merely because its dedup entry was pruned.
Derive golden cases from legacy tests without
altering the reference implementation. Compare parsed Lua tables where timestamps or
field ordering make byte comparison inappropriate. Never execute SavedVariables as code.

Gate: valid and malformed fixtures pass; Unicode, separators, invalid lengths,
escaping, duplicate records, stale outboxes, cross-transport key equivalence and slot
wrapping are covered. Generated slot and Inbox.lua files load
in the existing Lua test harness. Legacy npm test still passes.

### 3. Run basic chat without a game

Implement explicit config/path handling, a shared agent process runner, all five legacy
adapters plus the requested Gemini adapter, bounded process output,
stdin/stream handling, timeouts, and Windows process-tree termination. Keep permissions
at least as restrictive as each configured legacy adapter; define Gemini permission
semantics from its official CLI contract. Never fall back to bypass mode.
Add deterministic injected input using a fake agent executable and a temporary addon tree.
Add exclusive ownership of the output directory before any runtime writes; do not claim
cross-backend locking until the legacy backend participates or another verified mechanism
prevents concurrent ownership. Use a separate Rust data directory; do not read/import
or overwrite legacy state.json or transcripts.json. Missing Rust state creates a fresh
history and session store. Preserve new Rust sessions across restarts; broader addon
history restoration remains deferred.

Persist a job lifecycle before acknowledging acceptance: accepted, launch-intent,
completed (including reply/error), and interrupted. Persist launch intent before
spawning an agent. After a crash, accepted jobs without launch intent may run;
launch-intent jobs without a durable completion become interrupted and require an
explicit new request to retry. Report uncertain side effects clearly. Persist the
completion before publishing its reply and completion signal; replay publication
after restart without rerunning the agent. A failed acceptance write must not launch
or acknowledge the job. Define recovery for orphaned agent processes before new work
is allowed. These rules also apply to requests received through reload recovery.

Gate: injected message produces a readable reply; malformed streams, absent CLI,
timeout, process exit, shutdown, Unicode/space-containing paths, duplicate messages,
and competing ownership have deterministic integration tests. No lost or corrupt
previous state on a failed write. Permission flags match each adapter contract.
Inject crashes before/after acceptance persistence, acknowledgement, launch-intent
persistence, agent launch, completion persistence, and reply/signal publication.
After restart, assert that completed jobs republish without another agent run,
uncertain jobs report interruption without automatic replay, and unaccepted jobs
remain retryable. Replay the same request through pixels and SavedVariables, both
before and after restart, and verify one accepted job. Exercise stale outboxes and
orphan cleanup. Test the handoff procedure against temporary shared transport files;
a Rust-only lock must not be presented as protection against an unmodified Node bridge.
Every required adapter passes fixtures for argument construction, prompt delivery,
output parsing, progress/reply handling, and failure behavior. Preserve adapter-specific
session resume parsing even if broader history restoration is deferred. Mock coverage
is mandatory in CI; record an authenticated Windows smoke test for each required
agent before advertising it as supported. Missing access is an explicit release gap.
Adapters may be implemented sequentially, but an intermediate single-agent build
does not satisfy the all-agent milestone. Seed legacy state/history fixtures, run Rust
startup and chat tests, and assert their hashes remain unchanged. Verify Rust restarts
resume only Rust-created sessions with the same agent and project identity.

### 4. Add native Windows capture and prove the playable milestone

Implement a Windows-specific capture module with the current decoder semantics and
DPI/client-area handling. Replay synthetic images from codec tests before live testing.
Provide a native Rust setup/slot-generation command for an explicit game location.
Extract bundled addon assets and primer from the executable. Do not invoke legacy
setup.js, capture.ps1, Python capture scripts, or a shell interpreter as a backend helper.
Launch agent executables directly; resolve Windows launchers without introducing a
scripting-runtime requirement beyond each selected external agent’s prerequisites.

Gate: on Windows 11 x64 with the recorded live client build, install, connect, send, acknowledge,
receive a reply, timeout, stop, and restart successfully. Test borderless/windowed modes,
window movement/DPI behavior, missing/minimized game window, invalid frames, and agent
failure. Verify agent selection reaches the requested executable and that switching
agents cannot reuse a session belonging to another provider. Unsupported features produce clear behavior rather than false success.
Force pixel retries to expire and verify automatic reload recovery delivers the
reply without duplicate agent execution. Exercise Node → Rust → Node with WoW open:
verify no stale reply is attributed to new work, stale acknowledgements/completion
signals cannot suppress a new request, and presence advances for the active backend.
Use the documented stop/drain/start procedure; if cached transport state requires a
reload or full restart, verify and document that requirement before the gate passes.
Publish an exact supported-feature list. Re-run stage 1 benchmarks and assess agreed
budgets. A passing CI build alone does not prove capture works in the game.

### 5. Package the Windows preview

Produce a standalone release executable with embedded shared addon assets and primer,
plus sample config and install/troubleshooting instructions. List any external agent requirements
separately from the backend's own requirements. Keep the Node entry point available.

Gate: clean Windows install succeeds using only documented prerequisites; no repository
checkout, Rust toolchain, Node, Python, or PowerShell helper is required for backend
setup or runtime. Verify installation, capture and a fake-agent round trip on a clean
Windows environment without those helper runtimes; then test real agents with their
prerequisites installed separately. Switching back to Node preserves its
existing configuration and history and passes the stage 4 transport handoff checks.
Publish the handoff and interrupted-job recovery instructions. Record release
smoke-test evidence.

### Chat reconciliation prerequisite: durable deletion before history restoration

The Rust/addon deletion slice is implemented and covered by automated crash recovery
tests. It remains a prerequisite rather than a claim of complete two-way history
synchronization; backend-originated deletion and live in-game reconnect acceptance
are still outside the completed contract.

Current behavior: the addon stores pending deletions in `WoWAIDB.forget`, retries
them until it receives the exact durable Rust receipt, clears deleted outgoing work
and rotates the cleared last chat's identity. Rust persists deletion intent, removes
private history/session/pending state, clears retained replies, republishes all slots,
persists completion and then acknowledges the stable addon operation ID. Startup and
ticks resume interrupted deletion work before accepting conflicting traffic.

Implemented contract and retained boundaries:
- Preserve a pending deletion (a tombstone) until the bridge explicitly acknowledges
  that exact operation after durable cleanup. Presence alone is not confirmation.
  Keep older bridge compatibility capability-gated; do not advertise stronger
  guarantees for the legacy acknowledgement path.
- Make deletion retries idempotent across reconnects and restarts. Specify operation
  identity, ordering and tombstone retention before implementation. A stale restore,
  delayed request or late reply must not recreate a deleted conversation.
- Reconcile history, session references, retained replies and any pending publication
  or recovery records. Define behavior when deletion races an in-flight request;
  deleting bridge references does not imply erasing an external provider's own data
  or cancelling its process. Preserve the no-automatic-replay side-effect policy.
- Define explicit backend-originated deletion separately from missing backend files,
  reset, retention eviction and switching backends. Missing state must not implicitly
  delete the addon's visible conversation. A deliberate backend deletion needs a
  durable, acknowledged event before two-way deletion is advertised.
- Handle the last-chat behavior explicitly: the addon currently clears and reuses
  its ID. New messages survive delayed deletion retries because the addon rotates
  the cleared chat to a fresh collision-free identity.
- Keep Rust and legacy private stores separate. Do not turn reconciliation into
  automatic legacy import, cross-backend deletion or a general history merge.

Automated gate: deterministic addon and Rust integration tests cover offline deletion followed
by reconnect; duplicate deletion; restart before/after cleanup and acknowledgement;
presence without acknowledgement; partial cleanup failure; stale restore and late
reply; an in-flight request; last-chat reuse; and reset versus explicit backend
removal. Verify no resurrection, no silent loss of new messages, and no provider
relaunch. Add focused parity inventory entries only for implemented test seams;
use strict expected failures only with narrow observable gap evidence. Validate
pixel delivery and the reload recovery path with deterministic integration tests.
In-game reconnect and deletion checks remain required before advertising the
in-game guarantee.

### 6. Expand parity, then platforms

Add addon history restoration, optional legacy import as a separately scoped feature,
multiple chats/concurrency,
game context/links, map/macros, and permission retry UI as
separately tested slices. Ordering follows actual user needs after the MVP.
Add macOS/Linux capture modules behind platform boundaries; determine X11/Wayland
scope before promising Linux coverage. Maintain shared logic checks on all three OSes.

Gate per feature/platform: focused tests plus an updated capability checklist; live
capture proof for each supported platform. Do not switch the default backend until
its advertised capabilities, installation and recovery paths are verified.

## Risks and mitigations

- Upstream merges cleanly but changes transport semantics: review protocol/addon changes
  explicitly and rerun differential fixtures after each sync (FORK.md).
- Platform abstractions become speculative: implement shared protocol/process behavior
  first, and abstract capture only at the actual input/output boundary.
- Windows file sharing or process cleanup differs from Unix: run targeted Windows tests
  for replacement writes, ownership, process trees and paths before the playable gate.
- State compatibility is mistaken for automatic migration: keep separate state initially;
  any import requires version checks, backup, and explicit documented behavior.
- Rust reduces bridge overhead but not agent latency: benchmark bridge/capture separately;
  report measured results and avoid attributing external agent time to Rust.
- Scope grows into an addon redesign: preserve the current transport for the MVP and
  make incompatible changes a separate decision.

## Verification for each implementation slice

Run targeted Rust tests, cargo fmt --all -- --check,
cargo clippy --workspace --all-targets --locked -- -D warnings,
cargo test --workspace --locked, and cargo build --release --locked.
Run npm test for shared contracts and legacy regression coverage.
Windows/macOS/Linux CI establishes build/test portability; live game checks establish
capture correctness. Record evidence and unresolved gaps at every stage.

## Implementation follow-ups

- Treat Gemini as Google Gemini CLI; verify the CLI contract with official documentation
  before choosing invocation and permission behavior. Flag any mismatch with that interpretation.
- Record the exact live WoW client build during Windows validation.
- Agree numerical resource/latency budgets after measuring the legacy baseline.
- Select and justify Rust dependencies when requirements call for them; no library
  choices or new dependencies are approved by this plan alone.

No delivery dates or performance gains are promised. The implementation notes
below are chronological milestones, not the current status of every feature.

The initial scaffold was completed. Stage 2 added pixel record/flag parsing and Lua
string escaping, basic-chat slot serialization, and per-file atomic publication.
Node-reference fixture comparisons and Lua VM checks pass locally. Runtime ownership
locking and the remaining stage gates are still pending. Pure RGB frame decoding
now has tests based on the actual Lua encoder; native screen capture remains pending. WAV signal
operations and presence/activity logic now have tests, with a Windows testing guide
in rust/WINDOWS-TESTING.md. Scheduling and persisted counters are not implemented; no stage is claimed complete.

Stage 3 now has a runnable `inject` command, strict JSON config, Rust-private state,
exclusive data ownership, six provider adapters, process/output limits, persistent
Rust sessions, completion-publication recovery, and a six-fake-agent `self-test`.
Integration tests cover timeouts, inherited pipes, malformed output, publication
recovery and legacy preservation. Windows builds run `self-test` before upload.
Authenticated agent checks, shared addon ownership, and live capture remain open.

Stage 4 now has a native `setup --wow <client-directory>` command with embedded addon
assets and slots, preserving existing runtime data and checking static assets.
Tests verify byte-for-byte equivalence against the legacy installer in isolated trees.
Windows builds smoke-test setup before upload.

Stage 4 also implements native Windows screen capture via Win32 GDI `BitBlt` and the
`wow-ai-reforged run --config <file> [--wow <client>]` live bridge loop. It attaches to
`Wow.exe`, captures the pixel strip, decodes frames, dispatches to the agent pipeline,
and publishes slot replies and WAV signals. Synthetic frame tests and live CLI tests pass in CI.
Live in-game WoW validation on Windows remains open.

Live-loop hardening adds tested hello snapshots, complete configured-agent lists,
periodic idle/busy presence with persisted counters, recent message deduplication
across restart, and target-bound pending-reply recovery. Unknown/uninstalled agents
produce explicit errors. Publication reports are checked before completion is
cleared. At that milestone SavedVariables polling was not yet connected to the live
loop; the reload recovery milestones below supersede that limitation. Windows FFI
lint and GDI bitmap synchronization issues from the initial capture commit are
corrected.

Agent discovery now mirrors the legacy backend: configured paths take precedence,
then environment overrides, known install locations and PATH/npm launchers are
searched. Setup records discovered commands using JSON serialization, preserves
existing config, and prints installation guidance for missing agents. The `agents`
command provides a read-only diagnostic report; agent installation and login remain
separate. All six adapters use the same resolver; no shell launcher is executed.

Current lifecycle checks cover explicit Ctrl+C shutdown, idle detection, crash
expiry, slot-only heartbeats, preservation of unread replies, and same-chat
reconnection. Native Windows console events and WoW caching still require live
validation. `setup --update-addon` backs up changed static files and preserves
runtime/configuration data. Initial in-game Codex chat and session continuation
were reported working by the user; this does not establish all-agent acceptance.


Historical reload recovery sequence (now implemented through live polling and
crash-boundary coverage) proceeded in these reviewable slices:
- Safe SavedVariables outbox parsing is the first slice, with Node-reference golden
  cases and malformed-input tests. Parsing never executes the saved Lua file.
- Before enabling live polling, add durable admission/launch-intent records and a
  persisted stale-outbox policy. The current 1,000-entry `handled_live` retention
  must not allow an old saved request to become runnable again after eviction.
- Wire file selection and bounded reads into the existing live loop, using the same
  request identity and dispatch path for pixels and reload input. Preserve request
  model/effort snapshots; reject unsupported overrides rather than dropping them.
- Exercise cross-transport retries and crash points before claiming reload recovery.

At that milestone the parser alone did not enable reload fallback. The later live
polling and durable admission milestones below supersede that historical limitation.
Chat reconciliation remains a separate prerequisite for history restoration.


Reload recovery preview now has opt-in `saved_variables` polling in the existing
live loop. It requires a fresh save and current pixel hello, and shares dispatch
with pixels. Durable exact admission intervals survive recent-cache eviction;
retained old IDs are migrated, but previously evicted IDs cannot be reconstructed.
An interruption snapshot is persisted before launch, and completion/error snapshots
are durable before publication. This deliberately treats even a pre-launch crash
after admission as uncertain rather than automatically retrying it.

Focused tests cover cross-transport duplicates, restart and old-cache eviction,
interruption error republication, freshness and session gating. At that preview
milestone, complete crash-point injection, Windows in-game fallback/handoff, orphan
process cleanup and account discovery remained open. Later milestones below close
the crash-point and Windows Job Object test seams, but not full in-game acceptance.

Subprocess crash coverage now exits without unwinding at eleven live-request
boundaries: before/after admission save, Working publication, acknowledgement,
agent exit, completion save, reply publication, completion signal, pending clear,
and error save/publication. Restart assertions verify exact durable admission,
correct Error/Done republication, and no repeated fake-agent invocation through
pixel or reload retries. Before-admission interruption remains retryable.

These checks alone did not cover an agent still running at bridge death, power-loss
filesystem durability, or every partial multi-file publication failure. The next
milestone adds Windows Job Object containment; Unix orphan containment, power-loss
durability and Windows in-game fallback/handoff remain open. The manual acceptance
recipe is in rust/WINDOWS-TESTING.md.

Windows provider lifetime containment assigns the bridge to a private
kill-on-close Job Object before provider creation. Assignment failure blocks
launch. A Windows-only integration test kills a running owner and waits on native
handles for its fake provider and descendant, avoiding PID reuse as test evidence.
PR #6 (`d7385a8`) ran this test on Windows CI successfully; the passing job includes
`windows_job_owner_child` and
`abrupt_bridge_death_terminates_agent_and_descendant`:
<https://github.com/leozitor/wow-ai-reforged/actions/runs/42815209010/job/129826435044>.
This is Windows runtime evidence rather than cross-compilation, but it is not full
in-game acceptance. Unix abrupt-death containment, earlier surviving providers from
old bridge versions, host job restrictions, authenticated provider compatibility and
Windows in-game fallback/handoff remain open. Never kill an arbitrary saved PID to
compensate for old versions.


Recovery review hardening: successful forget handling now clears that chat's
pending publication snapshot without removing its durable admission IDs. Terminal
validation errors are admitted and saved before publication, so restart or a
transport retry cannot reconsider the same rejected ID. Their transaction retains
acknowledged game context for the next valid request. Startup preserves cached
Working replies that have a matching durable recovery snapshot instead of briefly
publishing an incorrect generic interruption error. Reload polling caches only
successfully processed file versions; failed reads/parses/dispatch remain retryable.

Historical limitation: the initial forget fix did not make deletion a cross-file
transaction, so a crash between reply-cache and Rust-state cleanup still required
the tombstone/reconciliation work described next. That limitation is superseded by
the crash-safe deletion transaction below. Windows Job Object runtime acceptance is
now established by the PR #6 CI evidence above; live in-game acceptance remains open.

Crash-safe backend deletion now uses permanent, bounded tombstones. Intent and
private history/session/pending cleanup are one atomic state write; retained reply
cleanup and all-slot publication retry before completion is persisted and the
exact acknowledgment is sent. Startup and ticks finish interrupted work first.
Unseen requests for a deleted chat are consumed without recreating it, and repeated
forget records acknowledge completed cleanup idempotently. A six-boundary process
crash test covers before/after intent, cache cleanup, publication, completion and
acknowledgment, with unrelated chat preservation and stale transport checks.

The addon clears deleted outgoing work, rotates the cleared last chat's identity
without collisions, and waits for an explicit acknowledgment rather than presence.
Capacity and publication failures are tested as unacknowledged, retryable outcomes.
This supersedes the earlier cross-file cleanup limitation for accepted Rust
operations. Backend-originated deletion events, retention policy/management UI,
provider-side history deletion, and native in-game caching acceptance remain open.

Completed deletions also have structured Inbox/slot receipts keyed by chat, session
and a stable persisted addon operation ID. This closes the sound-disabled
acknowledgment path and prevents a stale reused WAV slot from confirming a modern
Rust deletion. Receipt support is detected from the snapshot field; older bridge
sound acknowledgments remain compatible. Tests cover mismatched session/ID,
reconnect identity, disabled sound, and stale WAV rejection.
