'use strict';
const GD = require('./gamedata');

const KNOWN_KINDS = Object.freeze(['item', 'npc', 'quest', 'map', 'skill', 'faction']);
const TOKEN = new RegExp(`\\{(${KNOWN_KINDS.join('|')}):([^{}\\n]{0,40})\\}`, 'g');
const ID_ONLY = /^\s*(\d{1,9})\s*$/;
const MAP_ARGS = /^\s*(\d{1,9})\s*,\s*(\d{1,3}(?:\.\d{1,2})?)\s*,\s*(\d{1,3}(?:\.\d{1,2})?)\s*$/;
const UNSAFE_NAME = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}|{}]/u;
const TOKEN_SEPARATOR = ' ';
const TYPOGRAPHIC_APOSTROPHE = /[‘’]/g;
const WORD_SPLIT = /[^a-z0-9']+/;
const NUMBER_WORD = /^\d+(?:st|nd|rd|th|x|g|s|c|k)?$/;
const POSSESSIVE = /'s$/;
const TOKEN_TEXT_MAX = 400;
const TOKEN_FORMS = '{item:ID}, {skill:ID} or {map:ID,x,y}';
const REASON = Object.freeze({
  noData: 'noData',
  buildMismatch: 'buildMismatch',
  buildUnknown: 'buildUnknown',
  tableUnavailable: 'tableUnavailable',
  badToken: 'badToken',
  unknownId: 'unknownId',
  outOfRange: 'outOfRange',
  unsupportedKind: 'unsupportedKind',
  unsafeName: 'unsafeName',
});
const STORE_REASONS = Object.freeze(new Set([REASON.noData, REASON.buildMismatch, REASON.buildUnknown]));
const PROBLEM = Object.freeze({ empty: 'empty', length: 'length', char: 'char', words: 'words', refs: 'refs' });

function parseRefs(text) {
  const refs = [];
  for (const m of String(text || '').matchAll(TOKEN)) refs.push({ token: m[0], kind: m[1], args: m[2], index: m.index });
  return refs;
}

function withoutRefs(text) {
  return String(text || '').replace(TOKEN, TOKEN_SEPARATOR);
}

function percentText(n) {
  return n.toFixed(1);
}

function missingRow(store, entity) {
  return { reason: store.has(entity) ? REASON.unknownId : REASON.tableUnavailable };
}

function safeName(name) {
  return typeof name === 'string' && name.trim() !== '' && !UNSAFE_NAME.test(name);
}

function resolveNamed(entity) {
  return (store, args) => {
    const m = ID_ONLY.exec(args);
    if (!m) return { reason: REASON.badToken };
    const row = store.byId(entity, Number(m[1]));
    if (!row) return missingRow(store, entity);
    if (!safeName(row.name)) return { reason: REASON.unsafeName };
    return { id: row.id, name: row.name, text: row.name };
  };
}

function resolveMap(store, args) {
  const m = MAP_ARGS.exec(args);
  if (!m) return { reason: REASON.badToken };
  const x = Number(m[2]);
  const y = Number(m[3]);
  if (x > 100 || y > 100) return { reason: REASON.outOfRange };
  const row = store.byId('uimaps', Number(m[1]));
  if (!row) return missingRow(store, 'uimaps');
  if (!safeName(row.name)) return { reason: REASON.unsafeName };
  return { id: row.id, name: row.name, x, y, text: `${row.name} (${percentText(x)}, ${percentText(y)})` };
}

const RESOLVERS = Object.freeze({ item: resolveNamed('items'), skill: resolveNamed('skilllines'), map: resolveMap });

function storeProblem(store) {
  if (!store || !store.build) return REASON.noData;
  if (store.buildCheck === GD.BUILD_CHECK.mismatch) return REASON.buildMismatch;
  if (store.buildCheck === GD.BUILD_CHECK.unknown) return REASON.buildUnknown;
  return null;
}

function createExpander(store) {
  function expand(text) {
    const source = String(text || '');
    const refs = [];
    const errors = [];
    const stop = storeProblem(store);
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
      refs.push({ token: ref.token, kind: ref.kind, ...fields, source: store.source, build: store.build, trust: store.rowTrust });
      out += shown;
    }
    out += source.slice(at);
    return errors.length ? { ok: false, text: null, refs, errors } : { ok: true, text: out, refs, errors };
  }

  return { expand };
}

function storeProblemText(reason, store) {
  if (reason === REASON.noData) return 'No game data is synced for this build yet (claude-wow data sync), so no reference token can be checked. Until it is, only names the game itself reported may appear.';
  if (reason === REASON.buildMismatch) return `The synced game data is build ${store.build}, which is not in the client's build family (client ${store.clientBuild}). No reference token is expanded until the data matches the client (claude-wow data sync).`;
  return `The game has not reported its client build, so the synced data (build ${store.build}) cannot be checked against it. Send any message from the game, then try again.`;
}

