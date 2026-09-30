'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const LP = require('../bridge/liveproto');
const P = require('../bridge/protocol');
const { createChannel, pickProtocol } = require('../bridge/channel');
const { createLive } = require('../bridge/plugins/live');

const POSIX = process.platform !== 'win32';
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

function fakeCore(home, extra = {}) {
  const calls = { reply: [], fail: [], progress: [], accept: [], publish: 0, log: [] };
  const core = {
    home,
    claudeDir: extra.claudeDir || '',
    timeoutMs: 60000,
    liveStartCommand: 'claude --dangerously-load-development-channels server:claude-wow',
    options: () => extra.options || {},
    log: line => calls.log.push(line),
    tag: job => `#${job.id}`,
    reply: (job, text, denied) => calls.reply.push({ job, text, denied }),
    late: (job, text) => (calls.late = calls.late || []).push({ job, text }),
    fail: (job, text) => calls.fail.push({ job, text }),
    progress: (job, text) => calls.progress.push({ job, text }),
    accept: job => calls.accept.push(job),
    gameContext: () => extra.ctx || '',
    publish: () => { calls.publish++; },
  };
  return { core, calls };
}

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cw-live-'));
}

async function initialize(ch, out) {
  ch.feed(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } }) + '\n');
  ch.feed(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  await until(() => out.lines.find(l => l.id === 1));
}

const LISTENING = 'claude --dangerously-load-development-channels server:claude-wow';
const DEAF = 'claude --dangerously-skip-permissions';

async function rig(opts = {}) {
  const home = tmpHome();
  const commandLine = opts.commandLine || (() => LISTENING);
  const live = createLive(opts.realPickup ? { commandLine } : { commandLine, pickedUp: opts.pickedUp || (() => false) });
  const { core, calls } = fakeCore(home, opts);
  live.start(core);
  await until(() => fs.existsSync(LP.endpoint(home)) || !POSIX);
  const out = fakeStdout();
  const ch = createChannel({ stdout: out, home, name: opts.name || 'proj', cwd: '/work/proj', retryMs: 20, ppid: opts.ppid || 777, sessionId: opts.sessionId || '' });
  const cleanup = () => { ch.stop(); live.stop(); fs.rmSync(home, { recursive: true, force: true }); };
  if (opts.connect !== false) {
    try {
      ch.connect();
      await until(() => ch.verified);
      await until(() => live.sessions().length === 1);
    } catch (e) { cleanup(); throw e; }
  }
  return { home, live, core, calls, out, ch, cleanup };
}

test('endpoint: a socket in the home folder, /tmp when that path is too long, a named pipe on Windows', () => {
  assert.equal(LP.endpoint('/home/me/.claude-wow', 'darwin'), '/home/me/.claude-wow/live.sock');
  const long = '/' + 'x'.repeat(120);
  const alt = LP.endpoint(long, 'linux');
  assert.match(alt, /^\/tmp\/claude-wow-\d+-[0-9a-f]{12}\.sock$/);
  assert.ok(Buffer.byteLength(alt) <= LP.UNIX_PATH_MAX);
  assert.equal(LP.endpoint(long, 'linux'), alt, 'the same home always maps to the same socket');
  assert.notEqual(LP.endpoint(long + 'y', 'linux'), alt);
  assert.match(LP.endpoint('C:\\Users\\me\\.claude-wow', 'win32'), /^\\\\\.\\pipe\\claude-wow-live-[0-9a-f]{12}$/);
});

test('framing: newline-delimited JSON across chunk boundaries, garbage skipped, oversized lines dropped', () => {
  const got = [];
  let overflow = 0;
  const feed = LP.lineReader(m => got.push(m), () => overflow++);
  feed(Buffer.from('{"a":1}\n{"b"'));
  feed(':2}\nnot json\n[1,2]\n\n{"c":3}');
  assert.deepEqual(got, [{ a: 1 }, { b: 2 }]);
  feed('\n');
  assert.deepEqual(got, [{ a: 1 }, { b: 2 }, { c: 3 }]);
  feed('x'.repeat(LP.MAX_LINE + 1));
  assert.equal(overflow, 1);
  feed('{"d":4}\n');
  assert.deepEqual(got.at(-1), { d: 4 });
  assert.equal(LP.encode({ type: 'x' }), '{"type":"x"}\n');
});

test('proofs: HMAC over role and nonce, compared in constant time', () => {
  const a = LP.proof('tok', 'client', 'n1');
  assert.equal(a, LP.proof('tok', 'client', 'n1'));
  assert.notEqual(a, LP.proof('tok', 'bridge', 'n1'));
  assert.notEqual(a, LP.proof('other', 'client', 'n1'));
  assert.ok(LP.sameProof(a, a));
  assert.ok(!LP.sameProof(a, a.slice(1)));
  assert.ok(!LP.sameProof('', ''));
});

