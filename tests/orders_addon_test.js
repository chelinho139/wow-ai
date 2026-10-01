'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');
const G = require('../bridge/goals');

const ADDON = path.join(__dirname, '..', 'addon', 'ClaudeWoW');
const ADDON_FILES = ['Codec.lua', 'Inbox.lua', 'ClaudeWoW.lua', 'Orders.lua'];
const CHAR = 'Testchar-TestRealm';

const STATUSBAR_STUB = `
do
  local probe = CreateFrame("Frame")
  local mt = getmetatable(probe)
  local base = mt.__index
  mt.__index = function(t, k)
    if k == "SetValue" then return function(self, v) if STUB.failBar then error("bar broke") end self.value = v end end
    if k == "SetHighlightAtlas" then return function(self, name) self.highlightAtlas = name end end
    return base(t, k)
  end
end
`;

const LOAD_COUNTER_STUB = `
STUB.loads = 0
local plainLoad = C_AddOns.LoadAddOn
C_AddOns.LoadAddOn = function(name)
  STUB.loads = STUB.loads + 1
  return plainLoad(name)
end
`;

const SPIES = `
STUB.syncs, STUB.printed = 0, {}
local plainSync = ClaudeWoWOrders.Sync
ClaudeWoWOrders.Sync = function(...)
  STUB.syncs = STUB.syncs + 1
  return plainSync(...)
end
local plainPrint = ClaudeWoW.Print
ClaudeWoW.Print = function(msg, tag)
  table.insert(STUB.printed, msg)
  return plainPrint(msg, tag)
end
`;

const NATIVE_TEMPLATES_STUB = `
C_XMLUtil = { GetTemplateInfo = function(name)
  if name == "ObjectiveTrackerModuleHeaderTemplate" or name == "ObjectiveTrackerProgressBarTemplate" then return { type = "Frame" } end
end }
local plainCreateFrame = CreateFrame
function CreateFrame(kind, name, parent, template)
  local f = plainCreateFrame(kind, name, parent, template)
  if template == "ObjectiveTrackerModuleHeaderTemplate" and not STUB.brokenTemplates then
    f.Text = f:CreateFontString(nil, "ARTWORK", "ObjectiveTrackerHeaderFont")
    f.MinimizeButton = plainCreateFrame("Button", nil, f)
  elseif template == "ObjectiveTrackerProgressBarTemplate" and not STUB.brokenTemplates then
    f.Bar = plainCreateFrame("StatusBar", nil, f)
    f.Bar.mouseEnabled = true
    f.Bar.Label = f.Bar:CreateFontString(nil, "ARTWORK", "GameFontHighlightMedium")
  end
  return f
end
`;

const FAILING_CARD_STUB = `
STUB.failCard = true
local plainCreateFrame = CreateFrame
function CreateFrame(kind, name, ...)
  if name == "ClaudeWoWOrdersCard" and STUB.failCard then error("no frame today") end
  return plainCreateFrame(kind, name, ...)
end
`;

const TRACKER_STUB = `
ObjectiveTrackerFrame = CreateFrame("Frame", "ObjectiveTrackerFrame", UIParent)
ObjectiveTrackerFrame:SetSize(260, 800)
ObjectiveTrackerFrame:SetPoint("TOPRIGHT", UIParent, "TOPRIGHT", -85, -200)
ObjectiveTrackerFrame.NineSlice = CreateFrame("Frame", nil, ObjectiveTrackerFrame)
`;

const PET_VEHICLE_STUB = `
C_PetBattles = { IsInBattle = function() return STUB.petBattle == true end }
function UnitHasVehicleUI(unit) return unit == "player" and STUB.vehicle == true end
`;

function newVM({ prelude = '', beforeLogin = '' } = {}) {
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
  run(fs.readFileSync(path.join(__dirname, 'wow_stub.lua'), 'utf8'));
  run(STATUSBAR_STUB);
  run(LOAD_COUNTER_STUB);
  if (prelude) run(prelude);
  for (const f of ADDON_FILES) run(fs.readFileSync(path.join(ADDON, f), 'utf8'), 'ClaudeWoW');
  run(SPIES);
  run('STUB.FireEvent("ADDON_LOADED", "ClaudeWoW")');
  if (beforeLogin) run(beforeLogin);
  run('STUB.FireEvent("PLAYER_LOGIN")');
  run('STUB.RunTimers()');
  return { run, evaluate, num: expr => Number(evaluate(expr)) };
}

