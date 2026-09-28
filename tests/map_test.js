// Map layers: validation, versioned application, reply blocks, and the Lua the
// slot files carry (executed in a real Lua VM).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');
const P = require('../bridge/protocol');

const pt = (x, y, extra = {}) => ({ m: 1429, x, y, label: `p${x}`, kind: 'ore', ...extra });

test('validateMapCommand sanitizes points, labels, kinds and layer names', () => {
  const why = [];
  const c = P.validateMapCommand({ op: 'set', layer: 'mining', title: 'A|cff00ff00b', points: [
    pt(10, 20, { label: 'x|Hitem:1|h\ny', kind: 'nonsense' }), { m: 'no', x: 1, y: 2 }, pt(150, -3),
  ] }, why);
  assert.equal(c.points.length, 2);
  assert.equal(c.points[0].kind, 'poi');
  assert.ok(!c.points[0].label.includes('|') && !c.points[0].label.includes('\n'));
  assert.deepEqual([c.points[1].x, c.points[1].y], [100, 0]);
  assert.ok(!c.title.includes('|'));
  assert.ok(why.some(w => /dropped invalid/.test(w)));
  assert.equal(P.validateMapCommand({ op: 'set', layer: 'bad name!', points: [pt(1, 1)] }), null);
  assert.equal(P.validateMapCommand({ op: 'set', layer: 'empty', points: [] }), null);
  assert.deepEqual(P.validateMapCommand({ op: 'clear', layer: 'mining' }), { op: 'clear', layer: 'mining' });
  assert.equal(P.validateMapCommand({ op: 'explode' }), null);
});

test('applyMapCommands bumps the version only on change and keeps the budget', () => {
  const map = P.newMap('e1');
  let r = P.applyMapCommands(map, [{ op: 'set', layer: 'a', points: [pt(1, 1)] }]);
  assert.ok(r.changed); assert.equal(map.version, 1);
  r = P.applyMapCommands(map, [{ op: 'clear', layer: 'nope' }]);
  assert.ok(!r.changed); assert.equal(map.version, 1);
  r = P.applyMapCommands(map, [{ op: 'set', layer: 'b', points: [pt(2, 2)] }, { op: 'clear', layer: 'a' }]);
  assert.equal(map.version, 2);
  assert.deepEqual(Object.keys(map.layers), ['b']);
  // Too many layers: the oldest go first.
  const many = [];
  for (let i = 0; i < P.MAP_LIMITS.layers + 3; i++) many.push({ op: 'set', layer: 'l' + i, points: [pt(i, i)] });
  P.applyMapCommands(map, many.map((c, i) => c), 0);
  assert.equal(Object.keys(map.layers).length, P.MAP_LIMITS.layers);
  // Too many points in total.
  const big = n => ({ op: 'set', layer: 'big' + n, points: Array.from({ length: 400 }, (_, i) => pt(i % 100, n)) });
  P.applyMapCommands(map, [big(1), big(2), big(3), big(4)]);
  const total = Object.values(map.layers).reduce((s, l) => s + l.points.length, 0);
  assert.ok(total <= P.MAP_LIMITS.totalPoints);
  r = P.applyMapCommands(map, [{ op: 'clearall' }]);
  assert.ok(r.changed); assert.equal(Object.keys(map.layers).length, 0);
});

test('extractMapBlocks takes objects, arrays and JSON lines out of the reply', () => {
  const text = 'Here is your route.\n\n```wowmap\n{"op":"set","layer":"a","points":[{"m":1429,"x":1,"y":2}]}\n```\n\nAnd more:\n```wowmap\n[{"op":"clear","layer":"b"}]\n```\n```wowmap\n{"op":"clearall"}\nnot json\n```\nBye.';
  const r = P.extractMapBlocks(text);
  assert.equal(r.cmds.length, 3);
  assert.equal(r.errors.length, 1);
  assert.ok(!r.text.includes('wowmap'));
  assert.ok(r.text.startsWith('Here is your route.') && r.text.endsWith('Bye.'));
  assert.deepEqual(P.extractMapBlocks('no blocks').cmds, []);
});

test('parseMapFile reads one command per line', () => {
  const r = P.parseMapFile('{"op":"clearall"}\n\n{"op":"clear","layer":"x"}\n{broken\n');
  assert.equal(r.cmds.length, 2);
  assert.equal(r.errors.length, 1);
});

function runLua(src, expr) {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  if (lauxlib.luaL_dostring(L, to_luastring(src + '\nRESULT = ' + expr)) !== 0) {
    throw new Error('Lua error: ' + to_jsstring(lua.lua_tostring(L, -1)));
  }
  lua.lua_getglobal(L, to_luastring('RESULT'));
  return to_jsstring(lua.lua_tostring(L, -1));
}

test('slot files carry the map as a Lua table the addon can read', () => {
  const map = P.newMap('ep0ch');
  P.applyMapCommands(map, [{ op: 'set', layer: 'quests', title: 'Route "one"', ordered: true, points: [
    pt(48.92, 41.61, { label: '1. accept "Wolves"\\ ok', kind: 'quest' }), pt(40.6, 82.3, { kind: 'explore' }),
  ] }]);
  const src = P.luaTable('ClaudeWoW_SlotData', [], { now: 1, cwd: '/x', map });
  const got = runLua(src, `(function(m) local l = m.layers[1]; local p = l.points[1]
    return table.concat({ m.epoch, m.version, l.name, l.title, tostring(l.ordered), #l.points, p[1], p[2], p[3], p[4], p[5], l.points[2][5] }, "|") end)(ClaudeWoW_SlotData.map)`);
  assert.equal(got, 'ep0ch|1|quests|Route "one"|true|2|1429|48.92|41.61|1. accept "Wolves"\\ ok|quest|explore');
  assert.ok(!P.luaTable('X', [], { now: 1 }).includes('map ='));
});
