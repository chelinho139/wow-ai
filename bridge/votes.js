'use strict';

const tls = require('tls');
const ST = require('./plugins/stream');

const IRC_HOST = 'irc.chat.twitch.tv';
const IRC_PORT = 6697;
const ANON_NICK_PREFIX = 'justinfan';
const OVERLAY_ACTION = 'vote';
const OPTIONS_MIN = 2;
const OPTIONS_MAX = 3;
const SECONDS_MIN = 15;
const SECONDS_MAX = 900;
const VOTERS_MAX = 10000;
const LINE_MAX_BYTES = 4096;
const PUSH_EVERY_MS = 2000;
const RECONNECT_MS = 5000;
const RECONNECTS_MAX = 5;

const CHANNEL_RE = /^[a-z0-9_]{3,25}$/;
const NICK_RE = /^([a-z0-9_]{1,25})!/;
const PRIVMSG_PARAMS_RE = /^#([a-z0-9_]{1,25}) :(.*)$/s;
const CHOICE_RE = /^!([1-9])[\s\u{E0000}]*$/u;

function channelOf(config) {
  const raw = config && typeof config === 'object' && typeof config.channel === 'string' ? config.channel : '';
  const name = raw.trim().toLowerCase().replace(/^#/, '');
  return CHANNEL_RE.test(name) ? name : '';
}

function parseIrcLine(line) {
  let rest = String(line || '');
  if (Buffer.byteLength(rest, 'utf8') > LINE_MAX_BYTES) return null;
  if (rest.startsWith('@')) {
    const sp = rest.indexOf(' ');
    if (sp < 0) return null;
    rest = rest.slice(sp + 1);
  }
  let prefix = '';
  if (rest.startsWith(':')) {
    const sp = rest.indexOf(' ');
    if (sp < 0) return null;
    prefix = rest.slice(1, sp);
    rest = rest.slice(sp + 1);
  }
  const sp = rest.indexOf(' ');
  const command = sp < 0 ? rest : rest.slice(0, sp);
  const params = sp < 0 ? '' : rest.slice(sp + 1);
  if (command === 'PING') return { type: 'ping', arg: params.replace(/^:/, '') };
  if (command !== 'PRIVMSG') return null;
  const nick = NICK_RE.exec(prefix.toLowerCase());
  const m = PRIVMSG_PARAMS_RE.exec(params);
  if (!nick || !m) return null;
  return { type: 'privmsg', user: nick[1], channel: m[1], text: m[2] };
}

function voteChoice(text, optionCount) {
  const m = CHOICE_RE.exec(String(text || '').trim());
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= optionCount ? n : null;
}

function createBallot({ options, endsAt, votersMax = VOTERS_MAX }) {
  const counts = options.map(() => 0);
  const voters = new Set();
  let capped = false;

  function cast(user, choice) {
    if (voters.has(user)) return 'repeat';
    if (voters.size >= votersMax) { capped = true; return 'capped'; }
    voters.add(user);
    counts[choice - 1] += 1;
    return 'counted';
  }

  function result() {
    const top = Math.max(...counts);
    const leaders = counts.flatMap((c, i) => (c === top ? [i] : []));
    const winner = top > 0 && leaders.length === 1 ? leaders[0] + 1 : null;
    return {
      options: options.map((o, i) => ({ n: i + 1, title: o.title, votes: counts[i] })),
      total: voters.size,
      capped,
      endsAt,
      winner,
    };
  }

  return { cast, result, voters: () => voters.size };
}

function resultText(r) {
  const lines = r.options.map(o => `!${o.n} ${o.title}: ${o.votes}`);
  const capped = r.capped ? ` The voter cap of ${VOTERS_MAX} was reached; later voters were not counted.` : '';
  const outcome = r.winner ? `Winner: !${r.winner}.` : r.total ? 'No winner: a tie.' : 'No winner: nobody voted.';
  return `${lines.join('; ')}. ${r.total} voter${r.total === 1 ? '' : 's'}. ${outcome}${capped}`;
}

function createVotes(opts) {
  const config = opts.config || (() => null);
  const connect = opts.connect || (() => tls.connect({ host: IRC_HOST, port: IRC_PORT, servername: IRC_HOST }));
  const post = opts.post || ST.postControl;
  const streamOptions = opts.streamOptions || (() => ({}));
  const now = opts.now || Date.now;
  const log = opts.log || (() => {});
  const timers = opts.timers || { set: setTimeout, clear: clearTimeout };
  const pushEveryMs = opts.pushEveryMs === undefined ? PUSH_EVERY_MS : opts.pushEveryMs;
  const reconnectMs = opts.reconnectMs === undefined ? RECONNECT_MS : opts.reconnectMs;
  const nick = opts.nick || (() => `${ANON_NICK_PREFIX}${10000 + Math.floor(Math.random() * 89999)}`);

  let open = null;
  let last = null;

  function unref(t) {
    if (t && typeof t.unref === 'function') t.unref();
    return t;
  }

  async function pushDisplay(vote, isOpen) {
    const options = streamOptions() || {};
    if (!ST.isEnabled(options)) return;
    const r = vote.ballot.result();
    const command = { action: OVERLAY_ACTION, vote: { open: isOpen, options: r.options, total: r.total, endsAt: r.endsAt, winner: isOpen ? null : r.winner } };
    try {
      const answer = await post(ST.serviceUrl(options), command);
      if (!(answer && answer.ok) && !vote.pushFailSaid) {
        vote.pushFailSaid = true;
        log(`votes: the stream service did not take the vote display (${answer && answer.message ? answer.message : 'status ' + (answer ? answer.status : '?')})`);
      }
    } catch (e) {
      if (!vote.pushFailSaid) {
        vote.pushFailSaid = true;
        log(`votes: the vote display push failed (${e && e.message ? e.message : e})`);
      }
    }
  }

  function schedulePush(vote) {
    if (vote.pushTimer || vote !== open) return;
    vote.pushTimer = unref(timers.set(() => {
      vote.pushTimer = null;
      if (vote === open && vote.dirty) { vote.dirty = false; pushDisplay(vote, true); }
    }, pushEveryMs));
  }

  function onLine(vote, line) {
    const msg = parseIrcLine(line);
    if (!msg) return;
    if (msg.type === 'ping') { write(vote, `PONG :${msg.arg}`); return; }
    if (msg.channel !== vote.channel) return;
    const choice = voteChoice(msg.text, vote.options.length);
    if (!choice) return;
    const r = vote.ballot.cast(msg.user, choice);
    if (r === 'capped' && !vote.cappedSaid) { vote.cappedSaid = true; log(`votes: ${VOTERS_MAX} voters reached; later voters are not counted`); }
    if (r === 'counted') { vote.dirty = true; schedulePush(vote); }
  }

  function write(vote, line) {
    if (vote.socket && !vote.socket.destroyed) vote.socket.write(`${line}\r\n`);
  }

  function attach(vote) {
    let socket;
    try { socket = connect(); } catch (e) { log(`votes: cannot connect to Twitch chat (${e.message})`); scheduleReconnect(vote); return; }
    vote.socket = socket;
    let buffer = '';
    if (typeof socket.setEncoding === 'function') socket.setEncoding('utf8');
    socket.on('data', chunk => {
      if (vote !== open || vote.socket !== socket) return;
      buffer += String(chunk);
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      if (Buffer.byteLength(buffer, 'utf8') > LINE_MAX_BYTES) buffer = '';
      for (const line of lines) onLine(vote, line);
    });
    socket.on('error', e => log(`votes: Twitch chat connection error (${e && e.message ? e.message : e})`));
    socket.on('close', () => {
      if (vote !== open || vote.socket !== socket) return;
      vote.socket = null;
      scheduleReconnect(vote);
    });
    write(vote, `NICK ${nick()}`);
    write(vote, `JOIN #${vote.channel}`);
  }

  function scheduleReconnect(vote) {
    if (vote !== open || vote.reconnectTimer) return;
    if (vote.reconnects >= RECONNECTS_MAX) { log(`votes: Twitch chat dropped ${RECONNECTS_MAX} times; no more votes are read until the next vote`); return; }
    vote.reconnects += 1;
    vote.reconnectTimer = unref(timers.set(() => { vote.reconnectTimer = null; if (vote === open) attach(vote); }, reconnectMs));
  }

  function release(vote) {
    for (const t of [vote.pushTimer, vote.reconnectTimer, vote.endTimer]) if (t) timers.clear(t);
    vote.pushTimer = vote.reconnectTimer = vote.endTimer = null;
    const socket = vote.socket;
    vote.socket = null;
    if (socket) { try { socket.destroy(); } catch {} }
  }

  function finish() {
    const vote = open;
    if (!vote) return null;
    open = null;
    release(vote);
    last = { options: vote.options, result: vote.ballot.result(), adopted: false };
    pushDisplay(vote, false);
    log(`votes: closed; ${resultText(last.result)}`);
    return last;
  }

  function start({ options, seconds }) {
    const channel = channelOf(config());
    if (!channel) return { ok: false, text: 'Votes are off. Set votes.channel to a Twitch channel name in config.json and restart the bridge.' };
    if (open) return { ok: false, text: 'A vote is already open. Close it with goal_vote_close first.' };
    const endsAt = now() + seconds * 1000;
    const vote = { channel, options, ballot: createBallot({ options, endsAt }), socket: null, reconnects: 0, dirty: false };
    open = vote;
    last = null;
    vote.endTimer = unref(timers.set(() => { if (open === vote) finish(); }, seconds * 1000));
    attach(vote);
    pushDisplay(vote, true);
    log(`votes: open on #${channel} for ${seconds} s with ${options.length} options`);
    return { ok: true, text: `The vote is open on #${channel} for ${seconds} s: ${options.map((o, i) => `!${i + 1} ${o.title}`).join(', ')}. Viewers type !1 to !${options.length}; one vote per Twitch name. Close it with goal_vote_close.` };
  }

  function stop() {
    if (open) { const vote = open; open = null; release(vote); }
  }

  return {
    start,
    close: finish,
    stop,
    isOpen: () => !!open,
    last: () => last,
    markAdopted: () => { if (last) last.adopted = true; },
    voters: () => (open ? open.ballot.voters() : 0),
  };
}

module.exports = {
  IRC_HOST, IRC_PORT, ANON_NICK_PREFIX, OVERLAY_ACTION, OPTIONS_MIN, OPTIONS_MAX, SECONDS_MIN, SECONDS_MAX, VOTERS_MAX, LINE_MAX_BYTES, RECONNECTS_MAX,
  channelOf, parseIrcLine, voteChoice, createBallot, resultText, createVotes,
};
