'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');
const P = require('../bridge/protocol');
const S = require('../bridge/service');
const Checks = require('../dev/doctor/checks');

const ROOT = path.join(__dirname, '..');
const ADDON = path.join(ROOT, 'addon', 'ClaudeWoW');
const TOC_VERSION = /^##\s*Version:\s*(\S+)/m.exec(fs.readFileSync(path.join(ADDON, 'ClaudeWoW.toc'), 'utf8'))[1];
const PACKAGE_VERSION = require('../package.json').version;

const LOAD_COUNTER_STUB = `
STUB.loads = 0
local plainLoad = C_AddOns.LoadAddOn
C_AddOns.LoadAddOn = function(name)
  STUB.loads = STUB.loads + 1
  return plainLoad(name)
end
`;

function newVM({ prelude = '', beforeLogin = '' } = {}) {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const run = code => {
    if (lauxlib.luaL_loadstring(L, to_luastring(code)) !== lua.LUA_OK) throw new Error('Lua load: ' + to_jsstring(lua.lua_tostring(L, -1)));
    if (lua.lua_pcall(L, 0, 0, 0) !== lua.LUA_OK) throw new Error('Lua error: ' + to_jsstring(lua.lua_tostring(L, -1)));
  };
  const evaluate = expr => {
    run(`local v = (${expr}); if v == nil then RESULT = nil else RESULT = tostring(v) end`);
    lua.lua_getglobal(L, to_luastring('RESULT'));
    const s = lua.lua_isnil(L, -1) ? null : to_jsstring(lua.lua_tolstring(L, -1));
    lua.lua_pop(L, 1);
    return s;
  };
  run(fs.readFileSync(path.join(__dirname, 'wow_stub.lua'), 'utf8'));
  run(LOAD_COUNTER_STUB);
  if (prelude) run(prelude);
  for (const f of ['Codec.lua', 'Inbox.lua', 'ClaudeWoW.lua']) run(fs.readFileSync(path.join(ADDON, f), 'utf8'));
  run('STUB.FireEvent("ADDON_LOADED", "ClaudeWoW")');
  if (beforeLogin) run(beforeLogin);
  run('STUB.FireEvent("PLAYER_LOGIN")');
  return { run, evaluate, num: expr => Number(evaluate(expr)) };
}

const luaBridge = b => (b ? `, bridge = { version = "${b.version}", protoMin = ${b.protoMin}, protoMax = ${b.protoMax} }` : '');

function helloPoll(vm, bridge, nowLua = 'time()') {
  vm.run('STUB.RunTimers()');
  const before = vm.num('STUB.loads');
  vm.run(`STUB.onLoadAddOn = function(name) ClaudeWoW_SlotData = { now = ${nowLua}, cwd = "", replies = {}${luaBridge(bridge)} } end`);
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.ok(vm.num('STUB.loads') > before, 'the hello poll read a slot');
}

function slotPoll(vm, bridge, nowLua = 'time()') {
  const before = vm.num('STUB.loads');
  vm.run(`STUB.onLoadAddOn = function(name) ClaudeWoW_SlotData = { now = ${nowLua}, cwd = "", replies = {}${luaBridge(bridge)} } end`);
  vm.run('STUB.now = STUB.now + 601; STUB.Tick()');
  assert.equal(vm.num('STUB.loads'), before + 1, 'the idle poll read one slot');
}

function told(vm, needle) {
  vm.run(`STUB.found = 0; for _, c in ipairs(ClaudeWoWDB.chats) do for _, m in ipairs(c.history) do if m.role == "system" and m.text:find(${JSON.stringify(needle)}, 1, true) then STUB.found = STUB.found + 1 end end end`);
  return vm.num('STUB.found');
}

const bridgeAt = (version, protoMin = P.PROTO_MIN, protoMax = P.PROTO_MAX) => ({ version, protoMin, protoMax });

