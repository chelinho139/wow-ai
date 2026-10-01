'use strict';

const fs = require('fs');
const path = require('path');
const ST = require('./plugins/stream');

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

const PLAIN_WORDS = new Set([
  'A', 'An', 'The', 'And', 'Or', 'But', 'So', 'Then', 'Next', 'Now', 'First', 'Last', 'Again', 'Also', 'Only', 'Just',
  'Until', 'While', 'After', 'Before', 'When', 'If', 'Once', 'At', 'In', 'On', 'To', 'For', 'From', 'With', 'Without',
  'By', 'Of', 'Up', 'Down', 'Out', 'Off', 'Into', 'Each', 'Every', 'All', 'Some', 'More', 'Less', 'No', 'Not', 'Do',
  "Don't", 'Get', 'Go', 'Make', 'Keep', 'Stop', 'Start', 'Finish', 'Use', 'Buy', 'Sell', 'Craft', 'Train', 'Learn',
  'Level', 'Raise', 'Reach', 'Gather', 'Skin', 'Fish', 'Cook', 'Mine', 'Pick', 'Loot', 'Collect', 'Farm', 'Grind',
  'Kill', 'Bandage', 'Repair', 'Rest', 'Bank', 'Hold', 'Save', 'Spend', 'Turn', 'Hand', 'Return', 'Visit', 'Check',
  'Practice', 'Work', 'Push', 'Try', 'Aim', 'Focus', 'Head', 'Find', 'Bring', 'Clear', 'Empty', 'Let', "Let's",
  'Your', 'You', 'My', 'I', 'We', 'Our', 'It', 'This', 'That', 'These', 'Those', 'Here', 'There', 'Today', 'Tonight',
  'Yes', 'Ok', 'Okay', 'Good', 'Great', 'Nice', 'Well', 'Done', 'Quick', 'Fast', 'Slow', 'Easy', 'One', 'Two',
  'Three', 'Four', 'Five', 'Ten', 'Max', 'Goal', 'Order', 'Skill', 'Rank', 'Points',
]);

const MACRO_RE = /wowmacro/i;
const SLASH_COMMAND_RE = /(^|[\s"'(])\/\p{L}/u;
const FORBIDDEN_CHARS_RE = /[|{}<>`\\\u0000-\u001f\u007f]/;
const WORD_SPLIT_RE = /[^\p{L}\p{N}']+/u;
const CAPITAL_RE = /\p{Lu}/u;

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

function parseProfessions(ctxText) {
  const line = contextLine(ctxText, 'Professions');
  if (!line) return [];
  return line.split(/,\s*/).map(part => {
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
  return { text, at: Number(c.at) || 0, character: characterOf(text), professions: parseProfessions(text) };
}

function knownNames(snap) {
  const names = snap.professions.map(p => p.name);
  if (snap.character) names.push(snap.character.name);
  return names;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function maskKnownNames(text, names) {
  const unique = [...new Set((names || []).map(n => String(n || '').trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
  return unique.reduce((out, n) => out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(n)}(?![\\p{L}\\p{N}])`, 'gu'), ' '), text);
}

function unknownCapitalized(text, names) {
  const words = maskKnownNames(text, names).split(WORD_SPLIT_RE);
  return [...new Set(words.filter(w => CAPITAL_RE.test(w) && !PLAIN_WORDS.has(w)))];
}

function validateOrderText(text, names = []) {
  const s = typeof text === 'string' ? text.trim() : '';
  if (!s) return fail('The order text is empty.');
  if (s.length > ORDER_TEXT_MAX) return fail(`The order text is ${s.length} characters; the limit is ${ORDER_TEXT_MAX}.`);
  if (FORBIDDEN_CHARS_RE.test(s)) return fail('The order text may not contain line breaks or any of | { } < > ` \\.');
  if (MACRO_RE.test(s)) return fail('Orders are advice only: no wowmacro blocks.');
  if (SLASH_COMMAND_RE.test(s)) return fail('Orders are advice only: no slash commands.');
  const unknown = unknownCapitalized(s, names);
  if (unknown.length) {
    return fail(`The order names words the game has not reported: ${unknown.join(', ')}. Use plain lowercase words and numbers; the only names allowed are the character and the professions in the Professions line.`);
  }
  return done(s);
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

function issueOrder(doc, args, snap, now) {
  const stamp = now();
  if (args.clear === true) {
    if (!doc.orders.current) return fail('There is no current order to clear.');
    retireOrder(doc, 'cleared', stamp);
    return done('Cleared the current order.');
  }
  const checked = validateOrderText(args.text, knownNames(snap));
  if (!checked.ok) return checked;
  const goalId = args.goalId === undefined || args.goalId === null || args.goalId === '' ? null : String(args.goalId);
  if (goalId && !doc.goals.some(g => g.id === goalId)) return fail(`There is no goal ${goalId}. goal_list shows the ids.`);
  retireOrder(doc, 'superseded', stamp);
  doc.orders.current = { id: `o_${doc.rev + 1}`, text: checked.text, goalId, issuedAt: stamp };
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
    goals: doc.goals.map(g => goalView(g, snap)),
    order: doc.orders.current,
    ordersInHistory: doc.orders.history.length,
  };
}

function overlayPayload(doc, snap, now = Date.now) {
  const current = doc.orders.current;
  const orderGoal = current && current.goalId ? doc.goals.find(g => g.id === current.goalId) : null;
  const goals = doc.goals
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
    asOf: snap.at || now(),
  };
}

function overlayCommand(doc, snap, now) {
  return { action: OVERLAY_ACTION, orders: overlayPayload(doc, snap, now) };
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

  async function push(doc, snap) {
    const options = streamOptions() || {};
    if (!ST.isEnabled(options)) return 'The stream overlay is off (plugins.stream.enabled is false).';
    const url = ST.serviceUrl(options);
    try {
      const r = await post(url, overlayCommand(doc, snap, now));
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
    const change = tool === TOOL.set ? setGoal(doc, args, snap, now) : issueOrder(doc, args, snap, now);
    if (!change.ok) return change;
    doc.rev += 1;
    try { writeStore(file, doc); } catch (e) { return fail(`Could not save ${file}: ${e.message}`); }
    log(`goals: ${tool} for ${snap.character.key}, rev ${doc.rev}`);
    return done(`${change.text} ${await push(doc, snap)}`);
  }

  return { call, file: key => storeFile(root, key) };
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
      description: `Issue the one current order shown on the stream overlay, or clear it. Advice only: no macros and no slash commands. At most ${ORDER_TEXT_MAX} characters of plain words and numbers; the only capitalized names allowed are the character and the professions the game reported. Other game names are rejected.`,
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', maxLength: ORDER_TEXT_MAX, description: 'The order, for example "Skin 30 hides, then train" with plain words' },
          goalId: { type: 'string', description: 'The goal this order serves (an id from goal_list)' },
          clear: { type: 'boolean', description: 'true clears the current order' },
        },
      },
    },
  ];
}

module.exports = {
  STORE_VERSION, GOALS_FILE, ACTIVE_GOALS_MAX, ORDER_HISTORY_MAX, ORDER_TEXT_MAX, GOAL_TITLE_MAX, OVERLAY_GOALS_MAX, TARGET_RANK_LIMIT,
  TOOL, TOOL_NAMES, WRITE_TOOL_NAMES, PROFESSION_SKILL_IDS, PLAIN_WORDS,
  parseProfessions, characterOf, snapshotOf, skillIdForName, validateOrderText, maskKnownNames,
  readStore, writeStore, overlayPayload, overlayCommand, listView, storeFile, createGoals, toolSchemas,
};
