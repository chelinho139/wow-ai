local V = {}
ClaudeWoWVoice = V

local LINE_GAP_SECONDS = 2
local SOUND_CHANNEL = "Master"
local DEFAULT_PACK = "race"
local PACK_NAMES = { "race", "peasant", "peon", "off" }
local EVENTS = { "sent", "started", "done", "error", "permission" }
local EVENT_PRIORITY = { sent = 1, started = 1, done = 2, error = 2, permission = 2 }
local EVENT_MEANING = {
	sent = "a message leaves for the agent",
	started = "the bridge picked the message up",
	done = "a reply arrived",
	error = "the run failed",
	permission = "a reply waits on Allow & retry",
}
local PLAYER_SEX_FEMALE = 3

local UNIT_PACK_LINES = {
	peasant = {
		ready = { 558118 },
		morework = { 558127 },
		what = { 558128, 558120 },
		yes = { 558119, 558124, 558125 },
		reluctant = { 558123, 558117, 558126 },
		warcry = { 558121 },
		pissed = { 558122 },
	},
	peon = {
		ready = { 558137 },
		what = { 558141, 558134, 558143, 558135 },
		yes = { 558136, 558139, 558147, 558140 },
		workwork = { 558147 },
		workcomplete = { 558132 },
		reluctant = { 558145, 558138 },
		pissed = { 558133, 558144, 558142, 558146 },
	},
}

local EVENT_LINES = {
	race = { sent = "yes", started = "hello", done = "cheer", error = "cantuse", permission = "notready" },
	peasant = { sent = "yes", started = "ready", done = "morework", error = "pissed", permission = "what" },
	peon = { sent = "yes", started = "ready", done = "workcomplete", error = "pissed", permission = "what" },
}

