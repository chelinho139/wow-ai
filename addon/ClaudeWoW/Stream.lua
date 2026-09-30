local S = {}
ClaudeWoWStream = S

S.KIND = "stream"
S.PLUGIN = "stream"
S.CHAT_NAME = "Stream control"
S.TRACK_INTERVAL = 8
S.MAX_OBJECTIVES = 5
S.MAX_OBJECTIVE_CHARS = 60
S.MAX_TITLE_CHARS = 80
S.MAX_CHAT_TITLE_CHARS = 80
S.MAX_QUEST_TEXT_CHARS = 200
S.MAX_QUEUED_COMMANDS = 4
S.QUEST_EVENTS = { "QUEST_LOG_UPDATE", "QUEST_WATCH_LIST_CHANGED", "QUEST_WATCH_UPDATE", "SUPER_TRACKING_CHANGED", "PLAYER_ENTERING_WORLD" }

local SCENES = { starting = "Starting", raid = "Raid", game = "Game", code = "Code", brb = "BRB" }
local PANES = { left = true, right = true, full = true }
local QUEST_LOG_SCAN_LIMIT = 60
local NULL = {}

local USAGE = {
	"/stream starting | raid | game | code | brb  -  switch the scene",
	"/stream quest <text>  -  show this quest text (turns follow off)",
	"/stream quest auto  -  follow the tracked quest again",
	"/stream pane left | right | full  -  move the game pane",
	"/stream follow on | off  -  send the tracked quest and open chat as they change",
}

local lastTrackPayload = nil
local lastTrackAt = nil
local pendingTrack = nil
local trackTimerArmed = false
local commandQueue = {}
local ev = CreateFrame("Frame")

local function Settings()
	if type(ClaudeWoWDB) ~= "table" then return nil end
	if type(ClaudeWoWDB.stream) ~= "table" then ClaudeWoWDB.stream = {} end
	local s = ClaudeWoWDB.stream
	for key in pairs(s) do
		if key ~= "follow" and key ~= "chat" then s[key] = nil end
	end
	if type(s.follow) ~= "boolean" then s.follow = true end
	return s
end

local function Say(msg)
	print("|cff66ccff[Claude WoW stream]|r " .. msg)
end

local function SafeCall(fn, ...)
	if type(fn) ~= "function" then return nil end
	local ok, a, b, c, d, e, f, g, h = pcall(fn, ...)
	if ok then return a, b, c, d, e, f, g, h end
end

local function PlainText(s)
	s = tostring(s or "")
	s = s:gsub("|H.-|h(.-)|h", "%1")
	s = s:gsub("|c%x%x%x%x%x%x%x%x", ""):gsub("|r", "")
	s = s:gsub("|", ""):gsub("%c", " "):gsub("%s+", " ")
	return (s:gsub("^%s+", ""):gsub("%s+$", ""))
end

function S.Clip(s, max)
	s = PlainText(s)
	if #s <= max then return s end
	s = s:sub(1, max)
	return (s:gsub("[\192-\255][\128-\191]*$", ""))
end

local JSON_ESCAPES = { ['"'] = '\\"', ["\\"] = "\\\\", ["\n"] = "\\n", ["\r"] = "\\r", ["\t"] = "\\t", ["\b"] = "\\b", ["\f"] = "\\f" }

local function JsonString(s)
	return '"' .. tostring(s):gsub('[%c"\\]', function(c)
		return JSON_ESCAPES[c] or string.format("\\u%04x", c:byte())
	end) .. '"'
end

function S.Object(...)
	local fields = {}
	for i = 1, select("#", ...), 2 do
		local key, value = select(i, ...)
		table.insert(fields, { key = key, value = value })
	end
	return { jsonFields = fields }
end

function S.Encode(v)
	if v == nil or v == NULL then return "null" end
	local kind = type(v)
	if kind == "string" then return JsonString(v) end
	if kind == "boolean" then return v and "true" or "false" end
	if kind == "number" then
		if v ~= v or v == math.huge or v == -math.huge then return "null" end
		if v == math.floor(v) then return string.format("%d", v) end
		return tostring(v)
	end
	if kind ~= "table" then return "null" end
	local parts = {}
	if v.jsonFields then
		for _, field in ipairs(v.jsonFields) do
			table.insert(parts, JsonString(field.key) .. ":" .. S.Encode(field.value))
		end
		return "{" .. table.concat(parts, ",") .. "}"
	end
	for _, item in ipairs(v) do table.insert(parts, S.Encode(item)) end
	return "[" .. table.concat(parts, ",") .. "]"
