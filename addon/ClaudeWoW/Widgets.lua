local ADDON_NAME = ...
local W = {}
ClaudeWoWWidgets = W

local DENIED_NAMES = {
	"CastSpell", "CastSpellByName", "CastSpellByID", "CastShapeshiftForm", "CastPetAction",
	"UseAction", "UseItemByName", "UseInventoryItem", "UseContainerItem", "UseToy", "UseToyByName",
	"RunMacro", "RunMacroText", "RunBinding", "RunScript",
	"TargetUnit", "TargetNearestEnemy", "TargetNearestFriend", "TargetLastTarget", "TargetLastEnemy", "ClearTarget",
	"AssistUnit", "FocusUnit", "InteractUnit", "FollowUnit",
	"AttackTarget", "StartAttack", "StopAttack", "PetAttack", "PetFollow",
	"SpellStopCasting", "SpellStopTargeting", "SpellTargetUnit", "CancelShapeshiftForm", "CancelUnitBuff",
	"JumpOrAscendStart", "MoveForwardStart", "MoveBackwardStart", "StrafeLeftStart", "StrafeRightStart",
	"TurnLeftStart", "TurnRightStart", "ToggleAutoRun", "ToggleRun", "SitStandOrDescendStart",
	"PickupAction", "PlaceAction", "PickupSpell", "PickupItem", "PickupMacro", "PickupContainerItem",
	"PickupInventoryItem", "DeleteCursorItem", "EquipItemByName",
	"SendChatMessage", "SendAddonMessage", "BNSendWhisper", "DoEmote", "SendMail", "ChatEdit_SendText", "ChatEdit_ParseText",
	"InviteUnit", "UninviteUnit", "LeaveParty", "AcceptGroup", "AcceptTrade", "InitiateTrade",
	"BuyMerchantItem", "RepairAllItems", "PlaceAuctionBid", "SetRaidTarget",
	"CreateMacro", "EditMacro", "DeleteMacro",
	"SetBinding", "SetBindingClick", "SetBindingSpell", "SetBindingItem", "SetBindingMacro", "SaveBindings",
	"SetCVar", "ConsoleExec", "ReloadUI", "Logout", "Quit", "ForceQuit",
	"LoadAddOn", "EnableAddOn", "DisableAddOn", "SlashCmdList", "hooksecurefunc",
	"loadstring", "load", "getfenv", "setfenv", "getglobal", "setglobal", "rawget", "rawset", "debug",
}
W.DENIED_NAMES = DENIED_NAMES

local DENIED = {}
for _, name in ipairs(DENIED_NAMES) do DENIED[name] = true end

local wdb
local running = {}
local failures = {}
local containers = {}

local function Print(msg)
	if ClaudeWoW and ClaudeWoW.Print then
		ClaudeWoW.Print(msg, "Claude WoW ui")
	else
		print("|cff66ccff[Claude WoW ui]|r " .. msg)
	end
end

local function Report(msg)
	Print(msg)
	if ClaudeWoW and ClaudeWoW.SystemNote then ClaudeWoW.SystemNote("UI widget " .. msg) end
end

local function DB()
	if not wdb then
		ClaudeWoWWidgetDB = ClaudeWoWWidgetDB or {}
		wdb = ClaudeWoWWidgetDB
		wdb.removed = wdb.removed or {}
		wdb.data = wdb.data or {}
	end
	return wdb
end

local function Items()
	local set = DB().set
	return set and set.items or {}
end

local function FindItem(name)
	for _, item in ipairs(Items()) do
		if item.name == name then return item end
	end
end

local function Blocked(name)
	return function()
		error(name .. " is not allowed in a widget: widgets are display-only", 2)
	end
end

local function NamespaceProxy(namespaceName, namespace)
	return setmetatable({}, {
		__index = function(_, field)
			if DENIED[field] then return Blocked(namespaceName .. "." .. tostring(field)) end
			return namespace[field]
		end,
		__newindex = function() error(namespaceName .. " is read-only in a widget", 2) end,
		__metatable = false,
	})
end

