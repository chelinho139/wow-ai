'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REF_RE = /^[A-Za-z0-9._-]{1,80}$/;
const MIN_PREFIX = 4;
const HISTORY_TAIL_BYTES = 262144;
const TITLE_TAIL_BYTES = 65536;
const CWD_HEAD_BYTES = 65536;
const NAME_MAX = 60;

function claudeDir(env = process.env, configured = '') {
  if (configured) return path.resolve(String(configured));
  if (env.CLAUDE_CONFIG_DIR) return path.resolve(env.CLAUDE_CONFIG_DIR);
  return path.join(os.homedir(), '.claude');
}

function readSlice(file, bytes, fromEnd) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, bytes);
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, fromEnd ? size - length : 0);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
}

function readTail(file, bytes = HISTORY_TAIL_BYTES) {
  return readSlice(file, bytes, true);
}

function jsonLines(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const s = line.trim();
    if (!s || s[0] !== '{') continue;
    try { out.push(JSON.parse(s)); } catch {}
  }
  return out;
}

function oneLine(text, max = NAME_MAX) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 3).trimEnd() + '...' : s;
}

function projectSlug(cwd) {
  return String(cwd || '').replace(/[^A-Za-z0-9]/g, '-');
}

function sessionTitle(file) {
  let custom = '', ai = '';
  for (const ev of jsonLines(readSlice(file, TITLE_TAIL_BYTES, true))) {
    if (ev.type === 'custom-title' && typeof ev.customTitle === 'string' && ev.customTitle.trim()) custom = ev.customTitle;
    else if (ev.type === 'ai-title' && typeof ev.aiTitle === 'string' && ev.aiTitle.trim()) ai = ev.aiTitle;
  }
  return oneLine(custom || ai);
}

function promptText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const part = content.find(p => p && p.type === 'text' && typeof p.text === 'string');
  return part ? part.text : '';
}

function firstPrompt(file) {
  for (const ev of jsonLines(readSlice(file, CWD_HEAD_BYTES, false))) {
    if (ev.type !== 'user' || ev.isMeta || !ev.message) continue;
    const text = promptText(ev.message.content).trim();
    if (text && !text.startsWith('<') && !text.startsWith('/')) return oneLine(text);
  }
  return '';
}

function sessionLabel(dir, id, cwd) {
  const file = id ? sessionFileFor(dir, id, cwd) : '';
  return file ? (sessionTitle(file) || firstPrompt(file)) : '';
}

const BRANCH_TTL_MS = 30000;
const BRANCH_DEPTH = 12;
const branchCache = new Map();

function readGitHead(dir) {
  const dotGit = path.join(dir, '.git');
  let st;
  try { st = fs.statSync(dotGit); } catch { return null; }
  let gitDir = dotGit;
  if (st.isFile()) {
    const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'));
    if (!m) return '';
    gitDir = path.resolve(dir, m[1].trim());
  }
  try { return fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim(); } catch { return ''; }
}

