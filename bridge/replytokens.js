'use strict';

const SPELL_TOKEN = /\{spell:(\d+)\}/gi;
const LINKED_MARK = '--- Linked from the game ---';
const LINKED_SPELL = /^\[[^\]\n]*\] (?:spell|enchant) (\d+)\b/gm;
const MAX_LOGGED = 10;

function linkedSpells(texts) {
  const ids = new Set();
  for (const text of texts) {
    const s = String(text || '');
    const at = s.indexOf(LINKED_MARK);
    if (at < 0) continue;
    for (const m of s.slice(at + LINKED_MARK.length).matchAll(LINKED_SPELL)) ids.add(Number(m[1]));
  }
  return ids;
}

function checkReply(text, linked = new Set()) {
  const unverified = [];
  const out = String(text || '').replace(SPELL_TOKEN, (token, id) => {
    if (linked.has(Number(id))) return token;
    unverified.push(id);
    return `spell ${id} (unverified)`;
  });
  return { text: out, unverified };
}

function logLine(unverified) {
  const shown = unverified.slice(0, MAX_LOGGED).map(id => `spell:${id}`).join(', ');
  return `reply tokens: ${unverified.length} spell token(s) not linked in this chat, shown as plain text: ${shown}${unverified.length > MAX_LOGGED ? ', ...' : ''}`;
}

module.exports = { LINKED_MARK, linkedSpells, checkReply, logLine };
