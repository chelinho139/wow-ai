'use strict';
const GD = require('./gamedata');

const KNOWN_KINDS = Object.freeze(['item', 'npc', 'quest', 'map', 'skill', 'faction']);
const TOKEN = new RegExp(`\\{(${KNOWN_KINDS.join('|')}):([^{}\\n]{0,40})\\}`, 'g');
const ID_ONLY = /^\s*(\d{1,9})\s*$/;
const MAP_ARGS = /^\s*(\d{1,9})\s*,\s*(\d{1,3}(?:\.\d{1,2})?)\s*,\s*(\d{1,3}(?:\.\d{1,2})?)\s*$/;
const REASON = Object.freeze({
  noData: 'noData',
  buildMismatch: 'buildMismatch',
  badToken: 'badToken',
  unknownId: 'unknownId',
  outOfRange: 'outOfRange',
  unsupportedKind: 'unsupportedKind',
});

function parseRefs(text) {
  const refs = [];
  for (const m of String(text || '').matchAll(TOKEN)) refs.push({ token: m[0], kind: m[1], args: m[2], index: m.index });
  return refs;
}

function percentText(n) {
  return n.toFixed(1);
}

function resolveItem(store, args) {
  const m = ID_ONLY.exec(args);
  if (!m) return { reason: REASON.badToken };
  const row = store.byId('items', Number(m[1]));
  return row ? { id: row.id, name: row.name, text: row.name } : { reason: REASON.unknownId };
}

function resolveSkill(store, args) {
  const m = ID_ONLY.exec(args);
  if (!m) return { reason: REASON.badToken };
  const row = store.byId('skilllines', Number(m[1]));
  return row ? { id: row.id, name: row.name, text: row.name } : { reason: REASON.unknownId };
}

function resolveMap(store, args) {
  const m = MAP_ARGS.exec(args);
  if (!m) return { reason: REASON.badToken };
  const x = Number(m[2]);
  const y = Number(m[3]);
  if (x > 100 || y > 100) return { reason: REASON.outOfRange };
  const row = store.byId('uimaps', Number(m[1]));
  if (!row) return { reason: REASON.unknownId };
  return { id: row.id, name: row.name, x, y, text: `${row.name} (${percentText(x)}, ${percentText(y)})` };
}

const RESOLVERS = Object.freeze({ item: resolveItem, skill: resolveSkill, map: resolveMap });

function createExpander(store) {
  function blocked() {
    if (!store || !store.build) return REASON.noData;
    if (store.buildCheck === GD.BUILD_CHECK.mismatch) return REASON.buildMismatch;
    return null;
  }

  function expand(text) {
    const source = String(text || '');
    const refs = [];
    const errors = [];
    const stop = blocked();
    let out = '';
    let at = 0;
    for (const ref of parseRefs(source)) {
      out += source.slice(at, ref.index);
      at = ref.index + ref.token.length;
      const resolve = RESOLVERS[ref.kind];
      const r = stop ? { reason: stop } : resolve ? resolve(store, ref.args) : { reason: REASON.unsupportedKind };
      if (r.reason) {
        errors.push({ token: ref.token, kind: ref.kind, reason: r.reason });
        out += ref.token;
        continue;
      }
      const { text: shown, ...fields } = r;
      refs.push({ token: ref.token, kind: ref.kind, ...fields, source: store.source, build: store.build, trust: GD.TRUST.clientData });
      out += shown;
    }
    out += source.slice(at);
    return errors.length ? { ok: false, text: null, refs, errors } : { ok: true, text: out, refs, errors };
  }

  return { expand };
}

module.exports = { KNOWN_KINDS, REASON, parseRefs, createExpander };
