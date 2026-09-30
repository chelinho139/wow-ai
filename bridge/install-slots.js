#!/usr/bin/env node
'use strict';
// Creates the reply-slot addons and signal files that the no-reload transport needs.
// WoW only indexes addon folders and files at launch, so run this once, then restart
// the game. Safe to re-run: existing files are left alone.

const fs = require('fs');
const path = require('path');
const G = require('./gamefs');

const HOME = require('./home').resolve();
const cfg = JSON.parse(fs.readFileSync(HOME.config, 'utf8'));
const addons = cfg.addonDir;
const N = cfg.slots || 200;
const ACT = cfg.actMax || 60;
const PRESENCE = cfg.presenceMax || 2000;
const iface = cfg.tocInterface || '16001';

if (!fs.existsSync(path.join(addons, 'ClaudeWoW', 'ClaudeWoW.toc'))) {
  console.error('ClaudeWoW addon not found under ' + addons);
  process.exit(1);
}

let made = 0, kept = 0, cleaned = 0, updated = 0;
function ensureDir(dir) {
  G.mkdir(dir);
}
// Signal files are "on" by existing, so an off one must not be on disk at all.
// Older installs pre-created them empty, which this client reads as playable;
// sweep those away or every signal would read as permanently on.
function cleanEmpty(file) {
  try {
    if (fs.existsSync(file) && fs.statSync(file).size === 0) { fs.rmSync(file, { force: true }); cleaned++; }
  } catch {}
}
function ensure(file, content, { replaceWhenDifferent = false } = {}) {
  if (fs.existsSync(file)) {
    if (replaceWhenDifferent && fs.readFileSync(file, 'utf8') !== content) { G.writeFile(file, content); updated++; return; }
    kept++;
    return;
  }
  G.mkdir(path.dirname(file));
  G.writeFile(file, content);
  made++;
}

for (let i = 1; i <= N; i++) {
  const name = 'ClaudeWoW_S' + String(i).padStart(3, '0');
  const dir = path.join(addons, name);
  ensure(path.join(dir, name + '.toc'), [
    '## Interface: ' + iface,
    '## Title: Claude WoW slot ' + String(i).padStart(3, '0'),
    '## Notes: Reply slot for Claude WoW. Load-on-demand; leave it enabled.',
    '## LoadOnDemand: 1',
    '## Dependencies: ClaudeWoW',
    '',
    'Inbox.lua',
    '',
  ].join('\n'), { replaceWhenDifferent: true });
  ensure(path.join(dir, 'Inbox.lua'), 'ClaudeWoW_SlotData = nil\n');
  // No file = no signal, so only the folders are made here; the bridge creates a
  // .wav when it has something to say and deletes it to take it back.
  cleanEmpty(path.join(addons, 'ClaudeWoW', 'sig', String(i).padStart(3, '0') + '.wav'));
  cleanEmpty(path.join(addons, 'ClaudeWoW', 'ack', String(i).padStart(3, '0') + '.wav'));
  ensureDir(path.join(addons, 'ClaudeWoW', 'act', String(i).padStart(3, '0')));
  for (let k = 1; k <= ACT; k++) {
    cleanEmpty(path.join(addons, 'ClaudeWoW', 'act', String(i).padStart(3, '0'), String(k).padStart(2, '0') + '.wav'));
  }
}
ensureDir(path.join(addons, 'ClaudeWoW', 'sig'));
ensureDir(path.join(addons, 'ClaudeWoW', 'ack'));

// Presence: the bridge creates one every 30 s so the game can show "connected".
ensureDir(path.join(addons, 'ClaudeWoW', 'presence'));
// The addon finds the bridge by the HIGHEST presence file that exists, so a file
// ahead of the counter makes it wait for a beat that will never come and read the
// bridge as gone. Older installs wrote these as valid .wav files, which the
// zero-byte sweep above cannot catch, so clear everything past the counter.
let counter = 0;
try {
  counter = Number(JSON.parse(fs.readFileSync(HOME.state, 'utf8')).presence) || 0;
} catch {}
for (let k = 1; k <= PRESENCE; k++) {
  const file = path.join(addons, 'ClaudeWoW', 'presence', String(k).padStart(4, '0') + '.wav');
  if (k > counter) {
    try { if (fs.existsSync(file)) { fs.rmSync(file, { force: true }); cleaned++; } } catch {}
  } else {
    cleanEmpty(file);
  }
}

// Control files for the addon's self-test: one that must never exist, one always
// valid. absent.wav is swept every run in case an older install left it behind.
ensureDir(path.join(addons, 'ClaudeWoW', 'ctl'));
for (const gone of ['absent.wav', 'empty.wav']) {
  try { fs.rmSync(path.join(addons, 'ClaudeWoW', 'ctl', gone), { force: true }); } catch {}
}
ensure(path.join(addons, 'ClaudeWoW', 'ctl', 'valid.wav'), require('./protocol').SILENT_WAV);

const perms = G.repair(addons);
if (perms.fixed) console.log(`permissions: ${perms.fixed} of ${perms.checked} file(s) and folder(s) under the ClaudeWoW addon folders set to 0777 to match the game install (Battle.net error 2113)`);
for (const f of perms.failed) console.log(`permissions: could not chmod ${f}`);
console.log(`slots: ${N}  files created: ${made}  updated: ${updated}  already present: ${kept}  stale empty signal files removed: ${cleaned}`);
if (made > 0 || updated > 0) console.log('Now fully quit and relaunch WoW so it sees the new files.');
