// Runs the real addon Lua (Codec.lua + WoWAI.lua) in a Lua VM with a stub
// WoW API (wow_stub.lua) and drives it through a session: login, hello, a sent
// message read back off the pixel strip, a reply delivered through a slot, the
// bridge's default folder and agent, a chat that picks another agent, a
// permission denial with Allow, and a restore.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const fengari = require('fengari');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari;

const ADDON = path.join(__dirname, '..', 'addon', 'WoWAI');
const CELLS_PER_ROW = 200;

function newVM() {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const run = (code, arg) => {
    if (lauxlib.luaL_loadstring(L, to_luastring(code)) !== lua.LUA_OK) throw new Error('Lua load: ' + to_jsstring(lua.lua_tostring(L, -1)));
    let nargs = 0;
    if (arg !== undefined) { lua.lua_pushstring(L, to_luastring(arg)); nargs = 1; }
    if (lua.lua_pcall(L, nargs, 0, 0) !== lua.LUA_OK) throw new Error('Lua error: ' + to_jsstring(lua.lua_tostring(L, -1)));
  };
  // Evaluate an expression and bring it back as a string (or nil).
  const evaluate = (expr) => {
    run(`local v = (${expr}); if v == nil then RESULT = nil else RESULT = tostring(v) end`);
    lua.lua_getglobal(L, to_luastring('RESULT'));
    const isNil = lua.lua_isnil(L, -1);
    const s = isNil ? null : to_jsstring(lua.lua_tolstring(L, -1));
    lua.lua_pop(L, 1);
    return s;
  };
  const num = (expr) => Number(evaluate(expr));
  run(fs.readFileSync(path.join(__dirname, 'wow_stub.lua'), 'utf8'));
  for (const f of ['Codec.lua', 'Inbox.lua', 'WoWAI.lua']) run(fs.readFileSync(path.join(ADDON, f), 'utf8'), 'WoWAI');
  return { run, evaluate, num };
}

// Read the strip the addon drew, exactly like capture.ps1: 3 bits per cell,
// [C7 1A] [id] [len] [payload] [fletcher]. Returns { id, text } or null.
function decodeStrip(vm, threshold = 0.5) {
  if (vm.evaluate('WoWAIStrip and WoWAIStrip.shown') !== 'true') return null;
  vm.run(`
    local parts = {}
    local th = ${threshold}
    for _, t in ipairs(WoWAIStrip.textures) do
      if t.shown and t.color then
        local c, r = math.floor(t.x / 4), math.floor(-t.y / 4)
        local v = (t.color[1] >= th and 4 or 0) + (t.color[2] >= th and 2 or 0) + (t.color[3] >= th and 1 or 0)
        parts[#parts + 1] = (r * ${CELLS_PER_ROW} + c) .. ":" .. v
      end
    end
    RESULT = table.concat(parts, ",")`);
  const cells = [];
  for (const p of vm.evaluate('RESULT').split(',')) { const [i, v] = p.split(':').map(Number); cells[i] = v; }
  const bytes = [];
  let acc = 0, nbits = 0;
  for (let i = 0; i < cells.length; i++) {
    acc = (acc << 3) | (cells[i] || 0); nbits += 3;
    while (nbits >= 8) { bytes.push((acc >> (nbits - 8)) & 0xff); nbits -= 8; acc &= (1 << nbits) - 1; }
  }
  assert.equal(bytes[0], 0xc7); assert.equal(bytes[1], 0x1a);
  const id = bytes[2] * 256 + bytes[3];
  const len = bytes[4] * 256 + bytes[5];
  let s1 = 0, s2 = 0;
  for (let k = 2; k < 6 + len; k++) { s1 = (s1 + bytes[k]) % 255; s2 = (s2 + s1) % 255; }
  assert.equal(bytes[6 + len], s1, 'fletcher s1'); assert.equal(bytes[7 + len], s2, 'fletcher s2');
  return { id, text: Buffer.from(bytes.slice(6, 6 + len)).toString('utf8') };
}

function stripRecords(vm, threshold) {
  const frame = decodeStrip(vm, threshold);
  if (!frame) return [];
  return frame.text.split('\x1E').map(r => {
    const p = r.split('\x1F');
    const withCtx = p[4].split(';').includes('c'); // a "c" flag means field 7 is the game context
    const rec = { session: p[0], chat: p[1], id: Number(p[2]), cwd: p[3], flags: p[4], name: p[5], text: p.slice(withCtx ? 7 : 6).join('\x1F') };
    if (withCtx) rec.ctx = p[6];
    return rec;
  });
}

// Make the next LoadAddOn deliver this slot data (a Lua table literal body).
function nextSlot(vm, luaBody) {
  vm.run(`STUB.onLoadAddOn = function(name) WoWAI_SlotData = ${luaBody} end`);
}

function login(vm) {
  vm.run('STUB.FireEvent("ADDON_LOADED", "WoWAI")');
  vm.run('STUB.FireEvent("PLAYER_LOGIN")');
}

// Let the bridge answer the login hello: its slot carries a fresh clock, which is
// what makes the addon consider itself connected (Send is gated on that).
function connect(vm) {
  vm.run('STUB.RunTimers()'); // C_Timer.After(3, SayHello)
  nextSlot(vm, '{ now = time(), cwd = "", replies = {} }');
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()'); // hello poll 5 s later
  assert.equal(vm.evaluate('WoWAI.IsConnected()'), 'true', 'connected after the hello slot');
}

test('addon loads, builds its UI and creates a first chat', () => {
  const vm = newVM();
  login(vm);
  assert.equal(vm.num('#WoWAIDB.chats'), 1);
  assert.equal(vm.evaluate('WoWAIDB.chats[1].name'), 'Chat 1');
  assert.equal(vm.evaluate('WoWAIFrame ~= nil'), 'true');
  assert.equal(vm.evaluate('WoWAIMini ~= nil'), 'true');
  assert.equal(vm.num('#STUB.tickers'), 1);
  assert.equal(vm.evaluate('SlashCmdList.WOWAI ~= nil'), 'true');
  assert.deepEqual([1, 2, 3, 4, 5].map(i => vm.evaluate('SLASH_WOWAI' + i)), ['/wow-ai', '/wowai', '/wow-claude', '/ai', '/ask'], 'the old command name and the short forms are aliases');
  assert.equal(vm.evaluate('SlashCmdList.WOWAIASK'), null, '/ai is an alias of the one command, not a handler of its own');
});

test('hello goes out on the strip after login', () => {
  const vm = newVM();
  login(vm);
  vm.run('STUB.RunTimers()'); // C_Timer.After(3, SayHello)
  const recs = stripRecords(vm);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].flags, 'h;c', 'a hello always carries the game context');
  assert.equal(recs[0].text, '');
  assert.equal(recs[0].session, vm.evaluate('WoWAIDB.session'));
});

test('outbound records replace field separators inside user text', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  vm.run('WoWAI.Send("wire" .. string.char(30, 31) .. "safe")');
  const rec = stripRecords(vm).find(r => r.text === 'wire  safe');
  assert.ok(rec, 'the record keeps the full message as one wire field');
});

test('the game context describes the character and rides on the hello, then only when it changes or is turned off', () => {
  const vm = newVM();
  login(vm);
  vm.run('STUB.RunTimers()');
  const hello = stripRecords(vm)[0];
  assert.deepEqual(hello.ctx.split('\n'), [
    'Game: World of Warcraft: Forever (client 1.60.1.69913, interface 16001)',
    'Character: Testchar on Test Realm, level 23 Night Elf Hunter (Alliance), guild <Test Guild>',
    'Location: Duskwood - Darkshire',
    'Position: 45.2, 67.8 (map 1431)',
    'Money: 1g 23s 45c; XP: 1234/5000',
    'Talents: Beast Mastery 10 / Marksmanship 5 / Survival 0',
    'Professions: Skinning 75/75, First Aid 40/75',
  ]);
  // The bridge answers the hello: the context is now known to be on its side.
  nextSlot(vm, '{ now = time(), cwd = "", replies = {} }');
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('WoWAI.IsConnected()'), 'true');
  vm.run('WoWAI.Send("hello world")');
  let rec = stripRecords(vm).find(r => r.text === 'hello world');
  assert.equal(rec.flags, '', 'unchanged context is not repeated');
  assert.equal(rec.ctx, undefined);
  assert.equal(vm.evaluate('WoWAIDB.outbox.ctx'), null);
  // Moving to another zone changes it, so the next message (from another chat,
  // the first one is still waiting) carries the new version.
  vm.run('STUB.zone = "Elwynn Forest"; STUB.subzone = ""; STUB.posX = 0.1; WoWAI.NewChat("Second"); WoWAI.Send("where am I")');
  rec = stripRecords(vm).find(r => r.text === 'where am I');
  assert.equal(rec.flags, 'c');
  assert.ok(rec.ctx.includes('Location: Elwynn Forest\n'), rec.ctx);
  assert.ok(rec.ctx.includes('Position: 10.0, 67.8 on Duskwood (map 1431)'), 'the map name shows when it differs from the zone');
  assert.equal(Buffer.from(vm.evaluate('WoWAIDB.outbox.ctx'), 'hex').toString('utf8'), rec.ctx, 'the reload path carries it too');
  // Turning it off sends an empty context at once (a hello), so the bridge drops what it had.
  vm.run('SlashCmdList.WOWAI("context off")');
  assert.equal(vm.evaluate('WoWAIDB.settings.context'), 'false');
  const off = stripRecords(vm).filter(r => r.flags === 'h;c');
  assert.equal(off.length, 1);
  assert.equal(off[0].ctx, '');
  assert.ok(vm.evaluate('WoWAIDB.chats[2].history[#WoWAIDB.chats[2].history].text').includes('Game context is OFF'));
  // Back on: another hello, with the context again.
  vm.run('SlashCmdList.WOWAI("context on")');
  const on = stripRecords(vm).filter(r => r.flags === 'h;c');
  assert.ok(on.some(r => r.ctx.includes('Character: Testchar')));
  assert.ok(vm.evaluate('WoWAIDB.chats[2].history[#WoWAIDB.chats[2].history].text').includes('Game context is ON'));
});

