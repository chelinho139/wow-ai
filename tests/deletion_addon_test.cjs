'use strict';

// Reuse the real-Lua harness without changing the preserved upstream reference
// test. Appending these cases to the same evaluated module keeps its private VM
// helpers available while this fork owns the additional deletion contracts.
eval(require('node:fs').readFileSync(require('node:path').join(__dirname, 'addon_test.js'), 'utf8').split('\ntest(')[0] + String.raw`

test('deleting the last chat rotates its identity and removes its pending transports', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  const deleted = vm.evaluate('WoWAIDB.chats[1].id');
  vm.run('WoWAI.Send("old pending request")');
  assert.equal(vm.evaluate('WoWAIDB.outbox.chat'), deleted);
  assert.ok(stripRecords(vm).some(r => r.chat === deleted && r.text === 'old pending request'));

  vm.run('WoWAI.DeleteChat()');
  const replacement = vm.evaluate('WoWAIDB.chats[1].id');
  assert.notEqual(replacement, deleted, 'the cleared row is a new conversation identity');
  assert.equal(vm.evaluate('WoWAIDB.activeChat'), replacement);
  assert.equal(vm.evaluate('WoWAIDB.outbox'), null, 'reload fallback cannot resend deleted work');
  assert.equal(vm.evaluate('WoWAIDB.chats[1].pendingId'), null);
  assert.ok(stripRecords(vm).some(r => r.chat === deleted && r.flags === 'd'), 'the old identity is forgotten');
  assert.ok(!stripRecords(vm).some(r => r.chat === deleted && r.flags !== 'd'), 'old requests leave the strip');

  vm.run('WoWAI.Send("new conversation request")');
  const current = stripRecords(vm).find(r => r.text === 'new conversation request');
  assert.ok(current);
  assert.equal(current.chat, replacement, 'new work cannot be erased by the delayed old forget');
});

test('last-chat identity rotation survives a repeated random candidate', () => {
  const vm = newVM();
  login(vm);
  const deleted = vm.evaluate('WoWAIDB.chats[1].id');
  vm.run('math.random = function() return tonumber("' + deleted.slice(-4) + '", 16) end');
  vm.run('WoWAI.DeleteChat()');
  const replacement = vm.evaluate('WoWAIDB.chats[1].id');
  assert.notEqual(replacement, deleted);
  assert.match(replacement, /^[0-9a-zA-Z]+$/);
  assert.equal(vm.evaluate('WoWAIDB.activeChat'), replacement);
  assert.equal(vm.evaluate('WoWAIDB.forget["' + deleted + '"] ~= nil'), 'true');
});

test('bridge presence never acknowledges deletion without its exact signal', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  vm.run('WoWAI.NewChat("Delete me")');
  const deleted = vm.evaluate('WoWAIDB.chats[2].id');
  vm.run('WoWAI.DeleteChat()');
  const forget = stripRecords(vm).find(r => r.chat === deleted && r.flags === 'd');
  assert.ok(forget);

  // A later connection response proves only that the bridge is alive. It must
  // not claim that the separate deletion transaction reached durable completion.
  vm.run('WoWAI.Connect()');
  nextSlot(vm, '{ now = time(), cwd = "", replies = {} }');
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('WoWAIDB.forget["' + deleted + '"] ~= nil'), 'true');
  assert.ok(stripRecords(vm).some(r => r.chat === deleted && r.flags === 'd'));

  const slot = String(((forget.id - 1) % 200) + 1).padStart(3, '0');
  vm.run('STUB.sounds["Interface\\\\AddOns\\\\WoWAI\\\\ack\\\\' + slot + '.wav"] = true; STUB.Tick()');
  assert.equal(vm.evaluate('WoWAIDB.forget["' + deleted + '"]'), null);
  assert.ok(!stripRecords(vm).some(r => r.chat === deleted && r.flags === 'd'));
});


test('Rust deletion receipts work without sound and require the exact operation', () => {
  const vm = newVM();
  login(vm); connect(vm);
  vm.run('WoWAIDB.settings.signal = false; WoWAI.DeleteChat()');
  const gone = Object.values(stripRecords(vm)).find(r => r.flags === 'd');
  assert.ok(gone);
  const token = vm.evaluate('WoWAIDB.session');
  nextSlot(vm, '{ now = time(), bridgeOnline = true, replies = {}, deletionAcks = { { chat = "' + gone.chat + '", session = "' + token + '", id = ' + (gone.id + 1) + ' } } }');
  vm.run('WoWAI.Connect(); STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('WoWAIDB.forget["' + gone.chat + '"] ~= nil'), 'true', 'wrong operation cannot acknowledge deletion');
  const retry = stripRecords(vm).find(r => r.flags === 'd');
  assert.equal(retry.id, gone.id, 'reconnect retains durable operation identity');
  nextSlot(vm, '{ now = time(), bridgeOnline = true, replies = {}, deletionAcks = { { chat = "' + gone.chat + '", session = "wrong", id = ' + gone.id + ' } } }');
  vm.run('WoWAI.Connect(); STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('WoWAIDB.forget["' + gone.chat + '"] ~= nil'), 'true', 'wrong session cannot acknowledge deletion');
  nextSlot(vm, '{ now = time(), bridgeOnline = true, replies = {}, deletionAcks = { { chat = "' + gone.chat + '", session = "' + token + '", id = ' + gone.id + ' } } }');
  vm.run('WoWAI.Connect(); STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('WoWAIDB.forget["' + gone.chat + '"]'), null);
  assert.ok(!stripRecords(vm).some(r => r.flags === 'd'));
});


test('receipt-capable Rust ignores an old WAV acknowledgment', () => {
  const vm = newVM(); login(vm); connect(vm);
  vm.run('WoWAI.DeleteChat()');
  const gone = stripRecords(vm).find(r => r.flags === 'd');
  const token = vm.evaluate('WoWAIDB.session');
  nextSlot(vm, '{ now = time(), bridgeOnline = true, replies = {}, deletionAcks = {} }');
  vm.run('WoWAI.Connect(); STUB.now = STUB.now + 6; STUB.Tick()');
  const slot = String(((gone.id - 1) % 200) + 1).padStart(3, '0');
  vm.run('STUB.sounds["Interface\\\\AddOns\\\\WoWAI\\\\ack\\\\' + slot + '.wav"] = true; STUB.Tick()');
  assert.equal(vm.evaluate('WoWAIDB.forget["' + gone.chat + '"] ~= nil'), 'true');
  nextSlot(vm, '{ now = time(), bridgeOnline = true, replies = {}, deletionAcks = { { chat = "' + gone.chat + '", session = "' + token + '", id = ' + gone.id + ' } } }');
  vm.run('WoWAI.Connect(); STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('WoWAIDB.forget["' + gone.chat + '"]'), null);
});


test('an offline deletion cannot be acknowledged by a leftover WAV before handshake', () => {
  const vm = newVM(); login(vm);
  vm.run('WoWAI.DeleteChat()');
  const gone = stripRecords(vm).find(r => r.flags === 'd');
  const slot = String(((gone.id - 1) % 200) + 1).padStart(3, '0');
  vm.run('STUB.sounds["Interface\\\\AddOns\\\\WoWAI\\\\ack\\\\' + slot + '.wav"] = true; STUB.Tick()');
  assert.equal(vm.evaluate('WoWAIDB.forget["' + gone.chat + '"] ~= nil'), 'true');
});


test('new chats never reuse an acknowledged deleted identity', () => {
  const vm = newVM(); login(vm); connect(vm);
  const gone = vm.evaluate('WoWAIDB.chats[1].id');
  vm.run('WoWAI.DeleteChat()');
  // Receipt delivery may remove the retry queue; retirement must remain separate.
  vm.run('WoWAIDB.forget = {}; STUB.now = 0; math.random = function() return ' + parseInt(gone.slice(-4), 16) + ' end');
  vm.run('WoWAI.NewChat("fresh after delete")');
  assert.notEqual(vm.evaluate('WoWAIDB.chats[2].id'), gone);
  assert.equal(vm.evaluate('WoWAIDB.retiredChats["' + gone + '"]'), 'true');
  const token = vm.evaluate('WoWAIDB.session');
  vm.run('WoWAIDB.restored = nil');
  nextSlot(vm, '{ now = time(), replies = {}, restore = { token = "' + token + '", chats = { { id = "' + gone + '", name = "stale deleted chat", messages = {} } } } }');
  vm.run('WoWAI.Connect(); STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.num('#WoWAIDB.chats'), 2, 'an acknowledged retired chat cannot return through restore');
});
`);
