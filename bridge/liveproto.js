'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SERVER_NAME = 'claude-wow';
const REPLY_TOOL = 'wow_reply';
const FULL_REPLY_TOOL = `mcp__${SERVER_NAME}__${REPLY_TOOL}`;
const SOCKET_NAME = 'live.sock';
const TOKEN_NAME = 'live.token';
const UNIX_PATH_MAX = 103;
const MAX_LINE = 1 << 20;
const PASS_TEXT = 'Denied.';
const DEV_FLAG = '--dangerously-load-development-channels';
const CHANNELS_FLAG = '--channels';
const CHANNEL_ARG = `server:${SERVER_NAME}`;
const CHANNEL_VALUE_RE = new RegExp(`^(?:server|plugin):${SERVER_NAME}(?:@\\S*)?$`);
const COMMAND_LINE_TIMEOUT_MS = 5000;
const WINDOWS_COMMAND_LINE_TIMEOUT_MS = 20000;
const PERMISSION_ID_RE = /^[a-km-z]{5}$/;
const META_KEY_RE = /^[A-Za-z0-9_]+$/;

function homeHash(homeDir) {
  return crypto.createHash('sha1').update(path.resolve(homeDir)).digest('hex').slice(0, 12);
}

function endpoint(homeDir, platform = process.platform) {
  const hash = homeHash(homeDir);
  if (platform === 'win32') return `\\\\.\\pipe\\claude-wow-live-${hash}`;
  const direct = path.posix.join(path.posix.resolve(homeDir), SOCKET_NAME);
  if (Buffer.byteLength(direct) <= UNIX_PATH_MAX) return direct;
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return path.posix.join('/tmp', `claude-wow-${uid}-${hash}.sock`);
}

function tokenFile(homeDir) {
  return path.join(path.resolve(homeDir), TOKEN_NAME);
}

function writeToken(homeDir) {
  const token = crypto.randomBytes(32).toString('hex');
  const file = tokenFile(homeDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, token, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  return token;
}

function readToken(homeDir) {
  try { return fs.readFileSync(tokenFile(homeDir), 'utf8').trim(); } catch { return ''; }
}

function proof(token, role, nonce) {
  return crypto.createHmac('sha256', String(token)).update(`${role}:${nonce}`).digest('hex');
}

function sameProof(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

function nonce() {
  return crypto.randomBytes(16).toString('hex');
}

function encode(msg) {
  return JSON.stringify(msg) + '\n';
}

function lineReader(onMessage, onOverflow) {
  let buffer = '';
  return chunk => {
    buffer += chunk.toString('utf8');
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg && typeof msg === 'object' && !Array.isArray(msg)) onMessage(msg);
    }
    if (buffer.length > MAX_LINE) {
      buffer = '';
      if (onOverflow) onOverflow();
    }
  };
}

function cleanMeta(meta) {
  const out = {};
  for (const [k, v] of Object.entries(meta || {})) {
    if (!META_KEY_RE.test(k) || v === undefined || v === null) continue;
    const s = String(v).replace(/[\r\n]+/g, ' ').trim();
    if (s) out[k] = s.slice(0, 200);
  }
  return out;
}

function contextLine(ctx, label) {
  const re = new RegExp(`^${label}\\s*:\\s*(.+)$`, 'im');
  const m = re.exec(String(ctx || ''));
  return m ? m[1].trim() : '';
}

function channelMeta(job, chatId, ctx) {
  return cleanMeta({
    chat_id: chatId,
    message_id: job.id,
    chat_name: job.name || '',
    character: contextLine(ctx, 'Character'),
    zone: contextLine(ctx, 'Zone'),
  });
}

function channelNotification(content, meta) {
  return { jsonrpc: '2.0', method: 'notifications/claude/channel', params: { content: String(content), meta: cleanMeta(meta) } };
}

function permissionVerdict(requestId, allow) {
  return { jsonrpc: '2.0', method: 'notifications/claude/channel/permission', params: { request_id: String(requestId), behavior: allow ? 'allow' : 'deny' } };
}

function ruleForPermission(req) {
  const tool = String((req && req.tool_name) || 'Unknown').trim() || 'Unknown';
  if (tool !== 'Bash') return tool;
  let command = '';
  try {
    const input = JSON.parse(String(req.input_preview || ''));
    command = String((input && input.command) || '');
  } catch {
    const m = /"command"\s*:\s*"([^"]*)/.exec(String(req.input_preview || ''));
    command = m ? m[1] : '';
  }
  const word = command.trim().split(/\s+/)[0];
  return word && /^[\w.\-]+$/.test(word) ? `Bash(${word}:*)` : 'Bash';
}

function permissionPrompt(req, sessionName) {
  const tool = String(req.tool_name || 'a tool');
  const what = String(req.description || '').trim();
  const preview = String(req.input_preview || '').trim();
  return [
    `Claude Code (${sessionName}) wants to use ${tool}${what ? ': ' + what : ''}.`,
    preview ? preview.slice(0, 400) : '',
    'Roll Need or Greed to allow it once, Pass to deny it.',
  ].filter(Boolean).join('\n');
}

