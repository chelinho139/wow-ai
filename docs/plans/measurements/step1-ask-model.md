# Step 1 measurement: `ask` on Opus 5.5 vs Sonnet 5.5

Plan: [`router-and-game-data.md` §3 and §12](../router-and-game-data.md). Raw results: [`step1-ask-model.json`](step1-ask-model.json). The JSON records `claudeVersion` (2.1.286), `ranAt` (2026-10-01T01:21:51Z), `claudePath` (`~/.local/bin/claude`) and, per run, the full argv with the system prompt replaced by its size and SHA-256.

## Result

Three kinds of turn, priced separately. Mean cost per turn, error runs left out:

| Turn | Opus 5.5 | Sonnet 5.5 | Ratio |
|---|---|---|---|
| Cold first turn (new folder, n = 1 each) | $0.274 | $0.212 (did a web search) | not comparable |
| First turn of a new chat in a used folder | $0.233 (n = 4) | $0.130 (n = 5) | **1.8x** |
| Resumed turn in the same chat | $0.031 (n = 5), median $0.025 | $0.034 (n = 6), median $0.016 | **about the same** |

- **A new chat costs about the same with or without a warm folder.** Each new session in the same folder still wrote about 26k tokens to cache and read only 18.2k. Only a resumed turn reads the whole prefix (about 44k) from cache.
- **Resumed turns are cheap on both models**: $0.02 to $0.04. One Sonnet resumed turn (`macro-pickpocket`) missed the cache and cost $0.115; it sets the Sonnet mean.
- **Latency (median wall time)**: new chat 13.5 s Opus vs 11.0 s Sonnet; resumed turn 7.0 s vs 6.1 s.
- **Quality is for the owner to judge** from the answers below. Every answer names game nouns from model memory, so every answer is **unverified**.
- **Recommendation:** Sonnet 5.5 saves about $0.10 on the first turn of each chat and little after that. Switch only if the answers below hold up. The default model in config is not changed by this PR.

## Method