test('a shift-clicked link lands in the focused input and is sent as its name plus tooltip', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  const link = '|cff1eff00|Hitem:2140:0:0:0:0:0:0:0:60:0:0|h[Fine Longsword]|h|r';
  vm.run(`STUB.tooltips["item:2140:0:0:0:0:0:0:0:60:0:0"] = { "Fine Longsword", { "Main Hand", "Sword" }, { "17 - 33 Damage", "Speed 2.70" }, "Requires Level 14" }`);
  // Without focus the link is left alone (shift-click keeps its normal meaning).
  vm.run(`WoWAIInput:SetText("is this good for me? "); WoWAIInput:ClearFocus(); ChatFrameUtil.InsertLink("${link}")`);
  assert.equal(vm.evaluate('WoWAIInput:GetText()'), 'is this good for me? ');
  // The client's own path (bags, spellbook, quest log all end here): ChatFrameUtil.InsertLink.
  vm.run(`WoWAIInput:SetFocus(); ChatFrameUtil.InsertLink("${link}")`);
  assert.equal(vm.evaluate('WoWAIInput:GetText()'), 'is this good for me? ' + link);
  // The old global name is not hooked as well, so nothing is inserted twice.
  vm.run(`ChatEdit_InsertLink("${link}")`);
  assert.equal(vm.evaluate('WoWAIInput:GetText()'), 'is this good for me? ' + link + link, 'the alias reaches the one hook exactly once');
  vm.run(`WoWAIInput:SetText("is this good for me? ${link}")`);
  vm.run('WoWAI.SendFromInput()');
  const expected = [
    'is this good for me? [Fine Longsword]',
    '',
    '--- Linked from the game ---',
    '[Fine Longsword] item 2140 (Uncommon)',
    '  Fine Longsword',
    '  Main Hand  Sword',
    '  17 - 33 Damage  Speed 2.70',
    '  Requires Level 14',
  ].join('\n');
  const rec = stripRecords(vm).find(r => r.text.startsWith('is this good'));
  assert.equal(rec.text, expected);
  assert.equal(vm.evaluate('WoWAIDB.chats[1].history[#WoWAIDB.chats[1].history].text'), expected, 'the transcript shows what was sent');
  assert.equal(vm.evaluate('WoWAIDB.chats[1].name'), 'Is this good for me');
  // Bare links (no colour) and repeated links: one block each, tooltip or not.
  vm.run('RESULT = (WoWAI.ExpandLinks("x |Hspell:1978|h[Serpent Sting]|h y |Hspell:1978|h[Serpent Sting]|h"))');
  assert.equal(vm.evaluate('RESULT'), 'x [Serpent Sting] y [Serpent Sting]\n\n--- Linked from the game ---\n[Serpent Sting] spell 1978');
  vm.run('RESULT, COUNT = WoWAI.ExpandLinks("plain text | with a pipe")');
  assert.equal(vm.evaluate('RESULT'), 'plain text | with a pipe');
  assert.equal(vm.evaluate('COUNT'), '0');
});

test('deleting a chat tells the bridge to forget it, and a restore never brings it back', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  vm.run('WoWAI.NewChat("Second")');
  assert.equal(vm.num('#WoWAIDB.chats'), 2);
  const gone = vm.evaluate('WoWAIDB.chats[2].id');
  vm.run(`WoWAI.DeleteChat("${gone}")`);
  assert.equal(vm.num('#WoWAIDB.chats'), 1);
  // A forget record for that chat is on the strip and remembered until acked.
  const rec = stripRecords(vm).find(r => r.flags === 'd');
  assert.ok(rec, 'forget record on the strip');
  assert.equal(rec.chat, gone);
  assert.equal(rec.text, '');
  assert.equal(vm.evaluate(`WoWAIDB.forget["${gone}"] ~= nil`), 'true');
  // A restore that still lists the chat is ignored for it.
  const token = vm.evaluate('WoWAIDB.session');
  nextSlot(vm, `{ now = time(), cwd = "", replies = {}, restore = { token = "${token}", chats = { { id = "${gone}", name = "Second", cwd = "", messages = { { role = "user", text = "old", id = 1, t = 1 } } } } } }`);
  vm.run('WoWAI.Connect(); STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.num('#WoWAIDB.chats'), 1, 'deleted chat not restored');
  // The bridge acks the forget record: it leaves the strip and the memory.
  const slot = String(rec.id).padStart(3, '0');
  vm.run(`STUB.sounds["Interface\\\\AddOns\\\\WoWAI\\\\ack\\\\${slot}.wav"] = true; STUB.Tick()`);
  assert.equal(vm.evaluate(`WoWAIDB.forget["${gone}"]`), null, 'forgotten once acked');
  assert.ok(!stripRecords(vm).find(r => r.flags === 'd'), 'forget record left the strip');
});

test('until the bridge answers, Connect replaces Send and a message stays in the box', () => {
  const vm = newVM();
  login(vm);
  vm.run('WoWAI.Toggle(true)');
  assert.equal(vm.evaluate('WoWAI.IsConnected()'), 'false');
  const texts = () => vm.evaluate('table.concat(STUB.texts, "|")');
  assert.ok(texts().includes('Not connected - start the bridge, then click Connect'));
  // Sending while disconnected puts the text back in the box and starts a connect attempt.
  vm.run('WoWAIInput:SetText("fix the bug"); WoWAI.SendFromInput()');
  assert.equal(vm.evaluate('WoWAIDB.chats[1].pendingId'), null, 'nothing sent');
  assert.equal(vm.evaluate('WoWAIInput:GetText()'), 'fix the bug', 'message kept in the box');
  const hello = stripRecords(vm);
  assert.equal(hello.length, 1);
  assert.equal(hello[0].flags, 'h;c', 'a hello went out instead');
  assert.ok(texts().includes('Connecting...'));
  assert.ok(texts().includes('your message goes out as soon as it answers'));
  // No answer within CONNECT_WAIT: the attempt is reported as failed, Connect is back.
  vm.run('STUB.now = STUB.now + 20; STUB.Tick()');
  assert.equal(vm.evaluate('WoWAI.IsConnected()'), 'false');
  assert.ok(texts().includes('No answer from the bridge'));
  assert.equal(vm.evaluate('WoWAIInput:GetText()'), 'fix the bug', 'message still in the box after a failed attempt');
  // Click Connect again; this time the bridge answers the hello poll. Nothing was
  // queued by that click, so the message waits for the user.
  vm.run('WoWAI.Connect()');
  nextSlot(vm, '{ now = time(), cwd = "C:\\\\proj", replies = {} }');
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('WoWAI.IsConnected()'), 'true');
  assert.equal(vm.evaluate('WoWAIDB.chats[1].pendingId'), null, 'a plain Connect sends nothing by itself');
  vm.run('WoWAI.SendFromInput()');
  assert.ok(vm.num('WoWAIDB.chats[1].pendingId') >= 1, 'the kept message goes out once connected');
  assert.ok(stripRecords(vm).find(r => r.text === 'fix the bug'));
});

test('a message sent while disconnected goes out by itself once the bridge answers', () => {
  const vm = newVM();
  login(vm);
  vm.run('WoWAI.Toggle(true)');
  vm.run('WoWAIInput:SetText("fix the bug"); WoWAI.SendFromInput()');
  assert.equal(vm.evaluate('WoWAIDB.chats[1].pendingId'), null, 'nothing sent yet');
  // The bridge answers the hello poll: the queued message follows without a second click.
  nextSlot(vm, '{ now = time(), cwd = "C:\\\\proj", replies = {} }');
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('WoWAI.IsConnected()'), 'true');
  assert.ok(vm.num('WoWAIDB.chats[1].pendingId') >= 1, 'queued message went out on connect');
  assert.ok(stripRecords(vm).find(r => r.text === 'fix the bug'));
  assert.equal(vm.evaluate('WoWAIInput:GetText()'), '', 'box cleared after the auto-send');
  // Only once: a later reconnect sends nothing.
  vm.run('WoWAI.Connect()');
  nextSlot(vm, '{ now = time(), cwd = "C:\\\\proj", replies = {} }');
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(stripRecords(vm).filter(r => r.text === 'fix the bug').length, 1);
});

test('without the sound channel, the light stays green between idle slot polls', () => {
  // The stub has no ctl/valid.wav, so the login self-test disables the sound
  // channel: the addon is in "slot checks only" mode, like a client whose
  // PlaySoundFile reports every file as playable.
  const vm = newVM();
  login(vm);
  connect(vm);
  assert.equal(vm.evaluate('WoWAI.BridgeState()'), 'ok');
  // 90 s of silence used to mean "stale"; with no beats to hear that is normal.
  vm.run('STUB.now = STUB.now + 200; STUB.Tick()');
  assert.equal(vm.evaluate('WoWAI.BridgeState()'), 'ok', 'still green after 200 s');
  assert.equal(vm.evaluate('WoWAI.IsConnected()'), 'true');
  // 10 minutes in, the idle poll spends a slot; the bridge's clock in it keeps the light green.
  vm.run('STUB.loadCount = 0; STUB.onLoadAddOn = function(name) STUB.loadCount = STUB.loadCount + 1; WoWAI_SlotData = { now = time(), cwd = "", replies = {} } end');
  vm.run('STUB.now = STUB.now + 410; STUB.Tick()');
  assert.equal(vm.num('STUB.loadCount'), 1, 'one idle poll');
  assert.equal(vm.evaluate('WoWAI.BridgeState()'), 'ok', 'green again after the idle poll');
  // A bridge that really is gone still shows: no slot answers, and the light drops.
  vm.run('STUB.onLoadAddOn = function(name) WoWAI_SlotData = nil end');
  vm.run('STUB.now = STUB.now + 800; STUB.Tick()');
  assert.equal(vm.evaluate('WoWAI.BridgeState()'), 'stale');
  vm.run('STUB.now = STUB.now + 700; STUB.Tick()');
  assert.equal(vm.evaluate('WoWAI.BridgeState()'), 'down');
});

