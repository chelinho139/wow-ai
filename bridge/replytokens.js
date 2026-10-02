'use strict';
const GD = require('./gamedata');

const TOKEN = /\{([A-Za-z]+):(\d+)\}/g;
const FENCE = /(```[\s\S]*?(?:```|$))/;
const LINKED_MARK = '--- Linked from the game ---';
const LINKED_LINE = /^\[[^\]\n]*\] (item|spell|quest) (\d+)\b/gm;
const DATA_TABLES = Object.freeze({ item: 'items', quest: 'quests' });
const MAX_LOGGED = 10;

function linkedIds(texts) {
  const ids = new Set();
  for (const text of texts) {
    const s = String(text || '');
    const at = s.indexOf(LINKED_MARK);
    if (at < 0) continue;
    for (const m of s.slice(at + LINKED_MARK.length).matchAll(LINKED_LINE)) ids.add(`${m[1]}:${m[2]}`);
  }
  return ids;
}

function missingFromData(store, kind, id) {
  if (!store || store.rowTrust !== GD.TRUST.clientData) return '';
  const entity = DATA_TABLES[kind];
  if (!store.has(entity)) return `the ${store.flavor} ${store.build} data has no ${entity} table`;
  return store.byId(entity, Number(id)) ? '' : `not in the ${store.flavor} ${store.build} data`;
}

function checkProse(text, { store, linked, unverified, unknown }) {
  return text.replace(TOKEN, (token, rawKind, id) => {
    const kind = rawKind.toLowerCase();
    if (linked.has(`${kind}:${id}`)) return token;
    if (kind === 'spell') {
      unverified.push(`spell:${id}`);
      return `spell ${id} (unverified)`;
    }
    if (DATA_TABLES[kind]) {
      const reason = missingFromData(store, kind, id);
      if (reason) unknown.push(`${kind}:${id} (${reason})`);
    }
    return token;
  });
}

function checkReply(text, { store = null, linked = new Set() } = {}) {
  const unverified = [];
  const unknown = [];
  const out = String(text || '').split(FENCE).map((part, k) => (k % 2 ? part : checkProse(part, { store, linked, unverified, unknown }))).join('');
  return { text: out, unverified, unknown };
}

function listed(items) {
  return items.slice(0, MAX_LOGGED).join(', ') + (items.length > MAX_LOGGED ? ', ...' : '');
}

function logLines({ unverified, unknown }) {
  const lines = [];
  if (unverified.length) lines.push(`reply tokens: ${unverified.length} spell token(s) not linked in this chat, shown as plain text: ${listed(unverified)}`);
  if (unknown.length) lines.push(`reply tokens: ${unknown.length} ID(s) the client will show gray: ${listed(unknown)}`);
  return lines;
}

module.exports = { LINKED_MARK, linkedIds, checkReply, logLines };
