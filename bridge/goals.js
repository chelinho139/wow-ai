'use strict';

const fs = require('fs');
const path = require('path');
const ST = require('./plugins/stream');
const GR = require('./gamerefs');
const V = require('./votes');
const { luaStr } = require('./protocol');

const STORE_VERSION = 1;
const GOALS_FILE = 'goals.json';
const ACTIVE_GOALS_MAX = 8;
const ORDER_HISTORY_MAX = 20;
const ORDER_TEXT_MAX = 90;
const GOAL_TITLE_MAX = 60;
const OVERLAY_GOALS_MAX = 3;
const SLOT_GOALS_MAX = 3;
const SLOT_LUA_MAX_BYTES = 640;
const TARGET_RANK_LIMIT = 999;
const PROFESSION_TYPE = 'profession';
const GEARSET_TYPE = 'gearset';
const GOAL_TYPES = Object.freeze([PROFESSION_TYPE, GEARSET_TYPE]);
const GEARSET_ID = 'g_gearset';
const GEARSET_TITLE_PREFIX = 'Gear set: ';
const TWO_HAND_TYPE = 17;
const MAIN_HAND_SLOT = 16;
const OFF_HAND_SLOT = 17;
const EQUIP_SLOT_MAX = 19;
const INVENTORY_TYPE_SLOTS = Object.freeze({
  1: [1], 2: [2], 3: [3], 4: [4], 5: [5], 20: [5], 6: [6], 7: [7], 8: [8], 9: [9], 10: [10],
  11: [11, 12], 12: [13, 14], 13: [16, 17], 21: [16], 17: [16], 14: [17], 22: [17], 23: [17],
  15: [18], 25: [18], 26: [18], 28: [18], 16: [15], 19: [19],
});
const OVERLAY_ACTION = 'orders';

const TOOL = Object.freeze({ set: 'goal_set', list: 'goal_list', order: 'order_issue', voteOpen: 'goal_vote_open', voteClose: 'goal_vote_close' });
const TOOL_NAMES = Object.freeze(Object.values(TOOL));
const WRITE_TOOL_NAMES = Object.freeze([TOOL.set, TOOL.order, TOOL.voteOpen, TOOL.voteClose]);

const PROFESSION_SKILL_IDS = Object.freeze({
  164: 'Blacksmithing',
  165: 'Leatherworking',
  171: 'Alchemy',
  182: 'Herbalism',
  186: 'Mining',
  197: 'Tailoring',
  202: 'Engineering',
  333: 'Enchanting',
  393: 'Skinning',
  129: 'First Aid',
  185: 'Cooking',
  356: 'Fishing',
});

