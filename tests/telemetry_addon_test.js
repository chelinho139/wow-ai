'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');
const P = require('../bridge/protocol');
const TL = require('../bridge/telemetry');
const G = require('../bridge/goals');

const ADDON = path.join(__dirname, '..', 'addon', 'ClaudeWoW');
const CELLS_PER_ROW = 200;
const MAX_PAYLOAD = 3200;

const GAME_STUB = `
C_SkillInfo = {
  GetNumSkillLines = function() return 4 end,
  GetSkillLineInfo = function(i)
    return ({
      { name = "Professions", isHeader = true, parentSkillLineID = 0 },
      { name = "Skinning", isHeader = false, rank = STUB.skinning or 75, maxRank = 75, skillID = 393, parentSkillLineID = 0 },
      { name = "Secondary Skills", isHeader = true, parentSkillLineID = 0 },
      { name = "First Aid", isHeader = false, rank = 40, maxRank = 75, skillID = 129, parentSkillLineID = 0 },
    })[i]
  end,
}
STUB.bagFree = { [0] = 3, [1] = 2, [2] = 0, [3] = 0, [4] = 0 }
C_Container = { GetContainerNumFreeSlots = function(bag) return STUB.bagFree[bag] or 0, 0 end }
STUB.itemCounts = { [2589] = 12 }
C_Item.GetItemCount = function(id) return STUB.itemCounts[id] or 0 end
STUB.equipped = { [1] = 16707, [16] = 2140 }
function GetInventoryItemID(unit, slot) return STUB.equipped[slot] end
STUB.factions = { [530] = { factionID = 530, reaction = 5, currentStanding = 3000 } }
GetCurrentKeyBoardFocus = function() return STUB.focus end
C_Reputation = {
  GetFactionDataByID = function(id) return STUB.factions[id] end,
  GetWatchedFactionData = function() return nil end,
}
`;

function newVM({ extra = GAME_STUB, saved = '' } = {}) {
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
  run(extra);
  if (saved) run(saved);
  for (const f of ['Codec.lua', 'Inbox.lua', 'ClaudeWoW.lua', 'Telemetry.lua']) run(fs.readFileSync(path.join(ADDON, f), 'utf8'), 'ClaudeWoW');
  run('ARMED = 0; local arm = ClaudeWoW.ArmAutoRefresh; ClaudeWoW.ArmAutoRefresh = function(...) ARMED = ARMED + 1; return arm(...) end');
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
  assert.equal(bytes[0], 0xc7);
  assert.equal(bytes[1], 0x1a);
  const len = bytes[4] * 256 + bytes[5];
  return { id: bytes[2] * 256 + bytes[3], text: Buffer.from(bytes.slice(6, 6 + len)).toString('utf8'), len };
}

function nextSlot(vm, luaBody) {
  vm.run(`STUB.onLoadAddOn = function(name) ClaudeWoW_SlotData = ${luaBody} end`);
}

const GS = '{ v = 1, watch = { items = { 2589 }, factions = { 530 } }, chars = {} }';
const CHARACTER = 'Testchar-TestRealm';

function slotBody(gs = GS, extra = '') {
  return `{ now = time(), cwd = "", transport = "screenshot", strip = { on = 255, off = 0 }, ${gs ? `gs = ${gs},` : ''} replies = {} ${extra} }`;
}

function shoot(vm, outcome = 'SCREENSHOT_SUCCEEDED') {
  if (vm.evaluate('ClaudeWoWStrip and ClaudeWoWStrip.shown') !== 'true') return null;
  for (let i = 0; i < 2; i++) vm.run('local f = ClaudeWoWStrip; if f.shown and f.scripts.OnUpdate then f.scripts.OnUpdate(f, 0.016) end');
  const frame = decodeStrip(vm);
  vm.run(`STUB.FireEvent("${outcome}")`);
  return { frame, jobs: P.jobsFromStrip(frame.id, frame.text) };
}

function tick(vm, seconds) {
  vm.run(`STUB.now = STUB.now + ${seconds}; STUB.Tick()`);
}

function gsJobs(shot) {
  return shot ? shot.jobs.filter(j => j.kind === 'gs') : [];
}

function sectionsOf(job) {
  return TL.parseRecord(job.text);
}

function ready({ gs = GS, saved = '', extra } = {}) {
  const vm = newVM({ saved, extra });
  vm.run('STUB.FireEvent("ADDON_LOADED", "ClaudeWoW"); STUB.FireEvent("PLAYER_LOGIN")');
  vm.run('STUB.RunTimers()');
  nextSlot(vm, slotBody(gs));
  tick(vm, 6);
  assert.equal(vm.evaluate('ClaudeWoW.IsConnected()'), 'true');
  const hello = shoot(vm);
  assert.ok(hello && hello.jobs.some(j => j.hello), 'the hello went out on a screenshot');
  assert.deepEqual(gsJobs(hello), [], 'the capability arrived after that shot was drawn');
  tick(vm, 21);
  return vm;
}

test('no game state goes out before the bridge advertises gs, and an old bridge without it never gets one', () => {
  const vm = ready({ gs: null });
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'false', 'no telemetry-only shot');
  const shots = vm.num('STUB.screenshots');
  for (let i = 0; i < 5; i++) { vm.run('STUB.money = STUB.money + 100'); tick(vm, 130); }
  assert.equal(vm.num('STUB.screenshots'), shots, 'still no shot after ten minutes of changes');
  vm.run('ClaudeWoW.Send("what should I do next")');
  const shot = shoot(vm);
  assert.ok(shot.jobs.some(j => j.text === 'what should I do next'));
  assert.deepEqual(gsJobs(shot), [], 'nothing rides on the message either');
  assert.equal(vm.evaluate('ClaudeWoWTelemetry.Active()'), 'false');
});

