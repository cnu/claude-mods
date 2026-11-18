# model-router

Runs each subagent on the cheapest model that can do its task well.

When a subagent is about to start, a cheap model (`haiku`) reads the task and
labels it `light`, `standard` or `heavy`, with a confidence between 0 and 1. The
tier maps to a model through the options. The subagent is moved to that model
only when the confidence clears the bar for that direction:

- **Cheaper model:** confidence must be at least `minDowngradeConfidence`
  (default 0.8). A missing or unreadable confidence never downgrades.
- **Stronger model:** confidence must be at least `minUpgradeConfidence`
  (default 0.4). The bar is lower on purpose, because under-powering a task
  costs more than overspending on it. A missing confidence counts as 0 here.
- **Same family, or a model the router cannot place** (not haiku, sonnet, opus
  or fable): unchanged.

The router leaves a spawn alone, without asking the classifier, when:

- the caller named a model (`Agent({ model })`)
- it is a fork, which always inherits the parent's model
- it resumes an existing agent
- it is a workflow agent (a workflow script's `agent()` call, `e.workflow`): its
  prompt may be a fixed placeholder and its content is the script's
- the task is empty
- the agent type is not routed: only the types in `routedAgentTypes` (by default
  just `general-purpose`) are touched, and anything in
  `skipAgentTypes` never is (see "Agent types" below)

It never changes the main chat's model. Main-chat effort is out of scope; that
is `effort-optimizer`.

## Options

| Option | Default | Meaning |
|---|---|---|
| `lightModel` | `haiku` | Model for light tasks |
| `standardModel` | `sonnet` | Model for standard tasks |
| `heavyModel` | `opus` | Model for heavy tasks |
| `minDowngradeConfidence` | 0.8 | Confidence needed to move to a cheaper model |
| `minUpgradeConfidence` | 0.4 | Confidence needed to move to a stronger model |
| `classifyTimeoutMs` | 4000 | Hard time limit on the classifier call |
| `showDecisions` | false | Also show each decision as a toast (decisions always go to the debug log) |
| `assumedInputTokens` | 60000 | Input tokens of the typical run the cost estimate assumes (see "Cost estimates") |
| `assumedOutputTokens` | 6000 | Output tokens of that typical run |
| `routedAgentTypes` | `general-purpose` | Agent types the router may reroute. Comma-separated; exact names or `prefix*` |
| `skipAgentTypes` | empty | Agent types never rerouted. Same syntax. Wins over `routedAgentTypes` |

## Agent types

The router cannot see an agent definition's own model (see Limitations), so it
does not guess: a spawn is classified only when its type is listed.

- Default: only `general-purpose` is routed. It inherits the parent's model, so
  the parent is its real baseline. Every other type is passed through untouched,
  including `Explore` and `Plan` (a built-in may default to a cheaper model than
  the parent, and moving it to Sonnet could raise the cost), plugin agents
  (names like `lab:runner`) and custom agents, which may pin a model.
- To route another type, name it in `routedAgentTypes`, which replaces the
  default list (keep `general-purpose` in it if you still want it). `lab:*`
  routes every type starting `lab:`; a lone `*` routes everything.
- **Baseline rule.** A saving is claimed (a "downgrade" decision and a
  `cost-downgrade` ledger line) only when the chosen model ranks below the
  agent's baseline model. The API does not reveal an agent's resolved model before
  the spawn, so the baseline is the parent's model for `general-purpose` and
  unknown for every other listed type. For an unknown baseline the router only
  moves a spawn UP (the chosen model must rank above the parent's), never claims
  a saving, logs `n/a (baseline unknown)` and writes a ledger `info` line
  (`kept`) when it declined to move it.
- `skipAgentTypes` wins when a type matches both lists, and works on built-ins
  too (`Plan`, or `Exp*`).
- Matching is case-sensitive. A blank or unreadable value falls back to the
  default; a blank `skipAgentTypes` means none.
- The decision log shows `passthrough (agent-type-not-routed)` or
  `passthrough (agent-type-skipped)` for these spawns, and no classifier call is
  made.

## Failure behaviour

If the classifier call times out, errors, is refused, returns nothing, or
returns anything other than one JSON object with a known tier, the subagent
starts unchanged. A failure inside the router itself does the same. The time
limit is the engine's own `timeoutMs` on `$.model.complete`.

## What it logs

- **Claude Code's debug log** (`$.ui.log` with `to: "debug"`, so the chat
  stays clean; read it with `claude --debug` or the debug log file), one line
  per spawn:
  - the first 80 characters of the task
  - the model it would have used
  - the model chosen
  - the tier and confidence
  - a rough cost difference and the classifier's own tokens (`classifier-tokens=N`)
  - the classifier's short reason
- **Savings ledger** `~/.claude/claude-mods/ledger/model-router.<session-id>.jsonl`
  (one file per session, written only by this mod; characters outside letters,
  digits, `_` and `-` in the id become `_`, so no dots, at most 80 characters; no
  ledger without `HOME` or a session id; a read error other than "file missing"
  turns the ledger off for that session; only JSON-object lines with a `mod` are
  kept; after `/clear` the new session id is picked up before the next write,
  the old file being written first). Each line has `mod: "model-router"` and
  the `session`, which is the SANITISED id, the same value as in the file name.
  Following `docs/ledger.md`, entries hold model names, tier, confidence and
  token counts, never task text. Every estimate is net of the classifier's own
  cost (see "Cost estimates"):
  - `cost-downgrade`: a `general-purpose` subagent actually started on a cheaper
    model than the parent's. `costUsdEstimate` is the gross saving minus the
    classifier's cost, so it can be negative (the note says so).
  - `cost-upgrade`: a `general-purpose` subagent actually started on a stronger
    model. `costUsdEstimate` is NEGATIVE (the extra cost plus the classifier's);
    `tokensAvoided` is absent. The note names both models, the tier and the
    confidence. For a listed type with an unknown baseline that was moved up, the
    extra cost cannot be estimated, so only the classifier's cost is logged
    (negative) and the note says the move happened.
  - `cost-upgrade` is also how the classifier's own cost is logged when no
    decision line carries it: every classified spawn that was kept, or whose
    change did not take effect, gets one small negative line
    (`classifier overhead ...`). A spawn that skipped the classifier costs
    nothing and logs nothing.
  - `info` (no number): a listed type with an unknown baseline was kept, or,
    only when `showDecisions` is on, any other kept decision.

## Cost estimates

The ledger figures are rough and labelled so. Their assumptions:

- **Run size.** Real token counts are unknown when a subagent starts, so a model
  change is priced for a typical run of `assumedInputTokens` (default 60000) and
  `assumedOutputTokens` (default 6000). Change them to match your own agents;
  a notes line states the run it assumed.
- **Prices.** List prices per million tokens (input / output), current model of
  each family, cached on 2026-11-03: Haiku 5.5 $0.10 / $0.50, Sonnet 5.5
  $2 / $10, Opus 5.5 $4 / $20, Fable 5.2 $8 / $40. They go stale; older ids in a
  family are priced as the current one. Caching, batch discounts and a forced
  session model are ignored.
- **Classifier cost.** Each classified spawn spends one `haiku` call. Its tokens
  are the API's reported usage when it is non-zero (cache reads and writes
  counted as input), else ceil(chars / 4) of the system and task prompt plus the
  reply (a refused request counts as nothing, a timed-out or errored one as its
  prompt only). The price is Haiku's. The choice made: the cost is FOLDED INTO the
  decision line (`classifier-tokens: N` in the note, subtracted from
  `costUsdEstimate`), and it gets a line of its own only when no decision line
  exists. `tokensAvoided` is never written: the mod works in dollars.
  The same token count is also written to `helperTokens` (>= 0, the classifier's
  input plus output tokens) on every decision and overhead line, kept apart from
  the dollars: tokens are not netted and `costUsdEstimate` is unchanged. Lines
  with no classifier call behind them (`info`) have no `helperTokens`.
  A downgrade that saves less than its classifier cost is still logged, with a
  negative net.
- Anything with an unknown model family gets no number.

## Limitations (read these)

- **An agent's own model is invisible.** When the caller names no model, the
  engine uses the agent definition's model, then the parent's. The hook API
  exposes only the parent's model (`parentModel`). Checked against the
  `claude-code.d.ts` of 2.1.321: `agent.spawn` input, `agent.offer` input
  (`agent`, `description`, `source`, `provider`), `$.agent.list()` entries
  (`id`, `type`, `status`, `name`, ...) and `$.agent.register` (writes a
  definition, does not read one) carry no model field, and there is no call that
  returns a definition. So a pinned model is not detectable, and the router
  cannot skip "when the definition pins a model". What is detectable: the type
  name and, from `provider`, who supplies it, which is why routing is an
  allow-list of types (see "Agent types"). For a listed type
  other than `general-purpose` the baseline is therefore unknown: the router only
  moves it up, claims no saving, and the "would-use" value in the log is
  `parentModel` labelled as a guess.
- **Cost figures are rough estimates.** Token counts are unknown when a subagent
  starts. The figure assumes a typical run (60k input and 6k output tokens by
  default, set by `assumedInputTokens` and `assumedOutputTokens`) at list prices
  cached on 2026-11-03. It ignores caching and a forced session model. See "Cost
  estimates".
- **Prompt injection is reduced, not removed.** The task text is placed between
  delimiters it cannot close, and the system prompt tells the classifier to treat
  it as data. A crafted task can still talk the classifier into a confident
  `light` label and get itself a weaker model. The cost of that is a weaker
  subagent, not extra permissions.
- **Every routed spawn costs one small haiku call**, which the ledger counts against the savings, and adds up to
  `classifyTimeoutMs` of delay before the subagent starts.
- **Workflow agents** (`e.workflow`) are never classified or rerouted: the
  prompt can be a placeholder, and the API applies only a prompt or model
  rewrite to them.
- **A session-forced subagent model wins.** If the session forces one model on
  every subagent, the hook's choice is overridden. The log and the ledger use the
  model that actually started.
- **Family matching is by name.** A model id without `haiku`, `sonnet`, `opus`,
  `fable` or `mythos` in it (some gateways) is never rerouted.
- **Not exercised live.** It was checked offline only:
  - `claude plugin validate`
  - a TypeScript typecheck
  - `claude plugin test` with a mocked engine (type filters and the per-session
    ledger path are covered there; the engine's real agent definitions and a real
    session id are not)
