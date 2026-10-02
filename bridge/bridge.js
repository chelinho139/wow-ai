#!/usr/bin/env node
'use strict';
// Claude WoW bridge: the half of ClaudeWoW that lives outside the game.
//
//   OUT  the addon calls Screenshot() with its pixel strip up and we decode
//        the file from the game's Screenshots folder -> one or more
//        {session, chat, id, cwd, flags, text} records per shot (capture.mode
//        "screenshot", the default); or, on the deprecated "pixel" mode,
//        capture.ps1 / capture_*.py screen-capture the strip four times a
//        second (kept until Screenshot() is confirmed on Windows and Wine, and
//        what the bridge falls back to when the addon says it cannot shoot)
//        (fallback: the game's SavedVariables file, written on /reload)
//   ROUTE the plugin the message belongs to (plugins.js: the chat's binding,
//        else the default) decides what happens: the coding plugin
//        (plugins/claude-code.js) runs the chat's agent in the chat's folder.
//   RUN  the chat's agent (Claude Code, Codex or Grok; see agents.js) headless,
//        streaming progress. Each chat is its own agent session; up to
//        maxParallel run at once.
//   IN   we write the latest reply/status of every chat into every
//        ClaudeWoW_S### slot addon (the game loads a fresh one from a timer),
//        flip a signal .wav per message, and also write Inbox.lua for the
//        reload path.
//
// Zero npm dependencies. Run with npm start or `node bridge.js`.
//   --once            handle one pending SavedVariables prompt and exit
//   --inject "text"   pretend the strip said this and exit when done
//   --agent <id>      agent for --inject (default: "agent" in config.json)
//   --plugin <id>     plugin for --inject (default: plugins.default in config.json)
//   --image <file>    with --inject: attach this PNG/TGA as the player's screen (vision)
//   --project <dir>   default folder for chats that haven't picked one
//
// Like the agent CLIs themselves, the bridge works in the folder it was started
// from: `cd my-project && claude-wow` makes my-project the default for every chat
// that hasn't chosen its own with /claude-wow cd. Started from inside this repo (npm
// start), it falls back to defaultCwd in config.json.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const PR = require('./procs');  // the children (agent runs, the capture script): their process groups, and ending them for good (tests/procs_test.js)
const P = require('./protocol'); // the pure protocol code, unit-tested in tests/bridge_test.js
const A = require('./agents');   // how each agent is launched and read, unit-tested in tests/agents_test.js
const D = require('./decode');   // PNG/TGA reader + strip decoder for the screenshot transport (tests/decode_test.js)
const S = require('./screenshots'); // the Screenshots folder watcher (tests/screenshots_test.js)
const CL = require('./chatlog');
const V = require('./vision');   // vision: the screenshot's game view, cropped and downscaled for the agent (tests/vision_test.js)
const PL = require('./plugins'); // the plugin registry and routing (tests/plugins_test.js)
const H = require('./home');     // where config, state and logs live (tests/home_test.js)
const R = require('./runtime');  // node, bun, or the compiled binary (tests/runtime_test.js)
const AS = require('./assets');  // the capture scripts and the primer, by path, from a checkout or the binary (tests/assets_test.js)
const ACH = require('./achievements');
const SS = require('./sessions');
const G = require('./gamefs');
const SIG = require('./signals');
const DM = require('./datamcp');
const GM = require('./goalsmcp');
const GD = require('./gamedata');
const DSYNC = require('./datasync');
const GR = require('./gamerefs');

// The plugins this bridge has (docs/PLATFORM.md). Registration order is the
// order match() is asked in, and the first one is the default unless
// plugins.default in config.json says otherwise: "ask", general in-game chat,
// so the product works for someone who does not code; "claude-code", an agent
// session in a folder, what the bridge was before plugins.
const registry = PL.createRegistry();
registry.register(require('./plugins/ask'));
registry.register(require('./plugins/claude-code'));
registry.register(require('./plugins/roast'));
registry.register(require('./plugins/stream'));
registry.register(require('./plugins/live'));
const LP = require('./liveproto');
const T = require('./titles');
const GOALS = require('./goals');
const CAMPAIGN = require('./campaign');
const TL = require('./telemetry');
const VOTES = require('./votes');
const OB = require('./observed');
const OT = require('./observedtools');
const MH = require('./maphold');

const HERE = __dirname;
// Config, state, transcripts, log and scratch live in the home folder (home.js:
// CLAUDE_WOW_HOME, ~/.claude-wow, or bridge/ for an install from before it).
const HOME = H.resolve();
const CONFIG_FILE = HOME.config;
const STATE_FILE = HOME.state;
const LOG_FILE = HOME.log;
const TMP_DIR = HOME.tmp; // prompt files for agents that read the prompt from disk

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log('claude-wow [--project <dir>] [--once] [--inject "text" [--agent <id>] [--plugin <id>] [--image <png|tga>]]\n\n' +
    'Runs the Claude WoW bridge. Chats without a folder of their own work in <dir>,\n' +
    'or in the folder you started it from, or in defaultCwd from bridge/config.json.\n' +
    '--image attaches a screenshot to an --inject run the way vision does in game.\n' +
    `Agents: ${A.agentIds().join(', ')} (the default is "agent" in config.json; chats pick with /claude --agent).\n` +
    `Plugins: ${registry.ids().join(', ')} (the default is plugins.default in config.json).`);
  process.exit(0);
}
let cfg;
try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
catch (e) {
  console.error(`Cannot read ${CONFIG_FILE} (${e.message}).\nRun "claude-wow setup" (node setup.js in the claude-wow folder) first.`);
  process.exit(2); // the supervisor doesn't restart on 2
}
const once = argv.includes('--once');
const injectIdx = argv.indexOf('--inject');
const inject = injectIdx >= 0 ? argv[injectIdx + 1] : null;
const agentIdx = argv.indexOf('--agent');
const injectAgent = agentIdx >= 0 ? argv[agentIdx + 1] : '';
const imageIdx = argv.indexOf('--image');
const injectImage = imageIdx >= 0 ? argv[imageIdx + 1] : '';
const pluginIdx = argv.indexOf('--plugin');
const injectPlugin = pluginIdx >= 0 ? argv[pluginIdx + 1] : '';
const exitWhenIdle = once || inject !== null;

// The agent chats use unless they pick their own (/claude-wow agent, "agent=" flag).
const DEFAULT_AGENT = A.normalizeAgent(cfg.agent || A.DEFAULT_AGENT);
if (!DEFAULT_AGENT) {
  console.error(`"agent": "${cfg.agent}" in ${CONFIG_FILE} is not one of ${A.agentIds().join(', ')}.`);
  process.exit(2);
}
// The plugin a chat is routed to unless it is bound to another ("plugin=" flag).
const pluginsCfg = cfg.plugins && typeof cfg.plugins === 'object' ? cfg.plugins : {};
const DEFAULT_PLUGIN = pluginsCfg.default ? registry.normalize(pluginsCfg.default) : registry.ids()[0];
if (!DEFAULT_PLUGIN) {
  console.error(`"plugins.default": "${pluginsCfg.default}" in ${CONFIG_FILE} is not one of ${registry.ids().join(', ')}.`);
  process.exit(2);
}

