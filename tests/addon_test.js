// Runs the real addon Lua (Codec.lua + ClaudeWoW.lua) in a Lua VM with a stub
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

const ADDON = path.join(__dirname, '..', 'addon', 'ClaudeWoW');
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
  for (const f of ['Codec.lua', 'Inbox.lua', 'ClaudeWoW.lua']) run(fs.readFileSync(path.join(ADDON, f), 'utf8'), 'ClaudeWoW');
  return { run, evaluate, num };
}

// Read the strip the addon drew, exactly like capture.ps1: 3 bits per cell,
// [C7 1A] [id] [len] [payload] [fletcher]. Returns { id, text } or null.
function decodeStrip(vm, threshold = 0.5) {
  if (vm.evaluate('ClaudeWoWStrip and ClaudeWoWStrip.shown') !== 'true') return null;
  vm.run(`
    local parts = {}
    local th = ${threshold}
    for _, t in ipairs(ClaudeWoWStrip.textures) do
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
  vm.run(`STUB.onLoadAddOn = function(name) ClaudeWoW_SlotData = ${luaBody} end`);
}

function login(vm) {
  vm.run('STUB.FireEvent("ADDON_LOADED", "ClaudeWoW")');
  vm.run('STUB.FireEvent("PLAYER_LOGIN")');
}

// Let the bridge answer the login hello: its slot carries a fresh clock, which is
// what makes the addon consider itself connected (Send is gated on that).
function connect(vm) {
  vm.run('STUB.RunTimers()'); // C_Timer.After(3, SayHello)
  nextSlot(vm, '{ now = time(), cwd = "", replies = {} }');
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()'); // hello poll 5 s later
  assert.equal(vm.evaluate('ClaudeWoW.IsConnected()'), 'true', 'connected after the hello slot');
}

test('addon loads, builds its UI and creates a first chat', () => {
  const vm = newVM();
  login(vm);
  assert.equal(vm.num('#ClaudeWoWDB.chats'), 1);
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].name'), 'Chat 1');
  assert.equal(vm.evaluate('ClaudeWoWFrame ~= nil'), 'true');
  assert.equal(vm.evaluate('ClaudeWoWMini ~= nil'), 'true');
  assert.equal(vm.num('#STUB.tickers'), 1);
  assert.equal(vm.evaluate('SlashCmdList.CLAUDEWOW ~= nil'), 'true');
  // Two commands, not two spellings of one: /claude-wow shows the window, /claude
  // bare opens a new chat the way a terminal does. No other alias.
  assert.deepEqual([1, 2].map(i => vm.evaluate('SLASH_CLAUDEWOW' + i)), ['/claude-wow', null], 'the client command and no alias');
  assert.deepEqual([1, 2].map(i => vm.evaluate('SLASH_CLAUDE' + i)), ['/claude', null], 'the terminal command and no alias');
  assert.equal(vm.evaluate('SlashCmdList.CLAUDE ~= nil'), 'true');
  // Bare /claude starts a fresh chat rather than toggling the window.
  vm.evaluate('SlashCmdList.CLAUDE("")');
  assert.equal(vm.num('#ClaudeWoWDB.chats'), 2, 'bare /claude added a chat');
  // With text it still routes to the client handler.
  vm.evaluate('SlashCmdList.CLAUDE("mini")');
  assert.equal(vm.num('#ClaudeWoWDB.chats'), 2, 'a command after /claude is not a new chat');
  assert.equal(vm.evaluate('SlashCmdList.CLAUDEWOWASK'), null, '/claude is a spelling of the one command, not a handler of its own');
  // The names from before the rename are gone, not aliased: nothing registers them.
  vm.run('RESULT = ""; for k, v in pairs(_G) do if type(k) == "string" and k:match("^SLASH_") and type(v) == "string" and (v == "/wow-ai" or v == "/wowai" or v == "/ai" or v == "/ask" or v == "/wow-claude") then RESULT = RESULT .. k .. "=" .. v .. " " end end');
  assert.equal(vm.evaluate('RESULT'), '', 'no old slash command survives');
});

test('hello goes out on the strip after login', () => {
  const vm = newVM();
  login(vm);
  vm.run('STUB.RunTimers()'); // C_Timer.After(3, SayHello)
  const recs = stripRecords(vm);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].flags, 'h;c', 'a hello always carries the game context');
  assert.equal(recs[0].text, '');
  assert.equal(recs[0].session, vm.evaluate('ClaudeWoWDB.session'));
});

test('outbound records replace field separators inside user text', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  vm.run('ClaudeWoW.Send("wire" .. string.char(30, 31) .. "safe")');
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
  assert.equal(vm.evaluate('ClaudeWoW.IsConnected()'), 'true');
  vm.run('ClaudeWoW.Send("hello world")');
  let rec = stripRecords(vm).find(r => r.text === 'hello world');
  assert.equal(rec.flags, '', 'unchanged context is not repeated');
  assert.equal(rec.ctx, undefined);
  assert.equal(vm.evaluate('ClaudeWoWDB.outbox.ctx'), null);
  // Moving to another zone changes it, so the next message (from another chat,
  // the first one is still waiting) carries the new version.
  vm.run('STUB.zone = "Elwynn Forest"; STUB.subzone = ""; STUB.posX = 0.1; ClaudeWoW.NewChat("Second"); ClaudeWoW.Send("where am I")');
  rec = stripRecords(vm).find(r => r.text === 'where am I');
  assert.equal(rec.flags, 'c');
  assert.ok(rec.ctx.includes('Location: Elwynn Forest\n'), rec.ctx);
  assert.ok(rec.ctx.includes('Position: 10.0, 67.8 on Duskwood (map 1431)'), 'the map name shows when it differs from the zone');
  assert.equal(Buffer.from(vm.evaluate('ClaudeWoWDB.outbox.ctx'), 'hex').toString('utf8'), rec.ctx, 'the reload path carries it too');
  // Turning it off sends an empty context at once (a hello), so the bridge drops what it had.
  vm.run('SlashCmdList.CLAUDEWOW("context off")');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.context'), 'false');
  const off = stripRecords(vm).filter(r => r.flags === 'h;c');
  assert.equal(off.length, 1);
  assert.equal(off[0].ctx, '');
  assert.ok(vm.evaluate('ClaudeWoWDB.chats[2].history[#ClaudeWoWDB.chats[2].history].text').includes('Game context is OFF'));
  // Back on: another hello, with the context again.
  vm.run('SlashCmdList.CLAUDEWOW("context on")');
  const on = stripRecords(vm).filter(r => r.flags === 'h;c');
  assert.ok(on.some(r => r.ctx.includes('Character: Testchar')));
  assert.ok(vm.evaluate('ClaudeWoWDB.chats[2].history[#ClaudeWoWDB.chats[2].history].text').includes('Game context is ON'));
});

test('a shift-clicked link lands in the focused input and is sent as its name plus tooltip', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  const link = '|cff1eff00|Hitem:2140:0:0:0:0:0:0:0:60:0:0|h[Fine Longsword]|h|r';
  vm.run(`STUB.tooltips["item:2140:0:0:0:0:0:0:0:60:0:0"] = { "Fine Longsword", { "Main Hand", "Sword" }, { "17 - 33 Damage", "Speed 2.70" }, "Requires Level 14" }`);
  // Without focus the link is left alone (shift-click keeps its normal meaning).
  vm.run(`ClaudeWoWInput:SetText("is this good for me? "); ClaudeWoWInput:ClearFocus(); ChatFrameUtil.InsertLink("${link}")`);
  assert.equal(vm.evaluate('ClaudeWoWInput:GetText()'), 'is this good for me? ');
  // The client's own path (bags, spellbook, quest log all end here): ChatFrameUtil.InsertLink.
  vm.run(`ClaudeWoWInput:SetFocus(); ChatFrameUtil.InsertLink("${link}")`);
  assert.equal(vm.evaluate('ClaudeWoWInput:GetText()'), 'is this good for me? ' + link);
  // The old global name is not hooked as well, so nothing is inserted twice.
  vm.run(`ChatEdit_InsertLink("${link}")`);
  assert.equal(vm.evaluate('ClaudeWoWInput:GetText()'), 'is this good for me? ' + link + link, 'the alias reaches the one hook exactly once');
  vm.run(`ClaudeWoWInput:SetText("is this good for me? ${link}")`);
  vm.run('ClaudeWoW.SendFromInput()');
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
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].text'), expected, 'the transcript shows what was sent');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].name'), 'Is this good for me');
  // Bare links (no colour) and repeated links: one block each, tooltip or not.
  vm.run('RESULT = (ClaudeWoW.ExpandLinks("x |Hspell:1978|h[Serpent Sting]|h y |Hspell:1978|h[Serpent Sting]|h"))');
  assert.equal(vm.evaluate('RESULT'), 'x [Serpent Sting] y [Serpent Sting]\n\n--- Linked from the game ---\n[Serpent Sting] spell 1978');
  vm.run('RESULT, COUNT = ClaudeWoW.ExpandLinks("plain text | with a pipe")');
  assert.equal(vm.evaluate('RESULT'), 'plain text | with a pipe');
  assert.equal(vm.evaluate('COUNT'), '0');
});

test('deleting a chat tells the bridge to forget it, and a restore never brings it back', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  vm.run('ClaudeWoW.NewChat("Second")');
  assert.equal(vm.num('#ClaudeWoWDB.chats'), 2);
  const gone = vm.evaluate('ClaudeWoWDB.chats[2].id');
  vm.run(`ClaudeWoW.DeleteChat("${gone}")`);
  assert.equal(vm.num('#ClaudeWoWDB.chats'), 1);
  // A forget record for that chat is on the strip and remembered until acked.
  const rec = stripRecords(vm).find(r => r.flags === 'd');
  assert.ok(rec, 'forget record on the strip');
  assert.equal(rec.chat, gone);
  assert.equal(rec.text, '');
  assert.equal(vm.evaluate(`ClaudeWoWDB.forget["${gone}"] ~= nil`), 'true');
  // A restore that still lists the chat is ignored for it.
  const token = vm.evaluate('ClaudeWoWDB.session');
  nextSlot(vm, `{ now = time(), cwd = "", replies = {}, restore = { token = "${token}", chats = { { id = "${gone}", name = "Second", cwd = "", messages = { { role = "user", text = "old", id = 1, t = 1 } } } } } }`);
  vm.run('ClaudeWoW.Connect(); STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.num('#ClaudeWoWDB.chats'), 1, 'deleted chat not restored');
  // The bridge acks the forget record: it leaves the strip and the memory.
  const slot = String(rec.id).padStart(3, '0');
  vm.run(`STUB.sounds["Interface\\\\AddOns\\\\ClaudeWoW\\\\ack\\\\${slot}.wav"] = true; STUB.Tick()`);
  assert.equal(vm.evaluate(`ClaudeWoWDB.forget["${gone}"]`), null, 'forgotten once acked');
  assert.ok(!stripRecords(vm).find(r => r.flags === 'd'), 'forget record left the strip');
});

test('until the bridge answers, Connect replaces Send and a message stays in the box', () => {
  const vm = newVM();
  login(vm);
  vm.run('ClaudeWoW.Toggle(true)');
  assert.equal(vm.evaluate('ClaudeWoW.IsConnected()'), 'false');
  const texts = () => vm.evaluate('table.concat(STUB.texts, "|")');
  assert.ok(texts().includes('Not connected - start the bridge, then click Connect'));
  // Sending while disconnected puts the text back in the box and starts a connect attempt.
  vm.run('ClaudeWoWInput:SetText("fix the bug"); ClaudeWoW.SendFromInput()');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].pendingId'), null, 'nothing sent');
  assert.equal(vm.evaluate('ClaudeWoWInput:GetText()'), 'fix the bug', 'message kept in the box');
  const hello = stripRecords(vm);
  assert.equal(hello.length, 1);
  assert.equal(hello[0].flags, 'h;c', 'a hello went out instead');
  assert.ok(texts().includes('Connecting...'));
  assert.ok(texts().includes('your message goes out as soon as it answers'));
  // No answer within CONNECT_WAIT: the attempt is reported as failed, Connect is back.
  vm.run('STUB.now = STUB.now + 20; STUB.Tick()');
  assert.equal(vm.evaluate('ClaudeWoW.IsConnected()'), 'false');
  assert.ok(texts().includes('No answer from the bridge'));
  assert.equal(vm.evaluate('ClaudeWoWInput:GetText()'), 'fix the bug', 'message still in the box after a failed attempt');
  // Click Connect again; this time the bridge answers the hello poll. Nothing was
  // queued by that click, so the message waits for the user.
  vm.run('ClaudeWoW.Connect()');
  nextSlot(vm, '{ now = time(), cwd = "C:\\\\proj", replies = {} }');
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('ClaudeWoW.IsConnected()'), 'true');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].pendingId'), null, 'a plain Connect sends nothing by itself');
  vm.run('ClaudeWoW.SendFromInput()');
  assert.ok(vm.num('ClaudeWoWDB.chats[1].pendingId') >= 1, 'the kept message goes out once connected');
  assert.ok(stripRecords(vm).find(r => r.text === 'fix the bug'));
});

test('a message sent while disconnected goes out by itself once the bridge answers', () => {
  const vm = newVM();
  login(vm);
  vm.run('ClaudeWoW.Toggle(true)');
  vm.run('ClaudeWoWInput:SetText("fix the bug"); ClaudeWoW.SendFromInput()');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].pendingId'), null, 'nothing sent yet');
  // The bridge answers the hello poll: the queued message follows without a second click.
  nextSlot(vm, '{ now = time(), cwd = "C:\\\\proj", replies = {} }');
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('ClaudeWoW.IsConnected()'), 'true');
  assert.ok(vm.num('ClaudeWoWDB.chats[1].pendingId') >= 1, 'queued message went out on connect');
  assert.ok(stripRecords(vm).find(r => r.text === 'fix the bug'));
  assert.equal(vm.evaluate('ClaudeWoWInput:GetText()'), '', 'box cleared after the auto-send');
  // Only once: a later reconnect sends nothing.
  vm.run('ClaudeWoW.Connect()');
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
  assert.equal(vm.evaluate('ClaudeWoW.BridgeState()'), 'ok');
  // 90 s of silence used to mean "stale"; with no beats to hear that is normal.
  vm.run('STUB.now = STUB.now + 200; STUB.Tick()');
  assert.equal(vm.evaluate('ClaudeWoW.BridgeState()'), 'ok', 'still green after 200 s');
  assert.equal(vm.evaluate('ClaudeWoW.IsConnected()'), 'true');
  // 10 minutes in, the idle poll spends a slot; the bridge's clock in it keeps the light green.
  vm.run('STUB.loadCount = 0; STUB.onLoadAddOn = function(name) STUB.loadCount = STUB.loadCount + 1; ClaudeWoW_SlotData = { now = time(), cwd = "", replies = {} } end');
  vm.run('STUB.now = STUB.now + 410; STUB.Tick()');
  assert.equal(vm.num('STUB.loadCount'), 1, 'one idle poll');
  assert.equal(vm.evaluate('ClaudeWoW.BridgeState()'), 'ok', 'green again after the idle poll');
  // A bridge that really is gone still shows: no slot answers, and the light drops.
  vm.run('STUB.onLoadAddOn = function(name) ClaudeWoW_SlotData = nil end');
  vm.run('STUB.now = STUB.now + 800; STUB.Tick()');
  assert.equal(vm.evaluate('ClaudeWoW.BridgeState()'), 'stale');
  vm.run('STUB.now = STUB.now + 700; STUB.Tick()');
  assert.equal(vm.evaluate('ClaudeWoW.BridgeState()'), 'down');
});

test('the Folder... menu item (right-click a chat) opens a prompt that sets the chat folder like /claude-wow cd', () => {
  const vm = newVM();
  login(vm);
  vm.run('ClaudeWoW.FolderPrompt()');
  assert.equal(vm.evaluate('STUB.popup.which'), 'CLAUDEWOW_FOLDER');
  assert.equal(vm.evaluate('STUB.popup.data.cwd'), '');
  // Accept the dialog the way the game would: an edit box holding the new path.
  vm.run(`
    local dialog = { editBox = { GetText = function() return "  ..\\\\realms " end } }
    StaticPopupDialogs.CLAUDEWOW_FOLDER.OnAccept(dialog, STUB.popup.data)`);
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].cwd'), '..\\realms');
  assert.ok(vm.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].text').includes('relative to'));
  vm.run('ClaudeWoW.FolderPrompt()');
  assert.equal(vm.evaluate('STUB.popup.data.cwd'), '..\\realms', 'prompt is prefilled with the current folder');
  // A full path gets no "relative to" note; empty goes back to the default.
  vm.run('ClaudeWoW.SetFolder("C:\\\\other")');
  assert.ok(!vm.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].text').includes('relative to'));
  vm.run('ClaudeWoW.SetFolder("")');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].cwd'), '');
});

test('a sent message is encoded on the strip with the chat folder, then a slot reply finishes it', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  vm.run('SlashCmdList.CLAUDEWOW("cd realms")');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].cwd'), 'realms');
  vm.run('ClaudeWoW.Send("hello world")');
  const chatId = vm.evaluate('ClaudeWoWDB.chats[1].id');
  const id = vm.num('ClaudeWoWDB.chats[1].pendingId');
  assert.ok(id >= 1);
  const rec = stripRecords(vm).find(r => r.text === 'hello world');
  assert.ok(rec, 'message record on the strip');
  assert.equal(rec.chat, chatId);
  assert.equal(rec.id, id);
  assert.equal(rec.cwd, 'realms');
  assert.equal(rec.flags, '');
  // The chat took its title from the first message.
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].name'), 'Hello world');

  nextSlot(vm, `{ now = time(), cwd = "C:\\\\proj", replies = { { chat = "${chatId}", id = ${id}, status = "done", text = "hi back", cwd = "x", session = "s" } } }`);
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()'); // first scheduled poll is 5 s after sending
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].pendingId'), null);
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].role'), 'assistant');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].text'), 'hi back');
  assert.ok(vm.evaluate('table.concat(STUB.prints, "\\n")').includes('hi back'), 'reply echoed to the game chat');
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'false', 'strip cleared once nothing is pending');

  // The bridge's default folder arrived with the slot and is what "/claude-wow cd" reports.
  vm.run('SlashCmdList.CLAUDEWOW("cd")');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].cwd'), '');
  assert.ok(vm.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].text').includes('C:\\proj'));
});

test('a denied reply shows Allow, and Allow resends with the rules as flags', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  vm.run('ClaudeWoW.Send("search for it")');
  const chatId = vm.evaluate('ClaudeWoWDB.chats[1].id');
  const id = vm.num('ClaudeWoWDB.chats[1].pendingId');
  nextSlot(vm, `{ now = time(), cwd = "", replies = { { chat = "${chatId}", id = ${id}, status = "done", text = "need permission", denied = { "WebSearch", "Bash(cargo:*)" } } } }`);
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].denied[2]'), 'Bash(cargo:*)');
  vm.run(`ClaudeWoW.Allow("${chatId}", { "WebSearch", "Bash(cargo:*)" })`);
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
  assert.equal(vm.evaluate('ClaudeWoW.IsConnected()'), 'true');
  const texts = () => vm.evaluate('table.concat(STUB.texts, "|")');
  assert.ok(texts().includes('agent: Claude (bridge default)'), 'the cwd line names the bridge default');
  // Without an agent of its own the chat sends no agent flag, and the reply is labelled Claude.
  vm.run('ClaudeWoW.Send("hello")');
  const chatId = vm.evaluate('ClaudeWoWDB.chats[1].id');
  let rec = stripRecords(vm).find(r => r.text === 'hello');
  assert.equal(rec.flags, '');
  assert.equal(vm.evaluate('ClaudeWoWDB.outbox.agent'), null);
  const id = vm.num('ClaudeWoWDB.chats[1].pendingId');
  nextSlot(vm, slot(`{ chat = "${chatId}", id = ${id}, status = "done", text = "hi", agent = "claude" }`));
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].role'), 'assistant');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].agent'), 'claude');
  assert.ok(vm.evaluate('table.concat(STUB.prints, "\\n")').includes('[Claude · '), 'the game chat echo names the agent');
  // Switch this chat to Codex: the next message carries agent=codex, on both transports.
  vm.run('SlashCmdList.CLAUDEWOW("agent Codex")');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].agent'), 'codex');
  assert.ok(vm.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].text').includes('agent set to Codex'));
  vm.run('ClaudeWoW.Send("now with codex")');
  rec = stripRecords(vm).find(r => r.text === 'now with codex');
  assert.equal(rec.flags, 'agent=codex');
  assert.equal(vm.evaluate('ClaudeWoWDB.outbox.agent'), 'codex');
  assert.ok(texts().includes('agent: Codex   mode: pixel'));
  const id2 = vm.num('ClaudeWoWDB.chats[1].pendingId');
  nextSlot(vm, slot(`{ chat = "${chatId}", id = ${id2}, status = "done", text = "codex here", agent = "codex" }`));
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].agent'), 'codex');
  assert.ok(vm.evaluate('table.concat(STUB.prints, "\\n")').includes('[Codex · '));
  // Resend keeps the agent flag.
  vm.run('ClaudeWoW.Send("again")');
  vm.run('ClaudeWoW.Resend()');
  assert.equal(stripRecords(vm).find(r => r.text === 'again').flags, 'agent=codex');
  vm.run('SlashCmdList.CLAUDEWOW("cancel")');
  // A name the bridge did not list is refused; "default" goes back to the bridge's.
  vm.run('SlashCmdList.CLAUDEWOW("agent gemini")');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].agent'), 'codex');
  assert.ok(vm.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].text').includes('Unknown agent "gemini"'));
  vm.run('SlashCmdList.CLAUDEWOW("agent default")');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].agent'), '');
  assert.ok(vm.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].text').includes('agent reset to the bridge\'s default: Claude'));
  // The Agent... menu item opens a prompt prefilled with the chat's agent.
  vm.run('ClaudeWoW.SetAgent("grok"); ClaudeWoW.AgentPrompt()');
  assert.equal(vm.evaluate('STUB.popup.which'), 'CLAUDEWOW_AGENT');
  assert.equal(vm.evaluate('STUB.popup.data.agent'), 'grok');
  vm.run(`
    local dialog = { editBox = { GetText = function() return " codex " end } }
    StaticPopupDialogs.CLAUDEWOW_AGENT.OnAccept(dialog, STUB.popup.data)`);
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].agent'), 'codex');
  // A new chat inherits the agent, like the folder.
  vm.run('ClaudeWoW.NewChat("Second")');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[2].agent'), 'codex');
});

test('replies saved under the old "claude" role are read as assistant replies from Claude', () => {
  const vm = newVM();
  vm.run('ClaudeWoWDB = { chats = { { id = "c1", name = "Old", cwd = "", history = { { role = "user", text = "q", id = 1, t = 1 }, { role = "claude", text = "a", id = 1, t = 2 } }, unread = 0, created = 1 } }, activeChat = "c1", settings = {} }');
  login(vm);
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].history[2].role'), 'assistant');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].history[2].agent'), 'claude');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].agent'), '');
  // Before the bridge has said which agent it runs, the label falls back to "AI".
  vm.run('ClaudeWoW.Toggle(true)');
  assert.ok(vm.evaluate('table.concat(STUB.texts, "|")').includes('|Claude|'), 'the old reply is labelled Claude');
});

test('free text that starts with a command word is sent as a message; exact commands still run', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  const sent = text => !!stripRecords(vm).find(r => r.text === text);
  const last = () => vm.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].text');
  // "delete the unused imports" is a message, not /claude-wow delete; "cancel" alone is the command.
  vm.run('SlashCmdList.CLAUDEWOW("delete the unused imports")');
  assert.equal(vm.num('#ClaudeWoWDB.chats'), 1, 'no chat deleted');
  assert.ok(sent('delete the unused imports'));
  vm.run('SlashCmdList.CLAUDEWOW("cancel")');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].pendingId'), null, 'cancel ran as a command');
  // "help me with this macro" is a message; "help" alone prints the help.
  vm.run('SlashCmdList.CLAUDEWOW("help me with this macro")');
  assert.ok(sent('help me with this macro'));
  vm.run('SlashCmdList.CLAUDEWOW("cancel")');
  vm.run('SlashCmdList.CLAUDEWOW("help")');
  assert.ok(last().includes('/claude-wow cd'));
  // One-word arguments keep their command; more words make it a message.
  vm.run('SlashCmdList.CLAUDEWOW("agent codex")');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].agent'), 'codex');
  vm.run('SlashCmdList.CLAUDEWOW("agent smith says hi")');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].agent'), 'codex');
  assert.ok(sent('agent smith says hi'));
  vm.run('SlashCmdList.CLAUDEWOW("cancel")');
  // Enumerated arguments: "context off" is the command, "context matters here" a message.
  vm.run('SlashCmdList.CLAUDEWOW("context off")');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.context'), 'false');
  vm.run('SlashCmdList.CLAUDEWOW("context matters here")');
  assert.ok(sent('context matters here'));
  vm.run('SlashCmdList.CLAUDEWOW("cancel")');
  // "reset the counter" and "clear the cache" are messages; the transcript survives.
  vm.run('SlashCmdList.CLAUDEWOW("clear the cache")');
  assert.ok(sent('clear the cache'));
  assert.ok(vm.num('#ClaudeWoWDB.chats[1].history') > 1, 'clear did not run');
  vm.run('SlashCmdList.CLAUDEWOW("cancel")');
  vm.run('SlashCmdList.CLAUDEWOW("reset the counter")');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].resetNext'), null);
  assert.ok(sent('reset the counter'));
  vm.run('SlashCmdList.CLAUDEWOW("cancel")');
  // A chat can still be picked by number or name; "chat with me about it" is a message.
  vm.run('SlashCmdList.CLAUDEWOW("new Realms")');
  vm.run('SlashCmdList.CLAUDEWOW("chat 1")');
  assert.equal(vm.evaluate('ClaudeWoWDB.activeChat'), vm.evaluate('ClaudeWoWDB.chats[1].id'));
  vm.run('SlashCmdList.CLAUDEWOW("chat realms")');
  assert.equal(vm.evaluate('ClaudeWoWDB.activeChat'), vm.evaluate('ClaudeWoWDB.chats[2].id'));
  vm.run('SlashCmdList.CLAUDEWOW("chat with me about it")');
  assert.ok(sent('chat with me about it'));
  // /claude alone toggles the window.
  vm.run('ClaudeWoW.Toggle(false); SlashCmdList.CLAUDEWOW("")');
  assert.equal(vm.evaluate('ClaudeWoWFrame.shown'), 'true');
});

test('/claude-wow reset marks the next message as a new session', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  vm.run('SlashCmdList.CLAUDEWOW("reset")');
  vm.run('ClaudeWoW.Send("start over")');
  const rec = stripRecords(vm).find(r => r.text === 'start over');
  assert.equal(rec.flags, 'n');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].resetNext'), null);
});

test('game chat echo: the summary by default, the first lines without one, the whole reply with "echo full"', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.echo'), 'summary', 'summary echo is the default');
  const chatId = vm.evaluate('ClaudeWoWDB.chats[1].id');
  const prints = () => vm.evaluate('table.concat(STUB.prints, "\\n")');
  const reply = (text, summary) => {
    vm.run('STUB.prints = {}');
    vm.run('ClaudeWoW.Send("do it")');
    const id = vm.num('ClaudeWoWDB.chats[1].pendingId');
    const sum = summary === undefined ? '' : `, summary = "${summary}"`;
    nextSlot(vm, `{ now = time(), cwd = "", replies = { { chat = "${chatId}", id = ${id}, status = "done", text = "${text}", agent = "claude"${sum} } } }`);
    vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
    assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].pendingId'), null);
  };

  // With a summary only the summary is printed; the window keeps the whole reply.
  reply('Long line one\\nLong line two\\nLong line three\\n\\nTL;DR: Renamed foo.\\nTests pass.', 'Renamed foo.\\nTests pass.');
  let out = prints();
  assert.ok(out.includes('[Claude · ') && out.includes('Renamed foo.') && out.includes('Tests pass.'), 'summary lines printed: ' + out);
  assert.ok(!out.includes('Long line one'), 'the body stays out of the game chat');
  assert.ok(out.includes('[open]'), 'the open link is there');
  assert.ok(vm.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].text').includes('Long line three'), 'the window has the full reply');

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
  vm.run('SlashCmdList.CLAUDEWOW("echo full")');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.echo'), 'full');
  reply('Line one\\nLine two\\nLine three\\n\\nTL;DR: Short.', 'Short.');
  out = prints();
  assert.ok(out.includes('Line one') && out.includes('Line three') && out.includes('TL;DR: Short.'), out);
  vm.run('SlashCmdList.CLAUDEWOW("echo summary")');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.echo'), 'summary');
  vm.run('SlashCmdList.CLAUDEWOW("echo bogus")');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.echo'), 'summary', 'an unknown mode is ignored');

  // An install that still had the old default saved moves to summary once; a mode picked on purpose stays.
  const vm2 = newVM();
  vm2.run('ClaudeWoWDB = { settings = { echo = "full" } }');
  login(vm2);
  assert.equal(vm2.evaluate('ClaudeWoWDB.settings.echo'), 'summary');
  const vm3 = newVM();
  vm3.run('ClaudeWoWDB = { settings = { echo = "short" } }');
  login(vm3);
  assert.equal(vm3.evaluate('ClaudeWoWDB.settings.echo'), 'short');
  const vm4 = newVM();
  vm4.run('ClaudeWoWDB = { settings = { echo = "full", echoV2 = true } }');
  login(vm4);
  assert.equal(vm4.evaluate('ClaudeWoWDB.settings.echo'), 'full');
});

test('a restore bundle addressed to this session adds the missing chats once', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  vm.run('ClaudeWoW.Send("hi")');
  const chatId = vm.evaluate('ClaudeWoWDB.chats[1].id');
  const id = vm.num('ClaudeWoWDB.chats[1].pendingId');
  const token = vm.evaluate('ClaudeWoWDB.session');
  const bundle = `restore = { token = "${token}", chats = { { id = "old1", name = "Old work", cwd = "C:\\\\old", messages = { { role = "user", id = 1, t = 1, text = "q" }, { role = "claude", id = 1, t = 2, text = "a" } } } } }`;
  nextSlot(vm, `{ now = time(), cwd = "", replies = { { chat = "${chatId}", id = ${id}, status = "done", text = "ok" } }, ${bundle} }`);
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.num('#ClaudeWoWDB.chats'), 2);
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].id'), 'old1');
  assert.equal(vm.num('#ClaudeWoWDB.chats[1].history'), 2);
  // An older bridge's transcript says "claude"; it is read as an assistant reply from Claude.
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].history[2].role'), 'assistant');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].history[2].agent'), 'claude');
  assert.equal(vm.evaluate('ClaudeWoWDB.restored'), 'true');
  // A second bundle with the same token is ignored.
  vm.run('ClaudeWoW.Send("again")');
  const id2 = vm.num('ClaudeWoWDB.chats[2].pendingId');
  nextSlot(vm, `{ now = time(), cwd = "", replies = { { chat = "${chatId}", id = ${id2}, status = "done", text = "ok" } }, ${bundle.replace('old1', 'old2')} }`);
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.num('#ClaudeWoWDB.chats'), 2);
});

test('chat management commands: new, chat, rename, delete, clear, copy', () => {
  const vm = newVM();
  login(vm);
  vm.run('SlashCmdList.CLAUDEWOW("new Realms")');
  assert.equal(vm.num('#ClaudeWoWDB.chats'), 2);
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[2].name'), 'Realms');
  assert.equal(vm.evaluate('ClaudeWoWDB.activeChat'), vm.evaluate('ClaudeWoWDB.chats[2].id'));
  vm.run('SlashCmdList.CLAUDEWOW("chat 1")');
  assert.equal(vm.evaluate('ClaudeWoWDB.activeChat'), vm.evaluate('ClaudeWoWDB.chats[1].id'));
  vm.run('SlashCmdList.CLAUDEWOW("rename Stuff")');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].name'), 'Stuff');
  vm.run('SlashCmdList.CLAUDEWOW("help")');
  assert.ok(vm.evaluate('ClaudeWoWDB.chats[1].history[1].text').includes('/claude-wow cd'));
  vm.run('SlashCmdList.CLAUDEWOW("clear")');
  assert.equal(vm.num('#ClaudeWoWDB.chats[1].history'), 0);
  vm.run('SlashCmdList.CLAUDEWOW("delete")');
  assert.equal(vm.num('#ClaudeWoWDB.chats'), 1);
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].name'), 'Realms');
  // The copy box builds with a proper backdrop (the stub fails on SetBackdrop(nil)).
  vm.run('ClaudeWoW.ShowCopy("some reply")');
  assert.equal(vm.evaluate('ClaudeWoWCopy.shown'), 'true');
  assert.equal(vm.evaluate('ClaudeWoWCopyBox.text'), 'some reply');
});

test('chat rows: right-click opens a menu that renames or sets the folder of that chat, the trash can asks before deleting', () => {
  const vm = newVM();
  login(vm);
  vm.run('SlashCmdList.CLAUDEWOW("new Realms")');
  const first = vm.evaluate('ClaudeWoWDB.chats[1].id');
  const second = vm.evaluate('ClaudeWoWDB.chats[2].id');
  assert.equal(vm.evaluate('ClaudeWoWDB.activeChat'), second);
  // The menu opens for the row's chat, not the active one, and toggles closed on a second open.
  vm.run(`ClaudeWoW.ShowChatMenu("${first}", ClaudeWoWFrame)`);
  assert.equal(vm.evaluate('ClaudeWoWChatMenu.shown'), 'true');
  assert.equal(vm.evaluate('ClaudeWoWChatMenu.chatId'), first);
  assert.equal(vm.evaluate('ClaudeWoWChatMenu.title.text'), 'Chat 1');
  vm.run(`ClaudeWoW.ShowChatMenu("${first}", ClaudeWoWFrame)`);
  assert.equal(vm.evaluate('ClaudeWoWChatMenu.shown'), 'false');
  // Rename and Folder prompts target the chat they were opened for.
  vm.run(`ClaudeWoW.RenamePrompt("${first}")`);
  assert.equal(vm.evaluate('STUB.popup.which'), 'CLAUDEWOW_RENAME');
  assert.equal(vm.evaluate('STUB.popup.data.id'), first);
  vm.run(`
    local dialog = { editBox = { GetText = function() return "Old stuff" end } }
    StaticPopupDialogs.CLAUDEWOW_RENAME.OnAccept(dialog, STUB.popup.data)`);
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].name'), 'Old stuff');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[2].name'), 'Realms');
  vm.run(`ClaudeWoW.FolderPrompt("${first}")`);
  assert.equal(vm.evaluate('STUB.popup.which'), 'CLAUDEWOW_FOLDER');
  assert.equal(vm.evaluate('STUB.popup.data.id'), first);
  // The X asks first: nothing happens until OK, then only that chat goes and the active one stays.
  vm.run(`ClaudeWoW.ConfirmDelete("${first}")`);
  assert.equal(vm.evaluate('STUB.popup.which'), 'CLAUDEWOW_DELETE');
  assert.equal(vm.num('#ClaudeWoWDB.chats'), 2);
  vm.run('StaticPopupDialogs.CLAUDEWOW_DELETE.OnAccept({}, STUB.popup.data)');
  assert.equal(vm.num('#ClaudeWoWDB.chats'), 1);
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].id'), second);
  assert.equal(vm.evaluate('ClaudeWoWDB.activeChat'), second);
  // Deleting the last chat clears it instead of removing it.
  vm.run(`ClaudeWoW.ConfirmDelete("${second}")`);
  vm.run('StaticPopupDialogs.CLAUDEWOW_DELETE.OnAccept({}, STUB.popup.data)');
  assert.equal(vm.num('#ClaudeWoWDB.chats'), 1);
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].name'), 'Chat 1');
});

test('minimize collapses to the mini bar and back; the mini bar X hides everything', () => {
  const vm = newVM();
  login(vm);
  vm.run('ClaudeWoW.Toggle(true)');
  assert.equal(vm.evaluate('ClaudeWoWFrame.shown'), 'true');
  vm.run('ClaudeWoW.Minimize(true)');
  assert.equal(vm.evaluate('ClaudeWoWFrame.shown'), 'false');
  assert.equal(vm.evaluate('ClaudeWoWMini.shown'), 'true');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.minimized'), 'true');
  vm.run('ClaudeWoW.Minimize(false)');
  assert.equal(vm.evaluate('ClaudeWoWFrame.shown'), 'true');
  assert.equal(vm.evaluate('ClaudeWoWMini.shown'), 'false');
  vm.run('ClaudeWoW.Toggle(false)');
  assert.equal(vm.evaluate('ClaudeWoWFrame.shown'), 'false');
  assert.equal(vm.evaluate('ClaudeWoWMini.shown'), 'false');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.shown'), 'false');
});

test('reload mode writes the outbox for the bridge instead of drawing the strip', () => {
  const vm = newVM();
  login(vm);
  vm.run('SlashCmdList.CLAUDEWOW("mode reload")');
  vm.run('SlashCmdList.CLAUDEWOW("reset")');
  vm.run('ClaudeWoW.Send("via reload", { "WebSearch", "Bash(git:*)" })');
  assert.equal(vm.evaluate('STUB.reloaded'), 'true');
  assert.equal(vm.evaluate('ClaudeWoWDB.outbox.newSession'), 'true');
  assert.equal(vm.evaluate('ClaudeWoWDB.outbox.text'), Buffer.from('via reload').toString('hex'));
  assert.equal(Buffer.from(vm.evaluate('ClaudeWoWDB.outbox.allow'), 'hex').toString('utf8'), 'WebSearch\x1fBash(git:*)');
  assert.equal(decodeStrip(vm), null);
});

// The screenshot transport: the bridge's slot says `transport = "screenshot"`,
// and from then on the strip is only up for the frames around a Screenshot()
// call. Drives the strip's OnUpdate by hand (the stub renders nothing).
function frames(vm, n) {
  for (let i = 0; i < n; i++) vm.run('local f = ClaudeWoWStrip; if f.shown and f.scripts.OnUpdate then f.scripts.OnUpdate(f, 0.016) end');
}

test('screenshot transport: the strip is shot once per message, hidden on the event, and the format CVar is restored', () => {
  const vm = newVM();
  vm.run('STUB.sounds["Interface\\\\AddOns\\\\ClaudeWoW\\\\ctl\\\\valid.wav"] = true'); // the sound channel works: acks arrive as files
  login(vm);
  vm.run('STUB.RunTimers()'); // SayHello: not knowing better, the hello goes up pixel-style
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'true');
  assert.equal(vm.num('STUB.screenshots'), 0);
  // The hello poll reads a slot from a screenshot-mode bridge.
  nextSlot(vm, '{ now = time(), cwd = "", transport = "screenshot", replies = {} }');
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.transport'), 'screenshot', 'remembered for the next login');
  assert.equal(vm.evaluate('STUB.cvars.screenshotFormat'), 'png', 'lossless format while the mode is on');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.shotFormatSaved'), 'jpeg', 'the player\'s own format is kept');
  // The unacknowledged hello is shot now: strip up, two frames, Screenshot().
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'true');
  frames(vm, 1);
  assert.equal(vm.num('STUB.screenshots'), 0, 'not before the strip had a frame to render');
  frames(vm, 1);
  assert.equal(vm.num('STUB.screenshots'), 1);
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'true', 'still up until the client confirms');
  assert.equal(stripRecords(vm)[0].flags, 'h;c');
  vm.run('STUB.FireEvent("SCREENSHOT_SUCCEEDED")');
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'false', 'hidden as soon as the shot is confirmed');
  assert.equal(vm.evaluate('ClaudeWoWStrip.scripts.OnUpdate'), null, 'no OnUpdate left running');
  // A message: one more shot, carrying the hello (still unacked) and the message.
  vm.run('ClaudeWoW.Send("hello world")');
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'true');
  frames(vm, 2);
  assert.equal(vm.num('STUB.screenshots'), 2);
  const recs = stripRecords(vm);
  assert.ok(recs.find(r => r.text === 'hello world'));
  assert.ok(recs.find(r => r.flags === 'h;c'));
  vm.run('STUB.FireEvent("SCREENSHOT_SUCCEEDED")');
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'false');
  // Ticks without news take no more screenshots; an ack changes nothing on screen either.
  vm.run('STUB.now = STUB.now + 2; STUB.Tick(); STUB.now = STUB.now + 2; STUB.Tick()');
  frames(vm, 3);
  assert.equal(vm.num('STUB.screenshots'), 2);
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'false');
  const id = vm.num('ClaudeWoWDB.chats[1].pendingId');
  vm.run(`STUB.sounds["Interface\\\\AddOns\\\\ClaudeWoW\\\\ack\\\\${String(id).padStart(3, '0')}.wav"] = true; STUB.now = STUB.now + 2; STUB.Tick()`);
  frames(vm, 3);
  assert.equal(vm.num('STUB.screenshots'), 2);
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'false');
  // A player's own screenshot event with nothing in flight is ignored.
  vm.run('STUB.FireEvent("SCREENSHOT_SUCCEEDED")');
  assert.equal(vm.num('STUB.screenshots'), 2);
  // A second chat's message that the bridge never acks: the 40 s retry shoots it
  // again (the hello has expired by then and is not on that strip).
  vm.run('ClaudeWoW.NewChat("Two"); ClaudeWoW.Send("lost one")');
  frames(vm, 2);
  assert.equal(vm.num('STUB.screenshots'), 3);
  vm.run('STUB.FireEvent("SCREENSHOT_SUCCEEDED")');
  vm.run('STUB.now = STUB.now + 41; STUB.Tick()');
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'true', 'retry puts the strip up again');
  frames(vm, 2);
  assert.equal(vm.num('STUB.screenshots'), 4);
  assert.deepEqual(stripRecords(vm).map(r => r.text), ['lost one']);
  vm.run('STUB.FireEvent("SCREENSHOT_SUCCEEDED")');
  // The status line says which transport is in use; diag counts the shots.
  vm.run('STUB.texts = {}; ClaudeWoW.UpdateStatus()');
  assert.ok(vm.evaluate('table.concat(STUB.texts, "|")').includes('mode: pixel (screenshot)'));
  vm.run('SlashCmdList.CLAUDEWOW("diag")');
  const diag = vm.evaluate('ClaudeWoWDB.chats[2].history[#ClaudeWoWDB.chats[2].history].text');
  assert.ok(diag.includes('transport: screenshot, screenshots: 4 taken, 4 confirmed, 0 failed, 0 without event'), diag);
  // Back to a pixel-mode bridge: the CVar goes back and the strip stays up pixel-style.
  nextSlot(vm, '{ now = time(), cwd = "", transport = "pixel", replies = {} }');
  vm.run('ClaudeWoW.Connect(); STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.transport'), 'pixel');
  assert.equal(vm.evaluate('STUB.cvars.screenshotFormat'), 'jpeg', 'restored');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.shotFormatSaved'), null);
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'true', 'pixel mode: the strip stays up until acked');
  frames(vm, 3);
  assert.equal(vm.num('STUB.screenshots'), 4, 'no screenshots in pixel mode');
});

test('screenshot transport: a failed shot is retried a few times, a missing event times out, logout restores the CVar', () => {
  const vm = newVM();
  login(vm);
  vm.run('STUB.RunTimers()'); // SayHello
  nextSlot(vm, '{ now = time(), cwd = "", transport = "screenshot", replies = {} }');
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()'); // the hello poll learns the transport
  assert.equal(vm.evaluate('ClaudeWoW.IsConnected()'), 'true');
  frames(vm, 2); // the hello's shot
  vm.run('STUB.FireEvent("SCREENSHOT_SUCCEEDED")');
  assert.equal(vm.num('STUB.screenshots'), 1);
  vm.run('ClaudeWoW.Send("try me")');
  frames(vm, 2);
  assert.equal(vm.num('STUB.screenshots'), 2);
  vm.run('STUB.FireEvent("SCREENSHOT_FAILED")');
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'true', 'a failure puts it straight up again');
  frames(vm, 2);
  assert.equal(vm.num('STUB.screenshots'), 3);
  vm.run('STUB.FireEvent("SCREENSHOT_FAILED")');
  frames(vm, 2);
  assert.equal(vm.num('STUB.screenshots'), 4);
  vm.run('STUB.prints = {}');
  vm.run('STUB.FireEvent("SCREENSHOT_FAILED")');
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'false', 'after SHOT_RETRIES failures it waits for the normal retry');
  frames(vm, 2);
  assert.equal(vm.num('STUB.screenshots'), 4);
  // Every try failed: the reload outbox tells the bridge to fall back to the pixel capture, and the player hears once.
  assert.equal(vm.evaluate('ClaudeWoWDB.outbox.shot'), 'failed');
  assert.equal(vm.evaluate('#STUB.prints'), '1');
  assert.ok(vm.evaluate('STUB.prints[1]').includes('SCREENSHOT_FAILED 3 times'), vm.evaluate('STUB.prints[1]'));
  // The 40 s retry shoots it again, with the flag on the record.
  vm.run('STUB.now = STUB.now + 41; STUB.Tick()');
  frames(vm, 2);
  assert.equal(vm.num('STUB.screenshots'), 5);
  const failed = stripRecords(vm).find(r => r.text === 'try me');
  assert.ok(failed && failed.flags.split(';').includes('shot=failed'), JSON.stringify(stripRecords(vm).map(r => r.flags)));
  vm.run('STUB.FireEvent("SCREENSHOT_FAILED")');
  assert.equal(vm.evaluate('#STUB.prints'), '1', 'not said again');
  // No event at all: the timeout hides the strip and counts it.
  vm.run('STUB.timers = {}; ClaudeWoW.NewChat("Two"); ClaudeWoW.Send("quiet")');
  frames(vm, 2);
  assert.equal(vm.num('STUB.screenshots'), 6);
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'true');
  vm.run('STUB.RunTimers()'); // the SHOT_TIMEOUT timer
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'false');
  vm.run('SlashCmdList.CLAUDEWOW("diag")');
  const diag = vm.evaluate('ClaudeWoWDB.chats[2].history[#ClaudeWoWDB.chats[2].history].text');
  assert.ok(diag.includes('6 taken, 1 confirmed, 4 failed, 1 without event'), diag);
  // Logging out restores the format; the mode itself is remembered.
  assert.equal(vm.evaluate('STUB.cvars.screenshotFormat'), 'png');
  vm.run('STUB.FireEvent("PLAYER_LOGOUT")');
  assert.equal(vm.evaluate('STUB.cvars.screenshotFormat'), 'jpeg');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.transport'), 'screenshot');
});

test('screenshot transport without Screenshot(): the strip stays up carrying shot=missing, the reload outbox says so, the player is told once, and diag shows the bridge\'s fallback note', () => {
  const vm = newVM();
  vm.run('Screenshot = nil'); // a client without the function
  login(vm);
  vm.run('STUB.RunTimers()'); // SayHello
  nextSlot(vm, '{ now = time(), cwd = "", transport = "screenshot", replies = {} }');
  vm.run('STUB.prints = {}; STUB.now = STUB.now + 6; STUB.Tick()'); // the hello poll learns the transport
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.transport'), 'screenshot');
  assert.equal(vm.evaluate('STUB.cvars.screenshotFormat'), 'jpeg', 'the format CVar is left alone: no shot can be taken');
  // The hello counted as delivered pixel-style (the bridge was seen while it was up): nothing is on the strip now.
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'false');
  // A message: no shot can be taken, so the strip stays up pixel-style, every
  // record on it tells the bridge why, and the player hears about it once.
  vm.run('ClaudeWoW.Send("hello there")');
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'true');
  frames(vm, 3);
  assert.equal(vm.num('STUB.screenshots'), 0);
  const told = () => vm.evaluate('(function() local n = 0; for _, l in ipairs(STUB.prints or {}) do if l:find("no Screenshot%(%) function") then n = n + 1 end end; return n end)()');
  assert.equal(told(), '1', 'the player is told once');
  const recs = stripRecords(vm);
  assert.ok(recs.every(r => r.flags.split(';').includes('shot=missing')), JSON.stringify(recs.map(r => r.flags)));
  const msg = recs.find(r => r.text === 'hello there');
  assert.ok(msg && msg.flags.split(';').includes('shot=missing'), JSON.stringify(recs.map(r => r.flags)));
  // The reload fallback's outbox carries the same report, so a /reload reaches the bridge with it.
  assert.equal(vm.evaluate('ClaudeWoWDB.outbox.shot'), 'missing');
  assert.equal(vm.evaluate('ClaudeWoWDB.outbox.text'), Buffer.from('hello there').toString('hex'));
  vm.run('STUB.now = STUB.now + 41; STUB.Tick()');
  assert.equal(told(), '1', 'a retry does not say it again');
  // The bridge fell back: its slot says pixel, with the note; diag shows it and the flag goes away.
  nextSlot(vm, '{ now = time(), cwd = "", transport = "pixel", transportNote = "pixel transport, fallen back to since 2026-09-28 12:00 UTC because the game client has no Screenshot() function; the pixel capture is deprecated", replies = {} }');
  vm.run('ClaudeWoW.Connect(); STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.transport'), 'pixel');
  assert.ok(stripRecords(vm).every(r => !r.flags.includes('shot=')), 'on the pixel transport nothing is reported');
  vm.run('ClaudeWoW.NewChat("Two"); ClaudeWoW.Send("second")'); // the first chat still has its message pending
  assert.equal(vm.evaluate('ClaudeWoWDB.outbox.text'), Buffer.from('second').toString('hex'));
  assert.equal(vm.evaluate('ClaudeWoWDB.outbox.shot'), null);
  vm.run('SlashCmdList.CLAUDEWOW("diag")');
  const diag = vm.evaluate('ClaudeWoWDB.chats[2].history[#ClaudeWoWDB.chats[2].history].text');
  assert.ok(diag.includes('transport: pixel (bridge: pixel transport, fallen back to since 2026-09-28 12:00 UTC because the game client has no Screenshot() function'), diag);
  // A bridge back on the screenshot transport drops the note.
  nextSlot(vm, '{ now = time(), cwd = "", transport = "screenshot", replies = {} }');
  vm.run('ClaudeWoW.Connect(); STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.transportNote'), null);
});

test('screenshot transport: a remembered mode shoots the login hello, and a /reload never loses the saved format', () => {
  const vm = newVM();
  // Saved data from a previous session that ended mid-mode (a /reload): the
  // CVar is already png and the original is on record.
  vm.run('ClaudeWoWDB = { settings = { transport = "screenshot", shotFormatSaved = "tga" } }; STUB.cvars.screenshotFormat = "png"');
  login(vm);
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.shotFormatSaved'), 'tga', 'the original is not overwritten with our own png');
  vm.run('STUB.RunTimers()'); // SayHello
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'true');
  frames(vm, 2);
  assert.equal(vm.num('STUB.screenshots'), 1, 'the hello is shot without waiting for a slot');
  vm.run('STUB.FireEvent("SCREENSHOT_SUCCEEDED")');
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'false');
  // Switching to the reload transport in game gives the CVar back too.
  vm.run('SlashCmdList.CLAUDEWOW("mode reload")');
  assert.equal(vm.evaluate('STUB.cvars.screenshotFormat'), 'tga');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.shotFormatSaved'), null);
  vm.run('SlashCmdList.CLAUDEWOW("mode pixel")');
  assert.equal(vm.evaluate('STUB.cvars.screenshotFormat'), 'png');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.shotFormatSaved'), 'tga');
});

// A client crash skips PLAYER_LOGOUT and its restore: the player's screenshots
// would silently stay in our format. The original is in the saved settings from
// the first change, and load gives it back when the value is still ours.
test('screenshotFormat: a crash that skipped the logout restore is repaired at the next load, a value the player set since is kept, and the stored original is never clobbered by ours', () => {
  // The bridge had moved on to the pixel transport (or never said): our png is
  // still in place from the crash and the original is on record. Repaired at
  // ADDON_LOADED, before PLAYER_LOGIN even runs.
  let vm = newVM();
  vm.run('ClaudeWoWDB = { settings = { shotFormatSaved = "jpeg" } }; STUB.cvars.screenshotFormat = "png"');
  vm.run('STUB.FireEvent("ADDON_LOADED", "ClaudeWoW")');
  assert.equal(vm.evaluate('STUB.cvars.screenshotFormat'), 'jpeg', 'restored as soon as the saved data is there');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.shotFormatSaved'), null);
  vm.run('STUB.FireEvent("PLAYER_LOGIN")');
  assert.equal(vm.evaluate('STUB.cvars.screenshotFormat'), 'jpeg');
  // The tga fallback is ours too.
  vm = newVM();
  vm.run('ClaudeWoWDB = { settings = { shotFormatSaved = "jpeg" } }; STUB.cvars.screenshotFormat = "tga"');
  login(vm);
  assert.equal(vm.evaluate('STUB.cvars.screenshotFormat'), 'jpeg');
  // The player put a value of their own in place after the crash: it is theirs
  // and stays; the stale original is dropped, not "restored" over it.
  vm = newVM();
  vm.run('ClaudeWoWDB = { settings = { shotFormatSaved = "tga" } }; STUB.cvars.screenshotFormat = "jpeg"');
  login(vm);
  assert.equal(vm.evaluate('STUB.cvars.screenshotFormat'), 'jpeg', 'not put back to tga');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.shotFormatSaved'), null);
  // Remembered screenshot mode: our png stays, the original is kept, and however
  // many crashes and loads follow, it is never overwritten with png.
  vm = newVM();
  vm.run('ClaudeWoWDB = { settings = { transport = "screenshot", shotFormatSaved = "jpeg" } }; STUB.cvars.screenshotFormat = "png"');
  for (let crash = 0; crash < 3; crash++) {
    vm.run('STUB.FireEvent("ADDON_LOADED", "ClaudeWoW")');
    assert.equal(vm.evaluate('ClaudeWoWDB.settings.shotFormatSaved'), 'jpeg', 'load ' + crash + ': the original is not clobbered');
    assert.equal(vm.evaluate('STUB.cvars.screenshotFormat'), 'png', 'load ' + crash + ': the mode still needs ours');
  }
  vm.run('STUB.FireEvent("PLAYER_LOGIN")');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.shotFormatSaved'), 'jpeg');
  // Leaving the mode in game gives the real original back, not png.
  vm.run('SlashCmdList.CLAUDEWOW("mode reload")');
  assert.equal(vm.evaluate('STUB.cvars.screenshotFormat'), 'jpeg');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.shotFormatSaved'), null);
  // Remembered mode, but the player changed the format by hand after the crash:
  // that is the new original, and it is what logout restores.
  vm = newVM();
  vm.run('ClaudeWoWDB = { settings = { transport = "screenshot", shotFormatSaved = "tga" } }; STUB.cvars.screenshotFormat = "jpeg"');
  login(vm);
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.shotFormatSaved'), 'jpeg', 'the player\'s new choice replaces the stale original');
  assert.equal(vm.evaluate('STUB.cvars.screenshotFormat'), 'png');
  vm.run('STUB.FireEvent("PLAYER_LOGOUT")');
  assert.equal(vm.evaluate('STUB.cvars.screenshotFormat'), 'jpeg');
  // A player who already shoots png: nothing to change, and the restore is a no-op.
  vm = newVM();
  vm.run('STUB.cvars.screenshotFormat = "png"');
  login(vm);
  vm.run('STUB.RunTimers()');
  nextSlot(vm, '{ now = time(), cwd = "", transport = "screenshot", replies = {} }');
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.shotFormatSaved'), 'png');
  vm.run('STUB.FireEvent("PLAYER_LOGOUT")');
  assert.equal(vm.evaluate('STUB.cvars.screenshotFormat'), 'png');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.shotFormatSaved'), null);
});

// Every shot is a full-screen file that only the bridge deletes. Once the bridge
// has been silent for as long as BridgeState's "down" window (5 min with presence
// beats), the addon stops shooting, says so once, and puts the strip up
// pixel-style instead, so the usual retries and fallback carry the message.
test('screenshot transport: shots stop once the bridge has been dark for a while, the player is told, Connect takes one by hand, and shooting resumes when the bridge is back', () => {
  const vm = newVM();
  vm.run('STUB.sounds["Interface\\\\AddOns\\\\ClaudeWoW\\\\ctl\\\\valid.wav"] = true'); // presence beats can be heard
  login(vm);
  vm.run('STUB.RunTimers()'); // SayHello
  nextSlot(vm, '{ now = time(), cwd = "", transport = "screenshot", replies = {} }');
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()'); // the bridge is seen through the hello slot
  frames(vm, 2);
  vm.run('STUB.FireEvent("SCREENSHOT_SUCCEEDED")');
  assert.equal(vm.num('STUB.screenshots'), 1);
  vm.run('ClaudeWoW.Send("still there?")');
  frames(vm, 2);
  vm.run('STUB.FireEvent("SCREENSHOT_SUCCEEDED")');
  assert.equal(vm.num('STUB.screenshots'), 2);
  const prints = () => vm.evaluate('table.concat(STUB.prints, "\\n")') || '';
  // The bridge dies: its slot files keep the clock of its last write. After
  // 200 s it is only stale, and the retry still shoots.
  vm.run('local dead = time(); STUB.onLoadAddOn = function(name) ClaudeWoW_SlotData = { now = dead, cwd = "", transport = "screenshot", replies = {} } end');
  vm.run('STUB.now = STUB.now + 200; STUB.Tick()');
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'true', 'the 40 s retry');
  frames(vm, 2);
  vm.run('STUB.FireEvent("SCREENSHOT_SUCCEEDED")');
  assert.equal(vm.num('STUB.screenshots'), 3);
  assert.ok(!prints().includes('screenshots paused'), 'nothing said while the bridge is merely stale');
  // Past 5 minutes it counts as down: the next retry puts the strip up pixel-style, no file.
  vm.run('STUB.now = STUB.now + 110; STUB.Tick()');
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'true', 'the message is not dropped: the strip stays up as in pixel mode');
  frames(vm, 3);
  assert.equal(vm.num('STUB.screenshots'), 3, 'no screenshot for a bridge that has been dark 5 minutes');
  assert.ok(prints().includes('bridge not seen for 5m10s: screenshots paused'), 'the player is told in the game chat: ' + prints());
  assert.ok(vm.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].text').includes('screenshots paused'), 'and in the window');
  // A message typed now: Send is gated on the connection, and the automatic
  // Connect it triggers says hello without a file. The pause is said once.
  vm.run('STUB.prints = {}; ClaudeWoW.NewChat("Two"); ClaudeWoW.Send("anyone?")');
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'true');
  frames(vm, 3);
  assert.equal(vm.num('STUB.screenshots'), 3, 'a message typed at a dead bridge leaves no file behind');
  assert.ok(!prints().includes('screenshots paused'), 'said once, not per message');
  vm.run('SlashCmdList.CLAUDEWOW("diag")');
  assert.ok(vm.evaluate('ClaudeWoWDB.chats[2].history[#ClaudeWoWDB.chats[2].history].text').includes('screenshots PAUSED (bridge not seen for'), 'diag says so');
  // The Connect button is a deliberate act: it buys exactly one shot.
  vm.run('STUB.now = STUB.now + 20; STUB.Tick()'); // the automatic connect attempt gives up
  assert.equal(vm.evaluate('ClaudeWoWFrame ~= nil'), 'true');
  vm.run('ClaudeWoW.Connect(true)');
  frames(vm, 2);
  assert.equal(vm.num('STUB.screenshots'), 4, 'one hello shot for the click');
  assert.ok(stripRecords(vm).find(r => r.text === 'still there?'), 'the message that waited rides on that one shot');
  vm.run('STUB.FireEvent("SCREENSHOT_SUCCEEDED")');
  vm.run('STUB.now = STUB.now + 2; STUB.Tick()');
  frames(vm, 3);
  assert.equal(vm.num('STUB.screenshots'), 4, 'and no more');
  assert.ok(!prints().includes('resume'), 'a click is not the bridge coming back');
  // The bridge is back: a presence beat. Said once, and sends shoot again.
  vm.run('STUB.sounds["Interface\\\\AddOns\\\\ClaudeWoW\\\\presence\\\\0001.wav"] = true; STUB.prints = {}; STUB.now = STUB.now + 2; STUB.Tick()');
  assert.ok(prints().includes('bridge is back: screenshots resume'), prints());
  assert.equal(vm.evaluate('ClaudeWoW.IsConnected()'), 'true');
  vm.run('ClaudeWoW.Send("back?")');
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'true');
  frames(vm, 2);
  assert.equal(vm.num('STUB.screenshots'), 5, 'a message sent now is shot as usual');
  assert.ok(stripRecords(vm).find(r => r.text === 'back?'));
  vm.run('STUB.FireEvent("SCREENSHOT_SUCCEEDED")');
  vm.run('STUB.now = STUB.now + 2; STUB.Tick()');
  assert.equal(prints().split('screenshots resume').length, 2, 'said once');
});

// Strip colour levels, in 0..255 per channel, of every shown cell on the strip.
function stripLevels(vm) {
  vm.run(`local seen = {}
    for _, t in ipairs(ClaudeWoWStrip.textures) do
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
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.stripLevels.on'), '60');
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'true', 'the hello is being shot');
  assert.deepEqual(stripLevels(vm), [0, 60], 'dark levels: the strip is drawn at 0 and 60 of 255');
  // Reads back at the bridge's threshold (31), not at the pixel transport's (128).
  assert.equal(stripRecords(vm, 31 / 255)[0].flags, 'h;c');
  frames(vm, 2);
  vm.run('STUB.FireEvent("SCREENSHOT_SUCCEEDED")');
  // The bridge changes its levels: the next strip follows without a transport change.
  nextSlot(vm, '{ now = time(), cwd = "", transport = "screenshot", strip = { on = 90, off = 10 }, replies = {} }');
  vm.run('ClaudeWoW.Connect(); STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.stripLevels.on'), '90');
  vm.run('ClaudeWoW.Send("dark one")');
  assert.deepEqual(stripLevels(vm), [10, 90]);
  assert.ok(stripRecords(vm, 51 / 255).find(r => r.text === 'dark one'));
  frames(vm, 2);
  vm.run('STUB.FireEvent("SCREENSHOT_SUCCEEDED")');
  // Unusable levels are ignored (bright), never trusted.
  nextSlot(vm, '{ now = time(), cwd = "", transport = "screenshot", strip = { on = 5, off = 0 }, replies = {} }');
  vm.run('ClaudeWoW.Connect(); STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.stripLevels'), null);
  assert.deepEqual(stripLevels(vm), [0, 255]);
  vm.run('STUB.FireEvent("SCREENSHOT_SUCCEEDED")');
  // Back on a pixel-mode bridge the strip is bright whatever levels were remembered.
  nextSlot(vm, '{ now = time(), cwd = "", transport = "pixel", replies = {} }');
  vm.run('ClaudeWoW.Connect(); STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'true');
  assert.deepEqual(stripLevels(vm), [0, 255]);
});

