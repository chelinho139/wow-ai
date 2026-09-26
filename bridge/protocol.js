'use strict';
// The bridge's pure protocol code: strip records in, Lua slot files out, and the
// small rules around folders, permissions and dedup. No I/O, no config, no
// process state, so tests/bridge_test.js can exercise it directly.

const os = require('os');
const path = require('path');

function fromHex(hex) {
  return Buffer.from(hex || '', 'hex').toString('utf8');
}

function pad3(n) { return String(n).padStart(3, '0'); }

// Treat Windows paths consistently when tests or imported agent events run on
// another platform. The bridge still targets Windows, but protocol data can be
// inspected and tested elsewhere.
function isWindowsAbsolute(p) {
  const value = String(p || '');
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value);
}

function baseName(p) {
  return String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
}

function comparableWindowsPath(p) {
  const normalized = path.win32.normalize(String(p || ''));
  return normalized.length > 3 ? normalized.replace(/[\\/]$/, '') : normalized;
}

// Reply slot / signal file number for a message id (1-based, wraps at `slots`).
function slotNumber(id, slots) { return ((id - 1) % slots) + 1; }

// A chat as the bridge tracks it: the addon's session token plus the chat id.
function chatKey(job) { return `${job.session || ''}:${job.chat || 'default'}`; }
// Agent sessions are keyed by chat id alone, which survives an addon data reset.
function sessKey(job) { return job.chat ? 'chat:' + job.chat : chatKey(job); }

// ---------------------------------------------------------------------------
// Dedup: message ids restart whenever the addon's saved data is reset, so they
// are only unique within the addon's session token.
// ---------------------------------------------------------------------------

function alreadyHandled(state, job) {
  const key = job.session || '';
  const h = state.handled[key];
  if (!h) return key === '' && job.id <= state.lastId;
  return !!h[job.id];
}

function markHandled(state, job, now = Date.now()) {
  const key = job.session || '';
  const h = (state.handled[key] = state.handled[key] || {});
  h[job.id] = 1;
  const ids = Object.keys(h);
  if (ids.length > 1000) for (const k of ids.slice(0, ids.length - 1000)) delete h[k];
  state.lastId = Math.max(state.lastId, job.id);
  (state.seen = state.seen || {})[key] = now;
}

