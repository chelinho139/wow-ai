# WoW: Forever and Classic Era addon and macro primer

Read by the claude-wow bridge and appended to the agent's system prompt on every run (Claude and Grok; for Codex it goes at the top of the prompt) (see `primerFile` in docs/CONFIGURATION.md). Keep it short: it costs tokens on every message. Edit it freely; the bridge re-reads it on each run.

## The client

- World of Warcraft: Forever is vanilla content on the current retail engine and UI code (the `Mainline` files, with 12.x-era deprecation shims). Interface number 16001 (client 1.60.x). Lua 5.1.
- Blizzard's own UI code for this client is the `forever` branch of https://github.com/Gethe/wow-ui-source. When unsure whether a function, frame template or global exists, check there, or in game: `/dump type(SomeFunction)`, `/run print(GetBuildInfo())`.
- Use the modern `C_` namespaces; many old globals are gone or only exist as temporary shims: `C_Item.GetItemInfo` (not `GetItemInfo`), `C_Spell.GetSpellInfo` / `C_Spell.GetSpellCooldown` (return tables, not multiple values), `C_UnitAuras.GetAuraDataByIndex(unit, i, "HELPFUL")` (not `UnitBuff`), `C_Container.GetContainerNumSlots` / `GetContainerItemInfo` (returns a table), `C_AddOns`, `C_Timer`, `C_Map`. Write a fallback only if you have confirmed the old name exists: `local f = (C_Item and C_Item.GetItemInfo) or GetItemInfo`. Skill lines and weapon skills keep the classic `GetNumSkillLines` / `GetSkillLineInfo(i)`. Many other Classic functions are absent: talent tabs (`GetNumTalentTabs`, `GetTalentTabInfo`), `GetTradeSkillInfo`, `GetCraftInfo`, `GetMerchantItemInfo`, `GetAuctionItemInfo`. Use `C_TradeSkillUI`, `GetMerchantItemID` / `GetMerchantItemLink`, `C_AuctionHouse`.
- Talents are a trait tree. Read them like Blizzard's Forever talent frame (`Blizzard_PlayerSpells/Camelot/ClassTalents/Blizzard_ClassTalentsFrame.lua`): `C_SpecializationInfo.GetActiveSpecGroup()` → `C_SpecializationInfo.GetCombatConfigIDForSpecGroup(group)` (nil: no loadout) → `C_Traits.GetConfigInfo(configID).treeIDs[1]` → `C_Traits.GetGroupDisplayInfoByTreeID(treeID)` (each tree's `groupID`, `displayName`) and `C_Traits.GetGroupCurrencyInfo(configID, groupIDs)` (`traitNodeGroupID`, `currencyInfos[1].spent`).
- Classic Era (`Game: World of Warcraft Classic`, interface 11509) also loads the addon; its UI code is the `classic_era` branch. It keeps `GetNumTalentTabs`, `GetTradeSkillInfo`, `GetMerchantItemInfo`, `GetQuestLogTitle`; talent tab names and points come from `C_SpecializationInfo.GetSpecializationInfo(i)` (2nd and 7th returns). No trait talents, no `C_SuperTrack`.
- Beta quirk: the client sometimes wipes addon SavedVariables. Do not keep anything irreplaceable only there.

## Addon layout

