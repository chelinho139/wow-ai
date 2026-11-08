# Testing on Windows 11 x64

The injected Rust pipeline can run fake-agent self-tests and configured real agent
CLIs, then save replies to a private Rust outbox. It cannot capture WoW yet.

## Download a Windows build (no Rust or Node installation needed)

1. Sign in to GitHub and open the
   [Rust workflow](https://github.com/leozitor/wow-ai-reforged/actions/workflows/rust.yml).
2. Select a successful run for `feat/rust-backend` with the desired commit.
3. Under **Artifacts**, download `wow-ai-reforged-windows-x64` and extract the ZIP.
   Artifacts expire after 14 days; a later successful run provides a fresh build.
4. Open a terminal in the extracted folder and run:

```powershell
.\wow-ai-reforged.exe --help
.\wow-ai-reforged.exe --version
.\wow-ai-reforged.exe self-test
```

Expect six `PASS` lines from fake agents and a printed temporary workspace/reply path.
No account, agent installation or running game is needed for `self-test`.
These are pipeline smoke checks, not live game tests. The automated protocol,
publication, signal and frame tests run in CI before this executable is uploaded.
Running without arguments prints usage guidance and exits with an error.

The archive includes `BUILD.txt` with its source commit and CI run, `LICENSE`, and
`SHA256SUMS.txt`. To compare the executable against the included checksum:

```powershell
(Get-FileHash .\wow-ai-reforged.exe -Algorithm SHA256).Hash.ToLowerInvariant()
Get-Content .\SHA256SUMS.txt
```

### Native addon installation

The executable bundles the addon files, primer, and all 200 reply slots directly into the binary. To install them into your WoW client without Node or PowerShell scripts:

```powershell
.\wow-ai-reforged.exe setup --wow "C:\Program Files (x86)\World of Warcraft\_forever_"
```

- `--wow` must point to the game folder containing `Wow.exe` (normally `_forever_`).
- It extracts `Interface\AddOns\WoWAI` and `WoWAI_S001` through `WoWAI_S200`.
- It is create-only and safe to rerun: existing runtime files (`Inbox.lua`, signals) and other addons are preserved. Differing static assets cause an explicit error without touching your files.

### Running the live bridge

Once addon setup is complete, launch World of Warcraft and enable the `WoWAI` addon.
To start the live Rust bridge:

```powershell
.\wow-ai-reforged.exe run --config .\config.json --wow "C:\Program Files (x86)\World of Warcraft\_forever_"
```

- Discovers the `Wow.exe` game window and client area coordinates.
- Polls and captures the in-game pixel strip directly via Windows GDI `BitBlt` without PowerShell/Python helper scripts.
- Executes configured agent CLIs when prompts are sent from in-game chat.
- Atomically publishes replies and signal WAVs directly to `Interface\AddOns`.
- Use Ctrl+C to stop the bridge when done playing.

## Prerequisites for building from source

Use native Windows, rather than WSL, to exercise Windows file replacement behavior.
Install stable Rust using the x64 installer from the
[official Rust installation page](https://rust-lang.org/tools/install/).
Follow its prompts for the Visual Studio C++ build tools. Open a new terminal after
installation so Cargo is on PATH. These are developer prerequisites, not requirements
for the eventual standalone release.

Use an up-to-date copy of the `feat/rust-backend` sources. Do not
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
available commands, and version `0.1.0`. Test counts may grow as development continues.

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

To try an actual agent outside the game, copy `config.example.json` from the ZIP,
replace its project/executable paths, and choose a new empty data directory. Keep
only the agent configurations you have installed and logged in. Then run:

```powershell
.\wow-ai-reforged.exe inject --config .\config.example.json --agent codex --prompt "Reply with exactly PONG"
```

This contacts your selected provider and uses its existing authentication. The reply
is printed as JSON and saved under the configured `data_dir/outbox`; your installed
addon files and legacy chats are untouched. Inspect `reforged-state.json` for the new
Rust history/session. Repeating a chat resumes its Rust session; `--fresh-session`
starts a new one. If a completed reply cannot be published, use:

```powershell
.\wow-ai-reforged.exe recover --config .\config.example.json
```

Recovery republishes the saved reply without another provider call. Adapters have
fake-process coverage; authenticated compatibility with your installed CLI version
still needs testing. See `rust/bridge/README.md` in the source repository for the
provider-specific permission behavior and Windows launcher configuration.

Continue using the Node backend for live chat. Do not point an ad hoc Rust example
at your real addon directory: shared live bridge coordination and native capture are still pending. The roadmap's live Windows gate will cover those
features once the runtime is ready. Files already read by WoW can remain cached;
clearing a signal on disk cannot reset that cache.

If a check fails, retain the failing command and its full output along with
`rustc --version` and `cargo --version`. A passing local macOS/Linux run does not
establish that Windows-specific tests have passed.
