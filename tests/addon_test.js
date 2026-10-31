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
function decodeStrip(vm) {
  if (vm.evaluate('WoWAIStrip and WoWAIStrip.shown') !== 'true') return null;
  vm.run(`
    local parts = {}
    for _, t in ipairs(WoWAIStrip.textures) do
      if t.shown and t.color then
        local c, r = math.floor(t.x / 4), math.floor(-t.y / 4)
        local v = (t.color[1] >= 0.5 and 4 or 0) + (t.color[2] >= 0.5 and 2 or 0) + (t.color[3] >= 0.5 and 1 or 0)
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

function stripRecords(vm) {
  const frame = decodeStrip(vm);
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

test('on a retail client the context names the specialization, loadout and professions instead of talent tabs and skill lines', () => {
  const vm = newVM();
  vm.run(`
    function GetBuildInfo() return "11.2.5", "63906", "Oct 7 2025", 110205 end
    function GetLocale() return "esES" end
    GetNumTalentTabs, GetTalentTabInfo, GetNumSkillLines, GetSkillLineInfo = nil, nil, nil, nil
    function GetSpecialization() return 2 end
    function GetSpecializationInfo(i) if i == 2 then return 254, "Puntería", "", 0, "DAMAGER" end end
    C_ClassTalents = { GetLastSelectedSavedConfigID = function(specID) if specID == 254 then return 77 end end }
    C_Traits = { GetConfigInfo = function(id) if id == 77 then return { ID = 77, name = "Raid ST" } end end }
    function GetProfessions() return 3, nil, nil, 9, 10 end
    local P = { [3] = { "Desuello", 100, 100 }, [9] = { "Pesca", 12, 300 }, [10] = { "Cocina", 5, 300 } }
    function GetProfessionInfo(i) local p = P[i]; if p then return p[1], 0, p[2], p[3] end end
  `);
  const lines = vm.evaluate('WoWAI.GameContext()').split('\n');
  assert.equal(lines[0], 'Game: World of Warcraft (retail) (client 11.2.5.63906, interface 110205, locale esES)');
  assert.ok(lines.includes('Specialization: Puntería (loadout: Raid ST)'), lines.join('\n'));
  assert.ok(lines.includes('Professions: Desuello 100/100, Pesca 12/300, Cocina 5/300'), lines.join('\n'));
  assert.ok(!lines.some(l => l.startsWith('Talents:')));
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

test('without the sound channel the first minute after a send is polled every 4 s; with it, on the usual schedule', () => {
  const loadsInFirstMinute = (sound) => {
    const vm = newVM();
    if (sound) vm.run('STUB.sounds["Interface\\\\AddOns\\\\WoWAI\\\\ctl\\\\valid.wav"] = true');
    login(vm);
    connect(vm);
    vm.run('WoWAI.Send("hello world")');
    vm.run('STUB.loadCount = 0; STUB.onLoadAddOn = function(name) STUB.loadCount = STUB.loadCount + 1; WoWAI_SlotData = { now = time(), cwd = "", replies = {} } end');
    for (let t = 0; t < 60; t += 2) vm.run('STUB.now = STUB.now + 2; STUB.Tick()');
    assert.notEqual(vm.evaluate('WoWAIDB.chats[1].pendingId'), null, 'still waiting');
    return vm.num('STUB.loadCount');
  };
  assert.equal(loadsInFirstMinute(false), 15, 'every 4 s, 4..60');
  assert.equal(loadsInFirstMinute(true), 7, '5, 10, 16, 24, 34, 46, 60');
});

test('/wow-ai probe finds which check tells empty from valid and follows the tick file', () => {
  const P = 'Interface\\\\AddOns\\\\WoWAI\\\\ctl\\\\probe\\\\';
  const runProbe = (flip) => {
    const vm = newVM();
    login(vm);
    // Like the Firestorm client: every existing .wav "plays", empty or not.
    vm.run(`for _, n in ipairs({ "empty", "valid", "tick" }) do STUB.sounds["${P}" .. n .. ".wav"] = true end`);
    vm.run(`STUB.files["${P}valid.ttf"] = true; STUB.files["${P}valid.tga"] = true; STUB.sounds["${P}valid.mp3"] = true`);
    vm.run('SlashCmdList.WOWAI("probe")');
    for (let step = 1; step <= 30; step++) {
      if (flip) {
        const on = Math.floor(step / 5) % 2 === 1;
        vm.run(`STUB.files["${P}tick.ttf"] = ${on}`);
        // The mp3 is seen filled once and then stays "valid": a cached file.
        if (step === 7) vm.run(`STUB.sounds["${P}tick.mp3"] = true`);
      }
      vm.run('STUB.RunTimers()');
    }
    return vm;
  };
  const vm = runProbe(true);
  assert.equal(vm.evaluate('WoWAIDB.probe.best'), 'font return');
  assert.equal(vm.evaluate('WoWAIDB.probe.verdict["wav sound"]'), 'no', 'empty wav plays too');
  assert.equal(vm.evaluate('WoWAIDB.probe.verdict["mp3 sound"]'), 'fill only');
  for (const v of ['font path', 'font width']) assert.equal(vm.evaluate(`WoWAIDB.probe.verdict["${v}"]`), 'useful', v);
  assert.equal(vm.evaluate('WoWAIDB.probe.verdict["texture loaded"]'), 'no', 'the tick texture never changed');
  const report = vm.evaluate('WoWAIDB.probe.report');
  assert.match(report, /"font return" works on this client/);
  assert.match(report, /wav sound: empty 1, valid 1, missing 0, tick 1+ -> no/);
  assert.match(vm.evaluate('WoWAIDB.chats[1].history[#WoWAIDB.chats[1].history].text'), /^Probe: "font return"/);
  vm.run('SlashCmdList.WOWAI("diag")');
  assert.match(vm.evaluate('WoWAIDB.chats[1].history[#WoWAIDB.chats[1].history].text'), /probe: 12:00, works: font return/);

  // Nothing flips the tick files: no bridge, or nothing follows them.
  const idle = runProbe(false);
  assert.equal(idle.evaluate('WoWAIDB.probe.best'), null);
  assert.match(idle.evaluate('WoWAIDB.probe.report'), /^Probe: no check followed the tick file/);
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

test('a denied reply shows Allow once and Always; once resends the rules flagged for one run, Always without the flag', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  const deny = (n) => {
    vm.run(`WoWAI.Send("search for it ${n}")`);
    const chatId = vm.evaluate('WoWAIDB.chats[1].id');
    const id = vm.num('WoWAIDB.chats[1].pendingId');
    nextSlot(vm, `{ now = time(), cwd = "", replies = { { chat = "${chatId}", id = ${id}, status = "done", text = "need permission", denied = { "WebSearch", "Bash(cargo:*)" } } } }`);
    vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
    assert.equal(vm.evaluate('WoWAIDB.chats[1].history[#WoWAIDB.chats[1].history].denied[2]'), 'Bash(cargo:*)');
    return { chatId, id };
  };
  let { chatId, id } = deny(1);
  vm.run(`WoWAI.Allow("${chatId}", { "WebSearch", "Bash(cargo:*)" }, false)`);
  let rec = stripRecords(vm).find(r => r.flags.includes('allow='));
  assert.ok(rec, 'allow record on the strip');
  assert.equal(rec.flags, 'allow=WebSearch,Bash(cargo:*);once');
  assert.equal(rec.id, id + 1);
  assert.equal(vm.evaluate('WoWAIDB.outbox.allowOnce'), 'true', 'the reload path says "once" too');
  assert.ok(vm.evaluate('WoWAIDB.chats[1].history[#WoWAIDB.chats[1].history - 1].text').startsWith('Allowed once: '));

  // Answer the retry, get refused again, and this time save the rules.
  nextSlot(vm, `{ now = time(), cwd = "", replies = { { chat = "${chatId}", id = ${id + 1}, status = "done", text = "ok" } } }`);
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  ({ chatId, id } = deny(2));
  vm.run(`WoWAI.Allow("${chatId}", { "WebSearch", "Bash(cargo:*)" }, true)`);
  rec = stripRecords(vm).find(r => r.id === id + 1);
  assert.equal(rec.flags, 'allow=WebSearch,Bash(cargo:*)');
  assert.equal(vm.evaluate('WoWAIDB.outbox.allowOnce'), null);
});

// A retail-looking client: trait trees, item levels, the mount journal and C_QuestLog.
const RETAIL_STUBS = `
  function GetLocale() return "esES" end
  GetNumTalentTabs, GetTalentTabInfo = nil, nil
  function GetSpecialization() return 3 end
  function GetSpecializationInfo(i) if i == 3 then return 267, "Destrucción" end end
  C_Spell = {
    GetSpellName = function(id) return ({ [1] = "Inmolar", [2] = "Conflagrar" })[id] end,
    -- Markup and line breaks as tooltips have them; a long one made of 2-byte characters.
    GetSpellDescription = function(id)
      if id == 2 then return "|cffffffffQuema|r al\\nobjetivo." end
      if id == 1 then return string.rep("á", 100) end
    end,
  }
  local NODES = {
    [10] = { ID = 10, currentRank = 1, maxRanks = 1, posX = 5, posY = 2, isVisible = true, activeEntry = { entryID = 100 } },
    [11] = { ID = 11, currentRank = 2, maxRanks = 2, posX = 1, posY = 2, isVisible = true, activeEntry = { entryID = 110 } },
    [12] = { ID = 12, currentRank = 0, maxRanks = 1, posX = 1, posY = 1, isVisible = true, entryIDs = { 120 } },
    [13] = { ID = 13, currentRank = 1, maxRanks = 1, posX = 9, posY = 0, isVisible = true, activeEntry = { entryID = 130 } },
    [14] = { ID = 14, currentRank = 1, maxRanks = 1, posX = 9, posY = 1, isVisible = true, subTreeID = 7, subTreeActive = true, activeEntry = { entryID = 140 } },
    [15] = { ID = 15, currentRank = 1, maxRanks = 1, posX = 9, posY = 1, isVisible = true, subTreeID = 8, subTreeActive = false, activeEntry = { entryID = 150 } },
  }
  local ENTRIES = { [100] = { definitionID = 1000 }, [110] = { definitionID = 1100 }, [120] = { definitionID = 1200 },
    [130] = { subTreeID = 7 }, [140] = { definitionID = 1400 }, [150] = { definitionID = 1500 } }
  local DEFS = { [1000] = { spellID = 1 }, [1100] = { spellID = 2 }, [1200] = { overrideName = "Nunca" },
    [1400] = { overrideName = "Ritual diabólico" }, [1500] = { overrideName = "Otra rama" } }
  C_ClassTalents = { GetActiveConfigID = function() return 5 end, GetLastSelectedSavedConfigID = function(specID) if specID == 267 then return 9 end end }
  C_Traits = {
    GetConfigInfo = function(id) if id == 5 then return { ID = 5, treeIDs = { 1 } } elseif id == 9 then return { ID = 9, name = "Raid ST" } end end,
    GetTreeNodes = function(tree) return { 10, 11, 12, 13, 14, 15 } end,
    GetNodeInfo = function(cfg, id) return NODES[id] end,
    GetEntryInfo = function(cfg, id) return ENTRIES[id] end,
    GetDefinitionInfo = function(id) return DEFS[id] end,
    GetSubTreeInfo = function(cfg, id) if id == 7 then return { ID = 7, name = "Diabolista" } end end,
    GetTreeCurrencyInfo = function(cfg, tree) return { { traitCurrencyID = 1, quantity = 2 }, { traitCurrencyID = 2, quantity = 0 } } end,
  }
  HEADSLOT, MAINHANDSLOT = "Cabeza", "Mano principal"
  function GetAverageItemLevel() return 48.2, 45.5 end
  function GetInventoryItemLink(unit, slot)
    if slot == 1 then return "|cff1eff00|Hitem:2140::::::::16:::::|h[Fine Longsword]|h|r" end
    if slot == 16 then return "|cffffffff|Hitem:99::::::::16:::::|h[Bastón viejo]|h|r" end
  end
  C_Item.GetDetailedItemLevelInfo = function(link) if link:find("item:2140") then return 47 end return 40 end
  C_Item.GetItemInfoInstant = function(link)
    if tostring(link):find("item:99") then return 99, "Arma", STUB.weaponType or "Bastones", STUB.weaponLoc or "INVTYPE_2HWEAPON" end
  end
  -- The client takes a full link here; the shared stub only knows bare "item:" strings.
  C_Item.GetItemInfo = function(link) if tostring(link):find("item:2140") then return "Fine Longsword", link, 2 end end
  SPELL_STAT4_NAME = "Intelecto"
  function UnitStat(unit, i) if i == 4 then return 300, 312 end end
  function GetSpellCritChance() return 12.34 end
  function GetHaste() return 8 end
  BATTLE_PET_SOURCE_3, BATTLE_PET_SOURCE_10 = "Vendedor", "Tienda"
  local MOUNTS = {
    [1] = { "Lobo", 3, false, true }, [2] = { "Raptor", 3, false, false }, [3] = { "Zancudo", 3, false, false },
    [4] = { "Caballo de la Alianza", 3, true, false }, [5] = { "Dragón de tienda", 10, false, false },
  }
  C_MountJournal = {
    GetMountIDs = function() return { 1, 2, 3, 4, 5 } end,
    GetMountInfoByID = function(id) local m = MOUNTS[id]; return m[1], 100 + id, 0, false, true, m[2], false, false, nil, m[3], m[4], id end,
  }
  local LOG = {
    { title = "Dragonflight", isHeader = true }, -- a group header with no quest under it
    { title = "Bosque Canción Eterna", isHeader = true },
    { title = "Lobos hambrientos", questID = 101 },
    { title = "Entrega del correo", questID = 49930 },
  }
  local OBJ = { [101] = { { text = "Lobos sarnosos: 3/8", finished = false }, { text = "Habla con Lana", finished = true } }, [49930] = {} }
  C_QuestLog = {
    GetNumQuestLogEntries = function() return #LOG end,
    GetInfo = function(i) return LOG[i] end,
    IsComplete = function(id) return id == 49930 end,
    GetQuestObjectives = function(id) return OBJ[id] end,
  }
`;

// The record the last /ai <attachment> put on the strip, by the start of its text.
function sentStartingWith(vm, start) {
  return stripRecords(vm).find(r => r.text.startsWith(start));
}

test('/ai talentos sends the build in use: names, ranks and descriptions top to bottom, the hero tree, unspent points', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  vm.run(RETAIL_STUBS);
  vm.run('SlashCmdList.WOWAI("talentos")');
  const rec = sentStartingWith(vm, 'Revisa mis talentos.');
  assert.ok(rec, 'sent with the Spanish default question');
  assert.equal(rec.text, [
    'Revisa mis talentos.',
    '',
    'Talents, read from the game:',
    'Specialization: Destrucción (loadout Raid ST)',
    'Unspent talent points: 2',
    'Class and spec talents, top to bottom (2):',
    '- Conflagrar 2/2: Quema al objetivo.',
    '- Inmolar: ' + 'á'.repeat(68) + '...',
    'Hero talents (Diabolista):',
    '- Ritual diabólico',
  ].join('\n'));
  // A question typed after the command replaces the default one.
  vm.run('STUB.now = STUB.now + 1; WoWAI.NewChat("Otro"); SlashCmdList.WOWAI("talents is Conflagrar worth it?")');
  assert.ok(sentStartingWith(vm, 'is Conflagrar worth it?\n\nTalents, read from the game:\n'));
});

test('/ai equipo, /ai monturas and /ai misiones attach gear, the mount collection and the quest log', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  vm.run(RETAIL_STUBS);
  vm.run('SlashCmdList.WOWAI("equipo que mejoro?")');
  let rec = sentStartingWith(vm, 'que mejoro?');
  assert.ok(rec);
  const gear = rec.text.split('\n');
  assert.equal(gear[2], 'Equipped gear, read from the game:');
  assert.ok(gear[3].startsWith('Average item level equipped: 45.5; empty slots: 13 (Neck, Shoulder, '), gear[3]);
  assert.ok(!rec.text.includes('48.2'), 'the "overall" average is not passed on as gear in the bags');
  assert.ok(gear.includes('Cabeza: Fine Longsword (ilvl 47, Uncommon)'), rec.text);
  assert.ok(gear.includes('Mano principal: Bastón viejo (ilvl 40, Bastones, two-handed)'), rec.text);
  assert.ok(gear.includes('Neck: (empty)'), 'an empty slot is listed, by its English name when the client has no global for it');
  assert.ok(!rec.text.includes('Off hand'), 'an empty off hand is left out behind a two-handed weapon');
  // A one-handed weapon leaves the off hand free: that empty slot counts.
  vm.run('STUB.weaponType, STUB.weaponLoc = "Dagas", "INVTYPE_WEAPON"');
  const oneHand = vm.evaluate('WoWAI.GearText()').split('\n');
  assert.ok(oneHand.includes('Mano principal: Bastón viejo (ilvl 40, Dagas)'), oneHand.join('\n'));
  assert.ok(oneHand.includes('Off hand: (empty)'));
  assert.ok(oneHand[0].includes('empty slots: 14 ('), oneHand[0]);
  assert.equal(gear[gear.length - 1], 'Stats: Intelecto 312, crit 12.3%, haste 8.0%');

  vm.run('WoWAI.NewChat("m"); SlashCmdList.WOWAI("monturas")');
  rec = sentStartingWith(vm, '¿Qué monturas');
  assert.ok(rec);
  assert.ok(rec.text.endsWith([
    'Mount collection, read from the game:',
    'Mounts: 1 collected of 4 this character can see; 3 missing',
    'Collected (1): Lobo',
    'Missing by source: Vendedor 2, Tienda 1',
    'Examples missing, Vendedor: Raptor, Zancudo',
  ].join('\n')), rec.text);

  vm.run('WoWAI.NewChat("q"); SlashCmdList.WOWAI("misiones")');
  rec = sentStartingWith(vm, 'Ayúdame con mis misiones');
  assert.ok(rec.text.endsWith([
    'Quest log, read from the game:',
    '== Bosque Canción Eterna',
    '101 Lobos hambrientos',
    '  - Lobos sarnosos: 3/8',
    '  - Habla con Lana (done)',
    '49930 Entrega del correo - ready to turn in',
  ].join('\n')), rec.text);
  assert.ok(!rec.text.includes('Dragonflight'), 'a header with no quest under it is left out');
});

test('the context lists quests with their titles while they fit, then ids only, never over the cap', () => {
  const vm = newVM();
  vm.run(RETAIL_STUBS);
  let ctx = vm.evaluate('WoWAI.GameContext()');
  assert.ok(ctx.split('\n').includes('Quest log (id, * = ready to turn in, title): 101 Lobos hambrientos; 49930* Entrega del correo'), ctx);
  // A full log of long titles: the first ones keep theirs, every id is still there.
  vm.run(`
    local log = {}
    for i = 1, 35 do log[i] = { title = "Una mision con un titulo bastante largo " .. i, questID = 1000 + i } end
    C_QuestLog.GetNumQuestLogEntries = function() return #log end
    C_QuestLog.GetInfo = function(i) return log[i] end
  `);
  ctx = vm.evaluate('WoWAI.GameContext()');
  assert.ok(ctx.length <= 900, `context is ${ctx.length} bytes`);
  const line = ctx.split('\n').find(l => l.startsWith('Quest log'));
  assert.ok(line.includes('1001 Una mision con un titulo bastant;'), 'early quests keep a title, cut to 32 characters');
  for (let i = 1; i <= 35; i++) assert.ok(line.includes(String(1000 + i)), 'quest ' + (1000 + i) + ' is listed');
  assert.ok(line.endsWith('; 1035'), 'the last ones are ids only');
});

test('a big mount collection keeps every source count and stays within the attachment budget', () => {
  const vm = newVM();
  vm.run(RETAIL_STUBS);
  vm.run(`
    for i = 1, 12 do _G["BATTLE_PET_SOURCE_" .. i] = "Origen" .. i end
    C_MountJournal.GetMountIDs = function() local t = {} for i = 1, 1000 do t[i] = i end return t end
    C_MountJournal.GetMountInfoByID = function(id) return "Montura de nombre largo " .. id, id, 0, false, true, (id % 12) + 1, false, false, nil, false, id <= 50, id end
  `);
  const text = vm.evaluate('WoWAI.MountsText()');
  assert.ok(text.length <= 2000, `${text.length} bytes`);
  const counts = text.split('\n').find(l => l.startsWith('Missing by source: '));
  for (let i = 1; i <= 12; i++) assert.ok(counts.includes('Origen' + i + ' '), 'source ' + i + ' counted');
  assert.ok(text.includes('Collected (50): Montura de nombre largo 1, '), 'owned mounts by name');
  assert.ok(text.includes('Examples missing, Origen'), 'some names as examples');
});

test('/ai monturas with a question says, for each mount it names, whether it is collected', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  vm.run(RETAIL_STUBS);
  vm.run('SlashCmdList.WOWAI("monturas ¿tengo el raptor o el lobo?")');
  const rec = sentStartingWith(vm, '¿tengo el raptor o el lobo?');
  assert.ok(rec);
  assert.ok(rec.text.includes('\nMatching "raptor" (1): Raptor (missing, Vendedor)\nMatching "lobo" (1): Lobo (have)\n'), rec.text);
  // A name the journal doesn't have is said so, not guessed.
  const none = vm.evaluate('WoWAI.MountsText("tengo el grifo dorado")');
  assert.ok(none.includes('Matching the question: none;'), none);
  // Accented words survive the split ("á" shares a byte with "¡"), and accents don't matter either way.
  assert.ok(vm.evaluate('WoWAI.MountsText("¡Dragón de tienda!")').includes('Dragón de tienda (missing, Tienda)'));
  assert.ok(vm.evaluate('WoWAI.MountsText("dragon")').includes('Matching "dragon" (1): Dragón de tienda (missing, Tienda)'));
  assert.ok(vm.evaluate('WoWAI.MountsText("ZANCÚDO")').includes('Zancudo (missing, Vendedor)'));
});

test('a mount question naming several kinds gives each kind its share of the room', () => {
  const vm = newVM();
  vm.run(RETAIL_STUBS);
  vm.run(`
    local kinds = { "Halcón zancudo", "Kodo", "Lobo", "Raptor" }
    C_MountJournal.GetMountIDs = function() local t = {} for i = 1, 400 do t[i] = i end return t end
    C_MountJournal.GetMountInfoByID = function(id)
      return kinds[(id % 4) + 1] .. " de color numero " .. id, id, 0, false, true, 3, false, false, nil, false, id % 10 == 0, id
    end
  `);
  const text = vm.evaluate('WoWAI.MountsText("halcón zancudo kodo lobo raptor")');
  assert.ok(text.length <= 2000, `${text.length} bytes`);
  for (const w of ['halcon', 'kodo', 'lobo', 'raptor']) { // words are matched (and shown) without accents
    assert.ok(new RegExp(`\\nMatching "${w}" \\(100\\): \\S`).test(text), w + ' has its own line with names: ' + text);
  }
  assert.ok(!text.includes('Matching "zancudo"'), 'a word already matched by an earlier one adds no empty group');
  // Owned ones (every tenth id, so hawkstriders and wolves here) lead their group.
  assert.match(text, /\nMatching "lobo" \(100\): Lobo de color numero 10 \(have\), Lobo de color numero 110 \(have\), /);
});

test('owned mounts lead a cut match list', () => {
  const vm = newVM();
  vm.run(RETAIL_STUBS);
  vm.run(`
    C_MountJournal.GetMountIDs = function() local t = {} for i = 1, 60 do t[i] = i end return t end
    C_MountJournal.GetMountInfoByID = function(id)
      return (id == 60 and "Zzz raptor viejo" or ("Raptor numero " .. id)), id, 0, false, true, 3, false, false, nil, false, id == 60, id
    end
  `);
  const line = vm.evaluate('WoWAI.MountsText("raptor")').split('\n').find(l => l.startsWith('Matching'));
  assert.ok(line.startsWith('Matching "raptor" (60): Zzz raptor viejo (have), '), line);
  assert.match(line, /\+\d+ more$/, 'the list is cut, and the owned one is still in it');
});

test('an attachment the client cannot provide is explained in the chat and nothing is sent', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  vm.run('C_MountJournal = nil; SlashCmdList.WOWAI("mounts")');
  assert.equal(vm.evaluate('WoWAIDB.chats[1].pendingId'), null);
  assert.equal(vm.evaluate('WoWAIDB.chats[1].history[#WoWAIDB.chats[1].history].text'), 'Could not read mount collection: this client has no mount journal');
});

test('/wow-ai resend puts the message back with the flags it went out with', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  vm.run('SlashCmdList.WOWAI("agent grok"); SlashCmdList.WOWAI("reset"); WoWAI.Send("start over")');
  assert.equal(sentStartingWith(vm, 'start over').flags, 'n;agent=grok');
  vm.run('WoWAI.Resend()');
  assert.equal(sentStartingWith(vm, 'start over').flags, 'n;agent=grok', 'the fresh-session mark survives a resend');
});

test('the addon\'s own commands typed in its input box run locally instead of going to the agent', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  vm.run('WoWAIInput:SetText("/wow-ai new Second"); WoWAI.SendFromInput()');
  assert.equal(vm.evaluate('WoWAIDB.chats[#WoWAIDB.chats].name'), 'Second', 'ran as a command');
  assert.equal(vm.evaluate('WoWAIDB.outbox'), null, 'nothing sent');
  // Other slash lines are messages: the player may be asking about a macro.
  vm.run('WoWAIInput:SetText("/cast [@mouseover] Inmolar is this right?"); WoWAI.SendFromInput()');
  assert.ok(stripRecords(vm).some(r => r.text === '/cast [@mouseover] Inmolar is this right?'));
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
