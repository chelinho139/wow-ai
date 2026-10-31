#!/usr/bin/env node
'use strict';
// Creates the reply-slot addons and signal files that the no-reload transport needs.
// WoW only indexes addon folders and files at launch, so run this once, then restart
// the game. Safe to re-run: existing files are left alone.

const fs = require('fs');
const path = require('path');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const addons = cfg.addonDir;
const N = cfg.slots || 200;
const ACT = cfg.actMax || 60;
const PRESENCE = cfg.presenceMax || 2000;
const iface = cfg.tocInterface || '16001, 110205';

if (!fs.existsSync(path.join(addons, 'WoWAI', 'WoWAI.toc'))) {
  console.error('WoWAI addon not found under ' + addons);
  process.exit(1);
}

let made = 0, kept = 0;
function ensure(file, content) {
  if (fs.existsSync(file)) { kept++; return; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  made++;
}

for (let i = 1; i <= N; i++) {
  const name = 'WoWAI_S' + String(i).padStart(3, '0');
  const dir = path.join(addons, name);
  ensure(path.join(dir, name + '.toc'), [
    '## Interface: ' + iface,
    '## Title: WoW AI slot ' + String(i).padStart(3, '0'),
    '## Notes: Reply slot for WoW AI. Load-on-demand; leave it enabled.',
    '## LoadOnDemand: 1',
    '## Dependencies: WoWAI',
    '',
    'Inbox.lua',
    '',
  ].join('\n'));
  ensure(path.join(dir, 'Inbox.lua'), 'WoWAI_SlotData = nil\n');
  ensure(path.join(addons, 'WoWAI', 'sig', String(i).padStart(3, '0') + '.wav'), '');
  ensure(path.join(addons, 'WoWAI', 'ack', String(i).padStart(3, '0') + '.wav'), '');
  // Heartbeat files: one per agent action, flipped valid by the bridge as it works.
  for (let k = 1; k <= ACT; k++) {
    ensure(path.join(addons, 'WoWAI', 'act', String(i).padStart(3, '0'), String(k).padStart(2, '0') + '.wav'), '');
  }
}

// Presence files: the bridge flips one every 30 s so the game can show "connected".
for (let k = 1; k <= PRESENCE; k++) {
  ensure(path.join(addons, 'WoWAI', 'presence', String(k).padStart(4, '0') + '.wav'), '');
}

// Control files for the addon's self-test: one always empty, one always valid.
ensure(path.join(addons, 'WoWAI', 'ctl', 'empty.wav'), '');
ensure(path.join(addons, 'WoWAI', 'ctl', 'valid.wav'), require('./protocol').SILENT_WAV);

// Probe files for /wow-ai probe: per kind one empty, one valid, and a tick file
// the running bridge flips every 5 s. (missing.* is checked too, and never made.)
for (const [ext, valid] of Object.entries(require('./protocol').probeContents())) {
  if (!valid) continue;
  ensure(path.join(addons, 'WoWAI', 'ctl', 'probe', 'empty.' + ext), '');
  ensure(path.join(addons, 'WoWAI', 'ctl', 'probe', 'valid.' + ext), valid);
  ensure(path.join(addons, 'WoWAI', 'ctl', 'probe', 'tick.' + ext), '');
}

console.log(`slots: ${N}  files created: ${made}  already present: ${kept}`);
if (made > 0) console.log('Now fully quit and relaunch WoW so it sees the new files.');
