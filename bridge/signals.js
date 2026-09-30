'use strict';
const fs = require('fs');
const path = require('path');
const G = require('./gamefs');
const { SILENT_WAV, pad3 } = require('./protocol');

const SCHEME = 'armed';
const RINGS = ['a', 'b'];
const DEFAULT_PRESENCE_MAX = 2000;
const DEFAULT_ACT_MAX = 60;
const PROBE_TOKEN = /^[0-9a-z]{4,16}$/;
const PROBE_FILE = /^probe-[0-9a-z]{4,16}\.wav$/;
const LEGACY_PRESENCE_FILE = /^\d{4}\.wav$/i;

const addonRoot = addonDir => path.join(addonDir, 'ClaudeWoW');
const signalFile = (addonDir, kind, slot) => path.join(addonRoot(addonDir), kind, pad3(slot) + '.wav');
const actFile = (addonDir, slot, k) => path.join(addonRoot(addonDir), 'act', pad3(slot), String(k).padStart(2, '0') + '.wav');
const presenceDir = addonDir => path.join(addonRoot(addonDir), 'presence');
const ringDir = (addonDir, ring) => path.join(presenceDir(addonDir), ring);
const ringFile = (addonDir, ring, k) => path.join(ringDir(addonDir, ring), String(k).padStart(4, '0') + '.wav');
const ctlDir = addonDir => path.join(addonRoot(addonDir), 'ctl');
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

module.exports = {
  SCHEME, RINGS, DEFAULT_PRESENCE_MAX, DEFAULT_ACT_MAX, PROBE_TOKEN,
  signalFile, actFile, presenceDir, ringDir, ringFile, probeFile, otherRing,
  arm, fire, armSlot, presenceState, armRing, legacyPresenceFiles, removeLegacyPresence, preparePresence, beat, placeProbe, clearProbes,
};
