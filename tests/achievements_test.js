'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const luaparse = require('luaparse');
const ACH = require('../bridge/achievements');
const P = require('../bridge/protocol');

const FRIDAY_NOON = new Date(2026, 8, 25, 12, 0, 0).getTime();
const TUESDAY_NOON = new Date(2026, 8, 29, 12, 0, 0).getTime();
const TUESDAY_2AM = new Date(2026, 8, 29, 2, 30, 0).getTime();

const ran = (command, output = '', failed = false) => ({ command, output, failed });
const ids = result => result.awards.map(a => a.id);

test('test runners are recognised through prefixes, env vars and shell wrappers', () => {
  for (const cmd of ['npm test', 'npm run test:unit', 'yarn test --watch=false', 'pnpm t', 'bun test', 'npx jest src', 'npx vitest run',
    'pytest -q', 'python -m pytest tests', 'go test ./...', 'cargo test', 'node --test tests/a_test.js', 'CI=1 npm test',
    'cd app && npm test', "bash -lc 'npm test'", './gradlew test', 'bundle exec rspec', 'make test', 'deno test']) {
    assert.ok(ACH.isTestCommand(cmd), cmd);
  }
  for (const cmd of ['npm install', 'npm run build', 'git commit -m "npm test"', 'echo test', 'ls tests', 'node build.js']) {
    assert.equal(ACH.isTestCommand(cmd), false, cmd);
  }
});

test('a test verdict comes from the exit status first, then from the runner output', () => {
  assert.equal(ACH.testVerdict(ran('npm test', 'ok', false)), 'pass');
  assert.equal(ACH.testVerdict(ran('npm test', 'Exit code 1\nboom', true)), 'fail');
  assert.equal(ACH.testVerdict(ran('npm test', 'Exit code 1')), 'fail');
  assert.equal(ACH.testVerdict(ran('npx jest', 'Tests:       2 failed, 10 passed')), 'fail');
  assert.equal(ACH.testVerdict(ran('pytest', '===== 1 failed, 3 passed in 0.2s =====')), 'fail');
  assert.equal(ACH.testVerdict(ran('cargo test', 'test result: FAILED. 1 passed; 1 failed')), 'fail');
  assert.equal(ACH.testVerdict(ran('node --test', '# pass 12\n# fail 0')), 'pass');
  assert.equal(ACH.testVerdict(ran('node --test', '# pass 11\n# fail 1')), 'fail');
  assert.equal(ACH.testVerdict(ran('go test ./...', '--- FAIL: TestX (0.00s)')), 'fail');
  assert.equal(ACH.testVerdict(ran('npm test', 'Tests:       0 failed, 12 passed')), 'pass');
  assert.equal(ACH.testVerdict(ran('npm run build', 'FAIL')), '');
});

test('commits count only when git made one', () => {
  assert.equal(ACH.countCommits(ran('git commit -m "feat: x"', '[main 1a2b3c4] feat: x\n 1 file changed')), 1);
  assert.equal(ACH.countCommits(ran('git -C /repo commit -am fix', '')), 1);
  assert.equal(ACH.countCommits(ran('git add -A && git commit -m x && git push', 'Exit code 1\n[main abcdef1] x\nerror: failed to push', true)), 1);
  assert.equal(ACH.countCommits(ran('git commit -m x', 'nothing to commit, working tree clean', true)), 0);
  assert.equal(ACH.countCommits(ran('git commit --dry-run', '')), 0);
  assert.equal(ACH.countCommits(ran('git status', '')), 0);
  assert.equal(ACH.countCommits(ran('echo "git commit"', '')), 0);
});

