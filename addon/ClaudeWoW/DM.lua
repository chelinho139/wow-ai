local T = {}
ClaudeWoWDM = T

local FRAME_NAME = "ClaudeWoWDMFrame"
local FRAME_WIDTH = 338
local FRAME_HEIGHT = 496
local FRAME_TITLE = "Dungeon Master"
local PARCHMENT_X = 7
local PARCHMENT_Y = -62
local PARCHMENT_FALLBACK_WIDTH = 322
local PARCHMENT_FALLBACK_HEIGHT = 404
local TEXT_X = 20
local TEXT_Y = -18
local TEXT_WIDTH = 286
local LINE_GAP = 10
local HINT_X = 16
local HINT_Y = 12
local TITLE_MAX = 60
local LINE_MAX = 400
local LINES_MAX = 8
local BEAT_ID_MAX = 16
local MAX_DATA_AGE_SECONDS = 300
local SIGNATURE_SEPARATOR = "\031"
local HINT_TEXT = "Type /dm next when you are ready to go on."
local PORTRAIT = "Interface\\AddOns\\ClaudeWoW\\Portrait"
local PARCHMENT_FALLBACK_COLOR = { 0.80, 0.70, 0.52, 1 }
local INK = { 0.18, 0.12, 0.06 }
local INK_DIM = { 0.38, 0.30, 0.20 }

T.TEMPLATES = { frame = "ButtonFrameTemplate" }
T.ATLAS = { parchment = "QuestBG-Parchment" }
T.FONTS = {
	title = { "QuestTitleFont", "GameFontNormalLarge" },
	body = { "QuestFont", "GameFontHighlight" },
	hint = { "QuestFontNormalSmall", "GameFontNormalSmall" },
}

T.debug = { renders = 0, native = {} }

local frame
local watcher

local function Print(msg)
	if ClaudeWoW and ClaudeWoW.Print then
		ClaudeWoW.Print(msg)
	else
		print("|cff66ccff[Claude WoW]|r " .. msg)
	end
end

function T.TemplateExists(name)
	if type(C_XMLUtil) ~= "table" or type(C_XMLUtil.GetTemplateInfo) ~= "function" then return false end
	local ok, info = pcall(C_XMLUtil.GetTemplateInfo, name)
	return ok and info ~= nil
end

function T.AtlasExists(name)
	if type(C_Texture) ~= "table" or type(C_Texture.GetAtlasExists) ~= "function" then return false end
	local ok, exists = pcall(C_Texture.GetAtlasExists, name)
	return ok and exists == true
end

local function FontName(pair)
	return _G[pair[1]] ~= nil and pair[1] or pair[2]
end

local function Clip(value, max)
	local s = tostring(value or ""):gsub("%c", " ")
	if #s > max then s = s:sub(1, max) end
	return (s:gsub("|", "||"))
end

local function PlayQuestSound(key)
	if type(SOUNDKIT) == "table" and SOUNDKIT[key] and type(PlaySound) == "function" then pcall(PlaySound, SOUNDKIT[key]) end
end

function T.CharacterKey()
	if ClaudeWoWOrders and type(ClaudeWoWOrders.CharacterKey) == "function" then return ClaudeWoWOrders.CharacterKey() end
	return nil
end

local function Applies(data)
	local key = T.CharacterKey()
	return key ~= nil and type(data.char) == "string" and key == data.char
end

local function Normalize(data)
	local view = { manual = data.manual == true }
	local beat = type(data.beat) == "table" and data.beat or nil
	if beat and type(beat.title) == "string" and beat.title ~= "" then
		view.beat = { id = Clip(beat.id, BEAT_ID_MAX), title = Clip(beat.title, TITLE_MAX), lines = {} }
		for _, line in ipairs(type(beat.lines) == "table" and beat.lines or {}) do
			if #view.beat.lines >= LINES_MAX then break end
			if type(line) == "string" and line ~= "" then table.insert(view.beat.lines, Clip(line, LINE_MAX)) end
		end
	end
	return view
end

local function Signature(view)
	local parts = { tostring(view.manual) }
	if view.beat then
		table.insert(parts, view.beat.id)
		table.insert(parts, view.beat.title)
		for _, line in ipairs(view.beat.lines) do table.insert(parts, line) end
	end
	return table.concat(parts, SIGNATURE_SEPARATOR)
end

local function TextString(parent, pair, color)
	local fs = parent:CreateFontString(nil, "ARTWORK", FontName(pair))
	fs:SetWidth(TEXT_WIDTH)
	fs:SetJustifyH("LEFT")
	fs:SetWordWrap(true)
	fs:SetTextColor(color[1], color[2], color[3])
	return fs
