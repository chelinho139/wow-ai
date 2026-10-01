local T = {}
ClaudeWoWOrders = T

local CARD_WIDTH = 260
local CARD_NAME = "ClaudeWoWOrdersCard"
local HEADER_TEXT = "Orders"
local HEADER_HEIGHT = 26
local TEXT_INDENT = 10
local LINE_GAP = 4
local BAR_WIDTH = 192
local BAR_HEIGHT = 25
local BAR_INNER_WIDTH = 180
local BAR_INNER_HEIGHT = 15
local GOALS_MAX = 3
local ORDER_TEXT_MAX = 90
local GOAL_TITLE_MAX = 60
local ORDER_ID_MAX = 16
local TRACKER_GAP = 10
local TRACKER_NINESLICE_INSET = 30
local TRACKER_TOP_PADDING = 15
local SCREEN_RIGHT_OFFSET = -85
local SCREEN_TOP_OFFSET = -260
local SIGNATURE_SEPARATOR = "\031"
local DEFAULT_DASH = "- "
local DEFAULT_PERCENT = "%d%%"
local MAX_DATA_AGE_SECONDS = 300
local ORDER_STYLE = "Header"
local GOAL_STYLE = "Normal"
local PLAYER = "player"
local WATCH_LINE_HEIGHT = 13
local WATCH_HEADER_HEIGHT = 16
local WATCH_BLOCK_GAP = 4
local WATCH_DASH = " - "
local PERCENT_DONE = 100

T.STYLE = { tracker = "tracker", watch = "watch" }

T.WATCH_FONTS = {
	header = { "GameFontNormal", "GameFontNormalSmall" },
	line = { "GameFontHighlight", "GameFontHighlightSmall" },
}

T.WATCH_FILES = {
	highlight = "Interface\\Buttons\\UI-PlusButton-Hilight",
}

local WATCH_COLORS = {
	title = { r = 0.75, g = 0.61, b = 0 },
	titleDone = { r = 1, g = 0.82, b = 0 },
	line = { r = 0.8, g = 0.8, b = 0.8 },
	lineDone = { r = 1, g = 1, b = 1 },
}

T.TEMPLATES = {
	header = "ObjectiveTrackerModuleHeaderTemplate",
	bar = "ObjectiveTrackerProgressBarTemplate",
}

T.ATLAS = {
	header = "UI-QuestTracker-Secondary-Objective-Header",
	collapse = "ui-questtrackerbutton-secondary-collapse",
	collapsePressed = "ui-questtrackerbutton-secondary-collapse-pressed",
	expand = "ui-questtrackerbutton-secondary-expand",
	expandPressed = "ui-questtrackerbutton-secondary-expand-pressed",
	highlight = "ui-questtrackerbutton-yellow-highlight",
}

T.FILES = {
	bar = "Interface\\TargetingFrame\\UI-StatusBar",
	barBorder = "Interface\\PaperDollInfoFrame\\UI-Character-Skills-BarBorder",
	plus = "Interface\\Buttons\\UI-PlusButton-Up",
	minus = "Interface\\Buttons\\UI-MinusButton-Up",
}

T.FONTS = {
	header = { "ObjectiveTrackerHeaderFont", "GameFontNormal" },
	line = { "ObjectiveTrackerLineFont", "GameFontHighlightSmall" },
	barLabel = { "GameFontHighlightMedium", "GameFontHighlightSmall" },
}

local FALLBACK_COLORS = {
	Header = { r = 0.75, g = 0.61, b = 0 },
	Normal = { r = 0.8, g = 0.8, b = 0.8 },
	Complete = { r = 0.6, g = 0.6, b = 0.6 },
	Failed = { r = 0.8, g = 0.1, b = 0.1 },
}

local BAR_COLOR = { 0.26, 0.42, 1 }
local BAR_BACKGROUND = { 0.04, 0.07, 0.18, 1 }
local BAR_BORDER_COORDS = {
	left = { 0.007843, 0.043137, 0.193548, 0.774193 },
	right = { 0.043137, 0.007843, 0.193548, 0.774193 },
	mid = { 0.113726, 0.1490196, 0.193548, 0.774193 },
}

T.debug = { renders = 0, native = {} }

local card
local watcher

