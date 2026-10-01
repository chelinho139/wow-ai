'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeRoot, gameRunner } = require('./helpers');

const ROOT = makeRoot('roast');
const withGame = gameRunner(ROOT);
const FIXTURES = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'roast', 'recaps.json'), 'utf8'));

function luaValue(v) {
  return typeof v === 'string' ? JSON.stringify(v) : String(v);
}

function luaRecap(events) {
  return '{ ' + events.map(e => '{ ' + Object.entries(e).map(([k, v]) => `${k} = ${luaValue(v)}`).join(', ') + ' }').join(', ') + ' }';
}

test('a death is roasted end to end, and the sandbox bridge never tells the real stream overlay', async () => {
  await withGame({}, async h => {
    await h.client.connect();
    h.client.slash('/claude config roast on');
    const f = FIXTURES.gameRecap;
    h.client.runLua(`STUB.deathRecap = ${luaRecap(f.deathRecap)}; STUB.deathRecapMaxHealth = ${f.maxHealth}`);
    h.client.runLua('DEV.Fire("PLAYER_DEAD")');
    const roastChat = () => (h.client.db().chats || []).find(c => c.plugin === 'roast');
    await h.client.waitFor(() => { const c = roastChat(); return c && !c.pendingId && (c.history || []).some(m => m.role === 'assistant'); }, { label: 'the roast reply' });
    await h.bridge.waitForLine(/roast: overlay not told, plugins\.stream\.enabled is false/);
    assert.doesNotMatch(h.bridge.output, /roast: overlay ->|roast: overlay at /);
    assert.equal(h.sb.cfg.plugins.stream.enabled, false);
  });
});

test.after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});
