'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const SB = require('./sandbox');
const { WowClient } = require('./wow/client');

const BRIDGE = path.join(SB.REPO, 'bridge', 'bridge.js');
const SUPERVISOR = path.join(SB.REPO, 'bridge', 'supervisor.js');

class BridgeProcess {
  constructor(sb, { supervised = false, echo = false } = {}) {
    this.sb = sb;
    this.supervised = supervised;
    this.echo = echo;
    this.child = null;
    this.output = '';
    this.exits = [];
    this.outFile = path.join(sb.logs, 'bridge.out');
  }

  start() {
    if (this.child) return this;
    const script = this.supervised ? SUPERVISOR : BRIDGE;
    const env = Object.assign({}, this.sb.env);
    delete env.CLAUDE_WOW_SERVICE;
    const child = spawn(process.execPath, [script], { cwd: SB.REPO, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    const out = fs.createWriteStream(this.outFile, { flags: 'a' });
    const take = chunk => {
      const s = chunk.toString('utf8');
      this.output += s;
      out.write(s);
      if (this.echo) process.stdout.write(s.replace(/^/gm, '  bridge| '));
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('exit', (code, signal) => {
      this.exits.push({ at: Date.now(), code, signal });
      if (this.child === child) this.child = null;
      out.end();
    });
    this.child = child;
    this.startedAt = Date.now();
    this.mark = this.output.length;
    return this;
  }

  get pid() {
    return this.child ? this.child.pid : null;
  }

  since(mark = this.mark) {
    return this.output.slice(mark);
  }

  async waitForLine(re, { timeoutMs = 20000, from = this.mark } = {}) {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const m = re.exec(this.output.slice(from));
      if (m) return m;
      if (Date.now() > until) throw new Error(`bridge never logged ${re} within ${timeoutMs} ms; last output:\n${this.output.slice(-2000)}`);
      if (!this.child && !this.supervised) throw new Error(`bridge exited (${JSON.stringify(this.exits.at(-1))}) before logging ${re}; output:\n${this.output.slice(-2000)}`);
      await new Promise(r => setTimeout(r, 50));
    }
  }

  async ready(timeoutMs = 20000) {
    await this.waitForLine(/screenshot transport: watching|pixel capture/, { timeoutMs });
    return this;
  }

  signalGroup(sig) {
    if (!this.child) return false;
    try {
      if (process.platform !== 'win32') process.kill(-this.child.pid, sig); else this.child.kill(sig);
      return true;
    } catch { return false; }
  }

  async stop({ signal = 'SIGTERM', timeoutMs = 8000 } = {}) {
    const child = this.child;
    if (!child) return;
    const done = new Promise(r => child.once('exit', r));
    this.signalGroup(signal);
    const t = setTimeout(() => this.signalGroup('SIGKILL'), timeoutMs);
    await done;
    clearTimeout(t);
  }

  async crash() {
    await this.stop({ signal: 'SIGKILL', timeoutMs: 1000 });
  }

  async restart() {
    await this.stop();
    this.start();
    await this.ready();
  }
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function agentCalls(sb) {
  try {
    return fs.readFileSync(path.join(sb.agentState, 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch { return []; }
}

async function start(name, opts = {}) {
  const sb = opts.open ? SB.open(name, opts) : SB.create(name, opts);
  const bridge = new BridgeProcess(sb, opts);
  const client = new WowClient(sb, opts.client || {});
  const discard = async () => {
    client.stop();
    await bridge.stop();
    if (!opts.keep && !opts.open) fs.rmSync(SB.assertSafe(sb.dir), { recursive: true, force: true });
  };
  try {
    if (opts.beforeLaunch) await opts.beforeLaunch(sb);
    if (opts.bridge !== false) {
      bridge.start();
      await bridge.ready(opts.readyTimeoutMs);
    }
    client.launch();
    if (opts.run !== false) client.start();
  } catch (e) {
    await discard().catch(() => {});
    throw e;
  }
  const h = {
    sb, bridge, client,
    state: () => readJson(sb.state, {}),
    transcripts: () => readJson(sb.transcripts, {}),
    agentCalls: () => agentCalls(sb),
    screenshots: () => fs.readdirSync(sb.screenshots),
    async close({ keep = !!process.env.CLAUDE_WOW_KEEP_SANDBOX } = {}) {
      client.stop();
      await bridge.stop();
      if (!keep && !opts.keep) fs.rmSync(SB.assertSafe(sb.dir), { recursive: true, force: true });
    },
  };
  return h;
}

module.exports = { start, BridgeProcess, agentCalls, readJson };
