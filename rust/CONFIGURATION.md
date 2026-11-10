# Rust bridge configuration reference

This is the complete user reference for the Rust bridge's JSON configuration.
Start with [config.example.json](config.example.json), or edit the `config.json`
created by native setup. In the Windows preview ZIP, this guide and the example
are included alongside the executable.

Run the bridge with the file you edited:

```powershell
.\wow-ai-reforged.exe run --config .\config.json
```

The filename is your choice; `--config` selects it. Restart the bridge after edits.
The format is strict JSON: no comments or trailing commas. Unknown top-level
and per-agent keys are rejected. Files larger than 65,536 bytes are rejected.

The JavaScript bridge's `bridge/config.json` and the upstream configuration guide
use a different schema. They are not the configuration reference for Rust.

## A typical configuration

Change the paths to match your machine. Codex is discovered automatically when
`executable` is omitted; it must be installed and logged in separately.

```json
{
  "schema_version": 1,
  "project_dir": "C:/Projects/MyAddon",
  "data_dir": "./reforged-data",
  "addon_dir": "C:/Games/World of Warcraft/_forever_/Interface/AddOns",
  "agent": "codex",
  "timeout_ms": 1800000,
  "max_output_bytes": 1048576,
  "agents": {
    "codex": {
      "model": "gpt-6.1-terra",
      "reasoning_effort": "low",
      "permission_mode": "default",
      "models": [
        {
          "id": "gpt-6.1-terra",
          "reasoning_efforts": ["low", "high"]
        }
      ]
    }
  }
}
```

`model` and `reasoning_effort` set defaults. `models` and `reasoning_efforts`
describe alternatives the addon may offer. Use IDs and efforts actually supported
by your installed provider CLI/account; Rust does not discover account entitlements
or query a model catalog. The example's model name is illustrative, not a guarantee
that your account provides it.

## Top-level options

| Key | JSON type | Required / default | Meaning |
| --- | --- | --- | --- |
| `schema_version` | integer | Required: `1` | Configuration schema version; other values are rejected. |
| `project_dir` | string | Required | Existing default working directory. Chats without an override run here. |
| `data_dir` | string | Required | Rust-owned history, session and recovery storage. Must be empty or already Rust-owned; keep it separate from legacy Node data. |
| `agent` | string | Required | Default provider: `claude`, `codex`, `grok`, `agy`, `hermes`, or `gemini`. Its executable must be discoverable for startup to succeed. |
| `addon_dir` | string or `null` | Omitted / `null` | Installed `Interface/AddOns` directory. `run --wow <client-directory>` overrides this location. |
| `saved_variables` | string or `null` | Omitted / `null` | Explicit account `SavedVariables/WoWAI.lua` file for opt-in reload fallback. See below. |
| `timeout_ms` | integer | `1800000` | Provider timeout in milliseconds; allowed range `1` through `1800000` (30 minutes). |
| `max_output_bytes` | integer | `1048576` | Combined provider stdout/stderr budget; allowed range `1024` through `16777216` bytes. This is not the chat history or reply length limit. |
| `agents` | object | `{}` | Provider settings keyed by the canonical lowercase names above. Missing providers get default settings and automatic discovery. |

`project_dir`, `data_dir`, `addon_dir`, `saved_variables`, and an explicitly
configured relative `executable` resolve relative to the JSON file's directory.
They do not resolve relative to the terminal's current directory. Use absolute
paths when convenient. `~` is supported for in-game per-chat folder selection,
not expanded in these configuration paths.

On Windows, forward slashes avoid JSON escaping: `"C:/Projects/MyAddon"`.
Backslashes must be doubled: `"C:\\Projects\\MyAddon"`.

### Reload fallback

Add this top-level option to opt in, replacing the account path:

```json
{
  "saved_variables": "C:/Games/World of Warcraft/_forever_/WTF/Account/MYACCOUNT/SavedVariables/WoWAI.lua"
}
```

This is a fragment to merge into your full config, not a complete config by itself.
Account discovery is not implemented. The file must be a fresh save since bridge
startup and match an addon session observed through a current pixel hello. After a
bridge restart, reconnect and `/reload` again if fallback is needed; Rust does not
run an old disk snapshot just because it restarted.

## Per-agent options

Each entry under `agents` accepts the following fields. All are optional.

