// Development-only round trip through a Lua VM; no Node dependency at runtime.
const {execFileSync} = require('node:child_process');
const {lua, lauxlib, lualib, to_luastring} = require('fengari');
const path = require('node:path');
const source = execFileSync('cargo', ['run', '--quiet', '--locked', '--example', 'slot_fixture'], {cwd: path.resolve(__dirname, '../../..'), encoding: 'utf8'});
const L = lauxlib.luaL_newstate();
lualib.luaL_openlibs(L);
const assertions = `
local d = WoWAI_SlotData
assert(d.now == 1700000000 and d.agent == 'codex')
assert(#d.agents == 6 and #d.replies == 3)
assert(d.replies[1].status == 'working')
assert(d.replies[2].status == 'done' and d.replies[2].summary == 'short reply')
assert(d.replies[3].status == 'error' and d.replies[3].denied[2] == 'Bash(git:*)')
assert(d.replies[1].text == 'Hello 世界 🐉\\n"quoted" \\\\ \\000')
assert(d.restore == nil and d.map == nil)
`;
if (lauxlib.luaL_dostring(L, to_luastring(source + assertions)) !== lua.LUA_OK) {
  throw new Error(lua.lua_tojsstring(L, -1));
}
console.log('Rust slot output loaded and verified in Lua VM.');
