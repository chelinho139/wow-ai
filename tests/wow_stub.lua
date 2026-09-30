-- A minimal stand-in for the WoW addon environment, enough to load and drive
-- ClaudeWoW.lua outside the game (see addon_test.js). Frames are plain tables:
-- capitalized names that aren't listed below resolve to a no-op method, so any
-- SetFoo/EnableBar call is accepted; lowercase names are ordinary fields.
--
-- STUB collects what the addon did: frames, texts, timers, tickers, prints.

STUB = {
	frames = {}, texts = {}, timers = {}, tickers = {}, prints = {}, bindings = {},
	now = 1000, epoch = 1700000000, sounds = {}, loaded = {}, reloaded = false,
	tooltips = {}, zone = "Duskwood", subzone = "Darkshire", level = 23, money = 12345,
}

local function noop() end

local Methods = {}
local FrameMT = {
	__index = function(t, k)
		if type(k) == "string" and k:match("^%u") then
			return Methods[k] or noop
		end
	end,
}

local function NewObject(kind, name, parent)
	local o = setmetatable({ kind = kind, name = name, parent = parent, scripts = {}, hooks = {}, events = {}, shown = true, textures = {}, children = {} }, FrameMT)
	if name then _G[name] = o end
	if parent and type(parent) == "table" and parent.children then table.insert(parent.children, o) end
	return o
end

function Methods.SetScript(self, name, fn) self.scripts[name] = fn end
function Methods.GetScript(self, name) return self.scripts[name] end
function Methods.HookScript(self, name, fn) self.hooks[name] = self.hooks[name] or {}; table.insert(self.hooks[name], fn) end
function Methods.RegisterEvent(self, ev) self.events[ev] = true end
function Methods.UnregisterEvent(self, ev) self.events[ev] = nil end
function Methods.Show(self) self.shown = true end
function Methods.Hide(self)
	local was = self.shown
	self.shown = false
	if was and self.scripts.OnHide then self.scripts.OnHide(self) end
end
function Methods.SetShown(self, v) if v then self:Show() else self:Hide() end end
function Methods.IsShown(self) return self.shown end
function Methods.IsVisible(self) return self.shown end
function Methods.SetText(self, t) self.text = t; table.insert(STUB.texts, tostring(t)) end
function Methods.GetText(self) return self.text or "" end
function Methods.GetName(self) return self.name end
function Methods.GetParent(self) return self.parent end
function Methods.GetWidth(self) return self.width or 400 end
function Methods.GetHeight(self) return self.height or 300 end
function Methods.SetSize(self, w, h) self.width, self.height = w, h end
function Methods.SetWidth(self, w) self.width = w end
function Methods.SetHeight(self, h) self.height = h end
function Methods.GetSize(self) return self:GetWidth(), self:GetHeight() end
function Methods.GetStringHeight(self) return 14 end
function Methods.GetStringWidth(self) return 100 end
function Methods.GetFontString(self) return self end
function Methods.GetPoint(self) return "CENTER", nil, "CENTER", 0, 0 end
function Methods.SetPoint(self, point, rel, relPoint, x, y)
	if type(rel) == "number" then x, y = rel, relPoint end
	self.x, self.y = x or 0, y or 0
end
function Methods.GetVerticalScrollRange(self) return 0 end
function Methods.CreateTexture(self, name, layer)
	local t = NewObject("Texture", name, self)
	table.insert(self.textures, t)
	return t
end
function Methods.CreateFontString(self, name) return NewObject("FontString", name, self) end
function Methods.CreateAnimationGroup(self) return NewObject("AnimationGroup", nil, self) end
function Methods.CreateAnimation(self) return NewObject("Animation", nil, self) end
function Methods.IsPlaying(self) return self.playing or false end
function Methods.Play(self) self.playing = true end
function Methods.Stop(self) self.playing = false end
function Methods.SetColorTexture(self, r, g, b, a) self.color = { r, g, b, a } end
function Methods.SetTexture(self, path) self.texture = path; return true end
function Methods.GetTexture(self) return self.texture end
function Methods.SetBackdrop(self, t)
	-- The real client would silently draw nothing; make it a test failure instead.
	assert(type(t) == "table", "SetBackdrop called with " .. tostring(t) .. " on " .. tostring(self.name or self.kind))
	self.backdrop = t
