'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const V = require('../bridge/votes');
const G = require('../bridge/goals');
const GD = require('../bridge/gamedata');

const IRC = Object.freeze({
  plain: ':viewer_one!viewer_one@viewer_one.tmi.twitch.tv PRIVMSG #bonestream :!1',
  tagged: '@badge-info=;badges=;color=#FF0000;display-name=Viewer_Two;emotes=;id=abc;mod=0;room-id=1;subscriber=0;tmi-sent-ts=1;turbo=0;user-id=2;user-type= :viewer_two!viewer_two@viewer_two.tmi.twitch.tv PRIVMSG #bonestream :!2',
  dupeSuffix: ':viewer_three!viewer_three@viewer_three.tmi.twitch.tv PRIVMSG #bonestream :!3 \u{E0000}',
  ping: 'PING :tmi.twitch.tv',
  join: ':justinfan12345!justinfan12345@justinfan12345.tmi.twitch.tv JOIN #bonestream',
  welcome: ':tmi.twitch.tv 001 justinfan12345 :Welcome, GLHF!',
  otherChannel: ':viewer_four!viewer_four@viewer_four.tmi.twitch.tv PRIVMSG #elsewhere :!1',
});

test('IRC parsing: PRIVMSG with and without IRCv3 tags, PING, and lines that are not chat', () => {
  assert.deepEqual(V.parseIrcLine(IRC.plain), { type: 'privmsg', user: 'viewer_one', channel: 'bonestream', text: '!1' });
  assert.deepEqual(V.parseIrcLine(IRC.tagged), { type: 'privmsg', user: 'viewer_two', channel: 'bonestream', text: '!2' });
  assert.deepEqual(V.parseIrcLine(IRC.ping), { type: 'ping', arg: 'tmi.twitch.tv' });
  assert.equal(V.parseIrcLine(IRC.welcome), null);
});

test('IRC parsing: malformed lines give nothing and never throw', () => {
  for (const line of [
    '', '@tagsonly', ':prefixonly', 'PRIVMSG', ':x PRIVMSG #bonestream', ':noexclaim PRIVMSG #bonestream :!1',
    ':a!a@a PRIVMSG bonestream :!1', ':a!a@a PRIVMSG #Bad-Chan :!1', ':bad name!x@x PRIVMSG #bonestream :!1',
    `:a!a@a PRIVMSG #bonestream :${'x'.repeat(V.LINE_MAX_BYTES)}`, null, undefined, 42,
  ]) {
    assert.equal(V.parseIrcLine(line), null, JSON.stringify(line));
  }
});

test('vote choice: only !N within the option count, with trailing spaces or the duplicate-message marker', () => {
  assert.equal(V.voteChoice('!1', 3), 1);
  assert.equal(V.voteChoice(' !3  ', 3), 3);
  assert.equal(V.voteChoice('!3 \u{E0000}', 3), 3);
  for (const text of ['!3', '!0', '!4', '1', '! 1', '!1!', '!12', '!1 please', 'vote !1', '!one', '']) {
    assert.equal(V.voteChoice(text, 2), null, text);
  }
});

test('channel config: off unless votes.channel is a valid Twitch name', () => {
  assert.equal(V.channelOf({ channel: '#BoneStream' }), 'bonestream');
  for (const c of [null, {}, { channel: '' }, { channel: 'ab' }, { channel: 'bad name' }, { channel: 'x'.repeat(26) }, { channel: 5 }]) {
    assert.equal(V.channelOf(c), '', JSON.stringify(c));
  }
});

test('ballot: one vote per Twitch name, the first one counts; a tie or no votes has no winner', () => {
  const b = V.createBallot({ options: [{ title: 'A' }, { title: 'B' }], endsAt: 5 });
  assert.equal(b.cast('ann', 1), 'counted');
  assert.equal(b.cast('ann', 2), 'repeat');
  assert.equal(b.cast('ann', 1), 'repeat');
  assert.deepEqual(b.result(), { options: [{ n: 1, title: 'A', votes: 1 }, { n: 2, title: 'B', votes: 0 }], total: 1, capped: false, endsAt: 5, winner: 1 });
  assert.equal(b.cast('bob', 2), 'counted');
  assert.equal(b.result().winner, null, 'a tie has no winner');
  assert.equal(V.createBallot({ options: [{ title: 'A' }, { title: 'B' }], endsAt: 0 }).result().winner, null, 'no votes, no winner');
});