// Every saved-data reset in the game mints a new session token; forget the ones
// not heard from in a month so state.json and transcripts.json stop growing.
const MONTH_MS = 30 * 24 * 3600 * 1000;
function pruneStale(state, transcripts, now = Date.now(), maxAgeMs = MONTH_MS) {
  let removed = 0;
  state.seen = state.seen || {};
  for (const key of Object.keys(state.handled || {})) {
    if (key === '') continue;
    if (!state.seen[key]) { state.seen[key] = now; continue; } // grace period starts now
    if (now - state.seen[key] > maxAgeMs) { delete state.handled[key]; delete state.seen[key]; removed++; }
  }
  for (const key of Object.keys(state.seen)) {
    if (!(state.handled || {})[key] && now - state.seen[key] > maxAgeMs) { delete state.seen[key]; }
  }
  for (const [tok, t] of Object.entries((transcripts && transcripts.tokens) || {})) {
    if (now - t > maxAgeMs) { delete transcripts.tokens[tok]; removed++; }
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

// A chat's folder as typed in game: empty = the default, relative = relative to
// the default, ~ = home. Always absolute and normalized on the way out.
function resolveCwd(raw, base) {
  let p = String(raw || '').trim();
  if (!p) return base;
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) {
    p = path.join(os.homedir(), p.slice(1).replace(/^[\\/]+/, ''));
  }
  if (isWindowsAbsolute(p)) return path.win32.normalize(p);
  return path.resolve(base, p);
}

function sameFolder(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  if (isWindowsAbsolute(left) || isWindowsAbsolute(right)) {
    return comparableWindowsPath(left).toLowerCase() === comparableWindowsPath(right).toLowerCase();
  }
  return path.resolve(left) === path.resolve(right);
}

// ---------------------------------------------------------------------------
// In: what the game sends
// ---------------------------------------------------------------------------

// Flags field: ';'-separated tokens. "n" = fresh agent session, "h" = hello
// (no prompt), "d" = the player deleted this chat: forget its transcript and
// session (no prompt), "allow=Rule1,Rule2" = add these permission rules before
// running, "c" = the record carries a game-context field before the text (an
// empty one clears the context the bridge keeps), "agent=codex" = run this
// chat with that agent instead of the bridge's default (see agents.js).
function parseFlags(flags) {
  const out = { newSession: false, hello: false, forget: false, context: false, allow: [], agent: '' };
  for (const tok of String(flags || '').split(';')) {
    if (tok === 'n') out.newSession = true;
    else if (tok === 'h') out.hello = true;
    else if (tok === 'd') out.forget = true;
    else if (tok === 'c') out.context = true;
    else if (tok.startsWith('allow=')) out.allow.push(...tok.slice(6).split(',').map(s => s.trim()).filter(Boolean));
    else if (tok.startsWith('agent=')) out.agent = tok.slice(6).trim().toLowerCase();
  }
  return out;
}

// Strip payload: records separated by \x1E, fields by \x1F:
//   session, chat, id, cwd, flags, name, [ctx,] text
// `cwd` is left as typed; the bridge resolves it against its default folder.
// The ctx field is only there when the flags say "c" (older addons never set
// it), so a separator inside the text can't be mistaken for it.
function jobsFromStrip(headerId, payload) {
  const jobs = [];
  for (const rec of String(payload).split('\x1E')) {
    const p = rec.split('\x1F');
    if (p.length >= 7 && /^\d+$/.test(p[2])) {
      const flags = parseFlags(p[4]);
      const withCtx = flags.context && p.length >= 8;
      const job = { session: p[0], chat: p[1], id: Number(p[2]), cwd: p[3], ...flags, name: p[5], text: p.slice(withCtx ? 7 : 6).join('\x1F'), via: 'pixel' };
      if (withCtx) job.ctx = p[6];
      jobs.push(job);
    } else if (p.length === 6 && /^\d+$/.test(p[2])) { // previous format without the chat name
      jobs.push({ session: p[0], chat: p[1], id: Number(p[2]), cwd: p[3], ...parseFlags(p[4]), name: '', text: p[5], via: 'pixel' });
    } else if (p.length === 4) { // pre-chat format: session, cwd, flags, text
      jobs.push({ session: p[0], chat: '', id: headerId, cwd: p[1], ...parseFlags(p[2]), text: p[3], via: 'pixel' });
    }
  }
  return jobs;
}

// The reload path: the addon's SavedVariables file holds an `outbox` table with
// hex-encoded text and cwd. Returns null when there is no complete outbox.
function parseOutbox(src) {
  const block = String(src || '').match(/\["outbox"\]\s*=\s*\{([^}]*)\}/);
  if (!block) return null;
  const b = block[1];
  const id = Number((b.match(/\["id"\]\s*=\s*(\d+)/) || [])[1]);
  if (!id) return null;
  const text = fromHex((b.match(/\["text"\]\s*=\s*"([0-9a-fA-F]*)"/) || [])[1]);
  const cwd = fromHex((b.match(/\["cwd"\]\s*=\s*"([0-9a-fA-F]*)"/) || [])[1]);
  const session = (b.match(/\["session"\]\s*=\s*"([0-9a-zA-Z]*)"/) || [])[1] || '';
  const chat = (b.match(/\["chat"\]\s*=\s*"([0-9a-zA-Z]*)"/) || [])[1] || '';
  const newSession = /\["newSession"\]\s*=\s*true/.test(b);
  const job = { id, session, chat, text, cwd, newSession, via: 'reload' };
  const ctx = b.match(/\["ctx"\]\s*=\s*"([0-9a-fA-F]*)"/);
  if (ctx) job.ctx = fromHex(ctx[1]);
  const agent = b.match(/\["agent"\]\s*=\s*"([0-9a-zA-Z_-]*)"/);
  if (agent && agent[1]) job.agent = agent[1].toLowerCase();
  const allow = b.match(/\["allow"\]\s*=\s*"([0-9a-fA-F]*)"/);
  if (allow && allow[1]) job.allow = fromHex(allow[1]).split('\x1F').filter(Boolean);
  return job;
}

// ---------------------------------------------------------------------------
// System prompt: reply format, game context, primer
// ---------------------------------------------------------------------------

// What the agent is told on every run. First how the reply is shown: the full
// reply goes to the addon's window and only its closing "TL;DR:" block is
// printed in the game chat, so every reply must end with one. Then, while the
// addon has sent a context (the player's character, location and so on; see
// GameContext in WoWAI.lua), that context plus the addon/macro primer
// (docs/WOW-ADDON-PRIMER.md) so it can write for this client whatever folder
// the chat works in. Empty context = neither is appended, so a bridge used for
// unrelated projects, or an addon with `/wow-ai context off`, only gets the
// reply-format rule. Claude and Grok take this as a system prompt; for Codex,
// agents.js puts it at the top of the prompt.
const SUMMARY_MARKER = 'TL;DR:';
const REPLY_FORMAT = [
  'The user is talking to you from inside World of Warcraft through the wow-ai addon. They type in a small in-game window and your reply is shown there as plain text (markdown is not rendered), so keep replies compact and formatting simple.',
  '',
  `Only a short summary of each reply is printed into the game chat, where the user actually sees it while playing; the full reply is only visible if they open the addon window. So end EVERY reply with a final block that starts with "${SUMMARY_MARKER}" on its own line and holds one or two short lines (under about 200 characters in total) saying what you did or what the answer is, and what you need from the user if anything. Write it as plain text. Do not repeat the summary elsewhere, and put nothing after it.`,
];

