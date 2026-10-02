'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const OB = require('../bridge/observed');
const OT = require('../bridge/observedtools');
const TL = require('../bridge/telemetry');
const GR = require('../bridge/gamerefs');
const P = require('../bridge/protocol');
const MH = require('../bridge/maphold');

const WOWDATA = path.join(__dirname, 'fixtures', 'wowdata');
const BONE_CONTEXT = [
  'Game: World of Warcraft: Forever (client 1.60.1.70124, interface 16001)',
  'Character: Bone on Classic Beta PvP 2, level 20 Orc Rogue (Horde)',
  'Professions: Skinning 187/225',
].join('\n');
const BONE = 'Bone-ClassicBetaPvP2';
const SESSION = 'abc123';
const AT = 1790000000;
const ITEM = 501;
const OTHER_ITEM = 505;

function tmpDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `cw-observed-${name}-`));
}

function gsText(sections) {
  return ['gs1', ...Object.entries(sections).map(([name, data]) => `${name}:${String(data.length).padStart(8, '0')}:${data}`)].join('\n');
}

function gsJob(seq, sections, character = BONE) {
  return { kind: 'gs', session: SESSION, id: seq, name: character, text: gsText(sections) };
}

function lootEntry(type, id, spell, at, items, place = '9002@412@478') {
  return `${type}${id}_${spell}@${at}@${place}@${Object.entries(items).map(([k, v]) => `${k}=${v}`).join('/')}`;
}

function lootLine(source, items, { at = AT, map = { id: 9002, x: 41.2, y: 47.8 }, trust = OB.TRUST, key } = {}) {
  return JSON.stringify({ v: 1, kind: 'loot', trust, n: 1, at: at * 1000, key: key || `loot|${source.type}${source.id}@${at}@${Math.random()}`, source, map, items });
}

function writeLines(dir, lines) {
  fs.mkdirSync(path.join(dir, BONE), { recursive: true });
  fs.writeFileSync(path.join(dir, BONE, OB.OBSERVED_FILE), lines.join('\n') + '\n');
}

function tools(dir, { context = BONE_CONTEXT, applied = [], applyMap } = {}) {
  const observed = OB.createObserved({ dir });
  return OT.createObservedTools({
    observed,
    context: () => ({ text: context, at: AT * 1000 }),
    gameData: text => GR.openFor(WOWDATA, text),
    applyMap: applyMap || (cmds => { applied.push(...cmds); return { changed: true, notes: [] }; }),
  });
}

