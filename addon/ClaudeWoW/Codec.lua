-- ClaudeWoW pixel codec. Pure Lua, no WoW APIs, so it can be tested outside the game.
--
-- A message is a byte stream:
--   [magic: 2 bytes] [id hi, id lo] [len hi, len lo] [payload: len bytes] [fletcher s1, s2]
-- The checksum covers id..payload. Two codecs turn the bytes into cells, each cell
-- one square drawn with SetColorTexture, packed MSB-first, row by row:
--
--   1  magic C7 1A, 4 px cells, 3 bits a cell: R, G and B each fully on or off
--      (bit 2 = R, bit 1 = G, bit 0 = B), 200 cells a row. Pure primaries survive
--      any gamma or contrast setting, which a screen capture goes through: the
--      pixel transport (capture.ps1, capture_x11.py, capture_mac.py), and the
--      screenshot transport for a bridge that has not asked for codec 2.
--   2  magic C7 2A, 2 px cells, 6 bits a cell: R, G and B each at one of four
--      levels (bits 5-4 = R, 3-2 = G, 1-0 = B), 400 cells a row: eight times the
--      payload per screen area. Four ramp cells come first, every channel at
--      level 0, 1, 2, 3 in turn; the decoder (bridge/decode.js) reads the actual
--      levels off them and classes each channel sample by the nearest, so the
--      numbers are the drawer's business. Only for the screenshot transport,
--      whose PNG/TGA is a bit-exact copy of the frame, and only when the bridge
--      asks for it (`strip = { on, off, codec = 2 }` in its slot files).
--
-- The magic names the codec, so a bridge and an addon of different versions
-- never read one strip as the other: each side finds no magic and moves on.

ClaudeWoW_Codec = {}
local C = ClaudeWoW_Codec

C.MAGIC1, C.MAGIC2 = 0xC7, 0x1A -- codec 1
C.MAGIC2_DENSE = 0x2A           -- codec 2 (the first byte is the same)
C.BITS = 3                      -- codec 1's bits per cell (the name the capture scripts grew up with)
C.MAX_PAYLOAD = 3200
-- Per codec: cell size in pixels, cells per row, rows at most, bits per cell,
-- levels per channel, and how many ramp cells lead.
C.GEOMETRY = {
	[1] = { cell = 4, cells = 200, rows = 48, bits = 3, levels = 2, ramp = 0 },
	[2] = { cell = 2, cells = 400, rows = 48, bits = 6, levels = 4, ramp = 4 },
}
-- Codec 2's ramp: cell values with every channel at level 0, 1, 2, 3.
C.RAMP = { 0, 21, 42, 63 }

function C.Fletcher16(bytes, from, to)
	local s1, s2 = 0, 0
	for i = from, to do
		s1 = (s1 + bytes[i]) % 255
		s2 = (s2 + s1) % 255
	end
	return s1, s2
end

-- Returns an array of cell values (0 .. 2^bits - 1, the ramp first for codec 2)
-- and the number of bytes encoded. `codec` is 1 (the default) or 2.
function C.Encode(id, payload, codec)
	codec = codec == 2 and 2 or 1
	local geo = C.GEOMETRY[codec]
	local len = #payload
	local bytes = {
		C.MAGIC1, codec == 2 and C.MAGIC2_DENSE or C.MAGIC2,
		math.floor(id / 256) % 256, id % 256,
		math.floor(len / 256) % 256, len % 256,
	}
	for i = 1, len do
		bytes[#bytes + 1] = payload:byte(i)
	end
	local s1, s2 = C.Fletcher16(bytes, 3, 6 + len)
	bytes[#bytes + 1] = s1
	bytes[#bytes + 1] = s2

	local BITS = geo.bits
	local base = 2 ^ BITS
	local cells = {}
	for i = 1, geo.ramp do
		cells[i] = C.RAMP[i]
	end
	local acc, nbits = 0, 0
	for i = 1, #bytes do
		acc = acc * 256 + bytes[i]
		nbits = nbits + 8
		while nbits >= BITS do
			local shift = nbits - BITS
			cells[#cells + 1] = math.floor(acc / 2 ^ shift) % base
			nbits = shift
			acc = acc % 2 ^ nbits
		end
	end
	if nbits > 0 then
		cells[#cells + 1] = (acc * 2 ^ (BITS - nbits)) % base
	end
	return cells, #bytes
end

-- Codec 1: color for a cell value, each channel fully on (1) or off (0).
function C.CellColor(v)
	local r = math.floor(v / 4) % 2
	local g = math.floor(v / 2) % 2
	local b = v % 2
	return r, g, b
end

-- Codec 2: the level (0..3) of each channel for a cell value.
function C.DenseCellColor(v)
	local r = math.floor(v / 16) % 4
	local g = math.floor(v / 4) % 4
	local b = v % 4
	return r, g, b
end

-- Codec 2: the four levels (0..255, integers) spread evenly from `off` to `on`,
-- the two levels the bridge names for the strip. 0/60 gives 0, 20, 40, 60. The
-- bridge computes the same numbers (protocol.denseLevels), though its decoder
-- reads them off the ramp anyway.
function C.DenseLevels(on, off)
	local t = {}
	for k = 0, 3 do
		t[k + 1] = math.floor(off + k * (on - off) / 3 + 0.5)
	end
	return t
end
