# research-router

Keeps bulky web research out of the main chat. Large web search and web fetch
results are shortened on a cheap model before the main model reads them, and
`/research-router <question>` runs a short research job whose brief, with
source URLs, is all the chat receives.

Independently written from `docs/specs/research-router.md` and the public mod
API.

## What it does

### 1. Condensing large web results

Hooks the `WebFetch` and `WebSearch` tool calls. After the tool has run:

- A result whose text is **at most `minChars`** characters is left exactly as
  the tool returned it. No helper call is made.
- A longer one is sent to the helper model with the request's focus (the
  WebFetch prompt and URL, or the search query). The helper is told to keep
  the relevant parts, every URL and any dates. The page text is wrapped in
  delimiters and labelled as untrusted data, not instructions.
- Before the helper is called, the mod estimates whether condensing is worth
  it (see "Savings ledger"): a result it would not shorten, or one whose
  estimated dollar net is negative, is left whole, with no helper call.
- The mod then checks the helper's text in code. Any URL from the original
  that the helper dropped is listed under "Other URLs in the original". Those
  URLs are page-authored, so the list sits INSIDE the fence: at most 20 URLs
  (then a "(N more not shown)" line), each cut to 200 characters with a
  `...[cut]` marker, with control, bidi, zero-width and tag characters and
  line breaks removed. The main model gets the helper's text and that list,
  fenced (see "Fenced helper text" below), and after the END line only the
  mod's own one-line note saying the result was condensed, by which model,
  from how many characters, that the quoted text is untrusted web content,
  and that repeating the identical call once returns the full original.
- For WebFetch, the condensed text replaces the record's `result`. For
  WebSearch, the condensed text leads `results`, and every hit keeps its
  title and URL with its page text removed.

**Fallback.** The original result is passed on untouched when:

- the tool call was denied or errored;
- the helper call fails, times out, is refused, or returns nothing;
- the condensed text (plus, for a search, the kept hit titles and URLs) is
  not clearly shorter (under 80% of the original);
- condensing would keep nothing out, or its estimated dollar net is negative
  (see "Savings ledger"), checked before the helper is called;
- the result has an unexpected shape;
- anything in the mod throws. The hooks also carry a `.catch` that replays the
  original.

**Not condensed:**

- calls made inside a subagent, whose results never reach the main chat;
- calls raised by any plugin (this mod's `/research-router` workers included):
  only the main model's own calls are condensed;
- the first identical repeat of a call that was condensed earlier in the
  session. This is the escape hatch when the model needs the full text. The
  repeat after that is condensed again.

### 2. `/research-router <question>`

1. If `maxWorkers` is above 1, the helper model splits the question into at
   most `maxWorkers` distinct parts, returned as a JSON array. If that reply
   is unusable, the whole question becomes one part.
2. **Searches.** Each part's `WebSearch` (no `mode` is sent, so the tool's
   default applies) is put to the session's permission decision first (see
   "Permissions" below). The allowed ones run in parallel.
3. **Pages.** From each search's hits, in rank order, the mod takes the first
   3 distinct links that pass the address check below. Links that fail it are
   skipped, and the next hits are used. Each page is put to the permission
   decision, and the allowed ones are read with `WebFetch`. A page that fails
   is skipped.
4. **Briefs.** For each part, the helper model writes a brief of at most about
   300 words from the search text and pages, citing URLs and dates. Code adds
   a "Sources read" list of the URLs actually fetched. Those links come from
   search hits (page-authored), so the list is quoted INSIDE the brief's
   fence, after the helper's text, capped and cleaned like the condensing
   URL list (20 URLs, 200 characters each). A "Not read" list of skipped links
   as `host: reason` follows in a fence of its own (the host comes from a
   search-hit link and a refusal reason may quote the engine), cleaned and
   capped the same way (20 items, 200 characters each). Both lists are built by code,
   never by the helper.
5. The command's output is the assembled brief: one section per part, with a
   header (written by code, before any helper text) that says how many
   workers answered and that the content is web-sourced. Each part's heading
   is the planner's part text flattened to one short line. A part whose search or brief failed says "No brief: <why>".
   No raw page text is ever used as a fallback.

#### Permissions

