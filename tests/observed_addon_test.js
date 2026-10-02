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
const G = require('../bridge/goals');

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

const ERA_FACTION = 76;
const ERA_CLIENT = `
C_SkillInfo = nil
C_AuctionHouse = nil
C_MerchantFrame = { GetBuybackItemID = function() return nil end }
C_Reputation = { GetWatchedFactionData = function() return nil end }
function GetMerchantItemInfo(i)
  local m = STUB.merchant[i]
  if not m then return nil end
  return "Merchant Item " .. i, 134400, m.price, m.stack, -1, true, true, m.ext or false, m.currency
end
STUB.skillLines = {
  { "Professions", true }, { "Skinning", false, 187, 225 }, { "Weapon Skills", true }, { "Daggers", false, 100, 115 },
}
function GetNumSkillLines() return #STUB.skillLines end
function GetSkillLineInfo(i)
  local l = STUB.skillLines[i]
  if not l then return nil end
  return l[1], l[2], true, l[3] or 0, 0, 0, l[4] or 0, false, 0, 0, 0, 0, ""
end
function GetFactionInfoByID(id)
  local f = STUB.factions and STUB.factions[id]
  if not f then return nil end
  return "Faction " .. id, "", f.standing, 3000, 9000, f.value, false, true, false, false, true, false, false, f.reportedID or id, false, false
end
`;

function eraGs(factions = '') {
  return `{ v = 1, watch = { items = {}, factions = { ${factions} } }, chars = {}, obs = 1, gather = { [${GATHER_SPELL}] = ${GATHER_SPELL} } }`;
}

test('Classic Era vendor window: prices come from GetMerchantItemInfo, extended-cost and currency items are left out', () => {
  const vm = ready({ extra: ERA_CLIENT, gs: eraGs() });
  vm.run('STUB.FireEvent("MERCHANT_SHOW")');
  const r = nextRecord(vm);
  assert.ok(r && r.sections.vendor, 'the vendor section went out');
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.sections.vendor.value.visit.items, [{ itemID: 501, price: 600, stack: 1 }, { itemID: 505, price: 25, stack: 5 }]);
});

const ERA_AUCTION = `
STUB.ahQueries = {}
STUB.bids = 0
STUB.canSend = true
function QueryAuctionItems(text) table.insert(STUB.ahQueries, text or "") end
function CanSendAuctionQuery(kind) return kind == "list" and STUB.canSend end
function PlaceAuctionBid() STUB.bids = STUB.bids + 1 end
STUB.auctions = {}
function GetNumAuctionItems(kind)
  if kind ~= "list" then return 0, 0 end
  return #STUB.auctions, STUB.auctionTotal or #STUB.auctions
end
function GetAuctionItemInfo(kind, i)
  local a = kind == "list" and STUB.auctions[i]
  if not a then return nil end
  return a.name or "Test Cloth", 134400, a.count, 1, true, 10, nil, 5, 1, a.buyout, 0, false, nil, "Seller", nil, 0, a.reported or a.id, a.info ~= false
end
function GetAuctionItemLink(kind, i)
  local a = kind == "list" and STUB.auctions[i]
  if not a or a.noLink then return nil end
  return a.link or ("|cff1eff00|Hitem:" .. a.id .. ":0:0:0:0:0:" .. (a.suffix or 0) .. ":0:20|h[x]|h|r")
end
AuctionFrame = CreateFrame("Frame", "AuctionFrame")
BrowseName = CreateFrame("EditBox", "BrowseName")
BrowseName:SetText("cloth")
function STUB.LoadAuctionUI()
  function DequoteString(s)
    local inner = s:match('^"(.*)"$')
    return inner
  end
  function AuctionFrameBrowse_Search()
    local text = BrowseName:GetText()
    local exact = false
    local inner = DequoteString(text)
    if inner then exact, text = true, inner end
    QueryAuctionItems(text, 0, 0, 0, false, -1, false, exact, nil)
  end
  STUB.FireEvent("ADDON_LOADED", "Blizzard_AuctionUI")
end
`;

function auctionList(rows) {
  return `{ ${rows.map(r => `{ ${Object.entries(r).map(([k, v]) => `${k} = ${typeof v === 'string' ? JSON.stringify(v) : v}`).join(', ')} }`).join(', ')} }`;
}

