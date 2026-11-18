# research-router

**Goal:** keep bulky web research out of the main chat.

## Behaviour
1. Hook web search and web fetch results. When one is larger than `minChars`
   (default 8,000), a cheap model shortens it to the parts relevant to the
   query, keeping every URL and a date where the page gives one. The main model
   gets the short version plus a note that it was condensed. Falls back to the
   original on any failure. Skipped before the helper call when it would keep
   nothing out or its estimated dollar net (main-model input price x tokens
   kept out minus helper input price x helper tokens) is negative. URLs the helper dropped are listed
   inside the fenced (untrusted) region, at most 20, each at most 200
   characters, with control, bidi and zero-width characters stripped. The same
   applies to a brief's list of sources read and its "Not read" list.
2. `/research-router <question>` runs a short research job: dispatch a cheap
   worker (or a few in parallel when the question has distinct parts) to
   search, read the real pages and return a brief with source URLs. The main
   chat receives only the brief. Cap workers at `maxWorkers` (default 3).
3. A search that is already short is left alone.
4. Ledger (`docs/ledger.md`, "Three separate numbers", never netted):
   `tokensAvoided` is GROSS main-context tokens kept out (>= 0): for a
   condensed result, the original minus what was delivered (condensed text,
   note, and a search's kept hit titles and URLs); for `/research-router`, a
   documented share (`RESEARCH_READ_SHARE`, 0.25) of the text the workers read
   minus the brief. `helperTokens` is what the helper calls spent (condense
   call; planner and every brief writer), from reported usage if non-zero,
   else ceil(chars / 4). `costUsdEstimate` = avoided x main-model input price
   minus helper x helper-model input price (may be negative; omitted when a
   price is unknown; models and assumption in the note). A helper call that
   kept nothing out logs `cost-upgrade` with no `tokensAvoided`.

## Permissions and addresses
The `/research-router` command checks each WebSearch/WebFetch against the session's permission verdict (allow runs, deny skips, ask goes into one Yes/No dialog per phase). Links from search hits must be http(s), carry no credentials, and not point at private, loopback, link-local or local names; `blockedHosts` adds more.

## Options
`minChars`, `helperModel`, `maxWorkers`, `timeoutMs`, `blockedHosts`.
