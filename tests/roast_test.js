'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const P = require('../bridge/protocol');
const PL = require('../bridge/plugins');
const roast = require('../bridge/plugins/roast');
const stream = require('../bridge/plugins/stream');

const RECAP = [
  'Death recap: a level 23 Night Elf Hunter just died in Duskwood - Darkshire.',
  'Hits taken in the last 10 s, oldest first:',
  '-0.2s Hogger (level 11): Melee 52, overkill 17 <- killing blow',
  'Damage taken: 52 from 1 source. Killing blow: Hogger\'s Melee.',
].join('\n');

const noop = () => {};

function fakeCore(scratch) {
  const calls = [];
  const core = {
    log: noop, tag: j => '#' + j.id, defaultCwd: '/some/project',
    options: id => (id === 'roast' ? { cwd: scratch } : {}),
    sessionFolder: () => '',
    fail: (job, text) => calls.push({ fail: text }),
    runAgent: (job, opts) => calls.push({ run: opts, text: job.text }),
  };
  return { core, calls };
}

test('the kind flag: parsed only when present and well formed, next to every other flag', () => {
  assert.equal(P.parseFlags('').kind, undefined, 'a record from an addon without kinds parses as before');
  assert.equal(P.parseFlags('kind=roast').kind, 'roast');
  assert.equal(P.parseFlags('kind=ROAST').kind, 'roast');
  assert.equal(P.parseFlags('kind=').kind, undefined);
  assert.equal(P.parseFlags('kind=../x').kind, undefined);
  const all = P.parseFlags('n;agent=codex;plugin=roast;v;kind=roast;c');
  assert.deepEqual(
    { newSession: all.newSession, agent: all.agent, plugin: all.plugin, vision: all.vision, kind: all.kind, context: all.context },
    { newSession: true, agent: 'codex', plugin: 'roast', vision: true, kind: 'roast', context: true },
  );
});

test('a roast record round-trips through the strip payload with its kind, plugin, vision flag and recap text', () => {
  const record = ['sess1', 'chat9', '42', '', 'plugin=roast;v;kind=roast', 'Death roasts', RECAP].join('\x1F');
  const [job] = P.jobsFromStrip(42, record);
  assert.equal(job.kind, 'roast');
  assert.equal(job.plugin, 'roast');
  assert.equal(job.vision, true);
  assert.equal(job.chat, 'chat9');
  assert.equal(job.id, 42);
  assert.equal(job.text, RECAP);
  const withContext = ['sess1', 'chat9', '43', '', 'plugin=roast;kind=roast;c', 'Death roasts', 'Location: Duskwood', RECAP].join('\x1F');
  const [ctxJob] = P.jobsFromStrip(43, withContext);
  assert.equal(ctxJob.kind, 'roast');
  assert.equal(ctxJob.ctx, 'Location: Duskwood');
  assert.equal(ctxJob.text, RECAP);
});

test('routing: a chat bound to roast goes there, an unbound roast-kind message is matched, anything else is left alone', () => {
  const reg = PL.createRegistry();
  reg.register(require('../bridge/plugins/ask'));
  reg.register(require('../bridge/plugins/claude-code'));
  reg.register(roast);
  assert.deepEqual(reg.ids(), ['ask', 'claude-code', 'roast'], 'registered after the others, so never the default');
  assert.equal(reg.route({ text: RECAP, plugin: 'roast', kind: 'roast' }).plugin.id, 'roast');
  assert.equal(reg.route({ text: RECAP, kind: 'roast' }).plugin.id, 'roast', 'match() catches a roast-kind message on an unbound chat');
  assert.equal(reg.route({ text: 'what drops the sword' }).plugin.id, 'ask');
  assert.equal(reg.route({ text: 'nice one', plugin: 'roast' }).plugin.id, 'roast');
});

