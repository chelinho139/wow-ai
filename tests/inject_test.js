// Live bridge test in a scratch sandbox: fake AddOns dir with a 5-slot pool, then
// `node bridge.js --inject "..."` runs a real headless agent, once per plugin,
// and must publish the reply into every slot, Inbox.lua, and flip the signal /
// heartbeat files. The coding plugin must run in the project folder, ask in its
// scratch folder. Needs that agent's CLI installed and logged in. Claude by default:
//   node tests/inject_test.js [--agent claude|codex|grok] [--plugin ask|claude-code]
'use strict';
const fs = require('fs'), path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const luaparse = require('luaparse');

const S = path.join(__dirname, 'tmp', 'inject');
const SRC = path.join(__dirname, '..', 'bridge');
fs.rmSync(S, { recursive: true, force: true });
fs.mkdirSync(path.join(S, 'addons', 'ClaudeWoW'), { recursive: true });
fs.mkdirSync(path.join(S, 'proj'), { recursive: true });
for (const f of ['bridge.js', 'protocol.js', 'agents.js', 'plugins.js', 'decode.js', 'screenshots.js', 'vision.js', 'install-slots.js', 'capture.ps1']) fs.copyFileSync(path.join(SRC, f), path.join(S, f));
fs.mkdirSync(path.join(S, 'plugins'), { recursive: true });
for (const f of fs.readdirSync(path.join(SRC, 'plugins'))) fs.copyFileSync(path.join(SRC, 'plugins', f), path.join(S, 'plugins', f));
const agentIdx = process.argv.indexOf('--agent');
const agent = agentIdx >= 0 ? process.argv[agentIdx + 1] : 'claude';
const pluginIdx = process.argv.indexOf('--plugin');
const plugins = pluginIdx >= 0 ? [process.argv[pluginIdx + 1]] : ['claude-code', 'ask'];
fs.writeFileSync(path.join(S, 'addons', 'ClaudeWoW', 'ClaudeWoW.toc'), '## Interface: 16001\n');

const cfg = JSON.parse(fs.readFileSync(path.join(SRC, 'config.example.json'), 'utf8'));
cfg.addonDir = path.join(S, 'addons');
cfg.inboxFile = path.join(S, 'addons', 'ClaudeWoW', 'Inbox.lua');
cfg.savedVariablesFile = path.join(S, 'nope.lua');
cfg.defaultCwd = path.join(S, 'proj');
cfg.plugins = { default: 'ask', ask: { cwd: path.join(S, 'scratch') } };
cfg.slots = 5;
fs.writeFileSync(path.join(S, 'config.json'), JSON.stringify(cfg, null, 2));

console.log(execFileSync(process.execPath, ['install-slots.js'], { cwd: S, encoding: 'utf8' }).trim());

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
    } else top[f.key.name] = f.value.type === 'TableConstructorExpression' ? f.value.fields.map(x => val(x.value)) : val(f.value);
  }
  return top;
}

// The system prompt asks for a closing TL;DR block, so the reply is "PONG" plus
// that block (the summary the game chat prints is split off as `summary`).
const pong = text => /^PONG\b/.test(String(text || ''));
// A signal is a valid .wav; "off" is no file at all.
const size = f => { try { return fs.statSync(path.join(S, 'addons', 'ClaudeWoW', f)).size; } catch { return -1; } };
const pad = n => String(n).padStart(3, '0');
const env = { ...process.env }; delete env.CLAUDECODE;
console.log(`agent: ${agent}`);

let ok = true;
let n = 0; // message ids count up across runs (state.json lives in the sandbox)
for (const plugin of plugins) {
  n++;
  console.log(`\n--- plugin ${plugin} (message #${n}) ---`);
  const r = spawnSync(process.execPath, ['bridge.js', '--inject', 'Reply with exactly the word PONG and nothing else.', '--agent', agent, '--plugin', plugin], { cwd: S, encoding: 'utf8', env, timeout: 180000 });
  const lines = r.stdout.split('\n').filter(l => l.includes(`#${n}`));
  console.log(lines.join('\n'));
  if (r.stderr.trim()) console.log('stderr:', r.stderr.trim().slice(0, 500));
  const where = plugin === 'ask' ? cfg.plugins.ask.cwd : cfg.defaultCwd;
  const ran = lines.some(l => l.includes(`[${plugin}]`) && l.includes(`starting in ${where}`));
  if (!ran) console.log(`BAD: expected "[${plugin}] ... starting in ${where}" in the log`);
  ok = ok && ran;
  for (let i = 1; i <= 5; i++) {
    const d = readLua(path.join(S, 'addons', 'ClaudeWoW_S00' + i, 'Inbox.lua'), 'ClaudeWoW_SlotData');
    const rec = (d.replies || [])[0] || {};
    const good = d.replies && d.replies.length === 1 && Number(rec.id) === n && rec.status === 'done' && pong(rec.text) && rec.agent === agent && rec.plugin === plugin;
    ok = ok && good;
    console.log(`slot ${i}: replies=${(d.replies || []).length} id=${rec.id} status=${rec.status} agent=${rec.agent} plugin=${rec.plugin} text=${JSON.stringify(rec.text)} ${good ? 'ok' : 'BAD'}`);
  }
  const inbox = readLua(cfg.inboxFile, 'ClaudeWoW_Inbox');
  const ir = (inbox.replies || [])[0] || {};
  console.log(`Inbox.lua: id=${ir.id} status=${ir.status} plugin=${inbox.plugin} plugins=${JSON.stringify(inbox.plugins)} text=${JSON.stringify(ir.text)}`);
  ok = ok && pong(ir.text) && inbox.plugin === 'ask';
  const sig = `sig/${pad(n)}.wav`, ack = `ack/${pad(n)}.wav`, next = `sig/${pad(n + 1)}.wav`, act = `act/${pad(n)}/01.wav`;
  console.log(`${sig}=${size(sig)}B  ${ack}=${size(ack)}B  ${next}=${size(next)}B  ${act}=${size(act)}B  (-1 = no file)`);
  ok = ok && size(sig) > 40 && size(ack) > 40 && size(next) === -1 && size(act) > 40;
}
console.log(ok ? '\n>>> INJECT TEST PASS' : '\n>>> INJECT TEST FAIL');
process.exit(ok ? 0 : 1);
