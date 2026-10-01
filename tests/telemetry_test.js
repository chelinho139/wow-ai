'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');
const TL = require('../bridge/telemetry');
const P = require('../bridge/protocol');
const G = require('../bridge/goals');

const BRIDGE_SOURCE = path.join(__dirname, '..', 'bridge', 'bridge.js');
const CHARACTER = 'Bone-Forever';

function tmpDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `claude-wow-telemetry-${label}-`));
}

function record(sections) {
  return ['gs1', ...Object.entries(sections).map(([name, data]) => `${name}:${'0'.repeat(8 - String(data.length).length)}${data.length}:${data}`)].join('\n');
}

function gsJob(session, seq, sections, character = CHARACTER) {
  return { session, chat: '', id: seq, cwd: '', kind: 'gs', name: character, text: record(sections) };
}

function store(dir, opts = {}) {
  const lines = [];
  const t = TL.createTelemetry({
    dir,
    log: l => lines.push(l),
    now: opts.now || (() => 1790000000000),
    watch: opts.watch || (() => TL.watchFrom({ watch: { items: { 2589: 40 }, factions: [530] } })),
    rotateBytes: opts.rotateBytes,
  });
  return { t, lines };
}

function readEvents(dir) {
  const file = path.join(dir, CHARACTER, TL.EVENTS_FILE);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}

function luaEval(chunk, expr) {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const code = `${chunk}\nRESULT = ${expr}`;
  if (lauxlib.luaL_dostring(L, to_luastring(code)) !== 0) throw new Error('Lua: ' + to_jsstring(lua.lua_tostring(L, -1)));
  lua.lua_getglobal(L, to_luastring('RESULT'));
  return lua.lua_isnil(L, -1) ? null : to_jsstring(lua.lua_tolstring(L, -1));
}

function submitBody() {
  const src = fs.readFileSync(BRIDGE_SOURCE, 'utf8');
  const start = src.indexOf('function submit(job) {');
  assert.ok(start >= 0, 'bridge.js has submit()');
  const end = src.indexOf('\nfunction ', start + 1);
  return src.slice(start, end);
}

test('submit() branches on kind=gs before any dedupe, ack, sig, signal clearing or lastId update', () => {
  const body = submitBody();
  const branch = body.indexOf('TL.isTelemetry(job)');
  assert.ok(branch > 0, 'the gs branch is in submit()');
  const branchEnd = body.indexOf('return;', branch);
  for (const later of ['fallbackToPixel', 'noteSignalReport', 'alreadyHandled(job)', 'clearSignalsAhead(', 'markHandled(', "signal('ack'", "signal('sig'", 'setContext(', 'runJob(']) {
    const at = body.indexOf(later);
    assert.ok(at < 0 || at > branchEnd, `${later} comes after the gs branch has returned`);
  }
  assert.doesNotMatch(body.slice(branch, branchEnd), /markHandled|signal\(|lastId|clearSignalsAhead|alreadyHandled/, 'the branch itself touches none of them');
});

test('kind=gs is a telemetry record whatever other flags ride with it; other kinds are not', () => {
  const [gs] = P.jobsFromStrip(0, ['sess', '', '7', '', 'kind=gs;h;d;cancel=3', '', 'gs1'].join('\x1F'));
  assert.equal(gs.kind, 'gs');
  assert.equal(TL.isTelemetry(gs), true);
  for (const kind of ['stream', 'roast', undefined]) assert.equal(TL.isTelemetry({ kind, id: 7 }), false);
  assert.equal(TL.isTelemetry(null), false);
});

test('parseRecord reads every section into integers and drops what does not parse', () => {
  const text = record({
    cap: 'C_Reputation.GetFactionDataByID',
    level: '20,1234,5000',
    zone: '1421',
    money: '123456',
    items: '3;2589=12,2592=0',
    skills: '393=75/75,129=40/75',
    equip: '1=16707,16=2140',
    factions: '530=5/-1200',
    life: '2,1790000000',
    recipes: '3275@1790000001',
  });
  const r = TL.parseRecord(text);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.sections.cap.value, { missing: ['C_Reputation.GetFactionDataByID'] });
  assert.deepEqual(r.sections.level.value, { level: 20, xp: 1234, xpMax: 5000 });
  assert.deepEqual(r.sections.zone.value, { mapID: 1421 });
  assert.deepEqual(r.sections.money.value, { copper: 123456 });
  assert.deepEqual(r.sections.items.value, { free: 3, counts: { 2589: 12, 2592: 0 } });
  assert.deepEqual(r.sections.skills.value, { skills: { 393: { rank: 75, max: 75 }, 129: { rank: 40, max: 75 } } });
  assert.deepEqual(r.sections.equip.value, { slots: { 1: 16707, 16: 2140 } });
  assert.deepEqual(r.sections.factions.value, { factions: { 530: { reaction: 5, standing: -1200 } } });
  assert.deepEqual(r.sections.life.value, { deaths: 2, lastDeath: 1790000000 });
  assert.deepEqual(r.sections.recipes.value, { learned: [{ id: 3275, at: 1790000001 }] });

  const bad = TL.parseRecord(['gs1', 'money:00000001:12a', 'zone:00000001:Duskwood', 'equip:00000001:25=1', 'nope:00000001:1', 'level:zzzz:1', 'items:00000001:3;2589=1'].join('\n'));
  assert.deepEqual(Object.keys(bad.sections), ['items']);
  assert.equal(bad.errors.length, 5);
  assert.deepEqual(TL.parseRecord('gs2\nmoney:00000001:1').sections, {}, 'an unknown version is refused whole');
  assert.deepEqual(TL.parseRecord('gs1\nmoney:00000001:' + '1'.repeat(TL.RECORD_TEXT_MAX)).sections, {}, 'a record over 1.5 KB is refused whole');
});

