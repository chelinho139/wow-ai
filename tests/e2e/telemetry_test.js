'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const SB = require('../../dev/sandbox');
const SIG = require('../../bridge/signals');
const TL = require('../../bridge/telemetry');
const { encodePng, luaQuote } = require('../../dev/wow/client');
const { makeRoot, gameRunner } = require('./helpers');

const ROOT = makeRoot('telemetry');
const withGame = gameRunner(ROOT);
const RECORDS = 300;
const PER_FRAME = 20;
const CELL = 4;
const CELLS = 200;
const WIDTH = 1920;
const HEIGHT = 1080;
const SLOTS = 200;
const CHARACTER = 'Testchar-TestRealm';

function spentSlots(sb, kind) {
  const out = [];
  for (let slot = 1; slot <= SLOTS; slot++) if (!fs.existsSync(SIG.signalFile(sb.addons, kind, slot))) out.push(slot);
  return out;
}

function gsRecord(session, seq) {
  const money = String(1000 + seq);
  const hash = String(seq).padStart(8, '0');
  return [session, '', String(seq), '', 'kind=gs', CHARACTER, `gs1\nmoney:${hash}:${money}`].join('\x1F');
}

function stripCells(client, payload) {
  return client.luaValue(`(function() local c = ClaudeWoW_Codec.Encode(0, ${luaQuote(payload)}, 1); local t = {}; for i = 1, #c do t[i] = c[i] end; return table.concat(t, ",") end)()`).split(',').map(Number);
}

function writeShot(sb, client, payload, n) {
  const cells = stripCells(client, payload);
  const rgb = Buffer.alloc(WIDTH * HEIGHT * 3);
  cells.forEach((v, i) => {
    const r = Math.floor(i / CELLS), c = i % CELLS;
    const lv = [(v >> 2) & 1, (v >> 1) & 1, v & 1].map(b => (b ? 255 : 0));
    for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) {
      const o = ((r * CELL + y) * WIDTH + c * CELL + x) * 3;
      rgb[o] = lv[0]; rgb[o + 1] = lv[1]; rgb[o + 2] = lv[2];
    }
  });
  const file = path.join(sb.screenshots, `WoWScrnShot_010199_${String(n).padStart(6, '0')}.png`);
  fs.writeFileSync(SB.assertSafe(file), encodePng(WIDTH, HEIGHT, rgb));
  return file;
}

async function sendRecords(h, session, seqs, frameNo) {
  for (let i = 0; i < seqs.length; i += PER_FRAME) {
    const payload = seqs.slice(i, i + PER_FRAME).map(seq => gsRecord(session, seq)).join('\x1E');
    const file = writeShot(h.sb, h.client, payload, frameNo++);
    await h.client.waitFor(() => !fs.existsSync(file), { timeoutMs: 20000, label: `the bridge to read ${path.basename(file)}` });
  }
  return frameNo;
}