function nextSlot(vm, goalsLua, repliesLua = '', nowLua = 'time()') {
  const goals = goalsLua ? `, goals = ${goalsLua}` : '';
  vm.run(`STUB.onLoadAddOn = function(name) ClaudeWoW_SlotData = { now = ${nowLua}, cwd = "", plugin = "ask", plugins = { "ask" }, replies = { ${repliesLua} }${goals} } end`);
}

function tick(vm, seconds = 6) {
  vm.run(`STUB.now = STUB.now + ${seconds}; STUB.Tick()`);
}

const ORDER_GOALS = (rev, text = 'Craft until Leatherworking hits 125', pct = 71, char = CHAR) =>
  `{ rev = ${rev}, char = "${char}", order = { id = "o_${rev}", text = "${text}", pct = ${pct} }, goals = { { title = "Skinning 225", pct = 83 }, { title = "Cooking 75", pct = 14 } } }`;

function shownBars(vm) {
  return vm.num('(function() local n = 0 for _, b in ipairs(ClaudeWoWOrdersCard.bars) do if b.shown then n = n + 1 end end return n end)()');
}

function scenario(vm, slots) {
  for (const s of slots) {
    nextSlot(vm, s);
    tick(vm);
  }
}

function pending(vm) {
  vm.run('PENDING_CHAT, PENDING_ID = nil, nil; for _, c in ipairs(ClaudeWoWDB.chats) do if c.pendingId then PENDING_CHAT, PENDING_ID = c.id, c.pendingId end end');
  return { chat: vm.evaluate('PENDING_CHAT'), id: vm.evaluate('PENDING_ID') };
}

function cardShown(vm) {
  return vm.evaluate('ClaudeWoWOrdersCard ~= nil and ClaudeWoWOrdersCard.shown == true') === 'true';
}

test('orders card: appears after the natural hello slot load that carries goals, laid out like the quest tracker', () => {
  const vm = newVM();
  nextSlot(vm, ORDER_GOALS(5));
  assert.equal(vm.evaluate('ClaudeWoWOrdersCard'), null, 'nothing before a slot is read');
  tick(vm);
  assert.ok(vm.num('STUB.loads') >= 1, 'the login slot reads');
  assert.equal(vm.evaluate('ClaudeWoW.IsConnected()'), 'true');
  assert.equal(vm.evaluate('ClaudeWoWOrdersCard.shown'), 'true');
  assert.equal(vm.evaluate('ClaudeWoWOrdersCard.header.Text.text'), 'Orders');
  assert.equal(vm.evaluate('ClaudeWoWOrdersCard.orderText.text'), 'Craft until Leatherworking hits 125');
  assert.equal(vm.evaluate('ClaudeWoWOrdersCard.bars[1].Bar.value'), '71');
  assert.equal(vm.evaluate('ClaudeWoWOrdersCard.bars[1].Bar.Label.text'), '71%');
  assert.equal(vm.evaluate('ClaudeWoWOrdersCard.goalLines[1].text'), '- Skinning 225');
  assert.equal(vm.evaluate('ClaudeWoWOrdersCard.goalLines[2].text'), '- Cooking 75');
  assert.equal(vm.evaluate('ClaudeWoWOrdersCard.goalLines[3].shown'), 'false');
  assert.equal(vm.evaluate('ClaudeWoWOrdersCard.bars[3].Bar.value'), '14');
  assert.equal(shownBars(vm), 3, 'the order bar and one bar per goal');
  assert.equal(vm.evaluate('ClaudeWoWOrders.debug.anchoredTo'), 'screen', 'no quest tracker frame in this client: the tracker spot on screen');
  assert.equal(vm.num('ClaudeWoWOrders.debug.renders'), 1);
  assert.equal(vm.evaluate('ClaudeWoWOrdersCard.bars[1].Bar.mouseEnabled'), 'false', 'the bars never eat clicks');
});

test('orders card: the addon builds the same character key as the bridge, two-part Forever names included', () => {
  const vm = newVM();
  assert.equal(vm.evaluate('ClaudeWoWOrders.CharacterKey()'), G.characterOf('Character: Testchar on Test Realm, level 23').key);
  vm.run('function UnitName(unit) return "Bone" end; function GetUnitName(unit, withRealm) return "Bone Sleeve" end; function GetRealmName() return "Classic Beta PvP 2" end');
  assert.equal(vm.evaluate('ClaudeWoWOrders.CharacterKey()'), G.characterOf('Character: Bone on Classic Beta PvP 2, level 20 Orc Rogue (Horde)').key, 'UnitName, the first part of a Forever name, as the context line uses');
  assert.equal(vm.evaluate('ClaudeWoWOrders.CharacterKey()'), 'Bone-ClassicBetaPvP2');
});