test('the first record is a telemetry-only shot with every section, stamped with its own sequence and outside the message ids', () => {
  const vm = ready();
  const lastSeq = vm.num('ClaudeWoWDB.lastSeq');
  const shot = shoot(vm);
  assert.ok(shot, 'a telemetry-only shot once the hello left the strip');
  assert.equal(shot.jobs.length, 1);
  const [gs] = gsJobs(shot);
  assert.equal(gs.session, vm.evaluate('ClaudeWoWDB.session'));
  assert.equal(gs.chat, '');
  assert.equal(gs.kind, 'gs');
  assert.equal(gs.hello, false);
  assert.equal(gs.name, CHARACTER, 'the record names its character');
  assert.ok(gs.id >= vm.num('time()') - 1, 'the sequence is clock based, so a crash that lost the saved counter never goes back');
  assert.equal(vm.num('ClaudeWoWDB.lastSeq'), lastSeq, 'no message id was spent');
  assert.equal(vm.num('ClaudeWoWDB.telemetry.seq'), gs.id);
  const r = sectionsOf(gs);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(Object.keys(r.sections), ['cap', 'level', 'zone', 'money', 'items', 'skills', 'equip', 'factions', 'life', 'recipes']);
  assert.deepEqual(r.sections.cap.value, { missing: [] });
  assert.deepEqual(r.sections.money.value, { copper: 12345 });
  assert.deepEqual(r.sections.level.value, { level: 23, xp: 1234, xpMax: 5000 });
  assert.deepEqual(r.sections.zone.value, { mapID: 1431 });
  assert.deepEqual(r.sections.items.value, { free: 5, counts: { 2589: 12 } });
  assert.deepEqual(r.sections.skills.value, { skills: { 393: { rank: 75, max: 75 }, 129: { rank: 40, max: 75 } } });
  assert.deepEqual(r.sections.equip.value, { slots: { 1: 16707, 16: 2140 } });
  assert.deepEqual(r.sections.factions.value, { factions: { 530: { reaction: 5, standing: 3000 } } });
  assert.ok(Buffer.byteLength(gs.text) <= TL.RECORD_TEXT_MAX);
});

test('telemetry stays out of run.outbound: no ack wait, no retry, no pixelFailed, no keypress reload', () => {
  const vm = ready();
  assert.ok(gsJobs(shoot(vm)).length, 'the first record');
  const shots = vm.num('STUB.screenshots');
  const armedAtLogin = vm.num('ARMED');
  for (let i = 0; i < 10; i++) { vm.run('STUB.FireEvent("PLAYER_MONEY")'); tick(vm, 41); }
  assert.equal(vm.num('STUB.screenshots'), shots, 'an unacknowledged record is never shot again');
  assert.equal(vm.evaluate('ClaudeWoW.IsConnected()'), 'true', 'pixelFailed was never set');
  assert.equal(vm.num('ARMED'), armedAtLogin, 'ArmAutoRefresh was never called after login');  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'false');
});

test('a telemetry-only shot comes at most once every 2 minutes; level up, death and a new recipe go at once', () => {
  const vm = ready();
  shoot(vm);
  vm.run('STUB.money = STUB.money + 5; STUB.FireEvent("PLAYER_MONEY")');
  tick(vm, 40);
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'false', 'a money tick waits for the 2-minute window');
  tick(vm, 81);
  const later = gsJobs(shoot(vm));
  assert.equal(later.length, 1, 'then it goes');
  assert.deepEqual(Object.keys(sectionsOf(later[0]).sections), ['money'], 'only what changed');
  const urgentCases = [
    ['level', 'STUB.level = 24; STUB.FireEvent("PLAYER_LEVEL_UP", 24)'],
    ['life', 'STUB.FireEvent("PLAYER_DEAD")'],
    ['recipes', 'STUB.FireEvent("NEW_RECIPE_LEARNED", 3275)'],
  ];
  for (const [section, fire] of urgentCases) {
    vm.run(fire);
    tick(vm, 5);
    const urgent = gsJobs(shoot(vm));
    assert.equal(urgent.length, 1, `${section} goes at once`);
    assert.ok(sectionsOf(urgent[0]).sections[section], `the record carries ${section}`);
  }
});

test('telemetry rides on a message shot after the message, at most once every 30 s, and never pushes a message out of the frame', () => {
  const vm = ready();
  shoot(vm);
  vm.run('STUB.money = STUB.money + 7');
  tick(vm, 10);
  vm.run('ClaudeWoW.Send("first question")');
  const early = shoot(vm);
  assert.ok(early.jobs.some(j => j.text === 'first question'));
  assert.deepEqual(gsJobs(early), [], 'inside 30 s of the last record nothing rides');
  tick(vm, 25);
  vm.run('ClaudeWoW.NewChat("Two")');
  const big = 'x'.repeat(MAX_PAYLOAD - 300);
  vm.run(`ClaudeWoW.Send("${big}")`);
  const full = shoot(vm);
  const message = full.jobs.find(j => j.text === big);
  assert.ok(message, 'the long message is on the strip whole');
  assert.ok(full.frame.len <= MAX_PAYLOAD, `the frame holds ${full.frame.len} bytes`);
  const rider = gsJobs(full)[0];
  assert.ok(rider, 'telemetry took the room that was left');
  assert.ok(full.frame.text.indexOf('kind=gs') > full.frame.text.indexOf(big), 'after the message');
  assert.ok(Object.keys(sectionsOf(rider).sections).length < 10, 'only the sections that fit');
});

