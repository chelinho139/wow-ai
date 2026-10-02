'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeRoot, gameRunner } = require('./helpers');
const SS = require('../../bridge/sessions');

const ROOT = makeRoot('commands');
const withGame = gameRunner(ROOT);

const OLD = 'f02436b8-8a5f-4c05-823e-bef25f88ff7b';
const UNLISTED = '0badc0de-0000-4000-8000-000000000009';
const TWIN_A = 'abcdef12-0000-4000-8000-000000000001';
const TWIN_B = 'abcdef12-0000-4000-8000-000000000002';

function seedClaudeStore(sb, folder) {
  fs.mkdirSync(folder, { recursive: true });
  const dir = path.join(sb.user, '.claude');
  const put = (id, title) => {
    const p = path.join(dir, 'projects', SS.projectSlug(folder));
    fs.mkdirSync(p, { recursive: true });
    const lines = [{ type: 'user', cwd: folder, sessionId: id }];
    if (title) lines.push({ type: 'ai-title', aiTitle: title, sessionId: id });
    fs.writeFileSync(path.join(p, `${id}.jsonl`), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  };
  put(OLD, 'Fix the build');
  put(UNLISTED, '');
  put(TWIN_A, '');
  put(TWIN_B, '');
  const history = [{ display: 'fix the build', timestamp: Date.now() - 3600000, project: folder, sessionId: OLD }];
  fs.writeFileSync(path.join(dir, 'history.jsonl'), history.map(l => JSON.stringify(l)).join('\n') + '\n');
  fs.writeFileSync(path.join(sb.agentState, `${OLD}.json`), JSON.stringify({ id: OLD, turns: 4, total: {}, created: Date.now() - 3600000 }));
}

function answerTo(h, id, label) {
  return h.client.waitFor(() => {
    const c = h.client.activeChat();
    return c && !c.pendingId && (c.history || []).find(m => m.id === id && m.role !== 'user');
  }, { timeoutMs: 60000, label });
}

async function slash(h, line, label) {
  const id = h.client.lastSeq() + 1;
  h.client.slash(line);
  return answerTo(h, id, label || line);
}

const flagAfter = (argv, flag) => argv[argv.indexOf(flag) + 1];

test('/claude --model and --effort start a new chat whose agent runs with them, and -c changes them on that chat', async () => {
  await withGame({}, async h => {
    await h.client.connect();
    const first = h.client.activeChat().id;
    const r1 = await slash(h, '/claude --model opus --effort high fix the build');
    assert.match(r1.text, /fix the build/);
    assert.notEqual(h.client.activeChat().id, first, 'a new chat');
    let call = h.agentCalls().at(-1);
    assert.equal(flagAfter(call.argv, '--model'), 'opus');
    assert.equal(flagAfter(call.argv, '--effort'), 'high');
    await slash(h, '/claude -c --model sonnet --add-dir extra next step');
    call = h.agentCalls().at(-1);
    assert.equal(flagAfter(call.argv, '--model'), 'sonnet');
    assert.equal(flagAfter(call.argv, '--add-dir'), path.join(h.sb.project, 'extra'), 'a relative folder is taken from the bridge folder');
    assert.equal(call.resume, h.agentCalls().at(-2).session, '-c resumed the same session');
  });
});

test('the ask plugin runs on its own model and effort from plugins.ask.agents, and a chat flag still raises it', async () => {
  const beforeLaunch = sb => {
    const cfg = JSON.parse(fs.readFileSync(sb.config, 'utf8'));
    cfg.agents.claude = { ...cfg.agents.claude, model: 'opus[1m]', effort: 'max' };
    cfg.plugins.ask = { ...cfg.plugins.ask, agents: { claude: { model: 'claude-sonnet-5-5', effort: 'medium' } } };
    fs.writeFileSync(sb.config, JSON.stringify(cfg, null, 2));
  };
  await withGame({ plugin: 'ask', beforeLaunch }, async h => {
    await h.client.connect();
    await h.client.say('best race for a rogue');
    let call = h.agentCalls().at(-1);
    assert.equal(flagAfter(call.argv, '--model'), 'claude-sonnet-5-5');
    assert.equal(flagAfter(call.argv, '--effort'), 'medium');
    await slash(h, '/claude -c --model opus[1m] --effort max plan the whole route');
    call = h.agentCalls().at(-1);
    assert.equal(flagAfter(call.argv, '--model'), 'opus[1m]');
    assert.equal(flagAfter(call.argv, '--effort'), 'max');
  });
});

test('/claude -r resumes a Claude Code session headless in its folder: from the list by prefix, by an id only the bridge can find, and refuses one it cannot', async () => {
  let folder = '';
  await withGame({
    beforeLaunch: sb => {
      folder = path.join(sb.dir, 'elsewhere');
      seedClaudeStore(sb, folder);
    },
  }, async h => {
    await h.client.connect();
    const r = await slash(h, '/claude -r f024 carry on');
    assert.match(r.text, /echo \(turn 5\): carry on/, 'the agent continued the old session');
    const call = h.agentCalls().at(-1);
    assert.equal(call.resume, OLD);
    assert.equal(fs.realpathSync(call.cwd), fs.realpathSync(folder), 'the run happens in the session\'s folder');
    assert.equal(h.client.activeChat().cwd, folder);
    await slash(h, '/claude -c and again');
    assert.equal(h.agentCalls().at(-1).resume, OLD, 'later turns keep the adopted session');

    const found = await slash(h, `/claude -r ${UNLISTED.slice(0, 8)} hello there`);
    assert.match(found.text, /hello there/);
    assert.equal(h.agentCalls().at(-1).resume, UNLISTED, 'an id the list did not have is looked up by the bridge');
    assert.equal(h.client.activeChat().cwd, folder, 'and the chat learns its folder from the reply');

    const calls = h.agentCalls().length;
    const none = await slash(h, '/claude -r deadbeef nope');
    assert.equal(none.role, 'system');
    assert.match(none.text, /No session matches "deadbeef"/);
    const twins = await slash(h, '/claude -r abcdef12 hi');
    assert.equal(twins.role, 'system');
    assert.match(twins.text, /"abcdef12" matches 2 sessions:\nabcdef12  [^\n]*\nabcdef12  [^\n]*\nUse more of the id\./);
    assert.equal(h.agentCalls().length, calls, 'no agent ran for either');
  });
});

test('a Claude chat starts a new session when the system prompt rules changed since its session began, and keeps one that has no recorded rules', async () => {
  await withGame({}, async h => {
    await h.client.connect();
    const editState = async edit => {
      await h.bridge.stop();
      const state = JSON.parse(fs.readFileSync(h.sb.state, 'utf8'));
      edit(state);
      fs.writeFileSync(h.sb.state, JSON.stringify(state));
      h.bridge.start();
      await h.bridge.ready();
    };
    await h.client.say('first');
    const first = h.agentCalls().at(-1);
    assert.ok(!first.resume, 'a new chat starts a session');
    await h.client.say('second');
    assert.equal(h.agentCalls().at(-1).resume, first.session, 'same rules: resumed');
    const recorded = Object.values(h.state().sessionRules || {});
    assert.equal(recorded.length, 1);
    assert.match(recorded[0], /^[0-9a-f]{16}$/);
    await editState(state => { for (const k of Object.keys(state.sessionRules)) state.sessionRules[k] = '0000000000000000'; });
    await h.client.say('third');
    const third = h.agentCalls().at(-1);
    assert.ok(!third.resume, 'changed rules: a new session');
    await h.bridge.waitForLine(/system prompt rules changed \(0000000000000000 -> [0-9a-f]{16}\): new session/, { from: 0 });
    await editState(state => { delete state.sessionRules; });
    await h.client.say('fourth');
    assert.equal(h.agentCalls().at(-1).resume, third.session, 'a session from before the rules were recorded keeps resuming');
  });
});

test.after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});
