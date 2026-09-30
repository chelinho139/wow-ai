'use strict';
const PR = require('./procs');

const DEFAULT_TITLE_MODEL = 'claude-haiku-4-5';
const TITLE_MAX = 32;
const TITLE_INPUT_MAX = 2000;
const TITLE_TIMEOUT_MS = 30000;
const TITLE_SYSTEM = 'You name chat threads. Reply with only a title of 2 to 5 words for the conversation that starts with the user\'s message. Use title case. No quotes, no emoji, no trailing punctuation, nothing else.';

function titleModel(cfg) {
  if (cfg && cfg.titleModel === false) return '';
  if (cfg && typeof cfg.titleModel === 'string') return cfg.titleModel.trim();
  return DEFAULT_TITLE_MODEL;
}

function titleArgs(model, text) {
  return ['-p', '--model', model, '--output-format', 'text', '--tools', '', '--no-session-persistence',
    '--strict-mcp-config', '--setting-sources', '', '--system-prompt', TITLE_SYSTEM,
    String(text || '').slice(0, TITLE_INPUT_MAX)];
}

function cleanTitle(raw) {
  const line = String(raw || '').split(/\r?\n/).map(s => s.trim()).find(Boolean) || '';
  let t = line.replace(/^(title|thread)\s*:\s*/i, '').replace(/^["'`*_\s]+|["'`*_\s.!?:;,]+$/g, '').replace(/\s+/g, ' ').trim();
  if (t.length > TITLE_MAX) t = t.slice(0, TITLE_MAX).replace(/\s+\S*$/, '').trim();
  return t;
}

function generateTitle({ file, args = [], model, text, cwd, env, timeoutMs = TITLE_TIMEOUT_MS }) {
  return new Promise(resolve => {
    let out = '';
    let done = false;
    let child;
    const end = (title) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(title);
    };
    const timer = setTimeout(() => { if (child) PR.killTree(child); end(''); }, timeoutMs);
    try {
      child = PR.spawnChild(file, [...args, ...titleArgs(model, text)], { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { end(''); return; }
    child.stdout.on('data', d => { out += d; });
    child.on('error', () => end(''));
    child.on('close', code => end(code === 0 ? cleanTitle(out) : ''));
  });
}

module.exports = { DEFAULT_TITLE_MODEL, TITLE_MAX, titleModel, titleArgs, cleanTitle, generateTitle };
