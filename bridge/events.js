'use strict';

const fs = require('fs');
const path = require('path');
const TL = require('./telemetry');

const BURST_WINDOW_MS = 10000;
const WAKES_PER_HOUR = 40;
const HOUR_MS = 60 * 60 * 1000;
const POLL_MS = 1000;
const RESOLVE_EVERY_TICKS = 10;
const IMPORTANCE_MIN = 1;
const IMPORTANCE_MAX = 3;
const RECENT_LINES = 50;
const READ_CHUNK_MAX = 1024 * 1024;

const USAGE = [
  'claude-wow events [--follow] [--min N] [--character Name-Realm]',
  '  --follow     wait for new game events and print one JSON line per event',
  '  --min N      only events of importance N or more (1 money and loot, 2 watched items, zone, bags full, 3 level up, death, new recipe, a watched item target reached (goal_complete))',
  '  --character  the character folder under the goals folder (default: the one written to last)',
  `Bursts within ${BURST_WINDOW_MS / 1000} s are merged; at most ${WAKES_PER_HOUR} bursts are printed per hour, later ones wait.`,
].join('\n');

function coalesceKey(e) {
  const d = e.data && typeof e.data === 'object' ? e.data : {};
  const which = d.id !== undefined ? d.id : d.slot !== undefined ? d.slot : '';
  return `${e.type}:${which}`;
}

function mergeEvents(older, newer) {
  const data = { ...(newer.data || {}) };
  if (older.data && 'from' in older.data && 'from' in data) data.from = older.data.from;
  if (older.data && 'delta' in older.data && 'delta' in data) data.delta = Number(older.data.delta) + Number(data.delta);
  return { ...newer, importance: Math.max(older.importance, newer.importance), count: (older.count || 1) + 1, data };
}

function createCoalescer({ windowMs = BURST_WINDOW_MS, wakesPerHour = WAKES_PER_HOUR, now = Date.now } = {}) {
  const buffer = new Map();
  const wakes = [];
  let burstAt = null;

  function push(e) {
    const key = coalesceKey(e);
    const prev = buffer.get(key);
    buffer.set(key, prev ? mergeEvents(prev, e) : { ...e, count: 1 });
    if (burstAt === null) burstAt = now();
  }

  function wakesInLastHour() {
    const t = now();
    while (wakes.length && t - wakes[0] >= HOUR_MS) wakes.shift();
    return wakes.length;
  }

  function flush() {
    if (burstAt === null || now() - burstAt < windowMs) return null;
    if (wakesInLastHour() >= wakesPerHour) return { held: buffer.size, nextAt: wakes[0] + HOUR_MS };
    wakes.push(now());
    const events = [...buffer.values()];
    buffer.clear();
    burstAt = null;
    return { events };
  }

  return { push, flush, pending: () => buffer.size, wakes: () => wakesInLastHour() };
}

function parseLine(line) {
  try {
    const e = JSON.parse(line);
    if (!e || typeof e.type !== 'string' || !Number.isInteger(e.importance)) return null;
    return e;
  } catch { return null; }
}

function newestEventsFile(goalsDir) {
  let best = null;
  let names = [];
  try { names = fs.readdirSync(goalsDir); } catch { return null; }
  for (const name of names) {
    const file = path.join(goalsDir, name, TL.EVENTS_FILE);
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    if (!best || st.mtimeMs > best.mtimeMs) best = { file, mtimeMs: st.mtimeMs };
  }
  return best ? best.file : null;
}

function eventsFile(goalsDir, character) {
  if (character) return path.join(goalsDir, character, TL.EVENTS_FILE);
  return newestEventsFile(goalsDir);
}

function allEventsFiles(goalsDir) {
  let names = [];
  try { names = fs.readdirSync(goalsDir); } catch { return []; }
  return names.map(n => path.join(goalsDir, n, TL.EVENTS_FILE)).filter(f => { try { return fs.statSync(f).isFile(); } catch { return false; } });
}

function sizeOf(file) {
  try { return fs.statSync(file).size; } catch { return 0; }
}