// Default folder: --project, else the folder we were started from (unless that is
// one of the bridge's own folders), else the configured one. Own folders: this
// repo (npm start) and the home folder itself, which is where the service runs
// the compiled binary (there is no repo then; service.js). Both mean "no
// project of my own here": fall back to defaultCwd.
const REPO = R.compiled ? '' : path.dirname(HERE);
function insideRepo(dir) {
  if (path.resolve(dir) === path.resolve(HOME.dir)) return true;
  if (!REPO) return false;
  const rel = path.relative(REPO, dir);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
const projectIdx = argv.indexOf('--project');
// CLAUDE_WOW_PROJECT names the default folder; the old WOW_AI_PROJECT still counts.
const PROJECT_ENV = process.env.CLAUDE_WOW_PROJECT || process.env.WOW_AI_PROJECT || '';
const DEFAULT_CWD = path.resolve(
  projectIdx >= 0 && argv[projectIdx + 1] ? argv[projectIdx + 1]
    : PROJECT_ENV ? PROJECT_ENV
    : !insideRepo(process.cwd()) ? process.cwd()
    : cfg.defaultCwd || process.cwd());
const DEFAULT_CWD_SOURCE = projectIdx >= 0 ? '--project' : PROJECT_ENV ? (process.env.CLAUDE_WOW_PROJECT ? 'CLAUDE_WOW_PROJECT' : 'WOW_AI_PROJECT')
  : !insideRepo(process.cwd()) ? 'started here' : 'config.json';

const CLAUDE_DIR = SS.claudeDir(process.env, cfg.claudeDir);
const SESSION_LIST_MAX = 20;
const CLAUDE_SESSIONS_TTL_MS = 30000;
let claudeSessionsCache = { at: 0, list: [] };

const SLOTS = cfg.slots || 200;
const MAX_PARALLEL = cfg.maxParallel || 3;
const cap = Object.assign({ enabled: true, processName: 'WowB', cellPx: 4, cellsPerRow: 200, maxRows: 48, intervalMs: 250 }, cfg.capture || {});
// Outbound transport (protocol.chooseTransport): "screenshot" = the addon takes
// a screenshot per send and we read the file (the default); "pixel" = a capture
// script watches the screen (deprecated; an explicit capture.mode, or the
// fallback a previous run had to make, remembered in state.json). It can
// change while running: fallbackToPixel, when the addon reports it cannot shoot.
const LOCK_FILE = path.join(HOME.dir, 'bridge.lock');
const BOOTED_AT = Date.now() - os.uptime() * 1000;
const SELF_MARKER = path.basename(process.argv[1] || process.execPath);

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function commandOf(pid) {
  if (process.platform === 'win32') return null;
  const r = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

function isSameProcess(pid, startedAt, marker) {
  if (!pidAlive(pid)) return false;
  if (!Number.isFinite(startedAt) || startedAt < BOOTED_AT) return false;
  const cmd = commandOf(pid);
  if (cmd === null) return process.platform === 'win32';
  return !!marker && cmd.includes(marker);
}

function readJsonQuiet(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function holdLock() {
  fs.mkdirSync(HOME.dir, { recursive: true });
  const mine = JSON.stringify({ pid: process.pid, started: new Date().toISOString(), startedAt: Date.now(), marker: SELF_MARKER });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(LOCK_FILE, mine, { flag: 'wx' });
      process.on('exit', () => {
        const now = readJsonQuiet(LOCK_FILE);
        if (now && now.pid === process.pid) { try { fs.rmSync(LOCK_FILE, { force: true }); } catch {} }
      });
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    const held = readJsonQuiet(LOCK_FILE);
    if (held && held.pid !== process.pid && isSameProcess(held.pid, held.startedAt, held.marker)) {
      const msg = `another bridge is already running on ${HOME.dir} (pid ${held.pid}, started ${held.started || 'at an unknown time'}). Two bridges would overwrite each other's state and race for the same screenshots. Stop it first ("claude-wow service stop", or end pid ${held.pid}).`;
      console.error(msg);
      log(msg);
      process.exit(3);
    }
    try { fs.rmSync(LOCK_FILE, { force: true }); } catch {}
  }
  log(`could not take ${LOCK_FILE}; starting without the single-bridge guard`);
  return false;
}
const holdsLock = !exitWhenIdle && holdLock();

const stateEarly = readJson(STATE_FILE, {});
const chosen = P.chooseTransport(cap, stateEarly);
if (!chosen.transport) {
  console.error(`"capture.mode": "${cap.mode}" in ${CONFIG_FILE} is not one of ${P.TRANSPORTS.join(', ')}.`);
  process.exit(2);
}
let TRANSPORT = chosen.transport;
let TRANSPORT_SOURCE = chosen.source; // 'config' | 'default' | 'fallback'
const SCREENSHOT_DIR = S.screenshotDir(cfg);
const CHAT_LOG = CL.options(cap.chatLog);
const CHAT_LOG_FILE = CL.chatLogFile(cfg);
// Vision: a chat that turned it on (/claude-wow vision on, flag "v") gets the rest
// of the screenshot, strip cropped off and scaled to vision.maxWidth, attached
// to its run as an image. Screenshot transport only: the pixel capture never
// sees more than the strip. vision.keep caps the PNGs kept in bridge/tmp.
const vis = Object.assign({}, V.DEFAULTS, cfg.vision || {});
// Screenshot mode draws the strip dark (capture.screenshotLevels) and reads it
// with the threshold between the two levels; pixel mode stays bright and >= 128.
const LEVELS = P.screenshotLevels(cap.screenshotLevels);
// ... and which strip the addon draws there: codec 2 (2 px cells, four levels,
// the default) or 1 (the capture scripts' 4 px cells). The decoder reads both.
const STRIP_CODEC = P.stripCodec(cap.screenshotCodec);
// The game-side files. A config.json written for one of the addon's old names
// (WoWClaude, WoWAI) still works: the paths are derived from addonDir instead.
const INBOX_FILE = cfg.inboxFile && !P.OLD_ADDON_PATH.test(cfg.inboxFile) ? cfg.inboxFile : path.join(cfg.addonDir || '', P.ADDON, 'Inbox.lua');
const SAVED_VARS = String(cfg.savedVariablesFile || '').replace(P.OLD_SAVED_FILE, P.ADDON + '.lua');

let state = Object.keys(stateEarly).length ? stateEarly : { lastId: 0, sessions: {}, handled: {} };
if (!state.handled) state.handled = {};
if (!state.sessions) state.sessions = {};
// Older versions stored handled[session] as "highest id so far"; expand to a map.
for (const [k, v] of Object.entries(state.handled)) {
  if (typeof v === 'number') {
    const m = {};
    for (let i = 1; i <= v; i++) m[i] = 1;
    state.handled[k] = m;
  }
}

const TELEMETRY_ON = TL.telemetryEnabled(cfg.telemetry);
const observed = OB.createObserved({ dir: HOME.goals, log });
const telemetry = TL.createTelemetry({
  dir: HOME.goals,
  log,
  watch: () => TL.watchFrom(cfg.telemetry),
  observed,
  gatherSpells: () => OB.gatherSpells(GR.openFor(HOME.data, (state.context && state.context.text) || '')),
});

// Bridge-side transcripts. The beta client sometimes wipes addon saved data; since
// every prompt and reply passes through here, this copy lets the addon recover.
const TRANSCRIPT_FILE = HOME.transcripts;
let transcripts = readJson(TRANSCRIPT_FILE, { chats: {}, tokens: {} });
if (!transcripts.chats) transcripts.chats = {};
if (!transcripts.tokens) transcripts.tokens = {};
if (P.pruneStale(state, transcripts)) { saveState(); saveTranscripts(); }
let pendingRestore = null;

function saveTranscripts() {
  try { durableWrite(TRANSCRIPT_FILE, JSON.stringify(transcripts)); } catch (e) { log('could not save transcripts:', e.message); }
}

// Chats the player deleted in game while a run for them was still going: the
// run's late progress and reply must not recreate the transcript.
const forgotten = new Set();

function noteMessage(job, role, text) {
  if (!job.chat) return;
  if (role === 'user') forgotten.delete(job.chat);
  else if (forgotten.has(job.chat)) return;
  const c = transcripts.chats[job.chat] = transcripts.chats[job.chat] || { id: job.chat, name: '', cwd: job.cwd, messages: [] };
  if (job.name) c.name = job.name;
  if (job.cwd) c.cwd = job.cwd;
  if (job.plugin) c.plugin = job.plugin;
  const m = { role, text: String(text ?? '').slice(0, 4000), id: job.id, t: Math.floor(Date.now() / 1000) };
  if (role === 'assistant' && job.agent) m.agent = job.agent;
  c.messages.push(m);
  while (c.messages.length > 200) c.messages.shift();
  c.updated = Date.now();
  saveTranscripts();
}

const RESTORE_CHATS = 16;
const RESTORE_MESSAGES = 40;
const RESTORE_TEXT_MAX = 2000;

// First message from an addon session token we haven't seen: its saved data is
// fresh (or reset), so offer everything we know once, in the next publish.
function maybeOfferRestore(job) {
  if (!job.session || transcripts.tokens[job.session]) return;
  transcripts.tokens[job.session] = Date.now();
  const chats = Object.values(transcripts.chats)
    .filter(c => c.id !== job.chat && c.messages.length)
    .sort((a, b) => (b.updated || 0) - (a.updated || 0))
    .slice(0, RESTORE_CHATS)
    .map(c => ({ id: c.id, name: c.name, cwd: c.cwd, plugin: c.plugin || 'claude-code', ...P.usageFields(state.sessionUsage && state.sessionUsage['chat:' + c.id]), messages: c.messages.slice(-RESTORE_MESSAGES).map(m => ({ ...m, text: m.text.slice(0, RESTORE_TEXT_MAX) })) }));
  saveTranscripts();
  if (chats.length) {
    pendingRestore = { token: job.session, chats };
    log(`new addon session ${job.session}: offering ${chats.length} chat(s) to restore`);
  }
}

// The player deleted a chat in game. Drop everything we keep for it, so the next
// restore doesn't bring it back and its id can't resume the old agent session.
function forgetChat(job) {
  if (!job.chat) return;
  const had = !!transcripts.chats[job.chat];
  delete transcripts.chats[job.chat];
  forgotten.add(job.chat);
  delete state.sessions[sessKey(job)];
  delete state.sessions[chatKey(job)];
  if (state.sessionCwd) delete state.sessionCwd[sessKey(job)];
  if (state.sessionAgent) delete state.sessionAgent[sessKey(job)];
  if (state.sessionPlugin) delete state.sessionPlugin[sessKey(job)];
  if (state.sessionUsage) delete state.sessionUsage[sessKey(job)];
  if (pendingRestore) pendingRestore.chats = pendingRestore.chats.filter(c => c.id !== job.chat);
  saveTranscripts();
  log(`#${job.id}${job.session ? '@' + job.session : ''} forgot chat ${job.chat}${had ? '' : ' (nothing stored)'}`);
}

let lastMtime = 0;
const running = new Map(); // chatKey -> { job, child }
const queued = new Map();  // chatKey -> job waiting for that chat (or for a free parallel slot)
const live = new Map();    // chatKey -> latest record shown to the game
let lastPublish = 0;
let publishTimer = null;

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function readJson(file, fallback) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code !== 'ENOENT') log(`${path.basename(file)}: cannot read it (${e.code || e.message}); starting from empty`);
    return fallback;
  }
  try { return JSON.parse(text); } catch (e) {
    const aside = `${file}.corrupt-${Date.now()}`;
    let kept = true;
    try { fs.renameSync(file, aside); } catch { kept = false; }
    log(`${path.basename(file)} is corrupt (${e.message}); ${kept ? `kept it as ${path.basename(aside)}` : 'could not move it aside'} and started from empty. To recover, stop the bridge, repair that copy, and put it back as ${path.basename(file)}.`);
    return fallback;
  }
}

function durableWrite(file, content) {
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}

function saveState() {
  durableWrite(STATE_FILE, JSON.stringify(state, null, 2));
}

function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

const { pad3, chatKey, sessKey, jobsFromStrip } = P;
const slotNumber = id => P.slotNumber(id, SLOTS);
const alreadyHandled = job => P.alreadyHandled(state, job);
const markHandled = job => P.markHandled(state, job);

function atomicWrite(file, content) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

