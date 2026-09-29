'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const READ_ONLY_COMMANDS = {
  launchctl: args => args[0] === 'print' || args[0] === 'list',
  ps: () => true,
  pgrep: () => true,
  git: args => {
    const sub = args.find(a => !a.startsWith('-') && !isGitOptionValue(args, a));
    return ['rev-parse', 'log', 'status', 'reflog', 'show'].includes(sub);
  },
  gh: args => args[0] === 'run' && args[1] === 'list',
};

function isGitOptionValue(args, value) {
  const i = args.indexOf(value);
  return i > 0 && args[i - 1] === '-C';
}

function isReadOnlyCommand(cmd, args) {
  const allowed = READ_ONLY_COMMANDS[cmd];
  if (!allowed || !allowed(args)) return false;
  if (cmd === 'git' && args.includes('reflog') && args.some(a => ['expire', 'delete'].includes(a))) return false;
  return true;
}

function spawnReadOnly(cmd, args, opts = {}) {
  if (!isReadOnlyCommand(cmd, args)) throw new Error(`doctor refuses to run a command that is not on its read-only list: ${cmd} ${args.join(' ')}`);
  const result = spawnSync(cmd, args, { encoding: 'utf8', timeout: 15000, ...opts, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...(opts.env || {}) } });
  return { ok: !result.error && result.status === 0, status: result.status, out: result.stdout || '', err: (result.stderr || '') + (result.error ? String(result.error.message) : '') };
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function statPath(file) {
  try {
    const st = fs.statSync(file);
    return { size: st.size, mtimeMs: st.mtimeMs, isDir: st.isDirectory(), isFile: st.isFile(), mode: st.mode };
  } catch { return null; }
}

function listDir(dir) {
  try { return fs.readdirSync(dir); } catch { return null; }
}

function treeSize(dir, maxEntries = 200000) {
  let bytes = 0;
  let files = 0;
  const pending = [dir];
  while (pending.length && files < maxEntries) {
    const current = pending.pop();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile()) {
        try { bytes += fs.statSync(full).size; files++; } catch {}
      }
    }
  }
  return { bytes, files };
}

function tailText(file, maxBytes = 1024 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.toString('utf8');
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } catch { return null; } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

function createSystem(overrides = {}) {
  return {
    platform: process.platform,
    home: os.homedir(),
    uid: typeof process.getuid === 'function' ? process.getuid() : 0,
    env: process.env,
    now: () => Date.now(),
    run: spawnReadOnly,
    readText,
    tailText,
    stat: statPath,
    listDir,
    treeSize,
    ...overrides,
  };
}

module.exports = { createSystem, isReadOnlyCommand, spawnReadOnly, readText, statPath, listDir, treeSize, tailText };
