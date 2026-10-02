'use strict';
// `claude-wow service`: the bridge as a per-user background service that starts at
// login and comes back after a crash, plus the log rotation the supervisor uses
// in every mode (the bridge itself only appends to bridge/bridge.log).
//
//   claude-wow service install     write the service definition and start it
//   claude-wow service uninstall   stop it and remove the definition
//   claude-wow service start|stop|restart
//   claude-wow service status      installed? running? pid, uptime, last log lines
//   claude-wow service logs [-n N] [-f]
//
//   macOS    LaunchAgent  ~/Library/LaunchAgents/io.claudewow.bridge.plist (RunAtLoad + KeepAlive)
//   Linux    systemd      ~/.config/systemd/user/claude-wow-bridge.service (Restart=always)
//   Windows  Startup folder launcher (hidden window); the supervisor does the crash restarts
//
// Under the service the supervisor runs with CLAUDE_WOW_SERVICE=1: it captures the
// bridge's output into <logs>/bridge.log (rotated at 5 MB, 5 files kept) and
// writes <run>/supervisor.pid so `status` can find it. Everything that builds a
// file or parses a command's output is a pure function, tested in
// tests/service_test.js; the commands themselves shell out to launchctl,
// systemctl or taskkill.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const H = require('./home');
const R = require('./runtime');
const P = require('./protocol'); // which transport a config starts the bridge on

const LABEL = 'io.claudewow.bridge';      // launchd label
const UNIT = 'claude-wow-bridge';         // systemd unit name
// The service as the project's old name (wow-ai) installed it. `install` and
// `uninstall` remove it, or two bridges would start at login and fight over
// the slot files.
const OLD_LABEL = 'io.wowai.bridge';
const OLD_UNIT = 'wow-ai-bridge';
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const LOG_KEEP = 5;
const COMMANDS = ['install', 'uninstall', 'start', 'stop', 'restart', 'status', 'logs'];

