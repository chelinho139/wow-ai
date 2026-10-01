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
const TITLE_MAX = 60;
const LINE_MAX_BYTES = 4096;
const PUSH_EVERY_MS = 2000;
const RECONNECT_MS = 5000;
const RECONNECTS_MAX = 5;
const CONNECT_TIMEOUT_MS = 10000;
const IDLE_TIMEOUT_MS = 6 * 60 * 1000;
const END_OF_NAMES = '366';
const SHUTDOWN_PUSH_WAIT_MS = 1000;
const UNKNOWN_ACTION_RE = /unknown action/i;

const CHANNEL_RE = /^[a-z0-9_]{3,25}$/;
const NICK_RE = /^([a-z0-9_]{1,25})!/;
const PRIVMSG_PARAMS_RE = /^#([a-z0-9_]{1,25}) :(.*)$/s;
const JOIN_PARAMS_RE = /^:?#([a-z0-9_]{1,25})$/;
const NAMES_END_PARAMS_RE = /^\S+ #([a-z0-9_]{1,25})(?: |$)/;
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
  if (command === 'JOIN' || command === END_OF_NAMES) {
    const m = (command === 'JOIN' ? JOIN_PARAMS_RE : NAMES_END_PARAMS_RE).exec(params);
    return m ? { type: 'joined', channel: m[1] } : null;
  }
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

function displayCommand(r, isOpen) {
  return { action: OVERLAY_ACTION, vote: { open: isOpen, options: r.options, total: r.total, endsAt: r.endsAt, winner: isOpen ? null : r.winner } };
}

function resultText(r) {
  const lines = r.options.map(o => `!${o.n} ${o.title}: ${o.votes}`);
  const capped = r.capped ? ` The voter cap of ${VOTERS_MAX} was reached; later voters were not counted.` : '';
  const missed = r.chatMissed ? ' Twitch chat was not connected for part of the vote, so votes from that time are missing.' : '';
  const outcome = r.winner ? `Winner: !${r.winner}.` : r.total ? 'No winner: a tie.' : 'No winner: nobody voted.';
  return `${lines.join('; ')}. ${r.total} voter${r.total === 1 ? '' : 's'}. ${outcome}${capped}${missed}`;
}

