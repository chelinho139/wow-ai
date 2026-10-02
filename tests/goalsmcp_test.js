'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const GM = require('../bridge/goalsmcp');
const G = require('../bridge/goals');
const LP = require('../bridge/liveproto');
const P = require('../bridge/protocol');
const A = require('../bridge/agents');
const { createLive } = require('../bridge/plugins/live');

const POSIX = process.platform !== 'win32';
const CONTEXT = 'Character: Bone on Forever, level 20 Orc Rogue (Horde)\nProfessions: Skinning 187/225';
const IN_GAME_TOOLS = ['goal_set', 'goal_list', 'order_issue', 'farm_spot_lookup', 'market_price', 'route_draw', 'campaign_start', 'campaign_end', 'beat_add', 'beat_trigger', 'narrate'];

const until = async (cond, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = cond();
    if (v) return v;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('timed out waiting');
};

function fakeStdout() {
  const lines = [];
  let buf = '';
  return {
    lines,
    write(s) {
      buf += s;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, nl))); buf = buf.slice(nl + 1); }
    },
  };
}

test('in-game runs get goals, orders, campaigns and routes, never the vote tools; Bash is denied next to them', () => {
  assert.deepEqual([...GM.TOOL_NAMES], IN_GAME_TOOLS);
  assert.deepEqual(GM.toolSchemas().map(t => t.name), IN_GAME_TOOLS);
  assert.deepEqual([...GM.RUN_RULES], IN_GAME_TOOLS.map(t => `mcp__wowgoals__${t}`));
  for (const vote of ['goal_vote_open', 'goal_vote_close']) {
    assert.ok(!GM.RUN_RULES.includes(`mcp__wowgoals__${vote}`), vote);
    assert.ok(GM.DENIED_WITH_TOOLS.includes(`mcp__wowgoals__${vote}`), `${vote} is denied even when the server is there`);
  }
  assert.ok(GM.DENIED_WITH_TOOLS.includes('Bash'), 'one rule denies every shell command');
  assert.deepEqual([...GM.ASK_DENIED_TOOLS], ['Grep', 'Glob', 'LS', 'NotebookRead']);
  for (const rule of ['Bash(cat:*)', 'Bash', ' Bash(node -e x) ', 'Grep', 'Grep(path=/x)']) assert.ok(GM.deniedBy(['Bash', 'Grep'], rule), rule);
  for (const rule of ['WebFetch', 'Read(//x)', 'Bashful']) assert.ok(!GM.deniedBy(['Bash', 'Grep'], rule), rule);
  assert.ok(GM.deniedBy(['Read(//h/.claude-wow/**)'], 'Read(//h/.claude-wow/live.token)'));
  assert.ok(GM.deniedBy(['Read(//h/.claude-wow/**)'], 'Read(//h/.claude-wow/**)'));
  assert.ok(!GM.deniedBy(['Read(//h/.claude-wow/**)'], 'Read(//h/.claude-wowx/a)'));
  assert.ok(!GM.deniedBy(['Read(//h/.claude-wow/**)'], 'Edit(//h/.claude-wow/a)'));
  assert.deepEqual([...GM.DENIED_WITHOUT_TOOLS], ['mcp__wowgoals']);
  assert.match(GM.INSTRUCTIONS, /\{item:ID\}, \{skill:ID\}, \{map:ID,x,y\}/);
});