function tokenErrorText(error, store) {
  const where = store && store.build ? ` for build ${store.build}` : '';
  switch (error.reason) {
    case REASON.unknownId: return `${error.token}: that ${error.kind} ID is not in the Forever client data${where}. Look the ID up with the wowdata tools; never use an ID from memory or from Classic.`;
    case REASON.tableUnavailable: return `${error.token}: the ${error.kind} table is missing or damaged in the synced data, so the ID cannot be checked.`;
    case REASON.badToken: return `${error.token} is not a well-formed token. Use ${TOKEN_FORMS}, with whole-number IDs and x, y from 0 to 100.`;
    case REASON.outOfRange: return `${error.token}: map coordinates run from 0 to 100.`;
    case REASON.unsupportedKind: return `${error.token}: there is no verified source of ${error.kind} names yet, so leave that name out.`;
    case REASON.unsafeName: return `${error.token}: the name in the data has characters that cannot be shown.`;
    default: return `${error.token}: ${error.reason}.`;
  }
}

function errorsText(errors, store) {
  const storeReason = errors.map(e => e.reason).find(r => STORE_REASONS.has(r));
  if (storeReason) return storeProblemText(storeReason, store);
  return errors.map(e => tokenErrorText(e, store)).join(' ');
}

function tokenHint(store) {
  const problem = storeProblem(store);
  if (problem) return storeProblemText(problem, store);
  return `Name a game thing with a reference token instead (${TOKEN_FORMS}), using an ID from the wowdata tools; the bridge writes the real name.`;
}

function displayWords(text) {
  return String(text || '').replace(TYPOGRAPHIC_APOSTROPHE, "'").toLowerCase().split(WORD_SPLIT)
    .map(w => w.replace(/^'+|'+$/g, ''))
    .filter(Boolean);
}

function refusedChar(text, charRe) {
  return [...String(text)].find(ch => !charRe.test(ch)) || null;
}

function nameWordLists(names, charRe) {
  const usable = (names || []).map(n => String(n || '').normalize('NFKC').trim()).filter(n => n && !refusedChar(n, charRe));
  const lists = usable.map(n => displayWords(n)).filter(words => words.length);
  return lists.sort((a, b) => b.length - a.length);
}

function nameAt(words, i, lists) {
  const plain = w => w.replace(POSSESSIVE, '');
  return lists.find(list => list.every((w, k) => i + k < words.length && (words[i + k] === w || (k === list.length - 1 && plain(words[i + k]) === w)))) || null;
}

function plainWord(word, plainWords) {
  return NUMBER_WORD.test(word) || plainWords.has(word) || plainWords.has(word.replace(POSSESSIVE, ''));
}

function refusedWords(text, names, plainWords, charRe) {
  const words = displayWords(text);
  const lists = nameWordLists(names, charRe);
  const refused = [];
  for (let i = 0; i < words.length;) {
    const name = nameAt(words, i, lists);
    if (name) { i += name.length; continue; }
    if (!plainWord(words[i], plainWords) && !refused.includes(words[i])) refused.push(words[i]);
    i += 1;
  }
  return refused;
}

function checkText(raw, { store = null, names = [], plainWords, charRe, maxLength }) {
  const s = typeof raw === 'string' ? raw.normalize('NFKC').trim() : '';
  if (!s) return { ok: false, problem: PROBLEM.empty };
  const tokens = parseRefs(s);
  const inputMax = tokens.length ? TOKEN_TEXT_MAX : maxLength;
  if (s.length > inputMax) return { ok: false, problem: PROBLEM.length, length: s.length, max: inputMax };
  const rest = withoutRefs(s);
  const ch = refusedChar(rest, charRe);
  if (ch) return { ok: false, problem: PROBLEM.char, char: ch };
  const words = refusedWords(rest, names, plainWords, charRe);
  if (words.length) return { ok: false, problem: PROBLEM.words, words };
  if (!tokens.length) return { ok: true, text: s, refs: [] };
  const expanded = createExpander(store).expand(s);
  if (!expanded.ok) return { ok: false, problem: PROBLEM.refs, errors: expanded.errors };
  if (expanded.text.length > maxLength) return { ok: false, problem: PROBLEM.length, length: expanded.text.length, max: maxLength, expanded: true };
  return { ok: true, text: expanded.text, refs: expanded.refs };
}

function refSummary(refs) {
  return (refs || []).map(r => ({ kind: r.kind, id: r.id, name: r.name, trust: r.trust, build: r.build }));
}

module.exports = {
  KNOWN_KINDS, REASON, PROBLEM, TOKEN_FORMS, TOKEN_TEXT_MAX,
  parseRefs, withoutRefs, createExpander, storeProblem, errorsText, tokenHint,
  displayWords, refusedChar, refusedWords, checkText, refSummary,
};