test('telemetry is only offered the room the messages left, and a record bigger than that room is not drawn', () => {
  const vm = ready();
  shoot(vm);
  const big = 'y'.repeat(MAX_PAYLOAD - 300);
  vm.run('ROOMS = {}; ClaudeWoWTelemetry.Take = function(room, solo) table.insert(ROOMS, room); return string.rep("z", room + 1) end');
  vm.run(`ClaudeWoW.Send("${big}")`);
  const shot = shoot(vm);
  assert.ok(shot.jobs.find(j => j.text === big), 'the message is drawn whole');
  assert.ok(!shot.frame.text.includes('zzzz'), 'the oversized record was refused');
  const room = vm.num('ROOMS[#ROOMS]');
  assert.ok(room > 0, 'there was some room left');
  assert.ok(shot.frame.len + 1 + room <= MAX_PAYLOAD, `a record of ${room} bytes next to the ${shot.frame.len}-byte frame still fits`);
});

test('a record taken for a shot survives a redraw before the shot fires: two sends in one frame still carry it', () => {
  const vm = ready();
  shoot(vm);
  vm.run('STUB.money = STUB.money + 11');
  tick(vm, 31);
  vm.run('ClaudeWoW.Send("one"); ClaudeWoW.NewChat("Two"); ClaudeWoW.Send("two")');
  const shot = shoot(vm);
  assert.deepEqual(shot.jobs.filter(j => j.text === 'one' || j.text === 'two').map(j => j.text).sort(), ['one', 'two']);
  const [gs] = gsJobs(shot);
  assert.ok(gs, 'the record taken by the first redraw is still on the strip');
  assert.deepEqual(sectionsOf(gs).sections.money.value, { copper: 12345 + 11 });
});

test('the bridge being dark pauses telemetry: no telemetry-only shot and nothing riding the pixel-style strip', () => {
  const vm = ready();
  shoot(vm);
  const armed = vm.num('ARMED');
  nextSlot(vm, 'nil');
  vm.run('STUB.money = STUB.money + 9');
  tick(vm, 23 * 60);
  for (let i = 0; i < 3; i++) tick(vm, 130);
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'false', 'no shot while the bridge is down');
  vm.run('STUB.FireEvent("PLAYER_DEAD")');
  tick(vm, 5);
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'false', 'not even an importance-3 event');
  assert.equal(vm.num('ARMED'), armed);
});

test('at most 120 records an hour, even with importance-3 events', () => {
  const vm = ready();
  shoot(vm);
  let sent = 1;
  for (let i = 0; i < 130; i++) {
    vm.run('STUB.level = STUB.level + 1; STUB.FireEvent("PLAYER_LEVEL_UP")');
    tick(vm, 2);
    sent += gsJobs(shoot(vm)).length;
  }
  assert.equal(sent, 120);
});

test('a slot whose hash for a section differs from what was sent makes the addon send that section again; matching hashes send nothing', () => {
  const vm = ready();
  const [first] = gsJobs(shoot(vm));
  const lines = first.text.split('\n').slice(1).map(l => l.split(':'));
  const hashes = Object.fromEntries(lines.map(([name, hash]) => [name, hash]));
  const roundTrip = (luaHashes) => {
    vm.run('ClaudeWoW.Send("ping")');
    shoot(vm);
    const chat = vm.evaluate('ClaudeWoWDB.chats[1].id');
    const id = vm.num('ClaudeWoWDB.chats[1].pendingId');
    nextSlot(vm, slotBody(`{ v = 1, watch = { items = { 2589 }, factions = { 530 } }, chars = { { character = "${CHARACTER}", session = ClaudeWoWDB.session, seq = ${first.id}, hashes = { ${luaHashes} } } } }`, `, replies = { { chat = "${chat}", id = ${id}, status = "done", text = "pong" } }`));
    tick(vm, 6);
    assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].pendingId'), null, 'the reply came through the slot');
  };
  tick(vm, 61);
  roundTrip(Object.entries(hashes).map(([n, h]) => `${n} = "${h}"`).join(', '));
  tick(vm, 125);
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'false', 'the bridge has every section: nothing to send');
  roundTrip(Object.entries(hashes).map(([n, h]) => `${n} = "${n === 'money' ? '00000000' : h}"`).join(', '));
  const resent = gsJobs(shoot(vm));
  assert.equal(resent.length, 1);
  assert.deepEqual(Object.keys(sectionsOf(resent[0]).sections), ['money'], 'only the section the bridge has wrong');
});

test('the capability probe names the collection functions this client lacks', () => {
  const vm = ready({ extra: GAME_STUB + '\nC_Reputation = nil\nGetInventoryItemID = nil' });
  const [gs] = gsJobs(shoot(vm));
  const r = sectionsOf(gs);
  assert.deepEqual(r.sections.cap.value.missing, ['GetInventoryItemID', 'C_Reputation.GetFactionDataByID', 'C_Reputation.GetWatchedFactionData']);
  assert.equal(r.sections.factions, undefined, 'no reputation API, no section');
  assert.deepEqual(r.sections.equip.value, { slots: {} });
});