end

local function BuildFrame()
	if T.TemplateExists(T.TEMPLATES.frame) then
		local ok, f = pcall(CreateFrame, "Frame", FRAME_NAME, UIParent, T.TEMPLATES.frame)
		if ok and type(f) == "table" then
			T.debug.native.frame = true
			return f
		end
	end
	T.debug.native.frame = false
	return CreateFrame("Frame", FRAME_NAME, UIParent, "BackdropTemplate")
end

local function DecorateNative(f)
	if type(f.Inset) == "table" then f.Inset:Hide() end
	if type(f.SetPortraitToAsset) == "function" then pcall(f.SetPortraitToAsset, f, PORTRAIT) end
	local titled = type(f.SetTitle) == "function" and pcall(f.SetTitle, f, FRAME_TITLE)
	if not titled then
		local title = f:CreateFontString(nil, "OVERLAY", "GameFontNormal")
		title:SetPoint("TOP", f, "TOP", 0, -5)
		title:SetText(FRAME_TITLE)
	end
end

local function DecoratePlain(f)
	if type(f.SetBackdrop) == "function" and type(BACKDROP_DIALOG_32_32) == "table" then pcall(f.SetBackdrop, f, BACKDROP_DIALOG_32_32) end
	local title = f:CreateFontString(nil, "OVERLAY", "GameFontNormal")
	title:SetPoint("TOP", f, "TOP", 0, -14)
	title:SetText(FRAME_TITLE)
	local close = CreateFrame("Button", nil, f, "UIPanelCloseButton")
	close:SetPoint("TOPRIGHT", f, "TOPRIGHT", -4, -4)
end

local function BuildParchment(f)
	local paper = f:CreateTexture(nil, "BACKGROUND", nil, 1)
	paper:SetPoint("TOPLEFT", f, "TOPLEFT", PARCHMENT_X, PARCHMENT_Y)
	if T.AtlasExists(T.ATLAS.parchment) and pcall(paper.SetAtlas, paper, T.ATLAS.parchment, true) then
		T.debug.parchment = T.ATLAS.parchment
	else
		paper:SetSize(PARCHMENT_FALLBACK_WIDTH, PARCHMENT_FALLBACK_HEIGHT)
		paper:SetColorTexture(PARCHMENT_FALLBACK_COLOR[1], PARCHMENT_FALLBACK_COLOR[2], PARCHMENT_FALLBACK_COLOR[3], PARCHMENT_FALLBACK_COLOR[4])
		T.debug.parchment = "color"
	end
	return paper
end

local function BuildParts(f)
	f:SetSize(FRAME_WIDTH, FRAME_HEIGHT)
	f:SetPoint("TOPLEFT", UIParent, "TOPLEFT", 16, -116)
	f:SetFrameStrata("MEDIUM")
	f:SetClampedToScreen(true)
	f:EnableMouse(true)
	f:SetMovable(true)
	f:RegisterForDrag("LeftButton")
	f:SetScript("OnDragStart", f.StartMoving)
	f:SetScript("OnDragStop", f.StopMovingOrSizing)
	if T.debug.native.frame then DecorateNative(f) else DecoratePlain(f) end
	f.paper = BuildParchment(f)
	f.beatTitle = TextString(f, T.FONTS.title, INK)
	f.body = TextString(f, T.FONTS.body, INK)
	f.hint = TextString(f, T.FONTS.hint, INK_DIM)
	f.hint:SetPoint("BOTTOMLEFT", f, "BOTTOMLEFT", HINT_X, HINT_Y)
	f:SetScript("OnHide", function() PlayQuestSound("IG_QUEST_LIST_CLOSE") end)
	if type(UISpecialFrames) == "table" then table.insert(UISpecialFrames, FRAME_NAME) end
	f:Hide()
end

local function Build()
	local f = BuildFrame()
	frame = f
	local ok, err = pcall(BuildParts, f)
	if not ok then f.buildError = err end
end

local function Layout(view)
	frame.beatTitle:ClearAllPoints()
	frame.beatTitle:SetPoint("TOPLEFT", frame.paper, "TOPLEFT", TEXT_X, TEXT_Y)
	frame.beatTitle:SetText(view.beat.title)
	frame.body:ClearAllPoints()
	frame.body:SetPoint("TOPLEFT", frame.beatTitle, "BOTTOMLEFT", 0, -LINE_GAP)
	frame.body:SetText(table.concat(view.beat.lines, "\n\n"))
	frame.hint:SetText(HINT_TEXT)
	frame.hint:SetShown(view.manual)