test('ballot: the voter set is capped; later names are not counted and the result says so', () => {
  const b = V.createBallot({ options: [{ title: 'A' }, { title: 'B' }], endsAt: 0, votersMax: 2 });
  assert.equal(b.cast('a', 1), 'counted');
  assert.equal(b.cast('b', 1), 'counted');
  assert.equal(b.cast('c', 2), 'capped');
  assert.equal(b.voters(), 2);
  const r = b.result();
  assert.deepEqual(r.options.map(o => o.votes), [2, 0]);
  assert.equal(r.capped, true);
  assert.match(V.resultText(r), /voter cap of \d+ was reached/);
});

function fakeSocket() {
  const s = new EventEmitter();
  s.written = [];
  s.destroyed = false;
  s.write = line => { s.written.push(line); return true; };
  s.destroy = () => { s.destroyed = true; };
  s.setEncoding = () => {};
  return s;
}

function fakeTimers() {
  const pending = new Set();
  return {
    pending,
    set(fn, ms) { const t = { fn, ms }; pending.add(t); return t; },
    clear(t) { pending.delete(t); },
    run(filter = () => true) { for (const t of [...pending]) if (filter(t)) { pending.delete(t); t.fn(); } },
  };
}

function collector(opts = {}) {
  const sockets = [];
  const posts = [];
  const logs = [];
  const timers = fakeTimers();
  const votes = V.createVotes({
    config: () => (opts.channel === undefined ? { channel: 'bonestream' } : opts.channel),
    connect: () => {
      const s = fakeSocket();
      sockets.push(s);
      if (opts.autoJoin) queueMicrotask(() => s.emit('data', `${IRC.join}\r\n`));
      return s;
    },
    post: async (url, command) => { posts.push(command); return opts.answer || { ok: true, status: 200 }; },
    streamOptions: () => opts.streamOptions || { url: 'http://127.0.0.1:9' },
    now: () => 1000,
    log: l => logs.push(l),
    timers,
    nick: () => 'justinfan12345',
  });
  return { votes, sockets, posts, logs, timers };
}

const TWO = [{ title: 'Skinning 200' }, { title: 'Skinning 225' }];

test('collector: anonymous read-only login, PONG on PING, and it never sends a chat message', async () => {
  const c = collector();
  assert.equal(c.votes.start({ options: TWO, seconds: 60 }).ok, true);
  const s = c.sockets[0];
  s.emit('data', `${IRC.ping}\r\n${IRC.plain}\r\n`);
  assert.deepEqual(s.written, ['NICK justinfan12345\r\n', 'JOIN #bonestream\r\n', 'PONG :tmi.twitch.tv\r\n']);
  assert.ok(!s.written.some(l => /^(PASS|PRIVMSG)/.test(l)), 'no token and no chat sending');
});

test('collector: one vote per name across lines split over chunks; other channels and bad lines do not count', () => {
  const c = collector();
  c.votes.start({ options: TWO, seconds: 60 });
  const s = c.sockets[0];
  s.emit('data', `${IRC.plain}\r\n${IRC.tagged.slice(0, 40)}`);
  s.emit('data', `${IRC.tagged.slice(40)}\r\n${IRC.plain.replace('!1', '!2')}\r\n${IRC.otherChannel}\r\n${IRC.dupeSuffix}\r\ngarbage\r\n`);
  const r = c.votes.close().result;
  assert.deepEqual(r.options.map(o => o.votes), [1, 1], 'viewer_one changing to !2 is not counted; !3 is out of range for two options');
  assert.equal(r.total, 2);
});

