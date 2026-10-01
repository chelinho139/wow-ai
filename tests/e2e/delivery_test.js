'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const SB = require('../../dev/sandbox');
const { makeRoot, gameRunner, sessionCostByAgent, isAlive, H } = require('./helpers');

const ROOT = makeRoot('delivery');
const withGame = gameRunner(ROOT);

test('a message goes out on a screenshot, the reply comes back through a slot, and nothing is left behind', async () => {
  await withGame({}, async h => {
    const r = await h.client.say('hello from the sim');
    assert.match(r.text, /echo \(turn 1\): hello from the sim/);
    assert.equal(r.role, 'assistant');
    const settleBy = Date.now() + 5000;
    while (h.screenshots().length && Date.now() < settleBy) await new Promise(r => setTimeout(r, 100));
    assert.deepEqual(h.screenshots(), [], 'the strip screenshot was deleted');
    const t = h.transcripts();
    assert.ok(Object.keys(t.chats || t).length >= 1, 'the bridge kept a transcript');
  });
});

test('the first message of a new chat comes back with a title from the lightweight model, and the chat takes it', async () => {
  await withGame({}, async h => {
    await h.client.say('name this chat');
    const active = '(function() for _, c in ipairs(ClaudeWoWDB.chats) do if c.id == ClaudeWoWDB.activeChat then return c end end end)()';
    assert.equal(h.client.luaValue(`${active}.name`), 'Fake Chat Title');
  });
});

test('every file the bridge writes into the game folder is 0777 like the rest of the install (Battle.net error 2113)', { skip: process.platform === 'win32' }, async () => {
  await withGame({}, async h => {
    await h.client.say('permissions');
    const addon = path.join(h.sb.addons, 'ClaudeWoW_Runtime');
    const presence = fs.readdirSync(path.join(addon, 'presence', 'b')).filter(n => n.endsWith('.wav'));
    assert.ok(fs.existsSync(path.join(addon, 'Inbox.lua')) && fs.existsSync(path.join(addon, 'ClaudeWoW_Runtime.toc')));
    assert.equal(presence.length, 2000, 'the presence rings are armed');
    const slotInboxes = fs.readdirSync(h.sb.addons).filter(n => /^ClaudeWoW_S\d{3}$/.test(n)).map(n => path.join(h.sb.addons, n, 'Inbox.lua'));
    assert.ok(slotInboxes.some(f => /echo/.test(fs.readFileSync(f, 'utf8'))), 'a slot carries the reply');
    const locked = [];
    const pending = [addon, ...slotInboxes];
    while (pending.length) {
      const current = pending.pop();
      const st = fs.statSync(current);
      if ((st.mode & 0o777) !== 0o777) locked.push(`${current} ${(st.mode & 0o777).toString(8)}`);
      if (st.isDirectory()) for (const n of fs.readdirSync(current)) pending.push(path.join(current, n));
    }
    assert.deepEqual(locked, []);
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

test('the reload path reads the Inbox.lua the bridge writes into ClaudeWoW_Runtime, and the shipped ClaudeWoW folder stays as shipped', async () => {
  await withGame({}, async h => {
    const r = await h.client.say('through the runtime folder');
    assert.match(r.text, /through the runtime folder/);
    h.client.reload();
    assert.equal(h.client.luaValue('C_AddOns.IsAddOnLoaded("ClaudeWoW_Runtime")'), 'true');
    assert.ok(Number(h.client.luaValue('ClaudeWoW_Inbox.now')) > 0, 'the bridge-written inbox, not the empty placeholder');
    const shipped = path.join(SB.REPO, 'addon', 'ClaudeWoW');
    assert.deepEqual(fs.readdirSync(path.join(h.sb.addons, 'ClaudeWoW')).sort(), fs.readdirSync(shipped).sort());
    assert.equal(fs.readFileSync(path.join(h.sb.addons, 'ClaudeWoW', 'Inbox.lua'), 'utf8'), fs.readFileSync(path.join(shipped, 'Inbox.lua'), 'utf8'));
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
      SB.spendSignals(sb, ['ack', 'sig'], slots);
    },
  }, async h => {
    const r = await h.client.say('after the wrap [[sleep 20]]', { timeoutMs: 60000 });
    assert.match(r.text, /after the wrap/);
    const diag = h.client.diag();
    assert.match(diag, /marked unreliable this session: false/);
    assert.ok(!h.client.prints().some(p => /didn't see/i.test(p)), 'the addon never gave up on the message');
  });
});

test('with capture.chatLog on, a message goes out through the chat log file and no screenshot is taken', async () => {
  await withGame({ capture: { chatLog: { enabled: true } } }, async h => {
    await h.bridge.waitForLine(/chat log transport: watching/);
    const r = await h.client.say('hello through the chat log');
    assert.match(r.text, /echo \(turn 1\): hello through the chat log/);
    assert.match(h.bridge.output, /strip #\d+ \(chat log, \d+ line\(s\)\): \d+ message\(s\)/);
    assert.match(h.bridge.output, /#\d+@\S+ \(chatlog\)/);
    assert.ok(!/\(screenshot WoWScrnShot/.test(h.bridge.output), 'no strip came from a screenshot');
    assert.deepEqual(h.screenshots(), []);
    assert.match(h.client.diag(), /chat log transport: on, lines of 900, filler 50000 bytes; \d+ frames, \d+ lines written, [1-9]\d* acknowledged first time, 0 only after the screenshot retry/);
    const slot = fs.readFileSync(path.join(h.sb.addons, 'ClaudeWoW_S001', 'Inbox.lua'), 'utf8');
    const session = /session token: (\w+)/.exec(h.client.diag())[1];
    const acked = [...slot.matchAll(/\{ session = "(\w+)", id = (\d+) \}/g)].filter(m => m[1] === session).map(m => Number(m[2]));
    assert.ok(acked.length >= 2, `the slot file lists the hello and the message as acknowledged (${acked.join(', ')})`);
  });
});

test('a client whose chat log only reaches disk at exit still delivers: the retry is a screenshot', async () => {
  await withGame({ capture: { chatLog: { enabled: true } }, speed: 8, client: { speed: 8, chatLogBufferBytes: 0 } }, async h => {
    const r = await h.client.say('the log never flushes here', { timeoutMs: 60000 });
    assert.match(r.text, /the log never flushes here/);
    assert.ok(!/\(chat log, /.test(h.bridge.output), 'nothing was read from the chat log');
    assert.match(h.bridge.output, /\(screenshot WoWScrnShot/);
    assert.match(h.client.diag(), /0 acknowledged first time, [1-9]\d* only after the screenshot retry/);
  });
});

test.after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});
