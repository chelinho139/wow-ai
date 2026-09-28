# Homebrew tap layout

This folder is the content of the tap repository `rdimascio/homebrew-wow-ai`
(Homebrew finds `brew tap rdimascio/wow-ai` at `github.com/rdimascio/homebrew-wow-ai`).
To publish it, copy `Formula/` into that repo as-is; nothing else is required.

```
homebrew-wow-ai/
  Formula/
    wow-ai.rb
```

Then:

```sh
brew tap rdimascio/wow-ai
brew install --HEAD wow-ai   # head-only until the repo has a tagged release
wow-ai setup                 # game side: addon, config.json, slot pool
wow-ai service install       # optional: background service
```

## The split, honestly

Homebrew can install the bridge and put `wow-ai` on the PATH. It cannot install
a WoW addon into the game folder, find your WoW account, or write a config that
depends on both: that is `wow-ai setup`, the same step every install route ends
with. So `brew install` alone gives you a `wow-ai` that says "run setup first".

## Why install.sh is the recommended route today

The bridge keeps its runtime state next to its own code: `bridge/config.json`,
`bridge/state.json` (the agents' session ids), `bridge/transcripts.json` and
`bridge/bridge.log`. Under Homebrew that folder is the keg
(`$(brew --prefix)/opt/wow-ai/libexec/bridge`), and `brew upgrade` or
`brew reinstall` replaces the keg wholesale. The formula works for a first
install, but every upgrade means `wow-ai setup` again and fresh agent sessions.
The `caveats` say so.

What would make it a good fit: the bridge (and `setup.js`) honouring a state
folder outside the code, e.g. `WOW_AI_HOME` defaulting to
`~/Library/Application Support/wow-ai`, so the keg holds only code. The formula's
bin script would then set that variable and upgrades would keep everything. That
touches `bridge/bridge.js`, which is being refactored separately at the time of
writing, so it is not done here.

## Checking the formula locally

```sh
brew install --HEAD --formula ./homebrew/Formula/wow-ai.rb
brew test wow-ai
wow-ai service help
brew uninstall wow-ai
```
