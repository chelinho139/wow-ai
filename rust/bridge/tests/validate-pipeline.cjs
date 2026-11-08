// Development-only end-to-end validation of the executable's actual private outbox.
const {execFileSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const {lua, lauxlib, lualib, to_luastring} = require('fengari');
const output = execFileSync('cargo', ['run', '--quiet', '--locked', '--', 'self-test'], {cwd: path.resolve(__dirname, '../../..'), encoding: 'utf8'});
const workspace = output.split(/\r?\n/).find(l => l.startsWith('Workspace: '))?.slice(11);
if (!workspace) throw Error('Missing self-test workspace');
try {
  const source = fs.readFileSync(path.join(workspace, 'data/outbox/WoWAI_S001/Inbox.lua'), 'utf8');
  const L = lauxlib.luaL_newstate(); lualib.luaL_openlibs(L);
  if (lauxlib.luaL_dostring(L, to_luastring(source + `
local r = WoWAI_SlotData.replies[1]
assert(r.id == 6 and r.agent == 'gemini' and r.status == 'done')
assert(r.text == 'Fake gemini reply: Hello from the Rust pipeline')
assert(r.session == 'fake-gemini-session')
assert(WoWAI_SlotData.restore == nil)
`)) !== lua.LUA_OK) throw Error(lua.lua_tojsstring(L, -1));
  console.log('Injected fake-agent pipeline generated valid Lua reply data.');
} finally { fs.rmSync(workspace, {recursive: true}); }
