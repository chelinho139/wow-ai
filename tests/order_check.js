// Every top-level `local` in the addon must be defined before any use of it.
// (A later local is invisible to earlier code: the use would hit a nil global.)
// Covers `local function X` and `local X = ...`; bare forward declarations
// (`local Finish`) are fine and are skipped.
'use strict';
const fs = require('fs');
const path = require('path');
const luaparse = require('luaparse');

const ADDON = process.argv[2] || path.join(__dirname, '..', 'addon', 'ClaudeWoW');
let bad = 0;
for (const f of ['Codec.lua', 'ClaudeWoW.lua', 'Inbox.lua', 'Map.lua', 'Roast.lua', 'Voice.lua', 'LootRoll.lua']) {
  const src = fs.readFileSync(path.join(ADDON, f), 'utf8');
  luaparse.parse(src, { luaVersion: '5.1' });
  console.log('OK   ' + f + ' parses');
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
