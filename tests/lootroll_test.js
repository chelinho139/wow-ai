'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');

const ADDON = path.join(__dirname, '..', 'addon', 'ClaudeWoW');
const CELLS_PER_ROW = 200;

const SOUND_STUB = `
STUB.played = {}
SOUNDKIT = { UI_EPICLOOT_TOAST = 31578, UI_NEED_ROLL_POSITIVE = 229319, LOOT_WINDOW_COIN_SOUND = 120, UI_NEED_ROLL_NEGATIVE = 229321 }
local SOUND_NAMES = {}
for name, id in pairs(SOUNDKIT) do SOUND_NAMES[id] = name end
function PlaySound(id) if SOUND_NAMES[id] then table.insert(STUB.played, SOUND_NAMES[id]) end end
function PlaySoundFile(path) if STUB.sounds[path] then return true, 1 end return false end
`;

function newVM({ withRollModule = true } = {}) {
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
  const num = (expr) => Number(evaluate(expr));
  run(fs.readFileSync(path.join(__dirname, 'wow_stub.lua'), 'utf8'));
  run(SOUND_STUB);
  const files = ['Codec.lua', 'Inbox.lua', 'ClaudeWoW.lua'].concat(withRollModule ? ['LootRoll.lua'] : []);
  for (const f of files) run(fs.readFileSync(path.join(ADDON, f), 'utf8'), 'ClaudeWoW');
  run('STUB.FireEvent("ADDON_LOADED", "ClaudeWoW"); STUB.FireEvent("PLAYER_LOGIN")');
  run('STUB.RunTimers()');
  run('STUB.onLoadAddOn = function(name) ClaudeWoW_SlotData = { now = time(), cwd = "", replies = {} } end');
  run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(evaluate('ClaudeWoW.IsConnected()'), 'true');
  return { run, evaluate, num };
}

function stripFlags(vm) {
  if (vm.evaluate('ClaudeWoWStrip and ClaudeWoWStrip.shown') !== 'true') return [];
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
  const payload = Buffer.from(bytes.slice(6, 6 + len)).toString('utf8');
  return payload.split('\x1E').map(r => ({ flags: r.split('\x1F')[4], text: r.split('\x1F').slice(-1)[0] }));
}

function deliverDenial(vm, rules, agent = 'claude', chatIndex = 1) {
  vm.run('ClaudeWoW.Send("clean the build folder")');
  const chatId = vm.evaluate(`ClaudeWoWDB.chats[${chatIndex}].id`);
  const id = vm.num(`ClaudeWoWDB.chats[${chatIndex}].pendingId`);
  const luaRules = rules.map(r => JSON.stringify(r)).join(', ');
  vm.run(`STUB.onLoadAddOn = function(name) ClaudeWoW_SlotData = { now = time(), cwd = "", replies = { { chat = "${chatId}", id = ${id}, status = "done", text = "I need permission", agent = "${agent}", denied = { ${luaRules} } } } } end`);
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate(`ClaudeWoWDB.chats[${chatIndex}].pendingId`), null);
  return { chatId, id };
}

const lastHistory = 'ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history]';

