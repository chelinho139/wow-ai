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

const WOWDATA = path.join(__dirname, 'fixtures', 'wowdata', 'forever', '1.60.1.200');

test('roast overlay: every word of the line must be a number, a recap word or a plain word, so lowercase, hidden-character and title-case names are dropped', () => {
  const game = FIXTURES.gameRecap.recap;
  const line = summary => roast.overlayCommand(game, { status: 'done', text: 'Roast.', summary }).roast.text;
  assert.equal(line('hogger sends his regards.'), 'hogger sends his regards.', 'a recap name passes in any case');
  assert.equal(line('Duskwood ate you alive.'), 'Duskwood ate you alive.');
  assert.equal(line('hogger and van cleef send regards.'), undefined, 'a lowercase game name the recap does not have is dropped');
  assert.equal(line('next time, try orgrimmar.'), undefined);
  assert.equal(line('Hogger sends you to Under city.'), undefined, 'a place name spaced into two words is refused: "city" is not a plain word');
  assert.equal(line('Hogger taught you to run faster.'), 'Hogger taught you to run faster.', 'precondition: both words are plain');
  assert.equal(line('Hogger taught you to run​faster.'), undefined, 'a zero-width space is refused even between plain words');
  assert.equal(line('Hogger taught you to run⁠faster.'), undefined);
  assert.equal(line('Hogger says ‮ouch.'), undefined);
  assert.equal(line('ǅungeon time, Hogger.'), undefined, 'a title-case letter is not an escape hatch');
  assert.equal(line('Ｈｏｇｇｅｒ sends regards.'), 'Hogger sends regards.', 'fullwidth letters are NFKC-normalized before the check');
  assert.equal(line(`Hogger ${'ha '.repeat(120)}`), undefined, `longer than ${roast.ROAST_TEXT_MAX} characters`);
});

const ORDINARY_ROASTS = [
  DONE.text,
  'Hogger sends his regards.',
  'That fight ended before it even started.',
  'You saw the claw coming and still said yes.',
  'Kiting works better when you actually run away.',
  'Your guild will hear about this one.',
  'Twenty three levels of experience, zero levels of caution.',
  'Rend did the rest while you were busy losing.',
  'A level 11 bully just made a level 23 hero look silly.',
  'Next time, maybe bring a friend and a plan.',
  'Duskwood is spooky, but Hogger is scarier.',
  'Respect the claw. Always respect the claw.',
  'You lost to Hogger, which is honestly a rite of passage.',
  'Bold strategy: let the brute hit you first and hope he gets tired.',
  'That was not a pull, that was a donation.',
  'Your armor called in sick today.',
  'Somewhere, Hogger is telling this story at dinner.',
  'Pro tip: health bars go down faster when you stand still.',
  'The Night Elf Hunter forgot to bring a pet again.',
  'Absorbed 4, took 61, learned nothing.',
  'Even the healers in Darkshire saw that coming.',
  "You died doing what you loved: standing in the wrong place.",
  'Hogger did not even need the second hit.',
  "Imagine losing a staring contest to Hogger. Oh wait, you just did.",
  'That crit was personal.',
  'You pulled aggro and then pulled a disappearing act.',
  'Your corpse has seen more of Duskwood than you have.',
  'You attacked first, which was the problem.',
  'Hogger loves a good warm-up.',
  'She hit the ground and blamed herself, which is fair.',
  'Literally nobody saw that coming, except Hogger.',
  'Viewers are still laughing, haha.',
];

const fixtureData = () => require('../bridge/gamedata').openStore({ dataDir: path.join(__dirname, 'fixtures', 'wowdata'), clientBuild: '1.60.1.70124' });

test('roast overlay: ordinary rule-abiding roast lines are shown, with and without synced data', () => {
  assert.equal(ORDINARY_ROASTS[0], 'Hogger clawed you so hard the overkill has its own respawn timer.', 'starts with the recorded reply');
  assert.ok(ORDINARY_ROASTS.length >= 30);
  for (const data of [null, fixtureData()]) {
    for (const summary of ORDINARY_ROASTS) {
      const checked = roast.checkLine(FIXTURES.gameRecap.recap, { status: 'done', text: 'Roast.', summary }, data);
      assert.deepEqual({ text: checked.text, refused: checked.refused }, { text: summary, refused: '' }, summary);
    }
  }
});

