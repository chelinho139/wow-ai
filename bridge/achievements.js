'use strict';

const P = require('./protocol');
const A = require('./agents');

const ICON_DIR = 'Interface\\Icons\\';
const NIGHT_OWL_LAST_HOUR = 4;
const FRIDAY = 5;
const RUBBER_DUCK_MESSAGES = 50;
const RECENT_TOASTS_KEPT = 8;
const OUTPUT_KEPT_CHARS = 4000;

const CATALOG = [
  { id: 'first-task', title: 'Hello, World', text: 'An agent finished its first task for you.', points: 10, icon: 'INV_Misc_Note_01' },
  { id: 'tasks-10', title: 'Questing Buddy', text: 'Ten tasks finished.', points: 10, icon: 'INV_Misc_Map_01' },
  { id: 'tasks-100', title: 'Loremaster of the Repo', text: 'One hundred tasks finished.', points: 25, icon: 'INV_Misc_Book_11' },
  { id: 'back-to-green', title: 'Back From the Dead', text: 'The tests passed after failing.', points: 10, icon: 'Spell_Holy_Resurrection', repeatable: true },
  { id: 'first-commit', title: 'Signed and Sealed', text: 'The agent made its first git commit.', points: 10, icon: 'INV_Scroll_03' },
  { id: 'commits-10', title: 'Commit Streak', text: 'Ten git commits by your agents.', points: 10, icon: 'INV_Scroll_05' },
  { id: 'commits-100', title: 'Centurion', text: 'One hundred git commits by your agents.', points: 25, icon: 'INV_Misc_Book_09' },
  { id: 'first-push', title: 'Ship It', text: 'The agent pushed to a remote.', points: 10, icon: 'Ability_Rogue_Sprint' },
  { id: 'pushes-10', title: 'Frequent Flyer', text: 'Ten pushes by your agents.', points: 10, icon: 'Ability_Hunter_AspectOfTheHawk' },
  { id: 'merged-on-a-friday', title: 'Merged on a Friday', text: 'Committed or pushed on a Friday. Bold.', points: 10, icon: 'Spell_Fire_Incinerate' },
  { id: 'night-owl', title: 'Night Owl', text: 'A task finished after midnight.', points: 10, icon: 'Ability_EyeOfTheOwl' },
  { id: 'works-on-my-machine', title: 'It Works On My Machine', text: 'Pushed without running the tests first.', points: 10, icon: 'INV_Misc_Gear_01' },
  { id: 'rubber-duck', title: 'Rubber Duck', text: `${RUBBER_DUCK_MESSAGES} messages in one chat.`, points: 10, icon: 'INV_Misc_Head_Murloc_01' },
  { id: 'leeroy', title: 'Leeroy Jenkins', text: 'The agent ran a command with --force.', points: 10, icon: 'Ability_Warrior_Charge' },
].map(entry => ({ ...entry, icon: ICON_DIR + entry.icon }));

const CATALOG_BY_ID = new Map(CATALOG.map(entry => [entry.id, entry]));

const COMMAND_SEPARATORS = /&&|\|\||[;\n|&]/;
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const COMMAND_PREFIXES = new Set(['sudo', 'time', 'exec', 'env', 'command', 'nice', 'npx', 'bunx', 'pnpx']);
const TWO_WORD_PREFIXES = [['bundle', 'exec'], ['python', '-m'], ['python3', '-m'], ['uv', 'run'], ['poetry', 'run'], ['pnpm', 'exec'], ['yarn', 'dlx'], ['npm', 'exec']];
const GIT_OPTIONS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);

const TEST_COMMANDS = [
  /^(?:npm|pnpm|yarn|bun)(?: run)? (?:test|t)(?::\S+)?(?:\s|$)/,
  /^(?:jest|vitest|mocha|pytest|py\.test|rspec|phpunit|tox|ava|tap|karma|cypress run|playwright test)(?:\s|$)/,
  /^(?:\S*\/)?(?:go|cargo|deno|mix|dotnet|mvn|gradle|gradlew|make|swift|zig|flutter|ctest) test(?:\s|$)/,
  /^node(?: \S+)* --test(?:\s|$)/,
];