test('collector: an endless line without a newline is dropped, not buffered forever', () => {
  const c = collector();
  c.votes.start({ options: TWO, seconds: 60 });
  const s = c.sockets[0];
  s.emit('data', 'x'.repeat(V.LINE_MAX_BYTES + 10));
  assert.equal(c.votes.buffered(), 0, 'the overlong line is not kept');
  s.emit('data', 'y'.repeat(100));
  assert.equal(c.votes.buffered(), 0, 'its rest is not kept either');
  s.emit('data', `${IRC.plain}\r\n${IRC.tagged}\r\n`);
  assert.deepEqual(c.votes.close().result.options.map(o => o.votes), [0, 1], 'the rest of the overlong line, up to its newline, is discarded; the next line counts');
});

test('collector: off without a channel, one vote at a time, and close releases the socket and timers', () => {
  const off = collector({ channel: { channel: '' } });
  const r = off.votes.start({ options: TWO, seconds: 60 });
  assert.equal(r.ok, false);
  assert.match(r.text, /Votes are off/);
  assert.equal(off.sockets.length, 0, 'no connection when votes are off');

  const c = collector();
  assert.equal(c.votes.start({ options: TWO, seconds: 60 }).ok, true);
  assert.match(c.votes.start({ options: TWO, seconds: 60 }).text, /already open/);
  c.votes.close();
  assert.equal(c.sockets[0].destroyed, true);
  assert.equal(c.timers.pending.size, 0);
  c.sockets[0].emit('data', `${IRC.plain}\r\n`);
  assert.equal(c.votes.last().result.total, 0, 'a vote after close is not counted');
});

test('collector: the timer closes the vote and keeps the result for goal_vote_close', () => {
  const c = collector();
  c.votes.start({ options: TWO, seconds: 30 });
  c.sockets[0].emit('data', `${IRC.plain}\r\n`);
  c.timers.run(t => t.ms === 30000);
  assert.equal(c.votes.isOpen(), false);
  assert.equal(c.votes.last().result.winner, 1);
  assert.equal(c.sockets[0].destroyed, true);
});

test('collector: the overlay gets only options and counts, at most once per push interval, and the final result', async () => {
  const c = collector();
  c.votes.start({ options: TWO, seconds: 60 });
  await new Promise(r => setImmediate(r));
  assert.deepEqual(c.posts[0], { action: 'vote', vote: { open: true, options: [{ n: 1, title: 'Skinning 200', votes: 0 }, { n: 2, title: 'Skinning 225', votes: 0 }], total: 0, endsAt: 61000, winner: null } });
  c.sockets[0].emit('data', `${IRC.plain}\r\n${IRC.tagged}\r\n`);
  assert.equal([...c.timers.pending].filter(t => t.ms === 2000).length, 1, 'two votes schedule one push');
  c.timers.run(t => t.ms === 2000);
  await new Promise(r => setImmediate(r));
  assert.equal(c.posts.length, 2);
  assert.equal(c.posts[1].vote.total, 2);
  c.votes.close();
  await new Promise(r => setImmediate(r));
  assert.equal(c.posts[2].vote.open, false);
  assert.equal(c.posts[2].vote.winner, null);
  assert.ok(c.posts.every(p => Object.keys(p.vote).sort().join() === 'endsAt,open,options,total,winner'), 'no voter names leave the bridge');
});

test('collector: the stream plugin switched off gets no posts', async () => {
  const c = collector({ streamOptions: { enabled: false } });
  c.votes.start({ options: TWO, seconds: 60 });
  c.votes.close();
  await new Promise(r => setImmediate(r));
  assert.equal(c.posts.length, 0);
});

test('collector: a dropped connection reconnects a bounded number of times', () => {
  const c = collector();
  c.votes.start({ options: TWO, seconds: 600 });
  for (let i = 0; i < V.RECONNECTS_MAX + 2; i++) {
    c.sockets[c.sockets.length - 1].emit('error', new Error('reset'));
    c.sockets[c.sockets.length - 1].emit('close');
    c.timers.run(t => t.ms === 5000);
  }
  assert.equal(c.sockets.length, 1 + V.RECONNECTS_MAX);
  assert.ok(c.logs.some(l => /dropped \d+ times/.test(l)));
  assert.equal(c.timers.pending.size, 1, 'only the end timer is left');
  assert.equal(c.votes.isOpen(), true, 'the vote stays open and can still be closed');
  assert.equal(c.votes.close().result.total, 0);
});

