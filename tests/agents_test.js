// Unit tests for bridge/agents.js: how each agent is launched (arguments, prompt
// delivery, permissions) and how its output stream is read back into progress
// lines, a session id and a reply. The sample streams are the formats the CLIs
// document: Claude Code's stream-json, Codex's `exec --json` JSONL, Grok's
// `--output-format streaming-json`.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('../bridge/agents');

const SYS = 'The user is talking to you from inside World of Warcraft';

test('agent ids, display names and the legacy Claude config keys', () => {
  assert.deepEqual(A.agentIds(), ['claude', 'codex', 'grok', 'agy', 'hermes']);
  assert.equal(A.normalizeAgent(' Codex '), 'codex');
  assert.equal(A.normalizeAgent('gemini'), null);
  assert.equal(A.normalizeAgent(''), null);
  assert.equal(A.displayName('grok'), 'Grok');
  assert.equal(A.displayName(''), 'AI');
  // Claude's settings from before "agents" existed still count, under anything in agents.claude.
  const legacy = { claudePath: 'C:\\c.exe', model: 'opus', permissionMode: 'default', allowedTools: ['WebSearch'] };
  assert.deepEqual(A.agentConfig(legacy, 'claude'), { path: 'C:\\c.exe', model: 'opus', permissionMode: 'default', allowedTools: ['WebSearch'] });
  assert.deepEqual(A.agentConfig({ ...legacy, agents: { claude: { model: 'sonnet' } } }, 'claude').model, 'sonnet');
  assert.deepEqual(A.agentConfig(legacy, 'codex'), {});
  assert.deepEqual(A.agentConfig({ agents: { grok: { model: 'grok-build' } } }, 'grok'), { model: 'grok-build' });
});

test('Claude Code: headless stream-json with the allowlist, resume and system prompt; prompt on stdin', () => {
  const cfg = { permissionMode: 'acceptEdits', allowedTools: ['WebSearch', 'Bash(git:*)'], model: 'opus' };
  const args = A.AGENTS.claude.args({ cfg, resume: 'sess-1', system: SYS, cwd: 'C:\\p' });
  assert.deepEqual(args, ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits',
    '--allowedTools', 'WebSearch', 'Bash(git:*)', '--model', 'opus', '--resume', 'sess-1', '--append-system-prompt', SYS]);
  const bare = A.AGENTS.claude.args({ cfg: {}, resume: '', system: '', cwd: 'C:\\p' });
  assert.deepEqual(bare, ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits']);
  assert.deepEqual(A.AGENTS.claude.input({ prompt: 'hi', system: SYS, systemShort: 'x', resume: '' }), { stdin: 'hi' });
  const env = A.AGENTS.claude.env({ CLAUDECODE: '1', PATH: 'x' });
  assert.equal(env.CLAUDECODE, undefined);
  assert.equal(env.PATH, 'x');
});

test('Claude Code with an image (vision): a stream-json user message with the picture as a content block', () => {
  const image = { file: '/b/tmp/vision-7-x.png', data: 'aGVsbG8=', mediaType: 'image/png', width: 1280, height: 712 };
  // Without images nothing changes: no --input-format, plain text on stdin.
  assert.deepEqual(A.AGENTS.claude.args({ cfg: {}, resume: '', system: '', cwd: 'x', images: [] }),
    ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits']);
  assert.deepEqual(A.AGENTS.claude.input({ prompt: 'hi', images: [] }), { stdin: 'hi' });
  assert.deepEqual(A.AGENTS.claude.input({ prompt: 'hi' }), { stdin: 'hi' });
  // With one: the prompt goes in as one JSON line the CLI reads with --input-format stream-json.
  const args = A.AGENTS.claude.args({ cfg: {}, resume: 's', system: 'SYS', cwd: 'x', images: [image] });
  assert.deepEqual(args, ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits',
    '--input-format', 'stream-json', '--resume', 's', '--append-system-prompt', 'SYS']);
  const { stdin } = A.AGENTS.claude.input({ prompt: 'what is this?', images: [image] });
  assert.ok(stdin.endsWith('\n'), 'one line, newline-terminated');
  const msg = JSON.parse(stdin);
  assert.equal(msg.type, 'user');
  assert.equal(msg.message.role, 'user');
  assert.deepEqual(msg.message.content[0], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } });
  assert.deepEqual(msg.message.content[1], { type: 'text', text: A.IMAGE_CAPTION + '\n\nwhat is this?' });
  assert.equal(msg.message.content.length, 2);
  // A path-only image (no pixels loaded) is not inlined: it is named in the prompt like the other CLIs do.
  assert.deepEqual(A.AGENTS.claude.input({ prompt: 'hi', images: ['/a.png'] }), { stdin: 'hi\n\nAttached screenshots: /a.png — read them with your Read tool.' });
  assert.ok(!A.AGENTS.claude.args({ cfg: {}, resume: '', system: '', cwd: 'x', images: ['/a.png'] }).includes('--input-format'));
  // The other agents take the file path out of the same image objects.
  assert.deepEqual(A.imagePaths([image, '/b.png', null]), ['/b/tmp/vision-7-x.png', '/b.png']);
  assert.deepEqual(A.AGENTS.codex.args({ cfg: {}, resume: '', cwd: 'x', images: [image] }).slice(-3), ['-i', '/b/tmp/vision-7-x.png', '-']);
  assert.ok(A.AGENTS.codex.input({ prompt: 'p', system: '', systemShort: '', resume: '', images: [image] }).stdin.includes('Attached screenshots: /b/tmp/vision-7-x.png'));
  assert.ok(A.AGENTS.hermes.args({ cfg: {}, cwd: '.', resume: '', images: [image] }).includes('/b/tmp/vision-7-x.png'));
  assert.ok(A.AGENTS.grok.input({ prompt: 'p', images: [image] }).promptFile.includes('/b/tmp/vision-7-x.png'));
});

