'use strict';
const path = require('path');
const Service = require('../../bridge/service');
const Screens = require('../../bridge/screenshots');
const { slotNumber, pad3 } = require('../../bridge/protocol');
const GameFs = require('../../bridge/gamefs');
const SIG = require('../../bridge/signals');

const DAY_MS = 24 * 60 * 60 * 1000;
const QUIET_LIMIT_MS = 10 * 60 * 1000;
const LOG_TAIL_BYTES = 2 * 1024 * 1024;
const WRAP_WINDOW = 50;
const LAUNCH_SLACK_MS = 2000;
const MB = 1024 * 1024;
const LIMITS = { sessionBytes: 20 * MB, homeBytes: 200 * MB, logsBytes: 50 * MB, screenshotLeftovers: 20 };
const TROUBLE_PATTERN = /error|rejected|cannot|unreadable|TRANSPORT FALLBACK|exited with code|bridge exited/i;
const LEGACY_FILES = ['config.json', 'state.json', 'transcripts.json'];
const EDITING_PERMISSION_MODES = ['acceptEdits', 'bypassPermissions'];
const EDITING_TOOLS = /^(Write|Edit|MultiEdit|NotebookEdit)\b/;

const problem = (what, why, fix) => ({ what, why, fix });

function result(id, title, status, summary, problems = []) {
  return { id, title, status, summary, problems };
}

function worst(problems, fallback = 'ok') {
  if (problems.some(p => p.level === 'fail')) return 'fail';
  if (problems.some(p => p.level === 'warn')) return 'warn';
  return fallback;
}

function finish(id, title, summary, leveledProblems) {
  const status = worst(leveledProblems);
  return result(id, title, status, summary, leveledProblems.map(({ what, why, fix }) => ({ what, why, fix })));
}

const fail = (what, why, fix) => ({ level: 'fail', ...problem(what, why, fix) });
const warn = (what, why, fix) => ({ level: 'warn', ...problem(what, why, fix) });

function parseEtime(text) {
  const match = /^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s*$/.exec(String(text || ''));
  if (!match) return null;
  const [, days, hours, minutes, seconds] = match.map(v => Number(v || 0));
  return ((days * 24 + hours) * 60 + minutes) * 60 + seconds;
}

function formatBytes(bytes) {
  if (bytes >= 1024 * MB) return (bytes / (1024 * MB)).toFixed(1) + ' GB';
  if (bytes >= MB) return (bytes / MB).toFixed(1) + ' MB';
  if (bytes >= 1024) return Math.round(bytes / 1024) + ' KB';
  return bytes + ' B';
}

const formatAgo = ms => Service.formatUptime(ms) + ' ago';
const formatClock = ms => new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');

function cached(ctx, key, compute) {
  ctx.cache = ctx.cache || {};
  if (!(key in ctx.cache)) ctx.cache[key] = compute();
  return ctx.cache[key];
}

function processInfo(ctx, pid) {
  if (!pid) return null;
  return cached(ctx, 'ps:' + pid, () => {
    const r = ctx.sys.run('ps', ['-o', 'etime=,command=', '-p', String(pid)]);
    const line = r.out.split('\n').map(s => s.trim()).find(Boolean);
    if (!r.ok || !line) return null;
    const [etime, ...command] = line.split(/\s+/);
    const seconds = parseEtime(etime);
    return { pid, seconds, startedAt: seconds === null ? null : ctx.now - seconds * 1000, command: command.join(' ') };
  });
}

function launchdJob(ctx) {
  return cached(ctx, 'launchd', () => {
    const r = ctx.sys.run('launchctl', ['print', `gui/${ctx.sys.uid}/${ctx.label}`]);
    if (!r.ok) return { loaded: false };
    const parsed = Service.parseLaunchctlPrint(r.out);
    const runs = /^\s*runs = (\d+)/m.exec(r.out);
    const lastExit = /^\s*last exit code = (.+)$/m.exec(r.out);
    return { loaded: true, ...parsed, runs: runs ? Number(runs[1]) : null, lastExit: lastExit ? lastExit[1].trim() : '' };
  });
}

function wowProcessLines(ctx) {
  return cached(ctx, 'wow', () => {
    const r = ctx.sys.run('pgrep', ['-lf', 'World of Warcraft']);
    return r.ok ? r.out.split('\n').filter(line => /\.app\/Contents\/MacOS\//.test(line)) : [];
  });
}

function wowRunning(ctx) {
  return wowProcessLines(ctx).length > 0;
}

function wowProcess(ctx) {
  const line = wowProcessLines(ctx)[0];
  const pid = line ? Number(line.trim().split(/\s+/)[0]) : null;
  if (!pid) return null;
  const info = processInfo(ctx, pid);
  return info ? { pid, startedAt: info.startedAt } : { pid, startedAt: null };
}

function gitRaw(ctx, dir, args) {
  const r = ctx.sys.run('git', ['-C', dir, ...args]);
  return r.ok ? r.out : null;
}

function git(ctx, dir, args) {
  const out = gitRaw(ctx, dir, args);
  return out === null ? null : out.trim();
}

function parseLogLines(text) {
  const entries = [];
  let lastTime = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line) continue;
    const stamp = /^\[(\d{4}-\d\d-\d\dT[\d:.]+Z)\]/.exec(line);
    if (stamp) lastTime = Date.parse(stamp[1]);
    entries.push({ time: stamp ? lastTime : null, inheritedTime: lastTime, line });
  }
  return entries;
}

