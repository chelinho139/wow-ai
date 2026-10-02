'use strict';

const fs = require('fs');
const path = require('path');

const OBSERVED_FILE = 'observed.jsonl';
const OBSERVED_ROTATED_FILE = 'observed.1.jsonl';
const OBSERVED_ROTATE_BYTES = 5 * 1024 * 1024;
const LINE_VERSION = 1;
const TRUST = 'observed';
const SECTIONS = Object.freeze(['vendor', 'ah', 'loot']);
const VENDOR_ITEMS_MAX = 40;
const AH_QUOTES_MAX = 50;
const LOOT_ENTRIES_MAX = 8;
const LOOT_ITEMS_MAX = 6;
const SEEN_KEYS_MAX = 4000;
const SEEN_PRIME_BYTES = 512 * 1024;
const MIN_SAMPLES = 10;
const MEDOID_POINTS_MAX = 200;
const PRICE_WINDOW_MS = 24 * 60 * 60 * 1000;
const GATHER_SKILL_NAMES = Object.freeze(['Herbalism', 'Mining', 'Skinning']);
const GATHER_SPELLS_MAX = 80;
const POSITION_SCALE = 10;
const POSITION_MAX = 1000;
const SOURCE_TYPES = Object.freeze({ n: 'npc', o: 'object', f: 'fishing' });
const KINDS = Object.freeze({ vendor: 'vendor', ah: 'ah', loot: 'loot' });

const INT_RE = /^\d{1,15}$/;
const SOURCE_RE = /^([nof])(\d{1,9})_(\d{1,9})$/;

function whole(s) {
  return INT_RE.test(String(s)) ? Number(s) : null;
}

function positive(s) {
  const n = whole(s);
  return n !== null && n > 0 ? n : null;
}

function optionalPositive(s) {
  return s === '' ? null : positive(s);
}

function position(s) {
  if (s === '') return null;
  const n = whole(s);
  return n !== null && n <= POSITION_MAX ? n : undefined;
}

function parseVendor(data) {
  if (data === '') return { visit: null };
  const semi = data.indexOf(';');
  if (semi < 0) return null;
  const head = data.slice(0, semi).split('@');
  if (head.length !== 3) return null;
  const npcID = positive(head[0]);
  const at = positive(head[1]);
  const mapID = optionalPositive(head[2]);
  if (npcID === null || at === null || (head[2] !== '' && mapID === null)) return null;
  const body = data.slice(semi + 1);
  const parts = body === '' ? [] : body.split(',');
  if (parts.length > VENDOR_ITEMS_MAX) return null;
  const items = [];
  for (const part of parts) {
    const m = /^(\d{1,9})=(\d{1,15})\/(\d{1,5})$/.exec(part);
    if (!m) return null;
    const itemID = positive(m[1]);
    const price = positive(m[2]);
    const stack = positive(m[3]);
    if (itemID === null || price === null || stack === null) return null;
    items.push({ itemID, price, stack });
  }
  return { visit: { key: `${npcID}@${at}`, npcID, at, mapID, items } };
}

function parseAh(data) {
  const parts = data === '' ? [] : data.split(',');
  if (parts.length > AH_QUOTES_MAX) return null;
  const quotes = [];
  for (const part of parts) {
    const m = /^(\d{1,9})=(\d{1,15})\/(\d{1,9})@(\d{1,12})(?:\/(\d{1,5})\/(\d{1,5}))?$/.exec(part);
    if (!m) return null;
    const itemID = positive(m[1]);
    const price = positive(m[2]);
    const quantity = whole(m[3]);
    const at = positive(m[4]);
    const rows = m[5] === undefined ? undefined : positive(m[5]);
    const stack = m[6] === undefined ? undefined : positive(m[6]);
    if (itemID === null || price === null || quantity === null || at === null || rows === null || stack === null) return null;
    quotes.push(rows === undefined ? { key: part, itemID, price, quantity, at } : { key: part, itemID, price, quantity, rows, stack, at });
  }
  return { quotes };
}

function parseLootItems(text) {
  const items = {};
  const parts = text === '' ? [] : text.split('/');
  if (parts.length > LOOT_ITEMS_MAX) return null;
  for (const part of parts) {
    const m = /^(\d{1,9})=(\d{1,5})$/.exec(part);
    if (!m) return null;
    const itemID = positive(m[1]);
    const qty = positive(m[2]);
    if (itemID === null || qty === null) return null;
    items[itemID] = (items[itemID] || 0) + qty;
  }
  return items;
}

