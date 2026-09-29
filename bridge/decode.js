'use strict';
// Pure strip decoder for the screenshot transport: reads the PNG or TGA file the
// game wrote and finds the ClaudeWoW pixel strip in its top-left corner. Zero
// dependencies (PNG inflation is node's zlib). The cell, magic, length and
// checksum rules are exactly those of capture.ps1 / capture_x11.py /
// capture_mac.py, so both transports read the same Codec.lua output; the only
// knob that differs is the channel threshold (see `threshold` below), because a
// screenshot is bit-exact while a screen capture goes through gamma and scaling.
//
//   readImage(buf)                  -> { width, height, px(x, y) -> [r, g, b] }
//   decodeStrip(img, opts)          -> { id, text, rows } | { error } | null (no magic)
//   findStrip(img, opts)            -> { msg, offset }

const zlib = require('zlib');

// Codec 1 (the capture scripts' strip; the screenshot transport's for an addon
// that was not asked for codec 2): 4 px cells, one bit per channel at
// `threshold`. Codec 2 ("dense", screenshot transport only): 2 px cells, four
// levels per channel read off a four-cell ramp, six bits a cell, its own magic.
// See Codec.lua for the format. DENSE is fixed: the addon hard-codes it too.
const MAGIC = 0xC71A;
const MAGIC_DENSE = 0xC72A;
const DEFAULTS = { cell: 4, cells: 200, maxRows: 48, threshold: 128, xSlack: 8, ySlack: 8 };
const DENSE = { cell: 2, cells: 400, maxRows: 48, ramp: 4, minStep: 2 };

// ---------------------------------------------------------------------------
// PNG: 8-bit gray, gray+alpha, RGB, RGBA and palette; filters 0-4; no Adam7.
// ---------------------------------------------------------------------------

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function isPNG(buf) {
  return buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIG);
}

function readPNG(buf) {
  if (!isPNG(buf)) throw new Error('not a PNG');
  let pos = 8;
  let width = 0, height = 0, depth = 0, ctype = 0, interlace = 0;
  let palette = null;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const kind = buf.toString('ascii', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (kind === 'IHDR') {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4);
      depth = body[8]; ctype = body[9]; interlace = body[12];
    } else if (kind === 'PLTE') {
      palette = body;
    } else if (kind === 'IDAT') {
      idat.push(body);
    } else if (kind === 'IEND') {
      break;
    }
  }
  if (!width || !height) throw new Error('PNG without IHDR');
  if (depth !== 8) throw new Error(`unsupported PNG bit depth ${depth}`);
  if (interlace) throw new Error('interlaced PNGs are not supported');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype];
  if (!channels) throw new Error(`unsupported PNG color type ${ctype}`);
  if (ctype === 3 && !palette) throw new Error('palette PNG without PLTE');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) throw new Error('PNG data is truncated');
  const out = Buffer.alloc(stride * height);
  const bpp = channels;
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const prev = y > 0 ? dst - stride : -1;
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i];
      const a = i >= bpp ? out[dst + i - bpp] : 0;
      const b = prev >= 0 ? out[prev + i] : 0;
      const c = prev >= 0 && i >= bpp ? out[prev + i - bpp] : 0;
      let v;
      switch (f) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`bad PNG filter ${f} on row ${y}`);
      }
      out[dst + i] = v & 0xff;
    }
  }
  let px;
  if (ctype === 2 || ctype === 6) {
    px = (x, y) => { const o = y * stride + x * channels; return [out[o], out[o + 1], out[o + 2]]; };
  } else if (ctype === 3) {
    px = (x, y) => { const o = out[y * stride + x] * 3; return [palette[o], palette[o + 1], palette[o + 2]]; };
  } else {
    px = (x, y) => { const g = out[y * stride + x * channels]; return [g, g, g]; };
  }
  return { width, height, px, format: 'png' };
}

// ---------------------------------------------------------------------------
// TGA: truecolor and grayscale, raw (2, 3) or RLE (10, 11), 24/32 bpp (16-bit
// too), either row order. The Forever client writes type 10, 32 bpp, top-left.
// ---------------------------------------------------------------------------

function looksLikeTGA(buf) {
  if (buf.length < 18) return false;
  const cmapType = buf[1], type = buf[2], bpp = buf[16];
  return (cmapType === 0 || cmapType === 1) && [1, 2, 3, 9, 10, 11].includes(type) && [8, 15, 16, 24, 32].includes(bpp);
}

