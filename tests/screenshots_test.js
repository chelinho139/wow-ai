// The screenshot transport's folder side (bridge/screenshots.js): where the
// game's Screenshots folder is, which files are the client's screenshots, and
// the watcher's rules: files present before it started are never reported, a
// new file is reported once, after its size stopped changing.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../bridge/screenshots');

test('the Screenshots folder is the client root next to Interface/AddOns, or an explicit override', () => {
  const client = path.join(os.tmpdir(), 'World of Warcraft', '_classic_beta_');
  const addonDir = path.join(client, 'Interface', 'AddOns');
  assert.equal(S.screenshotDir({ addonDir }), path.join(client, 'Screenshots'));
  assert.equal(S.screenshotDir({ addonDir: addonDir + path.sep }), path.join(client, 'Screenshots'), 'a trailing separator does not matter');
  assert.equal(S.screenshotDir({ addonDir, capture: { screenshotDir: path.join(os.tmpdir(), 'shots') } }), path.join(os.tmpdir(), 'shots'));
  assert.equal(S.screenshotDir({}), '', 'no addonDir, no folder');
});

test('only the client\'s own screenshot names in PNG or TGA count', () => {
  assert.ok(S.isScreenshotFile('WoWScrnShot_092826_103651.png'));
  assert.ok(S.isScreenshotFile('WoWScrnShot_092826_103651.tga'));
  assert.ok(S.isScreenshotFile('WoWScrnShot_092826_103651.PNG'));
  assert.ok(!S.isScreenshotFile('WoWScrnShot_092826_103335.jpg'), 'jpeg is lossy: the addon never asks for it');
  assert.ok(!S.isScreenshotFile('WoWScrnShot_092826_103651.png.tmp'));
  assert.ok(!S.isScreenshotFile('probe.png'));
  assert.ok(!S.isScreenshotFile(''));
});

test('the watcher reports a new file once its size settles, and never the files that were already there', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wowai-shots-'));
  fs.writeFileSync(path.join(dir, 'WoWScrnShot_010126_000000.png'), 'old');
  const got = [];
  const w = S.watchScreenshots(dir, f => got.push(path.basename(f)), { settleMs: 20, scanMs: 40 });
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  try {
    await sleep(120);
    assert.deepEqual(got, [], 'a file from before the bridge started is the player\'s');
    // Written in pieces, like a big TGA: reported once, after the last piece.
    const name = 'WoWScrnShot_010126_000001.tga';
    const fd = fs.openSync(path.join(dir, name), 'w');
    fs.writeSync(fd, Buffer.alloc(1000, 1));
    await sleep(15);
    fs.writeSync(fd, Buffer.alloc(1000, 2));
    await sleep(15);
    fs.writeSync(fd, Buffer.alloc(1000, 3));
    fs.closeSync(fd);
    await sleep(250);
    assert.deepEqual(got, [name]);
    assert.equal(fs.statSync(path.join(dir, name)).size, 3000, 'the watcher does not delete anything itself');
    // Other names are ignored even though they appeared after the start.
    fs.writeFileSync(path.join(dir, 'WoWScrnShot_010126_000002.jpg'), 'x');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
    await sleep(150);
    assert.deepEqual(got, [name]);
    // A second screenshot after the first was deleted (as the bridge does) is reported too.
    fs.unlinkSync(path.join(dir, name));
    await sleep(100);
    fs.writeFileSync(path.join(dir, 'WoWScrnShot_010126_000003.png'), Buffer.alloc(500));
    await sleep(250);
    assert.deepEqual(got, [name, 'WoWScrnShot_010126_000003.png']);
  } finally {
    w.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
