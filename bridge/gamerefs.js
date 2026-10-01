'use strict';
const GD = require('./gamedata');

const KNOWN_KINDS = Object.freeze(['item', 'npc', 'quest', 'map', 'skill', 'faction']);
const TOKEN = new RegExp(`\\{(${KNOWN_KINDS.join('|')}):([^{}\\n]{0,40})\\}`, 'g');
const ID_ONLY = /^\s*(\d{1,9})\s*$/;
const MAP_ARGS = /^\s*(\d{1,9})\s*,\s*(\d{1,3}(?:\.\d{1,2})?)\s*,\s*(\d{1,3}(?:\.\d{1,2})?)\s*$/;
const SAFE_NAME = /^[A-Za-z0-9 ,.'\-:!?%]+$/;
const PHRASE_MIN_WORDS = 2;
const PHRASE_MAX_WORDS = 4;
const PHRASE_SOURCES = Object.freeze({ uimaps: 'map', skilllines: 'skill', zones: 'area', flightpaths: 'flight path' });
const PHRASE_TOKEN_FORMS = Object.freeze({ map: '{map:ID,x,y}', skill: '{skill:ID}' });
const SPELL_ITEM_SOURCE = 'spell taught by an item';
const BUILT_IN_SOURCE = 'built-in list';
const SOURCE_NOUNS = Object.freeze({
  map: 'a map name in the game data',
  skill: 'a skill name in the game data',
  area: 'an area name in the game data',
  'flight path': 'a flight path name in the game data',
  [SPELL_ITEM_SOURCE]: 'the spell or item a recipe or spell book teaches',
  [BUILT_IN_SOURCE]: 'a well-known ability, NPC or place name from the built-in list',
});
const SPELL_ITEM_PREFIX = /^(?:(?:Book|Tome|Codex|Grimoire|Libram|Manual)(?: of|:)|(?:Recipe|Formula|Pattern|Plans|Schematic):)\s+(.+)$/;
const RUNE_ITEM_PREFIX = /^(?:Tablet|Rune) of\s+(.+)$/;
const STOP_WORDS = Object.freeze(new Set(['a', 'an', 'the', 'of', 'and', 'or', 'in', 'on', 'at', 'to', 'for', 'with', 'by', 'from', 'it', 'its', 'is', 'be']));
const JUNK_NAME = /\b(?:test|not used|no longer used|deprecated|delete me|unused)\b/i;
const phraseIndexes = new Map();
const GLUE = /[\p{L}\p{N}{}]/u;
const MODEL_TRUST = 'model';
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
  noFlavor: 'noFlavor',
  tableUnavailable: 'tableUnavailable',
  badToken: 'badToken',
  unknownId: 'unknownId',
  outOfRange: 'outOfRange',
  unsupportedKind: 'unsupportedKind',
  unsafeName: 'unsafeName',
});
const STORE_REASONS = Object.freeze(new Set([REASON.noData, REASON.buildMismatch, REASON.buildUnknown, REASON.noFlavor]));
const PROBLEM = Object.freeze({ empty: 'empty', length: 'length', char: 'char', glued: 'glued', words: 'words', phrases: 'phrases', refs: 'refs' });

function parseRefs(text) {
  const refs = [];
  for (const m of String(text || '').matchAll(TOKEN)) refs.push({ token: m[0], kind: m[1], args: m[2], index: m.index });
  return refs;
}

function withoutRefs(text) {
  return String(text || '').replace(TOKEN, TOKEN_SEPARATOR);
}

function missingRow(store, entity) {
  return { reason: store.has(entity) ? REASON.unknownId : REASON.tableUnavailable };
}

function safeName(name) {
  return typeof name === 'string' && name.trim() !== '' && SAFE_NAME.test(name);
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
  return { id: row.id, name: row.name, point: { x, y, trust: MODEL_TRUST }, text: row.name };
}

const RESOLVERS = Object.freeze({ item: resolveNamed('items'), skill: resolveNamed('skilllines'), map: resolveMap });