function eraAuctionHouse({ extra = '', load = true } = {}) {
  const vm = ready({ extra: `${ERA_CLIENT}\n${ERA_AUCTION}\n${extra}`, gs: eraGs() });
  if (load) vm.run('if not AuctionFrameBrowse_Search then STUB.LoadAuctionUI() end');
  vm.run('AuctionFrame:Show()');
  return vm;
}

function playerSearch(vm, rows, total) {
  vm.run('AuctionFrameBrowse_Search()');
  return results(vm, rows, total);
}

function results(vm, rows, total) {
  vm.run(`STUB.auctions = ${auctionList(rows)}; STUB.auctionTotal = ${total === undefined ? 'nil' : total}; STUB.FireEvent("AUCTION_ITEM_LIST_UPDATE")`);
  return vm.evaluate('ClaudeWoWObserved.debug.ah');
}

function eraQuotes(vm) {
  const r = nextRecord(vm);
  return r && r.sections.ah ? r.sections.ah.value.quotes.map(q => [q.itemID, q.price, q.quantity, q.rows, q.stack]) : [];
}

test('Classic Era: a search the player ran is read once, as the lowest buyout per item rounded up, with every listed item, the auction rows and the winning stack; the addon queries nothing', () => {
  const vm = eraAuctionHouse();
  const reason = playerSearch(vm, [
    { id: 2589, count: 3, buyout: 100 },
    { id: 2589, count: 1, buyout: 35 },
    { id: 2589, count: 5, buyout: 0 },
    { id: 2592, count: 2, buyout: 101 },
    { id: 2593, count: 1, buyout: 0 },
  ]);
  assert.equal(reason, 'read 3 items from 5 auctions');
  assert.deepEqual(eraQuotes(vm), [[2589, 34, 9, 3, 3], [2592, 51, 2, 1, 2]], '100 for 3 is 33.4 per item, beats 35 for 1 and is shown as 34 from a stack of 3; 101 for 2 is 51 rounded up; a bid-only auction counts as listed but never as a price');
  assert.equal(vm.evaluate('#STUB.ahQueries'), '1', 'the only query is the player\'s own search');
});

test('Classic Era: every auction hook is a secure post-hook, installed whether the auction UI loads after the addon or before it, and ADDON_LOADED is dropped once they are in', () => {
  const late = eraAuctionHouse();
  for (const name of ['QueryAuctionItems', 'PlaceAuctionBid', 'DequoteString', 'AuctionFrameBrowse_Search']) {
    assert.equal(late.evaluate(`STUB.secureHooks[${name}] == true`), 'true', `${name} is wrapped by hooksecurefunc, never replaced`);
  }
  assert.equal(playerSearch(late, [{ id: 2589, count: 1, buyout: 40 }]), 'read 1 items from 1 auctions');
  late.run('RESULT = 0; for _, f in ipairs(STUB.frames) do if f.events.ADDON_LOADED and f.events.AUCTION_ITEM_LIST_UPDATE then RESULT = RESULT + 1 end end');
  assert.equal(late.evaluate('RESULT'), '0', 'the observed frame stops listening for ADDON_LOADED');
  const early = eraAuctionHouse({ extra: 'STUB.LoadAuctionUI()' });
  assert.equal(playerSearch(early, [{ id: 2589, count: 1, buyout: 40 }]), 'read 1 items from 1 auctions');
});

test('Classic Era: without the Blizzard search hooks nothing is read, and the reason says so', () => {
  const vm = eraAuctionHouse({ load: false });
  vm.run('QueryAuctionItems("cloth")');
  assert.equal(results(vm, [{ id: 2589, count: 1, buyout: 40 }]), 'query hooks not installed');
  assert.equal(vm.evaluate('ClaudeWoWObserved.Sections().ah'), null);
});

test('Classic Era: a query from another addon after the player\'s search means the list is not the player\'s, and nothing is stored', () => {
  const vm = eraAuctionHouse();
  vm.run('AuctionFrameBrowse_Search(); QueryAuctionItems("addon scan")');
  assert.equal(results(vm, [{ id: 2589, count: 1, buyout: 7 }]), 'another query ran after the player\'s search');
  assert.equal(results(vm, [{ id: 2589, count: 1, buyout: 7 }]), 'no player search waiting', 'the player\'s search is spent');
  assert.equal(vm.evaluate('ClaudeWoWObserved.Sections().ah'), null);
});

