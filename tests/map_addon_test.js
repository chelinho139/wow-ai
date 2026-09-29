// Runs the real Map.lua (with ClaudeWoW.lua) in a Lua VM: syncing layers from the
// bridge, drawing pins on the world map (zone and continent), the navigator's
// distance/bearing and arrival, herb/ore nodes filtered by skill, and /claude-wow map.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');

const ADDON = path.join(__dirname, '..', 'addon', 'ClaudeWoW');

// Map-specific client stubs: Loch Modan (1432) sits at x .5-.6, y .4-.5 of
// Eastern Kingdoms (1415), which is 10000 x 15000 yards.
const MAP_STUB = `
Enum = { UIMapType = { Continent = 2, Zone = 3 } }
local MAPS = { [1432] = { name = "Loch Modan", mapType = 3, parentMapID = 1415 }, [1415] = { name = "Eastern Kingdoms", mapType = 2, parentMapID = 947 }, [947] = { name = "Azeroth", mapType = 1, parentMapID = 0 } }
C_Map.GetMapInfo = function(id) local m = MAPS[id]; if m then return { name = m.name, mapType = m.mapType, parentMapID = m.parentMapID, mapID = id } end end
C_Map.GetBestMapForUnit = function() return STUB.playerMap or 1432 end
C_Map.GetMapRectOnMap = function(child, parent) if child == 1432 and parent == 1415 then return 0.5, 0.6, 0.4, 0.5 end end
function CreateVector2D(x, y) return { x = x, y = y } end
C_Map.GetWorldPosFromMapPos = function(id, v) if id == 1415 then return 0, { x = v.x * 10000, y = v.y * 15000 } end end
function GetPlayerFacing() return STUB.facing or 0 end
function Methods_CreateLine() end
local canvas = CreateFrame("Frame", "WorldMapCanvas")
canvas.width, canvas.height = 1000, 700
WorldMapFrame = CreateFrame("Frame", "WorldMapFrame")
WorldMapFrame.shown = true
function WorldMapFrame:GetCanvas() return canvas end
function WorldMapFrame:GetMapID() return STUB.shownMap or 1432 end
function WorldMapFrame:GetCanvasScale() return 1 end
function WorldMapFrame:OnMapChanged() end
local T = getmetatable(canvas).__index
MINING, HERBALISM = "Mining", "Herbalism"
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
    const s = lua.lua_isnil(L, -1) ? null : to_jsstring(lua.lua_tolstring(L, -1));
    lua.lua_pop(L, 1);
    return s;
  };
  const num = (expr) => Number(evaluate(expr));
  let stub = fs.readFileSync(path.join(__dirname, 'wow_stub.lua'), 'utf8');
  // Lines are frames too (Frame:CreateLine), and textures can rotate.
  stub += `
