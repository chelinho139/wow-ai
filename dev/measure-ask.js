#!/usr/bin/env node
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const A = require('../bridge/agents');
const P = require('../bridge/protocol');
const SB = require('./sandbox');
const ASK = require('../bridge/plugins/ask');

const REPO = path.resolve(__dirname, '..');
const PRIMER_FILE = path.join(REPO, 'docs', 'WOW-ADDON-PRIMER.md');
const DEFAULT_MODELS = ['opus[1m]', 'claude-sonnet-5-5'];
const DEFAULT_BUDGET_USD = 3;
const PER_RUN_CAP_USD = 1;
const PHASES = ['cold-first', 'warm-first', 'resumed'];
const FIRST_RUN_GUESS_USD = {
  'opus[1m]': { 'cold-first': 0.4, 'warm-first': 0.15, resumed: 0.15 },
  'claude-sonnet-5-5': { 'cold-first': 0.2, 'warm-first': 0.08, resumed: 0.08 },
};
const RUN_TIMEOUT_MS = 5 * 60 * 1000;
const FOLLOW_UP = 'thanks. in one sentence, what is the first thing I should do?';
const SYSTEM_FLAG = '--append-system-prompt';

const GAME_CONTEXT = [
  'Game: World of Warcraft: Forever (client 1.60.1.70124, interface 16001)',
  'Character: Bone on Classic Beta PvP 2, level 20 Orc Rogue (Horde)',
  'Location: Undercity - Canals',
  'Position: 59.3, 17.4 (map 1458)',
  'Money: 21s 29c; XP: 91/23200',
  'Professions: Leatherworking 107/150, Skinning 187/225, Cooking 11/75, First Aid 97/150, Fishing 4/75',
  'Quest log (id, * = ready to turn in): 6563,235*,5728,5761,896,863,852,882,899,1069,1060*,4921,92706,97003,878,1483*,868,97250,264*,1130*,1489*,1491,959,97904,2479*',
].join('\n');

const PROMPTS = [
  { id: 'where-trainer', kind: 'where-is', text: 'where is my class trainer in this city?' },
  { id: 'where-skinning', kind: 'where-is', text: 'my skinning is capped at 225. where do I train the next rank?' },
  { id: 'where-fishing', kind: 'where-is', text: 'where can I buy a fishing pole near here?' },
  { id: 'macro-opener', kind: 'macro', text: 'make me a macro that opens with my stun when I am stealthed and uses my normal combo point builder when I am not' },
  { id: 'macro-pickpocket', kind: 'macro', text: 'macro: pick pocket my target, then start attacking it' },
  { id: 'route-turnins', kind: 'route', text: 'which quests in my log are ready to turn in, and in what order should I hand them in? mark the route on my map' },
  { id: 'route-next-zone', kind: 'route', text: 'I am level 20. where should I go to level next, and why?' },
  { id: 'advice-talents', kind: 'advice', text: 'which talent tree should I use for solo questing at my level?' },
  { id: 'advice-money', kind: 'advice', text: 'I only have about 21 silver. what should I spend money on first at this level?' },
  { id: 'lore-city', kind: 'lore', text: 'who leads this city and what is its story, in short?' },
];

function parseArgs(argv) {
  const o = { models: DEFAULT_MODELS, budget: DEFAULT_BUDGET_USD, out: '', only: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--models') o.models = String(argv[++i] || '').split(',').filter(Boolean);
    else if (a === '--budget') o.budget = Number(argv[++i]);
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--render') o.render = argv[++i];
    else if (a === '--only') o.only = String(argv[++i] || '').split(',').filter(Boolean);
    else if (a === '--help' || a === '-h') o.help = true;
  }
  return o;
}

function realClaudePath() {
  const found = A.resolveCommand('claude', {});
  if (!found.found) throw new Error(`no real claude CLI found: ${found.note}`);
  if (/fake-claude/.test(found.file)) throw new Error('refusing to measure dev/fake-claude.js');
  return found.file;
}

function claudeVersion(file) {
  const r = spawnSync(file, ['--version'], { encoding: 'utf8', timeout: 30000 });
  return String(r.stdout || '').trim() || null;
}

