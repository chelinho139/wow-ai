# Installing on Windows

A start-to-finish walkthrough for a fresh Windows machine, ending with the `wow-ai` command available in any terminal. Coming from wow-claude, the project's old name? See [Upgrading from wow-claude](#upgrading-from-wow-claude). The short version is in the [README](../README.md); this page spells out every step and what can go wrong.

## 1. Prerequisites

| Need | Check | Get it |
|---|---|---|
| Windows 10/11 on NTFS | | |
| World of Warcraft: Forever, **windowed or borderless** | Options → Graphics → Display Mode | Exclusive fullscreen blocks screen capture, so the bridge can't see your messages |
| Node.js 22.2 or newer | `node -v` prints `v22.x` or higher | [nodejs.org](https://nodejs.org), the LTS installer; tick "Add to PATH" (default) |
| Git | `git --version` | [git-scm.com](https://git-scm.com/download/win) |
| At least one agent CLI, logged in (they work side by side) | | |
| · Claude Code | `claude --version` prints a version | [claude.com/claude-code](https://claude.com/claude-code), then run `claude` once and log in |
| · Codex | `codex --version` prints a version | `npm install -g @openai/codex`, then run `codex` once and log in |
| · Grok Build | `grok --version` prints a version | `irm https://x.ai/cli/install.ps1 \| iex` in PowerShell (or `npm install -g @xai-official/grok`), then `grok login`; needs a SuperGrok or X Premium+ subscription |
| · Antigravity | `agy --version` prints a version | Google's Antigravity CLI installer (the bridge also looks in `%LocalAppData%\agy\bin`), then run `agy` once and log in |
| · Hermes Agent | `hermes --version` prints a version | Hermes Agent installer, then `hermes setup` once |

Open a new terminal after installing Node or Git so the `PATH` change is picked up. Any terminal works: Windows Terminal, PowerShell, cmd, or Git Bash.

## 2. Get the code

```powershell
cd C:\Users\<you>\Documents          # or wherever you keep projects
git clone https://github.com/chelinho139/wow-ai
cd wow-ai
npm install
```

`npm install` only pulls the test tooling; the bridge itself has no dependencies.

## 3. Set up the game side

```powershell
node setup.js --project "C:\path\to\the\project\you\want\to\work\on"
```

This:

- finds the WoW: Forever client (it looks under `Program Files (x86)\World of Warcraft\_classic_beta_` and a few other common places; pass `--wow "D:\Games\World of Warcraft\_classic_beta_"` if it can't find yours),
- copies the addon into `Interface\AddOns\WoWAI`,
- writes `bridge\config.json` with your paths and the project folder,
- reports which agent CLIs it found (Claude Code, Codex, Grok Build, Antigravity, Hermes); one is enough, and you can add another later,
- creates the 200 reply-slot addons and about 15,000 tiny signal files next to it. That count is normal: the client only discovers addon files when it launches, so everything the bridge might ever touch has to exist up front.

`--project` is the fallback folder for chats. Once the `wow-ai` command is installed (step 5) you'll usually pick the folder by where you start the bridge instead.

If you have several WoW accounts, setup picks the first and says so; pass `--account <name>` to choose.

Now **fully quit and relaunch World of Warcraft** (a `/reload` is not enough, the new files have to be there at launch). On the character screen, open **AddOns** and make sure *WoW AI* is enabled. The 200 *WoW AI slot* entries stay enabled too; leave them alone.

## 4. First run

From the `wow-ai` folder:

```powershell
npm start
```

You should see a banner like:

```
WoW AI bridge
  folder   : C:\path\to\your\project  (config.json; chats can override with /wow-ai cd)
  addons   : C:\Program Files (x86)\World of Warcraft\_classic_beta_\Interface\AddOns
  slots    : 200 installed
  capture  : on (WowB, 200x48 cells of 4px)
  parallel : up to 3 chats at once
  fallback : ...
  agent    : claude (default; chats pick their own with /wow-ai agent)
  claude   : C:\Users\<you>\.local\bin\claude.exe  [acceptEdits, 11 allowed tool rules]
  codex    : not found - install it (npm install -g @openai/codex, then run `codex` once and log in) or set agents.codex.path in config.json
  grok     : C:\Users\<you>\.grok\bin\grok.exe  [acceptEdits, 11 allowed tool rules]
  ...
```

An agent shown as `not found` is fine as long as no chat uses it; a chat that picks it gets a reply saying so. The default (`agent` in `bridge\config.json`) must be one you have.

In the game, type `/wow-ai`. The window opens; the light in its corner should turn green within about ten seconds. Type something in the box and press Enter. The reply arrives with the whisper sound.

If the light stays red, see [Troubleshooting](#troubleshooting).

## 5. Install the `wow-ai` command

The bridge works in the folder you start it from, like the agent CLIs themselves. To be able to type `wow-ai` from any folder, install it once from inside the repo:

```powershell
cd C:\Users\<you>\Documents\wow-ai
npm link
```

`npm link` puts a `wow-ai` launcher into npm's global folder (`%AppData%\npm`, already on your `PATH` since Node was installed) that points back at this repo. Nothing is copied: pulling a newer version of the repo updates the command, and `bridge\config.json` stays where `setup.js` wrote it.

> Don't use `npm install -g .` instead. That copies the files into npm's global folder, where there is no `config.json`, and the bridge refuses to start.

Check it:

```powershell
wow-ai --help
```

Then use it from any project:

```powershell
cd C:\path\to\realms
wow-ai
```

The banner's `folder` line now says `started here`, and every chat that hasn't chosen its own folder with `/wow-ai cd` works in `realms`. `wow-ai --project <dir>` names the folder explicitly. Only one bridge can run at a time (two would fight over the screen and the slot files), so this sets the default folder rather than running one bridge per project.

Leave the window open while you play. Ctrl+C stops it. It restarts itself if it ever crashes.

### Updating

```powershell
cd C:\Users\<you>\Documents\wow-ai
git pull
node setup.js        # re-copies the addon; keeps your config.json and the slot pool
```

Then `/reload` in game and restart the bridge. If `setup.js` reports that it created new files, quit and relaunch the game instead of `/reload`.

### Upgrading from wow-claude

The project was called wow-claude until it learned to drive Codex and Grok; the addon was `WoWClaude` and the command `/wow-claude`. To move an existing install:

```powershell
cd C:\Users\<you>\Documents\wow-claude   # or clone https://github.com/chelinho139/wow-ai next to it
git pull
node setup.js
```

`setup.js` copies your chats and settings from `WoWClaude.lua` to `WoWAI.lua` in the game's SavedVariables, removes the old `WoWClaude` addon and its 200 `WoWClaude_S###` slot folders (two addons would both answer `/ai` and `/r`), rewrites the addon paths in `bridge\config.json`, moves the Claude settings under `agents.claude` and adds the `codex` and `grok` blocks, then builds the new slot pool. Quit and relaunch the game, and enable *WoW AI* on the AddOns screen. Your agent sessions carry on, since the bridge keeps them per chat.

Then, if you had installed the command: `npm unlink -g wow-claude`, and `npm link` again from the repo folder (rename the folder to `wow-ai` first if you like; `npm link` follows whatever it is called). A hotkey set with `/wow-claude bind` needs `/wow-ai bind <key>` again, since it pointed at the old addon's button. `/wow-claude` itself keeps working as an alias of `/wow-ai`.

### Uninstalling

```powershell
npm unlink -g wow-ai      # removes the command
```

Delete `Interface\AddOns\WoWAI` and the `WoWAI_S001` … `WoWAI_S200` folders next to it, and the `wow-ai` folder. Your chats' saved data is in `WTF\Account\<account>\SavedVariables\WoWAI.lua`.

### Retail clients (The War Within, 11.2.5)

The addon declares `## Interface: 16001, 110205`, so the same files load on Forever and on a retail 11.2.5 client. On retail the game context names the specialization and its saved talent loadout instead of talent tabs, lists professions through `GetProfessions`, and includes the client's locale (spell names in macros must match it); the bridge sends `docs/WOW-ADDON-PRIMER-RETAIL.md` instead of the Forever primer. Herb and ore nodes on the map are vanilla data and do not apply.

A client in a folder of its own, without `_retail_` (as some servers ship it), needs `--wow` pointing at the folder that holds `Interface` and the game exe:

```powershell
node setup.js --wow "E:GamesThe War Within" --project "C:path	oproject"
```

setup takes `capture.processName` from that exe's name (spaces included). Post-processing injectors (ReShade, HDR mods, frame generation) draw over the whole frame, the addon's strip included: if the light stays red while the strip is on screen, turn their effects off and check `bridgeridge.log` for `strip #N`.

## Troubleshooting

**`wow-ai` is not recognized.** Open a new terminal; `npm link` needs `%AppData%\npm` on the `PATH`, which the Node installer sets up but an already-open terminal doesn't see. Check with `npm prefix -g`: that folder must be in `$env:Path`.

**PowerShell says "running scripts is disabled on this system".** npm creates three launchers (`wow-ai`, `wow-ai.cmd`, `wow-ai.ps1`) and PowerShell prefers the `.ps1` one, which a *Restricted* execution policy blocks. Either allow local scripts for your user:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

or type `wow-ai.cmd` instead, which bypasses the policy.

**"Cannot read config.json … Run node setup.js".** The command is pointing at a copy of the repo that hasn't been set up (usually `npm install -g .` was used instead of `npm link`, or the repo folder was moved). Run `npm link` again from the repo folder you set up.

**The banner says `slots : NOT INSTALLED`.** `setup.js` couldn't write into the AddOns folder, or it wrote somewhere else. Check `addonDir` in `bridge\config.json`, then run `node bridge\install-slots.js` and relaunch the game.

**A reply says `… is not installed on the bridge PC`, or `Could not start …`.** The bridge looks for each agent in its installer's folder (`%UserProfile%\.local\bin\claude.exe`, `%UserProfile%\.grok\bin\grok.exe`), then for `<name>.exe` on the `PATH`, then behind npm's `<name>.cmd` launchers (how `npm install -g @openai/codex` installs Codex; for Codex, a `CODEX_BIN` environment variable is checked first). The banner shows what it found for each. If yours lives elsewhere, put the full path in `agents.<id>.path` in `bridge\config.json` and restart the bridge.

**A reply says the agent is not logged in, or the run ends in a timeout.** Run the CLI once by hand in a terminal on this PC (`claude`, `codex`, `grok login`) and finish the login; headless runs reuse it. Grok also stops for nothing else: the bridge passes `--no-auto-update`.

**The light stays red / "no sign of the bridge".** The bridge can't see the strip in the top-left corner of the game window. In order of likelihood: the game is in exclusive fullscreen (switch to windowed or borderless); the game window is minimized or on a monitor the bridge can't capture; `capture.processName` in the config doesn't match your game exe (`WowB` for Forever, the exe name without `.exe` for others; `setup.js` sets it from the exe it finds). `bridge\bridge.log` prints `attached to '...'` when it finds the window and `strip #N` when it decodes a message.

**Windows Defender or another antivirus complains about the slot files.** They are 15,000 empty or 124-byte files; nothing runs from them. Exclude `Interface\AddOns` if the scanner slows the bridge's writes down.

**Everything else** is in the README's Troubleshooting section and in `/wow-ai diag` in game.
