'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');
const CL = require('../bridge/chatlog');
const P = require('../bridge/protocol');

const ADDON = path.join(__dirname, '..', 'addon', 'ClaudeWoW');
const ACK = id => `Interface\\\\AddOns\\\\ClaudeWoW\\\\ack\\\\${String(id).padStart(3, '0')}.wav`;
const SLOT = '{ now = time(), cwd = "", transport = "screenshot", chatlog = { line = 200, filler = 4096 }, replies = {} }';

const CLIENT_LOG_API = `
SENT, LOGGING, FILTERS = {}, false, {}
function SendSystemMessage(text) SENT[#SENT + 1] = text end
function LoggingChat(on) if on ~= nil then LOGGING = on end return LOGGING end
function ChatFrame_AddMessageEventFilter(event, fn) FILTERS[#FILTERS + 1] = { event = event, fn = fn } end
`;

function newVM(clientApi = CLIENT_LOG_API) {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const run = (code) => {
    if (lauxlib.luaL_loadstring(L, to_luastring(code)) !== lua.LUA_OK) throw new Error('Lua load: ' + to_jsstring(lua.lua_tostring(L, -1)));
    if (lua.lua_pcall(L, 0, 0, 0) !== lua.LUA_OK) throw new Error('Lua error: ' + to_jsstring(lua.lua_tostring(L, -1)));
  };
  const evaluate = (expr) => {
    run(`local v = (${expr}); if v == nil then RESULT = nil else RESULT = tostring(v) end`);
    lua.lua_getglobal(L, to_luastring('RESULT'));
    const s = lua.lua_isnil(L, -1) ? null : Buffer.from(lua.lua_tolstring(L, -1)).toString('latin1');
    lua.lua_pop(L, 1);
    return s;
  };
  const num = (expr) => Number(evaluate(expr));
  run(fs.readFileSync(path.join(__dirname, 'wow_stub.lua'), 'utf8') + clientApi);
  for (const f of ['Codec.lua', 'Inbox.lua', 'ClaudeWoW.lua']) run(fs.readFileSync(path.join(ADDON, f), 'utf8'));
  return { run, evaluate, num };
}

function loggedIn(slot = SLOT, clientApi = CLIENT_LOG_API, { ackHello = true } = {}) {
  const vm = newVM(clientApi);
  vm.run('STUB.sounds["Interface\\\\AddOns\\\\ClaudeWoW\\\\ctl\\\\valid.wav"] = true; STUB.armed = true');
  vm.run('STUB.FireEvent("ADDON_LOADED", "ClaudeWoW"); STUB.FireEvent("PLAYER_LOGIN")');
  vm.run('STUB.RunTimers()');
  vm.run(`STUB.onLoadAddOn = function(name) ClaudeWoW_SlotData = ${slot} end`);
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  if (ackHello) vm.run(`STUB.sounds["${ACK(vm.num('ClaudeWoWDB.lastSeq'))}"] = false; STUB.now = STUB.now + 2; STUB.Tick()`);
  return vm;
}

function sentFrom(vm, first) {
  const n = vm.num('#SENT');
  const lines = [];
  for (let i = first; i <= n; i++) lines.push(vm.evaluate(`SENT[${i}]`));
  return lines;
}

function asLogText(lines) {
  return lines.map(l => '9/30 19:00:00.000  ' + l + '\r\n').join('');
}

function framesOf(text, cuts = []) {
  const frames = [];
  const a = CL.createAssembler(f => frames.push(f));
  let at = 0;
  for (const cut of cuts) { a.feed(text.slice(at, cut)); at = cut; }
  a.feed(text.slice(at));
  return frames;
}

function recordsOf(frame) {
  return frame.text.split('\x1E').map(r => {
    const p = r.split('\x1F');
    return { chat: p[1], id: Number(p[2]), flags: p[4], text: p[p.length - 1] };
  });
}

function shotFrames(vm, n) {
  for (let i = 0; i < n; i++) vm.run('local f = ClaudeWoWStrip; if f and f.shown and f.scripts.OnUpdate then f.scripts.OnUpdate(f, 0.016) end');
}

