local R = {}
ClaudeWoWRoast = R

R.KIND = "roast"
R.PLUGIN = "roast"
R.CHAT_NAME = "Death roasts"
R.WINDOW_SECONDS = 10
R.COOLDOWN_SECONDS = 120
R.MAX_HITS = 12
R.MAX_BYTES = 900
R.MAX_NAME = 40
R.EVENTS = { "PLAYER_DEAD" }
R.PLAYER_UNIT_EVENTS = { "UNIT_COMBAT" }

local LEVEL_UNITS = { "target", "focus", "mouseover", "targettarget", "pettarget" }
local NAMEPLATE_COUNT = 40
local UNSEEN = "something unseen"
local ENVIRONMENT = "the environment"
local DAMAGE_ACTION = "WOUND"
local CRIT_FLAGS = { CRITICAL = true, CRUSHING = true }
local SCHOOL_NAMES = { [1] = "Physical", [2] = "Holy", [4] = "Fire", [8] = "Nature", [16] = "Frost", [32] = "Shadow", [64] = "Arcane" }
local MIXED_SCHOOL = "Mixed"
local RECAP_ABILITY = { SWING_DAMAGE = "Melee", RANGE_DAMAGE = "Shoot" }
local PERIODIC_EVENT = "SPELL_PERIODIC_DAMAGE"
local ENVIRONMENTAL_EVENT = "ENVIRONMENTAL_DAMAGE"

local hits = {}
local lastRecapStamp = nil
local listening = false
local ev = CreateFrame("Frame")

local function Settings()
	if type(ClaudeWoWDB) ~= "table" then return nil end
	ClaudeWoWDB.roast = ClaudeWoWDB.roast or {}
	local s = ClaudeWoWDB.roast
	if s.on == nil then s.on = false end
	return s
end

local function Say(msg)
	print("|cff66ccff[Claude WoW roast]|r " .. msg)
end

local function SafeCall(fn, ...)
	if type(fn) ~= "function" then return nil end
	local ok, a, b, c, d = pcall(fn, ...)
	if ok then return a, b, c, d end
end

local function Readable(v)
	if v == nil then return nil end
	if type(issecretvalue) == "function" and issecretvalue(v) then return nil end
	return v
end

local function Number(v)
	return tonumber(Readable(v))
end

local function Text(v)
	v = Readable(v)
	if type(v) ~= "string" or v == "" then return nil end
	return v
end

local function Clip(s, max)
	s = tostring(s or ""):gsub("[%c|]", " ")
	if #s > max then s = s:sub(1, max) end
	return s
end

local function UnitLevelIfNamed(unit, name)
	if Text(SafeCall(UnitName, unit)) == name then return Number(SafeCall(UnitLevel, unit)) end
end

function R.LevelOfName(name)
	if not name or name == UNSEEN or name == ENVIRONMENT then return nil end
	for _, unit in ipairs(LEVEL_UNITS) do
		local level = UnitLevelIfNamed(unit, name)
		if level then return level end
	end
	for i = 1, NAMEPLATE_COUNT do
		local level = UnitLevelIfNamed("nameplate" .. i, name)
		if level then return level end
	end
end

function R.SchoolName(mask)
	mask = Number(mask)
	if not mask or mask <= 0 then return "Damage" end
	return SCHOOL_NAMES[mask] or MIXED_SCHOOL
end

function R.HitFromUnitCombat(now, unit, action, flag, amount, school)
	if Readable(unit) ~= "player" or Readable(action) ~= DAMAGE_ACTION then return nil end
	amount = Number(amount) or 0
	if amount <= 0 then return nil end
	return {
		at = now,
		ability = R.SchoolName(school),
		amount = amount,
		crit = CRIT_FLAGS[Readable(flag) or ""] and true or nil,
	}
end

local function RecapAbility(e, kind)
	if RECAP_ABILITY[kind] and not Text(e.spellName) then return RECAP_ABILITY[kind] end
	if kind == ENVIRONMENTAL_EVENT then
		local env = Text(e.environmentalType)
		return env and (env:sub(1, 1):upper() .. env:sub(2):lower()) or "The environment"
	end
	return Text(e.spellName) or RECAP_ABILITY[kind] or "an attack"
