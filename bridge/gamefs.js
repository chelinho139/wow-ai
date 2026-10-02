'use strict';
const fs = require('fs');
const path = require('path');
const { ADDON, RUNTIME_ADDON } = require('./protocol');

const GAME_MODE = 0o777;
const PERMISSION_BITS = 0o777;
const WORLD_WRITABLE = 0o002;
const ADDON_FOLDER = new RegExp(`^(${ADDON}(_S\\d{3})?|${RUNTIME_ADDON})$`);

const matchesGame = (platform = process.platform) => platform !== 'win32';

function openUp(target) {
  if (matchesGame()) fs.chmodSync(target, GAME_MODE);
}

function missingAncestors(dir) {
  const missing = [];
  let current = path.resolve(dir);
  while (!fs.existsSync(current)) {
    missing.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return missing;
}

function mkdir(dir) {
  const created = missingAncestors(dir);
  fs.mkdirSync(dir, { recursive: true });
  for (const d of created.reverse()) openUp(d);
}

function writeFile(file, content) {
  fs.writeFileSync(file, content);
  openUp(file);
}

function atomicWrite(file, content) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, content);
  openUp(tmp);
  fs.renameSync(tmp, file);
  openUp(file);
}

function ensureFile(file, content) {
  if (fs.existsSync(file)) return false;
  mkdir(path.dirname(file));
  writeFile(file, content);
  return true;
}

function remove(file) {
  try {
    fs.rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

function copyFile(from, to) {
  fs.copyFileSync(from, to);
  openUp(to);
}

function addonFolders(addonDir) {
  let names;
  try { names = fs.readdirSync(addonDir); } catch { return []; }
  return names.filter(n => ADDON_FOLDER.test(n)).sort().map(n => path.join(addonDir, n));
}

function walk(root, visit) {
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    let st;
    try { st = fs.lstatSync(current); } catch { continue; }
    if (st.isSymbolicLink()) continue;
    visit(current, st);
    if (!st.isDirectory()) continue;
    let entries;
    try { entries = fs.readdirSync(current); } catch { continue; }
    for (const name of entries) pending.push(path.join(current, name));
  }
}

function repair(addonDir) {
  const result = { checked: 0, fixed: 0, failed: [] };
  if (!matchesGame()) return result;
  for (const folder of addonFolders(addonDir)) {
    walk(folder, (target, st) => {
      result.checked++;
      if ((st.mode & PERMISSION_BITS) === GAME_MODE) return;
      try { fs.chmodSync(target, GAME_MODE); result.fixed++; } catch (e) { result.failed.push(`${target} (${e.code || e.message})`); }
    });
  }
  return result;
}

module.exports = { GAME_MODE, PERMISSION_BITS, WORLD_WRITABLE, ADDON_FOLDER, matchesGame, mkdir, writeFile, atomicWrite, ensureFile, remove, copyFile, addonFolders, repair };
