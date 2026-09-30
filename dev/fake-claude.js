#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MODEL = 'claude-opus-5';
const RATES = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };
const BASE_CONTEXT = 20000;
const TURN_GROWTH = 1500;
const ACCEPT_EDITS_COMMANDS = new Set(['mkdir', 'touch', 'rm', 'rmdir', 'mv', 'cp', 'sed']);

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function directives(text) {
  const found = {};
  for (const m of String(text).matchAll(/\[\[\s*([a-z-]+)(?:\s+([^\]]*?))?\s*\]\]/gi)) found[m[1].toLowerCase()] = m[2] === undefined ? true : m[2];
  return found;
}

function stateDir() {
  return process.env.CLAUDE_WOW_FAKE_STATE || path.join(process.cwd(), '.fake-claude');
}

function loadSession(id) {
  try { return JSON.parse(fs.readFileSync(path.join(stateDir(), `${id}.json`), 'utf8')); } catch { return null; }
}

function saveSession(s) {
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(path.join(stateDir(), `${s.id}.json`), JSON.stringify(s, null, 2));
}

function recordCall(entry) {
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.appendFileSync(path.join(stateDir(), 'calls.jsonl'), JSON.stringify(entry) + '\n');
}

function turnUsage(turn) {
  return {
    input_tokens: 3,
    cache_creation_input_tokens: TURN_GROWTH,
    cache_read_input_tokens: BASE_CONTEXT + TURN_GROWTH * (turn - 1),
    output_tokens: 200,
  };
}

function priceOf(u) {
  return (u.input_tokens * RATES.input + u.output_tokens * RATES.output
    + u.cache_read_input_tokens * RATES.cacheRead + u.cache_creation_input_tokens * RATES.cacheWrite) / 1e6;
}

function addUsage(total, u) {
  return {
    inputTokens: (total.inputTokens || 0) + u.input_tokens,
    outputTokens: (total.outputTokens || 0) + u.output_tokens,
    cacheReadInputTokens: (total.cacheReadInputTokens || 0) + u.cache_read_input_tokens,
    cacheCreationInputTokens: (total.cacheCreationInputTokens || 0) + u.cache_creation_input_tokens,
    costUSD: (total.costUSD || 0) + priceOf(u),
    contextWindow: 1000000,
  };
}

function emit(ev) {
  process.stdout.write(JSON.stringify(ev) + '\n');
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function readStdin() {
  return new Promise(resolve => {
    let data = '';
    if (process.stdin.isTTY) return resolve('');
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', c => { data += c; });
    process.stdin.on('end', () => resolve(data));
  });
}

function promptText(raw) {
  const line = raw.trim().split('\n')[0];
  try {
    const msg = JSON.parse(line);
    const content = msg && msg.message && msg.message.content;
    if (Array.isArray(content)) return { text: content.filter(c => c.type === 'text').map(c => c.text).join('\n'), images: content.filter(c => c.type === 'image').length };
  } catch {}
  return { text: raw, images: 0 };
}

function argList(argv, name) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== name) continue;
    for (let j = i + 1; j < argv.length && !String(argv[j]).startsWith('--'); j++) out.push(argv[j]);
  }
  return out;
}

function insideAny(p, dirs) {
  return dirs.some(d => {
    const rel = path.relative(path.resolve(d), path.resolve(p));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
}

function bashRefusal(command, argv, stuck) {
  const word = String(command).trim().split(/\s+/)[0];
  const rules = argList(argv, '--allowedTools');
  const dirs = stuck ? [process.cwd()] : [process.cwd(), ...argList(argv, '--add-dir')];
  const outside = String(command).split(/\s+/).slice(1).find(a => path.isAbsolute(a) && !insideAny(a, dirs));
  if (outside) return `${word} in '${outside}' needs approval. The path is outside the working directories for this session ('${process.cwd()}'). Allowing runs the command as written.`;
  const autoEdit = arg(argv, '--permission-mode') === 'acceptEdits' && ACCEPT_EDITS_COMMANDS.has(word);
  if (!autoEdit && !rules.includes(`Bash(${word}:*)`)) return 'This command requires approval';
  return '';
}

function runBash(session, command, argv) {
  const id = `toolu_fake_${session.turns}`;
  emit({ type: 'assistant', session_id: session.id, message: { model: MODEL, role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }], usage: turnUsage(session.turns) } });
  const refusal = bashRefusal(command, argv, session.stuck);
  if (!refusal) {
    emit({ type: 'user', session_id: session.id, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: false, content: '(Bash completed with no output)' }] } });
    return null;
  }
  emit({ type: 'system', subtype: 'permission_denied', tool_name: 'Bash', tool_use_id: id, message: refusal, session_id: session.id });
  emit({ type: 'user', session_id: session.id, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: refusal }] } });
  return { tool_name: 'Bash', tool_use_id: id, tool_input: { command } };
}

