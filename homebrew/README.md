# Homebrew tap layout

This folder is the content of the tap repository `rdimascio/homebrew-claude-wow`
(Homebrew finds `brew tap rdimascio/claude-wow` at `github.com/rdimascio/homebrew-claude-wow`).
To publish it, copy `Formula/` into that repo as-is; nothing else is required.

```
homebrew-claude-wow/
  Formula/
    claude-wow.rb
```

Then:

```sh
brew tap rdimascio/claude-wow
brew install --HEAD claude-wow   # head-only until the repo has a tagged release
claude-wow setup                 # game side: addon, config.json, slot pool
claude-wow service install       # optional: background service
```

## The split, honestly

Homebrew can install the bridge and put `claude-wow` on the PATH. It cannot install
a WoW addon into the game folder, find your WoW account, or write a config that
depends on both: that is `claude-wow setup`, the same step every install route ends
with. So `brew install` alone gives you a `claude-wow` that says "run setup first".

## Upgrades keep your config and sessions

The keg holds only code. The bridge keeps `config.json`, `state.json` (the agents'
session ids), `transcripts.json`, `bridge.log` and its scratch folders in a home
folder outside the code: `CLAUDE_WOW_HOME` when set, else `~/.claude-wow`
(`bridge/home.js`). `brew upgrade` or `brew reinstall` replaces the keg and touches
none of that; `claude-wow service restart` afterwards picks up the new code, and
`claude-wow setup` is only needed again when the addon itself changed.

## Checking the formula locally

```sh
brew install --HEAD --formula ./homebrew/Formula/claude-wow.rb
brew test claude-wow
claude-wow service help
brew uninstall claude-wow
```
