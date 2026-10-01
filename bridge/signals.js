'use strict';
const fs = require('fs');
const path = require('path');
const G = require('./gamefs');
const { SILENT_WAV, pad3, ADDON, RUNTIME_ADDON, TOC_INTERFACE } = require('./protocol');

const SCHEME = 'armed';
const RINGS = ['a', 'b'];
const DEFAULT_PRESENCE_MAX = 2000;
const DEFAULT_ACT_MAX = 60;
const DEFAULT_SLOTS = 200;
const PROBE_TOKEN = /^[0-9a-z]{4,16}$/;
const PROBE_FILE = /^probe-[0-9a-z]{4,16}\.wav$/;
const LEGACY_PRESENCE_FILE = /^\d{4}\.wav$/i;
const RUNTIME_FOLDERS = Object.freeze(['ack', 'sig', 'act', 'ctl', 'presence']);
const RETIRED_CTL_FILES = Object.freeze(['absent.wav', 'empty.wav']);
const INBOX_PLACEHOLDER = 'ClaudeWoW_Inbox = ClaudeWoW_Inbox or { id = 0, replies = {} }\n';
const RESTART_NOTE = `the signal files moved from ${ADDON} to ${RUNTIME_ADDON}: fully quit and relaunch WoW once so the game sees them`;

const runtimeRoot = addonDir => path.join(addonDir, RUNTIME_ADDON);
const runtimeToc = addonDir => path.join(runtimeRoot(addonDir), RUNTIME_ADDON + '.toc');
const runtimeInbox = addonDir => path.join(runtimeRoot(addonDir), 'Inbox.lua');
const signalFile = (addonDir, kind, slot) => path.join(runtimeRoot(addonDir), kind, pad3(slot) + '.wav');
const actFile = (addonDir, slot, k) => path.join(runtimeRoot(addonDir), 'act', pad3(slot), String(k).padStart(2, '0') + '.wav');
const presenceDir = addonDir => path.join(runtimeRoot(addonDir), 'presence');
const ringDir = (addonDir, ring) => path.join(presenceDir(addonDir), ring);
const ringFile = (addonDir, ring, k) => path.join(ringDir(addonDir, ring), String(k).padStart(4, '0') + '.wav');
const ctlDir = addonDir => path.join(runtimeRoot(addonDir), 'ctl');
const validFile = addonDir => path.join(ctlDir(addonDir), 'valid.wav');
const probeFile = (addonDir, token) => path.join(ctlDir(addonDir), 'probe-' + token + '.wav');
const otherRing = ring => (ring === 'a' ? 'b' : 'a');

function arm(file) {
  try { return G.ensureFile(file, SILENT_WAV); } catch { return false; }
}

function fire(file) {
  return G.remove(file);
}

function armSlot(addonDir, slot, actMax = DEFAULT_ACT_MAX) {
  let made = 0;
  for (const kind of ['ack', 'sig']) if (arm(signalFile(addonDir, kind, slot))) made++;
  for (let k = 1; k <= actMax; k++) if (arm(actFile(addonDir, slot, k))) made++;
  return made;
}

function presenceState(raw) {
  if (raw && typeof raw === 'object' && RINGS.includes(raw.ring)) {
    return {
      ring: raw.ring,
      at: Math.max(0, Math.floor(Number(raw.at) || 0)),
      switches: Math.max(0, Math.floor(Number(raw.switches) || 0)),
      probe: typeof raw.probe === 'string' && PROBE_TOKEN.test(raw.probe) ? raw.probe : '',
    };
  }
  return { ring: 'a', at: 0, switches: 0, probe: '' };
}

function armRing(addonDir, ring, max) {
  let made = 0;
  for (let k = 1; k <= max; k++) if (arm(ringFile(addonDir, ring, k))) made++;
  return made;
}

function legacyPresenceFiles(addonDir) {
  let names;
  try { names = fs.readdirSync(presenceDir(addonDir)); } catch { return []; }
  return names.filter(n => LEGACY_PRESENCE_FILE.test(n)).map(n => path.join(presenceDir(addonDir), n));
}

function removeLegacyPresence(addonDir) {
  let removed = 0;
  for (const file of legacyPresenceFiles(addonDir)) if (G.remove(file)) removed++;
  return removed;
}

function preparePresence(addonDir, raw, max = DEFAULT_PRESENCE_MAX) {
  const state = presenceState(raw);
  if (state.at > max) state.at = max;
  let made = 0;
  let removed = removeLegacyPresence(addonDir);
  for (let k = 1; k <= max; k++) {
    const file = ringFile(addonDir, state.ring, k);
    if (k > state.at) {
      if (arm(file)) made++;
    } else if (fs.existsSync(file) && G.remove(file)) {
      removed++;
    }
  }
  made += armRing(addonDir, otherRing(state.ring), max);
  return { state, made, removed };
}

