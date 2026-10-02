local O = {}
ClaudeWoWObserved = O

O.VENDOR_ITEMS_MAX = 40
O.AH_QUOTES_MAX = 50
O.AH_BROWSE_RESULTS_MAX = 12
O.AH_SECTION_BYTES = 1200
O.LOOT_ENTRIES_MAX = 8
O.LOOT_ITEMS_MAX = 6
O.LOOTED_GUIDS_MAX = 64
O.GATHER_SPELLS_MAX = 80
O.SPELL_WINDOW_SECONDS = 1
O.WINDOW_SECONDS = 2
O.AH_REPEAT_SECONDS = 300
O.MERCHANT_PRICE = 3
O.MERCHANT_STACK = 4
O.MERCHANT_EXTENDED_COST = 8
O.MERCHANT_CURRENCY = 9
O.POSITION_SCALE = 1000
O.LOOT_SLOT_ITEM = 1
O.SOURCE_CODES = { Creature = "n", Vehicle = "n", GameObject = "o" }
O.FISHING_CODE = "f"
O.AH_LIST = "list"
O.AH_PAGE_MAX = 50
O.AUCTION_NAME = 1
O.AUCTION_COUNT = 3
O.AUCTION_BUYOUT = 10
O.AUCTION_ITEM_ID = 17
O.AUCTION_HAS_ALL_INFO = 18
O.LINK_SUFFIX_FIELD = 7
O.ERA_AUCTION_API = { "QueryAuctionItems", "GetNumAuctionItems", "GetAuctionItemInfo", "GetAuctionItemLink", "CanSendAuctionQuery", "PlaceAuctionBid", "hooksecurefunc" }
O.ERA_HOOKS = { query = "QueryAuctionItems", bid = "PlaceAuctionBid", dequote = "DequoteString", search = "AuctionFrameBrowse_Search" }
O.PROBES = {
	"GetMerchantNumItems",
	"GetMerchantItemID",
	{ "C_MerchantFrame.GetItemInfo", "GetMerchantItemInfo" },
	{ "C_AuctionHouse.GetBrowseResults", O.ERA_AUCTION_API },
	{ "C_AuctionHouse.GetCommoditySearchResultInfo", O.ERA_AUCTION_API },
	"GetNumLootItems",
	"GetLootSlotType",
	"GetLootSlotLink",
	"GetLootSourceInfo",
	"GetLootSlotInfo",
	"IsFishingLoot",
	"C_Map.GetPlayerMapPosition",
	"UnitGUID",
	"UnitIsDead",
}
O.EVENTS = { "MERCHANT_SHOW", "AUCTION_HOUSE_BROWSE_RESULTS_UPDATED", "COMMODITY_SEARCH_RESULTS_UPDATED", "AUCTION_ITEM_LIST_UPDATE", "AUCTION_HOUSE_CLOSED", "LOOT_READY", "LOOT_OPENED", "LOOT_CLOSED" }
O.debug = { ah = nil, ahUnsent = 0 }

local state = { vendor = nil, ah = {}, loot = {}, looted = {}, lootedOrder = {}, windowAt = nil, spell = nil, gather = {}, queries = 0, lastQuery = nil, before = nil, playerQuery = nil, hooked = {} }

local function Try(fn, ...)
	if type(fn) ~= "function" then return nil end
	local ok, a, b, c, d, e, f, g, h = pcall(fn, ...)
	if ok then return a, b, c, d, e, f, g, h end
end

local function Returns(fn, ...)
	if type(fn) ~= "function" then return nil end
	local r = { pcall(fn, ...) }
	if r[1] then return r end
end

local function Int(n)
	return string.format("%d", math.floor(n))
end

local function WholeNumber(v)
	return type(v) == "number" and v >= 0 and v == math.floor(v) and v or nil
end

local function Secret(v)
	return type(issecretvalue) == "function" and Try(issecretvalue, v) and true or false
end

local function PlainString(v)
	return type(v) == "string" and not Secret(v) and v or nil
end

local function Active()
	return ClaudeWoWTelemetry and type(ClaudeWoWTelemetry.Observing) == "function" and ClaudeWoWTelemetry.Observing() and true or false
end

local function Changed()
	if ClaudeWoWTelemetry and type(ClaudeWoWTelemetry.Hint) == "function" then ClaudeWoWTelemetry.Hint() end
end

