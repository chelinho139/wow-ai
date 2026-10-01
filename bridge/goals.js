'use strict';

const fs = require('fs');
const path = require('path');
const ST = require('./plugins/stream');
const GR = require('./gamerefs');
const GD = require('./gamedata');

const STORE_VERSION = 1;
const GOALS_FILE = 'goals.json';
const ACTIVE_GOALS_MAX = 8;
const ORDER_HISTORY_MAX = 20;
const ORDER_TEXT_MAX = 90;
const GOAL_TITLE_MAX = 60;
const OVERLAY_GOALS_MAX = 3;
const TARGET_RANK_LIMIT = 999;
const PROFESSION_TYPE = 'profession';
const OVERLAY_ACTION = 'orders';

const TOOL = Object.freeze({ set: 'goal_set', list: 'goal_list', order: 'order_issue' });
const TOOL_NAMES = Object.freeze(Object.values(TOOL));
const WRITE_TOOL_NAMES = Object.freeze([TOOL.set, TOOL.order]);

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

function expandedCharText(ch) {
  return `A name from the game data has the character ${codePoint(ch)}, which orders may not show. Leave that name out.`;
}

function validateOrderText(text, names = [], gameData = null) {
  const r = GR.checkText(text, { store: gameData, names, plainWords: ORDER_WORDS, charRe: ORDER_CHAR_RE, maxLength: ORDER_TEXT_MAX });
  if (r.ok) return r.refs.length ? { ok: true, text: r.text, refs: GR.refSummary(r.refs) } : done(r.text);
  if (r.problem === GR.PROBLEM.empty) return fail('The order text is empty.');
  if (r.problem === GR.PROBLEM.length) return fail(lengthText(r));
  if (r.problem === GR.PROBLEM.char) return fail(r.expanded ? expandedCharText(r.char) : refusedCharText(r.char));
  if (r.problem === GR.PROBLEM.glued) return fail(GR.gluedText(r.token));
  if (r.problem === GR.PROBLEM.words) return fail(refusedWordsText(r.words, names));
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

function progressOf(goal, snap) {
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

function setGoal(doc, args, snap, now) {
  if (args.type !== undefined && args.type !== PROFESSION_TYPE) return fail(`Only "${PROFESSION_TYPE}" goals exist so far.`);
  const prof = resolveProfession(args, snap);
  if (!prof.ok) return prof;
  const id = `g_${prof.skillID}`;
  const existing = doc.goals.find(g => g.id === id);
  if (args.drop === true) {
    if (!existing) return fail(`There is no goal for ${prof.reported.name}.`);
    doc.goals = doc.goals.filter(g => g.id !== id);
    return done(`Dropped the goal "${existing.title}".`);
  }
  const rank = Number(args.rank);
  if (!Number.isInteger(rank) || rank < 1 || rank > TARGET_RANK_LIMIT) return fail(`rank must be a whole number from 1 to ${TARGET_RANK_LIMIT}.`);
  if (!existing && doc.goals.length >= ACTIVE_GOALS_MAX) return fail(`There are already ${ACTIVE_GOALS_MAX} goals. Drop one first.`);
  const title = clip(`${prof.reported.name} ${rank}`, GOAL_TITLE_MAX);
  const stamp = now();
  if (existing) {
    existing.target = { skillID: prof.skillID, rank };
    existing.title = title;
    existing.updatedAt = stamp;
    return done(`Updated the goal "${title}" (${existing.id}).`);
  }
  doc.goals.push({ id, type: PROFESSION_TYPE, target: { skillID: prof.skillID, rank }, title, createdAt: stamp, updatedAt: stamp });
  return done(`Set the goal "${title}" (${id}).`);
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
  const checked = validateOrderText(args.text, knownNames(snap), () => gameData(snap.text));
  if (!checked.ok) return checked;
  const goalId = args.goalId === undefined || args.goalId === null || args.goalId === '' ? null : String(args.goalId);
  if (goalId && !doc.goals.some(g => g.id === goalId)) return fail(`There is no goal ${goalId}. goal_list shows the ids.`);
  retireOrder(doc, 'superseded', stamp);
  doc.orders.current = { id: `o_${doc.rev + 1}`, text: checked.text, goalId, issuedAt: stamp, ...(checked.refs ? { refs: checked.refs } : {}) };
  return done(`Issued order ${doc.orders.current.id}: "${checked.text}".`);
}

function goalView(goal, snap) {
  const p = progressOf(goal, snap);
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
    const snap = snapshotOf(context());
    if (!snap.character) return fail('The game has not reported a character yet. Log in with the addon running, or send any message from the game first.');
    const file = storeFile(root, snap.character.key);
    let doc;
    try { doc = readStore(file, snap.character.key); } catch (e) { return fail(e.message); }
    if (tool === TOOL.list) return done(JSON.stringify(listView(doc, snap), null, 2));
    const change = tool === TOOL.set ? setGoal(doc, args, snap, now) : issueOrder(doc, args, snap, now, gameData);
    if (!change.ok) return change;
    doc.rev += 1;
    try { writeStore(file, doc); } catch (e) { return fail(`Could not save ${file}: ${e.message}`); }
    log(`goals: ${tool} for ${snap.character.key}, rev ${doc.rev}`);
    return done(`${change.text} ${await push(doc, snap)}`);
  }

  return { call, file: key => storeFile(root, key) };
}

function openGameData(dataDir, contextText, log) {
  try {
    return GD.openStore({ dataDir, clientBuild: GD.clientBuildOf(contextText || '') });
  } catch (e) {
    log(`goals: cannot open the synced game data for reference tokens (${e.message})`);
    return null;
  }
}

function createBridgeGoals({ home, context, streamOptions, log = () => {} }) {
  return createGoals({
    dir: home.goals,
    context,
    streamOptions,
    gameData: contextText => openGameData(home.data, contextText, log),
    log,
  });
}

function toolSchemas() {
  return [
    {
      name: TOOL.set,
      description: 'Set, change or drop a profession goal for the character the game last reported. Progress is read from the game, never typed in. Only professions in the Professions line of the game context can be goals. At most 8 goals.',
      inputSchema: {
        type: 'object',
        properties: {
          profession: { type: 'string', description: 'The profession name exactly as the Professions line reports it' },
          skillID: { type: 'integer', description: 'The skill line ID, instead of profession' },
          rank: { type: 'integer', minimum: 1, maximum: TARGET_RANK_LIMIT, description: 'The target skill rank' },
          drop: { type: 'boolean', description: 'true removes the goal' },
        },
      },
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
  ];
}

module.exports = {
  STORE_VERSION, GOALS_FILE, ACTIVE_GOALS_MAX, ORDER_HISTORY_MAX, ORDER_TEXT_MAX, GOAL_TITLE_MAX, OVERLAY_GOALS_MAX, TARGET_RANK_LIMIT,
  TOOL, TOOL_NAMES, WRITE_TOOL_NAMES, PROFESSION_SKILL_IDS, ORDER_WORDS, CONTEXT_STALE_MS, ADDON_CONTEXT_MAX_BYTES,
  parseProfessions, characterOf, snapshotOf, skillIdForName, validateOrderText, orderWords,
  readStore, writeStore, overlayPayload, overlayCommand, listView, storeFile, createGoals, createBridgeGoals, toolSchemas,
};