test('collector: votes on a reconnected socket count; the dropped one is ignored', () => {
  const c = collector();
  c.votes.start({ options: TWO, seconds: 600 });
  c.sockets[0].emit('close');
  c.timers.run(t => t.ms === 5000);
  c.sockets[0].emit('data', `${IRC.plain}\r\n`);
  c.sockets[1].emit('data', `${IRC.tagged}\r\n`);
  assert.deepEqual(c.votes.close().result.options.map(o => o.votes), [0, 1]);
});

const BONE_CONTEXT = [
  'Game: World of Warcraft: Forever (client 1.60.1.70124, interface 16001)',
  'Character: Bone on Classic Beta PvP 2, level 20 Orc Rogue (Horde)',
  'Professions: Leatherworking 107/150, Skinning 187/225',
].join('\n');
const WOWDATA = path.join(__dirname, 'fixtures', 'wowdata');

function goalRig(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-votes-'));
  const c = collector({ autoJoin: true });
  let ctx = { text: opts.ctx || BONE_CONTEXT, at: 1000 };
  const opened = { count: 0 };
  const store = G.createGoals({
    dir, context: () => ctx, now: () => 2000, votes: opts.noVotes ? null : c.votes,
    streamOptions: () => ({ enabled: false }),
    gameData: text => { opened.count += 1; return GD.openStore({ dataDir: WOWDATA, clientBuild: GD.clientBuildOf(text) }); },
  });
  const file = path.join(dir, 'Bone-ClassicBetaPvP2', G.GOALS_FILE);
  return { store, c, file, opened, dir, read: () => JSON.parse(fs.readFileSync(file, 'utf8')), setContext: text => { ctx = { text, at: 1000 }; }, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const SKIN_OPTIONS = [{ profession: 'Skinning', rank: 200 }, { profession: 'Skinning', rank: 225 }];

test('goal_vote_open: options get the goal_set checks, titles come from the bridge, and nothing is written', async () => {
  const r = goalRig();
  try {
    const res = await r.store.call('goal_vote_open', { options: [...SKIN_OPTIONS, { type: 'gearset', slots: { 16: 501 } }], seconds: 60 });
    assert.equal(res.ok, true, res.text);
    assert.match(res.text, /!1 Skinning 200, !2 Skinning 225, !3 Gear set: Fixture Blade\. Viewers type !1 to !3; one vote per Twitch name\. The stream overlay shows it only with a wow-stream that has the "vote" action\./);
    assert.equal(fs.existsSync(r.file), false, 'opening a vote writes no goal');
  } finally { r.cleanup(); }
});

test('goal_vote_open: refuses bad option counts, invalid goals, duplicates, drops, bad seconds, and no collector', async () => {
  const r = goalRig();
  try {
    const refuse = async (args, re) => {
      const res = await r.store.call('goal_vote_open', args);
      assert.equal(res.ok, false, JSON.stringify(args));
      assert.match(res.text, re);
    };
    await refuse({ options: [SKIN_OPTIONS[0]], seconds: 60 }, /needs 2 to 3 options/);
    await refuse({ options: [...SKIN_OPTIONS, SKIN_OPTIONS[0], SKIN_OPTIONS[1]], seconds: 60 }, /needs 2 to 3 options/);
    await refuse({ options: 'two', seconds: 60 }, /needs 2 to 3 options/);
    await refuse({ options: [SKIN_OPTIONS[0], { profession: 'Tailoring', rank: 50 }], seconds: 60 }, /Option 2: The game has not reported a profession called "Tailoring"/);
    await refuse({ options: [SKIN_OPTIONS[0], { type: 'gearset', slots: { 16: 2318 } }], seconds: 60 }, /Option 2: .*\{item:2318\} is not in the Forever client data/);
    await refuse({ options: [SKIN_OPTIONS[0], { profession: 'skinning', rank: 200 }], seconds: 60 }, /Option 2 is the same goal/);
    await refuse({ options: [SKIN_OPTIONS[0], { profession: 'Leatherworking', drop: true }], seconds: 60 }, /cannot drop one/);
    await refuse({ options: SKIN_OPTIONS, seconds: 5 }, /seconds must be a whole number from 15 to 900/);
    await refuse({ options: SKIN_OPTIONS, seconds: 9999 }, /seconds must be/);
    assert.equal(r.c.votes.isOpen(), false, 'no refused call opened a vote');
  } finally { r.cleanup(); }
  const none = goalRig({ noVotes: true });
  try {
    assert.match((await none.store.call('goal_vote_open', { options: SKIN_OPTIONS, seconds: 60 })).text, /no vote collector/);
    assert.match((await none.store.call('goal_vote_close', {})).text, /no vote collector/);
  } finally { none.cleanup(); }
});

test('goal_vote_close: adopt writes the single winner through the goal_set path, once', async () => {
  const r = goalRig();
  try {
    assert.equal((await r.store.call('goal_vote_open', { options: SKIN_OPTIONS, seconds: 60 })).ok, true);
    r.c.sockets[0].emit('data', `${IRC.plain.replace('!1', '!2')}\r\n${IRC.tagged}\r\n${IRC.dupeSuffix.replace('!3', '!1')}\r\n`);
    const res = await r.store.call('goal_vote_close', { adopt: true });
    assert.equal(res.ok, true, res.text);
    assert.match(res.text, /Closed the vote\. !1 Skinning 200: 1; !2 Skinning 225: 2\. 3 voters\. Winner: !2\. Set the goal "Skinning 225"/);
    const doc = r.read();
    assert.equal(doc.goals.length, 1);
    assert.deepEqual(doc.goals[0].target, { skillID: 393, rank: 225 });
    assert.equal(doc.goals[0].createdBy, 'vote');
    const again = await r.store.call('goal_vote_close', { adopt: true });
    assert.equal(again.ok, false);
    assert.match(again.text, /already adopted/);
    assert.equal(r.read().rev, 1, 'the second adopt wrote nothing');
  } finally { r.cleanup(); }
});

test('goal_vote_close: a tie or no votes adopts nothing; without adopt it only reports', async () => {
  const r = goalRig();
  try {
    await r.store.call('goal_vote_open', { options: SKIN_OPTIONS, seconds: 60 });
    r.c.sockets[0].emit('data', `${IRC.plain}\r\n${IRC.tagged}\r\n`);
    const tie = await r.store.call('goal_vote_close', { adopt: true });
    assert.equal(tie.ok, true);
    assert.match(tie.text, /No winner: a tie\. Nothing was adopted\./);
    assert.equal(fs.existsSync(r.file), false);
    await r.store.call('goal_vote_open', { options: SKIN_OPTIONS, seconds: 60 });
    r.c.sockets[1].emit('data', `${IRC.plain}\r\n`);
    const look = await r.store.call('goal_vote_close', {});
    assert.match(look.text, /Winner: !1\.$/);
    assert.equal(fs.existsSync(r.file), false, 'closing without adopt writes nothing');
    assert.match((await r.store.call('goal_vote_close', { adopt: true })).text, /The vote had already closed\..*Set the goal "Skinning 200"/);
  } finally { r.cleanup(); }
  const empty = goalRig();
  try { assert.match((await empty.store.call('goal_vote_close', {})).text, /There is no vote to close/); } finally { empty.cleanup(); }
});

test('goal_vote_close: the winner is checked again at adoption and refused when it no longer passes', async () => {
  const r = goalRig();
  try {
    await r.store.call('goal_vote_open', { options: SKIN_OPTIONS, seconds: 60 });
    r.c.sockets[0].emit('data', `${IRC.plain}\r\n`);
    r.setContext(BONE_CONTEXT.replace(', Skinning 187/225', ''));
    const res = await r.store.call('goal_vote_close', { adopt: true });
    assert.equal(res.ok, false);
    assert.match(res.text, /failed the goal check now and was not adopted: The game has not reported a profession called "Skinning"/);
    assert.equal(fs.existsSync(r.file), false);
  } finally { r.cleanup(); }
});

test('IRC parsing: JOIN and end of NAMES (366) confirm the channel', () => {
  assert.deepEqual(V.parseIrcLine(IRC.join), { type: 'joined', channel: 'bonestream' });
  assert.deepEqual(V.parseIrcLine(':justinfan12345.tmi.twitch.tv 366 justinfan12345 #bonestream :End of /NAMES list'), { type: 'joined', channel: 'bonestream' });
  assert.equal(V.parseIrcLine(':tmi.twitch.tv 366 justinfan12345 bonestream :End'), null);
});

test('collector: no JOIN within the connect timeout drops the socket and reconnects; the result says chat was missing', () => {
  const c = collector();
  c.votes.start({ options: TWO, seconds: 600 });
  c.timers.run(t => t.ms === V.CONNECT_TIMEOUT_MS);
  assert.equal(c.sockets[0].destroyed, true);
  c.timers.run(t => t.ms === 5000);
  assert.equal(c.sockets.length, 2);
  c.timers.run(t => t.ms === V.CONNECT_TIMEOUT_MS);
  c.timers.run(t => t.ms === 5000);
  assert.equal(c.sockets.length, 3);
  c.sockets[2].emit('data', `${IRC.join}\r\n${IRC.plain}\r\n`);
  assert.equal([...c.timers.pending].some(t => t.ms === V.CONNECT_TIMEOUT_MS), false, 'the JOIN cleared the connect timer');
  const rec = c.votes.close();
  assert.equal(rec.result.chatMissed, true);
  assert.match(V.resultText(rec.result), /Twitch chat was not connected for part of the vote/);
  assert.equal(c.logs.filter(l => /Twitch chat is not connected/.test(l)).length, 1, 'said once');
});

test('collector: a joined connection that goes quiet past the idle timeout is dropped and reconnected; data keeps it alive', () => {
  const c = collector();
  c.votes.start({ options: TWO, seconds: 900 });
  c.sockets[0].emit('data', `${IRC.join}\r\n`);
  assert.equal([...c.timers.pending].filter(t => t.ms === V.IDLE_TIMEOUT_MS).length, 1);
  c.sockets[0].emit('data', `${IRC.ping}\r\n`);
  assert.equal([...c.timers.pending].filter(t => t.ms === V.IDLE_TIMEOUT_MS).length, 1, 'data rearms one idle timer');
  c.timers.run(t => t.ms === V.IDLE_TIMEOUT_MS);
  assert.equal(c.sockets[0].destroyed, true);
  c.timers.run(t => t.ms === 5000);
  assert.equal(c.sockets.length, 2);
});

test('collector: a vote whose chat never joined says so; one that stayed joined does not', () => {
  const never = collector();
  never.votes.start({ options: TWO, seconds: 60 });
  assert.equal(never.votes.close().result.chatMissed, true);
  const fine = collector();
  fine.votes.start({ options: TWO, seconds: 60 });
  fine.sockets[0].emit('data', `${IRC.join}\r\n${IRC.plain}\r\n`);
  const r = fine.votes.close().result;
  assert.equal(r.chatMissed, false);
  assert.doesNotMatch(V.resultText(r), /not connected/);
});

test('collector: a stream service without the vote action is logged once, with a clear line', async () => {
  const c = collector({ answer: { ok: false, status: 400, message: 'Unknown action: vote' } });
  c.votes.start({ options: TWO, seconds: 60 });
  c.votes.close();
  c.votes.start({ options: TWO, seconds: 60 });
  c.votes.close();
  await new Promise(r => setImmediate(r));
  const said = c.logs.filter(l => /no "vote" action/.test(l));
  assert.equal(said.length, 1, c.logs.join('\n'));
  assert.match(said[0], /the overlay shows votes only with a wow-stream that has it/);
  assert.equal(c.logs.filter(l => /did not take the vote display/.test(l)).length, 0);
});

test('collector: stop() tells the overlay the vote is closed before it lets go', async () => {
  const c = collector();
  c.votes.start({ options: TWO, seconds: 60 });
  c.votes.stop();
  await new Promise(r => setImmediate(r));
  assert.equal(c.posts[c.posts.length - 1].vote.open, false);
  assert.equal(c.sockets[0].destroyed, true);
  assert.equal(c.timers.pending.size, 0);
});

const CONTRACT = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'stream', 'vote.json'), 'utf8'));

