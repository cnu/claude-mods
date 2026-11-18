# claude-mods

Eight token-saving mods for Claude Code, written independently against the public mod API. MIT licensed.

## Install

```
/plugin marketplace add cnu/claude-mods
/plugin install cache-clock@cnu-mods
/plugin install effort-optimizer@cnu-mods
/plugin install handoff@cnu-mods
/plugin install input-router@cnu-mods
/plugin install model-router@cnu-mods
/plugin install research-router@cnu-mods
/plugin install savings-proof@cnu-mods
/plugin install mods@cnu-mods
```

Install only the ones you want. To develop or try a mod from a local checkout, use `claude --plugin-dir plugins/<mod>`.

## The mods

| Mod | What it does | Main caveat |
|---|---|---|
| `cache-clock` | Countdown to the prompt cache going cold; optional keep-warm pings; offers `/refresh` on a big cold chat | Cache lifetime is detected only from model-switch/resume signals, else assumed 5 min; set `ttlMinutes` to override |
| `handoff` | At a token threshold writes a handoff note for a fresh chat (`/refresh`) | "Clear and continue" is destructive and needs a second press |
| `input-router` | A cheap model digests big Read and MCP results (optionally Bash); instruction files always pass whole | Saved full copies may contain secrets; swept after `retentionDays` |
| `research-router` | Condenses big web results; `/research-router` runs a small research job | Command web calls go through the permission check and a private-address filter |
| `model-router` | Routes `general-purpose` subagents to a cheaper/stronger model by classifier | Cannot see a model pinned inside an agent definition |
| `effort-optimizer` | Suggests or applies a reasoning-effort level per prompt | Cannot change the session's own effort setting; overrides per request |
| `savings-proof` | `/savings` pane summarising the shared ledger | Shows avoided tokens, helper tokens and a signed estimated dollar figure side by side; all estimates |
| `mods` | `/mods` pane listing installed mods and toggling them in user settings | Needs a restart; backs up `settings.json` first |

Each plugin folder has its own README with options, behaviour and limitations.

## Shared ledger

Mods that save tokens write estimates to `~/.claude/claude-mods/ledger/<mod>.<session-id>.jsonl`. Contract and rules: [docs/ledger.md](docs/ledger.md).

## Developing

Specs: [docs/specs/](docs/specs/). Offline validate / typecheck / test commands and gotchas: [docs/toolchain.md](docs/toolchain.md).

## Known gaps

- Dollar figures use list input prices from a table dated 2026-11-03 and ignore caching; token figures are intentionally not netted (see [docs/ledger.md](docs/ledger.md)).
- Subagent tool calls routed by `input-router` carry no dollar estimate (the subagent's model is not exposed).
- No `tsc` output is saved with the final test run; the type check was run per mod by each implementer.

License: [MIT](LICENSE).
