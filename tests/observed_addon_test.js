'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');
const P = require('../bridge/protocol');
const TL = require('../bridge/telemetry');
const OB = require('../bridge/observed');

const ADDON = path.join(__dirname, '..', 'addon', 'ClaudeWoW');
const CELLS_PER_ROW = 200;
const CHARACTER = 'Testchar-TestRealm';
const NPC_GUID = 'Creature-0-4372-0-17-3100-00000ABCDE';
const OTHER_GUID = 'Creature-0-4372-0-17-3101-00000ABCDF';
const HERB_GUID = 'GameObject-0-4372-0-17-1617-00000ABCE0';

const GAME_STUB = `
local unpack = unpack or table.unpack
C_SkillInfo = { GetNumSkillLines = function() return 0 end, GetSkillLineInfo = function() return nil end }
C_Container = { GetContainerNumFreeSlots = function() return 0, 0 end }
C_Item.GetItemCount = function() return 0 end
function GetInventoryItemID() return nil end
C_Reputation = { GetFactionDataByID = function() return nil end, GetWatchedFactionData = function() return nil end }
GetCurrentKeyBoardFocus = function() return nil end
STUB.unitGUIDs = { npc = "${NPC_GUID}" }
function UnitGUID(unit) return STUB.unitGUIDs[unit] end
STUB.merchant = { { id = 501, price = 600, stack = 1 }, { id = 777, price = 50, stack = 1, ext = true }, { id = 505, price = 25, stack = 5 }, { id = 778, price = 9, stack = 1, currency = 1 } }
function GetMerchantNumItems() return #STUB.merchant end
function GetMerchantItemID(i) return STUB.merchant[i] and STUB.merchant[i].id end
C_MerchantFrame = { GetItemInfo = function(i) local m = STUB.merchant[i]; return m and { price = m.price, stackCount = m.stack, hasExtendedCost = m.ext or false, currencyID = m.currency } end }
STUB.ahCalls = {}
C_AuctionHouse = setmetatable({
  GetBrowseResults = function() return STUB.browse or {} end,
  GetCommoditySearchResultInfo = function(id, i) return STUB.commodity and STUB.commodity[i] end,
}, { __index = function(_, k) return function() table.insert(STUB.ahCalls, k) end end })
STUB.lootSlots = {}
function GetNumLootItems() return #STUB.lootSlots end
function GetLootSlotType(i) return STUB.lootSlots[i].kind end
function GetLootSlotLink(i) return STUB.lootSlots[i].link end
function GetLootSlotInfo(i) return nil, nil, STUB.lootSlots[i].qty end
function GetLootSourceInfo(i) return unpack(STUB.lootSlots[i].sources) end
function IsFishingLoot() return STUB.fishing or false end
function UnitIsDead(unit) return STUB.targetDead ~= false end
`;

function newVM({ extra = '', saved = '' } = {}) {
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
  run(GAME_STUB + extra);
  if (saved) run(saved);
  for (const f of ['Codec.lua', 'Inbox.lua', 'ClaudeWoW.lua', 'Telemetry.lua', 'Observed.lua']) run(fs.readFileSync(path.join(ADDON, f), 'utf8'), 'ClaudeWoW');
  return { run, evaluate, num: e => Number(evaluate(e)) };
}

function decodeStrip(vm) {
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
  const len = bytes[4] * 256 + bytes[5];
  return { id: bytes[2] * 256 + bytes[3], text: Buffer.from(bytes.slice(6, 6 + len)).toString('utf8') };
}

function shoot(vm) {
  if (vm.evaluate('ClaudeWoWStrip and ClaudeWoWStrip.shown') !== 'true') return null;
  for (let i = 0; i < 2; i++) vm.run('local f = ClaudeWoWStrip; if f.shown and f.scripts.OnUpdate then f.scripts.OnUpdate(f, 0.016) end');
  const frame = decodeStrip(vm);
  vm.run('STUB.FireEvent("SCREENSHOT_SUCCEEDED")');
  return P.jobsFromStrip(frame.id, frame.text);
}

function tick(vm, seconds) {
  vm.run(`STUB.now = STUB.now + ${seconds}; STUB.Tick()`);
}

function gsOf(jobs) {
  return (jobs || []).filter(j => j.kind === 'gs');
}

const GATHER_SPELL = 8613;
const GATHER_RANK = 8617;
const PICK_POCKET_LIKE = 921;
const GS_OBSERVED = `{ v = 1, watch = { items = {}, factions = {} }, chars = {}, obs = 1, gather = { [${GATHER_SPELL}] = ${GATHER_SPELL}, [${GATHER_RANK}] = ${GATHER_SPELL}, [2366] = 2366 } }`;
const GS_PLAIN = '{ v = 1, watch = { items = {}, factions = {} }, chars = {} }';

