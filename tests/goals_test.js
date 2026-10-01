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
  const store = G.createGoals({ dir, context: () => ctx, streamOptions: () => streamOptions, post, now: () => NOW });
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

test('order text validator: plain words, numbers and reported names pass', () => {
  const names = ['Leatherworking', 'First Aid', 'Bone'];
  for (const text of [
    'Skin 30 hides, then raise Leatherworking to 150.',
    'Bone, train First Aid now',
    'Let\'s cook 20 more',
    'craft until 125',
  ]) assert.deepEqual(G.validateOrderText(text, names), { ok: true, text }, text);
  assert.equal(G.validateOrderText('  Skin 10  ', names).text, 'Skin 10', 'trimmed');
});

test('order text validator: an unreported capitalized word is rejected, also inside a longer word or mid-sentence', () => {
  const names = ['Leatherworking', 'Bone'];
  const cases = [
    ['Go to Silverpine Forest', ['Silverpine', 'Forest']],
    ['skin wolves near the Sepulcher', ['Sepulcher']],
    ['Raise Leatherworkingx to 150', ['Leatherworkingx']],
    ['Bonesaw time', ['Bonesaw']],
    ['raise Tailoring to 50', ['Tailoring']],
    ['buy a heavy KIT', ['KIT']],
  ];
  for (const [text, words] of cases) {
    const r = G.validateOrderText(text, names);
    assert.equal(r.ok, false, text);
    assert.match(r.text, new RegExp(`not reported: ${words.join(', ')}\\.`), text);
  }
  assert.equal(G.validateOrderText('Raise Leatherworking to 150', []).ok, false, 'a profession is only allowed once the game reported it');
});

test('order text validator: macros, slash commands, escape characters, line breaks and long text are rejected', () => {
  const reject = (text, re) => {
    const r = G.validateOrderText(text, ['Leatherworking']);
    assert.equal(r.ok, false, text);
    assert.match(r.text, re, text);
  };
  reject('use this wowmacro now', /no wowmacro/);
  reject('/cast stealth', /no slash commands/);
  reject('then /use the kit', /no slash commands/);
  reject('type "/sit" now', /no slash commands/);
  reject('skin |cff00ff00 now', /\| \{ \} < >/);
  reject('see {item:2318}', /\| \{ \} < >/);
  reject('one\ntwo', /line breaks/);
  reject('x'.repeat(G.ORDER_TEXT_MAX + 1), /limit is 90/);
  reject('', /empty/);
  reject(undefined, /empty/);
  assert.equal(G.validateOrderText('skin 30 and/or fish', []).ok, true, 'a slash inside a word is not a command');
  assert.equal(G.validateOrderText('x'.repeat(G.ORDER_TEXT_MAX), []).ok, true);
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
    await refuse({ type: 'gold', profession: 'Skinning', rank: 5 }, /Only "profession" goals/);
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
        goals: [{ title: 'Leatherworking 150', pct: 71 }, { title: 'Skinning 225', pct: 83 }, { title: 'Cooking 75', pct: 14 }],
        asOf: CONTEXT_AT,
      },
    });
    assert.deepEqual(r.posts[0].command.orders.order, null);
    await r.store.call('order_issue', { text: 'fish 10' });
    assert.deepEqual(r.posts[5].command.orders.order, { text: 'fish 10', goal: '', pct: null });
  } finally { r.cleanup(); }
});

