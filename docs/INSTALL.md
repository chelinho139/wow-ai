# Installing Claude WoW

Every route ends in the same place: the code on your machine, a `claude-wow` command, the addon in the game folder, and a bridge that is running while you play. Pick one route; the rest of this page (service, updating, uninstalling) is the same for all of them.

Before any of them you need:

- **World of Warcraft: Forever**, run at least once with the account you play on (setup reads the account folder).
- **Nothing else, on route 1 or 2**: the bridge ships as one self-contained binary for macOS (arm64, x64), Linux (x64) and Windows (x64), with its runtime inside. Route 3, and route 1 where there is no binary for your machine, run the checkout and need **Node.js 22.2 or newer** (`node -v`: [nodejs.org](https://nodejs.org), `brew install node`, `winget install OpenJS.NodeJS.LTS`) or [Bun](https://bun.sh).
- **At least one agent CLI**, installed and logged in: `claude`, `codex`, `grok`, `agy` or `hermes` (see [AGENTS.md](AGENTS.md)). One is enough; the bridge lists what it found.

Platform notes that are not about installing (which display mode, screen-capture permissions, Wine and X11) stay in [INSTALL-WINDOWS.md](INSTALL-WINDOWS.md) and [INSTALL-LINUX.md](INSTALL-LINUX.md), and in the README's macOS section.

## Route 1: the one-line installer (recommended)

macOS and Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/rdimascio/claude-wow/main/install.sh | sh
```

Windows, in PowerShell:

```powershell
irm https://raw.githubusercontent.com/rdimascio/claude-wow/main/install.ps1 | iex
```

(Those URLs serve the scripts at the root of this repository once this branch is on `main`; until then, download `install.sh` / `install.ps1` from the branch and run them the same way.)

The script downloads the `claude-wow` binary for your machine from the project's GitHub releases into `~/.local/bin` (Windows: `%LocalAppData%\Programs\claude-wow\bin`, put on your user PATH), checks it against the release's `SHA256SUMS`, runs it once, runs the game-side setup (config, state and logs go to `~/.claude-wow`), and asks whether to run the bridge in the background from now on. Nothing else is installed: the binary is the bridge, setup and the service commands with their runtime inside. Where there is no binary for your machine (another platform, or no release yet), or with `--from-source` (`$env:CLAUDE_WOW_SOURCE = "1"` on Windows), it installs from source instead: checks for Node.js 22.2+, downloads the code (git if you have it, otherwise the archive) into `~/.claude-wow/app` (Windows: `%LocalAppData%\Programs\claude-wow`) and writes a `claude-wow` shim that runs it with node. An install under the project's old name (`~/.wow-ai`, the `wow-ai` command and service) is carried over; see [Coming from wow-ai](#coming-from-wow-ai). It never asks for sudo or administrator rights, it is safe to run again (that is how you update), and if something is missing it stops and says what to do.

Options go after `sh -s --` (macOS/Linux) or in the environment before `iex` (Windows):

| | macOS / Linux | Windows |
|---|---|---|
| Client folder, if setup cannot find it | `--wow "/Applications/World of Warcraft/_classic_beta_"` | `$env:CLAUDE_WOW_WOW = "D:\Games\World of Warcraft\_classic_beta_"` |
| Default project folder for the agents | `--project ~/code/my-game` | `$env:CLAUDE_WOW_PROJECT = "C:\code\my-game"` |
| Background service without asking / never | `--service` / `--no-service` | `$env:CLAUDE_WOW_SERVICE = "yes"` / `"no"` |
| The source with Node instead of the binary | `--from-source` | `$env:CLAUDE_WOW_SOURCE = "1"` |
| Which release's binary | `--release <tag>` | `$env:CLAUDE_WOW_RELEASE = "<tag>"` |
| Where the source goes (from source) | `--dir <folder>` | `$env:CLAUDE_WOW_DIR = "<folder>"` |

For example:

```sh
curl -fsSL https://raw.githubusercontent.com/rdimascio/claude-wow/main/install.sh | sh -s -- --project ~/code/my-game --service
```

When it finishes: fully quit and relaunch WoW, enable *Claude WoW* on the AddOns screen, and type `/claude-wow` in game.

## Route 2: Homebrew (macOS)

```sh
brew tap rdimascio/claude-wow
brew install claude-wow             # the release binary: no Node.js (--HEAD: the checkout, run with Homebrew's node)
claude-wow setup                    # the game side: addon, config, slot pool
claude-wow service install          # optional: background service
```

Homebrew installs the bridge and the `claude-wow` command: the self-contained binary for your Mac from the tagged release (until the first release exists, only `--HEAD` installs). It cannot put an addon into the game folder or read your WoW account, so `claude-wow setup` is a separate, required step. The keg holds only code: your config, the agents' sessions, transcripts and logs live in `~/.claude-wow` (`CLAUDE_WOW_HOME`, see [CONFIGURATION.md](CONFIGURATION.md#where-the-bridge-keeps-its-files)), so `brew upgrade` keeps them; `claude-wow service restart` afterwards picks up the new code. The formula is in [`homebrew/`](../homebrew/README.md).

## Route 3: by hand (git)

```sh
git clone https://github.com/rdimascio/claude-wow
cd claude-wow
node setup.js --project ~/code/my-game     # or --wow "<client folder>" if it cannot find the client
npm start                                  # the bridge, in this terminal
```

This route needs Node.js 22.2+ or Bun (`bun setup.js`, `bun bridge/supervisor.js`); `npm install` is only for running the tests; the bridge has no runtime dependencies. `npm run build` makes the self-contained binaries the other routes install (see [CONTRIBUTING.md](../CONTRIBUTING.md#building-the-binary)). To have the `claude-wow` command from any folder, `npm link` in the repo (see [INSTALL-WINDOWS.md](INSTALL-WINDOWS.md) for what that does and the PowerShell execution-policy note), or write a two-line shim that runs `node <repo>/bridge/supervisor.js "$@"`.

## What setup does

`claude-wow setup` (the same as `node setup.js`) finds the client (or takes `--wow`), copies the addon into `Interface/AddOns/ClaudeWoW`, writes `config.json` in `~/.claude-wow` (or `CLAUDE_WOW_HOME`) with the paths and the default project folder, reports which agent CLIs it found, and creates the 200 reply-slot addons plus about 15,000 tiny signal files. That count is normal: the client only discovers addon files at launch, so everything the bridge might ever touch has to exist up front. Re-running it keeps your config and the slot pool; `--project <folder>` on a re-run corrects the default folder.

Then **fully quit and relaunch World of Warcraft** (a `/reload` is not enough) and enable *Claude WoW* on the character-select AddOns screen. The 200 *Claude WoW slot* entries stay enabled; leave them alone.

## Running the bridge

Two ways, not both at once (two bridges fight over the slot files):

- **In a terminal:** `claude-wow` from the project folder you want the agents to work in (that folder becomes the default for chats), or `npm start` inside the repo. Leave the window open; Ctrl+C stops it; it restarts itself after a crash.
- **As a background service:** `claude-wow service install`. It starts now and at every login, comes back after a crash, and needs no window. `claude-wow service status` says whether it is running, with its pid, uptime and the last log lines; `claude-wow service logs` (or `logs -f`) shows the log; `stop`, `start`, `restart` do what they say; `uninstall` removes it.

Under the service the bridge's default project folder is `defaultCwd` from `~/.claude-wow/config.json` (`claude-wow setup --project <folder>` sets it); chats still pick their own with `/claude-wow cd`.

### What the service is, per platform

| | Definition | Logs |
|---|---|---|
| macOS | LaunchAgent `~/Library/LaunchAgents/io.claudewow.bridge.plist` (`RunAtLoad` + `KeepAlive`: starts at login, restarted by launchd 10 s after any exit) | `~/Library/Logs/claude-wow/bridge.log` |
| Linux | systemd user unit `~/.config/systemd/user/claude-wow-bridge.service` (`Restart=always`; needs `systemctl --user`, which every mainstream desktop has) | `~/.local/state/claude-wow/bridge.log` (`$XDG_STATE_HOME`) |
| Windows | `Claude WoW bridge.vbs` in your Startup folder, which starts the bridge with no window at login; the supervisor does the crash restarts | `%LocalAppData%\claude-wow\logs\bridge.log` |

Logs rotate at 5 MB with five old files kept, so they never grow without bound. The bridge's own `~/.claude-wow/bridge.log` is rotated the same way, in every mode.

Things worth knowing:

- **The service sees the PATH you had when you installed it.** launchd and systemd hand services an almost empty environment, so `claude-wow service install` bakes your PATH into the definition; the bridge finds `claude`, `codex` and the rest through it. After installing a new agent CLI, or a new Node, run `claude-wow service install` again.
- **macOS and screen capture.** A background process cannot ask for Screen Recording or Automation permission. With `"mode": "screenshot"` under `capture` in `~/.claude-wow/config.json` the bridge needs neither (the addon takes a screenshot with the strip up; the bridge reads the file), which is the configuration the service is meant for; `install` says so if the config is still on the pixel transport. On the pixel transport, run the bridge from a terminal that has the permissions instead.
- **Linux and X11 capture.** The pixel transport needs `DISPLAY`; the unit carries the one you had at install time. The screenshot transport needs nothing.
- **Windows without a restart-on-crash guarantee for the supervisor itself:** the Startup-folder route restarts the bridge when it crashes (that is what the supervisor does) but not the supervisor. If you want that too, create a Task Scheduler task (*Create Basic Task*, trigger *When I log on*, action `node "C:\...\claude-wow\bridge\supervisor.js"` with *Start in* set to the claude-wow folder, and under *Settings* tick *If the task fails, restart every 1 minute*) and delete the Startup-folder launcher with `claude-wow service uninstall`.
- `claude-wow service install` refuses to run without a `config.json` in the home folder (the service would only loop), warns when a bridge is already running in a terminal, and removes a service installed by the project's old name (`io.wowai.bridge`, `wow-ai-bridge`, *WoW AI bridge.vbs*) so two bridges never start at login; `uninstall` removes that one too.

## Updating

- Route 1: run the one-line installer again. It replaces the binary (or pulls the source), re-runs setup, and keeps your config and chats. Then `claude-wow service restart` (or restart the terminal bridge), and `/reload` in game, or relaunch the game if setup reports new files. A new binary writes its own capture scripts and addon out under `~/.claude-wow/assets` the first time it runs.
- Route 2: `brew upgrade claude-wow` (`--fetch-HEAD` for a `--HEAD` install), then `claude-wow service restart` (your config and sessions are in `~/.claude-wow`, untouched; `claude-wow setup` again only if the addon changed, which the changelog says).
- Route 3: `git pull && node setup.js`, then restart the bridge.

## Uninstalling

```sh
claude-wow service uninstall        # if you installed the service
```

Then delete the code (the `claude-wow` binary in `~/.local/bin`, Windows `%LocalAppData%\Programs\claude-wow`; `~/.claude-wow/app` for a from-source install; the Homebrew keg via `brew uninstall claude-wow`; or your clone), the home folder `~/.claude-wow` (config, sessions, transcripts, logs, and the binary's extracted `assets`; with a from-source route 1 the code is inside it too, so one `rm -rf ~/.claude-wow` does both), and the `claude-wow` shim in `~/.local/bin` (route 1 from source) or `npm unlink -g claude-wow` (route 3). In the game folder, delete `Interface/AddOns/ClaudeWoW` and the `ClaudeWoW_S001` … `ClaudeWoW_S200` folders next to it. Your chats' saved data is in `WTF/Account/<account>/SavedVariables/ClaudeWoW.lua`; the service's logs are in the folder listed above.

## Coming from wow-ai

The project was called wow-ai (and wow-claude before that). Run the installer again, or `claude-wow setup` (any route): it copies your chats and settings from the old addon's saved data (`WoWAI.lua` or `WoWClaude.lua`) to `ClaudeWoW.lua`, removes the old addon and its slot folders, and rewrites the addon paths in `config.json`. The installer also carries `config.json`, `state.json` and `transcripts.json` over from `~/.wow-ai/bridge` to `~/.claude-wow`, uninstalls the old service and removes the old `wow-ai` command; `claude-wow service install` removes the old service on its own too. The old slash commands (`/wow-ai`, `/ai`, `/ask`, `/wowai`, `/wow-claude`) are gone: it is `/claude` or `/claude-wow`. Details in [INSTALL-WINDOWS.md](INSTALL-WINDOWS.md#upgrading-from-wow-ai-or-wow-claude) and the README.

## If something goes wrong

- The installer stops with `install failed: ...` and a `->` line: do what the arrow says and run it again. Nothing is left half-done: the code and the command go in before setup runs, so `claude-wow setup --wow "<client folder>"` is always the way to finish.
- `claude-wow service status` says `running : no`: `claude-wow service logs` shows why. `Cannot read config.json` means setup has not run; `NOT INSTALLED` in the banner means setup could not write into the game folder (check `addonDir` in `config.json`; the banner's `home :` line says where that is).
- The light in the game window stays red: the bridge is not running, or cannot see the game. Platform specifics are in [INSTALL-WINDOWS.md](INSTALL-WINDOWS.md#troubleshooting), [INSTALL-LINUX.md](INSTALL-LINUX.md) and the README's Troubleshooting section; `/claude-wow diag` in game reports what the addon sees.
