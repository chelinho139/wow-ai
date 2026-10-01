'use strict';

const G = require('./goals');
const GR = require('./gamerefs');
const OB = require('./observed');

const TOOL = Object.freeze({ farm: 'farm_spot_lookup', price: 'market_price', route: 'route_draw' });
const TOOL_NAMES = Object.freeze(Object.values(TOOL));
const WRITE_TOOL_NAMES = Object.freeze([TOOL.route]);
const ROUTE_LAYER = 'claude-route';
const ROUTE_POINTS_MAX = 40;
const ROUTE_POINT_KIND = 'poi';
const SPOTS_PER_SOURCE_MAX = 3;
const SOURCES_SHOWN_MAX = 8;
const MODEL_TRUST = 'model';
const NO_NAME_SOURCE = 'no verified name source';

function fail(text) {
  return { ok: false, text };
}

function done(value) {
  return { ok: true, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) };
}

function itemIdArg(args) {
  const raw = args.itemID;
  const n = typeof raw === 'number' ? raw : (typeof raw === 'string' && /^\d{1,9}$/.test(raw.trim()) ? Number(raw.trim()) : NaN);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function resolveOne(store, token) {
  const r = GR.createExpander(store).expand(token);
  if (!r.ok) return { error: GR.errorsText(r.errors, store) };
  return { ref: r.refs[0] };
}

function itemRef(store, itemID) {
  const r = resolveOne(store, `{item:${itemID}}`);
  if (r.error) return r;
  return { item: { ref: `{item:${itemID}}`, id: r.ref.id, name: r.ref.name, trust: r.ref.trust, build: r.ref.build } };
}

function observedPoint(store, spot, notes) {
  if (spot.x === null || spot.y === null) {
    const r = resolveOne(store, `{map:${spot.mapID},0,0}`);
    if (r.error) { notes.add(`map ${spot.mapID} is not in the game data, so ${spot.n} sample(s) there are left out`); return null; }
    return { map: { ref: null, id: r.ref.id, name: r.ref.name, trust: r.ref.trust }, point: null, n: spot.n };
  }
  const token = `{map:${spot.mapID},${spot.x},${spot.y}}`;
  const r = resolveOne(store, token);
  if (r.error) { notes.add(`map ${spot.mapID} is not in the game data, so ${spot.n} sample(s) there are left out`); return null; }
  return { map: { ref: token, id: r.ref.id, name: r.ref.name, trust: r.ref.trust }, point: { x: spot.x, y: spot.y, trust: OB.TRUST }, n: spot.n };
}

function sourceView(source) {
  return { type: source.type, id: source.id, spell: source.spell || null, ref: null, name: null, nameNote: NO_NAME_SOURCE };
}

function farmView(store, item, lines, minSamples, asOfContext) {
  const { shown, hidden } = OB.dropRates(lines, item.id, minSamples);
  const notes = new Set();
  const sources = shown.slice(0, SOURCES_SHOWN_MAX).map(row => ({
    source: sourceView(row.source),
    trust: OB.TRUST,
    n: row.n,
    k: row.k,
    rate: row.rate,
    perLoot: row.perLoot,
    asOf: row.asOf,
    spots: row.spots.slice(0, SPOTS_PER_SOURCE_MAX).map(s => observedPoint(store, s, notes)).filter(Boolean),
  }));
  const out = {
    item,
    asOf: sources.length ? Math.max(...sources.map(s => s.asOf)) : null,
    contextAsOf: asOfContext,
    minSamples,
    sources,
    hidden: hidden.map(h => ({ source: sourceView(h.source), n: h.n })),
    notes: [
      'Rates are per loot window the player opened, for one source each; sources are never added together. A kill with no loot window is not counted. A source the player looted often without this item shows rate 0.',
      'Each spot is one real loot position, the most central of the samples on that map.',
      `Sources with fewer than ${minSamples} loot windows show no rate.`,
      'NPC and object names have no verified source yet: name a source only by what the player sees, never from memory.',
      ...notes,
    ],
  };
  if (!sources.length) out.notes.unshift(hidden.length ? 'Not enough observed loot yet to give a rate for this item.' : 'No observed loot of this item yet. Say you do not know.');
  return out;
}

function priceView(store, item, lines, asOfContext) {
  const { ah, vendors } = OB.prices(lines, item.id);
  const notes = new Set();
  const vendorRows = vendors.map(v => {
    const placed = v.mapID ? observedPoint(store, { mapID: v.mapID, x: null, y: null, n: v.n }, notes) : null;
    return { npc: sourceView({ type: 'npc', id: v.npcID, spell: 0 }), price: v.price, stack: v.stack, unitPrice: Math.round(v.price / v.stack), n: v.n, asOf: v.asOf, trust: OB.TRUST, map: placed ? placed.map : null };
  });
  const out = {
    item,
    contextAsOf: asOfContext,
    auctionHouse: ah ? { ...ah, trust: OB.TRUST, unit: 'copper per item' } : null,
    vendors: vendorRows,
    notes: [
      'Prices are only what the player saw: auction house searches the player ran and vendor windows the player opened. Copper.',
      `Auction prices change; give asOf with any number. low and high cover only the ${OB.PRICE_WINDOW_MS / 3600000} hours before the latest quote.`,
      ...notes,
    ],
  };
  if (!ah && !vendorRows.length) out.notes.unshift('No observed price for this item yet. Say you do not know.');
  return out;
}

function routePoints(store, raw) {
  if (!Array.isArray(raw) || !raw.length) return { error: `route_draw needs points: 1 to ${ROUTE_POINTS_MAX} map tokens {map:ID,x,y}.` };
  if (raw.length > ROUTE_POINTS_MAX) return { error: `A route has at most ${ROUTE_POINTS_MAX} points; this one has ${raw.length}.` };
  const points = [];
  const errors = [];
  raw.forEach((value, i) => {
    const text = typeof value === 'string' ? value.trim() : '';
    const refs = GR.parseRefs(text);
    if (refs.length !== 1 || refs[0].token !== text || refs[0].kind !== 'map') { errors.push(`point ${i + 1} is not one {map:ID,x,y} token`); return; }
    const r = resolveOne(store, text);
    if (r.error) { errors.push(`point ${i + 1}: ${r.error}`); return; }
    points.push({ token: text, id: r.ref.id, name: r.ref.name, trust: r.ref.trust, x: r.ref.point.x, y: r.ref.point.y });
  });
  if (errors.length) return { error: `The route was refused and nothing was drawn. ${errors.join(' ')}` };
  return { points };
}

function routeCommand(points, loop) {
  const total = points.length;
  return {
    op: 'set',
    layer: ROUTE_LAYER,
    title: `${points[0].name} route, model estimate`,
    ordered: true,
    loop: !!loop,
    points: points.map((p, i) => ({ m: p.id, x: p.x, y: p.y, label: `Stop ${i + 1} of ${total}, model estimate`, kind: ROUTE_POINT_KIND })),
  };
}

function createObservedTools(opts) {
  const observed = opts.observed;
  const context = opts.context || (() => null);
  const gameData = opts.gameData || (() => null);
  const applyMap = opts.applyMap || null;
  const minSamples = opts.minSamples || OB.MIN_SAMPLES;
  const log = opts.log || (() => {});

  function lookup(args, snap, view) {
    const itemID = itemIdArg(args);
    if (itemID === null) return fail('itemID must be a positive whole number from the wowdata tools.');
    const store = gameData(snap.text);
    const resolved = itemRef(store, itemID);
    if (resolved.error) return fail(`Refused: ${resolved.error}`);
    let lines;
    try { lines = observed.lines(snap.character.key); } catch (e) { return fail(`Cannot read the observed data: ${e.message}`); }
    return done(view(store, resolved.item, lines, snap.at || null));
  }

  function route(args, snap) {
    if (typeof applyMap !== 'function') return fail('This bridge cannot draw on the map.');
    if (args.clear === true) {
      const r = applyMap([{ op: 'clear', layer: ROUTE_LAYER }]);
      return done(r.changed ? 'Cleared the route. The game drops it on the next slot it loads.' : 'There was no route to clear.');
    }
    const store = gameData(snap.text);
    const checked = routePoints(store, args.points);
    if (checked.error) return fail(checked.error);
    const r = applyMap([routeCommand(checked.points, args.loop === true)]);
    log(`observed tools: route_draw for ${snap.character.key}, ${checked.points.length} point(s)`);
    return done({
      layer: ROUTE_LAYER,
      drawn: !!r.changed,
      delivery: 'The bridge keeps the route in the slot files until the next reply is published or the game says hello, then for three minutes more; it reaches the map on a slot load the game makes anyway (a reply, the hello or /reload). A route drawn while a hello is in flight may miss the slot that hello reads and then rides only those three minutes. No slot is spent for it.',
      points: checked.points.map(p => ({ ref: p.token, map: { id: p.id, name: p.name, trust: p.trust }, point: { x: p.x, y: p.y, trust: MODEL_TRUST } })),
      notes: ['Every point is your estimate: the map shows each stop as a model estimate, never as a verified spot.', ...(r.notes || [])],
    });
  }

  async function call(tool, rawArgs) {
    if (!TOOL_NAMES.includes(tool)) return fail(`Unknown tool: ${tool}`);
    const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {};
    const snap = G.snapshotOf(context());
    if (!snap.character) return fail('The game has not reported a character yet. Log in with the addon running, or send any message from the game first.');
    if (tool === TOOL.farm) return lookup(args, snap, (store, item, lines, at) => farmView(store, item, lines, minSamples, at));
    if (tool === TOOL.price) return lookup(args, snap, priceView);
    return route(args, snap);
  }

  return { call };
}

function toolSchemas() {
  return [
    {
      name: TOOL.farm,
      description: `Where the player's own loot dropped an item: for each loot source (an NPC by ID, a gathering object by ID, or fishing in a zone), the observed drop rate with its sample size n, the maps where it dropped and the average spot there. Only data the game reported to this bridge (trust "observed") and the synced Forever client data (item and map names). Sources with fewer than ${OB.MIN_SAMPLES} loot windows show no rate. Rates of different sources are never added together. NPC and object names have no verified source: refer to them only by what the player sees. An itemID the game data does not have is refused.`,
      inputSchema: {
        type: 'object',
        properties: { itemID: { type: 'integer', minimum: 1, description: 'The item ID, from the wowdata tools' } },
        required: ['itemID'],
      },
    },
    {
      name: TOOL.price,
      description: 'The prices the player saw for an item: the auction house results of searches the player ran in game, and vendor windows the player opened, in copper, with n and asOf. Nothing here comes from the web or from memory, and the bridge never searches the auction house. An itemID the game data does not have is refused. No observation means you do not know the price.',
      inputSchema: {
        type: 'object',
        properties: { itemID: { type: 'integer', minimum: 1, description: 'The item ID, from the wowdata tools' } },
        required: ['itemID'],
      },
    },
    {
      name: TOOL.route,
      description: `Draw one ordered route on the player's world map, replacing the last one, or clear it. Each point is a map token {map:ID,x,y} with the uiMapID from the wowdata tools and x, y from 0 to 100. A map ID the synced Forever data does not have refuses the whole route. Your x and y are shown in game only as a model estimate. At most ${ROUTE_POINTS_MAX} points. The route reaches the game on the next slot it loads anyway; no slot is spent for it. Advice only: it moves nothing and acts for no one.`,
      inputSchema: {
        type: 'object',
        properties: {
          points: { type: 'array', maxItems: ROUTE_POINTS_MAX, items: { type: 'string', maxLength: 40 }, description: 'Ordered stops, for example ["{map:ID,45.6,42.4}", "{map:ID,50.1,40.0}"]' },
          loop: { type: 'boolean', description: 'true joins the last stop back to the first' },
          clear: { type: 'boolean', description: 'true removes the route' },
        },
      },
    },
  ];
}

module.exports = {
  TOOL, TOOL_NAMES, WRITE_TOOL_NAMES, ROUTE_LAYER, ROUTE_POINTS_MAX, MODEL_TRUST,
  routePoints, routeCommand, farmView, priceView, createObservedTools, toolSchemas,
};