test('Classic Era: a search sent while queries are throttled arms nothing, so another addon\'s result in flight is not stored', () => {
  const vm = eraAuctionHouse();
  vm.run('QueryAuctionItems("addon scan"); STUB.canSend = false; AuctionFrameBrowse_Search()');
  assert.equal(vm.evaluate('ClaudeWoWObserved.debug.ah'), 'the search was throttled');
  assert.equal(results(vm, [{ id: 2589, count: 1, buyout: 7 }]), 'no player search waiting');
  vm.run('STUB.canSend = true');
  assert.equal(playerSearch(vm, [{ id: 2589, count: 1, buyout: 40 }]), 'read 1 items from 1 auctions');
  assert.deepEqual(eraQuotes(vm), [[2589, 40, 1, 1, 1]]);
});

test('Classic Era: a search call that sends no query of its own (the token page) or two queries arms nothing', () => {
  const noQuery = eraAuctionHouse({ extra: 'function DequoteString() return nil end\nfunction AuctionFrameBrowse_Search() DequoteString(BrowseName:GetText()) end' });
  noQuery.run('QueryAuctionItems("addon scan"); AuctionFrameBrowse_Search()');
  assert.equal(noQuery.evaluate('ClaudeWoWObserved.debug.ah'), 'the search sent no query of its own');
  assert.equal(results(noQuery, [{ id: 2589, count: 1, buyout: 7 }]), 'no player search waiting');
  const twice = eraAuctionHouse({ extra: 'function DequoteString() return nil end\nfunction AuctionFrameBrowse_Search() DequoteString(BrowseName:GetText()); QueryAuctionItems("cloth"); QueryAuctionItems("addon scan") end' });
  twice.run('AuctionFrameBrowse_Search()');
  assert.equal(twice.evaluate('ClaudeWoWObserved.debug.ah'), 'the search sent no query of its own');
  assert.equal(results(twice, [{ id: 2589, count: 1, buyout: 7 }]), 'no player search waiting');
  const token = eraAuctionHouse({ extra: 'function DequoteString() return nil end\nfunction AuctionFrameBrowse_Search() end' });
  token.run('QueryAuctionItems("addon scan"); AuctionFrameBrowse_Search()');
  assert.equal(token.evaluate('ClaudeWoWObserved.debug.ah'), 'the search sent no query of its own', 'the token page calls neither DequoteString nor a query');
  const stale = eraAuctionHouse({ extra: 'function DequoteString() return nil end\nfunction AuctionFrameBrowse_Search() QueryAuctionItems("cloth") end' });
  stale.run('DequoteString("cloth")');
  tick(stale, 1);
  stale.run('AuctionFrameBrowse_Search()');
  assert.equal(stale.evaluate('ClaudeWoWObserved.debug.ah'), 'the search sent no query of its own', 'a DequoteString call from an earlier frame does not vouch for this query');
  assert.equal(results(stale, [{ id: 2589, count: 1, buyout: 7 }]), 'no player search waiting');
});

test('Classic Era: a list update with no player search behind it (a query from the bid path or another addon) stores nothing, and a refire after a read adds nothing', () => {
  const vm = eraAuctionHouse();
  vm.run('QueryAuctionItems("bid path")');
  assert.equal(results(vm, [{ id: 2589, count: 1, buyout: 9 }]), 'no player search waiting');
  assert.equal(vm.evaluate('ClaudeWoWObserved.Sections().ah'), null);
  assert.equal(playerSearch(vm, [{ id: 2589, count: 1, buyout: 40 }]), 'read 1 items from 1 auctions');
  assert.equal(results(vm, [{ id: 2589, count: 1, buyout: 12 }]), 'no player search waiting', 'the update after a bid is not a second read');
  assert.deepEqual(eraQuotes(vm), [[2589, 40, 1, 1, 1]]);
});

test('Classic Era: a bid or buyout while the player\'s search still waits for its refire drops the search, so the refreshed list is not stored', () => {
  const vm = eraAuctionHouse();
  vm.run('AuctionFrameBrowse_Search()');
  assert.equal(results(vm, [{ id: 2589, count: 1, buyout: 40, noLink: true }]), 'a row has no item info yet');
  vm.run('PlaceAuctionBid("list", 1, 40)');
  assert.equal(vm.evaluate('STUB.bids'), '1', 'the hook kept the real bid call');
  assert.equal(vm.evaluate('ClaudeWoWObserved.debug.ah'), 'a bid or buyout was placed');
  assert.equal(results(vm, [{ id: 2589, count: 1, buyout: 60 }]), 'no player search waiting');
  assert.equal(vm.evaluate('ClaudeWoWObserved.Sections().ah'), null);
});

