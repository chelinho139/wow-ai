// Compare native setup with the unchanged Node slot installer in isolated trees.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const repo = path.resolve(__dirname, '../../..');
const root = fs.mkdtempSync(path.join(os.tmpdir(),'reforged-install-'));
try {
  const native = path.join(root,'native'); const legacy = path.join(root,'legacy');
  fs.mkdirSync(native); fs.writeFileSync(path.join(native,'Wow.exe'),'fake client');
  const addons = path.join(legacy,'Interface','AddOns'); const addon = path.join(addons,'WoWAI');
  fs.mkdirSync(addon,{recursive:true});
  for (const name of ['WoWAI.toc','WoWAI.lua','Codec.lua','Map.lua','Inbox.lua']) {
    fs.copyFileSync(path.join(repo,'addon','WoWAI',name),path.join(addon,name));
  }
  const bridge = path.join(root,'bridge'); fs.mkdirSync(bridge);
  for (const name of ['install-slots.js','protocol.js']) fs.copyFileSync(path.join(repo,'bridge',name),path.join(bridge,name));
  fs.writeFileSync(path.join(bridge,'config.json'),JSON.stringify({addonDir:addons}));
  execFileSync(process.execPath,[path.join(bridge,'install-slots.js')]);
  execFileSync('cargo',['run','--quiet','--locked','--','setup','--wow',native],{cwd:repo});
  let compared=0;
  function compare(dir,relative='') {
    for (const entry of fs.readdirSync(dir,{withFileTypes:true})) {
      const name = path.join(relative,entry.name); const original = path.join(dir,entry.name);
      if (entry.isDirectory()) compare(original,name);
      else {
        const installed = path.join(native,'Interface','AddOns',name);
        assert.deepEqual(fs.readFileSync(installed),fs.readFileSync(original),name); compared++;
      }
    }
  }
  compare(addons);
  assert.equal(compared,14807);
  console.log(`Native setup matches ${compared} legacy addon/slot/signal files byte-for-byte.`);
} finally { fs.rmSync(root,{recursive:true,force:true}); }
