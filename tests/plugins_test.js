// The plugin registry and routing (bridge/plugins.js), the plugin= binding on
// the wire (protocol.js), and the plugins the bridge ships.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const PL = require('../bridge/plugins');
const P = require('../bridge/protocol');

const noop = () => {};
const fake = (id, extra = {}) => ({ id, label: id, handle: noop, ...extra });

test('register validates the shape and fills in the optional fields', () => {
  const reg = PL.createRegistry();
  const p = reg.register(fake('one'));
  assert.equal(p.label, 'one');
  assert.equal(p.tools, '');
  assert.deepEqual(p.surfaces, []);
  assert.deepEqual(p.aliases, []);
  assert.equal(p.match({}), false, 'a plugin without match() never claims a bare message');
  assert.throws(() => reg.register(fake('one')), /registered twice/);
  assert.throws(() => reg.register(fake('Bad Id')), /lowercase/);
  assert.throws(() => reg.register({ id: 'nohandle', label: 'x' }), /handle/);
  assert.throws(() => reg.register(fake('two', { aliases: ['one'] })), /taken/);
  const two = reg.register(fake('Two', { aliases: ['Deux', 'two', 'bad name'], surfaces: ['map'], tools: ' t ' }));
  assert.equal(two.id, 'two', 'ids are lowercased');
  assert.deepEqual(two.aliases, ['deux'], 'aliases are lowercased, the id itself and bad names dropped');
  assert.deepEqual(reg.ids(), ['one', 'two']);
  assert.equal(reg.normalize('DEUX'), 'two');
  assert.equal(reg.normalize('three'), null);
  assert.equal(reg.get('two').tools, ' t ');
});

test('route: address, then the chat binding, then match(), then the default', () => {
  const reg = PL.createRegistry();
  reg.register(fake('code', { aliases: ['claude'] }));
  reg.register(fake('ask'));
  reg.register(fake('board', { match: job => /^board:/.test(job.text) }));
  // The default is the first registered plugin unless the caller names one.
  assert.equal(reg.route({ text: 'hi' }).plugin.id, 'code');
  assert.equal(reg.route({ text: 'hi' }).why, 'default');
  assert.equal(reg.route({ text: 'hi' }, { fallback: 'ask' }).plugin.id, 'ask');
  assert.equal(reg.route({ text: 'hi' }, { fallback: 'nope' }).plugin.id, 'code', 'an unknown fallback is ignored');
  // The chat's binding wins over match() and the default; an unknown one is an error.
  assert.equal(reg.route({ text: 'board: x', plugin: 'ask' }).plugin.id, 'ask');
  assert.equal(reg.route({ text: 'hi', plugin: 'ask' }).why, 'bound');
  assert.match(reg.route({ text: 'hi', plugin: 'factory' }).error, /Unknown plugin "factory".*code, ask, board/);
  // match() only on a chat bound to nothing.
  const m = reg.route({ text: 'board: what is blocked' }, { fallback: 'ask' });
  assert.equal(m.plugin.id, 'board');
  assert.equal(m.why, 'matched');
  // An address at the start of the text beats everything and is stripped; the rest of the text is untouched.
  const a = reg.route({ text: '@claude fix  the build', plugin: 'ask' });
  assert.equal(a.plugin.id, 'code');
  assert.equal(a.why, 'addressed');
  assert.equal(a.text, 'fix  the build');
  assert.equal(reg.route({ text: '/ask what drops it' }).plugin.id, 'ask');
  assert.equal(reg.route({ text: '/ASK  x' }).text, 'x');
  // Not an address: an unknown name, a name with nothing after it, a bare sigil, a path.
  for (const text of ['@nobody hi', '@ask', '@ask   ', '/', '@', '/usr/bin/x', 'ask me']) {
    const r = reg.route({ text }, { fallback: 'ask' });
    assert.equal(r.plugin.id, 'ask', text);
    assert.equal(r.text, undefined, text);
  }
  assert.deepEqual(PL.parseAddress('@code   go'), { name: 'code', text: 'go' });
  assert.equal(PL.parseAddress('code go'), null);
  // A match() that throws is a no.
  reg.register(fake('broken', { match: () => { throw new Error('x'); } }));
  assert.equal(reg.route({ text: 'zzz' }, { fallback: 'ask' }).plugin.id, 'ask');
  assert.match(PL.createRegistry().route({ text: 'hi' }).error, /no plugins/);
});