test('pushes count only when git pushed something', () => {
  assert.equal(ACH.countPushes(ran('git push origin main', '   1a2b3c4..5d6e7f8  main -> main')), 1);
  assert.equal(ACH.countPushes(ran('git push -u origin feat', ' * [new branch]      feat -> feat')), 1);
  assert.equal(ACH.countPushes(ran('git push', 'Everything up-to-date')), 0);
  assert.equal(ACH.countPushes(ran('git push', 'Exit code 128\nfatal: no upstream', true)), 0);
  assert.equal(ACH.countPushes(ran('git push --dry-run', '')), 0);
  assert.equal(ACH.countPushes(ran('gh pr create', '')), 0);
});

test('--force is spotted in any command, and -f on a git push', () => {
  assert.ok(ACH.usesForce('git push --force origin main'));
  assert.ok(ACH.usesForce('git push --force-with-lease=main:abc origin main'));
  assert.ok(ACH.usesForce('git push -f'));
  assert.ok(ACH.usesForce('git push -uf origin x'));
  assert.ok(ACH.usesForce('npm install --force'));
  assert.equal(ACH.usesForce('rm -f build.log'), false);
  assert.equal(ACH.usesForce('git push origin main'), false);
  assert.equal(ACH.usesForce('echo --forceful'), false);
});

test('Friday and after-midnight read the bridge clock', () => {
  assert.ok(ACH.isFriday(new Date(FRIDAY_NOON)));
  assert.equal(ACH.isFriday(new Date(TUESDAY_NOON)), false);
  assert.ok(ACH.isAfterMidnight(new Date(TUESDAY_2AM)));
  assert.equal(ACH.isAfterMidnight(new Date(TUESDAY_NOON)), false);
});

test('green after red, within a run and across runs of the same chat', () => {
  assert.deepEqual(ACH.wentGreen('', ['fail', 'pass']), { green: true, last: 'pass' });
  assert.deepEqual(ACH.wentGreen('fail', ['pass']), { green: true, last: 'pass' });
  assert.deepEqual(ACH.wentGreen('pass', ['pass']), { green: false, last: 'pass' });
  assert.deepEqual(ACH.wentGreen('', ['pass', 'fail']), { green: false, last: 'fail' });
  assert.deepEqual(ACH.wentGreen('fail', []), { green: false, last: 'fail' });
});

test('Claude stream-json and Codex items become commands with their results', () => {
  const claude = ACH.createRunLog('claude');
  claude.feed({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }, { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'a' } }] } });
  claude.feed({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: [{ type: 'text', text: 'Exit code 1\n1 failing' }] }] } });
  claude.feed({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'git push' } }] } });
  assert.deepEqual(claude.commands().map(c => [c.command, c.failed]), [['npm test', true]], 'a call without its result yet is not counted');
  claude.feed(null);
  claude.feed({ type: 'user', message: { content: 'plain text' } });

  const codex = ACH.createRunLog('codex');
  codex.feed({ type: 'item.started', item: { id: 'c1', type: 'command_execution', command: "bash -lc 'cargo test'" } });
  codex.feed({ type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: "bash -lc 'cargo test'", aggregated_output: 'test result: ok', exit_code: 0, status: 'completed' } });
  assert.deepEqual(codex.commands().map(c => [c.command, c.output, c.failed]), [["bash -lc 'cargo test'", 'test result: ok', false]]);
  assert.equal(ACH.testVerdict(codex.commands()[0]), 'pass');

  const hermes = ACH.createRunLog('hermes');
  hermes.feed({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: { command: 'ls' } }] } });
  assert.deepEqual(hermes.commands(), []);
});

test('one-time achievements are awarded once, and persisted in the state', () => {
  const state = {};
  const first = ACH.evaluate(state, { chat: 's:c1', status: 'done', now: TUESDAY_NOON });
  assert.deepEqual(ids(first), ['first-task']);
  const again = ACH.evaluate(state, { chat: 's:c1', status: 'done', now: TUESDAY_NOON });
  assert.deepEqual(ids(again), []);
  const copy = JSON.parse(JSON.stringify(state));
  const afterRestart = ACH.evaluate(copy, { chat: 's:c1', status: 'done', now: TUESDAY_NOON });
  assert.deepEqual(ids(afterRestart), []);
  assert.equal(copy.achievements.counts.tasks, 3);
  assert.equal(copy.achievements.earned['first-task'].count, 1);
});

