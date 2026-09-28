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

test('capture_scale reports the Retina case the decoder cannot read', { skip }, () => {
  assert.strictEqual(pyEval('m.capture_scale(1000, 400, 1000, 400)'), 1.0);
  assert.strictEqual(pyEval('m.capture_scale(1000, 400, 2000, 800)'), 2.0);
  // A window clamped at a screen edge must not read as a scale change.
  assert.strictEqual(pyEval('m.capture_scale(0, 0, 100, 100)'), 1.0);
});