test('orders card: a change redraws on the next natural slot load; the same visible data does not, even with a new rev', () => {
  const vm = newVM();
  scenario(vm, [ORDER_GOALS(5)]);
  const atLogin = vm.num('STUB.loads');
  vm.run('ClaudeWoW.Send("how is my leatherworking")');
  scenario(vm, [ORDER_GOALS(6, 'Skin 30 more', 40)]);
  assert.equal(vm.num('STUB.loads'), atLogin + 1, 'the scheduled poll after the message, nothing more');
  assert.equal(vm.evaluate('ClaudeWoWOrdersCard.orderText.text'), 'Skin 30 more');
  assert.equal(vm.evaluate('ClaudeWoWOrdersCard.bars[1].Bar.Label.text'), '40%');
  assert.equal(vm.num('ClaudeWoWOrders.debug.renders'), 2);
  vm.run('ClaudeWoWOrdersCard.orderText.text = "untouched"');
  scenario(vm, [ORDER_GOALS(6, 'Skin 30 more', 40)]);
  assert.equal(vm.num('STUB.loads'), atLogin + 2);
  assert.equal(vm.num('ClaudeWoWOrders.debug.renders'), 2, 'unchanged data: no redraw');
  assert.equal(vm.evaluate('ClaudeWoWOrdersCard.orderText.text'), 'untouched');
  scenario(vm, [ORDER_GOALS(6, 'Skin 30 more', 40).replace('rev = 6', 'rev = 7')]);
  assert.equal(vm.num('ClaudeWoWOrders.debug.renders'), 2, 'a new rev with nothing visible changed: no redraw');
  scenario(vm, [ORDER_GOALS(6, 'Skin 30 more', 41)]);
  assert.equal(vm.num('ClaudeWoWOrders.debug.renders'), 3, 'progress moved: one redraw');
});

test('orders card: hides when the order clears; a slot without the field is read and changes nothing', () => {
  const vm = newVM();
  scenario(vm, [ORDER_GOALS(5)]);
  assert.equal(cardShown(vm), true);
  const syncs = vm.num('STUB.syncs');
  const loads = vm.num('STUB.loads');
  sendAndRead(vm, null, 'thanks');
  assert.equal(vm.num('STUB.loads'), loads + 1, 'a slot was read');
  assert.equal(vm.num('STUB.syncs'), syncs, 'and the card was not even asked');
  assert.equal(cardShown(vm), true);
  vm.run('STUB.failBar = true');
  sendAndRead(vm, ORDER_GOALS(6, 'Skin 30 more', 40), 'fails');
  assert.notEqual(vm.evaluate('ClaudeWoWOrders.debug.lastError'), null, 'a draw failed first');
  vm.run('STUB.failBar = false');
  sendAndRead(vm, `{ rev = 7, char = "${CHAR}", goals = { { title = "Skinning 225", pct = 83 } } }`, 'clear');
  assert.equal(cardShown(vm), false, 'no order: the card hides even with goals');
  assert.equal(vm.evaluate('ClaudeWoWOrders.debug.lastError'), null, 'hidden on purpose, not by an error');
});

test('orders card: an old bridge never sends goals, so there is no card and no error', () => {
  const vm = newVM();
  scenario(vm, [null]);
  assert.ok(vm.num('STUB.loads') >= 1, 'slots were read');
  assert.equal(vm.evaluate('ClaudeWoW.IsConnected()'), 'true');
  assert.equal(vm.num('STUB.syncs'), 0);
  assert.equal(vm.evaluate('ClaudeWoWOrdersCard'), null);
  assert.equal(vm.num('ClaudeWoWOrders.debug.renders'), 0);
});

test('orders card: no extra slot load, the same count as a session without goals over a long stretch', () => {
  const run = (goals) => {
    const vm = newVM();
    nextSlot(vm, goals ? ORDER_GOALS(5) : null);
    tick(vm);
    vm.run('ClaudeWoW.Send("one")');
    nextSlot(vm, goals ? ORDER_GOALS(6, 'Skin 30 more', 40) : null);
    for (let i = 0; i < 400; i++) tick(vm, 9);
    return { loads: vm.num('STUB.loads'), card: vm.evaluate('ClaudeWoWOrdersCard and ClaudeWoWOrdersCard.orderText.text') };
  };
  const control = run(false);
  const withCard = run(true);
  assert.equal(withCard.card, 'Skin 30 more', 'the card did update during the stretch');
  assert.ok(control.loads > 1, `the control loaded ${control.loads} slots`);
  assert.equal(withCard.loads, control.loads, 'the card never asks for a slot of its own');
});

