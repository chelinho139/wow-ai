'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');
const C = require('../bridge/campaign');
const G = require('../bridge/goals');

const ADDON = path.join(__dirname, '..', 'addon', 'ClaudeWoW');
const ADDON_FILES = ['Codec.lua', 'Inbox.lua', 'ClaudeWoW.lua', 'Orders.lua', 'DM.lua'];
const CHAR = 'Testchar-TestRealm';
const CELLS_PER_ROW = 200;
const STRIP_SECONDS = 40;
const STRIP_TRIES = 3;

const LOAD_COUNTER_STUB = `
STUB.loads = 0
local plainLoad = C_AddOns.LoadAddOn
C_AddOns.LoadAddOn = function(name)
  STUB.loads = STUB.loads + 1
  return plainLoad(name)
end
`;

const SPIES = `
STUB.dmSyncs, STUB.printed = 0, {}
local plainSync = ClaudeWoWDM.Sync
ClaudeWoWDM.Sync = function(...)
  STUB.dmSyncs = STUB.dmSyncs + 1
  return plainSync(...)
end
local plainPrint = ClaudeWoW.Print
ClaudeWoW.Print = function(msg, tag)
  table.insert(STUB.printed, msg)
  return plainPrint(msg, tag)
end
`;

const NATIVE_STUB = `
C_XMLUtil = { GetTemplateInfo = function(name) if name == "ButtonFrameTemplate" then return { type = "Frame" } end end }
local plainCreateFrame = CreateFrame
function CreateFrame(kind, name, parent, template)
  local f = plainCreateFrame(kind, name, parent, template)
  if template == "ButtonFrameTemplate" then
    f.Inset = plainCreateFrame("Frame", nil, f)
    f.SetTitle = function(self, text) self.titleText = text end
    f.SetPortraitToAsset = function(self, asset) self.portrait = asset end
  end
  return f
end
`;

const ARMED_SIGNALS = 'STUB.sounds["Interface\\\\AddOns\\\\ClaudeWoW_Runtime\\\\ctl\\\\valid.wav"] = true; STUB.armed = true';

const FAILING_STUB = `
STUB.failDm = true
local plainCreateFrame = CreateFrame
function CreateFrame(kind, name, ...)
  if name == "ClaudeWoWDMFrame" and STUB.failDm then error("no parchment today") end
  return plainCreateFrame(kind, name, ...)
end
`;

function newVM({ prelude = '', beforeLogin = '' } = {}) {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const run = (code, arg) => {
    if (lauxlib.luaL_loadstring(L, to_luastring(code)) !== lua.LUA_OK) throw new Error('Lua load: ' + to_jsstring(lua.lua_tostring(L, -1)));
    let nargs = 0;
    if (arg !== undefined) { lua.lua_pushstring(L, to_luastring(arg)); nargs = 1; }
    if (lua.lua_pcall(L, nargs, 0, 0) !== lua.LUA_OK) throw new Error('Lua error: ' + to_jsstring(lua.lua_tostring(L, -1)));
  };
  const evaluate = (expr) => {
    run(`local v = (${expr}); if v == nil then RESULT = nil else RESULT = tostring(v) end`);
    lua.lua_getglobal(L, to_luastring('RESULT'));
    const s = lua.lua_isnil(L, -1) ? null : to_jsstring(lua.lua_tolstring(L, -1));
    lua.lua_pop(L, 1);
    return s;
  };
  run(fs.readFileSync(path.join(__dirname, 'wow_stub.lua'), 'utf8'));
  run(LOAD_COUNTER_STUB);
  if (prelude) run(prelude);
  for (const f of ADDON_FILES) run(fs.readFileSync(path.join(ADDON, f), 'utf8'), 'ClaudeWoW');
  run(SPIES);
  run('STUB.FireEvent("ADDON_LOADED", "ClaudeWoW")');
  if (beforeLogin) run(beforeLogin);
  run('STUB.FireEvent("PLAYER_LOGIN")');
  run('STUB.RunTimers()');
  return { run, evaluate, num: expr => Number(evaluate(expr)) };
}

const q = s => JSON.stringify(s);

function dmLua({ rev = 1, char = CHAR, beat = null, manual = false, now = 'time()' } = {}) {
  const beatLua = beat ? `, beat = { id = ${q(beat.id)}, title = ${q(beat.title)}, lines = { ${beat.lines.map(q).join(', ')} } }` : '';
  return `{ rev = ${rev}, char = ${q(char)}, now = ${now}${manual ? ', manual = true' : ''}${beatLua} }`;
}

const BEAT1 = { id: 'b1', title: 'A story begins', lines: ['Someone left a letter in your pack.', 'Nobody saw who.'] };
const BEAT2 = { id: 'b2', title: 'The quiet road', lines: ['The road into Fixture Pines is quiet.'] };

