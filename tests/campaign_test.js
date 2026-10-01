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
const DEMO_FILE = path.join(__dirname, '..', 'docs', 'campaigns', 'horde-solo-demo.json');
const REAL_DATA = path.join(os.homedir(), '.claude-wow', 'data');
const DEMO_MAP_ROWS = [
  { id: 1421, name: 'Silverpine Forest', parentUiMapID: 1415, type: 3, system: 0 },
  { id: 1458, name: 'Undercity', parentUiMapID: 1415, type: 3, system: 0 },
];
const QUEST_ROWS = [{ id: 7101 }, { id: 7102 }, { id: 7103 }];

function tmpDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `cw-campaign-${name}-`));
}

function jsonl(rows) {
  return rows.map(r => JSON.stringify(r)).join('\n') + '\n';
}

function makeData() {
  const root = tmpDir('data');
  const dir = path.join(root, 'forever', '1.60.1.200');
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(FIXTURE)) fs.copyFileSync(path.join(FIXTURE, f), path.join(dir, f));
  fs.writeFileSync(path.join(root, 'forever', 'current'), '1.60.1.200\n');
  fs.appendFileSync(path.join(dir, 'uimaps.jsonl'), jsonl(DEMO_MAP_ROWS));
  fs.writeFileSync(path.join(dir, 'quests.jsonl'), jsonl(QUEST_ROWS));
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  manifest.entities.uimaps.rows += DEMO_MAP_ROWS.length;
  manifest.entities.quests = { file: 'quests.jsonl', table: 'QuestV2', rows: QUEST_ROWS.length };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  return root;
}

const DATA = makeData();
const openData = text => GD.openStore({ dataDir: DATA, clientBuild: GD.clientBuildOf(text) });

