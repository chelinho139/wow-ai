# UI redesign validation

Implemented in native addon frames, without new dependencies or polling:

- Header conversation title, agent selector, chat picker, conversation menu and labeled connection state.
- Per-chat model/effort selection from versioned Rust bridge capabilities. Reset inherits defaults. Unavailable backends are disabled with a reason. Codex low effort is labeled Light. Slash agent selection remains available.
- Rust bridge validates advertised configuration, constructs adapter arguments, returns selected effective configuration, and starts a fresh session when configuration changes. Existing in-flight and resent requests retain their configuration.
- Older bridges retain agent switching. Model/effort controls are unavailable without capabilities; saved overrides block sending rather than silently falling back.
- Reconnect and recovery explanation beside the composer; offline drafts survive. Enter sends; Shift+Enter inserts a newline. No cancellation control because no verified cancellation protocol was added.
- Quiet message surfaces, bounded reading width, speaker/time metadata, structured bridge summaries with full reply copy, and a source copy action for the first detected external URL. Unstructured replies retain original text. Source recognition is syntactic, not a trust assertion.
- Scroll position is retained when reading history; near-bottom readers follow updates. New reply action returns to the bottom. Resize preserves scroll offset, not a semantic message anchor.
- Rail preference persists. Automatic compact layout below 780 frame units; chat picker toggles history. Secondary actions use conversation menus. Settings exposes configured defaults and selectable diagnostics. Global defaults are edited in the Rust configuration passed with --config.

## Verification

`NODE_PATH=/Users/leozitor/Projects/wow-ai-reforged/node_modules npm test` runs the repository suite using existing dependencies from the main checkout. `cargo test --workspace` covers Rust validation, arguments, capability serialization, session changes and fake-agent pixel requests. Added real-Lua addon tests for overrides, resend snapshots and scroll preservation. `git diff --check` checks whitespace. No in-game client is available in this checkout.

## Required in-game checks

- Wide/narrow windows and UI scales: selector truncation, popover scroll, rail, fonts and bright/dark scenes.
- Reconnect a stopped bridge and send the original draft; verify acknowledgment before waiting state.
- Two chats with different agent/model/effort; inspect bridge invocation and final reply. Reset, missing executable, rejected pair, active request and new backend session.
- Enter/Shift+Enter, Escape, focus on reopen and shift-click item/spell/quest links. Existing link hooks remain intact.
- Long replies, structured summaries, source copy and reading older history during arrival/resize.
- Combat: opening, resizing, sending and link insertion; no protected actions were added by this redesign.
- The supplied screenshot's clipped message could be an ordinary scroll position; client reproduction remains needed. “Screen Captured” was not found as addon-owned feedback and was left alone.

## Limits

Model/effort alternatives are configured capabilities, not live provider account discovery. Adapters besides Codex currently expose model choices only. No real provider call or live WoW visual test was performed. Rust reload-outbox input is an opt-in preview configured with `saved_variables`; see `rust/bridge/README.md` for handshake and freshness requirements. A new addon used with an old bridge cannot apply saved model/effort overrides until reset or a bridge upgrade.