const TEST_FAILURE_SIGNS = [
  /\b[1-9]\d* (?:failed|failing|failures?)\b/i,
  /^\s*FAIL\b/m,
  /^\s*FAILED\b/m,
  /test result: FAILED/,
  /^# fail [1-9]/m,
  /\bTests? failed\b/i,
  /^--- FAIL:/m,
];

const EXIT_CODE_LINE = /^Exit code ([0-9]+)/m;
const COMMIT_SUMMARY_LINE = /^\[[^\]\n]+ [0-9a-f]{7,40}\]/m;
const NOTHING_TO_COMMIT = /nothing to commit|no changes added to commit|nothing added to commit/i;
const PUSH_UPDATE_LINE = /^\s*(?:[+*]? ?[0-9a-f]{7,40}\.{2,3}[0-9a-f]{7,40}|\* \[new (?:branch|tag)\])\s+\S+\s+->\s+\S+/m;
const PUSH_UP_TO_DATE = /Everything up-to-date/;
const FORCE_OPTION = /^--force(?:-with-lease|-if-includes)?(?:=.*)?$/;
const SHORT_FLAGS_WITH_F = /^-[a-zA-Z]*f[a-zA-Z]*$/;

function commandSegments(command) {
  return String(A.shellInner(command) || '').split(COMMAND_SEPARATORS).map(s => s.trim()).filter(Boolean);
}

function unquote(word) {
  if (word.length >= 2 && (word[0] === '"' || word[0] === "'") && word[word.length - 1] === word[0]) return word.slice(1, -1);
  return word;
}

function segmentWords(segment) {
  const words = (String(segment).match(/"[^"]*"|'[^']*'|\S+/g) || []).map(unquote);
  let i = 0;
  for (;;) {
    if (i < words.length && (ENV_ASSIGNMENT.test(words[i]) || COMMAND_PREFIXES.has(words[i]))) { i++; continue; }
    const pair = TWO_WORD_PREFIXES.find(([a, b]) => words[i] === a && words[i + 1] === b);
    if (pair) { i += 2; continue; }
    break;
  }
  return words.slice(i);
}

function programName(word) {
  return String(word || '').split(/[\\/]/).pop().replace(/\.exe$/i, '');
}

function gitSubcommand(words) {
  if (programName(words[0]) !== 'git') return null;
  let i = 1;
  while (i < words.length && words[i].startsWith('-')) i += GIT_OPTIONS_WITH_VALUE.has(words[i]) ? 2 : 1;
  return i < words.length ? { name: words[i], args: words.slice(i + 1) } : null;
}

function testRunner(segment) {
  const words = segmentWords(segment);
  if (!words.length) return '';
  const line = [programName(words[0]), ...words.slice(1)].join(' ');
  return TEST_COMMANDS.some(re => re.test(line)) ? programName(words[0]) : '';
}

function isTestCommand(command) {
  return commandSegments(command).some(seg => testRunner(seg) !== '');
}

function exitedWithFailure(run) {
  if (run.failed) return true;
  const m = EXIT_CODE_LINE.exec(String(run.output || ''));
  return !!(m && Number(m[1]) !== 0);
}

function testVerdict(run) {
  if (!isTestCommand(run.command)) return '';
  if (exitedWithFailure(run)) return 'fail';
  const output = String(run.output || '');
  return TEST_FAILURE_SIGNS.some(re => re.test(output)) ? 'fail' : 'pass';
}

function gitSegments(command, name) {
  return commandSegments(command).map(segmentWords).map(gitSubcommand).filter(sub => sub && sub.name === name);
}

function countCommits(run) {
  const commits = gitSegments(run.command, 'commit').filter(sub => !sub.args.includes('--dry-run') && !sub.args.includes('-h') && !sub.args.includes('--help'));
  if (!commits.length) return 0;
  const output = String(run.output || '');
  if (COMMIT_SUMMARY_LINE.test(output)) return commits.length;
  if (exitedWithFailure(run) || NOTHING_TO_COMMIT.test(output)) return 0;
  return commits.length;
}

function countPushes(run) {
  const pushes = gitSegments(run.command, 'push').filter(sub => !sub.args.includes('--dry-run') && !sub.args.includes('-n'));
  if (!pushes.length) return 0;
  const output = String(run.output || '');
  if (PUSH_UPDATE_LINE.test(output)) return pushes.length;
  if (exitedWithFailure(run) || PUSH_UP_TO_DATE.test(output)) return 0;
  return pushes.length;
}

function usesForce(command) {
  return commandSegments(command).map(segmentWords).some(words => {
    if (words.some(w => FORCE_OPTION.test(w))) return true;
    const git = gitSubcommand(words);
    return !!(git && git.name === 'push' && git.args.some(w => SHORT_FLAGS_WITH_F.test(w)));
  });
}

function isFriday(when) {
  return when.getDay() === FRIDAY;
}

function isAfterMidnight(when) {
  return when.getHours() <= NIGHT_OWL_LAST_HOUR;
}

function summarizeRun(commands) {
  const summary = { verdicts: [], commits: 0, pushes: 0, forced: false, ranTests: false };
  for (const run of commands || []) {
    const verdict = testVerdict(run);
    if (verdict) { summary.verdicts.push(verdict); summary.ranTests = true; }
    summary.commits += countCommits(run);
    summary.pushes += countPushes(run);
    if (usesForce(run.command)) summary.forced = true;
  }
  return summary;
}

function wentGreen(previousVerdict, verdicts) {
  let last = previousVerdict || '';
  let green = false;
  for (const v of verdicts) {
    if (v === 'pass' && last === 'fail') green = true;
    last = v;
  }
  return { green, last };
}

function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(part => (part && typeof part.text === 'string' ? part.text : '')).join('\n');
  return '';
}