test('a denied reply pops the roll frame: epic name, scroll icon and the epic loot sound', () => {
  const vm = newVM();
  deliverDenial(vm, ['Bash(rm:*)', 'WebFetch']);
  assert.equal(vm.evaluate('ClaudeWoWRollFrame.shown'), 'true');
  assert.equal(vm.evaluate('ClaudeWoWRollFrame.Name.text'), 'Scroll of rm +1');
  assert.equal(vm.evaluate('ClaudeWoWRollFrame.IconFrame.Icon.texture'), 'Interface\\Icons\\INV_Scroll_03');
  assert.equal(vm.evaluate('table.concat(STUB.played, ",")'), 'UI_EPICLOOT_TOAST');
  assert.equal(vm.num('ClaudeWoWRoll.Current() and 1 or 0'), 1);
  assert.equal(vm.evaluate('ClaudeWoWRoll.Current().rules[2]'), 'WebFetch');
  vm.run('ClaudeWoWRollFrame.scripts.OnUpdate(ClaudeWoWRollFrame, 0)');
  assert.equal(vm.evaluate('ClaudeWoWRollFrame.shown'), 'true', 'the roll stays open while time is left');
  vm.run('ClaudeWoW.Render()');
  assert.equal(vm.evaluate('table.concat(STUB.played, ",")'), 'UI_EPICLOOT_TOAST', 'a redraw does not offer the same roll twice');
  vm.run('RESULT = "false"; for _, f in ipairs(STUB.frames) do if f.template == "UIPanelButtonTemplate" and f.rules and f.shown then RESULT = "true" end end');
  assert.equal(vm.evaluate('RESULT'), 'false', 'the old Allow & retry button is hidden while the roll frame handles it');
});

test('item names and icons: a command prefix is a scroll, any other tool is a gear', () => {
  const vm = newVM();
  assert.equal(vm.evaluate('ClaudeWoWRoll.CommandOf("Bash(cargo:*)")'), 'cargo');
  assert.equal(vm.evaluate('ClaudeWoWRoll.CommandOf("Bash(npm test)")'), 'npm test');
  assert.equal(vm.evaluate('ClaudeWoWRoll.CommandOf("WebSearch")'), 'WebSearch');
  assert.equal(vm.evaluate('ClaudeWoWRoll.ItemName({ "WebSearch" })'), 'WebSearch');
  assert.equal(vm.evaluate('ClaudeWoWRoll.IconFor({ "WebSearch" })'), 'Interface\\Icons\\Trade_Engineering');
  assert.equal(vm.evaluate('ClaudeWoWRoll.IconFor({ "WebSearch", "Bash(git:*)" })'), 'Interface\\Icons\\INV_Scroll_03');
});

test('Need grants the rules for good through the Allow & retry path', () => {
  const vm = newVM();
  const { id } = deliverDenial(vm, ['Bash(cargo:*)']);
  vm.run('STUB.played = {}; ClaudeWoWRollFrame.NeedButton.scripts.OnClick(ClaudeWoWRollFrame.NeedButton)');
  assert.equal(vm.evaluate('ClaudeWoWRollFrame.shown'), 'false');
  assert.equal(vm.evaluate('table.concat(STUB.played, ",")'), 'UI_NEED_ROLL_POSITIVE');
  const rec = stripFlags(vm).find(r => r.flags.includes('allow='));
  assert.ok(rec, 'an allow record on the strip');
  assert.equal(rec.flags, 'allow=Bash(cargo:*)');
  assert.equal(vm.num('ClaudeWoWDB.chats[1].pendingId'), id + 1);
  assert.ok(vm.evaluate('ClaudeWoWDB.outbox.allow') !== null);
  assert.equal(vm.evaluate('ClaudeWoWDB.outbox.allowOnce'), null);
});

test('Greed grants the rules for this retry only: a once= flag, never allow=', () => {
  const vm = newVM();
  deliverDenial(vm, ['Bash(rm:*)']);
  vm.run('STUB.played = {}; ClaudeWoWRollFrame.GreedButton.scripts.OnClick(ClaudeWoWRollFrame.GreedButton)');
  assert.equal(vm.evaluate('table.concat(STUB.played, ",")'), 'LOOT_WINDOW_COIN_SOUND');
  const records = stripFlags(vm);
  const rec = records.find(r => r.flags.includes('once='));
  assert.ok(rec, 'a once record on the strip');
  assert.equal(rec.flags, 'once=Bash(rm:*)');
  assert.ok(!records.some(r => r.flags.includes('allow=')));
  assert.equal(vm.evaluate('ClaudeWoWDB.outbox.allow'), null);
  assert.equal(vm.evaluate('ClaudeWoWDB.outbox.allowOnce').toLowerCase(), Buffer.from('Bash(rm:*)').toString('hex'));
  assert.ok(vm.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history - 1].text').includes('this retry only'));
});

