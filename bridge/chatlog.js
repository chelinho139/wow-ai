'use strict';
const fs = require('fs');
const path = require('path');

const TAG = 'CWX1';
const MAGIC = [0xc7, 0x3a];
const STAMP = '^\\d+/\\d+ \\d\\d:\\d\\d:\\d\\d\\.\\d{3}  ';
const KEY = /^[0-9a-f]{16,64}$/;
const LINE = new RegExp(`${STAMP}${TAG} ([0-9a-f]{16,64}) (\\d+) (\\d+)/(\\d+) ([A-Za-z0-9+/=]+)\\s*$`);
const MAX_OPEN_FRAMES = 8;
const MAX_CHUNKS = 400;
const DEFAULTS = { enabled: false, line: 900, filler: 50000, show: false, clean: true, pollMs: 250 };

function options(raw) {
  const r = raw === true ? { enabled: true } : raw && typeof raw === 'object' ? raw : {};
  const int = (v, lo, hi, dflt) => (Number.isInteger(v) && v >= lo && v <= hi ? v : dflt);
  return {
    enabled: r.enabled === true,
    line: int(r.line, 60, 1000, DEFAULTS.line),
    filler: int(r.filler, 0, 65536, DEFAULTS.filler),
    show: r.show === true,
    clean: r.clean !== false,
    pollMs: int(r.pollMs, 50, 5000, DEFAULTS.pollMs),
  };
}

const WRITE_BUCKET = 1024;
const MIN_WRITE_SAMPLE = 2048;
const MAX_WRITE_SAMPLES = 30;
const MIN_CLUSTER = 3;
const SAME_SIZE_TOLERANCE = 0.05;
const MAX_FILLER = 65536;
const FILLER_STEP = 1000;

function noteWrite(samples, bytes) {
  if (!Number.isInteger(bytes) || bytes < MIN_WRITE_SAMPLE) return samples;
  return [...samples, bytes].slice(-MAX_WRITE_SAMPLES);
}

function writeClusters(samples) {
  const counts = new Map();
  for (const s of samples) counts.set(Math.floor(s / WRITE_BUCKET), (counts.get(Math.floor(s / WRITE_BUCKET)) || 0) + 1);
  const clusters = [];
  for (const [bucket, n] of counts) {
    const total = n + (counts.get(bucket + 1) || 0);
    if (total < MIN_CLUSTER) continue;
    const size = Math.min(...samples.filter(s => { const b = Math.floor(s / WRITE_BUCKET); return b === bucket || b === bucket + 1; }));
    clusters.push({ size, total });
  }
  return clusters;
}

function bufferSize(samples) {
  const clusters = writeClusters(samples);
  if (!clusters.length) return 0;
  let best = clusters.reduce((a, b) => (b.total > a.total || (b.total === a.total && b.size < a.size) ? b : a));
  for (const writesPerRead of [2, 3]) {
    const single = clusters.find(c => Math.abs(c.size * writesPerRead - best.size) / best.size < SAME_SIZE_TOLERANCE);
    if (single) { best = single; break; }
  }
  return best.size;
}

function calibratedFiller(samples, configured) {
  const size = bufferSize(samples);
  if (!size) return { filler: configured, size: 0, usable: true };
  const filler = Math.ceil(size / FILLER_STEP) * FILLER_STEP;
  return { filler: Math.min(filler, MAX_FILLER), size, usable: filler <= MAX_FILLER };
}

const PROBE_TAG = 'CWLOG\\d+';
const OUR_LINE = new RegExp(`${STAMP}(${TAG}|${PROBE_TAG}) `);
const CLEAN_MIN_IDLE_MS = 60000;

const STRIP_CHUNK_BYTES = 1 << 20;

function stripOurLines(file, chunkBytes = STRIP_CHUNK_BYTES) {
  const fd = fs.openSync(file, 'r+');
  try {
    const before = fs.fstatSync(fd).size;
    const chunk = Buffer.alloc(chunkBytes);
    let readAt = 0;
    let writeAt = 0;
    let removed = 0;
    let carry = '';
    const keep = (text) => {
      if (removed > 0 && text) fs.writeSync(fd, Buffer.from(text, 'latin1'), 0, text.length, writeAt);
      writeAt += text.length;
    };
    while (readAt < before) {
      const got = fs.readSync(fd, chunk, 0, Math.min(chunkBytes, before - readAt), readAt);
      if (got <= 0) break;
      readAt += got;
      const text = carry + chunk.toString('latin1', 0, got);
      const cut = text.lastIndexOf('\n');
      carry = cut < 0 ? text : text.slice(cut + 1);
      if (cut < 0) continue;
      const lines = text.slice(0, cut).split('\n');
      const kept = lines.filter(line => !OUR_LINE.test(line));
      removed += lines.length - kept.length;
      keep(kept.map(line => line + '\n').join(''));
    }
    if (OUR_LINE.test(carry)) removed++;
    else keep(carry);
    if (removed === 0) return { before, after: before, removed };
    if (fs.fstatSync(fd).size !== before) return { before, after: before, removed, grewMeanwhile: true };
    fs.ftruncateSync(fd, writeAt);
    return { before, after: writeAt, removed };
  } finally {
    fs.closeSync(fd);
  }
}

function clientFolder(cfg) {
  const addonDir = String((cfg && cfg.addonDir) || '').replace(/[\\/]+$/, '');
  return addonDir ? path.dirname(path.dirname(addonDir)) : '';
}

