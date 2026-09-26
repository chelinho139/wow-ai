// Quest state: the addon's context lines and saved completed set, and the
// bridge's parsing and merge into the game-state file the agent's tools read.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');
const P = require('../bridge/protocol');

const ADDON = path.join(__dirname, '..', 'addon', 'WoWAI');

test('base-36 ranges round-trip and survive junk', () => {
  const ids = [1, 2, 3, 5, 36, 37, 38, 1000, 26031];
  const enc = P.encodeRanges([...ids].reverse());
  assert.equal(enc, '1-3,5,10-12,rs,k33');
  assert.deepEqual(P.decodeRanges(enc), ids);
  assert.deepEqual(P.decodeRanges(',,zz-,x'), [1295, 33]);
  assert.deepEqual(P.decodeRanges('0-zzzzzz'), [], 'absurd ranges are skipped');
});

test('parseQuestsDone reads every character from saved data', () => {
  const src = 'WoWAIDB = {\n["chats"] = { { ["name"] = "x" } },\n["questsDone"] = {\n["Rocio Aguirre-Classic Beta PvP 2"] = {\n["n"] = 3,\n["ids"] = "lw-ly",\n["at"] = 1790000000,\n},\n["Alt-Realm"] = {\n["ids"] = "1",\n},\n},\n["settings"] = {},\n}';
  const q = P.parseQuestsDone(src);
  assert.deepEqual(Object.keys(q), ['Rocio Aguirre-Classic Beta PvP 2', 'Alt-Realm']);
  assert.deepEqual(q['Rocio Aguirre-Classic Beta PvP 2'], { ids: [788, 789, 790], at: 1790000000 });
  assert.deepEqual(P.parseQuestsDone('WoWAIDB = {}'), {});
});

const CTX = [
  'Game: World of Warcraft: Forever (client 1.60.1.69977, interface 16001)',
  'Character: Rocio Aguirre on Classic Beta PvP 2, level 12 Night Elf Druid (Alliance), guild <Test>',
  'Location: The Barrens - Shrine of the Fallen Warrior',
  'Position: 47.1, 30.6 on Kalimdor (map 1413)',
  'Money: 21s 52c; XP: 8556/10100',
  'Professions: Engineering 75/75, Mining 72/75',
  'Quests (id, objectives, * ready to turn in, ! failed): 848 Fungal Spores 2/4; 867 Harpy Raiders 5/8, Harpy Claw done; 6384*; 1492!; 870 0/1',
  'Turned in since login: 844,871',
].join('\n');

test('parseGameContext reads character, position, professions and the quest log', () => {
  const st = P.parseGameContext(CTX);
  assert.deepEqual(st.character, { name: 'Rocio Aguirre', realm: 'Classic Beta PvP 2', key: 'Rocio Aguirre-Classic Beta PvP 2' });
  assert.equal(st.level, 12);
  assert.equal(st.race, 'Night Elf');
  assert.equal(st.class, 'Druid');
  assert.equal(st.faction, 'Alliance');
  assert.equal(st.zone, 'The Barrens');
  assert.deepEqual(st.position, { map: 1413, x: 47.1, y: 30.6 });
  assert.deepEqual(st.professions, { Engineering: 75, Mining: 72 });
  assert.deepEqual(st.xp, { have: 8556, need: 10100 });
  assert.deepEqual(st.quests.map(q => `${q.id}:${q.status}`), ['848:active', '867:active', '6384:complete', '1492:failed', '870:active']);
  assert.deepEqual(st.quests[1].objectives, [{ name: 'Harpy Raiders', have: 5, need: 8, done: false }, { name: 'Harpy Claw', done: true }]);
  assert.deepEqual(st.quests[4].objectives, [{ name: '', have: 0, need: 1, done: false }]);
  assert.deepEqual(st.turnedIn, [844, 871]);
  assert.equal(P.parseGameContext('Game: x').quests, null, 'no quest line: unknown, not empty');
});

test('buildGameState joins saved history and this login', () => {
  const done = { 'Rocio Aguirre-Classic Beta PvP 2': { ids: [788, 844], at: 1790000000 }, 'Someone-Else': { ids: [1], at: 1 } };
  const gs = P.buildGameState(CTX, done, 0);
  assert.equal(gs.completed.known, true);
  assert.deepEqual(gs.completed.ids, [788, 844, 871]);
  const other = P.buildGameState(CTX.replace('Rocio Aguirre', 'Newbie'), done, 0);
  assert.equal(other.completed.known, false, 'another character never borrows this one\'s history');
  assert.deepEqual(other.completed.ids, [844, 871]);
});

// ---------------------------------------------------------------------------
// Addon side
// ---------------------------------------------------------------------------

