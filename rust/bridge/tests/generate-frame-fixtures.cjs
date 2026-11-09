// Development-only golden cells from the real addon encoder. No Rust encoder.
const fs = require('node:fs');
const path = require('node:path');
const {lua, lauxlib, lualib, to_luastring} = require('fengari');
const codec = fs.readFileSync(path.resolve(__dirname, '../../../addon/WoWAI/Codec.lua'), 'utf8');
const cases = [[7, 'session\x1fchat\x1f7\x1fC:\\My Project\x1fagent=codex\x1fname\x1fHello 世界 🐉'], [4242, 'long message '.repeat(200)], [65000, 'x'], [0, ''], [8, Buffer.from([255, 97])], [65535, 'x'.repeat(3200)]];
const rows = cases.map(([id, payload]) => {
  const L = lauxlib.luaL_newstate(); lualib.luaL_openlibs(L);
  const lit = '"' + [...Buffer.from(payload)].map(b => '\\' + String(b).padStart(3, '0')).join('') + '"';
  const code = `${codec}\nlocal cells = WoWAI_Codec.Encode(${id}, ${lit})\nlocal out = {} for i, v in ipairs(cells) do out[i] = string.format('%d', v) end RESULT = table.concat(out, ',')`;
  if (lauxlib.luaL_dostring(L, to_luastring(code)) !== lua.LUA_OK) throw Error(lua.lua_tojsstring(L, -1));
  lua.lua_getglobal(L, to_luastring('RESULT'));
  const cells = lua.lua_tojsstring(L, -1); lua.lua_close(L);
  return `${id}\t${Buffer.from(payload).toString('hex')}\t${cells}`;
});
fs.writeFileSync(path.join(__dirname, 'fixtures/frames.tsv'), rows.join('\n') + '\n');