function summarizeLog(text, now) {
  const entries = parseLogLines(text);
  const since = now - DAY_MS;
  const trouble = entries.filter(e => e.inheritedTime !== null && e.inheritedTime >= since && TROUBLE_PATTERN.test(e.line));
  const lastMatching = re => {
    for (let i = entries.length - 1; i >= 0; i--) if (entries[i].time !== null && re.test(entries[i].line)) return entries[i].time;
    return null;
  };
  const stamped = entries.filter(e => e.time !== null);
  return {
    lines: entries.length,
    trouble: trouble.length,
    troubleSamples: trouble.slice(-2).map(e => e.line.slice(0, 160)),
    exits: trouble.filter(e => /bridge exited|exited with code/i.test(e.line)).length,
    lastStrip: lastMatching(/\bstrip #\d+/),
    lastDone: lastMatching(/#\d+@\S+ done\b/),
    lastActivity: stamped.length ? stamped[stamped.length - 1].time : null,
  };
}

function logSummaries(ctx) {
  return cached(ctx, 'logs', () => {
    const files = [
      { name: 'service log', file: ctx.serviceLog },
      { name: 'home log', file: ctx.homePaths.log },
    ];
    return files.map(f => {
      const text = ctx.sys.tailText(f.file, LOG_TAIL_BYTES);
      return { ...f, present: text !== null, ...summarizeLog(text, ctx.now) };
    });
  });
}

function checkService(ctx) {
  const issues = [];
  if (!ctx.plist) {
    return finish('service', 'Service', `no LaunchAgent at ${ctx.plistPath}`, [
      fail('The LaunchAgent plist is missing.', 'Without it launchd does not start the bridge at login or restart it after a crash.', 'Run "claude-wow service install" from the checkout you want to serve.'),
    ]);
  }
  if (!ctx.sys.stat(ctx.plist.node)) {
    issues.push(fail(`The plist pins node at ${ctx.plist.node}, and that file is gone.`, 'An nvm upgrade or uninstall removed that Node version; launchd cannot start the bridge at the next restart or login.', 'Run "claude-wow service install" again with the Node you use now.'));
  }
  if (ctx.plist.script && !ctx.sys.stat(ctx.plist.script)) {
    issues.push(fail(`The plist runs ${ctx.plist.script}, and that file is gone.`, 'The checkout moved or was deleted; launchd restarts into a missing script in a loop.', 'Run "claude-wow service install" from the checkout you want to serve.'));
  }
  const job = launchdJob(ctx);
  if (!job.loaded) {
    issues.push(fail(`launchd has no job ${ctx.label} loaded.`, 'The plist exists but is not loaded, so nothing runs the bridge.', 'Run "claude-wow service start".'));
    return finish('service', 'Service', 'installed, not loaded', issues);
  }
  const pidInfo = ctx.pidInfo || {};
  const supervisorPid = pidInfo.pid || job.pid;
  const supervisor = processInfo(ctx, supervisorPid);
  const bridge = processInfo(ctx, pidInfo.bridgePid);
  if (!supervisor) {
    issues.push(fail(`The supervisor (pid ${supervisorPid || 'unknown'}) is not running.`, `launchd state is "${job.state || 'unknown'}", last exit code ${job.lastExit || 'unknown'}; no process relays chat.`, 'Read the log with "claude-wow service logs", then run "claude-wow service restart".'));
  }
  if (supervisor && !bridge) {
    issues.push(fail(`The bridge child (pid ${pidInfo.bridgePid || 'unknown'}) is not running.`, 'The supervisor restarts bridge.js 3 s after each exit; a missing child means it is crash-looping or the pid file is stale.', 'Read the log with "claude-wow service logs -n 100" for the exit reason.'));
  }
  if (job.pid && pidInfo.pid && job.pid !== pidInfo.pid) {
    issues.push(warn(`launchd reports pid ${job.pid}, the pid file says ${pidInfo.pid}.`, 'A second supervisor may run from a terminal, and two bridges fight over the slot files.', 'Run "ps -p ' + pidInfo.pid + ',' + job.pid + '" and stop the one that is not the service.'));
  }
  const restarts = job.runs ? job.runs - 1 : 0;
  const bridgeExits = logSummaries(ctx)[0].exits;
  if (bridgeExits > 0) {
    issues.push(warn(`The bridge child exited ${bridgeExits} time(s) in the last 24 h.`, 'Each exit drops the message in flight and restarts the agent run.', 'Read the lines before each "bridge exited" in the service log.'));
  }
  const parts = [
    `loaded [${job.state || '?'}]`,
    supervisor ? `supervisor ${supervisor.pid} up ${Service.formatUptime((supervisor.seconds || 0) * 1000)}` : 'supervisor down',
    bridge ? `bridge ${bridge.pid} up ${Service.formatUptime((bridge.seconds || 0) * 1000)}` : 'bridge down',
    `launchd runs ${job.runs === null ? '?' : job.runs} (${restarts} restart(s))`,
    `child exits 24h ${bridgeExits}`,
  ];
  return finish('service', 'Service', parts.join(', '), issues);
}

function parseReflog(text) {
  return String(text || '').split('\n').map(line => {
    const match = /^HEAD@\{(\d+)\}\t(.*)$/.exec(line.trim());
    return match ? { time: Number(match[1]) * 1000, subject: match[2] } : null;
  }).filter(Boolean);
}

function checkoutState(ctx) {
  return cached(ctx, 'checkout', () => {
    const dir = ctx.checkout;
    if (!dir || !ctx.sys.stat(path.join(dir, '.git'))) return null;
    const head = git(ctx, dir, ['rev-parse', 'HEAD']);
    const branch = git(ctx, dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const commitLine = git(ctx, dir, ['log', '-1', '--format=%ct%x09%h%x09%s', 'HEAD']) || '';
    const [commitSeconds, shortSha, subject] = commitLine.split('\t');
    const porcelain = gitRaw(ctx, dir, ['--no-optional-locks', 'status', '--porcelain']);
    const reflog = parseReflog(git(ctx, dir, ['reflog', '-n', '100', '--date=unix', '--format=%gd%x09%gs']));
    return {
      dir, head, branch, shortSha, subject,
      commitTime: commitSeconds ? Number(commitSeconds) * 1000 : null,
      dirty: porcelain === null ? [] : porcelain.split('\n').filter(Boolean),
      reflog,
    };
  });
}

const SPAWNED_FRESH = new Set(['install-slots.js']);

function loadedFilesChangedSince(ctx, dir, since) {
  const changed = [];
  const walk = (rel, depth) => {
    if (depth > 4) return;
    for (const name of ctx.sys.listDir(path.join(dir, rel)) || []) {
      const relPath = path.join(rel, name);
      const st = ctx.sys.stat(path.join(dir, relPath));
      if (!st) continue;
      if (st.isDir) walk(relPath, depth + 1);
      else if (/\.(js|cjs|mjs)$/.test(name) && !SPAWNED_FRESH.has(name) && st.mtimeMs > since) changed.push(relPath);
    }
  };
  walk('bridge', 0);
  return changed.sort();
}

function checkDrift(ctx) {
  if (!ctx.checkout) return finish('drift', 'Code drift', 'no checkout (no plist script path)', []);
  const repo = checkoutState(ctx);
  if (!repo) return finish('drift', 'Code drift', `${ctx.checkout} is not a git checkout`, []);
  const issues = [];
  const bridge = processInfo(ctx, ctx.pidInfo && ctx.pidInfo.bridgePid);
  const startedAt = bridge ? bridge.startedAt : null;
  if (startedAt !== null) {
    const movesAfterStart = repo.reflog.filter(e => e.time > startedAt);
    const changed = loadedFilesChangedSince(ctx, repo.dir, startedAt);
    if (changed.length) {
      issues.push(warn(
        `The bridge runs old code: it started ${formatClock(startedAt)}, and ${changed.length} bridge file(s) changed since: ${changed.slice(0, 4).join(', ')}${changed.length > 4 ? ', ...' : ''}.`,
        'Node loaded the files at start; edits and commits after that are not live until a restart.',
        'Run "claude-wow service restart" when no chat is mid-run.'));
    }
    const switches = movesAfterStart.filter(e => /^checkout: moving from /.test(e.subject));
    if (switches.length) {
      const first = /^checkout: moving from (\S+) to (\S+)/.exec(switches[switches.length - 1].subject);
      issues.push(warn(`The checkout switched branch since the bridge started (${first ? first[1] + ' -> ' + first[2] : switches.length + ' switch(es)'}, now ${repo.branch}).`,
        'A restart picks up whatever branch is checked out, which may not be the code you meant to serve.',
        `Check out the branch you want in ${repo.dir} before the next restart.`));
    }
  }
  if (repo.branch === 'HEAD') {
    issues.push(warn(`${repo.dir} is on a detached HEAD.`, 'A detached checkout does not follow any branch, so pulls do not update it.', `Check out a branch in ${repo.dir}.`));
  }
  if (repo.dirty.length) {
    issues.push(warn(`${repo.dirty.length} uncommitted change(s) in ${repo.dir}: ${repo.dirty.slice(0, 3).map(l => l.slice(3)).join(', ')}${repo.dirty.length > 3 ? ', ...' : ''}.`,
      'The service runs the working tree, so uncommitted edits go live at the next restart without CI.',
      'Commit or discard the changes in the live checkout.'));
  }
  const summary = `${repo.dir} on ${repo.branch} @ ${repo.shortSha}, bridge started ${startedAt === null ? 'unknown' : formatClock(startedAt)}, ${repo.dirty.length} dirty`;
  return finish('drift', 'Code drift', summary, issues);
}

function checkLogs(ctx) {
  const issues = [];
  const logs = logSummaries(ctx);
  const present = logs.filter(l => l.present);
  if (!present.length) {
    return finish('logs', 'Logs', 'no log files', [warn('Neither the service log nor the home bridge.log exists.', 'The bridge writes a line at every start; no log means it never started here.', 'Run "claude-wow service status".')]);
  }
  for (const log of present) {
    if (log.trouble > 0) {
      issues.push(warn(`${log.name}: ${log.trouble} error-like line(s) in the last 24 h, latest: ${log.troubleSamples[log.troubleSamples.length - 1]}`,
        'Lines that match error/rejected/cannot/unreadable/TRANSPORT FALLBACK/exited mean a message or a strip failed.',
        `Read the context around them: grep -n -i -E "error|rejected|cannot|unreadable|fallback|exited" "${log.file}".`));
    }
  }
  const newest = key => Math.max(...present.map(l => l[key] || 0)) || null;
  const lastActivity = newest('lastActivity');
  const lastStrip = newest('lastStrip');
  const lastDone = newest('lastDone');
  const quietFor = lastActivity === null ? null : ctx.now - lastActivity;
  const wow = wowRunning(ctx);
  if (wow && (quietFor === null || quietFor > QUIET_LIMIT_MS)) {
    issues.push(warn(`WoW is running and the bridge has logged nothing for ${quietFor === null ? 'ever' : Service.formatUptime(quietFor)}.`,
      'An idle chat logs nothing, but a message you sent that got no reply means the bridge does not see the strips.',
      'Send a short message in game; if no "strip #" line appears, run "claude-wow service restart".'));
  }
  const describe = t => (t === null ? 'never' : formatAgo(ctx.now - t));
  const counts = present.map(l => `${l.name} ${l.trouble} error-like/24h`).join(', ');
  return finish('logs', 'Logs', `${counts}; last strip ${describe(lastStrip)}, last done ${describe(lastDone)}, WoW ${wow ? 'running' : 'not running'}`, issues);
}

function parseLastSeq(text) {
  const match = /\["lastSeq"\]\s*=\s*(\d+)/.exec(String(text || ''));
  return match ? Number(match[1]) : null;
}

function wavSlots(ctx, dir) {
  const names = ctx.sys.listDir(dir);
  if (!names) return null;
  return names.map(n => /^(\d{3})\.wav$/i.exec(n)).filter(Boolean).map(m => Number(m[1]));
}

function slotsAhead(lastSlot, slots, window) {
  const ahead = [];
  for (let k = 1; k <= window; k++) ahead.push(((lastSlot - 1 + k) % slots) + 1);
  return ahead;
}

function checkSignals(ctx) {
  const addonDir = ctx.config.addonDir;
  if (!addonDir) return finish('signals', 'Signal files', 'no addonDir in config', [warn('config.json has no addonDir.', 'The bridge cannot write reply slots or signal files without it.', 'Run "claude-wow setup".')]);
  const slots = Number(ctx.config.slots) || 200;
  const ack = wavSlots(ctx, path.join(addonDir, 'ClaudeWoW', 'ack'));
  const sig = wavSlots(ctx, path.join(addonDir, 'ClaudeWoW', 'sig'));
  const lastSeq = parseLastSeq(ctx.sys.readText(ctx.config.savedVariablesFile || ''));
  const issues = [];
  const armed = `ack ${ack ? ack.length : 'missing'} armed .wav, sig ${sig ? sig.length : 'missing'} armed .wav`;
  if (lastSeq === null) {
    issues.push(warn(`Cannot read db.lastSeq from ${ctx.config.savedVariablesFile || '(no savedVariablesFile)'}.`, 'Without it the slots ahead of the next message cannot be judged.', 'Log in once and /reload so WoW writes the SavedVariables file.'));
    return finish('signals', 'Signal files', `${armed}, lastSeq unknown`, issues);
  }
  const lastSlot = slotNumber(Math.max(lastSeq, 1), slots);
  const toWrap = slots - (lastSeq % slots);
  const ackSet = new Set(ack || []);
  const spentAhead = slotsAhead(lastSlot, slots, WRAP_WINDOW).filter(s => !ackSet.has(s));
  if (spentAhead.length) {
    issues.push(warn(`${spentAhead.length} ack file(s) ahead of lastSeq ${lastSeq} are missing (${spentAhead.slice(0, 5).map(pad3).join(', ')}${spentAhead.length > 5 ? ', ...' : ''}).`,
      'An ack is a file the bridge deletes; a slot whose file is already gone cannot signal, so those messages wait for the slower slot polls.',
      'Restart the bridge on this version (it arms the next 50 slots on every message), then restart WoW so the game sees the armed files.'));
  }
  const summary = `${armed}, lastSeq ${lastSeq} (slot ${pad3(lastSlot)}, ${toWrap} to wrap at ${slots})`;
  return finish('signals', 'Signal files', summary, issues);
}

function signalFilesWithTimes(ctx, addonDir) {
  const root = path.join(addonDir, 'ClaudeWoW');
  const out = [];
  const add = rel => {
    const st = ctx.sys.stat(path.join(root, rel));
    if (st && !st.isDir) out.push({ rel, mtimeMs: st.mtimeMs });
  };
  for (const dir of ['presence/a', 'presence/b', 'presence', 'ack', 'sig']) {
    for (const name of ctx.sys.listDir(path.join(root, dir)) || []) {
      if (/\.wav$/i.test(name)) add(dir + '/' + name);
    }
  }
  return out;
}

function checkPresence(ctx) {
  const addonDir = ctx.config.addonDir;
  if (!addonDir) return finish('presence', 'Presence files', 'no addonDir in config', []);
  const issues = [];
  const files = signalFilesWithTimes(ctx, addonDir);
  const legacy = files.filter(f => /^presence\/\d{4}\.wav$/i.test(f.rel));
  const ring = SIG.presenceState(ctx.state.presence);
  const test = ctx.state.presenceTest || {};
  const wow = wowProcess(ctx);
  const oldCounter = typeof ctx.state.presence === 'number';
  const parts = [`${files.length} signal file(s)`, oldCounter ? `bridge state still has the old presence counter ${ctx.state.presence}` : `bridge on ring ${ring.ring} at ${ring.at}`];
  if (wow && wow.startedAt !== null) {
    const late = files.filter(f => f.mtimeMs > wow.startedAt + LAUNCH_SLACK_MS).sort((a, b) => b.mtimeMs - a.mtimeMs);
    parts.push(`WoW started ${formatClock(wow.startedAt)}`, `${late.length} created after it`);
    if (late.length) {
      issues.push(warn(`${late.length} signal file(s) were created after WoW started at ${formatClock(wow.startedAt)}, newest ${late[0].rel} (${formatAgo(ctx.now - late[0].mtimeMs)}).`,
        'The client only sees files that existed when it started: on 2026-09-29 presence files made after launch were never seen (beats seen 0), and the light went red 5 minutes after every reply.',
        'Quit WoW fully and start it again. The bridge arms its files ahead of time, so a fresh start sees them.'));
    }
  } else {
    parts.push(wow ? 'WoW running, start time unknown' : 'WoW not running');
  }
  if (legacy.length) {
    issues.push(warn(`${legacy.length} presence file(s) from the old create-on-beat scheme sit in presence/ (e.g. ${legacy[0].rel}).`,
      'The bridge no longer writes them and the addon no longer reads them.',
      'Restart the bridge on this version (it removes them) or run "npm run slots", then restart WoW.'));
  }
  if (test.result || test.late) parts.push(`game self-test ${test.result || 'pending'}, late-created file ${test.late || 'not checked'}`);
  if (test.result === 'failed') {
    issues.push(warn('The addon reported that a launch-time file the bridge deleted still reads as present (pt=failed).',
      'Presence beats cannot reach this client, so the addon uses the slot-poll windows (stale after 12 minutes, down after 22).',
      `Nothing breaks. Note the late-created file result (${test.late || 'not checked'}) when you report it.`));
  }
  return finish('presence', 'Presence files', parts.join(', '), issues);
}

function tocInterface(text) {
  const match = /^##\s*Interface:\s*([\d, ]+)/m.exec(String(text || ''));
  return match ? match[1].split(',').map(s => s.trim()).filter(Boolean) : null;
}

function interfaceFromVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version || ''));
  return match ? String(Number(match[1]) * 10000 + Number(match[2]) * 100 + Number(match[3])) : null;
}