end

local function ReportError(err)
	local text = tostring(err)
	if text == T.debug.lastError then return end
	T.debug.lastError = text
	Print("the DM frame could not be drawn: " .. text)
end

local function InCombat()
	return type(InCombatLockdown) == "function" and InCombatLockdown() == true
end

local function Reveal()
	if InCombat() then
		T.showAfterCombat = true
		return
	end
	frame:Show()
	PlayQuestSound("IG_QUEST_LIST_OPEN")
end

local function Draw(view, reveal)
	if not view or not view.beat then
		if frame then frame:Hide() end
		return
	end
	if not frame then Build() end
	if frame.buildError then error(frame.buildError, 0) end
	Layout(view)
	if reveal then Reveal() end
	T.debug.renders = T.debug.renders + 1
	T.debug.lastError = nil
end

local function DrawFailed(err)
	if frame then pcall(frame.Hide, frame) end
	ReportError(err)
end

function T.Sync(data)
	if type(data) ~= "table" then return end
	local view = Applies(data) and Normalize(data) or Normalize({})
	local signature = Signature(view)
	if signature == T.signature then return end
	local previous = T.view and T.view.beat
	local isNewBeat = view.beat ~= nil and (previous == nil or previous.id ~= view.beat.id or previous.title ~= view.beat.title)
	if not view.beat then T.showAfterCombat = nil end
	local ok, err = pcall(Draw, view, isNewBeat)
	if not ok then
		DrawFailed(err)
		T.signature, T.view = nil, nil
		return
	end
	if not view.beat then T.debug.lastError = nil end
	T.signature, T.view = signature, view
end

local function Fresh(data)
	local stamp = tonumber(data.now)
	return stamp ~= nil and time() - stamp <= MAX_DATA_AGE_SECONDS
end

function T.SyncInbox(data)
	if type(data) ~= "table" then return end
	return T.Sync(Fresh(data) and data or {})
end

function T.SyncSlot(data)
	if type(data) ~= "table" or not Fresh(data) then return end
	return T.Sync(data)
end

function T.Frame()
	return frame
end

function T.Toggle()
	if not T.view or not T.view.beat then
		if T.view and T.view.manual then
			Print("The story is ready. Type /dm next to begin.")
		else
			Print("No story beat yet. The Dungeon Master shows the current beat once Claude starts a campaign and its first beat fires.")
		end
		return
	end
	if frame and frame:IsShown() then
		frame:Hide()
		return
	end
	local ok, err = pcall(Draw, T.view, true)
	if not ok then
		DrawFailed(err)
		T.signature = nil
	end
end

local NEXT_REPLIES = {
	sent = "Asked the bridge for the next beat. It shows here as soon as the bridge has it.",
	busy = "The last /dm next is still on its way. Wait a moment.",
	unsupported = "This bridge cannot take /dm next. Update the bridge, then /reload.",
	reload = "/dm next needs the addon to reach the bridge without a reload (/claude mode pixel).",
	nochar = "The game did not name your character, so the bridge cannot tell whose story this is.",
}

function T.Next()
	if not T.view or (not T.view.beat and not T.view.manual) then
		Print("There is no campaign beat waiting for /dm next.")
		return
	end
	if not T.view.manual then
		Print("The next beat starts on its own when its moment comes, not with /dm next.")
		return
	end
	local result = ClaudeWoW and type(ClaudeWoW.SendDmNext) == "function" and ClaudeWoW.SendDmNext(T.CharacterKey()) or "unsupported"
	Print(NEXT_REPLIES[result] or NEXT_REPLIES.unsupported)
end

function T.Command(rest)
	local word = tostring(rest or ""):lower():match("^%s*(%S*)")
	if word == "" then
		T.Toggle()
	elseif word == "next" then
		T.Next()
	else
		Print("/dm shows or hides the Dungeon Master. /dm next goes on to the next beat when it waits for you.")
	end
end

SLASH_CLAUDEWOWDM1 = "/dm"
SlashCmdList.CLAUDEWOWDM = T.Command

watcher = CreateFrame("Frame")
pcall(watcher.RegisterEvent, watcher, "PLAYER_REGEN_ENABLED")
watcher:SetScript("OnEvent", function()
	if not T.showAfterCombat then return end
	T.showAfterCombat = nil
	if frame and T.view and T.view.beat and not frame.buildError then
		frame:Show()
		PlayQuestSound("IG_QUEST_LIST_OPEN")
	end
end)
