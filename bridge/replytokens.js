'use strict';
const GD = require('./gamedata');

const TOKEN = /\{([A-Za-z]+):(\d{1,9})\}/g;
const LINKED_MARK = '--- Linked from the game ---';
const LINKED_LINE = /^\[[^\]\n]*\] (item|spell|quest) (\d{1,9})\b/gm;
const CHECKED_KINDS = new Set(['item', 'spell', 'quest']);
const MAX_DROPS_LOGGED = 10;

function linkedIds(texts) {
  const ids = new Set();
  for (const text of texts) {
    const s = String(text || '');
    const at = s.indexOf(LINKED_MARK);
    if (at < 0) continue;
    for (const m of s.slice(at + LINKED_MARK.length).matchAll(LINKED_LINE)) ids.add(`${m[1]}:${Number(m[2])}`);
  }
  return ids;
}

function trusted(store) {
  return !!store && store.rowTrust === GD.TRUST.clientData;
}

function dataCheck(store) {
  if (!trusted(store)) return () => 'no data for this client';
  let spells = null;
  const spellIds = () => {
    if (!spells) spells = new Set([...store.rows('skilllineabilities').map(r => r.spell), ...store.rows('spellreagents').map(r => r.spellID)]);
    return spells;
  };
  const where = `${store.flavor} ${store.build} data`;
  const inTable = (entity, id) => {
    if (!store.has(entity)) return `the ${where} has no ${entity} table`;
    return store.byId(entity, id) ? '' : `not in the ${where}`;
  };
  return (kind, id) => {
    if (kind === 'item') return inTable('items', id);
    if (kind === 'quest') return inTable('quests', id);
    if (!store.has('skilllineabilities') && !store.has('spellreagents')) return `the ${where} has no recipe spell tables`;
    return spellIds().has(id) ? '' : `not linked in this chat and not a recipe spell in the ${where}`;
  };
}

function checkTokens(text, { store = null, linked = new Set() } = {}) {
  const reasonFor = dataCheck(store);
  const dropped = [];
  const out = String(text || '').replace(TOKEN, (token, rawKind, rawId) => {
    const kind = rawKind.toLowerCase();
    const id = Number(rawId);
    if (!CHECKED_KINDS.has(kind) || linked.has(`${kind}:${id}`)) return token;
    const reason = reasonFor(kind, id);
    if (!reason) return token;
    dropped.push({ kind, id, reason });
    return `${kind} ${id}`;
  });
  return { text: out, dropped };
}

function dropsLine(dropped) {
  const shown = dropped.slice(0, MAX_DROPS_LOGGED).map(d => `${d.kind}:${d.id} (${d.reason})`).join(', ');
  return `reply tokens: ${dropped.length} unlinked, ${shown}${dropped.length > MAX_DROPS_LOGGED ? ', ...' : ''}`;
}

module.exports = { LINKED_MARK, linkedIds, checkTokens, dropsLine };