A plugin's `$.tool.call` runs the session's permission check but opens no
dialog. On its own, it would run a call that no rule allows without asking
anyone. So the command does not rely on it:

- **Every web call is checked first.** Before running any `WebSearch` (input
  `{ query }`) or `WebFetch` (input `{ url, prompt }`), the mod asks the
  session's own verdict with `$.tool.check`. This is the same decision core
  makes from your allow, ask and deny rules, your permission mode and other
  plugins' `tool.check` hooks, and it runs nothing. Classic PreToolUse hooks
  are not consulted by this check (per the API docs); they still run on the
  real call.
  - `allow`: the call runs, with no dialog. This happens, for example, under an
    allow rule such as `WebFetch(domain:example.com)`, or in a mode that
    allows everything.
  - `deny`: that call is skipped and listed as refused by your permission
    settings. The other calls go on.
  - `ask`: the call waits for you. All of a phase's asks go into **one**
    question (the engine's AskUserQuestion dialog, options `Yes` / `No`): one
    for the searches, listing the queries, then one for the pages, listing
    their hosts and saying that the links come from the web, not from you.
    Only an exact `Yes` runs them. `No`, free text under "Other", a dismissed
    dialog, or a run with no one to ask (`-p`) skips them, and they are listed
    as "not approved".
  - A check that fails counts as a deny.
- **Even an allowed call goes through `$.tool.call`'s own check**, so a deny
  rule added in between still stops it.
- **When a call was refused or not approved,** the brief ends with a line on
  how to allow it: add `WebSearch` and `WebFetch(domain:<host>)` to
  `permissions.allow` in your settings. A deny rule always wins.

So, going by the API docs (not yet confirmed in a live session), with default
permissions (no rule for WebSearch or WebFetch) a run asks you at most twice:
once for the searches, once for the pages. With allow rules in place, it asks
nothing.

#### Address check (links from search hits)

Search hits are untrusted, so before any permission check a link must pass
all of these:

- the scheme is `http` or `https`; `file:`, `ftp:`, `data:`, `javascript:`
  and the rest are refused;
- the link has no user name or password in it;
- the host is not private, loopback, link-local or reserved. This covers
  `localhost` and `*.localhost`, single-label names, the `.local`,
  `.internal`, `.intranet`, `.lan`, `.home.arpa` and `.localdomain`
  suffixes, and these IPv4 ranges: 0/8, 10/8, 127/8, 100.64/10, 169.254/16
  (cloud metadata included), 172.16/12, 192.0.0/24, 192.168/16, 198.18/15,
  and 224/4 and above. Numeric spellings such as `2130706433`, `0x7f.1` and
  `127.1` are refused too, because the URL parser normalises them first. For
  IPv6, every literal outside global unicast (2000::/3) is refused, which
  covers `::1`, `::`, IPv4-mapped addresses, fc00::/7, fe80::/10 and
  multicast. A 6to4 address (2002::/16) is judged by the IPv4 address inside
  it;
- the host is not on `blockedHosts`, and is not a subdomain of one.

The search and page text the workers read stays inside the mod. Only the
brief enters the chat.

`/research-router` with no question prints usage and starts nothing.

### 3. Savings ledger

Entries go to `~/.claude/claude-mods/ledger/research-router.<session-id>.jsonl`,
one file per session, using the shared contract in `docs/ledger.md`. Every
line carries `"mod": "research-router"` and the session id. In the file name,
any character other than letters, digits, `_` and `-` in the session id
becomes `_` (so no dots) and the id is cut at 80 characters. With no session
id (the call fails or answers an empty string), no HOME, or no readable clock
the entry is dropped: the ledger is off, with no shared `unknown` file and no
1970 timestamp. The file is picked at the first entry from `$.session.id()`, and
re-picked whenever that id changes: after `/clear` (which fires no
`session.start`) the next entry goes to the new session's file. An existing
file for the session is read once first, so a resumed session keeps its lines.
Each file is capped at 5,000 lines, and a note never contains a query, URL or
page text. Entries and writes run one after another. Writes are batched: the first
entry of a session file is written at once, later entries are held and the
whole file is written back by the first entry that arrives 5 seconds or more
after the last write (no timer), and anything still unwritten is flushed on
`session.end`. Before each flush the session id is asked again, so after
`/clear` the old file is written first and the new session's file is opened.
When reading an existing file, only lines that are JSON objects with a string
`mod` are kept (not `null`, arrays or scalars).

Each line carries **three separate numbers** (`docs/ledger.md`, "Three
separate numbers"). They are never netted into one token count, because
helper tokens (a cheap model) and main-context tokens (the main model, re-read
on every later turn) are not the same thing:

- `tokensAvoided`: GROSS main-context tokens kept out, never below 0.
- `helperTokens`: tokens the mod's own helper calls spent.
- `costUsdEstimate`: the net in dollars, `tokensAvoided x main model input
  price - helperTokens x helper model input price`, rounded to 6 decimals.
  It may be negative. It is omitted when either price is unknown. The note
  names both models and the assumption.

| Event | `kind` | `tokensAvoided` | `helperTokens` |
|---|---|---|---|
| A condensed result | `tokens-avoided` | `ceil((original chars - delivered chars) / 4)` | the condense call |
| A helper call whose text was not used (no text, not clearly shorter, failed) | `cost-upgrade` | absent | that call (no line when it spent nothing) |
| A `/research-router` run that kept something out | `tokens-avoided` | `floor(ceil(chars read / 4) x RESEARCH_READ_SHARE) - ceil(brief chars / 4)` | planner + every brief writer |
| A `/research-router` run that kept nothing out | `cost-upgrade` (or `info` when no helper ran) | absent | planner + every brief writer |

What is estimated, and how:

- **Helper tokens** are the call's reported usage (`input_tokens` +
  `cache_read_input_tokens` + `cache_creation_input_tokens` +
  `output_tokens`) when the call reports any. Otherwise they are estimated as
  `ceil(chars / 4)` of the system prompt and prompt sent plus the reply. A
  refused API call (`api-error`) counts as 0; a call that threw counts its
  prompt. Failed brief writers count too.
- **Delivered chars** for a condensed result are the fenced text with the
  note, plus, for WebSearch, the kept hit titles and URLs (measured as their
  JSON). How core renders the record to the model was not verified, so this
  is an estimate.
- **`RESEARCH_READ_SHARE` = 0.25** (`hooks/logic.ts`). For `/research-router`,
  only a quarter of the search and page text the workers read is counted as
  kept out: the main model would not have read every page a worker opened.
  This share is a judgment, not a measurement. Only workers that delivered a
  brief count their reading; a run where no worker answered counts nothing.
- **Prices.** `INPUT_USD_PER_MTOK` in `hooks/logic.ts` is a copy (made
  2026-11-17) of the list input prices in `plugins/model-router/hooks/logic.ts`
  (claude-api skill table cached 2026-11-03): haiku 0.1, sonnet 2, opus 4,
  fable 8 USD per million input tokens. The model family is read from the
  name. All helper tokens, output included, are priced at the helper's INPUT
  price, and the avoided tokens at the main model's input price for one turn
  only: no caching discounts and no credit for later turns re-reading the
  context. The main model is `$.session.model()` at the time of the line.
- **In raw tokens, condensing usually costs more than it keeps out.** The
  helper reads the whole page (up to 300,000 characters), so `helperTokens`
  is usually a little larger than `tokensAvoided`. The saving is in dollars
  and context space: those tokens are spent on a cheaper model and stay out of
  the main chat. With an opus main model and a haiku helper, a condensation
  of a page that keeps 1,000 tokens out at a cost of 1,500 helper tokens is
  about +0.00385 USD.
- **Skip gate.** Before calling the helper, the mod estimates avoided =
  `ceil(original / 4) - ceil((target + 600 + kept hit chars) / 4)` (target =
  the length the helper is asked for, 1,000 to 6,000 characters) and helper
  = `ceil(prompt chars / 4) + ceil(target / 4)`. It skips condensing when
  avoided is 0 or less, or when both prices are known and the dollar net
  (same formula as `costUsdEstimate`) is negative. With a cheap helper (the
  default `haiku`, 40x cheaper than opus at input) almost every result that
  is shortened at all passes; with a helper as dear as the main model,
  condensing is skipped, because the helper reads the whole page. With an
  unknown price only "keeps something out" applies.

## Options (`userConfig`)

| Option | Default | Meaning |
|---|---|---|
| `minChars` | 8000 | Results longer than this are condensed, unless the skip gate (see "Savings ledger") leaves them whole. Exactly this many are not. Range 500 to 1,000,000. |
| `helperModel` | `haiku` | Model for condensing, planning and briefs: an alias or a full model id. Its family sets the helper price in the ledger and the skip gate; a model as dear as the main one makes the gate skip condensing. |
| `maxWorkers` | 3 | Most parts (parallel workers) one question is split into. Range 1 to 10. At 1, the planner is skipped. |
| `blockedHosts` | empty | Comma-separated hosts `/research-router` never reads, each with its subdomains (`example.com, *.tracker.net`). Case, a leading `*.` or `.`, a trailing dot, and a pasted link's scheme, user name, port and path are ignored. |
| `timeoutMs` | 60000 | Limit for each helper-model call. Past it, a condensation keeps the original and a research part gets no brief. Range 1,000 to 600,000. |

## Files

- `.claude-plugin/plugin.json`: the manifest and options.
- `hooks/hooks.json`: names the hooks module.
- `hooks/register.tsx`: the hooks:
  - `session.start` loads the ledger and registers `/research-router`;
  - `tool.call` handles WebFetch and WebSearch;
  - `command.run` runs `/research-router`, checking every web call with `$.tool.check` and asking with `$.ui.ask`;
  - `session.end` resets the escape-hatch memory on `/clear` and flushes the ledger.
- `hooks/logic.ts`: pure helpers (thresholds, URL handling, the address check and `blockedHosts`, prompts, plan parsing, brief assembly).
- `hooks/ledger.ts`: the per-session ledger writer.
- `hooks/register.test.tsx`: 71 tests for size thresholds, every fallback, pass-through cases, the command, the permission flow (allow, ask with Yes, No, a dismissed dialog, free text, deny, a failing check), the address checks and `blockedHosts`, options, the fence and the URL lists inside it (hostile URLs, caps), the three ledger numbers (gross tokens, reported and estimated helper usage, the dollar estimate and an unknown price, the skip gate, the research share), and the per-session ledger (batching, session id rules, /clear).

## Limitations (honest)

- **Workers are not subagents.** The spec says to "dispatch a cheap worker".
  In this build (CLI 2.1.326), a plugin's `$.tool.call({ tool: 'Agent' })` is
  refused by a host check that points to `$.agent.spawn`. `$.agent.spawn`
  resolves when the agent starts, not when it finishes. Waiting for its answer
  inside the command hook would spend the hook's 10-second own-time budget.
  So each worker is a fixed chain of the session's own tools plus the helper
  model:

  > search, then read the top 3 pages, then write a brief

  It does not decide to search again or follow links the way an agent would.
- **WebFetch output is already processed.** WebFetch gives the processed
  extract of a page, not the raw HTML. So "pages read" in the ledger is the
  size of that extract plus the search text. Real page sizes (WebFetch's
  `bytes`) would be larger.
- **The ledger's numbers are estimates.** See "Savings ledger" for the
  formulas, prices and documented constants. Not counted in `helperTokens`:
  the model WebFetch uses internally to extract a page. For
  `/research-router` workers that cost is the mod's, so its numbers are
  optimistic in that direction. The price table is a dated copy and will go
  stale.
- **`cost-upgrade` lines.** A helper call that kept nothing out is logged as
  `cost-upgrade` (no `tokensAvoided`, a negative `costUsdEstimate`), following
  the contract's rule for cost with no avoidance. How the `savings-proof`
  reader shows these lines was not checked.
- **Permission prompts are the mod's own, not core's.** `$.tool.call` opens
  no dialog, so the mod asks the session's verdict with `$.tool.check` and,
  for `ask`, asks you itself with `$.ui.ask` (the engine's AskUserQuestion
  dialog). Consequences:
  - one Yes covers every call listed in that question, not one call at a
    time, and nothing is remembered: the next run asks again;
  - "Yes, and don't ask again" is not offered, so no allow rule is ever
    written; add rules yourself (see section 2);
  - in auto mode, an `ask` comes to you, not to the auto-mode classifier
    (from the API docs; not confirmed live);
  - an `ask` raised by a plugin hook or an organization policy is shown to
    you too, but `$.tool.call` then refuses the call even after your Yes; it
    is listed as refused. A classic PreToolUse hook's ask is not seen by the
    check at all: the call is simply refused and listed as refused.
- **The address check sees only the link as written.** It cannot see where a
  page redirects to, or what a public-looking name resolves to (a mod has no
  DNS lookup), so a public name pointing at a private address, or a redirect
  to one, is not caught by the mod. WebFetch's own handling of redirects is
  what applies there. Single-label names (`http://intranet/`) and the
  local-only suffixes `.localhost`, `.local`, `.internal`, `.intranet`,
  `.lan`, `.home.arpa` and `.localdomain` are refused as private.
- **The main model's own web calls are not filtered.** `blockedHosts` and the
  address check apply only to `/research-router`. The main model's WebFetch
  and WebSearch go through core's normal permission flow as before.
- **`timeoutMs` covers only helper-model calls.** The searches and fetches
  have no timeout of their own.
- **WebFetch offsets.** The helper is asked to keep any "continue at offset"
  line from a long page. Only URLs are enforced in code; dates and offsets
  depend on the helper following the instruction.
- **Subagents are not condensed.** Spec item 1 sets no such limit; this mod
  adds it on purpose, so other agents' research is not degraded.
- **Ledger accuracy.**
  - When the escape hatch hands back the full original, the earlier
    `tokens-avoided` entry stays; no correcting entry is written, so that
    pair of calls is over-counted by the original's size.
  - A session's ledger file that exists but cannot be read (any error other
    than "missing") turns the ledger off for that session rather than being
    overwritten.
  - Because of the batching, up to about 5 seconds of entries can be lost if
    the process is killed before `session.end` runs.
  - The old shared file `research-router.jsonl` is neither written nor
    migrated; readers still read it under the contract.
