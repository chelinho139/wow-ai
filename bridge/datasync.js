'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BUILD_PATTERN = /^\d+\.\d+\.\d+\.\d+$/;
const FLAVORS = Object.freeze({
  forever: Object.freeze({ product: 'wow_cn_beta' }),
});
const DEFAULT_FLAVOR = 'forever';
const WAGO_ORIGIN = 'https://wago.tools';
const SOURCE_NAME = 'wago.tools';
const LICENSE_NOTE = 'Blizzard client data (DB2) as mirrored by wago.tools. Cached on this machine only; never committed or redistributed.';
const MANIFEST_SCHEMA = 1;
const MAX_NAME_LENGTH = 120;
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 120000;
const LOCK_STALE_MS = 30 * 60 * 1000;
const LOCK_FILE = '.sync.lock';
const CURRENT_FILE = 'current';
const MANIFEST_FILE = 'manifest.json';
const UI_MAP_TYPE_CONTINENT = 2;
const UI_MAP_TYPE_ZONE = 3;
const UNSAFE_TEXT = /[\u0000-\u001f\u007f|]/;
const EDGE_SPACES = /^ +| +$/g;
const INTEGER_TEXT = /^-?\d+$/;
const DECIMAL_TEXT = /^-?(\d+(\.\d*)?|\.\d+)(e[-+]?\d+)?$/i;

class SyncError extends Error {}
class LockedError extends SyncError {}

function isBuild(value) {
  return typeof value === 'string' && BUILD_PATTERN.test(value);
}

function assertBuild(value) {
  if (!isBuild(value)) throw new SyncError(`bad build string ${JSON.stringify(value)}: it must look like 1.60.1.70094`);
  return value;
}

function flavorOf(name) {
  if (!Object.prototype.hasOwnProperty.call(FLAVORS, name)) throw new SyncError(`unknown flavor ${JSON.stringify(name)}: use ${Object.keys(FLAVORS).join(', ')}`);
  return FLAVORS[name];
}

function buildFamily(build) {
  return assertBuild(build).split('.').slice(0, 3).join('.');
}

function compatibility(clientBuild, dataBuild) {
  if (!isBuild(clientBuild) || !isBuild(dataBuild)) return 'mismatch';
  if (clientBuild === dataBuild) return 'exact';
  return buildFamily(clientBuild) === buildFamily(dataBuild) ? 'family' : 'mismatch';
}

function buildsUrl() {
  return `${WAGO_ORIGIN}/api/builds`;
}

