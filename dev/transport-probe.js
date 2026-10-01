#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const HOME = require('../bridge/home');

const CHAT_LOG = 'WoWChatLog.txt';
const ASYNC_LOG = 'AsyncFile.log';
const PROBE_LINE = /(CWLOG\d+) (LONG|V|H|END) ?(\S*)/;
const ASYNC_LINE = /(Cancel requested|Cancel processed|Wait Started|Wait Finished) -- FileData ID (-?\d+)/;
const STRIP_LINE = /  (CWLOG\d+|CWX1) /;
const SINGLE_IDS = { 133975: 'A1 shown cancel', 133888: 'A2 twice', 134120: 'A3 hidden cancel', 8999999: 'A4 missing id', 134188: 'A5 blocking load', 134336: 'A6/A7 keep then reuse' };
const CANCEL_BURST_FIRST = 135000;
const WAIT_BURST_FIRST = 135100;
const BURST_COUNT = 48;

function parseArgs(argv) {
  const o = { logs: '', out: '', minutes: 110, settle: 150, interval: 200 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--logs') o.logs = argv[++i];
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--minutes') o.minutes = Number(argv[++i]) || o.minutes;
    else if (a === '--settle') o.settle = Number(argv[++i]) || o.settle;
    else if (a === '--interval') o.interval = Number(argv[++i]) || o.interval;
    else if (a === '--truncate-test') o.truncateTest = true;
    else if (a === '--help' || a === '-h') o.help = true;
  }
  return o;
}

function logsDirFromConfig() {
  try {
    const home = HOME.resolve();
    const cfg = JSON.parse(fs.readFileSync(home.config, 'utf8'));
    const addonDir = String(cfg.addonDir || '').replace(/[\\/]+$/, '');
    if (!addonDir) return '';
    return path.join(path.dirname(path.dirname(addonDir)), 'Logs');
  } catch {
    return '';
  }
}

function burstLabel(id) {
  if (id >= CANCEL_BURST_FIRST && id < CANCEL_BURST_FIRST + BURST_COUNT) return 'A8 cancel burst';
  if (id >= WAIT_BURST_FIRST && id < WAIT_BURST_FIRST + BURST_COUNT) return 'A9 wait burst';
  return '';
}

function completeLines(state, text) {
  const all = (state.carry || '') + text;
  const cut = all.lastIndexOf('\n');
  state.carry = cut < 0 ? all : all.slice(cut + 1);
  return cut < 0 ? [] : all.slice(0, cut).split(/\r?\n/);
}

function newChatState() {
  return { growth: [], tags: {}, carry: '' };
}

function feedChat(state, text, seenAt, from, to) {
  state.growth.push({ seenAt, from, to, delta: to - from });
  for (const line of completeLines(state, text)) {
    const m = PROBE_LINE.exec(line);
    if (!m) continue;
    const tag = state.tags[m[1]] || (state.tags[m[1]] = { firstSeenAt: seenAt, visible: 0, hidden: 0, longLength: null, end: false, highest: 0 });
    if (m[2] === 'LONG') tag.longLength = m[3].length;
    else if (m[2] === 'END') tag.end = true;
    else {
      if (m[2] === 'V') tag.visible++; else tag.hidden++;
      tag.highest = Math.max(tag.highest, Number(m[3]) || 0);
    }
  }
}

function newAsyncState() {
  return { lines: [], truncated: 0, carry: '' };
}

function feedAsync(state, text, seenAt) {
  for (const line of completeLines(state, text)) {
    const m = ASYNC_LINE.exec(line);
    if (!m) continue;
    const id = Number(m[2]);
    const label = SINGLE_IDS[id] || burstLabel(id);
    if (!label) continue;
    state.lines.push({ seenAt, stamp: line.slice(0, line.indexOf('  ')).trim(), kind: m[1], id, label });
  }
}

function burstSummary(lines, label, kind, first) {
  const ids = lines.filter(l => l.label === label && l.kind === kind).map(l => l.id);
  const distinct = new Set(ids);
  let inOrder = true;
  for (let i = 1; i < ids.length; i++) if (ids[i] < ids[i - 1]) inOrder = false;
  const missing = [];
  for (let i = 0; i < BURST_COUNT; i++) if (!distinct.has(first + i)) missing.push(first + i);
  return { lines: ids.length, distinct: distinct.size, of: BURST_COUNT, inOrder, missing };
}

function verdict(chat, asyncState) {
  const out = { chatlog: { status: 'no evidence', tags: chat.tags, growth: chat.growth }, asyncfile: { status: 'no evidence' } };
  const tags = Object.values(chat.tags);
  if (tags.length > 0) {
    const t = tags[tags.length - 1];
    const deltas = chat.growth.map(g => g.delta);
    out.chatlog.status = 'ALIVE: probe lines reached disk while the game ran';
    out.chatlog.hiddenLinesLogged = t.hidden > 0;
    out.chatlog.visibleLinesLogged = t.visible;
    out.chatlog.longLineLength = t.longLength;
    out.chatlog.endLineOnDisk = t.end;
    out.chatlog.highestLine = t.highest;
    out.chatlog.flushDeltas = deltas;
    out.chatlog.allDeltasMultipleOf4096 = deltas.length > 0 && deltas.every(d => d % 4096 === 0);
  } else if (chat.growth.length > 0) {
    out.chatlog.status = 'file grew, but no probe line was in it';
  }
  if (asyncState.lines.length > 0) {
    const by = {};
    for (const l of asyncState.lines) {
      const key = l.label;
      by[key] = by[key] || {};
      by[key][l.kind] = (by[key][l.kind] || 0) + 1;
    }
    out.asyncfile.status = 'ALIVE: addon-chosen ids reached AsyncFile.log';
    out.asyncfile.steps = by;
    out.asyncfile.cancelBurst = burstSummary(asyncState.lines, 'A8 cancel burst', 'Cancel requested', CANCEL_BURST_FIRST);
    out.asyncfile.waitBurst = burstSummary(asyncState.lines, 'A9 wait burst', 'Wait Started', WAIT_BURST_FIRST);
    out.asyncfile.firstLines = asyncState.lines.slice(0, 12);
  }
  return out;
}