local function Print(msg)
	if ClaudeWoW and ClaudeWoW.Print then
		ClaudeWoW.Print(msg)
	else
		print("|cff66ccff[Claude WoW]|r " .. msg)
	end
end

local function Settings()
	local db = ClaudeWoWDB
	if type(db) ~= "table" then return nil end
	db.settings = db.settings or {}
	return db.settings
end

function T.IsOn()
	local s = Settings()
	return not s or s.ordersCard ~= false
end

local function Collapsed()
	local s = Settings()
	return s ~= nil and s.ordersCollapsed == true
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

function T.Style()
	if type(ObjectiveTrackerFrame) ~= "table" and type(QuestWatchFrame) == "table" then return T.STYLE.watch end
	return T.STYLE.tracker
end

local function Watching()
	return card ~= nil and card.style == T.STYLE.watch
end

local function WatchColor(name)
	local live = (name == "titleDone" and NORMAL_FONT_COLOR) or (name == "lineDone" and HIGHLIGHT_FONT_COLOR) or nil
	local c = type(live) == "table" and type(live.r) == "number" and live or WATCH_COLORS[name]
	return c.r, c.g, c.b
end

local function PercentText(pct)
	return string.format(type(PERCENTAGE_STRING) == "string" and PERCENTAGE_STRING or DEFAULT_PERCENT, pct)
end

local function TrackerColor(style)
	local colors = type(OBJECTIVE_TRACKER_COLOR) == "table" and OBJECTIVE_TRACKER_COLOR or FALLBACK_COLORS
	local c = colors[style] or FALLBACK_COLORS[style] or FALLBACK_COLORS.Normal
	return c.r, c.g, c.b
end

local function Clip(value, max)
	local s = tostring(value or ""):gsub("%c", " ")
	if #s > max then s = s:sub(1, max) end
	return (s:gsub("|", "||"))
end

local function Percent(value)
	local n = tonumber(value)
	if not n then return nil end
	return math.max(0, math.min(100, math.floor(n)))
end

function T.CharacterKey()
	if type(UnitName) ~= "function" then return nil end
	local ok, name = pcall(UnitName, PLAYER)
	name = ok and type(name) == "string" and T.ComparableKey(name:match("^[^%s,(]+")) or ""
	if name == "" then return nil end
	local realm = ""
	if type(GetRealmName) == "function" then
		local okRealm, value = pcall(GetRealmName)
		if okRealm and type(value) == "string" then realm = (value:match("^[^,(]*") or ""):gsub("%s+", "") end
	end
	return T.ComparableKey(realm ~= "" and (name .. "-" .. realm) or name)
end

local function KeptAsciiByte(c)
	return c:match("[%w_%-]") or ""
end

function T.ComparableKey(key)
	return (tostring(key or ""):gsub("[\1-\127]", KeptAsciiByte))
end

local function Applies(data)
	local key = T.CharacterKey()
	return type(data.char) == "string" and key == data.char
end

local function Normalize(data)
	local view = { goals = {} }
	local order = type(data.order) == "table" and data.order or nil
	if order and type(order.text) == "string" and order.text ~= "" then
		view.order = {
			id = Clip(order.id, ORDER_ID_MAX),
			text = Clip(order.text, ORDER_TEXT_MAX),
			pct = Percent(order.pct),
		}
	end
	for _, goal in ipairs(type(data.goals) == "table" and data.goals or {}) do
		if #view.goals >= GOALS_MAX then break end
		local pct = type(goal) == "table" and Percent(goal.pct)
		if pct and type(goal.title) == "string" and goal.title ~= "" then
			table.insert(view.goals, { title = Clip(goal.title, GOAL_TITLE_MAX), pct = pct })
		end
	end
	return view
end

local function Signature(view)
	local parts = {}
	local order = view.order
	if order then
		table.insert(parts, order.id)
		table.insert(parts, order.text)
		table.insert(parts, tostring(order.pct))
	end
	for _, goal in ipairs(view.goals) do
		table.insert(parts, goal.title)
		table.insert(parts, tostring(goal.pct))
	end
	return table.concat(parts, SIGNATURE_SEPARATOR)
end