function ready({ gs = GS_OBSERVED, extra, saved } = {}) {
  const vm = newVM({ extra, saved });
  vm.run('STUB.FireEvent("ADDON_LOADED", "ClaudeWoW"); STUB.FireEvent("PLAYER_LOGIN")');
  vm.run('STUB.RunTimers()');
  vm.run(`STUB.onLoadAddOn = function(name) ClaudeWoW_SlotData = { now = time(), cwd = "", transport = "screenshot", strip = { on = 255, off = 0 }, gs = ${gs}, replies = {} } end`);
  tick(vm, 6);
  shoot(vm);
  tick(vm, 21);
  const first = gsOf(shoot(vm));
  assert.equal(first.length, 1, 'the first game state record went out');
  return vm;
}

function nextRecord(vm) {
  tick(vm, 125);
  const [gs] = gsOf(shoot(vm));
  return gs ? TL.parseRecord(gs.text) : null;
}

function lootSlot(itemID, qty, sources) {
  const link = itemID ? `"|cffffffff|Hitem:${itemID}::::::::20:::::|h[x]|h|r"` : 'nil';
  return `{ kind = ${itemID ? 1 : 2}, link = ${link}, qty = ${qty}, sources = { ${sources.map(s => (typeof s === 'string' ? `"${s}"` : s)).join(', ')} } }`;
}

test('an old bridge without the obs capability gets no observed section, and nothing is collected for it', () => {
  const vm = ready({ gs: GS_PLAIN });
  vm.run('STUB.FireEvent("MERCHANT_SHOW")');
  vm.run(`STUB.lootSlots = { ${lootSlot(501, 1, [NPC_GUID, 1])} }; STUB.FireEvent("LOOT_READY")`);
  vm.run('STUB.money = STUB.money + 5; STUB.FireEvent("PLAYER_MONEY")');
  const r = nextRecord(vm);
  assert.ok(r, 'a record still goes for the money change');
  assert.deepEqual(Object.keys(r.sections).filter(n => OB.SECTIONS.includes(n)), []);
  assert.equal(vm.evaluate('ClaudeWoWObserved.Sections().vendor'), null, 'the vendor window was not read');
  assert.equal(vm.evaluate('ClaudeWoWObserved.Sections().loot'), null, 'the loot window was not read');
});

test('observations collected while the bridge asked for them stay home once a slot stops asking', () => {
  const vm = ready();
  vm.run('STUB.FireEvent("MERCHANT_SHOW")');
  assert.ok(vm.evaluate('ClaudeWoWObserved.Sections().vendor'), 'the vendor window was read');
  vm.run(`ClaudeWoWTelemetry.Sync(${GS_PLAIN})`);
  vm.run('STUB.money = STUB.money + 5; STUB.FireEvent("PLAYER_MONEY")');
  const r = nextRecord(vm);
  assert.ok(r, 'a record goes for the money change');
  assert.equal(r.sections.vendor, undefined, 'no vendor section for a bridge that stopped asking');
});

test('a vendor window the player opened goes out as a vendor section: priced items only, read by the bridge into observed.jsonl', () => {
  const vm = ready();
  vm.run('STUB.FireEvent("MERCHANT_SHOW")');
  const r = nextRecord(vm);
  assert.ok(r && r.sections.vendor, 'the vendor section went out on a shot of its own');
  assert.deepEqual(r.errors, []);
  const visit = r.sections.vendor.value.visit;
  assert.equal(visit.npcID, 3100);
  assert.equal(visit.mapID, 1431);
  assert.deepEqual(visit.items, [{ itemID: 501, price: 600, stack: 1 }, { itemID: 505, price: 25, stack: 5 }], 'an extended-cost or currency item is left out');
  vm.run('STUB.unitGUIDs.npc = "Player-4372-0ABCDEF0"; STUB.FireEvent("MERCHANT_SHOW")');
  assert.equal(vm.evaluate('ClaudeWoWObserved.Sections().vendor').startsWith('3100@'), true, 'a window whose unit is not an NPC is not a vendor');
});