end
function Methods.SetFocus(self) STUB.focus = self end
function Methods.ClearFocus(self) if STUB.focus == self then STUB.focus = nil end end
function Methods.HasFocus(self) return STUB.focus == self end
function Methods.Insert(self, t) self.text = (self.text or "") .. tostring(t) end
function Methods.GetEditBox(self) return self.editBox end
function Methods.SetAttribute(self, k, v) self.attrs = self.attrs or {}; self.attrs[k] = v end
function Methods.GetAttribute(self, k) return self.attrs and self.attrs[k] end
-- Chat frames: AddMessage keeps every line with its colour in self.messages.
function Methods.AddMessage(self, text, r, g, b)
	self.messages = self.messages or {}
	table.insert(self.messages, { text = tostring(text), r = r, g = g, b = b })
end
-- Tooltip scanning: SetHyperlink fills <name>TextLeft<i> / TextRight<i> from
-- STUB.tooltips[link], a list of strings or { left, right } pairs.
function Methods.ClearLines(self) self.lines = {} end
function Methods.NumLines(self) return #(self.lines or {}) end
function Methods.SetHyperlink(self, link)
	self.lines = STUB.tooltips[link] or {}
	for i, l in ipairs(self.lines) do
		local left, right = l, nil
		if type(l) == "table" then left, right = l[1], l[2] end
		local L = NewObject("FontString", self.name .. "TextLeft" .. i, self)
		L.text = left
		local R = NewObject("FontString", self.name .. "TextRight" .. i, self)
		R.text = right
		R.shown = right ~= nil
	end
end

function CreateFrame(kind, name, parent, template)
	local f = NewObject(kind, name, parent)
	f.template = template
	table.insert(STUB.frames, f)
	return f
end

-- Fire an event on every frame that registered for it.
function STUB.FireEvent(ev, ...)
	for _, f in ipairs(STUB.frames) do
		if f.events[ev] and f.scripts.OnEvent then f.scripts.OnEvent(f, ev, ...) end
	end
end

-- Run every C_Timer.After callback that is due, then every ticker once.
function STUB.RunTimers()
	local due = STUB.timers
	STUB.timers = {}
	for _, t in ipairs(due) do t.fn() end
end
function STUB.Tick()
	for _, fn in ipairs(STUB.tickers) do fn() end
end

UIParent = CreateFrame("Frame", "UIParent")
GameTooltip = CreateFrame("Frame", "GameTooltip")
UIErrorsFrame = CreateFrame("Frame", "UIErrorsFrame")
ChatFontNormal = {}
OKAY, CANCEL = "Okay", "Cancel"
NUM_CHAT_WINDOWS = 1
StaticPopupDialogs = {}
function StaticPopup_Show(which, a, b, data) STUB.popup = { which = which, data = data } end
SlashCmdList = {}
UISpecialFrames = {}
tinsert = table.insert
function wipe(t) for k in pairs(t) do t[k] = nil end return t end
STUB.secureHooks = {}
function hooksecurefunc(a, b, c)
	local wrapper
	if type(a) == "table" then
		local orig = a[b]
		wrapper = function(...) local r = orig(...); local saved = STUB.tainted; c(...); STUB.tainted = saved; return r end
		a[b] = wrapper
	else
		local orig = _G[a]
		wrapper = function(...) local r = orig(...); local saved = STUB.tainted; b(...); STUB.tainted = saved; return r end
		_G[a] = wrapper
	end
	STUB.secureHooks[wrapper] = true