test('the Folder... menu item (right-click a chat) opens a prompt that sets the chat folder like /wow-ai cd', () => {
  const vm = newVM();
  login(vm);
  vm.run('WoWAI.FolderPrompt()');
  assert.equal(vm.evaluate('STUB.popup.which'), 'WOWAI_FOLDER');
  assert.equal(vm.evaluate('STUB.popup.data.cwd'), '');
  // Accept the dialog the way the game would: an edit box holding the new path.
  vm.run(`
    local dialog = { editBox = { GetText = function() return "  ..\\\\realms " end } }
    StaticPopupDialogs.WOWAI_FOLDER.OnAccept(dialog, STUB.popup.data)`);
  assert.equal(vm.evaluate('WoWAIDB.chats[1].cwd'), '..\\realms');
  assert.ok(vm.evaluate('WoWAIDB.chats[1].history[#WoWAIDB.chats[1].history].text').includes('relative to'));
  vm.run('WoWAI.FolderPrompt()');
  assert.equal(vm.evaluate('STUB.popup.data.cwd'), '..\\realms', 'prompt is prefilled with the current folder');
  // A full path gets no "relative to" note; empty goes back to the default.
  vm.run('WoWAI.SetFolder("C:\\\\other")');
  assert.ok(!vm.evaluate('WoWAIDB.chats[1].history[#WoWAIDB.chats[1].history].text').includes('relative to'));
  vm.run('WoWAI.SetFolder("")');
  assert.equal(vm.evaluate('WoWAIDB.chats[1].cwd'), '');
});

test('a sent message is encoded on the strip with the chat folder, then a slot reply finishes it', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  vm.run('SlashCmdList.WOWAI("cd realms")');
  assert.equal(vm.evaluate('WoWAIDB.chats[1].cwd'), 'realms');
  vm.run('WoWAI.Send("hello world")');
  const chatId = vm.evaluate('WoWAIDB.chats[1].id');
  const id = vm.num('WoWAIDB.chats[1].pendingId');
  assert.ok(id >= 1);
  const rec = stripRecords(vm).find(r => r.text === 'hello world');
  assert.ok(rec, 'message record on the strip');
  assert.equal(rec.chat, chatId);
  assert.equal(rec.id, id);
  assert.equal(rec.cwd, 'realms');
  assert.equal(rec.flags, '');
  // The chat took its title from the first message.
  assert.equal(vm.evaluate('WoWAIDB.chats[1].name'), 'Hello world');

  nextSlot(vm, `{ now = time(), cwd = "C:\\\\proj", replies = { { chat = "${chatId}", id = ${id}, status = "done", text = "hi back", cwd = "x", session = "s" } } }`);
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()'); // first scheduled poll is 5 s after sending
  assert.equal(vm.evaluate('WoWAIDB.chats[1].pendingId'), null);
  assert.equal(vm.evaluate('WoWAIDB.chats[1].history[#WoWAIDB.chats[1].history].role'), 'assistant');
  assert.equal(vm.evaluate('WoWAIDB.chats[1].history[#WoWAIDB.chats[1].history].text'), 'hi back');
  assert.ok(vm.evaluate('table.concat(STUB.prints, "\\n")').includes('hi back'), 'reply echoed to the game chat');
  assert.equal(vm.evaluate('WoWAIStrip.shown'), 'false', 'strip cleared once nothing is pending');

  // The bridge's default folder arrived with the slot and is what "/wow-ai cd" reports.
  vm.run('SlashCmdList.WOWAI("cd")');
  assert.equal(vm.evaluate('WoWAIDB.chats[1].cwd'), '');
  assert.ok(vm.evaluate('WoWAIDB.chats[1].history[#WoWAIDB.chats[1].history].text').includes('C:\\proj'));
});

test('a denied reply shows Allow, and Allow resends with the rules as flags', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  vm.run('WoWAI.Send("search for it")');
  const chatId = vm.evaluate('WoWAIDB.chats[1].id');
  const id = vm.num('WoWAIDB.chats[1].pendingId');
  nextSlot(vm, `{ now = time(), cwd = "", replies = { { chat = "${chatId}", id = ${id}, status = "done", text = "need permission", denied = { "WebSearch", "Bash(cargo:*)" } } } }`);
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('WoWAIDB.chats[1].history[#WoWAIDB.chats[1].history].denied[2]'), 'Bash(cargo:*)');
  vm.run(`WoWAI.Allow("${chatId}", { "WebSearch", "Bash(cargo:*)" })`);
  const rec = stripRecords(vm).find(r => r.flags.includes('allow='));
  assert.ok(rec, 'allow record on the strip');
  assert.equal(rec.flags, 'allow=WebSearch,Bash(cargo:*)');
  assert.equal(rec.id, id + 1);
});

test('a chat can pick its agent: the strip says so, replies are labelled by their writer, unknown names are refused', () => {
  const vm = newVM();
  login(vm);
  // The hello slot carries the bridge's default agent and the ones it knows.
  vm.run('STUB.RunTimers()');
  const slot = replies => `{ now = time(), cwd = "", agent = "claude", agents = { "claude", "codex", "grok" }, replies = { ${replies || ''} } }`;
  nextSlot(vm, slot());
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('WoWAI.IsConnected()'), 'true');
  const texts = () => vm.evaluate('table.concat(STUB.texts, "|")');
  assert.ok(texts().includes('agent: Claude (bridge default)'), 'the cwd line names the bridge default');
  // Without an agent of its own the chat sends no agent flag, and the reply is labelled Claude.
  vm.run('WoWAI.Send("hello")');
  const chatId = vm.evaluate('WoWAIDB.chats[1].id');
  let rec = stripRecords(vm).find(r => r.text === 'hello');
  assert.equal(rec.flags, '');
  assert.equal(vm.evaluate('WoWAIDB.outbox.agent'), null);
  const id = vm.num('WoWAIDB.chats[1].pendingId');
  nextSlot(vm, slot(`{ chat = "${chatId}", id = ${id}, status = "done", text = "hi", agent = "claude" }`));
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('WoWAIDB.chats[1].history[#WoWAIDB.chats[1].history].role'), 'assistant');
  assert.equal(vm.evaluate('WoWAIDB.chats[1].history[#WoWAIDB.chats[1].history].agent'), 'claude');
  assert.ok(vm.evaluate('table.concat(STUB.prints, "\\n")').includes('[Claude · '), 'the game chat echo names the agent');
  // Switch this chat to Codex: the next message carries agent=codex, on both transports.
  vm.run('SlashCmdList.WOWAI("agent Codex")');
  assert.equal(vm.evaluate('WoWAIDB.chats[1].agent'), 'codex');
  assert.ok(vm.evaluate('WoWAIDB.chats[1].history[#WoWAIDB.chats[1].history].text').includes('agent set to Codex'));
  vm.run('WoWAI.Send("now with codex")');
  rec = stripRecords(vm).find(r => r.text === 'now with codex');
  assert.equal(rec.flags, 'agent=codex');
  assert.equal(vm.evaluate('WoWAIDB.outbox.agent'), 'codex');
  assert.ok(texts().includes('agent: Codex   mode: pixel'));
  const id2 = vm.num('WoWAIDB.chats[1].pendingId');
  nextSlot(vm, slot(`{ chat = "${chatId}", id = ${id2}, status = "done", text = "codex here", agent = "codex" }`));
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('WoWAIDB.chats[1].history[#WoWAIDB.chats[1].history].agent'), 'codex');
  assert.ok(vm.evaluate('table.concat(STUB.prints, "\\n")').includes('[Codex · '));
  // Resend keeps the agent flag.
  vm.run('WoWAI.Send("again")');
  vm.run('WoWAI.Resend()');
  assert.equal(stripRecords(vm).find(r => r.text === 'again').flags, 'agent=codex');
  vm.run('SlashCmdList.WOWAI("cancel")');
  // A name the bridge did not list is refused; "default" goes back to the bridge's.
  vm.run('SlashCmdList.WOWAI("agent gemini")');
  assert.equal(vm.evaluate('WoWAIDB.chats[1].agent'), 'codex');
  assert.ok(vm.evaluate('WoWAIDB.chats[1].history[#WoWAIDB.chats[1].history].text').includes('Unknown agent "gemini"'));
  vm.run('SlashCmdList.WOWAI("agent default")');
  assert.equal(vm.evaluate('WoWAIDB.chats[1].agent'), '');
  assert.ok(vm.evaluate('WoWAIDB.chats[1].history[#WoWAIDB.chats[1].history].text').includes('agent reset to the bridge\'s default: Claude'));
  // The Agent... menu item opens a prompt prefilled with the chat's agent.
  vm.run('WoWAI.SetAgent("grok"); WoWAI.AgentPrompt()');
  assert.equal(vm.evaluate('STUB.popup.which'), 'WOWAI_AGENT');
  assert.equal(vm.evaluate('STUB.popup.data.agent'), 'grok');
  vm.run(`
    local dialog = { editBox = { GetText = function() return " codex " end } }
    StaticPopupDialogs.WOWAI_AGENT.OnAccept(dialog, STUB.popup.data)`);
  assert.equal(vm.evaluate('WoWAIDB.chats[1].agent'), 'codex');
  // A new chat inherits the agent, like the folder.
  vm.run('WoWAI.NewChat("Second")');
  assert.equal(vm.evaluate('WoWAIDB.chats[2].agent'), 'codex');
});