test('Classic Era: closing the auction house or reading while telemetry is off drops a waiting search', () => {
  const closed = eraAuctionHouse();
  closed.run('AuctionFrameBrowse_Search(); STUB.FireEvent("AUCTION_HOUSE_CLOSED")');
  assert.equal(results(closed, [{ id: 2589, count: 1, buyout: 40 }]), 'no player search waiting');
  const off = eraAuctionHouse();
  off.run('AuctionFrameBrowse_Search(); SlashCmdList.CLAUDE("config telemetry off")');
  assert.equal(results(off, [{ id: 2589, count: 1, buyout: 40 }]), 'telemetry is not collecting');
  off.run('SlashCmdList.CLAUDE("config telemetry on")');
  assert.equal(results(off, [{ id: 2589, count: 1, buyout: 40 }]), 'no player search waiting', 'the search was spent while off');
  assert.equal(off.evaluate('ClaudeWoWObserved.Sections().ah'), null);
});

test('Classic Era: every row must contain the player\'s search text, exactly for a quoted search; an empty search stores nothing', () => {
  const vm = eraAuctionHouse();
  assert.equal(playerSearch(vm, [{ id: 2589, count: 1, buyout: 40, name: 'Test Cloth' }, { id: 4306, count: 1, buyout: 9, name: 'Other Thing' }]), 'a row does not match the search text');
  assert.equal(vm.evaluate('ClaudeWoWObserved.Sections().ah'), null);
  vm.run('BrowseName:SetText("\\"Test Cloth\\"")');
  assert.equal(playerSearch(vm, [{ id: 2589, count: 1, buyout: 40, name: 'Test Cloth' }, { id: 2590, count: 1, buyout: 9, name: 'Bolt of Test Cloth' }]), 'a row does not match the search text', 'an exact search accepts only the exact name');
  assert.equal(playerSearch(vm, [{ id: 2589, count: 1, buyout: 40, name: 'test cloth' }]), 'read 1 items from 1 auctions', 'the match ignores case');
  vm.run('BrowseName:SetText("")');
  assert.equal(playerSearch(vm, [{ id: 2589, count: 1, buyout: 40 }]), 'no search text to check the rows against');
  assert.deepEqual(eraQuotes(vm), [[2589, 40, 1, 1, 1]]);
});

test('Classic Era: a result on more than one page, or a batch larger than one page, is not the market low and stores nothing', () => {
  const vm = eraAuctionHouse();
  const page = Array.from({ length: 50 }, () => ({ id: 2589, count: 1, buyout: 30 }));
  assert.equal(playerSearch(vm, page, 120), 'result spans pages: 120 auctions, 50 shown');
  const all = Array.from({ length: 60 }, () => ({ id: 2589, count: 1, buyout: 30 }));
  assert.equal(playerSearch(vm, all, 60), 'result spans pages: 60 auctions, 60 shown');
  assert.equal(vm.evaluate('ClaudeWoWObserved.Sections().ah'), null);
  assert.equal(playerSearch(vm, page, 50), 'read 1 items from 50 auctions', 'a full single page is complete');
});

test('Classic Era: a random-suffix row never prices the base item; links with zero, empty or missing suffix fields are told apart', () => {
  const vm = eraAuctionHouse();
  const reason = playerSearch(vm, [
    { id: 15210, count: 1, buyout: 900, suffix: 1179 },
    { id: 15210, count: 1, buyout: 800, suffix: -15 },
    { id: 15210, count: 1, buyout: 5000 },
    { id: 15211, count: 1, buyout: 4000, link: '|cff1eff00|Hitem:15211::::::::20:::::|h[x]|h|r' },
    { id: 15212, count: 1, buyout: 100, link: '|cff1eff00|Hitem:15212:0:0|h[x]|h|r' },
  ]);
  assert.equal(reason, 'read 2 items from 5 auctions');
  assert.deepEqual(eraQuotes(vm), [[15210, 5000, 1, 1, 1], [15211, 4000, 1, 1, 1]], 'suffix rows are skipped, and a link too short to show its suffix is not trusted');
});