test('300 gs records whose seqs overlap the message ids spend no ack or sig file, leave lastId alone, and a message sent between them is answered', async () => {
  await withGame({}, async h => {
    h.client.runLua('ClaudeWoWTelemetry.Take = function() return nil end');
    const first = await h.client.say('before the telemetry');
    assert.match(first.text, /before the telemetry/);
    await h.bridge.waitForLine(/game context updated: Character: Testchar/);
    const session = h.client.db().session;
    const ackBefore = spentSlots(h.sb, 'ack');
    const sigBefore = spentSlots(h.sb, 'sig');
    const lastIdBefore = h.state().lastId;
    assert.ok(lastIdBefore < RECORDS, `message ids (${lastIdBefore}) sit inside the gs seq range, the case a shared id space would break`);

    const seqs = Array.from({ length: RECORDS }, (_, i) => i + 1);
    let frameNo = await sendRecords(h, session, seqs.slice(0, RECORDS / 2), 1);
    const between = await h.client.say('sent between the records');
    assert.match(between.text, /sent between the records/, 'the real message was not taken for a duplicate');
    assert.ok(between.id <= RECORDS / 2, `its id ${between.id} was already used as a gs seq`);
    frameNo = await sendRecords(h, session, seqs.slice(RECORDS / 2), frameNo);

    const snapFile = path.join(h.sb.home, 'goals', CHARACTER, TL.SNAPSHOT_FILE);
    const snap = await h.client.waitFor(() => {
      try { const s = JSON.parse(fs.readFileSync(snapFile, 'utf8')); return s.seq === RECORDS ? s : null; } catch { return null; }
    }, { timeoutMs: 20000, label: 'the snapshot at seq 300' });
    assert.deepEqual(snap.sections.money.value, { copper: 1000 + RECORDS });
    assert.equal(snap.session, session);
    const events = fs.readFileSync(path.join(h.sb.home, 'goals', CHARACTER, TL.EVENTS_FILE), 'utf8').trim().split('\n');
    assert.equal(events.length, RECORDS - 1, 'one money event per record after the baseline');

    const slotB = ((between.id - 1) % SLOTS) + 1;
    const newAcks = spentSlots(h.sb, 'ack').filter(s => !ackBefore.includes(s));
    const newSigs = spentSlots(h.sb, 'sig').filter(s => !sigBefore.includes(s));
    assert.deepEqual(newAcks, [slotB], 'only the real message spent an ack file');
    assert.deepEqual(newSigs.filter(s => s !== slotB), [], 'only the real message spent a sig file');
    const state = h.state();
    assert.equal(state.lastId, between.id, 'lastId is the last message id, never a gs seq');
    assert.ok(Object.keys(state.handled[session]).every(id => Number(id) <= between.id), 'no gs seq in the message dedupe map');
    assert.equal(h.agentCalls().length, 2, 'no gs record ever reached an agent');
    assert.doesNotMatch(h.bridge.output, /gs1/, 'no gs text was logged or run as a prompt');
    const published = new RegExp(`\\{ character = "${CHARACTER}", session = "${session}", seq = ${RECORDS}, hashes = \\{ money = "${String(RECORDS).padStart(8, '0')}" \\} \\}`);
    await h.client.waitFor(() => published.test(fs.readFileSync(path.join(h.sb.addons, 'ClaudeWoW_S001', 'Inbox.lua'), 'utf8')), { timeoutMs: 45000, label: 'the slot files to publish the gs hashes' });
  });
});

