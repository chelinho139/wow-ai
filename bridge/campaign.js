'use strict';

const fs = require('fs');
const path = require('path');
const GR = require('./gamerefs');
const G = require('./goals');
const TL = require('./telemetry');
const { luaStr } = require('./protocol');
const { ROAST_WORDS } = require('./plugins/roast');

const STORE_VERSION = 1;
const CAMPAIGN_FILE = 'campaign.json';
const BEATS_MAX = 12;
const NARRATION_LINES_MAX = 5;
const LIVE_LINES_MAX = 3;
const LIVE_TEXT_MAX = 400;
const NARRATION_MAX = 400;
const TITLE_MAX = 60;
const LEVEL_LIMIT = 100;
const FIRED_MAX = BEATS_MAX * 2;
const SLOT_LUA_MAX_BYTES = 1600;
const BEAT_EVENT = 'beat';
const BEAT_IMPORTANCE = 3;
const MANUAL_KIND = 'dm';
const MANUAL_TEXT = 'next';
const NARRATE_CHAR_RE = /^[A-Za-z0-9 ,.'\-:!?%]$/;
const NARRATE_CHARS_TEXT = "letters A-Z, digits, spaces and , . ' - : ! ? %";
const AD_WORDS = Object.freeze(['tip', 'tips', 'donated', 'donation', 'discount', 'click', 'stream', 'viewers', 'chat', 'bits']);
const NARRATE_WORDS = Object.freeze(new Set([...ROAST_WORDS].filter(w => !AD_WORDS.includes(w))));

const TRIGGER = Object.freeze({ zone: 'zone', questTurnIn: 'quest_turnin', level: 'level', death: 'death', manual: 'manual' });
const TRIGGER_TYPES = Object.freeze(Object.values(TRIGGER));
const TRIGGER_WORDS = Object.freeze({ zone: 'being on a map', quest_turnin: 'a quest turn-in', level: 'a level', death: 'a death', manual: '/dm next' });

const TOOL = Object.freeze({ start: 'campaign_start', end: 'campaign_end', add: 'beat_add', trigger: 'beat_trigger', narrate: 'narrate' });
const TOOL_NAMES = Object.freeze(Object.values(TOOL));
const WRITE_TOOL_NAMES = TOOL_NAMES;

function fail(text) {
  return { ok: false, text };
}

function done(text) {
  return { ok: true, text };
}

function isDmRecord(job) {
  return !!job && job.kind === MANUAL_KIND;
}

function refusalText(r, what, names) {
  switch (r.problem) {
    case GR.PROBLEM.empty: return `${what} is empty.`;
    case GR.PROBLEM.length: return `${what} is ${r.length} characters${r.expanded ? ' once its tokens are expanded' : ''}; the limit is ${r.max}.`;
    case GR.PROBLEM.char: return r.expanded
      ? `${what}: ${r.token} expands to "${r.name}", which has a character that cannot be shown.`
      : `${what} has the character U+${r.char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}. Allowed: ${NARRATE_CHARS_TEXT}. No links, handles or slash commands.`;
    case GR.PROBLEM.glued: return `${what}: ${GR.gluedText(r.token)}`;
    case GR.PROBLEM.words: return `${what} uses words that are not allowed: ${r.words.map(w => `"${w}"`).join(', ')}. Story text may use numbers, everyday words, the character's name (${names.join(', ') || 'none reported yet'}) and reference tokens. No zone, NPC, item or quest names, and no calls to action. ${GR.tokenHint()}`;
    case GR.PROBLEM.phrases: return `${what} was refused. ${GR.phrasesText(r.phrases, r.phrasesNote)}`;
    default: return `${what} was refused. ${GR.errorsText(r.errors, r.store)}`;
  }
}

function checkStory(text, { names, store, maxLength, what }) {
  const r = GR.checkText(text, { store, names, plainWords: NARRATE_WORDS, charRe: NARRATE_CHAR_RE, maxLength });
  if (!r.ok) return fail(refusalText(r, what, names));
  if (r.phrasesNote) return fail(`${what} was not saved: multi-word game names cannot be checked. ${r.phrasesNote}`);
  return { ok: true, text: r.text, refs: GR.refSummary(r.refs) };
}

function staleContextText(snap, nowMs, tool) {
  const minutes = G.CONTEXT_STALE_MS / 60000;
  if (!snap.receivedAt) return `The bridge does not know when the game sent its context. Send any message from the game, then call ${tool} again.`;
  const age = nowMs - snap.receivedAt;
  if (age <= G.CONTEXT_STALE_MS) return '';
  return `The game context is ${Math.floor(age / 60000)} minutes old; campaign writes need one from the last ${minutes} minutes. Wait for the player's next message from the game, then call ${tool} again.`;
}

function characterNames(snap) {
  return snap.character ? [snap.character.name] : [];
}

function emptyStore(character) {
  return { v: STORE_VERSION, rev: 0, character, campaign: null };
}

function readStore(file, character) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return emptyStore(character);
    throw new Error(`cannot read ${file}: ${e.message}`);
  }
  let doc;
  try { doc = JSON.parse(raw); } catch (e) { throw new Error(`${file} is not valid JSON (${e.message}); fix or move it first`); }
  if (!doc || doc.v !== STORE_VERSION) throw new Error(`${file} is not a version ${STORE_VERSION} campaign store`);
  const c = doc.campaign;
  if (c !== null && (!c || typeof c !== 'object' || !Array.isArray(c.beats))) throw new Error(`${file} has a damaged campaign; fix or move it first`);
  return { ...doc, rev: Number(doc.rev) || 0 };
}