test('replies saved under the old "claude" role are read as assistant replies from Claude', () => {
  const vm = newVM();
  vm.run('WoWAIDB = { chats = { { id = "c1", name = "Old", cwd = "", history = { { role = "user", text = "q", id = 1, t = 1 }, { role = "claude", text = "a", id = 1, t = 2 } }, unread = 0, created = 1 } }, activeChat = "c1", settings = {} }');
  login(vm);
  assert.equal(vm.evaluate('WoWAIDB.chats[1].history[2].role'), 'assistant');
  assert.equal(vm.evaluate('WoWAIDB.chats[1].history[2].agent'), 'claude');
  assert.equal(vm.evaluate('WoWAIDB.chats[1].agent'), '');
  // Before the bridge has said which agent it runs, the label falls back to "AI".
  vm.run('WoWAI.Toggle(true)');
  assert.ok(vm.evaluate('table.concat(STUB.texts, "|")').includes('|Claude|'), 'the old reply is labelled Claude');
});

test('free text that starts with a command word is sent as a message; exact commands still run', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  const sent = text => !!stripRecords(vm).find(r => r.text === text);
  const last = () => vm.evaluate('WoWAIDB.chats[1].history[#WoWAIDB.chats[1].history].text');
  // "delete the unused imports" is a message, not /wow-ai delete; "cancel" alone is the command.
  vm.run('SlashCmdList.WOWAI("delete the unused imports")');
  assert.equal(vm.num('#WoWAIDB.chats'), 1, 'no chat deleted');
  assert.ok(sent('delete the unused imports'));
  vm.run('SlashCmdList.WOWAI("cancel")');
  assert.equal(vm.evaluate('WoWAIDB.chats[1].pendingId'), null, 'cancel ran as a command');
  // "help me with this macro" is a message; "help" alone prints the help.
  vm.run('SlashCmdList.WOWAI("help me with this macro")');
  assert.ok(sent('help me with this macro'));
  vm.run('SlashCmdList.WOWAI("cancel")');
  vm.run('SlashCmdList.WOWAI("help")');
  assert.ok(last().includes('/wow-ai cd'));
  // One-word arguments keep their command; more words make it a message.
  vm.run('SlashCmdList.WOWAI("agent codex")');
  assert.equal(vm.evaluate('WoWAIDB.chats[1].agent'), 'codex');
  vm.run('SlashCmdList.WOWAI("agent smith says hi")');
  assert.equal(vm.evaluate('WoWAIDB.chats[1].agent'), 'codex');
  assert.ok(sent('agent smith says hi'));
  vm.run('SlashCmdList.WOWAI("cancel")');
  // Enumerated arguments: "context off" is the command, "context matters here" a message.
  vm.run('SlashCmdList.WOWAI("context off")');
  assert.equal(vm.evaluate('WoWAIDB.settings.context'), 'false');
  vm.run('SlashCmdList.WOWAI("context matters here")');
  assert.ok(sent('context matters here'));
  vm.run('SlashCmdList.WOWAI("cancel")');
  // "reset the counter" and "clear the cache" are messages; the transcript survives.
  vm.run('SlashCmdList.WOWAI("clear the cache")');
  assert.ok(sent('clear the cache'));
  assert.ok(vm.num('#WoWAIDB.chats[1].history') > 1, 'clear did not run');
  vm.run('SlashCmdList.WOWAI("cancel")');
  vm.run('SlashCmdList.WOWAI("reset the counter")');
  assert.equal(vm.evaluate('WoWAIDB.chats[1].resetNext'), null);
  assert.ok(sent('reset the counter'));
  vm.run('SlashCmdList.WOWAI("cancel")');
  // A chat can still be picked by number or name; "chat with me about it" is a message.
  vm.run('SlashCmdList.WOWAI("new Realms")');
  vm.run('SlashCmdList.WOWAI("chat 1")');
  assert.equal(vm.evaluate('WoWAIDB.activeChat'), vm.evaluate('WoWAIDB.chats[1].id'));
  vm.run('SlashCmdList.WOWAI("chat realms")');
  assert.equal(vm.evaluate('WoWAIDB.activeChat'), vm.evaluate('WoWAIDB.chats[2].id'));
  vm.run('SlashCmdList.WOWAI("chat with me about it")');
  assert.ok(sent('chat with me about it'));
  // /ai alone toggles the window.
  vm.run('WoWAI.Toggle(false); SlashCmdList.WOWAI("")');
  assert.equal(vm.evaluate('WoWAIFrame.shown'), 'true');
});

test('/wow-ai reset marks the next message as a new session', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  vm.run('SlashCmdList.WOWAI("reset")');
  vm.run('WoWAI.Send("start over")');
  const rec = stripRecords(vm).find(r => r.text === 'start over');
  assert.equal(rec.flags, 'n');
  assert.equal(vm.evaluate('WoWAIDB.chats[1].resetNext'), null);
});

test('game chat echo: the summary by default, the first lines without one, the whole reply with "echo full"', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  assert.equal(vm.evaluate('WoWAIDB.settings.echo'), 'summary', 'summary echo is the default');
  const chatId = vm.evaluate('WoWAIDB.chats[1].id');
  const prints = () => vm.evaluate('table.concat(STUB.prints, "\\n")');
  const reply = (text, summary) => {
    vm.run('STUB.prints = {}');
    vm.run('WoWAI.Send("do it")');
    const id = vm.num('WoWAIDB.chats[1].pendingId');
    const sum = summary === undefined ? '' : `, summary = "${summary}"`;
    nextSlot(vm, `{ now = time(), cwd = "", replies = { { chat = "${chatId}", id = ${id}, status = "done", text = "${text}", agent = "claude"${sum} } } }`);
    vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
    assert.equal(vm.evaluate('WoWAIDB.chats[1].pendingId'), null);
  };

  // With a summary only the summary is printed; the window keeps the whole reply.
  reply('Long line one\\nLong line two\\nLong line three\\n\\nTL;DR: Renamed foo.\\nTests pass.', 'Renamed foo.\\nTests pass.');
  let out = prints();
  assert.ok(out.includes('[Claude · ') && out.includes('Renamed foo.') && out.includes('Tests pass.'), 'summary lines printed: ' + out);
  assert.ok(!out.includes('Long line one'), 'the body stays out of the game chat');
  assert.ok(out.includes('[open]'), 'the open link is there');
  assert.ok(vm.evaluate('WoWAIDB.chats[1].history[#WoWAIDB.chats[1].history].text').includes('Long line three'), 'the window has the full reply');

  // Without a summary: the first two lines, then a hint that there is more.
  reply('Line one\\nLine two\\nLine three\\nLine four');
  out = prints();
  assert.ok(out.includes('Line one') && out.includes('Line two'), 'first two lines: ' + out);
  assert.ok(!out.includes('Line three'), 'third line held back');
  assert.ok(out.includes('click [open]'), 'hint to open the window');

  // A short reply without a summary needs no hint.
  reply('Just this');
  out = prints();
  assert.ok(out.includes('Just this') && !out.includes('click [open] to read'), out);

  // "echo full" prints everything, as before.
  vm.run('SlashCmdList.WOWAI("echo full")');
  assert.equal(vm.evaluate('WoWAIDB.settings.echo'), 'full');
  reply('Line one\\nLine two\\nLine three\\n\\nTL;DR: Short.', 'Short.');
  out = prints();
  assert.ok(out.includes('Line one') && out.includes('Line three') && out.includes('TL;DR: Short.'), out);
  vm.run('SlashCmdList.WOWAI("echo summary")');
  assert.equal(vm.evaluate('WoWAIDB.settings.echo'), 'summary');
  vm.run('SlashCmdList.WOWAI("echo bogus")');
  assert.equal(vm.evaluate('WoWAIDB.settings.echo'), 'summary', 'an unknown mode is ignored');

  // An install that still had the old default saved moves to summary once; a mode picked on purpose stays.
  const vm2 = newVM();
  vm2.run('WoWAIDB = { settings = { echo = "full" } }');
  login(vm2);
  assert.equal(vm2.evaluate('WoWAIDB.settings.echo'), 'summary');
  const vm3 = newVM();
  vm3.run('WoWAIDB = { settings = { echo = "short" } }');
  login(vm3);
  assert.equal(vm3.evaluate('WoWAIDB.settings.echo'), 'short');
  const vm4 = newVM();
  vm4.run('WoWAIDB = { settings = { echo = "full", echoV2 = true } }');
  login(vm4);
  assert.equal(vm4.evaluate('WoWAIDB.settings.echo'), 'full');
});

test('a restore bundle addressed to this session adds the missing chats once', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  vm.run('WoWAI.Send("hi")');
  const chatId = vm.evaluate('WoWAIDB.chats[1].id');
  const id = vm.num('WoWAIDB.chats[1].pendingId');
  const token = vm.evaluate('WoWAIDB.session');
  const bundle = `restore = { token = "${token}", chats = { { id = "old1", name = "Old work", cwd = "C:\\\\old", messages = { { role = "user", id = 1, t = 1, text = "q" }, { role = "claude", id = 1, t = 2, text = "a" } } } } }`;
  nextSlot(vm, `{ now = time(), cwd = "", replies = { { chat = "${chatId}", id = ${id}, status = "done", text = "ok" } }, ${bundle} }`);
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.num('#WoWAIDB.chats'), 2);
  assert.equal(vm.evaluate('WoWAIDB.chats[1].id'), 'old1');
  assert.equal(vm.num('#WoWAIDB.chats[1].history'), 2);
  // An older bridge's transcript says "claude"; it is read as an assistant reply from Claude.
  assert.equal(vm.evaluate('WoWAIDB.chats[1].history[2].role'), 'assistant');
  assert.equal(vm.evaluate('WoWAIDB.chats[1].history[2].agent'), 'claude');
  assert.equal(vm.evaluate('WoWAIDB.restored'), 'true');
  // A second bundle with the same token is ignored.
  vm.run('WoWAI.Send("again")');
  const id2 = vm.num('WoWAIDB.chats[2].pendingId');
  nextSlot(vm, `{ now = time(), cwd = "", replies = { { chat = "${chatId}", id = ${id2}, status = "done", text = "ok" } }, ${bundle.replace('old1', 'old2')} }`);
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.num('#WoWAIDB.chats'), 2);
});