| Key | JSON type | Default | Meaning / support |
| --- | --- | --- | --- |
| `executable` | string | Automatic discovery | Override the provider executable or supported launcher path. See discovery below. |
| `launcher_args` | array of strings | `[]` | Advanced: arguments before adapter-generated arguments, for a selected executable/script. Empty arguments are rejected. |
| `model` | string or `null` | Omitted / `null` | Provider's default model ID. An explicit empty string is rejected. If omitted, the provider CLI chooses its default. |
| `models` | array | `[]` | Configured model alternatives for the addon selector. Entries are strings or objects described below. The configured default model is included automatically. |
| `reasoning_effort` | string or `null` | Omitted / `null` | Codex default effort, such as `low`. Other adapters currently have no reasoning-effort mapping. |
| `reasoning_efforts` | array of strings | `[]` | Shared Codex effort alternatives. A model-specific list overrides this list. |
| `permission_mode` | string | `"default"` | `"default"` or `"acceptEdits"`. Provider-specific mapping is listed below. |
| `allowed_tools` | array of strings | `[]` | Claude/Grok tool rules. Other adapters reject nonempty lists because their mappings are not verified. Empty/whitespace-only rules are rejected. |
| `denied_tools` | array of strings | `[]` | Claude/Grok deny rules, with the same mapping restrictions. |
| `extra_args` | array of strings | `[]` | Advanced Codex CLI arguments appended to the generated command. Other adapters currently do not consume this field. Prefer dedicated model/effort settings. |

Use snake_case consistently. Compatibility aliases are accepted for `extraArgs`,
`reasoningEffort`, and `reasoningEfforts`; model objects also accept
`reasoningEfforts`. Do not provide both an alias and its snake_case spelling.
Legacy keys such as `permissionMode`, `defaultCwd`, `pollMs`, `gameContext`,
`primerFile`, and `networkAccess` are not Rust configuration fields.

### Models and reasoning choices

Simple alternatives can be strings:

```json
{
  "models": ["your-supported-model-id"]
}
```

For Codex, attach a separate effort list to each model:

```json
{
  "model": "gpt-6.1-terra",
  "reasoning_effort": "low",
  "reasoning_efforts": ["low"],
  "models": [
    {
      "id": "gpt-6.1-terra",
      "reasoning_efforts": ["low", "high"]
    }
  ]
}
```

Both snippets are fragments to merge under `agents.codex`. A model object accepts
`id` (string) and `reasoning_efforts` (array of strings). Non-Codex adapters expose
model alternatives only. Configured choices are declarations, not provider-side
validation; unsupported real-provider choices can still produce a CLI error.

The addon labels Codex `low` as **Light**. A chat's overrides take precedence over
config defaults. **Reset to bridge defaults** removes those overrides. Agent,
model, effort, and canonical folder changes can start a fresh backend session;
visible transcript history is preserved. Requests already admitted retain their
original settings through retries and reply recovery.

### Permission modes and tool rules

These are the current Rust adapter mappings, not a universal sandbox policy:

| Provider | `default` | `acceptEdits` | Tool rules |
| --- | --- | --- | --- |
| Claude | `--permission-mode default` | `--permission-mode acceptEdits` | `--allowedTools` / `--disallowedTools` |
| Codex | `--sandbox read-only` | `--sandbox workspace-write` | Nonempty allow/deny lists rejected |
| Grok | `dontAsk` | `dontAsk` plus Edit/Read/Grep allow rules | Translated `--allow` / `--deny` rules |
| Antigravity (`agy`) | `--mode plan` | `--mode accept-edits` | Nonempty allow/deny lists rejected |
| Hermes | Provider default | Provider default | Nonempty allow/deny lists rejected |
| Gemini | `--approval-mode default` | `--approval-mode auto_edit` | Nonempty allow/deny lists rejected |

Claude/Grok rule examples include `WebSearch`, `Bash(git:*)`, and `Bash(cargo:*)`;
actual enforcement depends on the installed provider CLI. `bypassPermissions` is
not a Rust permission mode, and Hermes is never automatically given `--yolo`.
In-game Allow & retry grants are not implemented in the Rust bridge.

### Discovery and advanced launch arguments

Omit `executable` to use provider discovery. Explicit executable paths take
precedence over environment overrides, known installation locations and PATH.
Supported Windows npm `.cmd` launchers are inspected and resolved to their underlying
command; `.cmd`/`.bat`/`.ps1` are not executed through a shell. Configure the actual
executable, a supported npm launcher, or let discovery find it.

`launcher_args` are literal arguments, not shell text; their embedded paths are
not automatically rebased to the config directory. They and Codex `extra_args`
are trusted local command configuration. Avoid overriding protocol/output,
permission, cwd, or session flags the adapter already controls. The bridge does
not validate arbitrary extra arguments as safe policy settings.

Legacy Codex `extra_args` effort overrides using `model_reasoning_effort` are
recognized for defaults. A selected effort replaces those overrides. Using
`reasoning_effort` directly is easier to understand.

## Checking changes

```powershell
.\wow-ai-reforged.exe agents --config .\config.json
.\wow-ai-reforged.exe run --config .\config.json
```

`agents` loads the config and reports discovered commands; it does not authenticate
providers or prove a model is available. Invalid JSON, unknown keys, invalid limits
or a missing default executable fail during loading. Adapter-specific tool rules
and request choices may be rejected when a request is processed. Keep the bridge
terminal visible for actionable errors.

For implementation details, the schema is in `bridge/src/config.rs` (`Config`)
and `bridge/src/agents.rs` (`AgentSettings`, `ModelConfig`).