end

local function FindStreamChat()
	local s = Settings()
	if not s or not s.chat or type(ClaudeWoWDB.chats) ~= "table" then return nil end
	for _, c in ipairs(ClaudeWoWDB.chats) do
		if c.id == s.chat then return c end
	end
end

function S.EnsureChat()
	local chat = FindStreamChat()
	if not chat then
		if not (ClaudeWoW and ClaudeWoW.AddChat) then return nil end
		chat = ClaudeWoW.AddChat(S.CHAT_NAME, { cwd = "", plugin = S.PLUGIN, quiet = true })
		if not chat then return nil end
		Settings().chat = chat.id
	end
	chat.quiet = true
	chat.plugin = S.PLUGIN
	return chat
end

local function WhyNotSend()
	if not Settings() then return "the addon has not loaded its saved data yet" end
	if not (ClaudeWoW and ClaudeWoW.Send) then return "the addon core did not load" end
	if ClaudeWoWDB.settings and ClaudeWoWDB.settings.mode ~= "pixel" then return "reload mode sends nothing without a /reload" end
	if not (ClaudeWoW.IsConnected and ClaudeWoW.IsConnected()) then return "the bridge is not connected" end
	return nil
end

local function QuestLogCount()
	local n = SafeCall(C_QuestLog and C_QuestLog.GetNumQuestLogEntries)
	if type(n) ~= "number" then n = SafeCall(GetNumQuestLogEntries) end
	return type(n) == "number" and math.min(n, QUEST_LOG_SCAN_LIMIT) or 0
end

local function QuestAtIndex(index)
	local info = SafeCall(C_QuestLog and C_QuestLog.GetInfo, index)
	if type(info) == "table" then
		if info.isHeader then return nil end
		local id = tonumber(info.questID)
		local complete = id and SafeCall(C_QuestLog.IsComplete, id)
		return { id = id, title = info.title, complete = complete and true or false, index = index }
	end
	local title, _, _, isHeader, _, isComplete, _, questID = SafeCall(GetQuestLogTitle, index)
	if type(title) ~= "string" or isHeader then return nil end
	return { id = tonumber(questID), title = title, complete = isComplete == 1 or isComplete == true, index = index }
end

local function LogIndexForQuest(questID)
	local index = SafeCall(C_QuestLog and C_QuestLog.GetLogIndexForQuestID, questID)
	if type(index) == "number" and index > 0 then return index end
	for i = 1, QuestLogCount() do
		local q = QuestAtIndex(i)
		if q and q.id == questID then return i end
	end
end

local function ObjectiveTexts(quest)
	local out = {}
	local list = quest.id and SafeCall(C_QuestLog and C_QuestLog.GetQuestObjectives, quest.id)
	if type(list) == "table" and #list > 0 then
		for _, o in ipairs(list) do
			if #out >= S.MAX_OBJECTIVES then break end
			if type(o) == "table" and type(o.text) == "string" and o.text ~= "" then
				table.insert(out, S.Clip(o.text, S.MAX_OBJECTIVE_CHARS))
			end
		end
		return out
	end
	local count = SafeCall(GetNumQuestLeaderBoards, quest.index)
	for i = 1, (type(count) == "number" and count or 0) do
		if #out >= S.MAX_OBJECTIVES then break end
		local text = SafeCall(GetQuestLogLeaderBoard, i, quest.index)
		if type(text) == "string" and text ~= "" then table.insert(out, S.Clip(text, S.MAX_OBJECTIVE_CHARS)) end
	end
	return out
end

local function SuperTrackedQuestID()
	local id = SafeCall(C_SuperTrack and C_SuperTrack.GetSuperTrackedQuestID)
	id = tonumber(id)
	if id and id > 0 then return id end
end

