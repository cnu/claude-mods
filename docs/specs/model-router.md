# model-router

**Goal:** run each subagent on the cheapest model that can do its task well.

## Behaviour
1. On every subagent spawn, ask a cheap model (haiku) to classify the task as
   one of three tiers and return strict JSON `{"tier":"light|standard|heavy",
   "confidence":0..1,"reason":"..."}`. Tiers map to models via options
   (`lightModel` default haiku, `standardModel` default sonnet, `heavyModel`
   default opus).
2. Asymmetric thresholds: move a task to a *cheaper* model only when confidence
   >= `minDowngradeConfidence` (default 0.8). Move to a *stronger* model when
   confidence >= `minUpgradeConfidence` (default 0.4), because under-powering
   hurts more than overspending. Missing or unreadable confidence never
   downgrades. If the caller named a model explicitly, leave it alone.
3. Hard timeout `classifyTimeoutMs` (default 4,000): on timeout or bad JSON let
   the spawn through unchanged.
4. Never change the main chat's model. Main-chat effort routing is out of scope
   (that is `effort-optimizer`).
5. Log each decision: task summary (first 80 chars only), the model it would
   have used, the model chosen, tier, confidence, estimated cost difference,
   classifier tokens.
   Ledger (net, not gross, per docs/ledger.md; every line's `session` is the
   SANITISED session id, the same value as in the file name):
   - `cost-downgrade` only when a cheaper model than the agent's BASELINE model
     actually ran; `costUsdEstimate` = gross saving minus the classifier's cost
     (may be negative, noted).
   - `cost-upgrade` when a stronger model than the baseline actually ran:
     NEGATIVE `costUsdEstimate` (extra cost plus classifier), no `tokensAvoided`,
     a note naming both models, tier and confidence. With an unknown baseline
     the extra cost is not estimated; only the classifier's cost is logged.
   - Classifier cost: each classified spawn spends one haiku call (reported
     usage if non-zero, else ceil(chars/4) of prompt and reply, Haiku list
     price). It is folded into the decision line (`classifier-tokens: N`,
     subtracted in `costUsdEstimate`); a classified spawn with no decision line
     (kept, or the change did not take effect) gets one small negative
     `cost-upgrade` "classifier overhead" line.
   - `info` (no number): unknown baseline blocked a downgrade, or any kept
     decision when `showDecisions` is on.
   - Estimates assume a run of `assumedInputTokens` / `assumedOutputTokens`
     (60000 / 6000) at list prices cached 2026-11-03; real counts are unknown.
6. `showDecisions` option: also toast/status each decision, and ledger `info` for kept decisions.

## Agent types
Only `routedAgentTypes` (default `general-purpose`) are classified; `skipAgentTypes` (exact or `prefix*`) always wins. A model pinned inside an agent definition cannot be detected, so custom types are skipped unless listed. Spawns carrying a `workflow` marker and resumes are never classified.

## Baseline
A built-in such as `Explore` may default to a cheaper model than the parent, so the parent's model is not always what an agent would have used. The API does not reveal an agent's resolved model before the spawn. Baseline = the parent's model for `general-purpose` only; unknown for every other listed type. A "downgrade" decision and a `cost-downgrade` ledger line require the chosen model to rank below the baseline; with an unknown baseline the router only upgrades (chosen model above the parent's), claims no saving, logs ledger `info`, and an upgrade over the parent logs only the classifier's cost (the agent's own default is unknown). `Explore` and `Plan` are routed only if the person lists them.

## Options
`lightModel`, `standardModel`, `heavyModel`, `minDowngradeConfidence`,
`minUpgradeConfidence`, `classifyTimeoutMs`, `showDecisions`, `assumedInputTokens` (60000), `assumedOutputTokens` (6000), `routedAgentTypes`, `skipAgentTypes`.
