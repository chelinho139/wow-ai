'use strict';
// The bridge's pure protocol code: strip records in, Lua slot files out, and the
// small rules around folders, permissions and dedup. No I/O, no config, no
// process state, so tests/bridge_test.js can exercise it directly.

const crypto = require('crypto');
const os = require('os');
const path = require('path');

// The addon's name, as the game sees it: its folder under Interface/AddOns, its
// .toc, its SavedVariables file (<ADDON>.lua) and the prefix of its globals.
// The names it had before (wow-claude, then wow-ai) are what setup.js migrates
// from and what an older config.json may still name.
const ADDON = 'ClaudeWoW';
const RUNTIME_ADDON = ADDON + '_Runtime';
const SHIPPED_INBOX_PATH = new RegExp('(^|[\\\\/])' + ADDON + '[\\\\/]Inbox\\.lua$');
const OLD_ADDONS = ['WoWAI', 'WoWClaude']; // newest first
const OLD_ADDON_PATH = new RegExp('(^|[\\\\/])(' + OLD_ADDONS.join('|') + ')([\\\\/]|$)');
const OLD_SAVED_FILE = new RegExp('(' + OLD_ADDONS.join('|') + ')\\.lua$');
const TOC_INTERFACE = '11509, 16001';
const OLD_TOC_INTERFACES = Object.freeze(['16001']);

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

const SIGNAL_CLEAR_AHEAD = 50;
function slotsToClearAhead(id, slots, keepIds = [], ahead = SIGNAL_CLEAR_AHEAD) {
  const reach = Math.min(ahead, Math.floor(slots / 2));
  const keep = new Set(keepIds.filter(Number.isFinite).map(k => slotNumber(k, slots)));
  keep.add(slotNumber(id, slots));
  const out = [];
  for (let j = 1; j <= reach; j++) {
    const s = slotNumber(id + j, slots);
    if (!keep.has(s)) out.push(s);
  }
  return out;
}

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

const RECENT_ACKS_MAX = 24;
const RECENT_ACK_MS = 10 * 60 * 1000;

function noteAck(acks, job, now = Date.now()) {
  const id = Number(job && job.id);
  if (!Number.isInteger(id) || id <= 0) return acks;
  const session = String((job && job.session) || '');
  const kept = acks.filter(a => now - a.at < RECENT_ACK_MS && !(a.id === id && a.session === session));
  return [...kept, { session, id, at: now }].slice(-RECENT_ACKS_MAX);
}

function recentAcks(acks, now = Date.now()) {
  return acks.filter(a => now - a.at < RECENT_ACK_MS);
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
// Context growth
// ---------------------------------------------------------------------------
//
// Every message resumes the chat's agent session, so what the model reads grows
// with every turn and each message costs more than the last (measured: 107k
// tokens after 8 turns, 312k after 213). state.sessionUsage[sessKey] keeps, per
// chat, the tokens its next message will carry (as the agent reported after the
// last run; agents that report nothing keep the last known value), the number
// of runs in the current agent session, and the model's window when known. The
// reply record carries it to the addon as ctx / turns / window.

// Also kept: `since`, when the session started (a new chat or a reset brings
// it back to now, so the footer's elapsed time visibly restarts), and `cost`,
// the API-equivalent price of the session's runs so far (agents.js CLAUDE_RATES;
// a subscription is not billed by the token, so it is shown as a comparison).
// A run whose model has no rate marks the session costUnknown: tokens are still
// shown, the cost is not, rather than guessed.
function noteUsage(state, key, { usage, fresh, agent, startedAt, now = Date.now() } = {}) {
  const all = (state.sessionUsage = state.sessionUsage || {});
  const prev = !fresh && all[key] ? all[key] : null;
  const rec = { turns: (prev ? prev.turns || 0 : 0) + 1, agent: agent || '', at: now, since: prev && prev.since ? prev.since : (startedAt || now) };
  const u = usage && Number.isFinite(usage.context) && usage.context > 0 ? usage : null;
  if (u) {
    rec.context = Math.round(u.context);
    if (Number.isFinite(u.window) && u.window > 0) rec.window = u.window;
    else if (prev && prev.window) rec.window = prev.window;
  } else if (prev && prev.context) {
    rec.context = prev.context;
    if (prev.window) rec.window = prev.window;
  }
  if (prev && prev.cost !== undefined) rec.cost = prev.cost;
  if (usage && Number.isFinite(usage.cost)) rec.cost = usage.costIsSessionTotal ? usage.cost : (rec.cost || 0) + usage.cost;
  if ((usage && usage.costUnknown) || (prev && prev.costUnknown)) rec.costUnknown = true;
  all[key] = rec;
  return rec;
}

// The reply-record fields for a chat's usage, or nothing when there is none.
function usageFields(rec) {
  if (!rec) return {};
  const f = {};
  if (rec.context > 0) f.ctx = rec.context;
  if (rec.turns > 0) f.turns = rec.turns;
  if (rec.window > 0) f.window = rec.window;
  if (rec.since > 0) f.since = Math.floor(rec.since / 1000);
  if (rec.cost !== undefined && !rec.costUnknown) f.cost = Math.round(rec.cost * 10000) / 10000;
  return f;
}

// 186.7k, 9.5k, 850, 1.2M: tokens as Claude Code's status line shows them.
function tokensLabel(n) {
  n = Number(n) || 0;
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) return (n / 1000).toFixed(1) + 'k';
  return (n / 1e6).toFixed(1) + 'M';
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
// chat with that agent instead of the bridge's default (see agents.js),
// "plugin=ask" = the chat is bound to that plugin instead of the bridge's
// default (see plugins.js; only set when the flag is there, so a record from
// an addon that predates plugins parses exactly as before).
const SETTING_RE = /^[A-Za-z0-9._:\[\]-]{1,80}$/;
const RESUME_REF_RE = /^[A-Za-z0-9._-]{1,80}$/;
const ADD_DIRS_MAX = 8;
const PERMISSION_MODES = ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'default', 'dontAsk', 'plan'];

function permissionModeName(raw) {
  const want = String(raw || '').trim().toLowerCase();
  return PERMISSION_MODES.find(m => m.toLowerCase() === want) || '';
}

const PRESENCE_TEST_RESULTS = ['passed', 'failed'];
const LATE_CREATE_RESULTS = ['seen', 'unseen'];