function rig(opts = {}) {
  const dir = tmpDir('store');
  let ctx = { text: opts.ctx === undefined ? BONE_CONTEXT : opts.ctx, at: NOW - 1000 };
  const logs = [];
  let changes = 0;
  let clock = NOW;
  const store = C.createCampaigns({
    dir,
    context: () => ctx,
    now: () => clock,
    gameData: opts.gameData || openData,
    log: m => logs.push(m),
    onChange: () => { changes += 1; },
  });
  const file = path.join(dir, BONE_KEY, C.CAMPAIGN_FILE);
  return {
    dir, store, logs, file,
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
    const r = C.checkStory(line, { names: ['Bone'], store: null, maxLength: 400, what: 'line' });
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
  assert.deepEqual(C.checkTrigger({ type: 'zone', mapID: 1421 }, data).refs, [{ kind: 'map', id: 1421, name: 'Silverpine Forest', trust: 'client-data', build: '1.60.1.200' }]);
  assert.match(C.checkTrigger({ type: 'zone', mapID: 1999 }, data).text, /not a map in the Forever client data/);
  assert.equal(C.checkTrigger({ type: 'quest_turnin', questID: 7101 }, data).ok, true);
  assert.match(C.checkTrigger({ type: 'quest_turnin', questID: 7999 }, data).text, /not a quest in the Forever client data/);
  assert.equal(C.checkTrigger({ type: 'level', level: 21 }, null).ok, true);
  assert.equal(C.checkTrigger({ type: 'level', level: 1 }, null).ok, false);
  assert.equal(C.checkTrigger({ type: 'level', level: 21.5 }, null).ok, false);
  assert.equal(C.checkTrigger({ type: 'death' }, null).ok, true);
  assert.equal(C.checkTrigger({ type: 'manual' }, null).ok, true);
  assert.equal(C.checkTrigger({ type: 'reach' }, null).ok, false, 'no trigger type the telemetry does not report');
  const era = GD.openStore({ dataDir: DATA, clientBuild: '1.15.9.70003' });
  assert.match(C.checkTrigger({ type: 'zone', mapID: 1421 }, era).text, /not in the client's build family/);
  assert.match(C.checkTrigger({ type: 'zone', mapID: 1421 }, null).text, /No game data is synced/);
});

test('campaign tools: start with beats, add, trigger, narrate and end; one campaign per character, written atomically', async () => {
  const r = rig();
  try {
    const start = await r.store.call('campaign_start', { title: 'A letter with no name', beats: [beat('A story begins', ['Someone left a letter in your pack.'], { type: 'manual' })] });
    assert.equal(start.ok, true, start.text);
    assert.match(start.text, /waits for \/dm next/);
    assert.equal(r.changes(), 1, 'a write republishes the slots');
    assert.match((await r.store.call('campaign_start', { title: 'Another one' })).text, /is running/);
    const added = await r.store.call('beat_add', beat('The quiet road', ['The road into {map:1421,50,50} is quiet.'], { type: 'zone', mapID: 1421 }));
    assert.equal(added.ok, true, added.text);
    const doc = r.read();
    assert.equal(doc.character, BONE_KEY);
    assert.deepEqual(doc.campaign.beats.map(b => b.id), ['b1', 'b2']);
    assert.equal(doc.campaign.beats[1].narration[0], 'The road into Silverpine Forest is quiet.');
    assert.deepEqual(doc.campaign.beats[1].refs.map(x => [x.kind, x.id]), [['map', 1421], ['map', 1421]]);
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
      beat('Into the dark', ['A cold wind.'], { type: 'zone', mapID: 1421 }),
      beat('Fallen', ['Get up.'], { type: 'death' }),
      beat('Stronger', ['You feel stronger now.'], { type: 'level', level: 21 }),
      beat('Home', ['Rest.'], { type: 'zone', mapID: 1458 }),
    ] });
    assert.equal(started.ok, true, started.text);
    assert.equal(r.store.onEvents(BONE_KEY, [{ type: 'death', data: {} }]), null, 'death is not armed yet');
    assert.equal(r.store.onEvents(BONE_KEY, [{ type: 'zone', data: { from: 1420, to: 1458 } }]), null, 'a later beat never fires out of order');
    assert.equal(r.store.onEvents('Other-Realm', [{ type: 'zone', data: { from: 1420, to: 1421 } }]), null, 'another character has no campaign');
    assert.equal(r.read().campaign.current, null);
    const fired = r.store.onEvents(BONE_KEY, [{ type: 'zone', data: { from: 1420, to: 1421 } }, { type: 'death', data: {} }]);
    assert.equal(fired.id, 'b1');
    assert.equal(r.read().campaign.current, 'b1', 'one beat per batch, even when the next one matches too');
    assert.equal(r.store.onEvents(BONE_KEY, [{ type: 'death', data: {} }]).id, 'b2');
    assert.equal(r.store.onEvents(BONE_KEY, [{ type: 'level_up', data: { from: 19, to: 20 } }]), null);
    assert.equal(r.store.onEvents(BONE_KEY, [{ type: 'level_up', data: { from: 20, to: 22 } }]).id, 'b3');
    assert.equal(r.store.onEvents(BONE_KEY, [{ type: 'zone', data: { from: 1421, to: 1458 } }]).id, 'b4');
    assert.equal(r.store.onEvents(BONE_KEY, [{ type: 'zone', data: { from: 1458, to: 1421 } }]), null, 'nothing is armed after the last beat');
    assert.deepEqual(r.read().campaign.fired.map(f => [f.id, f.by]), [['b1', 'zone'], ['b2', 'death'], ['b3', 'level'], ['b4', 'zone']]);
    assert.deepEqual(r.events().map(e => e.data.n), [1, 2, 3, 4], 'each beat is one importance-3 event for the live session');
    assert.ok(r.events().every(e => e.importance === 3 && e.type === 'beat'));
  } finally { r.cleanup(); }
});