test('chat management commands: new, chat, rename, delete, clear, copy', () => {
  const vm = newVM();
  login(vm);
  vm.run('SlashCmdList.WOWAI("new Realms")');
  assert.equal(vm.num('#WoWAIDB.chats'), 2);
  assert.equal(vm.evaluate('WoWAIDB.chats[2].name'), 'Realms');
  assert.equal(vm.evaluate('WoWAIDB.activeChat'), vm.evaluate('WoWAIDB.chats[2].id'));
  vm.run('SlashCmdList.WOWAI("chat 1")');
  assert.equal(vm.evaluate('WoWAIDB.activeChat'), vm.evaluate('WoWAIDB.chats[1].id'));
  vm.run('SlashCmdList.WOWAI("rename Stuff")');
  assert.equal(vm.evaluate('WoWAIDB.chats[1].name'), 'Stuff');
  vm.run('SlashCmdList.WOWAI("help")');
  assert.ok(vm.evaluate('WoWAIDB.chats[1].history[1].text').includes('/wow-ai cd'));
  vm.run('SlashCmdList.WOWAI("clear")');
  assert.equal(vm.num('#WoWAIDB.chats[1].history'), 0);
  vm.run('SlashCmdList.WOWAI("delete")');
  assert.equal(vm.num('#WoWAIDB.chats'), 1);
  assert.equal(vm.evaluate('WoWAIDB.chats[1].name'), 'Realms');
  // The copy box builds with a proper backdrop (the stub fails on SetBackdrop(nil)).
  vm.run('WoWAI.ShowCopy("some reply")');
  assert.equal(vm.evaluate('WoWAICopy.shown'), 'true');
  assert.equal(vm.evaluate('WoWAICopyBox.text'), 'some reply');
});

test('chat rows: right-click opens a menu that renames or sets the folder of that chat, the trash can asks before deleting', () => {
  const vm = newVM();
  login(vm);
  vm.run('SlashCmdList.WOWAI("new Realms")');
  const first = vm.evaluate('WoWAIDB.chats[1].id');
  const second = vm.evaluate('WoWAIDB.chats[2].id');
  assert.equal(vm.evaluate('WoWAIDB.activeChat'), second);
  // The menu opens for the row's chat, not the active one, and toggles closed on a second open.
  vm.run(`WoWAI.ShowChatMenu("${first}", WoWAIFrame)`);
  assert.equal(vm.evaluate('WoWAIChatMenu.shown'), 'true');
  assert.equal(vm.evaluate('WoWAIChatMenu.chatId'), first);
  assert.equal(vm.evaluate('WoWAIChatMenu.title.text'), 'Chat 1');
  vm.run(`WoWAI.ShowChatMenu("${first}", WoWAIFrame)`);
  assert.equal(vm.evaluate('WoWAIChatMenu.shown'), 'false');
  // Rename and Folder prompts target the chat they were opened for.
  vm.run(`WoWAI.RenamePrompt("${first}")`);
  assert.equal(vm.evaluate('STUB.popup.which'), 'WOWAI_RENAME');
  assert.equal(vm.evaluate('STUB.popup.data.id'), first);
  vm.run(`
    local dialog = { editBox = { GetText = function() return "Old stuff" end } }
    StaticPopupDialogs.WOWAI_RENAME.OnAccept(dialog, STUB.popup.data)`);
  assert.equal(vm.evaluate('WoWAIDB.chats[1].name'), 'Old stuff');
  assert.equal(vm.evaluate('WoWAIDB.chats[2].name'), 'Realms');
  vm.run(`WoWAI.FolderPrompt("${first}")`);
  assert.equal(vm.evaluate('STUB.popup.which'), 'WOWAI_FOLDER');
  assert.equal(vm.evaluate('STUB.popup.data.id'), first);
  // The X asks first: nothing happens until OK, then only that chat goes and the active one stays.
  vm.run(`WoWAI.ConfirmDelete("${first}")`);
  assert.equal(vm.evaluate('STUB.popup.which'), 'WOWAI_DELETE');
  assert.equal(vm.num('#WoWAIDB.chats'), 2);
  vm.run('StaticPopupDialogs.WOWAI_DELETE.OnAccept({}, STUB.popup.data)');
  assert.equal(vm.num('#WoWAIDB.chats'), 1);
  assert.equal(vm.evaluate('WoWAIDB.chats[1].id'), second);
  assert.equal(vm.evaluate('WoWAIDB.activeChat'), second);
  // Deleting the last chat clears it instead of removing it.
  vm.run(`WoWAI.ConfirmDelete("${second}")`);
  vm.run('StaticPopupDialogs.WOWAI_DELETE.OnAccept({}, STUB.popup.data)');
  assert.equal(vm.num('#WoWAIDB.chats'), 1);
  assert.equal(vm.evaluate('WoWAIDB.chats[1].name'), 'Chat 1');
});

test('minimize collapses to the mini bar and back; the mini bar X hides everything', () => {
  const vm = newVM();
  login(vm);
  vm.run('WoWAI.Toggle(true)');
  assert.equal(vm.evaluate('WoWAIFrame.shown'), 'true');
  vm.run('WoWAI.Minimize(true)');
  assert.equal(vm.evaluate('WoWAIFrame.shown'), 'false');
  assert.equal(vm.evaluate('WoWAIMini.shown'), 'true');
  assert.equal(vm.evaluate('WoWAIDB.settings.minimized'), 'true');
  vm.run('WoWAI.Minimize(false)');
  assert.equal(vm.evaluate('WoWAIFrame.shown'), 'true');
  assert.equal(vm.evaluate('WoWAIMini.shown'), 'false');
  vm.run('WoWAI.Toggle(false)');
  assert.equal(vm.evaluate('WoWAIFrame.shown'), 'false');
  assert.equal(vm.evaluate('WoWAIMini.shown'), 'false');
  assert.equal(vm.evaluate('WoWAIDB.settings.shown'), 'false');
});

test('reload mode writes the outbox for the bridge instead of drawing the strip', () => {
  const vm = newVM();
  login(vm);
  vm.run('SlashCmdList.WOWAI("mode reload")');
  vm.run('SlashCmdList.WOWAI("reset")');
  vm.run('WoWAI.Send("via reload", { "WebSearch", "Bash(git:*)" })');
  assert.equal(vm.evaluate('STUB.reloaded'), 'true');
  assert.equal(vm.evaluate('WoWAIDB.outbox.newSession'), 'true');
  assert.equal(vm.evaluate('WoWAIDB.outbox.text'), Buffer.from('via reload').toString('hex'));
  assert.equal(Buffer.from(vm.evaluate('WoWAIDB.outbox.allow'), 'hex').toString('utf8'), 'WebSearch\x1fBash(git:*)');
  assert.equal(decodeStrip(vm), null);
});

// The screenshot transport: the bridge's slot says `transport = "screenshot"`,
// and from then on the strip is only up for the frames around a Screenshot()
// call. Drives the strip's OnUpdate by hand (the stub renders nothing).
function frames(vm, n) {
  for (let i = 0; i < n; i++) vm.run('local f = WoWAIStrip; if f.shown and f.scripts.OnUpdate then f.scripts.OnUpdate(f, 0.016) end');
}