test('an error reply is not a finished task', () => {
  const state = {};
  assert.deepEqual(ids(ACH.evaluate(state, { chat: 'k', status: 'error', now: TUESDAY_NOON })), []);
  assert.equal(state.achievements.counts.tasks, 0);
});

test('tests going green is repeatable and remembered per chat between runs', () => {
  const state = {};
  const red = ACH.evaluate(state, { chat: 'k', status: 'done', commands: [ran('npm test', 'Exit code 1', true)], now: TUESDAY_NOON });
  assert.ok(!ids(red).includes('back-to-green'));
  assert.equal(state.achievements.lastTest.k, 'fail');
  const other = ACH.evaluate(state, { chat: 'other', status: 'done', commands: [ran('npm test', 'ok')], now: TUESDAY_NOON });
  assert.ok(!ids(other).includes('back-to-green'), 'another chat has its own history');
  const green = ACH.evaluate(state, { chat: 'k', status: 'done', commands: [ran('npm test', 'ok')], now: TUESDAY_NOON });
  assert.ok(ids(green).includes('back-to-green'));
  const twice = ACH.evaluate(state, { chat: 'k', status: 'done', commands: [ran('npm test', 'Exit code 1', true), ran('npm test', 'ok')], now: TUESDAY_NOON });
  assert.ok(ids(twice).includes('back-to-green'));
  assert.equal(state.achievements.earned['back-to-green'].count, 2);
  assert.equal(state.achievements.counts.greens, 2);
});

test('commit, push, Friday, works on my machine and Leeroy', () => {
  const state = {};
  const r = ACH.evaluate(state, {
    chat: 'k', status: 'done', now: FRIDAY_NOON,
    commands: [ran('git commit -m wip', '[main abc1234] wip'), ran('git push --force', ' + abc1234...def5678 main -> main (forced update)')],
  });
  assert.deepEqual(ids(r).sort(), ['first-commit', 'first-push', 'first-task', 'leeroy', 'merged-on-a-friday', 'works-on-my-machine'].sort());
  const tested = ACH.evaluate({}, { chat: 'k', status: 'done', now: TUESDAY_NOON, commands: [ran('npm test', 'ok'), ran('git push', '   abc1234..def5678  main -> main')] });
  assert.ok(!ids(tested).includes('works-on-my-machine'), 'the tests ran before the push');
  assert.ok(!ids(tested).includes('merged-on-a-friday'));
});

test('milestones count commits and pushes across runs', () => {
  const state = {};
  for (let i = 0; i < 9; i++) ACH.evaluate(state, { chat: 'k', status: 'done', now: TUESDAY_NOON, commands: [ran(`git commit -m c${i}`, `[main abc12${i}0] c`)] });
  assert.ok(!state.achievements.earned['commits-10']);
  const tenth = ACH.evaluate(state, { chat: 'k', status: 'done', now: TUESDAY_NOON, commands: [ran('git commit -m ten', '[main abc9999] ten')] });
  assert.ok(ids(tenth).includes('commits-10'));
  assert.ok(ids(tenth).includes('tasks-10'));
});

test('Night Owl after midnight, Rubber Duck at 50 messages', () => {
  assert.ok(ids(ACH.evaluate({}, { chat: 'k', status: 'done', now: TUESDAY_2AM })).includes('night-owl'));
  assert.ok(!ids(ACH.evaluate({}, { chat: 'k', status: 'error', now: TUESDAY_2AM })).includes('night-owl'));
  assert.ok(!ids(ACH.evaluate({}, { chat: 'k', status: 'done', chatMessages: ACH.RUBBER_DUCK_MESSAGES - 1, now: TUESDAY_NOON })).includes('rubber-duck'));
  assert.ok(ids(ACH.evaluate({}, { chat: 'k', status: 'done', chatMessages: ACH.RUBBER_DUCK_MESSAGES, now: TUESDAY_NOON })).includes('rubber-duck'));
});

