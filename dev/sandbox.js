'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const DEFAULT_ROOT = path.join(REPO, '.dev', 'sandboxes');
const ACCOUNT = 'DEV#1';
const CLIENT_INTERFACE = '16001';

function forbiddenRoots(home = os.homedir()) {
  return [
    path.join(home, '.claude-wow'),
    path.join(home, 'Library', 'LaunchAgents'),
    path.join(home, 'Library', 'Logs', 'claude-wow'),
    path.join(home, '.claude'),
    '/Applications/World of Warcraft',
    'C:\\Program Files (x86)\\World of Warcraft',
    'C:\\Program Files\\World of Warcraft',
  ].map(p => path.resolve(p));
}

function isWithin(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function assertSafe(p, home = os.homedir()) {
  const abs = path.resolve(p);
  for (const bad of forbiddenRoots(home)) {
    if (isWithin(abs, bad) || isWithin(bad, abs)) throw new Error(`refusing to touch ${abs}: it overlaps a live install path (${bad})`);
  }
  if (/World of Warcraft/i.test(abs) && !abs.includes(`${path.sep}.dev${path.sep}`) && !abs.startsWith(path.resolve(os.tmpdir()))) {
    throw new Error(`refusing to touch ${abs}: it looks like a real game folder`);
  }
  return abs;
}

function layout(dir) {
  const client = path.join(dir, 'client', '_classic_beta_');
  const addons = path.join(client, 'Interface', 'AddOns');
  return {
    dir,
    client,
    addons,
    screenshots: path.join(client, 'Screenshots'),
    savedDir: path.join(client, 'WTF', 'Account', ACCOUNT, 'SavedVariables'),
    saved: path.join(client, 'WTF', 'Account', ACCOUNT, 'SavedVariables', 'ClaudeWoW.lua'),
    home: path.join(dir, 'home'),
    user: path.join(dir, 'user'),
    project: path.join(dir, 'project'),
    agentState: path.join(dir, 'agent'),
    logs: path.join(dir, 'logs'),
    config: path.join(dir, 'home', 'config.json'),
    state: path.join(dir, 'home', 'state.json'),
    transcripts: path.join(dir, 'home', 'transcripts.json'),
    bridgeLog: path.join(dir, 'home', 'bridge.log'),
  };
}

function readExample() {
  return JSON.parse(fs.readFileSync(path.join(REPO, 'bridge', 'config.example.json'), 'utf8'));
}

function buildConfig(L, opts = {}) {
  const cfg = readExample();
  const scale = opts.speed && opts.speed > 1 ? opts.speed : 1;
  Object.assign(cfg, {
    addonDir: L.addons,
    savedVariablesFile: L.saved,
    inboxFile: path.join(L.addons, 'ClaudeWoW', 'Inbox.lua'),
    defaultCwd: L.project,
    tocInterface: opts.tocInterface || CLIENT_INTERFACE,
    slots: opts.slots || 200,
    presenceIntervalMs: Math.max(250, Math.round((opts.presenceIntervalMs || 30000) / scale)),
    pollMs: opts.pollMs || 250,
    timeoutMs: opts.timeoutMs || cfg.timeoutMs || 1800000,
  });
  cfg.capture = Object.assign({}, cfg.capture, { enabled: true, mode: 'screenshot', processName: 'World of Warcraft' }, opts.capture || {});
  cfg.plugins = Object.assign({}, cfg.plugins, { default: opts.plugin || 'claude-code', ask: { cwd: path.join(L.dir, 'ask') } });
  const claude = Object.assign({}, cfg.agents.claude, { path: opts.agentPath || path.join(REPO, 'dev', 'fake-claude.js') });
  cfg.agents = Object.assign({}, cfg.agents, { claude });
  cfg.agent = 'claude';
  if (opts.primerFile !== undefined) cfg.primerFile = opts.primerFile;
  return Object.assign(cfg, opts.config || {});
}

function copyAddon(L) {
  const src = path.join(REPO, 'addon', 'ClaudeWoW');
  const dest = path.join(L.addons, 'ClaudeWoW');
  fs.mkdirSync(dest, { recursive: true });
  for (const f of fs.readdirSync(src)) {
    const target = path.join(dest, f);
    if (f === 'Inbox.lua' && fs.existsSync(target)) continue;
    fs.copyFileSync(path.join(src, f), target);
  }
}

function installAddon(L, env) {
  copyAddon(L);
  const r = spawnSync(process.execPath, [path.join(REPO, 'bridge', 'install-slots.js')], { env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`install-slots failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

function envFor(L, extra = {}) {
  const keep = ['PATH', 'LANG', 'TMPDIR', 'SystemRoot', 'TEMP', 'TMP', 'COMSPEC'];
  const env = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  return Object.assign(env, {
    HOME: L.user,
    USERPROFILE: L.user,
    CLAUDE_WOW_HOME: L.home,
    CLAUDE_WOW_FAKE_STATE: L.agentState,
    CLAUDE_WOW_SANDBOX: L.dir,
  }, extra);
}

function create(name = 'default', opts = {}) {
  const root = path.resolve(opts.root || DEFAULT_ROOT);
  const dir = assertSafe(path.join(root, name));
  if (opts.fresh !== false && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  const L = layout(dir);
  for (const d of [L.addons, L.screenshots, L.savedDir, L.home, L.user, L.project, L.agentState, L.logs]) fs.mkdirSync(assertSafe(d), { recursive: true });
  fs.writeFileSync(path.join(L.project, 'README.md'), '# sandbox project\n');
  const cfg = buildConfig(L, opts);
  fs.writeFileSync(L.config, JSON.stringify(cfg, null, 2) + '\n');
  const env = envFor(L, opts.env);
  const installed = installAddon(L, env);
  fs.writeFileSync(path.join(dir, 'sandbox.json'), JSON.stringify({ name, created: new Date().toISOString(), repo: REPO, opts: { ...opts, root: undefined } }, null, 2) + '\n');
  return { ...L, name, cfg, env, installed };
}

function open(name = 'default', opts = {}) {
  const root = path.resolve(opts.root || DEFAULT_ROOT);
  const dir = assertSafe(path.join(root, name));
  if (!fs.existsSync(path.join(dir, 'sandbox.json'))) throw new Error(`no sandbox at ${dir}; run: npm run dev -- --fresh`);
  const L = layout(dir);
  const cfg = JSON.parse(fs.readFileSync(L.config, 'utf8'));
  return { ...L, name, cfg, env: envFor(L, opts.env) };
}

function writeConfig(sb, patch) {
  const cfg = Object.assign(JSON.parse(fs.readFileSync(sb.config, 'utf8')), patch);
  fs.writeFileSync(assertSafe(sb.config), JSON.stringify(cfg, null, 2) + '\n');
  sb.cfg = cfg;
  return cfg;
}

function signalFile(sb, kind, slot) {
  return path.join(sb.addons, 'ClaudeWoW', kind, String(slot).padStart(3, '0') + '.wav');
}

function seedStaleSignals(sb, kinds, slots) {
  const { SILENT_WAV } = require(path.join(REPO, 'bridge', 'protocol.js'));
  for (const kind of kinds) for (const s of slots) fs.writeFileSync(assertSafe(signalFile(sb, kind, s)), SILENT_WAV);
}

module.exports = { REPO, DEFAULT_ROOT, ACCOUNT, CLIENT_INTERFACE, assertSafe, isWithin, forbiddenRoots, layout, buildConfig, create, open, writeConfig, envFor, signalFile, seedStaleSignals };