function beat(addonDir, state, max = DEFAULT_PRESENCE_MAX) {
  let switched = '';
  if (state.at >= max) {
    switched = state.ring;
    state.ring = otherRing(state.ring);
    state.at = 0;
    state.switches = (state.switches || 0) + 1;
    armRing(addonDir, switched, max);
  }
  state.at += 1;
  fire(ringFile(addonDir, state.ring, state.at));
  return { ring: state.ring, k: state.at, switched };
}

function placeProbe(addonDir, token) {
  if (!PROBE_TOKEN.test(String(token || ''))) return false;
  clearProbes(addonDir, token);
  return arm(probeFile(addonDir, token));
}

function clearProbes(addonDir, keep = '') {
  let names;
  try { names = fs.readdirSync(ctlDir(addonDir)); } catch { return 0; }
  let removed = 0;
  for (const n of names) {
    if (PROBE_FILE.test(n) && n !== 'probe-' + keep + '.wav' && G.remove(path.join(ctlDir(addonDir), n))) removed++;
  }
  return removed;
}

function runtimeTocText(tocInterface = TOC_INTERFACE) {
  return [
    '## Interface: ' + tocInterface,
    '## Title: Claude WoW runtime',
    '## Notes: Files the Claude WoW bridge writes while it runs. Leave it enabled.',
    '## Dependencies: ' + ADDON,
    '',
    'Inbox.lua',
    '',
  ].join('\n');
}

function writeWhenDifferent(file, content) {
  let current = null;
  try { current = fs.readFileSync(file, 'utf8'); } catch {}
  if (current === content) return false;
  G.mkdir(path.dirname(file));
  G.writeFile(file, content);
  return true;
}

function legacySignalFolders(addonDir) {
  return RUNTIME_FOLDERS.map(name => path.join(addonDir, ADDON, name)).filter(dir => fs.existsSync(dir));
}

function removeLegacySignalFolders(addonDir) {
  let removed = 0;
  for (const dir of legacySignalFolders(addonDir)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      removed++;
    } catch {}
  }
  return removed;
}

function needsMigration(addonDir) {
  return legacySignalFolders(addonDir).length > 0 && !fs.existsSync(validFile(addonDir));
}

function prepareRuntime(addonDir, { slots = DEFAULT_SLOTS, actMax = DEFAULT_ACT_MAX, presence = null, presenceMax = DEFAULT_PRESENCE_MAX, tocInterface = TOC_INTERFACE, removeLegacy = false } = {}) {
  const result = { made: 0, updated: 0, armed: 0, cleaned: 0, legacy: legacySignalFolders(addonDir).length, legacyRemoved: 0, presence: null };
  const tocExisted = fs.existsSync(runtimeToc(addonDir));
  if (writeWhenDifferent(runtimeToc(addonDir), runtimeTocText(tocInterface))) {
    if (tocExisted) result.updated++;
    else result.made++;
  }
  if (G.ensureFile(runtimeInbox(addonDir), INBOX_PLACEHOLDER)) result.made++;
  for (let slot = 1; slot <= slots; slot++) result.armed += armSlot(addonDir, slot, actMax);
  G.mkdir(presenceDir(addonDir));
  result.presence = preparePresence(addonDir, presence, presenceMax);
  result.armed += result.presence.made;
  result.cleaned += result.presence.removed;
  G.mkdir(ctlDir(addonDir));
  for (const name of RETIRED_CTL_FILES) {
    const file = path.join(ctlDir(addonDir), name);
    if (fs.existsSync(file) && G.remove(file)) result.cleaned++;
  }
  result.cleaned += clearProbes(addonDir);
  if (arm(validFile(addonDir))) result.made++;
  if (removeLegacy) result.legacyRemoved = removeLegacySignalFolders(addonDir);
  return result;
}

module.exports = {
  SCHEME, RINGS, DEFAULT_PRESENCE_MAX, DEFAULT_ACT_MAX, DEFAULT_SLOTS, PROBE_TOKEN, RUNTIME_FOLDERS, INBOX_PLACEHOLDER, RESTART_NOTE,
  runtimeRoot, runtimeToc, runtimeInbox, runtimeTocText, signalFile, actFile, presenceDir, ringDir, ringFile, ctlDir, validFile, probeFile, otherRing,
  arm, fire, armSlot, presenceState, armRing, legacyPresenceFiles, removeLegacyPresence, preparePresence, beat, placeProbe, clearProbes,
  legacySignalFolders, removeLegacySignalFolders, needsMigration, prepareRuntime,
};
