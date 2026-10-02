'use strict';

const crypto = require('crypto');
const net = require('net');
const LP = require('./liveproto');
const G = require('./goals');
const OT = require('./observedtools');
const C = require('./campaign');

const SERVER_NAME = 'wowgoals';
const SCRIPT = 'goals-mcp';
const HELLO = 'run_hello';
const CALL = 'run_call';
const RESULT = 'run_result';
const TOKEN_ENV = 'CLAUDE_WOW_RUN_TOKEN';
const RUN_ID_RE = /^[0-9a-f]{32}$/;
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const CALL_TIMEOUT_MS = 15000;
const DROPPED_TEXT = 'The connection to the claude-wow bridge closed, so the goal tools are off for the rest of this run; the call did nothing.';

const ALL_TOOL_NAMES = Object.freeze([...G.TOOL_NAMES, ...OT.TOOL_NAMES, ...C.TOOL_NAMES]);
const LIVE_SESSION_ONLY = Object.freeze([G.TOOL.voteOpen, G.TOOL.voteClose]);
const TOOL_NAMES = Object.freeze(ALL_TOOL_NAMES.filter(t => !LIVE_SESSION_ONLY.includes(t)));
const fullToolName = tool => `mcp__${SERVER_NAME}__${tool}`;
const SERVER_RULE = `mcp__${SERVER_NAME}`;
const RUN_RULES = Object.freeze(TOOL_NAMES.map(fullToolName));
const DENIED_WITH_TOOLS = Object.freeze([...LIVE_SESSION_ONLY.map(fullToolName), 'Bash']);
const ASK_DENIED_TOOLS = Object.freeze(['Grep', 'Glob', 'LS', 'NotebookRead']);
const DENIED_WITHOUT_TOOLS = Object.freeze([SERVER_RULE]);

const INSTRUCTIONS = [
  'Goals, the current order, campaigns, narration and map routes for the player\'s character. The claude-wow bridge writes them for this in-game chat run only; the grant ends when the run ends.',
  'Name every zone, NPC, item or quest only with a reference token ({item:ID}, {skill:ID}, {map:ID,x,y}) whose ID comes from the wowdata tools, never from memory. The bridge expands each token to the real name and refuses unknown IDs and any game name typed as plain text; the error names the word.',
  'Twitch votes are not here: they belong to the live Claude Code session.',
].join('\n');

function toolSchemas() {
  return [...G.toolSchemas(), ...OT.toolSchemas(), ...C.toolSchemas()].filter(t => TOOL_NAMES.includes(t.name));
}

function pickProtocol(requested) {
  return PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0];
}

function version() {
  try { return require('../package.json').version; } catch { return '0.0.0'; }
}

function isRunToolRule(rule) {
  return String(rule || '').trim().startsWith(SERVER_RULE);
}

const RULE_RE = /^([^()]+)\((.*)\)$/;
const DRIVE_RE = /^([A-Za-z]):(?:\/|$)/;

