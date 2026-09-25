// Macros the agent hands over: the bridge's extraction (protocol.js) and the
// addon's buttons, create/update/undo, run in a Lua VM with a macro API stub
// that keeps macros sorted by name like the client, so indices shift.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');
const P = require('../bridge/protocol');

const ADDON = path.join(__dirname, '..', 'addon', 'WoWAI');

// ---------------------------------------------------------------------------
// Bridge side
// ---------------------------------------------------------------------------

test('extractMacros reads name, icon and scope, and leaves a readable version', () => {
  const r = P.extractMacros('Here.\n\n```wowmacro Charge icon=Ability_Warrior_Charge scope=character\n#showtooltip\r\n/cast [combat] Intercept; Charge   \n```\nDone.');
  assert.deepEqual(r.macros, [{ name: 'Charge', body: '#showtooltip\n/cast [combat] Intercept; Charge', icon: 'Ability_Warrior_Charge', char: true, risky: false }]);
  assert.equal(r.text, 'Here.\n\nMacro "Charge":\n#showtooltip\n/cast [combat] Intercept; Charge\nDone.');
  assert.deepEqual(r.notes, []);
});

test('macro names follow the game: no quotes or bars, 16 characters (not bytes), not empty', () => {
  const r = P.extractMacros('```wowmacro "Añadir|ñññññññññññññññ"\n/sit\n```\n```wowmacro   \n/sit\n```\n```wowmacro X icon=12345\n/sit\n```');
  assert.equal(r.macros.length, 2);
  assert.equal(Array.from(r.macros[0].name).length, 16);
  assert.ok(r.macros[0].name.startsWith('Añadir') && !r.macros[0].name.includes('|'));
  assert.equal(r.macros[1].icon, 12345);
  assert.ok(r.notes.some(n => /without a name/.test(n)));
});

test('bodies over 255 bytes, empty ones and extra macros get no button; code-running ones are flagged', () => {
  const long = '/say ' + 'é'.repeat(130); // 5 + 260 bytes, 135 characters
  const blocks = [`\`\`\`wowmacro Long\n${long}\n\`\`\``, '```wowmacro Empty\n\n```', '```wowmacro Run\n/run print(1)\n```'];
  for (let i = 0; i < 7; i++) blocks.push(`\`\`\`wowmacro M${i}\n/sit\n\`\`\``);
  const r = P.extractMacros(blocks.join('\n'));
  assert.ok(r.notes.some(n => /Long.*bytes/.test(n)));
  assert.ok(r.notes.some(n => /Empty.*empty/.test(n)));
  assert.ok(r.notes.some(n => /first 6/.test(n)));
  assert.equal(r.macros.length, P.MACRO_LIMITS.perReply);
  assert.equal(r.macros[0].name, 'Run');
  assert.ok(r.macros[0].risky);
  assert.ok(r.text.includes('Macro "Long":'), 'rejected macros stay readable');
});

test('a macro block after TL;DR stays out of the game-chat summary', () => {
  const reply = 'Made it.\n\nTL;DR:\nCharge macro ready.\n```wowmacro Charge\n#showtooltip\n/cast Charge\n```';
  const { text, summary } = P.splitSummary(reply);
  assert.equal(P.stripMacroBlocks(summary), 'Charge macro ready.');
  assert.equal(P.extractMacros(text).macros.length, 1);
});

test('slot files carry macros on the reply record', () => {
  const macros = P.extractMacros('```wowmacro A "q"\n/cast X\n```\n```wowmacro B icon=7\n/run y()\n```').macros;
  const src = P.luaTable('WoWAI_SlotData', [{ chat: 'c', id: 3, status: 'done', text: 't', macros }], { now: 1 });
  const got = runLua(src, `(function(r) local a, b = r.macros[1], r.macros[2]
    return table.concat({ #r.macros, a.name, a.body, tostring(a.icon), tostring(a.char), b.icon, tostring(b.risky) }, "|") end)(WoWAI_SlotData.replies[1])`);
  assert.equal(got, '2|A q|/cast X|nil|false|7|true');
});

function runLua(src, expr) {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  if (lauxlib.luaL_dostring(L, to_luastring(src + '\nRESULT = ' + expr)) !== 0) throw new Error('Lua error: ' + to_jsstring(lua.lua_tostring(L, -1)));
  lua.lua_getglobal(L, to_luastring('RESULT'));
  return to_jsstring(lua.lua_tostring(L, -1));
}

// ---------------------------------------------------------------------------
// Addon side
// ---------------------------------------------------------------------------

