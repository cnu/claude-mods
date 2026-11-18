# cache-clock

**Goal:** the prompt cache expires after a period of inactivity, and a cold
cache makes the next message in a big chat expensive. Show how long is left and
help the person avoid or soften the cost.

## Behaviour
1. Track the time of the last model response (turn complete). The cache is warm
   for `ttlMinutes` after it (option; default 0 = detect: use the model-switch `cache_ttl` signal, then a resume inference, else assume 5 minutes; any value above 0 overrides).
2. A band above the prompt shows a countdown (`cache warm 42:10`, then `cache
   cold`). Hidden when there is no turn yet, or the chat is small
   (`minTokens`, default 20,000 of context). Redraws about once a second only
   while visible.
3. A "Keep warm" button toggles background pings: shortly before expiry, send
   one very cheap model call that re-reads the same cached prefix (via the
   session's own fork-style call so the prefix matches), then reset the clock.
   Max `maxPings` per idle stretch (default 6). Off by default.
4. When the cache has gone cold and the chat is big (`handoffTokens`, default
   150,000), show a one-line offer to start a fresh chat with a handoff summary.
   Do not implement the handoff itself: if the `handoff` mod's command exists,
   point at it by name, otherwise toast the suggestion.
5. Ledger: each successful keep-warm ping writes a `cache-kept-warm` entry.

## Options
`ttlMinutes` (0 = detect), `minTokens`, `handoffTokens`, `maxPings`, `keepWarmDefault`.