function parseFlags(flags) {
  const out = { newSession: false, hello: false, forget: false, context: false, vision: false, allow: [], agent: '' };
  for (const tok of String(flags || '').split(';')) {
    if (tok === 'n') out.newSession = true;
    else if (tok === 'h') out.hello = true;
    else if (tok === 'd') out.forget = true;
    else if (tok === 'c') out.context = true;
    else if (tok === 't') out.title = true;
    else if (tok === 'v') out.vision = true; // attach the screenshot's game view to the run (screenshot transport only)
    else if (tok.startsWith('allow=')) out.allow.push(...tok.slice(6).split(',').map(s => s.trim()).filter(Boolean));
    else if (tok.startsWith('once=')) (out.allowOnce = out.allowOnce || []).push(...tok.slice(5).split(',').map(s => s.trim()).filter(Boolean));
    else if (tok.startsWith('agent=')) out.agent = tok.slice(6).trim().toLowerCase();
    else if (tok.startsWith('cancel=')) { const n = Number(tok.slice(7)); if (Number.isInteger(n) && n > 0) out.cancel = n; }
    else if (tok.startsWith('plugin=')) { const p = tok.slice(7).trim().toLowerCase(); if (p) out.plugin = p; }
    else if (tok.startsWith('kind=')) { const k = tok.slice(5).trim().toLowerCase(); if (/^[a-z][a-z0-9-]*$/.test(k)) out.kind = k; }
    else if (tok.startsWith('model=')) { const v = tok.slice(6).trim(); if (SETTING_RE.test(v)) out.model = v; }
    else if (tok.startsWith('effort=')) { const v = tok.slice(7).trim().toLowerCase(); if (SETTING_RE.test(v)) out.effort = v; }
    else if (tok.startsWith('pm=')) { const v = permissionModeName(tok.slice(3)); if (v) out.permissionMode = v; }
    else if (tok.startsWith('dirs=')) { const dirs = fromHex(tok.slice(5).trim()).split('\x1F').map(s => s.trim()).filter(Boolean).slice(0, ADD_DIRS_MAX); if (dirs.length) out.addDirs = dirs; }
    else if (tok.startsWith('resume=')) { const v = tok.slice(7).trim(); if (RESUME_REF_RE.test(v)) out.resume = v; }
    else if (tok.startsWith('live=')) { const v = fromHex(tok.slice(5).trim()).trim().slice(0, 80); if (v) out.liveTarget = v; }
    // "shot=missing" / "shot=failed": the addon is on the screenshot transport but
    // cannot take the shot (no Screenshot() in this client, or SCREENSHOT_FAILED on
    // every try). The bridge falls back to the pixel transport on it (transportFallback).
    else if (tok.startsWith('shot=')) { const s = tok.slice(5).trim().toLowerCase(); if (FALLBACK_REASONS[s]) out.shot = s; }
    else if (tok.startsWith('pt=')) { const v = tok.slice(3).trim().toLowerCase(); if (PRESENCE_TEST_RESULTS.includes(v)) out.presenceTest = v; }
    else if (tok.startsWith('lc=')) { const v = tok.slice(3).trim().toLowerCase(); if (LATE_CREATE_RESULTS.includes(v)) out.lateCreate = v; }
    else if (tok.startsWith('probe=')) { const v = tok.slice(6).trim().toLowerCase(); if (/^[0-9a-z]{4,16}$/.test(v)) out.probe = v; }
    else if (tok.startsWith('ver=')) { const v = tok.slice(4).trim(); if (SEMVER_RE.test(v)) out.addonVersion = v; }
    else if (tok.startsWith('proto=')) { const v = tok.slice(6).trim(); if (/^\d{1,6}$/.test(v) && Number(v) > 0) out.addonProto = Number(v); }
  }
  return out;
}

const PROTO = 1;
const PROTO_MIN = PROTO;
const PROTO_MAX = PROTO;
const LEGACY_PROTO = 1;
const SEMVER_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:[-+][0-9A-Za-z.-]{1,32})?$/;
const ADDON_VERSIONS_MAX = 8;

function bridgeVersion() {
  try { return require('../package.json').version; } catch { return '0.0.0'; }
}

function bridgeInfo(version = bridgeVersion()) {
  return { version: SEMVER_RE.test(String(version)) ? String(version) : '0.0.0', protoMin: PROTO_MIN, protoMax: PROTO_MAX };
}