test('auction prices come only from results of searches the player ran; the addon never calls an auction house query', () => {
  const vm = ready();
  vm.run('STUB.browse = { { itemKey = { itemID = 501 }, minPrice = 1500, totalQuantity = 4 }, { itemKey = { itemID = 505 }, minPrice = 7, totalQuantity = 200 } }; STUB.FireEvent("AUCTION_HOUSE_BROWSE_RESULTS_UPDATED")');
  vm.run('STUB.commodity = { { itemID = 2589, unitPrice = 31, quantity = 80 } }; STUB.FireEvent("COMMODITY_SEARCH_RESULTS_UPDATED", 2589)');
  vm.run('STUB.FireEvent("AUCTION_HOUSE_BROWSE_RESULTS_UPDATED")');
  vm.run('STUB.browse = { { itemKey = { itemID = 4000, itemSuffix = 0 }, minPrice = 500, totalQuantity = 1 }, { itemKey = { itemID = 4000, itemSuffix = 1179 }, minPrice = 9000, totalQuantity = 1 } }');
  vm.run('STUB.FireEvent("AUCTION_HOUSE_BROWSE_RESULTS_UPDATED"); STUB.FireEvent("AUCTION_HOUSE_BROWSE_RESULTS_UPDATED")');
  const r = nextRecord(vm);
  assert.deepEqual(r.sections.ah.value.quotes.map(q => [q.itemID, q.price, q.quantity]), [[501, 1500, 4], [505, 7, 200], [2589, 31, 80], [4000, 500, 1]], 'results seen again are not counted twice, and a suffix variant is never priced as the item');
  for (let i = 0; i < 30; i++) tick(vm, 60);
  assert.equal(vm.evaluate('#STUB.ahCalls'), '0', 'no search, refresh or purchase call from addon code, ever');
});

test('loot: one sample per source GUID with its items, money-only sources count, a second loot event for the same window or corpse adds nothing', () => {
  const vm = ready();
  vm.run(`STUB.lootSlots = { ${lootSlot(501, 2, [NPC_GUID, 2])}, ${lootSlot(null, 0, [OTHER_GUID, 0])} }`);
  vm.run('STUB.FireEvent("LOOT_READY"); STUB.FireEvent("LOOT_OPENED", false, false)');
  vm.run('STUB.FireEvent("LOOT_CLOSED")');
  tick(vm, 3);
  vm.run('STUB.FireEvent("LOOT_READY")');
  const r = nextRecord(vm);
  const samples = r.sections.loot.value.samples;
  assert.deepEqual(samples.map(s => [s.source, s.items]), [
    [{ type: 'npc', id: 3100, spell: 0 }, { 501: 2 }],
    [{ type: 'npc', id: 3101, spell: 0 }, {}],
  ]);
  assert.deepEqual(samples[0].map, { id: 1431, x: 45.2, y: 67.8 });
});

test('loot after a cast within a second is keyed by that spell; a later loot of another corpse is not; container loot is skipped', () => {
  const vm = ready();
  vm.run(`STUB.FireEvent("UNIT_SPELLCAST_SUCCEEDED", "player", "Cast-1", 8613)`);
  vm.run(`STUB.lootSlots = { ${lootSlot(2318, 1, [NPC_GUID, 1])} }; STUB.FireEvent("LOOT_READY")`);
  vm.run('STUB.FireEvent("LOOT_CLOSED")');
  vm.run(`STUB.FireEvent("UNIT_SPELLCAST_SUCCEEDED", "target", "Cast-2", 1234)`);
  tick(vm, 2);
  vm.run(`STUB.lootSlots = { ${lootSlot(2318, 1, [OTHER_GUID, 1])} }; STUB.FireEvent("LOOT_READY")`);
  vm.run('STUB.FireEvent("LOOT_CLOSED")');
  tick(vm, 3);
  vm.run(`STUB.lootSlots = { ${lootSlot(5523, 1, ['Item-4372-0-400000000ABCDEF', 1])} }; STUB.FireEvent("LOOT_OPENED", false, true)`);
  vm.run('STUB.FireEvent("LOOT_CLOSED")');
  const r = nextRecord(vm);
  assert.deepEqual(r.sections.loot.value.samples.map(s => s.source), [{ type: 'npc', id: 3100, spell: 8613 }, { type: 'npc', id: 3101, spell: 0 }]);
});

