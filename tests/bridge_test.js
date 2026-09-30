// Unit tests for the bridge's pure protocol code (bridge/protocol.js).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const P = require('../bridge/protocol');

test('luaStr escapes everything Lua 5.1 needs', () => {
  assert.equal(P.luaStr('a"b\\c\nd\re\x01'), '"a\\"b\\\\c\\nde\\001"');
  assert.equal(P.luaStr(null), '""');
  assert.equal(P.luaStr(42), '"42"');
});

test('parseFlags reads new-session, hello, forget, context, agent and allow lists', () => {
  const none = { newSession: false, hello: false, forget: false, context: false, vision: false, allow: [], agent: '' };
  assert.deepEqual(P.parseFlags(''), none);
  assert.deepEqual(P.parseFlags('n'), { ...none, newSession: true });
  assert.deepEqual(P.parseFlags('v'), { ...none, vision: true });
  assert.deepEqual(P.parseFlags('agent=codex;v;c'), { ...none, vision: true, context: true, agent: 'codex' });
  assert.deepEqual(P.parseFlags('h'), { ...none, hello: true });
  assert.deepEqual(P.parseFlags('d'), { ...none, forget: true });
  assert.deepEqual(P.parseFlags('h;c'), { ...none, hello: true, context: true });
  assert.deepEqual(P.parseFlags('n;allow=WebSearch, Bash(git:*),'), { ...none, newSession: true, allow: ['WebSearch', 'Bash(git:*)'] });
  assert.deepEqual(P.parseFlags('agent=Codex'), { ...none, agent: 'codex' });
  assert.deepEqual(P.parseFlags('n;agent=grok;allow=WebSearch'), { ...none, newSession: true, agent: 'grok', allow: ['WebSearch'] });
  assert.deepEqual(P.parseFlags('once=Bash(rm:*), WebFetch'), { ...none, allowOnce: ['Bash(rm:*)', 'WebFetch'] });
  assert.equal(P.parseFlags('allow=WebSearch').allowOnce, undefined, 'no allowOnce key at all without the flag');
});

test('parseFlags reads the per-chat settings and the resume and live targets /claude sends, and drops values that do not fit', () => {
  const hex = s => Buffer.from(s).toString('hex');
  const f = P.parseFlags(`agent=claude;model=claude-opus-5[1m];effort=HIGH;pm=PLAN;dirs=${hex('realms\x1F~/notes')};resume=f02436b8-8a5f;live=${hex('wow-ai main')}`);
  assert.equal(f.model, 'claude-opus-5[1m]');
  assert.equal(f.effort, 'high');
  assert.equal(f.permissionMode, 'plan', 'the mode is spelled the way the CLI wants it');
  assert.deepEqual(f.addDirs, ['realms', '~/notes']);
  assert.equal(f.resume, 'f02436b8-8a5f');
  assert.equal(f.liveTarget, 'wow-ai main');
  const bad = P.parseFlags('model=two words;effort=;pm=yolo;resume=a b;live=zz;dirs=');
  for (const k of ['model', 'effort', 'permissionMode', 'resume', 'liveTarget', 'addDirs']) assert.equal(bad[k], undefined, k);
  const many = P.parseFlags(`dirs=${hex(Array.from({ length: 12 }, (_, i) => 'd' + i).join('\x1F'))}`);
  assert.equal(many.addDirs.length, P.ADD_DIRS_MAX);
  assert.equal(P.parseFlags('plugin=live').liveTarget, undefined, 'plugin=live is a binding, not a target');
});

test('parseOutbox reads the same settings from the opts field of the reload outbox', () => {
  const hex = s => Buffer.from(s).toString('hex');
  const src = `ClaudeWoWDB = { ["outbox"] = { ["id"] = 9, ["text"] = "${hex('go on')}", ["cwd"] = "${hex('/proj')}", ["session"] = "s1", ["chat"] = "c1", ["plugin"] = "claude-code", ["opts"] = "${hex('model=opus;resume=f02436b8-8a5f-4c05-823e-bef25f88ff7b')}", }, }`;
  const job = P.parseOutbox(src);
  assert.equal(job.text, 'go on');
  assert.equal(job.model, 'opus');
  assert.equal(job.resume, 'f02436b8-8a5f-4c05-823e-bef25f88ff7b');
  assert.equal(job.plugin, 'claude-code');
  assert.equal(P.parseOutbox(src.replace(/\["opts"\][^,]*,/, '')).model, undefined);
});

test('withRunOnlyRules adds greed rules to one run without touching the saved agent config', () => {
  const saved = { permissionMode: 'acceptEdits', allowedTools: ['WebSearch'] };
  const run = P.withRunOnlyRules(saved, ['Bash(rm:*)', 'WebSearch', '']);
  assert.deepEqual(run.allowedTools, ['WebSearch', 'Bash(rm:*)']);
  assert.equal(run.permissionMode, 'acceptEdits');
  assert.deepEqual(saved.allowedTools, ['WebSearch']);
  assert.equal(P.withRunOnlyRules(saved, []), saved);
  assert.equal(P.withRunOnlyRules(saved, undefined), saved);
  assert.deepEqual(P.withRunOnlyRules({ model: 'x' }, ['WebFetch']).allowedTools, ['WebFetch']);
  const A = require('../bridge/agents');
  const claudeArgs = A.AGENTS.claude.args({ cfg: run, resume: '', cwd: 'x', system: '', promptFile: 'f' });
  assert.ok(claudeArgs.includes('Bash(rm:*)'), 'Claude gets the greed rule in --allowedTools');
  const grokArgs = A.AGENTS.grok.args({ cfg: run, resume: '', cwd: 'x', system: '', promptFile: 'f' });
  assert.ok(grokArgs.includes('Bash(rm *)'), 'Grok gets the greed rule as an --allow glob');
});

