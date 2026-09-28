# Homebrew formula for the Claude WoW bridge and its `claude-wow` command.
# Lives in the tap rdimascio/homebrew-claude-wow as Formula/claude-wow.rb:
#
#   brew tap rdimascio/claude-wow
#   brew install --HEAD claude-wow  # head-only until the repo has a tagged release
#   claude-wow setup                # the game-side install (addon, config, slot pool)
#   claude-wow service install      # optional: run it in the background, start at login
#
# Homebrew installs the bridge and the command; it cannot touch the game folder,
# so the addon goes in with `claude-wow setup`. The keg holds only code: the
# config, the agents' sessions, transcripts and logs live in ~/.claude-wow
# (CLAUDE_WOW_HOME), so `brew upgrade` keeps them. See ../README.md.
class ClaudeWow < Formula
  desc "Claude in World of Warcraft: chat with local coding agents from inside the game (the bridge and CLI)"
  homepage "https://github.com/rdimascio/claude-wow"
  # No tagged release yet: head-only. When one exists, add
  #   url "https://github.com/rdimascio/claude-wow/archive/refs/tags/v0.5.0.tar.gz"
  #   sha256 "..."
  # and `brew install claude-wow` works without --HEAD.
  license "MIT"
  head "https://github.com/rdimascio/claude-wow.git", branch: "main"

  depends_on "node"
  # python3 is only needed for the pixel-capture transport (capture_mac.py);
  # the screenshot transport needs nothing beyond node. Left to the user.

  def install
    # Code only. The bridge keeps config.json, state.json, transcripts.json,
    # bridge.log and its scratch folders in ~/.claude-wow (bridge/home.js), never
    # in the keg, so an upgrade replaces nothing the user cares about.
    libexec.install Dir["*"]
    chmod 0755, libexec/"bridge/supervisor.js"
    (bin/"claude-wow").write_env_script libexec/"bridge/supervisor.js",
      PATH: "#{formula_opt_bin("node")}:$PATH"
  end

  def caveats
    <<~EOS
      Homebrew installed the bridge and the claude-wow command only. The addon has
      to go into the game folder, which Homebrew cannot do:

        claude-wow setup              # finds the client, installs the addon, writes the config
        claude-wow service install    # optional: run in the background, start at login

      Your config, the agents' sessions and the logs live in ~/.claude-wow
      (or $CLAUDE_WOW_HOME), outside this keg, so `brew upgrade` keeps them.
      After an upgrade, `claude-wow service restart` picks up the new code.
    EOS
  end

  test do
    assert_match "install", shell_output("#{bin}/claude-wow service help")
    assert_match "claude-wow [--project", shell_output("#{bin}/claude-wow --help")
  end
end
