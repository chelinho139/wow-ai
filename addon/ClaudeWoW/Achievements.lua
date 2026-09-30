local T = {}
ClaudeWoWAchievements = T

local FADE_IN_SECONDS = 0.4
local HOLD_SECONDS = 5
local FADE_OUT_SECONDS = 0.8
local FRESH_SECONDS = 600
local ACHIEVEMENT_SOUND_FILE_ID = 569143
local ACHIEVEMENT_SOUNDKIT_ID = 12891
local GOLD_R, GOLD_G, GOLD_B = 1, 0.82, 0
local FALLBACK_ICON = "Interface\\Icons\\INV_Misc_QuestionMark"
local SHIELD_TEXTURE = "Interface\\CHARACTERFRAME\\TempPortraitAlphaMask"
local BANNER_BACKDROP = {
	bgFile = "Interface\\Tooltips\\UI-Tooltip-Background",
	edgeFile = "Interface\\DialogFrame\\UI-DialogBox-Border",
	tile = true, tileSize = 16, edgeSize = 24,
	insets = { left = 6, right = 6, top = 6, bottom = 6 },
}

local queue = {}
local toast

local function Print(msg)
	print("|cff66ccff[Claude WoW]|r " .. msg)
end

local function Settings()
	local db = ClaudeWoWDB
	if type(db) ~= "table" then return nil end
	db.settings = db.settings or {}
	if db.settings.toasts == nil then db.settings.toasts = true end
	return db.settings
end

local function Store()
	local db = ClaudeWoWDB
	if type(db) ~= "table" then return nil end
	db.achievements = db.achievements or {}
	local store = db.achievements
	store.earned = store.earned or {}
	store.points = store.points or 0
	store.total = store.total or 0
	return store
end

function T.ToastsOn()
	local s = Settings()
	return not s or s.toasts ~= false
end

local function PlayAchievementSound()
	local ok, willPlay = pcall(PlaySoundFile, ACHIEVEMENT_SOUND_FILE_ID, "Master")
	if ok and willPlay then return "file" end
	if pcall(PlaySound, ACHIEVEMENT_SOUNDKIT_ID, "Master") then return "soundkit" end
	return "none"
end

local function Alpha(age)
	if age < FADE_IN_SECONDS then return age / FADE_IN_SECONDS end
	if age < FADE_IN_SECONDS + HOLD_SECONDS then return 1 end
	return math.max(0, 1 - (age - FADE_IN_SECONDS - HOLD_SECONDS) / FADE_OUT_SECONDS)
end

local ShowNext

local function Dismiss()
	if not toast then return end
	toast.current = nil
	toast:Hide()
	ShowNext()
end

local function BuildToast()
	local f = CreateFrame("Frame", "ClaudeWoWAchievementToast", UIParent, "BackdropTemplate")
	f:SetSize(320, 84)
	f:SetPoint("BOTTOM", UIParent, "BOTTOM", 0, 220)
	f:SetFrameStrata("DIALOG")
	f:SetBackdrop(BANNER_BACKDROP)
	f:SetBackdropColor(0.05, 0.04, 0.02, 0.92)
	f:SetBackdropBorderColor(GOLD_R, GOLD_G, GOLD_B, 1)
	f:EnableMouse(true)
	f:SetScript("OnMouseUp", Dismiss)

	local iconFrame = f:CreateTexture(nil, "BORDER")
	iconFrame:SetSize(52, 52)
	iconFrame:SetPoint("LEFT", f, "LEFT", 14, 0)
	iconFrame:SetColorTexture(GOLD_R * 0.8, GOLD_G * 0.8, GOLD_B, 1)
	f.iconFrame = iconFrame

	local icon = f:CreateTexture(nil, "ARTWORK")
	icon:SetSize(46, 46)
	icon:SetPoint("CENTER", iconFrame, "CENTER", 0, 0)
	icon:SetTexCoord(0.07, 0.93, 0.07, 0.93)
	f.icon = icon

	local shield = f:CreateTexture(nil, "ARTWORK")
	shield:SetSize(38, 38)
	shield:SetPoint("RIGHT", f, "RIGHT", -14, 0)
	shield:SetTexture(SHIELD_TEXTURE)
	shield:SetVertexColor(GOLD_R, GOLD_G * 0.85, GOLD_B, 1)
	f.shield = shield

	local points = f:CreateFontString(nil, "OVERLAY", "GameFontNormalLarge")
	points:SetPoint("CENTER", shield, "CENTER", 0, 0)
	points:SetTextColor(0.15, 0.08, 0)
	f.points = points

	local header = f:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
	header:SetPoint("TOP", f, "TOP", 0, -12)
	header:SetText("Achievement Earned")
	header:SetTextColor(GOLD_R, GOLD_G, GOLD_B)
	f.header = header

	local title = f:CreateFontString(nil, "OVERLAY", "GameFontHighlightLarge")
	title:SetPoint("TOP", header, "BOTTOM", 0, -4)
	title:SetWidth(190)
	f.title = title

	local text = f:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
	text:SetPoint("TOP", title, "BOTTOM", 0, -4)
	text:SetWidth(190)
	text:SetTextColor(0.85, 0.85, 0.85)
	f.text = text

	f:SetScript("OnUpdate", function(self, elapsed)
		if not self.current then return end
		self.age = (self.age or 0) + (elapsed or 0)
		local alpha = Alpha(self.age)
		self:SetAlpha(alpha)
		if self.age >= FADE_IN_SECONDS + HOLD_SECONDS + FADE_OUT_SECONDS then Dismiss() end
	end)
	f:Hide()
	return f
