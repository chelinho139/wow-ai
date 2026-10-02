## Distribution design: wow-ai release, addon, and bridge

**Verdict:** Most of the parts exist already. `build.js` makes one Bun binary that carries the addon, `install.sh` does a checksum-verified binary swap, and there is a Homebrew formula. What is missing:
- a release workflow (the repo has no tags, and `test.yml` only builds artifacts),
- a split of the folders,
- a self-updater,
- a version handshake.

⚠️ The bridge writes files inside `ClaudeWoW/`. CurseForge reinstalls any folder whose files changed, so CurseForge distribution needs the folder split first.

### Repo facts that shape the design
- **The bridge has no runtime dependencies.** `package.json` has only `devDependencies` (fengari, luaparse). Running the bridge never needs `npm install`, so manual step 2 goes away.
- `build/entry.js` embeds all 17 addon files. `bridge/assets.js` writes them to `~/.claude-wow/assets/`. `setup.js copyAddon` copies them and skips an existing `Inbox.lua`.
- The LaunchAgent runs `/Users/ryan/.nvm/versions/node/v24.21.0/bin/node /Users/ryan/wow-ai/bridge/supervisor.js`. That is the dev tree, through a pinned nvm path.
- `bridge.js` keeps `state.inflight` in `state.json` (`noteInflight`, `recoverInflight`). The updater can use it as the idle check.
- The hello record already has a flags field (`protocol.js:209`, where `h` means hello). There is no version exchange today.
- The addon hardcodes `Interface\AddOns\ClaudeWoW\...` for signals in 7 places (`ClaudeWoW.lua:1187-1506`).
- `gamefs.walk` skips symlinks, so `repair()` never chmods files behind a symlink.

### Research findings
| Topic | Finding |
|---|---|
| BigWigs packager | Its `toc_to_type` maps `11???` to classic and **`16???` to forever** (alias `camelot`). A single `## Interface: 11509, 16001` toc then publishes to both flavors. Action: `BigWigsMods/packager@v2` with `CF_API_KEY`, `WAGO_API_TOKEN` and `GITHUB_OAUTH`, triggered by a tag. `-S` splits the toc per flavor. |
| Multi-folder | `.pkgmeta` `move-folders:` can ship more than one addon folder in one zip. |
| CurseForge app | Added the "Forever" flavor in app 1.321. An update uninstalls and reinstalls the folder. |
| Modified files | TSM: CurseForge "sees the file as 'modified'… will try to reinstall the original". RaiderIO: CurseForge "will override" the client's copy. Both tell users to set the addon to Ignored in CurseForge. |
| WeakAuras Companion | Writes into **its own** `WeakAurasCompanion` addon folder (`data.lua`), not into the WeakAuras folder. The app updates itself with electron-updater. |
| CurseForge rules | "External download links for files are not allowed", and automated checks reject executables. The bridge must not be in the zip. A text note that a companion is needed is the TSM/RaiderIO pattern. |
| Symlinks | WoW follows symlinks on Mac (warcraft.wiki.gg). Nobody documents whether Battle.net 2113 checks a symlink's target. |
| Homebrew | homebrew-autoupdate runs `brew upgrade` from launchd. It does not restart services. |

### Target folder layout
| Folder | Owner | Contents |
|---|---|---|
| `ClaudeWoW/` | **CurseForge** (or the bridge, for users without CurseForge). Pristine: nothing at runtime writes here. | Lua, toc, xml, `Portrait.tga`, plus a generated `Manifest.lua` (version, proto, file list) |
| `ClaudeWoW_Runtime/` (new) | **Bridge** | toc (`## Dependencies: ClaudeWoW`), `Inbox.lua`, `ack/ sig/ act/ ctl/ presence/a,b` |
| `ClaudeWoW_S001..S200/` | **Bridge** | Unchanged |

- `Inbox.lua` leaves the `ClaudeWoW.toc` file list. Load order is the open question: a hard dependency loads Runtime after ClaudeWoW, but `OptionalDeps: ClaudeWoW_Runtime` on ClaudeWoW makes the two folders depend on each other. Settle it in the game (Q2).
- Point the 7 signal paths at a `SIGNAL_ROOT` constant that resolves to `ClaudeWoW_Runtime`.
- **Migration** (`setup` / first run of the new bridge): create `ClaudeWoW_Runtime`, move the signal folders and the live `Inbox.lua` into it, then delete them from `ClaudeWoW/`. This needs **one full game restart**, so tell the player once. Remove the `ADDON_FOLDER` regex coupling in `gamefs.js` so `repair()` covers `_Runtime`.

### End-user update flow
- **Addon:** CurseForge, Wago or WoWUp update `ClaudeWoW/` from the packager release. Users without a manager let the bridge own `ClaudeWoW/` (setting `addonSource: "bridge"`), the RaiderIO-client model.
- **Bridge:** the release binary updates itself.
  - A daily check fetches `releases/latest` and downloads the asset and `SHA256SUMS`, which already exist.
  - It verifies the checksum, then `mv`s the binary into place. A running process keeps its old inode.
  - It sets `pendingRestart`. The supervisor restarts the child only when `state.inflight` is empty and the queue is idle, and the game is closed or idle for N seconds.
  - On a Homebrew keg path it does not swap the binary. It only prints `brew upgrade claude-wow`.
