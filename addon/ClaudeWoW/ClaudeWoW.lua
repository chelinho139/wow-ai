-- ClaudeWoW: talk to local coding agents (Claude Code, Codex, Grok) from inside WoW,
-- without reloading.
--
-- The WoW sandbox has no network and no file reads at runtime. Two doors remain open:
--
--   OUT ("pixel" mode): pending messages are drawn as a strip of colored squares in
--        the top-left corner of the screen until the bridge acknowledges them.
--        bridge.js screen-captures that corner and decodes it. Nothing touches the game.
--        When the bridge says it listens on the "screenshot" transport instead, the
--        strip is only up for the two frames around a Screenshot() call and the
--        bridge reads the file the client wrote to its Screenshots folder.
--   IN:  load-on-demand addons read their files from disk at the moment they load.
--        The bridge writes the latest replies for every chat into a pool of pre-made
--        slot addons (ClaudeWoW_S001..S200); we load a fresh slot from a timer.
--        Each slot is single-use per session; a /reload frees them all.
--   Fallback ("reload" mode): SavedVariables + Inbox.lua, a ReloadUI() per step.
--
-- Chats: each chat is its own agent session (like a separate terminal) with its own
-- folder, agent, history and pending message. The bridge runs them in parallel.
-- Everything here is plain addon API. No automation, no memory reading.

local ADDON_NAME = ...
local ClaudeWoW = {}
_G.ClaudeWoW = ClaudeWoW
local Codec = ClaudeWoW_Codec

local DEFAULT_CWD = "" -- empty = the bridge's configured defaultCwd
local MAX_HISTORY = 200
local MAX_CHATS = 16

local SLOT_COUNT = 200
local SLOT_PREFIX = "ClaudeWoW_S"
local ACT_MAX = 60 -- heartbeat files per message (act/NNN/01..60.wav)
local PRESENCE_MAX = 2000 -- presence/0001..2000.wav, one flipped by the bridge every 30 s
local STRIP_TRIES = 3 -- re-show an unacknowledged message this many times before falling back
local CELL, CELLS_PER_ROW, MAX_ROWS = 4, 200, 48
local STRIP_SECONDS = 40 -- max per message; it leaves the strip as soon as the bridge acknowledges
local SHOT_FRAMES = 2 -- screenshot transport: frames the strip is drawn before Screenshot() is called
local SHOT_TIMEOUT = 3 -- seconds to wait for SCREENSHOT_SUCCEEDED/FAILED before hiding the strip anyway
local SHOT_RETRIES = 3 -- failed screenshots per message before the normal 40 s retry takes over
local POLL_SCHEDULE = { 5, 10, 16, 24, 34, 46, 60, 80, 100, 130, 160, 200, 240, 300 }
local POLL_TAIL = 60
local TICK_SECONDS = 2
local CONNECT_WAIT = 15 -- seconds the Connect button waits for the bridge before giving up
local IDLE_POLL_SECONDS = 600 -- without the sound channel, spend one slot this often while idle to check the bridge
local RS, US = "\30", "\31" -- record / unit separators in the strip payload

local db
local ui = {}
-- Transport state for this UI session. outbound[id] = { chat, cwd, flags, text, sentAt, acked }
local run = { outbound = {} }
-- Whisper tabs (the section after the game context). Declared up here because
-- Send, ApplyReplies and Finish use it and come first in the file.
local Whisper = {}

-- Shared window backdrop. Declared up here because ShowCopy (rendering section)
-- uses it too: a later `local` would be invisible there and resolve to a nil global.
local BACKDROP = {
	bgFile = "Interface\\Tooltips\\UI-Tooltip-Background",
	edgeFile = "Interface\\Tooltips\\UI-Tooltip-Border",
	tile = true, tileSize = 16, edgeSize = 16,
	insets = { left = 4, right = 4, top = 4, bottom = 4 },
}

-- The assistant bubble is labelled with the agent that wrote it (see AgentName).
local ROLE_STYLE = {
	user      = { label = "You",    color = { 0.49, 0.78, 1.00 }, bg = { 0.25, 0.45, 0.75, 0.16 } },
	assistant = { label = "AI",     color = { 1.00, 0.82, 0.25 }, bg = { 0.85, 0.70, 0.30, 0.10 } },
	system    = { label = "System", color = { 0.62, 0.62, 0.62 }, bg = { 0.50, 0.50, 0.50, 0.10 } },
}

---------------------------------------------------------------------------
-- Helpers
---------------------------------------------------------------------------

local function ToHex(s)
	return (s:gsub(".", function(c)
		return string.format("%02x", c:byte())
	end))
end

-- Record fields use control characters as separators, so keep them out of the wire format.
local function Wire(s)
	local value = tostring(s or "")
	return (value:gsub("[\30\31]", " "))
end

-- EditBoxes do not render UI escape sequences, so just make pipes harmless.
local function Display(s)
	return (tostring(s or ""):gsub("|", "¦"))
end

local function Trim(s)
	return (s:gsub("^%s+", ""):gsub("%s+$", ""))
end

local function FmtDur(sec)
	sec = math.floor(sec or 0)
	if sec < 60 then return sec .. "s" end
	if sec < 3600 then return math.floor(sec / 60) .. "m" .. string.format("%02d", sec % 60) .. "s" end
	return math.floor(sec / 3600) .. "h" .. string.format("%02d", math.floor(sec / 60) % 60) .. "m"
end

-- Tokens as Claude Code's status line shows them: 850, 9.5k, 186.7k, 1.2M.
local function FmtTokens(n)
	n = tonumber(n) or 0
	if n < 1000 then return tostring(math.floor(n + 0.5)) end
	if n < 1000000 then return string.format("%.1fk", n / 1000) end
	return string.format("%.1fM", n / 1000000)
end

-- Elapsed time the way the same status line shows it: 45s, 11m 58s, 1h 02m.
local function FmtElapsed(sec)
	sec = math.max(0, math.floor(sec or 0))
	if sec < 60 then return sec .. "s" end
	if sec < 3600 then return math.floor(sec / 60) .. "m " .. string.format("%02d", sec % 60) .. "s" end
	return math.floor(sec / 3600) .. "h " .. string.format("%02d", math.floor(sec / 60) % 60) .. "m"
end

-- The footer segment's glyphs (Claude Code's own: "11m 58s · ↓ 186.7k tokens").
-- One place to change if the client's font lacks one of them.
local SEG_DOT, SEG_DOWN, SEG_APPROX = "·", "↓", "≈"

-- "100000", "100k", "0.5m" -> a token count; anything else nil.
local function ParseTokens(text)
	local num, unit = tostring(text or ""):lower():match("^(%d+%.?%d*)([km]?)$")
	if not num then return nil end
	local n = tonumber(num)
	if not n then return nil end
	if unit == "k" then n = n * 1000 elseif unit == "m" then n = n * 1000000 end
	return math.floor(n + 0.5)
end

-- Last path component of a folder, for labels.
local function FolderName(cwd)
	local name = tostring(cwd or ""):gsub("[\\/]+$", ""):match("([^\\/]+)$")
	return name or ""
end

-- The folder a chat works in: its own, or the bridge's default (the folder the
-- bridge was started from), which the bridge reports in every slot file.
local function ChatFolder(c)
	if c and c.cwd ~= "" then return c.cwd end
	return run.bridgeCwd or ""
end

-- Agents are named by id as the bridge knows them ("claude", "codex", "grok");
-- the bridge lists the ones it has, and its default, in every slot file. A chat
-- with no agent of its own runs on the bridge's default.
local AGENT_NAMES = { claude = "Claude", codex = "Codex", grok = "Grok", agy = "Antigravity", hermes = "Hermes" }

local function AgentName(id)
	id = tostring(id or "")
	if id == "" then return "AI" end
	return AGENT_NAMES[id] or (id:sub(1, 1):upper() .. id:sub(2))
end

local function ChatAgent(c)
	if c and c.agent and c.agent ~= "" then return c.agent end
	return run.bridgeAgent or ""
end

local function ChatAgentName(c)
	return AgentName(ChatAgent(c))
end

-- The name to show on a reply: the agent the bridge says wrote it, else the chat's.
local function ReplyAgentName(c, agent)
	if agent and agent ~= "" then return AgentName(agent) end
	return ChatAgentName(c)
end

local function Contains(list, v)
	for _, x in ipairs(list or {}) do
		if x == v then return true end
	end
	return false
end

-- First few words of a message, as a chat title.
local function AutoTitle(text)
	local words = {}
	for w in tostring(text or ""):gmatch("%S+") do
		w = w:gsub("^[%p]+", ""):gsub("[%p]+$", "")
		if w ~= "" then
			table.insert(words, w)
			if #words >= 5 then break end
		end
	end
	local title = table.concat(words, " ")
	if #title > 24 then title = title:sub(1, 24):gsub("%s+%S*$", "") end
	if title == "" then return nil end
	return title:sub(1, 1):upper() .. title:sub(2)
end

local function NewId()
	return string.format("%x%04x", time() % 0xFFFFFF, math.random(0, 0xFFFF))
end

local function FindChat(id)
	for i, c in ipairs(db.chats) do
		if c.id == id then return c, i end
	end
end

local function ActiveChat()
	return FindChat(db.activeChat)
end

