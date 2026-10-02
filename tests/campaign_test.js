'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const luaparse = require('luaparse');
const C = require('../bridge/campaign');
const G = require('../bridge/goals');
const GD = require('../bridge/gamedata');
const LP = require('../bridge/liveproto');
const TL = require('../bridge/telemetry');
const P = require('../bridge/protocol');
const { createChannel } = require('../bridge/channel');

const BONE_CONTEXT = [
  'Game: World of Warcraft: Forever (client 1.60.1.70124, interface 16001)',
  'Character: Bone on Classic Beta PvP 2, level 20 Orc Rogue (Horde)',
  'Professions: Leatherworking 107/150, Skinning 187/225',
  'Quest log (id, * = ready to turn in): 7101*,7102',
].join('\n');
const BONE_KEY = 'Bone-ClassicBetaPvP2';
const NOW = 1790000500000;
const FIXTURE = path.join(__dirname, 'fixtures', 'wowdata', 'forever', '1.60.1.200');
const STORY_MAP_ROWS = [
  { id: 9101, name: 'Fixture Pines', parentUiMapID: 9001, type: 3, system: 0 },
  { id: 9102, name: 'Fixture Hold', parentUiMapID: 9001, type: 3, system: 0 },
];
const QUEST_ROWS = [{ id: 7101 }, { id: 7102 }, { id: 7103 }];

function tmpDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `cw-campaign-${name}-`));
}

function jsonl(rows) {
  return rows.map(r => JSON.stringify(r)).join('\n') + '\n';
}

function addFlavor(root, flavor, build, extra = {}) {
  const dir = path.join(root, flavor, build);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(FIXTURE)) fs.copyFileSync(path.join(FIXTURE, f), path.join(dir, f));
  fs.writeFileSync(path.join(root, flavor, 'current'), `${build}\n`);
  fs.appendFileSync(path.join(dir, 'uimaps.jsonl'), jsonl(STORY_MAP_ROWS));
  fs.writeFileSync(path.join(dir, 'quests.jsonl'), jsonl(QUEST_ROWS));
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  manifest.entities.uimaps.rows += STORY_MAP_ROWS.length;
  manifest.entities.quests = { file: 'quests.jsonl', table: 'QuestV2', rows: QUEST_ROWS.length };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ ...manifest, build, ...extra }));
}

function makeData({ era = false } = {}) {
  const root = tmpDir('data');
  addFlavor(root, 'forever', '1.60.1.200');
  if (era) addFlavor(root, 'classic_era', '1.15.9.70003', { flavor: 'classic_era', product: 'wow_classic_era', buildFamily: '1.15.9' });
  return root;
}

const DATA = makeData();
const DATA_WITH_ERA = makeData({ era: true });
const ERA_CONTEXT = BONE_CONTEXT.replace('Game: World of Warcraft: Forever (client 1.60.1.70124, interface 16001)', 'Game: World of Warcraft Classic (client 1.15.9.70003, interface 11509)');
const openData = text => GD.openStore({ dataDir: DATA, clientBuild: GD.clientBuildOf(text) });

