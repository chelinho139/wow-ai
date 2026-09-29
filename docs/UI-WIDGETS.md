# Live UI widgets

Ask the agent for a small UI element (*"give me a DPS meter"*, *"a timer bar for my buffs"*) and it appears in the game a moment later, with no `/reload`. The agent writes addon Lua. The bridge checks it, keeps it versioned and ships it in the slot files. The addon runs it.

## How a widget gets from the agent to the game

1. The system prompt of a game chat tells the agent the contract, on every plugin whose `surfaces` include `ui` (`ask` and `claude-code` both do). The agent ends its reply with a block:

   ````
   ```wowui dps title="DPS meter"
   local ui = ...
   local f = CreateFrame("Frame", nil, ui.frame, "BackdropTemplate")
   ...
   ```
   ````

   Or its tools append one JSON object per line to the file in `CLAUDE_WOW_UI_FILE` (set for every run of a plugin with the `ui` surface, in `~/.claude-wow/uijobs/`):

   ```json
   {"op":"set","name":"dps","title":"DPS meter","source":"local ui = ...\n..."}
   {"op":"remove","name":"dps"}
   {"op":"clearall"}
   ```

   A ```` ```wowui <name> remove ```` block with an empty body also removes a widget. The bridge takes the blocks out of the reply and leaves `[UI widget "dps"]` in their place.
2. When the run ends, the bridge validates each widget (`protocol.js`): a name of letters, digits, `_ . -` (at most 32), at most 16,000 bytes of source, at most 8 widgets and 64,000 bytes in total (the oldest go first). It refuses any widget whose source names a protected or outward action (the deny-list below). A widget with the same name replaces the old one. The reply gets a `[bridge] ui: ...` line that says what changed or why a widget was refused.
3. The widgets live in `state.json` (`widgets`, with an epoch and a version). The next slot files carry the whole set for three minutes after a change, and again after every hello, the same way as the map layers. The addon replaces its copy when the version is newer, so a widget never runs twice, and a client that lost its saved data gets its widgets back.

## The widget contract

The source is the body of a function. `local ui = ...` gives:

| Field | What it is |
|---|---|
| `ui.name`, `ui.title` | the widget's name and title |
| `ui.frame` | a full-screen container frame. Frames created with no parent (or with `UIParent`) are put in it |
| `ui.db` | a table saved between sessions (for a position, a setting) |
| `ui.print(text)` | print a line to the game chat |

Use documented addon APIs: `CreateFrame`, events, `OnUpdate`, `C_Timer`, `Unit*`, `C_UnitAuras`, `CombatLogGetCurrentEventInfo`.

## Display-only

Widgets only read and draw. Two checks enforce that:

- **Bridge deny-list.** A source that names any of these is refused: casting, using actions and items, macros (`CastSpellByName`, `UseAction`, `RunMacro`, `RunMacroText`, ...), targeting and movement (`TargetUnit`, `AssistUnit`, `MoveForwardStart`, ...), chat and addon messages (`SendChatMessage`, `SendAddonMessage`, `BNSendWhisper`), groups, trade, mail, bindings, CVars, `ReloadUI`, `LoadAddOn`, `SlashCmdList`, `hooksecurefunc`, `loadstring`/`setfenv`/`getfenv`/`rawget`/`debug`, any `Secure...Template`, and any `ClaudeWoW*` global. The full list is `WIDGET_DENIED_NAMES` in `bridge/protocol.js`.
- **Addon sandbox.** `Widgets.lua` runs each widget with its own environment. The same names resolve to a function that raises an error, `_G` is the sandbox, `ClaudeWoW*` globals are hidden, `C_*` namespaces are read-only proxies, and `CreateFrame` refuses secure templates. A test keeps the two lists equal.

## Errors

The first run is in a `pcall`, and so are the widget's script handlers (`SetScript`, `HookScript`) and timer callbacks. On an error, the addon stops the widget (hides its frames, unregisters their events, cancels its tickers) and writes the error to the game chat and to the chat window. `/claude-wow ui run <name>` tries again.

## In game

| Command | Does |
|---|---|
| `/claude-wow ui` or `/claude-wow ui list` | list the widgets: running, removed, or failed with the error |
| `/claude-wow ui remove <name>` | stop a widget and keep it off after login. It comes back only when the agent sends a new version |
| `/claude-wow ui run <name>` | start a widget again (after an error or a remove) |

Widgets live in `ClaudeWoWWidgetDB` and start again at login. `Widgets.lua` is a new addon file, so the client needs one full restart after the update (a `/reload` does not discover new files). To delete a widget on the bridge too, ask the agent ("remove the DPS meter").
