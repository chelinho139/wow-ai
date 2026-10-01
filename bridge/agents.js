'use strict';
// The coding agents the bridge can drive, and the two things bridge.js needs
// from each: how to start it headless in a folder with a prompt, and how to
// turn what it prints into progress lines, a session id and a reply.
//
//   claude  Claude Code   `claude -p --output-format stream-json`, prompt on stdin
//   codex   OpenAI Codex  `codex exec --json`, prompt on stdin
//   grok    xAI Grok      `grok --prompt-file … --output-format streaming-json`
//
// Everything is pure (no I/O) except resolveCommand, which looks for the
// executable on disk. Adding an agent: an entry in AGENTS (args, input, parser,
// optionally denialRule/allowFlag), a block in config.example.json, a section
// in docs/AGENTS.md, a case in tests/agents_test.js.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describeToolUse, ruleFor, baseName, classifyDenial, deniedAgain, denialNotes } = require('./protocol');
const R = require('./runtime'); // which node runs a JavaScript launcher

const PROGRESS_CHARS = 140;

// One progress line's worth of a text: first PROGRESS_CHARS characters, one line.
function snippet(text) {
  const s = String(text || '').trim().replace(/\s+/g, ' ');
  return s.length > PROGRESS_CHARS ? s.slice(0, PROGRESS_CHARS) + '...' : s;
}

function firstLine(s) { return String(s || '').split('\n')[0].slice(0, 110); }

