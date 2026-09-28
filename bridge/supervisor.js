#!/usr/bin/env node
'use strict';
// Keeps bridge.js running: restarts it 3 s after any exit. Ctrl+C stops both.
// This is also the `wow-ai` command (package.json "bin"): arguments and the
// current folder pass straight through to bridge.js, so `cd proj && wow-ai`
// makes proj the default folder for chats. Two subcommands are handled here:
//   wow-ai setup [...]     runs setup.js (the game-side install)
//   wow-ai service <cmd>   the bridge as a background service (service.js)
// Under the service (WOW_AI_SERVICE=1) the bridge's output goes to a rotating
// log file instead of a terminal, and a pid file lets `service status` find us.
// bridge/bridge.log, which bridge.js appends to on its own, is rotated here too.
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const svc = require('./service');

const argv = process.argv.slice(2);
if (argv[0] === 'service') {
  process.exitCode = svc.main(argv.slice(1));
} else if (argv[0] === 'setup') {
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'setup.js'), ...argv.slice(1)], { stdio: 'inherit' });
  process.exitCode = r.status === null ? 1 : r.status;
} else {
  if (argv.includes('--help') || argv.includes('-h')) console.log('wow-ai setup [...]   game-side install (setup.js)\nwow-ai service <cmd> background service (install, uninstall, start, stop, restart, status, logs)\n');
  supervise();
}

function supervise() {
  const SERVICE = process.env.WOW_AI_SERVICE === '1';
  const dirs = svc.dirs();
  const out = SERVICE ? new svc.RotatingLog(svc.serviceLogFile(dirs)) : null;
  const say = line => (out ? out.write(line + '\n') : console.log(line));
  const BRIDGE_LOG = path.join(__dirname, 'bridge.log');
  const started = Date.now();
  let child = null;
  let stopping = false;

  function start() {
    svc.rotate(BRIDGE_LOG);
    child = spawn(process.execPath, [path.join(__dirname, 'bridge.js'), ...argv], {
      stdio: SERVICE ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    if (SERVICE) {
      child.stdout.on('data', d => out.write(d));
      child.stderr.on('data', d => out.write(d));
    }
    svc.writePid(dirs, { pid: process.pid, bridgePid: child.pid, started, mode: SERVICE ? 'service' : 'terminal', repo: path.dirname(__dirname) });
    child.on('exit', (code) => {
      child = null;
      if (stopping) return;
      if (code === 2 && SERVICE) { // config problem: keep the service alive, retry slowly
        say(`\nbridge exited (${code}): run "wow-ai setup"; retrying in 60 s`);
        setTimeout(start, 60000);
        return;
      }
      if (code === 2 || code === 0) { svc.clearPid(dirs); process.exit(code); } // config problem or --help/--once: don't loop
      say(`\nbridge exited (${code}); restarting in 3 s`);
      setTimeout(start, 3000);
    });
  }

  function stop() {
    stopping = true;
    if (child) child.kill();
    svc.clearPid(dirs);
    process.exit(0);
  }

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  setInterval(() => svc.rotate(BRIDGE_LOG), 60000).unref();
  if (SERVICE) say(`[${new Date().toISOString()}] supervisor started as a service (pid ${process.pid})`);
  start();
}
