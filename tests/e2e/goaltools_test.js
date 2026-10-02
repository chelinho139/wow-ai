'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const GM = require('../../bridge/goalsmcp');
const P = require('../../bridge/protocol');
const { makeRoot, gameRunner, isAlive } = require('./helpers');

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
  const stale = { file: '' };
  const beforeLaunch = async sb => { stale.file = path.join(sb.home, 'tmp', 'mcp', 'mcp-1-stale.json'); fs.mkdirSync(path.dirname(stale.file), { recursive: true }); fs.writeFileSync(stale.file, '{}'); };
  await withGame({ plugin: 'ask', beforeLaunch }, async h => {
    assert.ok(!fs.existsSync(stale.file), 'a config file left by a crashed bridge is removed at startup');
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
    const server = askRun.mcpConfig.mcpServers.wowgoals;
    assert.ok(!askRun.argv.join(' ').includes(server.env[GM.TOKEN_ENV]), 'the token is nowhere on the command line');
    const configFile = listAfter(askRun.argv, '--mcp-config')[0];
    assert.equal(path.dirname(configFile), path.join(h.sb.home, 'tmp', 'mcp'));
    assert.ok(!fs.existsSync(configFile), 'the config file is gone after the run');
    assert.ok(listAfter(askRun.argv, '--disallowedTools').some(r => r.startsWith('Read(') && r.endsWith('/tmp/mcp/**)')), 'the agent may not read the config folder');
    assert.equal(server.alwaysLoad, true);
    assert.ok(path.isAbsolute(server.command), server.command);
    const runId = server.args[server.args.indexOf('--run') + 1];
    assert.match(runId, /^[0-9a-f]{32}$/);
    assert.match(server.env[GM.TOKEN_ENV], /^[0-9a-f]{64}$/);
    const allowed = listAfter(askRun.argv, '--allowedTools');
    for (const rule of GM.RUN_RULES) assert.ok(allowed.includes(rule), `${rule} is a run-only rule`);
    const denied = listAfter(askRun.argv, '--disallowedTools');
    assert.deepEqual(denied.filter(r => r.startsWith('mcp__wowgoals')), GM.DENIED_WITH_TOOLS.filter(r => r.startsWith('mcp__wowgoals')));
    for (const rule of ['Bash', ...GM.FILE_SEARCH_TOOLS, ...[...new Set([h.sb.home, fs.realpathSync(h.sb.home)])].map(dir => P.absolutePathRule('Read', path.join(dir, '**')))]) assert.ok(denied.includes(rule), `${rule} is denied to an ask run that holds a grant`);
    assert.ok(allowed.includes('Bash(node:*)'), 'the sandbox config allows node, so the Bash deny is what holds');
    const previous = runs[runs.length - 2].mcpConfig.mcpServers.wowgoals;
    assert.notEqual(previous.env[GM.TOKEN_ENV], server.env[GM.TOKEN_ENV], 'every run gets its own grant');
    const replay = await callServer(server, 'order_issue', { text: 'skin 20' });
    assert.equal(replay.isError, true);
    assert.match(replay.content[0].text, /claude-wow bridge closed/);
    await h.bridge.waitForLine(/refused an in-game run connection without a valid run grant/);
    assert.equal(JSON.parse(fs.readFileSync(ordersFile, 'utf8')).orders.current.text, 'skin 10', 'an ended run\'s grant writes nothing');

    const coding = await h.client.say('@claude-code [[mcp-call wowgoals goal_list {}]]');
    assert.match(coding.text, /^mcp goal_list denied/);
    assert.deepEqual(coding.denied || [], [], 'the roll never offers a wowgoals tool');
    const codingRun = h.agentCalls().at(-1);
    assert.ok(!codingRun.argv.includes('--mcp-config'), 'the coding plugin runs without it');
    assert.ok(listAfter(codingRun.argv, '--disallowedTools').includes('mcp__wowgoals'));
    for (const rule of ['Bash', ...GM.FILE_SEARCH_TOOLS]) assert.ok(!listAfter(codingRun.argv, '--disallowedTools').includes(rule), `coding runs keep ${rule}`);
    for (const rule of [...new Set([h.sb.home, fs.realpathSync(h.sb.home)])].map(dir => P.absolutePathRule('Read', path.join(dir, '**')))) assert.ok(listAfter(codingRun.argv, '--disallowedTools').includes(rule), `coding runs are denied ${rule}`);
    assert.ok(!listAfter(codingRun.argv, '--allowedTools').some(r => r.startsWith('mcp__wowgoals')));
    assert.ok(!/wowgoals/.test(fs.readFileSync(h.sb.config, 'utf8')), 'no rule is ever saved');
  });
});