// Account macros are 1..120 and character macros 121..150, each kept sorted by
// name, so creating or renaming one shifts the others, as in the client.
const MACRO_STUB = `
STUB.acct, STUB.chr, STUB.calls = {}, {}, {}
Constants = { MacroConsts = { MAX_ACCOUNT_MACROS = 120, MAX_CHARACTER_MACROS = 30 } }
local function sortList(l) table.sort(l, function(a, b) return a.name < b.name end) end
local function locate(i) if i > 120 then return STUB.chr, i - 120, 120 end return STUB.acct, i, 0 end
local function indexOf(entry)
  for i, e in ipairs(STUB.acct) do if e == entry then return i end end
  for i, e in ipairs(STUB.chr) do if e == entry then return 120 + i end end
end
function GetMacroInfo(i) local l, j = locate(i); local e = l[j]; if e then return e.name, e.icon, e.body end end
function GetNumMacros() return #STUB.acct, #STUB.chr end
function CreateMacro(name, icon, body, perCharacter)
  table.insert(STUB.calls, "create " .. name)
  local l = perCharacter and STUB.chr or STUB.acct
  local e = { name = name, icon = icon, body = body }
  table.insert(l, e); sortList(l)
  return indexOf(e)
end
function EditMacro(i, name, icon, body)
  table.insert(STUB.calls, "edit " .. i)
  local l, j = locate(i); local e = l[j]
  e.name = name or e.name; if icon then e.icon = icon end; if body then e.body = body end
  sortList(l)
  return indexOf(e)
end
function DeleteMacro(i) local l, j = locate(i); table.remove(l, j) end
function PickupMacro(i) STUB.picked = i end
function InCombatLockdown() return STUB.combat or false end
`;

function newVM() {
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
  run(MACRO_STUB);
  for (const f of ['Codec.lua', 'Inbox.lua', 'WoWAI.lua']) run(fs.readFileSync(path.join(ADDON, f), 'utf8'), 'WoWAI');
  run('STUB.FireEvent("ADDON_LOADED", "WoWAI"); STUB.FireEvent("PLAYER_LOGIN")');
  return { run, evaluate };
}

// A reply carrying `macrosLua` lands through the reload path (Inbox.lua).
function deliver(vm, macrosLua) {
  vm.run(`
    local c = WoWAIDB.chats[1]
    c.pendingId = 5
    WoWAI_Inbox = { replies = { { chat = c.id, id = 5, status = "done", text = "Here you go.", macros = ${macrosLua} } } }
    STUB.FireEvent("PLAYER_LOGIN")
    WoWAI.Toggle(true)
    WoWAI.Render()`);
}

// The shown macro buttons, as "label" strings, and a way to click the n-th.
function buttons(vm) {
  vm.run(`
    local out = {}
    for _, f in ipairs(STUB.frames) do
      if f.macro and f.shown and f.parent and f.parent.shown then out[#out + 1] = f.text end
    end
    RESULT = table.concat(out, "\\n")`);
  const s = vm.evaluate('RESULT');
  return s ? s.split('\n') : [];
}
function click(vm, n = 1) {
  vm.run(`
    local k = 0
    for _, f in ipairs(STUB.frames) do
      if f.macro and f.shown and f.parent and f.parent.shown then
        k = k + 1
        if k == ${n} then f.scripts.OnClick(f) return end
      end
    end
    error("no macro button ${n}")`);
}
const accept = vm => vm.run('StaticPopupDialogs[STUB.popup.which].OnAccept(nil, STUB.popup.data); STUB.popup = nil');

test('a reply with a macro shows a button that creates it and puts it on the cursor', () => {
  const vm = newVM();
  vm.run('CreateMacro("Aaa", 1, "/sit", false); CreateMacro("Zzz", 1, "/dance", false); STUB.calls = {}');
  deliver(vm, '{ { name = "Mmm", body = "#showtooltip\\n/cast Charge", char = false } }');
  assert.equal(vm.evaluate('#WoWAIDB.chats[1].history[#WoWAIDB.chats[1].history].macros'), '1');
  assert.deepEqual(buttons(vm), ['Create macro: Mmm']);
  click(vm);
  assert.equal(vm.evaluate('table.concat(STUB.calls, ",")'), 'create Mmm');
  // Sorted between Aaa and Zzz: the index CreateMacro returned is the one picked up.
  assert.equal(vm.evaluate('STUB.picked'), '2');
  assert.equal(vm.evaluate('(GetMacroInfo(2))'), 'Mmm');
  assert.equal(vm.evaluate('select(2, GetMacroInfo(2))'), '134400', 'default icon');
  assert.deepEqual(buttons(vm), ['Update macro: Mmm']);
  // Same body again: updates without asking.
  click(vm);
  assert.equal(vm.evaluate('STUB.popup'), null);
});