function lastUserLine(text) {
  const lines = String(text).split('\n').map(l => l.trim()).filter(Boolean);
  return lines[lines.length - 1] || '';
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--version')) { console.log('0.0.0 (claude-wow fake)'); return; }
  if (argv.includes('--no-session-persistence')) { console.log('Fake Chat Title'); return; }
  const raw = await readStdin();
  const { text, images } = promptText(raw);
  const d = directives(text);
  const resume = arg(argv, '--resume');
  const prior = resume ? loadSession(resume) : null;
  const session = prior || { id: resume || crypto.randomUUID(), turns: 0, total: {}, created: Date.now() };
  session.turns += 1;
  recordCall({ at: new Date().toISOString(), session: session.id, turn: session.turns, resume: resume || null, images, directives: d, argv, cwd: process.cwd(), pid: process.pid });

  if (d.auth) {
    emit({ type: 'result', subtype: 'success', is_error: true, result: 'Invalid API key · Please run /login', session_id: session.id });
    process.exit(1);
  }
  if (d['no-result']) process.exit(Number(d['no-result']) || 1);
  emit({ type: 'system', subtype: 'init', session_id: session.id, model: MODEL, cwd: process.cwd(), tools: [] });
  if (d.crash) { process.stderr.write('fake-claude: crashing on request\n'); process.exit(Number(d.crash) || 3); }
  if (d.hang) { setInterval(() => {}, 1 << 30); await new Promise(() => {}); }

  const tools = Number(d.tools) || 0;
  const pause = Number(d.sleep) || 0;
  for (let i = 1; i <= tools; i++) {
    emit({ type: 'assistant', session_id: session.id, message: { model: MODEL, role: 'assistant', content: [{ type: 'tool_use', id: `tool_${i}`, name: 'Bash', input: { command: `echo step ${i}` } }], usage: turnUsage(session.turns) } });
    if (pause) await sleep((pause * 1000) / (tools + 1));
  }
  if (pause) await sleep(tools ? (pause * 1000) / (tools + 1) : pause * 1000);

  if (d['rate-limit']) {
    emit({ type: 'result', subtype: 'success', is_error: true, result: 'Claude AI usage limit reached|' + Math.floor(Date.now() / 1000 + 3600), session_id: session.id });
    saveSession(session);
    process.exit(1);
  }
  if (d.error) {
    emit({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: session.id, ...(d.error === true ? {} : { result: String(d.error) }) });
    saveSession(session);
    process.exit(1);
  }

  if (typeof d['bash-stuck'] === 'string') { d.bash = d['bash-stuck']; session.stuck = true; }
  const command = typeof d.bash === 'string' ? d.bash : session.pendingBash;
  const denials = [];
  if (command) {
    const denial = runBash(session, command, argv);
    if (denial) { denials.push(denial); session.pendingBash = command; } else delete session.pendingBash;
  }

  const u = turnUsage(session.turns);
  session.total = addUsage(session.total, u);
  saveSession(session);
  const said = denials.length ? `blocked (turn ${session.turns}): ${command}` : command ? `ran (turn ${session.turns}): ${command}` : '';
  const reply = d.reply !== undefined && d.reply !== true ? String(d.reply) : said || `echo (turn ${session.turns}): ${lastUserLine(text).slice(0, 200)}`;
  const body = d.long ? `${reply}\n` + 'lorem ipsum dolor sit amet '.repeat(Number(d.long) || 100) : reply;
  emit({ type: 'assistant', session_id: session.id, message: { model: MODEL, role: 'assistant', content: [{ type: 'text', text: body }], usage: u } });
  emit({
    type: 'result', subtype: 'success', is_error: false, result: body, session_id: session.id,
    num_turns: session.turns, usage: u, permission_denials: denials,
    modelUsage: { [MODEL]: session.total },
    total_cost_usd: session.total.costUSD,
  });
}

main().catch(e => { process.stderr.write(String(e && e.stack || e) + '\n'); process.exit(70); });