test('the roast plugin: the stable instructions are in the system prompt, the recap is wrapped as a roast request, and talk-back is not', () => {
  const reg = PL.createRegistry();
  const p = reg.register(roast);
  assert.deepEqual(p.surfaces, [], 'a roast never marks the map or makes macros');
  assert.ok(p.tools.includes('two or three sentences'));
  assert.ok(p.tools.includes('Punch at the play, never at the person'));
  assert.ok(p.tools.includes('No slurs'));
  const system = P.systemPrompt('Location: Duskwood', '', { tools: p.tools });
  assert.ok(system.includes(roast.TOOLS), 'the roast rules ride in the stable system prompt');

  assert.equal(roast.isRoast({ kind: 'roast', text: 'x' }), true);
  assert.equal(roast.isRoast({ text: RECAP }), true, 'a resend without the kind flag is still a recap');
  assert.equal(roast.isRoast({ text: 'lol unfair' }), false);

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wowai-roast-'));
  const scratch = path.join(base, 'scratch');
  const { core, calls } = fakeCore(scratch);
  p.handle({ id: 1, kind: 'roast', text: RECAP }, core);
  assert.equal(calls[0].run.cwd, scratch, 'runs in a scratch folder, never a project');
  assert.ok(fs.existsSync(scratch));
  assert.ok(calls[0].text.startsWith('I just died. Roast this death'), calls[0].text);
  assert.ok(calls[0].text.endsWith(RECAP));
  const prompt = P.messagePrompt(calls[0].text, 'Location: Duskwood', { image: { width: 1280, height: 720 } });
  assert.ok(prompt.includes('screenshot of the player\'s screen') && prompt.endsWith(RECAP), 'vision attaches the way it does for any message');

  p.handle({ id: 2, text: 'that was lag and you know it' }, core);
  assert.equal(calls[1].text, 'that was lag and you know it', 'talking back is passed through as is');

  fs.writeFileSync(path.join(base, 'file'), '');
  core.options = () => ({ cwd: path.join(base, 'file', 'sub') });
  p.handle({ id: 3, kind: 'roast', text: RECAP }, core);
  assert.match(calls[2].fail, /could not create/);
  assert.match(p.banner({ cwd: scratch }), /roast on/);
  fs.rmSync(base, { recursive: true, force: true });
});

const FIXTURES = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'roast', 'recaps.json'), 'utf8'));
const ROAST_REPLY = 'Hogger clawed you so hard the overkill has its own respawn timer.\n\nTL;DR: Hogger sends his regards.';
const DONE = { status: 'done', text: 'Hogger clawed you so hard the overkill has its own respawn timer.', summary: 'Hogger sends his regards.' };

function overlayServer() {
  const bodies = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      bodies.push({ method: req.method, url: req.url, body: JSON.parse(raw) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message: 'Roast shown' }));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, bodies, url: `http://127.0.0.1:${server.address().port}` })));
}

function overlayCore(streamOptions, scratch) {
  const logs = [];
  const core = {
    log: line => logs.push(line), tag: j => '#' + j.id,
    options: id => (id === 'stream' ? streamOptions : id === 'roast' ? { cwd: scratch } : {}),
    fail: () => {}, runAgent: () => {},
  };
  return { core, logs };
}

test('roast overlay: the payload carries only what the recorded recap really says', () => {
  assert.equal(P.splitSummary(ROAST_REPLY).summary, DONE.summary, 'DONE is what finish() hands over for this reply');
  assert.deepEqual(roast.overlayCommand(FIXTURES.gameRecap.recap, DONE), {
    action: 'roast',
    roast: { text: 'Hogger sends his regards.', killer: 'Hogger', ability: 'Rending Claw', overkill: 23, zone: 'Duskwood - Darkshire' },
  });
  assert.deepEqual(roast.overlayCommand(FIXTURES.environmentRecap.recap, DONE).roast, {
    text: 'Hogger sends his regards.', ability: 'Falling', overkill: 60, zone: 'Duskwood - Darkshire',
  }, 'the environment is not a killer name');
  assert.deepEqual(roast.overlayCommand(FIXTURES.unitCombatOnly.recap, DONE).roast, {
    text: 'Hogger sends his regards.', zone: 'Duskwood - Darkshire',
  }, 'UNIT_COMBAT hits name no attacker and no ability, so none is sent');
});

test('roast overlay: the text is the TL;DR line, else the reply without bridge notes, and nothing for a failed run', () => {
  const recap = FIXTURES.gameRecap.recap;
  assert.equal(roast.overlayCommand(recap, { status: 'done', text: 'Short roast.\n\n[bridge] a note', summary: '' }).roast.text, 'Short roast.');
  assert.equal(roast.overlayCommand(recap, { status: 'error', text: 'Claude exited with code 1', summary: '' }).roast.text, undefined);
  assert.equal(roast.overlayCommand(recap, { status: 'error', text: 'x' }).roast.killer, 'Hogger', 'the death still counts');
});