local function SetButtonArt(button, normal, pushed, file)
	if T.AtlasExists(normal) then
		local n, p = button:GetNormalTexture(), button:GetPushedTexture()
		if n and p then
			n:SetAtlas(normal, true)
			p:SetAtlas(pushed, true)
		else
			button:SetNormalAtlas(normal)
			button:SetPushedAtlas(pushed)
		end
		return normal
	end
	button:SetNormalTexture(file)
	button:SetPushedTexture(file)
	return file
end

local function BuildPlainHeader(parent)
	local header = CreateFrame("Frame", nil, parent)
	header:SetSize(CARD_WIDTH, HEADER_HEIGHT)
	local background = header:CreateTexture(nil, "BACKGROUND")
	background:SetPoint("CENTER", header, "CENTER", 0, 0)
	if T.AtlasExists(T.ATLAS.header) then
		background:SetAtlas(T.ATLAS.header, true)
	else
		background:SetSize(CARD_WIDTH, HEADER_HEIGHT)
		background:SetColorTexture(0, 0, 0, 0.35)
	end
	header.Background = background
	header.Text = header:CreateFontString(nil, "ARTWORK", FontName(T.FONTS.header))
	header.Text:SetPoint("LEFT", header, "LEFT", 7, 0)
	header.Text:SetJustifyH("LEFT")
	local button = CreateFrame("Button", nil, header)
	button:SetSize(16, 16)
	button:SetPoint("RIGHT", header, "RIGHT", 1, 0)
	if T.AtlasExists(T.ATLAS.highlight) then button:SetHighlightAtlas(T.ATLAS.highlight, "ADD") end
	header.MinimizeButton = button
	return header
end

local function BuildWatchHeader(parent)
	local header = CreateFrame("Frame", nil, parent)
	header:SetSize(CARD_WIDTH, WATCH_HEADER_HEIGHT)
	local button = CreateFrame("Button", nil, header)
	button:SetSize(14, 14)
	button:SetPoint("LEFT", header, "LEFT", 0, 0)
	button:SetHighlightTexture(T.WATCH_FILES.highlight, "ADD")
	header.MinimizeButton = button
	header.Text = header:CreateFontString(nil, "ARTWORK", FontName(T.WATCH_FONTS.header))
	header.Text:SetPoint("LEFT", button, "RIGHT", 2, 0)
	header.Text:SetJustifyH("LEFT")
	return header
end

local function BuildHeader(parent)
	if T.TemplateExists(T.TEMPLATES.header) then
		local ok, header = pcall(CreateFrame, "Frame", nil, parent, T.TEMPLATES.header)
		if ok and type(header) == "table" and type(header.Text) == "table" and type(header.MinimizeButton) == "table" then
			T.debug.native.header = true
			return header
		end
	end
	T.debug.native.header = false
	return BuildPlainHeader(parent)
end

local function BorderTexture(bar, coords)
	local tex = bar:CreateTexture(nil, "ARTWORK")
	tex:SetTexture(T.FILES.barBorder)
	tex:SetTexCoord(coords[1], coords[2], coords[3], coords[4])
	return tex
end

local function BuildPlainBar(parent)
	local holder = CreateFrame("Frame", nil, parent)
	holder:SetSize(BAR_WIDTH, BAR_HEIGHT)
	local bar = CreateFrame("StatusBar", nil, holder)
	bar:SetSize(BAR_INNER_WIDTH, BAR_INNER_HEIGHT)
	bar:SetPoint("RIGHT", holder, "RIGHT", 15, 0)
	bar:SetStatusBarTexture(T.FILES.bar)
	bar:SetStatusBarColor(BAR_COLOR[1], BAR_COLOR[2], BAR_COLOR[3])
	bar:SetMinMaxValues(0, 100)
	local background = bar:CreateTexture(nil, "BACKGROUND")
	background:SetAllPoints()
	background:SetColorTexture(BAR_BACKGROUND[1], BAR_BACKGROUND[2], BAR_BACKGROUND[3], BAR_BACKGROUND[4])
	local left = BorderTexture(bar, BAR_BORDER_COORDS.left)
	left:SetSize(9, 22)
	left:SetPoint("LEFT", bar, "LEFT", -3, 0)
	local right = BorderTexture(bar, BAR_BORDER_COORDS.right)
	right:SetSize(9, 22)
	right:SetPoint("RIGHT", bar, "RIGHT", 3, 0)
	local mid = BorderTexture(bar, BAR_BORDER_COORDS.mid)
	mid:SetPoint("TOPLEFT", left, "TOPRIGHT", 0, 0)
	mid:SetPoint("BOTTOMRIGHT", right, "BOTTOMLEFT", 0, 0)
	bar.Label = bar:CreateFontString(nil, "OVERLAY", FontName(T.FONTS.barLabel))
	bar.Label:SetPoint("CENTER", bar, "CENTER", 0, -1)
	holder.Bar = bar
	return holder
