'use strict';

const fs = require('fs');
const path = require('path');
const OB = require('./observed');

const KIND = 'gs';
const RECORD_VERSION = 'gs1';
const GS_SLOT_VERSION = 1;
const SECTION_NAMES = Object.freeze(['cap', 'level', 'zone', 'money', 'items', 'skills', 'equip', 'factions', 'life', 'recipes', ...OB.SECTIONS]);
const RECORD_TEXT_MAX = 1500;
const SNAPSHOT_FILE = 'snapshot.json';
const EVENTS_FILE = 'events.jsonl';
const EVENTS_ROTATED_FILE = 'events.1.jsonl';
const EVENTS_ROTATE_BYTES = 5 * 1024 * 1024;
const SNAPSHOT_VERSION = 1;
const HANDLED_PER_SESSION = 500;
const WATCH_ITEMS_MAX = 20;
const WATCH_FACTIONS_MAX = 10;
const SKILLS_MAX = 40;
const FACTIONS_MAX = 20;
const RECIPES_MAX = 8;
const CAP_NAMES_MAX = 30;
const EQUIP_SLOT_MAX = 19;
const WATCH_THRESHOLDS = Object.freeze([100, 75, 50, 25]);

const IMPORTANCE = Object.freeze({
  money: 1,
  item: 1,
  skill: 1,
  equip: 1,
  reputation: 1,
  zone: 2,
  bags_full: 2,
  item_threshold: 2,
  reputation_rank: 2,
  level_up: 3,
  death: 3,
  recipe: 3,
  goal_complete: 3,
});
const GS_CHARACTERS_MAX = 4;
const REJECTED_KEYS_LOGGED = 20;
const KEY_CHARS_MAX = 64;
const LONG_KEY_SHOWN = 80;

const LINE_RE = /^([a-z]+):([0-9a-f]{8}):(.*)$/;
const HASH_RE = /^[0-9a-f]{8}$/;
const DATA_RE = /^[0-9A-Za-z_.,=/;@-]*$/;
const INT_RE = /^-?\d{1,15}$/;
const API_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;
const CHARACTER_KEY_RE = /^[\p{L}\p{N}_-]{1,64}$/u;
const SESSION_RE = /^[0-9A-Za-z]{0,64}$/;

function int(s) {
  return INT_RE.test(String(s)) ? Number(s) : null;
}

function nonNegative(s) {
  const n = int(s);
  return n !== null && n >= 0 ? n : null;
}

function positive(s) {
  const n = int(s);
  return n !== null && n > 0 ? n : null;
}

function list(data) {
  return data === '' ? [] : data.split(',');
}

function pairMap(data, max, parseValue) {
  const parts = list(data);
  if (parts.length > max) return null;
  const out = {};
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq < 0) return null;
    const id = positive(part.slice(0, eq));
    const value = parseValue(part.slice(eq + 1));
    if (id === null || value === null) return null;
    out[id] = value;
  }
  return out;
}

function slashPair(s, first, second) {
  const [a, b, extra] = String(s).split('/');
  if (extra !== undefined || b === undefined) return null;
  const x = first(a);
  const y = second(b);
  return x === null || y === null ? null : [x, y];
}