test('orders card: the reload path shows a fresh order for this character from Inbox.lua without any slot load', () => {
  const vm = newVM({ beforeLogin: `ClaudeWoW_Inbox = { now = time(), replies = {}, goals = ${ORDER_GOALS(3, 'Rest')} }` });
  assert.equal(vm.num('STUB.loads'), 0, 'no LoadAddOn at all');
  assert.equal(vm.num('STUB.syncs'), 1);
  assert.equal(cardShown(vm), true);
  assert.equal(vm.evaluate('ClaudeWoWOrdersCard.orderText.text'), 'Rest');
});

test('orders card: an Inbox.lua order that is old, for another character, or unlabelled stays hidden', () => {
  const cases = [
    ['old', `{ now = time() - 3600, replies = {}, goals = ${ORDER_GOALS(3, 'Rest')} }`],
    ['another character', `{ now = time(), replies = {}, goals = ${ORDER_GOALS(3, 'Rest', 71, 'Bone-ClassicBetaPvP2')} }`],
    ['no clock', `{ replies = {}, goals = ${ORDER_GOALS(3, 'Rest')} }`],
    ['the client cannot name its own character', `{ now = time(), replies = {}, goals = ${ORDER_GOALS(3, 'Rest')} }`, 'function UnitName() return nil end'],
  ];
  for (const [why, inbox, extra = ''] of cases) {
    const vm = newVM({ beforeLogin: `${extra}\nClaudeWoW_Inbox = ${inbox}` });
    assert.equal(vm.num('STUB.syncs'), 1, `${why}: the field was read`);
    assert.equal(cardShown(vm), false, `${why}: no card`);
  }
  const fresh = newVM({ beforeLogin: `ClaudeWoW_Inbox = { now = time() - 120, replies = {}, goals = ${ORDER_GOALS(3, 'Rest')} }` });
  assert.equal(cardShown(fresh), true, 'two minutes old is still live');
});

test('orders card: a drawing error never stops the slot read, is said once, and the same data is tried again', () => {
  const vm = newVM({ prelude: FAILING_CARD_STUB });
  scenario(vm, [null]);
  vm.run('ClaudeWoW.Send("first")');
  let p = pending(vm);
  assert.ok(p.id, 'a message is waiting');
  nextSlot(vm, ORDER_GOALS(5), `{ chat = "${p.chat}", id = ${p.id}, status = "done", text = "the reply", agent = "", plugin = "ask" }`);
  tick(vm);
  assert.equal(pending(vm).id, null, 'the reply in the same slot still landed');
  assert.equal(vm.evaluate('ClaudeWoWOrdersCard'), null);
  vm.run('ClaudeWoW.Send("second")');
  p = pending(vm);
  nextSlot(vm, ORDER_GOALS(5), `{ chat = "${p.chat}", id = ${p.id}, status = "done", text = "again", agent = "", plugin = "ask" }`);
  tick(vm);
  vm.run('RESULT = 0; for _, m in ipairs(STUB.printed) do if m:find("could not be drawn", 1, true) then RESULT = RESULT + 1 end end');
  assert.equal(vm.num('RESULT'), 1, 'the error is said once');
  vm.run('STUB.failCard = false; ClaudeWoW.Send("third")');
  p = pending(vm);
  nextSlot(vm, ORDER_GOALS(5), `{ chat = "${p.chat}", id = ${p.id}, status = "done", text = "ok", agent = "", plugin = "ask" }`);
  tick(vm);
  assert.equal(cardShown(vm), true, 'the same data drew once it could');
});

function sendAndRead(vm, goalsLua, text) {
  vm.run(`ClaudeWoW.Send("${text}")`);
  const p = pending(vm);
  nextSlot(vm, goalsLua, `{ chat = "${p.chat}", id = ${p.id}, status = "done", text = "ok", agent = "", plugin = "ask" }`);
  tick(vm);
}

function drawErrorsSaid(vm) {
  vm.run('RESULT = 0; for _, m in ipairs(STUB.printed) do if m:find("could not be drawn", 1, true) then RESULT = RESULT + 1 end end');
  return vm.num('RESULT');
}