function productForFlavor(flavorDir) {
  if (flavorDir === '_retail_') return 'wow';
  return 'wow' + flavorDir.replace(/_+$/, '');
}

function parseBuildInfo(text) {
  const lines = String(text || '').split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const columns = lines[0].split('|').map(h => h.split('!')[0]);
  return lines.slice(1).map(line => {
    const cells = line.split('|');
    const row = {};
    columns.forEach((name, i) => { row[name] = cells[i] || ''; });
    return row;
  });
}

function clientBuild(ctx, addonDir) {
  const clientDir = path.dirname(path.dirname(addonDir));
  const product = productForFlavor(path.basename(clientDir));
  const rows = parseBuildInfo(ctx.sys.readText(path.join(path.dirname(clientDir), '.build.info')));
  const row = rows.find(r => r.Product === product);
  if (row && row.Version) return { version: row.Version, interface: interfaceFromVersion(row.Version), source: '.build.info ' + product };
  const wtf = /^SET lastAddonVersion "?(\d+)"?/m.exec(ctx.sys.readText(path.join(clientDir, 'WTF', 'Config.wtf')) || '');
  if (wtf) return { version: '', interface: wtf[1], source: 'Config.wtf lastAddonVersion' };
  return null;
}

function checkInterface(ctx) {
  const addonDir = ctx.config.addonDir;
  if (!addonDir) return finish('interface', 'Interface version', 'no addonDir in config', []);
  const main = tocInterface(ctx.sys.readText(path.join(addonDir, 'ClaudeWoW', 'ClaudeWoW.toc')));
  const slot = tocInterface(ctx.sys.readText(path.join(addonDir, 'ClaudeWoW_S001', 'ClaudeWoW_S001.toc')));
  const client = clientBuild(ctx, addonDir);
  const issues = [];
  if (!main) issues.push(fail('ClaudeWoW.toc is missing or has no ## Interface line.', 'WoW does not load an addon without a readable toc.', 'Run "claude-wow setup" to reinstall the addon.'));
  if (!slot) issues.push(warn('ClaudeWoW_S001.toc is missing or has no ## Interface line.', 'Replies land in the slot addons; a missing slot 001 means the slots are not installed.', 'Run "npm run slots" or "claude-wow setup".'));
  if (main && slot && !slot.some(v => main.includes(v))) {
    issues.push(warn(`ClaudeWoW.toc says ${main.join(',')}, slot 001 says ${slot.join(',')}.`, 'Slots with another interface show as out of date, and WoW may refuse to load them.', 'Run "npm run slots" so the slots match tocInterface.'));
  }
  if (main && client && client.interface && !main.includes(client.interface)) {
    issues.push(warn(`The client is ${client.version || ''} (interface ${client.interface}), ClaudeWoW.toc says ${main.join(',')}.`, 'An out-of-date toc makes WoW mark the addon out of date and skip it unless "load out of date addons" is on.', `Set tocInterface to ${client.interface} in config.json and run "claude-wow setup".`));
  }
  const summary = `ClaudeWoW.toc ${main ? main.join(',') : 'missing'}, S001 ${slot ? slot.join(',') : 'missing'}, client ${client ? `${client.interface} (${client.version || client.source})` : 'unknown'}`;
  return finish('interface', 'Interface version', summary, issues);
}

