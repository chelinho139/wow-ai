# WoW AI Reforged contributor instructions

## Implementation direction

- Implement and maintain the desktop bridge in Rust under `rust/bridge/`.
- Keep the legacy JavaScript bridge under `bridge/` so this fork can continue receiving and reconciling upstream updates. Its presence does not make it the implementation target for Reforged features.
- Do not implement Reforged bridge features in the legacy JavaScript bridge unless the user explicitly requests it. Study upstream changes there and port relevant behavior to Rust.
- Keep shared addon behavior in `addon/WoWAI/` compatible with advertised bridge capabilities. Never show a configuration as applied when the active bridge cannot support it.
- Use Rust bridge configuration and documentation for Reforged setup; do not direct users to legacy `bridge/config.json` for Rust-only features.

## Working agreements

- Inspect the actual addon, transport and adapter paths before editing. Preserve chat data, game links, commands, pixel transport and reply slots.
- Execute clear, reversible implementation and verification steps autonomously. Keep changes reviewable and do not revert unrelated work.
- Use bounded native subagents when independent work materially improves throughput. The coordinating agent owns integration and final verification.
- Add meaningful regression coverage for changed behavior. Run the affected Rust tests and appropriate addon checks; report any checks that require the game client.
- Keep upstream compatibility fixtures and JavaScript reference tests intact unless their changes are explicitly needed for a sync. Add Rust-specific tests for Reforged features.