// How the agent draws on the world map (see "Map layers" below and docs/MAP.md).
// Sent with the game context, since marks only make sense in a game chat.
const MAP_HINT = [
  'You can mark the player\'s world map. Either append commands to the file named by the WOW_AI_MAP_FILE environment variable (one JSON object per line) or, for a few marks, end the reply with a fenced block whose language tag is wowmap containing them. Commands:',
  '{"op":"set","layer":"<name>","title":"<shown title>","ordered":true,"loop":false,"points":[{"m":<uiMapID>,"x":<0-100>,"y":<0-100>,"label":"<text>","kind":"quest"}]}  replaces that layer; "ordered" draws a numbered route with a navigator, "loop" closes it.',
  '{"op":"clear","layer":"<name>"} removes a layer; {"op":"clearall"} removes them all.',
  'A point that is a quest step can add "q":<quest id> and "step":"accept"|"objective"|"turnin" (plus "obj":"<the objective\'s item or creature name>" for objectives): the navigator then moves on by itself when the game reports that step done.',
  'x and y are map percent on the map with that uiMapID (the context gives the player\'s current one). kind is one of ore, herb, quest, turnin, kill, loot, object, explore, npc, trainer, vendor, dungeon, flight, poi. Only mark the map when asked for a route, marks or locations; say in the reply what you drew.',
];

// How the agent hands the player a ready-made macro (see "Macros" below).
const MACRO_HINT = [
  'When the player asks for a macro, write each one as a fenced block whose language tag is wowmacro followed by the macro name (at most 16 characters), and the macro text inside, one command per line, at most 255 characters in total. Start it with #showtooltip when it casts something. After the name you may add icon=<icon fileID or file name, e.g. Ability_Warrior_Charge> and scope=character for a per-character macro (the default is an account macro). Example:',
  '```wowmacro Charge',
  '#showtooltip',
  '/cast [combat] Intercept; Charge',
  '```',
  'The addon shows the player a button that creates the macro (or updates one with the same name) and puts it on their cursor. Explain outside the block what it does. Avoid /run and /script unless asked; the player is warned about them.',
];

function systemPrompt(ctx, primer) {
  const lines = [...REPLY_FORMAT];
  const text = String(ctx || '').trim();
  if (text) {
    lines.push('',
      'Their in-game situation when the message was written, as reported by the addon:',
      text,
      '',
      'Use this when the request is about the game or the character (questions, macros, addon code, gear advice); ignore it when the task is unrelated. Items, spells or quests the player shift-clicked into a message appear as [Name] in the text, with their tooltip in a "Linked from the game" block at the end of the message.',
      '',
      ...MAP_HINT,
      '',
      ...MACRO_HINT,
      '',
      ...QUEST_HINT);
  }
  const ref = text ? String(primer || '').trim() : '';
  if (ref) {
    lines.push('', 'Reference for writing addons and macros for this client. Follow it when the task is about WoW, and check anything it marks as uncertain against the Blizzard UI source it names:', '', ref);
  }
  return lines.join('\n');
}