test('launch config: the bridge\'s own command, the run id in the server args, the token only in the server env (the bridge writes it to a private file, never to argv), alwaysLoad', () => {
  const checkout = { compiled: false, execPath: '/usr/local/bin/node', root: '/opt/claude-wow' };
  const runId = 'a'.repeat(32);
  const launch = GM.launchConfig({ runId, token: 'secret-token', socket: '/h/live.sock', runtime: checkout });
  assert.deepEqual(launch, { server: { type: 'stdio', command: '/usr/local/bin/node', args: [path.join('/opt/claude-wow', 'bridge', 'goalsmcp.js'), '--socket', '/h/live.sock', '--run', runId], env: { CLAUDE_WOW_RUN_TOKEN: 'secret-token' }, alwaysLoad: true } });
  const binary = { compiled: true, execPath: '/home/p/.local/bin/claude-wow', root: '/$bunfs/root' };
  assert.deepEqual(GM.launchConfig({ runId, token: 't', socket: '/s', runtime: binary }).server.args, ['goals-mcp', '--socket', '/s', '--run', runId]);
  assert.equal(GM.mcpConfig({ wowdata: null, wowgoals: null }), '');
  assert.deepEqual(JSON.parse(GM.mcpConfig({ wowdata: { type: 'stdio', command: 'd' }, wowgoals: launch.server })), { mcpServers: { wowdata: { type: 'stdio', command: 'd' }, wowgoals: launch.server } });
  assert.throws(() => GM.parseArgs(['--token', 'x']), /unknown option/);
});

test('Claude args for an ask run: the run-only wowgoals rules next to the user rules, the vote tools and token readers denied; a roll never keeps a wowgoals rule', () => {
  const launch = GM.launchConfig({ runId: 'b'.repeat(32), token: 't', socket: '/s' });
  const cfg = P.withRunDeniedRules(P.withRunOnlyRules({ allowedTools: ['WebSearch'] }, GM.RUN_RULES), GM.DENIED_WITH_TOOLS);
  const mcpConfig = GM.mcpConfig({ wowgoals: launch.server });
  const args = A.AGENTS.claude.args({ cfg, resume: '', system: '', cwd: 'x', mcpConfig });
  assert.deepEqual(args, ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits',
    '--allowedTools', 'WebSearch', ...GM.RUN_RULES, '--disallowedTools', ...GM.DENIED_WITH_TOOLS, '--mcp-config', mcpConfig]);
  for (const rule of ['mcp__wowgoals__goal_set(*)', 'mcp__wowgoals*', ' mcp__wowgoals__new_tool', 'mcp__wowgoals', ...GM.RUN_RULES]) assert.ok(GM.isRunToolRule(rule), rule);
  assert.ok(!GM.isRunToolRule('mcp__wowdata') && !GM.isRunToolRule('WebFetch'));
});

const fakeConn = () => ({ destroyed: false, destroy() { this.destroyed = true; } });
const helloFor = (id, token, nonce = 'n1', extra = {}) => ({ type: GM.HELLO, run: id, nonce, proof: LP.proof(token, 'client', nonce), ...extra });