test('the fallback version constant equals the toc and package.json versions', () => {
  const vm = newVM();
  assert.equal(vm.evaluate('ClaudeWoW.Version.SEMVER'), TOC_VERSION);
  assert.equal(TOC_VERSION, PACKAGE_VERSION);
  assert.equal(vm.num('ClaudeWoW.Version.PROTO'), P.PROTO, 'the addon and the bridge ship the same protocol number');
});

test('the addon reads its version from the toc metadata and falls back to the constant', () => {
  const vm = newVM({ prelude: 'STUB.addonMeta = { ClaudeWoW = { Version = "9.8.7" } }' });
  assert.equal(vm.evaluate('ClaudeWoW.Version.Own()'), '9.8.7');
  vm.run('STUB.addonMeta = nil');
  assert.equal(vm.evaluate('ClaudeWoW.Version.Own()'), TOC_VERSION);
  vm.run('STUB.addonMeta = { ClaudeWoW = { Version = "@project-version@" } }');
  assert.equal(vm.evaluate('ClaudeWoW.Version.Own()'), TOC_VERSION, 'an unreplaced packager token is not a version');
  vm.run('C_AddOns.GetAddOnMetadata = function() error("no metadata") end');
  assert.equal(vm.evaluate('ClaudeWoW.Version.Own()'), TOC_VERSION, 'an error in the metadata call falls back');
});

test('the hello carries ver= and proto=, and the bridge parses them from the same flags', () => {
  const flags = `h;ver=${TOC_VERSION};proto=${P.PROTO};c`;
  const job = P.jobsFromStrip(1, ['s1', 'c1', '7', '', flags, 'Chat 1', '', ''].join('\x1F'))[0];
  assert.equal(job.hello, true);
  assert.equal(job.addonVersion, TOC_VERSION);
  assert.equal(job.addonProto, P.PROTO);
  assert.equal(job.text, '');
});

test('a reload-mode message carries ver= and proto= in its outbox, so the bridge judges a session that never says hello', () => {
  const vm = newVM({ beforeLogin: `ClaudeWoW.Version.PROTO = ${P.PROTO + 1}` });
  vm.run('SlashCmdList.CLAUDE("config mode reload")');
  vm.run('ClaudeWoW.Send("via reload")');
  const out = name => vm.evaluate(`ClaudeWoWDB.outbox.${name}`);
  const saved = `ClaudeWoWDB = { ["outbox"] = { ["id"] = ${out('id')}, ["session"] = "${out('session')}", ["chat"] = "${out('chat')}", ["text"] = "${out('text')}", ["opts"] = "${out('opts')}" } }`;
  const job = P.parseOutbox(saved);
  assert.equal(job.addonVersion, TOC_VERSION);
  assert.equal(job.addonProto, P.PROTO + 1);
  assert.equal(job.text, 'via reload');
  const state = {};
  assert.equal(P.addonRefusal(state, job), '', 'no record yet');
  P.noteAddonVersion(state, job);
  assert.match(P.addonRefusal(state, job), /The bridge \(.*\) is too old for this addon/);
});

test('a version with a prerelease and build metadata is accepted on both sides', () => {
  const v = '0.4.0-beta.1+build.2';
  assert.equal(P.parseFlags(`h;ver=${v}`).addonVersion, v);
  assert.equal(P.bridgeInfo(v).version, v);
  const vm = newVM({ prelude: `STUB.addonMeta = { ClaudeWoW = { Version = "${v}" } }` });
  assert.equal(vm.evaluate('ClaudeWoW.Version.Own()'), v);
});

test('bad ver= and proto= values are dropped, and an unknown token on a hello is ignored', () => {
  const f = P.parseFlags('h;ver=1.2;proto=0;zz=9');
  assert.equal(f.hello, true);
  assert.equal(f.addonVersion, undefined);
  assert.equal(f.addonProto, undefined);
  assert.equal(P.parseFlags('h;proto=x1').addonProto, undefined);
  assert.equal(P.parseFlags('h;ver=1.2.3;bad').addonVersion, '1.2.3');
});