function gitBranch(cwd, now = Date.now()) {
  if (!cwd) return '';
  const hit = branchCache.get(cwd);
  if (hit && now - hit.at < BRANCH_TTL_MS) return hit.branch;
  let branch = '';
  let dir = path.resolve(String(cwd));
  for (let i = 0; i < BRANCH_DEPTH; i++) {
    let head = null;
    try { head = readGitHead(dir); } catch { head = ''; }
    if (head !== null) {
      const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
      branch = ref ? ref[1] : (/^[0-9a-f]{7,}$/i.test(head) ? head.slice(0, 7) : '');
      break;
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  branchCache.set(cwd, { at: now, branch });
  return branch;
}

function sessionCwd(file) {
  const m = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(readSlice(file, CWD_HEAD_BYTES, false));
  if (!m) return '';
  try { return JSON.parse(`"${m[1]}"`); } catch { return ''; }
}

function projectDirs(dir) {
  const root = path.join(dir, 'projects');
  try {
    return fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => path.join(root, d.name));
  } catch { return []; }
}

function sessionFileFor(dir, id, cwd) {
  if (cwd) {
    const direct = path.join(dir, 'projects', projectSlug(cwd), `${id}.jsonl`);
    if (fs.existsSync(direct)) return direct;
  }
  for (const p of projectDirs(dir)) {
    const f = path.join(p, `${id}.jsonl`);
    if (fs.existsSync(f)) return f;
  }
  return '';
}

function recentClaudeSessions(dir, { limit = 10 } = {}) {
  const byId = new Map();
  for (const ev of jsonLines(readSlice(path.join(dir, 'history.jsonl'), HISTORY_TAIL_BYTES, true))) {
    const id = String(ev.sessionId || '');
    if (!SESSION_ID_RE.test(id)) continue;
    const at = Number(ev.timestamp) || 0;
    const cur = byId.get(id) || { id, cwd: '', at: 0, prompt: '', promptAt: Infinity };
    if (at >= cur.at) {
      cur.at = at;
      if (ev.project) cur.cwd = String(ev.project);
    }
    const prompt = String(ev.display || '').trim();
    if (prompt && !prompt.startsWith('/') && at < cur.promptAt) { cur.prompt = prompt; cur.promptAt = at; }
    byId.set(id, cur);
  }
  return [...byId.values()].sort((a, b) => b.at - a.at).slice(0, limit).map(s => {
    const file = sessionFileFor(dir, s.id, s.cwd);
    const name = (file && sessionTitle(file)) || oneLine(s.prompt) || (file && firstPrompt(file));
    return { id: s.id, name, cwd: s.cwd, agent: 'claude', at: Math.floor(s.at / 1000) };
  });
}

function findClaudeSessions(dir, ref, { limit = 20 } = {}) {
  const want = String(ref || '').toLowerCase();
  if (!want) return [];
  const found = [];
  for (const p of projectDirs(dir)) {
    let names = [];
    try { names = fs.readdirSync(p); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      const id = n.slice(0, -6);
      if (!SESSION_ID_RE.test(id) || !id.toLowerCase().startsWith(want)) continue;
      if (found.some(f => f.id === id)) continue;
      const file = path.join(p, n);
      let at = 0;
      try { at = Math.floor(fs.statSync(file).mtimeMs / 1000); } catch {}
      found.push({ id, file, at });
      if (found.length >= limit) break;
    }
    if (found.length >= limit) break;
  }
  return found.map(f => ({ id: f.id, name: sessionTitle(f.file), cwd: sessionCwd(f.file), agent: 'claude', at: f.at }));
}

function runningClaude(dir, pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return null;
  let info;
  try { info = JSON.parse(fs.readFileSync(path.join(dir, 'sessions', `${n}.json`), 'utf8')); } catch { return null; }
  if (!info || typeof info !== 'object') return null;
  const id = String(info.sessionId || '');
  return { id: SESSION_ID_RE.test(id) ? id : '', name: oneLine(info.name || ''), cwd: String(info.cwd || '') };
}

function ownSessions(state, transcripts) {
  const out = [];
  const sessions = (state && state.sessions) || {};
  const chats = (transcripts && transcripts.chats) || {};
  for (const [key, id] of Object.entries(sessions)) {
    if (!key.startsWith('chat:') || typeof id !== 'string' || !id) continue;
    const chat = key.slice(5);
    const t = chats[chat] || {};
    out.push({
      id,
      chat,
      name: oneLine(t.name || ''),
      cwd: String((state.sessionCwd && state.sessionCwd[key]) || t.cwd || ''),
      agent: String((state.sessionAgent && state.sessionAgent[key]) || 'claude'),
      plugin: String((state.sessionPlugin && state.sessionPlugin[key]) || ''),
      at: Math.floor((Number(t.updated) || 0) / 1000),
    });
  }
  return out;
}

function mergeSessions({ live = [], own = [], claude = [], limit = 12 } = {}) {
  const seen = new Set();
  const out = [];
  const running = [...live].sort((a, b) => Number(b.listening !== false) - Number(a.listening !== false));
  for (const s of running) {
    const key = s.id || `${s.name || ''}\n${s.cwd || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const listening = s.listening !== false;
    out.push({ ...s, live: listening, running: true });
  }
  const rest = [];
  for (const s of [...own, ...claude]) {
    if (!s || !s.id || seen.has(s.id)) continue;
    seen.add(s.id);
    rest.push(s);
  }
  rest.sort((a, b) => (b.at || 0) - (a.at || 0));
  return out.concat(rest).slice(0, Math.max(limit, out.length));
}

function matchRef(list, ref) {
  const want = String(ref || '').trim().toLowerCase();
  if (!want) return [];
  const rules = [
    s => String(s.id || '').toLowerCase() === want,
    s => String(s.name || '').toLowerCase() === want,
    s => want.length >= MIN_PREFIX && String(s.id || '').toLowerCase().startsWith(want),
    s => String(s.name || '').toLowerCase().startsWith(want),
  ];
  for (const rule of rules) {
    const hits = list.filter(rule);
    if (hits.length) return hits;
  }
  return [];
}

function resolveResume(ref, { own = [], find = () => [] } = {}) {
  let hits = matchRef(own, ref);
  if (!hits.length) hits = matchRef(find(ref), ref);
  const exact = hits.filter(h => h.id === ref);
  if (exact.length === 1) hits = exact;
  if (hits.length === 1) return { session: hits[0] };
  if (!hits.length) return { error: `No session matches "${ref}". /claude -r lists the recent ones.` };
  return { error: `"${ref}" matches ${hits.length} sessions:\n${hits.slice(0, 8).map(describe).join('\n')}\nUse more of the id.` };
}

function describe(s) {
  return [s.id ? s.id.slice(0, 8) : '', s.name || '', s.cwd || ''].filter(Boolean).join('  ');
}

module.exports = {
  SESSION_ID_RE, REF_RE, MIN_PREFIX,
  claudeDir, projectSlug, sessionTitle, sessionCwd, sessionFileFor, readTail, firstPrompt, sessionLabel, gitBranch,
  recentClaudeSessions, findClaudeSessions, runningClaude, ownSessions, mergeSessions, matchRef, resolveResume, describe, oneLine,
};