function isDirectory(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

// Stop a run and whatever it spawned: an npm launcher runs the real binary as a
// child of its own, an agent shells out to builds and test runs. procs.js: on
// POSIX every child leads its own process group and the group gets SIGTERM,
// then SIGKILL after killGraceMs (a child that ignores SIGTERM would otherwise
// hold its pipes open, 'close' would never fire, and the chat would sit in
// `running` until a restart); on Windows taskkill /T /F.
const KILL_GRACE_MS = Number.isFinite(cfg.killGraceMs) && cfg.killGraceMs >= 0 ? cfg.killGraceMs : PR.DEFAULT_GRACE_MS;
function killTree(child) { PR.killTree(child, { graceMs: KILL_GRACE_MS, log }); }

// Ctrl+C, `claude-wow service stop`, a kill of this pid: end the agent runs
// and the capture script first (they are in process groups of their own now,
// so the terminal's Ctrl+C does not reach them by itself), then exit with the
// signal's usual code; the supervisor restarts a bridge that went this way
// unless it is stopping too. A second signal while that is going changes nothing.
let shuttingDown = false;
let captureChild = null; // the capture script on the pixel transport (startCapture)
function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  try { runGrants.revokeAll(); } catch {}
  stopPlugins();
  let voteClosing = Promise.resolve();
  try { voteClosing = VOTES.settleWithin(voteBox.stop(), VOTES.SHUTDOWN_PUSH_WAIT_MS); } catch {}
  const kids = [...running.values()].map(r => r.child).concat(T.titleChildren()).filter(Boolean);
  if (captureChild) kids.push(captureChild);
  const n = kids.filter(PR.alive).length;
  log(`${sig}: stopping${n ? `; ending ${n} child process${n === 1 ? '' : 'es'} (SIGTERM, SIGKILL after ${KILL_GRACE_MS} ms)` : ''}`);
  PR.killAll(kids, { graceMs: KILL_GRACE_MS, log }, () => voteClosing.then(() => process.exit(sig === 'SIGINT' ? 130 : 143)));
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
function crash(kind, err) {
  try { log(`CRASH (${kind}): ${err && err.stack ? err.stack : err}`); } catch {}
  const kids = [...running.values()].map(r => r.child).concat(T.titleChildren(), captureChild ? [captureChild] : []).filter(Boolean);
  for (const child of kids) { try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch {} }
  process.exit(70);
}
process.on('uncaughtException', e => crash('uncaughtException', e));
process.on('unhandledRejection', e => crash('unhandledRejection', e));

// ---------------------------------------------------------------------------
// What the game reads
// ---------------------------------------------------------------------------

// Map layers the agent drew (see protocol.js, "Map layers"). The bridge is the source of
// truth; slot files carry the whole set while the game may not have it yet: for a
// while after it changes, and after every hello (a fresh or wiped client).
if (!state.map) state.map = P.newMap();
const MAP_DIR = HOME.mapjobs;
// Every publish rewrites all slot files, so the map rides along only for a short
// while, and on progress publishes only while it is small.
const MAP_SHARE_MS = 3 * 60 * 1000;
const MAP_PROGRESS_MAX = 20000;
const mapShare = MH.createMapShare({ state, shareMs: MAP_SHARE_MS, save: () => saveState() });
let mapLuaCache = { version: -1, epoch: '', text: '' };
function mapLuaSize() {
  if (mapLuaCache.version !== state.map.version || mapLuaCache.epoch !== state.map.epoch) {
    mapLuaCache = { version: state.map.version, epoch: state.map.epoch, text: P.luaMap(state.map) };
  }
  return mapLuaCache.text.length;
}

function applyToolMap(cmds) {
  const { changed, notes } = P.applyMapCommands(state.map, cmds);
  if (changed) {
    mapShare.hold();
    log(`map: ${notes.join('; ')} (version ${state.map.version}), kept in the slot files until the next reply or hello`);
    publishNow(true, { refresh: true });
  }
  return { changed, notes };
}

function mapFileFor(job) {
  return path.join(MAP_DIR, `${String(job.chat || 'default').replace(/[^\w-]/g, '_')}-${job.id}.jsonl`);
}

// Collect what the run asked for (its map file, then ```wowmap blocks in its
// reply), apply it, and return the reply text without the blocks plus a note
// for the reply, if anything was asked.
function takeMapCommands(job, text) {
  const file = mapFileFor(job);
  let cmds = [], errors = [];
  try {
    const r = P.parseMapFile(fs.readFileSync(file, 'utf8'));
    cmds = r.cmds; errors = r.errors;
  } catch {}
  try { fs.unlinkSync(file); } catch {}
  const blocks = P.extractMapBlocks(text);
  cmds.push(...blocks.cmds);
  errors.push(...blocks.errors);
  if (!cmds.length && !errors.length) return { text: blocks.text, note: '' };
  const { changed, notes } = P.applyMapCommands(state.map, cmds);
  if (changed) { saveState(); mapShare.touch(); }
  const all = [...notes, ...errors];
  log(`#${job.id} map: ${all.join('; ') || 'no change'} (version ${state.map.version})`);
  return { text: blocks.text, note: all.length ? `map: ${all.join('; ')}` : '' };
}

if (!state.widgets) state.widgets = P.newWidgetSet();
const WIDGET_DIR = HOME.uijobs;
const WIDGET_SHARE_MS = 3 * 60 * 1000;
const WIDGET_PROGRESS_MAX = 20000;
let widgetShareUntil = Object.keys(state.widgets.items).length ? Date.now() + WIDGET_SHARE_MS : 0;
function widgetSourceBytes() {
  return Object.values(state.widgets.items).reduce((sum, w) => sum + w.source.length, 0);
}

function widgetFileFor(job) {
  return path.join(WIDGET_DIR, `${String(job.chat || 'default').replace(/[^\w-]/g, '_')}-${job.id}.jsonl`);
}

function takeWidgetCommands(job, text) {
  const file = widgetFileFor(job);
  let cmds = [], errors = [];
  try {
    const fromFile = P.parseWidgetFile(fs.readFileSync(file, 'utf8'));
    cmds = fromFile.cmds; errors = fromFile.errors;
  } catch {}
  try { fs.unlinkSync(file); } catch {}
  const blocks = P.extractWidgetBlocks(text);
  cmds.push(...blocks.cmds);
  if (!cmds.length && !errors.length) return { text: blocks.text, note: '' };
  const { changed, notes } = P.applyWidgetCommands(state.widgets, cmds);
  if (changed) { saveState(); widgetShareUntil = Date.now() + WIDGET_SHARE_MS; }
  const all = [...notes, ...errors];
  log(`#${job.id} ui: ${all.join('; ') || 'no change'} (version ${state.widgets.version})`);
  return { text: blocks.text, note: all.length ? `ui: ${all.join('; ')}` : '' };
}

let acksSent = [];

// Slot file / Inbox.lua body: see protocol.luaTable.
function slotFile(globalName, records, urgent = true) {
  const map = mapShare.inSlots({ urgent, size: mapLuaSize(), progressMax: MAP_PROGRESS_MAX }) ? state.map : null;
  const widgets = Date.now() < widgetShareUntil && (urgent || widgetSourceBytes() <= WIDGET_PROGRESS_MAX) ? state.widgets : null;
  const transportNote = TRANSPORT_SOURCE === 'fallback' ? P.transportNote(state.transportFallback) : '';
  const achievementsLua = ACHIEVEMENTS_ON ? ACH.luaAchievements(state) : '';
  const lp = livePlugin();
  const liveInfo = lp ? { sessions: lp.status(), start: liveStartCommand() } : null;
  const goalsLua = goalStore.slotLua();
  let dmLua = '';
  try { dmLua = campaignStore.slotLua(); } catch (e) { log(`campaign: slot field dm left out (${e && e.message ? e.message : e})`); }
  let gsLua = '';
  if (TELEMETRY_ON) {
    try { gsLua = telemetry.luaGs(); } catch (e) { log(`telemetry: slot field gs left out (${e && e.message ? e.message : e})`); }
  }
  return P.luaTable(globalName, records, { live: liveInfo, sessions: sessionList(), cwd: DEFAULT_CWD, restore: pendingRestore, agent: DEFAULT_AGENT, agents: A.agentIds(), plugin: DEFAULT_PLUGIN, plugins: registry.ids(), map, widgets, transport: TRANSPORT, levels: LEVELS, codec: STRIP_CODEC, chatlog: chatLogSlot(), acks: P.recentAcks(acksSent), transportNote, achievementsLua, goalsLua, dmLua, gsLua, presence: presenceInfo() });
}

function recentClaudeSessions() {
  if (cfg.claudeSessions === false) return [];
  if (Date.now() - claudeSessionsCache.at > CLAUDE_SESSIONS_TTL_MS) {
    let list = [];
    try { list = SS.recentClaudeSessions(CLAUDE_DIR, { limit: SESSION_LIST_MAX }); } catch (e) { log(`sessions: cannot read ${CLAUDE_DIR} (${e.message})`); }
    claudeSessionsCache = { at: Date.now(), list };
  }
  return claudeSessionsCache.list;
}

function sessionList() {
  const lp = livePlugin();
  const live = lp && typeof lp.sessions === 'function' ? lp.sessions() : [];
  const merged = SS.mergeSessions({ live, own: SS.ownSessions(state, transcripts), claude: recentClaudeSessions(), limit: SESSION_LIST_MAX });
  return merged.map(s => ({ ...s, branch: SS.gitBranch(s.cwd) }));
}

function resolveResume(job) {
  const find = ref => {
    if (cfg.claudeSessions === false) return [];
    try { return SS.findClaudeSessions(CLAUDE_DIR, ref); } catch (e) { log(`${tagOf(job)} sessions: cannot search ${CLAUDE_DIR} (${e.message})`); return []; }
  };
  return SS.resolveResume(job.resume, { own: SS.ownSessions(state, transcripts), find });
}

function adoptSession(job, m) {
  const skey = sessKey(job);
  state.sessions[skey] = m.id;
  delete state.sessions[chatKey(job)];
  (state.sessionAgent = state.sessionAgent || {})[skey] = m.agent || 'claude';
  if (m.cwd) (state.sessionCwd = state.sessionCwd || {})[skey] = m.cwd;
  if (!job.agent) job.agent = m.agent || 'claude';
  const plugin = !job.plugin && m.plugin && m.plugin !== 'live' ? m.plugin : '';
  if (plugin) job.plugin = plugin;
  if (!job.plugin && m.cwd) job.plugin = 'claude-code';
  if (!job.cwd && m.cwd && registry.normalize(job.plugin) === 'claude-code') job.cwd = m.cwd;
  job.newSession = false;
  job.adopted = m;
  log(`${tagOf(job)} resumes session ${m.id}${m.cwd ? ' in ' + m.cwd : ''} (${m.agent || 'claude'})`);
}

const ACHIEVEMENTS_ON = cfg.achievements !== false;
function awardAchievements(job, status) {
  if (!ACHIEVEMENTS_ON || !ACH.pluginEarns(registry.get(job.plugin))) return;
  const chatTranscript = job.chat && transcripts.chats[job.chat];
  const chatMessages = chatTranscript ? chatTranscript.messages.filter(m => m.role === 'user').length : 0;
  const commands = job.activity ? job.activity.commands() : [];
  try {
    const { awards, changed } = ACH.evaluate(state, { chat: chatKey(job), status, commands, chatMessages });
    if (changed) saveState();
    if (awards.length) log(`${tagOf(job)} achievement${awards.length === 1 ? '' : 's'}: ${awards.map(a => a.title).join(', ')}`);
  } catch (e) {
    log(`${tagOf(job)} achievements: ${e.message}`);
  }
}

// The addon cannot take the screenshot the transport needs (no Screenshot() in
// this client, or SCREENSHOT_FAILED on every try): its record says so with a
// "shot=" flag, on the strip or in the reload outbox. Switch to the pixel
// capture now, remember why (state.json; the next start goes straight to it),
// say so plainly here and in the slot files (the addon's /claude-wow diag
// shows the note), and start the capture. A player is never left without a
// transport just because the default one cannot work on their client.
function fallbackToPixel(reason, job) {
  const fresh = P.transportFallback(state, reason, job); // null when this reason is already on record
  if (fresh) saveState();
  if (TRANSPORT === 'pixel') {
    // An explicit "pixel" in config.json, an earlier fallback, or the addon
    // repeating itself until its next slot read: nothing to switch.
    if (fresh) log(`${tagOf(job)} the addon reports shot=${reason} (${P.FALLBACK_REASONS[reason]}); already on the pixel transport`);
    return;
  }
  TRANSPORT = 'pixel';
  TRANSPORT_SOURCE = 'fallback';
  log(`${tagOf(job)} TRANSPORT FALLBACK: the addon reports shot=${reason}: ${P.FALLBACK_REASONS[reason]}.`);
  log(`  switching from the screenshot transport to the pixel capture (deprecated; it needs ${process.platform === 'win32' ? 'capture.ps1' : 'python3 and ' + (process.platform === 'darwin' ? 'the Screen Recording and Automation permissions' : 'an X11 session')}).`);
  if (chosen.source === 'config') log(`  capture.mode is "screenshot" in ${CONFIG_FILE}, so every start tries the screenshot transport first and falls back again when the addon reports this; set it to "pixel" to skip the wait.`);
  else log(`  remembered in ${STATE_FILE}: the next start goes straight to the pixel transport. To choose for good, set capture.mode in ${CONFIG_FILE} to "pixel" (no more note) or "screenshot" (try again).`);
  if (shotWatch) { shotWatch.close(); shotWatch = null; }
  if (chatLogWatch) { chatLogWatch.close(); chatLogWatch = null; }
  publishNow(); // the slot files now say "pixel", with the note; the addon follows on its next slot read
  if (cap.enabled && !exitWhenIdle) startCapture();
}

function addonInstalled() {
  return fs.existsSync(path.join(cfg.addonDir, 'ClaudeWoW', 'ClaudeWoW.toc'));
}

function slotsInstalled() {
  return fs.existsSync(path.join(cfg.addonDir, 'ClaudeWoW_S001', 'Inbox.lua'));
}

// The game will load *some* unused slot next, so every slot gets the full picture.
// A missing addon folder (not installed yet, or the game folder moved) must not
// take the bridge down: capture and agent runs keep working, and the game just
// won't see replies until `node setup.js` has run and WoW was restarted.
let warnedNoAddon = false;
function publishNow(urgent = true, { refresh = false } = {}) {
  lastPublish = Date.now();
  const records = [...live.values()].slice(-30);
  try {
    G.atomicWrite(INBOX_FILE, slotFile('ClaudeWoW_Inbox', records, urgent));
  } catch (e) {
    if (!warnedNoAddon) {
      warnedNoAddon = true;
      log(`publish: cannot write ${INBOX_FILE} (${e.code || e.message}); addon not installed? run: node setup.js, then restart WoW`);
    }
    return;
  }
  if (!slotsInstalled()) return;
  const body = slotFile('ClaudeWoW_SlotData', records, urgent);
  for (let i = 1; i <= SLOTS; i++) {
    try { G.atomicWrite(path.join(cfg.addonDir, 'ClaudeWoW_S' + pad3(i), 'Inbox.lua'), body); } catch {}
  }
  // The restore bundle is large; it rides along once and is then dropped.
  // (The game keeps loading fresh slots until it has read one carrying it.)
  if (pendingRestore && !refresh) { pendingRestore.published = (pendingRestore.published || 0) + 1; if (pendingRestore.published >= 3) pendingRestore = null; }
}

// Final results publish immediately; progress is throttled. `key` is the chat
// (record.session is the agent's session id, a different thing).
function publish(key, record, urgent) {
  const named = titles.get(key);
  if (named && !record.title) { record.title = named.title; record.titleFor = named.id; }
  live.set(key, record);
  if (urgent) { if (publishTimer) { clearTimeout(publishTimer); publishTimer = null; } publishNow(); return; }
  const wait = (cfg.progressWriteMs || 3000) - (Date.now() - lastPublish);
  if (wait <= 0) publishNow(false);
  else if (!publishTimer) publishTimer = setTimeout(() => { publishTimer = null; publishNow(false); }, wait);
}

function setSignalFile(file, on) {
  if (on) SIG.fire(file);
  else SIG.arm(file);
}

function signal(kind, id, on) {
  setSignalFile(SIG.signalFile(cfg.addonDir, kind, slotNumber(id)), on);
}

function ackJob(job) {
  acksSent = P.noteAck(acksSent, job);
  signal('ack', job.id, true);
}

function pendingIds() {
  const ids = [...running.values()].map(r => r.job.id).concat([...queued.values()].map(j => j.id));
  for (const r of live.values()) if (r && r.status === 'working') ids.push(r.id);
  return ids;
}

function clearSignalsAhead(id) {
  if (!Number.isFinite(id)) return;
  for (const slot of P.slotsToClearAhead(id, SLOTS, pendingIds())) SIG.armSlot(cfg.addonDir, slot, ACT_MAX);
}

const ACT_MAX = cfg.actMax || SIG.DEFAULT_ACT_MAX;
function actFile(id, k) {
  return SIG.actFile(cfg.addonDir, slotNumber(id), k);
}
function resetBeats(id) {
  for (let k = 1; k <= ACT_MAX; k++) setSignalFile(actFile(id, k), false);
}
function beat(job) {
  job.beats = (job.beats || 0) + 1;
  if (job.beats > ACT_MAX) return;
  setSignalFile(actFile(job.id, job.beats), true);
}

const PRESENCE_MAX = cfg.presenceMax || SIG.DEFAULT_PRESENCE_MAX;
const PRESENCE_INTERVAL_MS = cfg.presenceIntervalMs || 30000;
function presenceReady() {
  return fs.existsSync(SIG.presenceDir(cfg.addonDir));
}
function preparePresence() {
  if (!presenceReady()) return;
  const r = SIG.preparePresence(cfg.addonDir, state.presence, PRESENCE_MAX);
  state.presence = r.state;
  saveState();
  log(`presence: ring ${r.state.ring} at ${r.state.at} of ${PRESENCE_MAX}${r.made ? `, armed ${r.made} file(s)` : ''}${r.removed ? `, removed ${r.removed} stale file(s)` : ''}`);
}
function presenceBeat() {
  if (!presenceReady()) return;
  state.presence = SIG.presenceState(state.presence);
  const r = SIG.beat(cfg.addonDir, state.presence, PRESENCE_MAX);
  if (r.switched) log(`presence: ring ${r.switched} spent and armed again for the next game launch; beating on ring ${r.ring}`);
  saveState();
  if (Date.now() - lastPublish >= PRESENCE_INTERVAL_MS) publishNow(false, { refresh: true });
}
function presenceInfo() {
  if (!presenceReady()) return null;
  const p = SIG.presenceState(state.presence);
  return { scheme: SIG.SCHEME, ring: p.ring, at: p.at, n: PRESENCE_MAX, probe: p.probe };
}
function noteSignalReport(job) {
  if (!job.presenceTest && !job.lateCreate) return;
  const prev = state.presenceTest || {};
  const next = { result: job.presenceTest || prev.result || '', late: job.lateCreate || prev.late || '' };
  if (next.result === prev.result && next.late === prev.late) return;
  state.presenceTest = { ...next, at: new Date().toISOString(), session: job.session || '' };
  saveState();
  log(`${tagOf(job)} signal self-test from the game: deleting a launch-time file ${next.result === 'passed' ? 'reads as missing (presence beats work)' : next.result === 'failed' ? 'does NOT read as missing (the addon uses slot polls only)' : 'not decided yet'}; a file created after launch is ${next.late || 'not checked yet'}`);
}
function placeProbe(job) {
  if (!job.probe || !presenceReady()) return;
  SIG.placeProbe(cfg.addonDir, job.probe);
  if (!fs.existsSync(SIG.probeFile(cfg.addonDir, job.probe))) return;
  state.presence = { ...SIG.presenceState(state.presence), probe: job.probe };
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

// The reload path: the addon writes its outbox into SavedVariables on /reload.
function readOutbox() {
  let src;
  try { src = fs.readFileSync(SAVED_VARS, 'utf8'); } catch { return null; }
  return P.parseOutbox(src);
}

// The addon sends the player's in-game context (character, location, ...) with
// its hello and again whenever it changes; an empty one means "context off".
// It is kept in state.json so a restarted bridge still has it, and goes at the
// top of every message (protocol.messagePrompt); its presence puts the game
// rules and the primer into the system prompt (protocol.systemPrompt).
function setContext(job) {
  const text = String(job.ctx || '').replace(/\r/g, '').trim().slice(0, 2000);
  const prev = (state.context && state.context.text) || '';
  if (text === prev) { noteContextHeard(); return; }
  const heardAt = Date.now();
  state.context = text ? { text, at: heardAt, receivedAt: heardAt, session: job.session || '' } : null;
  saveState();
  const who = (text.split('\n').find(l => /^Character:/i.test(l)) || text.split('\n')[0] || '').slice(0, 100);
  log(`#${job.id}${job.session ? '@' + job.session : ''} game context ${text ? 'updated: ' + who : 'cleared'}`);
}

function noteContextHeard() {
  if (state.context) state.context.receivedAt = Date.now();
}

function gameContext() {
  if (cfg.gameContext === false) return '';
  return (state.context && state.context.text) || '';
}

const loggedDataChecks = new Set();
function noGameDataLine(clientBuild) {
  const flavor = DSYNC.flavorForBuild(clientBuild);
  if (!clientBuild) return 'wowdata: the game has not reported its client build, so no game data is picked; ask runs go without it';
  if (!flavor) return `wowdata: client ${clientBuild} is neither Forever (1.60.*) nor Classic Era (1.15.*); ask runs go without game data`;
  return `wowdata: no synced game data for ${DSYNC.FLAVORS[flavor].label} under ${HOME.data}; ask runs go without it (${DSYNC.syncCommand(flavor)})`;
}
function gameDataServer(tag) {
  let server = null;
  try {
    server = DM.launchConfig({ dataDir: HOME.data, clientBuild: GD.clientBuildOf((state.context && state.context.text) || '') });
  } catch (e) {
    log(`${tag} wowdata unavailable: ${e.message}`);
    return null;
  }
  const clientBuild = GD.clientBuildOf((state.context && state.context.text) || '');
  const check = server ? `${server.flavor}:${server.build}:${server.clientBuild}:${server.buildCheck}` : `none:${clientBuild}`;
  if (!loggedDataChecks.has(check)) {
    loggedDataChecks.add(check);
    if (!server) log(noGameDataLine(clientBuild));
    else if (server.buildCheck === GD.BUILD_CHECK.mismatch) log(`wowdata: data build ${server.build} is not in the client's build family (${server.clientBuild}); answers are labeled build-mismatch`);
  }
  return server;
}

// The addon/macro primer that goes into the system prompt while the addon sends
// a context. Read on every run so edits count without a restart (Claude Code
// records a chat's system prompt at its first message, so there an edit reaches
// new chats); "" in the config turns
// it off. Relative paths are taken from the repo (docs/WOW-ADDON-PRIMER.md),
// or from the binary's extracted copy of it (assets.js), where an edit lasts
// until the next start.
const PRIMER_FILE = cfg.primerFile === undefined ? 'docs/WOW-ADDON-PRIMER.md' : cfg.primerFile;
const primerPath = () => (path.isAbsolute(PRIMER_FILE) ? PRIMER_FILE : AS.file(PRIMER_FILE));
let warnedNoPrimer = false;
function primer() {
  if (!PRIMER_FILE) return '';
  const file = primerPath();
  try { return fs.readFileSync(file, 'utf8'); } catch (e) {
    if (!warnedNoPrimer) { warnedNoPrimer = true; log(`primer: cannot read ${file} (${e.code || e.message}); running without it`); }
    return '';
  }
}

// Persist newly allowed rules for an agent so they stick across bridge restarts.
// They go under agents.<id>.allowedTools; a config.json from before agents
// existed keeps Claude's list at the top level, which moves down on first write.
function allowRules(agentId, rules) {
  const current = new Set(A.agentConfig(cfg, agentId).allowedTools || []);
  const added = rules.filter(r => r && !current.has(r));
  if (!added.length) return [];
  const list = [...current, ...added];
  cfg.agents = cfg.agents || {};
  cfg.agents[agentId] = { ...(cfg.agents[agentId] || {}), allowedTools: list };
  try {
    const onDisk = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    onDisk.agents = onDisk.agents || {};
    onDisk.agents[agentId] = { ...(onDisk.agents[agentId] || {}), allowedTools: list };
    if (agentId === 'claude') delete onDisk.allowedTools;
    atomicWrite(CONFIG_FILE, JSON.stringify(onDisk, null, 2) + '\n');
  } catch (e) { log('could not save config.json:', e.message); }
  return added;
}

// ---------------------------------------------------------------------------
// Running an agent
// ---------------------------------------------------------------------------

function submit(job) {
  if (TL.isTelemetry(job)) {
    if (!TELEMETRY_ON) return;
    let applied = null;
    try { applied = telemetry.submit(job); } catch (e) { log(`telemetry: gs #${job.id} not applied (${e && e.message ? e.message : e})`); }
    if (applied && applied.status === 'applied') {
      if (CAMPAIGN.contextIsFor(state.context, job.name)) noteContextHeard();
      try { campaignStore.onEvents(job.name, applied.events); } catch (e) { log(`campaign: beat trigger check failed (${e && e.message ? e.message : e})`); }
    }
    return;
  }
  if (job.shot) fallbackToPixel(job.shot, job); // even for a message already handled: the report stands
  noteSignalReport(job);
  if (alreadyHandled(job)) {
    acksSent = P.noteAck(acksSent, job);
    return;
  }
  clearSignalsAhead(job.id);
  if (CAMPAIGN.isDmRecord(job)) {
    markHandled(job);
    saveState();
    ackJob(job);
    let result = { fired: false, text: 'not a known DM request; ignored' };
    if (job.text === CAMPAIGN.MANUAL_TEXT) {
      try { result = campaignStore.manual(job.name); } catch (e) { result = { fired: false, text: `failed (${e && e.message ? e.message : e})` }; }
    }
    log(`${tagOf(job)} /dm next for ${String(job.name || '-').slice(0, 64).replace(/[\x00-\x1f\x7f]/g, '?')}: ${result.text}`);
    if (!result.fired) publishNow();
    return;
  }
  if (job.ctx !== undefined) setContext(job);
  else noteContextHeard();
  if (job.forget) {
    // A deleted chat: forget it and ack. No agent run.
    markHandled(job);
    forgetChat(job);
    saveState();
    ackJob(job);
    publishNow();
    return;
  }
  if (job.cancel) {
    markHandled(job);
    saveState();
    ackJob(job);
    cancelRun(job);
    publishNow();
    return;
  }
  if (job.hello) {
    // The addon announcing itself: ack, offer a restore if its data is fresh,
    // and refresh the slots so it can read our clock. No agent run.
    markHandled(job);
    mapShare.onHello(job);
    placeProbe(job);
    presenceBeat();
    saveState();
    ackJob(job);
    maybeOfferRestore(job);
    // Even an empty set: a client holding layers from a reset bridge must drop them.
    mapShare.touch();
    widgetShareUntil = Date.now() + WIDGET_SHARE_MS;
    publishNow();
    log(`hello from session ${job.session}${pendingRestore ? ' (restore offered)' : ''}`);
    return;
  }
  const key = chatKey(job);
  const cur = running.get(key);
  if (cur && cur.job.id === job.id) return;
  const q = queued.get(key);
  if (q && q.id === job.id) return;
  if (cur || running.size >= MAX_PARALLEL) {
    queued.set(key, job);
    log(`#${job.id}${job.session ? '@' + job.session : ''} queued (${cur ? 'chat busy' : running.size + ' running'})`);
    return;
  }
  runJob(job);
}

function cancelRun(job) {
  const key = chatKey(job);
  const q = queued.get(key);
  if (q && q.id === job.cancel) {
    queued.delete(key);
    markHandled(q);
    saveState();
    log(`${tagOf(q)} cancelled from the game before it started`);
    return;
  }
  const cur = running.get(key);
  if (cur && cur.job.id === job.cancel) {
    cur.job.cancelled = true;
    log(`${tagOf(cur.job)} cancelled from the game; ending it and everything it started`);
    revokeRunGrant(cur.job);
    if (cur.child) killTree(cur.child);
    return;
  }
  log(`${tagOf(job)} cancel for #${job.cancel}: nothing is running for that message`);
}

// Is this message already running or waiting its turn? (A retried strip.)
function inFlight(job) {
  const key = chatKey(job);
  const cur = running.get(key), q = queued.get(key);
  return !!((cur && cur.job.id === job.id) || (q && q.id === job.id));
}

function drainQueue() {
  if (shuttingDown) return; // a run ending under the shutdown must not start the next one
  for (const [key, job] of queued) {
    if (running.size >= MAX_PARALLEL) break;
    if (running.has(key)) continue;
    queued.delete(key);
    runJob(job);
  }
}

const tagOf = job => `#${job.id}${job.session ? '@' + job.session : ''}`;

// A message the addon sent: acknowledge it, decide which plugin it belongs to
// (plugins.js: an address in the text, the chat's binding, a plugin's match(),
// else the default), and hand it over.
function runJob(job) {
  const tag = tagOf(job);
  signal('sig', job.id, false);
  resetBeats(job.id);
  ackJob(job);
  if (job.resume && !job.liveTarget) {
    const found = resolveResume(job);
    if (found.error) {
      log(`${tag} resume ${job.resume}: ${found.error.split('\n')[0]}`);
      finish(job, 'error', found.error);
      return;
    }
    adoptSession(job, found.session);
  }
  const r = registry.route(job, { fallback: DEFAULT_PLUGIN });
  if (r.error) {
    log(`${tag} ${r.error}`);
    finish(job, 'error', `${r.error}\nUse /claude config plugin <name> to pick one, or /claude config plugin default for the bridge's default (${DEFAULT_PLUGIN}).`);
    return;
  }
  job.plugin = r.plugin.id;
  if (job.adopted) {
    (state.sessionPlugin = state.sessionPlugin || {})[sessKey(job)] = job.plugin;
    saveState();
  }
  if (r.text !== undefined) job.text = r.text; // "@ask ..." addressed it; the address is not part of the prompt
  const failed = e => {
    log(`${tag} ${r.plugin.id}: ${e && e.stack ? e.stack : e}`);
    finish(job, 'error', `The ${r.plugin.id} plugin failed: ${e && e.message ? e.message : e}`);
  };
  let handled;
  try { handled = r.plugin.handle(job, core); } catch (e) { failed(e); return; }
  if (handled && typeof handled.then === 'function') handled.then(null, failed);
}

// What a plugin's handle(job, core) may use: the model runner, the bridge's
// folder, and the sessions the core keeps per chat.
const core = {
  log,
  tag: tagOf,
  get defaultCwd() { return DEFAULT_CWD; },
  // That plugin's block in config.json (plugins.<id>), or nothing.
  options: id => (pluginsCfg[id] && typeof pluginsCfg[id] === 'object' ? pluginsCfg[id] : {}),
  // The folder the chat's current agent session was made in, if any.
  sessionFolder: job => (state.sessionCwd && state.sessionCwd[sessKey(job)]) || '',
  fail: (job, text) => finish(job, 'error', text),
  reply: (job, text, denied) => finish(job, 'done', text, undefined, denied),
  late: (job, text) => lateReply(job, text),
  progress: (job, text) => publish(chatKey(job), { chat: job.chat, id: job.id, status: 'working', text, cwd: job.cwd, session: '', agent: job.agent || '', plugin: job.plugin || '' }, true),
  accept: (job) => { maybeOfferRestore(job); noteMessage(job, 'user', job.text); },
  gameContext: () => gameContext(),
  publish: () => publishNow(),
  get home() { return HOME.dir; },
  get timeoutMs() { return cfg.timeoutMs || 1800000; },
  get liveStartCommand() { return liveStartCommand(); },
  get liveHome() { return liveHomeArg(); },
  get claudeDir() { return CLAUDE_DIR; },
  runAgent,
  goals: (tool, args) => {
    if (OT.TOOL_NAMES.includes(tool)) return observedTools.call(tool, args);
    if (CAMPAIGN.TOOL_NAMES.includes(tool)) return campaignStore.call(tool, args);
    return goalStore.call(tool, args);
  },
  gameData: () => GR.openFor(HOME.data, (state.context && state.context.text) || ''),
  get runGrants() { return runGrants; },
  agentPids: () => [...running.values()].map(r => r.child).concat(T.titleChildren()).filter(Boolean).map(c => c.pid),
};

const runGrants = GM.createRunGrants({
  call: (tool, args) => core.goals(tool, args),
  character: () => runGrantCharacter(),
  log,
});

const voteBox = VOTES.createVotes({
  config: () => cfg.votes,
  streamOptions: () => core.options('stream'),
  log,
});

const goalStore = GOALS.createBridgeGoals({
  home: HOME,
  context: () => state.context,
  streamOptions: () => core.options('stream'),
  onChange: () => publishNow(true, { refresh: true }),
  equipped: TL.equippedReader(telemetry, TELEMETRY_ON),
  votes: voteBox,
  log,
});

const observedTools = OT.createObservedTools({
  observed,
  context: () => state.context,
  gameData: contextText => {
    try { return GR.openFor(HOME.data, contextText || ''); } catch (e) { log(`observed tools: cannot open the synced game data (${e.message})`); return null; }
  },
  applyMap: applyToolMap,
  log,
});

const campaignStore = CAMPAIGN.createBridgeCampaigns({
  home: HOME,
  context: () => state.context,
  onChange: () => publishNow(true, { refresh: true }),
  standing: TL.standingReader(telemetry, TELEMETRY_ON),
  telemetryOn: TELEMETRY_ON,
  log,
});

function liveHomeArg() {
  return HOME.source === 'CLAUDE_WOW_HOME' ? HOME.dir : '';
}

function liveStartCommand() {
  return LP.startCommand({ repo: REPO, home: liveHomeArg() });
}

function lateReply(job, raw) {
  const { text, summary } = P.splitSummary(String(raw || ''));
  noteMessage(job, 'assistant', text);
  publish(`${chatKey(job)}#late`, { chat: job.chat, id: job.id, status: 'done', late: true, text, summary, cwd: job.cwd, agent: job.agent || '', plugin: job.plugin || '' }, true);
  mapShare.onReplyPublished();
  log(`${tagOf(job)} late reply delivered (${text.length} chars)`);
}

function livePlugin() {
  const p = registry.get('live');
  return p && typeof p.status === 'function' ? p : null;
}

function startPlugins() {
  for (const p of registry.all()) {
    if (typeof p.start !== 'function') continue;
    try { p.start(core); } catch (e) { log(`${p.id}: could not start (${e.message})`); }
  }
}

function stopPlugins() {
  for (const p of registry.all()) {
    if (typeof p.stop !== 'function') continue;
    try { p.stop(); } catch {}
  }
}

// Run the chat's agent on the message, in opts.cwd, and publish what it says.
// opts.freshSession() may name a reason to start a new session instead of
// resuming (the coding plugin: the folder changed). The plugin's own
// instructions (tools) go into the system prompt; its surfaces say whether the
// run may mark the map and whether macro blocks in the reply become buttons.
const IN_GAME_NEVER_GRANTED = LP.GOAL_WRITE_TOOLS;
function neverOffered(denied) {
  return rule => GM.isRunToolRule(rule) || GM.deniedBy(denied, rule);
}
function inGameGrantable(rules, denied) {
  const blocked = neverOffered(denied);
  return P.withoutRules(rules, IN_GAME_NEVER_GRANTED).filter(r => !blocked(r));
}
function homeReadDenies(plugin) {
  const homeReads = homeDirs().map(dir => P.absolutePathRule('Read', path.join(dir, '**')));
  return plugin.searchesFiles === true ? homeReads : [...GM.FILE_SEARCH_TOOLS, ...homeReads];
}
function inGameDeniedTools({ claudeRun, plugin, withRunTools }) {
  return [
    ...LP.GOAL_WRITE_TOOLS,
    ...(withRunTools ? GM.DENIED_WITH_TOOLS : GM.DENIED_WITHOUT_TOOLS),
    ...homeGuardRules(),
    ...(claudeRun ? homeReadDenies(plugin) : []),
  ];
}

const loggedNoRunTools = new Set();
function noRunTools(tag, why) {
  if (loggedNoRunTools.has(why)) return '';
  loggedNoRunTools.add(why);
  log(`${tag} ${GM.SERVER_NAME}: ${why}, so in-game runs go without the goal, order and campaign tools`);
  return '';
}
function runToolsSocket(tag) {
  const lp = livePlugin();
  const socket = lp && typeof lp.runEndpoint === 'function' ? lp.runEndpoint() : '';
  if (!socket) return noRunTools(tag, 'the live socket is not listening (plugins.live.enabled, or --once)');
  if (!runGrantCharacter()) return noRunTools(tag, 'the game context names no character');
  return socket;
}
function runGrantCharacter() {
  return (GOALS.characterOf((state.context && state.context.text) || '') || {}).key || '';
}

const MCP_CONFIG_DIR = path.join(TMP_DIR, 'mcp');
if (holdsLock) { try { fs.rmSync(MCP_CONFIG_DIR, { recursive: true, force: true }); } catch {} }
function writePrivateFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, content, { mode: 0o600, flag: 'wx' });
  fs.chmodSync(file, 0o600);
}

