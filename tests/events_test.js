'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const EV = require('../bridge/events');
const TL = require('../bridge/telemetry');

const SUPERVISOR = path.join(__dirname, '..', 'bridge', 'supervisor.js');

function clock(start = 1790000000000) {
  let t = start;
  const now = () => t;
  now.advance = ms => { t += ms; };
  return now;
}

function sink() {
  const chunks = [];
  return { write: s => { chunks.push(s); return true; }, chunks, lines: () => chunks.join('').split('\n').filter(Boolean).map(l => JSON.parse(l)) };
}

function ev(type, importance, data = {}) {
  return { at: '2026-10-01T00:00:00.000Z', ms: 1, character: 'Bone-Forever', type, importance, data };
}

function tmpGoals(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `claude-wow-events-${label}-`));
}

function appendEvents(file, events) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, events.map(e => JSON.stringify(e)).join('\n') + '\n');
}

test('a 10 s burst is merged per event kind and printed together: first from, last to, summed delta, highest importance', () => {
  const now = clock();
  const c = EV.createCoalescer({ now });
  c.push(ev('money', 1, { from: 100, to: 150, delta: 50 }));
  now.advance(3000);
  c.push(ev('money', 1, { from: 150, to: 175, delta: 25 }));
  c.push(ev('item', 1, { id: 2589, from: 9, to: 10 }));
  c.push(ev('item', 2, { id: 2589, from: 10, to: 12, threshold: 25 }));
  c.push(ev('item', 1, { id: 2592, from: 0, to: 1 }));
  now.advance(6999);
  assert.equal(c.flush(), null, 'the burst window is still open');
  now.advance(1);
  const out = c.flush();
  assert.deepEqual(out.events.map(e => [e.type, e.data.id || null, e.importance, e.count]), [['money', null, 1, 2], ['item', 2589, 2, 2], ['item', 2592, 1, 1]]);
  assert.deepEqual(out.events[0].data, { from: 100, to: 175, delta: 75 });
  assert.deepEqual(out.events[1].data, { id: 2589, from: 9, to: 12, threshold: 25 });
  assert.equal(c.flush(), null, 'nothing left');
});

test('the coalescer enforces 40 wakes an hour itself: later bursts wait, merged, until the hour frees a wake', () => {
  const now = clock();
  const c = EV.createCoalescer({ now });
  for (let i = 0; i < EV.WAKES_PER_HOUR; i++) {
    c.push(ev('death', 3, { at: i }));
    now.advance(EV.BURST_WINDOW_MS);
    assert.ok(c.flush().events, `burst ${i + 1} prints`);
  }
  c.push(ev('death', 3, { at: 41 }));
  c.push(ev('level_up', 3, { from: 20, to: 21 }));
  now.advance(EV.BURST_WINDOW_MS);
  const held = c.flush();
  assert.equal(held.events, undefined, 'wake 41 is held');
  assert.equal(held.held, 2);
  c.push(ev('death', 3, { at: 42 }));
  now.advance(EV.HOUR_MS - EV.WAKES_PER_HOUR * EV.BURST_WINDOW_MS - 1);
  assert.equal(c.flush().events, undefined, 'still inside the hour of the first wake');
  now.advance(1);
  const late = c.flush();
  assert.deepEqual(late.events.map(e => [e.type, e.count]), [['death', 2], ['level_up', 1]]);
  assert.equal(c.wakes(), EV.WAKES_PER_HOUR);
});