test('saved telemetry state is per character and bounded: the last 8 recipes, 20 characters, junk dropped at login', () => {
  const junk = Array.from({ length: 20 }, (_, i) => `{ id = ${i + 1}, t = 5 }`).join(', ');
  const others = Array.from({ length: 25 }, (_, i) => `["Alt${i}-TestRealm"] = { deaths = 1, lastDeath = 1, learned = {}, seen = ${i} }`).join(', ');
  const vm = ready({ saved: `ClaudeWoWDB = { telemetry = { seq = "x", junk = string.rep("y", 100), chars = { ${others}, ["${CHARACTER}"] = { deaths = -3, learned = { ${junk}, { id = "bad" } }, seen = 1000 }, [5] = {} } } }` });
  const mine = `ClaudeWoWDB.telemetry.chars["${CHARACTER}"]`;
  assert.equal(vm.evaluate('ClaudeWoWDB.telemetry.junk'), null);
  assert.equal(vm.num('ClaudeWoWDB.telemetry.seq') > 0, true);
  assert.equal(vm.num(`#${mine}.learned`), 8);
  assert.equal(vm.num(`${mine}.learned[1].id`), 13);
  assert.equal(vm.num(`${mine}.deaths`), 0);
  vm.run('N = 0; for k in pairs(ClaudeWoWDB.telemetry.chars) do N = N + 1 end');
  assert.equal(vm.num('N'), 20, 'the 20 most recently seen characters are kept');
  assert.equal(vm.evaluate('ClaudeWoWDB.telemetry.chars["Alt0-TestRealm"]'), null, 'the oldest go first');
  for (let i = 0; i < 12; i++) vm.run(`STUB.FireEvent("NEW_RECIPE_LEARNED", ${100 + i})`);
  assert.equal(vm.num(`#${mine}.learned`), 8);
  assert.equal(vm.num(`${mine}.learned[8].id`), 111);
});

test('deaths and recipes belong to the character: an alt on the same account starts at 0,0 after the main died', () => {
  const main = ready();
  shoot(main);
  main.run('STUB.FireEvent("PLAYER_DEAD"); STUB.FireEvent("NEW_RECIPE_LEARNED", 3275)');
  const deaths = main.num(`ClaudeWoWDB.telemetry.chars["${CHARACTER}"].deaths`);
  const lastDeath = main.num(`ClaudeWoWDB.telemetry.chars["${CHARACTER}"].lastDeath`);
  assert.equal(deaths, 1);
  const saved = `ClaudeWoWDB = { telemetry = { seq = 5, chars = { ["${CHARACTER}"] = { deaths = ${deaths}, lastDeath = ${lastDeath}, learned = { { id = 3275, t = ${lastDeath} } }, seen = ${lastDeath} } } } }`;
  const alt = ready({ saved, extra: GAME_STUB + '\nfunction UnitName(unit) return "Altchar" end' });
  const [gs] = gsJobs(shoot(alt));
  assert.equal(gs.name, 'Altchar-TestRealm');
  const r = sectionsOf(gs).sections;
  assert.deepEqual(r.life.value, { deaths: 0, lastDeath: 0 }, 'the main\'s death is not replayed for the alt');
  assert.deepEqual(r.recipes.value, { learned: [] });
  assert.equal(alt.num(`ClaudeWoWDB.telemetry.chars["${CHARACTER}"].deaths`), 1, 'the main keeps its own');
});

test('the record names the character with the key goals.js derives from the game context, so telemetry and goals share one folder', () => {
  for (const [extra, expected] of [['', 'Testchar-TestRealm'], ['\nfunction GetUnitName(unit, showServer) return "Bone Sleeve" end\nfunction UnitName(unit) return "Bone" end\nfunction GetRealmName() return "Forever Realm" end', 'Bone-ForeverRealm'], ['\nfunction GetRealmName() return "Forever\'s Realm" end', 'Testchar-ForeversRealm']]) {
    const vm = ready({ extra: GAME_STUB + extra });
    const [gs] = gsJobs(shoot(vm));
    const fromContext = G.characterOf(vm.evaluate('ClaudeWoW.GameContext()'));
    assert.equal(gs.name, fromContext.key, 'the same key goals.js reads off the Character line');
    assert.equal(gs.name, expected);
    assert.match(gs.name, TL.CHARACTER_KEY_RE);
  }
});

test('a record whose shot fails is sent again, and a message retry never carries a record', () => {
  const vm = ready();
  shoot(vm);
  tick(vm, 31);
  vm.run('STUB.money = STUB.money + 13; STUB.FireEvent("PLAYER_MONEY")');
  vm.run('ClaudeWoW.Send("will fail once")');
  vm.run('STUB.FireEvent("PLAYER_DEAD")');
  const failed = shoot(vm, 'SCREENSHOT_FAILED');
  assert.ok(gsJobs(failed).length, 'the record rode on the shot that failed');
  const retry = shoot(vm);
  assert.ok(retry.jobs.some(j => j.text === 'will fail once'), 'the message is shot again');
  assert.deepEqual(gsJobs(retry), [], 'nothing rides on a retry, even with an importance-3 event waiting');
  const chat = vm.evaluate('ClaudeWoWDB.chats[1].id');
  const id = vm.num('ClaudeWoWDB.chats[1].pendingId');
  nextSlot(vm, slotBody(GS, `, replies = { { chat = "${chat}", id = ${id}, status = "done", text = "ok" } }`));
  tick(vm, 6);
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].pendingId'), null);
  const [again] = gsJobs(shoot(vm));
  assert.ok(again, 'the record goes on a shot of its own');
  const sections = sectionsOf(again).sections;
  assert.deepEqual(sections.money.value, { copper: 12345 + 13 }, 'the money from the failed shot is sent again');
  assert.ok(sections.life, 'with the death');
});