test('parseFlags reads cancel=<id> and ignores a bad one', () => {
  assert.equal(P.parseFlags('cancel=42').cancel, 42);
  assert.equal(P.parseFlags('cancel=x').cancel, undefined);
  assert.equal(P.parseFlags('n').cancel, undefined);
});

test('parseFlags reads shot=missing / shot=failed (the addon cannot take the screenshot the transport needs) and nothing else under shot=', () => {
  assert.equal(P.parseFlags('h;c;shot=missing').shot, 'missing');
  assert.equal(P.parseFlags('shot=failed;v').shot, 'failed');
  assert.equal(P.parseFlags('shot=bogus').shot, undefined, 'an unknown reason is ignored');
  assert.equal(P.parseFlags('v').shot, undefined, 'absent unless the flag is there, so older records parse exactly as before');
  const job = P.jobsFromStrip(5, ['sess', 'c1', '5', '', 'shot=missing', 'Chat', 'hi'].join('\x1F'))[0];
  assert.equal(job.shot, 'missing');
  assert.equal(job.text, 'hi');
});

test('the screenshot transport is the default; an explicit capture.mode wins; a remembered fallback puts an unset mode on pixels', () => {
  assert.equal(P.DEFAULT_TRANSPORT, 'screenshot');
  assert.equal(P.transportName(undefined), 'screenshot');
  assert.equal(P.transportName(''), 'screenshot');
  assert.equal(P.transportName('PIXEL'), 'pixel');
  assert.equal(P.transportName('gif'), '');
  // A new install, or a config.json from before the mode existed: the default.
  assert.deepEqual(P.chooseTransport(undefined, {}), { transport: 'screenshot', source: 'default', fallback: null });
  assert.deepEqual(P.chooseTransport({ enabled: true }, { sessions: {} }), { transport: 'screenshot', source: 'default', fallback: null });
  // An existing config.json with an explicit mode keeps what it has.
  assert.deepEqual(P.chooseTransport({ mode: 'pixel' }, {}), { transport: 'pixel', source: 'config', fallback: null });
  assert.deepEqual(P.chooseTransport({ mode: 'screenshot' }, {}), { transport: 'screenshot', source: 'config', fallback: null });
  assert.equal(P.chooseTransport({ mode: 'gif' }, {}).transport, '', 'a bad explicit mode is refused, not defaulted');
  // A previous run fell back to pixels: without an explicit mode the next start goes straight there...
  const fb = { reason: 'missing', at: 1700000000000, session: 's1' };
  assert.deepEqual(P.chooseTransport({}, { transportFallback: fb }), { transport: 'pixel', source: 'fallback', fallback: fb });
  // ...and an explicit mode still wins over the memory.
  assert.equal(P.chooseTransport({ mode: 'screenshot' }, { transportFallback: fb }).source, 'config');
  assert.equal(P.chooseTransport({}, { transportFallback: { reason: 'weird' } }).source, 'default', 'a memory with an unknown reason does not count');
});

test('transportFallback remembers the addon\'s report once per reason and words the note for the log and the slot files', () => {
  const state = {};
  const note = P.transportFallback(state, 'missing', { session: 'abc', id: 3 }, Date.UTC(2026, 8, 28, 12, 30));
  assert.deepEqual(state.transportFallback, { reason: 'missing', at: Date.UTC(2026, 8, 28, 12, 30), session: 'abc' });
  assert.match(note, /^pixel transport, fallen back to since 2026-09-28 12:30 UTC because the game client has no Screenshot\(\) function; the pixel capture is deprecated: set capture\.mode in config\.json to "pixel" .* or to "screenshot" to try the screenshot transport again$/);
  assert.equal(P.transportFallback(state, 'missing', { session: 'abc' }), null, 'the same reason again: nothing new');
  assert.ok(P.transportFallback(state, 'failed', {}), 'a different reason is recorded');
  assert.equal(state.transportFallback.reason, 'failed');
  assert.equal(P.transportFallback(state, 'bogus', {}), null);
  assert.equal(P.transportNote(null), '');
  assert.equal(P.transportNote(state.transportFallback), note.replace('2026-09-28 12:30 UTC', new Date(state.transportFallback.at).toISOString().slice(0, 16).replace('T', ' ') + ' UTC').replace('has no Screenshot() function', 'reported SCREENSHOT_FAILED on every try'));
});

test('parseOutbox reads the shot field the addon writes when it cannot take the screenshot', () => {
  const hex = s => Buffer.from(s, 'utf8').toString('hex');
  const src = `ClaudeWoWDB = {\n["outbox"] = {\n["id"] = 9,\n["session"] = "s1",\n["chat"] = "c1",\n["text"] = "${hex('hi')}",\n["cwd"] = "",\n["shot"] = "missing",\n},\n}`;
  const job = P.parseOutbox(src);
  assert.equal(job.shot, 'missing');
  assert.equal(job.text, 'hi');
  assert.equal(P.parseOutbox(src.replace('"missing"', '"nope"')).shot, undefined);
  assert.equal(P.parseOutbox(src.replace('["shot"] = "missing",\n', '')).shot, undefined);
});

test('luaTable carries the fallback note when there is one', () => {
  assert.ok(!/transportNote/.test(P.luaTable('X', [], { transport: 'pixel' })), 'no note unless given');
  const lua = P.luaTable('X', [], { transport: 'pixel', transportNote: 'pixel transport, fallen back to "why"' });
  assert.match(lua, /^\ttransportNote = "pixel transport, fallen back to \\"why\\"",$/m);
});