test('section parsers: vendor, auction quotes and loot samples on the gs wire set, refusing what does not parse or is over the caps', () => {
  assert.deepEqual(OB.parseVendor(''), { visit: null });
  const v = OB.parseVendor(`3100@${AT}@9002;501=600/1,505=25/5`);
  assert.deepEqual(v.visit, { key: `3100@${AT}`, npcID: 3100, at: AT, mapID: 9002, items: [{ itemID: 501, price: 600, stack: 1 }, { itemID: 505, price: 25, stack: 5 }] });
  assert.equal(OB.parseVendor(`3100@${AT}@;`).visit.mapID, null, 'no map in an instance');
  for (const bad of [`3100@${AT}@9002`, `0@${AT}@9002;`, `3100@${AT}@9002;501=0/1`, `3100@${AT}@x;`, `3100@${AT}@9002;${Array.from({ length: OB.VENDOR_ITEMS_MAX + 1 }, (_, i) => `${i + 1}=5/1`).join(',')}`]) {
    assert.equal(OB.parseVendor(bad), null, bad);
  }
  assert.deepEqual(OB.parseAh(`501=1200/3@${AT}`).quotes.map(q => [q.itemID, q.price, q.quantity, q.at]), [[501, 1200, 3, AT]]);
  assert.equal(OB.parseAh(Array.from({ length: OB.AH_QUOTES_MAX + 1 }, () => `501=1/1@${AT}`).join(',')), null);
  assert.equal(OB.parseAh(`501=1200@${AT}`), null);
  assert.deepEqual(OB.parseAh(`501=34/4@${AT}/2/3`).quotes.map(q => [q.itemID, q.price, q.quantity, q.at, q.rows, q.stack]), [[501, 34, 4, AT, 2, 3]], 'an Era quote carries its auction rows and the winning stack size');
  assert.equal(OB.parseAh(`501=34/4@${AT}/0/3`), null, 'zero rows is not a quote');
  assert.equal(OB.parseAh(`501=34/4@${AT}/2/0`), null, 'a zero stack is not a quote');
  assert.equal(OB.parseAh(`501=34/4@${AT}/2`), null, 'rows without a stack size is not a quote');
  const eraLine = OB.lineFor('ah', OB.parseAh(`501=34/4@${AT}/2/3`).quotes[0]);
  assert.deepEqual([eraLine.rows, eraLine.stack], [2, 3]);
  assert.equal('rows' in OB.lineFor('ah', OB.parseAh(`501=34/4@${AT}`).quotes[0]), false, 'a Forever quote has no rows field');
  assert.equal(OB.validLine({ ...eraLine, rows: -1 }), false);
  assert.equal(OB.validLine({ ...eraLine, stack: undefined }), false);
  assert.equal(OB.validLine(eraLine), true);
  const l = OB.parseLoot([lootEntry('n', 3100, 0, AT, { 501: 2 }), lootEntry('o', 1731, 2575, AT, {}, '@@'), lootEntry('f', 9002, 0, AT, { 505: 1 }, '9002@@')].join(';'));
  assert.deepEqual(l.samples.map(s => [s.source, s.map, s.items]), [
    [{ type: 'npc', id: 3100, spell: 0 }, { id: 9002, x: 41.2, y: 47.8 }, { 501: 2 }],
    [{ type: 'object', id: 1731, spell: 2575 }, null, {}],
    [{ type: 'fishing', id: 9002, spell: 0 }, { id: 9002, x: null, y: null }, { 505: 1 }],
  ]);
  for (const bad of [`x3100_0@${AT}@@@@`, `n3100@${AT}@@@@`, `n3100_0@${AT}@9002@1001@5@`, `n3100_0@${AT}@@@@501=0`, `n3100_0@${AT}@@@@${Array.from({ length: OB.LOOT_ITEMS_MAX + 1 }, (_, i) => `${i + 1}=1`).join('/')}`]) {
    assert.equal(OB.parseLoot(bad), null, bad);
  }
  assert.equal(OB.parseLoot(Array.from({ length: OB.LOOT_ENTRIES_MAX + 1 }, () => lootEntry('n', 1, 0, AT, {})).join(';')), null);
  const record = TL.parseRecord(gsText({ vendor: `3100@${AT}@9002;501=600/1`, ah: `501=1200/3@${AT}`, loot: lootEntry('n', 3100, 0, AT, { 501: 1 }) }));
  assert.deepEqual(record.errors, []);
  assert.deepEqual(Object.keys(record.sections), ['vendor', 'ah', 'loot'], 'the gs record carries them as sections');
});