local RACE_LINES = {
	Human = {
		male = {
			yes = { 540702, 540709, 540667 },
			no = { 540673, 540683, 540700, 540698 },
			cheer = { 540694, 540707 },
			thank = { 540672, 540682, 540662 },
			hello = { 540674, 540664, 540681, 540665 },
			congrats = { 540703, 540676, 540712 },
			laugh = { 540739 },
			cry = { 540736 },
			nomana = { 540803, 540801, 540776 },
			notready = { 540793, 540786, 540787 },
			cantuse = { 540777 },
			notarget = { 540747, 540743, 540754 },
			outofrange = { 540767, 540781, 540759 },
		},
		female = {
			yes = { 540624, 540605, 540632 },
			no = { 540614, 540658, 540607 },
			cheer = { 540628, 540610 },
			thank = { 540650, 540659, 540635 },
			hello = { 540629, 540608, 540657 },
			congrats = { 540654, 540640, 540655 },
			laugh = { 540540 },
			cry = { 540533 },
			nomana = { 540588, 540576, 540561 },
			notready = { 540550, 540584, 540543 },
			cantuse = { 540591 },
			notarget = { 540603, 540567, 540563 },
			outofrange = { 540551, 540604, 540585 },
		},
	},
	Dwarf = {
		male = {
			yes = { 540047, 540062, 540022, 540044 },
			no = { 540054, 540056, 540040, 540074 },
			cheer = { 540024, 540070, 540076 },
			thank = { 540091, 540028, 540034, 540075 },
			hello = { 540077, 540082, 540072, 540073 },
			congrats = { 540065, 540058, 540039, 540042, 540063 },
			laugh = { 539883 },
			cry = { 539875 },
			nomana = { 539909, 539897, 539951 },
			notready = { 539936, 539923, 539914 },
			cantuse = { 539903 },
			notarget = { 539912, 539900, 539906 },
			outofrange = { 539904, 539893, 539915 },
		},
		female = {
			yes = { 540002, 540011, 539982 },
			no = { 540003, 540012, 539996 },
			cheer = { 540014, 539977 },
			thank = { 539973, 539991, 539985, 539990 },
			hello = { 539988, 540021, 540020 },
			congrats = { 539981, 539994, 539965, 540008 },
			laugh = { 539798 },
			cry = { 539792 },
			nomana = { 539842, 539819, 539833 },
			notready = { 539845, 539838, 539855 },
			cantuse = { 539821 },
			notarget = { 539831, 539834, 539869 },
			outofrange = { 539829, 539827, 539818 },
		},
	},
	NightElf = {
		male = {
			yes = { 541099, 541130, 541137 },
			no = { 541128, 541094, 541083 },
			cheer = { 541138, 541126 },
			thank = { 541080, 541112, 541096 },
			hello = { 541089, 541097, 541090 },
			congrats = { 541085, 541103, 541136 },
			laugh = { 540945 },
			cry = { 540957 },
			nomana = { 540970, 540968, 541019 },
			notready = { 540992, 540994, 541007 },
			cantuse = { 540993 },
			notarget = { 541010, 540991, 540987 },
			outofrange = { 540983, 541017, 540997 },
		},
		female = {
			yes = { 541071, 541058, 541046 },
			no = { 541068, 541039, 541074 },
			cheer = { 541043, 541055 },
			thank = { 541054, 541027, 541029 },
			hello = { 541030, 541032, 541041, 541070 },
			congrats = { 541045, 541031, 541033 },
			laugh = { 540877 },
			cry = { 540873 },
			nomana = { 540915, 540917, 540935 },
			notready = { 540937, 540940, 540895 },
			cantuse = { 540897 },
			notarget = { 540925, 540939, 540887 },
			outofrange = { 540919, 540916, 540928 },
		},
	},
	Gnome = {
		male = {
			yes = { 540471, 540477, 540483 },
			no = { 540496, 540514, 540506 },
			cheer = { 540493, 540463 },
			thank = { 540507, 540466, 540472 },
			hello = { 540490, 540505, 540469, 540485 },
			congrats = { 540476, 540501, 540512 },
			laugh = { 540267 },
			cry = { 540264 },
			nomana = { 540366, 540371, 540369 },
			notready = { 540378, 540355, 540373 },
			cantuse = { 540395 },
			notarget = { 540344, 540357, 540400 },
			outofrange = { 540383, 540391, 540385 },
		},
		female = {
			yes = { 540418, 540422, 540446 },
			no = { 540440, 540429, 540433 },
			cheer = { 540434, 540445 },
			thank = { 540408, 540437, 540410 },
			hello = { 540421, 540428, 540436 },
			congrats = { 540432, 540449, 540420, 540415 },
			laugh = { 540268 },
			cry = { 540273 },
			nomana = { 540283, 540310, 540311 },
			notready = { 540300, 540334, 540315 },
			cantuse = { 540295 },
			notarget = { 540284, 540308, 540298 },
			outofrange = { 540341, 540289, 540328 },
		},
	},
	Orc = {
		male = {
			yes = { 541424, 541399, 541379, 541377 },
			no = { 541428, 541390, 541416 },
			cheer = { 541435, 541404 },
			thank = { 541388, 541411, 541380 },
			hello = { 541408, 541425, 541418 },
			congrats = { 541396, 541401, 541423 },
			laugh = { 541230 },
			cry = { 541240 },
			nomana = { 541260, 541247, 541294 },
			notready = { 541293, 541262, 541283 },
			cantuse = { 541254 },
			notarget = { 541286, 541281, 541266 },
			outofrange = { 541289, 541256, 541279 },
		},
		female = {
			yes = { 541331, 541365, 541319, 541338 },
			no = { 541340, 541326, 541343 },
			cheer = { 541328, 541320 },
			thank = { 541348, 541316, 541323 },
			hello = { 541370, 541375, 541329 },
			congrats = { 541317, 541358, 541332 },
			laugh = { 541153 },
			cry = { 541149 },
			nomana = { 541193, 541197, 541212 },
			notready = { 541189, 541202, 541223 },
			cantuse = { 541168 },
			notarget = { 541217, 541169, 541174 },
			outofrange = { 541194, 541183, 541161 },
		},
	},
	Troll = {
		male = {
			yes = { 543313, 543306, 543328, 543312 },
			no = { 543324, 543296, 543286, 543295 },
			cheer = { 543331, 543330, 543326 },
			thank = { 543290, 543297, 543325 },
			hello = { 543332, 543282, 543309 },
			congrats = { 543307, 543291, 543336 },
			laugh = { 543094 },
			cry = { 543090 },
			nomana = { 543217, 543216, 543208 },
			notready = { 543180, 543164, 543181 },
			cantuse = { 543210 },
			notarget = { 543192, 543190, 543221 },
			outofrange = { 543188, 543223, 543222 },
		},
		female = {
			yes = { 543267, 543268, 543249 },
			no = { 543252, 543240, 543239 },
			cheer = { 543253, 543277 },
			thank = { 543271, 543250, 543230 },
			hello = { 543263, 543235, 543227 },
			congrats = { 543273, 543233, 543243 },
			laugh = { 543091 },
			cry = { 543084 },
			nomana = { 543140, 543111, 543113 },
			notready = { 543129, 543107, 543127 },
			cantuse = { 543145 },
			notarget = { 543118, 543153, 543109 },
			outofrange = { 543151, 543142, 543139 },
		},
	},
	Tauren = {
		male = {
			yes = { 543046, 543030, 543036 },
			no = { 543042, 543080, 543059 },
			cheer = { 543078, 543025 },
			thank = { 543069, 543060, 543047, 543039 },
			hello = { 543074, 543035, 543029 },
			congrats = { 543038, 543070, 543027 },
			laugh = { 542898 },
			cry = { 542887 },
			nomana = { 542905, 542916, 542948 },
			notready = { 542924, 542954, 542923 },
			cantuse = { 542958 },
			notarget = { 542925, 542937, 542915 },
			outofrange = { 542965, 542935, 542926 },
		},
		female = {
			yes = { 543022, 542983, 543021 },
			no = { 542980, 543005, 542979 },
			cheer = { 542976, 542985 },
			thank = { 542974, 542973, 543000 },
			hello = { 542982, 542978, 542998 },
			congrats = { 542997, 542981, 542995 },
			laugh = { 542806 },
			cry = { 542815 },
			nomana = { 542830, 542848, 542886 },
			notready = { 542833, 542879, 542880 },
			cantuse = { 542843 },
			notarget = { 542872, 542851, 542885 },
			outofrange = { 542858, 542840, 542831 },
		},
	},
	Scourge = {
		male = {
			yes = { 542750, 542741, 542789 },
			no = { 542749, 542743, 542780 },
			cheer = { 542783, 542781 },
			thank = { 542787, 542779, 542737 },
			hello = { 542761, 542764, 542752 },
			congrats = { 542747, 542775, 542735 },
			laugh = { 542595 },
			cry = { 542601 },
			nomana = { 542665, 542637, 542646 },
			notready = { 542661, 542642, 542626 },
			cantuse = { 542612 },
			notarget = { 542639, 542628, 542657 },
			outofrange = { 542653, 542644, 542655 },
		},
		female = {
			yes = { 542729, 542703, 542718 },
			no = { 542681, 542675, 542723 },
			cheer = { 542697, 542691 },
			thank = { 542715, 542719, 542731 },
			hello = { 542699, 542678, 542722 },
			congrats = { 542684, 542694, 542724, 542726 },
			laugh = { 542518 },
			cry = { 542519 },
			nomana = { 542579, 542558, 542539 },
			notready = { 542574, 542531, 542541 },
			cantuse = { 542559 },
			notarget = { 542532, 542543, 542533 },
			outofrange = { 542553, 542577, 542537 },
		},
	},
}

