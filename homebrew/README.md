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
brew install claude-wow          # the release binary (macOS arm64 and x64): no Node.js
brew install --HEAD claude-wow   # or the checkout, run with Homebrew's node
claude-wow setup                 # game side: addon, config.json, slot pool
claude-wow service install       # optional: background service
```

The stable formula fetches one self-contained binary (`build.js`: the bridge, setup
and the service commands with Bun's runtime inside) from the tagged release and
puts it in `bin` as `claude-wow`; nothing else is installed. `--HEAD` clones the
repo and runs it with Homebrew's `node`, as the formula always did. Until the first
tagged release exists, only `--HEAD` installs; the formula's two `sha256` lines are
filled in from the release's `SHA256SUMS` when it is cut.

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
brew install --HEAD --formula ./homebrew/Formula/claude-wow.rb   # (or without --HEAD once a release exists)
brew test claude-wow
claude-wow service help
brew uninstall claude-wow
```