test('display push: a goal the context no longer reports leaves the overlay list; no context time falls back to now', () => {
  const doc = { goals: [{ id: 'g_197', title: 'Tailoring 50', target: { skillID: 197, rank: 50 } }, { id: 'g_393', title: 'Skinning 225', target: { skillID: 393, rank: 225 } }], orders: { current: { text: 'x'.repeat(120), goalId: 'g_197' }, history: [] } };
  const payload = G.overlayPayload(doc, G.snapshotOf({ text: BONE_CONTEXT }), () => 42);
  assert.deepEqual(payload.goals, [{ title: 'Skinning 225', pct: 83 }]);
  assert.equal(payload.order.text.length, G.ORDER_TEXT_MAX);
  assert.equal(payload.order.pct, null);
  assert.equal(payload.asOf, 42);
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

test('MCP tool schemas: goal_set, goal_list and order_issue; only the two writers are denied to in-game runs', () => {
  assert.deepEqual(G.toolSchemas().map(t => t.name), ['goal_set', 'goal_list', 'order_issue']);
  assert.equal(G.toolSchemas()[2].inputSchema.properties.text.maxLength, 90);
  assert.deepEqual(LP.GOAL_WRITE_TOOLS, ['mcp__claude-wow__goal_set', 'mcp__claude-wow__order_issue']);
  const acfg = P.withRunDeniedRules({ allowedTools: ['WebSearch'], deniedTools: ['Bash(rm:*)'] }, LP.GOAL_WRITE_TOOLS);
  assert.deepEqual(acfg.deniedTools, ['Bash(rm:*)', 'mcp__claude-wow__goal_set', 'mcp__claude-wow__order_issue']);
  assert.deepEqual(P.withoutRules(['WebSearch', 'mcp__claude-wow__order_issue'], LP.GOAL_WRITE_TOOLS), ['WebSearch']);
});

function hex(s) {
  return Buffer.from(s, 'utf8').toString('hex');
}

function fakeInstall(dir) {
  const home = path.join(dir, 'home');
  const client = path.join(dir, 'client');
  const addons = path.join(client, 'Interface', 'AddOns');
  for (const d of ['sig', 'ack', 'act', 'presence']) fs.mkdirSync(path.join(addons, 'ClaudeWoW', d), { recursive: true });
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
  ];
  fs.writeFileSync(agent, [
    `require('fs').writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));`,
    `process.stdout.write(JSON.stringify({ type: 'result', result: 'ok', session_id: 'sess-1', permission_denials: ${JSON.stringify(denials)} }) + '\\n');`,
  ].join('\n'));
  const cfg = {
    addonDir: addons,
    savedVariablesFile: path.join(savedDir, 'ClaudeWoW.lua'),
    inboxFile: path.join(addons, 'ClaudeWoW', 'Inbox.lua'),
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

test('in-game ask runs: goal write tools are denied, a Need roll can never grant or persist them, and the roll never offers them', { timeout: 60000 }, () => {
  const dir = tmpDir('askrun');
  try {
    const { home, addons, saved, argvFile } = fakeInstall(dir);
    const allow = ['mcp__claude-wow__order_issue', 'WebFetch'].join('\x1F');
    const allowOnce = ['mcp__claude-wow__goal_set', 'Glob'].join('\x1F');
    fs.writeFileSync(saved, `ClaudeWoWDB = {\n["outbox"] = {\n["id"] = 7,\n["session"] = "sess1",\n["chat"] = "chat1",\n["text"] = "${hex('set my order')}",\n["cwd"] = "",\n["plugin"] = "ask",\n["allow"] = "${hex(allow)}",\n["allowOnce"] = "${hex(allowOnce)}",\n["t"] = 1,\n},\n}\n`);
    const r = spawnSync(process.execPath, [BRIDGE, '--once'], { encoding: 'utf8', env: { ...process.env, CLAUDE_WOW_HOME: home }, timeout: 60000 });
    const out = r.stdout + r.stderr;
    assert.equal(r.status, 0, out);
    assert.match(out, /\[ask\]/, out);
    const argv = JSON.parse(fs.readFileSync(argvFile, 'utf8'));
    assert.deepEqual(argList(argv, '--disallowedTools'), LP.GOAL_WRITE_TOOLS);
    const allowed = argList(argv, '--allowedTools');
    assert.ok(allowed.includes('WebFetch') && allowed.includes('Glob'), 'other granted rules still work, for good and once');
    for (const tool of LP.GOAL_WRITE_TOOLS) assert.ok(!allowed.includes(tool), `${tool} is never allowed`);
    const config = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
    assert.deepEqual(config.agents.claude.allowedTools, ['WebSearch', 'WebFetch'], 'a Need click never persists a goal write tool');
    const lua = fs.readFileSync(path.join(addons, 'ClaudeWoW_S001', 'Inbox.lua'), 'utf8');
    const deniedLine = (/^\s*denied = \{.*\},$/m.exec(lua) || [''])[0];
    assert.match(deniedLine, /"NotebookEdit"/, lua);
    assert.doesNotMatch(lua, /goal_set|order_issue/, 'neither the roll nor the reply offers a goal write tool');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