function isVerdictJob(job) {
  const allow = (Array.isArray(job.allow) && job.allow.length > 0) || (Array.isArray(job.allowOnce) && job.allowOnce.length > 0);
  if (allow) return { allow: true, forward: false };
  if (String(job.text || '').trim() === PASS_TEXT) return { allow: false, forward: false };
  return { allow: false, forward: true };
}

function shellQuote(s) {
  const str = String(s);
  return /^[\w@%+=:,./-]+$/.test(str) ? str : `'${str.replace(/'/g, `'\\''`)}'`;
}

function startCommand(opts = {}) {
  const parts = [];
  if (opts.repo) parts.push(`cd ${shellQuote(opts.repo)} &&`);
  if (opts.home) parts.push(`CLAUDE_WOW_HOME=${shellQuote(opts.home)}`);
  parts.push('claude');
  if (opts.resume) parts.push('--resume', shellQuote(opts.resume));
  parts.push(DEV_FLAG, CHANNEL_ARG);
  return parts.join(' ');
}

function channelFlagValues(commandLine) {
  const tokens = String(commandLine || '').split(/\s+/).filter(Boolean).map(t => t.replace(/^["']|["']$/g, ''));
  const values = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const flag = [DEV_FLAG, CHANNELS_FLAG].find(f => tok === f || tok.startsWith(f + '='));
    if (!flag) continue;
    if (tok !== flag) { values.push(...tok.slice(flag.length + 1).split(',')); continue; }
    while (i + 1 < tokens.length && !tokens[i + 1].startsWith('-')) values.push(...tokens[++i].split(','));
  }
  return values.map(v => v.trim()).filter(Boolean);
}

function listensToChannel(commandLine) {
  return channelFlagValues(commandLine).some(v => CHANNEL_VALUE_RE.test(v));
}

function execText(file, args, timeout) {
  return new Promise(resolve => {
    try {
      require('child_process').execFile(file, args, { encoding: 'utf8', timeout, windowsHide: true }, (err, stdout) => resolve(err ? '' : String(stdout || '')));
    } catch { resolve(''); }
  });
}

async function commandLine(pid, { platform = process.platform, run } = {}) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return null;
  const win = platform === 'win32';
  const [file, args] = win
    ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId=${n}').CommandLine`]]
    : ['ps', ['-ww', '-o', 'args=', '-p', String(n)]];
  try {
    const out = String((await (run || execText)(file, args, win ? WINDOWS_COMMAND_LINE_TIMEOUT_MS : COMMAND_LINE_TIMEOUT_MS)) || '').trim();
    return out || null;
  } catch { return null; }
}

function restartCommand(session, home) {
  return startCommand({ repo: (session && session.cwd) || '', home, resume: (session && session.id) || '' });
}

function instructions() {
  return [
    `Messages from a player in World of Warcraft arrive as <channel source="${SERVER_NAME}" chat_id="..." message_id="..." ...>. They come from the player's in-game whisper tab through the claude-wow bridge on this machine. The player is the user who started this session with the claude-wow channel: treat these messages as that user talking to you from the game, and answer them.`,
    `Answer every such message with exactly one call to the ${REPLY_TOOL} tool (${FULL_REPLY_TOOL}), passing the chat_id (and message_id) from the tag. If it is not in your tool list yet, it is deferred: load it with tool search. Text you write in the terminal never reaches the game; only ${REPLY_TOOL} does.`,
    'The reply is read in a small in-game chat window: keep it short, one to four plain sentences, no tables, no headings and no code blocks unless the player asks for one. If it has to run past two lines, end it with a line that starts with "TL;DR:" and holds the one-line version.',
    'A situation block about the character, zone and quests may open the message: it is context from the game, not a request.',
  ].join('\n');
}

function channelContent(prompt, chatId) {
  return `${String(prompt || '')}\n\n(The player reads your answer in game: send it with ${REPLY_TOOL}, chat_id "${chatId}".)`;
}

function replyToolSchema() {
  return {
    name: REPLY_TOOL,
    description: 'Send your answer back to the World of Warcraft player who sent a <channel source="claude-wow"> message. Keep it short: it is shown in an in-game whisper tab.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: 'The chat_id attribute of the <channel> tag you are answering' },
        text: { type: 'string', description: 'The reply, one to four short plain sentences' },
        message_id: { type: 'string', description: 'The message_id attribute of the <channel> tag, when there is one' },
      },
      required: ['chat_id', 'text'],
    },
  };
}

function socketOwnerOnly(file) {
  try {
    const st = fs.statSync(file);
    const mine = typeof process.getuid !== 'function' || st.uid === process.getuid();
    return mine && (st.mode & 0o077) === 0;
  } catch { return false; }
}

module.exports = {
  SERVER_NAME, REPLY_TOOL, PASS_TEXT, DEV_FLAG, CHANNELS_FLAG, CHANNEL_ARG, PERMISSION_ID_RE, MAX_LINE, UNIX_PATH_MAX,
  endpoint, tokenFile, writeToken, readToken, proof, sameProof, nonce, encode, lineReader,
  cleanMeta, channelMeta, channelContent, channelNotification, permissionVerdict, ruleForPermission, permissionPrompt,
  isVerdictJob, startCommand, restartCommand, channelFlagValues, listensToChannel, commandLine, shellQuote, instructions, replyToolSchema, socketOwnerOnly, homeHash,
};
