'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { makeRoot, gameRunner, sessionCostByAgent, isAlive, H } = require('./helpers');

const ROOT = makeRoot('failures');
const withGame = gameRunner(ROOT);

test('an agent that reports a rate limit reaches the player with the reason', async () => {
  await withGame({}, async h => {
    const r = await h.client.say('go [[rate-limit]]');
    assert.equal(r.role, 'system');
    assert.match(r.text, /usage limit/i);
  });
});

test('an agent error with no text tells the player something useful', async () => {
  await withGame({}, async h => {
    const r = await h.client.say('go [[error]]');
    assert.equal(r.role, 'system');
    assert.match(r.text, /error_during_execution/);
  });
});

test('a run that passes timeoutMs is stopped and the player is told the limit', async () => {
  await withGame({ config: { timeoutMs: 3000 } }, async h => {
    const r = await h.client.say('forever [[hang]]', { timeoutMs: 30000 });
    assert.equal(r.role, 'system');
    assert.match(r.text, /stopped after 3 s, the limit set by timeoutMs/);
  });
});

test('/claude-wow cancel stops the agent run in the bridge', async () => {
  await withGame({}, async h => {
    await h.client.connect();
    const id = h.client.lastSeq() + 1;
    h.client.send('long job [[hang]]');
    await h.bridge.waitForLine(new RegExp(`#${id}@\\S+ \\(screenshot\\)`));
    await h.client.waitFor(() => h.agentCalls().length === 1, { label: 'the agent to start' });
    const pid = h.agentCalls()[0].pid;
    h.client.slash('/claude-wow cancel');
    await h.client.waitFor(() => !isAlive(pid), { timeoutMs: 15000, label: 'the agent process to end' });
    await h.bridge.waitForLine(new RegExp(`#${id}@\\S+ cancelled from the game`));
  });
});

test('a bridge that dies mid-run tells the player which message was lost', async () => {
  await withGame({}, async h => {
    await h.client.connect();
    const id = h.client.lastSeq() + 1;
    h.client.send('doomed [[hang]]');
    await h.bridge.waitForLine(new RegExp(`#${id}@\\S+ \\(screenshot\\)`));
    await h.client.waitFor(() => h.agentCalls().length === 1 && Object.keys(h.state().inflight || {}).length === 1, { label: 'the run to be recorded as in flight' });
    await h.bridge.crash();
    h.bridge.start();
    await h.bridge.ready();
    const note = await h.client.waitFor(() => {
      const c = h.client.activeChat();
      return c && (c.history || []).find(m => m.id === id && m.role === 'system');
    }, { timeoutMs: 30000, label: 'a note about the lost run' });
    assert.match(note.text, /stopped unexpectedly .* reply is lost\. Send it again/);
    await h.bridge.waitForLine(new RegExp(`#${id}: ended the orphaned .* process group`), { from: 0 });
    await h.client.waitFor(() => h.agentCalls().every(c => !isAlive(c.pid)), { timeoutMs: 5000, label: 'the orphaned agent to be ended' });
  });
});

test.after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});