test('follow prints appended events once per burst, filters by --min, survives a rotation, and starts at the end of the file', () => {
  const dir = tmpGoals('follow');
  const file = path.join(dir, 'Bone-Forever', TL.EVENTS_FILE);
  try {
    appendEvents(file, [ev('zone', 2, { from: 1, to: 2 })]);
    const now = clock();
    const out = sink();
    const err = sink();
    const f = EV.follow({ file, min: 2, out, err, now, pollMs: 0 });
    f.tick();
    now.advance(EV.BURST_WINDOW_MS);
    f.tick();
    assert.deepEqual(out.chunks, [], 'what was there before following is not replayed');
    appendEvents(file, [ev('money', 1, { from: 1, to: 2, delta: 1 }), ev('zone', 2, { from: 2, to: 3 }), ev('bags_full', 2, { free: 0 })]);
    f.tick();
    assert.deepEqual(out.chunks, [], 'the burst is open');
    now.advance(EV.BURST_WINDOW_MS);
    f.tick();
    assert.equal(out.chunks.length, 1, 'one write for the burst');
    assert.deepEqual(out.lines().map(e => e.type), ['zone', 'bags_full'], 'importance 1 is below --min 2');
    fs.renameSync(file, path.join(path.dirname(file), TL.EVENTS_ROTATED_FILE));
    appendEvents(file, [ev('death', 3, { at: 5 })]);
    f.tick();
    now.advance(EV.BURST_WINDOW_MS);
    f.tick();
    assert.deepEqual(out.lines().map(e => e.type), ['zone', 'bags_full', 'death'], 'read from the start of the new file');
    f.stop();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('follow waits for an events file to appear, picks the newest character folder, and reads a file that appeared later from its start', () => {
  const dir = tmpGoals('newest');
  try {
    const now = clock();
    const out = sink();
    const f = EV.follow({ file: () => EV.eventsFile(dir, ''), min: 1, out, err: sink(), now, pollMs: 0 });
    f.tick();
    assert.equal(f.file(), null);
    appendEvents(path.join(dir, 'Old-Realm', TL.EVENTS_FILE), [ev('money', 1)]);
    const past = new Date(Date.now() - 60000);
    fs.utimesSync(path.join(dir, 'Old-Realm', TL.EVENTS_FILE), past, past);
    appendEvents(path.join(dir, 'Bone-Forever', TL.EVENTS_FILE), [ev('zone', 2)]);
    f.tick();
    assert.equal(f.file(), path.join(dir, 'Bone-Forever', TL.EVENTS_FILE));
    now.advance(EV.BURST_WINDOW_MS);
    f.tick();
    assert.deepEqual(out.lines().map(e => e.type), ['zone']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('lines written just before a rotation are read from the rotated file before the new one', () => {
  const dir = tmpGoals('drain');
  const file = path.join(dir, 'Bone-Forever', TL.EVENTS_FILE);
  try {
    appendEvents(file, [ev('zone', 2, { from: 1, to: 2 })]);
    const now = clock();
    const out = sink();
    const f = EV.follow({ file, min: 1, out, err: sink(), now, pollMs: 0 });
    appendEvents(file, [ev('death', 3, { at: 1 }), ev('bags_full', 2, { free: 0 })]);
    fs.renameSync(file, path.join(path.dirname(file), TL.EVENTS_ROTATED_FILE));
    appendEvents(file, [ev('level_up', 3, { from: 20, to: 21 })]);
    f.tick();
    now.advance(EV.BURST_WINDOW_MS);
    f.tick();
    assert.deepEqual(out.lines().map(e => e.type), ['death', 'bags_full', 'level_up']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('without --character the newest events file is looked for again, and a character that starts writing later is followed from what is new', () => {
  const dir = tmpGoals('switch');
  try {
    const bone = path.join(dir, 'Bone-Forever', TL.EVENTS_FILE);
    const alt = path.join(dir, 'Alt-Forever', TL.EVENTS_FILE);
    appendEvents(alt, [ev('money', 1, { from: 0, to: 1, delta: 1 })]);
    const past = new Date(Date.now() - 60000);
    fs.utimesSync(alt, past, past);
    appendEvents(bone, [ev('zone', 2, { from: 1, to: 2 })]);
    const now = clock();
    const out = sink();
    const f = EV.follow({ file: () => EV.eventsFile(dir, ''), list: () => EV.allEventsFiles(dir), min: 1, out, err: sink(), now, pollMs: 0, resolveEvery: 2 });
    assert.equal(f.file(), bone);
    appendEvents(alt, [ev('death', 3, { at: 9 })]);
    f.tick();
    f.tick();
    assert.equal(f.file(), alt, 'the alt is newest now');
    now.advance(EV.BURST_WINDOW_MS);
    f.tick();
    assert.deepEqual(out.lines().map(e => e.type), ['death'], 'only what the alt wrote after following began');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the events command parses its options and refuses bad ones', () => {
  assert.deepEqual(EV.parseArgs(['--follow', '--min', '2']), { follow: true, min: 2, character: '' });
  assert.match(EV.USAGE, /goal_complete/, 'the usage names every importance-3 event');
  assert.equal(EV.parseArgs(['--min=3', '--character', 'Bone-Forever']).character, 'Bone-Forever');
  assert.match(EV.parseArgs(['--min', '4']).error, /--min takes 1 to 3/);
  assert.match(EV.parseArgs(['--min', 'x']).error, /--min/);
  assert.match(EV.parseArgs(['--character', '../etc']).error, /--character/);
  assert.match(EV.parseArgs(['--loud']).error, /unknown option --loud/);
});

test('claude-wow events without --follow prints the recent events at or above --min and exits', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-wow-events-cli-'));
  try {
    fs.writeFileSync(path.join(dir, 'config.json'), '{}');
    appendEvents(path.join(dir, 'goals', 'Bone-Forever', TL.EVENTS_FILE), [ev('money', 1), ev('level_up', 3, { from: 20, to: 21 })]);
    const r = spawnSync(process.execPath, [SUPERVISOR, 'events', '--min', '3'], { encoding: 'utf8', env: { ...process.env, CLAUDE_WOW_HOME: dir }, timeout: 20000 });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.stdout.trim().split('\n').map(l => JSON.parse(l).type), ['level_up']);
    const bad = spawnSync(process.execPath, [SUPERVISOR, 'events', '--min', '9'], { encoding: 'utf8', env: { ...process.env, CLAUDE_WOW_HOME: dir }, timeout: 20000 });
    assert.equal(bad.status, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