end

local function BuildBar(parent)
	if T.TemplateExists(T.TEMPLATES.bar) then
		local ok, holder = pcall(CreateFrame, "Frame", nil, parent, T.TEMPLATES.bar)
		if ok and type(holder) == "table" and type(holder.Bar) == "table" and type(holder.Bar.Label) == "table" then
			T.debug.native.bar = true
			return holder
		end
	end
	T.debug.native.bar = false
	return BuildPlainBar(parent)
end

local function LineString(parent, watch)
	local line = parent:CreateFontString(nil, "ARTWORK", FontName(watch and T.WATCH_FONTS.line or T.FONTS.line))
	line:SetWidth(CARD_WIDTH - TEXT_INDENT)
	line:SetJustifyH("LEFT")
	line:SetWordWrap(true)
	return line
end

local SetCollapsedArt

local function BuildParts(f)
	local watch = f.style == T.STYLE.watch
	f:SetSize(CARD_WIDTH, watch and WATCH_HEADER_HEIGHT or HEADER_HEIGHT)
	f:SetFrameStrata("LOW")
	f:SetClampedToScreen(true)
	f.header = watch and BuildWatchHeader(f) or BuildHeader(f)
	f.header:SetPoint("TOPLEFT", f, "TOPLEFT", 0, 0)
	f.header.Text:SetText(HEADER_TEXT)
	f.header.MinimizeButton:SetScript("OnClick", function() T.ToggleCollapsed() end)
	f.orderText = LineString(f, watch)
	f.goalLines, f.bars = {}, {}
	for i = 1, GOALS_MAX do f.goalLines[i] = LineString(f, watch) end
	if watch then
		f.pctLine = LineString(f, true)
		f:Hide()
		return
	end
	for i = 1, GOALS_MAX + 1 do
		f.bars[i] = BuildBar(f)
		f.bars[i].Bar:EnableMouse(false)
		f.bars[i]:Hide()
	end
	f:Hide()
end

local function Build()
	local f = CreateFrame("Frame", CARD_NAME, UIParent)
	f.style = T.Style()
	T.debug.style = f.style
	card = f
	local ok, err = pcall(BuildParts, f)
	if not ok then f.buildError = err end
end

SetCollapsedArt = function(collapsed)
	local button = card.header.MinimizeButton
	if Watching() then
		local file = collapsed and T.FILES.plus or T.FILES.minus
		button:SetNormalTexture(file)
		T.debug.buttonArt = file
		return
	end
	if collapsed then
		T.debug.buttonArt = SetButtonArt(button, T.ATLAS.expand, T.ATLAS.expandPressed, T.FILES.plus)
	else
		T.debug.buttonArt = SetButtonArt(button, T.ATLAS.collapse, T.ATLAS.collapsePressed, T.FILES.minus)
	end
end

local function ShowBar(holder, pct, y)
	holder:ClearAllPoints()
	holder:SetPoint("TOPLEFT", card, "TOPLEFT", TEXT_INDENT, y)
	holder.Bar:SetMinMaxValues(0, 100)
	holder.Bar:SetValue(pct)
	holder.Bar.Label:SetText(PercentText(pct))
	holder:Show()
	return y - BAR_HEIGHT
end

local function ShowLine(line, text, style, y)
	line:ClearAllPoints()
	line:SetPoint("TOPLEFT", card, "TOPLEFT", TEXT_INDENT, y)
	line:SetText(text)
	line:SetTextColor(TrackerColor(style))
	line:Show()
	return y - line:GetStringHeight() - LINE_GAP
end

local function ShowWatchLine(line, text, color, y)
	line:ClearAllPoints()
	line:SetPoint("TOPLEFT", card, "TOPLEFT", 0, y)
	line:SetText(text)
	line:SetTextColor(WatchColor(color))
	line:Show()
	return y - math.max(WATCH_LINE_HEIGHT, line:GetStringHeight())
