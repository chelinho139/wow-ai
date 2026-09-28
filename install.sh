#!/bin/sh
# Claude WoW installer for macOS and Linux. One line:
#
#   curl -fsSL https://raw.githubusercontent.com/rdimascio/claude-wow/main/install.sh | sh
#
# With options (everything after `-s --` goes to the script):
#
#   curl -fsSL https://raw.githubusercontent.com/rdimascio/claude-wow/main/install.sh | sh -s -- --wow "/Applications/World of Warcraft/_classic_beta_" --project ~/code/my-game --service
#
#   --wow <folder>      the WoW client folder (setup.js looks in the usual places without it)
#   --project <folder>  the default folder the agents work in
#   --service           install the background service without asking
#   --no-service        don't install or ask
#   --dir <folder>      where to put the code (default ~/.claude-wow/app; or CLAUDE_WOW_DIR)
#   --ref <branch|tag>  which version (default main; or CLAUDE_WOW_REF)
#
# What it does, in order, and it is safe to run again (an existing install is
# updated, config.json and your chats are kept):
#   1. checks for Node.js 22.2+ (and says how to get it if not)
#   2. clones the repo into ~/.claude-wow/app with git, or downloads the tarball
#      (there is nothing to npm-install: the bridge has no runtime dependencies)
#   3. puts a `claude-wow` command in ~/.local/bin
#   4. runs the game-side setup (addon, config.json, slot pool); config, state
#      and logs live in ~/.claude-wow (CLAUDE_WOW_HOME), outside the code
#   5. offers to install the background service
# An install by the project's old name (~/.wow-ai, the wow-ai command, the
# io.wowai.bridge service) is carried over: its config and sessions are copied
# to ~/.claude-wow, its service and command are removed, and setup migrates
# the addon and your chats in the game folder.
# Never sudo. Any failure stops with a message saying what to do.

set -eu

REPO_URL=${CLAUDE_WOW_REPO:-https://github.com/rdimascio/claude-wow}
REF=${CLAUDE_WOW_REF:-main}
HOME_DIR=${CLAUDE_WOW_HOME:-$HOME/.claude-wow}
DIR=${CLAUDE_WOW_DIR:-$HOME_DIR/app}
BIN_DIR=${CLAUDE_WOW_BIN:-$HOME/.local/bin}
OLD_DIR=$HOME/.wow-ai
MIN_NODE=22.2
WOW=${CLAUDE_WOW_WOW:-}
PROJECT=${CLAUDE_WOW_PROJECT:-}
SERVICE=ask

say()  { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
fail() {
  printf '\ninstall failed: %s\n' "$1" >&2
  [ $# -gt 1 ] && printf '  -> %s\n' "$2" >&2
  exit 1
}

# Is a node version string (v22.2.0, 22.10.1) at least MIN_NODE? Pure; used by the tests.
node_ok() {
  v=${1#v}
  maj=${v%%.*}
  case "$v" in *.*) rest=${v#*.}; min=${rest%%.*} ;; *) min=0 ;; esac
  case "$maj$min" in *[!0-9]*|'') return 1 ;; esac
  want_maj=${MIN_NODE%%.*}; want_min=${MIN_NODE#*.}
  [ "$maj" -gt "$want_maj" ] || { [ "$maj" -eq "$want_maj" ] && [ "$min" -ge "$want_min" ]; }
}

os_name() { case "$(uname -s)" in Darwin) echo macOS ;; Linux) echo Linux ;; *) uname -s ;; esac; }

node_hint() {
  if [ "$(os_name)" = macOS ]; then
    echo "Install it with Homebrew (brew install node) or the installer at https://nodejs.org, open a new terminal, and run this again."
  else
    echo "Install it from your package manager, https://nodejs.org, or with fnm (https://github.com/Schniz/fnm), open a new terminal, and run this again."
  fi
}

# Ask on the terminal even when the script itself came in on stdin (curl | sh).
ask() {
  answer=
  if ( : < /dev/tty ) 2>/dev/null; then
    printf '%s' "$1" > /dev/tty
    read -r answer < /dev/tty || answer=
  fi
  case "$answer" in y|Y|yes|YES|Yes) return 0 ;; *) return 1 ;; esac
}

