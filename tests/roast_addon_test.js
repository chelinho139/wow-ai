'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const fengari = require('fengari');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari;
const P = require('../bridge/protocol');

const ADDON = path.join(__dirname, '..', 'addon', 'ClaudeWoW');
const CELLS_PER_ROW = 200;
const PLAYER_GUID = 'Player-1-0001';
const HOGGER_GUID = 'Creature-0-1-0-0-448-0001';

const COMBAT_LOG_STUB = `
STUB.guids = { player = "${PLAYER_GUID}" }
function UnitGUID(unit) return STUB.guids[unit] end
STUB.levels = {}
function UnitLevel(unit) if STUB.levels[unit] ~= nil then return STUB.levels[unit] end return STUB.level end
STUB.combatLog = { n = 0 }
function CombatLogGetCurrentEventInfo() return table.unpack(STUB.combatLog, 1, STUB.combatLog.n) end
function STUB.CombatLog(...)
  STUB.combatLog = table.pack(...)
  STUB.FireEvent("COMBAT_LOG_EVENT_UNFILTERED")
end
`;

function newVM() {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const run = (code, arg) => {
    if (lauxlib.luaL_loadstring(L, to_luastring(code)) !== lua.LUA_OK) throw new Error('Lua load: ' + to_jsstring(lua.lua_tostring(L, -1)));
    let nargs = 0;
    if (arg !== undefined) { lua.lua_pushstring(L, to_luastring(arg)); nargs = 1; }
    if (lua.lua_pcall(L, nargs, 0, 0) !== lua.LUA_OK) throw new Error('Lua error: ' + to_jsstring(lua.lua_tostring(L, -1)));
  };
  const evaluate = (expr) => {
    run(`local v = (${expr}); if v == nil then RESULT = nil else RESULT = tostring(v) end`);
    lua.lua_getglobal(L, to_luastring('RESULT'));
    const isNil = lua.lua_isnil(L, -1);
    const s = isNil ? null : to_jsstring(lua.lua_tolstring(L, -1));
    lua.lua_pop(L, 1);
    return s;
  };
  const num = (expr) => Number(evaluate(expr));
  run(fs.readFileSync(path.join(__dirname, 'wow_stub.lua'), 'utf8'));
  run(COMBAT_LOG_STUB);
  for (const f of ['Codec.lua', 'Inbox.lua', 'ClaudeWoW.lua', 'Roast.lua']) run(fs.readFileSync(path.join(ADDON, f), 'utf8'), 'ClaudeWoW');
  return { run, evaluate, num };
}

function decodeStrip(vm) {
  if (vm.evaluate('ClaudeWoWStrip and ClaudeWoWStrip.shown') !== 'true') return null;
  vm.run(`
    local parts = {}
    for _, t in ipairs(ClaudeWoWStrip.textures) do
      if t.shown and t.color then
        local c, r = math.floor(t.x / 4), math.floor(-t.y / 4)
        local v = (t.color[1] >= 0.5 and 4 or 0) + (t.color[2] >= 0.5 and 2 or 0) + (t.color[3] >= 0.5 and 1 or 0)
        parts[#parts + 1] = (r * ${CELLS_PER_ROW} + c) .. ":" .. v
      end
    end
    RESULT = table.concat(parts, ",")`);
  const cells = [];
  for (const p of vm.evaluate('RESULT').split(',')) { const [i, v] = p.split(':').map(Number); cells[i] = v; }
  const bytes = [];
  let acc = 0, nbits = 0;
  for (let i = 0; i < cells.length; i++) {
    acc = (acc << 3) | (cells[i] || 0); nbits += 3;
    while (nbits >= 8) { bytes.push((acc >> (nbits - 8)) & 0xff); nbits -= 8; acc &= (1 << nbits) - 1; }
  }
  assert.equal(bytes[0], 0xc7); assert.equal(bytes[1], 0x1a);
  const len = bytes[4] * 256 + bytes[5];
  return { id: bytes[2] * 256 + bytes[3], text: Buffer.from(bytes.slice(6, 6 + len)).toString('utf8') };
}

function stripJobs(vm) {
  const frame = decodeStrip(vm);
  return frame ? P.jobsFromStrip(frame.id, frame.text) : [];
}

function nextSlot(vm, luaBody) {
  vm.run(`STUB.onLoadAddOn = function(name) ClaudeWoW_SlotData = ${luaBody} end`);
}