const termCalls = h => {
  try { return fs.readFileSync(path.join(h.sb.agentState, 'term-calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; }
};

test('while a run is live a second connection with its token is refused, and a cancel revokes the grant before the process ends', async () => {
  const beforeLaunch = async sb => {
    const cfg = JSON.parse(fs.readFileSync(sb.config, 'utf8'));
    cfg.agents.claude.allowedTools = [...(cfg.agents.claude.allowedTools || []), 'Bash(*)'];
    fs.writeFileSync(sb.config, JSON.stringify(cfg, null, 2));
  };
  await withGame({ plugin: 'ask', beforeLaunch }, async h => {
    await h.client.say('hello');
    await h.bridge.waitForLine(/game context updated: Character: Testchar/);
    h.client.send('[[mcp-term wowgoals order_issue {"text":"skin 20"}]]');
    const first = await h.client.waitFor(() => termCalls(h).find(c => c.phase === 'first'), { timeoutMs: 30000, label: 'the run\'s own first call' });
    assert.equal(first.isError, false, `a server under the run's agent is accepted: ${first.text}`);

    const run = h.agentCalls().at(-1);
    assert.ok(listAfter(run.argv, '--allowedTools').includes('Bash(*)'));
    assert.ok(listAfter(run.argv, '--disallowedTools').includes('Bash'), 'Bash is denied while the run holds a grant, whatever the config allows');
    const configFile = listAfter(run.argv, '--mcp-config')[0];
    assert.ok(fs.existsSync(configFile), 'the config file exists while the run is live');
    if (process.platform !== 'win32') assert.equal(fs.statSync(configFile).mode & 0o777, 0o600);
    const server = JSON.parse(fs.readFileSync(configFile, 'utf8')).mcpServers.wowgoals;
    const replay = await callServer(server, 'order_issue', { text: 'skin 30' });
    assert.equal(replay.isError, true);
    await h.bridge.waitForLine(/refused an in-game run connection without a valid run grant \(.*already had its one connection/);
    const ordersFile = path.join(h.sb.home, 'goals', CHARACTER, 'goals.json');
    assert.ok(!fs.existsSync(ordersFile), 'the replay wrote nothing');

    h.client.slash('/claude cancel');
    const term = await h.client.waitFor(() => termCalls(h).find(c => c.phase === 'term'), { timeoutMs: 30000, label: 'the call the run made after the cancel' });
    assert.equal(term.isError, true, term.text);
    await h.bridge.waitForLine(/wowgoals grant revoked before the run is ended/);
    assert.ok(!fs.existsSync(ordersFile), 'a call after the cancel wrote nothing');
    await h.client.waitFor(() => !isAlive(run.pid), { timeoutMs: 15000, label: 'the agent process to end' });
    await h.client.waitFor(() => !fs.existsSync(configFile), { timeoutMs: 15000, label: 'the config file to be removed' });
  });
});

test('a tool an ask run is denied never becomes a Need roll and is never saved', async () => {
  await withGame({ plugin: 'ask' }, async h => {
    await h.client.say('hello');
    await h.bridge.waitForLine(/game context updated: Character: Testchar/);
    const rollOpen = () => h.client.luaValue('ClaudeWoWRoll.Current() and "open" or "none"') === 'open';
    const grep = await h.client.say('[[use-tool Grep]]');
    assert.deepEqual(grep.denied || [], [], 'a denied Grep is not offered');
    assert.equal(rollOpen(), false);
    const cat = await h.client.say(`[[bash cat ${path.join(h.sb.home, 'live.token')}]]`);
    assert.match(cat.text, /^blocked/);
    assert.deepEqual(cat.denied || [], [], 'a Bash command in a run that holds a grant is not offered');
    assert.equal(rollOpen(), false);
    assert.ok(!/Grep|Bash\(cat/.test(fs.readFileSync(h.sb.config, 'utf8')), 'nothing denied is saved');
  });
});