end

local function WatchLayout(view)
	local collapsed = Collapsed()
	SetCollapsedArt(collapsed)
	card.orderText:Hide()
	card.pctLine:Hide()
	for _, line in ipairs(card.goalLines) do line:Hide() end
	if collapsed then
		card:SetHeight(WATCH_HEADER_HEIGHT)
		return
	end
	local order = view.order
	local orderDone = order.pct == PERCENT_DONE
	local y = ShowWatchLine(card.orderText, order.text, orderDone and "titleDone" or "title", -WATCH_HEADER_HEIGHT)
	if order.pct then
		y = ShowWatchLine(card.pctLine, WATCH_DASH .. PercentText(order.pct), orderDone and "lineDone" or "line", y)
	end
	for i, goal in ipairs(view.goals) do
		y = ShowWatchLine(card.goalLines[i], WATCH_DASH .. goal.title .. ": " .. PercentText(goal.pct), goal.pct == PERCENT_DONE and "lineDone" or "line", y)
	end
	card:SetHeight(-y)
end

local function Layout(view)
	if Watching() then return WatchLayout(view) end
	local collapsed = Collapsed()
	SetCollapsedArt(collapsed)
	card.orderText:Hide()
	for _, line in ipairs(card.goalLines) do line:Hide() end
	for _, holder in ipairs(card.bars) do holder:Hide() end
	if collapsed then
		card:SetHeight(HEADER_HEIGHT)
		return
	end
	local dash = type(QUEST_DASH) == "string" and QUEST_DASH or DEFAULT_DASH
	local order = view.order
	local y = ShowLine(card.orderText, order.text, ORDER_STYLE, -HEADER_HEIGHT - LINE_GAP)
	local used = 0
	if order.pct then
		used = 1
		y = ShowBar(card.bars[used], order.pct, y)
	end
	for i, goal in ipairs(view.goals) do
		y = ShowLine(card.goalLines[i], dash .. goal.title, GOAL_STYLE, y)
		used = used + 1
		y = ShowBar(card.bars[used], goal.pct, y)
	end
	card:SetHeight(-y)
end

local function WatchAnchor(watch)
	if watch:IsShown() then
		card:SetPoint("TOPLEFT", watch, "BOTTOMLEFT", 0, -WATCH_BLOCK_GAP)
		T.debug.anchoredTo = "watch"
	else
		card:SetPoint("TOPLEFT", watch, "TOPLEFT", 0, 0)
		T.debug.anchoredTo = "watch-top"
	end
end

local function TrackerFrame()
	if Watching() then return QuestWatchFrame end
	return ObjectiveTrackerFrame
end

local function Anchor()
	card:ClearAllPoints()
	if Watching() and type(QuestWatchFrame) == "table" then return WatchAnchor(QuestWatchFrame) end
	local tracker = ObjectiveTrackerFrame
	if type(tracker) == "table" and tracker.NineSlice and tracker:IsShown() and tracker.NineSlice:IsShown() then
		card:SetPoint("TOPLEFT", tracker.NineSlice, "BOTTOMLEFT", TRACKER_NINESLICE_INSET, -TRACKER_GAP)
		T.debug.anchoredTo = "tracker"
	elseif type(tracker) == "table" then
		card:SetPoint("TOPLEFT", tracker, "TOPLEFT", 0, -TRACKER_TOP_PADDING)
		T.debug.anchoredTo = "tracker-top"
	else
		card:SetPoint("TOPRIGHT", UIParent, "TOPRIGHT", SCREEN_RIGHT_OFFSET, SCREEN_TOP_OFFSET)
		T.debug.anchoredTo = "screen"
	end
end

local function FollowTracker()
	local tracker = TrackerFrame()
	if T.followingTracker or type(tracker) ~= "table" or type(tracker.HookScript) ~= "function" then return end
	T.followingTracker = true
	local function Reanchor()
		if card and card:IsShown() then Anchor() end
	end
	tracker:HookScript("OnShow", Reanchor)
	tracker:HookScript("OnHide", Reanchor)
	tracker:HookScript("OnSizeChanged", Reanchor)
end