local function FirstWatchedLogIndex()
	if C_QuestLog and C_QuestLog.GetNumQuestWatches then
		local n = tonumber(SafeCall(C_QuestLog.GetNumQuestWatches)) or 0
		if n > 0 then
			local id = tonumber(SafeCall(C_QuestLog.GetQuestIDForQuestWatchIndex, 1))
			if id and id > 0 then return LogIndexForQuest(id) end
		end
	end
	local n = tonumber(SafeCall(GetNumQuestWatches)) or 0
	if n > 0 then
		local index = tonumber(SafeCall(GetQuestIndexForWatch, 1))
		if index and index > 0 then return index end
	end
end

function S.CurrentQuest()
	local index
	local tracked = SuperTrackedQuestID()
	if tracked then index = LogIndexForQuest(tracked) end
	index = index or FirstWatchedLogIndex()
	if not index then return nil end
	local quest = QuestAtIndex(index)
	if not quest then return nil end
	return {
		id = quest.id,
		title = S.Clip(quest.title, S.MAX_TITLE_CHARS),
		objectives = ObjectiveTexts(quest),
		complete = quest.complete,
	}
end

function S.CurrentChatTitle()
	if type(ClaudeWoWDB) ~= "table" or type(ClaudeWoWDB.chats) ~= "table" then return nil end
	local s = Settings()
	for _, c in ipairs(ClaudeWoWDB.chats) do
		if c.id == ClaudeWoWDB.activeChat then
			if s and c.id == s.chat then return nil end
			local title = S.Clip(c.name, S.MAX_CHAT_TITLE_CHARS)
			return title ~= "" and title or nil
		end
	end
end

function S.TrackPayload()
	local quest = S.CurrentQuest()
	local questField = NULL
	if quest then
		questField = S.Object("id", quest.id, "title", quest.title, "objectives", quest.objectives, "complete", quest.complete)
	end
	local title = S.CurrentChatTitle()
	local chatField = title and S.Object("title", title) or NULL
	return S.Encode(S.Object("action", "track", "quest", questField, "chat", chatField))
end

local function SendNow(payload)
	local chat = S.EnsureChat()
	if not chat then return false, "no room for a \"" .. S.CHAT_NAME .. "\" chat (delete one)" end
	if chat.pendingId then return false, "busy" end
	ClaudeWoW.Send(payload, nil, { chat = chat.id, kind = S.KIND })
	if not chat.pendingId then return false, "the send did not go out" end
	return true
end

local function ArmTrackTimer(delay)
	if trackTimerArmed or not (C_Timer and C_Timer.After) then return end
	trackTimerArmed = true
	C_Timer.After(math.max(0.1, delay), function()
		trackTimerArmed = false
		S.Pump()
	end)
end

function S.Pump(now)
	now = now or GetTime()
	if WhyNotSend() then
		if pendingTrack then ArmTrackTimer(S.TRACK_INTERVAL) end
		return
	end
	local chat = FindStreamChat()
	if chat and chat.pendingId then return end
	if #commandQueue > 0 then
		local payload = table.remove(commandQueue, 1)
		local ok, why = SendNow(payload)
		if not ok and why ~= "busy" then
			Say("Could not send: " .. why .. ".")
		elseif not ok then
			table.insert(commandQueue, 1, payload)
		end
		return
	end
	if not pendingTrack then return end
	if pendingTrack == lastTrackPayload then
		pendingTrack = nil
		return
	end
	local wait = lastTrackAt and (lastTrackAt + S.TRACK_INTERVAL - now) or 0
	if wait > 0 then
		ArmTrackTimer(wait)
		return
	end
	local payload = pendingTrack
	if SendNow(payload) then
		lastTrackPayload = payload
		lastTrackAt = now
		pendingTrack = nil
	end
end

function S.Update(now)
	local s = Settings()
	if not (s and s.follow) then
		pendingTrack = nil
		return
	end
	local payload = S.TrackPayload()
	if payload == lastTrackPayload then
		pendingTrack = nil
		return
	end
	pendingTrack = payload
	S.Pump(now)
end

function S.ForceTrack(now)
	lastTrackPayload = nil
	lastTrackAt = nil
	S.Update(now)
end

