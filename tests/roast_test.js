'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
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
  assert.ok(p.tools.includes('Name only the mobs, abilities, zones and levels that appear in the recap, spelled exactly as they appear there.'));
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
const FALL_DONE = { status: 'done', text: 'Gravity is undefeated.', summary: 'You hit the ground harder than you hit anything in Duskwood.' };

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
  assert.deepEqual(roast.overlayCommand(FIXTURES.environmentRecap.recap, FALL_DONE).roast, {
    text: FALL_DONE.summary, ability: 'Falling', overkill: 60, zone: 'Duskwood - Darkshire',
  }, 'the environment is not a killer name');
  assert.deepEqual(roast.overlayCommand(FIXTURES.environmentNoType.recap, FALL_DONE).roast, {
    text: FALL_DONE.summary, overkill: 40, zone: 'Duskwood - Darkshire',
  }, '"The environment" is not an ability name');
  assert.deepEqual(roast.overlayCommand(FIXTURES.unitCombatOnly.recap, FALL_DONE).roast, {
    text: FALL_DONE.summary, zone: 'Duskwood - Darkshire',
  }, 'UNIT_COMBAT hits name no attacker and no ability, so none is sent');
});

test('roast overlay: a TL;DR that names a game thing the recap does not have is not shown, and neither is an escape code', () => {
  const doneWith = summary => ({ status: 'done', text: 'Roast.', summary });
  for (const name of ['environmentRecap', 'environmentNoType', 'unitCombatOnly']) {
    const roasted = roast.overlayCommand(FIXTURES[name].recap, DONE).roast;
    assert.equal(roasted.text, undefined, `${name} has no Hogger, so the line is not shown`);
    assert.equal(roasted.zone, 'Duskwood - Darkshire', 'the card still goes out');
  }
  const unit = FIXTURES.unitCombatOnly.recap;
  assert.equal(roast.overlayCommand(unit, doneWith('Stormwind called, it wants its guard back.')).roast.text, undefined);
  assert.equal(roast.overlayCommand(unit, doneWith("Elwynn's finest would never.")).roast.text, undefined);
  assert.equal(roast.overlayCommand(unit, doneWith('Duskwood ate you alive.')).roast.text, 'Duskwood ate you alive.');
  assert.equal(roast.overlayCommand(unit, doneWith('You took 52 Physical to the face.')).roast.text, 'You took 52 Physical to the face.');
  const game = FIXTURES.gameRecap.recap;
  assert.equal(roast.overlayCommand(game, doneWith("Hogger's Rending Claw sends regards.")).roast.text, "Hogger's Rending Claw sends regards.");
  assert.equal(roast.overlayCommand(game, doneWith('Hogger’s claw, again.')).roast.text, 'Hogger’s claw, again.');
  assert.equal(roast.overlayCommand(game, doneWith('Hogger and Van Cleef agree.')).roast.text, undefined);
  assert.equal(roast.overlayCommand(game, doneWith('Hogger says |cffff0000hi|r.')).roast.text, undefined);
  assert.equal(roast.overlayCommand(game, doneWith('Hogger says ||hi.')).roast.text, undefined);
});

const WOWDATA = path.join(__dirname, 'fixtures', 'wowdata');
const GD = require('../bridge/gamedata');
const fixtureData = (clientBuild = '1.60.1.70124') => GD.openStore({ dataDir: WOWDATA, clientBuild });

test('roast overlay: every word of the line must be a number, a recap word or a plain word, so lowercase, hidden-character and title-case names are dropped', () => {
  const game = FIXTURES.gameRecap.recap;
  const line = (summary, data = null) => roast.overlayCommand(game, { status: 'done', text: 'Roast.', summary }, data).roast.text;
  assert.equal(line('hogger sends his regards.'), 'hogger sends his regards.', 'a recap name passes in any case');
  assert.equal(line('Duskwood ate you alive.'), 'Duskwood ate you alive.');
  assert.equal(line('hogger and van cleef send regards.'), undefined, 'a lowercase game name the recap does not have is dropped');
  assert.equal(line('next time, try orgrimmar.'), undefined);
  assert.equal(line('Hogger sends you to Under city.'), 'Hogger sends you to Under city.', 'precondition: both halves are plain words');
  assert.equal(line('Hogger sends you to Under​city.'), undefined, 'a zero-width space cannot split a name into two plain words');
  assert.equal(line('Hogger sends you to Under⁠city.'), undefined);
  assert.equal(line('Hogger says ‮ouch.'), undefined);
  assert.equal(line('ǅungeon time, Hogger.'), undefined, 'a title-case letter is not an escape hatch');
  assert.equal(line('Ｈｏｇｇｅｒ sends regards.'), 'Hogger sends regards.', 'fullwidth letters are NFKC-normalized before the check');
  assert.equal(line(`Hogger ${'ha '.repeat(120)}`), undefined, `longer than ${roast.ROAST_TEXT_MAX} characters`);
});

