'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const G = require('../bridge/goals');
const GD = require('../bridge/gamedata');
const TL = require('../bridge/telemetry');

const BONE_CONTEXT = [
  'Game: World of Warcraft: Forever (client 1.60.1.70124, interface 16001)',
  'Character: Bone on Classic Beta PvP 2, level 20 Orc Rogue (Horde)',
  'Professions: Leatherworking 107/150, Skinning 187/225',
].join('\n');
const BONE_KEY = 'Bone-ClassicBetaPvP2';
const WOWDATA = path.join(__dirname, 'fixtures', 'wowdata');
const BLADE = 501;
const LETTER = 502;
const RING = 505;
const TWO_HAND = 507;
const UNTYPED = 509;
const HELM = 510;

function rig(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-gearset-'));
  let equip = opts.equip === undefined ? null : opts.equip;
  const posts = [];
  const store = G.createGoals({
    dir,
    context: () => ({ text: opts.ctx || BONE_CONTEXT, at: 1000 }),
    now: () => 2000,
    equipped: key => { assert.equal(key, BONE_KEY); return equip; },
    post: async (url, command) => { posts.push(command); return { ok: true, status: 200 }; },
    streamOptions: () => ({ url: 'http://127.0.0.1:9' }),
    gameData: opts.gameData || (text => GD.openStore({ dataDir: WOWDATA, clientBuild: GD.clientBuildOf(text) })),
  });
  const file = path.join(dir, BONE_KEY, G.GOALS_FILE);
  return { store, posts, file, read: () => JSON.parse(fs.readFileSync(file, 'utf8')), equip: e => { equip = e; }, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('gearset: item IDs are checked against the synced data and stored with their refs; the title names the items from the data', async () => {
  const r = rig();
  try {
    const res = await r.store.call('goal_set', { type: 'gearset', slots: { 16: BLADE, 17: BLADE, 11: RING, 1: HELM } });
    assert.equal(res.ok, true, res.text);
    const goal = r.read().goals[0];
    assert.equal(goal.id, G.GEARSET_ID);
    assert.equal(goal.title, 'Gear set: Tablet of the Stars, Rending Claw and 1 more', 'names until the 60-character cap, then a count');
    assert.ok(goal.title.length <= G.GOAL_TITLE_MAX);
    assert.deepEqual(goal.target, { slots: { 1: HELM, 11: RING, 16: BLADE, 17: BLADE } });
    assert.deepEqual(goal.refs.map(ref => [ref.id, ref.slot, ref.trust, ref.build]), [[HELM, 1, 'client-data', '1.60.1.200'], [RING, 11, 'client-data', '1.60.1.200'], [BLADE, 16, 'client-data', '1.60.1.200'], [BLADE, 17, 'client-data', '1.60.1.200']]);
    assert.equal(G.validateOrderText(goal.title, goal.refs.map(ref => ref.name)).ok, true, 'the title passes the viewer text check with its checked names');
    assert.equal(G.validateOrderText(goal.title, []).ok, false, 'and only with them');
    await r.store.call('goal_set', { type: 'gearset', slots: { 16: BLADE, 17: BLADE } });
    assert.equal(r.read().goals[0].title, 'Gear set: 2x Fixture Blade');
  } finally { r.cleanup(); }
});

test('gearset: unknown IDs, wrong slots, items that cannot be worn, bad slot numbers and no data refuse everything', async () => {
  const r = rig();
  try {
    const refuse = async (slots, re, gameData) => {
      const res = await r.store.call('goal_set', { type: 'gearset', slots });
      assert.equal(res.ok, false, JSON.stringify(slots));
      assert.match(res.text, re);
    };
    await refuse({ 16: 2318 }, /slot 16: \{item:2318\} is not in the Forever client data for build 1\.60\.1\.200/);
    await refuse({ 16: BLADE, 1: RING }, /slot 1: \{item:505\} goes in slot 11 or 12, not 1\./);
    await refuse({ 5: LETTER }, /slot 5: \{item:502\} cannot be equipped \(inventory type 0\)/);
    await refuse({ 20: BLADE }, /"20" is not an equipment slot \(1 to 19\)/);
    await refuse({ 0: BLADE }, /"0" is not an equipment slot/);
    await refuse({ 16: 'x' }, /slot 16: the item ID must be a whole number/);
    await refuse({ 1: UNTYPED }, /slot 1: the synced data does not say where \{item:509\} is worn/);
    await refuse({ 16: TWO_HAND, 17: BLADE }, /slot 17: slot 16 holds a two-hand item, so slot 17 stays empty\./);
    await refuse({ 17: TWO_HAND }, /slot 17: \{item:507\} goes in slot 16, not 17\./);
    await refuse({ 1: 504 }, /\{item:504\}: the name in the data has characters that cannot be shown/);
    await refuse({}, /needs slots/);
    await refuse([BLADE], /needs slots/);
    assert.equal(fs.existsSync(r.file), false, 'nothing was written');
  } finally { r.cleanup(); }
  const nodata = rig({ gameData: () => GD.openStore({ dataDir: path.join(os.tmpdir(), 'cw-no-such-data'), clientBuild: '1.60.1.70124' }) });
  try {
    const res = await nodata.store.call('goal_set', { type: 'gearset', slots: { 16: BLADE } });
    assert.equal(res.ok, false);
    assert.match(res.text, /checked against the synced game data\. No game data is synced/);
  } finally { nodata.cleanup(); }
  const otherBuild = rig({ ctx: BONE_CONTEXT.replace('1.60.1.70124', '1.61.0.1') });
  try {
    assert.match((await otherBuild.store.call('goal_set', { type: 'gearset', slots: { 16: BLADE } })).text, /not in the client's build family/);
  } finally { otherBuild.cleanup(); }
});

test('gearset progress: counts set items the telemetry reports equipped, in any matching slot, each equipped item once', () => {
  const goal = { type: 'gearset', target: { slots: { 11: RING, 16: BLADE, 17: BLADE, 1: HELM } } };
  assert.deepEqual(G.progressOf(goal, { equip: null }), { have: null, of: 4, pct: null }, 'no telemetry, no progress');
  assert.deepEqual(G.progressOf(goal, { equip: {} }), { have: 0, of: 4, pct: 0 });
  assert.deepEqual(G.progressOf(goal, { equip: { 12: RING, 16: BLADE } }), { have: 2, of: 4, pct: 50 }, 'a ring in the other finger slot counts; one blade fills one of the two');
  assert.deepEqual(G.progressOf(goal, { equip: { 12: RING, 16: BLADE, 17: BLADE, 1: HELM } }), { have: 4, of: 4, pct: 100 });
});

test('gearset progress reaches the overlay, the Orders card slot field and goal_list from the telemetry snapshot', async () => {
  const r = rig({ equip: { 16: BLADE } });
  try {
    await r.store.call('goal_set', { type: 'gearset', slots: { 16: BLADE, 17: BLADE } });
    assert.deepEqual(r.posts[0].orders.goals, [{ title: 'Gear set: 2x Fixture Blade', pct: 50 }]);
    r.equip({ 16: BLADE, 17: BLADE });
    assert.match(r.store.slotLua(), /goals = \{ \{ title = "Gear set: 2x Fixture Blade", pct = 100 \} \}/);
    const list = JSON.parse((await r.store.call('goal_list', {})).text);
    assert.equal(list.goals[0].equipped, 2);
    assert.equal(list.goals[0].pct, 100);
    assert.deepEqual(list.goals[0].items.map(i => i.name), ['Fixture Blade', 'Fixture Blade']);
    r.equip(null);
    assert.match(r.store.slotLua(), /goals = \{  \}/, 'no equipped data: the bar is left out, never shown as 0');
  } finally { r.cleanup(); }
});

test('gearset: drop removes it; a second goal_set replaces the one set', async () => {
  const r = rig();
  try {
    await r.store.call('goal_set', { type: 'gearset', slots: { 16: BLADE } });
    await r.store.call('goal_set', { type: 'gearset', slots: { 11: RING, 12: RING } });
    assert.equal(r.read().goals.length, 1);
    assert.equal(r.read().goals[0].title, 'Gear set: 2x Rending Claw');
    assert.equal((await r.store.call('goal_set', { type: 'gearset', drop: true })).ok, true);
    assert.deepEqual(r.read().goals, []);
    assert.match((await r.store.call('goal_set', { type: 'gearset', drop: true })).text, /There is no goal for the gear set/);
  } finally { r.cleanup(); }
});

test('gearset: the bridge reads equipped items from the same character folder the telemetry writes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-gearset-tl-'));
  try {
    const tl = TL.createTelemetry({ dir, now: () => 1 });
    const r = tl.submit({ kind: 'gs', session: 'abc', id: 1, name: G.characterOf(BONE_CONTEXT).key, text: 'gs1\nequip:0000000a:16=501,17=501' });
    assert.equal(r.status, 'applied');
    assert.deepEqual(tl.snapshot(BONE_KEY).sections.equip.value.slots, { 16: BLADE, 17: BLADE });
    assert.deepEqual(TL.equippedReader(tl, true)(BONE_KEY), { 16: BLADE, 17: BLADE });
    assert.equal(TL.equippedReader(tl, false)(BONE_KEY), null, 'telemetry turned off shows no stale bar');
    assert.equal(TL.equippedReader(tl, true)('Nobody-Realm'), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the InventoryType slot table is pinned to the forever Enum.InventoryType values and slots 1 to 19', () => {
  assert.deepEqual(G.INVENTORY_TYPE_SLOTS, {
    1: [1], 2: [2], 3: [3], 4: [4], 5: [5], 20: [5], 6: [6], 7: [7], 8: [8], 9: [9], 10: [10],
    11: [11, 12], 12: [13, 14], 13: [16, 17], 21: [16], 17: [16], 14: [17], 22: [17], 23: [17],
    15: [18], 25: [18], 26: [18], 28: [18], 16: [15], 19: [19],
  });
});
