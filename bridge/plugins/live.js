'use strict';

const fs = require('fs');
const net = require('net');
const LP = require('../liveproto');
const P = require('../protocol');
const SS = require('../sessions');
const GM = require('../goalsmcp');

const DEFAULTS = { waitMs: 3000, permissionTimeoutMs: 120000, helloTimeoutMs: 5000, pickupMs: 45000, pickupPollMs: 5000 };
const CLAUDE_INFO_TTL_MS = 5000;
const DETECT_WAIT_MS = 25000;
const ANCESTRY_DEPTH_MAX = 64;

function pickupMarkers(chatId, messageId) {
  const plain = `chat_id="${chatId}" message_id="${messageId}"`;
  return [plain, plain.replace(/"/g, '\\"')];
}

function createLive(overrides = {}) {
  const sessions = new Map();
  const pending = new Map();
  const permissions = new Map();
  const waiters = new Set();
  const runSockets = new Set();
  let server = null;
  let address = '';
  let token = '';
  let core = null;
  let nextConn = 1;
  let platform = overrides.platform || process.platform;
  const commandLineOf = overrides.commandLine || (pid => LP.commandLine(pid, { platform }));
  const parentOf = overrides.parentOf || (pid => LP.parentPid(pid, { platform }));

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
  const claudeDir = () => overrides.claudeDir || (core && core.claudeDir) || '';
  const homeArg = () => (core && core.liveHome) || '';

  function connected() {
    return [...sessions.values()].filter(s => s.verified);
  }

  function listening() {
    return connected().filter(s => s.listening);
  }

  function describe(s) {
    return `${s.name}${s.cwd ? ' (' + s.cwd + ')' : ''}`;
  }

  function claudeInfo(s) {
    const dir = claudeDir();
    if (!dir || (!s.ppid && !s.sessionId)) return null;
    if (!s.info || Date.now() - s.info.at > CLAUDE_INFO_TTL_MS) {
      const running = s.ppid ? SS.runningClaude(dir, s.ppid) : null;
      const id = (running && running.id) || s.sessionId || '';
      const cwd = s.cwd || (running && running.cwd) || '';
      let label = '';
      try { label = id ? SS.sessionLabel(dir, id, cwd) : ''; } catch {}
      s.info = { at: Date.now(), value: { id, name: (running && running.name) || '', cwd: (running && running.cwd) || '', label } };
    }
    return s.info.value;
  }

  function sessionOf(s) {
    const info = claudeInfo(s);
    const id = (info && info.id) || s.sessionId || '';
    const cwd = s.cwd || (info && info.cwd) || '';
    return {
      id,
      name: s.name,
      title: (info && (info.label || info.name)) || '',
      pidName: (info && info.name) || '',
      cwd,
      agent: 'claude',
      at: Math.floor(s.connectedAt / 1000),
      listening: !!s.listening,
      restart: LP.restartCommand({ cwd, id }, homeArg()),
    };
  }

  function newestFirst(list) {
    return list.sort((a, b) => b.connectedAt - a.connectedAt);
  }

  function status() {
    return listening().sort((a, b) => a.connectedAt - b.connectedAt).map(describe);
  }

  function sessionsList() {
    const seen = new Set();
    const out = [];
    for (const s of newestFirst(connected().filter(x => !x.detecting && !x.print))) {
      const info = sessionOf(s);
      const key = info.id || `${info.name}\n${info.cwd}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const { pidName, ...entry } = info;
      out.push(entry);
    }
    return out.sort((a, b) => Number(b.listening) - Number(a.listening) || b.at - a.at);
  }

  function matchesTarget(s, target) {
    const want = String(target || '').trim().toLowerCase();
    if (!want) return true;
    const info = sessionOf(s);
    const id = info.id.toLowerCase();
    const names = [info.name, info.title, info.pidName].filter(Boolean).map(n => n.toLowerCase());
    return (id && (id === want || (want.length >= SS.MIN_PREFIX && id.startsWith(want)))) || names.includes(want);
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
    if (p.watch) clearTimeout(p.watch);
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

  function transcriptOf(s) {
    const dir = claudeDir();
    const info = claudeInfo(s);
    if (!dir || !info || !info.id) return '';
    if (s.transcript && s.transcript.id === info.id && s.transcript.file) return s.transcript.file;
    const file = SS.sessionFileFor(dir, info.id, info.cwd || s.cwd);
    s.transcript = { id: info.id, file };
    return file;
  }

  function pickedUpByTranscript(s, job, chatId, sentAt) {
    const file = transcriptOf(s);
    if (!file) return false;
    try { if (fs.statSync(file).mtimeMs < sentAt - 1000) return false; } catch { return false; }
    const tail = SS.readTail(file);
    return pickupMarkers(chatId, job.id).some(m => tail.includes(m));
  }

  const pickedUp = overrides.pickedUp || pickedUpByTranscript;

  function stalledText(s) {
    return `The session "${s.name}" did not pick it up — it may be busy or not listening. A late reply still lands here.`;
  }

  function watchPickup(job, chatId, s) {
    const p = pending.get(chatId);
    if (!p || p.job !== job) return;
    const pickupMs = opt('pickupMs');
    if (!pickupMs) return;
    const pollMs = Math.max(1, Math.min(opt('pickupPollMs') || pickupMs, pickupMs));
    let elapsed = 0;
    const step = () => {
      const wait = Math.min(pollMs, pickupMs - elapsed);
      p.watch = setTimeout(() => { elapsed += wait; check(); }, wait);
      if (p.watch.unref) p.watch.unref();
    };
    const check = () => {
      p.watch = null;
      if (pending.get(chatId) !== p || p.late) return;
      let seen = false;
      try { seen = pickedUp(s, job, chatId, p.sentAt); } catch {}
      if (seen) {
        p.active = true;
        log(`${core.tag(job)} "${s.name}" picked it up`);
        core.progress(job, `The live Claude Code session "${s.name}" picked it up and is working on it.`);
        return;
      }
      if (elapsed >= pickupMs) {
        p.late = true;
        job.lateOk = true;
        log(`${core.tag(job)} "${s.name}" showed no sign of it within ${pickupMs} ms; failed, a late reply still lands`);
        core.fail(job, stalledText(s));
        return;
      }
      step();
    };
    step();
  }

  function expectReply(job, chatId, s, watch) {
    const prev = clearPending(chatId);
    if (prev && prev.job !== job && !prev.late) core.fail(prev.job, 'A newer message in this chat replaced this one before the live session answered.');
    const ms = replyTimeoutMs();
    const timer = setTimeout(() => {
      const p = pending.get(chatId);
      if (!p || p.job !== job) return;
      clearPending(chatId);
      if (p.late) return;
      log(`${core.tag(job)} no reply from "${s.name}" within ${ms} ms`);
      core.fail(job, `The live Claude Code session "${s.name}" did not answer within ${Math.round(ms / 60000) || 1} min.`);
    }, ms);
    if (timer.unref) timer.unref();
    pending.set(chatId, { job, conn: s.id, sentAt: Date.now(), timer, watch: null, late: false });
    if (watch) watchPickup(job, chatId, s);
  }

  function deliverLate(job, text) {
    if (core && typeof core.late === 'function') core.late(job, text);
    else if (core) core.reply(job, text);
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
    log(`${core.tag(p.job)} ${p.late ? 'late ' : ''}reply from "${s.name}" (${text.length} chars)`);
    if (p.late) deliverLate(p.job, text);
    else core.reply(p.job, text);
    answer(true)('Delivered to the player\'s in-game whisper tab.');
  }

  function onPermissionRequest(s, msg) {
    const requestId = String(msg.request_id || '');
    if (!LP.PERMISSION_ID_RE.test(requestId)) return;
    let target = null;
    for (const [chatId, p] of pending) {
      if (p.conn === s.id && !p.late && (!target || p.sentAt > target.p.sentAt)) target = { chatId, p };
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

  function agentRunPids() {
    const pids = core && typeof core.agentPids === 'function' ? core.agentPids() : [];
    return new Set((Array.isArray(pids) ? pids : []).map(Number).filter(n => Number.isInteger(n) && n > 0));
  }

  async function checkGoalCaller(s) {
    if (!s.pid || !s.ppid) return 'the channel server did not name its process and its Claude Code process';
    const parent = await parentOf(s.pid);
    if (parent !== s.ppid) return `pid ${s.pid} is not a child of Claude Code pid ${s.ppid}`;
    const runs = agentRunPids();
    let pid = s.pid;
    for (let depth = 0; pid > 1 && depth < ANCESTRY_DEPTH_MAX; depth++) {
      if (runs.has(pid)) return `pid ${s.pid} runs under agent run pid ${pid}, which the bridge started from the game`;
      pid = depth === 0 ? s.ppid : await parentOf(pid);
      if (!pid) break;
    }
    return '';
  }

  async function goalCallerRefusal(s) {
    if (s.goalCallerTrusted) return '';
    const why = await checkGoalCaller(s);
    s.goalCallerTrusted = !why;
    return why;
  }

  async function onGoalCall(s, msg) {
    const answer = r => sendTo(s, { type: 'goal_result', call: msg.call, ok: !!(r && r.ok), text: String((r && r.text) || '') });
    if (!core || typeof core.goals !== 'function') { answer({ ok: false, text: 'This bridge has no goal store.' }); return; }
    const tool = String(msg.tool || '');
    if (!s.listening) {
      log(`${tool} from "${s.name}" refused: the session is not listening on the channel`);
      answer({ ok: false, text: `${tool} only works in a session started with ${LP.DEV_FLAG} ${LP.CHANNEL_ARG}, never in a -p run.` });
      return;
    }
    const why = await goalCallerRefusal(s);
    if (why) {
      log(`${tool} from "${s.name}" refused: ${why}`);
      answer({ ok: false, text: `${tool} was refused: ${why}.` });
      return;
    }
    let result;
    try { result = await core.goals(tool, msg.args); } catch (e) { result = { ok: false, text: `${tool} failed: ${e && e.message ? e.message : e}` }; }
    log(`${tool} from "${s.name}": ${result && result.ok ? 'ok' : 'refused'}`);
    answer(result);
  }

  function onVerified(s, msg) {
    if (msg.type === 'reply') onReply(s, msg);
    else if (msg.type === 'permission_request') onPermissionRequest(s, msg);
    else if (msg.type === 'goal_call') onGoalCall(s, msg);
  }

  async function acceptRun(s, msg) {
    const grants = core && core.runGrants;
    sessions.delete(s.id);
    s.runPending = true;
    let accepted = { why: 'this bridge gives no run grants' };
    try { if (grants) accepted = await grants.hello(msg, s.sock); } catch (e) { accepted = { why: e && e.message ? e.message : String(e) }; }
    s.runPending = false;
    if (!accepted.run || s.sock.destroyed) {
      if (accepted.run) grants.detach(accepted.run, s.sock);
      s.sock.write(LP.encode({ type: 'reject', reason: 'bad run hello' }));
      s.sock.destroy();
      log(`refused an in-game run connection without a valid run grant (${accepted.why || 'closed during the hello'})`);
      return;
    }
    s.run = accepted.run;
    runSockets.add(s.sock);
    s.sock.write(LP.encode(accepted.welcome));
  }

  async function onRunMessage(s, msg) {
    if (msg.type !== GM.CALL) return;
    const answer = await core.runGrants.onCall(s.run, msg);
    if (!s.sock.destroyed) s.sock.write(LP.encode(answer));
  }

  function runEndpoint() {
    return server && server.listening ? address : '';
  }

  async function detectListening(s) {
    if (!s.ppid) return { listening: false, why: 'the channel server did not name its Claude Code process' };
    let line = null;
    try { line = await commandLineOf(s.ppid); } catch {}
    if (!line) return { listening: false, why: `cannot read the command line of Claude Code pid ${s.ppid}` };
    if (LP.isPrintMode(line)) return { listening: false, print: true, why: `Claude Code pid ${s.ppid} runs one prompt with -p/--print` };
    if (LP.sessionListens(line)) return { listening: true, why: '' };
    return { listening: false, why: `Claude Code pid ${s.ppid} was started without ${LP.DEV_FLAG} ${LP.CHANNEL_ARG}` };
  }

  function wake() {
    for (const w of [...waiters]) w();
  }

  function onConnection(sock) {
    const s = { id: nextConn++, sock, verified: false, name: '', cwd: '', pid: 0, connectedAt: Date.now(), listening: false, sessionId: '' };
    sessions.set(s.id, s);
    const hello = setTimeout(() => { if (!s.verified) sock.destroy(); }, opt('helloTimeoutMs'));
    if (hello.unref) hello.unref();
    sock.on('data', LP.lineReader(msg => {
      if (s.runPending) return;
      if (s.run) { onRunMessage(s, msg); return; }
      if (s.verified) { onVerified(s, msg); return; }
      clearTimeout(hello);
      if (msg.type === GM.HELLO) { acceptRun(s, msg); return; }
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
      s.sessionId = SS.SESSION_ID_RE.test(String(msg.session || '')) ? String(msg.session) : '';
      s.detecting = true;
      sock.write(LP.encode({ type: 'welcome', proof: LP.proof(token, 'bridge', msg.nonce) }));
      detectListening(s).then(heard => {
        s.detecting = false;
        if (sessions.get(s.id) !== s) return;
        s.listening = heard.listening;
        s.print = !!heard.print;
        log(`session "${s.name}" connected${s.cwd ? ' from ' + s.cwd : ''}${s.pid ? ', pid ' + s.pid : ''}, ${s.listening ? 'listening' : 'not listening (' + heard.why + ')'}`);
        wake();
        changed();
      });
    }, () => sock.destroy()));
    sock.on('error', () => {});
    sock.on('close', () => {
      clearTimeout(hello);
      sessions.delete(s.id);
      if (s.run) {
        runSockets.delete(sock);
        if (core && core.runGrants) core.runGrants.detach(s.run, sock);
        return;
      }
      if (!s.verified) return;
      log(`session "${s.name}" disconnected`);
      for (const [chatId, p] of [...pending]) {
        if (p.conn !== s.id) continue;
        clearPending(chatId);
        if (!p.late) core.fail(p.job, `The live Claude Code session "${s.name}" disconnected before it answered.`);
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
    for (const sock of [...runSockets]) sock.destroy();
    runSockets.clear();
    if (server) {
      server.close();
      server = null;
      if (platform !== 'win32') { try { fs.rmSync(address, { force: true }); } catch {} }
    }
  }

  function pick(chatId, target) {
    const live = listening().filter(s => matchesTarget(s, target));
    if (!live.length) return null;
    const sticky = live.find(s => s.chats && s.chats.has(chatId));
    return sticky || newestFirst(live)[0];
  }

  function deaf() {
    return connected().filter(s => !s.listening && !s.detecting && !s.print);
  }

  function deafMatch(target) {
    return newestFirst(deaf().filter(s => matchesTarget(s, target)))[0] || null;
  }

  function waitForSession(ms, target) {
    return new Promise(resolve => {
      const ready = () => listening().some(s => matchesTarget(s, target));
      const detecting = () => connected().some(s => s.detecting && matchesTarget(s, target));
      if (ready()) { resolve(); return; }
      let expired = false;
      let timer = null;
      let cap = null;
      const done = () => { clearTimeout(timer); clearTimeout(cap); waiters.delete(check); resolve(); };
      const check = () => { if (ready() || (expired && !detecting())) done(); };
      timer = setTimeout(() => { expired = true; check(); }, ms);
      cap = setTimeout(done, ms + DETECT_WAIT_MS);
      waiters.add(check);
    });
  }

  function notListeningText(s) {
    const info = sessionOf(s);
    const label = info.title || info.name;
    const lines = [
      `The Claude Code session "${label}" is running, but it was not started with the claude-wow channel, so it cannot hear the game.`,
      'Restart it in its terminal with:',
      info.restart,
    ];
    if (info.id) lines.push('Or pick it in /claude -r and click resume headless to continue it here without the terminal.');
    return lines.join('\n');
  }

  function noSessionText(target) {
    if (target) return `The running Claude Code session "${target}" is not connected. /claude -r lists the ones that are, and /claude -r <id> resumes a session headless when its terminal is closed.`;
    const n = deaf().length;
    const note = n ? `\n${n} running session${n === 1 ? ' was' : 's were'} started without the channel; /claude -r shows how to restart ${n === 1 ? 'it' : 'them'}.` : '';
    return `No live Claude Code session is connected. Start one with:\n${core.liveStartCommand}\n(see docs/LIVE-SESSION.md)${note}`;
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
        expectReply(job, chatId, s, false);
        c.progress(job, `${verdict.allow ? 'Allowed' : 'Denied'} ${perm.rule}; Claude Code carries on.`);
        return;
      }
    }
    if (!server) { c.fail(job, 'The live plugin is off on this bridge (plugins.live.enabled is false).'); return; }
    const target = job.liveTarget || '';
    if (!listening().some(x => matchesTarget(x, target)) && !(target && deafMatch(target))) await waitForSession(opt('waitMs'), target);
    const s = pick(chatId, target);
    if (!s) {
      const deaf = target ? deafMatch(target) : null;
      if (deaf) {
        log(`${c.tag(job)} "${deaf.name}" matches "${target}" but is not listening`);
        c.fail(job, notListeningText(deaf));
        return;
      }
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
    expectReply(job, chatId, s, true);
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
    runEndpoint,
    banner: () => `forwards chats to a running Claude Code session (${LP.DEV_FLAG} ${LP.CHANNEL_ARG}); see docs/LIVE-SESSION.md`,
    _state: { sessions, pending, permissions, runSockets, get address() { return address; } },
  };
}

module.exports = createLive();
module.exports.createLive = createLive;
module.exports.DEFAULTS = DEFAULTS;
module.exports.pickupMarkers = pickupMarkers;
