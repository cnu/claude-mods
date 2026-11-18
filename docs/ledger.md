# Savings ledger contract

Shared by every mod that saves tokens or money, read by `savings-proof`.

## Location

`~/.claude/claude-mods/ledger/<mod-name>.<session-id>.jsonl`. Each mod writes ONLY
its own per-session file (no cross-mod and no cross-session write races). Readers
glob `*.jsonl` and take the mod from each line's `mod` field, not the file name.
The legacy name `<mod-name>.jsonl` is still read. `$.fs` has read and write but no append, so a
mod keeps its entries in memory, and writes the whole file back (batched, at
most once every few seconds and on `session.end`), after reading it once at
start. Cap each file at 5,000 lines: drop the oldest when over.

## Rules every writer follows

- **Session id in the file name:** replace every character outside `[A-Za-z0-9_-]` with `_`, cap at 80 characters. No dots (so no leading-dot or `..` tricks).
- **No session id (or no HOME): the ledger is off.** Never write a shared `unknown` file.
- **Read errors never wipe history:** a missing file starts empty; any other read error turns the ledger off for that session instead of overwriting.
- **Parsing:** keep only lines that are JSON objects (not `null`, arrays or scalars) with a string `mod`.
- **`/clear`:** the engine gives a new session id and fires no `session.start`. Re-resolve the session id before each flush and switch files (flushing the old one first).
- **`session` field:** write the same value the file name uses, i.e. the SANITISED id (see first rule). Readers compare against the sanitised id of the current session (and may also accept the raw id).
- **Three separate numbers (supersedes the earlier "net tokens" rule):** token counts are NOT netted, because helper tokens (cheap model) and main-context tokens (expensive model, re-read every later turn) are not the same thing.
  - `tokensAvoided`: GROSS main-context tokens kept out (>= 0). Estimate with ceil(chars/4) unless a real count exists.
  - `helperTokens`: tokens the mod itself spent on helper/classifier/ping calls (>= 0), from the call's reported usage if non-zero, else ceil(chars/4).
  - `costUsdEstimate`: the honest NET in dollars, only when prices are known: `avoided * mainModelInputPrice - helper * helperModelInputPrice` (it MAY be negative; for `cost-upgrade` it is negative). Put the models and the assumption in `note`. Omit it when a price is unknown.
  `helperTokens` counts tokens on whatever model the mod called (a Haiku classifier, or the main model for a keep-warm ping), so the Helper column mixes models; the dollar figure is what weights them. A writer that tracks input and output tokens separately MAY price output at the model's output price; say so in `note`. Readers must show the three side by side, must show negatives and must never clamp or merge them into one token number. A mod that adds cost with no avoidance logs `cost-upgrade` (negative `costUsdEstimate`, no `tokensAvoided`).
- **Honest numbers:** every figure is an estimate; if a number cannot be estimated, omit the field and log `info`. Never merge, net or clamp the three numbers into one token figure.

## Line format (one JSON object per line)

```json
{
  "v": 1,
  "ts": "2026-11-17T10:00:00.000Z",
  "mod": "input-router",
  "session": "<session id>",
  "kind": "tokens-avoided",
  "tokensAvoided": 12000,
  "helperTokens": 1500,
  "costUsdEstimate": 0.036,
  "note": "short human-readable text, no file contents"
}
```

- `kind`: `tokens-avoided` | `cost-downgrade` | `cost-upgrade` | `cache-kept-warm` | `handoff` | `info`.
- `tokensAvoided` and `costUsdEstimate` are optional numbers, always estimates.
  Never log prompt text, file contents or secrets in `note`.
- Estimate tokens as `ceil(chars / 4)` unless a real count is available.