function parseLoot(data) {
  const parts = data === '' ? [] : data.split(';');
  if (parts.length > LOOT_ENTRIES_MAX) return null;
  const samples = [];
  for (const part of parts) {
    const f = part.split('@');
    if (f.length !== 6) return null;
    const src = SOURCE_RE.exec(f[0]);
    const at = positive(f[1]);
    const mapID = optionalPositive(f[2]);
    const x = position(f[3]);
    const y = position(f[4]);
    const items = parseLootItems(f[5]);
    if (!src || at === null || (f[2] !== '' && mapID === null) || x === undefined || y === undefined || !items) return null;
    const id = positive(src[2]);
    const spell = whole(src[3]);
    if (id === null || spell === null) return null;
    const placed = mapID !== null && x !== null && y !== null;
    samples.push({
      key: part,
      source: { type: SOURCE_TYPES[src[1]], id, spell },
      at,
      map: mapID === null ? null : { id: mapID, x: placed ? x / POSITION_SCALE : null, y: placed ? y / POSITION_SCALE : null },
      items,
    });
  }
  return { samples };
}

const PARSERS = Object.freeze({ vendor: parseVendor, ah: parseAh, loot: parseLoot });

function entriesOf(name, value) {
  if (!value) return [];
  if (name === 'vendor') return value.visit ? [value.visit] : [];
  if (name === 'ah') return value.quotes || [];
  return value.samples || [];
}

function lineFor(name, entry) {
  const base = { v: LINE_VERSION, kind: KINDS[name], trust: TRUST, n: 1, at: entry.at * 1000, key: `${name}|${entry.key}` };
  if (name === 'vendor') return { ...base, npcID: entry.npcID, mapID: entry.mapID, items: entry.items };
  if (name === 'ah') return { ...base, itemID: entry.itemID, price: entry.price, quantity: entry.quantity, ...(entry.rows && entry.stack ? { rows: entry.rows, stack: entry.stack } : {}) };
  return { ...base, source: entry.source, map: entry.map, items: entry.items };
}

function fileStamp(file) {
  try {
    const st = fs.statSync(file);
    return [st.mtimeMs, st.ctimeMs, st.size, st.ino].join(':');
  } catch { return 'none'; }
}

function validLine(doc) {
  if (!doc || typeof doc !== 'object' || doc.v !== LINE_VERSION || doc.trust !== TRUST) return false;
  if (!Number.isSafeInteger(doc.at) || doc.at <= 0 || doc.n !== 1) return false;
  if (doc.kind === KINDS.ah) return Number.isSafeInteger(doc.itemID) && doc.itemID > 0 && Number.isSafeInteger(doc.price) && doc.price > 0 && ((doc.rows === undefined && doc.stack === undefined) || (Number.isSafeInteger(doc.rows) && doc.rows > 0 && Number.isSafeInteger(doc.stack) && doc.stack > 0));
  if (doc.kind === KINDS.vendor) return Number.isSafeInteger(doc.npcID) && doc.npcID > 0 && Array.isArray(doc.items);
  if (doc.kind === KINDS.loot) {
    const s = doc.source;
    return !!s && Object.values(SOURCE_TYPES).includes(s.type) && Number.isSafeInteger(s.id) && s.id > 0 && Number.isSafeInteger(s.spell) && !!doc.items && typeof doc.items === 'object';
  }
  return false;
}

function readLines(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    let doc;
    try { doc = JSON.parse(line); } catch { continue; }
    if (validLine(doc)) out.push(doc);
  }
  return out;
}

function sourceKey(s) {
  return `${s.type}:${s.id}:${s.spell}`;
}

function medoid(points) {
  const pool = points.slice(-MEDOID_POINTS_MAX);
  let best = null;
  let bestCost = Infinity;
  for (const p of pool) {
    const cost = pool.reduce((sum, q) => sum + Math.hypot(p.x - q.x, p.y - q.y), 0);
    if (cost < bestCost) { best = p; bestCost = cost; }
  }
  return best;
}