// Where the service keeps its files, per platform. All per-user, none need sudo.
function dirs(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === 'darwin') {
    return {
      logs: path.join(home, 'Library', 'Logs', 'claude-wow'),
      run: path.join(home, 'Library', 'Application Support', 'claude-wow'),
      definition: path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`),
    };
  }
  if (platform === 'win32') {
    const base = path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'claude-wow');
    return {
      logs: path.join(base, 'logs'),
      run: base,
      definition: path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'),
        'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Claude WoW bridge.vbs'),
    };
  }
  const state = path.join(env.XDG_STATE_HOME || path.join(home, '.local', 'state'), 'claude-wow');
  return {
    logs: state,
    run: state,
    definition: path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'systemd', 'user', `${UNIT}.service`),
  };
}

// Where the old name's service kept its definition and pid file.
function oldDirs(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === 'darwin') {
    return { label: OLD_LABEL, definition: path.join(home, 'Library', 'LaunchAgents', `${OLD_LABEL}.plist`), run: path.join(home, 'Library', 'Application Support', 'wow-ai') };
  }
  if (platform === 'win32') {
    return {
      run: path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'wow-ai'),
      definition: path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'),
        'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'WoW AI bridge.vbs'),
    };
  }
  return { unit: OLD_UNIT, definition: path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'systemd', 'user', `${OLD_UNIT}.service`), run: path.join(env.XDG_STATE_HOME || path.join(home, '.local', 'state'), 'wow-ai') };
}

const serviceLogFile = d => path.join(d.logs, 'bridge.log');
const launchdLogFile = d => path.join(d.logs, 'launchd.log'); // the supervisor's own stdout/stderr under launchd (crashes of the supervisor itself)
const pidFile = d => path.join(d.run, 'supervisor.pid');

// ---- argument parsing -------------------------------------------------------

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = { lines: 50, follow: false };
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') return { cmd: 'help', opts };
  if (!COMMANDS.includes(cmd)) return { cmd: 'help', opts, error: `unknown service command "${cmd}"` };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '-f' || a === '--follow') opts.follow = true;
    else if (a === '-n' || a === '--lines') {
      const n = Number(rest[++i]);
      if (!Number.isInteger(n) || n < 0) return { cmd, opts, error: `-n needs a whole number, not "${rest[i]}"` };
      opts.lines = n;
    } else if (/^-n\d+$/.test(a)) opts.lines = Number(a.slice(2));
    else return { cmd, opts, error: `unknown option "${a}"` };
  }
  return { cmd, opts };
}

const HELP = `claude-wow service <command>

  install     Run the bridge in the background, now and at every login.
  uninstall   Stop it and remove the background service.
  start       Start the installed service.
  stop        Stop it (it comes back at the next login, or with start).
  restart     Stop and start.
  status      Installed? Running? Pid, uptime and the last log lines.
  logs        Show the log (-n <lines>, default 50; -f to follow).

macOS: a LaunchAgent (~/Library/LaunchAgents/${LABEL}.plist).
An install by the project's old name (${OLD_LABEL}, ${OLD_UNIT}) is removed by install and uninstall.
Linux: a systemd --user unit (${UNIT}.service).
Windows: a launcher in your Startup folder; the bridge runs without a window.
Logs rotate at 5 MB, 5 files kept. Run "claude-wow setup" before installing.`;

// ---- the service definitions (pure) -----------------------------------------

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// What the service runs: `node` and `script` from a checkout (node
// bridge/supervisor.js), the binary alone when the bridge is one (script is
// empty then; runtime.js).
const programArgs = ({ node, script }) => [node, script].filter(Boolean);

// A LaunchAgent that launchd starts at login and restarts whenever it exits.
// The user's PATH is baked in: launchd hands agents an almost empty one, and the
// bridge finds the agent CLIs (claude, codex, ...) through it.
function launchdPlist({ label = LABEL, node, script, cwd, logFile, env = {} }) {
  const envRows = Object.entries({ CLAUDE_WOW_SERVICE: '1', ...env })
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `      <key>${xmlEscape(k)}</key>\n      <string>${xmlEscape(v)}</string>`).join('\n');
  const program = programArgs({ node, script }).map(a => `      <string>${xmlEscape(a)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${xmlEscape(label)}</string>
    <key>ProgramArguments</key>
    <array>
${program}
    </array>
    <key>WorkingDirectory</key>
    <string>${xmlEscape(cwd)}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>ProcessType</key>
    <string>Interactive</string>
    <key>StandardOutPath</key>
    <string>${xmlEscape(logFile)}</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(logFile)}</string>
    <key>EnvironmentVariables</key>
    <dict>
${envRows}
    </dict>
  </dict>
</plist>
`;
}

// systemd --user: starts with the user's session, restarts on any exit.
function systemdUnit({ node, script, cwd, env = {} }) {
  const q = s => `"${String(s).replace(/(["\\])/g, '\\$1')}"`;
  const envRows = Object.entries({ CLAUDE_WOW_SERVICE: '1', ...env })
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `Environment=${q(`${k}=${v}`)}`).join('\n');
  return `[Unit]
Description=Claude WoW bridge
After=default.target

[Service]
Type=simple
ExecStart=${programArgs({ node, script }).map(q).join(' ')}
WorkingDirectory=${cwd}
Restart=always
RestartSec=5
${envRows}

[Install]
WantedBy=default.target
`;
}

// Windows Startup folder: a VBScript that starts the supervisor with no console
// window. Explorer runs everything in Startup at login; the supervisor handles
// the crash restarts itself, so nothing else watches it.
function startupVbs({ node, script, cwd }) {
  const q = s => `"${String(s).replace(/"/g, '""')}"`;
  return `' Claude WoW bridge: started at login, no window. Written by "claude-wow service install"; remove with "claude-wow service uninstall".\r
Set sh = CreateObject("WScript.Shell")\r
sh.Environment("Process")("CLAUDE_WOW_SERVICE") = "1"\r
sh.CurrentDirectory = ${q(cwd)}\r
sh.Run ${q(programArgs({ node, script }).map(a => `"${a}"`).join(' '))}, 0, False\r
`;
}

// ---- log rotation (pure fs) -------------------------------------------------