function readTGA(buf) {
  if (!looksLikeTGA(buf)) throw new Error('not a TGA');
  const idLen = buf[0], cmapType = buf[1], type = buf[2];
  const cmapLen = buf.readUInt16LE(5), cmapBits = buf[7];
  const width = buf.readUInt16LE(12), height = buf.readUInt16LE(14);
  const bpp = buf[16], desc = buf[17];
  if (cmapType !== 0 || type === 1 || type === 9) throw new Error('color-mapped TGAs are not supported');
  if (!(type === 2 || type === 3 || type === 10 || type === 11)) throw new Error(`unsupported TGA type ${type}`);
  const bytesPP = bpp >> 3;
  if (![1, 2, 3, 4].includes(bytesPP)) throw new Error(`unsupported TGA depth ${bpp}`);
  const topDown = (desc & 0x20) !== 0;
  const rightToLeft = (desc & 0x10) !== 0;
  let pos = 18 + idLen + (cmapType ? cmapLen * ((cmapBits + 7) >> 3) : 0);
  const n = width * height;
  const out = Buffer.alloc(n * bytesPP);
  if (type === 2 || type === 3) {
    if (buf.length < pos + n * bytesPP) throw new Error('TGA data is truncated');
    buf.copy(out, 0, pos, pos + n * bytesPP);
  } else {
    let i = 0;
    while (i < n) {
      if (pos >= buf.length) throw new Error('TGA data is truncated');
      const h = buf[pos++];
      const count = (h & 0x7f) + 1;
      if (i + count > n) throw new Error('TGA RLE packet overruns the image');
      if (h & 0x80) {
        if (pos + bytesPP > buf.length) throw new Error('TGA data is truncated');
        for (let k = 0; k < count; k++) buf.copy(out, (i + k) * bytesPP, pos, pos + bytesPP);
        pos += bytesPP;
      } else {
        if (pos + count * bytesPP > buf.length) throw new Error('TGA data is truncated');
        buf.copy(out, i * bytesPP, pos, pos + count * bytesPP);
        pos += count * bytesPP;
      }
      i += count;
    }
  }
  const gray = type === 3 || type === 11;
  const px = (x, y) => {
    const row = topDown ? y : height - 1 - y;
    const col = rightToLeft ? width - 1 - x : x;
    const o = (row * width + col) * bytesPP;
    if (gray) { const g = out[o]; return [g, g, g]; }
    if (bytesPP === 2) {
      const v = out.readUInt16LE(o); // ARRRRRGG GGGBBBBB, 5 bits each
      return [((v >> 10) & 31) * 255 / 31 | 0, ((v >> 5) & 31) * 255 / 31 | 0, (v & 31) * 255 / 31 | 0];
    }
    return [out[o + 2], out[o + 1], out[o]]; // stored BGR(A)
  };
  return { width, height, px, format: 'tga' };
}

function readImage(buf) {
  if (isPNG(buf)) return readPNG(buf);
  if (looksLikeTGA(buf)) return readTGA(buf);
  throw new Error('not a PNG or TGA');
}

// ---------------------------------------------------------------------------
// Strip. Codec 1: identical rules to the capture scripts, threshold aside.
// Codec 2: the dense strip. The byte stream after the magic is the same.
// ---------------------------------------------------------------------------

function options(opts) {
  return { ...DEFAULTS, ...(opts || {}) };
}

function cellValue(img, o, c, r, ox, oy) {
  const [rr, gg, bb] = img.px(ox + c * o.cell + (o.cell >> 1), oy + r * o.cell + (o.cell >> 1));
  return (rr >= o.threshold ? 4 : 0) + (gg >= o.threshold ? 2 : 0) + (bb >= o.threshold ? 1 : 0);
}

function hasMagic(img, o, ox, oy) {
  let acc = 0;
  for (let i = 0; i < 6; i++) acc = (acc << 3) | cellValue(img, o, i, 0, ox, oy); // 18 bits cover the two magic bytes
  return (acc >> 2) === MAGIC;
}

// The byte stream [magic][id][len][payload][fletcher] out of `total` cells of
// `bits` bits each, cell i's value from cellAt(i) (row-major, ramp excluded),
// stopping as soon as the length field says the stream is complete; a length
// no strip can hold (`capacity` bytes) is refused before reading on.
// { out, cellsRead } or { error }.
function readStream(cellAt, total, bits, capacity) {
  const out = [];
  let acc = 0, nbits = 0, needed = 6, cellsRead = 0;
  for (let i = 0; i < total && out.length < needed; i++) {
    acc = (acc << bits) | cellAt(i);
    cellsRead = i + 1;
    nbits += bits;
    while (nbits >= 8) {
      out.push((acc >> (nbits - 8)) & 0xff);
      nbits -= 8;
      acc &= (1 << nbits) - 1;
      if (out.length === 6) {
        needed = 8 + out[4] * 256 + out[5];
        if (needed > capacity) return { error: 'length' };
      }
      if (out.length >= needed) break;
    }
  }
  if (out.length < needed) return { error: 'truncated' };
  return { out, cellsRead };
}

