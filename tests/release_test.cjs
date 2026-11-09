'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { prepare } = require('../scripts/release-version.cjs');

const root = path.resolve(__dirname, '..');
const files = ['package.json', 'package-lock.json', 'rust/bridge/Cargo.toml', 'Cargo.lock', 'addon/WoWAI/WoWAI.toc'];

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'wow-ai-release-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    fs.copyFileSync(path.join(root, file), path.join(cwd, file));
  }
  return cwd;
}

test('release preparation synchronizes every component without changing dependency versions', async t => {
  const cwd = fixture(t);
  const version = '0.6.1';
  // Exercise the same npm version command used by @semantic-release/npm.
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', [
    'version', version, '--no-git-tag-version', '--allow-same-version', '--ignore-scripts',
  ], { cwd, shell: process.platform === 'win32' });
  await prepare({}, { cwd, nextRelease: { version } });
  const read = file => fs.readFileSync(path.join(cwd, file), 'utf8');
  assert.equal(JSON.parse(read('package.json')).version, version);
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(lock.version, version);
  assert.equal(lock.packages[''].version, version);
  const manifest = read('rust/bridge/Cargo.toml');
  assert.match(manifest, /version = "0\.6\.1"/);
  assert.match(manifest, /serde = \{ version = "1"/);
  const cargoBefore = fs.readFileSync(path.join(root, 'Cargo.lock'), 'utf8');
  assert.equal(read('Cargo.lock'), cargoBefore.replace(
    /(name = "wow-ai-reforged"\nversion = ")[^"]+"/, '$10.6.1"',
  ));
  assert.match(read('addon/WoWAI/WoWAI.toc'), /^## Version: 0\.6\.1$/m);
  await prepare({}, { cwd, nextRelease: { version } });
  assert.match(read('addon/WoWAI/WoWAI.toc'), /^## Version: 0\.6\.1$/m);
});

test('missing version fields fail before any component files are written', async t => {
  const cwd = fixture(t);
  fs.writeFileSync(path.join(cwd, 'addon/WoWAI/WoWAI.toc'), '## Title: WoW AI\n');
  const before = fs.readFileSync(path.join(cwd, 'rust/bridge/Cargo.toml'), 'utf8');
  await assert.rejects(prepare({}, { cwd, nextRelease: { version: '0.6.1' } }), /version field missing/);
  assert.equal(fs.readFileSync(path.join(cwd, 'rust/bridge/Cargo.toml'), 'utf8'), before);
});

test('invalid release versions are rejected', async t => {
  const cwd = fixture(t);
  await assert.rejects(prepare({}, { cwd, nextRelease: { version: 'invalid' } }), /stable release version/);
});

test('conventional commits select patch, minor, breaking, or no release', async () => {
  const { analyzeCommits } = await import('@semantic-release/commit-analyzer');
  for (const [message, expected] of [
    ['fix: correct capture', 'patch'], ['feat: add an agent', 'minor'],
    ['feat!: replace wire format', 'major'],
    ['feat: change protocol\n\nBREAKING CHANGE: replace wire format', 'major'],
    ['docs: update installation', null],
  ]) {
    const analyzer = require('../release.config.cjs').plugins[0][1];
    assert.equal(await analyzeCommits(analyzer, {
      cwd: root, commits: [{ hash: 'abc123', message }], logger: { log() {} },
    }), expected);
  }
});