function claudeActivity(ev) {
  const found = [];
  const content = ev && ev.message && Array.isArray(ev.message.content) ? ev.message.content : [];
  if (ev.type === 'assistant') {
    for (const block of content) {
      if (block && block.type === 'tool_use' && block.name === 'Bash' && block.input && typeof block.input.command === 'string') {
        found.push({ kind: 'call', key: String(block.id || ''), command: block.input.command });
      }
    }
  } else if (ev.type === 'user') {
    for (const block of content) {
      if (block && block.type === 'tool_result') {
        found.push({ kind: 'result', key: String(block.tool_use_id || ''), output: toolResultText(block.content), failed: block.is_error === true });
      }
    }
  }
  return found;
}

function codexActivity(ev) {
  const item = ev && ev.item;
  if (ev.type !== 'item.completed' || !item || item.type !== 'command_execution') return [];
  const failed = (Number.isInteger(item.exit_code) && item.exit_code !== 0) || item.status === 'failed';
  const key = String(item.id || '');
  return [
    { kind: 'call', key, command: String(item.command || '') },
    { kind: 'result', key, output: String(item.aggregated_output || ''), failed },
  ];
}

const ACTIVITY_READERS = { claude: claudeActivity, codex: codexActivity };

function createRunLog(agentId) {
  const read = ACTIVITY_READERS[agentId] || (() => []);
  const commands = [];
  const byKey = new Map();
  return {
    feed(ev) {
      if (!ev || typeof ev !== 'object') return;
      let found;
      try { found = read(ev); } catch { return; }
      for (const step of found) {
        if (step.kind === 'call') {
          const run = { command: step.command, output: '', failed: false, finished: false };
          commands.push(run);
          if (step.key) byKey.set(step.key, run);
        } else {
          const run = byKey.get(step.key);
          if (!run) continue;
          run.output = String(step.output || '').slice(0, OUTPUT_KEPT_CHARS);
          run.failed = step.failed;
          run.finished = true;
        }
      }
    },
    commands: () => commands.filter(run => run.finished),
  };
}

function newLedger() {
  return { seq: 0, earned: {}, counts: { tasks: 0, commits: 0, pushes: 0, greens: 0 }, lastTest: {}, recent: [] };
}

function ledgerOf(state) {
  const ledger = state.achievements && typeof state.achievements === 'object' ? state.achievements : newLedger();
  const blank = newLedger();
  for (const key of Object.keys(blank)) if (ledger[key] === undefined) ledger[key] = blank[key];
  for (const key of Object.keys(blank.counts)) if (!Number.isFinite(ledger.counts[key])) ledger.counts[key] = 0;
  state.achievements = ledger;
  return ledger;
}

