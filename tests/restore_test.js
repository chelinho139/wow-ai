// A slot file carrying replies, a denied-tools list and a restore bundle must be
// valid Lua that the addon can read back field by field.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const luaparse = require('luaparse');
const P = require('../bridge/protocol');

// Undo luaStr's escapes: \\ \" \n and \ddd (a raw tab is legal in a Lua literal).
function luaUnescape(s) {
  return s.replace(/\\(\d{1,3}|.)/g, (_, e) => /^\d/.test(e) ? String.fromCharCode(Number(e)) : e === 'n' ? '\n' : e);
}

// Walk a luaparse table AST into plain JS values.
function value(node) {
  if (node.type === 'TableConstructorExpression') {
    const out = {};
    const arr = [];
    for (const f of node.fields) {
      if (f.type === 'TableKeyString') out[f.key.name] = value(f.value);
      else arr.push(value(f.value));
    }
    return arr.length ? arr : out;
  }
  if (node.type === 'StringLiteral') return luaUnescape(node.raw.slice(1, -1));
  if (node.type === 'NumericLiteral') return node.value;
  if (node.type === 'BooleanLiteral') return node.value;
  return null;
}

function readSlot(src, globalName) {
  const ast = luaparse.parse(src, { luaVersion: '5.1' });
  const assign = ast.body.find(n => n.type === 'AssignmentStatement' && n.variables[0].name === globalName);
  assert.ok(assign, globalName + ' assignment present');
  return value(assign.init[0]);
}

test('slot file round-trips replies, denied rules, cwd, agents and a restore bundle', () => {
  const restore = {
    token: 'tok1',
    chats: [{ id: 'c1', name: 'realms', cwd: 'C:\\x\\y', messages: [
      { role: 'user', id: 1, t: 1, text: 'hi "there"\nnew line' },
      { role: 'assistant', id: 1, t: 2, agent: 'codex', text: 'hello | pipe \\ backslash' },
    ] }],
  };
  const lua = P.luaTable('ClaudeWoW_SlotData',
    [{ chat: 'c9', id: 3, status: 'done', text: 'ok\ttab', denied: ['WebSearch', 'Bash(cargo:*)'], agent: 'grok' }],
    { cwd: 'C:\\proj', restore, now: 1700000000123, agent: 'claude', agents: ['claude', 'codex', 'grok'] });
  const d = readSlot(lua, 'ClaudeWoW_SlotData');
  assert.equal(d.now, 1700000000);
  assert.equal(d.cwd, 'C:\\proj');
  assert.equal(d.agent, 'claude');
  assert.deepEqual(d.agents, ['claude', 'codex', 'grok']);
  assert.equal(d.replies.length, 1);
  assert.deepEqual(d.replies[0].denied, ['WebSearch', 'Bash(cargo:*)']);
  assert.equal(d.replies[0].text, 'ok\ttab');
  assert.equal(d.replies[0].agent, 'grok');
  assert.equal(d.restore.token, 'tok1');
  assert.equal(d.restore.chats.length, 1);
  assert.equal(d.restore.chats[0].messages[0].text, 'hi "there"\nnew line');
  assert.equal(d.restore.chats[0].messages[0].agent, '');
  assert.equal(d.restore.chats[0].messages[1].text, 'hello | pipe \\ backslash');
  assert.equal(d.restore.chats[0].messages[1].agent, 'codex');
});

test('slot file without a restore has no restore field and tolerates empty records', () => {
  const d = readSlot(P.luaTable('ClaudeWoW_Inbox', [], { cwd: '' }), 'ClaudeWoW_Inbox');
  assert.equal(d.cwd, '');
  assert.equal(d.agent, '');
  assert.deepEqual(d.agents, {}); // an empty Lua table
  assert.equal(d.restore, undefined);
  assert.deepEqual(d.replies, {});
});