test('orders card: a shown card that fails mid-draw is hidden, not left half drawn; a later error is said again', () => {
  const vm = newVM();
  scenario(vm, [ORDER_GOALS(5)]);
  assert.equal(cardShown(vm), true);
  vm.run('STUB.failBar = true');
  sendAndRead(vm, ORDER_GOALS(6, 'Skin 30 more', 40), 'one');
  assert.equal(cardShown(vm), false, 'no half-drawn card with the new text and the old bars');
  assert.equal(drawErrorsSaid(vm), 1);
  vm.run('STUB.failBar = false; ClaudeWoWOrders.Refresh()');
  assert.equal(cardShown(vm), false, 'a later refresh does not bring back the old order');
  sendAndRead(vm, ORDER_GOALS(5), 'back');
  assert.equal(cardShown(vm), true, 'the old data draws again: a failed sync forgot what was on screen');
  assert.equal(vm.evaluate('ClaudeWoWOrdersCard.orderText.text'), 'Craft until Leatherworking hits 125');
  sendAndRead(vm, ORDER_GOALS(6, 'Skin 30 more', 40), 'two');
  assert.equal(cardShown(vm), true, 'the same data draws once it can');
  assert.equal(vm.evaluate('ClaudeWoWOrdersCard.orderText.text'), 'Skin 30 more');
  assert.equal(vm.evaluate('ClaudeWoWOrders.debug.lastError'), null, 'a good draw clears the last error');
  vm.run('STUB.failBar = true');
  sendAndRead(vm, ORDER_GOALS(7, 'Fish 10', 20), 'three');
  assert.equal(cardShown(vm), false);
  assert.equal(drawErrorsSaid(vm), 2, 'the same error after a good draw is said again');
});

test('orders card: a refresh that fails hides the card but keeps the order, so the next toggle can draw it', () => {
  const vm = newVM();
  scenario(vm, [ORDER_GOALS(5)]);
  vm.run('STUB.failBar = true; ClaudeWoWOrders.ToggleCollapsed(); ClaudeWoWOrders.ToggleCollapsed()');
  assert.equal(cardShown(vm), false);
  vm.run('STUB.failBar = false; ClaudeWoWOrders.ToggleCollapsed(); ClaudeWoWOrders.ToggleCollapsed()');
  assert.equal(cardShown(vm), true, 'no slot read needed');
  assert.equal(vm.evaluate('ClaudeWoWOrders.debug.lastError'), null, 'the good draw cleared the error');
  assert.equal(vm.evaluate('ClaudeWoWOrdersCard.orderText.text'), 'Craft until Leatherworking hits 125');
  sendAndRead(vm, ORDER_GOALS(5), 'settle');
  vm.run('STUB.failBar = true; ClaudeWoWOrders.ToggleCollapsed(); ClaudeWoWOrders.ToggleCollapsed(); STUB.failBar = false');
  assert.equal(cardShown(vm), false);
  sendAndRead(vm, ORDER_GOALS(5), 'same again');
  assert.equal(cardShown(vm), true, 'a failed refresh forgets the signature, so the same slot data draws again');
});

test('orders card: a draw error that keeps failing is said once across vehicle and pet battle cycles', () => {
  const vm = newVM({ prelude: PET_VEHICLE_STUB });
  scenario(vm, [ORDER_GOALS(5)]);
  vm.run('STUB.failBar = true');
  for (let i = 0; i < 5; i++) {
    vm.run('STUB.vehicle = true; STUB.FireEvent("UNIT_ENTERED_VEHICLE", "player")');
    vm.run('STUB.vehicle = false; STUB.FireEvent("UNIT_EXITED_VEHICLE", "player")');
    vm.run('STUB.petBattle = true; STUB.FireEvent("PET_BATTLE_OPENING_START")');
    vm.run('STUB.petBattle = false; STUB.FireEvent("PET_BATTLE_CLOSE")');
  }
  assert.equal(cardShown(vm), false);
  assert.equal(drawErrorsSaid(vm), 1);
  vm.run('SlashCmdList.CLAUDE("orders on")');
  assert.equal(drawErrorsSaid(vm), 2, 'an explicit /claude orders on says the error again');
});

test('orders card: a build that fails after the card frame exists never builds a second frame', () => {
  const vm = newVM({ prelude: `
STUB.cardFrames, STUB.failInside = 0, true
local plainCreateFrame = CreateFrame
function CreateFrame(kind, name, parent, ...)
  if name == "ClaudeWoWOrdersCard" then STUB.cardFrames = STUB.cardFrames + 1 end
  if STUB.failInside and parent ~= nil and parent == _G.ClaudeWoWOrdersCard then error("no parts today") end
  return plainCreateFrame(kind, name, parent, ...)
end` });
  scenario(vm, [null]);
  sendAndRead(vm, ORDER_GOALS(5), 'one');
  sendAndRead(vm, ORDER_GOALS(5), 'two');
  sendAndRead(vm, ORDER_GOALS(6, 'Rest'), 'three');
  assert.equal(vm.num('STUB.cardFrames'), 1, 'one named frame for the whole session');
  assert.equal(cardShown(vm), false);
  assert.equal(drawErrorsSaid(vm), 1, 'the build error, said once, not a new error per read');
  assert.match(vm.evaluate('ClaudeWoWOrders.debug.lastError'), /no parts today/);
});