end
function InCombatLockdown() return false end
function ReloadUI() STUB.reloaded = true end
function GetTime() return STUB.now end
function time() return STUB.epoch + math.floor(STUB.now) end
function date(fmt, t) return "12:00" end
C_Timer = {
	After = function(delay, fn) table.insert(STUB.timers, { delay = delay, fn = fn }) end,
	NewTicker = function(delay, fn) table.insert(STUB.tickers, fn); return { Cancel = noop } end,
}
C_AddOns = {
	IsAddOnLoaded = function(name) return STUB.loaded[name] or false end,
	LoadAddOn = function(name)
		STUB.loaded[name] = true
		if STUB.onLoadAddOn then STUB.onLoadAddOn(name) end
		return true
	end,
}
C_Texture = { GetAtlasExists = function() return true end }
function PlaySound() end
function STUB.SignalFile(path)
	if type(path) ~= "string" then return false end
	local rel = path:match("\\ClaudeWoW\\(.+)$")
	if not rel then return false end
	return (rel:match("^ack\\%d%d%d%.wav$") or rel:match("^sig\\%d%d%d%.wav$") or rel:match("^act\\%d%d%d\\%d%d%.wav$") or rel:match("^presence\\[ab]\\%d%d%d%d%.wav$")) and true or false
end
function STUB.FileExists(path)
	local v = STUB.sounds[path]
	if v ~= nil then return v and true or false end
	return STUB.armed and STUB.SignalFile(path) or false
end
function STUB.Launch()
	STUB.index = { armed = STUB.armed, files = {}, gone = {} }
	for p, v in pairs(STUB.sounds) do
		if v then STUB.index.files[p] = true else STUB.index.gone[p] = true end
	end
end
function STUB.Indexed(path)
	local idx = STUB.index
	if not idx then return true end
	if idx.files[path] then return true end
	if idx.gone[path] then return false end
	return idx.armed and STUB.SignalFile(path) or false
end
function PlaySoundFile(path)
	if not STUB.Indexed(path) then return nil end
	if STUB.FileExists(path) or STUB.deletionVisible == false then return true, 1 end
	return nil
end
function StopSound() end
function GetPhysicalScreenSize() return 1920, 1080 end
-- CVars and screenshots, for the screenshot transport. STUB.screenshots counts
-- Screenshot() calls; the addon hears SCREENSHOT_SUCCEEDED/FAILED from the test.
STUB.cvars = { screenshotFormat = "jpeg", screenshotQuality = "3" }
STUB.screenshots = 0
function GetCVar(name) return STUB.cvars[name] end
function SetCVar(name, value)
	if name == "screenshotFormat" and not (value == "png" or value == "tga" or value == "jpeg") then error("invalid value") end
	STUB.cvars[name] = tostring(value)
	return true
end
function Screenshot() STUB.screenshots = STUB.screenshots + 1 end
function SetBinding(key, cmd) STUB.bindings[key] = cmd end
function SaveBindings() end
function GetCurrentBindingSet() return 1 end
function SetItemRef() end
-- Nothing of Blizzard's is ever active here, so the link goes nowhere unless the
-- addon takes it. The Forever client's UI code calls ChatFrameUtil.InsertLink;
-- ChatEdit_InsertLink is the older global name.
ChatFrameUtil = { InsertLink = function(text) return false end }
function ChatEdit_InsertLink(text) return ChatFrameUtil.InsertLink(text) end

STUB.protectedCalls, STUB.chatSent, STUB.serverSends = {}, {}, 0

function STUB.AddonOnStack()
	for level = 2, 400 do
		local info = debug.getinfo(level, "S")
		if not info then return false end
		if type(info.source) == "string" and info.source:match("^@addon/") then return true end
	end
	return false
end

function STUB.Tainted()
	return STUB.tainted == true or STUB.AddonOnStack()
end

function STUB.Protected(name, arg)
	table.insert(STUB.protectedCalls, { name = name, arg = arg, tainted = STUB.Tainted() })
end

function STUB.PressEnter(eb)
	STUB.tainted = false
	debug.sethook(function()
		local info = debug.getinfo(2, "S")
		if info and type(info.source) == "string" and info.source:match("^@addon/") then STUB.tainted = true end
	end, "c")
	local ok, err = pcall(eb:GetScript("OnEnterPressed"), eb)
	debug.sethook()
	STUB.tainted = nil
	if not ok then error(err, 0) end
end

EventRegistry = { callbacks = {} }
function EventRegistry:RegisterCallback(event, func, owner)
	self.callbacks[event] = self.callbacks[event] or {}
	table.insert(self.callbacks[event], { func = func, owner = owner })
	return owner
end
function EventRegistry:TriggerEvent(event, ...)
	for _, cb in ipairs(self.callbacks[event] or {}) do
		local saved = STUB.tainted
		cb.func(cb.owner, ...)
		STUB.tainted = saved
	end