test('jobsFromStrip parses the current record format and keeps separators inside text', () => {
  const rec = ['sess', 'chat1', '12', 'realms', 'allow=WebSearch', 'My chat', 'hello\x1Fworld'].join('\x1F');
  const jobs = P.jobsFromStrip(12, rec);
  assert.equal(jobs.length, 1);
  assert.deepEqual(jobs[0], { session: 'sess', chat: 'chat1', id: 12, cwd: 'realms', newSession: false, hello: false, forget: false, context: false, vision: false, allow: ['WebSearch'], agent: '', name: 'My chat', text: 'hello\x1Fworld', via: 'pixel' });
  // A chat that picked its own agent says so in the flags.
  const codex = P.jobsFromStrip(13, ['sess', 'chat1', '13', '', 'agent=codex', 'My chat', 'hi'].join('\x1F'))[0];
  assert.equal(codex.agent, 'codex');
  assert.equal(codex.text, 'hi');
});

test('jobsFromStrip reads the game context field only when the flags say so', () => {
  const ctx = 'Game: World of Warcraft: Forever\nCharacter: Testchar, level 23 Hunter';
  const withCtx = ['sess', 'chat1', '13', '', 'c', 'My chat', ctx, 'is this\x1Fgood'].join('\x1F');
  const jobs = P.jobsFromStrip(13, withCtx);
  assert.equal(jobs[0].context, true);
  assert.equal(jobs[0].ctx, ctx);
  assert.equal(jobs[0].text, 'is this\x1Fgood');
  // An empty context clears it; a hello carries one too.
  const hello = P.jobsFromStrip(14, ['sess', 'chat1', '14', '', 'h;c', 'My chat', '', ''].join('\x1F'))[0];
  assert.equal(hello.hello, true);
  assert.equal(hello.ctx, '');
  assert.equal(hello.text, '');
  // Without the flag, a seventh field is just text with a separator in it.
  const plain = P.jobsFromStrip(15, ['sess', 'chat1', '15', '', '', 'My chat', 'a', 'b'].join('\x1F'))[0];
  assert.equal(plain.ctx, undefined);
  assert.equal(plain.text, 'a\x1Fb');
  // A "c" flag on a record too short to hold the field is not trusted.
  const short = P.jobsFromStrip(16, ['sess', 'chat1', '16', '', 'c', 'My chat', 'only text'].join('\x1F'))[0];
  assert.equal(short.ctx, undefined);
  assert.equal(short.text, 'only text');
});

test('systemPrompt always asks for the TL;DR block, and adds the game rules and primer while a context is sent', () => {
  // Without a context the prompt is only the reply-format rule.
  for (const empty of ['', '  \n ', undefined]) {
    const s = P.systemPrompt(empty);
    assert.ok(s.includes('claude-wow addon'));
    assert.ok(s.includes('"TL;DR:"'), 'asks for the summary marker');
    assert.ok(!s.includes('in-game situation'), 'no game rules without a context');
    assert.ok(!s.includes('Reference for writing addons'), 'no primer section without a context');
  }
  const ctx = 'Game: World of Warcraft: Forever\nCharacter: Testchar, level 23 Hunter\nPosition: 51.5, 30.4 (map 1413)';
  const s = P.systemPrompt(ctx);
  assert.ok(s.includes('"TL;DR:"'));
  assert.ok(s.includes('CLAUDE_WOW_MAP_FILE') && s.includes('wowmap') && s.includes('"op":"set"'), 'explains how to mark the map');
  assert.ok(!P.systemPrompt('').includes('CLAUDE_WOW_MAP_FILE'), 'map hint only with the game context');
  assert.ok(s.includes('CLAUDE_WOW_SAVED_VARIABLES') && s.includes('World of Warcraft: Forever'), 'a game chat is told where to find NPCs in this client, before the web');
  assert.ok(!P.systemPrompt('').includes('CLAUDE_WOW_SAVED_VARIABLES'), 'and only a game chat');
  assert.ok(s.includes('in-game situation') && s.includes('Linked from the game'), 'says what the situation block and the links are');
  assert.ok(!s.includes('Testchar') && !s.includes('51.5'), 'the context\'s text is not in the system prompt: it changes with every step (messagePrompt carries it)');
  assert.ok(!s.includes('Reference for writing addons'), 'no primer section without a primer');
  // The primer rides with the game rules, and only with them.
  const withPrimer = P.systemPrompt('Character: Testchar', '# Primer\n\nUse local.');
  assert.ok(withPrimer.endsWith('Reference for writing addons and macros for this client. Follow it when the task is about WoW, and check anything it marks as uncertain against the Blizzard UI source it names:\n\n# Primer\n\nUse local.'));
  assert.ok(!P.systemPrompt('', '# Primer').includes('# Primer'));
  // Stable: the same bytes whatever the context says and whether a screenshot
  // is attached, so a resumed chat's prefix is byte-identical (prompt caching,
  // and Claude Code's recorded system prompt).
  assert.equal(P.systemPrompt('Character: A\nPosition: 1, 2', '# P'), P.systemPrompt('Character: B\nPosition: 3, 4', '# P'));
  assert.equal(P.systemPrompt('Character: X', '# P', { image: { width: 1280, height: 712 } }), P.systemPrompt('Character: X', '# P'));
  for (const s of [P.systemPrompt(''), P.systemPrompt('Character: X', '# P'), P.systemPrompt('Character: X', '# P', { image: { width: 1, height: 1 } })]) {
    assert.ok(!s.includes('screenshot of the player'), 'the vision paragraph is not in the system prompt');
  }
});

