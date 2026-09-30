'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');

const ADDON = path.join(__dirname, '..', 'addon', 'ClaudeWoW');

function newVM({ before = '', saved = '' } = {}) {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const run = (code, arg, chunk) => {
    const buf = to_luastring(code);
    const loaded = chunk ? lauxlib.luaL_loadbuffer(L, buf, buf.length, to_luastring('@' + chunk)) : lauxlib.luaL_loadstring(L, buf);
    if (loaded !== lua.LUA_OK) throw new Error('Lua load: ' + to_jsstring(lua.lua_tostring(L, -1)));
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
  run(BLIZZARD);
  if (before) run(before);
  for (const f of ['Codec.lua', 'Inbox.lua', 'ClaudeWoW.lua', 'LootRoll.lua', 'Window.lua']) run(fs.readFileSync(path.join(ADDON, f), 'utf8'), 'ClaudeWoW', 'addon/' + f);
  if (saved) run(saved);
  run('STUB.FireEvent("ADDON_LOADED", "ClaudeWoW"); STUB.FireEvent("PLAYER_LOGIN")');
  return { run, evaluate, num };
}

const BLIZZARD = `
  STUB.Panel("CharacterFrame", 16, 1000, 700, 600)
  STUB.Panel("ContainerFrameCombinedBags", 1200, 700, 700, 500)
  STUB.Panel("GameMenuFrame", 760, 700, 400, 400)
  WorldMapFrame = STUB.Panel("WorldMapFrame", 300, 1000, 1300, 900)
  STUB.mapMax = false
  function WorldMapFrame:IsMaximized() return STUB.mapMax end
  function WorldMapFrame:Maximize() STUB.mapMax = true end
  function WorldMapFrame:Minimize() STUB.mapMax = false end
  function ToggleAllBags() if ContainerFrameCombinedBags:IsShown() then ContainerFrameCombinedBags:Hide() else ContainerFrameCombinedBags:Show() end end
`;

const rect = (vm) => ({
  left: vm.num('ClaudeWoWFrame:GetLeft()'), top: vm.num('ClaudeWoWFrame:GetTop()'),
  right: vm.num('ClaudeWoWFrame:GetRight()'), bottom: vm.num('ClaudeWoWFrame:GetBottom()'),
});
const settle = (vm) => vm.run('STUB.RunTimers(); STUB.RunTimers()');
const frames = (vm, n, dt = 0.05) => { for (let i = 0; i < n; i++) vm.run(`STUB.RunFrames(${dt})`); };
const open = (vm) => { vm.run('ClaudeWoW.Toggle(true)'); settle(vm); };
const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.bottom < b.top && a.top > b.bottom;
const panelRect = (vm, name) => ({ left: vm.num(`${name}:GetLeft()`), right: vm.num(`${name}:GetRight()`), top: vm.num(`${name}:GetTop()`), bottom: vm.num(`${name}:GetBottom()`) });

test('the workspace window steps aside when a Blizzard panel opens, and goes home when it closes', () => {
  const vm = newVM();
  open(vm);
  const home = rect(vm);
  assert.deepEqual(home, { left: 570, top: 790, right: 1350, bottom: 290 }, 'a new character starts centred at the default size');

  vm.run('ShowUIPanel(CharacterFrame)');
  settle(vm);
  let r = rect(vm);
  assert.equal(r.left, 16 + 700 + 8, 'moved just right of the character sheet');
  assert.equal(r.top, home.top, 'on the same line');
  assert.ok(!overlaps(r, panelRect(vm, 'CharacterFrame')));
  assert.equal(vm.evaluate('ClaudeWoWWindow.state.dodged'), 'true');

  vm.run('HideUIPanel(CharacterFrame)');
  settle(vm);
  assert.deepEqual(rect(vm), home, 'back where it was');
  assert.equal(vm.evaluate('ClaudeWoWWindow.state.dodged'), 'false');

  vm.run('ToggleAllBags()');
  settle(vm);
  r = rect(vm);
  assert.equal(r.right, 1200 - 8, 'bags on the right push it left');
  assert.ok(!overlaps(r, panelRect(vm, 'ContainerFrameCombinedBags')));
  vm.run('ToggleAllBags()');
  settle(vm);
  assert.deepEqual(rect(vm), home);

  vm.run('CharacterFrame:Show()');
  frames(vm, 8);
  settle(vm);
  assert.equal(rect(vm).left, 724, 'a panel shown without the panel manager is caught by the poll');
  vm.run('CharacterFrame:Hide(); ContainerFrameCombinedBags:Show()');
  frames(vm, 8);
  settle(vm);
  vm.run('CharacterFrame:Show()');
  frames(vm, 8);
  settle(vm);
  assert.deepEqual(rect(vm), home, 'no room anywhere: it stays home instead of jumping off screen');
  vm.run('CharacterFrame:Hide(); ContainerFrameCombinedBags:Hide()');
  frames(vm, 8);
  settle(vm);

  vm.run('SlashCmdList.CLAUDE("config ui dodge off")');
  vm.run('ShowUIPanel(CharacterFrame)');
  settle(vm);
  assert.deepEqual(rect(vm), home, 'dodge off: it stays put');
  vm.run('HideUIPanel(CharacterFrame)');
});

test('full-screen frames hide the window and bring it back; autohide off keeps it; the player\'s own close is kept', () => {
  const vm = newVM();
  open(vm);
  vm.run('ShowUIPanel(GameMenuFrame)');
  settle(vm);
  assert.equal(vm.evaluate('ClaudeWoWFrame.shown'), 'false', 'the game menu hides it');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.shown'), 'true', 'but it still counts as open');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.minimized'), 'false', 'not minimized');
  assert.equal(vm.evaluate('ClaudeWoWMini.shown'), 'false', 'and the bar does not stand in for it');
  vm.run('HideUIPanel(GameMenuFrame)');
  settle(vm);
  assert.equal(vm.evaluate('ClaudeWoWFrame.shown'), 'true', 'back after the menu closes');

  vm.run('ShowUIPanel(WorldMapFrame)');
  settle(vm);
  assert.equal(vm.evaluate('ClaudeWoWFrame.shown'), 'true', 'the docked map is only a panel');
  assert.ok(!overlaps(rect(vm), panelRect(vm, 'WorldMapFrame')) || vm.evaluate('ClaudeWoWWindow.state.dodged') === 'false');
  vm.run('WorldMapFrame:Maximize()');
  settle(vm);
  assert.equal(vm.evaluate('ClaudeWoWFrame.shown'), 'false', 'the maximized map hides it');
  vm.run('WorldMapFrame:Minimize()');
  settle(vm);
  assert.equal(vm.evaluate('ClaudeWoWFrame.shown'), 'true', 'and gives it back');
  vm.run('HideUIPanel(WorldMapFrame)');
  settle(vm);

  vm.run('ShowUIPanel(GameMenuFrame)');
  settle(vm);
  vm.run('ClaudeWoW.Toggle(true)');
  settle(vm);
  assert.equal(vm.evaluate('ClaudeWoWFrame.shown'), 'true', 'opened on purpose over the menu: it stays');
  vm.run('ClaudeWoW.Minimize(true)');
  vm.run('HideUIPanel(GameMenuFrame)');
  settle(vm);
  assert.equal(vm.evaluate('ClaudeWoWFrame.shown'), 'false', 'minimized by the player: not brought back');

  vm.run('ClaudeWoW.Toggle(true); SlashCmdList.CLAUDE("config ui autohide off")');
  vm.run('ShowUIPanel(GameMenuFrame)');
  settle(vm);
  assert.equal(vm.evaluate('ClaudeWoWFrame.shown'), 'true', 'autohide off: it stays up');
});