function writeStore(file, doc) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function storeFile(root, characterKey) {
  return path.join(root, characterKey, CAMPAIGN_FILE);
}

function fileStamp(stat) {
  return [stat.mtimeMs, stat.ctimeMs, stat.size, stat.ino].join(':');
}

function wholeNumber(value, min, max) {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

function checkTrigger(raw, store) {
  const spec = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  if (!TRIGGER_TYPES.includes(spec.type)) return fail(`trigger.type must be one of ${TRIGGER_TYPES.map(t => `"${t}"`).join(', ')}.`);
  if (spec.type === TRIGGER.death || spec.type === TRIGGER.manual) return { ok: true, trigger: { type: spec.type }, refs: [] };
  if (spec.type === TRIGGER.level) {
    const level = wholeNumber(spec.level, 2, LEVEL_LIMIT);
    return level === null ? fail(`a level trigger needs level, a whole number from 2 to ${LEVEL_LIMIT}.`) : { ok: true, trigger: { type: spec.type, level }, refs: [] };
  }
  const stop = GR.storeProblem(store);
  if (stop) return fail(`A ${spec.type} trigger is checked against the synced game data. ${GR.errorsText([{ reason: stop }], store)}`);
  if (spec.type === TRIGGER.zone) {
    const mapID = wholeNumber(spec.mapID, 1, Number.MAX_SAFE_INTEGER);
    const row = mapID === null ? null : store.byId('uimaps', mapID);
    if (!row) return fail(`zone trigger: mapID ${spec.mapID} is not a map in the Forever client data for build ${store.build}. Look the uiMapID up with the wowdata tools; never use an ID from memory or from Classic.`);
    return { ok: true, trigger: { type: spec.type, mapID }, refs: [{ kind: 'map', id: mapID, name: row.name, trust: store.rowTrust, build: store.build }] };
  }
  const questID = wholeNumber(spec.questID, 1, Number.MAX_SAFE_INTEGER);
  if (questID === null || !store.byId('quests', questID)) return fail(`quest_turnin trigger: questID ${spec.questID} is not a quest in the Forever client data for build ${store.build}. Look it up with the wowdata tools.`);
  return { ok: true, trigger: { type: spec.type, questID }, refs: [{ kind: 'quest', id: questID, trust: store.rowTrust, build: store.build }] };
}

function checkBeat(raw, names, data, label) {
  const spec = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const title = checkStory(spec.title, { names, store: data, maxLength: TITLE_MAX, what: `${label}: the title` });
  if (!title.ok) return title;
  const lines = Array.isArray(spec.narration) ? spec.narration : [];
  if (lines.length < 1 || lines.length > NARRATION_LINES_MAX) return fail(`${label}: narration must be 1 to ${NARRATION_LINES_MAX} lines.`);
  const shown = [];
  const refs = [...title.refs];
  for (const [i, line] of lines.entries()) {
    const r = checkStory(line, { names, store: data, maxLength: NARRATION_MAX, what: `${label}: narration line ${i + 1}` });
    if (!r.ok) return r;
    shown.push(r.text);
    refs.push(...r.refs);
  }
  const total = shown.reduce((n, l) => n + l.length, 0);
  if (total > NARRATION_MAX) return fail(`${label}: the narration is ${total} characters once expanded; the limit for a beat is ${NARRATION_MAX}.`);
  const trigger = checkTrigger(spec.trigger, data());
  if (!trigger.ok) return fail(`${label}: ${trigger.text}`);
  return { ok: true, beat: { title: title.text, trigger: trigger.trigger, narration: shown, refs: [...trigger.refs, ...refs] } };
}

function matches(trigger, happening) {
  if (!trigger || trigger.type !== happening.type) return false;
  if (trigger.type === TRIGGER.zone) return happening.mapID === trigger.mapID;
  if (trigger.type === TRIGGER.level) return happening.level >= trigger.level;
  if (trigger.type === TRIGGER.questTurnIn) return happening.questID === trigger.questID;
  return true;
}

function happeningsFrom(events) {
  const out = [];
  for (const e of Array.isArray(events) ? events : []) {
    const d = e && e.data ? e.data : {};
    if (e.type === 'zone' && Number.isInteger(d.to)) out.push({ type: TRIGGER.zone, mapID: d.to });
    else if (e.type === 'level_up' && Number.isInteger(d.to)) out.push({ type: TRIGGER.level, level: d.to });
    else if (e.type === 'death') out.push({ type: TRIGGER.death });
    else if (e.type === 'quest_turnin' && Number.isInteger(d.id)) out.push({ type: TRIGGER.questTurnIn, questID: d.id });
  }
  return out;
}

function standingHappenings(standing) {
  const s = standing && typeof standing === 'object' ? standing : {};
  const out = [];
  if (Number.isInteger(s.mapID)) out.push({ type: TRIGGER.zone, mapID: s.mapID });
  if (Number.isInteger(s.level)) out.push({ type: TRIGGER.level, level: s.level });
  return out;
}

function armedBeat(campaign) {
  if (!campaign) return null;
  const at = Number.isInteger(campaign.next) ? campaign.next : 0;
  return at >= 0 && at < campaign.beats.length ? campaign.beats[at] : null;
}

function fire(campaign, index, by, stamp) {
  const beat = campaign.beats[index];
  campaign.current = beat.id;
  campaign.next = index + 1;
  campaign.live = [];
  campaign.fired = [...(Array.isArray(campaign.fired) ? campaign.fired : []), { id: beat.id, by, at: stamp }].slice(-FIRED_MAX);
  return beat;
}

function storedRefNames(beat) {
  return (Array.isArray(beat.refs) ? beat.refs : []).map(r => r && r.name).filter(n => typeof n === 'string' && n);
}

function recheck(text, names, maxLength) {
  const r = GR.checkText(text, { store: null, tokens: false, names, plainWords: NARRATE_WORDS, charRe: NARRATE_CHAR_RE, maxLength });
  return r.ok ? r.text : null;
}

function slotPayload(doc, snap) {
  const out = { rev: Math.max(0, Math.floor(Number(doc.rev) || 0)), char: snap.character ? snap.character.key : '', beat: null, manual: false };
  const c = doc.campaign;
  if (!c) return out;
  const armed = armedBeat(c);
  out.manual = !!armed && armed.trigger && armed.trigger.type === TRIGGER.manual;
  const beat = c.beats.find(b => b.id === c.current);
  if (!beat) return out;
  const names = characterNames(snap).concat(storedRefNames(beat));
  const title = recheck(beat.title, names, TITLE_MAX);
  if (!title) return { ...out, withheld: `beat ${beat.id} is not shown: its title fails the story text check` };
  const narration = (beat.narration || []).map(l => recheck(l, names, NARRATION_MAX)).filter(Boolean);
  const checkedLive = (Array.isArray(c.live) ? c.live : []).map(l => recheck(l && l.text, characterNames(snap).concat((l && l.names) || []), NARRATION_MAX)).filter(Boolean);
  const dropped = (beat.narration || []).length + (c.live || []).length - narration.length - checkedLive.length;
  const live = [];
  let liveChars = 0;
  for (const line of [...checkedLive].reverse()) {
    if (liveChars + line.length > LIVE_TEXT_MAX) break;
    live.unshift(line);
    liveChars += line.length;
  }
  return { ...out, beat: { id: String(beat.id), title, narration, live }, ...(dropped ? { withheld: `${dropped} line(s) of beat ${beat.id} failed the story text check` } : {}) };
}

function luaDm(payload, nowSec) {
  const head = `rev = ${payload.rev}, char = ${luaStr(payload.char || '')}, now = ${Math.floor(nowSec)}`;
  const manual = payload.manual ? ', manual = true' : '';
  if (!payload.beat) return `\tdm = { ${head}${manual} },`;
  const narration = [...payload.beat.narration];
  const live = [...payload.beat.live];
  const render = () => `\tdm = { ${head}${manual}, beat = { id = ${luaStr(payload.beat.id)}, title = ${luaStr(payload.beat.title)}, lines = { ${narration.concat(live).map(luaStr).join(', ')} } } },`;
  let lua = render();
  while (Buffer.byteLength(lua, 'utf8') > SLOT_LUA_MAX_BYTES && (live.length || narration.length > 1)) {
    if (live.length) live.shift();
    else narration.pop();
    lua = render();
  }
  return lua;
}

function campaignView(doc) {
  const c = doc.campaign;
  if (!c) return { character: doc.character, campaign: null };
  const armed = armedBeat(c);
  return {
    character: doc.character,
    campaign: {
      id: c.id,
      title: c.title,
      current: c.current || null,
      next: armed ? { id: armed.id, waitsFor: TRIGGER_WORDS[armed.trigger.type], trigger: armed.trigger } : null,
      beats: c.beats.map(b => ({ id: b.id, title: b.title, trigger: b.trigger })),
      live: (c.live || []).map(l => l.text),
    },
  };
}

function createCampaigns(opts) {
  const root = opts.dir;
  const context = opts.context || (() => null);
  const now = opts.now || Date.now;
  const log = opts.log || (() => {});
  const gameData = opts.gameData || (() => null);
  const onChange = opts.onChange || (() => {});
  const standing = opts.standing || (() => null);
  let cached = { file: '', stamp: '', doc: null };
  let lastSlotProblem = '';

  function slotProblem(text) {
    if (text !== lastSlotProblem) log(`campaign: the slot files hide part of the DM frame (${text})`);
    lastSlotProblem = text;
  }

  function dataOnce(snap) {
    let opened = false;
    let store = null;
    return () => {
      if (!opened) { opened = true; store = gameData(snap.text); }
      return store;
    };
  }

  function save(file, doc, why, character) {
    doc.rev += 1;
    writeStore(file, doc);
    cached = { file: '', stamp: '', doc: null };
    log(`campaign: ${why} for ${character}, rev ${doc.rev}`);
    onChange();
  }

  function noteBeatEvent(character, campaign, index) {
    try {
      TL.appendEvents(root, character, [{ type: BEAT_EVENT, importance: BEAT_IMPORTANCE, data: { n: index + 1, of: campaign.beats.length } }], { now: now() });
    } catch (e) {
      log(`campaign: could not note the beat in ${TL.EVENTS_FILE} for ${character} (${e.message})`);
    }
  }

  function standingOf(character) {
    try { return standing(character) || null; } catch (e) {
      log(`campaign: cannot read where ${character} stands (${e.message})`);
      return null;
    }
  }

  function fireMatching(c, happenings, stamp, limit) {
    const fired = [];
    for (const h of happenings) {
      const armed = armedBeat(c);
      if (!armed || fired.length >= limit) break;
      if (!matches(armed.trigger, h)) continue;
      const index = c.beats.indexOf(armed);
      fire(c, index, h.by || h.type, stamp);
      fired.push(index);
    }
    return fired;
  }

  function fireFrom(character, edges, { standingToo }) {
    const file = storeFile(root, character);
    let doc;
    try { doc = readStore(file, character); } catch (e) {
      log(`campaign: ${e.message}`);
      return [];
    }
    const c = doc.campaign;
    if (!armedBeat(c)) return [];
    const stamp = now();
    let fired = fireMatching(c, edges, stamp, Infinity);
    if (!fired.length && standingToo) fired = fireMatching(c, standingHappenings(standingOf(character)).map(h => ({ ...h, by: `${h.type} (already there)` })), stamp, 1);
    if (!fired.length) return [];
    try { save(file, doc, `beat ${fired.map(i => c.beats[i].id).join(', ')} fired`, character); } catch (e) {
      log(`campaign: could not save ${file} (${e.message})`);
      return [];
    }
    for (const index of fired) noteBeatEvent(character, c, index);
    return fired.map(i => c.beats[i]);
  }

  function onEvents(character, events) {
    if (!TL.CHARACTER_KEY_RE.test(String(character || ''))) return [];
    return fireFrom(character, happeningsFrom(events), { standingToo: true });
  }

  function manual(character) {
    if (!TL.CHARACTER_KEY_RE.test(String(character || ''))) return 'the record names no character';
    const fired = fireFrom(character, [{ type: TRIGGER.manual }], { standingToo: false });
    return fired.length ? `beat ${fired[0].id} fired` : 'the next beat does not wait for /dm next; nothing fired';
  }

  function startCampaign(doc, args, snap, data, stamp) {
    if (doc.campaign) return fail(`The campaign "${doc.campaign.title}" is running. End it with ${TOOL.end} first.`);
    const names = characterNames(snap);
    const title = checkStory(args.title, { names, store: data, maxLength: TITLE_MAX, what: 'The campaign title' });
    if (!title.ok) return title;
    const raw = args.beats === undefined ? [] : args.beats;
    if (!Array.isArray(raw) || raw.length > BEATS_MAX) return fail(`beats must be a list of at most ${BEATS_MAX} beat objects.`);
    const beats = [];
    for (const [i, spec] of raw.entries()) {
      const r = checkBeat(spec, names, data, `Beat ${i + 1}`);
      if (!r.ok) return fail(`The campaign was refused and nothing was saved. ${r.text}`);
      beats.push({ id: `b${i + 1}`, ...r.beat, addedAt: stamp });
    }
    doc.campaign = { id: `c_${doc.rev + 1}`, title: title.text, startedAt: stamp, beats, next: 0, current: null, live: [], fired: [], refs: title.refs };
    return done(`Started the campaign "${title.text}" with ${beats.length} beat${beats.length === 1 ? '' : 's'}.${beats.length ? ` The first waits for ${TRIGGER_WORDS[beats[0].trigger.type]}.` : ''}`);
  }

  function addBeat(doc, args, snap, data, stamp) {
    const c = doc.campaign;
    if (!c) return fail(`There is no campaign. Start one with ${TOOL.start}.`);
    if (c.beats.length >= BEATS_MAX) return fail(`The campaign already has ${BEATS_MAX} beats.`);
    const r = checkBeat(args, characterNames(snap), data, 'The beat');
    if (!r.ok) return r;
    const id = `b${c.beats.length + 1}`;
    c.beats.push({ id, ...r.beat, addedAt: stamp });
    return done(`Added beat ${id} "${r.beat.title}"; it waits for ${TRIGGER_WORDS[r.beat.trigger.type]}.`);
  }

  function triggerBeat(doc, args, stamp) {
    const c = doc.campaign;
    if (!c) return fail(`There is no campaign. Start one with ${TOOL.start}.`);
    const index = c.beats.findIndex(b => b.id === String(args.id || ''));
    if (index < 0) return fail(`There is no beat "${args.id}". Beats: ${c.beats.map(b => b.id).join(', ') || 'none'}.`);
    const beat = fire(c, index, 'tool', stamp);
    return { ok: true, text: `Fired beat ${beat.id} "${beat.title}".`, fired: index };
  }

  function narrate(doc, args, snap, data) {
    const c = doc.campaign;
    if (!c) return fail(`There is no campaign. Start one with ${TOOL.start}.`);
    if (!c.current) return fail('No beat has fired yet, so there is nothing to add the narration to.');
    const r = checkStory(args.text, { names: characterNames(snap), store: data, maxLength: NARRATION_MAX, what: 'The narration' });
    if (!r.ok) return r;
    c.live = [...(Array.isArray(c.live) ? c.live : []), { text: r.text, names: r.refs.map(x => x.name).filter(Boolean) }].slice(-LIVE_LINES_MAX);
    return done(`Added to beat ${c.current}: "${r.text}".`);
  }

  async function call(tool, rawArgs) {
    if (!TOOL_NAMES.includes(tool)) return fail(`Unknown campaign tool: ${tool}`);
    const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {};
    const snap = G.snapshotOf(context());
    if (!snap.character) return fail('The game has not reported a character yet. Log in with the addon running, or send any message from the game first.');
    const key = snap.character.key;
    const file = storeFile(root, key);
    let doc;
    try { doc = readStore(file, key); } catch (e) { return fail(e.message); }
    const stamp = now();
    if (tool !== TOOL.end) {
      const stale = staleContextText(snap, stamp, tool);
      if (stale) return fail(stale);
    }
    const data = dataOnce(snap);
    let change;
    if (tool === TOOL.start) change = startCampaign(doc, args, snap, data, stamp);
    else if (tool === TOOL.end) {
      if (!doc.campaign) return fail('There is no campaign to end.');
      const title = doc.campaign.title;
      doc.campaign = null;
      change = done(`Ended the campaign "${title}".`);
    } else if (tool === TOOL.add) change = addBeat(doc, args, snap, data, stamp);
    else if (tool === TOOL.trigger) change = triggerBeat(doc, args, stamp);
    else change = narrate(doc, args, snap, data);
    if (!change.ok) return change;
    try { save(file, doc, tool, key); } catch (e) { return fail(`Could not save ${file}: ${e.message}`); }
    if (change.fired !== undefined) noteBeatEvent(key, doc.campaign, change.fired);
    let text = change.text;
    if (tool === TOOL.start || tool === TOOL.add) {
      const already = fireFrom(key, [], { standingToo: true });
      if (already.length) {
        text += ` The character is already there, so beat ${already[0].id} fired now.`;
        try { doc = readStore(file, key); } catch {}
      }
    }
    return done(`${text}\n${JSON.stringify(campaignView(doc))}`);
  }

  function storedDoc(file, key) {
    let stat;
    try { stat = fs.statSync(file); } catch (e) {
      if (e.code === 'ENOENT') return emptyStore(key);
      throw new Error(`cannot read ${file}: ${e.message}`);
    }
    const stamp = fileStamp(stat);
    if (cached.file === file && cached.stamp === stamp) return cached.doc;
    const doc = readStore(file, key);
    cached = { file, stamp, doc };
    return doc;
  }

  function slotLua() {
    const nowSec = now() / 1000;
    const snap = G.snapshotOf(context());
    if (!snap.character) return luaDm({ rev: 0, char: '', beat: null, manual: false }, nowSec);
    const key = snap.character.key;
    let payload;
    try {
      payload = slotPayload(storedDoc(storeFile(root, key), key), snap);
    } catch (e) {
      slotProblem(e.message);
      return luaDm({ rev: 0, char: key, beat: null, manual: false }, nowSec);
    }
    if (payload.withheld) slotProblem(payload.withheld);
    else lastSlotProblem = '';
    return luaDm(payload, nowSec);
  }

  return { call, slotLua, onEvents, manual, file: key => storeFile(root, key) };
}

function createBridgeCampaigns({ home, context, onChange, standing, log = () => {} }) {
  return createCampaigns({
    dir: home.goals,
    context,
    onChange,
    standing,
    gameData: contextText => {
      try { return GR.openFor(home.data, contextText); } catch (e) {
        log(`campaign: cannot open the synced game data (${e.message})`);
        return null;
      }
    },
    log,
  });
}

function storyRules() {
  return `Story text is checked in the bridge: only ${NARRATE_CHARS_TEXT}; every word must be a number, the character's name or an everyday English word, in any letter case; no links, handles, calls to action or ads; T-rated. Name a game thing only with a reference token, which the bridge expands from the synced Forever client data: ${GR.TOKEN_FORMS}. Take each ID from the wowdata tools, never from memory or Classic. {npc:ID} and {quest:ID} have no name source yet and are refused.`;
}

function triggerSchema() {
  return {
    type: 'object',
    description: `When the beat fires. Only the next unfired beat is armed. "zone": the character is on map mapID (a uiMapID in the synced data), on entering it or, when the beat is armed while the character is already there, at once or on the next game update. "level": the character is at level or higher, the same way. "quest_turnin": the game reports questID (in the synced data) turned in. "death": the character dies. "manual": the player types /dm next. Several beats can fire from one game update when its events match them in order; two zone beats for the same map fire one game update apart.`,
    properties: {
      type: { type: 'string', enum: TRIGGER_TYPES },
      mapID: { type: 'integer', minimum: 1 },
      questID: { type: 'integer', minimum: 1 },
      level: { type: 'integer', minimum: 2, maximum: LEVEL_LIMIT },
    },
    required: ['type'],
  };
}

function beatSchema() {
  return {
    type: 'object',
    properties: {
      title: { type: 'string', maxLength: GR.TOKEN_TEXT_MAX, description: `The beat title, at most ${TITLE_MAX} characters after expansion` },
      narration: { type: 'array', minItems: 1, maxItems: NARRATION_LINES_MAX, items: { type: 'string', maxLength: GR.TOKEN_TEXT_MAX }, description: `1 to ${NARRATION_LINES_MAX} lines, at most ${NARRATION_MAX} characters in all after expansion` },
      trigger: triggerSchema(),
    },
    required: ['title', 'narration', 'trigger'],
  };
}

function toolSchemas() {
  return [
    {
      name: TOOL.start,
      description: `Start the one solo campaign for the character the game last reported, with up to ${BEATS_MAX} beats in order (more can be added with ${TOOL.add}). The current beat shows in the in-game DM frame on the next slot the addon reads. ${storyRules()}`,
      inputSchema: { type: 'object', properties: { title: { type: 'string', maxLength: GR.TOKEN_TEXT_MAX }, beats: { type: 'array', maxItems: BEATS_MAX, items: beatSchema() } }, required: ['title'] },
    },
    {
      name: TOOL.end,
      description: 'End the running campaign. The DM frame clears.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: TOOL.add,
      description: `Add a beat at the end of the running campaign. Every trigger ID must be in the synced Forever data. ${storyRules()}`,
      inputSchema: beatSchema(),
    },
    {
      name: TOOL.trigger,
      description: 'Fire a beat now by its id (b1, b2, ...), whatever its trigger. The beats after it follow in order.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
    {
      name: TOOL.narrate,
      description: `Add one line of live narration, at most ${NARRATION_MAX} characters after expansion, under the current beat in the DM frame (the last ${LIVE_LINES_MAX} lines are kept; a new beat clears them). Nothing is sent to game chat. ${storyRules()}`,
      inputSchema: { type: 'object', properties: { text: { type: 'string', maxLength: GR.TOKEN_TEXT_MAX } }, required: ['text'] },
    },
  ];
}

module.exports = {
  STORE_VERSION, CAMPAIGN_FILE, BEATS_MAX, NARRATION_LINES_MAX, LIVE_LINES_MAX, NARRATION_MAX, TITLE_MAX, SLOT_LUA_MAX_BYTES, FIRED_MAX,
  TRIGGER, TRIGGER_TYPES, TOOL, TOOL_NAMES, WRITE_TOOL_NAMES, MANUAL_KIND, MANUAL_TEXT, AD_WORDS, NARRATE_WORDS, BEAT_EVENT,
  isDmRecord, checkStory, checkTrigger, happeningsFrom, standingHappenings, slotPayload, luaDm, readStore, storeFile, createCampaigns, createBridgeCampaigns, toolSchemas,
};