test('messagePrompt puts the situation and the vision paragraph before the text, and nothing else', () => {
  assert.equal(P.messagePrompt('fix it', ''), 'fix it');
  assert.equal(P.messagePrompt('fix it', '  \n', {}), 'fix it');
  assert.equal(P.messagePrompt('fix it', '', { image: null }), 'fix it');
  assert.equal(P.messagePrompt(undefined, ''), '');
  const ctx = 'Game: World of Warcraft: Forever\nCharacter: Testchar, level 23 Hunter\nPosition: 51.5, 30.4 (map 1413)';
  const m = P.messagePrompt('where am I?', ctx);
  assert.ok(m.startsWith('[In-game situation when this message was written, reported by the claude-wow addon, not written by the player]\n' + ctx + '\n[End of in-game situation]\n\nwhere am I?'), m);
  assert.ok(m.endsWith('\n\nwhere am I?'), 'the text is last, after everything that changes per message');
  assert.equal(P.messagePrompt('where am I?', ctx + '\n\n'), m, 'a trailing newline in the context changes nothing');
  // Vision: the attached-screen paragraph only when an image really is attached.
  const seeing = P.messagePrompt('what is this?', ctx, { image: { width: 1280, height: 712 } });
  assert.ok(seeing.includes('A screenshot of the player\'s screen') && seeing.includes('(1280x712, downscaled)') && seeing.includes('cropped off'));
  assert.ok(seeing.indexOf('[End of in-game situation]') < seeing.indexOf('screenshot of the player') && seeing.endsWith('\n\nwhat is this?'), 'situation, then the vision paragraph, then the text');
  const seeingNoCtx = P.messagePrompt('what is this?', '', { image: { width: 1280, height: 712 } });
  assert.ok(seeingNoCtx.startsWith('A screenshot of the player') && seeingNoCtx.endsWith('\n\nwhat is this?') && !seeingNoCtx.includes('in-game situation'));
  assert.equal(P.visionHint({}), P.visionHint(null));
  assert.ok(!P.visionHint({}).includes('downscaled)'), 'no size when unknown');
});

test('splitSummary takes the last TL;DR block for the game chat and keeps the whole reply for the window', () => {
  const reply = 'Renamed the function.\n\nDetails:\n- foo.js\n- bar.js\n\n---\n**TL;DR:** Renamed doIt to run in foo.js and bar.js.\nTests pass.';
  const r = P.splitSummary(reply);
  assert.equal(r.summary, 'Renamed doIt to run in foo.js and bar.js.\nTests pass.');
  assert.equal(r.text, reply);
  assert.deepEqual(P.splitSummary('no marker here'), { text: 'no marker here', summary: '' });
  assert.deepEqual(P.splitSummary(''), { text: '', summary: '' });
  assert.deepEqual(P.splitSummary(undefined), { text: '', summary: '' });
  // Headings, missing colon, no bold, and a marker that is not at a line start.
  assert.equal(P.splitSummary('a\n## TL;DR\nsum').summary, 'sum');
  assert.equal(P.splitSummary('a\ntldr: sum').summary, 'sum');
  assert.equal(P.splitSummary('a TL;DR: inline\nmore').summary, '');
  assert.equal(P.splitSummary('first TL;DR: x\n\nbody\n\nTL;DR: last one').summary, 'last one');
  // The slot file carries the summary only when there is one.
  const lua = P.luaTable('ClaudeWoW_SlotData', [{ chat: 'c', id: 1, status: 'done', text: 'body\nTL;DR: short', summary: 'short' }, { chat: 'c', id: 2, status: 'done', text: 'plain' }]);
  assert.ok(lua.includes('summary = "short"'));
  assert.equal((lua.match(/summary = /g) || []).length, 1);
});

test('the shipped primer exists, mentions the essentials, and stays small enough to send on every run', () => {
  const fs = require('fs');
  const primer = fs.readFileSync(path.join(__dirname, '..', 'docs', 'WOW-ADDON-PRIMER.md'), 'utf8');
  for (const must of ['## Interface: 16001', 'Gethe/wow-ui-source', 'InCombatLockdown', 'hooksecurefunc', 'SavedVariables', '/reload', '#showtooltip']) {
    assert.ok(primer.includes(must), 'primer mentions ' + must);
  }
  assert.ok(primer.length < 9000, `primer is ${primer.length} chars; keep it under 9000 (it costs tokens on every message)`);
});

test('jobsFromStrip handles several records per frame and older formats', () => {
  const a = ['s', 'c1', '3', '', '', 'A', 'first'].join('\x1F');
  const b = ['s', 'c2', '4', 'C:\\x', 'n', 'second'].join('\x1F'); // no-name format
  const c = ['s', 'C:\\y', '', 'third'].join('\x1F'); // pre-chat format
  const jobs = P.jobsFromStrip(9, [a, b, c].join('\x1E'));
  assert.deepEqual(jobs.map(j => [j.id, j.chat, j.text, j.newSession]), [[3, 'c1', 'first', false], [4, 'c2', 'second', true], [9, '', 'third', false]]);
  assert.deepEqual(P.jobsFromStrip(1, 'garbage'), []);
  assert.deepEqual(P.jobsFromStrip(1, ['s', 'c', 'notanumber', '', '', '', 'x'].join('\x1F')), []);
});