function lockedGameFiles(ctx, addonDir) {
  const locked = [];
  let checked = 0;
  const folders = (ctx.sys.listDir(addonDir) || []).filter(n => GameFs.ADDON_FOLDER.test(n)).map(n => path.join(addonDir, n));
  const pending = [...folders];
  while (pending.length) {
    const current = pending.pop();
    const st = ctx.sys.stat(current);
    if (!st) continue;
    checked++;
    if ((st.mode & GameFs.WORLD_WRITABLE) === 0) locked.push(current);
    if (st.isDir) for (const name of ctx.sys.listDir(current) || []) pending.push(path.join(current, name));
  }
  return { folders: folders.length, checked, locked: locked.sort() };
}

function checkPermissions(ctx) {
  const addonDir = ctx.config.addonDir;
  if (!addonDir) return finish('permissions', 'Game file permissions', 'no addonDir in config', []);
  if (!GameFs.matchesGame(ctx.sys.platform)) return finish('permissions', 'Game file permissions', `not checked on ${ctx.sys.platform}`, []);
  const { folders, checked, locked } = lockedGameFiles(ctx, addonDir);
  const issues = [];
  if (locked.length) {
    const rel = locked.slice(0, 3).map(f => path.relative(addonDir, f));
    issues.push(warn(`${locked.length} of ${checked} file(s) and folder(s) under the ClaudeWoW addon folders are not world-writable: ${rel.join(', ')}${locked.length > 3 ? ', ...' : ''}.`,
      'Blizzard installs every game file as 0777; Battle.net error 2113 (permissions check failure) blocks updates and marks the game not playable when one is not.',
      'Run "claude-wow setup" (or "npm run slots"), which sets them to 0777, and restart the bridge on this version so new files are written 0777.'));
  }
  return finish('permissions', 'Game file permissions', `${checked} entr${checked === 1 ? 'y' : 'ies'} in ${folders} addon folder(s), ${locked.length} not world-writable`, issues);
}