rc_file() {
  case "${SHELL:-}" in
    */zsh) echo "$HOME/.zshrc" ;;
    */fish) echo "$HOME/.config/fish/config.fish" ;;
    *) if [ "$(os_name)" = macOS ]; then echo "$HOME/.bash_profile"; else echo "$HOME/.bashrc"; fi ;;
  esac
}

get_code() {
  if [ -d "$DIR/.git" ]; then
    say "updating the existing install in $DIR"
    if git -C "$DIR" pull --ff-only --quiet 2>/dev/null; then
      say "up to date with $REF"
    else
      say "warning: could not fast-forward $DIR (local changes or no network); keeping what is there"
    fi
    return
  fi
  if [ -e "$DIR" ] && [ ! -f "$DIR/setup.js" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
    fail "$DIR exists and is not a claude-wow install" "Pick another folder with --dir <folder> (or CLAUDE_WOW_DIR), or move that one aside."
  fi
  if command -v git >/dev/null 2>&1 && [ ! -f "$DIR/setup.js" ]; then
    say "cloning $REPO_URL ($REF) into $DIR"
    git clone --quiet --depth 1 --branch "$REF" "$REPO_URL" "$DIR" || fail "git clone failed" "Check the network and that $REPO_URL is reachable, then run this again."
    return
  fi
  # No git (or a previous tarball install to refresh): download the archive.
  command -v curl >/dev/null 2>&1 || fail "neither git nor curl is available" "Install git (macOS: xcode-select --install) and run this again."
  command -v tar >/dev/null 2>&1 || fail "tar is not available" "Install tar from your package manager and run this again."
  tmp=$(mktemp -d 2>/dev/null || mktemp -d -t claude-wow)
  say "downloading $REPO_URL/archive/refs/heads/$REF.tar.gz"
  if ! curl -fsSL "$REPO_URL/archive/refs/heads/$REF.tar.gz" | tar -xz -C "$tmp" 2>/dev/null; then
    curl -fsSL "$REPO_URL/archive/refs/tags/$REF.tar.gz" | tar -xz -C "$tmp" || fail "download failed" "Check the network, or install git and run this again."
  fi
  src=$(find "$tmp" -mindepth 1 -maxdepth 1 -type d | head -n 1)
  [ -f "$src/setup.js" ] || fail "the archive did not contain claude-wow" "Try again with git installed."
  mkdir -p "$DIR"
  # cp over the old files; config.json, state.json and transcripts.json are not in the archive, so they survive.
  cp -R "$src/." "$DIR/"
  rm -rf "$tmp"
  say "installed into $DIR (no git: run this script again to update)"
}

# An install under the old name: its config and the agents' sessions move to
# the home folder (once; setup then rewrites the addon paths inside), its
# background service is removed so it stops starting the old bridge at login,
# and its command goes. The old code folder is left for you to delete.
migrate_old_install() {
  [ -d "$OLD_DIR" ] || return 0
  if [ -f "$OLD_DIR/bridge/config.json" ] && [ ! -f "$HOME_DIR/config.json" ]; then
    mkdir -p "$HOME_DIR" || fail "cannot create $HOME_DIR"
    for f in config.json state.json transcripts.json; do
      [ -f "$OLD_DIR/bridge/$f" ] && cp "$OLD_DIR/bridge/$f" "$HOME_DIR/$f"
    done
    say "carried config.json, state.json and transcripts.json over from $OLD_DIR/bridge to $HOME_DIR"
    # The old service would keep starting the old bridge; the new one is installed in step 5 if wanted.
    "$NODE_BIN" "$DIR/bridge/supervisor.js" service uninstall >/dev/null 2>&1 || true
  fi
  if [ -f "$BIN_DIR/wow-ai" ] && grep -q "$OLD_DIR" "$BIN_DIR/wow-ai" 2>/dev/null; then
    rm -f "$BIN_DIR/wow-ai"
    say "removed the old wow-ai command ($BIN_DIR/wow-ai); it is claude-wow from now on"
  fi
  say "the old code in $OLD_DIR is no longer used; delete it when you like"
}

install_command() {
  mkdir -p "$BIN_DIR" || fail "cannot create $BIN_DIR" "Pick another folder with CLAUDE_WOW_BIN=<folder>."
  cat > "$BIN_DIR/claude-wow" <<EOF
#!/bin/sh
# Claude WoW: written by install.sh. Runs the bridge from $DIR.
NODE=\$(command -v node 2>/dev/null || echo "$NODE_BIN")
exec "\$NODE" "$DIR/bridge/supervisor.js" "\$@"
EOF
  chmod +x "$BIN_DIR/claude-wow"
  say "claude-wow command: $BIN_DIR/claude-wow"
  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *)
      rc=$(rc_file)
      line="export PATH=\"$BIN_DIR:\$PATH\""
      [ "${rc##*/}" = config.fish ] && line="fish_add_path $BIN_DIR"
      if [ -f "$rc" ] && grep -Fq "$BIN_DIR" "$rc" 2>/dev/null; then
        say "$BIN_DIR is already in $rc; open a new terminal for the claude-wow command"
      elif ask "$BIN_DIR is not on your PATH. Add it to $rc? [y/N] "; then
        printf '\n# claude-wow\n%s\n' "$line" >> "$rc"
        say "added to $rc; open a new terminal for the claude-wow command"
      else
        say "to use the claude-wow command, add this to $rc:  $line"
      fi
      ;;
  esac
}

main() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --wow) WOW=${2:-}; shift ;;
      --project) PROJECT=${2:-}; shift ;;
      --dir) DIR=${2:-}; shift ;;
      --ref) REF=${2:-}; shift ;;
      --service) SERVICE=yes ;;
      --no-service) SERVICE=no ;;
      --node-ok) node_ok "${2:-}" && { echo ok; exit 0; } || { echo "too old: need $MIN_NODE"; exit 1; } ;;
      -h|--help) sed -n '2,25p' "$0" 2>/dev/null || say "see the header of install.sh"; exit 0 ;;
      *) fail "unknown option $1" "Options: --wow <folder> --project <folder> --service --no-service --dir <folder> --ref <ref>" ;;
    esac
    shift
  done
  [ "$(id -u 2>/dev/null || echo 1000)" -ne 0 ] || fail "do not run this as root" "Run it as the user who plays the game; nothing here needs sudo."

  step "1/5 Node.js"
  command -v node >/dev/null 2>&1 || fail "Node.js is not installed (or not on the PATH)" "$(node_hint)"
  NODE_BIN=$(command -v node)
  NODE_VER=$(node -v 2>/dev/null || echo unknown)
  node_ok "$NODE_VER" || fail "Node.js $NODE_VER is too old; $MIN_NODE or newer is required" "$(node_hint)"
  say "node $NODE_VER ($NODE_BIN)"

  step "2/5 The code"
  get_code
  [ -f "$DIR/setup.js" ] || fail "$DIR does not contain setup.js after the download" "Remove $DIR and run this again."

  step "3/5 The claude-wow command"
  install_command
  migrate_old_install

  step "4/5 Game-side setup (addon, config, slot pool)"
  set --
  [ -n "$WOW" ] && set -- "$@" --wow "$WOW"
  [ -n "$PROJECT" ] && set -- "$@" --project "$PROJECT"
  if ! (cd "$DIR" && "$NODE_BIN" setup.js "$@"); then
    fail "the game-side setup did not finish (see above)" \
      "The code and the claude-wow command are installed. Fix what setup reported (usually: pass the client folder), then run:  claude-wow setup --wow \"<World of Warcraft/_classic_beta_>\""
  fi

  step "5/5 Background service"
  if [ "$SERVICE" = no ]; then
    say "skipped (install later with: claude-wow service install)"
  elif [ "$SERVICE" = yes ] || ask "Run the bridge in the background and start it at login? [y/N] "; then
    "$NODE_BIN" "$DIR/bridge/supervisor.js" service install || fail "the service did not install (see above)" "Everything else is in place; start the bridge by hand with: claude-wow"
  else
    say "skipped (install later with: claude-wow service install; or start the bridge by hand with: claude-wow)"
  fi

  printf '\nInstalled. From here on, the claude-wow command does what "npm start" does above, from any folder. Next:\n'
  say "  1. Fully quit and relaunch World of Warcraft (it only discovers new addon files at launch)."
  say "  2. Enable \"Claude WoW\" at the character-select AddOns screen."
  if [ "$SERVICE" = no ]; then
    say "  3. Start the bridge:  claude-wow        (or: claude-wow service install, to keep it running in the background)"
  else
    say "  3. Check the bridge:  claude-wow service status     (logs: claude-wow service logs)"
  fi
  say "  4. In game:  /claude"
  say ""
  say "Update later by running this installer again. Code: $DIR"
}

main "$@"