test('Pass denies: nothing is sent, the denial is closed in the transcript', () => {
  const vm = newVM();
  deliverDenial(vm, ['WebSearch']);
  const seqBefore = vm.num('ClaudeWoWDB.lastSeq');
  vm.run('STUB.played = {}; ClaudeWoWRollFrame.PassButton.scripts.OnClick(ClaudeWoWRollFrame.PassButton)');
  assert.equal(vm.evaluate('ClaudeWoWRollFrame.shown'), 'false');
  assert.equal(vm.evaluate('table.concat(STUB.played, ",")'), 'UI_NEED_ROLL_NEGATIVE');
  assert.equal(vm.num('ClaudeWoWDB.lastSeq'), seqBefore);
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].pendingId'), null);
  assert.equal(vm.evaluate(`${lastHistory}.text`), 'Passed on: WebSearch');
  assert.equal(vm.evaluate('ClaudeWoW.OpenDenial(ClaudeWoWDB.chats[1].id)'), null);
});

test('the countdown runs out after 60 seconds and counts as Pass', () => {
  const vm = newVM();
  deliverDenial(vm, ['Bash(git:*)']);
  vm.run('STUB.now = STUB.now + 30; ClaudeWoWRollFrame.scripts.OnUpdate(ClaudeWoWRollFrame, 30)');
  assert.equal(vm.evaluate('ClaudeWoWRollFrame.shown'), 'true');
  vm.run('STUB.played = {}; STUB.now = STUB.now + 31; ClaudeWoWRollFrame.scripts.OnUpdate(ClaudeWoWRollFrame, 31)');
  assert.equal(vm.evaluate('ClaudeWoWRollFrame.shown'), 'false');
  assert.equal(vm.evaluate('table.concat(STUB.played, ",")'), 'UI_NEED_ROLL_NEGATIVE');
  assert.equal(vm.evaluate(`${lastHistory}.text`), 'Passed on: Bash(git:*) (the roll timed out)');
  assert.equal(vm.evaluate('ClaudeWoWDB.outbox and ClaudeWoWDB.outbox.allow'), null);
});

test('a roll whose denial went stale closes without acting, and the next queued roll shows', () => {
  const vm = newVM();
  deliverDenial(vm, ['Bash(rm:*)']);
  vm.run('ClaudeWoW.NewChat("second")');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[2].name'), 'second');
  const second = deliverDenial(vm, ['WebFetch'], 'grok', 2);
  assert.equal(vm.evaluate('ClaudeWoWRoll.Current().rules[1]'), 'Bash(rm:*)', 'the first roll keeps the frame');
  assert.equal(vm.num('ClaudeWoWRoll.Waiting()'), 1, 'the second waits its turn');
  const seqBefore = vm.num('ClaudeWoWDB.lastSeq');
  vm.run('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].denied = nil');
  vm.run('ClaudeWoWRollFrame.scripts.OnUpdate(ClaudeWoWRollFrame, 0)');
  assert.equal(vm.num('ClaudeWoWDB.lastSeq'), seqBefore, 'a stale roll sends nothing');
  assert.equal(vm.evaluate('ClaudeWoWRollFrame.shown'), 'true');
  assert.equal(vm.evaluate('ClaudeWoWRoll.Current().chatId'), second.chatId);
  assert.equal(vm.evaluate('ClaudeWoWRollFrame.Name.text'), 'WebFetch');
  assert.equal(vm.evaluate('ClaudeWoWRollFrame.IconFrame.Icon.texture'), 'Interface\\Icons\\Trade_Engineering');
  vm.run('ClaudeWoWRollFrame.PassButton.scripts.OnClick(ClaudeWoWRollFrame.PassButton)');
  assert.equal(vm.evaluate('ClaudeWoWRollFrame.shown'), 'false');
  assert.equal(vm.evaluate('ClaudeWoWRoll.Current()'), null);
  assert.equal(vm.num('ClaudeWoWRoll.Waiting()'), 0);
});