// Pull the game-chat summary out of a reply: whatever follows the last "TL;DR:"
// marker that starts a line (bold or a heading around it is tolerated:
// "**TL;DR:**", "## TL;DR"). The text for the window stays the whole reply, so
// nothing the agent wrote is lost however the addon cuts the echo; without a
// marker the summary is empty and the addon falls back to the reply's first
// lines.
const MARKER_RE = /(?:^|\n)[ \t]*(?:#+[ \t]*)?(?:\*\*|__)?[ \t]*TL;?DR[ \t]*:?[ \t]*(?:\*\*|__)?[ \t]*:?[ \t]*/gi;
function splitSummary(text) {
  const full = String(text || '').trim();
  const last = [...full.matchAll(MARKER_RE)].pop();
  const summary = last ? full.slice(last.index + last[0].length).trim() : '';
  return { text: full, summary };
}

// ---------------------------------------------------------------------------
// Permissions and progress
// ---------------------------------------------------------------------------

// Turn a permission denial (Claude's shape: tool_name, tool_input) into an
// allowlist rule the user can accept. Rules are in Claude Code's syntax for
// every agent; agents.js translates where an agent's own syntax differs.
function ruleFor(d) {
  const name = d.tool_name || 'Unknown';
  if (name === 'Bash') {
    const cmd = String((d.tool_input && d.tool_input.command) || '').trim();
    const word = cmd.split(/\s+/)[0];
    if (word && /^[\w.\-]+$/.test(word)) return `Bash(${word}:*)`;
    return 'Bash';
  }
  return name;
}

// One progress line per Claude tool call, as shown in the game's "working"
// bubble (Codex and Grok have their own in agents.js).
function describeToolUse(block) {
  const inp = block.input || {};
  switch (block.name) {
    case 'Bash': return `$ ${String(inp.command || '').split('\n')[0].slice(0, 110)}`;
    case 'Read': return `read ${baseName(inp.file_path)}`;
    case 'Edit': return `edit ${baseName(inp.file_path)}`;
    case 'Write': return `write ${baseName(inp.file_path)}`;
    case 'Grep': return `grep ${inp.pattern || ''}`;
    case 'Glob': return `glob ${inp.pattern || ''}`;
    case 'Agent': return `agent: ${inp.description || ''}`;
    case 'WebSearch': return `search: ${inp.query || ''}`;
    case 'WebFetch': return `fetch ${inp.url || ''}`;
    default: return block.name;
  }
}

// ---------------------------------------------------------------------------
// Out: what the game reads
// ---------------------------------------------------------------------------

// Escape for a double-quoted Lua 5.1 string literal.
function luaStr(s) {
  return '"' + String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '')
    .replace(/\n/g, '\\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, c => '\\' + String(c.charCodeAt(0)).padStart(3, '0'))
    + '"';
}

// The slot file / Inbox.lua body: the latest record of every chat, the bridge's
// clock, default folder and default agent (plus the agents it knows), and
// (right after a saved-data reset) a restore bundle.
function luaTable(globalName, records, opts = {}) {
  const now = opts.now || Date.now();
  const agents = Array.isArray(opts.agents) ? opts.agents : [];
  const lines = [
    '-- Written by the wow-ai bridge (bridge/bridge.js). Do not edit by hand.',
    `${globalName} = {`,
    `\tts = ${luaStr(new Date(now).toISOString())},`,
    `\tnow = ${Math.floor(now / 1000)},`,
    `\tcwd = ${luaStr(opts.cwd || '')},`,
    `\tagent = ${luaStr(opts.agent || '')},`,
    `\tagents = { ${agents.map(luaStr).join(', ')} },`,
    '\treplies = {',
  ];
  for (const r of records) {
    lines.push('\t\t{');
    lines.push(`\t\t\tchat = ${luaStr(r.chat || '')},`);
    lines.push(`\t\t\tid = ${Number(r.id) || 0},`);
    lines.push(`\t\t\tstatus = ${luaStr(r.status)},`);
    lines.push(`\t\t\ttext = ${luaStr(r.text)},`);
    lines.push(`\t\t\tcwd = ${luaStr(r.cwd || '')},`);
    lines.push(`\t\t\tsession = ${luaStr(r.session || '')},`);
    lines.push(`\t\t\tagent = ${luaStr(r.agent || '')},`);
    if (r.summary) lines.push(`\t\t\tsummary = ${luaStr(r.summary)},`);
    if (Array.isArray(r.denied) && r.denied.length) {
      lines.push(`\t\t\tdenied = { ${r.denied.map(luaStr).join(', ')} },`);
    }
    if (Array.isArray(r.macros) && r.macros.length) lines.push(luaMacros(r.macros));
    lines.push('\t\t},');
  }
  lines.push('\t},');
  if (opts.map) lines.push(luaMap(opts.map));
  const restore = opts.restore;
  if (restore) {
    lines.push('\trestore = {', `\t\ttoken = ${luaStr(restore.token)},`, '\t\tchats = {');
    for (const c of restore.chats) {
      lines.push('\t\t\t{', `\t\t\t\tid = ${luaStr(c.id)},`, `\t\t\t\tname = ${luaStr(c.name)},`, `\t\t\t\tcwd = ${luaStr(c.cwd)},`, '\t\t\t\tmessages = {');
      for (const m of c.messages) {
        lines.push(`\t\t\t\t\t{ role = ${luaStr(m.role)}, id = ${Number(m.id) || 0}, t = ${Number(m.t) || 0}, agent = ${luaStr(m.agent || '')}, text = ${luaStr(m.text)} },`);
      }
      lines.push('\t\t\t\t},', '\t\t\t},');
    }
    lines.push('\t\t},', '\t},');
  }
  lines.push('}', '');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Map layers
// ---------------------------------------------------------------------------
//
// The agent marks the in-game map by writing commands, one JSON object per line,
// to the file named by WOW_AI_MAP_FILE in its environment (a tool of its own can
// do that), or with a ```wowmap fenced block in its reply for a few hand-made marks.
// The system prompt (MAP_HINT) tells it so.
// The bridge owns the resulting layers (state.json) and ships the whole set,
// versioned, in the slot files; the addon replaces its copy when the version is
// newer. So a mark is never applied twice, and a client that lost its saved data
// gets everything back on its next hello.
//
//   {"op":"set","layer":"mining","title":"Copper loop","ordered":true,"loop":true,
//    "points":[{"m":1432,"x":41.5,"y":47.8,"label":"1. Copper Vein","kind":"ore"}]}
//   {"op":"clear","layer":"mining"}    {"op":"clearall"}

const MAP_STEPS = new Set(['accept', 'objective', 'turnin']);
const MAP_KINDS = new Set(['ore', 'herb', 'quest', 'turnin', 'kill', 'loot', 'object', 'explore', 'npc', 'trainer', 'vendor', 'dungeon', 'flight', 'poi']);
const MAP_LIMITS = { layers: 12, pointsPerLayer: 400, totalPoints: 1500, label: 80, title: 80 };

function cleanText(s, max) {
  return String(s ?? '').replace(/[\x00-\x1f\x7f|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// One command, sanitized, or null (with the reason in `why`).
function validateMapCommand(c, why = []) {
  if (!c || typeof c !== 'object') { why.push('not an object'); return null; }
  if (c.op === 'clearall') return { op: 'clearall' };
  const layer = String(c.layer ?? '');
  if (!/^[A-Za-z0-9_.-]{1,32}$/.test(layer)) { why.push(`bad layer name "${layer.slice(0, 40)}"`); return null; }
  if (c.op === 'clear') return { op: 'clear', layer };
  if (c.op !== 'set') { why.push(`unknown op "${String(c.op).slice(0, 20)}"`); return null; }
  if (!Array.isArray(c.points)) { why.push(`layer ${layer}: points must be an array`); return null; }
  const points = [];
  for (const p of c.points.slice(0, MAP_LIMITS.pointsPerLayer)) {
    const m = Number(p && p.m), x = Number(p && p.x), y = Number(p && p.y);
    if (!Number.isInteger(m) || m <= 0 || m > 99999 || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    const point = {
      m, x: Math.round(Math.min(100, Math.max(0, x)) * 100) / 100, y: Math.round(Math.min(100, Math.max(0, y)) * 100) / 100,
      label: cleanText(p.label, MAP_LIMITS.label), kind: MAP_KINDS.has(p.kind) ? p.kind : 'poi',
    };
    // A quest step: the navigator moves on when the game says it's done.
    const q = Number(p.q);
    if (Number.isInteger(q) && q > 0 && q < 1e7 && MAP_STEPS.has(p.step)) {
      point.q = q;
      point.step = p.step;
      if (p.step === 'objective' && p.obj) point.obj = cleanText(p.obj, 40);
    }
    points.push(point);
  }
  if (c.points.length > MAP_LIMITS.pointsPerLayer) why.push(`layer ${layer}: kept the first ${MAP_LIMITS.pointsPerLayer} points`);
  if (points.length < c.points.slice(0, MAP_LIMITS.pointsPerLayer).length) why.push(`layer ${layer}: dropped invalid points`);
  if (!points.length) { why.push(`layer ${layer}: no valid points`); return null; }
  return { op: 'set', layer, title: cleanText(c.title || layer, MAP_LIMITS.title), ordered: !!c.ordered, loop: !!c.loop, points };
}

function newMap(epoch) {
  return { epoch: epoch || Math.random().toString(36).slice(2, 10), version: 0, layers: {} };
}

// Apply commands in order. Returns { changed, notes } and mutates `map`.
function applyMapCommands(map, cmds, now = Date.now()) {
  const notes = [];
  let changed = false;
  for (const raw of cmds || []) {
    const why = [];
    const c = validateMapCommand(raw, why);
    notes.push(...why);
    if (!c) continue;
    if (c.op === 'clearall') {
      if (Object.keys(map.layers).length) { map.layers = {}; changed = true; }
      notes.push('cleared all layers');
    } else if (c.op === 'clear') {
      if (map.layers[c.layer]) { delete map.layers[c.layer]; changed = true; notes.push(`cleared layer ${c.layer}`); }
    } else {
      map.layers[c.layer] = { title: c.title, ordered: c.ordered, loop: c.loop, points: c.points, t: now };
      changed = true;
      notes.push(`layer ${c.layer}: ${c.points.length} point(s)`);
    }
  }
  // Keep within budget: drop the oldest layers first.
  const total = () => Object.values(map.layers).reduce((s, l) => s + l.points.length, 0);
  const names = () => Object.keys(map.layers).sort((a, b) => map.layers[a].t - map.layers[b].t);
  while (Object.keys(map.layers).length > MAP_LIMITS.layers || total() > MAP_LIMITS.totalPoints) {
    const old = names()[0];
    delete map.layers[old];
    notes.push(`dropped old layer ${old} (map full)`);
    changed = true;
  }
  if (changed) map.version = (map.version || 0) + 1;
  return { changed, notes };
}

// Pull ```wowmap blocks out of a reply: a JSON object, an array, or one object per line.
function extractMapBlocks(text) {
  const cmds = [], errors = [];
  const stripped = String(text ?? '').replace(/```wowmap[^\n]*\n([\s\S]*?)```/g, (_, body) => {
    const src = body.trim();
    try {
      const v = JSON.parse(src);
      cmds.push(...(Array.isArray(v) ? v : [v]));
    } catch {
      for (const line of src.split('\n')) {
        if (!line.trim()) continue;
        try { cmds.push(JSON.parse(line)); } catch { errors.push('unreadable wowmap line: ' + line.trim().slice(0, 60)); }
      }
    }
    return '';
  }).replace(/\n{3,}/g, '\n\n').trim();
  return { text: stripped, cmds, errors };
}

// Commands the agent's tools appended to WOW_AI_MAP_FILE (one JSON per line).
function parseMapFile(src) {
  const cmds = [], errors = [];
  for (const line of String(src || '').split('\n')) {
    if (!line.trim()) continue;
    try { cmds.push(JSON.parse(line)); } catch { errors.push('unreadable map file line'); }
  }
  return { cmds, errors };
}

function luaMap(map) {
  const lines = ['\tmap = {', `\t\tepoch = ${luaStr(map.epoch)},`, `\t\tversion = ${Number(map.version) || 0},`, '\t\tlayers = {'];
  for (const [name, l] of Object.entries(map.layers || {})) {
    lines.push(`\t\t\t{ name = ${luaStr(name)}, title = ${luaStr(l.title)}, ordered = ${l.ordered ? 'true' : 'false'}, loop = ${l.loop ? 'true' : 'false'}, points = {`);
    for (const p of l.points) {
      const step = p.q ? `, q = ${p.q}, step = ${luaStr(p.step)}${p.obj ? `, obj = ${luaStr(p.obj)}` : ''}` : '';
      lines.push(`\t\t\t\t{ ${p.m}, ${p.x}, ${p.y}, ${luaStr(p.label)}, ${luaStr(p.kind)}${step} },`);
    }
    lines.push('\t\t\t} },');
  }
  lines.push('\t\t},', '\t},');
  return lines.join('\n');
}

// A valid, silent 10 ms WAV. An empty file "won't play"; this one will.
const SILENT_WAV = (() => {
  const rate = 8000, samples = 80;
  const b = Buffer.alloc(44 + samples);
  b.write('RIFF', 0); b.writeUInt32LE(36 + samples, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34);
  b.write('data', 36); b.writeUInt32LE(samples, 40);
  b.fill(128, 44);
  return b;
})();

// ---------------------------------------------------------------------------
// Macros
// ---------------------------------------------------------------------------
//
// A reply can carry ready-made macros in ```wowmacro <Name> [icon=..] [scope=character]
// blocks. The bridge validates them and sends them as `macros` on the reply record;
// the addon offers a button that creates or updates each one. The block itself is
// replaced by a readable plain-text version, since the window doesn't render markdown.

const MACRO_LIMITS = { name: 16, body: 255, perReply: 6 };
const MACRO_DEFAULT_ICON = 134400; // the question mark: with #showtooltip the game shows the spell's icon
const MACRO_RE = /```wowmacro([^\n]*)\n([\s\S]*?)```/g;
const RISKY_MACRO_RE = /^\s*\/(run|script|click|console|dump)\b/im;

// The first `max` characters (not bytes) of s, never splitting a character.
const firstChars = (s, max) => Array.from(s).slice(0, max).join('');

function parseMacroHeader(rest) {
  let name = String(rest || '');
  let icon = null, scope = 'account';
  name = name.replace(/\bicon\s*=\s*("?)([^\s"]+)\1/i, (_, q, v) => { icon = v; return ' '; });
  name = name.replace(/\bscope\s*=\s*("?)(\w+)\1/i, (_, q, v) => { scope = /^char/i.test(v) ? 'character' : 'account'; return ' '; });
  name = name.replace(/\bname\s*=\s*"([^"]*)"/i, (_, v) => ` ${v} `);
  return { name, icon, scope };
}

// { text, macros, notes }: text with each block made readable; invalid macros
// stay visible but get no button, with the reason in notes.
function extractMacros(text) {
  const macros = [], notes = [];
  const out = String(text ?? '').replace(MACRO_RE, (_, header, rawBody) => {
    const h = parseMacroHeader(header);
    // Blizzard strips double quotes from macro names; | would start an escape sequence.
    const name = firstChars(h.name.replace(/["|\x00-\x1f\x7f]/g, '').replace(/\s+/g, ' ').trim(), MACRO_LIMITS.name);
    const body = String(rawBody).replace(/\r/g, '').split('\n').map(l => l.replace(/\s+$/, '')).join('\n').replace(/^\n+|\n+$/g, '');
    const readable = `Macro "${name || '?'}":\n${body}`;
    const bytes = Buffer.byteLength(body, 'utf8');
    if (!name) { notes.push('a macro without a name was not offered as a button'); return readable; }
    if (!body) { notes.push(`macro "${name}" is empty`); return readable; }
    if (bytes > MACRO_LIMITS.body) { notes.push(`macro "${name}" is ${bytes} bytes, over the game's ${MACRO_LIMITS.body}; not offered as a button`); return readable; }
    if (macros.length >= MACRO_LIMITS.perReply) { notes.push(`only the first ${MACRO_LIMITS.perReply} macros get a button`); return readable; }
    let icon = null;
    if (h.icon && /^\d{1,9}$/.test(h.icon)) icon = Number(h.icon);
    else if (h.icon && /^[A-Za-z0-9_]{1,64}$/.test(h.icon)) icon = h.icon;
    macros.push({ name, body, icon, char: h.scope === 'character', risky: RISKY_MACRO_RE.test(body) });
    return readable;
  });
  return { text: out, macros, notes: [...new Set(notes)] };
}

// The summary is printed into the game chat: macro blocks have no place there.
function stripMacroBlocks(text) {
  return String(text ?? '').replace(MACRO_RE, '').replace(/\n{3,}/g, '\n\n').trim();
}

function luaMacros(macros) {
  return `\t\t\tmacros = { ${macros.map(m => `{ name = ${luaStr(m.name)}, body = ${luaStr(m.body)}, icon = ${m.icon == null ? 'nil' : typeof m.icon === 'number' ? m.icon : luaStr(m.icon)}, char = ${m.char ? 'true' : 'false'}, risky = ${m.risky ? 'true' : 'false'} }`).join(', ')} },`;
}

// ---------------------------------------------------------------------------
// Quest state
// ---------------------------------------------------------------------------
//
// The addon puts the quest log (each objective's progress) and the quests turned
// in since login into the game context, and the character's full completed set
// into its saved data (base-36 ranges, written on logout and /reload). The bridge
// joins them into one game-state file for the agent's tools.

const QUEST_HINT = [
  'The "Quests" line of the context is the live quest log: quest id, then each objective as "<name> have/need" or "done"; "*" means ready to turn in, "!" means failed (abandon and take it again). The full game state, including every quest this character has completed, is the JSON file named by the WOW_AI_GAME_STATE environment variable: plan leveling from it and never send the player to pick up or do a quest that is completed or already in their log.',
];

// "1-5,7,9-c" (base 36) -> [1,2,3,4,5,7,9,10,11,12]
function decodeRanges(s) {
  const out = [];
  for (const part of String(s || '').split(',')) {
    if (!part) continue;
    const [a, b] = part.split('-').map(x => parseInt(x, 36));
    if (!Number.isFinite(a)) continue;
    const end = Number.isFinite(b) ? b : a;
    if (end - a > 100000) continue; // corrupt range: skip rather than blow up
    for (let i = a; i <= end; i++) out.push(i);
  }
  return out;
}

function encodeRanges(ids) {
  const s = [...new Set(ids)].sort((x, y) => x - y);
  const parts = [];
  for (let i = 0; i < s.length;) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    parts.push(j === i ? s[i].toString(36) : `${s[i].toString(36)}-${s[j].toString(36)}`);
    i = j + 1;
  }
  return parts.join(',');
}

// The addon's saved data holds questsDone = { ["Name-Realm"] = { ids = "...", n = 57, at = <epoch> } }.
function parseQuestsDone(src) {
  const text = String(src || '');
  const start = text.search(/\["questsDone"\]\s*=\s*\{/);
  if (start < 0) return {};
  let i = text.indexOf('{', start), depth = 0, end = -1;
  for (; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) { end = i; break; }
  }
  const block = text.slice(text.indexOf('{', start) + 1, end < 0 ? text.length : end);
  const out = {};
  for (const m of block.matchAll(/\["((?:[^"\\]|\\.)*)"\]\s*=\s*\{([^{}]*)\}/g)) {
    const body = m[2];
    const ids = (body.match(/\["ids"\]\s*=\s*"([0-9a-z,-]*)"/) || [])[1];
    if (ids === undefined) continue;
    out[m[1].replace(/\\(.)/g, '$1')] = {
      ids: decodeRanges(ids),
      at: Number((body.match(/\["at"\]\s*=\s*(\d+)/) || [])[1]) || 0,
    };
  }
  return out;
}

const RACE_NAMES = ['Night Elf', 'Human', 'Dwarf', 'Gnome', 'Orc', 'Undead', 'Tauren', 'Troll', 'Blood Elf', 'Draenei', 'Goblin', 'Worgen', 'Pandaren'];

// Everything the context says about the character and their quests.
function parseGameContext(ctx) {
  const text = String(ctx || '');
  const line = re => { const m = text.match(re); return m ? m : null; };
  const st = { character: null, level: null, race: null, class: null, faction: null, zone: null, position: null, professions: {}, quests: null, turnedIn: [], historyMissing: /Completed quest history: not on disk/.test(text) };
  const ch = line(/^Character: (.+?)(?: on (.+?))?, level (\d+) (.+?)(?: \((\w+)\))?(?:, guild <.*>)?$/m);
  if (ch) {
    st.character = { name: ch[1], realm: ch[2] || '', key: `${ch[1]}-${ch[2] || ''}` };
    st.level = Number(ch[3]);
    const rc = ch[4];
    const race = RACE_NAMES.find(r => rc.startsWith(r + ' '));
    st.race = race || rc.split(' ')[0];
    st.class = race ? rc.slice(race.length + 1) : rc.split(' ').slice(1).join(' ');
    st.faction = ch[5] || null;
  }
  const xp = line(/XP: (\d+)\/(\d+)/);
  if (xp) st.xp = { have: Number(xp[1]), need: Number(xp[2]) };
  const loc = line(/^Location: (.+)$/m);
  if (loc) st.zone = loc[1].split(' - ')[0];
  const pos = line(/^Position: ([\d.]+), ([\d.]+)(?: on .+?)? \(map (\d+)\)$/m);
  if (pos) st.position = { map: Number(pos[3]), x: Number(pos[1]), y: Number(pos[2]) };
  const prof = line(/^Professions: (.+)$/m);
  if (prof) for (const p of prof[1].split(', ')) {
    const m = p.match(/^(.+?) (\d+)(?:\/(\d+))?$/);
    if (m) st.professions[m[1]] = Number(m[2]);
  }
  const q = line(/^Quests \([^)]*\): (.+)$/m);
  if (q) {
    st.quests = [];
    if (q[1] !== 'none') for (const e of q[1].split('; ')) {
      const m = e.match(/^(\d+)([*!]?)(?: (.*))?$/);
      if (!m) continue;
      const entry = { id: Number(m[1]), status: m[2] === '*' ? 'complete' : m[2] === '!' ? 'failed' : 'active', objectives: [] };
      for (const o of (m[3] || '').split(', ').filter(Boolean)) {
        const om = o.match(/^(?:(.*?) )?(?:(\d+)\/(\d+)|(done))$/);
        if (!om) continue;
        entry.objectives.push(om[4] ? { name: om[1] || '', done: true } : { name: om[1] || '', have: Number(om[2]), need: Number(om[3]), done: Number(om[2]) >= Number(om[3]) });
      }
      st.quests.push(entry);
    }
  }
  const ti = line(/^Turned in since login: ([\d,]+)$/m);
  if (ti) st.turnedIn = ti[1].split(',').map(Number).filter(Number.isFinite);
  return st;
}

// The file the agent's tools read: the parsed context plus the completed set
// (saved data for this character, joined with what was turned in since login).
function buildGameState(ctx, questsDone, ctxAt) {
  const st = parseGameContext(ctx);
  const saved = st.character && questsDone ? questsDone[st.character.key] : null;
  const completed = new Set([...(saved ? saved.ids : []), ...st.turnedIn]);
  return {
    at: ctxAt ? new Date(ctxAt).toISOString() : null,
    ...st,
    completed: {
      known: !!saved,
      savedAt: saved && saved.at ? new Date(saved.at * 1000).toISOString() : null,
      count: completed.size,
      ids: [...completed].sort((a, b) => a - b),
    },
  };
}

module.exports = {
  fromHex, pad3, slotNumber, chatKey, sessKey,
  alreadyHandled, markHandled, pruneStale, MONTH_MS,
  resolveCwd, sameFolder, baseName,
  parseFlags, jobsFromStrip, parseOutbox, systemPrompt, splitSummary,
  ruleFor, describeToolUse,
  luaStr, luaTable, SILENT_WAV,
  MAP_LIMITS, validateMapCommand, newMap, applyMapCommands, extractMapBlocks, parseMapFile, luaMap,
  MACRO_LIMITS, MACRO_DEFAULT_ICON, extractMacros, stripMacroBlocks, luaMacros,
  decodeRanges, encodeRanges, parseQuestsDone, parseGameContext, buildGameState,
};
