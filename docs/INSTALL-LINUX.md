# Linux (Wine) notes

The install itself is in [INSTALL.md](INSTALL.md): the one-line installer, or by hand with git. This page keeps what is specific to Linux: the session requirements, where the client lives, the background service under systemd, and how to check the screen capture.

The addon is the same as on Windows; only the bridge's screen capture differs. On Linux the pixel transport runs `bridge/capture_x11.py` (python3 + libX11 through ctypes, no packages to install) instead of `capture.ps1`, and the bridge writes the slot files straight into the Wine prefix. The screenshot transport (`"mode": "screenshot"` under `capture` in `~/.claude-wow/config.json`) needs no capture at all.

## Requirements

- The game under Wine (Lutris, Bottles, a hand-made prefix...), **windowed or borderless**.
- For the pixel transport: an **X11** session (`echo $XDG_SESSION_TYPE` prints `x11`) and python3. Wayland blocks reading other windows' pixels; the screenshot transport works there.
- Node.js 22.2+, and at least one agent CLI logged in (see [AGENTS.md](AGENTS.md)).

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/rdimascio/claude-wow/main/install.sh | sh -s -- --project ~/path/to/the/project
```

Without `--wow`, setup looks in `$WINEPREFIX`, `~/.wine` and `~/Games/battlenet` for `drive_c/Program Files (x86)/World of Warcraft/_classic_beta_`; pass `--wow "<that folder>"` for anything else. By hand: `git clone https://github.com/rdimascio/claude-wow && cd claude-wow && node setup.js --wow "..." --project ...`, then `npm start` (`npm ci` is only needed to run the tests).

Then fully restart the game, enable *Claude WoW* on the AddOns screen, and either leave `claude-wow` running in a terminal or install the service.

## The service under systemd

`claude-wow service install` writes `~/.config/systemd/user/claude-wow-bridge.service` and runs `systemctl --user enable --now` on it: the bridge starts with your session and systemd restarts it after any exit. `claude-wow service status|logs|stop|start|restart|uninstall` wrap `systemctl --user`; the bridge's output goes to `~/.local/state/claude-wow/bridge.log` (`$XDG_STATE_HOME/claude-wow`), rotated at 5 MB, and `journalctl --user -u claude-wow-bridge` has the supervisor's own messages. The unit carries the `PATH` and `DISPLAY` you had when you installed it (the pixel capture needs `DISPLAY`; the screenshot transport does not), so re-run `claude-wow service install` after installing a new agent CLI. If you want the bridge up before you log in graphically, `loginctl enable-linger $USER`; it is not needed for the usual "starts when I log in".

## Check the capture (pixel transport, do this once)

Log in, open the Claude WoW window and send any message, then while the strip of colored squares is in the top-left corner run:

```bash
npm run probe        # in the repo folder (~/.claude-wow/app with the installer)
```

It finds the game window, saves what the capture sees to `bridge/probe.png`, and prints whether it could decode a strip. If the picture is black or stale while the game shows the strip, the compositor is letting the game flip its own buffers. Try, in order:

1. `"keepComposited": true` under `capture` in `~/.claude-wow/config.json` (asks mutter/KWin to keep compositing the game window), then restart the bridge.
2. Plain windowed mode in the game settings.
3. `nvidia-settings -a AllowFlipping=0` (NVIDIA).
4. `"mode": "screenshot"` under `capture`: no capture at all, the addon screenshots the strip.
5. As a last resort `/claude-wow mode reload` in game: one UI reload per message.

The log shows `capture: attached to window 0x...` once the window is found. If it keeps saying `waiting for WowB window`, set `capture.processName` to your executable's name, or `capture.windowName` to part of the window title. `capture.python` picks the interpreter if `python3` is not the one on your `PATH`.