test('Codex: exec --json in the chat folder, sandbox from permissionMode, resume as a subcommand, prompt on stdin with the context on top', () => {
  const args = A.AGENTS.codex.args({ cfg: { permissionMode: 'acceptEdits', model: 'gpt-5-codex' }, resume: '', cwd: 'C:\\p' });
  assert.deepEqual(args, ['exec', '--json', '--skip-git-repo-check', '-C', 'C:\\p', '--sandbox', 'workspace-write', '-m', 'gpt-5-codex', '-']);
  assert.deepEqual(A.AGENTS.codex.args({ cfg: {}, resume: 'thread-9', cwd: 'C:\\p' }),
    ['exec', '--json', '--skip-git-repo-check', '-C', 'C:\\p', '--sandbox', 'workspace-write', 'resume', 'thread-9', '-']);
  assert.ok(A.AGENTS.codex.args({ cfg: { permissionMode: 'default' }, resume: '', cwd: 'x' }).includes('read-only'));
  const yolo = A.AGENTS.codex.args({ cfg: { permissionMode: 'bypassPermissions' }, resume: '', cwd: 'x' });
  assert.ok(yolo.includes('--dangerously-bypass-approvals-and-sandbox') && !yolo.includes('--sandbox'));
  // Network inside the sandbox is a config override, which must come before `exec`.
  const net = A.AGENTS.codex.args({ cfg: { networkAccess: true }, resume: '', cwd: 'x' });
  assert.deepEqual(net.slice(0, 3), ['-c', 'sandbox_workspace_write.network_access=true', 'exec']);
  // Extra arguments stay before the subcommand and the stdin marker.
  const extra = A.AGENTS.codex.args({ cfg: { extraArgs: ['--profile', 'fast'] }, resume: 't', cwd: 'x' });
  assert.deepEqual(extra.slice(-5), ['--profile', 'fast', 'resume', 't', '-']);
  // No system-prompt flag: the context rides at the top of the prompt, in full
  // for a new session and as the short version on a resumed one.
  const fresh = A.AGENTS.codex.input({ prompt: 'fix it', system: 'FULL', systemShort: 'SHORT', resume: '' });
  assert.equal(fresh.stdin, A.contextBlock('FULL') + 'fix it');
  assert.ok(fresh.stdin.startsWith('[Context from the Claude WoW bridge'));
  assert.equal(A.AGENTS.codex.input({ prompt: 'fix it', system: 'FULL', systemShort: 'SHORT', resume: 't' }).stdin, A.contextBlock('SHORT') + 'fix it');
  assert.equal(A.AGENTS.codex.input({ prompt: 'fix it', system: '', systemShort: '', resume: '' }).stdin, 'fix it');
  assert.deepEqual(A.AGENTS.codex.args({ cfg: {}, resume: '', cwd: 'x', images: ['a.png', 'b.png'] }).slice(-5), ['-i', 'a.png', '-i', 'b.png', '-']);
});

