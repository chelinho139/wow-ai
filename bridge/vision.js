'use strict';
// Vision: the part of a screenshot that is not the strip. On the screenshot
// transport the game writes a full frame per message; decode.js reads the strip
// out of its top-left corner and the rest of the frame is the game as the
// player saw it when they pressed Enter. This module turns that frame into a
// small PNG the agent can look at: crop the strip's rows off the top, box-filter
// it down to at most `maxWidth` pixels wide, and write an RGB PNG (zero
// dependencies: the deflate is node's zlib). Pure; bridge.js does the I/O.
//
//   gameView(img, { cropTop, maxWidth }) -> { width, height, rgb }
//   encodePNG(view)                      -> Buffer
//   pngSize(buf)                         -> { width, height } (for tests and logs)

const zlib = require('zlib');

const DEFAULTS = { maxWidth: 1280, keep: 6 };

// `img` is what decode.readImage returns ({ width, height, px(x, y) -> [r, g, b] }).
// The top `cropTop` rows are dropped (the strip, and whatever was drawn behind
// it), then the rest is scaled to `maxWidth` wide by area averaging: every
// output pixel is the mean of the source rectangle it covers, so text stays
// legible and nothing aliases. A frame already narrow enough is only cropped.
function gameView(img, opts = {}) {
  const maxWidth = Math.max(1, Math.floor(opts.maxWidth || DEFAULTS.maxWidth));
  const cropTop = Math.max(0, Math.min(Math.floor(opts.cropTop || 0), img.height - 1));
  const srcW = img.width, srcH = img.height - cropTop;
  if (srcW < 1 || srcH < 1) throw new Error('nothing left of the frame after the crop');
  const scale = srcW > maxWidth ? maxWidth / srcW : 1;
  const outW = Math.max(1, Math.round(srcW * scale));
  const outH = Math.max(1, Math.round(srcH * scale));
  const rgb = Buffer.alloc(outW * outH * 3);
  // Source bounds of each output column / row, computed once.
  const xs = new Int32Array(outW + 1), ys = new Int32Array(outH + 1);
  for (let X = 0; X <= outW; X++) xs[X] = Math.min(srcW, Math.round(X / scale));
  for (let Y = 0; Y <= outH; Y++) ys[Y] = Math.min(srcH, Math.round(Y / scale));
  for (let Y = 0; Y < outH; Y++) {
    const y0 = ys[Y], y1 = Math.max(y0 + 1, ys[Y + 1]);
    for (let X = 0; X < outW; X++) {
      const x0 = xs[X], x1 = Math.max(x0 + 1, xs[X + 1]);
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = y0; y < y1 && y < srcH; y++) {
        for (let x = x0; x < x1 && x < srcW; x++) {
          const p = img.px(x, y + cropTop);
          r += p[0]; g += p[1]; b += p[2]; n++;
        }
      }
      const o = (Y * outW + X) * 3;
      if (n) { rgb[o] = (r / n) | 0; rgb[o + 1] = (g / n) | 0; rgb[o + 2] = (b / n) | 0; }
    }
  }
  return { width: outW, height: outH, rgb };
}

function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

// An 8-bit RGB PNG. Every row uses the Paeth filter (type 4), which is what
// keeps a game frame small: a screenshot filtered this way deflates to about a
// third of the unfiltered size, and one filter for all rows keeps this simple.
function encodePNG({ width, height, rgb }) {
  if (rgb.length !== width * height * 3) throw new Error('rgb buffer does not match width x height');
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const src = y * stride, dst = y * (stride + 1);
    raw[dst] = 4;
    for (let i = 0; i < stride; i++) {
      const x = rgb[src + i];
      const a = i >= 3 ? rgb[src + i - 3] : 0;
      const b = y > 0 ? rgb[src - stride + i] : 0;
      const c = y > 0 && i >= 3 ? rgb[src - stride + i - 3] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      raw[dst + 1 + i] = (x - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB, no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw, { level: 6 })), pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function pngSize(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24 || buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// The prefix vision files in the bridge's tmp folder carry, and a name for one.
const FILE_PREFIX = 'vision-';
function fileName(jobId) { return `${FILE_PREFIX}${jobId}-${Date.now().toString(36)}.png`; }
function isVisionFile(name) { return String(name || '').startsWith(FILE_PREFIX) && /\.png$/i.test(String(name)); }

module.exports = { DEFAULTS, gameView, encodePNG, pngSize, fileName, isVisionFile, FILE_PREFIX };
