# cache-clock

A Claude Code mod that shows how long your prompt cache has left, can keep it
warm with cheap background pings, and suggests a fresh chat when a big chat has
gone cold. A cold cache makes the next message in a big chat expensive, because
the whole conversation is billed again at the full input rate.

Status: written offline against the mod API types and checked with
`claude plugin validate`, a TypeScript check and `claude plugin test` (mocked
clock, mocked model). It has not been loaded into a live session.

## Install

    /plugin install cache-clock --marketplace <owner>/claude-mods

## What you see

A band above the prompt (terminal and desktop):

- `cache warm 4:10 (180k tokens)` counts down from the cache lifetime (see "Cache lifetime" below) after each
  model response. It turns yellow in the last minute, then reads `cache cold`.
- A **Keep warm** button toggles pings. The label shows `on (n/max)` when on.
- When the cache is cold and the chat holds at least `handoffTokens`, a line
  offers a fresh chat with a handoff summary. If the handoff mod is installed
  (any slash command registered by a plugin named `handoff`, such as its
  `/refresh`, or a command named `handoff`), the line names it, for example
  `(/refresh)`. If not, you get one toast with the suggestion. The mod never writes the handoff itself.

The band is hidden before the first turn, while the chat is under `minTokens`,
and while a survey holds the band. It redraws about once a second, and only
while it is visible and the countdown is moving (plus once when the cache goes
cold).

## Keep warm

Off by default. When on, about a tenth of the lifetime before expiry (15 to 60
seconds), the mod calls `$.model.fork`. That is the engine's own call over the
session's transcript exactly as the main thread last sent it, so the provider
serves that prefix from the cache, and reading it refreshes the entry. The
mod's prompt asks for a one-word reply with no tools. Then the clock resets.

Rules: at most `maxPings` pings per idle stretch (the count resets on each of
your turns); never while a turn is running; never once the cache is already
cold (a ping into a cold cache would pay the full write); two failed pings in a
row switch it off with a toast. A ping counts as successful only if the
provider reported cached tokens read or written (`usage.cache_read_input_tokens`
or `cache_creation_input_tokens`); otherwise nothing was refreshed, the clock is
not reset and it counts as a failure. Each successful ping is written to the
shared savings ledger as a `cache-kept-warm` entry (see `docs/ledger.md` in the
repo), with no `tokensAvoided` and no dollar figure (see "Limitations"), in the file `~/.claude/claude-mods/ledger/cache-clock.<session-id>.jsonl`
(one file per session, every line has `"mod": "cache-clock"`). An older
`cache-clock.jsonl` is not migrated or deleted. After `/clear` the mod switches to the
new session's file if the session id changed.

### Limitations, stated plainly

- **A ping is not free, and the saving is not guaranteed.** A ping re-reads the
  whole cached context at the cache-read rate and adds a few output tokens, so
  it costs tokens itself. A saving only materialises if you come back before
  the cache would have expired anyway and the pings cost less than the cold
  start they avoided. If you never return, every ping was pure cost. On a very
  large chat, six pings can cost more than one cold start would. Keep
  `maxPings` low for huge chats.
