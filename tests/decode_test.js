// The screenshot transport's decoder (bridge/decode.js): the addon's real
// Codec.lua encodes, the test renders the strip into the files the client can
// write (PNG with every filter type, RGB and RGBA; TGA raw and RLE, 24 and 32
// bit, both row orders) inside a full 1920x1080 frame of noise, and the
// decoder must read it back exactly. Same rules as the capture scripts, so
// tests/codec_test.js and this one agree on what a strip is.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const fengari = require('fengari');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari;
const D = require('../bridge/decode');

const CODEC = path.join(__dirname, '..', 'addon', 'WoWAI', 'Codec.lua');
const CELL = 4, CELLS = 200, MAXROWS = 48;

function encodeWithLua(id, payload) {
  const bytes = Buffer.from(payload, 'utf8');
  const lit = '"' + [...bytes].map(b => '\\' + b).join('') + '"';
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const code = fs.readFileSync(CODEC, 'utf8') +
    `\nlocal cells = WoWAI_Codec.Encode(${id}, ${lit})\n` +
    `local t = {}\nfor i = 1, #cells do t[i] = string.format("%d", cells[i]) end\n` +
    `RESULT = table.concat(t, ",")\n`;
  if (lauxlib.luaL_dostring(L, to_luastring(code)) !== 0) throw new Error('Lua error: ' + to_jsstring(lua.lua_tostring(L, -1)));
  lua.lua_getglobal(L, to_luastring('RESULT'));
  return to_jsstring(lua.lua_tostring(L, -1)).split(',').map(Number);
}

// A frame of the given size: noise everywhere (like a game world), the strip's
// cells at (ox, oy) painted with `on`/`off` levels per channel, plus optional
// jitter on the strip itself. Returns an RGB buffer.
function frame({ width, height, cells, ox = 0, oy = 0, on = 255, off = 0, jitter = 0, seed = 1 }) {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const rgb = Buffer.alloc(width * height * 3);
  for (let i = 0; i < rgb.length; i++) rgb[i] = Math.floor(rnd() * 256);
  const rows = Math.ceil(cells.length / CELLS);
  for (let r = 0; r < rows; r++) for (let c = 0; c < CELLS; c++) {
    const v = cells[r * CELLS + c] || 0;
    const lv = [Math.floor(v / 4) % 2, Math.floor(v / 2) % 2, v % 2].map(b => (b ? on : off));
    for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) {
      const o = ((oy + r * CELL + y) * width + (ox + c * CELL + x)) * 3;
      for (let k = 0; k < 3; k++) {
        const n = jitter ? Math.round((rnd() * 2 - 1) * jitter) : 0;
        rgb[o + k] = Math.max(0, Math.min(255, lv[k] + n));
      }
    }
  }
  return rgb;
}