test('parseOutbox decodes the SavedVariables fallback', () => {
  const hex = s => Buffer.from(s, 'utf8').toString('hex');
  const src = `ClaudeWoWDB = {\n["outbox"] = {\n["id"] = 7,\n["session"] = "abc123",\n["chat"] = "c1",\n["text"] = "${hex('héllo')}",\n["cwd"] = "${hex('realms')}",\n["newSession"] = true,\n},\n["settings"] = {},\n}`;
  assert.deepEqual(P.parseOutbox(src), { id: 7, session: 'abc123', chat: 'c1', text: 'héllo', cwd: 'realms', newSession: true, via: 'reload' });
  const withAllow = src.replace('["newSession"]', `["allow"] = "${hex('WebSearch\x1fBash(git:*)')}",\n["newSession"]`);
  assert.deepEqual(P.parseOutbox(withAllow).allow, ['WebSearch', 'Bash(git:*)']);
  assert.equal(P.parseOutbox(withAllow).allowOnce, undefined);
  const withAllowOnce = src.replace('["newSession"]', `["allowOnce"] = "${hex('Bash(rm:*)')}",\n["newSession"]`);
  assert.deepEqual(P.parseOutbox(withAllowOnce).allowOnce, ['Bash(rm:*)']);
  assert.equal(P.parseOutbox(withAllowOnce).allow, undefined);
  const withCtx = src.replace('["newSession"]', `["ctx"] = "${hex('Character: Testchar')}",\n["newSession"]`);
  assert.equal(P.parseOutbox(withCtx).ctx, 'Character: Testchar');
  const withAgent = src.replace('["newSession"]', '["agent"] = "codex",\n["newSession"]');
  assert.equal(P.parseOutbox(withAgent).agent, 'codex');
  assert.equal(P.parseOutbox(src).agent, undefined);
  assert.equal(P.parseOutbox('ClaudeWoWDB = {}'), null);
  assert.equal(P.parseOutbox('["outbox"] = { ["text"] = "" }'), null);
});

test('resolveCwd: empty is the default, relative joins it, ~ is home, absolute wins', () => {
  const base = path.resolve('C:\\work\\proj');
  assert.equal(P.resolveCwd('', base), base);
  assert.equal(P.resolveCwd('  ', base), base);
  assert.equal(P.resolveCwd('realms', base), path.join(base, 'realms'));
  assert.equal(P.resolveCwd('./realms/', base), path.join(base, 'realms'));
  assert.equal(P.resolveCwd('../other', base), path.resolve(base, '..', 'other'));
  assert.equal(P.resolveCwd('~/x', base), path.join(os.homedir(), 'x'));
  assert.equal(P.resolveCwd('D:\\elsewhere', base), path.win32.normalize('D:\\elsewhere'));
  assert.ok(P.sameFolder('C:\\A\\b\\', 'c:/a/B'));
  assert.ok(!P.sameFolder('C:\\a', 'C:\\a\\b'));
});

test('ruleFor turns denials into prefix rules', () => {
  assert.equal(P.ruleFor({ tool_name: 'WebSearch' }), 'WebSearch');
  assert.equal(P.ruleFor({ tool_name: 'Bash', tool_input: { command: 'cargo build --release' } }), 'Bash(cargo:*)');
  assert.equal(P.ruleFor({ tool_name: 'Bash', tool_input: { command: '"C:\\weird path\\x.exe" arg' } }), 'Bash');
  assert.equal(P.ruleFor({}), 'Unknown');
});

test('folder grants: AddDir(<folder>) entries split from rules, and folder containment', () => {
  assert.equal(P.folderRule('/tmp'), 'AddDir(/tmp)');
  assert.equal(P.ruleFolder('AddDir(/a (b))'), '/a (b)');
  assert.equal(P.ruleFolder('Bash(ls:*)'), '');
  assert.deepEqual(P.splitGrants(['Bash(ls:*)', 'AddDir(/tmp)', '', 'WebSearch']), { rules: ['Bash(ls:*)', 'WebSearch'], dirs: ['/tmp'] });
  assert.deepEqual(P.splitGrants(undefined), { rules: [], dirs: [] });
  assert.equal(P.insideFolder('/tmp/x.txt', '/tmp'), true);
  assert.equal(P.insideFolder('/tmp', '/tmp/'), true);
  assert.equal(P.insideFolder('/tmpfoo/x', '/tmp'), false);
  assert.equal(P.insideFolder('/srv/x', '/tmp'), false);
  assert.equal(P.insideFolder('C:\\Games\\wow\\x.lua', 'c:\\games'), true);
  assert.equal(P.insideFolder('', '/tmp'), false);
  const dirs = new Set(['/', '/tmp']);
  assert.equal(P.nearestFolder('/tmp/a/b/c.txt', p => dirs.has(p)), '/tmp');
  assert.equal(P.nearestFolder('/tmp', p => dirs.has(p)), '/tmp');
  assert.equal(P.nearestFolder('/tmp/x.txt'), '/tmp');
});