test('the real addon sends its game state on a telemetry-only screenshot once the bridge advertises gs, and the bridge keeps it', async () => {
  await withGame({}, async h => {
    await h.client.say('hello');
    const snapFile = path.join(h.sb.home, 'goals', CHARACTER, TL.SNAPSHOT_FILE);
    const snap = await h.client.waitFor(() => {
      try { const s = JSON.parse(fs.readFileSync(snapFile, 'utf8')); return s.sections.level ? s : null; } catch { return null; }
    }, { timeoutMs: 60000, label: 'the first gs record in snapshot.json' });
    assert.equal(snap.session, h.client.db().session);
    assert.deepEqual(snap.sections.level.value, { level: 23, xp: 1234, xpMax: 5000 });
    assert.deepEqual(snap.sections.zone.value, { mapID: 1431 });
    assert.ok(Array.isArray(snap.sections.cap.value.missing));
    await h.bridge.waitForLine(/telemetry: Testchar-TestRealm's game client is missing /);
    assert.equal(h.agentCalls().length, 1);
  });
});

test('a frame of [message, gs rider] from the real addon and a frame of [gs, message] each answer the message and spend exactly its one ack and one sig', async () => {
  await withGame({ client: { speed: 8 }, speed: 8 }, async h => {
    await h.client.say('warm up');
    const snapFile = path.join(h.sb.home, 'goals', CHARACTER, TL.SNAPSHOT_FILE);
    const readSnap = () => { try { return JSON.parse(fs.readFileSync(snapFile, 'utf8')); } catch { return null; } };
    await h.client.waitFor(() => { const s = readSnap(); return s && s.sections.money; }, { timeoutMs: 60000, label: 'the first gs record' });
    await new Promise(r => setTimeout(r, 5000));
    const session = h.client.db().session;

    h.client.runLua('ClaudeWoWDB.stream = ClaudeWoWDB.stream or {}; ClaudeWoWDB.stream.follow = false');
    const slotOf = n => ((n - 1) % SLOTS) + 1;
    const ackBefore = spentSlots(h.sb, 'ack');
    const sigBefore = spentSlots(h.sb, 'sig');
    h.client.runLua('STUB.money = STUB.money + 77');
    const mark = h.bridge.output.length;
    const ridden = await h.client.say('message with a rider');
    assert.match(ridden.text, /message with a rider/);
    await h.bridge.waitForLine(new RegExp(`telemetry: gs #\\d+@${session} for ${CHARACTER}: money`), { from: mark });
    const after = h.bridge.output.slice(mark).split('\n');
    const frameAt = after.findIndex(l => new RegExp(`strip #${ridden.id % 65536} \\(screenshot `).test(l));
    assert.ok(frameAt >= 0, 'the message went out on a screenshot frame');
    const nextFrame = after.findIndex((l, i) => i > frameAt && /strip #\d+ \(screenshot /.test(l));
    const frameLines = after.slice(frameAt, nextFrame < 0 ? undefined : nextFrame);
    const gsLine = frameLines.find(l => /telemetry: gs #\d+@/.test(l));
    assert.ok(gsLine, 'a gs record rode in the same frame as the message');
    const gsSeq = Number(/telemetry: gs #(\d+)@/.exec(gsLine)[1]);
    assert.equal(readSnap().sections.money.value.copper, 12345 + 77);
    const slotA = slotOf(ridden.id);
    const newAcks = spentSlots(h.sb, 'ack').filter(s => !ackBefore.includes(s));
    const newSigs = spentSlots(h.sb, 'sig').filter(s => !sigBefore.includes(s));
    assert.deepEqual(newAcks, [slotA], 'only the message spent an ack file');
    assert.deepEqual(newSigs, [slotA], 'only the message spent a sig file');
    if (slotOf(gsSeq) === slotA) console.warn(`SKIPPED: gs seq ${gsSeq} shares slot ${slotA} with the message, so its own spend cannot be told apart this run`);
    else assert.ok(!newAcks.includes(slotOf(gsSeq)) && !newSigs.includes(slotOf(gsSeq)), 'the gs seq spent nothing');

    const ackMid = spentSlots(h.sb, 'ack');
    const sigMid = spentSlots(h.sb, 'sig');
    const calls = h.agentCalls().length;
    const id = h.client.lastSeq() + 50;
    const chat = h.client.activeChat().id;
    const message = [session, chat, String(id), '', '', 'Chat 1', 'gs first, then this'].join('\x1F');
    let craftedSeq = 2000000000;
    while (slotOf(craftedSeq) === slotOf(id)) craftedSeq += 1;
    const file = writeShot(h.sb, h.client, [gsRecord(session, craftedSeq), message].join('\x1E'), 900);
    await h.client.waitFor(() => !fs.existsSync(file), { timeoutMs: 20000, label: 'the bridge to read the crafted frame' });
    await h.client.waitFor(() => h.agentCalls().length > calls, { timeoutMs: 30000, label: 'the message after the gs record to run' });
    const slotB = slotOf(id);
    await h.client.waitFor(() => !fs.existsSync(SIG.signalFile(h.sb.addons, 'sig', slotB)), { timeoutMs: 30000, label: 'its reply signal' });
    const newAcksB = spentSlots(h.sb, 'ack').filter(s => !ackMid.includes(s));
    const newSigsB = spentSlots(h.sb, 'sig').filter(s => !sigMid.includes(s));
    assert.deepEqual(newAcksB, [slotB], 'only the message after the gs record spent an ack file');
    assert.deepEqual(newSigsB, [slotB], 'only the message after the gs record spent a sig file');
    assert.notEqual(slotOf(craftedSeq), slotB);
    assert.equal(h.state().lastId, id);
  });
});

test.after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});
