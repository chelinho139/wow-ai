# Installing WoW AI

Every route ends in the same place: the code on your machine, a `wow-ai` command, the addon in the game folder, and a bridge that is running while you play. Pick one route; the rest of this page (service, updating, uninstalling) is the same for all of them.

Before any of them you need:

- **World of Warcraft: Forever**, run at least once with the account you play on (setup reads the account folder).
- **Node.js 22.2 or newer** (`node -v`): [nodejs.org](https://nodejs.org), or `brew install node` on macOS, `winget install OpenJS.NodeJS.LTS` on Windows.
- **At least one agent CLI**, installed and logged in: `claude`, `codex`, `grok`, `agy` or `hermes` (see [AGENTS.md](AGENTS.md)). One is enough; the bridge lists what it found.

Platform notes that are not about installing (which display mode, screen-capture permissions, Wine and X11) stay in [INSTALL-WINDOWS.md](INSTALL-WINDOWS.md) and [INSTALL-LINUX.md](INSTALL-LINUX.md), and in the README's macOS section.

## Route 1: the one-line installer (recommended)

macOS and Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/rdimascio/wow-ai/main/install.sh | sh
```

Windows, in PowerShell:

```powershell
irm https://raw.githubusercontent.com/rdimascio/wow-ai/main/install.ps1 | iex
```

(Those URLs serve the scripts at the root of this repository once this branch is on `main`; until then, download `install.sh` / `install.ps1` from the branch and run them the same way.)

The script checks for Node, downloads the code (git if you have it, otherwise the archive) into `~/.wow-ai` (Windows: `%LocalAppData%\Programs\wow-ai`), puts a `wow-ai` command on your PATH (`~/.local/bin`; Windows: the user PATH), runs the game-side setup, and asks whether to run the bridge in the background from now on. It never asks for sudo or administrator rights, it is safe to run again (that is how you update), and if something is missing it stops and says what to do.

Options go after `sh -s --` (macOS/Linux) or in the environment before `iex` (Windows):

| | macOS / Linux | Windows |
|---|---|---|
| Client folder, if setup cannot find it | `--wow "/Applications/World of Warcraft/_classic_beta_"` | `$env:WOW_AI_WOW = "D:\Games\World of Warcraft\_classic_beta_"` |
| Default project folder for the agents | `--project ~/code/my-game` | `$env:WOW_AI_PROJECT = "C:\code\my-game"` |
| Background service without asking / never | `--service` / `--no-service` | `$env:WOW_AI_SERVICE = "yes"` / `"no"` |
| Where the code goes | `--dir <folder>` | `$env:WOW_AI_DIR = "<folder>"` |

For example:

```sh
curl -fsSL https://raw.githubusercontent.com/rdimascio/wow-ai/main/install.sh | sh -s -- --project ~/code/my-game --service
```

When it finishes: fully quit and relaunch WoW, enable *WoW AI* on the AddOns screen, and type `/wow-ai` in game.

## Route 2: Homebrew (macOS)

```sh
brew tap rdimascio/wow-ai
brew install --HEAD wow-ai      # head-only until there is a tagged release
wow-ai setup                    # the game side: addon, config, slot pool
wow-ai service install          # optional: background service
```

Homebrew installs the bridge and the `wow-ai` command. It cannot put an addon into the game folder or read your WoW account, so `wow-ai setup` is a separate, required step. One caveat, printed by `brew` too: the bridge keeps its config and the agents' sessions inside the Homebrew keg, and `brew upgrade` replaces the keg. After an upgrade run `wow-ai setup` again, and expect sessions to start fresh. If that bothers you, use route 1, which keeps everything in `~/.wow-ai`. The formula and the reasoning are in [`homebrew/`](../homebrew/README.md).

## Route 3: by hand (git)

```sh
git clone https://github.com/rdimascio/wow-ai
cd wow-ai
node setup.js --project ~/code/my-game     # or --wow "<client folder>" if it cannot find the client
npm start                                  # the bridge, in this terminal
```

`npm install` is only for running the tests; the bridge has no runtime dependencies. To have the `wow-ai` command from any folder, `npm link` in the repo (see [INSTALL-WINDOWS.md](INSTALL-WINDOWS.md) for what that does and the PowerShell execution-policy note), or write a two-line shim that runs `node <repo>/bridge/supervisor.js "$@"`.

## What setup does

`wow-ai setup` (the same as `node setup.js`) finds the client (or takes `--wow`), copies the addon into `Interface/AddOns/WoWAI`, writes `bridge/config.json` with the paths and the default project folder, reports which agent CLIs it found, and creates the 200 reply-slot addons plus about 15,000 tiny signal files. That count is normal: the client only discovers addon files at launch, so everything the bridge might ever touch has to exist up front. Re-running it keeps your config and the slot pool; `--project <folder>` on a re-run corrects the default folder.

Then **fully quit and relaunch World of Warcraft** (a `/reload` is not enough) and enable *WoW AI* on the character-select AddOns screen. The 200 *WoW AI slot* entries stay enabled; leave them alone.

## Running the bridge

Two ways, not both at once (two bridges fight over the slot files):

- **In a terminal:** `wow-ai` from the project folder you want the agents to work in (that folder becomes the default for chats), or `npm start` inside the repo. Leave the window open; Ctrl+C stops it; it restarts itself after a crash.
- **As a background service:** `wow-ai service install`. It starts now and at every login, comes back after a crash, and needs no window. `wow-ai service status` says whether it is running, with its pid, uptime and the last log lines; `wow-ai service logs` (or `logs -f`) shows the log; `stop`, `start`, `restart` do what they say; `uninstall` removes it.

Under the service the bridge's default project folder is `defaultCwd` from `bridge/config.json` (`wow-ai setup --project <folder>` sets it); chats still pick their own with `/wow-ai cd`.

### What the service is, per platform

| | Definition | Logs |
|---|---|---|
| macOS | LaunchAgent `~/Library/LaunchAgents/io.wowai.bridge.plist` (`RunAtLoad` + `KeepAlive`: starts at login, restarted by launchd 10 s after any exit) | `~/Library/Logs/wow-ai/bridge.log` |
| Linux | systemd user unit `~/.config/systemd/user/wow-ai-bridge.service` (`Restart=always`; needs `systemctl --user`, which every mainstream desktop has) | `~/.local/state/wow-ai/bridge.log` (`$XDG_STATE_HOME`) |
| Windows | `WoW AI bridge.vbs` in your Startup folder, which starts the bridge with no window at login; the supervisor does the crash restarts | `%LocalAppData%\wow-ai\logs\bridge.log` |

Logs rotate at 5 MB with five old files kept, so they never grow without bound. The bridge's own `bridge/bridge.log` (next to the code) is rotated the same way, in every mode.

Things worth knowing:

- **The service sees the PATH you had when you installed it.** launchd and systemd hand services an almost empty environment, so `wow-ai service install` bakes your PATH into the definition; the bridge finds `claude`, `codex` and the rest through it. After installing a new agent CLI, or a new Node, run `wow-ai service install` again.
- **macOS and screen capture.** A background process cannot ask for Screen Recording or Automation permission. With `"mode": "screenshot"` under `capture` in `bridge/config.json` the bridge needs neither (the addon takes a screenshot with the strip up; the bridge reads the file), which is the configuration the service is meant for; `install` says so if the config is still on the pixel transport. On the pixel transport, run the bridge from a terminal that has the permissions instead.
- **Linux and X11 capture.** The pixel transport needs `DISPLAY`; the unit carries the one you had at install time. The screenshot transport needs nothing.
- **Windows without a restart-on-crash guarantee for the supervisor itself:** the Startup-folder route restarts the bridge when it crashes (that is what the supervisor does) but not the supervisor. If you want that too, create a Task Scheduler task (*Create Basic Task*, trigger *When I log on*, action `node "C:\...\wow-ai\bridge\supervisor.js"` with *Start in* set to the wow-ai folder, and under *Settings* tick *If the task fails, restart every 1 minute*) and delete the Startup-folder launcher with `wow-ai service uninstall`.
- `wow-ai service install` refuses to run without `bridge/config.json` (the service would only loop), and warns when a bridge is already running in a terminal.

## Updating

- Route 1: run the one-line installer again. It pulls (or re-downloads), re-runs setup, and keeps your config and chats. Then `wow-ai service restart` (or restart the terminal bridge), and `/reload` in game, or relaunch the game if setup reports new files.
- Route 2: `brew upgrade --fetch-HEAD wow-ai`, then `wow-ai setup`, then `wow-ai service restart`.
- Route 3: `git pull && node setup.js`, then restart the bridge.

## Uninstalling

```sh
wow-ai service uninstall        # if you installed the service
```

Then delete the code (`~/.wow-ai`, the Homebrew keg via `brew uninstall wow-ai`, or your clone) and the `wow-ai` shim in `~/.local/bin` (route 1) or `npm unlink -g wow-ai` (route 3). In the game folder, delete `Interface/AddOns/WoWAI` and the `WoWAI_S001` … `WoWAI_S200` folders next to it. Your chats' saved data is in `WTF/Account/<account>/SavedVariables/WoWAI.lua`; the service's logs are in the folder listed above.

## Coming from wow-claude

The project was called wow-claude until it learned to drive more than one agent. Run setup again (any route): it copies your chats and settings from the old addon's saved data, removes the old `WoWClaude` addon and its slot folders, and rewrites `bridge/config.json`. Details in [INSTALL-WINDOWS.md](INSTALL-WINDOWS.md#upgrading-from-wow-claude).

## If something goes wrong

- The installer stops with `install failed: ...` and a `->` line: do what the arrow says and run it again. Nothing is left half-done: the code and the command go in before setup runs, so `wow-ai setup --wow "<client folder>"` is always the way to finish.
- `wow-ai service status` says `running : no`: `wow-ai service logs` shows why. `Cannot read config.json` means setup has not run; `NOT INSTALLED` in the banner means setup could not write into the game folder (check `addonDir` in `bridge/config.json`).
- The light in the game window stays red: the bridge is not running, or cannot see the game. Platform specifics are in [INSTALL-WINDOWS.md](INSTALL-WINDOWS.md#troubleshooting), [INSTALL-LINUX.md](INSTALL-LINUX.md) and the README's Troubleshooting section; `/wow-ai diag` in game reports what the addon sees.
