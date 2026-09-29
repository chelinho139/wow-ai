// bridge/assets.js: the non-JavaScript files the compiled binary carries, read
// from the checkout by default and written out from an embedded table when
// there is one; build/entry.js embeds exactly that list; build.js names the
// binaries the installers fetch.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AS = require('../bridge/assets');
const B = require('../build');

const ROOT = path.join(__dirname, '..');

test('every asset exists in the checkout, the addon folder is covered in full, and from a checkout the paths are the checkout', () => {
  for (const rel of AS.FILES) assert.ok(fs.statSync(path.join(ROOT, rel)).isFile(), rel);
  const addon = fs.readdirSync(path.join(ROOT, 'addon', 'ClaudeWoW')).sort();
  assert.deepEqual(AS.FILES.filter(f => f.startsWith('addon/ClaudeWoW/')).map(f => path.basename(f)).sort(), addon, 'a new addon file must be embedded too');
  assert.equal(AS.isEmbedded(), false);
  assert.equal(AS.root(), ROOT);
  assert.equal(AS.file('bridge/capture_mac.py'), path.join(ROOT, 'bridge', 'capture_mac.py'));
  assert.equal(AS.dir('addon/ClaudeWoW'), path.join(ROOT, 'addon', 'ClaudeWoW'));
});

test('build/entry.js embeds exactly assets.FILES, under the same names', () => {
  const src = fs.readFileSync(path.join(ROOT, 'build', 'entry.js'), 'utf8');
  const imports = [...src.matchAll(/^import (\w+) from '\.\.\/([^']+)' with \{ type: 'file' \};$/gm)];
  assert.deepEqual(imports.map(m => m[2]).sort(), [...AS.FILES].sort(), 'one import per asset');
  const table = [...src.matchAll(/^\s+'([^']+)': (\w+),$/gm)];
  assert.deepEqual(table.map(m => m[1]).sort(), [...AS.FILES].sort(), 'one table entry per asset');
  for (const [, rel, name] of table) assert.equal(imports.find(m => m[1] === name)[2], rel, `${rel} maps to its own import`);
  assert.match(src, /require\('\.\.\/bridge\/assets'\)\.embed\(/);
  assert.match(src, /require\('\.\.\/bridge\/supervisor'\);\s*$/);
});

test('with an embedded table, files are written out once, rewritten when they differ, and left alone when they match', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-wow-assets-'));
  try {
    // A stand-in for the binary's embedded copies: the checkout's files, from a folder of their own.
    const embeddedDir = path.join(tmp, 'embedded');
    const table = {};
    for (const rel of AS.FILES) {
      const f = path.join(embeddedDir, rel.replace(/\//g, '_'));
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.copyFileSync(path.join(ROOT, rel), f);
      table[rel] = f;
    }
    assert.throws(() => AS.embed({}), /is not embedded/);
    const home = path.join(tmp, 'home');
    const first = AS.extract(path.join(home, AS.DIR_NAME), table);
    assert.deepEqual(first.sort(), [...AS.FILES].sort(), 'everything written the first time');
    assert.deepEqual(AS.extract(path.join(home, AS.DIR_NAME), table), [], 'nothing the second time');
    const py = path.join(home, AS.DIR_NAME, 'bridge', 'capture_mac.py');
    assert.equal(fs.readFileSync(py, 'utf8'), fs.readFileSync(path.join(ROOT, 'bridge', 'capture_mac.py'), 'utf8'));
    fs.writeFileSync(py, '# edited\n');
    fs.unlinkSync(path.join(home, AS.DIR_NAME, 'addon', 'ClaudeWoW', 'Map.lua'));
    assert.deepEqual(AS.extract(path.join(home, AS.DIR_NAME), table).sort(), ['addon/ClaudeWoW/Map.lua', 'bridge/capture_mac.py'], 'only what changed or went missing');
    assert.equal(fs.readFileSync(py, 'utf8'), fs.readFileSync(path.join(ROOT, 'bridge', 'capture_mac.py'), 'utf8'));

    AS.embed(table);
    assert.equal(AS.isEmbedded(), true);
    const home2 = path.join(tmp, 'home2');
    assert.equal(AS.root(home2), path.join(home2, AS.DIR_NAME));
    assert.equal(AS.file('docs/WOW-ADDON-PRIMER.md', home2), path.join(home2, AS.DIR_NAME, 'docs', 'WOW-ADDON-PRIMER.md'));
    assert.ok(fs.existsSync(AS.file('bridge/capture.ps1', home2)));
    assert.ok(fs.existsSync(path.join(AS.dir('addon/ClaudeWoW', home2), 'ClaudeWoW.toc')));
    assert.equal(fs.readdirSync(AS.dir('addon/ClaudeWoW', home2)).length, 6);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('build.js names one binary per target, and the host target is this machine', () => {
  assert.deepEqual(B.TARGETS, ['bun-darwin-arm64', 'bun-darwin-x64', 'bun-linux-x64', 'bun-windows-x64']);
  assert.equal(B.outName('bun-darwin-arm64'), 'claude-wow-darwin-arm64');
  assert.equal(B.outName('bun-linux-x64'), 'claude-wow-linux-x64');
  assert.equal(B.outName('bun-windows-x64'), 'claude-wow-windows-x64.exe');
  assert.match(B.hostTarget(), /^bun-(darwin|linux|windows)-(arm64|x64)$/);
  assert.equal(B.main(['--target', 'bun-plan9-mips']), 2);
});