function readRange(file, from, to) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(to - from);
    fs.readSync(fd, buf, 0, buf.length, from);
    return buf.toString('latin1');
  } finally {
    fs.closeSync(fd);
  }
}

function stripInPlace(file, pattern) {
  const fd = fs.openSync(file, 'r+');
  try {
    const before = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(before);
    fs.readSync(fd, buf, 0, before, 0);
    const lines = buf.toString('latin1').split('\n');
    const kept = lines.filter(line => !pattern.test(line));
    const out = Buffer.from(kept.join('\n'), 'latin1');
    fs.writeSync(fd, out, 0, out.length, 0);
    fs.ftruncateSync(fd, out.length);
    return { before, after: out.length, removedLines: lines.length - kept.length };
  } finally {
    fs.closeSync(fd);
  }
}

function sizeOf(file) {
  try { return fs.statSync(file).size; } catch { return -1; }
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) {
    console.log('node dev/transport-probe.js [--logs <client Logs folder>] [--out <report.json>] [--minutes <n>] [--settle <seconds>]\nWatches WoWChatLog.txt and AsyncFile.log for the lines /claude probe writes, then prints a verdict.');
    return;
  }
  const logs = o.logs || logsDirFromConfig();
  if (!logs || !fs.existsSync(logs)) {
    console.error(`no Logs folder (${logs || 'no addonDir in config.json'}); pass --logs`);
    process.exit(2);
  }
  const chatFile = path.join(logs, CHAT_LOG);
  const asyncFile = path.join(logs, ASYNC_LOG);
  const chat = newChatState();
  const asyncState = newAsyncState();
  let chatAt = Math.max(sizeOf(chatFile), 0);
  let asyncAt = Math.max(sizeOf(asyncFile), 0);
  const started = Date.now();
  let evidenceAt = 0;
  console.log(`watching ${logs} (chat log at ${chatAt} bytes, AsyncFile.log at ${asyncAt} bytes)`);

  function finish(why) {
    const report = Object.assign({ why, started: new Date(started).toISOString(), ended: new Date().toISOString(), logs }, verdict(chat, asyncState));
    if (truncation) report.truncation = truncation;
    if (o.out) fs.writeFileSync(o.out, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
  }

  let truncation = null;

  setInterval(() => {
    const now = Date.now();
    const chatSize = sizeOf(chatFile);
    if (chatSize > chatAt) {
      const text = readRange(chatFile, chatAt, chatSize);
      if (truncation && !truncation.nextWrite) {
        truncation.nextWrite = { seenAt: new Date(now).toISOString(), size: chatSize, grewBy: chatSize - truncation.after, nulBytes: text.includes('\0') };
        truncation.appendedAfterTruncate = !truncation.nextWrite.nulBytes && chatSize < truncation.before;
        truncation.doneAt = now;
        console.log(`truncate test: next write seen, ${JSON.stringify(truncation.nextWrite)}`);
      }
      feedChat(chat, text, new Date(now).toISOString(), chatAt, chatSize);
      chatAt = chatSize;
      if (o.truncateTest && !truncation && Object.keys(chat.tags).length > 0) {
        truncation = Object.assign({ at: new Date(now).toISOString() }, stripInPlace(chatFile, STRIP_LINE));
        chatAt = truncation.after;
        chat.carry = '';
        console.log(`truncate test: removed ${truncation.removedLines} probe lines in place, ${truncation.before} -> ${truncation.after} bytes; waiting for the client's next write`);
      }
    } else if (chatSize >= 0 && chatSize < chatAt) {
      chatAt = chatSize;
    }
    if (truncation && truncation.doneAt && now - truncation.doneAt > 5000) finish('truncate test finished');
    const asyncSize = sizeOf(asyncFile);
    if (asyncSize >= 0 && asyncSize < asyncAt) {
      asyncAt = 0;
      asyncState.carry = '';
      asyncState.truncated++;
    }
    if (asyncSize > asyncAt) {
      feedAsync(asyncState, readRange(asyncFile, asyncAt, asyncSize), new Date(now).toISOString());
      asyncAt = asyncSize;
    }
    if (!evidenceAt && (Object.keys(chat.tags).length > 0 || asyncState.lines.length > 0)) {
      evidenceAt = now;
      console.log(`probe evidence seen at ${new Date(now).toISOString()}; collecting for ${o.settle} s more`);
    }
    if (!o.truncateTest && evidenceAt && now - evidenceAt > o.settle * 1000) finish('settled after probe evidence');
    if (now - started > o.minutes * 60000) finish('timed out with no probe evidence');
  }, o.interval);
}

if (require.main === module) main();

module.exports = { newChatState, feedChat, newAsyncState, feedAsync, verdict, parseArgs, stripInPlace, STRIP_LINE };