test('the bridge appends each new observation once to observed.jsonl per character, with trust observed, n and a timestamp', () => {
  const dir = tmpDir('ingest');
  try {
    const observed = OB.createObserved({ dir });
    const t = TL.createTelemetry({ dir, observed, now: () => AT * 1000 });
    const first = lootEntry('n', 3100, 0, AT, { 501: 1 });
    const second = lootEntry('n', 3100, 0, AT + 5, {});
    assert.equal(t.submit(gsJob(100, { loot: first, ah: `501=1200/3@${AT}` })).observed, 2);
    assert.equal(t.submit(gsJob(101, { loot: [first, second].join(';') })).observed, 1, 'a ring that grew adds only the new sample');
    assert.equal(t.submit(gsJob(102, { loot: second })).observed, 0, 'a ring that dropped its oldest adds nothing');
    const lines = fs.readFileSync(observed.file(BONE), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.equal(lines.length, 3);
    for (const line of lines) {
      assert.equal(line.trust, 'observed');
      assert.equal(line.n, 1);
      assert.ok(Number.isSafeInteger(line.at) && line.at >= AT * 1000);
    }
    assert.deepEqual(lines.find(l => l.kind === 'ah'), { v: 1, kind: 'ah', trust: 'observed', n: 1, at: AT * 1000, key: `ah|501=1200/3@${AT}`, itemID: 501, price: 1200, quantity: 3 });
    const restarted = TL.createTelemetry({ dir, observed: OB.createObserved({ dir }), now: () => AT * 1000 });
    assert.equal(restarted.submit({ ...gsJob(5, { loot: [first, second].join(';') }), session: 'fresh' }).observed, 0, 'after a bridge restart and a new addon session the same samples are not written twice');
    assert.equal(fs.readFileSync(observed.file(BONE), 'utf8').trim().split('\n').length, 3);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the slot field offers the observed sections only when the bridge keeps them', () => {
  const dir = tmpDir('slot');
  try {
    const plain = TL.createTelemetry({ dir });
    const keeps = TL.createTelemetry({ dir, observed: OB.createObserved({ dir }) });
    assert.doesNotMatch(plain.luaGs(), /obs = 1/);
    assert.match(keeps.luaGs(), /refused = \{ {2}\}, obs = 1, gather = \{ {2}\} \},$/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('drop tracker: one rate per source with its n, sources never added together, and no rate below the minimum n', () => {
  const npc = { type: 'npc', id: 3100, spell: 0 };
  const skin = { type: 'npc', id: 3100, spell: 8613 };
  const herb = { type: 'object', id: 1617, spell: 0 };
  const lines = [];
  for (let i = 0; i < 20; i++) lines.push(JSON.parse(lootLine(npc, i < 5 ? { [ITEM]: 1 } : {}, { at: AT + i })));
  for (let i = 0; i < 10; i++) lines.push(JSON.parse(lootLine(skin, { [ITEM]: 2 }, { at: AT + 100 + i, map: { id: 9003, x: 10, y: 20 } })));
  for (let i = 0; i < 4; i++) lines.push(JSON.parse(lootLine(herb, { [ITEM]: 1 }, { at: AT + 200 + i })));
  const { shown, hidden } = OB.dropRates(lines, ITEM, 10);
  assert.deepEqual(shown.map(r => [r.source, r.n, r.k, r.rate, r.perLoot]), [
    [skin, 10, 10, 1, 2],
    [npc, 20, 5, 0.25, 0.25],
  ], 'the kill loot and the skinning loot of one NPC are two sources');
  assert.deepEqual(hidden, [{ source: herb, n: 4 }], 'four samples show no rate');
  assert.deepEqual(shown[0].spots, [{ mapID: 9003, n: 10, x: 10, y: 20 }]);
  assert.equal(OB.dropRates(lines, ITEM, 21).shown.length, 0);
});

test('drop tracker: a well-sampled source that never dropped the item shows rate 0 with its asOf; the spot is a real sample, the medoid', () => {
  const npc = { type: 'npc', id: 3100, spell: 0 };
  const dry = { type: 'npc', id: 3200, spell: 0 };
  const lines = [];
  const spots = [[10, 10], [11, 11], [12, 12], [90, 90]];
  for (let i = 0; i < 12; i++) lines.push(JSON.parse(lootLine(npc, i < 4 ? { [ITEM]: 1 } : {}, { at: AT + i, map: { id: 9002, x: (spots[i] || [5, 5])[0], y: (spots[i] || [5, 5])[1] } })));
  for (let i = 0; i < 10; i++) lines.push(JSON.parse(lootLine(dry, {}, { at: AT + 100 + i })));
  const { shown } = OB.dropRates(lines, ITEM, 10);
  const zero = shown.find(r => r.source.id === 3200);
  assert.deepEqual([zero.n, zero.k, zero.rate, zero.asOf], [10, 0, 0, (AT + 109) * 1000]);
  assert.deepEqual(shown.find(r => r.source.id === 3100).spots, [{ mapID: 9002, n: 4, x: 11, y: 11 }], 'a point the player stood on, not an average no one stood on');
  assert.equal(shown.find(r => r.source.id === 3100).asOf, (AT + 11) * 1000, 'asOf follows the newest loot window, with or without the item');
});

test('gather spells: the gathering abilities of the synced Herbalism, Mining and Skinning lines, crafts and tracking left out, rank chains folded to one source spell', () => {
  const rows = {
    skilllines: [{ id: 182, name: 'Herbalism', parentSkillLineID: 0 }, { id: 2944, name: 'Herbalism', parentSkillLineID: 182 }, { id: 186, name: 'Mining', parentSkillLineID: 0 }, { id: 393, name: 'Skinning', parentSkillLineID: 0 }, { id: 39, name: 'Subtlety', parentSkillLineID: 0 }],
    skilllineabilities: [
      { skillLine: 182, spell: 2366, trivialHigh: 0, acquireMethod: 0, supercedesSpell: 0 },
      { skillLine: 182, spell: 2368, trivialHigh: 0, acquireMethod: 0, supercedesSpell: 2366 },
      { skillLine: 2944, spell: 900001, trivialHigh: 0, acquireMethod: 0, supercedesSpell: 0 },
      { skillLine: 182, spell: 2383, trivialHigh: 0, acquireMethod: 1, supercedesSpell: 0 },
      { skillLine: 182, spell: 8387, trivialHigh: 0, acquireMethod: 0, supercedesSpell: 2383 },
      { skillLine: 186, spell: 2657, trivialHigh: 70, acquireMethod: 1, supercedesSpell: 0 },
      { skillLine: 186, spell: 2575, trivialHigh: 0, acquireMethod: 0, supercedesSpell: 0 },
      { skillLine: 186, spell: 3304, trivialHigh: 0, acquireMethod: 0, supercedesSpell: 0 },
      { skillLine: 393, spell: 8613, trivialHigh: 0, acquireMethod: 0, supercedesSpell: 0 },
      { skillLine: 393, spell: 8617, trivialHigh: 0, acquireMethod: 0, supercedesSpell: 8613 },
      { skillLine: 393, spell: 8618, trivialHigh: 0, acquireMethod: 0, supercedesSpell: 8617 },
      { skillLine: 393, spell: 10768, trivialHigh: 0, acquireMethod: 0, supercedesSpell: 0 },
      { skillLine: 39, spell: 921, trivialHigh: 0, acquireMethod: 0, supercedesSpell: 0 },
    ],
    spellreagents: [{ spellID: 2657, reagents: [] }, { spellID: 3304, reagents: [] }],
  };
  let opened = 0;
  const store = (trust, tag, tables = rows) => ({ build: '1.60.1.1', buildCheck: 'family', dir: tag, manifest: {}, rowTrust: trust, has: e => { opened += 1; return !!tables[e]; }, rows: e => tables[e] || [] });
  const r = OB.gatherSpells(store('client-data', 'a'));
  assert.deepEqual(r.spells, { 2366: 2366, 2368: 2366, 2575: 2575, 8613: 8613, 8617: 8613, 8618: 8613, 10768: 8613, 900001: 2366 }, 'no smelting (reagents, trivial range), no tracking learned with the line and its later ranks, no rogue ability; one root per gathering line, even for a later rank whose row names no earlier one');
  assert.deepEqual([r.count, r.cut, r.why], [8, 0, '']);
  const before = opened;
  OB.gatherSpells(store('client-data', 'a'));
  assert.equal(opened, before, 'a cached data identity opens no table');
  assert.match(OB.gatherSpells(store('unverified-build-mismatch', 'b')).why, /not checked against the client build/);
  assert.match(OB.gatherSpells(store('client-data', 'c', { ...rows, spellreagents: undefined })).why, /no usable spellreagents table/, 'without the reagents table crafts cannot be told apart');
  const missingOpened = opened;
  OB.gatherSpells(store('client-data', 'c', { ...rows, spellreagents: undefined }));
  assert.equal(opened, missingOpened, 'the missing table is not looked for again for the same data');
  assert.match(OB.gatherSpells(null).why, /no synced game data/);
  const many = { ...rows, skilllineabilities: Array.from({ length: OB.GATHER_SPELLS_MAX + 5 }, (_, i) => ({ skillLine: 393, spell: 100000 + i, trivialHigh: 0, acquireMethod: 0, supercedesSpell: 0 })) };
  const capped = OB.gatherSpells(store('client-data', 'd', many));
  assert.deepEqual([capped.count, capped.cut], [OB.GATHER_SPELLS_MAX, 5]);
  const dir = tmpDir('gather');
  try {
    const lines = [];
    const t = TL.createTelemetry({ dir, observed: OB.createObserved({ dir }), log: l => lines.push(l), gatherSpells: () => ({ spells: { 8617: 8613, 2366: 2366 }, cut: 0, why: '' }) });
    assert.match(t.luaGs(), /obs = 1, gather = \{ \[2366\] = 2366, \[8617\] = 8613 \} \},$/);
    const empty = TL.createTelemetry({ dir, observed: OB.createObserved({ dir }), log: l => lines.push(l), gatherSpells: () => ({ spells: {}, why: 'no synced game data' }) });
    empty.luaGs();
    empty.luaGs();
    assert.equal(lines.filter(l => /no loot capture: no synced game data/.test(l)).length, 1, 'said once');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the dedupe memory is primed from the rotated file too', () => {
  const dir = tmpDir('rotated');
  try {
    const entry = lootEntry('n', 3100, 0, AT, { 501: 1 });
    fs.mkdirSync(path.join(dir, BONE), { recursive: true });
    fs.writeFileSync(path.join(dir, BONE, OB.OBSERVED_ROTATED_FILE), JSON.stringify(OB.lineFor('loot', OB.parseLoot(entry).samples[0])) + '\n');
    const observed = OB.createObserved({ dir });
    assert.equal(observed.ingest(BONE, 'loot', OB.parseLoot(entry)), 0, 'a sample already in observed.1.jsonl is not written again');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('farm_spot_lookup: observed rates with n and trust, item and map names from the synced data, NPC names never', async () => {
  const dir = tmpDir('farm');
  try {
    const npc = { type: 'npc', id: 3100, spell: 0 };
    writeLines(dir, [
      ...Array.from({ length: 12 }, (_, i) => lootLine(npc, i % 3 === 0 ? { [ITEM]: 1 } : {}, { at: AT + i })),
      ...Array.from({ length: 12 }, (_, i) => lootLine({ type: 'npc', id: 4000, spell: 0 }, { [ITEM]: 1 }, { at: AT + 50 + i, map: { id: 777777, x: 5, y: 5 } })),
    ]);
    const r = await tools(dir).call('farm_spot_lookup', { itemID: ITEM });
    assert.equal(r.ok, true, r.text);
    const out = JSON.parse(r.text);
    assert.deepEqual(out.item, { ref: '{item:501}', id: 501, name: 'Fixture Blade', trust: 'client-data', build: '1.60.1.200' });
    const row = out.sources.find(s => s.source.id === 3100);
    assert.deepEqual([row.trust, row.n, row.k, row.rate], ['observed', 12, 4, 0.333]);
    assert.deepEqual(row.source, { type: 'npc', id: 3100, spell: null, ref: null, name: null, nameNote: 'no verified name source' });
    assert.deepEqual(row.spots, [{ map: { ref: '{map:9002,41.2,47.8}', id: 9002, name: 'Fixture Vale', trust: 'client-data' }, point: { x: 41.2, y: 47.8, trust: 'observed' }, n: 4 }]);
    const unknownMap = out.sources.find(s => s.source.id === 4000);
    assert.deepEqual(unknownMap.spots, [], 'a map the data does not have is never shown');
    assert.ok(out.notes.some(n => /map 777777 is not in the game data/.test(n)));
    assert.ok(out.asOf > 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('farm_spot_lookup and market_price refuse an unknown item ID, a missing ID, no synced data and no character', async () => {
  const dir = tmpDir('refuse');
  try {
    const t = tools(dir);
    for (const tool of ['farm_spot_lookup', 'market_price']) {
      const unknown = await t.call(tool, { itemID: 999999 });
      assert.equal(unknown.ok, false);
      assert.match(unknown.text, /\{item:999999\}: that item ID is not in the Forever client data/);
      assert.match((await t.call(tool, { itemID: 'abc' })).text, /itemID must be a positive whole number/);
    }
    const noData = OT.createObservedTools({ observed: OB.createObserved({ dir }), context: () => ({ text: BONE_CONTEXT }), gameData: () => null });
    const r = await noData.call('market_price', { itemID: ITEM });
    assert.equal(r.ok, false);
    assert.match(r.text, /No game data is synced/);
    const nobody = await tools(dir, { context: 'Game: x' }).call('market_price', { itemID: ITEM });
    assert.match(nobody.text, /has not reported a character/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a web-unverified or hand-written line never backs a number: market_price and farm_spot_lookup ignore every line that is not trust observed', async () => {
  const dir = tmpDir('web');
  try {
    const npc = { type: 'npc', id: 3100, spell: 0 };
    writeLines(dir, [
      JSON.stringify({ v: 1, kind: 'ah', trust: 'web-unverified', n: 1, at: AT * 1000, key: 'w1', itemID: ITEM, price: 99, quantity: 1 }),
      JSON.stringify({ v: 1, kind: 'vendor', trust: 'community-db', n: 1, at: AT * 1000, key: 'w2', npcID: 3100, mapID: 9002, items: [{ itemID: ITEM, price: 5, stack: 1 }] }),
      ...Array.from({ length: 15 }, (_, i) => lootLine(npc, { [ITEM]: 1 }, { at: AT + i, trust: 'web-unverified' })),
    ]);
    const t = tools(dir);
    const price = JSON.parse((await t.call('market_price', { itemID: ITEM })).text);
    assert.equal(price.auctionHouse, null);
    assert.deepEqual(price.vendors, []);
    assert.match(price.notes[0], /No observed price/);
    const farm = JSON.parse((await t.call('farm_spot_lookup', { itemID: ITEM })).text);
    assert.deepEqual(farm.sources, []);
    assert.match(farm.notes[0], /No observed loot/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('market_price: the auction prices from searches the player ran and the vendor prices the player saw, with n and asOf', async () => {
  const dir = tmpDir('price');
  try {
    const observed = OB.createObserved({ dir });
    const t = TL.createTelemetry({ dir, observed, now: () => AT * 1000 });
    t.submit(gsJob(9, { ah: `${ITEM}=90/1@${AT - 2 * 86400}` }));
    t.submit(gsJob(10, { ah: [`${ITEM}=1500/4@${AT}`, `${ITEM}=1200/2@${AT + 60}`, `${OTHER_ITEM}=7/100@${AT}`].join(','), vendor: `3100@${AT + 30}@9002;${ITEM}=600/1,${OTHER_ITEM}=25/5` }));
    const r = await tools(dir).call('market_price', { itemID: ITEM });
    const out = JSON.parse(r.text);
    assert.deepEqual(out.auctionHouse, {
      n: 3, asOf: (AT + 60) * 1000, latest: { price: 1200, quantity: 2 },
      recent: { n: 2, from: AT * 1000, asOf: (AT + 60) * 1000, low: 1200, high: 1500, hours: 24 },
      trust: 'observed', unit: 'copper per item',
    }, 'a quote from two days before is counted in n but never sets low or high');
    assert.equal(out.vendors.length, 1);
    const v = out.vendors[0];
    assert.deepEqual([v.price, v.stack, v.unitPrice, v.n, v.asOf, v.trust], [600, 1, 600, 1, (AT + 30) * 1000, 'observed']);
    assert.deepEqual(v.map, { ref: null, id: 9002, name: 'Fixture Vale', trust: 'client-data' });
    assert.equal(v.npc.name, null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('route_draw: map tokens checked against the synced uimaps, drawn as one ordered layer whose every stop says model estimate', async () => {
  const dir = tmpDir('route');
  try {
    const applied = [];
    const t = tools(dir, { applied });
    const r = await t.call('route_draw', { points: ['{map:9002,40,50}', '{map:9003,10.5,20.25}'], loop: true });
    assert.equal(r.ok, true, r.text);
    assert.deepEqual(applied, [{
      op: 'set', layer: OT.ROUTE_LAYER, title: 'Fixture Vale route, model estimate', ordered: true, loop: true,
      points: [
        { m: 9002, x: 40, y: 50, label: 'Stop 1 of 2, model estimate', kind: 'poi' },
        { m: 9003, x: 10.5, y: 20.25, label: 'Stop 2 of 2, model estimate', kind: 'poi' },
      ],
    }]);
    const out = JSON.parse(r.text);
    assert.deepEqual(out.points[0], { ref: '{map:9002,40,50}', map: { id: 9002, name: 'Fixture Vale', trust: 'client-data' }, point: { x: 40, y: 50, trust: 'model' } });
    const valid = P.validateMapCommand(applied[0]);
    assert.deepEqual(valid.points.map(p => p.label), ['Stop 1 of 2, model estimate', 'Stop 2 of 2, model estimate'], 'the bridge map validator keeps the command as it is');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('route_draw refuses the whole route for one unknown map, a non-token point, coordinates over 100, too many points, or no data; nothing is drawn', async () => {
  const dir = tmpDir('routebad');
  try {
    const applied = [];
    const t = tools(dir, { applied });
    const cases = [
      [['{map:9002,40,50}', '{map:424242,1,1}'], /point 2: \{map:424242,1,1\}: that map ID is not in the Forever client data/],
      [['{map:9002,40,50}', 'Fixture Vale 40 50'], /point 2 is not one \{map:ID,x,y\} token/],
      [['{item:501}'], /point 1 is not one \{map:ID,x,y\} token/],
      [['{map:9002,140,50}'], /map coordinates run from 0 to 100/],
      [Array.from({ length: OT.ROUTE_POINTS_MAX + 1 }, () => '{map:9002,1,1}'), /at most 40 points/],
      [[], /needs points/],
    ];
    for (const [points, why] of cases) {
      const r = await t.call('route_draw', { points });
      assert.equal(r.ok, false, JSON.stringify(points).slice(0, 60));
      assert.match(r.text, why);
    }
    const noData = OT.createObservedTools({ observed: OB.createObserved({ dir }), context: () => ({ text: BONE_CONTEXT }), gameData: () => null, applyMap: cmds => { applied.push(...cmds); return { changed: true }; } });
    assert.match((await noData.call('route_draw', { points: ['{map:9002,40,50}'] })).text, /No game data is synced/);
    assert.deepEqual(applied, [], 'nothing reached the map');
    const cleared = await t.call('route_draw', { clear: true });
    assert.equal(cleared.ok, true);
    assert.deepEqual(applied, [{ op: 'clear', layer: OT.ROUTE_LAYER }]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('map in the slot files: shared for a while after a change, held without a time limit while a tool route waits for a reply, small only on progress publishes', () => {
  const base = { now: 1000, shareUntil: 0, held: false, urgent: true, size: 10, progressMax: 100 };
  assert.equal(MH.inSlots(base), false, 'nothing changed lately: no map');
  assert.equal(MH.inSlots({ ...base, shareUntil: 2000 }), true);
  assert.equal(MH.inSlots({ ...base, held: true }), true, 'a held route rides however long the game takes');
  assert.equal(MH.inSlots({ ...base, held: true, urgent: false, size: 1000 }), false, 'a large set stays off progress publishes');
  assert.equal(MH.inSlots({ ...base, held: 'yes' }), false);
});

test('map hold: a message never releases it; the published reply or a hello does', () => {
  let clock = 1000;
  let saves = 0;
  const state = { map: { layers: {} } };
  const share = MH.createMapShare({ state, shareMs: 180000, now: () => clock, save: () => { saves += 1; } });
  share.hold();
  assert.equal(state.mapHeldForGame, true);
  clock = 1000 + 10 * 60 * 1000;
  assert.equal(share.onHello({ session: 's', id: 7, text: 'a message' }), false, 'a message waits for its reply');
  assert.equal(share.held(), true);
  assert.equal(share.inSlots({ urgent: true, size: 50000, progressMax: 20000 }), true, 'a large held set rides on the urgent reply publish however long the run took');
  assert.equal(share.onReplyPublished(), true);
  assert.equal(share.held(), false);
  assert.equal(share.shareUntil(), clock + 180000, 'the usual window starts at the reply');
  assert.equal(share.onHello({ session: 's', id: 8, hello: true }), false, 'nothing held: nothing to release');
  share.hold();
  assert.equal(share.onHello({ session: 's', id: 9, hello: true }), true, 'a hello does');
  assert.ok(saves >= 4);
});

test('the observed tools are listed for the live session, and only route_draw is a writer', () => {
  assert.deepEqual(OT.toolSchemas().map(t => t.name), ['farm_spot_lookup', 'market_price', 'route_draw']);
  assert.deepEqual(OT.WRITE_TOOL_NAMES, ['route_draw']);
});