function askAgentConfig(root, model, capUsd) {
  const L = SB.layout(root);
  const cfg = SB.buildConfig(L, { agentPath: realClaudePath(), plugin: 'ask' });
  const acfg = P.withRunOnlyRules(A.agentConfig(cfg, 'claude'), []);
  acfg.model = model;
  acfg.extraArgs = [...(acfg.extraArgs || []), '--max-budget-usd', String(capUsd)];
  return acfg;
}

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

function redactedArgv(file, args) {
  const out = [file];
  for (let i = 0; i < args.length; i++) {
    out.push(args[i]);
    if (args[i] === SYSTEM_FLAG && i + 1 < args.length) {
      const system = args[++i];
      out.push(`<system prompt: ${Buffer.byteLength(system)} bytes, sha256 ${sha256(system)}>`);
    }
  }
  return out;
}

function buildRun(promptText, model, root, capUsd, resume = '') {
  const acfg = askAgentConfig(root, model, capUsd);
  const agent = A.AGENTS.claude;
  const primer = fs.readFileSync(PRIMER_FILE, 'utf8');
  const system = P.systemPrompt(GAME_CONTEXT, primer, { tools: ASK.tools, surfaces: ASK.surfaces });
  const prompt = P.messagePrompt(promptText, GAME_CONTEXT, {});
  const input = agent.input({ prompt, system, resume, cfg: acfg, images: [] });
  const cmd = A.resolveCommand('claude', acfg);
  const args = [...cmd.args, ...agent.args({ cfg: acfg, resume, cwd: root, system, images: [], prompt })];
  const env = agent.env({ ...process.env });
  env.CLAUDE_WOW_MAP_FILE = path.join(root, 'map.jsonl');
  env.CLAUDE_WOW_UI_FILE = path.join(root, 'ui.jsonl');
  return { file: cmd.file, args, env, stdin: input.stdin, system, prompt, argv: redactedArgv(cmd.file, args), systemSha256: sha256(system) };
}

function runOnce(run, cwd) {
  return new Promise(resolve => {
    const started = Date.now();
    const child = spawn(run.file, run.args, { cwd, env: run.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const tools = [];
    let buffer = '', stderr = '', result = null, lastModel = '', firstTextMs = 0;
    const timer = setTimeout(() => child.kill('SIGTERM'), RUN_TIMEOUT_MS);
    const take = line => {
      let ev;
      try { ev = JSON.parse(line); } catch { return; }
      if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
        if (ev.message.model) lastModel = ev.message.model;
        for (const b of ev.message.content) {
          if (b.type === 'tool_use') tools.push(b.name);
          if (b.type === 'text' && b.text && !firstTextMs) firstTextMs = Date.now() - started;
        }
      }
      if (ev.type === 'result') result = ev;
    };
    child.stdout.on('data', d => {
      buffer += d.toString('utf8');
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) { take(buffer.slice(0, nl)); buffer = buffer.slice(nl + 1); }
    });
    child.stderr.on('data', d => { stderr += d.toString('utf8'); });
    child.stdin.on('error', () => {});
    child.stdin.end(run.stdin);
    child.on('close', code => {
      clearTimeout(timer);
      if (buffer.trim()) take(buffer);
      resolve({ code, wallMs: Date.now() - started, firstTextMs, tools, result, lastModel, stderr: stderr.slice(-2000) });
    });
  });
}

const minus = (total, before) => (Number.isFinite(total) ? total - (Number.isFinite(before) ? before : 0) : null);

