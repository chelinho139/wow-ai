'use strict';
// The files the bridge and setup hand to other programs by path: the capture
// scripts (spawned with python3 or PowerShell), the addon (copied into the
// game folder), config.example.json (setup's template) and the primer (read
// into the system prompt). From a checkout they are read where they are. The
// compiled binary carries them inside itself (build/entry.js embeds them,
// runtime.js says when that is the case), where python and the game cannot
// see them, so on first use it writes them out under <home>/assets/ and hands
// out those paths. A file there that differs from the embedded copy (an older
// binary wrote it, or someone edited it) is written again, so a binary always
// runs its own scripts and installs its own addon.
//
//   AS.file('bridge/capture_mac.py') -> an absolute path that exists
//   AS.dir('addon/ClaudeWoW')        -> the folder holding the addon's files
//
// Pure apart from the writes; tests/assets_test.js hands it a table and a
// folder of its own.

const fs = require('fs');
const path = require('path');
const R = require('./runtime');
const H = require('./home');

// Every file the binary needs that is not JavaScript. build/entry.js embeds
// exactly this list; tests/assets_test.js keeps the two, and the addon
// folder, in step.
const FILES = [
  'addon/ClaudeWoW/ClaudeWoW.lua',
  'addon/ClaudeWoW/ClaudeWoW.toc',
  'addon/ClaudeWoW/Codec.lua',
  'addon/ClaudeWoW/Inbox.lua',
  'addon/ClaudeWoW/Map.lua',
  'addon/ClaudeWoW/Roast.lua',
  'addon/ClaudeWoW/Voice.lua',
  'addon/ClaudeWoW/LootRoll.lua',
  'addon/ClaudeWoW/Achievements.lua',
  'addon/ClaudeWoW/Widgets.lua',
  'addon/ClaudeWoW/Window.lua',
  'addon/ClaudeWoW/Bindings.xml',
  'bridge/capture.ps1',
  'bridge/capture_mac.py',
  'bridge/capture_x11.py',
  'bridge/config.example.json',
  'docs/WOW-ADDON-PRIMER.md',
];
const DIR_NAME = 'assets';

let embedded = null; // rel -> where the embedded copy can be read (set by build/entry.js)
let checked = '';    // the folder the embedded set was last written to, this process

function embed(table) {
  for (const rel of FILES) if (!table || !table[rel]) throw new Error(`${rel} is not embedded`);
  embedded = table;
  checked = '';
}

// Write every file in `table` that is missing from `dir` or differs; return
// the names written.
function extract(dir, table = embedded) {
  const out = [];
  for (const rel of FILES) {
    const want = fs.readFileSync(table[rel]);
    const dest = path.join(dir, rel);
    let have = null;
    try { have = fs.readFileSync(dest); } catch {}
    if (have && have.equals(want)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, want);
    out.push(rel);
  }
  return out;
}

// The folder the repo-relative names resolve against: the checkout, or the
// extracted set in the home folder (checked once per process).
function root(home) {
  if (!embedded) return R.ROOT;
  const dir = path.join(home || H.resolve().dir, DIR_NAME);
  if (checked !== dir) { extract(dir); checked = dir; }
  return dir;
}

function file(rel, home) { return path.join(root(home), rel); }
const dir = file;
const isEmbedded = () => !!embedded;
function unembed() {
  embedded = null;
  checked = '';
}

module.exports = { FILES, DIR_NAME, embed, unembed, extract, root, file, dir, isEmbedded };