test('run grants: one hello ever, with the run\'s own proof; a spoofed pid gives nothing; a vote tool, an ended run and an unknown run are refused before the store', () => {
  const calls = [];
  const logs = [];
  const grants = GM.createRunGrants({ call: async (tool, args) => { calls.push([tool, args]); return { ok: true, text: 'done' }; }, character: () => 'Bone-Forever', log: l => logs.push(l) });
  const one = grants.grant('#1');
  const two = grants.grant('#2');
  assert.match(one.id, /^[0-9a-f]{32}$/);
  assert.notEqual(one.token, two.token);
  assert.equal(grants.hello(helloFor(one.id, two.token), fakeConn()).run, undefined, 'another run\'s token does not open this run');
  assert.equal(grants.hello(helloFor(one.id, two.token, 'n9', { pid: process.pid }), fakeConn()).run, undefined, 'a pid field does not stand in for the token');
  assert.equal(grants.hello(helloFor('c'.repeat(32), one.token), fakeConn()).run, undefined);
  assert.equal(grants.hello({ ...helloFor(one.id, one.token), nonce: '' }, fakeConn()).run, undefined);
  const conn = fakeConn();
  const ok = grants.hello(helloFor(one.id, one.token), conn);
  assert.deepEqual(ok.welcome, { type: 'welcome', proof: LP.proof(one.token, 'bridge', 'n1') });
  assert.match(grants.hello(helloFor(one.id, one.token, 'n2', { pid: process.pid }), fakeConn()).why, /already had its one connection/, 'a second hello is refused whatever pid it names');
  return (async () => {
    const vote = await grants.onCall(ok.run, { call: 1, tool: 'goal_vote_open', args: {} });
    assert.deepEqual(vote, { type: GM.RESULT, call: 1, ok: false, text: 'goal_vote_open is not given to in-game runs.' });
    const list = await grants.onCall(ok.run, { call: 2, tool: 'goal_list', args: [1] });
    assert.deepEqual(list, { type: GM.RESULT, call: 2, ok: true, text: 'done' });
    assert.deepEqual(calls, [['goal_list', {}]]);

    conn.destroy();
    grants.detach(ok.run, conn);
    assert.ok(logs.some(l => /connection dropped; the run's goal tools are off/.test(l)), logs.join('\n'));
    assert.match(grants.hello(helloFor(one.id, one.token, 'n3'), fakeConn()).why, /already had its one connection/, 'a dropped connection is never replaced');

    assert.equal(grants.revoke(one.id), true);
    const ended = await grants.onCall(ok.run, { call: 3, tool: 'goal_list', args: {} });
    assert.equal(ended.ok, false);
    assert.match(ended.text, /the in-game run that held it has ended/);
    assert.equal(grants.hello(helloFor(one.id, one.token, 'n4'), fakeConn()).run, undefined, 'an ended run cannot connect again');
    const live = fakeConn();
    assert.ok(grants.hello(helloFor(two.id, two.token), live).run);
    grants.revoke(two.id);
    assert.equal(live.destroyed, true, 'revoking closes the run\'s connection');
    assert.equal(calls.length, 1);
    grants.grant('#3');
    grants.revokeAll();
    assert.equal(grants.size, 0);
  })();
});

test('run grants are bound to the character the game reported when the run started', async () => {
  let character = 'Bone-Forever';
  const calls = [];
  const grants = GM.createRunGrants({ call: async tool => { calls.push(tool); return { ok: true, text: 'done' }; }, character: () => character });
  const g = grants.grant('#3');
  const { run } = grants.hello(helloFor(g.id, g.token), fakeConn());
  assert.equal((await grants.onCall(run, { call: 1, tool: 'goal_list' })).ok, true);
  character = 'Alt-Forever';
  const alt = await grants.onCall(run, { call: 2, tool: 'order_issue', args: { text: 'skin 10' } });
  assert.equal(alt.ok, false);
  assert.match(alt.text, /started for Bone-Forever, and the game now reports Alt-Forever/);
  character = '';
  assert.equal((await grants.onCall(run, { call: 3, tool: 'goal_list' })).ok, false, 'no reported character, no write');
  const late = GM.createRunGrants({ call: async () => ({ ok: true }), character: () => '' });
  const none = late.grant('#5');
  const noneRun = late.hello(helloFor(none.id, none.token), fakeConn()).run;
  assert.equal((await late.onCall(noneRun, { call: 4, tool: 'goal_list' })).ok, false, 'a grant made with no character never writes');
  assert.deepEqual(calls, ['goal_list']);
});

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cw-goalsmcp-'));
}

async function socketRig() {
  const home = tmpHome();
  const posts = [];
  const ctx = { text: CONTEXT, at: Date.now() };
  const store = G.createGoals({ dir: path.join(home, 'goals'), context: () => ctx, streamOptions: () => ({ url: 'http://127.0.0.1:9' }), post: async (url, command) => { posts.push(command); return { ok: true, status: 200 }; } });
  const storeCalls = [];
  const logs = [];
  const grants = GM.createRunGrants({ call: (tool, args) => { storeCalls.push(tool); return store.call(tool, args); }, character: () => 'Bone-Forever', log: l => logs.push(l) });
  const core = { home, timeoutMs: 60000, options: () => ({}), log: l => logs.push(l), tag: j => `#${j.id}`, publish: () => {}, runGrants: grants };
  const live = createLive({ commandLine: () => '', parentOf: async () => null, pickedUp: () => false });
  live.start(core);
  await until(() => !POSIX || fs.existsSync(live.runEndpoint()));
  const servers = [];
  const serve = (runId, token) => {
    const out = fakeStdout();
    const srv = GM.createServer({ stdout: out, socket: live.runEndpoint(), runId, token, timeoutMs: 3000 });
    servers.push(srv);
    let id = 1;
    const call = async (name, args) => {
      const n = id++;
      srv.handle({ jsonrpc: '2.0', id: n, method: 'tools/call', params: { name, arguments: args } });
      return (await until(() => out.lines.find(l => l.id === n))).result;
    };
    return { out, srv, call };
  };
  const cleanup = () => { for (const s of servers) s.stop(); live.stop(); fs.rmSync(home, { recursive: true, force: true }); };
  return { home, grants, live, logs, posts, storeCalls, serve, cleanup };
}

test('live.runEndpoint names the socket as soon as the server exists, and drops it when listening fails', { skip: !POSIX }, async () => {
  const home = tmpHome();
  const core = { home, timeoutMs: 60000, options: () => ({}), log: () => {}, tag: j => `#${j.id}`, publish: () => {} };
  const live = createLive({ commandLine: () => '', parentOf: async () => null, pickedUp: () => false });
  live.start(core);
  assert.equal(live.runEndpoint(), LP.endpoint(home), 'a job queued before the listen event still gets the tools');
  live.stop();
  const blocked = LP.endpoint(home);
  fs.mkdirSync(blocked, { recursive: true });
  fs.writeFileSync(path.join(blocked, 'keep'), 'x');
  const logs = [];
  const broken = createLive({ commandLine: () => '', parentOf: async () => null, pickedUp: () => false });
  broken.start({ ...core, log: l => logs.push(l) });
  await until(() => logs.some(l => /cannot listen/.test(l)));
  assert.equal(broken.runEndpoint(), '', 'no socket, no tools');
  broken.stop();
  fs.rmSync(home, { recursive: true, force: true });
});

test('an ask run\'s wowgoals server writes through the bridge socket with the same checks; an unbacked name is refused and nothing is written', async () => {
  const r = await socketRig();
  try {
    assert.ok(!POSIX || fs.statSync(r.live.runEndpoint()).isSocket());
    const grant = r.grants.grant('#7');
    const s = r.serve(grant.id, grant.token);
    s.srv.handle({ jsonrpc: '2.0', id: 100, method: 'tools/list' });
    assert.deepEqual((await until(() => s.out.lines.find(l => l.id === 100))).result.tools.map(t => t.name), IN_GAME_TOOLS);

    const set = await s.call('goal_set', { profession: 'Skinning', rank: 225 });
    assert.equal(set.isError, false, set.content[0].text);
    assert.match(set.content[0].text, /Set the goal "Skinning 225"/);
    const file = path.join(r.home, 'goals', 'Bone-Forever', 'goals.json');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).rev, 1);

    const unbacked = await s.call('order_issue', { text: 'Go to Silverpine' });
    assert.equal(unbacked.isError, true);
    assert.match(unbacked.content[0].text, /words that are not allowed: "silverpine"/);
    const afterRefusal = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(afterRefusal.rev, 1, 'a refused order writes nothing');
    assert.equal(afterRefusal.orders.current, null);

    const order = await s.call('order_issue', { text: 'Skin 38 more, then train', goalId: 'g_393' });
    assert.equal(order.isError, false, order.content[0].text);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).orders.current.text, 'Skin 38 more, then train');
    assert.deepEqual(r.posts.at(-1).orders.order, { text: 'Skin 38 more, then train', goal: 'Skinning 225', pct: 83 });

    const vote = await s.call('goal_vote_open', { options: [], seconds: 60 });
    assert.equal(vote.isError, true);
    assert.match(vote.content[0].text, /Unknown tool/);
    assert.deepEqual(r.storeCalls, ['goal_set', 'order_issue', 'order_issue']);
    assert.deepEqual(r.live.sessions(), [], 'a run connection is not a live session');
    assert.equal(r.live._state.runSockets.size, 1, 'the bridge tracks the run connection');

    r.grants.revoke(grant.id);
    await until(() => r.live._state.runSockets.size === 0);
    const late = await s.call('goal_list', {});
    assert.equal(late.isError, true);
    assert.match(late.content[0].text, /goal tools are off for the rest of this run/);
    assert.deepEqual(r.storeCalls, ['goal_set', 'order_issue', 'order_issue']);
  } finally { r.cleanup(); }
});

