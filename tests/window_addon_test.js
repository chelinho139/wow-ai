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
  assert.deepEqual(home, { left: 16, top: 964, right: 796, bottom: 464 }, 'it opens in the Blizzard left panel slot at the default size');

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
  assert.deepEqual(rect(vm), home, 'bags on the right leave the left slot alone');
  vm.run('UIParent:SetAttribute("LEFT_OFFSET", 1100)');
  vm.run('ClaudeWoWWindow.Relayout()');
  r = rect(vm);
  assert.equal(r.right, 1200 - 8, 'a home the bags cover moves left of them');
  assert.ok(!overlaps(r, panelRect(vm, 'ContainerFrameCombinedBags')));
  vm.run('UIParent:SetAttribute("LEFT_OFFSET", nil); ClaudeWoWWindow.Relayout()');
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

test('the window cannot be dragged, the compact bar can, and the size is remembered per character and respects the UI scale', () => {
  const vm = newVM();
  open(vm);
  const home = rect(vm);
  assert.equal(vm.evaluate('ClaudeWoWFrame.scripts.OnDragStart'), null, 'no drag on the window');
  assert.equal(vm.evaluate('ClaudeWoWFrame.scripts.OnDragStop'), null);
  assert.notEqual(vm.evaluate('ClaudeWoWMini.scripts.OnDragStart'), null, 'the compact bar still drags');

  vm.run('ClaudeWoWFrame:SetSize(900, 600); for _, c in ipairs(ClaudeWoWFrame.children) do if c.scripts.OnMouseUp and c.kind == "Button" and not c.name then c.scripts.OnMouseUp(c) end end');
  assert.equal(vm.num('ClaudeWoWDB.layouts["Testchar-Test Realm"].w'), 900, 'the resize grip saves the size');
  settle(vm);
  assert.deepEqual(rect(vm), { left: home.left, top: home.top, right: home.left + 900, bottom: home.top - 600 }, 'resizing keeps the top-left corner in the slot');

  vm.run('local real = UnitName; UnitName = function() return "Alt" end; ALT = ClaudeWoWWindow.Layout(); UnitName = real');
  assert.equal(vm.num('ALT.w'), 900, 'another character starts at the account\'s last size');

  vm.run('ClaudeWoWFrame:SetSize(780, 500); for _, c in ipairs(ClaudeWoWFrame.children) do if c.scripts.OnMouseUp and c.kind == "Button" and not c.name then c.scripts.OnMouseUp(c) end end');
  settle(vm);
  vm.run('CharacterFrame:SetScale(0.5); ShowUIPanel(CharacterFrame)');
  settle(vm);
  assert.ok(!overlaps(rect(vm), { left: 8, right: 358, top: 500, bottom: 200 }), 'a scaled panel is measured in UIParent units');
  assert.equal(vm.evaluate('ClaudeWoWWindow.state.dodged'), 'true');
  vm.run('HideUIPanel(CharacterFrame); CharacterFrame:SetScale(1)');
  settle(vm);

  vm.run('UIParent:SetSize(1280, 720); STUB.FireEvent("UI_SCALE_CHANGED")');
  settle(vm);
  const r = rect(vm);
  assert.ok(r.left >= 0 && r.right <= 1280 && r.bottom >= 0 && r.top <= 720, 'kept on a smaller screen: ' + JSON.stringify(r));

  vm.run('ClaudeWoWDB.layouts["Testchar-Test Realm"].w = 1000');
  vm.run('SlashCmdList.CLAUDE("config ui reset")');
  assert.equal(vm.evaluate('ClaudeWoWDB.layouts["Testchar-Test Realm"].w'), '780', 'reset goes back to the default size');
});