test('a gather spell after kill loot on the same corpse is a second sample; a plain reopen adds nothing', () => {
  const vm = ready();
  vm.run(`STUB.lootSlots = { ${lootSlot(501, 1, [NPC_GUID, 1])} }; STUB.FireEvent("LOOT_READY"); STUB.FireEvent("LOOT_CLOSED")`);
  tick(vm, 3);
  vm.run(`STUB.FireEvent("UNIT_SPELLCAST_SUCCEEDED", "player", "Cast-3", ${GATHER_SPELL})`);
  vm.run(`STUB.lootSlots = { ${lootSlot(2318, 1, [NPC_GUID, 1])} }; STUB.FireEvent("LOOT_READY"); STUB.FireEvent("LOOT_CLOSED")`);
  tick(vm, 3);
  vm.run(`STUB.lootSlots = { ${lootSlot(2318, 1, [NPC_GUID, 1])} }; STUB.FireEvent("LOOT_READY"); STUB.FireEvent("LOOT_CLOSED")`);
  const r = nextRecord(vm);
  assert.deepEqual(r.sections.loot.value.samples.map(s => [s.source, s.items]), [
    [{ type: 'npc', id: 3100, spell: 0 }, { 501: 1 }],
    [{ type: 'npc', id: 3100, spell: GATHER_SPELL }, { 2318: 1 }],
  ]);
});

test('a loot window from the living target is a pick pocket: no sample and no mark, and the kill loot of that GUID later is recorded', () => {
  const vm = ready({ extra: `STUB.unitGUIDs.target = "${NPC_GUID}"\nSTUB.targetDead = false\nfunction UnitIsDead(unit) return unit == "target" and STUB.targetDead end` });
  vm.run(`STUB.FireEvent("UNIT_SPELLCAST_SUCCEEDED", "player", "Cast-4", ${PICK_POCKET_LIKE})`);
  vm.run(`STUB.lootSlots = { ${lootSlot(5374, 1, [NPC_GUID, 1])} }; STUB.FireEvent("LOOT_READY"); STUB.FireEvent("LOOT_CLOSED")`);
  tick(vm, 3);
  vm.run('STUB.targetDead = true');
  vm.run(`STUB.lootSlots = { ${lootSlot(501, 2, [NPC_GUID, 2])} }; STUB.FireEvent("LOOT_READY"); STUB.FireEvent("LOOT_CLOSED")`);
  const r = nextRecord(vm);
  assert.deepEqual(r.sections.loot.value.samples.map(s => [s.source, s.items]), [[{ type: 'npc', id: 3100, spell: 0 }, { 501: 2 }]]);
});

test('a finisher cast just before autoloot leaves the kill sample alone', () => {
  const vm = ready({ extra: `STUB.unitGUIDs.target = "${NPC_GUID}"\nfunction UnitIsDead(unit) return true end` });
  vm.run(`STUB.FireEvent("UNIT_SPELLCAST_SUCCEEDED", "player", "Cast-7", ${PICK_POCKET_LIKE})`);
  tick(vm, 0.3);
  vm.run(`STUB.lootSlots = { ${lootSlot(501, 1, [NPC_GUID, 1])} }; STUB.FireEvent("LOOT_READY"); STUB.FireEvent("LOOT_CLOSED")`);
  const r = nextRecord(vm);
  assert.deepEqual(r.sections.loot.value.samples.map(s => [s.source, s.items]), [[{ type: 'npc', id: 3100, spell: 0 }, { 501: 1 }]]);
});

test('one cast keys one window, a higher rank keys its first rank, and without a gather list no loot is read at all', () => {
  const vm = ready();
  vm.run(`STUB.FireEvent("UNIT_SPELLCAST_SUCCEEDED", "player", "Cast-6", ${GATHER_RANK})`);
  vm.run(`STUB.lootSlots = { ${lootSlot(2318, 1, [NPC_GUID, 1])} }; STUB.FireEvent("LOOT_READY"); STUB.FireEvent("LOOT_CLOSED")`);
  vm.run(`STUB.lootSlots = { ${lootSlot(2318, 1, [OTHER_GUID, 1])} }; STUB.FireEvent("LOOT_READY"); STUB.FireEvent("LOOT_CLOSED")`);
  const r = nextRecord(vm);
  assert.deepEqual(r.sections.loot.value.samples.map(s => s.source), [{ type: 'npc', id: 3100, spell: GATHER_SPELL }, { type: 'npc', id: 3101, spell: 0 }], 'two corpses in one second: only the first is the skinning');
  vm.run('ClaudeWoWTelemetry.Sync({ v = 1, watch = { items = {}, factions = {} }, chars = {}, obs = 1 })');
  assert.equal(vm.evaluate('ClaudeWoWObserved.LootKeyed()'), 'false');
  tick(vm, 3);
  vm.run(`STUB.lootSlots = { ${lootSlot(501, 1, ['Creature-0-4372-0-17-3300-00000ABD10', 1])} }; STUB.FireEvent("LOOT_READY"); STUB.FireEvent("LOOT_CLOSED")`);
  assert.doesNotMatch(vm.evaluate('ClaudeWoWObserved.Sections().loot'), /n3300_/, 'a bridge with no gather list gets no loot it could not key');
});

