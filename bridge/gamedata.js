'use strict';
const fs = require('fs');
const path = require('path');
const D = require('./datasync');

const TRUST = Object.freeze({ clientData: 'client-data', communityDb: 'community-db', none: 'none' });
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

function readRows(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row && typeof row === 'object' && isId(row.id)) rows.push(row);
  }
  return rows;
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

function openStore({ dataDir, flavor = 'forever', clientBuild = '' } = {}) {
  const root = dataDir ? D.flavorDir(dataDir, flavor) : null;
  const current = root ? D.readCurrent(root) : null;
  const build = current ? current.build : null;
  const manifest = current ? current.manifest : null;
  const dir = build ? path.join(root, build) : null;
  const tables = new Map();
  const indexes = new Map();
  const listed = new Set(manifest && manifest.entities && typeof manifest.entities === 'object' ? Object.keys(manifest.entities) : []);

  function has(entity) {
    return !!dir && ENTITIES.includes(entity) && listed.has(entity);
  }

  function rows(entity) {
    if (!has(entity)) return [];
    if (!tables.has(entity)) tables.set(entity, readRows(path.join(dir, `${entity}.jsonl`)));
    return tables.get(entity);
  }

  function byId(entity, id) {
    if (!isId(id) || !has(entity)) return null;
    if (!indexes.has(entity)) indexes.set(entity, new Map(rows(entity).map(r => [r.id, r])));
    return indexes.get(entity).get(id) || null;
  }

  function group(entity, name, keysOf) {
    const memo = `${entity}:${name}`;
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
    build,
    buildFamily: manifest ? manifest.buildFamily || null : null,
    manifest,
    dir,
    clientBuild: D.isBuild(clientBuild) ? clientBuild : '',
    buildCheck,
    source: manifest ? manifest.source || null : null,
    has,
    rows,
    byId,
    group,
    search,
    loaded: () => [...tables.keys()],
  };
}

module.exports = { TRUST, BUILD_CHECK, ENTITIES, MAX_QUERY_LENGTH, isId, clientBuildOf, buildCheckFor, foldName, openStore };
