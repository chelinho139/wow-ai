'use strict';
// The plugin registry and routing: the part of the core that decides which
// plugin a message belongs to (docs/PLATFORM.md). A plugin is a named
// capability the bridge routes to. It declares:
//
//   id          "claude-code": lowercase letters, digits and dashes
//   label       shown in the banner and the logs (the addon shows the id)
//   aliases     other names a message may address it by: "@claude fix it"    [optional]
//   match(job)  whether a bare message on a chat bound to nothing is its      [optional]
//   tools       extra instructions appended to the system prompt              [optional]
//   surfaces    the core surfaces its replies may use: "map" (its runs may
//               mark the world map), "macro" (macro blocks become buttons)    [optional]
//   handle(job, core)  what to do with a message; `core` is what bridge.js
//               lends it (run the agent, fail the message, the bridge's folder)
//
// Routing, in order: an address at the start of the text ("@ask ..." or
// "/ask ..."), which is stripped; the chat's binding (the plugin= flag the
// addon sends, and --plugin for --inject); the first plugin whose match() says
// yes; the default. Pure: no I/O and no process state (tests/plugins_test.js).

const ID_RE = /^[a-z][a-z0-9-]*$/;

function normalizeId(id) {
  return String(id || '').trim().toLowerCase();
}

// A plugin with every optional field filled in, or an Error explaining what is wrong.
function normalizePlugin(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('a plugin must be an object');
  const id = normalizeId(raw.id);
  if (!ID_RE.test(id)) throw new Error(`plugin id "${raw.id}" must be lowercase letters, digits and dashes`);
  if (typeof raw.handle !== 'function') throw new Error(`plugin "${id}" has no handle(job, core) function`);
  const aliases = (Array.isArray(raw.aliases) ? raw.aliases : []).map(normalizeId).filter(a => ID_RE.test(a) && a !== id);
  return {
    ...raw,
    id,
    label: String(raw.label || id),
    aliases,
    match: typeof raw.match === 'function' ? raw.match : () => false,
    tools: String(raw.tools || ''),
    surfaces: Array.isArray(raw.surfaces) ? raw.surfaces.map(String) : [],
    searchesFiles: raw.searchesFiles === true,
  };
}

// "@ask what drops the sword" / "/claude fix the build" -> { name: "ask", text: "what drops the sword" }.
// Only the first word counts, it must be a bare name, and something must follow
// it: "@ask" alone, "@" or "/" are text.
const ADDRESS_RE = /^[@/]([a-z][a-z0-9-]*)\s+(?=\S)/i;
function parseAddress(text) {
  const m = ADDRESS_RE.exec(String(text || ''));
  if (!m) return null;
  return { name: m[1].toLowerCase(), text: String(text).slice(m[0].length) };
}

function createRegistry() {
  const plugins = new Map();
  const byName = new Map(); // id or alias -> id

  function register(raw) {
    const p = normalizePlugin(raw);
    if (plugins.has(p.id)) throw new Error(`plugin "${p.id}" is registered twice`);
    for (const name of [p.id, ...p.aliases]) {
      if (byName.has(name) && byName.get(name) !== p.id) throw new Error(`plugin name "${name}" is taken by "${byName.get(name)}"`);
    }
    plugins.set(p.id, p);
    for (const name of [p.id, ...p.aliases]) byName.set(name, p.id);
    return p;
  }

  // The plugin id a config value, flag or address names, or null when unknown.
  function normalize(name) {
    return byName.get(normalizeId(name)) || null;
  }

  const ids = () => [...plugins.keys()];
  const all = () => [...plugins.values()];
  const get = id => plugins.get(normalizeId(id)) || null;

  // Where a job goes. Returns { plugin, why, text } (text only when an address
  // was stripped from the job's text) or { error } when the job names a plugin
  // this bridge does not have.
  function route(job, opts = {}) {
    const fallback = opts.fallback ? normalize(opts.fallback) : null;
    const dflt = fallback || ids()[0] || null;
    if (!dflt) return { error: 'this bridge has no plugins' };
    const addr = parseAddress(job && job.text);
    if (addr && byName.has(addr.name)) return { plugin: plugins.get(byName.get(addr.name)), why: 'addressed', text: addr.text };
    const bound = job && job.plugin ? String(job.plugin) : '';
    if (bound) {
      const id = normalize(bound);
      if (!id) return { error: `Unknown plugin "${bound}". This bridge knows: ${ids().join(', ')}.` };
      return { plugin: plugins.get(id), why: 'bound' };
    }
    for (const p of plugins.values()) {
      let hit = false;
      try { hit = !!p.match(job); } catch { hit = false; }
      if (hit) return { plugin: p, why: 'matched' };
    }
    return { plugin: plugins.get(dflt), why: 'default' };
  }

  return { register, normalize, ids, all, get, route };
}

module.exports = { createRegistry, normalizePlugin, parseAddress, ID_RE };
