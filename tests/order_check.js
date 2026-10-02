// Every top-level `local` in the addon must be defined before any use of it.
// (A later local is invisible to earlier code: the use would hit a nil global.)
// Covers `local function X` and `local X = ...`; bare forward declarations
// (`local Finish`) are fine and are skipped.
'use strict';
const fs = require('fs');
const path = require('path');
const luaparse = require('luaparse');

const ADDON = process.argv[2] || path.join(__dirname, '..', 'addon', 'ClaudeWoW');
const MAIN_CHUNK_LOCALS_MAX = 190;
let bad = 0;

function mainChunkLocals(ast) {
  let n = 0;
  for (const s of ast.body) {
    if (s.type === 'LocalStatement') n += s.variables.length;
    else if (s.type === 'FunctionDeclaration' && s.isLocal) n += 1;
  }
  return n;
}

for (const f of ['Codec.lua', 'ClaudeWoW.lua', 'Inbox.lua', 'Map.lua', 'Roast.lua', 'Stream.lua', 'Voice.lua', 'LootRoll.lua', 'Achievements.lua', 'Orders.lua', 'DM.lua', 'Widgets.lua', 'Window.lua', 'Telemetry.lua', 'Observed.lua']) {
  const src = fs.readFileSync(path.join(ADDON, f), 'utf8');
  const ast = luaparse.parse(src, { luaVersion: '5.1' });
  const locals = mainChunkLocals(ast);
  if (locals > MAIN_CHUNK_LOCALS_MAX) {
    bad++;
    console.log(`TOO MANY LOCALS: ${f} has ${locals} main-chunk locals; Lua stops at 200, the budget is ${MAIN_CHUNK_LOCALS_MAX}. Fold constants into a table.`);
  }
  console.log('OK   ' + f + ' parses (' + locals + ' main-chunk locals)');
  // Blank out comments so a name mentioned in prose doesn't count as a use.
  const code = src.replace(/--\[\[[\s\S]*?\]\]|--[^\n]*/g, m => m.replace(/[^\n]/g, ' '));
  const forward = new Set([...code.matchAll(/^local (\w+)\s*$/gm)].map(m => m[1]));
  const defs = [
    ...[...code.matchAll(/^local function (\w+)/gm)].map(m => ({ name: m[1], at: m.index, kind: 'function' })),
    ...[...code.matchAll(/^local (\w+)\s*=/gm)].map(m => ({ name: m[1], at: m.index, kind: 'value' })),
  ];
  for (const d of defs) {
    if (forward.has(d.name)) continue;
    const use = d.kind === 'function'
      ? new RegExp('(?<![\\w.:])' + d.name + '\\s*\\(', 'g')
      : new RegExp('(?<![\\w.:])' + d.name + '(?![\\w])', 'g');
    for (const m of code.matchAll(use)) {
      if (m.index < d.at) {
        const line = code.slice(0, m.index).split('\n').length;
        bad++;
        console.log('USED BEFORE DEFINITION:', d.name, 'in', f, 'at line', line);
        break;
      }
    }
  }
}
console.log(bad ? '>>> ORDER FAIL' : '>>> ORDER PASS');
process.exit(bad ? 1 : 0);
