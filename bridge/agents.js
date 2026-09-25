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
const { describeToolUse, ruleFor, baseName } = require('./protocol');

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
// appends to the reply; done: the reply itself, once the run has produced it.
function empty() { return { progress: [], denied: [], notes: [] }; }

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

function claudeParser() {
  return {
    feed(ev) {
      const out = empty();
      if (ev.session_id) out.session = ev.session_id;
      if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
        for (const block of ev.message.content) {
          if (block.type === 'tool_use') out.progress.push(describeToolUse(block));
          else if (block.type === 'text' && block.text && block.text.trim()) out.progress.push(snippet(block.text));
        }
      } else if (ev.type === 'result') {
        const text = typeof ev.result === 'string' ? ev.result : JSON.stringify(ev.result ?? '', null, 2);
        const denials = Array.isArray(ev.permission_denials) ? ev.permission_denials : [];
        if (denials.length) {
          out.denied = [...new Set(denials.map(ruleFor))];
          const list = denials.map(d => d.tool_name + (d.tool_input && d.tool_input.command ? ': ' + d.tool_input.command : '')).join('\n  ');
          out.notes.push(`Claude needed ${denials.length} action(s) that aren't allowed yet:\n  ${list}\nUse the Allow button below to permit them and let it continue.`);
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

// The "system prompt" is the game context and the addon primer. Claude and Grok
// take it as a real system prompt; Codex has no such flag, so it rides at the
// top of the prompt, marked as context, in full for a new session and as the
// short context-only version on a resumed one (the primer is already in the
// thread).
function contextBlock(text) {
  return `[Context from the WoW AI bridge, not written by the user]\n${text}\n[End of context]\n\n`;
}

const AGENTS = {
  claude: {
    name: 'Claude',
    command: 'claude',
    install: 'https://claude.com/claude-code, then run `claude` once and log in',
    windowsPaths: () => [path.join(os.homedir(), '.local', 'bin', 'claude.exe')],
    posixPaths: () => [path.join(os.homedir(), '.local', 'bin', 'claude')],
    args({ cfg, resume, system }) {
      const a = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', cfg.permissionMode || 'acceptEdits'];
      const rules = Array.isArray(cfg.allowedTools) ? cfg.allowedTools.filter(Boolean) : [];
      if (rules.length) a.push('--allowedTools', ...rules);
      const denied = Array.isArray(cfg.deniedTools) ? cfg.deniedTools.filter(Boolean) : [];
      if (denied.length) a.push('--disallowedTools', ...denied);
      if (cfg.model) a.push('--model', cfg.model);
      if (resume) a.push('--resume', resume);
      if (system) a.push('--append-system-prompt', system);
      return a.concat(Array.isArray(cfg.extraArgs) ? cfg.extraArgs : []);
    },
    input: ({ prompt, images }) => {
      const attached = images && images.length ? `\n\nAttached screenshots: ${images.join(', ')} — read them with your Read tool` : '';
      return { stdin: prompt + attached };
    },
    env: (env) => { delete env.CLAUDECODE; return env; }, // a bridge started from inside Claude Code can still launch it
    parser: claudeParser,
  },
  codex: {
    name: 'Codex',
    command: 'codex',
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
      else a.push('--sandbox', mode === 'default' ? 'read-only' : 'workspace-write');
      if (cfg.model) a.push('-m', cfg.model);
      a.push(...(Array.isArray(cfg.extraArgs) ? cfg.extraArgs : []));
      if (resume) a.push('resume', resume);
      for (const image of images || []) if (!String(image).startsWith('-')) a.push('-i', image);
      a.push('-'); // the prompt comes on stdin
      return a;
    },
    input: ({ prompt, system, systemShort, resume, images }) => {
      const ctx = resume ? systemShort : system;
      const attached = images && images.length ? `\n\nAttached screenshots: ${images.join(', ')} — read them with your Read tool.` : '';
      return { stdin: (ctx ? contextBlock(ctx) : '') + prompt + attached };
    },
    env: (env) => env,
    parser: codexParser,
  },
  grok: {
    name: 'Grok',
    command: 'grok',
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
    input: ({ prompt, images }) => {
      const attached = images && images.length ? `\n\nAttached screenshots: ${images.join(', ')} — read them with your Read tool.` : '';
      return { promptFile: prompt + attached };
    },
    env: (env) => { env.GROK_DISABLE_AUTOUPDATER = '1'; return env; },
    parser: grokParser,
  },
  agy: {
    name: 'Antigravity', command: 'agy',
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
      else if (mode === 'default') a.push('--mode', 'plan');
      else a.push('--dangerously-skip-permissions', '--disable-slash-commands');
      if (resume) a.push('--conversation', resume);
      if (cfg.model) a.push('--model', cfg.model);
      return a.concat(Array.isArray(cfg.extraArgs) ? cfg.extraArgs : []);
    },
    input: () => ({}), env: env => env, parser: agyParser,
  },
  hermes: {
    name: 'Hermes', command: 'hermes',
    install: 'Install Hermes Agent and run `hermes setup` once.',
    windowsPaths: () => [], posixPaths: () => [],
    stream: 'text',
    args({ cfg, resume, cwd, images }) {
      const a = ['chat', '--query-file', '-', '-Q', '--in', cwd, '--source', 'tool'];
      if (resume) a.push('--resume', resume);
      if (cfg.model) a.push('-m', cfg.model);
      if (images && images.length && !String(images[0]).startsWith('-')) a.push('--image', images[0]);
      // R1: hermes never runs with --yolo from the bridge, even via extraArgs.
      return a.concat(Array.isArray(cfg.extraArgs) ? cfg.extraArgs.filter(x => !/^(-y|--yolo)(=.*)?$/.test(String(x))) : []);
    },
    input: ({ prompt, system, systemShort, resume, images, cfg }) => {
      const ctx = resume ? systemShort : system;
      let text = (ctx ? contextBlock(ctx) : '') + prompt;
      if (images && images.length > 1) text += `\n\nAdditional attached screenshot paths: ${images.slice(1).join(', ')}`;
      const note = cfg && cfg.permissionMode === 'bypassPermissions' ? 'hermes never runs with --yolo from the bridge' : '';
      return { stdin: text, note };
    },
    env: env => env, parser: hermesParser,
  },
};

const DEFAULT_AGENT = 'claude';

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

// A configured path: a script is run with this node, anything else directly.
function fromPath(p) {
  if (/\.(c|m)?js$/i.test(p)) return { file: process.execPath, args: [p], found: exists(p) };
  return { file: p, args: [], found: exists(p) };
}

// npm's Windows launchers are .cmd files that Node can't spawn directly (and
// cmd.exe would mangle a system prompt with % in it). Read the script path out
// of the shim and run it with this node; for packages that ship a native
// binary next to it, run that instead so the process tree stays one deep.
function unwrapShim(shim, agent) {
  let src;
  try { src = fs.readFileSync(shim, 'utf8'); } catch { return null; }
  // npm shims also mention "%dp0%\node.exe"; the launcher is the .js one.
  const m = [...src.matchAll(/"%~?dp0%?\\([^"]+)"/g)].find(x => /\.[cm]?js$/i.test(x[1]));
  if (!m) return null;
  const script = path.resolve(path.dirname(shim), m[1].split('\\').join(path.sep));
  if (!exists(script)) return null;
  for (const exe of nativeNextTo(script, agent)) if (exists(exe)) return { file: exe, args: [], found: true };
  return { file: process.execPath, args: [script], found: true };
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
  AGENTS, DEFAULT_AGENT, agentIds, normalizeAgent, displayName, agentConfig,
  grokRules, snippet, contextBlock,
  claudeParser, codexParser, grokParser, agyParser, hermesParser, codexItemLine, grokCall, grokRefusal, shellInner,
  resolveCommand, unwrapShim, nativeNextTo,
};