test('a quest turn-in fires its beat when a ready quest leaves the log; a cut context or another character never does', async () => {
  const r = rig();
  try {
    await r.store.call('campaign_start', { title: 'Story', beats: [beat('Paid', ['Well done.'], { type: 'quest_turnin', questID: 7101 })] });
    const without = (ids) => BONE_CONTEXT.replace('7101*,7102', ids);
    assert.equal(r.store.onContext(BONE_CONTEXT, without('7102')).id, 'b1');
    await r.store.call('campaign_end', {});
    await r.store.call('campaign_start', { title: 'Story', beats: [beat('Paid', ['Well done.'], { type: 'quest_turnin', questID: 7102 })] });
    assert.equal(r.store.onContext(BONE_CONTEXT, without('7101*')), null, 'a quest that was not ready to turn in was dropped, not turned in');
    const ready = BONE_CONTEXT.replace('7101*,7102', '7101,7102*');
    const big = without('7101') + '\nPadding: ' + 'x'.repeat(G.ADDON_CONTEXT_MAX_BYTES);
    assert.equal(r.store.onContext(ready, big), null, 'a context the addon cut may have lost the rest of the log');
    const ashReady = ready.replace('Character: Bone', 'Character: Ash');
    assert.equal(r.store.onContext(ashReady, without('7101')), null, 'a quest another character had ready');
    assert.equal(r.store.onContext(ready, without('7101')).id, 'b1');
  } finally { r.cleanup(); }
  assert.deepEqual([...C.questLog('Quest log (id, * = ready to turn in): 1*,2,33*,x,4').ready], [1, 33]);
  assert.deepEqual(C.turnedIn('Quest log (id, * = ready to turn in): 1*,2', 'Character: x'), [1], 'a log that emptied turns in every ready quest');
});

test('/dm next fires only a beat that waits for it, and only for the character the record names', async () => {
  const r = rig();
  try {
    assert.match(r.store.manual(BONE_KEY), /nothing fired/);
    await r.store.call('campaign_start', { title: 'Story', beats: [beat('Begin', ['Go.'], { type: 'manual' }), beat('Later', ['Go on.'], { type: 'death' })] });
    assert.match(r.store.manual('Ash-ClassicBetaPvP2'), /nothing fired/);
    assert.match(r.store.manual('bad key!'), /names no character/);
    assert.match(r.store.manual(BONE_KEY), /beat b1 fired/);
    assert.match(r.store.manual(BONE_KEY), /nothing fired/, 'the next beat waits for a death');
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

test('slot field: at most 1600 bytes; live lines go first, then narration from the end', () => {
  const long = 'quiet '.repeat(66).trim();
  const payload = { rev: 3, char: BONE_KEY, manual: false, beat: { id: 'b1', title: 'Begin', narration: [long, long, long, long, long], live: [long, long, long] } };
  const lua = C.luaDm(payload, NOW / 1000);
  assert.ok(Buffer.byteLength(lua) <= C.SLOT_LUA_MAX_BYTES, `${Buffer.byteLength(lua)} bytes`);
  const lines = field(field(slotTable(lua), 'beat'), 'lines').fields;
  assert.ok(lines.length >= 1 && lines.length < 8);
  assert.equal(luaString(lines[0].value), long, 'the first narration line stays');
});

test('the demo campaign: every ID resolves, and it passes campaign_start against fixture rows copied from the synced data', async () => {
  const demo = JSON.parse(fs.readFileSync(DEMO_FILE, 'utf8'));
  const ids = demo.beats.flatMap(b => [b.trigger.mapID, ...[...JSON.stringify(b).matchAll(/\{map:(\d+),/g)].map(m => Number(m[1]))]).filter(Boolean);
  assert.deepEqual([...new Set(ids)].sort(), [1421, 1458]);
  const r = rig();
  try {
    const res = await r.store.call('campaign_start', demo);
    assert.equal(res.ok, true, res.text);
    assert.equal(r.read().campaign.beats[3].narration[0], 'The road ends in Undercity. Find a warm fire and rest.');
  } finally { r.cleanup(); }
});

test('the demo campaign IDs match the real synced Forever data on this machine', { skip: !fs.existsSync(path.join(REAL_DATA, 'forever', 'current')) && 'no synced data here (CI)' }, () => {
  const real = GD.openStore({ dataDir: REAL_DATA, clientBuild: '1.60.1.70124' });
  for (const row of DEMO_MAP_ROWS) assert.deepEqual(real.byId('uimaps', row.id), row, `uimap ${row.id}`);
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