test('a message shot called off before it fires takes its record with it, and that record is sent again later', () => {
  const vm = ready();
  shoot(vm);
  tick(vm, 31);
  vm.run('STUB.money = STUB.money + 17; STUB.FireEvent("PLAYER_MONEY")');
  vm.run('ClaudeWoW.Send("never mind")');
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'true');
  vm.run('ClaudeWoW.Cancel(ClaudeWoWDB.chats[1])');
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'false', 'a shot whose message was cancelled is not kept for its record');
  tick(vm, 125);
  const [later] = gsJobs(shoot(vm));
  assert.deepEqual(sectionsOf(later).sections.money.value, { copper: 12345 + 17 });
});

test('a slot that has seen the record but holds another hash makes the addon resend at once; one that has not seen it yet keeps the addon\'s own', () => {
  const vm = ready();
  const [first] = gsJobs(shoot(vm));
  const roundTrip = (seq, luaHashes) => {
    vm.run('ClaudeWoW.Send("ping")');
    shoot(vm);
    const chat = vm.evaluate('ClaudeWoWDB.chats[1].id');
    const id = vm.num('ClaudeWoWDB.chats[1].pendingId');
    nextSlot(vm, slotBody(`{ v = 1, watch = { items = { 2589 }, factions = { 530 } }, chars = { { character = "${CHARACTER}", session = ClaudeWoWDB.session, seq = ${seq}, hashes = { ${luaHashes} } } } }`, `, replies = { { chat = "${chat}", id = ${id}, status = "done", text = "pong" } }`));
    tick(vm, 6);
    assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].pendingId'), null);
  };
  roundTrip(first.id - 1, '');
  tick(vm, 125);
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'false', 'an older bridge seq within a minute: the record is probably on its way');
  const vm2 = ready();
  const [first2] = gsJobs(shoot(vm2));
  const hashes2 = Object.fromEntries(first2.text.split('\n').slice(1).map(l => l.split(':').slice(0, 2)));
  const wrong2 = Object.entries(hashes2).map(([n, h]) => `${n} = "${n === 'zone' ? '00000000' : h}"`).join(', ');
  tick(vm2, 10);
  vm2.run('ClaudeWoW.Send("ping")');
  shoot(vm2);
  const chat = vm2.evaluate('ClaudeWoWDB.chats[1].id');
  const id = vm2.num('ClaudeWoWDB.chats[1].pendingId');
  nextSlot(vm2, slotBody(`{ v = 1, watch = { items = { 2589 }, factions = { 530 } }, chars = { { character = "${CHARACTER}", session = ClaudeWoWDB.session, seq = ${first2.id}, hashes = { ${wrong2} } } } }`, `, replies = { { chat = "${chat}", id = ${id}, status = "done", text = "pong" } }`));
  tick(vm2, 6);
  tick(vm2, 110);
  const [resent] = gsJobs(shoot(vm2));
  assert.ok(resent, 'the bridge saw the record and holds another hash: sent again before the minute is up');
  assert.deepEqual(Object.keys(sectionsOf(resent).sections), ['zone']);
});

test('Inbox.lua at login brings the bridge\'s hashes, so only what changed goes out', () => {
  const probe = ready({ saved: 'ClaudeWoWDB = { session = "fixedsession" }' });
  const [first] = gsJobs(shoot(probe));
  const hashes = Object.entries(Object.fromEntries(first.text.split('\n').slice(1).map(l => l.split(':').slice(0, 2)))).map(([n, h]) => `${n} = "${h}"`).join(', ');
  const vm = newVM({ saved: 'ClaudeWoWDB = { session = "fixedsession", settings = { transport = "screenshot", stripLevels = { on = 255, off = 0, codec = 1 } } }' });
  vm.run(`ClaudeWoW_Inbox = { now = time(), cwd = "", transport = "screenshot", strip = { on = 255, off = 0 }, gs = { v = 1, watch = { items = { 2589 }, factions = { 530 } }, chars = { { character = "${CHARACTER}", session = "fixedsession", seq = ${first.id}, hashes = { ${hashes} } } } }, replies = {} }`);
  vm.run('STUB.money = STUB.money + 21');
  vm.run('STUB.FireEvent("ADDON_LOADED", "ClaudeWoW"); STUB.FireEvent("PLAYER_LOGIN")');
  vm.run('STUB.RunTimers()');
  const hello = shoot(vm);
  assert.ok(hello.jobs.some(j => j.hello));
  const [rider] = gsJobs(hello);
  assert.ok(rider, 'the capability came from Inbox.lua, before any slot');
  assert.deepEqual(Object.keys(sectionsOf(rider).sections), ['money'], 'only the section that changed since the bridge last heard');
});

