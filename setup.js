#!/usr/bin/env node
'use strict';
// One-shot installer.
//
//   node setup.js [--wow "<client folder>"] [--project "<default work folder>"] [--account <name>]
//
// Finds the WoW: Forever client, copies the addon into Interface\AddOns, writes
// bridge/config.json from the example (if missing), and builds the slot pool.
// Re-running is safe: existing config and generated files are kept, except that
// an explicit --project updates defaultCwd (that is the only way to correct it
// without editing config.json by hand).
//
// An install of this project under one of its old names (wow-ai: the WoWAI
// addon, WoWAI_S### slots, WoWAI.lua saved data; before that wow-claude and
// WoWClaude) is migrated: the saved data is carried over so chats survive, the
// old folders are removed so two addons don't fight over the slash commands and
// /r, and config.json is brought up to date.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// Literal requires: the compiled binary bundles what it can see (runtime.js).
const P = require('./bridge/protocol'); // the addon's name, and its old names
const H = require('./bridge/home');     // CLAUDE_WOW_HOME: where config.json and the state live
const R = require('./bridge/runtime');  // node, bun, or the compiled binary
const A = require('./bridge/agents');   // which agent CLIs this PC has
const ROOT = __dirname;
const BRIDGE = path.join(ROOT, 'bridge');
const ADDON_SRC = path.join(ROOT, 'addon', P.ADDON);
const EXAMPLE = path.join(BRIDGE, 'config.example.json');
let CONFIG = H.resolve().config; // settled in main(), after the legacy layout has been migrated

const args = {};
function parseArgs(argv) {
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) args[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return args;
}

// package.json says node >=22.2, but npm does not enforce engines by default, so a
// too-old node otherwise fails later with something unrelated-looking. Bun (and
// the binary, which is Bun) reports a node version of its own choosing: not checked.
const MIN_NODE = [22, 2];
function checkNode() {
  if (R.bun) return;
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj > MIN_NODE[0] || (maj === MIN_NODE[0] && min >= MIN_NODE[1])) return;
  throw new Error(`Node ${MIN_NODE.join('.')} or newer is required; this is ${process.versions.node}. ` +
    'Install a newer Node (https://nodejs.org) and run setup again.');
}

// The default work folder. Validated, because the README's example is a Windows
// placeholder and path.resolve() would otherwise silently glue it onto the folder
// setup was run from, producing a path that exists nowhere and only fails in game.
function resolveProject(raw) {
  const p = String(raw === true ? '' : raw).trim();
  if (!p) throw new Error('--project needs a folder (e.g. --project ~/code/my-game)');
  const windowsShaped = /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');
  if (windowsShaped && process.platform !== 'win32') {
    throw new Error(`--project "${p}" is a Windows path, but this is ${process.platform}. ` +
      'Pass a path for this machine, e.g. --project ~/code/my-game');
  }
  const abs = path.resolve(p.replace(/^~(?=[\\/]|$)/, os.homedir()));
  if (!fs.existsSync(abs)) {
    throw new Error(`--project "${p}" does not exist (looked in ${abs}). ` +
      'Pass the folder you want the agents to work in, or leave --project off to use the current folder.');
  }
  if (!fs.statSync(abs).isDirectory()) throw new Error(`--project "${p}" is not a folder (${abs})`);
  return abs;
}
// A folder listing, sorted: Node's comes back alphabetical (libuv sorts it),
// Bun's in the order the OS gives, and "the first account" or "the first
// game executable" must be the same choice from a checkout and from the binary.
const listDir = dir => fs.readdirSync(dir).sort();


function isClient(dir) {
  try {
    if (!fs.existsSync(path.join(dir, 'Interface'))) return false;
    const items = listDir(dir);
    // Windows: the game exe. macOS: the .app bundle. Linux (Wine): the Wine exe.
    return items.some(f => /^Wow.*\.exe$/i.test(f) || /\.app$/i.test(f));
  } catch { return false; }
}