test('it dims while the player moves or fights, fades back smoothly, and is opaque under the mouse or while typing', () => {
  const vm = newVM();
  open(vm);
  const alpha = () => vm.num('ClaudeWoWFrame:GetAlpha()');
  assert.equal(alpha(), 1);
  vm.run('STUB.FireEvent("PLAYER_STARTED_MOVING")');
  frames(vm, 1, 0.1);
  assert.ok(alpha() < 1 && alpha() > 0.35, 'a fade, not a jump: ' + alpha());
  frames(vm, 5, 0.1);
  assert.equal(alpha(), 0.35, 'dimmed to 35%');
  assert.equal(vm.num('ClaudeWoWMini:GetAlpha()'), 0.35, 'the bar dims with it');
  vm.run('STUB.mouseOver = ClaudeWoWFrame');
  frames(vm, 5, 0.1);
  assert.equal(alpha(), 1, 'opaque under the mouse');
  vm.run('STUB.mouseOver = nil; ClaudeWoWInput:SetFocus()');
  frames(vm, 5, 0.1);
  assert.equal(alpha(), 1, 'opaque while typing');
  vm.run('ClaudeWoWInput:ClearFocus()');
  frames(vm, 5, 0.1);
  assert.equal(alpha(), 0.35);
  vm.run('STUB.FireEvent("PLAYER_STOPPED_MOVING")');
  frames(vm, 1, 0.1);
  assert.ok(alpha() > 0.35 && alpha() < 1, 'fading back: ' + alpha());
  frames(vm, 5, 0.1);
  assert.equal(alpha(), 1, 'back when the player stops');

  vm.run('STUB.combat = true; STUB.FireEvent("PLAYER_REGEN_DISABLED")');
  frames(vm, 6, 0.1);
  assert.equal(alpha(), 0.35, 'dimmed in combat');
  vm.run('STUB.combat = false; STUB.FireEvent("PLAYER_REGEN_ENABLED")');
  frames(vm, 6, 0.1);
  assert.equal(alpha(), 1);

  vm.run('SlashCmdList.CLAUDE("config ui dim 60")');
  vm.run('STUB.FireEvent("PLAYER_STARTED_MOVING")');
  frames(vm, 6, 0.1);
  assert.equal(alpha(), 0.6, 'the dim level is the setting');
  vm.run('SlashCmdList.CLAUDE("config ui dim off")');
  frames(vm, 6, 0.1);
  assert.equal(alpha(), 1, 'dim off: never dimmed');
  vm.run('STUB.FireEvent("PLAYER_STARTED_MOVING"); SlashCmdList.CLAUDE("config ui dim 35")');
  frames(vm, 6, 0.1);
  assert.equal(alpha(), 0.35);
  assert.equal(vm.evaluate('ClaudeWoWFrame.mouseEnabled'), 'true', 'dimmed, it still takes clicks: nothing is turned off');
  assert.equal(vm.evaluate('ClaudeWoWInput.mouseEnabled ~= false'), 'true');
});

