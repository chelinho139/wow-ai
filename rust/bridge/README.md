# Rust bridge

The executable remains a scaffold. The library currently implements pixel payload
record/flag parsing and Lua 5.1 string escaping. It accepts current, unnamed-chat,
and pre-chat layouts, preserves embedded field separators in message text, and
distinguishes absent context from an explicit context reset.

Rust rejects IDs outside JavaScript's safe integer range instead of accepting
rounded values. This intentional validation difference does not affect normal
addon message IDs. Frame checksums and size validation are not implemented yet;
this parser accepts already decoded UTF-8 payloads, not raw screen captures.

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

Slot payload publication, capture, persistence, setup, and agent execution remain
unimplemented. See [the roadmap](../ROADMAP.md) for the release contract.
