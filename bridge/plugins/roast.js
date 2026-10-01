'use strict';

const fs = require('fs');
const path = require('path');
const ask = require('./ask');
const stream = require('./stream');
const GR = require('../gamerefs');

const KIND = 'roast';
const RECAP_PREFIX = 'Death recap:';
const OVERLAY_ACTION = 'roast';
const PLACEHOLDER_SOURCES = new Set(['something unseen', 'the environment']);
const PLACEHOLDER_ABILITIES = new Set(['an attack', 'The environment']);
const PLACEHOLDER_ZONES = new Set(['somewhere unmapped']);
const HEAD_RE = /^Death recap: .+? just died in (.+)\.$/;
const KILLING_BLOW_RE = /^-\d+(?:\.\d+)?s (.+?)(?: \(level [^)]*\))?: (.+?) \d+(?: crit)?(?: \(tick\))?(?:, overkill (\d+))?(?:, absorbed \d+)? <- killing blow$/;
const BRIDGE_NOTE_RE = /(?:^|\n\n)\[bridge\]/;
const PLAIN_WORDS = new Set([
  'i', "i'm", "i'd", "i'll", 'me', 'my', 'you', "you're", "you've", "you'll", 'your', 'yours', 'he', 'she', 'it', "it's", 'its', 'we', 'they', 'them', 'their',
  'a', 'an', 'the', 'this', 'that', "that's", 'these', 'those', 'there', "there's", 'here', "here's",
  'and', 'but', 'or', 'so', 'if', 'when', 'then', 'not', 'no', 'yes', 'nope', 'just', 'even', 'still', 'also', 'next', 'maybe', 'never', 'always', 'again',
  'what', "what's", 'who', "who's", 'why', 'how', 'well', 'oh', 'wow', 'ouch', 'hey', 'nice', 'good', 'great', 'pro', 'tip', 'rip', 'gg', 'lol',
  'at', 'in', 'on', 'to', 'of', 'for', 'with', 'from', 'by', 'one', 'some', 'someone', 'something', 'somehow', 'death', 'dead', 'died',
  "don't", "didn't", "can't", "won't", "let's", 'tl', 'dr',
]);
const ROAST_WORDS = Object.freeze(new Set([...require('../order-words.json'), ...require('../roast-words.json'), ...PLAIN_WORDS]));
const ROAST_CHAR_RE = /^[A-Za-z0-9 ,.'‘’\-:!?%()";]$/;
const ROAST_TEXT_MAX = 280;

const TOOLS = [
  'This chat is the player\'s death roast. When a message is a death recap (it starts with "Death recap:"), the player has just died in World of Warcraft and the addon sent you the last hits before the death: from the game\'s death recap (who hit them, with what, for how much, the overkill, the levels), or, when the game shared none, the hits they took with no attacker named plus their target at death. The zone is always there.',
  'Reply with a short, funny, affectionate roast of that death: two or three sentences, like a friend in guild chat who saw it happen. Use the specifics (the mob, the ability, the overkill, a level gap, the zone) because the details are the joke. Punch at the play, never at the person. No slurs, nothing about real-world identity, appearance or intelligence, nothing cruel. At most one practical tip, and only if it is also funny.',
  'If a screenshot of the screen is attached, you may use what you see in it. Do not use the map or write macros in this chat. Your TL;DR line is the best line of the roast.',
  'Name only the mobs, abilities, zones and levels that appear in the recap, spelled exactly as they appear there. Never name any other mob, ability, zone, item, quest or character from the game, even one you remember: your TL;DR line is shown to stream viewers.',
  'The bridge checks the TL;DR line word by word before it goes on the stream card: every word must be a number, a word from the recap, or an everyday English word, in any letter case. Any other game name drops the line from the card. This chat has no reference tokens: the reply is printed in the game chat as written, so name game things only the way the recap does.',
  'A message that is not a death recap is the player talking back: answer it in the same playful tone, briefly.',
].join('\n');

function isRecap(text) {
  return String(text || '').trimStart().startsWith(RECAP_PREFIX);
}

function isRoast(job) {
  return !!job && (job.kind === KIND || isRecap(job.text));
}

function roastPrompt(recap) {
  return [
    'I just died. Roast this death in two or three sentences, then the TL;DR line.',
    '',
    String(recap || '').trim(),
  ].join('\n');
}

function scratchFolder(options) {
  return ask.scratchFolder(options);
}

function recapFacts(recap) {
  const lines = String(recap || '').split('\n').map(l => l.trim());
  const facts = {};
  const head = HEAD_RE.exec(lines[0] || '');
  if (head && !PLACEHOLDER_ZONES.has(head[1])) facts.zone = head[1];
  const blowLine = lines.find(l => l.endsWith('<- killing blow'));
  const blow = blowLine ? KILLING_BLOW_RE.exec(blowLine) : null;
  if (!blow) return facts;
  const [, source, ability, overkill] = blow;
  const summary = `Killing blow: ${source}'s ${ability}.`;
  if (!lines.some(l => l.includes(summary))) return facts;
  if (!PLACEHOLDER_SOURCES.has(source)) facts.killer = source;
  if (!PLACEHOLDER_ABILITIES.has(ability)) facts.ability = ability;
  if (overkill !== undefined) facts.overkill = Number(overkill);
  return facts;
}

function withoutBridgeNotes(text) {
  const raw = String(text || '');
  const note = BRIDGE_NOTE_RE.exec(raw);
  return (note ? raw.slice(0, note.index) : raw).trim();
}

function roastLine(outcome) {
  if (!outcome || outcome.status !== 'done') return '';
  return withoutBridgeNotes(outcome.summary) || withoutBridgeNotes(outcome.text);
}

function recapNames(recap) {
  return GR.displayWords(recap);
}

function refusedText(r, gameData) {
  if (r.problem === GR.PROBLEM.length) return `${r.length} characters, the limit is ${r.max}`;
  if (r.problem === GR.PROBLEM.char) return `the character U+${r.char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')} is not allowed`;
  if (r.problem === GR.PROBLEM.words) return `words neither in the recap nor plain: ${r.words.join(', ')}`;
  if (r.problem === GR.PROBLEM.refs) return GR.errorsText(r.errors, gameData);
  return 'it is empty';
}

function checkLine(recap, outcome, gameData = null) {
  const line = roastLine(outcome);
  if (!line) return { text: '', refused: '' };
  const r = GR.checkText(line, { store: gameData, names: recapNames(recap), plainWords: ROAST_WORDS, charRe: ROAST_CHAR_RE, maxLength: ROAST_TEXT_MAX });
  return r.ok ? { text: r.text, refused: '' } : { text: '', refused: refusedText(r, gameData) };
}

function overlayCommand(recap, outcome, gameData = null) {
  const facts = recapFacts(recap);
  const { text } = checkLine(recap, outcome, gameData);
  const roast = {};
  if (text) roast.text = text;
  for (const key of ['killer', 'ability', 'overkill', 'zone']) {
    if (facts[key] !== undefined) roast[key] = facts[key];
  }
  return { action: OVERLAY_ACTION, roast };
}

async function sendToOverlay(job, outcome, core) {
  if (!job || typeof job.recap !== 'string') return null;
  const status = outcome && outcome.status;
  if (status !== 'done') {
    core.log(`${core.tag(job)} roast: overlay not told, the run ended with ${status || 'no status'}`);
    return null;
  }
  const options = core.options('stream');
  if (!stream.isEnabled(options)) {
    core.log(`${core.tag(job)} roast: overlay not told, plugins.stream.enabled is false`);
    return null;
  }
  const url = stream.serviceUrl(options);
  const gameData = typeof core.gameData === 'function' ? core.gameData() : null;
  const checked = checkLine(job.recap, outcome, gameData);
  if (checked.refused) core.log(`${core.tag(job)} roast: line left off the card (${checked.refused})`);
  const command = overlayCommand(job.recap, outcome, gameData);
  try {
    const result = await stream.postControl(url, command);
    core.log(`${core.tag(job)} roast: overlay -> ${result.status}${result.message ? ' ' + result.message : ''}`);
    return result;
  } catch (e) {
    core.log(`${core.tag(job)} roast: overlay at ${url} not reached (${e && e.message ? e.message : e})`);
    return null;
  }
}

const plugin = {
  id: 'roast',
  label: 'Death roast',
  tools: TOOLS,
  surfaces: [],
  achievements: false,
  match: job => !!job && job.kind === KIND,
  scratchFolder,
  banner: options => `roasts your deaths (/claude config roast on), runs in ${scratchFolder(options)} (plugins.roast.cwd)`,
  handle(job, core) {
    const cwd = scratchFolder(core.options('roast'));
    try { fs.mkdirSync(cwd, { recursive: true }); }
    catch (e) {
      core.log(`${core.tag(job)} roast: cannot create ${cwd} (${e.message})`);
      core.fail(job, `The roast plugin needs a scratch folder and could not create ${path.resolve(cwd)}: ${e.message}\nSet plugins.roast.cwd in config.json to a folder that works.`);
      return;
    }
    if (isRoast(job)) {
      job.recap = String(job.text || '');
      job.text = roastPrompt(job.text);
    }
    core.runAgent(job, { cwd });
  },
  finished: sendToOverlay,
};

module.exports = plugin;
module.exports.KIND = KIND;
module.exports.RECAP_PREFIX = RECAP_PREFIX;
module.exports.TOOLS = TOOLS;
module.exports.isRecap = isRecap;
module.exports.isRoast = isRoast;
module.exports.roastPrompt = roastPrompt;
module.exports.recapFacts = recapFacts;
module.exports.overlayCommand = overlayCommand;
module.exports.checkLine = checkLine;
module.exports.ROAST_WORDS = ROAST_WORDS;
module.exports.ROAST_TEXT_MAX = ROAST_TEXT_MAX;
module.exports.sendToOverlay = sendToOverlay;