test('the plugin binding travels as a plugin= flag and in the reload outbox, only when set', () => {
  const none = { newSession: false, hello: false, forget: false, context: false, vision: false, allow: [], agent: '' };
  assert.deepEqual(P.parseFlags('agent=codex'), { ...none, agent: 'codex' }, 'no plugin key at all without the flag');
  assert.deepEqual(P.parseFlags('plugin=Ask;v'), { ...none, vision: true, plugin: 'ask' });
  assert.deepEqual(P.parseFlags('plugin='), none, 'an empty binding is no binding');
  const job = P.jobsFromStrip(3, ['s', 'c1', '3', '', 'plugin=claude-code;agent=grok', 'N', 'hi'].join('\x1F'))[0];
  assert.equal(job.plugin, 'claude-code');
  assert.equal(job.agent, 'grok');
  assert.equal(job.text, 'hi');
  const hex = s => Buffer.from(s, 'utf8').toString('hex');
  const src = `WoWAIDB = {\n["outbox"] = {\n["id"] = 7,\n["session"] = "abc",\n["chat"] = "c1",\n["text"] = "${hex('q')}",\n["cwd"] = "",\n["plugin"] = "ask",\n},\n}`;
  assert.equal(P.parseOutbox(src).plugin, 'ask');
  assert.equal(P.parseOutbox(src.replace('["plugin"] = "ask",\n', '')).plugin, undefined);
});

test('slot files name the default plugin and the list, and a reply names the plugin that answered', () => {
  const lua = P.luaTable('WoWAI_SlotData', [{ chat: 'c', id: 1, status: 'done', text: 'x', plugin: 'ask' }, { chat: 'c', id: 2, status: 'done', text: 'y' }], { plugin: 'ask', plugins: ['ask', 'claude-code'] });
  assert.ok(lua.includes('\tplugin = "ask",'), lua);
  assert.ok(lua.includes('\tplugins = { "ask", "claude-code" },'), lua);
  assert.equal((lua.match(/\t\t\tplugin = "ask",/g) || []).length, 1, 'only the record that has one');
  const bare = P.luaTable('WoWAI_Inbox', []);
  assert.ok(bare.includes('\tplugin = "",') && bare.includes('\tplugins = {  },'), bare);
});

test('the system prompt carries a plugin\'s instructions right after the reply rules, and nothing extra without them', () => {
  assert.equal(P.systemPrompt('', '', { tools: '' }), P.systemPrompt(''), 'empty tools = the prompt as it was');
  assert.equal(P.systemPrompt('Character: X', '# P', { tools: '  ' }), P.systemPrompt('Character: X', '# P'));
  const s = P.systemPrompt('Character: X', '# P', { tools: 'Be the guide.', image: { width: 10, height: 5 } });
  assert.ok(s.includes('\n\nBe the guide.\n\n'));
  assert.ok(s.indexOf('"TL;DR:"') < s.indexOf('Be the guide.'), 'after the reply rules');
  assert.ok(s.indexOf('Be the guide.') < s.indexOf('screenshot of the player'), 'before the vision hint');
  assert.ok(s.indexOf('Be the guide.') < s.indexOf('in-game situation'), 'before the context');
});

test('the shipped coding plugin: a folder resolved against the bridge\'s, refused when missing, and a fresh session when it changes', () => {
  const code = require('../bridge/plugins/claude-code');
  const reg = PL.createRegistry();
  const p = reg.register(code);
  assert.equal(p.id, 'claude-code');
  assert.deepEqual(p.aliases, ['claude', 'code']);
  assert.equal(p.tools, '', 'the coding plugin adds nothing to the prompt: the prompt is what it was');
  assert.deepEqual(p.surfaces, ['map', 'macro']);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wowai-plug-'));
  fs.mkdirSync(path.join(base, 'realms'));
  const calls = [];
  const core = {
    log: noop, tag: j => '#' + j.id, defaultCwd: base,
    sessionFolder: () => path.join(base, 'realms'),
    fail: (job, text) => calls.push({ fail: text }),
    runAgent: (job, opts) => calls.push({ run: opts }),
  };
  // A relative folder is joined to the bridge's; the run happens there and job.cwd says so.
  const job = { id: 1, cwd: 'realms', text: 'hi' };
  p.handle(job, core);
  assert.equal(job.cwd, path.join(base, 'realms'));
  assert.equal(calls[0].run.cwd, path.join(base, 'realms'));
  assert.equal(calls[0].run.freshSession(), '', 'same folder as the session: resume');
  // Another folder than the session's means a new session.
  p.handle({ id: 2, cwd: '', text: 'hi' }, core);
  assert.equal(calls[1].run.cwd, base);
  assert.match(calls[1].run.freshSession(), /folder changed/);
  // A folder that does not exist is refused with the siblings as a hint.
  p.handle({ id: 3, cwd: 'nope', text: 'hi' }, core);
  assert.match(calls[2].fail, /Folder does not exist/);
  assert.ok(calls[2].fail.includes('Folders there: realms'));
  fs.rmSync(base, { recursive: true, force: true });
});
