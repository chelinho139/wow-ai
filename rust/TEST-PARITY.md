# Rust to Node test parity

The machine-readable inventory is [tests/parity/manifest.json](bridge/tests/parity/manifest.json).
It records the Node reference, Rust probe (when executable), status, and rationale
for each reviewed behavior. Existing compatibility tests remain the active probes;
the inventory does not duplicate their assertions.

## Current inventory

| Status | Count | Meaning |
| --- | ---: | --- |
| Active | 9 | Existing Rust contract tests run in normal Cargo test suites. |
| ExpectedFailure | 0 | No currently registered probe has a documented expected failure. |
| Planned | 5 | Reference behavior is tracked, but there is no safe Rust seam yet. |
| IntentionalDifference | 0 | Rust deliberately preserves a stricter permission policy. |
| NeedsDecision | 0 | Unresolved compatibility decisions; these are never treated as requirements. |

`folder_selection` is Active. Its live integration probe sends a request through
`LiveBridge::accept_frame`, records the deterministic fake agent's working directory,
and verifies the requested per-chat folder and project identity are used.

`reload_outbox` is Active for the implemented live seam: SavedVariables and pixel
delivery share exact durable admission even after the bounded recent-ID cache is
pruned. `durable_deletion` is Active for all six cross-file transaction crash
boundaries, restart completion, unrelated-chat preservation and stale transport
suppression. These focused contracts do not claim full Windows in-game fallback or
reconnect acceptance.

The strict expected-failure classifier remains covered with synthetic contracts. It
rejects XPASS, wrong IDs/reasons, unexpected failures, empty evidence and missing
results without tying framework coverage to an active product gap.

Full Windows in-game reload acceptance, addon history restore, map commands, macros,
live summary extraction and permission retry remain outside the active contracts.
Reload polling, durable admission and deletion recovery now have focused integration
coverage. This does not imply every other area lacks
an observable pipeline seam: pending probes should be added where an approved
contract and narrow gap evidence are available. Permission retry is scheduled by
the roadmap; future grants must remain restrictive and adapter-validated.

The cwd recording scenario extends the existing explicitly fake `__fixture-agent`
command for test observation only; it does not invoke a provider or expand production
behavior.

## Reporting and validation

Normal `cargo test --workspace --locked` executes every runnable contract, including
the live folder probe. The Rust CI matrix additionally runs:

```sh
cargo test -p wow-ai-reforged --locked --test parity -- --nocapture
cargo test -p wow-ai-reforged --locked --test live_transport per_chat_folder_selection_uses_requested_directory -- --nocapture
```

The first command validates inventory IDs, statuses, references, and probe links,
then prints a deterministic status/rationale report with Node/probe references and separate totals. The second
proves per-chat folder selection through the live transport. Planned and intentional entries are reported,
not counted as tests.

When implementing a pending feature, retain the success assertions and fixtures and
set it Active only when the probe passes. Never convert an arbitrary failure into an
expected failure. Any new expected-failure entry requires explicit review of its ID,
exact reason code, evidence boundary, rationale and handled-probe registration;
XPASS remains a hard failure.

## Open decisions and limits

This inventory records Node behavior as evidence, not automatic Reforged
requirements. Planned entries need a product decision and a safe observable seam
before becoming executable contracts. Permission retry must respect Rust's restrictive policy; it is not classified as permanently out of scope.
The suite uses fake agents and temporary addon trees; it does not establish live
WoW client or Windows capture behavior.

Inventory validation rejects orphan `_is_known_gap` test declarations, unknown
fields, invalid status/reason combinations, and missing or ignored test references.
Any new expected-failure integration probe must follow that naming convention and use
the shared manifest expectation and assertion helpers. Source checks are deliberately
small and support the repository's top-level `#[test]` / `fn name()` style; they
are not a general Rust parser. Review must preserve this convention.
