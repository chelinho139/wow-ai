# Plan: trusted game data, then a model router, shipped as a Claude Code plugin

Status: draft, revision 2 (2026-09-30), after a two-seat fresh-eyes review. Code references name functions, not line numbers. **(unverified)** marks claims nobody has checked yet.

## 1. Goals and non-goals

**Goals**
- Answers about game content come from a local, versioned, cited dataset. The web comes last and is labeled.
- Game chats stop paying Opus prices for simple questions.
- The prompt surface moves out of `bridge/*.js` into one distributable plugin (skills and agents).
- Install and upgrade take one command per OS.

**Non-goals**
- No stored NPC data. Sightings is removed by PR #23 (`chore/remove-sightings`), which is a prerequisite and not part of this plan.
- No transport, map, macro or widget protocol changes.
- No hosted service. Data is fetched and cached on the user's machine.
- v1 is **Forever only**. The addon declares `## Interface: 16001` only, so other clients do not load it and never send a `Game:` line. Other flavors wait until the addon supports them.

## 2. Order of work

Data first, router last. Each step must pay off on its own before the next one starts.

1. Pin a cheaper model for `ask` and measure (no new code).
2. Forever data sync.
3. `wowdata` MCP server, wired into `ask` runs by the bridge.
4. `wow-data` skill and prompt change, with a session reset.
5. Plugin with skills and agents. The router only goes in if step 1 to 4 numbers show a gain.
6. Installers, setup, doctor and docs.

## 3. Step 1: cheaper `ask` model, measured

- `agents.claude.model` and `agents.claude.extraArgs` already reach the `claude` argv (`agents.js`, `claude.args`). Try `claude-sonnet-5-5` for game chats through config first.
- A per-plugin override (`plugins.ask.model`) is added only if the owner wants `ask` and `claude-code` on different models.
- Measure with the real `claude` (`agentPath` set), not `dev/fake-claude.js`: 10 fixed prompts, cost and latency, against today's `opus[1m]`.
- Check `CLAUDE_RATES` in `agents.js` against the current price list in the same PR. Checked 2026-09-30: the Opus 5.5 rate was wrong ($5/$25, now $4/$20 with $0.20 cache reads).
- **Measured 2026-09-30** ([`measurements/step1-ask-model.md`](measurements/step1-ask-model.md), `dev/measure-ask.js`): one stable folder per model, as live `ask` runs use. The first turn of a new chat cost $0.233 on Opus vs $0.130 on Sonnet (1.8x, median 13.5 s vs 11.0 s). A resumed turn cost about the same on both: mean $0.031 vs $0.034, median $0.025 vs $0.016 (median 7.0 s vs 6.1 s). A cold first turn in a new folder cost $0.274 vs $0.212 (n = 1 each). New chats in a used folder still wrote about 26k cache tokens, so only resumed turns ran warm. The run stopped at its $3 budget after 6 of 10 prompts. Quality is for the owner to judge from the recorded answers; all of them use unverified game data. The default model is unchanged until then.

## 4. Step 2: trusted data for Forever

### 4.1 Sources

| Source | Gives | Risk | Freshness |
|---|---|---|---|
| wago.tools DB2 CSV, product `wow_cn_beta` | Client tables: `ItemSparse`, `TaxiNodes`, `QuestV2`, areas, `UiMap*` | wago.tools has no terms page. The real exposure is the Blizzard EULA on datamined client files **(unverified)**. Cache locally only; never commit or ship. | One build in its history so far (`1.60.1.70094`, 2026-09-29). The live client is already `1.60.1.70124`, so a mirror behind the client is normal. |
| QuestieDB `data/Forever/*` plus `src/corrections/Forever/` | NPC and object spawns, quest givers, objectives | No license on GitHub (all rights reserved by default). Fetch on the user's machine only. Ask the maintainers (open decision 3). | Daily pushes; pin a commit SHA and bump it on purpose. |
| `Gethe/wow-ui-source`, branch `forever` | Blizzard UI Lua and API docs | Mirror of Blizzard code. Clone locally. | Tracks builds |
| warcraft.wiki.gg | API pages | CC BY-SA 4.0 (siteinfo API). Cache with attribution. | Live |
| Wowhead, other wikis | — | Never cached. Web fallback only, always labeled unverified. | — |

### 4.2 Sync