test('classifyDenial: outside the working folders becomes a folder, anything else a rule; deniedAgain spots a repeat', () => {
  const isDir = p => ['/', '/tmp', '/work'].includes(p);
  const touch = { tool_name: 'Bash', tool_input: { command: 'touch /tmp/demo.txt' } };
  const outside = P.classifyDenial(touch, { message: "touch in '/tmp/demo.txt' needs approval. The path is outside the working directories for this session ('/work'). Allowing runs the command as written." }, { cwd: '/work', isDir });
  assert.deepEqual({ kind: outside.kind, rule: outside.rule, folder: outside.folder, path: outside.path }, { kind: 'folder', rule: 'AddDir(/tmp)', folder: '/tmp', path: '/tmp/demo.txt' });
  const relative = P.classifyDenial(touch, { message: "touch in '../tmp/demo.txt' needs approval. The path is outside the working directories for this session." }, { cwd: '/work', isDir });
  assert.equal(relative.path, '/tmp/demo.txt');
  const write = P.classifyDenial({ tool_name: 'Write', tool_input: { file_path: '/tmp/w.txt' } }, { reasonType: 'workingDir', message: 'Claude requested permissions to write to /tmp/w.txt, but you haven\'t granted it yet.' }, { cwd: '/work', isDir });
  assert.equal(write.rule, 'AddDir(/tmp)');
  const plain = P.classifyDenial({ tool_name: 'Bash', tool_input: { command: 'curl x' } }, { message: 'This command requires approval' }, { cwd: '/work', isDir });
  assert.deepEqual({ kind: plain.kind, rule: plain.rule }, { kind: 'rule', rule: 'Bash(curl:*)' });
  assert.equal(P.classifyDenial({ tool_name: 'Bash', tool_input: { command: 'ls /x' } }, { message: 'outside the working directories' }, {}).kind, 'rule', 'no path named: a rule');
  assert.equal(P.classifyDenial(touch).rule, 'Bash(touch:*)');

  const granted = P.grantsFor({ allowedTools: ['Bash(curl:*)'], addDirs: ['/tmp'] }, '/work');
  assert.deepEqual(granted, { rules: ['Bash(curl:*)'], dirs: ['/work', '/tmp'] });
  assert.equal(P.deniedAgain(outside, granted), true);
  assert.equal(P.deniedAgain(plain, granted), true);
  assert.equal(P.deniedAgain(outside, P.grantsFor({ allowedTools: ['Bash(touch:*)'] }, '/work')), false, 'an allowed rule never covers a folder');
  assert.equal(P.deniedAgain({ kind: 'rule', rule: 'WebSearch' }, granted), false);
  assert.equal(P.deniedAgain(outside, undefined), false);

  const notes = P.denialNotes('Claude', [outside, plain], []);
  assert.equal(notes.length, 2);
  assert.match(notes[0], /needed 1 action\(s\)[\s\S]*Bash: curl x/);
  assert.match(notes[1], /blocked outside this chat's folders:\n {2}Bash: touch \/tmp\/demo\.txt \(folder \/tmp\)/);
  const again = P.denialNotes('Claude', [], [outside, outside]);
  assert.equal(again.length, 1, 'one line per repeat');
  assert.ok(!again[0].includes('\n'));
});

test('flags: a retry granted a folder carries it in dirs=, never in allow=', () => {
  const hex = Buffer.from(['/srv/data', '/tmp'].join('\x1F')).toString('hex');
  const f = P.parseFlags(`once=Bash(curl:*);dirs=${hex}`);
  assert.deepEqual(f.allowOnce, ['Bash(curl:*)']);
  assert.deepEqual(f.addDirs, ['/srv/data', '/tmp']);
  assert.deepEqual(f.allow, []);
});

test('describeToolUse gives one short line per tool call', () => {
  assert.equal(P.describeToolUse({ name: 'Bash', input: { command: 'npm test\nsecond line' } }), '$ npm test');
  assert.equal(P.describeToolUse({ name: 'Edit', input: { file_path: 'C:\\x\\player.gd' } }), 'edit player.gd');
  assert.equal(P.describeToolUse({ name: 'Mystery' }), 'Mystery');
});

test('handled ids are tracked per session token and capped', () => {
  const state = { lastId: 0, handled: {}, sessions: {} };
  const job = { session: 's1', id: 5 };
  assert.equal(P.alreadyHandled(state, job), false);
  P.markHandled(state, job, 1000);
  assert.equal(P.alreadyHandled(state, job), true);
  assert.equal(P.alreadyHandled(state, { session: 's2', id: 5 }), false);
  assert.equal(state.lastId, 5);
  assert.equal(state.seen.s1, 1000);
  for (let i = 1; i <= 1200; i++) P.markHandled(state, { session: 's1', id: i });
  assert.ok(Object.keys(state.handled.s1).length <= 1000);
  // Sessionless (inject / very old addon) jobs fall back to the high-water mark.
  assert.equal(P.alreadyHandled(state, { session: '', id: 3 }), true);
  assert.equal(P.alreadyHandled(state, { session: '', id: 5000 }), false);
});

test('pruneStale forgets session tokens not seen for a month', () => {
  const day = 24 * 3600 * 1000;
  const now = 100 * day;
  const state = { lastId: 0, handled: { old: { 1: 1 }, fresh: { 1: 1 }, unknown: { 1: 1 }, '': { 1: 1 } }, seen: { old: now - 40 * day, fresh: now - day } };
  const transcripts = { chats: {}, tokens: { old: now - 40 * day, fresh: now } };
  const removed = P.pruneStale(state, transcripts, now);
  assert.equal(removed, 2);
  assert.deepEqual(Object.keys(state.handled).sort(), ['', 'fresh', 'unknown']);
  assert.equal(state.seen.unknown, now); // grace period starts when first seen by the pruner
  assert.deepEqual(Object.keys(transcripts.tokens), ['fresh']);
});

test('slotNumber wraps and SILENT_WAV is a valid RIFF header', () => {
  assert.equal(P.slotNumber(1, 200), 1);
  assert.equal(P.slotNumber(200, 200), 200);
  assert.equal(P.slotNumber(201, 200), 1);
  assert.equal(P.SILENT_WAV.toString('ascii', 0, 4), 'RIFF');
  assert.equal(P.SILENT_WAV.readUInt32LE(4), P.SILENT_WAV.length - 8);
  assert.equal(P.chatKey({ session: 's', chat: 'c' }), 's:c');
  assert.equal(P.sessKey({ session: 's', chat: 'c' }), 'chat:c');
  assert.equal(P.sessKey({ session: 's', chat: '' }), 's:default');
});

test('slot files name the outbound transport the bridge listens on, screenshot unless told otherwise', () => {
  assert.equal(P.transportName(undefined), 'screenshot');
  assert.equal(P.transportName('Screenshot'), 'screenshot');
  assert.equal(P.transportName('bogus'), '', 'an unknown mode is refused, not silently defaulted');
  assert.deepEqual(P.TRANSPORTS, ['pixel', 'screenshot']);
  const plain = P.luaTable('ClaudeWoW_SlotData', []);
  assert.ok(plain.includes('\ttransport = "screenshot",'), plain);
  const pixel = P.luaTable('ClaudeWoW_SlotData', [], { transport: 'pixel' });
  assert.ok(pixel.includes('\ttransport = "pixel",'), pixel);
  assert.ok(P.luaTable('ClaudeWoW_Inbox', [], { transport: 'nope' }).includes('\ttransport = "screenshot",'), 'garbage falls back to the default in the file');
});

test('screenshot mode ships its strip levels; pixel mode never does', () => {
  assert.deepEqual(P.screenshotLevels(undefined), { off: 0, on: 60, threshold: 31 });
  assert.deepEqual(P.screenshotLevels({ off: 10, on: 90 }), { off: 10, on: 90, threshold: 51 });
  assert.deepEqual(P.screenshotLevels({ off: 0, on: 255 }), { off: 0, on: 255, threshold: 128 }, 'the bright palette reads at the capture scripts\' threshold');
  for (const bad of [{ off: 50, on: 55 }, { off: -1, on: 60 }, { off: 0, on: 300 }, { off: 'a', on: 60 }, { on: 4 }, 'x']) {
    assert.deepEqual(P.screenshotLevels(bad), { off: 0, on: 60, threshold: 31 }, JSON.stringify(bad));
  }
  const shot = P.luaTable('ClaudeWoW_SlotData', [], { transport: 'screenshot', levels: { off: 0, on: 60 } });
  assert.ok(shot.includes('\tstrip = { on = 60, off = 0, codec = 2 },'), shot);
  assert.ok(P.luaTable('ClaudeWoW_SlotData', [], { transport: 'screenshot' }).includes('\tstrip = { on = 60, off = 0, codec = 2 },'), 'default levels and the dense codec when none are given');
  assert.ok(P.luaTable('ClaudeWoW_SlotData', [], { transport: 'screenshot', codec: 1 }).includes('\tstrip = { on = 60, off = 0, codec = 1 },'), 'capture.screenshotCodec 1 asks for the 4 px strip');
  assert.ok(!P.luaTable('ClaudeWoW_SlotData', [], { transport: 'pixel', levels: { off: 0, on: 60 }, codec: 2 }).includes('strip ='), 'pixel mode draws full primaries, codec 1, whatever the config says');
  // The codec: 1 or 2, anything else the default; the dense levels as the addon computes them.
  assert.equal(P.DEFAULT_STRIP_CODEC, 2);
  for (const [raw, want] of [[1, 1], [2, 2], [undefined, 2], [3, 2], ['2', 2], [null, 2]]) assert.equal(P.stripCodec(raw), want, String(raw));
  assert.deepEqual(P.denseLevels(undefined), [0, 20, 40, 60]);
  assert.deepEqual(P.denseLevels({ off: 10, on: 90 }), [10, 37, 63, 90]);
  assert.deepEqual(P.denseLevels({ off: 0, on: 255 }), [0, 85, 170, 255]);
});

test('noteUsage keeps a session-total cost as the total instead of adding it again on every resumed turn', () => {
  const state = {};
  P.noteUsage(state, 'chat:b', { usage: { context: 20000, cost: 0.04, costIsSessionTotal: true }, fresh: true, agent: 'claude', now: 1000 });
  P.noteUsage(state, 'chat:b', { usage: { context: 21500, cost: 0.09, costIsSessionTotal: true }, agent: 'claude', now: 2000 });
  const rec = P.noteUsage(state, 'chat:b', { usage: { context: 23000, cost: 0.15, costIsSessionTotal: true }, agent: 'claude', now: 3000 });
  assert.equal(rec.cost, 0.15);
  assert.equal(P.usageFields(rec).cost, 0.15);
});

test('slotsToClearAhead names the next slots past an id, wraps at the slot count, and spares pending ids', () => {
  assert.deepEqual(P.slotsToClearAhead(10, 200, [], 3), [11, 12, 13]);
  assert.deepEqual(P.slotsToClearAhead(199, 200, [], 3), [200, 1, 2]);
  assert.deepEqual(P.slotsToClearAhead(199, 200, [401], 3), [200, 2], 'id 401 still pending sits in slot 1');
  assert.equal(P.slotsToClearAhead(5, 200).length, P.SIGNAL_CLEAR_AHEAD);
  assert.deepEqual(P.slotsToClearAhead(3, 4, []), [4, 1], 'never more than half the pool');
});

test('context growth: noteUsage counts turns per session, keeps the last known size, and the slot file carries it', () => {
  const state = {};
  // A fresh session: turn 1, with what the agent reported.
  let rec = P.noteUsage(state, 'chat:a', { usage: { context: 31065, output: 1, window: 200000, cost: 0.03 }, fresh: true, agent: 'claude', startedAt: 4000, now: 5000 });
  assert.deepEqual(rec, { turns: 1, agent: 'claude', at: 5000, since: 4000, context: 31065, window: 200000, cost: 0.03 });
  // Resumed: turn 2. The window and the session's start are kept; the cost adds up.
  rec = P.noteUsage(state, 'chat:a', { usage: { context: 44000, cost: 0.05 }, agent: 'claude', startedAt: 5500, now: 6000 });
  assert.deepEqual(rec, { turns: 2, agent: 'claude', at: 6000, since: 4000, context: 44000, window: 200000, cost: 0.08 });
  // A run that reported nothing (an error) keeps the last known size and still counts.
  rec = P.noteUsage(state, 'chat:a', { usage: null, agent: 'claude', now: 7000 });
  assert.deepEqual(rec, { turns: 3, agent: 'claude', at: 7000, since: 4000, context: 44000, window: 200000, cost: 0.08 });
  // A model without a rate: the tokens stay, the cost is not guessed, for the rest of the session.
  rec = P.noteUsage(state, 'chat:a', { usage: { context: 50000, costUnknown: ['claude-new-9'] }, agent: 'claude', now: 7500 });
  assert.equal(rec.costUnknown, true);
  assert.deepEqual(P.usageFields(rec), { ctx: 50000, turns: 4, window: 200000, since: 4 });
  rec = P.noteUsage(state, 'chat:a', { usage: { context: 51000, cost: 0.01 }, agent: 'claude', now: 7600 });
  assert.equal(rec.costUnknown, true, 'stays unknown: the total would be wrong');
  // A new session starts over, clock included; an agent that never reports has turns and a clock only.
  rec = P.noteUsage(state, 'chat:a', { fresh: true, agent: 'codex', startedAt: 8000, now: 8500 });
  assert.deepEqual(rec, { turns: 1, agent: 'codex', at: 8500, since: 8000 });
  rec = P.noteUsage(state, 'chat:a', { agent: 'codex', now: 9000 });
  assert.deepEqual(rec, { turns: 2, agent: 'codex', at: 9000, since: 8000 });
  assert.deepEqual(Object.keys(state.sessionUsage), ['chat:a']);
  // The record fields: only what is known; since in seconds, cost to 4 places.
  assert.deepEqual(P.usageFields({ turns: 2, agent: 'codex' }), { turns: 2 });
  assert.deepEqual(P.usageFields({ turns: 8, context: 106863, window: 200000, since: 1700000000123, cost: 2.4123456 }), { ctx: 106863, turns: 8, window: 200000, since: 1700000000, cost: 2.4123 });
  assert.deepEqual(P.usageFields(undefined), {});
  // Human-readable sizes, as Claude Code's status line writes them.
  assert.deepEqual([0, 850, 1000, 9540, 9960, 10400, 106863, 312458, 1000000].map(P.tokensLabel), ['0', '850', '1.0k', '9.5k', '10.0k', '10.4k', '106.9k', '312.5k', '1.0M']);
  // The slot file: ctx / turns / window on a record that has them, nothing on one that does not.
  const lua = P.luaTable('ClaudeWoW_SlotData', [
    { chat: 'a', id: 1, status: 'done', text: 'hi', ctx: 106863, turns: 8, window: 200000, since: 1700000000, cost: 2.41 },
    { chat: 'b', id: 2, status: 'done', text: 'hi', turns: 2 },
    { chat: 'c', id: 3, status: 'working', text: 'thinking' },
  ], { restore: { token: 't', chats: [{ id: 'a', name: 'A', cwd: '', plugin: 'ask', ctx: 106863, turns: 8, since: 1700000000, cost: 0, messages: [] }, { id: 'b', name: 'B', cwd: '', messages: [] }] } });
  assert.ok(lua.includes('\t\t\tctx = 106863,\n\t\t\tturns = 8,\n\t\t\twindow = 200000,\n\t\t\tsince = 1700000000,\n\t\t\tcost = 2.41,'), lua);
  assert.equal((lua.match(/^\t\t\tcost = /gm) || []).length, 1);
  assert.equal((lua.match(/^\t\t\tctx = /gm) || []).length, 1);
  assert.equal((lua.match(/^\t\t\tturns = /gm) || []).length, 2);
  assert.ok(lua.includes('\t\t\t\tctx = 106863,\n\t\t\t\tturns = 8,\n\t\t\t\tsince = 1700000000,\n\t\t\t\tcost = 0,\n\t\t\t\tmessages = {'), 'the restore bundle carries it per chat, a zero cost included');
  assert.equal((lua.match(/^\t\t\t\tctx = /gm) || []).length, 1);
});

test('the title flag and a generated title cross the protocol', () => {
  assert.equal(P.parseFlags('plugin=ask;t').title, true);
  assert.equal(P.parseFlags('plugin=ask').title, undefined);
  assert.match(P.luaTable('X', [{ chat: 'c', id: 1, status: 'done', text: 'x', title: 'Hunter Pet "Pathing"' }]), /title = "Hunter Pet \\"Pathing\\"",/);
  assert.ok(!/title =/.test(P.luaTable('X', [{ chat: 'c', id: 1, status: 'done', text: 'x' }])));
});

test('titles: the model is configurable, and its answer is cut to one clean line', () => {
  const T = require('../bridge/titles');
  assert.equal(T.titleModel({}), 'claude-haiku-4-5');
  assert.equal(T.titleModel({ titleModel: 'claude-sonnet-5-5' }), 'claude-sonnet-5-5');
  assert.equal(T.titleModel({ titleModel: false }), '');
  assert.equal(T.cleanTitle('"Hunter Pet Pathing."\nextra'), 'Hunter Pet Pathing');
  assert.equal(T.cleanTitle('Title: **Fishing Spots**'), 'Fishing Spots');
  assert.ok(T.cleanTitle('A very long title that keeps going well past the limit for sure').length <= T.TITLE_MAX);
  const args = T.titleArgs('claude-haiku-4-5', 'hi');
  assert.deepEqual(args.slice(0, 3), ['-p', '--model', 'claude-haiku-4-5']);
  assert.equal(args[args.length - 1], 'hi');
  assert.ok(args.includes('--no-session-persistence'));
});

test('titles: generateTitle runs the command and cleans its output, and gives up on failure', async () => {
  const T = require('../bridge/titles');
  const ok = await T.generateTitle({ file: process.execPath, args: ['-e', 'console.log("  Pet Pathing!  ")', '--'], model: 'm', text: 't' });
  assert.equal(ok, 'Pet Pathing');
  const bad = await T.generateTitle({ file: process.execPath, args: ['-e', 'process.exit(2)', '--'], model: 'm', text: 't' });
  assert.equal(bad, '');
});
