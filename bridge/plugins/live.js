'use strict';

const fs = require('fs');
const net = require('net');
const LP = require('../liveproto');
const P = require('../protocol');
const SS = require('../sessions');

const DEFAULTS = { waitMs: 3000, permissionTimeoutMs: 120000, helloTimeoutMs: 5000 };
const CLAUDE_INFO_TTL_MS = 5000;

function createLive(overrides = {}) {
  const sessions = new Map();
  const pending = new Map();
  const permissions = new Map();
  const waiters = new Set();
  let server = null;
  let address = '';
  let token = '';
  let core = null;
  let nextConn = 1;
  let platform = overrides.platform || process.platform;

  const opt = key => {
    const o = core ? core.options('live') : {};
    return Number.isFinite(o[key]) && o[key] >= 0 ? o[key] : (overrides[key] !== undefined ? overrides[key] : DEFAULTS[key]);
  };
  const replyTimeoutMs = () => {
    const o = core ? core.options('live') : {};
    if (Number.isFinite(o.timeoutMs) && o.timeoutMs > 0) return o.timeoutMs;
    return (core && core.timeoutMs) || 1800000;
  };
  const log = line => { if (core) core.log(`live: ${line}`); };

  function connected() {
    return [...sessions.values()].filter(s => s.verified);
  }

  function describe(s) {
    return `${s.name}${s.cwd ? ' (' + s.cwd + ')' : ''}`;
  }

  function claudeInfo(s) {
    const dir = overrides.claudeDir || (core && core.claudeDir) || '';
    if (!dir || !s.ppid) return null;
    if (!s.info || Date.now() - s.info.at > CLAUDE_INFO_TTL_MS) s.info = { at: Date.now(), value: SS.runningClaude(dir, s.ppid) };
    return s.info.value;
  }

  function sessionOf(s) {
    const info = claudeInfo(s);
    return { id: (info && info.id) || '', name: s.name, title: (info && info.name) || '', cwd: s.cwd || (info && info.cwd) || '', agent: 'claude', at: Math.floor(s.connectedAt / 1000) };
  }

  function status() {
    return connected().sort((a, b) => a.connectedAt - b.connectedAt).map(describe);
  }

  function sessionsList() {
    return connected().sort((a, b) => a.connectedAt - b.connectedAt).map(sessionOf);
  }

  function matchesTarget(s, target) {
    const want = String(target || '').trim().toLowerCase();
    if (!want) return true;
    const info = sessionOf(s);
    const id = info.id.toLowerCase();
    return (id && (id === want || (want.length >= SS.MIN_PREFIX && id.startsWith(want))))
      || info.name.toLowerCase() === want || (info.title && info.title.toLowerCase() === want);
  }

  function changed() {
    if (core && typeof core.publish === 'function') core.publish();
  }

  function sendTo(s, msg) {
    if (!s || !s.verified || s.sock.destroyed) return false;
    s.sock.write(LP.encode(msg));
    return true;
  }

  function clearPending(chatId) {
    const p = pending.get(chatId);
    if (!p) return null;
    clearTimeout(p.timer);
    pending.delete(chatId);
    return p;
  }

  function clearPermission(chatId) {
    const perm = permissions.get(chatId);
    if (!perm) return null;
    clearTimeout(perm.timer);
    permissions.delete(chatId);
    return perm;
  }

  function expectReply(job, chatId, s) {
    const prev = clearPending(chatId);
    if (prev && prev.job !== job) core.fail(prev.job, 'A newer message in this chat replaced this one before the live session answered.');
    const ms = replyTimeoutMs();
    const timer = setTimeout(() => {
      const p = pending.get(chatId);
      if (!p || p.job !== job) return;
      pending.delete(chatId);
      log(`${core.tag(job)} no reply from "${s.name}" within ${ms} ms`);
      core.fail(job, `The live Claude Code session "${s.name}" did not answer within ${Math.round(ms / 60000) || 1} min.`);
    }, ms);
    if (timer.unref) timer.unref();
    pending.set(chatId, { job, conn: s.id, sentAt: Date.now(), timer });
  }

  function onReply(s, msg) {
    const chatId = String(msg.chat_id || '');
    const answer = ok => text => sendTo(s, { type: 'reply_result', call: msg.call, ok, text });
    const p = pending.get(chatId);
    if (!p) {
      answer(false)(`No player message is waiting for a reply in chat_id "${chatId}". Each player message takes exactly one ${LP.REPLY_TOOL} call, with the chat_id from its <channel> tag.`);
      return;
    }
    if (p.conn !== s.id) {
      answer(false)(`chat_id "${chatId}" belongs to another Claude Code session.`);
      return;
    }
    clearPending(chatId);
    const text = String(msg.text || '').trim();
    log(`${core.tag(p.job)} reply from "${s.name}" (${text.length} chars)`);
    core.reply(p.job, text);
    answer(true)('Delivered to the player\'s in-game whisper tab.');
  }

  function onPermissionRequest(s, msg) {
    const requestId = String(msg.request_id || '');
    if (!LP.PERMISSION_ID_RE.test(requestId)) return;
    let target = null;
    for (const [chatId, p] of pending) {
      if (p.conn === s.id && (!target || p.sentAt > target.p.sentAt)) target = { chatId, p };
    }
    if (!target) {
      log(`permission request ${requestId} from "${s.name}" (${msg.tool_name}) has no in-game chat waiting; left to the terminal`);
      return;
    }
    const { chatId, p } = target;
    clearPending(chatId);
    clearPermission(chatId);
    const rule = LP.ruleForPermission(msg);
    const ms = opt('permissionTimeoutMs');
    const timer = setTimeout(() => {
      const perm = permissions.get(chatId);
      if (!perm || perm.requestId !== requestId) return;
      permissions.delete(chatId);
      sendTo(sessions.get(perm.conn), { type: 'permission', request_id: requestId, behavior: 'deny' });
      log(`${core.tag(p.job)} permission ${requestId} (${rule}) timed out after ${ms} ms: denied`);
    }, ms);
    if (timer.unref) timer.unref();
    permissions.set(chatId, { requestId, conn: s.id, rule, timer });
    log(`${core.tag(p.job)} permission ${requestId} for ${rule} relayed to the game`);
    core.reply(p.job, LP.permissionPrompt(msg, s.name), [rule]);
  }

  function onVerified(s, msg) {
    if (msg.type === 'reply') onReply(s, msg);
    else if (msg.type === 'permission_request') onPermissionRequest(s, msg);
  }

  function onConnection(sock) {
    const s = { id: nextConn++, sock, verified: false, name: '', cwd: '', pid: 0, connectedAt: Date.now() };
    sessions.set(s.id, s);
    const hello = setTimeout(() => { if (!s.verified) sock.destroy(); }, opt('helloTimeoutMs'));
    if (hello.unref) hello.unref();
    sock.on('data', LP.lineReader(msg => {
      if (s.verified) { onVerified(s, msg); return; }
      clearTimeout(hello);
      if (msg.type !== 'hello' || typeof msg.nonce !== 'string' || !msg.nonce || !LP.sameProof(msg.proof, LP.proof(token, 'client', msg.nonce))) {
        sock.write(LP.encode({ type: 'reject', reason: 'bad hello' }));
        sock.destroy();
        log('refused a connection without a valid hello');
        return;
      }
      s.verified = true;
      s.name = String(msg.name || 'claude').replace(/[^\w .@-]/g, '').slice(0, 40) || 'claude';
      s.cwd = String(msg.cwd || '').slice(0, 300);
      s.pid = Number(msg.pid) || 0;
      s.ppid = Number(msg.ppid) || 0;
      sock.write(LP.encode({ type: 'welcome', proof: LP.proof(token, 'bridge', msg.nonce) }));
      log(`session "${s.name}" connected${s.cwd ? ' from ' + s.cwd : ''}${s.pid ? ', pid ' + s.pid : ''}`);
      for (const w of [...waiters]) w();
      changed();
    }, () => sock.destroy()));
    sock.on('error', () => {});
    sock.on('close', () => {
      clearTimeout(hello);
      sessions.delete(s.id);
      if (!s.verified) return;
      log(`session "${s.name}" disconnected`);
      for (const [chatId, p] of [...pending]) {
        if (p.conn !== s.id) continue;
        clearPending(chatId);
        core.fail(p.job, `The live Claude Code session "${s.name}" disconnected before it answered.`);
      }
      for (const [chatId, perm] of [...permissions]) if (perm.conn === s.id) clearPermission(chatId);
      changed();
    });
  }

  function start(c) {
    core = c;
    if (server) return;
    const o = core.options('live');
    if (o.enabled === false) { log('off (plugins.live.enabled is false)'); return; }
    token = LP.writeToken(core.home);
    address = LP.endpoint(core.home, platform);
    if (platform !== 'win32') { try { fs.rmSync(address, { force: true }); } catch {} }
    server = net.createServer(onConnection);
    server.on('error', e => log(`cannot listen on ${address}: ${e.message}`));
    const umask = platform !== 'win32' ? process.umask(0o177) : null;
    server.listen(address, () => {
      if (platform !== 'win32') { try { fs.chmodSync(address, 0o600); } catch {} }
      log(`listening on ${address}`);
    });
    if (umask !== null) process.umask(umask);
  }

  function stop() {
    for (const [chatId] of [...pending]) clearPending(chatId);
    for (const [chatId] of [...permissions]) clearPermission(chatId);
    for (const s of sessions.values()) s.sock.destroy();
    sessions.clear();
    if (server) {
      server.close();
      server = null;
      if (platform !== 'win32') { try { fs.rmSync(address, { force: true }); } catch {} }
    }
  }

  function pick(chatId, target) {
    const live = connected().filter(s => matchesTarget(s, target));
    if (!live.length) return null;
    const sticky = live.find(s => s.chats && s.chats.has(chatId));
    return sticky || live.sort((a, b) => b.connectedAt - a.connectedAt)[0];
  }

  function waitForSession(ms, target) {
    return new Promise(resolve => {
      if (connected().some(s => matchesTarget(s, target))) { resolve(); return; }
      const done = () => { clearTimeout(timer); waiters.delete(done); resolve(); };
      const timer = setTimeout(done, ms);
      waiters.add(done);
    });
  }

  function noSessionText(target) {
    if (target) return `The running Claude Code session "${target}" is not connected. /claude -r lists the ones that are, and /claude -r <id> resumes a session headless when its terminal is closed.`;
    return `No live Claude Code session is connected. Start one with:\n${core.liveStartCommand}\n(see docs/LIVE-SESSION.md)`;
  }

  async function handle(job, c) {
    core = c;
    const chatId = P.chatKey(job);
    job.agent = 'claude';
    c.accept(job);
    const perm = permissions.get(chatId);
    if (perm) {
      const verdict = LP.isVerdictJob(job);
      clearPermission(chatId);
      const s = sessions.get(perm.conn);
      const sent = sendTo(s, { type: 'permission', request_id: perm.requestId, behavior: verdict.allow ? 'allow' : 'deny' });
      log(`${c.tag(job)} permission ${perm.requestId} (${perm.rule}): ${verdict.allow ? 'allowed' : 'denied'}${sent ? '' : ', but the session is gone'}`);
      if (!verdict.forward) {
        if (!sent) { c.fail(job, 'The live Claude Code session that asked is no longer connected.'); return; }
        expectReply(job, chatId, s);
        c.progress(job, `${verdict.allow ? 'Allowed' : 'Denied'} ${perm.rule}; Claude Code carries on.`);
        return;
      }
    }
    if (!server) { c.fail(job, 'The live plugin is off on this bridge (plugins.live.enabled is false).'); return; }
    const target = job.liveTarget || '';
    if (!connected().some(x => matchesTarget(x, target))) await waitForSession(opt('waitMs'), target);
    const s = pick(chatId, target);
    if (!s) {
      log(`${c.tag(job)} no live session connected${target ? ' matching "' + target + '"' : ''}`);
      c.fail(job, noSessionText(target));
      return;
    }
    const ctx = c.gameContext();
    const content = LP.channelContent(P.messagePrompt(job.text, ctx), chatId);
    const meta = LP.channelMeta(job, chatId, ctx);
    if (!sendTo(s, { type: 'message', content, meta })) {
      c.fail(job, noSessionText(target));
      return;
    }
    (s.chats = s.chats || new Set()).add(chatId);
    expectReply(job, chatId, s);
    log(`${c.tag(job)} sent to "${s.name}" as chat_id ${chatId}`);
    c.progress(job, `Sent to the live Claude Code session "${s.name}".`);
  }

  return {
    id: 'live',
    label: 'Live session',
    tools: '',
    surfaces: [],
    achievements: false,
    match: () => false,
    handle,
    start,
    stop,
    status,
    sessions: sessionsList,
    banner: () => `forwards chats to a running Claude Code session (${LP.DEV_FLAG} ${LP.CHANNEL_ARG}); see docs/LIVE-SESSION.md`,
    _state: { sessions, pending, permissions, get address() { return address; } },
  };
}

module.exports = createLive();
module.exports.createLive = createLive;
module.exports.DEFAULTS = DEFAULTS;