function nextSlot(vm, dm, repliesLua = '') {
  const field = dm ? `, dm = ${dm}` : '';
  vm.run(`STUB.onLoadAddOn = function(name) ClaudeWoW_SlotData = { now = time(), cwd = "", plugin = "ask", plugins = { "ask" }, replies = { ${repliesLua} }${field} } end`);
}

function tick(vm, seconds = 6) {
  vm.run(`STUB.now = STUB.now + ${seconds}; STUB.Tick()`);
}

function pending(vm) {
  vm.run('PENDING_CHAT, PENDING_ID = nil, nil; for _, c in ipairs(ClaudeWoWDB.chats) do if c.pendingId then PENDING_CHAT, PENDING_ID = c.id, c.pendingId end end');
  return { chat: vm.evaluate('PENDING_CHAT'), id: vm.evaluate('PENDING_ID') };
}

function sendAndRead(vm, dm, text) {
  vm.run(`ClaudeWoW.Send("${text}")`);
  const p = pending(vm);
  nextSlot(vm, dm, `{ chat = "${p.chat}", id = ${p.id}, status = "done", text = "ok", agent = "", plugin = "ask" }`);
  tick(vm);
}

function shown(vm) {
  return vm.evaluate('ClaudeWoWDMFrame ~= nil and ClaudeWoWDMFrame.shown == true') === 'true';
}

function printedCount(vm, needle) {
  vm.run(`RESULT = 0
    local lines = {}
    for _, m in ipairs(STUB.prints) do lines[#lines + 1] = m end
    for _, m in ipairs(DEFAULT_CHAT_FRAME and DEFAULT_CHAT_FRAME.messages or {}) do lines[#lines + 1] = m.text end
    for _, m in ipairs(lines) do if m:find(${q(needle)}, 1, true) then RESULT = RESULT + 1 end end`);
  return vm.num('RESULT');
}

function linesIn(vm, frameName) {
  return vm.evaluate(`STUB.Lines(${frameName})`) || '';
}

