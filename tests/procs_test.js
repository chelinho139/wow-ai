// bridge/procs.js: the bridge's children lead their own process groups, and
// ending one ends the whole tree, SIGTERM first and SIGKILL after a grace
// period; a child that ignores SIGTERM still dies, and so does what it spawned.
// Then the bridge itself: a SIGTERM to its pid alone ends the agent run it
// has going (and that run's own child) before it exits.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const PR = require('../bridge/procs');

const POSIX = process.platform !== 'win32';
const BRIDGE = path.join(__dirname, '..', 'bridge', 'bridge.js');

function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await sleep(50); }
  return fn();
}
function scratch(name) {
  const dir = path.join(os.tmpdir(), `claude-wow-procs-${name}-${process.pid}-${Date.now().toString(36)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// A process that ignores SIGTERM and starts a grandchild that ignores it too;
// once the grandchild is up it reports both pids: on stdout, or into `file`.
function stubborn(file) {
  return `
    process.on('SIGTERM', () => {});
    const { spawn } = require('child_process');
    const g = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); process.stdout.write('up\\\\n'); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'pipe', 'ignore'] });
    g.stdout.once('data', () => {
      const line = JSON.stringify({ pid: process.pid, gpid: g.pid }) + '\\n';
      ${file ? `require('fs').writeFileSync(${JSON.stringify(file)}, line);` : 'process.stdout.write(line);'}
    });
    setInterval(() => {}, 1000);`;
}

test('killTree: a child that ignores SIGTERM, and the grandchild it started, are both dead after the grace period', async () => {
  const child = PR.spawnChild(process.execPath, ['-e', stubborn()], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
  let err = '';
  child.stderr.on('data', d => { err += d; });
  const info = await new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', d => { out += d; const m = /\{.*\}/.exec(out); if (m) resolve(JSON.parse(m[0])); });
    child.on('error', reject);
    child.on('exit', () => reject(new Error('exited before reporting: ' + err)));
  });
  // Its stdout came through the pipe: a detached child is wired like any other.
  assert.equal(info.pid, child.pid);
  assert.ok(pidAlive(info.gpid), 'the grandchild is up');
  assert.ok(PR.alive(child));

  const logged = [];
  const exited = new Promise(resolve => child.on('exit', (code, sig) => resolve({ code, sig })));
  const t0 = Date.now();
  PR.killTree(child, { graceMs: 400, log: l => logged.push(l) });
  const r = await exited;
  const took = Date.now() - t0;
  if (POSIX) {
    assert.equal(r.sig, 'SIGKILL', `SIGTERM was ignored, so SIGKILL ended it (${JSON.stringify(r)})`);
    assert.ok(took >= 350 && took < 5000, `the grace period was waited out, no longer: ${took} ms`);
    assert.equal(logged.length, 1);
    assert.match(logged[0], new RegExp(`^pid ${child.pid} ignored SIGTERM for 400 ms; SIGKILL to its process group$`));
  }
  assert.ok(await until(() => !pidAlive(info.gpid)), 'the grandchild died with the group');
  assert.ok(!PR.alive(child));
  PR.killTree(child); // already gone: a no-op
  } finally { try { if (POSIX) process.kill(-child.pid, 'SIGKILL'); else child.kill(); } catch {} }
});

// The case the escalation exists for: the child itself goes on SIGTERM, but a
// process it started ignores it and keeps the child's stdout pipe open (an npm
// launcher's real binary, a test runner an agent shelled out to), so 'close'
// never comes and the bridge would keep the run in `running` for good.
test('killTree: a child that exits while its grandchild ignores SIGTERM and holds the pipe still closes, once the group is SIGKILLed', { skip: !POSIX && 'process groups' }, async () => {
  const script = `
    const { spawn } = require('child_process');
    const g = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); process.stdout.write('up\\\\n'); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'inherit', 'ignore'] });
    process.stderr.write(String(g.pid) + '\\n');
    setInterval(() => {}, 1000);`;
  const child = PR.spawnChild(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  const cleanup = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }; // a failed assertion must not leave it pinning the runner
  try {
  let out = '', err = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { err += d; });
  assert.ok(await until(() => /up/.test(out) && /\d+/.test(err)), 'the grandchild is up and writing to the shared pipe: ' + JSON.stringify({ out, err }));
  const gpid = Number(/\d+/.exec(err)[0]);
  const logged = [];
  const exitedAt = new Promise(resolve => child.on('exit', (code, sig) => resolve({ code, sig, at: Date.now() })));
  const closedAt = new Promise(resolve => child.on('close', () => resolve(Date.now())));
  const t0 = Date.now();
  PR.killTree(child, { graceMs: 400, log: l => logged.push(l) });
  const ex = await exitedAt;
  assert.equal(ex.sig, 'SIGTERM', 'the child itself honoured SIGTERM');
  assert.ok(ex.at - t0 < 350, 'and went at once');
  assert.ok(PR.open(child) && !PR.alive(child), 'gone, but its pipe is still held');
  const closed = await Promise.race([closedAt, sleep(5000).then(() => null)]);
  assert.ok(closed !== null, 'close came');
  assert.ok(closed - t0 >= 350 && closed - t0 < 5000, `after the grace period: ${closed - t0} ms`);
  assert.equal(logged.length, 1);
  assert.match(logged[0], new RegExp(`^pid ${child.pid} \\(gone, but something it started\\) ignored SIGTERM for 400 ms; SIGKILL to its process group$`));
  assert.ok(await until(() => !pidAlive(gpid)), 'the grandchild is dead');
  assert.ok(!PR.open(child));
  } finally { cleanup(); }
});

test('killTree: a child that honours SIGTERM ends with it, and no SIGKILL follows', async () => {
  const child = PR.spawnChild(process.execPath, ['-e', "process.stdout.write('up\\n'); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise(r => child.stdout.once('data', r));
  const logged = [];
  const exited = new Promise(resolve => child.on('exit', (code, sig) => resolve({ code, sig })));
  PR.killTree(child, { graceMs: 400, log: l => logged.push(l) });
  const r = await exited;
  if (POSIX) assert.equal(r.sig, 'SIGTERM');
  await sleep(600);
  assert.deepEqual(logged, [], 'nothing escalated');
});

test('killAll: ends every child it is given and calls back once they are gone, within the grace period plus a moment', async () => {
  const kids = [0, 1].map(() => PR.spawnChild(process.execPath, ['-e', stubborn()], { stdio: ['ignore', 'pipe', 'ignore'] }));
  try {
  const infos = await Promise.all(kids.map(k => new Promise(resolve => { let out = ''; k.stdout.on('data', d => { out += d; const m = /\{.*\}/.exec(out); if (m) resolve(JSON.parse(m[0])); }); })));
  const t0 = Date.now();
  await new Promise(resolve => PR.killAll([...kids, null, undefined], { graceMs: 400 }, resolve));
  const took = Date.now() - t0;
  assert.ok(took < 5000, `${took} ms`);
  for (const k of kids) assert.ok(!PR.alive(k));
  for (const i of infos) assert.ok(await until(() => !pidAlive(i.gpid)), 'grandchildren too');
  // Nothing to end: called back at once.
  const t1 = Date.now();
  await new Promise(resolve => PR.killAll([], { graceMs: 400 }, resolve));
  assert.ok(Date.now() - t1 < 100);
  } finally { for (const k of kids) { try { if (POSIX) process.kill(-k.pid, 'SIGKILL'); else k.kill(); } catch {} } }
});

// The bridge, with an agent that ignores SIGTERM and never finishes (and has a
// child of its own), gets a SIGTERM to its pid alone, the way `kill <pid>`,
// launchd or systemd send one: the run and its child must be gone when the
// bridge exits, and the bridge must exit with the signal's code, not hang.
test('the bridge on SIGTERM ends a running agent that ignores SIGTERM, and that agent\'s own child, then exits 143', { skip: !POSIX && 'a TerminateProcess on Windows runs no handler' }, async () => {
  const dir = scratch('bridge');
  const home = path.join(dir, 'home');
  const addons = path.join(dir, 'client', 'Interface', 'AddOns');
  const project = path.join(dir, 'project');
  for (const d of ['sig', 'ack', 'act', 'presence']) fs.mkdirSync(path.join(addons, 'ClaudeWoW_Runtime', d), { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const pidsFile = path.join(dir, 'pids.json');
  const agent = path.join(dir, 'stubborn-claude.js');
  fs.writeFileSync(agent, stubborn(pidsFile));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    addonDir: addons, savedVariablesFile: path.join(dir, 'ClaudeWoW.lua'), inboxFile: path.join(addons, 'ClaudeWoW_Runtime', 'Inbox.lua'),
    defaultCwd: project, slots: 1, agent: 'claude', agents: { claude: { path: agent } }, plugins: { default: 'claude-code' },
    gameContext: false, primerFile: '', capture: { enabled: false }, killGraceMs: 500, timeoutMs: 600000,
  }));
  const bridge = spawn(process.execPath, [BRIDGE, '--inject', 'hang in there', '--project', project], {
    env: { ...process.env, CLAUDE_WOW_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  bridge.stdout.on('data', d => { out += d; });
  bridge.stderr.on('data', d => { out += d; });
  const exited = new Promise(resolve => bridge.on('exit', (code, sig) => resolve({ code, sig })));
  try {
  assert.ok(await until(() => fs.existsSync(pidsFile), 15000), 'the agent run started and has its child up: ' + out);
  const pids = JSON.parse(fs.readFileSync(pidsFile, 'utf8'));
  assert.ok(pidAlive(pids.pid) && pidAlive(pids.gpid));

  const t0 = Date.now();
  bridge.kill('SIGTERM');
  const r = await Promise.race([exited, sleep(10000).then(() => ({ timeout: true }))]);
  const took = Date.now() - t0;
  assert.deepEqual(r, { code: 143, sig: null }, `the bridge exited on its own terms (${took} ms): ` + out);
  assert.ok(took >= 450 && took < 6000, `after the grace period, not much later: ${took} ms`);
  assert.match(out, /SIGTERM: stopping; ending 1 child process \(SIGTERM, SIGKILL after 500 ms\)/, out);
  assert.match(out, new RegExp(`pid ${pids.pid} ignored SIGTERM for 500 ms; SIGKILL to its process group`), out);
  // The run's own 'close' handler had its turn before the exit: the chat was told.
  assert.match(out, /#1 error \(94 chars, no summary\)/, out);
  assert.match(fs.readFileSync(path.join(addons, 'ClaudeWoW_Runtime', 'Inbox.lua'), 'utf8'), /status = "error",\n\t\t\ttext = "The bridge was stopped while Claude was still working\. Send the message again once it is back\.",/);
  assert.ok(await until(() => !pidAlive(pids.pid)), 'the agent is dead');
  assert.ok(await until(() => !pidAlive(pids.gpid)), 'and so is its child');
  fs.rmSync(dir, { recursive: true, force: true });
  } finally {
    try { bridge.kill('SIGKILL'); } catch {}
    try { const p = JSON.parse(fs.readFileSync(pidsFile, 'utf8')); process.kill(-p.pid, 'SIGKILL'); } catch {}
  }
});