function rig(opts = {}) {
  const dir = tmpDir('store');
  let ctx = { text: opts.ctx === undefined ? BONE_CONTEXT : opts.ctx, at: NOW - 1000 };
  const logs = [];
  let changes = 0;
  let clock = NOW;
  const where = { mapID: null, level: null };
  const store = C.createCampaigns({
    dir,
    context: () => ctx,
    now: () => clock,
    gameData: opts.gameData || openData,
    standing: key => (key === BONE_KEY ? { ...where } : null),
    telemetryOn: opts.telemetryOn,
    log: m => logs.push(m),
    onChange: () => { changes += 1; },
  });
  const file = path.join(dir, BONE_KEY, C.CAMPAIGN_FILE);
  return {
    dir, store, logs, file, where,
    read: () => JSON.parse(fs.readFileSync(file, 'utf8')),
    changes: () => changes,
    tick: ms => { clock += ms; },
    setContext: text => { ctx = { text, at: clock }; },
    events: () => { try { return fs.readFileSync(path.join(dir, BONE_KEY, TL.EVENTS_FILE), 'utf8').trim().split('\n').map(l => JSON.parse(l)); } catch { return []; } },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

const beat = (title, narration, trigger) => ({ title, narration, trigger });

function slotTable(lua) {
  const ast = luaparse.parse(`ClaudeWoW_SlotData = {\n${lua}\n}`, { luaVersion: '5.1' });
  return ast.body[0].init[0].fields[0].value;
}

function field(table, name) {
  const f = table.fields.find(x => x.key && x.key.name === name);
  return f ? f.value : undefined;
}

function luaString(node) {
  return node.raw.slice(1, -1).replace(/\\(.)/g, '$1');
}

test('story text: everyday words, the character name and tokens pass; tokens expand from the synced data', () => {
  const data = openData(BONE_CONTEXT);
  const ok = C.checkStory('Bone, the road into {map:9003,40,40} is quiet. Too quiet.', { names: ['Bone'], store: data, maxLength: 400, what: 'line' });
  assert.equal(ok.ok, true, ok.text);
  assert.equal(ok.text, 'Bone, the road into Fixture Town is quiet. Too quiet.');
  assert.deepEqual(ok.refs.map(r => [r.kind, r.id, r.name]), [['map', 9003, 'Fixture Town']]);
});

test('story text: a corpus of ordinary narration lines passes with the real word list', () => {
  const corpus = [
    'Someone left a letter in your pack. Nobody saw who.',
    'A cold wind follows you down the road.',
    'Not every promise is kept, but this one will be.',
    'Something waits in the dark, and it knows your name.',
    'You fell. Get up. The story is not over.',
    'You feel stronger now. Someone is watching.',
    'The letter was a test, and you passed it.',
    'Rest a while. The hard part comes next.',
  ];
  for (const line of corpus) {
    const r = C.checkStory(line, { names: ['Bone'], store: openData(BONE_CONTEXT), maxLength: 400, what: 'line' });
    assert.equal(r.ok, true, `${line}: ${r.text}`);
  }
});

test('story text: names, links, handles, calls to action and ads are refused', () => {
  const data = openData(BONE_CONTEXT);
  const refused = [
    ['the road to fixture town', /"fixture"/],
    ['take the low road home', /"low road"/],
    ['meet Thrall in the dark', /"thrall"/],
    ['visit http://example.com now', /U\+002F/],
    ['visit www.example.com now', /"www", "com"/],
    ['ask @bone about it', /U\+0040/],
    ['find {npc:123} in the dark', /no verified source of npc names/],
    ['find {quest:7101} soon', /no verified source of quest names/],
    ['go to {map:999999,1,1} now', /not in the Forever client data/],
    ['x'.repeat(401), /limit is 400/],
  ];
  for (const [line, why] of refused) {
    const r = C.checkStory(line, { names: ['Bone'], store: data, maxLength: 400, what: 'line' });
    assert.equal(r.ok, false, line);
    assert.match(r.text, why, line);
  }
  for (const word of C.AD_WORDS) {
    const r = C.checkStory(`a ${word} for you`, { names: ['Bone'], store: null, maxLength: 400, what: 'line' });
    assert.equal(r.ok, false, `${word} is refused in story text`);
    assert.match(r.text, new RegExp(`"${word}"`));
  }
  for (const line of ['subscribe and follow the channel', 'click the link in chat', 'donate to the stream for a shout out']) {
    assert.equal(C.checkStory(line, { names: [], store: null, maxLength: 400, what: 'line' }).ok, false, line);
  }
});

test('triggers: zone and quest IDs must be in the synced data; level, death and manual need no data', () => {
  const data = openData(BONE_CONTEXT);
  assert.deepEqual(C.checkTrigger({ type: 'zone', mapID: 9101 }, data).refs, [{ kind: 'map', id: 9101, name: 'Fixture Pines', trust: 'client-data', build: '1.60.1.200' }]);
  assert.match(C.checkTrigger({ type: 'zone', mapID: 1999 }, data).text, /not a map in the synced data for the client's build/);
  assert.equal(C.checkTrigger({ type: 'quest_turnin', questID: 7101 }, data).ok, true);
  assert.match(C.checkTrigger({ type: 'quest_turnin', questID: 7999 }, data).text, /not a quest in the synced data for the client's build/);
  assert.equal(C.checkTrigger({ type: 'level', level: 21 }, null).ok, true);
  assert.equal(C.checkTrigger({ type: 'level', level: 1 }, null).ok, false);
  assert.equal(C.checkTrigger({ type: 'level', level: 21.5 }, null).ok, false);
  assert.equal(C.checkTrigger({ type: 'death' }, null).ok, true);
  assert.equal(C.checkTrigger({ type: 'manual' }, null).ok, true);
  assert.equal(C.checkTrigger({ type: 'reach' }, null).ok, false, 'no trigger type the telemetry does not report');
  const era = GD.openStore({ dataDir: DATA, clientBuild: '1.15.9.70003' });
  assert.match(C.checkTrigger({ type: 'zone', mapID: 9101 }, era).text, /No game data is synced for this build yet \(claude-wow data sync --flavor classic_era\)/);
  assert.match(C.checkTrigger({ type: 'zone', mapID: 9101 }, null).text, /No game data is synced/);
});

test('campaign tools: start with beats, add, trigger, narrate and end; one campaign per character, written atomically', async () => {
  const r = rig();
  try {
    const start = await r.store.call('campaign_start', { title: 'A letter with no name', beats: [beat('A story begins', ['Someone left a letter in your pack.'], { type: 'manual' })] });
    assert.equal(start.ok, true, start.text);
    assert.match(start.text, /waits for \/dm next/);
    assert.equal(r.changes(), 1, 'a write republishes the slots');
    assert.match((await r.store.call('campaign_start', { title: 'Another one' })).text, /is running/);
    const added = await r.store.call('beat_add', beat('The quiet road', ['The road into {map:9101,50,50} is quiet.'], { type: 'zone', mapID: 9101 }));
    assert.equal(added.ok, true, added.text);
    const doc = r.read();
    assert.equal(doc.character, BONE_KEY);
    assert.deepEqual(doc.campaign.beats.map(b => b.id), ['b1', 'b2']);
    assert.equal(doc.campaign.beats[1].narration[0], 'The road into Fixture Pines is quiet.');
    assert.deepEqual(doc.campaign.beats[1].refs.map(x => [x.kind, x.id]), [['map', 9101], ['map', 9101]]);
    assert.match((await r.store.call('narrate', { text: 'Hello there.' })).text, /No beat has fired yet/);
    assert.equal((await r.store.call('beat_trigger', { id: 'b1' })).ok, true);
    assert.equal(r.read().campaign.current, 'b1');
    assert.equal(r.events().at(-1).type, C.BEAT_EVENT);
    assert.deepEqual(r.events().at(-1).data, { n: 1, of: 2 });
    const said = await r.store.call('narrate', { text: 'The wind turns cold, Bone.' });
    assert.equal(said.ok, true, said.text);
    assert.deepEqual(r.read().campaign.live.map(l => l.text), ['The wind turns cold, Bone.']);
    assert.equal((await r.store.call('narrate', { text: 'Go to the low road.' })).ok, false);
    assert.equal((await r.store.call('beat_trigger', { id: 'b9' })).ok, false);
    assert.equal((await r.store.call('campaign_end', {})).ok, true);
    assert.equal(r.read().campaign, null);
    assert.equal((await r.store.call('campaign_end', {})).ok, false);
    assert.deepEqual(fs.readdirSync(path.dirname(r.file)).filter(f => f.endsWith('.tmp')), [], 'no temp file left behind');
  } finally { r.cleanup(); }
});

test('campaign tools: a bad beat refuses the whole start; limits on beats and lines hold', async () => {
  const r = rig();
  try {
    const bad = await r.store.call('campaign_start', { title: 'Story', beats: [beat('Fine', ['Fine.'], { type: 'manual' }), beat('Bad', ['Fine.'], { type: 'zone', mapID: 1999 })] });
    assert.equal(bad.ok, false);
    assert.match(bad.text, /Beat 2: zone trigger: mapID 1999/);
    assert.equal(fs.existsSync(r.file), false, 'nothing was saved');
    assert.equal((await r.store.call('campaign_start', { title: 'Story', beats: Array.from({ length: C.BEATS_MAX + 1 }, () => beat('b', ['x.'], { type: 'death' })) })).ok, false);
    assert.equal((await r.store.call('campaign_start', { title: 'Story' })).ok, true);
    assert.match((await r.store.call('beat_add', beat('Too much', ['a.', 'b.', 'c.', 'd.', 'e.', 'f.'], { type: 'death' }))).text, /1 to 5 lines/);
    assert.match((await r.store.call('beat_add', beat('Too long', ['quiet '.repeat(40), 'quiet '.repeat(40)], { type: 'death' }))).text, /limit for a beat is 400/);
    for (let i = 0; i < C.BEATS_MAX; i++) assert.equal((await r.store.call('beat_add', beat('Again', ['Again.'], { type: 'death' }))).ok, true);
    assert.match((await r.store.call('beat_add', beat('One more', ['Again.'], { type: 'death' }))).text, /already has 12 beats/);
    assert.match((await r.store.call('beat_add', beat('Unknown', ['x.'], { type: 'quest_turnin', questID: 7999 }))).text, /12 beats|not a quest/);
  } finally { r.cleanup(); }
});

test('campaign tools: no character, a damaged store and an unknown tool are refused without a write', async () => {
  const none = rig({ ctx: 'Game: World of Warcraft: Forever (client 1.60.1.70124, interface 16001)' });
  try {
    assert.match((await none.store.call('campaign_start', { title: 'Story' })).text, /has not reported a character/);
  } finally { none.cleanup(); }
  const r = rig();
  try {
    fs.mkdirSync(path.dirname(r.file), { recursive: true });
    fs.writeFileSync(r.file, '{ not json');
    const res = await r.store.call('campaign_start', { title: 'Story' });
    assert.equal(res.ok, false);
    assert.match(res.text, /not valid JSON/);
    assert.equal(fs.readFileSync(r.file, 'utf8'), '{ not json', 'never overwritten');
    assert.match((await r.store.call('campaign_nope', {})).text, /Unknown campaign tool/);
  } finally { r.cleanup(); }
});

test('beats fire from telemetry events: only the armed beat, in order, one per batch, for that character', async () => {
  const r = rig();
  try {
    const started = await r.store.call('campaign_start', { title: 'Story', beats: [
      beat('Into the dark', ['A cold wind.'], { type: 'zone', mapID: 9101 }),
      beat('Fallen', ['Get up.'], { type: 'death' }),
      beat('Stronger', ['You feel stronger now.'], { type: 'level', level: 21 }),
      beat('Home', ['Rest.'], { type: 'zone', mapID: 9102 }),
    ] });
    assert.equal(started.ok, true, started.text);
    const ids = list => list.map(b => b.id);
    assert.deepEqual(r.store.onEvents(BONE_KEY, [{ type: 'death', data: {} }]), [], 'death is not armed yet');
    assert.deepEqual(r.store.onEvents(BONE_KEY, [{ type: 'zone', data: { from: 9001, to: 9102 } }]), [], 'a later beat never fires out of order');
    assert.deepEqual(r.store.onEvents('Other-Realm', [{ type: 'zone', data: { from: 9001, to: 9101 } }]), [], 'another character has no campaign');
    assert.equal(r.read().campaign.current, null);
    assert.deepEqual(ids(r.store.onEvents(BONE_KEY, [{ type: 'death', data: {} }, { type: 'zone', data: { from: 9001, to: 9101 } }])), ['b1'], 'an event before the beat it would fire is not kept for later');
    assert.deepEqual(ids(r.store.onEvents(BONE_KEY, [{ type: 'death', data: {} }, { type: 'level_up', data: { from: 19, to: 20 } }])), ['b2'], 'the death fires b2; the level is below b3');
    assert.deepEqual(ids(r.store.onEvents(BONE_KEY, [{ type: 'level_up', data: { from: 20, to: 22 } }, { type: 'zone', data: { from: 9101, to: 9102 } }])), ['b3', 'b4'], 'the rest of the batch is checked against each newly armed beat');
    assert.deepEqual(r.store.onEvents(BONE_KEY, [{ type: 'zone', data: { from: 9102, to: 9101 } }]), [], 'nothing is armed after the last beat');
    assert.deepEqual(r.read().campaign.fired.map(f => [f.id, f.by]), [['b1', 'zone'], ['b2', 'death'], ['b3', 'level'], ['b4', 'zone']]);
    assert.deepEqual(r.events().map(e => e.data.n), [1, 2, 3, 4], 'each beat is one importance-3 event for the live session');
    assert.ok(r.events().every(e => e.importance === 3 && e.type === 'beat'));
  } finally { r.cleanup(); }
});

test('zone and level beats armed while the character is already there fire at once or on the next game update, one at a time', async () => {
  const r = rig();
  try {
    r.where.mapID = 9101;
    r.where.level = 20;
    const started = await r.store.call('campaign_start', { title: 'Story', beats: [beat('Here', ['A cold wind.'], { type: 'zone', mapID: 9101 }), beat('Still here', ['Quiet.'], { type: 'zone', mapID: 9101 }), beat('Strong', ['Stronger.'], { type: 'level', level: 20 })] });
    assert.equal(started.ok, true, started.text);
    assert.match(started.text, /already there, so beat b1 fired now/);
    assert.equal(r.read().campaign.current, 'b1');
    assert.deepEqual(r.store.onEvents(BONE_KEY, []).map(b => b.id), ['b2'], 'the next update with the character still there fires b2, not b2 and b3 at once');
    assert.deepEqual(r.store.onEvents(BONE_KEY, []).map(b => b.id), ['b3']);
    assert.deepEqual(r.read().campaign.fired.map(f => f.by), ['zone (already there)', 'zone (already there)', 'level (already there)']);
  } finally { r.cleanup(); }
  const away = rig();
  try {
    away.where.mapID = 9102;
    await away.store.call('campaign_start', { title: 'Story', beats: [beat('Begin', ['Go.'], { type: 'manual' }), beat('Here', ['A cold wind.'], { type: 'zone', mapID: 9101 })] });
    assert.equal(away.read().campaign.current, null, 'a manual beat never fires by standing');
    away.store.manual(BONE_KEY);
    assert.deepEqual(away.store.onEvents(BONE_KEY, []), [], 'elsewhere: b2 waits');
    away.where.mapID = 9101;
    assert.deepEqual(away.store.onEvents(BONE_KEY, []).map(b => b.id), ['b2'], 'a beat armed by /dm next where the character stands fires on the next update');
    const added = await away.store.call('beat_add', beat('More', ['Again.'], { type: 'zone', mapID: 9101 }));
    assert.match(added.text, /beat b3 fired now/, 'beat_add arms it while the character is there');
  } finally { away.cleanup(); }
});

test('a quest beat fires only on the game\'s own turn-in event, never on quests leaving the log', async () => {
  const r = rig();
  try {
    await r.store.call('campaign_start', { title: 'Story', beats: [beat('Paid', ['Well done.'], { type: 'quest_turnin', questID: 7101 })] });
    assert.deepEqual(r.store.onEvents(BONE_KEY, [{ type: 'item', data: { id: 1, from: 1, to: 2 } }]), [], 'other events');
    assert.deepEqual(r.store.onEvents(BONE_KEY, [{ type: 'quest_turnin', data: { id: 7102, at: 1 } }]), [], 'another quest');
    r.setContext(BONE_CONTEXT.replace('7101*,7102', ''));
    assert.equal(r.read().campaign.current, null, '7101* and 7102 vanishing from the log together fire nothing');
    assert.deepEqual(r.store.onEvents(BONE_KEY, [{ type: 'quest_turnin', data: { id: 7101, at: 2 } }]).map(b => b.id), ['b1']);
    assert.deepEqual(r.read().campaign.fired.map(f => f.by), ['quest_turnin']);
  } finally { r.cleanup(); }
});

test('story text is refused when multi-word game names cannot be checked: no data, another build family', () => {
  const mismatch = GD.openStore({ dataDir: DATA, clientBuild: '1.15.9.70003' });
  const r = C.checkStory('take the low road home', { names: ['Bone'], store: mismatch, maxLength: 400, what: 'line' });
  assert.equal(r.ok, false);
  assert.match(r.text, /cannot be checked/);
  assert.match(r.text, /No game data is synced for this build yet \(claude-wow data sync --flavor classic_era\)/);
  assert.equal(C.checkStory('A cold wind.', { names: [], store: null, maxLength: 400, what: 'line' }).ok, false, 'no data at all');
  assert.equal(C.checkStory('A cold wind.', { names: [], store: openData(BONE_CONTEXT), maxLength: 400, what: 'line' }).ok, true);
});

test('campaign writes need a fresh game context; ending a campaign always works', async () => {
  const r = rig();
  try {
    assert.equal((await r.store.call('campaign_start', { title: 'Story' })).ok, true);
    r.tick(G.CONTEXT_STALE_MS + 60000);
    for (const [tool, args] of [['campaign_start', { title: 'Again' }], ['beat_add', beat('x', ['A cold wind.'], { type: 'death' })], ['beat_trigger', { id: 'b1' }], ['narrate', { text: 'Hello.' }]]) {
      const res = await r.store.call(tool, args);
      assert.equal(res.ok, false, tool);
      assert.match(res.text, /minutes old; campaign writes need one from the last 15 minutes/, tool);
    }
    assert.equal((await r.store.call('campaign_end', {})).ok, true);
  } finally { r.cleanup(); }
});

test('/dm next fires only a beat that waits for it, and only for the character the record names', async () => {
  const r = rig();
  try {
    assert.match(r.store.manual(BONE_KEY).text, /nothing fired/);
    await r.store.call('campaign_start', { title: 'Story', beats: [beat('Begin', ['Go.'], { type: 'manual' }), beat('Later', ['Go on.'], { type: 'death' })] });
    assert.match(r.store.manual('Ash-ClassicBetaPvP2').text, /nothing fired/);
    assert.match(r.store.manual('bad key!').text, /names no character/);
    assert.deepEqual(r.store.manual(BONE_KEY), { fired: true, text: 'beat b1 fired' });
    assert.match(r.store.manual(BONE_KEY).text, /nothing fired/, 'the next beat waits for a death');
    assert.equal(r.read().campaign.current, 'b1');
  } finally { r.cleanup(); }
  assert.equal(C.isDmRecord({ kind: 'dm', text: 'next' }), true);
  assert.equal(C.isDmRecord({ kind: 'gs' }), false);
  assert.equal(P.parseFlags('kind=dm').kind, 'dm', 'a kind the strip parser already carries');
});

test('slot field: an explicit empty value with no character or no campaign; the current beat with its lines; manual flag', async () => {
  const none = rig({ ctx: 'Game: World of Warcraft: Forever (client 1.60.1.70124, interface 16001)' });
  try {
    const t = slotTable(none.store.slotLua());
    assert.equal(field(t, 'char').raw, '""');
    assert.equal(field(t, 'beat'), undefined);
  } finally { none.cleanup(); }
  const r = rig();
  try {
    let t = slotTable(r.store.slotLua());
    assert.equal(luaString(field(t, 'char')), BONE_KEY);
    assert.equal(Number(field(t, 'now').raw), Math.floor(NOW / 1000));
    assert.equal(field(t, 'beat'), undefined, 'no campaign: nothing to show, said explicitly');
    await r.store.call('campaign_start', { title: 'Story', beats: [beat('Begin', ['Line one.', 'Line two, Bone.'], { type: 'manual' })] });
    t = slotTable(r.store.slotLua());
    assert.equal(field(t, 'manual').raw, 'true');
    assert.equal(field(t, 'beat'), undefined, 'nothing has fired yet');
    r.store.manual(BONE_KEY);
    await r.store.call('narrate', { text: 'A live line.' });
    t = slotTable(r.store.slotLua());
    assert.equal(field(t, 'manual'), undefined, 'nothing waits for /dm next now');
    const b = field(t, 'beat');
    assert.equal(luaString(field(b, 'id')), 'b1');
    assert.equal(luaString(field(b, 'title')), 'Begin');
    assert.deepEqual(field(b, 'lines').fields.map(f => luaString(f.value)), ['Line one.', 'Line two, Bone.', 'A live line.']);
    assert.equal(Number(field(t, 'rev').raw), r.read().rev);
  } finally { r.cleanup(); }
});

test('slot field: text edited into the store by hand is checked again and withheld; a damaged store sends the empty field', async () => {
  const r = rig();
  try {
    await r.store.call('campaign_start', { title: 'Story', beats: [beat('Begin', ['Line one.'], { type: 'manual' })] });
    r.store.manual(BONE_KEY);
    const doc = r.read();
    doc.campaign.beats[0].narration.push('Meet Thrall in the dark.');
    fs.writeFileSync(r.file, JSON.stringify(doc));
    let b = field(slotTable(r.store.slotLua()), 'beat');
    assert.deepEqual(field(b, 'lines').fields.map(f => luaString(f.value)), ['Line one.']);
    assert.ok(r.logs.some(l => /1 line\(s\) of beat b1 failed the story text check/.test(l)), r.logs.join('\n'));
    doc.campaign.beats[0].title = 'Thrall';
    fs.writeFileSync(r.file, JSON.stringify(doc) + ' ');
    assert.equal(field(slotTable(r.store.slotLua()), 'beat'), undefined, 'a title that fails hides the beat');
    fs.writeFileSync(r.file, '{ broken');
    const t = slotTable(r.store.slotLua());
    assert.equal(luaString(field(t, 'char')), BONE_KEY);
    assert.equal(field(t, 'beat'), undefined);
    const before = r.logs.length;
    r.store.slotLua();
    assert.equal(r.logs.length, before, 'the same problem is logged once');
  } finally { r.cleanup(); }
});

test('slot field: the body fits the page; the newest live line always shows, older live lines go first, then narration from the end', async () => {
  const lineCount = lines => lines.reduce((n, l) => n + Math.max(1, Math.ceil(l.length / C.BODY_CHARS_PER_LINE)), 0);
  const r = rig();
  try {
    const story = n => `${'quiet '.repeat(12)}line ${n}.`;
    await r.store.call('campaign_start', { title: 'Story', beats: [beat('Begin', [1, 2, 3, 4, 5].map(story), { type: 'manual' })] });
    r.store.manual(BONE_KEY);
    const long = n => `${'quiet '.repeat(49)}${n}.`;
    for (const n of ['one', 'two', 'three']) assert.equal((await r.store.call('narrate', { text: long(n) })).ok, true);
    const lines = field(field(slotTable(r.store.slotLua()), 'beat'), 'lines').fields.map(f => luaString(f.value));
    assert.equal(lines.at(-1), long('three'), 'the newest live line is last and shown');
    assert.ok(!lines.includes(long('one')) && !lines.includes(long('two')), 'older live lines went first');
    assert.deepEqual(lines.slice(0, -1), [1, 2, 3, 4].map(story), 'then narration from the end');
    assert.ok(lineCount(lines) <= C.BODY_LINES_MAX, `${lineCount(lines)} estimated lines`);
  } finally { r.cleanup(); }
  assert.deepEqual(C.fitBody(['a.'], ['x'.repeat(300), 'y'.repeat(300), 'z'.repeat(300)]), { narration: ['a.'], live: ['y'.repeat(300), 'z'.repeat(300)] });
  const huge = 'w'.repeat(400);
  assert.deepEqual(C.fitBody([huge, huge], [huge]), { narration: [], live: [huge] }, 'a 12-line live line leaves no room for a 12-line narration line');
});

test('with telemetry off in the bridge, only manual beats are taken', async () => {
  const r = rig({ telemetryOn: false });
  try {
    const res = await r.store.call('campaign_start', { title: 'Story', beats: [beat('Here', ['A cold wind.'], { type: 'zone', mapID: 9101 })] });
    assert.equal(res.ok, false);
    assert.match(res.text, /can never fire, because game state telemetry is off/);
    assert.equal((await r.store.call('campaign_start', { title: 'Story', beats: [beat('Begin', ['Go.'], { type: 'manual' })] })).ok, true);
    assert.match((await r.store.call('beat_add', beat('Fallen', ['Get up.'], { type: 'death' }))).text, /telemetry is off/);
  } finally { r.cleanup(); }
});

test('a game state record counts as hearing from the game only for the character the context names', () => {
  const ctx = { text: BONE_CONTEXT, at: 1 };
  assert.equal(C.contextIsFor(ctx, BONE_KEY), true);
  assert.equal(C.contextIsFor(ctx, 'Ash-ClassicBetaPvP2'), false);
  assert.equal(C.contextIsFor(null, BONE_KEY), false);
  assert.equal(C.contextIsFor({ text: 'Game: x' }, BONE_KEY), false);
});

test('slot field: at most 1600 bytes; live lines go first, then narration from the end', () => {
  const long = 'quiet '.repeat(66).trim();
  const payload = { rev: 3, char: BONE_KEY, manual: false, beat: { id: 'b1', title: 'Begin', narration: [long, long, long, long, long], live: [long, long, long] } };
  const lua = C.luaDm(payload, NOW / 1000);
  assert.ok(Buffer.byteLength(lua) <= C.SLOT_LUA_MAX_BYTES, `${Buffer.byteLength(lua)} bytes`);
  const lines = field(field(slotTable(lua), 'beat'), 'lines').fields;
  assert.ok(lines.length >= 1 && lines.length < 8);
  assert.equal(luaString(lines[0].value), long, 'the first narration line stays');
});

test('tools: five campaign tools on the live session; every one is denied to in-game runs', async () => {
  assert.deepEqual(C.toolSchemas().map(t => t.name), ['campaign_start', 'campaign_end', 'beat_add', 'beat_trigger', 'narrate']);
  for (const tool of C.TOOL_NAMES) assert.ok(LP.GOAL_WRITE_TOOLS.includes(`mcp__claude-wow__${tool}`), tool);
  const out = [];
  const ch = createChannel({ stdout: { write: s => out.push(JSON.parse(s)) }, home: tmpDir('home'), listening: true });
  ch.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  await new Promise(r => setImmediate(r));
  const names = out[0].result.tools.map(t => t.name);
  for (const tool of C.TOOL_NAMES) assert.ok(names.includes(tool), tool);
  ch.stop();
});

test('Classic Era: a campaign starts and narrates against the Era data for an Era client, and the Forever data alone refuses the same text', async () => {
  assert.notEqual(ERA_CONTEXT, BONE_CONTEXT);
  const args = { title: 'A letter with no name', beats: [beat('The quiet road', ['The road into {map:9101,50,50} is quiet.'], { type: 'zone', mapID: 9101 }), beat('Begin', ['Go.'], { type: 'manual' })] };
  const era = rig({ ctx: ERA_CONTEXT, gameData: text => GD.openStore({ dataDir: DATA_WITH_ERA, clientBuild: GD.clientBuildOf(text) }) });
  try {
    const started = await era.store.call('campaign_start', args);
    assert.equal(started.ok, true, started.text);
    const doc = era.read();
    assert.equal(doc.campaign.beats[0].narration[0], 'The road into Fixture Pines is quiet.');
    assert.ok(doc.campaign.beats[0].refs.every(r => r.build === '1.15.9.70003'), 'refs come from the Era data');
    assert.equal((await era.store.call('beat_trigger', { id: 'b1' })).ok, true);
    const said = await era.store.call('narrate', { text: 'The wind turns cold on {map:9102,10,10}.' });
    assert.equal(said.ok, true, said.text);
    assert.match(said.text, /Fixture Hold/);
  } finally { era.cleanup(); }
  const foreverOnly = rig({ ctx: ERA_CONTEXT, gameData: text => GD.openStore({ dataDir: DATA, clientBuild: GD.clientBuildOf(text) }) });
  try {
    const refused = await foreverOnly.store.call('campaign_start', args);
    assert.equal(refused.ok, false);
    assert.match(refused.text, /No game data is synced for this build yet \(claude-wow data sync --flavor classic_era\)/);
    assert.equal(fs.existsSync(foreverOnly.file), false, 'nothing was saved');
  } finally { foreverOnly.cleanup(); }
});