test('roast overlay: reference tokens expand from the fixture data; an unknown or Classic-only ID drops the line; no data drops any token', () => {
  const game = FIXTURES.gameRecap.recap;
  const outcome = summary => ({ status: 'done', text: 'Roast.', summary });
  assert.equal(roast.overlayCommand(game, outcome('Hogger took your {item:501} too.'), fixtureData()).roast.text, 'Hogger took your Fixture Blade too.');
  assert.equal(roast.overlayCommand(game, outcome('Hogger took your {item:999} too.'), fixtureData()).roast.text, undefined);
  assert.equal(roast.overlayCommand(game, outcome('Hogger took your {item:2318} too.'), fixtureData()).roast.text, undefined, 'a Classic ID absent from the Forever data');
  assert.equal(roast.overlayCommand(game, outcome('Hogger took your {item:501} too.'), fixtureData('1.61.0.1')).roast.text, undefined, 'data for another build family');
  assert.equal(roast.overlayCommand(game, outcome('Hogger took your {item:501} too.'), null).roast.text, undefined, 'no synced data');
  assert.equal(roast.overlayCommand(game, outcome('Hogger took your {item:501} in Silverpine.'), fixtureData()).roast.text, undefined, 'a token never excuses a raw name');
  assert.equal(roast.overlayCommand(game, outcome('Hogger sends his regards.'), null).roast.text, 'Hogger sends his regards.', 'without data a line with no token is shown as before');
  assert.deepEqual(roast.checkLine(game, outcome('Hogger took your {item:2318} too.'), fixtureData()), {
    text: '', refused: '{item:2318}: that item ID is not in the Forever client data for build 1.60.1.200. Look the ID up with the wowdata tools; never use an ID from memory or from Classic.',
  });
  assert.match(roast.checkLine(game, outcome('Hogger took your {item:501}.'), null).refused, /No game data is synced/);
  assert.match(roast.checkLine(game, outcome('Go to silverpine.'), null).refused, /words neither in the recap nor plain: silverpine/);
});