function Methods.CreateLine(self, name, layer) local l = NewObjectPublic("Line", name, self); table.insert(self.textures, l); return l end
function Methods.SetRotation(self, r) self.rotation = r end
function Methods.SetVertexColor(self, r, g, b, a) self.vcolor = { r, g, b, a } end
function Methods.SetScale(self, s) self.scale = s end
function Methods.SetAllPoints(self, rel) if rel then self.width, self.height = rel.width, rel.height end end
function Methods.GetFrameLevel(self) return self.level or 1 end
function Methods.SetFrameLevel(self, l) self.level = l end
`;
  stub = stub.replace('local function NewObject(', 'function NewObjectPublic(').replace(/NewObject\(/g, 'NewObjectPublic(');
  run(stub);
  run(MAP_STUB);
  for (const f of ['Codec.lua', 'Inbox.lua', 'ClaudeWoW.lua', 'Map.lua']) run(fs.readFileSync(path.join(ADDON, f), 'utf8'), 'ClaudeWoW');
  run('STUB.FireEvent("ADDON_LOADED", "ClaudeWoW"); STUB.FireEvent("PLAYER_LOGIN")');
  return { run, evaluate, num };
}

// Shown pins on the world map overlay: "x,y,label" (label = the numbered text).
function shownPins(vm) {
  vm.run(`
    local out = {}
    local canvas = WorldMapFrame:GetCanvas()
    local overlay = canvas.children[#canvas.children]
    for _, c in ipairs(overlay.children) do
      if c.kind == "Button" and c.shown then
        local label = c.num and c.num.text or ""
        out[#out + 1] = string.format("%.0f,%.0f,%s,%s", c.x, -c.y, label, c.info and c.info.title or "")
      end
    end
    RESULT = table.concat(out, ";")`);
  const s = vm.evaluate('RESULT');
  return s ? s.split(';') : [];
}

const LAYER = `{ epoch = "e1", version = 1, layers = { { name = "mining", title = "Copper loop", ordered = true, loop = true, points = {
  { 1432, 50, 40, "1. Copper Vein", "ore" }, { 1432, 60, 50, "2. Copper Vein", "ore" }, { 1432, 55, 70, "3. Tin Vein", "ore" } } } } }`;

test('Sync applies a new version once, starts navigation, ignores stale versions', () => {
  const vm = newVM();
  vm.run(`ClaudeWoWMap.Sync(${LAYER})`);
  assert.equal(vm.evaluate('ClaudeWoWMapDB.map.version'), '1');
  assert.equal(vm.evaluate('ClaudeWoWMapDB.nav.layer'), 'mining');
  assert.equal(vm.evaluate('ClaudeWoWMapDB.nav.index'), '1');
  const prints = () => vm.num('#STUB.prints');
  const before = prints();
  vm.run(`ClaudeWoWMap.Sync(${LAYER})`); // same version: nothing
  assert.equal(prints(), before);
  vm.run(`ClaudeWoWMap.Sync({ epoch = "e1", version = 0, layers = {} })`); // older: ignored
  assert.equal(vm.num('#ClaudeWoWMapDB.map.layers'), 1);
  // A new epoch (bridge state reset) replaces, even with a lower version; same content stays quiet.
  vm.run(`local m = ${LAYER}; m.epoch = "e2"; ClaudeWoWMap.Sync(m)`);
  assert.equal(vm.evaluate('ClaudeWoWMapDB.map.epoch'), 'e2');
  assert.equal(prints(), before);
  vm.run(`ClaudeWoWMap.Sync({ epoch = "e2", version = 5, layers = {} })`);
  assert.equal(vm.num('#ClaudeWoWMapDB.map.layers'), 0);
  assert.equal(vm.evaluate('ClaudeWoWMapDB.nav'), null);
});

test('a new route does not take over a route the player is already following', () => {
  const vm = newVM();
  vm.run(`ClaudeWoWMap.Sync(${LAYER})`);
  vm.run('SlashCmdList.CLAUDEWOWMAP("nav mining 2")');
  vm.run(`local m = ${LAYER}; m.version = 2; m.layers[2] = { name = "quests", title = "Westfall", ordered = true, loop = false,
    points = { { 1432, 10, 10, "1. Talk", "quest" }, { 1432, 20, 20, "2. Kill", "kill" } } }; ClaudeWoWMap.Sync(m)`);
  assert.equal(vm.evaluate('ClaudeWoWMapDB.nav.layer'), 'mining');
  assert.equal(vm.evaluate('ClaudeWoWMapDB.nav.index'), '2');
  // With nothing being followed, the next route starts by itself.
  vm.run('SlashCmdList.CLAUDEWOWMAP("stop")');
  vm.run(`local m = ${LAYER}; m.version = 3; m.layers[1].points[1][4] = "1. Rich Copper"; ClaudeWoWMap.Sync(m)`);
  assert.equal(vm.evaluate('ClaudeWoWMapDB.nav.layer'), 'mining');
  assert.equal(vm.evaluate('ClaudeWoWMapDB.nav.index'), '1');
});

test('slot data carrying a map reaches the map module', () => {
  const vm = newVM();
  vm.run(`ClaudeWoW_Inbox = { replies = {}, map = ${LAYER} }; STUB.FireEvent("PLAYER_LOGIN")`);
  assert.equal(vm.evaluate('ClaudeWoWMapDB.map.layers[1].title'), 'Copper loop');
});

test('pins land where the points are, on the zone map and on the continent', () => {
  const vm = newVM();
  vm.run(`ClaudeWoWMap.Sync(${LAYER})`);
  vm.run('ClaudeWoWMap.Refresh()');
  let pins = shownPins(vm);
  assert.deepEqual(pins, ['500,280,1,Copper loop', '600,350,2,Copper loop', '550,490,3,Copper loop']);
  vm.run('STUB.shownMap = 1415; ClaudeWoWMap.Refresh()');
  pins = shownPins(vm);
  // 1432 (50,40) -> 1415 (0.55, 0.44) on a 1000x700 canvas.
  assert.equal(pins[0], '550,308,1,Copper loop');
  vm.run('STUB.shownMap = 947; ClaudeWoWMap.Refresh()'); // no rect: nothing drawn
  assert.deepEqual(shownPins(vm), []);
});

test('navigator shows yards and bearing, and advances on arrival', () => {
  const vm = newVM();
  vm.run(`ClaudeWoWMap.Sync(${LAYER})`);
  // Player at Loch Modan 50,50 -> continent (0.55, 0.45); stop 1 (50,40) is 150 yd due north.
  vm.run('STUB.posX, STUB.posY = 0.5, 0.5; ClaudeWoWMap.UpdateNavigator()');
  assert.match(vm.evaluate('ClaudeWoWNavigator.text.text'), /^150 yd/);
  assert.ok(Math.abs(vm.num('ClaudeWoWNavigator.arrow.rotation')) < 1e-9, 'north is straight up');
  vm.run('STUB.facing = math.pi / 2; ClaudeWoWMap.UpdateNavigator()'); // facing west: target is to the right
  assert.ok(Math.abs(vm.num('ClaudeWoWNavigator.arrow.rotation') + Math.PI / 2) < 1e-9);
  // Walk onto stop 1: it advances to stop 2 (60,50: 100 yd east and 150 yd south).
  vm.run('STUB.facing = 0; STUB.posX, STUB.posY = 0.5, 0.4; ClaudeWoWMap.UpdateNavigator()');
  assert.equal(vm.evaluate('ClaudeWoWMapDB.nav.index'), '2');
  vm.run('ClaudeWoWMap.UpdateNavigator()');
  assert.match(vm.evaluate('ClaudeWoWNavigator.text.text'), /^180 yd/);
  // South-east: a clockwise turn between a quarter and a half.
  assert.ok(Math.abs(vm.num('ClaudeWoWNavigator.arrow.rotation') - Math.atan2(-100, -150)) < 1e-9);
  // Due east from the same spot's latitude: exactly a clockwise quarter turn.
  vm.run('STUB.posX, STUB.posY = 0.5, 0.5; ClaudeWoWMap.UpdateNavigator()');
  assert.match(vm.evaluate('ClaudeWoWNavigator.text.text'), /^100 yd/);
  assert.ok(Math.abs(vm.num('ClaudeWoWNavigator.arrow.rotation') + Math.PI / 2) < 1e-9, 'east is a clockwise quarter turn');
  // Loop: after the last stop it wraps to the first.
  vm.run('ClaudeWoWMap.Step(1); ClaudeWoWMap.Step(1)');
  assert.equal(vm.evaluate('ClaudeWoWMapDB.nav.index'), '1');
  // Elsewhere with no position: says so instead of pointing.
  vm.run('STUB.playerMap = 999; ClaudeWoWMap.UpdateNavigator()');
  assert.equal(vm.evaluate('ClaudeWoWNavigator.text.text'), 'no position here');
});

test('herb/ore nodes toggle and follow the gathering skill', () => {
  const vm = newVM();
  vm.run(`ClaudeWoWNodes = { kinds = { { "Copper Vein", "mining", 1 }, { "Tin Vein", "mining", 65 }, { "Peacebloom", "herbalism", 1 } },
    maps = { [1432] = { [1] = "100200300400", [2] = "500500", [3] = "999999" } } }`);
  vm.run('ClaudeWoWMap.Refresh()');
  assert.equal(shownPins(vm).length, 0, 'off by default');
  vm.run('SlashCmdList.CLAUDEWOWMAP("ore on")');
  // No Mining skill line in the stub: every ore shows, flagged as not learned.
  assert.deepEqual(shownPins(vm).map(p => p.split(',').slice(0, 2).join(',') + ',' + p.split(',')[3]), ['100,140,Copper Vein', '300,280,Copper Vein', '500,350,Tin Vein']);
  // With Mining 50 (Forever's C_SkillInfo: one table per line), Tin (65) is filtered out until "filter all".
  // Forever also lists child lines (parentSkillLineID ~= 0) that repeat the parent.
  vm.run(`C_SkillInfo = { GetNumSkillLines = function() return 3 end, GetSkillLineInfo = function(i)
    if i == 1 then return { name = "Professions", isHeader = true, rank = 0, maxRank = 0, skillID = 0, parentSkillLineID = 0 } end
    if i == 3 then return { name = "Bergbau", isHeader = false, rank = 50, maxRank = 75, skillID = 2572, parentSkillLineID = 186 } end
    return { name = "Bergbau", isHeader = false, rank = 50, maxRank = 75, skillID = 186, parentSkillLineID = 0 } end }
    ClaudeWoWMap.Refresh()`);
  assert.equal(shownPins(vm).length, 2);
  vm.run('SlashCmdList.CLAUDEWOWMAP("filter all")');
  assert.equal(shownPins(vm).length, 3);
  vm.run('SlashCmdList.CLAUDEWOWMAP("herb on")');
  assert.equal(shownPins(vm).length, 4);
  vm.run('SlashCmdList.CLAUDEWOWMAP("ore off"); SlashCmdList.CLAUDEWOWMAP("herb off")');
  assert.equal(shownPins(vm).length, 0);
  // The game context reads professions from the same API.
  assert.match(vm.evaluate('ClaudeWoW.GameContext()'), /Professions: Bergbau 50\/75(\n|$)/);
});

test('/claude-wow map hide, show, nav and stop', () => {
  const vm = newVM();
  vm.run(`ClaudeWoWMap.Sync(${LAYER})`);
  vm.run('SlashCmdList.CLAUDEWOWMAP("hide mining")');
  assert.equal(shownPins(vm).length, 0);
  vm.run('SlashCmdList.CLAUDEWOWMAP("show mining")');
  assert.equal(shownPins(vm).length, 3);
  vm.run('SlashCmdList.CLAUDEWOWMAP("nav mining 3")');
  assert.equal(vm.evaluate('ClaudeWoWMapDB.nav.index'), '3');
  vm.run('SlashCmdList.CLAUDEWOWMAP("stop")');
  assert.equal(vm.evaluate('ClaudeWoWMapDB.nav'), null);
  assert.equal(vm.evaluate('ClaudeWoWNavigator.shown'), 'false');
  vm.run('SlashCmdList.CLAUDEWOWMAP("")'); // status never errors
});