end

local function RecapSource(e, kind)
	if kind == ENVIRONMENTAL_EVENT then return ENVIRONMENT end
	if Readable(e.hideCaster) then return UNSEEN end
	return Text(e.sourceName) or UNSEEN
end

local function HitFromRecapEvent(e, now, newest)
	local kind = Text(e.event) or ""
	local amount = Number(e.amount) or 0
	local overkill = Number(e.overkill) or 0
	local absorbed = Number(e.absorbed) or 0
	local stamp = Number(e.timestamp) or newest
	local source = Clip(RecapSource(e, kind), R.MAX_NAME)
	return {
		at = now - math.max(0, newest - stamp),
		source = source,
		level = R.LevelOfName(source),
		ability = Clip(RecapAbility(e, kind), R.MAX_NAME),
		amount = amount,
		overkill = overkill > 0 and overkill or nil,
		absorbed = absorbed > 0 and absorbed or nil,
		periodic = kind == PERIODIC_EVENT or nil,
	}
end

local function ReadRecap(now)
	local api = C_DeathRecap
	if type(api) ~= "table" or not SafeCall(api.HasRecapEvents) then return nil end
	local events = SafeCall(api.GetRecapEvents)
	if type(events) ~= "table" or type(events[1]) ~= "table" then return nil end
	local newest = Number(events[1].timestamp)
	if not newest or newest == lastRecapStamp then return nil end
	local list = {}
	for i = #events, 1, -1 do
		if type(events[i]) == "table" then table.insert(list, HitFromRecapEvent(events[i], now, newest)) end
	end
	if #list == 0 then return nil end
	lastRecapStamp = newest
	return { hits = list, maxHealth = Number(SafeCall(api.GetRecapMaxHealth)) }
end

function R.ReadRecap(now)
	local ok, recap = pcall(ReadRecap, now)
	if ok then return recap end
end

function R.Prune(now)
	local oldest = now - R.WINDOW_SECONDS
	local kept = {}
	for _, hit in ipairs(hits) do
		if hit.at >= oldest then table.insert(kept, hit) end
	end
	hits = kept
end

function R.Record(hit)
	if not hit then return end
	table.insert(hits, hit)
	R.Prune(hit.at)
end

function R.Hits()
	return hits
end

function R.Reset()
	hits = {}
end

local function LevelLabel(level)
	if level == nil then return "" end
	if level < 0 then return " (level ??, a boss or far above you)" end
	return " (level " .. level .. ")"
end

local function HitLine(hit, now)
	local who = hit.source and (hit.source .. LevelLabel(hit.level) .. ": ") or ""
	local parts = { string.format("-%.1fs %s%s %d", now - hit.at, who, hit.ability, hit.amount) }
	if hit.crit then table.insert(parts, " crit") end
	if hit.periodic then table.insert(parts, " (tick)") end
	if hit.overkill then table.insert(parts, ", overkill " .. hit.overkill) end
	if hit.absorbed then table.insert(parts, ", absorbed " .. hit.absorbed) end
	return table.concat(parts)
end

local function WhoAndWhere()
	local level = SafeCall(UnitLevel, "player")
	local race = SafeCall(UnitRace, "player")
	local class = SafeCall(UnitClass, "player")
	local zone = SafeCall(GetZoneText) or ""
	local subzone = SafeCall(GetSubZoneText) or ""
	local who = table.concat({ level and ("level " .. level) or "", race or "", class or "" }, " "):gsub("%s+", " "):gsub("^%s+", ""):gsub("%s+$", "")
	local where = zone
	if subzone ~= "" and subzone ~= zone then where = where ~= "" and (where .. " - " .. subzone) or subzone end
	return who ~= "" and who or "an adventurer", where ~= "" and where or "somewhere unmapped"
end