test('orders card: an old slot file left by a stopped bridge never brings back an order Inbox.lua already hid', () => {
  const old = ORDER_GOALS(3, 'Rest');
  const vm = newVM({ beforeLogin: `ClaudeWoW_Inbox = { now = time() - 3600, replies = {}, goals = ${old} }` });
  assert.equal(cardShown(vm), false);
  nextSlot(vm, old, '', 'time() - 3600');
  tick(vm, 9);
  assert.ok(vm.num('STUB.loads') >= 1, 'the hello slot was read');
  assert.equal(cardShown(vm), false);
});

test('orders card: an old slot file leaves a shown card as it is, neither hiding nor changing it', () => {
  const vm = newVM();
  scenario(vm, [ORDER_GOALS(5)]);
  vm.run('ClaudeWoW.Send("later")');
  nextSlot(vm, ORDER_GOALS(6, 'Skin 30 more', 40), '', 'time() - 1000');
  tick(vm);
  assert.equal(cardShown(vm), true);
  assert.equal(vm.evaluate('ClaudeWoWOrdersCard.orderText.text'), 'Craft until Leatherworking hits 125');
});

function inboxFor(name, realm, char) {
  return newVM({ beforeLogin: `function UnitName() return "${name}" end; function GetRealmName() return "${realm}" end
ClaudeWoW_Inbox = { now = time(), replies = {}, goals = ${ORDER_GOALS(3, 'Rest', 71, char)} }` });
}

test('orders card: non-Latin names stay distinct and match the bridge key; an accented realm matches', () => {
  const ivan = G.characterOf('Character: Иван on Гордунни, level 20').key;
  assert.equal(cardShown(inboxFor('Иван', 'Гордунни', ivan)), true, 'a Cyrillic name matches the bridge key for the same character');
  assert.equal(cardShown(inboxFor('Пётр', 'Гордунни', ivan)), false, 'another Cyrillic name on the same realm does not');
  const zul = G.characterOf('Character: Bone on Zùl Grim, level 20').key;
  assert.equal(cardShown(inboxFor('Bone', 'Zùl Grim', zul)), true);
  assert.equal(cardShown(inboxFor('Bone', 'Zul Grim', zul)), false, 'an accent is not dropped');
  const dot = G.characterOf('Character: Bone on Foo·Bar, level 20').key;
  assert.equal(cardShown(inboxFor('Bone', 'Foo·Bar', dot)), false, 'a symbol the bridge drops never matches: the documented limit, hidden is the safe side');
  assert.equal(inboxFor('·', 'Foo', 'x').evaluate('ClaudeWoWOrders.CharacterKey()'), '·-Foo', 'a name that is only a non-ASCII symbol keeps its bytes');
  assert.equal(inboxFor('!!', 'Foo', 'x').evaluate('ClaudeWoWOrders.CharacterKey()'), null, 'an empty name after cleaning is refused');
});

test('orders card: /claude orders off hides it and keeps it hidden through new data, on brings it back; settings stay two booleans', () => {
  const vm = newVM();
  scenario(vm, [ORDER_GOALS(5)]);
  vm.run('SlashCmdList.CLAUDE("orders off")');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.ordersCard'), 'false');
  assert.equal(cardShown(vm), false);
  vm.run('ClaudeWoW.Send("next")');
  scenario(vm, [ORDER_GOALS(6, 'Skin 30 more')]);
  assert.equal(cardShown(vm), false, 'off stays off when a new order arrives');
  vm.run('SlashCmdList.CLAUDE("config orders on")');
  assert.equal(cardShown(vm), true);
  assert.equal(vm.evaluate('ClaudeWoWOrdersCard.orderText.text'), 'Skin 30 more', 'the latest order, kept while hidden');
  vm.run('ClaudeWoWOrders.Toggle()');
  assert.equal(cardShown(vm), false, 'the gear menu checkbox toggles the same setting');
  vm.run('ClaudeWoWOrders.Toggle()');
  vm.run('ClaudeWoWOrdersCard.header.MinimizeButton.scripts.OnClick(ClaudeWoWOrdersCard.header.MinimizeButton)');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.ordersCollapsed'), 'true');
  assert.equal(shownBars(vm), 0, 'collapsed: only the header');
  assert.equal(vm.num('ClaudeWoWOrdersCard.height'), 26);
  assert.equal(vm.evaluate('ClaudeWoWOrders.debug.buttonArt'), 'ui-questtrackerbutton-secondary-expand');
  vm.run('ClaudeWoWOrdersCard.header.MinimizeButton.scripts.OnClick(ClaudeWoWOrdersCard.header.MinimizeButton)');
  assert.equal(vm.evaluate('ClaudeWoWOrders.debug.buttonArt'), 'ui-questtrackerbutton-secondary-collapse');
  assert.equal(shownBars(vm), 3);
  assert.equal(vm.evaluate('ClaudeWoWDB.orders'), null);
  vm.run('RESULT = 0; for k, v in pairs(ClaudeWoWDB.settings) do if tostring(k):find("^orders") then RESULT = RESULT + 1; assert(type(v) == "boolean", k) end end');
  assert.equal(vm.num('RESULT'), 2, 'ordersCard and ordersCollapsed, nothing else');
});