function homeDirs() {
  let real = HOME.dir;
  try { real = fs.realpathSync(HOME.dir); } catch {}
  return [...new Set([HOME.dir, real])];
}

function homeGuardRules() {
  const mcpDir = path.relative(HOME.dir, MCP_CONFIG_DIR);
  return homeDirs().flatMap(dir => [
    P.absolutePathRule('Read', LP.tokenFile(dir)),
    P.absolutePathRule('Edit', path.join(dir, path.basename(HOME.goals), '**')),
    P.absolutePathRule('Read', path.join(dir, mcpDir, '**')),
  ]);
}

function revokeRunGrant(job) {
  if (job && job.runGrantId && runGrants.revoke(job.runGrantId)) log(`${tagOf(job)} ${GM.SERVER_NAME} grant revoked before the run is ended`);
}

function runAgent(job, opts = {}) {
  const key = chatKey(job);
  const cwd = opts.cwd || DEFAULT_CWD;
  const tag = tagOf(job);
  const plugin = registry.get(job.plugin) || { id: '', tools: '', surfaces: [] };
  const surfaces = new Set(plugin.surfaces);
  // Which agent: the chat's own (an "agent=" flag), else the bridge's default.
  const agentId = job.agent ? A.normalizeAgent(job.agent) : DEFAULT_AGENT;
  if (!agentId) {
    log(`${tag} unknown agent "${job.agent}"`);
    finish(job, 'error', `Unknown agent "${job.agent}". This bridge knows: ${A.agentIds().join(', ')}.\n` +
      `Use /claude -c --agent <name> to pick one, or /claude -c --agent default for the bridge's default (${DEFAULT_AGENT}).`);
    return;
  }
  job.agent = agentId;
  const agent = A.AGENTS[agentId];
  const chosen = chatSettings(job);
  const claudeRun = agentId === 'claude';
  const runToolSocket = claudeRun && opts.runTools ? runToolsSocket(tag) : '';
  const runDenied = inGameDeniedTools({ claudeRun, plugin, withRunTools: !!runToolSocket });
  const grantForGood = P.splitGrants(inGameGrantable(job.allow, runDenied));
  const grantOnce = P.splitGrants(inGameGrantable(job.allowOnce, runDenied));
  if (grantForGood.rules.length) {
    const added = allowRules(agentId, grantForGood.rules);
    log(`${tag} allowed for ${agentId}: ${grantForGood.rules.join(', ')}${added.length ? '' : ' (already allowed)'}`);
  }
  if (grantOnce.rules.length) {
    log(`${tag} allowed for this run only (${agentId}): ${grantOnce.rules.join(', ')}`);
  }
  const dataServer = opts.gameData && agentId === 'claude' ? gameDataServer(tag) : null;
  const runOnlyRules = [...grantOnce.rules, ...(dataServer ? dataServer.rules : []), ...(runToolSocket ? GM.RUN_RULES : [])];
  const baseCfg = A.withPluginSettings(A.agentConfig(cfg, agentId), agentId, core.options(plugin.id));
  const acfg = A.withChatSettings(P.withRunDeniedRules(P.withRunOnlyRules(baseCfg, runOnlyRules), runDenied), agentId, chosen);
  const runDirs = [...grantForGood.dirs, ...grantOnce.dirs].map(d => P.resolveCwd(d, DEFAULT_CWD));
  if (runDirs.length) {
    acfg.addDirs = [...new Set([...A.addDirs(acfg), ...runDirs])];
    log(`${tag} folders added for this run only (${agentId}): ${runDirs.join(', ')}`);
  }
  const ignored = A.unsupportedSettings(agentId, chosen);
  const cmd = A.resolveCommand(agentId, acfg);
  if (!cmd.found) {
    log(`${tag} ${agentId} not found: ${cmd.note}`);
    finish(job, 'error', `${agent.name} is not installed on the bridge PC: ${cmd.note}.`);
    return;
  }
  const skey = sessKey(job);
  if (job.newSession) { delete state.sessions[skey]; delete state.sessions[key]; }
  // A session belongs to the plugin and the agent that made it (and, for the
  // coding plugin, its folder), so a chat that changes any of them starts fresh.
  const why = typeof opts.freshSession === 'function' && state.sessions[skey] ? opts.freshSession() : '';
  if (why) {
    log(`${tag} ${why}: new session`);
    delete state.sessions[skey]; delete state.sessions[key];
  }
  const prevAgent = (state.sessionAgent && state.sessionAgent[skey]) || 'claude';
  if (prevAgent !== agentId && state.sessions[skey]) {
    log(`${tag} agent changed (${prevAgent} -> ${agentId}): new session`);
    delete state.sessions[skey]; delete state.sessions[key];
  }
  // Sessions from before plugins existed were all the coding plugin's.
  const prevPlugin = (state.sessionPlugin && state.sessionPlugin[skey]) || 'claude-code';
  if (prevPlugin !== plugin.id && state.sessions[skey]) {
    log(`${tag} plugin changed (${prevPlugin} -> ${plugin.id}): new session`);
    delete state.sessions[skey]; delete state.sessions[key];
  }
  maybeOfferRestore(job);
  noteMessage(job, 'user', job.text);
  const resume = state.sessions[skey] || state.sessions[key];

  // Vision: the game view handleScreenshot cut out for this job, read now (it
  // may have waited in the queue) and handed to the agent as an image.
  const images = [];
  let visionNote = '';
  if (job.image) {
    try {
      images.push({ ...job.image, data: fs.readFileSync(job.image.file).toString('base64') });
    } catch (e) {
      log(`${tag} vision: ${path.basename(job.image.file)} is gone (${e.message}); running without the screen`);
      visionNote = 'The screenshot for this message was gone before the run started, so the agent did not see your screen.';
    }
  } else if (job.vision && TRANSPORT !== 'screenshot') {
    log(`${tag} vision asked for, but the ${TRANSPORT} transport has no screenshot to attach`);
  }
  const image = images[0] || null;

  // The stable system prompt (the same bytes on every run of this chat) and the
  // message, which carries what changes: the situation and the vision note.
  const ctx = gameContext();
  const system = P.systemPrompt(ctx, primer(), { tools: plugin.tools, surfaces: plugin.surfaces, voice: plugin.voice });
  const systemShort = P.systemPrompt(ctx, '', { surfaces: plugin.surfaces, voice: plugin.voice });
  const prompt = P.messagePrompt(job.text, ctx, { image });
  const promptFile = path.join(TMP_DIR, `prompt-${job.id}-${Date.now().toString(36)}.txt`);
  const input = agent.input({ prompt, system, systemShort, resume, cfg: acfg, images });
  if (input.promptFile !== undefined) {
    try { fs.mkdirSync(TMP_DIR, { recursive: true }); fs.writeFileSync(promptFile, input.promptFile); }
    catch (e) { finish(job, 'error', `Could not write the prompt file ${promptFile}: ${e.message}`); return; }
  }
  const runGrant = runToolSocket ? runGrants.grant(tag) : null;
  const runServer = runGrant ? GM.launchConfig({ runId: runGrant.id, token: runGrant.token, socket: runToolSocket }).server : null;
  const mcpJson = GM.mcpConfig({ [DM.SERVER_NAME]: dataServer && dataServer.server, [GM.SERVER_NAME]: runServer });
  const mcpConfigFile = mcpJson ? path.join(MCP_CONFIG_DIR, `mcp-${job.id}-${crypto.randomBytes(8).toString('hex')}.json`) : '';
  if (mcpConfigFile) {
    try { writePrivateFile(mcpConfigFile, mcpJson); }
    catch (e) {
      if (runGrant) runGrants.revoke(runGrant.id);
      if (input.promptFile !== undefined) { try { fs.unlinkSync(promptFile); } catch {} }
      finish(job, 'error', `Could not write the MCP config file ${mcpConfigFile}: ${e.message}`);
      return;
    }
  }
  if (runGrant) job.runGrantId = runGrant.id;
  const args = [...cmd.args, ...agent.args({
    cfg: acfg, resume, cwd, system, systemShort, promptFile, images,
    prompt, timeoutMs: cfg.timeoutMs, mcpConfig: mcpConfigFile,
  })];
  const env = agent.env({ ...process.env });
  // Where this run's tools append map commands (docs/MAP.md); any agent can use
  // it, on a plugin whose replies may reach the map.
  if (surfaces.has('map')) {
    try {
      fs.mkdirSync(MAP_DIR, { recursive: true });
      fs.rmSync(mapFileFor(job), { force: true });
      env.CLAUDE_WOW_MAP_FILE = mapFileFor(job);
    } catch (e) { log(`${tag} map file unavailable: ${e.message}`); }
  }
  if (surfaces.has('ui')) {
    try {
      fs.mkdirSync(WIDGET_DIR, { recursive: true });
      fs.rmSync(widgetFileFor(job), { force: true });
      env.CLAUDE_WOW_UI_FILE = widgetFileFor(job);
    } catch (e) { log(`${tag} ui file unavailable: ${e.message}`); }
  }

  const picked = [acfg.model && 'model ' + acfg.model, acfg.effort && 'effort ' + acfg.effort, chosen.permissionMode && 'mode ' + acfg.permissionMode, (acfg.addDirs || []).length && '+' + acfg.addDirs.length + ' dir(s)', dataServer && 'wowdata ' + dataServer.build + ' ' + dataServer.flavor, runGrant && GM.SERVER_NAME + ' for this run'].filter(Boolean).join(', ');
  log(`${tag} (${job.via}) [${plugin.id}] ${agent.name} starting in ${cwd}${picked ? ' [' + picked + ']' : ''}${resume ? ' (resume ' + resume.slice(0, 8) + ')' : ' (new session)'}${ctx ? ' [game context]' : ''}${image ? ` [screen ${image.width}x${image.height}, ${Math.round(image.bytes / 1024)} KB]` : ''}${running.size ? ' [' + (running.size + 1) + ' running]' : ''}`);
  const startedAt = Date.now(); // a fresh session's clock starts here (the footer's elapsed time)
  const child = PR.spawnChild(cmd.file, args, { cwd, env, windowsHide: true, stdio: [input.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
  running.set(key, { job, child });
  noteInflight(key, job, child, agent.name, path.basename(args.find(a => /\.[cm]?js$/.test(String(a))) || cmd.file));
  publish(key, { chat: job.chat, id: job.id, status: 'working', text: resume ? 'thinking...' : 'starting a new session...', cwd: job.cwd, session: resume, agent: agentId, plugin: plugin.id }, true);
  if (input.stdin !== undefined) { child.stdin.on('error', () => {}); child.stdin.end(input.stdin); }
  if (job.title) nameChat(job, key);

  const granted = P.grantsFor(acfg, cwd);
  const parser = agent.parser({ cwd, granted, isDir: isDirectory, neverOffer: [...IN_GAME_NEVER_GRANTED, ...(acfg.deniedTools || [])], neverOfferIf: neverOffered(acfg.deniedTools || []) });
  job.activity = ACH.createRunLog(agentId);
  const progress = [];
  let sessionId = resume || '';
  let result = null;       // { text, error } once the agent has produced its reply
  let usage = null;        // the last { context, output, window? } the parser saw (agents.js)
  const denied = new Set(); // allowlist rules the run was refused (Claude syntax)
  const deniedAgain = new Set();
  const notes = [];        // bridge remarks appended to the reply
  let stderr = '';
  let buffer = '';
  let stdoutText = '';
  let parserError = false;

  const pushProgress = (line) => {
    progress.push(line);
    while (progress.length > 10) progress.shift();
    beat(job);
    publish(key, { chat: job.chat, id: job.id, status: 'working', text: progress.join('\n'), cwd: job.cwd, session: sessionId, agent: agentId, plugin: plugin.id }, false);
  };
  const noteMcpDown = (servers) => {
    log(`${tag} MCP server(s) not connected: ${servers.map(s => `${s.name} (${s.status})`).join(', ')}`);
    const ours = dataServer && servers.find(s => s.name === DM.SERVER_NAME);
    if (ours) notes.push(`The game data server (${DM.SERVER_NAME}) did not start (${ours.status}), so this answer was not checked against the client data.`);
    const goalsDown = runGrant && servers.find(s => s.name === GM.SERVER_NAME);
    if (goalsDown) notes.push(`The goal tools server (${GM.SERVER_NAME}) did not start (${goalsDown.status}), so no goal, order or campaign was changed by this run.`);
  };
  if (agent.stream === 'text') pushProgress(`${agent.name} is working (no live progress)`);
  if (input.note) notes.push(input.note);
  if (visionNote) notes.push(visionNote);
  if (ignored.length) {
    notes.push(`${agent.name} has no ${ignored.map(f => f.split(' ')[0]).join(', ')} option, so ${ignored.join(', ')} ${ignored.length === 1 ? 'was' : 'were'} ignored.`);
    log(`${tag} ${agent.name} ignores ${ignored.join(', ')}`);
  }
  // Long thinking stretches produce no tool events; keep the heartbeat alive anyway.
  const keepalive = setInterval(() => beat(job), 45000);

  const handleLine = (line) => {
    if (parserError) return;
    let ev;
    try { ev = JSON.parse(line); } catch { return; }
    if (!ev || typeof ev !== 'object') return;
    job.activity.feed(ev);
    let r;
    try {
      r = parser.feed(ev);
      if (!r || !Array.isArray(r.progress) || !Array.isArray(r.denied) || !Array.isArray(r.notes)) {
        throw new Error('agent parser returned an invalid event result');
      }
    } catch (err) {
      parserError = true;
      const detail = err instanceof Error ? err.message : String(err);
      result = { text: `${agent.name} returned an unreadable event.`, error: true };
      notes.push(`${agent.name} event parser failed: ${detail}`);
      log(`${tag} parser error: ${err && err.stack ? err.stack : detail}`);
      return;
    }
    if (r.session) sessionId = r.session;
    if (r.usage) usage = r.usage;
    for (const p of r.progress) pushProgress(p);
    for (const d of r.denied) denied.add(d);
    if (Array.isArray(r.deniedAgain)) for (const d of r.deniedAgain) deniedAgain.add(d);
    if (Array.isArray(r.mcpDown)) noteMcpDown(r.mcpDown);
    notes.push(...r.notes);
    if (r.done) result = r.done;
  };

  child.stdout.on('data', (chunk) => {
    if (agent.stream === 'text') {
      stdoutText += chunk.toString('utf8');
      return;
    }
    buffer += chunk.toString('utf8');
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) handleLine(line);
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

  const timer = setTimeout(() => {
    job.timedOut = true;
    log(`${tag} timed out after ${cfg.timeoutMs || 1800000} ms; ending it and everything it started (SIGTERM, SIGKILL after ${KILL_GRACE_MS} ms)`);
    revokeRunGrant(job);
    killTree(child);
  }, cfg.timeoutMs || 1800000);

  const cleanup = () => {
    clearTimeout(timer);
    clearInterval(keepalive);
    if (runGrant) runGrants.revoke(runGrant.id);
    if (mcpConfigFile) { try { fs.unlinkSync(mcpConfigFile); } catch {} }
    if (input.promptFile !== undefined) { try { fs.unlinkSync(promptFile); } catch {} }
    // The game view was for this run only; the agent has it in its session now.
    if (job.image) { try { fs.unlinkSync(job.image.file); } catch {} }
  };

  child.on('error', (err) => {
    cleanup();
    finish(job, 'error', `Could not start ${agent.name} (${cmd.file}): ${err.message}\nSet agents.${agentId}.path in config.json.`);
  });

  child.on('close', (code) => {
    cleanup();
    if (agent.stream === 'text') {
      try {
        const r = parser.finish({ stdout: stdoutText, stderr, code });
        if (r && r.session) sessionId = r.session;
        if (r && r.done) result = r.done;
        if (r && Array.isArray(r.notes)) notes.push(...r.notes);
      } catch (err) {
        result = { text: `${agent.name} output parser failed: ${err.message}`, error: true };
      }
    }
    if (buffer.trim()) handleLine(buffer.trim());
    if (sessionId) {
      state.sessions[skey] = sessionId;
      (state.sessionCwd = state.sessionCwd || {})[skey] = cwd;
      (state.sessionAgent = state.sessionAgent || {})[skey] = agentId;
      (state.sessionPlugin = state.sessionPlugin || {})[skey] = plugin.id;
      // Context growth: one more turn on this session, and what the next one will carry.
      job.usage = P.noteUsage(state, skey, { usage, fresh: !resume, agent: agentId, startedAt });
    }
    // Map marks count whatever the outcome: the tools already reported them.
    if (surfaces.has('map')) {
      const mapped = takeMapCommands(job, result ? result.text : '');
      if (result) result.text = mapped.text;
      if (mapped.note) notes.push(mapped.note);
    }
    if (surfaces.has('ui')) {
      const widgeted = takeWidgetCommands(job, result ? result.text : '');
      if (result) result.text = widgeted.text;
      if (widgeted.note) notes.push(widgeted.note);
    }
    for (const rule of [...denied]) {
      if (!P.deniedAgain({ kind: 'rule', rule }, granted)) continue;
      denied.delete(rule);
      deniedAgain.add(rule);
      notes.push(`${agent.name} was blocked again on ${rule} although it is already allowed, so allowing it again would not help.`);
    }
    if (deniedAgain.size) log(`${tag} blocked again on ${[...deniedAgain].join(', ')} although already allowed: not offered again`);
    const extra = notes.length ? `\n\n[bridge] ${notes.join('\n\n[bridge] ')}` : '';
    if (result && !result.error) {
      const body = String(result.text || '').trim() || (notes.length ? '' : `(${agent.name} finished without a reply)`);
      finish(job, 'done', (body + extra).trim(), sessionId, [...denied]);
    } else if (result) {
      const said = String(result.text || '').trim() || `${agent.name} reported an error with no message (exit code ${code}).${stderr.trim() ? '\n' + stderr.trim().slice(-1500) : ''}`;
      finish(job, 'error', (said + extra).trim(), sessionId, [...denied]);
    } else if (shuttingDown) {
      finish(job, 'error', `The bridge was stopped while ${agent.name} was still working. Send the message again once it is back.`, sessionId);
    } else if (job.cancelled) {
      finish(job, 'error', 'Cancelled from the game.', sessionId);
    } else if (job.timedOut) {
      const limitMs = cfg.timeoutMs || 1800000;
      const limit = limitMs < 60000 ? `${Math.round(limitMs / 1000)} s` : `${Math.round(limitMs / 60000)} min`;
      finish(job, 'error', `${agent.name} was stopped after ${limit}, the limit set by timeoutMs in config.json. Send the message again, or raise timeoutMs.`, sessionId);
    } else {
      finish(job, 'error', `${agent.name} exited with code ${code} and no result.\n${stderr.trim().slice(-1500)}`, sessionId);
    }
  });
}

function chatSettings(job) {
  return {
    model: job.model || '',
    effort: job.effort || '',
    permissionMode: job.permissionMode || '',
    addDirs: (Array.isArray(job.addDirs) ? job.addDirs : []).map(d => P.resolveCwd(d, DEFAULT_CWD)),
  };
}

function noteInflight(key, job, child, agentName, marker) {
  (state.inflight = state.inflight || {})[key] = { id: job.id, chat: job.chat, session: job.session, cwd: job.cwd, pid: child && child.pid, agent: agentName, marker, startedAt: Date.now() };
  saveState();
}

function recoverInflight() {
  const lost = Object.entries(state.inflight || {});
  if (!lost.length) return;
  for (const [key, run] of lost) {
    if (process.platform !== 'win32' && isSameProcess(run.pid, run.startedAt, run.marker)) {
      try { process.kill(-run.pid, 'SIGKILL'); log(`#${run.id}: ended the orphaned ${run.agent || 'agent'} process group ${run.pid} left by the previous bridge`); } catch {}
    }
    const since = new Date(run.startedAt || Date.now()).toISOString().slice(11, 19);
    const text = `The bridge stopped unexpectedly while ${run.agent || 'the agent'} was working on this message (started ${since} UTC), so its reply is lost. Send it again. The reason is in ${LOG_FILE}.`;
    P.markHandled(state, { session: run.session, chat: run.chat, id: run.id });
    live.set(key, { chat: run.chat, id: run.id, status: 'error', text, cwd: run.cwd });
    ackJob({ session: run.session, id: run.id });
    signal('sig', run.id, true);
    log(`#${run.id}@${run.session || ''} was running when the previous bridge stopped; told the game it is lost`);
  }
  state.inflight = {};
  saveState();
}

const titles = new Map();
const TITLES_KEPT = 60;

const TITLE_WAIT_MS = 4000;

function nameChat(job, key) {
  const model = T.titleModel(cfg);
  if (!model || !String(job.text || '').trim()) return;
  const claude = A.resolveCommand('claude', A.agentConfig(cfg, 'claude'));
  if (!claude.found) { log(`#${job.id} title: claude not found, the chat keeps its first words`); return; }
  try { fs.mkdirSync(TMP_DIR, { recursive: true }); } catch {}
  titles.delete(key);
  job.titlePending = T.generateTitle({ file: claude.file, args: claude.args, model, text: job.text, cwd: TMP_DIR, env: A.AGENTS.claude.env({ ...process.env }) }).then(title => {
    if (!title) { log(`#${job.id} title: ${model} gave none`); return; }
    titles.set(key, { id: job.id, title });
    while (titles.size > TITLES_KEPT) titles.delete(titles.keys().next().value);
    log(`#${job.id} title (${model}): ${title}`);
    const kept = transcripts.chats[job.chat];
    if (kept && (!kept.name || kept.name === job.name)) { kept.name = title; saveTranscripts(); }
    const rec = live.get(key);
    if (rec) publish(key, { ...rec, title: '' }, true);
  });
}

function tellPluginFinished(plugin, job, outcome) {
  if (!plugin || typeof plugin.finished !== 'function') return;
  if (exitWhenIdle) {
    log(`${tagOf(job)} ${plugin.id}: finished hook skipped, this bridge exits when idle (--inject or --once)`);
    return;
  }
  const failed = e => log(`${tagOf(job)} ${plugin.id}: finished hook failed (${e && e.message ? e.message : e})`);
  try {
    const pending = plugin.finished(job, outcome, core);
    if (pending && typeof pending.then === 'function') pending.then(null, failed);
  } catch (e) { failed(e); }
}

function finish(job, status, text, session, denied) {
  if (job.finished) return; // spawn failures fire both 'error' and 'close'
  const named = titles.get(chatKey(job));
  if (status === 'done' && job.titlePending && !job.titleWaited && !(named && named.id === job.id)) {
    job.titleWaited = true;
    const go = () => finish(job, status, text, session, denied);
    Promise.race([job.titlePending, new Promise(r => setTimeout(r, TITLE_WAIT_MS))]).then(go, go);
    return;
  }
  job.finished = true;
  running.delete(chatKey(job));
  if (state.inflight) delete state.inflight[chatKey(job)];
  markHandled(job);
  saveState();
  // A finished reply ends with the "TL;DR:" block the system prompt asks for:
  // that part is what the game chat prints; the window gets the whole reply.
  let summary = '';
  let macros = [];
  const plugin = registry.get(job.plugin);
  if (status === 'done') {
    ({ text, summary } = P.splitSummary(text));
    // After the split: a macro block the agent put after "TL;DR:" must not end up
    // in the game-chat summary. Only a plugin whose replies may carry macros
    // gets the buttons.
    if (plugin && plugin.surfaces.includes('macro')) {
      const m = P.extractMacros(text);
      text = m.text + (m.notes.length ? `\n\n[bridge] ${m.notes.join('; ')}` : '');
      macros = m.macros;
      summary = P.stripMacroBlocks(summary);
    }
  }
  noteMessage(job, status === 'done' ? 'assistant' : 'system', status === 'done' ? text : 'Bridge error: ' + text);
  awardAchievements(job, status);
  const usage = P.usageFields(job.usage);
  publish(chatKey(job), { chat: job.chat, id: job.id, status, text, summary, cwd: job.cwd, session, denied, macros, agent: job.agent || '', plugin: job.plugin || '', lateOk: status === 'error' && !!job.lateOk, ...usage }, true);
  mapShare.onReplyPublished();
  signal('sig', job.id, true);
  tellPluginFinished(plugin, job, { status, text, summary });
  const growth = usage.turns ? `, turn ${usage.turns}${usage.ctx ? ', ctx ' + P.tokensLabel(usage.ctx) + (usage.window ? ' of ' + P.tokensLabel(usage.window) : '') : ''}${usage.cost !== undefined ? ', ~$' + usage.cost.toFixed(2) + ' API so far' : ''}` : '';
  log(`#${job.id}${job.session ? '@' + job.session : ''} ${status} (${text.length} chars${summary ? ', summary ' + summary.length : ', no summary'}${growth})`);
  drainQueue();
  if (exitWhenIdle && running.size === 0 && !shuttingDown) process.exit(status === 'done' ? 0 : 1); // under a shutdown, shutdown() exits
}

// ---------------------------------------------------------------------------
// Input loops
// ---------------------------------------------------------------------------

function pollSavedVariables() {
  let st;
  try { st = fs.statSync(SAVED_VARS); } catch { return; }
  if (st.mtimeMs === lastMtime) return;
  lastMtime = st.mtimeMs;
  const job = readOutbox();
  if (job) submit(job);
}

// Windows: capture.ps1 (GDI). macOS: capture_mac.py (CoreGraphics, screencapture fallback). Elsewhere: capture_x11.py (Wine/X11).
// The scripts are next to this file in a checkout and written out of the binary otherwise (assets.js).
function captureCommand() {
  if (process.platform === 'win32') {
    return ['powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', AS.file('bridge/capture.ps1'),
      '-Cell', String(cap.cellPx), '-Cells', String(cap.cellsPerRow), '-MaxRows', String(cap.maxRows),
      '-IntervalMs', String(cap.intervalMs), '-ProcessName', cap.processName]];
  }
  if (process.platform === 'darwin') {
    const args = [AS.file('bridge/capture_mac.py'),
      '--cell', String(cap.cellPx), '--cells', String(cap.cellsPerRow), '--max-rows', String(cap.maxRows),
      '--interval-ms', String(cap.intervalMs), '--process-name', cap.processName];
    if (cap.windowName) args.push('--window-name', cap.windowName);
    return [cap.python || 'python3', args];
  }
  const args = [AS.file('bridge/capture_x11.py'),
    '--cell', String(cap.cellPx), '--cells', String(cap.cellsPerRow), '--max-rows', String(cap.maxRows),
    '--interval-ms', String(cap.intervalMs), '--process-name', cap.processName];
  if (cap.windowName) args.push('--window-name', cap.windowName);
  if (cap.keepComposited) args.push('--keep-composited');
  return [cap.python || 'python3', args];
}

function startCapture() {
  if (shuttingDown) return;
  const [cmd, args] = captureCommand();
  const ps = captureChild = PR.spawnChild(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const rl = readline.createInterface({ input: ps.stdout });
  rl.on('line', (line) => {
    let ev;
    try { ev = JSON.parse(line); } catch { return; }
    // `hint` is the capture script naming a cause the user can fix (a denied macOS
    // permission, a display scale the decoder cannot read); never swallow it.
    const hint = ev.hint ? `\n         -> ${ev.hint}` : '';
    if (ev.info) { log('capture:', ev.info + hint); return; }
    if (ev.warn) { log('capture:', ev.warn + hint); return; }
    if (ev.error) { log('capture error:', ev.error + hint); return; }
    if (typeof ev.id === 'number') {
      const jobs = jobsFromStrip(ev.id, ev.text);
      log(`strip #${ev.id}: ${jobs.length} message(s)`);
      for (const job of jobs) submit(job);
    }
  });
  ps.stderr.on('data', (d) => log('capture stderr:', String(d).trim().slice(0, 300)));
  ps.on('error', (err) => log(`capture could not start (${cmd}): ${err.message}`));
  ps.on('close', (code) => {
    if (captureChild === ps) captureChild = null;
    if (shuttingDown) return;
    log(`capture exited (${code}); restarting in 5 s`);
    setTimeout(startCapture, 5000);
  });
}

// The screenshot transport: every new WoWScrnShot_*.png/.tga in the game's
// Screenshots folder is decoded once its size settles. A file holding a strip is
// deleted after it was read (whatever the strip's verdict once the magic is
// there, so a retried shot doesn't pile up); one without a strip is the
// player's own screenshot and stays. Files from before the bridge started are
// the sweep's business (sweepScreenshots below): strip-bearing ones go, the rest stay.
const stripOptions = () => ({ cell: cap.cellPx, cells: cap.cellsPerRow, maxRows: cap.maxRows, threshold: LEVELS.threshold });
// The strip the addon is asked to draw, for the banner and the log.
const stripGeometry = () => (STRIP_CODEC === 2
  ? `${D.DENSE.cells}x${D.DENSE.maxRows} cells of ${D.DENSE.cell}px, levels ${P.denseLevels(cap.screenshotLevels).join('/')}`
  : `${cap.cellsPerRow}x${cap.maxRows} cells of ${cap.cellPx}px, levels ${LEVELS.off}/${LEVELS.on}, threshold ${LEVELS.threshold}`);
let shotHint = null;
function handleScreenshot(file) {
  let buf;
  try { buf = fs.readFileSync(file); } catch (e) { log(`screenshot: cannot read ${path.basename(file)} (${e.message})`); return; }
  let img;
  try { img = D.readImage(buf); } catch (e) { log(`screenshot: ${path.basename(file)} unreadable (${e.message}); left alone`); return; }
  const { msg, offset } = D.findStrip(img, stripOptions(), shotHint);
  if (!msg) {
    log(`screenshot: ${path.basename(file)} (${img.width}x${img.height} ${img.format}) holds no strip; left alone`);
    return;
  }
  shotHint = offset;
  if (msg.error) {
    log(`screenshot: strip in ${path.basename(file)} rejected: ${msg.error}` + (msg.error === 'checksum' ? ' (is the strip drawn at 1 UI unit per pixel?)' : ''));
  } else {
    const jobs = jobsFromStrip(msg.id, msg.text).map(job => ({ ...job, via: 'screenshot' }));
    log(`strip #${msg.id} (screenshot ${path.basename(file)}, ${img.width}x${img.height} ${img.format}, codec ${msg.codec}, ${msg.rows} row(s)): ${jobs.length} message(s)`);
    // Vision: the frame below the strip is the game as the player saw it. Cut
    // it out once for the messages that asked, before the file goes (not for a
    // retried shot of a message already handled or under way: no orphan file).
    const seeing = jobs.filter(job => job.vision && !job.hello && !job.forget && !alreadyHandled(job) && !inFlight(job));
    if (seeing.length) attachGameView(img, offset[1] + msg.height, seeing, path.basename(file));
    for (const job of jobs) submit(job);
  }
  try { fs.unlinkSync(file); } catch (e) { log(`screenshot: could not delete ${path.basename(file)} (${e.message})`); }
}

// Vision: crop the strip's rows off `img`, scale it down and write one PNG per
// job into bridge/tmp (job.image says where; runJob reads and then deletes it).
// The folder never holds more than vision.keep of them: a run that never
// started (bridge killed, chat deleted) must not leave a pile of screenshots.
function attachGameView(img, cropTop, jobs, source) {
  let view, png;
  try {
    view = V.gameView(img, { cropTop, maxWidth: vis.maxWidth });
    png = V.encodePNG(view);
    fs.mkdirSync(TMP_DIR, { recursive: true });
  } catch (e) { log(`vision: could not prepare the game view from ${source} (${e.message}); running without it`); return; }
  for (const job of jobs) {
    const file = path.join(TMP_DIR, V.fileName(job.id));
    try { fs.writeFileSync(file, png); } catch (e) { log(`vision: could not write ${file} (${e.message})`); continue; }
    job.image = { file, width: view.width, height: view.height, mediaType: 'image/png', bytes: png.length };
  }
  pruneVisionFiles(Math.max(1, vis.keep | 0));
  log(`vision: ${source} -> ${view.width}x${view.height} png, ${Math.round(png.length / 1024)} KB, for ${jobs.map(j => '#' + j.id).join(', ')}`);
}

// Keep the newest `keep` vision files in bridge/tmp; 0 sweeps them all (startup).
function pruneVisionFiles(keep) {
  let names = [];
  try { names = fs.readdirSync(TMP_DIR).filter(V.isVisionFile); } catch { return; }
  const files = names.map(name => { const f = path.join(TMP_DIR, name); let m = 0; try { m = fs.statSync(f).mtimeMs; } catch {} return { f, m }; })
    .sort((a, b) => b.m - a.m);
  for (const { f } of files.slice(keep)) { try { fs.unlinkSync(f); } catch {} }
}
pruneVisionFiles(0); // leftovers from a bridge that died mid-run

// Leftover shots. The watcher only sees files that appear while it runs, and
// the addon shoots on every send, so a bridge that was down (or died) while the
// player kept typing leaves a full-screen file per message in the Screenshots
// folder. At startup, and then every SWEEP_MS, S.sweepOrphans deletes the files
// that hold a decodable strip (the same reader and finder handleScreenshot
// uses: magic header plus checksum, which nothing but the addon draws) and
// leaves every other file, i.e. the player's own screenshots, alone. A file
// younger than a minute is the watcher's business, not the sweep's.
const SWEEP_MS = 5 * 60 * 1000;
const sweepMemo = new Map();
function holdsStrip(buf) {
  const img = D.readImage(buf);
  return !!D.findStrip(img, stripOptions(), shotHint).msg;
}
function sweepScreenshots(why) {
  const r = S.sweepOrphans(SCREENSHOT_DIR, holdsStrip, { memo: sweepMemo, log, minAgeMs: why === 'startup' ? 2000 : 60000 });
  if (r.removed.length || r.more) {
    log(`screenshot sweep (${why}): removed ${r.removed.length} leftover strip screenshot(s), ${(r.bytes / 1048576).toFixed(1)} MB` +
      (r.kept ? `; ${r.kept} without a strip left alone` : '') + (r.more ? '; more next time' : ''));
  }
}

let shotWatch = null; // the folder watcher, closed by fallbackToPixel
function startScreenshotWatch() {
  if (TRANSPORT !== 'screenshot') return; // fell back while waiting for the folder
  if (!SCREENSHOT_DIR) { log('screenshot transport: no addonDir in config.json, so no Screenshots folder to watch'); return; }
  if (!fs.existsSync(SCREENSHOT_DIR)) {
    // The client creates it on the first screenshot; look again in a while.
    log(`screenshot transport: ${SCREENSHOT_DIR} does not exist yet; retrying in 10 s`);
    setTimeout(startScreenshotWatch, 10000);
    return;
  }
  shotWatch = S.watchScreenshots(SCREENSHOT_DIR, handleScreenshot, { log });
  log(`screenshot transport: watching ${SCREENSHOT_DIR} (strip codec ${STRIP_CODEC}: ${stripGeometry()})`);
  sweepScreenshots('startup');
  const sweeper = setInterval(() => sweepScreenshots('periodic'), SWEEP_MS);
  if (sweeper.unref) sweeper.unref();
}

let chatLogWatch = null;
function chatLogSlot() {
  const measured = CL.calibratedFiller(Array.isArray(state.chatLogWrites) ? state.chatLogWrites : [], CHAT_LOG.filler);
  return { enabled: CHAT_LOG.enabled && measured.usable, line: CHAT_LOG.line, filler: measured.filler, show: CHAT_LOG.show, bufferSize: measured.size, key: CHAT_LOG.enabled ? chatLogKey() : '' };
}
let refusedFrameToldAt = 0;
function noteRefusedFrame() {
  if (Date.now() - refusedFrameToldAt < SWEEP_MS) return;
  refusedFrameToldAt = Date.now();
  log('chat log transport: ignored a frame line with another key or in the old format. If it was yours, /reload the game so the addon reads the current key; the message goes out by screenshot meanwhile');
}
function chatLogKey() {
  const made = CL.ensureKey(state, crypto.randomBytes);
  if (made.created) saveState();
  return made.key;
}
function noteChatLogWrite(bytes) {
  const before = chatLogSlot();
  state.chatLogWrites = CL.noteWrite(Array.isArray(state.chatLogWrites) ? state.chatLogWrites : [], bytes);
  const after = chatLogSlot();
  if (after.filler === before.filler && after.enabled === before.enabled) return;
  log(after.enabled
    ? `chat log transport: the client writes its chat log every ${after.bufferSize} bytes; padding is now ${after.filler} bytes (was ${before.filler})`
    : `chat log transport: the client writes its chat log every ${after.bufferSize} bytes, more than the padding limit; off until that changes, messages go by screenshot`);
  saveState();
  publishNow();
}
function cleanChatLog(why) {
  if (!CHAT_LOG.clean) return;
  let r;
  try { r = CL.cleanWhenClosed(CHAT_LOG_FILE, CL.clientFolder(cfg)); } catch (e) { log(`chat log clean (${why}): failed (${e.message})`); return; }
  if (!r.cleaned || !r.removed) return;
  if (chatLogWatch) chatLogWatch.resync();
  if (r.grewMeanwhile) {
    log(`chat log clean (${why}): ${path.basename(CHAT_LOG_FILE)} grew while it was cleaned, so it was left at full length: bytes ${r.keptUpTo} to ${r.before} are stale copies of older lines, starting inside a line. Nothing the game wrote is lost`);
    return;
  }
  log(`chat log clean (${why}): the game is closed; removed ${r.removed} transport line(s) from ${path.basename(CHAT_LOG_FILE)}, ${r.before} -> ${r.after} bytes`);
}
function handleLogFrame(frame) {
  if (frame.error) {
    log(`chat log: frame #${frame.lineId} (${frame.chunks} line(s)) rejected: ${frame.error}`);
    return;
  }
  const jobs = jobsFromStrip(frame.id, frame.text).map(job => ({ ...job, via: 'chatlog' }));
  log(`strip #${frame.id} (chat log, ${frame.chunks} line(s)): ${jobs.length} message(s)`);
  for (const job of jobs) submit(job);
}
function startChatLogWatch() {
  if (TRANSPORT !== 'screenshot' || !CHAT_LOG.enabled) return;
  if (!CHAT_LOG_FILE) { log('chat log transport: no addonDir in config.json, so no Logs folder to watch'); return; }
  chatLogWatch = CL.watchChatLog(CHAT_LOG_FILE, handleLogFrame, { log, pollMs: CHAT_LOG.pollMs, onWrite: noteChatLogWrite, key: chatLogKey(), onRefused: noteRefusedFrame });
  log(`chat log transport: watching ${CHAT_LOG_FILE} (lines of ${CHAT_LOG.line}, filler ${chatLogSlot().filler} bytes${CHAT_LOG.show ? ', lines shown in chat' : ''}); screenshots stay as the retry path`);
  if (!CHAT_LOG.clean) return;
  if (process.platform !== 'darwin') {
    log(`chat log transport: WARNING, the bridge cannot tell on ${process.platform} whether the game is running, so it never removes its lines from ${path.basename(CHAT_LOG_FILE)}: the file grows by about ${Math.round(chatLogSlot().filler / 1000)} KB per message. The transport is measured on macOS only.`);
    return;
  }
  cleanChatLog('startup');
  const cleaner = setInterval(() => cleanChatLog('periodic'), SWEEP_MS);
  if (cleaner.unref) cleaner.unref();
}

function agentLine(id) {
  const acfg = A.agentConfig(cfg, id);
  const cmd = A.resolveCommand(id, acfg);
  if (!cmd.found) return `not found - ${cmd.note}`;
  const where = cmd.args.length ? `${cmd.file} ${cmd.args.join(' ')}` : cmd.file;
  const rules = Array.isArray(acfg.allowedTools) ? acfg.allowedTools.length : 0;
  return `${where}  [${acfg.permissionMode || 'acceptEdits'}${id === 'codex' ? '' : ', ' + rules + ' allowed tool rules'}${acfg.model ? ', model ' + acfg.model : ''}]`;
}

function banner() {
  console.log('Claude WoW bridge');
  console.log(`  runtime  : ${R.describe()}`);
  console.log(`  home     : ${HOME.dir}  (${HOME.source === 'legacy' ? 'the layout from before CLAUDE_WOW_HOME; run setup to move it to ' + H.defaultDir() : HOME.source}; config, state, transcripts, log)`);
  console.log(`  folder   : ${DEFAULT_CWD}  (${DEFAULT_CWD_SOURCE}; chats can override with /claude cd)`);
  console.log(`  addons   : ${cfg.addonDir}`);
  console.log(`  addon    : ${addonInstalled() ? 'installed' : 'NOT INSTALLED - run: node setup.js, then restart WoW'}`);
  console.log(`  slots    : ${slotsInstalled() ? SLOTS + ' installed' : 'NOT INSTALLED - run: node setup.js (or node bridge/install-slots.js), then restart WoW'}`);
  console.log(`  capture  : ${!cap.enabled ? 'off' : TRANSPORT === 'screenshot' ? 'screenshot transport' + (TRANSPORT_SOURCE === 'default' ? ' (the default; no screen capture, no permissions, no python)' : ' (capture.mode in config.json)') + ': ' + SCREENSHOT_DIR + ', strip codec ' + STRIP_CODEC + ': ' + stripGeometry() : 'pixel transport, DEPRECATED (' + (TRANSPORT_SOURCE === 'fallback' ? 'FALLBACK: ' + P.transportNote(state.transportFallback) : 'capture.mode in config.json; kept only until Screenshot() is confirmed on Windows and Linux/Wine') + '): screen capture of ' + cap.processName + ', ' + cap.cellsPerRow + 'x' + cap.maxRows + ' cells of ' + cap.cellPx + 'px'}`);
  console.log(`  chat log : ${TRANSPORT === 'screenshot' && CHAT_LOG.enabled ? CHAT_LOG_FILE + ' (capture.chatLog; the first try of each message, with the screenshot as the retry)' : 'off (capture.chatLog in config.json; experimental)'}`);
  console.log(`  vision   : ${TRANSPORT === 'screenshot' ? 'per chat (/claude config vision on, or /claude look <question>); the game view goes out up to ' + vis.maxWidth + 'px wide' : 'needs capture.mode "screenshot" (the pixel capture never sees more than the strip)'}`);
  console.log(`  parallel : up to ${MAX_PARALLEL} chats at once`);
  console.log(`  fallback : ${SAVED_VARS}`);
  console.log(`  plugins  : ${registry.all().map(p => p.id + (p.id === DEFAULT_PLUGIN ? ' (default)' : '')).join(', ')}  (a chat with a folder uses claude-code, one without the default; /claude config plugin overrides)`);
  for (const p of registry.all()) if (typeof p.banner === 'function') console.log(`  ${p.id.padEnd(9)}: ${p.banner(core.options(p.id))}`);
  console.log(`  agent    : ${DEFAULT_AGENT} (default; chats pick their own with /claude --agent)`);
  for (const id of A.agentIds()) console.log(`  ${id.padEnd(9)}: ${agentLine(id)}`);
  console.log(`  sessions : ${Object.keys(state.sessions).length} saved`);
  const ctx = gameContext();
  console.log(`  context  : ${cfg.gameContext === false ? 'off (gameContext in config.json)' : ctx ? (ctx.split('\n').find(l => /^Character:/i.test(l)) || ctx.split('\n')[0]).slice(0, 100) : 'none yet (the addon sends it with its hello; /claude config context in game)'}`);
  console.log(`  primer   : ${!PRIMER_FILE ? 'off (primerFile in config.json)' : primer() ? primerPath() + ' (' + primer().length + ' chars, in the system prompt while the addon sends a context)' : 'NOT FOUND: ' + primerPath()}`);
  console.log('Leave this window open while you play. Ctrl+C to stop.\n');
}

banner();
if (!once) startPlugins();
if (inject !== null) {
  const job = { id: state.lastId + 1, session: '', chat: '', text: inject, cwd: '', newSession: false, via: 'inject', agent: injectAgent || '' };
  if (injectPlugin) job.plugin = injectPlugin;
  if (injectImage) {
    // The whole file is the screen (no strip to crop): what vision does in game, without the game.
    let img;
    try { img = D.readImage(fs.readFileSync(injectImage)); }
    catch (e) { console.error(`--image: cannot read ${injectImage} (${e.message}); PNG or TGA only.`); process.exit(2); }
    job.vision = true;
    attachGameView(img, 0, [job], path.basename(injectImage));
    if (!job.image) process.exit(2);
  }
  submit(job);
} else {
  if (!once) recoverInflight();
  pollSavedVariables();
  if (once) {
    if (running.size === 0) { console.log('nothing pending'); process.exit(0); }
  } else {
    setInterval(pollSavedVariables, cfg.pollMs || 750);
    if (Number.isFinite(state.lastId)) clearSignalsAhead(state.lastId);
    preparePresence();
    presenceBeat();
    setInterval(presenceBeat, PRESENCE_INTERVAL_MS);
    // Fresh slot files right away, so the addon's first slot read tells it which
    // transport this bridge listens on (its hello can't reach a screenshot-mode
    // bridge until it knows to take a screenshot).
    publishNow();
    if (cap.enabled && TRANSPORT === 'screenshot') {
      startScreenshotWatch();
      startChatLogWatch();
    } else if (cap.enabled) {
      if (TRANSPORT_SOURCE === 'fallback') log(`transport: ${P.transportNote(state.transportFallback)}`);
      startCapture();
    }
  }
}