function claudeProjectDir(home, cwd) {
  return path.join(home, '.claude', 'projects', String(cwd).replace(/[^A-Za-z0-9]/g, '-'));
}

function sessionFiles(ctx) {
  const sessions = ctx.state.sessions || {};
  const cwds = ctx.state.sessionCwd || {};
  const agents = ctx.state.sessionAgent || {};
  return Object.entries(sessions).filter(([chat]) => (agents[chat] || 'claude') === 'claude').map(([chat, sessionId]) => {
    const cwd = cwds[chat] || ctx.config.defaultCwd || '';
    const file = path.join(claudeProjectDir(ctx.sys.home, cwd), sessionId + '.jsonl');
    const st = ctx.sys.stat(file);
    return { chat, sessionId, file, bytes: st ? st.size : null };
  });
}

function checkDisk(ctx) {
  const issues = [];
  const home = ctx.sys.treeSize(ctx.homePaths.dir);
  const logs = ctx.sys.treeSize(ctx.serviceDirs.logs);
  const parts = [`home ${formatBytes(home.bytes)}`, `logs ${formatBytes(logs.bytes)}`];
  if (home.bytes > LIMITS.homeBytes) issues.push(warn(`${ctx.homePaths.dir} is ${formatBytes(home.bytes)}.`, 'tmp/ vision PNGs and transcripts grow without bound.', `Clear ${ctx.homePaths.tmp} while the bridge is idle.`));
  if (logs.bytes > LIMITS.logsBytes) issues.push(warn(`${ctx.serviceDirs.logs} is ${formatBytes(logs.bytes)}.`, 'Rotation keeps 5 x 5 MB; more means a log outside the rotation grows.', `Look for large files in ${ctx.serviceDirs.logs}.`));
  if (ctx.config.addonDir) {
    const shotsDir = Screens.screenshotDir(ctx.config);
    const names = ctx.sys.listDir(shotsDir) || [];
    const strips = names.filter(Screens.isScreenshotFile);
    parts.push(`screenshots ${strips.length} strip-sized leftover(s) of ${names.length}`);
    if (strips.length > LIMITS.screenshotLeftovers) issues.push(warn(`${strips.length} WoWScrnShot files sit in ${shotsDir}.`, 'The bridge deletes strips after it decodes them; leftovers are strips it could not read.', `Check the log for "unreadable", then delete the old WoWScrnShot files in ${shotsDir}.`));
    const presenceDir = path.join(ctx.config.addonDir, 'ClaudeWoW', 'presence');
    const presence = ctx.sys.listDir(presenceDir);
    const wavs = dir => (ctx.sys.listDir(dir) || []).filter(n => /\.wav$/i.test(n)).length;
    parts.push(`presence ${presence ? wavs(presenceDir) + SIG.RINGS.reduce((n, r) => n + wavs(path.join(presenceDir, r)), 0) : 'missing'} file(s)`);
  }
  for (const s of sessionFiles(ctx)) {
    parts.push(`${s.chat} session ${s.bytes === null ? 'not found' : formatBytes(s.bytes)}`);
    if (s.bytes !== null && s.bytes > LIMITS.sessionBytes) {
      issues.push(warn(`The agent session for ${s.chat} is ${formatBytes(s.bytes)} (${s.file}).`, 'Every --resume reloads the whole session, so turns get slower and cost more.', `Start a new chat in game for ${s.chat} with /claude.`));
    }
  }
  return finish('disk', 'Disk', parts.join(', '), issues);
}

