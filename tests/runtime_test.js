// bridge/runtime.js: how the bridge runs its own scripts on Node, on Bun and
// from the compiled binary, and where a JavaScript launcher finds a node.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const R = require('../bridge/runtime');

const checkout = { compiled: false, execPath: '/usr/local/bin/node', root: '/home/p/claude-wow' };
const binary = { compiled: true, execPath: '/home/p/.local/bin/claude-wow', root: '/build/machine/claude-wow' };

test('this test run is not the compiled binary, and describe() names what it is', () => {
  assert.equal(R.compiled, false);
  assert.equal(R.bun, !!process.versions.bun);
  assert.match(R.describe(), process.versions.bun ? /^bun \d/ : /^node \d/);
  assert.equal(R.describe(binary, { bun: '1.4.2', node: '26.3.0' }), 'claude-wow binary (bun 1.4.2)');
});

test('from a checkout, a script is run with this interpreter and its path, as before', () => {
  assert.deepEqual(R.scriptCommand('bridge', ['--once'], checkout), ['/usr/local/bin/node', ['/home/p/claude-wow/bridge/bridge.js', '--once']]);
  assert.deepEqual(R.scriptCommand('setup', ['--wow', 'x'], checkout), ['/usr/local/bin/node', ['/home/p/claude-wow/setup.js', '--wow', 'x']]);
  assert.deepEqual(R.scriptCommand('install-slots', [], checkout), ['/usr/local/bin/node', ['/home/p/claude-wow/bridge/install-slots.js']]);
  assert.deepEqual(R.scriptCommand('supervisor', [], checkout), ['/usr/local/bin/node', ['/home/p/claude-wow/bridge/supervisor.js']]);
  const [file, args] = R.scriptCommand('bridge');
  assert.equal(file, process.execPath);
  assert.equal(args[0], path.join(R.ROOT, 'bridge', 'bridge.js'));
  assert.ok(fs.existsSync(args[0]));
  assert.throws(() => R.scriptCommand('nope', [], checkout), /no script called "nope"/);
});

test('from the binary, a script is the binary and a subcommand; the supervisor is the binary itself', () => {
  assert.deepEqual(R.scriptCommand('bridge', ['--once'], binary), ['/home/p/.local/bin/claude-wow', ['bridge', '--once']]);
  assert.deepEqual(R.scriptCommand('setup', ['--wow', 'x'], binary), ['/home/p/.local/bin/claude-wow', ['setup', '--wow', 'x']]);
  assert.deepEqual(R.scriptCommand('install-slots', [], binary), ['/home/p/.local/bin/claude-wow', ['install-slots']]);
  assert.deepEqual(R.scriptCommand('supervisor', [], binary), ['/home/p/.local/bin/claude-wow', []]);
  for (const name of Object.keys(R.SCRIPTS)) assert.ok(fs.existsSync(path.join(R.ROOT, R.SCRIPTS[name])), `${R.SCRIPTS[name]} exists`);
});

test('a JavaScript launcher runs with this interpreter from a checkout, and with the node on the PATH from the binary', () => {
  assert.deepEqual(R.node(checkout), { file: '/usr/local/bin/node', found: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-wow-rt-'));
  try {
    const a = path.join(tmp, 'a'), b = path.join(tmp, 'b');
    fs.mkdirSync(a); fs.mkdirSync(b);
    const PATH = [a, b].join(path.delimiter);
    const none = R.node(binary, { PATH }, 'linux');
    assert.equal(none.found, false);
    assert.equal(none.file, 'node');
    assert.match(none.note, /no node is on the PATH/);
    fs.writeFileSync(path.join(b, 'bun'), '');
    assert.deepEqual(R.node(binary, { PATH }, 'linux'), { file: path.join(b, 'bun'), found: true });
    fs.writeFileSync(path.join(b, 'node'), '');
    assert.deepEqual(R.node(binary, { PATH }, 'linux'), { file: path.join(b, 'node'), found: true }, 'node before bun');
    fs.writeFileSync(path.join(a, 'node'), '');
    assert.deepEqual(R.node(binary, { PATH }, 'linux'), { file: path.join(a, 'node'), found: true }, 'PATH order');
    fs.writeFileSync(path.join(a, 'node.exe'), '');
    assert.deepEqual(R.node(binary, { PATH }, 'win32'), { file: path.join(a, 'node.exe'), found: true });
    assert.equal(R.node(binary, { PATH: '' }, 'win32').file, 'node.exe');
    fs.mkdirSync(path.join(b, 'node2'));
    assert.equal(R.node(binary, { PATH: b + path.delimiter + 'x' }, 'linux').file, path.join(b, 'node'), 'a folder is not a node');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