const ORDER_WORDS = Object.freeze(new Set(require('./order-words.json')));
const ORDER_CHARS_TEXT = "letters A-Z, digits, spaces and , . ' - : ! ? %";
const ORDER_CHAR_RE = /^[A-Za-z0-9 ,.'\-:!?%]$/;
const CONTEXT_STALE_MS = 15 * 60 * 1000;
const ADDON_CONTEXT_MAX_BYTES = 900;

function fail(text) {
  return { ok: false, text };
}

function done(text) {
  return { ok: true, text };
}

function clip(s, max) {
  const str = String(s || '').trim();
  return str.length > max ? str.slice(0, max).trimEnd() : str;
}

function contextLine(ctxText, label) {
  const m = new RegExp(`^${label}\\s*:\\s*(.+)$`, 'im').exec(String(ctxText || ''));
  return m ? m[1].trim() : '';
}

function skillIdForName(name) {
  const want = String(name || '').trim().toLowerCase();
  const hit = Object.entries(PROFESSION_SKILL_IDS).find(([, n]) => n.toLowerCase() === want);
  return hit ? Number(hit[0]) : null;
}

function professionsCutByAddon(ctxText) {
  const text = String(ctxText || '');
  const lines = text.trimEnd().split('\n');
  return Buffer.byteLength(text, 'utf8') >= ADDON_CONTEXT_MAX_BYTES && /^Professions\s*:/i.test(lines[lines.length - 1]);
}

function parseProfessions(ctxText) {
  const line = contextLine(ctxText, 'Professions');
  if (!line) return [];
  const parts = line.split(/,\s*/);
  if (professionsCutByAddon(ctxText)) parts.pop();
  return parts.map(part => {
    const m = /^(.+?)(?:\s+(\d+)(?:\/(\d+))?)?$/.exec(part.trim());
    if (!m) return null;
    const name = m[1].trim();
    return { name, rank: m[2] ? Number(m[2]) : null, maxRank: m[3] ? Number(m[3]) : null, skillID: skillIdForName(name) };
  }).filter(Boolean);
}

function characterOf(ctxText) {
  const line = contextLine(ctxText, 'Character');
  const m = /^([^\s,(]+)(?:\s+on\s+([^,(]+?))?\s*(?:[,(].*)?$/u.exec(line);
  if (!m) return null;
  const name = m[1];
  const realm = (m[2] || '').trim();
  const key = [name, realm.replace(/\s+/g, '')].filter(Boolean).join('-').replace(/[^\p{L}\p{N}_-]/gu, '');
  return key ? { name, realm, key } : null;
}

function snapshotOf(context) {
  const c = context && typeof context === 'object' ? context : {};
  const text = String(c.text || '');
  const at = Number(c.at) || 0;
  return { text, at, receivedAt: Number(c.receivedAt) || at, character: characterOf(text), professions: parseProfessions(text) };
}

function staleContextText(snap, nowMs) {
  if (!snap.receivedAt) return 'The bridge does not know when the game sent its context. Send any message from the game, then issue the order.';
  const age = nowMs - snap.receivedAt;
  if (age <= CONTEXT_STALE_MS) return '';
  return `The game context is ${Math.floor(age / 60000)} minutes old; orders need one from the last ${CONTEXT_STALE_MS / 60000} minutes. Wait for the player's next message from the game, then issue the order.`;
}

function knownNames(snap) {
  const names = snap.professions.map(p => p.name);
  if (snap.character) names.push(snap.character.name);
  return names;
}

function orderWords(text) {
  return GR.displayWords(text);
}

function codePoint(ch) {
  return `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
}

function refusedCharText(ch) {
  const shown = /^[\x21-\x7e]$/.test(ch) ? `"${ch}"` : codePoint(ch);
  const braces = ch === '{' || ch === '}' ? ` Braces may only open and close a whole reference token: ${GR.TOKEN_FORMS}.` : '';
  const why = ch === '/' ? ' Orders are advice only: no slash commands.' : braces;
  return `The order text has the character ${shown}, which orders may not use. Allowed: ${ORDER_CHARS_TEXT}.${why}`;
}

function namesText(names) {
  const shown = (names || []).map(n => String(n || '').trim()).filter(Boolean);
  return shown.length ? shown.join(', ') : 'none reported yet';
}

function lengthText(r) {
  if (r.expanded) return `The order is ${r.length} characters once its tokens are expanded; the limit is ${r.max}.`;
  return `The order text is ${r.length} characters; the limit is ${r.max}.`;
}

function refusedWordsText(words, names) {
  return `The order uses words that are not allowed: ${words.map(w => `"${w}"`).join(', ')}. No zone, NPC, item or quest names. An order may use only numbers, plain words from the order vocabulary, and these reported names: ${namesText(names)}. ${GR.tokenHint()}`;
}

function expandedCharText(r) {
  return `${r.token}: the name "${r.name}" in the game data has the character ${codePoint(r.char)}, which orders may not show. Leave that name out.`;
}

function validateOrderText(text, names = [], gameData = null, onPhraseNote = () => {}) {
  const r = GR.checkText(text, { store: gameData, names, plainWords: ORDER_WORDS, charRe: ORDER_CHAR_RE, maxLength: ORDER_TEXT_MAX });
  if (r.phrasesNote) onPhraseNote(r.phrasesNote);
  if (r.ok) return r.refs.length ? { ok: true, text: r.text, refs: GR.refSummary(r.refs) } : done(r.text);
  if (r.problem === GR.PROBLEM.empty) return fail('The order text is empty.');
  if (r.problem === GR.PROBLEM.length) return fail(lengthText(r));
  if (r.problem === GR.PROBLEM.char) return fail(r.expanded ? expandedCharText(r) : refusedCharText(r.char));
  if (r.problem === GR.PROBLEM.glued) return fail(GR.gluedText(r.token));
  if (r.problem === GR.PROBLEM.words) return fail(refusedWordsText(r.words, names));
  if (r.problem === GR.PROBLEM.phrases) return fail(`The order was refused. ${GR.phrasesText(r.phrases, r.phrasesNote)}`);
  return fail(`The whole order was refused and nothing was saved. ${GR.errorsText(r.errors, r.store)}`);
}

function emptyStore(character) {
  return { v: STORE_VERSION, rev: 0, character, goals: [], orders: { current: null, history: [] } };
}

function readStore(file, character) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return emptyStore(character);
    throw new Error(`cannot read ${file}: ${e.message}`);
  }
  let doc;
  try { doc = JSON.parse(raw); } catch (e) { throw new Error(`${file} is not valid JSON (${e.message}); fix or move it before setting goals`); }
  if (!doc || doc.v !== STORE_VERSION || !Array.isArray(doc.goals)) throw new Error(`${file} is not a version ${STORE_VERSION} goal store`);
  const orders = doc.orders && typeof doc.orders === 'object' ? doc.orders : {};
  return {
    ...doc,
    rev: Number(doc.rev) || 0,
    orders: { current: orders.current || null, history: Array.isArray(orders.history) ? orders.history : [] },
  };
}

function writeStore(file, doc) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function reportedProfession(snap, skillID) {
  return snap.professions.find(p => p.skillID === skillID) || null;
}

function gearsetProgress(goal, snap) {
  const wanted = Object.values(goal.target.slots || {}).map(Number);
  const equipped = snap.equip && typeof snap.equip === 'object' ? Object.values(snap.equip).map(Number) : null;
  if (!equipped || !wanted.length) return { have: null, of: wanted.length, pct: null };
  const pool = [...equipped];
  let have = 0;
  for (const id of wanted) {
    const at = pool.indexOf(id);
    if (at >= 0) { have += 1; pool.splice(at, 1); }
  }
  return { have, of: wanted.length, pct: Math.floor((have / wanted.length) * 100) };
}

function progressOf(goal, snap) {
  if (goal.type === GEARSET_TYPE) return gearsetProgress(goal, snap);
  const p = reportedProfession(snap, goal.target.skillID);
  if (!p || p.rank === null) return { rank: null, maxRank: p ? p.maxRank : null, pct: null };
  const pct = Math.max(0, Math.min(100, Math.floor((p.rank / goal.target.rank) * 100)));
  return { rank: p.rank, maxRank: p.maxRank, pct };
}

function resolveProfession(args, snap) {
  if (args.skillID !== undefined && args.skillID !== null) {
    const id = Number(args.skillID);
    if (!Number.isInteger(id) || !PROFESSION_SKILL_IDS[id]) return fail(`skillID ${args.skillID} is not a profession skill line this bridge knows (${Object.keys(PROFESSION_SKILL_IDS).join(', ')}).`);
    const reported = reportedProfession(snap, id);
    if (!reported) return fail(`The game has not reported skill line ${id} for this character. Phase 0 goals need a profession the character already has.`);
    return { ok: true, skillID: id, reported };
  }
  const want = String(args.profession || '').trim().toLowerCase();
  if (!want) return fail('goal_set needs profession (as the game names it) or skillID.');
  const reported = snap.professions.find(p => p.name.toLowerCase() === want);
  if (!reported) {
    const have = snap.professions.map(p => p.name).join(', ') || 'none';
    return fail(`The game has not reported a profession called "${args.profession}" for this character. Reported: ${have}.`);
  }
  if (reported.skillID === null) return fail(`"${reported.name}" has no known skill line ID, so its progress cannot be tracked.`);
  return { ok: true, skillID: reported.skillID, reported };
}

function itemProblem(store, slot, itemID) {
  if (!Number.isInteger(itemID) || itemID <= 0) return `slot ${slot}: the item ID must be a whole number above 0.`;
  const row = store.byId('items', itemID);
  if (!row) return `slot ${slot}: {item:${itemID}} is not in the Forever client data for build ${store.build}. Look the ID up with the wowdata tools; never use an ID from memory or from Classic.`;
  if (!Number.isInteger(row.inventoryType)) return `slot ${slot}: the synced data does not say where {item:${itemID}} is worn (claude-wow data sync --force).`;
  const fits = INVENTORY_TYPE_SLOTS[row.inventoryType];
  if (!fits) return `slot ${slot}: {item:${itemID}} cannot be equipped (inventory type ${row.inventoryType}).`;
  if (!fits.includes(slot)) return `slot ${slot}: {item:${itemID}} goes in slot ${fits.join(' or ')}, not ${slot}.`;
  return { row };
}

function gearsetTitle(store, refs) {
  const expander = GR.createExpander(store);
  const counts = new Map();
  for (const ref of refs) {
    const shown = expander.expand(`{item:${ref.id}}`);
    if (!shown.ok) return fail(`The gearset was refused and nothing was saved. ${GR.errorsText(shown.errors, store)}`);
    counts.set(shown.text, (counts.get(shown.text) || 0) + 1);
  }
  const parts = [...counts].map(([name, n]) => (n > 1 ? `${n}x ${name}` : name));
  for (let k = parts.length; k >= 1; k--) {
    const rest = parts.length - k;
    const text = `${GEARSET_TITLE_PREFIX}${parts.slice(0, k).join(', ')}${rest ? ` and ${rest} more` : ''}`;
    if (text.length <= GOAL_TITLE_MAX) return done(text);
  }
  return done(`${GEARSET_TITLE_PREFIX}${refs.length} items`);
}

function checkGearset(args, snap, gameData) {
  const raw = args.slots && typeof args.slots === 'object' && !Array.isArray(args.slots) ? args.slots : null;
  const entries = raw ? Object.entries(raw) : [];
  if (!entries.length) return fail(`A gearset goal needs slots: an object of equipment slot (1 to ${EQUIP_SLOT_MAX}) to item ID.`);
  const store = gameData(snap.text);
  const stop = GR.storeProblem(store);
  if (stop) return fail(`Gearset items are checked against the synced game data. ${GR.errorsText([{ reason: stop }], store)}`);
  const slots = {};
  const refs = [];
  const rows = {};
  const problems = [];
  for (const [key, value] of entries) {
    const slot = Number(key);
    if (!Number.isInteger(slot) || slot < 1 || slot > EQUIP_SLOT_MAX) { problems.push(`"${key}" is not an equipment slot (1 to ${EQUIP_SLOT_MAX}).`); continue; }
    const itemID = Number(value);
    const r = itemProblem(store, slot, itemID);
    if (typeof r === 'string') { problems.push(r); continue; }
    slots[slot] = itemID;
    rows[slot] = r.row;
    refs.push({ kind: 'item', id: itemID, name: r.row.name, trust: store.rowTrust, build: store.build, slot });
  }
  if (rows[MAIN_HAND_SLOT] && rows[MAIN_HAND_SLOT].inventoryType === TWO_HAND_TYPE && rows[OFF_HAND_SLOT]) problems.push(`slot ${OFF_HAND_SLOT}: slot ${MAIN_HAND_SLOT} holds a two-hand item, so slot ${OFF_HAND_SLOT} stays empty.`);
  if (problems.length) return fail(`The gearset was refused and nothing was saved. ${problems.join(' ')}`);
  const title = gearsetTitle(store, refs);
  if (!title.ok) return title;
  return { ok: true, goal: { id: GEARSET_ID, type: GEARSET_TYPE, target: { slots }, title: title.text, refs }, label: 'the gear set' };
}

function checkProfession(args, snap) {
  const prof = resolveProfession(args, snap);
  if (!prof.ok) return prof;
  const id = `g_${prof.skillID}`;
  if (args.drop === true) return { ok: true, goal: { id }, label: prof.reported.name };
  const rank = Number(args.rank);
  if (!Number.isInteger(rank) || rank < 1 || rank > TARGET_RANK_LIMIT) return fail(`rank must be a whole number from 1 to ${TARGET_RANK_LIMIT}.`);
  return { ok: true, goal: { id, type: PROFESSION_TYPE, target: { skillID: prof.skillID, rank }, title: clip(`${prof.reported.name} ${rank}`, GOAL_TITLE_MAX) }, label: prof.reported.name };
}

function checkGoalSpec(args, snap, gameData) {
  const type = args.type === undefined ? PROFESSION_TYPE : args.type;
  if (!GOAL_TYPES.includes(type)) return fail(`Goal types: ${GOAL_TYPES.map(t => `"${t}"`).join(', ')}.`);
  if (type === GEARSET_TYPE) return args.drop === true ? { ok: true, goal: { id: GEARSET_ID }, label: 'the gear set' } : checkGearset(args, snap, gameData);
  return checkProfession(args, snap);
}

function writeGoal(doc, spec, stamp, createdBy) {
  const existing = doc.goals.find(g => g.id === spec.id);
  if (!existing && doc.goals.length >= ACTIVE_GOALS_MAX) return fail(`There are already ${ACTIVE_GOALS_MAX} goals. Drop one first.`);
  const fields = { type: spec.type, target: spec.target, title: spec.title, ...(spec.refs ? { refs: spec.refs } : {}) };
  if (existing) {
    Object.assign(existing, fields, { updatedAt: stamp });
    if (!spec.refs) delete existing.refs;
    return done(`Updated the goal "${spec.title}" (${existing.id}).`);
  }
  doc.goals.push({ id: spec.id, ...fields, ...(createdBy ? { createdBy } : {}), createdAt: stamp, updatedAt: stamp });
  return done(`Set the goal "${spec.title}" (${spec.id}).`);
}

function setGoal(doc, args, snap, now, gameData) {
  const checked = checkGoalSpec(args, snap, gameData);
  if (!checked.ok) return checked;
  if (args.drop === true) {
    const existing = doc.goals.find(g => g.id === checked.goal.id);
    if (!existing) return fail(`There is no goal for ${checked.label}.`);
    doc.goals = doc.goals.filter(g => g.id !== checked.goal.id);
    return done(`Dropped the goal "${existing.title}".`);
  }
  return writeGoal(doc, checked.goal, now());
}

function retireOrder(doc, status, stamp) {
  const current = doc.orders.current;
  if (!current) return;
  doc.orders.history = [{ ...current, status, endedAt: stamp }, ...doc.orders.history].slice(0, ORDER_HISTORY_MAX);
  doc.orders.current = null;
}

function issueOrder(doc, args, snap, now, gameData) {
  const stamp = now();
  if (args.clear === true) {
    if (!doc.orders.current) return fail('There is no current order to clear.');
    retireOrder(doc, 'cleared', stamp);
    return done('Cleared the current order.');
  }
  const stale = staleContextText(snap, stamp);
  if (stale) return fail(stale);
  let phraseNote = '';
  const checked = validateOrderText(args.text, knownNames(snap), () => gameData(snap.text), note => { phraseNote = note; });
  if (!checked.ok) return checked;
  const unchecked = phraseNote ? ` ${phraseNote}` : '';
  const goalId = args.goalId === undefined || args.goalId === null || args.goalId === '' ? null : String(args.goalId);
  if (goalId && !doc.goals.some(g => g.id === goalId)) return fail(`There is no goal ${goalId}. goal_list shows the ids.`);
  retireOrder(doc, 'superseded', stamp);
  doc.orders.current = { id: `o_${doc.rev + 1}`, text: checked.text, goalId, issuedAt: stamp, ...(checked.refs ? { refs: checked.refs } : {}) };
  return done(`Issued order ${doc.orders.current.id}: "${checked.text}".${unchecked}`);
}

function goalView(goal, snap) {
  const p = progressOf(goal, snap);
  if (goal.type === GEARSET_TYPE) return { id: goal.id, type: goal.type, title: goal.title, slots: goal.target.slots, items: goal.refs || [], equipped: p.have, of: p.of, pct: p.pct };
  return { id: goal.id, title: goal.title, skillID: goal.target.skillID, targetRank: goal.target.rank, rank: p.rank, maxRank: p.maxRank, pct: p.pct };
}

function listView(doc, snap) {
  return {
    character: doc.character,
    asOf: snap.at || null,
    contextReceivedAt: snap.receivedAt || null,
    goals: doc.goals.map(g => goalView(g, snap)),
    order: doc.orders.current,
    ordersInHistory: doc.orders.history.length,
  };
}

function overlayPayload(doc, snap) {
  const current = doc.orders.current;
  const orderGoal = current && current.goalId ? doc.goals.find(g => g.id === current.goalId) : null;
  const goals = doc.goals
    .filter(g => g !== orderGoal)
    .map(g => ({ title: clip(g.title, GOAL_TITLE_MAX), pct: progressOf(g, snap).pct }))
    .filter(g => g.pct !== null)
    .slice(0, OVERLAY_GOALS_MAX);
  return {
    order: current ? {
      text: clip(current.text, ORDER_TEXT_MAX),
      goal: orderGoal ? clip(orderGoal.title, GOAL_TITLE_MAX) : '',
      pct: orderGoal ? progressOf(orderGoal, snap).pct : null,
    } : null,
    goals,
    asOf: snap.at || null,
  };
}

function overlayCommand(doc, snap) {
  return { action: OVERLAY_ACTION, orders: overlayPayload(doc, snap) };
}

const ORDER_ID_RE = /^o_\d{1,9}$/;

function slotPct(pct) {
  return pct === null || pct === undefined ? null : Math.max(0, Math.min(100, Math.floor(Number(pct) || 0)));
}

function slotTitle(goal, names) {
  const checked = validateOrderText(goal && goal.title, names.concat(storedRefNames(goal || {})));
  return checked.ok && checked.text.length <= GOAL_TITLE_MAX ? checked.text : null;
}

function storedRefNames(current) {
  return (Array.isArray(current.refs) ? current.refs : []).map(ref => ref && ref.name).filter(name => typeof name === 'string' && name);
}

function slotOrder(doc, snap, names, orderGoal) {
  const current = doc.orders.current;
  if (!current) return { order: null };
  const checked = validateOrderText(current.text, names.concat(storedRefNames(current)));
  if (!checked.ok) return { order: null, withheld: `order ${current.id} is not shown: ${checked.text}` };
  return { order: {
    id: ORDER_ID_RE.test(String(current.id)) ? String(current.id) : `o_${doc.rev}`,
    text: checked.text,
    pct: orderGoal ? slotPct(progressOf(orderGoal, snap).pct) : null,
  } };
}

function slotPayload(doc, snap) {
  const names = knownNames(snap);
  const current = doc.orders.current;
  const orderGoal = current && current.goalId ? doc.goals.find(g => g.id === current.goalId) || null : null;
  const { order, withheld } = slotOrder(doc, snap, names, orderGoal);
  const shownWithOrder = order ? orderGoal : null;
  const goals = doc.goals
    .filter(g => g !== shownWithOrder)
    .map(g => ({ title: slotTitle(g, names), pct: slotPct(progressOf(g, snap).pct) }))
    .filter(g => g.title && g.pct !== null)
    .slice(0, SLOT_GOALS_MAX);
  return { rev: Math.max(0, Math.floor(Number(doc.rev) || 0)), char: snap.character ? snap.character.key : '', order, goals, ...(withheld ? { withheld } : {}) };
}

function luaSlotOrder(order) {
  if (!order) return '';
  const pct = order.pct === null ? '' : `, pct = ${order.pct}`;
  return `order = { id = ${luaStr(order.id)}, text = ${luaStr(order.text)}${pct} }, `;
}

function luaGoals(payload) {
  const order = luaSlotOrder(payload.order);
  const goals = payload.goals.slice(0, SLOT_GOALS_MAX);
  const render = () => `\tgoals = { rev = ${payload.rev}, char = ${luaStr(payload.char || '')}, ${order}goals = { ${goals.map(g => `{ title = ${luaStr(g.title)}, pct = ${g.pct} }`).join(', ')} } },`;
  let lua = render();
  while (Buffer.byteLength(lua, 'utf8') > SLOT_LUA_MAX_BYTES && goals.length) {
    goals.pop();
    lua = render();
  }
  return Buffer.byteLength(lua, 'utf8') <= SLOT_LUA_MAX_BYTES ? lua : '';
}

function fileStamp(stat) {
  return [stat.mtimeMs, stat.ctimeMs, stat.size, stat.ino].join(':');
}

function storeFile(root, characterKey) {
  return path.join(root, characterKey, GOALS_FILE);
}

function createGoals(opts) {
  const root = opts.dir;
  const context = opts.context || (() => null);
  const streamOptions = opts.streamOptions || (() => ({}));
  const post = opts.post || ST.postControl;
  const now = opts.now || Date.now;
  const log = opts.log || (() => {});
  const gameData = opts.gameData || (() => null);
  const onChange = opts.onChange || (() => {});
  const equipped = opts.equipped || (() => null);
  const votes = opts.votes || null;
  let cached = { file: '', stamp: '', doc: null };
  let lastSlotProblem = '';

  function currentSnap() {
    const snap = snapshotOf(context());
    if (!snap.character) return snap;
    try { snap.equip = equipped(snap.character.key) || null; } catch (e) {
      snap.equip = null;
      log(`goals: cannot read the equipped items for ${snap.character.key} (${e.message})`);
    }
    return snap;
  }

  function dataOnce(snap) {
    let opened = false;
    let store = null;
    return () => {
      if (!opened) { opened = true; store = gameData(snap.text); }
      return store;
    };
  }

  function voteOptions(raw, snap, doc) {
    if (!Array.isArray(raw) || raw.length < V.OPTIONS_MIN || raw.length > V.OPTIONS_MAX) return fail(`A vote needs ${V.OPTIONS_MIN} to ${V.OPTIONS_MAX} options.`);
    const names = knownNames(snap);
    const data = dataOnce(snap);
    const out = [];
    const seen = new Set();
    const titles = new Set();
    for (const [i, option] of raw.entries()) {
      const spec = option && typeof option === 'object' && !Array.isArray(option) ? option : {};
      if (spec.drop === true) return fail(`Option ${i + 1}: a vote option sets a goal; it cannot drop one.`);
      const checked = checkGoalSpec(spec, snap, data);
      if (!checked.ok) return fail(`Option ${i + 1}: ${checked.text}`);
      const key = JSON.stringify([checked.goal.id, checked.goal.target]);
      if (seen.has(key)) return fail(`Option ${i + 1} is the same goal as an earlier option.`);
      seen.add(key);
      if (!doc.goals.some(g => g.id === checked.goal.id) && doc.goals.length >= ACTIVE_GOALS_MAX) return fail(`Option ${i + 1} would be a new goal, and there are already ${ACTIVE_GOALS_MAX} goals. Drop one first.`);
      const shown = validateOrderText(checked.goal.title, names.concat(storedRefNames(checked.goal)));
      if (!shown.ok || shown.text.length > GOAL_TITLE_MAX) return fail(`Option ${i + 1}: its title "${checked.goal.title}" cannot be shown to viewers.`);
      if (titles.has(shown.text)) return fail(`Option ${i + 1} has the same title as an earlier option ("${shown.text}"), so viewers could not tell them apart.`);
      titles.add(shown.text);
      out.push({ title: shown.text, spec });
    }
    return { ok: true, options: out };
  }

  function openVote(args, snap, file) {
    if (!votes) return fail('This bridge has no vote collector.');
    const seconds = Number(args.seconds);
    if (!Number.isInteger(seconds) || seconds < V.SECONDS_MIN || seconds > V.SECONDS_MAX) return fail(`seconds must be a whole number from ${V.SECONDS_MIN} to ${V.SECONDS_MAX}.`);
    let doc;
    try { doc = readStore(file, snap.character.key); } catch (e) { return fail(`A vote needs a readable goal store to adopt into: ${e.message}`); }
    const checked = voteOptions(args.options, snap, doc);
    if (!checked.ok) return checked;
    return votes.start({ options: checked.options, seconds, character: snap.character.key });
  }

  function takeVote(args, snap) {
    if (!votes) return { result: fail('This bridge has no vote collector.') };
    const wasOpen = votes.isOpen();
    const rec = wasOpen ? votes.close() : votes.last();
    if (!rec) return { result: fail('There is no vote to close.') };
    const summary = `${wasOpen ? 'Closed the vote.' : 'The vote had already closed.'} ${V.resultText(rec.result)}`;
    if (args.adopt !== true) return { result: done(summary) };
    if (rec.adopted) return { result: fail(`${summary} Its winner was already adopted.`) };
    if (!rec.result.winner) return { result: done(`${summary} Nothing was adopted.`) };
    if (rec.character !== snap.character.key) return { result: fail(`${summary} The vote was opened for ${rec.character || 'no character'}, but the game now reports ${snap.character.key}; nothing was adopted. Log back in to that character to adopt it.`) };
    return { rec, summary };
  }

  function adoptVote(doc, taken, snap) {
    const checked = checkGoalSpec(taken.rec.options[taken.rec.result.winner - 1].spec, snap, dataOnce(snap));
    if (!checked.ok) return fail(`${taken.summary} The winner failed the goal check now and was not adopted: ${checked.text}`);
    const change = writeGoal(doc, checked.goal, now(), 'vote');
    if (!change.ok) return fail(`${taken.summary} ${change.text}`);
    return done(`${taken.summary} ${change.text}`);
  }

  function slotProblem(text) {
    if (text !== lastSlotProblem) log(`goals: the slot files hide the Orders card (${text})`);
    lastSlotProblem = text;
  }

  function storedDoc(file, key) {
    let stat;
    try { stat = fs.statSync(file); } catch (e) {
      if (e.code === 'ENOENT') return emptyStore(key);
      throw new Error(`cannot read ${file}: ${e.message}`);
    }
    const stamp = fileStamp(stat);
    if (cached.file === file && cached.stamp === stamp) return cached.doc;
    const doc = readStore(file, key);
    cached = { file, stamp, doc };
    return doc;
  }

  function hiddenCard(key, why) {
    slotProblem(why);
    return luaGoals({ rev: 0, char: key, order: null, goals: [] });
  }

  function slotLua() {
    const snap = currentSnap();
    if (!snap.character) return '';
    const key = snap.character.key;
    let lua;
    let payload;
    try {
      payload = slotPayload(storedDoc(storeFile(root, key), key), snap);
      lua = luaGoals(payload);
    } catch (e) {
      return hiddenCard(key, e.message);
    }
    if (!lua) return hiddenCard(key, `the field is over ${SLOT_LUA_MAX_BYTES} bytes`);
    if (payload.withheld) slotProblem(payload.withheld);
    else lastSlotProblem = '';
    return lua;
  }

  async function push(doc, snap) {
    const options = streamOptions() || {};
    if (!ST.isEnabled(options)) return 'The stream overlay is off (plugins.stream.enabled is false).';
    const url = ST.serviceUrl(options);
    try {
      const r = await post(url, overlayCommand(doc, snap));
      if (r && r.ok) return 'The stream overlay shows it.';
      log(`goals: overlay push to ${url} answered ${r ? r.status : 'nothing'}`);
      return `The stream service did not take the update (${r && r.message ? r.message : 'status ' + (r ? r.status : '?')}).`;
    } catch (e) {
      log(`goals: overlay push to ${url} failed (${e && e.message ? e.message : e})`);
      return ST.notRunningText(url);
    }
  }

  async function call(tool, rawArgs) {
    if (!TOOL_NAMES.includes(tool)) return fail(`Unknown goal tool: ${tool}`);
    const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {};
    const snap = currentSnap();
    if (!snap.character) return fail('The game has not reported a character yet. Log in with the addon running, or send any message from the game first.');
    const file = storeFile(root, snap.character.key);
    if (tool === TOOL.voteOpen) return openVote(args, snap, file);
    const taken = tool === TOOL.voteClose ? takeVote(args, snap) : null;
    if (taken && taken.result) return taken.result;
    let doc;
    try { doc = readStore(file, snap.character.key); } catch (e) { return fail(taken ? `${taken.summary} ${e.message}` : e.message); }
    if (tool === TOOL.list) return done(JSON.stringify(listView(doc, snap), null, 2));
    let change;
    let afterWrite = () => {};
    if (taken) {
      change = adoptVote(doc, taken, snap);
      afterWrite = () => votes.markAdopted();
    } else {
      change = tool === TOOL.set ? setGoal(doc, args, snap, now, gameData) : issueOrder(doc, args, snap, now, gameData);
    }
    if (!change.ok) return change;
    doc.rev += 1;
    try { writeStore(file, doc); } catch (e) { return fail(`Could not save ${file}: ${e.message}`); }
    afterWrite();
    cached = { file: '', stamp: '', doc: null };
    log(`goals: ${tool} for ${snap.character.key}, rev ${doc.rev}`);
    onChange();
    return done(`${change.text} ${await push(doc, snap)}`);
  }

  return { call, slotLua, file: key => storeFile(root, key) };
}

function openGameData(dataDir, contextText, log) {
  try {
    return GR.openFor(dataDir, contextText);
  } catch (e) {
    log(`goals: cannot open the synced game data for reference tokens (${e.message})`);
    return null;
  }
}

function createBridgeGoals({ home, context, streamOptions, onChange, equipped, votes, log = () => {} }) {
  const goals = createGoals({
    dir: home.goals,
    context,
    streamOptions,
    onChange,
    equipped,
    votes,
    gameData: contextText => openGameData(home.data, contextText, log),
    log,
  });
  return { ...goals, home };
}

function toolSchemas() {
  return [
    {
      name: TOOL.set,
      description: `Set, change or drop a goal for the character the game last reported. Progress is read from the game, never typed in. type "profession" (the default): only professions in the Professions line of the game context. type "gearset": one gear set, slots maps equipment slot 1 to ${EQUIP_SLOT_MAX} to an item ID from the wowdata tools; every ID must be in the synced Forever data and fit its slot; progress counts the set's items the game reports equipped. At most ${ACTIVE_GOALS_MAX} goals.`,
      inputSchema: goalSpecSchema({ drop: { type: 'boolean', description: 'true removes the goal' } }),
    },
    {
      name: TOOL.list,
      description: 'List the goals with their progress from the latest game context, and the current order.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: TOOL.order,
      description: `Issue the one current order shown on the stream overlay, or clear it. Advice only. Never type a zone, NPC, item or quest name, in any letter case. Name a game thing only with a reference token, which the bridge expands to its real name from the synced Forever client data: ${GR.TOKEN_FORMS}. A map token shows only the map's name; its x and y (0 to 100) are kept with the order as your estimate, never shown as fact. Put a space or punctuation on both sides of each token. Take each ID from the wowdata tools, never from memory or Classic; an ID the data does not have refuses the whole order. {npc:ID}, {quest:ID} and {faction:ID} have no name source yet and are refused. Without synced data no token works and only reported names may appear. Every other word must be the character's name, a profession in the game's Professions line, a number, or a plain English word from a fixed vocabulary; any other word is refused and the error names it. The text you send may be up to ${GR.TOKEN_TEXT_MAX} characters with its tokens (${ORDER_TEXT_MAX} without any); the order as shown, after expansion, is at most ${ORDER_TEXT_MAX} characters. Use only ${ORDER_CHARS_TEXT}, so no slash commands or macros. Refused when the game context is more than ${CONTEXT_STALE_MS / 60000} minutes old.`,
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', maxLength: GR.TOKEN_TEXT_MAX, description: 'The order in plain words with reference tokens for game names, for example "Skin 30 more, then train Skinning" or "Buy 20 {item:ID} at {map:ID,45.6,42.4}"' },
          goalId: { type: 'string', description: 'The goal this order serves (an id from goal_list)' },
          clear: { type: 'boolean', description: 'true clears the current order' },
        },
      },
    },
    {
      name: TOOL.voteOpen,
      description: `Open a Twitch chat vote between ${V.OPTIONS_MIN} and ${V.OPTIONS_MAX} candidate goals. Each option is a goal_set argument object and gets the same checks; the bridge writes each option's title, never you. Viewers type !1, !2 or !3 in the configured channel (votes.channel); one vote per Twitch name. The stream overlay shows the counts only when the stream service (wow-stream) has the "vote" control action; votes are counted either way. Nothing changes until goal_vote_close adopts the winner.`,
      inputSchema: {
        type: 'object',
        properties: {
          options: { type: 'array', minItems: V.OPTIONS_MIN, maxItems: V.OPTIONS_MAX, items: goalSpecSchema({}) },
          seconds: { type: 'integer', minimum: V.SECONDS_MIN, maximum: V.SECONDS_MAX, description: 'How long the vote stays open' },
        },
        required: ['options', 'seconds'],
      },
    },
    {
      name: TOOL.voteClose,
      description: 'Close the open vote (or read the result of one that timed out) and return the counts. With adopt true, the single winner is checked again like goal_set and saved as a goal for the character the vote was opened for; a tie, no votes or another logged-in character adopts nothing.',
      inputSchema: { type: 'object', properties: { adopt: { type: 'boolean', description: 'true saves the winning option as a goal' } } },
    },
  ];
}