function W.Fail(widget, err)
	if widget.failed then return end
	widget.failed = true
	failures[widget.name] = { rev = widget.rev, err = tostring(err) }
	W.Stop(widget)
	Report(string.format("%s failed and was stopped: %s. /claude config ui run %s tries again; or ask the agent to fix it.", widget.name, tostring(err), widget.name))
end

local function Guarded(widget, fn)
	return function(...)
		if widget.stopped then return end
		local ok, err = pcall(fn, ...)
		if not ok then W.Fail(widget, err) end
	end
end

local function GuardScripts(widget, frame)
	local setScript, hookScript = frame.SetScript, frame.HookScript
	if type(setScript) == "function" then
		frame.SetScript = function(self, handler, fn)
			return setScript(self, handler, type(fn) == "function" and Guarded(widget, fn) or fn)
		end
	end
	if type(hookScript) == "function" then
		frame.HookScript = function(self, handler, fn)
			return hookScript(self, handler, type(fn) == "function" and Guarded(widget, fn) or fn)
		end
	end
end

local function WidgetCreateFrame(widget)
	return function(kind, name, parent, template, id)
		if type(template) == "string" and template:find("Secure") then
			error("secure templates are not allowed in a widget: widgets are display-only", 2)
		end
		if parent == nil or parent == UIParent then parent = widget.frame end
		local frame = CreateFrame(kind, name, parent, template, id)
		GuardScripts(widget, frame)
		widget.frames[#widget.frames + 1] = frame
		return frame
	end
end

local function WidgetTimers(widget)
	local timers = {}
	timers.After = function(delay, fn)
		return C_Timer.After(delay, Guarded(widget, fn))
	end
	for _, constructor in ipairs({ "NewTicker", "NewTimer" }) do
		if C_Timer[constructor] then
			timers[constructor] = function(delay, fn, iterations)
				local handle = C_Timer[constructor](delay, Guarded(widget, fn), iterations)
				widget.timers[#widget.timers + 1] = handle
				return handle
			end
		end
	end
	return setmetatable(timers, { __index = C_Timer, __metatable = false })
end

local function NewEnvironment(widget)
	local env = {}
	local namespaces = {}
	local overrides = { CreateFrame = WidgetCreateFrame(widget), C_Timer = WidgetTimers(widget) }
	setmetatable(env, {
		__index = function(_, key)
			if DENIED[key] then return Blocked(key) end
			if key == "_G" then return env end
			if type(key) == "string" and key:match("^ClaudeWoW") then return nil end
			if overrides[key] ~= nil then return overrides[key] end
			local value = _G[key]
			if type(value) == "table" and type(key) == "string" and key:match("^C_") then
				namespaces[key] = namespaces[key] or NamespaceProxy(key, value)
				return namespaces[key]
			end
			return value
		end,
		__metatable = false,
	})
	return env
end

local function Compile(source, name, env)
	local chunkName = "=widget " .. name
	if setfenv and loadstring then
		local chunk, err = loadstring(source, chunkName)
		if chunk then setfenv(chunk, env) end
		return chunk, err
	end
	return load(source, chunkName, "t", env)
end

local function Container(name)
	local frame = containers[name]
	if not frame then
		frame = CreateFrame("Frame", nil, UIParent)
		frame:SetAllPoints(UIParent)
		containers[name] = frame
	end
	return frame
end

local function WidgetData(name)
	local data = DB().data
	data[name] = data[name] or {}
	return data[name]
end

function W.Stop(widget)
	widget.stopped = true
	for _, handle in ipairs(widget.timers) do
		if handle and handle.Cancel then pcall(handle.Cancel, handle) end
	end
	for _, frame in ipairs(widget.frames) do
		pcall(frame.UnregisterAllEvents, frame)
		pcall(frame.SetScript, frame, "OnUpdate", nil)
		pcall(frame.Hide, frame)
	end
	widget.frame:Hide()
	if running[widget.name] == widget then running[widget.name] = nil end
end

function W.Start(item, announce)
	local widget = { name = item.name, title = item.title or item.name, rev = item.rev, frames = {}, timers = {} }
	widget.frame = Container(item.name)
	widget.frame:Show()
	failures[item.name] = nil
	running[item.name] = widget
	local chunk, compileError = Compile(item.source, item.name, NewEnvironment(widget))
	if not chunk then
		W.Fail(widget, compileError)
		return false
	end
	local api = {
		name = item.name,
		title = widget.title,
		frame = widget.frame,
		db = WidgetData(item.name),
		print = function(msg) Print(item.name .. ": " .. tostring(msg)) end,
	}
	local ok, err = pcall(chunk, api)
	if not ok then
		W.Fail(widget, err)
		return false
	end
	if announce then Report(string.format("%s is live: %s. /claude config ui lists widgets, /claude config ui remove %s removes it.", item.name, widget.title, item.name)) end
	return true
end

function W.Apply(announce)
	local d = DB()
	local wanted = {}
	for _, item in ipairs(Items()) do wanted[item.name] = item end
	for name, widget in pairs(running) do
		local item = wanted[name]
		if not item or item.rev ~= widget.rev or d.removed[name] == item.rev then
			W.Stop(widget)
			if not item and announce then Report(name .. " was removed by the agent.") end
		end
	end
	for name, rev in pairs(d.removed) do
		if not wanted[name] or wanted[name].rev ~= rev then d.removed[name] = nil end
	end
	for _, item in ipairs(Items()) do
		local failure = failures[item.name]
		local failedThisRevision = failure and failure.rev == item.rev
		if not d.removed[item.name] and not running[item.name] and not failedThisRevision then
			W.Start(item, announce)
		end
	end
end

function W.Sync(set)
	if type(set) ~= "table" or type(set.items) ~= "table" then return end
	local d = DB()
	local current = d.set
	if current and current.epoch == set.epoch and (tonumber(set.version) or 0) <= (tonumber(current.version) or 0) then return end
	local items = {}
	for _, item in ipairs(set.items) do
		if type(item) == "table" and type(item.name) == "string" and type(item.source) == "string" and type(item.rev) == "string" then
			items[#items + 1] = { name = item.name, title = type(item.title) == "string" and item.title or item.name, rev = item.rev, source = item.source }
		end
	end
	d.set = { epoch = set.epoch, version = tonumber(set.version) or 0, items = items }
	W.Apply(true)
end

function W.Status(name)
	local item = FindItem(name)
	if not item then return nil end
	if running[name] then return "running" end
	if DB().removed[name] == item.rev then return "removed" end
	local failure = failures[name]
	if failure and failure.rev == item.rev then return "failed", failure.err end
	return "stopped"
end

local function List()
	local items = Items()
	if #items == 0 then
		Print("no widgets yet. Ask the agent for one, e.g. /claude give me a small DPS meter")
		return
	end
	for _, item in ipairs(items) do
		local status, err = W.Status(item.name)
		Print(string.format("%s  %s  (%s%s, %d bytes)", item.name, item.title, status, err and (": " .. err) or "", #item.source))
	end
	Print("commands: /claude config ui list, /claude config ui remove <name>, /claude config ui run <name>")
end

function W.Remove(name)
	local item = FindItem(name)
	if not item then Print("no widget " .. tostring(name)); return end
	DB().removed[name] = item.rev
	if running[name] then W.Stop(running[name]) end
	Report(string.format("%s removed. It stays off until the agent sends a new version; /claude config ui run %s brings it back.", name, name))
end

function W.Run(name)
	local item = FindItem(name)
	if not item then Print("no widget " .. tostring(name)); return end
	DB().removed[name] = nil
	if running[name] then W.Stop(running[name]) end
	W.Start(item, true)
end

function W.Command(msg)
	DB()
	local cmd, rest = (msg or ""):match("^%s*(%S*)%s*(.-)%s*$")
	cmd = (cmd or ""):lower()
	if cmd == "remove" and rest ~= "" then W.Remove(rest)
	elseif cmd == "run" and rest ~= "" then W.Run(rest)
	else List() end
end

local events = CreateFrame("Frame")
events:RegisterEvent("ADDON_LOADED")
events:RegisterEvent("PLAYER_LOGIN")
events:SetScript("OnEvent", function(_, event, arg1)
	if event == "ADDON_LOADED" and arg1 == ADDON_NAME then
		DB()
	elseif event == "PLAYER_LOGIN" then
		DB()
		W.Apply(false)
	end
end)