test('Antigravity arguments and captured stream parser', () => {
  const input = { cfg: {}, resume: '', cwd: 'C:\\work', prompt: 'PONG', system: SYS, systemShort: 'short' };
  const accept = A.AGENTS.agy.args({ ...input, cfg: { permissionMode: 'acceptEdits' } });
  assert.equal(accept[0], `-p=${A.contextBlock(SYS)}PONG`);
  assert.ok(accept.includes('--add-dir') && accept.includes('C:\\work'));
  assert.ok(accept.includes('--mode') && accept.includes('accept-edits') && accept.includes('--disable-slash-commands'));
  const readOnly = A.AGENTS.agy.args({ ...input, cfg: { permissionMode: 'default' } });
  assert.ok(readOnly.includes('plan') && !readOnly.includes('--disable-slash-commands'));
  const bypass = A.AGENTS.agy.args({ ...input, cfg: { permissionMode: 'bypassPermissions' } });
  assert.ok(bypass.includes('--dangerously-skip-permissions'));
  const resume = A.AGENTS.agy.args({ ...input, resume: 'conv-1', systemShort: 'short' });
  assert.ok(resume.includes('--conversation') && resume.includes('conv-1'));
  const events = fs.readFileSync(path.join(__dirname, 'fixtures/agents/agy-tools.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  const p = A.agyParser();
  let last;
  for (const ev of events) last = p.feed(ev);
  assert.equal(last.session, '6d560884-a06c-4b29-a675-4d3201dea093');
  assert.equal(last.done.text.includes('HELLO'), true);
  const pong = A.agyParser();
  const lines = fs.readFileSync(path.join(__dirname, 'fixtures/agents/agy-pong.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  const parsed = lines.map(ev => pong.feed(ev));
  assert.equal(parsed[0].session, 'ad79f5cc-2c0a-445c-a918-a0fbd7929859');
  assert.equal(parsed.find(row => row.done).done.text.trim(), 'PONG');
  assert.deepEqual(parsed[1].progress, []);
  const resumed = fs.readFileSync(path.join(__dirname, 'fixtures/agents/agy-resume.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  const rp = A.agyParser();
  const results = resumed.map(ev => rp.feed(ev));
  assert.equal(results[0].session, '6d560884-a06c-4b29-a675-4d3201dea093');
  assert.equal(results[results.length - 1].done.text.trim(), 'HELLO');
});

test('Hermes command modes, image forwarding and plain text completion', () => {
  const args = A.AGENTS.hermes.args({ cfg: { permissionMode: 'acceptEdits', model: 'm' }, cwd: 'C:\\work', resume: 's1', images: ['a.png'] });
  assert.deepEqual(args, ['chat', '--query-file', '-', '-Q', '--in', 'C:\\work', '--source', 'tool', '--resume', 's1', '-m', 'm', '--image', 'a.png']);
  for (const permissionMode of ['default', 'acceptEdits', 'bypassPermissions']) {
    assert.ok(!A.AGENTS.hermes.args({ cfg: { permissionMode }, cwd: '.', resume: '' }).includes('--yolo'));
  }
  const p = A.hermesParser();
  assert.deepEqual(p.finish({ stdout: fs.readFileSync(path.join(__dirname, 'fixtures/agents/hermes-pong.stdout'), 'utf8'),
    stderr: fs.readFileSync(path.join(__dirname, 'fixtures/agents/hermes-pong.stderr'), 'utf8'), code: 0 }),
  { session: '20260925_134414_e62607', done: { text: 'PONG', error: false } });
});

test('agy review fixes: hermes stderr errors, yolo spellings, flag-like images, agy arg bound', () => {
  const p = A.hermesParser();
  assert.deepEqual(p.finish({ stdout: '', stderr: '\x1b[2mSession_ID: abc\x1b[0m\nError: model not found\n', code: 1 }),
    { session: 'abc', done: { text: 'Error: model not found', error: true } });
  const extra = ['--yolo', '-y', '--yolo=1', '--max-turns', '3'];
  const args = A.AGENTS.hermes.args({ cfg: { extraArgs: extra }, cwd: '.', resume: '', images: ['--yolo'] });
  assert.deepEqual(args.slice(-2), ['--max-turns', '3']);
  assert.ok(!args.some(x => /yolo|^-y$/.test(x)) && !args.includes('--image'));
  assert.ok(!A.AGENTS.codex.args({ cfg: {}, resume: '', cwd: 'x', images: ['-bad'] }).includes('-bad'));
  const agy = A.AGENTS.agy.args({ cfg: {}, cwd: '.', resume: '', prompt: 'p'.repeat(30000), system: 's'.repeat(40000) });
  assert.ok(agy[0].length <= 24100, `agy -p argument is ${agy[0].length} chars`);
});

test('Grok: streaming-json from a prompt file, dontAsk plus translated allow rules, resume and the system prompt', () => {
  const cfg = { permissionMode: 'acceptEdits', allowedTools: ['WebSearch', 'Bash(git:*)', 'Bash'], model: 'grok-build' };
  const args = A.AGENTS.grok.args({ cfg, resume: 's-1', cwd: 'C:\\p', system: SYS, promptFile: 'C:\\b\\tmp\\prompt-001.txt' });
  assert.deepEqual(args, ['--no-auto-update', '--output-format', 'streaming-json', '--cwd', 'C:\\p', '--prompt-file', 'C:\\b\\tmp\\prompt-001.txt',
    '--permission-mode', 'dontAsk', '--allow', 'Edit', '--allow', 'Read', '--allow', 'Grep', '--allow', 'WebSearch',
    '--allow', 'Bash(git *)', '--allow', 'Bash(git)', '--allow', 'Bash',
    '-m', 'grok-build', '-r', 's-1', '--append-system-prompt', SYS]);
  const strict = A.AGENTS.grok.args({ cfg: { permissionMode: 'default', allowedTools: ['WebFetch'] }, resume: '', cwd: 'x', system: '', promptFile: 'f' });
  assert.ok(!strict.includes('Edit') && strict.includes('WebFetch') && strict.includes('dontAsk'));
  const yolo = A.AGENTS.grok.args({ cfg: { permissionMode: 'bypassPermissions', allowedTools: ['WebFetch'], deniedTools: ['Bash(rm:*)'] }, resume: '', cwd: 'x', system: '', promptFile: 'f' });
  assert.ok(yolo.includes('--always-approve') && !yolo.includes('--allow') && !yolo.includes('dontAsk'));
  assert.deepEqual(yolo.slice(yolo.indexOf('--deny')), ['--deny', 'Bash(rm *)', '--deny', 'Bash(rm)']);
  const claudeDeny = A.AGENTS.claude.args({ cfg: { deniedTools: ['Bash(rm:*)', 'WebFetch'] }, resume: '', system: '', cwd: 'x' });
  assert.deepEqual(claudeDeny.slice(-3), ['--disallowedTools', 'Bash(rm:*)', 'WebFetch']);
  assert.deepEqual(A.AGENTS.grok.input({ prompt: 'hello', system: SYS }), { promptFile: 'hello' });
  assert.equal(A.AGENTS.grok.env({}).GROK_DISABLE_AUTOUPDATER, '1');
  assert.deepEqual(A.grokRules('Bash(cargo:*)'), ['Bash(cargo *)', 'Bash(cargo)']);
  assert.deepEqual(A.grokRules('Bash(npm test)'), ['Bash(npm test)']);
  assert.deepEqual(A.grokRules('WebSearch'), ['WebSearch']);
  assert.deepEqual(A.grokRules(''), []);
});

test('Claude stream: tool calls and text become progress, the result carries the reply and any denials', () => {
  const p = A.claudeParser();
  let r = p.feed({ type: 'system', subtype: 'init', session_id: 'sess-1' });
  assert.equal(r.session, 'sess-1');
  r = p.feed({ type: 'assistant', session_id: 'sess-1', message: { content: [{ type: 'text', text: 'Let me look.' }, { type: 'tool_use', name: 'Edit', input: { file_path: 'player.gd' } }] } });
  assert.deepEqual(r.progress, ['Let me look.', 'edit player.gd']);
  assert.equal(r.done, undefined);
  r = p.feed({ type: 'result', session_id: 'sess-1', is_error: false, result: 'Done.', permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'cargo build' } }, { tool_name: 'WebSearch' }] });
  assert.deepEqual(r.done, { text: 'Done.', error: false });
  assert.deepEqual(r.denied, ['Bash(cargo:*)', 'WebSearch']);
  assert.ok(r.notes[0].includes('2 action(s)') && r.notes[0].includes('Bash: cargo build'));
  const err = A.claudeParser().feed({ type: 'result', is_error: true, result: 'boom' });
  assert.deepEqual(err.done, { text: 'boom', error: true });
});

test('Codex stream: thread id, one line per item, the last agent message is the reply, declined commands are noted', () => {
  const p = A.codexParser();
  const feed = ev => p.feed(ev);
  assert.equal(feed({ type: 'thread.started', thread_id: 'thr-1' }).session, 'thr-1');
  assert.deepEqual(feed({ type: 'turn.started' }).progress, []);
  assert.deepEqual(feed({ type: 'item.completed', item: { id: 'i0', type: 'reasoning', text: 'Looking at the tests first' } }).progress, ['~ Looking at the tests first']);
  assert.deepEqual(feed({ type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'npm test\nsecond', status: 'in_progress' } }).progress, ['$ npm test']);
  // The shell wrapper Codex runs commands through is stripped (real line from codex 0.156).
  assert.equal(A.codexItemLine({ type: 'command_execution', command: "/bin/zsh -lc 'ls -la'" }), '$ ls -la');
  assert.equal(A.codexItemLine({ type: 'command_execution', command: 'C:\\Windows\\System32\\cmd.exe /c "dir /b"' }), '$ dir /b');
  assert.equal(A.shellInner('bash -c "echo hi"'), 'echo hi');
  assert.equal(A.shellInner('npm test'), 'npm test');
  // Completing an item that was announced when it started adds nothing.
  assert.deepEqual(feed({ type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'npm test', status: 'completed', exit_code: 0 } }).progress, []);
  assert.deepEqual(feed({ type: 'item.completed', item: { id: 'i2', type: 'file_change', status: 'completed', changes: [{ path: 'C:/x/a.js', kind: 'update' }, { path: 'C:/x/b.js', kind: 'update' }] } }).progress, ['edit a.js, b.js']);
  assert.deepEqual(feed({ type: 'item.completed', item: { id: 'i3', type: 'file_change', status: 'completed', changes: [{ path: 'new.md', kind: 'add' }] } }).progress, ['write new.md']);
  assert.deepEqual(feed({ type: 'item.started', item: { id: 'i4', type: 'web_search', query: 'lua 5.1 gsub' } }).progress, ['search: lua 5.1 gsub']);
  assert.deepEqual(feed({ type: 'item.started', item: { id: 'i5', type: 'mcp_tool_call', server: 'fs', tool: 'list', status: 'in_progress' } }).progress, ['tool: fs.list']);
  const declined = feed({ type: 'item.completed', item: { id: 'i6', type: 'command_execution', command: 'git push', status: 'declined' } });
  assert.deepEqual(declined.progress, ['$ git push']);
  assert.ok(declined.notes[0].startsWith('Codex was not allowed to run: git push'));
  assert.deepEqual(feed({ type: 'item.completed', item: { id: 'i7', type: 'agent_message', text: 'First draft of the answer.' } }).progress, ['First draft of the answer.']);
  assert.deepEqual(feed({ type: 'item.completed', item: { id: 'i8', type: 'agent_message', text: 'All done: tests pass.' } }).progress, ['All done: tests pass.']);
  assert.deepEqual(feed({ type: 'item.completed', item: { id: 'i9', type: 'error', message: 'rate limited once' } }).notes, ['rate limited once']);
  const end = feed({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } });
  assert.deepEqual(end.done, { text: 'All done: tests pass.', error: false });
  // A failed turn is an error with its message; a stream error too.
  assert.deepEqual(A.codexParser().feed({ type: 'turn.failed', error: { message: 'context window exceeded' } }).done, { text: 'context window exceeded', error: true });
  assert.deepEqual(A.codexParser().feed({ type: 'error', message: 'auth' }).done, { text: 'auth', error: true });
  // A turn with no agent message yields an empty reply (the bridge fills in a note).
  assert.deepEqual(A.codexParser().feed({ type: 'turn.completed', usage: {} }).done, { text: '', error: false });
});

