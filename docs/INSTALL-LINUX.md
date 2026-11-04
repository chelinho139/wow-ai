# Installing on Linux (Wine)

The addon is the same; only the bridge's screen capture differs. On Linux the bridge runs `bridge/capture_x11.py` (python3 + libX11 through ctypes, no packages to install) instead of `capture.ps1`, and writes the slot files straight into the Wine prefix.

## Requirements

- An **X11** session (`echo $XDG_SESSION_TYPE` prints `x11`). Wayland blocks reading other windows' pixels.
- The game under Wine (Lutris, Bottles, a hand-made prefix...), **windowed or borderless**.
- Node.js 22.2+, python3, and at least one agent CLI logged in (see [AGENTS.md](AGENTS.md)).

## Install

```bash
git clone https://github.com/chelinho139/wow-ai
cd wow-ai
npm ci                      # only needed to run the tests
node setup.js --wow "$HOME/.wine/drive_c/Program Files (x86)/World of Warcraft/_forever_" --project ~/path/to/the/project
```

Without `--wow`, `setup.js` looks in `$WINEPREFIX`, `~/.wine` and `~/Games/battlenet`. Then fully restart the game, enable *WoW AI* on the AddOns screen, and start the bridge with `npm start`.

## Check the capture (do this once)

Log in, open the WoW AI window and send any message, then while the strip of colored squares is in the top-left corner run:

```bash
npm run probe
```

It finds the game window, saves what the capture sees to `bridge/probe.png`, and prints whether it could decode a strip. If the picture is black or stale while the game shows the strip, the compositor is letting the game flip its own buffers. Try, in order:

1. `"keepComposited": true` under `capture` in `bridge/config.json` (asks mutter/KWin to keep compositing the game window), then restart the bridge.
2. Plain windowed mode in the game settings.
3. `nvidia-settings -a AllowFlipping=0` (NVIDIA).
4. As a last resort `/wow-ai mode reload` in game: no capture at all, one UI reload per message.

`bridge.log` shows `capture: attached to window 0x...` once the window is found. If it keeps saying `waiting for Wow window`, set `capture.processName` to your executable's name, or `capture.windowName` to part of the window title. `capture.python` picks the interpreter if `python3` is not the one on your `PATH`.