function follow(opts) {
  const out = opts.out || process.stdout;
  const err = opts.err || process.stderr;
  const min = opts.min || IMPORTANCE_MIN;
  const resolve = typeof opts.file === 'function' ? opts.file : () => opts.file;
  const list = typeof opts.list === 'function' ? opts.list : () => [];
  const resolveEvery = opts.resolveEvery || RESOLVE_EVERY_TICKS;
  const chunk = opts.chunk || READ_CHUNK_MAX;
  const coalescer = createCoalescer({ windowMs: opts.windowMs, wakesPerHour: opts.wakesPerHour, now: opts.now });
  const resume = new Map();
  let file = null;
  let offset = 0;
  let inode = null;
  let partial = '';
  let heldSaid = false;
  let ticks = 0;

  function noteNewFiles(atStart) {
    for (const f of list()) if (!resume.has(f)) resume.set(f, { offset: atStart && !opts.fromStart ? sizeOf(f) : 0, partial: '' });
  }

  function attach(found, atStart) {
    file = found;
    let st = null;
    try { st = fs.statSync(file); } catch {}
    inode = st ? st.ino : null;
    const saved = resume.get(file);
    offset = saved ? saved.offset : st && atStart && !opts.fromStart ? st.size : 0;
    partial = saved ? saved.partial : '';
    if (st && offset > st.size) { offset = 0; partial = ''; }
  }

  function feed(text) {
    const lines = (partial + text).split('\n');
    partial = lines.pop();
    for (const line of lines) {
      const e = parseLine(line);
      if (e && e.importance >= min) coalescer.push(e);
    }
  }

  function readRange(target, from, to) {
    if (to <= from) return 0;
    const len = Math.min(to - from, chunk);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(target, 'r');
    try { fs.readSync(fd, buf, 0, len, from); } finally { fs.closeSync(fd); }
    feed(buf.toString('utf8'));
    return len;
  }

  function drainRotated() {
    const rotated = path.join(path.dirname(file), TL.EVENTS_ROTATED_FILE);
    let st;
    try { st = fs.statSync(rotated); } catch { return; }
    if (inode === null || st.ino !== inode) return;
    let at = offset;
    while (at < st.size) {
      const got = readRange(rotated, at, st.size);
      if (!got) break;
      at += got;
    }
  }

  function readNew() {
    let st;
    try { st = fs.statSync(file); } catch { return; }
    if (inode !== null && st.ino !== inode) { drainRotated(); offset = 0; partial = ''; }
    else if (st.size < offset) { offset = 0; partial = ''; }
    inode = st.ino;
    offset += readRange(file, offset, st.size);
  }

  function reresolve(atStart) {
    noteNewFiles(atStart);
    const found = resolve();
    if (!found || found === file) return;
    if (file) { readNew(); resume.set(file, { offset, partial }); }
    attach(found, atStart);
  }

  function tick() {
    ticks += 1;
    if (!file || ticks % resolveEvery === 0) reresolve(false);
    if (!file) return;
    readNew();
    const r = coalescer.flush();
    if (!r) return;
    if (r.events) {
      heldSaid = false;
      out.write(r.events.map(e => JSON.stringify(e)).join('\n') + '\n');
    } else if (!heldSaid) {
      heldSaid = true;
      err.write(`events: ${WAKES_PER_HOUR} bursts printed in the last hour; ${r.held} event kind(s) wait until ${new Date(r.nextAt).toISOString()}\n`);
    }
  }

  reresolve(true);
  const timer = opts.pollMs === 0 ? null : setInterval(tick, opts.pollMs || POLL_MS);
  return { tick, stop: () => { if (timer) clearInterval(timer); }, file: () => file };
}


function recent(file, min, limit = RECENT_LINES) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  return text.split('\n').map(parseLine).filter(e => e && e.importance >= min).slice(-limit);
}

function parseArgs(argv) {
  const o = { follow: false, min: IMPORTANCE_MIN, character: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--follow' || a === '-f') o.follow = true;
    else if (a === '--min') o.min = Number(argv[++i]);
    else if (a.startsWith('--min=')) o.min = Number(a.slice(6));
    else if (a === '--character') o.character = String(argv[++i] || '');
    else if (a.startsWith('--character=')) o.character = a.slice(12);
    else if (a === '--help' || a === '-h') o.help = true;
    else o.error = `unknown option ${a}`;
  }
  if (!Number.isInteger(o.min) || o.min < IMPORTANCE_MIN || o.min > IMPORTANCE_MAX) o.error = `--min takes ${IMPORTANCE_MIN} to ${IMPORTANCE_MAX}`;
  if (o.character && !/^[\p{L}\p{N}_-]{1,64}$/u.test(o.character)) o.error = '--character takes a folder name like Name-Realm';
  return o;
}

function main(argv, { goalsDir = require('./home').resolve().goals, out = process.stdout, err = process.stderr } = {}) {
  const o = parseArgs(argv);
  if (o.help) { out.write(USAGE + '\n'); return 0; }
  if (o.error) { err.write(`events: ${o.error}\n${USAGE}\n`); return 2; }
  if (!o.follow) {
    const file = eventsFile(goalsDir, o.character);
    if (!file) { err.write(`events: no ${TL.EVENTS_FILE} under ${goalsDir} yet\n`); return 1; }
    for (const e of recent(file, o.min)) out.write(JSON.stringify(e) + '\n');
    return 0;
  }
  const f = follow({ file: () => eventsFile(goalsDir, o.character), list: o.character ? null : () => allEventsFiles(goalsDir), min: o.min, out, err });
  const stop = () => { f.stop(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return null;
}

module.exports = { BURST_WINDOW_MS, WAKES_PER_HOUR, HOUR_MS, RESOLVE_EVERY_TICKS, allEventsFiles, USAGE, coalesceKey, mergeEvents, createCoalescer, follow, recent, eventsFile, newestEventsFile, parseArgs, main };