function tableUrl(table, build) {
  return `${WAGO_ORIGIN}/db2/${encodeURIComponent(table)}/csv?build=${assertBuild(build)}`;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let fieldStart = i;
  const end = text.length;
  while (i < end) {
    const c = text[i];
    if (quoted) {
      const close = text.indexOf('"', i);
      if (close < 0) throw new SyncError('CSV has an unterminated quoted field');
      field += text.slice(i, close);
      if (text[close + 1] === '"') { field += '"'; i = close + 2; continue; }
      quoted = false;
      i = close + 1;
      continue;
    }
    if (c === '"' && i === fieldStart) { quoted = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; fieldStart = i; continue; }
    if (c === '\r' || c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += c === '\r' && text[i + 1] === '\n' ? 2 : 1;
      fieldStart = i;
      continue;
    }
    field += c;
    i++;
  }
  if (quoted) throw new SyncError('CSV has an unterminated quoted field');
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function toInt(value) {
  if (typeof value !== 'string' || !INTEGER_TEXT.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

function toNumber(value) {
  if (typeof value !== 'string' || !DECIMAL_TEXT.test(value)) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toName(value) {
  if (typeof value !== 'string' || UNSAFE_TEXT.test(value)) return null;
  const name = value.replace(EDGE_SPACES, '');
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) return null;
  return name;
}

function isPercent(n) {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100;
}

class Drop extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
}

function need(value, reason) {
  if (value === null) throw new Drop(reason);
  return value;
}

function idOf(row, column = 'ID') {
  const id = need(toInt(row[column]), 'badId');
  if (id <= 0) throw new Drop('badId');
  return id;
}

function intOf(row, column) {
  return need(toInt(row[column]), 'badInteger');
}

function numberOf(row, column) {
  return need(toNumber(row[column]), 'badNumber');
}

function nameOf(row, column) {
  return need(toName(row[column]), 'badName');
}

function roundPercent(n) {
  return Math.round(n * 100) / 100;
}

function projectOnto(a, world, system) {
  const [minX, minY, , maxX, maxY] = a.region;
  if (world.x < minX || world.x > maxX || world.y < minY || world.y > maxY) return null;
  if (maxX === minX || maxY === minY) return null;
  const across = (maxY - world.y) / (maxY - minY);
  const down = (maxX - world.x) / (maxX - minX);
  const x = roundPercent(100 * (a.uiMin[0] + across * (a.uiMax[0] - a.uiMin[0])));
  const y = roundPercent(100 * (a.uiMin[1] + down * (a.uiMax[1] - a.uiMin[1])));
  return isPercent(x) && isPercent(y) ? { uiMapID: a.uiMapID, x, y, system, area: (maxX - minX) * (maxY - minY) } : null;
}

function placeOnMap(world, continentID, ctx) {
  const byType = { [UI_MAP_TYPE_ZONE]: new Map(), [UI_MAP_TYPE_CONTINENT]: new Map() };
  const ordered = [...ctx.assignments].sort((p, q) => p.id - q.id);
  for (const a of ordered) {
    if (a.mapID !== continentID) continue;
    const uiMap = ctx.uiMaps.get(a.uiMapID);
    const bucket = uiMap && byType[uiMap.type];
    if (!bucket || bucket.has(a.uiMapID)) continue;
    const spot = projectOnto(a, world, uiMap.system);
    if (spot) bucket.set(a.uiMapID, spot);
  }
  const bySize = m => [...m.values()].sort((p, q) => p.system - q.system || p.area - q.area || p.uiMapID - q.uiMapID).map(({ uiMapID, x, y }) => ({ uiMapID, x, y }));
  const zones = bySize(byType[UI_MAP_TYPE_ZONE]);
  const continents = bySize(byType[UI_MAP_TYPE_CONTINENT]);
  const zoneAmbiguous = zones.length > 1;
  const map = zones.length === 1 ? zones[0] : continents[0] || null;
  return { map, maps: [...zones, ...continents], zoneAmbiguous };
}

const TABLES = Object.freeze([
  {
    table: 'UiMap',
    entity: 'uimaps',
    columns: ['ID', 'Name_lang', 'ParentUiMapID', 'Type', 'System'],
    convert(row) {
      return { id: idOf(row), name: nameOf(row, 'Name_lang'), parentUiMapID: intOf(row, 'ParentUiMapID'), type: intOf(row, 'Type'), system: intOf(row, 'System') };
    },
    accept(record, ctx) {
      ctx.uiMaps.set(record.id, { type: record.type, system: record.system });
    },
  },
  {
    table: 'UiMapAssignment',
    entity: 'uimapassignments',
    columns: ['ID', 'UiMapID', 'MapID', 'AreaID', 'OrderIndex', 'UiMin_0', 'UiMin_1', 'UiMax_0', 'UiMax_1', 'Region_0', 'Region_1', 'Region_2', 'Region_3', 'Region_4', 'Region_5'],
    convert(row) {
      const uiMin = [numberOf(row, 'UiMin_0'), numberOf(row, 'UiMin_1')];
      const uiMax = [numberOf(row, 'UiMax_0'), numberOf(row, 'UiMax_1')];
      if (![...uiMin, ...uiMax].every(n => n >= 0 && n <= 1)) throw new Drop('uiRectOutOfRange');
      return {
        id: idOf(row),
        uiMapID: idOf(row, 'UiMapID'),
        mapID: intOf(row, 'MapID'),
        areaID: intOf(row, 'AreaID'),
        orderIndex: intOf(row, 'OrderIndex'),
        uiMin,
        uiMax,
        region: [0, 1, 2, 3, 4, 5].map(k => numberOf(row, `Region_${k}`)),
      };
    },
    accept(record, ctx) {
      ctx.assignments.push(record);
    },
  },
  {
    table: 'AreaTable',
    entity: 'zones',
    columns: ['ID', 'AreaName_lang', 'ContinentID', 'ParentAreaID'],
    convert(row) {
      return { id: idOf(row), name: nameOf(row, 'AreaName_lang'), continentID: intOf(row, 'ContinentID'), parentAreaID: intOf(row, 'ParentAreaID') };
    },
  },
  {
    table: 'TaxiNodes',
    entity: 'flightpaths',
    columns: ['ID', 'Name_lang', 'ContinentID', 'Pos_0', 'Pos_1', 'Pos_2', 'Flags'],
    convert(row, ctx) {
      const continentID = intOf(row, 'ContinentID');
      const world = { x: numberOf(row, 'Pos_0'), y: numberOf(row, 'Pos_1'), z: numberOf(row, 'Pos_2') };
      return { id: idOf(row), name: nameOf(row, 'Name_lang'), continentID, flags: intOf(row, 'Flags'), world, ...placeOnMap(world, continentID, ctx) };
    },
    accept(record, ctx) {
      if (!record.map) ctx.note('TaxiNodes', 'notOnAnyMap');
      if (record.zoneAmbiguous) ctx.note('TaxiNodes', 'zoneAmbiguous');
    },
  },
  {
    table: 'QuestV2',
    entity: 'quests',
    columns: ['ID'],
    convert(row) {
      return { id: idOf(row) };
    },
  },
  {
    table: 'ItemSparse',
    entity: 'items',
    columns: ['ID', 'Display_lang', 'OverallQualityID', 'ItemLevel', 'RequiredLevel', 'InventoryType', 'SellPrice', 'BuyPrice', 'StartQuestID'],
    convert(row) {
      return {
        id: idOf(row),
        name: nameOf(row, 'Display_lang'),
        quality: intOf(row, 'OverallQualityID'),
        itemLevel: intOf(row, 'ItemLevel'),
        requiredLevel: intOf(row, 'RequiredLevel'),
        inventoryType: intOf(row, 'InventoryType'),
        sellPrice: intOf(row, 'SellPrice'),
        buyPrice: intOf(row, 'BuyPrice'),
        startQuestID: intOf(row, 'StartQuestID'),
      };
    },
  },
  {
    table: 'SkillLine',
    entity: 'skilllines',
    columns: ['ID', 'DisplayName_lang', 'CategoryID', 'ParentSkillLineID'],
    convert(row) {
      return { id: idOf(row), name: nameOf(row, 'DisplayName_lang'), categoryID: intOf(row, 'CategoryID'), parentSkillLineID: intOf(row, 'ParentSkillLineID') };
    },
  },
  {
    table: 'SkillLineAbility',
    entity: 'skilllineabilities',
    columns: ['ID', 'SkillLine', 'Spell', 'MinSkillLineRank', 'TrivialSkillLineRankLow', 'TrivialSkillLineRankHigh', 'AcquireMethod', 'SupercedesSpell'],
    convert(row) {
      return {
        id: idOf(row),
        skillLine: idOf(row, 'SkillLine'),
        spell: idOf(row, 'Spell'),
        minSkillRank: intOf(row, 'MinSkillLineRank'),
        trivialLow: intOf(row, 'TrivialSkillLineRankLow'),
        trivialHigh: intOf(row, 'TrivialSkillLineRankHigh'),
        acquireMethod: intOf(row, 'AcquireMethod'),
        supercedesSpell: intOf(row, 'SupercedesSpell'),
      };
    },
  },
  {
    table: 'SpellReagents',
    entity: 'spellreagents',
    columns: ['ID', 'SpellID', ...[0, 1, 2, 3, 4, 5, 6, 7].flatMap(k => [`Reagent_${k}`, `ReagentCount_${k}`])],
    convert(row) {
      const reagents = [];
      for (let k = 0; k < 8; k++) {
        const itemID = intOf(row, `Reagent_${k}`);
        const count = intOf(row, `ReagentCount_${k}`);
        if (itemID === 0) continue;
        if (itemID < 0 || count < 0) throw new Drop('badReagent');
        reagents.push({ itemID, count });
      }
      return { id: idOf(row), spellID: idOf(row, 'SpellID'), reagents };
    },
  },
]);

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function combinedTableHash(tables) {
  const h = crypto.createHash('sha256');
  for (const name of Object.keys(tables).sort()) h.update(`${name}:${tables[name].sha256}\n`);
  return h.digest('hex');
}

function convertTable(spec, text, ctx) {
  const rows = parseCsv(text);
  if (rows.length === 0) throw new SyncError(`${spec.table}: the CSV is empty`);
  const header = rows[0];
  const missing = spec.columns.filter(c => !header.includes(c));
  if (missing.length) throw new SyncError(`${spec.table}: column ${missing.join(', ')} is missing; the table layout changed`);
  const dropped = {};
  const drop = reason => { dropped[reason] = (dropped[reason] || 0) + 1; };
  const seen = new Set();
  const records = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    if (cells.length === 1 && cells[0] === '') continue;
    if (cells.length !== header.length) { drop('columnCount'); continue; }
    const row = {};
    for (let c = 0; c < header.length; c++) row[header[c]] = cells[c];
    let record;
    try {
      record = spec.convert(row, ctx);
    } catch (e) {
      if (e instanceof Drop) { drop(e.reason); continue; }
      throw e;
    }
    if (seen.has(record.id)) { drop('duplicateId'); continue; }
    seen.add(record.id);
    if (spec.accept) spec.accept(record, ctx);
    records.push(record);
  }
  if (records.length === 0) throw new SyncError(`${spec.table}: no row passed validation`);
  return { records, dropped };
}

async function fetchText(fetchImpl, url, { expect, filename }) {
  let res;
  try {
    res = await fetchImpl(url, { headers: { 'user-agent': `claude-wow/${require('../package.json').version} (data sync)` }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (e) {
    throw new SyncError(`${url}: ${e.message}`);
  }
  if (!res || res.status !== 200) throw new SyncError(`${url}: HTTP ${res ? res.status : 'no response'}`);
  const type = String(res.headers.get('content-type') || '');
  if (!type.includes(expect)) throw new SyncError(`${url}: expected ${expect}, got ${type || 'no content type'}`);
  if (filename) {
    const disposition = String(res.headers.get('content-disposition') || '');
    if (!disposition.includes(`filename="${filename}"`)) throw new SyncError(`${url}: wago.tools did not serve ${filename} (got ${disposition || 'no file name'})`);
  }
  const text = await res.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) throw new SyncError(`${url}: response is larger than ${MAX_BODY_BYTES} bytes`);
  return text;
}

async function latestBuild(fetchImpl, flavor) {
  const text = await fetchText(fetchImpl, buildsUrl(), { expect: 'json' });
  let list;
  try { list = JSON.parse(text)[flavor.product]; } catch { list = null; }
  if (!Array.isArray(list)) throw new SyncError(`${buildsUrl()}: no ${flavor.product} builds listed`);
  const builds = list.map(b => b && b.version).filter(isBuild);
  if (!builds.length) throw new SyncError(`${buildsUrl()}: no valid ${flavor.product} build string`);
  return builds.sort(compareBuilds).pop();
}

function compareBuilds(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let k = 0; k < 4; k++) if (pa[k] !== pb[k]) return pa[k] - pb[k];
  return 0;
}

function flavorDir(dataDir, flavorName) {
  flavorOf(flavorName);
  return path.join(dataDir, flavorName);
}

function readCurrent(root) {
  let build;
  try { build = fs.readFileSync(path.join(root, CURRENT_FILE), 'utf8').trim(); } catch { return null; }
  if (!isBuild(build)) return null;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, build, MANIFEST_FILE), 'utf8'));
    return manifest && manifest.build === build ? { build, manifest } : null;
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function acquireLock(root, now = Date.now, alive = pidAlive) {
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, LOCK_FILE);
  const token = `${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  const body = JSON.stringify({ pid: process.pid, startedAt: now(), token });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, body, { flag: 'wx' });
      return {
        file,
        release() {
          try {
            if (JSON.parse(fs.readFileSync(file, 'utf8')).token === token) fs.unlinkSync(file);
          } catch {}
        },
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    let held = null;
    try { held = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    const fresh = held && typeof held.startedAt === 'number' && now() - held.startedAt < LOCK_STALE_MS;
    if (held && fresh && alive(held.pid)) throw new LockedError(`another data sync is running (pid ${held.pid}); lock file ${file}`);
    try { fs.unlinkSync(file); } catch {}
  }
  throw new LockedError(`could not take the lock file ${file}`);
}

function writeJsonl(file, records) {
  fs.writeFileSync(file, records.length ? records.map(r => JSON.stringify(r)).join('\n') + '\n' : '');
}

function swapInto(root, build, tmpDir) {
  const finalDir = path.join(root, build);
  const oldDir = `${finalDir}.old`;
  fs.rmSync(oldDir, { recursive: true, force: true });
  if (fs.existsSync(finalDir)) fs.renameSync(finalDir, oldDir);
  fs.renameSync(tmpDir, finalDir);
  fs.rmSync(oldDir, { recursive: true, force: true });
  const pointerTmp = path.join(root, `${CURRENT_FILE}.tmp`);
  fs.writeFileSync(pointerTmp, build + '\n');
  fs.renameSync(pointerTmp, path.join(root, CURRENT_FILE));
  return finalDir;
}

async function sync(opts = {}) {
  const flavorName = opts.flavor || DEFAULT_FLAVOR;
  const flavor = flavorOf(flavorName);
  const fetchImpl = opts.fetch || globalThis.fetch;
  const now = opts.now || Date.now;
  const log = opts.log || (() => {});
  if (!opts.dataDir) throw new SyncError('no data folder given');
  if (opts.build !== undefined) assertBuild(opts.build);
  const root = flavorDir(opts.dataDir, flavorName);
  const lock = acquireLock(root, now, opts.pidAlive);
  try {
    const build = opts.build || await latestBuild(fetchImpl, flavor);
    assertBuild(build);
    const before = readCurrent(root);
    if (!opts.force && before && before.build === build) {
      log(`${flavorName} data is already at ${build}; nothing to do (--force syncs it again)`);
      return { status: 'current', build, dir: path.join(root, build), manifest: before.manifest };
    }
    const tmpDir = path.join(root, `${build}.tmp`);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    try {
      const notes = {};
      const ctx = {
        uiMaps: new Map(),
        assignments: [],
        note(table, reason) { notes[table] = notes[table] || {}; notes[table][reason] = (notes[table][reason] || 0) + 1; },
      };
      const tables = {};
      const entities = {};
      for (const spec of TABLES) {
        const url = tableUrl(spec.table, build);
        log(`fetch ${url}`);
        const text = await fetchText(fetchImpl, url, { expect: 'csv', filename: `${spec.table}.${build}.csv` });
        const { records, dropped } = convertTable(spec, text, ctx);
        const file = `${spec.entity}.jsonl`;
        writeJsonl(path.join(tmpDir, file), records);
        const droppedCount = Object.values(dropped).reduce((s, n) => s + n, 0);
        tables[spec.table] = { url, sha256: sha256(text), entity: spec.entity, rows: records.length, dropped: droppedCount, droppedBy: dropped, ...(notes[spec.table] ? { notes: notes[spec.table] } : {}) };
        entities[spec.entity] = { file, table: spec.table, rows: records.length };
        log(`${spec.entity}: ${records.length} rows, ${droppedCount} dropped`);
      }
      const tableHash = combinedTableHash(tables);
      const family = buildFamily(build);
      const manifest = {
        schema: MANIFEST_SCHEMA,
        flavor: flavorName,
        source: SOURCE_NAME,
        product: flavor.product,
        url: WAGO_ORIGIN,
        build,
        buildFamily: family,
        fetchedAt: new Date(now()).toISOString(),
        license: LICENSE_NOTE,
        rows: Object.values(tables).reduce((s, t) => s + t.rows, 0),
        dropped: Object.values(tables).reduce((s, t) => s + t.dropped, 0),
        tableHash,
        tables,
        entities,
      };
      if (before && before.manifest && before.manifest.buildFamily === family) {
        const prior = before.manifest.tables || {};
        manifest.previous = {
          build: before.build,
          tableHash: before.manifest.tableHash,
          changedTables: Object.keys(tables).filter(t => !prior[t] || prior[t].sha256 !== tables[t].sha256),
        };
      }
      fs.writeFileSync(path.join(tmpDir, MANIFEST_FILE), JSON.stringify(manifest, null, 2) + '\n');
      const dir = swapInto(root, build, tmpDir);
      return { status: 'synced', build, dir, manifest };
    } catch (e) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      throw e;
    }
  } finally {
    lock.release();
  }
}

const USAGE = 'claude-wow data sync [--build <a.b.c.d>] [--force]\n  Fetches the Forever client tables from wago.tools into <CLAUDE_WOW_HOME>/data/forever/<build>/.\n  --build  a build other than the newest one wago.tools lists\n  --force  fetch again when that build is already current\n';

function parseArgs(argv) {
  const opts = { force: false };
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k];
    if (a === '--force') opts.force = true;
    else if (a === '--build') opts.build = argv[++k] ?? '';
    else if (a.startsWith('--build=')) opts.build = a.slice('--build='.length);
    else if (a === '--flavor') opts.flavor = argv[++k] ?? '';
    else if (a.startsWith('--flavor=')) opts.flavor = a.slice('--flavor='.length);
    else throw new SyncError(`unknown option ${JSON.stringify(a)}`);
  }
  if (opts.build !== undefined) assertBuild(opts.build);
  if (opts.flavor !== undefined) flavorOf(opts.flavor);
  return opts;
}

async function main(argv, deps = {}) {
  const out = deps.out || (s => process.stdout.write(s));
  const err = deps.err || (s => process.stderr.write(s));
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h' || command === 'help') { out(USAGE); return command ? 0 : 2; }
  if (command !== 'sync') { err(`unknown data command ${JSON.stringify(command)}\n${USAGE}`); return 2; }
  if (rest.includes('--help') || rest.includes('-h')) { out(USAGE); return 0; }
  try {
    const opts = parseArgs(rest);
    const home = require('./home').resolve(deps.env || process.env);
    const result = await sync({ ...opts, dataDir: home.data, fetch: deps.fetch, now: deps.now, log: line => out(line + '\n') });
    if (result.status === 'synced') out(`${result.manifest.rows} rows kept, ${result.manifest.dropped} dropped; current build ${result.build} in ${result.dir}\n`);
    return 0;
  } catch (e) {
    if (!(e instanceof SyncError)) throw e;
    err(`data sync failed: ${e.message}\n`);
    return e instanceof LockedError ? 3 : 1;
  }
}

module.exports = {
  BUILD_PATTERN, FLAVORS, TABLES, MAX_NAME_LENGTH, LOCK_FILE, LOCK_STALE_MS, CURRENT_FILE, MANIFEST_FILE,
  SyncError, LockedError,
  isBuild, assertBuild, buildFamily, compatibility, compareBuilds, buildsUrl, tableUrl,
  parseCsv, toInt, toNumber, toName, convertTable, placeOnMap,
  acquireLock, readCurrent, flavorDir, sync, parseArgs, main,
};
