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
  assert.equal(V.parseIrcLine(IRC.join), null);
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
    connect: () => { const s = fakeSocket(); sockets.push(s); return s; },
    post: async (url, command) => { posts.push(command); return { ok: true, status: 200 }; },
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
  s.emit('data', `${IRC.plain}\r\n`);
  assert.equal(c.votes.close().result.options[0].votes, 1);
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
  const c = collector();
  let ctx = { text: BONE_CONTEXT, at: 1000 };
  const store = G.createGoals({
    dir, context: () => ctx, now: () => 2000, votes: opts.noVotes ? null : c.votes,
    streamOptions: () => ({ enabled: false }),
    gameData: text => GD.openStore({ dataDir: WOWDATA, clientBuild: GD.clientBuildOf(text) }),
  });
  const file = path.join(dir, 'Bone-ClassicBetaPvP2', G.GOALS_FILE);
  return { store, c, file, read: () => JSON.parse(fs.readFileSync(file, 'utf8')), setContext: text => { ctx = { text, at: 1000 }; }, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const SKIN_OPTIONS = [{ profession: 'Skinning', rank: 200 }, { profession: 'Skinning', rank: 225 }];

test('goal_vote_open: options get the goal_set checks, titles come from the bridge, and nothing is written', async () => {
  const r = goalRig();
  try {
    const res = await r.store.call('goal_vote_open', { options: [...SKIN_OPTIONS, { type: 'gearset', slots: { 16: 501 } }], seconds: 60 });
    assert.equal(res.ok, true, res.text);
    assert.match(res.text, /!1 Skinning 200, !2 Skinning 225, !3 Gear set: 1 item/);
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