test('the pump collects only after a change event or an importance-3 event', () => {
  const vm = ready();
  shoot(vm);
  vm.run('STUB.money = STUB.money + 23');
  tick(vm, 130);
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'false', 'no PLAYER_MONEY: nothing collected');
  vm.run('STUB.FireEvent("PLAYER_MONEY")');
  tick(vm, 5);
  const [gs] = gsJobs(shoot(vm));
  assert.deepEqual(sectionsOf(gs).sections.money.value, { copper: 12345 + 23 });
});

test('no telemetry-only shot while the player is typing', () => {
  const vm = ready();
  shoot(vm);
  vm.run('STUB.focus = ClaudeWoW.UI.input or CreateFrame("EditBox"); STUB.FireEvent("PLAYER_DEAD")');
  tick(vm, 130);
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'false', 'an edit box has the keyboard');
  vm.run('STUB.focus = nil');
  tick(vm, 5);
  assert.ok(gsJobs(shoot(vm)).length, 'it goes once the box lets go');
});

test('/claude config context off also stops telemetry', () => {
  const vm = ready({ saved: 'ClaudeWoWDB = { settings = { context = false } }' });
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'false');
  vm.run('STUB.FireEvent("PLAYER_DEAD")');
  tick(vm, 5);
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'false');
});

test('the Lua character key equals goals.js characterOf on the same game context, case by case', () => {
  const cases = [
    ['Bone', 'Forever'],
    ['Bone', 'Forever Realm'],
    ['Bone', "Forever's Realm"],
    ['Bone', 'Forever (PvP)'],
    ['Bone', 'A, B'],
    ['Bone', ''],
    ['Bone', null],
    ['Боне', 'Вечность'],
    ['Bóne', 'Éternité'],
    ['Bone', '  Spaced   Out  '],
  ];
  const vm = newVM();
  for (const [name, realm] of cases) {
    vm.run(`function UnitName(unit) return ${JSON.stringify(name)} end; function GetRealmName() return ${realm === null ? 'nil' : JSON.stringify(realm)} end`);
    const who = G.characterOf(vm.evaluate('ClaudeWoW.GameContext()'));
    assert.equal(vm.evaluate('ClaudeWoWTelemetry.CharacterKey()'), who ? who.key : null, `${name} / ${realm}`);
  }
  vm.run(`function UnitName(unit) return ${JSON.stringify('B'.repeat(70))} end; function GetRealmName() return "Forever" end`);
  assert.equal(vm.evaluate('ClaudeWoWTelemetry.CharacterKey()'), null, 'over 64 characters the addon sends no key');
  vm.run(`function UnitName(unit) return ${JSON.stringify('Б'.repeat(60))} end`);
  assert.equal(vm.evaluate('ClaudeWoWTelemetry.CharacterKey()'), null, 'the cap counts characters, not bytes');
  vm.run(`function UnitName(unit) return ${JSON.stringify('Б'.repeat(50))} end`);
  assert.equal(vm.evaluate('ClaudeWoWTelemetry.CharacterKey()'), `${'Б'.repeat(50)}-Forever`);
});

test('an urgent record whose shot fails stays urgent: the next shot goes at once', () => {
  const vm = ready();
  shoot(vm);
  vm.run('STUB.level = 24; STUB.FireEvent("PLAYER_LEVEL_UP", 24)');
  tick(vm, 5);
  const failed = shoot(vm, 'SCREENSHOT_FAILED');
  assert.ok(sectionsOf(gsJobs(failed)[0]).sections.level, 'the level-up record was on the failed shot');
  tick(vm, 5);
  const again = gsJobs(shoot(vm));
  assert.equal(again.length, 1, 'sent again within a tick, not after the 2-minute window');
  assert.ok(sectionsOf(again[0]).sections.level);
});

test('a slot that changes nothing for the addon does not wake the pump; a new watch list does', () => {
  const vm = ready();
  const [first] = gsJobs(shoot(vm));
  const luaHashes = first.text.split('\n').slice(1).map(l => l.split(':')).map(([n, h]) => `${n} = "${h}"`).join(', ');
  const roundTrip = (watchItems) => {
    vm.run('ClaudeWoW.Send("ping")');
    shoot(vm);
    const chat = vm.evaluate('ClaudeWoWDB.chats[1].id');
    const id = vm.num('ClaudeWoWDB.chats[1].pendingId');
    nextSlot(vm, slotBody(`{ v = 1, watch = { items = { ${watchItems} }, factions = { 530 } }, chars = { { character = "${CHARACTER}", session = ClaudeWoWDB.session, seq = ${first.id}, hashes = { ${luaHashes} } } } }`, `, replies = { { chat = "${chat}", id = ${id}, status = "done", text = "pong" } }`));
    tick(vm, 6);
    tick(vm, 2);
    vm.run('COLLECTED = 0; local sections = ClaudeWoWTelemetry.Sections; ClaudeWoWTelemetry.Sections = function(...) COLLECTED = COLLECTED + 1; return sections(...) end');
    tick(vm, 125);
  };
  tick(vm, 61);
  roundTrip('2589');
  assert.equal(vm.num('COLLECTED'), 0, 'same watch list, same hashes: nothing collected');
  roundTrip('2589, 2592');
  const [items] = gsJobs(shoot(vm));
  assert.deepEqual(Object.keys(sectionsOf(items).sections), ['items'], 'a new watch list is collected and sent');
});

