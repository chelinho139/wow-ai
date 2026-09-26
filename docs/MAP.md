# Map layers, navigator and gathering nodes

The agent can mark your world map. What it draws are **layers**: a named list of points (`uiMapID`, x, y in map percent, a label, a kind), optionally **ordered** (a route: numbered pins joined by lines) and **looping** (a farming circuit).

## How marks get from the agent to the game

1. For every run, whatever the agent, the bridge sets `WOW_AI_MAP_FILE` to a fresh file in `bridge/mapjobs/`. Tools append commands there, one JSON object per line:

   ```json
   {"op":"set","layer":"mining","title":"Copper loop","ordered":true,"loop":true,"points":[{"m":1432,"x":41.5,"y":47.8,"label":"1. Copper Vein","kind":"ore"}]}
   {"op":"clear","layer":"mining"}
   {"op":"clearall"}
   ```

   A point that is a quest step can also say which quest and which step: `"q":855,"step":"accept"`, `"step":"objective","obj":"Centaur Bracers"` (the objective's item or creature name) or `"step":"turnin"`. The navigator then moves on when the game reports that step done (see below).

   The agent can also put a few marks in its reply inside a ```` ```wowmap ```` block; the bridge takes the block out of the text. The system prompt that goes with the game context explains both ways, so any agent can draw without extra tooling: `set` replaces a layer, `clear` removes one, `clearall` removes them all; `kind` is one of `ore`, `herb`, `quest`, `turnin`, `kill`, `loot`, `object`, `explore`, `npc`, `trainer`, `vendor`, `dungeon`, `flight`, `poi`.
2. When the run ends the bridge validates the commands (`protocol.js`: sanitized labels, coordinates clamped to 0-100, at most 400 points per layer, 1500 in total, 12 layers with the oldest dropped first), applies them to the layers it keeps in `state.json`, and bumps a version number. The reply gets a `[bridge] map: ...` line saying what changed.
3. The next slot files carry the whole set (`map = { epoch, version, layers }`) for three minutes after a change (on progress publishes only while the set is small), and again after every hello. The addon replaces its copy when the version is newer (or the bridge's state was reset). A mark can't be applied twice, and a client that lost its saved data gets the layers back when it says hello.

## In game

- **World map:** pins for every visible layer on the map you are looking at, projected onto continent maps too. Hover for the label; click a pin to navigate to it.
- **Navigator:** a small frame with an arrow and the distance in yards to the current stop of the route. It starts on a route as soon as one arrives (unless you are already following another one) and wraps around on loops. Drag it to move it; right-click skips a stop. It shows "no position here" in instances, where the game gives addons no coordinates.
  - **Plain stops** (ore, marks) advance when you get within 12 yards.
  - **Quest steps** advance when the game says they are done: the quest is in your log (accept), the objective's line is finished or the whole quest is complete (objective), the quest is turned in (turn in). Being at the spot doesn't count; close to it the navigator says what's left ("here: accept it", "finish it", "turn it in"). Every step already done is skipped in one jump (also when a route arrives), with one chat line and a sound, and done steps leave the map. An objective is matched to its log line by name only; when that fails (custom text, another language) the stop waits for the whole quest to be complete rather than guess.
  - A stop you pick yourself (`prev`, `nav <layer> <n>`, clicking a pin) is never skipped over; `next` hands control back to the game.
- **Herb and ore nodes:** with a `WoWAI_Nodes` data addon installed (see below), every herb and ore spawn point of the zone on the world map, filtered to what your skill can gather.

| Command | Does |
|---|---|
| `/wow-ai map` | List layers, navigation and node settings |
| `/wow-ai map ore [on\|off]`, `/wow-ai map herb [on\|off]` | Show or hide mining / herbalism nodes |
| `/wow-ai map filter all\|skill` | Every node, or only those your skill can gather (default) |
| `/wow-ai map hide <layer>`, `/wow-ai map show <layer>` | Hide or show a layer locally |
| `/wow-ai map nav <layer> [n]`, `next`, `prev`, `stop` | Drive the navigator |

`/aimap` is a shorter alias for `/wow-ai map`. Everything here only reads positions and draws. Nothing moves, targets or acts for you.

## Where the data comes from

The bridge ships no game data: the agent has to know where things are. With just the system prompt it can place marks it knows or that you tell it about. For real routes, point the chat at a folder (`/wow-ai cd`) that holds game data and tools to query it, and describe them in that folder's `CLAUDE.md` (or the equivalent for your agent): quests, NPCs, objects and gathering spawns with their `uiMapID` and coordinates, and a script that appends `set` commands to `$WOW_AI_MAP_FILE`. Such datasets exist (QuestieDB, AtlasLootClassic, the vmangos world database) but their licences don't allow redistributing them here, so that folder stays yours.

The optional `WoWAI_Nodes` addon is the same idea for the in-game node pins: a separate addon that sets the global `WoWAINodes = { kinds = { { name, "mining"|"herbalism", requiredSkill }, ... }, maps = { [uiMapID] = { [kindIndex] = "xxxyyyxxxyyy..." } } }`, where each point is x and y in tenths of a percent, three digits each. `Map.lua` reads it if it is there and says so in `/wow-ai map` if it is not.
