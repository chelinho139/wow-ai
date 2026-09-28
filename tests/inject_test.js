// Live bridge test in a scratch sandbox: fake AddOns dir with a 5-slot pool, then
// `node bridge.js --inject "..."` runs a real headless agent and must publish the
// reply into every slot, Inbox.lua, and flip the signal / heartbeat files.
// Needs that agent's CLI installed and logged in. Claude by default:
//   node tests/inject_test.js [--agent claude|codex|grok]
'use strict';
const fs = require('fs'), path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const luaparse = require('luaparse');

const S = path.join(__dirname, 'tmp', 'inject');
const SRC = path.join(__dirname, '..', 'bridge');
fs.rmSync(S, { recursive: true, force: true });
fs.mkdirSync(path.join(S, 'addons', 'WoWAI'), { recursive: true });
fs.mkdirSync(path.join(S, 'proj'), { recursive: true });
for (const f of ['bridge.js', 'protocol.js', 'agents.js', 'plugins.js', 'decode.js', 'screenshots.js', 'vision.js', 'install-slots.js', 'capture.ps1']) fs.copyFileSync(path.join(SRC, f), path.join(S, f));
fs.mkdirSync(path.join(S, 'plugins'), { recursive: true });
for (const f of fs.readdirSync(path.join(SRC, 'plugins'))) fs.copyFileSync(path.join(SRC, 'plugins', f), path.join(S, 'plugins', f));
const agentIdx = process.argv.indexOf('--agent');
const agent = agentIdx >= 0 ? process.argv[agentIdx + 1] : 'claude';
fs.writeFileSync(path.join(S, 'addons', 'WoWAI', 'WoWAI.toc'), '## Interface: 16001\n');

const cfg = JSON.parse(fs.readFileSync(path.join(SRC, 'config.example.json'), 'utf8'));
cfg.addonDir = path.join(S, 'addons');
cfg.inboxFile = path.join(S, 'addons', 'WoWAI', 'Inbox.lua');
cfg.savedVariablesFile = path.join(S, 'nope.lua');
cfg.defaultCwd = path.join(S, 'proj');
cfg.slots = 5;
fs.writeFileSync(path.join(S, 'config.json'), JSON.stringify(cfg, null, 2));

console.log(execFileSync(process.execPath, ['install-slots.js'], { cwd: S, encoding: 'utf8' }).trim());

const env = { ...process.env }; delete env.CLAUDECODE;
console.log(`agent: ${agent}`);
const r = spawnSync(process.execPath, ['bridge.js', '--inject', 'Reply with exactly the word PONG and nothing else.', '--agent', agent], { cwd: S, encoding: 'utf8', env, timeout: 180000 });
console.log(r.stdout.split('\n').filter(l => l.includes('#1')).join('\n'));
if (r.stderr.trim()) console.log('stderr:', r.stderr.trim().slice(0, 500));

function readLua(file, globalName) {
  const src = fs.readFileSync(file, 'utf8');
  const ast = luaparse.parse(src, { luaVersion: '5.1' });
  const assign = ast.body.find(n => n.type === 'AssignmentStatement' && n.variables[0].name === globalName);
  const val = v => v.raw !== undefined ? v.raw.replace(/^"|"$/g, '') : v.value;
  const top = {};
  for (const f of assign.init[0].fields) {
    if (f.key.name === 'replies') {
      top.replies = f.value.fields.map(entry => {
        const rec = {};
        for (const g of entry.value.fields) rec[g.key.name] = val(g.value);
        return rec;
      });
    } else top[f.key.name] = val(f.value);
  }
  return top;
}

// The system prompt asks for a closing TL;DR block, so the reply is "PONG" plus
// that block (the summary the game chat prints is split off as `summary`).
const pong = text => /^PONG\b/.test(String(text || ''));
let ok = true;
for (let i = 1; i <= 5; i++) {
  const d = readLua(path.join(S, 'addons', 'WoWAI_S00' + i, 'Inbox.lua'), 'WoWAI_SlotData');
  const rec = (d.replies || [])[0] || {};
  const good = d.replies && d.replies.length === 1 && Number(rec.id) === 1 && rec.status === 'done' && pong(rec.text) && rec.agent === agent;
  ok = ok && good;
  console.log(`slot ${i}: replies=${(d.replies || []).length} id=${rec.id} status=${rec.status} agent=${rec.agent} plugin=${rec.plugin} text=${JSON.stringify(rec.text)} ${good ? 'ok' : 'BAD'}`);
}
const inbox = readLua(cfg.inboxFile, 'WoWAI_Inbox');
const ir = (inbox.replies || [])[0] || {};
console.log(`Inbox.lua: id=${ir.id} status=${ir.status} text=${JSON.stringify(ir.text)}`);
ok = ok && pong(ir.text);
// A signal is a valid .wav; "off" is no file at all.
const size = f => { try { return fs.statSync(path.join(S, 'addons', 'WoWAI', f)).size; } catch { return -1; } };
console.log(`sig/001.wav=${size('sig/001.wav')}B  ack/001.wav=${size('ack/001.wav')}B  sig/002.wav=${size('sig/002.wav')}B  act/001/01.wav=${size('act/001/01.wav')}B  (-1 = no file)`);
ok = ok && size('sig/001.wav') > 40 && size('ack/001.wav') > 40 && size('sig/002.wav') === -1 && size('act/001/01.wav') > 40;
console.log(ok ? '>>> INJECT TEST PASS' : '>>> INJECT TEST FAIL');
process.exit(ok ? 0 : 1);