// Vision: a "v" flag on the record asks the bridge to attach the screenshot's
// game view to the run. Off by default; on per chat, or once with /claude-wow look.
test('vision: off by default; "vision on" flags every send and resend with v, "look" flags one message, footer and diag show it', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  const chatId = vm.evaluate('ClaudeWoWDB.chats[1].id');
  const flagsOf = (text) => (stripRecords(vm).find(r => r.text === text) || {}).flags;
  const reply = (text) => {
    const id = vm.num('ClaudeWoWDB.chats[1].pendingId');
    nextSlot(vm, `{ now = time(), cwd = "", replies = { { chat = "${chatId}", id = ${id}, status = "done", text = "${text}", agent = "claude" } } }`);
    vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
    assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].pendingId'), null);
  };
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.vision'), 'false', 'off by default');
  vm.run('ClaudeWoW.Send("plain")');
  assert.equal(flagsOf('plain'), '', 'no flag while off');
  reply('ok');
  // The footer says so, and so does diag.
  vm.run('STUB.texts = {}; ClaudeWoW.UpdateStatus()');
  assert.ok(vm.evaluate('table.concat(STUB.texts, "|")').includes('mode: pixel   vision: off'));
  vm.run('SlashCmdList.CLAUDEWOW("diag")');
  assert.ok(vm.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].text').includes('\nvision: off'));

  // "look" sends that one message with the flag; the setting stays off.
  vm.run('SlashCmdList.CLAUDEWOW("look what is this item?")');
  assert.equal(flagsOf('what is this item?'), 'v');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.vision'), 'false');
  reply('a sword');
  vm.run('SlashCmdList.CLAUDEWOW("look")');
  assert.equal(flagsOf('What do you see on my screen?'), 'v', 'a bare look asks the obvious question');
  reply('grass');
  // "look at my gear" is the command too (the whole line is the question).
  vm.run('SlashCmdList.CLAUDEWOW("look at my gear")');
  assert.equal(flagsOf('at my gear'), 'v');
  reply('fine');

  // On: every send carries it, next to the other flags, and a resend keeps it.
  vm.run('SlashCmdList.CLAUDEWOW("vision on")');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.vision'), 'true');
  let note = vm.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].text');
  assert.ok(note.includes('Vision is ON, but the bridge listens on the pixel transport'), 'told it needs the screenshot transport: ' + note);
  vm.run('STUB.texts = {}; ClaudeWoW.UpdateStatus()');
  assert.ok(vm.evaluate('table.concat(STUB.texts, "|")').includes('mode: pixel   vision: on'));
  vm.run('SlashCmdList.CLAUDEWOW("agent codex")');
  vm.run('ClaudeWoW.Send("with the picture")');
  assert.equal(flagsOf('with the picture'), 'agent=codex;v');
  vm.run('ClaudeWoW.Resend()');
  assert.equal(flagsOf('with the picture'), 'agent=codex;v', 'a resend asks again (it is a fresh screenshot)');
  reply('seen');
  vm.run('SlashCmdList.CLAUDEWOW("agent default")');
  vm.run('SlashCmdList.CLAUDEWOW("diag")');
  assert.ok(vm.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].text').includes('\nvision: on (needs the screenshot transport'));
  // On a screenshot-mode bridge the status is the happy one.
  nextSlot(vm, '{ now = time(), cwd = "", transport = "screenshot", replies = {} }');
  vm.run('ClaudeWoW.Connect(); STUB.now = STUB.now + 6; STUB.Tick()');
  vm.run('SlashCmdList.CLAUDEWOW("vision")');
  note = vm.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].text');
  assert.ok(note.startsWith('Vision is ON: each message goes out with a picture of your screen'), note);
  vm.run('ClaudeWoW.Send("dark one")');
  assert.equal(flagsOf('dark one'), 'v');
  vm.run('STUB.FireEvent("SCREENSHOT_SUCCEEDED")');
  reply('yes');
  // Off again: no flag, and the setting survives a reload (it is in the saved data).
  vm.run('SlashCmdList.CLAUDEWOW("vision off")');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.vision'), 'false');
  vm.run('ClaudeWoW.Send("no picture")');
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
  const chatId = vm.evaluate('ClaudeWoWDB.chats[1].id');
  const lines = (n) => vm.evaluate(`(function() local t = {} for _, m in ipairs(ChatFrame${n}.messages or {}) do t[#t + 1] = m.text .. " @" .. m.r .. "," .. m.g .. "," .. m.b end return table.concat(t, "\\n") end)()`) || '';
  const enter = (box, text) => vm.run(`${box}:SetText("${text}"); ${box}.scripts.OnEnterPressed(${box})`);
  const reply = (id, body) => {
    const pending = vm.num(`(select(1, (function() for _, c in ipairs(ClaudeWoWDB.chats) do if c.id == "${id}" then return c.pendingId end end end)()))`);
    nextSlot(vm, `{ now = time(), cwd = "", replies = { { chat = "${id}", id = ${pending}, ${body} } } }`);
    // Polls follow a schedule that a manual check (typing while pending) pushes out: tick until the slot is read.
    for (let i = 0; i < 8; i++) vm.run('STUB.now = STUB.now + 10; STUB.Tick()');
  };

  // Off: replies go to the game chat as before, no tab opens.
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.whisper'), 'false', 'off by default');
  vm.run('SlashCmdList.CLAUDEWOW("agent claude")');
  vm.run('ClaudeWoW.Send("hello there")');
  reply(chatId, 'status = "done", text = "plain echo", agent = "claude"');
  assert.equal(vm.num('STUB.tempWindows'), 0);
  assert.ok(vm.evaluate('table.concat(STUB.prints, "\\n")').includes('plain echo'));

  // On: the active chat's tab opens, selected, named after the chat.
  vm.run('SlashCmdList.CLAUDEWOW("whisper on")');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.whisper'), 'true');
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
  assert.ok(out.includes('|Hclaudewow:reply:' + chatId + '|h[Claude]|h whispers: hi back @1,0.5,1'), 'first line formatted as a whisper: ' + out);
  assert.ok(out.includes('second line @1,0.5,1'), 'the rest follows in whisper colour');
  assert.deepEqual(vm.evaluate('table.concat(STUB.flashed, ",")'), 'ChatFrame11', 'the tab flashed');
  assert.ok(!vm.evaluate('table.concat(STUB.prints, "\\n")').includes('hi back'), 'no duplicate in General');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].text'), 'hi back\nsecond line', 'the window has it too');

  // Typing while the agent works keeps the text as a draft and says so in the tab.
  enter('ChatFrame11EditBox', 'first');
  const before = stripRecords(vm).length;
  enter('ChatFrame11EditBox', 'too soon');
  assert.equal(stripRecords(vm).length, before, 'no second record while one is pending');
  assert.ok(lines(11).includes('still working on your last message'), 'told in the tab');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].draft'), 'too soon');
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
  vm.run('SlashCmdList.CLAUDEWOW("new Second")');
  const secondId = vm.evaluate('ClaudeWoWDB.chats[2].id');
  vm.run('ClaudeWoW.Send("second hello")');
  assert.equal(vm.num('STUB.tempWindows'), 2);
  assert.equal(vm.evaluate('ChatFrame12Tab.text'), 'Second');
  assert.ok(lines(12).includes('To Claude: second hello'));
  reply(secondId, 'status = "done", text = "for two", agent = "claude"');
  assert.ok(lines(12).includes('whispers: for two') && !lines(11).includes('for two'));
  // A system reply (bridge error) is a system line, and a denied one says what to allow.
  vm.run('ClaudeWoW.Send("again")');
  reply(secondId, 'status = "error", text = "boom"');
  assert.ok(lines(12).includes('Bridge error: boom  |Hclaudewow:open:' + secondId + '|h|cff7ec8ff[open]|r|h @1,1,0'), lines(12));
  vm.run('ClaudeWoW.Send("once more")');
  reply(secondId, 'status = "done", text = "need it", denied = { "Bash(rm:*)" }');
  assert.ok(lines(12).includes('needs permission for Bash(rm:*)'));

  // The leak filter: the server's answer to a whisper that got out becomes a loud line.
  assert.ok(vm.evaluate(`select(2, STUB.filters.CHAT_MSG_SYSTEM(nil, "CHAT_MSG_SYSTEM", "No player named 'Claude' is currently playing."))`).includes('WHISPER LEAK'));
  assert.equal(vm.evaluate(`select(2, STUB.filters.CHAT_MSG_SYSTEM(nil, "CHAT_MSG_SYSTEM", "No player named 'Bob' is currently playing."))`), null, 'other names are left alone');
  vm.run('SlashCmdList.CLAUDEWOW("whisper")');
  assert.ok(vm.evaluate('ClaudeWoWDB.chats[2].history[#ClaudeWoWDB.chats[2].history].text').includes('LEAKS: 1'));

  // Rename retitles the tab, delete closes it, off closes them all and the hooks go quiet.
  vm.run('SlashCmdList.CLAUDEWOW("rename Renamed")');
  assert.equal(vm.evaluate('ChatFrame12Tab.text'), 'Renamed');
  vm.run('SlashCmdList.CLAUDEWOW("delete")');
  assert.equal(vm.evaluate('ChatFrame12.inUse'), 'false', 'the deleted chat\'s tab is closed');
  vm.run('SlashCmdList.CLAUDEWOW("whisper off")');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.whisper'), 'false');
  assert.equal(vm.evaluate('ChatFrame11.inUse'), 'false');
  enter('ChatFrame1EditBox', '/w Claude ping');
  assert.equal(vm.num('STUB.serverSends'), 3, 'off: a whisper is the game\'s again');
});