function checkData(ctx) {
  const issues = [];
  const describe = (name, parsed) => (!parsed.present ? `${name} absent` : parsed.error ? `${name} BROKEN` : `${name} ok`);
  for (const [name, parsed, file] of [['state.json', ctx.stateJson, ctx.homePaths.state], ['transcripts.json', ctx.transcriptsJson, ctx.homePaths.transcripts]]) {
    if (parsed.present && parsed.error) {
      issues.push(fail(`${file} does not parse: ${parsed.error}.`, 'The bridge reads it with a silent fallback to empty and overwrites it on the next write, so every chat session and transcript is lost.', `Copy ${file} aside now and repair the JSON before you send another message.`));
    }
  }
  if (ctx.configJson.present && ctx.configJson.error) {
    issues.push(fail(`${ctx.homePaths.config} does not parse: ${ctx.configJson.error}.`, 'The bridge cannot start without its config.', 'Repair the JSON, or run "claude-wow setup".'));
  }
  const legacyDir = ctx.checkout ? path.join(ctx.checkout, 'bridge') : '';
  const legacy = legacyDir ? LEGACY_FILES.filter(f => ctx.sys.stat(path.join(legacyDir, f))) : [];
  if (legacy.length && ctx.homePaths.source !== 'legacy') {
    issues.push(warn(`Legacy ${legacy.join(', ')} still sit in ${legacyDir}.`, 'home.js falls back to that stale copy if ~/.claude-wow/config.json goes missing, and old sessions come back.', `Move them out of ${legacyDir} once ${ctx.homePaths.dir} is confirmed good.`));
  }
  const summary = `${describe('state.json', ctx.stateJson)}, ${describe('transcripts.json', ctx.transcriptsJson)}, home ${ctx.homePaths.dir} (${ctx.homePaths.source}), ${legacy.length} legacy file(s)`;
  return finish('data', 'Data files', summary, issues);
}

