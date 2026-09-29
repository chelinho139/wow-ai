'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../bridge/protocol');
const PL = require('../bridge/plugins');
const roast = require('../bridge/plugins/roast');

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

test('the recap fits the strip with room to spare', () => {
  const codec = fs.readFileSync(path.join(__dirname, '..', 'addon', 'ClaudeWoW', 'Codec.lua'), 'utf8');
  const maxPayload = Number(/C\.MAX_PAYLOAD\s*=\s*(\d+)/.exec(codec)[1]);
  const roastLua = fs.readFileSync(path.join(__dirname, '..', 'addon', 'ClaudeWoW', 'Roast.lua'), 'utf8');
  const recapBudget = Number(/R\.MAX_BYTES\s*=\s*(\d+)/.exec(roastLua)[1]);
  const contextBudget = 900;
  const recordFields = 200;
  assert.ok(recapBudget + contextBudget + recordFields <= maxPayload, `${recapBudget} + ${contextBudget} + ${recordFields} > ${maxPayload}`);
});