function O.SourceOf(guid)
	guid = PlainString(guid)
	if not guid then return nil end
	local kind, id = guid:match("^(%a+)%-%d+%-%d+%-%d+%-%d+%-(%d+)%-%x+$")
	local code = kind and O.SOURCE_CODES[kind]
	id = tonumber(id)
	if not code or not WholeNumber(id) or id <= 0 then return nil end
	return code, id
end

local function ItemIDFromLink(link)
	link = PlainString(link)
	local id = link and tonumber(link:match("|Hitem:(%d+)"))
	return WholeNumber(id) and id > 0 and id or nil
end

local function Place()
	local map = Try(C_Map and C_Map.GetBestMapForUnit, "player")
	if not (WholeNumber(map) and map > 0) then return "", "", "" end
	local pos = Try(C_Map.GetPlayerMapPosition, map, "player")
	local x, y
	if type(pos) == "table" then
		if type(pos.GetXY) == "function" then x, y = Try(pos.GetXY, pos) else x, y = pos.x, pos.y end
	end
	if type(x) ~= "number" or type(y) ~= "number" or Secret(x) or Secret(y) or x < 0 or x > 1 or y < 0 or y > 1 then return Int(map), "", "" end
	return Int(map), Int(x * O.POSITION_SCALE + 0.5), Int(y * O.POSITION_SCALE + 0.5)
end

