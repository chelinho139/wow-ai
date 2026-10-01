'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');

const ADDON = path.join(__dirname, '..', 'addon', 'ClaudeWoW');
const TOC_FILES = fs.readFileSync(path.join(ADDON, 'ClaudeWoW.toc'), 'utf8').split(/\r?\n/).map(l => l.trim()).filter(l => l.endsWith('.lua'));

const SOUND_STUB = `
VOICE = { played = {} }
local playSignalFile = PlaySoundFile
PlaySoundFile = function(file, channel)
  if type(file) == "number" then
    table.insert(VOICE.played, file)
    return true, 100 + #VOICE.played
  end
  return playSignalFile(file, channel)
end
StopSound = function() end
UnitRace = function() return "Human", "Human" end
UnitSex = function() return 2 end
STUB.played = {}
SOUNDKIT = { UI_EPICLOOT_TOAST = 31578, UI_NEED_ROLL_POSITIVE = 229319, LOOT_WINDOW_COIN_SOUND = 120, UI_NEED_ROLL_NEGATIVE = 229321 }
local SOUND_NAMES = {}
for name, id in pairs(SOUNDKIT) do SOUND_NAMES[id] = name end
function PlaySound(id) if SOUND_NAMES[id] then table.insert(STUB.played, SOUND_NAMES[id]) end end
`;

function newVM(savedVariables = '') {
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
    const s = lua.lua_isnil(L, -1) ? null : to_jsstring(lua.lua_tolstring(L, -1));
    lua.lua_pop(L, 1);
    return s;
  };
  const num = (expr) => Number(evaluate(expr));
  run(fs.readFileSync(path.join(__dirname, 'wow_stub.lua'), 'utf8'));
  run(SOUND_STUB);
  if (savedVariables) run(savedVariables);
  for (const f of TOC_FILES) run(fs.readFileSync(path.join(ADDON, f), 'utf8'), 'ClaudeWoW');
  run('STUB.FireEvent("ADDON_LOADED", "ClaudeWoW"); STUB.FireEvent("PLAYER_LOGIN")');
  run('STUB.RunTimers()');
  run('STUB.onLoadAddOn = function(name) ClaudeWoW_SlotData = { now = time(), cwd = "", replies = {} } end');
  run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(evaluate('ClaudeWoW.IsConnected()'), 'true');
  run('VOICE.played = {}; STUB.played = {}');
  return { run, evaluate, num };
}

function deliverDenial(vm, rules) {
  vm.run('ClaudeWoW.Send("clean the build folder")');
  const chatId = vm.evaluate('ClaudeWoWDB.chats[1].id');
  const id = vm.num('ClaudeWoWDB.chats[1].pendingId');
  vm.run('VOICE.played = {}; STUB.played = {}');
  const luaRules = rules.map(r => JSON.stringify(r)).join(', ');
  vm.run(`STUB.onLoadAddOn = function(name) ClaudeWoW_SlotData = { now = time(), cwd = "", replies = { { chat = "${chatId}", id = ${id}, status = "done", text = "I need permission", agent = "claude", denied = { ${luaRules} } } } } end`);
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].pendingId'), null);
}

function voiceLinesPlayed(vm) {
  return vm.num('#VOICE.played');
}

function playedLineIsFor(vm, index, event) {
  vm.run(`RESULT = "false"; for _, id in ipairs(ClaudeWoWVoice.LineFor("${event}") or {}) do if id == VOICE.played[${index}] then RESULT = "true" end end`);
  return vm.evaluate('RESULT') === 'true';
}

test('every feature module loads in .toc order and the core finds each one', () => {
  assert.deepEqual(TOC_FILES.slice(0, 3), ['Codec.lua', 'Inbox.lua', 'ClaudeWoW.lua']);
  for (const f of ['Roast.lua', 'Voice.lua', 'LootRoll.lua', 'Achievements.lua', 'Orders.lua', 'Widgets.lua']) {
    assert.ok(TOC_FILES.indexOf(f) > TOC_FILES.indexOf('ClaudeWoW.lua'), `${f} loads after the core it extends`);
  }
  const vm = newVM();
  for (const g of ['ClaudeWoWRoast', 'ClaudeWoWVoice', 'ClaudeWoWRoll', 'ClaudeWoWAchievements', 'ClaudeWoWOrders', 'ClaudeWoWWidgets']) {
    assert.equal(vm.evaluate(`type(${g})`), 'table', g);
  }
  assert.equal(vm.evaluate('ClaudeWoW.LootRollEnabled()'), 'true');
});