function dropRates(lines, itemID, minSamples = MIN_SAMPLES) {
  const groups = new Map();
  for (const doc of lines) {
    if (doc.kind !== KINDS.loot) continue;
    const key = sourceKey(doc.source);
    if (!groups.has(key)) groups.set(key, { source: doc.source, n: 0, k: 0, qty: 0, asOf: 0, spots: new Map() });
    const g = groups.get(key);
    g.n += 1;
    g.asOf = Math.max(g.asOf, doc.at);
    const qty = Number(doc.items[itemID]) || 0;
    if (!qty) continue;
    g.k += 1;
    g.qty += qty;
    if (doc.map && Number.isSafeInteger(doc.map.id)) {
      if (!g.spots.has(doc.map.id)) g.spots.set(doc.map.id, { mapID: doc.map.id, n: 0, points: [] });
      const spot = g.spots.get(doc.map.id);
      spot.n += 1;
      if (typeof doc.map.x === 'number' && typeof doc.map.y === 'number') spot.points.push({ x: doc.map.x, y: doc.map.y });
    }
  }
  const shown = [];
  const hidden = [];
  for (const g of groups.values()) {
    if (!g.k && g.n < minSamples) continue;
    const spots = [...g.spots.values()].sort((a, b) => b.n - a.n).map(s => {
      const point = medoid(s.points);
      return { mapID: s.mapID, n: s.n, x: point ? point.x : null, y: point ? point.y : null };
    });
    const row = { source: g.source, n: g.n, k: g.k, asOf: g.asOf, spots };
    if (g.n < minSamples) { hidden.push({ source: g.source, n: g.n }); continue; }
    shown.push({ ...row, rate: Math.round((g.k / g.n) * 1000) / 1000, perLoot: Math.round((g.qty / g.n) * 100) / 100 });
  }
  shown.sort((a, b) => b.rate - a.rate || b.n - a.n);
  return { shown, hidden };
}

function prices(lines, itemID) {
  const quotes = lines.filter(d => d.kind === KINDS.ah && d.itemID === itemID).sort((a, b) => a.at - b.at);
  const last = quotes[quotes.length - 1];
  const recent = last ? quotes.filter(q => q.at > last.at - PRICE_WINDOW_MS) : [];
  const ah = last ? {
    n: quotes.length,
    asOf: last.at,
    latest: { price: last.price, quantity: last.quantity, ...(last.rows ? { rows: last.rows, stack: last.stack } : {}) },
    recent: { n: recent.length, from: recent[0].at, asOf: last.at, low: Math.min(...recent.map(q => q.price)), high: Math.max(...recent.map(q => q.price)), hours: PRICE_WINDOW_MS / 3600000 },
  } : null;
  const byNpc = new Map();
  for (const d of lines) {
    if (d.kind !== KINDS.vendor) continue;
    const item = d.items.find(it => it && it.itemID === itemID && Number.isSafeInteger(it.price) && Number.isSafeInteger(it.stack) && it.stack > 0);
    if (!item) continue;
    const cur = byNpc.get(d.npcID) || { npcID: d.npcID, mapID: d.mapID, n: 0, asOf: 0, price: 0, stack: 1 };
    cur.n += 1;
    if (d.at >= cur.asOf) Object.assign(cur, { asOf: d.at, price: item.price, stack: item.stack, mapID: d.mapID });
    byNpc.set(d.npcID, cur);
  }
  const vendors = [...byNpc.values()].sort((a, b) => a.price / a.stack - b.price / b.stack);
  return { ah, vendors };
}

const LEARNED_WITH_SKILL_LINE = 1;
const gatherCache = { key: '', result: null };

function gatherFail(why) {
  return { spells: {}, count: 0, cut: 0, why };
}

function gatherSpells(store) {
  if (!store || !store.build) return gatherFail('no synced game data');
  if (store.rowTrust !== 'client-data') return gatherFail(`the synced data (build ${store.build}) is not checked against the client build (${store.buildCheck})`);
  const m = store.manifest || {};
  const key = [store.dir, store.build, m.fetchedAt || '', m.tableHash || '', store.rowTrust].join('|');
  if (gatherCache.key === key) return gatherCache.result;
  const remember = result => { gatherCache.key = key; gatherCache.result = result; return result; };
  const missing = ['skilllines', 'skilllineabilities', 'spellreagents'].filter(e => !store.has(e));
  if (missing.length) return remember(gatherFail(`the synced data has no usable ${missing.join(', ')} table`));
  const skillRows = store.rows('skilllines');
  const topOf = new Map(skillRows.filter(r => GATHER_SKILL_NAMES.includes(r.name) && !(r.parentSkillLineID > 0)).map(r => [r.id, r.id]));
  for (const r of skillRows) if (topOf.has(r.parentSkillLineID)) topOf.set(r.id, topOf.get(r.parentSkillLineID));
  const crafted = new Set(store.rows('spellreagents').map(r => r.spellID));
  const abilities = new Map();
  for (const a of store.rows('skilllineabilities')) {
    if (topOf.has(a.skillLine) && Number.isSafeInteger(a.spell) && a.spell > 0) abilities.set(a.spell, a);
  }
  const excluded = a => crafted.has(a.spell) || a.trivialHigh > 0 || a.acquireMethod === LEARNED_WITH_SKILL_LINE;
  const inheritsExclusion = a => {
    const seen = new Set();
    for (let at = a; at && !seen.has(at.spell); at = abilities.get(at.supercedesSpell)) {
      if (excluded(at)) return true;
      seen.add(at.spell);
    }
    return false;
  };
  const kept = [...abilities.values()].filter(a => !inheritsExclusion(a)).sort((x, y) => x.spell - y.spell);
  const rootOf = new Map();
  for (const a of kept) if (!rootOf.has(topOf.get(a.skillLine))) rootOf.set(topOf.get(a.skillLine), a.spell);
  const spells = {};
  for (const a of kept.slice(0, GATHER_SPELLS_MAX)) spells[a.spell] = rootOf.get(topOf.get(a.skillLine));
  return remember({ spells, count: Math.min(kept.length, GATHER_SPELLS_MAX), cut: Math.max(0, kept.length - GATHER_SPELLS_MAX), why: kept.length ? '' : 'the synced data has no gathering spells' });
}

