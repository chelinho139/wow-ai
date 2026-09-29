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

test('a second screenshot with the same name, in the same second, is reported again', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wowai-shots-'));
  const name = 'WoWScrnShot_010126_000003.png';
  const got = [];
  const w = S.watchScreenshots(dir, f => { got.push(fs.readFileSync(f, 'utf8')); fs.unlinkSync(f); }, { settleMs: 20, scanMs: 40 });
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  try {
    fs.writeFileSync(path.join(dir, name), 'first');
    await sleep(200);
    fs.writeFileSync(path.join(dir, name), 'second');
    await sleep(200);
    assert.deepEqual(got, ['first', 'second']);
  } finally {
    w.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a file the handler left alone is reported again when the client overwrites it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wowai-shots-'));
  const name = 'WoWScrnShot_010126_000004.png';
  const got = [];
  const w = S.watchScreenshots(dir, f => got.push(fs.readFileSync(f, 'utf8')), { settleMs: 20, scanMs: 40 });
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  try {
    fs.writeFileSync(path.join(dir, name), 'player shot');
    await sleep(200);
    fs.writeFileSync(path.join(dir, name), 'a strip, longer');
    await sleep(200);
    assert.deepEqual(got, ['player shot', 'a strip, longer']);
  } finally {
    w.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

// The sweep: what a bridge that was down while the player kept sending finds
// in the folder. Only client-named files whose pixels hold a strip go (the
// predicate stands in for decode.js here: "strip" in the file is a strip),
// never a file without one, never a file too young for the watcher to have
// had its turn, never a name the client would not have written.
test('the sweep deletes leftover strip screenshots and nothing else, decodes each file once, and works in bounded batches', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wowai-sweep-'));
  const old = new Date(Date.now() - 3600 * 1000);
  const write = (name, body, when = old) => { fs.writeFileSync(path.join(dir, name), body); fs.utimesSync(path.join(dir, name), when, when); };
  const seen = [];
  const hasStrip = buf => { seen.push(buf.toString()); return buf.toString().includes('strip'); };
  try {
    write('WoWScrnShot_010126_000001.png', 'strip #1');       // the addon's, from a hello nobody read
    write('WoWScrnShot_010126_000002.tga', 'strip #2');       // the addon's, a retried message
    write('WoWScrnShot_010126_000003.png', 'a nice sunset');  // the player's
    write('WoWScrnShot_010126_000004.png', 'strip #4', new Date()); // just written: the watcher's, not the sweep's
    write('WoWScrnShot_010126_000005.jpg', 'strip #5');       // not a format the addon asks for: never opened
    write('holiday.png', 'strip in a file the client did not name'); // never opened either
    write('WoWScrnShot_010126_000006.png', '');               // empty: left for the watcher (still being written)
    const memo = new Map();
    const r = S.sweepOrphans(dir, hasStrip, { memo, minAgeMs: 60000 });
    assert.deepEqual(r.removed, ['WoWScrnShot_010126_000001.png', 'WoWScrnShot_010126_000002.tga']);
    assert.equal(r.kept, 1, 'the sunset');
    assert.equal(r.bytes, 16);
    assert.equal(r.more, false);
    assert.deepEqual(seen.sort(), ['a nice sunset', 'strip #1', 'strip #2'], 'only client-named, settled, non-empty files are ever opened');
    assert.deepEqual(fs.readdirSync(dir).sort(), ['WoWScrnShot_010126_000003.png', 'WoWScrnShot_010126_000004.png', 'WoWScrnShot_010126_000005.jpg', 'WoWScrnShot_010126_000006.png', 'holiday.png']);
    // The next sweep does not decode the sunset again; a rewritten file is looked at afresh.
    seen.length = 0;
    assert.deepEqual(S.sweepOrphans(dir, hasStrip, { memo, minAgeMs: 60000 }).removed, []);
    assert.deepEqual(seen, [], 'remembered as the player\'s');
    write('WoWScrnShot_010126_000003.png', 'strip now'); // same name, new content and mtime
    assert.deepEqual(S.sweepOrphans(dir, hasStrip, { memo, minAgeMs: 60000 }).removed, ['WoWScrnShot_010126_000003.png']);
    // An unreadable file is never ours; a predicate that throws deletes nothing.
    write('WoWScrnShot_010126_000007.png', 'strip #7');
    const r2 = S.sweepOrphans(dir, () => { throw new Error('truncated'); }, { memo: new Map(), minAgeMs: 60000 });
    assert.deepEqual(r2.removed, []);
    assert.ok(fs.existsSync(path.join(dir, 'WoWScrnShot_010126_000007.png')));
    // A pile is taken down a batch at a time, so the bridge never stalls on it.
    for (let i = 10; i < 20; i++) write(`WoWScrnShot_010126_0000${i}.png`, `strip #${i}`);
    const batch = S.sweepOrphans(dir, hasStrip, { memo: new Map(), minAgeMs: 60000, maxDecodes: 4 });
    assert.equal(batch.removed.length, 4);
    assert.equal(batch.more, true);
    const rest = S.sweepOrphans(dir, hasStrip, { memo: new Map(), minAgeMs: 60000, maxDecodes: 100 });
    assert.equal(rest.removed.length, 7, 'the other six of the pile plus #7');
    assert.equal(rest.more, false);
    // A folder that is not there is not an error.
    assert.deepEqual(S.sweepOrphans(path.join(dir, 'nope'), hasStrip).removed, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