function findClient() {
  if (args.wow) {
    if (isClient(args.wow)) return args.wow;
    throw new Error(`--wow "${args.wow}" does not look like a WoW client folder (needs Interface\\ and a game binary)`);
  }
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
  for (const root of roots) {
    for (const flavor of ['_classic_beta_', '_forever_', '_retail_', '_classic_era_', '_classic_']) {
      const dir = path.join(root, flavor);
      if (isClient(dir)) return dir;
    }
  }
  throw new Error('Could not find the WoW client. Pass --wow "<path to World of Warcraft/_classic_beta_>"');
}

function findAccount(client) {
  const base = path.join(client, 'WTF', 'Account');
  let names = [];
  try { names = listDir(base).filter(n => n !== 'SavedVariables' && fs.statSync(path.join(base, n)).isDirectory()); } catch {}
  if (args.account) {
    if (!names.includes(args.account)) throw new Error(`Account "${args.account}" not found under ${base}`);
    return args.account;
  }
  if (!names.length) throw new Error(`No account folder under ${base}. Log into the game once, then run setup again.`);
  if (names.length > 1) console.log(`Several accounts found (${names.join(', ')}); using "${names[0]}". Pass --account to choose another.`);
  return names[0];
}

// The previous names of this project. Chats live in the addon's saved data, so
// carry that over (renaming the globals inside: the game loads a SavedVariables
// file by the addon's name and keeps only the globals the .toc declares), then
// remove the old addon and its slot pool: the game only needs one of each, and
// the old one would still answer /r and the shift-click hook. The old saved
// file is left where it is; nothing here deletes saved data. Agent sessions
// are keyed by chat id in the bridge's state.json, so they follow the chats.
function migrateSavedData(oldName, oldSaved, newSaved) {
  let src = fs.readFileSync(oldSaved, 'utf8');
  for (const g of ['DB', 'MapDB']) src = src.replace(new RegExp('^' + oldName + g + '(\\s*=)', 'm'), P.ADDON + g + '$1');
  fs.writeFileSync(newSaved, src);
}

function migrateOldInstall(client, account) {
  const addons = path.join(client, 'Interface', 'AddOns');
  const savedDir = path.join(client, 'WTF', 'Account', account, 'SavedVariables');
  const newSaved = path.join(savedDir, P.ADDON + '.lua');
  for (const old of P.OLD_ADDONS) { // newest first: WoWAI.lua wins over WoWClaude.lua when both exist
    const oldSaved = path.join(savedDir, old + '.lua');
    if (fs.existsSync(oldSaved) && !fs.existsSync(newSaved)) {
      migrateSavedData(old, oldSaved, newSaved);
      console.log(`migrate  : chats and settings copied from ${path.basename(oldSaved)} to ${path.basename(newSaved)} (${path.basename(oldSaved)} is kept)`);
    }
    let removed = 0;
    for (const name of fs.existsSync(addons) ? fs.readdirSync(addons) : []) {
      if (name === old || new RegExp('^' + old + '_S\\d{3}$').test(name)) {
        fs.rmSync(path.join(addons, name), { recursive: true, force: true });
        removed++;
      }
    }
    if (removed) console.log(`migrate  : removed the old ${old} addon and slot folders (${removed} folder(s))`);
  }
}

