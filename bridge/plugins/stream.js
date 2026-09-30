'use strict';

const KIND = 'stream';
const DEFAULT_URL = 'http://127.0.0.1:4466';
const TIMEOUT_MS = 3000;
const QUIET_ACTIONS = new Set(['track']);

function serviceUrl(options) {
  const url = options && typeof options.url === 'string' && options.url.trim() ? options.url.trim() : DEFAULT_URL;
  return url.replace(/\/+$/, '');
}

function parseCommand(text) {
  try {
    const command = JSON.parse(String(text || ''));
    return command && typeof command === 'object' && !Array.isArray(command) && typeof command.action === 'string' ? command : null;
  } catch {
    return null;
  }
}

async function postControl(url, command, timeoutMs = TIMEOUT_MS) {
  const res = await fetch(`${url}/control`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  const ok = !!(body && body.ok === true);
  const message = body && typeof body.message === 'string' ? body.message : '';
  return { ok, message, status: res.status };
}

function notRunningText(url) {
  return `Stream service is not running (${url})`;
}

function replyText(command, result) {
  if (QUIET_ACTIONS.has(command.action)) return '';
  if (result.message) return result.message;
  return result.ok ? 'Stream: done.' : `Stream service answered ${result.status} with no message.`;
}

const plugin = {
  id: 'stream',
  label: 'Stream control',
  tools: '',
  surfaces: [],
  achievements: false,
  match: job => !!job && job.kind === KIND,
  banner: options => `sends /stream scene, quest and pane commands to ${serviceUrl(options)}/control (plugins.stream.url)`,
  async handle(job, core) {
    const url = serviceUrl(core.options('stream'));
    const command = parseCommand(job.text);
    if (!command) {
      core.log(`${core.tag(job)} stream: not a stream command`);
      core.reply(job, 'Stream: that was not a stream command.');
      return;
    }
    let result;
    try {
      result = await postControl(url, command);
    } catch (e) {
      core.log(`${core.tag(job)} stream: ${command.action} to ${url} failed (${e && e.message ? e.message : e})`);
      core.reply(job, QUIET_ACTIONS.has(command.action) ? '' : notRunningText(url));
      return;
    }
    core.log(`${core.tag(job)} stream: ${command.action} -> ${result.status}${result.message ? ' ' + result.message : ''}`);
    core.reply(job, replyText(command, result));
  },
};

module.exports = plugin;
module.exports.KIND = KIND;
module.exports.DEFAULT_URL = DEFAULT_URL;
module.exports.serviceUrl = serviceUrl;
module.exports.parseCommand = parseCommand;
module.exports.postControl = postControl;
module.exports.notRunningText = notRunningText;