function summarize(prompt, model, phase, run, raw, before = null) {
  const r = raw.result || {};
  const u = r.usage || {};
  const bridgeCost = raw.result ? A.claudeCost(r, raw.lastModel) : null;
  const answer = typeof r.result === 'string' ? r.result : '';
  const sessionCostUsd = Number.isFinite(r.total_cost_usd) ? r.total_cost_usd : null;
  const bridgeSessionCostUsd = bridgeCost ? bridgeCost.usd : null;
  return {
    prompt: prompt.id, kind: prompt.kind, phase, text: phase === 'resumed' ? FOLLOW_UP : prompt.text, model,
    sessionId: r.session_id || '',
    modelsUsed: r.modelUsage ? Object.keys(r.modelUsage) : [],
    sessionCostUsd, bridgeSessionCostUsd,
    costUsd: minus(sessionCostUsd, before && before.sessionCostUsd),
    bridgeCostUsd: minus(bridgeSessionCostUsd, before && before.bridgeSessionCostUsd),
    bridgeUnknown: bridgeCost ? bridgeCost.unknown : [],
    cacheWriteTokens: Number.isFinite(u.cache_creation_input_tokens) ? u.cache_creation_input_tokens : null,
    cacheReadTokens: Number.isFinite(u.cache_read_input_tokens) ? u.cache_read_input_tokens : null,
    wallMs: raw.wallMs, apiMs: r.duration_api_ms || null, firstTextMs: raw.firstTextMs || null,
    turns: r.num_turns || null, tools: raw.tools,
    isError: !!r.is_error || !raw.result, subtype: r.subtype || '', exitCode: raw.code,
    answerChars: answer.length, answer,
    argv: run.argv, systemSha256: run.systemSha256,
    modelUsage: r.modelUsage || null, usage: r.usage || null,
    stderr: raw.result ? '' : raw.stderr,
  };
}

function nextEstimate(results, model, phase) {
  const seen = results.filter(r => r.model === model && r.phase === phase && Number.isFinite(r.costUsd)).map(r => r.costUsd);
  if (seen.length) return Math.max(...seen);
  return (FIRST_RUN_GUESS_USD[model] || {})[phase] || PER_RUN_CAP_USD;
}

function median(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return NaN;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

const mean = values => {
  const v = values.filter(Number.isFinite);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
};
const usd = n => (Number.isFinite(n) ? `$${n.toFixed(4)}` : 'n/a');
const secs = ms => (Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)} s` : 'n/a');
const ktok = n => (Number.isFinite(n) ? `${(n / 1000).toFixed(1)}k` : 'n/a');

function renderTable(results) {
  const rows = ['| Prompt | Phase | Model | Cost | Cache write / read | Wall latency | Answer length | Tools |', '|---|---|---|---|---|---|---|---|'];
  for (const r of results) rows.push(`| ${r.prompt} | ${r.phase} | ${r.model} | ${usd(r.costUsd)} | ${ktok(r.cacheWriteTokens)} / ${ktok(r.cacheReadTokens)} | ${secs(r.wallMs)} | ${r.answerChars} chars | ${r.tools.join(', ') || 'none'}${r.isError ? ` (error: ${r.subtype || 'exit ' + r.exitCode})` : ''} |`);
  return rows.join('\n');
}

function renderTotals(results, models) {
  const rows = ['| Model | Phase | Runs (errors) | Total cost | Mean cost | Mean cache write / read | Median wall latency | Mean answer length |', '|---|---|---|---|---|---|---|---|'];
  for (const m of models) {
    for (const phase of PHASES) {
      const all = results.filter(r => r.model === m && r.phase === phase);
      if (!all.length) continue;
      const mine = all.filter(r => !r.isError);
      const total = all.map(r => r.costUsd).filter(Number.isFinite).reduce((a, b) => a + b, 0);
      const costs = mine.map(r => r.costUsd).filter(Number.isFinite);
      rows.push(`| ${m} | ${phase} | ${mine.length} (${all.length - mine.length}) | ${usd(total)} | ${usd(mean(costs))} | ${ktok(mean(mine.map(r => r.cacheWriteTokens)))} / ${ktok(mean(mine.map(r => r.cacheReadTokens)))} | ${secs(median(mine.map(r => r.wallMs)))} | ${Math.round(mean(mine.map(r => r.answerChars)))} chars |`);
    }
  }
  return rows.join('\n');
}

function renderAnswers(results) {
  const out = [];
  for (const p of PROMPTS) {
    const mine = results.filter(r => r.prompt === p.id);
    if (!mine.length) continue;
    out.push(`### ${p.id} (${p.kind})`, '', `Prompt: "${p.text}"`, '', `Follow-up: "${FOLLOW_UP}"`, '');
    for (const r of mine) out.push(`#### ${r.model}, ${r.phase}`, '', '```text', r.answer.replace(/```/g, "'''") || '(no answer)', '```', '');
  }
  return out.join('\n');
}