// Rename file -> file.1 -> file.2 ... once it reaches maxBytes. Safe for the
// bridge's own log because bridge.js reopens it for every line (appendFileSync),
// so the next line lands in a fresh file. Returns true when it rotated.
function rotate(file, { maxBytes = LOG_MAX_BYTES, keep = LOG_KEEP } = {}) {
  let size;
  try { size = fs.statSync(file).size; } catch { return false; }
  if (size < maxBytes) return false;
  for (let i = keep - 1; i >= 1; i--) {
    try { fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`); } catch {}
  }
  try { fs.renameSync(file, `${file}.1`); } catch { return false; }
  return true;
}

// The supervisor's log writer under the service: appends, rotates itself.
class RotatingLog {
  constructor(file, opts = {}) {
    this.file = file;
    this.opts = opts;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try { this.size = fs.statSync(file).size; } catch { this.size = 0; }
  }
  write(chunk) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    try { fs.appendFileSync(this.file, buf); } catch { return; }
    this.size += buf.length;
    if (this.size >= (this.opts.maxBytes || LOG_MAX_BYTES) && rotate(this.file, this.opts)) this.size = 0;
  }
}

// ---- pid file and process checks --------------------------------------------

function writePid(d, info) {
  try {
    fs.mkdirSync(d.run, { recursive: true });
    fs.writeFileSync(pidFile(d), JSON.stringify({ ...info, written: Date.now() }));
  } catch {}
}

function readPid(d) {
  try { return JSON.parse(fs.readFileSync(pidFile(d), 'utf8')); } catch { return null; }
}

function clearPid(d, pid = process.pid) {
  const cur = readPid(d);
  if (cur && cur.pid !== pid) return; // another supervisor's file
  try { fs.unlinkSync(pidFile(d)); } catch {}
}

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// `launchctl print gui/<uid>/<label>` -> the pid and state lines.
function parseLaunchctlPrint(text) {
  const out = { pid: 0, state: '' };
  const pid = /^\s*pid = (\d+)/m.exec(text || '');
  const state = /^\s*state = (\S+)/m.exec(text || '');
  if (pid) out.pid = Number(pid[1]);
  if (state) out.state = state[1];
  return out;
}

function formatUptime(ms) {
  if (!(ms >= 0)) return '?';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h ${m}m`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function lastLines(file, n) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return n === 0 ? [] : lines.slice(-n);
}

// ---- the commands -----------------------------------------------------------

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts });
  return { ok: !r.error && r.status === 0, status: r.status, out: (r.stdout || '') + (r.stderr || ''), error: r.error };
}

function agentEnv() {
  // What the bridge needs from the login environment and would not get from launchd/systemd.
  const env = { PATH: process.env.PATH || '' };
  if (process.execPath && !env.PATH.split(path.delimiter).includes(path.dirname(process.execPath))) {
    env.PATH = path.dirname(process.execPath) + path.delimiter + env.PATH;
  }
  for (const k of ['HOME', 'DISPLAY', 'LANG', 'CLAUDE_WOW_HOME', 'CLAUDE_WOW_PROJECT', 'WOW_AI_PROJECT', 'CODEX_BIN', 'GROK_HOME']) if (process.env[k]) env[k] = process.env[k];
  return env;
}

// The command the service runs and the folder it runs in. From a checkout:
// this node, bridge/supervisor.js, the repo (so bridge.js falls back to
// defaultCwd rather than taking the repo as the project). From the binary:
// the binary alone, in the home folder, which bridge.js treats the same way.
function program(r = R.DEFAULT) {
  const [node, args] = R.scriptCommand('supervisor', [], r);
  return { node, script: args[0] || '', cwd: r.compiled ? H.resolve().dir : r.root };
}

function definition(platform, d, r = R.DEFAULT) {
  const base = { ...program(r), env: agentEnv() };
  if (platform === 'darwin') return launchdPlist({ ...base, logFile: launchdLogFile(d) });
  if (platform === 'win32') return startupVbs(base);
  return systemdUnit(base);
}

function preflight(d) {
  const problems = [];
  const home = H.resolve();
  if (!fs.existsSync(home.config)) {
    problems.push(`${home.config} is missing: run "claude-wow setup" (node setup.js) first, or the service would just restart in a loop.`);
  }
  const p = readPid(d);
  if (p && p.mode === 'terminal' && alive(p.pid)) {
    problems.push(`a bridge is already running in a terminal (pid ${p.pid}). Stop it with Ctrl+C first; two bridges fight over the slot files.`);
  }
  return problems;
}