test('replacing a different macro asks first, and undo brings the old one back', () => {
  const vm = newVM();
  vm.run('CreateMacro("Charge", 99, "/cast Old", false); STUB.calls = {}');
  deliver(vm, '{ { name = "Charge", body = "/cast New", char = false } }');
  click(vm);
  assert.equal(vm.evaluate('STUB.popup.which'), 'WOWAI_MACRO');
  assert.equal(vm.evaluate('select(3, GetMacroInfo(1))'), '/cast Old', 'nothing changed before OK');
  accept(vm);
  assert.equal(vm.evaluate('select(3, GetMacroInfo(1))'), '/cast New');
  assert.equal(vm.evaluate('select(2, GetMacroInfo(1))'), '99', 'the player\'s icon is kept when the agent set none');
  assert.equal(vm.evaluate('STUB.picked'), '1');
  vm.run('SlashCmdList.WOWAI("macro undo")');
  assert.equal(vm.evaluate('select(3, GetMacroInfo(1))'), '/cast Old');
});

test('undo removes a macro the button created', () => {
  const vm = newVM();
  deliver(vm, '{ { name = "New", body = "/sit", char = false } }');
  click(vm);
  assert.equal(vm.evaluate('(GetNumMacros())'), '1');
  vm.run('SlashCmdList.WOWAI("macro undo")');
  assert.equal(vm.evaluate('(GetNumMacros())'), '0');
});

test('"/ai macro ..." with anything but undo is a message for the agent', () => {
  const vm = newVM();
  vm.run('SENT = nil; WoWAI.Send = function(m) SENT = m end; SlashCmdList.WOWAI("macro para mi guerrero con carga")');
  assert.equal(vm.evaluate('SENT'), 'macro para mi guerrero con carga');
  vm.run('SENT = nil; SlashCmdList.WOWAI("macro undo")');
  assert.equal(vm.evaluate('SENT'), null);
});

test('macros that run code ask first even when new', () => {
  const vm = newVM();
  deliver(vm, '{ { name = "Runner", body = "/run print(1)", char = false, risky = true } }');
  assert.match(buttons(vm)[0], /^Create macro: Runner .*runs code/);
  click(vm);
  assert.equal(vm.evaluate('STUB.popup.which'), 'WOWAI_MACRO');
  assert.equal(vm.evaluate('(GetNumMacros())'), '0');
  accept(vm);
  assert.equal(vm.evaluate('(GetNumMacros())'), '1');
});

test('character scope only matches character macros with that name', () => {
  const vm = newVM();
  vm.run('CreateMacro("Heal", 1, "/cast Account", false)');
  deliver(vm, '{ { name = "Heal", body = "/cast Char", char = true } }');
  assert.deepEqual(buttons(vm), ['Create macro: Heal (character)']);
  click(vm);
  assert.equal(vm.evaluate('select(3, GetMacroInfo(1))'), '/cast Account', 'the account macro is untouched');
  assert.equal(vm.evaluate('select(3, GetMacroInfo(121))'), '/cast Char');
  assert.equal(vm.evaluate('STUB.picked'), '121');
});

test('no macro changes in combat or when the macro list is full', () => {
  const vm = newVM();
  deliver(vm, '{ { name = "Later", body = "/sit", char = true } }');
  vm.run('STUB.combat = true');
  click(vm);
  assert.equal(vm.evaluate('(GetNumMacros())'), '0');
  assert.ok(vm.evaluate('STUB.prints[#STUB.prints]').includes('combat'));
  vm.run('STUB.combat = false; for i = 1, 30 do CreateMacro("C" .. i, 1, "/sit", true) end');
  click(vm);
  assert.equal(vm.evaluate('select(2, GetNumMacros())'), '30');
  assert.ok(vm.evaluate('STUB.prints[#STUB.prints]').includes('full'));
});

test('malformed macro entries from a slot are dropped', () => {
  const vm = newVM();
  deliver(vm, '{ { name = "", body = "/sit" }, { name = "Ok", body = "/sit", icon = {} }, "junk" }');
  assert.deepEqual(buttons(vm), ['Create macro: Ok']);
  assert.equal(vm.evaluate('WoWAIDB.chats[1].history[#WoWAIDB.chats[1].history].macros[1].icon'), null);
});
