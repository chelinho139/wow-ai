'use strict';
// CLAUDE_WOW_HOME: where the bridge keeps what is not code. config.json,
// state.json (the agents' sessions, keyed by chat), transcripts.json, bridge.log,
// tmp/ (prompt files and vision PNGs for a run) and mapjobs/ live there, so the
// code can be replaced (git pull, brew upgrade, the installer run again) without
// touching any of it. Resolution, first match wins:
//
//   1. $CLAUDE_WOW_HOME, when set (a leading ~ expands)
//   2. ~/.claude-wow, once it holds a config.json
//   3. this checkout's bridge/ folder, while it holds a config.json: the layout
//      from before there was a home folder. setup.js copies it to 2 on its next
//      run (never into an explicit CLAUDE_WOW_HOME: that one is the user's call)
//   4. ~/.claude-wow: a fresh install; setup.js writes the config there
//
// Pure apart from the existence checks, so tests/home_test.js can hand it an
// environment, a home folder and a legacy folder of its own.

const fs = require('fs');
const os = require('os');
const path = require('path');

const LEGACY_DIR = __dirname;
const FILES = ['config.json', 'state.json', 'transcripts.json']; // what setup.js carries over
const DIR_NAME = '.claude-wow';

function expand(p, home) {
  return path.resolve(String(p).replace(/^~(?=[\\/]|$)/, home));
}

function defaultDir(home = os.homedir()) {
  return path.join(home, DIR_NAME);
}

function hasConfig(dir) {
  try { return fs.statSync(path.join(dir, 'config.json')).isFile(); } catch { return false; }
}

function paths(dir, source) {
  return {
    dir, source,
    config: path.join(dir, 'config.json'),
    state: path.join(dir, 'state.json'),
    transcripts: path.join(dir, 'transcripts.json'),
    log: path.join(dir, 'bridge.log'),
    tmp: path.join(dir, 'tmp'),
    mapjobs: path.join(dir, 'mapjobs'),
  };
}

function resolve(env = process.env, home = os.homedir(), legacy = LEGACY_DIR) {
  if (env.CLAUDE_WOW_HOME) return paths(expand(env.CLAUDE_WOW_HOME, home), 'CLAUDE_WOW_HOME');
  const dflt = defaultDir(home);
  if (hasConfig(dflt)) return paths(dflt, 'default');
  if (hasConfig(legacy)) return paths(legacy, 'legacy');
  return paths(dflt, 'default');
}

// The first setup after the upgrade: bring config, state and transcripts over
// from bridge/ to ~/.claude-wow. Copies, not moves: an older checkout of this
// repo still reads bridge/, and nothing here may be able to lose a session.
// Returns the names of the files copied (none when there was nothing to do).
function migrateLegacy(env = process.env, home = os.homedir(), legacy = LEGACY_DIR) {
  if (env.CLAUDE_WOW_HOME) return [];
  const dflt = defaultDir(home);
  if (path.resolve(dflt) === path.resolve(legacy) || hasConfig(dflt) || !hasConfig(legacy)) return [];
  fs.mkdirSync(dflt, { recursive: true });
  const copied = [];
  for (const f of FILES) {
    const from = path.join(legacy, f);
    if (!fs.existsSync(from)) continue;
    fs.copyFileSync(from, path.join(dflt, f));
    copied.push(f);
  }
  return copied;
}

module.exports = { LEGACY_DIR, FILES, DIR_NAME, defaultDir, hasConfig, resolve, migrateLegacy };