- **The ledger claims no saving.** The mod cannot compute a conservative net
  (cache-write premium avoided minus the pings' own cost) from values the API
  reports, because it does not report your model's prices. So each ping is
  logged as `cache-kept-warm` with no `tokensAvoided` and no dollar estimate
  (the `savings-proof` mod counts only a numeric `tokensAvoided`, so these
  rows add nothing to its totals). The `note` holds plain facts only: which
  ping of the idle stretch it was and how many cached tokens it re-read (or,
  if the cache was already cold, how many tokens it wrote).
  Each such row also carries `helperTokens` (>= 0): the tokens the ping itself
  used, cache read + cache write + input + output from the ping's reported
  usage. It is reported beside, never netted into, anything else: the row still
  has no `tokensAvoided` and no dollar figure. These `helperTokens` are
  main-model cache-read/creation tokens of a ping, so the `savings-proof`
  Helper column mixes models.
- **Ledger rules** (`docs/ledger.md`): the session id in the file name has every
  character outside `A-Z a-z 0-9 _ -` replaced by `_` and is capped at 80
  characters. With no session id or no HOME the ledger is off. A missing file
  starts empty; any other read error turns the ledger off for the session, so
  existing history is never overwritten. Only JSON-object lines with a string
  `mod` are kept. The session id is looked up again before each write, so a
  `/clear` writes the old file out first and then uses the new one.
- **The lifetime is detected only in part, and otherwise assumed.** See "Cache
  lifetime" below. No call reports when the live cache entry expires, so the
  countdown is an estimate. If a ping finds the cache already cold (it wrote
  instead of read), the mod toasts once to say the lifetime shown is too long.
- **Hook failures are contained.** The `classic.*` hooks (resume seeding, model-switch lifetime) swallow their own errors and always pass the event on, so a failure leaves the clock unseeded or the lifetime unchanged and never disturbs the session or the model switch.
- **No effort override on the ping.** On some models a different effort level
  rewrites the whole cache entry, so the ping asks for haste in its prompt
  instead and leaves effort alone.
- **The clock starts at a turn, or at a resume.** On `resume` and `fork` starts
  it is seeded from the engine's `seconds_since_last_response` and
  `context_tokens` (the `classic.SessionStart` hook input). Otherwise there is
  no band until your first turn ends. Subagent turns do not count, only the
  main thread's.
- **Context size is the figure at the last response** (`$.session.usage()`),
  so it lags tool results added since.
- `$.model.fork` reports `nothing-to-fork` before the first turn and after
  `/clear`. The mod resets on `/clear` and never pings until a new turn ends.
- The handoff command is matched by plugin name (`handoff`) or the name
  `handoff`; a differently named command from another plugin is not detected.
- Not verified live. The behaviour was exercised with a mocked clock and a
  mocked `$.model.fork` only. The detection reads `cache_ttl` and
  `prompt_cache_likely_expired` as the types describe them; whether the live engine
  fills them as described, and which model's cache `cache_ttl` refers to when you
  switch, are unchecked. Whether the real fork refreshes the real cache
  entry, and whether a 1 Hz redraw looks right in a terminal, are unchecked.

## Cache lifetime

The API has two lifetimes, 5 minutes and 1 hour. With `ttlMinutes` at its
default of 0 the mod works out which one applies, in this order:

1. **Option.** `ttlMinutes` above 0 is used as given and nothing is detected.
2. **Model-switch hooks (detected).** Both `PreModelSwitch` and `PostModelSwitch`
   hook inputs carry `cache_ttl` (`5m` or `1h`) in the mod API types. The mod
   listens to them and uses the latest value. This is the only place the API
   states the lifetime outright, and it only arrives when you switch model
   (or the engine switches it for you), so in many sessions it never arrives.
3. **Resume or fork start (inferred).** The session-start input carries
   `seconds_since_last_response` and the engine's own `prompt_cache_likely_expired`.
   Since only 5m and 1h exist: judged still warm after more than 5 minutes means
   1h; judged expired within the hour means 5m. A resume that fits both (for
   example warm after 2 minutes) says nothing. This is an inference from the
   engine's verdict, not a stated lifetime, and a model-switch reading always
   replaces it.
4. **Assumed: 5 minutes.** When none of the above applies, the mod assumes the
   short lifetime, so it never claims a warm cache that may be gone. The cost
   of a wrong guess is a "cold" label on a cache that is still warm, and Keep
   warm pings sooner than needed.

What is not used: `prompt_cache_warm` (a one-off flag at a model switch, not a
lifetime), the token usage on `turn.complete` and `$.session.usage()` (counts of
tokens only, with no lifetime or 5m/1h split), and the rate limits (account
usage windows, unrelated to the cache). If you know your cache is 1 hour and
want the band right before any switch or resume, set `ttlMinutes` to 60.

## Options


| Option | Default | Meaning |
|---|---|---|
| `ttlMinutes` | 0 | Cache lifetime after the last response in minutes. 0 = detect it (model-switch hooks, then resume inference), else assume 5. Any value above 0 overrides detection |
| `minTokens` | 20000 | Band stays hidden below this context size |
| `handoffTokens` | 150000 | Cold and at least this big: offer a fresh chat |
| `maxPings` | 6 | Pings per idle stretch |
| `keepWarmDefault` | false | Start sessions with Keep warm on |

## Development

See `docs/toolchain.md` in the repo for the validate, type-check and test
commands. Code layout: `hooks/register.tsx` (hooks and band),
`hooks/logic.ts` (pure countdown and ping rules), `hooks/ledger.ts` (per-session ledger
writer), `hooks/register.test.tsx` (tests), `types/index.d.ts` (state typing).