test('the stub records ADDON_ACTION_BLOCKED when an addon registers the combat log', () => {
  const vm = newVM();
  vm.run('local f = CreateFrame("Frame"); f:RegisterEvent("COMBAT_LOG_EVENT_UNFILTERED"); f:RegisterUnitEvent("UNIT_PING_PIN_ADDED", "player")');
  assert.equal(vm.num('#STUB.actionBlocked'), 2);
  assert.equal(vm.evaluate('STUB.actionBlocked[1]'), 'ADDON_ACTION_BLOCKED Frame:RegisterEvent(COMBAT_LOG_EVENT_UNFILTERED)');
});

test('loading every file in .toc order and logging in registers no event the client blocks, with default settings or with roast on', () => {
  const defaults = newVM();
  assert.equal(defaults.num('#STUB.actionBlocked'), 0, defaults.evaluate('table.concat(STUB.actionBlocked, "; ")'));
  defaults.run('SlashCmdList.CLAUDE("config roast on")');
  defaults.run('STUB.FireEvent("UNIT_COMBAT", "player", "WOUND", "", 40, 1); STUB.FireEvent("PLAYER_DEAD")');
  defaults.run('SlashCmdList.CLAUDE("config roast off")');
  assert.equal(defaults.num('#STUB.actionBlocked'), 0, defaults.evaluate('table.concat(STUB.actionBlocked, "; ")'));

  const roastOn = newVM('ClaudeWoWDB = { roast = { on = true } }');
  assert.equal(roastOn.evaluate('ClaudeWoWRoast.Listening()'), 'true');
  roastOn.run('STUB.FireEvent("PLAYER_ENTERING_WORLD"); STUB.FireEvent("UNIT_COMBAT", "player", "WOUND", "CRITICAL", 90, 4); STUB.FireEvent("PLAYER_DEAD")');
  assert.equal(roastOn.num('#STUB.actionBlocked'), 0, roastOn.evaluate('table.concat(STUB.actionBlocked, "; ")'));
});

test('a denied command plays the permission voice line once, next to one roll-frame toast', () => {
  const vm = newVM();
  deliverDenial(vm, ['Bash(rm:*)']);
  assert.equal(vm.evaluate('ClaudeWoWRollFrame.shown'), 'true');
  assert.equal(vm.evaluate('table.concat(STUB.played, ",")'), 'UI_EPICLOOT_TOAST');
  assert.equal(voiceLinesPlayed(vm), 1);
  assert.ok(playedLineIsFor(vm, 1, 'permission'), 'the one line is the permission line');
  vm.run('ClaudeWoW.Render(); ClaudeWoW.Render()');
  vm.run('ClaudeWoWRollFrame.scripts.OnUpdate(ClaudeWoWRollFrame, 0)');
  assert.equal(voiceLinesPlayed(vm), 1, 'redraws and the roll timer add no voice line');
  assert.equal(vm.evaluate('table.concat(STUB.played, ",")'), 'UI_EPICLOOT_TOAST', 'redraws add no toast');
});

test('rolling Need plays the Need sound and one sent line, and Pass plays no voice line', () => {
  const vm = newVM();
  deliverDenial(vm, ['Bash(cargo:*)']);
  vm.run('STUB.now = STUB.now + 5; VOICE.played = {}; STUB.played = {}');
  vm.run('ClaudeWoWRollFrame.NeedButton.scripts.OnClick(ClaudeWoWRollFrame.NeedButton)');
  assert.equal(vm.evaluate('table.concat(STUB.played, ",")'), 'UI_NEED_ROLL_POSITIVE');
  assert.equal(voiceLinesPlayed(vm), 1);
  assert.ok(playedLineIsFor(vm, 1, 'sent'));

  const passed = newVM();
  deliverDenial(passed, ['Bash(rm:*)']);
  passed.run('STUB.now = STUB.now + 5; VOICE.played = {}; STUB.played = {}');
  passed.run('ClaudeWoWRollFrame.PassButton.scripts.OnClick(ClaudeWoWRollFrame.PassButton)');
  assert.equal(passed.evaluate('table.concat(STUB.played, ",")'), 'UI_NEED_ROLL_NEGATIVE');
  assert.equal(voiceLinesPlayed(passed), 0);
});