test('orders card: "/claude orders <words>" is a message, not the command', () => {
  const vm = newVM();
  scenario(vm, [ORDER_GOALS(5)]);
  const chats = vm.num('#ClaudeWoWDB.chats');
  vm.run('SlashCmdList.CLAUDE("orders for the raid tonight")');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.ordersCard'), null);
  assert.equal(vm.num('#ClaudeWoWDB.chats'), chats + 1, 'a new chat with that text');
  assert.equal(cardShown(vm), true);
});

test('orders card: follows the quest tracker as it shows, hides and changes size', () => {
  const vm = newVM({ prelude: TRACKER_STUB });
  scenario(vm, [ORDER_GOALS(5)]);
  assert.equal(vm.evaluate('ClaudeWoWOrders.debug.anchoredTo'), 'tracker');
  assert.equal(vm.evaluate('ClaudeWoWOrdersCard.rel == ObjectiveTrackerFrame.NineSlice'), 'true');
  assert.equal(vm.evaluate('ClaudeWoWOrdersCard.relPoint'), 'BOTTOMLEFT');
  vm.run('ObjectiveTrackerFrame:Hide()');
  assert.equal(vm.evaluate('ClaudeWoWOrders.debug.anchoredTo'), 'tracker-top', 'the tracker hid (no quests): the card takes its place');
  assert.equal(vm.evaluate('ClaudeWoWOrdersCard.rel == ObjectiveTrackerFrame'), 'true');
  vm.run('ObjectiveTrackerFrame:Show()');
  assert.equal(vm.evaluate('ClaudeWoWOrders.debug.anchoredTo'), 'tracker');
  vm.run('ObjectiveTrackerFrame.NineSlice:Hide(); for _, fn in ipairs(ObjectiveTrackerFrame.hooks.OnSizeChanged or {}) do fn(ObjectiveTrackerFrame) end');
  assert.equal(vm.evaluate('ClaudeWoWOrders.debug.anchoredTo'), 'tracker-top', 'a size change re-anchors');
  vm.run('ClaudeWoWOrders.Refresh(); ClaudeWoWOrders.ToggleCollapsed(); ClaudeWoWOrders.ToggleCollapsed()');
  for (const script of ['OnShow', 'OnHide', 'OnSizeChanged']) {
    assert.equal(vm.num(`#ObjectiveTrackerFrame.hooks.${script}`), 1, `${script} hooked once, with HookScript, however often the card redraws`);
  }
});

test('orders card: hides in a pet battle and in a vehicle UI, and comes back after', () => {
  const vm = newVM({ prelude: PET_VEHICLE_STUB });
  scenario(vm, [ORDER_GOALS(5)]);
  assert.equal(cardShown(vm), true);
  vm.run('STUB.petBattle = true; STUB.FireEvent("PET_BATTLE_OPENING_START")');
  assert.equal(cardShown(vm), false);
  vm.run('STUB.petBattle = false; STUB.FireEvent("PET_BATTLE_CLOSE")');
  assert.equal(cardShown(vm), true);
  vm.run('STUB.vehicle = true; STUB.FireEvent("UNIT_ENTERED_VEHICLE", "player")');
  assert.equal(cardShown(vm), false);
  vm.run('STUB.vehicle = false; STUB.FireEvent("UNIT_EXITED_VEHICLE", "player")');
  assert.equal(cardShown(vm), true);
});

