#!/usr/bin/env node
'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const H = require('./harness');
const SB = require('./sandbox');

const HELP = `
  type a message          send it from the active chat
  /claude-wow ...         run an addon slash command (/claude-wow help lists them)
  :reload                 /reload the UI (SavedVariables are written, slots freed)
  :quit-game / :launch    log out of the game (saves), then start it again
  :crash-game             kill the game without saving
  :bridge stop|start|restart|crash
  :hide / :show           Alt+Z: hide or show the UI (the strip cannot be seen)
  :key                    press a key (runs an armed reload)
  :diag                   /claude-wow diag, printed here
  :state                  the bridge's state.json
  :db                     the addon's ClaudeWoWDB summary
  :log [n]                the last n bridge log lines (default 20)
  :files                  signal files on disk (ack, sig) and screenshots waiting
  :help                   this list
  :exit                   stop everything (the sandbox stays in .dev/sandboxes)
`;

function parseArgs(argv) {
  const o = { name: 'default', fresh: false, echo: false, speed: 1, realAgent: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--fresh') o.fresh = true;
    else if (a === '--echo') o.echo = true;
    else if (a === '--real-agent') o.realAgent = true;
    else if (a === '--name') o.name = argv[++i];
    else if (a === '--speed') o.speed = Number(argv[++i]) || 1;
    else if (a === '--help' || a === '-h') o.help = true;
  }
  return o;
}

function roleColor(role) {
  return role === 'user' ? '\x1b[36m' : role === 'assistant' ? '\x1b[33m' : '\x1b[90m';
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { console.log('npm run dev -- [--fresh] [--name <sandbox>] [--speed <x>] [--echo] [--real-agent]' + HELP); return; }
  const existing = fs.existsSync(path.join(SB.DEFAULT_ROOT, o.name, 'sandbox.json'));
  const sbOpts = { speed: o.speed };
  if (o.realAgent) {
    o.fresh = true;
    sbOpts.agentPath = '';
    sbOpts.env = { HOME: os.homedir(), USERPROFILE: os.homedir() };
    console.log('\x1b[31m--real-agent: messages run your real claude CLI in the sandbox project and use your plan quota.\x1b[0m');
  }
  const h = await H.start(o.name, Object.assign({ open: existing && !o.fresh, keep: true, echo: o.echo, client: { speed: o.speed } }, sbOpts));
  const { client, bridge, sb } = h;
  console.log(`sandbox  ${sb.dir}\nclient   ${sb.client}\nhome     ${sb.home}\nlog      ${bridge.outFile}\n:help for commands`);

  let seen = new Map();
  let printed = client.prints().length;
  const show = () => {
    try {
      const db = client.db() || {};
      for (const c of db.chats || []) {
        const n = seen.get(c.id) || 0;
        const hist = c.history || [];
        for (const m of hist.slice(n)) console.log(`${roleColor(m.role)}[${c.name}] ${m.role}${m.id ? ' #' + m.id : ''}:\x1b[0m ${m.text}`);
        seen.set(c.id, hist.length);
      }
      const p = client.prints();
      for (const line of p.slice(printed)) console.log(`\x1b[35m[game]\x1b[0m ${line.replace(/\|c\w{8}|\|r|\|H[^|]*\|h|\|h/g, '')}`);
      printed = p.length;
      for (const e of client.errors().slice(-1)) if (e !== show.lastErr) { console.log(`\x1b[31m[lua error]\x1b[0m ${e}`); show.lastErr = e; }
    } catch {}
  };
  const ticker = setInterval(show, 250);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
  rl.prompt();
  rl.on('line', async line => {
    const t = line.trim();
    try {
      if (!t) rl.prompt();
      else if (t === ':help') console.log(HELP);
      else if (t === ':exit') { rl.close(); return; }
      else if (t === ':reload') { client.reload(); seen = new Map(); printed = 0; }
      else if (t === ':quit-game') client.quit();
      else if (t === ':crash-game') client.quit({ crash: true });
      else if (t === ':launch') { client.launch(); client.start(); seen = new Map(); printed = 0; }
      else if (t.startsWith(':bridge')) {
        const verb = t.split(/\s+/)[1];
        if (verb === 'stop') await bridge.stop();
        else if (verb === 'start') { bridge.start(); await bridge.ready(); }
        else if (verb === 'restart') await bridge.restart();
        else if (verb === 'crash') await bridge.crash();
        console.log(`bridge ${bridge.pid ? 'running, pid ' + bridge.pid : 'stopped'}`);
      }
      else if (t === ':hide') client.setUiHidden(true);
      else if (t === ':show') client.setUiHidden(false);
      else if (t === ':key') client.pressKey();
      else if (t === ':diag') console.log(client.diag());
      else if (t === ':state') console.log(JSON.stringify(h.state(), null, 2));
      else if (t === ':db') {
        const db = client.db() || {};
        console.log({ lastSeq: db.lastSeq, activeChat: db.activeChat, chats: (db.chats || []).map(c => ({ id: c.id, name: c.name, pending: c.pendingId, turns: c.turns, ctx: c.ctx, cost: c.cost, messages: (c.history || []).length })) });
      }
      else if (t.startsWith(':log')) {
        const n = Number(t.split(/\s+/)[1]) || 20;
        console.log(bridge.output.trim().split('\n').slice(-n).join('\n'));
      }
      else if (t === ':files') {
        const dir = kind => { try { return fs.readdirSync(path.join(sb.addons, 'ClaudeWoW', kind)).filter(f => f.endsWith('.wav')); } catch { return []; } };
        console.log({ ack: dir('ack'), sig: dir('sig'), screenshots: h.screenshots() });
      }
      else if (t.startsWith('/')) client.slash(t);
      else client.send(t);
    } catch (e) {
      console.log(`\x1b[31m${e.message}\x1b[0m`);
    }
    rl.prompt();
  });
  rl.on('close', async () => {
    clearInterval(ticker);
    client.stop();
    await bridge.stop();
    console.log(`stopped. The sandbox stays at ${sb.dir} (npm run dev -- --fresh starts over).`);
    process.exit(0);
  });
}

main().catch(e => { console.error(e.stack || e.message); process.exit(1); });