test('Grok stream: chunks join into the reply, thoughts and tool calls become progress, end carries the session id', () => {
  // The documented example stream, as printed by Grok Build 1.0.
  const lines = [
    '{"type":"thought","data":"Analyzing the directory structure..."}',
    '{"type":"tool_call","toolCallId":"call_1","title":"Read","kind":"read","status":"in_progress","toolName":"read_file","rawInput":{"path":"src/main.rs"},"content":[],"locations":[]}',
    '{"type":"tool_call_update","toolCallId":"call_1","status":"completed","content":[],"rawOutput":{"lines":42},"locations":[]}',
    '{"type":"text","data":"Here\'s a "}',
    '{"type":"text","data":"summary"}',
    '{"type":"usage","messageId":"resp_1","stopReason":"end_turn","usage":{"input_tokens":812,"output_tokens":45}}',
    '{"type":"end","stopReason":"end_turn","sessionId":"abc123","requestId":"xyz789","usage":{"input_tokens":812,"output_tokens":45},"num_turns":1}',
  ];
  const p = A.grokParser();
  const all = lines.map(l => p.feed(JSON.parse(l)));
  assert.deepEqual(all[0].progress, []); // thoughts are buffered until something else happens
  assert.deepEqual(all[1].progress, ['~ Analyzing the directory structure...', 'read main.rs']);
  assert.deepEqual(all[2].progress, []);
  assert.deepEqual(all[3].progress, []);
  assert.equal(all[6].session, 'abc123');
  assert.deepEqual(all[6].done, { text: "Here's a summary", error: false });
  assert.deepEqual(all[6].notes, []);
  // Narration before a tool call is progress; the text after the last tool call is the reply.
  const q = A.grokParser();
  q.feed({ type: 'text', data: 'Let me run the tests.' });
  const call = q.feed({ type: 'tool_call', toolCallId: 't1', kind: 'execute', toolName: 'bash', status: 'in_progress', rawInput: { command: 'npm test' } });
  assert.deepEqual(call.progress, ['Let me run the tests.', '$ npm test']);
  q.feed({ type: 'text', data: 'All green.' });
  assert.deepEqual(q.feed({ type: 'end', stopReason: 'end_turn', sessionId: 's2' }).done, { text: 'All green.', error: false });
  // A turn that ends on a tool call keeps the last text it had; a cut-off stop reason is noted.
  const r = A.grokParser();
  r.feed({ type: 'text', data: 'Partial' });
  r.feed({ type: 'tool_call', toolCallId: 't2', kind: 'edit', toolName: 'edit_file', rawInput: { path: 'a/b.lua' } });
  const cut = r.feed({ type: 'end', stopReason: 'max_tokens', sessionId: 's3' });
  assert.deepEqual(cut.done, { text: 'Partial', error: false });
  assert.deepEqual(cut.notes, ['Grok stopped early: max_tokens']);
  // A refused tool call becomes an allow rule for the button.
  const d = A.grokParser();
  d.feed({ type: 'tool_call', toolCallId: 't3', kind: 'execute', toolName: 'bash', rawInput: { command: 'cargo build --release' } });
  const denied = d.feed({ type: 'tool_call_update', toolCallId: 't3', status: 'denied' });
  assert.deepEqual(denied.denied, ['Bash(cargo:*)']);
  assert.ok(denied.notes[0].includes('$ cargo build --release'));
  assert.deepEqual(d.feed({ type: 'tool_call_update', toolCallId: 't3', status: 'in_progress' }).denied, []);
  // Errors end the run.
  assert.deepEqual(A.grokParser().feed({ type: 'error', message: 'not logged in' }).done, { text: 'not logged in', error: true });
  assert.deepEqual(A.grokParser().feed({ type: 'error' }).done, { text: 'Grok reported an error', error: true });
  // Tool lines for the other kinds.
  assert.equal(A.grokCall({ toolName: 'web_search', rawInput: { query: 'wow api' } }).line, 'search: wow api');
  assert.equal(A.grokCall({ toolName: 'web_fetch', rawInput: { url: 'https://x' } }).rule, 'WebFetch');
  assert.equal(A.grokCall({ toolName: 'grep', rawInput: { pattern: 'foo' } }).line, 'grep foo');
  assert.deepEqual(A.grokCall({ title: 'Mystery tool' }), { line: 'Mystery tool', rule: null });
});