test('Codec.LogLines and the bridge assembler round-trip a payload with separators and UTF-8, whatever the flush boundaries', () => {
  const vm = newVM();
  vm.run('PAYLOAD = "sess\\31chat\\31" .. "7\\31\\31n\\31Name\\31h\\195\\169llo w\\195\\182rld " .. string.rep("x", 900) .. "\\30second\\31record"');
  vm.run('LINES, TOTAL = ClaudeWoW_Codec.LogLines(70007, PAYLOAD, 200, 4096)');
  const n = vm.num('#LINES');
  const total = vm.num('TOTAL');
  const lines = [];
  for (let i = 1; i <= n; i++) lines.push(vm.evaluate(`LINES[${i}]`));
  assert.ok(total >= 6 && total < n);
  for (const l of lines) assert.match(l, /^CWX1 70007 (\d+\/\d+ [A-Za-z0-9+/=]+|pad z{200})$/);
  const fillerBytes = lines.slice(total).reduce((sum, l) => sum + l.length, 0);
  assert.ok(fillerBytes >= 4096, 'filler covers a whole buffer: ' + fillerBytes);
  const text = asLogText(lines);
  for (const cuts of [[], [4096], [37, 500, 501, 4096, 4097]]) {
    const frames = framesOf(text, cuts);
    assert.equal(frames.length, 1);
    assert.equal(frames[0].error, undefined);
    assert.equal(frames[0].id, 70007 % 65536);
    assert.equal(frames[0].lineId, 70007);
    assert.equal(frames[0].text, Buffer.from(vm.evaluate('PAYLOAD'), 'latin1').toString('utf8'));
  }
});

test('the assembler ignores other chat lines, rejects a damaged frame, and reads a frame sent twice once each time', () => {
  const vm = newVM();
  vm.run('LINES = ClaudeWoW_Codec.LogLines(5, "abc\\31def", 60, 0)');
  const lines = sentLinesOf(vm);
  const chatter = '9/30 19:00:00.000  [1. General] Someone: CWX1 is not a frame\r\n9/30 19:00:01.000  You feel rested.\r\n';
  assert.deepEqual(framesOf(chatter), []);
  const good = framesOf(chatter + asLogText(lines) + chatter + asLogText(lines));
  assert.deepEqual(good.map(f => f.text), ['abc\x1Fdef', 'abc\x1Fdef']);
  const damaged = lines.map((l, i) => (i === 0 ? l.replace(/ (\S)(\S*)$/, (m, a, rest) => ' ' + (a === 'A' ? 'B' : 'A') + rest) : l));
  const bad = framesOf(asLogText(damaged));
  assert.equal(bad.length, 1);
  assert.ok(['magic', 'checksum', 'length'].includes(bad[0].error), bad[0].error);
});

function sentLinesOf(vm) {
  const n = vm.num('#LINES');
  const lines = [];
  for (let i = 1; i <= n; i++) lines.push(vm.evaluate(`LINES[${i}]`));
  return lines;
}

