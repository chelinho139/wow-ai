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
T.ORDER = { "cap", "level", "zone", "money", "items", "skills", "equip", "factions", "life", "recipes", "vendor", "ah", "loot" }
T.OBSERVED = { "vendor", "ah", "loot" }
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
	{ "C_Reputation.GetFactionDataByID", "GetFactionInfoByID" },
	"C_Reputation.GetWatchedFactionData",
}
T.URGENT_EVENTS = { PLAYER_LEVEL_UP = true, PLAYER_DEAD = true, NEW_RECIPE_LEARNED = true }
T.CHANGE_EVENTS = { "PLAYER_MONEY", "PLAYER_XP_UPDATE", "ZONE_CHANGED_NEW_AREA", "BAG_UPDATE_DELAYED", "PLAYER_EQUIPMENT_CHANGED", "SKILL_LINES_CHANGED", "UPDATE_FACTION" }
T.FACTION_STANDING = 3
T.FACTION_BAR_VALUE = 6
T.FACTION_ID = 14
T.CHARS_MAX = 20
T.KEY_MAX_CHARS = 64
T.KEY_MAX_BYTES = 256
T.INFLIGHT_MAX = 4
T.INBOX_MAX_AGE = 300

local US = "\31"
local state = { bridge = false, known = {}, sentAt = {}, sentSeq = {}, sent = {}, inflight = {}, urgent = false, urgentRestored = false, refusedMine = false, observed = false, hint = false, watch = { items = {}, factions = {} } }

local function Try(fn, ...)
	if type(fn) ~= "function" then return nil end
	local ok, a, b, c, d = pcall(fn, ...)
	if ok then return a, b, c, d end
end

local function Returns(fn, ...)
	if type(fn) ~= "function" then return nil end
	local r = { pcall(fn, ...) }
	if r[1] then return r end
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

local function WholeNumber(v)
	return type(v) == "number" and v >= 0 and v == math.floor(v) and v or nil
end

local function Trim(s)
	return (s:gsub("^%s+", ""):gsub("%s+$", ""))
end

local function CodePoints(s)
	local n = 0
	for i = 1, #s do
		local b = s:byte(i)
		if b < 128 or b >= 192 then n = n + 1 end
	end
	return n
end

