# WoW retail addon and macro primer

Read by the wow-ai bridge and appended to the agent's system prompt on every run when the game context says the client is retail (interface 100000 and up); `primerFile` in docs/CONFIGURATION.md overrides the choice. Keep it short: it costs tokens on every message. Edit it freely; the bridge re-reads it on each run.

## The client

- World of Warcraft retail, The War Within (11.2.x, interface 110205 for 11.2.5). Lua 5.1. Some servers run an older or newer build than live: the `Game:` line of the context has the exact version (and a `Server:` line may say more); check it before relying on a recent API.
- Online data describes the current live build: Wowhead, Raidbots and SimulationCraft data, guides and talent calculators. When the client is on another build (a private server on 11.2.5 while live is 12.x), talent trees, node ids, spells and quests there can differ, and decoding a talent string with live data gives wrong names. Prefer what the game reports (the context, linked tooltips, what the player reads to you); if you must use outside data, find the dataset for the client's exact build, and say when advice leans on data from another build.
- Blizzard's own UI code is https://github.com/Gethe/wow-ui-source (the `live` branch, with a tag per build). When unsure whether a function, frame template or global exists, check there, or in game: `/dump type(SomeFunction)`, `/run print(GetBuildInfo())`.
- Use the modern `C_` namespaces; many old globals are gone: `C_Item.GetItemInfo`, `C_Spell.GetSpellInfo` / `C_Spell.GetSpellCooldown` (return tables, not multiple values), `C_UnitAuras.GetAuraDataByIndex(unit, i, "HELPFUL")` (not `UnitBuff`), `C_Container.GetContainerNumSlots` / `GetContainerItemInfo` (returns a table), `C_AddOns` (`LoadAddOn`, `GetAddOnMetadata`, `IsAddOnLoaded`), `C_Timer`, `C_Map`, `C_QuestLog`.
- No talent tabs and no skill lines (`GetTalentTabInfo`, `GetNumSkillLines` do not exist). Specialization: `GetSpecialization()` then `GetSpecializationInfo(index)` (specID, name, description, icon, role). Talents are trait trees: `C_ClassTalents.GetActiveConfigID()`, `C_Traits.GetConfigInfo(configID)`, `C_Traits.GetNodeInfo(configID, nodeID)`. Professions: `GetProfessions()` (prof1, prof2, archaeology, fishing, cooking indices, nil when unlearned) and `GetProfessionInfo(index)` (name, icon, skillLevel, maxSkillLevel, ...); recipes through `C_TradeSkillUI`.
- Options panels: `Settings.RegisterCanvasLayoutCategory(frame, name)` then `Settings.RegisterAddOnCategory(category)` (`InterfaceOptions_AddCategory` is gone). `## AddonCompartmentFunc: MyAddon_OnClick` in the `.toc` adds an entry to the minimap addon menu.

## Addon layout

- `Interface\AddOns\<Name>\<Name>.toc` lists the files, in load order:
  ```
  ## Interface: 110205
  ## Title: My Addon
  ## Notes: What it does
  ## SavedVariables: MyAddonDB
  ## SavedVariablesPerCharacter: MyAddonCharDB
  ## Dependencies: OtherAddon
  ## LoadOnDemand: 0
  Core.lua
  UI.xml
  ```
  `## Interface:` takes a comma-separated list (`110205, 110207`) for an addon that runs on several builds.
- Files are discovered at client launch only: a new file or addon needs a full restart. Edits to existing Lua/XML files need just `/reload`.
- Every file receives `local addonName, ns = ...` (the addon name and a private table shared by its files). Use `local` for everything; globals are shared with every addon.
- SavedVariables are plain global tables, valid from `ADDON_LOADED` (arg1 == your addon name) and written on logout or `/reload`.

## Sandbox rules

- No networking, no file I/O, no `require`, `io`, `os`, `loadfile`. `time()`, `date()`, `GetTime()` (uptime seconds) exist. `print()` writes to the chat frame.
- Protected actions (casting, targeting, movement, using items) cannot be called from addon code. They only work from a secure button (`SecureActionButtonTemplate` with `type`/`spell`/`macrotext` attributes) pressed by the player, or from macros. `InCombatLockdown()` is true in combat: secure frames cannot be created, shown, hidden or re-anchored then; queue the change for `PLAYER_REGEN_ENABLED`.
- `ReloadUI()` and a few others need a hardware event (a real key or click), not a timer.
- Hook Blizzard code with `hooksecurefunc("FunctionName", fn)` (runs after, cannot break taint) rather than replacing functions; replacing a secure function taints it.

## Frames and events