test('in combat the window still steps aside and dims, touches no protected frame and calls no panel function', () => {
  const vm = newVM();
  open(vm);
  vm.run('STUB.combat = true; STUB.FireEvent("PLAYER_REGEN_DISABLED")');
  vm.run('ShowUIPanel(CharacterFrame)');
  settle(vm);
  frames(vm, 8, 0.1);
  assert.equal(rect(vm).left, 724, 'moved in combat: it is an ordinary frame');
  assert.equal(vm.num('ClaudeWoWFrame:GetAlpha()'), 0.35);
  vm.run('ShowUIPanel(GameMenuFrame)');
  settle(vm);
  vm.run('HideUIPanel(GameMenuFrame); HideUIPanel(CharacterFrame)');
  settle(vm);
  frames(vm, 8, 0.1);
  vm.run('ClaudeWoW.InstallMacro({ name = "X", body = "/sit" })');
  assert.equal(vm.evaluate('STUB.blocked[1]'), null, 'no protected frame was moved, shown or hidden by addon code');
  assert.equal(vm.evaluate('(function() for _, c in ipairs(STUB.panelCalls) do if c.addon then return c.name end end end)()'), null, 'no ShowUIPanel/HideUIPanel from addon code');
  assert.ok(vm.evaluate('table.concat(STUB.prints, "\\n")').includes("macros can't be changed in combat"));
});