function clientRunning(folder, { platform = process.platform, listProcesses } = {}) {
  if (platform !== 'darwin' || !folder) return null;
  let commands;
  try {
    commands = listProcesses ? listProcesses() : require('child_process').execFileSync('ps', ['-axo', 'command='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  } catch {
    return null;
  }
  const prefix = folder.replace(/[\\/]+$/, '') + '/';
  return String(commands).split('\n').some(line => line.includes(prefix));
}

function cleanWhenClosed(file, folder, opts = {}) {
  const now = opts.now || Date.now();
  let st;
  try { st = fs.statSync(file); } catch { return { cleaned: false, why: 'no file' }; }
  if (now - st.mtimeMs < CLEAN_MIN_IDLE_MS) return { cleaned: false, why: 'written less than a minute ago' };
  const running = clientRunning(folder, opts);
  if (running !== false) return { cleaned: false, why: running === null ? 'cannot tell whether the game is running' : 'the game is running' };
  return Object.assign({ cleaned: true }, stripOurLines(file, opts.chunkBytes));
}

function chatLogFile(cfg) {
  const addonDir = String((cfg && cfg.addonDir) || '').replace(/[\\/]+$/, '');
  if (!addonDir) return '';
  return path.join(path.dirname(path.dirname(addonDir)), 'Logs', 'WoWChatLog.txt');
}

function parseLine(line, key) {
  const m = LINE.exec(line);
  if (!m || !KEY.test(String(key || '')) || m[1] !== key) return null;
  const seq = Number(m[3]);
  const total = Number(m[4]);
  if (seq < 1 || total < 1 || seq > total || total > MAX_CHUNKS) return null;
  return { id: Number(m[2]), seq, total, chunk: m[5] };
}

function decodeFrame(base64) {
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length < 8 || bytes[0] !== MAGIC[0] || bytes[1] !== MAGIC[1]) return { error: 'magic' };
  const len = bytes[4] * 256 + bytes[5];
  if (bytes.length !== 8 + len) return { error: 'length' };
  let s1 = 0;
  let s2 = 0;
  for (let i = 2; i < 6 + len; i++) {
    s1 = (s1 + bytes[i]) % 255;
    s2 = (s2 + s1) % 255;
  }
  if (bytes[6 + len] !== s1 || bytes[7 + len] !== s2) return { error: 'checksum' };
  return { id: bytes[2] * 256 + bytes[3], text: bytes.subarray(6, 6 + len).toString('utf8') };
}

function createAssembler(onFrame, { key } = {}) {
  const open = new Map();
  let carry = '';
  let insideLine = false;

  function take(part) {
    const key = `${part.id}/${part.total}`;
    if (part.seq === 1) open.delete(key);
    let frame = open.get(key);
    if (!frame) {
      frame = { chunks: new Array(part.total), have: 0 };
      open.set(key, frame);
      if (open.size > MAX_OPEN_FRAMES) open.delete(open.keys().next().value);
    }
    if (frame.chunks[part.seq - 1] === undefined) frame.have++;
    frame.chunks[part.seq - 1] = part.chunk;
    if (frame.have < part.total) return;
    open.delete(key);
    const decoded = decodeFrame(frame.chunks.join(''));
    onFrame(Object.assign({ lineId: part.id, chunks: part.total }, decoded));
  }

  function feed(text) {
    if (insideLine) {
      const lineEnd = text.indexOf('\n');
      if (lineEnd < 0) return;
      text = text.slice(lineEnd + 1);
      insideLine = false;
    }
    const all = carry + text;
    const cut = all.lastIndexOf('\n');
    if (cut < 0) { carry = all; return; }
    carry = all.slice(cut + 1);
    for (const line of all.slice(0, cut).split('\n')) {
      if (line.indexOf(TAG) < 0) continue;
      const part = parseLine(line.replace(/\r$/, ''), key);
      if (part) take(part);
    }
  }

  function reset({ midLine = false } = {}) {
    open.clear();
    carry = '';
    insideLine = midLine;
  }

  return { feed, reset };
}

function watchChatLog(file, onFrame, opts = {}) {
  const log = opts.log || (() => {});
  const pollMs = opts.pollMs || DEFAULTS.pollMs;
  const assembler = createAssembler(onFrame, { key: opts.key });
  let offset = -1;
  let missingTold = false;

  function midLineAt(position) {
    if (position <= 0) return false;
    try { return read(position - 1, position) !== '\n'; } catch { return true; }
  }

  function startAt(position) {
    offset = position;
    assembler.reset({ midLine: midLineAt(position) });
  }

  function sizeNow() {
    try { return fs.statSync(file).size; } catch { return -1; }
  }

  function read(from, to) {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(to - from);
      const got = fs.readSync(fd, buf, 0, buf.length, from);
      return buf.toString('latin1', 0, got);
    } finally {
      fs.closeSync(fd);
    }
  }

  function check() {
    const size = sizeNow();
    if (size < 0) {
      if (!missingTold) { missingTold = true; log(`chat log transport: ${file} does not exist yet (the client creates it when chat logging first writes)`); }
      if (offset > 0) { offset = 0; assembler.reset(); }
      if (offset < 0) offset = 0;
      return;
    }
    if (offset < 0) { startAt(size); return; }
    if (size < offset) startAt(0);
    if (size === offset) return;
    let text;
    try { text = read(offset, size); } catch (e) { log(`chat log transport: cannot read ${file} (${e.message})`); return; }
    offset += text.length;
    if (opts.onWrite) opts.onWrite(text.length);
    assembler.feed(text);
  }

  function resync() {
    startAt(Math.max(sizeNow(), 0));
  }

  check();
  const timer = setInterval(check, pollMs);
  if (timer.unref && opts.unref) timer.unref();
  return { close: () => clearInterval(timer), check, resync };
}

module.exports = { TAG, DEFAULTS, options, chatLogFile, parseLine, decodeFrame, createAssembler, watchChatLog, noteWrite, bufferSize, calibratedFiller, stripOurLines, clientFolder, clientRunning, cleanWhenClosed };