end

local function Present(entry)
	toast = toast or BuildToast()
	toast.current = entry
	toast.age = 0
	toast.icon:SetTexture(entry.icon and entry.icon ~= "" and entry.icon or FALLBACK_ICON)
	toast.title:SetText(entry.title or "")
	toast.text:SetText(entry.text or "")
	toast.points:SetText(tostring(entry.points or 0))
	toast:SetAlpha(0)
	toast:Show()
	T.lastSound = PlayAchievementSound()
	Print("You have earned the achievement |cffffd100[" .. tostring(entry.title) .. "]|r!")
end

ShowNext = function()
	if toast and toast.current then return end
	local entry = table.remove(queue, 1)
	if entry then Present(entry) end
end

function T.Announce(entry)
	if type(entry) ~= "table" or not T.ToastsOn() then return end
	table.insert(queue, entry)
	ShowNext()
end

function T.Toast()
	return toast
end

function T.Pending()
	return #queue
end

local function FreshEntries(recent, seen, now)
	local fresh = {}
	for _, r in ipairs(type(recent) == "table" and recent or {}) do
		local seq = type(r) == "table" and tonumber(r.seq)
		local at = type(r) == "table" and tonumber(r.at)
		if seq and at and seq > seen and now - at <= FRESH_SECONDS then
			table.insert(fresh, r)
		end
	end
	table.sort(fresh, function(a, b) return a.seq < b.seq end)
	return fresh
end

function T.Sync(data, bridgeNow)
	if type(data) ~= "table" then return end
	local store = Store()
	if not store then return end
	if type(data.earned) == "table" then store.earned = data.earned end
	store.points = tonumber(data.points) or store.points
	store.total = tonumber(data.total) or store.total
	local seq = tonumber(data.seq) or 0
	local seen = tonumber(store.seen) or 0
	if seq < seen then seen = 0 end
	store.seen = math.max(seen, seq)
	local now = tonumber(bridgeNow) or time()
	for _, entry in ipairs(FreshEntries(data.recent, seen, now)) do T.Announce(entry) end
end

local function EarnedLine(e)
	local times = (tonumber(e.count) or 1) > 1 and (" x" .. e.count) or ""
	local when = e.at and date and date("%Y-%m-%d", e.at) or ""
	return string.format("|cffffd100[%s]|r %d pts%s - %s%s", tostring(e.title), tonumber(e.points) or 0, times, tostring(e.text or ""), when ~= "" and (" (" .. when .. ")") or "")
end

function T.List()
	local store = Store()
	if not store then return end
	local earned = store.earned or {}
	Print(string.format("Achievements: %d of %d earned, %d points. Toasts are %s (/claude config achievements on|off|test).",
		#earned, math.max(store.total or 0, #earned), store.points or 0, T.ToastsOn() and "on" or "off"))
	if #earned == 0 then
		Print("None yet. Finish a task, make the tests pass, commit, push...")
		return
	end
	for _, e in ipairs(earned) do Print(EarnedLine(e)) end
end

local SAMPLE = { title = "Achievement Unlocked", text = "You looked at a sample toast.", points = 0, icon = "Interface\\Icons\\INV_Misc_Note_01" }

function T.Command(rest)
	rest = tostring(rest or ""):lower()
	local s = Settings()
	if rest == "on" or rest == "off" then
		if s then s.toasts = rest == "on" end
		if rest == "off" then wipe(queue) end
		Print("Achievement toasts are " .. rest .. ". /claude config achievements lists what you earned.")
	elseif rest == "test" then
		if not T.ToastsOn() then
			Print("Achievement toasts are off. /claude config achievements on first.")
			return
		end
		T.Announce(SAMPLE)
	else
		T.List()
	end
end
