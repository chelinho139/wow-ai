'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const GM = require('../../bridge/goalsmcp');
const { makeRoot, gameRunner } = require('./helpers');

const ROOT = makeRoot('goaltools');
const withGame = gameRunner(ROOT);
const CHARACTER = 'Testchar-TestRealm';

const listAfter = (argv, flag) => {
  const i = argv.indexOf(flag);
  if (i < 0) return [];
  const out = [];
  for (let j = i + 1; j < argv.length && !String(argv[j]).startsWith('--'); j++) out.push(argv[j]);
  return out;
};

function callServer(server, tool, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(server.command, server.args, { env: { ...process.env, ...server.env }, stdio: ['pipe', 'pipe', 'ignore'] });
    let buf = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('the wowgoals server did not answer')); }, 20000);
    child.stdout.on('data', chunk => {
      buf += chunk.toString('utf8');
      const line = buf.split('\n').find(l => l.includes('"id":2'));
      if (!line) return;
      clearTimeout(timer);
      child.kill();
      resolve(JSON.parse(line).result);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: args } }) + '\n');
  });
}

test('an in-game ask run gets the wowgoals server for that run only; its calls write through the bridge with the same checks; coding runs and config.json never get it', async () => {
  await withGame({ plugin: 'ask' }, async h => {
    await h.client.say('hello');
    await h.bridge.waitForLine(/game context updated: Character: Testchar/);

    const refused = await h.client.say('[[mcp-call wowgoals order_issue {"text":"go to Silverpine"}]]');
    assert.match(refused.text, /^mcp order_issue error: The order uses words that are not allowed: "silverpine"/);
    const ordersFile = path.join(h.sb.home, 'goals', CHARACTER, 'goals.json');
    assert.ok(!fs.existsSync(ordersFile), 'a refused order writes nothing');

    const issued = await h.client.say('[[mcp-call wowgoals order_issue {"text":"skin 10"}]]');
    assert.match(issued.text, /^mcp order_issue ok: Issued order o_1: "skin 10"/);
    assert.equal(JSON.parse(fs.readFileSync(ordersFile, 'utf8')).orders.current.text, 'skin 10', 'the bridge wrote the order');
    await h.bridge.waitForLine(/order_issue from the in-game run: ok/);

    const runs = h.agentCalls();
    const askRun = runs[runs.length - 1];
    const server = JSON.parse(listAfter(askRun.argv, '--mcp-config')[0]).mcpServers.wowgoals;
    assert.equal(server.alwaysLoad, true);
    assert.ok(path.isAbsolute(server.command), server.command);
    const runId = server.args[server.args.indexOf('--run') + 1];
    assert.match(runId, /^[0-9a-f]{32}$/);
    assert.match(server.env[GM.TOKEN_ENV], /^[0-9a-f]{64}$/);
    const allowed = listAfter(askRun.argv, '--allowedTools');
    for (const rule of GM.RUN_RULES) assert.ok(allowed.includes(rule), `${rule} is a run-only rule`);
    assert.deepEqual(listAfter(askRun.argv, '--disallowedTools').filter(r => r.startsWith('mcp__wowgoals')), [...GM.DENIED_WITH_TOOLS]);
    const previous = JSON.parse(listAfter(runs[runs.length - 2].argv, '--mcp-config')[0]).mcpServers.wowgoals;
    assert.notEqual(previous.env[GM.TOKEN_ENV], server.env[GM.TOKEN_ENV], 'every run gets its own grant');
    const replay = await callServer(server, 'order_issue', { text: 'skin 20' });
    assert.equal(replay.isError, true);
    assert.match(replay.content[0].text, /bridge closed the connection/);
    await h.bridge.waitForLine(/refused an in-game run connection without a valid run grant/);
    assert.equal(JSON.parse(fs.readFileSync(ordersFile, 'utf8')).orders.current.text, 'skin 10', 'an ended run\'s grant writes nothing');

    const coding = await h.client.say('@claude-code [[mcp-call wowgoals goal_list {}]]');
    assert.match(coding.text, /^mcp goal_list denied/);
    assert.deepEqual(coding.denied || [], [], 'the roll never offers a wowgoals tool');
    const codingRun = h.agentCalls().at(-1);
    assert.ok(!codingRun.argv.includes('--mcp-config'), 'the coding plugin runs without it');
    assert.ok(listAfter(codingRun.argv, '--disallowedTools').includes('mcp__wowgoals'));
    assert.ok(!listAfter(codingRun.argv, '--allowedTools').some(r => r.startsWith('mcp__wowgoals')));
    assert.ok(!/wowgoals/.test(fs.readFileSync(h.sb.config, 'utf8')), 'no rule is ever saved');
  });
});
