# savings-proof

**Goal:** show evidence of what the other mods saved.

## Behaviour
1. `/savings` opens a pane (reload-safe). It reads every
   `~/.claude/claude-mods/ledger/*.jsonl` file (see `docs/ledger.md`) and shows:
   totals for today and for this chat; a table per mod (events, avoided, helper,
   estimated USD); and the last 10 events with their notes.
2. Clearly label every figure an estimate (pane title "Savings (estimated)"). Follow the
   ledger's "Three separate numbers" rule: there is no single net-token headline. Each
   total and per-mod row shows Avoided (sum of `tokensAvoided`, >= 0), Helper (sum of
   `helperTokens`, >= 0, absent = 0) and Est. $ (signed sum of `costUsdEstimate`, only over
   lines that have one; negatives shown, not clamped) plus how many events had no dollar
   figure. Negative token counts are malformed and count as 0. `cost-upgrade` counts as
   cost, never as saving (its `tokensAvoided` is ignored). Where a mod logs an `info`
   kind, count the event but no figures. "This chat" matches the raw or the sanitised
   session id. Dollar sums are rounded to 6 decimals; zero shows as `~$0.00`, a tiny
   non-zero amount as `~<$0.01` (sign kept for losses), and the label follows the
   `currency` option (`Est. $` for USD, `Est. INR` otherwise). A stored snapshot is used
   only if every figure in it is a finite number; otherwise it is declined. Lines dated
   more than a day after "now" are ignored in every window; a line later the same day
   counts, today included.
3. Refresh when a new ledger line appears (poll modestly, at most every few
   seconds, only while the pane is open).
4. Handle missing/empty/corrupt ledger files gracefully (skip bad lines, show
   "no data yet").
5. Optional compact status-line entry `avoided ~12k, helper ~1.5k, ~$0.03 est. today`
   (`showStatus` option); parts that are 0 or unknown are omitted.
6. Bounded reads: `ledgerDays` (default 90, 0 = no limit, max 3650) skips ledger files
   last modified earlier (by `$.fs.list` mtime) and ignores older lines (by `ts`); the
   pane footer counts skipped files.

## Options
`showStatus`, `currency`, `unitsPerUsd`, `ledgerDays`.
