// bridge/home.js: where config.json, state.json, transcripts.json and the log
// live. CLAUDE_WOW_HOME wins, then ~/.claude-wow once it has a config, then the
// old layout (bridge/ in the checkout) while that has one, else ~/.claude-wow.
// setup.js copies the old layout into ~/.claude-wow once, never into an
// explicit CLAUDE_WOW_HOME.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const H = require('../bridge/home');

function scratch(name) {
  const dir = path.join(os.tmpdir(), `claude-wow-home-${name}-${process.pid}-${Date.now().toString(36)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test('resolution order: CLAUDE_WOW_HOME, ~/.claude-wow with a config, the legacy bridge/ with a config, ~/.claude-wow', () => {
  const home = scratch('res');
  const legacy = path.join(home, 'checkout', 'bridge');
  fs.mkdirSync(legacy, { recursive: true });
  const dflt = path.join(home, '.claude-wow');

  // Nothing anywhere: the default, and every file under it.
  let r = H.resolve({}, home, legacy);
  assert.equal(r.dir, dflt);
  assert.equal(r.source, 'default');
  assert.equal(r.config, path.join(dflt, 'config.json'));
  assert.equal(r.state, path.join(dflt, 'state.json'));
  assert.equal(r.transcripts, path.join(dflt, 'transcripts.json'));
  assert.equal(r.log, path.join(dflt, 'bridge.log'));
  assert.equal(r.tmp, path.join(dflt, 'tmp'));
  assert.equal(r.mapjobs, path.join(dflt, 'mapjobs'));
  assert.equal(r.uijobs, path.join(dflt, 'uijobs'));
  assert.equal(r.goals, path.join(dflt, 'goals'));
  assert.equal(r.data, path.join(dflt, 'data'));

  // The old layout: a config next to the code is used as long as the default has none.
  fs.writeFileSync(path.join(legacy, 'config.json'), '{}');
  r = H.resolve({}, home, legacy);
  assert.equal(r.dir, legacy);
  assert.equal(r.source, 'legacy');

  // Once ~/.claude-wow has a config it wins over the old layout.
  fs.mkdirSync(dflt, { recursive: true });
  fs.writeFileSync(path.join(dflt, 'config.json'), '{}');
  r = H.resolve({}, home, legacy);
  assert.equal(r.dir, dflt);
  assert.equal(r.source, 'default');

  // The variable beats both, with or without a config there, and ~ expands.
  const custom = path.join(home, 'elsewhere');
  r = H.resolve({ CLAUDE_WOW_HOME: custom }, home, legacy);
  assert.equal(r.dir, custom);
  assert.equal(r.source, 'CLAUDE_WOW_HOME');
  assert.equal(H.resolve({ CLAUDE_WOW_HOME: '~/cw' }, home, legacy).dir, path.join(home, 'cw'));
  assert.equal(H.resolve({ CLAUDE_WOW_HOME: '' }, home, legacy).dir, dflt, 'empty means unset');

  // A config.json that is a folder does not count.
  fs.rmSync(path.join(dflt, 'config.json'));
  fs.mkdirSync(path.join(dflt, 'config.json'));
  assert.equal(H.resolve({}, home, legacy).source, 'legacy');
  fs.rmSync(home, { recursive: true, force: true });
});

test('migrateLegacy copies config, state and transcripts into ~/.claude-wow once, and leaves the originals', () => {
  const home = scratch('mig');
  const legacy = path.join(home, 'checkout', 'bridge');
  fs.mkdirSync(legacy, { recursive: true });
  const dflt = path.join(home, '.claude-wow');

  assert.deepEqual(H.migrateLegacy({}, home, legacy), [], 'nothing to migrate');
  assert.ok(!fs.existsSync(dflt), 'and nothing is created for it');

  fs.writeFileSync(path.join(legacy, 'config.json'), '{"addonDir":"/x"}');
  fs.writeFileSync(path.join(legacy, 'state.json'), '{"sessions":{"c1":{"id":"s1"}}}');
  fs.writeFileSync(path.join(legacy, 'bridge.log'), 'old log\n'); // not carried
  // No transcripts.json: only what exists is copied.
  assert.deepEqual(H.migrateLegacy({}, home, legacy), ['config.json', 'state.json']);
  assert.equal(fs.readFileSync(path.join(dflt, 'config.json'), 'utf8'), '{"addonDir":"/x"}');
  assert.equal(fs.readFileSync(path.join(dflt, 'state.json'), 'utf8'), '{"sessions":{"c1":{"id":"s1"}}}', 'the sessions came across');
  assert.ok(!fs.existsSync(path.join(dflt, 'bridge.log')));
  assert.ok(fs.existsSync(path.join(legacy, 'config.json')) && fs.existsSync(path.join(legacy, 'state.json')), 'originals stay');
  assert.equal(H.resolve({}, home, legacy).dir, dflt, 'from now on the default is the home');

  // A second run does nothing: the home's files are not overwritten.
  fs.writeFileSync(path.join(dflt, 'state.json'), '{"sessions":{"c1":{"id":"s2"}}}');
  assert.deepEqual(H.migrateLegacy({}, home, legacy), []);
  assert.equal(fs.readFileSync(path.join(dflt, 'state.json'), 'utf8'), '{"sessions":{"c1":{"id":"s2"}}}');

  // An explicit CLAUDE_WOW_HOME is never filled from the old layout.
  const custom = path.join(home, 'custom');
  assert.deepEqual(H.migrateLegacy({ CLAUDE_WOW_HOME: custom }, home, legacy), []);
  assert.ok(!fs.existsSync(custom));
  fs.rmSync(home, { recursive: true, force: true });
});

test('the bridge, the slot installer, the supervisor and the service all go through home.js', () => {
  // Static: none of them builds the config or log path from __dirname any more.
  for (const f of ['bridge.js', 'install-slots.js', 'supervisor.js', 'service.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'bridge', f), 'utf8');
    assert.ok(!/path\.join\((HERE|__dirname), '(config|state|transcripts)\.json'\)/.test(src), `${f} reads its files from the home folder`);
    assert.ok(!/path\.join\((HERE|__dirname), 'bridge\.log'\)/.test(src), `${f} logs to the home folder`);
    assert.ok(/require\('\.\/home'\)/.test(src), `${f} uses home.js`);
  }
});
