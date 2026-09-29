'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const SB = require('../dev/sandbox');

const ROOT = path.join(os.tmpdir(), `claude-wow-sandbox-test-${process.pid}`);

test('assertSafe refuses every live install path and anything that contains one', () => {
  const home = '/Users/someone';
  for (const p of [
    '/Users/someone/.claude-wow',
    '/Users/someone/.claude-wow/state.json',
    '/Users/someone/Library/LaunchAgents/io.claudewow.bridge.plist',
    '/Users/someone/Library/Logs/claude-wow/bridge.log',
    '/Users/someone/.claude/projects/x.jsonl',
    '/Applications/World of Warcraft/_classic_beta_/WTF',
    '/Users/someone',
    '/',
  ]) assert.throws(() => SB.assertSafe(p, home), /refusing/, p);
  assert.equal(SB.assertSafe('/Users/someone/code/wow-ai/.dev/sandboxes/a', home), '/Users/someone/code/wow-ai/.dev/sandboxes/a');
});

test('a sandbox keeps every path the bridge and the client use inside itself', () => {
  const sb = SB.create('inside', { root: ROOT });
  try {
    for (const key of ['addonDir', 'savedVariablesFile', 'inboxFile', 'defaultCwd']) {
      assert.ok(SB.isWithin(path.resolve(sb.cfg[key]), sb.dir), `${key} = ${sb.cfg[key]}`);
    }
    assert.ok(SB.isWithin(sb.cfg.plugins.ask.cwd, sb.dir));
    for (const key of ['HOME', 'USERPROFILE', 'CLAUDE_WOW_HOME', 'CLAUDE_WOW_FAKE_STATE']) assert.ok(SB.isWithin(sb.env[key], sb.dir), key);
    assert.equal(sb.env.CLAUDE_WOW_SERVICE, undefined);
    assert.ok(fs.existsSync(path.join(sb.addons, 'ClaudeWoW', 'ClaudeWoW.toc')));
    assert.ok(fs.existsSync(path.join(sb.addons, 'ClaudeWoW_S200', 'ClaudeWoW_S200.toc')));
    assert.ok(fs.existsSync(path.join(sb.addons, 'ClaudeWoW', 'ctl', 'valid.wav')));
    assert.match(sb.cfg.agents.claude.path, /fake-claude\.js$/);
  } finally {
    fs.rmSync(ROOT, { recursive: true, force: true });
  }
});

test('the fake agent answers in stream-json, resumes its session, and reports cumulative usage like the real CLI', () => {
  const { spawnSync } = require('child_process');
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-claude-'));
  const run = (prompt, extra = []) => {
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'dev', 'fake-claude.js'), '-p', ...extra], { input: prompt, encoding: 'utf8', env: { ...process.env, CLAUDE_WOW_FAKE_STATE: state } });
    return r.stdout.trim().split('\n').map(l => JSON.parse(l));
  };
  try {
    const first = run('hello').at(-1);
    assert.equal(first.type, 'result');
    assert.equal(first.num_turns, 1);
    const second = run('again', ['--resume', first.session_id]).at(-1);
    assert.equal(second.session_id, first.session_id);
    assert.equal(second.num_turns, 2);
    assert.ok(second.total_cost_usd > first.total_cost_usd, 'the total carries the earlier turn');
    assert.equal(run('x [[error]]').at(-1).is_error, true);
  } finally {
    fs.rmSync(state, { recursive: true, force: true });
  }
});