- **Very long results.** A result over 300,000 characters is cut before it
  reaches the helper. URLs from the unread part are still listed (inside the
  fence, at most 20), but the note does not say the rest was unread.
- **Fenced helper text.** Everything the helper writes (condensed results and
  worker briefs) is quoted between a start and an end marker line, each of its
  lines starting with `│ `. The characters the markers and the prefix are made
  of are replaced in the helper's text (`⟦` `⟧` become `[` `]`, `│` becomes `|`),
  every kind of line break (CR, VT, FF, NEL, LS, PS) splits a line, and
  control, bidi, zero-width and tag characters are removed, so injected text
  cannot print a line that looks like the end of the fence or like one of the
  mod's own lines. URL lists taken from pages (the dropped-URL list of a
  condensed result and a brief's "Sources read") are page-authored, so they
  are quoted INSIDE the fence, at most 20 URLs of at most 200 characters each,
  cleaned the same way. A brief's "Not read" list (hosts from search-hit
  links) gets a fence of its own. The mod's own lines (the condensed-result
  note, the cut note, the header, the permission hint) are written only
  outside the fences; after a condensed result's END line comes the note and
  nothing else. This makes forging the mod's text hard; it does
  not make the quoted text trustworthy, and a page that steers the helper can
  still put misleading claims inside the fence.
- **WebSearch measurement.** Condensing is decided on the result text that
  core reports (`text`). How core turns the rewritten WebSearch record back
  into model text was not verified live.
- **Not verified live.** The mod has passed `claude plugin validate`, the
  typecheck and `claude plugin test`, all of which are offline. It has not
  been loaded in a real session. That leaves these behaviours unconfirmed:
  - the model text core produces from a rewritten result;
  - whether results of plugin-raised web calls stay out of the transcript;
  - permission behaviour in a live session. The tests play the engine's
    part: they give `$.tool.check` a verdict and answer the dialog. Still
    unconfirmed: the verdict `$.tool.check` gives in each permission mode, the
    `$.ui.ask` dialog opening from a slash command, and the
    `WebFetch(domain:...)` rule syntax quoted in the hint;
  - real helper quality.
- **Duplicate names.** Install only one mod named `research-router` at a time.