test('roast overlay: a placeholder zone, a cut recap and a killing blow the summary does not confirm give no names', () => {
  const unmapped = FIXTURES.unitCombatOnly.recap.replace('Duskwood - Darkshire', 'somewhere unmapped');
  assert.equal(roast.recapFacts(unmapped).zone, undefined);
  const lines = FIXTURES.gameRecap.recap.split('\n');
  const cut = lines.slice(0, -1).join('\n');
  assert.deepEqual(roast.recapFacts(cut), { zone: 'Duskwood - Darkshire' }, 'the summary line fell off the 900-byte cap');
  const forged = lines.map(l => l.replace("Killing blow: Hogger's Rending Claw.", "Killing blow: Hogger's Melee.")).join('\n');
  assert.deepEqual(roast.recapFacts(forged), { zone: 'Duskwood - Darkshire' });
  const unseen = FIXTURES.gameRecap.recap.replace(/Hogger \(level 11\): Rending Claw/, 'something unseen: an attack').replace("Hogger's Rending Claw", "something unseen's an attack");
  assert.deepEqual(roast.recapFacts(unseen), { zone: 'Duskwood - Darkshire', overkill: 23 });
});

test('roast overlay: a finished roast POSTs one roast action to the stream url, reusing the stream plugin options', async () => {
  const svc = await overlayServer();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wowai-roast-overlay-'));
  try {
    const p = PL.createRegistry().register(roast);
    assert.equal(typeof p.finished, 'function', 'the registry keeps the finished hook');
    const { core, logs } = overlayCore({ url: svc.url + '/' }, path.join(base, 'scratch'));
    const job = { id: 5, kind: 'roast', text: FIXTURES.gameRecap.recap };
    p.handle(job, core);
    const result = await p.finished(job, DONE, core);
    assert.equal(result.ok, true);
    assert.deepEqual(svc.bodies, [{ method: 'POST', url: '/control', body: roast.overlayCommand(FIXTURES.gameRecap.recap, DONE) }]);
    assert.ok(logs.some(l => /#5 roast: overlay -> 200 Roast shown/.test(l)), logs.join('\n'));

    const talkBack = { id: 6, text: 'that was lag and you know it' };
    p.handle(talkBack, core);
    assert.equal(await p.finished(talkBack, DONE, core), null);
    assert.equal(svc.bodies.length, 1, 'talking back in the roast chat is not a death');
  } finally {
    svc.server.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('roast overlay: plugins.stream.enabled false (and the sandbox options) send nothing; a service that is down is only logged', async () => {
  const svc = await overlayServer();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wowai-roast-overlay-'));
  try {
    for (const options of [{ enabled: false, url: svc.url }, { ...stream.INERT_OPTIONS }]) {
      const { core, logs } = overlayCore(options, path.join(base, 'scratch'));
      const job = { id: 7, kind: 'roast', text: FIXTURES.gameRecap.recap };
      roast.handle(job, core);
      assert.equal(await roast.finished(job, DONE, core), null);
      assert.ok(logs.some(l => /plugins\.stream\.enabled is false/.test(l)), logs.join('\n'));
    }
    assert.equal(svc.bodies.length, 0, 'no request reaches the service');
  } finally {
    svc.server.close();
  }
  const port = await new Promise(resolve => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const { core, logs } = overlayCore({ url: `http://127.0.0.1:${port}` }, path.join(base, 'scratch'));
  const job = { id: 8, kind: 'roast', text: FIXTURES.gameRecap.recap };
  roast.handle(job, core);
  assert.equal(await roast.finished(job, DONE, core), null);
  assert.ok(logs.some(l => /overlay at http:\/\/127\.0\.0\.1:\d+ not reached/.test(l)), logs.join('\n'));
  fs.rmSync(base, { recursive: true, force: true });
});

test('the recap fits the strip with room to spare', () => {
  const codec = fs.readFileSync(path.join(__dirname, '..', 'addon', 'ClaudeWoW', 'Codec.lua'), 'utf8');
  const maxPayload = Number(/C\.MAX_PAYLOAD\s*=\s*(\d+)/.exec(codec)[1]);
  const roastLua = fs.readFileSync(path.join(__dirname, '..', 'addon', 'ClaudeWoW', 'Roast.lua'), 'utf8');
  const recapBudget = Number(/R\.MAX_BYTES\s*=\s*(\d+)/.exec(roastLua)[1]);
  const contextBudget = 900;
  const recordFields = 200;
  assert.ok(recapBudget + contextBudget + recordFields <= maxPayload, `${recapBudget} + ${contextBudget} + ${recordFields} > ${maxPayload}`);
});
