'use strict';
// The screenshot transport's inbox: the game's Screenshots folder. In
// capture.mode "screenshot" the addon calls Screenshot() with the strip on
// screen, the client writes WoWScrnShot_MMDDYY_HHMMSS.<png|tga> there, and the
// bridge decodes the file (decode.js) and deletes it. Files without a strip
// (the player's own screenshots) are left alone, always; strip-bearing files
// the watcher never saw (shot while the bridge was down) are swept by
// sweepOrphans at the bottom.

const fs = require('fs');
const path = require('path');

// <client>/Interface/AddOns -> <client>/Screenshots. The client root is the
// grandparent of the addon folder, whatever the client is called.
function screenshotDir(cfg) {
  const c = (cfg && cfg.capture) || {};
  if (c.screenshotDir) return path.resolve(c.screenshotDir);
  const addonDir = String((cfg && cfg.addonDir) || '').replace(/[\\/]+$/, '');
  if (!addonDir) return '';
  return path.join(path.dirname(path.dirname(addonDir)), 'Screenshots');
}

const SHOT_RE = /^WoWScrnShot_\d{6}_\d{6}\.(png|tga)$/i;
function isScreenshotFile(name) {
  return SHOT_RE.test(String(name || ''));
}

// Watch `dir` for new screenshot files; `onFile(fullPath)` is called once per
// file, once its size has been the same over two consecutive checks (the client
// writes big files in pieces). fs.watch gives the low latency; a slow scan
// backs it up where fs.watch misses events. Returns { close() }.
function watchScreenshots(dir, onFile, opts = {}) {
  const settleMs = opts.settleMs ?? 120;
  const scanMs = opts.scanMs ?? 1000;
  const log = opts.log || (() => {});
  const seen = new Map(); // name -> { size, stable, done }
  let closed = false;
  let watcher = null;
  let scanTimer = null;

  // Everything already there is the player's, or a leftover: never touched.
  try { for (const name of fs.readdirSync(dir)) seen.set(name, { done: true }); } catch {}

  function check(name) {
    if (closed || !isScreenshotFile(name)) return;
    const entry = seen.get(name) || { size: -1, stable: 0, done: false };
    if (entry.done) return;
    seen.set(name, entry);
    let st;
    try { st = fs.statSync(path.join(dir, name)); } catch { seen.delete(name); return; }
    if (st.size > 0 && st.size === entry.size) entry.stable++;
    else { entry.size = st.size; entry.stable = 0; }
    if (entry.stable >= 1) {
      entry.done = true;
      try { onFile(path.join(dir, name)); } catch (e) { log(`screenshot handler failed: ${e.message}`); }
      return;
    }
    setTimeout(() => check(name), settleMs);
  }

  function scan() {
    if (closed) return;
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const name of names) if (!seen.has(name)) check(name);
    // Forget files that went away, so a name reused later is looked at again.
    const present = new Set(names);
    for (const name of [...seen.keys()]) if (!present.has(name)) seen.delete(name);
  }

  try {
    watcher = fs.watch(dir, (event, name) => { if (name) check(String(name)); });
    watcher.on('error', (e) => log(`screenshot watch error: ${e.message}`));
  } catch (e) {
    log(`fs.watch unavailable on ${dir} (${e.message}); polling instead`);
  }
  scanTimer = setInterval(scan, scanMs);
  if (scanTimer.unref) scanTimer.unref();

  return {
    close() {
      closed = true;
      if (watcher) { try { watcher.close(); } catch {} }
      if (scanTimer) clearInterval(scanTimer);
    },
    // For tests: force a scan now.
    scan,
  };
}

// Leftovers. The addon shoots a strip per send and the bridge deletes the file
// once read, so a bridge that was down while the player kept sending (or died
// mid-way) leaves a full-screen file per message behind: ~8 MB each as TGA.
// sweepOrphans(dir, hasStrip) deletes the client-named files whose pixels hold
// the addon's strip (hasStrip(buffer) -> boolean; decode.js behind it in the
// bridge) and nothing else. Only the addon draws the strip's magic header and
// checksum in a screenshot, so a file with one is the addon's whoever started
// first, and a file without one is the player's and stays, always.
//
// Files younger than minAgeMs are left for the watcher (still being written, or
// about to be read and submitted); a verdict is remembered per name, size and
// mtime in `memo` (a Map the caller keeps between sweeps), so a player's
// screenshot is decoded once, not on every sweep; and at most maxDecodes files
// are decoded per sweep, so a big pile is taken down over a few sweeps instead
// of stalling the bridge. An unreadable file counts as not ours.
// Returns { removed: [names], kept, bytes, more }.
function sweepOrphans(dir, hasStrip, opts = {}) {
  const minAgeMs = opts.minAgeMs ?? 60000;
  const maxDecodes = opts.maxDecodes ?? 40;
  const memo = opts.memo || new Map();
  const log = opts.log || (() => {});
  const now = opts.now || Date.now();
  const out = { removed: [], kept: 0, bytes: 0, more: false };
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return out; }
  const present = new Set(names);
  for (const name of [...memo.keys()]) if (!present.has(name)) memo.delete(name);
  let decodes = 0;
  for (const name of names) {
    if (!isScreenshotFile(name)) continue;
    const file = path.join(dir, name);
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    if (!st.isFile() || st.size === 0 || now - st.mtimeMs < minAgeMs) continue;
    const key = st.size + ':' + st.mtimeMs;
    let m = memo.get(name);
    if (!m || m.key !== key) {
      if (decodes >= maxDecodes) { out.more = true; continue; }
      decodes++;
      let ours = false;
      try { ours = !!hasStrip(fs.readFileSync(file)); } catch (e) { log(`screenshot sweep: ${name} unreadable (${e.message}); left alone`); }
      m = { key, ours };
      memo.set(name, m);
    }
    if (!m.ours) { out.kept++; continue; }
    try { fs.unlinkSync(file); } catch (e) { log(`screenshot sweep: could not delete ${name} (${e.message})`); continue; }
    memo.delete(name);
    out.removed.push(name);
    out.bytes += st.size;
  }
  return out;
}

module.exports = { screenshotDir, isScreenshotFile, watchScreenshots, sweepOrphans };
