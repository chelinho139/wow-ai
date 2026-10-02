// The bridge's outbound transport, end to end against a fake home and a fake
// agent: a new install starts on the screenshot transport; when the addon
// reports that it cannot take the screenshot (a "shot" in the reload outbox,
// which is how a client without Screenshot() reaches a bridge that is not
// watching the screen), the bridge falls back to the pixel capture at once,
// says so in the log, remembers it in state.json, and names it in the slot
// files (the addon's /claude-wow diag shows the note) and in its banner at the
// next start; an explicit capture.mode always wins over that memory.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const BRIDGE = path.join(__dirname, '..', 'bridge', 'bridge.js');

function scratch(name) {
  const dir = path.join(os.tmpdir(), `claude-wow-transport-${name}-${process.pid}-${Date.now().toString(36)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// A home folder with a config that points every game-side path into the same
// scratch tree: the addon folder with its signal folders and one installed slot
// (the bridge writes slot files only when ClaudeWoW_S001/Inbox.lua exists), the
// SavedVariables file, a project folder, and an agent that answers at once.
function fakeInstall(dir, capture = {}) {
  const home = path.join(dir, 'home');
  const client = path.join(dir, 'client');
  const addons = path.join(client, 'Interface', 'AddOns');
  const project = path.join(dir, 'project');
  for (const d of ['sig', 'ack', 'act', 'presence']) fs.mkdirSync(path.join(addons, 'ClaudeWoW_Runtime', d), { recursive: true });
  fs.mkdirSync(path.join(addons, 'ClaudeWoW'), { recursive: true });
  fs.writeFileSync(path.join(addons, 'ClaudeWoW', 'ClaudeWoW.toc'), '## Interface: 16001\n');
  fs.mkdirSync(path.join(addons, 'ClaudeWoW_S001'), { recursive: true });
  fs.writeFileSync(path.join(addons, 'ClaudeWoW_S001', 'Inbox.lua'), 'ClaudeWoW_SlotData = nil\n');
  fs.mkdirSync(path.join(client, 'Screenshots'), { recursive: true });
  const savedDir = path.join(client, 'WTF', 'Account', 'ACCT', 'SavedVariables');
  fs.mkdirSync(savedDir, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const agent = path.join(dir, 'fake-claude.js');
  fs.writeFileSync(agent, "process.stdout.write(JSON.stringify({ type: 'result', result: 'pong', session_id: 'sess-1' }) + '\\n');\n");
  const cfg = {
    addonDir: addons,
    savedVariablesFile: path.join(savedDir, 'ClaudeWoW.lua'),
    inboxFile: path.join(addons, 'ClaudeWoW_Runtime', 'Inbox.lua'),
    defaultCwd: project, slots: 1, agent: 'claude', agents: { claude: { path: agent } },
    plugins: { default: 'claude-code' }, gameContext: false, primerFile: '',
    capture: { enabled: true, ...capture },
  };
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(cfg, null, 2));
  return { home, addons, saved: cfg.savedVariablesFile, project, cfg };
}

// What the game writes on /reload with a message waiting: the reload outbox,
// here from an addon on the screenshot transport in a client without Screenshot().
function outbox(id, text, shot) {
  const hex = s => Buffer.from(s, 'utf8').toString('hex');
  return `ClaudeWoWDB = {\n["outbox"] = {\n["id"] = ${id},\n["session"] = "sess1",\n["chat"] = "chat1",\n["text"] = "${hex(text)}",\n["cwd"] = "",\n${shot ? `["shot"] = "${shot}",\n` : ''}["t"] = 1,\n},\n}\n`;
}

function runOnce(home, project, extra = []) {
  const r = spawnSync(process.execPath, [BRIDGE, '--once', '--project', project, ...extra], {
    encoding: 'utf8', env: { ...process.env, CLAUDE_WOW_HOME: home }, timeout: 60000,
  });
  return { ...r, out: r.stdout + r.stderr };
}

test('a new install starts on the screenshot transport; the addon reporting shot=missing makes the bridge fall back to pixels, say so, remember it and name it in the slot files', () => {
  const dir = scratch('fallback');
  const { home, addons, saved, project } = fakeInstall(dir);
  fs.writeFileSync(saved, outbox(7, 'ping', 'missing'));

  const r = runOnce(home, project);
  assert.equal(r.status, 0, r.out);
  // The banner: the default transport, named as such.
  assert.match(r.out, /^ {2}capture {2}: screenshot transport \(the default; no screen capture, no permissions, no python\): /m, r.out);
  // The report arrived (through the reload outbox) and the bridge switched, in plain words.
  assert.match(r.out, /#7@sess1 TRANSPORT FALLBACK: the addon reports shot=missing: the game client has no Screenshot\(\) function\./, r.out);
  assert.match(r.out, /switching from the screenshot transport to the pixel capture \(deprecated; it needs /, r.out);
  assert.match(r.out, /remembered in .*state\.json: the next start goes straight to the pixel transport\. To choose for good, set capture\.mode in .*config\.json to "pixel" \(no more note\) or "screenshot" \(try again\)\./, r.out);
  // The message itself was still handled (the reload path carried it).
  assert.match(r.out, /#7@sess1 \(reload\) \[claude-code\] Claude starting in /, r.out);
  assert.match(r.out, /#7@sess1 done \(/, r.out);
  // Remembered.
  const state = JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8'));
  assert.equal(state.transportFallback.reason, 'missing');
  assert.equal(state.transportFallback.session, 'sess1');
  assert.ok(Date.now() - state.transportFallback.at < 60000);
  // The slot files and Inbox.lua say pixel, with the note the addon shows in /claude-wow diag.
  for (const f of [path.join(addons, 'ClaudeWoW_S001', 'Inbox.lua'), path.join(addons, 'ClaudeWoW_Runtime', 'Inbox.lua')]) {
    const lua = fs.readFileSync(f, 'utf8');
    assert.match(lua, /^\ttransport = "pixel",$/m, f);
    assert.match(lua, /^\ttransportNote = "pixel transport, fallen back to since \d{4}-\d\d-\d\d \d\d:\d\d UTC because the game client has no Screenshot\(\) function; the pixel capture is deprecated: set capture\.mode in config\.json to \\"pixel\\" to keep it without this note, or to \\"screenshot\\" to try the screenshot transport again",$/m, f);
    assert.ok(!/^\tstrip = /m.test(lua), 'no screenshot strip levels on the pixel transport');
  }
  // The log file has the same lines.
  assert.match(fs.readFileSync(path.join(home, 'bridge.log'), 'utf8'), /TRANSPORT FALLBACK/);

  // The next start, nothing pending: straight to the pixel transport, and the banner says why.
  const again = runOnce(home, project);
  assert.equal(again.status, 0, again.out);
  assert.match(again.out, /^ {2}capture {2}: pixel transport, DEPRECATED \(FALLBACK: pixel transport, fallen back to since .* because the game client has no Screenshot\(\) function; /m, again.out);
  assert.match(again.out, /nothing pending/);
  assert.match(fs.readFileSync(path.join(addons, 'ClaudeWoW_S001', 'Inbox.lua'), 'utf8'), /^\ttransportNote = /m, 'the note stays in the slot files');

  // The same report again is not news: nothing switches, nothing is logged about it.
  fs.writeFileSync(saved, outbox(8, 'ping again', 'missing'));
  const third = runOnce(home, project);
  assert.equal(third.status, 0, third.out);
  assert.ok(!/TRANSPORT FALLBACK/.test(third.out), third.out);
  assert.match(third.out, /#8@sess1 done \(/, third.out);

  // An explicit capture.mode in config.json wins over the memory: "screenshot" tries again...
  // (a message in the outbox each time, so the run publishes slot files; a --once with nothing pending writes none)
  const cfgFile = path.join(home, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  cfg.capture.mode = 'screenshot';
  fs.writeFileSync(cfgFile, JSON.stringify(cfg));
  fs.writeFileSync(saved, outbox(10, 'hello again', ''));
  const explicit = runOnce(home, project);
  assert.equal(explicit.status, 0, explicit.out);
  assert.match(explicit.out, /^ {2}capture {2}: screenshot transport \(capture\.mode in config\.json\): /m, explicit.out);
  assert.match(explicit.out, /#10@sess1 done \(/, explicit.out);
  const back = fs.readFileSync(path.join(addons, 'ClaudeWoW_S001', 'Inbox.lua'), 'utf8');
  assert.match(back, /^\ttransport = "screenshot",$/m, back);
  assert.ok(!/transportNote/.test(back), 'no note on the transport the config chose');
  // ...and falls back again, this run, when the addon still cannot shoot; the config is named as the reason it will keep trying.
  fs.writeFileSync(saved, outbox(11, 'still no shots', 'failed'));
  const retry = runOnce(home, project);
  assert.equal(retry.status, 0, retry.out);
  assert.match(retry.out, /#11@sess1 TRANSPORT FALLBACK: the addon reports shot=failed: the game client reported SCREENSHOT_FAILED on every try\./, retry.out);
  assert.match(fs.readFileSync(path.join(addons, 'ClaudeWoW_S001', 'Inbox.lua'), 'utf8'), /^\ttransportNote = "pixel transport, fallen back to since .* because the game client reported SCREENSHOT_FAILED on every try; /m);
  assert.match(retry.out, /capture\.mode is "screenshot" in .*config\.json, so every start tries the screenshot transport first and falls back again/, retry.out);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8')).transportFallback.reason, 'failed');
  // ..."pixel" is simply the pixel transport, deprecated, without the note.
  cfg.capture.mode = 'pixel';
  fs.writeFileSync(cfgFile, JSON.stringify(cfg));
  fs.writeFileSync(saved, outbox(12, 'on pixels', ''));
  const pixel = runOnce(home, project);
  assert.equal(pixel.status, 0, pixel.out);
  assert.match(pixel.out, /#12@sess1 done \(/, pixel.out);
  assert.match(pixel.out, /^ {2}capture {2}: pixel transport, DEPRECATED \(capture\.mode in config\.json; kept only until Screenshot\(\) is confirmed on Windows and Linux\/Wine\): /m, pixel.out);
  assert.ok(!/transportNote/.test(fs.readFileSync(path.join(addons, 'ClaudeWoW_S001', 'Inbox.lua'), 'utf8')), 'no note when the pixel transport was chosen');
  // A bad mode is refused with the file name, exit 2 (the supervisor does not loop on it).
  cfg.capture.mode = 'gif';
  fs.writeFileSync(cfgFile, JSON.stringify(cfg));
  const bad = runOnce(home, project);
  assert.equal(bad.status, 2, bad.out);
  assert.match(bad.out, /"capture\.mode": "gif" in .*config\.json is not one of pixel, screenshot\./);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a report the bridge cannot use (an unknown reason) changes nothing, and a config without a mode stays on the default', () => {
  const dir = scratch('noop');
  const { home, addons, saved, project } = fakeInstall(dir);
  fs.writeFileSync(saved, outbox(3, 'plain', ''));
  const r = runOnce(home, project);
  assert.equal(r.status, 0, r.out);
  assert.ok(!/TRANSPORT FALLBACK/.test(r.out));
  assert.match(r.out, /#3@sess1 done \(/, r.out);
  const state = JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8'));
  assert.equal(state.transportFallback, undefined);
  const lua = fs.readFileSync(path.join(addons, 'ClaudeWoW_S001', 'Inbox.lua'), 'utf8');
  assert.match(lua, /^\ttransport = "screenshot",$/m);
  assert.match(lua, /^\tstrip = \{ on = 60, off = 0, codec = 2 \},$/m);
  assert.ok(!/transportNote/.test(lua));
  fs.rmSync(dir, { recursive: true, force: true });
});