local function Push(list, entry, max)
	list[#list + 1] = entry
	while #list > max do table.remove(list, 1) end
end

local function ModernMerchant()
	return C_MerchantFrame and type(C_MerchantFrame.GetItemInfo) == "function"
end

local function MerchantOffer(i)
	if ModernMerchant() then
		local info = Try(C_MerchantFrame.GetItemInfo, i)
		if type(info) ~= "table" then return nil end
		return info.price, info.stackCount, info.hasExtendedCost or info.currencyID ~= nil
	end
	local r = Returns(GetMerchantItemInfo, i)
	if not r then return nil end
	return r[O.MERCHANT_PRICE + 1], r[O.MERCHANT_STACK + 1], r[O.MERCHANT_EXTENDED_COST + 1] or r[O.MERCHANT_CURRENCY + 1] ~= nil
end

function O.OnMerchant()
	if not (ModernMerchant() or type(GetMerchantItemInfo) == "function") then return end
	local code, npc = O.SourceOf(Try(UnitGUID, "npc"))
	if code ~= "n" then return end
	local count = WholeNumber(Try(GetMerchantNumItems)) or 0
	local parts = {}
	for i = 1, count do
		if #parts >= O.VENDOR_ITEMS_MAX then break end
		local id = Try(GetMerchantItemID, i)
		local price, stack, otherCost = MerchantOffer(i)
		if WholeNumber(id) and id > 0 and not otherCost and WholeNumber(price) and price > 0 then
			parts[#parts + 1] = Int(id) .. "=" .. Int(price) .. "/" .. Int(math.max(1, WholeNumber(stack) or 1))
		end
	end
	local map = Place()
	state.vendor = Int(npc) .. "@" .. Int(time()) .. "@" .. map .. ";" .. table.concat(parts, ",")
	Changed()
end

local function Quote(itemID, price, quantity, rows, stack)
	if not (WholeNumber(itemID) and itemID > 0 and WholeNumber(price) and price > 0) then return false end
	quantity = WholeNumber(quantity) or 0
	local now = time()
	for _, q in ipairs(state.ah) do
		if q.id == itemID and q.price == price and q.quantity == quantity and q.rows == rows and q.stack == stack and now - q.at < O.AH_REPEAT_SECONDS then return false end
	end
	Push(state.ah, { id = itemID, price = price, quantity = quantity, rows = rows, stack = stack, at = now }, O.AH_QUOTES_MAX)
	return true
end

function O.OnBrowse()
	local results = Try(C_AuctionHouse and C_AuctionHouse.GetBrowseResults)
	if type(results) ~= "table" then return end
	local added = false
	for i = 1, math.min(#results, O.AH_BROWSE_RESULTS_MAX) do
		local r = results[i]
		local key = type(r) == "table" and r.itemKey
		local plain = type(key) == "table" and (key.itemSuffix or 0) == 0 and (key.battlePetSpeciesID or 0) == 0
		if plain and Quote(key.itemID, r.minPrice, r.totalQuantity) then added = true end
	end
	if added then Changed() end
end

function O.OnCommodity(itemID)
	if not (WholeNumber(itemID) and itemID > 0) then return end
	local first = Try(C_AuctionHouse and C_AuctionHouse.GetCommoditySearchResultInfo, itemID, 1)
	if type(first) == "table" and Quote(itemID, first.unitPrice, first.quantity) then Changed() end
end

function O.OnAuctionQuery(text, exact)
	state.queries = state.queries + 1
	state.lastQuery = { text = PlainString(text) or "", exact = exact and true or false }
end

function O.BeforeQuery()
	state.before = { at = GetTime(), count = state.queries, canSend = Try(CanSendAuctionQuery, O.AH_LIST) and true or false }
end

local function AsciiLower(s)
	return (s:gsub("[A-Z]", string.lower))
end

local function NonAscii(s)
	return s:find("[\128-\255]") ~= nil
end

function O.OnPlayerSearch()
	local before, now = state.before, GetTime()
	state.before = nil
	state.playerQuery = nil
	if not before or before.at ~= now or state.queries ~= before.count + 1 then
		O.debug.ah = "the search sent no query of its own"
		return
	end
	if not before.canSend then
		O.debug.ah = "the search was throttled"
		return
	end
	local query = state.lastQuery or { text = "", exact = false }
	local caseSensitive = NonAscii(query.text)
	state.playerQuery = { count = state.queries, text = caseSensitive and query.text or AsciiLower(query.text), exact = query.exact, caseSensitive = caseSensitive }
end

function O.OnBid()
	if state.playerQuery then O.debug.ah = "a bid or buyout was placed" end
	state.playerQuery = nil
end

local function Hook(key, fn)
	local name = O.ERA_HOOKS[key]
	if not state.hooked[key] and type(_G[name]) == "function" then state.hooked[key] = pcall(hooksecurefunc, name, fn) end
end

function O.AuctionHooked()
	local h = state.hooked
	return (h.query and h.bid and h.dequote and h.search) and true or false
end

function O.HookAuctionQueries()
	if type(hooksecurefunc) ~= "function" then return false end
	Hook("query", function(text, _, _, _, _, _, _, exact) O.OnAuctionQuery(text, exact) end)
	Hook("bid", function() O.OnBid() end)
	if state.hooked.query and state.hooked.bid then
		Hook("dequote", function() O.BeforeQuery() end)
		Hook("search", function() O.OnPlayerSearch() end)
	end
	return O.AuctionHooked()
end

function O.AuctionLinkItem(link)
	link = PlainString(link)
	local body = link and link:match("|Hitem:([^|]+)|h")
	if not body then return nil end
	local fields = {}
	for f in (body .. ":"):gmatch("([^:]*):") do fields[#fields + 1] = f end
	local id = tonumber(fields[1])
	if not (WholeNumber(id) and id > 0) then return nil end
	local suffix = fields[O.LINK_SUFFIX_FIELD]
	return id, suffix ~= nil and (suffix == "" or tonumber(suffix) == 0)
end

local function SkipList(reason, consume)
	O.debug.ah = reason
	if consume then state.playerQuery = nil end
end

local function NameMatches(name, search)
	if not search.caseSensitive then name = AsciiLower(name) end
	if search.exact then return name == search.text end
	return string.find(name, search.text, 1, true) ~= nil
end

local function AuctionRows(batch, search)
	local items, order = {}, {}
	for i = 1, batch do
		local r = Returns(GetAuctionItemInfo, O.AH_LIST, i)
		local id, plain = O.AuctionLinkItem(Try(GetAuctionItemLink, O.AH_LIST, i))
		local name = r and PlainString(r[O.AUCTION_NAME + 1])
		if not r or not r[O.AUCTION_HAS_ALL_INFO + 1] or not id or not name then return nil end
		if plain and not NameMatches(name, search) then return false end
		local count, buyout, reported = WholeNumber(r[O.AUCTION_COUNT + 1]), WholeNumber(r[O.AUCTION_BUYOUT + 1]), r[O.AUCTION_ITEM_ID + 1]
		if plain and count and count > 0 and buyout and (reported == nil or reported == id) then
			local it = items[id]
			if not it then
				it = { rows = 0, quantity = 0 }
				items[id] = it
				order[#order + 1] = id
			end
			it.rows = it.rows + 1
			it.quantity = it.quantity + count
			if buyout > 0 and (not it.buyout or buyout * it.count < it.buyout * count) then it.buyout, it.count = buyout, count end
		end
	end
	return items, order
end

function O.OnAuctionList()
	if not O.AuctionHooked() then return SkipList("query hooks not installed", true) end
	local search = state.playerQuery
	if not search then return SkipList("no player search waiting") end
	if search.count ~= state.queries then return SkipList("another query ran after the player's search", true) end
	if not (AuctionFrame and Try(AuctionFrame.IsShown, AuctionFrame)) then return SkipList("auction window not shown", true) end
	if search.text == "" then return SkipList("no search text to check the rows against", true) end
	local batch, total = Try(GetNumAuctionItems, O.AH_LIST)
	batch, total = WholeNumber(batch), WholeNumber(total)
	if not (batch and total) then return SkipList("no result count", true) end
	if total > batch or batch > O.AH_PAGE_MAX then return SkipList("result spans pages: " .. Int(total) .. " auctions, " .. Int(batch) .. " shown", true) end
	local items, order = AuctionRows(batch, search)
	if items == false then return SkipList(search.caseSensitive and "a row does not match the search text (case-sensitive: the search text is not ASCII)" or "a row does not match the search text", true) end
	if not items then return SkipList("a row has no item info yet") end
	state.playerQuery = nil
	local added = false
	for _, id in ipairs(order) do
		local it = items[id]
		if it.buyout and Quote(id, math.floor((it.buyout + it.count - 1) / it.count), it.quantity, it.rows, it.count) then added = true end
	end
	O.debug.ah = "read " .. Int(#order) .. " items from " .. Int(batch) .. " auctions"
	if added then Changed() end
end

local function Looted(guid)
	if state.looted[guid] then return true end
	state.looted[guid] = true
	Push(state.lootedOrder, guid, O.LOOTED_GUIDS_MAX)
	if #state.lootedOrder == O.LOOTED_GUIDS_MAX then
		local keep = {}
		for _, g in ipairs(state.lootedOrder) do keep[g] = true end
		state.looted = keep
	end
	return false
end

local function SpellBeforeLoot()
	local s = state.spell
	state.spell = nil
	if not s or GetTime() - s.at > O.SPELL_WINDOW_SECONDS then return 0 end
	return state.gather[s.id] or 0
end

local function Entry(code, id, spell, place, items)
	local parts = {}
	for _, it in ipairs(items) do
		if #parts >= O.LOOT_ITEMS_MAX then break end
		parts[#parts + 1] = Int(it.id) .. "=" .. Int(it.qty)
	end
	return code .. Int(id) .. "_" .. Int(spell) .. "@" .. Int(time()) .. "@" .. place[1] .. "@" .. place[2] .. "@" .. place[3] .. "@" .. table.concat(parts, "/")
end

local function AddItem(source, itemID, qty)
	if not itemID then return end
	for _, it in ipairs(source.items) do
		if it.id == itemID then it.qty = it.qty + qty return end
	end
	source.items[#source.items + 1] = { id = itemID, qty = qty }
end

local function LivingTarget()
	local guid = PlainString(Try(UnitGUID, "target"))
	if not guid or type(UnitIsDead) ~= "function" then return nil end
	local dead = Try(UnitIsDead, "target")
	if Secret(dead) or dead then return nil end
	return guid
end

function O.LootKeyed()
	return next(state.gather) ~= nil
end

function O.OnLoot()
	if not O.LootKeyed() then return end
	local now = GetTime()
	if state.windowAt and now - state.windowAt < O.WINDOW_SECONDS then return end
	state.windowAt = now
	local count = WholeNumber(Try(GetNumLootItems)) or 0
	local spell = SpellBeforeLoot()
	local place = { Place() }
	if Try(IsFishingLoot) then
		local map = tonumber(place[1])
		if not map then return end
		local fish = { items = {} }
		for slot = 1, count do
			if Try(GetLootSlotType, slot) == O.LOOT_SLOT_ITEM then
				local _, _, qty = Try(GetLootSlotInfo, slot)
				AddItem(fish, ItemIDFromLink(Try(GetLootSlotLink, slot)), WholeNumber(qty) or 1)
			end
		end
		Push(state.loot, Entry(O.FISHING_CODE, map, 0, place, fish.items), O.LOOT_ENTRIES_MAX)
		Changed()
		return
	end
	local sources, order = {}, {}
	for slot = 1, count do
		local itemID = Try(GetLootSlotType, slot) == O.LOOT_SLOT_ITEM and ItemIDFromLink(Try(GetLootSlotLink, slot)) or nil
		local info = { Try(GetLootSourceInfo, slot) }
		for k = 1, #info - 1, 2 do
			local guid, qty = PlainString(info[k]), WholeNumber(info[k + 1])
			local code, id = O.SourceOf(guid)
			if code then
				if not sources[guid] then
					sources[guid] = { code = code, id = id, items = {} }
					order[#order + 1] = guid
				end
				AddItem(sources[guid], itemID, qty and qty > 0 and qty or 1)
			end
		end
	end
	local alive = LivingTarget()
	local added = false
	for _, guid in ipairs(order) do
		if guid ~= alive and not Looted(guid .. "_" .. Int(spell)) then
			local s = sources[guid]
			Push(state.loot, Entry(s.code, s.id, spell, place, s.items), O.LOOT_ENTRIES_MAX)
			added = true
		end
	end
	if added then Changed() end
end

function O.SetGather(map)
	local gather, n = {}, 0
	for id, root in pairs(type(map) == "table" and map or {}) do
		if n >= O.GATHER_SPELLS_MAX then break end
		if WholeNumber(id) and id > 0 and WholeNumber(root) and root > 0 then
			gather[id] = root
			n = n + 1
		end
	end
	state.gather = gather
end

function O.OnSpell(unit, spellID)
	if unit ~= "player" or not (WholeNumber(spellID) and spellID > 0) then return end
	state.spell = { id = spellID, at = GetTime() }
end

function O.Sections()
	local ah, bytes = {}, 0
	for i = #state.ah, 1, -1 do
		local q = state.ah[i]
		local part = Int(q.id) .. "=" .. Int(q.price) .. "/" .. Int(q.quantity) .. "@" .. Int(q.at) .. (q.rows and q.stack and ("/" .. Int(q.rows) .. "/" .. Int(q.stack)) or "")
		if bytes + #part + 1 > O.AH_SECTION_BYTES then break end
		bytes = bytes + #part + 1
		table.insert(ah, 1, part)
	end
	O.debug.ahUnsent = #state.ah - #ah
	return { vendor = state.vendor, ah = #ah > 0 and table.concat(ah, ",") or nil, loot = #state.loot > 0 and table.concat(state.loot, ";") or nil }
end

function O.OnEvent(event, ...)
	if event == "LOOT_CLOSED" then
		state.windowAt = nil
		return
	end
	if event == "UNIT_SPELLCAST_SUCCEEDED" then
		local unit, _, spellID = ...
		return O.OnSpell(unit, spellID)
	end
	if event == "AUCTION_HOUSE_CLOSED" then
		state.playerQuery = nil
		return
	end
	if event == "AUCTION_ITEM_LIST_UPDATE" and not Active() then return SkipList("telemetry is not collecting", true) end
	if not Active() then return end
	if event == "MERCHANT_SHOW" then return O.OnMerchant() end
	if event == "AUCTION_HOUSE_BROWSE_RESULTS_UPDATED" then return O.OnBrowse() end
	if event == "COMMODITY_SEARCH_RESULTS_UPDATED" then return O.OnCommodity(...) end
	if event == "AUCTION_ITEM_LIST_UPDATE" then return O.OnAuctionList() end
	if event == "LOOT_READY" or event == "LOOT_OPENED" then return O.OnLoot() end
end

local frame = CreateFrame("Frame")
frame:RegisterEvent("PLAYER_LOGIN")
frame:RegisterEvent("ADDON_LOADED")
frame:SetScript("OnEvent", function(_, event, ...)
	if event == "ADDON_LOADED" then
		if O.HookAuctionQueries() then frame:UnregisterEvent("ADDON_LOADED") end
		return
	end
	if event == "PLAYER_LOGIN" then
		for _, name in ipairs(O.EVENTS) do pcall(frame.RegisterEvent, frame, name) end
		if not (frame.RegisterUnitEvent and pcall(frame.RegisterUnitEvent, frame, "UNIT_SPELLCAST_SUCCEEDED", "player")) then
			pcall(frame.RegisterEvent, frame, "UNIT_SPELLCAST_SUCCEEDED")
		end
		return
	end
	O.OnEvent(event, ...)
end)
