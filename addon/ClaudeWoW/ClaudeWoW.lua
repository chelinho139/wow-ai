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
_G.BINDING_NAME_CLAUDEWOW_WORKSPACE = "Claude WoW: open or close the workspace"
local Codec = ClaudeWoW_Codec

local DEFAULT_CWD = "" -- empty = the bridge's configured defaultCwd
local MAX_HISTORY = 200

local SLOT_COUNT = 200
local SLOT_PREFIX = "ClaudeWoW_S"
local ACT_MAX = 60 -- heartbeat files per message (act/NNN/01..60.wav)
local PRESENCE_MAX = 2000
local Presence = { RINGS = { "a", "b" }, STALL_SECONDS = 150 }
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
local LIVE_PLUGIN = "live"
local LIVE_PASS_TEXT = "Denied."
local LINK_PREFIX = "addon:claudewow:"
local RS, US = "\30", "\31" -- record / unit separators in the strip payload

local db
local ui = {}
ClaudeWoW.UI = ui
-- Transport state for this UI session. outbound[id] = { chat, cwd, flags, text, sentAt, acked }
local run = { outbound = {} }
-- Whisper tabs (the section after the game context). Declared up here because
-- Send, ApplyReplies and Finish use it and come first in the file.
local Whisper = {}
local Cli = { DIM_DEFAULT = 0.35, Links = {} }

-- Shared window backdrop. Declared up here because ShowCopy (rendering section)
-- uses it too: a later `local` would be invisible there and resolve to a nil global.
local BACKDROP = {
	bgFile = "Interface\\Tooltips\\UI-Tooltip-Background",
	edgeFile = "Interface\\Tooltips\\UI-Tooltip-Border",
	tile = true, tileSize = 16, edgeSize = 16,
	insets = { left = 4, right = 4, top = 4, bottom = 4 },
}

-- The assistant bubble is labelled with the agent that wrote it (see AgentName).
local Q = {}
Q.CHAT_PAGE = 16

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

local function Link(action, arg, label, hex)
	return "|H" .. LINK_PREFIX .. action .. (arg and (":" .. arg) or "") .. "|h|cff" .. (hex or "7ec8ff") .. "[" .. Display(label) .. "]|r|h"
end
ClaudeWoW.Link = Link

local function Flat(s)
	return (Display(s):gsub("%s*\n%s*", " "))
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
	return Cli.ProjectOf(c)
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

function Cli.ChatPlugin(c)
	if not c then return "" end
	if c.liveTarget and c.liveTarget ~= "" then return LIVE_PLUGIN end
	if c.plugin and c.plugin ~= "" then return c.plugin end
	if c.cwd and c.cwd ~= "" then return "claude-code" end
	return ""
end

function ClaudeWoW.FolderOf(rule)
	if type(rule) ~= "string" then return nil end
	return rule:match("^AddDir%((.+)%)$")
end

function ClaudeWoW.GrantLabel(rule)
	local dir = ClaudeWoW.FolderOf(rule)
	return dir and ("folder " .. dir) or tostring(rule)
end

function ClaudeWoW.GrantsLabel(rules)
	local labels = {}
	for i, rule in ipairs(rules or {}) do labels[i] = ClaudeWoW.GrantLabel(rule) end
	return table.concat(labels, ", ")
end

function ClaudeWoW.SplitGrants(rules)
	local commands, dirs = {}, {}
	for _, rule in ipairs(rules or {}) do
		local dir = ClaudeWoW.FolderOf(rule)
		if dir then table.insert(dirs, dir) else table.insert(commands, rule) end
	end
	return commands, dirs
end

function Cli.ChatDirs(c, extra)
	local dirs = {}
	for _, list in ipairs({ type(c.addDirs) == "table" and c.addDirs or {}, type(extra) == "table" and extra or {} }) do
		for _, dir in ipairs(list) do
			if not Contains(dirs, dir) then table.insert(dirs, dir) end
		end
	end
	return dirs
end

function Cli.AddChatDirs(c, dirs)
	local left = {}
	for _, dir in ipairs(dirs or {}) do
		c.addDirs = c.addDirs or {}
		if not Contains(c.addDirs, dir) then
			if #c.addDirs < Cli.ADD_DIRS_MAX then table.insert(c.addDirs, dir) else table.insert(left, dir) end
		end
	end
	if c.addDirs and #c.addDirs == 0 then c.addDirs = nil end
	return left
end

function Cli.ChatOptionTokens(c, extraDirs)
	local tokens = {}
	if c.model and c.model ~= "" then table.insert(tokens, "model=" .. c.model) end
	if c.effort and c.effort ~= "" then table.insert(tokens, "effort=" .. c.effort) end
	if c.permissionMode and c.permissionMode ~= "" then table.insert(tokens, "pm=" .. c.permissionMode) end
	local dirs = Cli.ChatDirs(c, extraDirs)
	if #dirs > 0 then table.insert(tokens, "dirs=" .. ToHex(table.concat(dirs, "\31"))) end
	if c.resumeId and c.resumeId ~= "" then table.insert(tokens, "resume=" .. c.resumeId) end
	if c.liveTarget and c.liveTarget ~= "" then table.insert(tokens, "live=" .. ToHex(c.liveTarget)) end
	return tokens
end