test('orders card: Blizzard templates when the client has them, plain frames when a template is missing or incomplete', () => {
  const native = newVM({ prelude: NATIVE_TEMPLATES_STUB });
  scenario(native, [ORDER_GOALS(5)]);
  assert.equal(native.evaluate('ClaudeWoWOrders.debug.native.header'), 'true');
  assert.equal(native.evaluate('ClaudeWoWOrders.debug.native.bar'), 'true');
  assert.equal(native.evaluate('ClaudeWoWOrdersCard.header.template'), 'ObjectiveTrackerModuleHeaderTemplate');
  assert.equal(native.evaluate('ClaudeWoWOrdersCard.bars[1].template'), 'ObjectiveTrackerProgressBarTemplate');
  assert.equal(native.evaluate('ClaudeWoWOrdersCard.header.Text.text'), 'Orders');
  assert.equal(native.evaluate('ClaudeWoWOrdersCard.bars[1].Bar.Label.text'), '71%');
  native.run('RESULT = 0; for _, b in ipairs(ClaudeWoWOrdersCard.bars) do if b.Bar.mouseEnabled ~= false then RESULT = RESULT + 1 end end');
  assert.equal(native.num('RESULT'), 0, 'the template bar takes the mouse; every one is turned off');
  const broken = newVM({ prelude: NATIVE_TEMPLATES_STUB + '\nSTUB.brokenTemplates = true' });
  scenario(broken, [ORDER_GOALS(5)]);
  assert.equal(broken.evaluate('ClaudeWoWOrders.debug.native.header'), 'false');
  assert.equal(broken.evaluate('ClaudeWoWOrders.debug.native.bar'), 'false');
  assert.equal(cardShown(broken), true);
  assert.equal(broken.evaluate('ClaudeWoWOrdersCard.bars[1].Bar.Label.text'), '71%');
  const plain = newVM();
  scenario(plain, [ORDER_GOALS(5)]);
  assert.equal(plain.evaluate('ClaudeWoWOrders.debug.native.header'), 'false', 'no C_XMLUtil: plain frames');
  const noAtlas = newVM({ prelude: 'C_Texture.GetAtlasExists = function() return false end' });
  scenario(noAtlas, [ORDER_GOALS(5)]);
  assert.equal(noAtlas.evaluate('ClaudeWoWOrders.debug.buttonArt'), 'Interface\\Buttons\\UI-MinusButton-Up', 'a missing atlas falls back to a file');
});

test('orders card: data from the slot is bounded and escaped, at most three goals', () => {
  const vm = newVM();
  const many = Array.from({ length: 10 }, (_, i) => `{ title = "goal ${i}", pct = ${i * 10} }`).join(', ');
  scenario(vm, [`{ rev = 1, char = "${CHAR}", order = { id = "o_1", text = "a|cffff0000b ${'x'.repeat(200)}", pct = 250 }, goals = { ${many}, { title = "", pct = 5 }, { title = "no pct" } } }`]);
  const text = vm.evaluate('ClaudeWoWOrdersCard.orderText.text');
  assert.ok(text.startsWith('a||cffff0000b '), 'a pipe cannot start an escape sequence');
  assert.ok(text.length <= 91, `${text.length} characters`);
  assert.equal(vm.evaluate('ClaudeWoWOrdersCard.bars[1].Bar.value'), '100', 'percent clamped');
  assert.equal(shownBars(vm), 4);
  assert.equal(vm.evaluate('ClaudeWoWOrdersCard.goalLines[3].text'), '- goal 2');
  assert.equal(vm.evaluate('ClaudeWoWOrders.debug.lastError'), null, 'ten goals draw without an error');
  vm.run(`ClaudeWoWOrders.Sync("not a table"); ClaudeWoWOrders.Sync({ rev = 2, char = "${CHAR}", order = { text = 7 } })`);
  assert.equal(cardShown(vm), false, 'an order without text is no order');
});

test('orders card: the module sends nothing and automates nothing', () => {
  const src = fs.readFileSync(path.join(ADDON, 'Orders.lua'), 'utf8');
  for (const name of ['SendChatMessage', 'SendAddonMessage', 'C_ChatInfo', 'ChatFrame_OpenChat', 'ChatFrameUtil', 'RunMacro', 'RunScript', 'loadstring', 'CastSpell', 'UseAction', 'TryLoadSlot', 'LoadAddOn', 'SetBinding']) {
    assert.ok(!src.includes(name), `Orders.lua does not use ${name}`);
  }
  const vm = newVM();
  const before = vm.num('#STUB.chatSent');
  scenario(vm, [ORDER_GOALS(5)]);
  vm.run('SlashCmdList.CLAUDE("orders off"); SlashCmdList.CLAUDE("orders on")');
  assert.equal(vm.num('#STUB.chatSent'), before);
});

test('orders card: the toc loads Orders.lua after the core', () => {
  const toc = fs.readFileSync(path.join(ADDON, 'ClaudeWoW.toc'), 'utf8').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  assert.ok(toc.indexOf('Orders.lua') > toc.indexOf('ClaudeWoW.lua'), toc.join(', '));
});