test('every slot file carries the bridge version and protocol range, and none without it', () => {
  const body = P.luaTable('ClaudeWoW_SlotData', [], { now: 1000, bridge: bridgeAt('1.2.3', 2, 3) });
  assert.match(body, /\tbridge = \{ version = "1\.2\.3", protoMin = 2, protoMax = 3 \},/);
  assert.doesNotMatch(P.luaTable('ClaudeWoW_SlotData', [], { now: 1000 }), /bridge = /);
  const info = P.bridgeInfo();
  assert.equal(info.version, PACKAGE_VERSION);
  assert.equal(info.protoMin, P.PROTO_MIN);
  assert.equal(info.protoMax, P.PROTO_MAX);
});

test('verdicts: equal, the older side by semver, different builds, either side out of the protocol range, and an old addon', () => {
  const b = bridgeAt('1.4.0', 2, 3);
  const cases = [
    [{ version: '1.4.0', proto: 2 }, 'equal', false],
    [{ version: '1.3.9', proto: 2 }, 'addon-older', false],
    [{ version: '1.10.0', proto: 3 }, 'bridge-older', false],
    [{ version: '1.4.0-beta', proto: 2 }, 'differs', false],
    [{ version: '1.4.0', proto: 1 }, 'update-addon', true],
    [{ version: '1.4.0', proto: 4 }, 'update-bridge', true],
    [{ version: '', proto: null }, 'update-addon', true],
  ];
  for (const [addon, verdict, refuse] of cases) {
    const v = P.versionVerdict(addon, b);
    assert.equal(v.verdict, verdict, JSON.stringify(addon));
    assert.equal(v.refuse, refuse, JSON.stringify(addon));
    assert.equal(v.text === '', verdict === 'equal', JSON.stringify(addon));
  }
  assert.equal(P.versionVerdict({ version: '', proto: null }, bridgeAt('1.4.0', 1, 1)).verdict, 'unknown', 'an addon from before the handshake speaks protocol 1');
  assert.match(P.versionVerdict({ version: '1.4.0', proto: 1 }, b).text, /CurseForge.*claude-wow setup.*restart WoW/);
  assert.match(P.versionVerdict({ version: '1.4.0', proto: 4 }, b).text, /brew upgrade claude-wow.*claude-wow service restart/);
});

test('the addon says the same words as the bridge for every verdict', () => {
  const cases = [
    [bridgeAt(TOC_VERSION), 'equal'],
    [bridgeAt('99.0.0'), 'addon-older'],
    [bridgeAt('0.0.1'), 'bridge-older'],
    [bridgeAt(TOC_VERSION + '-dev'), 'differs'],
    [bridgeAt(TOC_VERSION, P.PROTO + 1, P.PROTO + 2), 'update-addon'],
  ];
  const vm = newVM();
  for (const [b, verdict] of cases) {
    vm.run(`STUB.v, STUB.t = ClaudeWoW.Version.Verdict({ version = "${b.version}", protoMin = ${b.protoMin}, protoMax = ${b.protoMax} })`);
    const js = P.versionVerdict({ version: TOC_VERSION, proto: P.PROTO }, b);
    assert.equal(js.verdict, verdict);
    assert.equal(vm.evaluate('STUB.v'), js.verdict, b.version);
    assert.equal(vm.evaluate('STUB.t'), js.text, b.version);
  }
  vm.run('ClaudeWoW.Version.PROTO = 5');
  vm.run('STUB.v, STUB.t = ClaudeWoW.Version.Verdict({ version = "1.0.0", protoMin = 1, protoMax = 4 })');
  const js = P.versionVerdict({ version: TOC_VERSION, proto: 5 }, bridgeAt('1.0.0', 1, 4));
  assert.equal(vm.evaluate('STUB.v'), 'update-bridge');
  assert.equal(vm.evaluate('STUB.t'), js.text);
});