local function HasUserMessage(c)
	for _, m in ipairs(c.history or {}) do
		if m.role == "user" then return true end
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
	local current = ActiveChat()
	if current and current.quiet then current = nil end
	local c = {
		id = NewId(),
		name = name or ("Chat " .. (#db.chats + 1)),
		cwd = cwd or DEFAULT_CWD,
		agent = (current and current.agent) or "",
		plugin = "",
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

function ClaudeWoW.RepairQuietChats(data)
	local quietPlugins = {}
	local active, firstUserChat
	for _, c in ipairs(data.chats) do
		if c.quiet and c.plugin ~= "" then quietPlugins[c.plugin] = true end
		if c.id == data.activeChat then active = c end
		if not c.quiet and not firstUserChat then firstUserChat = c end
	end
	for _, c in ipairs(data.chats) do
		if not c.quiet and quietPlugins[c.plugin] then c.plugin = "" end
	end
	if active and active.quiet and firstUserChat then data.activeChat = firstUserChat.id end
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
	ClaudeWoW.RepairQuietChats(db)
	if FindChat(db.activeChat).quiet then db.activeChat = AddChat().id end
	ClaudeWoW.MigrateWhisper(s, fresh)
	if s.dim == nil then s.dim = Cli.DIM_DEFAULT end
	if s.dodge == nil then s.dodge = true end
	if s.autohide == nil then s.autohide = true end
	if fresh and s.shown == nil then s.shown, s.minimized = true, true end
end

function ClaudeWoW.LastWhisperChoice(chats)
	local latest, choice = -1, nil
	for _, c in ipairs(chats or {}) do
		for i, m in ipairs(c.history or {}) do
			if m.role == "system" and type(m.text) == "string" then
				local said = (m.text:match("^Whisper tabs are ON") and "on") or (m.text:match("^Whisper tabs are off") and "off") or nil
				local at = (tonumber(m.t) or 0) + i / 1000
				if said and at >= latest then latest, choice = at, said end
			end
		end
	end
	return choice
end

function ClaudeWoW.MigrateWhisper(s, fresh)
	if s.whisperV2 then
		if s.whisper == nil then s.whisper = true end
		return
	end
	s.whisperV2 = true
	if s.whisper == true then
		s.whisperChoice = "on"
		return
	end
	if s.whisper == false and not fresh and ClaudeWoW.LastWhisperChoice(db.chats) == "off" then
		s.whisperChoice = "off"
		return
	end
	s.whisper = true
	if not fresh then s.whisperNews = true end
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
	local report = Presence.Report and Presence.Report() or ""
	if report ~= "" then flags = flags == "" and report or (flags .. ";" .. report) end
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

local function TellPlayer(msg)
	local c = ActiveChat()
	if c then AddHistory(c, "system", msg) end
	if not (c and Whisper.Active() and Whisper.System(c, msg, true)) then print("|cff66ccff[Claude WoW]|r " .. msg) end
	if ui.frame then ClaudeWoW.Render() end
end

ClaudeWoW.ChatLog = { MISSES_BEFORE_PAUSE = 2, RETRY_SECONDS = 8, SLOW_RETRY_SECONDS = 15, ACK_POLL_SECONDS = 4, FIRST_PAUSE_SECONDS = 600, MAX_PAUSE_SECONDS = 3600 }

function ClaudeWoW.ChatLog.RetrySeconds()
	local L = ClaudeWoW.ChatLog
	if ClaudeWoW.PresenceWorks() and not run.signalUnreliable then return L.RETRY_SECONDS end
	return L.SLOW_RETRY_SECONDS
end

function ClaudeWoW.ChatLog.Paused()
	local pause = run.chatlogPause
	return pause ~= nil and GetTime() - pause.at < pause.wait
end

function ClaudeWoW.ChatLog.Pause(reason)
	local L = ClaudeWoW.ChatLog
	local earlier = run.chatlogPause
	local wait = earlier and math.min(earlier.wait * 2, L.MAX_PAUSE_SECONDS) or L.FIRST_PAUSE_SECONDS
	run.chatlogPause = { at = GetTime(), wait = wait, reason = reason }
	run.chatlogMisses = 0
	return wait, earlier == nil
end

function ClaudeWoW.ChatLog.Resume()
	run.chatlogPause = nil
	run.chatlogMisses = 0
end

function ClaudeWoW.ChatLog.Spec(data)
	local spec = type(data) == "table" and data.chatlog
	if type(spec) ~= "table" or type(spec.line) ~= "number" or type(spec.filler) ~= "number" then return nil end
	local line, filler = math.floor(spec.line), math.floor(spec.filler)
	if line < 60 or line > 940 or filler < 0 or filler > 65536 then return nil end
	local key = spec.key
	if type(key) ~= "string" or #key ~= 32 or key:find("[^0-9a-f]") then return nil end
	return { line = line, filler = filler, key = key, show = spec.show == true or nil }
end

function ClaudeWoW.ChatLog.Same(a, b)
	if a == nil or b == nil then return a == b end
	return a.line == b.line and a.filler == b.filler and a.key == b.key and a.show == b.show
end

function ClaudeWoW.ChatLog.Mode()
	return db ~= nil and db.settings.mode == "pixel" and db.settings.transport == "screenshot"
		and type(db.settings.chatlog) == "table" and type(db.settings.chatlog.key) == "string" and not ClaudeWoW.ChatLog.Paused()
		and type(SendSystemMessage) == "function" and type(LoggingChat) == "function"
end

function ClaudeWoW.ChatLog.Fits(records)
	for _, rec in ipairs(records) do
		if (rec.tries or 1) > 1 then return false end
		if (";" .. (rec.flags or "") .. ";"):find(";v;", 1, true) then return false end
	end
	return true
end

function ClaudeWoW.ChatLog.Hide(_, _, msg, ...)
	if type(msg) ~= "string" or msg:sub(1, #Codec.LOG_TAG + 1) ~= Codec.LOG_TAG .. " " then return false end
	local spec = db and db.settings.chatlog
	if type(spec) ~= "table" or not spec.show then return true end
	local keyless = msg:gsub("^(%S+) %x+ (%d+ %d+/%d+ )", "%1 ... %2", 1)
	return false, keyless, ...
end

function ClaudeWoW.ChatLog.InstallFilter()
	local L = ClaudeWoW.ChatLog
	if L.filtered then return end
	local add = (type(ChatFrameUtil) == "table" and ChatFrameUtil.AddMessageEventFilter) or ChatFrame_AddMessageEventFilter
	if type(add) == "function" then L.filtered = pcall(add, "CHAT_MSG_SYSTEM", L.Hide) end
end

function ClaudeWoW.ChatLog.Write(id, payload, kind)
	local spec = db.settings.chatlog
	local ok, err = pcall(function()
		if not LoggingChat() then LoggingChat(true) end
		ClaudeWoW.ChatLog.InstallFilter()
		local lines = Codec.LogLines(id, payload, spec.line, spec.filler, spec.key)
		for i = 1, #lines do SendSystemMessage(lines[i]) end
		run.chatlogStats = run.chatlogStats or { frames = 0, lines = 0, acked = 0, late = 0, gs = 0 }
		if kind == "gs" then
			run.chatlogStats.gs = run.chatlogStats.gs + 1
		else
			run.chatlogStats.frames = run.chatlogStats.frames + 1
		end
		run.chatlogStats.lines = run.chatlogStats.lines + #lines
	end)
	if not ok then
		ClaudeWoW.ChatLog.Pause("error: " .. tostring(err))
	end
	return ok
end

function ClaudeWoW.ChatLog.Acked(rec)
	if not rec.logged then return end
	local stats = run.chatlogStats
	if (rec.tries or 1) == 1 then
		if stats then stats.acked = stats.acked + 1 end
		ClaudeWoW.ChatLog.Resume()
		return
	end
	if stats then stats.late = stats.late + 1 end
	run.chatlogMisses = (run.chatlogMisses or 0) + 1
	if run.chatlogPause or run.chatlogMisses >= ClaudeWoW.ChatLog.MISSES_BEFORE_PAUSE then
		local wait, first = ClaudeWoW.ChatLog.Pause("the bridge read the last message only from the screenshot retry")
		if first then
			TellPlayer("the bridge did not read the chat log in time. Messages go out by screenshot; the chat log is tried again in " .. FmtDur(wait) .. ".")
		end
	end
end

function ClaudeWoW.ChatLog.Status()
	local s = db.settings
	if type(s.chatlog) ~= "table" then return "chat log transport: off (the bridge did not ask for it)" end
	local stats = run.chatlogStats
	local pause = run.chatlogPause
	local state = ClaudeWoW.ChatLog.Mode() and (pause and "on trial after a pause" or "on") or "unavailable in this client"
	if ClaudeWoW.ChatLog.Paused() then
		state = "PAUSED, next try in " .. FmtDur(pause.wait - (GetTime() - pause.at)) .. " (" .. tostring(pause.reason) .. ")"
	end
	return string.format("chat log transport: %s, lines of %d, filler %d bytes%s%s",
		state,
		s.chatlog.line, s.chatlog.filler,
		s.chatlog.show and ", lines shown in chat" or "",
		stats and string.format("; %d frames, %d lines written, %d acknowledged first time, %d only after the screenshot retry, %d game state frames", stats.frames, stats.lines, stats.acked, stats.late, stats.gs) or "")
end

local Tm = {}

function Tm.Settle(outcome, rec)
	local telemetry = ClaudeWoWTelemetry
	if rec and type(telemetry) == "table" and type(telemetry[outcome]) == "function" then pcall(telemetry[outcome], rec) end
end

function Tm.CallOff()
	if run.shot and not run.shot.fired then
		Tm.Settle("Lost", run.shot.telemetry)
		run.shot = nil
	end
end

local ShotStatus = { hooked = {} }

function ShotStatus.Frames()
	local out = {}
	if _G.ActionStatus then table.insert(out, _G.ActionStatus) end
	if WorldFrame and WorldFrame.GetChildren then
		for _, child in ipairs({ WorldFrame:GetChildren() }) do
			if child ~= _G.ActionStatus and child.GetName and child:GetName() == "ActionStatus" then table.insert(out, child) end
		end
	end
	return out
end

function ShotStatus.Quiet(gen)
	run.quietShot = gen
	for _, frame in ipairs(ShotStatus.Frames()) do
		if not ShotStatus.hooked[frame] and frame.HookScript then
			ShotStatus.hooked[frame] = true
			frame:HookScript("OnShow", function(self)
				if run.quietShot then self:Hide() end
			end)
		end
	end
end

function ShotStatus.End(gen)
	C_Timer.After(0, function()
		if run.quietShot == gen then run.quietShot = nil end
	end)
end

-- ok = true (SCREENSHOT_SUCCEEDED), false (SCREENSHOT_FAILED or the call raised),
-- nil (no event within SHOT_TIMEOUT: the file may or may not exist).
local function ScreenshotDone(ok, fromEvent)
	local shot = run.shot
	if fromEvent and run.staleShotUntil then
		run.staleShotUntil = nil
		if run.staleShotGen then ShotStatus.End(run.staleShotGen) end
		run.staleShotGen = nil
		if not (shot and shot.fired) then return end
	end
	if not shot or (fromEvent and not shot.fired) then return end
	run.shot = nil
	if ok == nil then
		run.staleShotUntil = GetTime() + SHOT_TIMEOUT
		run.staleShotGen = shot.gen
	else
		ShotStatus.End(shot.gen)
	end
	HideStrip()
	Tm.Settle(ok == true and "Delivered" or "Lost", shot.telemetry)
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
		if run.staleShotUntil and GetTime() < run.staleShotUntil then return end
		if run.staleShotGen then ShotStatus.End(run.staleShotGen) end
		run.staleShotUntil, run.staleShotGen = nil, nil
		self:SetScript("OnUpdate", nil)
		shot.fired = true
		ShotStats().taken = ShotStats().taken + 1
		pcall(ShotStatus.Quiet, gen)
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

function Tm.Record(room, solo)
	local telemetry = ClaudeWoWTelemetry
	if type(telemetry) ~= "table" or type(telemetry.Take) ~= "function" then return nil end
	if room <= 0 or ShotsPaused(true) or run.shotOverride then return nil end
	local ok, rec = pcall(telemetry.Take, room, solo)
	if ok and type(rec) == "string" and rec ~= "" and #rec <= room then return rec end
	return nil
end

function ClaudeWoW.TelemetryShot()
	if not db or not ScreenshotMode() or run.shot then return end
	RefreshStrip()
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
		if run.shot and not run.shot.solo then Tm.CallOff() end
		if not run.shot and ClaudeWoW.ChatLog.Mode() then
			HideStrip()
			local solo = Tm.Record(Codec.MAX_PAYLOAD, true)
			if solo then Tm.Settle(ClaudeWoW.ChatLog.Write(0, solo, "gs") and "Delivered" or "Lost", solo) end
			return
		end
		if not run.shot then
			local solo = ScreenshotMode() and Tm.Record(Codec.MAX_PAYLOAD, true)
			if solo then
				ShowStrip(0, solo)
				TakeScreenshot()
				run.shot.telemetry = solo
				run.shot.solo = true
				return
			end
			HideStrip()
		end
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
	if ClaudeWoW.ChatLog.Mode() and ClaudeWoW.ChatLog.Fits(included) then
		local unsent = false
		for _, rec in ipairs(included) do
			if not rec.shot then unsent = true end
		end
		local rider = unsent and Tm.Record(Codec.MAX_PAYLOAD - size - 1, false) or nil
		if rider then table.insert(parts, rider) end
		local written = unsent and ClaudeWoW.ChatLog.Write(latest, table.concat(parts, RS))
		Tm.Settle(written and "Delivered" or "Lost", rider)
		if rider and not written then table.remove(parts) end
		if not unsent or written then
			Tm.CallOff()
			if not run.shot then HideStrip() end
			if unsent then
				for _, rec in ipairs(included) do
					rec.shot = "log"
					rec.logged = true
					rec.loggedAt = GetTime()
					if (rec.forget or rec.cancelOf) and not run.helloPollAt and not run.ackPollAt then
						run.ackPollAt = GetTime() + ClaudeWoW.ChatLog.ACK_POLL_SECONDS
					end
				end
			end
			return
		end
	end
	if not ScreenshotMode() then
		-- A shot still counting frames (the transport just changed) is called off.
		Tm.CallOff()
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
		Tm.CallOff()
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
	local retry = false
	for _, rec in ipairs(included) do
		if (rec.tries or 1) > 1 or rec.shotFails then retry = true end
	end
	local room = Codec.MAX_PAYLOAD - size - 1
	local waiting = run.shot and not run.shot.fired and run.shot.telemetry
	local keep = waiting and not retry and #waiting <= room
	if waiting and not keep then Tm.Settle("Lost", waiting) end
	local rider = keep and waiting or (not retry and Tm.Record(room, false)) or nil
	if rider then table.insert(parts, rider) end
	ShowStrip(latest, table.concat(parts, RS))
	local gen = TakeScreenshot()
	run.shot.telemetry = rider
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
	local logSpec = ClaudeWoW.ChatLog.Spec(data)
	if db.settings.transport == t and sameLevels and ClaudeWoW.ChatLog.Same(logSpec, db.settings.chatlog) then return end
	db.settings.transport = t
	db.settings.stripLevels = lv
	if not ClaudeWoW.ChatLog.Same(logSpec, db.settings.chatlog) then ClaudeWoW.ChatLog.Resume() end
	db.settings.chatlog = logSpec
	SyncScreenshotMode()
	-- Whatever is still unacknowledged goes out again the new way.
	for _, rec in pairs(run.outbound) do rec.shot = nil end
	RefreshStrip()
	ClaudeWoW.UpdateStatus()
end

---------------------------------------------------------------------------
-- Signals and slots (in)
---------------------------------------------------------------------------

local signalAvailable = type(PlaySoundFile) == "function"
local signalStats = { checks = 0, hits = 0, lastHit = nil }

function Presence.Probe(path)
	if not signalAvailable or not db.settings.signal then return nil end
	signalStats.checks = signalStats.checks + 1
	local ok, willPlay, handle = pcall(PlaySoundFile, path, "Master")
	if not ok then
		signalAvailable = false
		signalStats.error = tostring(willPlay)
		return nil
	end
	if willPlay and handle then pcall(StopSound, handle) end
	if willPlay then
		signalStats.hits = signalStats.hits + 1
		signalStats.lastHit = GetTime()
	end
	return willPlay and true or false
end

local function SoundValid(path)
	return Presence.Probe(path) == true
end

function Presence.Fired(path)
	return Presence.Probe(path) == false
end

local function CheckSignal(kind, id)
	if run.signalUnreliable then return false end
	return Presence.Fired(string.format("Interface\\AddOns\\ClaudeWoW\\%s\\%03d.wav", kind, SlotNumber(id)))
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

local function ActPath(id, k)
	return string.format("Interface\\AddOns\\ClaudeWoW\\act\\%03d\\%02d.wav", SlotNumber(id), k)
end

local function StartActivity(chat, id)
	local a = { next = 1, count = 0, startedAt = GetTime() }
	if Presence.Fired(ActPath(id, 1)) then a.unreliable = true end
	run.act = run.act or {}
	run.act[chat.id] = a
end

local function PollActivity(chat)
	local a = run.act and run.act[chat.id]
	if not a or a.unreliable or not chat.pendingId then return false end
	local moved = false
	for _ = 1, 3 do
		if a.next > ACT_MAX then break end
		if not Presence.Fired(ActPath(chat.pendingId, a.next)) then break end
		a.count = a.count + 1
		a.next = a.next + 1
		a.last = GetTime()
		moved = true
	end
	return moved
end

local function NotedBridge(at)
	at = at or GetTime()
	if not run.bridgeSeen or at > run.bridgeSeen then run.bridgeSeen = at end
	run.pixelFailed = nil
end

local function PresencePath(ring, k)
	return string.format("Interface\\AddOns\\ClaudeWoW\\presence\\%s\\%04d.wav", ring, k)
end

local function FindPresenceHead(ring)
	local lo, hi = 1, PRESENCE_MAX + 1
	while lo < hi do
		local mid = math.floor((lo + hi) / 2)
		if SoundValid(PresencePath(ring, mid)) then hi = mid else lo = mid + 1 end
	end
	return lo
end

function Presence.Channel()
	return signalAvailable and db ~= nil and db.settings.signal and true or false
end

function Presence.State()
	if run.presence then return run.presence end
	local p = { heads = {}, loginHeads = {}, staleRing = {}, beats = 0, test = "pending" }
	for _, ring in ipairs(Presence.RINGS) do
		p.heads[ring] = FindPresenceHead(ring)
		p.loginHeads[ring] = p.heads[ring]
	end
	run.presence = p
	return p
end

function Presence.Passed(p, why)
	if p.test == "passed" then return end
	p.test = "passed"
	p.testWhy = why
	p.testAt = GetTime()
end

local function PollPresence(limit)
	if not Presence.Channel() then return end
	local p = Presence.State()
	for _, ring in ipairs(Presence.RINGS) do
		for _ = 1, limit or 3 do
			local k = p.heads[ring]
			if k > PRESENCE_MAX or not Presence.Fired(PresencePath(ring, k)) then break end
			p.heads[ring] = k + 1
			p.beats = p.beats + 1
			p.lastBeat = GetTime()
			Presence.Passed(p, "a launch-time file read missing after the bridge deleted it")
			NotedBridge()
		end
	end
end

function Presence.Check(info, bridgeNow)
	if type(info) ~= "table" or type(info.ring) ~= "string" or type(info.at) ~= "number" then return end
	run.bridgePresence = info
	if not Presence.Channel() then return end
	local p = Presence.State()
	PollPresence(PRESENCE_MAX)
	local head = p.heads[info.ring]
	if not head then return end
	if head <= info.at then
		if p.test ~= "passed" then
			p.test = "failed"
			p.testWhy = "presence/" .. info.ring .. string.format("/%04d.wav", head) .. " still reads present after the bridge deleted it"
			p.testAt = GetTime()
		else
			p.staleRing[info.ring] = "a file the bridge deleted still reads present"
		end
	elseif head > PRESENCE_MAX and info.at < PRESENCE_MAX then
		p.staleRing[info.ring] = "the bridge beats on files this client did not see at launch"
	elseif p.test == "passed" and type(bridgeNow) == "number" and time() - bridgeNow < 90
		and GetTime() - (p.lastBeat or p.testAt or GetTime()) > Presence.STALL_SECONDS then
		p.staleRing[info.ring] = "the bridge is up but its beats stopped reaching this client"
	end
	if type(info.probe) == "string" and run.lateProbe and info.probe == run.lateProbe.token and run.lateProbe.result == nil then
		run.lateProbe.result = SoundValid("Interface\\AddOns\\ClaudeWoW\\ctl\\probe-" .. info.probe .. ".wav") and "seen" or "unseen"
	end
end

local function PresenceWorks()
	if not Presence.Channel() then return false end
	local p = run.presence
	if not p or p.test ~= "passed" then return false end
	local current = run.bridgePresence and run.bridgePresence.ring
	if current and p.staleRing[current] then return false end
	for _, ring in ipairs(Presence.RINGS) do
		if p.heads[ring] <= PRESENCE_MAX and not p.staleRing[ring] then return true end
	end
	return false
end

ClaudeWoW.PresenceWorks = PresenceWorks
ClaudeWoW.Presence = Presence

function Presence.Scheme()
	if not Presence.Channel() then return "slot polls only (sound channel unusable)" end
	local p = run.presence
	if not p then return "not started" end
	if p.test == "failed" then return "slot polls only (self-test failed: " .. tostring(p.testWhy) .. ")" end
	if p.test ~= "passed" then
		local seen = false
		for _, ring in ipairs(Presence.RINGS) do
			if p.loginHeads[ring] <= PRESENCE_MAX then seen = true end
		end
		if not seen then return "slot polls only (no presence file existed when the game started: run setup, then restart WoW)" end
		return "slot polls until the self-test passes (pending: waiting for a bridge-driven deletion)"
	end
	if PresenceWorks() then return "beats (self-test passed: " .. tostring(p.testWhy) .. ")" end
	local current = run.bridgePresence and run.bridgePresence.ring
	local why = current and p.staleRing[current]
	return "slot polls only (self-test passed, but " .. (type(why) == "string" and why or "no presence ring this client can see is left") .. ": restart WoW)"
end

function Presence.Report()
	local out = {}
	local p = run.presence
	if p and (p.test == "passed" or p.test == "failed") then table.insert(out, "pt=" .. p.test) end
	if run.lateProbe and run.lateProbe.result then table.insert(out, "lc=" .. run.lateProbe.result) end
	return table.concat(out, ";")
end

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
		Presence.State()
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
			if quiet > 120 then s = s .. " (quiet for a while - stuck? /claude cancel)" end
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
	if limit > 0 then return "warning at " .. FmtTokens(limit) .. " tokens (/claude config context <n> to change, 0 = off)" end
	return "warning off (/claude config context <n> turns it on)"
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
		.. "Said once per crossing. /claude config context <n> moves the mark, /claude config context 0 turns it off."
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
	ClaudeWoW.ChatLog.Acked(rec)
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

function ClaudeWoW.ApplyAcks(acks)
	if type(acks) ~= "table" or not db then return false end
	local any = false
	for _, a in ipairs(acks) do
		local rec = type(a) == "table" and a.session == db.session and run.outbound[a.id]
		if rec and not rec.acked then
			NoteAcked(rec)
			any = true
		end
	end
	if any then NotedBridge() end
	return any
end

-- Dispatch a list of reply records to the chats waiting for them.
local function ApplyReplies(replies)
	local matched = false
	for _, r in ipairs(replies or {}) do
		local c = FindChat(r.chat)
		if c and c.titleFor and (tonumber(r.titleFor) or r.id) == c.titleFor and type(r.title) == "string" and r.title ~= "" then
			c.name = r.title
			c.titleFor = nil
			Whisper.Retitle(c)
		end
		if c and r.late == true then
			if r.status == "done" and r.id ~= c.pendingId and (tonumber(c.lateSeen) or 0) < (tonumber(r.id) or 0) then
				c.lateSeen = r.id
				ClaudeWoW.LateReply(c, r)
			end
		elseif c and c.pendingId and r.id == c.pendingId then
			matched = true
			MarkAcked(r.id)
			local denied = type(r.denied) == "table" and #r.denied > 0 and r.denied or nil
			if r.status == "done" or r.status == "error" then
				NoteUsage(c, r)
				if c.adoptCwd and type(r.cwd) == "string" and r.cwd ~= "" then c.cwd = r.cwd end
				if type(r.session) == "string" and r.session ~= "" then c.session = r.session end
				c.adoptCwd, c.resumeId = nil, nil
			end
			if r.status == "done" then
				Finish(c, "assistant", r.text or "", denied, r.agent, r.summary, ClaudeWoW.CleanMacros(r.macros))
			elseif r.status == "error" then
				if r.lateOk == true then
					run.lateWait = run.lateWait or {}
					run.lateWait[c.id] = { id = r.id, since = GetTime(), step = 1 }
				end
				Finish(c, "system", "Bridge error: " .. tostring(r.text), denied)
			elseif r.status == "working" then
				if ClaudeWoWVoice then ClaudeWoWVoice.Started(r.id) end
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
		if type(rc) == "table" and rc.id and not FindChat(rc.id) and not db.forget[rc.id] then
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
		if data.cancel == true then run.bridgeCancel = true end
		if type(data.agent) == "string" and data.agent ~= "" then run.bridgeAgent = data.agent end
		if type(data.agents) == "table" and #data.agents > 0 then run.bridgeAgents = data.agents end
		if type(data.plugin) == "string" and data.plugin ~= "" then run.bridgePlugin = data.plugin end
		if type(data.plugins) == "table" and #data.plugins > 0 then run.bridgePlugins = data.plugins end
		ClaudeWoW.ApplyLive(data.live)
		ClaudeWoW.ApplySessions(data.sessions, data.now)
		local acked = ClaudeWoW.ApplyAcks(data.acks)
		ApplyTransport(data)
		if acked then RefreshStrip() end
		Presence.Check(data.presence, data.now)
	end
	local matched = ApplyReplies(type(data) == "table" and data.replies or nil)
	if type(data) == "table" and data.restore then ImportRestore(data.restore) end
	if type(data) == "table" and data.map and ClaudeWoWMap then ClaudeWoWMap.Sync(data.map) end
	if type(data) == "table" and data.achievements and ClaudeWoWAchievements then ClaudeWoWAchievements.Sync(data.achievements, data.now) end
	if type(data) == "table" and data.goals and ClaudeWoWOrders then ClaudeWoWOrders.SyncSlot(data.goals, data.now) end
	if type(data) == "table" and data.widgets and ClaudeWoWWidgets then ClaudeWoWWidgets.Sync(data.widgets) end
	if type(data) == "table" and ClaudeWoWTelemetry then ClaudeWoWTelemetry.Sync(data.gs) end
	if why == "signal" and not matched then
		run.signalUnreliable = true
	end
	ClaudeWoW.Render()
end

local LATE_POLLS = { 10, 20, 30, 45, 60, 90, 120, 180, 240, 300 }

local function PollLate(now)
	for chatId, w in pairs(run.lateWait or {}) do
		local due = LATE_POLLS[w.step]
		if not due or not FindChat(chatId) then
			run.lateWait[chatId] = nil
		elseif now - w.since >= due then
			w.step = w.step + 1
			TryLoadSlot("late")
			return
		end
	end
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
	elseif PresenceWorks() and db.settings.mode == "pixel" and not AnyPending()
		and now - (run.presence.lastBeat or run.presence.testAt or now) > Presence.STALL_SECONDS
		and now - (run.lastPresenceCheck or -1e9) >= IDLE_POLL_SECONDS then
		run.lastPresenceCheck = now
		TryLoadSlot("presence")
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
	if run.ackPollAt and now >= run.ackPollAt then
		run.ackPollAt = nil
		if not ClaudeWoW.PresenceWorks() then TryLoadSlot("ack") end
	end
	if run.restoring and now - run.restoring > 25 then
		run.restoring = nil
		ClaudeWoW.Render()
	end
	for id, rec in pairs(run.outbound) do
		if rec.staleAck and not CheckSignal("ack", id) then rec.staleAck = nil end
		if not rec.acked and not rec.staleAck and CheckSignal("ack", id) then
			NoteAcked(rec)
			changed = true
			NotedBridge()
			if (rec.text or "") ~= "" and ClaudeWoWVoice then ClaudeWoWVoice.Started(id) end
			if rec.hello and run.lateProbe and not run.lateProbe.result then run.helloPollAt = now + 1 end
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
		elseif rec.shot == "log" and now - (rec.loggedAt or rec.sentAt) >= ClaudeWoW.ChatLog.RetrySeconds() then
			rec.tries = (rec.tries or 1) + 1
			rec.sentAt = now
			rec.shot = nil
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
	if not AnyPending() then
		PollLate(now)
		return
	end
	local moved = false
	for _, c in ipairs(db.chats) do
		if c.pendingId and PollActivity(c) then moved = true end
	end
	if moved then ClaudeWoW.Render() end
	for _, c in ipairs(db.chats) do
		if c.pendingId and run.staleSig and run.staleSig[c.pendingId] and not CheckSignal("sig", c.pendingId) then run.staleSig[c.pendingId] = nil end
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
	if inbox.cancel == true then run.bridgeCancel = true end
	if type(inbox.agent) == "string" and inbox.agent ~= "" then run.bridgeAgent = inbox.agent end
	if type(inbox.agents) == "table" and #inbox.agents > 0 then run.bridgeAgents = inbox.agents end
	if type(inbox.plugin) == "string" and inbox.plugin ~= "" then run.bridgePlugin = inbox.plugin end
	if type(inbox.plugins) == "table" and #inbox.plugins > 0 then run.bridgePlugins = inbox.plugins end
	ClaudeWoW.ApplyLive(inbox.live)
	ClaudeWoW.ApplySessions(inbox.sessions, inbox.now)
	ApplyTransport(inbox)
	ApplyReplies(inbox.replies)
	if inbox.restore then ImportRestore(inbox.restore) end
	if inbox.map and ClaudeWoWMap then ClaudeWoWMap.Sync(inbox.map) end
	if inbox.achievements and ClaudeWoWAchievements then ClaudeWoWAchievements.Sync(inbox.achievements, inbox.now) end
	if inbox.goals and ClaudeWoWOrders then ClaudeWoWOrders.SyncInbox(inbox.goals, inbox.now) end
	if inbox.widgets and ClaudeWoWWidgets then ClaudeWoWWidgets.Sync(inbox.widgets) end
	if ClaudeWoWTelemetry then ClaudeWoWTelemetry.SyncInbox(inbox.gs, inbox.now) end
end

local quietReplyHandlers = {}

function ClaudeWoW.OnQuietReply(plugin, handler)
	quietReplyHandlers[plugin] = handler
end

local function FinishQuiet(chat, role, text)
	chat.pendingId = nil
	chat.progress = nil
	if run.act then run.act[chat.id] = nil end
	NotedBridge()
	if not AnyPending() then keyCatcher:Hide() end
	local handler = quietReplyHandlers[chat.plugin]
	if handler then pcall(handler, chat, role, text) end
end

Finish = function(chat, role, text, denied, agent, summary, macros)
	if chat.quiet then return FinishQuiet(chat, role, text) end
	local msgId = chat.pendingId
	AddHistory(chat, role, text, msgId, denied, agent, macros)
	chat.pendingId = nil
	chat.progress = nil
	ContextWarning(chat)
	if run.act then run.act[chat.id] = nil end
	NotedBridge()
	local visible = ui.frame and ui.frame:IsShown() and db.activeChat == chat.id
	if not visible and not Whisper.Active() then
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
	if denied and ClaudeWoW.LootRollEnabled() then ClaudeWoWRoll.Offer(chat.id) end
	ClaudeWoW.Notify(chat, text, agent, summary, role, denied, msgId, macros)
	if chat.draft and chat.draft ~= "" and not visible then
		Whisper.System(chat, "Waiting to go: " .. Flat(chat.draft) .. "  " .. Link("send", chat.id, "send it", "55ff55"), false, true)
	end
end

function ClaudeWoW.LateReply(chat, r)
	local text = type(r.text) == "string" and r.text or ""
	local agent = type(r.agent) == "string" and r.agent ~= "" and r.agent or nil
	if run.lateWait then run.lateWait[chat.id] = nil end
	AddHistory(chat, "assistant", text, r.id, nil, agent)
	local visible = ui.frame and ui.frame:IsShown() and db.activeChat == chat.id
	if not visible and not Whisper.Active() then chat.unread = (chat.unread or 0) + 1 end
	ClaudeWoW.Render()
	ClaudeWoW.Notify(chat, text, agent, r.summary, "assistant", nil, r.id, nil)
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
	return (function(ok, ...)
		if ok then return ... end
	end)(pcall(fn, ...))
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
ClaudeWoW.PROFESSION_SKILL_IDS = PROFESSION_SKILL_IDS

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

function ClaudeWoW.ActiveTraitConfigID()
	local specGroup = Try(C_SpecializationInfo and C_SpecializationInfo.GetActiveSpecGroup)
	if type(specGroup) ~= "number" then return nil end
	local configID = Try(C_SpecializationInfo.GetCombatConfigIDForSpecGroup, specGroup)
	if type(configID) == "number" then return configID end
end

function ClaudeWoW.TraitTalentTrees()
	if not C_Traits then return {} end
	local configID = ClaudeWoW.ActiveTraitConfigID()
	if not configID then return {} end
	local config = Try(C_Traits.GetConfigInfo, configID)
	local treeID = type(config) == "table" and type(config.treeIDs) == "table" and config.treeIDs[1]
	if type(treeID) ~= "number" then return {} end
	local displays = Try(C_Traits.GetGroupDisplayInfoByTreeID, treeID)
	if type(displays) ~= "table" then return {} end
	local groupIDs = {}
	for _, display in ipairs(displays) do
		if type(display) == "table" and type(display.groupID) == "number" then table.insert(groupIDs, display.groupID) end
	end
	local currencies = Try(C_Traits.GetGroupCurrencyInfo, configID, groupIDs)
	if type(currencies) ~= "table" then return {} end
	local spentByGroup = {}
	for _, group in ipairs(currencies) do
		local first = type(group) == "table" and type(group.traitNodeGroupID) == "number" and type(group.currencyInfos) == "table" and group.currencyInfos[1]
		if type(first) == "table" and type(first.spent) == "number" then spentByGroup[group.traitNodeGroupID] = first.spent end
	end
	if next(spentByGroup) == nil then return {} end
	local trees = {}
	for _, display in ipairs(displays) do
		if type(display) == "table" and type(display.displayName) == "string" and display.displayName ~= "" then
			table.insert(trees, { name = display.displayName, points = spentByGroup[display.groupID] or 0 })
		end
	end
	return trees
end

function ClaudeWoW.TabTalentTrees()
	local trees = {}
	local tabs = Try(GetNumTalentTabs)
	local specInfo = C_SpecializationInfo and C_SpecializationInfo.GetSpecializationInfo
	for i = 1, (type(tabs) == "number" and tabs or 0) do
		local tname, points
		if specInfo then
			local _, specName, _, _, _, _, spent = Try(specInfo, i)
			tname, points = specName, spent
		else
			tname, _, points = Try(GetTalentTabInfo, i)
		end
		if type(tname) == "string" and type(points) == "number" then
			table.insert(trees, { name = tname, points = points })
		end
	end
	return trees
end

function ClaudeWoW.TalentTrees()
	local trees = Try(ClaudeWoW.TraitTalentTrees)
	if type(trees) == "table" and #trees > 0 then return trees end
	trees = Try(ClaudeWoW.TabTalentTrees)
	return type(trees) == "table" and trees or {}
end

function ClaudeWoW.CharacterLine()
	local name = Try(UnitName, "player")
	if not name then return nil end
	local realm = Try(GetRealmName)
	local level = Try(UnitLevel, "player")
	local race = Try(UnitRace, "player")
	local class = Try(UnitClass, "player")
	local faction = Try(UnitFactionGroup, "player")
	local guild = Try(GetGuildInfo, "player")
	local who = tostring(name) .. (realm and (" on " .. tostring(realm)) or "")
	local desc = {}
	if level then table.insert(desc, "level " .. tostring(level)) end
	if race then table.insert(desc, tostring(race)) end
	if class then table.insert(desc, tostring(class)) end
	if #desc > 0 then who = who .. ", " .. table.concat(desc, " ") end
	if faction then who = who .. " (" .. tostring(faction) .. ")" end
	if guild then who = who .. ", guild <" .. tostring(guild) .. ">" end
	return who
end

function ClaudeWoW.GameContext()
	local lines = {}
	local version, build, _, toc = Try(GetBuildInfo)
	toc = tonumber(toc)
	local game = "World of Warcraft"
	if toc and toc >= 16000 and toc < 20000 then game = "World of Warcraft: Forever"
	elseif toc and toc >= 11500 and toc < 11600 then game = "World of Warcraft Classic" end
	local client = ""
	if version then
		client = " (client " .. tostring(version) .. (build and ("." .. tostring(build)) or "") .. (toc and (", interface " .. toc) or "") .. ")"
	end
	table.insert(lines, "Game: " .. game .. client)

	local who = ClaudeWoW.CharacterLine()
	if who then table.insert(lines, "Character: " .. who) end

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

	local trees = ClaudeWoW.TalentTrees()
	if #trees > 0 then
		local parts = {}
		for _, tree in ipairs(trees) do table.insert(parts, tree.name .. " " .. tree.points) end
		table.insert(lines, "Talents: " .. table.concat(parts, " / "))
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

local WHISPER_TEXT_MAX = 4000 -- characters of a reply written into the tab before it points at the window
local WHISPER_PROBE_NAME = "Cwowprobe" -- /aiwhisper leak whispers this nobody to prove the leak filter works
local WL = { SHORT_LINES = 8, SHORT_CHARS = 700, TLDR_LINES = 3, PREVIEW_LINES = 2, PROGRESS_MAX = 120, LINE_MAX = 300, BOOT_WAIT = 15, THROTTLE_SECONDS = 20, ELAPSED_STEP = 5, PULSE_SECONDS = 1 }
local PRE_SEND_EVENT = "ChatFrame.OnEditBoxPreSendText"
local preSendHooked = false
local whisperLive = setmetatable({}, { __mode = "k" })

local function WhisperOn()
	return db ~= nil and db.settings.whisper == true
end

function Whisper.Active()
	return WhisperOn() and preSendHooked and type(FCF_OpenTemporaryWindow) == "function"
end

local function WhisperColor(kind, r, g, b)
	local info = type(ChatTypeInfo) == "table" and ChatTypeInfo[kind]
	if type(info) == "table" and info.r then return info.r, info.g, info.b end
	return r, g, b
end

function Whisper.SystemColor()
	return WhisperColor("SYSTEM", 1, 1, 0)
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

function Whisper.Title(chat)
	if tostring(chat.name or ""):match("^Chat %d+$") then return ChatAgentName(chat) end
	return Display(chat.name)
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

function Whisper.Lines(frame, text, r, g, b)
	for line in (tostring(text) .. "\n"):gmatch("(.-)\n") do
		if line:match("%S") then WhisperWrite(frame, line, r, g, b) end
	end
end

function Whisper.CanEdit(frame)
	return type(frame.RemoveMessagesByPredicate) == "function"
end

function Whisper.DropLine(frame, text)
	if not Whisper.CanEdit(frame) then return false end
	return pcall(frame.RemoveMessagesByPredicate, frame, function(message) return message == text end) and true or false
end

function Whisper.Live(frame, key, text, r, g, b, force)
	if not frame then return nil end
	whisperLive[frame] = whisperLive[frame] or {}
	local slot = whisperLive[frame][key]
	if slot and slot.text == text then return "same" end
	if slot and not Whisper.CanEdit(frame) and not force and GetTime() - slot.at < WL.THROTTLE_SECONDS then return "throttled" end
	local how = "added"
	if slot and Whisper.DropLine(frame, slot.text) then how = "edited" end
	WhisperWrite(frame, text, r, g, b)
	whisperLive[frame][key] = { text = text, at = GetTime() }
	return how
end

function Whisper.EndLive(frame, key)
	local lines = frame and whisperLive[frame]
	local slot = lines and lines[key]
	if not slot then return end
	lines[key] = nil
	Whisper.DropLine(frame, slot.text)
end

function Whisper.Retitle(chat)
	local frame = run.whisperTabs and run.whisperTabs[chat.id]
	if not frame then return end
	local title = Whisper.Title(chat)
	if frame.claudewowTitle == title then return end
	frame.claudewowTitle = title
	local ok = type(FCF_SetWindowName) == "function" and pcall(FCF_SetWindowName, frame, title, true)
	if not ok then
		local tab = WhisperTab(frame)
		if tab and tab.SetText then pcall(tab.SetText, tab, title) end
	end
end

function Whisper.HookPreSend(handler)
	if preSendHooked then return true end
	if type(EventRegistry) ~= "table" or type(EventRegistry.RegisterCallback) ~= "function" then return false end
	preSendHooked = pcall(EventRegistry.RegisterCallback, EventRegistry, PRE_SEND_EVENT, handler, Whisper) and true or false
	return preSendHooked
end

local function WhisperAdopt(chat, frame)
	run.whisperTabs = run.whisperTabs or {}
	frame.claudewowChatId = chat.id
	frame.claudewowTarget = frame.claudewowTarget or ChatAgentName(chat)
	run.whisperTabs[chat.id] = frame
	Whisper.Retitle(chat)
	return frame
end

function Whisper.Welcome(chat, frame)
	local folder = FolderName(ChatFolder(chat))
	local where = folder ~= "" and ("coding in " .. Display(folder)) or "general chat"
	local r, g, b = Whisper.SystemColor()
	WhisperWrite(frame, ChatAgentName(chat) .. " - " .. where .. ". Type here and press Enter to talk; /claude help lists the commands; " .. Link("open", chat.id, "workspace") .. " opens the full window.", r, g, b)
	if db.settings.whisperNews then
		db.settings.whisperNews = nil
		WhisperWrite(frame, "New: chats live in whisper tabs like this one by default. /claude config ui whisper off goes back to the window and the game chat.", r, g, b)
	end
end

function Whisper.FrameFor(chat, create, select)
	if not WhisperOn() or not chat then return nil end
	if not preSendHooked then
		run.whisperError = "this client has no " .. PRE_SEND_EVENT .. " hook, so a tab could not keep its whispers off the server"
		return nil
	end
	run.whisperTabs = run.whisperTabs or {}
	local frame = run.whisperTabs[chat.id]
	local stale = frame and create and ChatAgent(chat) ~= "" and tostring(frame.claudewowTarget or ""):lower() ~= ChatAgentName(chat):lower()
	if stale then
		Whisper.Close(chat)
		frame = nil
	end
	if WhisperOwns(chat, frame) then
		Whisper.Retitle(chat)
		return frame
	end
	run.whisperTabs[chat.id] = nil
	local title = Whisper.Title(chat):lower()
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
	WhisperAdopt(chat, f)
	Whisper.Welcome(chat, f)
	return f
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

function Whisper.System(chat, text, create, raw)
	local frame = Whisper.FrameFor(chat, create)
	if not frame then return false end
	local r, g, b = Whisper.SystemColor()
	Whisper.Lines(frame, raw and text or Display(text), r, g, b)
	return true
end

function Whisper.BodyLines(source, max, width)
	local lines, total = {}, 0
	for line in (source .. "\n"):gmatch("(.-)\n") do
		if line:match("%S") then
			total = total + 1
			if width and #line > width then line = line:sub(1, width) .. "..." end
			if total <= max then table.insert(lines, line) end
		end
	end
	return lines, total
end

function Whisper.Body(text, summary)
	local body = Display(text)
	local mode = db.settings.echo
	local limit = mode == "full" and WHISPER_TEXT_MAX or tonumber(mode)
	if limit then
		local lines, shown = {}, 0
		for line in (body .. "\n"):gmatch("(.-)\n") do
			if line:match("%S") then
				if shown + #line > limit then return lines, (#body - shown) .. " more characters" end
				table.insert(lines, line)
				shown = shown + #line
			end
		end
		return lines, nil
	end
	local all, total = Whisper.BodyLines(body, WL.SHORT_LINES)
	if total <= WL.SHORT_LINES and #body <= WL.SHORT_CHARS then return all, nil end
	local tldr = Display(summary or "")
	if tldr:match("%S") then
		local lines = Whisper.BodyLines(tldr, WL.TLDR_LINES, WL.LINE_MAX)
		return lines, "TL;DR of a longer reply (" .. total .. " lines)"
	end
	local lines = Whisper.BodyLines(body, WL.PREVIEW_LINES, WL.LINE_MAX)
	local more = total - #lines
	return lines, more > 0 and ("... " .. more .. " more lines") or "... the rest is longer than the tab shows"
end

function Whisper.RollLinks(chat, msgId)
	local id = chat.id .. ":" .. tostring(msgId or 0)
	if ClaudeWoW.LootRollEnabled() then
		return Link("roll", id .. ":need", NEED or "Need", "1eff00") .. " " .. Link("roll", id .. ":greed", GREED or "Greed", "ffd100") .. " " .. Link("roll", id .. ":pass", PASS or "Pass", "ff6060")
	end
	return Link("roll", id .. ":need", "Allow & retry", "1eff00") .. " " .. Link("roll", id .. ":greed", "Allow once", "ffd100") .. " " .. Link("roll", id .. ":pass", "Pass", "ff6060")
end

function Whisper.MacroLinkLabel(m)
	return (ClaudeWoW.MacroLabel(m):gsub("|c%x%x%x%x%x%x%x%x", ""):gsub("|r", ""))
end

function Whisper.Reply(chat, text, agent, role, denied, summary, msgId, macros)
	local frame = Whisper.FrameFor(chat, true, false)
	if not frame then return false end
	Whisper.EndLive(frame, "progress")
	local who = ReplyAgentName(chat, agent)
	local sr, sg, sb = Whisper.SystemColor()
	if role == "system" then
		local lines = Whisper.BodyLines(Display(text), WL.SHORT_LINES)
		for i, line in ipairs(lines) do
			WhisperWrite(frame, line .. (i == #lines and ("  " .. Link("open", chat.id, "open")) or ""), sr, sg, sb)
		end
	else
		local r, g, b = WhisperColor("WHISPER", 1, 0.5, 1)
		local prefix = WhisperFormat(CHAT_WHISPER_GET, "%s whispers: ", "|H" .. LINK_PREFIX .. "reply:" .. chat.id .. "|h[" .. who .. "]|h")
		local lines, cut = Whisper.Body(text, summary)
		for i, line in ipairs(lines) do WhisperWrite(frame, (i == 1 and prefix or "") .. line, r, g, b) end
		if #lines == 0 then WhisperWrite(frame, prefix, r, g, b) end
		if cut then WhisperWrite(frame, "|cff888888" .. cut .. ":|r " .. Link("open", chat.id, "full reply"), r, g, b) end
		for k, m in ipairs(macros or {}) do
			WhisperWrite(frame, Link("macro", chat.id .. ":" .. tostring(msgId or 0) .. ":" .. k, Whisper.MacroLinkLabel(m), "ffd100") .. "  |cff888888click, then drop it on an action bar|r", sr, sg, sb)
		end
	end
	if denied then
		WhisperWrite(frame, who .. " needs permission for " .. Display(ClaudeWoW.GrantsLabel(denied)) .. ": " .. Whisper.RollLinks(chat, msgId), sr, sg, sb)
	end
	Whisper.Flash(frame)
	return true
end

function Whisper.ProgressText(chat)
	local a = run.act and run.act[chat.id]
	local started = (a and a.startedAt) or (run.whisperSentAt and run.whisperSentAt[chat.id]) or GetTime()
	local elapsed = math.floor((GetTime() - started) / WL.ELAPSED_STEP) * WL.ELAPSED_STEP
	local parts = { FmtElapsed(elapsed) }
	if a and not a.unreliable and a.count > 0 then table.insert(parts, a.count .. (a.count == 1 and " action" or " actions")) end
	local text = ChatAgentName(chat) .. " is working... " .. table.concat(parts, " " .. SEG_DOT .. " ")
	local p = Trim(Flat(chat.progress or ""))
	if p ~= "" then
		if #p > WL.PROGRESS_MAX then p = p:sub(1, WL.PROGRESS_MAX) .. "..." end
		text = text .. " - " .. p
	end
	return text .. "  " .. Link("cancel", chat.id, "cancel", "888888")
end

function Whisper.RefreshProgress(chat, force)
	if not chat.pendingId then return nil end
	local frame = Whisper.FrameFor(chat, false)
	if not frame then return nil end
	local r, g, b = Whisper.SystemColor()
	return Whisper.Live(frame, "progress", Whisper.ProgressText(chat), r, g, b, force)
end

function Whisper.Sent(chat, text)
	local frame = Whisper.FrameFor(chat, true, false)
	if not frame then return false end
	local who = ChatAgentName(chat)
	WhisperWrite(frame, WhisperFormat(CHAT_WHISPER_INFORM_GET, "To %s: ", who) .. Flat(text), WhisperColor("WHISPER_INFORM", 1, 0.5, 1))
	run.whisperSentAt = run.whisperSentAt or {}
	run.whisperSentAt[chat.id] = GetTime()
	Whisper.EndLive(frame, "progress")
	Whisper.RefreshProgress(chat, true)
	return true
end

function Whisper.Progress(chat)
	if chat.pendingId then Whisper.RefreshProgress(chat) end
end

function Whisper.StopProgress(chat)
	local frame = run.whisperTabs and run.whisperTabs[chat.id]
	if frame then Whisper.EndLive(frame, "progress") end
end

function Whisper.BridgeLine(chat)
	local key = ConnectionKey()
	if key == run.whisperBridgeKey then return end
	run.whisperBridgeKey = key
	local frame = chat and Whisper.FrameFor(chat, false)
	if not frame then return end
	local r, g, b = Whisper.SystemColor()
	local text
	if key == "ok" then
		if run.whisperBridgeBad then text = "|cff33ff66Bridge is back.|r" end
		run.whisperBridgeBad = nil
	elseif key == "stale" then
		text = "Bridge quiet for a while. " .. Link("connect", nil, "reconnect")
	elseif key == "down" then
		text = select(5, ClaudeWoW.BridgeState()) .. " " .. Link("connect", nil, "connect")
	elseif key == "failed" then
		text = "No answer from the bridge. Is it running (claude-wow in a terminal, or the service)? " .. Link("connect", nil, "try again")
	elseif key == "connecting" then
		text = "Connecting to the bridge..."
	elseif key == "unknown" then
		text = "Not connected to the bridge yet. Start it (claude-wow in a terminal, or the service), then " .. Link("connect", nil, "connect")
	end
	if key == "stale" or key == "down" or key == "failed" then run.whisperBridgeBad = true end
	if text then
		Whisper.Live(frame, "bridge", text, r, g, b, true)
	else
		Whisper.EndLive(frame, "bridge")
	end
end

function Whisper.Pulse()
	if not db or not Whisper.Active() then return end
	local c = ActiveChat()
	if not run.whisperBooted then
		local waited = GetTime() - (run.startedAt or GetTime())
		local ready = ClaudeWoW.IsConnected() and c ~= nil and ChatAgent(c) ~= ""
		if not ready and waited < WL.BOOT_WAIT then return end
		run.whisperBooted = true
		if c then Whisper.FrameFor(c, true, false) end
	end
	for _, ch in ipairs(db.chats) do
		if ch.pendingId then Whisper.RefreshProgress(ch) end
	end
	Whisper.BridgeLine(c)
end

function Whisper.Close(chat)
	local frame = run.whisperTabs and run.whisperTabs[chat.id]
	if not frame then return end
	run.whisperTabs[chat.id] = nil
	frame.claudewowChatId = nil
	whisperLive[frame] = nil
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
		if not c.quiet and ChatAgentName(c):lower() == target then
			if c.id == db.activeChat then return c end
			if c.id == run.lastReplyChat or not best then best = c end
		end
	end
	return best
end

function Whisper.ReplyName(chat)
	local label = Trim(Display(chat.name))
	if label == "" then label = tostring(chat.id) end
	return ChatAgentName(chat) .. " [" .. label .. "]"
end

local function ReplyNameChat(target)
	target = tostring(target or ""):lower()
	if target == "" or not db then return nil end
	local offered = run.replyNames and run.replyNames[target]
	if offered then return FindChat(offered) or FindChat(run.lastReplyChat) or ActiveChat() end
	local best
	for _, c in ipairs(db.chats) do
		if Whisper.ReplyName(c):lower() == target then
			if c.id == run.lastReplyChat then return c end
			best = best or c
		end
	end
	return best
end

local function SetLastTellFunction()
	if type(ChatFrameUtil) == "table" and type(ChatFrameUtil.SetLastTellTarget) == "function" then return ChatFrameUtil.SetLastTellTarget end
	if type(ChatEdit_SetLastTellTarget) == "function" then return ChatEdit_SetLastTellTarget end
	return nil
end

function Whisper.OfferReply(chat)
	local setLastTell = SetLastTellFunction()
	if not preSendHooked or not setLastTell then return false end
	local name = Whisper.ReplyName(chat)
	run.replyNames = run.replyNames or {}
	run.replyNames[name:lower()] = chat.id
	local ok = pcall(setLastTell, name, "WHISPER")
	if ok then run.replyTarget = name end
	return ok
end

function Whisper.TabChat(eb)
	if not WhisperOn() or type(eb) ~= "table" then return nil end
	local frame = eb.chatFrame or (eb.GetParent and eb:GetParent())
	local chat = type(frame) == "table" and frame.claudewowChatId and FindChat(frame.claudewowChatId)
	if chat and run.whisperTabs and run.whisperTabs[chat.id] == frame then return chat end
	return nil
end

function Whisper.ChatForBox(eb)
	if type(eb) ~= "table" or not eb.GetAttribute then return nil end
	if eb:GetAttribute("chatType") ~= "WHISPER" then return nil end
	local target = eb:GetAttribute("tellTarget")
	local replied = ReplyNameChat(target)
	if replied then return replied end
	if not WhisperOn() then return nil end
	return Whisper.TabChat(eb) or WhisperAgentChat(target)
end

function Whisper.Intercept(eb, layer)
	local chat = Whisper.ChatForBox(eb)
	if not chat then return false end
	local text = Trim(eb:GetText() or "")
	pcall(eb.SetText, eb, "")
	if text == "" then return true end
	run.whisperSwallowed = (run.whisperSwallowed or 0) + 1
	run.whisperLayer = layer
	if eb.AddHistoryLine then pcall(eb.AddHistoryLine, eb, text) end
	if run.whisperProbe then
		run.whisperProbe(chat, text, layer)
		return true
	end
	if db.activeChat ~= chat.id then ClaudeWoW.SwitchChat(chat.id) end
	if chat.pendingId then
		Whisper.System(chat, ChatAgentName(chat) .. " is still working on your last message; this one waits and is offered again when the reply lands (/claude cancel gives up on the last one)")
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
	if not db then return false end
	local name = WhisperNotFoundName(msg)
	if not name then return false end
	name = name:lower()
	local ours = ReplyNameChat(name) ~= nil or (run.replyTarget and run.replyTarget:lower() == name)
	if not ours and not WhisperOn() then return false end
	ours = ours or name == WHISPER_PROBE_NAME:lower()
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

function Whisper.Install()
	if whisperInstalled then return end
	whisperInstalled = true
	run.whisperLayers = { preSendHooked and PRE_SEND_EVENT or ("no " .. PRE_SEND_EVENT) }
	if type(ChatFrame_AddMessageEventFilter) == "function" then
		pcall(ChatFrame_AddMessageEventFilter, "CHAT_MSG_SYSTEM", WhisperLeakFilter)
		table.insert(run.whisperLayers, "leak filter")
	end
end

function Whisper.Status()
	local tabs = 0
	for _, c in ipairs(db.chats) do
		if WhisperOwns(c, run.whisperTabs and run.whisperTabs[c.id]) then tabs = tabs + 1 end
	end
	return "whisper tabs: " .. (WhisperOn() and "on" or "off") .. ", " .. tabs .. " open, send hook: " .. (preSendHooked and "pre-send" or "MISSING")
		.. ", sends swallowed: " .. (run.whisperSwallowed or 0)
		.. ", LEAKS: " .. (run.whisperLeaks or 0) .. (run.whisperError and (", last open error: " .. run.whisperError) or "")
		.. ", /r: " .. (run.replyTarget or "the game's last whisper")
end

-- opts.vision asks for a picture of the screen with this one message, whatever
-- the setting ("/claude-wow look <question>").
function ClaudeWoW.Send(text, allow, opts)
	local c = (opts and opts.chat and FindChat(opts.chat)) or ActiveChat()
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
	text = Cli.ProjectTag(c, text)
	if not ClaudeWoW.IsConnected() then
		if ui.input then ui.input:SetText(text) end
		run.sendOnConnect = { chat = c.id, text = text, allow = allow, opts = opts }
		if not run.connectingAt then ClaudeWoW.Connect(ShotsPaused(true)) end
		if not (Whisper.Active() and Whisper.System(c, "Not connected to the bridge yet; connecting now. Your message goes out as soon as it answers.", true)) then
			ClaudeWoW.Toggle(true)
		end
		return
	end
	-- Shift-clicked links become [Name] plus their tooltip, which is what the agent can read.
	local links
	text, links = ClaudeWoW.ExpandLinks(text)
	local limit = Codec.MAX_PAYLOAD - 300
	if #text > limit then
		Cli.Out(c, "That message is too long for one send (" .. #text .. " chars, max ~" .. limit .. "). Split it up." .. (links > 0 and " Each linked item adds its tooltip to the message." or ""))
		return
	end
	-- The game context rides along when the bridge doesn't have this version yet.
	local ctx = ContextToSend(limit - #text)

	db.lastSeq = db.lastSeq + 1
	local id = db.lastSeq
	local tokens = {}
	local plugin = Cli.ChatPlugin(c)
	if c.resetNext then table.insert(tokens, "n") end
	if c.agent and c.agent ~= "" then table.insert(tokens, "agent=" .. c.agent) end
	if plugin ~= "" then table.insert(tokens, "plugin=" .. plugin) end
	if db.settings.vision or (opts and opts.vision) then table.insert(tokens, "v") end
	if opts and opts.kind then table.insert(tokens, "kind=" .. opts.kind) end
	local allowHex, allowOnceHex
	if type(allow) == "table" and #allow > 0 then
		if opts and opts.allowForThisRunOnly then
			table.insert(tokens, "once=" .. table.concat(allow, ","))
			allowOnceHex = ToHex(table.concat(allow, US))
		else
			table.insert(tokens, "allow=" .. table.concat(allow, ","))
			allowHex = ToHex(table.concat(allow, US))
		end
	end
	local optionTokens = Cli.ChatOptionTokens(c, opts and opts.onceDirs)
	local wantsTitle = c.name:match("^Chat %d+$") and not HasUserMessage(c)
	if wantsTitle then table.insert(optionTokens, "t") end
	for _, t in ipairs(optionTokens) do table.insert(tokens, t) end
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
		plugin = plugin ~= "" and plugin or nil,
		opts = #optionTokens > 0 and ToHex(table.concat(optionTokens, ";")) or nil,
		allow = allowHex,
		allowOnce = allowOnceHex,
		newSession = newSession,
		-- The bridge wants screenshots and this client cannot take one: the
		-- reload fallback tells it so, and it switches to the pixel capture.
		shot = NoScreenshot() and "missing" or nil,
		t = time(),
	}
	c.pendingId = id
	c.draft = nil
	c.progress = nil
	if not c.quiet then
		AddHistory(c, "user", text, id)
		if wantsTitle then
			c.name = AutoTitle(text) or c.name
			c.titleFor = id
		end
		if not Whisper.Sent(c, text) then db.settings.shown = true end
		if ClaudeWoWVoice then ClaudeWoWVoice.Event("sent") end
	end

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

local function SendCancel(chat, id)
	if db.settings.mode ~= "pixel" or not id or not run.bridgeCancel then return end
	db.lastSeq = db.lastSeq + 1
	run.outbound[db.lastSeq] = { chat = chat.id, cwd = chat.cwd or "", flags = "cancel=" .. id, name = chat.name or "", text = "", sentAt = GetTime(), cancelOf = id }
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
	local flags = "h"
	if Presence.Channel() and not (run.lateProbe and run.lateProbe.result) then
		run.lateProbe = run.lateProbe or { token = string.format("%06x%04x", time() % 16777216, math.floor(now * 1000) % 65536) }
		flags = flags .. ";probe=" .. run.lateProbe.token
	end
	run.outbound[db.lastSeq] = { chat = c and c.id or "", cwd = c and c.cwd or "", flags = flags, name = c and c.name or "", text = "", ctx = ctx, sentAt = now, hello = true }
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
	local plugin = Cli.ChatPlugin(c)
	if c.agent and c.agent ~= "" then table.insert(tokens, "agent=" .. c.agent) end
	if plugin ~= "" then table.insert(tokens, "plugin=" .. plugin) end
	if db.settings.vision then table.insert(tokens, "v") end -- a resend is a fresh screenshot
	for _, t in ipairs(Cli.ChatOptionTokens(c)) do table.insert(tokens, t) end
	if c.titleFor == c.pendingId then table.insert(tokens, "t") end
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
	local commands, dirs = ClaudeWoW.SplitGrants(rules)
	local full = Cli.AddChatDirs(c, dirs)
	local text = "Allowed: " .. ClaudeWoW.GrantsLabel(rules)
	if #dirs > 0 then text = text .. ". Extra folders for this chat: " .. Cli.DirsLabel(c) end
	if #full > 0 then text = text .. ". No room for " .. table.concat(full, ", ") .. " (at most " .. Cli.ADD_DIRS_MAX .. " folders), so it is added for this retry only" end
	Cli.Out(c, text)
	ClaudeWoW.Send("Those actions are allowed now. Continue from where you left off.", commands, { onceDirs = full })
end

function ClaudeWoW.AllowOnce(chatId, rules)
	local c = FindChat(chatId)
	if not c or c.pendingId or not rules or #rules == 0 then return end
	if db.activeChat ~= c.id then ClaudeWoW.SwitchChat(c.id) end
	for _, m in ipairs(c.history) do m.denied = nil end
	local commands, dirs = ClaudeWoW.SplitGrants(rules)
	Cli.Out(c, "Allowed for this retry only: " .. ClaudeWoW.GrantsLabel(rules))
	ClaudeWoW.Send("Those actions are allowed for this run. Continue from where you left off.", commands, { allowForThisRunOnly = true, onceDirs = dirs })
end

function ClaudeWoW.PassOnDenial(chatId, rules, reason)
	local c = FindChat(chatId)
	if not c or not rules or #rules == 0 then return end
	for _, m in ipairs(c.history) do m.denied = nil end
	Cli.Out(c, "Passed on: " .. ClaudeWoW.GrantsLabel(rules) .. (reason and (" (" .. reason .. ")") or ""))
	if c.plugin == LIVE_PLUGIN and not c.pendingId then
		ClaudeWoW.Send(LIVE_PASS_TEXT, nil, { chat = c.id })
		return
	end
	ClaudeWoW.Render()
end

function ClaudeWoW.ApplyLive(live)
	if type(live) ~= "table" then return end
	run.bridgeLive = {
		sessions = type(live.sessions) == "table" and live.sessions or {},
		start = type(live.start) == "string" and live.start or "",
	}
end

function ClaudeWoW.LiveStatus()
	local live = run.bridgeLive
	if not live then
		return { "Running Claude Code sessions: unknown until the bridge is heard from." }
	end
	if #live.sessions == 0 then
		local lines = { "No Claude Code session is running with the claude-wow channel. Start one in a terminal with:" }
		if live.start ~= "" then table.insert(lines, live.start) end
		table.insert(lines, "Then attach a chat to it: /claude -r <name>")
		return lines
	end
	local lines = { "Running Claude Code sessions (" .. #live.sessions .. "):" }
	for i, name in ipairs(live.sessions) do table.insert(lines, i .. ". " .. tostring(name)) end
	table.insert(lines, "Attach a chat to one: /claude -r <name>")
	return lines
end

function ClaudeWoW.ApplySessions(list, now)
	if type(list) ~= "table" then return end
	local clean = {}
	for _, e in ipairs(list) do
		if type(e) == "table" and (type(e.id) == "string" or type(e.name) == "string") then
			table.insert(clean, {
				id = type(e.id) == "string" and e.id or "",
				name = type(e.name) == "string" and e.name or "",
				cwd = type(e.cwd) == "string" and e.cwd or "",
				agent = type(e.agent) == "string" and e.agent or "",
				plugin = type(e.plugin) == "string" and e.plugin or "",
				chat = type(e.chat) == "string" and e.chat or "",
				at = tonumber(e.at) or 0,
				live = e.live == true,
				running = e.running == true or e.live == true,
				title = type(e.title) == "string" and e.title or "",
				branch = type(e.branch) == "string" and e.branch or "",
				restart = type(e.restart) == "string" and e.restart or "",
			})
		end
	end
	run.bridgeSessions = clean
	if type(now) == "number" then run.bridgeNow = now end
end

function ClaudeWoW.OpenDenial(chatId)
	local c = FindChat(chatId)
	if not c or c.pendingId then return nil end
	local latest = c.history[#c.history]
	if latest and type(latest.denied) == "table" and #latest.denied > 0 then
		return latest.denied, latest.id, latest.agent
	end
	return nil
end

function ClaudeWoW.LootRollEnabled()
	return db ~= nil and db.settings.lootRoll ~= false and ClaudeWoWRoll ~= nil
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
	ui.chatPage = nil
	if ui.input then
		ui.input:SetText(c.draft or "")
		c.draft = nil
	end
	ClaudeWoW.Render()
	ClaudeWoW.RenderChatList()
end

function ClaudeWoW.AddChat(name, fields)
	local c = AddChat(name)
	if not c then return nil end
	for k, v in pairs(fields or {}) do c[k] = v end
	ClaudeWoW.RenderChatList()
	return c
end

function ClaudeWoW.NewChat(name)
	local c = AddChat(name and name ~= "" and name or nil)
	ClaudeWoW.SwitchChat(c.id)
	Cli.Show(c)
	return c
end

Cli.PROJECTS_MAX = 20
Cli.NO_PROJECT = "No project"

function Cli.ProjectOf(c)
	if not c then return "" end
	if c.cwd and c.cwd ~= "" then return c.cwd end
	if Cli.ChatPlugin(c) == "claude-code" then return run.bridgeCwd or "" end
	return ""
end

function Cli.KnownProjects()
	local out, seen = {}, {}
	local function Add(p)
		if type(p) == "string" and p ~= "" and not seen[p] and #out < Cli.PROJECTS_MAX then
			seen[p] = true
			table.insert(out, p)
		end
	end
	for _, p in ipairs(db.settings.projects or {}) do Add(p) end
	for _, c in ipairs(db.chats) do Add(Cli.ProjectOf(c)) end
	Add(run.bridgeCwd)
	return out
end

function Cli.RememberProject(path)
	local list = { path }
	for _, p in ipairs(db.settings.projects or {}) do
		if p ~= path and #list < Cli.PROJECTS_MAX then table.insert(list, p) end
	end
	db.settings.projects = list
end

function Cli.FindProject(name)
	name = Trim(tostring(name or ""))
	if name == "" then return nil end
	local lower = name:lower()
	for _, p in ipairs(Cli.KnownProjects()) do
		if p == name or FolderName(p):lower() == lower then return p end
	end
	return nil
end

function Cli.ProjectNames()
	local names = {}
	for _, p in ipairs(Cli.KnownProjects()) do table.insert(names, FolderName(p)) end
	return #names > 0 and table.concat(names, ", ") or "none yet"
end

function Cli.IsNoProject(value)
	value = Trim(tostring(value or "")):lower()
	return value == "" or value == "none" or value == "-" or value == "default"
end

function Cli.ResolveProject(value)
	value = Trim(tostring(value or ""))
	if Cli.IsNoProject(value) then return "" end
	return Cli.FindProject(value) or (value:find("[\\/~]") and value) or nil
end

function Cli.SetProject(c, value)
	local path = Cli.ResolveProject(value)
	if not path then return nil, "Unknown project \"" .. tostring(value) .. "\". Known: " .. Cli.ProjectNames() .. ". Or give a folder path." end
	c.cwd = path
	if c.plugin ~= "" and c.plugin ~= LIVE_PLUGIN then c.plugin = "" end
	if path ~= "" then Cli.RememberProject(path) end
	return path == "" and Cli.NO_PROJECT or FolderName(path)
end

function Cli.ProjectTag(c, text)
	for tag in text:gmatch("#([%w%._%-]+)") do
		local path = Cli.FindProject(tag)
		if path then
			if Cli.ProjectOf(c) ~= path then
				Cli.SetProject(c, path)
				Cli.Out(c, "project: " .. FolderName(path))
			end
			local escaped = ("#" .. tag):gsub("%p", "%%%0")
			return (text:gsub(escaped, tag, 1))
		end
	end
	return text
end

function Cli.ProjectLabel(c)
	local path = Cli.ProjectOf(c)
	return path == "" and Cli.NO_PROJECT or FolderName(path)
end

function Cli.PickProject(c, value)
	local note, err = Cli.SetProject(c, value)
	Cli.Out(c, err or ("project: " .. note))
	ClaudeWoW.Render()
end

function Cli.ProjectMenu(anchor)
	local c = ActiveChat()
	if not c then return end
	if type(MenuUtil) == "table" and type(MenuUtil.CreateContextMenu) == "function" then
		local shown = pcall(MenuUtil.CreateContextMenu, anchor, function(_, root)
			root:CreateTitle("Project")
			root:CreateButton(Cli.NO_PROJECT, function() Cli.PickProject(c, "none") end)
			for _, p in ipairs(Cli.KnownProjects()) do
				root:CreateButton(FolderName(p), function() Cli.PickProject(c, p) end)
			end
			root:CreateDivider()
			root:CreateButton("Other folder...", function() ClaudeWoW.FolderPrompt(c.id) end)
		end)
		if shown then return end
	end
	ClaudeWoW.FolderPrompt(c.id)
end

function Cli.UpdateProjectButton()
	local b = ui.projectButton
	if not b then return end
	b.text:SetText("Project: |cffffffff" .. Display(Cli.ProjectLabel(ActiveChat())) .. "|r")
	b:SetWidth(math.max(60, (Try(b.text.GetStringWidth, b.text) or 100) + 8))
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
		Cli.Out(c, "cwd set to " .. rest .. note .. (changed and #c.history > 1 and ("; the next message starts a fresh " .. ChatAgentName(c) .. " session there") or ""))
	elseif c.cwd ~= "" then
		c.cwd = ""
		Cli.Out(c, "cwd reset to the bridge's default: " .. base)
	else
		Cli.Out(c, "cwd is the bridge's default: " .. base .. " (/claude cd <folder>, or right-click the chat and pick Folder, to change)")
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
	if rest == "" then
		Cli.Out(c, (c.agent ~= "" and ("agent is " .. AgentName(c.agent)) or ("agent is the bridge's default: " .. (run.bridgeAgent and AgentName(run.bridgeAgent) or "unknown until connected"))) .. " (/claude -c --agent <name>, or right-click the chat and pick Agent, to change; agents: " .. AgentList() .. ")")
		ClaudeWoW.Render()
		return
	end
	if rest == "-" or rest == "default" then rest = "" end
	if rest ~= "" and run.bridgeAgents and not Contains(run.bridgeAgents, rest) then
		Cli.Out(c, "Unknown agent \"" .. rest .. "\". The bridge knows: " .. AgentList())
		ClaudeWoW.Render()
		return
	end
	local changed = rest ~= (c.agent or "")
	c.agent = rest
	if rest ~= "" then
		Cli.Out(c, "agent set to " .. AgentName(rest) .. (changed and #c.history > 1 and "; the next message starts a fresh session with it" or ""))
	elseif changed then
		Cli.Out(c, "agent reset to the bridge's default: " .. (run.bridgeAgent and AgentName(run.bridgeAgent) or "unknown until connected"))
	else
		Cli.Out(c, "agent is the bridge's default: " .. (run.bridgeAgent and AgentName(run.bridgeAgent) or "unknown until connected") .. " (/claude -c --agent <name>, or right-click the chat and pick Agent, to change; agents: " .. AgentList() .. ")")
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
		if chat and box then ClaudeWoW.SetAgent(Trim(box:GetText() or "") == "" and "default" or box:GetText(), chat) end
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
	if rest == "" then
		Cli.Out(c, ((c.plugin or "") ~= "" and ("plugin is " .. c.plugin) or ("plugin is the bridge's default: " .. BridgePluginName())) .. " (/claude config plugin <name>, or right-click the chat and pick Plugin, to change; plugins: " .. PluginList() .. "). This is an advanced setting: a chat with a folder (/claude cd) is a coding session and one without is general chat, and /claude -r attaches running sessions.")
		ClaudeWoW.Render()
		return
	end
	if rest == "-" or rest == "default" then rest = "" end
	if rest ~= "" and run.bridgePlugins and not Contains(run.bridgePlugins, rest) then
		Cli.Out(c, "Unknown plugin \"" .. rest .. "\". The bridge has: " .. PluginList())
		ClaudeWoW.Render()
		return
	end
	local changed = rest ~= (c.plugin or "")
	c.plugin = rest
	if rest ~= "" then
		Cli.Out(c, "plugin set to " .. rest .. (changed and #c.history > 1 and "; the next message starts a fresh session with it" or ""))
	elseif changed then
		Cli.Out(c, "plugin reset to the bridge's default: " .. BridgePluginName())
	else
		Cli.Out(c, "plugin is the bridge's default: " .. BridgePluginName() .. " (/claude config plugin <name>, or right-click the chat and pick Plugin, to change; plugins: " .. PluginList() .. ")")
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
		if chat and box then ClaudeWoW.SetPlugin(Trim(box:GetText() or "") == "" and "default" or box:GetText(), chat) end
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
			chat.titleFor = nil
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
	local otherUserChats = 0
	for _, ch in ipairs(db.chats) do
		if ch ~= c and not ch.quiet then otherUserChats = otherUserChats + 1 end
	end
	if #db.chats == 1 or (otherUserChats == 0 and not c.quiet) then
		wipe(c.history)
		c.pendingId, c.progress, c.unread, c.draft = nil, nil, 0, nil
		c.name = "Chat 1"
		ClaudeWoW.Render()
		ClaudeWoW.RenderChatList()
		return
	end
	table.remove(db.chats, idx)
	if db.activeChat == c.id then
		local nextChat = db.chats[math.min(idx, #db.chats)]
		if nextChat.quiet then
			for _, ch in ipairs(db.chats) do
				if not ch.quiet then
					nextChat = ch
					break
				end
			end
		end
		ClaudeWoW.SwitchChat(nextChat.id)
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
	ClaudeWoW.Print(msg)
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
		if index and oldBody ~= m.body then table.insert(why, "It replaces your existing macro \"" .. m.name .. "\" (/claude config macro undo brings the old one back).") end
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

function ClaudeWoW.MacroPrompt(m)
	if type(m) ~= "table" then return end
	if InCombatLockdown() then
		MacroSay("macros can't be changed in combat; click the link again afterwards.")
		return
	end
	local index, _, oldBody = FindMacro(m.name, m.char)
	local lines = { (index and "Update" or "Create") .. " the macro \"" .. Display(m.name) .. "\"" .. (m.char and " (this character only)" or "") .. "? It lands on your cursor: click an action bar slot to place it." }
	if m.risky then table.insert(lines, "This macro runs code or clicks buttons (/run, /script, /click). Only keep it if you trust what it does.") end
	if index and oldBody ~= m.body then table.insert(lines, "It replaces your existing macro \"" .. Display(m.name) .. "\" (/claude config macro undo brings the old one back).") end
	table.insert(lines, Display(m.body))
	StaticPopup_Show("CLAUDEWOW_MACRO", table.concat(lines, "\n\n"), nil, m)
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
				s = ((run.slotError and run.slotError ~= "MISSING" and run.slotError ~= "DISABLED") and ("Reply slots do not load (" .. tostring(run.slotError) .. "; run install-slots.js, restart WoW)") or "Reply slots not installed (run install-slots.js, restart WoW)") .. ". Using reload instead: Enter or Refresh"
			elseif run.slotsExhausted then
				s = "Slot pool used up this session - next keypress reloads to free it"
			elseif run.pixelFailed then
				s = "Bridge didn't see #" .. id .. " after " .. STRIP_TRIES .. " tries - next keypress switches to the reload path (or /claude reload)"
			elseif c.progress or (run.act and run.act[c.id] and run.act[c.id].count > 0) then
				s = ChatAgentName(c) .. " is working on #" .. id .. " - " .. ActivityLine(c)
			elseif rec and not rec.acked then
				s = "Sending #" .. id .. (rec.tries and rec.tries > 1 and (" (try " .. rec.tries .. "/" .. STRIP_TRIES .. ")") or "") .. "..."
				local state = ClaudeWoW.BridgeState()
				if state == "down" then s = s .. " - bridge not seen lately, is the bridge running?" end
			else
				s = "Waiting for #" .. id .. " (checked " .. (run.polls or 0) .. "x)"
				if elapsed > 45 then
					s = s .. " - no sign of the bridge. Is the bridge running? /claude resend"
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
	ui.status:SetText(ui.native and Q.ShortStatus(c, s) or s)
	run.statusText = s
	ClaudeWoW.UpdateDot()
	ClaudeWoW.UpdateConnect()
	if ui.title then
		local t = c and Display(c.name) or "Claude WoW"
		if ui.chatTitle then
			t = "Claude WoW"
		else
			local folder = FolderName(ChatFolder(c))
			if folder ~= "" then t = t .. "  |cff888888" .. Display(folder) .. "|r" end
			if c and c.agent and c.agent ~= "" then t = t .. "  |cff888888" .. AgentName(c.agent) .. "|r" end
		end
		ui.title:SetText(t)
	end
	if ui.chatTitle then ClaudeWoW.RefreshTitleBar() end
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
	if ui.stats then
		ui.stats:SetText(Q.FooterStats(c))
		ui.stats:ClearAllPoints()
		local beside = (ui.refresh:IsShown() and ui.refresh) or (ui.resend:IsShown() and ui.resend) or nil
		if beside then
			ui.stats:SetPoint("RIGHT", beside, "LEFT", -10, 0)
		else
			ui.stats:SetPoint("BOTTOMRIGHT", ui.frame, "BOTTOMRIGHT", -26, 9)
		end
		Q.UpdateContextBar(c)
		if ui.ctxBar then
			ui.ctxBar:ClearAllPoints()
			ui.ctxBar:SetPoint("RIGHT", ui.stats, "LEFT", -14, 0)
		end
	end
	ClaudeWoW.UpdateMini()
end

local PICKER_ROW_HEIGHT = 20

local function GetPickerRow(b, k)
	local rb = b.rowBtns[k]
	if rb then return rb end
	rb = CreateFrame("Button", nil, b)
	rb:SetHeight(PICKER_ROW_HEIGHT - 2)
	rb.label = rb:CreateFontString(nil, "OVERLAY", "ChatFontNormal")
	rb.label:SetPoint("LEFT", rb, "LEFT", 4, 0)
	rb.label:SetPoint("RIGHT", rb, "RIGHT", -4, 0)
	rb.label:SetJustifyH("LEFT")
	rb.label:SetWordWrap(false)
	rb:SetHighlightTexture("Interface\\QuestFrame\\UI-QuestTitleHighlight", "ADD")
	rb:SetScript("OnClick", function(self) ClaudeWoW.PickRow(self.row) end)
	b.rowBtns[k] = rb
	return rb
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
	local onParchment = ui.parchment ~= nil
	b.who = b:CreateFontString(nil, "OVERLAY", onParchment and Q.FontObject("QuestFontNormalSmall", "GameFontNormalSmall") or "GameFontNormalSmall")
	b.who:SetPoint("TOPLEFT", b, "TOPLEFT", 10, -6)
	b.who:SetJustifyH("LEFT")
	b.when = b:CreateFontString(nil, "OVERLAY", onParchment and Q.FontObject("QuestFontNormalSmall", "GameFontDisableSmall") or "GameFontDisableSmall")
	b.when:SetPoint("TOPRIGHT", b, "TOPRIGHT", -8, -6)
	b.body = b:CreateFontString(nil, "OVERLAY", onParchment and Q.FontObject("QuestFont", "ChatFontNormal") or "ChatFontNormal")
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
	b.rowBtns = {}
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
	Cli.UpdateProjectButton()
	if ui.content and c then
		local width = ui.scroll:GetWidth()
		if not width or width < 80 then width = 400 end
		ui.content:SetWidth(width)
		local y, n = 0, 0
		local function Place(role, text, when, dim, denied, agent, macros, newChat, picker)
			n = n + 1
			local b = GetBubble(n)
			local st = ROLE_STYLE[role] or ROLE_STYLE.system
			local look = ui.parchment and (Q.PARCHMENT_STYLE[role] or Q.PARCHMENT_STYLE.system) or st
			b:SetWidth(width)
			b.bg:SetColorTexture(look.bg[1], look.bg[2], look.bg[3], look.bg[4])
			b.accent:SetColorTexture(look.color[1], look.color[2], look.color[3], ui.parchment and 0.6 or 0.9)
			b.who:SetText(st == ROLE_STYLE.assistant and ReplyAgentName(c, agent) or st.label)
			b.who:SetTextColor(look.color[1], look.color[2], look.color[3])
			b.when:SetText(when or "")
			b.body:SetWidth(width - 18)
			b.body:SetText(Display(text))
			local ink = ui.parchment and (dim and Q.PARCHMENT_DIM or Q.PARCHMENT_TEXT) or (dim and { 0.72, 0.72, 0.72 } or { 0.93, 0.93, 0.93 })
			b.body:SetTextColor(ink[1], ink[2], ink[3])
			local h = b.body:GetStringHeight()
			if not h or h < 1 then h = 14 end
			local extra = 0
			if denied and ClaudeWoW.LootRollEnabled() then
				b.allow:Hide()
				ClaudeWoWRoll.Offer(c.id)
			elseif denied then
				local label = "Allow " .. ClaudeWoW.GrantsLabel(denied) .. " & retry"
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
			local shownRows = 0
			for k, row in ipairs(picker or {}) do
				local rb = GetPickerRow(b, k)
				rb.row = row
				rb.label:SetText(row.text or "")
				rb:SetWidth(width - 24)
				rb:ClearAllPoints()
				rb:SetPoint("TOPLEFT", b.body, "BOTTOMLEFT", 0, -4 - extra)
				rb:Show()
				extra = extra + PICKER_ROW_HEIGHT
				shownRows = k
			end
			for k = shownRows + 1, #b.rowBtns do b.rowBtns[k]:Hide() end
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
			local picker = type(m.picker) == "table" and #m.picker > 0 and m.picker or nil
			Place(m.role, picker and m.head or m.text, m.t and date("%H:%M", m.t) or "", false, denied, m.agent, m.macros, m.newChat, picker)
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
				Place("system", Whisper.Active()
					and ("Nothing here yet. Type below and press Enter, or talk to " .. ChatAgentName(c) .. " in its chat tab: this window is the full record, the tab is the everyday way in. Shift-click an item, spell or quest to link it. /claude help lists the commands.")
					or "Click the box below and type to start. Shift-click an item, spell or quest to link it into your message. /claude help lists the commands. From the game chat, /claude <text> starts a new chat with that message, /claude -c <text> continues the current one.", "", true)
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
	if ui.questList then return ClaudeWoW.RenderQuestList() end
	if not ui.chatButtons then return end
	local pages = math.max(1, math.ceil(#db.chats / Q.CHAT_PAGE))
	if not ui.chatPage then
		for i, ch in ipairs(db.chats) do
			if ch.id == db.activeChat then ui.chatPage = math.ceil(i / Q.CHAT_PAGE) end
		end
	end
	ui.chatPage = math.min(math.max(ui.chatPage or 1, 1), pages)
	local offset = (ui.chatPage - 1) * Q.CHAT_PAGE
	if ui.pageLabel then
		ui.pageLabel:SetText(pages > 1 and (ui.chatPage .. " / " .. pages) or "")
		ui.pagePrev:SetShown(pages > 1)
		ui.pageNext:SetShown(pages > 1)
		ui.pagePrev:SetEnabled(ui.chatPage > 1)
		ui.pageNext:SetEnabled(ui.chatPage < pages)
	end
	for i, btn in ipairs(ui.chatButtons) do
		local c = db.chats[offset + i]
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
	return "  " .. Link("reply", chat.id, "reply", "55ff55") .. " " .. Link("open", chat.id, "open")
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
function ClaudeWoW.Notify(chat, text, agent, summary, role, denied, msgId, macros)
	pcall(PlaySound, 3081)
	if ClaudeWoWVoice then ClaudeWoWVoice.Reply(role, denied) end
	ClaudeWoW.UpdateMini()
	run.lastReplyChat = chat.id
	Whisper.OfferReply(chat)
	if not Whisper.Reply(chat, text, agent, role, denied, summary, msgId, macros) then
		EchoToChat(chat, text, agent, summary)
	end
	if ui.frame and ui.frame:IsShown() and db.activeChat == chat.id then return end
	if UIErrorsFrame then
		UIErrorsFrame:AddMessage(ReplyAgentName(chat, agent) .. " replied in " .. Display(chat.name), 0.5, 0.8, 1, 1)
	end
end

function ClaudeWoW.SystemNote(text)
	if not db then return end
	local c = ActiveChat()
	if not c then return end
	AddHistory(c, "system", text)
	ClaudeWoW.Render()
end

local function OnPreSendText(_, eb)
	if not db or type(eb) ~= "table" then return end
	Whisper.Intercept(eb, "pre-send")
end

local function InstallChatHooks()
	Whisper.HookPreSend(OnPreSendText)
end

function Cli.Split(s)
	local out = {}
	for part in (tostring(s or "") .. ":"):gmatch("([^:]*):") do table.insert(out, part) end
	return out
end

function Cli.FindMessage(c, msgId)
	msgId = tonumber(msgId)
	if not c or not msgId then return nil end
	for i = #c.history, 1, -1 do
		local m = c.history[i]
		if m.id == msgId and m.role ~= "user" then return m end
	end
end

function Cli.Links.resume(arg)
	ClaudeWoW.ResumePick(tonumber(arg))
end

function Cli.Links.open(arg)
	ClaudeWoW.OpenWorkspace(Cli.Split(arg)[1])
end

function Cli.Links.reply(arg)
	local id = Cli.Split(arg)[1]
	if Whisper.Active() then
		if FindChat(id) and db.activeChat ~= id then ClaudeWoW.SwitchChat(id) end
		return
	end
	ClaudeWoW.OpenWorkspace(id, true)
end

function Cli.Links.connect()
	ClaudeWoW.Connect(true)
end

function Cli.Links.cancel(arg)
	ClaudeWoW.Cancel(FindChat(Cli.Split(arg)[1]))
end

function Cli.Links.send(arg)
	local c = FindChat(Cli.Split(arg)[1])
	if not c or c.pendingId or not c.draft or c.draft == "" then return end
	local text = c.draft
	c.draft = nil
	ClaudeWoW.Send(text, nil, { chat = c.id })
end

function Cli.Links.roll(arg)
	local parts = Cli.Split(arg)
	local c, msgId, choice = FindChat(parts[1]), tonumber(parts[2]), parts[3]
	if not c then return end
	local rules, openId = ClaudeWoW.OpenDenial(c.id)
	if not rules or openId ~= msgId then
		Whisper.System(c, "That request was answered already.")
		return
	end
	local current = ClaudeWoWRoll and ClaudeWoWRoll.Current()
	if current and current.chatId == c.id and current.msgId == msgId then
		ClaudeWoWRoll.Choose(choice)
	elseif choice == "need" then
		ClaudeWoW.Allow(c.id, rules)
	elseif choice == "greed" then
		ClaudeWoW.AllowOnce(c.id, rules)
	elseif choice == "pass" then
		ClaudeWoW.PassOnDenial(c.id, rules)
	end
end

function Cli.Links.macro(arg)
	local parts = Cli.Split(arg)
	local m = Cli.FindMessage(FindChat(parts[1]), parts[2])
	local macro = m and m.macros and m.macros[tonumber(parts[3]) or 0]
	if macro then ClaudeWoW.MacroPrompt(macro) end
end

function Cli.Links.map(arg)
	if ClaudeWoWMap and ClaudeWoWMap.ShowLayer then ClaudeWoWMap.ShowLayer(arg) end
end

function ClaudeWoW.OnLink(link)
	if not db then return false end
	link = tostring(link or "")
	local body = link:match("^addon:claudewow:(.*)$") or link:match("^claudewow:(.*)$")
	if not body then return false end
	local action, arg = body:match("^(%a+):?(.*)$")
	local fn = action and Cli.Links[action]
	if not fn then return false end
	fn(arg or "")
	return true
end

hooksecurefunc("SetItemRef", function(link)
	ClaudeWoW.OnLink(link)
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

function ClaudeWoW.ClearChat(id)
	local c = (id and FindChat(id)) or ActiveChat()
	if c then wipe(c.history) end
	ClaudeWoW.Render()
end

local function MakeButton(parent, label, width, onClick)
	local b = CreateFrame("Button", nil, parent, "UIPanelButtonTemplate")
	b:SetSize(width, 22)
	b:SetText(label)
	b:SetScript("OnClick", onClick)
	return b
end

local PANEL_W = 150
Q.PORTRAIT = "Interface\\AddOns\\ClaudeWoW\\Portrait"
Q.NATIVE_TEMPLATES = { "ButtonFrameTemplate", "InsetFrameTemplate" }
Q.LIST_W = 300
Q.NAV_TOP = -24
Q.NAV_H = 34
Q.LIST_ROW_H = 20
Q.LIST_HEADER_H = 22
Q.NO_FOLDER = "Chats"
Q.QUEST_ART = {
	listBg = "QuestLog-main-background",
	header = "common-button-list-collapseExpand",
	plus = "common-button-list-plus",
	minus = "common-button-list-minus",
	rowGlow = "questlog-quest-glow-yellow",
	working = "Quest-In-Progress-Icon-yellow",
	reply = "UI-QuestIcon-TurnIn-Normal",
	parchment = "QuestBG-Parchment",
	poi = "UI-QuestPoi-QuestNumber",
	poiSelected = "UI-QuestPoi-QuestNumber-SuperTracked",
	poiPushed = "UI-QuestPoi-QuestNumber-Pressed",
	poiOuter = "UI-QuestPoi-OuterGlow",
	poiInner = "UI-QuestPoi-InnerGlow",
	workingSelected = "Quest-In-Progress-Icon-Brown",
	frame = "questlog-frame",
	filigree = "questlog-frame-filigree",
	gradient = "questlog-frame-gradient-bottom",
	gear = "questlog-icon-setting",
}
Q.ROW_TITLE_X = 31
Q.ROW_TOP = 8
Q.ROW_BOTTOM = 6
Q.ROW_BOTTOM_BARE = 4
Q.OBJECTIVE_GAP = 3
Q.OBJECTIVE_LINE_GAP = 2
Q.HEADER_INSET = 9
Q.HEADER_RIGHT = 6
Q.PAD_FIRST = 8
Q.PAD_HEADER_AFTER_HEADER = 6
Q.PAD_HEADER_AFTER_ROW = 4
Q.PAD_ROW_AFTER_HEADER = 2
Q.PAD_ROW_AFTER_ROW = -3
Q.TITLE_IDLE = { 0.75, 0.61, 0 }
Q.TITLE_WORKING = { 1, 1, 0 }
Q.TITLE_REPLY = { 0.25, 0.75, 0.25 }
Q.COUNT_W = 92
Q.GOLD_ICON = "|TInterface\\MoneyFrame\\UI-GoldIcon:12:12:0:-1|t"
Q.STATUS_HIT_W = 260
Q.CTX_BAR_W, Q.CTX_BAR_H = 120, 13
Q.CTX_DEFAULT_WINDOW = 200000
Q.CTX_LEVELS = {
	{ upTo = 0.50, color = { 0.10, 0.75, 0.10 } },
	{ upTo = 0.75, color = { 1.00, 0.82, 0.00 } },
	{ upTo = 0.90, color = { 1.00, 0.50, 0.00 } },
	{ upTo = math.huge, color = { 0.85, 0.10, 0.10 } },
}

function Q.ContextWindow(c)
	return (c and c.window) or Q.CTX_DEFAULT_WINDOW
end

function Q.ContextColor(fraction)
	for _, level in ipairs(Q.CTX_LEVELS) do
		if fraction <= level.upTo then return level.color end
	end
end

function Q.ContextBar(f)
	local bar = CreateFrame("StatusBar", "ClaudeWoWContextBar", f)
	bar:SetSize(Q.CTX_BAR_W, Q.CTX_BAR_H)
	bar:SetStatusBarTexture("Interface\\TargetingFrame\\UI-StatusBar")
	bar:SetMinMaxValues(0, 1)
	local bg = bar:CreateTexture(nil, "BACKGROUND")
	bg:SetAllPoints()
	bg:SetColorTexture(0, 0, 0, 0.6)
	local border = CreateFrame("Frame", nil, bar, "BackdropTemplate")
	border:SetPoint("TOPLEFT", bar, "TOPLEFT", -2, 2)
	border:SetPoint("BOTTOMRIGHT", bar, "BOTTOMRIGHT", 2, -2)
	if border.SetBackdrop then
		border:SetBackdrop({ edgeFile = "Interface\\Tooltips\\UI-Tooltip-Border", edgeSize = 8 })
		border:SetBackdropBorderColor(0.6, 0.6, 0.6, 1)
	end
	bar.text = bar:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
	bar.text:SetPoint("CENTER", bar, "CENTER", 0, 0)
	bar:EnableMouse(true)
	bar:SetScript("OnEnter", function(self)
		GameTooltip:SetOwner(self, "ANCHOR_TOP")
		GameTooltip:SetText("Context")
		local c = ActiveChat()
		GameTooltip:AddLine(ContextReport(c), 1, 1, 1, true)
		GameTooltip:Show()
	end)
	bar:SetScript("OnLeave", function() GameTooltip:Hide() end)
	bar:Hide()
	return bar
end

function Q.UpdateContextBar(c)
	local bar = ui.ctxBar
	if not bar then return end
	if not (c and c.ctx) then
		bar:Hide()
		return
	end
	local window = Q.ContextWindow(c)
	local fraction = c.ctx / window
	local color = Q.ContextColor(fraction)
	bar:SetValue(math.min(fraction, 1))
	bar:SetStatusBarColor(color[1], color[2], color[3])
	bar.fraction = fraction
	bar.text:SetText(FmtTokens(c.ctx) .. " / " .. FmtTokens(window))
	bar:Show()
end

function Q.ShortStatus(c, full)
	if c and c.pendingId then
		local a = run.act and run.act[c.id]
		local started = (a and a.startedAt) or run.sentAt or GetTime()
		return "|cffffd100Working|r  " .. FmtDur(GetTime() - started)
	end
	if not ClaudeWoW.IsConnected() then return "|cffff5050Not connected|r" end
	return full
end

function Q.TotalCost()
	local total, chats = 0, 0
	for _, ch in ipairs(db.chats) do
		if type(ch.cost) == "number" then
			total = total + ch.cost
			chats = chats + 1
		end
	end
	return total, chats
end

function Q.FooterStats(c)
	local parts = {}
	local total, chats = Q.TotalCost()
	if c and c.cost then
		local money = Q.GOLD_ICON .. " " .. string.format("$%.2f", c.cost)
		if chats > 1 then money = money .. string.format("  |cff9d9d9d(all chats $%.2f)|r", total) end
		table.insert(parts, money)
	elseif chats > 0 then
		table.insert(parts, Q.GOLD_ICON .. string.format(" |cff9d9d9dall chats $%.2f|r", total))
	end
	return table.concat(parts, "    ")
end

function Q.StatusTooltip()
	local c = ActiveChat()
	if run.statusText and ui.status and run.statusText ~= ui.status:GetText() then
		GameTooltip:AddLine(run.statusText, 1, 1, 1, true)
	end
	local total, chats = Q.TotalCost()
	if (c and c.cost) or chats > 0 then
		GameTooltip:AddLine(" ")
		if c and c.cost then GameTooltip:AddDoubleLine("This chat's session", string.format("$%.2f", c.cost), 1, 0.82, 0, 1, 1, 1) end
		if chats > 0 then GameTooltip:AddDoubleLine("All chats", string.format("$%.2f", total), 1, 0.82, 0, 1, 1, 1) end
		GameTooltip:AddLine("At API list prices: a comparison, not a bill. A subscription is not charged per token.", 0.6, 0.6, 0.6, true)
	end
end
Q.PARCHMENT_STYLE = {
	user      = { color = { 0.10, 0.22, 0.45 }, bg = { 0.10, 0.20, 0.40, 0.07 } },
	assistant = { color = { 0.45, 0.13, 0.02 }, bg = { 0, 0, 0, 0 } },
	system    = { color = { 0.32, 0.25, 0.16 }, bg = { 0, 0, 0, 0 } },
}
Q.PARCHMENT_TEXT, Q.PARCHMENT_DIM = { 0.18, 0.12, 0.06 }, { 0.38, 0.30, 0.20 }

function Q.TemplateExists(name)
	return type(C_XMLUtil) == "table" and Try(C_XMLUtil.GetTemplateInfo, name) ~= nil
end

function Q.NativeFrames()
	for _, name in ipairs(Q.NATIVE_TEMPLATES) do
		if not Q.TemplateExists(name) then return false end
	end
	return true
end

function Q.AtlasExists(name)
	return C_Texture and C_Texture.GetAtlasExists and C_Texture.GetAtlasExists(name) and true or false
end

Q.CLASSIC_ERA_ART = { parchment = true, reply = true }
Q.CLASSIC_ERA_GEAR = "Interface\\Icons\\INV_Misc_Gear_01"
Q.CLASSIC_PARCHMENT = "Interface\\QuestFrame\\UI-QuestGreeting-TopLeft"
Q.CLASSIC_PARCHMENT_COORDS = { 32 / 256, 248 / 256, 92 / 256, 248 / 256 }

function Q.ClassicParchment(tex)
	if not Q.IsClassicEra() then return false end
	local ok = pcall(tex.SetTexture, tex, Q.CLASSIC_PARCHMENT)
	if not ok then return false end
	local c = Q.CLASSIC_PARCHMENT_COORDS
	tex:SetTexCoord(c[1], c[2], c[3], c[4])
	ui.art = ui.art or {}
	ui.art.parchment = Q.CLASSIC_PARCHMENT
	return true
end

function Q.IsClassicEra()
	local _, _, _, interface = Try(GetBuildInfo)
	local toc = tonumber(interface)
	return toc ~= nil and toc >= 11500 and toc < 11600
end

function Q.ArtAllowed(key)
	return not Q.IsClassicEra() or Q.CLASSIC_ERA_ART[key] == true
end

function Q.SetArt(tex, key, useSize)
	local name = Q.QUEST_ART[key]
	local ok = name ~= nil and Q.ArtAllowed(key) and Q.AtlasExists(name) and pcall(tex.SetAtlas, tex, name, useSize)
	ui.art = ui.art or {}
	ui.art[key] = ok and name or false
	return ok and true or false
end

function Q.FontObject(name, fallback)
	return _G[name] ~= nil and name or fallback
end

function Q.FolderKey(c)
	local name = FolderName(Cli.ProjectOf(c))
	return name ~= "" and name or Q.NO_FOLDER
end

function Q.DeleteButton(parent)
	local del = CreateFrame("Button", nil, parent)
	del:SetSize(16, 16)
	if Q.AtlasExists("128-RedButton-Delete") then
		del:SetNormalAtlas("128-RedButton-Delete")
		del:SetPushedAtlas("128-RedButton-Delete-Pressed")
		del:SetHighlightAtlas("128-RedButton-Delete-Highlight")
	else
		del:SetNormalTexture("Interface\\Buttons\\UI-GroupLoot-Pass-Up")
		del:SetHighlightTexture("Interface\\Buttons\\UI-GroupLoot-Pass-Highlight")
	end
	del:SetScript("OnClick", function() ClaudeWoW.ConfirmDelete(parent.chatId) end)
	del:SetScript("OnEnter", function(self)
		GameTooltip:SetOwner(self, "ANCHOR_RIGHT")
		GameTooltip:SetText("Delete this chat")
		GameTooltip:Show()
	end)
	del:SetScript("OnLeave", function(self)
		GameTooltip:Hide()
		if not Try(parent.IsMouseOver, parent) then self:Hide() end
	end)
	del:Hide()
	return del
end

function Q.ChatRowClicks(row)
	row:RegisterForClicks("LeftButtonUp", "RightButtonUp")
	row:SetScript("OnClick", function(self, button)
		if button == "RightButton" then
			ClaudeWoW.ShowChatMenu(self.chatId, self)
		else
			ClaudeWoW.SwitchChat(self.chatId)
		end
	end)
	row:SetScript("OnDoubleClick", function(self)
		ClaudeWoW.SwitchChat(self.chatId)
		ClaudeWoW.RenamePrompt(self.chatId)
	end)
end

function Q.Color(name, r, g, b)
	local c = _G[name]
	if type(c) == "table" and type(c.GetRGB) == "function" then return c:GetRGB() end
	return r, g, b
end

function Q.PreviewsOn()
	return db.settings.chatPreviews ~= false
end

function Q.ChatObjectives(c)
	if c.pendingId then return { "Working: " .. ActivityLine(c) } end
	local last, count = nil, 0
	for _, m in ipairs(c.history) do
		if m.role == "user" or m.role == "assistant" then
			last = m
			count = count + 1
		end
	end
	if not last then return { "No messages yet" } end
	local who = last.role == "user" and "You" or ReplyAgentName(c, last.agent)
	local first = tostring(last.text or ""):match("^%s*([^\n]*)") or ""
	return {
		who .. ": " .. first,
		count .. (count == 1 and " message" or " messages") .. (last.t and (", last at " .. date("%H:%M", last.t)) or ""),
	}
end

function Q.PoiState(poi, glyphKey, number, selected)
	if not Q.SetArt(poi.bg, selected and "poiSelected" or "poi", true) then Q.SetArt(poi.bg, "poi", true) end
	poi.outer:SetShown(selected)
	if glyphKey then
		poi.glyph:SetShown(Q.SetArt(poi.glyph, glyphKey, true))
		poi.number:Hide()
	else
		poi.glyph:Hide()
		poi.number:SetText(number)
		poi.number:Show()
	end
end

function Q.Poi(parent)
	local poi = CreateFrame("Button", nil, parent)
	poi:SetSize(20, 20)
	poi.outer = poi:CreateTexture(nil, "BACKGROUND")
	poi.outer:SetPoint("CENTER")
	if Q.SetArt(poi.outer, "poiOuter", true) then poi.outer:SetBlendMode("ADD") end
	poi.outer:Hide()
	poi.bg = poi:CreateTexture(nil, "BORDER")
	poi.bg:SetPoint("CENTER")
	poi.glyph = poi:CreateTexture(nil, "ARTWORK", nil, 1)
	poi.glyph:SetPoint("CENTER")
	poi.number = poi:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
	poi.number:SetPoint("CENTER", poi, "CENTER", 0, 0)
	local inner = poi:CreateTexture(nil, "HIGHLIGHT")
	inner:SetPoint("CENTER")
	if Q.SetArt(inner, "poiInner", true) then inner:SetBlendMode("ADD") end
	poi:SetScript("OnMouseDown", function(self)
		self.glyph:SetPoint("CENTER", 1, -1)
		self.number:SetPoint("CENTER", self, "CENTER", 1, -1)
		Q.SetArt(self.bg, "poiPushed", true)
	end)
	poi:SetScript("OnMouseUp", function(self)
		self.glyph:SetPoint("CENTER")
		self.number:SetPoint("CENTER", self, "CENTER", 0, 0)
		local row = self:GetParent()
		Q.SetArt(self.bg, row.active and "poiSelected" or "poi", true)
	end)
	poi:SetScript("OnClick", function(self) ClaudeWoW.SwitchChat(self:GetParent().chatId) end)
	return poi
end

function Q.Objective(r, k)
	local line = r.objectives[k]
	if line then return line end
	local font = Q.FontObject("ObjectiveFont", "GameFontHighlightSmall")
	line = {
		dash = r:CreateFontString(nil, "OVERLAY", font),
		text = r:CreateFontString(nil, "OVERLAY", font),
	}
	line.dash:SetText(_G.QUEST_DASH or "- ")
	line.text:SetPoint("TOPLEFT", line.dash, "TOPRIGHT", 0, 0)
	line.text:SetJustifyH("LEFT")
	line.text:SetWordWrap(false)
	r.objectives[k] = line
	return line
end

function Q.RowColors(r, hover)
	local c = hover and { 1, 1, 1 } or r.titleColor
	r.title:SetTextColor(c[1], c[2], c[3])
	local or_, og, ob
	if hover then
		or_, og, ob = Q.Color("QUEST_OBJECTIVE_HIGHLIGHT_FONT_COLOR", 1, 1, 1)
	else
		or_, og, ob = Q.Color("QUEST_OBJECTIVE_FONT_COLOR", 0.8, 0.8, 0.8)
	end
	for _, line in ipairs(r.objectives) do
		line.dash:SetTextColor(or_, og, ob)
		line.text:SetTextColor(or_, og, ob)
	end
end

function Q.QuestRow(i)
	local q = ui.questList
	local r = q.rows[i]
	if r then return r end
	r = CreateFrame("Button", nil, q.content)
	r.objectives = {}
	r.glow = r:CreateTexture(nil, "BACKGROUND")
	r.glow:SetAllPoints()
	if not Q.SetArt(r.glow, "rowGlow") then r.glow:SetColorTexture(1, 0.82, 0, 0.12) end
	r.glow:Hide()
	r.poi = Q.Poi(r)
	r.poi:SetPoint("TOPLEFT", r, "TOPLEFT", 6, -4)
	r.del = Q.DeleteButton(r)
	r.del:SetPoint("TOPRIGHT", r, "TOPRIGHT", -2, -Q.ROW_TOP + 2)
	r.title = r:CreateFontString(nil, "OVERLAY", Q.FontObject("GameFontNormalLeft", "GameFontNormalSmall"))
	r.title:SetPoint("TOPLEFT", r, "TOPLEFT", Q.ROW_TITLE_X, -Q.ROW_TOP)
	r.title:SetPoint("RIGHT", r, "RIGHT", -22, 0)
	r.title:SetJustifyH("LEFT")
	r.title:SetWordWrap(false)
	r.label = r.title
	Q.ChatRowClicks(r)
	r:SetScript("OnEnter", function(self)
		self.del:Show()
		Q.RowColors(self, true)
	end)
	r:SetScript("OnLeave", function(self)
		if not Try(self.del.IsMouseOver, self.del) then self.del:Hide() end
		Q.RowColors(self, false)
	end)
	q.rows[i] = r
	return r
end

function Q.FillRow(r, c, index, width)
	local active = c.id == db.activeChat
	local unread = c.unread or 0
	r.chatId = c.id
	r.poi.chatId = c.id
	r.active = active
	r:SetWidth(width)
	r.glow:SetShown(active)
	local title = Display(c.name)
	if c.agent and c.agent ~= "" then title = title .. " |cff9d9d9d" .. AgentName(c.agent) .. "|r" end
	if unread > 0 then title = title .. " (" .. unread .. ")" end
	r.title:SetText(title)
	r.titleColor = active and { 1, 1, 1 } or (unread > 0 and Q.TITLE_REPLY) or (c.pendingId and Q.TITLE_WORKING) or Q.TITLE_IDLE
	local glyph = (c.pendingId and (active and "workingSelected" or "working")) or (unread > 0 and "reply") or nil
	Q.PoiState(r.poi, glyph, tostring(index), active)
	local lines = Q.PreviewsOn() and Q.ChatObjectives(c) or {}
	local textW = width - Q.ROW_TITLE_X - 22
	local titleH = Try(r.title.GetStringHeight, r.title) or 14
	if titleH < 1 then titleH = 14 end
	local y = Q.ROW_TOP + titleH + Q.OBJECTIVE_GAP
	for k, text in ipairs(lines) do
		local line = Q.Objective(r, k)
		line.dash:ClearAllPoints()
		line.dash:SetPoint("TOPLEFT", r, "TOPLEFT", Q.ROW_TITLE_X, -y)
		line.text:SetWidth(textW - 8)
		line.text:SetText(Display(text))
		line.dash:Show()
		line.text:Show()
		local h = Try(line.text.GetStringHeight, line.text) or 12
		if h < 1 then h = 12 end
		y = y + h + Q.OBJECTIVE_LINE_GAP
	end
	for k = #lines + 1, #r.objectives do
		r.objectives[k].dash:Hide()
		r.objectives[k].text:Hide()
	end
	local height = #lines > 0 and (y - Q.OBJECTIVE_LINE_GAP + Q.ROW_BOTTOM) or (Q.ROW_TOP + titleH + Q.ROW_BOTTOM_BARE)
	r:SetHeight(height)
	Q.RowColors(r, false)
	return height
end

function Q.QuestHeader(i)
	local q = ui.questList
	local h = q.headers[i]
	if h then return h end
	h = CreateFrame("Button", nil, q.content)
	h:SetHeight(Q.LIST_HEADER_H)
	local bg = h:CreateTexture(nil, "BACKGROUND")
	bg:SetAllPoints()
	if not Q.SetArt(bg, "header") then bg:SetColorTexture(0.25, 0.18, 0.08, 0.6) end
	local hl = h:CreateTexture(nil, "HIGHLIGHT")
	hl:SetAllPoints()
	if Q.SetArt(hl, "header") then
		hl:SetBlendMode("ADD")
		hl:SetAlpha(0.4)
	else
		hl:SetColorTexture(1, 1, 1, 0.08)
	end
	h.collapse = CreateFrame("Button", nil, h)
	h.collapse:SetSize(20, 20)
	h.collapse:SetPoint("RIGHT", h, "RIGHT", -6, 0)
	h.icon = h.collapse:CreateTexture(nil, "ARTWORK")
	h.icon:SetPoint("CENTER")
	h.iconHighlight = h.collapse:CreateTexture(nil, "HIGHLIGHT")
	h.iconHighlight:SetPoint("CENTER")
	h.text = h:CreateFontString(nil, "OVERLAY", Q.FontObject("Game15Font_Shadow", "GameFontNormal"))
	h.text:SetPoint("LEFT", h, "LEFT", 8, 1)
	h.text:SetPoint("RIGHT", h.collapse, "LEFT", -4, 0)
	h.text:SetJustifyH("LEFT")
	h.text:SetWordWrap(false)
	local function Toggle(self)
		local header = self.key and self or self:GetParent()
		local collapsed = db.settings.collapsedFolders or {}
		db.settings.collapsedFolders = collapsed
		collapsed[header.key] = (not collapsed[header.key]) or nil
		ClaudeWoW.RenderChatList()
	end
	h:SetScript("OnClick", Toggle)
	h.collapse:SetScript("OnClick", Toggle)
	h:SetScript("OnEnter", function(self) self.text:SetTextColor(Q.Color("HIGHLIGHT_FONT_COLOR", 1, 1, 1)) end)
	h:SetScript("OnLeave", function(self) self.text:SetTextColor(Q.Color("DISABLED_FONT_COLOR", 0.5, 0.5, 0.5)) end)
	h:SetScript("OnMouseDown", function(self) self.text:SetPoint("LEFT", self, "LEFT", 9, 0) end)
	h:SetScript("OnMouseUp", function(self) self.text:SetPoint("LEFT", self, "LEFT", 8, 1) end)
	h.text:SetTextColor(Q.Color("DISABLED_FONT_COLOR", 0.5, 0.5, 0.5))
	q.headers[i] = h
	return h
end

function Q.SetHeaderIcon(h, collapsed)
	local key = collapsed and "plus" or "minus"
	if Q.SetArt(h.icon, key, true) then
		Q.SetArt(h.iconHighlight, key, true)
		h.iconHighlight:SetBlendMode("ADD")
		h.iconHighlight:SetAlpha(0.4)
	else
		h.icon:SetSize(14, 14)
		h.icon:SetTexture(collapsed and "Interface\\Buttons\\UI-PlusButton-Up" or "Interface\\Buttons\\UI-MinusButton-Up")
	end
end

function ClaudeWoW.RenderQuestList()
	local q = ui.questList
	local filter = ui.chatFilter or ""
	local collapsed = db.settings.collapsedFolders or {}
	local groups, order = {}, {}
	for _, c in ipairs(Q.NewestFirst(db.chats)) do
		local key = Q.FolderKey(c)
		if not groups[key] then
			groups[key] = {}
			table.insert(order, key)
		end
		table.insert(groups[key], c)
	end
	for i, key in ipairs(order) do
		if key == Q.NO_FOLDER and i > 1 then
			table.remove(order, i)
			table.insert(order, 1, key)
			break
		end
	end
	local width = Try(q.scroll.GetWidth, q.scroll) or (Q.LIST_W - 32)
	if width < 80 then width = Q.LIST_W - 32 end
	q.content:SetWidth(width)
	local y, nh, nr, matched, index = 0, 0, 0, 0, 0
	local last, activeTop, activeBottom
	for _, key in ipairs(order) do
		local matches = {}
		for _, c in ipairs(groups[key]) do
			if filter == "" or tostring(c.name or ""):lower():find(filter, 1, true) then table.insert(matches, c) end
		end
		if #matches > 0 then
			matched = matched + #matches
			y = y + ((last == nil and Q.PAD_FIRST) or (last == "header" and Q.PAD_HEADER_AFTER_HEADER) or Q.PAD_HEADER_AFTER_ROW)
			nh = nh + 1
			local h = Q.QuestHeader(nh)
			local closed = filter == "" and collapsed[key] == true
			h.key = key
			h.collapsed = closed
			h.text:SetText(Display(key))
			Q.SetHeaderIcon(h, closed)
			h:SetWidth(width - Q.HEADER_INSET - Q.HEADER_RIGHT)
			h:ClearAllPoints()
			h:SetPoint("TOPLEFT", q.content, "TOPLEFT", Q.HEADER_INSET, -y)
			h:Show()
			y = y + Q.LIST_HEADER_H
			last = "header"
			if not closed then
				for _, c in ipairs(matches) do
					index = index + 1
					y = y + (last == "header" and Q.PAD_ROW_AFTER_HEADER or Q.PAD_ROW_AFTER_ROW)
					nr = nr + 1
					local r = Q.QuestRow(nr)
					local height = Q.FillRow(r, c, index, width)
					r:ClearAllPoints()
					r:SetPoint("TOPLEFT", q.content, "TOPLEFT", 0, -y)
					r:Show()
					if r.active then activeTop, activeBottom = y, y + height end
					y = y + height
					last = "row"
				end
			else
				index = index + #matches
			end
		end
	end
	for i = nh + 1, #q.headers do q.headers[i]:Hide() end
	for i = nr + 1, #q.rows do q.rows[i]:Hide() end
	q.empty:SetShown(filter ~= "" and matched == 0)
	q.content:SetHeight(math.max(y + Q.PAD_FIRST, 1))
	if activeTop and q.shownActive ~= db.activeChat then
		q.shownActive = db.activeChat
		Q.RevealRow(q, activeTop, activeBottom)
	end
	ui.chatCount:SetText("Chats: |cffffffff" .. #db.chats .. "|r")
end

function Q.NewestFirst(chats)
	local sorted, rank = {}, {}
	for i, c in ipairs(chats) do
		local last = c.history and c.history[#c.history]
		rank[c] = { t = tonumber(last and last.t) or tonumber(c.created) or 0, i = i }
		table.insert(sorted, c)
	end
	table.sort(sorted, function(a, b)
		if rank[a].t ~= rank[b].t then return rank[a].t > rank[b].t end
		return rank[a].i > rank[b].i
	end)
	return sorted
end

function Q.RevealRow(q, top, bottom)
	local view = Try(q.scroll.GetHeight, q.scroll) or 0
	if view <= 0 then return end
	pcall(q.scroll.UpdateScrollChildRect, q.scroll)
	local current = Try(q.scroll.GetVerticalScroll, q.scroll) or 0
	local target = current
	if top < current then
		target = math.max(0, top - Q.LIST_HEADER_H - Q.PAD_FIRST - Q.PAD_ROW_AFTER_HEADER)
	elseif bottom > current + view then
		target = bottom - view
	end
	if target ~= current then pcall(q.scroll.SetVerticalScroll, q.scroll, target) end
end

function Q.ListSettingsMenu(anchor)
	local s = db.settings
	local function SetAll(value)
		local collapsed = {}
		if value then
			for _, c in ipairs(db.chats) do collapsed[Q.FolderKey(c)] = true end
		end
		s.collapsedFolders = collapsed
		ClaudeWoW.RenderChatList()
	end
	local function TogglePreviews()
		s.chatPreviews = not Q.PreviewsOn()
		ClaudeWoW.RenderChatList()
	end
	if type(MenuUtil) == "table" and type(MenuUtil.CreateContextMenu) == "function" then
		local shown = pcall(MenuUtil.CreateContextMenu, anchor, function(_, root)
			root:CreateCheckbox("Show message previews", Q.PreviewsOn, TogglePreviews)
			if ClaudeWoWOrders then root:CreateCheckbox("Show the Orders card", ClaudeWoWOrders.IsOn, ClaudeWoWOrders.Toggle) end
			if ClaudeWoWTelemetry then root:CreateCheckbox("Send game state, prices and loot to Claude", ClaudeWoWTelemetry.IsOn, ClaudeWoWTelemetry.Toggle) end
			root:CreateDivider()
			root:CreateButton("Commands and tips", function() ClaudeWoW.ShowHelp() end)
			root:CreateButton("Expand all folders", function() SetAll(false) end)
			root:CreateButton("Collapse all folders", function() SetAll(true) end)
		end)
		if shown then return end
	end
	TogglePreviews()
end

function Q.ChatDetails(c)
	local folder = FolderName(ChatFolder(c))
	local agent = AgentName((c and c.agent ~= "" and c.agent) or run.bridgeAgent)
	local plugin = (c and (c.plugin or "") ~= "" and c.plugin) or run.bridgePlugin or "default"
	return {
		{ "Folder", folder ~= "" and Display(folder) or "none" },
		{ "Agent", agent },
		{ "Plugin", Display(plugin) },
	}
end

function ClaudeWoW.RefreshTitleBar()
	local label = ui.chatTitle
	if not label then return end
	local c = ActiveChat()
	label:SetText(c and Display(c.name) or "Claude WoW")
end

function Q.TitleBarTooltip(bar)
	local c = ActiveChat()
	if not c then return end
	GameTooltip:SetOwner(bar, "ANCHOR_BOTTOMLEFT", 0, 0)
	GameTooltip:SetText(Display(c.name))
	for _, row in ipairs(Q.ChatDetails(c)) do GameTooltip:AddDoubleLine(row[1], row[2], 1, 0.82, 0, 1, 1, 1) end
	GameTooltip:AddLine("Click to rename. Right-click for chat options.", 0.6, 0.6, 0.6, true)
	GameTooltip:Show()
end

function Q.BuildQuestFrames(f)
	local list = CreateFrame("Frame", nil, f)
	list:SetPoint("TOPRIGHT", f, "TOPRIGHT", -6, Q.NAV_TOP)
	list:SetPoint("BOTTOMRIGHT", f, "BOTTOMRIGHT", -6, 28)
	list:SetWidth(Q.LIST_W)
	ui.listPanel = list

	local gear = CreateFrame("Button", "ClaudeWoWChatSettings", list)
	gear:SetSize(15, 16)
	gear:SetPoint("TOPRIGHT", list, "TOPRIGHT", -4, -10)
	local gearIcon = gear:CreateTexture(nil, "ARTWORK")
	gearIcon:SetAllPoints()
	if not Q.SetArt(gearIcon, "gear") then
		if Q.IsClassicEra() then
			gearIcon:SetTexture(Q.CLASSIC_ERA_GEAR)
			gearIcon:SetTexCoord(0.08, 0.92, 0.08, 0.92)
		else
			gearIcon:SetTexture("Interface\\Buttons\\UI-OptionsButton")
		end
	end
	local gearHl = gear:CreateTexture(nil, "HIGHLIGHT")
	gearHl:SetAllPoints()
	if Q.SetArt(gearHl, "gear") then
		gearHl:SetBlendMode("ADD")
		gearHl:SetAlpha(0.4)
	end
	gear:SetScript("OnMouseDown", function() gearIcon:SetPoint("TOPLEFT", gear, "TOPLEFT", 1, -1) end)
	gear:SetScript("OnMouseUp", function() gearIcon:SetAllPoints() end)
	gear:SetScript("OnClick", function(self) Q.ListSettingsMenu(self) end)
	gear:SetScript("OnEnter", function(self)
		GameTooltip:SetOwner(self, "ANCHOR_RIGHT")
		GameTooltip:SetText("Chat list options")
		GameTooltip:Show()
	end)
	gear:SetScript("OnLeave", function() GameTooltip:Hide() end)
	ui.listSettings = gear

	local countBox = CreateFrame("Frame", "ClaudeWoWChatCount", list, Q.TemplateExists("InsetFrameTemplate3") and "InsetFrameTemplate3" or "InsetFrameTemplate")
	countBox:SetSize(Q.COUNT_W, 20)
	countBox:SetPoint("RIGHT", gear, "LEFT", -6, 0)
	local count = countBox:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
	count:SetPoint("CENTER", countBox, "CENTER", 0, 0)
	ui.chatCount = count

	local search = CreateFrame("EditBox", "ClaudeWoWChatSearch", list, Q.TemplateExists("SearchBoxTemplate") and "SearchBoxTemplate" or "InputBoxTemplate")
	search:SetHeight(20)
	search:SetPoint("LEFT", list, "LEFT", 10, 0)
	search:SetPoint("TOP", countBox, "TOP", 0, 0)
	search:SetPoint("RIGHT", countBox, "LEFT", -6, 0)
	search:SetAutoFocus(false)
	if type(search.Instructions) == "table" then search.Instructions:SetText("Search Chats") end
	search:HookScript("OnTextChanged", function(self)
		ui.chatFilter = Trim(self:GetText() or ""):lower()
		ClaudeWoW.RenderChatList()
	end)
	ui.search = search

	local newChat = MakeButton(list, "New chat", Q.LIST_W - 12, function() ClaudeWoW.NewChat() end)
	newChat:SetPoint("BOTTOM", list, "BOTTOM", 0, 2)
	ui.newChat = newChat

	local listScroll = CreateFrame("ScrollFrame", "ClaudeWoWChatScroll", list, Q.TemplateExists("ScrollFrameTemplate") and "ScrollFrameTemplate" or "UIPanelScrollFrameTemplate")
	listScroll:SetPoint("TOPLEFT", list, "TOPLEFT", 6, -40)
	listScroll:SetPoint("BOTTOMRIGHT", list, "BOTTOMRIGHT", -20, 34)
	local listBg = list:CreateTexture(nil, "BACKGROUND", nil, 1)
	listBg:SetPoint("TOPLEFT", listScroll, "TOPLEFT", 0, 0)
	listBg:SetPoint("BOTTOMRIGHT", listScroll, "BOTTOMRIGHT", 16, 0)
	if not Q.SetArt(listBg, "listBg") then listBg:SetColorTexture(0.06, 0.05, 0.04, 0.9) end
	local listContent = CreateFrame("Frame", "ClaudeWoWChatListContent", listScroll)
	listContent:SetSize(Q.LIST_W - 32, 1)
	listScroll:SetScrollChild(listContent)
	local empty = listContent:CreateFontString(nil, "OVERLAY", "GameFontNormal")
	empty:SetPoint("TOP", listContent, "TOP", 0, -20)
	empty:SetWidth(Q.LIST_W - 60)
	empty:SetText("There are no chats that match your search.")
	empty:Hide()
	ui.questList = { scroll = listScroll, content = listContent, headers = {}, rows = {}, empty = empty }

	local border = CreateFrame("Frame", "ClaudeWoWChatBorder", list)
	border:SetPoint("TOPLEFT", listScroll, "TOPLEFT", -3, 7)
	border:SetPoint("BOTTOMRIGHT", listScroll, "BOTTOMRIGHT", 19, -6)
	border:SetFrameLevel((Try(listScroll.GetFrameLevel, listScroll) or 1) + 20)
	border:EnableMouse(false)
	local edge = border:CreateTexture(nil, "BORDER")
	edge:SetAllPoints()
	if Q.SetArt(edge, "frame") then
		local filigree = border:CreateTexture(nil, "ARTWORK")
		filigree:SetPoint("TOP", border, "TOP", 0, 1)
		Q.SetArt(filigree, "filigree", true)
		local gradient = border:CreateTexture(nil, "BACKGROUND")
		gradient:SetPoint("BOTTOM", border, "BOTTOM", 0, 4)
		Q.SetArt(gradient, "gradient", true)
	else
		edge:Hide()
		local inset = Q.Panel(list, true)
		inset:SetAllPoints(border)
		inset:SetFrameLevel((Try(listScroll.GetFrameLevel, listScroll) or 1) - 1)
	end
	ui.listBorder = border

	local parchment = Q.Panel(f, true)
	parchment:SetPoint("TOPLEFT", f, "TOPLEFT", 8, Q.NAV_TOP - Q.NAV_H - 2)
	parchment:SetPoint("BOTTOMRIGHT", list, "BOTTOMLEFT", -6, 52)
	local paper = parchment:CreateTexture(nil, "BACKGROUND", nil, 1)
	paper:SetPoint("TOPLEFT", parchment, "TOPLEFT", 3, -3)
	paper:SetPoint("BOTTOMRIGHT", parchment, "BOTTOMRIGHT", -3, 3)
	if not Q.SetArt(paper, "parchment") and not Q.ClassicParchment(paper) then paper:SetColorTexture(0.80, 0.70, 0.52, 1) end
	ui.parchment = parchment
	ui.transcriptPanel = parchment

	local bar = CreateFrame("Button", "ClaudeWoWTitleBar", f, Q.TemplateExists("NavBarTemplate") and "NavBarTemplate" or nil)
	bar:SetPoint("TOPLEFT", f, "TOPLEFT", 60, Q.NAV_TOP)
	bar:SetPoint("RIGHT", list, "LEFT", -6, 0)
	bar:SetHeight(Q.NAV_H)
	for _, key in ipairs({ "home", "overflow" }) do
		if type(bar[key]) == "table" and bar[key].Hide then bar[key]:Hide() end
	end
	local label = bar:CreateFontString(nil, "OVERLAY", "GameFontNormalLarge")
	label:SetPoint("LEFT", bar, "LEFT", 12, 0)
	label:SetPoint("RIGHT", bar, "RIGHT", -12, 0)
	label:SetJustifyH("LEFT")
	label:SetWordWrap(false)
	bar:RegisterForClicks("LeftButtonUp", "RightButtonUp")
	bar:SetScript("OnClick", function(self, button)
		local c = ActiveChat()
		if not c then return end
		GameTooltip:Hide()
		if button == "RightButton" then ClaudeWoW.ShowChatMenu(c.id, self) else ClaudeWoW.RenamePrompt(c.id) end
	end)
	bar:SetScript("OnEnter", Q.TitleBarTooltip)
	bar:SetScript("OnLeave", function() GameTooltip:Hide() end)
	ui.titleBar = bar
	ui.chatTitle = label
	ClaudeWoW.RefreshTitleBar()
end

function Q.Panel(parent, native)
	local p = CreateFrame("Frame", nil, parent, native and "InsetFrameTemplate" or "BackdropTemplate")
	if not native then
		p:SetBackdrop({
			bgFile = "Interface\\ChatFrame\\ChatFrameBackground",
			edgeFile = "Interface\\Tooltips\\UI-Tooltip-Border",
			tile = true, tileSize = 16, edgeSize = 12,
			insets = { left = 3, right = 3, top = 3, bottom = 3 },
		})
		p:SetBackdropColor(0, 0, 0, 0.4)
		p:SetBackdropBorderColor(0.4, 0.4, 0.4, 1)
	end
	return p
end

local function BuildUI()
	if ui.frame then return end
	local s = db.settings
	local native = Q.NativeFrames()
	ui.native = native

	local f = CreateFrame("Frame", "ClaudeWoWFrame", UIParent, native and "ButtonFrameTemplate" or "BackdropTemplate")
	ui.frame = f
	f.claudewowNative = native
	f:SetSize(s.width, s.height)
	f:SetPoint("CENTER")
	f:SetFrameStrata("DIALOG")
	f:SetResizable(true)
	f:SetClampedToScreen(true)
	f:SetResizeBounds(560, 300)
	f:EnableMouse(true)
	if native then
		Try(f.SetPortraitToAsset, f, Q.PORTRAIT)
		if type(f.Inset) == "table" then f.Inset:Hide() end
	else
		f:SetBackdrop(BACKDROP)
		f:SetBackdropColor(0.05, 0.05, 0.07, 0.95)
		f:SetBackdropBorderColor(0.6, 0.6, 0.6, 1)
	end
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
			if ui.native then
				Q.StatusTooltip()
				if ui.cwd then GameTooltip:AddLine(ui.cwd:GetText(), 0.6, 0.6, 0.6, true) end
			end
			GameTooltip:Show()
		end)
		holder:SetScript("OnLeave", function() GameTooltip:Hide() end)
		return holder, dot
	end

	local dotHolder, dot = MakeDot(f)
	ui.dot = dot
	ui.dotHolder = dotHolder

	local nativeTitle = native and Try(f.GetTitleText, f)
	local title = nativeTitle or f:CreateFontString(nil, "OVERLAY", "GameFontNormalLarge")
	if not nativeTitle then title:SetPoint("LEFT", dotHolder, "RIGHT", 6, 0) end
	title:SetText("Claude WoW")
	ui.title = title

	local status = f:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
	status:SetPoint("RIGHT", f, "RIGHT", -60, 0)
	status:SetJustifyH("LEFT")
	ui.status = status
	if native then
		dotHolder:SetPoint("BOTTOMLEFT", f, "BOTTOMLEFT", 12, 6)
		dotHolder:SetHitRectInsets(0, -Q.STATUS_HIT_W, -4, -4)
		status:ClearAllPoints()
		status:SetPoint("LEFT", dotHolder, "RIGHT", 6, 0)
		status:SetWidth(Q.STATUS_HIT_W)
		status:SetWordWrap(false)
		local stats = f:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
		stats:SetPoint("BOTTOMRIGHT", f, "BOTTOMRIGHT", -26, 9)
		stats:SetJustifyH("RIGHT")
		ui.stats = stats
		ui.ctxBar = Q.ContextBar(f)
	else
		dotHolder:SetPoint("TOPLEFT", f, "TOPLEFT", 14, -16)
		status:SetPoint("TOPLEFT", f, "TOPLEFT", 14, -34)
	end

	-- Minimize button in the corner where a close X would be: this window is never
	-- closed from here, only collapsed to the mini bar (Esc does the same, see OnHide).
	-- The mini bar's own X is the one that hides everything.
	local mini = native and type(f.CloseButton) == "table" and f.CloseButton or nil
	if not mini and Q.AtlasExists("RedButton-MiniCondense") then
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
	if mini ~= rawget(f, "CloseButton") then mini:SetPoint("TOPRIGHT", f, "TOPRIGHT", -4, -4) end
	ui.minimize = mini
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
	if native then Q.BuildQuestFrames(f) end
	local panel = Q.Panel(f, false)
	panel:SetPoint("TOPLEFT", f, "TOPLEFT", 14, -52)
	panel:SetPoint("BOTTOMLEFT", f, "BOTTOMLEFT", 14, 50)
	panel:SetWidth(PANEL_W)
	if native then panel:Hide() else ui.listPanel = panel end

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
		if ui.native and type(MenuUtil) == "table" and type(MenuUtil.CreateContextMenu) == "function" then
			local shown = pcall(MenuUtil.CreateContextMenu, anchor, function(_, root)
				root:CreateTitle(Display(c.name))
				root:CreateButton("Rename...", function() ClaudeWoW.RenamePrompt(chatId) end)
				root:CreateButton("Folder...", function() ClaudeWoW.FolderPrompt(chatId) end)
				root:CreateButton("Agent...", function() ClaudeWoW.AgentPrompt(chatId) end)
				root:CreateButton("Plugin...", function() ClaudeWoW.PluginPrompt(chatId) end)
				root:CreateDivider()
				root:CreateButton("Clear messages", function() ClaudeWoW.ClearChat(chatId) end)
				root:CreateButton("|cffff4040Delete|r", function() ClaudeWoW.ConfirmDelete(chatId) end)
			end)
			if shown then return end
		end
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
	for i = 1, Q.CHAT_PAGE do
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
	local function PageButton(label, delta)
		local pb = MakeButton(panel, label, 28, function()
			ui.chatPage = (ui.chatPage or 1) + delta
			ClaudeWoW.RenderChatList()
		end)
		pb:SetHeight(18)
		return pb
	end
	ui.pagePrev = PageButton("<", -1)
	ui.pagePrev:SetPoint("BOTTOMLEFT", panel, "BOTTOMLEFT", 8, 6)
	ui.pageNext = PageButton(">", 1)
	ui.pageNext:SetPoint("BOTTOMRIGHT", panel, "BOTTOMRIGHT", -8, 6)
	ui.pageLabel = panel:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
	ui.pageLabel:SetPoint("BOTTOM", panel, "BOTTOM", 0, 10)

	-- Transcript: a scrolling stack of message bubbles
	local scroll = CreateFrame("ScrollFrame", "ClaudeWoWScroll", native and ui.parchment or f, (native and Q.TemplateExists("ScrollFrameTemplate")) and "ScrollFrameTemplate" or "UIPanelScrollFrameTemplate")
	if native then
		scroll:SetPoint("TOPLEFT", ui.parchment, "TOPLEFT", 22, -16)
		scroll:SetPoint("BOTTOMRIGHT", ui.parchment, "BOTTOMRIGHT", -34, 14)
	else
		scroll:SetPoint("TOPLEFT", panel, "TOPRIGHT", 8, 0)
		scroll:SetPoint("BOTTOMRIGHT", f, "BOTTOMRIGHT", -32, 110)
	end
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
	local inputBg = Q.Panel(f, native)
	if native then
		inputBg:SetPoint("TOPLEFT", ui.parchment, "BOTTOMLEFT", 0, -4)
		inputBg:SetPoint("BOTTOMRIGHT", ui.listPanel, "BOTTOMLEFT", -6 - SEND_W - 6, 0)
	else
		inputBg:SetPoint("BOTTOMLEFT", panel, "BOTTOMRIGHT", 8, 0)
		inputBg:SetPoint("BOTTOMRIGHT", f, "BOTTOMRIGHT", -14 - SEND_W - 6, 50)
		inputBg:SetHeight(54)
	end
	if not native then
		inputBg:SetBackdropColor(0, 0, 0, 0.6)
		inputBg:SetBackdropBorderColor(0.5, 0.5, 0.5, 1)
	end

	local plainInput = native and type(ScrollingEdit_OnCursorChanged) == "function" and type(ScrollingEdit_OnTextChanged) == "function"
	local inScroll = CreateFrame("ScrollFrame", "ClaudeWoWInputScroll", inputBg, (not plainInput) and "UIPanelScrollFrameTemplate" or nil)
	inScroll:SetPoint("TOPLEFT", inputBg, "TOPLEFT", 8, -6)
	inScroll:SetPoint("BOTTOMRIGHT", inputBg, "BOTTOMRIGHT", plainInput and -8 or -24, 6)

	local input = CreateFrame("EditBox", "ClaudeWoWInput", inScroll)
	input:SetMultiLine(true)
	input:SetAutoFocus(false)
	input:SetFontObject(ChatFontNormal)
	input:SetMaxLetters(0)
	input:SetSize(500, 40)
	input:SetScript("OnEnterPressed", function() ClaudeWoW.SendFromInput() end)
	input:SetScript("OnEscapePressed", function(self) self:ClearFocus() end)
	if plainInput then
		input:SetScript("OnCursorChanged", ScrollingEdit_OnCursorChanged)
		input:SetScript("OnTextChanged", ScrollingEdit_OnTextChanged)
		if type(ScrollingEdit_OnUpdate) == "function" then input:SetScript("OnUpdate", ScrollingEdit_OnUpdate) end
	end
	inScroll:SetScrollChild(input)
	inScroll:HookScript("OnSizeChanged", function(self, w, h)
		input:SetWidth(w)
	end)
	inputBg:SetScript("OnMouseDown", function() input:SetFocus() end)
	ui.input = input

	local projectButton = CreateFrame("Button", "ClaudeWoWProjectButton", inputBg)
	projectButton:SetSize(120, 16)
	projectButton:SetPoint("BOTTOMRIGHT", inputBg, "BOTTOMRIGHT", -6, 4)
	projectButton:SetFrameLevel((Try(inputBg.GetFrameLevel, inputBg) or 1) + 5)
	projectButton.text = projectButton:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
	projectButton.text:SetPoint("RIGHT", projectButton, "RIGHT", -2, 0)
	projectButton.text:SetJustifyH("RIGHT")
	local projectHl = projectButton:CreateTexture(nil, "HIGHLIGHT")
	projectHl:SetAllPoints()
	projectHl:SetColorTexture(1, 1, 1, 0.08)
	projectButton:SetScript("OnClick", function(self) Cli.ProjectMenu(self) end)
	projectButton:SetScript("OnEnter", function(self)
		GameTooltip:SetOwner(self, "ANCHOR_TOP")
		GameTooltip:SetText("Project")
		GameTooltip:AddLine("The repo this chat works in. No project = a general chat. You can also type #name in a message or use /claude --project <name>.", 0.8, 0.8, 0.8, true)
		GameTooltip:Show()
	end)
	projectButton:SetScript("OnLeave", function() GameTooltip:Hide() end)
	ui.projectButton = projectButton

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
	local clear = MakeButton(f, "Clear", 60, function() ClaudeWoW.ClearChat() end)
	clear:SetPoint("BOTTOMLEFT", f, "BOTTOMLEFT", 14, 16)

	local resend = MakeButton(f, "Resend", 70, ClaudeWoW.Resend)
	resend:SetPoint("LEFT", clear, "RIGHT", 6, 0)
	resend:Hide()
	ui.resend = resend
	if native then
		clear:Hide()
		resend:ClearAllPoints()
		resend:SetPoint("BOTTOMRIGHT", f, "BOTTOMRIGHT", -26, 4)
		refresh:ClearAllPoints()
		refresh:SetPoint("RIGHT", resend, "LEFT", -4, 0)
	end

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
	if native then cwd:Hide() end

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
	m:SetSize(200, 26)
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

	local mlabel = m:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
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
		GameTooltip:SetText("Quit: hide completely (/claude -c brings it back)")
		GameTooltip:Show()
	end)
	mclose:SetScript("OnLeave", function() GameTooltip:Hide() end)
	m:SetScript("OnEnter", function(self)
		GameTooltip:SetOwner(self, "ANCHOR_BOTTOM")
		GameTooltip:SetText("Claude WoW")
		GameTooltip:AddLine("Click: open the workspace (full transcripts, chats, settings). Drag: move.", 0.8, 0.8, 0.8, true)
		GameTooltip:AddLine((ui.dot and ui.dot.tip) or "Bridge status unknown", 0.6, 0.6, 0.6, true)
		GameTooltip:Show()
	end)
	m:SetScript("OnLeave", function() GameTooltip:Hide() end)
	if ClaudeWoWWindow then ClaudeWoWWindow.Attach(f, m, grip) end
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

function ClaudeWoW.Suspend(hidden)
	if not ui.frame or not db then return false end
	if hidden then
		if not ui.frame:IsShown() then return false end
		ui.quitting = true
		ui.frame:Hide()
		ui.quitting = nil
		return true
	end
	if not db.settings.shown or db.settings.minimized or ui.frame:IsShown() then return false end
	ui.frame:Show()
	ClaudeWoW.Render()
	return true
end

---------------------------------------------------------------------------
-- Slash commands
---------------------------------------------------------------------------

local HELP
function ClaudeWoW.ShowHelp()
	local c = ActiveChat()
	if not c then return end
	AddHistory(c, "system", HELP)
	ClaudeWoW.Render()
end
HELP = table.concat({
	"/claude <text>                     start a new chat with that message, like claude \"<text>\" in a terminal. Bare /claude in the game chat opens the workspace window; in a chat's tab it starts a new chat",
	"/claude -c [text]                  continue the current chat (--continue); alone it points at its tab (with the tabs off, it opens the window on it)",
	"/claude -r [id|name|n] [text]      resume a session (--resume). A Claude Code session started with the claude-wow channel gets the chat live; any other session is resumed headless in its folder. Bare -r lists the sessions (live ones first, marked live, running not listening, or resume): click a row or give its number; -r more lists them all",
	"/claude -n <name> [text]           name the new chat (--name); with -c it renames the current one",
	"/claude --model <model> [text]     the model for the chat (opus, sonnet, a full model name)",
	"/claude --effort <level> [text]    low, medium, high, xhigh or max",
	"/claude --project <name|path|none> [text]    attach this chat to a repo (or #name in a message); none = a general chat",
	"/claude --permission-mode <mode>   acceptEdits, auto, plan, manual, dontAsk or bypassPermissions",
	"/claude --add-dir <path> [text]    one more folder the agent may use (repeat the flag for more)",
	"/claude --agent <name> [text]      which CLI runs the chat: claude, codex, grok, agy or hermes",
	"    Flags come before the text and combine: /claude --model opus fix the build starts a new chat on opus. With -c they change the current chat. --flag=value and \"quoted values\" work, a value of - clears a setting, and a flag with no value shows it. The bridge tells you when an agent has no such option",
	"/claude orders [on|off]            show or hide the Orders card under the quest tracker",
	"/claude config [key] [value]       settings: voice, roast, whisper, echo, vision, roll, achievements, orders, telemetry, ui, map, macro, context, signal, mode, longchat, auto, bind, diag. Alone it lists them with their values",
	"/claude config ui [setting]        the tabs and the window: whisper on|off, dim <10-100>|off, dodge on|off, autohide on|off, reset",
	"/claude cd <folder>                folder this chat's agent works in (relative to the bridge's folder; alone = the default). A chat with a folder is a coding session there, one without is general in-game chat",
	"/claude look <question>            send one message to the current chat with a picture of your screen",
	"/claude rename [name]              rename the current chat (alone: a dialog)",
	"/claude delete                     delete the current chat",
	"/claude clear                      clear this chat's transcript",
	"/claude copy                       open the last reply in a selectable box for Ctrl+C",
	"/claude reset                      the next message in this chat starts a fresh session",
	"/claude cancel                     stop waiting on this chat's reply",
	"/claude resend                     show the strip again if the bridge missed it",
	"/claude reload                     reload now (also frees the slot pool)",
	"/claude slots                      how many reply slots are still free this session",
	"/claude diag [copy]                transport diagnostics; copy opens them in a box, selected for Ctrl+C",
	"/claude probe [chatlog|asyncfile]  write test lines to the client's own logs so the bridge can measure them",
	"/claude hide | mini               hide the window, or collapse it to the small bar",
	"/claude help                       this list",
	"/r <text>                          reply to the chat that answered last, until a real player whispers you",
	"/w <agent> <text>                  send to that agent's chat when whisper tabs are on",
	"A command word followed by something it does not take is a message: /claude delete the unused imports starts a new chat with that text.",
}, "\n")

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

local function WidgetArgument(rest)
	local lower = rest:lower()
	return lower == "" or lower == "list" or lower:match("^remove%s+%S+$") ~= nil or lower:match("^run%s+%S+$") ~= nil
end

local COMMAND_ARGS = {
	mini = 0, min = 0, hide = 0, quit = 0, help = 0, clear = 0, delete = 0, reset = 0, copy = 0,
	cancel = 0, resend = 0, reload = 0, refresh = 0, slots = 0, diag = { [""] = true, copy = true },
	context = function(rest) return rest == "" or rest == "on" or rest == "off" or ParseTokens(rest) ~= nil end,
	ctx = function(rest) return rest == "" or rest == "on" or rest == "off" or ParseTokens(rest) ~= nil end,
	mode = { [""] = true, pixel = true, reload = true },
	signal = { [""] = true, on = true, off = true }, longchat = { [""] = true, on = true, off = true },
	roll = { [""] = true, on = true, off = true },
	whisper = { [""] = true, on = true, off = true },
	vision = { [""] = true, on = true, off = true },
	look = true,
	roast = { [""] = true, on = true, off = true },
	telemetry = { [""] = true, on = true, off = true },
	auto = OnOffOrNumber,
	echo = function(rest) return rest == "" or rest == "summary" or rest == "full" or rest == "short" or rest == "off" or tonumber(rest) ~= nil end,
	bind = 1, agent = 1, plugin = 1, live = 0,
	chat = ChatArgument, chats = ChatArgument,
	cd = true, new = true, rename = true,
	map = true,
	macro = { undo = true },
	voice = function(rest) return ClaudeWoWVoice ~= nil and ClaudeWoWVoice.IsCommand(rest) end,
	achievements = { [""] = true, on = true, off = true, test = true, list = true },
	toasts = { [""] = true, on = true, off = true, test = true },
	orders = { [""] = true, on = true, off = true },
	ui = function(rest) return Cli.IsUi(rest) end,
	probe = function(rest)
		local which, arg = rest:lower():match("^(%S*)%s*(.-)$")
		if which == "chatlog" then return arg == "" or tonumber(arg) ~= nil end
		return arg == "" and (which == "" or which == "all" or which == "asyncfile")
	end,
}

Cli.CLAUDE_VERBS = {
	help = true, diag = true, cancel = true, copy = true, clear = true, rename = true, delete = true,
	cd = true, hide = true, quit = true, mini = true, min = true, reload = true, refresh = true,
	resend = true, slots = true, look = true, reset = true, probe = true, orders = true,
}

Cli.CONFIG_KEYS = {
	"voice", "roast", "whisper", "echo", "vision", "roll", "achievements", "orders", "telemetry", "context", "signal",
	"mode", "longchat", "auto", "plugin", "ui", "map", "macro", "bind", "diag",
}
Cli.CONFIG_ALIASES = { toasts = "achievements", ctx = "context" }

local function IsCommand(cmd, rest)
	local spec = COMMAND_ARGS[cmd]
	if spec == nil then return false end
	if spec == true then return true end
	if spec == 0 then return rest == "" end
	if spec == 1 then return not rest:find("%s") end
	if type(spec) == "table" then return spec[rest:lower()] == true end
	return spec(rest) == true
end

function Cli.ConfigKey(word)
	word = tostring(word or ""):lower()
	word = Cli.CONFIG_ALIASES[word] or word
	return Contains(Cli.CONFIG_KEYS, word) and word or nil
end

function Cli.IsConfig(rest)
	if rest == "" then return true end
	local word, args = rest:match("^(%S+)%s*(.-)$")
	local key = Cli.ConfigKey(word)
	if not key then return false end
	if key == "macro" and args == "" then return true end
	return IsCommand(key, args)
end

local function ApplyLongChat()
	local box = ChatFrame1EditBox
	if not box or not box.SetMaxLetters then return end
	box:SetMaxLetters(db.settings.longchat and 4000 or 255)
end


Cli.emitted = setmetatable({}, { __mode = "k" })

function Cli.WindowShown()
	return ui.frame ~= nil and ui.frame:IsShown()
end

function Cli.Emit(c, text)
	if not c or not Whisper.Active() then return end
	local cmd = run.cmd
	if cmd and cmd.tab then
		Whisper.System(c, text, true)
		return
	end
	if Cli.WindowShown() then return end
	if cmd and cmd.general then
		for line in (tostring(text) .. "\n"):gmatch("(.-)\n") do
			if line:match("%S") then print("|cff66ccff[Claude WoW]|r " .. line) end
		end
		return
	end
	Whisper.System(c, text, true)
end

function Cli.Show(c)
	if Whisper.Active() then
		if not c or Cli.WindowShown() then return end
		local had = run.whisperTabs and run.whisperTabs[c.id]
		local frame = Whisper.FrameFor(c, true, true)
		return frame ~= nil and frame == had
	end
	ClaudeWoW.Toggle(true)
	return false
end

function Cli.Point(c)
	if Cli.Show(c) and run.cmd and run.cmd.general then
		print("|cff66ccff[Claude WoW]|r " .. Display(c.name) .. " is the \"" .. Whisper.Title(c) .. "\" tab in the chat dock; bare /claude opens the workspace window.")
	end
end



function Cli.Out(c, text, open)
	if not c then return end
	AddHistory(c, "system", text)
	Cli.emitted[c.history[#c.history]] = true
	ClaudeWoW.Render()
	Cli.Emit(c, text)
	if open then Cli.Show(c) end
end

function Cli.Say(c, text)
	Cli.Out(c, text, true)
end

function Cli.Begin(editBox)
	local tab = Whisper.TabChat(editBox)
	local marks = {}
	for _, ch in ipairs(db.chats) do marks[ch.id] = ch.history[#ch.history] or false end
	run.cmd = { tab = tab, general = type(editBox) == "table" and not tab or nil, marks = marks }
	if tab and db.activeChat ~= tab.id then ClaudeWoW.SwitchChat(tab.id) end
end

function Cli.Finish()
	local cmd = run.cmd
	if not cmd then return end
	for _, ch in ipairs(db.chats) do
		local mark = cmd.marks[ch.id]
		local fresh = {}
		for i = #ch.history, 1, -1 do
			local m = ch.history[i]
			if m == mark then break end
			table.insert(fresh, 1, m)
		end
		for _, m in ipairs(fresh) do
			if m.role == "system" and not Cli.emitted[m] then
				Cli.emitted[m] = true
				Cli.Emit(ch, m.text)
			end
		end
	end
	run.cmd = nil
end

function Cli.Run(editBox, fn, ...)
	Cli.Begin(editBox)
	local ok, err = pcall(fn, ...)
	Cli.Finish()
	if not ok then error(err, 0) end
end

function ClaudeWoW.Print(msg, tag)
	local cmd = run.cmd
	local c = cmd and cmd.tab
	if not c and not (cmd and cmd.general) and Whisper.Active() and not Cli.WindowShown() then
		c = FindChat(run.lastReplyChat) or ActiveChat()
	end
	if c and Whisper.System(c, msg, true, true) then return end
	print("|cff66ccff[" .. (tag or "Claude WoW") .. "]|r " .. msg)
end

function ClaudeWoW.OpenWorkspace(chatId, focus)
	if not ui.frame then return end
	if chatId and FindChat(chatId) and db.activeChat ~= chatId then ClaudeWoW.SwitchChat(chatId) end
	ClaudeWoW.Toggle(true)
	if focus and ui.input then ui.input:SetFocus() end
end

function ClaudeWoW.ToggleWorkspace()
	if not ui.frame then return end
	if ui.frame:IsShown() then
		ClaudeWoW.Minimize(true)
	else
		ClaudeWoW.OpenWorkspace()
	end
end

function Cli.ConfigValue(key)
	local s = db.settings
	local c = ActiveChat()
	if key == "voice" then return (type(ClaudeWoWDB.voice) == "table" and ClaudeWoWDB.voice.pack) or "race" end
	if key == "roast" then return (type(ClaudeWoWDB.roast) == "table" and ClaudeWoWDB.roast.on) and "on" or "off" end
	if key == "whisper" then return s.whisper and "on" or "off" end
	if key == "ui" then return Cli.UiStatus() end
	if key == "echo" then return tostring(s.echo) end
	if key == "vision" then return s.vision and "on" or "off" end
	if key == "roll" then return s.lootRoll == false and "off" or "on" end
	if key == "achievements" then return s.toasts == false and "toasts off" or "toasts on" end
	if key == "orders" then return ClaudeWoWOrders and ClaudeWoWOrders.Status() or "" end
	if key == "telemetry" then return ClaudeWoWTelemetry and ClaudeWoWTelemetry.Status() or "" end
	if key == "context" then return (s.context and "on" or "off") .. ", " .. ContextThresholdLabel() end
	if key == "signal" then return s.signal and "on" or "off" end
	if key == "mode" then return tostring(s.mode) end
	if key == "longchat" then return s.longchat and "on" or "off" end
	if key == "auto" then return (s.autoRefresh and "on" or "off") .. ", every " .. tostring(s.interval) .. " s" end
	if key == "plugin" then return (c and (c.plugin or "") ~= "") and c.plugin or ("chat default: " .. (Cli.ChatPlugin(c) ~= "" and Cli.ChatPlugin(c) or BridgePluginName())) end
	return ""
end

Cli.CONFIG_HELP = {
	voice = "race|peasant|peon|off, set <event> <line>, reset, test <event|line>, lines [pack]: voice lines at agent events",
	roast = "on|off: when you die, a short roast of it in the \"Death roasts\" chat",
	whisper = "on|off: each chat as a native whisper tab (same as ui whisper)",
	echo = "summary|full|short|off|<chars>: how much of a reply the game chat prints",
	vision = "on|off: a picture of your screen with each message (screenshot transport)",
	roll = "on|off: a denied command pops a Need/Greed/Pass roll, or an Allow & retry button",
	achievements = "on|off|test: achievement toasts; alone it lists what you earned",
	orders = "on|off: the Orders card under the quest tracker (also /claude orders and the chat list's gear menu)",
	telemetry = "on|off: send game state (money, level, zone, professions, watched items, gear, reputation) to the bridge; also the chat list's gear menu",
	context = "on|off|<tokens>: the game context the agent gets, and the context-size warning (0 = never)",
	signal = "on|off: the cheap sound-file readiness check",
	mode = "pixel|reload: the transport",
	longchat = "on|off: let the game chat box take 4000 characters",
	auto = "on|off|<seconds>: reload mode only, auto-reload after the interval",
	plugin = "<name>|default: advanced, what this chat is bound to",
	ui = "whisper on|off, dim <10-100>|off, dodge on|off, autohide on|off, reset: the tabs and the window; list|remove <name>|run <name>: live widgets",
	map = "map layers, the route navigator and herb/ore nodes (/aimap is the same)",
	macro = "undo: undo the last macro the agent's button created or changed",
	bind = "<key>: hotkey that checks for a reply while waiting, else toggles the window",
	diag = "transport diagnostics",
}

function Cli.ConfigList()
	local lines = { "Settings. /claude config <key> <value> changes one, /claude config <key> shows it:" }
	for _, key in ipairs(Cli.CONFIG_KEYS) do
		local value = Cli.ConfigValue(key)
		table.insert(lines, key .. (value ~= "" and (" = " .. value) or "") .. "  -  " .. Cli.CONFIG_HELP[key])
	end
	return table.concat(lines, "\n")
end

function Cli.ParseDim(v)
	v = tostring(v or ""):lower()
	if v == "off" then return 1 end
	if v == "on" then return Cli.DIM_DEFAULT end
	local n = tonumber((v:gsub("%%$", "")))
	if not n then return nil end
	if n > 1 then n = n / 100 end
	if n < 0.1 or n > 1 then return nil end
	return n
end

function Cli.Percent(alpha)
	return math.floor((alpha or 1) * 100 + 0.5) .. "%"
end

function Cli.UiStatus()
	local s = db.settings
	local dim = tonumber(s.dim) or 1
	return "whisper " .. (s.whisper and "on" or "off")
		.. ", dim " .. (dim < 1 and Cli.Percent(dim) or "off")
		.. ", dodge " .. (s.dodge and "on" or "off")
		.. ", autohide " .. (s.autohide and "on" or "off")
end

function Cli.IsUi(rest)
	local word, arg = tostring(rest or ""):lower():match("^(%S*)%s*(.-)$")
	if word == "whisper" or word == "dodge" or word == "autohide" then return arg == "" or arg == "on" or arg == "off" end
	if word == "dim" then return arg == "" or Cli.ParseDim(arg) ~= nil end
	if word == "reset" then return arg == "" end
	return WidgetArgument(rest)
end

function Cli.SetWhisper(c, rest)
	local s = db.settings
	rest = tostring(rest or ""):lower()
	if rest == "on" then
		s.whisper, s.whisperChoice = true, "on"
		Whisper.Install()
		local frame = Whisper.FrameFor(c, true, true)
		Cli.Out(c, frame
			and ("Whisper tabs are ON: this chat is the \"" .. Whisper.Title(c) .. "\" tab in the chat dock. Type there and press Enter to talk to " .. ChatAgentName(c) .. "; replies flash the tab, and /claude commands work there too. Other chats get a tab of their own. /claude config ui whisper off closes them.")
			or ("Whisper tabs are ON, but this client could not open a chat tab" .. (run.whisperError and (": " .. run.whisperError) or " (no FCF_OpenTemporaryWindow)") .. ". Replies keep going to the game chat and the window."))
	elseif rest == "off" then
		s.whisper, s.whisperChoice = false, "off"
		Whisper.CloseAll()
		Cli.Out(c, "Whisper tabs are off; replies go to the game chat and the window as before")
		print("|cff66ccff[Claude WoW]|r Whisper tabs are off: replies go to the game chat, and /claude opens the window. /claude config ui whisper on brings the tabs back.")
	else
		Cli.Out(c, Whisper.Status() .. " (/claude config ui whisper on|off: each chat as a native whisper tab)")
	end
end

function Cli.Ui(c, rest)
	local s = db.settings
	local word, arg = tostring(rest or ""):match("^(%S*)%s*(.-)$")
	word, arg = (word or ""):lower(), (arg or ""):lower()
	if word == "whisper" then
		Cli.SetWhisper(c, arg)
	elseif word == "dodge" then
		if arg == "on" then s.dodge = true elseif arg == "off" then s.dodge = false end
		Cli.Out(c, "Dodge is " .. (s.dodge and "on: the window moves aside when bags, the character sheet, the spellbook, a vendor or another panel opens, and goes back when it closes." or "off: the window stays in the left panel slot."))
	elseif word == "autohide" then
		if arg == "on" then s.autohide = true elseif arg == "off" then s.autohide = false end
		Cli.Out(c, "Auto-hide is " .. (s.autohide and "on: the window steps away while the maximized world map, the game menu or the settings are open, and comes back after." or "off: the window stays up over full-screen panels."))
	elseif word == "dim" then
		if arg ~= "" then s.dim = Cli.ParseDim(arg) end
		local dim = tonumber(s.dim) or 1
		Cli.Out(c, dim < 1 and ("The window dims to " .. Cli.Percent(dim) .. " while you move or fight, and comes back when you stop or point at it.") or "Dimming is off: the window stays fully opaque.")
	elseif word == "reset" then
		if ClaudeWoWWindow then ClaudeWoWWindow.Reset() end
		Cli.Out(c, "The window's size is back to the default for this character.")
	elseif word == "" then
		Cli.Out(c, "Window and tabs: " .. Cli.UiStatus() .. ".\n/claude config ui whisper on|off, dim <10-100>|off, dodge on|off, autohide on|off, reset.\nLive widgets: /claude config ui list, remove <name>, run <name>.")
		if ClaudeWoWWidgets then ClaudeWoWWidgets.Command("") end
	elseif ClaudeWoWWidgets then
		ClaudeWoWWidgets.Command(rest)
	else
		ClaudeWoW.Print("the widget module did not load")
	end
	if ClaudeWoWWindow then ClaudeWoWWindow.Apply() end
end

local RunCommand

function ClaudeWoW.Config(rest)
	rest = Trim(rest or "")
	if rest == "" then
		Cli.Say(ActiveChat(), Cli.ConfigList())
		return
	end
	local word, args = rest:match("^(%S+)%s*(.-)$")
	local key = Cli.ConfigKey(word)
	if not key then
		Cli.Say(ActiveChat(), "No setting \"" .. word .. "\". " .. Cli.ConfigList())
		return
	end
	if key == "macro" and args == "" then
		Cli.Say(ActiveChat(), "macro: " .. Cli.CONFIG_HELP.macro)
		return
	end
	if not IsCommand(key, args) then
		Cli.Say(ActiveChat(), key .. " does not take \"" .. args .. "\". " .. key .. ": " .. Cli.CONFIG_HELP[key])
		return
	end
	RunCommand(key, args)
end

Cli.CLI_FLAGS = {
	["-c"] = "continue", ["--continue"] = "continue",
	["-r"] = "resume", ["--resume"] = "resume",
	["-n"] = "name", ["--name"] = "name",
	["-h"] = "help", ["--help"] = "help",
	["--model"] = "model", ["--effort"] = "effort", ["--permission-mode"] = "permissionMode",
	["--add-dir"] = "addDir", ["--agent"] = "agent", ["--project"] = "project",
}
Cli.CLI_VALUE = { name = "required", model = "required", effort = "required", permissionMode = "required", addDir = "required", agent = "required", project = "required", resume = "optional" }
Cli.EFFORTS = { "low", "medium", "high", "xhigh", "max", "minimal" }
Cli.PERMISSION_MODES = { "acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan" }
Cli.ADD_DIRS_MAX = 8

function Cli.ReadToken(s, pos)
	local start = s:find("%S", pos)
	if not start then return nil end
	local q = s:sub(start, start)
	if q == "\"" or q == "'" then
		local close = s:find(q, start + 1, true)
		if close and (close == #s or s:sub(close + 1, close + 1):match("%s")) then
			return s:sub(start + 1, close - 1), start, close + 1, true
		end
	end
	local stop = s:find("%s", start) or (#s + 1)
	return s:sub(start, stop - 1), start, stop, false
end

function Cli.TextFrom(msg, start)
	local rest = Trim(msg:sub(start))
	local q = rest:sub(1, 1)
	if (q == "\"" or q == "'") and #rest >= 2 and rest:sub(-1) == q and not rest:sub(2, -2):find(q, 1, true) then
		return rest:sub(2, -2)
	end
	return rest
end

function Cli.FlagKey(tok)
	if not tok then return nil end
	local name = tok:match("^(%-%-[%w%-]+)=") or tok
	return Cli.CLI_FLAGS[name:lower()]
end

function ClaudeWoW.ParseCli(msg)
	msg = msg or ""
	local o = { flags = 0, text = "", addDir = {} }
	local pos = 1
	while true do
		local tok, start, after, quoted = Cli.ReadToken(msg, pos)
		if not tok then return o end
		if quoted then
			o.text = Cli.TextFrom(msg, start)
			return o
		end
		if tok == "--" then
			o.text = Cli.TextFrom(msg, after)
			return o
		end
		local name, inline = tok:match("^(%-%-[%w%-]+)=(.*)$")
		local key = Cli.CLI_FLAGS[(name or tok):lower()]
		if not key then
			o.text = Cli.TextFrom(msg, start)
			return o
		end
		o.flags = o.flags + 1
		pos = after
		local value
		if name then
			if inline ~= "" then
				local v, _, vAfter = Cli.ReadToken(msg, start + #name + 1)
				value, pos = v, vAfter
			end
		elseif Cli.CLI_VALUE[key] then
			local nxt, _, nAfter, nQuoted = Cli.ReadToken(msg, pos)
			if nxt and nxt ~= "--" and (nQuoted or not Cli.FlagKey(nxt)) then
				value, pos = nxt, nAfter
			end
		end
		if key == "addDir" then
			if value then table.insert(o.addDir, value) else o.addDirShow = true end
		elseif Cli.CLI_VALUE[key] then
			o[key] = value or true
		else
			o[key] = true
		end
	end
end

function Cli.Cleared(v)
	v = tostring(v or ""):lower()
	return v == "-" or v == "default"
end

function Cli.Canonical(list, v)
	v = tostring(v or ""):lower()
	for _, x in ipairs(list) do
		if x:lower() == v then return x end
	end
	return nil
end

function Cli.HasSetters(o)
	for _, key in ipairs({ "name", "model", "effort", "permissionMode", "agent", "project" }) do
		if type(o[key]) == "string" then return true end
	end
	return #o.addDir > 0
end

function Cli.CheckFlags(o)
	local errors = {}
	if type(o.model) == "string" and not Cli.Cleared(o.model) and not o.model:match("^[%w%._:%[%]%-]+$") then
		table.insert(errors, "\"" .. o.model .. "\" is not a model name.")
	end
	if type(o.effort) == "string" and not Cli.Cleared(o.effort) and not Cli.Canonical(Cli.EFFORTS, o.effort) then
		table.insert(errors, "Unknown effort \"" .. o.effort .. "\": low, medium, high, xhigh or max.")
	end
	if type(o.permissionMode) == "string" and not Cli.Cleared(o.permissionMode) and not Cli.Canonical(Cli.PERMISSION_MODES, o.permissionMode) then
		table.insert(errors, "Unknown permission mode \"" .. o.permissionMode .. "\": " .. table.concat(Cli.PERMISSION_MODES, ", ") .. ".")
	end
	if type(o.agent) == "string" and not Cli.Cleared(o.agent) and run.bridgeAgents and not Contains(run.bridgeAgents, o.agent:lower()) then
		table.insert(errors, "Unknown agent \"" .. o.agent .. "\". The bridge knows: " .. AgentList() .. ".")
	end
	if #o.addDir > Cli.ADD_DIRS_MAX then table.insert(errors, "At most " .. Cli.ADD_DIRS_MAX .. " --add-dir folders.") end
	if type(o.project) == "string" and not Cli.ResolveProject(o.project) then
		table.insert(errors, "Unknown project \"" .. o.project .. "\". Known: " .. Cli.ProjectNames() .. ". Or give a folder path.")
	end
	return errors
end

function Cli.DirsLabel(c)
	if type(c.addDirs) ~= "table" or #c.addDirs == 0 then return "none" end
	return table.concat(c.addDirs, ", ")
end

function Cli.ApplyChatFlags(c, o)
	local notes = {}
	if o.agent ~= nil then ClaudeWoW.SetAgent(o.agent == true and "" or o.agent, c) end
	if type(o.project) == "string" then
		table.insert(notes, "project: " .. (Cli.SetProject(c, o.project) or Cli.ProjectLabel(c)))
	elseif o.project == true then
		table.insert(notes, "project: " .. Cli.ProjectLabel(c) .. " (known: " .. Cli.ProjectNames() .. ")")
	end
	local function Setting(key, label, canonical)
		if o[key] == nil then return end
		if o[key] ~= true then
			if Cli.Cleared(o[key]) then
				c[key] = nil
			else
				c[key] = canonical and canonical(o[key]) or o[key]
			end
		end
		table.insert(notes, label .. ": " .. ((c[key] or "") ~= "" and c[key] or "the agent's default"))
	end
	Setting("model", "model")
	Setting("effort", "effort", function(v) return Cli.Canonical(Cli.EFFORTS, v) end)
	Setting("permissionMode", "permission mode", function(v) return Cli.Canonical(Cli.PERMISSION_MODES, v) end)
	if #o.addDir > 0 or o.addDirShow then
		for _, dir in ipairs(o.addDir) do
			if Cli.Cleared(dir) then
				c.addDirs = nil
			else
				c.addDirs = c.addDirs or {}
				if not Contains(c.addDirs, dir) and #c.addDirs < Cli.ADD_DIRS_MAX then table.insert(c.addDirs, dir) end
			end
		end
		table.insert(notes, "extra folders: " .. Cli.DirsLabel(c))
	end
	return notes
end

function Cli.Age(at)
	local now = run.bridgeNow or time()
	local sec = math.max(0, now - (tonumber(at) or now))
	if sec < 60 then return "now" end
	if sec < 3600 then return math.floor(sec / 60) .. "m ago" end
	if sec < 86400 then return math.floor(sec / 3600) .. "h ago" end
	return math.floor(sec / 86400) .. "d ago"
end

function Cli.LastActivity(ch)
	local last = ch.history and ch.history[#ch.history]
	return (last and last.t) or ch.created or 0
end

Cli.PICKER_ROWS = 8
Cli.TITLE_MAX = 48
Cli.BADGES = {
	live = { "live", "55ff55" },
	deaf = { "running, not listening", "ff9933" },
	resume = { "resume", "aaaaaa" },
}

function Cli.SessionEntries()
	local live, deaf, rest, seen, seenId = {}, {}, {}, {}, {}
	for _, e in ipairs(run.bridgeSessions or {}) do
		if e.id == "" or not seenId[e.id] then
			if e.id ~= "" then seenId[e.id] = true end
			local alias = e.name
			local chat = e.chat ~= "" and FindChat(e.chat) or nil
			for _, ch in ipairs(db.chats) do
				if not chat and e.id ~= "" and (ch.session == e.id or ch.resumeId == e.id) and not e.running then chat = ch end
				if not chat and e.running and ch.liveTarget and (ch.liveTarget == e.id or ch.liveTarget:lower() == alias:lower()) then chat = ch end
			end
			if not (chat and seen[chat.id]) then
				local kind = e.live and "live" or (e.running and "deaf" or (chat and "chat" or "headless"))
				local title = e.title ~= "" and e.title or e.name
				local entry = {
					kind = kind, id = e.id, name = (chat and not e.running) and chat.name or title, alias = alias,
					cwd = e.cwd, branch = e.branch, agent = e.agent, plugin = e.plugin, at = e.at,
					live = e.live, running = e.running, restart = e.restart, chat = chat and chat.id or nil,
				}
				table.insert(kind == "live" and live or (kind == "deaf" and deaf or rest), entry)
				if chat then seen[chat.id] = true end
			end
		end
	end
	for _, ch in ipairs(db.chats) do
		if not seen[ch.id] then
			table.insert(rest, { kind = "chat", id = ch.session or "", name = ch.name, cwd = ch.cwd or "", branch = "", agent = ch.agent or "", at = Cli.LastActivity(ch), chat = ch.id })
		end
	end
	for i, e in ipairs(rest) do e.order = i end
	table.sort(rest, function(a, b)
		local x, y = tonumber(a.at) or 0, tonumber(b.at) or 0
		if x ~= y then return x > y end
		return a.order < b.order
	end)
	local list = {}
	for _, group in ipairs({ live, deaf, rest }) do
		for _, e in ipairs(group) do table.insert(list, e) end
	end
	return list
end

function Cli.Badge(e)
	if e.kind == "live" then return Cli.BADGES.live end
	if e.kind == "deaf" then return Cli.BADGES.deaf end
	return Cli.BADGES.resume
end

function Cli.EntryParts(e)
	local title = Flat(e.name ~= "" and e.name or (e.id ~= "" and e.id:sub(1, 8) or "?"))
	if #title > Cli.TITLE_MAX then title = title:sub(1, Cli.TITLE_MAX - 3) .. "..." end
	local where = Display(FolderName(e.cwd or ""))
	if (e.branch or "") ~= "" then where = (where ~= "" and (where .. " ") or "") .. "(" .. Display(e.branch) .. ")" end
	local meta = {}
	if where ~= "" then table.insert(meta, where) end
	if e.at and e.at > 0 then table.insert(meta, Cli.Age(e.at)) end
	local current = e.chat ~= nil and e.chat == db.activeChat
	return title, table.concat(meta, " " .. SEG_DOT .. " "), Cli.Badge(e), current
end

function Cli.EntryLine(i, e)
	local title, meta, badge, current = Cli.EntryParts(e)
	local parts = { title }
	if meta ~= "" then table.insert(parts, meta) end
	table.insert(parts, badge[1])
	return i .. ". " .. table.concat(parts, " " .. SEG_DOT .. " ") .. (current and " (this chat)" or "")
end

function Cli.EntryRich(i, e)
	local title, meta, badge, current = Cli.EntryParts(e)
	return "|cff7ec8ff[" .. i .. "]|r " .. title
		.. (meta ~= "" and (" |cff888888" .. SEG_DOT .. " " .. meta .. "|r") or "")
		.. " |cff" .. badge[2] .. badge[1] .. "|r"
		.. (current and " |cffffd100(this chat)|r" or "")
end

function Cli.EntryLink(i, e)
	return "|H" .. LINK_PREFIX .. "resume:" .. i .. "|h" .. Cli.EntryRich(i, e) .. "|h"
end

function Cli.EntryCopy(e)
	local copy = {}
	for k, v in pairs(e) do
		if type(v) ~= "table" and type(v) ~= "function" then copy[k] = v end
	end
	return copy
end

function Cli.MoreRich(left)
	return "|cff7ec8ff[more]|r |cff888888" .. left .. " older session" .. (left == 1 and "" or "s") .. "|r"
end

function ClaudeWoW.ShowResumePicker(entries, header, all)
	entries = entries or Cli.SessionEntries()
	run.resumeList = entries
	local c = ActiveChat()
	header = header or "Sessions: click one to attach this chat, or /claude -r <n>."
	local shown = all and #entries or math.min(#entries, Cli.PICKER_ROWS)
	local left = #entries - shown
	local lines, rows = { header }, {}
	for i = 1, shown do
		local e = entries[i]
		table.insert(lines, Cli.EntryLine(i, e))
		table.insert(rows, { text = Cli.EntryRich(i, e), entry = Cli.EntryCopy(e) })
	end
	if #entries == 0 then table.insert(lines, "No sessions yet.") end
	if left > 0 then
		table.insert(lines, "[more] " .. left .. " older session" .. (left == 1 and "" or "s") .. ": /claude -r more")
		table.insert(rows, { text = Cli.MoreRich(left), more = true })
	end
	local live = run.bridgeLive
	local startHint = live and #live.sessions == 0 and live.start ~= "" and ("No session is listening to the game. Start one with: " .. live.start) or nil
	if startHint then table.insert(lines, startHint) end
	AddHistory(c, "system", table.concat(lines, "\n"))
	local m = c.history[#c.history]
	m.picker = rows
	m.head = header .. (startHint and ("\n" .. startHint) or "")
	Cli.emitted[m] = true
	ClaudeWoW.Render()
	if not Whisper.Active() then ClaudeWoW.Toggle(true) end
	ClaudeWoW.Print(Display(header))
	for i = 1, shown do ClaudeWoW.Print(Cli.EntryLink(i, entries[i])) end
	if #entries == 0 then ClaudeWoW.Print("No sessions yet.") end
	if left > 0 then ClaudeWoW.Print("|H" .. LINK_PREFIX .. "sessions:all|h" .. Cli.MoreRich(left) .. "|h") end
	if startHint then ClaudeWoW.Print(Display(startHint)) end
end

function Cli.Links.sessions(arg)
	ClaudeWoW.ShowResumePicker(nil, nil, arg == "all")
end

function Cli.Links.headless(arg)
	local id = Cli.Split(arg)[1]
	if not db or id == "" then return end
	local found
	for _, e in ipairs(run.resumeList or {}) do
		if e.id == id then found = e end
	end
	if not found then
		for _, e in ipairs(Cli.SessionEntries()) do
			if e.id == id then found = e end
		end
	end
	local e = Cli.EntryCopy(found or { id = id, name = id:sub(1, 8), cwd = "", agent = "" })
	e.kind, e.live, e.running, e.chat = "headless", false, false, nil
	Cli.AttachWith(e, { text = "", addDir = {}, flags = 1 })
end

function ClaudeWoW.PickRow(row)
	if type(row) ~= "table" or not db then return end
	if row.more then
		ClaudeWoW.ShowResumePicker(nil, nil, true)
		return
	end
	if row.headless then
		Cli.Links.headless(row.headless)
		return
	end
	if type(row.entry) == "table" then Cli.AttachWith(Cli.EntryCopy(row.entry), { text = "", addDir = {}, flags = 1 }) end
end

function Cli.MatchEntries(entries, ref)
	local want = tostring(ref or ""):lower()
	local function alias(e) return tostring(e.alias or ""):lower() end
	local rules = {
		function(e) return e.id ~= "" and e.id:lower() == want end,
		function(e) return e.name:lower() == want end,
		function(e) return alias(e) ~= "" and alias(e) == want end,
		function(e) return #want >= 4 and e.id ~= "" and e.id:lower():sub(1, #want) == want end,
		function(e) return e.name:lower():sub(1, #want) == want end,
		function(e) return alias(e) ~= "" and alias(e):sub(1, #want) == want end,
	}
	for _, rule in ipairs(rules) do
		local hits = {}
		for _, e in ipairs(entries) do
			if rule(e) then table.insert(hits, e) end
		end
		if #hits > 0 then return hits end
	end
	return {}
end

function Cli.AttachTo(e)
	local c = e.chat and FindChat(e.chat) or nil
	if c then
		ClaudeWoW.SwitchChat(c.id)
		return c, false
	end
	if e.chat and (e.id or "") == "" then
		Cli.Say(ActiveChat(), "That chat is gone. /claude -r lists what is left.")
		return nil
	end
	local name = (e.name ~= "" and e.name or e.id:sub(1, 8)):sub(1, 24)
	c = AddChat(name, "")
	c.plugin = ""
	c.agent = ""
	if e.live then
		c.liveTarget = e.id ~= "" and e.id or (e.alias or e.name)
		c.agent = "claude"
		c.cwd = e.cwd or ""
		AddHistory(c, "system", "Attached to the running Claude Code session " .. Display(e.name) .. (e.cwd ~= "" and (" in " .. Display(e.cwd)) or "") .. ". Messages here go to that terminal session, and its answers come back here.")
	else
		c.resumeId = e.id
		if e.agent and e.agent ~= "" then c.agent = e.agent end
		if e.plugin and e.plugin ~= "" and e.plugin ~= "claude-code" and e.plugin ~= LIVE_PLUGIN then
			c.plugin = e.plugin
		else
			c.cwd = e.cwd or ""
			c.adoptCwd = (e.cwd or "") == "" or nil
		end
		AddHistory(c, "system", "Attached to session " .. e.id .. ((e.cwd or "") ~= "" and (" in " .. Display(e.cwd)) or "") .. ". Your next message resumes it" .. (e.unverified and " (the bridge looks the id up then)" or "") .. ".")
	end
	ClaudeWoW.SwitchChat(c.id)
	ClaudeWoW.RenderChatList()
	return c, true
end

function Cli.NotListening(e, text)
	local c = ActiveChat()
	local lines = { Display(e.name) .. " is running in a terminal, but it was not started with the claude-wow channel, so it cannot hear the game." }
	if (e.restart or "") ~= "" then
		table.insert(lines, "Restart it in its terminal with:")
		table.insert(lines, e.restart)
	end
	if (e.id or "") ~= "" then table.insert(lines, "Or resume it headless here: click [resume headless] below.") end
	if (text or "") ~= "" then table.insert(lines, "Your message was not sent.") end
	Cli.Out(c, table.concat(lines, "\n"), true)
	if (e.id or "") ~= "" then
		local link = "|cff55ff55[resume headless]|r |cff888888continue " .. Display(e.name) .. " here without its terminal|r"
		c.history[#c.history].picker = { { text = link, headless = e.id } }
		ClaudeWoW.Render()
		ClaudeWoW.Print("|H" .. LINK_PREFIX .. "headless:" .. e.id .. "|h" .. link .. "|h")
	end
end

function Cli.ResolveResume(ref)
	local n = tonumber(ref)
	if n and n == math.floor(n) and n >= 1 then
		local list = run.resumeList or Cli.SessionEntries()
		if list[n] then return { list[n] } end
	end
	local hits = Cli.MatchEntries(Cli.SessionEntries(), ref)
	if #hits == 0 and ref:match("^[%x%-]+$") and #ref >= 8 then
		return { { kind = "headless", id = ref, name = ref:sub(1, 8), cwd = "", agent = "", at = 0, unverified = true } }
	end
	return hits
end

function Cli.AttachWith(e, o)
	if e.kind == "deaf" then
		Cli.NotListening(e, o.text)
		return
	end
	local c = Cli.AttachTo(e)
	if not c then return end
	if type(o.name) == "string" then
		c.name = o.name:sub(1, 24)
		Whisper.Retitle(c)
	end
	local notes = Cli.ApplyChatFlags(c, o)
	if #notes > 0 then Cli.Out(c, table.concat(notes, "\n")) end
	if o.text ~= "" then
		ClaudeWoW.Send(o.text, nil, { chat = c.id })
	else
		ClaudeWoW.Render()
		Cli.Show(c)
	end
end

function Cli.RunResume(o)
	if o.resume == true then
		ClaudeWoW.ShowResumePicker()
		return
	end
	if tostring(o.resume):lower() == "more" and o.text == "" then
		ClaudeWoW.ShowResumePicker(nil, nil, true)
		return
	end
	local hits = Cli.ResolveResume(o.resume)
	if #hits == 0 then
		Cli.Say(ActiveChat(), "No chat or session matches \"" .. Display(o.resume) .. "\". /claude -r lists them.")
		return
	end
	if #hits > 1 then
		ClaudeWoW.ShowResumePicker(hits, "\"" .. Display(o.resume) .. "\" matches " .. #hits .. " sessions: click one, or /claude -r <n>.", true)
		return
	end
	Cli.AttachWith(hits[1], o)
end

function ClaudeWoW.ResumePick(n)
	if not n or not db then return end
	local e = (run.resumeList or Cli.SessionEntries())[n]
	if not e then return end
	Cli.RunResume({ resume = tostring(n), text = "", addDir = {}, flags = 1 })
end

function ClaudeWoW.RunCli(o)
	if o.help then
		Cli.Say(ActiveChat(), HELP)
		return
	end
	local errors = Cli.CheckFlags(o)
	if #errors > 0 then
		Cli.Say(ActiveChat(), table.concat(errors, "\n"))
		return
	end
	if o.resume ~= nil then
		Cli.RunResume(o)
		return
	end
	local c
	if o.continue or (o.flags > 0 and o.text == "" and not Cli.HasSetters(o)) then
		c = ActiveChat()
		if o.continue and type(o.name) == "string" then
			c.name = o.name:sub(1, 24)
			Whisper.Retitle(c)
		end
	else
		c = ClaudeWoW.NewChat(type(o.name) == "string" and o.name:sub(1, 24) or nil)
	end
	local notes = Cli.ApplyChatFlags(c, o)
	if #notes > 0 then Cli.Out(c, table.concat(notes, "\n")) end
	if o.text ~= "" then
		ClaudeWoW.Send(o.text, nil, { chat = c.id })
	else
		ClaudeWoW.Render()
		Cli.Point(c)
	end
end

SLASH_CLAUDEWOW1 = "/claude-wow"
SLASH_CLAUDE1 = "/claude"
function Cli.ClaudeCommand(msg)
	msg = Trim(msg or "")
	if msg == "" then
		if Whisper.Active() and run.cmd and run.cmd.general then
			ClaudeWoW.OpenWorkspace(nil, true)
		else
			ClaudeWoW.NewChat()
		end
		return
	end
	local cmd, rest = msg:match("^(%S+)%s*(.-)$")
	local verb = cmd:lower()
	if verb == "config" and Cli.IsConfig(rest) then
		ClaudeWoW.Config(rest)
		return
	end
	if Cli.CLAUDE_VERBS[verb] and IsCommand(verb, rest) then
		RunCommand(verb, rest)
		return
	end
	ClaudeWoW.RunCli(ClaudeWoW.ParseCli(msg))
end

function Cli.ClientCommand(msg)
	msg = Trim(msg or "")
	local cmd, rest = msg:match("^(%S+)%s*(.-)$")
	cmd = cmd and cmd:lower() or ""
	if cmd ~= "" and not IsCommand(cmd, rest) then
		ClaudeWoW.Send(msg)
		return
	end
	RunCommand(cmd, rest)
end

SlashCmdList["CLAUDE"] = function(msg, editBox)
	Cli.Run(editBox, Cli.ClaudeCommand, msg)
end

SlashCmdList["CLAUDEWOW"] = function(msg, editBox)
	Cli.Run(editBox, Cli.ClientCommand, msg)
end

function ClaudeWoW.Cancel(c)
	if c and c.pendingId then
		local cancelled = c.pendingId
		Whisper.StopProgress(c)
		AddHistory(c, "system", "Gave up waiting on #" .. c.pendingId .. (run.bridgeCancel and "; the bridge is told to stop it" or "; this bridge cannot stop it, so it may still finish in the background"))
		run.outbound[c.pendingId] = nil
		if run.act then run.act[c.id] = nil end
		c.pendingId = nil
		c.progress = nil
		SendCancel(c, cancelled)
		RefreshStrip()
		if not AnyPending() then keyCatcher:Hide() end
	end
	ClaudeWoW.Render()
end

ClaudeWoW.Probe = {
	TAG = "CWLOG",
	CANCEL_BURST_FIRST = 135000,
	WAIT_BURST_FIRST = 135100,
	BURST_COUNT = 48,
}

function ClaudeWoW.Probe.HideLine(_, _, msg)
	return type(msg) == "string" and msg:find("^CWLOG%d+ H ") ~= nil
end

function ClaudeWoW.Probe.ChatLog(target)
	local P = ClaudeWoW.Probe
	if type(LoggingChat) ~= "function" or type(SendSystemMessage) ~= "function" then
		return "chatlog: LoggingChat or SendSystemMessage is missing in this client"
	end
	target = math.min(math.max(tonumber(target) or 16384, 1024), 262144)
	local tag = P.TAG .. time()
	local wasOn = LoggingChat()
	if not wasOn then LoggingChat(true) end
	if not P.filtered then
		local add = (type(ChatFrameUtil) == "table" and ChatFrameUtil.AddMessageEventFilter) or ChatFrame_AddMessageEventFilter
		if type(add) == "function" then P.filtered = pcall(add, "CHAT_MSG_SYSTEM", P.HideLine) end
	end
	SendSystemMessage(tag .. " LONG " .. string.rep("L", 1000))
	local pad = string.rep("z", 200)
	local lines = math.ceil(target / 240)
	for i = 1, lines do
		SendSystemMessage(string.format("%s %s %05d %s", tag, i % 4 == 1 and "V" or "H", i, pad))
	end
	SendSystemMessage(tag .. " END " .. lines)
	return string.format("chatlog: tag=%s lines=%d bytes=%d wasOn=%s filter=%s", tag, lines, target, tostring(wasOn), tostring(P.filtered or false))
end

function ClaudeWoW.Probe.AsyncFile(done)
	local P = ClaudeWoW.Probe
	local out = {}
	local function step(name, fn)
		local ok, a, b = pcall(fn)
		out[#out + 1] = name .. "=" .. tostring(ok) .. ":" .. tostring(a) .. ":" .. tostring(b)
	end
	if not P.host then
		P.host = CreateFrame("Frame", nil, UIParent)
		P.host:SetSize(2, 2)
		P.host:SetPoint("BOTTOMLEFT", UIParent, "BOTTOMLEFT", 0, 0)
		P.host:Show()
		P.shown = P.host:CreateTexture(nil, "BACKGROUND")
		P.shown:SetAllPoints()
		P.blocking = P.host:CreateTexture(nil, "BACKGROUND")
		P.blocking:SetAllPoints()
		P.hiddenHost = CreateFrame("Frame")
		P.hiddenHost:Hide()
		P.hidden = P.hiddenHost:CreateTexture()
	end
	local shown, hidden, blocking = P.shown, P.hidden, P.blocking
	step("A1_shown_cancel_133975", function() local s = shown:SetTexture(133975); shown:SetTexture(nil); return s end)
	step("A2_twice_133888", function() shown:SetTexture(133888); shown:SetTexture(nil); local s = shown:SetTexture(133888); shown:SetTexture(nil); return s end)
	step("A3_hidden_cancel_134120", function() local s = hidden:SetTexture(134120); hidden:SetTexture(nil); return s end)
	step("A4_missing_8999999", function() local s = shown:SetTexture(8999999); shown:SetTexture(nil); return s end)
	step("A5_blocking_134188", function() blocking:SetBlockingLoadsRequested(true); local s = blocking:SetTexture(134188); return s, blocking:IsBlockingLoadRequested() end)
	step("A6_keep_134336", function() return shown:SetTexture(134336) end)
	C_Timer.After(2, function()
		step("A7_reuse_after_complete_134336", function() shown:SetTexture(nil); local s = shown:SetTexture(134336); shown:SetTexture(nil); return s end)
	end)
	C_Timer.After(4, function()
		step("A8_cancel_burst_" .. P.CANCEL_BURST_FIRST, function()
			for i = 0, P.BURST_COUNT - 1 do
				shown:SetTexture(P.CANCEL_BURST_FIRST + i)
				shown:SetTexture(nil)
			end
			return P.BURST_COUNT
		end)
	end)
	C_Timer.After(6, function()
		step("A9_wait_burst_" .. P.WAIT_BURST_FIRST, function()
			blocking:SetBlockingLoadsRequested(true)
			for i = 0, P.BURST_COUNT - 1 do
				blocking:SetTexture(P.WAIT_BURST_FIRST + i)
			end
			blocking:SetTexture(nil)
			return P.BURST_COUNT
		end)
		done("asyncfile: " .. table.concat(out, " "))
	end)
end

function ClaudeWoW.Probe.Run(rest)
	local P = ClaudeWoW.Probe
	local which, arg = Trim(rest or ""):lower():match("^(%S*)%s*(.-)$")
	if which == "" then which = "all" end
	local function say(line) ClaudeWoW.Print("probe " .. line) end
	say("start " .. which .. " at " .. time())
	if which == "all" or which == "chatlog" then
		local ok, line = pcall(P.ChatLog, arg)
		say(ok and line or ("chatlog: error " .. tostring(line)))
	end
	if which == "all" or which == "asyncfile" then
		local ok, err = pcall(P.AsyncFile, say)
		if not ok then say("asyncfile: error " .. tostring(err)) end
	end
end

RunCommand = function(cmd, rest)
	local s = db.settings
	local c = ActiveChat()
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
		Cli.Show(ActiveChat())
	elseif cmd == "rename" then
		if rest ~= "" then
			c.name = rest:sub(1, 24)
			Whisper.Retitle(c)
			ClaudeWoW.Render()
		else
			ClaudeWoW.RenameActive()
		end
		Cli.Show(c)
	elseif cmd == "delete" then
		ClaudeWoW.DeleteChat()
	elseif cmd == "cd" then
		ClaudeWoW.SetFolder(rest, c)
		Cli.Show(c)
	elseif cmd == "map" then
		if ClaudeWoWMap then ClaudeWoWMap.Command(rest) else print("|cff66ccff[Claude WoW]|r the map module did not load") end
	elseif cmd == "roast" then
		if ClaudeWoWRoast then ClaudeWoWRoast.Command(rest) else print("|cff66ccff[Claude WoW]|r the roast module did not load") end
	elseif cmd == "voice" then
		ClaudeWoWVoice.Command(rest)
	elseif cmd == "achievements" or cmd == "toasts" then
		if ClaudeWoWAchievements then ClaudeWoWAchievements.Command(rest) else print("|cff66ccff[Claude WoW]|r the achievements module did not load") end
	elseif cmd == "orders" then
		if ClaudeWoWOrders then ClaudeWoWOrders.Command(rest) else print("|cff66ccff[Claude WoW]|r the orders module did not load") end
	elseif cmd == "telemetry" then
		if ClaudeWoWTelemetry then ClaudeWoWTelemetry.Command(rest) else print("|cff66ccff[Claude WoW]|r the telemetry module did not load") end
	elseif cmd == "ui" then
		Cli.Ui(c, rest)
	elseif cmd == "agent" then
		ClaudeWoW.SetAgent(rest, c)
		Cli.Show(c)
	elseif cmd == "plugin" then
		ClaudeWoW.SetPlugin(rest, c)
		Cli.Show(c)
	elseif cmd == "live" then
		ClaudeWoW.ShowResumePicker()
	elseif cmd == "reset" then
		c.resetNext = true
		local where = ChatFolder(c)
		AddHistory(c, "system", "Next message starts a fresh " .. ChatAgentName(c) .. " session" .. (where ~= "" and (" in " .. where) or ""))
		ClaudeWoW.Render()
		Cli.Show(c)
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
			Cli.Show(c)
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
			and "Game context is ON: the agent is told this with each message (it goes into its system prompt, so unrelated projects are unaffected by anything but a few lines). /claude config context off to stop.\n\n"
			or "Game context is OFF: the agent is told nothing about the game. /claude config context on to send this:\n\n") .. ctx
			.. "\n\nTip: click the input box, then shift-click an item, spell or quest to link it into your message; the agent gets its tooltip.")
		ClaudeWoW.Render()
		Cli.Show(c)
	elseif cmd == "mode" then
		if rest == "pixel" or rest == "reload" then
			s.mode = rest
			SyncScreenshotMode()
			AddHistory(c, "system", "mode set to " .. rest)
		else
			AddHistory(c, "system", "mode is " .. s.mode .. " (pixel or reload)")
		end
		ClaudeWoW.Render()
		Cli.Show(c)
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
	elseif cmd == "roll" then
		if rest == "on" then s.lootRoll = true elseif rest == "off" then s.lootRoll = false end
		if s.lootRoll == false and ClaudeWoWRoll then ClaudeWoWRoll.CloseAll() end
		ClaudeWoW.Print("denied commands: " .. (ClaudeWoW.LootRollEnabled() and "Need/Greed/Pass roll frame" or "Allow & retry button in the reply"))
		ClaudeWoW.Render()
	elseif cmd == "signal" then
		if rest == "on" then s.signal = true elseif rest == "off" then s.signal = false end
		AddHistory(c, "system", "signal check is " .. (s.signal and "on" or "off"))
		ClaudeWoW.Render()
	elseif cmd == "whisper" then
		Cli.SetWhisper(c, rest)
	elseif cmd == "vision" then
		if rest == "on" then s.vision = true elseif rest == "off" then s.vision = false end
		AddHistory(c, "system", VisionStatus() .. ". /claude config vision on|off; /claude look <question> sends one message with a picture whatever the setting.")
		ClaudeWoW.UpdateStatus()
		ClaudeWoW.Render()
		Cli.Show(c)
	elseif cmd == "look" then
		ClaudeWoW.Send(rest ~= "" and rest or "What do you see on my screen?", nil, { vision = true })
	elseif cmd == "slots" then
		local free = 0
		for i = 1, SLOT_COUNT do
			if not C_AddOns.IsAddOnLoaded(SlotName(i)) then free = free + 1 end
		end
		AddHistory(c, "system", free .. " of " .. SLOT_COUNT .. " reply slots free this session (a reload frees all)")
		ClaudeWoW.Render()
		Cli.Show(c)
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
		Cli.Show(c)
	elseif cmd == "probe" then
		ClaudeWoW.Probe.Run(rest)
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
			"signals: launch-time files, on = file deleted (a file created after the game started is never seen); bridge presence: " .. (run.bridgePresence and (string.format("ring %s at %d of %d", tostring(run.bridgePresence.ring), run.bridgePresence.at, tonumber(run.bridgePresence.n) or PRESENCE_MAX)) or "not heard yet"),
			"presence: " .. Presence.Scheme(),
			"presence self-test: " .. (run.presence and run.presence.test or "not run") .. ", late-created file: " .. (run.lateProbe and (run.lateProbe.result or "pending") or "not checked"),
			"presence: head at " .. (run.presence and string.format("a %d, b %d", run.presence.heads.a, run.presence.heads.b) or "?") .. ", beats seen: " .. tostring(run.presence and run.presence.beats or 0),
			select(5, ClaudeWoW.BridgeState()),
			"mode: " .. s.mode .. ", session token: " .. tostring(db.session),
			Whisper.Status(),
			"transport: " .. tostring(s.transport or "pixel") .. (s.transport == "screenshot" and type(Screenshot) ~= "function" and " (Screenshot() missing: strip stays up, and the bridge is told to fall back to the pixel capture)" or "")
				.. (s.transport == "pixel" and s.transportNote and (" (bridge: " .. s.transportNote .. ")") or "")
				.. (s.transport == "screenshot" and s.stripLevels and string.format(", strip levels %d/%d", s.stripLevels.off, s.stripLevels.on) or "")
				.. (run.shotStats and string.format(", screenshots: %d taken, %d confirmed, %d failed, %d without event", run.shotStats.taken, run.shotStats.ok, run.shotStats.failed, run.shotStats.timeouts) or "")
				.. (run.shotsPaused and ", screenshots PAUSED (bridge not seen for " .. FmtDur(GetTime() - (run.bridgeSeen or run.startedAt or GetTime())) .. ")" or "")
				.. (s.shotFormatSaved and (", screenshotFormat saved: " .. s.shotFormatSaved) or ""),
			ClaudeWoW.ChatLog.Status(),
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
		local report = "Diagnostics:\n" .. table.concat(lines, "\n")
		AddHistory(c, "system", report)
		ClaudeWoW.Render()
		Cli.Show(c)
		if rest:lower() == "copy" then ClaudeWoW.ShowCopy(report) end
	elseif cmd == "cancel" then
		ClaudeWoW.Cancel(c)
	elseif cmd == "clear" then
		wipe(c.history)
		ClaudeWoW.Render()
	elseif cmd == "help" then
		AddHistory(c, "system", HELP)
		ClaudeWoW.Render()
		Cli.Show(c)
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
		ScreenshotDone(true, true)
	elseif event == "SCREENSHOT_FAILED" then
		ScreenshotDone(false, true)
	elseif event == "PLAYER_LOGOUT" then
		-- The player's screenshot format goes back before the client saves its CVars.
		if db then ScreenshotCVarsOff() end
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
		InstallChatHooks()
		Whisper.Install()
		if db.settings.shown then
			if db.settings.minimized or Whisper.Active() then
				ClaudeWoW.Minimize(true)
			else
				ClaudeWoW.Toggle(true)
			end
		end
		ClaudeWoW.ArmAutoRefresh()
		ClaudeWoW.UpdateDot()
		if db.settings.longchat then ApplyLongChat() end
		C_Timer.NewTicker(TICK_SECONDS, Tick)
		C_Timer.NewTicker(WL.PULSE_SECONDS, Whisper.Pulse)
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
