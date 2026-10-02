'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn, spawnSync } = require('child_process');
const luaparse = require('luaparse');
const H = require('../bridge/home');
const LP = require('../bridge/liveproto');

const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : dflt; };
const MODEL = arg('--model', 'claude-haiku-4-5-20251001');
const BASE = path.resolve(arg('--dir', os.tmpdir()));
const EVIDENCE = arg('--evidence', '');
const CLAUDE = arg('--claude', 'claude');
const KEEP = process.argv.includes('--keep');
const PRIME = process.argv.includes('--prime');
const PRIME_TEXT = 'My World of Warcraft client is attached to this session through the claude-wow channel. Answer each claude-wow channel message with the wow_reply tool. Reply OK.';
const STEP_MS = Number(arg('--step-ms', '120000'));

const REPO = path.join(__dirname, '..');
const SRC = path.join(REPO, 'bridge');
const REAL_HOME = path.resolve(H.defaultDir());
fs.mkdirSync(BASE, { recursive: true });
const S = fs.mkdtempSync(path.join(BASE, 'claude-wow-live-'));
const SANDBOX_HOME = path.join(S, 'home');
const TMUX = `cw-live-${process.pid}`;
let bridge = null;

function isInside(dir, p) {
  const rel = path.relative(path.resolve(dir), path.resolve(p));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function abort(why) {
  console.error(`>>> LIVE SESSION TEST ABORTED: ${why}`);
  cleanup();
  process.exit(1);
}

function tmux(...args) {
  return spawnSync('tmux', args, { encoding: 'utf8' });
}

function pane() {
  return tmux('capture-pane', '-p', '-t', TMUX, '-S', '-200').stdout || '';
}

let cleaned = false;
let paneSaved = false;
function savePane() {
  if (!EVIDENCE || paneSaved) return;
  const text = pane();
  if (!text.trim()) return;
  paneSaved = true;
  try {
    fs.mkdirSync(EVIDENCE, { recursive: true });
    fs.writeFileSync(path.join(EVIDENCE, 'tmux-pane.txt'), text);
  } catch (e) { console.error(`evidence: ${e.message}`); }
}

function cleanup() {
  if (cleaned) return;
  cleaned = true;
  savePane();
  if (EVIDENCE) {
    try {
      fs.mkdirSync(EVIDENCE, { recursive: true });
      for (const f of ['bridge.log']) { try { fs.copyFileSync(path.join(SANDBOX_HOME, f), path.join(EVIDENCE, f)); } catch {} }
      try { fs.copyFileSync(path.join(S, 'bridge-stdout.txt'), path.join(EVIDENCE, 'bridge-stdout.txt')); } catch {}
      try { fs.copyFileSync(path.join(ADDONS, 'ClaudeWoW_S001', 'Inbox.lua'), path.join(EVIDENCE, 'slot-S001-Inbox.lua')); } catch {}
    } catch (e) { console.error(`evidence: ${e.message}`); }
  }
  tmux('kill-session', '-t', TMUX);
  if (bridge && bridge.exitCode === null) { try { bridge.kill('SIGTERM'); } catch {} }
  if (!KEEP) fs.rmSync(S, { recursive: true, force: true });
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

const env = { ...process.env, CLAUDE_WOW_HOME: SANDBOX_HOME };
delete env.CLAUDECODE;
delete env.CLAUDE_WOW_PROJECT;
delete env.WOW_AI_PROJECT;
const resolvedHome = H.resolve(env).dir;
if (resolvedHome !== path.resolve(SANDBOX_HOME)) abort(`the bridge home resolves to ${resolvedHome}, not the sandbox ${SANDBOX_HOME}`);
if (isInside(REAL_HOME, resolvedHome) || isInside(resolvedHome, REAL_HOME)) abort(`the bridge home ${resolvedHome} is the real ${REAL_HOME}`);
if (isInside(REAL_HOME, S)) abort(`the sandbox ${S} is inside the real ${REAL_HOME}`);
if (spawnSync('tmux', ['-V']).status !== 0) abort('tmux is not installed');

const ADDONS = path.join(S, 'wow', 'Interface', 'AddOns');
const PROJ = path.join(S, 'proj');
const SAVED = path.join(S, 'wow', 'WTF', 'ClaudeWoW.lua');
fs.mkdirSync(path.join(ADDONS, 'ClaudeWoW'), { recursive: true });
fs.mkdirSync(path.dirname(SAVED), { recursive: true });
fs.mkdirSync(path.join(PROJ, '.claude'), { recursive: true });
fs.mkdirSync(SANDBOX_HOME, { recursive: true });
fs.writeFileSync(path.join(ADDONS, 'ClaudeWoW', 'ClaudeWoW.toc'), '## Interface: 16001\n');

const cfg = JSON.parse(fs.readFileSync(path.join(SRC, 'config.example.json'), 'utf8'));
cfg.addonDir = ADDONS;
cfg.inboxFile = path.join(ADDONS, 'ClaudeWoW_Runtime', 'Inbox.lua');
cfg.savedVariablesFile = SAVED;
cfg.defaultCwd = PROJ;
cfg.capture = { ...cfg.capture, enabled: false, screenshotDir: path.join(S, 'wow', 'Screenshots') };
cfg.plugins = { default: 'ask', ask: { cwd: path.join(S, 'scratch') }, roast: { cwd: path.join(S, 'roast') }, live: { waitMs: 1000 }, stream: { ...require('../bridge/plugins/stream').INERT_OPTIONS } };
cfg.slots = 5;
cfg.pollMs = 300;
for (const p of [cfg.addonDir, cfg.inboxFile, cfg.savedVariablesFile, cfg.defaultCwd, cfg.capture.screenshotDir]) {
  if (!isInside(S, p) || isInside(REAL_HOME, p)) abort(`config path ${p} is outside the sandbox ${S}`);
}
fs.writeFileSync(path.join(SANDBOX_HOME, 'config.json'), JSON.stringify(cfg, null, 2));
fs.writeFileSync(path.join(PROJ, '.mcp.json'), JSON.stringify({ mcpServers: { [LP.SERVER_NAME]: { command: process.execPath, args: [path.join(SRC, 'channel.js')], env: { CLAUDE_WOW_HOME: SANDBOX_HOME }, alwaysLoad: true } } }, null, 2));
fs.writeFileSync(path.join(PROJ, '.claude', 'settings.json'), JSON.stringify({ enableAllProjectMcpServers: true }, null, 2));
console.log(`sandbox: ${S} (CLAUDE_WOW_HOME=${SANDBOX_HOME})`);
console.log(execFileSync(process.execPath, [path.join(SRC, 'install-slots.js')], { cwd: S, env, encoding: 'utf8' }).trim().split('\n')[0]);

function readSlot() {
  const src = fs.readFileSync(path.join(ADDONS, 'ClaudeWoW_S001', 'Inbox.lua'), 'utf8');
  const ast = luaparse.parse(src, { luaVersion: '5.1' });
  const assign = ast.body.find(n => n.type === 'AssignmentStatement' && n.variables[0].name === 'ClaudeWoW_SlotData');
  const val = v => (v.type === 'StringLiteral' ? JSON.parse(v.raw.replace(/\\\n/g, '\\n')) : v.type === 'TableConstructorExpression' ? v.fields.map(x => val(x.value)) : v.value);
  const out = {};
  for (const f of assign.init[0].fields) {
    if (f.key.name === 'replies') {
      out.replies = f.value.fields.map(e => Object.fromEntries(e.value.fields.map(g => [g.key.name, val(g.value)])));
    } else if (f.key.name === 'live') {
      out.live = Object.fromEntries(f.value.fields.map(g => [g.key.name, val(g.value)]));
    }
  }
  return out;
}

function reply(id) {
  try { return (readSlot().replies || []).find(r => Number(r.id) === id) || null; } catch { return null; }
}

const hex = s => Buffer.from(s, 'utf8').toString('hex');
function send(id, text, once) {
  const fields = [`["id"] = ${id}`, '["session"] = "e2e"', '["chat"] = "live1"', `["text"] = "${hex(text)}"`, '["cwd"] = ""', '["plugin"] = "live"',
    `["ctx"] = "${hex('Character: Thrall, level 12 Orc Shaman\nZone: Durotar (Razor Hill) 52.1, 43.0')}"`];
  if (once) fields.push(`["allowOnce"] = "${hex(once)}"`);
  fs.writeFileSync(SAVED, `ClaudeWoWDB = {\n\t["outbox"] = {\n\t\t${fields.join(',\n\t\t')},\n\t},\n}\n`);
  console.log(`\n>>> injected #${id}${once ? ` (allowOnce ${once})` : ''}: ${JSON.stringify(text)}`);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(what, cond, ms = STEP_MS) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = cond();
    if (v) return v;
    await sleep(500);
  }
  abort(`timed out waiting for ${what}\n--- pane ---\n${pane()}\n--- bridge log tail ---\n${bridgeLog().split('\n').slice(-15).join('\n')}`);
}
const bridgeLog = () => { try { return fs.readFileSync(path.join(SANDBOX_HOME, 'bridge.log'), 'utf8'); } catch { return ''; } };

const results = [];
function check(name, ok, detail) {
  results.push(ok);
  console.log(`${ok ? 'ok  ' : 'BAD '} ${name}${detail ? ': ' + detail : ''}`);
}

async function main() {
  const out = fs.openSync(path.join(S, 'bridge-stdout.txt'), 'w');
  bridge = spawn(process.execPath, [path.join(SRC, 'bridge.js'), '--project', PROJ], { cwd: S, env, stdio: ['ignore', out, out] });
  await waitFor('the bridge to listen', () => /live: listening on/.test(bridgeLog()), 15000);
  const addr = bridgeLog().match(/live: listening on (.+)/)[1].trim();
  if (process.platform !== 'win32') check('socket is owner-only (0600)', (fs.statSync(addr).mode & 0o777) === 0o600, `${addr} ${(fs.statSync(addr).mode & 0o777).toString(8)}`);

  send(1, 'hello?');
  const none = await waitFor('the no-session reply', () => { const r = reply(1); return r && r.status !== 'working' ? r : null; }, 20000);
  check('no session: the chat says so and names the command', none.status === 'error' && /No live Claude Code session is connected\. Start one with:\n.*--dangerously-load-development-channels server:claude-wow/.test(none.text), JSON.stringify(none.text));

  const cmd = `env -u CLAUDECODE ${LP.shellQuote(CLAUDE)} ${LP.DEV_FLAG} ${LP.CHANNEL_ARG} --model ${LP.shellQuote(MODEL)} --permission-mode manual --allowedTools mcp__${LP.SERVER_NAME}__${LP.REPLY_TOOL} --setting-sources project,local`;
  console.log(`\n>>> tmux ${TMUX}: ${cmd}`);
  const t = tmux('new-session', '-d', '-s', TMUX, '-x', '180', '-y', '50', '-c', PROJ, cmd);
  if (t.status !== 0) abort(`tmux: ${t.stderr}`);
  const answered = new Set();
  await waitFor('the session to connect', () => {
    const p = pane();
    if (/Yes, I trust this folder/.test(p) && !answered.has('trust')) { answered.add('trust'); tmux('send-keys', '-t', TMUX, 'Down', 'Enter'); }
    else if (/I am using this for local development/.test(p) && !answered.has('dev')) { answered.add('dev'); tmux('send-keys', '-t', TMUX, 'Enter'); }
    else if (/New MCP server found/.test(p) && !answered.has('mcp')) { answered.add('mcp'); tmux('send-keys', '-t', TMUX, 'Enter'); }
    else if (/blocked by org policy|channels are not available|not enabled/i.test(p)) abort(`the CLI refused channels:\n${p}`);
    return /live: session ".*" connected/.test(bridgeLog());
  }, 90000);
  console.log(`dialogs answered: ${[...answered].join(', ') || 'none'}`);
  if (PRIME) {
    const turns = () => (pane().match(/ · done /g) || []).length;
    const before = turns();
    tmux('send-keys', '-t', TMUX, '-l', PRIME_TEXT);
    tmux('send-keys', '-t', TMUX, 'Enter');
    console.log(`\n>>> typed into the session: ${JSON.stringify(PRIME_TEXT)}`);
    await waitFor('the session to take the priming turn', () => turns() > before, 60000);
  }
  const status = await waitFor('the slot files to list the session', () => { try { const l = readSlot().live; return l && l.sessions.length ? l : null; } catch { return null; } }, 10000);
  check('slot files list the connected session', status.sessions.length === 1, JSON.stringify(status.sessions));

  send(2, 'Reply with exactly the word PONG.');
  const pong = await waitFor('the PONG reply', () => { const r = reply(2); return r && r.status === 'done' ? r : null; });
  check('reply comes back through the slot files', /PONG/.test(pong.text) && pong.agent === 'claude' && pong.plugin === 'live', JSON.stringify(pong));

  send(3, 'Use the Bash tool to run exactly: touch roll-test.txt  Then reply saying whether it worked.');
  const roll = await waitFor('the permission roll', () => { const r = reply(3); return r && r.status === 'done' ? r : null; });
  check('a permission request becomes a Need/Greed roll', Array.isArray(roll.denied) && roll.denied[0] === 'Bash(touch:*)' && /Roll Need or Greed/.test(roll.text), JSON.stringify(roll));

  send(4, 'Those actions are allowed for this run. Continue from where you left off.', 'Bash(touch:*)');
  const after = await waitFor('the reply after Greed', () => { const r = reply(4); return r && r.status === 'done' ? r : null; });
  check('Greed allows the call and the answer comes back', fs.existsSync(path.join(PROJ, 'roll-test.txt')), JSON.stringify(after.text));

  send(5, 'Use the Bash tool to run exactly: touch deny-test.txt  Then reply saying whether it worked.');
  await waitFor('the second roll', () => { const r = reply(5); return r && r.status === 'done' ? r : null; });
  send(6, LP.PASS_TEXT);
  const denied = await waitFor('the reply after Pass', () => { const r = reply(6); return r && r.status === 'done' ? r : null; });
  check('Pass denies the call', !fs.existsSync(path.join(PROJ, 'deny-test.txt')), JSON.stringify(denied.text));

  console.log(`\n--- tmux pane ---\n${pane().replace(/\n{3,}/g, '\n\n')}`);
  console.log(`--- bridge log (live lines) ---\n${bridgeLog().split('\n').filter(l => / live: |#\d+@e2e (done|error)/.test(l)).join('\n')}`);
  savePane();
  tmux('kill-session', '-t', TMUX);
  bridge.kill('SIGTERM');
  await waitFor('the bridge to stop', () => bridge.exitCode !== null || bridge.signalCode !== null, 15000);
  if (process.platform !== 'win32') check('socket removed on shutdown', !fs.existsSync(addr), addr);
  const ok = results.every(Boolean);
  console.log(ok ? '\n>>> LIVE SESSION TEST PASS' : '\n>>> LIVE SESSION TEST FAIL');
  cleanup();
  process.exit(ok ? 0 : 1);
}

main().catch(e => abort(e && e.stack ? e.stack : String(e)));