const SECTION_PARSERS = {
  cap(data) {
    const names = list(data);
    if (names.length > CAP_NAMES_MAX || !names.every(n => API_NAME_RE.test(n))) return null;
    return { missing: names };
  },
  money(data) {
    const copper = nonNegative(data);
    return copper === null ? null : { copper };
  },
  level(data) {
    const parts = list(data);
    if (parts.length !== 3) return null;
    const [level, xp, xpMax] = parts.map(nonNegative);
    return level === null || xp === null || xpMax === null ? null : { level, xp, xpMax };
  },
  zone(data) {
    const mapID = positive(data);
    return mapID === null ? null : { mapID };
  },
  skills(data) {
    const skills = pairMap(data, SKILLS_MAX, v => {
      const p = slashPair(v, nonNegative, nonNegative);
      return p ? { rank: p[0], max: p[1] } : null;
    });
    return skills ? { skills } : null;
  },
  items(data) {
    const semi = data.indexOf(';');
    if (semi < 0) return null;
    const freeText = data.slice(0, semi);
    const free = freeText === '' ? null : nonNegative(freeText);
    if (freeText !== '' && free === null) return null;
    const counts = pairMap(data.slice(semi + 1), WATCH_ITEMS_MAX, nonNegative);
    return counts ? { free, counts } : null;
  },
  equip(data) {
    const slots = pairMap(data, EQUIP_SLOT_MAX, positive);
    if (!slots || Object.keys(slots).some(s => Number(s) > EQUIP_SLOT_MAX)) return null;
    return { slots };
  },
  factions(data) {
    const factions = pairMap(data, FACTIONS_MAX, v => {
      const p = slashPair(v, nonNegative, int);
      return p ? { reaction: p[0], standing: p[1] } : null;
    });
    return factions ? { factions } : null;
  },
  life(data) {
    const parts = list(data);
    if (parts.length !== 2) return null;
    const [deaths, lastDeath] = parts.map(nonNegative);
    return deaths === null || lastDeath === null ? null : { deaths, lastDeath };
  },
  recipes(data) {
    const parts = list(data);
    if (parts.length > RECIPES_MAX) return null;
    const learned = [];
    for (const part of parts) {
      const [idText, atText, extra] = part.split('@');
      const id = positive(idText);
      const at = nonNegative(atText);
      if (extra !== undefined || id === null || at === null) return null;
      learned.push({ id, at });
    }
    return { learned };
  },
  ...OB.PARSERS,
};

function parseRecord(text) {
  const raw = String(text || '');
  const errors = [];
  if (Buffer.byteLength(raw, 'utf8') > RECORD_TEXT_MAX) return { sections: {}, errors: [`record is over ${RECORD_TEXT_MAX} bytes`] };
  const lines = raw.split('\n');
  if (lines[0] !== RECORD_VERSION) return { sections: {}, errors: [`unknown record version ${JSON.stringify(lines[0].slice(0, 8))}`] };
  const sections = {};
  for (const line of lines.slice(1)) {
    const m = LINE_RE.exec(line);
    if (!m) { errors.push('malformed line'); continue; }
    const [, name, hash, data] = m;
    if (!SECTION_NAMES.includes(name)) { errors.push(`unknown section ${name}`); continue; }
    if (!DATA_RE.test(data)) { errors.push(`section ${name}: characters outside the wire set`); continue; }
    const value = SECTION_PARSERS[name](data);
    if (!value) { errors.push(`section ${name}: does not parse`); continue; }
    sections[name] = { hash, value, data };
  }
  return { sections, errors };
}

function isTelemetry(job) {
  return !!job && job.kind === KIND;
}

function idList(raw, max) {
  const out = [];
  for (const v of Array.isArray(raw) ? raw : []) {
    const id = Number(v);
    if (Number.isSafeInteger(id) && id > 0 && !out.includes(id)) out.push(id);
    if (out.length >= max) break;
  }
  return out;
}

function watchFrom(telemetryConfig) {
  const watch = telemetryConfig && typeof telemetryConfig === 'object' && telemetryConfig.watch && typeof telemetryConfig.watch === 'object' ? telemetryConfig.watch : {};
  const targets = new Map();
  const rawItems = watch.items;
  if (Array.isArray(rawItems)) {
    for (const id of idList(rawItems, WATCH_ITEMS_MAX)) targets.set(id, 0);
  } else if (rawItems && typeof rawItems === 'object') {
    for (const [k, v] of Object.entries(rawItems)) {
      const id = Number(k);
      const target = Number(v);
      if (!Number.isSafeInteger(id) || id <= 0) continue;
      targets.set(id, Number.isSafeInteger(target) && target > 0 ? target : 0);
      if (targets.size >= WATCH_ITEMS_MAX) break;
    }
  }
  return { items: targets, factions: idList(watch.factions, WATCH_FACTIONS_MAX) };
}

