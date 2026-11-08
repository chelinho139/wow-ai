#!/usr/bin/env node
'use strict';
// One-shot installer.
//
//   node setup.js [--wow "<client folder>"] [--project "<default work folder>"] [--account <name>]
//
// Finds the WoW: Forever client, copies the addon into Interface\AddOns, writes
// bridge/config.json from the example (if missing), and builds the slot pool.
// Re-running is safe: existing config and generated files are kept. A config
// still on the beta client moves to Forever once Forever is installed.
//
// An install of this project under its old name (wow-claude: the WoWClaude
// addon, WoWClaude_S### slots, WoWClaude.lua saved data) is migrated: the saved
// data is carried over so chats survive, the old folders are removed so two
// addons don't fight over /ai and /r, and config.json is brought up to date.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = __dirname;
const ADDON_SRC = path.join(ROOT, 'addon', 'WoWAI');
const BRIDGE = path.join(ROOT, 'bridge');
const CONFIG = path.join(BRIDGE, 'config.json');
const EXAMPLE = path.join(BRIDGE, 'config.example.json');
const { sameFolder } = require(path.join(BRIDGE, 'protocol.js'));

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) args[a.slice(2)] = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : true;
}

function isClient(dir) {
  try {
    if (!fs.existsSync(path.join(dir, 'Interface'))) return false;
    const items = fs.readdirSync(dir);
    // Windows: the game exe. macOS: the .app bundle. Linux (Wine): the Wine exe.
    return items.some(f => /^Wow.*\.exe$/i.test(f) || /\.app$/i.test(f));
  } catch { return false; }
}

// The client folder an existing config.json points at.
function configuredClient() {
  try { return path.dirname(path.dirname(JSON.parse(fs.readFileSync(CONFIG, 'utf8')).addonDir)); } catch { return null; }
}

function findClient() {
  if (args.wow) {
    if (isClient(args.wow)) return args.wow;
    throw new Error(`--wow "${args.wow}" does not look like a WoW client folder (needs Interface\\ and a game binary)`);
  }
  // A re-run stays on its client, unless that's the beta: Forever replaced it.
  const current = configuredClient();
  if (current && isClient(current) && path.basename(current) !== '_classic_beta_') return current;
  let roots;
  if (process.platform === 'win32') {
    roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, 'D:\\', 'E:\\', 'D:\\Games', 'E:\\Games', 'C:\\Games']
      .filter(Boolean).map(r => path.join(r, 'World of Warcraft'));
  } else if (process.platform === 'darwin') {
    roots = ['/Applications/World of Warcraft', path.join(os.homedir(), 'Applications', 'World of Warcraft')];
  } else {
    // Linux: the client lives inside a Wine prefix.
    roots = [process.env.WINEPREFIX, path.join(os.homedir(), '.wine'),
      path.join(os.homedir(), 'Games', 'battlenet')]
      .filter(Boolean).flatMap(p => ['Program Files (x86)', 'Program Files'].map(pf => path.join(p, 'drive_c', pf, 'World of Warcraft')));
  }
  if (current) roots.unshift(path.dirname(current));
  // Tests search a fake install tree and nothing else, never a real game.
  if (process.env.WOWAI_TEST_WOW_ROOT) roots = [process.env.WOWAI_TEST_WOW_ROOT];
  for (const root of roots) {
    // The beta folder can outlive the beta: Forever goes first.
    for (const flavor of ['_forever_', '_classic_beta_', '_retail_', '_classic_era_', '_classic_']) {
      const dir = path.join(root, flavor);
      if (isClient(dir)) return dir;
    }
  }
  throw new Error('Could not find the WoW client. Pass --wow "<path to World of Warcraft/_forever_>"');
}

function findAccount(client) {
  const base = path.join(client, 'WTF', 'Account');
  let names = [];
  try { names = fs.readdirSync(base).filter(n => n !== 'SavedVariables' && fs.statSync(path.join(base, n)).isDirectory()); } catch {}
  if (args.account) {
    if (!names.includes(args.account)) throw new Error(`Account "${args.account}" not found under ${base}`);
    return args.account;
  }
  // The game creates this folder at the first login. Everything else can be
  // installed before that (slots must exist when the game launches); the bridge
  // finds the account by itself once it appears.
  if (!names.length) return null;
  if (names.length > 1) console.log(`Several accounts found (${names.join(', ')}); using "${names[0]}". Pass --account to choose another.`);
  return names[0];
}

