local W = {}
ClaudeWoWWindow = W

local GAP = 8
local FADE_SECONDS = 0.25
local POLL_SECONDS = 0.25
local DEFAULT_W, DEFAULT_H = 780, 500
local MIN_W, MIN_H = 560, 300
local DIM_FLOOR = 0.1
local PANEL_TOP_OFFSET = 116
local PANEL_LEFT_OFFSET = 16

local PANELS = {
	"CharacterFrame", "SpellBookFrame", "PlayerSpellsFrame", "PlayerTalentFrame", "TalentFrame", "ClassTalentFrame",
	"QuestLogFrame", "QuestLogDetailFrame", "WorldMapFrame", "MerchantFrame", "TradeFrame", "BankFrame", "MailFrame",
	"OpenMailFrame", "AuctionHouseFrame", "AuctionFrame", "GossipFrame", "QuestFrame", "FriendsFrame", "ClassTrainerFrame",
	"ProfessionsFrame", "TradeSkillFrame", "CraftFrame", "MacroFrame", "LootFrame", "DressUpFrame", "InspectFrame",
	"PVEFrame", "GuildFrame", "CommunitiesFrame", "AchievementFrame", "CollectionsJournal", "EncounterJournal",
	"TabardFrame", "PetStableFrame", "ItemTextFrame", "ContainerFrameCombinedBags",
	"StaticPopup1", "StaticPopup2", "StaticPopup3", "StaticPopup4",
}
for i = 1, 13 do PANELS[#PANELS + 1] = "ContainerFrame" .. i end
W.PANELS = PANELS

local FULLSCREEN = { "GameMenuFrame", "SettingsPanel", "InterfaceOptionsFrame", "VideoOptionsFrame", "CinematicFrame", "MovieFrame" }
W.FULLSCREEN = FULLSCREEN

local PANEL_HOOKS = { "ShowUIPanel", "HideUIPanel", "UpdateUIPanelPositions", "ToggleAllBags", "OpenAllBags", "CloseAllBags", "ToggleBag", "StaticPopup_Show", "StaticPopup_Hide" }

local win, mini, grip, driver
local state = { moving = false, combat = false, stashed = false, fullOpen = false, dodged = false, alpha = 1, pending = false, signature = "", pollIn = 0 }
W.state = state
local hooked = {}

local function Settings()
	local db = ClaudeWoWDB
	return (type(db) == "table" and type(db.settings) == "table") and db.settings or {}
end

local function Try(fn, ...)
	if type(fn) ~= "function" then return nil end
	local ok, a, b, c, d = pcall(fn, ...)
	if ok then return a, b, c, d end
end

local function Screen()
	return UIParent:GetWidth() or 1920, UIParent:GetHeight() or 1080
end

local function CharKey()
	return tostring(Try(UnitName, "player") or "?") .. "-" .. tostring(Try(GetRealmName) or "?")
end

local function Layouts()
	local db = ClaudeWoWDB
	db.layouts = db.layouts or {}
	return db.layouts
end

local function Clamp(left, top, w, h)
	local sw, sh = Screen()
	w = math.max(MIN_W, math.min(w, sw))
	h = math.max(MIN_H, math.min(h, sh))
	left = math.max(0, math.min(left, sw - w))
	top = math.min(sh, math.max(top, h))
	return left, top, w, h
end

function W.Layout()
	local all = Layouts()
	local key = CharKey()
	local l = all[key]
	if l and l.w and l.h then return l end
	local s = Settings()
	l = { w = tonumber(s.width) or DEFAULT_W, h = tonumber(s.height) or DEFAULT_H }
	all[key] = l
	return l
end

local function PanelOffset(attribute, fallback)
	return math.abs(tonumber(Try(UIParent.GetAttribute, UIParent, attribute)) or fallback)
end

local function HomeRect()
	local l = W.Layout()
	local sw, sh = Screen()
	local _, _, w, h = Clamp(0, sh, l.w, l.h)
	local left, top = Clamp(PanelOffset("LEFT_OFFSET", PANEL_LEFT_OFFSET), sh - PanelOffset("TOP_OFFSET", PANEL_TOP_OFFSET), w, h)
	return { left = left, top = top, right = left + w, bottom = top - h }
end
W.HomeRect = HomeRect

local function Put(rect)
	win:SetSize(rect.right - rect.left, rect.top - rect.bottom)
	win:ClearAllPoints()
	win:SetPoint("TOPLEFT", UIParent, "BOTTOMLEFT", rect.left, rect.top)
	state.at = rect
end

local function Overlaps(a, b)
	return a.left < b.right and a.right > b.left and a.bottom < b.top and a.top > b.bottom
end

local function RectOf(f)
	local l, r, t, b = Try(f.GetLeft, f), Try(f.GetRight, f), Try(f.GetTop, f), Try(f.GetBottom, f)
	if not (l and r and t and b) then return nil end
	local k = (Try(f.GetEffectiveScale, f) or 1) / (Try(UIParent.GetEffectiveScale, UIParent) or 1)
	return { left = l * k, right = r * k, top = t * k, bottom = b * k }
end
W.RectOf = RectOf

local function Shown(name)
	local f = _G[name]
	return type(f) == "table" and type(f.IsShown) == "function" and Try(f.IsShown, f) and true or false
end

local function MapMaximized()
	local map = _G.WorldMapFrame
	return Shown("WorldMapFrame") and type(map.IsMaximized) == "function" and Try(map.IsMaximized, map) and true or false
end

function W.FullscreenOpen()
	if MapMaximized() then return true end
	for _, name in ipairs(FULLSCREEN) do
		if Shown(name) then return true end
	end
	return false
end

function W.OpenPanels()
	local out = {}
	for _, name in ipairs(PANELS) do
		if Shown(name) and not (name == "WorldMapFrame" and MapMaximized()) then
			local r = RectOf(_G[name])
			if r and r.right > r.left and r.top > r.bottom then
				r.name = name
				table.insert(out, r)
			end
		end
	end
	return out
end

local function Signature()
	local parts = {}
	for _, name in ipairs(PANELS) do
		if Shown(name) then table.insert(parts, name) end
	end
	for _, name in ipairs(FULLSCREEN) do
		if Shown(name) then table.insert(parts, name) end
	end
	if MapMaximized() then table.insert(parts, "map+") end
	return table.concat(parts, ",")
end

local function Free(rect, occupied)
	local sw, sh = Screen()
	if rect.left < 0 or rect.right > sw or rect.bottom < 0 or rect.top > sh then return false end
	for _, o in ipairs(occupied) do
		if Overlaps(rect, o) then return false end
	end
	return true
end

function W.FindSpot(home, occupied)
	if Free(home, occupied) then return home end
	local sw = Screen()
	local w, h = home.right - home.left, home.top - home.bottom
	local lefts, tops = { home.left, GAP, sw - w - GAP }, { home.top }
	for _, o in ipairs(occupied) do
		table.insert(lefts, o.right + GAP)
		table.insert(lefts, o.left - GAP - w)
		table.insert(tops, o.bottom - GAP)
		table.insert(tops, o.top + GAP + h)
	end
	local best, bestCost
	for _, left in ipairs(lefts) do
		for _, top in ipairs(tops) do
			local r = { left = left, top = top, right = left + w, bottom = top - h }
			if Free(r, occupied) then
				local cost = math.abs(left - home.left) + math.abs(top - home.top)
				if not bestCost or cost < bestCost then best, bestCost = r, cost end
			end
		end
	end
	return best
end

local function Visible()
	return win ~= nil and win:IsShown()
end

function W.Relayout()
	state.pending = false
	if not win then return end
	local s = Settings()
	state.signature = Signature()
	local full = W.FullscreenOpen()
	if full ~= state.fullOpen then
		state.fullOpen = full
		if full and s.autohide ~= false and Visible() then
			state.stashed = ClaudeWoW.Suspend(true) and true or false
		elseif not full and state.stashed then
			state.stashed = false
			ClaudeWoW.Suspend(false)
		end
	end
	if state.stashed or not Visible() or state.dragging then
		W.Drive()
		return
	end
	local home = HomeRect()
	local spot = home
	if s.dodge ~= false then spot = W.FindSpot(home, W.OpenPanels()) or home end
	state.dodged = spot ~= home
	Put(spot)
	W.Drive()
end

function W.Schedule()
	if state.pending or not win then return end
	state.pending = true
	C_Timer.After(0, W.Relayout)
end

local function Hovered()
	if win and win:IsShown() and Try(win.IsMouseOver, win) then return true end
	if mini and mini:IsShown() and Try(mini.IsMouseOver, mini) then return true end
	local ui = ClaudeWoW.UI
	return ui and ui.input and Try(ui.input.HasFocus, ui.input) and true or false
end

function W.DimAlpha()
	local dim = tonumber(Settings().dim) or 1
	if dim >= 1 then return 1 end
	return math.max(DIM_FLOOR, dim)
end

function W.Target()
	if not (state.moving or state.combat) then return 1 end
	if Hovered() then return 1 end
	return W.DimAlpha()
end

local function SetAlpha(a)
	state.alpha = a
	if win then win:SetAlpha(a) end
	if mini then mini:SetAlpha(a) end
end

function W.Fade(dt)
	local target = W.Target()
	local a = state.alpha
	if a == target then return true end
	local step = (dt or 0) / FADE_SECONDS
	if a < target then a = math.min(target, a + step) else a = math.max(target, a - step) end
	SetAlpha(a)
	return a == target
end

function W.Update(dt)
	local settled = W.Fade(dt)
	local watching = Visible() or state.stashed
	if watching then
		state.pollIn = state.pollIn - (dt or 0)
		if state.pollIn <= 0 then
			state.pollIn = POLL_SECONDS
			if Signature() ~= state.signature then W.Schedule() end
		end
	end
	if settled and not watching and not state.moving and not state.combat then driver:Hide() end
end

function W.Drive()
	if driver then driver:Show() end
end

function W.SaveFromFrame()
	if not win then return end
	local w, h = win:GetWidth(), win:GetHeight()
	if not (w and h) then return end
	local _, _, cw, ch = Clamp(0, 0, w, h)
	local l = W.Layout()
	l.w, l.h = cw, ch
	local s = Settings()
	s.width, s.height = cw, ch
	state.dodged = false
	Put(HomeRect())
	W.Schedule()
end

function W.Reset()
	Layouts()[CharKey()] = nil
	local s = Settings()
	s.width, s.height = DEFAULT_W, DEFAULT_H
	if win then
		W.Layout()
		W.Relayout()
	end
end

function W.Apply()
	if not win then return end
	W.Schedule()
	W.Drive()
end

local function Skin(f)
	local util, layouts = _G.NineSliceUtil, _G.NineSliceLayouts
	if not (type(util) == "table" and type(util.ApplyLayoutByName) == "function" and type(layouts) == "table" and layouts.ButtonFrameTemplateNoPortrait) then return false end
	local ok, border = pcall(CreateFrame, "Frame", nil, f, "NineSlicePanelTemplate")
	if not ok or not border then return false end
	if not pcall(util.ApplyLayoutByName, border, "ButtonFrameTemplateNoPortrait") then
		border:Hide()
		return false
	end
	if f.SetBackdropBorderColor then f:SetBackdropBorderColor(0, 0, 0, 0) end
	local ui = ClaudeWoW.UI or {}
	if ui.dotHolder then
		ui.dotHolder:ClearAllPoints()
		ui.dotHolder:SetPoint("TOPLEFT", f, "TOPLEFT", 10, -3)
	end
	if ui.status then
		ui.status:ClearAllPoints()
		ui.status:SetPoint("TOPLEFT", f, "TOPLEFT", 14, -30)
		ui.status:SetPoint("RIGHT", f, "RIGHT", -60, 0)
	end
	if ui.minimize then
		ui.minimize:ClearAllPoints()
		ui.minimize:SetPoint("TOPRIGHT", f, "TOPRIGHT", 2, 1)
	end
	f.claudewowBorder = border
	return true
end

local function HookPanels()
	for _, name in ipairs(PANEL_HOOKS) do
		if not hooked[name] and type(_G[name]) == "function" then
			hooked[name] = true
			hooksecurefunc(name, W.Schedule)
		end
	end
	local map = _G.WorldMapFrame
	if not hooked.map and type(map) == "table" then
		for _, method in ipairs({ "Maximize", "Minimize" }) do
			if type(map[method]) == "function" then
				hooked.map = true
				hooksecurefunc(map, method, W.Schedule)
			end
		end
	end
end
W.HookPanels = HookPanels

function W.Attach(frame, miniBar, sizeGrip)
	win, mini, grip = frame, miniBar, sizeGrip
	W.skinned = Skin(win)
	W.Layout()
	Put(HomeRect())
	win:RegisterForDrag()
	win:SetScript("OnDragStart", nil)
	win:SetScript("OnDragStop", nil)
	if grip then
		grip:SetScript("OnMouseDown", function()
			state.dragging = true
			win:StartSizing("BOTTOMRIGHT")
		end)
		grip:SetScript("OnMouseUp", function()
			win:StopMovingOrSizing()
			state.dragging = false
			W.SaveFromFrame()
		end)
	end
	win:HookScript("OnShow", function()
		state.stashed = false
		W.Schedule()
		W.Drive()
	end)
	if mini then mini:HookScript("OnShow", W.Drive) end
	driver = driver or CreateFrame("Frame", "ClaudeWoWWindowDriver", UIParent)
	driver:SetScript("OnUpdate", function(_, dt) W.Update(dt) end)
	HookPanels()
	state.combat = (Try(InCombatLockdown) or Try(UnitAffectingCombat, "player")) and true or false
	SetAlpha(1)
	W.Drive()
end

local events = CreateFrame("Frame")
for _, ev in ipairs({ "PLAYER_STARTED_MOVING", "PLAYER_STOPPED_MOVING", "PLAYER_REGEN_DISABLED", "PLAYER_REGEN_ENABLED", "PLAYER_ENTERING_WORLD", "ADDON_LOADED", "UI_SCALE_CHANGED", "DISPLAY_SIZE_CHANGED" }) do
	events:RegisterEvent(ev)
end
events:SetScript("OnEvent", function(_, event)
	if event == "PLAYER_STARTED_MOVING" then
		state.moving = true
	elseif event == "PLAYER_STOPPED_MOVING" then
		state.moving = false
	elseif event == "PLAYER_REGEN_DISABLED" then
		state.combat = true
	elseif event == "PLAYER_REGEN_ENABLED" then
		state.combat = false
	elseif event == "PLAYER_ENTERING_WORLD" then
		state.moving = false
		state.combat = (Try(InCombatLockdown) or Try(UnitAffectingCombat, "player")) and true or false
	elseif event == "ADDON_LOADED" then
		HookPanels()
		return
	else
		W.Schedule()
	end
	W.Drive()
end)