local function UnitLabel(unit)
	local name = Text(SafeCall(UnitName, unit))
	if not name then return nil end
	return Clip(name, R.MAX_NAME) .. LevelLabel(Number(SafeCall(UnitLevel, unit)))
end

local function NearbyLine()
	local target = UnitLabel("target")
	local mouseover = UnitLabel("mouseover")
	local parts = {}
	if target then table.insert(parts, "your target was " .. target) end
	if mouseover and mouseover ~= target then table.insert(parts, "the mouse was over " .. mouseover) end
	if #parts == 0 then return "At death you had no target." end
	local line = "At death " .. table.concat(parts, " and ") .. "."
	return line:sub(1, 1):upper() .. line:sub(2)
end

local function Total(list)
	local total, sources, count = 0, {}, 0
	for _, hit in ipairs(list) do
		total = total + hit.amount
		if hit.source and not sources[hit.source] then
			sources[hit.source] = true
			count = count + 1
		end
	end
	return total, count
end

local function Compose(opts)
	local list = {}
	for i = math.max(1, #opts.hits - R.MAX_HITS + 1), #opts.hits do table.insert(list, opts.hits[i]) end
	local dropped = #opts.hits - #list
	local blow = list[#list]
	local function compose()
		local lines = { opts.head, opts.title }
		if dropped > 0 then table.insert(lines, "(" .. dropped .. " earlier hits left out)") end
		for _, hit in ipairs(list) do
			table.insert(lines, HitLine(hit, opts.now) .. (hit == blow and opts.blowMark or ""))
		end
		for _, line in ipairs(opts.tail) do table.insert(lines, line) end
		return table.concat(lines, "\n")
	end
	local recap = compose()
	while #recap > R.MAX_BYTES and #list > 1 do
		table.remove(list, 1)
		dropped = dropped + 1
		recap = compose()
	end
	return recap:sub(1, R.MAX_BYTES)
end

function R.BuildRecap(now, recap)
	R.Prune(now)
	local who, where = WhoAndWhere()
	local head = "Death recap: a " .. who .. " just died in " .. where .. "."
	if recap and #recap.hits > 0 then
		local total, sourceCount = Total(recap.hits)
		local blow = recap.hits[#recap.hits]
		local summary = string.format("Damage taken: %d from %d source%s. Killing blow: %s's %s.", total, sourceCount, sourceCount == 1 and "" or "s", blow.source, blow.ability)
		if recap.maxHealth and recap.maxHealth > 0 then summary = summary .. " Max health: " .. recap.maxHealth .. "." end
		return Compose({ now = now, head = head, title = "Last hits from the game's death recap, oldest first:", hits = recap.hits, blowMark = " <- killing blow", tail = { summary } })
	end
	if #hits == 0 then
		return head .. "\nNo damage seen in the last " .. R.WINDOW_SECONDS .. " s before death (a fall, a drowning, a debuff that started earlier, or a death recap the game did not share).\n" .. NearbyLine()
	end
	local total = Total(hits)
	local last = hits[#hits]
	return Compose({
		now = now, head = head,
		title = "Hits taken in the last " .. R.WINDOW_SECONDS .. " s, oldest first (the game does not say who dealt them):",
		hits = hits, blowMark = " <- last hit",
		tail = { string.format("Damage taken: %d. Last hit: %s %d.", total, last.ability, last.amount), NearbyLine() },
	})
end

function R.CooldownLeft(nowEpoch)
	local s = Settings()
	if not s or not s.lastAt then return 0 end
	return math.max(0, s.lastAt + R.COOLDOWN_SECONDS - nowEpoch)
end

local function FindRoastChat()
	local s = Settings()
	if not s or type(ClaudeWoWDB.chats) ~= "table" then return nil end
	for _, c in ipairs(ClaudeWoWDB.chats) do
		if c.id == s.chat then return c end
	end
end

function R.EnsureChat()
	local chat = FindRoastChat()
	if chat then return chat end
	if not (ClaudeWoW and ClaudeWoW.AddChat) then return nil end
	chat = ClaudeWoW.AddChat(R.CHAT_NAME, { cwd = "", plugin = R.PLUGIN })
	if chat then Settings().chat = chat.id end
	return chat
end

function R.WhyNot(nowEpoch)
	local s = Settings()
	if not s then return "the addon has not loaded its saved data yet" end
	if not s.on then return "off" end
	local wait = R.CooldownLeft(nowEpoch)
	if wait > 0 then return "cooling down, " .. wait .. " s left" end
	if not (ClaudeWoW and ClaudeWoW.Send) then return "the addon core did not load" end
	if ClaudeWoWDB.settings and ClaudeWoWDB.settings.mode ~= "pixel" then return "reload mode sends nothing without a /reload" end
	if not (ClaudeWoW.IsConnected and ClaudeWoW.IsConnected()) then return "the bridge is not connected" end
	local chat = FindRoastChat()
	if chat and chat.pendingId then return "the last roast is still being written" end
	return nil
end

function R.OnDeath(now, nowEpoch)
	local recapData = R.ReadRecap(now)
	local why = R.WhyNot(nowEpoch)
	if why then
		R.lastSkip = why
		R.Reset()
		return false
	end
	local recap = R.BuildRecap(now, recapData)
	R.Reset()
	local chat = R.EnsureChat()
	if not chat then
		R.lastSkip = "no room for the " .. R.CHAT_NAME .. " chat (delete one)"
		Say("No room for a \"" .. R.CHAT_NAME .. "\" chat. Delete a chat to get roasted.")
		return false
	end
	ClaudeWoW.Send(recap, nil, { chat = chat.id, kind = R.KIND })
	if not chat.pendingId then
		R.lastSkip = "the send did not go out"
		return false
	end
	Settings().lastAt = nowEpoch
	R.lastSkip = nil
	return true
end

function R.Listening()
	return listening
end

function R.Listen(on)
	on = on and true or false
	if on == listening then return end
	listening = on
	for _, name in ipairs(R.EVENTS) do
		if on then ev:RegisterEvent(name) else ev:UnregisterEvent(name) end
	end
	for _, name in ipairs(R.PLAYER_UNIT_EVENTS) do
		if not on then
			ev:UnregisterEvent(name)
		elseif type(ev.RegisterUnitEvent) == "function" then
			ev:RegisterUnitEvent(name, "player")
		else
			ev:RegisterEvent(name)
		end
	end
end

function R.Status()
	local s = Settings()
	if not s then return "Death roast: not loaded yet" end
	local wait = R.CooldownLeft(time())
	return "Death roast is " .. (s.on and "ON" or "OFF")
		.. ": when you die, the game's death recap (or the last " .. R.WINDOW_SECONDS .. " s of hits you took) goes to the agent in the \"" .. R.CHAT_NAME .. "\" chat for a short roast (at most one every " .. math.floor(R.COOLDOWN_SECONDS / 60) .. " min"
		.. (wait > 0 and (", next in " .. wait .. " s") or "") .. ")."
		.. (R.lastSkip and R.lastSkip ~= "off" and (" Last death was not roasted: " .. R.lastSkip .. ".") or "")
		.. " /claude config roast on|off"
end

function R.Command(rest)
	local s = Settings()
	if not s then return end
	rest = tostring(rest or ""):lower()
	if rest == "on" then
		s.on = true
		R.Reset()
	elseif rest == "off" then
		s.on = false
		R.Reset()
	end
	R.Listen(s.on)
	Say(R.Status())
end

ev:RegisterEvent("PLAYER_LOGIN")
ev:SetScript("OnEvent", function(self, event, ...)
	if event == "PLAYER_LOGIN" then
		local s = Settings()
		R.Listen(s and s.on)
	elseif event == "UNIT_COMBAT" then
		local s = Settings()
		if not (s and s.on) then return end
		R.Record(R.HitFromUnitCombat(GetTime(), ...))
	elseif event == "PLAYER_DEAD" then
		R.OnDeath(GetTime(), time())
	end
end)
