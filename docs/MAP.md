# Map layers, navigator and gathering nodes

The agent can mark your world map. What it draws are **layers**: a named list of points (`uiMapID`, x, y in map percent, a label, a kind), optionally **ordered** (a route: numbered pins joined by lines) and **looping** (a farming circuit).

## How marks get from the agent to the game

1. For every run, whatever the agent, the bridge sets `CLAUDE_WOW_MAP_FILE` to a fresh file in `~/.claude-wow/mapjobs/`. Tools append commands there, one JSON object per line:

   ```json
   {"op":"set","layer":"mining","title":"Copper loop","ordered":true,"loop":true,"points":[{"m":1432,"x":41.5,"y":47.8,"label":"1. Copper Vein","kind":"ore"}]}
   {"op":"clear","layer":"mining"}
   {"op":"clearall"}
   ```

   The agent can also put a few marks in its reply inside a ```` ```wowmap ```` block; the bridge takes the block out of the text. The system prompt that goes with the game context explains both ways, so any agent can draw without extra tooling: `set` replaces a layer, `clear` removes one, `clearall` removes them all; `kind` is one of `ore`, `herb`, `quest`, `turnin`, `kill`, `loot`, `object`, `explore`, `npc`, `trainer`, `vendor`, `dungeon`, `flight`, `poi`.
2. When the run ends the bridge validates the commands (`protocol.js`: sanitized labels, coordinates clamped to 0-100, at most 400 points per layer, 1500 in total, 12 layers with the oldest dropped first), applies them to the layers it keeps in `state.json`, and bumps a version number. The reply gets a `[bridge] map: ...` line saying what changed.
3. The next slot files carry the whole set (`map = { epoch, version, layers }`) for three minutes after a change (on progress publishes only while the set is small), and again after every hello. A route the live session draws with `route_draw` ([LIVE-SESSION.md](LIVE-SESSION.md)) is applied by the bridge at once and stays in the slot files until the next reply is published or the game says hello (`mapHeldForGame` in `state.json`), then for the usual three minutes, so it reaches the map on a slot load the game makes anyway. The addon replaces its copy when the version is newer (or the bridge's state was reset). A mark can't be applied twice, and a client that lost its saved data gets the layers back when it says hello.

## In game

- **World map:** pins for every visible layer on the map you are looking at, projected onto continent maps too. Hover for the label; click a pin to navigate to it.
- **Navigator:** a small frame with an arrow and the distance in yards to the current stop of the route. It starts on a route as soon as one arrives (unless you are already following another one), advances when you get within 12 yards, and wraps around on loops. Drag it to move it; right-click skips a stop. It shows "no position here" in instances, where the game gives addons no coordinates.
- **Herb and ore nodes:** with a `ClaudeWoW_Nodes` data addon installed (see below), every herb and ore spawn point of the zone on the world map, filtered to what your skill can gather.

| Command | Does |
|---|---|
| `/claude config map` | List layers, navigation and node settings |
| `/claude config map ore [on\|off]`, `/claude config map herb [on\|off]` | Show or hide mining / herbalism nodes |
| `/claude config map filter all\|skill` | Every node, or only those your skill can gather (default) |
| `/claude config map hide <layer>`, `/claude config map show <layer>` | Hide or show a layer locally |
| `/claude config map nav <layer> [n]`, `next`, `prev`, `stop` | Drive the navigator |

`/aimap` is a shorter alias for `/claude config map`. Everything here only reads positions and draws. Nothing moves, targets or acts for you.

## Where the data comes from

The bridge ships no game data: the agent has to know where things are. With just the system prompt it can place marks it knows or that you tell it about. For real routes, point the chat at a folder (`/claude cd`) that holds game data and tools to query it, and describe them in that folder's `CLAUDE.md` (or the equivalent for your agent): quests, NPCs, objects and gathering spawns with their `uiMapID` and coordinates, and a script that appends `set` commands to `$CLAUDE_WOW_MAP_FILE`. Such datasets exist (QuestieDB, AtlasLootClassic, the vmangos world database) but their licences don't allow redistributing them here, so that folder stays yours.

The optional `ClaudeWoW_Nodes` addon is the same idea for the in-game node pins: a separate addon that sets the global `ClaudeWoWNodes = { kinds = { { name, "mining"|"herbalism", requiredSkill }, ... }, maps = { [uiMapID] = { [kindIndex] = "xxxyyyxxxyyy..." } } }`, where each point is x and y in tenths of a percent, three digits each. `Map.lua` reads it if it is there and says so in `/claude config map` if it is not.
