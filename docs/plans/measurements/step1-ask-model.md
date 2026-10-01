# Step 1 measurement: `ask` on Opus 5.5 vs Sonnet 5.5

Plan: [`router-and-game-data.md` §3 and §12](../router-and-game-data.md). Run on 2026-09-30 with Claude Code 2.1.286. Raw results: [`step1-ask-model.json`](step1-ask-model.json).

## Result

- **Sonnet 5.5 costs 2.1x less**: $0.145 vs $0.306 mean per first turn, $1.45 vs $3.06 for the 10 prompts.
- **Sonnet 5.5 is faster**: median wall latency 8.1 s vs 14.1 s. Sonnet was faster on 9 of 10 prompts.
- **Answers are shorter on Sonnet**: 538 vs 680 characters mean.
- **Quality is for the owner to judge** from the answers below. Every answer names game nouns from model memory, so every answer is **unverified**.
- **Recommendation:** use `claude-sonnet-5-5` for `ask` if the answers below hold up for you. The default model in config is not changed by this PR.

## Method

- Script: `node dev/measure-ask.js` (`--budget 4.9`). It runs each prompt once per model, headless, `-p --output-format stream-json --verbose`, with the real `claude` from `A.resolveCommand` (never `dev/fake-claude.js`).
- Same shape as a bridge `ask` run: the config comes from `dev/sandbox.js` `buildConfig` (so `bridge/config.example.json`'s `agents.claude` block), the argv from `AGENTS.claude.args`, the stdin from `AGENTS.claude.input`, the env from `AGENTS.claude.env`, the system prompt from `P.systemPrompt(ctx, primer, { tools: ask.tools, surfaces: ask.surfaces })` and the message from `P.messagePrompt`. `CLAUDE_WOW_MAP_FILE` and `CLAUDE_WOW_UI_FILE` point into the run folder.
- Tools: `--permission-mode acceptEdits --allowedTools WebSearch WebFetch Bash(git:*) …` as in `config.example.json`. The owner's own `config.json` allows more (`Write`, `Skill`, `mcp__wow-stream`, more `Bash`), so live runs can differ.
- Extra flags, for the measurement only: `--no-session-persistence` and `--max-budget-usd` (at most $1 per run).
- Situation block: the context the live addon last reported for Bone (level 20 Orc Rogue, Horde, Undercity, client 1.60.1.70124), copied verbatim into the script.
- Each run is a new session in a new temp folder. Prompt order alternates (Opus first on odd prompts, Sonnet first on even ones).
- Cost is Claude Code's `total_cost_usd` (API list price, not a subscription bill). The bridge's own `claudeCost` matched it to the cent on every run, except $0.01 per web search (see below).
- The runs inherit the user's `~/.claude` setup (plan decision 5), the same as live `ask` runs. Its global `CLAUDE.md` shaped the answer style.

## Limits

- n = 1 per prompt per model. Latency includes Claude Code start-up and varies between runs.
- First turns only. About 34k tokens of each run were a cold 1-hour cache write (Opus: 34.5k written, 28.3k read on average). That write is about 90% of each Opus run's cost. A resumed chat reads most of it from cache, so later turns cost less on both models and the gap moves toward the output rates ($20 vs $10 per MTok).
- A new folder per run changes the dynamic part of Claude Code's system prompt. The live `ask` scratch folder is stable, so cross-chat caching can be better there.
- Web search costs $10 per 1,000 searches. The bridge's `claudeCost` leaves that fee out ($0.01 per search here). `modelUsage.<model>.webSearchRequests` carries the count if this should change.

## Rates check

`CLAUDE_RATES` in `bridge/agents.js` was checked against https://platform.claude.com/docs/en/about-claude/pricing on 2026-09-30.

| Model | Listed (in / out / cache read per MTok) | Before this PR | Now |
|---|---|---|---|
| Claude Opus 5.5 | $4 / $20 / $0.20 | $5 / $25 / $0.50 (matched the Opus 5 row) | fixed |
| Claude Sonnet 5.5 | $2 / $10 / $0.20 | $2 / $10 / $0.20 | correct, now tested |
| Claude Opus 4.5 | $5 / $25 / $0.50 | no rate | added |
| Claude Sonnet 4.5 | $3 / $15 / $0.30 | no rate | added |
| Fable 5.1, Fable 5, Opus 5, Opus 4.6 to 4.8, Sonnet 5, Sonnet 4.6, Haiku 4.5 | as listed | correct | unchanged |

## Flags

Every answer below names specific items, NPCs, spells, zones, quests or coordinates from model memory (Classic data at best), so all 20 are **unverified** for Forever. Notes I can check against the prompt itself, without game knowledge:

- `route-next-zone`, Sonnet: says "6 are marked *". The situation block marks 7 quests with `*`.
- `where-trainer`: the two models put the trainer at different coordinates on map 1458 (Opus 83.7, 70.0; Sonnet 72, 32). At most one can be right.
- `where-fishing`: Opus searched the web and marked the map. Sonnet did not search, said it was unsure and did not mark the map.
- `route-turnins`: Sonnet listed the 7 ready quest IDs and declined to route them without names. Opus drew a 4-stop route from memory and said so.
- Map marks written: Opus 3 (`where-trainer`, `where-fishing`, `route-turnins`), Sonnet 1 (`where-trainer`).

## Numbers

| Model | Runs | Total cost | Mean cost | Median wall latency | Mean answer length |
|---|---|---|---|---|---|
| opus[1m] | 10 | $3.0616 | $0.3062 | 14.1 s | 680 chars |
| claude-sonnet-5-5 | 10 | $1.4541 | $0.1454 | 8.1 s | 538 chars |

| Prompt | Model | Cost | Wall latency | Answer length | Tools |
|---|---|---|---|---|---|
| where-trainer | opus[1m] | $0.2857 | 15.8 s | 662 chars | none |
| where-trainer | claude-sonnet-5-5 | $0.1420 | 17.7 s | 558 chars | none |
| where-skinning | claude-sonnet-5-5 | $0.1398 | 8.1 s | 282 chars | none |
| where-skinning | opus[1m] | $0.2888 | 13.7 s | 450 chars | none |
| where-fishing | opus[1m] | $0.3496 | 17.7 s | 624 chars | ToolSearch, WebSearch |
| where-fishing | claude-sonnet-5-5 | $0.1418 | 9.0 s | 494 chars | none |
| macro-opener | claude-sonnet-5-5 | $0.1388 | 6.3 s | 391 chars | none |
| macro-opener | opus[1m] | $0.2865 | 9.3 s | 473 chars | none |
| macro-pickpocket | opus[1m] | $0.2906 | 14.1 s | 579 chars | none |
| macro-pickpocket | claude-sonnet-5-5 | $0.1385 | 7.3 s | 409 chars | none |
| route-turnins | claude-sonnet-5-5 | $0.1948 | 17.8 s | 596 chars | ToolSearch, WebSearch |
| route-turnins | opus[1m] | $0.3914 | 38.1 s | 1289 chars | ToolSearch, WebSearch |
| route-next-zone | opus[1m] | $0.2958 | 16.6 s | 704 chars | none |
| route-next-zone | claude-sonnet-5-5 | $0.1423 | 10.3 s | 758 chars | none |
| advice-talents | claude-sonnet-5-5 | $0.1374 | 5.7 s | 546 chars | none |
| advice-talents | opus[1m] | $0.2947 | 13.6 s | 644 chars | none |
| advice-money | opus[1m] | $0.2936 | 16.9 s | 674 chars | none |
| advice-money | claude-sonnet-5-5 | $0.1382 | 8.0 s | 696 chars | none |
| lore-city | claude-sonnet-5-5 | $0.1405 | 8.6 s | 650 chars | none |
| lore-city | opus[1m] | $0.2849 | 8.9 s | 704 chars | none |

## Answers

Verbatim `result` text. Triple backticks inside an answer are shown as `'''`. All answers are unverified (see Flags).

### where-trainer (where-is)

Prompt: "where is my class trainer in this city?"

#### opus[1m]

```text
Your rogue trainers are in the Rogues' Quarter, in the southeast corner of the Undercity. Carolyn Ward, Miles Dexter and Josef Gregorian stand there, at about 83.7, 70.0.

From the canals, go east through the inner ring and take the southeast exit. These are Classic coordinates, so the spot can be a little off in Forever. I put a marker on your map.

'''wowmap
{"op":"set","layer":"trainer","title":"Rogue Trainers","points":[{"m":1458,"x":83.7,"y":70.0,"label":"Rogues' Quarter - Rogue Trainers","kind":"trainer"}]}
'''

TL;DR:
Rogue trainers are in the Rogues' Quarter, southeast Undercity, at about 83.7, 70.0 (Classic coordinates). I marked it on your map.
```

#### claude-sonnet-5-5

```text
Your rogue trainer is Whisper Gloomshade in the Rogues' Quarter, on the east side of Undercity, around 72, 32. That's from memory, not checked against this client, so treat the spot as approximate. I marked it on your map.

'''wowmap
{"op":"set","layer":"trainer","title":"Rogue trainer","ordered":false,"loop":false,"points":[{"m":1458,"x":72,"y":32,"label":"Whisper Gloomshade (Rogue trainer)","kind":"trainer"}]}
'''

TL;DR: Rogue trainer Whisper Gloomshade is in the Rogues' Quarter, east side, about 72, 32 (from memory, unverified). Marked on your map.
```

### where-skinning (where-is)

Prompt: "my skinning is capped at 225. where do I train the next rank?"

#### claude-sonnet-5-5

```text
Your skinning is capped at 225 because the next rank, Artisan, requires character level 35. You are level 20, so no trainer can teach it yet.

TL;DR: Artisan Skinning (225-300) needs level 35. You are level 20, so you cannot train it until then. Check the trainer when you reach 35.
```

#### opus[1m]

```text
You cannot train it yet. Artisan Skinning (225-300) needs character level 35, and you are level 20.

At 35, train it from a city skinning trainer. In Classic, Killian Hagey teaches it in the Undercity Rogues' Quarter, and Thuwd teaches it in Orgrimmar. WoW Forever may differ from Classic, so check with the trainer.

TL;DR:
Artisan Skinning needs level 35 (you are 20). At 35, try Killian Hagey in UC or Thuwd in Org (Classic data, may differ here).
```

### where-fishing (where-is)

Prompt: "where can I buy a fishing pole near here?"

#### opus[1m]

```text
Lizbeth Cromwell, the Fishing Supplies vendor, sells the Fishing Pole. She stands near the fishing trainer Armand Cromwell, at about 80.6, 31.0 in the canal ring on the east side, by the Magic Quarter. The coordinates are from a classic database, so they may be a little off in Forever. I marked the spot on your map.

'''wowmap
{"op":"set","layer":"fishing","title":"Fishing Pole vendor","points":[{"m":1458,"x":80.6,"y":31.0,"label":"Lizbeth Cromwell - Fishing Supplies","kind":"vendor"}]}
'''

TL;DR:
Lizbeth Cromwell (Fishing Supplies) sells poles, near Armand Cromwell at about 80.6, 31.0 Undercity. Marked on your map.
```

#### claude-sonnet-5-5

```text
Armand Cromwell, the Undercity fishing trainer, should sell Fishing Poles. I think they're in the Trade Quarter, but I'm not sure of the exact spot. I can't check coordinates here, so I haven't marked the map.

Failing that, the general goods vendors in the Trade Quarter often stock one. Fishing is 4/75, so you can also learn Apprentice rank from Armand.

TL;DR: Try Armand Cromwell, fishing trainer in the Undercity Trade Quarter (unsure of spot); general goods vendors there are the backup.
```

### macro-opener (macro)

Prompt: "make me a macro that opens with my stun when I am stealthed and uses my normal combo point builder when I am not"

#### claude-sonnet-5-5

```text
'''wowmacro Opener
#showtooltip
/cast [stealth] Cheap Shot; Sinister Strike
'''

Cheap Shot while stealthed, Sinister Strike otherwise. Use `[stealth,@target]` if you need it, but the plain form works. Make sure Cheap Shot and Sinister Strike are on your bars or known by name.

TL;DR: Macro "Opener" casts Cheap Shot when stealthed, otherwise Sinister Strike. Click the button to create it.
```

#### opus[1m]

```text
'''wowmacro Opener
#showtooltip
/cast [stealth] Cheap Shot; Sinister Strike
'''
In stealth, the macro casts Cheap Shot. Out of stealth, it casts Sinister Strike.
In vanilla, rogues learn Cheap Shot at level 26, and you are 20. Until then, change "Cheap Shot" to "Garrote" or "Ambush". Forever can differ from vanilla, so check your spellbook.

TL;DR:
Macro "Opener": Cheap Shot in stealth, else Sinister Strike. Cheap Shot comes at 26 in vanilla, so use Garrote until then.
```

### macro-pickpocket (macro)

Prompt: "macro: pick pocket my target, then start attacking it"

#### opus[1m]

```text
This picks your target's pocket from stealth, then starts auto attack in the same press. Out of stealth, it only starts the attack.

'''wowmacro PickAttack
#showtooltip Pick Pocket
/cast [stealth] Pick Pocket
/startattack
'''

The auto attack breaks stealth, so you lose your opener (Cheap Shot or Ambush). To keep the opener, delete the /startattack line. Then press the macro once to pick the pocket and use your opener as the second press.

TL;DR:
Macro PickAttack: picks the pocket from stealth, then auto attacks. The attack breaks stealth, so you lose Cheap Shot or Ambush.
```

#### claude-sonnet-5-5

```text
'''wowmacro PickAttack
#showtooltip Pick Pocket
/cast Pick Pocket
/startattack
'''

It casts Pick Pocket on your target, then turns on auto-attack in the same press. Pick Pocket only works while you are stealthed, so stealth first and be behind the target. The attack breaks stealth after the pick.

TL;DR: Macro "PickAttack" casts Pick Pocket, then /startattack. Stealth first. Click the button to create it.
```

### route-turnins (route)

Prompt: "which quests in my log are ready to turn in, and in what order should I hand them in? mark the route on my map"

#### claude-sonnet-5-5

```text
Seven quests in your log are ready to turn in: 235, 264, 1060, 1130, 1483, 1489 and 2479. I can't give you a route or mark the map, because I can't confirm where they hand in. Your log lists only quest IDs, and my search found no turn-in locations for them.

Open your quest log (L) and look at each ready quest's name. Tell me the names or shift-click them into chat. I'll then order the hand-ins by distance from Undercity and mark them.

TL;DR: Ready to turn in: 235, 264, 1060, 1130, 1483, 1489, 2479. I couldn't look up where they hand in, so no route yet. Shift-click the quest names to me.
```

#### opus[1m]

```text
I could not check the quest database, so this is from memory. These are the 7 quests ready to hand in: 235, 1060, 1483, 264, 1130, 1489, 2479. I am sure of where 4 of them go:

1. 2479 Hinott's Assistance: Serge Hinott, Tarren Mill, Hillsbrad 61.6, 19.2. It is close, so do it first.
2. Take the Tirisfal zeppelin to Orgrimmar, then fly to the Crossroads.
3. 1060 Letter to Jin'Zil: Malaka'jin, Stonetalon 74.5, 97.9.
4. 1483 Ziz Fizziks: Windshear Crag, Stonetalon 59.0, 67.4.
5. 1489 Hamuul Runetotem: Elder Rise, Thunder Bluff 78.6, 28.6.

I don't know where 235, 264 and 1130 end. 1130 (Melor Sends Word) is most likely in Thunder Bluff. Tell me the names of the other two from your log and I will add them.

I drew a 4-stop route named "Turn-ins".

'''wowmap
{"op":"set","layer":"turnins","title":"Turn-ins","ordered":true,"loop":false,"points":[{"m":1424,"x":61.6,"y":19.2,"label":"Hinott's Assistance - Serge Hinott","kind":"turnin"},{"m":1442,"x":74.5,"y":97.9,"label":"Letter to Jin'Zil","kind":"turnin"},{"m":1442,"x":59.0,"y":67.4,"label":"Ziz Fizziks","kind":"turnin"},{"m":1456,"x":78.6,"y":28.6,"label":"Hamuul Runetotem","kind":"turnin"}]}
'''

TL;DR:
7 ready. Route on map: Tarren Mill, Jin'Zil, Ziz Fizziks, Hamuul (Thunder Bluff). Send me the names of quests 235 and 264.
```

### route-next-zone (route)

Prompt: "I am level 20. where should I go to level next, and why?"

#### opus[1m]

```text
Go to Hillsbrad Foothills now. It is a level 20–30 zone, and you can walk there from Undercity through Silverpine.

- You have a quest ready to turn in there: 2479 (Hinott's Assistance), to Serge Hinott in Tarren Mill.
- Tarren Mill has a flight path and a lot of quests for your level.
- After Hillsbrad, take the zeppelin back to Kalimdor. You have several finished quests to hand in: 1060, 1483 and 1130 in Stonetalon, and 1489 and 264 in the Barrens. That is free XP.

These quest locations come from the original game. Forever can differ, so check them in game.

TL;DR:
Go to Tarren Mill in Hillsbrad (20–30) and turn in Hinott's Assistance, then hand in your finished Stonetalon and Barrens quests.
```

#### claude-sonnet-5-5

```text
Go to Hillsbrad Foothills (Tarren Mill). It is the closest 20-30 zone from Undercity and has plenty of quests for your level.

- Turn in your ready quests (6 are marked *) before you leave, since you are already in Undercity.
- Take the Undercity flight path to Tarren Mill and pick up the quests there.
- Hillsbrad is dense with beasts, so your Skinning (187/225) will keep levelling as you go.
- Ashenvale is the alternative, but it is a long trip from Undercity.
- Shadowfang Keep is also a good dungeon at 20+ if you can find a group.

I did not check this against Forever-specific quest data, so some NPCs or quests may differ from Classic.

TL;DR: Turn in your ready quests, then fly to Tarren Mill and level in Hillsbrad Foothills from 20 to about 30.
```

### advice-talents (advice)

Prompt: "which talent tree should I use for solo questing at my level?"

#### claude-sonnet-5-5

```text
Combat (Assassination) or Subtlety are the usual picks. For solo questing at 20, go Combat: Improved Sinister Strike, Dagger/Sword Specialization, Precision and Lightning Reflexes. It gives more damage and survives better than the others.

Assassination is a fine alternative if you want faster kills with Malice and Lethality. Subtlety is weaker for questing until later.

Forever's talent layout may differ from Classic, so check the names in your tree.

TL;DR: Combat is the best pick for solo questing at 20; Assassination is the alternative.
```

#### opus[1m]

```text
Use Combat with swords. It is the safest and fastest tree for solo questing in vanilla.

- Points 1–10: Improved Sinister Strike 2/2, Lightning Reflexes 3/5, Precision 5/5
- Points 11–20: Dual Wield Specialization 5/5, then the rest into Lightning Reflexes or Deflection
- Level 30: Blade Flurry. After that, Sword Specialization 5/5.

Use a slow sword in your main hand for Sinister Strike, and a fast weapon in your off hand.

This is the standard vanilla build. Forever can change talents, so check that the tooltips match.

TL;DR:
Combat Swords: Imp Sinister Strike 2, Precision 5, Dual Wield Spec 5, then Blade Flurry at 30 and Sword Spec.
```

### advice-money (advice)

Prompt: "I only have about 21 silver. what should I spend money on first at this level?"

#### opus[1m]

```text
Spend it on class training at a rogue trainer first. Undercity's Rogues' Quarter has them, and level 20 brings new ranks. Next, buy poisons if your trainer offers them, but WoW: Forever may differ, so check there.

- Before you spend, turn in your 7 ready quests (235, 1060, 1483, 264, 1130, 1489, 2479). The silver from them likely covers training.
- Skip vendor gear and the auction house. Quest rewards and your own Leatherworking are cheaper.
- Sell spare leather or hides only after you have the leather you need for Leatherworking.

TL;DR:
Turn in your 7 ready quests, then buy level 20 rogue training in the Rogues' Quarter; poisons next if offered. Skip vendor gear.
```

#### claude-sonnet-5-5

```text
Train Rogue skills and buy a bigger bag first. Skip gear.

- Rogue trainer: at level 20 you likely have new ranks to learn. Check the Undercity trainer. Use any copper left on the cheap, useful ranks.
- Poisons: you need a Rogue level 20 quest for Poisons. Skip it for now. It costs too much.
- Bag: with Leatherworking you can craft your own. Buy Light Leather from the AH or the vendor only if you are short.
- Keep a few silver for Thistle Tea and flash powder only if you hit those levels.

I did not check this against current game data, so ranks and prices may differ.

TL;DR: Spend first on Rogue trainer skills, then a bigger bag. Keep a little silver in reserve. I did not verify prices.
```

### lore-city (lore)

Prompt: "who leads this city and what is its story, in short?"

#### claude-sonnet-5-5

```text
Sylvanas Windrunner, the Dark Lady, leads Undercity. The dreadlord Varimathras is her lieutenant.

Undercity is a vast complex of tunnels and sewers beneath the ruined Lordaeron capital. After Arthas destroyed Lordaeron, Sylvanas freed the Forsaken, undead who broke from the Lich King's control. She took the ruins as the Forsaken's home and joined them to the Horde. Her enemies are the Scourge and the Alliance, which she blames for her fall. The Apothecary Lab, under Putress, works on plague weapons there.

TL;DR: Sylvanas Windrunner rules Undercity. She led the Forsaken out of the Scourge, took the ruins under Lordaeron and joined the Horde.
```

#### opus[1m]

```text
Sylvanas Windrunner, the Banshee Queen, rules Undercity. She leads the Forsaken from the Royal Quarter.

- Undercity lies under the ruins of Lordaeron, the old human capital.
- Prince Arthas killed his father, King Terenas, and the Scourge burned the city.
- Sylvanas and other undead broke free from the Lich King. They called themselves the Forsaken and took the crypts below the city.
- They joined the Horde for convenience, not out of loyalty. The dreadlord Varimathras serves Sylvanas, and the Royal Apothecary Society works on a new plague.

TL;DR:
Sylvanas Windrunner rules. Undercity is under ruined Lordaeron, which Arthas destroyed. Her undead broke free of the Lich King and joined the Horde.
```

