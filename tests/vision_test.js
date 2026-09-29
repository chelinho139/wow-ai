// Unit tests for bridge/vision.js: the screenshot's game view, cropped and
// downscaled into a PNG the agent can look at. The PNG is read back with the
// bridge's own decoder (decode.js), so the two agree on the format.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../bridge/vision');
const D = require('../bridge/decode');

// A synthetic frame: px(x, y) from an RGB buffer, like decode.readImage returns.
function image(width, height, fill) {
  const rgb = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const [r, g, b] = fill(x, y);
    const o = (y * width + x) * 3;
    rgb[o] = r; rgb[o + 1] = g; rgb[o + 2] = b;
  }
  return { width, height, px: (x, y) => { const o = (y * width + x) * 3; return [rgb[o], rgb[o + 1], rgb[o + 2]]; } };
}

test('gameView crops the strip rows off the top and box-filters the rest down to maxWidth', () => {
  // 8x6: the top 2 rows are "strip" (white); below, 2x2 blocks of one colour each.
  const img = image(8, 6, (x, y) => (y < 2 ? [255, 255, 255] : [Math.floor(x / 2) * 60, Math.floor((y - 2) / 2) * 100, 7]));
  const v = V.gameView(img, { cropTop: 2, maxWidth: 4 });
  assert.equal(v.width, 4);
  assert.equal(v.height, 2);
  // Every output pixel is the mean of one uniform 2x2 block: exact values, no white.
  for (let Y = 0; Y < 2; Y++) for (let X = 0; X < 4; X++) {
    const o = (Y * 4 + X) * 3;
    assert.deepEqual([v.rgb[o], v.rgb[o + 1], v.rgb[o + 2]], [X * 60, Y * 100, 7], `pixel ${X},${Y}`);
  }
  // Averaging is real: a 2x2 block of two colours gives their mean.
  const mixed = image(2, 2, (x) => (x ? [200, 0, 0] : [0, 0, 100]));
  const m = V.gameView(mixed, { maxWidth: 1 });
  assert.deepEqual([m.width, m.height, m.rgb[0], m.rgb[1], m.rgb[2]], [1, 1, 100, 0, 50]);
});

test('gameView leaves a frame that is narrow enough alone, apart from the crop, and rounds the height with the width', () => {
  const img = image(100, 60, (x, y) => [x, y, 0]);
  const same = V.gameView(img, { cropTop: 10, maxWidth: 1280 });
  assert.deepEqual([same.width, same.height], [100, 50]);
  assert.deepEqual([same.rgb[0], same.rgb[1]], [0, 10], 'the first row is the one just under the crop');
  const half = V.gameView(img, { cropTop: 0, maxWidth: 50 });
  assert.deepEqual([half.width, half.height], [50, 30]);
  const big = V.gameView(image(1920, 1080, () => [1, 2, 3]), { cropTop: 12, maxWidth: 1280 });
  assert.deepEqual([big.width, big.height], [1280, 712]);
  assert.throws(() => V.gameView({ width: 0, height: 0, px: () => [0, 0, 0] }, {}), /nothing left/);
});

test('encodePNG writes an RGB PNG the bridge decoder reads back pixel for pixel', () => {
  const img = image(37, 23, (x, y) => [(x * 7) & 255, (y * 11) & 255, (x * y) & 255]);
  const view = V.gameView(img, { maxWidth: 1000 });
  const png = V.encodePNG(view);
  assert.ok(D.isPNG(png));
  assert.deepEqual(V.pngSize(png), { width: 37, height: 23 });
  const back = D.readPNG(png);
  for (let y = 0; y < 23; y++) for (let x = 0; x < 37; x++) assert.deepEqual(back.px(x, y), img.px(x, y), `pixel ${x},${y}`);
  assert.throws(() => V.encodePNG({ width: 2, height: 2, rgb: Buffer.alloc(3) }), /does not match/);
  assert.equal(V.pngSize(Buffer.from('not a png')), null);
});

test('vision file names carry the job id and are told apart from the prompt files next to them', () => {
  const name = V.fileName(42);
  assert.match(name, /^vision-42-[0-9a-z]+\.png$/);
  assert.ok(V.isVisionFile(name));
  assert.ok(!V.isVisionFile('prompt-42-abc.txt'));
  assert.ok(!V.isVisionFile('vision-42-abc.txt'));
  assert.deepEqual(V.DEFAULTS, { maxWidth: 1280, keep: 6 });
});
