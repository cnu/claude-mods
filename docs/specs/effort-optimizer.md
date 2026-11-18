# effort-optimizer

**Goal:** most prompts do not need maximum reasoning effort. Pick the level
each prompt needs.

## Behaviour
1. On each submitted prompt, decide an effort level (`low`, `medium`, `high`,
   `xhigh`, `max`) from four questions, answered cheaply (heuristics first,
   optionally one small-model call when `useModel` is on):
   (a) is it a lookup, rename or mechanical edit? (b) does it need multi-step
   planning? (c) is the code or domain unfamiliar or ambiguous? (d) is a wrong
   answer expensive (data loss, production, security)?
   Suggested mapping: only (a) -> low; none -> medium; (b) or (c) -> high;
   (b) and (c), or (d) -> xhigh; leave `max` to the person.
2. Mode `suggest` (default): if the pick differs from the current effort, show
   a one-line offer "Switch to <level>" with a button. Mode `auto`: switch by
   itself and show a toast. Mode `off`: do nothing.
3. Never switch DOWN or sideways twice inside `cooldownTurns` (default 2),
   because a mid-chat effort change can invalidate the prompt cache. An UPGRADE
   (a riskier prompt than the active level) is never held back by the cooldown.
   A Switch pressed mid-turn is queued for the next turn. Explain this in the README.
4. A person-chosen level wins in `auto` mode unless `respectManual` is off,
   for `manualHoldTurns` turns (default 10, 0 = until /clear), counted from the
   turn it was noticed; a new change restarts the hold. A level change made
   together with a model change (the model id on the first request of the turn
   differs from the previous turn's) is not counted as the person's: the model's
   default effort moved. Limit: a manual change in that same boundary is missed.
   During a hold the only switch applied is an UPGRADE for a costly prompt
   (question d), capped at `xhigh`, never down; everything else waits.
   The hold exists only in `auto` mode with `respectManual` on: with it off,
   nothing is recorded or capped; in `suggest` mode the hold never caps or
   suppresses an offer (offer and decision use the same uncapped pick).
5. `/effort-optimizer on|off|auto|suggest` to change mode at runtime.
6. Ledger: `info` entry per switch (no savings claim; effort cost is not
   directly measurable). When `useModel` runs, each classifier call is helper
   cost, logged as `cost-upgrade` with `helperTokens` (reported usage if
   non-zero, else ceil(chars/4)) and a negative `costUsdEstimate` at haiku's
   input price (0.1 USD/MTok, price table dated 2026-11-17; haiku 0.1, sonnet 2,
   opus 4, fable 8), note "effort classifier call". No `tokensAvoided`.

## Options
`mode`, `useModel`, `cooldownTurns`, `respectManual`, `manualHoldTurns` (default 10, min 0).
