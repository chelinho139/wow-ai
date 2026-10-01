DEV = {
	now = 0,
	epoch = 0,
	timers = {},
	tickers = {},
	loaded = {},
	indexed = {},
	disabled = {},
	shots = 0,
	shotQueue = {},
	errors = {},
	interface = 16001,
	version = "1.60.1",
	build = "70058",
	loadOutOfDate = false,
	width = 1920,
	height = 1080,
}

loadstring = loadstring or function(src, name) return load(src, name) end
unpack = unpack or table.unpack
strsplit = strsplit or function(sep, s)
	local out = {}
	for part in (tostring(s) .. sep):gmatch("(.-)" .. sep:gsub("%p", "%%%0")) do out[#out + 1] = part end
	return unpack(out)
end
strtrim = strtrim or function(s) return (tostring(s):gsub("^%s+", ""):gsub("%s+$", "")) end
format = format or string.format
strlower = strlower or string.lower
strupper = strupper or string.upper
strsub = strsub or string.sub
strlen = strlen or string.len
strfind = strfind or string.find
gsub = gsub or string.gsub
floor = floor or math.floor
ceil = ceil or math.ceil
abs = abs or math.abs
min = min or math.min
max = max or math.max
tremove = tremove or table.remove
getn = getn or function(t) return #t end
debugstack = debugstack or function() return "" end
geterrorhandler = geterrorhandler or function() return function(e) table.insert(DEV.errors, tostring(e)) end end

function GetTime() return DEV.now end
function time(t) if t then return os.time(t) end return DEV.epoch end
function date(fmt, t) return os.date(fmt, t or DEV.epoch) end
function GetPhysicalScreenSize() return DEV.width, DEV.height end
function GetBuildInfo() return DEV.version, DEV.build, "Sep 1 2026", DEV.interface end

C_Timer = {
	After = function(delay, fn)
		table.insert(DEV.timers, { at = DEV.now + (tonumber(delay) or 0), fn = fn })
	end,
	NewTicker = function(interval, fn, iterations)
		local t = { interval = tonumber(interval) or 1, fn = fn, next = DEV.now + (tonumber(interval) or 1), left = iterations, cancelled = false }
		t.Cancel = function(self) self.cancelled = true end
		t.IsCancelled = function(self) return self.cancelled end
		table.insert(DEV.tickers, t)
		return t
	end,
	NewTimer = function(delay, fn)
		local t = { cancelled = false }
		t.Cancel = function(self) self.cancelled = true end
		table.insert(DEV.timers, { at = DEV.now + (tonumber(delay) or 0), fn = function() if not t.cancelled then fn(t) end end })
		return t
	end,
}

local function report(err)
	table.insert(DEV.errors, tostring(err))
end

function DEV.RunTimers()
	local due, keep = {}, {}
	for _, t in ipairs(DEV.timers) do
		if t.at <= DEV.now then table.insert(due, t) else table.insert(keep, t) end
	end
	DEV.timers = keep
	table.sort(due, function(a, b) return a.at < b.at end)
	for _, t in ipairs(due) do
		local ok, err = pcall(t.fn)
		if not ok then report(err) end
	end
	for _, t in ipairs(DEV.tickers) do
		if not t.cancelled and DEV.now >= t.next then
			t.next = DEV.now + t.interval
			local ok, err = pcall(t.fn, t)
			if not ok then report(err) end
			if t.left then
				t.left = t.left - 1
				if t.left <= 0 then t.cancelled = true end
			end
		end
	end
end

function DEV.Visible(f)
	local seen = 0
	while f and seen < 64 do
		if f.shown == false then return false end
		f = f.parent
		seen = seen + 1
	end
	return true
end

function DEV.RunFrame(dt)
	DEV.RunTimers()
	local frames = {}
	for i, f in ipairs(STUB.frames) do frames[i] = f end
	for _, f in ipairs(frames) do
		local fn = f.scripts and f.scripts.OnUpdate
		if fn and DEV.Visible(f) then
			local ok, err = pcall(fn, f, dt)
			if not ok then report(err) end
		end
	end
end

function DEV.Fire(ev, ...)
	local frames = {}
	for i, f in ipairs(STUB.frames) do frames[i] = f end
	for _, f in ipairs(frames) do
		if f.events[ev] and f.scripts.OnEvent then
			local ok, err = pcall(f.scripts.OnEvent, f, ev, ...)
			if not ok then report(err) end
		end
	end
end

function Screenshot()
	DEV.shots = DEV.shots + 1
	table.insert(DEV.shotQueue, DEV.shots)
end

DEV.loggingChat = false
DEV.chatLogQueue = {}
DEV.systemMessages = 0

function LoggingChat(on)
	if on ~= nil then DEV.loggingChat = on and true or false end
	return DEV.loggingChat
end

function SendSystemMessage(text)
	DEV.systemMessages = DEV.systemMessages + 1
	if DEV.loggingChat then table.insert(DEV.chatLogQueue, tostring(text)) end
end

function DEV.StripCells()
	local s = _G.ClaudeWoWStrip
	if not s or not DEV.Visible(s) then return "" end
	local out = {}
	for _, t in ipairs(s.textures or {}) do
		if t.shown ~= false and t.color then
			out[#out + 1] = string.format("%d,%d,%d,%d,%d,%d,%d", math.floor((t.x or 0) + 0.5), math.floor(-(t.y or 0) + 0.5), math.floor((t.width or 1) + 0.5),
				math.floor((t.color[1] or 0) * 255 + 0.5), math.floor((t.color[2] or 0) * 255 + 0.5), math.floor((t.color[3] or 0) * 255 + 0.5), math.floor((t.height or t.width or 1) + 0.5))
		end
	end
	return table.concat(out, ";")
end

local function tocPath(name)
	return "Interface/AddOns/" .. name .. "/" .. name .. ".toc"
end

function DEV.ParseToc(src)
	local meta, files = {}, {}
	for line in (src .. "\n"):gmatch("([^\r\n]*)\r?\n") do
		local k, v = line:match("^##%s*([^:]+):%s*(.-)%s*$")
		if k then
			meta[k] = v
		elseif line:match("%S") and not line:match("^#") then
			files[#files + 1] = (line:gsub("^%s+", ""):gsub("%s+$", ""):gsub("\\", "/"))
		end
	end
	return meta, files
end

function DEV.RunAddonFile(name, file)
	local src = HOST_read("Interface/AddOns/" .. name .. "/" .. file)
	if not src then return false, "MISSING_FILE " .. file end
	local fn, err = load(src, "@" .. name .. "/" .. file)
	if not fn then report(err) return false, "CORRUPT" end
	local ok, rerr = pcall(fn, name, DEV.ns(name))
	if not ok then report(rerr) end
	return true
end

DEV.namespaces = {}
function DEV.ns(name)
	DEV.namespaces[name] = DEV.namespaces[name] or {}
	return DEV.namespaces[name]
end

function DEV.LoadAddOn(name)
	if DEV.loaded[name] then return true end
	if not DEV.indexed[name] then return false, "MISSING" end
	if DEV.disabled[name] then return false, "DISABLED" end
	local src = HOST_read(tocPath(name))
	if not src then return false, "MISSING" end
	local meta = DEV.ParseToc(src)
	local _, files = DEV.ParseToc(src)
	local fits = false
	for v in tostring(meta.Interface or ""):gmatch("%d+") do
		if tonumber(v) == DEV.interface then fits = true end
	end
	if not fits and not DEV.loadOutOfDate then return false, "INTERFACE_VERSION" end
	for _, f in ipairs(files) do
		local ok, reason = DEV.RunAddonFile(name, f)
		if not ok then return false, reason end
	end
	DEV.loaded[name] = true
	return true
end

C_AddOns = C_AddOns or {}
C_AddOns.LoadAddOn = function(name) return DEV.LoadAddOn(name) end
C_AddOns.IsAddOnLoaded = function(name) return DEV.loaded[name] and true or false end
C_AddOns.GetAddOnMetadata = function(name, key)
	local src = HOST_read(tocPath(name))
	if not src then return nil end
	local meta = DEV.ParseToc(src)
	return meta[key]
end
LoadAddOn = C_AddOns.LoadAddOn
IsAddOnLoaded = C_AddOns.IsAddOnLoaded

function PlaySoundFile(path, channel)
	local p = tostring(path):gsub("\\", "/")
	if HOST_exists(p) then
		DEV.handles = (DEV.handles or 0) + 1
		return true, DEV.handles
	end
	return nil
end

function ReloadUI()
	DEV.reloadRequested = true
end

local function sortedKeys(t)
	local keys = {}
	for k in pairs(t) do keys[#keys + 1] = k end
	table.sort(keys, function(a, b)
		local ta, tb = type(a), type(b)
		if ta ~= tb then return ta < tb end
		return a < b
	end)
	return keys
end

local function isArray(t)
	local n = #t
	local count = 0
	for _ in pairs(t) do count = count + 1 end
	return count == n
end

local function quote(s)
	return (string.format("%q", s):gsub("\\\n", "\\n"):gsub("\r", "\\r"))
end

local function scalar(v)
	local tv = type(v)
	if tv == "string" then return quote(v) end
	if tv == "number" then
		if v == math.floor(v) and math.abs(v) < 2 ^ 53 then return string.format("%d", v) end
		return string.format("%.14g", v)
	end
	if tv == "boolean" then return tostring(v) end
	return nil
end

local function serialize(v, out, depth)
	if depth > 40 then return end
	local array = isArray(v)
	for _, k in ipairs(sortedKeys(v)) do
		local item = v[k]
		local key = type(k) == "number" and ("[" .. k .. "]") or ("[" .. quote(tostring(k)) .. "]")
		if array and type(k) == "number" then key = nil end
		local prefix = key and (key .. " = ") or ""
		if type(item) == "table" then
			out[#out + 1] = prefix .. "{"
			serialize(item, out, depth + 1)
			out[#out + 1] = "},"
		else
			local s = scalar(item)
			if s then out[#out + 1] = prefix .. s .. "," end
		end
	end
end

function DEV.SerializeSaved(names)
	local out = { "" }
	for _, name in ipairs(names) do
		local v = _G[name]
		if type(v) == "table" then
			out[#out + 1] = name .. " = {"
			serialize(v, out, 0)
			out[#out + 1] = "}"
		elseif v ~= nil then
			local s = scalar(v)
			if s then out[#out + 1] = name .. " = " .. s end
		else
			out[#out + 1] = name .. " = nil"
		end
	end
	return table.concat(out, "\r\n") .. "\r\n"
end

local function jsonString(s)
	return '"' .. tostring(s):gsub('[%c"\\]', function(c)
		local map = { ['"'] = '\\"', ['\\'] = '\\\\', ['\n'] = '\\n', ['\r'] = '\\r', ['\t'] = '\\t' }
		return map[c] or string.format("\\u%04x", c:byte())
	end) .. '"'
end

function DEV.Json(v, depth)
	depth = depth or 0
	local tv = type(v)
	if tv == "nil" then return "null" end
	if tv == "boolean" then return tostring(v) end
	if tv == "number" then
		if v ~= v or v == math.huge or v == -math.huge then return "null" end
		return string.format("%.14g", v)
	end
	if tv == "string" then return jsonString(v) end
	if tv ~= "table" or depth > 30 then return "null" end
	if next(v) == nil then return "[]" end
	if isArray(v) then
		local parts = {}
		for i = 1, #v do parts[i] = DEV.Json(v[i], depth + 1) end
		return "[" .. table.concat(parts, ",") .. "]"
	end
	local parts = {}
	for _, k in ipairs(sortedKeys(v)) do
		local item = v[k]
		if type(item) ~= "function" and type(item) ~= "userdata" then
			parts[#parts + 1] = jsonString(tostring(k)) .. ":" .. DEV.Json(item, depth + 1)
		end
	end
	return "{" .. table.concat(parts, ",") .. "}"
end