function contractProblems(p) {
  const problems = [];
  const keys = o => Object.keys(o).sort().join(',');
  if (keys(p) !== keys(CONTRACT)) problems.push(`top keys ${keys(p)}`);
  if (p.action !== CONTRACT.action) problems.push(`action ${p.action}`);
  const v = p.vote || {};
  if (keys(v) !== keys(CONTRACT.vote)) problems.push(`vote keys ${keys(v)}`);
  if (typeof v.open !== 'boolean') problems.push('open');
  if (!Array.isArray(v.options) || v.options.length < V.OPTIONS_MIN || v.options.length > V.OPTIONS_MAX) problems.push('options length');
  for (const [i, o] of (v.options || []).entries()) {
    if (keys(o) !== keys(CONTRACT.vote.options[0])) problems.push(`option keys ${keys(o)}`);
    if (o.n !== i + 1) problems.push(`n ${o.n}`);
    if (typeof o.title !== 'string' || !o.title || o.title.length > V.TITLE_MAX) problems.push(`title ${o.title}`);
    if (!Number.isSafeInteger(o.votes) || o.votes < 0) problems.push(`votes ${o.votes}`);
  }
  if (!Number.isSafeInteger(v.total) || v.total !== (v.options || []).reduce((s, o) => s + o.votes, 0)) problems.push(`total ${v.total}`);
  if (!Number.isSafeInteger(v.endsAt) || v.endsAt <= 0) problems.push(`endsAt ${v.endsAt}`);
  if (!(v.winner === null || (Number.isSafeInteger(v.winner) && v.winner >= 1 && v.winner <= (v.options || []).length))) problems.push(`winner ${v.winner}`);
  if (v.open && v.winner !== null) problems.push('an open vote has a winner');
  return problems;
}

