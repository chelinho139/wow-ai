'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const G = require('../bridge/gamefs');

const posixOnly = { skip: process.platform === 'win32' };
const modeOf = file => fs.statSync(file).mode & 0o777;

function scratch(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `claude-wow-gamefs-${name}-`));
}

function withUmask(mask, fn) {
  const before = process.umask(mask);
  try { return fn(); } finally { process.umask(before); }
}

test('only Windows is exempt from matching the game install', () => {
  assert.equal(G.matchesGame('darwin'), true);
  assert.equal(G.matchesGame('linux'), true);
  assert.equal(G.matchesGame('win32'), false);
});

test('atomicWrite replaces a file and leaves it 0777 whatever the umask and the old mode', posixOnly, () => {
  const dir = scratch('atomic');
  const file = path.join(dir, 'Inbox.lua');
  fs.writeFileSync(file, 'old', { mode: 0o600 });
  withUmask(0o077, () => G.atomicWrite(file, 'new'));
  assert.equal(fs.readFileSync(file, 'utf8'), 'new');
  assert.equal(modeOf(file), 0o777);
  assert.ok(!fs.existsSync(file + '.tmp'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('mkdir makes every missing folder 0777 and leaves existing parents alone', posixOnly, () => {
  const dir = scratch('mkdir');
  fs.chmodSync(dir, 0o700);
  const deep = path.join(dir, 'a', 'b', 'c');
  withUmask(0o022, () => G.mkdir(deep));
  for (const d of [path.join(dir, 'a'), path.join(dir, 'a', 'b'), deep]) assert.equal(modeOf(d), 0o777, d);
  assert.equal(modeOf(dir), 0o700);
  withUmask(0o022, () => G.mkdir(deep));
  assert.equal(modeOf(deep), 0o777);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writeFile and copyFile leave the target 0777', posixOnly, () => {
  const dir = scratch('write');
  const src = path.join(dir, 'src.lua');
  fs.writeFileSync(src, 'x', { mode: 0o644 });
  withUmask(0o022, () => {
    G.writeFile(path.join(dir, 'w.lua'), 'y');
    G.copyFile(src, path.join(dir, 'c.lua'));
  });
  assert.equal(modeOf(path.join(dir, 'w.lua')), 0o777);
  assert.equal(modeOf(path.join(dir, 'c.lua')), 0o777);
  assert.equal(modeOf(src), 0o644);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('repair sets every file and folder under the ClaudeWoW addon folders to 0777 and nothing else', posixOnly, () => {
  const addons = scratch('repair');
  const presence = path.join(addons, 'ClaudeWoW', 'presence');
  fs.mkdirSync(presence, { recursive: true, mode: 0o755 });
  fs.writeFileSync(path.join(presence, '0007.wav'), 'RIFF', { mode: 0o644 });
  fs.mkdirSync(path.join(addons, 'ClaudeWoW_S001'), { mode: 0o755 });
  fs.writeFileSync(path.join(addons, 'ClaudeWoW_S001', 'Inbox.lua'), 'x', { mode: 0o644 });
  fs.mkdirSync(path.join(addons, 'SomeOtherAddon'), { mode: 0o755 });
  fs.writeFileSync(path.join(addons, 'SomeOtherAddon', 'a.lua'), 'x', { mode: 0o644 });
  const first = G.repair(addons);
  assert.equal(first.fixed, first.checked);
  assert.ok(first.fixed >= 5);
  assert.deepEqual(first.failed, []);
  for (const f of [path.join(addons, 'ClaudeWoW'), presence, path.join(presence, '0007.wav'), path.join(addons, 'ClaudeWoW_S001'), path.join(addons, 'ClaudeWoW_S001', 'Inbox.lua')]) {
    assert.equal(modeOf(f), 0o777, f);
  }
  assert.equal(modeOf(path.join(addons, 'SomeOtherAddon', 'a.lua')), 0o644, 'another addon is not touched');
  const again = G.repair(addons);
  assert.equal(again.fixed, 0);
  assert.deepEqual(G.repair(path.join(addons, 'missing')), { checked: 0, fixed: 0, failed: [] });
  fs.rmSync(addons, { recursive: true, force: true });
});
