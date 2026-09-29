'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const H = require('../../dev/harness');
const SB = require('../../dev/sandbox');
const A = require('../../bridge/agents');

const ROOT = path.join(os.tmpdir(), `claude-wow-e2e-${process.pid}`);
let seq = 0;

async function withGame(opts, fn) {
  const h = await H.start(`t${++seq}`, Object.assign({ root: ROOT }, opts));
  try {
    await fn(h);
    assert.deepEqual(h.client.errors(), [], 'the addon raised no Lua errors');
  } catch (e) {
    e.message += `\n--- bridge output (tail) ---\n${h.bridge.output.slice(-2500)}\n--- game prints (tail) ---\n${h.client.prints().slice(-8).join('\n')}`;
    throw e;
  } finally {
    await h.close();
  }
}

function priceOfSession(h) {
  const calls = h.agentCalls();
  const last = calls[calls.length - 1];
  const session = JSON.parse(fs.readFileSync(path.join(h.sb.agentState, `${last.session}.json`), 'utf8'));
  const ev = { type: 'result', modelUsage: { 'claude-opus-5': session.total } };
  return A.claudeCost ? A.claudeCost(ev, 'claude-opus-5').usd : null;
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

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

test('an agent that reports a rate limit reaches the player with the reason', async () => {
  await withGame({}, async h => {
    const r = await h.client.say('go [[rate-limit]]');
    assert.equal(r.role, 'system');
    assert.match(r.text, /usage limit/i);
  });
});

test('the displayed session cost matches what the session really cost across --resume', async () => {
  await withGame({}, async h => {
    await h.client.say('one');
    await h.client.say('two');
    await h.client.say('three');
    const shown = h.client.activeChat().cost;
    const real = priceOfSession(h);
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
    h.client.send('doomed [[sleep 10]]');
    await h.bridge.waitForLine(new RegExp(`#${id}@\\S+ \\(screenshot\\)`));
    await h.bridge.crash();
    h.bridge.start();
    await h.bridge.ready();
    const note = await h.client.waitFor(() => {
      const c = h.client.activeChat();
      return c && (c.history || []).find(m => m.id === id && m.role === 'system');
    }, { timeoutMs: 30000, label: 'a note about the lost run' });
    assert.match(note.text, /stopped unexpectedly .* reply is lost\. Send it again/);
    await h.client.waitFor(() => h.agentCalls().every(c => !isAlive(c.pid)), { timeoutMs: 5000, label: 'the orphaned agent to be ended' });
  });
});

test('a client whose interface version no longer matches the slots tells the player why replies stopped', async () => {
  await withGame({ client: { interface: 16002 } }, async h => {
    await h.client.waitFor(() => h.client.prints().some(p => /INTERFACE_VERSION.*tocInterface to 16002/.test(p)), { timeoutMs: 20000, label: 'a message about the slot version' });
  });
});

test('a corrupt state.json is kept aside and reported, not silently reset', async () => {
  await withGame({ beforeLaunch: sb => fs.writeFileSync(sb.state, '{"sessions": {"x": ') }, async h => {
    await h.bridge.waitForLine(/state\.json.*(corrupt|unreadable|not valid)/i, { timeoutMs: 5000 });
    assert.ok(fs.readdirSync(h.sb.home).some(f => /^state\.json\.corrupt/.test(f)));
  });
});

test('a second bridge on the same home refuses to start', async () => {
  await withGame({}, async h => {
    const second = new H.BridgeProcess(h.sb);
    second.start();
    await second.waitForLine(/already running/i, { timeoutMs: 8000 }).finally(() => second.stop());
  });
});

test.after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});