const QUEST_STUB = `
STUB.log = {
  { questID = 848, isHeader = false, objectives = { { text = "Fungal Spores: 2/4", finished = false, numFulfilled = 2, numRequired = 4 } } },
  { questID = 0, isHeader = true },
  { questID = 6384, isHeader = false, complete = true, objectives = {} },
  { questID = 1492, isHeader = false, failed = true, objectives = {} },
  { questID = 870, isHeader = false, objectives = { { text = "Explore the Forgotten Pools", finished = true, numFulfilled = 1, numRequired = 1 } } },
}
STUB.completed = { 790, 788, 789, 804 }
C_QuestLog = {
  GetNumQuestLogEntries = function() return #STUB.log end,
  GetInfo = function(i) return STUB.log[i] end,
  IsComplete = function(id) for _, q in ipairs(STUB.log) do if q.questID == id then return q.complete == true end end end,
  IsFailed = function(id) for _, q in ipairs(STUB.log) do if q.questID == id then return q.failed == true end end end,
  GetQuestObjectives = function(id) for _, q in ipairs(STUB.log) do if q.questID == id then return q.objectives end end end,
  GetAllCompletedQuestIDs = function() local t = {} for i, v in ipairs(STUB.completed) do t[i] = v end return t end,
}
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
  run(QUEST_STUB);
  for (const f of ['Codec.lua', 'Inbox.lua', 'WoWAI.lua']) run(fs.readFileSync(path.join(ADDON, f), 'utf8'), 'WoWAI');
  run('STUB.FireEvent("ADDON_LOADED", "WoWAI"); STUB.FireEvent("PLAYER_LOGIN")');
  return { run, evaluate };
}

test('the context carries the quest log with progress, and the bridge reads it back', () => {
  const vm = newVM();
  const ctx = vm.evaluate('WoWAI.GameContext()');
  assert.match(ctx, /^Quests \(id, objectives, \* ready to turn in, ! failed\): 848 Fungal Spores 2\/4; 6384\*; 1492!; 870 Explore the Forgotte done$/m, "objective names are cut at 20 characters");
  assert.match(ctx, /^Completed quest history: not on disk yet/m, 'first login with the addon');
  const st = P.parseGameContext(ctx);
  assert.deepEqual(st.quests.map(q => q.id), [848, 6384, 1492, 870]);
});

test('turning in quests: listed since login, and the full set lands in saved data', () => {
  const vm = newVM();
  vm.run('STUB.RunTimers()'); // the delayed save after login
  vm.run('table.insert(STUB.completed, 848); STUB.FireEvent("QUEST_TURNED_IN", 848)');
  assert.match(vm.evaluate('WoWAI.GameContext()'), /^Turned in since login: 848$/m);
  const key = 'Testchar-Test Realm';
  assert.equal(vm.evaluate(`WoWAIDB.questsDone["${key}"].n`), '5');
  // What the file would hold, as the bridge parses it.
  const ids = vm.evaluate(`WoWAIDB.questsDone["${key}"].ids`);
  const src = `WoWAIDB = {\n["questsDone"] = {\n["${key}"] = {\n["ids"] = "${ids}",\n["at"] = 5,\n},\n},\n}`;
  assert.deepEqual(P.parseQuestsDone(src)[key].ids, [788, 789, 790, 804, 848]);
});

test('once the history is on disk the context stops asking for a /reload', () => {
  const vm = newVM();
  vm.run('WoWAIDB.questsDone = { ["Testchar-Test Realm"] = { ids = "lw", n = 1, at = 1 } }; STUB.FireEvent("PLAYER_LOGIN")');
  assert.doesNotMatch(vm.evaluate('WoWAI.GameContext()'), /not on disk/);
});

test('a long quest log drops objective names before anything else, and never cuts an entry in half', () => {
  const vm = newVM();
  vm.run(`STUB.log = {}
    for i = 1, 25 do
      STUB.log[i] = { questID = 1000 + i, isHeader = false, objectives = {
        { text = "A very long objective name: 1/10", finished = false, numFulfilled = 1, numRequired = 10 },
        { text = "Another long objective name: 2/10", finished = false, numFulfilled = 2, numRequired = 10 } } }
    end`);
  const line = vm.evaluate('WoWAI.GameContext()').split('\n').find(l => l.startsWith('Quests'));
  assert.ok(line.length < 1000, `line is ${line.length} bytes`);
  const st = P.parseGameContext(line);
  assert.equal(st.quests.length, 25);
  assert.deepEqual(st.quests[0].objectives.map(o => [o.have, o.need]), [[1, 10], [2, 10]]);
});
