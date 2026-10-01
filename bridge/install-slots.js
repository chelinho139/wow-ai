#!/usr/bin/env node
'use strict';
// Creates the reply-slot addons and signal files that the no-reload transport needs.
// WoW only indexes addon folders and files at launch, so run this once, then restart
// the game. Safe to re-run: existing files are left alone.

const fs = require('fs');
const path = require('path');
const G = require('./gamefs');
const SIG = require('./signals');
const P = require('./protocol');

const HOME = require('./home').resolve();
const cfg = JSON.parse(fs.readFileSync(HOME.config, 'utf8'));
const addons = cfg.addonDir;
const N = cfg.slots || 200;
const ACT = cfg.actMax || SIG.DEFAULT_ACT_MAX;
const PRESENCE = cfg.presenceMax || SIG.DEFAULT_PRESENCE_MAX;
const iface = cfg.tocInterface || P.TOC_INTERFACE;

if (!fs.existsSync(path.join(addons, 'ClaudeWoW', 'ClaudeWoW.toc'))) {
  console.error('ClaudeWoW addon not found under ' + addons);
  process.exit(1);
}

let made = 0, kept = 0, cleaned = 0, updated = 0, armed = 0;
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
  armed += SIG.armSlot(addons, i, ACT);
}

G.mkdir(SIG.presenceDir(addons));
let savedPresence = null;
try {
  savedPresence = JSON.parse(fs.readFileSync(HOME.state, 'utf8')).presence;
} catch {}
const presence = SIG.preparePresence(addons, savedPresence, PRESENCE);
armed += presence.made;
cleaned += presence.removed;

G.mkdir(path.join(addons, 'ClaudeWoW', 'ctl'));
for (const gone of ['absent.wav', 'empty.wav']) {
  if (fs.existsSync(path.join(addons, 'ClaudeWoW', 'ctl', gone)) && G.remove(path.join(addons, 'ClaudeWoW', 'ctl', gone))) cleaned++;
}
cleaned += SIG.clearProbes(addons);
ensure(path.join(addons, 'ClaudeWoW', 'ctl', 'valid.wav'), P.SILENT_WAV);

const perms = G.repair(addons);
if (perms.fixed) console.log(`permissions: ${perms.fixed} of ${perms.checked} file(s) and folder(s) under the ClaudeWoW addon folders set to 0777 to match the game install (Battle.net error 2113)`);
for (const f of perms.failed) console.log(`permissions: could not chmod ${f}`);
console.log(`slots: ${N}  files created: ${made}  updated: ${updated}  already present: ${kept}  signal files armed: ${armed}  stale signal files removed: ${cleaned}`);
console.log(`presence: ring ${presence.state.ring} at ${presence.state.at} of ${PRESENCE}, the other ring armed`);
if (made > 0 || updated > 0 || armed > 0) console.log('Now fully quit and relaunch WoW so it sees the new files: the game only sees files that existed when it started.');
