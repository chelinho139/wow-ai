#!/usr/bin/env node
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const A = require('../bridge/agents');
const P = require('../bridge/protocol');
const SB = require('./sandbox');
const ASK = require('../bridge/plugins/ask');

const REPO = path.resolve(__dirname, '..');
const PRIMER_FILE = path.join(REPO, 'docs', 'WOW-ADDON-PRIMER.md');
const DEFAULT_MODELS = ['opus[1m]', 'claude-sonnet-5-5'];
const DEFAULT_BUDGET_USD = 5;
const PER_RUN_CAP_USD = 1;
const FIRST_RUN_GUESS_USD = { 'opus[1m]': 0.6, 'claude-sonnet-5-5': 0.3 };
const RUN_TIMEOUT_MS = 5 * 60 * 1000;

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

function askAgentConfig(root, model, capUsd) {
  const L = SB.layout(root);
  const cfg = SB.buildConfig(L, { agentPath: realClaudePath(), plugin: 'ask' });
  const acfg = P.withRunOnlyRules(A.agentConfig(cfg, 'claude'), []);
  acfg.model = model;
  acfg.extraArgs = [...(acfg.extraArgs || []), '--no-session-persistence', '--max-budget-usd', String(capUsd)];
  return acfg;
}

function buildRun(promptText, model, root, capUsd) {
  const acfg = askAgentConfig(root, model, capUsd);
  const agent = A.AGENTS.claude;
  const primer = fs.readFileSync(PRIMER_FILE, 'utf8');
  const system = P.systemPrompt(GAME_CONTEXT, primer, { tools: ASK.tools, surfaces: ASK.surfaces });
  const prompt = P.messagePrompt(promptText, GAME_CONTEXT, {});
  const input = agent.input({ prompt, system, resume: '', cfg: acfg, images: [] });
  const cmd = A.resolveCommand('claude', acfg);
  const args = [...cmd.args, ...agent.args({ cfg: acfg, resume: '', cwd: root, system, images: [], prompt })];
  const env = agent.env({ ...process.env });
  env.CLAUDE_WOW_MAP_FILE = path.join(root, 'map.jsonl');
  env.CLAUDE_WOW_UI_FILE = path.join(root, 'ui.jsonl');
  return { file: cmd.file, args, env, stdin: input.stdin, system, prompt };
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

function summarize(prompt, model, raw) {
  const r = raw.result || {};
  const bridgeCost = raw.result ? A.claudeCost(r, raw.lastModel) : null;
  const answer = typeof r.result === 'string' ? r.result : '';
  return {
    prompt: prompt.id, kind: prompt.kind, text: prompt.text, model,
    modelsUsed: r.modelUsage ? Object.keys(r.modelUsage) : [],
    costUsd: Number.isFinite(r.total_cost_usd) ? r.total_cost_usd : null,
    bridgeCostUsd: bridgeCost ? bridgeCost.usd : null,
    bridgeUnknown: bridgeCost ? bridgeCost.unknown : [],
    wallMs: raw.wallMs, apiMs: r.duration_api_ms || null, firstTextMs: raw.firstTextMs || null,
    turns: r.num_turns || null, tools: raw.tools,
    isError: !!r.is_error || !raw.result, subtype: r.subtype || '', exitCode: raw.code,
    answerChars: answer.length, answer,
    modelUsage: r.modelUsage || null, usage: r.usage || null,
    stderr: raw.result ? '' : raw.stderr,
  };
}

function nextEstimate(results, model) {
  const seen = results.filter(r => r.model === model && Number.isFinite(r.costUsd)).map(r => r.costUsd);
  return seen.length ? Math.max(...seen) : (FIRST_RUN_GUESS_USD[model] || PER_RUN_CAP_USD);
}

const usd = n => (Number.isFinite(n) ? `$${n.toFixed(4)}` : 'n/a');
const secs = ms => (Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)} s` : 'n/a');

function renderTable(results) {
  const rows = ['| Prompt | Model | Cost | Wall latency | Answer length | Tools |', '|---|---|---|---|---|---|'];
  for (const r of results) rows.push(`| ${r.prompt} | ${r.model} | ${usd(r.costUsd)} | ${secs(r.wallMs)} | ${r.answerChars} chars | ${r.tools.join(', ') || 'none'}${r.isError ? ` (error: ${r.subtype || 'exit ' + r.exitCode})` : ''} |`);
  return rows.join('\n');
}

function renderTotals(results, models) {
  const rows = ['| Model | Runs | Total cost | Mean cost | Median wall latency | Mean answer length |', '|---|---|---|---|---|---|'];
  for (const m of models) {
    const mine = results.filter(r => r.model === m);
    if (!mine.length) continue;
    const costs = mine.map(r => r.costUsd).filter(Number.isFinite);
    const total = costs.reduce((a, b) => a + b, 0);
    const walls = mine.map(r => r.wallMs).sort((a, b) => a - b);
    const median = walls[Math.floor((walls.length - 1) / 2)];
    const chars = Math.round(mine.reduce((a, r) => a + r.answerChars, 0) / mine.length);
    rows.push(`| ${m} | ${mine.length} | ${usd(total)} | ${usd(total / (costs.length || 1))} | ${secs(median)} | ${chars} chars |`);
  }
  return rows.join('\n');
}

function renderAnswers(results) {
  const out = [];
  for (const p of PROMPTS) {
    const mine = results.filter(r => r.prompt === p.id);
    if (!mine.length) continue;
    out.push(`### ${p.id} (${p.kind})`, '', `Prompt: "${p.text}"`, '');
    for (const r of mine) out.push(`#### ${r.model}`, '', '```text', r.answer.replace(/```/g, "'''") || '(no answer)', '```', '');
  }
  return out.join('\n');
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) {
    console.log('node dev/measure-ask.js [--models opus[1m],claude-sonnet-5-5] [--budget 5] [--only id,id] [--out results.json]\nnode dev/measure-ask.js --render results.json');
    return;
  }
  if (o.render) {
    const data = JSON.parse(fs.readFileSync(o.render, 'utf8'));
    const models = [...new Set(data.results.map(r => r.model))];
    console.log([renderTotals(data.results, models), '', renderTable(data.results), '', renderAnswers(data.results)].join('\n'));
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-wow-measure-'));
  const out = o.out || path.join(root, 'results.json');
  const prompts = o.only.length ? PROMPTS.filter(p => o.only.includes(p.id)) : PROMPTS;
  const results = [];
  let spent = 0, stopped = '';
  console.log(`claude: ${realClaudePath()}\nscratch: ${root}\nresults: ${out}\nbudget: $${o.budget}`);
  outer: for (const [i, prompt] of prompts.entries()) {
    const order = i % 2 ? [...o.models].reverse() : o.models;
    for (const model of order) {
      const estimate = nextEstimate(results, model);
      if (spent + estimate > o.budget) { stopped = `stopped before ${prompt.id} on ${model}: $${spent.toFixed(4)} spent + $${estimate.toFixed(4)} estimate > $${o.budget}`; break outer; }
      const cwd = fs.mkdtempSync(path.join(root, `${prompt.id}-`));
      const cap = Math.min(PER_RUN_CAP_USD, o.budget - spent);
      const raw = await runOnce(buildRun(prompt.text, model, cwd, cap), cwd);
      const row = summarize(prompt, model, raw);
      results.push(row);
      spent += Number.isFinite(row.costUsd) ? row.costUsd : cap;
      console.log(`${prompt.id} ${model}: $${row.costUsd} bridge $${row.bridgeCostUsd} ${row.wallMs}ms ${row.answerChars} chars tools=[${row.tools.join(',')}]${row.isError ? ' ERROR ' + row.subtype : ''} total $${spent.toFixed(4)}`);
      fs.writeFileSync(out, JSON.stringify({ context: GAME_CONTEXT, budget: o.budget, spent, stopped, results }, null, 2) + '\n');
    }
  }
  if (stopped) console.log(stopped);
  console.log(`spent $${spent.toFixed(4)} on ${results.length} runs`);
}

if (require.main === module) main().catch(e => { console.error(e.stack || e.message); process.exit(1); });

module.exports = { PROMPTS, GAME_CONTEXT, buildRun, askAgentConfig, summarize, nextEstimate, renderTable, renderTotals, renderAnswers };
