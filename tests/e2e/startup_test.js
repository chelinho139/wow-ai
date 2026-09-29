'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { makeRoot, gameRunner, sessionCostByAgent, isAlive, H } = require('./helpers');

const ROOT = makeRoot('startup');
const withGame = gameRunner(ROOT);

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

test('a lock left by a process that is not a bridge does not keep the bridge down', async () => {
  await withGame({ beforeLaunch: sb => fs.writeFileSync(require('path').join(sb.home, 'bridge.lock'), JSON.stringify({ pid: 1, startedAt: Date.now(), marker: 'bridge.js' })) }, async h => {
    assert.ok(h.bridge.pid, 'the bridge is running');
    const r = await h.client.say('still here');
    assert.match(r.text, /still here/);
  });
});

test.after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});