test('change events never write the saved variables; only a death or a new recipe does', () => {
  const vm = ready();
  shoot(vm);
  const key = `ClaudeWoWDB.telemetry.chars["${CHARACTER}"]`;
  vm.run(`${key}.seen = 7`);
  for (const ev of ['PLAYER_MONEY', 'PLAYER_XP_UPDATE', 'ZONE_CHANGED_NEW_AREA', 'BAG_UPDATE_DELAYED', 'PLAYER_EQUIPMENT_CHANGED', 'SKILL_LINES_CHANGED', 'UPDATE_FACTION', 'PLAYER_LEVEL_UP']) vm.run(`STUB.FireEvent("${ev}")`);
  assert.equal(vm.num(`${key}.seen`), 7);
  vm.run('STUB.FireEvent("PLAYER_DEAD")');
  assert.ok(vm.num(`${key}.seen`) > 7);
});

test('when a record head does not fit the room left, the change still waits for a shot of its own', () => {
  const vm = ready();
  const [first] = gsJobs(shoot(vm));
  const luaHashes = first.text.split('\n').slice(1).map(l => l.split(':')).map(([n, h]) => `${n} = "${h}"`).join(', ');
  tick(vm, 31);
  vm.run('STUB.money = STUB.money + 29; STUB.FireEvent("PLAYER_MONEY")');
  vm.run('local take = ClaudeWoWTelemetry.Take; ClaudeWoWTelemetry.Take = function(room, solo) if not solo then return take(10, solo) end return take(room, solo) end');
  vm.run('ClaudeWoW.Send("tight frame")');
  assert.deepEqual(gsJobs(shoot(vm)), [], 'no room for even the head');
  const chat = vm.evaluate('ClaudeWoWDB.chats[1].id');
  const id = vm.num('ClaudeWoWDB.chats[1].pendingId');
  nextSlot(vm, slotBody(`{ v = 1, watch = { items = { 2589 }, factions = { 530 } }, chars = { { character = "${CHARACTER}", session = ClaudeWoWDB.session, seq = ${first.id}, hashes = { ${luaHashes} } } } }`, `, replies = { { chat = "${chat}", id = ${id}, status = "done", text = "ok" } }`));
  tick(vm, 6);
  tick(vm, 2);
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'false', 'inside the 2-minute window nothing goes yet');
  tick(vm, 90);
  const [solo] = gsJobs(shoot(vm));
  assert.ok(solo, 'the pending change still has a hint and goes on its own shot');
  assert.deepEqual(Object.keys(sectionsOf(solo).sections), ['money']);
});

test('a failing Screenshot() gets one urgent retry, then normal pacing: the third try waits for the 2-minute window', () => {
  const vm = ready();
  shoot(vm);
  vm.run('STUB.level = 24; STUB.FireEvent("PLAYER_LEVEL_UP", 24)');
  tick(vm, 5);
  assert.ok(gsJobs(shoot(vm, 'SCREENSHOT_FAILED')).length, 'first try, failed');
  assert.ok(gsJobs(shoot(vm, 'SCREENSHOT_FAILED')).length, 'the one urgent retry, failed again');
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'false', 'no third try at once');
  tick(vm, 5);
  tick(vm, 5);
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'false', 'nor on the next ticks');
  tick(vm, 125);
  const third = gsJobs(shoot(vm));
  assert.equal(third.length, 1, 'after the window the record goes again');
  assert.ok(sectionsOf(third[0]).sections.level);
});

test('the addon stops sending when the slot lists its own character key as refused', () => {
  const vm = ready({ gs: `{ v = 1, watch = { items = { 2589 }, factions = { 530 } }, chars = {}, refused = { "${CHARACTER}" } }` });
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'false', 'no telemetry-only shot for a refused key');
  vm.run('STUB.FireEvent("PLAYER_DEAD")');
  tick(vm, 130);
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'false');
  assert.equal(vm.evaluate('ClaudeWoWTelemetry.Active()'), 'false');
  const other = ready({ gs: '{ v = 1, watch = { items = { 2589 }, factions = { 530 } }, chars = {}, refused = { "Someone-Else" } }' });
  assert.ok(gsJobs(shoot(other)).length, 'another character\'s refused key does not stop this one');
});

test('the character line comes from ClaudeWoW.CharacterLine, the same text GameContext uses', () => {
  const vm = newVM();
  const line = vm.evaluate('ClaudeWoW.CharacterLine()');
  assert.ok(vm.evaluate('ClaudeWoW.GameContext()').split('\n').includes(`Character: ${line}`));
  vm.run('function UnitName() error("boom") end');
  assert.equal(vm.evaluate('ClaudeWoW.CharacterLine()'), null);
  assert.equal(vm.evaluate('ClaudeWoWTelemetry.CharacterKey()'), null);
});

test('an urgent event that changes nothing does not stay urgent: a later silent change waits for the gates', () => {
  const vm = ready();
  shoot(vm);
  vm.run('STUB.FireEvent("NEW_RECIPE_LEARNED")');
  tick(vm, 5);
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'false', 'nothing to record for a recipe event without an id');
  vm.run('STUB.money = STUB.money + 31');
  tick(vm, 5);
  tick(vm, 5);
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'false', 'a money change with no event is not shot at once');
});