- `claude-wow data sync` is a new supervisor subcommand. It runs from install, from setup, from the weekly service timer, or by hand. **It never starts from game text.**
- QuestieDB files are Lua source. The sync parses Lua table literals with a data-only parser (`luaparse`, moved from devDependencies to dependencies and bundled in the binary). It never runs the Lua.
- Each row is checked on the way in: string length limits, coordinates numeric and within 0 to 100, IDs integers. A row that fails is dropped and counted in the manifest.
- Output: `<CLAUDE_WOW_HOME>/data/forever/<build>/` with JSONL per entity (`npcs`, `objects`, `quests`, `items`, `flightpaths`, `zones`) and `manifest.json` (`source`, `url`, `commit or build`, `fetchedAt`, `license`, `rows`, `dropped`).
- Coordinates are stored as `{uiMapID, x, y}` percent. QuestieDB zone coordinates are converted with the `UiMap*` tables.
- Atomic swap: the sync writes `<build>.tmp`, then renames it, and updates a `current` pointer. A lock file stops two syncs at once.
- Any build string used in a path or URL must match `^\d+\.\d+\.\d+\.\d+$`. The flavor is a fixed enum.

## 5. Step 3: `wowdata` MCP server

- `claude-wow data-mcp`, a stdio server. Tools: `wow_where`, `wow_quest`, `wow_item`, `wow_flights`, `wow_sources`. Each takes a name or ID and an optional `uiMapID`.
- Every row returns structured fields plus `source`, `build` and `trust` (`client-data`, `community-db`, `none`). Free text (names, quest text) is data in fields, never instructions.
- It reads the `current` pointer once at start and loads each table on first use, not all 10 MB up front. Each `ask` turn is a new process.
- **The bridge wires it, not the plugin.** For `ask` runs the bridge passes `--mcp-config` with the absolute path of its own binary and `alwaysLoad: true`. That avoids PATH problems (source checkouts have no `claude-wow` command) and keeps the tool name `mcp__wowdata__*`. Plugin-bundled servers are renamed `mcp__plugin_<plugin>_<server>__*`.
- **Permissions:** `ask` runs are `claude -p --permission-mode acceptEdits --allowedTools <config>`, and headless runs deny MCP tools that are not listed. The bridge adds `mcp__wowdata` as a run-only rule in code (`P.withRunOnlyRules`), so no user config change is needed. Test it in `tests/agents_test.js`.
- A client build newer than the cached one is expected. The server labels answers `build-mismatch` and the bridge logs it once. It does not trigger a sync.

## 6. Step 4: `wow-data` skill and prompt change