test('a gs record merges into snapshot.json under the goals folder; the first sight of a section is a baseline, later changes are events', () => {
  const dir = tmpDir('merge');
  try {
    const { t } = store(dir);
    assert.equal(t.submit(gsJob('s1', 100, { money: '100', zone: '1421', level: '19,10,100' })).status, 'applied');
    assert.deepEqual(readEvents(dir), [], 'nothing to compare with yet');
    const r = t.submit(gsJob('s1', 101, { money: '150', zone: '1420', level: '20,0,200' }));
    assert.deepEqual(r.events.map(e => [e.type, e.importance]), [['level_up', 3], ['zone', 2], ['money', 1]]);
    const snap = JSON.parse(fs.readFileSync(path.join(dir, CHARACTER, TL.SNAPSHOT_FILE), 'utf8'));
    assert.equal(snap.session, 's1');
    assert.equal(snap.seq, 101);
    assert.deepEqual(snap.sections.money.value, { copper: 150 });
    assert.deepEqual(snap.sections.level.value, { level: 20, xp: 0, xpMax: 200 });
    const ev = readEvents(dir);
    assert.deepEqual(ev.map(e => e.type), ['level_up', 'zone', 'money']);
    assert.deepEqual(ev[2].data, { from: 100, to: 150, delta: 50 });
    assert.equal(ev[0].character, CHARACTER);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('handled.gs is keyed by session: a repeated seq is a duplicate, an older seq never overwrites, and a new session starts over', () => {
  const dir = tmpDir('seq');
  try {
    const { t } = store(dir);
    t.submit(gsJob('s1', 10, { money: '100' }));
    t.submit(gsJob('s1', 11, { money: '150' }));
    assert.equal(t.submit(gsJob('s1', 11, { money: '999' })).status, 'duplicate');
    assert.equal(t.submit(gsJob('s1', 9, { money: '50' })).status, 'stale');
    assert.deepEqual(t.snapshot(CHARACTER).sections.money.value, { copper: 150 });
    assert.ok(t.handled.gs.s1.has(11));
    const fresh = t.submit(gsJob('s2', 1, { money: '160' }));
    assert.equal(fresh.status, 'applied', 'ids restart after a saved-data wipe; the new session is not a duplicate');
    assert.equal(t.snapshot(CHARACTER).session, 's2');
    assert.ok(t.handled.gs.s2.has(1) && !t.handled.gs.s1.has(1));
    assert.equal(readEvents(dir).filter(e => e.type === 'money').length, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the handled map per session stays bounded', () => {
  const dir = tmpDir('bound');
  try {
    const { t } = store(dir);
    for (let seq = 1; seq <= TL.HANDLED_PER_SESSION + 50; seq++) t.submit(gsJob('s1', seq, { money: String(seq) }));
    assert.equal(t.handled.gs.s1.size, TL.HANDLED_PER_SESSION);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a record without a usable character in its name field is dropped with one log line, and nothing is written', () => {
  const dir = tmpDir('nochar');
  try {
    const { t, lines } = store(dir);
    assert.equal(t.submit(gsJob('s1', 1, { money: '1' }, '')).status, 'no-character');
    assert.equal(t.submit(gsJob('s1', 2, { money: '2' }, '../../etc')).status, 'no-character');
    assert.equal(t.submit(gsJob('s1', 3, { money: '3' }, 'Bone Sleeve-Forever')).status, 'no-character');
    assert.equal(t.submit(gsJob('s1', 4, { money: '4' }, '../../etc')).status, 'no-character');
    assert.equal(lines.filter(l => /character key "\.\.\/\.\.\/etc"/.test(l)).length, 1, 'one line per distinct rejected key');
    assert.equal(lines.filter(l => /dropped a game state record whose character key/.test(l)).length, 3, 'each distinct raw key is named once');
    assert.ok(lines.some(l => l.includes(JSON.stringify('Bone Sleeve-Forever'))), 'the raw key is in the log');
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('each record goes to the character it names, whatever the bridge heard last: two clients never mix', () => {
  const dir = tmpDir('twochars');
  try {
    const { t } = store(dir);
    t.submit(gsJob('s1', 10, { money: '100' }, 'Bone-Forever'));
    t.submit(gsJob('s2', 10, { money: '900' }, 'Alt-Forever'));
    t.submit(gsJob('s1', 11, { money: '150' }, 'Bone-Forever'));
    assert.deepEqual(t.snapshot('Bone-Forever').sections.money.value, { copper: 150 });
    assert.deepEqual(t.snapshot('Alt-Forever').sections.money.value, { copper: 900 });
    assert.equal(fs.existsSync(path.join(dir, 'Alt-Forever', TL.EVENTS_FILE)), false, 'the alt has only its baseline');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('watched item counts are importance 2 only when they cross 25/50/75/100% of the target; bags full is importance 2', () => {
  const dir = tmpDir('items');
  try {
    const { t } = store(dir);
    const step = (seq, data) => t.submit(gsJob('s1', seq, { items: data })).events.map(e => [e.type, e.importance, e.data.threshold || null]);
    step(1, '3;2589=9');
    assert.deepEqual(step(2, '3;2589=10'), [['item', 2, 25]], '10 of 40 is 25%');
    assert.deepEqual(step(3, '3;2589=15'), [['item', 1, null]], 'between marks: a loot tick');
    assert.deepEqual(step(4, '3;2589=14'), [['item', 1, null]], 'a count going down never crosses');
    assert.deepEqual(step(5, '3;2589=40'), [['item', 2, 100], ['goal_complete', 3, null]], 'several marks at once: the highest, and the target is met');
    assert.deepEqual(step(6, '0;2589=41'), [['item', 1, null], ['bags_full', 2, null]]);
    assert.deepEqual(step(7, '0;2589=41'), [], 'already full: no second event');
    assert.deepEqual(step(8, '2;2589=41,2592=3'), [], 'an item that just joined the watch list is a baseline');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('thresholdCrossed needs a target and an increase', () => {
  assert.equal(TL.thresholdCrossed(0, 100, 0), null);
  assert.equal(TL.thresholdCrossed(5, 5, 20), null);
  assert.equal(TL.thresholdCrossed(4, 5, 20), 25);
  assert.equal(TL.thresholdCrossed(9, 16, 20), 75);
  assert.equal(TL.thresholdCrossed(19, 30, 20), 100);
  assert.equal(TL.thresholdCrossed(20, 30, 20), null, 'past the target already');
});

test('deaths and new recipes are importance 3; skill, gear and reputation changes are 1, a new reputation rank 2', () => {
  const dir = tmpDir('life');
  try {
    const { t } = store(dir);
    t.submit(gsJob('s1', 1, { life: '0,0', recipes: '', skills: '393=70/75', equip: '1=100', factions: '530=4/2900' }));
    const r = t.submit(gsJob('s1', 2, { life: '1,1790000100', recipes: '3275@1790000090', skills: '393=71/75', equip: '1=101', factions: '530=5/3000' }));
    assert.deepEqual(r.events.map(e => [e.type, e.importance]).sort(), [['death', 3], ['equip', 1], ['recipe', 3], ['reputation', 2], ['skill', 1]].sort());
    const r2 = t.submit(gsJob('s1', 3, { recipes: '3275@1790000090', factions: '530=5/3100' }));
    assert.deepEqual(r2.events.map(e => [e.type, e.importance]), [['reputation', 1]], 'a known recipe is not new again');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the capability probe logs missing collection functions once per change', () => {
  const dir = tmpDir('cap');
  try {
    const { t, lines } = store(dir);
    t.submit(gsJob('s1', 1, { cap: 'C_Item.GetItemCount' }));
    t.submit(gsJob('s1', 2, { cap: 'C_Item.GetItemCount', money: '1' }));
    t.submit(gsJob('s1', 3, { cap: '' }));
    assert.equal(lines.filter(l => /missing C_Item\.GetItemCount/.test(l)).length, 1);
    assert.equal(lines.filter(l => /has every collection function/.test(l)).length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('events.jsonl rotates at the size limit and keeps 2 files', () => {
  const dir = tmpDir('rotate');
  try {
    const { t, lines } = store(dir, { rotateBytes: 600 });
    for (let seq = 1; seq <= 40; seq++) t.submit(gsJob('s1', seq, { money: String(seq * 10) }));
    const files = fs.readdirSync(path.join(dir, CHARACTER)).filter(f => f.startsWith('events')).sort();
    assert.deepEqual(files, [TL.EVENTS_ROTATED_FILE, TL.EVENTS_FILE].sort());
    assert.ok(fs.statSync(path.join(dir, CHARACTER, TL.EVENTS_FILE)).size < 600 + 200);
    assert.ok(lines.filter(l => /rotated to events\.1\.jsonl/.test(l)).length >= 2, 'rotated more than once, still 2 files');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the slot field gs carries each recent character with its session, seq and hashes, plus the watch list, and reads back in Lua', () => {
  const dir = tmpDir('lua');
  try {
    let clockMs = 0;
    const { t } = store(dir, { now: () => ++clockMs });
    assert.equal(luaEval(`X = {\n${t.luaGs()}\n}`, 'X.gs.v .. "/" .. #X.gs.chars'), '1/0', 'nothing known yet: the capability alone');
    for (let i = 0; i < TL.GS_CHARACTERS_MAX + 2; i++) t.submit(gsJob('other', i + 1, { money: String(i) }, `Alt${i}-Forever`));
    const job = gsJob('abc123', 42, { money: '100', zone: '1421' });
    t.submit(job);
    const hashes = TL.parseRecord(job.text).sections;
    const body = P.luaTable('ClaudeWoW_SlotData', [], { gsLua: t.luaGs() });
    const get = expr => luaEval(body, expr);
    assert.equal(get('ClaudeWoW_SlotData.gs.v'), '1');
    assert.equal(get('#ClaudeWoW_SlotData.gs.chars'), String(TL.GS_CHARACTERS_MAX));
    assert.equal(get('ClaudeWoW_SlotData.gs.watch.items[1]'), '2589');
    assert.equal(get('ClaudeWoW_SlotData.gs.watch.factions[1]'), '530');
    const fresh = TL.createTelemetry({ dir, watch: () => TL.watchFrom(null), now: () => 1 });
    const again = P.luaTable('ClaudeWoW_SlotData', [], { gsLua: fresh.luaGs() });
    const find = `(function() for _, e in ipairs(ClaudeWoW_SlotData.gs.chars) do if e.character == "${CHARACTER}" then return e end end end)()`;
    assert.equal(luaEval(again, `${find}.session`), 'abc123', 'a restarted bridge reads the snapshots back for the slot files');
    assert.equal(luaEval(again, `${find}.seq`), '42');
    assert.equal(luaEval(again, `${find}.hashes.money`), hashes.money.hash);
    assert.equal(luaEval(again, `${find}.hashes.zone`), hashes.zone.hash);
    assert.equal(luaEval(again, `${find}.hashes.items`), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a malformed snapshot.json never crashes the bridge: bad sections are dropped with a log line, unreadable files start fresh', () => {
  const dir = tmpDir('malformed');
  try {
    const folder = path.join(dir, CHARACTER);
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, TL.SNAPSHOT_FILE);
    fs.writeFileSync(file, JSON.stringify({ v: 1, session: 's1', seq: 5, sections: {
      money: { seq: 5, hash: '00000003', data: '100' },
      zone: { seq: 'x', hash: '00000001', data: '1' },
      level: { seq: 5, hash: '00000001', data: 'banana' },
      items: null,
      bogus: { seq: 1, hash: '00000001', data: '1' },
      skills: { seq: 5, hash: '00000001' },
    } }));
    const { t, lines } = store(dir);
    const r = t.submit(gsJob('s1', 6, { money: '120', zone: '1421', level: '20,1,2', items: '1;', skills: '' }));
    assert.equal(r.status, 'applied');
    assert.deepEqual(r.events.map(e => e.type), ['money'], 'only the section that survived has a baseline to compare with');
    assert.ok(lines.some(l => /dropped unreadable section\(s\) zone, level, items, bogus, skills/.test(l)), lines.join('\n'));
    for (const broken of ['{', '[]', JSON.stringify({ v: 1, sections: [] }), JSON.stringify({ v: 1, sections: { money: { seq: 1, hash: 'zz', value: { copper: 'lots' } } } })]) {
      fs.writeFileSync(file, broken);
      const fresh = store(dir);
      assert.equal(fresh.t.submit(gsJob('s1', 7, { money: '130' })).status, 'applied', broken);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('bridge.js catches anything telemetry.submit and luaGs throw and logs it', () => {
  const body = submitBody();
  assert.match(body, /try \{ applied = telemetry\.submit\(job\); \} catch \(e\) \{ log\(/);
  assert.match(body, /try \{ campaignStore\.onEvents\(job\.name, applied\.events\); \} catch \(e\) \{ log\(/);
  const src = fs.readFileSync(BRIDGE_SOURCE, 'utf8');
  assert.match(src, /try \{ gsLua = telemetry\.luaGs\(\); \} catch \(e\) \{ log\(/);
});

test('watchFrom takes a target map or a plain list, caps both lists, and drops what is not an ID', () => {
  const w = TL.watchFrom({ watch: { items: { 2589: 40, x: 3, 2592: 'lots' }, factions: [530, '530', -1, 'Orgrimmar', 76] } });
  assert.deepEqual([...w.items.entries()], [[2589, 40], [2592, 0]]);
  assert.deepEqual(w.factions, [530, 76]);
  const list = TL.watchFrom({ watch: { items: Array.from({ length: 30 }, (_, i) => i + 1) } });
  assert.equal(list.items.size, TL.WATCH_ITEMS_MAX);
  assert.deepEqual(TL.watchFrom(undefined), { items: new Map(), factions: [] });
  assert.equal(TL.telemetryEnabled(undefined), true);
  assert.equal(TL.telemetryEnabled({ enabled: false }), false);
});

test('a gs record and a goal for the same character land in the same folder', async () => {
  const dir = tmpDir('samefolder');
  try {
    const context = 'Game: World of Warcraft: Forever\nCharacter: Bone on Forever Realm, level 20 Orc Rogue (Horde)\nProfessions: Skinning 75/75';
    const key = G.characterOf(context).key;
    const { t } = store(dir);
    assert.equal(t.submit(gsJob('s1', 1, { money: '5' }, key)).status, 'applied');
    const goals = G.createGoals({ dir, context: () => ({ text: context, at: Date.now(), receivedAt: Date.now() }), streamOptions: () => ({ enabled: false }) });
    const r = await goals.call('goal_set', { profession: 'Skinning', rank: 150 });
    assert.equal(r.ok, true, r.text);
    assert.equal(path.dirname(t.snapshotFile(key)), path.dirname(goals.file(key)));
    assert.ok(fs.existsSync(t.snapshotFile(key)) && fs.existsSync(goals.file(key)));
    assert.deepEqual(fs.readdirSync(dir), [key], 'one folder for the character');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});



test('the slot field lists the character keys the bridge refused, read back byte for byte in Lua', () => {
  const dir = tmpDir('refused');
  try {
    const { t } = store(dir);
    const odd = 'Bone-For·ever';
    assert.equal(t.submit(gsJob('s1', 1, { money: '1' }, odd)).status, 'no-character');
    const body = P.luaTable('ClaudeWoW_SlotData', [], { gsLua: t.luaGs() });
    assert.equal(luaEval(body, 'ClaudeWoW_SlotData.gs.refused[1]'), odd);
    assert.equal(luaEval(body, '#ClaudeWoW_SlotData.gs.refused'), '1');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('goal_complete fires once per watched target: a dip and a recover across it is not a second completion, a new target is', () => {
  const dir = tmpDir('oncecomplete');
  try {
    const bridgeWith = target => store(dir, { watch: () => TL.watchFrom({ watch: { items: { 2589: target } } }) }).t;
    const completes = (t, seq, data) => t.submit(gsJob('s1', seq, { items: data })).events.filter(ev => ev.type === 'goal_complete').length;
    let t = bridgeWith(40);
    completes(t, 1, '3;2589=30');
    assert.equal(completes(t, 2, '3;2589=40'), 1);
    assert.equal(completes(t, 3, '3;2589=38'), 0);
    assert.equal(completes(t, 4, '3;2589=40'), 0, '40 -> 38 -> 40 is one completion');
    t = bridgeWith(40);
    completes(t, 5, '3;2589=39');
    assert.equal(completes(t, 6, '3;2589=40'), 0, 'the completion is kept in snapshot.json across a restart');
    t = bridgeWith(50);
    assert.equal(completes(t, 7, '3;2589=45'), 0);
    t = bridgeWith(40);
    completes(t, 8, '3;2589=30');
    assert.equal(completes(t, 9, '3;2589=40'), 1, 'a target that changed away and back is a new goal');
    t = bridgeWith(60);
    completes(t, 10, '3;2589=50');
    assert.equal(completes(t, 11, '3;2589=60'), 1, 'a new target completes');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a target changed away and back with no items record in between is a new goal', () => {
  const dir = tmpDir('awayback');
  try {
    const bridgeWith = target => store(dir, { watch: () => TL.watchFrom({ watch: { items: { 2589: target } } }) }).t;
    const completes = (t, seq, sections) => t.submit(gsJob('s1', seq, sections)).events.filter(ev => ev.type === 'goal_complete').length;
    let t = bridgeWith(40);
    completes(t, 1, { items: '3;2589=30' });
    assert.equal(completes(t, 2, { items: '3;2589=40' }), 1);
    t = bridgeWith(50);
    completes(t, 3, { money: '10' });
    t = bridgeWith(40);
    completes(t, 4, { items: '3;2589=39' });
    assert.equal(completes(t, 5, { items: '3;2589=40' }), 1, '40 -> 50 -> 40 is a new goal even when only money arrived during the 50');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('only keys the addon could send are listed as refused, the newest kept; a 3 KB key is logged cut and never relayed', () => {
  const dir = tmpDir('longkey');
  try {
    const { t, lines } = store(dir);
    const huge = 'Б'.repeat(3000) + '-Forever';
    for (let i = 0; i < 25; i++) t.submit(gsJob('s1', 10 + i, { money: '1' }, `Bone${i}-For·ever`));
    assert.equal(t.submit(gsJob('s1', 99, { money: '1' }, huge)).status, 'no-character');
    const logged = lines.find(l => /characters, cut/.test(l));
    assert.ok(logged && logged.length < 400, 'logged once, cut short');
    const body = P.luaTable('ClaudeWoW_SlotData', [], { gsLua: t.luaGs() });
    assert.equal(luaEval(body, '#ClaudeWoW_SlotData.gs.refused'), '20');
    assert.equal(luaEval(body, 'ClaudeWoW_SlotData.gs.refused[20]'), 'Bone24-For·ever', 'the newest is kept');
    assert.equal(luaEval(body, 'ClaudeWoW_SlotData.gs.refused[1]'), 'Bone5-For·ever', 'the oldest went first');
    assert.ok(!body.includes('ББББББББ'), 'the 3 KB key is not in the slot file');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
