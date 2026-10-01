'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const R = require('../bridge/report');
const G = require('../bridge/goals');
const TL = require('../bridge/telemetry');

const KEY = 'Bone-ClassicBetaPvP2';
const DAY = '2026-10-01';
const NOON = new Date(2026, 9, 1, 12).getTime();
const YESTERDAY = new Date(2026, 8, 30, 23, 59).getTime();
const TOMORROW = new Date(2026, 9, 2, 0, 0).getTime();

function ev(ms, type, data, importance = 1) {
  return JSON.stringify({ at: new Date(ms).toISOString(), ms, character: KEY, type, importance, data });
}

function fixture(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-report-'));
  const folder = path.join(dir, KEY);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, TL.EVENTS_ROTATED_FILE), [
    ev(YESTERDAY, 'level_up', { from: 18, to: 19 }, 3),
    ev(NOON - 3000, 'money', { from: 100, to: 15100, delta: 15000 }),
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(folder, TL.EVENTS_FILE), [
    ev(NOON, 'level_up', { from: 19, to: 20 }, 3),
    ev(NOON + 1, 'money', { from: 15100, to: 15000, delta: -100 }),
    ev(NOON + 2, 'death', { at: 5, deaths: 1 }, 3),
    ev(NOON + 3, 'zone', { from: 1, to: 21 }, 2),
    ev(NOON + 4, 'skill', { id: 393, from: 180, to: 185, max: 225 }),
    ev(NOON + 5, 'skill', { id: 393, from: 185, to: 187, max: 225 }),
    ev(NOON + 6, 'recipe', { id: 9001, at: 5 }, 3),
    ev(NOON + 7, 'item', { id: 2318, from: 4, to: 30, target: 30, threshold: 100 }, 2),
    ev(NOON + 8, 'goal_complete', { id: 2318, count: 30, target: 30 }, 3),
    'not json',
    '{"type":"money"}',
    ev(TOMORROW, 'death', { at: 6, deaths: 2 }, 3),
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(folder, TL.SNAPSHOT_FILE), JSON.stringify({
    v: 1, character: KEY, session: 'abc', seq: 3, updatedAt: NOON, completed: {},
    sections: {
      skills: { seq: 3, hash: '0000000a', at: NOON, data: '393=187/225,165=107/150' },
      equip: { seq: 3, hash: '0000000b', at: NOON, data: '16=501' },
    },
  }));
  if (opts.goals !== false) {
    fs.writeFileSync(path.join(folder, G.GOALS_FILE), JSON.stringify({
      v: 1, rev: 4, character: KEY,
      goals: [
        { id: 'g_393', type: 'profession', target: { skillID: 393, rank: 225 }, title: 'Skinning 225' },
        { id: 'g_gearset', type: 'gearset', target: { slots: { 16: 501, 17: 501 } }, title: 'Gear set: 2 items' },
        { id: 'g_165', type: 'profession', target: { skillID: 165, rank: 150 }, title: 'Hand Undercity' },
      ],
      orders: {
        current: { id: 'o_4', text: 'Buy 2 Fixture Blade', refs: [{ kind: 'item', id: 501, name: 'Fixture Blade' }], issuedAt: NOON + 100 },
        history: [
          { id: 'o_3', text: 'Skin 30 more, then raise Skinning', issuedAt: NOON - 100, status: 'superseded' },
          { id: 'o_2', text: 'Go to Orgrimmar now', issuedAt: NOON - 50, status: 'superseded' },
          { id: 'o_1', text: 'Old day order', issuedAt: YESTERDAY, status: 'superseded' },
        ],
      },
    }));
  }
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function run(argv, dir, now = NOON) {
  let out = '';
  let err = '';
  const code = R.main(argv, { goalsDir: dir, out: { write: s => { out += s; } }, err: { write: s => { err += s; } }, now: () => now });
  return { code, out, err };
}

test('report: one local day of events from both event files, orders issued that day and goal progress from the snapshot', () => {
  const f = fixture();
  try {
    const r = run(['--day', DAY], f.dir);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, [
      `Day report for ${KEY}, ${DAY} (local time)`,
      'Level: 19 to 20',
      'Money: +1g 49s 0c over 2 changes',
      'Deaths: 1',
      'Zone changes: 1 (maps 21)',
      'Skill 393: 180 to 187',
      'Recipes learned: 1 (recipe 9001)',
      'Item 2318 in bags: 4 to 30',
      'Watched item 2318 reached its target of 30',
      'Orders issued: 3',
      '  Skin 30 more, then raise Skinning (superseded)',
      `  ${R.HIDDEN_TEXT} (superseded)`,
      '  Buy 2 Fixture Blade (current)',
      'Goals now:',
      '  Skinning 225: 83%',
      '  Gear set: 2 items: 50%',
      `  ${R.HIDDEN_TEXT}: 71%`,
      `Data: 10 events; snapshot updated ${new Date(NOON).toISOString()}`,
      '',
    ].join('\n'));
  } finally { f.cleanup(); }
});

test('report: every order text and goal title goes through the viewer text check; a typed game name never prints', () => {
  const f = fixture();
  try {
    const out = run(['--day', DAY], f.dir).out;
    assert.doesNotMatch(out, /Orgrimmar/);
    assert.doesNotMatch(out, /Undercity/);
    assert.match(out, /Buy 2 Fixture Blade/, 'a name the order stored as a checked ref is allowed');
  } finally { f.cleanup(); }
});

test('report: the default day is today, the default character the newest events folder, and a quiet day says so', () => {
  const f = fixture();
  try {
    assert.equal(run([], f.dir).out, run(['--day', DAY], f.dir).out);
    assert.equal(run(['--day'], f.dir).out, run(['--day', DAY], f.dir).out);
    const quiet = run(['--day', '2026-01-01'], f.dir);
    assert.match(quiet.out, /No game events this day\./);
    assert.match(quiet.out, /Data: 0 events/);
    assert.doesNotMatch(quiet.out, /Orders issued/);
  } finally { f.cleanup(); }
});

test('report: usage errors, no folder and an unreadable goal store', () => {
  const f = fixture({ goals: false });
  try {
    for (const argv of [['--day', '2026-02-30'], ['--day=yesterday'], ['--character', '../x'], ['--bogus']]) {
      const r = run(argv, f.dir);
      assert.equal(r.code, 2, argv.join(' '));
      assert.match(r.err, /^report: /);
    }
    assert.equal(run(['--character', 'Nobody'], f.dir).code, 1);
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-report-empty-'));
    try { assert.equal(run([], empty).code, 1); } finally { fs.rmSync(empty, { recursive: true, force: true }); }
    assert.doesNotMatch(run(['--day', DAY], f.dir).out, /Goals now|Orders issued/, 'no goals file: no goal lines');
    fs.writeFileSync(path.join(f.dir, KEY, G.GOALS_FILE), '{bad');
    assert.match(run(['--day', DAY], f.dir).out, /Goals: not read \(.*not valid JSON/);
  } finally { f.cleanup(); }
});

test('report: money formatting', () => {
  assert.equal(R.money(0), '+0c');
  assert.equal(R.money(-123456), '-12g 34s 56c');
  assert.equal(R.money(105), '+1s 5c');
});