function T.KeyFromCharacterLine(line)
	local name, rest = line:match("^([^%s,%(]+)(.*)$")
	if not name then return nil end
	local realm = ""
	local afterOn = rest:match("^%s+on(%s.*)$")
	local stop = afterOn and (afterOn:find("[,%(]") or (#afterOn + 1))
	local region = afterOn and afterOn:sub(2, stop - 1) or ""
	if afterOn and region ~= "" then
		realm = Trim(region)
	elseif not (rest:match("^%s*$") or rest:match("^%s*[,%(]")) then
		return nil
	end
	realm = realm:gsub("%s+", "")
	local key = (realm ~= "" and (name .. "-" .. realm) or name):gsub("[^%w_%-\128-\255]", "")
	if key == "" or CodePoints(key) > T.KEY_MAX_CHARS then return nil end
	return key
end

function T.CharacterKey()
	local line = ClaudeWoW and ClaudeWoW.CharacterLine and Try(ClaudeWoW.CharacterLine)
	if type(line) ~= "string" then return nil end
	line = Trim((line:gsub("[\30\31]", " ")))
	if line == "" then return nil end
	return T.KeyFromCharacterLine(line)
end

local function Root()
	if type(ClaudeWoWDB) ~= "table" then return nil end
	if type(ClaudeWoWDB.telemetry) ~= "table" then ClaudeWoWDB.telemetry = {} end
	local root = ClaudeWoWDB.telemetry
	if type(root.chars) ~= "table" then root.chars = {} end
	return root
end

local function CleanCharacter(c)
	local learned = {}
	for _, r in ipairs(type(c) == "table" and type(c.learned) == "table" and c.learned or {}) do
		if type(r) == "table" and WholeNumber(r.id) and r.id > 0 and WholeNumber(r.t) then
			learned[#learned + 1] = { id = r.id, t = r.t }
		end
	end
	while #learned > T.LEARNED_MAX do table.remove(learned, 1) end
	c = type(c) == "table" and c or {}
	return { deaths = WholeNumber(c.deaths) or 0, lastDeath = WholeNumber(c.lastDeath) or 0, learned = learned, seen = WholeNumber(c.seen) or 0 }
end

local function Mine()
	local root, key = Root(), T.CharacterKey()
	if not root or not key then return nil end
	if type(root.chars[key]) ~= "table" then root.chars[key] = CleanCharacter(nil) end
	local c = root.chars[key]
	c.seen = time()
	return c
end

function T.Sanitize()
	local root = Root()
	if not root then return end
	local list = {}
	for key, c in pairs(root.chars) do
		if type(key) == "string" and key ~= "" and #key <= T.KEY_MAX_BYTES then list[#list + 1] = { key = key, c = CleanCharacter(c) } end
	end
	table.sort(list, function(a, b) return a.c.seen > b.c.seen end)
	local chars = {}
	for i = 1, math.min(#list, T.CHARS_MAX) do chars[list[i].key] = list[i].c end
	ClaudeWoWDB.telemetry = { seq = WholeNumber(root.seq) or 0, chars = chars }
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
	local probes = { T.PROBES, state.observed and ClaudeWoWObserved and ClaudeWoWObserved.PROBES or {} }
	for _, list in ipairs(probes) do
		for _, name in ipairs(list) do
			local names = type(name) == "table" and name or { name }
			local found = false
			for _, n in ipairs(names) do
				if type(Lookup(n)) == "function" then found = true end
			end
			if not found then out[#out + 1] = names[1] end
		end
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

local function FactionStanding(id)
	if type(C_Reputation.GetFactionDataByID) == "function" then
		local f = Try(C_Reputation.GetFactionDataByID, id)
		if type(f) == "table" then return f.reaction, f.currentStanding end
		return nil
	end
	local r = Returns(GetFactionInfoByID, id)
	if not r or r[T.FACTION_ID + 1] ~= id then return nil end
	return r[T.FACTION_STANDING + 1], r[T.FACTION_BAR_VALUE + 1]
end

local function Factions()
	if not C_Reputation then return nil end
	local ids = {}
	for _, id in ipairs(state.watch.factions) do ids[#ids + 1] = id end
	local bar = Try(C_Reputation.GetWatchedFactionData)
	if type(bar) == "table" and WholeNumber(bar.factionID) and bar.factionID > 0 then ids[#ids + 1] = bar.factionID end
	local parts, seen = {}, {}
	for _, id in ipairs(ids) do
		local reaction, standing
		if not seen[id] then reaction, standing = FactionStanding(id) end
		seen[id] = true
		if WholeNumber(reaction) and type(standing) == "number" and #parts < T.WATCH_FACTIONS_MAX + 1 then
			parts[#parts + 1] = Int(id) .. "=" .. Int(reaction) .. "/" .. Int(standing)
		end
	end
	return table.concat(parts, ",")
end

local function Recipes(mine)
	local parts = {}
	for _, r in ipairs(mine.learned or {}) do parts[#parts + 1] = Int(r.id) .. "@" .. Int(r.t) end
	return table.concat(parts, ",")
end

function T.Sections()
	local mine = Mine() or CleanCharacter(nil)
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
	s.life = Int(mine.deaths or 0) .. "," .. Int(mine.lastDeath or 0)
	s.recipes = Recipes(mine)
	local observed = state.observed and ClaudeWoWObserved and Try(ClaudeWoWObserved.Sections)
	if type(observed) == "table" then
		for _, name in ipairs(T.OBSERVED) do
			if type(observed[name]) == "string" then s[name] = observed[name] end
		end
	end
	return s
end

local function Print(msg)
	if ClaudeWoW and type(ClaudeWoW.Print) == "function" then return ClaudeWoW.Print(msg) end
	print("|cff66ccff[Claude WoW]|r " .. msg)
end

function T.IsOn()
	return not (type(ClaudeWoWDB) == "table" and type(ClaudeWoWDB.settings) == "table" and ClaudeWoWDB.settings.telemetry == false)
end

function T.SetOn(on)
	if type(ClaudeWoWDB) ~= "table" then return end
	ClaudeWoWDB.settings = type(ClaudeWoWDB.settings) == "table" and ClaudeWoWDB.settings or {}
	ClaudeWoWDB.settings.telemetry = on and true or false
	if on then state.hint = true end
end

function T.Toggle()
	T.SetOn(not T.IsOn())
	T.Command("")
end

function T.Status()
	return T.IsOn() and "on" or "off"
end

function T.Command(rest)
	rest = tostring(rest or ""):lower()
	if rest == "on" or rest == "off" then T.SetOn(rest == "on") end
	if not T.IsOn() then
		Print("Game state telemetry is off: no game state, vendor, auction or loot records and no telemetry screenshots. /claude config telemetry on starts it again.")
		return
	end
	local extra = ""
	if T.Observing() then
		local loot = ClaudeWoWObserved and ClaudeWoWObserved.LootKeyed and ClaudeWoWObserved.LootKeyed()
		extra = loot and ", and the vendor prices, auction results and loot (with your map position) from windows you open" or ", and the vendor prices and auction results from windows you open (no loot: the bridge has no game data for this client)"
	end
	Print("Game state telemetry is on: money, level, zone, profession ranks, watched items, gear IDs, reputation, deaths and recipes" .. extra .. " go to the bridge on screenshots the addon takes anyway, plus one of its own at most every 2 minutes. /claude config telemetry off stops it.")
end

local function Enabled()
	return state.bridge and type(ClaudeWoWDB) == "table" and type(ClaudeWoWDB.session) == "string"
		and not (type(ClaudeWoWDB.settings) == "table" and ClaudeWoWDB.settings.context == false)
		and not state.refusedMine and T.IsOn()
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
	local root, key = Root(), T.CharacterKey()
	if not root or not key then return nil end
	local seq = math.max((WholeNumber(root.seq) or 0) + 1, time())
	local head = table.concat({ (ClaudeWoWDB.session:gsub("[\30\31]", " ")), "", Int(seq), "", "kind=" .. T.KIND, key, T.VERSION }, US)
	local limit = math.min(room, T.RECORD_MAX)
	if #head > limit then return nil, nil, true end
	local sections = T.Sections()
	local lines, size, sent, left = {}, #head, {}, false
	for _, name in ipairs(T.ORDER) do
		local data = sections[name]
		if data then
			local hash = T.Hash(data)
			local line = "\n" .. name .. ":" .. hash .. ":" .. data
			if hash ~= state.known[name] then
				if size + #line <= limit then
					lines[#lines + 1] = line
					size = size + #line
					sent[name] = hash
				else
					left = true
				end
			end
		end
	end
	if next(sent) == nil then return nil, nil, left end
	root.seq = seq
	return head .. table.concat(lines), sent, left, seq
end

function T.Take(room, solo)
	if not Enabled() then return nil end
	if solo and Try(GetCurrentKeyBoardFocus) then return nil end
	local now = GetTime()
	if not T.Allowed(now, solo) then return nil end
	local rec, sent, left, seq = T.Record(room)
	state.hint = left and true or false
	if not rec then
		if not left then state.urgent = false end
		return nil
	end
	state.lastAt = now
	if solo then state.lastSoloAt = now end
	local restoreUrgent = state.urgent and not state.urgentRestored
	state.urgentRestored = false
	state.urgent = false
	state.sent[#state.sent + 1] = now
	for name, hash in pairs(sent) do
		state.known[name] = hash
		state.sentAt[name] = now
		state.sentSeq[name] = seq
	end
	table.insert(state.inflight, { rec = rec, sent = sent, urgent = restoreUrgent })
	while #state.inflight > T.INFLIGHT_MAX do table.remove(state.inflight, 1) end
	return rec
end

local function Settle(rec, lost)
	for i, f in ipairs(state.inflight) do
		if f.rec == rec then
			table.remove(state.inflight, i)
			if lost then
				for name, hash in pairs(f.sent) do
					if state.known[name] == hash then
						state.known[name] = nil
						state.sentAt[name] = nil
						state.sentSeq[name] = nil
					end
				end
				state.hint = true
				if f.urgent and not state.urgent then
					state.urgent = true
					state.urgentRestored = true
				end
			end
			return true
		end
	end
	return false
end

function T.Delivered(rec)
	return Settle(rec, false)
end

function T.Lost(rec)
	return Settle(rec, true)
end

local function Entry(gs)
	local key = T.CharacterKey()
	local session = type(ClaudeWoWDB) == "table" and ClaudeWoWDB.session
	for _, e in ipairs(type(gs.chars) == "table" and gs.chars or {}) do
		if type(e) == "table" and e.character == key and e.session == session and type(e.hashes) == "table" then return e end
	end
	return nil
end

function T.Sync(gs)
	if type(gs) ~= "table" or gs.v ~= T.SLOT_VERSION then
		state.bridge = false
		state.observed = false
		if ClaudeWoWObserved and ClaudeWoWObserved.SetGather then ClaudeWoWObserved.SetGather(nil) end
		return
	end
	local changed = not state.bridge or state.observed ~= (gs.obs == 1)
	state.bridge = true
	state.observed = gs.obs == 1
	if ClaudeWoWObserved and ClaudeWoWObserved.SetGather then ClaudeWoWObserved.SetGather(state.observed and gs.gather or nil) end
	local watch = type(gs.watch) == "table" and gs.watch or {}
	local items, factions = IdList(watch.items, T.WATCH_ITEMS_MAX), IdList(watch.factions, T.WATCH_FACTIONS_MAX)
	if table.concat(items, ",") ~= table.concat(state.watch.items, ",") or table.concat(factions, ",") ~= table.concat(state.watch.factions, ",") then changed = true end
	state.watch = { items = items, factions = factions }
	local key = T.CharacterKey()
	state.refusedMine = false
	for _, refused in ipairs(type(gs.refused) == "table" and gs.refused or {}) do
		if key and refused == key then state.refusedMine = true end
	end
	local entry = Entry(gs)
	local hashes = entry and entry.hashes or {}
	local bridgeSeq = entry and WholeNumber(entry.seq) or 0
	local now = GetTime()
	for _, name in ipairs(T.ORDER) do
		local at, seq = state.sentAt[name], state.sentSeq[name]
		if not at or (seq and bridgeSeq >= seq) or now - at >= T.RESEND_AFTER then
			local h = type(hashes[name]) == "string" and hashes[name] or nil
			if state.known[name] ~= h then changed = true end
			state.known[name] = h
		end
	end
	if changed then state.hint = true end
end

function T.SyncInbox(gs, bridgeNow)
	local stamp = tonumber(bridgeNow)
	if stamp == nil or time() - stamp > T.INBOX_MAX_AGE then return T.Sync(nil) end
	return T.Sync(gs)
end

function T.Active()
	return Enabled() and true or false
end

function T.Observing()
	return Enabled() and state.observed and true or false
end

function T.Hint()
	state.hint = true
end

function T.Pump()
	if not Enabled() or not (state.urgent or state.hint) or not T.Allowed(GetTime(), true) then return end
	if ClaudeWoW and ClaudeWoW.TelemetryShot then ClaudeWoW.TelemetryShot() end
end

function T.OnEvent(event, ...)
	if T.URGENT_EVENTS[event] then
		state.urgent = true
		state.urgentRestored = false
	else
		state.hint = true
	end
	if event ~= "PLAYER_DEAD" and event ~= "NEW_RECIPE_LEARNED" then return end
	local mine = Mine()
	if not mine then return end
	if event == "PLAYER_DEAD" then
		mine.deaths = (WholeNumber(mine.deaths) or 0) + 1
		mine.lastDeath = time()
	elseif event == "NEW_RECIPE_LEARNED" then
		local id = ...
		if not (WholeNumber(id) and id > 0) then return end
		mine.learned = type(mine.learned) == "table" and mine.learned or {}
		table.insert(mine.learned, { id = id, t = time() })
		while #mine.learned > T.LEARNED_MAX do table.remove(mine.learned, 1) end
	end
end

local frame = CreateFrame("Frame")
frame:RegisterEvent("PLAYER_LOGIN")
frame:SetScript("OnEvent", function(_, event, ...)
	if event == "PLAYER_LOGIN" then
		T.Sanitize()
		for name in pairs(T.URGENT_EVENTS) do pcall(frame.RegisterEvent, frame, name) end
		for _, name in ipairs(T.CHANGE_EVENTS) do pcall(frame.RegisterEvent, frame, name) end
		if C_Timer and C_Timer.NewTicker then C_Timer.NewTicker(T.PUMP_SECONDS, T.Pump) end
		return
	end
	T.OnEvent(event, ...)
end)
