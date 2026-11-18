# savings-proof

Shows evidence of what the other claude-mods saved. `/savings` opens a pane that reads the shared savings ledger (every `*.jsonl` in `~/.claude/claude-mods/ledger/`, format in `docs/ledger.md`) and shows totals for today and for this chat, a table per mod (events, tokens avoided, helper tokens, estimated dollars) and the last 10 events with their notes. Every figure is an estimate and the pane says so.

## Use

1. Install the plugin (it needs no other mod, but it has nothing to show until a mod writes ledger lines).
2. Type `/savings`. The pane refreshes about every 4 seconds, only while it is open.
3. Optional: set `showStatus` to pin `avoided ~12k, helper ~1.5k, ~$0.03 est. today` under the prompt. Parts that are 0 or unknown are left out (`~-$0.04 est. today` on a day with only a cost-upgrade).

## Options

| Option | Default | Meaning |
|---|---|---|
| `showStatus` | off | Pin a one-line status entry. Updated at session start and after each turn, not on a timer. Nothing is shown while all of today's figures are zero. |
| `currency` | `USD` | Label for money figures (`USD`, `EUR`, `GBP`, `INR`, or any code). |
| `ledgerDays` | `90` | Ignore ledger files last modified, and lines dated (`ts`), more than this many days ago. `0` = no limit, max `3650`. The pane footer says how many files were skipped. |
| `unitsPerUsd` | `1` | Multiplier applied to the ledger's dollar estimates. There is no live exchange rate: if `currency` is not USD you set this yourself, otherwise you get dollar amounts under another label. (Added beyond the spec's two options so `currency` can mean something.) |

## How the numbers are built

- Three separate numbers, never merged into one "net tokens" figure (`docs/ledger.md`, "Three separate numbers"). The pane is titled "Savings (estimated)". Each total (today, this chat, all time) and each per-mod row shows:
  - **Avoided**: sum of `tokensAvoided` (gross main-context tokens kept out, >= 0).
  - **Helper**: sum of `helperTokens` (tokens the mod itself spent on helper calls, >= 0). A legacy line without `helperTokens` counts 0.
  - **Est. $**: the signed sum of `costUsdEstimate` (the honest net in dollars, may be negative, shown as `~-$0.04`). The sum is rounded to 6 decimals so float leftovers never show: exact zero is `~$0.00`, a non-zero amount under 0.01 is `~<$0.01` (`~-<$0.01` for a tiny loss). With a non-USD `currency` the label follows it: `Est. INR ~3.24` (column header `Est. INR`); USD stays `Est. $ ~$0.04`. It adds up only over lines that carry a dollar figure; a line with only `costUsdEstimate` still counts, and a line with only tokens adds nothing to it. The pane says how many events had no dollar figure (`(2 no $)` on the totals, a `No $` column per mod; `info` lines are not counted there).
  A negative `tokensAvoided` or `helperTokens` is malformed and counts as 0; it is never subtracted from another number.
- `cost-upgrade` lines are a cost, never a saving: their `tokensAvoided` (if any) is ignored, and their `costUsdEstimate` is taken as negative whatever sign the writer used. A `cost-upgrade` with no dollar figure adds nothing to Est. $ and shows in the `No $` count.
- The per-event list shows each event as `av <avoided> help <helper> <$ or ->`.
- Today is the local calendar day. This chat is the entries whose `session` field equals the current session id, either raw or sanitised (chars outside `[A-Za-z0-9_-]` become `_`, capped at 80), wherever the line is stored (the file name is never consulted).
- `info` entries (and any unknown `kind`) count as an event but add no tokens or money, even if they carry them (and they are not counted as missing a dollar figure).
- Ledger files: every `*.jsonl` in the folder is read, whether it is a per-session file (`<mod>.<session-id>.jsonl`) or a legacy `<mod>.jsonl`. The mod name comes only from each line's `mod` field (a line without one is shown as `unknown`), never from the file name, so one file may hold several mods and a mod may span many files.
- Many files: each file is parsed on its own and cached by name, size and modified time. A poll rereads only files whose size or mtime changed (new files included) and forgets deleted ones; `/savings` itself rereads everything.
- De-duplication: only a line that is byte-for-byte identical to an earlier line in the same file is dropped (a retried write). Nothing is de-duplicated across files.
- Per-mod rows are all time over what the ledger files still hold (each file is capped at 5,000 lines by its writer), not just today.
- Age window: with `ledgerDays` > 0, files whose modified time (from the directory listing) is older are not read at all, and lines older than the window by `ts` are ignored even in a fresh file. The window is evaluated when the ledger changes or on `/savings`, so a file that ages out on its own disappears at the next refresh, not on a timer.
- Bad lines (not JSON, not an object, no parsable `ts`) are skipped and counted in the pane. Non-numeric estimates count as 0 (and a non-numeric `costUsdEstimate` counts as no dollar figure); a negative dollar estimate is kept. Missing, empty or all-corrupt files show "no data yet".

## Limitations (honest ones)

- Estimates of estimates: each mod guesses its own tokens (usually `ceil(chars / 4)`) and prices them, and a mod's Est. $ is only as good as the prices it assumed (they are in the line's `note`, not checked here). Nothing here is billed usage, and savings that never happened (a cache that was already cold, a summary the model needed anyway) cannot be detected. Treat totals as order of magnitude.
- Trust: the ledger is plain files any process can write. Entries are not signed, and only exact repeats within one file are removed, so two real events with byte-identical lines in one file count once.
- Read limit: a file over 4 MiB cannot be read by the engine and is reported as unreadable. A 5,000-line ledger is far below that.
- Polling compares file size and modified time per file, then rereads the changed files whole; there is no incremental read, and a file that failed to read stays counted unreadable until it changes or you run `/savings`. A write that changes neither (same size, same millisecond) would be missed until the next change.
- After a hot reload of the plugin the poll timer is gone; it is re-armed at the end of the next turn if the pane is still open. `/savings` again also restarts it. The pane's contents themselves survive a reload (they live in engine state).
- "This chat" is empty until a mod has logged under the current session id. After `/clear` the session id changes, so the chat total restarts.
- The status line is one per plugin and refreshes per turn, so it can lag a ledger line written mid-turn. The money figures are in US dollars unless you set `unitsPerUsd`.
- Written without loading it into a live session: it is validated, type-checked and tested offline only. Real rendering (colours, column fit on a narrow desktop pane, how the pane docks) has not been seen.