test('/claude config roll off brings back the Allow & retry button; without the module the button is the fallback', () => {
  const vm = newVM();
  deliverDenial(vm, ['WebSearch']);
  const visibleAllowButton = 'RESULT = "none"; for _, f in ipairs(STUB.frames) do if f.template == "UIPanelButtonTemplate" and f.rules and f.shown then RESULT = f.text end end';
  vm.run('SlashCmdList.CLAUDE("config roll off")');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.lootRoll'), 'false');
  assert.equal(vm.evaluate('ClaudeWoWRollFrame.shown'), 'false');
  assert.equal(vm.evaluate('ClaudeWoW.LootRollEnabled()'), 'false');
  vm.run(visibleAllowButton);
  assert.equal(vm.evaluate('RESULT'), 'Allow WebSearch & retry', 'the same denial is still open, now as the button');
  vm.run('SlashCmdList.CLAUDE("config roll on")');
  assert.equal(vm.evaluate('ClaudeWoW.LootRollEnabled()'), 'true');
  assert.equal(vm.evaluate('ClaudeWoWRollFrame.shown'), 'true', 'turning it back on rolls the open denial again');
  vm.run(visibleAllowButton);
  assert.equal(vm.evaluate('RESULT'), 'none');

  const plain = newVM({ withRollModule: false });
  deliverDenial(plain, ['WebSearch']);
  assert.equal(plain.evaluate('ClaudeWoW.LootRollEnabled()'), 'false');
  plain.run('RESULT = "false"; for _, f in ipairs(STUB.frames) do if f.template == "UIPanelButtonTemplate" and f.rules and f.shown then RESULT = f.text end end');
  assert.equal(plain.evaluate('RESULT'), 'Allow WebSearch & retry');
});

const hexDirs = (...dirs) => Buffer.from(dirs.join('\x1F')).toString('hex');
const chatDirs = vm => {
  vm.run('RESULT = table.concat(ClaudeWoWDB.chats[1].addDirs or {}, "|")');
  return vm.evaluate('RESULT');
};

test('a folder outside the chat is a scroll named after the folder, with folder hints on the buttons', () => {
  const vm = newVM();
  deliverDenial(vm, ['AddDir(/tmp)']);
  assert.equal(vm.evaluate('ClaudeWoWRollFrame.shown'), 'true');
  assert.equal(vm.evaluate('ClaudeWoWRollFrame.Name.text'), 'Scroll of /tmp');
  assert.equal(vm.evaluate('ClaudeWoWRollFrame.IconFrame.Icon.texture'), 'Interface\\Icons\\INV_Scroll_03');
  assert.equal(vm.evaluate('ClaudeWoWRoll.CommandOf("AddDir(/Users/me/My Stuff (old))")'), '/Users/me/My Stuff (old)');
  assert.equal(vm.evaluate('ClaudeWoWRoll.ItemName({ "AddDir(/tmp)", "Bash(curl:*)" })'), 'Scroll of /tmp +1');
  assert.match(vm.evaluate('ClaudeWoWRoll.Hint("need", { "AddDir(/tmp)" })'), /--add-dir/);
  assert.match(vm.evaluate('ClaudeWoWRoll.Hint("greed", { "AddDir(/tmp)" })'), /this one retry only/);
  assert.match(vm.evaluate('ClaudeWoWRoll.Hint("need", { "Bash(curl:*)" })'), /allowlist/);
  assert.equal(vm.evaluate('ClaudeWoW.GrantsLabel({ "AddDir(/tmp)", "WebSearch" })'), 'folder /tmp, WebSearch');
});

