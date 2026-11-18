# effort-optimizer

Most prompts do not need maximum reasoning effort. This mod looks at each prompt you submit, asks four cheap questions about it, and either offers a one-line switch to a better-fitting effort level or makes the switch itself.

## The four questions

Answered from the prompt text with keyword and length rules (no model call), in `hooks/logic.ts` (`scorePrompt`):

1. Is it a lookup, rename or mechanical edit?
2. Does it need multi-step planning?
3. Is the code or domain unfamiliar, or the request ambiguous?
4. Is a wrong answer expensive (data loss, production, security)?

Mapping: only (1) gives `low`; none gives `medium`; (2) or (3) gives `high`; (2) and (3), or (4), gives `xhigh`. The mod never picks `max`: that is left to you.

## Modes

| Mode | What happens |
|---|---|
| `suggest` (default) | When the pick differs from the current level, a line above the prompt reads "Switch to <level>" with a button. Nothing changes until you press it. Pressed while a turn is still running, the label reads "from next prompt": the switch applies at the first request of your next prompt. |
| `auto` | Switches by itself and shows a toast. |
| `off` | Does nothing. |

Change it at runtime with `/effort-optimizer on|off|auto|suggest` (`on` returns to the configured mode, or `suggest` if that is `off`). `/effort-optimizer` alone shows the status. The command changes the mode for the running session only; set the `mode` option for the default.

## Options

- `mode`: `suggest`, `auto` or `off`.
- `useModel` (default off): also ask a small model (haiku) the four questions, once per prompt, and merge its answers with the rules. This sends your prompt text (first 2,000 characters) in one extra request per prompt. A "yes" from either side stands, except for "mechanical", which needs both to agree. If the call fails or the reply is not the expected JSON, the rules stand alone.
- `cooldownTurns` (default 2): after a switch, no downgrade or same-level move (and no offer for one) until that many turns have passed. An upgrade is never held back: a riskier prompt than the active level switches at once in `auto`, and is still offered in `suggest`.
- `respectManual` (default on): in `auto` mode, a level you changed yourself wins, for `manualHoldTurns` turns (see below).
- `manualHoldTurns` (default 10, `0` = never expires): how many turns a level you set yourself is respected in `auto` mode, counting the turn on which the change was noticed. After that the hold ends and the mod may switch again; a new change of yours starts a new hold. `/effort-optimizer` shows how many turns are left. `/clear` also ends it.

## While you hold a level yourself (auto mode)

- Downgrades and sideways moves are blocked for the whole hold.
- One exception: an **upgrade for a high-risk prompt** (question 4, "a wrong answer is expensive") is still applied, because running such a prompt at a level you lowered costs more than the change. It goes up to `xhigh` at most, never to `max` (that stays yours), and never down: if you run `max`, a risky prompt leaves it alone. Once applied, that level stays until the hold ends or you change the level again, because the downgrades are blocked.
- Other upgrades (a plain planning prompt, say) wait until the hold ends. `suggest` mode is unaffected: it still offers the pick, never capped or held back. With `respectManual` off there is no hold at all.

## Why the cooldown

Changing effort in the middle of a chat can change the request prefix and invalidate the prompt cache on some models, which costs more than the lower effort saves. The cooldown limits how often that can happen. Keep it above 1. It does not apply to upgrades, because running a risky prompt (say, dropping a production table) at the previous prompt's `low` costs more than a cache miss.

## How it works, and the limits

There is no API for a mod to set the session's effort. The one thing a mod can do is rewrite the `effort` of a model request in the `turn.step` hook, and that rewrite is not carried to later steps. So this mod holds the chosen level itself and applies it to every main-thread request until it changes or you turn the mod off. The session's own `/effort` setting is never modified, so the effort line in Claude Code's own UI keeps showing the level you set. Subagent requests are not touched.

Limits to know about:

- **Decided on the first request of a turn, not at submit.** The mod only learns the session's current level from the first model request of the turn, so the offer appears while that turn is already running. A Switch pressed during that turn is queued and applied at the first request of the next turn: rewriting the rest of a running turn could change the request prefix and drop the prompt cache. In `auto` mode an upgrade for a risky prompt does apply at that turn's first request, even though it may cost a cache miss; that is the trade-off for not running a risky prompt at a low level.
- **Detecting your own choice is a heuristic.** The mod treats a change in the level the engine asks for (between two turns, and not equal to the level the mod applies) as you having set it. A level you chose before the session began, or one that equals the mod's own, cannot be told apart.
- **A model switch is not a manual choice.** The default effort differs per model, so a `/model` switch moves the level the engine asks for. The mod compares the model id named on the first request of each turn with the one before it; when they differ, a level change at that boundary is not counted as yours. The limit: an effort change you make in the same turn boundary as a model switch is missed too, and a default that moves for another reason (a settings change, say) still looks manual.
- **Models that take effort per message:** the docs say a level can stand from one message to the next on those, and on a tool-result step a different level is not sent. The mod repeats its rewrite on every step either way, so the effective level can differ from the intended one on some models.
- **Models without effort** (the request carries no level) are left alone.
- **Rules are keyword heuristics.** They will misjudge: a short prompt with the word "production" scores as costly, a vague long prompt as planning. Debugging questions ("find the cause of the crash", "why is X failing") count as unfamiliar and score `high`, never as a plain lookup. The mapping is deliberately simple. Use `suggest` until you trust the picks.
- **No savings claim.** The ledger (`~/.claude/claude-mods/ledger/effort-optimizer.<session-id>.jsonl`, one file per session) gets one `info` entry per switch, with no token or cost estimate, because the cost of effort is not directly measurable. The entry holds the levels and the reasons, never the prompt text. With `useModel` on, each haiku classifier call is logged too, as a `cost-upgrade` line (note "effort classifier call") with `helperTokens` (the call's reported usage if non-zero, else an estimate of characters divided by 4) and a negative dollar estimate at haiku's input price (0.1 USD per million tokens, a copy dated 2026-11-17; output tokens are priced as input), so the cost of the helper shows in `/savings`. It claims no saving. The ledger follows `docs/ledger.md`: the session id in the file name is sanitised (no dots, 80 characters at most), and each line's `session` field carries that same sanitised value; with no session id or no HOME it is off; a read error other than a missing file turns it off for that session rather than overwriting; only JSON-object lines with a string `mod` are kept; after `/clear` the old file is written before the new session's file is used.
- Slash commands and meta prompts are not scored. State (including a queued switch) resets on `/clear`.
- If the ledger or the mode display fails to start, the mod and the `/effort-optimizer` command still work.
- Not exercised in a live session: this was written and tested offline against the plugin API types and test kit only.