// PNG writer that uses a different filter on every row (0..4 cycling), so the
// reader's unfilter code is exercised on real data, in RGB or RGBA.
function png(width, height, rgb, { alpha = false, filters = [0, 1, 2, 3, 4] } = {}) {
  const ch = alpha ? 4 : 3;
  const stride = width * ch;
  const rows = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const s = (y * width + x) * 3, d = y * stride + x * ch;
    rows[d] = rgb[s]; rows[d + 1] = rgb[s + 1]; rows[d + 2] = rgb[s + 2];
    if (alpha) rows[d + 3] = 255;
  }
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const f = filters[y % filters.length];
    raw[y * (stride + 1)] = f;
    for (let i = 0; i < stride; i++) {
      const x = rows[y * stride + i];
      const a = i >= ch ? rows[y * stride + i - ch] : 0;
      const b = y > 0 ? rows[(y - 1) * stride + i] : 0;
      const c = y > 0 && i >= ch ? rows[(y - 1) * stride + i - ch] : 0;
      let v;
      if (f === 0) v = x;
      else if (f === 1) v = x - a;
      else if (f === 2) v = x - b;
      else if (f === 3) v = x - ((a + b) >> 1);
      else {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v = x - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      raw[y * (stride + 1) + 1 + i] = v & 0xff;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = alpha ? 6 : 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// TGA writer: type 2 (raw) or 10 (RLE) truecolor, 24 or 32 bpp, top-left or
// bottom-left origin. The Forever client writes type 10, 32 bpp, top-left.
function tga(width, height, rgb, { bpp = 32, rle = false, topDown = true } = {}) {
  const bytesPP = bpp / 8;
  const hdr = Buffer.alloc(18);
  hdr[2] = rle ? 10 : 2;
  hdr.writeUInt16LE(width, 12); hdr.writeUInt16LE(height, 14);
  hdr[16] = bpp; hdr[17] = (topDown ? 0x20 : 0) | (bpp === 32 ? 8 : 0);
  const pixels = [];
  for (let row = 0; row < height; row++) {
    const y = topDown ? row : height - 1 - row;
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 3;
      const p = Buffer.alloc(bytesPP);
      p[0] = rgb[s + 2]; p[1] = rgb[s + 1]; p[2] = rgb[s];
      if (bytesPP === 4) p[3] = 255;
      pixels.push(p);
    }
  }
  const parts = [hdr];
  if (!rle) {
    parts.push(Buffer.concat(pixels));
  } else {
    // Runs of equal pixels become run packets, the rest raw packets, 128 max each.
    let i = 0;
    while (i < pixels.length) {
      let run = 1;
      while (run < 128 && i + run < pixels.length && pixels[i + run].equals(pixels[i])) run++;
      if (run > 1) {
        parts.push(Buffer.from([0x80 | (run - 1)]), pixels[i]);
        i += run;
      } else {
        let n = 1;
        while (n < 128 && i + n < pixels.length && !(i + n + 1 < pixels.length && pixels[i + n].equals(pixels[i + n + 1]))) n++;
        parts.push(Buffer.from([n - 1]), ...pixels.slice(i, i + n));
        i += n;
      }
    }
  }
  return Buffer.concat(parts);
}

const PAYLOAD = 'sess1\x1Fchat1\x1F7\x1F/Users/me/proj\x1F\x1Fname\x1Fhéllo wörld ✓ — "quotes" & \\backslash\\ end';
const LONG = 'sess1\x1Fchat1\x1F4242\x1F\x1Fn\x1F\x1F' + 'Refactor the player controller so jumping feels less floaty. '.repeat(40);
const W = 1920, H = 1080;

test('the PNG reader unfilters every filter type, RGB and RGBA', () => {
  const cells = encodeWithLua(7, PAYLOAD);
  const rgb = frame({ width: 320, height: 40, cells: cells.slice(0, 0) }); // pure noise, exact read-back
  for (const alpha of [false, true]) {
    const img = D.readPNG(png(320, 40, rgb, { alpha }));
    assert.equal(img.width, 320); assert.equal(img.height, 40);
    for (let y = 0; y < 40; y += 7) for (let x = 0; x < 320; x += 13) {
      const o = (y * 320 + x) * 3;
      assert.deepEqual(img.px(x, y), [rgb[o], rgb[o + 1], rgb[o + 2]], `pixel ${x},${y} alpha=${alpha}`);
    }
  }
  assert.throws(() => D.readPNG(Buffer.from('not a png')), /not a PNG/);
});

test('the TGA reader takes raw and RLE, 24 and 32 bit, both row orders', () => {
  const rgb = frame({ width: 300, height: 30, cells: [] });
  for (const opts of [{ bpp: 24, rle: false, topDown: true }, { bpp: 32, rle: false, topDown: false }, { bpp: 32, rle: true, topDown: true }, { bpp: 24, rle: true, topDown: false }]) {
    const img = D.readTGA(tga(300, 30, rgb, opts));
    assert.equal(img.width, 300); assert.equal(img.height, 30);
    for (let y = 0; y < 30; y += 5) for (let x = 0; x < 300; x += 11) {
      const o = (y * 300 + x) * 3;
      assert.deepEqual(img.px(x, y), [rgb[o], rgb[o + 1], rgb[o + 2]], `pixel ${x},${y} ${JSON.stringify(opts)}`);
    }
  }
  // RLE with real runs: a flat strip compresses to run packets.
  const flat = Buffer.alloc(64 * 8 * 3, 200);
  const img = D.readTGA(tga(64, 8, flat, { bpp: 32, rle: true }));
  assert.deepEqual(img.px(63, 7), [200, 200, 200]);
  assert.throws(() => D.readTGA(Buffer.alloc(10)), /not a TGA/);
});

test('readImage sniffs the format from the bytes, not the name', () => {
  const rgb = frame({ width: 16, height: 8, cells: [] });
  assert.equal(D.readImage(png(16, 8, rgb)).format, 'png');
  assert.equal(D.readImage(tga(16, 8, rgb)).format, 'tga');
  assert.throws(() => D.readImage(Buffer.from('\xff\xd8\xff JPEG')), /not a PNG or TGA/);
});

test('a strip in the corner of a full-frame screenshot decodes from PNG and TGA, bright palette', () => {
  for (const [id, payload] of [[7, PAYLOAD], [4242, LONG]]) {
    const cells = encodeWithLua(id, payload);
    const rgb = frame({ width: W, height: H, cells, jitter: 40 });
    const files = [
      ['png rgb', png(W, H, rgb)],
      ['png rgba', png(W, H, rgb, { alpha: true })],
      ['tga rle32 top-down (the client\'s)', tga(W, H, rgb, { bpp: 32, rle: true, topDown: true })],
      ['tga raw24 bottom-up', tga(W, H, rgb, { bpp: 24, rle: false, topDown: false })],
    ];
    for (const [name, buf] of files) {
      const img = D.readImage(buf);
      const { msg, offset } = D.findStrip(img, { cell: CELL, cells: CELLS, maxRows: MAXROWS, threshold: 128 });
      assert.ok(msg && !msg.error, `${name} id=${id}: ${JSON.stringify(msg)}`);
      assert.equal(msg.id, id, name);
      assert.equal(msg.text, payload, name);
      assert.deepEqual(offset, [0, 0], name);
    }
  }
});

test('the decoder threshold is a parameter: a dark palette reads with a low one and fails with the bright one', () => {
  const cells = encodeWithLua(9, PAYLOAD);
  const rgb = frame({ width: 900, height: 200, cells, on: 60, off: 0, jitter: 6 });
  const img = D.readPNG(png(900, 200, rgb));
  const dark = D.findStrip(img, { threshold: 30 });
  assert.equal(dark.msg && dark.msg.text, PAYLOAD);
  assert.equal(dark.msg.id, 9);
  // At >= 128 every dark cell reads as 0: no magic, nothing found, no false decode.
  assert.equal(D.findStrip(img, { threshold: 128 }).msg, null);
});

test('a strip a few pixels off the origin is still found, and a hint is tried first', () => {
  const cells = encodeWithLua(11, PAYLOAD);
  const rgb = frame({ width: 900, height: 220, cells, ox: 3, oy: 5 });
  const img = D.readPNG(png(900, 220, rgb));
  const r = D.findStrip(img, {});
  assert.equal(r.msg && r.msg.id, 11);
  // The first offset whose cell-centre samples land inside the cells wins, which
  // can be up to half a cell before the true origin (capture_mac.py does the same).
  assert.ok(Math.abs(r.offset[0] - 3) <= 2 && Math.abs(r.offset[1] - 5) <= 2, JSON.stringify(r.offset));
  const hinted = D.findStrip(img, {}, [3, 5]);
  assert.equal(hinted.msg.text, PAYLOAD);
  assert.deepEqual(hinted.offset, [3, 5], 'the hint is tried first');
  // Beyond the search window it is not found (the window is deliberately small).
  const far = frame({ width: 900, height: 220, cells, ox: 20, oy: 20 });
  assert.equal(D.findStrip(D.readPNG(png(900, 220, far)), {}).msg, null);
});

test('no strip, a bad checksum and a truncated strip are told apart', () => {
  const noise = frame({ width: 900, height: 200, cells: [] });
  assert.equal(D.findStrip(D.readPNG(png(900, 200, noise)), {}).msg, null, 'noise alone has no magic');
  const cells = encodeWithLua(5, PAYLOAD);
  const bad = cells.slice();
  bad[30] ^= 1; // flip a payload bit
  const r1 = D.findStrip(D.readPNG(png(900, 200, frame({ width: 900, height: 200, cells: bad }))), {});
  assert.deepEqual(r1.msg, { error: 'checksum' });
  // A frame too short for the whole strip: truncated, not garbage.
  const short = frame({ width: 800, height: 4, cells: cells.slice(0, CELLS) });
  const r2 = D.findStrip(D.readPNG(png(800, 4, short)), {});
  assert.deepEqual(r2.msg, { error: 'truncated' });
  // A length field beyond what the strip can hold is rejected before reading on.
  const lenBomb = cells.slice(0, 40);
  // cells 10..15 carry the length bytes (bits 24..47): set them all to 7 (0xFFFF).
  for (let i = 10; i < 16; i++) lenBomb[i] = 7;
  const r3 = D.findStrip(D.readPNG(png(800, 8, frame({ width: 800, height: 8, cells: lenBomb }))), {});
  assert.deepEqual(r3.msg, { error: 'length' });
});

test('the decoder agrees with tests/codec_test.js on what the capture scripts read', () => {
  // Same encoding, same magic constant, same threshold default as capture_mac.py.
  assert.equal(D.MAGIC, 0xC71A);
  assert.equal(D.DEFAULTS.threshold, 128);
  assert.deepEqual([D.DEFAULTS.cell, D.DEFAULTS.cells, D.DEFAULTS.maxRows], [CELL, CELLS, MAXROWS]);
});