const folderFor = model => model.replace(/[^\w.-]/g, '_');

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) {
    console.log('node dev/measure-ask.js [--models opus[1m],claude-sonnet-5-5] [--budget 3] [--only id,id] [--out results.json]\nnode dev/measure-ask.js --render results.json');
    return;
  }
  if (o.render) {
    const data = JSON.parse(fs.readFileSync(o.render, 'utf8'));
    const models = [...new Set(data.results.map(r => r.model))];
    console.log([renderTotals(data.results, models), '', renderTable(data.results), '', renderAnswers(data.results)].join('\n'));
    return;
  }
  const claudePath = realClaudePath();
  const meta = { claudePath, claudeVersion: claudeVersion(claudePath), ranAt: new Date().toISOString(), followUp: FOLLOW_UP };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-wow-measure-'));
  const cwds = {};
  for (const m of o.models) { cwds[m] = path.join(root, folderFor(m)); fs.mkdirSync(cwds[m]); }
  const out = o.out || path.join(root, 'results.json');
  const prompts = o.only.length ? PROMPTS.filter(p => o.only.includes(p.id)) : PROMPTS;
  const results = [];
  let spent = 0, stopped = '';
  const save = () => fs.writeFileSync(out, JSON.stringify({ ...meta, context: GAME_CONTEXT, budget: o.budget, spent, stopped, cwds, results }, null, 2) + '\n');
  console.log(`claude: ${claudePath} (${meta.claudeVersion})\nscratch: ${root}\nresults: ${out}\nbudget: $${o.budget}`);
  const step = async (prompt, model, phase, text, before) => {
    const resume = before ? before.sessionId : '';
    const estimate = nextEstimate(results, model, phase);
    if (spent + estimate > o.budget) {
      stopped = `stopped before ${prompt.id} ${phase} on ${model}: $${spent.toFixed(4)} spent + $${estimate.toFixed(4)} estimate > $${o.budget}`;
      return null;
    }
    const cap = Math.min(PER_RUN_CAP_USD, o.budget - spent);
    const sessionCap = cap + (before && Number.isFinite(before.sessionCostUsd) ? before.sessionCostUsd : 0);
    const run = buildRun(text, model, cwds[model], sessionCap, resume);
    const raw = await runOnce(run, cwds[model]);
    const row = summarize(prompt, model, phase, run, raw, before);
    results.push(row);
    spent += Number.isFinite(row.costUsd) ? row.costUsd : cap;
    console.log(`${prompt.id} ${phase} ${model}: $${row.costUsd} bridge $${row.bridgeCostUsd} write ${row.cacheWriteTokens} read ${row.cacheReadTokens} ${row.wallMs}ms ${row.answerChars} chars tools=[${row.tools.join(',')}]${row.isError ? ' ERROR ' + row.subtype : ''} total $${spent.toFixed(4)}`);
    save();
    return row;
  };
  const warmed = new Set();
  outer: for (const [i, prompt] of prompts.entries()) {
    const order = i % 2 ? [...o.models].reverse() : o.models;
    for (const model of order) {
      const first = await step(prompt, model, warmed.has(model) ? 'warm-first' : 'cold-first', prompt.text, null);
      if (!first) break outer;
      warmed.add(model);
      if (first.isError || !first.sessionId) continue;
      if (!(await step(prompt, model, 'resumed', FOLLOW_UP, first))) break outer;
    }
  }
  save();
  if (stopped) console.log(stopped);
  console.log(`spent $${spent.toFixed(4)} on ${results.length} runs`);
}

if (require.main === module) main().catch(e => { console.error(e.stack || e.message); process.exit(1); });

module.exports = { PROMPTS, GAME_CONTEXT, FOLLOW_UP, buildRun, askAgentConfig, redactedArgv, summarize, nextEstimate, median, renderTable, renderTotals, renderAnswers };
