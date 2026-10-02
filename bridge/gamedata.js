'use strict';
const fs = require('fs');
const path = require('path');
const D = require('./datasync');

const TRUST = Object.freeze({ clientData: 'client-data', buildUnchecked: 'client-data-build-unchecked', buildMismatch: 'unverified-build-mismatch', communityDb: 'community-db', none: 'none' });
const BUILD_CHECK = Object.freeze({ exact: 'exact', family: 'family', mismatch: 'build-mismatch', unknown: 'unknown', noData: 'no-data' });
const ENTITIES = Object.freeze(['items', 'quests', 'zones', 'flightpaths', 'uimaps', 'uimapassignments', 'skilllines', 'skilllineabilities', 'spellreagents']);
const MAX_QUERY_LENGTH = 100;
const CLIENT_BUILD_IN_CONTEXT = /^Game:[^\n]*\(client (\d+\.\d+\.\d+\.\d+)[,)]/m;

function isId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function clientBuildOf(contextText) {
  const m = CLIENT_BUILD_IN_CONTEXT.exec(String(contextText || ''));
  return m && D.isBuild(m[1]) ? m[1] : '';
}

function buildCheckFor(clientBuild, dataBuild) {
  if (!dataBuild) return BUILD_CHECK.noData;
  if (!D.isBuild(clientBuild)) return BUILD_CHECK.unknown;
  const c = D.compatibility(clientBuild, dataBuild);
  return c === 'mismatch' ? BUILD_CHECK.mismatch : c;
}

function rowTrustFor(buildCheck) {
  if (buildCheck === BUILD_CHECK.exact || buildCheck === BUILD_CHECK.family) return TRUST.clientData;
  if (buildCheck === BUILD_CHECK.unknown) return TRUST.buildUnchecked;
  if (buildCheck === BUILD_CHECK.mismatch) return TRUST.buildMismatch;
  return TRUST.none;
}

function unavailable(problem) {
  return { rows: [], problem };
}

function readTable(file, expectedRows) {
  if (!Number.isSafeInteger(expectedRows) || expectedRows < 0) return unavailable('the manifest has no row count');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return unavailable(`the file cannot be read (${e.code || e.message})`); }
  const rows = [];
  let bad = 0;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let row;
    try { row = JSON.parse(line); } catch { bad++; continue; }
    if (row && typeof row === 'object' && isId(row.id)) rows.push(row);
    else bad++;
  }
  if (bad || rows.length !== expectedRows) return unavailable(`${rows.length} good rows and ${bad} bad lines, the manifest says ${expectedRows}`);
  return { rows, problem: null };
}

function foldName(s) {
  return String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function rankName(name, q) {
  const n = foldName(name);
  if (n === q) return 0;
  if (n.startsWith(q)) return 1;
  if (n.split(/[\s'-]+/).some(w => w.startsWith(q))) return 2;
  if (n.includes(q)) return 3;
  return -1;
}

function flavorFor(clientBuild, flavor) {
  return flavor === undefined ? D.flavorForBuild(clientBuild) : flavor;
}

function openStore({ dataDir, flavor: chosen, clientBuild = '' } = {}) {
  const flavor = flavorFor(clientBuild, chosen);
  const root = dataDir && flavor ? D.flavorDir(dataDir, flavor) : null;
  const current = root ? D.readCurrent(root) : null;
  const build = current ? current.build : null;
  const manifest = current ? current.manifest : null;
  const dir = current ? current.dir : null;
  const tables = new Map();
  const indexes = new Map();
  const missed = new Map();
  const listed = manifest && manifest.entities && typeof manifest.entities === 'object' ? manifest.entities : {};

  function load(entity) {
    if (!tables.has(entity)) {
      const info = Object.prototype.hasOwnProperty.call(listed, entity) ? listed[entity] : null;
      tables.set(entity, info && typeof info === 'object' ? readTable(path.join(dir, `${entity}.jsonl`), info.rows) : unavailable('this sync has no such table'));
    }
    return tables.get(entity);
  }

  function has(entity) {
    if (!dir || !ENTITIES.includes(entity)) return false;
    const table = load(entity);
    if (table.problem) missed.set(entity, table.problem);
    return !table.problem;
  }

  function rows(entity) {
    return has(entity) ? tables.get(entity).rows : [];
  }

  function byId(entity, id) {
    if (!isId(id) || !has(entity)) return null;
    if (!indexes.has(entity)) indexes.set(entity, new Map(rows(entity).map(r => [r.id, r])));
    return indexes.get(entity).get(id) || null;
  }

  function group(entity, name, keysOf) {
    const memo = `${entity}:${name}`;
    if (!has(entity)) return new Map();
    if (!indexes.has(memo)) {
      const index = new Map();
      for (const r of rows(entity)) {
        for (const key of keysOf(r)) {
          if (!index.has(key)) index.set(key, []);
          index.get(key).push(r);
        }
      }
      indexes.set(memo, index);
    }
    return indexes.get(memo);
  }

  function search(entity, query) {
    const q = foldName(query);
    if (!q) return [];
    const hits = [];
    for (const r of rows(entity)) {
      if (typeof r.name !== 'string') continue;
      const rank = rankName(r.name, q);
      if (rank >= 0) hits.push({ rank, row: r });
    }
    return hits.sort((a, b) => a.rank - b.rank || a.row.name.length - b.row.name.length || a.row.id - b.row.id);
  }

  const buildCheck = buildCheckFor(clientBuild, build);

  return {
    flavor: flavor || null,
    flavorLabel: flavor ? D.FLAVORS[flavor].label : null,
    syncCommand: D.syncCommand(flavor || D.DEFAULT_FLAVOR),
    build,
    buildFamily: manifest ? manifest.buildFamily || null : null,
    manifest,
    dir,
    clientBuild: D.isBuild(clientBuild) ? clientBuild : '',
    buildCheck,
    rowTrust: rowTrustFor(build ? buildCheck : BUILD_CHECK.noData),
    source: manifest ? manifest.source || null : null,
    has,
    rows,
    byId,
    group,
    search,
    loaded: () => [...tables.keys()].filter(entity => !tables.get(entity).problem),
    takeMissed() {
      const out = [...missed].map(([entity, problem]) => ({ entity, problem }));
      missed.clear();
      return out;
    },
  };
}

module.exports = { TRUST, BUILD_CHECK, ENTITIES, MAX_QUERY_LENGTH, isId, clientBuildOf, flavorFor, buildCheckFor, rowTrustFor, foldName, openStore };
