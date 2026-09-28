// bridge/service.js, the `wow-ai service` command: the service definitions it
// writes (LaunchAgent plist, systemd unit, Windows Startup launcher), its
// argument parsing, the log rotation the supervisor runs, the pid file, and the
// bits that read launchctl back. Nothing here talks to launchd or systemd.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../bridge/service');

function scratch(name) {
  const dir = path.join(__dirname, 'tmp', 'service', name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test('argument parsing: the seven commands, -n and -f, and errors for anything else', () => {
  for (const c of S.COMMANDS) assert.equal(S.parseArgs([c]).cmd, c);
  assert.equal(S.parseArgs([]).cmd, 'help');
  assert.equal(S.parseArgs(['--help']).cmd, 'help');
  assert.match(S.parseArgs(['bogus']).error, /unknown service command "bogus"/);
  assert.deepEqual(S.parseArgs(['logs']).opts, { lines: 50, follow: false });
  assert.deepEqual(S.parseArgs(['logs', '-n', '10', '-f']).opts, { lines: 10, follow: true });
  assert.deepEqual(S.parseArgs(['logs', '-n200', '--follow']).opts, { lines: 200, follow: true });
  assert.match(S.parseArgs(['logs', '-n', 'ten']).error, /whole number/);
  assert.match(S.parseArgs(['status', '--verbose']).error, /unknown option "--verbose"/);
});

test('per-user folders per platform, none of them under /usr or Program Files', () => {
  const home = '/Users/p';
  const mac = S.dirs('darwin', {}, home);
  assert.equal(mac.definition, path.join(home, 'Library', 'LaunchAgents', 'io.wowai.bridge.plist'));
  assert.equal(mac.logs, path.join(home, 'Library', 'Logs', 'wow-ai'));
  const lin = S.dirs('linux', {}, '/home/p');
  assert.equal(lin.definition, path.join('/home/p', '.config', 'systemd', 'user', 'wow-ai-bridge.service'));
  assert.equal(lin.logs, path.join('/home/p', '.local', 'state', 'wow-ai'));
  const xdg = S.dirs('linux', { XDG_STATE_HOME: '/st', XDG_CONFIG_HOME: '/cf' }, '/home/p');
  assert.equal(xdg.logs, path.join('/st', 'wow-ai'));
  assert.equal(xdg.definition, path.join('/cf', 'systemd', 'user', 'wow-ai-bridge.service'));
  const win = S.dirs('win32', { LOCALAPPDATA: 'C:\\U\\p\\AppData\\Local', APPDATA: 'C:\\U\\p\\AppData\\Roaming' }, 'C:\\U\\p');
  assert.ok(win.definition.includes('Startup') && win.definition.endsWith('WoW AI bridge.vbs'));
  assert.ok(win.logs.startsWith('C:\\U\\p\\AppData\\Local'));
  assert.equal(S.pidFile(mac), path.join(mac.run, 'supervisor.pid'));
  assert.equal(S.serviceLogFile(mac), path.join(mac.logs, 'bridge.log'));
});

test('the LaunchAgent plist: label, node + supervisor, RunAtLoad, KeepAlive, logs, PATH, and XML escaping', () => {
  const plist = S.launchdPlist({
    node: '/opt/homebrew/bin/node', script: '/Users/p/wow-ai/bridge/supervisor.js', cwd: '/Users/p/wow-ai',
    logFile: '/Users/p/Library/Logs/wow-ai/launchd.log', env: { PATH: '/a/b & c:/usr/bin', EMPTY: '' },
  });
  assert.ok(plist.startsWith('<?xml version="1.0"'));
  assert.match(plist, /<key>Label<\/key>\s*<string>io\.wowai\.bridge<\/string>/);
  assert.match(plist, /<key>ProgramArguments<\/key>\s*<array>\s*<string>\/opt\/homebrew\/bin\/node<\/string>\s*<string>\/Users\/p\/wow-ai\/bridge\/supervisor\.js<\/string>\s*<\/array>/);
  assert.match(plist, /<key>WorkingDirectory<\/key>\s*<string>\/Users\/p\/wow-ai<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /<key>StandardOutPath<\/key>\s*<string>\/Users\/p\/Library\/Logs\/wow-ai\/launchd\.log<\/string>/);
  assert.match(plist, /<key>WOW_AI_SERVICE<\/key>\s*<string>1<\/string>/, 'the supervisor knows it is the service');
  assert.match(plist, /<key>PATH<\/key>\s*<string>\/a\/b &amp; c:\/usr\/bin<\/string>/, 'the ampersand is escaped');
  assert.ok(!plist.includes('EMPTY'), 'empty variables are left out');
  // Well-formed: every <key> has a value, every open tag closes.
  for (const tag of ['dict', 'array', 'plist']) {
    assert.equal((plist.match(new RegExp(`<${tag}[ >]`, 'g')) || []).length, (plist.match(new RegExp(`</${tag}>`, 'g')) || []).length, tag);
  }
  assert.equal(S.xmlEscape('<a href="x">&</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
});

test('the plist parses with plutil where it exists', { skip: process.platform !== 'darwin' }, () => {
  const { spawnSync } = require('child_process');
  const file = path.join(scratch('plutil'), 'io.wowai.bridge.plist');
  fs.writeFileSync(file, S.launchdPlist({ node: '/usr/local/bin/node', script: '/x/supervisor.js', cwd: '/x', logFile: '/x/l.log', env: { PATH: '/usr/bin' } }));
  const r = spawnSync('plutil', ['-lint', file], { encoding: 'utf8' });
  if (r.error) return; // no plutil on this box
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('the systemd unit: ExecStart with quoted paths, Restart=always, the environment, WantedBy=default.target', () => {
  const unit = S.systemdUnit({ node: '/usr/bin/node', script: '/home/p/my wow-ai/bridge/supervisor.js', cwd: '/home/p/my wow-ai', env: { PATH: '/usr/bin', DISPLAY: ':0' } });
  assert.match(unit, /^\[Unit\]/);
  assert.match(unit, /^ExecStart="\/usr\/bin\/node" "\/home\/p\/my wow-ai\/bridge\/supervisor\.js"$/m);
  assert.match(unit, /^WorkingDirectory=\/home\/p\/my wow-ai$/m);
  assert.match(unit, /^Restart=always$/m);
  assert.match(unit, /^Environment="WOW_AI_SERVICE=1"$/m);
  assert.match(unit, /^Environment="DISPLAY=:0"$/m);
  assert.match(unit, /^WantedBy=default\.target$/m);
});

test('the Windows launcher: hidden window, service flag, quotes doubled', () => {
  const vbs = S.startupVbs({ node: 'C:\\Program Files\\nodejs\\node.exe', script: 'C:\\Users\\p\\wow-ai\\bridge\\supervisor.js', cwd: 'C:\\Users\\p\\wow-ai' });
  assert.match(vbs, /sh\.Environment\("Process"\)\("WOW_AI_SERVICE"\) = "1"/);
  assert.match(vbs, /sh\.CurrentDirectory = "C:\\Users\\p\\wow-ai"/);
  assert.match(vbs, /sh\.Run """C:\\Program Files\\nodejs\\node\.exe"" ""C:\\Users\\p\\wow-ai\\bridge\\supervisor\.js""", 0, False/);
  assert.ok(vbs.split('\n').every(l => l === '' || l.endsWith('\r')), 'CRLF for Windows');
});

test('log rotation: nothing below the limit, then a shift of .1 .. .keep with the oldest dropped', () => {
  const dir = scratch('rotate');
  const file = path.join(dir, 'bridge.log');
  fs.writeFileSync(file, 'small\n');
  assert.equal(S.rotate(file, { maxBytes: 100, keep: 3 }), false);
  assert.equal(fs.readFileSync(file, 'utf8'), 'small\n');
  assert.equal(S.rotate(path.join(dir, 'missing.log')), false, 'a missing file is not an error');
  for (let gen = 1; gen <= 5; gen++) {
    fs.writeFileSync(file, `gen${gen}\n`.repeat(30));
    assert.equal(S.rotate(file, { maxBytes: 100, keep: 3 }), true);
    assert.ok(!fs.existsSync(file), 'the current log moved aside');
  }
  assert.equal(fs.readFileSync(file + '.1', 'utf8').slice(0, 4), 'gen5');
  assert.equal(fs.readFileSync(file + '.2', 'utf8').slice(0, 4), 'gen4');
  assert.equal(fs.readFileSync(file + '.3', 'utf8').slice(0, 4), 'gen3');
  assert.ok(!fs.existsSync(file + '.4'), 'keep=3 means three old files');
});

test('RotatingLog appends and rotates itself once it passes the limit', () => {
  const dir = scratch('rotlog');
  const file = path.join(dir, 'service.log');
  const log = new S.RotatingLog(file, { maxBytes: 50, keep: 2 });
  log.write('a'.repeat(20) + '\n');
  log.write('b'.repeat(20) + '\n');
  assert.equal(fs.statSync(file).size, 42);
  log.write('c'.repeat(20) + '\n'); // crosses 50 -> rotated
  assert.ok(!fs.existsSync(file));
  assert.equal(fs.statSync(file + '.1').size, 63);
  log.write(Buffer.from('after\n'));
  assert.equal(fs.readFileSync(file, 'utf8'), 'after\n');
  const again = new S.RotatingLog(file, { maxBytes: 50, keep: 2 });
  assert.equal(again.size, 6, 'a new writer picks up the existing size');
});

test('pid file: written, read back, only its owner clears it, liveness check', () => {
  const dir = scratch('pid');
  const d = { run: dir, logs: dir, definition: path.join(dir, 'x') };
  S.writePid(d, { pid: process.pid, bridgePid: 0, started: 1000, mode: 'terminal' });
  const p = S.readPid(d);
  assert.equal(p.pid, process.pid);
  assert.equal(p.mode, 'terminal');
  assert.ok(p.written > 0);
  assert.ok(S.alive(process.pid));
  assert.ok(!S.alive(0));
  assert.ok(!S.alive(2147483000), 'a pid nobody has');
  S.clearPid(d, process.pid + 1);
  assert.ok(fs.existsSync(S.pidFile(d)), 'another process may not clear it');
  S.clearPid(d, process.pid);
  assert.ok(!fs.existsSync(S.pidFile(d)));
  assert.equal(S.readPid(d), null);
});

test('launchctl print is read for the pid and state; uptime and log tails format sensibly', () => {
  const text = `gui/501/io.wowai.bridge = {
\tactive count = 1
\tpath = /Users/p/Library/LaunchAgents/io.wowai.bridge.plist
\tstate = running
\tprogram = /opt/homebrew/bin/node
\tpid = 4242
\trunning = 1
}`;
  assert.deepEqual(S.parseLaunchctlPrint(text), { pid: 4242, state: 'running' });
  assert.deepEqual(S.parseLaunchctlPrint(''), { pid: 0, state: '' });
  assert.deepEqual(S.parseLaunchctlPrint('\tstate = not running\n'), { pid: 0, state: 'not' });
  assert.equal(S.formatUptime(5000), '5s');
  assert.equal(S.formatUptime(65000), '1m 5s');
  assert.equal(S.formatUptime(3600000 * 2 + 60000 * 13), '2h 13m');
  assert.equal(S.formatUptime(86400000 * 3 + 3600000), '3d 1h 0m');
  assert.equal(S.formatUptime(NaN), '?');
  const dir = scratch('tail');
  const file = path.join(dir, 'l.log');
  fs.writeFileSync(file, 'one\ntwo\nthree\n');
  assert.deepEqual(S.lastLines(file, 2), ['two', 'three']);
  assert.deepEqual(S.lastLines(file, 10), ['one', 'two', 'three']);
  assert.deepEqual(S.lastLines(file, 0), []);
  assert.deepEqual(S.lastLines(path.join(dir, 'nope'), 3), []);
});

test('the environment baked into the service puts node on PATH and drops nothing the agents need', () => {
  const env = S.agentEnv();
  assert.ok(env.PATH.split(path.delimiter).includes(path.dirname(process.execPath)));
  if (process.env.HOME) assert.equal(env.HOME, process.env.HOME);
});

test('status on a clean machine says not installed / not running and exits 3; help and bad input exit cleanly', () => {
  const lines = [];
  const dir = scratch('status');
  const code = S.status({ run: dir, logs: dir, definition: path.join(dir, 'io.wowai.bridge.plist') }, 'darwin', l => lines.push(l));
  assert.equal(code, 3);
  assert.match(lines.join('\n'), /installed : no/);
  assert.match(lines.join('\n'), /running   : no/);
  const out = [];
  assert.equal(S.main(['help'], { out: l => out.push(l), err: () => {} }), 0);
  assert.match(out.join('\n'), /install\s+Run the bridge in the background/);
  const errs = [];
  assert.equal(S.main(['frobnicate'], { out: () => {}, err: l => errs.push(l) }), 2);
  assert.match(errs.join('\n'), /unknown service command/);
});

test('install refuses without a config.json rather than looping a broken service', { skip: fs.existsSync(path.join(__dirname, '..', 'bridge', 'config.json')) && 'config.json exists on this machine' }, () => {
  const errs = [];
  assert.equal(S.main(['install'], { out: () => {}, err: l => errs.push(l) }), 1);
  assert.match(errs.join('\n'), /config\.json is missing/);
});
