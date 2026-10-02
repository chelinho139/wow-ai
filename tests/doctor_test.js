'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSystem, isReadOnlyCommand } = require('../dev/doctor/system');
const { gather, parsePlist } = require('../dev/doctor/context');
const C = require('../dev/doctor/checks');
const Doctor = require('../dev/doctor');
const Service = require('../bridge/service');
const GameFs = require('../bridge/gamefs');

const NOW = Date.parse('2026-09-29T18:40:00Z');
const MINUTE = 60 * 1000;
const iso = ms => new Date(ms).toISOString();

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function makeWorld(name, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `doctor-${name}-`));
  const home = path.join(root, 'home');
  const checkout = path.join(root, 'checkout');
  const nodeBin = path.join(root, 'node', 'bin', 'node');
  const wowRoot = path.join(root, 'World of Warcraft');
  const clientDir = path.join(wowRoot, '_classic_beta_');
  const addonDir = path.join(clientDir, 'Interface', 'AddOns');
  const svFile = path.join(clientDir, 'WTF', 'Account', 'A', 'SavedVariables', 'ClaudeWoW.lua');
  const project = path.join(root, 'project');
  const dirs = Service.dirs('darwin', {}, home);
  const clawHome = path.join(home, '.claude-wow');

  if (options.node !== false) write(nodeBin, '');
  write(path.join(checkout, 'bridge', 'supervisor.js'), '');
  fs.utimesSync(path.join(checkout, 'bridge', 'supervisor.js'), new Date(NOW - 24 * 60 * MINUTE), new Date(NOW - 24 * 60 * MINUTE));
  fs.mkdirSync(path.join(checkout, '.git'), { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  if (options.plist !== false) {
    write(dirs.definition, Service.launchdPlist({ node: nodeBin, script: path.join(checkout, 'bridge', 'supervisor.js'), cwd: checkout, logFile: Service.launchdLogFile(dirs), env: { HOME: home } }));
  }
  const config = {
    addonDir, savedVariablesFile: svFile, defaultCwd: project, slots: 200, presenceMax: 2000,
    agent: 'claude', agents: { claude: { model: 'claude-x', permissionMode: 'default', allowedTools: ['WebSearch'] } },
    ...options.config,
  };
  write(path.join(clawHome, 'config.json'), JSON.stringify(config));
  write(path.join(clawHome, 'state.json'), options.stateText !== undefined ? options.stateText : JSON.stringify(options.state || {
    sessions: { 'chat:abc': 'sess-1' },
    sessionCwd: { 'chat:abc': project },
    sessionAgent: { 'chat:abc': 'claude' },
    sessionUsage: { 'chat:abc': { turns: 14, context: 141443, window: 1000000, cost: 82.2962585 } },
  }));
  write(path.join(clawHome, 'transcripts.json'), '{}');
  write(Service.pidFile(dirs), JSON.stringify({ pid: 100, bridgePid: 101, started: NOW - 3 * 60 * MINUTE, mode: 'service', repo: checkout }));
  const logLines = options.logLines || [
    `[${iso(NOW - 5 * MINUTE)}] strip #70 (screenshot WoWScrnShot_092926_112926.png, 1920x1080 png, codec 2, 3 row(s)): 1 message(s)`,
    `[${iso(NOW - 4 * MINUTE)}] #70@abc done (743 chars, summary 109, turn 13)`,
  ];
  write(Service.serviceLogFile(dirs), logLines.join('\n') + '\n');
  write(path.join(clawHome, 'bridge.log'), logLines.join('\n') + '\n');

  const toc = options.toc || '16001';
  write(path.join(addonDir, 'ClaudeWoW', 'ClaudeWoW.toc'), `## Interface: ${toc}\n## Title: Claude WoW\n`);
  write(path.join(addonDir, 'ClaudeWoW_S001', 'ClaudeWoW_S001.toc'), `## Interface: ${options.slotToc || toc}\n`);
  if (options.runtimeToc !== false) write(path.join(addonDir, 'ClaudeWoW_Runtime', 'ClaudeWoW_Runtime.toc'), `## Interface: ${options.runtimeToc || toc}\n`);
  for (const slot of options.ack || Array.from({ length: 200 }, (_, i) => i + 1)) write(path.join(addonDir, 'ClaudeWoW_Runtime', 'ack', String(slot).padStart(3, '0') + '.wav'), 'RIFF');
  for (const slot of options.sig || [2]) write(path.join(addonDir, 'ClaudeWoW_Runtime', 'sig', String(slot).padStart(3, '0') + '.wav'), 'RIFF');
  fs.mkdirSync(path.join(addonDir, 'ClaudeWoW_Runtime', 'presence'), { recursive: true });
  write(path.join(addonDir, 'ClaudeWoW_Runtime', 'presence', 'a', '0001.wav'), 'RIFF');
  for (const rel of options.presenceFiles || []) write(path.join(addonDir, 'ClaudeWoW_Runtime', ...rel.split('/')), 'RIFF');
  for (const rel of options.legacySignals || []) write(path.join(addonDir, 'ClaudeWoW', ...rel.split('/')), 'RIFF');
  write(svFile, `ClaudeWoWDB = {\n\t["lastSeq"] = ${options.lastSeq === undefined ? 3 : options.lastSeq},\n}\n`);
  write(path.join(wowRoot, '.build.info'), 'Branch!STRING:0|Version!STRING:0|Product!STRING:0\nus|12.1.0.69933|wow\nus|' + (options.clientVersion || '1.60.1.70058') + '|wow_classic_beta\n');
  fs.mkdirSync(path.join(clientDir, 'Screenshots'), { recursive: true });
  for (let i = 0; i < (options.leftovers || 0); i++) write(path.join(clientDir, 'Screenshots', `WoWScrnShot_092926_1000${String(i).padStart(2, '0')}.png`), 'x');
  if (options.sessionBytes) write(path.join(C.claudeProjectDir(home, project), 'sess-1.jsonl'), Buffer.alloc(options.sessionBytes));
  for (const legacy of options.legacy || []) write(path.join(checkout, 'bridge', legacy), '{}');
  GameFs.repair(addonDir);
  return { root, home, checkout, nodeBin, addonDir, clientDir, project, dirs, clawHome };
}

function fakeRunner(world, overrides = {}) {
  const calls = [];
  const git = {
    'rev-parse HEAD': 'aaaaaaa1111111111111111111111111111111',
    'rev-parse --abbrev-ref HEAD': 'main',
    'log': `${Math.floor((NOW - 5 * 60 * MINUTE) / 1000)}\taaaaaaa\tcommit subject`,
    'status': '',
    'reflog': `HEAD@{${Math.floor((NOW - 5 * 60 * MINUTE) / 1000)}}\tcommit: commit subject`,
    'rev-parse --show-toplevel': world.project,
    ...overrides.git,
  };
  const responses = {
    launchctl: overrides.launchctl !== undefined ? overrides.launchctl : { ok: true, out: '\tstate = running\n\truns = 3\n\tpid = 100\n\tlast exit code = 0\n' },
    ps: pid => (overrides.ps && pid in overrides.ps ? overrides.ps[pid] : { ok: true, out: `  03:00:00 /node/bin/node something\n` }),
    pgrep: overrides.pgrep || { ok: false, out: '' },
    gh: overrides.gh || { ok: true, out: JSON.stringify([{ conclusion: 'success', status: 'completed', headSha: 'aaaaaaa1111111111111111111111111111111' }]) },
  };
  const run = (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    assert.ok(isReadOnlyCommand(cmd, args), `not read-only: ${cmd} ${args.join(' ')}`);
    if (cmd === 'ps') return responses.ps(args[args.length - 1]);
    if (cmd === 'git') {
      const rest = args.slice(2).filter(a => a !== '--no-optional-locks').join(' ');
      const key = Object.keys(git).find(k => rest === k || rest.startsWith(k + ' '));
      const value = key === undefined ? null : git[key];
      return value === null ? { ok: false, out: '' } : { ok: true, out: value + '\n' };
    }
    return responses[cmd];
  };
  run.calls = calls;
  return run;
}

function context(world, runOverrides = {}) {
  const run = fakeRunner(world, runOverrides);
  const sys = createSystem({ home: world.home, env: {}, uid: 501, now: () => NOW, run });
  return gather(sys);
}

const byId = (results, id) => results.find(r => r.id === id);

test('read-only guard: only the whitelisted inspection commands pass', () => {
  assert.ok(isReadOnlyCommand('launchctl', ['print', 'gui/501/io.claudewow.bridge']));
  assert.ok(!isReadOnlyCommand('launchctl', ['kickstart', '-k', 'gui/501/io.claudewow.bridge']));
  assert.ok(!isReadOnlyCommand('launchctl', ['bootout', 'gui/501/io.claudewow.bridge']));
  assert.ok(isReadOnlyCommand('git', ['-C', '/x', 'rev-parse', 'HEAD']));
  assert.ok(isReadOnlyCommand('git', ['-C', '/x', '--no-optional-locks', 'status', '--porcelain']));
  assert.ok(!isReadOnlyCommand('git', ['-C', '/x', 'checkout', 'main']));
  assert.ok(!isReadOnlyCommand('git', ['-C', '/x', 'stash']));
  assert.ok(!isReadOnlyCommand('git', ['-C', '/x', 'reflog', 'expire', '--all']));
  assert.ok(!isReadOnlyCommand('kill', ['-9', '1']));
  assert.ok(isReadOnlyCommand('gh', ['run', 'list']));
  assert.ok(!isReadOnlyCommand('gh', ['run', 'rerun', '1']));
});

test('plist parsing: node, script, working directory and environment', () => {
  const xml = Service.launchdPlist({ node: '/n/node', script: '/c/bridge/supervisor.js', cwd: '/c', logFile: '/l', env: { CLAUDE_WOW_HOME: '/h&x' } });
  const plist = parsePlist(xml);
  assert.equal(plist.node, '/n/node');
  assert.equal(plist.script, '/c/bridge/supervisor.js');
  assert.equal(plist.workingDirectory, '/c');
  assert.equal(plist.env.CLAUDE_WOW_HOME, '/h&x');
  assert.equal(plist.env.CLAUDE_WOW_SERVICE, '1');
});

test('a healthy world: every check ok, exit code 0', () => {
  const world = makeWorld('healthy');
  const ctx = context(world);
  const results = C.runChecks(ctx);
  for (const r of results) assert.equal(r.status, 'ok', `${r.id}: ${r.summary} ${JSON.stringify(r.problems)}`);
  const lines = [];
  assert.equal(Doctor.main([], ctx.sys, l => lines.push(l)), 0);
  assert.match(lines[0], /HEALTHY, 0 failure\(s\), 0 warning\(s\)/);
  const json = [];
  Doctor.main(['--json'], ctx.sys, l => json.push(l));
  const parsed = JSON.parse(json[0]);
  assert.equal(parsed.status, 'ok');
  assert.equal(parsed.checks.length, 13);
});

test('service: missing plist, missing node, unloaded job, dead child', () => {
  assert.equal(C.checkService(context(makeWorld('noplist', { plist: false }))).status, 'fail');
  const noNode = C.checkService(context(makeWorld('nonode', { node: false })));
  assert.equal(noNode.status, 'fail');
  assert.match(noNode.problems[0].what, /pins node/);
  const world = makeWorld('unloaded');
  const unloaded = C.checkService(context(world, { launchctl: { ok: false, out: '' } }));
  assert.equal(unloaded.status, 'fail');
  assert.match(unloaded.summary, /not loaded/);
  const deadChild = C.checkService(context(world, { ps: { 101: { ok: false, out: '' } } }));
  assert.equal(deadChild.status, 'fail');
  assert.match(deadChild.problems[0].what, /bridge child/);
  const ok = C.checkService(context(world));
  assert.match(ok.summary, /supervisor 100 up 3h 0m, bridge 101 up 3h 0m, launchd runs 3 \(2 restart\(s\)\)/);
});

test('service: bridge exits in the log in the last 24 h warn', () => {
  const world = makeWorld('exits', { logLines: [`[${iso(NOW - 60 * MINUTE)}] something`, 'bridge exited (1); restarting in 3 s'] });
  const r = C.checkService(context(world));
  assert.equal(r.status, 'warn');
  assert.match(r.summary, /child exits 24h 1/);
});

test('etime parsing', () => {
  assert.equal(C.parseEtime('05:03'), 303);
  assert.equal(C.parseEtime('01:02:03'), 3723);
  assert.equal(C.parseEtime('2-01:02:03'), 2 * 86400 + 3723);
  assert.equal(C.parseEtime('bogus'), null);
});

test('drift: a newer commit that changed no bridge file is not old code', () => {
  const world = makeWorld('drift-addon-only');
  const afterStart = Math.floor((NOW - 30 * MINUTE) / 1000);
  const r = C.checkDrift(context(world, { git: { 'log': `${afterStart}\tccccccc\taddon only` } }));
  assert.equal(r.status, 'ok');
});

test('drift: HEAD committed after the bridge started, branch switch, dirty tree, detached', () => {
  const world = makeWorld('drift');
  const afterStart = Math.floor((NOW - 30 * MINUTE) / 1000);
  const edited = path.join(world.checkout, 'bridge', 'bridge.js');
  fs.writeFileSync(edited, '');
  fs.utimesSync(edited, new Date(NOW - 30 * MINUTE), new Date(NOW - 30 * MINUTE));
  const r = C.checkDrift(context(world, { git: {
    'log': `${afterStart}\tbbbbbbb\tnew`,
    'reflog': `HEAD@{${afterStart}}\tcheckout: moving from main to feature\nHEAD@{${afterStart - 99999}}\tcommit: old`,
    'rev-parse --abbrev-ref HEAD': 'feature',
    'status': ' M bridge/bridge.js\n?? scratch.txt',
  } }));
  assert.equal(r.status, 'warn');
  assert.equal(r.problems.length, 3);
  assert.match(r.problems[0].what, /runs old code.*bridge[\\/]bridge\.js/);
  assert.match(r.problems[1].what, /main -> feature/);
  assert.match(r.problems[2].what, /2 uncommitted change\(s\).*bridge\/bridge\.js/);
  fs.rmSync(edited);
  const detached = C.checkDrift(context(world, { git: { 'rev-parse --abbrev-ref HEAD': 'HEAD' } }));
  assert.match(detached.problems[0].what, /detached/);
  assert.equal(C.checkDrift(context(world)).status, 'ok');
});

test('logs: error-like lines in 24 h counted, older ones not; last strip and done; quiet while WoW runs', () => {
  const world = makeWorld('logs', { logLines: [
    `[${iso(NOW - 2 * 24 * 60 * MINUTE)}] strip #1 unreadable`,
    `[${iso(NOW - 50 * MINUTE)}] strip #2 (screenshot a.png): 1 message(s)`,
    `[${iso(NOW - 49 * MINUTE)}] #2@abc error: agent rejected the prompt`,
    '  continuation line with cannot in it',
    `[${iso(NOW - 45 * MINUTE)}] #2@abc done (10 chars)`,
  ] });
  const quietRun = { pgrep: { ok: true, out: '123 /Applications/World of Warcraft/_classic_beta_/World of Warcraft Beta.app/Contents/MacOS/World of Warcraft\n' } };
  const r = C.checkLogs(context(world, quietRun));
  assert.equal(r.status, 'warn');
  assert.match(r.summary, /service log 2 error-like\/24h/);
  assert.match(r.summary, /last strip 50m 0s ago, last done 45m 0s ago, WoW running/);
  assert.ok(r.problems.some(p => /logged nothing for 45m/.test(p.what)));
  const summary = C.summarizeLog(fs.readFileSync(Service.serviceLogFile(world.dirs), 'utf8'), NOW);
  assert.equal(summary.trouble, 2);
  const notRunning = C.checkLogs(context(world));
  assert.ok(!notRunning.problems.some(p => /logged nothing/.test(p.what)));
});

test('signals: acks are armed files, and a missing one ahead of the next message warns', () => {
  assert.deepEqual(C.slotsAhead(199, 200, 3), [200, 1, 2]);
  assert.equal(C.parseLastSeq('x = { ["lastSeq"] = 68, }'), 68);
  const all = Array.from({ length: 200 }, (_, i) => i + 1);
  const spent = C.checkSignals(context(makeWorld('spent', { lastSeq: 190, ack: all.filter(s => s < 191 || s > 195) })));
  assert.equal(spent.status, 'warn');
  assert.match(spent.problems[0].what, /5 ack file\(s\) ahead of lastSeq 190 are missing \(191, 192, 193, 194, 195\)/);
  assert.match(spent.problems[0].why, /a slot whose file is already gone cannot signal/);
  const early = C.checkSignals(context(makeWorld('early', { lastSeq: 68 })));
  assert.equal(early.status, 'ok');
  assert.match(early.summary, /ack 200 armed \.wav, sig 1 armed \.wav, lastSeq 68 \(slot 068, 132 to wrap at 200\)/);
  const noSv = makeWorld('nosv');
  fs.rmSync(path.join(noSv.clientDir, 'WTF'), { recursive: true });
  assert.equal(C.checkSignals(context(noSv)).status, 'warn');
});

test('signals: old signal folders left in the shipped ClaudeWoW folder warn, and the runtime ones count', () => {
  const world = makeWorld('legacy-signals', { lastSeq: 68, legacySignals: ['ack/001.wav', 'presence/a/0001.wav', 'ctl/valid.wav'] });
  const r = C.checkSignals(context(world));
  assert.equal(r.status, 'warn');
  assert.match(r.summary, /ack 200 armed \.wav/);
  assert.match(r.problems[0].what, /Old signal folder\(s\) sit in the shipped ClaudeWoW folder: (ack|ctl|presence), (ack|ctl|presence), (ack|ctl|presence)\./);
  assert.match(r.problems[0].fix, /npm run slots/);
});

test('presence: files created after the running game started warn, with the old flat files and a failed in-game self-test', () => {
  const world = makeWorld('presence-late', {
    presenceFiles: ['presence/a/0002.wav', 'presence/1981.wav'],
    state: { presence: { ring: 'a', at: 0 }, presenceTest: { result: 'failed', late: 'unseen' } },
  });
  const before = new Date(NOW - 120 * MINUTE);
  for (const rel of ['a/0001.wav', 'a/0002.wav']) fs.utimesSync(path.join(world.addonDir, 'ClaudeWoW_Runtime', 'presence', ...rel.split('/')), before, before);
  const after = new Date(NOW - 10 * MINUTE);
  fs.utimesSync(path.join(world.addonDir, 'ClaudeWoW_Runtime', 'presence', '1981.wav'), after, after);
  for (const slot of [1, 2]) fs.utimesSync(path.join(world.addonDir, 'ClaudeWoW_Runtime', 'ack', String(slot).padStart(3, '0') + '.wav'), before, before);
  const running = {
    pgrep: { ok: true, out: '123 /Applications/World of Warcraft/_classic_era_/World of Warcraft Classic.app/Contents/MacOS/World of Warcraft Classic\n' },
    ps: { 123: { ok: true, out: '  01:00:00 /Applications/World of Warcraft/x.app/Contents/MacOS/World of Warcraft\n' } },
  };
  const all = Array.from({ length: 200 }, (_, i) => i + 1);
  for (const slot of all.slice(2)) fs.utimesSync(path.join(world.addonDir, 'ClaudeWoW_Runtime', 'ack', String(slot).padStart(3, '0') + '.wav'), before, before);
  fs.utimesSync(path.join(world.addonDir, 'ClaudeWoW_Runtime', 'sig', '002.wav'), before, before);
  const r = C.checkPresence(context(world, running));
  assert.equal(r.status, 'warn');
  assert.match(r.summary, /bridge on ring a at 0, WoW started 2026-09-29 17:40:00Z, 1 created after it/);
  assert.match(r.summary, /game self-test failed, late-created file unseen/);
  assert.match(r.problems[0].what, /1 signal file\(s\) were created after WoW started at 2026-09-29 17:40:00Z, newest presence\/1981\.wav/);
  assert.match(r.problems[0].fix, /Quit WoW fully and start it again/);
  assert.ok(r.problems.some(p => /old create-on-beat scheme/.test(p.what)));
  assert.ok(r.problems.some(p => /pt=failed/.test(p.what)));
  const idle = C.checkPresence(context(makeWorld('presence-idle')));
  assert.equal(idle.status, 'ok');
  assert.match(idle.summary, /WoW not running/);
});

test('interface: client build from .build.info, toc and slot mismatches', () => {
  assert.equal(C.interfaceFromVersion('1.60.1.70058'), '16001');
  assert.equal(C.interfaceFromVersion('1.15.9.70003'), '11509');
  assert.equal(C.productForFlavor('_classic_beta_'), 'wow_classic_beta');
  assert.equal(C.productForFlavor('_retail_'), 'wow');
  assert.deepEqual(C.tocInterface('## Interface: 11507, 16001\n'), ['11507', '16001']);
  assert.equal(C.checkInterface(context(makeWorld('iface-ok'))).status, 'ok');
  const stale = C.checkInterface(context(makeWorld('iface-stale', { clientVersion: '1.61.0.71000' })));
  assert.equal(stale.status, 'warn');
  assert.match(stale.problems[0].what, /interface 16100/);
  const slot = C.checkInterface(context(makeWorld('iface-slot', { slotToc: '11507' })));
  assert.match(slot.problems[0].what, /slot 001 says 11507/);
  const noRuntime = C.checkInterface(context(makeWorld('iface-no-runtime', { runtimeToc: false })));
  assert.equal(noRuntime.status, 'warn');
  assert.match(noRuntime.problems[0].what, /ClaudeWoW_Runtime\.toc is missing/);
  const oldRuntime = C.checkInterface(context(makeWorld('iface-old-runtime', { runtimeToc: '11507' })));
  assert.match(oldRuntime.problems[0].what, /ClaudeWoW_Runtime\.toc says 11507/);
  const wtfWorld = makeWorld('iface-wtf');
  fs.rmSync(path.join(path.dirname(wtfWorld.clientDir), '.build.info'));
  write(path.join(wtfWorld.clientDir, 'WTF', 'Config.wtf'), 'SET lastAddonVersion "16002"\n');
  assert.match(C.checkInterface(context(wtfWorld)).summary, /client 16002 \(Config\.wtf lastAddonVersion\)/);
});

test('permissions: a 0644 file under the addon folders warns with Battle.net error 2113', { skip: process.platform === 'win32' }, () => {
  const world = makeWorld('perms');
  assert.equal(C.checkPermissions(context(world)).status, 'ok');
  const presence = path.join(world.addonDir, 'ClaudeWoW_Runtime', 'presence', 'a', '0001.wav');
  fs.chmodSync(presence, 0o644);
  const r = C.checkPermissions(context(world));
  assert.equal(r.status, 'warn');
  assert.match(r.summary, /1 not world-writable/);
  assert.match(r.problems[0].what, /1 of \d+ file\(s\) and folder\(s\).*presence[\\/]a[\\/]0001\.wav/);
  assert.match(r.problems[0].why, /Battle\.net error 2113/);
  assert.match(r.problems[0].fix, /claude-wow setup/);
  const onWindows = C.checkPermissions({ ...context(world), sys: { ...context(world).sys, platform: 'win32' } });
  assert.equal(onWindows.status, 'ok');
});

test('disk: leftover strips and a large session file warn', () => {
  const ok = C.checkDisk(context(makeWorld('disk-ok', { sessionBytes: 1000 })));
  assert.equal(ok.status, 'ok');
  assert.match(ok.summary, /chat:abc session 1000 B/);
  assert.match(ok.summary, /presence 1 file\(s\)/);
  const big = C.checkDisk(context(makeWorld('disk-big', { sessionBytes: C.LIMITS.sessionBytes + 1, leftovers: C.LIMITS.screenshotLeftovers + 1 })));
  assert.equal(big.status, 'warn');
  assert.equal(big.problems.length, 2);
  assert.equal(C.claudeProjectDir('/h', '/Users/ryan/every-io/every'), path.join('/h', '.claude', 'projects', '-Users-ryan-every-io-every'));
});

test('data: a broken state.json fails loudly; legacy files in the checkout warn', () => {
  const broken = C.checkData(context(makeWorld('data-broken', { stateText: '{"sessions": ' })));
  assert.equal(broken.status, 'fail');
  assert.match(broken.problems[0].why, /silent fallback to empty/);
  const legacy = C.checkData(context(makeWorld('data-legacy', { legacy: ['state.json', 'config.json'] })));
  assert.equal(legacy.status, 'warn');
  assert.match(legacy.problems[0].what, /config\.json, state\.json/);
});

test('cost: shows stored turns, context and the displayed cost', () => {
  const r = C.checkCost(context(makeWorld('cost')));
  assert.equal(r.status, 'ok');
  assert.match(r.summary, /chat:abc 14 turn\(s\), ctx 141\.4k of 1\.0M, displayed ~\$82\.30/);
  assert.match(r.summary, /double-counts across --resume/);
});

test('config: an editable repo and an empty model warn, a missing defaultCwd fails', () => {
  const world = makeWorld('config', { config: { agents: { claude: { model: '', permissionMode: 'acceptEdits' } } } });
  const r = C.checkConfig(context(world));
  assert.equal(r.status, 'warn');
  assert.equal(r.problems.length, 2);
  assert.match(r.problems[0].what, /Game chat can edit/);
  assert.match(r.problems[1].what, /model is empty/);
  const missing = C.checkConfig(context(makeWorld('config-missing', { config: { defaultCwd: '/nope/not/here' } })));
  assert.equal(missing.status, 'fail');
  assert.ok(C.allowsEdits({ permissionMode: 'default', allowedTools: ['Write'] }));
  assert.ok(!C.allowsEdits({ permissionMode: 'default', allowedTools: ['WebSearch'] }));
});

test('ci: HEAD without a run, a failed run, and gh failing all warn', () => {
  const world = makeWorld('ci');
  const other = C.checkCi(context(world, { gh: { ok: true, out: JSON.stringify([{ conclusion: 'success', status: 'completed', headSha: 'ccccccc' }]) } }));
  assert.equal(other.status, 'warn');
  assert.match(other.problems[0].what, /HEAD aaaaaaa has no CI run/);
  const failed = C.checkCi(context(world, { gh: { ok: true, out: JSON.stringify([{ conclusion: 'failure', status: 'completed', headSha: 'aaaaaaa1111111111111111111111111111111' }]) } }));
  assert.match(failed.problems[0].what, /ended "failure"/);
  assert.equal(C.checkCi(context(world, { gh: { ok: false, out: '', err: 'not logged in' } })).status, 'warn');
  assert.equal(C.checkCi(context(world, { gh: { ok: true, out: '[]' } })).status, 'warn');
});

test('exit codes and the text format: fail beats warn, each problem prints what, why and fix', () => {
  const results = [
    { id: 'a', title: 'A', status: 'ok', summary: 's', problems: [] },
    { id: 'b', title: 'B', status: 'warn', summary: 's', problems: [{ what: 'w', why: 'y', fix: 'f' }] },
  ];
  assert.equal(Doctor.overallStatus(results), 'warn');
  assert.equal(Doctor.overallStatus([...results, { status: 'fail' }]), 'fail');
  const text = Doctor.formatText(results, { checkout: '/c', homePaths: { dir: '/h' } });
  assert.match(text, /DEGRADED, 0 failure\(s\), 1 warning\(s\)/);
  assert.match(text, /what: w\n\s+why: {2}y\n\s+fix: {2}f/);
  const world = makeWorld('exit', { stateText: 'nope' });
  assert.equal(Doctor.main([], context(world).sys, () => {}), 2);
});

test('a crashing check reports fail instead of throwing', () => {
  const crash = () => { throw new Error('boom'); };
  const [r] = C.runChecks({}, [crash]);
  assert.equal(r.status, 'fail');
  assert.match(r.problems[0].what, /boom/);
});