```lua
local f = CreateFrame("Frame", "MyAddonFrame", UIParent, "BackdropTemplate")
f:SetSize(300, 200); f:SetPoint("CENTER")
f:RegisterEvent("PLAYER_LOGIN"); f:RegisterEvent("PLAYER_ENTERING_WORLD")
f:SetScript("OnEvent", function(self, event, ...) end)
local text = f:CreateFontString(nil, "OVERLAY", "GameFontNormal")
local btn = CreateFrame("Button", nil, f, "UIPanelButtonTemplate")
btn:SetScript("OnClick", function(self, button) end)
C_Timer.After(2, function() end); C_Timer.NewTicker(1, function() end)
SLASH_MYADDON1 = "/myaddon"; SlashCmdList.MYADDON = function(msg) end
```

- Common templates: `UIPanelButtonTemplate`, `UIPanelCloseButton`, `ScrollFrameTemplate`, `InputBoxTemplate`, `UICheckButtonTemplate`, `GameTooltipTemplate`, `BackdropTemplate` (required for `SetBackdrop`), `ButtonFrameTemplate` / `PortraitFrameTemplate` for Blizzard-style windows.
- Useful events: `ADDON_LOADED`, `PLAYER_LOGIN`, `PLAYER_ENTERING_WORLD`, `PLAYER_REGEN_DISABLED`/`ENABLED` (combat start/end), `PLAYER_TARGET_CHANGED`, `UNIT_HEALTH`, `UNIT_AURA`, `BAG_UPDATE`, `ZONE_CHANGED_NEW_AREA`, `PLAYER_SPECIALIZATION_CHANGED`, `TRAIT_CONFIG_UPDATED`, `CHAT_MSG_*`, `COMBAT_LOG_EVENT_UNFILTERED` (read with `CombatLogGetCurrentEventInfo()`).
- Unit functions take a unit token: `"player"`, `"target"`, `"focus"`, `"pet"`, `"party1"`, `"raid5"`, `"mouseover"`, `"boss1"`, `"nameplate3"`. `UnitName`, `UnitLevel`, `UnitClass` (localized, then token), `UnitHealth`/`UnitHealthMax`, `UnitPower`, `UnitExists`, `UnitIsDead`, `UnitIsEnemy`; auras via `C_UnitAuras.GetAuraDataByIndex` or `AuraUtil.ForEachAura`.
- Items and spells: `C_Item.GetItemInfo(idOrLink)`, `C_Spell.GetSpellInfo(idOrName)` (table: name, iconID, castTime, ...), `C_Spell.GetSpellCooldown(id)` (table), `C_Spell.IsSpellUsable`, `GetInventoryItemLink("player", slot)`, `C_Container.GetContainerItemInfo(bag, slot)` (table; bags 0..4, reagent bag 5).
- Tooltips: `GameTooltip:SetOwner(frame, "ANCHOR_RIGHT")`, then `SetUnit`, `SetHyperlink`, `SetBagItem`, `SetInventoryItem`. For data without a visible tooltip use `C_TooltipInfo.GetHyperlink(link)` (returns `lines`, each with `leftText`).
- Text markup: `|cAARRGGBBtext|r` colour, `|Hitem:2140|h[Fine Longsword]|h` link, `|Ttexture:16|t` icon, `|A:atlas:16:16|a` atlas. Handle link clicks with `hooksecurefunc("SetItemRef", fn)`.
- Chat: `ChatFrameUtil.InsertLink(text)` is what a shift-click calls (older builds: `ChatEdit_InsertLink`); hook whichever exists.
- Helpers Blizzard ships: `strsplit`, `strtrim`, `strjoin`, `format`, `tinsert`, `tremove`, `wipe`, `tContains`, `hooksecurefunc`, `Mixin`, `CreateFrame`, `StaticPopup_Show` with `StaticPopupDialogs["KEY"] = { text=, button1=, button2=, OnAccept=, timeout=0, whileDead=true, hideOnEscape=true }`.

## Macros

- 255 characters, one action per hardware press (GCD-bound casts: one per press). `#showtooltip`, `/cast Spell`, `/use Item`, `/use 13` (trinket slot), `/castsequence reset=combat A, B`, `/target`, `/focus`, `/cancelaura`, `/stopcasting`, `/equip`, `/run <lua>`.
- Conditionals: `[mod:shift]`, `[combat]`, `[harm]`/`[help]`, `[dead]`, `[exists]`, `[spec:1]`, `[known:Spell]`, `[stance:1]`/`[form:1]`, `[@target]`/`[@mouseover]`/`[@focus]`/`[@player]`/`[@cursor]` (ground-targeted spells), `[nopet]`, `[flyable]`, `[indoors]`; combine with commas, separate alternatives with semicolons: `/cast [@mouseover,help,nodead][help] Heal; [@player] Heal`.
- Spell and item names are localized and must match the client's language exactly (the player's locale is in the context when known); no spell ranks in retail.

## Debugging in game

- `/reload` after editing Lua; `/console scriptErrors 1` to see Lua errors; `/dump expr` to print a value; `/etrace` to watch events; `/fstack` to find the frame under the mouse; `/tinspect` to browse a table; `/run` for one-liners.
- With wow-ai, the player is reading your reply in a small in-game window: give the file path and a short "what to do next" (`/reload`, or restart the client if you added a file).
