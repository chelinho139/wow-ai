// setup.js against fake install trees: which client it picks and what config it
// leaves, with the beta folder still on disk and with existing installs.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');

// A copy of the code (setup.js works next to itself) and an empty install tree.
function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wowai-setup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(path.join(repo, 'bridge'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'setup.js'), path.join(repo, 'setup.js'));
  fs.cpSync(path.join(REPO, 'addon'), path.join(repo, 'addon'), { recursive: true });
  for (const f of fs.readdirSync(path.join(REPO, 'bridge'))) {
    if (f.endsWith('.js') || f === 'config.example.json') fs.copyFileSync(path.join(REPO, 'bridge', f), path.join(repo, 'bridge', f));
  }
  return { repo, wow: path.join(dir, 'World of Warcraft') };
}

function client(s, flavor, exe, account) {
  const dir = path.join(s.wow, flavor);
  fs.mkdirSync(path.join(dir, 'Interface', 'AddOns'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'WTF', 'Account', 'SavedVariables'), { recursive: true });
  if (account) fs.mkdirSync(path.join(dir, 'WTF', 'Account', account, 'SavedVariables'), { recursive: true });
  fs.writeFileSync(path.join(dir, exe), '');
  fs.writeFileSync(path.join(dir, 'BlizzardError.exe'), '');
  return dir;
}

function setup(s, ...args) {
  // Replaces the search list outright: this must never find a real game on the
  // machine running the tests (it would install into it).
  const env = { ...process.env, WOWAI_TEST_WOW_ROOT: s.wow };
  // A fresh install needs --project (setup refuses the repo as the default folder); re-runs keep the config's.
  const project = fs.existsSync(path.join(s.repo, 'bridge', 'config.json')) ? [] : ['--project', '.'];
  const r = spawnSync(process.execPath, ['setup.js', ...project, ...args], { cwd: s.repo, env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return r.stdout;
}

const config = s => JSON.parse(fs.readFileSync(path.join(s.repo, 'bridge', 'config.json'), 'utf8'));
const slots = dir => fs.readdirSync(path.join(dir, 'Interface', 'AddOns')).filter(n => /^WoWAI_S\d{3}$/.test(n)).length;

test('a fresh install prefers Forever over a leftover beta folder', t => {
  const s = sandbox(t);
  const beta = client(s, '_classic_beta_', 'WowB.exe', '1#1');
  const forever = client(s, '_forever_', 'Wow.exe', '1#1');
  setup(s);
  const cfg = config(s);
  assert.equal(cfg.addonDir, path.join(forever, 'Interface', 'AddOns'));
  assert.equal(cfg.inboxFile, path.join(forever, 'Interface', 'AddOns', 'WoWAI', 'Inbox.lua'));
  assert.equal(cfg.savedVariablesFile, path.join(forever, 'WTF', 'Account', '1#1', 'SavedVariables', 'WoWAI.lua'));
  assert.equal(cfg.capture.processName, 'Wow');
  assert.equal(slots(forever), 200);
  assert.equal(slots(beta), 0);
});

test('a re-run moves a beta config to Forever and keeps the rest of it', t => {
  const s = sandbox(t);
  const beta = client(s, '_classic_beta_', 'WowB.exe', '1#1');
  setup(s);
  assert.equal(config(s).capture.processName, 'WowB');
  const edited = config(s);
  edited.defaultCwd = 'C:\\my-project';
  edited.capture.intervalMs = 500;
  fs.writeFileSync(path.join(s.repo, 'bridge', 'config.json'), JSON.stringify(edited));

  const forever = client(s, '_forever_', 'Wow.exe', '1#1');
  assert.match(setup(s), /moved to _forever_, process Wow/);
  const cfg = config(s);
  assert.equal(cfg.addonDir, path.join(forever, 'Interface', 'AddOns'));
  assert.equal(cfg.capture.processName, 'Wow');
  assert.equal(cfg.defaultCwd, 'C:\\my-project');
  assert.equal(cfg.capture.intervalMs, 500);
  assert.equal(slots(forever), 200);
  assert.equal(slots(beta), 200);
});

test('--wow moves the config too, so addon and slots land in the same client', t => {
  const s = sandbox(t);
  client(s, '_classic_beta_', 'WowB.exe', '1#1');
  setup(s);
  const era = client(s, '_classic_era_', 'WowClassic.exe', '1#1');
  setup(s, '--wow', era);
  assert.equal(config(s).addonDir, path.join(era, 'Interface', 'AddOns'));
  assert.equal(config(s).capture.processName, 'WowClassic');
  assert.equal(slots(era), 200);
});

test('a re-run stays on a client that is not the beta', t => {
  const s = sandbox(t);
  const era = client(s, '_classic_era_', 'WowClassic.exe', '1#1');
  setup(s, '--wow', era);
  client(s, '_forever_', 'Wow.exe', '1#1');
  assert.match(setup(s), /already exists, keeping it/);
  assert.equal(config(s).addonDir, path.join(era, 'Interface', 'AddOns'));
});

test('without --project, setup run from inside the repo refuses to make the repo the default folder', t => {
  const s = sandbox(t);
  client(s, '_forever_', 'Wow.exe', '1#1');
  const r = spawnSync(process.execPath, ['setup.js'], { cwd: s.repo, env: { ...process.env, WOWAI_TEST_WOW_ROOT: s.wow }, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--project/);
  assert.ok(!fs.existsSync(path.join(s.repo, 'bridge', 'config.json')));
  // A re-run with --project moves an existing config's default folder.
  setup(s);
  assert.match(setup(s, '--project', path.join(s.wow, 'notes')), /defaultCwd/);
  assert.equal(config(s).defaultCwd, path.join(s.wow, 'notes'));
});

test('setup installs before the first login and fills the account in later', t => {
  const s = sandbox(t);
  const forever = client(s, '_forever_', 'Wow.exe', null);
  assert.match(setup(s), /account  : none yet/);
  assert.equal(config(s).savedVariablesFile, '');
  assert.equal(slots(forever), 200);

  fs.mkdirSync(path.join(forever, 'WTF', 'Account', '1#1', 'SavedVariables'), { recursive: true });
  setup(s);
  assert.equal(config(s).savedVariablesFile, path.join(forever, 'WTF', 'Account', '1#1', 'SavedVariables', 'WoWAI.lua'));
});
