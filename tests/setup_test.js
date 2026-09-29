// setup.js: the migration from an install under one of the project's old names
// (WoWAI, and WoWClaude before it) to ClaudeWoW, run against a fake client tree.
// The chats live in the addon's SavedVariables file; they have to come across
// with the DB globals renamed, the old addon and its slot pool have to go, and
// an old config.json has to end up naming the new addon.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const S = require('../setup.js');
const P = require('../bridge/protocol');

function scratch(name) {
  const dir = path.join(os.tmpdir(), `claude-wow-setup-${name}-${process.pid}-${Date.now().toString(36)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// What the game writes for the old addon: two account-wide globals (the .toc's
// SavedVariables), a chat with history, and the map DB behind it.
function oldSavedData(name) {
  return `
${name}DB = {
["chats"] = {
{
["created"] = 1790628573,
["id"] = "bad3474c10",
["cwd"] = "~/code/game",
["name"] = "You there",
["history"] = {
{
["id"] = 22,
["role"] = "user",
["text"] = "you there?",
},
{
["role"] = "assistant",
["id"] = 22,
["agent"] = "claude",
["text"] = "Yes. TL;DR: here.",
},
},
},
{
["id"] = "0ff1ce0001",
["name"] = "Second chat",
["history"] = {
},
},
},
["settings"] = {
["echo"] = 4000,
},
["token"] = "sess-token-1",
}
${name}MapDB = {
["hidden"] = {
["route"] = true,
},
}
`;
}

// A client folder with the old addon installed: Interface/AddOns/<old> plus a
// few of its slot folders, and the account's SavedVariables.
function fakeClient(dir, oldName, { slots = 3 } = {}) {
  const addons = path.join(dir, 'Interface', 'AddOns');
  fs.mkdirSync(path.join(addons, oldName, 'sig'), { recursive: true });
  fs.writeFileSync(path.join(addons, oldName, `${oldName}.toc`), '## Interface: 16001\n');
  fs.writeFileSync(path.join(addons, oldName, 'Inbox.lua'), `${oldName}_Inbox = { id = 0, replies = {} }\n`);
  for (let i = 1; i <= slots; i++) {
    const slot = `${oldName}_S${String(i).padStart(3, '0')}`;
    fs.mkdirSync(path.join(addons, slot), { recursive: true });
    fs.writeFileSync(path.join(addons, slot, `${slot}.toc`), `## Dependencies: ${oldName}\n`);
    fs.writeFileSync(path.join(addons, slot, 'Inbox.lua'), `${oldName}_SlotData = nil\n`);
  }
  fs.mkdirSync(path.join(addons, 'SomeOtherAddon'), { recursive: true }); // must survive untouched
  fs.writeFileSync(path.join(dir, 'World of Warcraft.app'), ''); // isClient: Interface/ + a game binary
  const saved = path.join(dir, 'WTF', 'Account', 'ACCT#1', 'SavedVariables');
  fs.mkdirSync(saved, { recursive: true });
  fs.writeFileSync(path.join(saved, `${oldName}.lua`), oldSavedData(oldName));
  fs.writeFileSync(path.join(saved, `${oldName}.lua.bak`), oldSavedData(oldName));
  return { addons, saved };
}

