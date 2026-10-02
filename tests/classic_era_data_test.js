'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const D = require('../bridge/datasync');
const GD = require('../bridge/gamedata');
const GR = require('../bridge/gamerefs');
const DM = require('../bridge/datamcp');
const OB = require('../bridge/observed');
const OT = require('../bridge/observedtools');
const G = require('../bridge/goals');

const ERA_FIXTURES = path.join(__dirname, 'fixtures', 'wago-era');
const FOREVER_FIXTURES = path.join(__dirname, 'fixtures', 'wago');
const ERA_BUILD = '1.15.9.300';
const FOREVER_BUILD = '1.60.1.200';
const ERA_CLIENT = '1.15.9.70003';
const FOREVER_CLIENT = '1.60.1.70124';
const ERA_CONTEXT = [
  `Game: World of Warcraft Classic (client ${ERA_CLIENT}, interface 11509)`,
  'Character: Bone on Fixture Realm, level 20 Orc Rogue (Horde)',
  'Professions: Skinning 187/225',
].join('\n');
const NAMES = ['Bone', 'Skinning'];
const ERA_HIDE = 511;
const ERA_CAP = 512;
const FOREVER_BLADE = 501;
const FOREVER_HELM = 510;

function scratch(name) {
  const dir = path.join(os.tmpdir(), `claude-wow-era-${name}-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function fakeWago(fixtures) {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    const u = new URL(url);
    if (u.pathname === '/api/builds') return new Response(fs.readFileSync(path.join(fixtures, 'builds.json'), 'utf8'), { status: 200, headers: { 'content-type': 'application/json' } });
    const table = /^\/db2\/(\w+)\/csv$/.exec(u.pathname)[1];
    const headers = { 'content-type': 'text/csv; charset=UTF-8', 'content-disposition': `attachment; filename="${table}.${u.searchParams.get('build')}.csv"` };
    return new Response(fs.readFileSync(path.join(fixtures, `${table}.csv`), 'utf8'), { status: 200, headers });
  };
  return { fetchImpl, calls };
}

async function syncedData(name, { era = true, forever = true } = {}) {
  const dataDir = path.join(scratch(name), 'data');
  if (era) await D.sync({ dataDir, flavor: 'classic_era', fetch: fakeWago(ERA_FIXTURES).fetchImpl });
  if (forever) await D.sync({ dataDir, build: FOREVER_BUILD, fetch: fakeWago(FOREVER_FIXTURES).fetchImpl });
  return dataDir;
}

test('the client build picks the flavor: 1.15.* is classic_era, 1.60.* is forever, anything else has none', () => {
  assert.equal(D.flavorForBuild(ERA_CLIENT), 'classic_era');
  assert.equal(D.flavorForBuild('1.15.10.1'), 'classic_era');
  assert.equal(D.flavorForBuild(FOREVER_CLIENT), 'forever');
  for (const other of ['1.61.0.1', '1.14.4.1', '2.5.6.69795', '12.0.1.66220', '1.15.9', '', undefined, '../1.15.9.1']) assert.equal(D.flavorForBuild(other), null, String(other));
  assert.deepEqual(D.FLAVORS.classic_era, { product: 'wow_classic_era', family: '1.15.9', clientLine: '1.15', label: 'Classic Era' });
  assert.equal(GD.clientBuildOf(ERA_CONTEXT), ERA_CLIENT);
});

test('claude-wow data sync --flavor classic_era fetches the newest 1.15.9 wow_classic_era build and parses every Era-shaped table', async () => {
  const home = scratch('main');
  const wago = fakeWago(ERA_FIXTURES);
  const out = [];
  const code = await D.main(['sync', '--flavor', 'classic_era'], { env: { CLAUDE_WOW_HOME: home }, fetch: wago.fetchImpl, out: s => out.push(s), err: s => out.push(s) });
  assert.equal(code, 0, out.join(''));
  assert.match(out.join(''), /current build 1\.15\.9\.300 \(classic_era\)/);
  assert.ok(wago.calls.slice(1).every(u => u.endsWith(`build=${ERA_BUILD}`)), 'not the PTR product, not 1.15.8, not a 1.60 build listed under the Era product');
  const root = path.join(home, 'data', 'classic_era');
  const current = D.readCurrent(root);
  assert.equal(current.build, ERA_BUILD);
  assert.equal(fs.existsSync(path.join(home, 'data', 'forever')), false, 'the Forever folder is left alone');
  const m = current.manifest;
  assert.deepEqual([m.flavor, m.product, m.buildFamily, m.dropped], ['classic_era', 'wow_classic_era', '1.15.9', 0]);
  assert.deepEqual(Object.fromEntries(Object.entries(m.entities).map(([k, v]) => [k, v.rows])), {
    uimaps: 2, uimapassignments: 2, zones: 1, flightpaths: 1, quests: 1, items: 4, skilllines: 3, skilllineabilities: 6, spellreagents: 1,
  });
  const items = fs.readFileSync(path.join(current.dir, 'items.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(items[1], { id: ERA_CAP, name: 'Era Fixture Cap', quality: 2, itemLevel: 18, requiredLevel: 13, inventoryType: 1, sellPrice: 210, buyPrice: 1050, startQuestID: 0 });
  const flight = JSON.parse(fs.readFileSync(path.join(current.dir, 'flightpaths.jsonl'), 'utf8').trim());
  assert.deepEqual(flight.map, { uiMapID: 9102, x: 55, y: 50 });
});

test('a build of the other flavor is refused before any fetch or folder', async () => {
  const dataDir = path.join(scratch('cross'), 'data');
  const wago = fakeWago(ERA_FIXTURES);
  await assert.rejects(D.sync({ dataDir, flavor: 'forever', build: ERA_BUILD, fetch: wago.fetchImpl }), /1\.15\.9\.300 is a Classic Era build, not Forever; sync it with --flavor classic_era/);
  await assert.rejects(D.sync({ dataDir, flavor: 'classic_era', build: FOREVER_BUILD, fetch: wago.fetchImpl }), /is a Forever build, not Classic Era; sync it with --flavor forever/);
  assert.equal(wago.calls.length, 0);
  assert.equal(fs.existsSync(dataDir), false);
});

test('the store follows the client build: an Era client reads Classic Era data, a Forever client reads Forever data', async () => {
  const dataDir = await syncedData('both');
  const era = GD.openStore({ dataDir, clientBuild: ERA_CLIENT });
  assert.deepEqual([era.flavor, era.flavorLabel, era.build, era.buildCheck, era.rowTrust], ['classic_era', 'Classic Era', ERA_BUILD, 'family', 'client-data']);
  assert.equal(era.byId('items', ERA_HIDE).name, 'Era Fixture Hide');
  assert.equal(era.byId('items', FOREVER_BLADE), null);
  const forever = GD.openStore({ dataDir, clientBuild: FOREVER_CLIENT });
  assert.deepEqual([forever.flavor, forever.build, forever.buildCheck], ['forever', FOREVER_BUILD, 'family']);
  assert.equal(forever.byId('items', FOREVER_BLADE).name, 'Fixture Blade');
  assert.equal(forever.byId('items', ERA_HIDE), null);
  assert.equal(GR.openFor(dataDir, ERA_CONTEXT).flavor, 'classic_era');
  const unknown = GD.openStore({ dataDir });
  assert.deepEqual([unknown.flavor, unknown.build], [null, null], 'no client build: no flavor is guessed');
  assert.equal(GR.createExpander(unknown).expand(`{item:${ERA_HIDE}}`).errors[0].reason, 'buildUnknown');
  const retail = GD.openStore({ dataDir, clientBuild: '12.0.1.66220' });
  assert.deepEqual([retail.flavor, retail.build], [null, null]);
  assert.match(GR.errorsText(GR.createExpander(retail).expand(`{item:${ERA_HIDE}}`).errors, retail), /Client build 12\.0\.1\.66220 belongs to no game the bridge has data for/);
});

test('never across flavors: an Era client with only Forever data synced gets no data, and every token, phrase and gather spell says so', async () => {
  const dataDir = await syncedData('forever-only', { era: false });
  const store = GD.openStore({ dataDir, clientBuild: ERA_CLIENT });
  assert.deepEqual([store.flavor, store.build, store.buildCheck], ['classic_era', null, 'no-data']);
  assert.equal(store.byId('items', FOREVER_BLADE), null);
  const r = GR.createExpander(store).expand(`Buy 2 {item:${FOREVER_BLADE}}`);
  assert.deepEqual(r.errors.map(e => e.reason), ['noData']);
  assert.match(GR.errorsText(r.errors, store), /No game data is synced for this build yet \(claude-wow data sync --flavor classic_era\)/);
  const order = G.validateOrderText(`Buy 2 {item:${FOREVER_BLADE}}`, NAMES, store);
  assert.equal(order.ok, false);
  assert.doesNotMatch(order.text, /Fixture Blade/);
  assert.equal(OB.gatherSpells(store).count, 0);
  assert.equal(DM.launchConfig({ dataDir, clientBuild: ERA_CLIENT }), null, 'no wowdata server rather than Forever answers');
  const phrase = GR.checkText('go to fixture vale', { store, names: [], plainWords: new Set(['go', 'to', 'fixture', 'vale']), charRe: /[ -~]/, maxLength: 200 });
  assert.equal(phrase.phrasesChecked, false, 'the Forever phrase index is not used for an Era client');
  assert.match(phrase.phrasesNote, /--flavor classic_era/);

  const eraOnly = await syncedData('era-only', { forever: false });
  const foreverClient = GD.openStore({ dataDir: eraOnly, clientBuild: FOREVER_CLIENT });
  assert.deepEqual([foreverClient.flavor, foreverClient.build], ['forever', null]);
  assert.equal(GR.createExpander(foreverClient).expand(`{item:${ERA_HIDE}}`).errors[0].reason, 'noData');
});

test('a data folder whose manifest names another flavor is not read', async () => {
  const dataDir = await syncedData('swapped', { era: false });
  fs.cpSync(path.join(dataDir, 'forever'), path.join(dataDir, 'classic_era'), { recursive: true });
  assert.equal(D.readCurrent(path.join(dataDir, 'classic_era')), null);
  assert.equal(GD.openStore({ dataDir, clientBuild: ERA_CLIENT }).build, null);
  assert.equal(D.readCurrent(path.join(dataDir, 'forever')).build, FOREVER_BUILD);
});

test('Era gather spells: the ranks of each gathering skill from Era SkillLineAbility, never an auto-learned or crafted spell', async () => {
  const dataDir = await syncedData('gather', { forever: false });
  const g = OB.gatherSpells(GD.openStore({ dataDir, clientBuild: ERA_CLIENT }));
  assert.deepEqual(g.spells, { 92366: 92366, 92368: 92366, 98613: 98613, 98617: 98613 });
  assert.deepEqual([g.count, g.cut, g.why], [4, 0, '']);
});

test('Era tokens, phrases, gearset goals and route_draw use the Classic Era data', async () => {
  const dataDir = await syncedData('consumers');
  const store = GD.openStore({ dataDir, clientBuild: ERA_CLIENT });
  const order = G.validateOrderText(`Buy 2 {item:${ERA_HIDE}}`, NAMES, store);
  assert.equal(order.ok, true, order.text);
  assert.equal(order.text, 'Buy 2 Era Fixture Hide');
  assert.deepEqual(order.refs.map(r => [r.id, r.trust, r.build]), [[ERA_HIDE, 'client-data', ERA_BUILD]]);
  const forever = G.validateOrderText(`Buy 2 {item:${FOREVER_BLADE}}`, NAMES, store);
  assert.match(forever.text, /\{item:501\}: that item ID is not in the Classic Era client data for build 1\.15\.9\.300/);
  const phrase = GR.checkText('go to era fixture vale', { store, names: [], plainWords: new Set(['go', 'to', 'era', 'fixture', 'vale']), charRe: /[ -~]/, maxLength: 200 });
  assert.equal(phrase.ok, false);
  assert.deepEqual(phrase.phrases.map(p => [p.run, p.source]), [['era fixture vale', 'map']]);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-era-goals-'));
  try {
    const goals = G.createGoals({
      dir,
      context: () => ({ text: ERA_CONTEXT, at: 1000 }),
      now: () => 2000,
      equipped: () => null,
      post: async () => ({ ok: true, status: 200 }),
      streamOptions: () => ({ url: 'http://127.0.0.1:9' }),
      gameData: text => GR.openFor(dataDir, text),
    });
    const set = await goals.call('goal_set', { type: 'gearset', slots: { 1: ERA_CAP } });
    assert.equal(set.ok, true, set.text);
    const refused = await goals.call('goal_set', { type: 'gearset', slots: { 1: FOREVER_HELM } });
    assert.equal(refused.ok, false);
    assert.match(refused.text, /slot 1: \{item:510\} is not in the Classic Era client data for build 1\.15\.9\.300/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }

  const applied = [];
  const tools = OT.createObservedTools({
    observed: OB.createObserved({ dir: scratch('observed') }),
    context: () => ({ text: ERA_CONTEXT, at: Date.now() }),
    gameData: text => GR.openFor(dataDir, text),
    applyMap: cmds => { applied.push(...cmds); return { changed: true, notes: [] }; },
  });
  const drawn = await tools.call('route_draw', { points: ['{map:9102,40,50}'] });
  assert.equal(drawn.ok, true, drawn.text);
  assert.ok(applied.length > 0);
  const before = applied.length;
  const cross = await tools.call('route_draw', { points: ['{map:9102,40,50}', '{map:9002,40,50}'] });
  assert.equal(cross.ok, false);
  assert.match(cross.text, /\{map:9002,40,50\}: that map ID is not in the Classic Era client data/);
  assert.equal(applied.length, before, 'nothing is drawn');
});

test('a taught spell whose name starts with "the" is not indexed as a game phrase; other taught spells are', async () => {
  const dataDir = await syncedData('taught', { forever: false });
  const store = GD.openStore({ dataDir, clientBuild: ERA_CLIENT });
  const words = new Set(['it', 'was', 'the', 'era', 'fixture', 'go', 'blast']);
  const check = text => GR.checkText(text, { store, names: [], plainWords: words, charRe: /[ -~]/, maxLength: 200 });
  assert.equal(check('it was the era fixture').ok, true, '"Schematic: The Era Fixture" adds no phrase');
  const blast = check('go era blast');
  assert.equal(blast.ok, false);
  assert.deepEqual(blast.phrases.map(p => [p.run, p.source]), [['era blast', 'spell taught by an item']]);
});

test('market_price on Classic Era gives vendor prices only and says auction prices are not collected there; Forever keeps both', async () => {
  const dataDir = await syncedData('prices');
  const dir = scratch('price-lines');
  const key = G.characterOf(ERA_CONTEXT).key;
  const at = 1790000000;
  const lines = [
    OB.lineFor('ah', { key: 'a1', at, itemID: ERA_HIDE, price: 90, quantity: 4 }),
    OB.lineFor('ah', { key: 'a2', at, itemID: FOREVER_BLADE, price: 1500, quantity: 1 }),
    OB.lineFor('vendor', { key: 'v1', at, npcID: 3100, mapID: 9102, items: [{ itemID: ERA_HIDE, price: 60, stack: 1 }] }),
  ];
  fs.mkdirSync(path.join(dir, key), { recursive: true });
  fs.writeFileSync(path.join(dir, key, 'observed.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  const price = async (context, itemID) => {
    const tools = OT.createObservedTools({ observed: OB.createObserved({ dir }), context: () => ({ text: context, at: Date.now() }), gameData: text => GR.openFor(dataDir, text) });
    const r = await tools.call('market_price', { itemID });
    assert.equal(r.ok, true, r.text);
    return JSON.parse(r.text);
  };
  const era = await price(ERA_CONTEXT, ERA_HIDE);
  assert.equal(era.auctionHouse, null, 'an auction line never backs an Era price');
  assert.deepEqual(era.vendors.map(v => [v.price, v.stack]), [[60, 1]]);
  assert.ok(era.notes.some(n => /Auction house prices are not collected on this client \(Classic Era\) yet/.test(n)), era.notes.join(' | '));
  const forever = await price(ERA_CONTEXT.replace(`World of Warcraft Classic (client ${ERA_CLIENT}, interface 11509)`, `World of Warcraft: Forever (client ${FOREVER_CLIENT}, interface 16001)`), FOREVER_BLADE);
  assert.equal(forever.auctionHouse.latest.price, 1500);
  assert.ok(!forever.notes.some(n => /not collected/.test(n)));
});

test('the wowdata server for an Era client serves Classic Era rows labeled with their flavor', async () => {
  const dataDir = await syncedData('mcp');
  const launch = DM.launchConfig({ dataDir, clientBuild: ERA_CLIENT });
  assert.deepEqual([launch.flavor, launch.build, launch.buildCheck], ['classic_era', ERA_BUILD, 'family']);
  assert.deepEqual(JSON.parse(launch.config).mcpServers.wowdata.args.slice(-4), ['--data', dataDir, '--client-build', ERA_CLIENT]);
  const store = GD.openStore({ dataDir, clientBuild: ERA_CLIENT });
  const item = DM.callTool(store, 'wow_item', { id: ERA_HIDE }).structuredContent;
  assert.deepEqual([item.found, item.flavor, item.build, item.trust, item.results[0].name], [true, 'classic_era', ERA_BUILD, 'client-data', 'Era Fixture Hide']);
  const sources = DM.callTool(store, 'wow_sources', {}).structuredContent.results[0];
  assert.deepEqual([sources.flavor, sources.product], ['classic_era', 'wow_classic_era']);
  assert.match(DM.INSTRUCTIONS, /Forever \(1\.60\.\*\) or Classic Era \(1\.15\.\*\), never the other one/);
});
