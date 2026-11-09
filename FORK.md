# Developing WoW AI Reforged

This fork is developing a Rust companion backend, with Windows as the primary
target and macOS/Linux support where practical. The existing Node implementation
is the working legacy backend and a reference for compatibility.

## Repository boundaries

- `bridge/`, `setup.js`, `package.json`, and `tests/`: legacy Node backend,
  installer, and existing tests. Keep their paths so upstream patches remain
  straightforward to merge. `npm start` still starts this backend.
- `addon/`: shared Lua addon. Initially preserve its transport and payload formats
  so either backend can work with it. Review upstream addon changes for their
  effect on both backends.
- `rust/`: new Rust implementation; the root `Cargo.toml` defines its workspace.
- `.github/workflows/test.yml`: existing legacy checks.
- `.github/workflows/rust.yml`: independent Windows/Linux/macOS Rust checks.

The Rust executable supports a Windows live game bridge, native embedded addon
setup/update, injected messages, and fake-agent self-tests. JSON libraries compile
into the binary; no separate Node/Python runtime is required by the backend.
Rust configuration and history are separate from legacy data. Live mode writes to
the explicitly selected addon installation, shared with the legacy backend.
Never run both backends against the same game installation at once.
See [Windows testing](rust/WINDOWS-TESTING.md) for build, update, and live-test steps.

## Local development

Legacy backend:

```sh
npm ci
npm test
npm start
```

Rust backend (install the stable Rust toolchain):

```sh
cargo run -- --help
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
cargo build --release --locked
```

Commit `Cargo.lock` for reproducible application builds. Build output lives in
`target/` and is ignored. Node remains necessary for the legacy backend and its
tests; the Rust executable itself does not require Node. External agent CLIs retain
their own runtime requirements.

## Receiving upstream changes

`origin` is your fork; `upstream` is the original project. Git remotes are local
configuration, so each new clone needs this once:

```sh
git remote add upstream https://github.com/chelinho139/wow-ai.git
```

Start with a clean working tree. Fetch and review upstream on a temporary branch
based on your current development branch:

```sh
git fetch upstream
git switch -c sync/upstream-YYYY-MM-DD
git log --oneline HEAD..upstream/main
git diff HEAD...upstream/main
git merge upstream/main
```

Resolve conflicts deliberately, preserving the fork's Rust workspace and entry
points. Run both validation command sets above, then submit the sync branch to
your fork for review. This merge workflow retains upstream ancestry so future
syncs include only new changes. Do not replace your development branch with
`upstream/main`. No automatic sync job merges changes into your fork.

Keep fork-specific guidance here and Rust-specific documentation under `rust/`.
Limit edits to upstream-owned files to integration points and necessary fixes.
Upstream protocol changes still require Rust compatibility review even if Git
merges cleanly. Preserve upstream MIT licensing and attribution.

## Migration checkpoints

See [rust/ROADMAP.md](rust/ROADMAP.md) for the execution plan, confirmed release
scope, and acceptance gates. The first release targets Windows 11 x64, supports
all five legacy agents plus Gemini, installs as a standalone executable, and starts
with fresh Rust history while preserving legacy data.

1. Port pure protocol behavior, using existing fixtures/tests as the reference.
2. Implement configuration, persistence, agent processes, and deterministic
   injected-message tests without requiring a running game.
3. Implement Windows capture and verify end-to-end against a live client.
4. Add macOS/Linux capture behind platform-specific modules.
5. Switch the default backend only after compatibility and resource-use checks.

The Windows live preview is implemented and has initial user-reported in-game
chat success. Full feature parity, remaining live acceptance tests, native
macOS/Linux capture, and resource measurements remain open.