- `Interface\AddOns\<Name>\<Name>.toc` lists the files, in load order:
  ```
  ## Interface: 16001
  ## Title: My Addon
  ## Notes: What it does
  ## SavedVariables: MyAddonDB
  ## SavedVariablesPerCharacter: MyAddonCharDB
  ## Dependencies: OtherAddon
  ## LoadOnDemand: 0
  Core.lua
  UI.xml
  ```
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
f:SetBackdrop({ bgFile = "Interface\\Tooltips\\UI-Tooltip-Background", edgeFile = "Interface\\Tooltips\\UI-Tooltip-Border", tile = true, tileSize = 16, edgeSize = 16, insets = { left = 4, right = 4, top = 4, bottom = 4 } })
f:RegisterEvent("PLAYER_LOGIN"); f:RegisterEvent("PLAYER_ENTERING_WORLD")
f:SetScript("OnEvent", function(self, event, ...) end)
local text = f:CreateFontString(nil, "OVERLAY", "GameFontNormal")
local btn = CreateFrame("Button", nil, f, "UIPanelButtonTemplate")
btn:SetScript("OnClick", function(self, button) end)
C_Timer.After(2, function() end); C_Timer.NewTicker(1, function() end)
SLASH_MYADDON1 = "/myaddon"; SlashCmdList.MYADDON = function(msg) end
```

- Common templates: `UIPanelButtonTemplate`, `UIPanelCloseButton`, `UIPanelScrollFrameTemplate`, `InputBoxTemplate`, `UICheckButtonTemplate`, `GameTooltipTemplate`, `BackdropTemplate` (required for `SetBackdrop`).
- Useful events: `ADDON_LOADED`, `PLAYER_LOGIN`, `PLAYER_ENTERING_WORLD`, `PLAYER_REGEN_DISABLED`/`ENABLED` (combat start/end), `PLAYER_TARGET_CHANGED`, `UNIT_HEALTH`, `UNIT_AURA`, `BAG_UPDATE`, `ZONE_CHANGED_NEW_AREA`, `PLAYER_LEVEL_UP`, `CHAT_MSG_*`, `UNIT_COMBAT` (unit, action, flag, amount, school: damage and heals on a unit, no attacker), `PLAYER_DEAD`. After a death, `C_DeathRecap.GetRecapEvents()` lists the last hits (source, spell, amount, overkill).
- Restricted: this client lets only the Blizzard UI register `COMBAT_LOG_EVENT_UNFILTERED`, `COMBAT_LOG_EVENT`, `MINIMAP_PING` and `UNIT_PING_PIN_ADDED`/`REMOVED`. An addon that registers one gets the "blocked from an action only available to the Blizzard UI" popup, so `CombatLogGetCurrentEventInfo()` is not an option.
- Unit functions take a unit token: `"player"`, `"target"`, `"pet"`, `"party1"`, `"raid5"`, `"mouseover"`. `UnitName`, `UnitLevel`, `UnitClass` (localized, then token), `UnitHealth`/`UnitHealthMax`, `UnitPower`, `UnitExists`, `UnitIsDead`, `UnitIsEnemy`; auras via `C_UnitAuras.GetAuraDataByIndex(unit, i, "HELPFUL"|"HARMFUL")` or `AuraUtil.ForEachAura`.
- Items and spells: `C_Item.GetItemInfo(idOrLink)`, `C_Spell.GetSpellInfo(idOrName)` (table: name, iconID, castTime, ...), `C_Spell.GetSpellCooldown(id)` (table), `C_Spell.IsSpellUsable`, `GetInventoryItemLink("player", slot)`, bag contents via `C_Container.GetContainerNumSlots(bag)` / `C_Container.GetContainerItemInfo(bag, slot)` (table; bags 0..4).
- Tooltips: `GameTooltip:SetOwner(frame, "ANCHOR_RIGHT")`, then `SetUnit`, `SetHyperlink`, `SetBagItem`, `SetInventoryItem`. Read lines off a hidden tooltip named `MyScanTip` via `MyScanTipTextLeft<i>:GetText()`.
- Text markup: `|cAARRGGBBtext|r` colour, `|Hitem:2140|h[Fine Longsword]|h` link, `|Ttexture:16|t` icon. Handle link clicks with `hooksecurefunc("SetItemRef", fn)`.
- The chat code is the modern `ChatFrameUtil` API (Blizzard_ChatFrameBase, Blizzard_ChatFrameUtil): `ChatFrameUtil.InsertLink(text)` is what a shift-click calls, `ChatFrameUtil.GetActiveWindow()` the active edit box, `ChatFrameUtil.OpenChat(text)`. The old `ChatEdit_*` globals may exist as aliases but Blizzard's own code does not call them, so hook the `ChatFrameUtil` table (`hooksecurefunc(ChatFrameUtil, "InsertLink", fn)`).
- Helpers Blizzard ships: `strsplit`, `strtrim`, `strjoin`, `format`, `tinsert`, `tremove`, `wipe`, `tContains`, `hooksecurefunc`, `Mixin`, `CreateFrame`, `StaticPopup_Show` with `StaticPopupDialogs["KEY"] = { text=, button1=, button2=, OnAccept=, timeout=0, whileDead=true, hideOnEscape=true }`.

## Macros

- 255 characters, one action per hardware press. `#showtooltip`, `/cast Spell`, `/use Item`, `/castsequence reset=combat A, B`, `/target`, `/focus`, `/cancelaura`, `/stopcasting`, `/equip`, `/run <lua>`.
- Conditionals: `[mod:shift]`, `[combat]`, `[harm]`/`[help]`, `[dead]`, `[exists]`, `[stance:1]`, `[@target]`/`[@mouseover]`/`[@player]`, `[nopet]`; combine with commas, separate alternatives with semicolons: `/cast [mod:alt,@player] Heal; [help] Heal; Attack`.
- Spell and item names are localized and must match exactly; ranks as `Spell(Rank 2)`.

## Debugging in game

- `/reload` after editing Lua; `/console scriptErrors 1` to see Lua errors; `/dump expr` to print a value; `/etrace` to watch events; `/fstack` to find the frame under the mouse; `/run` for one-liners.
- With claude-wow, the player is reading your reply in a small in-game window: give the file path and a short "what to do next" (`/reload`, or restart the client if you added a file).