function telemetryEnabled(telemetryConfig) {
  return !(telemetryConfig && typeof telemetryConfig === 'object' && telemetryConfig.enabled === false);
}

function thresholdCrossed(from, to, target) {
  if (!(target > 0) || !(to > from)) return null;
  for (const pct of WATCH_THRESHOLDS) {
    const mark = Math.ceil((target * pct) / 100);
    if (from < mark && to >= mark) return pct;
  }
  return null;
}

function event(type, data, importance = IMPORTANCE[type]) {
  return { type, importance, data };
}

function keysOf(...objects) {
  const out = new Set();
  for (const o of objects) for (const k of Object.keys(o || {})) out.add(k);
  return [...out].sort((a, b) => Number(a) - Number(b));
}

const SECTION_DIFFS = {
  money(prev, next) {
    if (prev.copper === next.copper) return [];
    return [event('money', { from: prev.copper, to: next.copper, delta: next.copper - prev.copper })];
  },
  level(prev, next) {
    if (next.level <= prev.level) return [];
    return [event('level_up', { from: prev.level, to: next.level })];
  },
  zone(prev, next) {
    if (prev.mapID === next.mapID) return [];
    return [event('zone', { from: prev.mapID, to: next.mapID })];
  },
  items(prev, next, watch) {
    const out = [];
    for (const k of keysOf(prev.counts, next.counts)) {
      if (!(k in prev.counts) || !(k in next.counts)) continue;
      const from = prev.counts[k];
      const to = next.counts[k];
      if (from === to) continue;
      const id = Number(k);
      const target = watch.items.get(id) || 0;
      const pct = thresholdCrossed(from, to, target);
      const data = { id, from, to };
      if (target) data.target = target;
      if (pct !== null) out.push(event('item', { ...data, threshold: pct }, IMPORTANCE.item_threshold));
      else out.push(event('item', data));
      if (pct === 100) out.push(event('goal_complete', { id, count: to, target }));
    }
    if (prev.free !== null && next.free !== null && prev.free > 0 && next.free === 0) out.push(event('bags_full', { free: 0 }));
    return out;
  },
  skills(prev, next) {
    const out = [];
    for (const k of keysOf(prev.skills, next.skills)) {
      const was = prev.skills[k];
      const now = next.skills[k];
      if (!now || (was && was.rank === now.rank)) continue;
      out.push(event('skill', { id: Number(k), from: was ? was.rank : null, to: now.rank, max: now.max }));
    }
    return out;
  },
  equip(prev, next) {
    const out = [];
    for (const k of keysOf(prev.slots, next.slots)) {
      const from = prev.slots[k] || null;
      const to = next.slots[k] || null;
      if (from !== to) out.push(event('equip', { slot: Number(k), from, to }));
    }
    return out;
  },
  factions(prev, next) {
    const out = [];
    for (const k of keysOf(prev.factions, next.factions)) {
      const was = prev.factions[k];
      const now = next.factions[k];
      if (!was || !now || was.standing === now.standing) continue;
      const data = { id: Number(k), from: was.standing, to: now.standing, reaction: now.reaction };
      if (was.reaction !== now.reaction) out.push(event('reputation', { ...data, fromReaction: was.reaction }, IMPORTANCE.reputation_rank));
      else out.push(event('reputation', data));
    }
    return out;
  },
  life(prev, next) {
    if (next.deaths > prev.deaths || next.lastDeath > prev.lastDeath) return [event('death', { at: next.lastDeath, deaths: next.deaths })];
    return [];
  },
  recipes(prev, next) {
    const known = new Set(prev.learned.map(r => r.id));
    return next.learned.filter(r => !known.has(r.id)).map(r => event('recipe', { id: r.id, at: r.at }));
  },
  cap() {
    return [];
  },
  ...Object.fromEntries(OB.SECTIONS.map(name => [name, () => []])),
};

function diffSection(name, prev, next, watch) {
  if (!prev || !next) return [];
  return SECTION_DIFFS[name](prev, next, watch);
}