function createObserved(opts) {
  const dir = opts.dir;
  const log = opts.log || (() => {});
  const rotateBytes = opts.rotateBytes || OBSERVED_ROTATE_BYTES;
  const seen = new Map();
  const cache = new Map();

  function folder(character) {
    return path.join(dir, character);
  }

  function seenFor(character) {
    if (seen.has(character)) return seen.get(character);
    const keys = new Set();
    for (const name of [OBSERVED_ROTATED_FILE, OBSERVED_FILE]) {
      const file = path.join(folder(character), name);
      try {
        const size = fs.statSync(file).size;
        const start = Math.max(0, size - SEEN_PRIME_BYTES);
        const fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(size - start);
        try { fs.readSync(fd, buf, 0, buf.length, start); } finally { fs.closeSync(fd); }
        for (const line of buf.toString('utf8').split('\n')) {
          try { const doc = JSON.parse(line); if (doc && typeof doc.key === 'string') keys.add(doc.key); } catch {}
        }
      } catch {}
    }
    seen.set(character, keys);
    return keys;
  }

  function remember(keys, key) {
    keys.add(key);
    while (keys.size > SEEN_KEYS_MAX) keys.delete(keys.values().next().value);
  }

  function ingest(character, name, nextValue) {
    if (!SECTIONS.includes(name)) return 0;
    const keys = seenFor(character);
    const fresh = entriesOf(name, nextValue).filter(e => !keys.has(`${name}|${e.key}`));
    if (!fresh.length) return 0;
    const out = path.join(folder(character), OBSERVED_FILE);
    fs.mkdirSync(folder(character), { recursive: true });
    let size = 0;
    try { size = fs.statSync(out).size; } catch {}
    if (size >= rotateBytes) {
      fs.renameSync(out, path.join(folder(character), OBSERVED_ROTATED_FILE));
      log(`observed: ${OBSERVED_FILE} for ${character} reached ${rotateBytes} bytes; rotated to ${OBSERVED_ROTATED_FILE}`);
    }
    fs.appendFileSync(out, fresh.map(e => JSON.stringify(lineFor(name, e))).join('\n') + '\n');
    for (const e of fresh) remember(keys, `${name}|${e.key}`);
    return fresh.length;
  }

  function lines(character) {
    const files = [OBSERVED_ROTATED_FILE, OBSERVED_FILE].map(f => path.join(folder(character), f));
    const stamp = files.map(fileStamp).join('|');
    const hit = cache.get(character);
    if (hit && hit.stamp === stamp) return hit.lines;
    const all = files.flatMap(readLines);
    cache.set(character, { stamp, lines: all });
    return all;
  }

  return { ingest, lines, file: character => path.join(folder(character), OBSERVED_FILE) };
}

module.exports = {
  OBSERVED_FILE, OBSERVED_ROTATED_FILE, OBSERVED_ROTATE_BYTES, LINE_VERSION, TRUST, SECTIONS, PARSERS, MIN_SAMPLES,
  VENDOR_ITEMS_MAX, AH_QUOTES_MAX, LOOT_ENTRIES_MAX, LOOT_ITEMS_MAX, SOURCE_TYPES, KINDS,
  GATHER_SKILL_NAMES, GATHER_SPELLS_MAX, PRICE_WINDOW_MS, parseVendor, parseAh, parseLoot, entriesOf, gatherSpells, medoid, lineFor, validLine, readLines, dropRates, prices, createObserved,
};
