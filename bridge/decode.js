'use strict';
// Pure strip decoder for the screenshot transport: reads the PNG or TGA file the
// game wrote and finds the WoWAI pixel strip in its top-left corner. Zero
// dependencies (PNG inflation is node's zlib). The cell, magic, length and
// checksum rules are exactly those of capture.ps1 / capture_x11.py /
// capture_mac.py, so both transports read the same Codec.lua output; the only
// knob that differs is the channel threshold (see `threshold` below), because a
// screenshot is bit-exact while a screen capture goes through gamma and scaling.
//
//   readImage(buf)                  -> { width, height, px(x, y) -> [r, g, b] }
//   decodeStrip(img, opts)          -> { id, text } | { error } | null (no magic)
//   findStrip(img, opts)            -> { msg, offset }

const zlib = require('zlib');

const MAGIC = 0xC71A;
const DEFAULTS = { cell: 4, cells: 200, maxRows: 48, threshold: 128, xSlack: 8, ySlack: 8 };

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
// Strip: identical rules to the capture scripts, threshold aside.
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

// Decode at (ox, oy). null = no magic there; { error } = a strip that fails a
// check; { id, text } = a message.
function decodeStrip(img, opts, ox = 0, oy = 0) {
  const o = options(opts);
  if (ox + o.cells * o.cell > img.width || oy + o.cell > img.height) return null;
  if (!hasMagic(img, o, ox, oy)) return null;
  const rowsAvailable = Math.min(o.maxRows, Math.floor((img.height - oy) / o.cell));
  const total = o.cells * rowsAvailable;
  const out = [];
  let acc = 0, nbits = 0, needed = 6;
  for (let i = 0; i < total && out.length < needed; i++) {
    acc = (acc << 3) | cellValue(img, o, i % o.cells, Math.floor(i / o.cells), ox, oy);
    nbits += 3;
    while (nbits >= 8) {
      out.push((acc >> (nbits - 8)) & 0xff);
      nbits -= 8;
      acc &= (1 << nbits) - 1;
      if (out.length === 6) {
        const length = out[4] * 256 + out[5];
        needed = 8 + length;
        if (needed > Math.floor(o.cells * o.maxRows * 3 / 8)) return { error: 'length' };
      }
      if (out.length >= needed) break;
    }
  }
  if (out.length < needed) return { error: 'truncated' };
  const length = out[4] * 256 + out[5];
  let s1 = 0, s2 = 0;
  for (let k = 2; k < 6 + length; k++) { s1 = (s1 + out[k]) % 255; s2 = (s2 + s1) % 255; }
  if (out[6 + length] !== s1 || out[7 + length] !== s2) return { error: 'checksum' };
  return { id: out[2] * 256 + out[3], text: Buffer.from(out.slice(6, 6 + length)).toString('utf8') };
}

// Try the last good offset, then a small window around the origin. Returns
// { msg, offset }: msg null when no magic was found anywhere.
function findStrip(img, opts, hint) {
  const o = options(opts);
  const cands = hint ? [hint] : [];
  for (let dy = 0; dy <= o.ySlack; dy++) for (let dx = 0; dx <= o.xSlack; dx++) cands.push([dx, dy]);
  for (const [ox, oy] of cands) {
    const msg = decodeStrip(img, o, ox, oy);
    if (msg) return { msg, offset: [ox, oy] };
  }
  return { msg: null, offset: hint || null };
}

module.exports = { MAGIC, DEFAULTS, isPNG, looksLikeTGA, readPNG, readTGA, readImage, decodeStrip, findStrip };
