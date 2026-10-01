local T = {}
ClaudeWoWTelemetry = T

T.KIND = "gs"
T.VERSION = "gs1"
T.SLOT_VERSION = 1
T.RECORD_MAX = 1500
T.COALESCE_SECONDS = 30
T.SOLO_SECONDS = 120
T.HOUR_SECONDS = 3600
T.HOUR_CAP = 120
T.RESEND_AFTER = 60
T.PUMP_SECONDS = 5
T.LEARNED_MAX = 8
T.WATCH_ITEMS_MAX = 20
T.WATCH_FACTIONS_MAX = 10
T.EQUIP_SLOTS = 19
T.FIRST_BAG = 0
T.LAST_BAG = 4
T.GENERAL_BAG_FAMILY = 0
T.HASH_MOD = 65521
T.ORDER = { "cap", "level", "zone", "money", "items", "skills", "equip", "factions", "life", "recipes" }
T.PROBES = {
	"GetMoney",
	"UnitLevel",
	"UnitXP",
	"UnitXPMax",
	"C_Map.GetBestMapForUnit",
	"C_SkillInfo.GetNumSkillLines",
	"C_SkillInfo.GetSkillLineInfo",
	"C_Item.GetItemCount",
	"C_Container.GetContainerNumFreeSlots",
	"GetInventoryItemID",
	"C_Reputation.GetFactionDataByID",
	"C_Reputation.GetWatchedFactionData",
}
T.URGENT_EVENTS = { PLAYER_LEVEL_UP = true, PLAYER_DEAD = true, NEW_RECIPE_LEARNED = true }

local US = "\31"
local state = { bridge = false, known = {}, sentAt = {}, sent = {}, urgent = false, watch = { items = {}, factions = {} } }

local function Try(fn, ...)
	if type(fn) ~= "function" then return nil end
	local ok, a, b, c, d = pcall(fn, ...)
	if ok then return a, b, c, d end
end

local function Int(n)
	return string.format("%d", math.floor(n))
end

local function Lookup(name)
	local value = _G
	for part in string.gmatch(name, "[^%.]+") do
		if type(value) ~= "table" then return nil end
		value = value[part]
	end
	return value
end

local function Store()
	if type(ClaudeWoWDB) ~= "table" then return nil end
	if type(ClaudeWoWDB.telemetry) ~= "table" then ClaudeWoWDB.telemetry = {} end
	return ClaudeWoWDB.telemetry
end

local function WholeNumber(v)
	return type(v) == "number" and v >= 0 and v == math.floor(v) and v or nil
end

