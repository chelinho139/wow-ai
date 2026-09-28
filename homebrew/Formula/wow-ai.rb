# Homebrew formula for the WoW AI bridge and its `wow-ai` command.
# Lives in the tap rdimascio/homebrew-wow-ai as Formula/wow-ai.rb:
#
#   brew tap rdimascio/wow-ai
#   brew install --HEAD wow-ai      # head-only until the repo has a tagged release
#   wow-ai setup                    # the game-side install (addon, config, slot pool)
#   wow-ai service install          # optional: run it in the background, start at login
#
# Homebrew installs the bridge and the command; it cannot touch the game folder,
# so the addon goes in with `wow-ai setup`. See ../README.md for the split and
# the upgrade caveat before choosing this route over install.sh.
class WowAi < Formula
  desc "Chat with local coding agents from inside World of Warcraft (the bridge and CLI)"
  homepage "https://github.com/rdimascio/wow-ai"
  # No tagged release yet: head-only. When one exists, add
  #   url "https://github.com/rdimascio/wow-ai/archive/refs/tags/v0.5.0.tar.gz"
  #   sha256 "..."
  # and `brew install wow-ai` works without --HEAD.
  license "MIT"
  head "https://github.com/rdimascio/wow-ai.git", branch: "main"

  depends_on "node"
  # python3 is only needed for the pixel-capture transport (capture_mac.py);
  # the screenshot transport needs nothing beyond node. Left to the user.

  def install
    # The bridge keeps config.json, state.json, transcripts.json and bridge.log
    # next to its own code (bridge/), so the whole tree goes into libexec.
    libexec.install Dir["*"]
    chmod 0755, libexec/"bridge/supervisor.js"
    (bin/"wow-ai").write_env_script libexec/"bridge/supervisor.js",
      PATH: "#{formula_opt_bin("node")}:$PATH"
  end

  def caveats
    <<~EOS
      Homebrew installed the bridge and the wow-ai command only. The addon has to
      go into the game folder, which Homebrew cannot do:

        wow-ai setup                  # finds the client, installs the addon, writes the config
        wow-ai service install        # optional: run in the background, start at login

      The bridge keeps its config.json and saved sessions inside this keg
      (#{opt_libexec}/bridge). A `brew upgrade` or `brew reinstall`
      replaces that folder: run `wow-ai setup` again afterwards, and expect the
      agents' sessions to start fresh. If that bothers you, install.sh (see
      docs/INSTALL.md) keeps everything in ~/.wow-ai instead.
    EOS
  end

  test do
    assert_match "install", shell_output("#{bin}/wow-ai service help")
    assert_match "wow-ai [--project", shell_output("#{bin}/wow-ai --help")
  end
end