function decodeStrip(vm) {
  if (vm.evaluate('ClaudeWoWStrip and ClaudeWoWStrip.shown') !== 'true') return null;
  vm.run(`
    local parts = {}
    for _, t in ipairs(ClaudeWoWStrip.textures) do
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
  const len = bytes[4] * 256 + bytes[5];
  return Buffer.from(bytes.slice(6, 6 + len)).toString('utf8');
}

function stripRecords(vm) {
  const text = decodeStrip(vm);
  if (!text) return [];
  return text.split('\x1E').map(r => {
    const p = r.split('\x1F');
    return { session: p[0], chat: p[1], id: Number(p[2]), cwd: p[3], flags: p[4], name: p[5], text: p.slice(6).join('\x1F') };
  });
}

const dmRecords = vm => stripRecords(vm).filter(r => r.flags.split(';').includes(`kind=${C.MANUAL_KIND}`));

function ack(vm, id) {
  vm.run(`STUB.sounds["Interface\\\\AddOns\\\\ClaudeWoW_Runtime\\\\ack\\\\${String(id).padStart(3, "0")}.wav"] = false`);
}

test('dm frame: appears on the natural slot load that carries a beat, drawn like the quest detail parchment', () => {
  const vm = newVM();
  nextSlot(vm, dmLua({ beat: BEAT1 }));
  tick(vm);
  assert.ok(vm.num('STUB.loads') >= 1);
  assert.equal(shown(vm), true, 'a new beat opens the frame');
  assert.equal(vm.evaluate('ClaudeWoWDMFrame.beatTitle.text'), 'A story begins');
  assert.equal(vm.evaluate('ClaudeWoWDMFrame.body.text'), 'Someone left a letter in your pack.\nNobody saw who.');
  assert.equal(vm.evaluate('ClaudeWoWDMFrame.hint.shown'), 'false', 'the next beat does not wait for /dm next');
  assert.equal(vm.evaluate('ClaudeWoWDM.debug.parchment'), 'QuestBG-Parchment');
  assert.equal(vm.evaluate('ClaudeWoWDM.debug.native.frame'), 'false', 'no C_XMLUtil in the stub: the plain frame');
  assert.equal(vm.num('ClaudeWoWDM.debug.renders'), 1);
  assert.equal(vm.evaluate('ClaudeWoWDMFrame.parchmentArea.point'), 'TOPLEFT');
  assert.equal(vm.num('ClaudeWoWDMFrame.parchmentArea.y'), -62, 'where QuestFramePanelTemplate puts its parchment');
  vm.run('RESULT = false; for _, n in ipairs(UISpecialFrames) do if n == "ClaudeWoWDMFrame" then RESULT = true end end');
  assert.equal(vm.evaluate('RESULT'), 'true', 'Escape closes it');
});

test('dm frame: ButtonFrameTemplate when the client has it; a missing atlas falls back to a plain parchment color', () => {
  const native = newVM({ prelude: NATIVE_STUB });
  nextSlot(native, dmLua({ beat: BEAT1 }));
  tick(native);
  assert.equal(native.evaluate('ClaudeWoWDM.debug.native.frame'), 'true');
  assert.equal(native.evaluate('ClaudeWoWDMFrame.template'), 'ButtonFrameTemplate');
  assert.equal(native.evaluate('ClaudeWoWDMFrame.titleText'), 'Dungeon Master');
  assert.equal(native.evaluate('ClaudeWoWDMFrame.Inset.shown'), 'false');
  assert.equal(native.evaluate('ClaudeWoWDMFrame.portrait'), 'Interface\\AddOns\\ClaudeWoW\\Portrait');
});

const TEXTURE_STUB = `
do
  local probe = CreateFrame("Frame")
  local mt = getmetatable(probe)
  local base = mt.__index
  mt.__index = function(t, k)
    if k == "SetTexture" then return function(self, file) if STUB.noTextureFile and file == "Interface\\\\QuestFrame\\\\UI-QuestLog-TopLeft" then error("no such file") end self.file = file return true end end
    if k == "SetMaxLines" then return function(self, n) self.maxLines = n end end
    return base(t, k)
  end
end
`;

test('dm frame: every fallback branch draws; the parchment is the window\'s own art: the atlas, the Classic Era quest page, then a color', () => {
  const cases = [
    ['no template, no atlas, not Era', 'C_Texture.GetAtlasExists = function() return nil end', { frame: 'false', plain: 'false', template: null, close: 'none', parchment: 'color' }],
    ['Classic Era: no template, no atlas', 'C_Texture.GetAtlasExists = function() return nil end; function GetBuildInfo() return "1.15.9", "70003", "Oct 1 2026", 11509 end', { frame: 'false', plain: 'false', template: null, close: 'none', parchment: 'Interface\\QuestFrame\\UI-QuestLog-TopLeft' }],
    ['Classic Era: the frame template, no parchment atlas', 'C_XMLUtil = { GetTemplateInfo = function(n) if n == "ButtonFrameTemplate" then return {} end end }; C_Texture.GetAtlasExists = function() return false end; function GetBuildInfo() return "1.15.9", "70003", "Oct 1 2026", 11509 end', { frame: 'true', plain: null, template: 'ButtonFrameTemplate', close: null, parchment: 'Interface\\QuestFrame\\UI-QuestLog-TopLeft' }],
    ['Classic Era, no quest page file either', 'C_Texture.GetAtlasExists = function() return nil end; STUB.noTextureFile = true; function GetBuildInfo() return "1.15.9", "70003", "Oct 1 2026", 11509 end', { frame: 'false', plain: 'false', template: null, close: 'none', parchment: 'color' }],
    ['plain templates only', 'C_XMLUtil = { GetTemplateInfo = function(n) if n == "BackdropTemplate" or n == "UIPanelCloseButton" then return {} end end }', { frame: 'false', plain: 'true', template: 'BackdropTemplate', close: 'UIPanelCloseButton', parchment: 'QuestBG-Parchment' }],
    ['GetTemplateInfo answers nil for all', 'C_XMLUtil = { GetTemplateInfo = function() return nil end }', { frame: 'false', plain: 'false', template: null, close: 'none', parchment: 'QuestBG-Parchment' }],
  ];
  for (const [why, prelude, want] of cases) {
    const vm = newVM({ prelude: `${TEXTURE_STUB}\n${prelude}` });
    nextSlot(vm, dmLua({ beat: BEAT1 }));
    tick(vm);
    assert.equal(shown(vm), true, `${why}: drawn`);
    assert.equal(vm.evaluate('ClaudeWoWDM.debug.native.frame'), want.frame, why);
    assert.equal(vm.evaluate('ClaudeWoWDM.debug.native.plain'), want.plain, why);
    assert.equal(vm.evaluate('ClaudeWoWDMFrame.template'), want.template, why);
    assert.equal(vm.evaluate('ClaudeWoWDM.debug.close'), want.close, why);
    assert.equal(vm.evaluate('ClaudeWoWDM.debug.parchment'), want.parchment, why);
    assert.equal(vm.evaluate('ClaudeWoWDM.debug.lastError'), null, why);
    assert.equal(vm.evaluate('ClaudeWoWDM.debug.parchmentSize'), '322x404', `${why}: one size for any art`);
    assert.equal(vm.num('ClaudeWoWDMFrame.parchmentArea.width'), 322, why);
    assert.equal(vm.num('ClaudeWoWDMFrame.parchmentArea.height'), 404, why);
  }
});

test('dm frame: the body is bounded so the largest beat stays on the parchment', () => {
  const vm = newVM({ prelude: TEXTURE_STUB });
  const L = name => vm.num(`ClaudeWoWDM.LAYOUT.${name}`);
  const bottom = L('parchmentTop') + L('textTop') + L('titleHeight') + L('lineGap') + L('bodyHeight');
  assert.ok(bottom <= L('parchmentTop') + L('parchmentHeight'), `the body ends at ${bottom}, inside the parchment`);
  assert.ok(bottom <= L('frameHeight') - L('hintSpace'), 'and above the hint');
  assert.ok(L('bodyMaxLines') * L('bodyLineHeight') <= L('bodyHeight'), 'the line cap fits the height');
  assert.equal(L('bodyMaxLines'), C.BODY_LINES_MAX, 'the bridge budgets the body for the same number of lines');
  const huge = Array.from({ length: 8 }, () => 'quiet '.repeat(66).trim());
  nextSlot(vm, dmLua({ beat: { ...BEAT1, lines: huge } }));
  tick(vm);
  assert.equal(vm.num('ClaudeWoWDMFrame.body.height'), L('bodyHeight'));
  assert.equal(vm.num('ClaudeWoWDMFrame.body.maxLines'), L('bodyMaxLines'), 'longer text is cut by the client with an ellipsis');
});

test('dm frame: same data does not redraw; a new beat redraws and opens; a closed frame stays closed for new lines', () => {
  const vm = newVM();
  nextSlot(vm, dmLua({ beat: BEAT1 }));
  tick(vm);
  sendAndRead(vm, dmLua({ rev: 2, beat: BEAT1 }), 'one');
  assert.equal(vm.num('ClaudeWoWDM.debug.renders'), 1, 'a new rev with the same text: no redraw');
  vm.run('ClaudeWoWDMFrame:Hide()');
  sendAndRead(vm, dmLua({ rev: 3, beat: { ...BEAT1, lines: [...BEAT1.lines, 'A live line.'] } }), 'two');
  assert.equal(vm.num('ClaudeWoWDM.debug.renders'), 2);
  assert.equal(shown(vm), false, 'live narration never reopens a frame the player closed');
  assert.match(vm.evaluate('ClaudeWoWDMFrame.body.text'), /A live line\.$/);
  sendAndRead(vm, dmLua({ rev: 4, beat: BEAT2 }), 'three');
  assert.equal(shown(vm), true, 'a new beat opens it');
  assert.equal(vm.evaluate('ClaudeWoWDMFrame.beatTitle.text'), 'The quiet road');
});

test('dm frame: a new beat in combat waits for the end of combat to open', () => {
  const vm = newVM();
  vm.run('STUB.combat = true');
  nextSlot(vm, dmLua({ beat: BEAT1 }));
  tick(vm);
  assert.equal(shown(vm), false);
  vm.run('STUB.combat = false; STUB.FireEvent("PLAYER_REGEN_ENABLED")');
  assert.equal(shown(vm), true);
  vm.run('ClaudeWoWDMFrame:Hide(); STUB.combat = true; SlashCmdList.CLAUDEWOWDM("")');
  assert.equal(shown(vm), false, '/dm in combat waits too');
  assert.equal(printedCount(vm, 'shows after combat'), 1, 'and says so');
  vm.run('STUB.combat = false; STUB.FireEvent("PLAYER_REGEN_ENABLED")');
  assert.equal(shown(vm), true);
});

test('/dm next: an old Inbox.lua read at login does not prove the bridge takes /dm next', () => {
  const stale = newVM({ beforeLogin: `ClaudeWoW_Inbox = { now = time() - 3600, replies = {}, dm = ${dmLua({ manual: true, now: 'time()' })} }` });
  stale.run('SlashCmdList.CLAUDEWOWDM("next")');
  assert.equal(dmRecords(stale).length, 0);
  assert.equal(printedCount(stale, 'cannot take /dm next'), 1);
  const fresh = newVM({ beforeLogin: `ClaudeWoW_Inbox = { now = time(), replies = {}, dm = ${dmLua({ manual: true })} }` });
  fresh.run('SlashCmdList.CLAUDEWOWDM("next")');
  assert.equal(printedCount(fresh, 'Asked the bridge for the next beat'), 1, 'a fresh one does');
});

const CHAT_LOG_API = `
SENT, LOGGING = {}, false
function SendSystemMessage(text) SENT[#SENT + 1] = text end
function LoggingChat(on) if on ~= nil then LOGGING = on end return LOGGING end
`;

test('/dm next on the chat log: an ack signal while the ack poll is pending costs one slot load, not two', () => {
  const vm = newVM({ prelude: ARMED_SIGNALS + CHAT_LOG_API });
  const slot = dm => `STUB.onLoadAddOn = function(name) ClaudeWoW_SlotData = { now = time(), cwd = "", plugin = "ask", plugins = { "ask" }, transport = "screenshot", strip = { on = 255, off = 0 }, chatlog = { line = 200, filler = 4096, key = "0123456789abcdef0123456789abcdef" }, acks = { { session = ClaudeWoWDB.session, id = ClaudeWoWDB.lastSeq } }, replies = {}, dm = ${dm} } end`;
  vm.run(slot(dmLua({ manual: true })));
  tick(vm);
  tick(vm, 30);
  assert.equal(vm.evaluate('ClaudeWoW.ChatLog.Mode()'), 'true', 'the chat log transport is on');
  const sentBefore = vm.num('#SENT');
  vm.run('SlashCmdList.CLAUDEWOWDM("next")');
  assert.ok(vm.num('#SENT') > sentBefore, 'the record went out on the chat log');
  const id = vm.num('ClaudeWoWDB.lastSeq');
  vm.run(slot(dmLua({ rev: 2, beat: BEAT1 })));
  const loads = vm.num('STUB.loads');
  ack(vm, id);
  for (let i = 0; i < 10; i++) tick(vm, 1);
  assert.equal(shown(vm), true, 'the beat arrived');
  assert.equal(vm.num('STUB.loads'), loads + 1, 'one load for the ack and the beat');
});

test('dm frame: the explicit empty field hides it; a slot without the field (an old bridge) changes nothing', () => {
  const vm = newVM();
  nextSlot(vm, dmLua({ beat: BEAT1 }));
  tick(vm);
  const syncs = vm.num('STUB.dmSyncs');
  sendAndRead(vm, null, 'old bridge');
  assert.equal(vm.num('STUB.dmSyncs'), syncs, 'no field: not even asked');
  assert.equal(shown(vm), true);
  sendAndRead(vm, dmLua({ rev: 5 }), 'campaign ended');
  assert.equal(shown(vm), false);
  vm.run('SlashCmdList.CLAUDEWOWDM("")');
  assert.equal(shown(vm), true, '/dm after the campaign ended opens the empty state');
  assert.equal(vm.evaluate('ClaudeWoWDMFrame.beatTitle.text'), 'The Dungeon Master has no story for you yet.');
});

test('the story text is drawn on the parchment frame itself, so the parchment never covers it', () => {
  const vm = newVM();
  nextSlot(vm, dmLua({ beat: BEAT1 }));
  tick(vm);
  assert.equal(shown(vm), true);
  for (const part of ['beatTitle', 'body', 'hint']) {
    assert.equal(vm.evaluate(`ClaudeWoWDMFrame.${part}:GetParent() == ClaudeWoWDMFrame.parchmentArea`), 'true', `${part} sits on the frame that holds the parchment, not under it`);
  }
  assert.equal(vm.evaluate('ClaudeWoWDMFrame.paper:GetParent() == ClaudeWoWDMFrame.parchmentArea'), 'true');
});

const WHISPER_SLOT = dm => `STUB.onLoadAddOn = function(name) ClaudeWoW_SlotData = { now = time(), cwd = "", agent = "claude", agents = { "claude" }, replies = {}, dm = ${dm} } end`;

function dockedVM(dm) {
  const vm = newVM({ prelude: 'STUB.ChatDock()' });
  vm.run(WHISPER_SLOT(dm));
  tick(vm);
  return vm;
}

test('/dm with no campaign: the same parchment frame opens with a native empty state, and /dm again hides it', () => {
  const vm = dockedVM(dmLua({}));
  assert.equal(vm.evaluate('ClaudeWoWDMFrame'), null, 'nothing drawn before /dm');
  vm.run('ChatFrame1EditBox:SetText("/dm"); STUB.PressEnter(ChatFrame1EditBox)');
  assert.equal(shown(vm), true, '/dm opens the frame');
  assert.equal(vm.evaluate('ClaudeWoWDM.debug.parchment'), 'QuestBG-Parchment', 'the same parchment art');
  assert.equal(vm.evaluate('ClaudeWoWDMFrame.beatTitle.text'), 'The Dungeon Master has no story for you yet.');
  assert.equal(vm.evaluate('ClaudeWoWDMFrame.body.text'), 'A live Claude session starts a campaign. Its first beat shows here.');
  assert.equal(vm.evaluate('ClaudeWoWDMFrame.hint.shown'), 'false');
  assert.equal(printedCount(vm, 'story'), 0, 'nothing printed instead');
  vm.run('ChatFrame1EditBox:SetText("/dm"); STUB.PressEnter(ChatFrame1EditBox)');
  assert.equal(shown(vm), false, '/dm again hides it');
});

test('/dm with a campaign waiting for /dm next: the frame shows the begin hint, and a beat replaces the empty state', () => {
  const vm = newVM();
  vm.run('SlashCmdList.CLAUDEWOWDM("")');
  assert.equal(vm.evaluate('ClaudeWoWDMFrame.beatTitle.text'), 'The Dungeon Master has no story for you yet.');
  nextSlot(vm, dmLua({ manual: true }));
  tick(vm);
  assert.equal(shown(vm), true, 'the open empty state stays open');
  assert.equal(vm.evaluate('ClaudeWoWDMFrame.beatTitle.text'), 'The story is ready.');
  assert.equal(vm.evaluate('ClaudeWoWDMFrame.hint.text'), 'Type /dm next to begin.');
  assert.equal(vm.evaluate('ClaudeWoWDMFrame.hint.shown'), 'true');
  vm.run('SlashCmdList.CLAUDEWOWDM("")');
  assert.equal(shown(vm), false);
  vm.run('SlashCmdList.CLAUDEWOWDM("")');
  assert.equal(shown(vm), true);
  assert.equal(vm.evaluate('ClaudeWoWDMFrame.hint.text'), 'Type /dm next to begin.');
  sendAndRead(vm, dmLua({ rev: 2, beat: BEAT1, manual: true }), 'go');
  assert.equal(vm.evaluate('ClaudeWoWDMFrame.beatTitle.text'), 'A story begins');
  assert.equal(vm.evaluate('ClaudeWoWDMFrame.hint.text'), 'Type /dm next when you are ready to go on.');
});

test('/dm next with no campaign: the reply lands in the chat frame the player typed in, never the Claude whisper tab', () => {
  const vm = dockedVM(dmLua({}));
  assert.equal(vm.num('STUB.tempWindows'), 1, 'the Claude whisper tab is open');
  vm.run('ClaudeWoW.Print("routing probe")');
  assert.ok(linesIn(vm, 'ChatFrame11').includes('routing probe'), 'ClaudeWoW.Print goes to the whisper tab here');
  vm.run('ChatFrame1EditBox:SetText("/dm next"); STUB.PressEnter(ChatFrame1EditBox)');
  assert.ok(!linesIn(vm, 'ChatFrame11').includes('no campaign beat'), 'not in the whisper tab');
  assert.ok(linesIn(vm, 'ChatFrame1').includes('There is no campaign beat waiting for /dm next.'), linesIn(vm, 'ChatFrame1'));
  vm.run('SlashCmdList.CLAUDEWOWDM("next")');
  assert.equal(printedCount(vm, 'There is no campaign beat waiting'), 2, 'no edit box: the default chat frame');
  assert.ok(!linesIn(vm, 'ChatFrame11').includes('no campaign beat'));
});

test('dm frame: a beat for another character, or a field with no character, stays hidden', () => {
  for (const char of ['Bone-ClassicBetaPvP2', '']) {
    const vm = newVM();
    nextSlot(vm, dmLua({ char, beat: BEAT1 }));
    tick(vm);
    assert.ok(vm.num('STUB.dmSyncs') >= 1, `${char || 'empty'}: the field was read`);
    assert.equal(shown(vm), false, `${char || 'empty'}: hidden`);
  }
  const vm = newVM();
  assert.equal(vm.evaluate('ClaudeWoWDM.CharacterKey()'), G.characterOf('Character: Testchar on Test Realm, level 23').key, 'the same key the bridge derives');
});

test('dm frame: Inbox.lua shows a fresh beat at login; an old or keyless one stays hidden; an old slot file is skipped', () => {
  const fresh = newVM({ beforeLogin: `ClaudeWoW_Inbox = { now = time(), replies = {}, dm = ${dmLua({ beat: BEAT1 })} }` });
  assert.equal(fresh.num('STUB.loads'), 0);
  assert.equal(shown(fresh), true);
  for (const [why, dm] of [['old', dmLua({ beat: BEAT1, now: 'time() - 3600' })], ['no clock', `{ rev = 1, char = "${CHAR}", beat = { id = "b1", title = "x", lines = { "y" } } }`]]) {
    const vm = newVM({ beforeLogin: `ClaudeWoW_Inbox = { now = time(), replies = {}, dm = ${dm} }` });
    assert.equal(vm.num('STUB.dmSyncs'), 1, `${why}: read`);
    assert.equal(shown(vm), false, `${why}: hidden`);
  }
  const vm = newVM();
  nextSlot(vm, dmLua({ beat: BEAT1 }));
  tick(vm);
  sendAndRead(vm, dmLua({ rev: 9, beat: BEAT2, now: 'time() - 1000' }), 'stale');
  assert.equal(vm.evaluate('ClaudeWoWDMFrame.beatTitle.text'), 'A story begins', 'an old slot file neither changes nor hides the frame');
  assert.equal(shown(vm), true);
});

test('dm frame: data is bounded and escaped', () => {
  const vm = newVM();
  const many = Array.from({ length: 20 }, (_, i) => `line ${i}`);
  nextSlot(vm, dmLua({ beat: { id: 'b1'.repeat(20), title: `a|cffff0000b ${'x'.repeat(200)}`, lines: [...many, ''] } }));
  tick(vm);
  const title = vm.evaluate('ClaudeWoWDMFrame.beatTitle.text');
  assert.ok(title.startsWith('a||cffff0000b'), 'a pipe cannot start an escape sequence');
  assert.ok(title.length <= 61, `${title.length}`);
  assert.equal(vm.evaluate('ClaudeWoWDMFrame.body.text').split('\n').length, 8);
  vm.run(`ClaudeWoWDM.Sync("x"); ClaudeWoWDM.Sync({ char = "${CHAR}", beat = { title = 7 } })`);
  assert.equal(shown(vm), false, 'a beat without a title is no beat');
});

test('dm frame: a drawing error never stops the slot read, is said once, and the same data draws once it can', () => {
  const vm = newVM({ prelude: FAILING_STUB });
  nextSlot(vm, null);
  tick(vm);
  vm.run('ClaudeWoW.Send("first")');
  let p = pending(vm);
  nextSlot(vm, dmLua({ beat: BEAT1 }), `{ chat = "${p.chat}", id = ${p.id}, status = "done", text = "the reply", agent = "", plugin = "ask" }`);
  tick(vm);
  assert.equal(pending(vm).id, null, 'the reply in the same slot still landed');
  sendAndRead(vm, dmLua({ beat: BEAT1 }), 'second');
  assert.equal(printedCount(vm, 'could not be drawn'), 1);
  vm.run('STUB.failDm = false');
  sendAndRead(vm, dmLua({ beat: BEAT1 }), 'third');
  assert.equal(shown(vm), true);
});

test('/dm next: one record with the character key, acked, then one slot load brings the beat; Tick only', () => {
  const vm = newVM({ prelude: ARMED_SIGNALS });
  nextSlot(vm, dmLua({ manual: true }));
  tick(vm);
  assert.equal(shown(vm), false, 'nothing has fired yet');
  const loads = vm.num('STUB.loads');
  const chats = vm.num('#ClaudeWoWDB.chats');
  vm.run('SlashCmdList.CLAUDEWOWDM("next")');
  const recs = dmRecords(vm);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].name, CHAR, 'the record names its character');
  assert.equal(recs[0].text, C.MANUAL_TEXT);
  assert.equal(recs[0].chat, '');
  assert.equal(vm.num('#ClaudeWoWDB.chats'), chats, 'no chat is made');
  assert.equal(printedCount(vm, 'Asked the bridge for the next beat'), 1);
  vm.run('SlashCmdList.CLAUDEWOWDM("next")');
  assert.equal(dmRecords(vm).length, 1, 'one in flight at a time');
  assert.equal(printedCount(vm, 'still on its way'), 1);
  nextSlot(vm, dmLua({ rev: 2, beat: BEAT1, manual: true }));
  ack(vm, recs[0].id);
  tick(vm, 0.5);
  assert.equal(vm.num('STUB.loads'), loads, 'no load before the bridge had a moment to publish');
  tick(vm, 1);
  assert.equal(vm.num('STUB.loads'), loads + 1, 'exactly one slot load answers the ack');
  assert.equal(shown(vm), true);
  assert.equal(vm.evaluate('ClaudeWoWDMFrame.beatTitle.text'), 'A story begins');
  assert.equal(vm.evaluate('ClaudeWoWDMFrame.hint.shown'), 'true', 'the next beat waits for /dm next too');
  assert.equal(dmRecords(vm).length, 0, 'the record left the strip');
  vm.run('SlashCmdList.CLAUDEWOWDM("next")');
  assert.equal(dmRecords(vm).length, 0, 'a second press right after is held back');
  assert.equal(printedCount(vm, 'still on its way'), 2);
  for (let i = 0; i < 20; i++) tick(vm, 9);
  assert.equal(vm.num('STUB.loads'), loads + 1, 'and nothing more');
});

test('/dm next: an ack that rides the slot files comes with the beat, so no extra slot load follows', () => {
  const vm = newVM();
  nextSlot(vm, dmLua({ manual: true }));
  tick(vm);
  vm.run('SlashCmdList.CLAUDEWOWDM("next")');
  const [rec] = dmRecords(vm);
  assert.ok(rec, 'the record went out');
  vm.run('ClaudeWoW.Send("meanwhile")');
  const p = pending(vm);
  vm.run(`STUB.onLoadAddOn = function(name) ClaudeWoW_SlotData = { now = time(), cwd = "", plugin = "ask", plugins = { "ask" }, acks = { { session = ClaudeWoWDB.session, id = ${rec.id} } }, replies = { { chat = "${p.chat}", id = ${p.id}, status = "done", text = "ok", agent = "", plugin = "ask" } }, dm = ${dmLua({ rev: 2, beat: BEAT1 })} } end`);
  tick(vm);
  assert.equal(shown(vm), true, 'the same slot read brought the beat');
  assert.equal(dmRecords(vm).length, 0, 'and acked the record');
  const loads = vm.num('STUB.loads');
  for (let i = 0; i < 5; i++) tick(vm, 1);
  assert.equal(vm.num('STUB.loads'), loads, 'no follow-up load for an ack read from a slot');
});

test('/dm next: while the first record waits for its ack, a later press adds no second one', () => {
  const vm = newVM({ prelude: ARMED_SIGNALS });
  nextSlot(vm, dmLua({ manual: true }));
  tick(vm);
  vm.run('SlashCmdList.CLAUDEWOWDM("next")');
  tick(vm, 10);
  vm.run('SlashCmdList.CLAUDEWOWDM("next")');
  assert.equal(dmRecords(vm).length, 1);
  assert.equal(printedCount(vm, 'still on its way'), 1);
});

test('/dm next: refused without the bridge capability, when nothing waits for it, and never a second copy', () => {
  const old = newVM();
  nextSlot(old, null);
  tick(old);
  old.run('ClaudeWoWDM.Sync({ char = "' + CHAR + '", manual = true, now = time() })');
  old.run('SlashCmdList.CLAUDEWOWDM("next")');
  assert.equal(dmRecords(old).length, 0, 'an old bridge would run the record as an empty prompt');
  assert.equal(printedCount(old, 'cannot take /dm next'), 1);
  const auto = newVM();
  nextSlot(auto, dmLua({ beat: BEAT1 }));
  tick(auto);
  auto.run('SlashCmdList.CLAUDEWOWDM("next")');
  assert.equal(dmRecords(auto).length, 0);
  assert.equal(printedCount(auto, 'starts on its own'), 1);
  const none = newVM();
  nextSlot(none, dmLua({}));
  tick(none);
  none.run('SlashCmdList.CLAUDEWOWDM("next")');
  assert.equal(dmRecords(none).length, 0);
  none.run('SlashCmdList.CLAUDEWOWDM("dance")');
  assert.equal(printedCount(none, '/dm next goes on to the next beat'), 1);
});

test('/dm next: a record the bridge never acks is dropped after its tries, without marking the transport failed', () => {
  const vm = newVM();
  nextSlot(vm, dmLua({ manual: true }));
  tick(vm);
  vm.run('ClaudeWoW.BridgeState = function() return "ok", 0, 0, 0, "" end');
  vm.run('SlashCmdList.CLAUDEWOWDM("next")');
  assert.equal(dmRecords(vm).length, 1);
  for (let i = 0; i <= STRIP_TRIES; i++) tick(vm, STRIP_SECONDS + 1);
  assert.equal(dmRecords(vm).length, 0, 'gone from the strip');
  assert.equal(vm.evaluate('ClaudeWoW.IsConnected()'), 'true', 'no pixelFailed for a control record');
  vm.run('SlashCmdList.CLAUDEWOWDM("next")');
  assert.equal(dmRecords(vm).length, 1, 'the player can try again');
});

test('dm frame: the module sends nothing to chat and no addon file calls SendChatMessage', () => {
  const src = fs.readFileSync(path.join(ADDON, 'DM.lua'), 'utf8');
  for (const name of ['SendChatMessage', 'SendAddonMessage', 'C_ChatInfo', 'ChatFrame_OpenChat', 'ChatFrameUtil', 'RunMacro', 'RunScript', 'loadstring', 'CastSpell', 'UseAction', 'LoadAddOn', 'SetBinding']) {
    assert.ok(!src.includes(name), `DM.lua does not use ${name}`);
  }
  for (const f of fs.readdirSync(ADDON).filter(n => n.endsWith('.lua') && n !== 'Widgets.lua')) {
    assert.ok(!/SendChatMessage\s*\(/.test(fs.readFileSync(path.join(ADDON, f), 'utf8')), `${f} never calls SendChatMessage`);
  }
  assert.match(fs.readFileSync(path.join(ADDON, 'Widgets.lua'), 'utf8'), /"SendChatMessage"/, 'Widgets.lua names it only in its deny list');
  const vm = newVM();
  const before = vm.num('#STUB.chatSent');
  nextSlot(vm, dmLua({ manual: true, beat: BEAT1 }));
  tick(vm);
  vm.run('SlashCmdList.CLAUDEWOWDM(""); SlashCmdList.CLAUDEWOWDM(""); SlashCmdList.CLAUDEWOWDM("next")');
  assert.equal(vm.num('#STUB.chatSent'), before);
  assert.equal(vm.evaluate('ClaudeWoWDB.dm'), null, 'no saved variables of its own');
});
