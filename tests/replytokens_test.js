'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const GD = require('../bridge/gamedata');
const RT = require('../bridge/replytokens');

const DATA = path.join(__dirname, 'fixtures', 'wowdata');
const forever = () => GD.openStore({ dataDir: DATA, clientBuild: '1.60.1.70124' });
const LINKED_MESSAGE = 'is this good [Thunderfury]\n\n--- Linked from the game ---\n[Thunderfury] item 19019 (Legendary)\n  Binds when picked up\n[Frostbolt] spell 116\n[The Fallen Hero] quest 176';

test('linkedIds reads item, spell and quest IDs only from the Linked from the game block', () => {
  const ids = RT.linkedIds(['no links here [item 5]', LINKED_MESSAGE, null]);
  assert.deepEqual([...ids].sort(), ['item:19019', 'quest:176', 'spell:116']);
  assert.equal(RT.linkedIds(['[Fake] item 77 without the block']).size, 0, 'a line outside the block is not a link');
});

test('checkReply shows a spell token only when the player linked it in the chat; everything else keeps its token', () => {
  const store = forever();
  assert.equal(store.rowTrust, GD.TRUST.clientData);
  const linked = RT.linkedIds([LINKED_MESSAGE]);
  const r = RT.checkReply('cast {spell:116} then {Spell:12294}, buy {item:501} or {item:999}, do {quest:9}, see {npc:3}', { store, linked });
  assert.equal(r.text, 'cast {spell:116} then spell 12294 (unverified), buy {item:501} or {item:999}, do {quest:9}, see {npc:3}');
  assert.deepEqual(r.unverified, ['spell:12294']);
  assert.deepEqual(r.unknown, ['item:999 (not in the forever 1.60.1.200 data)', 'quest:9 (the forever 1.60.1.200 data has no quests table)']);
});

test('checkReply leaves fenced code untouched and matches IDs of any length like the addon', () => {
  const r = RT.checkReply('use {spell:5}\n```lua\nprint("{spell:5}")\n```\nand {spell:12345678901}\n```\n{spell:6}', { linked: new Set() });
  assert.equal(r.text, 'use spell 5 (unverified)\n```lua\nprint("{spell:5}")\n```\nand spell 12345678901 (unverified)\n```\n{spell:6}');
  assert.deepEqual(r.unverified, ['spell:5', 'spell:12345678901']);
});

test('without client data the item and quest tokens are not judged', () => {
  for (const store of [null, GD.openStore({ dataDir: DATA, clientBuild: '1.15.9.70003' }), GD.openStore({ dataDir: DATA, flavor: 'forever', clientBuild: '1.60.2.1' })]) {
    const r = RT.checkReply('{item:999} {quest:9}', { store });
    assert.equal(r.text, '{item:999} {quest:9}');
    assert.deepEqual(r.unknown, []);
  }
});

test('logLines says what was rewritten and what the client will gray, and stops at ten', () => {
  assert.deepEqual(RT.logLines({ unverified: [], unknown: [] }), []);
  const lines = RT.logLines({ unverified: Array.from({ length: 12 }, (_, k) => `spell:${k + 1}`), unknown: ['item:9 (x)'] });
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^reply tokens: 12 spell token\(s\) not linked in this chat, shown as plain text: spell:1, .*spell:10, \.\.\.$/);
  assert.equal(lines[1], 'reply tokens: 1 ID(s) the client will show gray: item:9 (x)');
});