test('the bridge refuses a session whose hello is outside its protocol range and runs the rest', () => {
  const state = {};
  const b = bridgeAt('1.4.0', 2, 3);
  P.noteAddonVersion(state, { session: 'old', addonVersion: '1.0.0', addonProto: 1 }, b, 1);
  P.noteAddonVersion(state, { session: 'new', addonVersion: '2.0.0', addonProto: 4 }, b, 2);
  P.noteAddonVersion(state, { session: 'ok', addonVersion: '1.3.0', addonProto: 3 }, b, 3);
  P.noteAddonVersion(state, { session: 'legacy' }, b, 4);
  assert.match(P.addonRefusal(state, { session: 'old' }, b), /This addon \(1\.0\.0, protocol 1\) is too old for the bridge \(1\.4\.0, protocol 2 to 3\)/);
  assert.match(P.addonRefusal(state, { session: 'new' }, b), /The bridge \(1\.4\.0, protocol 2 to 3\) is too old for this addon \(2\.0\.0, protocol 4\)/);
  assert.equal(P.addonRefusal(state, { session: 'ok' }, b), '', 'only semver differs: no refusal');
  assert.match(P.addonRefusal(state, { session: 'legacy' }, b), /version unknown, protocol 1/, 'an addon without the token is protocol 1');
  assert.equal(P.addonRefusal(state, { session: 'never-said-hello' }, b), '', 'no hello on record: no refusal');
  assert.equal(P.addonRefusal(state, { session: 'old' }, bridgeAt('1.5.0', 1, 3)), '', 'a widened bridge re-judges the stored hello');
  assert.equal(state.addons.legacy.proto, null);
});

test('the hello record says when it changed, and keeps at most the newest sessions', () => {
  const state = {};
  const b = bridgeAt('1.4.0', 1, 1);
  assert.equal(P.noteAddonVersion(state, { session: 's', addonVersion: '1.4.0', addonProto: 1 }, b, 1).changed, true);
  assert.equal(P.noteAddonVersion(state, { session: 's', addonVersion: '1.4.0', addonProto: 1 }, b, 2).changed, false);
  assert.equal(P.noteAddonVersion(state, { session: 's', addonVersion: '1.4.1', addonProto: 1 }, b, 3).changed, true);
  for (let i = 0; i < P.ADDON_VERSIONS_MAX + 4; i++) P.noteAddonVersion(state, { session: 'x' + i, addonVersion: '1.4.0', addonProto: 1 }, b, 10 + i);
  assert.equal(Object.keys(state.addons).length, P.ADDON_VERSIONS_MAX);
  assert.ok(state.addons['x' + (P.ADDON_VERSIONS_MAX + 3)], 'the newest is kept');
  assert.equal(state.addons.s, undefined, 'the oldest is dropped');
});

