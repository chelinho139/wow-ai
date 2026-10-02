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

test('checkTokens keeps tokens the data or a link backs and turns every other one into plain text', () => {
  const store = forever();
  assert.equal(store.rowTrust, GD.TRUST.clientData);
  const linked = RT.linkedIds([LINKED_MESSAGE]);
  const r = RT.checkTokens('take {item:501}, {ITEM:19019}, {spell:116} and {quest:176}; skip {item:999}, {spell:5} and {quest:9}. {npc:3} and {skill:1} stay', { store, linked });
  assert.equal(r.text, 'take {item:501}, {ITEM:19019}, {spell:116} and {quest:176}; skip item 999, spell 5 and quest 9. {npc:3} and {skill:1} stay');
  assert.deepEqual(r.dropped.map(d => `${d.kind}:${d.id}`), ['item:999', 'spell:5', 'quest:9']);
  assert.match(r.dropped[0].reason, /^not in the forever 1\.60\.1\.200 data$/);
  assert.match(r.dropped[2].reason, /has no quests table/);
});

test('without data for the client, only linked tokens stay', () => {
  const linked = RT.linkedIds([LINKED_MESSAGE]);
  for (const store of [null, GD.openStore({ dataDir: DATA, clientBuild: '1.15.9.70003' }), GD.openStore({ dataDir: DATA, flavor: 'forever', clientBuild: '1.60.2.1' })]) {
    const r = RT.checkTokens('{item:501} {item:19019}', { store, linked });
    assert.equal(r.text, 'item 501 {item:19019}');
    assert.equal(r.dropped[0].reason, 'no data for this client');
  }
});

test('dropsLine names each dropped token with its reason and stops at ten', () => {
  const dropped = Array.from({ length: 12 }, (_, k) => ({ kind: 'item', id: k + 1, reason: 'x' }));
  const line = RT.dropsLine(dropped);
  assert.match(line, /^reply tokens: 12 unlinked, item:1 \(x\), /);
  assert.ok(line.endsWith('item:10 (x), ...'));
});
