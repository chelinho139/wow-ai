// The macOS capture script's setup contract: `--check` must always answer in JSON
// lines, and a failure must be classified rather than passed through raw. Runs on
// every platform (that is the point: off macOS the tools are missing and the
// script still has to degrade gracefully instead of throwing a traceback).
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('node:child_process');
const path = require('node:path');

const MAC = path.join(__dirname, '..', 'bridge', 'capture_mac.py');
const PY = 'python3';
let skip = false;
try { execFileSync(PY, ['--version'], { stdio: 'ignore' }); }
catch { skip = 'python3 is not installed'; }

// Ask the module itself, so the strings the bridge relies on are the ones tested.
function pyEval(expr) {
  const src = `import json, importlib.util as u
s = u.spec_from_file_location("cm", ${JSON.stringify(MAC)})
m = u.module_from_spec(s); s.loader.exec_module(m)
print(json.dumps(${expr}))`;
  const r = spawnSync(PY, ['-c', src], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `python failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

test('--check answers in JSON lines and never throws', { skip }, () => {
  const r = spawnSync(PY, [MAC, '--check'], { encoding: 'utf8' });
  assert.strictEqual(r.stderr.trim(), '', 'a traceback would mean an unhandled failure');
  const rows = String(r.stdout).trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.ok(rows.length >= 1, 'at least the screen-recording verdict');
  for (const row of rows) {
    assert.ok(typeof row.check === 'string' && row.check, 'every row names the check');
    assert.strictEqual(typeof row.ok, 'boolean');
    if (!row.ok) assert.ok(row.hint, `a failed check must carry a hint: ${JSON.stringify(row)}`);
  }
  assert.ok(rows.some(r2 => r2.check === 'screen-recording'), 'screen recording is always checked');
  // Exit code mirrors the verdicts, so setup.js and a human both get the answer.
  assert.strictEqual(r.status === 0, rows.every(r2 => r2.ok));
});

test('a denied Screen Recording permission is named, not passed through raw', { skip }, () => {
  // The exact string macOS prints when the permission is missing.
  const hint = pyEval('m.classify_capture_error("could not create image from rect")');
  assert.match(hint, /Screen Recording/);
  assert.match(hint, /System Settings/);
  for (const other of ['not authorized', 'Screen Recording is off', 'operation not permitted']) {
    assert.ok(pyEval(`m.classify_capture_error(${JSON.stringify(other)})`), `should classify: ${other}`);
  }
  // Anything we do not recognize gets no invented explanation.
  assert.strictEqual(pyEval('m.classify_capture_error("disk full")'), '');
});

test('window-access failures point at the pane that actually fixes them', { skip }, () => {
  // Two different permissions block System Events, with two different errors; sending
  // the user to the wrong Settings pane is worse than saying nothing.
  const automation = pyEval('m.classify_window_error("osascript is not authorized to send Apple events (-1743)")');
  assert.match(automation, /Automation/);
  assert.doesNotMatch(automation, /Accessibility/);
  const assistive = pyEval('m.classify_window_error("System Events got an error: osascript is not allowed assistive access. (-1719)")');
  assert.match(assistive, /Accessibility/);
  assert.doesNotMatch(assistive, /Automation/);
  assert.strictEqual(pyEval('m.classify_window_error("some other applescript problem")'), '');
  // Screen Recording and window access must never be confused for each other.
  assert.doesNotMatch(pyEval('m.classify_capture_error("could not create image from rect")'), /Automation|Accessibility/);
});

test('the captured region is the strip plus its search margins, not a fixed 1000x400', { skip }, () => {
  // 200 cells x 4 px + 8 px of x slack, 48 rows x 4 px + the 80 px y slack: every extra
  // pixel is captured, copied and thrown away on every frame.
  assert.deepStrictEqual(pyEval('[m.args.region_w, m.args.region_h]'), [808, 272]);
  assert.deepStrictEqual(pyEval('[m.W + m.XSLACK, m.H + m.YSLACK]'), [808, 272]);
});

test('--check names the backend and the forced fallback still answers well-formed rows', { skip }, () => {
  // Off macOS the native backend must fail to load without a traceback and the
  // screencapture path must be what --check reports; on macOS --backend screencapture
  // forces that same fallback. Either way this is the automatic-fallback path.
  const r = spawnSync(PY, [MAC, '--check', '--backend', 'screencapture'], { encoding: 'utf8' });
  assert.strictEqual(r.stderr.trim(), '', 'a traceback would mean an unhandled failure');
  const rows = String(r.stdout).trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  const backend = rows.find(r2 => r2.check === 'backend');
  assert.ok(backend, 'the backend row is always there');
  assert.strictEqual(backend.ok, true, 'the slow path is not a failure');
  assert.strictEqual(backend.backend, 'screencapture');
  assert.ok(backend.detail, 'says why this backend was chosen');
  // The loader itself: never a native backend off macOS, with a stated reason; on
  // macOS whichever it picks must be one of the two names bridge users will read.
  if (process.platform !== 'darwin') {
    assert.strictEqual(pyEval('m.native_backend()'), null);
    assert.match(pyEval('m.native_reason()'), /CoreGraphics unavailable/);
    assert.strictEqual(pyEval('m.backend_name()[0]'), 'screencapture');
  } else {
    assert.ok(['native', 'screencapture'].includes(pyEval('m.backend_name()[0]')));
  }
});

test('capture_frame on the fallback path raises a classified CaptureError, never a traceback', { skip }, () => {
  // Force screencapture: off macOS the binary is missing, on a CI Mac it is denied
  // Screen Recording, on a real Mac it works. All three must come back through
  // CaptureError (or a frame), which is what the main loop knows how to report.
  const src = `import json, sys, importlib.util as u
sys.argv = ["x", "--backend", "screencapture"]
s = u.spec_from_file_location("cm", ${JSON.stringify(MAC)})
m = u.module_from_spec(s); s.loader.exec_module(m)
try:
    px, w, h = m.capture_frame(0, 0, 8, 8)
    print(json.dumps({"frame": [w, h], "px": list(px(0, 0))}))
except m.CaptureError as e:
    print(json.dumps({"detail": e.detail, "hint": e.hint}))`;
  const r = spawnSync(PY, ['-c', src], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `python failed: ${r.stderr}`);
  assert.strictEqual(r.stderr.trim(), '');
  const out = JSON.parse(r.stdout);
  if (out.frame) {
    assert.ok(out.frame[0] >= 8 && out.frame[1] >= 8, 'at least the asked-for size (Retina gives more)');
    assert.strictEqual(out.px.length, 3);
  } else {
    assert.ok(out.detail, 'a failure carries its detail');
    if (process.platform !== 'darwin') assert.match(out.detail, /cannot run screencapture/);
  }
});

// The fallback writes BMP (raw pixels) so nothing has to be inflated or un-filtered
// per frame; the reader must take both row orders and both depths.
function bmp({ width, height, bpp, topDown, bitfields, pixel }) {
  const bytesPP = bpp / 8;
  const stride = (width * bytesPP + 3) & ~3;
  const hdrSize = bitfields ? 108 : 40;
  const offset = 14 + hdrSize;
  const buf = Buffer.alloc(offset + stride * height);
  buf.write('BM', 0, 'ascii');
  buf.writeUInt32LE(buf.length, 2);
  buf.writeUInt32LE(offset, 10);
  buf.writeUInt32LE(hdrSize, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(topDown ? -height : height, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(bpp, 28);
  buf.writeUInt32LE(bitfields ? 3 : 0, 30);
  if (bitfields) { buf.writeUInt32LE(0x00FF0000, 54); buf.writeUInt32LE(0x0000FF00, 58); buf.writeUInt32LE(0x000000FF, 62); }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const [r, g, b] = pixel(x, y);
    const row = topDown ? y : height - 1 - y;
    const o = offset + row * stride + x * bytesPP;
    buf[o] = b; buf[o + 1] = g; buf[o + 2] = r; if (bytesPP === 4) buf[o + 3] = 255;
  }
  return buf;
}

test('read_bmp reads what screencapture -t bmp writes, and the plain bottom-up kind', { skip }, () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wowai-bmp-'));
  const pixel = (x, y) => [x * 40, y * 60, (x + y) * 10];   // distinct per channel and position
  const variants = [
    ['v4-32-topdown', { width: 5, height: 3, bpp: 32, topDown: true, bitfields: true, pixel }],   // screencapture
    ['v3-24-bottomup', { width: 5, height: 3, bpp: 24, topDown: false, bitfields: false, pixel }], // width 5 x 3 bytes = 15 -> padded rows
  ];
  for (const [name, spec] of variants) {
    const file = path.join(dir, name + '.bmp');
    fs.writeFileSync(file, bmp(spec));
    const got = pyEval(`[list(m.read_bmp(${JSON.stringify(file)})[1:])] + [list(m.read_bmp(${JSON.stringify(file)})[0](x, y)) for y in range(3) for x in range(5)]`);
    assert.deepStrictEqual(got[0], [5, 3], name);
    let i = 1;
    for (let y = 0; y < 3; y++) for (let x = 0; x < 5; x++) assert.deepStrictEqual(got[i++], pixel(x, y), `${name} at ${x},${y}`);
    // --test-image takes a BMP too, sniffed by magic rather than extension.
    const r = spawnSync(PY, [MAC, '--test-image', file], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.deepStrictEqual(JSON.parse(r.stdout.trim()), { error: 'no valid strip in image' });
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the native backend maps every CoreGraphics pixel layout it accepts, and refuses the rest', { skip }, () => {
  // bitmapInfo = byte order | alpha info. Wrong offsets here would decode garbage
  // silently, so the mapping is pinned: BGRA is what macOS actually hands out.
  const offs = (bpp, info) => pyEval(`m.NativeCapture.channel_offsets(${bpp}, ${info})`);
  assert.deepStrictEqual(offs(32, 0x2000 | 2), [2, 1, 0], '32Little + PremultipliedFirst = BGRA in memory');
  assert.deepStrictEqual(offs(32, 0x2000 | 6), [2, 1, 0], '32Little + NoneSkipFirst = BGRx');
  assert.deepStrictEqual(offs(32, 2), [1, 2, 3], 'big-endian ARGB');
  assert.deepStrictEqual(offs(32, 1), [0, 1, 2], 'RGBA');
  assert.deepStrictEqual(offs(32, 0x2000 | 1), [3, 2, 1], '32Little + PremultipliedLast = ABGR');
  assert.deepStrictEqual(offs(24, 0), [0, 1, 2], 'packed RGB');
  assert.strictEqual(offs(64, 0x100 | 3), null, '16-bit float HDR is not guessed at');
  assert.strictEqual(offs(24, 0x2000), null);
});

test('capture_scale reports the Retina case the decoder cannot read', { skip }, () => {
  assert.strictEqual(pyEval('m.capture_scale(1000, 400, 1000, 400)'), 1.0);
  assert.strictEqual(pyEval('m.capture_scale(1000, 400, 2000, 800)'), 2.0);
  // A window clamped at a screen edge must not read as a scale change.
  assert.strictEqual(pyEval('m.capture_scale(0, 0, 100, 100)'), 1.0);
});
