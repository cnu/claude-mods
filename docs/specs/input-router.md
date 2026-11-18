# input-router

**Goal:** big file reads and big connector (MCP) results flood the context.
Have a cheap model read them first and give the main model a short note plus the
path to the full thing.

## Behaviour
1. Hook Read-tool calls and MCP tool results. If the output is larger than
   `minChars` (default 12,000) and not an image/PDF/notebook the engine handles
   itself, send it to a cheap model (`helperModel`, default haiku) through the
   mod API's model call.
2. The helper returns notes for the task at hand: what the file is, the parts
   most likely to matter with line references, anything cut. The main model
   receives the notes plus an explicit line: where the full content is, and how
   to read an exact range (offset and limit) when it needs verbatim text.
   For MCP results, save the full result to a file first and give its path.
3. Never route: tiny outputs; files the model just wrote or edited in this turn;
   a repeated read of the same range right after a notes read (let it through
   whole: the model has asked for it); anything when `/input-router full` was
   issued, which lets the next one pass through whole, once.
4. If the helper fails, times out (`timeoutMs`, default 20,000) or returns
   nothing, let the original result through untouched. A call that was made and billed
   (answered, or unanswered with non-zero reported usage) but whose digest is then dropped
   (no answer, empty notes, notes >= 60% of the source, full copy not saved) is a wasted
   call: see 6.
5. Side pane lists each hand-off live: tool, target, size in, size out,
   tokens avoided (gross), helper tokens and estimated dollars side by side (never netted).
   Wasted calls show as `wasted (reason)` rows and as `| wasted W` in the total.
6. Ledger: one `tokens-avoided` entry per hand-off, `session` = sanitised id as in the
   file name. three separate numbers (docs/ledger.md): `tokensAvoided` = GROSS ceil((source - digest)/4) >= 0;
   `helperTokens` = the helper's cost (reported usage if non-zero, else ceil((payload + prompt overhead + reply)/4));
   `costUsdEstimate` = avoided * sessionModelInputPrice - helper * helperModelInputPrice (list input prices per
   family, copied from model-router, dated; may be negative and is logged anyway; omitted when either price is
   unknown). The note names both models.
   Subagent calls: `$.session.model()` is the main loop's model and the API does not expose a subagent's,
   so a subagent call is not priced at the main model: no `costUsdEstimate`, the note says
   `subagent: price unknown`, and the pre-call screen (7) is skipped.
   Wasted calls: kind `cost-upgrade`, `helperTokens` as above, no `tokensAvoided`,
   `costUsdEstimate` = -helper * helperModelInputPrice (negative; omitted when the helper price is unknown;
   known for subagents too), note = the reason, no content. An unanswered call with all-zero reported usage
   (aborted or refused: nothing billed is known) and a call that throws log nothing.
7. Before calling the helper, skip routing when `ceil(source/4) - 2*ceil(overhead/4)` is below 0
   (crude overhead guard, fixed), or when the estimated dollar impact
   `ceil(source/4)*mainPrice - ceil((min(source, cap) + overhead)/4)*helperPrice` is below
   `minEstimatedSavingUsd` (default 0). That impact is negative whenever the helper's price is not below
   the main model's, so the screen is not applied when a price is unknown, for a subagent call, or when both
   prices are equal and `routeWhenSamePrice` (default true) is on (with equal prices routing pays off
   only if the digest is reused over many later turns, which is not known before the call).

## Instruction files and Bash
Reads of CLAUDE.md / CLAUDE.local.md / SKILL.md / MEMORY.md, anything under a `.claude` folder, and `alwaysWholeGlobs` matches always pass through whole. Bash stdout routing is opt-in (`routeBash`, default off) and fail-closed on any sign of failure.

## Options
`minChars`, `helperModel`, `timeoutMs`, `maxNoteChars`, `excludeGlobs`, `alwaysWholeGlobs`, `routeBash`, `minEstimatedSavingUsd` (default 0), `routeWhenSamePrice` (default true), `retentionDays` (default 7; saved full copies older than this are overwritten with empty tombstones), `saveFullCopies` (default true; off = MCP/Bash results pass through whole).
