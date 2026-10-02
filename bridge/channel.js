#!/usr/bin/env node
'use strict';

const net = require('net');
const path = require('path');
const LP = require('./liveproto');
const G = require('./goals');
const OT = require('./observedtools');
const C = require('./campaign');

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const REPLY_TIMEOUT_MS = 15000;

function pickProtocol(requested) {
  return PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0];
}

function version() {
  try { return require('../package.json').version; } catch { return '0.0.0'; }
}

async function parentListens(ppid, { commandLine = LP.commandLine, platform } = {}) {
  let line = null;
  try { line = await commandLine(ppid, { platform }); } catch {}
  const unreadable = !line;
  return unreadable || LP.sessionListens(line);
}

function createChannel(opts) {
  const out = opts.stdout;
  const log = opts.log || (() => {});
  const home = opts.home;
  const name = opts.name || 'claude';
  const cwd = opts.cwd || '';
  const parentPid = opts.ppid || process.ppid;
  const claudeSession = opts.sessionId !== undefined ? String(opts.sessionId || '') : String(process.env.CLAUDE_CODE_SESSION_ID || '');
  const retryMs = opts.retryMs || 1000;
  const connectTo = opts.connect || (addr => net.connect(addr));
  const platform = opts.platform || process.platform;
  const replyTimeoutMs = opts.replyTimeoutMs || REPLY_TIMEOUT_MS;

  let initialized = false;
  const early = [];
  let sock = null;
  let verified = false;
  let myNonce = '';
  let retryTimer = null;
  let stopped = false;
  let nextCall = 1;
  const calls = new Map();
  const toolsListWaitMs = opts.toolsListWaitMs || 5000;
  let toolsListed = false;
  let waitingForReady = false;
  let readyTimer = null;
  let listening = typeof opts.listening === 'boolean' ? opts.listening : (opts.listening ? null : true);
  const listeningKnown = listening === null
    ? Promise.resolve(opts.listening).then(v => !!v, () => true).then(v => { listening = v; return v; })
    : Promise.resolve(listening);

  function maybeReady() {
    if (!waitingForReady || !initialized || !toolsListed || listening !== true) return;
    waitingForReady = false;
    if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; }
    connect();
  }

  function connectWhenReady() {
    waitingForReady = true;
    maybeReady();
  }

  listeningKnown.then(on => {
    if (!on) log('the parent Claude Code process does not load the claude-wow channel; staying idle');
    maybeReady();
  });

  function send(msg) { out.write(JSON.stringify(msg) + '\n'); }

  function notify(msg) {
    if (!initialized) { early.push(msg); return; }
    send(msg);
  }

  function toBridge(msg) {
    if (!sock || !verified) return false;
    sock.write(LP.encode(msg));
    return true;
  }

  function failCalls(why) {
    for (const [, c] of calls) { clearTimeout(c.timer); c.resolve({ ok: false, text: why }); }
    calls.clear();
  }

  function onBridge(msg) {
    if (!verified) {
      if (msg.type === 'welcome' && LP.sameProof(msg.proof, LP.proof(LP.readToken(home), 'bridge', myNonce))) {
        verified = true;
        log(`connected to the claude-wow bridge as "${name}"`);
        return;
      }
      if (msg.type === 'reject') log(`the bridge refused this session: ${msg.reason || 'no reason given'}`);
      else log('ignored a frame from an unverified peer');
      if (sock) sock.destroy();
      return;
    }
    if (msg.type === 'message' && typeof msg.content === 'string') {
      notify(LP.channelNotification(msg.content, msg.meta));
    } else if (msg.type === 'permission' && LP.PERMISSION_ID_RE.test(String(msg.request_id || ''))) {
      notify(LP.permissionVerdict(msg.request_id, msg.behavior === 'allow'));
    } else if ((msg.type === 'reply_result' || msg.type === 'goal_result') && calls.has(msg.call)) {
      const c = calls.get(msg.call);
      calls.delete(msg.call);
      clearTimeout(c.timer);
      c.resolve({ ok: !!msg.ok, text: String(msg.text || '') });
    }
  }

  function scheduleRetry() {
    if (stopped || retryTimer) return;
    retryTimer = setTimeout(() => { retryTimer = null; connect(); }, retryMs);
    if (retryTimer.unref) retryTimer.unref();
  }

  function connect() {
    if (stopped || sock || listening !== true) return;
    const addr = LP.endpoint(home, platform);
    if (platform !== 'win32' && !opts.skipPermissionCheck && !LP.socketOwnerOnly(addr)) { scheduleRetry(); return; }
    const token = LP.readToken(home);
    if (!token) { scheduleRetry(); return; }
    const s = connectTo(addr);
    sock = s;
    verified = false;
    myNonce = LP.nonce();
    s.on('connect', () => {
      s.write(LP.encode({ type: 'hello', name, cwd, pid: process.pid, ppid: parentPid, session: claudeSession, nonce: myNonce, proof: LP.proof(token, 'client', myNonce) }));
    });
    s.on('data', LP.lineReader(onBridge, () => s.destroy()));
    s.on('error', () => {});
    s.on('close', () => {
      if (sock === s) sock = null;
      if (verified) log('lost the claude-wow bridge; reconnecting');
      verified = false;
      failCalls('The claude-wow bridge is not connected, so the reply was not delivered.');
      scheduleRetry();
    });
  }

  function askBridge(msg, texts) {
    const call = nextCall++;
    return new Promise(resolve => {
      const timer = setTimeout(() => { calls.delete(call); resolve({ ok: false, text: texts.timeout }); }, replyTimeoutMs);
      if (timer.unref) timer.unref();
      calls.set(call, { resolve, timer });
      if (!toBridge({ ...msg, call })) {
        clearTimeout(timer);
        calls.delete(call);
        resolve({ ok: false, text: texts.offline });
      }
    });
  }

  function reply(args) {
    const chatId = String((args && args.chat_id) || '').trim();
    const text = String((args && args.text) || '').trim();
    if (!chatId || !text) return Promise.resolve({ ok: false, text: 'wow_reply needs chat_id and text.' });
    return askBridge({ type: 'reply', chat_id: chatId, message_id: String((args && args.message_id) || ''), text }, {
      timeout: 'The claude-wow bridge did not confirm the reply in time.',
      offline: 'The claude-wow bridge is not connected, so the reply was not delivered. Is the bridge running?',
    });
  }

  function goalCall(tool, args) {
    return askBridge({ type: 'goal_call', tool, args: args && typeof args === 'object' ? args : {} }, {
      timeout: `The claude-wow bridge did not answer ${tool} in time.`,
      offline: `The claude-wow bridge is not connected, so ${tool} did nothing. Is the bridge running?`,
    });
  }

  async function onRequest(msg) {
    const { id, method, params } = msg;
    if (method === 'initialize') {
      if (!(await listeningKnown)) {
        return { protocolVersion: pickProtocol(params && params.protocolVersion), capabilities: {}, serverInfo: { name: LP.SERVER_NAME, version: version() } };
      }
      return {
        protocolVersion: pickProtocol(params && params.protocolVersion),
        capabilities: { experimental: { 'claude/channel': {}, 'claude/channel/permission': {} }, tools: {} },
        serverInfo: { name: LP.SERVER_NAME, version: version() },
        instructions: LP.instructions(),
      };
    }
    if (method === 'ping') return {};
    if (method === 'tools/list') {
      if (!(await listeningKnown)) return { tools: [] };
      toolsListed = true;
      setImmediate(maybeReady);
      return { tools: [LP.replyToolSchema(), ...G.toolSchemas(), ...OT.toolSchemas(), ...C.toolSchemas()] };
    }
    if (method === 'tools/call') {
      const tool = params && params.name;
      const known = tool === LP.REPLY_TOOL || G.TOOL_NAMES.includes(tool) || OT.TOOL_NAMES.includes(tool) || C.TOOL_NAMES.includes(tool);
      if (!known || !(await listeningKnown)) return { content: [{ type: 'text', text: `Unknown tool: ${tool}` }], isError: true };
      const r = tool === LP.REPLY_TOOL ? await reply(params.arguments || {}) : await goalCall(tool, params.arguments);
      return { content: [{ type: 'text', text: r.text || (r.ok ? 'sent' : 'not sent') }], isError: !r.ok };
    }
    const err = new Error(`Method not found: ${method}`);
    err.code = -32601;
    err.id = id;
    throw err;
  }

  function onNotification(msg) {
    if (msg.method === 'notifications/initialized') {
      initialized = true;
      while (early.length) send(early.shift());
      if (waitingForReady && !readyTimer) {
        readyTimer = setTimeout(() => { toolsListed = true; maybeReady(); }, toolsListWaitMs);
        if (readyTimer.unref) readyTimer.unref();
      }
      maybeReady();
      return;
    }
    if (msg.method === 'notifications/claude/channel/permission_request') {
      const p = msg.params || {};
      if (!LP.PERMISSION_ID_RE.test(String(p.request_id || ''))) return;
      toBridge({ type: 'permission_request', request_id: p.request_id, tool_name: String(p.tool_name || ''), description: String(p.description || ''), input_preview: String(p.input_preview || '') });
    }
  }

  function handle(msg) {
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return;
    if (msg.id === undefined || msg.id === null) { onNotification(msg); return; }
    onRequest(msg).then(
      result => send({ jsonrpc: '2.0', id: msg.id, result }),
      err => send({ jsonrpc: '2.0', id: msg.id, error: { code: err.code || -32603, message: err.message } }),
    );
  }

  function feed(chunk) { reader(chunk); }
  const reader = LP.lineReader(handle);

  function stop() {
    stopped = true;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; }
    failCalls('The channel is shutting down.');
    if (sock) sock.destroy();
  }

  return { feed, connect, connectWhenReady, stop, handle, get verified() { return verified; }, get initialized() { return initialized; }, get listening() { return listening; }, listeningKnown };
}

function main() {
  const H = require('./home');
  const home = H.resolve().dir;
  const name = process.env.CLAUDE_WOW_LIVE_NAME || path.basename(process.cwd()) || 'claude';
  const ch = createChannel({
    stdout: process.stdout,
    home,
    name,
    cwd: process.cwd(),
    listening: parentListens(process.ppid),
    log: line => process.stderr.write(`[claude-wow channel] ${line}\n`),
  });
  process.stdin.on('data', ch.feed);
  process.stdin.on('end', () => { ch.stop(); process.exit(0); });
  process.on('SIGTERM', () => { ch.stop(); process.exit(0); });
  process.on('SIGINT', () => { ch.stop(); process.exit(0); });
  ch.connectWhenReady();
}

module.exports = { createChannel, parentListens, pickProtocol, PROTOCOL_VERSIONS, main };

if (require.main === module) main();