function checkCost(ctx) {
  const usage = ctx.state.sessionUsage || {};
  const rows = Object.entries(usage).map(([chat, u]) => {
    const ctxText = u.context ? `ctx ${(u.context / 1000).toFixed(1)}k${u.window ? ' of ' + (u.window / 1e6).toFixed(1) + 'M' : ''}` : 'ctx ?';
    const cost = typeof u.cost === 'number' ? `displayed ~$${u.cost.toFixed(2)}` : 'no cost';
    return `${chat} ${u.turns || 0} turn(s), ${ctxText}, ${cost}`;
  });
  const summary = rows.length ? rows.join('; ') + ' (displayed cost double-counts across --resume)' : 'no usage recorded';
  return finish('cost', 'Cost', summary, []);
}

function allowsEdits(agentConfig) {
  if (EDITING_PERMISSION_MODES.includes(agentConfig.permissionMode)) return true;
  return (agentConfig.allowedTools || []).some(t => EDITING_TOOLS.test(t));
}

function checkConfig(ctx) {
  const issues = [];
  const cwd = ctx.config.defaultCwd;
  const agentName = ctx.config.agent || 'claude';
  const agentConfig = (ctx.config.agents || {})[agentName] || {};
  let repoTop = null;
  if (!cwd) {
    issues.push(fail('config.json has no defaultCwd.', 'Chats without their own folder have nowhere to run.', 'Set defaultCwd in config.json to a project folder.'));
  } else if (!ctx.sys.stat(cwd)) {
    issues.push(fail(`defaultCwd ${cwd} does not exist.`, 'Every chat without its own folder fails to start the agent.', 'Point defaultCwd at a real folder.'));
  } else {
    repoTop = git(ctx, cwd, ['rev-parse', '--show-toplevel']);
    if (repoTop && allowsEdits(agentConfig)) {
      issues.push(warn(`Game chat can edit ${repoTop} (${agentName} permissionMode ${agentConfig.permissionMode || 'default'}).`,
        'Anything typed in game, including a bad strip decode, can change files in that repo.',
        'Point defaultCwd at a scratch repo, or set permissionMode to "default" for read-only chats.'));
    }
  }
  if (agentName === 'claude' && !agentConfig.model) {
    issues.push(warn('agents.claude.model is empty.', 'The game chat inherits the global Claude model, so a change there changes the in-game cost and speed.', 'Set agents.claude.model in config.json to pin a model.'));
  }
  const summary = `agent ${agentName}, defaultCwd ${cwd || 'unset'}${repoTop ? ' (git repo)' : ''}, model ${agentConfig.model || 'inherited'}`;
  return finish('config', 'Config', summary, issues);
}