test('Grok stream as Grok Build 1.0.41 prints it: tool inputs, a classifier refusal, a deny-rule refusal, an ordinary failure', () => {
  const p = A.grokParser();
  // Lines captured from real runs (paths shortened).
  assert.deepEqual(p.feed({ type: 'tool_call', toolCallId: 'c1', title: 'read_file', kind: 'read', status: 'pending', toolName: 'read_file', rawInput: { target_file: '/x/gproj/hello.txt' }, content: [], locations: [] }).progress, ['read hello.txt']);
  assert.deepEqual(p.feed({ type: 'tool_call', toolCallId: 'c2', title: 'write', kind: 'write', status: 'pending', toolName: 'write', rawInput: { file_path: '/x/gproj/note.txt', content: 'hi' } }).progress, ['edit note.txt']);
  assert.deepEqual(p.feed({ type: 'tool_call', toolCallId: 'c3', title: 'grep', kind: 'search', status: 'pending', toolName: 'grep', rawInput: { pattern: 'PONG', path: 'hello.txt' } }).progress, ['grep PONG']);
  assert.deepEqual(p.feed({ type: 'tool_call', toolCallId: 'c4', title: 'list_dir', kind: 'read', toolName: 'list_dir', rawInput: { target_directory: '/x/gproj/src' } }).progress, ['ls src']);
  assert.deepEqual(p.feed({ type: 'tool_call', toolCallId: 'c5', title: 'run_terminal_command', kind: 'execute', status: 'pending', toolName: 'run_terminal_command', rawInput: { command: 'rm victim.txt', description: 'Remove victim.txt' } }).progress, ['$ rm victim.txt']);
  // Progress updates carry no verdict.
  assert.deepEqual(p.feed({ type: 'tool_call_update', toolCallId: 'c5', status: null, content: [{ type: 'content', content: { type: 'text', text: 'Remove victim.txt' } }], rawOutput: null }).denied, []);
  // The classifier refusal: status failed plus a "was not executed" line.
  const blocked = p.feed({ type: 'tool_call_update', toolCallId: 'c5', status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'Tool `run_terminal_command` was not executed: Auto mode blocked this action (rm of a named non-scratch file is irreversible deletion and must wait). Take a safer approach that stays within what the user asked for; do not retry this exact action.' } }], rawOutput: null });
  assert.deepEqual(blocked.denied, ['Bash(rm:*)']);
  assert.ok(blocked.notes[0].startsWith('Grok was not allowed to: $ rm victim.txt\nAuto mode blocked this action'), blocked.notes[0]);
  assert.ok(blocked.notes[0].endsWith('Use the Allow button below to permit it and let it continue.'));
  // A deny rule.
  p.feed({ type: 'tool_call', toolCallId: 'c6', title: 'run_terminal_command', kind: 'execute', toolName: 'run_terminal_command', rawInput: { command: 'touch probe-deny.txt' } });
  const denied = p.feed({ type: 'tool_call_update', toolCallId: 'c6', status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'Tool `run_terminal_command` was not executed: Denied by permission policy: deny rule on bash matching "touch *"' } }] });
  assert.deepEqual(denied.denied, ['Bash(touch:*)']);
  assert.ok(denied.notes[0].includes('Denied by permission policy'));
  // A command that merely failed is not a refusal.
  p.feed({ type: 'tool_call', toolCallId: 'c7', kind: 'execute', toolName: 'run_terminal_command', rawInput: { command: 'npm test' } });
  assert.deepEqual(p.feed({ type: 'tool_call_update', toolCallId: 'c7', status: 'failed', content: [{ type: 'content', content: { type: 'text', text: '3 tests failed' } }], rawOutput: { type: 'Bash', exit_code: 1 } }).denied, []);
  // A completed run of the same command, with output, is not one either.
  assert.deepEqual(p.feed({ type: 'tool_call_update', toolCallId: 'c7', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'total 8' } }], rawOutput: { type: 'Bash', exit_code: 0 } }).denied, []);
  assert.equal(A.grokRefusal({ status: 'completed', content: [] }), null);
  // The rest of the toolbox.
  assert.equal(A.grokCall({ toolName: 'todo_write', kind: 'think' }).line, 'todo list');
  assert.equal(A.grokCall({ toolName: 'spawn_subagent', rawInput: { description: 'Explore the repo' } }).line, 'agent: Explore the repo');
  assert.equal(A.grokCall({ toolName: 'get_command_or_subagent_output', rawInput: {} }).line, 'get_command_or_subagent_output');
  assert.equal(A.grokCall({ toolName: 'web_fetch', kind: 'fetch', rawInput: { url: 'https://x' } }).line, 'fetch https://x');
  // Real transcript: chunks before a tool call are progress, the text after the last call is the reply.
  const q = A.grokParser();
  for (const w of ['The', ' user', ' wants', ' me', ' to', ' read', ' hello', '.txt']) q.feed({ type: 'thought', data: w });
  let r = q.feed({ type: 'text', data: "I'll" });
  assert.deepEqual(r.progress, ['~ The user wants me to read hello.txt']);
  for (const w of [' read', ' `hello.txt`', ' and reply.']) q.feed({ type: 'text', data: w });
  r = q.feed({ type: 'tool_call', toolCallId: 'r1', title: 'read_file', kind: 'read', toolName: 'read_file', rawInput: { target_file: '/x/hello.txt' } });
  assert.deepEqual(r.progress, ["I'll read `hello.txt` and reply.", 'read hello.txt']);
  q.feed({ type: 'tool_call_update', toolCallId: 'r1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: '1→PONG\n' } }], rawOutput: { type: 'ReadFile' } });
  q.feed({ type: 'thought', data: 'The file contains PONG.' });
  q.feed({ type: 'text', data: 'P' });
  r = q.feed({ type: 'text', data: 'ONG' });
  q.feed({ type: 'available_commands', tools: ['read_file'] });
  q.feed({ type: 'usage', usage: { input_tokens: 1 } });
  r = q.feed({ type: 'end', stopReason: 'end_turn', sessionId: '01a0d44b-bf06-79f1-b280-17e35a365e7c', usage: {}, num_turns: 2 });
  assert.equal(r.session, '01a0d44b-bf06-79f1-b280-17e35a365e7c');
  assert.deepEqual(r.done, { text: 'PONG', error: false });
});