test('overlay contract: the shared wow-stream fixture passes the shape check, and so does every payload the bridge sends', async () => {
  assert.deepEqual(contractProblems(CONTRACT), []);
  assert.equal(V.TITLE_MAX, 60, 'the wow-stream title cap');
  const c = collector();
  c.votes.start({ options: [...TWO, { title: 'Gear set: Fixture Blade' }], seconds: 60 });
  c.sockets[0].emit('data', `${IRC.join}\r\n${IRC.plain}\r\n${IRC.tagged}\r\n${IRC.dupeSuffix.replace('!3', '!1')}\r\n`);
  c.timers.run(t => t.ms === 2000);
  c.votes.close();
  await new Promise(r => setImmediate(r));
  assert.equal(c.posts.length, 3);
  for (const p of c.posts) assert.deepEqual(contractProblems(p), [], JSON.stringify(p));
  assert.deepEqual(c.posts[2].vote, { open: false, options: [{ n: 1, title: 'Skinning 200', votes: 2 }, { n: 2, title: 'Skinning 225', votes: 1 }, { n: 3, title: 'Gear set: Fixture Blade', votes: 0 }], total: 3, endsAt: 61000, winner: 1 });
  assert.notDeepEqual(contractProblems({ ...CONTRACT, vote: { ...CONTRACT.vote, extra: 1 } }), [], 'the check itself rejects a changed shape');
});

