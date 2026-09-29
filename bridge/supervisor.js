#!/usr/bin/env node
'use strict';
// Keeps bridge.js running: restarts it 3 s after any exit. Ctrl+C stops both:
// the bridge ends its agent runs and the capture script on its own SIGINT/SIGTERM
// (bridge.js, procs.js), and the supervisor waits for it before it goes.
// This is also the `claude-wow` command (package.json "bin", and the compiled
// binary's entry): arguments and the current folder pass straight through to
// bridge.js, so `cd proj && claude-wow` makes proj the default folder for chats.
// Subcommands handled here:
//   claude-wow setup [...]        runs setup.js (the game-side install)
//   claude-wow service <cmd>      the bridge as a background service (service.js)
//   claude-wow bridge [...]       bridge.js alone, in this process, no restarts
//   claude-wow install-slots      install-slots.js alone (setup runs it for you)
// The last two are how the compiled binary runs its own scripts (runtime.js:
// there is no node to hand a script path to), and they work from a checkout too.
// Under the service (CLAUDE_WOW_SERVICE=1) the bridge's output goes to a rotating
// log file instead of a terminal, and a pid file lets `service status` find us.
// bridge.log in the home folder, which bridge.js appends to on its own, is rotated here too.
const { spawn, spawnSync } = require('child_process');
const R = require('./runtime');

const argv = process.argv.slice(2);
if (argv[0] === '--version' || argv[0] === '-v') {
  console.log(`claude-wow ${require('../package.json').version} (${R.describe()})`);
} else if (argv[0] === 'service') {
  process.exitCode = require('./service').main(argv.slice(1));
} else if (argv[0] === 'setup' && R.compiled) {
  // The binary has setup.js inside it: run it here rather than spawn ourselves.
  process.argv.splice(2, 1);
  require('../setup').main();
} else if (argv[0] === 'setup') {
  const r = spawnSync(...R.scriptCommand('setup', argv.slice(1)), { stdio: 'inherit' });
  process.exitCode = r.status === null ? 1 : r.status;
} else if (argv[0] === 'bridge') {
  process.argv.splice(2, 1); // bridge.js reads its flags from process.argv
  require('./bridge');
} else if (argv[0] === 'channel') {
  require('./channel').main();
} else if (argv[0] === 'install-slots') {
  process.argv.splice(2, 1);
  require('./install-slots');
} else {
  if (argv.includes('--help') || argv.includes('-h')) console.log('claude-wow setup [...]   game-side install (setup.js)\nclaude-wow service <cmd> background service (install, uninstall, start, stop, restart, status, logs)\nclaude-wow bridge [...]  the bridge alone in this process, without the restarts\nclaude-wow channel      the live-session channel server Claude Code starts (docs/LIVE-SESSION.md)\n');
  supervise();
}

function supervise() {
  const svc = require('./service');
  const SERVICE = process.env.CLAUDE_WOW_SERVICE === '1';
  const dirs = svc.dirs();
  const out = SERVICE ? new svc.RotatingLog(svc.serviceLogFile(dirs)) : null;
  const say = line => (out ? out.write(line + '\n') : console.log(line));
  const BRIDGE_LOG = require('./home').resolve().log;
  const started = Date.now();
  let child = null;
  let stopping = false;

  function start() {
    svc.rotate(BRIDGE_LOG);
    child = spawn(...R.scriptCommand('bridge', argv), {
      stdio: SERVICE ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    if (SERVICE) {
      child.stdout.on('data', d => out.write(d));
      child.stderr.on('data', d => out.write(d));
    }
    svc.writePid(dirs, { pid: process.pid, bridgePid: child.pid, started, mode: SERVICE ? 'service' : 'terminal', repo: R.compiled ? process.execPath : R.ROOT });
    child.on('exit', (code) => {
      child = null;
      if (stopping) return;
      if ((code === 2 || code === 3) && SERVICE) {
        say(`\nbridge exited (${code}): ${code === 3 ? 'another bridge holds this home folder' : 'run "claude-wow setup"'}; retrying in 60 s`);
        setTimeout(start, 60000);
        return;
      }
      if (code === 2 || code === 3 || code === 0) { svc.clearPid(dirs); process.exit(code); }
      say(`\nbridge exited (${code}); restarting in 3 s`);
      setTimeout(start, 3000);
    });
  }

  function stop() {
    if (stopping) return;
    stopping = true;
    const gone = () => { svc.clearPid(dirs); process.exit(0); };
    if (!child) return gone();
    // SIGTERM; the bridge ends its own children (SIGTERM, then SIGKILL after
    // its killGraceMs) and exits. Wait for that, within reason, then make sure.
    const hard = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 10000);
    child.once('exit', () => { clearTimeout(hard); gone(); });
    try { child.kill(); } catch { clearTimeout(hard); gone(); }
  }

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  setInterval(() => svc.rotate(BRIDGE_LOG), 60000).unref();
  if (SERVICE) say(`[${new Date().toISOString()}] supervisor started as a service (pid ${process.pid}, ${R.describe()})`);
  start();
}
