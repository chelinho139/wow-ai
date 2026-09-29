'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');

const ADDON = path.join(__dirname, '..', 'addon', 'ClaudeWoW');
const ADDON_FILES = ['Codec.lua', 'Inbox.lua', 'ClaudeWoW.lua', 'Map.lua', 'Achievements.lua'];

const SOUND_STUB = `
STUB.soundFiles, STUB.soundKits = {}, {}
function PlaySoundFile(path, channel)
	table.insert(STUB.soundFiles, tostring(path))
	if STUB.sounds[path] then return true, 1 end
	return false
end
function PlaySound(kit, channel) table.insert(STUB.soundKits, kit) return true end
`;

function newVM({ beforeLogin = '' } = {}) {
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
  run(SOUND_STUB);
  for (const f of ADDON_FILES) run(fs.readFileSync(path.join(ADDON, f), 'utf8'), 'ClaudeWoW');
  run('STUB.FireEvent("ADDON_LOADED", "ClaudeWoW")');
  if (beforeLogin) run(beforeLogin);
  run('STUB.FireEvent("PLAYER_LOGIN")');
  const prints = () => {
    run('RESULT = table.concat(STUB.prints, "\\n")');
    return evaluate('RESULT') || '';
  };
  return { run, evaluate, prints };
}

const NOW = 'time()';
const entry = (seq, id, title, ageSeconds = 5) =>
  `{ seq = ${seq}, id = "${id}", title = "${title}", text = "t ${id}", points = 10, icon = "Interface\\\\Icons\\\\INV_Misc_Note_01", at = ${NOW} - ${ageSeconds} }`;
const earned = (id, title) => `{ id = "${id}", title = "${title}", text = "t ${id}", points = 10, icon = "Interface\\\\Icons\\\\INV_Misc_Note_01", at = ${NOW} - 5, count = 1 }`;
const payload = (seq, recent, earnedList = []) =>
  `{ seq = ${seq}, points = ${earnedList.length * 10}, total = 14, recent = { ${recent.join(', ')} }, earned = { ${earnedList.join(', ')} } }`;

test('a fresh award shows the gold toast with its points, plays the sound and says so in chat', () => {
  const vm = newVM();
  vm.run(`ClaudeWoWAchievements.Sync(${payload(1, [entry(1, 'leeroy', 'Leeroy Jenkins')], [earned('leeroy', 'Leeroy Jenkins')])})`);
  assert.equal(vm.evaluate('ClaudeWoWAchievementToast.shown'), 'true');
  assert.equal(vm.evaluate('ClaudeWoWAchievementToast.title.text'), 'Leeroy Jenkins');
  assert.equal(vm.evaluate('ClaudeWoWAchievementToast.points.text'), '10');
  assert.equal(vm.evaluate('ClaudeWoWAchievementToast.icon.texture'), 'Interface\\Icons\\INV_Misc_Note_01');
  assert.equal(vm.evaluate('ClaudeWoWAchievementToast.header.text'), 'Achievement Earned');
  assert.ok(vm.evaluate('ClaudeWoWAchievementToast.backdrop.edgeFile'));
  assert.equal(vm.evaluate('STUB.soundFiles[#STUB.soundFiles]'), '569143', 'the achievement sound by FileDataID first');
  assert.equal(vm.evaluate('STUB.soundKits[1]'), '12891', 'then the SOUNDKIT when the file does not play');
  assert.match(vm.prints(), /earned the achievement .*\[Leeroy Jenkins\]/);
  assert.equal(vm.evaluate('ClaudeWoWDB.achievements.seen'), '1');
  assert.equal(vm.evaluate('#ClaudeWoWDB.achievements.earned'), '1');
});

test('the sound file alone is enough when it plays', () => {
  const vm = newVM();
  vm.run('STUB.sounds[569143] = true');
  vm.run(`ClaudeWoWAchievements.Sync(${payload(1, [entry(1, 'a', 'A')])})`);
  assert.equal(vm.evaluate('#STUB.soundKits'), '0');
});

test('toasts queue one after another and fade out on their own', () => {
  const vm = newVM();
  vm.run(`ClaudeWoWAchievements.Sync(${payload(2, [entry(2, 'b', 'Second'), entry(1, 'a', 'First')])})`);
  assert.equal(vm.evaluate('ClaudeWoWAchievementToast.title.text'), 'First', 'oldest first');
  assert.equal(vm.evaluate('ClaudeWoWAchievements.Pending()'), '1');
  vm.run('local f = ClaudeWoWAchievementToast; f.scripts.OnUpdate(f, 0.2)');
  assert.equal(vm.evaluate('ClaudeWoWAchievementToast.title.text'), 'First');
  vm.run('local f = ClaudeWoWAchievementToast; f.scripts.OnUpdate(f, 10)');
  assert.equal(vm.evaluate('ClaudeWoWAchievementToast.title.text'), 'Second');
  vm.run('local f = ClaudeWoWAchievementToast; f.scripts.OnUpdate(f, 10)');
  assert.equal(vm.evaluate('ClaudeWoWAchievementToast.shown'), 'false');
  assert.equal(vm.evaluate('ClaudeWoWAchievements.Pending()'), '0');
});