test('watchChatLog starts at the end of the file, reads what is appended, and starts over when the file is replaced', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-chatlog-'));
  const file = path.join(dir, 'WoWChatLog.txt');
  const vm = newVM();
  vm.run('LINES = ClaudeWoW_Codec.LogLines(9, "old frame", 60, 0)');
  fs.writeFileSync(file, asLogText(sentLinesOf(vm)));
  const frames = [];
  const w = CL.watchChatLog(file, f => frames.push(f), { pollMs: 60000 });
  try {
    w.check();
    assert.deepEqual(frames, [], 'frames from before the bridge started are not replayed');
    vm.run('LINES = ClaudeWoW_Codec.LogLines(10, "new frame", 60, 0)');
    const text = asLogText(sentLinesOf(vm));
    fs.appendFileSync(file, text.slice(0, 50));
    w.check();
    assert.deepEqual(frames, []);
    fs.appendFileSync(file, text.slice(50));
    w.check();
    assert.deepEqual(frames.map(f => f.text), ['new frame']);
    vm.run('LINES = ClaudeWoW_Codec.LogLines(11, "after replace", 60, 0)');
    fs.writeFileSync(file, asLogText(sentLinesOf(vm)));
    w.check();
    assert.deepEqual(frames.map(f => f.text), ['new frame', 'after replace']);
  } finally {
    w.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('capture.chatLog options: off by default, bounded, and named in the slot file only when on', () => {
  assert.equal(CL.options(undefined).enabled, false);
  assert.deepEqual(CL.options(true), { enabled: true, line: 900, filler: 50000, show: false, clean: true, pollMs: 250 });
  assert.deepEqual(CL.options({ enabled: true, line: 5, filler: 999999, show: true }), { enabled: true, line: 900, filler: 50000, show: true, clean: true, pollMs: 250 });
  assert.equal(CL.chatLogFile({ addonDir: '/g/_classic_beta_/Interface/AddOns/' }), path.join('/g/_classic_beta_', 'Logs', 'WoWChatLog.txt'));
  assert.equal(CL.chatLogFile({}), '');
  const off = P.luaTable('ClaudeWoW_SlotData', [], { transport: 'screenshot', chatlog: CL.options(undefined) });
  assert.ok(!off.includes('chatlog'));
  const on = P.luaTable('ClaudeWoW_SlotData', [], { transport: 'screenshot', chatlog: CL.options({ enabled: true, line: 240, filler: 8192, show: true }) });
  assert.ok(on.includes('\tchatlog = { line = 240, filler = 8192, show = true },'), on);
  const pixel = P.luaTable('ClaudeWoW_SlotData', [], { transport: 'pixel', chatlog: CL.options(true) });
  assert.ok(!pixel.includes('chatlog'), 'the pixel transport never offers the chat log');
});

test('the bridge measures the client buffer from the sizes of its writes and sets the padding from it', () => {
  let samples = [];
  for (const bytes of [900, 31627, 49297]) samples = CL.noteWrite(samples, bytes);
  assert.deepEqual(samples, [31627, 49297], 'tiny writes are not samples');
  assert.deepEqual(CL.calibratedFiller(samples, 50000), { filler: 50000, size: 0, usable: true }, 'too few samples: the configured padding stays');
  for (const bytes of [49204, 9340, 49980]) samples = CL.noteWrite(samples, bytes);
  assert.equal(CL.bufferSize(samples), 49204);
  assert.deepEqual(CL.calibratedFiller(samples, 4096), { filler: 50000, size: 49204, usable: true });
  let small = [];
  for (const bytes of [4100, 4300, 4250, 2100]) small = CL.noteWrite(small, bytes);
  assert.deepEqual(CL.calibratedFiller(small, 50000), { filler: 5000, size: 4100, usable: true }, 'a smaller buffer needs less padding');
  let large = [];
  for (const bytes of [131072, 131500, 131900]) large = CL.noteWrite(large, bytes);
  assert.equal(CL.calibratedFiller(large, 50000).usable, false, 'a buffer past the padding limit turns the transport off');
  let many = [];
  for (let i = 0; i < 40; i++) many = CL.noteWrite(many, 49152 + i);
  assert.equal(many.length, 30, 'the sample list is bounded');
});

test('the chat log is cleaned only while the game is closed: transport lines go, the player\'s chat stays, and the file is the same file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-chatlog-'));
  const folder = path.join(dir, '_classic_beta_');
  const file = path.join(folder, 'Logs', 'WoWChatLog.txt');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const keep1 = '9/30 19:00:00.000  You feel rested.\r\n';
  const keep2 = '9/30 19:00:03.000  [1. General] Someone: CWX1 7 1/1 is only words here\r\n';
  const ours = '9/30 19:00:01.000  CWX1 7 1/1 abcd\r\n9/30 19:00:01.000  CWX1 7 pad zzzz\r\n9/30 19:00:02.000  CWLOG1790830585 V 00001 zzzz\r\n';
  const fill = () => { fs.writeFileSync(file, keep1 + ours + keep2, 'latin1'); const old = (Date.now() - 120000) / 1000; fs.utimesSync(file, old, old); };
  const running = () => `/usr/sbin/cfprefsd agent\n${folder}/World of Warcraft Beta.app/Contents/MacOS/World of Warcraft -launcherlogin\n`;
  const closed = () => '/usr/sbin/cfprefsd agent\n/Applications/Other.app/Contents/MacOS/Other\n';
  try {
    fill();
    const inode = fs.statSync(file).ino;
    assert.deepEqual(CL.cleanWhenClosed(file, folder, { platform: 'darwin', listProcesses: running }), { cleaned: false, why: 'the game is running' });
    assert.equal(CL.cleanWhenClosed(file, folder, { platform: 'linux', listProcesses: closed }).why, 'cannot tell whether the game is running');
    assert.equal(CL.cleanWhenClosed(file, folder, { platform: 'darwin', listProcesses: () => { throw new Error('no ps'); } }).why, 'cannot tell whether the game is running');
    assert.equal(fs.readFileSync(file, 'latin1'), keep1 + ours + keep2, 'nothing was touched');
    fs.utimesSync(file, Date.now() / 1000, Date.now() / 1000);
    assert.equal(CL.cleanWhenClosed(file, folder, { platform: 'darwin', listProcesses: closed }).why, 'written less than a minute ago');
    fill();
    const r = CL.cleanWhenClosed(file, folder, { platform: 'darwin', listProcesses: closed });
    assert.equal(r.cleaned, true);
    assert.equal(r.removed, 3);
    assert.equal(fs.readFileSync(file, 'latin1'), keep1 + keep2);
    assert.equal(fs.statSync(file).ino, inode);
    assert.equal(CL.cleanWhenClosed(path.join(dir, 'missing.txt'), folder, { platform: 'darwin', listProcesses: closed }).why, 'no file');
    assert.equal(CL.clientFolder({ addonDir: path.join(folder, 'Interface', 'AddOns') }), folder);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('watchChatLog reports the size of each write it reads', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-chatlog-'));
  const file = path.join(dir, 'WoWChatLog.txt');
  fs.writeFileSync(file, 'old\r\n');
  const writes = [];
  const w = CL.watchChatLog(file, () => {}, { pollMs: 60000, onWrite: n => writes.push(n) });
  try {
    fs.appendFileSync(file, 'x'.repeat(4998) + '\r\n');
    w.check();
    fs.appendFileSync(file, 'y'.repeat(98) + '\r\n');
    w.check();
    assert.deepEqual(writes, [5000, 100]);
  } finally {
    w.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('chat log transport: a message is written to the chat log as hidden system lines, with no strip and no screenshot', () => {
  const vm = loggedIn();
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.chatlog.line'), '200');
  assert.equal(vm.evaluate('LOGGING'), 'true', 'chat logging is turned on');
  const hello = framesOf(asLogText(sentFrom(vm, 1)));
  assert.equal(hello.length, 1, 'the unacknowledged hello went out again through the chat log');
  assert.match(recordsOf(hello[0])[0].flags, /^h;/);
  const before = vm.num('#SENT');
  vm.run('ClaudeWoW.Send("hello world")');
  const lines = sentFrom(vm, before + 1);
  assert.ok(lines.length > 0);
  const frames = framesOf(asLogText(lines));
  assert.equal(frames.length, 1);
  assert.ok(recordsOf(frames[0]).find(r => r.text === 'hello world'));
  assert.equal(vm.evaluate('ClaudeWoWStrip and ClaudeWoWStrip.shown or false'), 'false', 'no strip on screen');
  shotFrames(vm, 3);
  assert.equal(vm.num('STUB.screenshots'), 0);
  const hide = 'FILTERS[#FILTERS].fn';
  assert.equal(vm.evaluate(`${hide}(nil, "CHAT_MSG_SYSTEM", SENT[#SENT])`), 'true', 'the lines are filtered out of the chat frames');
  assert.equal(vm.evaluate(`${hide}(nil, "CHAT_MSG_SYSTEM", "You feel rested.")`), 'false');
  vm.run('STUB.now = STUB.now + 2; STUB.Tick(); STUB.now = STUB.now + 2; STUB.Tick()');
  assert.equal(vm.num('#SENT'), before + lines.length, 'nothing is written again while waiting for the ack');
});

function sendLate(vm, name) {
  const before = vm.num('#SENT');
  vm.run(`ClaudeWoW.NewChat("${name}"); ClaudeWoW.Send("late ${name}")`);
  const logged = vm.num('#SENT') > before;
  vm.run('STUB.now = STUB.now + 9; STUB.Tick()');
  shotFrames(vm, 2);
  vm.run('STUB.FireEvent("SCREENSHOT_SUCCEEDED")');
  vm.run(`STUB.sounds["${ACK(vm.num('ClaudeWoWDB.lastSeq'))}"] = false; STUB.now = STUB.now + 2; STUB.Tick()`);
  return logged;
}

function sendPrompt(vm, name) {
  const before = vm.num('#SENT');
  vm.run(`ClaudeWoW.NewChat("${name}"); ClaudeWoW.Send("prompt ${name}")`);
  const logged = vm.num('#SENT') > before;
  shotFrames(vm, 2);
  vm.run('STUB.FireEvent("SCREENSHOT_SUCCEEDED")');
  vm.run(`STUB.sounds["${ACK(vm.num('ClaudeWoWDB.lastSeq'))}"] = false; STUB.now = STUB.now + 2; STUB.Tick()`);
  return logged;
}

function lastDiag(vm) {
  vm.run('SlashCmdList.CLAUDE("diag")');
  return vm.evaluate('ClaudeWoWDB.chats[#ClaudeWoWDB.chats].history[#ClaudeWoWDB.chats[#ClaudeWoWDB.chats].history].text');
}

test('chat log transport heals itself: a pause after two late acks, a trial after 10 minutes, a longer pause when the trial is late, and back on when a trial is acknowledged', () => {
  const vm = loggedIn();
  assert.equal(sendLate(vm, 'a'), true);
  assert.equal(sendLate(vm, 'b'), true);
  assert.match(lastDiag(vm), /chat log transport: PAUSED, next try in 10m00s/);
  assert.equal(sendPrompt(vm, 'c'), false, 'paused: screenshot only');
  vm.run('STUB.now = STUB.now + 601');
  assert.equal(sendLate(vm, 'd'), true, 'the trial after the pause uses the chat log');
  assert.match(lastDiag(vm), /chat log transport: PAUSED, next try in 20m00s/, 'a late trial doubles the pause');
  vm.run('STUB.now = STUB.now + 601');
  assert.equal(sendPrompt(vm, 'e'), false, 'still paused after the first wait');
  vm.run('STUB.now = STUB.now + 601');
  assert.match(lastDiag(vm), /chat log transport: on trial after a pause/);
  assert.equal(sendPrompt(vm, 'f'), true, 'the second trial uses the chat log');
  assert.match(lastDiag(vm), /chat log transport: on, /, 'an ack on the first try ends the pause');
  assert.equal(sendLate(vm, 'g'), true);
  assert.match(lastDiag(vm), /chat log transport: on, /, 'one late ack alone does not pause');
});

test('chat log transport: new padding from the bridge ends a pause at once', () => {
  const vm = loggedIn();
  sendLate(vm, 'a');
  sendLate(vm, 'b');
  assert.match(lastDiag(vm), /PAUSED/);
  vm.run('STUB.onLoadAddOn = function(name) ClaudeWoW_SlotData = { now = time(), cwd = "", transport = "screenshot", chatlog = { line = 200, filler = 60000 }, replies = {} } end');
  vm.run('ClaudeWoW.Connect(); STUB.now = STUB.now + 6; STUB.Tick()');
  assert.match(lastDiag(vm), /chat log transport: on, lines of 200, filler 60000 bytes/);
});

test('chat log transport: an unacknowledged message is retried by screenshot, and two late acks in a row pause the chat log', () => {
  const vm = loggedIn();
  for (let round = 1; round <= 2; round++) {
    vm.run(`ClaudeWoW.NewChat("Chat ${round}"); ClaudeWoW.Send("lost ${round}")`);
    shotFrames(vm, 3);
    assert.equal(vm.num('STUB.screenshots'), round - 1, 'first try: chat log only');
    vm.run('STUB.now = STUB.now + 9; STUB.Tick()');
    assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'true', 'the retry puts the strip up');
    shotFrames(vm, 2);
    assert.equal(vm.num('STUB.screenshots'), round, 'the retry is a screenshot');
    vm.run('STUB.FireEvent("SCREENSHOT_SUCCEEDED")');
    const id = vm.num('ClaudeWoWDB.lastSeq');
    vm.run(`STUB.sounds["${ACK(id)}"] = false; STUB.now = STUB.now + 2; STUB.Tick()`);
  }
  const written = vm.num('#SENT');
  vm.run('ClaudeWoW.NewChat("Chat 3"); ClaudeWoW.Send("third")');
  assert.equal(vm.num('#SENT'), written, 'the chat log is off now');
  shotFrames(vm, 2);
  assert.equal(vm.num('STUB.screenshots'), 3, 'the message went out by screenshot at once');
  vm.run('SlashCmdList.CLAUDE("diag")');
  const diag = vm.evaluate('ClaudeWoWDB.chats[#ClaudeWoWDB.chats].history[#ClaudeWoWDB.chats[#ClaudeWoWDB.chats].history].text');
  assert.match(diag, /chat log transport: PAUSED, next try in/);
});

test('chat log transport: a hello the bridge never acknowledges is retried by screenshot before it expires, and a message waits 8 s, not 40', () => {
  const vm = loggedIn(SLOT, CLIENT_LOG_API, { ackHello: false });
  assert.equal(vm.num('STUB.screenshots'), 0);
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  shotFrames(vm, 2);
  assert.equal(vm.num('STUB.screenshots'), 0, 'not before the retry time');
  vm.run('STUB.now = STUB.now + 3; STUB.Tick()');
  shotFrames(vm, 2);
  assert.equal(vm.num('STUB.screenshots'), 1, 'the hello went out again by screenshot');
});

test('chat log transport: without the sound channel the ack comes from a slot poll, so the screenshot retry waits 15 s', () => {
  const vm = loggedIn();
  vm.run('ClaudeWoWDB.settings.signal = false');
  vm.run('ClaudeWoW.NewChat("Slow"); ClaudeWoW.Send("no sound channel")');
  vm.run('STUB.now = STUB.now + 9; STUB.Tick()');
  shotFrames(vm, 2);
  assert.equal(vm.num('STUB.screenshots'), 0, 'not at 8 s');
  vm.run('STUB.now = STUB.now + 7; STUB.Tick()');
  shotFrames(vm, 2);
  assert.equal(vm.num('STUB.screenshots'), 1, 'at 15 s');
});

test('chat log transport: a bridge not heard from for an hour still gets the message through the chat log, while screenshots stay paused', () => {
  const vm = loggedIn();
  vm.run('STUB.now = STUB.now + 3600; STUB.Tick()');
  const before = vm.num('#SENT');
  const shots = vm.num('STUB.screenshots');
  vm.run('ClaudeWoW.NewChat("After idle"); ClaudeWoW.Send("still there?")');
  const frames = framesOf(asLogText(sentFrom(vm, before + 1)));
  assert.equal(frames.length, 1);
  assert.ok(recordsOf(frames[0]).find(r => r.text === 'still there?'));
  shotFrames(vm, 3);
  assert.equal(vm.num('STUB.screenshots'), shots, 'no screenshot for a bridge that looks dark');
});

test('/claude diag copy opens the diagnostics in the copy box, and plain /claude diag does not', () => {
  const vm = loggedIn();
  vm.run('SlashCmdList.CLAUDE("diag")');
  assert.equal(vm.evaluate('ClaudeWoWCopy and ClaudeWoWCopy.shown or false'), 'false');
  vm.run('SlashCmdList.CLAUDE("diag copy")');
  assert.equal(vm.evaluate('ClaudeWoWCopy.shown'), 'true');
  assert.match(lastDiag(vm), /^Diagnostics:\nsound channel/);
});

test('chat log transport: an ack on the first try keeps the chat log on after one late ack', () => {
  const vm = loggedIn();
  vm.run('ClaudeWoW.NewChat("One"); ClaudeWoW.Send("late")');
  vm.run('STUB.now = STUB.now + 9; STUB.Tick()');
  shotFrames(vm, 2);
  vm.run('STUB.FireEvent("SCREENSHOT_SUCCEEDED")');
  vm.run(`STUB.sounds["${ACK(vm.num('ClaudeWoWDB.lastSeq'))}"] = false; STUB.now = STUB.now + 2; STUB.Tick()`);
  vm.run('ClaudeWoW.NewChat("Two"); ClaudeWoW.Send("prompt")');
  vm.run(`STUB.sounds["${ACK(vm.num('ClaudeWoWDB.lastSeq'))}"] = false; STUB.now = STUB.now + 2; STUB.Tick()`);
  vm.run('ClaudeWoW.NewChat("Three"); ClaudeWoW.Send("late again")');
  vm.run('STUB.now = STUB.now + 9; STUB.Tick()');
  shotFrames(vm, 2);
  vm.run('STUB.FireEvent("SCREENSHOT_SUCCEEDED")');
  vm.run(`STUB.sounds["${ACK(vm.num('ClaudeWoWDB.lastSeq'))}"] = false; STUB.now = STUB.now + 2; STUB.Tick()`);
  const before = vm.num('#SENT');
  vm.run('ClaudeWoW.NewChat("Four"); ClaudeWoW.Send("still by chat log")');
  assert.ok(vm.num('#SENT') > before, 'one late ack, then a prompt one, then one late ack: still on');
});

test('chat log transport: a message that asks for vision goes out by screenshot', () => {
  const vm = loggedIn();
  const before = vm.num('#SENT');
  vm.run('SlashCmdList.CLAUDE("look what is this item?")');
  assert.equal(vm.num('#SENT'), before);
  shotFrames(vm, 2);
  assert.equal(vm.num('STUB.screenshots'), 1);
});

test('a bridge that does not offer the chat log, or a client without the API, keeps the screenshot transport', () => {
  const plain = loggedIn('{ now = time(), cwd = "", transport = "screenshot", replies = {} }');
  assert.equal(plain.evaluate('ClaudeWoWDB.settings.chatlog'), null);
  plain.run('ClaudeWoW.Send("by screenshot")');
  assert.equal(plain.num('#SENT'), 0);
  shotFrames(plain, 2);
  assert.ok(plain.num('STUB.screenshots') >= 1);
  const noApi = loggedIn(SLOT, 'SENT = {}\n');
  noApi.run('ClaudeWoW.Send("by screenshot")');
  shotFrames(noApi, 2);
  assert.ok(noApi.num('STUB.screenshots') >= 1);
  noApi.run('SlashCmdList.CLAUDE("diag")');
  assert.match(noApi.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].text'), /chat log transport: unavailable in this client/);
});

test('a bridge that stops offering the chat log is followed on the next slot read', () => {
  const vm = loggedIn();
  vm.run('STUB.onLoadAddOn = function(name) ClaudeWoW_SlotData = { now = time(), cwd = "", transport = "screenshot", replies = {} } end');
  vm.run('ClaudeWoW.Connect(); STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.chatlog'), null);
  const before = vm.num('#SENT');
  vm.run('ClaudeWoW.Send("by screenshot now")');
  assert.equal(vm.num('#SENT'), before);
});