test('resolveCommand: a configured script runs with this node, an npm .cmd shim is unwrapped, a native binary next to it wins', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wow-ai-agents-'));
  try {
    const script = path.join(tmp, 'cli.js');
    fs.writeFileSync(script, '');
    assert.deepEqual(A.resolveCommand('claude', { path: script }), { file: process.execPath, args: [script], found: true });
    assert.equal(A.resolveCommand('claude', { path: path.join(tmp, 'missing.exe') }).found, false);
    // npm's Windows launcher: "%_prog%" "%dp0%\node_modules\@openai\codex\bin\codex.js" %*
    const bin = path.join(tmp, 'node_modules', '@openai', 'codex', 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'codex.js'), '');
    const shim = path.join(tmp, 'codex.cmd');
    fs.writeFileSync(shim, '@ECHO off\r\nSETLOCAL\r\nCALL :find_dp0\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n');
    assert.deepEqual(A.unwrapShim(shim, A.AGENTS.codex), { file: process.execPath, args: [path.join(bin, 'codex.js')], found: true });
    assert.deepEqual(A.resolveCommand('codex', { path: shim }), { file: process.execPath, args: [path.join(bin, 'codex.js')], found: true });
    // Current npm shims mention "%dp0%\node.exe" before the script.
    const realShim = path.join(tmp, 'codex2.cmd');
    fs.writeFileSync(realShim, 'IF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n)\r\n"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n');
    assert.deepEqual(A.unwrapShim(realShim, A.AGENTS.codex), { file: process.execPath, args: [path.join(bin, 'codex.js')], found: true });
    // Other generators write %~dp0 and .bat launchers.
    const batShim = path.join(tmp, 'codex3.bat');
    fs.writeFileSync(batShim, '@node "%~dp0\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n');
    assert.deepEqual(A.resolveCommand('codex', { path: batShim }), { file: process.execPath, args: [path.join(bin, 'codex.js')], found: true });
    // Claude's npm package launches a .exe: run it directly.
    const claudeExe = path.join(tmp, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    fs.mkdirSync(path.dirname(claudeExe), { recursive: true });
    fs.writeFileSync(claudeExe, '');
    const claudeShim = path.join(tmp, 'claude.cmd');
    fs.writeFileSync(claudeShim, 'IF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n)\r\n"%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" %*\r\n');
    assert.deepEqual(A.unwrapShim(claudeShim, A.AGENTS.claude), { file: claudeExe, args: [], found: true });
    // Grok's launcher has no extension: the native exe next to it when present, else this node runs the script.
    const grokScript = path.join(tmp, 'node_modules', '@xai-official', 'grok', 'bin', 'grok');
    fs.mkdirSync(path.dirname(grokScript), { recursive: true });
    fs.writeFileSync(grokScript, '#!/usr/bin/env node\n');
    const grokShim = path.join(tmp, 'grok.cmd');
    fs.writeFileSync(grokShim, 'IF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n)\r\n"%_prog%"  "%dp0%\\node_modules\\@xai-official\\grok\\bin\\grok" %*\r\n');
    assert.deepEqual(A.unwrapShim(grokShim, A.AGENTS.grok), { file: process.execPath, args: [grokScript], found: true });
    const grokExe = path.join(tmp, 'node_modules', '@xai-official', `grok-win32-${process.arch === 'arm64' ? 'arm64' : 'x64'}`, 'bin', 'grok.exe');
    fs.mkdirSync(path.dirname(grokExe), { recursive: true });
    fs.writeFileSync(grokExe, '');
    assert.deepEqual(A.unwrapShim(grokShim, A.AGENTS.grok), { file: grokExe, args: [], found: true });
    // A shim that only mentions node.exe unwraps to nothing.
    const nodeOnly = path.join(tmp, 'odd.cmd');
    fs.writeFileSync(nodeOnly, '"%dp0%\\node.exe" %*\r\n');
    assert.equal(A.unwrapShim(nodeOnly, A.AGENTS.codex), null);
    const oldPath = process.env.CODEX_BIN;
    try {
      process.env.CODEX_BIN = path.join(tmp, 'codex.exe');
      fs.writeFileSync(process.env.CODEX_BIN, '');
      assert.deepEqual(A.resolveCommand('codex', {}), { file: process.env.CODEX_BIN, args: [], found: true });
      process.env.CODEX_BIN = shim;
      assert.deepEqual(A.resolveCommand('codex', {}), { file: process.execPath, args: [path.join(bin, 'codex.js')], found: true });
    } finally {
      if (oldPath === undefined) delete process.env.CODEX_BIN;
      else process.env.CODEX_BIN = oldPath;
    }
    // With the platform package present, the native exe is spawned directly.
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const triple = process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
    const exe = path.join(tmp, 'node_modules', '@openai', `codex-win32-${arch}`, 'vendor', triple, 'bin', 'codex.exe');
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    fs.writeFileSync(exe, '');
    assert.deepEqual(A.unwrapShim(shim, A.AGENTS.codex), { file: exe, args: [], found: true });
    assert.equal(A.unwrapShim(path.join(tmp, 'nope.cmd'), A.AGENTS.codex), null);
    assert.equal(A.resolveCommand('nothing', {}).found, false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Claude stream: usage on the assistant messages is the context the next turn will carry; the result only adds the window', () => {
  // Shapes as Claude Code 2.1 prints them (`-p --output-format stream-json --verbose`, haiku):
  // turn 1 of a session, one call; turn 2 resumed, a tool step and the answer.
  const usage1 = { input_tokens: 10, cache_creation_input_tokens: 17366, cache_read_input_tokens: 13689, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 17366 }, output_tokens: 1, service_tier: 'standard' };
  const p = A.claudeParser();
  const r1 = p.feed({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'pong' }], usage: usage1 }, session_id: 's1' });
  assert.deepEqual(r1.usage, { context: 31065, output: 1 });
  assert.deepEqual(r1.progress, ['pong']);
  const end1 = p.feed({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: 'pong', session_id: 's1',
    usage: { input_tokens: 10, cache_creation_input_tokens: 17366, cache_read_input_tokens: 13689, output_tokens: 44, cache_creation: { ephemeral_1h_input_tokens: 17366, ephemeral_5m_input_tokens: 0 } },
    modelUsage: { 'claude-haiku-4-5-20251001': { inputTokens: 10, outputTokens: 44, cacheReadInputTokens: 13689, cacheCreationInputTokens: 17366, contextWindow: 200000, maxOutputTokens: 32000 } } });
  // The run's price at list rates is exactly what Claude Code itself reported (total_cost_usd 0.0363309):
  // haiku 4.5 at $1/M input, $5/M output, cache reads at 0.1x, this run's cache writes all 1-hour at 2x.
  assert.deepEqual(end1.usage, { context: 31065, output: 1, window: 200000, cost: 0.0363309, costIsSessionTotal: true });
  assert.deepEqual(end1.done, { text: 'pong', error: false });

  // Turn 2: the first call reads exactly turn 1's total plus the new message; the
  // last call is what turn 3 will carry. The result's usage is the SUM of the two
  // calls (cache_read 62491), which must not be mistaken for the context.
  const q = A.claudeParser();
  const step = q.feed({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }], usage: { input_tokens: 10, cache_read_input_tokens: 31055, cache_creation_input_tokens: 381, output_tokens: 4 } } });
  assert.equal(step.usage.context, 31446);
  q.feed({ type: 'user', message: { content: [{ type: 'tool_result', content: 'a.js' }] } });
  const last = q.feed({ type: 'assistant', message: { content: [{ type: 'text', text: 'pong' }], usage: { input_tokens: 8, cache_read_input_tokens: 31436, cache_creation_input_tokens: 1170, output_tokens: 2 } } });
  assert.equal(last.usage.context, 32614);
  const end2 = q.feed({ type: 'result', subtype: 'success', result: 'pong', num_turns: 2,
    usage: { input_tokens: 18, cache_read_input_tokens: 62491, cache_creation_input_tokens: 1551, output_tokens: 161 },
    modelUsage: { 'claude-haiku-4-5-20251001': { contextWindow: 200000 } } });
  assert.equal(end2.usage.context, 32614, 'the last assistant message, not the summed result');
  assert.equal(end2.usage.window, 200000);
  // A modelUsage entry with no token counts: the top-level usage (the turn's sum) is priced at that model.
  assert.ok(Math.abs(end2.usage.cost - (18 * 1 + 161 * 5 + 62491 * 0.1 + 1551 * 1.25) / 1e6) < 1e-12, String(end2.usage.cost));
  assert.equal(end2.usage.costUnknown, undefined);
  // A turn with no assistant message (an error) falls back to the result's usage; no usage at all reports none.
  const e = A.claudeParser().feed({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom', usage: { input_tokens: 5, cache_read_input_tokens: 100, output_tokens: 0 } });
  assert.deepEqual(e.usage, { context: 105, output: 0, costUnknown: ['no model named'] }, 'tokens, and a price it cannot name');
  assert.equal(A.claudeParser().feed({ type: 'result', result: 'x' }).usage, undefined);
  assert.equal(A.claudeParser().feed({ type: 'assistant', message: { content: [] } }).usage, undefined);
  assert.equal(A.claudeUsage({ input_tokens: 'x' }), null);
  assert.equal(A.claudeUsage(null), null);
  assert.equal(A.claudeWindow({ modelUsage: { a: { contextWindow: 200000 }, b: { contextWindow: 1000000 } } }), 1000000);
  assert.equal(A.claudeWindow({}), 0);
});

