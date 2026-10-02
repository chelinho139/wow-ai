'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const G = require('../bridge/goals');
const LP = require('../bridge/liveproto');
const P = require('../bridge/protocol');
const ST = require('../bridge/plugins/stream');
const GD = require('../bridge/gamedata');
const GR = require('../bridge/gamerefs');
const GM = require('../bridge/goalsmcp');

const ROOT = path.join(__dirname, '..');
const BRIDGE = path.join(ROOT, 'bridge', 'bridge.js');
const ADDON = path.join(ROOT, 'addon', 'ClaudeWoW', 'ClaudeWoW.lua');

const BONE_CONTEXT = [
  'Game: World of Warcraft: Forever (client 1.60.1.70124, interface 16001)',
  'Character: Bone on Classic Beta PvP 2, level 20 Orc Rogue (Horde)',
  'Professions: Leatherworking 107/150, Skinning 187/225, Cooking 11/75, First Aid 97/150, Fishing 4/75',
  'Quest log (id, * = ready to turn in): 101,102*',
].join('\n');
const BONE_KEY = 'Bone-ClassicBetaPvP2';
const CONTEXT_AT = 1790000000000;
const NOW = 1790000500000;

function tmpDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `cw-goals-${name}-`));
}

function rig(opts = {}) {
  const dir = tmpDir('store');
  let ctx = { text: opts.ctx === undefined ? BONE_CONTEXT : opts.ctx, at: CONTEXT_AT };
  const posts = [];
  const streamOptions = opts.streamOptions || { url: 'http://127.0.0.1:9' };
  const post = opts.post || (async (url, command) => { posts.push({ url, command }); return { ok: true, status: 200, message: '' }; });
  const store = G.createGoals({ dir, context: () => ctx, streamOptions: () => streamOptions, post, now: () => NOW, gameData: opts.gameData });
  const file = path.join(dir, BONE_KEY, G.GOALS_FILE);
  const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  return { dir, store, posts, file, read, setContext: text => { ctx = { text, at: CONTEXT_AT + 1000 }; }, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('the profession skill IDs mirror PROFESSION_SKILL_IDS in ClaudeWoW.lua exactly', () => {
  const src = fs.readFileSync(ADDON, 'utf8');
  const block = /local PROFESSION_SKILL_IDS = \{([\s\S]*?)\n\}/.exec(src);
  assert.ok(block, 'the addon table is where the bridge expects it');
  const luaIds = [...block[1].matchAll(/\[(\d+)\]\s*=\s*true/g)].map(m => Number(m[1])).sort((a, b) => a - b);
  const jsIds = Object.keys(G.PROFESSION_SKILL_IDS).map(Number).sort((a, b) => a - b);
  assert.deepEqual(jsIds, luaIds);
});

test('context parsing: the Professions line with ranks, the character and realm as a folder-safe key', () => {
  assert.deepEqual(G.parseProfessions(BONE_CONTEXT), [
    { name: 'Leatherworking', rank: 107, maxRank: 150, skillID: 165 },
    { name: 'Skinning', rank: 187, maxRank: 225, skillID: 393 },
    { name: 'Cooking', rank: 11, maxRank: 75, skillID: 185 },
    { name: 'First Aid', rank: 97, maxRank: 150, skillID: 129 },
    { name: 'Fishing', rank: 4, maxRank: 75, skillID: 356 },
  ]);
  assert.deepEqual(G.parseProfessions('Professions: Kürschnerei 5/75, Mining'), [
    { name: 'Kürschnerei', rank: 5, maxRank: 75, skillID: null },
    { name: 'Mining', rank: null, maxRank: null, skillID: 186 },
  ]);
  assert.deepEqual(G.parseProfessions('Character: Bone'), []);
  assert.deepEqual(G.characterOf(BONE_CONTEXT), { name: 'Bone', realm: 'Classic Beta PvP 2', key: BONE_KEY });
  assert.deepEqual(G.characterOf('Character: Bone (Horde)'), { name: 'Bone', realm: '', key: 'Bone' });
  assert.equal(G.characterOf('Character: ../../etc on ../x, level 1').key, 'etc-x');
  assert.equal(G.characterOf('Game: World of Warcraft'), null);
});

test('order text validator: numbers, plain words and reported names pass in any letter case', () => {
  const names = ['Leatherworking', 'First Aid', 'Bone'];
  for (const text of [
    'Skin 30 more, then raise Leatherworking to 150.',
    'Bone, train First Aid now',
    'raise leatherworking to 150 and first aid to 100',
    'Let\'s cook 20 more',
    'craft until 125',
    'Bone\'s next goal: 50% of first aid\'s max!',
    'sell to a vendor, then buy from the trainer? 2g 50s',
  ]) assert.deepEqual(G.validateOrderText(text, names), { ok: true, text }, text);
  assert.equal(G.validateOrderText('  Skin 10  ', names).text, 'Skin 10', 'trimmed');
  assert.equal(G.validateOrderText('ｓｋｉｎ １０', names).text, 'skin 10', 'stored NFKC-normalized');
});

test('order text validator: every word that is not a number, a plain word or a reported name is refused and named', () => {
  const names = ['Leatherworking', 'Bone'];
  const cases = [
    ['go to orgrimmar and buy from thrall', ['orgrimmar', 'thrall']],
    ['kill worgen in silverpine forest', ['worgen', 'silverpine', 'forest']],
    ['Go to Silverpine Forest', ['silverpine', 'forest']],
    ['skin wolves near the Sepulcher', ['wolves', 'sepulcher']],
    ['Raise Leatherworkingx to 150', ['leatherworkingx']],
    ['Bonesaw time', ['bonesaw']],
    ['raise Tailoring to 50', ['tailoring']],
    ['raise first aid to 50', ['aid']],
    ['buy a heavy KIT', ['heavy', 'kit']],
    ['Ⓞrgrimmar now', ['orgrimmar']],
    ['go to Ｏｒｇｒｉｍｍａｒ', ['orgrimmar']],
    ['use this wowmacro now', ['wowmacro']],
  ];
  for (const [text, words] of cases) {
    const r = G.validateOrderText(text, names);
    assert.equal(r.ok, false, text);
    assert.ok(r.text.includes(`not allowed: ${words.map(w => `"${w}"`).join(', ')}.`), `${text}: ${r.text}`);
    assert.match(r.text, /No zone, NPC, item or quest names/);
    assert.match(r.text, /reported names: Leatherworking, Bone\./);
  }
  const unreported = G.validateOrderText('Raise Leatherworking to 150', []);
  assert.equal(unreported.ok, false, 'a profession is only allowed once the game reported it');
  assert.match(unreported.text, /"leatherworking"/);
  assert.match(unreported.text, /reported names: none reported yet/);
});

test('order text validator: any character outside the plain set is refused, so no slash commands, markup, accents or hidden characters', () => {
  const reject = (text, re) => {
    const r = G.validateOrderText(text, ['Leatherworking', 'Bone']);
    assert.equal(r.ok, false, text);
    assert.match(r.text, re, text);
  };
  reject('/cast stealth', /"\/".*no slash commands/);
  reject('/1 lfg', /"\/".*no slash commands/);
  reject('skin 10,/cast stealth', /"\/".*no slash commands/);
  reject('then /use the kit', /"\/"/);
  reject('skin 30 and/or fish', /"\/"/);
  reject('type "/sit" now', /character """/);
  reject('skin |cff00ff00 now', /"\|"/);
  reject('see {item 2318}', /"\{".*whole reference token/);
  reject('see {item:2318}', /No game data is synced/);
  reject('see <b>', /"<"/);
  reject('one\ntwo', /U\+000A/);
  reject('go to Orgrímmar', /U\+00ED/);
  reject('go to Go​ldshire', /U\+200B/);
  reject('go to Gold­shire', /U\+00AD/);
  reject('go to Gold⁠shire', /U\+2060/);
  reject('ǅungeon', /U\+017E/);
  reject('Boné', /U\+00E9/);
  reject('skin ́', /U\+0301/);
  reject('x'.repeat(G.ORDER_TEXT_MAX + 1), /limit is 90/);
  reject('', /empty/);
  reject(undefined, /empty/);
  assert.match(G.validateOrderText('/cast', []).text, /Allowed: letters A-Z, digits, spaces and , \. ' - : ! \? %\./);
  assert.equal(G.validateOrderText('1'.repeat(G.ORDER_TEXT_MAX), []).ok, true);
});

test('order vocabulary: lowercase, no duplicates, a few hundred plain words, no profession and no game proper name', () => {
  const words = require('../bridge/order-words.json');
  assert.equal(new Set(words).size, words.length, 'no duplicates');
  assert.ok(words.length >= 250, `${words.length} words`);
  for (const w of words) assert.match(w, /^[a-z][a-z']*$/, w);
  const professions = Object.values(G.PROFESSION_SKILL_IDS).flatMap(n => n.toLowerCase().split(' ')).filter(w => w !== 'first');
  for (const p of professions) assert.ok(!G.ORDER_WORDS.has(p), `${p} is allowed only when the game reports it`);
  const properNames = ['horde', 'alliance', 'orc', 'troll', 'tauren', 'undead', 'human', 'dwarf', 'gnome', 'elf', 'rogue', 'warrior',
    'mage', 'priest', 'hunter', 'druid', 'paladin', 'shaman', 'warlock', 'thrall', 'orgrimmar', 'undercity', 'crossroads', 'barrens',
    'brill', 'ratchet', 'everlook', 'sepulcher', 'bulwark', 'durotar', 'mulgore', 'silverpine', 'tirisfal', 'stormwind', 'ironforge',
    'darnassus', 'murloc', 'kobold', 'gnoll', 'worgen', 'defias', 'scourge', 'light', 'hearthstone', 'forest', 'leather', 'linen', 'city'];
  for (const n of properNames) assert.ok(!G.ORDER_WORDS.has(n), n);
});

test('goal_set: a profession goal by name or skillID, progress from the game context, saved per character', async () => {
  const r = rig();
  try {
    const set = await r.store.call('goal_set', { profession: 'leatherworking', rank: 150 });
    assert.equal(set.ok, true, set.text);
    assert.match(set.text, /Set the goal "Leatherworking 150" \(g_165\)\. The stream overlay shows it\./);
    const doc = r.read();
    assert.equal(doc.v, 1);
    assert.equal(doc.rev, 1);
    assert.equal(doc.character, BONE_KEY);
    assert.deepEqual(doc.goals, [{ id: 'g_165', type: 'profession', target: { skillID: 165, rank: 150 }, title: 'Leatherworking 150', createdAt: NOW, updatedAt: NOW }]);
    assert.equal((await r.store.call('goal_set', { skillID: 393, rank: 225 })).ok, true);
    assert.equal((await r.store.call('goal_set', { skillID: 165, rank: 175 })).text.startsWith('Updated the goal "Leatherworking 175"'), true);
    const list = JSON.parse((await r.store.call('goal_list', {})).text);
    assert.equal(list.asOf, CONTEXT_AT);
    assert.deepEqual(list.goals.map(g => [g.id, g.rank, g.targetRank, g.pct]), [['g_165', 107, 175, 61], ['g_393', 187, 225, 83]]);
    r.setContext(BONE_CONTEXT.replace('Leatherworking 107/150', 'Leatherworking 180/225'));
    const after = JSON.parse((await r.store.call('goal_list', {})).text);
    assert.equal(after.goals[0].pct, 100, 'progress comes from the newest context and caps at 100');
    assert.equal(r.read().rev, 3, 'reading never writes');
    const dropped = await r.store.call('goal_set', { skillID: 393, drop: true });
    assert.match(dropped.text, /Dropped the goal "Skinning 225"/);
    assert.deepEqual(r.read().goals.map(g => g.id), ['g_165']);
    assert.deepEqual(fs.readdirSync(path.dirname(r.file)), [G.GOALS_FILE], 'no temp file is left behind');
  } finally { r.cleanup(); }
});

test('goal_set refuses what it cannot track: an unreported profession, a bad rank, a ninth goal, an unknown type, no character', async () => {
  const r = rig();
  try {
    const refuse = async (args, re) => {
      const res = await r.store.call('goal_set', args);
      assert.equal(res.ok, false, JSON.stringify(args));
      assert.match(res.text, re);
    };
    await refuse({ profession: 'Tailoring', rank: 50 }, /has not reported a profession called "Tailoring"/);
    await refuse({ skillID: 197, rank: 50 }, /has not reported skill line 197/);
    await refuse({ skillID: 9999, rank: 50 }, /not a profession skill line/);
    await refuse({ profession: 'Skinning', rank: 0 }, /rank must be a whole number/);
    await refuse({ profession: 'Skinning', rank: 12.5 }, /rank must be a whole number/);
    await refuse({ profession: 'Skinning', rank: G.TARGET_RANK_LIMIT + 1 }, /rank must be a whole number/);
    await refuse({ type: 'gold', profession: 'Skinning', rank: 5 }, /Goal types: "profession", "gearset"/);
    await refuse({ rank: 5 }, /needs profession/);
    assert.equal(fs.existsSync(r.file), false, 'nothing was written');
    assert.equal(r.posts.length, 0, 'nothing was pushed');
  } finally { r.cleanup(); }

  const nine = Object.values(G.PROFESSION_SKILL_IDS).slice(0, 9).map((n, i) => `${n} ${i + 1}/75`).join(', ');
  const full = rig({ ctx: `Character: Bone on Forever\nProfessions: ${nine}` });
  try {
    const names = Object.values(G.PROFESSION_SKILL_IDS).slice(0, 9);
    for (const name of names.slice(0, G.ACTIVE_GOALS_MAX)) assert.equal((await full.store.call('goal_set', { profession: name, rank: 75 })).ok, true, name);
    const ninth = await full.store.call('goal_set', { profession: names[8], rank: 75 });
    assert.equal(ninth.ok, false);
    assert.match(ninth.text, /already 8 goals/);
    assert.equal((await full.store.call('goal_set', { profession: names[0], rank: 70 })).ok, true, 'changing an existing goal still works at the limit');
  } finally { full.cleanup(); }

  const none = rig({ ctx: '' });
  try {
    const res = await none.store.call('goal_set', { profession: 'Skinning', rank: 5 });
    assert.equal(res.ok, false);
    assert.match(res.text, /not reported a character/);
  } finally { none.cleanup(); }
});

test('a goal store that cannot be read is never replaced with an empty one', async () => {
  const r = rig();
  try {
    fs.mkdirSync(r.file, { recursive: true });
    const res = await r.store.call('goal_set', { profession: 'Skinning', rank: 200 });
    assert.equal(res.ok, false);
    assert.match(res.text, /cannot read/);
    assert.equal(r.posts.length, 0);
  } finally { r.cleanup(); }
});

test('a goal store that is not valid JSON is never overwritten', async () => {
  const r = rig();
  try {
    fs.mkdirSync(path.dirname(r.file), { recursive: true });
    fs.writeFileSync(r.file, '{ broken');
    const res = await r.store.call('goal_set', { profession: 'Skinning', rank: 200 });
    assert.equal(res.ok, false);
    assert.match(res.text, /not valid JSON/);
    assert.equal(fs.readFileSync(r.file, 'utf8'), '{ broken');
  } finally { r.cleanup(); }
});

test('order_issue: one current order plus the last 20, checked by the validator, tied to a goal when given', async () => {
  const r = rig();
  try {
    await r.store.call('goal_set', { profession: 'Leatherworking', rank: 150 });
    const first = await r.store.call('order_issue', { text: 'Craft until Leatherworking hits 125', goalId: 'g_165' });
    assert.equal(first.ok, true, first.text);
    assert.deepEqual(r.read().orders.current, { id: 'o_2', text: 'Craft until Leatherworking hits 125', goalId: 'g_165', issuedAt: NOW });
    const bad = await r.store.call('order_issue', { text: 'Skin in Silverpine Forest' });
    assert.equal(bad.ok, false);
    assert.equal(r.read().rev, 2, 'a refused order writes nothing');
    const missing = await r.store.call('order_issue', { text: 'skin 10', goalId: 'g_999' });
    assert.match(missing.text, /no goal g_999/);
    for (let i = 0; i < 25; i++) assert.equal((await r.store.call('order_issue', { text: `skin ${i}` })).ok, true);
    const doc = r.read();
    assert.equal(doc.orders.current.text, 'skin 24');
    assert.equal(doc.orders.current.goalId, null);
    assert.equal(doc.orders.history.length, G.ORDER_HISTORY_MAX);
    assert.equal(doc.orders.history[0].text, 'skin 23');
    assert.equal(doc.orders.history[0].status, 'superseded');
    const cleared = await r.store.call('order_issue', { clear: true });
    assert.equal(cleared.ok, true);
    assert.equal(r.read().orders.current, null);
    assert.equal(r.read().orders.history[0].status, 'cleared');
    assert.equal((await r.store.call('order_issue', { clear: true })).ok, false);
    assert.match((await r.store.call('order_nope', {})).text, /Unknown goal tool/);
  } finally { r.cleanup(); }
});

const WOWDATA = path.join(__dirname, 'fixtures', 'wowdata');
const FIXTURE_BUILD = '1.60.1.200';
const openFixtureData = text => GD.openStore({ dataDir: WOWDATA, clientBuild: GD.clientBuildOf(text) });
const NAMES = ['Leatherworking', 'Bone'];
const fixtureData = (clientBuild = '1.60.1.70124') => GD.openStore({ dataDir: WOWDATA, clientBuild });

test('order tokens: {item:ID}, {skill:ID} and {map:ID,x,y} expand from the fixture data, and the expanded text and refs are stored and shown', async () => {
  const r = rig({ gameData: openFixtureData });
  try {
    const res = await r.store.call('order_issue', { text: 'Buy 2 {item:501}, then train {skill:40} at {map:9003,27.5,25}' });
    assert.equal(res.ok, true, res.text);
    const want = 'Buy 2 Fixture Blade, then train Fixture Craft at Fixture Town';
    assert.match(res.text, new RegExp(`"${want}"`));
    const current = r.read().orders.current;
    assert.equal(current.text, want, 'a map token shows the map name only, never the typed coordinates');
    assert.deepEqual(current.refs, [
      { kind: 'item', id: 501, name: 'Fixture Blade', trust: 'client-data', build: FIXTURE_BUILD },
      { kind: 'skill', id: 40, name: 'Fixture Craft', trust: 'client-data', build: FIXTURE_BUILD },
      { kind: 'map', id: 9003, name: 'Fixture Town', trust: 'client-data', build: FIXTURE_BUILD, point: { x: 27.5, y: 25, trust: 'model' } },
    ]);
    assert.equal(r.posts[0].command.orders.order.text, want, 'the overlay gets the expanded names, never a raw token');
    assert.equal((await r.store.call('order_issue', { text: 'Raise Leatherworking to 150' })).ok, true, 'a plain order still works with data synced');
    assert.equal(r.read().orders.current.refs, undefined, 'an order without tokens stores no refs');
  } finally { r.cleanup(); }
});

test('order tokens: unknown IDs, a malformed map token, a kind with no name source and an unsafe data name refuse the whole order and save nothing', async () => {
  const r = rig({ gameData: openFixtureData });
  try {
    const refuse = async (text, re) => {
      const res = await r.store.call('order_issue', { text });
      assert.equal(res.ok, false, text);
      assert.match(res.text, /The whole order was refused and nothing was saved\./, text);
      assert.match(res.text, re, text);
    };
    await refuse('Buy 2 {item:999}', /\{item:999\}: that item ID is not in the Forever client data for build 1\.60\.1\.200\. Look the ID up with the wowdata tools; never use an ID from memory or from another game version\./);
    await refuse('Buy 2 {item:501} and 5 {item:2318}', /\{item:2318\}: that item ID is not in the Forever client data/);
    await refuse('go to {map:4242,10,10}', /\{map:4242,10,10\}: that map ID/);
    await refuse('go to {map:9003,101,10}', /coordinates run from 0 to 100/);
    await refuse('kill {npc:1} for {quest:2} and {faction:3}', /\{npc:1\}: there is no verified source of npc names yet, so leave that name out\. \{quest:2\}: .*quest names.*\{faction:3\}: .*faction names/);
    await refuse('buy 2 {item:503}', /\{item:503\}: the name in the data has characters that cannot be shown/);
    await refuse('buy 2 {item:504}', /\{item:504\}: the name in the data has characters that cannot be shown/);
    assert.equal(fs.existsSync(r.file), false, 'nothing was written');
    assert.equal(r.posts.length, 0, 'nothing was pushed');
  } finally { r.cleanup(); }
});

test('order tokens: the 90-character cap applies to the expanded text', () => {
  const store = fixtureData();
  const text = `Buy ${'{item:501} '.repeat(7)}now`;
  assert.ok(text.length <= GR.TOKEN_TEXT_MAX);
  const r = G.validateOrderText(text, NAMES, store);
  assert.equal(r.ok, false);
  assert.match(r.text, /characters once its tokens are expanded; the limit is 90/);
  assert.match(G.validateOrderText(`buy ${'1'.repeat(GR.TOKEN_TEXT_MAX)} {item:501}`, NAMES, store).text, /the limit is 400/);
});

test('order tokens: a raw game name next to a valid token is still refused, in any case, split by a hidden character, or with a title-case letter', () => {
  const store = fixtureData();
  const refuse = (text, re) => {
    const r = G.validateOrderText(text, NAMES, store);
    assert.equal(r.ok, false, text);
    assert.match(r.text, re, text);
  };
  refuse('Buy 2 {item:501} in Silverpine', /not allowed: "silverpine"\..*reported names: Leatherworking, Bone\. Name a game thing with a reference token instead/);
  refuse('buy 2 {item:501} from thrall in orgrimmar', /not allowed: "thrall", "orgrimmar"/);
  refuse('go to Under city', /not allowed: "city"/);
  refuse('buy 2 {item:501} in Under city', /not allowed: "city"/);
  refuse('buy 2 {item:501} near the​town', /^The order text has the character U\+200B/);
  refuse('buy 2 {item:501} near the­town', /^The order text has the character U\+00AD/);
  refuse('buy 2 {item:501} in the ‮town', /^The order text has the character U\+202E/);
  refuse('buy 2 {item:501} from ǅungeon', /^The order text has the character U\+017E/);
  refuse('buy {item:501} {item 2}', /"\{"/);
  assert.equal(G.validateOrderText('buy 2 {item:501} near the town', NAMES, store).ok, true, 'precondition: the same words without the hidden character pass');
});

test('order tokens: a token glued to a letter, a digit or another token is refused with the reason', () => {
  const store = fixtureData();
  for (const [text, token] of [['buy 2{item:501} now', '{item:501}'], ['buy {item:501}now', '{item:501}'], ['buy {item:501}{item:502}', '{item:501}'], ['buy 2 {item:501}s', '{item:501}']]) {
    const r = G.validateOrderText(text, NAMES, store);
    assert.equal(r.ok, false, text);
    assert.equal(r.text, `${token} touches a letter, a digit or another token. Put a space or punctuation on both sides of every token.`, text);
  }
  assert.equal(G.validateOrderText('buy 2 {item:501}, {item:502}.', NAMES, store).text, 'buy 2 Fixture Blade, Fixture Letter.');
});

test('order tokens: a data name with a character the order set refuses is refused per token', async () => {
  const r = G.validateOrderText('buy {item:506}', NAMES, fixtureData());
  assert.equal(r.ok, false);
  assert.match(r.text, /\{item:506\}: the name in the data has characters that cannot be shown/);
  const tight = GR.checkText('buy {item:502}', { store: fixtureData(), names: [], plainWords: G.ORDER_WORDS, charRe: /^[A-KM-Za-z0-9 ]$/, maxLength: 90 });
  assert.deepEqual({ problem: tight.problem, char: tight.char, token: tight.token, name: tight.name }, { problem: 'char', char: 'L', token: '{item:502}', name: 'Fixture Letter' }, 'a caller with a tighter set gets the expanded text checked again, naming the token');
});

test('order phrases: a run of plain words that names something in the synced data is refused, unless a token, the character or a reported profession made it', async () => {
  const store = fixtureData();
  const refused = G.validateOrderText('take the low road to 150', NAMES, store);
  assert.equal(refused.ok, false);
  assert.equal(refused.text, 'The order was refused. These word runs are game names: "low road" (a map name in the game data; use {map:ID,x,y} for it). Reword the text or leave the names out.');
  assert.equal(G.validateOrderText('go to the old town', NAMES, store).text, 'The order was refused. These word runs are game names: "old town" (a well-known ability, NPC or place name from the built-in list). Reword the text or leave the names out.', 'no token is offered where no token kind exists');
  assert.equal(G.validateOrderText('you got old. town is next', NAMES, store).ok, true, 'runs stop at sentence and clause marks');
  assert.equal(G.validateOrderText('you got old, town is next', NAMES, store).ok, true);
  assert.equal(G.validateOrderText('go to old - town', NAMES, store).ok, false, 'a dash does not end a clause');
  assert.equal(G.validateOrderText('take the {map:9004,10,10} to 150', NAMES, store).text, 'take the Low Road to 150', 'the same name through a token is fine');
  assert.equal(G.validateOrderText('raise first aid to 100', ['First Aid', 'Bone'], store).ok, true, 'a reported profession that is also in the data and the built-in list');
  assert.equal(G.validateOrderText('take the low road to 150', ['Low Road', 'Bone'], store).ok, true, 'a reported name made of plain words is not refused as a data phrase');
  assert.equal(G.validateOrderText('take the low road to 150', NAMES, null).ok, true, 'without data the data phrases are skipped');
});

test('order phrases: the built-in list refuses well-known ability and place names made of plain words, with or without data', () => {
  for (const data of [null, fixtureData()]) {
    const r = G.validateOrderText('go to old town', NAMES, data);
    assert.equal(r.ok, false);
    assert.match(r.text, /"old town"/);
  }
  assert.equal(G.validateOrderText('go to the town', NAMES, null).ok, true, 'precondition: the words alone are plain');
});

test('order_issue says when the data phrase check was skipped for lack of synced data', async () => {
  const none = rig();
  try {
    const res = await none.store.call('order_issue', { text: 'take the low road to 150' });
    assert.equal(res.ok, true, res.text);
    assert.match(res.text, /No game data is synced for this build yet \(claude-wow data sync\).* Multi-word game names were checked only against the short built-in list\./);
  } finally { none.cleanup(); }
  const mismatch = rig({ gameData: openFixtureData, ctx: BONE_CONTEXT.replace('client 1.60.1.70124', 'client 1.60.0.1') });
  try {
    const res = await mismatch.store.call('order_issue', { text: 'take the low road to 150' });
    assert.equal(res.ok, true, res.text);
    assert.match(res.text, /The synced game data is build 1\.60\.1\.200, which is not in the client's build family \(client 1\.60\.0\.1\)\. Multi-word game names were checked only against the short built-in list\./, 'the note names the real reason');
    assert.doesNotMatch(res.text, /try again|reference token/, 'a saved order gets no retry or token advice');
  } finally { mismatch.cleanup(); }
  const synced = rig({ gameData: openFixtureData });
  try {
    const res = await synced.store.call('order_issue', { text: 'skin 10' });
    assert.equal(res.ok, true);
    assert.doesNotMatch(res.text, /No game data is synced/);
  } finally { synced.cleanup(); }
});

test('order tokens: an order refused by its words never opens the game data; a passing one opens it once', async () => {
  let opened = 0;
  const r = rig({ gameData: text => { opened += 1; return openFixtureData(text); } });
  try {
    assert.equal((await r.store.call('order_issue', { text: 'go to Silverpine' })).ok, false);
    assert.equal(opened, 0, 'a refused-by-words order never opens the data');
    assert.equal((await r.store.call('order_issue', { text: 'buy 2 {item:501}' })).ok, true);
    assert.equal(opened, 1);
  } finally { r.cleanup(); }
});

test('order tokens through the store the bridge builds: the injected home, its data and the context client build expand {item:501}', async () => {
  const dir = tmpDir('bridgegoals');
  try {
    const home = require('../bridge/home').resolve({ CLAUDE_WOW_HOME: dir });
    const store = G.createBridgeGoals({ home, context: () => ({ text: BONE_CONTEXT, at: NOW, receivedAt: Date.now() }), streamOptions: () => ({ ...ST.INERT_OPTIONS }) });
    assert.equal(store.home, home);
    assert.equal(store.home.data, path.join(dir, 'data'));
    fs.cpSync(WOWDATA, home.data, { recursive: true });
    const res = await store.call('order_issue', { text: 'Buy 2 {item:501}' });
    assert.equal(res.ok, true, res.text);
    const saved = JSON.parse(fs.readFileSync(path.join(home.goals, BONE_KEY, G.GOALS_FILE), 'utf8'));
    assert.equal(saved.orders.current.text, 'Buy 2 Fixture Blade');
    assert.equal(saved.orders.current.refs[0].build, FIXTURE_BUILD);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

function copiedData(name) {
  const dir = tmpDir(name);
  fs.cpSync(WOWDATA, dir, { recursive: true });
  return { dir, build: path.join(dir, 'forever', FIXTURE_BUILD), open: () => GD.openStore({ dataDir: dir, clientBuild: '1.60.1.70124' }) };
}

test('order phrases: a missing or damaged phrase table is never taken as a complete index, and the order says so', async () => {
  for (const damage of [
    d => fs.writeFileSync(path.join(d.build, 'uimaps.jsonl'), '{"id":9004,"name":"Low Road"}\n'),
    d => fs.rmSync(path.join(d.build, 'zones.jsonl')),
  ]) {
    const d = copiedData('damaged');
    try {
      damage(d);
      const checked = GR.checkText('take the low road to 150', { store: d.open(), names: NAMES, plainWords: G.ORDER_WORDS, charRe: /^[A-Za-z0-9 ,.'\-:!?%]$/, maxLength: 90 });
      assert.equal(checked.phrasesChecked, false);
      assert.match(checked.phrasesNote, /The synced game data is missing or has a damaged (uimaps|zones) table/);
      const again = GR.checkText('take the low road to 150', { store: d.open(), names: NAMES, plainWords: G.ORDER_WORDS, charRe: /^[A-Za-z0-9 ,.'\-:!?%]$/, maxLength: 90 });
      assert.equal(again.phrasesChecked, false, 'the incomplete index was not cached');
    } finally { fs.rmSync(d.dir, { recursive: true, force: true }); }
  }
});

test('order phrases: a re-sync of the same build with new tables rebuilds the index', () => {
  const d = copiedData('resync');
  try {
    const check = () => G.validateOrderText('go to the far bank', NAMES, d.open());
    assert.equal(check().ok, true);
    fs.appendFileSync(path.join(d.build, 'uimaps.jsonl'), '{"id":9010,"name":"Far Bank","parentUiMapID":9002,"type":3,"system":0}\n');
    const manifestFile = path.join(d.build, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    manifest.entities.uimaps.rows += 1;
    manifest.tableHash = 'fixture-2';
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    assert.match(check().text, /"far bank" \(a map name in the game data/);
  } finally { fs.rmSync(d.dir, { recursive: true, force: true }); }
});

test('order tokens: without synced data, or with data for another build or an unknown client build, no token expands and the order says why', async () => {
  const empty = tmpDir('nodata');
  try {
    const none = GD.openStore({ dataDir: empty, clientBuild: '1.60.1.70124' });
    const tokenOrder = G.validateOrderText('Buy 2 {item:501}', NAMES, none);
    assert.equal(tokenOrder.ok, false);
    assert.match(tokenOrder.text, /No game data is synced for this build yet \(claude-wow data sync\).*only names the game itself reported may appear/);
    const word = G.validateOrderText('Buy 2 in Silverpine', NAMES, none);
    assert.match(word.text, /"silverpine".*Tokens work only once game data is synced for the client's build \(claude-wow data sync, with --flavor classic_era for Classic Era\); until then only names the game reported may appear\./);
    assert.deepEqual(G.validateOrderText('Raise Leatherworking to 150', NAMES, none), { ok: true, text: 'Raise Leatherworking to 150' }, 'Phase 0 orders work as before');
    assert.match(G.validateOrderText('Buy 2 {item:501}', NAMES, null).text, /No game data is synced/);
  } finally { fs.rmSync(empty, { recursive: true, force: true }); }
  const mismatch = G.validateOrderText('Buy 2 {item:501}', NAMES, fixtureData('1.60.2.1'));
  assert.match(mismatch.text, /build 1\.60\.1\.200, which is not in the client's build family \(client 1\.60\.2\.1\)/);
  const unknown = G.validateOrderText('Buy 2 {item:501}', NAMES, fixtureData(''));
  assert.match(unknown.text, /has not reported its client build/);

  const r = rig({ gameData: openFixtureData, ctx: BONE_CONTEXT.replace('client 1.60.1.70124', 'client 1.60.0.1') });
  try {
    const res = await r.store.call('order_issue', { text: 'Buy 2 {item:501}' });
    assert.equal(res.ok, false, 'the client build comes from the game context the order is checked against');
    assert.match(res.text, /not in the client's build family \(client 1\.60\.0\.1\)/);
  } finally { r.cleanup(); }
});

test('display push: the exact orders contract, on every change and never on a read or a refusal', async () => {
  const r = rig();
  try {
    await r.store.call('goal_set', { profession: 'Leatherworking', rank: 150 });
    await r.store.call('goal_set', { profession: 'Skinning', rank: 225 });
    await r.store.call('goal_set', { profession: 'Cooking', rank: 75 });
    await r.store.call('goal_set', { profession: 'First Aid', rank: 150 });
    await r.store.call('order_issue', { text: 'Craft until Leatherworking hits 125', goalId: 'g_165' });
    await r.store.call('goal_list', {});
    await r.store.call('order_issue', { text: 'Go to Silverpine' });
    assert.equal(r.posts.length, 5);
    assert.equal(r.posts[4].url, 'http://127.0.0.1:9');
    assert.deepEqual(r.posts[4].command, {
      action: 'orders',
      orders: {
        order: { text: 'Craft until Leatherworking hits 125', goal: 'Leatherworking 150', pct: 71 },
        goals: [{ title: 'Skinning 225', pct: 83 }, { title: 'Cooking 75', pct: 14 }, { title: 'First Aid 150', pct: 64 }],
        asOf: CONTEXT_AT,
      },
    });
    assert.deepEqual(r.posts[0].command.orders.order, null);
    assert.equal(r.posts[3].command.orders.goals.length, G.OVERLAY_GOALS_MAX, 'without an order the first three goals show');
    assert.equal(r.posts[3].command.orders.goals[0].title, 'Leatherworking 150');
    await r.store.call('order_issue', { text: 'fish 10' });
    assert.deepEqual(r.posts[5].command.orders.order, { text: 'fish 10', goal: '', pct: null });
    assert.deepEqual(r.posts[5].command.orders.goals.map(g => g.title), ['Leatherworking 150', 'Skinning 225', 'Cooking 75']);
  } finally { r.cleanup(); }
});

test('display push: a goal the context no longer reports leaves the overlay list; no context time sends asOf null, never now', () => {
  const doc = { goals: [{ id: 'g_197', title: 'Tailoring 50', target: { skillID: 197, rank: 50 } }, { id: 'g_393', title: 'Skinning 225', target: { skillID: 393, rank: 225 } }], orders: { current: { text: 'x'.repeat(120), goalId: 'g_197' }, history: [] } };
  const payload = G.overlayPayload(doc, G.snapshotOf({ text: BONE_CONTEXT }));
  assert.deepEqual(payload.goals, [{ title: 'Skinning 225', pct: 83 }]);
  assert.equal(payload.order.text.length, G.ORDER_TEXT_MAX);
  assert.equal(payload.order.pct, null);
  assert.equal(payload.asOf, null);
  assert.equal(G.overlayPayload(doc, G.snapshotOf({ text: BONE_CONTEXT, at: 7, receivedAt: 99 })).asOf, 7, 'asOf is when the context was taken, not when it was last confirmed');
});

test('order_issue is refused when the game context is older than 15 minutes; clearing still works, and goal_list shows both times', async () => {
  const r = rig();
  try {
    let ctx = { text: BONE_CONTEXT, at: NOW - G.CONTEXT_STALE_MS - 60000 };
    const store = G.createGoals({ dir: r.dir, context: () => ctx, streamOptions: () => ({ ...ST.INERT_OPTIONS }), now: () => NOW });
    const stale = await store.call('order_issue', { text: 'skin 10' });
    assert.equal(stale.ok, false);
    assert.match(stale.text, /context is 16 minutes old; orders need one from the last 15 minutes/);
    assert.equal(fs.existsSync(r.file), false, 'a refused order writes nothing');
    ctx = { text: BONE_CONTEXT, at: NOW - G.CONTEXT_STALE_MS - 60000, receivedAt: NOW - 1000 };
    assert.equal((await store.call('order_issue', { text: 'skin 10' })).ok, true, 'an unchanged context the game confirmed just now is fresh');
    const list = JSON.parse((await store.call('goal_list', {})).text);
    assert.equal(list.asOf, NOW - G.CONTEXT_STALE_MS - 60000);
    assert.equal(list.contextReceivedAt, NOW - 1000);
    ctx = { text: BONE_CONTEXT, at: NOW - G.CONTEXT_STALE_MS - 60000 };
    assert.equal((await store.call('order_issue', { clear: true })).ok, true);
    ctx = { text: BONE_CONTEXT, at: 0 };
    assert.match((await store.call('order_issue', { text: 'skin 10' })).text, /does not know when the game sent its context/);
  } finally { r.cleanup(); }
});

test('context cut by the addon at 900 bytes: the last Professions entry is dropped, so a cut rank never counts', async () => {
  const src = fs.readFileSync(ADDON, 'utf8');
  assert.equal(Number((/^local CTX = \{ MAX = (\d+)/m.exec(src) || [])[1]), G.ADDON_CONTEXT_MAX_BYTES, 'mirrors CTX.MAX in ClaudeWoW.lua');
  const head = 'Character: Bone on Forever, level 20 Orc Rogue (Horde)\n';
  const tail = 'Professions: Leatherworking 107/150, Skinning 18';
  const cut = head + 'Money: 1g'.padEnd(G.ADDON_CONTEXT_MAX_BYTES - head.length - tail.length - 1, '.') + '\n' + tail;
  assert.equal(Buffer.byteLength(cut), G.ADDON_CONTEXT_MAX_BYTES);
  assert.deepEqual(G.parseProfessions(cut).map(p => [p.name, p.rank]), [['Leatherworking', 107]]);
  const r = rig({ ctx: cut });
  try {
    const res = await r.store.call('goal_set', { profession: 'Skinning', rank: 200 });
    assert.equal(res.ok, false, 'the cut entry is not a reported profession');
  } finally { r.cleanup(); }
});

test('context under the cap keeps its last Professions entry, and a cap-length context whose last line is not Professions keeps all', () => {
  const short = 'Character: Bone\nProfessions: Leatherworking 107/150, Skinning 18';
  assert.deepEqual(G.parseProfessions(short).map(p => [p.name, p.rank]), [['Leatherworking', 107], ['Skinning', 18]]);
  const head = 'Character: Bone\nProfessions: Leatherworking 107/150, Skinning 187/225\nQuest log (id, * = ready to turn in): ';
  const full = head + '1'.repeat(G.ADDON_CONTEXT_MAX_BYTES - head.length);
  assert.equal(Buffer.byteLength(full), G.ADDON_CONTEXT_MAX_BYTES);
  assert.deepEqual(G.parseProfessions(full).map(p => p.name), ['Leatherworking', 'Skinning']);
});

test('display push: stream off never posts, and a stream service that is down does not fail the write', async () => {
  const off = rig({ streamOptions: { ...ST.INERT_OPTIONS } });
  try {
    const res = await off.store.call('goal_set', { profession: 'Skinning', rank: 200 });
    assert.equal(res.ok, true);
    assert.match(res.text, /overlay is off/);
    assert.equal(off.posts.length, 0);
  } finally { off.cleanup(); }
  const down = rig({ post: async () => { throw new Error('connect ECONNREFUSED'); } });
  try {
    const res = await down.store.call('goal_set', { profession: 'Skinning', rank: 200 });
    assert.equal(res.ok, true);
    assert.match(res.text, /Stream service is not running \(http:\/\/127\.0\.0\.1:9\)/);
    assert.equal(down.read().goals.length, 1);
  } finally { down.cleanup(); }
});

test('MCP tool schemas: goal_set, goal_list, order_issue and the two vote tools; every writer, route_draw included, is denied to in-game runs', () => {
  assert.deepEqual(G.toolSchemas().map(t => t.name), ['goal_set', 'goal_list', 'order_issue', 'goal_vote_open', 'goal_vote_close']);
  assert.equal(G.toolSchemas()[2].inputSchema.properties.text.maxLength, GR.TOKEN_TEXT_MAX, 'raw text may carry tokens; the 90-character cap applies after expansion');
  assert.match(G.toolSchemas()[2].description, /\{item:ID\}, \{skill:ID\} or \{map:ID,x,y\}/);
  assert.match(G.toolSchemas()[2].description, /never from memory or another game version/);
  assert.deepEqual(LP.GOAL_WRITE_TOOLS, ['mcp__claude-wow__goal_set', 'mcp__claude-wow__order_issue', 'mcp__claude-wow__goal_vote_open', 'mcp__claude-wow__goal_vote_close', 'mcp__claude-wow__route_draw',
    'mcp__claude-wow__campaign_start', 'mcp__claude-wow__campaign_end', 'mcp__claude-wow__beat_add', 'mcp__claude-wow__beat_trigger', 'mcp__claude-wow__narrate']);
  const acfg = P.withRunDeniedRules({ allowedTools: ['WebSearch'], deniedTools: ['Bash(rm:*)'] }, LP.GOAL_WRITE_TOOLS);
  assert.deepEqual(acfg.deniedTools, ['Bash(rm:*)', ...LP.GOAL_WRITE_TOOLS]);
  assert.deepEqual(P.withoutRules(['WebSearch', 'mcp__claude-wow__order_issue'], LP.GOAL_WRITE_TOOLS), ['WebSearch']);
  assert.equal(P.absolutePathRule('Read', '/Users/me/.claude-wow/live.token'), 'Read(//Users/me/.claude-wow/live.token)');
  assert.equal(P.absolutePathRule('Edit', 'C:\\Users\\me\\.claude-wow\\goals\\**'), 'Edit(//c/Users/me/.claude-wow/goals/**)');
});

function hex(s) {
  return Buffer.from(s, 'utf8').toString('hex');
}

function fakeInstall(dir) {
  const home = path.join(dir, 'home');
  const client = path.join(dir, 'client');
  const addons = path.join(client, 'Interface', 'AddOns');
  for (const d of ['sig', 'ack', 'act', 'presence']) fs.mkdirSync(path.join(addons, 'ClaudeWoW_Runtime', d), { recursive: true });
  fs.mkdirSync(path.join(addons, 'ClaudeWoW'), { recursive: true });
  fs.writeFileSync(path.join(addons, 'ClaudeWoW', 'ClaudeWoW.toc'), '## Interface: 16001\n');
  fs.mkdirSync(path.join(addons, 'ClaudeWoW_S001'), { recursive: true });
  fs.writeFileSync(path.join(addons, 'ClaudeWoW_S001', 'Inbox.lua'), 'ClaudeWoW_SlotData = nil\n');
  fs.mkdirSync(path.join(client, 'Screenshots'), { recursive: true });
  const savedDir = path.join(client, 'WTF', 'Account', 'ACCT', 'SavedVariables');
  fs.mkdirSync(savedDir, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const argvFile = path.join(dir, 'argv.json');
  const agent = path.join(dir, 'fake-claude.js');
  const denials = [
    { tool_name: 'mcp__claude-wow__order_issue', tool_use_id: 't1', tool_input: { text: 'x' } },
    { tool_name: 'NotebookEdit', tool_use_id: 't2', tool_input: {} },
    { tool_name: 'mcp__wowgoals__campaign_start', tool_use_id: 't3', tool_input: {} },
    { tool_name: 'mcp__wowgoals__goal_vote_open', tool_use_id: 't4', tool_input: {} },
    { tool_name: 'mcp__wowgoals__future_tool', tool_use_id: 't5', tool_input: {} },
    { tool_name: 'Grep', tool_use_id: 't6', tool_input: { path: '/' } },
  ];
  fs.writeFileSync(agent, [
    `require('fs').writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));`,
    `process.stdout.write(JSON.stringify({ type: 'result', result: 'ok', session_id: 'sess-1', permission_denials: ${JSON.stringify(denials)} }) + '\\n');`,
  ].join('\n'));
  const cfg = {
    addonDir: addons,
    savedVariablesFile: path.join(savedDir, 'ClaudeWoW.lua'),
    inboxFile: path.join(addons, 'ClaudeWoW_Runtime', 'Inbox.lua'),
    slots: 1, agent: 'claude', agents: { claude: { path: agent, allowedTools: ['WebSearch'] } },
    plugins: { default: 'ask', ask: { cwd: path.join(dir, 'scratch') }, stream: { ...ST.INERT_OPTIONS } },
    gameContext: false, primerFile: '', capture: { enabled: true },
  };
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(cfg, null, 2));
  return { home, addons, saved: cfg.savedVariablesFile, argvFile };
}

function argList(argv, flag) {
  const i = argv.indexOf(flag);
  if (i < 0) return [];
  const out = [];
  for (let j = i + 1; j < argv.length && !argv[j].startsWith('--'); j++) out.push(argv[j]);
  return out;
}

function writeOutbox(saved, id, ctx) {
  const ctxLine = ctx === undefined ? '' : `["ctx"] = "${hex(ctx)}",\n`;
  fs.writeFileSync(saved, `ClaudeWoWDB = {\n["outbox"] = {\n["id"] = ${id},\n["session"] = "sess1",\n["chat"] = "chat1",\n["text"] = "${hex('hi')}",\n["cwd"] = "",\n["plugin"] = "ask",\n${ctxLine}["t"] = 1,\n},\n}\n`);
}

test('the bridge stamps when the game last confirmed its context: a message without a context keeps the text and its time, and moves receivedAt', { timeout: 60000 }, () => {
  const dir = tmpDir('heard');
  try {
    const { home, saved } = fakeInstall(dir);
    const run = () => {
      const r = spawnSync(process.execPath, [BRIDGE, '--once'], { encoding: 'utf8', env: { ...process.env, CLAUDE_WOW_HOME: home }, timeout: 60000 });
      assert.equal(r.status, 0, r.stdout + r.stderr);
      return JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8')).context;
    };
    writeOutbox(saved, 7, BONE_CONTEXT);
    const first = run();
    assert.equal(first.text, BONE_CONTEXT);
    assert.equal(first.receivedAt, first.at);
    const stateFile = path.join(home, 'state.json');
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    state.context.at = 1000;
    state.context.receivedAt = 1000;
    fs.writeFileSync(stateFile, JSON.stringify(state));
    writeOutbox(saved, 8);
    const before = Date.now();
    const second = run();
    assert.equal(second.text, BONE_CONTEXT);
    assert.equal(second.at, 1000, 'the context time stays when the text did not change');
    assert.ok(second.receivedAt >= before, `receivedAt ${second.receivedAt} moved to this message`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('in-game ask runs without the live socket: the channel goal tools and wowgoals are denied, a Need roll can never grant or persist them, and the roll never offers them', { timeout: 60000 }, () => {
  const dir = tmpDir('askrun');
  try {
    const { home, addons, saved, argvFile } = fakeInstall(dir);
    const allow = ['mcp__claude-wow__order_issue', 'mcp__wowgoals__order_issue', 'mcp__wowgoals', 'WebFetch', 'mcp__wowgoals__*', 'mcp__wowgoals__goal_set(*)', 'mcp__wowgoals*', ' mcp__wowgoals__new_tool', 'Grep', 'Read(' + home + '/state.json)', P.absolutePathRule('Read', path.join(home, 'state.json')), 'LS'].join('\x1F');
    const allowOnce = ['mcp__claude-wow__goal_set', 'mcp__wowgoals__goal_set', 'mcp__wowgoals__narrate(x)', 'Glob', 'TodoWrite'].join('\x1F');
    fs.writeFileSync(saved, `ClaudeWoWDB = {\n["outbox"] = {\n["id"] = 7,\n["session"] = "sess1",\n["chat"] = "chat1",\n["text"] = "${hex('set my order')}",\n["cwd"] = "",\n["plugin"] = "ask",\n["allow"] = "${hex(allow)}",\n["allowOnce"] = "${hex(allowOnce)}",\n["t"] = 1,\n},\n}\n`);
    const r = spawnSync(process.execPath, [BRIDGE, '--once'], { encoding: 'utf8', env: { ...process.env, CLAUDE_WOW_HOME: home }, timeout: 60000 });
    const out = r.stdout + r.stderr;
    assert.equal(r.status, 0, out);
    assert.match(out, /\[ask\]/, out);
    const argv = JSON.parse(fs.readFileSync(argvFile, 'utf8'));
    const homes = [...new Set([home, fs.realpathSync(home)])];
    const guards = homes.flatMap(h => [P.absolutePathRule('Read', path.join(h, 'live.token')), P.absolutePathRule('Edit', path.join(h, 'goals', '**')), P.absolutePathRule('Read', path.join(h, 'tmp', 'mcp', '**'))]);
    assert.deepEqual(argList(argv, '--disallowedTools'), [...LP.GOAL_WRITE_TOOLS, 'mcp__wowgoals', ...guards, 'Grep', 'Glob', 'LS', 'NotebookRead', ...homes.map(h => P.absolutePathRule('Read', path.join(h, '**')))], 'the token and the goal store are off limits by their real path too');
    assert.ok(guards.every(g => /^(Read|Edit)\(\/\/[^/]/.test(g)), 'absolute paths take the // prefix');
    assert.ok(!argv.includes('--mcp-config'), 'no live socket under --once, so no wowgoals server');
    assert.match(out, /wowgoals: the live socket is not listening/);
    const allowed = argList(argv, '--allowedTools');
    assert.ok(allowed.includes('WebFetch') && allowed.includes('TodoWrite') && !allowed.includes('Glob'), 'other granted rules still work, for good and once');
    for (const tool of LP.GOAL_WRITE_TOOLS) assert.ok(!allowed.includes(tool), `${tool} is never allowed`);
    assert.deepEqual(allowed.filter(r => r.trim().startsWith('mcp__wowgoals')), [], 'a roll never grants a wowgoals rule');
    const config = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
    assert.deepEqual(config.agents.claude.allowedTools, ['WebSearch', 'WebFetch'], 'a Need click never persists a goal write tool');
    const lua = fs.readFileSync(path.join(addons, 'ClaudeWoW_S001', 'Inbox.lua'), 'utf8');
    const deniedLine = (/^\s*denied = \{.*\},$/m.exec(lua) || [''])[0];
    assert.match(deniedLine, /"NotebookEdit"/, lua);
    assert.doesNotMatch(lua, /goal_set|order_issue|campaign_start|goal_vote_open|future_tool|wowgoals|Grep/, 'neither the roll nor the reply offers a goal write tool');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

function runPluginOnce(dir, { plugin, agent = '' }) {
  const install = fakeInstall(dir);
  const configFile = path.join(install.home, 'config.json');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  config.plugins.roast = { cwd: path.join(dir, 'roast-scratch') };
  config.agents.grok = { path: config.agents.claude.path, allowedTools: ['WebSearch'] };
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  const agentLine = agent ? `["agent"] = "${agent}",\n` : '';
  fs.writeFileSync(install.saved, `ClaudeWoWDB = {\n["outbox"] = {\n["id"] = 7,\n["session"] = "sess1",\n["chat"] = "chat1",\n["text"] = "${hex('grep the home')}",\n["cwd"] = "",\n["plugin"] = "${plugin}",\n${agentLine}["allow"] = "${hex('Grep')}",\n["t"] = 1,\n},\n}\n`);
  const r = spawnSync(process.execPath, [BRIDGE, '--once'], { encoding: 'utf8', env: { ...process.env, CLAUDE_WOW_HOME: install.home }, timeout: 60000 });
  const out = r.stdout + r.stderr;
  if (!agent) assert.equal(r.status, 0, out);
  assert.match(out, new RegExp(`\\[${plugin}\\]`), out);
  const homes = [...new Set([install.home, fs.realpathSync(install.home)])];
  return { ...install, out, argv: JSON.parse(fs.readFileSync(install.argvFile, 'utf8')), homeReads: homes.map(h => P.absolutePathRule('Read', path.join(h, '**'))) };
}

test('a Claude roast run from the game is denied Grep, Glob, LS, NotebookRead and Read of the bridge home, and a roll cannot grant Grep back', { timeout: 60000 }, () => {
  const dir = tmpDir('roast');
  try {
    const { argv, homeReads } = runPluginOnce(dir, { plugin: 'roast' });
    const denied = argList(argv, '--disallowedTools');
    for (const rule of [...GM.FILE_SEARCH_TOOLS, ...homeReads]) assert.ok(denied.includes(rule), `${rule} is denied to a roast run: ${denied.join(' ')}`);
    assert.ok(!argList(argv, '--allowedTools').includes('Grep'), 'a Need roll for Grep is not granted');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a Claude claude-code run from the game keeps Grep, Glob, LS and NotebookRead for its project but is denied Read of the bridge home', { timeout: 60000 }, () => {
  const dir = tmpDir('coding');
  try {
    const { argv, homeReads } = runPluginOnce(dir, { plugin: 'claude-code' });
    const denied = argList(argv, '--disallowedTools');
    for (const rule of homeReads) assert.ok(denied.includes(rule), `${rule} is denied to a coding run: ${denied.join(' ')}`);
    for (const tool of GM.FILE_SEARCH_TOOLS) assert.ok(!denied.includes(tool), `a coding run keeps ${tool}`);
    assert.ok(argList(argv, '--allowedTools').includes('Grep'), 'a coding run may be granted Grep');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a Grok run gets no home read deny, so it can still read the screenshot the bridge keeps in the home', { timeout: 60000 }, () => {
  const dir = tmpDir('grok');
  try {
    const { argv, home, homeReads } = runPluginOnce(dir, { plugin: 'roast', agent: 'grok' });
    assert.ok(argv.includes('--prompt-file'), `the Grok command line ran: ${argv.join(' ')}`);
    const denied = argv.filter((_, i) => argv[i - 1] === '--deny');
    assert.ok(denied.length > 0, 'the in-game deny rules still reach Grok');
    assert.ok(!denied.some(r => homeReads.includes(r)), `no Read of the whole home: ${denied.join(' ')}`);
    for (const tool of GM.FILE_SEARCH_TOOLS) assert.ok(!denied.includes(tool), `Grok keeps ${tool}`);
    assert.ok(denied.some(r => r.includes(path.basename(home)) && r.includes('live.token')), 'the token file stays denied');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

function luaUnescape(s) {
  return s.replace(/\\(\d{1,3}|.)/g, (_, e) => /^\d/.test(e) ? String.fromCharCode(Number(e)) : e === 'n' ? '\n' : e);
}

function luaValue(node) {
  if (node.type === 'TableConstructorExpression') {
    const out = {};
    const arr = [];
    for (const f of node.fields) {
      if (f.type === 'TableKeyString') out[f.key.name] = luaValue(f.value);
      else arr.push(luaValue(f.value));
    }
    return arr.length ? arr : out;
  }
  if (node.type === 'StringLiteral') return luaUnescape(node.raw.slice(1, -1));
  if (node.type === 'NumericLiteral') return node.value;
  if (node.type === 'BooleanLiteral') return node.value;
  return null;
}

function slotData(src, globalName = 'ClaudeWoW_SlotData') {
  const ast = require('luaparse').parse(src, { luaVersion: '5.1' });
  const assign = ast.body.find(n => n.type === 'AssignmentStatement' && n.variables[0].name === globalName);
  assert.ok(assign, `${globalName} assignment present`);
  return luaValue(assign.init[0]);
}

function slotGoals(store) {
  const goalsLua = store.slotLua();
  return slotData(P.luaTable('ClaudeWoW_SlotData', [], { goalsLua, now: NOW })).goals;
}

function writeDoc(r, doc) {
  fs.mkdirSync(path.dirname(r.file), { recursive: true });
  fs.writeFileSync(r.file, JSON.stringify({ v: G.STORE_VERSION, rev: 9, character: BONE_KEY, goals: [], orders: { current: null, history: [] }, ...doc }));
}

test('slot field: the Orders card data rides in the slot table as goals = { rev, order, goals }, read back as Lua', async () => {
  const r = rig();
  try {
    await r.store.call('goal_set', { profession: 'Leatherworking', rank: 150 });
    await r.store.call('goal_set', { profession: 'Skinning', rank: 225 });
    await r.store.call('goal_set', { profession: 'Cooking', rank: 75 });
    await r.store.call('goal_set', { profession: 'First Aid', rank: 150 });
    await r.store.call('order_issue', { text: 'Craft until Leatherworking hits 125', goalId: 'g_165' });
    assert.deepEqual(slotGoals(r.store), {
      rev: 5,
      char: BONE_KEY,
      order: { id: 'o_5', text: 'Craft until Leatherworking hits 125', pct: 71 },
      goals: [{ title: 'Skinning 225', pct: 83 }, { title: 'Cooking 75', pct: 14 }, { title: 'First Aid 150', pct: 64 }],
    });
    await r.store.call('order_issue', { text: 'fish 10' });
    const loose = slotGoals(r.store);
    assert.equal(loose.rev, 6);
    assert.deepEqual(loose.order, { id: 'o_6', text: 'fish 10' }, 'an order without a goal has no pct');
    assert.equal(loose.goals.length, G.SLOT_GOALS_MAX);
    r.setContext(BONE_CONTEXT.replace('Skinning 187/225', 'Skinning 200/225'));
    assert.equal(slotGoals(r.store).goals[1].pct, 88, 'progress follows the latest context without a store write');
  } finally { r.cleanup(); }
});

test('slot field: a cleared order sends the field without an order, so the card hides; no character sends no field', async () => {
  const r = rig();
  try {
    await r.store.call('order_issue', { text: 'skin 10' });
    assert.equal(slotGoals(r.store).order.text, 'skin 10');
    await r.store.call('order_issue', { clear: true });
    const cleared = slotGoals(r.store);
    assert.equal(cleared.rev, 2);
    assert.equal(cleared.order, undefined);
  } finally { r.cleanup(); }
  const nobody = rig({ ctx: '' });
  try {
    assert.equal(nobody.store.slotLua(), '');
  } finally { nobody.cleanup(); }
});

test('slot field: only text that passes the order validator reaches the game, whatever the store file says', () => {
  const r = rig();
  try {
    writeDoc(r, {
      goals: [
        { id: 'g_393', title: 'Skinning 225', target: { skillID: 393, rank: 225 } },
        { id: 'g_165', title: 'Silverpine Leatherworking', target: { skillID: 165, rank: 150 } },
        { id: 'g_185', title: 'Cooking |cffff0000 75', target: { skillID: 185, rank: 75 } },
      ],
      orders: { current: { id: 'o_9', text: 'Skin in Silverpine Forest', goalId: 'g_393' }, history: [] },
    });
    const field = slotGoals(r.store);
    assert.equal(field.order, undefined, 'an order naming a zone is never sent');
    assert.deepEqual(field.goals, [{ title: 'Skinning 225', pct: 83 }], 'goal titles go through the same validator');
    writeDoc(r, { orders: { current: { id: 'nine', text: 'Skin 10 more' }, history: [] } });
    assert.deepEqual(slotGoals(r.store).order, { id: 'o_9', text: 'Skin 10 more' }, 'an unknown id falls back, the text stays checked');
  } finally { r.cleanup(); }
});

test('slot field: a token order shows the expanded names its stored refs allow, with no game data opened; a tampered order stays off and is logged once', async () => {
  const logs = [];
  const dir = tmpDir('slotrefs');
  try {
    const context = () => ({ text: BONE_CONTEXT, at: CONTEXT_AT });
    const issuer = G.createGoals({ dir, context, streamOptions: () => ({ ...ST.INERT_OPTIONS }), now: () => NOW, gameData: openFixtureData });
    let opened = 0;
    const store = G.createGoals({ dir, context, streamOptions: () => ({ ...ST.INERT_OPTIONS }), now: () => NOW, gameData: () => { opened += 1; return null; }, log: m => logs.push(m) });
    const file = path.join(dir, BONE_KEY, G.GOALS_FILE);
    const edit = change => {
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      change(doc.orders.current);
      fs.writeFileSync(file, JSON.stringify(doc));
      const later = new Date(Date.now() + 1000 * (edit.n = (edit.n || 0) + 1));
      fs.utimesSync(file, later, later);
    };
    assert.equal((await issuer.call('order_issue', { text: 'Buy 2 {item:501}, then train {skill:40} at {map:9003,27.5,25}' })).ok, true);
    const want = 'Buy 2 Fixture Blade, then train Fixture Craft at Fixture Town';
    assert.deepEqual(slotGoals(store).order, { id: 'o_1', text: want });
    assert.equal(opened, 0, 'publishing never opens the game data');
    edit(c => { delete c.refs; });
    assert.equal(slotGoals(store).order, undefined, 'without its refs the expanded names are refused');
    assert.equal(slotGoals(store).order, undefined);
    assert.equal(logs.filter(l => /hide the Orders card \(order o_1 is not shown: .*fixture/.test(l)).length, 1, logs.join('\n'));
    edit(c => { c.refs = [{ kind: 'item', id: 501, name: 'Fixture Blade' }]; c.text = 'Buy 2 Fixture Blade in Silverpine'; });
    assert.equal(slotGoals(store).order, undefined, 'a name outside the refs is refused');
    assert.equal((await issuer.call('order_issue', { text: 'take the {map:9004,10,10} to 150' })).ok, true);
    assert.deepEqual(slotGoals(store).order, { id: 'o_2', text: 'take the Low Road to 150' }, 'a name made of plain words shows too');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('slot field: the Lua stays under the byte cap, dropping goals from the end before anything else', () => {
  const longest = 'x'.repeat(G.ORDER_TEXT_MAX);
  const fits = G.luaGoals({ rev: 1, char: 'Bonebonebonebone-ClassicBetaPvP2Realm', order: { id: 'o_1', text: longest, pct: 100 }, goals: [1, 2, 3].map(i => ({ title: `${'y'.repeat(G.GOAL_TITLE_MAX - 2)} ${i}`, pct: 100 })) });
  assert.ok(Buffer.byteLength(fits) <= G.SLOT_LUA_MAX_BYTES, `${Buffer.byteLength(fits)} bytes`);
  assert.equal((fits.match(/title =/g) || []).length, 3, 'the longest real content keeps all three goals');
  const oversized = G.luaGoals({ rev: 1, order: { id: 'o_1', text: longest, pct: 5 }, goals: [1, 2, 3].map(i => ({ title: `${'z'.repeat(250)}${i}`, pct: 1 })) });
  assert.ok(oversized.length > 0, 'the order still goes');
  assert.ok(Buffer.byteLength(oversized) <= G.SLOT_LUA_MAX_BYTES, `${Buffer.byteLength(oversized)} bytes`);
  assert.ok((oversized.match(/title =/g) || []).length < 3, 'goals were dropped to fit');
  assert.match(oversized, /z{250}1/, 'the first goal is kept longest');
  assert.equal(G.luaGoals({ rev: 1, order: { id: 'o_1', text: 'q'.repeat(G.SLOT_LUA_MAX_BYTES), pct: 5 }, goals: [] }), '', 'a field that cannot fit is not sent at all');
});

test('slot field: a store edited on disk is read again; one that cannot be read sends the empty field (the card hides) and is logged once', () => {
  const logs = [];
  const dir = tmpDir('slotlog');
  try {
    const store = G.createGoals({ dir, context: () => ({ text: BONE_CONTEXT, at: CONTEXT_AT }), streamOptions: () => ({ ...ST.INERT_OPTIONS }), now: () => NOW, log: m => logs.push(m) });
    const file = path.join(dir, BONE_KEY, G.GOALS_FILE);
    assert.match(store.slotLua(), /rev = 0, char = "Bone-ClassicBetaPvP2", goals = \{ {2}\}/, 'no store yet: an empty field, so a stale card hides');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ v: 1, rev: 3, goals: [], orders: { current: { id: 'o_3', text: 'Rest' } } }));
    assert.match(store.slotLua(), /text = "Rest"/);
    fs.writeFileSync(file, JSON.stringify({ v: 1, rev: 4, goals: [], orders: { current: { id: 'o_4', text: 'Fish' } } }));
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
    assert.match(store.slotLua(), /text = "Fish"/, 'a newer file on disk is read again');
    fs.writeFileSync(file, '{ broken');
    fs.utimesSync(file, new Date(), new Date(Date.now() + 10000));
    assert.deepEqual(slotGoals(store), { rev: 0, char: BONE_KEY, goals: {} }, 'an unreadable store hides the card');
    assert.deepEqual(slotGoals(store), { rev: 0, char: BONE_KEY, goals: {} });
    assert.equal(logs.filter(l => /hide the Orders card/.test(l)).length, 1, logs.join('\n'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('slot field: a second store written within the same mtime tick is still read again', () => {
  const dir = tmpDir('slotmtime');
  try {
    const store = G.createGoals({ dir, context: () => ({ text: BONE_CONTEXT, at: CONTEXT_AT }), streamOptions: () => ({ ...ST.INERT_OPTIONS }), now: () => NOW });
    const file = path.join(dir, BONE_KEY, G.GOALS_FILE);
    const tick = new Date(1790000000000);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ v: 1, rev: 3, goals: [], orders: { current: { id: 'o_3', text: 'Rest' } } }));
    fs.utimesSync(file, tick, tick);
    assert.equal(slotGoals(store).order.text, 'Rest');
    fs.writeFileSync(file, JSON.stringify({ v: 1, rev: 4, goals: [], orders: { current: { id: 'o_4', text: 'Fish 10 more' } } }));
    fs.utimesSync(file, tick, tick);
    assert.equal(fs.statSync(file).mtimeMs, tick.getTime(), 'both writes carry the same mtime');
    assert.equal(slotGoals(store).order.text, 'Fish 10 more');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('slot field: every goal write republishes the slot files at once; a read or a refusal does not', async () => {
  const dir = tmpDir('onchange');
  let published = 0;
  try {
    const store = G.createGoals({ dir, context: () => ({ text: BONE_CONTEXT, at: CONTEXT_AT }), streamOptions: () => ({ ...ST.INERT_OPTIONS }), now: () => NOW, onChange: () => { published += 1; } });
    await store.call('goal_set', { profession: 'Skinning', rank: 225 });
    await store.call('goal_list', {});
    await store.call('order_issue', { text: 'Go to Silverpine' });
    assert.equal(published, 1);
    await store.call('order_issue', { text: 'skin 10' });
    assert.equal(published, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('slot field: the bridge republishes a goal write as urgent, the mode that keeps a large map and widget set in the slot files', async () => {
  const src = fs.readFileSync(BRIDGE, 'utf8');
  const wiring = /GOALS\.createBridgeGoals\(\{[\s\S]*?onChange: \(\) => publishNow\((\w+), \{ refresh: true \}\)/.exec(src);
  assert.ok(wiring, 'the goal store is wired to publishNow');
  assert.equal(wiring[1], 'true', 'a non-urgent publish drops a map over the progress size from every slot file');
  assert.match(src, /const map = mapShare\.inSlots\(\{ urgent, size: mapLuaSize\(\), progressMax: MAP_PROGRESS_MAX \}\)/, 'urgent is what keeps a large map');
  const dir = tmpDir('bridgegoals');
  try {
    let published = 0;
    const store = G.createBridgeGoals({ home: { goals: path.join(dir, 'goals'), data: WOWDATA }, context: () => ({ text: BONE_CONTEXT, at: CONTEXT_AT }), streamOptions: () => ({ ...ST.INERT_OPTIONS }), onChange: () => { published += 1; } });
    const res = await store.call('goal_set', { profession: 'Skinning', rank: 225 });
    assert.equal(res.ok, true, res.text);
    assert.equal(published, 1, 'createBridgeGoals passes onChange through');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('slot field: urgent publish keeps large widgets too', () => {
  const src = fs.readFileSync(BRIDGE, 'utf8');
  assert.match(src, /const widgets = Date\.now\(\) < widgetShareUntil && \(urgent \|\| widgetSourceBytes\(\) <= WIDGET_PROGRESS_MAX\)/, 'and large widgets');
});

test('slot field through the real bridge: the slot files carry the current order next to the other fields', { timeout: 60000 }, () => {
  const dir = tmpDir('slotbridge');
  try {
    const { home, addons, saved } = fakeInstall(dir);
    const file = path.join(home, 'goals', BONE_KEY, G.GOALS_FILE);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ v: 1, rev: 12, character: BONE_KEY, goals: [{ id: 'g_393', title: 'Skinning 225', target: { skillID: 393, rank: 225 } }], orders: { current: { id: 'o_12', text: 'Skin 30 more', goalId: 'g_393' }, history: [] } }));
    writeOutbox(saved, 7, BONE_CONTEXT);
    const r = spawnSync(process.execPath, [BRIDGE, '--once'], { encoding: 'utf8', env: { ...process.env, CLAUDE_WOW_HOME: home }, timeout: 60000 });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const files = [['ClaudeWoW_S001', 'ClaudeWoW_SlotData'], ['ClaudeWoW_Runtime', 'ClaudeWoW_Inbox']];
    for (const [folder, globalName] of files) {
      const data = slotData(fs.readFileSync(path.join(addons, folder, 'Inbox.lua'), 'utf8'), globalName);
      assert.deepEqual(data.goals, { rev: 12, char: BONE_KEY, order: { id: 'o_12', text: 'Skin 30 more', pct: 83 }, goals: {} });
      assert.ok(Array.isArray(data.replies), 'the replies are still there');
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