- `WHERE_HINT` gains one line: use the `wowdata` tools first, cite `trust`, say "unverified" for web answers, say "I do not know, check in game" rather than invent coordinates. New Forever zones (Hyjal, Riverglades, Zephras, Shen'dralas) never use Classic data.
- `ask.js` `TOOLS` drops "use web search for current game data".
- **Session reset:** Claude Code records a chat's system prompt at its first request and reuses it on resume (`--system-prompt-snapshot`, on by default). Existing chats would keep the old prompt. The bridge stores a hash of the system prompt per session key and starts a new session when it changes, the same way it already does when the agent or plugin changes. This ships in the same PR as the prompt change, with a test in `tests/bridge_test.js`.
- The primer stays in the system prompt. It is recorded once and prefix-cached, so it costs little, and every macro answer needs its Forever API rules.

## 7. Step 5: plugin, and the router if it pays

### 7.1 Plugin contents

- Skills and agents only. No MCP servers in the plugin: the channel server stays registered as today (user scope), and `wowdata` is wired by the bridge (§5) or registered at user scope by setup for live sessions. Nothing gets renamed.
- `ask` runs load it with `--plugin-dir <assets>/plugins/claude-wow`, so the plugin matches the bridge version with no user install. Try this first through `agents.claude.extraArgs` before writing any bridge code.
- First, a one-run spike: `claude -p --plugin-dir … --output-format stream-json`, and read the tool, skill and agent lists. It answers whether `--plugin-dir` survives `--setting-sources` and whether subagent usage appears in the result's `modelUsage`.

### 7.2 Router (only if §3 to §6 measurements show a gain)

- Delegation adds turns: classify and delegate, then compose, plus a fresh subagent context. For "where is X", one Sonnet turn with `wowdata` is likely faster and cheaper. So the router covers only the heavy kinds of work:

| Request | Agent | Model |
|---|---|---|
| Lookups (where is, drops, quest steps, flights) | none: the `ask` session answers with `wowdata` | `ask` model (§3) |
| Macro, addon Lua, API questions | `claude-wow:wow-code` | `claude-sonnet-5-5` |
| Leveling route, gear, talent or profession plan, multi-quest route | `claude-wow:wow-planner` | `claude-opus-5-5` |
| Explicit deep request, full addon design | `claude-wow:wow-deep` (opt-in) | `claude-fable-5-1` |

- Plugin agents are namespaced (`claude-wow:<name>`). The skill and the eval graders use the full names.
- Subagents do not get the parent's appended system prompt. Each agent file carries the output contract it needs (`wowmacro` and `wowmap` block formats, coordinates are uiMap percent), or loads it from a shared skill reference.
- Subagents get no `Write` and no map-file access. They return `wowmap` and `wowmacro` blocks, and the `ask` session copies them verbatim.
- Agents that read `wowdata` get no `Bash` and no `WebFetch`, so injected text in third-party data cannot run commands.

## 8. Step 6: install, setup, doctor, docs

- `install.sh` and `install.ps1`: after the binary and setup, run `claude-wow data sync` for Forever. Installing the user-scope plugin for live sessions is open decision 4.
- Homebrew: `caveats` prints `claude-wow setup` **(post_install sandbox limit unverified)**.
- Codex-only users (no `claude` CLI): skip the plugin; `wowdata` can be added with `codex mcp add`.
- Doctor: flags a missing or stale data cache and a plugin version that differs from the bridge. One version source: the git tag. `package.json` (0.4.0) and the Homebrew formula (0.5.0) already disagree; fix that first.
- Docs: `INSTALL*.md`, `LIVE-SESSION.md`, `AGENTS.md`, `CONFIGURATION.md`.

## 9. Testing

- `npm test` stays free of the `claude` CLI. CI (`.github/workflows/test.yml`) has no Claude Code and no secrets. Plugin JSON and agent frontmatter are checked in plain node, including that every tool name in an agent file matches a real server name.
- `claude plugin eval` runs as a separate manual or secret-gated workflow with `--max-cost-usd` and recorded mocks for `wowdata`.
- Sync and server tests use fixture CSV and Lua files in `tests/`, with no network.

## 10. Risks

- **Licensing:** QuestieDB has no license; the EULA position on datamined client files is unverified. Fetch locally, never ship data.
- **Forever is pre-launch** (release 2026-11-04). Tables and the wago product key can change. Pin by build and commit.
- **Coverage gaps:** new Forever content is incomplete in QuestieDB. "I do not know" beats a wrong Classic proxy.
- **Third-party text:** names and quest text can carry prompt injection. Structured fields, validation at sync, and no Bash on data agents.
- **Cost:** a router can cost more than it saves. §3 measures first; §7.2 is conditional.

## 11. Decisions (2026-09-30)

1. The `ask` model is `claude-sonnet-5-5`, pending the step 1 measurement.
2. wago.tools client data is cached locally only, never committed or shipped.
3. Ask the QuestieDB maintainers for permission before step 2 ships QuestieDB data. Step 2 can start with wago data alone.
4. The installers offer the user-scope plugin and `wowdata` with a prompt; they do not install them silently.
5. `ask` runs keep inheriting the user's `~/.claude` setup for now. Revisit after step 1.
6. `wow-deep` (Fable) is opt-in behind config.
7. The TypeSafe router PRs (#6, #9) are closed. The 183 labeled cases in `evals/router/cases.jsonl` on branch `feat/router-evals` are the starting eval set for §7.2.

## 12. Ready to start: step 1

- [x] Set `agents.claude.model` to `claude-sonnet-5-5` in a test config (`dev/sandbox.js` with `agentPath` pointing at the real `claude`).
- [x] Run 10 fixed game prompts (where-is, macro, route, lore) on `opus[1m]` and on Sonnet 5.5. Record cost from the result's `modelUsage` and latency per prompt.
- [x] Check `CLAUDE_RATES` in `bridge/agents.js` against the current price list and fix it in the same PR.
- [x] Write the numbers into this file under §3.
- [ ] If Sonnet quality holds (owner's call, from the answers in `measurements/step1-ask-model.md`), set it in `config.example.json` and the owner's config.