function settleWithin(promise, ms, timers = { set: setTimeout }) {
  return Promise.race([
    Promise.resolve(promise).catch(() => {}),
    new Promise(resolve => {
      const t = timers.set(resolve, ms);
      if (t && typeof t.unref === 'function') t.unref();
    }),
  ]);
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
  const connectTimeoutMs = opts.connectTimeoutMs === undefined ? CONNECT_TIMEOUT_MS : opts.connectTimeoutMs;
  const idleTimeoutMs = opts.idleTimeoutMs === undefined ? IDLE_TIMEOUT_MS : opts.idleTimeoutMs;
  const nick = opts.nick || (() => `${ANON_NICK_PREFIX}${10000 + Math.floor(Math.random() * 89999)}`);

  let open = null;
  let last = null;
  let unknownActionSaid = false;

  function unref(t) {
    if (t && typeof t.unref === 'function') t.unref();
    return t;
  }

  function noteRefused(vote, why) {
    if (UNKNOWN_ACTION_RE.test(why)) {
      if (unknownActionSaid) return;
      unknownActionSaid = true;
      log(`votes: the stream service has no "${OVERLAY_ACTION}" action (${why}); the overlay shows votes only with a wow-stream that has it. Votes are still counted here.`);
      return;
    }
    if (vote.pushFailSaid) return;
    vote.pushFailSaid = true;
    log(`votes: the stream service did not take the vote display (${why})`);
  }

  async function pushDisplay(vote, isOpen, withWinner = true) {
    const options = streamOptions() || {};
    if (!ST.isEnabled(options)) return;
    const r = vote.ballot.result();
    const command = displayCommand(withWinner ? r : { ...r, winner: null }, isOpen);
    try {
      const answer = await post(ST.serviceUrl(options), command);
      if (!(answer && answer.ok)) noteRefused(vote, answer && answer.message ? answer.message : `status ${answer ? answer.status : '?'}`);
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

  function chatMissed(vote, why) {
    vote.chatMissed = true;
    if (vote.missedSaid) return;
    vote.missedSaid = true;
    log(`votes: Twitch chat is not connected (${why}); votes from that time are missing`);
  }

  function onLine(vote, line) {
    const msg = parseIrcLine(line);
    if (!msg) return;
    if (msg.type === 'ping') { write(vote, `PONG :${msg.arg}`); return; }
    if (msg.channel !== vote.channel) return;
    vote.joined = true;
    if (vote.connectTimer) { timers.clear(vote.connectTimer); vote.connectTimer = null; }
    if (msg.type === 'joined') return;
    const choice = voteChoice(msg.text, vote.options.length);
    if (!choice) return;
    const r = vote.ballot.cast(msg.user, choice);
    if (r === 'capped' && !vote.cappedSaid) { vote.cappedSaid = true; log(`votes: ${VOTERS_MAX} voters reached; later voters are not counted`); }
    if (r === 'counted') { vote.dirty = true; schedulePush(vote); }
  }

  function write(vote, line) {
    if (vote.socket && !vote.socket.destroyed) vote.socket.write(`${line}\r\n`);
  }

  function clearSocketTimers(vote) {
    for (const k of ['connectTimer', 'idleTimer']) {
      if (vote[k]) timers.clear(vote[k]);
      vote[k] = null;
    }
  }

  function drop(vote, socket, why) {
    if (vote !== open || vote.socket !== socket) return;
    clearSocketTimers(vote);
    vote.socket = null;
    vote.joined = false;
    try { socket.destroy(); } catch {}
    chatMissed(vote, why);
    scheduleReconnect(vote);
  }

  function armIdle(vote, socket) {
    if (vote.idleTimer) timers.clear(vote.idleTimer);
    vote.idleTimer = unref(timers.set(() => { vote.idleTimer = null; drop(vote, socket, `no data for ${idleTimeoutMs / 1000} s`); }, idleTimeoutMs));
  }

  function feed(vote, chunk) {
    let text = String(chunk);
    if (vote.discarding) {
      const nl = text.indexOf('\n');
      if (nl < 0) return;
      vote.discarding = false;
      text = text.slice(nl + 1);
    }
    vote.buffer += text;
    const lines = vote.buffer.split(/\r?\n/);
    vote.buffer = lines.pop();
    if (Buffer.byteLength(vote.buffer, 'utf8') > LINE_MAX_BYTES) { vote.buffer = ''; vote.discarding = true; }
    for (const line of lines) onLine(vote, line);
  }

  function attach(vote) {
    let socket;
    try { socket = connect(); } catch (e) { chatMissed(vote, `cannot connect: ${e.message}`); scheduleReconnect(vote); return; }
    vote.socket = socket;
    vote.joined = false;
    vote.buffer = '';
    vote.discarding = false;
    if (typeof socket.setEncoding === 'function') socket.setEncoding('utf8');
    socket.on('data', chunk => {
      if (vote !== open || vote.socket !== socket) return;
      armIdle(vote, socket);
      feed(vote, chunk);
    });
    socket.on('error', e => log(`votes: Twitch chat connection error (${e && e.message ? e.message : e})`));
    socket.on('close', () => drop(vote, socket, 'the connection closed'));
    vote.connectTimer = unref(timers.set(() => { vote.connectTimer = null; if (!vote.joined) drop(vote, socket, `no channel join within ${connectTimeoutMs / 1000} s`); }, connectTimeoutMs));
    armIdle(vote, socket);
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
    clearSocketTimers(vote);
    for (const k of ['pushTimer', 'reconnectTimer', 'endTimer']) {
      if (vote[k]) timers.clear(vote[k]);
      vote[k] = null;
    }
    const socket = vote.socket;
    vote.socket = null;
    if (socket) { try { socket.destroy(); } catch {} }
  }

  function finish() {
    const vote = open;
    if (!vote) return null;
    if (!vote.joined) chatMissed(vote, 'it never joined the channel or was disconnected at the close');
    open = null;
    release(vote);
    last = { options: vote.options, character: vote.character, result: { ...vote.ballot.result(), chatMissed: !!vote.chatMissed }, adopted: false };
    pushDisplay(vote, false);
    log(`votes: closed; ${resultText(last.result)}`);
    return last;
  }

  function start({ options, seconds, character = '' }) {
    const channel = channelOf(config());
    if (!channel) return { ok: false, text: 'Votes are off. Set votes.channel to a Twitch channel name in config.json and restart the bridge.' };
    if (open) return { ok: false, text: 'A vote is already open. Close it with goal_vote_close first.' };
    const long = options.findIndex(o => typeof o.title !== 'string' || !o.title || o.title.length > TITLE_MAX);
    if (long >= 0) return { ok: false, text: `Option ${long + 1}: its title is empty or over ${TITLE_MAX} characters, the overlay's limit.` };
    const endsAt = now() + seconds * 1000;
    const vote = { channel, character, options, ballot: createBallot({ options, endsAt }), socket: null, reconnects: 0, dirty: false };
    open = vote;
    last = null;
    vote.endTimer = unref(timers.set(() => { if (open === vote) finish(); }, seconds * 1000));
    attach(vote);
    pushDisplay(vote, true);
    log(`votes: open on #${channel} for ${seconds} s with ${options.length} options`);
    return { ok: true, text: `The vote is open on #${channel} for ${seconds} s: ${options.map((o, i) => `!${i + 1} ${o.title}`).join(', ')}. Viewers type !1 to !${options.length}; one vote per Twitch name. The stream overlay shows it only with a wow-stream that has the "${OVERLAY_ACTION}" action. Close it with goal_vote_close.` };
  }

  function stop() {
    if (!open) return Promise.resolve();
    const vote = open;
    open = null;
    const closing = pushDisplay(vote, false, false);
    release(vote);
    return closing;
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
  IRC_HOST, IRC_PORT, ANON_NICK_PREFIX, OVERLAY_ACTION, OPTIONS_MIN, OPTIONS_MAX, SECONDS_MIN, SECONDS_MAX, VOTERS_MAX, TITLE_MAX, LINE_MAX_BYTES, RECONNECTS_MAX,
  CONNECT_TIMEOUT_MS, IDLE_TIMEOUT_MS, SHUTDOWN_PUSH_WAIT_MS,
  channelOf, parseIrcLine, voteChoice, createBallot, resultText, createVotes, settleWithin,
};