test('size and place are remembered per character, snap to the screen edges and respect the UI scale', () => {
  const vm = newVM();
  open(vm);
  vm.run('ClaudeWoWFrame:ClearAllPoints(); ClaudeWoWFrame:SetPoint("TOPLEFT", UIParent, "BOTTOMLEFT", 9, 1071)');
  vm.run('ClaudeWoWFrame.scripts.OnDragStop(ClaudeWoWFrame)');
  assert.deepEqual(rect(vm), { left: 0, top: 1080, right: 780, bottom: 580 }, 'dropped within 16 px of the corner: snapped to it');
  assert.equal(vm.evaluate('ClaudeWoWDB.layouts["Testchar-Test Realm"].left'), '0');
  vm.run('ClaudeWoWFrame:SetSize(900, 600); for _, c in ipairs(ClaudeWoWFrame.children) do if c.scripts.OnMouseUp and c.kind == "Button" and not c.name then c.scripts.OnMouseUp(c) end end');
  assert.equal(vm.num('ClaudeWoWDB.layouts["Testchar-Test Realm"].w'), 900, 'the resize grip saves the size');

  vm.run('local real = UnitName; UnitName = function() return "Alt" end; ALT = ClaudeWoWWindow.Layout(); UnitName = real');
  assert.equal(vm.num('ALT.left'), (1920 - 900) / 2, 'another character gets a place of its own, centred at the account\'s last size');
  assert.equal(vm.num('ClaudeWoWWindow.Layout().left'), 0, 'this one keeps its own');

  vm.run('CharacterFrame:SetScale(0.5); ShowUIPanel(CharacterFrame)');
  settle(vm);
  assert.equal(rect(vm).left, 8 + 358, 'a scaled panel is measured in UIParent units');
  vm.run('HideUIPanel(CharacterFrame); CharacterFrame:SetScale(1)');
  settle(vm);

  vm.run('UIParent:SetSize(1280, 720); STUB.FireEvent("UI_SCALE_CHANGED")');
  settle(vm);
  const r = rect(vm);
  assert.ok(r.left >= 0 && r.right <= 1280 && r.bottom >= 0 && r.top <= 720, 'kept on a smaller screen: ' + JSON.stringify(r));

  vm.run('SlashCmdList.CLAUDE("config ui reset")');
  assert.equal(vm.evaluate('ClaudeWoWDB.layouts["Testchar-Test Realm"].w'), '780', 'reset goes back to the default size');
});

test('an install from before per-character layouts starts where its saved window was', () => {
  const vm = newVM({ saved: 'ClaudeWoWDB = { settings = { point = "TOPLEFT", relPoint = "TOPLEFT", x = 40, y = -60, width = 700, height = 400, whisperV2 = true, whisper = true } }' });
  open(vm);
  assert.deepEqual(rect(vm), { left: 40, top: 1020, right: 740, bottom: 620 });
});

test('the window replaces nothing of Blizzard\'s: panel hooks are secure post-hooks and no Blizzard frame script is touched', () => {
  const vm = newVM({ before: `SNAP = { g = {}, map = {} }
    for k, v in pairs(_G) do if type(v) == "function" then SNAP.g[k] = v end end
    for _, k in ipairs({ "Maximize", "Minimize", "IsMaximized" }) do SNAP.map[k] = WorldMapFrame[k] end` });
  open(vm);
  vm.run('ShowUIPanel(CharacterFrame); ToggleAllBags(); WorldMapFrame:Maximize()');
  settle(vm);
  const bad = vm.evaluate(`(function()
    local bad = {}
    for k, v in pairs(SNAP.g) do if _G[k] ~= v and not STUB.secureHooks[_G[k]] then bad[#bad + 1] = k end end
    for k, v in pairs(SNAP.map) do if WorldMapFrame[k] ~= v and not STUB.secureHooks[WorldMapFrame[k]] then bad[#bad + 1] = "WorldMapFrame:" .. k end end
    for _, name in ipairs({ "CharacterFrame", "ContainerFrameCombinedBags", "GameMenuFrame", "WorldMapFrame" }) do
      if next(_G[name].scripts) then bad[#bad + 1] = name .. " script" end
      if next(_G[name].hooks) then bad[#bad + 1] = name .. " HookScript" end
    end
    return table.concat(bad, ", ")
  end)()`);
  assert.equal(bad, '');
  assert.equal(vm.evaluate('STUB.secureHooks[ShowUIPanel]'), 'true', 'ShowUIPanel is watched through hooksecurefunc');
  assert.equal(vm.evaluate('STUB.secureHooks[SetItemRef]'), 'true', 'links are read through a SetItemRef post-hook');
});

test('the Dragonflight metal border is used where the client has it, and the plain one elsewhere', () => {
  const plain = newVM();
  assert.equal(plain.evaluate('ClaudeWoWWindow.skinned'), 'false');
  const metal = newVM({ before: `
    NineSliceLayouts = { ButtonFrameTemplateNoPortrait = {} }
    NineSliceUtil = { ApplyLayoutByName = function(frame, name) STUB.layout = name end }` });
  assert.equal(metal.evaluate('ClaudeWoWWindow.skinned'), 'true');
  assert.equal(metal.evaluate('STUB.layout'), 'ButtonFrameTemplateNoPortrait');
  assert.equal(metal.evaluate('ClaudeWoWFrame.claudewowBorder.template'), 'NineSlicePanelTemplate');
});