function pruneCompleted(snap, watch) {
  let pruned = false;
  for (const id of Object.keys(snap.completed)) {
    if (watch.items.get(Number(id)) !== snap.completed[id]) { delete snap.completed[id]; pruned = true; }
  }
  return pruned;
}

function onceCompleted(snap, name, events) {
  if (name !== 'items') return events;
  return events.filter(e => {
    if (e.type !== 'goal_complete') return true;
    if (snap.completed[e.data.id] === e.data.target) return false;
    snap.completed[e.data.id] = e.data.target;
    return true;
  });
}

function emptySnapshot(character) {
  return { v: SNAPSHOT_VERSION, character, session: '', seq: 0, updatedAt: 0, sections: {}, completed: {} };
}

function cleanSection(name, s) {
  if (!SECTION_NAMES.includes(name) || !s || typeof s !== 'object') return null;
  if (!Number.isSafeInteger(s.seq) || s.seq < 0 || typeof s.hash !== 'string' || !HASH_RE.test(s.hash)) return null;
  if (typeof s.data !== 'string' || !DATA_RE.test(s.data)) return null;
  const value = SECTION_PARSERS[name](s.data);
  if (!value) return null;
  return { seq: s.seq, hash: s.hash, at: Number.isSafeInteger(s.at) ? s.at : 0, data: s.data, value };
}

function readSnapshot(file, character, log = () => {}) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return emptySnapshot(character); }
  let doc;
  try { doc = JSON.parse(raw); } catch { log(`telemetry: ${file} is not valid JSON; starting a fresh snapshot`); return emptySnapshot(character); }
  if (!doc || typeof doc !== 'object' || doc.v !== SNAPSHOT_VERSION || !doc.sections || typeof doc.sections !== 'object' || Array.isArray(doc.sections)) {
    log(`telemetry: ${file} is not a version ${SNAPSHOT_VERSION} snapshot; starting a fresh one`);
    return emptySnapshot(character);
  }
  const snap = emptySnapshot(character);
  snap.session = typeof doc.session === 'string' && SESSION_RE.test(doc.session) ? doc.session : '';
  snap.seq = Number.isSafeInteger(doc.seq) && doc.seq >= 0 ? doc.seq : 0;
  snap.updatedAt = Number.isSafeInteger(doc.updatedAt) ? doc.updatedAt : 0;
  if (doc.completed && typeof doc.completed === 'object' && !Array.isArray(doc.completed)) {
    for (const [id, target] of Object.entries(doc.completed)) {
      if (/^\d{1,12}$/.test(id) && Number.isSafeInteger(target) && target > 0) snap.completed[id] = target;
    }
  }
  const dropped = [];
  for (const [name, s] of Object.entries(doc.sections)) {
    const clean = cleanSection(name, s);
    if (clean) snap.sections[name] = clean;
    else dropped.push(name);
  }
  if (dropped.length) log(`telemetry: ${file}: dropped unreadable section(s) ${dropped.slice(0, 5).join(', ')}`);
  return snap;
}

function writeAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

function rotateIfFull(file, rotated, limit) {
  let size = 0;
  try { size = fs.statSync(file).size; } catch { return false; }
  if (size < limit) return false;
  fs.renameSync(file, rotated);
  return true;
}

function appendEvents(dir, character, events, { now = Date.now(), rotateBytes = EVENTS_ROTATE_BYTES } = {}) {
  if (!events.length) return false;
  const folder = path.join(dir, character);
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, EVENTS_FILE);
  const rotated = rotateIfFull(file, path.join(folder, EVENTS_ROTATED_FILE), rotateBytes);
  const at = new Date(now).toISOString();
  const lines = events.map(e => JSON.stringify({ at, ms: now, character, type: e.type, importance: e.importance, data: e.data })).join('\n') + '\n';
  fs.appendFileSync(file, lines);
  return rotated;
}

function luaHashes(snap) {
  return SECTION_NAMES
    .filter(n => snap.sections[n] && HASH_RE.test(snap.sections[n].hash))
    .map(n => `${n} = "${snap.sections[n].hash}"`)
    .join(', ');
}

