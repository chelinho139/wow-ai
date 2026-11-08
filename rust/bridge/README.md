# Rust bridge

The executable remains a scaffold. The library currently implements pixel payload
record/flag parsing, Lua 5.1 string escaping, basic-chat slot serialization, and
per-file atomic publication to an explicitly installed addon tree, and WAV
acknowledgement/reply-ready/activity/presence signal operations. It accepts current, unnamed-chat,
and pre-chat layouts, preserves embedded field separators in message text, and
distinguishes absent context from an explicit context reset.

Rust rejects IDs outside JavaScript's safe integer range instead of accepting
rounded values. This intentional validation difference does not affect normal
addon message IDs. The record parser accepts already decoded UTF-8 payloads. The separate frame module
validates magic, length and Fletcher checksum from a top-down RGB buffer, and searches
the legacy 0..8-pixel offset window. Native screen capture is not implemented yet.

## Compatibility tests

Run `cargo test --workspace --locked` from the repository root. Committed golden
fixtures compare with the existing Node protocol without requiring Node at Rust
test time or runtime. They cover all ASCII control characters, Unicode, older
record formats, agent flags, context clearing, and malformed records.

After reviewing an upstream protocol change, regenerate the fixtures from the
repository root with:

```sh
node rust/bridge/tests/generate-fixtures.cjs
cargo test --workspace --locked
```

Review the fixture diff before committing it. Generation uses the legacy
implementation unchanged; fixture changes are compatibility decisions.

Run `node rust/bridge/tests/validate-slot.cjs` for a Lua VM round trip of Rust-generated
slot output (requires `npm ci` for development tooling). CI also checks regenerated
fixtures against the committed Node reference.

Publication requires preinstalled regular Inbox.lua files for the main addon and
each configured slot. It checks all targets before writing, then replaces files
individually using unique sibling temporary files. A returned report lists every
success and failure; the broadcast is not a multi-file transaction. The caller must
provide consistent UTC timestamp/epoch values and enforce exclusive ownership of
the addon tree. The public library is not connected to the CLI yet.

Capture, runtime ownership locking, persistence, setup, and agent execution remain
unimplemented. See [the roadmap](../ROADMAP.md) for the release contract.

Signal operations require installed files and report per-file failures. Presence
returns the proposed next counter; scheduling and persistence are not implemented.
Pools of 50 or fewer presence files are rejected to avoid clearing the active beat.
See [Windows testing](../WINDOWS-TESTING.md) for native Windows checks.

Frame fixtures come from the real addon Lua encoder. Regenerate them with
`node rust/bridge/tests/generate-frame-fixtures.cjs` after reviewing codec changes.
`cargo test --test frame_compat` covers Unicode, invalid UTF-8 replacement, empty and
3200-byte payloads, channel thresholds, padding, offsets, corrupted frames and invalid
buffer geometry. The frame module is OS-independent and uses no image dependencies.