function semverTriple(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compareSemver(a, b) {
  const x = semverTriple(a), y = semverTriple(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

function protoRange(bridge) {
  return bridge.protoMin === bridge.protoMax ? String(bridge.protoMin) : `${bridge.protoMin} to ${bridge.protoMax}`;
}

const ADDON_UPDATE_HOW = 'update the addon in the CurseForge app or run claude-wow setup, then restart WoW.';
const BRIDGE_UPDATE_HOW = 'run brew upgrade claude-wow or the installer again, then claude-wow service restart.';

function versionVerdict(addon, bridge = bridgeInfo()) {
  const proto = Number.isInteger(addon && addon.proto) ? addon.proto : LEGACY_PROTO;
  const version = addon && SEMVER_RE.test(String(addon.version || '')) ? String(addon.version) : '';
  const mine = `${version || 'version unknown'}, protocol ${proto}`;
  const theirs = `${bridge.version}, protocol ${protoRange(bridge)}`;
  if (proto < bridge.protoMin) {
    return { verdict: 'update-addon', refuse: true, text: `This addon (${mine}) is too old for the bridge (${theirs}). The bridge refuses messages until you update the addon: ${ADDON_UPDATE_HOW}` };
  }
  if (proto > bridge.protoMax) {
    return { verdict: 'update-bridge', refuse: true, text: `The bridge (${theirs}) is too old for this addon (${mine}). The bridge refuses messages until you update it: ${BRIDGE_UPDATE_HOW}` };
  }
  if (!version) return { verdict: 'unknown', refuse: false, text: '' };
  if (version === bridge.version) return { verdict: 'equal', refuse: false, text: '' };
  const order = compareSemver(version, bridge.version);
  if (order === -1) return { verdict: 'addon-older', refuse: false, text: `This addon (${version}) is older than the bridge (${bridge.version}). They still work together; update the addon when you can.` };
  if (order === 1) return { verdict: 'bridge-older', refuse: false, text: `The bridge (${bridge.version}) is older than this addon (${version}). They still work together; update the bridge when you can.` };
  return { verdict: 'differs', refuse: false, text: `This addon (${version}) and the bridge (${bridge.version}) are different builds. They still work together.` };
}

function noteAddonVersion(state, job, bridge = bridgeInfo(), now = Date.now()) {
  const all = (state.addons = state.addons && typeof state.addons === 'object' ? state.addons : {});
  const addon = { version: job.addonVersion || '', proto: Number.isInteger(job.addonProto) ? job.addonProto : null };
  const v = versionVerdict(addon, bridge);
  const key = String(job.session || '');
  const prev = all[key];
  all[key] = { ...addon, bridge: bridge.version, protoMin: bridge.protoMin, protoMax: bridge.protoMax, verdict: v.verdict, at: now };
  const keep = Object.entries(all).sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).slice(0, ADDON_VERSIONS_MAX).map(([k]) => k);
  for (const k of Object.keys(all)) if (!keep.includes(k)) delete all[k];
  return { ...v, changed: !prev || prev.verdict !== v.verdict || prev.version !== addon.version || prev.bridge !== bridge.version };
}

function addonRefusal(state, job, bridge = bridgeInfo()) {
  const rec = state.addons && state.addons[String(job.session || '')];
  if (!rec) return '';
  const v = versionVerdict(rec, bridge);
  return v.refuse ? v.text : '';
}

function latestAddonVersion(state) {
  const recs = Object.values((state && state.addons) || {}).filter(r => r && typeof r === 'object');
  return recs.sort((a, b) => (b.at || 0) - (a.at || 0))[0] || null;
}

function versionsSummary(state) {
  const r = latestAddonVersion(state);
  if (!r) return 'no hello with versions yet';
  const proto = Number.isInteger(r.proto) ? r.proto : `${LEGACY_PROTO} assumed`;
  const range = Number.isInteger(r.protoMin) && Number.isInteger(r.protoMax) ? protoRange(r) : '?';
  return `addon ${r.version || 'unknown'} (protocol ${proto}), bridge ${r.bridge || 'unknown'} (protocol ${range}): ${r.verdict || 'unknown'}, at the last hello ${new Date(r.at || 0).toISOString()}`;
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
  const plugin = b.match(/\["plugin"\]\s*=\s*"([0-9a-zA-Z_-]*)"/);
  if (plugin && plugin[1]) job.plugin = plugin[1].toLowerCase();
  const allow = b.match(/\["allow"\]\s*=\s*"([0-9a-fA-F]*)"/);
  if (allow && allow[1]) job.allow = fromHex(allow[1]).split('\x1F').filter(Boolean);
  const allowOnce = b.match(/\["allowOnce"\]\s*=\s*"([0-9a-fA-F]*)"/);
  if (allowOnce && allowOnce[1]) job.allowOnce = fromHex(allowOnce[1]).split('\x1F').filter(Boolean);
  const shot = b.match(/\["shot"\]\s*=\s*"([a-z]*)"/);
  if (shot && FALLBACK_REASONS[shot[1]]) job.shot = shot[1];
  const opts = b.match(/\["opts"\]\s*=\s*"([0-9a-fA-F]*)"/);
  if (opts && opts[1]) {
    const f = parseFlags(fromHex(opts[1]));
    for (const k of ['model', 'effort', 'permissionMode', 'addDirs', 'resume', 'liveTarget']) if (f[k] !== undefined) job[k] = f[k];
  }
  return job;
}

function withRunOnlyRules(agentCfg, rules) {
  const extra = Array.isArray(rules) ? rules.filter(Boolean) : [];
  if (!extra.length) return agentCfg;
  const current = Array.isArray(agentCfg.allowedTools) ? agentCfg.allowedTools : [];
  return { ...agentCfg, allowedTools: [...new Set([...current, ...extra])] };
}

function withRunDeniedRules(agentCfg, rules) {
  const extra = Array.isArray(rules) ? rules.filter(Boolean) : [];
  if (!extra.length) return agentCfg;
  const current = Array.isArray(agentCfg.deniedTools) ? agentCfg.deniedTools : [];
  return { ...agentCfg, deniedTools: [...new Set([...current, ...extra])] };
}

function absolutePathRule(tool, file) {
  const raw = String(file || '');
  const drive = /^([A-Za-z]):[\\/]/.exec(raw);
  const posix = drive ? `/${drive[1].toLowerCase()}/${raw.slice(3).replace(/\\/g, '/')}` : raw;
  return `${tool}(/${posix.startsWith('/') ? posix : '/' + posix})`;
}

function withoutRules(rules, banned) {
  const blocked = new Set(Array.isArray(banned) ? banned : []);
  return (Array.isArray(rules) ? rules : []).filter(r => !blocked.has(String(r)));
}

// ---------------------------------------------------------------------------
// System prompt (stable) and message prompt (per message)
// ---------------------------------------------------------------------------

// What the agent is told is split in two, by how often it changes:
//
//   systemPrompt(ctx, primer, opts)  the same bytes on every run of a chat:
//     how the reply is shown (the full reply goes to the addon's window and only
//     its closing "TL;DR:" block is printed in the game chat, so every reply
//     must end with one), the plugin's own lines (opts.tools), and, while the
//     addon sends a game context at all, the game rules (what the situation
//     block and the [Name] links are, how to mark the map, how to hand over a
//     macro) and the addon/macro primer (docs/WOW-ADDON-PRIMER.md). The
//     context's presence turns those on; its text is not in here.
//   messagePrompt(text, ctx, opts)   what changes per message: the player's
//     in-game situation as the addon reported it when the message was written
//     (character, zone, coordinates, quest log: coordinates change with every
//     step), the vision paragraph when a screenshot really is attached, and
//     the message itself.
//
// Why: Claude Code records the system prompt on a conversation's first request
// and sends that record as-is on every resume (--system-prompt-snapshot, on by
// default), so a context appended there was frozen at the chat's first message
// and every position or quest change after it never reached the model; and
// prompt caching is prefix-based, so anything that changes between messages
// must sit after everything that does not. Both point the same way: volatile
// text goes in the message, at the end. Claude and Grok take the stable part as
// a system prompt; for Codex and the others agents.js puts it at the top of the
// prompt on a new session. An empty context (a bridge used for unrelated
// projects, or `/claude-wow context off`) leaves only the reply-format rule and
// the plugin's lines, and a message with nothing attached is exactly the text.
const SUMMARY_MARKER = 'TL;DR:';
const REPLY_FORMAT = [
  'The user is talking to you from inside World of Warcraft through the claude-wow addon, usually while playing. They read your reply in a small window, or as one line in the game chat, often mid-fight. Markdown is not rendered.',
  '',
  'Be SHORT. A good reply is one to three lines. Answer first, in the first line. No preamble, no restating the question, no summary of what you are about to say, no offers of further help unless you need a decision from them. Drop pleasantries. Prefer a concrete answer over a menu of options; if you must offer options, at most two.',
  '',
  'Only use a list when the answer really is several items, and then keep each item to one short line. Never use headings. Never use bold for emphasis. Numbers, names and coordinates are what matter; adjectives are not.',
  '',
  `Only the closing summary is printed into the game chat, which is where they will actually see it. End EVERY reply with a final block that starts with "${SUMMARY_MARKER}" on its own line, holding ONE line, under about 140 characters, that stands alone: the answer or what you did, plus what you need from them if anything. Do not repeat it elsewhere and put nothing after it.`,
  '',
  'If the whole answer fits in the summary, let the reply be just that one line and the summary. Length is a cost to them, not a sign of effort.',
];

const PLAYER_VOICE_FORMAT = [
  'The player is talking to you from inside World of Warcraft, usually mid-game. Your reply shows as a whisper in their game chat. Markdown is not rendered.',
  '',
  'Answer like another player whispering back: one line, as few words as possible. all lowercase. no punctuation at all: no periods, commas, colons, quotes, question marks or exclamation marks. Never restate or mention the question. Never say the same thing twice. No summary line, no TL;DR, no greeting, no sign-off, no offer of more help.',
  'Casual player chat is wanted where it fits: lol, kek, lmao, idk, bro, hmm, wdyt, fyi, imo, ngl, tbh, np, ty, gl. Do not force one into every reply.',
  'Numbers stay digits. If you need something from the player, ask it in the same line.',
  'A macro or a map mark keeps the exact format given below and may follow the line.',
];

const LINK_HINT = [
  'Name an item, spell or quest with a token, not with its name: {item:ID}, {spell:ID} or {quest:ID}. The addon turns each token into the real in-game link, with the name and color the client has, and the player can hover or shift-click it, so a wrong ID shows the wrong thing. Do not also write the name next to the token. On both games (Forever and Classic Era), an ID must come from a source that ties it to that exact thing: a "Linked from the game" entry in this chat (item, spell or quest), or a wowdata result whose name is the item you mean. When several wowdata rows share that name, use a token only if the player\'s link or the situation picks out one of them; otherwise name it in plain words. Never use an ID from memory, a website or another game version, and never pick one from a list of bare IDs (the recipe spell IDs of a wowdata result, the quest log line). Without such a source, name the thing in plain words. A quest token shows only for a quest in the player\'s quest log. NPCs, zones and other things have no token: name them in plain words.',
  'For a list, put each item on its own line starting with "- "; the addon draws it as a bullet.',
];

// How the agent draws on the world map (see "Map layers" below and docs/MAP.md).
// Sent with the game context, since marks only make sense in a game chat.
const MAP_HINT = [
  'You can mark the player\'s world map. Either append commands to the file named by the CLAUDE_WOW_MAP_FILE environment variable (one JSON object per line) or, for a few marks, end the reply with a fenced block whose language tag is wowmap containing them. Commands:',
  '{"op":"set","layer":"<name>","title":"<shown title>","ordered":true,"loop":false,"points":[{"m":<uiMapID>,"x":<0-100>,"y":<0-100>,"label":"<text>","kind":"quest"}]}  replaces that layer; "ordered" draws a numbered route with a navigator, "loop" closes it.',
  '{"op":"clear","layer":"<name>"} removes a layer; {"op":"clearall"} removes them all.',
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

// What the agent is told when the player's screen rides along with the message
// (vision, screenshot transport only). Only added when an image really is
// attached, so a run without one is exactly what it was before.
function visionHint(image) {
  const size = image && image.width && image.height ? ` (${image.width}x${image.height}, downscaled)` : '';
  return `A screenshot of the player's screen, taken by the game the moment they sent this message, is attached to the message as an image${size}. It is what the player was looking at: the game world, their UI, any open windows, tooltips, quest text, and the Claude WoW chat window itself; the addon's data strip along the top edge has been cropped off. Use it when the question is about something on screen ("what is this item", "why is this boss killing me", "read this quest") and say what you see when it matters; ignore it when the task is unrelated.`;
}

// What the situation block in a message is (the block itself is built by
// messagePrompt). Sent while the addon sends a context at all.
const SITUATION_RULE = 'A message may open with a block marked as the player\'s in-game situation, reported by the addon the moment they wrote it (not written by them): character, zone, map coordinates, money, professions, quest log. Use it when the request is about the game or the character (questions, macros, addon code, gear advice); ignore it when the task is unrelated. Every message carries a fresh one, so the latest block is where they are now. Items, spells or quests the player shift-clicked into a message appear as [Name] in the text, with their tooltip in a "Linked from the game" block at the end of the message.';

const WHERE_HINT = [
  'The situation block\'s "Game:" line names the client. World of Warcraft: Forever is its own game: its NPCs, quests, drops and spawns can differ from retail and from Classic, so web databases and wikis (Wowhead and the like) are unverified guides there. World of Warcraft Classic (interface 115xx) is Classic Era: Classic web databases describe it, but an item, spell or quest ID still comes only from the sources the link rule below names. The wowdata tools and order tokens use the synced data of the client\'s own game (Forever or Classic Era), never the other one; with no data synced for it, an order with a token is refused. The bridge does not check chat replies.',
  'Coordinates are percent of the map with that uiMapID, 0 to 100, with 0,0 at the top left; give them as "x, y" and mark the spot on the map as well.',
];

// The stable part. `ctx` only decides whether the game rules and the primer are
// in (an addon that sends no context is not a game chat); its text goes in the
// message. Byte-identical from one run of a chat to the next, which is what
// lets it be recorded once (Claude Code) and cached (every agent).
function systemPrompt(ctx, primer, opts) {
  const lines = [...(opts && opts.voice === 'player' ? PLAYER_VOICE_FORMAT : REPLY_FORMAT)];
  const game = !!String(ctx || '').trim();
  const tools = opts && String(opts.tools || '').trim();
  if (tools) lines.push('', tools);
  if (game) lines.push('', SITUATION_RULE, '', ...WHERE_HINT, '', ...LINK_HINT, '', ...MAP_HINT, '', ...MACRO_HINT);
  if (game && opts && Array.isArray(opts.surfaces) && opts.surfaces.includes('ui')) lines.push('', ...WIDGET_HINT);
  const ref = game ? String(primer || '').trim() : '';
  if (ref) {
    lines.push('', 'Reference for writing addons and macros for this client. Follow it when the task is about WoW, and check anything it marks as uncertain against the Blizzard UI source it names:', '', ref);
  }
  return lines.join('\n');
}

const RULES_HASH_LENGTH = 16;
function systemRulesHash(ctx, opts) {
  return crypto.createHash('sha256').update(systemPrompt(ctx, '', opts)).digest('hex').slice(0, RULES_HASH_LENGTH);
}

function rulesChanged(state, key, hash) {
  const before = state.sessionRules && state.sessionRules[key];
  return !!before && before !== hash;
}

function noteRules(state, key, hash) {
  (state.sessionRules = state.sessionRules || {})[key] = hash;
}

// The per-message part: the situation block (when the addon sends a context),
// the vision paragraph (when an image really is attached, opts.image), then the
// player's text. Nothing attached = exactly the text.
const SITUATION_OPEN = '[In-game situation when this message was written, reported by the claude-wow addon, not written by the player]';
const SITUATION_CLOSE = '[End of in-game situation]';
function messagePrompt(text, ctx, opts) {
  const parts = [];
  const situation = String(ctx || '').trim();
  if (situation) parts.push(`${SITUATION_OPEN}\n${situation}\n${SITUATION_CLOSE}`);
  if (opts && opts.image) parts.push(visionHint(opts.image));
  parts.push(String(text || ''));
  return parts.join('\n\n');
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

const FOLDER_RULE_RE = /^AddDir\(([\s\S]+)\)$/;
const OUTSIDE_FOLDERS_RE = /working director/i;
const QUOTED_PATH_RE = /\bin '([^']+)'/;
const FILE_TOOL_PATH_KEYS = ['file_path', 'notebook_path', 'path'];

function folderRule(dir) { return `AddDir(${dir})`; }

function ruleFolder(rule) {
  const m = FOLDER_RULE_RE.exec(String(rule || '').trim());
  return m ? m[1] : '';
}

function splitGrants(rules) {
  const out = { rules: [], dirs: [] };
  for (const r of Array.isArray(rules) ? rules : []) {
    if (!r) continue;
    const dir = ruleFolder(r);
    if (dir) out.dirs.push(dir); else out.rules.push(String(r));
  }
  return out;
}

function pathApi(...paths) {
  if (paths.some(isWindowsAbsolute)) return path.win32;
  if (paths.some(p => String(p || '').startsWith('/'))) return path.posix;
  return path;
}

function insideFolder(p, dir) {
  if (!p || !dir) return false;
  const api = pathApi(p, dir);
  const fold = api === path.win32 ? s => s.toLowerCase() : s => s;
  const rel = api.relative(fold(api.resolve(String(dir))), fold(api.resolve(String(p))));
  return rel === '' || (!rel.startsWith('..') && !api.isAbsolute(rel));
}

function nearestFolder(p, isDir) {
  const api = pathApi(p);
  let dir = api.resolve(String(p));
  if (typeof isDir !== 'function') return api.dirname(dir);
  for (;;) {
    if (isDir(dir)) return dir;
    const up = api.dirname(dir);
    if (up === dir) return dir;
    dir = up;
  }
}

function denialPath(d, message, cwd) {
  const input = (d && d.tool_input) || {};
  const quoted = QUOTED_PATH_RE.exec(String(message || ''));
  let raw = quoted ? quoted[1] : '';
  if (!raw && d && d.tool_name !== 'Bash') raw = FILE_TOOL_PATH_KEYS.map(k => input[k]).find(v => typeof v === 'string' && v) || '';
  if (!raw) return '';
  if (isWindowsAbsolute(raw) || raw.startsWith('/') || path.isAbsolute(raw)) return raw;
  return cwd ? pathApi(cwd).resolve(cwd, raw) : '';
}

function denialWhat(d) {
  const input = (d && d.tool_input) || {};
  const name = (d && d.tool_name) || 'Unknown';
  const detail = input.command || input.file_path || input.notebook_path || input.path || '';
  return name + (detail ? ': ' + String(detail).split('\n')[0].slice(0, 160) : '');
}

function firstSentence(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  const m = /^[\s\S]*?[.!?](?=\s|$)/.exec(s);
  return (m ? m[0] : s).slice(0, 200);
}

function classifyDenial(d, info = {}, opts = {}) {
  const message = String(info.message || '');
  const what = denialWhat(d);
  const outside = info.reasonType === 'workingDir' || OUTSIDE_FOLDERS_RE.test(message);
  if (outside) {
    const p = denialPath(d, message, opts.cwd);
    if (p) {
      const folder = nearestFolder(p, opts.isDir);
      return { kind: 'folder', rule: folderRule(folder), folder, path: p, what, message };
    }
  }
  return { kind: 'rule', rule: ruleFor(d || {}), what, message };
}

function grantsFor(agentCfg, cwd) {
  const rules = Array.isArray(agentCfg && agentCfg.allowedTools) ? agentCfg.allowedTools.filter(Boolean).map(String) : [];
  const dirs = Array.isArray(agentCfg && agentCfg.addDirs) ? agentCfg.addDirs.filter(Boolean).map(String) : [];
  return { rules, dirs: cwd ? [cwd, ...dirs] : dirs };
}

function deniedAgain(entry, granted) {
  if (!entry || !granted) return false;
  if (entry.kind === 'folder') {
    const target = entry.path || entry.folder;
    return (granted.dirs || []).some(dir => insideFolder(target, dir));
  }
  return (granted.rules || []).some(rule => rule === entry.rule || coversMcpTool(rule, entry.rule));
}

const MCP_SERVER_RULE_RE = /^mcp__[^_]+(?:_[^_]+)*$/;

function coversMcpTool(rule, toolRule) {
  return MCP_SERVER_RULE_RE.test(rule) && String(toolRule || '').startsWith(`${rule}__`);
}

function denialNotes(agentName, fresh, again) {
  const who = agentName || 'The agent';
  const notes = [];
  const rules = (fresh || []).filter(e => e.kind !== 'folder');
  const folders = (fresh || []).filter(e => e.kind === 'folder');
  if (rules.length) {
    notes.push(`${who} needed ${rules.length} action(s) that aren't allowed yet:\n  ${rules.map(e => e.what).join('\n  ')}\nUse the Allow button below to permit them and let it continue.`);
  }
  if (folders.length) {
    notes.push(`${who} was blocked outside this chat's folders:\n  ${folders.map(e => `${e.what} (folder ${e.folder})`).join('\n  ')}\nAn allowlist rule cannot open a folder. Allow it below to add the folder to this chat (like /claude --add-dir) and let it continue.`);
  }
  const seen = new Set();
  for (const e of again || []) {
    if (seen.has(e.rule)) continue;
    seen.add(e.rule);
    const why = firstSentence(e.message);
    const granted = e.kind === 'folder' ? `${e.folder} is already one of this chat's folders` : `${e.rule} is already allowed`;
    notes.push(`${who} was blocked again on ${e.what} although ${granted}, so allowing it again would not help${why ? ': ' + why : '.'}`);
  }
  return notes;
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
// clock, default folder, default agent (plus the agents it knows), default
// plugin (plus the plugins it has), the
// outbound transport it listens on ("screenshot": the addon must call
// Screenshot() with the strip up; "pixel": it screen-captures the strip), and
// (right after a saved-data reset) a restore bundle.
//
// "screenshot" is the default: no screen capture, no permissions, no window
// discovery, no python. "pixel" is deprecated and kept only until Screenshot()
// is confirmed on Windows and on Linux under Wine; it is what the bridge falls
// back to when the addon reports that it cannot shoot.
const TRANSPORTS = ['pixel', 'screenshot'];
const DEFAULT_TRANSPORT = 'screenshot';
function transportName(v) {
  const t = String(v || DEFAULT_TRANSPORT).toLowerCase();
  return TRANSPORTS.includes(t) ? t : '';
}

// Which transport a bridge starts on. An explicit capture.mode in config.json
// always wins (a bad one comes back as '' so the caller can refuse it). Without
// one: the pixel transport if a previous run had to fall back to it (state.json
// transportFallback, see transportFallback below; the reason has not gone away
// just because the bridge restarted), else the default.
//   -> { transport, source: 'config' | 'fallback' | 'default', fallback }
function chooseTransport(capture, state) {
  const explicit = capture && capture.mode !== undefined && capture.mode !== null && capture.mode !== '';
  if (explicit) return { transport: transportName(capture.mode), source: 'config', fallback: null };
  const fb = state && state.transportFallback && typeof state.transportFallback === 'object' ? state.transportFallback : null;
  if (fb && FALLBACK_REASONS[fb.reason]) return { transport: 'pixel', source: 'fallback', fallback: fb };
  return { transport: DEFAULT_TRANSPORT, source: 'default', fallback: null };
}

// The addon said the screenshot transport cannot work for it (a "shot=" flag on
// a strip record, or "shot" in the reload outbox). Remember why in state.json,
// so the next start goes straight to the pixel transport, and hand back the
// note that goes into the log and, through the slot files, into the addon's
// /claude-wow diag. Returns null when the bridge is already on pixels for that
// reason (nothing to do); the caller switches transports on a non-null result.
const FALLBACK_REASONS = {
  missing: 'the game client has no Screenshot() function',
  failed: 'the game client reported SCREENSHOT_FAILED on every try',
};
function transportFallback(state, reason, job, now = Date.now()) {
  if (!FALLBACK_REASONS[reason]) return null;
  const cur = state.transportFallback;
  if (cur && cur.reason === reason) return null;
  state.transportFallback = { reason, at: now, session: (job && job.session) || '' };
  return transportNote(state.transportFallback);
}
function transportNote(fb) {
  if (!fb || !FALLBACK_REASONS[fb.reason]) return '';
  const when = fb.at ? new Date(fb.at).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'an earlier run';
  return `pixel transport, fallen back to since ${when} because ${FALLBACK_REASONS[fb.reason]}; ` +
    'the pixel capture is deprecated: set capture.mode in config.json to "pixel" to keep it without this note, or to "screenshot" to try the screenshot transport again';
}

// The strip's two levels per channel on the screenshot transport. A screenshot
// is bit-exact, so "on" need not be 255: dark levels make the strip all but
// invisible. The bridge reads with the threshold halfway between them. Anything
// unusable falls back to the default; the pixel transport never uses these (it
// draws full primaries and reads at 128, because a screen capture goes through
// gamma and scaling).
const DEFAULT_LEVELS = { off: 0, on: 60 };
function screenshotLevels(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  let off = Number.isInteger(r.off) ? r.off : DEFAULT_LEVELS.off;
  let on = Number.isInteger(r.on) ? r.on : DEFAULT_LEVELS.on;
  if (off < 0 || off > 255 || on < 0 || on > 255 || on - off < 8) ({ off, on } = DEFAULT_LEVELS);
  return { off, on, threshold: Math.floor((off + on) / 2) + 1 };
}

// Which codec the addon draws on the screenshot transport (capture.screenshotCodec).
// 2, the default: 2 px cells, four levels per channel between `off` and `on`,
// six bits a cell, 400 cells a row, so a message of a few hundred bytes is one
// 800x2 px line; 1: the capture scripts' 4 px cells with a bit per channel, for
// a client whose screenshots should turn out not to be exact at 2 px. Shipped in
// every slot file as `codec` next to the levels. An addon from before the field
// draws codec 1, which the bridge reads as well (decode.js tries both magics),
// so mixed versions keep talking; the magic tells the strips apart.
const STRIP_CODECS = [1, 2];
const DEFAULT_STRIP_CODEC = 2;
function stripCodec(raw) {
  return STRIP_CODECS.includes(raw) ? raw : DEFAULT_STRIP_CODEC;
}

// Codec 2's four levels, integers spread evenly from off to on (0/60 gives
// 0, 20, 40, 60), the same arithmetic as the addon's Codec.DenseLevels. The
// decoder reads the levels off each strip's ramp anyway; this is for the banner.
function denseLevels(raw) {
  const lv = screenshotLevels(raw);
  return [0, 1, 2, 3].map(k => Math.floor(lv.off + k * (lv.on - lv.off) / 3 + 0.5));
}

function luaSession(s) {
  const f = [`id = ${luaStr(s.id || '')}`, `name = ${luaStr(s.name || '')}`, `cwd = ${luaStr(s.cwd || '')}`, `agent = ${luaStr(s.agent || '')}`, `at = ${Math.max(0, Math.floor(Number(s.at) || 0))}`];
  if (s.plugin) f.push(`plugin = ${luaStr(s.plugin)}`);
  if (s.chat) f.push(`chat = ${luaStr(s.chat)}`);
  if (s.live) f.push('live = true');
  if (s.running) f.push('running = true');
  if (s.title) f.push(`title = ${luaStr(s.title)}`);
  if (s.branch) f.push(`branch = ${luaStr(s.branch)}`);
  if (s.restart) f.push(`restart = ${luaStr(s.restart)}`);
  return `\t\t{ ${f.join(', ')} },`;
}

function luaTable(globalName, records, opts = {}) {
  const now = opts.now || Date.now();
  const agents = Array.isArray(opts.agents) ? opts.agents : [];
  const plugins = Array.isArray(opts.plugins) ? opts.plugins : [];
  const transport = transportName(opts.transport) || DEFAULT_TRANSPORT;
  const lines = [
    '-- Written by the claude-wow bridge (bridge/bridge.js). Do not edit by hand.',
    `${globalName} = {`,
    `\tts = ${luaStr(new Date(now).toISOString())},`,
    `\tnow = ${Math.floor(now / 1000)},`,
    `\tcwd = ${luaStr(opts.cwd || '')},`,
    `\tagent = ${luaStr(opts.agent || '')},`,
    `\tagents = { ${agents.map(luaStr).join(', ')} },`,
    `\tplugin = ${luaStr(opts.plugin || '')},`,
    `\tplugins = { ${plugins.map(luaStr).join(', ')} },`,
    `\ttransport = ${luaStr(transport)},`,
    '\tcancel = true,',
    '\treplies = {',
  ];
  if (transport === 'screenshot') {
    const lv = screenshotLevels(opts.levels);
    lines.splice(lines.length - 1, 0, `\tstrip = { on = ${lv.on}, off = ${lv.off}, codec = ${stripCodec(opts.codec)} },`);
    const cl = opts.chatlog;
    if (cl && cl.enabled === true && Number.isInteger(cl.line) && Number.isInteger(cl.filler) && /^[0-9a-f]{32}$/.test(String(cl.key || ''))) {
      lines.splice(lines.length - 1, 0, `\tchatlog = { line = ${cl.line}, filler = ${cl.filler}, key = "${cl.key}"${cl.show ? ', show = true' : ''} },`);
    }
  }
  // Why a bridge is on the pixel transport when nobody asked for it (transportFallback);
  // the addon shows it in /claude-wow diag.
  if (opts.transportNote) lines.splice(lines.length - 1, 0, `\ttransportNote = ${luaStr(opts.transportNote)},`);
  if (opts.bridge && typeof opts.bridge === 'object') {
    const b = opts.bridge;
    lines.splice(lines.length - 1, 0, `\tbridge = { version = ${luaStr(b.version)}, protoMin = ${Math.floor(Number(b.protoMin)) || 0}, protoMax = ${Math.floor(Number(b.protoMax)) || 0} },`);
  }
  if (opts.live && typeof opts.live === 'object') {
    const sessions = Array.isArray(opts.live.sessions) ? opts.live.sessions : [];
    lines.splice(lines.length - 1, 0, `\tlive = { sessions = { ${sessions.map(luaStr).join(', ')} }, start = ${luaStr(opts.live.start || '')} },`);
  }
  if (Array.isArray(opts.sessions)) {
    lines.splice(lines.length - 1, 0, '\tsessions = {', ...opts.sessions.map(luaSession), '\t},');
  }
  if (Array.isArray(opts.acks)) {
    const acks = opts.acks.filter(a => a && Number.isInteger(a.id) && a.id > 0);
    lines.splice(lines.length - 1, 0, `\tacks = { ${acks.map(a => `{ session = ${luaStr(a.session || '')}, id = ${a.id} }`).join(', ')} },`);
  }
  if (opts.presence && typeof opts.presence === 'object') {
    const pr = opts.presence;
    lines.splice(lines.length - 1, 0, `\tsignals = ${luaStr(pr.scheme || 'armed')},`,
      `\tpresence = { ring = ${luaStr(pr.ring || '')}, at = ${Math.max(0, Math.floor(Number(pr.at) || 0))}, n = ${Math.max(0, Math.floor(Number(pr.n) || 0))}, probe = ${luaStr(pr.probe || '')} },`);
  }
  for (const r of records) {
    lines.push('\t\t{');
    lines.push(`\t\t\tchat = ${luaStr(r.chat || '')},`);
    lines.push(`\t\t\tid = ${Number(r.id) || 0},`);
    lines.push(`\t\t\tstatus = ${luaStr(r.status)},`);
    lines.push(`\t\t\ttext = ${luaStr(r.text)},`);
    lines.push(`\t\t\tcwd = ${luaStr(r.cwd || '')},`);
    lines.push(`\t\t\tsession = ${luaStr(r.session || '')},`);
    lines.push(`\t\t\tagent = ${luaStr(r.agent || '')},`);
    if (r.plugin) lines.push(`\t\t\tplugin = ${luaStr(r.plugin)},`);
    if (r.summary) lines.push(`\t\t\tsummary = ${luaStr(r.summary)},`);
    if (r.title) lines.push(`\t\t\ttitle = ${luaStr(r.title)},`);
    if (r.title && Number(r.titleFor) > 0) lines.push(`\t\t\ttitleFor = ${Math.floor(Number(r.titleFor))},`);
    if (r.late) lines.push('\t\t\tlate = true,');
    if (r.lateOk) lines.push('\t\t\tlateOk = true,');
    // Context growth (noteUsage): only on a final record, and only what is known.
    if (Number(r.ctx) > 0) lines.push(`\t\t\tctx = ${Math.round(Number(r.ctx))},`);
    if (Number(r.turns) > 0) lines.push(`\t\t\tturns = ${Math.round(Number(r.turns))},`);
    if (Number(r.window) > 0) lines.push(`\t\t\twindow = ${Math.round(Number(r.window))},`);
    if (Number(r.since) > 0) lines.push(`\t\t\tsince = ${Math.floor(Number(r.since))},`);
    if (Number.isFinite(Number(r.cost)) && r.cost !== undefined && r.cost !== null && r.cost !== '') lines.push(`\t\t\tcost = ${Number(r.cost)},`);
    if (Array.isArray(r.denied) && r.denied.length) {
      lines.push(`\t\t\tdenied = { ${r.denied.map(luaStr).join(', ')} },`);
    }
    if (Array.isArray(r.macros) && r.macros.length) lines.push(luaMacros(r.macros));
    lines.push('\t\t},');
  }
  lines.push('\t},');
  if (opts.map) lines.push(luaMap(opts.map));
  if (opts.achievementsLua) lines.push(opts.achievementsLua);
  if (opts.goalsLua) lines.push(opts.goalsLua);
  if (opts.dmLua) lines.push(opts.dmLua);
  if (opts.gsLua) lines.push(opts.gsLua);
  if (opts.widgets) lines.push(luaWidgets(opts.widgets));
  const restore = opts.restore;
  if (restore) {
    lines.push('\trestore = {', `\t\ttoken = ${luaStr(restore.token)},`, '\t\tchats = {');
    for (const c of restore.chats) {
      lines.push('\t\t\t{', `\t\t\t\tid = ${luaStr(c.id)},`, `\t\t\t\tname = ${luaStr(c.name)},`, `\t\t\t\tcwd = ${luaStr(c.cwd)},`, `\t\t\t\tplugin = ${luaStr(c.plugin || '')},`);
      if (Number(c.ctx) > 0) lines.push(`\t\t\t\tctx = ${Math.round(Number(c.ctx))},`);
      if (Number(c.turns) > 0) lines.push(`\t\t\t\tturns = ${Math.round(Number(c.turns))},`);
      if (Number(c.since) > 0) lines.push(`\t\t\t\tsince = ${Math.floor(Number(c.since))},`);
      if (Number.isFinite(Number(c.cost)) && c.cost !== undefined && c.cost !== null && c.cost !== '') lines.push(`\t\t\t\tcost = ${Number(c.cost)},`);
      lines.push('\t\t\t\tmessages = {');
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
// to the file named by CLAUDE_WOW_MAP_FILE in its environment (a tool of its own can
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
    points.push({
      m, x: Math.round(Math.min(100, Math.max(0, x)) * 100) / 100, y: Math.round(Math.min(100, Math.max(0, y)) * 100) / 100,
      label: cleanText(p.label, MAP_LIMITS.label), kind: MAP_KINDS.has(p.kind) ? p.kind : 'poi',
    });
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

// Commands the agent's tools appended to CLAUDE_WOW_MAP_FILE (one JSON per line).
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
    for (const p of l.points) lines.push(`\t\t\t\t{ ${p.m}, ${p.x}, ${p.y}, ${luaStr(p.label)}, ${luaStr(p.kind)} },`);
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

const WIDGET_LIMITS = { widgets: 8, sourceBytes: 16000, totalBytes: 64000, title: 60 };
const WIDGET_NAME_RE = /^[A-Za-z0-9_.-]{1,32}$/;
const WIDGET_BLOCK_RE = /```wowui([^\n]*)\n([\s\S]*?)```/g;

const WIDGET_DENIED_NAMES = [
  'CastSpell', 'CastSpellByName', 'CastSpellByID', 'CastShapeshiftForm', 'CastPetAction',
  'UseAction', 'UseItemByName', 'UseInventoryItem', 'UseContainerItem', 'UseToy', 'UseToyByName',
  'RunMacro', 'RunMacroText', 'RunBinding', 'RunScript',
  'TargetUnit', 'TargetNearestEnemy', 'TargetNearestFriend', 'TargetLastTarget', 'TargetLastEnemy', 'ClearTarget',
  'AssistUnit', 'FocusUnit', 'InteractUnit', 'FollowUnit',
  'AttackTarget', 'StartAttack', 'StopAttack', 'PetAttack', 'PetFollow',
  'SpellStopCasting', 'SpellStopTargeting', 'SpellTargetUnit', 'CancelShapeshiftForm', 'CancelUnitBuff',
  'JumpOrAscendStart', 'MoveForwardStart', 'MoveBackwardStart', 'StrafeLeftStart', 'StrafeRightStart',
  'TurnLeftStart', 'TurnRightStart', 'ToggleAutoRun', 'ToggleRun', 'SitStandOrDescendStart',
  'PickupAction', 'PlaceAction', 'PickupSpell', 'PickupItem', 'PickupMacro', 'PickupContainerItem',
  'PickupInventoryItem', 'DeleteCursorItem', 'EquipItemByName',
  'SendChatMessage', 'SendAddonMessage', 'BNSendWhisper', 'DoEmote', 'SendMail', 'ChatEdit_SendText', 'ChatEdit_ParseText',
  'InviteUnit', 'UninviteUnit', 'LeaveParty', 'AcceptGroup', 'AcceptTrade', 'InitiateTrade',
  'BuyMerchantItem', 'RepairAllItems', 'PlaceAuctionBid', 'SetRaidTarget',
  'CreateMacro', 'EditMacro', 'DeleteMacro',
  'SetBinding', 'SetBindingClick', 'SetBindingSpell', 'SetBindingItem', 'SetBindingMacro', 'SaveBindings',
  'SetCVar', 'ConsoleExec', 'ReloadUI', 'Logout', 'Quit', 'ForceQuit',
  'LoadAddOn', 'EnableAddOn', 'DisableAddOn', 'SlashCmdList', 'hooksecurefunc',
  'loadstring', 'load', 'getfenv', 'setfenv', 'getglobal', 'setglobal', 'rawget', 'rawset', 'debug',
  'CombatLogGetCurrentEventInfo',
];
const WIDGET_RESTRICTED_EVENTS = [
  'COMBAT_LOG_EVENT', 'COMBAT_LOG_EVENT_UNFILTERED', 'COMBAT_LOG_APPLY_FILTER_SETTINGS', 'COMBAT_LOG_REFILTER_ENTRIES',
  'MINIMAP_PING', 'UNIT_PING_PIN_ADDED', 'UNIT_PING_PIN_REMOVED',
];
const WIDGET_DENIED_RE = new RegExp(`(?<![A-Za-z0-9_])(${WIDGET_DENIED_NAMES.join('|')})(?![A-Za-z0-9_])`, 'g');
const WIDGET_DENIED_PATTERNS = [
  { re: /Secure[A-Za-z]*(?:Template|Handler)|SecureAction/g, why: 'secure templates' },
  { re: new RegExp(`(?<![A-Za-z0-9_])${ADDON}[A-Za-z0-9_]*`, 'g'), why: 'the addon\'s own data' },
  { re: new RegExp(`(?<![A-Za-z0-9_])(?:${WIDGET_RESTRICTED_EVENTS.join('|')})(?![A-Za-z0-9_])`, 'g'), why: 'an event only the Blizzard UI may register' },
];

const WIDGET_HINT = [
  'When the player asks for a small UI element (a DPS meter, a timer bar for their buffs, a tracker), hand it over as a live widget: the addon loads it at once, without /reload, and keeps it across logins. End the reply with a fenced block whose language tag is wowui followed by the widget name (letters, digits, _ . -, at most 32) and optionally title="<shown title>"; the block holds the widget\'s Lua 5.1 source. Or append {"op":"set","name":"<name>","title":"<title>","source":"<lua>"} as one JSON line to the file named by the CLAUDE_WOW_UI_FILE environment variable.',
  `The source runs once as a function body: "local ui = ..." gives ui.name, ui.frame (a container frame: parent your frames to it, or pass no parent), ui.db (a table saved between sessions, e.g. for a position), and ui.print(text). Use documented addon APIs only: CreateFrame (no Secure templates), events, OnUpdate, C_Timer, Unit* functions, C_UnitAuras, UNIT_COMBAT for damage and heals on a unit. The combat log (COMBAT_LOG_EVENT_UNFILTERED, CombatLogGetCurrentEventInfo) is for the Blizzard UI only in this client: registering it shows the player a blocked-action error, so a widget that names it is refused. Widgets are display-only: no casting, targeting, movement, items, chat or addon messages, macros, bindings, CVars, loadstring/setfenv/debug, and no ClaudeWoW* globals; a widget that names any of these is refused. At most ${WIDGET_LIMITS.sourceBytes} bytes.`,
  'The same name replaces the widget. To remove one, write a wowui block with the name followed by the word remove and an empty body, or append {"op":"remove","name":"<name>"}. Explain outside the block what it shows; the player lists and removes widgets with /claude config ui.',
];

function widgetRevision(source) {
  return crypto.createHash('sha1').update(String(source)).digest('hex').slice(0, 12);
}

function deniedWidgetCalls(source) {
  const found = new Set();
  for (const m of String(source).matchAll(WIDGET_DENIED_RE)) found.add(m[1]);
  for (const { re, why } of WIDGET_DENIED_PATTERNS) {
    for (const m of String(source).matchAll(re)) found.add(`${m[0]} (${why})`);
  }
  return [...found];
}

function validateWidgetCommand(c, why = []) {
  if (!c || typeof c !== 'object') { why.push('not an object'); return null; }
  if (c.op === 'clearall') return { op: 'clearall' };
  const name = String(c.name ?? '');
  if (!WIDGET_NAME_RE.test(name)) { why.push(`bad widget name "${name.slice(0, 40)}"`); return null; }
  if (c.op === 'remove') return { op: 'remove', name };
  if (c.op !== 'set') { why.push(`unknown op "${String(c.op).slice(0, 20)}"`); return null; }
  const source = String(c.source ?? '').replace(/\r/g, '').trim();
  if (!source) { why.push(`widget ${name}: empty source`); return null; }
  const bytes = Buffer.byteLength(source, 'utf8');
  if (bytes > WIDGET_LIMITS.sourceBytes) { why.push(`widget ${name}: ${bytes} bytes, over ${WIDGET_LIMITS.sourceBytes}; refused`); return null; }
  const denied = deniedWidgetCalls(source);
  if (denied.length) { why.push(`widget ${name} refused, widgets are display-only: ${denied.slice(0, 8).join(', ')}`); return null; }
  return { op: 'set', name, title: cleanText(c.title || name, WIDGET_LIMITS.title), source, rev: widgetRevision(source) };
}

function newWidgetSet(epoch) {
  return { epoch: epoch || Math.random().toString(36).slice(2, 10), version: 0, items: {} };
}

function applyWidgetCommands(set, cmds, now = Date.now()) {
  const notes = [];
  let changed = false;
  for (const raw of cmds || []) {
    const why = [];
    const c = validateWidgetCommand(raw, why);
    notes.push(...why);
    if (!c) continue;
    if (c.op === 'clearall') {
      if (Object.keys(set.items).length) { set.items = {}; changed = true; }
      notes.push('removed all widgets');
    } else if (c.op === 'remove') {
      if (set.items[c.name]) { delete set.items[c.name]; changed = true; notes.push(`removed widget ${c.name}`); }
    } else if (set.items[c.name] && set.items[c.name].rev === c.rev && set.items[c.name].title === c.title) {
      notes.push(`widget ${c.name}: unchanged`);
    } else {
      set.items[c.name] = { title: c.title, source: c.source, rev: c.rev, t: now };
      changed = true;
      notes.push(`widget ${c.name}: sent to the game (${Buffer.byteLength(c.source, 'utf8')} bytes)`);
    }
  }
  const totalBytes = () => Object.values(set.items).reduce((s, w) => s + Buffer.byteLength(w.source, 'utf8'), 0);
  const oldestFirst = () => Object.keys(set.items).sort((a, b) => set.items[a].t - set.items[b].t);
  while (Object.keys(set.items).length > WIDGET_LIMITS.widgets || totalBytes() > WIDGET_LIMITS.totalBytes) {
    const oldest = oldestFirst()[0];
    delete set.items[oldest];
    notes.push(`dropped old widget ${oldest} (widget budget full)`);
    changed = true;
  }
  if (changed) set.version = (set.version || 0) + 1;
  return { changed, notes };
}

function parseWidgetHeader(rest) {
  let header = String(rest || '');
  let title = '';
  header = header.replace(/\btitle\s*=\s*"([^"]*)"/i, (_, v) => { title = v; return ' '; });
  const words = header.trim().split(/\s+/).filter(Boolean);
  return { name: words[0] || '', remove: words.slice(1).some(w => w.toLowerCase() === 'remove'), title };
}

function extractWidgetBlocks(text) {
  const cmds = [];
  const stripped = String(text ?? '').replace(WIDGET_BLOCK_RE, (_, header, body) => {
    const h = parseWidgetHeader(header);
    if (h.remove) cmds.push({ op: 'remove', name: h.name });
    else cmds.push({ op: 'set', name: h.name, title: h.title || h.name, source: body });
    return h.remove ? '' : `[UI widget "${h.name || '?'}"]`;
  }).replace(/\n{3,}/g, '\n\n').trim();
  return { text: stripped, cmds };
}

function parseWidgetFile(src) {
  const cmds = [], errors = [];
  for (const line of String(src || '').split('\n')) {
    if (!line.trim()) continue;
    try { cmds.push(JSON.parse(line)); } catch { errors.push('unreadable widget file line'); }
  }
  return { cmds, errors };
}

function luaWidgets(set) {
  const lines = ['\twidgets = {', `\t\tepoch = ${luaStr(set.epoch)},`, `\t\tversion = ${Number(set.version) || 0},`, '\t\titems = {'];
  for (const [name, w] of Object.entries(set.items || {})) {
    lines.push(`\t\t\t{ name = ${luaStr(name)}, title = ${luaStr(w.title)}, rev = ${luaStr(w.rev)}, source = ${luaStr(w.source)} },`);
  }
  lines.push('\t\t},', '\t},');
  return lines.join('\n');
}

module.exports = {
  ADDON, RUNTIME_ADDON, SHIPPED_INBOX_PATH, OLD_ADDONS, OLD_ADDON_PATH, OLD_SAVED_FILE, TOC_INTERFACE, OLD_TOC_INTERFACES,
  fromHex, pad3, slotNumber, SIGNAL_CLEAR_AHEAD, slotsToClearAhead, PRESENCE_TEST_RESULTS, LATE_CREATE_RESULTS, chatKey, sessKey,
  alreadyHandled, markHandled, pruneStale, MONTH_MS, noteAck, recentAcks, RECENT_ACKS_MAX, RECENT_ACK_MS,
  noteUsage, usageFields, tokensLabel,
  resolveCwd, sameFolder, baseName,
  PROTO, PROTO_MIN, PROTO_MAX, LEGACY_PROTO, SEMVER_RE, ADDON_VERSIONS_MAX, bridgeVersion, bridgeInfo, compareSemver, versionVerdict, noteAddonVersion, addonRefusal, latestAddonVersion, versionsSummary,
  parseFlags, PERMISSION_MODES, permissionModeName, ADD_DIRS_MAX, jobsFromStrip, parseOutbox, withRunOnlyRules, withRunDeniedRules, withoutRules, absolutePathRule, systemPrompt, systemRulesHash, rulesChanged, noteRules, messagePrompt, visionHint, splitSummary,
  ruleFor, describeToolUse,
  folderRule, ruleFolder, splitGrants, insideFolder, nearestFolder, denialPath, classifyDenial, grantsFor, deniedAgain, denialNotes,
  luaStr, luaTable, luaSession, SILENT_WAV, TRANSPORTS, DEFAULT_TRANSPORT, transportName, chooseTransport, FALLBACK_REASONS, transportFallback, transportNote, DEFAULT_LEVELS, screenshotLevels, STRIP_CODECS, DEFAULT_STRIP_CODEC, stripCodec, denseLevels,
  MAP_LIMITS, validateMapCommand, newMap, applyMapCommands, extractMapBlocks, parseMapFile, luaMap,
  MACRO_LIMITS, extractMacros, stripMacroBlocks, luaMacros,
  WIDGET_LIMITS, WIDGET_DENIED_NAMES, WIDGET_RESTRICTED_EVENTS, deniedWidgetCalls, validateWidgetCommand, newWidgetSet, applyWidgetCommands,
  extractWidgetBlocks, parseWidgetFile, luaWidgets, widgetRevision,
};