for (const oldName of P.OLD_ADDONS) {
  test(`migrateOldInstall: a ${oldName} install becomes ${P.ADDON} with every chat intact and the old folders gone`, () => {
    const dir = scratch(oldName);
    const { addons, saved } = fakeClient(dir, oldName);
    assert.ok(S.isClient(dir));

    S.migrateOldInstall(dir, 'ACCT#1');

    const newFile = path.join(saved, `${P.ADDON}.lua`);
    assert.ok(fs.existsSync(newFile), 'the new SavedVariables file exists');
    const src = fs.readFileSync(newFile, 'utf8');
    assert.match(src, new RegExp(`^${P.ADDON}DB = \\{`, 'm'), 'the chat DB global is renamed');
    assert.match(src, new RegExp(`^${P.ADDON}MapDB = \\{`, 'm'), 'the map DB global is renamed');
    assert.ok(!src.includes(`${oldName}DB`) && !src.includes(`${oldName}MapDB`), 'no old global is left');
    // The chats, their ids (what the bridge keys the agent sessions by), their
    // history and the settings are byte-for-byte what they were.
    const expected = oldSavedData(oldName).replace(`${oldName}DB =`, `${P.ADDON}DB =`).replace(`${oldName}MapDB =`, `${P.ADDON}MapDB =`);
    assert.equal(src, expected);
    for (const id of ['bad3474c10', '0ff1ce0001']) assert.ok(src.includes(`["id"] = "${id}"`), `chat ${id} came across`);
    assert.ok(src.includes('["text"] = "Yes. TL;DR: here."'));
    assert.ok(src.includes('["token"] = "sess-token-1"'), 'the restore token came across');
    // Nothing is deleted from SavedVariables: the old file and its .bak stay.
    assert.ok(fs.existsSync(path.join(saved, `${oldName}.lua`)));
    assert.ok(fs.existsSync(path.join(saved, `${oldName}.lua.bak`)));

    const left = fs.readdirSync(addons).sort();
    assert.deepEqual(left, ['SomeOtherAddon'], 'the old addon and its slot pool are removed, other addons are not');

    // Re-running is a no-op: the new file is kept as it is.
    fs.appendFileSync(newFile, '-- edited in game\n');
    S.migrateOldInstall(dir, 'ACCT#1');
    assert.ok(fs.readFileSync(newFile, 'utf8').endsWith('-- edited in game\n'));

    // copyAddon then puts the real addon in place under the new name.
    const { dest, copied } = S.copyAddon(dir);
    assert.equal(dest, path.join(addons, P.ADDON));
    assert.ok(copied >= 4);
    assert.ok(fs.existsSync(path.join(dest, `${P.ADDON}.toc`)));
    assert.match(fs.readFileSync(path.join(dest, `${P.ADDON}.toc`), 'utf8'), new RegExp(`^## SavedVariables: ${P.ADDON}DB, ${P.ADDON}MapDB$`, 'm'),
      'the .toc declares the globals the migrated file now holds');
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

test('migrateOldInstall: with both old names present the newer (WoWAI) saved data wins, and both addons go', () => {
  const dir = scratch('both');
  fakeClient(dir, 'WoWClaude', { slots: 2 });
  const { addons, saved } = fakeClient(dir, 'WoWAI', { slots: 2 });
  fs.writeFileSync(path.join(saved, 'WoWClaude.lua'), oldSavedData('WoWClaude').replace('You there', 'OLDER CHAT'));
  S.migrateOldInstall(dir, 'ACCT#1');
  const src = fs.readFileSync(path.join(saved, `${P.ADDON}.lua`), 'utf8');
  assert.ok(src.includes('You there') && !src.includes('OLDER CHAT'), 'WoWAI.lua was the source');
  assert.deepEqual(fs.readdirSync(addons).sort(), ['SomeOtherAddon']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('migrateOldInstall: nothing to migrate is a no-op, and a client without an AddOns folder does not throw', () => {
  const dir = scratch('none');
  fs.mkdirSync(path.join(dir, 'Interface'), { recursive: true });
  S.migrateOldInstall(dir, 'ACCT#1');
  assert.ok(!fs.existsSync(path.join(dir, 'WTF')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('upgradeConfig: paths naming an old addon are rewritten to the new one, other keys are kept', () => {
  const example = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'bridge', 'config.example.json'), 'utf8'));
  for (const oldName of P.OLD_ADDONS) {
    const cfg = {
      addonDir: '/Games/WoW/_classic_beta_/Interface/AddOns',
      inboxFile: `/Games/WoW/_classic_beta_/Interface/AddOns/${oldName}/Inbox.lua`,
      savedVariablesFile: `/Games/WoW/_classic_beta_/WTF/Account/A/SavedVariables/${oldName}.lua`,
      defaultCwd: '/code/x', slots: 200, agent: 'codex', agents: { codex: { model: 'm' } },
    };
    const notes = S.upgradeConfig(cfg, example);
    assert.deepEqual(notes.sort(), ['inboxFile', 'savedVariablesFile']);
    assert.equal(cfg.inboxFile, path.join(cfg.addonDir, P.ADDON, 'Inbox.lua'));
    assert.equal(cfg.savedVariablesFile, `/Games/WoW/_classic_beta_/WTF/Account/A/SavedVariables/${P.ADDON}.lua`);
    assert.equal(cfg.agent, 'codex');
    assert.deepEqual(cfg.agents, { codex: { model: 'm' } });
    // Windows spelling too.
    const win = { addonDir: 'C:\\WoW\\Interface\\AddOns', inboxFile: `C:\\WoW\\Interface\\AddOns\\${oldName}\\Inbox.lua`, savedVariablesFile: `C:\\WoW\\WTF\\Account\\A\\SavedVariables\\${oldName}.lua`, agents: {} };
    S.upgradeConfig(win, example);
    assert.ok(win.inboxFile.endsWith(path.join(P.ADDON, 'Inbox.lua')));
    assert.ok(win.savedVariablesFile.endsWith(`\\${P.ADDON}.lua`));
  }
  // A current config is left alone.
  const cfg = { addonDir: '/a', inboxFile: `/a/${P.ADDON}/Inbox.lua`, savedVariablesFile: `/s/${P.ADDON}.lua`, agents: {} };
  assert.deepEqual(S.upgradeConfig(cfg, example), []);
});

// The whole installer against a fake client, with CLAUDE_WOW_HOME pointing at a
// scratch folder so nothing on this machine is read or written: the old addon
// with real-shaped saved data goes in, ClaudeWoW with the same chats comes out,
// and the config lands in the home folder naming the new addon.
test('node setup.js --wow <fake client>: migrates the chats, installs ClaudeWoW and its slots, writes the config to CLAUDE_WOW_HOME', () => {
  const { spawnSync } = require('child_process');
  const dir = scratch('e2e');
  const client = path.join(dir, 'client');
  const home = path.join(dir, 'home');
  const project = path.join(dir, 'project');
  fs.mkdirSync(project, { recursive: true });
  const { addons, saved } = fakeClient(client, 'WoWAI', { slots: 5 });
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'setup.js'), '--wow', client, '--project', project], {
    encoding: 'utf8', env: { ...process.env, CLAUDE_WOW_HOME: home }, timeout: 120000,
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /migrate {2}: chats and settings copied from WoWAI\.lua to ClaudeWoW\.lua/);
  assert.match(r.stdout, /migrate {2}: removed the old WoWAI addon and slot folders \(6 folder\(s\)\)/);
  assert.match(r.stdout, new RegExp('home {5}: ' + home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  // The saved data: same chats, new globals.
  const src = fs.readFileSync(path.join(saved, 'ClaudeWoW.lua'), 'utf8');
  assert.equal(src, oldSavedData('WoWAI').replace('WoWAIDB =', 'ClaudeWoWDB =').replace('WoWAIMapDB =', 'ClaudeWoWMapDB ='));
  assert.ok(fs.existsSync(path.join(saved, 'WoWAI.lua')), 'the old saved file is kept');

  // The game folder: the new addon and its full slot pool, nothing of the old.
  const names = fs.readdirSync(addons);
  assert.ok(names.includes('ClaudeWoW') && names.includes('SomeOtherAddon'));
  assert.ok(!names.some(n => /^WoWAI/.test(n)), 'no WoWAI folder left');
  assert.equal(names.filter(n => /^ClaudeWoW_S\d{3}$/.test(n)).length, 200);
  assert.equal(fs.readFileSync(path.join(addons, 'ClaudeWoW_S001', 'Inbox.lua'), 'utf8'), 'ClaudeWoW_SlotData = nil\n');
  assert.match(fs.readFileSync(path.join(addons, 'ClaudeWoW_S001', 'ClaudeWoW_S001.toc'), 'utf8'), /^## Dependencies: ClaudeWoW$/m);
  assert.ok(fs.existsSync(path.join(addons, 'ClaudeWoW', 'ClaudeWoW.toc')));
  assert.ok(fs.existsSync(path.join(addons, 'ClaudeWoW', 'ctl', 'valid.wav')));
  for (const d of ['sig', 'ack', 'act', 'presence']) assert.ok(fs.statSync(path.join(addons, 'ClaudeWoW', d)).isDirectory(), d);

  // The config: in the home folder, naming the new addon; nothing in bridge/ was touched.
  const cfg = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  assert.equal(cfg.addonDir, addons);
  assert.equal(cfg.inboxFile, path.join(addons, 'ClaudeWoW', 'Inbox.lua'));
  assert.equal(cfg.savedVariablesFile, path.join(saved, 'ClaudeWoW.lua'));
  assert.equal(cfg.defaultCwd, project);
  assert.ok(!fs.existsSync(path.join(home, 'state.json')), 'an explicit CLAUDE_WOW_HOME is not filled from this checkout');
  // A new install is on the screenshot transport: python3 and the macOS
  // permissions are reported as the deprecated pixel fallback's business only.
  assert.equal(cfg.capture.mode, 'screenshot');
  assert.match(r.stdout, /^transport: screenshot \(the default\): the addon calls Screenshot\(\), the bridge reads the file; no screen capture, no permissions, no python$/m);
  if (process.platform !== 'win32') assert.match(r.stdout, /^python {3}: .*only the deprecated pixel-capture fallback needs it/m);
  if (process.platform === 'darwin') assert.match(r.stdout, /^capture {2}: screenshot transport, so no Screen Recording or Automation permission is needed/m);
  assert.ok(!/Screen Recording:|window access:|display scale:/.test(r.stdout), 'the pixel capture\'s permission checks are not run');
  assert.ok(!/check the capture with/.test(r.stdout), 'no probe to run either');

  // Run again with the config switched to the pixel transport by hand: nothing
  // to migrate, the config (and its explicit mode) kept, slots already present,
  // and the transport named as deprecated.
  cfg.capture.mode = 'pixel';
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(cfg, null, 2) + '\n');
  const again = spawnSync(process.execPath, [path.join(__dirname, '..', 'setup.js'), '--wow', client], {
    encoding: 'utf8', env: { ...process.env, CLAUDE_WOW_HOME: home }, timeout: 120000,
  });
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.ok(!/migrate/.test(again.stdout), 'second run migrates nothing');
  assert.match(again.stdout, /already exists, keeping it/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).capture.mode, 'pixel', 'an existing config keeps its explicit mode');
  assert.match(again.stdout, /^transport: pixel \(capture\.mode in config\.json\): DEPRECATED screen capture, kept only until Screenshot\(\) is confirmed on Windows and on Linux under Wine/m);
  if (process.platform !== 'win32') assert.match(again.stdout, /^python {3}: (?!.*only the deprecated)/m, 'on the pixel transport python is simply required');

  // And a config from before the mode existed (no capture.mode at all) is left
  // without one: the bridge's default, the screenshot transport, applies.
  delete cfg.capture.mode;
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(cfg, null, 2) + '\n');
  const third = spawnSync(process.execPath, [path.join(__dirname, '..', 'setup.js'), '--wow', client], {
    encoding: 'utf8', env: { ...process.env, CLAUDE_WOW_HOME: home }, timeout: 120000,
  });
  assert.equal(third.status, 0, third.stdout + third.stderr);
  assert.match(third.stdout, /^transport: screenshot \(the default\)/m);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).capture.mode, undefined, 'setup does not write a mode into an existing config');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('transportReport: the screenshot transport unless capture.mode says pixel, which is reported as deprecated', () => {
  const lines = [];
  const orig = console.log;
  console.log = (l) => lines.push(String(l));
  try {
    assert.equal(S.transportReport({}), 'screenshot');
    assert.equal(S.transportReport({ capture: { enabled: true } }), 'screenshot');
    assert.equal(S.transportReport({ capture: { mode: 'screenshot' } }), 'screenshot');
    assert.equal(S.transportReport({ capture: { mode: 'pixel' } }), 'pixel');
    assert.equal(S.transportReport({ capture: { mode: 'gif' } }), '', 'a bad mode: nothing said here, the bridge refuses it with the file name');
  } finally { console.log = orig; }
  assert.equal(lines.filter(l => /^transport: screenshot \(the default\)/.test(l)).length, 3);
  assert.equal(lines.filter(l => /^transport: pixel .*DEPRECATED/.test(l)).length, 1);
});