test('plugins: a fresh install follows the bridge\'s default and sends no flag; chats from before plugins stay bound to claude-code; a new chat inherits; a restore brings the binding', () => {
  // Fresh saved data: chat 1 is bound to nothing, so a message carries no plugin flag
  // and the bridge routes it to its default (ask).
  const vm = newVM();
  login(vm);
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].plugin'), '');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.pluginsV1'), 'true');
  vm.run('STUB.RunTimers()');
  nextSlot(vm, '{ now = time(), cwd = "", plugin = "ask", plugins = { "ask", "claude-code" }, replies = {} }');
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('ClaudeWoW.IsConnected()'), 'true');
  vm.run('ClaudeWoW.Send("what drops the sword")');
  const rec = stripRecords(vm).find(r => r.text === 'what drops the sword');
  assert.equal(rec.flags, '');
  assert.equal(vm.evaluate('ClaudeWoWDB.outbox.plugin'), null);
  // A new chat inherits the binding of the chat it was made from, like the folder and the agent.
  vm.run('ClaudeWoW.NewChat("Second")');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[2].plugin'), '');
  // A restored chat comes back with the plugin the bridge's transcript names.
  const chatId = vm.evaluate('ClaudeWoWDB.chats[1].id');
  const id = vm.num('ClaudeWoWDB.chats[1].pendingId');
  const token = vm.evaluate('ClaudeWoWDB.session');
  nextSlot(vm, `{ now = time(), cwd = "", replies = { { chat = "${chatId}", id = ${id}, status = "done", text = "ok", plugin = "ask" } }, restore = { token = "${token}", chats = { { id = "old1", name = "Old work", cwd = "", plugin = "claude-code", messages = { { role = "user", id = 1, t = 1, text = "q" } } } } } }`);
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.num('#ClaudeWoWDB.chats'), 3);
  assert.equal(vm.evaluate('(function() for _, ch in ipairs(ClaudeWoWDB.chats) do if ch.id == "old1" then return ch.plugin end end end)()'), 'claude-code');

  // Saved data from before plugins existed: every chat was a coding chat, and
  // says so on the wire from now on; the migration runs once.
  const old = newVM();
  old.run('ClaudeWoWDB = { chats = { { id = "c1", name = "Old", cwd = "realms", history = {}, unread = 0, created = 1 } }, activeChat = "c1", settings = {} }');
  login(old);
  assert.equal(old.evaluate('ClaudeWoWDB.chats[1].plugin'), 'claude-code');
  connect(old);
  old.run('ClaudeWoW.Send("fix the build")');
  const coding = stripRecords(old).find(r => r.text === 'fix the build');
  assert.equal(coding.flags, 'plugin=claude-code');
  assert.equal(coding.cwd, 'realms');
  assert.equal(old.evaluate('ClaudeWoWDB.outbox.plugin'), 'claude-code');
  old.run('ClaudeWoW.Resend()');
  assert.equal(stripRecords(old).find(r => r.text === 'fix the build').flags, 'plugin=claude-code', 'a resend keeps the binding');
  old.run('ClaudeWoW.NewChat("More code")');
  assert.equal(old.evaluate('ClaudeWoWDB.chats[2].plugin'), 'claude-code', 'inherited');
  // A chat unbound later stays unbound after a reload: the migration does not run again.
  old.run('ClaudeWoWDB.chats[2].plugin = ""; STUB.FireEvent("ADDON_LOADED", "ClaudeWoW")');
  assert.equal(old.evaluate('ClaudeWoWDB.chats[2].plugin'), '');
});