function copyAddon(client) {
  const dest = path.join(client, 'Interface', 'AddOns', P.ADDON);
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

// A config.json from before a rename, or from before agents: fix the paths
// that named an old addon, and move Claude's settings under agents.claude next
// to the codex and grok blocks from the example. Everything else is kept.
function upgradeConfig(cfg, example) {
  const notes = [];
  if (P.OLD_ADDON_PATH.test(cfg.inboxFile || '')) {
    cfg.inboxFile = path.join(cfg.addonDir, P.ADDON, 'Inbox.lua');
    notes.push('inboxFile');
  }
  if (P.OLD_SAVED_FILE.test(cfg.savedVariablesFile || '')) {
    cfg.savedVariablesFile = cfg.savedVariablesFile.replace(P.OLD_SAVED_FILE, P.ADDON + '.lua');
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

function writeConfig(client, account) {
  const example = JSON.parse(fs.readFileSync(EXAMPLE, 'utf8'));
  if (fs.existsSync(CONFIG)) {
    const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
    const notes = upgradeConfig(cfg, example);
    // An explicit --project on a re-run is a correction: honour it. Without this
    // there was no way to fix a bad defaultCwd short of editing config.json.
    if (args.project) {
      const want = resolveProject(args.project);
      if (cfg.defaultCwd !== want) { cfg.defaultCwd = want; notes.push('defaultCwd'); }
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
  cfg.addonDir = path.join(client, 'Interface', 'AddOns');
  cfg.inboxFile = path.join(cfg.addonDir, P.ADDON, 'Inbox.lua');
  cfg.savedVariablesFile = path.join(client, 'WTF', 'Account', account, 'SavedVariables', P.ADDON + '.lua');
  cfg.defaultCwd = args.project ? resolveProject(args.project) : process.cwd();
  const exe = listDir(client).find(f => /^Wow.*\.exe$/i.test(f) || /\.app$/i.test(f));
  if (exe) {
    let processName = exe.replace(/\.exe$/i, '');
    // macOS: the process name is the executable inside the .app bundle, not the bundle name.
    if (process.platform === 'darwin' && exe.toLowerCase().endsWith('.app')) {
      const macosDir = path.join(client, exe, 'Contents', 'MacOS');
      try {
        const bins = listDir(macosDir).filter(f => fs.statSync(path.join(macosDir, f)).isFile());
        if (bins.length) processName = bins[0];
      } catch {}
    }
    cfg.capture.processName = processName;
  }
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true }); // the home folder, on a fresh install
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n');
  console.log(`config   : wrote ${CONFIG}`);
  return cfg;
}

// Warnings collected as we go, repeated at the end so they are not scrolled past.
const warnings = [];
function warn(line, hint) {
  warnings.push(hint ? `${line}\n           -> ${hint}` : line);
  console.log(`warning  : ${line}${hint ? `\n           -> ${hint}` : ''}`);
}

// The capture backends off Windows are python3 scripts, so a missing interpreter
// means no messages ever reach the bridge. Reported next to the agent CLIs.
function pythonReport(cfg) {
  if (process.platform === 'win32') return; // capture.ps1 needs no python
  const py = (cfg.capture && cfg.capture.python) || 'python3';
  const r = spawnSync(py, ['--version'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    warn(`python3 not found ("${py}"), and the ${process.platform === 'darwin' ? 'macOS' : 'Linux'} screen capture is a python script`,
      process.platform === 'darwin'
        ? 'Install it with: xcode-select --install (or brew install python3), then run setup again.'
        : 'Install python3 from your package manager, then run setup again.');
    return;
  }
  console.log(`python   : ${(r.stdout || r.stderr).trim()} (${py})`);
}

// macOS: the two permissions the bridge cannot work without, checked for real
// rather than discovered later as a screencapture error repeating once a second.
function macCaptureReport(cfg) {
  if (process.platform !== 'darwin') return;
  const py = (cfg.capture && cfg.capture.python) || 'python3';
  const r = spawnSync(py, [path.join(BRIDGE, 'capture_mac.py'), '--check',
    '--process-name', (cfg.capture && cfg.capture.processName) || 'World of Warcraft'], { encoding: 'utf8' });
  if (r.error) return; // python already reported missing
  const rows = String(r.stdout || '').trim().split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
  if (!rows.length) {
    warn('could not check the macOS screen-capture permissions', `Run it yourself: ${py} bridge/capture_mac.py --check`);
    return;
  }
  const label = { 'screen-recording': 'Screen Recording', window: 'window access', scale: 'display scale' };
  for (const row of rows) {
    const name = label[row.check] || row.check;
    if (row.ok) console.log(`capture  : ${name} OK${row.detail ? ' - ' + row.detail : ''}`);
    else warn(`${name}: ${row.detail || 'not available'}`, row.hint);
  }
}

// Which agent CLIs this PC has, so the last lines of setup can say what is missing.
function agentReport(cfg) {
  const lines = [];
  for (const id of A.agentIds()) {
    const r = A.resolveCommand(id, A.agentConfig(cfg, id));
    lines.push(`  ${A.AGENTS[id].name.padEnd(7)}: ${r.found ? r.file + (r.args.length ? ' ' + r.args.join(' ') : '') : 'not found (' + A.AGENTS[id].install + ')'}`);
  }
  return lines.join('\n');
}

function main() {
try {
  parseArgs(process.argv);
  checkNode();
  // Validate arguments before copying anything, so a bad --project costs nothing.
  if (args.project) args.project = resolveProject(args.project);
  // Config, state and transcripts from a checkout that kept them in bridge/ move
  // to the home folder first, so the config written below lands in one place.
  const carried = H.migrateLegacy();
  const home = H.resolve();
  CONFIG = home.config;
  console.log(`home     : ${home.dir}${home.source === 'CLAUDE_WOW_HOME' ? '  (CLAUDE_WOW_HOME)' : ''}`);
  if (carried.length) console.log(`migrate  : ${carried.join(', ')} copied from ${H.LEGACY_DIR} to ${home.dir}; the bridge reads them there from now on (the copies in bridge/ are no longer used)`);
  const client = findClient();
  console.log(`client   : ${client}`);
  const account = findAccount(client);
  console.log(`account  : ${account}`);
  migrateOldInstall(client, account);
  const { dest, copied } = copyAddon(client);
  console.log(`addon    : ${copied} file(s) -> ${dest}`);
  const cfg = writeConfig(client, account);
  console.log(`project  : ${cfg.defaultCwd}  (change with /claude-wow cd in game, or defaultCwd in config.json)`);
  // A defaultCwd that no longer exists (moved folder, or a bad --project from an
  // earlier run) makes every chat fail with "Folder does not exist" in game.
  if (!fs.existsSync(cfg.defaultCwd)) {
    warn(`the default project folder does not exist: ${cfg.defaultCwd}`,
      'Every chat that has not picked its own folder will fail. Fix it with: ' +
      'node setup.js --project "<folder>"');
  }
  console.log(`agent    : ${cfg.agent} by default (change with /claude-wow agent in game, or "agent" in config.json)`);
  console.log(agentReport(cfg));
  pythonReport(cfg);
  macCaptureReport(cfg);
  console.log('slots    : building the reply-slot pool and signal files...');
  const r = spawnSync(...R.scriptCommand('install-slots'), { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('install-slots.js failed');
  if (warnings.length) {
    console.log(`\n${warnings.length} warning(s) to deal with first:`);
    for (const w of warnings) console.log(`  - ${w}`);
  }
  console.log(`
Done. Next:
  1. Fully quit and relaunch World of Warcraft (it only discovers new addon files at launch).
  2. Enable "Claude WoW" at the character select AddOns screen (the Claude WoW slot ### entries stay enabled).
  3. Start the bridge:  ${R.compiled ? 'claude-wow' : 'npm start'}   (in this terminal${
    process.platform === 'win32' ? '; bridge\\start-window.cmd opens its own window'
    : process.platform === 'darwin' ? '; keep the game windowed or borderless, and check the capture with: npm run probe:mac'
    : '; keep the game borderless/windowed and check the capture with: npm run probe'})
  4. In game:  /claude
`);
} catch (e) {
  console.error('setup failed:', e.message);
  process.exit(1);
}
}

// Run as a script this is the installer; required (tests/setup_test.js) it only
// lends out the pieces, the migration above all.
if (require.main === module) main();
module.exports = { migrateOldInstall, migrateSavedData, copyAddon, upgradeConfig, isClient, parseArgs, main };
