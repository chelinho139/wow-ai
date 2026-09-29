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

local LEVEL_UNITS = { "target", "focus", "mouseover", "targettarget", "pettarget" }
local NAMEPLATE_COUNT = 40
local NO_OVERKILL = 0

local SUFFIX_LAYOUT = {
	SWING_DAMAGE = { amount = 12, overkill = 13, crit = 18, ability = "Melee" },
	RANGE_DAMAGE = { spellName = 13, amount = 15, overkill = 16, crit = 21 },
	SPELL_DAMAGE = { spellName = 13, amount = 15, overkill = 16, crit = 21 },
	SPELL_PERIODIC_DAMAGE = { spellName = 13, amount = 15, overkill = 16, crit = 21, periodic = true },
	SPELL_BUILDING_DAMAGE = { spellName = 13, amount = 15, overkill = 16, crit = 21 },
	DAMAGE_SHIELD = { spellName = 13, amount = 15, overkill = 16, crit = 21 },
	DAMAGE_SPLIT = { spellName = 13, amount = 15, overkill = 16, crit = 21 },
	ENVIRONMENTAL_DAMAGE = { environment = 12, amount = 13, overkill = 14, crit = 19 },
}

local hits = {}
local levelByGuid = {}

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

local function Clip(s, max)
	s = tostring(s or ""):gsub("[%c|]", " ")
	if #s > max then s = s:sub(1, max) end
	return s
end

local function PlayerGuid()
	return SafeCall(UnitGUID, "player")
end

local function LevelOfUnitWithGuid(guid)
	local function check(unit)
		if SafeCall(UnitGUID, unit) == guid then return SafeCall(UnitLevel, unit) end
	end
	for _, unit in ipairs(LEVEL_UNITS) do
		local level = check(unit)
		if level then return level end
	end
	for i = 1, NAMEPLATE_COUNT do
		local level = check("nameplate" .. i)
		if level then return level end
	end
end

function R.SourceLevel(guid)
	if not guid or guid == "" then return nil end
	local level = LevelOfUnitWithGuid(guid)
	if level then levelByGuid[guid] = level end
	return levelByGuid[guid]
end

function R.HitFromLog(now, ...)
	local subevent = select(2, ...)
	local layout = SUFFIX_LAYOUT[subevent]
	if not layout then return nil end
	local destGuid = select(8, ...)
	local player = PlayerGuid()
	if not player or destGuid ~= player then return nil end
	local sourceGuid = select(4, ...)
	local sourceName = select(5, ...)
	local amount = tonumber((select(layout.amount, ...))) or 0
	local overkill = tonumber((select(layout.overkill, ...))) or NO_OVERKILL
	local ability = layout.ability
	if layout.spellName then ability = select(layout.spellName, ...) end
	if layout.environment then
		ability = select(layout.environment, ...)
		sourceName = "the environment"
	end
	return {
		at = now,
		source = Clip(sourceName ~= nil and sourceName ~= "" and sourceName or "something unseen", R.MAX_NAME),
		level = R.SourceLevel(sourceGuid),
		ability = Clip(ability or "an attack", R.MAX_NAME),
		amount = amount,
		overkill = overkill > NO_OVERKILL and overkill or nil,
		crit = select(layout.crit, ...) and true or nil,
		periodic = layout.periodic,
	}
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
	levelByGuid = {}
end

local function LevelLabel(level)
	if level == nil then return "" end
	if level < 0 then return " (level ??, a boss or far above you)" end
	return " (level " .. level .. ")"
end

local function HitLine(hit, now)
	local parts = { string.format("-%.1fs %s%s: %s %d", now - hit.at, hit.source, LevelLabel(hit.level), hit.ability, hit.amount) }
	if hit.crit then table.insert(parts, " crit") end
	if hit.periodic then table.insert(parts, " (tick)") end
	if hit.overkill then table.insert(parts, ", overkill " .. hit.overkill) end
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

local function KillingBlow(list)
	for i = #list, 1, -1 do
		if list[i].overkill then return list[i] end
	end
	return list[#list]
end

local function Summary(list)
	local total, sources, count = 0, {}, 0
	for _, hit in ipairs(list) do
		total = total + hit.amount
		if not sources[hit.source] then
			sources[hit.source] = true
			count = count + 1
		end
	end
	return total, count
end

function R.BuildRecap(now)
	R.Prune(now)
	local who, where = WhoAndWhere()
	local head = "Death recap: a " .. who .. " just died in " .. where .. "."
	if #hits == 0 then
		return head .. "\nNo damage in the last " .. R.WINDOW_SECONDS .. " s before death: no attacker in the combat log (a fall, a drowning, a debuff that started earlier, or something the log did not show)."
	end
	local list = {}
	for i = math.max(1, #hits - R.MAX_HITS + 1), #hits do table.insert(list, hits[i]) end
	local dropped = #hits - #list
	local blow = KillingBlow(list)
	local total, sourceCount = Summary(hits)
	local function compose()
		local lines = { head, "Hits taken in the last " .. R.WINDOW_SECONDS .. " s, oldest first:" }
		if dropped > 0 then table.insert(lines, "(" .. dropped .. " earlier hits left out)") end
		for _, hit in ipairs(list) do
			table.insert(lines, HitLine(hit, now) .. (hit == blow and " <- killing blow" or ""))
		end
		table.insert(lines, string.format("Damage taken: %d from %d source%s. Killing blow: %s's %s.", total, sourceCount, sourceCount == 1 and "" or "s", blow.source, blow.ability))
		return table.concat(lines, "\n")
	end
	local recap = compose()
	while #recap > R.MAX_BYTES and #list > 1 do
		if list[1] == blow then break end
		table.remove(list, 1)
		dropped = dropped + 1
		recap = compose()
	end
	return recap:sub(1, R.MAX_BYTES)
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
	local why = R.WhyNot(nowEpoch)
	if why then
		R.lastSkip = why
		R.Reset()
		return false
	end
	local recap = R.BuildRecap(now)
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

function R.Status()
	local s = Settings()
	if not s then return "Death roast: not loaded yet" end
	local wait = R.CooldownLeft(time())
	return "Death roast is " .. (s.on and "ON" or "OFF")
		.. ": when you die, the last " .. R.WINDOW_SECONDS .. " s of hits go to the agent in the \"" .. R.CHAT_NAME .. "\" chat for a short roast (at most one every " .. math.floor(R.COOLDOWN_SECONDS / 60) .. " min"
		.. (wait > 0 and (", next in " .. wait .. " s") or "") .. ")."
		.. (R.lastSkip and R.lastSkip ~= "off" and (" Last death was not roasted: " .. R.lastSkip .. ".") or "")
		.. " /claude-wow roast on|off"
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
	Say(R.Status())
end

local ev = CreateFrame("Frame")
ev:RegisterEvent("PLAYER_LOGIN")
ev:RegisterEvent("COMBAT_LOG_EVENT_UNFILTERED")
ev:RegisterEvent("PLAYER_DEAD")
ev:SetScript("OnEvent", function(self, event)
	if event == "PLAYER_LOGIN" then
		Settings()
	elseif event == "COMBAT_LOG_EVENT_UNFILTERED" then
		local s = Settings()
		if not (s and s.on) then return end
		if type(CombatLogGetCurrentEventInfo) ~= "function" then return end
		R.Record(R.HitFromLog(GetTime(), CombatLogGetCurrentEventInfo()))
	elseif event == "PLAYER_DEAD" then
		R.OnDeath(GetTime(), time())
	end
end)
