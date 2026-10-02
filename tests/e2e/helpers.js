'use strict';
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const H = require('../../dev/harness');

function makeRoot(label) {
  return path.join(os.tmpdir(), `claude-wow-e2e-${label}-${process.pid}`);
}

function gameRunner(root) {
  let seq = 0;
  return async function withGame(opts, fn) {
    const h = await H.start(`t${++seq}`, Object.assign({ root }, opts));
    try {
      await fn(h);
      assert.deepEqual(h.client.errors(), [], 'the addon raised no Lua errors');
    } catch (e) {
      const tail = `\n--- bridge output (tail) ---\n${h.bridge.output.slice(-2500)}\n--- game prints (tail) ---\n${h.client.prints().slice(-8).join('\n')}`;
      e.message += tail;
      if (typeof e.stack === 'string') e.stack += tail;
      throw e;
    } finally {
      await h.close();
    }
  };
}

function sessionCostByAgent(h) {
  const calls = h.agentCalls();
  const last = calls[calls.length - 1];
  return JSON.parse(fs.readFileSync(path.join(h.sb.agentState, `${last.session}.json`), 'utf8')).total.costUSD;
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

module.exports = { makeRoot, gameRunner, sessionCostByAgent, isAlive, H };