function goalSpecSchema(extra) {
  return {
    type: 'object',
    properties: {
      type: { type: 'string', enum: GOAL_TYPES, description: 'The goal type (default profession)' },
      profession: { type: 'string', description: 'profession: the name exactly as the Professions line reports it' },
      skillID: { type: 'integer', description: 'profession: the skill line ID, instead of profession' },
      rank: { type: 'integer', minimum: 1, maximum: TARGET_RANK_LIMIT, description: 'profession: the target skill rank' },
      slots: { type: 'object', description: `gearset: equipment slot (1 to ${EQUIP_SLOT_MAX}) to item ID, for example {"16": 1234}`, additionalProperties: { type: 'integer' } },
      ...extra,
    },
  };
}

module.exports = {
  STORE_VERSION, GOALS_FILE, ACTIVE_GOALS_MAX, ORDER_HISTORY_MAX, ORDER_TEXT_MAX, GOAL_TITLE_MAX, OVERLAY_GOALS_MAX, TARGET_RANK_LIMIT,
  SLOT_GOALS_MAX, SLOT_LUA_MAX_BYTES,
  TOOL, TOOL_NAMES, WRITE_TOOL_NAMES, PROFESSION_SKILL_IDS, ORDER_WORDS, CONTEXT_STALE_MS, ADDON_CONTEXT_MAX_BYTES,
  GOAL_TYPES, GEARSET_TYPE, GEARSET_ID, EQUIP_SLOT_MAX, INVENTORY_TYPE_SLOTS,
  parseProfessions, characterOf, snapshotOf, skillIdForName, validateOrderText, orderWords, checkGoalSpec, progressOf,
  readStore, writeStore, overlayPayload, overlayCommand, slotPayload, luaGoals, listView, storeFile, createGoals, createBridgeGoals, toolSchemas,
};
