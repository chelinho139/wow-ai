'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const SIG = require('../bridge/signals');
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
  fs.mkdirSync(path.join(addons, 'ClaudeWoW', 'ctl'), { recursive: true });
  fs.writeFileSync(path.join(addons, 'ClaudeWoW', 'ctl', 'probe-dead.wav'), 'RIFF');
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'bridge', 'install-slots.js')], { env: { ...process.env, CLAUDE_WOW_HOME: home }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /signal files armed: 20/);
  assert.match(r.stdout, /presence: ring b at 2 of 5/);
  assert.match(r.stdout, /relaunch WoW/);
  for (let slot = 1; slot <= 3; slot++) {
    for (const kind of ['ack', 'sig']) assert.ok(fs.existsSync(SIG.signalFile(addons, kind, slot)), `${kind} ${slot}`);
    for (let k = 1; k <= 2; k++) assert.ok(fs.existsSync(SIG.actFile(addons, slot, k)));
  }
  assert.deepEqual(presentRange(addons, 'b', 1, 5), [false, false, true, true, true]);
  assert.deepEqual(presentRange(addons, 'a', 1, 5), Array(5).fill(true));
  assert.ok(fs.existsSync(path.join(addons, 'ClaudeWoW', 'ctl', 'valid.wav')));
  assert.ok(!fs.existsSync(path.join(addons, 'ClaudeWoW', 'ctl', 'probe-dead.wav')));
  fs.rmSync(dir, { recursive: true, force: true });
});

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