test('the run\'s server connects at startup and holds the one slot: a token holder is refused, and a dropped connection is never replaced', async () => {
  const r = await socketRig();
  try {
    const grant = r.grants.grant('#10');
    const own = r.serve(grant.id, grant.token);
    own.srv.connect();
    await until(() => r.live._state.runSockets.size === 1);
    const thief = r.serve(grant.id, grant.token);
    const stolen = await thief.call('order_issue', { text: 'skin 10' });
    assert.equal(stolen.isError, true, 'the same token from another process gets nothing');
    assert.ok(r.logs.some(l => /already had its one connection/.test(l)), r.logs.join('\n'));
    assert.equal((await own.call('goal_list', {})).isError, false, 'the run\'s own server still works');

    const [sock] = [...r.live._state.runSockets];
    sock.destroy();
    await until(() => r.logs.some(l => /connection dropped; the run's goal tools are off/.test(l)));
    const after = await own.call('goal_list', {});
    assert.equal(after.isError, true);
    assert.match(after.content[0].text, /goal tools are off for the rest of this run/);
    const retry = r.serve(grant.id, grant.token);
    assert.equal((await retry.call('goal_list', {})).isError, true, 'no new connection after a drop');
    assert.deepEqual(r.storeCalls, ['goal_list']);
  } finally { r.cleanup(); }
});

test('live.stop() closes the run connections it accepted', async () => {
  const r = await socketRig();
  try {
    const grant = r.grants.grant('#9');
    const s = r.serve(grant.id, grant.token);
    assert.equal((await s.call('goal_list', {})).isError, false);
    const [sock] = [...r.live._state.runSockets];
    r.live.stop();
    assert.equal(sock.destroyed, true);
    assert.equal(r.live._state.runSockets.size, 0);
  } finally { r.cleanup(); }
});

test('a wowgoals server with a wrong token is refused at hello and reaches no store', async () => {
  const r = await socketRig();
  try {
    const grant = r.grants.grant('#8');
    const s = r.serve(grant.id, 'f'.repeat(64));
    const res = await s.call('goal_list', {});
    assert.equal(res.isError, true);
    assert.deepEqual(r.storeCalls, []);
    assert.ok(r.logs.some(l => /refused an in-game run connection without a valid run grant/.test(l)), r.logs.join('\n'));
    const none = GM.createServer({ stdout: fakeStdout(), socket: '', runId: '', token: '' });
    assert.equal(none.connect(), false, 'no grant, no eager connection');
    if (POSIX) {
    const missingLogs = [];
    const missingOut = fakeStdout();
    const missing = GM.createServer({ stdout: missingOut, socket: path.join(r.home, 'no.sock'), runId: grant.id, token: 'a'.repeat(64), log: l => missingLogs.push(l), connect: () => { throw new Error('must not connect'); } });
    assert.equal(missing.connect(), false, 'a missing socket fails at startup');
    assert.deepEqual(missingLogs.filter(l => /goal tools are off for this run/.test(l)).length, 1);
    missing.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'goal_list', arguments: {} } });
    assert.match((await until(() => missingOut.lines.find(l => l.id === 1))).result.content[0].text, /goal tools are off for the rest of this run/, 'no lazy connection after a failed start');
    missing.stop();
    }
    const out = fakeStdout();
    const bare = GM.createServer({ stdout: out, socket: r.live.runEndpoint(), runId: '', token: '' });
    bare.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'goal_list', arguments: {} } });
    assert.match((await until(() => out.lines.find(l => l.id === 1))).result.content[0].text, /without a run grant/);
    none.stop();
    bare.stop();
  } finally { r.cleanup(); }
});