test('API-equivalent cost: per-model list rates, cache reads and writes priced apart, unknown models omitted rather than guessed', () => {
  // The real haiku run, priced from modelUsage with the 1h/5m split from usage.cache_creation.
  const real = { usage: { input_tokens: 10, cache_creation_input_tokens: 17366, cache_read_input_tokens: 13689, output_tokens: 44, cache_creation: { ephemeral_1h_input_tokens: 17366, ephemeral_5m_input_tokens: 0 } },
    modelUsage: { 'claude-haiku-4-5-20251001': { inputTokens: 10, outputTokens: 44, cacheReadInputTokens: 13689, cacheCreationInputTokens: 17366, contextWindow: 200000 } } };
  const c = A.claudeCost(real, '');
  assert.deepEqual(c.models, ['claude-haiku-4-5-20251001']);
  assert.deepEqual(c.unknown, []);
  assert.ok(Math.abs(c.usd - 0.0363309) < 1e-9, `${c.usd} = Claude Code's own total_cost_usd`);
  // Cache reads are a tenth of fresh input: the measured session (45.2M of 45.4M input tokens
  // read from cache) would be ~10x overstated at the full input rate.
  const opus = A.claudeCost({ usage: {}, modelUsage: { 'claude-opus-4-6': { inputTokens: 200000, outputTokens: 0, cacheReadInputTokens: 45200000, cacheCreationInputTokens: 0 } } }, '');
  assert.ok(Math.abs(opus.usd - (200000 * 5 + 45200000 * 0.5) / 1e6) < 1e-9, opus.usd);
  // Five-minute cache writes at 1.25x, one-hour at 2x, split by the top-level ratio.
  const writes = A.claudeCost({ usage: { cache_creation: { ephemeral_5m_input_tokens: 750, ephemeral_1h_input_tokens: 250 } }, modelUsage: { 'claude-sonnet-5': { cacheCreationInputTokens: 1000 } } }, '');
  assert.ok(Math.abs(writes.usd - (750 * 2 * 1.25 + 250 * 2 * 2) / 1e6) < 1e-12, writes.usd);
  // Claude Fable 5.1 lists its own cache-read rate.
  const fable = A.claudeCost({ usage: {}, modelUsage: { 'claude-fable-5-1': { cacheReadInputTokens: 1e6 } } }, '');
  assert.ok(Math.abs(fable.usd - 0.25) < 1e-12, fable.usd);
  assert.equal(A.claudeRate('claude-fable-5').cacheRead, undefined, 'Fable 5 reads at the usual tenth');
  // A model without a rate is named, not priced; nothing to price at all is null.
  const mixed = A.claudeCost({ usage: {}, modelUsage: { 'claude-haiku-4-5': { outputTokens: 1e6 }, 'claude-new-9': { outputTokens: 1e6 } } }, '');
  assert.deepEqual(mixed.unknown, ['claude-new-9']);
  assert.ok(Math.abs(mixed.usd - 5) < 1e-12);
  assert.equal(A.claudeCost({ usage: { input_tokens: 5 } }, ''), null);
  assert.equal(A.claudeCost({}, 'claude-opus-5'), null);
  // No modelUsage: the top-level usage at the model the assistant messages named.
  const top = A.claudeCost({ usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 10000, cache_creation_input_tokens: 2000 } }, 'claude-opus-5');
  assert.ok(Math.abs(top.usd - (1000 * 5 + 100 * 25 + 10000 * 0.5 + 2000 * 5 * 1.25) / 1e6) < 1e-12, top.usd);
  assert.deepEqual(A.claudeCost({ usage: { input_tokens: 1 } }, 'claude-new-9').unknown, ['claude-new-9']);
  for (const r of A.CLAUDE_RATES) assert.ok(r.input > 0 && r.output > 0 && r.match instanceof RegExp);
  // Through the parser: the result carries the run's cost, or names the model it could not price.
  const p = A.claudeParser();
  p.feed({ type: 'assistant', message: { model: 'claude-new-9', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 0, output_tokens: 1 } } });
  const r = p.feed({ type: 'result', result: 'hi', usage: { input_tokens: 5, cache_read_input_tokens: 100, output_tokens: 1 } });
  assert.deepEqual(r.usage, { context: 105, output: 1, costUnknown: ['claude-new-9'] });
});

test('the other agents report no context size: their streams carry none the bridge can trust', () => {
  // Codex names a usage on turn.completed, but whether it is the last call or the turn's sum is unverified.
  const codex = A.codexParser();
  codex.feed({ type: 'thread.started', thread_id: 't' });
  assert.equal(codex.feed({ type: 'turn.completed', usage: { input_tokens: 5000, cached_input_tokens: 4000, output_tokens: 20 } }).usage, undefined);
  const grok = A.grokParser();
  assert.equal(grok.feed({ type: 'usage', data: { input_tokens: 1 } }).usage, undefined);
  assert.equal(grok.feed({ type: 'end', sessionId: 'g', stopReason: 'end_turn' }).usage, undefined);
  assert.equal(A.agyParser().feed({ event: 'result', result: { status: 'SUCCESS', response: 'ok' } }).usage, undefined);
  assert.equal(A.hermesParser().finish({ stdout: 'ok', stderr: '', code: 0 }).usage, undefined);
});