function storeProblem(store) {
  if (!store) return REASON.noData;
  if (!store.flavor) return store.clientBuild ? REASON.noFlavor : REASON.buildUnknown;
  if (!store.build) return REASON.noData;
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

function syncHint(store) {
  return (store && store.syncCommand) || 'claude-wow data sync';
}

function noDataText(store) {
  return `No game data is synced for this build yet (${syncHint(store)})`;
}

function unknownBuildText(store) {
  if (!store || !store.build) return 'The game has not reported its client build, so the bridge cannot tell which game data belongs to it.';
  return `The game has not reported its client build, so the synced data (build ${store.build}) cannot be checked against it.`;
}

function noFlavorText(store) {
  return `Client build ${store.clientBuild} belongs to no game the bridge has data for (Forever is 1.60.*, Classic Era is 1.15.*), so no game data is used.`;
}

function storeProblemShort(reason, store) {
  if (reason === REASON.noData) return `${noDataText(store)}.`;
  if (reason === REASON.noFlavor) return noFlavorText(store);
  if (reason === REASON.buildMismatch) return `The synced game data is build ${store.build}, which is not in the client's build family (client ${store.clientBuild}).`;
  return unknownBuildText(store);
}

function storeProblemText(reason, store) {
  if (reason === REASON.noData) return `${noDataText(store)}, so no reference token can be checked. Until it is, only names the game itself reported may appear.`;
  if (reason === REASON.noFlavor) return `${noFlavorText(store)} No reference token can be checked; only names the game itself reported may appear.`;
  if (reason === REASON.buildMismatch) return `The synced game data is build ${store.build}, which is not in the client's build family (client ${store.clientBuild}). No reference token is expanded until the data matches the client (${syncHint(store)}).`;
  return `${unknownBuildText(store)} Send any message from the game, then try again.`;
}

function tokenErrorText(error, store) {
  const where = store && store.build ? ` for build ${store.build}` : '';
  switch (error.reason) {
    case REASON.unknownId: return `${error.token}: that ${error.kind} ID is not in the ${(store && store.flavorLabel) || 'synced'} client data${where}. Look the ID up with the wowdata tools; never use an ID from memory or from another game version.`;
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

function tokenHint() {
  return `Name a game thing with a reference token instead (${TOKEN_FORMS}), using an ID from the wowdata tools; the bridge writes the real name. Tokens work only once game data is synced for the client's build (claude-wow data sync, with --flavor classic_era for Classic Era); until then only names the game reported may appear.`;
}

function gluedText(token) {
  return `${token} touches a letter, a digit or another token. Put a space or punctuation on both sides of every token.`;
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

function gluedToken(text, tokens) {
  return tokens.find(t => GLUE.test(text[t.index - 1] || '') || GLUE.test(text[t.index + t.token.length] || '')) || null;
}

function phraseWords(name) {
  return displayWords(String(name || '').normalize('NFKC')).map(w => w.replace(POSSESSIVE, ''));
}

function phraseRuns(words) {
  const runs = [];
  for (let i = 0; i < words.length; i++) {
    for (let n = PHRASE_MIN_WORDS; n <= PHRASE_MAX_WORDS && i + n <= words.length; n++) runs.push(words.slice(i, i + n).join(' '));
  }
  return runs;
}

function phraseKey(name) {
  const words = phraseWords(name);
  return words.length >= PHRASE_MIN_WORDS && words.length <= PHRASE_MAX_WORDS ? words.join(' ') : '';
}

function indexKey(store) {
  const m = store.manifest || {};
  return [store.dir, store.build, m.fetchedAt || '', m.tableHash || ''].join('|');
}

function buildPhraseIndex(store) {
  const index = new Map();
  const add = (name, source) => {
    if (typeof name !== 'string' || JUNK_NAME.test(name)) return;
    const key = phraseKey(name);
    if (key && !index.has(key)) index.set(key, source);
  };
  for (const [entity, source] of Object.entries(PHRASE_SOURCES)) {
    for (const row of store.rows(entity)) add(row.name, source);
  }
  for (const row of store.rows('items')) {
    const name = typeof row.name === 'string' ? row.name : '';
    const taught = SPELL_ITEM_PREFIX.exec(name) || RUNE_ITEM_PREFIX.exec(name);
    if (taught && !ordinaryRemainder(taught[1])) add(taught[1], SPELL_ITEM_SOURCE);
  }
  return index;
}

function ordinaryRemainder(text) {
  const words = phraseWords(text);
  return words[0] === 'the' || words.every(w => STOP_WORDS.has(w));
}

function dataPhrases(store) {
  const problem = storeProblem(store);
  if (problem) return { index: null, note: storeProblemShort(problem, store) };
  const key = indexKey(store);
  if (phraseIndexes.has(key)) return { index: phraseIndexes.get(key), note: '' };
  const missing = [...Object.keys(PHRASE_SOURCES), 'items'].filter(entity => !store.has(entity));
  if (missing.length) return { index: null, note: `The synced game data is missing or has a damaged ${missing.join(', ')} table (${syncHint(store)} --force).` };
  const index = buildPhraseIndex(store);
  phraseIndexes.clear();
  phraseIndexes.set(key, index);
  return { index, note: '' };
}

function clauses(text) {
  return String(text).split(/[.!?;,](?=\s|$)/);
}

function refusedPhrases(text, tokens, known, index) {
  const allowed = new Set((known || []).flatMap(k => [phraseWords(k).join(' '), ...phraseRuns(phraseWords(k))]));
  const segments = [];
  let at = 0;
  for (const t of tokens) { segments.push(text.slice(at, t.index)); at = t.index + t.token.length; }
  segments.push(text.slice(at));
  const refused = [];
  for (const clause of segments.flatMap(clauses)) {
    for (const run of phraseRuns(phraseWords(clause))) {
      if (allowed.has(run) || refused.some(r => r.run === run)) continue;
      if (index && index.has(run)) refused.push({ run, source: index.get(run) });
      else if (GAME_PHRASES.has(run)) refused.push({ run, source: BUILT_IN_SOURCE });
    }
  }
  return refused;
}

function openFor(dataDir, contextText) {
  return GD.openStore({ dataDir, clientBuild: GD.clientBuildOf(contextText || '') });
}

function checkText(raw, { store = null, tokens: allowTokens = true, names = [], known = names, plainWords, charRe, maxLength }) {
  const s = typeof raw === 'string' ? raw.normalize('NFKC').trim() : '';
  if (!s) return { ok: false, problem: PROBLEM.empty };
  const tokens = allowTokens ? parseRefs(s) : [];
  const inputMax = tokens.length ? TOKEN_TEXT_MAX : maxLength;
  if (s.length > inputMax) return { ok: false, problem: PROBLEM.length, length: s.length, max: inputMax };
  const rest = tokens.length ? withoutRefs(s) : s;
  const ch = refusedChar(rest, charRe);
  if (ch) return { ok: false, problem: PROBLEM.char, char: ch };
  const glued = gluedToken(s, tokens);
  if (glued) return { ok: false, problem: PROBLEM.glued, token: glued.token };
  const words = refusedWords(rest, names, plainWords, charRe);
  if (words.length) return { ok: false, problem: PROBLEM.words, words };
  const opened = typeof store === 'function' ? store() : store;
  const { index, note } = dataPhrases(opened);
  const phrasesNote = note ? `${note} Multi-word game names were checked only against the short built-in list.` : '';
  const phrasesChecked = !!index;
  const phrases = refusedPhrases(s, tokens, known, index);
  if (phrases.length) return { ok: false, problem: PROBLEM.phrases, phrases, phrasesChecked, phrasesNote };
  if (!tokens.length) return { ok: true, text: s, refs: [], phrasesChecked, phrasesNote };
  const expanded = createExpander(opened).expand(s);
  if (!expanded.ok) return { ok: false, problem: PROBLEM.refs, errors: expanded.errors, store: opened };
  const shownCh = refusedChar(expanded.text, charRe);
  if (shownCh) {
    const ref = expanded.refs.find(r => String(r.name).includes(shownCh));
    return { ok: false, problem: PROBLEM.char, char: shownCh, expanded: true, token: ref ? ref.token : '', name: ref ? ref.name : '' };
  }
  if (expanded.text.length > maxLength) return { ok: false, problem: PROBLEM.length, length: expanded.text.length, max: maxLength, expanded: true };
  return { ok: true, text: expanded.text, refs: expanded.refs, phrasesChecked, phrasesNote };
}

function phraseText(p) {
  const token = PHRASE_TOKEN_FORMS[p.source] ? `; use ${PHRASE_TOKEN_FORMS[p.source]} for it` : '';
  const what = SOURCE_NOUNS[p.source];
  return `"${p.run}" (${what}${token})`;
}

function phrasesText(phrases, note) {
  return `These word runs are game names: ${phrases.map(phraseText).join(', ')}. Reword the text or leave the names out.${note ? ` ${note}` : ''}`;
}

const GAME_PHRASES = Object.freeze(new Set(require('./game-phrases.json').map(p => phraseWords(p).join(' '))));

function refSummary(refs) {
  return (refs || []).map(r => ({ kind: r.kind, id: r.id, name: r.name, trust: r.trust, build: r.build, ...(r.point ? { point: r.point } : {}) }));
}

module.exports = {
  KNOWN_KINDS, REASON, PROBLEM, TOKEN_FORMS, TOKEN_TEXT_MAX, GAME_PHRASES,
  parseRefs, withoutRefs, createExpander, storeProblem, errorsText, tokenHint, gluedText, phrasesText, phraseWords, openFor,
  displayWords, refusedChar, refusedWords, refusedPhrases, checkText, refSummary,
};