function T.Sanitize()
	local s = Store()
	if not s then return end
	local learned = {}
	for _, r in ipairs(type(s.learned) == "table" and s.learned or {}) do
		if type(r) == "table" and WholeNumber(r.id) and r.id > 0 and WholeNumber(r.t) then
			learned[#learned + 1] = { id = r.id, t = r.t }
		end
	end
	while #learned > T.LEARNED_MAX do table.remove(learned, 1) end
	ClaudeWoWDB.telemetry = { seq = WholeNumber(s.seq) or 0, deaths = WholeNumber(s.deaths) or 0, lastDeath = WholeNumber(s.lastDeath) or 0, learned = learned }
end

function T.Hash(s)
	local a, b = 1, 0
	for i = 1, #s do
		a = (a + s:byte(i)) % T.HASH_MOD
		b = (b + a) % T.HASH_MOD
	end
	return string.format("%04x%04x", b, a)
end

function T.Missing()
	local out = {}
	for _, name in ipairs(T.PROBES) do
		if type(Lookup(name)) ~= "function" then out[#out + 1] = name end
	end
	return out
end

local function IdList(raw, max)
	local out, seen = {}, {}
	for _, v in ipairs(type(raw) == "table" and raw or {}) do
		if WholeNumber(v) and v > 0 and not seen[v] and #out < max then
			seen[v] = true
			out[#out + 1] = v
		end
	end
	return out
end

local function Professions()
	local ids = ClaudeWoW and ClaudeWoW.PROFESSION_SKILL_IDS or {}
	local wanted = { [TRADE_SKILLS or "Professions"] = true, [SECONDARY_SKILLS or "Secondary Skills"] = true }
	local header, parts, seen = nil, {}, {}
	local lines = ClaudeWoW and ClaudeWoW.SkillLines and Try(ClaudeWoW.SkillLines) or {}
	for _, sk in ipairs(lines) do
		if sk.isHeader then
			header = sk.name
		elseif WholeNumber(sk.skillID) and sk.skillID > 0 and not seen[sk.skillID] and ((header and wanted[header]) or ids[sk.skillID]) then
			seen[sk.skillID] = true
			parts[#parts + 1] = Int(sk.skillID) .. "=" .. Int(WholeNumber(sk.rank) or 0) .. "/" .. Int(WholeNumber(sk.maxRank) or 0)
		end
	end
	return table.concat(parts, ",")
end

local function FreeSlots()
	if not (C_Container and type(C_Container.GetContainerNumFreeSlots) == "function") then return "" end
	local free = 0
	for bag = T.FIRST_BAG, T.LAST_BAG do
		local n, family = Try(C_Container.GetContainerNumFreeSlots, bag)
		if WholeNumber(n) and (family == nil or family == T.GENERAL_BAG_FAMILY) then free = free + n end
	end
	return Int(free)
end

local function Items()
	local parts = {}
	if C_Item and type(C_Item.GetItemCount) == "function" then
		for _, id in ipairs(state.watch.items) do
			local n = Try(C_Item.GetItemCount, id)
			if WholeNumber(n) then parts[#parts + 1] = Int(id) .. "=" .. Int(n) end
		end
	end
	return FreeSlots() .. ";" .. table.concat(parts, ",")
end

local function Equipment()
	local parts = {}
	for slot = 1, T.EQUIP_SLOTS do
		local id = Try(GetInventoryItemID, "player", slot)
		if WholeNumber(id) and id > 0 then parts[#parts + 1] = Int(slot) .. "=" .. Int(id) end
	end
	return table.concat(parts, ",")
end

local function Factions()
	if not C_Reputation then return nil end
	local ids = {}
	for _, id in ipairs(state.watch.factions) do ids[#ids + 1] = id end
	local bar = Try(C_Reputation.GetWatchedFactionData)
	if type(bar) == "table" and WholeNumber(bar.factionID) and bar.factionID > 0 then ids[#ids + 1] = bar.factionID end
	local parts, seen = {}, {}
	for _, id in ipairs(ids) do
		local f = not seen[id] and Try(C_Reputation.GetFactionDataByID, id)
		seen[id] = true
		if type(f) == "table" and WholeNumber(f.reaction) and type(f.currentStanding) == "number" and #parts < T.WATCH_FACTIONS_MAX + 1 then
			parts[#parts + 1] = Int(id) .. "=" .. Int(f.reaction) .. "/" .. Int(f.currentStanding)
		end
	end
	return table.concat(parts, ",")
end

local function Recipes(store)
	local parts = {}
	for _, r in ipairs(store.learned or {}) do parts[#parts + 1] = Int(r.id) .. "@" .. Int(r.t) end
	return table.concat(parts, ",")
end

function T.Sections()
	local store = Store() or {}
	local s = { cap = table.concat(T.Missing(), ",") }
	local copper = Try(GetMoney)
	if WholeNumber(copper) then s.money = Int(copper) end
	local level = Try(UnitLevel, "player")
	if WholeNumber(level) and level > 0 then
		s.level = Int(level) .. "," .. Int(WholeNumber(Try(UnitXP, "player")) or 0) .. "," .. Int(WholeNumber(Try(UnitXPMax, "player")) or 0)
	end
	local map = Try(C_Map and C_Map.GetBestMapForUnit, "player")
	if WholeNumber(map) and map > 0 then s.zone = Int(map) end
	s.skills = Professions()
	s.items = Items()
	s.equip = Equipment()
	s.factions = Factions()
	s.life = Int(store.deaths or 0) .. "," .. Int(store.lastDeath or 0)
	s.recipes = Recipes(store)
	return s
end

local function Enabled()
	return state.bridge and type(ClaudeWoWDB) == "table" and type(ClaudeWoWDB.session) == "string"
		and not (type(ClaudeWoWDB.settings) == "table" and ClaudeWoWDB.settings.context == false)
end

local function SentLastHour(now)
	local keep = {}
	for _, at in ipairs(state.sent) do
		if now - at < T.HOUR_SECONDS then keep[#keep + 1] = at end
	end
	state.sent = keep
	return #keep
end

function T.Allowed(now, solo)
	if SentLastHour(now) >= T.HOUR_CAP then return false end
	if state.urgent then return true end
	if state.lastAt and now - state.lastAt < T.COALESCE_SECONDS then return false end
	if solo and state.lastSoloAt and now - state.lastSoloAt < T.SOLO_SECONDS then return false end
	return true
end

function T.Record(room)
	local store = Store()
	if not store then return nil end
	local seq = math.max((WholeNumber(store.seq) or 0) + 1, time())
	local head = table.concat({ (ClaudeWoWDB.session:gsub("[\30\31]", " ")), "", Int(seq), "", "kind=" .. T.KIND, "", T.VERSION }, US)
	local limit = math.min(room, T.RECORD_MAX)
	if #head > limit then return nil end
	local sections = T.Sections()
	local lines, size, sent = {}, #head, {}
	for _, name in ipairs(T.ORDER) do
		local data = sections[name]
		if data then
			local hash = T.Hash(data)
			local line = "\n" .. name .. ":" .. hash .. ":" .. data
			if hash ~= state.known[name] and size + #line <= limit then
				lines[#lines + 1] = line
				size = size + #line
				sent[name] = hash
			end
		end
	end
	if next(sent) == nil then return nil end
	store.seq = seq
	return head .. table.concat(lines), sent
end

function T.Take(room, solo)
	if not Enabled() then return nil end
	local now = GetTime()
	if not T.Allowed(now, solo) then return nil end
	local rec, sent = T.Record(room)
	if not rec then return nil end
	state.lastAt = now
	if solo then state.lastSoloAt = now end
	state.urgent = false
	state.sent[#state.sent + 1] = now
	for name, hash in pairs(sent) do
		state.known[name] = hash
		state.sentAt[name] = now
	end
	return rec
end

function T.Sync(gs)
	if type(gs) ~= "table" or gs.v ~= T.SLOT_VERSION then
		state.bridge = false
		return
	end
	state.bridge = true
	local watch = type(gs.watch) == "table" and gs.watch or {}
	state.watch = { items = IdList(watch.items, T.WATCH_ITEMS_MAX), factions = IdList(watch.factions, T.WATCH_FACTIONS_MAX) }
	local mine = type(ClaudeWoWDB) == "table" and gs.session == ClaudeWoWDB.session and type(gs.hashes) == "table"
	local hashes = mine and gs.hashes or {}
	local now = GetTime()
	for _, name in ipairs(T.ORDER) do
		local at = state.sentAt[name]
		if not at or now - at >= T.RESEND_AFTER then
			local h = hashes[name]
			state.known[name] = type(h) == "string" and h or nil
		end
	end
end

function T.Active()
	return Enabled() and true or false
end

function T.Pump()
	if not Enabled() or not T.Allowed(GetTime(), true) then return end
	if ClaudeWoW and ClaudeWoW.TelemetryShot then ClaudeWoW.TelemetryShot() end
end

function T.OnEvent(event, ...)
	local store = Store()
	if not store then return end
	if event == "PLAYER_DEAD" then
		store.deaths = (WholeNumber(store.deaths) or 0) + 1
		store.lastDeath = time()
	elseif event == "NEW_RECIPE_LEARNED" then
		local id = ...
		if not (WholeNumber(id) and id > 0) then return end
		store.learned = type(store.learned) == "table" and store.learned or {}
		table.insert(store.learned, { id = id, t = time() })
		while #store.learned > T.LEARNED_MAX do table.remove(store.learned, 1) end
	end
	if T.URGENT_EVENTS[event] then state.urgent = true end
end

local frame = CreateFrame("Frame")
frame:RegisterEvent("PLAYER_LOGIN")
frame:SetScript("OnEvent", function(_, event, ...)
	if event == "PLAYER_LOGIN" then
		T.Sanitize()
		for name in pairs(T.URGENT_EVENTS) do pcall(frame.RegisterEvent, frame, name) end
		if C_Timer and C_Timer.NewTicker then C_Timer.NewTicker(T.PUMP_SECONDS, T.Pump) end
		return
	end
	T.OnEvent(event, ...)
end)