function login(vm) {
  vm.run('STUB.FireEvent("ADDON_LOADED", "ClaudeWoW")');
  vm.run('STUB.FireEvent("PLAYER_LOGIN")');
}

function connect(vm) {
  vm.run('STUB.RunTimers()');
  nextSlot(vm, '{ now = time(), cwd = "", plugin = "ask", plugins = { "ask", "claude-code", "roast" }, replies = {} }');
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('ClaudeWoW.IsConnected()'), 'true');
}

function luaArgs(values) {
  return values.map(v => (v === null ? 'nil' : typeof v === 'string' ? JSON.stringify(v) : String(v))).join(', ');
}

function swing(vm, { source = 'Hogger', guid = HOGGER_GUID, amount, overkill = -1, crit = false }) {
  vm.run(`STUB.CombatLog(${luaArgs([1, 'SWING_DAMAGE', false, guid, source, 0, 0, PLAYER_GUID, 'Testchar', 0, 0, amount, overkill, 1, null, null, null, crit])})`);
}

function spell(vm, { sub = 'SPELL_DAMAGE', source = 'Hogger', guid = HOGGER_GUID, name, amount, overkill = -1, crit = false, dest = PLAYER_GUID }) {
  vm.run(`STUB.CombatLog(${luaArgs([1, sub, false, guid, source, 0, 0, dest, 'Testchar', 0, 0, 12345, name, 1, amount, overkill, 1, null, null, null, crit])})`);
}

function die(vm) {
  vm.run('STUB.FireEvent("PLAYER_DEAD")');
}

function roastChat(vm) {
  return 'ClaudeWoW_RoastChatForTest()';
}

function withRoastChatHelper(vm) {
  vm.run('function ClaudeWoW_RoastChatForTest() for _, c in ipairs(ClaudeWoWDB.chats) do if c.id == ClaudeWoWDB.roast.chat then return c end end end');
}

function ready({ on = true } = {}) {
  const vm = newVM();
  login(vm);
  connect(vm);
  withRoastChatHelper(vm);
  vm.run('STUB.prints = {}');
  if (on) vm.run('SlashCmdList.CLAUDE("config roast on")');
  return vm;
}

function answerRoast(vm, text) {
  const chat = roastChat(vm);
  const id = vm.num(`${chat}.pendingId`);
  nextSlot(vm, `{ now = time(), cwd = "", replies = { { chat = ${chat}.id, id = ${id}, status = "done", text = ${JSON.stringify(text)}, summary = "Hogger sends his regards.", agent = "claude", plugin = "roast" } } }`);
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate(`${chat}.pendingId`), null, 'the roast reply arrived');
}

test('roast: off by default, the slash command turns it on and off and says so, and nothing is recorded or sent while off', () => {
  const vm = ready({ on: false });
  assert.equal(vm.evaluate('ClaudeWoWDB.roast.on'), 'false', 'off by default');
  swing(vm, { amount: 40 });
  assert.equal(vm.num('#ClaudeWoWRoast.Hits()'), 0, 'no combat log kept while off');
  die(vm);
  assert.equal(vm.num('#ClaudeWoWDB.chats'), 1, 'no roast chat while off');
  assert.ok(!stripJobs(vm).some(j => j.kind), 'no roast record on the strip');

  vm.run('SlashCmdList.CLAUDE("config roast")');
  assert.ok(vm.evaluate('STUB.prints[#STUB.prints]').includes('Death roast is OFF'), vm.evaluate('STUB.prints[#STUB.prints]'));
  vm.run('SlashCmdList.CLAUDE("config roast on")');
  assert.equal(vm.evaluate('ClaudeWoWDB.roast.on'), 'true');
  assert.ok(vm.evaluate('STUB.prints[#STUB.prints]').includes('Death roast is ON'));
  vm.run('SlashCmdList.CLAUDE("config roast off")');
  assert.equal(vm.evaluate('ClaudeWoWDB.roast.on'), 'false');

  vm.run('SlashCmdList.CLAUDE("roast the lich king for me please")');
  assert.ok(stripJobs(vm).some(j => j.text === 'roast the lich king for me please'), 'free text starting with "roast" is a message');
  vm.run('ClaudeWoW.SwitchChat(ClaudeWoWDB.chats[1].id); SlashCmdList.CLAUDE("config")');
  assert.ok(vm.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].text').includes('\nroast = off  -  on|off'));
});