test('screenshot transport: the strip is shot once per message, hidden on the event, and the format CVar is restored', () => {
  const vm = newVM();
  vm.run('STUB.sounds["Interface\\\\AddOns\\\\WoWAI\\\\ctl\\\\valid.wav"] = true'); // the sound channel works: acks arrive as files
  login(vm);
  vm.run('STUB.RunTimers()'); // SayHello: not knowing better, the hello goes up pixel-style
  assert.equal(vm.evaluate('WoWAIStrip.shown'), 'true');
  assert.equal(vm.num('STUB.screenshots'), 0);
  // The hello poll reads a slot from a screenshot-mode bridge.
  nextSlot(vm, '{ now = time(), cwd = "", transport = "screenshot", replies = {} }');
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('WoWAIDB.settings.transport'), 'screenshot', 'remembered for the next login');
  assert.equal(vm.evaluate('STUB.cvars.screenshotFormat'), 'png', 'lossless format while the mode is on');
  assert.equal(vm.evaluate('WoWAIDB.settings.shotFormatSaved'), 'jpeg', 'the player\'s own format is kept');
  // The unacknowledged hello is shot now: strip up, two frames, Screenshot().
  assert.equal(vm.evaluate('WoWAIStrip.shown'), 'true');
  frames(vm, 1);
  assert.equal(vm.num('STUB.screenshots'), 0, 'not before the strip had a frame to render');
  frames(vm, 1);
  assert.equal(vm.num('STUB.screenshots'), 1);
  assert.equal(vm.evaluate('WoWAIStrip.shown'), 'true', 'still up until the client confirms');
  assert.equal(stripRecords(vm)[0].flags, 'h;c');
  vm.run('STUB.FireEvent("SCREENSHOT_SUCCEEDED")');
  assert.equal(vm.evaluate('WoWAIStrip.shown'), 'false', 'hidden as soon as the shot is confirmed');
  assert.equal(vm.evaluate('WoWAIStrip.scripts.OnUpdate'), null, 'no OnUpdate left running');
  // A message: one more shot, carrying the hello (still unacked) and the message.
  vm.run('WoWAI.Send("hello world")');
  assert.equal(vm.evaluate('WoWAIStrip.shown'), 'true');
  frames(vm, 2);
  assert.equal(vm.num('STUB.screenshots'), 2);
  const recs = stripRecords(vm);
  assert.ok(recs.find(r => r.text === 'hello world'));
  assert.ok(recs.find(r => r.flags === 'h;c'));
  vm.run('STUB.FireEvent("SCREENSHOT_SUCCEEDED")');
  assert.equal(vm.evaluate('WoWAIStrip.shown'), 'false');
  // Ticks without news take no more screenshots; an ack changes nothing on screen either.
  vm.run('STUB.now = STUB.now + 2; STUB.Tick(); STUB.now = STUB.now + 2; STUB.Tick()');
  frames(vm, 3);
  assert.equal(vm.num('STUB.screenshots'), 2);
  assert.equal(vm.evaluate('WoWAIStrip.shown'), 'false');
  const id = vm.num('WoWAIDB.chats[1].pendingId');
  vm.run(`STUB.sounds["Interface\\\\AddOns\\\\WoWAI\\\\ack\\\\${String(id).padStart(3, '0')}.wav"] = true; STUB.now = STUB.now + 2; STUB.Tick()`);
  frames(vm, 3);
  assert.equal(vm.num('STUB.screenshots'), 2);
  assert.equal(vm.evaluate('WoWAIStrip.shown'), 'false');
  // A player's own screenshot event with nothing in flight is ignored.
  vm.run('STUB.FireEvent("SCREENSHOT_SUCCEEDED")');
  assert.equal(vm.num('STUB.screenshots'), 2);
  // A second chat's message that the bridge never acks: the 40 s retry shoots it
  // again (the hello has expired by then and is not on that strip).
  vm.run('WoWAI.NewChat("Two"); WoWAI.Send("lost one")');
  frames(vm, 2);
  assert.equal(vm.num('STUB.screenshots'), 3);
  vm.run('STUB.FireEvent("SCREENSHOT_SUCCEEDED")');
  vm.run('STUB.now = STUB.now + 41; STUB.Tick()');
  assert.equal(vm.evaluate('WoWAIStrip.shown'), 'true', 'retry puts the strip up again');
  frames(vm, 2);
  assert.equal(vm.num('STUB.screenshots'), 4);
  assert.deepEqual(stripRecords(vm).map(r => r.text), ['lost one']);
  vm.run('STUB.FireEvent("SCREENSHOT_SUCCEEDED")');
  // The status line says which transport is in use; diag counts the shots.
  vm.run('STUB.texts = {}; WoWAI.UpdateStatus()');
  assert.ok(vm.evaluate('table.concat(STUB.texts, "|")').includes('mode: pixel (screenshot)'));
  vm.run('SlashCmdList.WOWAI("diag")');
  const diag = vm.evaluate('WoWAIDB.chats[2].history[#WoWAIDB.chats[2].history].text');
  assert.ok(diag.includes('transport: screenshot, screenshots: 4 taken, 4 confirmed, 0 failed, 0 without event'), diag);
  // Back to a pixel-mode bridge: the CVar goes back and the strip stays up pixel-style.
  nextSlot(vm, '{ now = time(), cwd = "", transport = "pixel", replies = {} }');
  vm.run('WoWAI.Connect(); STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('WoWAIDB.settings.transport'), 'pixel');
  assert.equal(vm.evaluate('STUB.cvars.screenshotFormat'), 'jpeg', 'restored');
  assert.equal(vm.evaluate('WoWAIDB.settings.shotFormatSaved'), null);
  assert.equal(vm.evaluate('WoWAIStrip.shown'), 'true', 'pixel mode: the strip stays up until acked');
  frames(vm, 3);
  assert.equal(vm.num('STUB.screenshots'), 4, 'no screenshots in pixel mode');
});

test('screenshot transport: a failed shot is retried a few times, a missing event times out, logout restores the CVar', () => {
  const vm = newVM();
  login(vm);
  vm.run('STUB.RunTimers()'); // SayHello
  nextSlot(vm, '{ now = time(), cwd = "", transport = "screenshot", replies = {} }');
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()'); // the hello poll learns the transport
  assert.equal(vm.evaluate('WoWAI.IsConnected()'), 'true');
  frames(vm, 2); // the hello's shot
  vm.run('STUB.FireEvent("SCREENSHOT_SUCCEEDED")');
  assert.equal(vm.num('STUB.screenshots'), 1);
  vm.run('WoWAI.Send("try me")');
  frames(vm, 2);
  assert.equal(vm.num('STUB.screenshots'), 2);
  vm.run('STUB.FireEvent("SCREENSHOT_FAILED")');
  assert.equal(vm.evaluate('WoWAIStrip.shown'), 'true', 'a failure puts it straight up again');
  frames(vm, 2);
  assert.equal(vm.num('STUB.screenshots'), 3);
  vm.run('STUB.FireEvent("SCREENSHOT_FAILED")');
  frames(vm, 2);
  assert.equal(vm.num('STUB.screenshots'), 4);
  vm.run('STUB.FireEvent("SCREENSHOT_FAILED")');
  assert.equal(vm.evaluate('WoWAIStrip.shown'), 'false', 'after SHOT_RETRIES failures it waits for the normal retry');
  frames(vm, 2);
  assert.equal(vm.num('STUB.screenshots'), 4);
  // No event at all: the timeout hides the strip and counts it.
  vm.run('STUB.timers = {}; WoWAI.NewChat("Two"); WoWAI.Send("quiet")');
  frames(vm, 2);
  assert.equal(vm.num('STUB.screenshots'), 5);
  assert.equal(vm.evaluate('WoWAIStrip.shown'), 'true');
  vm.run('STUB.RunTimers()'); // the SHOT_TIMEOUT timer
  assert.equal(vm.evaluate('WoWAIStrip.shown'), 'false');
  vm.run('SlashCmdList.WOWAI("diag")');
  const diag = vm.evaluate('WoWAIDB.chats[2].history[#WoWAIDB.chats[2].history].text');
  assert.ok(diag.includes('5 taken, 1 confirmed, 3 failed, 1 without event'), diag);
  // Logging out restores the format; the mode itself is remembered.
  assert.equal(vm.evaluate('STUB.cvars.screenshotFormat'), 'png');
  vm.run('STUB.FireEvent("PLAYER_LOGOUT")');
  assert.equal(vm.evaluate('STUB.cvars.screenshotFormat'), 'jpeg');
  assert.equal(vm.evaluate('WoWAIDB.settings.transport'), 'screenshot');
});

test('screenshot transport: a remembered mode shoots the login hello, and a /reload never loses the saved format', () => {
  const vm = newVM();
  // Saved data from a previous session that ended mid-mode (a /reload): the
  // CVar is already png and the original is on record.
  vm.run('WoWAIDB = { settings = { transport = "screenshot", shotFormatSaved = "tga" } }; STUB.cvars.screenshotFormat = "png"');
  login(vm);
  assert.equal(vm.evaluate('WoWAIDB.settings.shotFormatSaved'), 'tga', 'the original is not overwritten with our own png');
  vm.run('STUB.RunTimers()'); // SayHello
  assert.equal(vm.evaluate('WoWAIStrip.shown'), 'true');
  frames(vm, 2);
  assert.equal(vm.num('STUB.screenshots'), 1, 'the hello is shot without waiting for a slot');
  vm.run('STUB.FireEvent("SCREENSHOT_SUCCEEDED")');
  assert.equal(vm.evaluate('WoWAIStrip.shown'), 'false');
  // Switching to the reload transport in game gives the CVar back too.
  vm.run('SlashCmdList.WOWAI("mode reload")');
  assert.equal(vm.evaluate('STUB.cvars.screenshotFormat'), 'tga');
  assert.equal(vm.evaluate('WoWAIDB.settings.shotFormatSaved'), null);
  vm.run('SlashCmdList.WOWAI("mode pixel")');
  assert.equal(vm.evaluate('STUB.cvars.screenshotFormat'), 'png');
  assert.equal(vm.evaluate('WoWAIDB.settings.shotFormatSaved'), 'tga');
});

// Strip colour levels, in 0..255 per channel, of every shown cell on the strip.
function stripLevels(vm) {
  vm.run(`local seen = {}
    for _, t in ipairs(WoWAIStrip.textures) do
      if t.shown and t.color then for k = 1, 3 do seen[math.floor(t.color[k] * 255 + 0.5)] = true end end
    end
    local out = {}
    for lv in pairs(seen) do out[#out + 1] = lv end
    table.sort(out)
    RESULT = table.concat(out, ",")`);
  return vm.evaluate('RESULT').split(',').filter(Boolean).map(Number);
}