local lastLine = { at = nil, priority = 0, handle = nil }

local function Try(fn, ...)
	if type(fn) ~= "function" then return nil end
	local ok, a, b, c, d = pcall(fn, ...)
	if ok then return a, b, c, d end
end

local function Print(msg)
	print("|cff66ccff[Claude WoW voice]|r " .. msg)
end

local function IsIn(list, value)
	for _, v in ipairs(list) do
		if v == value then return true end
	end
	return false
end

local function DB()
	ClaudeWoWDB = ClaudeWoWDB or {}
	local settings = ClaudeWoWDB.voice or {}
	ClaudeWoWDB.voice = settings
	if not IsIn(PACK_NAMES, settings.pack) then settings.pack = DEFAULT_PACK end
	settings.lines = settings.lines or {}
	return settings
end

local function CharacterVoice()
	local _, raceFile = Try(UnitRace, "player")
	local sex = Try(UnitSex, "player")
	return raceFile, sex == PLAYER_SEX_FEMALE and "female" or "male"
end

local function PackLines(pack)
	if pack == "race" then
		local race, gender = CharacterVoice()
		local voices = race and RACE_LINES[race]
		return voices and voices[gender]
	end
	return UNIT_PACK_LINES[pack]
end

local function SplitLineRef(ref)
	local pack, line = ref:match("^(%a+):(%a+)$")
	if pack then return pack, line end
	return nil, ref
end

local function ResolveLine(ref)
	local pack, line = SplitLineRef(ref)
	local candidates = pack and { pack } or { DB().pack, DEFAULT_PACK }
	for _, p in ipairs(candidates) do
		local lines = PackLines(p)
		if lines and lines[line] then return lines[line], p .. ":" .. line end
	end
end

local function EventLineRef(event)
	local db = DB()
	local override = db.lines[event]
	if override then return override, true end
	local defaults = EVENT_LINES[db.pack]
	return defaults and (db.pack .. ":" .. defaults[event]) or "off", false
end

