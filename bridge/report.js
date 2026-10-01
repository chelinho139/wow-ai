'use strict';

const fs = require('fs');
const path = require('path');
const TL = require('./telemetry');
const G = require('./goals');
const E = require('./events');

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const CHARACTER_RE = /^[\p{L}\p{N}_-]{1,64}$/u;
const HIDDEN_TEXT = '(not shown: it fails the text check)';

const USAGE = [
  'claude-wow report [--day [YYYY-MM-DD]] [--character Name-Realm]',
  '  --day        the local calendar day to report (default: today)',
  '  --character  the character folder under the goals folder (default: the one with the newest events)',
  'Reads only snapshot.json, events.jsonl (and events.1.jsonl) and goals.json. Game things are shown by ID, never by name.',
].join('\n');

function parseArgs(argv) {
  const o = { day: '', character: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--day') { if (argv[i + 1] && !argv[i + 1].startsWith('-')) o.day = argv[++i]; }
    else if (a.startsWith('--day=')) o.day = a.slice(6);
    else if (a === '--character') o.character = String(argv[++i] || '');
    else if (a.startsWith('--character=')) o.character = a.slice(12);
    else if (a === '--help' || a === '-h') o.help = true;
    else o.error = `unknown option ${a}`;
  }
  if (o.day && !dayRange(o.day)) o.error = '--day takes a date like 2026-10-01';
  if (o.character && !CHARACTER_RE.test(o.character)) o.error = '--character takes a folder name like Name-Realm';
  return o;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function localDay(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function dayRange(day) {
  const m = DAY_RE.exec(day);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const start = new Date(y, mo - 1, d);
  if (start.getFullYear() !== y || start.getMonth() !== mo - 1 || start.getDate() !== d) return null;
  return { day, start: start.getTime(), end: new Date(y, mo - 1, d + 1).getTime() };
}

function readEventLines(folder) {
  const out = [];
  for (const name of [TL.EVENTS_ROTATED_FILE, TL.EVENTS_FILE]) {
    let text = '';
    try { text = fs.readFileSync(path.join(folder, name), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const e = JSON.parse(line);
        if (e && typeof e.type === 'string' && Number.isSafeInteger(e.ms) && e.data && typeof e.data === 'object') out.push(e);
      } catch {}
    }
  }
  return out;
}

function readGoals(folder) {
  try { return G.readStore(path.join(folder, G.GOALS_FILE), path.basename(folder)); } catch (e) { return { error: e.message }; }
}

function money(copper) {
  const sign = copper < 0 ? '-' : '+';
  const c = Math.abs(copper);
  const parts = [];
  if (c >= 10000) parts.push(`${Math.floor(c / 10000)}g`);
  if (c >= 100) parts.push(`${Math.floor(c / 100) % 100}s`);
  parts.push(`${c % 100}c`);
  return sign + parts.join(' ');
}

function firstLast(events, keyOf) {
  const out = new Map();
  for (const e of events) {
    const k = keyOf(e);
    const seen = out.get(k);
    out.set(k, { from: seen ? seen.from : e.data.from, to: e.data.to });
  }
  return out;
}

function shownText(text, names) {
  const checked = G.validateOrderText(text, names);
  return checked.ok ? checked.text : HIDDEN_TEXT;
}

function knownNames(character, doc) {
  const names = [character.split('-')[0]];
  for (const g of doc.goals || []) {
    if (g && g.target && G.PROFESSION_SKILL_IDS[g.target.skillID]) names.push(G.PROFESSION_SKILL_IDS[g.target.skillID]);
  }
  return names;
}

function orderNames(order) {
  return (Array.isArray(order.refs) ? order.refs : []).map(r => r && r.name).filter(n => typeof n === 'string' && n);
}

function progressSnap(snapshot) {
  const skills = snapshot.sections.skills ? snapshot.sections.skills.value.skills : {};
  const professions = Object.entries(skills).map(([id, s]) => ({ name: '', rank: s.rank, maxRank: s.max, skillID: Number(id) }));
  return { professions, equip: snapshot.sections.equip ? snapshot.sections.equip.value.slots : null };
}

function eventLines(events) {
  const of = type => events.filter(e => e.type === type);
  const lines = [];
  const levels = of('level_up');
  if (levels.length) lines.push(`Level: ${levels[0].data.from} to ${levels[levels.length - 1].data.to}`);
  const moneyEvents = of('money');
  if (moneyEvents.length) lines.push(`Money: ${money(moneyEvents.reduce((sum, e) => sum + (Number(e.data.delta) || 0), 0))} over ${moneyEvents.length} changes`);
  const deaths = of('death');
  if (deaths.length) lines.push(`Deaths: ${deaths.length}`);
  const zones = of('zone');
  if (zones.length) lines.push(`Zone changes: ${zones.length} (maps ${[...new Set(zones.map(e => e.data.to))].join(', ')})`);
  const skills = firstLast(of('skill'), e => e.data.id);
  for (const [id, s] of skills) lines.push(`Skill ${id}: ${s.from === null || s.from === undefined ? 'new' : s.from} to ${s.to}`);
  const recipes = of('recipe');
  if (recipes.length) lines.push(`Recipes learned: ${recipes.length} (recipe ${recipes.map(e => e.data.id).join(', ')})`);
  const items = firstLast(of('item'), e => e.data.id);
  for (const [id, s] of items) lines.push(`Item ${id} in bags: ${s.from} to ${s.to}`);
  for (const e of of('goal_complete')) lines.push(`Watched item ${e.data.id} reached its target of ${e.data.target}`);
  const reps = of('reputation');
  if (reps.length) lines.push(`Reputation changes: ${reps.length} (faction ${[...new Set(reps.map(e => e.data.id))].join(', ')})`);
  const equips = of('equip');
  if (equips.length) lines.push(`Gear changes: ${equips.length}`);
  return lines;
}

function orderLines(doc, range, names) {
  const all = [doc.orders.current, ...doc.orders.history].filter(o => o && Number(o.issuedAt) >= range.start && Number(o.issuedAt) < range.end);
  if (!all.length) return [];
  const lines = [`Orders issued: ${all.length}`];
  for (const o of all.sort((a, b) => Number(a.issuedAt) - Number(b.issuedAt))) lines.push(`  ${shownText(o.text, names.concat(orderNames(o)))} (${o === doc.orders.current ? 'current' : o.status || 'ended'})`);
  return lines;
}

function goalLines(doc, snapshot, names) {
  if (!doc.goals.length) return [];
  const snap = progressSnap(snapshot);
  const lines = ['Goals now:'];
  for (const g of doc.goals) {
    const p = G.progressOf(g, snap);
    lines.push(`  ${shownText(g.title, names)}: ${p.pct === null ? 'no progress reported yet' : `${p.pct}%`}`);
  }
  return lines;
}

function build({ goalsDir, character, range }) {
  const folder = path.join(goalsDir, character);
  const events = readEventLines(folder).filter(e => e.ms >= range.start && e.ms < range.end);
  const snapshot = TL.readSnapshot(path.join(folder, TL.SNAPSHOT_FILE), character);
  const doc = readGoals(folder);
  const lines = [`Day report for ${character}, ${range.day} (local time)`];
  const body = eventLines(events);
  lines.push(...(body.length ? body : ['No game events this day.']));
  if (doc.error) lines.push(`Goals: not read (${doc.error})`);
  else {
    const names = knownNames(character, doc);
    lines.push(...orderLines(doc, range, names), ...goalLines(doc, snapshot, names));
  }
  lines.push(`Data: ${events.length} events; snapshot updated ${snapshot.updatedAt ? new Date(snapshot.updatedAt).toISOString() : 'never'}`);
  return lines.join('\n') + '\n';
}

function defaultCharacter(goalsDir) {
  const file = E.newestEventsFile(goalsDir);
  return file ? path.basename(path.dirname(file)) : '';
}

function main(argv, { goalsDir = require('./home').resolve().goals, out = process.stdout, err = process.stderr, now = Date.now } = {}) {
  const o = parseArgs(argv);
  if (o.help) { out.write(USAGE + '\n'); return 0; }
  if (o.error) { err.write(`report: ${o.error}\n${USAGE}\n`); return 2; }
  const character = o.character || defaultCharacter(goalsDir);
  if (!character) { err.write(`report: no ${TL.EVENTS_FILE} under ${goalsDir} yet\n`); return 1; }
  if (!fs.existsSync(path.join(goalsDir, character))) { err.write(`report: no folder for ${character} under ${goalsDir}\n`); return 1; }
  out.write(build({ goalsDir, character, range: dayRange(o.day || localDay(now())) }));
  return 0;
}

module.exports = { USAGE, HIDDEN_TEXT, parseArgs, dayRange, localDay, money, build, main };
