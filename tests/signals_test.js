'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const SIG = require('../bridge/signals');
const { INERT_OPTIONS: INERT_STREAM } = require('../bridge/plugins/stream');
const P = require('../bridge/protocol');

const posixOnly = { skip: process.platform === 'win32' };
const modeOf = file => fs.statSync(file).mode & 0o777;

function scratch(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `claude-wow-signals-${name}-`));
  const addons = path.join(dir, 'Interface', 'AddOns');
  fs.mkdirSync(path.join(addons, 'ClaudeWoW'), { recursive: true });
  return { dir, addons };
}

const present = (addons, ring, k) => fs.existsSync(SIG.ringFile(addons, ring, k));
const presentRange = (addons, ring, from, to) => {
  const out = [];
  for (let k = from; k <= to; k++) out.push(present(addons, ring, k));
  return out;
};

test('preparePresence arms both rings, keeps the spent prefix of the current ring missing, and clears the old flat files', () => {
  const { dir, addons } = scratch('prepare');
  const flat = path.join(SIG.presenceDir(addons), '1981.wav');
  fs.mkdirSync(path.dirname(flat), { recursive: true });
  fs.writeFileSync(flat, 'RIFF');
  const first = SIG.preparePresence(addons, 1981, 10);
  assert.deepEqual(first.state, { ring: 'a', at: 0, switches: 0, probe: '' }, 'an old numeric counter starts a fresh ring');
  assert.equal(first.made, 20);
  assert.equal(first.removed, 1);
  assert.ok(!fs.existsSync(flat));
  const again = SIG.preparePresence(addons, { ring: 'b', at: 3 }, 10);
  assert.deepEqual(presentRange(addons, 'b', 1, 10), [false, false, false, true, true, true, true, true, true, true]);
  assert.deepEqual(presentRange(addons, 'a', 1, 10), Array(10).fill(true));
  assert.equal(again.removed, 3);
  assert.equal(again.made, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a beat deletes the next file of the current ring; a spent ring is armed again and the other ring takes over', () => {
  const { dir, addons } = scratch('beat');
  const st = SIG.preparePresence(addons, null, 3).state;
  assert.deepEqual(SIG.beat(addons, st, 3), { ring: 'a', k: 1, switched: '' });
  SIG.beat(addons, st, 3);
  SIG.beat(addons, st, 3);
  assert.deepEqual(presentRange(addons, 'a', 1, 3), [false, false, false]);
  assert.deepEqual(SIG.beat(addons, st, 3), { ring: 'b', k: 1, switched: 'a' });
  assert.deepEqual(presentRange(addons, 'a', 1, 3), [true, true, true], 'ring a is armed for the next game launch');
  assert.deepEqual(presentRange(addons, 'b', 1, 3), [false, true, true]);
  assert.equal(st.switches, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('armSlot creates ack, sig and every act file once; fire deletes, arm only fills a gap', () => {
  const { dir, addons } = scratch('slot');
  assert.equal(SIG.armSlot(addons, 7, 4), 6);
  assert.equal(SIG.armSlot(addons, 7, 4), 0);
  const ack = SIG.signalFile(addons, 'ack', 7);
  assert.equal(fs.readFileSync(ack).subarray(0, 4).toString(), 'RIFF');
  SIG.fire(ack);
  assert.ok(!fs.existsSync(ack));
  assert.equal(SIG.arm(ack), true);
  assert.equal(SIG.arm(ack), false);
  assert.ok(fs.existsSync(SIG.actFile(addons, 7, 4)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('placeProbe keeps exactly one late-created probe file and refuses odd tokens', () => {
  const { dir, addons } = scratch('probe');
  assert.equal(SIG.placeProbe(addons, 'abc123'), true);
  assert.equal(SIG.placeProbe(addons, 'def456'), true);
  assert.ok(!fs.existsSync(SIG.probeFile(addons, 'abc123')));
  assert.ok(fs.existsSync(SIG.probeFile(addons, 'def456')));
  assert.equal(SIG.placeProbe(addons, '../x'), false);
  assert.equal(SIG.clearProbes(addons), 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('every armed signal file is 0777 like the game install', posixOnly, () => {
  const { dir, addons } = scratch('modes');
  const before = process.umask(0o022);
  try {
    SIG.armSlot(addons, 1, 2);
    SIG.preparePresence(addons, null, 2);
    SIG.placeProbe(addons, 'abcd');
  } finally { process.umask(before); }
  for (const f of [SIG.signalFile(addons, 'ack', 1), SIG.actFile(addons, 1, 2), path.dirname(SIG.actFile(addons, 1, 2)), SIG.ringFile(addons, 'b', 2), SIG.ringDir(addons, 'a'), SIG.probeFile(addons, 'abcd')]) {
    assert.equal(modeOf(f), 0o777, f);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('install-slots arms every signal file before the game starts', () => {
  const { dir, addons } = scratch('install');
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(addons, 'ClaudeWoW', 'ClaudeWoW.toc'), '## Interface: 16001\n');
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ addonDir: addons, slots: 3, actMax: 2, presenceMax: 5 }));
  fs.writeFileSync(path.join(home, 'state.json'), JSON.stringify({ presence: { ring: 'b', at: 2 } }));
  fs.mkdirSync(path.join(addons, 'ClaudeWoW_Runtime', 'ctl'), { recursive: true });
  fs.writeFileSync(path.join(addons, 'ClaudeWoW_Runtime', 'ctl', 'probe-dead.wav'), 'RIFF');
  const r = runInstallSlots(home);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /signal files armed: 20/);
  assert.match(r.stdout, /presence: ring b at 2 of 5/);
  assert.match(r.stdout, /relaunch WoW/);
  assert.doesNotMatch(r.stdout, /^migrate:/m, 'nothing to move on a fresh install');
  for (let slot = 1; slot <= 3; slot++) {
    for (const kind of ['ack', 'sig']) assert.ok(fs.existsSync(SIG.signalFile(addons, kind, slot)), `${kind} ${slot}`);
    for (let k = 1; k <= 2; k++) assert.ok(fs.existsSync(SIG.actFile(addons, slot, k)));
  }
  assert.deepEqual(presentRange(addons, 'b', 1, 5), [false, false, true, true, true]);
  assert.deepEqual(presentRange(addons, 'a', 1, 5), Array(5).fill(true));
  assert.ok(fs.existsSync(path.join(addons, 'ClaudeWoW_Runtime', 'ctl', 'valid.wav')));
  assert.ok(!fs.existsSync(path.join(addons, 'ClaudeWoW_Runtime', 'ctl', 'probe-dead.wav')));
  fs.rmSync(dir, { recursive: true, force: true });
});

function runInstallSlots(home) {
  return spawnSync(process.execPath, [path.join(__dirname, '..', 'bridge', 'install-slots.js')], { env: { ...process.env, CLAUDE_WOW_HOME: home }, encoding: 'utf8' });
}

function installWorld(name, { state = {}, config = {} } = {}) {
  const { dir, addons } = scratch(name);
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(addons, 'ClaudeWoW', 'ClaudeWoW.toc'), '## Interface: 16001\n');
  fs.writeFileSync(path.join(addons, 'ClaudeWoW', 'ClaudeWoW.lua'), 'ClaudeWoW = {}\n');
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ addonDir: addons, slots: 3, actMax: 2, presenceMax: 5, ...config }));
  fs.writeFileSync(path.join(home, 'state.json'), JSON.stringify(state));
  return { dir, addons, home };
}

const shippedOnly = addons => fs.readdirSync(path.join(addons, 'ClaudeWoW')).sort();

function writeLegacySignals(addons) {
  const legacy = rel => path.join(addons, 'ClaudeWoW', ...rel.split('/'));
  for (const rel of ['ack/001.wav', 'sig/002.wav', 'act/001/01.wav', 'ctl/valid.wav', 'presence/a/0003.wav', 'presence/b/0001.wav']) {
    fs.mkdirSync(path.dirname(legacy(rel)), { recursive: true });
    fs.writeFileSync(legacy(rel), 'RIFF');
  }
}

test('install-slots writes every runtime file into ClaudeWoW_Runtime and none into the shipped ClaudeWoW folder', () => {
  const { dir, addons, home } = installWorld('runtime-only');
  const r = runInstallSlots(home);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(shippedOnly(addons), ['ClaudeWoW.lua', 'ClaudeWoW.toc'], 'the shipped folder holds only what the addon ships');
  assert.equal(SIG.runtimeRoot(addons), path.join(addons, 'ClaudeWoW_Runtime'));
  for (const name of SIG.RUNTIME_FOLDERS) assert.ok(fs.statSync(path.join(addons, 'ClaudeWoW_Runtime', name)).isDirectory(), name);
  const toc = fs.readFileSync(path.join(addons, 'ClaudeWoW_Runtime', 'ClaudeWoW_Runtime.toc'), 'utf8');
  assert.match(toc, /^## Interface: 11509, 16001$/m);
  assert.match(toc, /^## Dependencies: ClaudeWoW$/m, 'it loads after ClaudeWoW, so the bridge-written Inbox.lua wins over the shipped placeholder');
  assert.doesNotMatch(toc, /LoadOnDemand/);
  assert.match(toc, /^Inbox\.lua$/m);
  assert.equal(fs.readFileSync(path.join(addons, 'ClaudeWoW_Runtime', 'Inbox.lua'), 'utf8'), fs.readFileSync(path.join(__dirname, '..', 'addon', 'ClaudeWoW', 'Inbox.lua'), 'utf8'), 'the runtime placeholder never clobbers data either way round');
  fs.writeFileSync(path.join(addons, 'ClaudeWoW_Runtime', 'Inbox.lua'), 'ClaudeWoW_Inbox = { id = 9 }\n');
  assert.equal(runInstallSlots(home).status, 0);
  assert.equal(fs.readFileSync(path.join(addons, 'ClaudeWoW_Runtime', 'Inbox.lua'), 'utf8'), 'ClaudeWoW_Inbox = { id = 9 }\n', 'a re-run keeps what the bridge wrote');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('install-slots moves old signal folders out of ClaudeWoW, keeps the presence ring in step with state.json, and says to restart once', () => {
  const { dir, addons, home } = installWorld('migrate', { state: { presence: { ring: 'a', at: 3 } } });
  writeLegacySignals(addons);
  const r = runInstallSlots(home);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^migrate: removed 5 old signal folder\(s\) from .*ClaudeWoW; the signal files moved from ClaudeWoW to ClaudeWoW_Runtime: fully quit and relaunch WoW once/m);
  assert.deepEqual(shippedOnly(addons), ['ClaudeWoW.lua', 'ClaudeWoW.toc']);
  assert.deepEqual(presentRange(addons, 'a', 1, 5), [false, false, false, true, true], 'the spent prefix of the current ring reads fired, as state.json says');
  assert.deepEqual(presentRange(addons, 'b', 1, 5), Array(5).fill(true));
  assert.ok(fs.existsSync(SIG.validFile(addons)));
  assert.ok(fs.existsSync(SIG.signalFile(addons, 'ack', 1)));
  const again = runInstallSlots(home);
  assert.doesNotMatch(again.stdout, /^migrate:/m, 'the restart note is said once');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('prepareRuntime without removeLegacy (the bridge start) builds the runtime folder and leaves the old folders alone', () => {
  const { dir, addons } = installWorld('bridge-start');
  writeLegacySignals(addons);
  assert.equal(SIG.needsMigration(addons), true);
  const r = SIG.prepareRuntime(addons, { slots: 2, actMax: 1, presence: { ring: 'b', at: 1 }, presenceMax: 3 });
  assert.equal(r.legacy, 5);
  assert.equal(r.legacyRemoved, 0);
  assert.deepEqual(r.presence.state, { ring: 'b', at: 1, switches: 0, probe: '' });
  assert.deepEqual(presentRange(addons, 'b', 1, 3), [false, true, true]);
  assert.ok(fs.existsSync(path.join(addons, 'ClaudeWoW', 'ack', '001.wav')), 'a running game may still read the old files');
  assert.equal(SIG.needsMigration(addons), false, 'done once: the runtime folder has its valid.wav');
  assert.equal(SIG.removeLegacySignalFolders(addons), 5);
  assert.deepEqual(SIG.legacySignalFolders(addons), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

async function startBridgeUntil(home, done, ms = 20000) {
  const bridge = spawn(process.execPath, [path.join(__dirname, '..', 'bridge', 'bridge.js')], { env: { ...process.env, CLAUDE_WOW_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  bridge.stdout.on('data', d => { out += d; });
  bridge.stderr.on('data', d => { out += d; });
  const exited = new Promise(resolve => bridge.on('exit', resolve));
  const deadline = Date.now() + ms;
  while (!done(out) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  bridge.kill('SIGKILL');
  await exited;
  return out;
}

test('a bridge started on an old install builds ClaudeWoW_Runtime from state.json, says to restart once, writes Inbox.lua there and leaves the old folders for setup', async () => {
  const { dir, addons, home } = installWorld('bridge-migrate', { state: { lastId: 0, sessions: {}, handled: {}, presence: { ring: 'b', at: 2 } } });
  writeLegacySignals(addons);
  const shippedInbox = path.join(addons, 'ClaudeWoW', 'Inbox.lua');
  fs.writeFileSync(shippedInbox, 'ClaudeWoW_Inbox = ClaudeWoW_Inbox or { id = 0, replies = {} }\n');
  fs.mkdirSync(path.join(dir, 'project'), { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    addonDir: addons, savedVariablesFile: path.join(dir, 'ClaudeWoW.lua'), inboxFile: shippedInbox,
    defaultCwd: path.join(dir, 'project'), slots: 3, actMax: 2, presenceMax: 5, agent: 'claude', agents: { claude: { path: path.join(dir, 'none.js') } },
    plugins: { default: 'claude-code', stream: { ...INERT_STREAM } }, gameContext: false, primerFile: '', capture: { enabled: false },
  }));
  try {
    const published = () => /ClaudeWoW_Inbox = \{/.test(readOr(SIG.runtimeInbox(addons)));
    const started = out => published() && /presence: ring/.test(out);
    const out = await startBridgeUntil(home, started);
    assert.match(out, /migrate: created .*ClaudeWoW_Runtime \(\d+ signal file\(s\) armed\); the signal files moved from ClaudeWoW to ClaudeWoW_Runtime: fully quit and relaunch WoW once/, out);
    assert.match(out, /The 5 old folder\(s\) in .*ClaudeWoW stay until setup/, out);
    assert.ok(fs.existsSync(SIG.validFile(addons)));
    assert.ok(fs.existsSync(SIG.runtimeToc(addons)));
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8')).presence.ring, 'b', 'the ring in state.json carries over');
    assert.deepEqual(presentRange(addons, 'b', 1, 2), [false, false], 'its spent prefix reads fired in the new folder');
    assert.ok(fs.existsSync(path.join(addons, 'ClaudeWoW', 'ack', '001.wav')), 'a running game may still read the old files');
    assert.ok(published(), 'the bridge publishes into the runtime Inbox.lua');
    assert.equal(fs.readFileSync(shippedInbox, 'utf8'), 'ClaudeWoW_Inbox = ClaudeWoW_Inbox or { id = 0, replies = {} }\n', 'an inboxFile naming the shipped folder is redirected');
    fs.writeFileSync(SIG.runtimeInbox(addons), SIG.INBOX_PLACEHOLDER);
    const again = await startBridgeUntil(home, started);
    assert.ok(published(), again);
    assert.doesNotMatch(again, /migrate:/, 'the restart note is logged once');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const readOr = file => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };

test('the strip flags carry the self-test and the probe token; the slot file names the scheme and the ring', () => {
  const f = P.parseFlags('h;probe=0a1b2c3d;pt=failed;lc=unseen');
  assert.equal(f.hello, true);
  assert.equal(f.probe, '0a1b2c3d');
  assert.equal(f.presenceTest, 'failed');
  assert.equal(f.lateCreate, 'unseen');
  const bad = P.parseFlags('pt=maybe;lc=x;probe=../../x');
  assert.equal(bad.presenceTest, undefined);
  assert.equal(bad.lateCreate, undefined);
  assert.equal(bad.probe, undefined);
  const lua = P.luaTable('ClaudeWoW_SlotData', [], { presence: { scheme: SIG.SCHEME, ring: 'b', at: 12, n: 2000, probe: 'abcd' } });
  assert.match(lua, /\tsignals = "armed",/);
  assert.match(lua, /\tpresence = \{ ring = "b", at = 12, n = 2000, probe = "abcd" \},/);
  assert.doesNotMatch(P.luaTable('X', [], {}), /presence =/);
});