test('gathering objects and fishing are their own source types, one fishing window is one sample, and a secret GUID is never read', () => {
  const vm = ready({ extra: `function issecretvalue(v) return v == "${OTHER_GUID}" end` });
  vm.run(`STUB.lootSlots = { ${lootSlot(2447, 3, [HERB_GUID, 3])} }; STUB.FireEvent("LOOT_READY")`);
  vm.run('STUB.FireEvent("LOOT_CLOSED")');
  tick(vm, 3);
  vm.run(`STUB.fishing = true; STUB.lootSlots = { ${lootSlot(6303, 1, ['GameObject-0-4372-0-17-35591-00000ABCE1', 1])} }; STUB.FireEvent("LOOT_READY"); STUB.FireEvent("LOOT_OPENED", false, false)`);
  vm.run('STUB.FireEvent("LOOT_CLOSED"); STUB.fishing = false');
  tick(vm, 3);
  vm.run(`STUB.lootSlots = { ${lootSlot(501, 1, [OTHER_GUID, 1])} }; STUB.FireEvent("LOOT_READY")`);
  const r = nextRecord(vm);
  assert.deepEqual(r.sections.loot.value.samples.map(s => [s.source, s.items]), [
    [{ type: 'object', id: 1617, spell: 0 }, { 2447: 3 }],
    [{ type: 'fishing', id: 1431, spell: 0 }, { 6303: 1 }],
  ]);
});

test('the loot ring keeps the newest 8 samples, and telemetry off stops collecting', () => {
  const vm = ready();
  for (let i = 0; i < 11; i++) {
    vm.run(`STUB.lootSlots = { ${lootSlot(501, 1, [`Creature-0-4372-0-17-${4000 + i}-00000ABC${10 + i}`, 1])} }; STUB.FireEvent("LOOT_READY"); STUB.FireEvent("LOOT_CLOSED")`);
    tick(vm, 3);
  }
  const r = nextRecord(vm);
  assert.deepEqual(r.sections.loot.value.samples.map(s => s.source.id), [4003, 4004, 4005, 4006, 4007, 4008, 4009, 4010]);
  vm.run('SlashCmdList.CLAUDE("config telemetry off")');
  vm.run(`STUB.lootSlots = { ${lootSlot(501, 1, ['Creature-0-4372-0-17-5000-00000ABD00', 1])} }; STUB.FireEvent("LOOT_READY"); STUB.FireEvent("LOOT_CLOSED")`);
  assert.doesNotMatch(vm.evaluate('ClaudeWoWObserved.Sections().loot'), /n5000_/, 'off means the loot window is not read');
});

test('the capability probe names the observed functions this client lacks, only for a bridge that keeps them', () => {
  const vm = ready({ extra: 'GetLootSourceInfo = nil\nC_MerchantFrame = nil' });
  vm.run('ClaudeWoWTelemetry.Sync({ v = 1, watch = { items = {}, factions = {} }, chars = { { character = "x", session = "y", seq = 1, hashes = {} } }, obs = 1 })');
  assert.equal(vm.evaluate('table.concat(ClaudeWoWTelemetry.Missing(), ",")'), 'C_MerchantFrame.GetItemInfo,GetLootSourceInfo');
  vm.run('ClaudeWoWTelemetry.Sync({ v = 1, watch = { items = {}, factions = {} }, chars = {} })');
  assert.equal(vm.evaluate('table.concat(ClaudeWoWTelemetry.Missing(), ",")'), '');
});

test('round trip: the addon\'s observed sections land in observed.jsonl through the real bridge parser', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-observed-addon-'));
  try {
    const vm = ready();
    vm.run('STUB.FireEvent("MERCHANT_SHOW")');
    vm.run(`STUB.lootSlots = { ${lootSlot(501, 1, [NPC_GUID, 1])} }; STUB.FireEvent("LOOT_READY")`);
    tick(vm, 125);
    const [job] = gsOf(shoot(vm));
    const observed = OB.createObserved({ dir });
    const t = TL.createTelemetry({ dir, observed });
    const r = t.submit(job);
    assert.equal(r.status, 'applied');
    assert.equal(r.observed, 2);
    const lines = observed.lines(CHARACTER);
    assert.deepEqual(lines.map(l => l.kind).sort(), ['loot', 'vendor']);
    assert.ok(lines.every(l => l.trust === 'observed' && l.n === 1));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
