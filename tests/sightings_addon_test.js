'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');

const ADDON = path.join(__dirname, '..', 'addon', 'ClaudeWoW');

const UNITS = `
STUB.units = {}
function UnitGUID(unit) return STUB.units[unit] and STUB.units[unit].guid end
function UnitName(unit) return STUB.units[unit] and STUB.units[unit].name end
function strsplit(sep, s)
  local out = {}
  for part in (s .. sep):gmatch("(.-)%" .. sep) do out[#out + 1] = part end
  return table.unpack(out)
end
function GetTaxiMapID() return 1414 end
C_TaxiMap = { GetAllTaxiNodes = function(mapId) return {
  { name = "Orgrimmar, Durotar", position = { x = 0.5213, y = 0.4077 } },
  { name = "Crossroads, The Barrens", position = { x = 0.5105, y = 0.5321 } },
} end }
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
  run(fs.readFileSync(path.join(__dirname, 'wow_stub.lua'), 'utf8'));
  run(UNITS);
  for (const f of ['Codec.lua', 'Inbox.lua', 'ClaudeWoW.lua', 'Sightings.lua']) run(fs.readFileSync(path.join(ADDON, f), 'utf8'), 'ClaudeWoW');
  run('STUB.FireEvent("ADDON_LOADED", "ClaudeWoW"); STUB.FireEvent("PLAYER_LOGIN")');
  return { run, evaluate };
}

const npc = (unit, name, id) => `STUB.units["${unit}"] = { name = "${name}", guid = "Creature-0-1-0-0-${id}-0000ABCDEF" }`;

test('talking to an NPC records its exact spot and role on the current map; a nameplate records an approximate one', () => {
  const vm = newVM();
  vm.run(`${npc('npc', 'Auctioneer Grimful', 9856)}; STUB.posX, STUB.posY = 0.5271, 0.6682; STUB.FireEvent("AUCTION_HOUSE_SHOW")`);
  assert.equal(vm.evaluate('ClaudeWoWNpcDB.npcs[9856].name'), 'Auctioneer Grimful');
  assert.equal(vm.evaluate('ClaudeWoWNpcDB.npcs[9856].spots[1431].x'), '52.7');
  assert.equal(vm.evaluate('ClaudeWoWNpcDB.npcs[9856].spots[1431].y'), '66.8');
  assert.equal(vm.evaluate('ClaudeWoWNpcDB.npcs[9856].spots[1431].role'), 'auction');
  assert.equal(vm.evaluate('ClaudeWoWNpcDB.npcs[9856].spots[1431].exact'), 'true');

  vm.run(`STUB.posX, STUB.posY = 0.60, 0.70; STUB.units["npc"] = nil; ${npc('nameplate3', 'Auctioneer Grimful', 9856)}; STUB.FireEvent("NAME_PLATE_UNIT_ADDED", "nameplate3")`);
  assert.equal(vm.evaluate('ClaudeWoWNpcDB.npcs[9856].spots[1431].x'), '52.7', 'an exact spot is never replaced by a nameplate guess');

  vm.run(`${npc('nameplate4', 'Bone Sleeve', 3159)}; STUB.FireEvent("NAME_PLATE_UNIT_ADDED", "nameplate4")`);
  assert.equal(vm.evaluate('ClaudeWoWNpcDB.npcs[3159].spots[1431].exact'), null, 'a nameplate is approximate');
  assert.equal(Number(vm.evaluate('ClaudeWoWNpcDB.npcs[3159].spots[1431].x')), 60);
});

test('players and pets are never recorded', () => {
  const vm = newVM();
  vm.run('STUB.units["target"] = { name = "Somebody", guid = "Player-1-00000001" }; STUB.FireEvent("PLAYER_TARGET_CHANGED")');
  assert.equal(vm.evaluate('next(ClaudeWoWNpcDB.npcs)'), null);
  vm.run('STUB.units["mouseover"] = { name = "Catfish", guid = "Pet-0-1-0-0-3619-0000000001" }; STUB.FireEvent("UPDATE_MOUSEOVER_UNIT")');
  assert.equal(vm.evaluate('next(ClaudeWoWNpcDB.npcs)'), null);
});

test('opening the flight map records every flight master on it', () => {
  const vm = newVM();
  vm.run(`${npc('npc', 'Doras', 3310)}; STUB.FireEvent("TAXIMAP_OPENED")`);
  assert.equal(vm.evaluate('ClaudeWoWNpcDB.flights[1414]["Crossroads, The Barrens"].x'), '51.1');
  assert.equal(vm.evaluate('ClaudeWoWNpcDB.npcs[3310].spots[1431].role'), 'flight');
});

test('the situation block names the closest NPCs seen on the current map', () => {
  const vm = newVM();
  vm.run(`STUB.posX, STUB.posY = 0.10, 0.10; ${npc('npc', 'Far Vendor', 1)}; STUB.FireEvent("MERCHANT_SHOW")`);
  vm.run(`STUB.posX, STUB.posY = 0.50, 0.50; ${npc('npc', 'Near Trainer', 2)}; STUB.FireEvent("TRAINER_SHOW")`);
  vm.run(`STUB.posX, STUB.posY = 0.52, 0.52; ${npc('nameplate1', 'Wolf', 3)}; STUB.FireEvent("NAME_PLATE_UNIT_ADDED", "nameplate1")`);
  const ctx = vm.evaluate('ClaudeWoW.GameContext()');
  const line = ctx.split('\n').find(l => l.startsWith('NPCs seen on this map'));
  assert.ok(line, ctx);
  assert.ok(line.indexOf('Wolf 52.0,52.0~') < line.indexOf('Near Trainer 50.0,50.0') && line.indexOf('Near Trainer') < line.indexOf('Far Vendor'), line);
});