test('roast vocabulary: lowercase, no duplicates, no game proper name, no word the order list refuses as a game name', () => {
  const words = require('../bridge/roast-words.json');
  assert.equal(new Set(words).size, words.length, 'no duplicates');
  for (const w of words) assert.match(w, /^[a-z][a-z']*$/, w);
  for (const n of ['horde', 'alliance', 'orc', 'rogue', 'thrall', 'orgrimmar', 'undercity', 'silverpine', 'durotar', 'barrens',
    'worgen', 'defias', 'murloc', 'kobold', 'wolves', 'wolf', 'light', 'hearthstone', 'forest', 'leather', 'linen', 'stealth', 'forever',
    'skinning', 'leatherworking', 'tailoring', 'mining', 'herbalism']) assert.ok(!roast.ROAST_WORDS.has(n), n);
});

test('roast overlay: the finished hook reads the bridge game data and logs why a line was left off the card', async () => {
  const svc = await overlayServer();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wowai-roast-refs-'));
  try {
    const { core, logs } = overlayCore({ url: svc.url }, path.join(base, 'scratch'));
    core.gameData = () => fixtureData();
    const run = async (id, summary) => {
      const job = { id, kind: 'roast', text: FIXTURES.gameRecap.recap };
      roast.handle(job, core);
      await roast.finished(job, { status: 'done', text: 'Roast.', summary }, core);
    };
    await run(11, 'Hogger took your {item:501} too.');
    await run(12, 'Hogger took your {item:2318} too.');
    assert.equal(svc.bodies[0].body.roast.text, 'Hogger took your Fixture Blade too.');
    assert.equal(svc.bodies[1].body.roast.text, undefined, 'the card still goes out without the line');
    assert.equal(svc.bodies[1].body.roast.killer, 'Hogger');
    assert.ok(logs.some(l => /#12 roast: line left off the card \(\{item:2318\}: that item ID is not in the Forever client data/.test(l)), logs.join('\n'));
  } finally {
    svc.server.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('the roast instructions tell the model the line is checked word by word and that this chat has no tokens', () => {
  assert.ok(roast.TOOLS.includes('checks the TL;DR line word by word'));
  assert.ok(roast.TOOLS.includes('This chat has no reference tokens'));
});

test('roast overlay: the text is the TL;DR line, else the reply, without bridge notes either way, and never a bridge placeholder', () => {
  const recap = FIXTURES.gameRecap.recap;
  const line = outcome => roast.overlayCommand(recap, { status: 'done', ...outcome }).roast.text;
  assert.equal(line({ text: 'Hogger wins again.\n\n[bridge] a note', summary: '' }), 'Hogger wins again.');
  assert.equal(line({ text: 'Long roast.\n\nTL;DR: Hogger wins.\n\n[bridge] a note', summary: 'Hogger wins.\n\n[bridge] a note' }), 'Hogger wins.');
  assert.equal(line({ text: '[bridge] some map marks were left out.', summary: '' }), undefined);
  assert.equal(line({ text: '(Claude finished without a reply)', summary: '' }), undefined);
  assert.equal(line({ text: '', summary: '' }), undefined);
  assert.equal(roast.overlayCommand(recap, { status: 'error', text: 'Claude exited with code 1', summary: '' }).roast.text, undefined);
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

    for (const failed of [{ status: 'error', text: 'Cancelled from the game.', summary: '' }, { status: 'error', text: 'Claude exited with code 1 and no result.' }, undefined]) {
      const retried = { id: 9, kind: 'roast', text: FIXTURES.gameRecap.recap };
      p.handle(retried, core);
      assert.equal(await p.finished(retried, failed, core), null);
    }
    assert.equal(svc.bodies.length, 1, 'a failed, cancelled or timed-out roast is not a death on the overlay: the retry is');
    assert.ok(logs.some(l => /#9 roast: overlay not told, the run ended with error/.test(l)), logs.join('\n'));

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

test('roast overlay: a bridge that exits when idle (--inject) skips the hook and says so, instead of racing its own exit', { skip: process.platform === 'win32' && 'a .js agent path' }, async () => {
  const svc = await overlayServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wowai-roast-inject-'));
  try {
    const home = path.join(dir, 'home');
    const addons = path.join(dir, 'client', 'Interface', 'AddOns');
    for (const d of ['sig', 'ack', 'act', 'presence']) fs.mkdirSync(path.join(addons, 'ClaudeWoW', d), { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    const agent = path.join(dir, 'fake-claude.js');
    const result = { type: 'result', subtype: 'success', is_error: false, result: 'Hogger again.\n\nTL;DR: Hogger sends his regards.', session_id: 'roast-inject' };
    fs.writeFileSync(agent, `process.stdin.resume(); process.stdin.on('end', () => { process.stdout.write(${JSON.stringify(JSON.stringify(result) + '\n')}); });`);
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
      addonDir: addons, savedVariablesFile: path.join(dir, 'ClaudeWoW.lua'), inboxFile: path.join(addons, 'ClaudeWoW', 'Inbox.lua'),
      defaultCwd: dir, slots: 1, agent: 'claude', agents: { claude: { path: agent } }, titleModel: false,
      plugins: { default: 'roast', roast: { cwd: path.join(dir, 'scratch') }, stream: { url: svc.url } },
      gameContext: false, primerFile: '', capture: { enabled: false }, timeoutMs: 60000,
    }));
    const bridge = spawn(process.execPath, [path.join(__dirname, '..', 'bridge', 'bridge.js'), '--inject', FIXTURES.gameRecap.recap, '--plugin', 'roast'], {
      env: { ...process.env, CLAUDE_WOW_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    bridge.stdout.on('data', d => { out += d; });
    bridge.stderr.on('data', d => { out += d; });
    const code = await new Promise(resolve => bridge.on('exit', resolve));
    assert.equal(code, 0, out);
    assert.match(out, /roast: finished hook skipped, this bridge exits when idle/, out);
    assert.equal(svc.bodies.length, 0, 'no half-sent roast');
  } finally {
    svc.server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