test('Inbox.lua an hour old does not arm telemetry: nothing rides on the login hello', () => {
  const vm = newVM({ saved: 'ClaudeWoWDB = { settings = { transport = "screenshot", stripLevels = { on = 255, off = 0, codec = 1 } } }' });
  vm.run('ClaudeWoW_Inbox = { now = time() - 3600, cwd = "", transport = "screenshot", strip = { on = 255, off = 0 }, gs = { v = 1, watch = { items = {}, factions = {} }, chars = {} }, replies = {} }');
  vm.run('STUB.FireEvent("ADDON_LOADED", "ClaudeWoW"); STUB.FireEvent("PLAYER_LOGIN")');
  vm.run('STUB.RunTimers()');
  const hello = shoot(vm);
  assert.ok(hello.jobs.some(j => j.hello));
  assert.deepEqual(gsJobs(hello), [], 'a stale Inbox.lua is not a bridge that is listening');
  assert.equal(vm.evaluate('ClaudeWoWTelemetry.Active()'), 'false');
});

test('/claude config telemetry off stops telemetry and on starts it again', () => {
  const vm = ready();
  shoot(vm);
  vm.run('SlashCmdList.CLAUDE("config telemetry off")');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.telemetry'), 'false');
  vm.run('STUB.FireEvent("PLAYER_DEAD")');
  tick(vm, 130);
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'false', 'off: no shot even for a death');
  vm.run('ClaudeWoW.Send("still talking")');
  assert.deepEqual(gsJobs(shoot(vm)), [], 'off: nothing rides on messages');
  vm.run('SlashCmdList.CLAUDE("config telemetry on")');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.telemetry'), 'true');
  assert.equal(vm.evaluate('ClaudeWoWTelemetry.Status()'), 'on');
});

test('a newer urgent event keeps its own retry when an older urgent shot fails', () => {
  const vm = ready();
  shoot(vm);
  vm.run('STUB.level = 24; STUB.FireEvent("PLAYER_LEVEL_UP", 24)');
  tick(vm, 5);
  for (let i = 0; i < 2; i++) vm.run('local f = ClaudeWoWStrip; if f.shown and f.scripts.OnUpdate then f.scripts.OnUpdate(f, 0.016) end');
  vm.run('STUB.FireEvent("PLAYER_DEAD")');
  vm.run('STUB.FireEvent("SCREENSHOT_FAILED")');
  assert.ok(gsJobs(shoot(vm, 'SCREENSHOT_FAILED')).length, 'the death goes at once, and its shot fails too');
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'true', 'the death still has its one urgent retry');
});

test('a message waits behind a fired telemetry-only shot, then is shot at once after its own failure', () => {
  const vm = ready();
  const frames = () => { for (let i = 0; i < 2; i++) vm.run('local f = ClaudeWoWStrip; if f.shown and f.scripts.OnUpdate then f.scripts.OnUpdate(f, 0.016) end'); };
  frames();
  const shots = vm.num('STUB.screenshots');
  vm.run('ClaudeWoW.Send("queued behind")');
  frames();
  assert.equal(vm.num('STUB.screenshots'), shots, 'no second screenshot while the first is being written');
  vm.run('STUB.FireEvent("SCREENSHOT_SUCCEEDED")');
  vm.run('STUB.FireEvent("SCREENSHOT_FAILED")');
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'true', 'the message is up again at once after its failure');
  const frame = decodeStrip(vm);
  assert.ok(P.jobsFromStrip(frame.id, frame.text).some(j => j.text === 'queued behind'));
  frames();
  assert.equal(vm.num('STUB.screenshots'), shots + 1, 'and shot');
});

test('a late screenshot event from a timed-out shot never completes the next shot: a message drawn after the timeout is still shot', () => {
  const vm = ready();
  const frames = () => { for (let i = 0; i < 2; i++) vm.run('local f = ClaudeWoWStrip; if f.shown and f.scripts.OnUpdate then f.scripts.OnUpdate(f, 0.016) end'); };
  frames();
  const fired = vm.num('STUB.screenshots');
  vm.run('STUB.RunTimers()');
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'false', 'the telemetry-only shot timed out');
  vm.run('ClaudeWoW.Send("after a slow shot")');
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'true');
  frames();
  assert.equal(vm.num('STUB.screenshots'), fired, 'no second shot while the late event may still come');
  vm.run('STUB.FireEvent("SCREENSHOT_SUCCEEDED")');
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'true', 'the late event belongs to the old shot, not to the message');
  const frame = decodeStrip(vm);
  assert.ok(P.jobsFromStrip(frame.id, frame.text).some(j => j.text === 'after a slow shot'));
  frames();
  assert.equal(vm.num('STUB.screenshots'), fired + 1, 'the message is shot once the late event is in');
});

test('the player\'s own screenshot event while a message strip is still being drawn does not count as the message\'s shot', () => {
  const vm = ready();
  const frames = () => { for (let i = 0; i < 2; i++) vm.run('local f = ClaudeWoWStrip; if f.shown and f.scripts.OnUpdate then f.scripts.OnUpdate(f, 0.016) end'); };
  frames();
  vm.run('STUB.FireEvent("SCREENSHOT_SUCCEEDED")');
  vm.run('ClaudeWoW.Send("typed during a print screen")');
  const before = vm.num('STUB.screenshots');
  vm.run('STUB.FireEvent("SCREENSHOT_SUCCEEDED")');
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'true', 'the strip is still up');
  frames();
  assert.equal(vm.num('STUB.screenshots'), before + 1, 'and the message is shot');
});