end

STUB.secureCmds = {
	["/CAST"] = function(msg) STUB.Protected("CastSpellByName", msg) end,
}
SLASH_GUILD_LEAVE1 = "/gquit"
SlashCmdList.GUILD_LEAVE = function() STUB.Protected("GuildLeave") end
SLASH_SIT1 = "/sit"
SlashCmdList.SIT = function() table.insert(STUB.protectedCalls, { name = "DoEmote", arg = "SIT", tainted = STUB.Tainted() }) end

local CHAT_TYPE_COMMANDS = {
	["/S"] = "SAY", ["/SAY"] = "SAY", ["/G"] = "GUILD", ["/GUILD"] = "GUILD",
	["/W"] = "WHISPER", ["/WHISPER"] = "WHISPER", ["/T"] = "WHISPER", ["/TELL"] = "WHISPER",
	["/R"] = "REPLY", ["/REPLY"] = "REPLY",
}

local function FindSlashCommand(command)
	for key, fn in pairs(SlashCmdList) do
		local i = 1
		while _G["SLASH_" .. key .. i] do
			if _G["SLASH_" .. key .. i]:upper() == command then return fn end
			i = i + 1
		end
	end
end

ChatFrameEditBoxMixin = {}
local M = ChatFrameEditBoxMixin

function M:GetChatType() return self:GetAttribute("chatType") end
function M:SetChatType(t) self:SetAttribute("chatType", t) end
function M:GetStickyType() return self:GetAttribute("stickyType") end
function M:SetStickyType(t) self:SetAttribute("stickyType", t) end
function M:GetTellTarget() return self:GetAttribute("tellTarget") end
function M:SetTellTarget(t) self:SetAttribute("tellTarget", t) end
function M:AddHistoryLine(text) self.historyLines = self.historyLines or {}; table.insert(self.historyLines, text) end
function M:UpdateHeader() self.headerUpdates = (self.headerUpdates or 0) + 1 end
function M:ClearChat()
	self:SetChatType(self:GetStickyType())
	self:SetText("")
	self:Hide()
end

function M:ProcessChatType(msg, index, send)
	if index == "WHISPER" then
		local target, rest = msg:match("^(%S+)%s+(.*)$")
		if target then
			self:SetTellTarget(target)
			self:SetChatType("WHISPER")
			self:SetText(rest)
			self:UpdateHeader()
		elseif send == 1 then
			self:ClearChat()
		end
	elseif index == "REPLY" then
		if STUB.lastTell then
			self:SetChatType("WHISPER")
			self:SetTellTarget(STUB.lastTell)
			self:SetText(msg)
			self:UpdateHeader()
		elseif send == 1 then
			self:ClearChat()
		end
	else
		self:SetChatType(index)
		self:SetText(msg)
		self:UpdateHeader()
	end
	return true
end