test('Classic Era: a row whose reported item ID differs from its link, or whose count is 0, is not counted', () => {
  const vm = eraAuctionHouse();
  const reason = playerSearch(vm, [
    { id: 2589, count: 1, buyout: 5, reported: 2590 },
    { id: 2589, count: 0, buyout: 6 },
    { id: 2589, count: 2, buyout: 80 },
  ]);
  assert.equal(reason, 'read 1 items from 3 auctions');
  assert.deepEqual(eraQuotes(vm), [[2589, 40, 2, 1, 2]]);
});

test('Classic Era: a row with no link or without all its info stores nothing for the whole list until the refire', () => {
  const vm = eraAuctionHouse();
  vm.run('AuctionFrameBrowse_Search()');
  assert.equal(results(vm, [{ id: 2589, count: 1, buyout: 40 }, { id: 2592, count: 1, buyout: 5, noLink: true }]), 'a row has no item info yet');
  assert.equal(results(vm, [{ id: 2589, count: 1, buyout: 40 }, { id: 2592, count: 1, buyout: 5, info: false }]), 'a row has no item info yet');
  assert.equal(vm.evaluate('ClaudeWoWObserved.Sections().ah'), null);
  assert.equal(results(vm, [{ id: 2589, count: 1, buyout: 40 }, { id: 2592, count: 1, buyout: 5 }]), 'read 2 items from 2 auctions');
  assert.deepEqual(eraQuotes(vm), [[2589, 40, 1, 1, 1], [2592, 5, 1, 1, 1]]);
});

test('Classic Era: a full page of 50 items keeps 50 quotes; the section sends the newest that fit its byte budget and counts the rest', () => {
  const vm = eraAuctionHouse();
  const rows = Array.from({ length: 50 }, (_, i) => ({ id: 3000 + i, count: 1, buyout: 10 + i }));
  assert.equal(playerSearch(vm, rows), 'read 50 items from 50 auctions');
  const section = vm.evaluate('ClaudeWoWObserved.Sections().ah');
  assert.ok(section.length <= Number(vm.evaluate('ClaudeWoWObserved.AH_SECTION_BYTES')), `section is ${section.length} bytes`);
  const sent = section.split(',').length;
  assert.equal(Number(vm.evaluate('ClaudeWoWObserved.debug.ahUnsent')), 50 - sent, 'every quote left out is counted');
  assert.deepEqual(eraQuotes(vm).map(q => q[0]), rows.slice(50 - sent).map(r => r.id), 'the newest quotes go first');
  assert.equal(OB.parseAh(section).quotes.length, sent, 'the bridge parser accepts the whole section');
});

test('Classic Era: the name check reads the query\'s own text, compares ASCII case only, is case-sensitive for non-ASCII text, and skips suffix rows', () => {
  const vm = eraAuctionHouse();
  assert.equal(playerSearch(vm, [{ id: 2589, count: 1, buyout: 40, name: 'TEST CLOTH' }, { id: 15210, count: 1, buyout: 9, name: 'Other Thing', suffix: 1179 }]), 'read 1 items from 2 auctions', 'a suffix row is skipped before the name check');
  vm.run('BrowseName:SetText("tést")');
  assert.equal(playerSearch(vm, [{ id: 2590, count: 1, buyout: 50, name: 'Bolt of tést' }]), 'read 1 items from 1 auctions');
  assert.equal(playerSearch(vm, [{ id: 2590, count: 1, buyout: 50, name: 'Bolt of Tést' }]), 'a row does not match the search text (case-sensitive: the search text is not ASCII)', 'ASCII lowering would have matched this; non-ASCII text compares as typed');
  const fromArgs = eraAuctionHouse({ extra: 'function DequoteString() return nil end\nfunction AuctionFrameBrowse_Search() DequoteString("ignored"); QueryAuctionItems("cloth", 0, 0, 0, false, -1, false, true, nil) end' });
  assert.equal(playerSearch(fromArgs, [{ id: 2589, count: 1, buyout: 40, name: 'Bolt of Cloth' }]), 'a row does not match the search text', 'text and exact flag come from the query arguments');
  assert.equal(playerSearch(fromArgs, [{ id: 2589, count: 1, buyout: 40, name: 'Cloth' }]), 'read 1 items from 1 auctions');
});