function luaQuote(s) {
  return '"' + String(s).replace(/[\\"]/g, c => '\\' + c).replace(/[\x00-\x1f\x7f]/g, c => '\\' + String(c.charCodeAt(0)).padStart(3, '0')) + '"';
}

function luaGsTable(snapshots, watch, refused = [], observedOn = false, gather = []) {
  const chars = (snapshots || [])
    .filter(s => s && CHARACTER_KEY_RE.test(s.character) && SESSION_RE.test(s.session || ''))
    .slice(0, GS_CHARACTERS_MAX)
    .map(s => `{ character = "${s.character}", session = "${s.session || ''}", seq = ${Math.max(0, Math.floor(Number(s.seq) || 0))}, hashes = { ${luaHashes(s)} } }`);
  const items = [...watch.items.keys()];
  return `\tgs = { v = ${GS_SLOT_VERSION}, watch = { items = { ${items.join(', ')} }, factions = { ${watch.factions.join(', ')} } }, chars = { ${chars.join(', ')} }, refused = { ${refused.map(luaQuote).join(', ')} }${observedOn ? `, obs = 1, gather = { ${idList(gather, OB.GATHER_SPELLS_MAX).join(', ')} }` : ''} },`;
}

function createTelemetry(opts) {
  const dir = opts.dir;
  const log = opts.log || (() => {});
  const now = opts.now || Date.now;
  const watch = opts.watch || (() => watchFrom(null));
  const rotateBytes = opts.rotateBytes || EVENTS_ROTATE_BYTES;
  const observed = opts.observed || null;
  const gatherSpells = opts.gatherSpells || (() => []);
  const handled = { gs: {} };
  const snapshots = new Map();
  const loggedMissing = new Map();
  let primed = false;
  const rejectedKeys = new Set();
  const longKeysLogged = new Set();

  function snapshotFile(character) {
    return path.join(dir, character, SNAPSHOT_FILE);
  }

  function load(character) {
    if (!snapshots.has(character)) snapshots.set(character, readSnapshot(snapshotFile(character), character, log));
    return snapshots.get(character);
  }

  function prime() {
    if (primed) return;
    primed = true;
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const name of names) {
      if (!CHARACTER_KEY_RE.test(name)) continue;
      try { if (fs.statSync(snapshotFile(name)).isFile()) load(name); } catch {}
    }
  }

  function remember(session, seq) {
    const seen = handled.gs[session] || (handled.gs[session] = new Set());
    if (seen.has(seq)) return false;
    seen.add(seq);
    if (seen.size > HANDLED_PER_SESSION) seen.delete(seen.values().next().value);
    return true;
  }

  function noteMissing(character, value) {
    const text = value.missing.join(', ');
    if (loggedMissing.get(character) === text) return;
    loggedMissing.set(character, text);
    if (text) log(`telemetry: ${character}'s game client is missing ${text}; those parts of the game state are not collected`);
    else log(`telemetry: ${character}'s game client has every collection function`);
  }

  function submit(job) {
    const session = String(job.session || '');
    const seq = Number(job.id);
    if (!SESSION_RE.test(session) || !Number.isSafeInteger(seq) || seq <= 0) return { status: 'invalid' };
    const character = String(job.name || '');
    if (!CHARACTER_KEY_RE.test(character)) {
      const sendable = character !== '' && [...character].length <= KEY_CHARS_MAX;
      const seen = sendable ? rejectedKeys : longKeysLogged;
      const shown = sendable ? character : character.slice(0, LONG_KEY_SHOWN);
      if (!seen.has(shown)) {
        log(`telemetry: dropped a game state record whose character key ${JSON.stringify(shown)}${character.length > LONG_KEY_SHOWN ? ` (${character.length} characters, cut)` : ''} is not 1 to ${KEY_CHARS_MAX} letters, digits, _ and - (a name with characters the addon cannot classify)`);
      } else seen.delete(shown);
      seen.add(shown);
      while (seen.size > REJECTED_KEYS_LOGGED) seen.delete(seen.values().next().value);
      return { status: 'no-character' };
    }
    if (!remember(session, seq)) return { status: 'duplicate' };
    const parsed = parseRecord(job.text);
    if (parsed.errors.length) log(`telemetry: gs #${seq}@${session}: ${parsed.errors.slice(0, 3).join('; ')}`);
    const snap = load(character);
    if (snap.session !== session) {
      snap.session = session;
      snap.seq = 0;
      for (const s of Object.values(snap.sections)) s.seq = 0;
    }
    const applied = [];
    const events = [];
    const observations = [];
    const w = watch();
    const pruned = pruneCompleted(snap, w);
    const stamp = now();
    for (const name of SECTION_NAMES) {
      const incoming = parsed.sections[name];
      if (!incoming) continue;
      const prev = snap.sections[name];
      if (prev && prev.seq >= seq) continue;
      events.push(...onceCompleted(snap, name, diffSection(name, prev && prev.value, incoming.value, w)));
      if (OB.SECTIONS.includes(name)) observations.push([name, incoming.value]);
      snap.sections[name] = { seq, hash: incoming.hash, at: stamp, data: incoming.data, value: incoming.value };
      applied.push(name);
      if (name === 'cap') noteMissing(character, incoming.value);
    }
    if (!applied.length) {
      if (pruned) { try { writeAtomic(snapshotFile(character), JSON.stringify(snap, null, 2) + '\n'); } catch {} }
      return { status: 'stale', events: [] };
    }
    snap.seq = Math.max(snap.seq, seq);
    snap.updatedAt = stamp;
    try {
      writeAtomic(snapshotFile(character), JSON.stringify(snap, null, 2) + '\n');
      if (appendEvents(dir, character, events, { now: stamp, rotateBytes })) log(`telemetry: ${EVENTS_FILE} for ${character} reached ${rotateBytes} bytes; rotated to ${EVENTS_ROTATED_FILE}`);
    } catch (e) {
      log(`telemetry: could not save the game state for ${character} (${e.message})`);
      return { status: 'error', events };
    }
    let observedCount = 0;
    if (observed) {
      try {
        for (const [name, value] of observations) observedCount += observed.ingest(character, name, value);
      } catch (e) { log(`telemetry: could not save the observed data for ${character} (${e.message})`); }
    }
    log(`telemetry: gs #${seq}@${session || '-'} for ${character}: ${applied.join(', ')}${events.length ? ` (${events.length} event${events.length === 1 ? '' : 's'})` : ''}${observedCount ? ` (${observedCount} observed)` : ''}`);
    return { status: 'applied', sections: applied, events, observed: observedCount };
  }

  function luaGs() {
    prime();
    const w = watch();
    const recent = [...snapshots.values()].filter(s => s.session).sort((a, b) => b.updatedAt - a.updatedAt);
    let gather = [];
    if (observed) { try { gather = gatherSpells(); } catch (e) { log(`telemetry: no gather spells in the slot field (${e.message})`); } }
    return luaGsTable(recent, w, [...rejectedKeys], !!observed, gather);
  }

  return { submit, luaGs, handled, snapshot: load, snapshotFile };
}

function equippedReader(telemetry, enabled) {
  return characterKey => {
    if (!enabled) return null;
    const section = telemetry.snapshot(characterKey).sections.equip;
    return section ? section.value.slots : null;
  };
}

module.exports = {
  KIND, RECORD_VERSION, GS_SLOT_VERSION, GS_CHARACTERS_MAX, SECTION_NAMES, RECORD_TEXT_MAX, SNAPSHOT_FILE, EVENTS_FILE, EVENTS_ROTATED_FILE, EVENTS_ROTATE_BYTES,
  HANDLED_PER_SESSION, WATCH_ITEMS_MAX, WATCH_FACTIONS_MAX, WATCH_THRESHOLDS, IMPORTANCE, CHARACTER_KEY_RE,
  parseRecord, isTelemetry, equippedReader, watchFrom, telemetryEnabled, thresholdCrossed, diffSection, appendEvents, readSnapshot, luaGsTable, createTelemetry,
};