local function PlayIds(ids)
	local id = ids[math.random(#ids)]
	local willPlay, handle = Try(PlaySoundFile, id, SOUND_CHANNEL)
	return willPlay and true or false, handle, id
end

local function Throttled(priority, now)
	if not lastLine.at then return false end
	if now - lastLine.at >= LINE_GAP_SECONDS then return false end
	return priority <= lastLine.priority
end

function V.LineFor(event)
	if DB().pack == "off" or not EVENT_PRIORITY[event] then return nil end
	local ref = EventLineRef(event)
	if ref == "off" then return nil end
	return ResolveLine(ref)
end

function V.Event(event)
	local ids = V.LineFor(event)
	if not ids then return false end
	local now = GetTime()
	local priority = EVENT_PRIORITY[event]
	if Throttled(priority, now) then return false end
	if lastLine.handle and lastLine.at and now - lastLine.at < LINE_GAP_SECONDS then
		Try(StopSound, lastLine.handle)
	end
	local played, handle, id = PlayIds(ids)
	lastLine = { at = now, priority = priority, handle = handle, id = id, event = event }
	return played
end

local startedMessages = {}

function V.Started(messageId)
	if messageId == nil or startedMessages[messageId] then return false end
	startedMessages[messageId] = true
	return V.Event("started")
end

function V.Reply(role, denied)
	if denied then return V.Event("permission") end
	return V.Event(role == "assistant" and "done" or "error")
end

function V.Last()
	return lastLine
end

local function LineNames(pack)
	local names = {}
	for name in pairs(PackLines(pack) or {}) do table.insert(names, name) end
	table.sort(names)
	return names
end

local function Status()
	local db = DB()
	local race, gender = CharacterVoice()
	local out = { "pack: " .. db.pack .. " (race follows this character: " .. tostring(race) .. " " .. gender .. ")" }
	for _, event in ipairs(EVENTS) do
		local ref, custom = EventLineRef(event)
		table.insert(out, string.format("  %s -> %s%s  (%s)", event, ref, custom and " [set]" or "", EVENT_MEANING[event]))
	end
	table.insert(out, "/claude-wow voice race|peasant|peon|off, set <event> <line>, reset, test <event|line>, lines [pack]")
	Print(table.concat(out, "\n"))
end

local function ListLines(pack)
	pack = pack ~= "" and pack or DB().pack
	if pack == "off" then pack = DEFAULT_PACK end
	local names = LineNames(pack)
	if #names == 0 then
		Print("no lines for " .. pack .. (pack == "race" and " on this character" or ""))
		return
	end
	Print(pack .. " lines: " .. table.concat(names, ", "))
end

local function SetLine(event, ref)
	if not EVENT_PRIORITY[event] then
		Print("unknown event " .. event .. ": " .. table.concat(EVENTS, ", "))
		return
	end
	local db = DB()
	if ref == "default" then
		db.lines[event] = nil
		Print(event .. " -> " .. EventLineRef(event))
		return
	end
	if ref == "off" then
		db.lines[event] = "off"
		Print(event .. " is silent")
		return
	end
	local ids, canonical = ResolveLine(ref)
	if not ids then
		Print("no line " .. ref .. ". /claude-wow voice lines [race|peasant|peon] lists them")
		return
	end
	db.lines[event] = canonical
	Print(event .. " -> " .. canonical)
end

local function TestLine(arg)
	local ids, label
	if EVENT_PRIORITY[arg] then
		if DB().pack == "off" then
			Print("voice is off: /claude-wow voice race|peasant|peon turns it on")
			return
		end
		ids, label = V.LineFor(arg), EventLineRef(arg)
	else
		ids, label = ResolveLine(arg)
	end
	if not ids then
		Print("nothing to play for " .. arg)
		return
	end
	local played, _, id = PlayIds(ids)
	Print(label .. " (FileDataID " .. id .. ")" .. (played and "" or " did not play"))
end

local SIMPLE_WORDS = { [""] = true, status = true, on = true, reset = true }

function V.IsCommand(rest)
	local words = {}
	for w in (rest or ""):lower():gmatch("%S+") do table.insert(words, w) end
	local first = words[1] or ""
	if #words <= 1 and (SIMPLE_WORDS[first] or IsIn(PACK_NAMES, first)) then return true end
	if first == "lines" then return #words <= 2 end
	if first == "set" then return #words == 3 and EVENT_PRIORITY[words[2]] ~= nil end
	if first == "test" then return #words == 2 end
	return false
end

function V.Command(rest)
	local words = {}
	for w in (rest or ""):lower():gmatch("%S+") do table.insert(words, w) end
	local first = words[1] or ""
	local db = DB()
	if first == "" or first == "status" then
		Status()
	elseif first == "on" then
		if db.pack == "off" then db.pack = DEFAULT_PACK end
		Status()
	elseif IsIn(PACK_NAMES, first) then
		db.pack = first
		Status()
	elseif first == "reset" then
		db.pack = DEFAULT_PACK
		db.lines = {}
		Status()
	elseif first == "lines" then
		ListLines(words[2] or "")
	elseif first == "set" and words[2] and words[3] then
		SetLine(words[2], words[3])
	elseif first == "test" and words[2] then
		TestLine(words[2])
	else
		Status()
	end
end

V.EVENTS = EVENTS
V.PACK_NAMES = PACK_NAMES
V.RACE_LINES = RACE_LINES
V.UNIT_PACK_LINES = UNIT_PACK_LINES
V.EVENT_LINES = EVENT_LINES