// The previous name of this project. Chats live in the addon's saved data, so
// carry that over (renaming the global inside), then remove the old addon and
// its slot pool: the game only needs one of each, and the old one would still
// answer /ai, /r and the shift-click hook.
function migrateOldInstall(client, account) {
  const addons = path.join(client, 'Interface', 'AddOns');
  const savedDir = path.join(client, 'WTF', 'Account', account, 'SavedVariables');
  const oldSaved = path.join(savedDir, 'WoWClaude.lua');
  const newSaved = path.join(savedDir, 'WoWAI.lua');
  if (fs.existsSync(oldSaved) && !fs.existsSync(newSaved)) {
    const src = fs.readFileSync(oldSaved, 'utf8').replace(/^WoWClaudeDB\s*=/m, 'WoWAIDB =');
    fs.writeFileSync(newSaved, src);
    console.log(`migrate  : chats and settings copied from ${path.basename(oldSaved)} to ${path.basename(newSaved)}`);
  }
  let removed = 0;
  for (const name of fs.existsSync(addons) ? fs.readdirSync(addons) : []) {
    if (name === 'WoWClaude' || /^WoWClaude_S\d{3}$/.test(name)) {
      fs.rmSync(path.join(addons, name), { recursive: true, force: true });
      removed++;
    }
  }
  if (removed) console.log(`migrate  : removed the old WoWClaude addon and slot folders (${removed} folder(s))`);
}

function copyAddon(client) {
  const dest = path.join(client, 'Interface', 'AddOns', 'WoWAI');
  fs.mkdirSync(dest, { recursive: true });
  let copied = 0;
  for (const f of fs.readdirSync(ADDON_SRC)) {
    const target = path.join(dest, f);
    if (f === 'Inbox.lua' && fs.existsSync(target)) continue; // the bridge owns it once running
    fs.copyFileSync(path.join(ADDON_SRC, f), target);
    copied++;
  }
  return { dest, copied };
}

// A config.json from before the rename, or from before agents: fix the paths
// that named the old addon, and move Claude's settings under agents.claude next
// to the codex and grok blocks from the example. Everything else is kept.
function upgradeConfig(cfg, example) {
  const notes = [];
  if (/WoWClaude/.test(cfg.inboxFile || '')) {
    cfg.inboxFile = path.join(cfg.addonDir, 'WoWAI', 'Inbox.lua');
    notes.push('inboxFile');
  }
  if (/WoWClaude\.lua$/.test(cfg.savedVariablesFile || '')) {
    cfg.savedVariablesFile = cfg.savedVariablesFile.replace(/WoWClaude\.lua$/, 'WoWAI.lua');
    notes.push('savedVariablesFile');
  }
  if (!cfg.agents) {
    const claude = { ...example.agents.claude };
    if (cfg.claudePath) claude.path = cfg.claudePath;
    if (cfg.model) claude.model = cfg.model;
    if (cfg.permissionMode) claude.permissionMode = cfg.permissionMode;
    if (Array.isArray(cfg.allowedTools)) claude.allowedTools = cfg.allowedTools;
    cfg.agent = cfg.agent || example.agent;
    cfg.agents = { claude, codex: { ...example.agents.codex }, grok: { ...example.agents.grok } };
    for (const k of ['claudePath', 'model', 'permissionMode', 'allowedTools']) delete cfg[k];
    notes.push('agents');
  }
  return notes;
}

function savedVariablesFile(client, account) {
  return account ? path.join(client, 'WTF', 'Account', account, 'SavedVariables', 'WoWAI.lua') : '';
}

// The game exe without .exe, as the capture looks for it.
function processNameOf(client) {
  const exe = fs.readdirSync(client).find(f => /^Wow.*\.exe$/i.test(f) || /\.app$/i.test(f));
  if (!exe) return null;
  let processName = exe.replace(/\.exe$/i, '');
  // macOS: the process name is the executable inside the .app bundle, not the bundle name.
  if (process.platform === 'darwin' && exe.toLowerCase().endsWith('.app')) {
    const macosDir = path.join(client, exe, 'Contents', 'MacOS');
    try {
      const bins = fs.readdirSync(macosDir).filter(f => fs.statSync(path.join(macosDir, f)).isFile());
      if (bins.length) processName = bins[0];
    } catch {}
  }
  return processName;
}

