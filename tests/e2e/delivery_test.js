'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const SB = require('../../dev/sandbox');
const { makeRoot, gameRunner, sessionCostByAgent, isAlive, H } = require('./helpers');

const ROOT = makeRoot('delivery');
const withGame = gameRunner(ROOT);

test('a message goes out on a screenshot, the reply comes back through a slot, and nothing is left behind', async () => {
  await withGame({}, async h => {
    const r = await h.client.say('hello from the sim');
    assert.match(r.text, /echo \(turn 1\): hello from the sim/);
    assert.equal(r.role, 'assistant');
    assert.deepEqual(h.screenshots(), [], 'the strip screenshot was deleted');
    const t = h.transcripts();
    assert.ok(Object.keys(t.chats || t).length >= 1, 'the bridge kept a transcript');
  });
});

test('a second turn resumes the same agent session', async () => {
  await withGame({}, async h => {
    await h.client.say('one');
    const r = await h.client.say('two');
    assert.match(r.text, /turn 2/);
    const calls = h.agentCalls();
    assert.equal(calls.length, 2);
    assert.equal(calls[1].resume, calls[0].session);
  });
});

test('a reply survives a /reload while the agent is still working', async () => {
  await withGame({}, async h => {
    await h.client.connect();
    const id = h.client.lastSeq() + 1;
    h.client.send('slow one [[sleep 4]]');
    await h.bridge.waitForLine(new RegExp(`#${id}@\\S+ \\(screenshot\\)`));
    h.client.reload();
    const reply = await h.client.waitFor(() => {
      const c = h.client.activeChat();
      return c && !c.pendingId && (c.history || []).find(m => m.id === id && m.role === 'assistant');
    }, { timeoutMs: 40000, label: 'the reply after the reload' });
    assert.match(reply.text, /slow one/);
  });
});

test('the displayed session cost matches what the session really cost across --resume', async () => {
  await withGame({}, async h => {
    await h.client.say('one');
    await h.client.say('two');
    await h.client.say('three');
    const shown = h.client.activeChat().cost;
    const real = sessionCostByAgent(h);
    assert.ok(real > 0);
    assert.ok(Math.abs(shown - real) < 1e-4, `shown $${shown} vs real $${real}`);
  });
});

test('message ids past the slot count still get acked and answered without marking the signals unreliable', async () => {
  const slots = Array.from({ length: 200 }, (_, i) => i + 1);
  await withGame({
    client: { speed: 8 },
    speed: 8,
    beforeLaunch: sb => {
      fs.writeFileSync(sb.saved, '\r\nClaudeWoWDB = {\r\n["lastSeq"] = 200,\r\n}\r\n');
      SB.seedStaleSignals(sb, ['ack', 'sig'], slots);
    },
  }, async h => {
    const r = await h.client.say('after the wrap [[sleep 20]]', { timeoutMs: 60000 });
    assert.match(r.text, /after the wrap/);
    const diag = h.client.diag();
    assert.match(diag, /marked unreliable this session: false/);
    assert.ok(!h.client.prints().some(p => /didn't see/i.test(p)), 'the addon never gave up on the message');
  });
});

test.after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});