test('plugins: /claude-wow plugin binds the chat like /claude-wow agent, the Plugin... menu item opens a prefilled prompt, the footer and diag show the binding', () => {
  const vm = newVM();
  login(vm);
  vm.run('STUB.RunTimers()');
  nextSlot(vm, '{ now = time(), cwd = "", plugin = "ask", plugins = { "ask", "claude-code" }, replies = {} }');
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('ClaudeWoW.IsConnected()'), 'true');
  const last = () => vm.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].text');
  const texts = () => vm.evaluate('table.concat(STUB.texts, "|")');
  assert.ok(vm.evaluate('ClaudeWoWChatMenu ~= nil') === 'true' && texts().includes('Plugin...'), 'the chat menu has a Plugin... item');
  // Bound to nothing: the footer names the bridge's default, and so does the command.
  assert.ok(texts().includes('vision: off   plugin: ask (bridge default)'), texts());
  vm.run('SlashCmdList.CLAUDEWOW("plugin")');
  assert.ok(last().startsWith('plugin is the bridge\'s default: ask'), last());
  // Bind to the coding plugin: the flag goes out with the next message, on both transports.
  vm.run('SlashCmdList.CLAUDEWOW("plugin Claude-Code")');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].plugin'), 'claude-code');
  assert.ok(last().includes('plugin set to claude-code'), last());
  vm.run('ClaudeWoW.Send("fix the build")');
  assert.equal(stripRecords(vm).find(r => r.text === 'fix the build').flags, 'plugin=claude-code');
  assert.equal(vm.evaluate('ClaudeWoWDB.outbox.plugin'), 'claude-code');
  vm.run('STUB.texts = {}; ClaudeWoW.UpdateStatus()');
  assert.ok(texts().includes('vision: off   plugin: claude-code'), texts());
  vm.run('SlashCmdList.CLAUDEWOW("diag")');
  assert.ok(last().includes('\nplugin: claude-code (bridge has: ask, claude-code)'), last());
  // An unknown plugin is refused; "default" unbinds; a message that merely starts with the word is sent.
  vm.run('SlashCmdList.CLAUDEWOW("plugin factory")');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].plugin'), 'claude-code');
  assert.ok(last().includes('Unknown plugin "factory"'), last());
  vm.run('SlashCmdList.CLAUDEWOW("plugin default")');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].plugin'), '');
  assert.ok(last().includes('plugin reset to the bridge\'s default: ask'), last());
  vm.run('SlashCmdList.CLAUDEWOW("diag")');
  assert.ok(last().includes('\nplugin: bridge default, ask (bridge has: ask, claude-code)'), last());
  vm.run('SlashCmdList.CLAUDEWOW("plugin for my warrior please")');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].plugin'), '');
  assert.ok(vm.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].role') === 'user' || vm.evaluate('ClaudeWoWDB.chats[1].draft') !== null, 'free text starting with the word is a message');
  // The Plugin... menu item opens a prompt prefilled with the chat's binding; OK applies it.
  vm.run('ClaudeWoW.SetPlugin("ask"); ClaudeWoW.PluginPrompt()');
  assert.equal(vm.evaluate('STUB.popup.which'), 'CLAUDEWOW_PLUGIN');
  assert.equal(vm.evaluate('STUB.popup.data.plugin'), 'ask');
  vm.run(`local dialog = { editBox = { GetText = function() return "claude-code" end } }
    StaticPopupDialogs.CLAUDEWOW_PLUGIN.OnAccept(dialog, STUB.popup.data)`);
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].plugin'), 'claude-code');
  // Help lists the command.
  vm.run('SlashCmdList.CLAUDEWOW("help")');
  assert.ok(last().includes('/claude-wow plugin [name]'));
});