test('service status and the doctor show both versions and the verdict of the last hello', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-wow-versions-'));
  try {
    const state = {};
    P.noteAddonVersion(state, { session: 's', addonVersion: '0.3.0', addonProto: 9 }, bridgeAt('0.4.0', 1, 1), Date.UTC(2026, 9, 2));
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
    const lines = [];
    S.status({ run: dir, logs: dir, definition: path.join(dir, 'none.plist') }, 'darwin', l => lines.push(l), path.join(dir, 'state.json'));
    const line = lines.find(l => l.startsWith('  versions  :'));
    assert.match(line, /addon 0\.3\.0 \(protocol 9\), bridge 0\.4\.0 \(protocol 1\): update-bridge, at the last hello 2026-10-02T00:00:00\.000Z/);
    assert.match(line, new RegExp(`this install is bridge ${PACKAGE_VERSION.replace(/\./g, '\\.')}`));
    const r = Checks.checkVersions({ state });
    assert.equal(r.status, 'fail');
    assert.match(r.summary, /update-bridge/);
    assert.match(r.problems[0].what, /The bridge \(0\.4\.0, protocol 1\) is too old for this addon/);
    const fine = {};
    P.noteAddonVersion(fine, { session: 's', addonVersion: '0.4.0', addonProto: 1 }, bridgeAt('0.4.0', 1, 1), 5);
    assert.equal(Checks.checkVersions({ state: fine }).status, 'ok');
    assert.equal(Checks.checkVersions({ state: {} }).summary, `no hello with versions yet; this install is bridge ${PACKAGE_VERSION} (protocol ${P.PROTO})`);
    for (const at of ['yesterday', 1e20, undefined]) {
      assert.match(P.versionsSummary({ addons: { s: { ...fine.addons.s, at } } }), /: equal$/, `a bad time (${at}) in state.json does not throw`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('equal versions on the hello poll: silent, and diag shows both and the verdict', () => {
  const vm = newVM();
  helloPoll(vm, bridgeAt(TOC_VERSION));
  assert.equal(vm.evaluate('ClaudeWoW.IsConnected()'), 'true');
  assert.equal(told(vm, 'older than'), 0);
  assert.equal(told(vm, 'too old'), 0);
  vm.run('SlashCmdList.CLAUDEWOW("diag")');
  assert.equal(told(vm, `versions: addon ${TOC_VERSION} (protocol ${P.PROTO}), bridge ${TOC_VERSION} (protocol ${P.PROTO}), verdict: equal`), 1);
});

test('only semver differs: one soft line per session over many slot reads', () => {
  const vm = newVM();
  helloPoll(vm, bridgeAt('99.0.0'));
  slotPoll(vm, bridgeAt('99.0.0'));
  slotPoll(vm, bridgeAt('99.0.0'));
  assert.equal(told(vm, `This addon (${TOC_VERSION}) is older than the bridge (99.0.0). They still work together`), 1);
});

test('a bridge whose protocol range is above the addon: the addon is told to update, once', () => {
  const vm = newVM();
  helloPoll(vm, bridgeAt(TOC_VERSION, P.PROTO + 1, P.PROTO + 1));
  slotPoll(vm, bridgeAt(TOC_VERSION, P.PROTO + 1, P.PROTO + 1));
  assert.equal(told(vm, 'is too old for the bridge'), 1);
  assert.equal(told(vm, 'CurseForge app or run claude-wow setup'), 1);
});

test('an addon whose protocol is above the bridge: the bridge is named as the side to update, once', () => {
  const vm = newVM({ prelude: '' , beforeLogin: `ClaudeWoW.Version.PROTO = ${P.PROTO + 1}` });
  helloPoll(vm, bridgeAt(TOC_VERSION));
  slotPoll(vm, bridgeAt(TOC_VERSION));
  assert.equal(told(vm, `The bridge (${TOC_VERSION}, protocol ${P.PROTO}) is too old for this addon`), 1);
  assert.equal(told(vm, 'brew upgrade claude-wow'), 1);
});

test('an old bridge with no bridge field: nothing said, nothing changed', () => {
  const vm = newVM();
  helloPoll(vm, null);
  assert.equal(vm.evaluate('ClaudeWoW.IsConnected()'), 'true');
  vm.run('SlashCmdList.CLAUDEWOW("diag")');
  assert.equal(told(vm, 'bridge not reported (an older bridge, or not heard yet), verdict: unknown'), 1);
  const later = newVM();
  helloPoll(later, bridgeAt('99.0.0'));
  slotPoll(later, null);
  later.run('SlashCmdList.CLAUDEWOW("diag")');
  assert.equal(told(later, 'bridge 99.0.0 (protocol 1), verdict: addon-older'), 1, 'a slot without the field keeps the last verdict');
});

test('a stale slot read skips the bridge field', () => {
  const vm = newVM();
  helloPoll(vm, bridgeAt('99.0.0'), 'time() - 600');
  assert.equal(told(vm, 'older than the bridge'), 0);
  vm.run('SlashCmdList.CLAUDEWOW("diag")');
  assert.equal(told(vm, 'verdict: unknown'), 1);
});

test('Inbox.lua carries the field too, under the 5-minute age rule', () => {
  const fresh = newVM({ beforeLogin: `ClaudeWoW_Inbox = { now = time() - 120, replies = {}${luaBridge(bridgeAt('99.0.0'))} }` });
  assert.equal(told(fresh, 'older than the bridge (99.0.0)'), 1);
  const stale = newVM({ beforeLogin: `ClaudeWoW_Inbox = { now = time() - 3600, replies = {}${luaBridge(bridgeAt('99.0.0'))} }` });
  assert.equal(told(stale, 'older than the bridge'), 0);
  for (const now of ['', 'now = "soon", ']) {
    const undated = newVM({ beforeLogin: `ClaudeWoW_Inbox = { ${now}replies = {}${luaBridge(bridgeAt('99.0.0'))} }` });
    assert.equal(told(undated, 'older than the bridge'), 0, `an inbox with ${now || 'no now'} is skipped`);
  }
});

test('a malformed bridge field is ignored, guard by guard', () => {
  const good = newVM({ beforeLogin: `ClaudeWoW_Inbox = { now = time(), replies = {}, bridge = { version = "99.0.0", protoMin = ${P.PROTO}, protoMax = ${P.PROTO} } }` });
  assert.equal(told(good, 'older than the bridge'), 1, 'the well-formed field is read');
  const cases = {
    'a version that is not semver': `version = "x", protoMin = ${P.PROTO}, protoMax = ${P.PROTO}`,
    'a version longer than 40 characters': `version = "99.0.0-${'a'.repeat(35)}", protoMin = ${P.PROTO}, protoMax = ${P.PROTO}`,
    'protoMin below 1': `version = "99.0.0", protoMin = 0, protoMax = ${P.PROTO}`,
    'protoMax below protoMin': `version = "99.0.0", protoMin = ${P.PROTO + 1}, protoMax = ${P.PROTO}`,
    'a fractional protoMin': `version = "99.0.0", protoMin = ${P.PROTO + 0.5}, protoMax = ${P.PROTO + 1}`,
    'a fractional protoMax': `version = "99.0.0", protoMin = ${P.PROTO}, protoMax = ${P.PROTO + 0.5}`,
    'no protoMax': `version = "99.0.0", protoMin = ${P.PROTO}`,
    'no protoMin': `version = "99.0.0", protoMax = ${P.PROTO}`,
    'a non-numeric protoMin': `version = "99.0.0", protoMin = "one", protoMax = ${P.PROTO}`,
    'a version that is a number': `version = 99, protoMin = ${P.PROTO}, protoMax = ${P.PROTO}`,
    'no version': `protoMin = ${P.PROTO}, protoMax = ${P.PROTO}`,
  };
  for (const [name, fields] of Object.entries(cases)) {
    const vm = newVM({ beforeLogin: `ClaudeWoW_Inbox = { now = time(), replies = {}, bridge = { ${fields} } }` });
    assert.equal(told(vm, 'bridge'), 0, name);
    vm.run('SlashCmdList.CLAUDEWOW("diag")');
    assert.equal(told(vm, 'verdict: unknown'), 1, name);
  }
  const longest = '9999.9999.9999-' + 'a'.repeat(24);
  assert.ok(P.SEMVER_RE.test(longest));
  assert.ok(!P.SEMVER_RE.test(longest + 'a'));
  assert.ok(longest.length <= 40, 'every version the bridge accepts fits the addon cap');
});

test('the verdict rides on the hello poll: no slot load of its own', () => {
  const counts = [null, bridgeAt('99.0.0')].map(b => {
    const vm = newVM();
    helloPoll(vm, b);
    slotPoll(vm, b);
    return vm.num('STUB.loads');
  });
  assert.ok(counts[0] > 0, 'the load counter is installed');
  assert.equal(counts[1], counts[0]);
});