test('roast: the recap names the attackers, abilities, amounts, crits, levels, overkill and the killing blow from the last 10 seconds', () => {
  const vm = ready();
  vm.run(`STUB.guids.target = "${HOGGER_GUID}"; STUB.levels.target = 11`);
  swing(vm, { source: 'Kobold Vermin', guid: 'Creature-0-1-0-0-6-0002', amount: 3 });
  vm.run('STUB.now = STUB.now + 5');
  swing(vm, { amount: 45 });
  vm.run('STUB.now = STUB.now + 3');
  spell(vm, { name: 'Rending Claw', amount: 38, crit: true });
  spell(vm, { name: 'Holy Light', amount: 99, dest: 'Player-1-0002' });
  spell(vm, { sub: 'SPELL_HEAL', name: 'Renew', amount: 20 });
  vm.run('STUB.now = STUB.now + 2.5');
  swing(vm, { amount: 52, overkill: 17 });
  vm.run('STUB.now = STUB.now + 0.2');
  assert.equal(vm.num('#ClaudeWoWRoast.Hits()'), 3, 'the vermin hit fell out of the 10 s window; heals and hits on others never count');

  const recap = vm.evaluate('ClaudeWoWRoast.BuildRecap(STUB.now)');
  const lines = recap.split('\n');
  assert.equal(lines[0], 'Death recap: a level 23 Night Elf Hunter just died in Duskwood - Darkshire.');
  assert.equal(lines[1], 'Hits taken in the last 10 s, oldest first:');
  assert.equal(lines[2], '-5.7s Hogger (level 11): Melee 45');
  assert.equal(lines[3], '-2.7s Hogger (level 11): Rending Claw 38 crit');
  assert.equal(lines[4], '-0.2s Hogger (level 11): Melee 52, overkill 17 <- killing blow');
  assert.equal(lines[5], 'Damage taken: 135 from 1 source. Killing blow: Hogger\'s Melee.');
  assert.ok(!recap.includes('Kobold'), 'older than the window');
  assert.ok(!recap.includes('Holy Light') && !recap.includes('Renew'));
});

test('roast: a long fight is capped to the recap budget and keeps the killing blow; a death with no hits still gets a recap', () => {
  const vm = ready();
  vm.run('STUB.guids.target = nil; ClaudeWoWRoast.MAX_BYTES = 420');
  for (let i = 0; i < 30; i++) {
    spell(vm, { source: `Defias Pillager Number ${i}`, guid: `Creature-${i}`, name: 'An Extremely Long Fireball Name', amount: 10 + i });
    vm.run('STUB.now = STUB.now + 0.1');
  }
  swing(vm, { source: 'Edwin VanCleef', guid: 'Creature-639', amount: 300, overkill: 250 });
  const recap = vm.evaluate('ClaudeWoWRoast.BuildRecap(STUB.now)');
  assert.ok(Buffer.byteLength(recap) <= 420, `${Buffer.byteLength(recap)} bytes`);
  assert.ok(/\(\d+ earlier hits left out\)/.test(recap), recap);
  assert.ok(recap.includes('Edwin VanCleef: Melee 300, overkill 250 <- killing blow'), recap);
  assert.ok(recap.includes('from 31 sources'), 'the total still counts every hit in the window');
  vm.run('ClaudeWoWRoast.MAX_BYTES = 900');
  vm.run('ClaudeWoWRoast.Reset()');
  const empty = vm.evaluate('ClaudeWoWRoast.BuildRecap(STUB.now)');
  assert.ok(empty.startsWith('Death recap: a level 23'), empty);
  assert.ok(empty.includes('No damage in the last 10 s'), empty);
  vm.run('STUB.combatLog = table.pack(1, "ENVIRONMENTAL_DAMAGE", false, "", nil, 0, 0, STUB.guids.player, "Testchar", 0, 0, "Falling", 180, 60, 1, nil, nil, nil, nil); STUB.FireEvent("COMBAT_LOG_EVENT_UNFILTERED")');
  assert.ok(vm.evaluate('ClaudeWoWRoast.BuildRecap(STUB.now)').includes('the environment: Falling 180, overkill 60 <- killing blow'));
});