// macOS ---------------------------------------------------------------------
const mac = {
  target: () => `gui/${process.getuid()}/${LABEL}`,
  loaded() { return run('launchctl', ['print', this.target()]).ok; },
  bootstrap(d) {
    let r = run('launchctl', ['bootstrap', `gui/${process.getuid()}`, d.definition]);
    if (!r.ok) r = run('launchctl', ['load', '-w', d.definition]); // pre-10.11 spelling
    return r;
  },
  bootout() {
    let r = run('launchctl', ['bootout', this.target()]);
    if (!r.ok && /not find|No such process|3: /.test(r.out)) r.ok = true; // was not loaded
    return r;
  },
  // The agent the old name installed: unload it and drop its plist. Best effort;
  // a plist that is not loaded, or an old launchctl, must not stop the install.
  removeOld(old = oldDirs('darwin')) {
    if (!fs.existsSync(old.definition)) return false;
    let r = run('launchctl', ['bootout', `gui/${process.getuid()}/${old.label}`]);
    if (!r.ok) r = run('launchctl', ['unload', '-w', old.definition]);
    try { fs.unlinkSync(old.definition); } catch {}
    return true;
  },
  install(d) {
    fs.mkdirSync(path.dirname(d.definition), { recursive: true });
    fs.mkdirSync(d.logs, { recursive: true });
    fs.mkdirSync(d.run, { recursive: true });
    rotate(launchdLogFile(d), { maxBytes: 1024 * 1024, keep: 1 });
    this.removeOld();
    fs.writeFileSync(d.definition, definition('darwin', d));
    if (this.loaded()) this.bootout();
    const r = this.bootstrap(d);
    if (!r.ok) throw new Error(`launchctl could not load ${d.definition}: ${r.out.trim() || r.error}`);
  },
  uninstall(d) {
    const old = this.removeOld();
    if (fs.existsSync(d.definition)) {
      const r = this.bootout();
      if (!r.ok) throw new Error(`launchctl could not unload the service: ${r.out.trim()}`);
      fs.unlinkSync(d.definition);
      return true;
    }
    return old;
  },
  start(d) {
    if (!fs.existsSync(d.definition)) throw new Error('the service is not installed. Run: claude-wow service install');
    const r = this.loaded() ? run('launchctl', ['kickstart', this.target()]) : this.bootstrap(d);
    if (!r.ok) throw new Error(`launchctl could not start the service: ${r.out.trim()}`);
  },
  stop() {
    const r = this.bootout();
    if (!r.ok) throw new Error(`launchctl could not stop the service: ${r.out.trim()}`);
  },
  restart(d) {
    if (!this.loaded()) return this.start(d);
    const r = run('launchctl', ['kickstart', '-k', this.target()]);
    if (!r.ok) throw new Error(`launchctl could not restart the service: ${r.out.trim()}`);
  },
  probe() {
    const r = run('launchctl', ['print', this.target()]);
    return r.ok ? { loaded: true, ...parseLaunchctlPrint(r.out) } : { loaded: false, pid: 0, state: '' };
  },
  kind: 'macOS LaunchAgent ' + LABEL,
};

// Linux ---------------------------------------------------------------------
const linux = {
  sys(args) {
    const r = run('systemctl', ['--user', ...args]);
    if (r.error && r.error.code === 'ENOENT') throw new Error('systemctl was not found. Without systemd, start the bridge from your session startup with: ' + programArgs(program()).join(' '));
    return r;
  },
  removeOld(old = oldDirs('linux')) {
    if (!fs.existsSync(old.definition)) return false;
    try { this.sys(['disable', '--now', old.unit]); } catch {}
    try { fs.unlinkSync(old.definition); } catch {}
    try { this.sys(['daemon-reload']); } catch {}
    return true;
  },
  install(d) {
    fs.mkdirSync(path.dirname(d.definition), { recursive: true });
    fs.mkdirSync(d.logs, { recursive: true });
    this.removeOld();
    fs.writeFileSync(d.definition, definition('linux', d));
    this.sys(['daemon-reload']);
    const r = this.sys(['enable', '--now', UNIT]);
    if (!r.ok) throw new Error(`systemctl could not enable ${UNIT}: ${r.out.trim()}`);
  },
  uninstall(d) {
    const old = this.removeOld();
    if (!fs.existsSync(d.definition)) return old;
    this.sys(['disable', '--now', UNIT]);
    fs.unlinkSync(d.definition);
    this.sys(['daemon-reload']);
    return true;
  },
  start(d) {
    if (!fs.existsSync(d.definition)) throw new Error('the service is not installed. Run: claude-wow service install');
    const r = this.sys(['start', UNIT]);
    if (!r.ok) throw new Error(`systemctl could not start ${UNIT}: ${r.out.trim()}`);
  },
  stop() { const r = this.sys(['stop', UNIT]); if (!r.ok) throw new Error(`systemctl could not stop ${UNIT}: ${r.out.trim()}`); },
  restart() { const r = this.sys(['restart', UNIT]); if (!r.ok) throw new Error(`systemctl could not restart ${UNIT}: ${r.out.trim()}`); },
  probe() {
    try {
      const active = this.sys(['is-active', UNIT]).out.trim();
      const pid = Number((this.sys(['show', '-p', 'MainPID', '--value', UNIT]).out || '').trim()) || 0;
      return { loaded: active !== 'inactive' || this.sys(['is-enabled', UNIT]).ok, pid, state: active };
    } catch { return { loaded: false, pid: 0, state: '' }; }
  },
  kind: 'systemd --user unit ' + UNIT,
};

