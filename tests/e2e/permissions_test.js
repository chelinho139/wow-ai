'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeRoot, gameRunner } = require('./helpers');

const ROOT = makeRoot('permissions');
const withGame = gameRunner(ROOT);

function outsideFolder(h) {
  const dir = path.join(h.sb.dir, 'scratch');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function answerTo(h, id, label) {
  return h.client.waitFor(() => {
    const c = h.client.activeChat();
    return c && !c.pendingId && (c.history || []).find(m => m.id === id && m.role !== 'user');
  }, { timeoutMs: 60000, label });
}

async function roll(h, choice) {
  await h.client.waitFor(() => h.client.luaValue('ClaudeWoWRoll.Current() and "open"') === 'open', { label: 'the roll frame' });
  const id = h.client.lastSeq() + 1;
  h.client.runLua(`ClaudeWoWRoll.Choose(${JSON.stringify(choice)})`);
  return answerTo(h, id, `the reply after ${choice}`);
}

const addDirsOf = argv => argv.flatMap((a, i) => (a === '--add-dir' ? [argv[i + 1]] : []));
const rollOpen = h => h.client.luaValue('ClaudeWoWRoll.Current() and "open" or "none"') === 'open';

test('a command outside the chat folder rolls for the folder; Need adds it to the chat for good and the retry runs', async () => {
  await withGame({}, async h => {
    const scratch = outsideFolder(h);
    const first = await h.client.say(`[[bash touch ${scratch}/demo.txt]]`);
    assert.deepEqual(first.denied, [`AddDir(${scratch})`]);
    assert.match(first.text, /blocked outside this chat's folders/);
    assert.equal(h.client.luaValue('ClaudeWoWRollFrame.Name:GetText()'), `Scroll of ${scratch}`);
    const retry = await roll(h, 'need');
    assert.match(retry.text, /^ran \(turn 2\): touch /);
    assert.deepEqual(h.client.activeChat().addDirs, [scratch]);
    const calls = h.agentCalls();
    assert.deepEqual(addDirsOf(calls[1].argv), [scratch]);
    assert.ok(!calls[1].argv.some(a => /AddDir/.test(a)), 'no folder ever reaches the allowlist');
    await h.client.say('and again');
    assert.deepEqual(addDirsOf(h.agentCalls()[2].argv), [scratch], 'the folder stays with the chat');
    assert.ok(!/AddDir/.test(fs.readFileSync(h.sb.config, 'utf8')), 'config.json is untouched');
  });
});

test('Greed adds the folder for the retry only', async () => {
  await withGame({}, async h => {
    const scratch = outsideFolder(h);
    await h.client.say(`[[bash touch ${scratch}/demo.txt]]`);
    const retry = await roll(h, 'greed');
    assert.match(retry.text, /^ran \(turn 2\)/);
    assert.deepEqual(addDirsOf(h.agentCalls()[1].argv), [scratch]);
    assert.equal(h.client.activeChat().addDirs, undefined);
    await h.client.say('next');
    assert.deepEqual(addDirsOf(h.agentCalls()[2].argv), []);
  });
});

test('Need on a missing rule reaches the very next run', async () => {
  await withGame({}, async h => {
    const first = await h.client.say('[[bash curl https://example.com]]');
    assert.deepEqual(first.denied, ['Bash(curl:*)']);
    const retry = await roll(h, 'need');
    assert.match(retry.text, /^ran \(turn 2\): curl/);
    const argv = h.agentCalls()[1].argv;
    assert.ok(argv.includes('Bash(curl:*)'), 'the granted rule is on the retry command line');
  });
});

test('a retry blocked again for what it was just granted stops the loop: no new roll, one plain line', async () => {
  await withGame({}, async h => {
    const scratch = outsideFolder(h);
    const first = await h.client.say(`[[bash-stuck touch ${scratch}/demo.txt]]`);
    assert.deepEqual(first.denied, [`AddDir(${scratch})`]);
    const retry = await roll(h, 'need');
    assert.equal(retry.denied, undefined);
    assert.match(retry.text, new RegExp(`blocked again on Bash: touch \\S+ although ${scratch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} is already one of this chat's folders`));
    assert.equal(rollOpen(h), false);
    await new Promise(r => setTimeout(r, 1500));
    assert.equal(h.agentCalls().length, 2, 'nothing else ran');
    await h.bridge.waitForLine(/not offered again/);
  });
});