test('roast: a death goes out as a roast-kind message in its own chat bound to the roast plugin, and the bridge reads the kind back', () => {
  const vm = ready();
  const activeBefore = vm.evaluate('ClaudeWoWDB.activeChat');
  swing(vm, { amount: 52, overkill: 17 });
  die(vm);
  assert.equal(vm.num('#ClaudeWoWDB.chats'), 2, 'the Death roasts chat was made');
  const chat = roastChat(vm);
  assert.equal(vm.evaluate(`${chat}.name`), 'Death roasts');
  assert.equal(vm.evaluate(`${chat}.plugin`), 'roast');
  assert.equal(vm.evaluate(`${chat}.cwd`), '');
  assert.equal(vm.evaluate('ClaudeWoWDB.activeChat'), activeBefore, 'dying does not switch the window to another chat');
  assert.equal(vm.num('#ClaudeWoWRoast.Hits()'), 0, 'the log is spent on this death');

  const job = stripJobs(vm).find(j => j.chat === vm.evaluate(`${chat}.id`));
  assert.ok(job, 'the roast record is on the strip');
  assert.equal(job.kind, 'roast');
  assert.equal(job.plugin, 'roast');
  assert.equal(job.vision, false);
  assert.ok(job.text.startsWith('Death recap: a level 23 Night Elf Hunter just died in Duskwood - Darkshire.'), job.text);
  assert.ok(job.text.includes('Hogger: Melee 52, overkill 17 <- killing blow'), job.text);
  assert.ok(Buffer.byteLength(job.text) <= 900);
  assert.equal(vm.evaluate(`${chat}.history[1].role`), 'user');

  answerRoast(vm, 'Hogger bullied you with his bare paws.\n\nTL;DR: Hogger sends his regards.');
  assert.equal(vm.evaluate(`${chat}.history[#${chat}.history].role`), 'assistant');
  assert.equal(vm.num(`${chat}.unread`), 1, 'unread in the chat list');
  assert.ok(vm.evaluate('table.concat(STUB.prints, "\\n")').includes('Hogger sends his regards.'), 'the roast is echoed in the game chat');
});

test('roast: vision on attaches the screenshot to the death message like any other', () => {
  const vm = ready();
  vm.run('SlashCmdList.CLAUDE("config vision on")');
  swing(vm, { amount: 52, overkill: 17 });
  die(vm);
  const job = stripJobs(vm).find(j => j.kind === 'roast');
  assert.ok(job);
  assert.equal(job.vision, true);
});

test('roast: at most one roast every two minutes, and a death while disconnected or mid-roast is skipped without spending the cooldown', () => {
  const vm = ready();
  swing(vm, { amount: 52, overkill: 17 });
  die(vm);
  const chat = roastChat(vm);
  const first = vm.num(`${chat}.pendingId`);
  assert.ok(first > 0);

  vm.run('STUB.now = STUB.now + 5');
  swing(vm, { amount: 60, overkill: 1 });
  die(vm);
  assert.equal(vm.num(`${chat}.pendingId`), first, 'a death mid-roast is not queued on top');

  answerRoast(vm, 'one\n\nTL;DR: one');
  vm.run('STUB.now = STUB.now + 30');
  swing(vm, { amount: 60, overkill: 1 });
  die(vm);
  assert.equal(vm.evaluate(`${chat}.pendingId`), null, 'still inside the two minutes: the wipe does not spam the agent');
  assert.ok(vm.evaluate('ClaudeWoWRoast.lastSkip').startsWith('cooling down'), vm.evaluate('ClaudeWoWRoast.lastSkip'));
  vm.run('SlashCmdList.CLAUDE("config roast")');
  assert.ok(vm.evaluate('STUB.prints[#STUB.prints]').includes('next in'), vm.evaluate('STUB.prints[#STUB.prints]'));

  vm.run('STUB.now = STUB.now + 120');
  vm.run('ClaudeWoWRoast.lastSkip = nil; STUB.onLoadAddOn = nil');
  vm.run('ClaudeWoW.IsConnectedForTest = ClaudeWoW.IsConnected; ClaudeWoW.IsConnected = function() return false end');
  die(vm);
  assert.equal(vm.evaluate(`${chat}.pendingId`), null);
  assert.equal(vm.evaluate('ClaudeWoWRoast.lastSkip'), 'the bridge is not connected');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].draft'), null, 'nothing lands in an input box');

  vm.run('ClaudeWoW.IsConnected = ClaudeWoW.IsConnectedForTest');
  swing(vm, { amount: 70, overkill: 5 });
  die(vm);
  assert.ok(vm.num(`${chat}.pendingId`) > first, 'past the cooldown and connected: roasted again');
  assert.equal(vm.evaluate('ClaudeWoWRoast.lastSkip'), null);
});
