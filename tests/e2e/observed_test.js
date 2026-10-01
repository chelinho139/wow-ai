'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { makeRoot, gameRunner } = require('./helpers');
const SB = require('../../dev/sandbox');
const D = require('../../bridge/datasync');
const OB = require('../../bridge/observed');
const TL = require('../../bridge/telemetry');
const OT = require('../../bridge/observedtools');

const ROOT = makeRoot('observed');
const withGame = gameRunner(ROOT);
const CHARACTER = 'Testchar-TestRealm';
const FIXTURES = path.join(__dirname, '..', 'fixtures', 'wago');
const BUILD = '1.60.1.200';
const CHANNEL = path.join(__dirname, '..', '..', 'bridge', 'channel.js');
const SESSION_NAME = 'observed-e2e';

function fixtureFetch(url) {
  const u = new URL(url);
  const table = /^\/db2\/(\w+)\/csv$/.exec(u.pathname)[1];
  const headers = { 'content-type': 'text/csv', 'content-disposition': `attachment; filename="${table}.${u.searchParams.get('build')}.csv"` };
  return Promise.resolve(new Response(fs.readFileSync(path.join(FIXTURES, `${table}.csv`), 'utf8'), { status: 200, headers }));
}

const LOOT_STUB = `
local unpack = unpack or table.unpack
DEV_LOOT = { { kind = 1, link = "|cffffffff|Hitem:501::::::::20:::::|h[x]|h|r", qty = 2, sources = { "Creature-0-4372-0-17-3100-00000ABCDE", 2 } } }
function GetNumLootItems() return #DEV_LOOT end
function GetLootSlotType(i) return DEV_LOOT[i].kind end
function GetLootSlotLink(i) return DEV_LOOT[i].link end
function GetLootSlotInfo(i) return nil, nil, DEV_LOOT[i].qty end
function GetLootSourceInfo(i) return unpack(DEV_LOOT[i].sources) end
function IsFishingLoot() return false end
`;

