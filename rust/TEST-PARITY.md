# Rust to Node test parity

The machine-readable inventory is [tests/parity/manifest.json](bridge/tests/parity/manifest.json).
It records the Node reference, Rust probe (when executable), status, and rationale
for each reviewed behavior. Existing compatibility tests remain the active probes;
the inventory does not duplicate their assertions.

## Current inventory

| Status | Count | Meaning |
| --- | ---: | --- |
| Active | 5 | Existing Rust contract tests run in normal Cargo test suites. |
| ExpectedFailure | 1 | The real live request probe reports only a narrow, documented Rust gap. |
| Planned | 6 | Reference behavior is tracked, but there is no safe Rust seam yet. |
| IntentionalDifference | 0 | Rust deliberately preserves a stricter permission policy. |
| NeedsDecision | 0 | Unresolved compatibility decisions; these are never treated as requirements. |

The executable expected failure is `folder_selection` / `unsupported_folder`.
Its integration probe sends a request through `LiveBridge::accept_frame`, first
checks for the desired reply and requested project identity, and accepts an XFAIL
only when the current request returns the exact unsupported-folder error, publishes its matching error reply in Inbox.lua, and Rust
state has no session or history side effects. The fake agent writes its working
directory to a temporary marker; the XFAIL also requires that marker to be absent,
proving the agent was not invoked. If support appears, the probe requires the
requested directory in the marker. The expectation is read from the manifest, so marking it Active enables normal success checks. Setup, publication, and other errors fail the
test. The classifier is pure and rejects XPASS, wrong IDs/reasons, unexpected
failures, and missing results.

Reload outbox parsing, addon history restore, map commands, macros, live summary
extraction and permission retry are Planned. This does not imply every area lacks
an observable pipeline seam: pending probes should be added where an approved
contract and narrow gap evidence are available. Permission retry is scheduled by
the roadmap; future grants must remain restrictive and adapter-validated.

The cwd recording scenario extends the existing explicitly fake `__fixture-agent`
command for test observation only; it does not invoke a provider. No missing bridge
feature is implemented here.

## Reporting and validation

Normal `cargo test --workspace --locked` executes every runnable contract, including
the live folder probe. The Rust CI matrix additionally runs:

```sh
cargo test -p wow-ai-reforged --locked --test parity -- --nocapture
cargo test -p wow-ai-reforged --locked --test live_transport per_chat_folder_selection_is_known_gap -- --nocapture
```

The first command validates inventory IDs, statuses, references, and probe links,
then prints a deterministic status/rationale report with Node/probe references and separate totals. The second
prints the observed XFAIL evidence. Planned and intentional entries are reported,
not counted as tests.

When implementing a pending feature, retain the success assertions and fixtures.
If the probe becomes satisfied, CI reports XPASS and fails. Remove only that case's
expected-failure marker, set it Active, and keep its probe active; run the focused
probe and full Rust checks. Never convert an arbitrary failure into an expected
failure. Any new or changed expected-failure entry requires explicit review of its
ID, exact reason code, evidence boundary, and rationale.

## Open decisions and limits

This inventory records Node behavior as evidence, not automatic Reforged
requirements. Planned entries need a product decision and a safe observable seam
before becoming executable contracts. Permission retry must respect Rust's restrictive policy; it is not classified as permanently out of scope.
The suite uses fake agents and temporary addon trees; it does not establish live
WoW client or Windows capture behavior.

Inventory validation rejects orphan `_is_known_gap` test declarations, unknown
fields, invalid status/reason combinations, and missing or ignored test references.
New pending integration probes must follow that naming convention and use the
shared manifest expectation and assertion helpers. Source checks are deliberately
small and support the repository's top-level `#[test]` / `fn name()` style; they
are not a general Rust parser. Review must preserve this convention.