test('Classic Era: results that arrive after the auction frame closed are not read', () => {
  const vm = eraAuctionHouse();
  vm.run('AuctionFrameBrowse_Search(); AuctionFrame:Hide()');
  assert.equal(results(vm, [{ id: 2589, count: 1, buyout: 40 }]), 'auction window not shown');
  assert.equal(vm.evaluate('ClaudeWoWObserved.Sections().ah'), null);
});

test('Classic Era round trip: the quote with its rows and stack lands in observed.jsonl through the real bridge parser', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-observed-era-ah-'));
  try {
    const vm = eraAuctionHouse();
    playerSearch(vm, [{ id: 2589, count: 3, buyout: 100 }, { id: 2589, count: 2, buyout: 70 }]);
    tick(vm, 125);
    const [job] = gsOf(shoot(vm));
    const observed = OB.createObserved({ dir });
    const t = TL.createTelemetry({ dir, observed });
    assert.equal(t.submit(job).status, 'applied');
    const [line] = observed.lines(CHARACTER).filter(l => l.kind === 'ah');
    assert.deepEqual([line.itemID, line.price, line.quantity, line.rows, line.stack, line.trust, line.n], [2589, 34, 5, 2, 3, 'observed', 1]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Classic Era skills: profession lines get their skill ID from the profession name table, other lines are left out', () => {
  const vm = ready({ extra: ERA_CLIENT, gs: eraGs() });
  assert.equal(vm.evaluate('ClaudeWoWTelemetry.Sections().skills'), '393=187/225');
  vm.run('STUB.skillLines[2][3] = 188; STUB.FireEvent("SKILL_LINES_CHANGED")');
  const r = nextRecord(vm);
  assert.deepEqual(r.sections.skills.value.skills, { 393: { rank: 188, max: 225 } });
});

test('the addon profession name table matches the bridge one', () => {
  const vm = ready({ extra: ERA_CLIENT, gs: eraGs() });
  vm.run('local parts = {}; for name, id in pairs(ClaudeWoW.PROFESSION_SKILL_NAMES) do parts[#parts + 1] = id .. "=" .. name end; table.sort(parts); RESULT = table.concat(parts, ",")');
  const bridge = Object.entries(G.PROFESSION_SKILL_IDS).map(([id, name]) => `${id}=${name}`).sort();
  assert.deepEqual(vm.evaluate('RESULT').split(','), bridge);
});

test('Classic Era factions: standing from GetFactionInfoByID, and a row for another faction is never reported', () => {
  const vm = ready({ extra: ERA_CLIENT, gs: eraGs(`${ERA_FACTION}, 81`) });
  vm.run(`STUB.factions = { [${ERA_FACTION}] = { standing = 5, value = 3200 }, [81] = { standing = 4, value = 10, reportedID = 530 } }`);
  vm.run('STUB.FireEvent("UPDATE_FACTION")');
  const r = nextRecord(vm);
  assert.deepEqual(r.sections.factions.value.factions, { [ERA_FACTION]: { reaction: 5, standing: 3200 } });
});

test('on Classic Era the capability probe counts the auction functions present only when the whole Era list API is there', () => {
  const vm = ready({ extra: `${ERA_CLIENT}\n${ERA_AUCTION}`, gs: eraGs() });
  assert.equal(vm.evaluate('table.concat(ClaudeWoWTelemetry.Missing(), ",")'), '');
  const partial = ready({ extra: `${ERA_CLIENT}\n${ERA_AUCTION}\nGetAuctionItemLink = nil`, gs: eraGs() });
  assert.equal(partial.evaluate('table.concat(ClaudeWoWTelemetry.Missing(), ",")'), 'C_AuctionHouse.GetBrowseResults,C_AuctionHouse.GetCommoditySearchResultInfo');
  const none = ready({ extra: `${ERA_CLIENT}\nGetMerchantItemInfo = nil\nGetFactionInfoByID = nil\nGetNumSkillLines = nil\nGetSkillLineInfo = nil`, gs: eraGs() });
  assert.equal(none.evaluate('table.concat(ClaudeWoWTelemetry.Missing(), ",")'), 'C_SkillInfo.GetNumSkillLines,C_SkillInfo.GetSkillLineInfo,C_Reputation.GetFactionDataByID,C_MerchantFrame.GetItemInfo,C_AuctionHouse.GetBrowseResults,C_AuctionHouse.GetCommoditySearchResultInfo', 'with neither API, the modern name is reported');
});