test('notification shape: notifications/claude/channel with content and identifier-only string meta', () => {
  const ctx = 'Character: Thrall, level 12 Orc Shaman\nZone: Durotar (Razor Hill) 52.1, 43.0';
  const meta = LP.channelMeta({ id: 7, name: 'Quest help' }, 'tok:c1', ctx);
  assert.deepEqual(meta, { chat_id: 'tok:c1', message_id: '7', chat_name: 'Quest help', character: 'Thrall, level 12 Orc Shaman', zone: 'Durotar (Razor Hill) 52.1, 43.0' });
  const n = LP.channelNotification('hello', { chat_id: 'x', 'bad-key': 'y', empty: '', multi: 'a\nb' });
  assert.deepEqual(n, { jsonrpc: '2.0', method: 'notifications/claude/channel', params: { content: 'hello', meta: { chat_id: 'x', multi: 'a b' } } });
  assert.deepEqual(LP.permissionVerdict('abcde', true).params, { request_id: 'abcde', behavior: 'allow' });
  assert.deepEqual(LP.permissionVerdict('abcde', false).params, { request_id: 'abcde', behavior: 'deny' });
  const content = LP.channelContent('the text', 'tok:c1');
  assert.ok(content.startsWith('the text\n\n'));
  assert.match(content, /send it with wow_reply, chat_id "tok:c1"\.\)$/);
});

test('permission rules and verdicts: Need/Greed allow, the Pass text denies, anything else denies and is forwarded', () => {
  assert.equal(LP.ruleForPermission({ tool_name: 'Bash', input_preview: '{ "command": "touch x.txt", "description": "d" }' }), 'Bash(touch:*)');
  assert.equal(LP.ruleForPermission({ tool_name: 'Bash', input_preview: '{"command":"rm -rf /tmp/x ⋯ 12 code points elided ⋯' }), 'Bash(rm:*)');
  assert.equal(LP.ruleForPermission({ tool_name: 'Bash', input_preview: '' }), 'Bash');
  assert.equal(LP.ruleForPermission({ tool_name: 'Write', input_preview: '{}' }), 'Write');
  assert.deepEqual(LP.isVerdictJob({ allow: ['Bash(x:*)'], text: 'Those actions are allowed now.' }), { allow: true, forward: false });
  assert.deepEqual(LP.isVerdictJob({ allow: [], allowOnce: ['Write'], text: 'x' }), { allow: true, forward: false });
  assert.deepEqual(LP.isVerdictJob({ allow: [], text: ` ${LP.PASS_TEXT} ` }), { allow: false, forward: false });
  assert.deepEqual(LP.isVerdictJob({ allow: [], text: 'actually, what drops the sword?' }), { allow: false, forward: true });
  assert.match(LP.permissionPrompt({ tool_name: 'Bash', description: 'Create a file', input_preview: '{"command":"touch x"}' }, 'proj'), /^Claude Code \(proj\) wants to use Bash: Create a file\.\n.*touch x.*\nRoll Need or Greed/s);
});

test('start command: the dev-channel flag, a cd to the repo, CLAUDE_WOW_HOME only when set, --resume when given', () => {
  assert.equal(LP.startCommand(), 'claude --dangerously-load-development-channels server:claude-wow');
  assert.equal(LP.startCommand({ repo: '/Users/me/wow ai', home: '/tmp/h', resume: 'abc-123' }),
    "cd '/Users/me/wow ai' && CLAUDE_WOW_HOME=/tmp/h claude --resume abc-123 --dangerously-load-development-channels server:claude-wow");
});

test('slot files carry the connected live sessions and the start command', () => {
  const lua = P.luaTable('ClaudeWoW_SlotData', [], { live: { sessions: ['proj (/work/proj)'], start: 'claude --x' } });
  assert.match(lua, /\tlive = \{ sessions = \{ "proj \(\/work\/proj\)" \}, start = "claude --x" \},/);
  assert.doesNotMatch(P.luaTable('ClaudeWoW_SlotData', [], {}), /live =/);
});