test('screenshot transport: the strip is drawn at the levels the bridge asked for, and bright again in pixel mode', () => {
  const vm = newVM();
  login(vm);
  vm.run('STUB.RunTimers()'); // SayHello, pixel-style: full primaries
  assert.deepEqual(stripLevels(vm), [0, 255]);
  nextSlot(vm, '{ now = time(), cwd = "", transport = "screenshot", strip = { on = 60, off = 0 }, replies = {} }');
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('WoWAIDB.settings.stripLevels.on'), '60');
  assert.equal(vm.evaluate('WoWAIStrip.shown'), 'true', 'the hello is being shot');
  assert.deepEqual(stripLevels(vm), [0, 60], 'dark levels: the strip is drawn at 0 and 60 of 255');
  // Reads back at the bridge's threshold (31), not at the pixel transport's (128).
  assert.equal(stripRecords(vm, 31 / 255)[0].flags, 'h;c');
  frames(vm, 2);
  vm.run('STUB.FireEvent("SCREENSHOT_SUCCEEDED")');
  // The bridge changes its levels: the next strip follows without a transport change.
  nextSlot(vm, '{ now = time(), cwd = "", transport = "screenshot", strip = { on = 90, off = 10 }, replies = {} }');
  vm.run('WoWAI.Connect(); STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('WoWAIDB.settings.stripLevels.on'), '90');
  vm.run('WoWAI.Send("dark one")');
  assert.deepEqual(stripLevels(vm), [10, 90]);
  assert.ok(stripRecords(vm, 51 / 255).find(r => r.text === 'dark one'));
  frames(vm, 2);
  vm.run('STUB.FireEvent("SCREENSHOT_SUCCEEDED")');
  // Unusable levels are ignored (bright), never trusted.
  nextSlot(vm, '{ now = time(), cwd = "", transport = "screenshot", strip = { on = 5, off = 0 }, replies = {} }');
  vm.run('WoWAI.Connect(); STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('WoWAIDB.settings.stripLevels'), null);
  assert.deepEqual(stripLevels(vm), [0, 255]);
  vm.run('STUB.FireEvent("SCREENSHOT_SUCCEEDED")');
  // Back on a pixel-mode bridge the strip is bright whatever levels were remembered.
  nextSlot(vm, '{ now = time(), cwd = "", transport = "pixel", replies = {} }');
  vm.run('WoWAI.Connect(); STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('WoWAIStrip.shown'), 'true');
  assert.deepEqual(stripLevels(vm), [0, 255]);
});

// Vision: a "v" flag on the record asks the bridge to attach the screenshot's
// game view to the run. Off by default; on per chat, or once with /wow-ai look.
test('vision: off by default; "vision on" flags every send and resend with v, "look" flags one message, footer and diag show it', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  const chatId = vm.evaluate('WoWAIDB.chats[1].id');
  const flagsOf = (text) => (stripRecords(vm).find(r => r.text === text) || {}).flags;
  const reply = (text) => {
    const id = vm.num('WoWAIDB.chats[1].pendingId');
    nextSlot(vm, `{ now = time(), cwd = "", replies = { { chat = "${chatId}", id = ${id}, status = "done", text = "${text}", agent = "claude" } } }`);
    vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
    assert.equal(vm.evaluate('WoWAIDB.chats[1].pendingId'), null);
  };
  assert.equal(vm.evaluate('WoWAIDB.settings.vision'), 'false', 'off by default');
  vm.run('WoWAI.Send("plain")');
  assert.equal(flagsOf('plain'), '', 'no flag while off');
  reply('ok');
  // The footer says so, and so does diag.
  vm.run('STUB.texts = {}; WoWAI.UpdateStatus()');
  assert.ok(vm.evaluate('table.concat(STUB.texts, "|")').includes('mode: pixel   vision: off'));
  vm.run('SlashCmdList.WOWAI("diag")');
  assert.ok(vm.evaluate('WoWAIDB.chats[1].history[#WoWAIDB.chats[1].history].text').includes('\nvision: off'));

  // "look" sends that one message with the flag; the setting stays off.
  vm.run('SlashCmdList.WOWAI("look what is this item?")');
  assert.equal(flagsOf('what is this item?'), 'v');
  assert.equal(vm.evaluate('WoWAIDB.settings.vision'), 'false');
  reply('a sword');
  vm.run('SlashCmdList.WOWAI("look")');
  assert.equal(flagsOf('What do you see on my screen?'), 'v', 'a bare look asks the obvious question');
  reply('grass');
  // "look at my gear" is the command too (the whole line is the question).
  vm.run('SlashCmdList.WOWAI("look at my gear")');
  assert.equal(flagsOf('at my gear'), 'v');
  reply('fine');

  // On: every send carries it, next to the other flags, and a resend keeps it.
  vm.run('SlashCmdList.WOWAI("vision on")');
  assert.equal(vm.evaluate('WoWAIDB.settings.vision'), 'true');
  let note = vm.evaluate('WoWAIDB.chats[1].history[#WoWAIDB.chats[1].history].text');
  assert.ok(note.includes('Vision is ON, but the bridge listens on the pixel transport'), 'told it needs the screenshot transport: ' + note);
  vm.run('STUB.texts = {}; WoWAI.UpdateStatus()');
  assert.ok(vm.evaluate('table.concat(STUB.texts, "|")').includes('mode: pixel   vision: on'));
  vm.run('SlashCmdList.WOWAI("agent codex")');
  vm.run('WoWAI.Send("with the picture")');
  assert.equal(flagsOf('with the picture'), 'agent=codex;v');
  vm.run('WoWAI.Resend()');
  assert.equal(flagsOf('with the picture'), 'agent=codex;v', 'a resend asks again (it is a fresh screenshot)');
  reply('seen');
  vm.run('SlashCmdList.WOWAI("agent default")');
  vm.run('SlashCmdList.WOWAI("diag")');
  assert.ok(vm.evaluate('WoWAIDB.chats[1].history[#WoWAIDB.chats[1].history].text').includes('\nvision: on (needs the screenshot transport'));
  // On a screenshot-mode bridge the status is the happy one.
  nextSlot(vm, '{ now = time(), cwd = "", transport = "screenshot", replies = {} }');
  vm.run('WoWAI.Connect(); STUB.now = STUB.now + 6; STUB.Tick()');
  vm.run('SlashCmdList.WOWAI("vision")');
  note = vm.evaluate('WoWAIDB.chats[1].history[#WoWAIDB.chats[1].history].text');
  assert.ok(note.startsWith('Vision is ON: each message goes out with a picture of your screen'), note);
  vm.run('WoWAI.Send("dark one")');
  assert.equal(flagsOf('dark one'), 'v');
  vm.run('STUB.FireEvent("SCREENSHOT_SUCCEEDED")');
  reply('yes');
  // Off again: no flag, and the setting survives a reload (it is in the saved data).
  vm.run('SlashCmdList.WOWAI("vision off")');
  assert.equal(vm.evaluate('WoWAIDB.settings.vision'), 'false');
  vm.run('WoWAI.Send("no picture")');
  assert.equal(flagsOf('no picture'), '');
  vm.run('STUB.FireEvent("SCREENSHOT_SUCCEEDED")');
});

// Whisper tabs: the chat dock stubbed just enough. FCF_OpenTemporaryWindow makes
// ChatFrame11, 12, ... with a tab, a glow and an edit box whose own Enter, SendText
// and SendMessage are the game's send (STUB.serverSends counts what would have
// reached the server). ChatFrame1EditBox is the ordinary chat box.
const WHISPER_DOCK = `
  CHAT_FRAMES = { "ChatFrame1" }
  ChatTypeInfo = { WHISPER = { r = 1, g = 0.5, b = 1 }, WHISPER_INFORM = { r = 1, g = 0.5, b = 1 }, SYSTEM = { r = 1, g = 1, b = 0 } }
  CHAT_WHISPER_GET = "%s whispers: "
  CHAT_WHISPER_INFORM_GET = "To %s: "
  STUB.serverSends, STUB.flashed, STUB.tempWindows, STUB.filters = 0, {}, 0, {}
  function ChatFrame_AddMessageEventFilter(ev, fn) STUB.filters[ev] = fn end
  function FCF_StartAlertFlash(f) table.insert(STUB.flashed, f:GetName()) end
  function FCF_SetWindowName(f, name) _G[f:GetName() .. "Tab"].text = name end
  function FCF_Close(f) f.inUse = false; f.isDocked = false; f.shown = false end
  local function GameSend(self) STUB.serverSends = STUB.serverSends + 1; self.text = "" end
  local function MakeBox(name, frame)
    local eb = CreateFrame("EditBox", name, frame)
    eb.chatFrame = frame
    eb.attrs = { chatType = "SAY" }
    eb.scripts.OnEnterPressed = GameSend
    eb.SendText, eb.SendMessage = GameSend, GameSend
    return eb
  end
  ChatFrame1 = CreateFrame("Frame", "ChatFrame1", UIParent)
  ChatFrame1.isDocked = true
  ChatFrame1.editBox = MakeBox("ChatFrame1EditBox", ChatFrame1)
  DEFAULT_CHAT_FRAME = ChatFrame1
  function FCF_OpenTemporaryWindow(chatType, target, source, select)
    STUB.tempWindows = STUB.tempWindows + 1
    local n = 10 + STUB.tempWindows
    local f = CreateFrame("Frame", "ChatFrame" .. n, UIParent)
    f.isTemporary, f.inUse, f.isDocked, f.shown = true, true, true, select and true or false
    f.chatType, f.chatTarget = chatType, target
    local tab = CreateFrame("Button", "ChatFrame" .. n .. "Tab", f)
    tab.text = target
    tab.glow = CreateFrame("Frame", nil, tab)
    f.editBox = MakeBox("ChatFrame" .. n .. "EditBox", f)
    f.editBox.attrs = { chatType = "WHISPER", tellTarget = target }
    table.insert(CHAT_FRAMES, f:GetName())
    return f
  end`;

test('whisper tabs: off by default; on, each chat is a tab, Enter there goes to the agent and never to the server, replies flash it', () => {
  const vm = newVM();
  vm.run(WHISPER_DOCK);
  login(vm);
  connect(vm);
  const chatId = vm.evaluate('WoWAIDB.chats[1].id');
  const lines = (n) => vm.evaluate(`(function() local t = {} for _, m in ipairs(ChatFrame${n}.messages or {}) do t[#t + 1] = m.text .. " @" .. m.r .. "," .. m.g .. "," .. m.b end return table.concat(t, "\\n") end)()`) || '';
  const enter = (box, text) => vm.run(`${box}:SetText("${text}"); ${box}.scripts.OnEnterPressed(${box})`);
  const reply = (id, body) => {
    const pending = vm.num(`(select(1, (function() for _, c in ipairs(WoWAIDB.chats) do if c.id == "${id}" then return c.pendingId end end end)()))`);
    nextSlot(vm, `{ now = time(), cwd = "", replies = { { chat = "${id}", id = ${pending}, ${body} } } }`);
    // Polls follow a schedule that a manual check (typing while pending) pushes out: tick until the slot is read.
    for (let i = 0; i < 8; i++) vm.run('STUB.now = STUB.now + 10; STUB.Tick()');
  };

  // Off: replies go to the game chat as before, no tab opens.
  assert.equal(vm.evaluate('WoWAIDB.settings.whisper'), 'false', 'off by default');
  vm.run('SlashCmdList.WOWAI("agent claude")');
  vm.run('WoWAI.Send("hello there")');
  reply(chatId, 'status = "done", text = "plain echo", agent = "claude"');
  assert.equal(vm.num('STUB.tempWindows'), 0);
  assert.ok(vm.evaluate('table.concat(STUB.prints, "\\n")').includes('plain echo'));

  // On: the active chat's tab opens, selected, named after the chat.
  vm.run('SlashCmdList.WOWAI("whisper on")');
  assert.equal(vm.evaluate('WoWAIDB.settings.whisper'), 'true');
  assert.equal(vm.num('STUB.tempWindows'), 1);
  assert.equal(vm.evaluate('ChatFrame11Tab.text'), 'Hello there', 'the tab carries the chat name');
  assert.equal(vm.evaluate('ChatFrame11EditBox.attrs.tellTarget'), 'Claude', 'the box whispers the agent');
  assert.equal(vm.evaluate('ChatFrame11.shown'), 'true');

  // Enter in the tab: the text goes to the agent, the game's own send never runs.
  enter('ChatFrame11EditBox', 'from the tab');
  assert.equal(vm.num('STUB.serverSends'), 0, 'nothing reached the server');
  assert.ok(stripRecords(vm).find(r => r.text === 'from the tab'), 'the message went out on the strip');
  assert.equal(vm.evaluate('ChatFrame11EditBox:GetText()'), '', 'the box is emptied');
  let out = lines(11);
  assert.ok(out.includes('To Claude: from the tab @1,0.5,1'), 'echoed as an outgoing whisper: ' + out);
  assert.ok(out.includes('Claude is working on it... @1,1,0'), 'working line in system colour');

  // The bridge's working text shows once per change; the reply is an incoming
  // whisper, line by line, the tab flashes (it is not on screen), General stays quiet.
  vm.run('ChatFrame11.shown = false; STUB.prints = {}');
  reply(chatId, 'status = "working", text = "Reading files"'); // read again on every poll while pending
  assert.equal((lines(11).match(/Claude: Reading files/g) || []).length, 1, 'a progress line once');
  reply(chatId, 'status = "done", text = "hi back\\nsecond line", agent = "claude"');
  out = lines(11);
  assert.ok(out.includes('|Hwowai:reply:' + chatId + '|h[Claude]|h whispers: hi back @1,0.5,1'), 'first line formatted as a whisper: ' + out);
  assert.ok(out.includes('second line @1,0.5,1'), 'the rest follows in whisper colour');
  assert.deepEqual(vm.evaluate('table.concat(STUB.flashed, ",")'), 'ChatFrame11', 'the tab flashed');
  assert.ok(!vm.evaluate('table.concat(STUB.prints, "\\n")').includes('hi back'), 'no duplicate in General');
  assert.equal(vm.evaluate('WoWAIDB.chats[1].history[#WoWAIDB.chats[1].history].text'), 'hi back\nsecond line', 'the window has it too');

  // Typing while the agent works keeps the text as a draft and says so in the tab.
  enter('ChatFrame11EditBox', 'first');
  const before = stripRecords(vm).length;
  enter('ChatFrame11EditBox', 'too soon');
  assert.equal(stripRecords(vm).length, before, 'no second record while one is pending');
  assert.ok(lines(11).includes('still working on your last message'), 'told in the tab');
  assert.equal(vm.evaluate('WoWAIDB.chats[1].draft'), 'too soon');
  reply(chatId, 'status = "done", text = "done", agent = "claude"');

  // A tell to an agent's name from the ordinary box goes to the agent; any other name is the game's.
  enter('ChatFrame1EditBox', '/w Claude ping');
  assert.ok(stripRecords(vm).find(r => r.text === 'ping'), '/w Claude from General reaches the agent');
  assert.equal(vm.num('STUB.serverSends'), 0);
  reply(chatId, 'status = "done", text = "pong", agent = "claude"');
  enter('ChatFrame1EditBox', '/w Bob hi');
  assert.equal(vm.num('STUB.serverSends'), 1, 'a real whisper still goes out');
  enter('ChatFrame11EditBox', '/s hello all');
  assert.equal(vm.num('STUB.serverSends'), 2, 'another slash command in the tab is the game\'s');

  // A second chat gets a tab of its own; a reply to the first still lands in the first.
  vm.run('SlashCmdList.WOWAI("new Second")');
  const secondId = vm.evaluate('WoWAIDB.chats[2].id');
  vm.run('WoWAI.Send("second hello")');
  assert.equal(vm.num('STUB.tempWindows'), 2);
  assert.equal(vm.evaluate('ChatFrame12Tab.text'), 'Second');
  assert.ok(lines(12).includes('To Claude: second hello'));
  reply(secondId, 'status = "done", text = "for two", agent = "claude"');
  assert.ok(lines(12).includes('whispers: for two') && !lines(11).includes('for two'));
  // A system reply (bridge error) is a system line, and a denied one says what to allow.
  vm.run('WoWAI.Send("again")');
  reply(secondId, 'status = "error", text = "boom"');
  assert.ok(lines(12).includes('Bridge error: boom  |Hwowai:open:' + secondId + '|h|cff7ec8ff[open]|r|h @1,1,0'), lines(12));
  vm.run('WoWAI.Send("once more")');
  reply(secondId, 'status = "done", text = "need it", denied = { "Bash(rm:*)" }');
  assert.ok(lines(12).includes('needs permission for Bash(rm:*)'));

  // The leak filter: the server's answer to a whisper that got out becomes a loud line.
  assert.ok(vm.evaluate(`select(2, STUB.filters.CHAT_MSG_SYSTEM(nil, "CHAT_MSG_SYSTEM", "No player named 'Claude' is currently playing."))`).includes('WHISPER LEAK'));
  assert.equal(vm.evaluate(`select(2, STUB.filters.CHAT_MSG_SYSTEM(nil, "CHAT_MSG_SYSTEM", "No player named 'Bob' is currently playing."))`), null, 'other names are left alone');
  vm.run('SlashCmdList.WOWAI("whisper")');
  assert.ok(vm.evaluate('WoWAIDB.chats[2].history[#WoWAIDB.chats[2].history].text').includes('LEAKS: 1'));

  // Rename retitles the tab, delete closes it, off closes them all and the hooks go quiet.
  vm.run('SlashCmdList.WOWAI("rename Renamed")');
  assert.equal(vm.evaluate('ChatFrame12Tab.text'), 'Renamed');
  vm.run('SlashCmdList.WOWAI("delete")');
  assert.equal(vm.evaluate('ChatFrame12.inUse'), 'false', 'the deleted chat\'s tab is closed');
  vm.run('SlashCmdList.WOWAI("whisper off")');
  assert.equal(vm.evaluate('WoWAIDB.settings.whisper'), 'false');
  assert.equal(vm.evaluate('ChatFrame11.inUse'), 'false');
  enter('ChatFrame1EditBox', '/w Claude ping');
  assert.equal(vm.num('STUB.serverSends'), 3, 'off: a whisper is the game\'s again');
});

test('plugins: a fresh install follows the bridge\'s default and sends no flag; chats from before plugins stay bound to claude-code; a new chat inherits; a restore brings the binding', () => {
  // Fresh saved data: chat 1 is bound to nothing, so a message carries no plugin flag
  // and the bridge routes it to its default (ask).
  const vm = newVM();
  login(vm);
  assert.equal(vm.evaluate('WoWAIDB.chats[1].plugin'), '');
  assert.equal(vm.evaluate('WoWAIDB.settings.pluginsV1'), 'true');
  vm.run('STUB.RunTimers()');
  nextSlot(vm, '{ now = time(), cwd = "", plugin = "ask", plugins = { "ask", "claude-code" }, replies = {} }');
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('WoWAI.IsConnected()'), 'true');
  vm.run('WoWAI.Send("what drops the sword")');
  const rec = stripRecords(vm).find(r => r.text === 'what drops the sword');
  assert.equal(rec.flags, '');
  assert.equal(vm.evaluate('WoWAIDB.outbox.plugin'), null);
  // A new chat inherits the binding of the chat it was made from, like the folder and the agent.
  vm.run('WoWAI.NewChat("Second")');
  assert.equal(vm.evaluate('WoWAIDB.chats[2].plugin'), '');
  // A restored chat comes back with the plugin the bridge's transcript names.
  const chatId = vm.evaluate('WoWAIDB.chats[1].id');
  const id = vm.num('WoWAIDB.chats[1].pendingId');
  const token = vm.evaluate('WoWAIDB.session');
  nextSlot(vm, `{ now = time(), cwd = "", replies = { { chat = "${chatId}", id = ${id}, status = "done", text = "ok", plugin = "ask" } }, restore = { token = "${token}", chats = { { id = "old1", name = "Old work", cwd = "", plugin = "claude-code", messages = { { role = "user", id = 1, t = 1, text = "q" } } } } } }`);
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.num('#WoWAIDB.chats'), 3);
  assert.equal(vm.evaluate('(function() for _, ch in ipairs(WoWAIDB.chats) do if ch.id == "old1" then return ch.plugin end end end)()'), 'claude-code');

  // Saved data from before plugins existed: every chat was a coding chat, and
  // says so on the wire from now on; the migration runs once.
  const old = newVM();
  old.run('WoWAIDB = { chats = { { id = "c1", name = "Old", cwd = "realms", history = {}, unread = 0, created = 1 } }, activeChat = "c1", settings = {} }');
  login(old);
  assert.equal(old.evaluate('WoWAIDB.chats[1].plugin'), 'claude-code');
  connect(old);
  old.run('WoWAI.Send("fix the build")');
  const coding = stripRecords(old).find(r => r.text === 'fix the build');
  assert.equal(coding.flags, 'plugin=claude-code');
  assert.equal(coding.cwd, 'realms');
  assert.equal(old.evaluate('WoWAIDB.outbox.plugin'), 'claude-code');
  old.run('WoWAI.Resend()');
  assert.equal(stripRecords(old).find(r => r.text === 'fix the build').flags, 'plugin=claude-code', 'a resend keeps the binding');
  old.run('WoWAI.NewChat("More code")');
  assert.equal(old.evaluate('WoWAIDB.chats[2].plugin'), 'claude-code', 'inherited');
  // A chat unbound later stays unbound after a reload: the migration does not run again.
  old.run('WoWAIDB.chats[2].plugin = ""; STUB.FireEvent("ADDON_LOADED", "WoWAI")');
  assert.equal(old.evaluate('WoWAIDB.chats[2].plugin'), '');
});