local function AddChat(name, cwd)
	if #db.chats >= MAX_CHATS then return nil end
	local current = ActiveChat()
	local c = {
		id = NewId(),
		name = name or ("Chat " .. (#db.chats + 1)),
		cwd = cwd or (current and current.cwd) or DEFAULT_CWD,
		agent = (current and current.agent) or "",
		plugin = (current and current.plugin) or "", -- "" = the bridge's default plugin
		history = {},
		unread = 0,
		created = time(),
	}
	table.insert(db.chats, c)
	return c
end

local function AnyPending()
	for _, c in ipairs(db.chats) do
		if c.pendingId then return true end
	end
	return false
end

local function InitDB()
	-- Nothing saved yet: a first run, as opposed to an install from before some setting existed.
	local fresh = ClaudeWoWDB == nil or next(ClaudeWoWDB) == nil
	ClaudeWoWDB = ClaudeWoWDB or {}
	db = ClaudeWoWDB
	db.settings = db.settings or {}
	local s = db.settings
	if s.autoRefresh == nil then s.autoRefresh = true end
	if s.signal == nil then s.signal = true end
	if s.context == nil then s.context = true end -- tell the agent about the character, zone, etc.
	-- Context growth: say so once when a chat's context passes this many tokens
	-- (/claude-wow context <n>; 0 = never). 100k is half of Claude's 200k window
	-- and where a fresh chat lands after about eight messages.
	if s.contextWarn == nil then s.contextWarn = 100000 end
	-- How much of each reply to print in the game chat. "summary" (the agent's
	-- closing TL;DR lines) replaced "full" as the default; an install that still
	-- has the old default saved moves over once, any other choice is kept.
	if not s.echoV2 then
		s.echoV2 = true
		if s.echo == "full" then s.echo = "summary" end
	end
	s.echo = s.echo or "summary"
	s.mode = s.mode or "pixel"
	if s.whisper == nil then s.whisper = false end -- each chat as a native whisper tab; opt-in
	if s.vision == nil then s.vision = false end -- send a picture of the screen with each message (screenshot transport); opt-in
	s.interval = s.interval or 20
	s.cwd = s.cwd or DEFAULT_CWD
	s.width = s.width or 780
	s.height = s.height or 500
	db.lastSeq = db.lastSeq or 0
	-- Chats deleted in game that the bridge hasn't confirmed forgetting yet.
	db.forget = db.forget or {}
	-- Identifies this counter's lifetime. If the saved data is ever reset, a new
	-- session lets the bridge tell "message #1 again" from "message #1, already done".
	if not db.session then
		db.session = string.format("%x%04x%04x", time() % 0xFFFFFF, math.random(0, 0xFFFF), math.random(0, 0xFFFF))
	end
	if not db.chats then
		-- Migrate the single-chat layout into the first chat.
		db.chats = {}
		local c = {
			id = NewId(),
			name = "Chat 1",
			cwd = s.cwd,
			history = db.history or {},
			pendingId = db.pendingId,
			unread = db.unread or 0,
			draft = db.draft,
			created = time(),
		}
		table.insert(db.chats, c)
		db.activeChat = c.id
		db.history, db.pendingId, db.unread, db.draft = nil, nil, nil, nil
	end
	if #db.chats == 0 then AddChat() end
	if not FindChat(db.activeChat) then db.activeChat = db.chats[1].id end
	-- Chats from before agents had names: replies were stored with role "claude".
	for _, c in ipairs(db.chats) do
		c.agent = c.agent or ""
		for _, m in ipairs(c.history or {}) do
			if m.role == "claude" then m.role, m.agent = "assistant", m.agent or "claude" end
		end
	end
	-- Chats from before plugins existed were all coding chats and stay bound to
	-- that plugin; chats made since follow the bridge's default ("" = its
	-- default, "ask" unless its config says otherwise), like a fresh install.
	if not s.pluginsV1 then
		s.pluginsV1 = true
		if not fresh then
			for _, c in ipairs(db.chats) do
				if not c.plugin or c.plugin == "" then c.plugin = "claude-code" end
			end
		end
	end
	for _, c in ipairs(db.chats) do c.plugin = c.plugin or "" end
end

local function AddHistory(chat, role, text, id, denied, agent, macros)
	table.insert(chat.history, { role = role, text = text, id = id, t = time(), denied = denied, agent = agent, macros = macros })
	while #chat.history > MAX_HISTORY do
		table.remove(chat.history, 1)
	end
end

local function SlotName(i)
	return string.format("%s%03d", SLOT_PREFIX, i)
end

local function SlotNumber(id)
	return ((id - 1) % SLOT_COUNT) + 1
end

---------------------------------------------------------------------------
-- Reload plumbing (fallback path)
---------------------------------------------------------------------------

local function SafeReload()
	if InCombatLockdown() then
		ClaudeWoW.reloadAfterCombat = true
		if ui.status then
			ui.status:SetText("In combat - will reload as soon as it ends")
		end
		return
	end
	ReloadUI()
end

-- ReloadUI() only works from a hardware event (a keypress or click), never from
-- a timer. So the automatic reload piggybacks on the player's own next keypress
-- once the interval has elapsed. The key still reaches the game normally.
local keyCatcher = CreateFrame("Frame", "ClaudeWoWKeyCatcher", UIParent)
keyCatcher:Hide()
keyCatcher:EnableKeyboard(true)
keyCatcher:SetScript("OnKeyDown", function(self, key)
	if db and AnyPending() and db.settings.autoRefresh
		and GetTime() >= (ClaudeWoW.nextAutoRefresh or 0)
		and not InCombatLockdown() then
		self:Hide()
		ReloadUI()
	end
end)

-- Arm the keypress reload. In pixel mode this is only used once the slot pool
-- is exhausted (a reload frees every slot) or the slots are not installed.
function ClaudeWoW.ArmAutoRefresh()
	keyCatcher:Hide()
	if not AnyPending() or not db.settings.autoRefresh then return end
	if db.settings.mode == "pixel" and not (run.slotsExhausted or run.slotsMissing or run.pixelFailed) then return end
	-- Propagation can't be changed in combat. Never show the catcher without it,
	-- or it would eat every keypress. PLAYER_REGEN_ENABLED re-arms after combat.
	if not keyCatcher.propagates then
		if InCombatLockdown() or not keyCatcher.SetPropagateKeyboardInput then return end
		keyCatcher:SetPropagateKeyboardInput(true)
		keyCatcher.propagates = true
	end
	ClaudeWoW.nextAutoRefresh = GetTime() + db.settings.interval
	keyCatcher:Show()
end

---------------------------------------------------------------------------
-- Pixel strip (out)
---------------------------------------------------------------------------

local strip
local cellPool = {}

local function EnsureStrip()
	if strip then return strip end
	strip = CreateFrame("Frame", "ClaudeWoWStrip", UIParent)
	strip:SetFrameStrata("TOOLTIP")
	strip:SetFrameLevel(10000)
	-- Scale so that one UI unit is exactly one physical pixel (see Blizzard's PixelUtil).
	local physH = 1080
	if GetPhysicalScreenSize then
		local _, h = GetPhysicalScreenSize()
		physH = h or physH
	end
	if strip.SetIgnoreParentScale then strip:SetIgnoreParentScale(true) end
	strip:SetScale(768 / physH)
	strip:SetPoint("TOPLEFT", UIParent, "TOPLEFT", 0, 0)
	strip:SetSize(CELLS_PER_ROW * CELL, MAX_ROWS * CELL)
	strip:Hide()
	return strip
end

local function HideStrip()
	if strip then strip:Hide() end
	run.stripShown = nil
end

-- Which codec the strip is drawn with (see Codec.lua) and the two levels, 0..255,
-- its channels span. Codec 1 at full primaries, except on the screenshot
-- transport, where the bridge asked for levels of its own (see StripLevels): a
-- screenshot is bit-exact, so dark levels read as well as bright ones and the
-- strip all but disappears. Codec 2 (2 px cells, four levels a channel between
-- the same two numbers) only when that bridge asked for it.
local function StripCodec()
	local lv = db and db.settings.mode == "pixel" and db.settings.transport == "screenshot" and db.settings.stripLevels
	if type(lv) == "table" and type(lv.on) == "number" and type(lv.off) == "number" then
		return lv.codec == 2 and 2 or 1, lv.on, lv.off
	end
	return 1, 255, 0
end

local function ShowStrip(id, payload)
	local codec, on, off = StripCodec()
	local geo = Codec.GEOMETRY[codec]
	local cells = Codec.Encode(id % 65536, payload, codec)
	local s = EnsureStrip()
	local rows = math.ceil(#cells / geo.cells)
	local total = rows * geo.cells
	local levels = codec == 2 and Codec.DenseLevels(on, off) or nil
	for i = 1, total do
		local t = cellPool[i]
		if not t then
			t = s:CreateTexture(nil, "OVERLAY")
			cellPool[i] = t
		end
		-- A texture is laid out for one codec; a switch (the bridge changed its
		-- mind, or an older saved setting) places it again.
		if t.codec ~= codec then
			t:SetSize(geo.cell, geo.cell)
			local c = (i - 1) % geo.cells
			local r = math.floor((i - 1) / geo.cells)
			t:ClearAllPoints()
			t:SetPoint("TOPLEFT", s, "TOPLEFT", c * geo.cell, -r * geo.cell)
			t.codec = codec
		end
		local v = cells[i] or 0
		if codec == 2 then
			local cr, cg, cb = Codec.DenseCellColor(v)
			t:SetColorTexture(levels[cr + 1] / 255, levels[cg + 1] / 255, levels[cb + 1] / 255, 1)
		else
			local cr, cg, cb = Codec.CellColor(v)
			t:SetColorTexture((off + cr * (on - off)) / 255, (off + cg * (on - off)) / 255, (off + cb * (on - off)) / 255, 1)
		end
		t:Show()
	end
	for i = total + 1, #cellPool do
		cellPool[i]:Hide()
	end
	s:Show()
	run.stripShown = true
end

-- Record: session, chat, id, cwd, flags, name, [context,] text. Several records
-- per frame. The context field is only present when the flags carry "c", so the
-- bridge can tell it from a separator inside the text.
local NoScreenshot -- below (Screenshot transport): the bridge wants shots this client cannot take
local function RecordFor(id, rec)
	local flags = Wire(rec.flags)
	-- The bridge wants screenshots and this record cannot be shot (no
	-- Screenshot() in this client, or SCREENSHOT_FAILED on every try): tell the
	-- bridge, and it falls back to the pixel capture (bridge.js fallbackToPixel;
	-- the reload outbox says it too).
	local shot = NoScreenshot() and "missing" or (rec.shotFailed and "failed") or nil
	if shot then flags = flags == "" and ("shot=" .. shot) or (flags .. ";shot=" .. shot) end
	local fields = { Wire(db.session), Wire(rec.chat), tostring(id), Wire(rec.cwd), flags, Wire(rec.name) }
	if rec.ctx ~= nil then
		fields[5] = flags == "" and "c" or (flags .. ";c")
		table.insert(fields, Wire(rec.ctx))
	end
	table.insert(fields, Wire(rec.text))
	return table.concat(fields, US)
end

---------------------------------------------------------------------------
-- Screenshot transport
---------------------------------------------------------------------------
--
-- The bridge names its outbound transport in every slot file (`transport`). On
-- "screenshot" it doesn't watch the screen: we draw the strip, wait SHOT_FRAMES
-- frames so it is really rendered, call Screenshot(), and hide the strip when
-- the client reports SCREENSHOT_SUCCEEDED / SCREENSHOT_FAILED (or after
-- SHOT_TIMEOUT). The bridge decodes the file from the Screenshots folder and
-- deletes it. Each outbound record is shot once (`rec.shot`); the 40 s retry in
-- Tick clears the flag so an unacknowledged message is shot again. The last
-- transport heard is kept in the saved settings, so the login hello already
-- goes out the right way.

local function ScreenshotMode()
	return db ~= nil and db.settings.mode == "pixel" and db.settings.transport == "screenshot" and type(Screenshot) == "function"
end

-- The bridge listens for screenshots, and this client cannot take one.
NoScreenshot = function()
	return db ~= nil and db.settings.transport == "screenshot" and type(Screenshot) ~= "function"
end

local function ShotStats()
	run.shotStats = run.shotStats or { taken = 0, ok = 0, failed = 0, timeouts = 0 }
	return run.shotStats
end

-- Vision ("/claude-wow vision on", off by default): the screenshot this transport
-- takes per message is the whole screen; the bridge keeps the part under the
-- strip, scales it down and attaches it to the agent's message as an image, so
-- "what is this item?" or "why is this boss killing me?" can be answered. A "v"
-- flag on the record asks for it. The pixel transport never sees more than the
-- strip, so there the flag is sent but changes nothing.
local function VisionStatus()
	local s = db.settings
	if not s.vision then return "Vision is OFF: the agent gets no picture of your screen" end
	if s.transport ~= "screenshot" then
		return "Vision is ON, but the bridge listens on the pixel transport, which has no screenshot to send: set capture.mode to \"screenshot\" in bridge/config.json and restart the bridge"
	end
	return "Vision is ON: each message goes out with a picture of your screen (the screenshot this transport takes anyway, strip cropped off and downscaled by the bridge), so the agent can see what you see"
end

-- The client writes screenshots as JPEG by default, which is lossy; the
-- transport needs PNG (or TGA). The player's own setting is kept in the saved
-- settings (shotFormatSaved) from the first time we change it until we leave
-- the mode or log out, so a /reload in between can't lose it, and a crash,
-- which skips the logout restore, is repaired at the next load (ADDON_LOADED
-- and PLAYER_LOGIN both call SyncScreenshotMode). The two values we set are
-- ours to recognise: a stored original is never replaced by one of them, or
-- the player's real setting would be gone for good, and only a value that is
-- still ours is ever put back, so a format the player chose since stays.
local function IsAddonFormat(v)
	return v == "png" or v == "tga"
end

local function ScreenshotCVarsOn()
	if type(SetCVar) ~= "function" or type(GetCVar) ~= "function" then return end
	local cur = tostring(GetCVar("screenshotFormat") or "jpeg")
	local saved = db.settings.shotFormatSaved
	-- Nothing on record: this is the player's value. Something on record and a
	-- current value that is neither it nor ours: the player changed it since
	-- (after a crash, say), and that is the setting to give back later.
	if saved == nil or (cur ~= saved and not IsAddonFormat(cur)) then
		db.settings.shotFormatSaved = cur
	end
	if cur == "png" then return end
	local ok = pcall(SetCVar, "screenshotFormat", "png")
	if not ok or GetCVar("screenshotFormat") ~= "png" then pcall(SetCVar, "screenshotFormat", "tga") end
end

local function ScreenshotCVarsOff()
	local saved = db.settings.shotFormatSaved
	if saved == nil then return end
	db.settings.shotFormatSaved = nil
	if type(SetCVar) ~= "function" or type(GetCVar) ~= "function" then return end
	-- Still ours (png, or the tga fallback): put the player's back. Anything
	-- else the player set by hand in the meantime, and it stays.
	if IsAddonFormat(tostring(GetCVar("screenshotFormat") or "")) then pcall(SetCVar, "screenshotFormat", saved) end
end

local function SyncScreenshotMode()
	if ScreenshotMode() then ScreenshotCVarsOn() else ScreenshotCVarsOff() end
end

local RefreshStrip -- below; ScreenshotDone re-runs it for records that arrived mid-shot
local ShotsPaused -- after BridgeState: whether the bridge has been dark too long to shoot for

-- A line for the player in the game chat and in the window, for the few things
-- that happen without them asking (screenshots paused, and resumed).
local function TellPlayer(msg)
	print("|cff66ccff[Claude WoW]|r " .. msg)
	local c = ActiveChat()
	if c then AddHistory(c, "system", msg) end
	if ui.frame then ClaudeWoW.Render() end
end

-- ok = true (SCREENSHOT_SUCCEEDED), false (SCREENSHOT_FAILED or the call raised),
-- nil (no event within SHOT_TIMEOUT: the file may or may not exist).
local function ScreenshotDone(ok)
	local shot = run.shot
	if not shot then return end
	run.shot = nil
	HideStrip()
	local stats = ShotStats()
	if ok == true then stats.ok = stats.ok + 1
	elseif ok == false then stats.failed = stats.failed + 1
	else stats.timeouts = stats.timeouts + 1 end
	if ok == false then
		for id, rec in pairs(run.outbound) do
			if rec.shot == shot.gen then
				rec.shotFails = (rec.shotFails or 0) + 1
				if rec.shotFails < SHOT_RETRIES then
					rec.shot = nil
				else
					-- Every try failed: the bridge should fall back to the pixel
					-- capture. Said on the record (the reload fallback carries it
					-- in the outbox; the strip retries carry it as a flag) and to
					-- the player, once.
					rec.shotFailed = true
					if db.outbox and db.outbox.id == id then db.outbox.shot = "failed" end
					if not run.shotFailTold then
						run.shotFailTold = true
						TellPlayer("the client reported SCREENSHOT_FAILED " .. SHOT_RETRIES .. " times for one message" .. (shot.err and (" (" .. shot.err .. ")") or "") .. ". The message waits for the usual retries and the reload fallback, which tell the bridge to switch to the pixel capture; set capture.mode to \"pixel\" in the bridge's config.json to skip the wait.")
					end
				end
			end
		end
	end
	-- Whatever is still unshot (arrived mid-shot, or just failed) goes next; in
	-- pixel mode this puts the strip back up.
	RefreshStrip()
end

local function TakeScreenshot()
	local s = EnsureStrip()
	run.shotGen = (run.shotGen or 0) + 1
	local gen = run.shotGen
	run.shot = { gen = gen, frames = 0, fired = false }
	run.shotOverride = nil -- a Connect click buys exactly one shot while the bridge is dark
	-- OnUpdate only runs while the strip is shown, which is exactly when the
	-- frames are being rendered with it.
	s:SetScript("OnUpdate", function(self)
		local shot = run.shot
		if not shot or shot.gen ~= gen then
			self:SetScript("OnUpdate", nil)
			return
		end
		shot.frames = shot.frames + 1
		if shot.frames < SHOT_FRAMES then return end
		self:SetScript("OnUpdate", nil)
		shot.fired = true
		ShotStats().taken = ShotStats().taken + 1
		local ok, err = pcall(Screenshot)
		if not ok then
			shot.err = tostring(err)
			ScreenshotDone(false)
			return
		end
		C_Timer.After(SHOT_TIMEOUT, function()
			if run.shot and run.shot.gen == gen then ScreenshotDone(nil) end
		end)
	end)
	return gen
end

-- Redraw the strip from every outbound message the bridge hasn't acknowledged.
RefreshStrip = function()
	local ids = {}
	for id, rec in pairs(run.outbound) do
		if not rec.acked then table.insert(ids, id) end
	end
	if #ids == 0 then
		-- Nothing left to send. A shot still counting frames is called off; one
		-- the client is already writing keeps the strip until its event.
		if run.shot and not run.shot.fired then run.shot = nil end
		if not run.shot then HideStrip() end
		return
	end
	table.sort(ids)
	-- Newest first; drop the oldest if the frame would overflow.
	local parts, size, latest, included = {}, 0, ids[#ids], {}
	for i = #ids, 1, -1 do
		local rec = run.outbound[ids[i]]
		local r = RecordFor(ids[i], rec)
		if size + #r + 1 > Codec.MAX_PAYLOAD then break end
		table.insert(parts, 1, r)
		table.insert(included, rec)
		size = size + #r + 1
	end
	if not ScreenshotMode() then
		-- A shot still counting frames (the transport just changed) is called off.
		if run.shot and not run.shot.fired then run.shot = nil end
		if NoScreenshot() and not run.noShotTold then
			-- The bridge wants screenshots and this client has no Screenshot():
			-- the strip stays up pixel-style, the retries and then the reload
			-- fallback carry the message, and the record tells the bridge to
			-- fall back to the pixel capture (shot=missing). Said once.
			run.noShotTold = true
			TellPlayer("this client has no Screenshot() function, so the bridge's screenshot transport cannot work here. Messages wait for the reload fallback (a couple of minutes the first time), which tells the bridge to switch to the pixel capture; set capture.mode to \"pixel\" in the bridge's config.json to skip the wait.")
		end
		ShowStrip(latest, table.concat(parts, RS))
		return
	end
	if ShotsPaused() then
		-- The bridge has been dark for a while: every shot would be a full-screen
		-- file nobody deletes. The strip goes up pixel-style instead, as when
		-- Screenshot() is missing, so the usual retries and then the reload
		-- fallback take the message from here; nothing is dropped. Said once,
		-- when a shot is actually withheld; Tick says when shooting resumes.
		if run.shot and not run.shot.fired then run.shot = nil end
		if not run.shotsPaused then
			run.shotsPaused = true
			local age = GetTime() - (run.bridgeSeen or run.startedAt or GetTime())
			TellPlayer("bridge not seen for " .. FmtDur(age) .. ": screenshots paused so they don't pile up in your Screenshots folder. Messages wait (the strip stays up, as in pixel mode) and shooting resumes when the bridge is back; the Connect button takes one by hand.")
		end
		ShowStrip(latest, table.concat(parts, RS))
		return
	end
	-- Screenshot transport: only records not yet shot put the strip up.
	local unshot = false
	for _, rec in ipairs(included) do
		if not rec.shot then unshot = true end
	end
	if not unshot then
		if not run.shot then HideStrip() end
		return
	end
	if run.shot and run.shot.fired then
		-- The client is writing a shot of the previous strip; ScreenshotDone takes
		-- another for the records still unshot.
		return
	end
	ShowStrip(latest, table.concat(parts, RS))
	local gen = TakeScreenshot()
	for _, rec in ipairs(included) do rec.shot = gen end
end

-- The two levels the bridge wants the strip drawn at on the screenshot transport
-- and the codec it decodes (`strip = { on, off, codec }` in its slot files; no
-- codec, as an older bridge writes it, is codec 1), sanity-checked and remembered.
local function StripLevels(data)
	local lv = type(data) == "table" and data.strip
	if type(lv) ~= "table" or type(lv.on) ~= "number" or type(lv.off) ~= "number" then return nil end
	local on, off = math.floor(lv.on), math.floor(lv.off)
	if off < 0 or on > 255 or on - off < 8 then return nil end
	return { on = on, off = off, codec = lv.codec == 2 and 2 or 1 }
end

-- The bridge's slot files and Inbox.lua say which transport it listens on, and
-- for the screenshot transport, which levels to draw the strip at.
local function ApplyTransport(data)
	if type(data) ~= "table" or type(data.transport) ~= "string" then return end
	local t = data.transport
	if t ~= "pixel" and t ~= "screenshot" then return end
	-- Why the bridge is on the pixel capture when nobody asked for it (it fell
	-- back after we reported shot=missing or shot=failed); /claude-wow diag shows it.
	db.settings.transportNote = type(data.transportNote) == "string" and data.transportNote ~= "" and data.transportNote or nil
	local lv = StripLevels(data)
	local cur = db.settings.stripLevels
	local sameLevels = (lv == nil and cur == nil) or (lv ~= nil and cur ~= nil and lv.on == cur.on and lv.off == cur.off and lv.codec == (cur.codec or 1))
	if db.settings.transport == t and sameLevels then return end
	db.settings.transport = t
	db.settings.stripLevels = lv
	SyncScreenshotMode()
	-- Whatever is still unacknowledged goes out again the new way.
	for _, rec in pairs(run.outbound) do rec.shot = nil end
	RefreshStrip()
	ClaudeWoW.UpdateStatus()
end

---------------------------------------------------------------------------
-- Signals and slots (in)
---------------------------------------------------------------------------

-- Optional cheap poll: a missing .wav won't play, a real one will. The bridge
-- creates sig/NNN.wav when reply NNN is ready and deletes it to take it back.
-- (An EMPTY file is not a reliable "no": this client reports a 0-byte file as
-- playable, so absence is the only signal that works.) Self-disables if it misbehaves.
local signalAvailable = type(PlaySoundFile) == "function"
local signalStats = { checks = 0, hits = 0, lastHit = nil }

local function SoundValid(path)
	if not signalAvailable or not db.settings.signal then return false end
	signalStats.checks = signalStats.checks + 1
	local ok, willPlay, handle = pcall(PlaySoundFile, path, "Master")
	if not ok then
		signalAvailable = false
		signalStats.error = tostring(willPlay)
		return false
	end
	if willPlay and handle then pcall(StopSound, handle) end
	if willPlay then
		signalStats.hits = signalStats.hits + 1
		signalStats.lastHit = GetTime()
	end
	return willPlay and true or false
end

local function CheckSignal(kind, id)
	if run.signalUnreliable then return false end
	return SoundValid(string.format("Interface\\AddOns\\ClaudeWoW\\%s\\%03d.wav", kind, SlotNumber(id)))
end

local function NoteStaleSignals(id)
	local rec = run.outbound[id]
	if not rec then return end
	rec.staleAck = CheckSignal("ack", id) or nil
	if CheckSignal("sig", id) then
		run.staleSig = run.staleSig or {}
		run.staleSig[id] = true
	end
end

local function FreshSignal(kind, id)
	if kind == "sig" and run.staleSig and run.staleSig[id] then return false end
	return CheckSignal(kind, id)
end

-- Heartbeat: the bridge flips act/NNN/kk.wav for the k-th action of message NNN.
local function ActPath(id, k)
	return string.format("Interface\\AddOns\\ClaudeWoW\\act\\%03d\\%02d.wav", SlotNumber(id), k)
end

local function StartActivity(chat, id)
	local a = { next = 1, count = 0, startedAt = GetTime() }
	-- The bridge can't have written anything yet, so a valid first file means the
	-- client cached this slot number's files from an earlier use: don't trust them.
	if SoundValid(ActPath(id, 1)) then a.unreliable = true end
	run.act = run.act or {}
	run.act[chat.id] = a
end

-- Returns true if the counter moved.
local function PollActivity(chat)
	local a = run.act and run.act[chat.id]
	if not a or a.unreliable or not chat.pendingId then return false end
	local moved = false
	for _ = 1, 3 do
		if a.next > ACT_MAX then break end
		if not SoundValid(ActPath(chat.pendingId, a.next)) then break end
		a.count = a.count + 1
		a.next = a.next + 1
		a.last = GetTime()
		moved = true
	end
	return moved
end

-- Bridge presence. Evidence the bridge is alive comes from several places:
-- presence beats, acks, slot data (which carries the bridge's clock), replies.
local function NotedBridge(at)
	at = at or GetTime()
	if not run.bridgeSeen or at > run.bridgeSeen then run.bridgeSeen = at end
	run.pixelFailed = nil
end

local function PresencePath(k)
	return string.format("Interface\\AddOns\\ClaudeWoW\\presence\\%04d.wav", k)
end

-- Valid presence files form a prefix 1..k, so a binary search finds the head.
local function FindPresenceHead()
	local lo, hi = 0, PRESENCE_MAX
	while lo < hi do
		local mid = math.ceil((lo + hi) / 2)
		if SoundValid(PresencePath(mid)) then lo = mid else hi = mid - 1 end
	end
	return lo
end

local function PollPresence()
	if not signalAvailable or not db.settings.signal then return end
	run.presence = run.presence or { last = FindPresenceHead() }
	local p = run.presence
	for _ = 1, 3 do
		local k = (p.last % PRESENCE_MAX) + 1
		if not SoundValid(PresencePath(k)) then break end
		p.last = k
		p.beats = (p.beats or 0) + 1
		NotedBridge()
	end
end

-- Whether the 30-second presence beats can reach us at all. When they can't
-- (self-test failed, or signal checks turned off), the only evidence of the
-- bridge is a slot read: the idle poll below and the replies themselves.
local function PresenceWorks()
	return signalAvailable and db ~= nil and db.settings.signal
end

-- How long the bridge may go unheard before it counts as stale, then down.
-- With presence beats the bridge is heard from every 30 s, so 90 s of silence is
-- suspicious. Without them the addon only hears from it every IDLE_POLL_SECONDS,
-- so the windows have to be wider or the light could never stay green between
-- messages and every reply would be followed by a Reconnect.
local function PresenceWindows()
	if PresenceWorks() then return 90, 300 end
	return IDLE_POLL_SECONDS + 120, IDLE_POLL_SECONDS * 2 + 120
end

-- Returns state ("ok" | "stale" | "down" | "unknown"), a color and a description.
function ClaudeWoW.BridgeState()
	local seen = run.bridgeSeen
	if not seen then
		return "unknown", 0.6, 0.6, 0.6, "Bridge: not seen yet this session"
	end
	local age = GetTime() - seen
	local okFor, staleFor = PresenceWindows()
	if age < okFor then
		return "ok", 0.2, 0.9, 0.3, "Bridge: connected (seen " .. FmtDur(age) .. " ago)"
	elseif age < staleFor then
		return "stale", 0.95, 0.8, 0.2, "Bridge: last seen " .. FmtDur(age) .. " ago"
	end
	return "down", 0.9, 0.25, 0.25, "Bridge: not seen for " .. FmtDur(age) .. " - is the bridge running?"
end

-- Screenshot transport: no more shots once the bridge would count as down (the
-- same window BridgeState uses: 5 minutes of silence with the presence beats,
-- 22 minutes without them), measured from the last sign of it or, before any,
-- from login. Each shot is a full-screen file only the bridge deletes, so a
-- dead bridge and a player still typing would otherwise fill the disk. A
-- Connect click (run.shotOverride) buys one shot regardless, which is how a
-- bridge that came back is found again when the presence beats can't say so.
-- `raw` ignores the override: what the bridge's silence alone says.
ShotsPaused = function(raw)
	if run.shotOverride and not raw then return false end
	local since = run.bridgeSeen or run.startedAt
	if not since then return false end
	local _, staleFor = PresenceWindows()
	return GetTime() - since >= staleFor
end

-- Same icons the friends list uses for online / away / busy / offline.
local STATE_ICON = {
	ok = "Interface\\FriendsFrame\\StatusIcon-Online",
	stale = "Interface\\FriendsFrame\\StatusIcon-Away",
	down = "Interface\\FriendsFrame\\StatusIcon-DnD",
	unknown = "Interface\\FriendsFrame\\StatusIcon-Offline",
}

function ClaudeWoW.UpdateDot()
	local state, _, _, _, tip = ClaudeWoW.BridgeState()
	if run.pixelFailed then state = "down" end
	if not signalAvailable and signalStats.selftest then
		tip = tip .. "\n(sound-file channel unavailable: " .. signalStats.selftest .. "; using slot checks only)"
	end
	for _, dot in ipairs({ ui.dot, ui.miniDot }) do
		if dot then
			dot:SetTexture(STATE_ICON[state] or STATE_ICON.unknown)
			dot.tip = tip
		end
	end
end

-- Connected = the bridge has been seen recently. In pixel mode, sending needs this;
-- until then the Connect button takes the Send button's place. The reload
-- transport has no idea whether the bridge is there, so it never gates.
function ClaudeWoW.IsConnected()
	if not db or db.settings.mode ~= "pixel" then return true end
	return ClaudeWoW.BridgeState() == "ok" and not run.pixelFailed
end

-- Connect button: say hello to the bridge (it acks, refreshes the slots and
-- offers a restore), ignoring SayHello's throttle so a click always does something.
-- `manual` is the button itself (Send calls this too, for a message typed while
-- disconnected): a deliberate click may take one screenshot even while shots
-- are paused; the automatic path never does, or a dark bridge would still get
-- a file per message typed.
function ClaudeWoW.Connect(manual)
	if db.settings.mode ~= "pixel" then
		SafeReload()
		return
	end
	run.lastHelloAt = nil
	run.pixelFailed = nil
	run.connectFailed = nil
	run.connectingAt = GetTime()
	if manual == true and ScreenshotMode() then run.shotOverride = true end
	ClaudeWoW.SayHello()
end

-- One word for the connection state, so Tick can tell when it changed.
local function ConnectionKey()
	if ClaudeWoW.IsConnected() then return "ok" end
	if run.connectingAt then return "connecting" end
	if run.connectFailed then return "failed" end
	return ClaudeWoW.BridgeState()
end

-- Called every tick: time out a Connect attempt, and redraw when the state flips
-- (light, button, status line, placeholder) without redrawing every tick.
function ClaudeWoW.CheckConnection()
	if run.connectingAt then
		if ClaudeWoW.IsConnected() then
			run.connectingAt, run.connectFailed = nil, nil
			-- A message typed while disconnected goes out now, without a second click,
			-- as long as the same chat is still in front and free.
			local queued = run.sendOnConnect
			run.sendOnConnect = nil
			local c = queued and ActiveChat()
			if c and c.id == queued.chat and not c.pendingId then
				if ui.input and Trim(ui.input:GetText() or "") == queued.text then ui.input:SetText("") end
				ClaudeWoW.Send(queued.text, queued.allow, queued.opts)
			end
		elseif GetTime() - run.connectingAt > CONNECT_WAIT then
			run.connectingAt, run.connectFailed = nil, true
			run.sendOnConnect = nil -- the text is still in the box
			run.shotOverride = nil -- an unused click does not carry over to a later shot
		end
	elseif run.connectFailed and ClaudeWoW.IsConnected() then
		run.connectFailed = nil
	end
	local key = ConnectionKey()
	if key ~= run.connKey then
		run.connKey = key
		ClaudeWoW.Render()
	end
end

-- Swap Send and Connect depending on the state; part of UpdateStatus.
function ClaudeWoW.UpdateConnect()
	if not ui.connect or not ui.send then return end
	local connected = ClaudeWoW.IsConnected()
	ui.send:SetShown(connected)
	ui.connect:SetShown(not connected)
	if connected then return end
	if run.connectingAt then
		ui.connect:SetText("Connecting...")
		ui.connect:Disable()
	else
		ui.connect:SetText(ClaudeWoW.BridgeState() == "stale" and "Reconnect" or "Connect")
		ui.connect:Enable()
	end
end

-- Prove the sound-file trick actually distinguishes empty from valid files on this
-- client before trusting it for presence, heartbeats and readiness signals.
local function SelfTestSignals()
	if not signalAvailable then
		signalStats.selftest = "PlaySoundFile missing"
		return
	end
	-- ctl/absent.wav is never created by setup; it must read as unplayable.
	local missingLooksValid = SoundValid("Interface\\AddOns\\ClaudeWoW\\ctl\\absent.wav")
	local validLooksValid = SoundValid("Interface\\AddOns\\ClaudeWoW\\ctl\\valid.wav")
	if missingLooksValid then
		signalAvailable = false
		signalStats.selftest = "a missing file reports as playable"
	elseif not validLooksValid then
		signalAvailable = false
		signalStats.selftest = "a valid file reports as unplayable (files not indexed? restart WoW)"
	else
		signalStats.selftest = "passed"
	end
end

local function ActivityLine(chat)
	local a = run.act and run.act[chat.id]
	local now = GetTime()
	local started = (a and a.startedAt) or run.sentAt or now
	local s = "running " .. FmtDur(now - started)
	if a and not a.unreliable then
		s = s .. " - " .. a.count .. (a.count == 1 and " action" or " actions")
		if a.last then
			local quiet = now - a.last
			s = s .. ", last " .. FmtDur(quiet) .. " ago"
			if quiet > 120 then s = s .. " (quiet for a while - stuck? /claude-wow cancel)" end
		elseif now - started > 60 then
			s = s .. ", no activity seen yet"
		end
	end
	return s
end

local function FreeSlot()
	for i = 1, SLOT_COUNT do
		local name = SlotName(i)
		if not C_AddOns.IsAddOnLoaded(name) then
			return name
		end
	end
end

local function ScheduleNextPoll()
	local idx = (run.polls or 0) + 1
	local t = POLL_SCHEDULE[idx]
	if not t then
		t = POLL_SCHEDULE[#POLL_SCHEDULE] + POLL_TAIL * (idx - #POLL_SCHEDULE)
	end
	run.nextPollAt = (run.sentAt or GetTime()) + t
end

local Finish -- defined below

---------------------------------------------------------------------------
-- Context growth
---------------------------------------------------------------------------
--
-- Every message resumes the chat's agent session, so the context the model
-- reads grows with every turn and each message costs more than the last
-- (measured: 107k tokens after 8 turns, 312k after 213). The bridge reports,
-- on every final reply, what the next message will carry (ctx), how many turns
-- the session has had, and the model's window when its CLI names it. The
-- footer shows it, /claude-wow context reports it, and past the threshold the
-- chat says so once and offers a new chat.

local function NoteUsage(c, r)
	if type(r.turns) == "number" then c.turns = r.turns end
	if type(r.ctx) == "number" and r.ctx > 0 then
		c.ctx = r.ctx
	elseif type(r.turns) == "number" and r.turns <= 1 then
		c.ctx = nil -- a fresh session with an agent that reports nothing
	end
	if type(r.window) == "number" and r.window > 0 then c.window = r.window end
	-- When the session started (its clock), and what it would have cost at API
	-- prices so far; a fresh session starts both over.
	if type(r.since) == "number" and r.since > 0 then c.since = r.since end
	if type(r.cost) == "number" then c.cost = r.cost
	elseif type(r.turns) == "number" and r.turns <= 1 then c.cost = nil end
end

-- The footer segment, shaped like Claude Code's status line:
-- "11m 58s · ↓ 186.7k tokens · ≈$2.41 API". Elapsed since the chat's current
-- agent session started; the tokens its next message carries; the session's
-- runs at API list prices ("API": a comparison, a subscription is not billed
-- by the token). Each part only when known; "" when none is.
local function ContextSegment(c, long)
	if not c then return "" end
	local parts = {}
	if c.since then table.insert(parts, FmtElapsed(time() - c.since)) end
	if c.ctx then
		table.insert(parts, SEG_DOWN .. " " .. FmtTokens(c.ctx) .. " tokens" .. ((long and c.window) and (" of " .. FmtTokens(c.window)) or ""))
	end
	if c.cost then table.insert(parts, SEG_APPROX .. string.format("$%.2f API", c.cost)) end
	return table.concat(parts, " " .. SEG_DOT .. " ")
end

-- "8 turns" for diag and the context report.
local function TurnsLabel(c)
	if not c or not c.turns then return "" end
	return c.turns .. (c.turns == 1 and " turn" or " turns")
end

local function ContextThresholdLabel()
	local limit = tonumber(db.settings.contextWarn) or 0
	if limit > 0 then return "warning at " .. FmtTokens(limit) .. " tokens (/claude-wow context <n> to change, 0 = off)" end
	return "warning off (/claude-wow context <n> turns it on)"
end

-- What /claude-wow context prints for the current chat.
local function ContextReport(c)
	local size
	if c and c.ctx then
		size = "Context: " .. FmtTokens(c.ctx) .. " tokens" .. (c.window and (" of " .. FmtTokens(c.window)) or "") .. " after " .. (c.turns or "?") .. " turn" .. ((c.turns or 0) == 1 and "" or "s") .. ": that is what your next message here re-reads before it starts on your question."
	elseif c and c.turns then
		size = "Context: " .. c.turns .. " turn" .. (c.turns == 1 and "" or "s") .. " in this session; " .. ChatAgentName(c) .. " does not report its context size."
	else
		size = "Context: nothing yet - no reply in this session."
	end
	if c and c.since then
		size = size .. "\nSession: " .. FmtElapsed(time() - c.since) .. " since it started"
			.. (c.cost and string.format("; %s$%.2f at API list prices so far (a comparison, not a bill: a subscription is not charged per token)", SEG_APPROX, c.cost) or "") .. "."
	end
	return size .. "\n" .. ContextThresholdLabel():gsub("^%l", string.upper) .. "."
end

-- Past the threshold: say so once per crossing (a fresh session brings the
-- number back down, which re-arms it), with a New chat button on the message.
local function ContextWarning(c)
	local limit = tonumber(db.settings.contextWarn) or 0
	if limit <= 0 or not c.ctx or c.ctx < limit then
		c.ctxWarned = nil
		return
	end
	if c.ctxWarned then return end
	c.ctxWarned = true
	local size = FmtTokens(c.ctx) .. " tokens"
	local text = "This chat's context is " .. size .. (c.window and (" of " .. FmtTokens(c.window)) or "") .. " after " .. (c.turns or "?") .. " turns, past the " .. FmtTokens(limit) .. " mark. "
		.. "Every message you send here re-reads all " .. size .. " before it starts on your question, so each reply costs more than the last and is slower to start, and it only grows.\n"
		.. (c.cost and string.format("At API list prices this session comes to %s$%.2f so far (a comparison, not a bill). ", SEG_APPROX, c.cost) or "")
		.. "Start a new chat to reset it: the New chat button below, or /claude. You lose " .. ChatAgentName(c) .. "'s memory of this conversation; this transcript stays here.\n"
		.. "Said once per crossing. /claude-wow context <n> moves the mark, /claude-wow context 0 turns it off."
	AddHistory(c, "system", text)
	c.history[#c.history].newChat = true
	-- Where the reply itself went: the whisper tab if the chat has one, else the game chat.
	if not Whisper.Reply(c, text, nil, "system") then
		print("|cff66ccff[Claude WoW]|r " .. Display(c.name) .. ": " .. (text:gsub("\n", " ")) .. " Type /claude for a new chat.")
	end
end

-- The bridge has read this record: whatever game context rode on it is now
-- what the bridge knows, so later messages only carry it again if it changes.
local function NoteAcked(rec)
	rec.acked = true
	if rec.ctx ~= nil then run.contextSent = rec.ctx end
end

local function MarkAcked(id)
	local rec = run.outbound[id]
	if rec and not rec.acked then
		NoteAcked(rec)
		RefreshStrip()
	end
	NotedBridge()
end

-- Dispatch a list of reply records to the chats waiting for them.
local function ApplyReplies(replies)
	local matched = false
	for _, r in ipairs(replies or {}) do
		local c = FindChat(r.chat)
		if c and c.pendingId and r.id == c.pendingId then
			matched = true
			MarkAcked(r.id)
			local denied = type(r.denied) == "table" and #r.denied > 0 and r.denied or nil
			if r.status == "done" or r.status == "error" then NoteUsage(c, r) end
			if r.status == "done" then
				Finish(c, "assistant", r.text or "", denied, r.agent, r.summary, ClaudeWoW.CleanMacros(r.macros))
			elseif r.status == "error" then
				Finish(c, "system", "Bridge error: " .. tostring(r.text), denied)
			elseif r.status == "working" then
				c.progress = r.text
				Whisper.Progress(c, r.text)
			end
		end
	end
	return matched
end

-- The bridge keeps every chat's transcript. After the client wipes our saved data,
-- it sends them back once, addressed to our new session token.
local function ImportRestore(r)
	if type(r) ~= "table" or r.token ~= db.session or db.restored then return end
	db.restored = true
	local added = 0
	local current = ActiveChat()
	for _, rc in ipairs(r.chats or {}) do
		-- Skip chats deleted here that the bridge hasn't been told about yet.
		if type(rc) == "table" and rc.id and not FindChat(rc.id) and not db.forget[rc.id] and #db.chats < MAX_CHATS then
			local chat = {
				id = rc.id,
				name = (rc.name and rc.name ~= "") and rc.name or ("Chat " .. (#db.chats + 1)),
				cwd = rc.cwd or DEFAULT_CWD,
				agent = "",
				plugin = type(rc.plugin) == "string" and rc.plugin or "",
				ctx = type(rc.ctx) == "number" and rc.ctx > 0 and rc.ctx or nil,
				turns = type(rc.turns) == "number" and rc.turns > 0 and rc.turns or nil,
				since = type(rc.since) == "number" and rc.since > 0 and rc.since or nil,
				cost = type(rc.cost) == "number" and rc.cost or nil,
				history = {},
				unread = 0,
				created = time(),
			}
			for _, m in ipairs(rc.messages or {}) do
				local role, agent = m.role, m.agent
				if role == "claude" then role, agent = "assistant", agent or "claude" end -- an older bridge's transcript
				if agent == "" then agent = nil end
				table.insert(chat.history, { role = role, text = m.text, id = m.id, t = m.t, agent = agent })
			end
			-- Keep the chat we're currently using last so it stays where it was.
			table.insert(db.chats, math.max(1, #db.chats), chat)
			added = added + 1
		end
	end
	run.restoring = nil
	if added > 0 then
		if current and #current.history <= 2 then
			for _, ch in ipairs(db.chats) do
				if ch ~= current and ch.name == current.name then current.name = "New chat" end
			end
		end
		AddHistory(current, "system", "Restored " .. added .. " chat(s) from the bridge after the game reset the saved data.")
		ClaudeWoW.RenderChatList()
	end
end

local function TryLoadSlot(why)
	local name = FreeSlot()
	if not name then
		run.slotsExhausted = true
		ClaudeWoW.ArmAutoRefresh()
		ClaudeWoW.UpdateStatus()
		return
	end
	ClaudeWoW_SlotData = nil
	local loaded, reason = C_AddOns.LoadAddOn(name)
	if not loaded then
		run.slotError = reason
		run.slotsMissing = true
		ClaudeWoW.ArmAutoRefresh()
		if reason ~= "MISSING" and reason ~= "DISABLED" and not run.slotErrorTold then
			run.slotErrorTold = true
			local build = select(4, GetBuildInfo())
			local fix = reason == "INTERFACE_VERSION"
				and ("the slot addons were made for another game version (this client is " .. tostring(build) .. "). Set tocInterface to " .. tostring(build) .. " in the bridge's config.json, run \"npm run slots\", then restart WoW.")
				or "run \"npm run slots\" on the bridge's machine, then restart WoW."
			TellPlayer("reply slots do not load (" .. tostring(reason) .. "): " .. fix .. " Until then replies arrive on /reload.")
		end
		ClaudeWoW.UpdateStatus()
		return
	end
	run.polls = (run.polls or 0) + 1
	ScheduleNextPoll()
	local data = ClaudeWoW_SlotData
	if type(data) == "table" and type(data.now) == "number" then
		-- The bridge's clock and ours are the same machine; translate to GetTime().
		NotedBridge(GetTime() - (time() - data.now))
	end
	if type(data) == "table" and type(data.cwd) == "string" and data.cwd ~= "" then run.bridgeCwd = data.cwd end
	if type(data) == "table" then
		if type(data.agent) == "string" and data.agent ~= "" then run.bridgeAgent = data.agent end
		if type(data.agents) == "table" and #data.agents > 0 then run.bridgeAgents = data.agents end
		if type(data.plugin) == "string" and data.plugin ~= "" then run.bridgePlugin = data.plugin end
		if type(data.plugins) == "table" and #data.plugins > 0 then run.bridgePlugins = data.plugins end
		ApplyTransport(data)
	end
	local matched = ApplyReplies(type(data) == "table" and data.replies or nil)
	if type(data) == "table" and data.restore then ImportRestore(data.restore) end
	if type(data) == "table" and data.map and ClaudeWoWMap then ClaudeWoWMap.Sync(data.map) end
	if why == "signal" and not matched then
		run.signalUnreliable = true
	end
	ClaudeWoW.Render()
end

local function Tick()
	if not db then return end
	local now = GetTime()
	PollPresence()
	-- Without presence beats, the only evidence is a slot read; spend one every
	-- IDLE_POLL_SECONDS while idle so the light still reflects reality (and stays
	-- green while the bridge is up: BridgeState allows for this interval).
	if not PresenceWorks() and db.settings.mode == "pixel" and not AnyPending()
		and now - (run.lastIdlePoll or -1e9) >= IDLE_POLL_SECONDS then
		run.lastIdlePoll = now
		TryLoadSlot("idle")
	end
	ClaudeWoW.UpdateDot()
	ClaudeWoW.CheckConnection()
	-- The footer's elapsed time ticks while the window is open (a pending chat
	-- refreshes it below anyway).
	if ui.frame and ui.frame:IsShown() and not AnyPending() then
		local c = ActiveChat()
		if c and c.since then ClaudeWoW.UpdateStatus() end
	end
	if run.shotsPaused and not ShotsPaused(true) then
		-- Heard from the bridge again (a beat, an ack, a slot): shoot what waited.
		run.shotsPaused = nil
		TellPlayer("bridge is back: screenshots resume")
		RefreshStrip()
	end
	if db.settings.mode ~= "pixel" then return end
	local changed = false
	if run.helloPollAt and now >= run.helloPollAt then
		run.helloPollAt = nil
		TryLoadSlot("hello")
		-- Whatever that slot held, the wait is over.
		if run.restoring then
			run.restoring = nil
			ClaudeWoW.Render()
		end
	end
	if run.restoring and now - run.restoring > 25 then
		run.restoring = nil
		ClaudeWoW.Render()
	end
	for id, rec in pairs(run.outbound) do
		if not rec.acked and not rec.staleAck and CheckSignal("ack", id) then
			NoteAcked(rec)
			changed = true
			NotedBridge()
		end
		-- A hello only needs the bridge to have been seen; it never escalates.
		-- A forget is the same, but the bridge must have been seen a moment after
		-- the record went up, so it had a chance to read it. That holds for a strip
		-- that stays up; on the screenshot transport only the ack file says it was read.
		if (rec.hello or rec.forget) and not rec.acked and not ScreenshotMode() and run.bridgeSeen and run.bridgeSeen >= rec.sentAt + (rec.forget and 2 or 0) then
			NoteAcked(rec)
			changed = true
		end
		if rec.acked then
			if rec.forget then db.forget[rec.forget] = nil end
			run.outbound[id] = nil
			changed = true
		elseif rec.hello and now - rec.sentAt >= 20 then
			run.outbound[id] = nil
			changed = true
		elseif now - rec.sentAt >= STRIP_SECONDS then
			rec.tries = (rec.tries or 1) + 1
			if rec.tries <= STRIP_TRIES then
				-- Nobody picked it up: show it again (a new screenshot in that mode).
				rec.sentAt = now
				rec.shot = nil
				changed = true
			elseif rec.forget or rec.cancelOf then
				-- The bridge is away; db.forget keeps it for the next hello.
				run.outbound[id] = nil
				changed = true
			else
				-- Give up on pixels for this message; the reload path still has it.
				run.outbound[id] = nil
				run.pixelFailed = true
				changed = true
				ClaudeWoW.ArmAutoRefresh()
			end
		end
	end
	if changed then
		RefreshStrip()
		ClaudeWoW.UpdateStatus()
	end
	if not AnyPending() then return end
	local moved = false
	for _, c in ipairs(db.chats) do
		if c.pendingId and PollActivity(c) then moved = true end
	end
	if moved then ClaudeWoW.Render() end
	for _, c in ipairs(db.chats) do
		if c.pendingId and FreshSignal("sig", c.pendingId) then
			TryLoadSlot("signal")
			return
		end
	end
	if run.nextPollAt and now >= run.nextPollAt then
		TryLoadSlot("schedule")
	end
end

-- Pull whatever bridge.js last wrote into Inbox.lua (the reload path).
local function ProcessInbox()
	local inbox = ClaudeWoW_Inbox
	if type(inbox) ~= "table" then return end
	if type(inbox.cwd) == "string" and inbox.cwd ~= "" then run.bridgeCwd = inbox.cwd end
	if type(inbox.agent) == "string" and inbox.agent ~= "" then run.bridgeAgent = inbox.agent end
	if type(inbox.agents) == "table" and #inbox.agents > 0 then run.bridgeAgents = inbox.agents end
	if type(inbox.plugin) == "string" and inbox.plugin ~= "" then run.bridgePlugin = inbox.plugin end
	if type(inbox.plugins) == "table" and #inbox.plugins > 0 then run.bridgePlugins = inbox.plugins end
	ApplyTransport(inbox)
	ApplyReplies(inbox.replies)
	if inbox.restore then ImportRestore(inbox.restore) end
	if inbox.map and ClaudeWoWMap then ClaudeWoWMap.Sync(inbox.map) end
end

Finish = function(chat, role, text, denied, agent, summary, macros)
	AddHistory(chat, role, text, chat.pendingId, denied, agent, macros)
	chat.pendingId = nil
	chat.progress = nil
	ContextWarning(chat)
	if run.act then run.act[chat.id] = nil end
	NotedBridge()
	local visible = ui.frame and ui.frame:IsShown() and db.activeChat == chat.id
	if not visible then
		chat.unread = (chat.unread or 0) + 1
	end
	if not AnyPending() then
		keyCatcher:Hide()
	end
	if visible and ui.input and chat.draft and chat.draft ~= "" then
		ui.input:SetText(chat.draft)
		chat.draft = nil
	end
	ClaudeWoW.Render()
	ClaudeWoW.Notify(chat, text, agent, summary, role, denied)
end

---------------------------------------------------------------------------
-- Game context and links
---------------------------------------------------------------------------

-- The agent only sees text, so two things about the game are spelled out for it:
-- who is asking (the character, where they are; sent with the hello and again
-- when it changes, and put into the agent's system prompt by the bridge), and
-- what the player shift-clicked into the message (item, spell and quest links
-- are meaningless markup to the agent; their tooltips are what the player sees).
-- Every game API here is optional: whatever the client lacks is left out.

local CONTEXT_MAX = 900 -- bytes of context per record; the strip has ~3.2 KB for everything
local LINK_LINES_MAX = 30 -- tooltip lines kept per link
local LINK_BYTES_MAX = 900 -- bytes kept per link

-- Call a game API that may not exist or may throw, and get its returns or nothing.
local function Try(fn, ...)
	if type(fn) ~= "function" then return nil end
	local ok, a, b, c, d, e, f, g = pcall(fn, ...)
	if ok then return a, b, c, d, e, f, g end
end

local function Money(copper)
	copper = tonumber(copper) or 0
	local g, s, c = math.floor(copper / 10000), math.floor(copper / 100) % 100, copper % 100
	if g > 0 then return g .. "g " .. s .. "s " .. c .. "c" end
	if s > 0 then return s .. "s " .. c .. "c" end
	return c .. "c"
end

-- A few lines about the game and the character, as the bridge will show them to the agent.
-- Profession and secondary skill lines by skill id (vanilla ids).
local PROFESSION_SKILL_IDS = {
	[164] = true, [165] = true, [171] = true, [182] = true, [186] = true, [197] = true, [202] = true,
	[333] = true, [393] = true, [129] = true, [185] = true, [356] = true,
}

-- The character's skill lines as { name, isHeader, rank, maxRank, skillID }.
-- Forever only has C_SkillInfo (one table per line); the classic globals
-- (multiple returns) are the fallback for other clients.
function ClaudeWoW.SkillLines()
	local out = {}
	if C_SkillInfo and C_SkillInfo.GetNumSkillLines then
		local n = Try(C_SkillInfo.GetNumSkillLines)
		local seen = {}
		for i = 1, (type(n) == "number" and n or 0) do
			local sk = Try(C_SkillInfo.GetSkillLineInfo, i)
			-- Child lines (parentSkillLineID ~= 0) repeat their parent; Blizzard's
			-- skills frame skips them too.
			if type(sk) == "table" and type(sk.name) == "string" and (sk.parentSkillLineID or 0) == 0 then
				local key = sk.isHeader and ("h:" .. sk.name) or (sk.skillID or sk.name)
				if not seen[key] then
					seen[key] = true
					out[#out + 1] = { name = sk.name, isHeader = sk.isHeader, rank = sk.rank, maxRank = sk.maxRank, skillID = sk.skillID }
				end
			end
		end
		return out
	end
	local n = Try(GetNumSkillLines)
	for i = 1, (type(n) == "number" and n or 0) do
		local sname, isHeader, _, rank, _, _, maxRank = Try(GetSkillLineInfo, i)
		if type(sname) == "string" then
			out[#out + 1] = { name = sname, isHeader = isHeader and true or false, rank = rank, maxRank = maxRank }
		end
	end
	return out
end

function ClaudeWoW.GameContext()
	local lines = {}
	local version, build, _, toc = Try(GetBuildInfo)
	toc = tonumber(toc)
	local game = "World of Warcraft"
	if toc and toc >= 16000 and toc < 20000 then game = "World of Warcraft: Forever" end
	local client = ""
	if version then
		client = " (client " .. tostring(version) .. (build and ("." .. tostring(build)) or "") .. (toc and (", interface " .. toc) or "") .. ")"
	end
	table.insert(lines, "Game: " .. game .. client)

	local name = Try(UnitName, "player")
	if name then
		local realm = Try(GetRealmName)
		local level = Try(UnitLevel, "player")
		local race = Try(UnitRace, "player")
		local class = Try(UnitClass, "player")
		local faction = Try(UnitFactionGroup, "player")
		local guild = Try(GetGuildInfo, "player")
		local who = "Character: " .. tostring(name) .. (realm and (" on " .. tostring(realm)) or "")
		local desc = {}
		if level then table.insert(desc, "level " .. tostring(level)) end
		if race then table.insert(desc, tostring(race)) end
		if class then table.insert(desc, tostring(class)) end
		if #desc > 0 then who = who .. ", " .. table.concat(desc, " ") end
		if faction then who = who .. " (" .. tostring(faction) .. ")" end
		if guild then who = who .. ", guild <" .. tostring(guild) .. ">" end
		table.insert(lines, who)
	end

	local zone = Try(GetZoneText)
	local sub = Try(GetSubZoneText)
	if zone and zone ~= "" then
		table.insert(lines, "Location: " .. zone .. ((sub and sub ~= "" and sub ~= zone) and (" - " .. sub) or ""))
	end

	-- Map coordinates, as the minimap shows them (0-100 across the current map;
	-- addons get no world x/y/z). Modern C_Map first, the vanilla call as fallback.
	local x, y, mapName
	local mapId = Try(C_Map and C_Map.GetBestMapForUnit, "player")
	if type(mapId) == "number" then
		local pos = Try(C_Map.GetPlayerMapPosition, mapId, "player")
		if type(pos) == "table" and type(pos.x) == "number" and type(pos.y) == "number" then x, y = pos.x, pos.y end
		local info = Try(C_Map.GetMapInfo, mapId)
		if type(info) == "table" and type(info.name) == "string" then mapName = info.name end
	end
	if not x then
		local px, py = Try(GetPlayerMapPosition, "player")
		if type(px) == "number" and type(py) == "number" then x, y = px, py end
	end
	if x and y and (x > 0 or y > 0) then
		local where = (mapName and mapName ~= zone) and (" on " .. mapName) or ""
		table.insert(lines, string.format("Position: %.1f, %.1f%s%s", x * 100, y * 100, where, mapId and (" (map " .. mapId .. ")") or ""))
	end

	local progress = {}
	local copper = Try(GetMoney)
	if copper then table.insert(progress, "Money: " .. Money(copper)) end
	local xp, xpMax = Try(UnitXP, "player"), Try(UnitXPMax, "player")
	if type(xp) == "number" and type(xpMax) == "number" and xpMax > 0 then
		table.insert(progress, "XP: " .. xp .. "/" .. xpMax)
	end
	if #progress > 0 then table.insert(lines, table.concat(progress, "; ")) end

	-- Classic-style talent tabs: name, icon, points spent.
	local tabs = Try(GetNumTalentTabs)
	if type(tabs) == "number" and tabs > 0 then
		local parts = {}
		for i = 1, tabs do
			local tname, _, points = Try(GetTalentTabInfo, i)
			if type(tname) == "string" and type(points) == "number" then
				table.insert(parts, tname .. " " .. points)
			end
		end
		if #parts > 0 then table.insert(lines, "Talents: " .. table.concat(parts, " / ")) end
	end

	-- Skill lines under the Professions and Secondary Skills headers.
	local header, parts = nil, {}
	local wanted = { [TRADE_SKILLS or "Professions"] = true, [SECONDARY_SKILLS or "Secondary Skills"] = true }
	for _, sk in ipairs(ClaudeWoW.SkillLines()) do
		if sk.isHeader then
			header = sk.name
		elseif (header and wanted[header]) or PROFESSION_SKILL_IDS[sk.skillID] then
			table.insert(parts, sk.name .. (sk.rank and (" " .. tostring(sk.rank) .. (sk.maxRank and ("/" .. tostring(sk.maxRank)) or "")) or ""))
		end
	end
	if #parts > 0 then table.insert(lines, "Professions: " .. table.concat(parts, ", ")) end

	-- Quest log ids (what is accepted, and which are done), so route planning can
	-- skip pickups and turn-ins that no longer apply.
	local quests = {}
	local qn = Try(C_QuestLog and C_QuestLog.GetNumQuestLogEntries) or Try(GetNumQuestLogEntries)
	if type(qn) == "number" then
		for i = 1, math.min(qn, 40) do
			local id, header, complete
			local info = Try(C_QuestLog and C_QuestLog.GetInfo, i)
			if type(info) == "table" then
				id, header = info.questID, info.isHeader
				complete = Try(C_QuestLog.IsComplete, id)
			else
				local _, _, _, isHeader, _, isComplete, _, qid = Try(GetQuestLogTitle, i)
				id, header, complete = qid, isHeader, isComplete == 1 or isComplete == true
			end
			if not header and type(id) == "number" and id > 0 then
				table.insert(quests, tostring(id) .. (complete and "*" or ""))
			end
		end
	end
	if #quests > 0 then table.insert(lines, "Quest log (id, * = ready to turn in): " .. table.concat(quests, ",")) end

	local s = table.concat(lines, "\n"):gsub("[\30\31]", " ")
	if #s > CONTEXT_MAX then s = s:sub(1, CONTEXT_MAX) end
	return s
end

-- The context to put on the next record, or nil when the bridge already has
-- it (or it wouldn't fit next to this message; it goes with a later one).
-- "" when the setting is off, so the bridge drops what it had.
local function ContextToSend(room)
	local ctx = db.settings.context and ClaudeWoW.GameContext() or ""
	if ctx == (run.contextSent or "") then return nil end
	if room and #ctx > room then return nil end
	return ctx
end

-- Read a link's tooltip off a hidden GameTooltip, one line per row.
local scanTip
local function TooltipLines(payload)
	if not scanTip then
		scanTip = CreateFrame("GameTooltip", "ClaudeWoWScanTip", UIParent, "GameTooltipTemplate")
	end
	scanTip:SetOwner(UIParent, "ANCHOR_NONE")
	scanTip:ClearLines()
	local lines = {}
	if pcall(scanTip.SetHyperlink, scanTip, payload) then
		for i = 1, math.min(scanTip:NumLines() or 0, LINK_LINES_MAX) do
			local left = _G["ClaudeWoWScanTipTextLeft" .. i]
			local right = _G["ClaudeWoWScanTipTextRight" .. i]
			local l = Trim(tostring((left and left:GetText()) or ""))
			local r = Trim(tostring((right and right:IsShown() and right:GetText()) or ""))
			if r ~= "" then l = l .. "  " .. r end
			if l ~= "" then table.insert(lines, l) end
		end
	end
	scanTip:Hide()
	return lines
end

-- What a link is, in words: "item 2140 (Uncommon)", "spell 1978", "quest 176".
local function DescribeLink(payload)
	local kind, id = payload:match("^(%a+):(%d+)")
	if not kind then return payload:match("^(%a+)") or "link" end
	local s = kind .. " " .. id
	if kind == "item" then
		local _, _, quality = Try((C_Item and C_Item.GetItemInfo) or GetItemInfo, payload)
		local desc = type(quality) == "number" and _G["ITEM_QUALITY" .. quality .. "_DESC"]
		if desc then s = s .. " (" .. desc .. ")" end
	end
	return s
end

-- Turn the links in a message into text the agent can use: each becomes [Name]
-- in place, and a block at the end lists what the tooltip says about it.
-- Returns the new text and the number of links found.
function ClaudeWoW.ExpandLinks(text)
	local links, seen = {}, {}
	local function Take(payload, name)
		if not seen[payload] then
			seen[payload] = true
			table.insert(links, { payload = payload, name = name })
		end
		return "[" .. name .. "]"
	end
	-- Coloured links first (|cAARRGGBB|H...|h[Name]|h|r), then bare ones.
	local out = text:gsub("|c%x%x%x%x%x%x%x%x|H([^|]+)|h%[([^%]]*)%]|h|r", Take)
	out = out:gsub("|H([^|]+)|h%[([^%]]*)%]|h", Take)
	if #links == 0 then return text, 0 end
	local blocks = {}
	for _, l in ipairs(links) do
		local head = "[" .. l.name .. "] " .. DescribeLink(l.payload)
		local body = table.concat(TooltipLines(l.payload), "\n  ")
		local block = body ~= "" and (head .. "\n  " .. body) or head
		if #block > LINK_BYTES_MAX then block = block:sub(1, LINK_BYTES_MAX) .. "..." end
		table.insert(blocks, block)
	end
	return out .. "\n\n--- Linked from the game ---\n" .. table.concat(blocks, "\n"), #links
end

---------------------------------------------------------------------------
-- Sending
---------------------------------------------------------------------------

-- allow: optional list of permission rules to grant before this message runs.
---------------------------------------------------------------------------
-- Whisper tabs
---------------------------------------------------------------------------

-- "/claude-wow whisper on" (off by default): every chat gets a native whisper tab
-- in the chat dock, opened on its first message the way a stranger's whisper
-- opens one. Replies are written into it as incoming whispers and the tab
-- flashes when it isn't the one on screen; what you send shows as "To Claude:";
-- Enter in that tab goes to the agent. The addon window is untouched and stays
-- the record of the chat. Tabs are temporary windows: gone with a reload,
-- opened again on the next message.
--
-- Nothing here may reach the server. The tab's edit box holds a whisper to a
-- name no player has ("Claude"), so every send path is cut before the game's
-- own. Three layers, because this client's chat code is a mixin behind the old
-- globals and only the game knows which runs first: the box's OnEnterPressed
-- script (what Enter runs), its SendText and SendMessage methods (the /r hook
-- already lives there, and shipped), and the ChatEdit_SendText and
-- ChatFrameUtil.SendText entry points. Should a whisper still get out, the
-- server answers "No player named 'Claude'" as a system message: a filter turns
-- that into a loud LEAK line and counts it (/aiwhisper status), so a failure
-- can't pass for the game's business.

local WHISPER_TEXT_MAX = 4000 -- characters of a reply written into the tab before it points at the window
local WHISPER_PROBE_NAME = "Cwowprobe" -- /aiwhisper leak whispers this nobody to prove the leak filter works

local function WhisperOn()
	return db ~= nil and db.settings.whisper == true
end

local function WhisperColor(kind, r, g, b)
	local info = type(ChatTypeInfo) == "table" and ChatTypeInfo[kind]
	if type(info) == "table" and info.r then return info.r, info.g, info.b end
	return r, g, b
end

-- The game's own format string when it has one ("%s whispers: "), else ours.
local function WhisperFormat(fmt, default, arg)
	if type(fmt) == "string" then
		local ok, s = pcall(string.format, fmt, arg)
		if ok then return s end
	end
	return string.format(default, arg)
end

-- Every chat frame the dock knows, temporary ones included.
local function WhisperFrames()
	local list, seen = {}, {}
	local function add(f)
		if type(f) == "table" and not seen[f] then
			seen[f] = true
			table.insert(list, f)
		end
	end
	if type(CHAT_FRAMES) == "table" then
		for _, name in ipairs(CHAT_FRAMES) do add(_G[name]) end
	end
	for i = 1, (NUM_CHAT_WINDOWS or 10) + 30 do add(_G["ChatFrame" .. i]) end
	return list
end

local function WhisperAlive(frame)
	return frame ~= nil and frame.inUse ~= false and (frame.isDocked or frame:IsShown()) and true or false
end

local function WhisperTab(frame)
	return frame.tab or _G[frame:GetName() .. "Tab"]
end

local function WhisperBox(frame)
	return frame.editBox or _G[frame:GetName() .. "EditBox"]
end

-- Still the tab we opened: alive, and its whisper still aimed at our agent (a
-- closed temporary window is reused by the game for the next real whisper).
local function WhisperOwns(chat, frame)
	if not frame or frame.claudewowChatId ~= chat.id or not WhisperAlive(frame) then return false end
	local eb = WhisperBox(frame)
	local target = eb and eb.GetAttribute and eb:GetAttribute("tellTarget")
	return target == nil or frame.claudewowTarget == nil or tostring(target):lower() == frame.claudewowTarget:lower()
end

local function WhisperWrite(frame, text, r, g, b)
	if frame and frame.AddMessage then pcall(frame.AddMessage, frame, text, r, g, b) end
end

function Whisper.Retitle(chat)
	local frame = run.whisperTabs and run.whisperTabs[chat.id]
	if not frame then return end
	local title = Display(chat.name)
	if frame.claudewowTitle == title then return end
	frame.claudewowTitle = title
	local ok = type(FCF_SetWindowName) == "function" and pcall(FCF_SetWindowName, frame, title, true)
	if not ok then
		local tab = WhisperTab(frame)
		if tab and tab.SetText then pcall(tab.SetText, tab, title) end
	end
end

-- Enter on a chat edit box. Wrapped once per box, ours and the game's own, so a
-- whisper to an agent goes to the addon wherever it is typed. The original
-- handler runs for everything else.
local function WhisperHookBox(eb)
	if type(eb) ~= "table" or eb.claudewowWhisperHooked then return end
	eb.claudewowWhisperHooked = true
	local script = eb.GetScript and eb:GetScript("OnEnterPressed")
	eb.claudewowOrigEnter = script -- /aiwhisper send drives the game's own path with it
	if eb.SetScript then
		eb:SetScript("OnEnterPressed", function(self, ...)
			if Whisper.Intercept(self, "script") then return end
			if script then return script(self, ...) end
		end)
	end
	for _, name in ipairs({ "SendText", "SendMessage" }) do
		local orig = eb[name]
		if type(orig) == "function" then
			eb[name] = function(self, ...)
				if Whisper.Intercept(self, name) then return end
				return orig(self, ...)
			end
		end
	end
end

local function WhisperAdopt(chat, frame)
	run.whisperTabs = run.whisperTabs or {}
	frame.claudewowChatId = chat.id
	frame.claudewowTarget = frame.claudewowTarget or ChatAgentName(chat)
	run.whisperTabs[chat.id] = frame
	WhisperHookBox(WhisperBox(frame))
	Whisper.Retitle(chat)
	return frame
end

-- The chat's tab: the one it has, one left in the dock from earlier this
-- session (same name, nothing else claims it), or a new one when asked for.
-- `select` brings a new tab to the front; a reply leaves the current one and
-- flashes instead.
function Whisper.FrameFor(chat, create, select)
	if not WhisperOn() or not chat then return nil end
	run.whisperTabs = run.whisperTabs or {}
	local frame = run.whisperTabs[chat.id]
	if WhisperOwns(chat, frame) then
		Whisper.Retitle(chat)
		return frame
	end
	run.whisperTabs[chat.id] = nil
	local title = Display(chat.name):lower()
	for _, f in ipairs(WhisperFrames()) do
		if f.isTemporary and WhisperAlive(f) then
			local tab = WhisperTab(f)
			local name = tab and tab.GetText and tab:GetText()
			local unclaimed = f.claudewowChatId == nil or not FindChat(f.claudewowChatId)
			if WhisperOwns(chat, f) or (unclaimed and type(name) == "string" and name:lower() == title) then
				return WhisperAdopt(chat, f)
			end
		end
	end
	if not create or type(FCF_OpenTemporaryWindow) ~= "function" then return nil end
	local ok, f = pcall(FCF_OpenTemporaryWindow, "WHISPER", ChatAgentName(chat), DEFAULT_CHAT_FRAME, select and true or false)
	if not ok or type(f) ~= "table" then
		run.whisperError = tostring(f)
		return nil
	end
	f.claudewowTitle = nil
	f.claudewowTarget = ChatAgentName(chat)
	return WhisperAdopt(chat, f)
end

-- Flash the tab as a real whisper does. The game's own function when it has
-- one, else the tab glow by hand; a tab already on screen needs none.
function Whisper.Flash(frame)
	local how
	if frame:IsShown() then
		how = "visible"
	elseif type(FCF_StartAlertFlash) == "function" and pcall(FCF_StartAlertFlash, frame) then
		how = "FCF_StartAlertFlash"
	else
		local tab = WhisperTab(frame)
		local glow = tab and tab.glow
		if glow and type(UIFrameFlash) == "function" and pcall(UIFrameFlash, glow, 1, 1, -1, false, 0, 0, "chat") then
			tab.alerting = true
			how = "UIFrameFlash"
		elseif glow and glow.Show then
			pcall(glow.Show, glow)
			how = "glow"
		else
			how = "none"
		end
	end
	run.whisperFlash = how
	return how
end

function Whisper.System(chat, text, create)
	local frame = Whisper.FrameFor(chat, create)
	if not frame then return false end
	WhisperWrite(frame, Display(text), WhisperColor("SYSTEM", 1, 1, 0))
	return true
end

-- A finished reply as an incoming whisper: "[Claude] whispers: first line", the
-- other lines under it, then the flash. Returns true when the tab has it; the
-- game-chat echo is skipped then, as the game does for a whisper with a window
-- of its own.
function Whisper.Reply(chat, text, agent, role, denied)
	local frame = Whisper.FrameFor(chat, true, false)
	if not frame then return false end
	local who = ReplyAgentName(chat, agent)
	local open = "|Hclaudewow:open:" .. chat.id .. "|h|cff7ec8ff[open]|r|h"
	if role == "system" then
		WhisperWrite(frame, Display(text) .. "  " .. open, WhisperColor("SYSTEM", 1, 1, 0))
	else
		local r, g, b = WhisperColor("WHISPER", 1, 0.5, 1)
		local prefix = WhisperFormat(CHAT_WHISPER_GET, "%s whispers: ", "|Hclaudewow:reply:" .. chat.id .. "|h[" .. who .. "]|h")
		local body = Display(text)
		local first, shown = true, 0
		for line in (body .. "\n"):gmatch("(.-)\n") do
			if line:match("%S") then
				if shown + #line > WHISPER_TEXT_MAX then
					WhisperWrite(frame, "|cff888888... " .. (#body - shown) .. " more characters, click " .. open .. " to read it all|r", r, g, b)
					break
				end
				WhisperWrite(frame, (first and prefix or "") .. line, r, g, b)
				first = false
				shown = shown + #line
			end
		end
		if first then WhisperWrite(frame, prefix, r, g, b) end
	end
	if denied then
		WhisperWrite(frame, who .. " needs permission for " .. Display(table.concat(denied, ", ")) .. ": click " .. open .. " and press Allow", WhisperColor("SYSTEM", 1, 1, 0))
	end
	if run.whisperProgress then run.whisperProgress[chat.id] = nil end
	Whisper.Flash(frame)
	return true
end

-- What you sent, as the game shows your own whispers, then a working line.
function Whisper.Sent(chat, text)
	local frame = Whisper.FrameFor(chat, true, false)
	if not frame then return false end
	local who = ChatAgentName(chat)
	local flat = (Display(text):gsub("%s*\n%s*", " "))
	WhisperWrite(frame, WhisperFormat(CHAT_WHISPER_INFORM_GET, "To %s: ", who) .. flat, WhisperColor("WHISPER_INFORM", 1, 0.5, 1))
	WhisperWrite(frame, who .. " is working on it...", WhisperColor("SYSTEM", 1, 1, 0))
	run.whisperProgress = run.whisperProgress or {}
	run.whisperProgress[chat.id] = nil
	return true
end

-- The bridge's "working" text, once per change, as a system line.
function Whisper.Progress(chat, text)
	text = Trim(tostring(text or ""))
	if text == "" then return end
	run.whisperProgress = run.whisperProgress or {}
	if run.whisperProgress[chat.id] == text then return end
	local frame = Whisper.FrameFor(chat, false)
	if not frame then return end
	run.whisperProgress[chat.id] = text
	local flat = (Display(text):gsub("%s*\n%s*", " "))
	if #flat > 200 then flat = flat:sub(1, 200) .. "..." end
	WhisperWrite(frame, ChatAgentName(chat) .. ": " .. flat, WhisperColor("SYSTEM", 1, 1, 0))
end

function Whisper.Close(chat)
	local frame = run.whisperTabs and run.whisperTabs[chat.id]
	if not frame then return end
	run.whisperTabs[chat.id] = nil
	frame.claudewowChatId = nil
	if run.whisperProgress then run.whisperProgress[chat.id] = nil end
	if type(FCF_Close) == "function" and WhisperAlive(frame) then pcall(FCF_Close, frame) end
end

function Whisper.CloseAll()
	for _, c in ipairs(db.chats) do Whisper.Close(c) end
end

-- The chat behind an agent's name typed as a whisper target: the active chat
-- when it talks to that agent, else the one that last replied, else the first.
local function WhisperAgentChat(target)
	target = tostring(target or ""):lower()
	if target == "" then return nil end
	local best
	for _, c in ipairs(db.chats) do
		if ChatAgentName(c):lower() == target then
			if c.id == db.activeChat then return c end
			if c.id == run.lastReplyChat or not best then best = c end
		end
	end
	return best
end

local TELL_COMMANDS = { w = true, whisper = true, t = true, tell = true }

-- "/w Claude text" typed anywhere: the target and the text, when it is a tell.
local function WhisperParseTell(text)
	local cmd, target, rest = text:match("^%s*/(%a+)%s+(%S+)%s*(.*)$")
	if cmd and TELL_COMMANDS[cmd:lower()] then return target, rest end
end

-- The agent chat a box's Enter belongs to, or nil for the game's own send: a
-- tell to an agent's name, or a box whose whisper is aimed at one (our tab's
-- box by the tab it belongs to, any other by the name).
function Whisper.ChatForBox(eb)
	if not WhisperOn() or type(eb) ~= "table" then return nil end
	local text = eb.GetText and eb:GetText() or ""
	local target, rest = WhisperParseTell(text)
	if target then
		local chat = WhisperAgentChat(target)
		if chat then return chat, rest end
		return nil
	end
	if text:match("^%s*/") then return nil end
	if not eb.GetAttribute or eb:GetAttribute("chatType") ~= "WHISPER" then return nil end
	local frame = eb.chatFrame or (eb.GetParent and eb:GetParent())
	local chat = type(frame) == "table" and frame.claudewowChatId and FindChat(frame.claudewowChatId)
	if chat and run.whisperTabs and run.whisperTabs[chat.id] == frame then return chat, text end
	return WhisperAgentChat(eb:GetAttribute("tellTarget")), text
end

-- Enter on a box whose whisper belongs to an agent: the box is emptied and put
-- away the way a send does it, and the text goes to the addon. Returns true when
-- swallowed, and then the game's own path must not run.
function Whisper.Intercept(eb, layer)
	local chat, text = Whisper.ChatForBox(eb)
	if not chat then return false end
	text = Trim(text or "")
	run.whisperSwallowed = (run.whisperSwallowed or 0) + 1
	run.whisperLayer = layer
	pcall(function()
		if text ~= "" and eb.AddHistoryLine then eb:AddHistoryLine(text) end
		eb:SetText("")
		if type(eb.OnEscapePressed) == "function" then
			eb:OnEscapePressed()
		elseif type(ChatEdit_OnEscapePressed) == "function" then
			ChatEdit_OnEscapePressed(eb)
		elseif type(ChatEdit_DeactivateChat) == "function" then
			ChatEdit_DeactivateChat(eb)
		else
			eb:ClearFocus()
		end
	end)
	if run.whisperProbe then
		-- /aiwhisper send: count the catch instead of bothering the agent.
		run.whisperProbe(chat, text, layer)
		return true
	end
	if text == "" then return true end
	-- The tab swallows everything typed in it, so our own slash commands typed
	-- there would otherwise reach the agent as literal text. Bare /claude in a
	-- whisper tab is the only way to begin a fresh thread from one, so it has to
	-- run as a command. Anything else still goes to the agent.
	local cmd, rest = text:match("^(/[%w%-]+)%s*(.-)$")
	if cmd then
		cmd = cmd:lower()
		if cmd == "/claude" then
			if Trim(rest) == "" then ClaudeWoW.NewChat() else SlashCmdList["CLAUDEWOW"](rest) end
			return true
		elseif cmd == "/claude-wow" or cmd == "/claudewow" then
			SlashCmdList["CLAUDEWOW"](rest)
			return true
		end
	end
	if db.activeChat ~= chat.id then ClaudeWoW.SwitchChat(chat.id) end
	if chat.pendingId then
		Whisper.System(chat, ChatAgentName(chat) .. " is still working on your last message; this one is kept as a draft in the window (/claude-wow cancel gives up on the last one)")
	elseif not ClaudeWoW.IsConnected() then
		Whisper.System(chat, "Not connected to the bridge yet, connecting; the message waits in the window")
	end
	ClaudeWoW.Send(text)
	return true
end

-- The name in "No player named '%s' is currently playing.", or nil.
local function WhisperNotFoundName(msg)
	local fmt = type(ERR_CHAT_PLAYER_NOT_FOUND_S) == "string" and ERR_CHAT_PLAYER_NOT_FOUND_S or "No player named '%s' is currently playing."
	local pattern = fmt:gsub("[%^%$%(%)%%%.%[%]%*%+%-%?]", "%%%0")
	pattern = pattern:gsub("%%%%s", "(.-)")
	return tostring(msg or ""):match("^" .. pattern .. "$")
end

-- A whisper that got out comes back as this system message: make it a loud
-- leak report instead of a line that looks like the game's business.
local function WhisperLeakFilter(_, _, msg, ...)
	if not WhisperOn() then return false end
	local name = WhisperNotFoundName(msg)
	if not name then return false end
	name = name:lower()
	local ours = name == WHISPER_PROBE_NAME:lower()
	for _, c in ipairs(db.chats) do
		if ChatAgentName(c):lower() == name then ours = true end
	end
	for _, n in pairs(AGENT_NAMES) do
		if n:lower() == name then ours = true end
	end
	if not ours then return false end
	run.whisperLeaks = (run.whisperLeaks or 0) + 1
	run.whisperLastLeak = msg
	return false, "|cffff4040[Claude WoW] WHISPER LEAK: " .. tostring(msg) .. " - a send reached the server. Run /aiwhisper status and report it.|r", ...
end

local whisperInstalled = false

function Whisper.HookBoxes()
	for i = 1, (NUM_CHAT_WINDOWS or 10) do WhisperHookBox(_G["ChatFrame" .. i .. "EditBox"]) end
	for _, f in ipairs(WhisperFrames()) do WhisperHookBox(WhisperBox(f)) end
end

-- The hooks, once, the first time the setting is on (at login or when turned
-- on). They stay in place but do nothing while it is off.
function Whisper.Install()
	if whisperInstalled then return end
	whisperInstalled = true
	run.whisperLayers = { "OnEnterPressed", "SendText/SendMessage" }
	if type(ChatEdit_SendText) == "function" then
		local orig = ChatEdit_SendText
		ChatEdit_SendText = function(eb, ...)
			if Whisper.Intercept(eb, "ChatEdit_SendText") then return end
			return orig(eb, ...)
		end
		table.insert(run.whisperLayers, "ChatEdit_SendText")
	end
	if type(ChatFrameUtil) == "table" and type(ChatFrameUtil.SendText) == "function" then
		local orig = ChatFrameUtil.SendText
		ChatFrameUtil.SendText = function(eb, ...)
			if Whisper.Intercept(eb, "ChatFrameUtil.SendText") then return end
			return orig(eb, ...)
		end
		table.insert(run.whisperLayers, "ChatFrameUtil.SendText")
	end
	if type(ChatFrame_AddMessageEventFilter) == "function" then
		pcall(ChatFrame_AddMessageEventFilter, "CHAT_MSG_SYSTEM", WhisperLeakFilter)
		table.insert(run.whisperLayers, "leak filter")
	end
	Whisper.HookBoxes()
end

function Whisper.Status()
	local tabs = 0
	for _, c in ipairs(db.chats) do
		if WhisperOwns(c, run.whisperTabs and run.whisperTabs[c.id]) then tabs = tabs + 1 end
	end
	return "whisper tabs: " .. (WhisperOn() and "on" or "off") .. ", " .. tabs .. " open, sends swallowed: " .. (run.whisperSwallowed or 0)
		.. ", LEAKS: " .. (run.whisperLeaks or 0) .. (run.whisperError and (", last open error: " .. run.whisperError) or "")
end

-- opts.vision asks for a picture of the screen with this one message, whatever
-- the setting ("/claude-wow look <question>").
function ClaudeWoW.Send(text, allow, opts)
	local c = ActiveChat()
	if not c then return end
	text = Trim(text or "")
	if c.pendingId then
		-- Typing while waiting: keep the draft, and check for the reply.
		if text ~= "" then c.draft = text end
		if db.settings.mode == "pixel" and not (run.slotsExhausted or run.slotsMissing) then
			TryLoadSlot("manual")
		else
			SafeReload()
		end
		return
	end
	if text == "" then return end
	if not ClaudeWoW.IsConnected() then
		-- Not connected: the message stays in the box and we try to connect;
		-- CheckConnection sends it the moment the light turns green. If the bridge
		-- never answers, the text is still in the box for a later try.
		if ui.input then ui.input:SetText(text) end
		run.sendOnConnect = { chat = c.id, text = text, allow = allow, opts = opts }
		if not run.connectingAt then ClaudeWoW.Connect() end
		ClaudeWoW.Toggle(true)
		return
	end
	-- Shift-clicked links become [Name] plus their tooltip, which is what the agent can read.
	local links
	text, links = ClaudeWoW.ExpandLinks(text)
	local limit = Codec.MAX_PAYLOAD - 300
	if #text > limit then
		AddHistory(c, "system", "That message is too long for one send (" .. #text .. " chars, max ~" .. limit .. "). Split it up." .. (links > 0 and " Each linked item adds its tooltip to the message." or ""))
		ClaudeWoW.Render()
		return
	end
	-- The game context rides along when the bridge doesn't have this version yet.
	local ctx = ContextToSend(limit - #text)

	db.lastSeq = db.lastSeq + 1
	local id = db.lastSeq
	local tokens = {}
	if c.resetNext then table.insert(tokens, "n") end
	if c.agent and c.agent ~= "" then table.insert(tokens, "agent=" .. c.agent) end
	if c.plugin and c.plugin ~= "" then table.insert(tokens, "plugin=" .. c.plugin) end
	if db.settings.vision or (opts and opts.vision) then table.insert(tokens, "v") end
	local allowHex
	if type(allow) == "table" and #allow > 0 then
		table.insert(tokens, "allow=" .. table.concat(allow, ","))
		allowHex = ToHex(table.concat(allow, US))
	end
	local flags = table.concat(tokens, ";")
	local newSession = c.resetNext and true or nil
	c.resetNext = nil
	db.outbox = {
		id = id,
		session = db.session,
		chat = c.id,
		text = ToHex(text),
		cwd = ToHex(c.cwd),
		ctx = ctx and ToHex(ctx) or nil,
		agent = (c.agent and c.agent ~= "") and c.agent or nil,
		plugin = (c.plugin and c.plugin ~= "") and c.plugin or nil,
		allow = allowHex,
		newSession = newSession,
		-- The bridge wants screenshots and this client cannot take one: the
		-- reload fallback tells it so, and it switches to the pixel capture.
		shot = NoScreenshot() and "missing" or nil,
		t = time(),
	}
	c.pendingId = id
	c.draft = nil
	c.progress = nil
	AddHistory(c, "user", text, id)
	-- A chat still carrying its default name takes its title from the first message
	-- you send (system notes like "/claude-wow cd" before it don't count).
	if c.name:match("^Chat %d+$") then
		local first = true
		for _, m in ipairs(c.history) do
			if m.role == "user" and m.id ~= id then first = false break end
		end
		if first then c.name = AutoTitle(text) or c.name end
	end
	db.settings.shown = true
	Whisper.Sent(c, text)

	if db.settings.mode == "pixel" then
		run.outbound[id] = { chat = c.id, cwd = c.cwd, flags = flags, name = c.name, text = text, ctx = ctx, sentAt = GetTime() }
		NoteStaleSignals(id)
		run.sentAt = GetTime()
		run.polls = 0
		StartActivity(c, id)
		ScheduleNextPoll()
		RefreshStrip()
		ClaudeWoW.Render()
	else
		SafeReload()
	end
end

-- Forget: a record with no text telling the bridge a chat was deleted, so it drops
-- the transcript (which a later restore would otherwise bring back) and the
-- agent session. db.forget keeps the id until the bridge acks, so a delete made
-- while the bridge was away is sent again with the next hello.
local function SendCancel(chat, id)
	if db.settings.mode ~= "pixel" or not id then return end
	db.lastSeq = db.lastSeq + 1
	run.outbound[db.lastSeq] = { chat = chat.id, cwd = chat.cwd or "", flags = "cancel=" .. id, name = chat.name or "", text = "", sentAt = GetTime(), cancelOf = id }
	NoteStaleSignals(db.lastSeq)
	RefreshStrip()
end

local function SendForget(chatId)
	if db.settings.mode ~= "pixel" then return end
	for _, rec in pairs(run.outbound) do
		if rec.forget == chatId and not rec.acked then return end
	end
	local info = db.forget[chatId] or {}
	db.lastSeq = db.lastSeq + 1
	run.outbound[db.lastSeq] = { chat = chatId, cwd = info.cwd or "", flags = "d", name = info.name or "", text = "", sentAt = GetTime(), forget = chatId }
	NoteStaleSignals(db.lastSeq)
	RefreshStrip()
end

local function ForgetOnBridge(c)
	if not c or not c.id then return end
	db.forget[c.id] = { name = c.name, cwd = c.cwd }
	SendForget(c.id)
end

-- Hello: a record with no text that just announces our session token. The bridge
-- acks it, offers a restore if our saved data is fresh, and refreshes the slots,
-- so the status light and any lost chats come back before the first message.
-- The game context always rides on it (empty when turned off), so the bridge's
-- copy is brought in line at every login and Connect.
function ClaudeWoW.SayHello()
	if db.settings.mode ~= "pixel" then return end
	local now = GetTime()
	if run.lastHelloAt and now - run.lastHelloAt < 60 then return end
	run.lastHelloAt = now
	db.lastSeq = db.lastSeq + 1
	local c = ActiveChat()
	local ctx = db.settings.context and ClaudeWoW.GameContext() or ""
	run.outbound[db.lastSeq] = { chat = c and c.id or "", cwd = c and c.cwd or "", flags = "h", name = c and c.name or "", text = "", ctx = ctx, sentAt = now, hello = true }
	NoteStaleSignals(db.lastSeq)
	run.helloPollAt = now + 5
	-- Deletions the bridge never confirmed ride along with the hello.
	for id in pairs(db.forget) do SendForget(id) end
	-- Fresh saved data: show "restoring" instead of an empty panel until we hear back.
	if not db.restored then
		local empty = true
		for _, ch in ipairs(db.chats) do
			if #ch.history > 0 then empty = false end
		end
		if empty then run.restoring = now end
	end
	RefreshStrip()
	ClaudeWoW.Render()
end

-- Put the active chat's pending message back on the strip.
function ClaudeWoW.Resend()
	local c = ActiveChat()
	if not c or not c.pendingId then return end
	local text
	for i = #c.history, 1, -1 do
		if c.history[i].id == c.pendingId and c.history[i].role == "user" then
			text = c.history[i].text
			break
		end
	end
	if not text then return end
	local tokens = {}
	if c.agent and c.agent ~= "" then table.insert(tokens, "agent=" .. c.agent) end
	if c.plugin and c.plugin ~= "" then table.insert(tokens, "plugin=" .. c.plugin) end
	if db.settings.vision then table.insert(tokens, "v") end -- a resend is a fresh screenshot
	run.outbound[c.pendingId] = { chat = c.id, cwd = c.cwd, flags = table.concat(tokens, ";"), name = c.name, text = text, sentAt = GetTime() }
	NoteStaleSignals(c.pendingId)
	run.sentAt = GetTime()
	run.polls = 0
	ScheduleNextPoll()
	RefreshStrip()
	ClaudeWoW.UpdateStatus()
end

function ClaudeWoW.SendFromInput()
	if not ui.input then return end
	local text = ui.input:GetText()
	ui.input:SetText("")
	ui.input:ClearFocus() -- hand the keyboard back to the game after sending
	ClaudeWoW.Send(text)
end

-- The Allow button: grant the rules a reply asked for, then tell the agent to carry on.
function ClaudeWoW.Allow(chatId, rules)
	local c = FindChat(chatId)
	if not c or c.pendingId or not rules or #rules == 0 then return end
	if db.activeChat ~= c.id then ClaudeWoW.SwitchChat(c.id) end
	for _, m in ipairs(c.history) do m.denied = nil end
	AddHistory(c, "system", "Allowed: " .. table.concat(rules, ", "))
	ClaudeWoW.Send("Those actions are allowed now. Continue from where you left off.", rules)
end

---------------------------------------------------------------------------
-- Chats
---------------------------------------------------------------------------

function ClaudeWoW.SwitchChat(id)
	local c = FindChat(id)
	if not c then return end
	local prev = ActiveChat()
	if prev and prev ~= c and ui.input then
		local typed = Trim(ui.input:GetText() or "")
		prev.draft = typed ~= "" and typed or nil
	end
	db.activeChat = c.id
	c.unread = 0
	if ui.input then
		ui.input:SetText(c.draft or "")
		c.draft = nil
	end
	ClaudeWoW.Render()
	ClaudeWoW.RenderChatList()
end

function ClaudeWoW.NewChat(name)
	local c = AddChat(name and name ~= "" and name or nil)
	if not c then
		local a = ActiveChat()
		AddHistory(a, "system", "Chat limit reached (" .. MAX_CHATS .. "). Delete one first with /claude-wow delete.")
		ClaudeWoW.Render()
		return
	end
	ClaudeWoW.SwitchChat(c.id)
	ClaudeWoW.Toggle(true)
end

-- Folder this chat's agent works in. Empty (or "-" / "default") = the bridge's
-- default. Relative paths are resolved by the bridge against that default.
function ClaudeWoW.SetFolder(rest, c)
	c = c or ActiveChat()
	if not c then return end
	rest = Trim(rest or "")
	if rest == "-" or rest == "default" then rest = "" end
	local base = run.bridgeCwd or "the bridge's default folder"
	if rest ~= "" then
		local changed = rest ~= c.cwd
		c.cwd = rest
		local absolute = rest:match("^%a:[\\/]") or rest:match("^[\\/~]")
		local note = absolute and "" or (" (relative to " .. base .. ")")
		AddHistory(c, "system", "cwd set to " .. rest .. note .. (changed and #c.history > 1 and ("; the next message starts a fresh " .. ChatAgentName(c) .. " session there") or ""))
	elseif c.cwd ~= "" then
		c.cwd = ""
		AddHistory(c, "system", "cwd reset to the bridge's default: " .. base)
	else
		AddHistory(c, "system", "cwd is the bridge's default: " .. base .. " (/claude-wow cd <folder>, or right-click the chat and pick Folder, to change)")
	end
	ClaudeWoW.Render()
end

StaticPopupDialogs["CLAUDEWOW_FOLDER"] = {
	text = "Folder for this chat\n\nRelative to the bridge's folder (%s), ~, or a full path.\nEmpty = the bridge's default. Changing it starts a fresh agent session.",
	button1 = OKAY,
	button2 = CANCEL,
	hasEditBox = 1,
	editBoxWidth = 320,
	maxLetters = 250,
	timeout = 0,
	whileDead = true,
	hideOnEscape = true,
	OnShow = function(dialog, data)
		local box = dialog.GetEditBox and dialog:GetEditBox() or dialog.editBox
		if box then
			box:SetText(data and data.cwd or "")
			box:HighlightText()
			box:SetFocus()
		end
	end,
	OnAccept = function(dialog, data)
		local box = dialog.GetEditBox and dialog:GetEditBox() or dialog.editBox
		local chat = data and FindChat(data.id)
		if chat and box then ClaudeWoW.SetFolder(box:GetText(), chat) end
	end,
	EditBoxOnEnterPressed = function(box)
		local dialog = box:GetParent()
		StaticPopupDialogs["CLAUDEWOW_FOLDER"].OnAccept(dialog, dialog.data)
		dialog:Hide()
	end,
	EditBoxOnEscapePressed = function(box)
		box:GetParent():Hide()
	end,
}

-- Folder dialog for a chat (the active one when no id is given).
function ClaudeWoW.FolderPrompt(id)
	local c = (id and FindChat(id)) or ActiveChat()
	if not c then return end
	StaticPopup_Show("CLAUDEWOW_FOLDER", run.bridgeCwd or "unknown until connected", nil, { id = c.id, cwd = c.cwd })
end

-- The agent this chat talks to, by id. Empty (or
-- "-" / "default") = the bridge's default. The bridge starts a fresh session
-- when a chat changes agent, since a session belongs to the agent that made it.
local function AgentList()
	return run.bridgeAgents and table.concat(run.bridgeAgents, ", ") or "claude, codex, grok, agy, hermes"
end

function ClaudeWoW.SetAgent(rest, c)
	c = c or ActiveChat()
	if not c then return end
	rest = Trim(rest or ""):lower()
	if rest == "-" or rest == "default" then rest = "" end
	if rest ~= "" and run.bridgeAgents and not Contains(run.bridgeAgents, rest) then
		AddHistory(c, "system", "Unknown agent \"" .. rest .. "\". The bridge knows: " .. AgentList())
		ClaudeWoW.Render()
		return
	end
	local changed = rest ~= (c.agent or "")
	c.agent = rest
	if rest ~= "" then
		AddHistory(c, "system", "agent set to " .. AgentName(rest) .. (changed and #c.history > 1 and "; the next message starts a fresh session with it" or ""))
	elseif changed then
		AddHistory(c, "system", "agent reset to the bridge's default: " .. (run.bridgeAgent and AgentName(run.bridgeAgent) or "unknown until connected"))
	else
		AddHistory(c, "system", "agent is the bridge's default: " .. (run.bridgeAgent and AgentName(run.bridgeAgent) or "unknown until connected") .. " (/claude-wow agent <name>, or right-click the chat and pick Agent, to change; agents: " .. AgentList() .. ")")
	end
	ClaudeWoW.Render()
end

StaticPopupDialogs["CLAUDEWOW_AGENT"] = {
	text = "Agent for this chat\n\nOne of: %s.\nEmpty = the bridge's default (%s). Changing it starts a fresh session.",
	button1 = OKAY,
	button2 = CANCEL,
	hasEditBox = 1,
	editBoxWidth = 200,
	maxLetters = 32,
	timeout = 0,
	whileDead = true,
	hideOnEscape = true,
	OnShow = function(dialog, data)
		local box = dialog.GetEditBox and dialog:GetEditBox() or dialog.editBox
		if box then
			box:SetText(data and data.agent or "")
			box:HighlightText()
			box:SetFocus()
		end
	end,
	OnAccept = function(dialog, data)
		local box = dialog.GetEditBox and dialog:GetEditBox() or dialog.editBox
		local chat = data and FindChat(data.id)
		if chat and box then ClaudeWoW.SetAgent(box:GetText(), chat) end
	end,
	EditBoxOnEnterPressed = function(box)
		local dialog = box:GetParent()
		StaticPopupDialogs["CLAUDEWOW_AGENT"].OnAccept(dialog, dialog.data)
		dialog:Hide()
	end,
	EditBoxOnEscapePressed = function(box)
		box:GetParent():Hide()
	end,
}

-- Agent dialog for a chat (the active one when no id is given).
function ClaudeWoW.AgentPrompt(id)
	local c = (id and FindChat(id)) or ActiveChat()
	if not c then return end
	StaticPopup_Show("CLAUDEWOW_AGENT", AgentList(), run.bridgeAgent and AgentName(run.bridgeAgent) or "unknown until connected", { id = c.id, agent = c.agent or "" })
end

-- The plugin this chat is bound to, by id ("ask": general in-game chat,
-- "claude-code": an agent session in a folder; docs/PLATFORM.md). Empty (or
-- "-" / "default") = the bridge's default. The bridge starts a fresh session
-- when a chat changes plugin, since a session belongs to the plugin that made it.
local function PluginList()
	return run.bridgePlugins and table.concat(run.bridgePlugins, ", ") or "ask, claude-code"
end

local function BridgePluginName()
	return run.bridgePlugin or "unknown until connected"
end

function ClaudeWoW.SetPlugin(rest, c)
	c = c or ActiveChat()
	if not c then return end
	rest = Trim(rest or ""):lower()
	if rest == "-" or rest == "default" then rest = "" end
	if rest ~= "" and run.bridgePlugins and not Contains(run.bridgePlugins, rest) then
		AddHistory(c, "system", "Unknown plugin \"" .. rest .. "\". The bridge has: " .. PluginList())
		ClaudeWoW.Render()
		return
	end
	local changed = rest ~= (c.plugin or "")
	c.plugin = rest
	if rest ~= "" then
		AddHistory(c, "system", "plugin set to " .. rest .. (changed and #c.history > 1 and "; the next message starts a fresh session with it" or ""))
	elseif changed then
		AddHistory(c, "system", "plugin reset to the bridge's default: " .. BridgePluginName())
	else
		AddHistory(c, "system", "plugin is the bridge's default: " .. BridgePluginName() .. " (/claude-wow plugin <name>, or right-click the chat and pick Plugin, to change; plugins: " .. PluginList() .. ")")
	end
	ClaudeWoW.Render()
end

StaticPopupDialogs["CLAUDEWOW_PLUGIN"] = {
	text = "Plugin for this chat\n\nOne of: %s.\nEmpty = the bridge's default (%s). Changing it starts a fresh session.",
	button1 = OKAY,
	button2 = CANCEL,
	hasEditBox = 1,
	editBoxWidth = 200,
	maxLetters = 32,
	timeout = 0,
	whileDead = true,
	hideOnEscape = true,
	OnShow = function(dialog, data)
		local box = dialog.GetEditBox and dialog:GetEditBox() or dialog.editBox
		if box then
			box:SetText(data and data.plugin or "")
			box:HighlightText()
			box:SetFocus()
		end
	end,
	OnAccept = function(dialog, data)
		local box = dialog.GetEditBox and dialog:GetEditBox() or dialog.editBox
		local chat = data and FindChat(data.id)
		if chat and box then ClaudeWoW.SetPlugin(box:GetText(), chat) end
	end,
	EditBoxOnEnterPressed = function(box)
		local dialog = box:GetParent()
		StaticPopupDialogs["CLAUDEWOW_PLUGIN"].OnAccept(dialog, dialog.data)
		dialog:Hide()
	end,
	EditBoxOnEscapePressed = function(box)
		box:GetParent():Hide()
	end,
}

-- Plugin dialog for a chat (the active one when no id is given).
function ClaudeWoW.PluginPrompt(id)
	local c = (id and FindChat(id)) or ActiveChat()
	if not c then return end
	StaticPopup_Show("CLAUDEWOW_PLUGIN", PluginList(), BridgePluginName(), { id = c.id, plugin = c.plugin or "" })
end

StaticPopupDialogs["CLAUDEWOW_RENAME"] = {
	text = "Rename this chat",
	button1 = OKAY,
	button2 = CANCEL,
	hasEditBox = 1,
	maxLetters = 24,
	timeout = 0,
	whileDead = true,
	hideOnEscape = true,
	OnShow = function(dialog, data)
		local box = dialog.GetEditBox and dialog:GetEditBox() or dialog.editBox
		if box then
			box:SetText(data and data.name or "")
			box:HighlightText()
			box:SetFocus()
		end
	end,
	OnAccept = function(dialog, data)
		local box = dialog.GetEditBox and dialog:GetEditBox() or dialog.editBox
		local chat = data and FindChat(data.id)
		local name = box and Trim(box:GetText() or "") or ""
		if chat and name ~= "" then
			chat.name = name:sub(1, 24)
			Whisper.Retitle(chat)
			ClaudeWoW.Render()
		end
	end,
	EditBoxOnEnterPressed = function(box)
		local dialog = box:GetParent()
		StaticPopupDialogs["CLAUDEWOW_RENAME"].OnAccept(dialog, dialog.data)
		dialog:Hide()
	end,
	EditBoxOnEscapePressed = function(box)
		box:GetParent():Hide()
	end,
}

-- Rename dialog for a chat (the active one when no id is given).
function ClaudeWoW.RenamePrompt(id)
	local c = (id and FindChat(id)) or ActiveChat()
	if not c then return end
	StaticPopup_Show("CLAUDEWOW_RENAME", nil, nil, { id = c.id, name = c.name })
end
ClaudeWoW.RenameActive = ClaudeWoW.RenamePrompt

-- Delete a chat (the active one when no id is given). The last chat is cleared
-- and renamed instead of removed, so there is always one to type into. Either
-- way the bridge is told to forget it, so a restore won't bring it back.
function ClaudeWoW.DeleteChat(id)
	local c, idx = nil, nil
	if id then c, idx = FindChat(id) end
	if not c then c, idx = ActiveChat() end
	if not c then return end
	ForgetOnBridge(c)
	Whisper.Close(c)
	if #db.chats == 1 then
		wipe(c.history)
		c.pendingId, c.progress, c.unread, c.draft = nil, nil, 0, nil
		c.name = "Chat 1"
		ClaudeWoW.Render()
		ClaudeWoW.RenderChatList()
		return
	end
	table.remove(db.chats, idx)
	if db.activeChat == c.id then
		ClaudeWoW.SwitchChat(db.chats[math.min(idx, #db.chats)].id)
	else
		ClaudeWoW.RenderChatList()
	end
end

-- The trash can on a chat row asks first; /claude-wow delete does not.
StaticPopupDialogs["CLAUDEWOW_DELETE"] = {
	text = "Delete chat \"%s\"?\n\nIts transcript goes away (the last chat is cleared instead of removed).",
	button1 = OKAY,
	button2 = CANCEL,
	timeout = 0,
	whileDead = true,
	hideOnEscape = true,
	OnAccept = function(dialog, data)
		if data then ClaudeWoW.DeleteChat(data.id) end
	end,
}

function ClaudeWoW.ConfirmDelete(id)
	local c = (id and FindChat(id)) or ActiveChat()
	if not c then return end
	StaticPopup_Show("CLAUDEWOW_DELETE", Display(c.name), nil, { id = c.id })
end

---------------------------------------------------------------------------
-- Macros
---------------------------------------------------------------------------

-- The agent can hand over ready-made macros (a ```wowmacro block the bridge turns
-- into `macros` on the reply). Each gets a button under its message that creates
-- the macro, or updates the one with that name, and puts it on the cursor to drop
-- on an action bar. The addon never runs a macro; the player's own click does.

local MACRO_ACCOUNT_MAX = (Constants and Constants.MacroConsts and Constants.MacroConsts.MAX_ACCOUNT_MACROS) or 120
local MACRO_CHAR_MAX = (Constants and Constants.MacroConsts and Constants.MacroConsts.MAX_CHARACTER_MACROS) or 30
local MACRO_DEFAULT_ICON = 134400 -- question mark: with #showtooltip the game shows the spell's icon

local function MacroSay(msg)
	print("|cff66ccff[Claude WoW]|r " .. msg)
end

-- Only well-formed entries survive (the slot file is trusted, but not blindly).
function ClaudeWoW.CleanMacros(list)
	if type(list) ~= "table" then return nil end
	local out = {}
	for _, m in ipairs(list) do
		if type(m) == "table" and type(m.name) == "string" and m.name ~= "" and type(m.body) == "string" and m.body ~= "" then
			out[#out + 1] = {
				name = m.name, body = m.body, char = m.char == true, risky = m.risky == true,
				icon = (type(m.icon) == "number" or type(m.icon) == "string") and m.icon or nil,
			}
		end
	end
	return #out > 0 and out or nil
end

-- The macro called `name` among account (1..120) or character (121..150) macros:
-- the same name may exist in both, and only the requested kind counts.
local function FindMacro(name, perCharacter)
	local first = perCharacter and MACRO_ACCOUNT_MAX + 1 or 1
	local last = perCharacter and MACRO_ACCOUNT_MAX + MACRO_CHAR_MAX or MACRO_ACCOUNT_MAX
	for i = first, last do
		local n, icon, body = Try(GetMacroInfo, i)
		if n == name then return i, icon, body end
	end
end

local function MacroIcon(icon)
	if type(icon) == "number" then return icon end
	if type(icon) == "string" then
		local id = Try(GetFileIDFromPath, "Interface\\Icons\\" .. icon)
		if type(id) == "number" and id > 0 then return id end
		return icon -- CreateMacro also takes a texture name
	end
	return MACRO_DEFAULT_ICON
end

function ClaudeWoW.MacroLabel(m)
	local verb = FindMacro(m.name, m.char) and "Update" or "Create"
	return verb .. " macro: " .. Display(m.name) .. (m.char and " (character)" or "") .. (m.risky and "  |cffff6060(runs code)|r" or "")
end

StaticPopupDialogs["CLAUDEWOW_MACRO"] = {
	text = "%s",
	button1 = OKAY,
	button2 = CANCEL,
	timeout = 0,
	whileDead = true,
	hideOnEscape = true,
	OnAccept = function(dialog, data)
		if data then ClaudeWoW.InstallMacro(data, true) end
	end,
}

-- Create or update macro `m` ({ name, body, icon, char, risky }). Asks first when it
-- would replace a different macro of yours, or when it runs code (/run, /click...).
function ClaudeWoW.InstallMacro(m, confirmed)
	if type(m) ~= "table" then return end
	if InCombatLockdown() then
		MacroSay("macros can't be changed in combat; click the button again afterwards.")
		return
	end
	local index, _, oldBody = FindMacro(m.name, m.char)
	if not confirmed then
		local why = {}
		if m.risky then table.insert(why, "This macro runs code or clicks buttons (/run, /script, /click). Only keep it if you trust what it does.") end
		if index and oldBody ~= m.body then table.insert(why, "It replaces your existing macro \"" .. m.name .. "\" (/claude-wow macro undo brings the old one back).") end
		if #why > 0 then
			StaticPopup_Show("CLAUDEWOW_MACRO", table.concat(why, "\n\n") .. "\n\n" .. Display(m.body), nil, m)
			return
		end
	end
	-- Blizzard's macro window saves its edit box into its selected macro when it
	-- hides; close it first so that can't land on a macro we just moved.
	if MacroFrame and MacroFrame:IsShown() then
		Try(HideUIPanel, MacroFrame)
		index, _, oldBody = FindMacro(m.name, m.char)
	end
	local ok, newIndex
	if index then
		local _, oldIcon = FindMacro(m.name, m.char)
		ok, newIndex = pcall(EditMacro, index, m.name, m.icon ~= nil and MacroIcon(m.icon) or nil, m.body)
		if ok and type(newIndex) == "number" then
			db.macroUndo = { name = m.name, char = m.char, icon = oldIcon, body = oldBody }
		end
	else
		local acc, chr = Try(GetNumMacros)
		if m.char and type(chr) == "number" and chr >= MACRO_CHAR_MAX then
			MacroSay("your character macros are full (" .. MACRO_CHAR_MAX .. "); delete one in /macro first.")
			return
		elseif not m.char and type(acc) == "number" and acc >= MACRO_ACCOUNT_MAX then
			MacroSay("your account macros are full (" .. MACRO_ACCOUNT_MAX .. "); delete one in /macro first.")
			return
		end
		ok, newIndex = pcall(CreateMacro, m.name, MacroIcon(m.icon), m.body, m.char)
		if (not ok or type(newIndex) ~= "number") and m.icon ~= nil then
			ok, newIndex = pcall(CreateMacro, m.name, MACRO_DEFAULT_ICON, m.body, m.char)
		end
		if ok and type(newIndex) == "number" then
			db.macroUndo = { name = m.name, char = m.char, created = true }
		end
	end
	if not ok or type(newIndex) ~= "number" then
		MacroSay("could not save macro \"" .. m.name .. "\": " .. (ok and "the game refused it (is the list full?)" or tostring(newIndex)))
		return
	end
	-- EditMacro may move the macro (names are sorted): pick up the index it returned.
	Try(PickupMacro, newIndex)
	MacroSay("macro \"" .. m.name .. "\" " .. (index and "updated" or "created") .. " and on your cursor: click an action bar slot to place it (it is also in /macro).")
	ClaudeWoW.Render()
end

function ClaudeWoW.UndoMacro()
	local u = db.macroUndo
	if not u then MacroSay("nothing to undo."); return end
	if InCombatLockdown() then MacroSay("macros can't be changed in combat."); return end
	local index = FindMacro(u.name, u.char)
	if not index then MacroSay("macro \"" .. u.name .. "\" is gone already."); db.macroUndo = nil; return end
	if MacroFrame and MacroFrame:IsShown() then Try(HideUIPanel, MacroFrame); index = FindMacro(u.name, u.char) end
	if u.created then
		Try(DeleteMacro, index)
		MacroSay("removed macro \"" .. u.name .. "\".")
	else
		Try(EditMacro, index, u.name, u.icon, u.body)
		MacroSay("macro \"" .. u.name .. "\" is back to what it was.")
	end
	db.macroUndo = nil
	ClaudeWoW.Render()
end

---------------------------------------------------------------------------
-- Rendering
---------------------------------------------------------------------------

function ClaudeWoW.UpdateStatus()
	if not ui.status then return end
	local c = ActiveChat()
	local mode = db.settings.mode
	local s
	if c and c.pendingId then
		local id = c.pendingId
		local elapsed = run.sentAt and (GetTime() - run.sentAt) or 0
		local rec = run.outbound[id]
		if mode == "pixel" then
			if run.slotsMissing then
				s = "Reply slots not installed (run install-slots.js, restart WoW). Using reload instead: Enter or Refresh"
			elseif run.slotsExhausted then
				s = "Slot pool used up this session - next keypress reloads to free it"
			elseif run.pixelFailed then
				s = "Bridge didn't see #" .. id .. " after " .. STRIP_TRIES .. " tries - next keypress switches to the reload path (or /claude-wow reload)"
			elseif c.progress or (run.act and run.act[c.id] and run.act[c.id].count > 0) then
				s = ChatAgentName(c) .. " is working on #" .. id .. " - " .. ActivityLine(c)
			elseif rec and not rec.acked then
				s = "Sending #" .. id .. (rec.tries and rec.tries > 1 and (" (try " .. rec.tries .. "/" .. STRIP_TRIES .. ")") or "") .. "..."
				local state = ClaudeWoW.BridgeState()
				if state == "down" then s = s .. " - bridge not seen lately, is the bridge running?" end
			else
				s = "Waiting for #" .. id .. " (checked " .. (run.polls or 0) .. "x)"
				if elapsed > 45 then
					s = s .. " - no sign of the bridge. Is the bridge running? /claude-wow resend"
				end
			end
		else
			s = "Waiting for reply #" .. id .. ". Enter or Refresh checks now"
			if db.settings.autoRefresh then
				s = s .. "; auto on next keypress after " .. db.settings.interval .. "s"
			end
		end
	elseif not ClaudeWoW.IsConnected() then
		if run.connectingAt and run.sendOnConnect then
			s = "Connecting to the bridge... your message goes out as soon as it answers"
		elseif run.connectingAt then
			s = "Connecting to the bridge..."
		elseif run.connectFailed then
			s = "No answer from the bridge. Is it running (npm start)? Connect tries again"
		elseif ClaudeWoW.BridgeState() == "stale" then
			s = "Bridge not seen for a while - click Reconnect"
		else
			s = "Not connected - start the bridge, then click Connect"
		end
	elseif c and c.draft and c.draft ~= "" then
		s = "Reply arrived. Your draft is back in the box - Enter to send it"
	elseif run.restoring then
		s = "Connecting to the bridge..."
	else
		s = "Ready"
	end
	ui.status:SetText(s)
	run.statusText = s
	ClaudeWoW.UpdateDot()
	ClaudeWoW.UpdateConnect()
	if ui.title then
		local t = c and Display(c.name) or "Claude WoW"
		local folder = FolderName(ChatFolder(c))
		if folder ~= "" then t = t .. "  |cff888888" .. Display(folder) .. "|r" end
		if c and c.agent and c.agent ~= "" then t = t .. "  |cff888888" .. AgentName(c.agent) .. "|r" end
		ui.title:SetText(t)
	end
	local cwdText
	if c and c.cwd ~= "" then
		cwdText = Display(c.cwd)
	elseif run.bridgeCwd then
		cwdText = Display(run.bridgeCwd) .. " (bridge default)"
	else
		cwdText = "(bridge default - start the bridge in a folder, or right-click the chat and pick Folder)"
	end
	local agentText
	if c and c.agent and c.agent ~= "" then
		agentText = AgentName(c.agent)
	elseif run.bridgeAgent then
		agentText = AgentName(run.bridgeAgent) .. " (bridge default)"
	else
		agentText = "(bridge default)"
	end
	local pluginText
	if c and c.plugin and c.plugin ~= "" then
		pluginText = c.plugin
	elseif run.bridgePlugin then
		pluginText = run.bridgePlugin .. " (bridge default)"
	else
		pluginText = "(bridge default)"
	end
	local growth = ContextSegment(c)
	ui.cwd:SetText("cwd: " .. cwdText .. "   agent: " .. agentText .. "   mode: " .. mode .. (ScreenshotMode() and " (screenshot)" or "") .. "   vision: " .. (db.settings.vision and "on" or "off") .. "   plugin: " .. pluginText .. (growth ~= "" and ("   " .. growth) or ""))
	if ui.resend then ui.resend:SetShown(c and c.pendingId ~= nil and mode == "pixel") end
	if ui.refresh then ui.refresh:SetShown(mode ~= "pixel" or run.slotsExhausted or run.slotsMissing or run.pixelFailed or false) end
	ClaudeWoW.UpdateMini()
end

-- One message bubble: accent bar, colored label, timestamp, wrapped body.
local function GetBubble(i)
	local b = ui.bubbles[i]
	if b then return b end
	b = CreateFrame("Frame", nil, ui.content)
	b.bg = b:CreateTexture(nil, "BACKGROUND")
	b.bg:SetAllPoints()
	b.accent = b:CreateTexture(nil, "BORDER")
	b.accent:SetPoint("TOPLEFT", b, "TOPLEFT", 0, 0)
	b.accent:SetPoint("BOTTOMLEFT", b, "BOTTOMLEFT", 0, 0)
	b.accent:SetWidth(3)
	b.who = b:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
	b.who:SetPoint("TOPLEFT", b, "TOPLEFT", 10, -6)
	b.who:SetJustifyH("LEFT")
	b.when = b:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
	b.when:SetPoint("TOPRIGHT", b, "TOPRIGHT", -8, -6)
	b.body = b:CreateFontString(nil, "OVERLAY", "ChatFontNormal")
	b.body:SetPoint("TOPLEFT", b.who, "BOTTOMLEFT", 0, -4)
	b.body:SetJustifyH("LEFT")
	b.body:SetJustifyV("TOP")
	b.body:SetWordWrap(true)
	b.body:SetNonSpaceWrap(true)
	b.allow = CreateFrame("Button", nil, b, "UIPanelButtonTemplate")
	b.allow:SetHeight(22)
	b.allow:SetPoint("TOPLEFT", b.body, "BOTTOMLEFT", 0, -6)
	b.allow:SetScript("OnClick", function(self)
		ClaudeWoW.Allow(self.chatId, self.rules)
	end)
	b.allow:Hide()
	-- The New chat button on a context warning: exactly what bare /claude does.
	b.fresh = CreateFrame("Button", nil, b, "UIPanelButtonTemplate")
	b.fresh:SetHeight(22)
	b.fresh:SetText("New chat")
	b.fresh:SetScript("OnClick", function() ClaudeWoW.NewChat() end)
	b.fresh:Hide()
	b.macroBtns = {}
	-- FontStrings can't be selected, so a click opens the message in the copy box.
	b:EnableMouse(true)
	b:SetScript("OnMouseUp", function(self, button)
		if button == "LeftButton" and self.text and self.text ~= "" then ClaudeWoW.ShowCopy(self.text) end
	end)
	ui.bubbles[i] = b
	return b
end

function ClaudeWoW.Render()
	local c = ActiveChat()
	if ui.content and c then
		local width = ui.scroll:GetWidth()
		if not width or width < 80 then width = 400 end
		ui.content:SetWidth(width)
		local y, n = 0, 0
		local function Place(role, text, when, dim, denied, agent, macros, newChat)
			n = n + 1
			local b = GetBubble(n)
			local st = ROLE_STYLE[role] or ROLE_STYLE.system
			b:SetWidth(width)
			b.bg:SetColorTexture(st.bg[1], st.bg[2], st.bg[3], st.bg[4])
			b.accent:SetColorTexture(st.color[1], st.color[2], st.color[3], 0.9)
			b.who:SetText(st == ROLE_STYLE.assistant and ReplyAgentName(c, agent) or st.label)
			b.who:SetTextColor(st.color[1], st.color[2], st.color[3])
			b.when:SetText(when or "")
			b.body:SetWidth(width - 18)
			b.body:SetText(Display(text))
			if dim then
				b.body:SetTextColor(0.72, 0.72, 0.72)
			else
				b.body:SetTextColor(0.93, 0.93, 0.93)
			end
			local h = b.body:GetStringHeight()
			if not h or h < 1 then h = 14 end
			local extra = 0
			if denied then
				local label = "Allow " .. table.concat(denied, ", ") .. " & retry"
				b.allow:SetText(label)
				b.allow:SetWidth(math.min(width - 24, math.max(160, b.allow:GetFontString():GetStringWidth() + 30)))
				b.allow.chatId = c.id
				b.allow.rules = denied
				b.allow:Show()
				extra = 28
			else
				b.allow:Hide()
			end
			if newChat then
				b.fresh:SetWidth(math.min(width - 24, math.max(120, b.fresh:GetFontString():GetStringWidth() + 30)))
				b.fresh:ClearAllPoints()
				b.fresh:SetPoint("TOPLEFT", b.body, "BOTTOMLEFT", 0, -6 - extra)
				b.fresh:Show()
				extra = extra + 28
			else
				b.fresh:Hide()
			end
			-- One button per macro the agent handed over.
			local shownMacros = 0
			for k, m in ipairs(macros or {}) do
				local mb = b.macroBtns[k]
				if not mb then
					mb = CreateFrame("Button", nil, b, "UIPanelButtonTemplate")
					mb:SetHeight(22)
					mb:SetScript("OnClick", function(self) ClaudeWoW.InstallMacro(self.macro) end)
					mb:SetScript("OnEnter", function(self)
						GameTooltip:SetOwner(self, "ANCHOR_RIGHT")
						GameTooltip:AddLine(Display(self.macro.name))
						GameTooltip:AddLine(Display(self.macro.body), 1, 1, 1, true)
						GameTooltip:Show()
					end)
					mb:SetScript("OnLeave", function() GameTooltip:Hide() end)
					b.macroBtns[k] = mb
				end
				mb.macro = m
				mb:SetText(ClaudeWoW.MacroLabel(m))
				mb:SetWidth(math.min(width - 24, math.max(160, mb:GetFontString():GetStringWidth() + 30)))
				mb:ClearAllPoints()
				mb:SetPoint("TOPLEFT", b.body, "BOTTOMLEFT", 0, -6 - extra)
				mb:Show()
				extra = extra + 28
				shownMacros = k
			end
			for k = shownMacros + 1, #b.macroBtns do b.macroBtns[k]:Hide() end
			b:SetHeight(6 + 12 + 4 + h + 8 + extra)
			b:ClearAllPoints()
			b:SetPoint("TOPLEFT", ui.content, "TOPLEFT", 0, -y)
			b.text = text
			b:Show()
			y = y + b:GetHeight() + 6
		end
		local last = #c.history
		for i, m in ipairs(c.history) do
			-- The Allow button only makes sense on the newest reply, and only while idle.
			local denied = (i == last and not c.pendingId and type(m.denied) == "table" and #m.denied > 0) and m.denied or nil
			Place(m.role, m.text, m.t and date("%H:%M", m.t) or "", false, denied, m.agent, m.macros, m.newChat)
		end
		if c.pendingId then
			local p = c.progress
			local head = "working... " .. ActivityLine(c)
			if run.statusText and run.statusText ~= "" then head = head .. "\n" .. run.statusText end
			Place("assistant", (p and p ~= "") and (head .. "\n\n" .. p) or head, "", true, nil, ChatAgent(c))
		elseif #c.history == 0 then
			if run.restoring then
				Place("system", "Connecting to the bridge and restoring your chats...", "", true)
			elseif not ClaudeWoW.IsConnected() then
				Place("system", "Not connected to the bridge. Start it (npm start in the claude-wow folder, or claude-wow in your project), then click Connect below.", "", true)
			else
				Place("system", "Click the box below and type to start. Shift-click an item, spell or quest to link it into your message. /claude-wow help lists the commands; /claude <text> and /r work from the game chat too.", "", true)
			end
		end
		for i = n + 1, #ui.bubbles do
			ui.bubbles[i]:Hide()
		end
		ui.content:SetHeight(math.max(y, 1))
		C_Timer.After(0.05, function()
			if ui.scroll then
				ui.scroll:SetVerticalScroll(ui.scroll:GetVerticalScrollRange())
			end
		end)
	end
	ClaudeWoW.UpdateStatus()
	ClaudeWoW.RenderChatList()
end

-- Copy box (/claude-wow copy): a selectable EditBox with the last reply pre-highlighted for Ctrl+C.
function ClaudeWoW.ShowCopy(text)
	if not ui.copy then
		local cf = CreateFrame("Frame", "ClaudeWoWCopy", UIParent, "BackdropTemplate")
		cf:SetSize(560, 320)
		cf:SetPoint("CENTER")
		cf:SetFrameStrata("FULLSCREEN_DIALOG")
		cf:SetMovable(true)
		cf:SetClampedToScreen(true)
		cf:EnableMouse(true)
		cf:RegisterForDrag("LeftButton")
		cf:SetScript("OnDragStart", cf.StartMoving)
		cf:SetScript("OnDragStop", cf.StopMovingOrSizing)
		cf:SetBackdrop(BACKDROP)
		cf:SetBackdropColor(0.05, 0.05, 0.07, 0.97)
		cf:SetBackdropBorderColor(0.6, 0.6, 0.6, 1)
		tinsert(UISpecialFrames, "ClaudeWoWCopy")

		local t = cf:CreateFontString(nil, "OVERLAY", "GameFontNormal")
		t:SetPoint("TOPLEFT", cf, "TOPLEFT", 14, -12)
		t:SetText("Text is selected - press Ctrl+C, then Esc")

		local x = CreateFrame("Button", nil, cf, "UIPanelCloseButton")
		x:SetPoint("TOPRIGHT", cf, "TOPRIGHT", -4, -4)

		local sc = CreateFrame("ScrollFrame", "ClaudeWoWCopyScroll", cf, "UIPanelScrollFrameTemplate")
		sc:SetPoint("TOPLEFT", cf, "TOPLEFT", 14, -36)
		sc:SetPoint("BOTTOMRIGHT", cf, "BOTTOMRIGHT", -32, 14)
		local eb = CreateFrame("EditBox", "ClaudeWoWCopyBox", sc)
		eb:SetMultiLine(true)
		eb:SetAutoFocus(false)
		eb:SetFontObject(ChatFontNormal)
		eb:SetMaxLetters(0)
		eb:SetSize(500, 260)
		eb:SetScript("OnEscapePressed", function() cf:Hide() end)
		sc:SetScrollChild(eb)
		sc:HookScript("OnSizeChanged", function(self, w) eb:SetWidth(w) end)
		ui.copy, ui.copyBox = cf, eb
	end
	ui.copyBox:SetText(text)
	ui.copy:Show()
	ui.copyBox:SetFocus()
	ui.copyBox:HighlightText()
end

function ClaudeWoW.RenderChatList()
	if not ui.chatButtons then return end
	for i, btn in ipairs(ui.chatButtons) do
		local c = db.chats[i]
		if c then
			local label = Display(c.name)
			local folder = FolderName(ChatFolder(c))
			if folder ~= "" and folder:lower() ~= c.name:lower() then
				label = label .. " |cff888888" .. Display(folder) .. "|r"
			end
			if c.agent and c.agent ~= "" then
				label = label .. " |cff888888" .. AgentName(c.agent) .. "|r"
			end
			if c.pendingId then
				label = label .. " |cffffd100...|r"
			elseif (c.unread or 0) > 0 then
				label = label .. " |cff55ff55(" .. c.unread .. ")|r"
			end
			btn.label:SetText(label)
			btn.chatId = c.id
			btn.selected:SetShown(c.id == db.activeChat)
			btn:Show()
		else
			btn:Hide()
		end
	end
end

function ClaudeWoW.UpdateMini()
	if not ui.miniBadge then return end
	local unread, working = 0, 0
	for _, c in ipairs(db.chats) do
		unread = unread + (c.unread or 0)
		if c.pendingId then working = working + 1 end
	end
	local t
	if working > 0 and unread > 0 then
		t = "|cff55ff55" .. unread .. " new|r |cffffd100" .. working .. " working|r"
	elseif working > 0 then
		t = "|cffffd100" .. (working == 1 and "working..." or (working .. " working...")) .. "|r"
	elseif unread > 0 then
		t = "|cff55ff55" .. unread .. (unread == 1 and " new reply" or " new replies") .. "|r"
	else
		t = "|cff999999idle|r"
	end
	ui.miniBadge:SetText(t)
	if ui.miniPulse then
		if unread > 0 then
			if not ui.miniPulse:IsPlaying() then ui.miniPulse:Play() end
		else
			ui.miniPulse:Stop()
			ui.miniBadge:SetAlpha(1)
		end
	end
end

local ECHO_DEFAULT = 4000 -- characters of a reply to print into the game chat ("/claude-wow echo <n>")

local function ChatLinks(chat)
	return "  |Hclaudewow:reply:" .. chat.id .. "|h|cff55ff55[reply]|r|h |Hclaudewow:open:" .. chat.id .. "|h|cff7ec8ff[open]|r|h"
end

local SUMMARY_LINES = 3 -- lines of the agent's TL;DR block printed in "summary" mode
local SUMMARY_FALLBACK_LINES = 2 -- lines of the reply shown when it came without one

-- Print a reply into the game chat: prefix on the first line, then the text line
-- by line up to the limit, then clickable links. `short` prints one preview line.
-- `summary` (the default) prints the TL;DR block the bridge split off the reply,
-- or the first lines of the reply when the agent didn't write one; the full text
-- is in the window, behind [open].
local function EchoToChat(chat, text, agent, summary)
	local mode = db.settings.echo
	if mode == "off" then return end
	local prefix = "|cff7ec8ff[" .. ReplyAgentName(chat, agent) .. " · " .. Display(chat.name) .. "]|r "
	local body = Display(text)
	if mode == "short" then
		local flat = (body:gsub("%s+", " "))
		if #flat > 200 then flat = flat:sub(1, 200) .. " ..." end
		print(prefix .. flat .. ChatLinks(chat))
		return
	end
	if mode == "summary" then
		local source, max = Display(summary or ""), SUMMARY_LINES
		if not source:match("%S") then source, max = body, SUMMARY_FALLBACK_LINES end
		local lines, total = {}, 0
		for line in (source .. "\n"):gmatch("(.-)\n") do
			if line:match("%S") then
				total = total + 1
				if total <= max then table.insert(lines, line) end
			end
		end
		for i, line in ipairs(lines) do
			print((i == 1 and prefix or "    ") .. line)
		end
		if total > max then
			print("    |cff888888... click [open] to read it all|r")
		end
		print("    " .. ChatLinks(chat):sub(3))
		return
	end
	local limit = tonumber(mode) or ECHO_DEFAULT
	local first, shown = true, 0
	for line in (body .. "\n"):gmatch("(.-)\n") do
		if line:match("%S") then
			if shown + #line > limit then
				print("    |cff888888... " .. (#body - shown) .. " more characters, click [open] to read it all|r")
				break
			end
			print((first and prefix or "    ") .. line)
			first = false
			shown = shown + #line
		end
	end
	print("    " .. ChatLinks(chat):sub(3))
end

-- A reply landed. Always play the sound and echo it to the game chat (into the
-- chat's whisper tab when those are on: a whisper with a window of its own
-- stays out of General); if that chat isn't on screen, also flash the screen
-- text and light up the mini bar.
function ClaudeWoW.Notify(chat, text, agent, summary, role, denied)
	pcall(PlaySound, 3081)
	ClaudeWoW.UpdateMini()
	-- Until a real whisper arrives, /r replies to this chat.
	run.lastMessenger = "agent"
	run.lastReplyChat = chat.id
	if not Whisper.Reply(chat, text, agent, role, denied) then
		EchoToChat(chat, text, agent, summary)
	end
	if ui.frame and ui.frame:IsShown() and db.activeChat == chat.id then return end
	if UIErrorsFrame then
		UIErrorsFrame:AddMessage(ReplyAgentName(chat, agent) .. " replied in " .. Display(chat.name), 0.5, 0.8, 1, 1)
	end
end

-- /r goes to the agent when it was the last one to message you, exactly like
-- whisper reply, and the box shows a "To Codex [chat]:" header while you type.
--
-- The chat type underneath is left alone (a custom type would leak into chat
-- settings); instead the box remembers an agent target, the header is repainted
-- over the game's own, and the send entry points are intercepted. Any other chat
-- type, Tab, Esc or a cleared box drops the target again.
local AGENT_R, AGENT_G, AGENT_B = 0.49, 0.78, 1.0

local function PaintAgentHeader(eb, chat)
	local header = _G[eb:GetName() .. "Header"]
	local suffix = _G[eb:GetName() .. "HeaderSuffix"]
	if not header then return end
	eb.agentPainting = true
	eb:UpdateHeader() -- lay out normally first, then repaint
	eb.agentPainting = nil
	header:SetWidth(0)
	header:SetText("To " .. ChatAgentName(chat) .. " [" .. Display(chat.name) .. "]: ")
	header:SetTextColor(AGENT_R, AGENT_G, AGENT_B)
	if suffix then suffix:Hide() end
	eb:SetTextInsets(15 + header:GetWidth(), 13, 0, 0)
	eb:SetTextColor(AGENT_R, AGENT_G, AGENT_B)
end

local function SendBoxToAgent(eb)
	local chat = FindChat(eb.agentTarget)
	local text = Trim(eb:GetText() or "")
	eb.agentTarget = nil
	eb:ClearChat()
	if chat and db.activeChat ~= chat.id then ClaudeWoW.SwitchChat(chat.id) end
	if text ~= "" then
		ClaudeWoW.Send(text)
	else
		ClaudeWoW.Toggle(true)
		if ui.input then ui.input:SetFocus() end
	end
end

local function HookReplyCommand()
	for i = 1, (NUM_CHAT_WINDOWS or 10) do
		local eb = _G["ChatFrame" .. i .. "EditBox"]
		if eb and eb.ProcessChatType and not eb.agentReplyHooked then
			eb.agentReplyHooked = true

			local origProcess = eb.ProcessChatType
			eb.ProcessChatType = function(self, msg, index, send, ...)
				if index ~= "REPLY" then
					self.agentTarget = nil
					return origProcess(self, msg, index, send, ...)
				end
				if not (db and run.lastMessenger == "agent") then
					return origProcess(self, msg, index, send, ...)
				end
				local chat = FindChat(run.lastReplyChat) or ActiveChat()
				if send == 1 then
					self:SetText(msg or "")
					self.agentTarget = chat and chat.id
					SendBoxToAgent(self)
					return true
				end
				self.agentTarget = chat and chat.id
				self:SetText(msg or "")
				if chat then PaintAgentHeader(self, chat) end
				return true
			end

			-- Enter arrives here; nothing below us ever sees an agent-targeted box.
			for _, name in ipairs({ "SendMessage", "SendText" }) do
				local orig = eb[name]
				if orig then
					eb[name] = function(self, ...)
						if self.agentTarget then
							SendBoxToAgent(self)
							return
						end
						return orig(self, ...)
					end
				end
			end

			-- Anything that repaints the header normally (Tab, /s, sticky reset) ends agent mode.
			hooksecurefunc(eb, "UpdateHeader", function(self)
				if not self.agentPainting then self.agentTarget = nil end
			end)
			hooksecurefunc(eb, "ClearChat", function(self)
				self.agentTarget = nil
			end)
		end
	end
end

-- Clicks on our [reply] / [open] links in the chat frame.
hooksecurefunc("SetItemRef", function(link)
	local action, chatId = tostring(link):match("^claudewow:(%a+):(%w+)")
	if not action or not db then return end
	if FindChat(chatId) then ClaudeWoW.SwitchChat(chatId) end
	ClaudeWoW.Toggle(true)
	if action == "reply" and ui.input then ui.input:SetFocus() end
end)

-- Shift-clicking an item, spell, quest or name puts its link into the chat box
-- being typed in. Blizzard's insert function only knows its own boxes, so when
-- ours has the keyboard, take the link too. With no box focused the shift-click
-- keeps its normal meaning (splitting a stack, for one).
--
-- On this client (modern UI code, Blizzard_ChatFrameUtil) every shift-click
-- ends in ChatFrameUtil.InsertLink; ChatEdit_InsertLink is the older global
-- name, hooked only where the new one is missing so one click inserts once.
local function TakeLink(text)
	if text and text ~= "" and ui.input and ui.input:HasFocus() then
		ui.input:Insert(text)
	end
end
if type(ChatFrameUtil) == "table" and type(ChatFrameUtil.InsertLink) == "function" then
	hooksecurefunc(ChatFrameUtil, "InsertLink", TakeLink)
elseif type(ChatEdit_InsertLink) == "function" then
	hooksecurefunc("ChatEdit_InsertLink", TakeLink)
end

---------------------------------------------------------------------------
-- UI
---------------------------------------------------------------------------

local function MakeButton(parent, label, width, onClick)
	local b = CreateFrame("Button", nil, parent, "UIPanelButtonTemplate")
	b:SetSize(width, 22)
	b:SetText(label)
	b:SetScript("OnClick", onClick)
	return b
end

local PANEL_W = 150

local function BuildUI()
	if ui.frame then return end
	local s = db.settings

	local f = CreateFrame("Frame", "ClaudeWoWFrame", UIParent, "BackdropTemplate")
	ui.frame = f
	f:SetSize(s.width, s.height)
	if s.point then
		f:SetPoint(s.point, UIParent, s.relPoint or s.point, s.x or 0, s.y or 0)
	else
		f:SetPoint("CENTER")
	end
	f:SetFrameStrata("DIALOG")
	f:SetMovable(true)
	f:SetResizable(true)
	f:SetClampedToScreen(true)
	f:SetResizeBounds(560, 300)
	f:EnableMouse(true)
	f:RegisterForDrag("LeftButton")
	f:SetScript("OnDragStart", f.StartMoving)
	f:SetScript("OnDragStop", function(self)
		self:StopMovingOrSizing()
		local point, _, relPoint, x, y = self:GetPoint()
		s.point, s.relPoint, s.x, s.y = point, relPoint, x, y
	end)
	f:SetBackdrop(BACKDROP)
	f:SetBackdropColor(0.05, 0.05, 0.07, 0.95)
	f:SetBackdropBorderColor(0.6, 0.6, 0.6, 1)
	f:Hide()
	tinsert(UISpecialFrames, "ClaudeWoWFrame")

	-- Status light: green = bridge seen recently, yellow = stale, red = gone.
	local function MakeDot(parent)
		local holder = CreateFrame("Frame", nil, parent)
		holder:SetSize(16, 16)
		local dot = holder:CreateTexture(nil, "OVERLAY")
		dot:SetAllPoints()
		dot:SetTexture("Interface\\FriendsFrame\\StatusIcon-Offline")
		holder:EnableMouse(true)
		holder:SetScript("OnEnter", function(self)
			GameTooltip:SetOwner(self, "ANCHOR_RIGHT")
			GameTooltip:SetText(dot.tip or "Bridge status", 0.9, 0.9, 0.9, 1, true)
			GameTooltip:Show()
		end)
		holder:SetScript("OnLeave", function() GameTooltip:Hide() end)
		return holder, dot
	end

	local dotHolder, dot = MakeDot(f)
	dotHolder:SetPoint("TOPLEFT", f, "TOPLEFT", 14, -16)
	ui.dot = dot

	local title = f:CreateFontString(nil, "OVERLAY", "GameFontNormalLarge")
	title:SetPoint("LEFT", dotHolder, "RIGHT", 6, 0)
	title:SetText("Claude WoW")
	ui.title = title

	local status = f:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
	status:SetPoint("TOPLEFT", f, "TOPLEFT", 14, -34)
	status:SetPoint("RIGHT", f, "RIGHT", -60, 0)
	status:SetJustifyH("LEFT")
	ui.status = status

	-- Minimize button in the corner where a close X would be: this window is never
	-- closed from here, only collapsed to the mini bar (Esc does the same, see OnHide).
	-- The mini bar's own X is the one that hides everything.
	local mini
	if C_Texture and C_Texture.GetAtlasExists and C_Texture.GetAtlasExists("RedButton-MiniCondense") then
		-- Blizzard's own minimize button: the close button's chrome with a "condense" glyph.
		local ok, b = pcall(CreateFrame, "Button", nil, f, "UIPanelHideButtonNoScripts")
		if ok and b then mini = b end
	end
	if not mini then
		-- Older art: draw a dash on a plain button.
		mini = CreateFrame("Button", nil, f)
		mini:SetSize(24, 24)
		local dash = mini:CreateTexture(nil, "ARTWORK")
		dash:SetSize(10, 2)
		dash:SetPoint("CENTER", mini, "CENTER", 0, -3)
		dash:SetColorTexture(0.9, 0.9, 0.9, 1)
		local hl = mini:CreateTexture(nil, "HIGHLIGHT")
		hl:SetAllPoints()
		hl:SetColorTexture(1, 1, 1, 0.15)
	end
	mini:SetPoint("TOPRIGHT", f, "TOPRIGHT", -4, -4)
	mini:SetScript("OnClick", function() ClaudeWoW.Minimize(true) end)
	mini:SetScript("OnEnter", function(self)
		GameTooltip:SetOwner(self, "ANCHOR_LEFT")
		GameTooltip:SetText("Minimize to the small bar  (Esc)")
		GameTooltip:AddLine("The agent keeps working; the bar shows when a reply lands.", 0.8, 0.8, 0.8, true)
		GameTooltip:Show()
	end)
	mini:SetScript("OnLeave", function() GameTooltip:Hide() end)

	-- Esc (via UISpecialFrames) just calls Hide(); treat that as a minimize unless
	-- we're hiding on purpose. Ignore hides caused by the whole UI going away.
	f:SetScript("OnHide", function()
		if ui.quitting then
			ui.quitting = nil
			return
		end
		if not db or not db.settings.shown or not UIParent:IsShown() then return end
		db.settings.minimized = true
		if ui.mini then ui.mini:Show() end
		ClaudeWoW.UpdateMini()
	end)

	-- Left panel: chat list
	local panel = CreateFrame("Frame", nil, f, "BackdropTemplate")
	panel:SetPoint("TOPLEFT", f, "TOPLEFT", 14, -52)
	panel:SetPoint("BOTTOMLEFT", f, "BOTTOMLEFT", 14, 50)
	panel:SetWidth(PANEL_W)
	panel:SetBackdrop({
		bgFile = "Interface\\ChatFrame\\ChatFrameBackground",
		edgeFile = "Interface\\Tooltips\\UI-Tooltip-Border",
		tile = true, tileSize = 16, edgeSize = 12,
		insets = { left = 3, right = 3, top = 3, bottom = 3 },
	})
	panel:SetBackdropColor(0, 0, 0, 0.4)
	panel:SetBackdropBorderColor(0.4, 0.4, 0.4, 1)

	local newBtn = MakeButton(panel, "+ New chat", PANEL_W - 16, function() ClaudeWoW.NewChat() end)
	newBtn:SetPoint("TOP", panel, "TOP", 0, -8)

	-- Per-chat menu: Rename, Folder, Agent and Plugin, opened by right-clicking
	-- a chat row. A plain frame of our own rather than a Blizzard dropdown, so it
	-- looks the same on every client.
	local menu = CreateFrame("Frame", "ClaudeWoWChatMenu", f, "BackdropTemplate")
	menu:SetSize(110, 5 * 20 + 12)
	menu:SetFrameStrata("TOOLTIP")
	menu:SetBackdrop({
		bgFile = "Interface\\ChatFrame\\ChatFrameBackground",
		edgeFile = "Interface\\Tooltips\\UI-Tooltip-Border",
		tile = true, tileSize = 16, edgeSize = 12,
		insets = { left = 3, right = 3, top = 3, bottom = 3 },
	})
	menu:SetBackdropColor(0.08, 0.08, 0.1, 0.97)
	menu:SetBackdropBorderColor(0.6, 0.6, 0.6, 1)
	menu:EnableMouse(true)
	menu.title = menu:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
	menu.title:SetPoint("TOPLEFT", menu, "TOPLEFT", 10, -8)
	menu.title:SetPoint("RIGHT", menu, "RIGHT", -8, 0)
	menu.title:SetJustifyH("LEFT")
	menu.title:SetWordWrap(false)
	local function MenuItem(label, order, onClick)
		local it = CreateFrame("Button", nil, menu)
		it:SetSize(110 - 12, 20)
		it:SetPoint("TOPLEFT", menu, "TOPLEFT", 6, -6 - order * 20)
		local hl = it:CreateTexture(nil, "HIGHLIGHT")
		hl:SetAllPoints()
		hl:SetColorTexture(1, 1, 1, 0.12)
		it.label = it:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
		it.label:SetPoint("LEFT", it, "LEFT", 6, 0)
		it.label:SetText(label)
		it:SetScript("OnClick", function()
			menu:Hide()
			onClick(menu.chatId)
		end)
		return it
	end
	MenuItem("Rename...", 1, ClaudeWoW.RenamePrompt)
	MenuItem("Folder...", 2, ClaudeWoW.FolderPrompt)
	MenuItem("Agent...", 3, ClaudeWoW.AgentPrompt)
	MenuItem("Plugin...", 4, ClaudeWoW.PluginPrompt)
	-- Close once the mouse has wandered away from the menu and the row it came from.
	menu:SetScript("OnUpdate", function(self, dt)
		if not MouseIsOver then return end
		if MouseIsOver(self) or (self.owner and MouseIsOver(self.owner)) then
			self.away = 0
		else
			self.away = (self.away or 0) + dt
			if self.away > 0.5 then self:Hide() end
		end
	end)
	menu:Hide()
	ui.chatMenu = menu

	function ClaudeWoW.ShowChatMenu(chatId, anchor)
		local c = FindChat(chatId)
		if not c then return end
		if menu:IsShown() and menu.chatId == chatId then
			menu:Hide()
			return
		end
		menu.chatId = chatId
		menu.owner = anchor
		menu.away = 0
		menu.title:SetText(Display(c.name))
		menu:ClearAllPoints()
		menu:SetPoint("TOPLEFT", anchor, "BOTTOMLEFT", 8, 2)
		menu:Show()
	end

	ui.chatButtons = {}
	for i = 1, MAX_CHATS do
		local b = CreateFrame("Button", nil, panel)
		b:SetSize(PANEL_W - 16, 20)
		b:SetPoint("TOP", newBtn, "BOTTOM", 0, -6 - (i - 1) * 21)
		b.selected = b:CreateTexture(nil, "BACKGROUND")
		b.selected:SetAllPoints()
		b.selected:SetColorTexture(1, 1, 1, 0.12)
		b.selected:Hide()
		local hl = b:CreateTexture(nil, "HIGHLIGHT")
		hl:SetAllPoints()
		hl:SetColorTexture(1, 1, 1, 0.08)

		-- Trash can: delete this chat (asks first). Blizzard's red delete button
		-- where the client has it, a plain X elsewhere.
		b.del = CreateFrame("Button", nil, b)
		b.del:SetSize(16, 16)
		b.del:SetPoint("RIGHT", b, "RIGHT", -2, 0)
		if C_Texture and C_Texture.GetAtlasExists and C_Texture.GetAtlasExists("128-RedButton-Delete") then
			b.del:SetNormalAtlas("128-RedButton-Delete")
			b.del:SetPushedAtlas("128-RedButton-Delete-Pressed")
			b.del:SetHighlightAtlas("128-RedButton-Delete-Highlight")
		else
			b.del:SetNormalTexture("Interface\\Buttons\\UI-GroupLoot-Pass-Up")
			b.del:SetHighlightTexture("Interface\\Buttons\\UI-GroupLoot-Pass-Highlight")
		end
		b.del:SetAlpha(0.6)
		b.del:SetScript("OnClick", function() ClaudeWoW.ConfirmDelete(b.chatId) end)
		b.del:SetScript("OnEnter", function(self)
			self:SetAlpha(1)
			GameTooltip:SetOwner(self, "ANCHOR_RIGHT")
			GameTooltip:SetText("Delete this chat")
			GameTooltip:Show()
		end)
		b.del:SetScript("OnLeave", function(self)
			self:SetAlpha(0.6)
			GameTooltip:Hide()
		end)

		b.label = b:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
		b.label:SetPoint("LEFT", b, "LEFT", 6, 0)
		b.label:SetPoint("RIGHT", b.del, "LEFT", -4, 0)
		b.label:SetJustifyH("LEFT")
		b.label:SetWordWrap(false)
		-- Left-click switches to the chat; right-click opens its menu (Rename,
		-- Folder, Agent). A second right-click on the same row closes the menu again.
		b:RegisterForClicks("LeftButtonUp", "RightButtonUp")
		b:SetScript("OnClick", function(self, button)
			if button == "RightButton" then
				ClaudeWoW.ShowChatMenu(self.chatId, self)
			else
				ClaudeWoW.SwitchChat(self.chatId)
			end
		end)
		b:SetScript("OnDoubleClick", function(self)
			ClaudeWoW.SwitchChat(self.chatId)
			ClaudeWoW.RenamePrompt(self.chatId)
		end)
		b:Hide()
		ui.chatButtons[i] = b
	end

	-- Transcript: a scrolling stack of message bubbles
	local scroll = CreateFrame("ScrollFrame", "ClaudeWoWScroll", f, "UIPanelScrollFrameTemplate")
	scroll:SetPoint("TOPLEFT", panel, "TOPRIGHT", 8, 0)
	scroll:SetPoint("BOTTOMRIGHT", f, "BOTTOMRIGHT", -32, 110)
	ui.scroll = scroll

	local content = CreateFrame("Frame", "ClaudeWoWContent", scroll)
	content:SetSize(500, 1)
	scroll:SetScrollChild(content)
	ui.content = content
	ui.bubbles = {}
	scroll:HookScript("OnSizeChanged", function(self, w, h)
		if ui.frame:IsShown() then ClaudeWoW.Render() end
	end)

	-- Input box, with Send docked at its right end like a messaging app.
	local SEND_W = 84
	local inputBg = CreateFrame("Frame", nil, f, "BackdropTemplate")
	inputBg:SetPoint("BOTTOMLEFT", panel, "BOTTOMRIGHT", 8, 0)
	inputBg:SetPoint("BOTTOMRIGHT", f, "BOTTOMRIGHT", -14 - SEND_W - 6, 50)
	inputBg:SetHeight(54)
	inputBg:SetBackdrop({
		bgFile = "Interface\\ChatFrame\\ChatFrameBackground",
		edgeFile = "Interface\\Tooltips\\UI-Tooltip-Border",
		tile = true, tileSize = 16, edgeSize = 12,
		insets = { left = 3, right = 3, top = 3, bottom = 3 },
	})
	inputBg:SetBackdropColor(0, 0, 0, 0.6)
	inputBg:SetBackdropBorderColor(0.5, 0.5, 0.5, 1)

	local inScroll = CreateFrame("ScrollFrame", "ClaudeWoWInputScroll", inputBg, "UIPanelScrollFrameTemplate")
	inScroll:SetPoint("TOPLEFT", inputBg, "TOPLEFT", 8, -6)
	inScroll:SetPoint("BOTTOMRIGHT", inputBg, "BOTTOMRIGHT", -24, 6)

	local input = CreateFrame("EditBox", "ClaudeWoWInput", inScroll)
	input:SetMultiLine(true)
	input:SetAutoFocus(false)
	input:SetFontObject(ChatFontNormal)
	input:SetMaxLetters(0)
	input:SetSize(500, 40)
	input:SetScript("OnEnterPressed", function() ClaudeWoW.SendFromInput() end)
	input:SetScript("OnEscapePressed", function(self) self:ClearFocus() end)
	inScroll:SetScrollChild(input)
	inScroll:HookScript("OnSizeChanged", function(self, w, h)
		input:SetWidth(w)
	end)
	inputBg:SetScript("OnMouseDown", function() input:SetFocus() end)
	ui.input = input

	-- Send sits to the right of the input box, vertically centred on it.
	local send = MakeButton(f, "Send", SEND_W, ClaudeWoW.SendFromInput)
	send:SetHeight(30)
	send:SetPoint("LEFT", inputBg, "RIGHT", 6, 0)
	ui.send = send

	-- Connect stands in for Send until the bridge has been seen (see UpdateConnect).
	local connect = MakeButton(f, "Connect", SEND_W, function() ClaudeWoW.Connect(true) end)
	connect:SetHeight(30)
	connect:SetPoint("LEFT", inputBg, "RIGHT", 6, 0)
	connect:SetScript("OnEnter", function(self)
		GameTooltip:SetOwner(self, "ANCHOR_TOP")
		GameTooltip:SetText("Connect to the bridge")
		GameTooltip:AddLine("The bridge must be running on this PC (npm start in claude-wow, or claude-wow in your project). The light turns green once it answers.", 0.8, 0.8, 0.8, true)
		GameTooltip:Show()
	end)
	connect:SetScript("OnLeave", function() GameTooltip:Hide() end)
	connect:Hide()
	ui.connect = connect

	-- Reload is the fallback transport's button; it sits apart on the right and
	-- only shows when a reload would do something (see UpdateStatus).
	local refresh = MakeButton(f, "Reload", 70, function() SafeReload() end)
	refresh:SetPoint("BOTTOMRIGHT", f, "BOTTOMRIGHT", -24, 16)
	refresh:Hide()
	ui.refresh = refresh

	-- Bottom row: Clear, plus Resend while a message is in flight. Rename, Folder
	-- and Delete live on each chat row in the left panel.
	local clear = MakeButton(f, "Clear", 60, function()
		local c = ActiveChat()
		if c then wipe(c.history) end
		ClaudeWoW.Render()
	end)
	clear:SetPoint("BOTTOMLEFT", f, "BOTTOMLEFT", 14, 16)

	local resend = MakeButton(f, "Resend", 70, ClaudeWoW.Resend)
	resend:SetPoint("LEFT", clear, "RIGHT", 6, 0)
	resend:Hide()
	ui.resend = resend

	-- A named, always-present button so a keybinding can click it (see /claude-wow bind).
	local hotkey = CreateFrame("Button", "ClaudeWoWRefreshButton", UIParent)
	hotkey:SetSize(1, 1)
	hotkey:SetPoint("TOPLEFT", UIParent, "TOPLEFT", -10, 10)
	hotkey:SetScript("OnClick", function()
		local c = ActiveChat()
		if c and c.pendingId then
			ClaudeWoW.Send("")
		else
			ClaudeWoW.Toggle()
		end
	end)

	local cwd = f:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
	cwd:SetPoint("BOTTOMLEFT", f, "BOTTOMLEFT", 16, 4)
	cwd:SetPoint("RIGHT", f, "RIGHT", -30, 0)
	cwd:SetJustifyH("LEFT")
	cwd:SetWordWrap(false)
	ui.cwd = cwd

	-- Resize grip
	local grip = CreateFrame("Button", nil, f)
	grip:SetSize(16, 16)
	grip:SetPoint("BOTTOMRIGHT", f, "BOTTOMRIGHT", -5, 5)
	grip:SetNormalTexture("Interface\\ChatFrame\\UI-ChatIM-SizeGrabber-Up")
	grip:SetHighlightTexture("Interface\\ChatFrame\\UI-ChatIM-SizeGrabber-Highlight")
	grip:SetPushedTexture("Interface\\ChatFrame\\UI-ChatIM-SizeGrabber-Down")
	grip:SetScript("OnMouseDown", function() f:StartSizing("BOTTOMRIGHT") end)
	grip:SetScript("OnMouseUp", function()
		f:StopMovingOrSizing()
		s.width, s.height = f:GetSize()
	end)

	-- Mini bar: what the window collapses into. Click it to expand, drag to move.
	local m = CreateFrame("Frame", "ClaudeWoWMini", UIParent, "BackdropTemplate")
	ui.mini = m
	m:SetSize(250, 30)
	if s.miniPoint then
		m:SetPoint(s.miniPoint, UIParent, s.miniRelPoint or s.miniPoint, s.miniX or 0, s.miniY or 0)
	else
		m:SetPoint("TOP", UIParent, "TOP", 0, -40)
	end
	m:SetFrameStrata("DIALOG")
	m:SetMovable(true)
	m:SetClampedToScreen(true)
	m:EnableMouse(true)
	m:RegisterForDrag("LeftButton")
	m:SetScript("OnDragStart", function(self)
		self.dragging = true
		self:StartMoving()
	end)
	m:SetScript("OnDragStop", function(self)
		self:StopMovingOrSizing()
		local point, _, relPoint, x, y = self:GetPoint()
		s.miniPoint, s.miniRelPoint, s.miniX, s.miniY = point, relPoint, x, y
		C_Timer.After(0, function() self.dragging = nil end)
	end)
	m:SetScript("OnMouseUp", function(self, button)
		if button == "LeftButton" and not self.dragging then
			ClaudeWoW.Minimize(false)
		end
	end)
	m:SetBackdrop(BACKDROP)
	m:SetBackdropColor(0.05, 0.05, 0.07, 0.95)
	m:SetBackdropBorderColor(0.6, 0.6, 0.6, 1)
	m:Hide()

	local miniDotHolder, miniDot = MakeDot(m)
	miniDotHolder:SetPoint("LEFT", m, "LEFT", 9, 0)
	ui.miniDot = miniDot

	local mlabel = m:CreateFontString(nil, "OVERLAY", "GameFontNormal")
	mlabel:SetPoint("LEFT", miniDotHolder, "RIGHT", 6, 0)
	mlabel:SetText("Claude WoW")

	local badge = m:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
	badge:SetPoint("LEFT", mlabel, "RIGHT", 8, 0)
	badge:SetPoint("RIGHT", m, "RIGHT", -26, 0)
	badge:SetJustifyH("LEFT")
	badge:SetWordWrap(false)
	ui.miniBadge = badge

	local ok, pulse = pcall(function()
		local g = badge:CreateAnimationGroup()
		local a1 = g:CreateAnimation("Alpha")
		a1:SetFromAlpha(1)
		a1:SetToAlpha(0.25)
		a1:SetDuration(0.6)
		a1:SetOrder(1)
		local a2 = g:CreateAnimation("Alpha")
		a2:SetFromAlpha(0.25)
		a2:SetToAlpha(1)
		a2:SetDuration(0.6)
		a2:SetOrder(2)
		g:SetLooping("REPEAT")
		return g
	end)
	if ok then ui.miniPulse = pulse end

	local mclose = CreateFrame("Button", nil, m, "UIPanelCloseButton")
	mclose:SetSize(24, 24)
	mclose:SetPoint("RIGHT", m, "RIGHT", -2, 0)
	mclose:SetScript("OnClick", function() ClaudeWoW.Toggle(false) end)
	mclose:SetScript("OnEnter", function(self)
		GameTooltip:SetOwner(self, "ANCHOR_LEFT")
		GameTooltip:SetText("Quit: hide completely (/claude-wow brings it back)")
		GameTooltip:Show()
	end)
	mclose:SetScript("OnLeave", function() GameTooltip:Hide() end)
end

function ClaudeWoW.Toggle(show)
	if not ui.frame then return end
	if show == nil then show = not ui.frame:IsShown() end
	if show then
		db.settings.minimized = false
		local c = ActiveChat()
		if c then c.unread = 0 end
	end
	if ui.mini then ui.mini:Hide() end
	if not show then ui.quitting = true end
	ui.frame:SetShown(show)
	ui.quitting = nil
	db.settings.shown = show
	if show then
		ClaudeWoW.Render()
		-- No auto-focus: the game keeps the keyboard until you click the box.
		-- No automatic hello either: if the bridge hasn't been seen, the panel
		-- shows Connect in place of Send and waits for a click.
	end
	ClaudeWoW.UpdateMini()
end

function ClaudeWoW.Minimize(mini)
	if not ui.frame then return end
	if mini == nil then mini = not db.settings.minimized end
	if mini then
		db.settings.minimized = true
		db.settings.shown = true
		ui.frame:Hide() -- OnHide shows the mini bar
		if ui.mini and not ui.mini:IsShown() then ui.mini:Show() end
		ClaudeWoW.UpdateMini()
	else
		ClaudeWoW.Toggle(true)
	end
end

---------------------------------------------------------------------------
-- Slash commands
---------------------------------------------------------------------------

local HELP = table.concat({
	"/claude-wow                        toggle the window (/claude is the same command)",
	"/claude-wow mini                   collapse to the small bar (click the bar to expand)",
	"/claude-wow hide                   hide the window completely",
	"/claude <text>                         send <text> to the current chat straight from the game chat box (/claude-wow <text> too). A message that starts with a command word is still sent when the rest of the line doesn't fit that command",
	"/r <text>                          replies to the agent when it was the last to message you (else normal whisper reply)",
	"/claude-wow whisper on|off        each chat as a native whisper tab: replies flash it like a player's whisper, typing in it goes to the agent (off by default)",
	"/claude-wow echo summary|full|short|off|<chars>   how much of each reply to print in the game chat (summary = the agent's closing TL;DR lines)",
	"/claude-wow longchat on|off        let the game chat box take 4000 characters (for long /claude messages)",
	"/claude-wow new [name]             start a new chat (its own agent session, like a new terminal)",
	"/claude-wow chat <n|name>          switch chats (or click one in the left panel)",
	"/claude-wow rename [name]          rename the current chat (no name = dialog; right-clicking the chat in the left panel offers it too)",
	"/claude-wow delete                 delete the current chat",
	"/claude-wow cd <folder>            folder this chat's agent works in (relative to the bridge's folder; no folder = back to default). Right-clicking the chat in the left panel and picking Folder does the same",
	"/claude-wow agent [name]           which agent this chat talks to (no name = show; default = the bridge's). Right-clicking the chat and picking Agent does the same",
	"/claude-wow plugin [name]          what this chat is for: ask (general in-game chat, the default) or claude-code (an agent session in a folder). No name = show; default = the bridge's. Right-clicking the chat and picking Plugin does the same",
	"/claude-wow reset                  next message in this chat starts a fresh agent session",
	"/claude-wow context [on|off]       what the agent is told about your character and where you are (no argument = show it, with this chat's context size and turns)",
	"/claude-wow context <n>            warn once, with a New chat button, when a chat's context passes n tokens (100k by default; 0 = never). The footer shows ctx and turns per chat",
	"/claude-wow vision [on|off]        send a picture of your screen with each message, so the agent can see what you see (screenshot transport; off by default)",
	"/claude-wow look <question>        send this one message with a picture of your screen, whatever the vision setting",
	"/claude-wow map [...]              map layers the agent drew, the route navigator and herb/ore nodes (no argument = status and subcommands; /aimap is the same)",
	"/claude-wow mode pixel             no-reload transport (default)",
	"/claude-wow mode reload            fallback transport: a /reload per step",
	"/claude-wow resend                 show the strip again if the bridge missed it",
	"/claude-wow reload                 reload now (also frees the slot pool)",
	"/claude-wow cancel                 stop waiting on this chat's reply",
	"/claude-wow copy                   open the last reply in a selectable box for Ctrl+C",
	"/claude-wow macro undo             undo the last macro the agent's button created or changed",
	"/claude-wow bind <key>             hotkey: checks for a reply while waiting, else toggles the window",
	"/claude-wow auto on|off            reload-mode only: auto-reload on your next keypress after the interval",
	"/claude-wow signal on|off          the cheap sound-file readiness check (off if it spams errors)",
	"/claude-wow slots                  how many reply slots are still free this session",
	"/claude-wow diag                   transport diagnostics (is the cheap sound-file channel working?)",
	"/claude-wow clear                  clear this chat's transcript",
}, "\n")

-- What each subcommand accepts, so that free text which happens to start with
-- one of these words ("delete the unused imports", "help me with this macro")
-- is sent as a message instead of run as a command. 0 = no arguments, 1 = at
-- most one word, a table = one of those words, a function decides, true = anything.
local function OnOffOrNumber(rest)
	return rest == "" or rest == "on" or rest == "off" or tonumber(rest) ~= nil
end

local function ChatArgument(rest)
	if rest == "" or tonumber(rest) or not rest:find("%s") then return true end
	for _, ch in ipairs(db.chats) do
		if ch.name:lower() == rest:lower() then return true end
	end
	return false
end

local COMMAND_ARGS = {
	mini = 0, min = 0, hide = 0, quit = 0, help = 0, clear = 0, delete = 0, reset = 0, copy = 0,
	cancel = 0, resend = 0, reload = 0, refresh = 0, slots = 0, diag = 0,
	context = function(rest) return rest == "" or rest == "on" or rest == "off" or ParseTokens(rest) ~= nil end,
	ctx = function(rest) return rest == "" or rest == "on" or rest == "off" or ParseTokens(rest) ~= nil end,
	mode = { [""] = true, pixel = true, reload = true },
	signal = { [""] = true, on = true, off = true }, longchat = { [""] = true, on = true, off = true },
	whisper = { [""] = true, on = true, off = true },
	vision = { [""] = true, on = true, off = true },
	look = true, -- /claude-wow look <question>: one message with a picture of the screen
	auto = OnOffOrNumber,
	echo = function(rest) return rest == "" or rest == "summary" or rest == "full" or rest == "short" or rest == "off" or tonumber(rest) ~= nil end,
	bind = 1, agent = 1, plugin = 1,
	chat = ChatArgument, chats = ChatArgument,
	cd = true, new = true, rename = true,
	map = true, -- /claude-wow map ...: Map.lua (layers, navigator, herb/ore nodes)
	macro = { undo = true }, -- /claude-wow macro undo; "/claude macro for my warrior" still goes to the agent
}

local function IsCommand(cmd, rest)
	local spec = COMMAND_ARGS[cmd]
	if spec == nil then return false end
	if spec == true then return true end
	if spec == 0 then return rest == "" end
	if spec == 1 then return not rest:find("%s") end
	if type(spec) == "table" then return spec[rest:lower()] == true end
	return spec(rest) == true
end

local function ApplyLongChat()
	local box = ChatFrame1EditBox
	if not box or not box.SetMaxLetters then return end
	box:SetMaxLetters(db.settings.longchat and 4000 or 255)
end

-- Two spellings of the one command and nothing else: the names from before the
-- rename (/wow-ai, /wowai, /ai, /ask, /wow-claude) are gone, not aliased.
-- /claude-wow is the client: bare, it shows the window. /claude behaves like
-- opening a terminal: bare, it starts a new chat, which is the only way to begin
-- a fresh thread from inside a whisper tab.
SLASH_CLAUDEWOW1 = "/claude-wow"
SLASH_CLAUDE1 = "/claude"
SlashCmdList["CLAUDE"] = function(msg, editBox)
	if Trim(msg or "") == "" then
		ClaudeWoW.NewChat()
		return
	end
	return SlashCmdList["CLAUDEWOW"](msg, editBox)
end

SlashCmdList["CLAUDEWOW"] = function(msg)
	msg = Trim(msg or "")
	local cmd, rest = msg:match("^(%S+)%s*(.-)$")
	cmd = cmd and cmd:lower() or ""
	local s = db.settings
	local c = ActiveChat()

	-- Anything that isn't a command, or a command word followed by something it
	-- doesn't take, is a message for the agent.
	if cmd ~= "" and not IsCommand(cmd, rest) then
		ClaudeWoW.Send(msg)
		return
	end
	if cmd == "" then
		ClaudeWoW.Toggle()
	elseif cmd == "mini" or cmd == "min" then
		ClaudeWoW.Minimize(true)
	elseif cmd == "new" then
		ClaudeWoW.NewChat(rest)
	elseif cmd == "chat" or cmd == "chats" then
		local n = tonumber(rest)
		local target = n and db.chats[n]
		if not target and rest ~= "" then
			for _, ch in ipairs(db.chats) do
				if ch.name:lower() == rest:lower() then target = ch end
			end
		end
		if target then
			ClaudeWoW.SwitchChat(target.id)
		else
			local lines = {}
			for i, ch in ipairs(db.chats) do
				table.insert(lines, i .. ". " .. ch.name .. (ch.id == db.activeChat and "  (current)" or "") .. (ch.pendingId and "  working" or "") .. ((ch.unread or 0) > 0 and ("  " .. ch.unread .. " new") or ""))
			end
			AddHistory(c, "system", "Chats:\n" .. table.concat(lines, "\n"))
			ClaudeWoW.Render()
		end
		ClaudeWoW.Toggle(true)
	elseif cmd == "rename" then
		if rest ~= "" then
			c.name = rest:sub(1, 24)
			Whisper.Retitle(c)
			ClaudeWoW.Render()
		else
			ClaudeWoW.RenameActive()
		end
		ClaudeWoW.Toggle(true)
	elseif cmd == "delete" then
		ClaudeWoW.DeleteChat()
	elseif cmd == "cd" then
		ClaudeWoW.SetFolder(rest, c)
		ClaudeWoW.Toggle(true)
	elseif cmd == "map" then
		if ClaudeWoWMap then ClaudeWoWMap.Command(rest) else print("|cff66ccff[Claude WoW]|r the map module did not load") end
	elseif cmd == "agent" then
		ClaudeWoW.SetAgent(rest, c)
		ClaudeWoW.Toggle(true)
	elseif cmd == "plugin" then
		ClaudeWoW.SetPlugin(rest, c)
		ClaudeWoW.Toggle(true)
	elseif cmd == "reset" then
		c.resetNext = true
		local where = ChatFolder(c)
		AddHistory(c, "system", "Next message starts a fresh " .. ChatAgentName(c) .. " session" .. (where ~= "" and (" in " .. where) or ""))
		ClaudeWoW.Render()
		ClaudeWoW.Toggle(true)
	elseif cmd == "context" or cmd == "ctx" then
		rest = rest:lower()
		local limit = ParseTokens(rest)
		if limit then
			-- The context-growth threshold. Chats now under it are re-armed.
			s.contextWarn = limit
			for _, ch in ipairs(db.chats) do
				if limit <= 0 or (ch.ctx or 0) < limit then ch.ctxWarned = nil end
			end
			AddHistory(c, "system", (limit > 0
				and ("Context warning at " .. FmtTokens(limit) .. " tokens: a chat that passes it says so once and offers a new chat.")
				or "Context warning off: chats grow quietly. The footer still shows ctx and turns.")
				.. "\n" .. ContextReport(c))
			ClaudeWoW.Render()
			ClaudeWoW.Toggle(true)
			return
		end
		if rest == "on" or rest == "off" then
			s.context = rest == "on"
			-- Make sure the next record carries the change, hello throttle or not.
			run.contextSent = nil
			run.lastHelloAt = nil
			if ClaudeWoW.IsConnected() then ClaudeWoW.SayHello() end
		end
		local ctx = ClaudeWoW.GameContext()
		AddHistory(c, "system", (rest == "" and (ContextReport(c) .. "\n\n") or "") .. (s.context
			and "Game context is ON: the agent is told this with each message (it goes into its system prompt, so unrelated projects are unaffected by anything but a few lines). /claude-wow context off to stop.\n\n"
			or "Game context is OFF: the agent is told nothing about the game. /claude-wow context on to send this:\n\n") .. ctx
			.. "\n\nTip: click the input box, then shift-click an item, spell or quest to link it into your message; the agent gets its tooltip.")
		ClaudeWoW.Render()
		ClaudeWoW.Toggle(true)
	elseif cmd == "mode" then
		if rest == "pixel" or rest == "reload" then
			s.mode = rest
			SyncScreenshotMode()
			AddHistory(c, "system", "mode set to " .. rest)
		else
			AddHistory(c, "system", "mode is " .. s.mode .. " (pixel or reload)")
		end
		ClaudeWoW.Render()
		ClaudeWoW.Toggle(true)
	elseif cmd == "resend" then
		ClaudeWoW.Resend()
	elseif cmd == "auto" then
		local n = tonumber(rest)
		if n then
			s.interval = math.max(5, math.floor(n))
			s.autoRefresh = true
		elseif rest == "on" then
			s.autoRefresh = true
		elseif rest == "off" then
			s.autoRefresh = false
		end
		ClaudeWoW.UpdateStatus()
		ClaudeWoW.ArmAutoRefresh()
	elseif cmd == "hide" or cmd == "quit" then
		ClaudeWoW.Toggle(false)
	elseif cmd == "macro" and rest == "undo" then
		ClaudeWoW.UndoMacro()
	elseif cmd == "copy" then
		for i = #c.history, 1, -1 do
			if c.history[i].role == "assistant" then
				ClaudeWoW.ShowCopy(c.history[i].text)
				break
			end
		end
	elseif cmd == "echo" then
		if rest == "summary" or rest == "full" or rest == "short" or rest == "off" then
			s.echo = rest
		elseif tonumber(rest) then
			s.echo = tostring(math.max(200, math.floor(tonumber(rest))))
		end
		AddHistory(c, "system", "replies in game chat: " .. s.echo .. " (summary = the agent's TL;DR lines, full = " .. ECHO_DEFAULT .. " chars, short, off, or a number of characters)")
		ClaudeWoW.Render()
	elseif cmd == "longchat" then
		if rest == "on" then s.longchat = true elseif rest == "off" then s.longchat = false end
		ApplyLongChat()
		AddHistory(c, "system", "game chat box limit: " .. (s.longchat and "4000 characters (fine for /claude; real chat over 255 may be rejected by the server)" or "255 (default)"))
		ClaudeWoW.Render()
	elseif cmd == "signal" then
		if rest == "on" then s.signal = true elseif rest == "off" then s.signal = false end
		AddHistory(c, "system", "signal check is " .. (s.signal and "on" or "off"))
		ClaudeWoW.Render()
	elseif cmd == "whisper" then
		if rest == "on" then
			s.whisper = true
			Whisper.Install()
			local frame = Whisper.FrameFor(c, true, true)
			AddHistory(c, "system", frame
				and ("Whisper tabs are ON: this chat is the \"" .. Display(c.name) .. "\" tab in the chat dock. Type there and press Enter to talk to " .. ChatAgentName(c) .. "; replies flash the tab. Other chats get a tab with their first message. /claude-wow whisper off closes them.")
				or ("Whisper tabs are ON, but this client could not open a chat tab" .. (run.whisperError and (": " .. run.whisperError) or " (no FCF_OpenTemporaryWindow)") .. ". Replies keep going to the game chat as before."))
		elseif rest == "off" then
			s.whisper = false
			Whisper.CloseAll()
			AddHistory(c, "system", "Whisper tabs are off; replies go to the game chat as before")
		else
			AddHistory(c, "system", Whisper.Status() .. " (/claude-wow whisper on|off: each chat as a native whisper tab)")
		end
		ClaudeWoW.Render()
	elseif cmd == "vision" then
		if rest == "on" then s.vision = true elseif rest == "off" then s.vision = false end
		AddHistory(c, "system", VisionStatus() .. ". /claude-wow vision on|off; /claude-wow look <question> sends one message with a picture whatever the setting.")
		ClaudeWoW.UpdateStatus()
		ClaudeWoW.Render()
		ClaudeWoW.Toggle(true)
	elseif cmd == "look" then
		ClaudeWoW.Send(rest ~= "" and rest or "What do you see on my screen?", nil, { vision = true })
	elseif cmd == "slots" then
		local free = 0
		for i = 1, SLOT_COUNT do
			if not C_AddOns.IsAddOnLoaded(SlotName(i)) then free = free + 1 end
		end
		AddHistory(c, "system", free .. " of " .. SLOT_COUNT .. " reply slots free this session (a reload frees all)")
		ClaudeWoW.Render()
		ClaudeWoW.Toggle(true)
	elseif cmd == "refresh" or cmd == "reload" then
		SafeReload()
	elseif cmd == "bind" then
		local key = rest:upper()
		if key ~= "" and not InCombatLockdown() then
			SetBinding(key, "CLICK ClaudeWoWRefreshButton:LeftButton")
			SaveBindings(GetCurrentBindingSet())
			AddHistory(c, "system", key .. " is now bound: checks for a reply while waiting, otherwise toggles this window")
		end
		ClaudeWoW.Render()
		ClaudeWoW.Toggle(true)
	elseif cmd == "diag" then
		local free = 0
		for i = 1, SLOT_COUNT do
			if not C_AddOns.IsAddOnLoaded(SlotName(i)) then free = free + 1 end
		end
		local lines = {
			"sound channel: " .. (signalAvailable and "usable" or "UNUSABLE") .. " (self-test: " .. tostring(signalStats.selftest) .. ")" .. (signalStats.error and (" error: " .. signalStats.error) or ""),
			"signal setting: " .. tostring(s.signal) .. ", marked unreliable this session: " .. tostring(run.signalUnreliable or false),
			"sound checks: " .. signalStats.checks .. ", valid hits: " .. signalStats.hits .. (signalStats.lastHit and (", last hit " .. FmtDur(GetTime() - signalStats.lastHit) .. " ago") or ""),
			"slot polls this session: " .. (run.polls or 0) .. ", free slots: " .. free .. "/" .. SLOT_COUNT,
			"presence: head at " .. tostring(run.presence and run.presence.last or "?") .. ", beats seen: " .. tostring(run.presence and run.presence.beats or 0),
			select(5, ClaudeWoW.BridgeState()),
			"mode: " .. s.mode .. ", session token: " .. tostring(db.session),
			Whisper.Status(),
			"transport: " .. tostring(s.transport or "pixel") .. (s.transport == "screenshot" and type(Screenshot) ~= "function" and " (Screenshot() missing: strip stays up, and the bridge is told to fall back to the pixel capture)" or "")
				.. (s.transport == "pixel" and s.transportNote and (" (bridge: " .. s.transportNote .. ")") or "")
				.. (s.transport == "screenshot" and s.stripLevels and string.format(", strip levels %d/%d", s.stripLevels.off, s.stripLevels.on) or "")
				.. (run.shotStats and string.format(", screenshots: %d taken, %d confirmed, %d failed, %d without event", run.shotStats.taken, run.shotStats.ok, run.shotStats.failed, run.shotStats.timeouts) or "")
				.. (run.shotsPaused and ", screenshots PAUSED (bridge not seen for " .. FmtDur(GetTime() - (run.bridgeSeen or run.startedAt or GetTime())) .. ")" or "")
				.. (s.shotFormatSaved and (", screenshotFormat saved: " .. s.shotFormatSaved) or ""),
			"vision: " .. (s.vision and "on" or "off") .. (s.vision and s.transport ~= "screenshot" and " (needs the screenshot transport; the pixel capture never sees more than the strip)" or ""),
			"plugin: " .. ((c.plugin and c.plugin ~= "") and c.plugin or ("bridge default, " .. (run.bridgePlugin or "unknown until connected"))) .. " (bridge has: " .. PluginList() .. ")",
			"context: " .. ContextThresholdLabel(),
		}
		for _, ch in ipairs(db.chats) do
			local a = run.act and run.act[ch.id]
			if ch.pendingId then
				table.insert(lines, ch.name .. ": pending #" .. ch.pendingId .. (a and (", heartbeat " .. (a.unreliable and "unreliable" or (a.count .. " beats"))) or ", no heartbeat state"))
			end
			local growth = ContextSegment(ch, true)
			local turns = TurnsLabel(ch)
			if growth ~= "" or turns ~= "" then
				table.insert(lines, ch.name .. ": " .. growth .. ((growth ~= "" and turns ~= "") and ", " or "") .. turns .. (ch.ctxWarned and " (warned)" or ""))
			end
		end
		-- Cost of the addon itself. Memory is always available; CPU needs
		-- scriptProfile, which only takes effect after a restart.
		if UpdateAddOnMemoryUsage then
			UpdateAddOnMemoryUsage()
			local kb = GetAddOnMemoryUsage and GetAddOnMemoryUsage("ClaudeWoW") or 0
			local line = string.format("addon memory: %.1f MB", kb / 1024)
			if UpdateAddOnCPUUsage and GetAddOnCPUUsage then
				UpdateAddOnCPUUsage()
				local ms = GetAddOnCPUUsage("ClaudeWoW")
				local total = 0
				for i = 1, (C_AddOns and C_AddOns.GetNumAddOns and C_AddOns.GetNumAddOns() or 0) do
					total = total + (GetAddOnCPUUsage(i) or 0)
				end
				if ms and ms > 0 then
					line = line .. string.format("; cpu %.0f ms%s", ms,
						total > 0 and string.format(" (%.0f%% of all addons)", ms / total * 100) or "")
				else
					line = line .. "; cpu profiling off (/console scriptProfile 1, then restart WoW)"
				end
			end
			lines[#lines + 1] = line
		end
		AddHistory(c, "system", "Diagnostics:\n" .. table.concat(lines, "\n"))
		ClaudeWoW.Render()
		ClaudeWoW.Toggle(true)
	elseif cmd == "cancel" then
		if c.pendingId then
			local cancelled = c.pendingId
			AddHistory(c, "system", "Gave up waiting on #" .. c.pendingId .. "; the bridge is told to stop it")
			run.outbound[c.pendingId] = nil
			if run.act then run.act[c.id] = nil end
			c.pendingId = nil
			c.progress = nil
			SendCancel(c, cancelled)
			RefreshStrip()
			if not AnyPending() then keyCatcher:Hide() end
		end
		ClaudeWoW.Render()
	elseif cmd == "clear" then
		wipe(c.history)
		ClaudeWoW.Render()
	elseif cmd == "help" then
		AddHistory(c, "system", HELP)
		ClaudeWoW.Render()
		ClaudeWoW.Toggle(true)
	end
end

---------------------------------------------------------------------------
-- Events
---------------------------------------------------------------------------

local ev = CreateFrame("Frame")
ev:RegisterEvent("ADDON_LOADED")
ev:RegisterEvent("PLAYER_LOGIN")
ev:RegisterEvent("PLAYER_REGEN_ENABLED")
ev:RegisterEvent("UPDATE_MACROS")
ev:RegisterEvent("CHAT_MSG_WHISPER")
ev:RegisterEvent("CHAT_MSG_BN_WHISPER")
ev:RegisterEvent("SCREENSHOT_SUCCEEDED")
ev:RegisterEvent("SCREENSHOT_FAILED")
ev:RegisterEvent("PLAYER_LOGOUT")
ev:SetScript("OnEvent", function(self, event, arg1)
	if event == "ADDON_LOADED" then
		if arg1 == ADDON_NAME then
			InitDB()
			-- The saved data is here: a screenshotFormat left behind by a crash
			-- (no PLAYER_LOGOUT, no restore) goes back to the player's value now,
			-- unless the remembered transport is about to need ours again.
			SyncScreenshotMode()
		end
	elseif event == "SCREENSHOT_SUCCEEDED" then
		ScreenshotDone(true)
	elseif event == "SCREENSHOT_FAILED" then
		ScreenshotDone(false)
	elseif event == "PLAYER_LOGOUT" then
		-- The player's screenshot format goes back before the client saves its CVars.
		if db then ScreenshotCVarsOff() end
	elseif event == "CHAT_MSG_WHISPER" or event == "CHAT_MSG_BN_WHISPER" then
		-- A real person whispered: /r belongs to them again.
		run.lastMessenger = "player"
	elseif event == "PLAYER_LOGIN" then
		if not db then InitDB() end
		BuildUI()
		run = { outbound = {}, startedAt = GetTime() }
		SelfTestSignals()
		ProcessInbox()
		SyncScreenshotMode()
		if AnyPending() then
			-- Still waiting after a reload: resume polling with a fresh slot pool.
			run.sentAt = GetTime()
			run.polls = 0
			run.act = {}
			for _, ch in ipairs(db.chats) do
				if ch.pendingId then
					-- Beats already written stay valid, so the counter catches up on its own.
					run.act[ch.id] = { next = 1, count = 0, startedAt = GetTime() }
				end
			end
			ScheduleNextPoll()
		end
		local c = ActiveChat()
		if c and c.draft and c.draft ~= "" then
			ui.input:SetText(c.draft)
			if not c.pendingId then c.draft = nil end
		end
		ClaudeWoW.Render()
		if db.settings.shown then
			if db.settings.minimized then
				ClaudeWoW.Minimize(true)
			else
				ClaudeWoW.Toggle(true)
			end
		end
		ClaudeWoW.ArmAutoRefresh()
		ClaudeWoW.UpdateDot()
		if db.settings.longchat then ApplyLongChat() end
		HookReplyCommand()
		if db.settings.whisper then Whisper.Install() end
		C_Timer.NewTicker(TICK_SECONDS, Tick)
		C_Timer.After(3, ClaudeWoW.SayHello)
	elseif event == "UPDATE_MACROS" then
		-- "Create" / "Update" on the macro buttons follows what exists now.
		if ui.frame and ui.frame:IsShown() then ClaudeWoW.Render() end
	elseif event == "PLAYER_REGEN_ENABLED" then
		if ClaudeWoW.reloadAfterCombat then
			ClaudeWoW.reloadAfterCombat = nil
			ReloadUI()
		elseif db then
			ClaudeWoW.ArmAutoRefresh()
		end
	end
end)