// The checks after the stream, then the message. rows: how many cell rows the
// strip covered, height: the pixels they span, so a caller that wants the rest
// of the frame (vision) knows how much of the top to cut off.
function message(out, cellsRead, cells, cellPx, codec) {
  const length = out[4] * 256 + out[5];
  let s1 = 0, s2 = 0;
  for (let k = 2; k < 6 + length; k++) { s1 = (s1 + out[k]) % 255; s2 = (s2 + s1) % 255; }
  if (out[6 + length] !== s1 || out[7 + length] !== s2) return { error: 'checksum' };
  const rows = Math.ceil(cellsRead / cells);
  return { id: out[2] * 256 + out[3], text: Buffer.from(out.slice(6, 6 + length)).toString('utf8'), rows, height: rows * cellPx, codec };
}

// Decode a codec-1 strip at (ox, oy). null = no magic there; { error } = a strip
// that fails a check; { id, text, rows, height, codec } = a message.
function decodeStrip(img, opts, ox = 0, oy = 0) {
  const o = options(opts);
  if (ox + o.cells * o.cell > img.width || oy + o.cell > img.height) return null;
  if (!hasMagic(img, o, ox, oy)) return null;
  const rowsAvailable = Math.min(o.maxRows, Math.floor((img.height - oy) / o.cell));
  const r = readStream(i => cellValue(img, o, i % o.cells, Math.floor(i / o.cells), ox, oy),
    o.cells * rowsAvailable, 3, Math.floor(o.cells * o.maxRows * 3 / 8));
  if (r.error) return r;
  return message(r.out, r.cellsRead, o.cells, o.cell, 1);
}

// Codec 2's cell reader, calibrated on the ramp: cells 0..3 hold every channel
// at level 0..3, so they give the four levels per channel as this frame really
// holds them, and every later channel sample is classed by the nearest of the
// four. A screenshot is bit-exact and the default levels are 0/20/40/60, so the
// ramp measures exactly what the addon drew and the nearest level is never in
// doubt; what it buys is independence from the numbers (any four levels a
// bridge and an addon agree on, or a client that one day applies a curve to
// its screenshots, decode the same) and a cheap check before the magic: a ramp
// that is not rising in all three channels is not a strip. Null when it is not.
function denseReader(img, o, ox, oy) {
  const at = (c, r) => img.px(ox + c * o.cell + (o.cell >> 1), oy + r * o.cell + (o.cell >> 1));
  const levels = [[], [], []];
  for (let k = 0; k < o.ramp; k++) { const p = at(k, 0); for (let ch = 0; ch < 3; ch++) levels[ch][k] = p[ch]; }
  for (let ch = 0; ch < 3; ch++) for (let k = 1; k < o.ramp; k++) if (levels[ch][k] - levels[ch][k - 1] < o.minStep) return null;
  const nearest = (v, ch) => {
    let best = 0;
    for (let k = 1; k < o.ramp; k++) if (Math.abs(v - levels[ch][k]) < Math.abs(v - levels[ch][best])) best = k;
    return best;
  };
  return i => {
    const j = i + o.ramp;
    const p = at(j % o.cells, Math.floor(j / o.cells));
    return (nearest(p[0], 0) << 4) | (nearest(p[1], 1) << 2) | nearest(p[2], 2);
  };
}

// Decode a codec-2 strip at (ox, oy); same results as decodeStrip. opts.dense
// may override DENSE (tests); the addon's geometry is fixed.
function decodeDense(img, opts, ox = 0, oy = 0) {
  const o = { ...DENSE, ...((opts && opts.dense) || {}) };
  if (ox + o.cells * o.cell > img.width || oy + o.cell > img.height) return null;
  const cellAt = denseReader(img, o, ox, oy);
  if (!cellAt) return null;
  if ((((cellAt(0) << 12) | (cellAt(1) << 6) | cellAt(2)) >> 2) !== MAGIC_DENSE) return null; // 18 bits cover the two magic bytes
  const rowsAvailable = Math.min(o.maxRows, Math.floor((img.height - oy) / o.cell));
  const r = readStream(cellAt, o.cells * rowsAvailable - o.ramp, 6, Math.floor((o.cells * o.maxRows - o.ramp) * 6 / 8));
  if (r.error) return r;
  return message(r.out, r.cellsRead + o.ramp, o.cells, o.cell, 2);
}

// Try the last good offset, then a small window around the origin; at each,
// the dense codec first, then codec 1 (opts.dense === false leaves the dense
// one out). Returns { msg, offset }: msg null when no magic was found anywhere.
function findStrip(img, opts, hint) {
  const o = options(opts);
  const cands = hint ? [hint] : [];
  for (let dy = 0; dy <= o.ySlack; dy++) for (let dx = 0; dx <= o.xSlack; dx++) cands.push([dx, dy]);
  for (const [ox, oy] of cands) {
    const msg = (o.dense !== false && decodeDense(img, o, ox, oy)) || decodeStrip(img, o, ox, oy);
    if (msg) return { msg, offset: [ox, oy] };
  }
  return { msg: null, offset: hint || null };
}

module.exports = { MAGIC, MAGIC_DENSE, DEFAULTS, DENSE, isPNG, looksLikeTGA, readPNG, readTGA, readImage, decodeStrip, decodeDense, findStrip };