function S.Command(payload)
	local why = WhyNotSend()
	if why then
		Say("Not sent: " .. why .. ".")
		return false
	end
	if not S.EnsureChat() then
		Say("No room for a \"" .. S.CHAT_NAME .. "\" chat. Delete a chat first.")
		return false
	end
	table.insert(commandQueue, payload)
	while #commandQueue > S.MAX_QUEUED_COMMANDS do table.remove(commandQueue, 1) end
	S.Pump()
	return true
end

function S.PendingTrack()
	return pendingTrack
end

function S.QueuedCommands()
	return commandQueue
end

function S.Reset()
	lastTrackPayload, lastTrackAt, pendingTrack, trackTimerArmed = nil, nil, nil, false
	commandQueue = {}
end

function S.OnReply(chat, role, text)
	text = PlainText(text)
	if text ~= "" then Say(text) end
	S.Pump()
end

local function PrintUsage(problem)
	if problem then Say(problem) end
	for _, line in ipairs(USAGE) do print("  " .. line) end
end

local function SetFollow(on)
	local s = Settings()
	if not s then return end
	s.follow = on
	if not on then pendingTrack = nil end
end

function S.SlashCommand(msg)
	local rest = tostring(msg or ""):gsub("^%s+", ""):gsub("%s+$", "")
	local word, tail = rest:match("^(%S+)%s*(.-)$")
	word = word and word:lower() or ""
	tail = tail or ""
	local lowerTail = tail:lower()
	if word == "" or word == "help" then
		PrintUsage()
		return
	end
	if not Settings() then
		Say("The addon has not loaded its saved data yet.")
		return
	end
	if SCENES[word] then
		S.Command(S.Encode(S.Object("action", "scene", "scene", SCENES[word])))
	elseif word == "quest" then
		if tail == "" then
			PrintUsage("Say which quest text to show, or \"auto\".")
		elseif lowerTail == "auto" then
			SetFollow(true)
			if S.Command(S.Encode(S.Object("action", "follow", "on", true))) then S.ForceTrack() end
		else
			local text = S.Clip(tail, S.MAX_QUEST_TEXT_CHARS)
			SetFollow(false)
			S.Command(S.Encode(S.Object("action", "quest", "text", text)))
		end
	elseif word == "pane" then
		if PANES[lowerTail] then
			S.Command(S.Encode(S.Object("action", "pane", "pane", lowerTail)))
		else
			PrintUsage("Pane must be left, right or full.")
		end
	elseif word == "follow" then
		if lowerTail == "on" or lowerTail == "off" then
			local on = lowerTail == "on"
			SetFollow(on)
			if S.Command(S.Encode(S.Object("action", "follow", "on", on))) and on then S.ForceTrack() end
		else
			Say("Follow is " .. (Settings().follow and "on" or "off") .. ".")
			PrintUsage()
		end
	else
		PrintUsage("Unknown scene or command \"" .. PlainText(word) .. "\".")
	end
end

local function OnChatShown()
	local s = Settings()
	if not (s and s.follow) then return end
	local title = S.CurrentChatTitle()
	if title == S.lastChatTitle then return end
	S.lastChatTitle = title
	S.Update()
end

function S.Install()
	if S.installed then return end
	S.installed = true
	for _, name in ipairs(S.QUEST_EVENTS) do pcall(ev.RegisterEvent, ev, name) end
	if ClaudeWoW and ClaudeWoW.OnQuietReply then ClaudeWoW.OnQuietReply(S.PLUGIN, S.OnReply) end
	if type(hooksecurefunc) == "function" and ClaudeWoW then
		if type(ClaudeWoW.Render) == "function" then hooksecurefunc(ClaudeWoW, "Render", OnChatShown) end
		if type(ClaudeWoW.SwitchChat) == "function" then hooksecurefunc(ClaudeWoW, "SwitchChat", OnChatShown) end
	end
end

SLASH_CLAUDEWOWSTREAM1 = "/stream"
SlashCmdList["CLAUDEWOWSTREAM"] = S.SlashCommand

ev:RegisterEvent("PLAYER_LOGIN")
ev:SetScript("OnEvent", function(self, event)
	if event == "PLAYER_LOGIN" then
		S.Install()
		Settings()
		return
	end
	S.Update()
end)