test('Need on a folder adds it to the chat for good, like /claude --add-dir, and nothing goes to the allowlist', () => {
  const vm = newVM();
  const { id } = deliverDenial(vm, ['AddDir(/tmp)']);
  vm.run('STUB.played = {}; ClaudeWoWRollFrame.NeedButton.scripts.OnClick(ClaudeWoWRollFrame.NeedButton)');
  assert.equal(vm.evaluate('table.concat(STUB.played, ",")'), 'UI_NEED_ROLL_POSITIVE');
  assert.equal(chatDirs(vm), '/tmp');
  assert.equal(vm.num('ClaudeWoWDB.chats[1].pendingId'), id + 1);
  const rec = stripFlags(vm).find(r => r.flags.includes('dirs='));
  assert.ok(rec, 'the retry carries the folder');
  assert.equal(rec.flags, `dirs=${hexDirs('/tmp')}`);
  assert.equal(vm.evaluate('ClaudeWoWDB.outbox.allow'), null);
  assert.equal(vm.evaluate('ClaudeWoWDB.outbox.allowOnce'), null);
  assert.match(vm.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history - 1].text'), /^Allowed: folder \/tmp\. Extra folders for this chat: \/tmp$/);
});

test('Greed on a folder sends it with this retry only; the chat keeps its own folders', () => {
  const vm = newVM();
  vm.run('ClaudeWoWDB.chats[1].addDirs = { "/srv/data" }');
  deliverDenial(vm, ['AddDir(/tmp)', 'Bash(curl:*)']);
  vm.run('ClaudeWoWRollFrame.GreedButton.scripts.OnClick(ClaudeWoWRollFrame.GreedButton)');
  assert.equal(chatDirs(vm), '/srv/data', 'the chat setting is untouched');
  const rec = stripFlags(vm).find(r => r.flags.includes('once='));
  assert.ok(rec);
  assert.equal(rec.flags, `once=Bash(curl:*);dirs=${hexDirs('/srv/data', '/tmp')}`);
  vm.run('ClaudeWoWDB.chats[1].pendingId = nil');
  vm.run('ClaudeWoW.Send("next message")');
  const next = stripFlags(vm).find(r => r.text === 'next message');
  assert.equal(next.flags, `dirs=${hexDirs('/srv/data')}`, 'the next message goes without the retry folder');
});

test('Need on a folder and a command: the folder joins the chat, the command goes to the allowlist', () => {
  const vm = newVM();
  deliverDenial(vm, ['Bash(curl:*)', 'AddDir(/tmp)']);
  vm.run('ClaudeWoWRollFrame.NeedButton.scripts.OnClick(ClaudeWoWRollFrame.NeedButton)');
  assert.equal(chatDirs(vm), '/tmp');
  const rec = stripFlags(vm).find(r => r.flags.includes('allow='));
  assert.equal(rec.flags, `allow=Bash(curl:*);dirs=${hexDirs('/tmp')}`);
});

test('Pass on a folder denies it; the Allow & retry button names the folder', () => {
  const vm = newVM();
  deliverDenial(vm, ['AddDir(/tmp)']);
  vm.run('SlashCmdList.CLAUDE("config roll off")');
  vm.run('RESULT = "none"; for _, f in ipairs(STUB.frames) do if f.template == "UIPanelButtonTemplate" and f.rules and f.shown then RESULT = f.text end end');
  assert.equal(vm.evaluate('RESULT'), 'Allow folder /tmp & retry');
  vm.run('SlashCmdList.CLAUDE("config roll on")');
  const seqBefore = vm.num('ClaudeWoWDB.lastSeq');
  vm.run('ClaudeWoWRollFrame.PassButton.scripts.OnClick(ClaudeWoWRollFrame.PassButton)');
  assert.equal(vm.num('ClaudeWoWDB.lastSeq'), seqBefore);
  assert.equal(vm.evaluate(`${lastHistory}.text`), 'Passed on: folder /tmp');
  assert.equal(chatDirs(vm), '');
});