local function InPetBattle()
	if type(C_PetBattles) ~= "table" or type(C_PetBattles.IsInBattle) ~= "function" then return false end
	local ok, inBattle = pcall(C_PetBattles.IsInBattle)
	return ok and inBattle == true
end

local function InVehicleUI()
	if type(UnitHasVehicleUI) ~= "function" then return false end
	local ok, hasUI = pcall(UnitHasVehicleUI, PLAYER)
	return ok and hasUI == true
end

local function TrackerReplaced()
	return InPetBattle() or InVehicleUI()
end

local function ReportError(err)
	local text = tostring(err)
	if text == T.debug.lastError then return end
	T.debug.lastError = text
	Print("the Orders card could not be drawn: " .. text)
end

local function PlayAddAnimation()
	local anim = card.header.AddAnim
	if type(anim) == "table" and type(anim.Restart) == "function" then pcall(anim.Restart, anim) end
end

local function Draw(view, isNewOrder)
	if not T.IsOn() or not view or not view.order or TrackerReplaced() then
		if card then card:Hide() end
		return
	end
	if not card then Build() end
	if card.buildError then error(card.buildError, 0) end
	FollowTracker()
	Layout(view)
	Anchor()
	card:Show()
	T.debug.renders = T.debug.renders + 1
	T.debug.lastError = nil
	if isNewOrder then PlayAddAnimation() end
end

local function DrawFailed(err)
	if card then pcall(card.Hide, card) end
	ReportError(err)
end

function T.Refresh()
	local ok, err = pcall(Draw, T.view)
	if not ok then
		DrawFailed(err)
		T.signature = nil
	end
	return ok
end

function T.Sync(data)
	if type(data) ~= "table" then return end
	local view = Applies(data) and Normalize(data) or Normalize({})
	local signature = Signature(view)
	if signature == T.signature then return end
	local previous = T.view and T.view.order
	local isNewOrder = view.order ~= nil and (previous == nil or previous.id ~= view.order.id)
	local ok, err = pcall(Draw, view, isNewOrder)
	if not ok then
		DrawFailed(err)
		T.signature, T.view = nil, nil
		return
	end
	if not view.order then T.debug.lastError = nil end
	T.signature, T.view = signature, view
end

local function Fresh(bridgeNow)
	local stamp = tonumber(bridgeNow)
	return stamp ~= nil and time() - stamp <= MAX_DATA_AGE_SECONDS
end

function T.SyncInbox(data, bridgeNow)
	if type(data) ~= "table" then return end
	return T.Sync(Fresh(bridgeNow) and data or {})
end

function T.SyncSlot(data, bridgeNow)
	if not Fresh(bridgeNow) then return end
	return T.Sync(data)
end

watcher = CreateFrame("Frame")
pcall(watcher.RegisterEvent, watcher, "PET_BATTLE_OPENING_START")
pcall(watcher.RegisterEvent, watcher, "PET_BATTLE_CLOSE")
pcall(watcher.RegisterUnitEvent, watcher, "UNIT_ENTERED_VEHICLE", PLAYER)
pcall(watcher.RegisterUnitEvent, watcher, "UNIT_EXITED_VEHICLE", PLAYER)
watcher:SetScript("OnEvent", function()
	if T.view then T.Refresh() end
end)

function T.Card()
	return card
end

function T.ToggleCollapsed()
	local s = Settings()
	if not s then return end
	s.ordersCollapsed = not Collapsed()
	if type(SOUNDKIT) == "table" and SOUNDKIT.IG_MAINMENU_OPTION_CHECKBOX_ON then
		pcall(PlaySound, SOUNDKIT.IG_MAINMENU_OPTION_CHECKBOX_ON)
	end
	T.Refresh()
end

function T.SetShown(on)
	local s = Settings()
	if s then s.ordersCard = on and true or false end
	T.debug.lastError = nil
	T.Refresh()
end

function T.Toggle()
	T.SetShown(not T.IsOn())
end

function T.Status()
	return T.IsOn() and "on" or "off"
end

function T.Command(rest)
	rest = tostring(rest or ""):lower()
	if rest == "on" or rest == "off" then T.SetShown(rest == "on") end
	if T.IsOn() then
		Print("The Orders card is on: it shows Claude's current order under the quest tracker, and hides when there is none. /claude orders off hides it.")
	else
		Print("The Orders card is off. /claude orders on shows it again.")
	end
end
