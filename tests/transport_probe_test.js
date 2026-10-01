'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');
const T = require('../dev/transport-probe');

const ADDON = path.join(__dirname, '..', 'addon', 'ClaudeWoW');

const CLIENT_LOG_API = `
SENT, LOGGING, FILTERS = {}, false, {}
function SendSystemMessage(text) SENT[#SENT + 1] = text end
function LoggingChat(on) if on ~= nil then LOGGING = on end return LOGGING end
function ChatFrame_AddMessageEventFilter(event, fn) FILTERS[#FILTERS + 1] = { event = event, fn = fn } end
function Methods.SetAllPoints(self) end
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
    const s = lua.lua_isnil(L, -1) ? null : to_jsstring(lua.lua_tolstring(L, -1));
    lua.lua_pop(L, 1);
    return s;
  };
  run(fs.readFileSync(path.join(__dirname, 'wow_stub.lua'), 'utf8') + clientApi);
  for (const f of ['Codec.lua', 'Inbox.lua', 'ClaudeWoW.lua']) run(fs.readFileSync(path.join(ADDON, f), 'utf8'));
  run('STUB.FireEvent("ADDON_LOADED", "ClaudeWoW"); STUB.FireEvent("PLAYER_LOGIN")');
  return { run, evaluate };
}

function sentLines(vm) {
  const n = Number(vm.evaluate('#SENT'));
  const lines = [];
  for (let i = 1; i <= n; i++) lines.push(vm.evaluate(`SENT[${i}]`));
  return lines;
}

test('/claude probe chatlog turns chat logging on and writes a long line, numbered filler and an end line as local system messages', () => {
  const vm = newVM();
  vm.run('SlashCmdList.CLAUDE("probe chatlog 4096")');
  const lines = sentLines(vm);
  assert.equal(lines.length, 1 + 18 + 1);
  assert.match(lines[0], /^CWLOG\d+ LONG L{1000}$/);
  assert.match(lines[1], /^CWLOG\d+ V 00001 z{200}$/);
  assert.match(lines[2], /^CWLOG\d+ H 00002 z{200}$/);
  assert.match(lines[19], /^CWLOG\d+ END 18$/);
  assert.equal(vm.evaluate('LOGGING'), 'true');
});

test('the probe filter hides only the lines marked H from the chat frame', () => {
  const vm = newVM();
  vm.run('SlashCmdList.CLAUDE("probe chatlog 1024")');
  assert.equal(vm.evaluate('FILTERS[#FILTERS].event'), 'CHAT_MSG_SYSTEM');
  assert.equal(vm.evaluate('FILTERS[#FILTERS].fn(nil, "CHAT_MSG_SYSTEM", "CWLOG17 H 00002 zz")'), 'true');
  assert.equal(vm.evaluate('FILTERS[#FILTERS].fn(nil, "CHAT_MSG_SYSTEM", "CWLOG17 V 00001 zz")'), 'false');
  assert.equal(vm.evaluate('FILTERS[#FILTERS].fn(nil, "CHAT_MSG_SYSTEM", "You feel rested.")'), 'false');
  const filters = Number(vm.evaluate('#FILTERS'));
  vm.run('SlashCmdList.CLAUDE("probe chatlog 1024")');
  assert.equal(Number(vm.evaluate('#FILTERS')), filters, 'a second run adds no second filter');
});

test('/claude probe followed by ordinary words is a message, not the probe', () => {
  const vm = newVM();
  vm.run('SlashCmdList.CLAUDE("probe chatlog for traps please")');
  assert.equal(vm.evaluate('#SENT'), '0');
});

test('a client without SendSystemMessage gets a line saying so and no error', () => {
  const vm = newVM(CLIENT_LOG_API + 'SendSystemMessage = nil\n');
  vm.run('SlashCmdList.CLAUDE("probe chatlog")');
  assert.equal(vm.evaluate('LOGGING'), 'false');
});

test('/claude probe asyncfile requests and releases the probe texture ids, then the two bursts', () => {
  const vm = newVM(CLIENT_LOG_API + `
    REQUESTED = {}
    local set = Methods.SetTexture
    function Methods.SetTexture(self, id) if id ~= nil then REQUESTED[#REQUESTED + 1] = id end return set(self, id) end
    function Methods.SetBlockingLoadsRequested(self, on) self.blocking = on end
    function Methods.IsBlockingLoadRequested(self) return self.blocking end
  `);
  vm.run('REQUESTED = {}');
  vm.run('SlashCmdList.CLAUDE("probe asyncfile")');
  vm.run('STUB.RunTimers()');
  const n = Number(vm.evaluate('#REQUESTED'));
  const ids = [];
  for (let i = 1; i <= n; i++) ids.push(Number(vm.evaluate(`REQUESTED[${i}]`)));
  for (const id of [133975, 133888, 134120, 8999999, 134188, 134336]) assert.ok(ids.includes(id), 'requested ' + id);
  for (let i = 0; i < 48; i++) {
    assert.ok(ids.includes(135000 + i), 'cancel burst id ' + (135000 + i));
    assert.ok(ids.includes(135100 + i), 'wait burst id ' + (135100 + i));
  }
  assert.equal(vm.evaluate('#SENT'), '0', 'the asyncfile probe writes nothing to chat logging');
});

test('the watcher reads probe lines out of chat log growth, across a flush that splits a line', () => {
  const vm = newVM();
  vm.run('SlashCmdList.CLAUDE("probe chatlog 4096")');
  const file = sentLines(vm).map(l => '9/30 19:00:00.000  ' + l + '\r\n').join('');
  const chat = T.newChatState();
  T.feedChat(chat, file.slice(0, 4096), 't1', 100, 4196);
  T.feedChat(chat, file.slice(4096), 't2', 4196, 100 + file.length);
  const v = T.verdict(chat, T.newAsyncState()).chatlog;
  assert.match(v.status, /^ALIVE/);
  assert.equal(v.longLineLength, 1000);
  assert.equal(v.hiddenLinesLogged, true);
  assert.equal(v.visibleLinesLogged, 5);
  assert.equal(v.highestLine, 18);
  assert.equal(v.endLineOnDisk, true);
  assert.deepEqual(v.flushDeltas, [4096, file.length - 4096]);
});

test('stripInPlace removes probe and frame lines, keeps other chat, and keeps the same file', () => {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cw-strip-'));
  const file = path.join(dir, 'WoWChatLog.txt');
  const keep1 = '9/30 19:00:00.000  You feel rested.\r\n';
  const keep2 = '9/30 19:00:03.000  [1. General] Someone: CWX1 and CWLOG1 are only words here\r\n';
  fs.writeFileSync(file, keep1 + '9/30 19:00:01.000  CWLOG17 H 00002 zzz\r\n' + '9/30 19:00:02.000  CWX1 7 1/1 abcd\r\n' + keep2, 'latin1');
  const inode = fs.statSync(file).ino;
  try {
    const r = T.stripInPlace(file, T.STRIP_LINE);
    assert.equal(r.removedLines, 2);
    assert.equal(fs.readFileSync(file, 'latin1'), keep1 + keep2);
    assert.equal(r.after, (keep1 + keep2).length);
    assert.equal(fs.statSync(file).ino, inode, 'the client keeps its open file');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the watcher reports no evidence when the chat log grew with other lines only', () => {
  const chat = T.newChatState();
  T.feedChat(chat, '9/30 19:00:00.000  You feel rested.\r\n', 't1', 0, 37);
  const v = T.verdict(chat, T.newAsyncState());
  assert.equal(v.chatlog.status, 'file grew, but no probe line was in it');
  assert.equal(v.asyncfile.status, 'no evidence');
});

test('the watcher keeps only probe ids from AsyncFile.log and summarises the bursts', () => {
  const lines = [
    '9/30 19:00:00.100  Cancel requested -- FileData ID 133975',
    '9/30 19:00:00.100  Cancel requested -- FileData ID 798064',
    '9/30 19:00:00.120  Cancel processed -- FileData ID 133975',
    '9/30 19:00:04.000  Cancel requested -- FileData ID 135000',
    '9/30 19:00:04.000  Cancel requested -- FileData ID 135002',
    '9/30 19:00:04.000  Cancel requested -- FileData ID 135001',
    '9/30 19:00:06.000  Wait Started -- FileData ID 135100',
  ];
  const state = T.newAsyncState();
  T.feedAsync(state, lines.join('\n') + '\n', 't1');
  const v = T.verdict(T.newChatState(), state).asyncfile;
  assert.match(v.status, /^ALIVE/);
  assert.deepEqual(v.steps['A1 shown cancel'], { 'Cancel requested': 1, 'Cancel processed': 1 });
  assert.equal(v.cancelBurst.distinct, 3);
  assert.equal(v.cancelBurst.inOrder, false);
  assert.equal(v.cancelBurst.missing.length, 45);
  assert.equal(v.waitBurst.distinct, 1);
  assert.equal(state.lines.length, 6);
});