test('an install with a dragged window from before opens in the panel slot at its saved size', () => {
  const vm = newVM({ saved: 'ClaudeWoWDB = { settings = { point = "TOPLEFT", relPoint = "TOPLEFT", x = 40, y = -60, width = 700, height = 400, whisperV2 = true, whisper = true } }' });
  open(vm);
  assert.deepEqual(rect(vm), { left: 16, top: 964, right: 716, bottom: 564 });
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

const NATIVE_TEMPLATES = `
  local templates = { ButtonFrameTemplate = true, InsetFrameTemplate = true, SearchBoxTemplate = true, ScrollFrameTemplate = true, NavBarTemplate = true, MainHelpPlateButton = true }
  C_XMLUtil = { GetTemplateInfo = function(name) if templates[name] then return { type = "Frame" } end end }
  STUB.nav = { resets = 0, buttons = {} }
  function NavBar_Initialize(bar, template, home) STUB.nav.home = home.name end
  function NavBar_Reset(bar) STUB.nav.resets = STUB.nav.resets + 1; STUB.nav.buttons = {} end
  function NavBar_AddButton(bar, data) table.insert(STUB.nav.buttons, data) end
  function ScrollingEdit_OnCursorChanged() end
  function ScrollingEdit_OnTextChanged() end
  MenuUtil = { CreateContextMenu = function(owner, gen)
    local root = { items = {} }
    function root:CreateTitle(t) table.insert(self.items, { text = t }) end
    function root:CreateButton(t, fn) table.insert(self.items, { text = t, fn = fn }) end
    function root:CreateCheckbox(t, get, fn) table.insert(self.items, { text = t, fn = fn, get = get }) end
    function root:CreateDivider() end
    STUB.menu = root
    gen(owner, root)
  end }
  function STUB.Pick(text) for _, it in ipairs(STUB.menu.items) do if it.text == text then it.fn() return end end error("no menu item " .. text) end
  local plainCreate = CreateFrame
  CreateFrame = function(kind, name, parent, template)
    local f = plainCreate(kind, name, parent, template)
    if template == "ButtonFrameTemplate" then
      f.CloseButton = plainCreate("Button", nil, f, "UIPanelCloseButton")
      f.Inset = plainCreate("Frame", nil, f, "InsetFrameTemplate")
      f.TitleText = f:CreateFontString()
      function f:GetTitleText() return self.TitleText end
      function f:SetPortraitToAsset(path) self.portrait = path end
    end
    return f
  end`;

const nativeVM = () => {
  const vm = newVM({ before: NATIVE_TEMPLATES });
  open(vm);
  vm.run('ClaudeWoW.SetFolder("~/every-io/every", ClaudeWoWDB.chats[1])');
  vm.run('ClaudeWoW.NewChat(); ClaudeWoW.SetFolder("~/wow-ai", ClaudeWoW.UI and ClaudeWoWDB.chats[2]); ClaudeWoWDB.chats[2].name = "Fix the bridge"');
  vm.run('ClaudeWoW.NewChat(); ClaudeWoWDB.chats[3].name = "Leatherworking route"; ClaudeWoW.SetFolder("~/every-io/every", ClaudeWoWDB.chats[3])');
  vm.run('ClaudeWoW.Render()');
  return vm;
};
const shownHeaders = (vm) => vm.evaluate('(function() local t = {} for _, h in ipairs(ClaudeWoW.UI.questList.headers) do if h.shown then table.insert(t, h.text:GetText()) end end return table.concat(t, "|") end)()');
const shownRows = (vm) => vm.evaluate('(function() local t = {} for _, r in ipairs(ClaudeWoW.UI.questList.rows) do if r.shown then table.insert(t, r.label:GetText()) end end return table.concat(t, "|") end)()');

test('on Classic Era the window keeps only the atlases that client draws, and plain fills replace the Forever quest-log art', () => {
  const vm = newVM({ before: NATIVE_TEMPLATES + '\nfunction GetBuildInfo() return "1.15.9", "70003", "Sep 1 2026", 11509, "", " " end' });
  open(vm);
  vm.run('ClaudeWoW.Render()');
  assert.equal(vm.evaluate('ClaudeWoW.UI.art.parchment'), 'QuestBG-Parchment');
  assert.equal(vm.evaluate('ClaudeWoW.UI.art.gear'), 'questlog-icon-setting');
  assert.equal(vm.evaluate('ClaudeWoW.UI.art.filigree'), null, 'no frame edge, so no filigree on top of it');
  for (const key of ['listBg', 'frame', 'header', 'poi', 'rowGlow']) {
    assert.equal(vm.evaluate(`ClaudeWoW.UI.art.${key}`), 'false', `${key} is not drawn on Era`);
  }
});

test('the window is built from Blizzard frame templates where the client has them: portrait, title bar, close button, parchment and a quest-log chat list', () => {
  const vm = nativeVM();
  assert.equal(vm.evaluate('ClaudeWoWFrame.template'), 'ButtonFrameTemplate');
  assert.equal(vm.evaluate('ClaudeWoWFrame.portrait'), 'Interface\\AddOns\\ClaudeWoW\\Portrait');
  assert.equal(vm.evaluate('ClaudeWoWFrame.Inset.shown'), 'false', 'the template inset is replaced by our own panels');
  assert.equal(vm.evaluate('ClaudeWoW.UI.title == ClaudeWoWFrame.TitleText'), 'true', 'the title goes in the Blizzard title bar');
  assert.equal(vm.evaluate('ClaudeWoW.UI.minimize == ClaudeWoWFrame.CloseButton'), 'true', 'the red close button collapses to the bar');
  assert.equal(vm.evaluate('ClaudeWoW.UI.art.listBg'), 'QuestLog-main-background');
  assert.equal(vm.evaluate('ClaudeWoW.UI.art.parchment'), 'QuestBG-Parchment', 'the transcript sits on quest parchment');
  assert.equal(vm.evaluate('ClaudeWoWScroll.parent == ClaudeWoW.UI.parchment'), 'true');
  assert.equal(vm.evaluate('ClaudeWoWChatSearch.template'), 'SearchBoxTemplate');
  assert.equal(vm.evaluate('ClaudeWoWScroll.template'), 'ScrollFrameTemplate', 'the transcript uses the thin Blizzard scroll bar');
  assert.equal(vm.evaluate('ClaudeWoWInputScroll.template'), null, 'the input box has no arrow scroll bar');
  assert.equal(vm.evaluate('ClaudeWoWInput.scripts.OnCursorChanged == ScrollingEdit_OnCursorChanged'), 'true', 'it follows the cursor the Blizzard way');
  assert.equal(vm.evaluate('ClaudeWoW.UI.cwd.shown'), 'false', 'the breadcrumbs replace the cwd footer');
  assert.equal(vm.evaluate('ClaudeWoWWindow.skinned'), 'true');
  assert.equal(vm.evaluate('ClaudeWoWFrame.claudewowBorder'), null, 'no extra border on top of the template');

  assert.equal(shownHeaders(vm), 'every|wow-ai', 'chats are grouped under folder headers in first-seen order');
  assert.equal(vm.evaluate('ClaudeWoW.UI.chatCount:GetText()'), 'Chats: |cffffffff3|r');
  assert.equal(vm.evaluate('ClaudeWoW.UI.art.frame'), 'questlog-frame');
  assert.equal(vm.evaluate('ClaudeWoW.UI.art.filigree'), 'questlog-frame-filigree');
  assert.equal(vm.evaluate('ClaudeWoW.UI.art.poi'), 'UI-QuestPoi-QuestNumber', 'each chat has a round POI button');
  assert.equal(vm.evaluate('ClaudeWoW.UI.questList.rows[1].objectives[1].text:GetText()'), 'No messages yet', 'objective lines sit under each title');
  assert.equal(vm.evaluate('ClaudeWoW.UI.art.minus'), 'common-button-list-minus');

  vm.run('ClaudeWoW.UI.questList.headers[1].scripts.OnClick(ClaudeWoW.UI.questList.headers[1])');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.collapsedFolders.every'), 'true');
  assert.equal(shownRows(vm), 'Fix the bridge', 'a collapsed folder hides its chats');
  assert.equal(vm.evaluate('ClaudeWoW.UI.art.plus'), 'common-button-list-plus');
  vm.run('ClaudeWoW.UI.questList.headers[1].scripts.OnClick(ClaudeWoW.UI.questList.headers[1])');

  vm.run('ClaudeWoWChatSearch:SetText("leather"); for _, fn in ipairs(ClaudeWoWChatSearch.hooks.OnTextChanged) do fn(ClaudeWoWChatSearch) end');
  assert.equal(shownRows(vm), 'Leatherworking route', 'search filters by chat name');
  assert.equal(shownHeaders(vm), 'every');
  vm.run('ClaudeWoWChatSearch:SetText("zzz"); for _, fn in ipairs(ClaudeWoWChatSearch.hooks.OnTextChanged) do fn(ClaudeWoWChatSearch) end');
  assert.equal(vm.evaluate('ClaudeWoW.UI.questList.empty.shown'), 'true');
  vm.run('ClaudeWoWChatSearch:SetText(""); for _, fn in ipairs(ClaudeWoWChatSearch.hooks.OnTextChanged) do fn(ClaudeWoWChatSearch) end');

  vm.run('ClaudeWoWDB.chats[2].unread = 1; ClaudeWoW.Render()');
  vm.run('ClaudeWoWChatSettings.scripts.OnClick(ClaudeWoWChatSettings); STUB.Pick("Show message previews")');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.chatPreviews'), 'false', 'the gear menu turns message previews off');
  assert.equal(vm.evaluate('ClaudeWoW.UI.questList.rows[1].objectives[1].text.shown'), 'false');
  vm.run('ClaudeWoWChatSettings.scripts.OnClick(ClaudeWoWChatSettings); STUB.Pick("Show message previews")');
  vm.run('ClaudeWoWChatSettings.scripts.OnClick(ClaudeWoWChatSettings); STUB.Pick("Collapse all folders")');
  assert.equal(shownRows(vm), '', 'collapse all hides every chat');
  vm.run('ClaudeWoWChatSettings.scripts.OnClick(ClaudeWoWChatSettings); STUB.Pick("Expand all folders")');
  assert.equal(vm.evaluate('ClaudeWoW.UI.art.reply'), 'UI-QuestIcon-TurnIn-Normal', 'an unread reply shows the turn-in icon');

  vm.run('ClaudeWoWFrame.CloseButton.scripts.OnClick(ClaudeWoWFrame.CloseButton)');
  assert.equal(vm.evaluate('ClaudeWoWFrame.shown'), 'false');
  assert.equal(vm.evaluate('ClaudeWoWMini.shown'), 'true');
});

test('the black bar shows the chat title across its whole width, with folder, agent and plugin in its tooltip', () => {
  const vm = nativeVM();
  vm.run('ClaudeWoW.SwitchChat(ClaudeWoWDB.chats[2].id)');
  assert.equal(vm.evaluate('ClaudeWoW.UI.chatTitle:GetText()'), 'Fix the bridge');
  assert.equal(vm.evaluate('ClaudeWoWFrame.TitleText:GetText()'), 'Claude WoW', 'the window title does not repeat the chat title');
  assert.equal(vm.num('#STUB.nav.buttons'), 0, 'no folder, agent or plugin crumbs');
  assert.equal(vm.evaluate('STUB.nav.home'), null);

  vm.run('ClaudeWoWDB.chats[2].name = "Renamed"; ClaudeWoW.Render()');
  assert.equal(vm.evaluate('ClaudeWoW.UI.chatTitle:GetText()'), 'Renamed', 'the bar follows a rename');

  vm.run('LINES = {}; GameTooltip.AddDoubleLine = function(_, a, b) table.insert(LINES, a .. "=" .. b) end');
  vm.run('ClaudeWoWTitleBar.scripts.OnEnter(ClaudeWoWTitleBar)');
  assert.equal(vm.evaluate('table.concat(LINES, "|")'), 'Folder=wow-ai|Agent=AI|Plugin=default');

  vm.run('CALLS = {}; ClaudeWoW.RenamePrompt = function(id) table.insert(CALLS, "rename:" .. id) end; ClaudeWoW.ShowChatMenu = function(id) table.insert(CALLS, "menu:" .. id) end');
  vm.run('ClaudeWoWTitleBar.scripts.OnClick(ClaudeWoWTitleBar, "LeftButton"); ClaudeWoWTitleBar.scripts.OnClick(ClaudeWoWTitleBar, "RightButton")');
  const id = vm.evaluate('ClaudeWoWDB.chats[2].id');
  assert.equal(vm.evaluate('table.concat(CALLS, "|")'), `rename:${id}|menu:${id}`);
});

test('help lives in the gear menu, and Clear moves from the bottom bar into the chat menu', () => {
  const vm = nativeVM();
  const active = '(function() for _, c in ipairs(ClaudeWoWDB.chats) do if c.id == ClaudeWoWDB.activeChat then return c end end end)()';
  vm.run('ClaudeWoWChatSettings.scripts.OnClick(ClaudeWoWChatSettings); STUB.Pick("Commands and tips")');
  assert.ok(vm.evaluate(`${active}.history[#${active}.history].text`).includes('/claude'));
  assert.equal(vm.evaluate('ClaudeWoWHelpButton'), null, 'no help button crowds the breadcrumb bar');

  const clearButton = '(function() for _, c in ipairs(ClaudeWoWFrame.children) do if c.kind == "Button" and c.text == "Clear" then return c end end end)()';
  assert.equal(vm.evaluate(`${clearButton}.shown`), 'false', 'no Clear button in the bottom bar');
  vm.run(`ClaudeWoW.ShowChatMenu(ClaudeWoWDB.activeChat, ClaudeWoWFrame); STUB.Pick("Clear messages")`);
  assert.equal(vm.num(`#${active}.history`), 0, 'the chat menu clears the chat');
});

test('the footer is a short state on the left and context and spend on the right, with the detail on hover', () => {
  const vm = nativeVM();
  vm.run('ClaudeWoWDB.chats[1].cost = 2.414; ClaudeWoWDB.chats[1].ctx = 186700; ClaudeWoWDB.chats[2].cost = 12.39; ClaudeWoW.SwitchChat(ClaudeWoWDB.chats[1].id); ClaudeWoW.Render()');
  const stats = vm.evaluate('ClaudeWoW.UI.stats:GetText()');
  assert.ok(stats.includes('UI-GoldIcon'), stats);
  assert.ok(stats.includes('$2.41'), 'this chat\'s spend: ' + stats);
  assert.ok(stats.includes('all chats $14.80'), 'and the total across chats: ' + stats);
  assert.equal(vm.evaluate('ClaudeWoWContextBar.shown'), 'true', 'the context is a bar');
  assert.ok(vm.evaluate('ClaudeWoWContextBar.text:GetText()').startsWith('186.7k / 200'), vm.evaluate('ClaudeWoWContextBar.text:GetText()'));
  const color = () => vm.evaluate('(function() return string.format("%.2f,%.2f", ClaudeWoWContextBar.color[1], ClaudeWoWContextBar.color[2]) end)()');
  assert.equal(color(), '0.85,0.10', '93% full is red');
  vm.run('ClaudeWoWDB.chats[1].ctx = 80000; ClaudeWoW.UpdateStatus()');
  assert.equal(color(), '0.10,0.75', '40% is green');
  vm.run('ClaudeWoWDB.chats[1].ctx = 130000; ClaudeWoW.UpdateStatus()');
  assert.equal(color(), '1.00,0.82', '65% is yellow');
  vm.run('ClaudeWoWDB.chats[1].ctx = 170000; ClaudeWoW.UpdateStatus()');
  assert.equal(color(), '1.00,0.50', '85% is orange');
  vm.run('ClaudeWoWDB.chats[1].window = 1000000; ClaudeWoW.UpdateStatus()');
  assert.equal(color(), '0.10,0.75', 'measured against the model window when the agent reports one');
  vm.run('ClaudeWoWDB.chats[1].ctx = nil; ClaudeWoW.UpdateStatus()');
  assert.equal(vm.evaluate('ClaudeWoWContextBar.shown'), 'false', 'no bar without a context size');

  vm.run('ClaudeWoWDB.chats[1].pendingId = 159; ClaudeWoW.UpdateStatus()');
  const status = vm.evaluate('ClaudeWoW.UI.status:GetText()');
  assert.ok(status.includes('Working') && !status.includes('#159'), 'a short state, not the full line: ' + status);
  assert.ok(vm.evaluate('ClaudeWoW.UI.cwd.shown') === 'false');
});

test('without the templates the window keeps its own backdrop', () => {
  const vm = newVM();
  open(vm);
  assert.equal(vm.evaluate('ClaudeWoWFrame.template'), 'BackdropTemplate');
  assert.equal(vm.evaluate('ClaudeWoW.UI.transcriptPanel'), null);
});