test('roast overlay: game names split into plain words are refused by the built-in phrase list, with no data needed', () => {
  const game = FIXTURES.gameRecap.recap;
  const check = summary => roast.checkLine(game, { status: 'done', text: 'Roast.', summary });
  for (const [summary, phrase] of [
    ['Hogger taught you to back stab.', 'back stab'],
    ['Next time, go to old town.', 'old town'],
    ['A power word would have helped.', 'power word'],
    ['A flash heal would have helped.', 'flash heal'],
    ['You needed an ice block.', 'ice block'],
    ['Where was your battle shout?', 'battle shout'],
    ['Nobody was there to lay on hands.', 'lay on hands'],
  ]) {
    const r = check(summary);
    assert.equal(r.text, '', summary);
    assert.match(r.refused, new RegExp(`^game names not in the recap: .*${phrase}`), `${summary}: the word check passes, the phrase check refuses`);
  }
  for (const summary of ['Heroic Strike would have helped.', 'You died to a Hill Giant.', 'The Dark Lady is not impressed.', 'Power Word: Shield would have helped.']) {
    assert.equal(check(summary).text, '', summary);
  }
});

test('roast overlay: a run of plain words that is a name in the synced data is refused, unless the recap has it; without data it is skipped and logged', async () => {
  const game = FIXTURES.gameRecap.recap;
  const outcome = summary => ({ status: 'done', text: 'Roast.', summary });
  const data = fixtureData();
  assert.deepEqual(roast.checkLine(game, outcome('Hogger sent you down the low road.'), data), { text: '', refused: 'game names not in the recap: low road (map)', phrasesNote: '' });
  assert.deepEqual(roast.checkLine(game, outcome('Hogger has quick hands.'), data).refused, 'game names not in the recap: quick hands (spell taught by an item)', 'a spell-book item name gives its spell as a phrase');
  assert.equal(roast.checkLine(game, outcome('Hogger has quick feet.'), data).refused, 'game names not in the recap: quick feet (spell taught by an item)', 'a rune or tablet names its spell too');
  assert.equal(roast.checkLine(game, outcome('Hogger made you see the stars.'), data).text, 'Hogger made you see the stars.', 'a rune or tablet remainder that starts with "the" is ordinary English');
  assert.equal(roast.checkLine(game, outcome('Not your lucky day, Hogger won.'), data).text, 'Not your lucky day, Hogger won.', 'item names are not phrases: "Lucky Day" is an item in the fixture data');
  assert.equal(roast.checkLine(game, outcome('That was a test run.'), data).text, 'That was a test run.', 'a junk row such as an area named "Test Run" is not indexed');
  assert.equal(roast.checkLine(game, outcome('Hogger sent you down the low road.'), null).text, 'Hogger sent you down the low road.');
  assert.equal(roast.checkLine(game, outcome("Hogger's Rending Claw sends regards."), data).text, "Hogger's Rending Claw sends regards.", 'the data has "Rending Claw", and so does the recap');
  const svc = await overlayServer();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wowai-roast-phrase-'));
  try {
    const { core, logs } = overlayCore({ url: svc.url }, path.join(base, 'scratch'));
    const job = { id: 15, kind: 'roast', text: game };
    roast.handle(job, core);
    await roast.finished(job, outcome('Hogger sends his regards.'), core);
    assert.ok(logs.some(l => /#15 roast: No game data is synced for this build yet \(claude-wow data sync\)\. Multi-word game names were checked only against the short built-in list\.$/.test(l)), logs.join('\n'));
    assert.ok(!logs.some(l => /try again|reference token/.test(l)), 'a log note carries no instructions meant for a refused text');
    core.gameData = () => data;
    const again = { id: 16, kind: 'roast', text: game };
    roast.handle(again, core);
    await roast.finished(again, outcome('Hogger sent you down the low road.'), core);
    assert.equal(svc.bodies[1].body.roast.text, undefined);
    assert.ok(logs.some(l => /#16 roast: line left off the card \(game names not in the recap: low road \(map\)\)/.test(l)), logs.join('\n'));
  } finally {
    svc.server.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('roast phrases: runs stop at sentence and clause marks but not at a colon or a dash', () => {
  const game = FIXTURES.gameRecap.recap;
  const check = summary => roast.checkLine(game, { status: 'done', text: 'Roast.', summary }).text;
  assert.equal(check('You got old. Town is that way.'), 'You got old. Town is that way.');
  assert.equal(check('You got old; town is that way.'), 'You got old; town is that way.');
  assert.equal(check('You got old, town is that way.'), 'You got old, town is that way.');
  assert.equal(check('Next stop: old - town.'), '', 'a dash does not split a name');
  assert.equal(check('Power word: fail.'), '', 'a colon does not split a name');
  assert.equal(check('Go to Old,Town now.'), '', 'a mark with no space after it does not end the clause');
  assert.equal(check('You needed Mark,of,the,Wild.'), '');
  assert.equal(check('Go to old.town now.'), '');
});

const REMOVED_PHRASES = require('./fixtures/removed-game-phrases.json');

test('phrases removed from the built-in list stay refused by the word check', () => {
  const G = require('../bridge/goals');
  const plain = w => roast.ROAST_WORDS.has(w) || G.ORDER_WORDS.has(w);
  assert.ok(REMOVED_PHRASES.length >= 80);
  const reopened = REMOVED_PHRASES.filter(p => p.split(' ').every(plain));
  assert.deepEqual(reopened, [], 'a phrase made only of plain words must go back into bridge/game-phrases.json');
  const recap = 'Death recap: someone just died somewhere.';
  for (const p of REMOVED_PHRASES) assert.equal(roast.checkLine(recap, { status: 'done', text: 'x', summary: `You met ${p}.` }).text, '', p);
});

test('built-in phrase list: every entry is already normalized and made only of words the word check lets through', () => {
  const G = require('../bridge/goals');
  const GR = require('../bridge/gamerefs');
  const entries = require('../bridge/game-phrases.json');
  assert.ok(entries.includes('mark of the wild'));
  for (const e of entries) {
    assert.equal(GR.phraseWords(e).join(' '), e, `${e} is normalized`);
    for (const w of e.split(' ')) assert.ok(roast.ROAST_WORDS.has(w) || G.ORDER_WORDS.has(w), `${e}: "${w}" is a plain word, so only the phrase check can catch it`);
  }
  assert.equal(GR.GAME_PHRASES.size, entries.length);
});

const IDIOM_ROASTS = [
  'Hot tip: do not do that again.', 'Not used to losing, are you?', 'That was the big one.', 'That clip is pure gold.',
  'You forgot your lucky charm at home.', 'Keep a close eye on Hogger next time.', 'A bag of gold would not save you.', 'Hogger got the last laugh.',
  'Better luck next time.', 'Back to the start for you.', 'Hogger called your bluff.', 'Easy come, easy go.', 'No pain, no gain.',
  'Time to hit the road.', 'Hogger had the upper hand.', 'That plan went up in smoke.', 'Rest in pieces.', 'You were in over your head.',
  'Not your lucky day, Hogger won.', 'Mind the gap next time.', 'You picked the wrong fight.', 'That was a long day at work.',
];

function realData() {
  const homeDir = process.env.CLAUDE_WOW_HOME;
  if (!homeDir) return null;
  const GDm = require('../bridge/gamedata');
  const dataDir = path.join(homeDir, 'data');
  const probe = GDm.openStore({ dataDir });
  return probe.build ? GDm.openStore({ dataDir, clientBuild: probe.build }) : null;
}

test('real synced data (opt-in, CLAUDE_WOW_HOME with data): ordinary and idiom roast lines show, known game phrases are refused', { skip: !realData() && 'set CLAUDE_WOW_HOME to a home with synced data to run this' }, () => {
  const data = realData();
  const game = FIXTURES.gameRecap.recap;
  const check = summary => roast.checkLine(game, { status: 'done', text: 'Roast.', summary }, data);
  const dropped = [...ORDINARY_ROASTS, ...IDIOM_ROASTS].filter(line => check(line).text !== line).map(line => `${line} -> ${check(line).refused}`);
  assert.deepEqual(dropped, [], dropped.join('\n'));
  for (const line of ['Next time, go to old town.', 'You needed the mark of the wild.', 'A gift of the wild would help.', 'What a gold mine of a clip.',
    'Should have used chain heal.', 'No victory rush for you.', 'Try water walking next time.', 'That was a raging blow.', 'No healing rain could save you.', 'Far sight would have helped.']) {
    assert.equal(check(line).text, '', line);
  }
  assert.equal(check('Hogger sends his regards.').phrasesNote, '', 'the real data indexed cleanly');
});

test('roast: a typed line that starts with "Death recap:" is treated as a recap; one that does not makes no card', async () => {
  const svc = await overlayServer();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wowai-roast-prefix-'));
  try {
    const { core } = overlayCore({ url: svc.url }, path.join(base, 'scratch'));
    const typed = { id: 17, kind: 'roast', text: 'Death recap: I died to Hogger in Silverpine.' };
    roast.handle(typed, core);
    assert.equal(typed.recap, 'Death recap: I died to Hogger in Silverpine.');
    await roast.finished(typed, { status: 'done', text: 'Roast.', summary: 'Silverpine got you.' }, core);
    assert.equal(svc.bodies[0].body.roast.text, 'Silverpine got you.', 'the prefixed typed line is the name source, as documented');
    const plain = { id: 18, kind: 'roast', text: 'I died to Hogger in Silverpine.' };
    roast.handle(plain, core);
    assert.equal(await roast.finished(plain, { status: 'done', text: 'Roast.', summary: 'Silverpine got you.' }, core), null);
    assert.equal(svc.bodies.length, 1);
  } finally {
    svc.server.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('roast overlay: no reference tokens; any brace drops the line', () => {
  const game = FIXTURES.gameRecap.recap;
  const outcome = summary => ({ status: 'done', text: 'Roast.', summary });
  assert.equal(roast.overlayCommand(game, outcome('Hogger took your {item:501} too.')).roast.text, undefined);
  assert.equal(roast.checkLine(game, outcome('Hogger took your {item:501} too.')).refused, 'the character U+007B is not allowed');
  assert.equal(roast.overlayCommand(game, outcome('Hogger took your } too.')).roast.text, undefined);
  assert.match(roast.checkLine(game, outcome('Go to silverpine.')).refused, /words neither in the recap nor plain: silverpine/);
});

const RACES = ['horde', 'alliance', 'orc', 'troll', 'tauren', 'undead', 'human', 'dwarf', 'gnome', 'elf', 'goblin'];
const CLASSES = ['rogue', 'warrior', 'mage', 'priest', 'hunter', 'druid', 'paladin', 'shaman', 'warlock'];
const ABILITY_AND_TITLE_WORDS = ['night', 'charge', 'kick', 'sprint', 'fear', 'blink', 'revenge', 'shield', 'claw', 'bite', 'dash', 'shoot',
  'bubble', 'king', 'lady', 'captain', 'general', 'guard', 'spirit', 'ghost', 'giant', 'lord', 'queen', 'prince', 'knight', 'warchief',
  'taunt', 'cleave', 'slam', 'execute', 'bash', 'maul', 'swipe', 'rake', 'shred', 'prowl', 'pounce', 'growl', 'roar', 'frenzy', 'enrage',
  'renew', 'smite', 'polymorph', 'fireball', 'frostbolt', 'evasion', 'vanish', 'gouge', 'sap', 'garrote', 'ambush', 'eviscerate', 'backstab', 'rend', 'stealth'];
const PLACE_WORDS = ['city', 'vale', 'shire', 'isle', 'steppes', 'highlands', 'wetlands', 'marsh', 'glade', 'grove', 'canyon', 'gorge', 'forest',
  'thrall', 'orgrimmar', 'undercity', 'crossroads', 'barrens', 'brill', 'ratchet', 'everlook', 'sepulcher', 'bulwark', 'durotar', 'mulgore',
  'silverpine', 'tirisfal', 'stormwind', 'ironforge', 'darnassus', 'light', 'hearthstone', 'forever'];
const CREATURE_FAMILIES = ['murloc', 'kobold', 'gnoll', 'worgen', 'defias', 'scourge', 'wolf', 'wolves', 'bear', 'boar', 'cat', 'raptor', 'spider',
  'scorpid', 'crocolisk', 'gorilla', 'bat', 'owl', 'hyena', 'crab', 'turtle', 'kodo', 'ogre', 'elemental', 'dragon', 'whelp', 'drake', 'demon',
  'imp', 'skeleton', 'zombie', 'ghoul', 'harpy', 'centaur', 'quilboar', 'satyr', 'furbolg', 'naga', 'trogg', 'ooze', 'golem'];

test('roast vocabulary: thousands of lowercase words, no duplicates, and none of the race, class, ability, title, place or creature-family words', () => {
  const words = require('../bridge/roast-words.json');
  assert.ok(words.length >= 3000, `${words.length} words`);
  assert.equal(new Set(words).size, words.length, 'no duplicates');
  for (const w of words) assert.match(w, /^[a-z][a-z']*$/, w);
  const professions = Object.values(require('../bridge/goals').PROFESSION_SKILL_IDS).flatMap(n => n.toLowerCase().split(' ')).filter(w => w !== 'first');
  for (const n of [...RACES, ...CLASSES, ...ABILITY_AND_TITLE_WORDS, ...PLACE_WORDS, ...CREATURE_FAMILIES, ...professions]) assert.ok(!roast.ROAST_WORDS.has(n), n);
  for (const n of ['crit', 'crits', 'critted', 'aggro', 'dps', 'overkill', 'corpse', 'noob', 'haha', 'literally', 'attacked', 'viewers', 'loves', 'herself', 'hers', 'theirs', 'kiting', 'kited', 'ended', 'guild']) {
    assert.ok(roast.ROAST_WORDS.has(n), n);
  }
});

test('roast overlay: talking back in the roast chat never reaches the card, even when it names places', async () => {
  const svc = await overlayServer();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wowai-roast-talkback-'));
  try {
    const { core } = overlayCore({ url: svc.url }, path.join(base, 'scratch'));
    const talk = { id: 13, kind: 'roast', text: 'tell me about Silverpine and Thrall' };
    roast.handle(talk, core);
    assert.equal(talk.recap, undefined, 'a typed line is not a recap, so it never becomes the name list');
    assert.equal(talk.text, 'tell me about Silverpine and Thrall', 'passed through as is');
    assert.equal(await roast.finished(talk, { status: 'done', text: 'Sure.', summary: 'Silverpine and Thrall send regards.' }, core), null);
    assert.equal(svc.bodies.length, 0, 'no card');
    const death = { id: 14, kind: 'roast', text: FIXTURES.gameRecap.recap };
    roast.handle(death, core);
    await roast.finished(death, DONE, core);
    assert.equal(svc.bodies.length, 1, 'precondition: a real recap in the same chat does send a card');
  } finally {
    svc.server.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('roast overlay: the finished hook checks the line once and logs why it was left off the card', async () => {
  const svc = await overlayServer();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wowai-roast-log-'));
  try {
    const { core, logs } = overlayCore({ url: svc.url }, path.join(base, 'scratch'));
    const job = { id: 12, kind: 'roast', text: FIXTURES.gameRecap.recap };
    roast.handle(job, core);
    const GR = require('../bridge/gamerefs');
    const real = GR.checkText;
    let calls = 0;
    GR.checkText = (...args) => { calls += 1; return real(...args); };
    try {
      await roast.finished(job, { status: 'done', text: 'Roast.', summary: 'Hogger and Van Cleef send regards.' }, core);
    } finally { GR.checkText = real; }
    assert.equal(calls, 1, 'the line is checked exactly once per card');
    assert.equal(svc.bodies[0].body.roast.text, undefined, 'the card still goes out without the line');
    assert.equal(svc.bodies[0].body.roast.killer, 'Hogger');
    assert.ok(logs.some(l => /#12 roast: line left off the card \(words neither in the recap nor plain: van, cleef\)/.test(l)), logs.join('\n'));
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
    for (const d of ['sig', 'ack', 'act', 'presence']) fs.mkdirSync(path.join(addons, 'ClaudeWoW_Runtime', d), { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    const agent = path.join(dir, 'fake-claude.js');
    const result = { type: 'result', subtype: 'success', is_error: false, result: 'Hogger again.\n\nTL;DR: Hogger sends his regards.', session_id: 'roast-inject' };
    fs.writeFileSync(agent, `process.stdin.resume(); process.stdin.on('end', () => { process.stdout.write(${JSON.stringify(JSON.stringify(result) + '\n')}); });`);
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
      addonDir: addons, savedVariablesFile: path.join(dir, 'ClaudeWoW.lua'), inboxFile: path.join(addons, 'ClaudeWoW_Runtime', 'Inbox.lua'),
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
