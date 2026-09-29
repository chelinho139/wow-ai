# Rename: wow-ai -> claude-wow

**Status: done** (branch `macos-ci-and-setup-checks`, one commit per surface: addon,
bridge, package/CLI, service/install, docs). Where the code differed from the plan
below, the code won:

- `WoWAIProbeFrame` does not exist in the addon; the frames are `WoWAIFrame`,
  `WoWAIStrip`, `WoWAIMini` and so on, all renamed to `ClaudeWoW*`.
- The optional node data addon is `ClaudeWoW_Nodes` (global `ClaudeWoWNodes`); it is
  this project's format and nobody ships one yet, so no fallback to `WoWAI_Nodes`.
- `/r`, `/aimap` and `/aiwhisper` are commands of their own, not aliases of the main
  one, and stay.
- The installer puts the code in `~/.claude-wow/app`, not `~/.claude-wow`: the home
  folder (`CLAUDE_WOW_HOME`, default `~/.claude-wow`) holds config, state and logs,
  and a git clone and a `config.json` cannot share one folder without the
  installer's "exists and is not an install" check misfiring for Homebrew users.
- Config, state and transcripts are copied from `bridge/` to `~/.claude-wow`, not
  moved, so an older checkout (the open upstream PR branches) still runs.
- The GitHub repo itself has not been renamed yet (last step, once this is merged).

Run this as one pass, after the plugin-seam and install/service work lands. The
project has done this once before (`wow-claude` -> `wow-ai`), and `setup.js` still
carries that migration; this rename follows the same shape and should absorb it, so
setup ends up migrating from either old name.

## Surfaces to change

**Repo and package**
- GitHub repo `wow-ai` -> `claude-wow` (GitHub redirects the old URL; keep it).
- `package.json`: `name`, `description`, `repository`, `bin` (`wow-ai` -> `claude-wow`),
  keywords.

**Addon (game side)**
- Folder `Interface/AddOns/WoWAI` -> `ClaudeWoW`.
- Slot pool `WoWAI_S###` -> `ClaudeWoW_S###` (200 folders + their `.toc`).
- `WoWAI.toc` -> `ClaudeWoW.toc`, Title/Notes text.
- Lua globals: `WoWAI_Inbox`, `WoWAI_SlotData`, `WoWAI_Codec`, `WoWAIDB`,
  `WoWAIProbeFrame` -> `ClaudeWoW*`.
- Saved variables `WoWAI.lua` -> `ClaudeWoW.lua`, and the `## SavedVariables` line.
- Signal/heartbeat paths are under the addon folder, so they move with it.

**Slash commands**
- `/claude` and `/claude-wow` only. Every old alias goes: `/wow-ai`, `/wowai`, `/ai`,
  `/ask`, `/wow-claude`. Clean break, no deprecation period.

**Bridge**
- `bridge/config.json` paths that name the addon (`addonDir`, `inboxFile`,
  `savedVariablesFile`). The bridge already derives these from `addonDir` when the
  stored value names an old addon; extend that rule rather than replacing it.
- Env vars `WOW_AI_MAP_FILE`, `WOW_AI_PROJECT`, `WOWAI_MAC_BACKEND` -> `CLAUDE_WOW_*`,
  reading the old names as a fallback.
- Log/state files keep their names; they live in `bridge/`.
- Introduce `CLAUDE_WOW_HOME` for config/state/logs, defaulting to `~/.claude-wow`,
  falling back to the repo folder when it already holds a config. Homebrew needs this:
  today config and state live inside the install directory, so `brew upgrade` wipes
  them. Migrate an existing `bridge/config.json` on first run.

**Service and install**
- LaunchAgent id `io.wowai.bridge` -> `io.claudewow.bridge`; systemd unit name; the
  installer's target directory; the Homebrew formula and tap name.
- `service install` must remove an old-id agent before writing the new one, or the
  user ends up with two bridges at login.

**Install and one-liners**
- `install.sh` / `install.ps1`: target dir `~/.wow-ai` -> `~/.claude-wow`, the binary
  name, and the raw GitHub URL they are fetched from.
- The Homebrew formula and tap name.

**Docs**
- README, `docs/*.md`, CHANGELOG. Add a "Renamed from wow-ai" note.

## Migration (setup.js)

Generalise the existing `migrateOldInstall`: for each old name in `["WoWClaude",
"WoWAI"]`, carry the saved data over (rewriting the DB global), delete the old addon
folder and its slot pool so two addons do not fight over the slash commands, and
bring `config.json` paths up to date. Chats and agent sessions must survive —
sessions are keyed by chat id, so they do if the saved data carries over.

## Order

1. Land the in-flight work first; this touches nearly every file.
2. Rename in one commit per surface (addon, bridge, package/CLI, service/install, docs)
   so a bisect stays useful.
3. `npm test` green at each step; the addon stub in `tests/wow_stub.lua` and
   `tests/addon_test.js` reference the globals by name.
4. Verify in game on a copy first: the migration must not lose chats.
5. Rename the GitHub repo last, once the code is consistent.

## Not renaming

The four open upstream PRs (#13-16) target `chelinho139/wow-ai` and must keep the
upstream naming. Do not let the rename leak into those branches.
