'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const RT = require('../bridge/replytokens');

const LINKED_MESSAGE = 'is this good [Frostbolt]\n\n--- Linked from the game ---\n[Thunderfury] item 19019 (Legendary)\n  Binds when picked up\n[Frostbolt] spell 116\n[Enchant Bracer - Minor Health] enchant 7418\n[The Fallen Hero] quest 176';

test('linkedSpells reads spell and recipe (enchant) IDs only from the Linked from the game block', () => {
  assert.deepEqual([...RT.linkedSpells(['no links [spell 5]', LINKED_MESSAGE, null])].sort((a, b) => a - b), [116, 7418]);
  assert.equal(RT.linkedSpells(['[Fake] spell 77 without the block']).size, 0, 'a line outside the block is not a link');
});

test('checkReply keeps a spell token the player linked and shows any other one as plain text; items, quests and fences are left alone', () => {
  const linked = RT.linkedSpells([LINKED_MESSAGE]);
  const r = RT.checkReply('cast {spell:116}, {SPELL:0116} or {spell:7418}, not {spell:12294}; buy {item:999}, do {quest:9}\n```\n/cast {spell:5}\n```', linked);
  assert.equal(r.text, 'cast {spell:116}, {SPELL:0116} or {spell:7418}, not spell 12294 (unverified); buy {item:999}, do {quest:9}\n```\n/cast spell 5 (unverified)\n```');
  assert.deepEqual(r.unverified, ['12294', '5']);
  assert.deepEqual(RT.checkReply('{spell:116}').unverified, ['116'], 'nothing linked: nothing kept');
});

test('logLine names the rewritten spell tokens and stops at ten', () => {
  assert.equal(RT.logLine(['5']), 'reply tokens: 1 spell token(s) not linked in this chat, shown as plain text: spell:5');
  assert.match(RT.logLine(Array.from({ length: 12 }, (_, k) => String(k + 1))), /^reply tokens: 12 .*spell:10, \.\.\.$/);
});