// Windows -------------------------------------------------------------------
const win = {
  // The old name's launcher in the Startup folder, and the bridge it started if
  // its pid file says one is still running.
  removeOld(old = oldDirs('win32')) {
    const had = fs.existsSync(old.definition);
    if (had) try { fs.unlinkSync(old.definition); } catch {}
    const p = readPid(old);
    if (p && p.mode === 'service' && alive(p.pid)) {
      run('taskkill', ['/PID', String(p.pid), '/T', '/F']);
      try { fs.unlinkSync(pidFile(old)); } catch {}
    }
    return had;
  },
  install(d) {
    fs.mkdirSync(path.dirname(d.definition), { recursive: true });
    fs.mkdirSync(d.logs, { recursive: true });
    fs.mkdirSync(d.run, { recursive: true });
    this.removeOld();
    fs.writeFileSync(d.definition, definition('win32', d));
    this.start(d);
  },
  uninstall(d) {
    const old = this.removeOld();
    const had = fs.existsSync(d.definition);
    this.stop(d);
    if (had) fs.unlinkSync(d.definition);
    return had || old;
  },
  start(d) {
    const p = readPid(d);
    if (p && p.mode === 'service' && alive(p.pid)) return; // already running
    const { node, script, cwd } = program();
    const child = spawn(node, programArgs({ node, script }).slice(1), {
      cwd, detached: true, stdio: 'ignore', windowsHide: true,
      env: { ...process.env, CLAUDE_WOW_SERVICE: '1' },
    });
    child.unref();
  },
  stop(d) {
    const p = readPid(d);
    if (!p || p.mode !== 'service' || !alive(p.pid)) return;
    run('taskkill', ['/PID', String(p.pid), '/T', '/F']);
    try { fs.unlinkSync(pidFile(d)); } catch {}
  },
  restart(d) { this.stop(d); this.start(d); },
  probe(d) {
    const p = readPid(d);
    const running = !!(p && p.mode === 'service' && alive(p.pid));
    return { loaded: running, pid: running ? p.pid : 0, state: running ? 'running' : 'stopped' };
  },
  kind: 'Startup-folder launcher',
};

function backend(platform = process.platform) {
  return platform === 'darwin' ? mac : platform === 'win32' ? win : linux;
}