function pointAtClient(cfg, client, account) {
  cfg.addonDir = path.join(client, 'Interface', 'AddOns');
  cfg.inboxFile = path.join(cfg.addonDir, 'WoWAI', 'Inbox.lua');
  cfg.savedVariablesFile = savedVariablesFile(client, account);
  const processName = processNameOf(client);
  if (processName) cfg.capture = { ...cfg.capture, processName };
}

function writeConfig(client, account) {
  const example = JSON.parse(fs.readFileSync(EXAMPLE, 'utf8'));
  if (fs.existsSync(CONFIG)) {
    const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
    const notes = upgradeConfig(cfg, example);
    if (!sameFolder(cfg.addonDir, path.join(client, 'Interface', 'AddOns'))) {
      pointAtClient(cfg, client, account);
      notes.push(`moved to ${path.basename(client)}, process ${cfg.capture.processName}`);
    } else if (account && !cfg.savedVariablesFile) {
      cfg.savedVariablesFile = savedVariablesFile(client, account);
      notes.push('savedVariablesFile');
    }
    if (args.project && !sameFolder(cfg.defaultCwd, path.resolve(args.project))) {
      cfg.defaultCwd = path.resolve(args.project);
      notes.push('defaultCwd');
    }
    if (notes.length) {
      fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n');
      console.log(`config   : ${CONFIG} updated (${notes.join(', ')}); everything else kept`);
    } else {
      console.log(`config   : ${CONFIG} already exists, keeping it`);
    }
    return cfg;
  }
  const cfg = example;
  pointAtClient(cfg, client, account);
  // The agent must not work inside this repo by default: it would be editing the
  // bridge that runs it. Only an explicit --project may point there.
  if (!args.project) {
    const rel = path.relative(ROOT, process.cwd());
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
      throw new Error('pass --project "<folder for the agent to work in>" (for example a notes folder); the wow-ai folder itself is refused as the default');
    }
  }
  cfg.defaultCwd = args.project ? path.resolve(args.project) : process.cwd();
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n');
  console.log(`config   : wrote ${CONFIG}`);
  return cfg;
}

// Which agent CLIs this PC has, so the last lines of setup can say what is missing.
function agentReport(cfg) {
  const A = require(path.join(BRIDGE, 'agents.js'));
  const lines = [];
  for (const id of A.agentIds()) {
    const r = A.resolveCommand(id, A.agentConfig(cfg, id));
    lines.push(`  ${A.AGENTS[id].name.padEnd(7)}: ${r.found ? r.file + (r.args.length ? ' ' + r.args.join(' ') : '') : 'not found (' + A.AGENTS[id].install + ')'}`);
  }
  return lines.join('\n');
}

try {
  const client = findClient();
  console.log(`client   : ${client}`);
  const account = findAccount(client);
  console.log(`account  : ${account || 'none yet (the game creates it at your first login; the bridge picks it up then)'}`);
  if (account) migrateOldInstall(client, account);
  const { dest, copied } = copyAddon(client);
  console.log(`addon    : ${copied} file(s) -> ${dest}`);
  const cfg = writeConfig(client, account);
  console.log(`project  : ${cfg.defaultCwd}  (change with /wow-ai cd in game, or defaultCwd in config.json)`);
  console.log(`agent    : ${cfg.agent} by default (change with /wow-ai agent in game, or "agent" in config.json)`);
  console.log(agentReport(cfg));
  console.log('slots    : building the reply-slot pool and signal files...');
  const r = spawnSync(process.execPath, [path.join(BRIDGE, 'install-slots.js')], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('install-slots.js failed');
  console.log(`
Done. Next:
  1. Fully quit and relaunch World of Warcraft (it only discovers new addon files at launch).
  2. Enable "WoW AI" at the character select AddOns screen (the WoW AI slot ### entries stay enabled).
  3. Start the bridge:  npm start   (in this terminal${process.platform === 'win32' ? '; bridge\\start-window.cmd opens its own window' : '; on Linux keep the game borderless/windowed and check the capture with: npm run probe'})
  4. In game:  /wow-ai
`);
} catch (e) {
  console.error('setup failed:', e.message);
  process.exit(1);
}
