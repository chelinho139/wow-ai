'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeRoot, gameRunner } = require('./helpers');

const ROOT = makeRoot('presence');
const withGame = gameRunner(ROOT);

const gamePath = rel => 'Interface\\\\AddOns\\\\ClaudeWoW\\\\' + rel.split('/').join('\\\\');
const beatsSeen = h => Number(h.client.luaValue('ClaudeWoW.Presence.State().beats'));

test('the old scheme reproduced: presence files the bridge creates after the game started are never seen (beats seen 0, 2026-09-29)', async () => {
  await withGame({ bridge: false }, async h => {
    const flat = path.join(h.sb.addons, 'ClaudeWoW', 'presence');
    let seen = 0;
    for (let k = 1962; k <= 1981; k++) {
      fs.writeFileSync(path.join(flat, `${k}.wav`), 'RIFF');
      if (h.client.luaValue(`ClaudeWoW.Presence.Probe("${gamePath(`presence/${k}.wav`)}")`) === 'true') seen++;
    }
    assert.equal(seen, 0, 'twenty files created after launch, none of them seen');
    assert.equal(beatsSeen(h), 0);
  });
});

test('the bridge deletes launch-time presence files: the self-test passes at the hello, beats keep coming, and the bridge learns pt=passed from the next strip', async () => {
  await withGame({ presenceIntervalMs: 1000 }, async h => {
    await h.client.connect();
    await h.client.waitFor(() => h.client.luaValue('ClaudeWoW.PresenceWorks()') === 'true', { timeoutMs: 15000, label: 'the presence self-test to pass' });
    const first = beatsSeen(h);
    await h.client.waitFor(() => beatsSeen(h) >= first + 2, { timeoutMs: 15000, label: 'two more presence beats' });
    const diag = await h.client.waitFor(() => { const d = h.client.diag(); return /late-created file: (seen|unseen)/.test(d) && d; }, { timeoutMs: 20000, everyMs: 500, label: 'the late-created probe to be checked' });
    assert.match(diag, /presence: beats \(self-test passed: a launch-time file read missing after the bridge deleted it\)/);
    assert.match(diag, /presence self-test: passed, late-created file: unseen/);
    assert.match(diag, /bridge presence: ring a at \d+ of 2000/);
    const r = await h.client.say('after the self-test');
    assert.match(r.text, /after the self-test/);
    await h.bridge.waitForLine(/signal self-test from the game: deleting a launch-time file reads as missing \(presence beats work\); a file created after launch is unseen/, { timeoutMs: 10000 });
    assert.equal(h.state().presenceTest.result, 'passed');
    assert.equal(h.state().presenceTest.late, 'unseen');
    const dir = path.join(h.sb.addons, 'ClaudeWoW', 'presence', 'a');
    const st = h.state().presence;
    assert.ok(!fs.existsSync(path.join(dir, String(st.at).padStart(4, '0') + '.wav')), 'the beaten file is gone');
    assert.ok(fs.existsSync(path.join(dir, String(st.at + 1).padStart(4, '0') + '.wav')), 'the next one is still armed');
    assert.equal(fs.readdirSync(path.join(h.sb.addons, 'ClaudeWoW', 'presence', 'b')).length, 2000, 'the other ring stays armed for the next launch');
  });
});

test('with the beats reaching the game the light is still green six game minutes after a reply (it went red at five before)', async () => {
  await withGame({ speed: 10, client: { speed: 10 } }, async h => {
    const r = await h.client.say('then go quiet');
    assert.match(r.text, /then go quiet/);
    const quietFrom = h.client.gameNow();
    await h.client.waitFor(() => h.client.gameNow() - quietFrom >= 360, { timeoutMs: 60000, everyMs: 250, label: 'six game minutes' });
    assert.equal(h.client.luaValue('ClaudeWoW.BridgeState()'), 'ok', h.client.diag());
    assert.ok(beatsSeen(h) >= 8, `beats seen: ${beatsSeen(h)}`);
  });
});

test('a client where a deleted launch-time file still reads present fails the self-test, keeps the light on the idle-poll windows, and tells the bridge pt=failed', async () => {
  await withGame({ presenceIntervalMs: 1000, client: { deletionVisible: false } }, async h => {
    await h.client.connect();
    await h.client.waitFor(() => h.client.luaValue('ClaudeWoW.Presence.State().test') === 'failed', { timeoutMs: 15000, label: 'the presence self-test to fail' });
    assert.equal(h.client.luaValue('ClaudeWoW.PresenceWorks()'), 'false');
    assert.equal(beatsSeen(h), 0);
    assert.match(h.client.diag(), /presence: slot polls only \(self-test failed: presence\/a\/\d{4}\.wav still reads present after the bridge deleted it\)/);
    const r = await h.client.say('after a failed self-test');
    assert.match(r.text, /after a failed self-test/);
    await h.bridge.waitForLine(/deleting a launch-time file does NOT read as missing/, { timeoutMs: 10000 });
    assert.equal(h.state().presenceTest.result, 'failed');
  });
});

test.after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});