- Script: `node dev/measure-ask.js --budget 2.68`. Headless `-p --output-format stream-json --verbose`, with the real `claude` from `A.resolveCommand` (never `dev/fake-claude.js`).
- Same shape as a bridge `ask` run: config from `dev/sandbox.js` `buildConfig` (so `bridge/config.example.json`'s `agents.claude` block), argv from `AGENTS.claude.args`, stdin from `AGENTS.claude.input`, env from `AGENTS.claude.env`, system prompt from `P.systemPrompt(ctx, primer, { tools: ask.tools, surfaces: ask.surfaces })`, message from `P.messagePrompt`. The system prompt was byte-identical on all 23 runs (one SHA-256).
- One stable folder per model for the whole run, like the live `ask` scratch folder. The first run in it is `cold-first`; later new sessions are `warm-first`.
- After each first turn, the script resumes that session (`--resume <session_id>`, the same system prompt and situation block) with the follow-up "thanks. in one sentence, what is the first thing I should do?" (`resumed`).
- Cost is Claude Code's `total_cost_usd`. On a resumed run that field and `modelUsage` are the **session total**, so a resumed turn's cost is the session total minus the first turn's. The bridge's `claudeCost` matched to the cent, except $0.01 per web search.
- Tools: `--permission-mode acceptEdits --allowedTools WebSearch WebFetch Bash(git:*) …` as in `config.example.json`. The owner's own `config.json` allows more, so live runs can differ.
- Extra flag for the measurement only: `--max-budget-usd` (at most $1 of new spend per run).
- Situation block: the context the live addon last reported for Bone (level 20 Orc Rogue, Horde, Undercity, client 1.60.1.70124), copied verbatim into the script.
- Prompt order alternates (Opus first on odd prompts, Sonnet first on even ones).
- The runs inherit the user's `~/.claude` setup (plan decision 5), the same as live `ask` runs.

## Limits

- **Stopped at the budget.** Total spend $3.01: $0.31 on an aborted first attempt that counted session totals as turn cost, and $2.70 here. 23 runs covered 6 of 10 prompts; `route-next-zone`, `advice-talents`, `advice-money` and `lore-city` did not run.
- `route-turnins` on Opus hit its per-run cap (`error_max_budget_usd`) with no answer. It is left out of the means.
- n = 1 per prompt per phase. Cold-first is one run per model, and Sonnet's did a web search (144.6k tokens read), so those two are not comparable.
- I did not find why a new session in a used folder writes about 26k tokens again. The measured cost is what a live new chat pays today.
- Web search costs $10 per 1,000 searches. The bridge's `claudeCost` leaves that fee out.

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

Every answer below names items, NPCs, spells, zones, quests or coordinates from model memory (Classic data at best), so all of them are **unverified** for Forever. Notes I can check against the prompt itself, without game knowledge:

- `where-skinning`, Opus resumed: says Skinning is 187/225 and not capped. That matches the situation block; the prompt said "capped at 225".
- `route-turnins`, Sonnet: lists the 7 ready quest IDs (235, 1060, 1483, 264, 1130, 1489, 2479). That matches the `*` marks. It declined to route them without names.
- `where-skinning`: the two models name different trainer spots; Sonnet named none.
- `where-trainer`: Opus marked a spot from memory; Sonnet searched the web, found no coordinates and marked nothing.
- Map marks written: Opus 2 (`where-trainer`, `where-fishing`), Sonnet 0.

## Numbers

| Model | Phase | Runs (errors) | Total cost | Mean cost | Mean cache write / read | Median wall latency | Mean answer length |
|---|---|---|---|---|---|---|---|
| opus[1m] | cold-first | 1 (0) | $0.2744 | $0.2744 | 32.8k / 10.3k | 13.3 s | 635 chars |
| opus[1m] | warm-first | 4 (1) | $1.2092 | $0.2327 | 26.6k / 18.2k | 13.5 s | 530 chars |
| opus[1m] | resumed | 5 (0) | $0.1531 | $0.0306 | 2.2k / 44.5k | 7.0 s | 156 chars |
| claude-sonnet-5-5 | cold-first | 1 (0) | $0.2119 | $0.2119 | 36.4k / 144.6k | 21.8 s | 474 chars |
| claude-sonnet-5-5 | warm-first | 5 (0) | $0.6497 | $0.1299 | 26.4k / 36.2k | 11.0 s | 489 chars |
| claude-sonnet-5-5 | resumed | 6 (0) | $0.2032 | $0.0339 | 6.0k / 40.6k | 6.1 s | 246 chars |

| Prompt | Phase | Model | Cost | Cache write / read | Wall latency | Answer length | Tools |
|---|---|---|---|---|---|---|---|
| where-trainer | cold-first | opus[1m] | $0.2744 | 32.8k / 10.3k | 13.3 s | 635 chars | none |
| where-trainer | resumed | opus[1m] | $0.0421 | 3.4k / 43.2k | 9.9 s | 257 chars | none |
| where-trainer | cold-first | claude-sonnet-5-5 | $0.2119 | 36.4k / 144.6k | 21.8 s | 474 chars | ToolSearch, WebSearch |
| where-trainer | resumed | claude-sonnet-5-5 | $0.0162 | 1.1k / 46.7k | 6.8 s | 253 chars | none |
| where-skinning | warm-first | claude-sonnet-5-5 | $0.1132 | 24.7k / 18.2k | 13.4 s | 410 chars | none |
| where-skinning | resumed | claude-sonnet-5-5 | $0.0257 | 4.0k / 42.9k | 5.1 s | 243 chars | none |
| where-skinning | warm-first | opus[1m] | $0.2300 | 26.8k / 18.2k | 10.9 s | 402 chars | none |
| where-skinning | resumed | opus[1m] | $0.0247 | 1.5k / 44.9k | 6.5 s | 179 chars | none |
| where-fishing | warm-first | opus[1m] | $0.2306 | 26.7k / 18.2k | 10.4 s | 567 chars | none |
| where-fishing | resumed | opus[1m] | $0.0235 | 1.5k / 44.9k | 5.9 s | 113 chars | none |
| where-fishing | warm-first | claude-sonnet-5-5 | $0.1142 | 26.0k / 18.2k | 11.0 s | 520 chars | none |
| where-fishing | resumed | claude-sonnet-5-5 | $0.0158 | 1.5k / 44.2k | 5.4 s | 233 chars | none |
| macro-opener | warm-first | claude-sonnet-5-5 | $0.1107 | 26.0k / 18.2k | 7.6 s | 341 chars | none |
| macro-opener | resumed | claude-sonnet-5-5 | $0.0157 | 1.2k / 44.2k | 11.2 s | 229 chars | none |
| macro-opener | warm-first | opus[1m] | $0.2305 | 26.8k / 18.2k | 16.1 s | 515 chars | none |
| macro-opener | resumed | opus[1m] | $0.0228 | 1.5k / 45.0k | 7.6 s | 109 chars | none |
| macro-pickpocket | warm-first | opus[1m] | $0.2397 | 26.3k / 18.2k | 20.1 s | 634 chars | none |
| macro-pickpocket | resumed | opus[1m] | $0.0401 | 3.3k / 44.5k | 7.0 s | 121 chars | none |
| macro-pickpocket | warm-first | claude-sonnet-5-5 | $0.1099 | 26.0k / 18.2k | 6.9 s | 546 chars | none |
| macro-pickpocket | resumed | claude-sonnet-5-5 | $0.1146 | 27.1k / 18.2k | 7.7 s | 222 chars | none |
| route-turnins | warm-first | claude-sonnet-5-5 | $0.2017 | 29.2k / 108.3k | 18.4 s | 629 chars | ToolSearch, WebSearch |
| route-turnins | resumed | claude-sonnet-5-5 | $0.0152 | 1.2k / 47.4k | 4.7 s | 294 chars | none |
| route-turnins | warm-first | opus[1m] | $0.2784 | 26.8k / 18.2k | 25.7 s | 0 chars | ToolSearch (error: error_max_budget_usd) |

## Answers

Verbatim `result` text. Triple backticks inside an answer are shown as `'''`. All answers are unverified (see Flags).

### where-trainer (where-is)

Prompt: "where is my class trainer in this city?"

Follow-up: "thanks. in one sentence, what is the first thing I should do?"

#### opus[1m], cold-first

```text
Your rogue trainers are in the Rogues' Quarter, in the east part of Undercity, at about 84, 72. They are Carolyn Ward, Miles Dexter and Josef Gregorian. From the Canals, go east and then south down the ramp into the Quarter.

These coordinates come from Classic data and can be a little off in Forever. I marked the spot on your map.

'''wowmap
{"op":"set","layer":"trainer","title":"Rogue Trainers","points":[{"m":1458,"x":84,"y":72,"label":"Rogue Trainers (Rogues' Quarter)","kind":"trainer"}]}
'''

TL;DR:
Rogue trainers are in the Rogues' Quarter, east Undercity, at about 84, 72 (Carolyn Ward and others). I marked it on your map.
```

#### opus[1m], resumed

```text
Go to the Rogues' Quarter (84, 72) and train your new level 20 skills. If you are short on gold, turn in your 7 completed quests first.

TL;DR:
Train your level 20 skills at the Rogues' Quarter (84, 72). Short on gold? Turn in your 7 completed quests first.
```

#### claude-sonnet-5-5, cold-first

```text
Your rogue trainers are in the Rogues' Quarter: Carolyn Ward (up to level 40), Miles Dexter and Gregory Charles. I found no exact coordinates, so I haven't marked the map. Look for the rogue-class icon on the Undercity map (press M).

Sources:
https://warcraft.wiki.gg/wiki/Rogue_trainers
https://warcraft.wiki.gg/wiki/Miles_Dexter

TL;DR: Rogue trainers (Carolyn Ward, Miles Dexter, Gregory Charles) are in the Rogues' Quarter. I found no coordinates, so nothing is marked.
```

#### claude-sonnet-5-5, resumed

```text
Go to the Rogues' Quarter and train your level 20 skills (you have 21s 29c, so it may not cover everything), then turn in your seven ready quests.

TL;DR: Train at the Rogues' Quarter trainer first, then turn in your ready quests (marked * in your log).
```

### where-skinning (where-is)

Prompt: "my skinning is capped at 225. where do I train the next rank?"

Follow-up: "thanks. in one sentence, what is the first thing I should do?"

#### claude-sonnet-5-5, warm-first

```text
You can't train it yet. Artisan Skinning (225 to 300) needs level 35, and you are level 20.

At level 35, train it at any Skinning trainer, such as the ones in Orgrimmar, Thunder Bluff or Undercity. I don't know the exact Undercity trainer or spot, so I haven't marked one.

TL;DR: Artisan Skinning needs level 35 (you're 20). Train it then at any Skinning trainer, e.g. in Orgrimmar. Keep skinning until then.
```

#### claude-sonnet-5-5, resumed

```text
Turn in your finished quests (235, 1060, 1483, 264, 1130, 1489, 2479) before anything else, since you're already in the city.

TL;DR: Turn in the 7 ready quests (235, 1060, 1483, 264, 1130, 1489, 2479) first, then keep skinning until level 35.
```

#### opus[1m], warm-first

```text
You cannot train it yet, because Artisan Skinning (225 to 300) needs character level 35 and you are 20. At level 35, any city skinning trainer can teach it. In Undercity, that is Killian Hagey in the Rogues' Quarter, at about 70, 58. These are Classic rules, so Forever may differ.

TL;DR:
Artisan Skinning needs level 35 (you are 20). Then train with Killian Hagey, Undercity Rogues' Quarter, ~70, 58.
```

#### opus[1m], resumed

```text
Your Skinning is 187/225, so it is not capped yet: keep skinning beasts until you reach 225.

TL;DR:
Skinning is 187/225, not capped yet: keep skinning beasts until you reach 225.
```

### where-fishing (where-is)

Prompt: "where can I buy a fishing pole near here?"

Follow-up: "thanks. in one sentence, what is the first thing I should do?"

#### opus[1m], warm-first

```text
Lizbeth Cromwell, the fishing supplier, sells the Fishing Pole for about 23 copper. She stands next to Armand Cromwell, the fishing trainer, near 80.6, 31.0 in the Canals on the east side. I took that spot from Classic data, and Forever spawns can differ.

TL;DR:
Fishing Pole: Lizbeth Cromwell, Undercity Canals east, about 80.6, 31.0 (beside trainer Armand Cromwell). Marked on your map.

'''wowmap
{"op":"set","layer":"fishing","title":"Fishing Pole vendor","points":[{"m":1458,"x":80.6,"y":31.0,"label":"Lizbeth Cromwell - Fishing Supplies","kind":"vendor"}]}
'''
```

#### opus[1m], resumed

```text
TL;DR:
Walk east through the Canals to Lizbeth Cromwell at about 80.6, 31.0 and buy the Fishing Pole (about 23c).
```

#### claude-sonnet-5-5, warm-first

```text
Try the Cromwells in the Trade Quarter, the south-west part of Undercity. I think Armand Cromwell trains Fishing there and Lizbeth Cromwell sells poles, but I haven't verified either name or their spots on this client. I haven't marked the map.

If they don't sell poles, Orgrimmar has a fishing supplies vendor near its fishing trainer, and so do most Horde towns with a trainer.

TL;DR: Probably Lizbeth Cromwell, Trade Quarter in Undercity (unverified). Check the Fishing trainer, Armand Cromwell, if she's not there.
```

#### claude-sonnet-5-5, resumed

```text
Turn in your finished quests first (you have several ready), then go to the Trade Quarter and ask the Cromwells for a pole.

TL;DR: Hand in your ready quests first, then visit the Trade Quarter for a fishing pole (vendor unverified).
```

### macro-opener (macro)

Prompt: "make me a macro that opens with my stun when I am stealthed and uses my normal combo point builder when I am not"

Follow-up: "thanks. in one sentence, what is the first thing I should do?"

#### claude-sonnet-5-5, warm-first

```text
'''wowmacro StealthOpen
#showtooltip
/cast [stealth] Cheap Shot; Sinister Strike
'''

Stealthed, it casts Cheap Shot. Otherwise it casts Sinister Strike. If you use daggers, replace Sinister Strike with Backstab.

TL;DR: Macro "StealthOpen" casts Cheap Shot while stealthed and Sinister Strike otherwise. Swap in Backstab if you use daggers.
```

#### claude-sonnet-5-5, resumed

```text
Click the macro button in the chat to create "StealthOpen", drop it on your action bar, then use it from stealth on your next target.

TL;DR: First, create the StealthOpen macro with the chat button and put it on your action bar.
```

#### opus[1m], warm-first

```text
Cheap Shot is your stealth stun, but in vanilla you learn it at level 26, and you are 20. Until then, change "Cheap Shot" to "Garrote" in the macro. WoW: Forever may train it at a different level.

'''wowmacro Opener
#showtooltip
/startattack
/cast [stealth] Cheap Shot; Sinister Strike
'''

In stealth, it casts Cheap Shot. Out of stealth, it casts Sinister Strike and starts auto-attack.

TL;DR:
Macro: Cheap Shot in stealth, otherwise Sinister Strike. You learn Cheap Shot at 26, so use Garrote in it until then.
```

#### opus[1m], resumed

```text
TL;DR:
Click the addon's macro button, change "Cheap Shot" to "Garrote" in the macro, and put it on your bar.
```

### macro-pickpocket (macro)

Prompt: "macro: pick pocket my target, then start attacking it"

Follow-up: "thanks. in one sentence, what is the first thing I should do?"

#### opus[1m], warm-first

```text
Press it twice from stealth. The first press picks the pocket. The second press opens with Garrote, which also starts your auto-attack.

'''wowmacro PickOpen
#showtooltip
/castsequence reset=target/combat Pick Pocket, Garrote
/startattack [nostealth]
'''

I did not put Pick Pocket and the attack on one press. The attack can break stealth before the loot comes through. Turn on Auto Loot so the loot window does not stall you. You get Cheap Shot at level 26; then you can change Garrote to Cheap Shot.

TL;DR:
Macro PickOpen: in stealth, press 1 picks the pocket, press 2 opens with Garrote and starts auto-attack. Turn on Auto Loot.
```

#### opus[1m], resumed

```text
TL;DR:
Click the PickOpen button the addon shows to create the macro, then drag it from your cursor onto your action bar.
```

#### claude-sonnet-5-5, warm-first

```text
Pick Pocket needs stealth, so the macro stealths you first if you aren't already. Attack follows once Pick Pocket lands.

'''wowmacro PickAttack
#showtooltip Pick Pocket
/cast [nostealth] Stealth
/cast [stealth,harm] Pick Pocket
/startattack [harm]
'''

Press it once to stealth, press it again to pick pocket and start attacking. Pick Pocket takes you out of stealth only on a failure. Attacking right after it is fine.

TL;DR: Macro "PickAttack": stealths, then Pick Pocket on your target, then auto-attacks. Press it twice from out of stealth.
```

#### claude-sonnet-5-5, resumed

```text
Click the macro button to create "PickAttack", drag it to your action bar, then press it once to stealth.

TL;DR: Create the PickAttack macro, put it on your bar, and press it once to stealth before you use it on a target.
```

### route-turnins (route)

Prompt: "which quests in my log are ready to turn in, and in what order should I hand them in? mark the route on my map"

Follow-up: "thanks. in one sentence, what is the first thing I should do?"

#### claude-sonnet-5-5, warm-first

```text
Seven quests are ready to turn in, but I couldn't look up where each one is handed in, so I haven't marked the map. My search didn't find the turn-in NPCs. I won't guess at coordinates or an order.

Ready (quest IDs): 235, 1060, 1483, 264, 1130, 1489, 2479.

- **Hand in first:** anything whose NPC is in Undercity, since you're standing there.
- **How to find the rest:** open the quest log and click each quest. Or tell me the quest names and I'll route them.

TL;DR: Ready quest IDs are 235, 1060, 1483, 264, 1130, 1489 and 2479. I couldn't find their turn-in NPCs, so no route is drawn. Send me the names and I'll route them.
```

#### claude-sonnet-5-5, resumed

```text
Open your quest log and check which of the seven ready quests name an Undercity NPC, then hand those in first because you're already standing in Undercity.

TL;DR: Open the quest log, find the ready quests whose turn-in NPC is in Undercity, and hand those in first. I don't know which they are.
```

#### opus[1m], warm-first

```text
(no answer)
```

