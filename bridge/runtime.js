'use strict';
// Which runtime this is, and how to run this project's own scripts on it.
//
// Node and Bun run the checkout the same way, and nothing else in the bridge
// needs to know which one it is on. The compiled binary (bun build --compile;
// see build.js) is different in two ways, and this module is the one place
// that knows:
//
//   - process.execPath is the bridge itself, not an interpreter. "Run
//     bridge.js with this node" becomes "run this binary with a subcommand"
//     (claude-wow bridge, claude-wow setup, claude-wow install-slots; the
//     supervisor maps them back), and a JavaScript launcher an agent CLI ships
//     (npm's codex.js) needs a real node found on the PATH.
//   - the sources are inside the binary: __dirname names the folder they were
//     built from, which exists nowhere else. Files handed to other programs
//     by path go through assets.js instead.
//
// Pure apart from the PATH lookup, so tests can hand it a runtime of their own.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Bun's compiled binaries load their bundle from a virtual folder: /$bunfs/
// on macOS and Linux, B:\~BUN\ on Windows. A plain `bun bridge/bridge.js` does not.
const bun = !!process.versions.bun;
const compiled = bun && typeof Bun !== 'undefined' && /^(\/\$bunfs\/|[A-Za-z]:\\~BUN\\)/.test(String(Bun.main || ''));

const DEFAULT = { compiled, execPath: process.execPath, root: ROOT };

// The scripts the bridge runs as processes of their own, and the subcommand
// each one is inside the binary.
const SCRIPTS = {
  supervisor: 'bridge/supervisor.js',
  bridge: 'bridge/bridge.js',
  setup: 'setup.js',
  'install-slots': 'bridge/install-slots.js',
};

// [file, args]: what to spawn to run one of this project's scripts. From a
// checkout it is this runtime and the script's path, as it always was; from
// the binary it is the binary and the script's subcommand (the supervisor is
// the binary itself, so no subcommand).
function scriptCommand(name, args = [], r = DEFAULT) {
  const rel = SCRIPTS[name];
  if (!rel) throw new Error(`no script called "${name}"`);
  if (r.compiled) return [r.execPath, name === 'supervisor' ? [...args] : [name, ...args]];
  return [r.execPath, [path.join(r.root, rel), ...args]];
}

function isFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }

// { file, found, note }: a node that can run a JavaScript file. From a
// checkout, this process's own interpreter. From the binary, the node (else
// the bun) on the PATH: an agent CLI installed with npm has one.
function node(r = DEFAULT, env = process.env, platform = process.platform) {
  if (!r.compiled) return { file: r.execPath, found: true };
  const names = platform === 'win32' ? ['node.exe', 'bun.exe'] : ['node', 'bun'];
  for (const dir of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const n of names) {
      const f = path.join(dir, n);
      if (isFile(f)) return { file: f, found: true };
    }
  }
  return { file: platform === 'win32' ? 'node.exe' : 'node', found: false, note: 'it is a JavaScript launcher and no node is on the PATH (https://nodejs.org)' };
}

// One line for the banner and the logs.
function describe(r = DEFAULT, versions = process.versions) {
  if (r.compiled) return `claude-wow binary (bun ${versions.bun})`;
  return versions.bun ? `bun ${versions.bun}` : `node ${versions.node}`;
}

module.exports = { ROOT, SCRIPTS, bun, compiled, DEFAULT, scriptCommand, node, describe };