test('the roast plugin opts out of achievements, so a death roast is no task, no Night Owl and no Rubber Duck message', () => {
  const PL = require('../bridge/plugins');
  const registry = PL.createRegistry();
  registry.register(require('../bridge/plugins/ask'));
  registry.register(require('../bridge/plugins/claude-code'));
  registry.register(require('../bridge/plugins/roast'));
  assert.equal(ACH.pluginEarns(registry.get('roast')), false);
  assert.equal(ACH.pluginEarns(registry.get('claude-code')), true);
  assert.equal(ACH.pluginEarns(registry.get('ask')), true);
  assert.equal(ACH.pluginEarns(null), true);
});

test('every rule has a catalog entry, and every entry a rule', () => {
  assert.deepEqual(ACH.RULES.map(r => r.id).sort(), ACH.CATALOG.map(c => c.id).sort());
  for (const c of ACH.CATALOG) {
    assert.ok(c.title && c.text && c.points >= 0 && /^Interface\\Icons\\/.test(c.icon), c.id);
  }
});

function luaUnescape(s) {
  return s.replace(/\\(\d{1,3}|.)/g, (_, e) => /^\d/.test(e) ? String.fromCharCode(Number(e)) : e === 'n' ? '\n' : e);
}

function value(node) {
  if (node.type === 'TableConstructorExpression') {
    const out = {};
    const arr = [];
    for (const f of node.fields) {
      if (f.type === 'TableKeyString') out[f.key.name] = value(f.value);
      else arr.push(value(f.value));
    }
    return arr.length ? arr : out;
  }
  if (node.type === 'StringLiteral') return luaUnescape(node.raw.slice(1, -1));
  if (node.type === 'NumericLiteral') return node.value;
  return null;
}

test('the slot file carries recent toasts and the earned list, and reads back as Lua', () => {
  const state = {};
  ACH.evaluate(state, { chat: 'k', status: 'done', now: FRIDAY_NOON, commands: [ran('git push --force', ' + a1b2c3d...e4f5a6b main -> main')] });
  const src = P.luaTable('ClaudeWoW_SlotData', [], { now: FRIDAY_NOON, achievementsLua: ACH.luaAchievements(state) });
  const ast = luaparse.parse(src, { luaVersion: '5.1' });
  const slot = value(ast.body.find(n => n.type === 'AssignmentStatement').init[0]);
  const a = slot.achievements;
  assert.equal(a.seq, state.achievements.seq);
  assert.equal(a.total, ACH.CATALOG.length);
  assert.equal(a.recent.length, a.seq);
  assert.deepEqual(a.recent.map(r => r.seq), a.recent.map((_, i) => i + 1));
  const leeroy = a.earned.find(e => e.id === 'leeroy');
  assert.equal(leeroy.title, 'Leeroy Jenkins');
  assert.equal(leeroy.icon, 'Interface\\Icons\\Ability_Warrior_Charge');
  assert.equal(leeroy.count, 1);
  assert.equal(a.points, a.earned.reduce((sum, e) => sum + e.points, 0));
  assert.equal(P.luaTable('X', [], {}).includes('achievements'), false, 'nothing when the bridge sends none');
});

test('the recent list keeps only the last few toasts', () => {
  const state = {};
  for (let i = 0; i < 12; i++) ACH.evaluate(state, { chat: 'k', status: 'done', now: TUESDAY_NOON, commands: [ran('npm test', 'Exit code 1', true), ran('npm test', 'ok')] });
  assert.ok(state.achievements.recent.length <= 8);
  assert.equal(state.achievements.recent[state.achievements.recent.length - 1].seq, state.achievements.seq);
});