test('collector: an option title longer than the overlay cap is refused before anything opens', () => {
  const c = collector();
  const r = c.votes.start({ options: [TWO[0], { title: 'x'.repeat(V.TITLE_MAX + 1) }], seconds: 60 });
  assert.equal(r.ok, false);
  assert.match(r.text, /over 60 characters/);
  assert.equal(c.sockets.length, 0);
  assert.equal(c.posts.length, 0);
});

test('goal_vote_close: adopt refuses when the game now reports another character than the vote was opened for', async () => {
  const r = goalRig();
  try {
    await r.store.call('goal_vote_open', { options: SKIN_OPTIONS, seconds: 60 });
    r.c.sockets[0].emit('data', `${IRC.plain}\r\n`);
    r.setContext(BONE_CONTEXT.replace('Character: Bone on', 'Character: Alt on'));
    const res = await r.store.call('goal_vote_close', { adopt: true });
    assert.equal(res.ok, false);
    assert.match(res.text, /opened for Bone-ClassicBetaPvP2, but the game now reports Alt-ClassicBetaPvP2; nothing was adopted/);
    assert.equal(fs.existsSync(path.join(r.dir, 'Alt-ClassicBetaPvP2')), false);
    r.setContext(BONE_CONTEXT);
    assert.equal((await r.store.call('goal_vote_close', { adopt: true })).ok, true, 'back on the right character it adopts');
  } finally { r.cleanup(); }
});

