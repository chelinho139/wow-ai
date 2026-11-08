# Testing on Windows 11 x64

The Rust backend is under development. You can test its protocol, slot publication,
WAV signals, and pixel-frame decoding now. It cannot capture WoW or run agents yet, and starting the main
executable without arguments intentionally fails with a scaffold message.

## Prerequisites for building from source

Use native Windows, rather than WSL, to exercise Windows file replacement behavior.
Install stable Rust using the x64 installer from the
[official Rust installation page](https://rust-lang.org/tools/install/).
Follow its prompts for the Visual Studio C++ build tools. Open a new terminal after
installation so Cargo is on PATH. These are developer prerequisites, not requirements
for the eventual standalone release.

Use a copy of the `feat/rust-backend` sources containing the latest signal commit.
Local commits are not available in a remote clone until the branch is pushed. Do not
copy another OS's `target/` build directory; Cargo builds the Windows binaries locally.

## Core tests (no Node, WoW, or agent login needed)

In a Windows terminal, change into the repository root and run each command:

```powershell
rustc --version
cargo --version
cargo test --workspace --locked
cargo build --release --locked
.\target\release\wow-ai-reforged.exe --help
.\target\release\wow-ai-reforged.exe --version
```

Expect all tests to pass, a successful release build, help text explaining the
scaffold, and version `0.1.0`. Test counts may grow as development continues.

The tests create their own folders under Windows' temporary directory, then remove
them. They check message parsing, Lua serialization, atomic replacement, slot and
signal file names, WAV contents, activity resets and presence wrapping. A Windows-only
test locks a destination file and verifies that publication reports failure, preserves
its old content, and cleans up its temporary file. No test targets your game folder
or imports legacy chat data.

To run just the new signal tests:

```powershell
cargo test --locked signals::tests -- --nocapture
cargo test --locked --test frame_compat
```

For the same Rust quality checks used in CI:

```powershell
rustup component add rustfmt clippy
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
```

## Optional legacy and Lua compatibility checks

With Node installed for development tooling, run:

```powershell
npm ci
npm test
node rust/bridge/tests/validate-slot.cjs
```

The last command runs Rust-generated reply data through a Lua VM. Node remains a
legacy/development requirement only; core Rust tests use committed fixtures.

## Live WoW testing comes later

Continue using the Node backend for live chat. Do not point an ad hoc Rust example
at your real addon directory: exclusive ownership, native capture, setup and the
agent adapters are still pending. The roadmap's live Windows gate will cover those
features once the runtime is ready. Files already read by WoW can remain cached;
clearing a signal on disk cannot reset that cache.

If a check fails, retain the failing command and its full output along with
`rustc --version` and `cargo --version`. A passing local macOS/Linux run does not
establish that Windows-specific tests have passed.