// The command inside the shell wrapper an agent runs it with (Codex: `/bin/zsh -lc 'ls -la'`).
function shellInner(cmd) {
  const s = String(cmd || '').trim();
  const sh = /^(?:\S*[\\/])?(?:ba|z|da)?sh(?:\.exe)?\s+-l?c\s+(['"])([\s\S]*)\1$/.exec(s);
  if (sh) return sh[2];
  const win = /^(?:\S*[\\/])?(?:cmd(?:\.exe)?\s+\/[cC]|(?:powershell|pwsh)(?:\.exe)?\s+-(?:Command|c))\s+(['"]?)([\s\S]*)\1$/.exec(s);
  if (win) return win[2];
  return s;
}

// A fresh accumulator for one parsed line. progress: lines for the working
// bubble; session: the agent's session id, for the next run's resume; denied:
// allowlist rules (Claude syntax) the run was refused; notes: text the bridge
// appends to the reply; done: the reply itself, once the run has produced it;
// usage: { context, output, window? } when the event says how big the session
// has grown (see claudeUsage). The bridge keeps the last usage it sees.
function empty() { return { progress: [], denied: [], notes: [] }; }

// Context growth. Every message resumes the chat's session, so what the model
// reads grows with every turn, and each message costs more than the last. The
// number the addon shows is what the NEXT message will carry: everything the
// model read on its last call, which for Claude Code is input_tokens +
// cache_read_input_tokens + cache_creation_input_tokens of the last assistant
// message (verified on Claude Code 2.1 with `-p --output-format stream-json
// --verbose`: a resumed turn's first call reads exactly the previous turn's
// total plus the new message). The result event's usage is the SUM over the
// turn's calls (two tool steps: cache_read 62k where each call read 31k), so it
// is only a fallback for a turn that produced no assistant message.
function claudeUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const n = k => (Number.isFinite(u[k]) && u[k] > 0 ? u[k] : 0);
  const context = n('input_tokens') + n('cache_read_input_tokens') + n('cache_creation_input_tokens');
  return context > 0 ? { context, output: n('output_tokens') } : null;
}

// The model's context window, when a result names it (modelUsage.<model>.contextWindow).
function claudeWindow(ev) {
  const mu = ev && ev.modelUsage && typeof ev.modelUsage === 'object' ? Object.values(ev.modelUsage) : [];
  const w = mu.map(m => m && Number(m.contextWindow)).filter(x => Number.isFinite(x) && x > 0);
  return w.length ? Math.max(...w) : 0;
}

// What a run would have cost at API list prices. A Max or Pro subscription is
// not billed by the token, so the addon shows this as "≈$2.41 API": a
// comparison, never a bill. Rates are USD per million tokens, Anthropic's
// first-party list prices as the claude-api skill's model table has them
// (cached 2026-06-24; https://docs.claude.com/en/docs/about-claude/pricing).
// Cache writes cost 1.25x the input rate (5-minute) or 2x (1-hour), cache
// reads 0.1x, unless a model lists its own read rate (cacheRead). Checked
// against Claude Code's own total_cost_usd for a real haiku run (tests).
// A model not in this table gets no cost, only its tokens. Update here.
const CLAUDE_RATES = [
  { match: /claude-fable-5-1\b/, input: 10, output: 50, cacheRead: 0.25 },
  { match: /claude-fable-5\b(?!-1)/, input: 10, output: 50 },
  { match: /claude-opus-5-5\b/, input: 4, output: 20, cacheRead: 0.2 },
  { match: /claude-opus-5\b(?!-5\b)/, input: 5, output: 25 },
  { match: /claude-opus-4-[5678]\b/, input: 5, output: 25 },
  { match: /claude-sonnet-5\b/, input: 2, output: 10 },
  { match: /claude-sonnet-4-[56]\b/, input: 3, output: 15 },
  { match: /claude-haiku-4-5\b/, input: 1, output: 5 },
];
const CACHE_WRITE_5M = 1.25, CACHE_WRITE_1H = 2, CACHE_READ = 0.1;

function claudeRate(model) {
  const m = String(model || '');
  return CLAUDE_RATES.find(r => r.match.test(m)) || null;
}

// USD for one model's tokens: { input, output, cacheRead, cache5m, cache1h }.
function priceTokens(rate, t) {
  return (t.input * rate.input + t.output * rate.output
    + t.cacheRead * (rate.cacheRead !== undefined ? rate.cacheRead : rate.input * CACHE_READ)
    + t.cache5m * rate.input * CACHE_WRITE_5M + t.cache1h * rate.input * CACHE_WRITE_1H) / 1e6;
}

// { usd, models, unknown } for a result event: per model from modelUsage
// (inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens),
// with the 5-minute / 1-hour split of the cache writes taken from the top-level
// usage.cache_creation (it is not broken down per model). Without modelUsage,
// the top-level usage priced at `model` (the last assistant message's). Null
// when there is nothing to price; `unknown` lists the models with no rate.
function claudeCost(ev, model) {
  const u = ev && ev.usage && typeof ev.usage === 'object' ? ev.usage : null;
  const n = (o, k) => (o && Number.isFinite(o[k]) && o[k] > 0 ? o[k] : 0);
  const cc = u && u.cache_creation && typeof u.cache_creation === 'object' ? u.cache_creation : null;
  const t1h = n(cc, 'ephemeral_1h_input_tokens'), t5m = n(cc, 'ephemeral_5m_input_tokens');
  const share1h = t1h + t5m > 0 ? t1h / (t1h + t5m) : 0;
  const mu = ev && ev.modelUsage && typeof ev.modelUsage === 'object' ? ev.modelUsage : null;
  const models = mu ? Object.keys(mu) : [];
  let usd = 0;
  const unknown = [];
  const counted = m => ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens'].some(k => mu[m] && Number.isFinite(mu[m][k]));
  // One model whose entry names no token counts: the top-level usage is its usage.
  if (models.length === 1 && !counted(models[0])) model = models[0];
  else if (models.length) {
    for (const m of models) {
      const rate = claudeRate(m);
      if (!rate) { unknown.push(m); continue; }
      if (!counted(m)) { unknown.push(m); continue; } // several models, this one without counts: cannot be priced
      const x = mu[m];
      const write = n(x, 'cacheCreationInputTokens');
      usd += priceTokens(rate, { input: n(x, 'inputTokens'), output: n(x, 'outputTokens'), cacheRead: n(x, 'cacheReadInputTokens'), cache1h: write * share1h, cache5m: write * (1 - share1h) });
    }
    return { usd, models, unknown, sessionTotal: true };
  }
  if (!u || !model) return null;
  const rate = claudeRate(model);
  if (!rate) return { usd: 0, models: [model], unknown: [model] };
  const write = n(u, 'cache_creation_input_tokens');
  usd = priceTokens(rate, { input: n(u, 'input_tokens'), output: n(u, 'output_tokens'), cacheRead: n(u, 'cache_read_input_tokens'), cache1h: cc ? t1h : 0, cache5m: cc ? t5m : write });
  return { usd, models: [model], unknown: [] };
}

// ---------------------------------------------------------------------------
// Permission rules
// ---------------------------------------------------------------------------

// Rules are written in Claude Code's syntax everywhere (config.json, the Allow
// button): `Bash(git:*)` = any command starting with git, `WebSearch` = a tool.
// Grok's rules are globs, so `git:*` becomes `git *` plus the bare `git`.
function grokRules(rule) {
  const m = /^Bash\(([^\s:()]+):\*\)$/.exec(String(rule || '').trim());
  if (m) return [`Bash(${m[1]} *)`, `Bash(${m[1]})`];
  return rule ? [String(rule).trim()] : [];
}

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

const DENIAL_MESSAGE_CHARS = 600;

function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(c => (c && typeof c.text === 'string' ? c.text : '')).join('\n');
}

function claudeParser(opts = {}) {
  let usage = null; // the last assistant message's usage: what the next turn will carry
  let model = '';   // the model that wrote it, for pricing a result without modelUsage
  const refusals = new Map();
  const noteRefusal = (id, message, reasonType, replace) => {
    if (!id || (!replace && refusals.has(id))) return;
    refusals.set(String(id), { message: String(message || '').slice(0, DENIAL_MESSAGE_CHARS), reasonType: String(reasonType || '') });
  };
  return {
    feed(ev) {
      const out = empty();
      if (ev.session_id) out.session = ev.session_id;
      if (ev.type === 'system' && ev.subtype === 'permission_denied') {
        noteRefusal(ev.tool_use_id, ev.message || ev.decision_reason, ev.decision_reason_type, true);
      } else if (ev.type === 'user' && ev.message && Array.isArray(ev.message.content)) {
        for (const block of ev.message.content) {
          if (block && block.type === 'tool_result' && block.is_error) noteRefusal(block.tool_use_id, toolResultText(block.content), '', false);
        }
      }
      if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
        for (const block of ev.message.content) {
          if (block.type === 'tool_use') out.progress.push(describeToolUse(block));
          else if (block.type === 'text' && block.text && block.text.trim()) out.progress.push(snippet(block.text));
        }
        const u = claudeUsage(ev.message.usage);
        if (u) { usage = u; out.usage = { ...u }; }
        if (typeof ev.message.model === 'string' && ev.message.model) model = ev.message.model;
      } else if (ev.type === 'result') {
        const u = usage || claudeUsage(ev.usage);
        const window = claudeWindow(ev);
        if (u) {
          out.usage = window ? { ...u, window } : { ...u };
          // The run's API-equivalent price: the result's usage is the sum over its calls.
          const cost = claudeCost(ev, model);
          if (cost && !cost.unknown.length) { out.usage.cost = cost.usd; if (cost.sessionTotal) out.usage.costIsSessionTotal = true; }
          else out.usage.costUnknown = cost ? cost.unknown : ['no model named'];
        }
        const missing = ev.result === undefined || ev.result === null || ev.result === '';
        const text = missing && ev.is_error ? `Claude Code ended with an error (${ev.subtype || 'no detail given'}) and no message.`
          : typeof ev.result === 'string' ? ev.result : JSON.stringify(ev.result ?? '', null, 2);
        const denials = Array.isArray(ev.permission_denials) ? ev.permission_denials : [];
        if (denials.length) {
          const entries = denials.map(d => classifyDenial(d, refusals.get(String(d && d.tool_use_id)) || {}, opts));
          const again = entries.filter(e => deniedAgain(e, opts.granted));
          const fresh = entries.filter(e => !again.includes(e));
          out.denied = [...new Set(fresh.map(e => e.rule))];
          if (again.length) out.deniedAgain = [...new Set(again.map(e => e.rule))];
          out.notes.push(...denialNotes('Claude', fresh, again));
        }
        out.done = { text, error: !!ev.is_error };
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

// One progress line for a Codex item, or null for the kinds shown elsewhere.
function codexItemLine(item) {
  switch (item.type) {
    case 'command_execution': return `$ ${firstLine(shellInner(item.command))}`;
    case 'file_change': {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const kinds = new Set(changes.map(c => c.kind));
      const verb = kinds.size === 1 ? ({ add: 'write', delete: 'delete', update: 'edit' })[[...kinds][0]] || 'edit' : 'edit';
      return `${verb} ${changes.map(c => baseName(c.path)).filter(Boolean).slice(0, 4).join(', ')}`;
    }
    case 'web_search': return `search: ${item.query || ''}`;
    case 'mcp_tool_call': return `tool: ${item.server || ''}.${item.tool || ''}`;
    case 'collab_tool_call': return `agent: ${item.tool || ''}`;
    default: return null;
  }
}

function codexParser() {
  let last = null; // the newest agent_message: Codex's final answer is the last one of the turn
  const shown = new Set(); // item ids already announced when they started
  return {
    feed(ev) {
      const out = empty();
      const item = ev.item;
      if (ev.type === 'thread.started') {
        if (ev.thread_id) out.session = ev.thread_id;
      } else if (ev.type === 'item.started' && item) {
        const line = codexItemLine(item);
        if (line) { out.progress.push(line); shown.add(item.id); }
      } else if (ev.type === 'item.completed' && item) {
        if (item.type === 'agent_message') {
          last = String(item.text || '');
          if (last.trim()) out.progress.push(snippet(last));
        } else if (item.type === 'reasoning') {
          if (item.text && item.text.trim()) out.progress.push('~ ' + snippet(item.text));
        } else if (item.type === 'error') {
          if (item.message) out.notes.push(String(item.message));
        } else {
          const line = codexItemLine(item);
          if (line && !shown.has(item.id)) out.progress.push(line);
          if (item.type === 'command_execution' && item.status === 'declined') {
            out.notes.push(`Codex was not allowed to run: ${firstLine(shellInner(item.command))}\nRaise "permissionMode" for codex in bridge/config.json (acceptEdits lets it edit the project, bypassPermissions lifts the sandbox) if it should have been.`);
          }
        }
      } else if (ev.type === 'turn.completed') {
        // ev.usage ({ input_tokens, cached_input_tokens, output_tokens }) is
        // here too, but whether it is the last call or the turn's sum is not
        // verified against a real Codex, so no context size is reported for it.
        out.done = { text: last ?? '', error: false };
      } else if (ev.type === 'turn.failed') {
        out.done = { text: (ev.error && ev.error.message) || 'Codex: the turn failed', error: true };
      } else if (ev.type === 'error') {
        out.done = { text: ev.message || 'Codex reported an error', error: true };
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// Grok
// ---------------------------------------------------------------------------

// Grok's built-in tools (Grok Build 1.0.41: run_terminal_command, read_file,
// write, search_replace, list_dir, grep, web_search, web_fetch, todo_write,
// spawn_subagent, ...) by what they do; anything else falls back to the ACP
// `kind` on the call, then to its name.
const GROK_TOOL_KIND = {
  run_terminal_command: 'execute', read_file: 'read', list_dir: 'list', write: 'edit', search_replace: 'edit',
  grep: 'search', web_search: 'websearch', web_fetch: 'fetch', todo_write: 'think', spawn_subagent: 'agent',
};

// A Grok tool_call as a progress line plus the Claude-syntax rule that would
// allow it, if it is one of the tools rules can name.
function grokCall(ev) {
  const name = String(ev.toolName || ev.title || '').toLowerCase();
  const kind = String(ev.kind || '').toLowerCase();
  const input = ev.rawInput && typeof ev.rawInput === 'object' ? ev.rawInput : {};
  const file = () => baseName(input.target_file || input.file_path || input.path || input.file || input.filename || input.target_directory);
  let k = GROK_TOOL_KIND[name];
  if (!k) {
    if (/subagent|scheduler|monitor|workflow|use_tool|search_tool|ask_user|feedback|plan_mode|image|video/.test(name)) k = 'other';
    else if (['execute', 'read', 'edit', 'write', 'delete', 'move', 'search', 'fetch', 'think'].includes(kind)) k = kind === 'write' ? 'edit' : kind;
    else if (/bash|shell|terminal/.test(name)) k = 'execute';
    else if (/web_?search/.test(name)) k = 'websearch';
    else if (/web_?fetch/.test(name)) k = 'fetch';
    else if (/read|view|cat/.test(name)) k = 'read';
    else if (/edit|write|create|replace|patch|apply/.test(name)) k = 'edit';
    else if (/grep|search|glob|find/.test(name)) k = 'search';
    else k = 'other';
  }
  switch (k) {
    case 'execute': {
      const cmd = firstLine(input.command || input.cmd || input.script || '') || firstLine(ev.title || '');
      return { line: `$ ${cmd}`, rule: ruleFor({ tool_name: 'Bash', tool_input: { command: cmd } }) };
    }
    case 'read': return { line: `read ${file()}`, rule: 'Read' };
    case 'list': return { line: `ls ${file() || '.'}`, rule: 'Read' };
    case 'edit': case 'delete': case 'move': return { line: `edit ${file()}`, rule: 'Edit' };
    case 'search': return { line: `grep ${input.pattern || input.query || input.regex || ''}`, rule: 'Grep' };
    case 'websearch': return { line: `search: ${input.query || input.q || ''}`, rule: 'WebSearch' };
    case 'fetch': return { line: `fetch ${input.url || ''}`, rule: 'WebFetch' };
    case 'think': return { line: 'todo list', rule: null };
    case 'agent': return { line: `agent: ${snippet(input.description || input.prompt || input.task || '')}`.trim(), rule: null };
    default: return { line: String(ev.title || ev.toolName || name || 'tool'), rule: null };
  }
}

// The text in a tool_call_update's content blocks: Grok nests them as
// {type:"content",content:{type:"text",text}}, ACP also allows {type:"text",text}.
function grokUpdateText(ev) {
  const parts = [];
  for (const b of Array.isArray(ev.content) ? ev.content : []) {
    if (!b || typeof b !== 'object') continue;
    if (typeof b.text === 'string') parts.push(b.text);
    else if (b.content && typeof b.content.text === 'string') parts.push(b.content.text);
  }
  return parts.join('\n');
}

// Why a call was refused, or null when the update is progress or an ordinary
// failure. Grok Build 1.0.41 marks a refusal `failed` with a line such as
// "Tool `run_terminal_command` was not executed: Denied by permission policy: …"
// or "…: Auto mode blocked this action (…)".
function grokRefusal(ev) {
  const status = String(ev.status || '');
  const text = grokUpdateText(ev);
  if (/denied|rejected|refused/i.test(status)) return text.trim() || status;
  const m = /was not executed:\s*([\s\S]*)/i.exec(text);
  if (m) return m[1].trim();
  if (/^(failed|error)$/i.test(status) && /denied by permission|blocked this action|permission (policy|denied)/i.test(text)) return text.trim();
  return null;
}

function grokParser() {
  let text = '';      // the text segment being streamed (chunks under `data`)
  let lastText = '';  // the last finished segment, for a turn that ends on a tool call
  let thought = '';   // buffered thought chunks, shown as one line when something else arrives
  const calls = new Map(); // toolCallId -> { line, rule }
  const flushThought = (out) => { if (thought.trim()) out.progress.push('~ ' + snippet(thought)); thought = ''; };
  const flushText = (out) => { if (text.trim()) { lastText = text; out.progress.push(snippet(text)); } text = ''; };
  const chunk = (ev) => typeof ev.data === 'string' ? ev.data : (ev.data && typeof ev.data.text === 'string') ? ev.data.text : typeof ev.text === 'string' ? ev.text : '';
  return {
    feed(ev) {
      const out = empty();
      switch (ev.type) {
        case 'text': flushThought(out); text += chunk(ev); break;
        case 'thought': if (text) flushText(out); thought += chunk(ev); break;
        case 'tool_call': {
          flushThought(out); flushText(out);
          const c = grokCall(ev);
          calls.set(String(ev.toolCallId || ''), c);
          out.progress.push(c.line);
          break;
        }
        case 'tool_call_update': {
          const why = grokRefusal(ev);
          if (why !== null) {
            const c = calls.get(String(ev.toolCallId || ''));
            if (c && c.rule) {
              out.denied.push(c.rule);
              out.notes.push(`Grok was not allowed to: ${c.line}\n${snippet(why).replace(/\.\.\.$/, '')}\nUse the Allow button below to permit it and let it continue.`);
            }
          }
          break;
        }
        case 'end': {
          flushThought(out);
          const final = text.trim() ? text : lastText;
          text = '';
          if (ev.sessionId) out.session = ev.sessionId;
          else if (ev.session_id) out.session = ev.session_id;
          const reason = String(ev.stopReason || '');
          if (reason && !/^(end_turn|stop|completed|cancelled)$/.test(reason)) out.notes.push(`Grok stopped early: ${reason}`);
          out.done = { text: final.trim(), error: false };
          break;
        }
        case 'error': {
          flushThought(out);
          const msg = ev.message || ev.error || (typeof ev.data === 'string' ? ev.data : '') || 'Grok reported an error';
          out.done = { text: String(typeof msg === 'object' ? JSON.stringify(msg) : msg), error: true };
          break;
        }
        default: break; // usage, plan, available_commands, and whatever a newer Grok adds
      }
      return out;
    },
  };
}

function agyParser() {
  let response = '';
  return {
    feed(ev) {
      const out = empty();
      if (ev.event === 'init' && ev.conversation_id) out.session = ev.conversation_id;
      if (ev.event === 'step_update' && ev.step_update) {
        const step = ev.step_update;
        if (step.step_type === 'tool' && step.state === 'ACTIVE') {
          const params = (step.tool_info && step.tool_info.parameters) || {};
          const name = step.tool_name || '';
          const file = params.AbsolutePath || params.TargetFile || params.file_path || params.path || '';
          const base = file ? baseName(file) : '';
          const commands = {
            view_file: `read ${base}`, write_to_file: `edit ${base}`, replace_file_content: `edit ${base}`,
            multi_replace_file_content: `edit ${base}`, sed_file: `edit ${base}`,
            run_command: `$ ${params.CommandLine || ''}`, grep_search: `grep: ${params.Query || ''}`,
            list_dir: `ls ${base || params.DirectoryPath || ''}`, search_web: `search: ${params.query || params.Query || ''}`,
            read_url_content: `fetch ${params.url || params.Url || ''}`,
          };
          if (commands[name]) out.progress.push(commands[name]);
          else if (name) out.progress.push(name);
        } else if (step.step_type === 'agent_response' && step.text_delta) {
          response += step.text_delta;
        }
      } else if (ev.event === 'result') {
        const result = ev.result || {};
        if (result.conversation_id) out.session = result.conversation_id;
        const ok = result.status === 'SUCCESS';
        out.done = { text: String(result.response || response), error: !ok };
        if (!ok) out.notes.push(`agy status: ${result.status || 'unknown'}`);
      }
      return out;
    },
  };
}

function hermesParser() {
  return {
    feed() { return empty(); },
    finish({ stdout, stderr, code }) {
      const err = String(stderr || '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
      const session = /session_id:\s*(\S+)/i.exec(err);
      let text = String(stdout || '').trim();
      if (!text && code !== 0) text = err.replace(/^.*session_id:.*$/gim, '').trim().slice(-2000);
      return { session: session ? session[1] : '', done: { text, error: code !== 0 } };
    },
  };
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

// The "system prompt" is the stable part: the reply rules, the game rules and
// the addon primer (protocol.systemPrompt; the player's situation rides in the
// prompt itself, protocol.messagePrompt). Claude and Grok take it as a real
// system prompt; Codex has no such flag, so it rides at the top of the prompt,
// marked as context, in full for a new session and as the short version
// without the primer on a resumed one (the primer is already in the thread).
function contextBlock(text) {
  return `[Context from the Claude WoW bridge, not written by the user]\n${text}\n[End of context]\n\n`;
}

// Images (vision): bridge.js hands each run `images`, a list of
// { file, data (base64), mediaType, width, height } for the game view it cut
// out of the screenshot. Claude takes the pixels inline: with
// `--input-format stream-json` the prompt goes in as one JSON user message
// whose content holds an Anthropic `image` block next to the text (verified on
// Claude Code 2.1: the model sees the picture with no tool call at all). The
// other CLIs take a path: Codex `-i`, Hermes `--image`, Grok reads it with its
// own file tool from the note in the prompt. A bare string is a path too.
function imagePaths(images) {
  return (Array.isArray(images) ? images : []).map(i => (typeof i === 'string' ? i : i && i.file)).filter(Boolean);
}
function attachedNote(images) {
  const paths = imagePaths(images);
  return paths.length ? `\n\nAttached screenshots: ${paths.join(', ')} — read them with your Read tool.` : '';
}
// The line next to the image in the message itself. Claude Code records the
// system prompt of a conversation's first request and resumes with that record
// (--system-prompt-snapshot), so nothing about this message's picture goes
// there: the caption rides with the picture, where it cannot be missed, and
// the fuller vision paragraph is in the prompt (protocol.messagePrompt).
const IMAGE_CAPTION = '[The image above is a screenshot of the player\'s screen, taken the moment they sent this message.]';

const READ_ONLY_MODES = new Set(['default', 'manual', 'plan']);

function addDirs(cfg) {
  return (Array.isArray(cfg && cfg.addDirs) ? cfg.addDirs : []).map(String).filter(d => d && !d.startsWith('-'));
}

const AGENTS = {
  claude: {
    name: 'Claude',
    command: 'claude',
    settings: ['model', 'effort', 'permissionMode', 'addDirs'],
    install: 'https://claude.com/claude-code, then run `claude` once and log in',
    windowsPaths: () => [path.join(os.homedir(), '.local', 'bin', 'claude.exe')],
    posixPaths: () => [path.join(os.homedir(), '.local', 'bin', 'claude')],
    args({ cfg, resume, system, images }) {
      const a = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', cfg.permissionMode || 'acceptEdits'];
      // With an image the prompt is a stream-json user message (see input below).
      if (Array.isArray(images) && images.some(i => i && i.data)) a.push('--input-format', 'stream-json');
      const rules = Array.isArray(cfg.allowedTools) ? cfg.allowedTools.filter(Boolean) : [];
      if (rules.length) a.push('--allowedTools', ...rules);
      const denied = Array.isArray(cfg.deniedTools) ? cfg.deniedTools.filter(Boolean) : [];
      if (denied.length) a.push('--disallowedTools', ...denied);
      if (cfg.model) a.push('--model', cfg.model);
      if (cfg.effort) a.push('--effort', cfg.effort);
      for (const dir of addDirs(cfg)) a.push('--add-dir', dir);
      if (resume) a.push('--resume', resume);
      if (system) a.push('--append-system-prompt', system);
      return a.concat(Array.isArray(cfg.extraArgs) ? cfg.extraArgs : []);
    },
    input: ({ prompt, images }) => {
      const inline = (Array.isArray(images) ? images : []).filter(i => i && typeof i === 'object' && i.data);
      if (!inline.length) return { stdin: prompt + attachedNote(images) };
      const content = inline.map(i => ({ type: 'image', source: { type: 'base64', media_type: i.mediaType || 'image/png', data: i.data } }));
      content.push({ type: 'text', text: `${IMAGE_CAPTION}\n\n${prompt}` });
      return { stdin: JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n' };
    },
    env: (env) => { delete env.CLAUDECODE; return env; }, // a bridge started from inside Claude Code can still launch it
    parser: claudeParser,
  },
  codex: {
    name: 'Codex',
    command: 'codex',
    settings: ['model', 'effort', 'permissionMode', 'addDirs'],
    install: 'npm install -g @openai/codex, then run `codex` once and log in',
    windowsPaths: () => [],
    posixPaths: () => [],
    envPath: 'CODEX_BIN',
    npmPackage: '@openai/codex',
    args({ cfg, resume, cwd, images }) {
      const a = [];
      if (cfg.networkAccess) a.push('-c', 'sandbox_workspace_write.network_access=true');
      a.push('exec', '--json', '--skip-git-repo-check', '-C', cwd);
      const mode = cfg.permissionMode || 'acceptEdits';
      if (mode === 'bypassPermissions') a.push('--dangerously-bypass-approvals-and-sandbox');
      else a.push('--sandbox', READ_ONLY_MODES.has(mode) ? 'read-only' : 'workspace-write');
      if (cfg.model) a.push('-m', cfg.model);
      if (cfg.effort) a.push('-c', `model_reasoning_effort=${cfg.effort}`);
      for (const dir of addDirs(cfg)) a.push('--add-dir', dir);
      a.push(...(Array.isArray(cfg.extraArgs) ? cfg.extraArgs : []));
      if (resume) a.push('resume', resume);
      for (const image of imagePaths(images)) if (!String(image).startsWith('-')) a.push('-i', image);
      a.push('-'); // the prompt comes on stdin
      return a;
    },
    input: ({ prompt, system, systemShort, resume, images }) => {
      const ctx = resume ? systemShort : system;
      return { stdin: (ctx ? contextBlock(ctx) : '') + prompt + attachedNote(images) };
    },
    env: (env) => env,
    parser: codexParser,
  },
  grok: {
    name: 'Grok',
    command: 'grok',
    settings: ['model', 'permissionMode'],
    install: 'https://docs.x.ai/build (irm https://x.ai/cli/install.ps1 | iex), then `grok login`',
    windowsPaths: () => [
      path.join(process.env.GROK_HOME || path.join(os.homedir(), '.grok'), 'bin', 'grok.exe'),
    ],
    posixPaths: () => [path.join(process.env.GROK_HOME || path.join(os.homedir(), '.grok'), 'bin', 'grok')],
    npmPackage: '@xai-official/grok',
    args({ cfg, resume, cwd, system, promptFile }) {
      const a = ['--no-auto-update', '--output-format', 'streaming-json', '--cwd', cwd, '--prompt-file', promptFile];
      const mode = cfg.permissionMode || 'acceptEdits';
      if (mode === 'bypassPermissions') {
        a.push('--always-approve');
      } else {
        // Headless Grok can't ask, so anything not on the allowlist is denied.
        a.push('--permission-mode', 'dontAsk');
        const rules = mode === 'acceptEdits' ? ['Edit', 'Read', 'Grep'] : [];
        for (const r of (Array.isArray(cfg.allowedTools) ? cfg.allowedTools : [])) rules.push(...grokRules(r));
        for (const r of new Set(rules)) a.push('--allow', r);
      }
      // Deny rules win over everything, always-approve included.
      const denied = [];
      for (const r of (Array.isArray(cfg.deniedTools) ? cfg.deniedTools : [])) denied.push(...grokRules(r));
      for (const r of new Set(denied)) a.push('--deny', r);
      if (cfg.model) a.push('-m', cfg.model);
      if (resume) a.push('-r', resume);
      if (system) a.push('--append-system-prompt', system);
      return a.concat(Array.isArray(cfg.extraArgs) ? cfg.extraArgs : []);
    },
    input: ({ prompt, images }) => ({ promptFile: prompt + attachedNote(images) }),
    env: (env) => { env.GROK_DISABLE_AUTOUPDATER = '1'; return env; },
    parser: grokParser,
  },
  agy: {
    name: 'Antigravity', command: 'agy',
    settings: ['model', 'permissionMode', 'addDirs'],
    install: 'Install Google Antigravity CLI (agy) and run `agy` once to log in.',
    windowsPaths: () => [path.join(process.env.LOCALAPPDATA || '', 'agy', 'bin', 'agy.exe')],
    posixPaths: () => [],
    args({ cfg, resume, cwd, prompt, system, systemShort, timeoutMs }) {
      const text = String(prompt || '');
      const note = '\n[User prompt truncated to fit the agy command line.]';
      const context = contextBlock(resume ? systemShort || '' : system || '').slice(0, 12000);
      const available = Math.max(0, 24000 - context.length - note.length);
      const bounded = text.length > available ? text.slice(0, available) + note : text;
      const a = [`-p=${context}${bounded}`, '--output-format', 'stream-json', '--add-dir', cwd,
        '--print-timeout', `${Math.max(1, Math.ceil((timeoutMs || 1800000) / 1000))}s`];
      const mode = cfg.permissionMode || 'acceptEdits';
      if (mode === 'acceptEdits') a.push('--mode', 'accept-edits', '--disable-slash-commands');
      else if (READ_ONLY_MODES.has(mode)) a.push('--mode', 'plan');
      else a.push('--dangerously-skip-permissions', '--disable-slash-commands');
      for (const dir of addDirs(cfg)) a.push('--add-dir', dir);
      if (resume) a.push('--conversation', resume);
      if (cfg.model) a.push('--model', cfg.model);
      return a.concat(Array.isArray(cfg.extraArgs) ? cfg.extraArgs : []);
    },
    input: () => ({}), env: env => env, parser: agyParser,
  },
  hermes: {
    name: 'Hermes', command: 'hermes',
    settings: ['model'],
    install: 'Install Hermes Agent and run `hermes setup` once.',
    windowsPaths: () => [], posixPaths: () => [],
    stream: 'text',
    args({ cfg, resume, cwd, images }) {
      const a = ['chat', '--query-file', '-', '-Q', '--in', cwd, '--source', 'tool'];
      if (resume) a.push('--resume', resume);
      if (cfg.model) a.push('-m', cfg.model);
      const paths = imagePaths(images);
      if (paths.length && !String(paths[0]).startsWith('-')) a.push('--image', paths[0]);
      // R1: hermes never runs with --yolo from the bridge, even via extraArgs.
      return a.concat(Array.isArray(cfg.extraArgs) ? cfg.extraArgs.filter(x => !/^(-y|--yolo)(=.*)?$/.test(String(x))) : []);
    },
    input: ({ prompt, system, systemShort, resume, images, cfg }) => {
      const ctx = resume ? systemShort : system;
      let text = (ctx ? contextBlock(ctx) : '') + prompt;
      const paths = imagePaths(images);
      if (paths.length > 1) text += `\n\nAdditional attached screenshot paths: ${paths.slice(1).join(', ')}`;
      const note = cfg && cfg.permissionMode === 'bypassPermissions' ? 'hermes never runs with --yolo from the bridge' : '';
      return { stdin: text, note };
    },
    env: env => env, parser: hermesParser,
  },
};

const DEFAULT_AGENT = 'claude';

const SETTING_FLAGS = { model: '--model', effort: '--effort', permissionMode: '--permission-mode', addDirs: '--add-dir' };

function unsupportedSettings(id, chosen) {
  const agent = AGENTS[id];
  if (!agent || !chosen) return [];
  const out = [];
  for (const key of Object.keys(SETTING_FLAGS)) {
    const v = chosen[key];
    const set = Array.isArray(v) ? v.length > 0 : !!v;
    if (set && !agent.settings.includes(key)) out.push(`${SETTING_FLAGS[key]} ${Array.isArray(v) ? v.join(' ') : v}`);
  }
  return out;
}

function withChatSettings(agentCfg, id, chosen) {
  const agent = AGENTS[id];
  if (!agent || !chosen) return agentCfg;
  const out = { ...agentCfg };
  for (const key of agent.settings) {
    const v = chosen[key];
    if (Array.isArray(v) ? v.length : v) out[key] = v;
  }
  return out;
}

function agentIds() { return Object.keys(AGENTS); }

// The agent id a config value or strip flag names, or null when it is unknown.
function normalizeAgent(id) {
  const s = String(id || '').trim().toLowerCase();
  return AGENTS[s] ? s : null;
}

function displayName(id) {
  const a = AGENTS[String(id || '').toLowerCase()];
  return a ? a.name : String(id || 'AI');
}

// An agent's block of config.json. Before agents existed, Claude's settings sat
// at the top level (claudePath, model, permissionMode, allowedTools); those are
// still read, under anything in agents.claude.
function agentConfig(cfg, id) {
  const own = (cfg && cfg.agents && cfg.agents[id]) || {};
  if (id !== 'claude') return { ...own };
  const legacy = {};
  if (cfg && cfg.claudePath) legacy.path = cfg.claudePath;
  if (cfg && cfg.model) legacy.model = cfg.model;
  if (cfg && cfg.permissionMode) legacy.permissionMode = cfg.permissionMode;
  if (cfg && Array.isArray(cfg.allowedTools)) legacy.allowedTools = cfg.allowedTools;
  return { ...legacy, ...own };
}

// ---------------------------------------------------------------------------
// Finding the executable
// ---------------------------------------------------------------------------

function exists(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }

function pathDirs() {
  const sep = process.platform === 'win32' ? ';' : ':';
  const dirs = String(process.env.PATH || '').split(sep).filter(Boolean);
  if (process.platform === 'win32' && process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'npm'));
  return dirs;
}

// A JavaScript launcher (npm's codex.js, a configured .js path) is run with a
// node: this one from a checkout, the one on the PATH from the compiled binary
// (runtime.js), which cannot run a script of somebody else's.
function withNode(script) {
  const n = R.node();
  const r = { file: n.file, args: [script], found: n.found && exists(script) };
  if (!n.found) r.note = n.note;
  return r;
}

// A configured path: a script is run with a node, anything else directly.
function fromPath(p) {
  if (/\.(c|m)?js$/i.test(p)) return withNode(p);
  return { file: p, args: [], found: exists(p) };
}

// npm's Windows launchers are .cmd files that Node can't spawn directly (and
// cmd.exe would mangle a system prompt with % in it). Read the script path out
// of the shim and run it with this node; for packages that ship a native
// binary next to it, run that instead so the process tree stays one deep.
function unwrapShim(shim, agent) {
  let src;
  try { src = fs.readFileSync(shim, 'utf8'); } catch { return null; }
  // npm shims mention "%dp0%\node.exe" before the launcher: skip it. The launcher
  // is a .js file (Codex), a .exe (Claude) or a shebang script with no extension (Grok).
  const m = [...src.matchAll(/"%~?dp0%?\\([^"]+)"/g)].find(x => !/(^|\\)node\.exe$/i.test(x[1]));
  if (!m) return null;
  const script = path.resolve(path.dirname(shim), m[1].split('\\').join(path.sep));
  if (!exists(script)) return null;
  for (const exe of nativeNextTo(script, agent)) if (exists(exe)) return { file: exe, args: [], found: true };
  if (/\.exe$/i.test(script)) return { file: script, args: [], found: true };
  return withNode(script);
}

// Where a package's platform binary would be, relative to its launcher script.
function nativeNextTo(script, agent) {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const triple = process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
  const pkg = path.resolve(path.dirname(script), '..'); // node_modules/@scope/name
  const scope = path.dirname(pkg);
  if (agent.npmPackage === '@openai/codex') {
    return [
      path.join(scope, `codex-win32-${arch}`, 'vendor', triple, 'bin', 'codex.exe'),
      path.join(pkg, 'vendor', triple, 'bin', 'codex.exe'),
      path.join(pkg, 'vendor', triple, 'codex', 'codex.exe'),
    ];
  }
  if (agent.npmPackage === '@xai-official/grok') {
    return [path.join(scope, `grok-win32-${arch}`, 'bin', 'grok.exe')];
  }
  return [];
}

// { file, args, found, note }: what to spawn for an agent, and whether it is there.
function resolveCommand(id, cfg = {}) {
  const A = AGENTS[id];
  if (!A) return { file: id, args: [], found: false, note: `unknown agent "${id}"` };
  if (cfg.path) {
    if (/\.(cmd|bat)$/i.test(cfg.path)) {
      const r = unwrapShim(cfg.path, A);
      if (r) return r;
      return { file: cfg.path, args: [], found: false, note: `agents.${id}.path in config.json points at ${cfg.path}, which could not be unwrapped` };
    }
    const r = fromPath(cfg.path);
    if (!r.found) r.note = `agents.${id}.path in config.json points at ${cfg.path}, which does not exist`;
    return r;
  }
  if (A.envPath && process.env[A.envPath]) {
    const p = process.env[A.envPath];
    const r = /\.(cmd|bat)$/i.test(p) ? unwrapShim(p, A) : fromPath(p);
    if (r && r.found) return r;
  }
  if (process.platform !== 'win32') {
    for (const p of A.posixPaths()) if (exists(p)) return { file: p, args: [], found: true };
    const found = pathDirs().some(d => exists(path.join(d, A.command)));
    return { file: A.command, args: [], found, note: found ? '' : `install it (${A.install}) or set agents.${id}.path in config.json` };
  }
  for (const p of A.windowsPaths()) if (exists(p)) return { file: p, args: [], found: true };
  const dirs = pathDirs();
  for (const d of dirs) { const exe = path.join(d, A.command + '.exe'); if (exists(exe)) return { file: exe, args: [], found: true }; }
  for (const d of dirs) {
    const shim = path.join(d, A.command + '.cmd');
    if (exists(shim)) { const r = unwrapShim(shim, A); if (r) return r; }
  }
  return { file: A.command + '.exe', args: [], found: false, note: `install it (${A.install}) or set agents.${id}.path in config.json` };
}

module.exports = {
  AGENTS, DEFAULT_AGENT, SETTING_FLAGS, READ_ONLY_MODES, unsupportedSettings, withChatSettings, addDirs, agentIds, normalizeAgent, displayName, agentConfig,
  grokRules, snippet, contextBlock, imagePaths, IMAGE_CAPTION,
  claudeParser, codexParser, grokParser, agyParser, hermesParser, codexItemLine, grokCall, grokRefusal, shellInner, claudeUsage, claudeWindow, claudeCost, claudeRate, CLAUDE_RATES,
  resolveCommand, unwrapShim, nativeNextTo,
};
