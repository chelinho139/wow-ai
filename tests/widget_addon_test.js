'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');
const P = require('../bridge/protocol');

const ADDON = path.join(__dirname, '..', 'addon', 'ClaudeWoW');

const STUB_EXTRAS = `
function Methods.UnregisterAllEvents(self) self.events = {} end
function Methods.SetAllPoints(self) end
local newTicker = C_Timer.NewTicker
C_Timer.NewTicker = function(delay, fn)
  local handle = newTicker(delay, fn)
  handle.Cancel = function(self) self.cancelled = true end
  STUB.lastTicker = handle
  return handle
end
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
  run(fs.readFileSync(path.join(__dirname, 'wow_stub.lua'), 'utf8') + STUB_EXTRAS);
  if (savedVariables) run(savedVariables);
  for (const f of ['Codec.lua', 'Inbox.lua', 'ClaudeWoW.lua', 'Map.lua', 'Widgets.lua']) run(fs.readFileSync(path.join(ADDON, f), 'utf8'), 'ClaudeWoW');
  run('STUB.FireEvent("ADDON_LOADED", "ClaudeWoW"); STUB.FireEvent("PLAYER_LOGIN")');
  return { run, evaluate };
}

const TARGET_METER = [
  'local ui = ...',
  'ui.db.runs = (ui.db.runs or 0) + 1',
  'local f = CreateFrame("Frame")',
  'f:RegisterEvent("PLAYER_TARGET_CHANGED")',
  'local text = f:CreateFontString(nil, "OVERLAY", "GameFontNormal")',
  'f:SetScript("OnEvent", function() if WIDGET_TEST_BOOM then error("boom") end text:SetText("level " .. UnitLevel("player")) end)',
  'C_Timer.NewTicker(1, function() end)',
].join('\n');

function widgetSet(widgets, version = 1, epoch = 'e1') {
  const set = P.newWidgetSet(epoch);
  P.applyWidgetCommands(set, widgets.map(([name, source]) => ({ op: 'set', name, title: name + ' title', source })));
  set.version = version;
  return P.luaTable('ClaudeWoW_SlotData', [], { now: 1, widgets: set }) + '\nClaudeWoWWidgets.Sync(ClaudeWoW_SlotData.widgets)';
}

const meterFrame = `(function() for _, f in ipairs(STUB.frames) do if f.events.PLAYER_TARGET_CHANGED and f.scripts.OnEvent then return f end end end)()`;
const lastSystemNote = '(function() local h = ClaudeWoWDB.chats[1].history; for i = #h, 1, -1 do if h[i].role == "system" then return h[i].text end end end)()';

test('a widget from the slot data runs live inside its container, with saved data', () => {
  const vm = newVM();
  vm.run(widgetSet([['meter', TARGET_METER]]));
  assert.equal(vm.evaluate('ClaudeWoWWidgets.Status("meter")'), 'running');
  assert.equal(vm.evaluate('ClaudeWoWWidgetDB.data.meter.runs'), '1');
  assert.equal(vm.evaluate(`${meterFrame}.parent.parent == UIParent`), 'true');
  vm.run('STUB.FireEvent("PLAYER_TARGET_CHANGED")');
  assert.equal(vm.evaluate(`${meterFrame}.children[1].text`), 'level 23');
  assert.match(vm.evaluate(lastSystemNote), /meter is live/);
  vm.run(widgetSet([['meter', TARGET_METER]]));
  assert.equal(vm.evaluate('ClaudeWoWWidgetDB.data.meter.runs'), '1');
});

test('a runtime error stops the widget and is reported in the chat window', () => {
  const vm = newVM();
  vm.run(widgetSet([['meter', TARGET_METER]]));
  vm.run('WIDGET_TEST_BOOM = true; STUB.FireEvent("PLAYER_TARGET_CHANGED")');
  assert.equal(vm.evaluate('ClaudeWoWWidgets.Status("meter")'), 'failed');
  assert.match(vm.evaluate(lastSystemNote), /meter failed and was stopped: .*boom/);
  assert.equal(vm.evaluate('STUB.lastTicker.cancelled'), 'true');
  assert.equal(vm.evaluate(`${meterFrame}`), null);
  vm.run('WIDGET_TEST_BOOM = false; SlashCmdList.CLAUDE("config ui run meter")');
  assert.equal(vm.evaluate('ClaudeWoWWidgets.Status("meter")'), 'running');
});

test('compile errors and blocked calls fail cleanly', () => {
  const vm = newVM();
  vm.run(widgetSet([
    ['broken', 'local ui = ...\nif then end'],
    ['sneaky', 'local ui = ...\nlocal name = "Cast" .. "Spell" .. "ByName"\n_G[name]("Fireball")'],
    ['secure', 'local ui = ...\nlocal kind = "Sec" .. "ure"\nCreateFrame("Button", nil, nil, kind .. "ActionButtonTemplate")'],
    ['nosy', 'local ui = ...\nlocal key = "Clau" .. "deWoWDB"\nassert(_G[key] == nil, "leak")\nassert(getmetatable(_G) == false)'],
  ]));
  assert.equal(vm.evaluate('ClaudeWoWWidgets.Status("broken")'), 'failed');
  assert.equal(vm.evaluate('ClaudeWoWWidgets.Status("sneaky")'), 'failed');
  assert.match(vm.evaluate('select(2, ClaudeWoWWidgets.Status("sneaky"))'), /CastSpellByName is not allowed/);
  assert.match(vm.evaluate('select(2, ClaudeWoWWidgets.Status("secure"))'), /secure templates are not allowed/);
  assert.equal(vm.evaluate('ClaudeWoWWidgets.Status("nosy")'), 'running');
});

test('/claude config ui remove keeps a widget off until the agent sends a new version', () => {
  const vm = newVM();
  vm.run(widgetSet([['meter', TARGET_METER]]));
  vm.run('SlashCmdList.CLAUDE("config ui remove meter")');
  assert.equal(vm.evaluate('ClaudeWoWWidgets.Status("meter")'), 'removed');
  assert.equal(vm.evaluate('STUB.lastTicker.cancelled'), 'true');
  vm.run(widgetSet([['meter', TARGET_METER]], 2));
  assert.equal(vm.evaluate('ClaudeWoWWidgets.Status("meter")'), 'removed');
  vm.run(widgetSet([['meter', TARGET_METER + '\nlocal changed = true']], 3));
  assert.equal(vm.evaluate('ClaudeWoWWidgets.Status("meter")'), 'running');
  vm.run(widgetSet([], 4));
  assert.equal(vm.evaluate('ClaudeWoWWidgets.Status("meter")'), null);
  assert.match(vm.evaluate(lastSystemNote), /meter was removed by the agent/);
});

test('/claude config ui lists widgets, and free text starting with "ui" is still a message', () => {
  const vm = newVM();
  vm.run(widgetSet([['meter', TARGET_METER]]));
  vm.run('STUB.prints = {}; SlashCmdList.CLAUDE("config ui")');
  assert.match(vm.evaluate('table.concat(STUB.prints, "\\n")'), /meter {2}meter title {2}\(running, \d+ bytes\)/);
  vm.run('STUB.prints = {}; ClaudeWoW.Send = function(text) SENT_TEXT = text end; SlashCmdList.CLAUDE("ui for my bags would be nice")');
  assert.doesNotMatch(vm.evaluate('table.concat(STUB.prints, "\\n")'), /\[Claude WoW ui\]/);
  assert.equal(vm.evaluate('SENT_TEXT'), 'ui for my bags would be nice');
});

test('saved widgets start again at login without the bridge', () => {
  const clock = 'local ui = ...\nui.db.started = true';
  const saved = `ClaudeWoWWidgetDB = { removed = { meter = "${P.widgetRevision(TARGET_METER)}" }, data = {}, set = { epoch = "e1", version = 2, items = {
    { name = "meter", title = "meter title", rev = "${P.widgetRevision(TARGET_METER)}", source = ${P.luaStr(TARGET_METER)} },
    { name = "clock", title = "clock title", rev = "${P.widgetRevision(clock)}", source = ${P.luaStr(clock)} } } } }`;
  const vm = newVM(saved);
  assert.equal(vm.evaluate('ClaudeWoWWidgets.Status("clock")'), 'running');
  assert.equal(vm.evaluate('ClaudeWoWWidgetDB.data.clock.started'), 'true');
  assert.equal(vm.evaluate('ClaudeWoWWidgets.Status("meter")'), 'removed');
});

test('widgets in Inbox.lua reach the widget module on the reload path', () => {
  const set = P.newWidgetSet('e9');
  P.applyWidgetCommands(set, [{ op: 'set', name: 'clock', source: 'local ui = ...\nui.db.started = true' }]);
  const inbox = P.luaTable('ClaudeWoW_Inbox', [], { now: 1, widgets: set });
  const vm = newVM();
  vm.run(inbox + '\nSTUB.FireEvent("PLAYER_LOGIN")');
  assert.equal(vm.evaluate('ClaudeWoWWidgets.Status("clock")'), 'running');
});
