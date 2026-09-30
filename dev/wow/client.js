'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const fengari = require('fengari');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari;
const { assertSafe } = require('../sandbox');

const REPO = path.resolve(__dirname, '..', '..');
const STUB = path.join(REPO, 'tests', 'wow_stub.lua');
const PRELUDE = path.join(__dirname, 'prelude.lua');
const MAIN_ADDON = 'ClaudeWoW';

function luaQuote(s) {
  return '"' + [...Buffer.from(String(s), 'utf8')].map(b => '\\' + b).join('') + '"';
}

function crcChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}

function encodePng(width, height, rgb) {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    crcChunk('IHDR', ihdr), crcChunk('IDAT', zlib.deflateSync(raw, { level: 1 })), crcChunk('IEND', Buffer.alloc(0)),
  ]);
}

function encodeTga(width, height, rgb) {
  const head = Buffer.alloc(18);
  head[2] = 2;
  head.writeUInt16LE(width, 12); head.writeUInt16LE(height, 14);
  head[16] = 24; head[17] = 0x20;
  const body = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    body[i * 3] = rgb[i * 3 + 2]; body[i * 3 + 1] = rgb[i * 3 + 1]; body[i * 3 + 2] = rgb[i * 3];
  }
  return Buffer.concat([head, body]);
}

function scene(width, height, seed) {
  const rgb = Buffer.alloc(width * height * 3);
  let s = seed >>> 0 || 1;
  const rand = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 3;
      const n = rand() * 40;
      rgb[o] = Math.min(255, 30 + (x * 90) / width + n);
      rgb[o + 1] = Math.min(255, 50 + (y * 110) / height + n);
      rgb[o + 2] = Math.min(255, 40 + n);
    }
  }
  return rgb;
}

function shotName(date, ext) {
  const p = n => String(n).padStart(2, '0');
  return `WoWScrnShot_${p(date.getMonth() + 1)}${p(date.getDate())}${p(date.getFullYear() % 100)}_${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}.${ext}`;
}

class WowClient {
  constructor(sb, opts = {}) {
    this.sb = sb;
    this.opts = Object.assign({
      frameMs: 50,
      speed: 1,
      width: 1920,
      height: 1080,
      interface: 16001,
      loadOutOfDate: false,
      hasScreenshot: true,
      shotDelayMs: 120,
      failShots: false,
      seed: 7,
      disabled: [],
      fileIndex: 'launch',
      deletionVisible: true,
    }, opts);
    this.clientRoot = assertSafe(sb.client);
    this.L = null;
    this.timer = null;
    this.pendingEvents = [];
    this.log = [];
    this.sessions = 0;
    this.gameOffset = 0;
    this.background = null;
  }

  resolveGamePath(rel) {
    const clean = String(rel).replace(/\\/g, '/').replace(/^\/+/, '');
    const abs = path.resolve(this.clientRoot, clean);
    if (!abs.startsWith(this.clientRoot + path.sep)) return null;
    return abs;
  }

