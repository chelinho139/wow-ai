local O = {}
ClaudeWoWObserved = O

O.VENDOR_ITEMS_MAX = 40
O.AH_QUOTES_MAX = 12
O.LOOT_ENTRIES_MAX = 8
O.LOOT_ITEMS_MAX = 6
O.LOOTED_GUIDS_MAX = 64
O.GATHER_SPELLS_MAX = 80
O.SPELL_WINDOW_SECONDS = 1
O.WINDOW_SECONDS = 2
O.AH_REPEAT_SECONDS = 300
O.AH_LIST = "list"
O.AH_PAGE_MAX = 50
O.AH_FIRST_PAGE = 0
O.AH_SEARCH_SECONDS = 15
O.AH_UI_ADDON = "Blizzard_AuctionUI"
O.AH_SEARCH_FUNCTION = "AuctionFrameBrowse_Search"
O.ITEM_LINK_SUFFIX_FIELD = 7
O.AH_LIST_COUNT = 3
O.AH_LIST_BUYOUT = 10
O.AH_LIST_ITEM_ID = 17
O.MERCHANT_PRICE = 3
O.MERCHANT_STACK = 4
O.MERCHANT_EXTENDED_COST = 8
O.MERCHANT_CURRENCY = 9
O.POSITION_SCALE = 1000
O.LOOT_SLOT_ITEM = 1
O.SOURCE_CODES = { Creature = "n", Vehicle = "n", GameObject = "o" }
O.FISHING_CODE = "f"
O.PROBES = {
	"GetMerchantNumItems",
	"GetMerchantItemID",
	{ "C_MerchantFrame.GetItemInfo", "GetMerchantItemInfo" },
	{ "C_AuctionHouse.GetBrowseResults", "GetAuctionItemInfo" },
	{ "C_AuctionHouse.GetCommoditySearchResultInfo", "GetNumAuctionItems" },
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
O.EVENTS = { "MERCHANT_SHOW", "AUCTION_HOUSE_BROWSE_RESULTS_UPDATED", "COMMODITY_SEARCH_RESULTS_UPDATED", "AUCTION_ITEM_LIST_UPDATE", "LOOT_READY", "LOOT_OPENED", "LOOT_CLOSED" }

local state = { vendor = nil, ah = {}, loot = {}, looted = {}, lootedOrder = {}, windowAt = nil, spell = nil, gather = {}, ahSearchAt = nil, ahHooked = false }

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

local function Quote(itemID, price, quantity)
	if not (WholeNumber(itemID) and itemID > 0 and WholeNumber(price) and price > 0) then return false end
	quantity = WholeNumber(quantity) or 0
	local now = time()
	for _, q in ipairs(state.ah) do
		if q.id == itemID and q.price == price and q.quantity == quantity and now - q.at < O.AH_REPEAT_SECONDS then return false end
	end
	Push(state.ah, { id = itemID, price = price, quantity = quantity, at = now }, O.AH_QUOTES_MAX)
	return true
end

function O.OnBrowse()
	local results = Try(C_AuctionHouse and C_AuctionHouse.GetBrowseResults)
	if type(results) ~= "table" then return end
	local added = false
	for i = 1, math.min(#results, O.AH_QUOTES_MAX) do
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

function O.LinkSuffix(link, itemID)
	link = PlainString(link)
	local body = link and link:match("|Hitem:([%-%d:]+)|h")
	if not body then return nil end
	local fields = {}
	for field in (body .. ":"):gmatch("([^:]*):") do fields[#fields + 1] = field end
	if tonumber(fields[1]) ~= itemID then return nil end
	return tonumber(fields[O.ITEM_LINK_SUFFIX_FIELD]) or 0
end

function O.OnPlayerSearch()
	local browse = AuctionFrameBrowse
	local firstPage = type(browse) == "table" and browse.page == O.AH_FIRST_PAGE
	state.ahSearchAt = firstPage and GetTime() or nil
end

function O.HookAuctionSearch()
	if state.ahHooked or type(hooksecurefunc) ~= "function" or type(_G[O.AH_SEARCH_FUNCTION]) ~= "function" then return end
	state.ahHooked = true
	hooksecurefunc(O.AH_SEARCH_FUNCTION, O.OnPlayerSearch)
end

local function PlayerSearchShown()
	if not state.ahSearchAt or GetTime() - state.ahSearchAt > O.AH_SEARCH_SECONDS then return false end
	return type(AuctionFrame) == "table" and type(AuctionFrame.IsShown) == "function" and AuctionFrame:IsShown() and true or false
end

function O.OnAuctionList()
	if type(GetNumAuctionItems) ~= "function" or type(GetAuctionItemInfo) ~= "function" then return end
	if not PlayerSearchShown() then return end
	local shown = WholeNumber(Try(GetNumAuctionItems, O.AH_LIST)) or 0
	if shown > O.AH_PAGE_MAX then return end
	local best, order = {}, {}
	for i = 1, shown do
		local r = Returns(GetAuctionItemInfo, O.AH_LIST, i)
		local count = r and WholeNumber(r[O.AH_LIST_COUNT + 1])
		local buyout = r and WholeNumber(r[O.AH_LIST_BUYOUT + 1])
		local itemID = r and WholeNumber(r[O.AH_LIST_ITEM_ID + 1])
		if count and count > 0 and buyout and buyout > 0 and itemID and itemID > 0 and buyout % count == 0
			and O.LinkSuffix(Try(GetAuctionItemLink, O.AH_LIST, i), itemID) == 0 then
			local unit = buyout / count
			local b = best[itemID]
			if not b then
				best[itemID] = { price = unit, quantity = count }
				order[#order + 1] = itemID
			elseif unit < b.price then
				b.price, b.quantity = unit, count
			elseif unit == b.price then
				b.quantity = b.quantity + count
			end
		end
	end
	local added = false
	for i = 1, math.min(#order, O.AH_QUOTES_MAX) do
		local id = order[i]
		if Quote(id, best[id].price, best[id].quantity) then added = true end
	end
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
	local ah = {}
	for _, q in ipairs(state.ah) do ah[#ah + 1] = Int(q.id) .. "=" .. Int(q.price) .. "/" .. Int(q.quantity) .. "@" .. Int(q.at) end
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
		if ... == O.AH_UI_ADDON then O.HookAuctionSearch() end
		return
	end
	if event == "PLAYER_LOGIN" then
		O.HookAuctionSearch()
		for _, name in ipairs(O.EVENTS) do pcall(frame.RegisterEvent, frame, name) end
		if not (frame.RegisterUnitEvent and pcall(frame.RegisterUnitEvent, frame, "UNIT_SPELLCAST_SUCCEEDED", "player")) then
			pcall(frame.RegisterEvent, frame, "UNIT_SPELLCAST_SUCCEEDED")
		end
		return
	end
	O.OnEvent(event, ...)
end)