function canonicalPath(raw, platform) {
  let p = String(raw || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
  const drive = DRIVE_RE.exec(p);
  if (drive) p = `${drive[1]}/${p.slice(drive[0].length)}`;
  p = p.replace(/\/{2,}/g, '/');
  return platform === 'win32' ? p.toLowerCase() : p;
}

function deniedBy(denied, rule, platform = process.platform) {
  const r = String(rule || '').trim();
  const tool = r.split('(')[0];
  const ruleArg = RULE_RE.exec(r);
  return (denied || []).some(d => {
    if (d === r || d === tool) return true;
    const m = RULE_RE.exec(String(d));
    if (!m || !ruleArg || m[1].trim() !== ruleArg[1].trim()) return false;
    const deniedPath = canonicalPath(m[2], platform);
    if (!deniedPath.endsWith('/**')) return false;
    const dir = deniedPath.slice(0, -2);
    const target = canonicalPath(ruleArg[2], platform);
    return target === dir.slice(0, -1) || `${target}/`.startsWith(dir);
  });
}

function createRunGrants({ call, character = () => '', log = () => {} } = {}) {
  const runs = new Map();

  function grant(label) {
    const id = crypto.randomBytes(16).toString('hex');
    const token = crypto.randomBytes(32).toString('hex');
    runs.set(id, { id, token, label: String(label || ''), character: String(character() || ''), used: false, conn: null });
    return { id, token };
  }

  function revoke(id) {
    const run = runs.get(id);
    if (!run) return false;
    runs.delete(id);
    if (run.conn) run.conn.destroy();
    run.conn = null;
    return true;
  }

  function revokeAll() {
    for (const id of [...runs.keys()]) revoke(id);
  }

  function hello(msg, conn) {
    const id = String((msg && msg.run) || '');
    const run = RUN_ID_RE.test(id) ? runs.get(id) : null;
    const nonce = msg && typeof msg.nonce === 'string' ? msg.nonce : '';
    if (!run || !nonce || !LP.sameProof(msg.proof, LP.proof(run.token, 'client', nonce))) return { why: 'no valid run grant' };
    if (run.used) return { why: `${run.label} already had its one connection; the run's goal tools stay off` };
    run.used = true;
    run.conn = conn || null;
    return { run, welcome: { type: 'welcome', proof: LP.proof(run.token, 'bridge', nonce) } };
  }

  function detach(run, conn) {
    if (!run || run.conn !== conn) return;
    run.conn = null;
    if (runs.get(run.id) === run) log(`${run.label} ${SERVER_NAME} connection dropped; the run's goal tools are off until it ends`);
  }

  async function onCall(run, msg) {
    const tool = String((msg && msg.tool) || '');
    const answer = (ok, text) => ({ type: RESULT, call: msg && msg.call, ok, text });
    if (runs.get(run.id) !== run) {
      log(`${run.label} ${tool} refused: the in-game run that held the grant has ended`);
      return answer(false, `${tool} was refused: the in-game run that held it has ended.`);
    }
    const now = String(character() || '');
    if (!run.character || !now || now !== run.character) {
      log(`${run.label} ${tool} refused: the run was granted for ${run.character || 'no character'}, the game now reports ${now || 'no character'}`);
      return answer(false, `${tool} was refused: this run was started for ${run.character || 'no reported character'}, and the game now reports ${now || 'no character'}.`);
    }
    if (!TOOL_NAMES.includes(tool)) {
      log(`${run.label} ${tool} refused: not given to in-game runs`);
      return answer(false, `${tool} is not given to in-game runs.`);
    }
    const args = msg.args && typeof msg.args === 'object' && !Array.isArray(msg.args) ? msg.args : {};
    let result;
    try { result = await call(tool, args); } catch (e) { result = { ok: false, text: `${tool} failed: ${e && e.message ? e.message : e}` }; }
    const ok = !!(result && result.ok);
    log(`${run.label} ${tool} from the in-game run: ${ok ? 'ok' : 'refused'}`);
    return answer(ok, String((result && result.text) || ''));
  }

  return { grant, revoke, revokeAll, hello, detach, onCall, get size() { return runs.size; } };
}

function launchConfig({ runId, token, socket, runtime } = {}) {
  const R = require('./runtime');
  const [command, args] = R.scriptCommand(SCRIPT, ['--socket', socket, '--run', runId], runtime);
  return { server: { type: 'stdio', command, args, env: { [TOKEN_ENV]: token }, alwaysLoad: true } };
}

function mcpConfig(servers) {
  const named = Object.entries(servers || {}).filter(([, s]) => s);
  return named.length ? JSON.stringify({ mcpServers: Object.fromEntries(named) }) : '';
}

function createServer(opts) {
  const out = opts.stdout;
  const socket = opts.socket || '';
  const runId = opts.runId || '';
  const token = opts.token || '';
  const platform = opts.platform || process.platform;
  const connectTo = opts.connect || (addr => net.connect(addr));
  const timeoutMs = opts.timeoutMs || CALL_TIMEOUT_MS;
  const log = opts.log || (() => {});
  const calls = new Map();
  let nextCall = 1;
  let sock = null;
  let verified = false;
  let myNonce = '';
  let dropped = false;
  const granted = () => !!socket && RUN_ID_RE.test(runId) && !!token;

  function send(msg) { out.write(JSON.stringify(msg) + '\n'); }

  function settle(id, r) {
    const c = calls.get(id);
    if (!c) return;
    calls.delete(id);
    clearTimeout(c.timer);
    c.resolve(r);
  }

  function failAll(text) {
    for (const id of [...calls.keys()]) settle(id, { ok: false, text });
  }

  function flush() {
    for (const [id, c] of calls) {
      if (c.sent) continue;
      c.sent = true;
      sock.write(LP.encode({ type: CALL, call: id, tool: c.tool, args: c.args }));
    }
  }

  function onBridge(msg) {
    if (!verified) {
      if (msg.type === 'welcome' && LP.sameProof(msg.proof, LP.proof(token, 'bridge', myNonce))) {
        verified = true;
        flush();
        return;
      }
      log(msg.type === 'reject' ? `the bridge refused this run: ${msg.reason || 'no reason given'}` : 'ignored a frame from an unverified peer');
      if (sock) sock.destroy();
      return;
    }
    if (msg.type === RESULT && calls.has(msg.call)) settle(msg.call, { ok: !!msg.ok, text: String(msg.text || '') });
  }

  function open() {
    if (sock) return true;
    if (dropped || !granted()) return false;
    if (platform !== 'win32' && !opts.skipPermissionCheck && !LP.socketOwnerOnly(socket)) return false;
    const s = connectTo(socket);
    sock = s;
    verified = false;
    myNonce = LP.nonce();
    s.on('connect', () => s.write(LP.encode({ type: HELLO, run: runId, nonce: myNonce, proof: LP.proof(token, 'client', myNonce) })));
    s.on('data', LP.lineReader(onBridge, () => s.destroy()));
    s.on('error', () => {});
    s.on('close', () => {
      if (sock === s) sock = null;
      verified = false;
      dropped = true;
      failAll(DROPPED_TEXT);
    });
    return true;
  }

  function connect() {
    if (!granted()) return false;
    if (open()) return true;
    dropped = true;
    log('cannot reach the claude-wow bridge socket (missing or not private); the goal tools are off for this run');
    return false;
  }

  function askBridge(tool, args) {
    if (!granted()) return Promise.resolve({ ok: false, text: `${SERVER_NAME} was started without a run grant from the bridge, so ${tool} did nothing.` });
    if (dropped) return Promise.resolve({ ok: false, text: DROPPED_TEXT });
    const id = nextCall++;
    return new Promise(resolve => {
      const timer = setTimeout(() => settle(id, { ok: false, text: `The claude-wow bridge did not answer ${tool} in time.` }), timeoutMs);
      if (timer.unref) timer.unref();
      calls.set(id, { resolve, timer, tool, args, sent: false });
      if (!open()) { settle(id, { ok: false, text: `The claude-wow bridge socket is missing or not private, so ${tool} did nothing.` }); return; }
      if (verified) flush();
    });
  }

  async function onRequest(msg) {
    const { method, params } = msg;
    if (method === 'initialize') {
      return { protocolVersion: pickProtocol(params && params.protocolVersion), capabilities: { tools: {} }, serverInfo: { name: SERVER_NAME, version: version() }, instructions: INSTRUCTIONS };
    }
    if (method === 'ping') return {};
    if (method === 'tools/list') return { tools: toolSchemas() };
    if (method === 'tools/call') {
      const tool = params && params.name;
      if (!TOOL_NAMES.includes(tool)) return { content: [{ type: 'text', text: `Unknown tool: ${String(tool).slice(0, 60)}` }], isError: true };
      const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments : {};
      const r = await askBridge(tool, args);
      return { content: [{ type: 'text', text: r.text || (r.ok ? 'done' : 'refused') }], isError: !r.ok };
    }
    const err = new Error(`Method not found: ${method}`);
    err.code = -32601;
    throw err;
  }

  function handle(msg) {
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return;
    if (msg.id === undefined || msg.id === null) return;
    onRequest(msg).then(
      result => send({ jsonrpc: '2.0', id: msg.id, result }),
      err => send({ jsonrpc: '2.0', id: msg.id, error: { code: err.code || -32603, message: err.message } }),
    );
  }

  function stop() {
    failAll('The wowgoals server is shutting down.');
    if (sock) sock.destroy();
  }

  return { handle, feed: LP.lineReader(handle), stop, connect };
}

function parseArgs(argv) {
  const opts = { socket: '', runId: '' };
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k];
    if (a === '--socket') opts.socket = argv[++k] || '';
    else if (a === '--run') opts.runId = argv[++k] || '';
    else throw new Error(`unknown option ${JSON.stringify(a)}`);
  }
  return opts;
}