test('channel server: initialize declares the channel and permission capabilities, tools/list has wow_reply', async () => {
  const out = fakeStdout();
  const ch = createChannel({ stdout: out, home: tmpHome(), retryMs: 1000 });
  ch.feed(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2026-07-28' } }) + '\n');
  const init = await until(() => out.lines.find(l => l.id === 1));
  assert.equal(init.result.protocolVersion, '2025-06-18', 'never negotiates a revision channels do not register on');
  assert.deepEqual(init.result.capabilities, { experimental: { 'claude/channel': {}, 'claude/channel/permission': {} }, tools: {} });
  assert.equal(init.result.serverInfo.name, 'claude-wow');
  assert.match(init.result.instructions, /wow_reply/);
  assert.match(init.result.instructions, /short/);
  assert.equal(pickProtocol('2024-11-05'), '2024-11-05');
  ch.feed(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
  const list = await until(() => out.lines.find(l => l.id === 2));
  assert.deepEqual(list.result.tools.map(t => t.name), ['wow_reply']);
  assert.deepEqual(list.result.tools[0].inputSchema.required, ['chat_id', 'text']);
  ch.feed(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'resources/list' }) + '\n');
  const nope = await until(() => out.lines.find(l => l.id === 3));
  assert.equal(nope.error.code, -32601);
  ch.feed(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'wow_reply', arguments: { chat_id: 'c', text: 'hi' } } }) + '\n');
  const offline = await until(() => out.lines.find(l => l.id === 4));
  assert.equal(offline.result.isError, true);
  assert.match(offline.result.content[0].text, /not connected/);
  ch.feed(JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'ping' }) + '\n');
  assert.deepEqual((await until(() => out.lines.find(l => l.id === 5))).result, {});
  ch.stop();
});

test('bridge to session: a message becomes a channel notification, wow_reply goes through the normal reply path', async () => {
  const r = await rig({ ctx: 'Character: Thrall, level 12 Orc Shaman\nZone: Durotar' });
  try {
    await initialize(r.ch, r.out);
    const job = { id: 4, session: 'tok', chat: 'c1', name: 'Live', text: 'where is the flight master?', allow: [] };
    await r.live.handle(job, r.core);
    assert.equal(job.agent, 'claude');
    assert.equal(r.calls.accept.length, 1, 'the message goes into the transcript');
    const note = await until(() => r.out.lines.find(l => l.method === 'notifications/claude/channel'));
    assert.match(note.params.content, /^\[In-game situation[\s\S]*Character: Thrall[\s\S]*where is the flight master\?\n\n\(The player reads your answer in game: send it with wow_reply, chat_id "tok:c1"\.\)$/);
    assert.deepEqual(note.params.meta, { chat_id: 'tok:c1', message_id: '4', chat_name: 'Live', character: 'Thrall, level 12 Orc Shaman', zone: 'Durotar' });
    assert.match(r.calls.progress[0].text, /Sent to the live Claude Code session "proj"/);
    r.ch.feed(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'wow_reply', arguments: { chat_id: 'tok:c1', text: 'East of Razor Hill.\nTL;DR: east' } } }) + '\n');
    const res = await until(() => r.out.lines.find(l => l.id === 9));
    assert.equal(res.result.isError, false);
    assert.match(res.result.content[0].text, /Delivered/);
    assert.equal(r.calls.reply.length, 1);
    assert.equal(r.calls.reply[0].job, job);
    assert.equal(r.calls.reply[0].text, 'East of Razor Hill.\nTL;DR: east');
    r.ch.feed(JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'wow_reply', arguments: { chat_id: 'tok:c1', text: 'again' } } }) + '\n');
    const twice = await until(() => r.out.lines.find(l => l.id === 10));
    assert.equal(twice.result.isError, true, 'one reply per message');
    assert.match(twice.result.content[0].text, /No player message is waiting/);
    assert.ok(r.calls.publish >= 1, 'a connect republishes the slot files');
    assert.deepEqual(r.live.status(), ['proj (/work/proj)']);
  } finally { r.cleanup(); }
});