function M:ParseText(send)
	local text = self:GetText()
	if text == "" or text:sub(1, 1) ~= "/" then return end
	if send ~= 1 and not text:find("%s") then return end
	local command = text:match("^(/[^%s]+)") or ""
	local msg = ""
	if command ~= text then msg = (text:sub(#command + 2)):match("^%s*(.*)$") end
	command = command:upper()
	if send == 1 and STUB.secureCmds[command] then
		STUB.secureCmds[command](strtrim(msg))
		self:AddHistoryLine(text)
		self:ClearChat()
		return
	end
	if CHAT_TYPE_COMMANDS[command] then
		self:ProcessChatType(msg, CHAT_TYPE_COMMANDS[command], send)
		return
	end
	if send == 0 then return end
	local fn = FindSlashCommand(command)
	if fn then
		fn(strtrim(msg), self)
		self:AddHistoryLine(text)
		self:ClearChat()
		return
	end
	self:ClearChat()
end

function M:OnPreSendText()
	EventRegistry:TriggerEvent("ChatFrame.OnEditBoxPreSendText", self)
end

function M:SendText(addHistory)
	self:ParseText(1)
	self:OnPreSendText()
	local chatType = self:GetChatType()
	local text = self:GetText()
	if text:find("%s*[^%s]+") then
		STUB.serverSends = STUB.serverSends + 1
		table.insert(STUB.chatSent, { chatType = chatType, target = chatType == "WHISPER" and self:GetTellTarget() or nil, text = text, tainted = STUB.Tainted() })
	end
end

function M:SendMessage()
	self:SendText(1)
	local frame = self.chatFrame
	if frame and frame.isTemporary then
		self:SetStickyType(frame.chatType)
		if frame.chatType == "WHISPER" then self:SetTellTarget(frame.chatTarget) end
	else
		local info = ChatTypeInfo and ChatTypeInfo[self:GetChatType()]
		if info and info.sticky == 1 then self:SetStickyType(self:GetChatType()) end
	end
	self:ClearChat()
end

function M:OnEnterPressed() self:SendMessage() end

local function EnterScript(self) self:OnEnterPressed() end

function strtrim(s) return (tostring(s or ""):gsub("^%s+", ""):gsub("%s+$", "")) end

ChatEdit_SendText = M.SendText
ChatEdit_ParseText = M.ParseText
ChatFrameUtil.SendText = function(eb, addHistory) return eb:SendText(addHistory) end

function STUB.ChatEditBox(name, frame, chatType, tellTarget)
	local eb = CreateFrame("EditBox", name, frame)
	for k, v in pairs(M) do eb[k] = v end
	eb.chatFrame = frame
	eb.attrs = { chatType = chatType or "SAY", stickyType = chatType or "SAY", tellTarget = tellTarget }
	eb.header = eb:CreateFontString(name .. "Header")
	eb:CreateFontString(name .. "HeaderSuffix")
	eb:SetScript("OnEnterPressed", EnterScript)
	return eb
end

-- The character, for the game context (ClaudeWoW.GameContext).
function GetBuildInfo() return "1.60.1", "69913", "Sep 1 2026", 16001 end
function UnitName(unit) if unit == "player" then return "Testchar" end end
function GetRealmName() return "Test Realm" end
function UnitLevel(unit) return STUB.level end
function UnitRace(unit) return "Night Elf", "NightElf" end
function UnitClass(unit) return "Hunter", "HUNTER" end
function UnitFactionGroup(unit) return "Alliance", "Alliance" end
function GetGuildInfo(unit) return "Test Guild", "Member", 1 end
function GetZoneText() return STUB.zone end
function GetSubZoneText() return STUB.subzone end
function GetMoney() return STUB.money end
C_Map = {
	GetBestMapForUnit = function(unit) return 1431 end,
	GetPlayerMapPosition = function(mapId, unit) return { x = STUB.posX or 0.452, y = STUB.posY or 0.678 } end,
	GetMapInfo = function(mapId) return { name = "Duskwood", mapID = mapId } end,
}
function UnitXP(unit) return 1234 end
function UnitXPMax(unit) return 5000 end
function GetNumTalentTabs() return 3 end
function GetTalentTabInfo(i)
	local tabs = { { "Beast Mastery", 10 }, { "Marksmanship", 5 }, { "Survival", 0 } }
	return tabs[i][1], "Interface\\Icons\\x", tabs[i][2]
end
TRADE_SKILLS, SECONDARY_SKILLS = "Professions", "Secondary Skills"
local SKILLS = {
	{ "Class Skills", true }, { "Bows", false, 46, 115 },
	{ "Professions", true }, { "Skinning", false, 75, 75 },
	{ "Secondary Skills", true }, { "First Aid", false, 40, 75 },
	{ "Weapon Skills", true }, { "Swords", false, 10, 115 },
}
function GetNumSkillLines() return #SKILLS end
function GetSkillLineInfo(i)
	local s = SKILLS[i]
	return s[1], s[2] or nil, false, s[3], 0, 0, s[4]
end
ITEM_QUALITY2_DESC = "Uncommon"
C_Item = {
	GetItemInfo = function(link)
		if tostring(link):find("^item:2140") then return "Fine Longsword", link, 2, 19, 14, "Weapon", "One-Handed Swords" end
	end,
}
function print(...)
	local parts = {}
	for i = 1, select("#", ...) do parts[i] = tostring((select(i, ...))) end
	table.insert(STUB.prints, table.concat(parts, " "))
end