const RULES = [
  { id: 'first-task', when: f => f.counts.tasks >= 1 },
  { id: 'tasks-10', when: f => f.counts.tasks >= 10 },
  { id: 'tasks-100', when: f => f.counts.tasks >= 100 },
  { id: 'back-to-green', when: f => f.green },
  { id: 'first-commit', when: f => f.counts.commits >= 1 },
  { id: 'commits-10', when: f => f.counts.commits >= 10 },
  { id: 'commits-100', when: f => f.counts.commits >= 100 },
  { id: 'first-push', when: f => f.counts.pushes >= 1 },
  { id: 'pushes-10', when: f => f.counts.pushes >= 10 },
  { id: 'merged-on-a-friday', when: f => isFriday(f.when) && f.run.commits + f.run.pushes > 0 },
  { id: 'night-owl', when: f => f.finished && isAfterMidnight(f.when) },
  { id: 'works-on-my-machine', when: f => f.run.pushes > 0 && !f.run.ranTests },
  { id: 'rubber-duck', when: f => f.chatMessages >= RUBBER_DUCK_MESSAGES },
  { id: 'leeroy', when: f => f.run.forced },
];

function evaluate(state, { chat = '', status = '', commands = [], chatMessages = 0, now = Date.now() } = {}) {
  const ledger = ledgerOf(state);
  const run = summarizeRun(commands);
  const finished = status === 'done';
  const { green, last } = wentGreen(ledger.lastTest[chat], run.verdicts);
  if (last) ledger.lastTest[chat] = last;
  if (finished) ledger.counts.tasks += 1;
  ledger.counts.commits += run.commits;
  ledger.counts.pushes += run.pushes;
  if (green) ledger.counts.greens += 1;
  const facts = { run, counts: ledger.counts, green, finished, chatMessages, when: new Date(now) };
  const awards = [];
  for (const rule of RULES) {
    const entry = CATALOG_BY_ID.get(rule.id);
    const had = ledger.earned[rule.id];
    if (had && !entry.repeatable) continue;
    if (!rule.when(facts)) continue;
    ledger.seq += 1;
    const at = Math.floor(now / 1000);
    ledger.earned[rule.id] = { at: had ? had.at : at, last: at, count: (had ? had.count : 0) + 1 };
    ledger.recent.push({ seq: ledger.seq, id: rule.id, at });
    awards.push(entry);
  }
  while (ledger.recent.length > RECENT_TOASTS_KEPT) ledger.recent.shift();
  return { awards, changed: awards.length > 0 || finished || !!last || run.commits > 0 || run.pushes > 0 };
}

function totalPoints(ledger) {
  return Object.keys(ledger.earned).reduce((sum, id) => sum + (CATALOG_BY_ID.has(id) ? CATALOG_BY_ID.get(id).points : 0), 0);
}

function luaEntry(entry, extra) {
  return `{ id = ${P.luaStr(entry.id)}, title = ${P.luaStr(entry.title)}, text = ${P.luaStr(entry.text)}, points = ${entry.points}, icon = ${P.luaStr(entry.icon)}, ${extra} }`;
}

function luaAchievements(state) {
  const ledger = ledgerOf(state);
  const recent = ledger.recent.filter(r => CATALOG_BY_ID.has(r.id))
    .map(r => luaEntry(CATALOG_BY_ID.get(r.id), `seq = ${r.seq}, at = ${r.at}`));
  const earned = Object.entries(ledger.earned).filter(([id]) => CATALOG_BY_ID.has(id))
    .sort((a, b) => a[1].at - b[1].at)
    .map(([id, e]) => luaEntry(CATALOG_BY_ID.get(id), `at = ${e.at}, count = ${e.count}`));
  return [
    '\tachievements = {',
    `\t\tseq = ${ledger.seq},`,
    `\t\tpoints = ${totalPoints(ledger)},`,
    `\t\ttotal = ${CATALOG.length},`,
    `\t\trecent = { ${recent.join(', ')} },`,
    `\t\tearned = { ${earned.join(', ')} },`,
    '\t},',
  ].join('\n');
}

module.exports = {
  CATALOG, RULES, RUBBER_DUCK_MESSAGES,
  commandSegments, segmentWords, gitSubcommand, testRunner, isTestCommand, testVerdict,
  countCommits, countPushes, usesForce, isFriday, isAfterMidnight, summarizeRun, wentGreen,
  claudeActivity, codexActivity, createRunLog, newLedger, ledgerOf, evaluate, totalPoints, luaAchievements,
};