- **Who writes `ClaudeWoW/`:** if `addonSource` is `bridge` and the embedded version is newer than the on-disk toc `## Version`, the bridge extracts the files with a temp-then-rename per file and runs chmod 0777. If `addonSource` is `curseforge`, the bridge never writes there.
- **Reload or restart:** the bridge records the file list of `ClaudeWoW/` and `_Runtime/` when it sees the game process start (`procs.js`). After any update it compares again. A new path means **"Restart the game"**. Only changed files means **"/reload"**. The bridge sends this as a system line through the existing slot or chat-log channel.
- **Multiple clients:** `config.clients[]` replaces the single `addonDir`. Runtime and slots go into each client. Each client's slot toc uses that client's interface number.

### Developer flow
- **Production is not the dev tree.** The LaunchAgent runs `~/.claude-wow/current/claude-wow`, a symlink to `~/.claude-wow/releases/<ver-or-sha>/claude-wow`. That is a Bun binary, so there is no nvm path.
- **`claude-wow dev deploy [ref|worktree]`** does this:
  - takes `~/.claude-wow/deploy.lock`, so parallel sessions stop racing,
  - runs `git worktree add` at a temp path, then `bun build.js --host` (bun is at `~/.bun/bin/bun`),
  - waits for idle, switches the `current` symlink, and runs `launchctl kickstart -k`,
  - syncs the embedded addon into every client in `clients[]` with no deletes,
  - prints "reload" or "restart" from the file-list compare.

  `claude-wow dev rollback` points `current` back at the previous release.
- **Symlinking the repo addon into the clients is not the default.** `repair()` must chmod 0777 the targets, which sets the exec bit in git (the file mode becomes 100755) unless `core.fileMode=false`. The 2113 check on symlinks is also unverified. Keep it as an opt-in after Q3 passes.

### Version handshake
- Keep two numbers: **semver** (`package.json` = toc `## Version`, one tag for both) and an integer **`PROTO`** in `protocol.js` and `Manifest.lua`.
- The addon reads its own version with `C_AddOns.GetAddOnMetadata` and sends a hello flag token, `v=<semver>;p=<proto>`. Pick a token that no existing flag uses.
- The bridge writes `bridge = {v=, protoMin=, protoMax=}` into slot data.
- If the addon proto is out of range, the bridge refuses jobs and the addon shows a banner naming which side to update. If only semver differs, show a soft note.
- `claude-wow service status` and `doctor` show both versions and the update state.

### Implementation steps
| # | Step | Size |
|---|---|---|
| 1 | `.github/workflows/release.yml` on tag `v*`: packager to CurseForge (Classic and Forever) and Wago, plus the `build.js` binaries and `SHA256SUMS` on the same GitHub release. A check fails the tag if `package.json` ≠ toc `## Version`. | S |
| 2 | `ClaudeWoW_Runtime` split (signal paths, `Inbox.lua`, toc, `gamefs`, `install-slots`, tests) and the migration in setup | L |
| 3 | Generate `Manifest.lua` at build; `PROTO` constant; hello token; banner | M |
| 4 | File-list snapshot and the reload/restart notice | M |
| 5 | Self-updater, the idle-gated supervisor restart, and Homebrew detection | M |
| 6 | `releases/` and `current` layout; repoint the service plist; `dev deploy`/`rollback` with a lock | M |
| 7 | `clients[]` config and a per-client sync | S–M |
| 8 | Fill the Homebrew formula sums from the release and publish the tap | S |

### Open questions to test in the game
1. Does CurseForge's Forever flavor take a packager upload tagged `forever`, and does the app install it into `_classic_beta_` (or the Forever folder)?
2. Load order: does `## OptionalDeps: ClaudeWoW_Runtime` on `ClaudeWoW`, while Runtime has `Dependencies: ClaudeWoW`, load `Inbox.lua` first without a cycle error? If not, Runtime has to be a LoadOnDemand addon that ClaudeWoW loads.
3. Do sound-file checks work on files in a folder whose addon is LoadOnDemand or not loaded?
4. Does Battle.net raise 2113 on a symlink, or on a 0777 symlink to a 0644 target?
5. Does a CurseForge update of `ClaudeWoW/` leave sibling `ClaudeWoW_*` folders untouched? (Expected yes, because it tracks folders by fingerprint.)
6. Can the Forever client read toc metadata through `C_AddOns.GetAddOnMetadata`? Run a strings check against the binary.

Next step: step 1, the release workflow, unblocks everything else. Step 2 has to land before the first CurseForge upload.

### Sources
https://github.com/BigWigsMods/packager
https://raw.githubusercontent.com/BigWigsMods/packager/master/release.sh
https://github.com/BigWigsMods/packager/wiki/Preparing-the-PackageMeta-File
https://blog.curseforge.com/app-release-notes-1-321/
https://support.curseforge.com/en/support/solutions/articles/9000197279
https://support.tradeskillmaster.com/addon/how-do-i-fix-an-error-about-appdatalua-being-empty
https://support.raider.io/kb/raider-dot-io-mythic-plus-addon/how-to-fix-conflict-with-curseforge-and-raiderio-client
https://raiderio.reamaze.io/kb/raider-dot-io-mythic-plus-addon
https://github.com/WeakAuras/WeakAuras-Companion
https://raw.githubusercontent.com/WeakAuras/WeakAuras-Companion/main/package.json
https://docs.rs/ajour-weak-auras/
https://wowinterface.com/forums/showthread.php?p=270130
https://warcraft.wiki.gg/wiki/Symlinking_AddOn_folders
https://github.com/Homebrew/homebrew-autoupdate