test('the channel registers with the bridge only once Claude Code has listed its tools', async () => {
  const r = await rig({ connect: false });
  try {
    r.ch.connectWhenReady();
    await new Promise(res => setTimeout(res, 100));
    assert.deepEqual(r.live.status(), [], 'not before initialize');
    await initialize(r.ch, r.out);
    await new Promise(res => setTimeout(res, 100));
    assert.deepEqual(r.live.status(), [], 'not before tools/list, or wow_reply may be missing when the first message lands');
    r.ch.feed(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
    await until(() => r.live.status().length === 1);
  } finally { r.cleanup(); }
});

test('no session connected: the chat is told plainly how to start one', async () => {
  const r = await rig({ connect: false, options: { waitMs: 0 } });
  try {
    const job = { id: 1, session: 'tok', chat: 'c1', text: 'hi', allow: [] };
    await r.live.handle(job, r.core);
    assert.equal(r.calls.fail.length, 1);
    assert.match(r.calls.fail[0].text, /^No live Claude Code session is connected\. Start one with:\nclaude --dangerously-load-development-channels server:claude-wow/);
    assert.deepEqual(r.live.status(), []);
  } finally { r.cleanup(); }
});

test('/claude -r targets one running session: by its Claude Code session id or prefix, its title or its name; another target is told it is not connected', async () => {
  const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-claude-'));
  const id = '6624f327-7126-423e-a653-d7cf7a4e492b';
  fs.mkdirSync(path.join(claudeDir, 'sessions'));
  fs.writeFileSync(path.join(claudeDir, 'sessions', '4242.json'), JSON.stringify({ pid: 4242, sessionId: id, cwd: '/work/proj', name: 'wow-ai-90' }));
  const r = await rig({ claudeDir, ppid: 4242, options: { waitMs: 0 } });
  try {
    await initialize(r.ch, r.out);
    const [s] = r.live.sessions();
    assert.equal(s.id, id, 'the channel names the Claude Code process that spawned it, and its pid file names the session');
    assert.equal(s.name, 'proj');
    assert.equal(s.title, 'wow-ai-90');
    assert.equal(s.cwd, '/work/proj');
    const sent = () => r.out.lines.filter(l => l.method === 'notifications/claude/channel').length;
    const tries = [['6624f327', true], [id, true], ['WOW-AI-90', true], ['proj', true], ['662', false], ['other', false]];
    let n = 0;
    for (const [target, hit] of tries) {
      const job = { id: ++n, session: 'tok', chat: 'c' + n, text: 'hi ' + target, allow: [], liveTarget: target };
      const before = sent();
      await r.live.handle(job, r.core);
      if (hit) {
        await until(() => sent() === before + 1);
      } else {
        const fail = r.calls.fail.find(f => f.job === job);
        assert.ok(fail, target);
        assert.equal(fail.text, `The running Claude Code session "${target}" is not connected. /claude -r lists the ones that are, and /claude -r <id> resumes a session headless when its terminal is closed.`);
        assert.equal(sent(), before);
      }
    }
  } finally { r.cleanup(); fs.rmSync(claudeDir, { recursive: true, force: true }); }
});

test('a session that connects within waitMs still gets the message', async () => {
  const r = await rig({ connect: false, options: { waitMs: 3000 } });
  try {
    await initialize(r.ch, r.out);
    const job = { id: 2, session: 'tok', chat: 'c1', text: 'hi', allow: [] };
    const handled = r.live.handle(job, r.core);
    setTimeout(() => r.ch.connect(), 50);
    await handled;
    assert.equal(r.calls.fail.length, 0);
    await until(() => r.out.lines.find(l => l.method === 'notifications/claude/channel'));
  } finally { r.cleanup(); }
});

test('socket: owner-only permissions, and a peer without the token is refused', { skip: !POSIX }, async () => {
  const r = await rig({ connect: false });
  try {
    const addr = LP.endpoint(r.home);
    assert.equal(fs.statSync(addr).mode & 0o777, 0o600);
    assert.ok(LP.socketOwnerOnly(addr));
    assert.equal(fs.statSync(LP.tokenFile(r.home)).mode & 0o777, 0o600);
    const got = [];
    const closed = new Promise(resolve => {
      const s = net.connect(addr, () => s.write(LP.encode({ type: 'hello', name: 'evil', nonce: 'n', proof: LP.proof('wrong', 'client', 'n') })));
      s.on('data', LP.lineReader(m => got.push(m)));
      s.on('close', resolve);
      s.on('error', () => {});
    });
    await closed;
    assert.deepEqual(got, [{ type: 'reject', reason: 'bad hello' }]);
    assert.deepEqual(r.live.status(), []);
  } finally { r.cleanup(); }
});

test('channel side: frames from a peer that cannot prove the token are ignored', { skip: !POSIX }, async () => {
  const home = tmpHome();
  LP.writeToken(home);
  const addr = LP.endpoint(home);
  const fake = net.createServer(sock => {
    sock.on('data', LP.lineReader(() => {
      sock.write(LP.encode({ type: 'welcome', proof: 'forged' }));
      sock.write(LP.encode({ type: 'message', content: 'injected', meta: { chat_id: 'x' } }));
    }));
    sock.on('error', () => {});
  });
  await new Promise(resolve => fake.listen(addr, resolve));
  fs.chmodSync(addr, 0o600);
  const out = fakeStdout();
  const ch = createChannel({ stdout: out, home, retryMs: 5000 });
  try {
    await initialize(ch, out);
    ch.connect();
    await new Promise(r => setTimeout(r, 200));
    assert.equal(ch.verified, false);
    assert.equal(out.lines.filter(l => l.method === 'notifications/claude/channel').length, 0);
  } finally {
    ch.stop();
    fake.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('channel side: a socket other users can reach is never connected to', { skip: !POSIX }, async () => {
  const home = tmpHome();
  LP.writeToken(home);
  const addr = LP.endpoint(home);
  let accepted = 0;
  const open = net.createServer(sock => { accepted++; sock.destroy(); });
  await new Promise(resolve => open.listen(addr, resolve));
  fs.chmodSync(addr, 0o666);
  const ch = createChannel({ stdout: fakeStdout(), home, retryMs: 20 });
  try {
    ch.connect();
    await new Promise(r => setTimeout(r, 150));
    assert.equal(accepted, 0);
  } finally {
    ch.stop();
    open.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('permission relay: the request becomes a Need/Greed roll in the chat, the roll answers it', async () => {
  const r = await rig();
  try {
    await initialize(r.ch, r.out);
    const job = { id: 5, session: 'tok', chat: 'c1', text: 'touch a file', allow: [] };
    await r.live.handle(job, r.core);
    r.ch.feed(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/claude/channel/permission_request', params: { request_id: 'abcde', tool_name: 'Bash', description: 'Create a file', input_preview: '{"command":"touch x.txt"}' } }) + '\n');
    await until(() => r.calls.reply.length === 1);
    assert.equal(r.calls.reply[0].job, job);
    assert.deepEqual(r.calls.reply[0].denied, ['Bash(touch:*)'], 'the reply carries the rule, so the addon opens the roll');
    assert.match(r.calls.reply[0].text, /Roll Need or Greed/);
    const greed = { id: 6, session: 'tok', chat: 'c1', text: 'Those actions are allowed for this run.', allow: [], allowOnce: ['Bash(touch:*)'] };
    await r.live.handle(greed, r.core);
    const verdict = await until(() => r.out.lines.find(l => l.method === 'notifications/claude/channel/permission'));
    assert.deepEqual(verdict.params, { request_id: 'abcde', behavior: 'allow' });
    assert.equal(r.out.lines.filter(l => l.method === 'notifications/claude/channel').length, 1, 'the verdict is not forwarded as chat');
    r.ch.feed(JSON.stringify({ jsonrpc: '2.0', id: 20, method: 'tools/call', params: { name: 'wow_reply', arguments: { chat_id: 'tok:c1', text: 'done' } } }) + '\n');
    await until(() => r.calls.reply.length === 2);
    assert.equal(r.calls.reply[1].job, greed, 'the answer after the roll lands on the verdict message');

    const job2 = { id: 7, session: 'tok', chat: 'c1', text: 'touch another', allow: [] };
    await r.live.handle(job2, r.core);
    r.ch.feed(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/claude/channel/permission_request', params: { request_id: 'fghij', tool_name: 'Write', description: 'Write', input_preview: '{}' } }) + '\n');
    await until(() => r.calls.reply.length === 3);
    await r.live.handle({ id: 8, session: 'tok', chat: 'c1', text: LP.PASS_TEXT, allow: [] }, r.core);
    const deny = await until(() => r.out.lines.find(l => l.method === 'notifications/claude/channel/permission' && l.params.request_id === 'fghij'));
    assert.equal(deny.params.behavior, 'deny');
  } finally { r.cleanup(); }
});

test('permission relay: an unanswered roll is denied after permissionTimeoutMs; a request with no chat waiting stays in the terminal', async () => {
  const r = await rig({ options: { permissionTimeoutMs: 50 } });
  try {
    await initialize(r.ch, r.out);
    r.ch.feed(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/claude/channel/permission_request', params: { request_id: 'aaaaa', tool_name: 'Bash', description: 'x', input_preview: '{}' } }) + '\n');
    await new Promise(res => setTimeout(res, 100));
    assert.equal(r.calls.reply.length, 0);
    assert.equal(r.out.lines.filter(l => l.method === 'notifications/claude/channel/permission').length, 0);
    await r.live.handle({ id: 1, session: 'tok', chat: 'c1', text: 'go', allow: [] }, r.core);
    r.ch.feed(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/claude/channel/permission_request', params: { request_id: 'bbbbb', tool_name: 'Bash', description: 'x', input_preview: '{}' } }) + '\n');
    const deny = await until(() => r.out.lines.find(l => l.method === 'notifications/claude/channel/permission'));
    assert.deepEqual(deny.params, { request_id: 'bbbbb', behavior: 'deny' });
  } finally { r.cleanup(); }
});

test('a session that disconnects fails the messages still waiting on it', async () => {
  const r = await rig();
  try {
    await initialize(r.ch, r.out);
    const job = { id: 3, session: 'tok', chat: 'c1', text: 'hi', allow: [] };
    await r.live.handle(job, r.core);
    r.ch.stop();
    await until(() => r.calls.fail.length === 1);
    assert.equal(r.calls.fail[0].job, job);
    assert.match(r.calls.fail[0].text, /disconnected before it answered/);
    await until(() => r.live.status().length === 0);
  } finally { r.cleanup(); }
});

test('the live plugin is registered in the bridge and .mcp.json starts the channel server', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'bridge', 'bridge.js'), 'utf8');
  assert.match(src, /registry\.register\(require\('\.\/plugins\/live'\)\)/);
  const mcp = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.mcp.json'), 'utf8'));
  assert.deepEqual(mcp.mcpServers['claude-wow'], { command: 'node', args: ['bridge/channel.js'], alwaysLoad: true });
});

const SESSION_A = '6624f327-7126-423e-a653-d7cf7a4e492b';
const SESSION_B = 'f02436b8-8a5f-4c05-823e-bef25f88ff7b';

const settle = async (cond, rounds = 2000) => {
  for (let i = 0; i < rounds; i++) {
    const v = cond();
    if (v) return v;
    await new Promise(r => setImmediate(r));
  }
  throw new Error('timed out waiting');
};

function claudeFixture(pid, id, cwd, lines = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-claude-'));
  fs.mkdirSync(path.join(dir, 'sessions'));
  fs.writeFileSync(path.join(dir, 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId: id, cwd, name: 'wow-ai-90', nameSource: 'derived' }));
  const proj = path.join(dir, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(proj, { recursive: true });
  const transcript = path.join(proj, `${id}.jsonl`);
  fs.writeFileSync(transcript, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return { dir, transcript };
}

test('listening detection: the Claude Code command line must load the claude-wow channel', () => {
  const yes = [
    'claude --dangerously-load-development-channels server:claude-wow',
    'claude --resume 6624f327 --dangerously-load-development-channels server:claude-wow',
    '/usr/local/bin/node /opt/claude/cli.js --dangerously-load-development-channels server:other server:claude-wow --model haiku',
    'claude --dangerously-load-development-channels=server:claude-wow',
    'claude --channels server:claude-wow',
    'claude --channels=plugin:other@market,plugin:claude-wow@local',
    '"C:\\Program Files\\claude\\claude.exe" --dangerously-load-development-channels server:claude-wow',
  ];
  const no = [
    'claude --dangerously-skip-permissions',
    'claude',
    'claude --dangerously-load-development-channels server:other',
    'claude --dangerously-load-development-channels',
    'claude --channels server:claude-wow-fork',
    'claude --mcp-config claude-wow.json server:claude-wow',
    '',
    null,
  ];
  for (const line of yes) assert.equal(LP.listensToChannel(line), true, line);
  for (const line of no) assert.equal(LP.listensToChannel(line), false, String(line));
  assert.deepEqual(LP.channelFlagValues('claude --dangerously-load-development-channels server:a server:b -c'), ['server:a', 'server:b']);

  const calls = [];
  const run = (file, args) => { calls.push([file, ...args]); return 'claude --dangerously-load-development-channels server:claude-wow\n'; };
  assert.equal(LP.commandLine(3421, { platform: 'darwin', run }), 'claude --dangerously-load-development-channels server:claude-wow');
  assert.deepEqual(calls[0], ['ps', '-ww', '-o', 'args=', '-p', '3421']);
  LP.commandLine(3421, { platform: 'win32', run });
  assert.equal(calls[1][0], 'powershell.exe');
  assert.match(calls[1].at(-1), /Win32_Process -Filter 'ProcessId=3421'\)\.CommandLine/);
  assert.equal(LP.commandLine(0, { run }), null);
  assert.equal(LP.commandLine('1; rm -rf /', { run }), null, 'only a numeric pid reaches the command');
  assert.equal(LP.commandLine(5, { run: () => { throw new Error('no such process'); } }), null);
  assert.equal(LP.commandLine(5, { run: () => '' }), null);
  assert.equal(LP.restartCommand({ cwd: '/Users/me/wow ai', id: SESSION_A }, ''), `cd '/Users/me/wow ai' && claude --resume ${SESSION_A} --dangerously-load-development-channels server:claude-wow`);
  assert.equal(typeof LP.commandLine(process.pid), 'string', 'reads a real process on this machine');
});

test('a session started without the channel is connected but never offered as live: a targeted message gets the exact restart command, an untargeted one is told why', async () => {
  const fx = claudeFixture(4242, SESSION_A, '/work/proj');
  const r = await rig({ claudeDir: fx.dir, ppid: 4242, commandLine: () => DEAF, options: { waitMs: 0 } });
  try {
    await initialize(r.ch, r.out);
    assert.deepEqual(r.live.status(), [], 'the slot files list listening sessions only');
    const [s] = r.live.sessions();
    assert.equal(s.listening, false);
    assert.equal(s.id, SESSION_A);
    assert.equal(s.restart, `cd /work/proj && claude --resume ${SESSION_A} --dangerously-load-development-channels server:claude-wow`);
    assert.ok(r.calls.log.some(l => l.includes('not listening (Claude Code pid 4242 was started without --dangerously-load-development-channels server:claude-wow)')), r.calls.log.join('\n'));
    for (const target of [SESSION_A, '6624f327', 'proj']) {
      const job = { id: 1, session: 'tok', chat: 'c-' + target, text: 'hey!', allow: [], liveTarget: target };
      await r.live.handle(job, r.core);
      const fail = r.calls.fail.find(f => f.job === job);
      assert.ok(fail, target);
      assert.equal(fail.text, [
        'The Claude Code session "wow-ai-90" is running, but it was not started with the claude-wow channel, so it cannot hear the game.',
        'Restart it in its terminal with:',
        `cd /work/proj && claude --resume ${SESSION_A} --dangerously-load-development-channels server:claude-wow`,
        'Or pick it in /claude -r and click resume headless to continue it here without the terminal.',
      ].join('\n'));
    }
    const plain = { id: 2, session: 'tok', chat: 'c9', text: 'hi', allow: [] };
    await r.live.handle(plain, r.core);
    assert.match(r.calls.fail.find(f => f.job === plain).text, /^No live Claude Code session is connected\. Start one with:\n[\s\S]*\n1 running session was started without the channel; \/claude -r shows how to restart it\.$/);
    assert.equal(r.out.lines.filter(l => l.method === 'notifications/claude/channel').length, 0, 'nothing is sent into a session that cannot hear it');
  } finally { r.cleanup(); fs.rmSync(fx.dir, { recursive: true, force: true }); }
});

test('another channel server, or a command line that cannot be read, is not listening either', async () => {
  for (const [commandLine, why] of [[() => 'claude --dangerously-load-development-channels server:other', 'was started without'], [() => null, 'cannot read the command line of Claude Code pid 777']]) {
    const r = await rig({ commandLine });
    try {
      assert.deepEqual(r.live.status(), []);
      assert.equal(r.live.sessions()[0].listening, false);
      assert.ok(r.calls.log.some(l => l.includes(why)), r.calls.log.join('\n'));
    } finally { r.cleanup(); }
  }
});

test('the session list: one row per Claude Code session, listening ones first; the channel names its parent pid and CLAUDE_CODE_SESSION_ID, never an inherited CLAUDE_PID', async () => {
  const r = await rig({ sessionId: SESSION_B, ppid: 11, commandLine: pid => (pid === 22 ? LISTENING : DEAF) });
  const extra = [];
  try {
    const again = createChannel({ stdout: fakeStdout(), home: r.home, name: 'proj', cwd: '/work/proj', retryMs: 20, ppid: 11, sessionId: SESSION_B });
    extra.push(again);
    again.connect();
    await until(() => again.verified);
    assert.equal(r.live.sessions().length, 1, 'two channel servers for one session are one row');
    const other = createChannel({ stdout: fakeStdout(), home: r.home, name: 'other', cwd: '/work/other', retryMs: 20, ppid: 22, sessionId: SESSION_A });
    extra.push(other);
    other.connect();
    await until(() => r.live.sessions().length === 2);
    assert.deepEqual(r.live.sessions().map(s => [s.id, s.listening]), [[SESSION_A, true], [SESSION_B, false]]);
    assert.deepEqual(r.live.status(), ['other (/work/other)']);
  } finally { for (const c of extra) c.stop(); r.cleanup(); }
  const prev = { pid: process.env.CLAUDE_PID, id: process.env.CLAUDE_CODE_SESSION_ID };
  process.env.CLAUDE_PID = '31337';
  process.env.CLAUDE_CODE_SESSION_ID = SESSION_A;
  try {
    const home = tmpHome();
    LP.writeToken(home);
    const hellos = [];
    const srv = net.createServer(sock => sock.on('data', LP.lineReader(m => { hellos.push(m); sock.destroy(); })));
    await new Promise(res => srv.listen(LP.endpoint(home), res));
    if (POSIX) fs.chmodSync(LP.endpoint(home), 0o600);
    const ch = createChannel({ stdout: fakeStdout(), home, retryMs: 5000 });
    ch.connect();
    await until(() => hellos.length === 1);
    assert.equal(hellos[0].ppid, process.ppid, 'CLAUDE_PID leaks in from an outer session, so the parent pid wins');
    assert.equal(hellos[0].session, SESSION_A);
    ch.stop();
    srv.close();
    fs.rmSync(home, { recursive: true, force: true });
  } finally {
    if (prev.pid === undefined) delete process.env.CLAUDE_PID; else process.env.CLAUDE_PID = prev.pid;
    if (prev.id === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = prev.id;
  }
});

test('delivery watchdog: no sign of pickup within 45 s fails the message with one line; a late reply still lands', async (t) => {
  const r = await rig();
  try {
    await initialize(r.ch, r.out);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const job = { id: 159, session: 'tok', chat: 'c1', text: 'hey!', allow: [] };
    await r.live.handle(job, r.core);
    await settle(() => r.out.lines.some(l => l.method === 'notifications/claude/channel'));
    for (let s = 0; s < 44; s++) t.mock.timers.tick(1000);
    t.mock.timers.tick(999);
    assert.equal(r.calls.fail.length, 0, 'still waiting at 44.999 s');
    t.mock.timers.tick(1);
    assert.equal(r.calls.fail.length, 1);
    assert.equal(r.calls.fail[0].job, job);
    assert.equal(r.calls.fail[0].text, 'The session "proj" did not pick it up — it may be busy or not listening. A late reply still lands here.');
    assert.ok(!r.calls.fail[0].text.includes('\n'), 'one line');
    for (let s = 0; s < 10; s++) t.mock.timers.tick(1000);
    assert.equal(r.calls.fail.length, 1, 'failed once');
    r.ch.feed(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'wow_reply', arguments: { chat_id: 'tok:c1', text: 'Sorry, I was busy. Hi!' } } }) + '\n');
    const res = await settle(() => r.out.lines.find(l => l.id === 9));
    assert.equal(res.result.isError, false);
    assert.deepEqual((r.calls.late || []).map(l => [l.job, l.text]), [[job, 'Sorry, I was busy. Hi!']]);
    assert.equal(r.calls.reply.length, 0, 'a late reply is not the failed message\'s reply');
  } finally { t.mock.timers.reset(); r.cleanup(); }
});

test('delivery watchdog: the message showing up in the session transcript counts as picked up', async (t) => {
  const fx = claudeFixture(4242, SESSION_A, '/work/proj', [{ type: 'user', message: { role: 'user', content: 'earlier' } }]);
  const r = await rig({ claudeDir: fx.dir, ppid: 4242, realPickup: true });
  try {
    await initialize(r.ch, r.out);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const job = { id: 7, session: 'tok', chat: 'c1', text: 'where is the flight master?', allow: [] };
    await r.live.handle(job, r.core);
    await settle(() => r.out.lines.some(l => l.method === 'notifications/claude/channel'));
    t.mock.timers.tick(5000);
    assert.ok(!r.calls.progress.some(p => /picked it up/.test(p.text)));
    fs.appendFileSync(fx.transcript, JSON.stringify({ type: 'user', message: { role: 'user', content: '<channel source="claude-wow" chat_id="tok:c1" message_id="7" chat_name="Live">\nwhere is the flight master?\n</channel>' } }) + '\n');
    t.mock.timers.tick(5000);
    assert.ok(r.calls.progress.some(p => p.text === 'The live Claude Code session "proj" picked it up and is working on it.'), JSON.stringify(r.calls.progress));
    for (let s = 0; s < 45; s++) t.mock.timers.tick(1000);
    assert.equal(r.calls.fail.length, 0, 'a session that picked it up is not failed at 45 s');
    for (let s = 0; s < 15; s++) t.mock.timers.tick(1000);
    assert.match(r.calls.fail[0].text, /did not answer within 1 min/, 'it gets the full reply timeout instead');
    assert.deepEqual(require('../bridge/plugins/live').pickupMarkers('tok:c1', 7), ['chat_id="tok:c1" message_id="7"', 'chat_id=\\"tok:c1\\" message_id=\\"7\\"']);
  } finally { t.mock.timers.reset(); r.cleanup(); fs.rmSync(fx.dir, { recursive: true, force: true }); }
});

test('delivery watchdog: a permission request counts as activity, and pickupMs 0 turns the watchdog off', async (t) => {
  const r = await rig();
  try {
    await initialize(r.ch, r.out);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    await r.live.handle({ id: 1, session: 'tok', chat: 'c1', text: 'touch a file', allow: [] }, r.core);
    await settle(() => r.out.lines.some(l => l.method === 'notifications/claude/channel'));
    r.ch.feed(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/claude/channel/permission_request', params: { request_id: 'abcde', tool_name: 'Bash', description: 'x', input_preview: '{}' } }) + '\n');
    await settle(() => r.calls.reply.length === 1);
    t.mock.timers.tick(46000);
    assert.equal(r.calls.fail.length, 0);
  } finally { t.mock.timers.reset(); r.cleanup(); }
  const off = await rig({ options: { pickupMs: 0 } });
  try {
    await initialize(off.ch, off.out);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    await off.live.handle({ id: 1, session: 'tok', chat: 'c1', text: 'hi', allow: [] }, off.core);
    t.mock.timers.tick(50000);
    assert.equal(off.calls.fail.length, 0);
  } finally { t.mock.timers.reset(); off.cleanup(); }
});