  indexAddons() {
    const dir = path.join(this.clientRoot, 'Interface', 'AddOns');
    const names = [];
    for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      if (fs.existsSync(path.join(dir, name, name + '.toc'))) names.push(name);
    }
    this.indexed = names;
    return names;
  }

  indexFiles() {
    const files = new Set();
    const pending = [path.join(this.clientRoot, 'Interface', 'AddOns')];
    while (pending.length) {
      const dir = pending.pop();
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) pending.push(full);
        else if (e.isFile()) files.add(full);
      }
    }
    this.fileIndex = this.opts.fileIndex === 'launch' ? files : null;
    return files;
  }

  visible(file) {
    let onDisk = false;
    try { onDisk = !!file && fs.statSync(file).isFile(); } catch { onDisk = false; }
    if (!this.fileIndex || !file) return onDisk;
    if (!this.fileIndex.has(file)) return false;
    return onDisk || this.opts.deletionVisible === false;
  }

  launch() {
    this.indexAddons();
    this.indexFiles();
    this.launchedAt = Date.now();
    this.boot();
    return this;
  }

  newState() {
    const L = lauxlib.luaL_newstate();
    lualib.luaL_openlibs(L);
    lua.lua_register(L, to_luastring('HOST_read'), S => {
      const file = this.resolveGamePath(to_jsstring(lauxlib.luaL_checkstring(S, 1)));
      let buf = null;
      try { buf = file ? fs.readFileSync(file) : null; } catch { buf = null; }
      if (buf) lua.lua_pushstring(S, Uint8Array.from(buf)); else lua.lua_pushnil(S);
      return 1;
    });
    lua.lua_register(L, to_luastring('HOST_exists'), S => {
      const file = this.resolveGamePath(to_jsstring(lauxlib.luaL_checkstring(S, 1)));
      lua.lua_pushboolean(S, this.visible(file));
      return 1;
    });
    return L;
  }

  runLua(code, name = '=dev') {
    const L = this.L;
    const bytes = typeof code === 'string' ? to_luastring(code) : Uint8Array.from(code);
    if (lauxlib.luaL_loadbuffer(L, bytes, null, to_luastring(name)) !== lua.LUA_OK) {
      const err = to_jsstring(lua.lua_tostring(L, -1)); lua.lua_pop(L, 1);
      throw new Error(`Lua load ${name}: ${err}`);
    }
    if (lua.lua_pcall(L, 0, 0, 0) !== lua.LUA_OK) {
      const err = to_jsstring(lua.lua_tostring(L, -1)); lua.lua_pop(L, 1);
      throw new Error(`Lua error ${name}: ${err}`);
    }
  }

  luaValue(expr) {
    this.runLua(`DEV_RESULT = (${expr}); if DEV_RESULT ~= nil then DEV_RESULT = tostring(DEV_RESULT) end`);
    const L = this.L;
    lua.lua_getglobal(L, to_luastring('DEV_RESULT'));
    const out = lua.lua_isnil(L, -1) ? null : to_jsstring(lua.lua_tolstring(L, -1));
    lua.lua_pop(L, 1);
    return out;
  }

  json(expr) {
    const s = this.luaValue(`DEV.Json(${expr})`);
    return s === null ? null : JSON.parse(s);
  }

  gameNow() {
    return this.gameOffset + ((Date.now() - this.launchedAt) / 1000) * this.opts.speed;
  }

  syncClock() {
    this.runLua(`DEV.now = ${this.gameNow().toFixed(3)}; DEV.epoch = ${Math.floor(Date.now() / 1000)}`);
  }

  savedNames() {
    const toc = fs.readFileSync(path.join(this.clientRoot, 'Interface', 'AddOns', MAIN_ADDON, MAIN_ADDON + '.toc'), 'utf8');
    const m = /^##\s*SavedVariables:\s*(.+)$/m.exec(toc);
    return m ? m[1].split(',').map(s => s.trim()).filter(Boolean) : [];
  }

  boot() {
    this.L = this.newState();
    this.sessions += 1;
    this.runLua(fs.readFileSync(STUB), '@wow_stub.lua');
    this.runLua(fs.readFileSync(PRELUDE), '@prelude.lua');
    const o = this.opts;
    this.runLua(`DEV.interface = ${Number(o.interface)}; DEV.loadOutOfDate = ${!!o.loadOutOfDate}; DEV.width = ${o.width}; DEV.height = ${o.height}`);
    this.runLua(`for _, n in ipairs({${this.indexed.map(luaQuote).join(',')}}) do DEV.indexed[n] = true end`);
    this.runLua(`for _, n in ipairs({${(o.disabled || []).map(luaQuote).join(',')}}) do DEV.disabled[n] = true end`);
    if (!o.hasScreenshot) this.runLua('Screenshot = nil');
    this.syncClock();
    this.runLua(`
      local src = HOST_read("Interface/AddOns/${MAIN_ADDON}/${MAIN_ADDON}.toc")
      assert(src, "the ${MAIN_ADDON} addon is not installed in the sandbox client")
      local _, files = DEV.ParseToc(src)
      for _, f in ipairs(files) do DEV.RunAddonFile("${MAIN_ADDON}", f) end
      DEV.loaded["${MAIN_ADDON}"] = true
    `, '@boot');
    if (fs.existsSync(this.sb.saved)) this.runLua(fs.readFileSync(this.sb.saved), '@SavedVariables');
    this.runLua(`DEV.Fire("ADDON_LOADED", "${MAIN_ADDON}")`);
    this.runLua('DEV.Fire("PLAYER_LOGIN")');
    this.runLua('DEV.Fire("PLAYER_ENTERING_WORLD", true, false)');
    this.note(`ui session ${this.sessions} started`);
  }

  note(line) {
    this.log.push({ at: Date.now(), line });
  }

  saveVariables() {
    const body = this.luaValue(`DEV.SerializeSaved({${this.savedNames().map(luaQuote).join(',')}})`);
    fs.mkdirSync(path.dirname(this.sb.saved), { recursive: true });
    if (fs.existsSync(this.sb.saved)) fs.copyFileSync(this.sb.saved, this.sb.saved + '.bak');
    fs.writeFileSync(assertSafe(this.sb.saved), body);
  }

  reload() {
    this.runLua('DEV.Fire("PLAYER_LOGOUT")');
    this.saveVariables();
    this.gameOffset = this.gameNow();
    this.launchedAt = Date.now();
    this.boot();
    this.note('reload');
  }

  quit({ crash = false } = {}) {
    this.stop();
    if (!crash) {
      this.runLua('DEV.Fire("PLAYER_LOGOUT")');
      this.saveVariables();
    }
    this.L = null;
    this.note(crash ? 'client crashed' : 'client quit');
  }

  start() {
    if (this.timer) return this;
    this.lastStep = Date.now();
    this.timer = setInterval(() => {
      try { this.step(); } catch (e) { this.note(`step error: ${e.message}`); this.fatal = e; }
    }, this.opts.frameMs);
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  step() {
    if (!this.L) return;
    const now = Date.now();
    const dt = ((now - this.lastStep) / 1000) * this.opts.speed;
    this.lastStep = now;
    this.syncClock();
    this.runLua(`DEV.RunFrame(${dt.toFixed(4)})`);
    this.takeShots();
    this.fireDueEvents();
    if (this.luaValue('DEV.reloadRequested') === 'true') this.reload();
  }

  takeShots() {
    const n = Number(this.luaValue('#DEV.shotQueue'));
    if (!n) return;
    const cells = this.luaValue('DEV.StripCells()') || '';
    this.runLua('DEV.shotQueue = {}');
    for (let i = 0; i < n; i++) {
      const fmt = String(this.luaValue('GetCVar("screenshotFormat")') || 'jpeg').toLowerCase();
      const ext = fmt === 'png' ? 'png' : fmt === 'tga' ? 'tga' : 'jpg';
      const file = path.join(this.sb.screenshots, shotName(new Date(), ext));
      if (this.opts.failShots) {
        this.pendingEvents.push({ at: Date.now() + this.opts.shotDelayMs, ev: 'SCREENSHOT_FAILED' });
        continue;
      }
      const { width, height } = this.opts;
      if (!this.background) this.background = scene(width, height, this.opts.seed);
      const rgb = Buffer.from(this.background);
      for (const c of cells.split(';').filter(Boolean)) {
        const [x, y, w, r, g, b, h] = c.split(',').map(Number);
        for (let yy = y; yy < Math.min(height, y + h); yy++) {
          for (let xx = x; xx < Math.min(width, x + w); xx++) {
            const o = (yy * width + xx) * 3;
            rgb[o] = r; rgb[o + 1] = g; rgb[o + 2] = b;
          }
        }
      }
      const data = ext === 'png' ? encodePng(width, height, rgb) : ext === 'tga' ? encodeTga(width, height, rgb) : Buffer.from('not a real jpeg');
      fs.writeFileSync(assertSafe(file), data);
      this.pendingEvents.push({ at: Date.now() + this.opts.shotDelayMs, ev: 'SCREENSHOT_SUCCEEDED' });
    }
  }

  fireDueEvents() {
    const now = Date.now();
    const due = this.pendingEvents.filter(e => e.at <= now);
    this.pendingEvents = this.pendingEvents.filter(e => e.at > now);
    for (const e of due) this.runLua(`DEV.Fire(${luaQuote(e.ev)})`);
  }

  send(text) {
    this.runLua(`ClaudeWoW.Send(${luaQuote(text)})`);
  }

  slash(line) {
    const m = /^\/(\S+)\s*(.*)$/.exec(String(line).trim());
    if (!m) throw new Error(`not a slash command: ${line}`);
    const key = m[1].toLowerCase() === 'claude' ? 'CLAUDE' : 'CLAUDEWOW';
    this.runLua(`SlashCmdList.${key}(${luaQuote(m[2])})`);
  }

  pressKey(key = 'SPACE') {
    this.runLua(`
      for _, f in ipairs(STUB.frames) do
        if f.shown ~= false and f.scripts.OnKeyDown then pcall(f.scripts.OnKeyDown, f, ${luaQuote(key)}) end
      end`);
  }

  setUiHidden(hidden) {
    this.runLua(hidden ? 'UIParent:Hide()' : 'UIParent:Show()');
  }

  prints() {
    return this.json('STUB.prints') || [];
  }

  errors() {
    return this.json('DEV.errors') || [];
  }

  db() {
    return this.json('ClaudeWoWDB');
  }

  activeChat() {
    return this.json('(function() for _, c in ipairs(ClaudeWoWDB.chats) do if c.id == ClaudeWoWDB.activeChat then return c end end return ClaudeWoWDB.chats[1] end)()');
  }

  connected() {
    return this.luaValue('ClaudeWoW.IsConnected()') === 'true';
  }

  lastSeq() {
    return Number(this.luaValue('ClaudeWoWDB.lastSeq'));
  }

  diag() {
    this.slash('/claude diag');
    const history = (this.activeChat() || {}).history || [];
    const last = [...history].reverse().find(m => m.role === 'system' && /^Diagnostics:/.test(m.text || ''));
    return last ? last.text : '';
  }

  async waitFor(pred, { timeoutMs = 30000, label = 'condition', everyMs = 50 } = {}) {
    const until = Date.now() + timeoutMs;
    for (;;) {
      if (this.fatal) throw this.fatal;
      const v = pred();
      if (v) return v;
      if (Date.now() > until) throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}`);
      await new Promise(r => setTimeout(r, everyMs));
    }
  }

  async connect(timeoutMs = 30000) {
    await this.waitFor(() => this.connected(), { timeoutMs, label: 'the addon to see the bridge' });
  }

  async say(text, { timeoutMs = 60000 } = {}) {
    await this.connect(timeoutMs);
    const id = this.lastSeq() + 1;
    this.send(text);
    const reply = await this.waitFor(() => {
      const c = this.activeChat();
      if (!c || c.pendingId) return null;
      return (c.history || []).find(m => m.id === id && m.role !== 'user') || null;
    }, { timeoutMs, label: `the reply to #${id}` });
    return { id, ...reply };
  }
}

module.exports = { WowClient, encodePng, encodeTga, shotName, luaQuote };
