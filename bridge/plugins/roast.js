'use strict';

const fs = require('fs');
const path = require('path');
const ask = require('./ask');

const KIND = 'roast';
const RECAP_PREFIX = 'Death recap:';

const TOOLS = [
  'This chat is the player\'s death roast. When a message is a death recap (it starts with "Death recap:"), the player has just died in World of Warcraft and the addon sent you the last seconds of the combat log: who hit them, with what, for how much, the overkill, the zone and the levels.',
  'Reply with a short, funny, affectionate roast of that death: two or three sentences, like a friend in guild chat who saw it happen. Use the specifics (the mob, the ability, the overkill, a level gap, the zone) because the details are the joke. Punch at the play, never at the person. No slurs, nothing about real-world identity, appearance or intelligence, nothing cruel. At most one practical tip, and only if it is also funny.',
  'If a screenshot of the screen is attached, you may use what you see in it. Do not use the map or write macros in this chat. Your TL;DR line is the best line of the roast.',
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
    if (isRoast(job)) job.text = roastPrompt(job.text);
    core.runAgent(job, { cwd });
  },
};

module.exports = plugin;
module.exports.KIND = KIND;
module.exports.RECAP_PREFIX = RECAP_PREFIX;
module.exports.TOOLS = TOOLS;
module.exports.isRecap = isRecap;
module.exports.isRoast = isRoast;
module.exports.roastPrompt = roastPrompt;