function main(argv, deps = {}) {
  const stdin = deps.stdin || process.stdin;
  const stdout = deps.stdout || process.stdout;
  const env = deps.env || process.env;
  const log = deps.log || (line => process.stderr.write(`[claude-wow goals-mcp] ${line}\n`));
  let opts;
  try { opts = parseArgs(argv); } catch (e) { log(e.message); process.exitCode = 2; return null; }
  const token = String(env[TOKEN_ENV] || '');
  const server = createServer({ stdout, socket: opts.socket, runId: opts.runId, token, log });
  server.connect();
  stdin.on('data', server.feed);
  stdin.on('end', () => { server.stop(); if (!deps.stdin) process.exit(0); });
  return server;
}

module.exports = {
  SERVER_NAME, SCRIPT, HELLO, CALL, RESULT, TOKEN_ENV, INSTRUCTIONS,
  TOOL_NAMES, LIVE_SESSION_ONLY, RUN_RULES, SERVER_RULE, DENIED_WITH_TOOLS, DENIED_WITHOUT_TOOLS, ASK_DENIED_TOOLS,
  fullToolName, isRunToolRule, deniedBy, toolSchemas, createRunGrants, launchConfig, mcpConfig, createServer, parseArgs, main,
};

if (require.main === module) main(process.argv.slice(2));
