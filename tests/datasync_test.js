'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const D = require('../bridge/datasync');

const FIXTURES = path.join(__dirname, 'fixtures', 'wago');
const BUILD = '1.60.1.200';
const OTHER_BUILD = '1.60.1.300';
const FIXED_NOW = Date.parse('2026-09-30T12:00:00Z');

function scratch(name) {
  const dir = path.join(os.tmpdir(), `claude-wow-data-${name}-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function response(status, body, headers, url) {
  const res = new Response(body, { status, headers });
  if (url) Object.defineProperty(res, 'url', { value: url });
  return res;
}

function fakeWago({ failTable, overrides = {}, disposition, servedFrom } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(url);
    assert.equal(init.redirect, 'error');
    const u = new URL(url);
    assert.equal(u.origin, 'https://wago.tools');
    if (u.pathname === '/api/builds') {
      return response(200, fs.readFileSync(path.join(FIXTURES, 'builds.json'), 'utf8'), { 'content-type': 'application/json' }, servedFrom);
    }
    const m = /^\/db2\/(\w+)\/csv$/.exec(u.pathname);
    assert.ok(m, `unexpected url ${url}`);
    const table = m[1];
    const build = u.searchParams.get('build');
    if (table === failTable) return response(500, 'boom', { 'content-type': 'text/html' });
    const body = overrides[table] ?? fs.readFileSync(path.join(FIXTURES, `${table}.csv`), 'utf8');
    return response(200, body, {
      'content-type': 'text/csv; charset=UTF-8',
      'content-disposition': disposition ? disposition(table, build) : `attachment; filename="${table}.${build}.csv"`,
    });
  };
  return { fetchImpl, calls };
}

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

function syncInto(dataDir, extra = {}) {
  const wago = extra.wago || fakeWago();
  return D.sync({ dataDir, fetch: wago.fetchImpl, now: () => FIXED_NOW, ...extra });
}

test('CSV parsing: quotes, doubled quotes, commas and newlines inside quotes, CRLF, BOM', () => {
  assert.deepEqual(D.parseCsv('﻿a,b\r\n1,"x, ""y"""\r\n2,"two\nlines"\n'), [['a', 'b'], ['1', 'x, "y"'], ['2', 'two\nlines']]);
  assert.deepEqual(D.parseCsv('a,b\n1,'), [['a', 'b'], ['1', '']]);
  assert.throws(() => D.parseCsv('a\n"open'), D.SyncError);
});

test('value checks: integers, numbers, names', () => {
  assert.equal(D.toInt('42'), 42);
  assert.equal(D.toInt('-3'), -3);
  for (const bad of ['1.5', '', ' 1', '1e3', 'abc', '99999999999999999999']) assert.equal(D.toInt(bad), null, bad);
  assert.equal(D.toNumber('-12.5'), -12.5);
  assert.equal(D.toNumber('1e3'), 1000);
  for (const bad of ['', 'abc', 'NaN', 'Infinity', '1,5']) assert.equal(D.toNumber(bad), null, bad);
  assert.equal(D.toName('Fixture Blade'), 'Fixture Blade');
  assert.equal(D.toName('x'.repeat(D.MAX_NAME_LENGTH)), 'x'.repeat(D.MAX_NAME_LENGTH));
  assert.equal(D.toName('  Edge Post '), 'Edge Post');
  assert.equal(D.toName('\u00a0Nbsp Post\u00a0'), 'Nbsp Post');
  for (const bad of ['', '   ', '\tpadded', 'x'.repeat(D.MAX_NAME_LENGTH + 1), 'a|cffff0000b', 'line\nbreak', 'tab\there', 'c1\u0085next', 'bidi\u202eflip', 'zero\u200bwidth', 'line\u2028sep', 'para\u2029sep']) assert.equal(D.toName(bad), null, JSON.stringify(bad));
});

test('build strings: only four dotted integers reach a path or a URL', () => {
  assert.equal(D.isBuild('1.60.1.70094'), true);
  for (const bad of ['1.60.1', '1.60.1.70094.1', '1.60.1.x', '../1.60.1.1', '1.60.1.1/..', '1.60.1.1\n', '', undefined, 1.6]) {
    assert.equal(D.isBuild(bad), false, String(bad));
    assert.throws(() => D.tableUrl('ItemSparse', bad), D.SyncError);
  }
  assert.equal(D.tableUrl('ItemSparse', '1.60.1.70094'), 'https://wago.tools/db2/ItemSparse/csv?build=1.60.1.70094');
  assert.throws(() => D.parseArgs(['--build', '1.60.1']), D.UsageError);
  assert.throws(() => D.parseArgs(['--build']), D.UsageError);
  assert.throws(() => D.parseArgs(['--flavor', 'forever']), D.UsageError);
  assert.throws(() => D.parseArgs(['--nope']), D.UsageError);
  assert.deepEqual(D.parseArgs(['--build=1.60.1.5', '--force']), { force: true, build: '1.60.1.5' });
});

test('a bad build string stops the sync before any fetch or folder', async () => {
  const dataDir = path.join(scratch('badbuild'), 'data');
  const wago = fakeWago();
  await assert.rejects(D.sync({ dataDir, fetch: wago.fetchImpl, build: '1.60.1.1/../../x' }), D.SyncError);
  assert.equal(wago.calls.length, 0);
  assert.equal(fs.existsSync(dataDir), false);

  const out = [];
  const err = [];
  const code = await D.main(['sync', '--build', '../etc'], { env: { CLAUDE_WOW_HOME: scratch('badbuild-main') }, fetch: wago.fetchImpl, out: s => out.push(s), err: s => err.push(s) });
  assert.equal(code, 2);
  assert.match(err.join(''), /bad build string/);
  assert.equal(await D.main(['sync', '--flavor=forever'], { env: { CLAUDE_WOW_HOME: scratch('badflag-main') }, fetch: wago.fetchImpl, out: s => out.push(s), err: s => err.push(s) }), 2);
  assert.match(err.join(''), /unknown option "--flavor=forever"/);
  assert.equal(wago.calls.length, 0);
});

test('build family: same 1.60.1 family is compatible, the exact build is exact', () => {
  assert.equal(D.buildFamily('1.60.1.70124'), '1.60.1');
  assert.equal(D.compatibility('1.60.1.70094', '1.60.1.70094'), 'exact');
  assert.equal(D.compatibility('1.60.1.70124', '1.60.1.70094'), 'family');
  assert.equal(D.compatibility('1.61.0.70124', '1.60.1.70094'), 'mismatch');
  assert.equal(D.compatibility('garbage', '1.60.1.70094'), 'mismatch');
});

test('sync: newest valid build, validated rows, drops counted, uiMap percent coordinates', async () => {
  const dataDir = path.join(scratch('sync'), 'data');
  const wago = fakeWago();
  const result = await syncInto(dataDir, { wago });
  const root = path.join(dataDir, 'forever');
  assert.equal(result.status, 'synced');
  assert.equal(result.build, BUILD);
  assert.equal(result.dir, path.join(root, BUILD));
  assert.equal(wago.calls[0], 'https://wago.tools/api/builds');
  assert.equal(wago.calls.length, 1 + D.TABLES.length);
  for (const url of wago.calls.slice(1)) assert.match(url, /\?build=1\.60\.1\.200$/);

  assert.equal(fs.readFileSync(path.join(root, 'current'), 'utf8'), `${BUILD}\n`);
  assert.deepEqual(fs.readdirSync(root).sort(), [BUILD, 'current']);

  const m = JSON.parse(fs.readFileSync(path.join(root, BUILD, 'manifest.json'), 'utf8'));
  assert.equal(m.source, 'wago.tools');
  assert.equal(m.product, 'wow_cn_beta');
  assert.equal(m.build, BUILD);
  assert.equal(m.buildFamily, '1.60.1');
  assert.equal(m.fetchedAt, '2026-09-30T12:00:00.000Z');
  assert.match(m.license, /never committed or redistributed/);
  assert.match(m.tableHash, /^[0-9a-f]{64}$/);
  assert.equal(m.previous, undefined);
  const perTable = Object.fromEntries(Object.entries(m.tables).map(([t, v]) => [t, [v.rows, v.droppedBy]]));
  assert.deepEqual(perTable, {
    UiMap: [3, { badName: 1, badId: 1 }],
    UiMapAssignment: [3, { uiRectOutOfRange: 1 }],
    AreaTable: [2, { badName: 1 }],
    TaxiNodes: [3, { badNumber: 1, badName: 1, duplicateId: 1, columnCount: 1 }],
    QuestV2: [3, { badId: 2 }],
    ItemSparse: [2, { badName: 1, badInteger: 1 }],
    SkillLine: [2, { badName: 1 }],
    SkillLineAbility: [1, { badId: 1 }],
    SpellReagents: [1, { badReagent: 1 }],
  });
  assert.equal(m.rows, 20);
  assert.equal(m.dropped, 15);
  assert.deepEqual(m.tables.TaxiNodes.notes, { zoneAmbiguous: 1, notOnAnyMap: 1 });

  const dir = path.join(root, BUILD);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['flightpaths.jsonl', 'items.jsonl', 'manifest.json', 'quests.jsonl', 'skilllineabilities.jsonl', 'skilllines.jsonl','spellreagents.jsonl', 'uimapassignments.jsonl', 'uimaps.jsonl', 'zones.jsonl']);
  const flights = readJsonl(path.join(dir, 'flightpaths.jsonl'));
  assert.deepEqual(flights.map(f => [f.id, f.name, f.map, f.zoneAmbiguous]), [
    [601, 'Fixture Town Roost', { uiMapID: 9001, x: 27.5, y: 25 }, true],
    [602, 'Fixture Vale Roost', { uiMapID: 9002, x: 10, y: 90 }, false],
    [603, 'Nowhere Roost', null, false],
  ]);
  assert.deepEqual(flights[0].maps, [{ uiMapID: 9003, x: 75, y: 50 }, { uiMapID: 9002, x: 55, y: 50 }, { uiMapID: 9001, x: 27.5, y: 25 }]);
  assert.deepEqual(flights[0].world, { x: 500, y: 450, z: 12.5 });
  assert.deepEqual(readJsonl(path.join(dir, 'zones.jsonl')).map(z => z.name), ['Fixture Vale', 'Quote "Inn"']);
  assert.deepEqual(readJsonl(path.join(dir, 'items.jsonl'))[1], { id: 502, name: 'Fixture Letter', quality: 1, itemLevel: 1, requiredLevel: 0, inventoryType: 0, sellPrice: 0, buyPrice: 0, startQuestID: 101 });
  assert.deepEqual(readJsonl(path.join(dir, 'quests.jsonl')), [{ id: 101 }, { id: 102 }, { id: 103 }]);
  assert.deepEqual(readJsonl(path.join(dir, 'skilllines.jsonl')), [{ id: 40, name: 'Fixture Craft', categoryID: 11, parentSkillLineID: 0 }, { id: 2940, name: 'Fixture Craft', categoryID: 11, parentSkillLineID: 40 }]);
  assert.deepEqual(readJsonl(path.join(dir, 'spellreagents.jsonl')), [{ id: 401, spellID: 4001, reagents: [{ itemID: 501, count: 2 }, { itemID: 502, count: 1 }] }]);
  assert.deepEqual(D.readCurrent(root).build, BUILD);
});

test('placeOnMap: one zone wins, overlapping zones fall back to the world-map continent, a point off every map or out of 0-100 gets no map', () => {
  const assignment = (id, uiMapID, region, uiMax = [1, 1]) => ({ id, uiMapID, mapID: 7, uiMin: [0, 0], uiMax, region });
  const ctx = {
    uiMaps: new Map([[1, { type: 2, system: 0 }], [2, { type: 3, system: 0 }], [3, { type: 3, system: 0 }], [5, { type: 2, system: 1 }]]),
    assignments: [
      assignment(10, 1, [-100, -100, 0, 100, 100, 0]),
      assignment(20, 2, [0, 0, 0, 100, 100, 0]),
      assignment(30, 3, [40, 40, 0, 60, 60, 0]),
      assignment(50, 5, [0, 0, 0, 100, 100, 0]),
    ],
  };
  assert.deepEqual(D.placeOnMap({ x: 10, y: 90 }, 7, ctx), {
    map: { uiMapID: 2, x: 10, y: 90 },
    maps: [{ uiMapID: 2, x: 10, y: 90 }, { uiMapID: 1, x: 5, y: 45 }, { uiMapID: 5, x: 10, y: 90 }],
    zoneAmbiguous: false,
  });
  assert.deepEqual(D.placeOnMap({ x: 50, y: 45 }, 7, ctx), {
    map: { uiMapID: 1, x: 27.5, y: 25 },
    maps: [{ uiMapID: 3, x: 75, y: 50 }, { uiMapID: 2, x: 55, y: 50 }, { uiMapID: 1, x: 27.5, y: 25 }, { uiMapID: 5, x: 55, y: 50 }],
    zoneAmbiguous: true,
  });
  assert.deepEqual(D.placeOnMap({ x: -50, y: -50 }, 7, ctx).map, { uiMapID: 1, x: 75, y: 75 });
  assert.deepEqual(D.placeOnMap({ x: 50, y: 45 }, 8, ctx), { map: null, maps: [], zoneAmbiguous: false });
  assert.deepEqual(D.placeOnMap({ x: 500, y: 500 }, 7, ctx), { map: null, maps: [], zoneAmbiguous: false });
  const stretched = { uiMaps: new Map([[4, { type: 3, system: 0 }]]), assignments: [assignment(40, 4, [0, 0, 0, 100, 100, 0], [1.5, 1])] };
  assert.equal(D.placeOnMap({ x: 50, y: 0 }, 7, stretched).map, null);
  const split = { uiMaps: new Map([[2, { type: 3, system: 0 }]]), assignments: [assignment(22, 2, [0, 0, 0, 200, 200, 0]), assignment(21, 2, [0, 0, 0, 100, 100, 0])] };
  assert.deepEqual(D.placeOnMap({ x: 50, y: 50 }, 7, split), { map: { uiMapID: 2, x: 50, y: 50 }, maps: [{ uiMapID: 2, x: 50, y: 50 }], zoneAmbiguous: false });
});

test('a build that is already current is not fetched again unless forced', async () => {
  const dataDir = path.join(scratch('current'), 'data');
  await syncInto(dataDir, { build: BUILD });
  const again = fakeWago();
  const r = await syncInto(dataDir, { build: BUILD, wago: again });
  assert.equal(r.status, 'current');
  assert.equal(again.calls.length, 0);

  const root = path.join(dataDir, 'forever');
  const marker = path.join(root, BUILD, 'stale.txt');
  fs.writeFileSync(marker, 'from the old copy');
  fs.mkdirSync(path.join(root, '1.60.1.100.tmp'));
  fs.mkdirSync(path.join(root, `${BUILD}.old`));
  const forced = fakeWago();
  const f = await syncInto(dataDir, { build: BUILD, force: true, wago: forced });
  assert.equal(f.status, 'synced');
  assert.equal(forced.calls.length, D.TABLES.length);
  assert.equal(f.dir, path.join(root, `${BUILD}-1`));
  assert.deepEqual(D.readCurrent(root), { build: BUILD, dir: f.dir, manifest: f.manifest });
  assert.equal(fs.existsSync(marker), false);
  assert.deepEqual(fs.readdirSync(root).sort(), [`${BUILD}-1`, 'current']);

  const again2 = await syncInto(dataDir, { build: BUILD, force: true });
  assert.equal(again2.dir, path.join(root, BUILD));
  assert.deepEqual(fs.readdirSync(root).sort(), [BUILD, 'current']);
});

test('a forced re-sync points current at the new folder before cleanup, and a cleanup failure is only logged', async (t) => {
  if (process.platform === 'win32' || (process.getuid && process.getuid() === 0)) return t.skip('needs POSIX permissions as a normal user');
  const dataDir = path.join(scratch('cleanup'), 'data');
  const root = path.join(dataDir, 'forever');
  await syncInto(dataDir, { build: BUILD });
  const locked = path.join(root, BUILD, 'locked');
  fs.mkdirSync(locked);
  fs.writeFileSync(path.join(locked, 'file'), 'x');
  fs.chmodSync(locked, 0o500);
  const lines = [];
  try {
    const r = await syncInto(dataDir, { build: BUILD, force: true, log: line => lines.push(line) });
    assert.equal(r.status, 'synced');
    assert.equal(fs.readFileSync(path.join(root, 'current'), 'utf8'), `${BUILD}-1\n`);
    assert.equal(D.readCurrent(root).dir, path.join(root, `${BUILD}-1`));
    assert.ok(lines.some(l => /could not remove/.test(l)), lines.join('\n'));
  } finally {
    fs.chmodSync(locked, 0o700);
  }
});

test('atomic swap: a failed sync leaves the current build, no new folder, no tmp, no lock', async () => {
  const dataDir = path.join(scratch('atomic'), 'data');
  const root = path.join(dataDir, 'forever');
  await syncInto(dataDir, { build: BUILD });
  const before = fs.readFileSync(path.join(root, BUILD, 'items.jsonl'), 'utf8');

  await assert.rejects(syncInto(dataDir, { build: OTHER_BUILD, wago: fakeWago({ failTable: 'ItemSparse' }) }), /HTTP 500/);
  assert.equal(fs.readFileSync(path.join(root, 'current'), 'utf8'), `${BUILD}\n`);
  assert.deepEqual(fs.readdirSync(root).sort(), [BUILD, 'current']);
  assert.equal(fs.readFileSync(path.join(root, BUILD, 'items.jsonl'), 'utf8'), before);
});

test('a table whose layout changed, or a file wago did not serve for that build, fails the sync', async () => {
  const dataDir = path.join(scratch('layout'), 'data');
  const root = path.join(dataDir, 'forever');
  await assert.rejects(syncInto(dataDir, { build: BUILD, wago: fakeWago({ overrides: { QuestV2: 'QuestID,Other\n1,2\n' } }) }), /QuestV2: column ID is missing/);
  await assert.rejects(syncInto(dataDir, { build: BUILD, wago: fakeWago({ overrides: { QuestV2: 'ID\n-1\n' } }) }), /QuestV2: no row passed validation/);
  await assert.rejects(syncInto(dataDir, { build: BUILD, wago: fakeWago({ disposition: t => `attachment; filename="${t}.1.60.1.1.csv"` }) }), /did not serve UiMap\.1\.60\.1\.200\.csv/);
  assert.equal(D.readCurrent(root), null);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('the lock: one sync at a time, a dead or stale holder is taken over', async () => {
  const dataDir = path.join(scratch('lock'), 'data');
  const root = path.join(dataDir, 'forever');
  const lockFile = path.join(root, D.LOCK_FILE);

  const held = D.acquireLock(root, () => FIXED_NOW, () => true);
  assert.throws(() => D.acquireLock(root, () => FIXED_NOW, () => true), D.LockedError);
  const wago = fakeWago();
  await assert.rejects(syncInto(dataDir, { wago, pidAlive: () => true }), D.LockedError);
  assert.equal(wago.calls.length, 0);
  assert.equal(fs.existsSync(lockFile), true);
  held.release();
  assert.equal(fs.existsSync(lockFile), false);

  fs.writeFileSync(lockFile, JSON.stringify({ pid: 999999, startedAt: FIXED_NOW, token: 'dead' }));
  D.acquireLock(root, () => FIXED_NOW, () => false).release();
  assert.equal(fs.existsSync(lockFile), false);

  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: FIXED_NOW - D.LOCK_STALE_MS - 1, token: 'old' }));
  D.acquireLock(root, () => FIXED_NOW, () => true).release();
  assert.equal(fs.existsSync(lockFile), false);

  const [first, second] = await Promise.allSettled([syncInto(dataDir, { build: BUILD }), syncInto(dataDir, { build: BUILD })]);
  assert.equal(first.status, 'fulfilled');
  assert.equal(second.status, 'rejected');
  assert.ok(second.reason instanceof D.LockedError);
  assert.equal(fs.existsSync(lockFile), false);
});

test('the lock: an unreadable lock is held until its file is stale', () => {
  const root = path.join(scratch('lock-empty'), 'data', 'forever');
  fs.mkdirSync(root, { recursive: true });
  const lockFile = path.join(root, D.LOCK_FILE);
  const seconds = ms => ms / 1000;
  for (const body of ['', '{"pid":']) {
    fs.writeFileSync(lockFile, body);
    fs.utimesSync(lockFile, seconds(FIXED_NOW), seconds(FIXED_NOW));
    assert.throws(() => D.acquireLock(root, () => FIXED_NOW, () => false), D.LockedError);
    assert.equal(fs.readFileSync(lockFile, 'utf8'), body);
  }
  const old = FIXED_NOW - D.LOCK_STALE_MS - 1000;
  fs.utimesSync(lockFile, seconds(old), seconds(old));
  D.acquireLock(root, () => FIXED_NOW, () => false).release();
  assert.equal(fs.existsSync(lockFile), false);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('the lock: a stale lock replaced by another taker is not deleted', () => {
  const root = path.join(scratch('lock-race'), 'data', 'forever');
  fs.mkdirSync(root, { recursive: true });
  const lockFile = path.join(root, D.LOCK_FILE);
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 999999, startedAt: FIXED_NOW, token: 'dead' }));
  const theirs = JSON.stringify({ pid: 4242, startedAt: FIXED_NOW, token: 'fresh-taker' });
  let calls = 0;
  const alive = () => {
    calls++;
    if (calls === 1) { fs.writeFileSync(lockFile, theirs); return false; }
    return true;
  };
  assert.throws(() => D.acquireLock(root, () => FIXED_NOW, alive), D.LockedError);
  assert.equal(fs.readFileSync(lockFile, 'utf8'), theirs);

  fs.writeFileSync(lockFile, JSON.stringify({ pid: 999999, startedAt: FIXED_NOW, token: 'dead' }));
  const guard = `${lockFile}.takeover`;
  fs.mkdirSync(guard);
  fs.utimesSync(guard, FIXED_NOW / 1000, FIXED_NOW / 1000);
  assert.throws(() => D.acquireLock(root, () => FIXED_NOW, () => false), /taking over/);
  assert.match(fs.readFileSync(lockFile, 'utf8'), /"dead"/);
  fs.rmdirSync(guard);
});

test('a lock held by someone else is not removed when our sync ends', () => {
  const root = path.join(scratch('lock-owner'), 'data', 'forever');
  const mine = D.acquireLock(root, () => FIXED_NOW, () => true);
  const lockFile = path.join(root, D.LOCK_FILE);
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 1, startedAt: FIXED_NOW, token: 'theirs' }));
  mine.release();
  assert.equal(fs.existsSync(lockFile), true);
});

test('a second build in the same family records which tables changed', async () => {
  const dataDir = path.join(scratch('family'), 'data');
  const first = await syncInto(dataDir, { build: BUILD });
  const changedQuests = fs.readFileSync(path.join(FIXTURES, 'QuestV2.csv'), 'utf8') + '104,6,0\n';
  const second = await syncInto(dataDir, { build: OTHER_BUILD, wago: fakeWago({ overrides: { QuestV2: changedQuests } }) });
  assert.deepEqual(second.manifest.previous, { build: BUILD, tableHash: first.manifest.tableHash, changedTables: ['QuestV2'] });
  assert.notEqual(second.manifest.tableHash, first.manifest.tableHash);
  assert.equal(D.readCurrent(path.join(dataDir, 'forever')).build, OTHER_BUILD);
  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'forever')).sort(), [BUILD, OTHER_BUILD, 'current']);
});

test('the current pointer is ignored when it is not a build string or has no manifest', () => {
  const root = path.join(scratch('pointer'), 'data', 'forever');
  fs.mkdirSync(path.join(root, BUILD), { recursive: true });
  const escape = path.join(root, '..', 'escape');
  fs.mkdirSync(escape, { recursive: true });
  fs.writeFileSync(path.join(escape, 'manifest.json'), JSON.stringify({ build: '../escape' }));
  fs.writeFileSync(path.join(root, 'current'), '../escape\n');
  assert.equal(D.readCurrent(root), null);
  fs.writeFileSync(path.join(root, 'current'), `${BUILD}\n`);
  assert.equal(D.readCurrent(root), null);
  fs.writeFileSync(path.join(root, BUILD, 'manifest.json'), JSON.stringify({ build: BUILD }));
  assert.equal(D.readCurrent(root).build, BUILD);
});

test('claude-wow data sync writes under CLAUDE_WOW_HOME/data and reports counts', async () => {
  const home = scratch('main');
  const wago = fakeWago();
  const out = [];
  const code = await D.main(['sync'], { env: { CLAUDE_WOW_HOME: home }, fetch: wago.fetchImpl, now: () => FIXED_NOW, out: s => out.push(s), err: s => out.push(s) });
  assert.equal(code, 0);
  assert.match(out.join(''), /20 rows kept, 15 dropped; current build 1\.60\.1\.200/);
  assert.equal(fs.readFileSync(path.join(home, 'data', 'forever', 'current'), 'utf8'), `${BUILD}\n`);

  const usage = [];
  assert.equal(await D.main(['nope'], { out: s => usage.push(s), err: s => usage.push(s) }), 2);
  assert.match(usage.join(''), /claude-wow data sync/);
});

test('an unexpected error in the sync is one line and exit 1, never a rejection', async () => {
  const err = [];
  const brokenFetch = async () => ({ status: 200, get headers() { throw new TypeError('headers exploded'); } });
  const code = await D.main(['sync', '--build', BUILD], { env: { CLAUDE_WOW_HOME: scratch('main-crash') }, fetch: brokenFetch, out: () => {}, err: s => err.push(s) });
  assert.equal(code, 1);
  assert.equal(err.length, 1);
  assert.match(err[0], /^data sync failed: .*headers exploded\n$/);

  const throwingLog = await D.main(['sync', '--build', BUILD], { env: { CLAUDE_WOW_HOME: scratch('main-crash2') }, fetch: fakeWago().fetchImpl, out: () => { throw new RangeError('stdout closed'); }, err: s => err.push(s) });
  assert.equal(throwingLog, 1);
  assert.match(err[1], /stdout closed/);
});

test('optional tables: a failed SkillLineAbility or SpellReagents is recorded and the sync goes on', async () => {
  for (const table of ['SkillLineAbility', 'SpellReagents']) {
    const dataDir = path.join(scratch(`optional-${table}`), 'data');
    const r = await syncInto(dataDir, { build: BUILD, wago: fakeWago({ failTable: table }) });
    assert.equal(r.status, 'synced');
    const spec = D.TABLES.find(s => s.table === table);
    assert.match(r.manifest.tables[table].error, /HTTP 500/);
    assert.equal(r.manifest.tables[table].rows, undefined);
    assert.equal(r.manifest.entities[spec.entity], undefined);
    assert.equal(fs.existsSync(path.join(r.dir, `${spec.entity}.jsonl`)), false);
    assert.equal(fs.existsSync(path.join(r.dir, 'items.jsonl')), true);
    assert.equal(D.readCurrent(path.join(dataDir, 'forever')).build, BUILD);
  }
  const layout = await syncInto(path.join(scratch('optional-layout'), 'data'), { build: BUILD, wago: fakeWago({ overrides: { SpellReagents: 'Other\n1\n' } }) });
  assert.match(layout.manifest.tables.SpellReagents.error, /column .* is missing/);
  await assert.rejects(syncInto(path.join(scratch('required'), 'data'), { build: BUILD, wago: fakeWago({ failTable: 'TaxiNodes' }) }), /HTTP 500/);
});

test('build family: the newest build of the configured family, and no family switch without --build', async () => {
  const dataDir = path.join(scratch('family-pick'), 'data');
  const root = path.join(dataDir, 'forever');
  const newer = await syncInto(dataDir, { family: '1.61.0' });
  assert.equal(newer.build, '1.61.0.50');

  const lines = [];
  await assert.rejects(syncInto(dataDir, { log: l => lines.push(l) }), /current data is 1\.61\.0\.50 .*--build/);
  assert.equal(D.readCurrent(root).build, '1.61.0.50');

  const explicit = await syncInto(dataDir, { build: BUILD });
  assert.equal(explicit.status, 'synced');
  assert.equal(D.readCurrent(root).build, BUILD);
  assert.equal(explicit.manifest.previous, undefined);

  await assert.rejects(syncInto(dataDir, { family: '1.60' }), /bad build family/);
});

test('fetch: no redirect off wago.tools, the body is capped while it streams', async () => {
  const dataDir = path.join(scratch('fetch'), 'data');
  await assert.rejects(syncInto(dataDir, { wago: fakeWago({ servedFrom: 'https://evil.example/api/builds' }) }), /came from https:\/\/evil\.example/);
  await assert.rejects(syncInto(dataDir, { maxBodyBytes: 32 }), /larger than 32 bytes/);

  let pulls = 0;
  const endless = new ReadableStream({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(1024)); } });
  const streaming = async () => new Response(endless, { status: 200, headers: { 'content-type': 'application/json' } });
  await assert.rejects(D.sync({ dataDir, fetch: streaming, maxBodyBytes: 4096 }), /larger than 4096 bytes/);
  assert.ok(pulls < 16, `read ${pulls} chunks`);

  let bodyRead = false;
  const declared = async () => {
    const res = new Response('{}', { status: 200, headers: { 'content-type': 'application/json', 'content-length': '999999999' } });
    const realBody = res.body;
    Object.defineProperty(res, 'body', { get() { bodyRead = true; return realBody; } });
    return res;
  };
  await assert.rejects(D.sync({ dataDir, fetch: declared, maxBodyBytes: 4096 }), /larger than 4096 bytes/);
  assert.equal(bodyRead, false);

  const failing = async () => new Response(new ReadableStream({ pull(c) { c.error(new TypeError('socket hang up')); } }), { status: 200, headers: { 'content-type': 'application/json' } });
  await assert.rejects(D.sync({ dataDir, fetch: failing }), e => e instanceof D.SyncError && /^https:\/\/wago\.tools\/api\/builds: socket hang up$/.test(e.message));
});