function checkCi(ctx) {
  const repo = checkoutState(ctx);
  if (!repo || !repo.branch || repo.branch === 'HEAD') return finish('ci', 'CI', 'no branch to look up', []);
  const r = ctx.sys.run('gh', ['run', 'list', '--branch', repo.branch, '--limit', '1', '--json', 'conclusion,headSha,status,workflowName'], { cwd: repo.dir });
  if (!r.ok) {
    return finish('ci', 'CI', 'gh run list failed', [warn(`gh run list for ${repo.branch} failed: ${(r.err || '').trim().split('\n')[0] || 'no output'}.`, 'The doctor cannot tell if the running code passed CI.', 'Run "gh auth status" and check the checkout has a GitHub remote.')]);
  }
  let runs;
  try { runs = JSON.parse(r.out || '[]'); } catch { runs = []; }
  const latest = runs[0];
  if (!latest) {
    return finish('ci', 'CI', `no CI runs on ${repo.branch}`, [warn(`Branch ${repo.branch} has no CI run.`, 'The live code has never been tested by CI.', `Push ${repo.branch} and let CI run.`)]);
  }
  const issues = [];
  const shortHead = (repo.head || '').slice(0, 7);
  if (latest.headSha !== repo.head) {
    issues.push(warn(`HEAD ${shortHead} has no CI run; the latest run on ${repo.branch} is for ${String(latest.headSha).slice(0, 7)}.`, 'The live checkout runs commits CI never saw (unpushed or pushed without a run).', `Push ${repo.branch} and wait for CI.`));
  } else if (latest.status === 'completed' && latest.conclusion !== 'success') {
    issues.push(warn(`CI on HEAD ${shortHead} ended "${latest.conclusion}".`, 'The live code fails its own tests.', `Run "gh run view" in ${repo.dir} for the failing step.`));
  }
  const state = latest.status === 'completed' ? latest.conclusion : latest.status;
  return finish('ci', 'CI', `${repo.branch} latest run ${state} on ${String(latest.headSha).slice(0, 7)} (HEAD ${shortHead})`, issues);
}

const CHECKS = [checkService, checkDrift, checkLogs, checkSignals, checkPresence, checkInterface, checkPermissions, checkDisk, checkData, checkCost, checkConfig, checkCi];

function runChecks(ctx, checks = CHECKS) {
  return checks.map(check => {
    try { return check(ctx); } catch (e) {
      return result(check.name, check.name, 'fail', 'the check crashed', [problem(`The ${check.name} check threw: ${e.message}.`, 'A doctor bug or an unexpected file shape.', 'Report it with the stack from "node dev/doctor.js --json".')]);
    }
  });
}

module.exports = {
  CHECKS, LIMITS, TROUBLE_PATTERN,
  runChecks, checkService, checkDrift, checkLogs, checkSignals, checkPresence, checkInterface, checkPermissions, checkDisk, checkData, checkCost, checkConfig, checkCi,
  parseEtime, formatBytes, summarizeLog, parseLastSeq, slotsAhead, tocInterface, interfaceFromVersion, productForFlavor, parseBuildInfo, parseReflog, claudeProjectDir, allowsEdits,
};