function readObserved(sb) {
  try { return fs.readFileSync(path.join(sb.home, 'goals', CHARACTER, OB.OBSERVED_FILE), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; }
}

async function untilNoSlotLoads(h, quietMs = 12000, maxMs = 90000) {
  const start = Date.now();
  let seen = h.client.luaValue('DEV_SLOT_LOADS');
  let since = Date.now();
  while (Date.now() - since < quietMs) {
    assert.ok(Date.now() - start < maxMs, 'the client settles into no slot loads');
    await new Promise(r => setTimeout(r, 500));
    const now = h.client.luaValue('DEV_SLOT_LOADS');
    if (now !== seen) { seen = now; since = Date.now(); }
  }
}

function fakeSession(sb) {
  const script = path.join(sb.dir, 'fake-session.js');
  fs.writeFileSync(SB.assertSafe(script), [
    "'use strict';",
    "const { spawn } = require('child_process');",
    `const child = spawn(process.execPath, [${JSON.stringify(CHANNEL)}], { env: process.env, stdio: ['pipe', 'pipe', 'inherit'] });`,
    'process.stdin.pipe(child.stdin);',
    'child.stdout.pipe(process.stdout);',
    'child.on(\'exit\', code => process.exit(code || 0));',
  ].join('\n'));
  const proc = spawn(process.execPath, [script, '--dangerously-load-development-channels', 'server:claude-wow'], {
    env: { ...sb.env, CLAUDE_WOW_LIVE_NAME: SESSION_NAME },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const replies = new Map();
  let buf = '';
  proc.stdout.on('data', chunk => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      try { const msg = JSON.parse(line); if (msg.id !== undefined) replies.set(msg.id, msg); } catch {}
    }
  });
  const send = msg => proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  return { proc, replies, send };
}

test('the real addon reads a loot window the player opened, sends it as a gs section, and the bridge files it in observed.jsonl', async () => {
  await withGame({ client: { speed: 8 }, speed: 8 }, async h => {
    await h.client.say('hello');
    const snapFile = path.join(h.sb.home, 'goals', CHARACTER, TL.SNAPSHOT_FILE);
    await h.client.waitFor(() => { try { return JSON.parse(fs.readFileSync(snapFile, 'utf8')).sections.cap; } catch { return null; } }, { timeoutMs: 60000, label: 'the first gs record' });
    await h.client.waitFor(() => h.client.luaValue('ClaudeWoWTelemetry.Observing()') === 'true', { timeoutMs: 30000, label: 'the bridge to offer observed sections' });
    h.client.runLua(LOOT_STUB);
    h.client.runLua('STUB.FireEvent("LOOT_READY"); STUB.FireEvent("LOOT_CLOSED")');
    const lines = await h.client.waitFor(() => { const l = readObserved(h.sb); return l.length ? l : null; }, { timeoutMs: 60000, label: 'the loot sample in observed.jsonl' });
    assert.equal(lines.length, 1);
    assert.deepEqual([lines[0].kind, lines[0].trust, lines[0].n, lines[0].source, lines[0].items], ['loot', 'observed', 1, { type: 'npc', id: 3100, spell: 0 }, { 501: 2 }]);
    assert.equal(h.agentCalls().length, 1, 'no gs record reached an agent');
  });
});

test('route_draw from a listening session reaches the game map on the next slot the game loads anyway, with no slot of its own', { skip: process.platform === 'win32' }, async () => {
  const beforeLaunch = async sb => { await D.sync({ dataDir: path.join(sb.home, 'data'), build: BUILD, fetch: fixtureFetch }); };
  await withGame({ beforeLaunch }, async h => {
    h.client.runLua('ClaudeWoWDB.stream = ClaudeWoWDB.stream or {}; ClaudeWoWDB.stream.follow = false');
    await h.client.say('hello');
    await h.bridge.waitForLine(/game context updated: Character: Testchar/);
    const session = fakeSession(h.sb);
    try {
      session.send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } } });
      session.send({ method: 'notifications/initialized' });
      session.send({ id: 2, method: 'tools/list' });
      await h.bridge.waitForLine(new RegExp(`session "${SESSION_NAME}" connected.*, listening`), { timeoutMs: 30000 });
      const listed = await h.client.waitFor(() => session.replies.get(2), { timeoutMs: 10000, label: 'tools/list' });
      assert.ok(listed.result.tools.some(t => t.name === OT.TOOL.route));
      h.client.runLua('DEV_SLOT_LOADS = 0; local load = C_AddOns.LoadAddOn; C_AddOns.LoadAddOn = function(name) if tostring(name):match("^ClaudeWoW_S") then DEV_SLOT_LOADS = DEV_SLOT_LOADS + 1 end return load(name) end');
      await untilNoSlotLoads(h);
      h.client.runLua('DEV_SLOT_LOADS = 0');
      session.send({ id: 3, method: 'tools/call', params: { name: OT.TOOL.route, arguments: { points: ['{map:9002,40,50}', '{map:9003,10,20}'] } } });
      const drawn = await h.client.waitFor(() => session.replies.get(3), { timeoutMs: 15000, label: 'route_draw' });
      assert.equal(drawn.result.isError, false, drawn.result.content[0].text);
      assert.equal(h.state().mapHeldForGame, true, 'the bridge holds the route for the game');
      const inbox = fs.readFileSync(path.join(h.sb.addons, 'ClaudeWoW_S001', 'Inbox.lua'), 'utf8');
      assert.match(inbox, /name = "claude-route", title = "Fixture Vale route, model estimate"/);
      assert.match(inbox, /\{ 9002, 40, 50, "Stop 1 of 2, model estimate", "poi" \}/);
      await new Promise(r => setTimeout(r, 4000));
      assert.equal(h.client.luaValue('DEV_SLOT_LOADS'), '0', 'no slot was loaded for the route');
      assert.equal(h.client.luaValue('ClaudeWoWMapDB.map and #ClaudeWoWMapDB.map.layers or 0'), '0', 'the route is not in the game yet');
      await h.client.say('show me the way');
      await h.client.waitFor(() => h.client.luaValue('ClaudeWoWMapDB.map and ClaudeWoWMapDB.map.layers[1] and ClaudeWoWMapDB.map.layers[1].name') === 'claude-route', { timeoutMs: 30000, label: 'the route in the game map' });
      assert.equal(h.client.luaValue('#ClaudeWoWMapDB.map.layers[1].points'), '2');
      assert.equal(h.state().mapHeldForGame, false, 'the published reply releases the hold');
      assert.equal(h.agentCalls().length, 2, 'route_draw ran no agent');
    } finally {
      session.proc.kill();
    }
  });
});

test.after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});
