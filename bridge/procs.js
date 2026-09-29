'use strict';
// The child processes the bridge owns: an agent run per chat, and the capture
// script on the pixel transport. How they are started and how they are ended.
//
// On POSIX each child is spawned as the leader of its own process group
// (`detached: true`, which is setsid(2) and nothing else: the stdio pipes are
// wired exactly as asked, and the parent still waits for the child because
// nothing here calls unref()). That is what makes "kill this run" mean the
// whole tree: an agent that shelled out (a long `npm test`, a build) and the
// python capture script die with it, instead of surviving as orphans when a
// run times out or the bridge is stopped. Without a group of its own, a bare
// child.kill() reached the one process the bridge started and nothing under it.
//
// killTree ends a child's group with SIGTERM and, if it is still there after a
// grace period, SIGKILL. A child that ignores SIGTERM used to hold its stdout
// pipe open, so 'close' never fired, the chat stayed in `running`, and one of
// maxParallel was gone until a restart; now it is dead within the grace period.
// Windows has no process groups; `taskkill /T /F` kills the tree and is final.
//
// The bridge's own SIGINT/SIGTERM handler (bridge.js) runs killTree on every
// child it has, so Ctrl+C and `claude-wow service stop` strand nothing either.
// Detached children are not in the terminal's foreground group any more, so
// that forwarding is not a nicety: without it Ctrl+C would not reach them at all.

const { spawn } = require('child_process');

const POSIX = process.platform !== 'win32';
const DEFAULT_GRACE_MS = 5000;

// Children whose 'close' has happened: process gone and its pipes drained. That,
// not 'exit', is when a run is over for the bridge (runJob reads the result on
// 'close'), and a grandchild holding the pipe keeps 'close' from firing after
// the child itself has exited: the case the SIGKILL below is for.
const closed = new WeakSet();

function spawnChild(file, args, opts = {}) {
  const child = spawn(file, args, POSIX ? { ...opts, detached: true } : opts);
  child.once('close', () => closed.add(child));
  return child;
}

// The process itself is still running (its 'exit' has not happened).
function alive(child) {
  return !!child && child.pid !== undefined && child.exitCode === null && child.signalCode === null;
}
// Something of it is still there: the process, or pipes its descendants hold.
function open(child) {
  return !!child && child.pid !== undefined && !closed.has(child) && (alive(child) || started(child));
}
function started(child) { return child.exitCode !== null || child.signalCode !== null; } // it did run once

// A signal to the child's process group, which outlives the child itself while
// anything it started is still going; to the child alone if it has no group of
// its own (spawned elsewhere without detached). false = nothing there to signal.
function signalGroup(child, sig) {
  if (!child || child.pid === undefined) return false;
  if (POSIX) {
    try { process.kill(-child.pid, sig); return true; } catch (e) {
      if (e.code === 'ESRCH' || !alive(child)) return false;
    }
  }
  if (!alive(child)) return false;
  try { return child.kill(sig); } catch { return false; }
}

// End the child and everything it spawned. opts.graceMs: how long SIGTERM gets
// before SIGKILL (default 5 s); opts.log: told when the escalation happens.
// Returns at once; the caller learns the end from the child's own 'close'.
function killTree(child, opts = {}) {
  if (!open(child)) return;
  const graceMs = Number.isFinite(opts.graceMs) && opts.graceMs >= 0 ? opts.graceMs : DEFAULT_GRACE_MS;
  const log = typeof opts.log === 'function' ? opts.log : null;
  if (!POSIX) {
    if (!alive(child)) return;
    try {
      const k = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      k.on('error', () => { try { child.kill(); } catch {} });
    } catch { try { child.kill(); } catch {} }
    return;
  }
  if (!signalGroup(child, 'SIGTERM')) return;
  const timer = setTimeout(() => {
    if (closed.has(child)) return;
    if (signalGroup(child, 'SIGKILL') && log) {
      log(`pid ${child.pid}${alive(child) ? '' : ' (gone, but something it started)'} ignored SIGTERM for ${graceMs} ms; SIGKILL to its process group`);
    }
  }, graceMs);
  if (timer.unref) timer.unref(); // the bridge's own shutdown keeps its own clock (killAll)
  child.once('close', () => clearTimeout(timer));
}

// End every child in `children` and call `done` once they have all closed
// (their runs' 'close' handlers have had their turn), or after graceMs plus a
// moment, whichever is first: the bridge's shutdown.
function killAll(children, opts, done) {
  const graceMs = Number.isFinite(opts.graceMs) && opts.graceMs >= 0 ? opts.graceMs : DEFAULT_GRACE_MS;
  const kids = children.filter(open);
  let left = kids.length;
  let called = false;
  const finish = () => { if (!called) { called = true; done(); } };
  if (!left) return finish();
  const timer = setTimeout(finish, graceMs + 1000);
  for (const c of kids) {
    c.once('close', () => { if (--left === 0) { clearTimeout(timer); setImmediate(finish); } }); // after the run's own 'close' handler
    killTree(c, opts);
  }
}

module.exports = { spawnChild, alive, open, signalGroup, killTree, killAll, DEFAULT_GRACE_MS, POSIX };