function readState(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function status(d, platform = process.platform, out = console.log, stateFile = H.resolve().state) {
  const b = backend(platform);
  const installed = fs.existsSync(d.definition);
  const probe = installed ? b.probe(d) : { loaded: false, pid: 0, state: '' };
  const p = readPid(d);
  const supervisorAlive = !!(p && alive(p.pid));
  const bridgeAlive = !!(p && alive(p.bridgePid));
  out(`claude-wow service (${b.kind})`);
  out(`  installed : ${installed ? 'yes  ' + d.definition : 'no   (claude-wow service install)'}`);
  if (installed && platform !== 'win32') out(`  loaded    : ${probe.loaded ? 'yes' : 'no   (claude-wow service start)'}${probe.state ? '  [' + probe.state + ']' : ''}`);
  if (supervisorAlive) {
    const where = p.mode === 'service' ? 'as the service' : 'in a terminal';
    out(`  running   : yes, ${where}: supervisor pid ${p.pid}${bridgeAlive ? ', bridge pid ' + p.bridgePid : ', bridge restarting'}, up ${formatUptime(Date.now() - p.started)} (since ${new Date(p.started).toLocaleString()})`);
  } else if (probe.pid && alive(probe.pid)) {
    out(`  running   : yes, pid ${probe.pid} (no pid file yet)`);
  } else {
    out('  running   : no');
  }
  out(`  versions  : ${P.versionsSummary(readState(stateFile))}; ${P.installedSummary()}`);
  const log = fs.existsSync(serviceLogFile(d)) ? serviceLogFile(d) : H.resolve().log;
  out(`  log       : ${log}  (rotates at 5 MB, 5 kept)`);
  const tail = lastLines(log, 5);
  if (tail.length) {
    out('  last lines:');
    for (const l of tail) out('    ' + l);
  }
  return supervisorAlive || (probe.pid && alive(probe.pid)) ? 0 : 3;
}

function follow(file, out) {
  let pos = 0;
  try { pos = fs.statSync(file).size; } catch {}
  const tick = () => {
    let st;
    try { st = fs.statSync(file); } catch { return; }
    if (st.size < pos) pos = 0; // rotated
    if (st.size > pos) {
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(st.size - pos);
      fs.readSync(fd, buf, 0, buf.length, pos);
      fs.closeSync(fd);
      pos = st.size;
      out(buf.toString('utf8').replace(/\n$/, ''));
    }
  };
  setInterval(tick, 500);
}

function logs(d, opts, out = console.log) {
  const file = fs.existsSync(serviceLogFile(d)) ? serviceLogFile(d) : H.resolve().log;
  if (!fs.existsSync(file)) { out(`no log yet (${file})`); return opts.follow ? 0 : 1; }
  for (const l of lastLines(file, opts.lines)) out(l);
  if (opts.follow) follow(file, out);
  return 0;
}

function main(argv, { platform = process.platform, out = console.log, err = console.error } = {}) {
  const { cmd, opts, error } = parseArgs(argv);
  if (error) { err(`claude-wow service: ${error}\n`); out(HELP); return 2; }
  if (cmd === 'help') { out(HELP); return 0; }
  const d = dirs(platform);
  const b = backend(platform);
  try {
    switch (cmd) {
      case 'install': {
        const problems = preflight(d);
        if (problems.length) { for (const p of problems) err(`claude-wow service: ${p}`); return 1; }
        b.install(d);
        out(`installed ${d.definition}`);
        out(`the bridge now runs in the background and starts at every login; log: ${serviceLogFile(d)}`);
        if (platform === 'darwin') {
          let mode = P.DEFAULT_TRANSPORT;
          const config = H.resolve().config;
          try { mode = P.chooseTransport(JSON.parse(fs.readFileSync(config, 'utf8')).capture).transport; } catch {}
          if (mode !== 'screenshot') out(`note: capture.mode is "pixel" (deprecated). A background process cannot ask for Screen Recording; remove capture.mode from ${config} or set it to "screenshot" (no permissions needed), or run the bridge from a terminal instead.`);
        }
        out('re-run "claude-wow service install" after installing a new agent CLI or a new Node, so the service sees the new PATH.');
        out('');
        return status(d, platform, out);
      }
      case 'uninstall': {
        const had = b.uninstall(d);
        out(had ? `removed ${d.definition}; the bridge no longer starts at login` : 'the service was not installed');
        return 0;
      }
      case 'start': b.start(d); out('started'); return status(d, platform, out);
      case 'stop': b.stop(d); out('stopped (it starts again at the next login; "claude-wow service uninstall" to remove it)'); return 0;
      case 'restart': b.restart(d); out('restarted'); return status(d, platform, out);
      case 'status': return status(d, platform, out);
      case 'logs': return logs(d, opts, out);
      default: out(HELP); return 2;
    }
  } catch (e) {
    err(`claude-wow service ${cmd}: ${e.message}`);
    return 1;
  }
}

module.exports = {
  LABEL, UNIT, OLD_LABEL, OLD_UNIT, COMMANDS, LOG_MAX_BYTES, LOG_KEEP, HELP,
  dirs, oldDirs, backend, serviceLogFile, launchdLogFile, pidFile,
  parseArgs, launchdPlist, systemdUnit, startupVbs, xmlEscape, program, definition,
  rotate, RotatingLog, writePid, readPid, clearPid, alive,
  parseLaunchctlPrint, formatUptime, lastLines, agentEnv,
  status, main,
};