test('goal_vote_open: gear set options show their item names, and two options with the same title are refused', async () => {
  const r = goalRig();
  try {
    const same = await r.store.call('goal_vote_open', { options: [{ type: 'gearset', slots: { 16: 501 } }, { type: 'gearset', slots: { 17: 501 } }], seconds: 60 });
    assert.equal(same.ok, false);
    assert.match(same.text, /Option 2 has the same title as an earlier option \("Gear set: Fixture Blade"\)/);
    const differ = await r.store.call('goal_vote_open', { options: [{ type: 'gearset', slots: { 16: 501 } }, { type: 'gearset', slots: { 16: 501, 17: 501 } }], seconds: 60 });
    assert.equal(differ.ok, true, differ.text);
    assert.match(differ.text, /!1 Gear set: Fixture Blade, !2 Gear set: 2x Fixture Blade/);
  } finally { r.cleanup(); }
});

test('goal_vote_open: refused when adopting an option would pass the goal limit', async () => {
  const names = Object.values(G.PROFESSION_SKILL_IDS).slice(0, 9);
  const ctx = `Game: World of Warcraft: Forever (client 1.60.1.70124, interface 16001)\nCharacter: Bone on Classic Beta PvP 2, level 20 Orc Rogue (Horde)\nProfessions: ${names.map(n => `${n} 1/75`).join(', ')}`;
  const r = goalRig({ ctx });
  try {
    for (const n of names.slice(0, G.ACTIVE_GOALS_MAX)) assert.equal((await r.store.call('goal_set', { profession: n, rank: 50 })).ok, true);
    const res = await r.store.call('goal_vote_open', { options: [{ profession: names[0], rank: 60 }, { profession: names[8], rank: 60 }], seconds: 60 });
    assert.equal(res.ok, false);
    assert.match(res.text, /Option 2 would be a new goal, and there are already 8 goals/);
    assert.equal(r.c.votes.isOpen(), false);
  } finally { r.cleanup(); }
});

test('goal_vote_close: a corrupt goals.json never blocks closing a vote; only adopting needs it', async () => {
  const r = goalRig();
  try {
    await r.store.call('goal_vote_open', { options: SKIN_OPTIONS, seconds: 60 });
    r.c.sockets[0].emit('data', `${IRC.plain}\r\n`);
    fs.mkdirSync(path.dirname(r.file), { recursive: true });
    fs.writeFileSync(r.file, '{broken');
    const closed = await r.store.call('goal_vote_close', {});
    assert.equal(closed.ok, true, closed.text);
    assert.match(closed.text, /Closed the vote\./);
    const adopt = await r.store.call('goal_vote_close', { adopt: true });
    assert.equal(adopt.ok, false);
    assert.match(adopt.text, /not valid JSON/);
    assert.equal(fs.readFileSync(r.file, 'utf8'), '{broken', 'the bad file is left alone');
    assert.match((await r.store.call('goal_vote_open', { options: SKIN_OPTIONS, seconds: 60 })).text, /needs a readable goal store/);
  } finally { r.cleanup(); }
});

test('goal_vote_open: the game data is opened once for all options', async () => {
  const r = goalRig();
  try {
    const res = await r.store.call('goal_vote_open', { options: [{ type: 'gearset', slots: { 16: 501 } }, { type: 'gearset', slots: { 11: 505 } }, { type: 'gearset', slots: { 1: 510 } }], seconds: 60 });
    assert.equal(res.ok, true, res.text);
    assert.equal(r.opened.count, 1);
  } finally { r.cleanup(); }
});