test('a click dismisses the toast', () => {
  const vm = newVM();
  vm.run(`ClaudeWoWAchievements.Sync(${payload(1, [entry(1, 'a', 'A')])})`);
  vm.run('local f = ClaudeWoWAchievementToast; f.scripts.OnMouseUp(f)');
  assert.equal(vm.evaluate('ClaudeWoWAchievementToast.shown'), 'false');
});

test('each award is toasted once: the same slot again, and stale awards, stay quiet', () => {
  const vm = newVM();
  const data = payload(1, [entry(1, 'a', 'A')]);
  vm.run(`ClaudeWoWAchievements.Sync(${data})`);
  vm.run('local f = ClaudeWoWAchievementToast; f.scripts.OnUpdate(f, 10)');
  vm.run(`ClaudeWoWAchievements.Sync(${data})`);
  assert.equal(vm.evaluate('ClaudeWoWAchievementToast.shown'), 'false');
  vm.run('ClaudeWoWDB.achievements.seen = nil');
  vm.run(`ClaudeWoWAchievements.Sync(${payload(3, [entry(3, 'old', 'Old news', 3600)])})`);
  assert.equal(vm.evaluate('ClaudeWoWAchievementToast.shown'), 'false', 'an award from an hour ago is not news after a data wipe');
  assert.equal(vm.evaluate('ClaudeWoWDB.achievements.seen'), '3');
});

test('a bridge whose ledger was reset starts the count again', () => {
  const vm = newVM();
  vm.run('ClaudeWoWDB.achievements = { seen = 40, earned = {} }');
  vm.run(`ClaudeWoWAchievements.Sync(${payload(1, [entry(1, 'a', 'Again')])})`);
  assert.equal(vm.evaluate('ClaudeWoWAchievementToast.title.text'), 'Again');
});

test('/claude-wow achievements off silences the toasts, the list still works', () => {
  const vm = newVM();
  vm.run('SlashCmdList.CLAUDEWOW("achievements off")');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.toasts'), 'false');
  vm.run(`ClaudeWoWAchievements.Sync(${payload(1, [entry(1, 'leeroy', 'Leeroy Jenkins')], [earned('leeroy', 'Leeroy Jenkins')])})`);
  assert.equal(vm.evaluate('ClaudeWoWAchievementToast'), null, 'no toast frame at all');
  assert.equal(vm.evaluate('#STUB.soundKits'), '0');
  vm.run('SlashCmdList.CLAUDEWOW("achievements")');
  const out = vm.prints();
  assert.match(out, /Achievements: 1 of 14 earned, 10 points\. Toasts are off/);
  assert.match(out, /\[Leeroy Jenkins\]\|r 10 pts - t leeroy/);
  vm.run('SlashCmdList.CLAUDEWOW("toasts on")');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.toasts'), 'true');
  vm.run('SlashCmdList.CLAUDEWOW("achievements test")');
  assert.equal(vm.evaluate('ClaudeWoWAchievementToast.title.text'), 'Achievement Unlocked');
});

test('an empty list says how to earn one, and free text starting with the word is a message', () => {
  const vm = newVM();
  vm.run('SlashCmdList.CLAUDEWOW("achievements")');
  assert.match(vm.prints(), /Achievements: 0 of 0 earned, 0 points\. Toasts are on/);
  assert.match(vm.prints(), /None yet/);
  vm.run('STUB.prints = {}');
  vm.run('SlashCmdList.CLAUDEWOW("achievements are a fun idea, add some")');
  assert.doesNotMatch(vm.prints(), /Achievements:/);
});

test('toasts ride in Inbox.lua too, the reload path', () => {
  const vm = newVM({ beforeLogin: `ClaudeWoW_Inbox = { now = time(), replies = {}, achievements = ${payload(1, [entry(1, 'night-owl', 'Night Owl')], [earned('night-owl', 'Night Owl')])} }` });
  assert.equal(vm.evaluate('ClaudeWoWAchievementToast.title.text'), 'Night Owl');
  assert.equal(vm.evaluate('ClaudeWoWDB.achievements.earned[1].id'), 'night-owl');
});
