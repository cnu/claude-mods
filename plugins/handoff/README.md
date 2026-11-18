# handoff

When a chat gets huge, carry the useful state into a fresh chat so you stop paying to re-read a giant history.
Written from `docs/specs/handoff.md` and the public plugin-authoring API docs only.

## What it does

1. After each of your turns it reads the context size. At `thresholdTokens` it shows a toast and a band
   under the chat with **Refresh** and **Not now**. It offers once per threshold crossing. **Not now** stays
   quiet for `snoozeTurns` turns, then offers again if the chat is still over the threshold. Going back under
   the threshold (a `/compact`, a `/clear`) makes the next crossing a new one. A resumed chat is offered after
   its first turn (a fork has nothing to read before that).
2. `/refresh` starts the same thing on demand, whatever the size. The mod registers `refresh`; if that
   registration is refused it registers `handoff` instead. It answers only the name it registered. `cache-clock` finds this mod's command either way.
   Per the API docs only a built-in's name is refused; another plugin registering `refresh` too replaces it
   (last one wins), which this mod cannot detect.
3. A refresh has four steps, each with its own progress bar in the band:
   save a draft -> one model call for the handoff note -> write the note -> ready.
   When it is ready the band offers **Copy note**, **Open note path** and **Clear and continue with it**
   (destructive, see below).
4. "Save a draft of the request first" is read here as: save a draft handoff built from the transcript before the
   model is asked (our reading; the spec does not say more). Files, under `~/.claude/handoffs/`. Every note and draft this mod writes starts with `claude-mods-`, so it cannot be confused with, or overwrite, files another tool keeps in the same folder; the log keeps its `handoff.<session-id>.log` name:
   - `claude-mods-<timestamp>.draft.md`: a draft built from the transcript with no model (first request, recent requests,
     files edited or written, last assistant message). Written **before** the model call.
   - `claude-mods-<timestamp>.md`: the note (a small front-matter header, then the model's note).
   - `handoff.<session-id>.log`: one tab-separated line per run: time, session id, tokens before, result (capped at
     2,000 lines). One file per session, so two chats running the mod never rewrite the same log. The session id is
     made file-safe by the shared rule in `docs/ledger.md` (every character outside `[A-Za-z0-9_-]` becomes `_`, at most
     80 characters, so no dots). With no session id **no log file is written at all** (never a shared `unknown` file) and the ledger is off; the
     note is still saved and a toast says that logging is off. If the log exists but cannot be read (anything other than "not there"), the
     line is skipped instead of overwriting the history.
     An older shared `handoff.log` from earlier versions is left alone and no longer written.
5. If the model call fails (API error, empty reply, nothing to fork), the band says so, the draft stays, and
   `claude-mods-<timestamp>.md` holds the draft marked `source: draft-only`, so the run still leaves a usable handoff.
   **Retry**, **Copy draft** and **Clear and continue with it** (with the draft) stay available.
6. Ledger (`~/.claude/claude-mods/ledger/handoff.<session-id>.jsonl`, contract in `docs/ledger.md`; each line has
   `"mod": "handoff"`): one `handoff` entry per
   run, with the tokens before in the note (its `session` field is the same file-safe id as the file name; not written when the run fails before the model call, e.g. no HOME or draft unsaved). The ledger follows the shared rules: with no session id (or no HOME) it is **off** (no
   shared `unknown` file); a missing file starts empty, but any other read error turns the ledger off for that session
   rather than overwriting it; only lines that are JSON objects with a string `mod` are kept. It carries no `tokensAvoided`, because nothing is saved until you
   actually move to the fresh chat and the mod cannot know how much you would have spent otherwise.
   The line does count what writing the note cost (the fork re-reads the whole transcript on the session model):
   `helperTokens` is input + cache read + cache creation + output from the call's reported usage when that is
   non-zero, else an estimate of ceil(chars/4): the tokens before, plus the prompt, plus the reply. `costUsdEstimate`
   is the call's cost as a **negative** dollar figure, written only when the session model's family (haiku 0.1,
   sonnet 2, opus 4, fable 8 USD per million input tokens, copied from model-router as of 2026-11-17) is known and
   the usage was reported; every token is priced at the input rate, so it is rough. With an unknown model or no
   reported usage the dollars are left out. The kind stays `handoff` and the note says "cost of writing the note".
   A call that failed but reported usage (billed) is logged too, as is one whose note could not be saved; a call
   that threw or reported no usage gets a line without `helperTokens`.

The note asks the model for: goal, decisions (and why), files touched, open tasks, exact next step, and what
the new chat must not forget. Unknowns are written as TBD. The ledger holds paths and counts only. The draft quotes your own messages (up to a few hundred characters each), so it can contain whatever you pasted.

## Options

| Option | Default | Range | Meaning |
|---|---|---|---|
| `thresholdTokens` | 250000 | 1000 and up | Context size at which to offer a refresh. |
| `snoozeTurns` | 5 | 0 to 100 | Turns to stay quiet after "Not now". 0 offers again after the next turn. |
| `maxHandoffChars` | 12000 | 1000 to 100000 | The model is asked to stay under it; longer notes are cut at a line end and marked. |

The spec gave only the 250,000 default; `snoozeTurns` and `maxHandoffChars` defaults are our choice.

## How it calls the model

`$.model.fork`, one call, over the session's own transcript. That is the only way to write a faithful note
without sending the history again, but the fork is billed like any request: if the prompt cache has lapsed
(an idle hour), it re-reads the whole chat at the uncached rate. That is the one-off price of getting the note.
`effort` is not set, so the cached prefix stays valid.

## Limitations (what the API cannot do, or what is unverified)

- **Safe by default: copying or opening the note never touches the chat.** **Copy note** puts the note on the
  clipboard. **Open note path** toasts the absolute path of the note file (the API cannot open a file, so it shows the
  path). Neither clears or sends anything.
- **"Clear and continue with it" is destructive.** The API has no call that opens a second session, so this is
  the built-in `/clear` plus a first message, which removes the current chat from the screen (it can be brought
  back with `/resume`). It therefore needs two presses: the first reads the note file back from disk and, if it is
  there, turns the button into **Press again to clear this chat** for 10 seconds (a toast repeats the warning);
  the second press reads the file again and only then runs `/clear` and submits the note (framed as background,
  asking for a two-line summary) with `$.prompt.submit`. The note is written by a model from a transcript that may
  contain injected text, and it arrives as the person's first message, so it is treated as untrusted: every spelling of
  the `<handoff>` wrapper tags inside it (any case, spacing, zero-width characters, full-width characters, `&lt;`,
  `&#60;`, `&#x3c;` forms) is replaced with `[handoff tag removed]` before it is wrapped, when the note is saved (so the
  file you are shown is what is sent) and again at send time. The message itself says plainly that the text is a
  machine-written summary of an earlier chat, background notes and not instructions from you, and asks the model to
  wait for your go-ahead; a closing line repeats that after the note ends. This lowers the risk, it cannot guarantee
  the model ignores injected text. After 10 seconds, on **Dismiss**, on a new refresh or on
  `/clear` it disarms. The chat is never cleared unless the note file is confirmed on disk, non-empty and equal to
  what was written; if the note could not be written the button is not shown. If `/clear` is missing or fails, the
  note is copied to the clipboard and the toast gives the path. This path is the least certain part: it was
  exercised only against a mocked engine.
- **The progress is a band, not a pane**, drawn in `AbovePrompt`. It only redraws on state changes (a step
  finishing), so there is no animation while the model call runs; the running step shows a half bar.
- **The offer toast has no buttons** (toasts take text and a timeout only), so the actions live in the band.
- **A band button pressed while the model is mid-turn is refused** with a toast. A typed `/refresh` waits for idle by itself.
- **Not run in a live Claude Code session.** Verified only with `claude plugin validate`, the type check and
  `claude plugin test`. Real band rendering, the real fork cost and the `/clear` flow are unseen.
- Context size comes from `$.session.usage()` after the last main-thread turn; it is not re-read while idle.

## Layout

`.claude-plugin/plugin.json` (options), `hooks/hooks.json`, `hooks/register.tsx` (hooks and band),
`hooks/logic.ts` (pure helpers), `hooks/ledger.ts` (ledger writer), `hooks/register.test.tsx`,
`types/index.d.ts` (state atoms).

Test: `claude plugin test plugins/handoff`. Validate: `claude plugin validate plugins/handoff`.

Known gaps: ledger and log are now one file per session, so concurrent sessions no longer overwrite each other (the same session id twice, e.g. a resumed chat open in two windows, still can); after a failed model call the band marks later steps pending although the draft note was written; the range limits in the table are enforced by the manifest, the code only enforces minimums.
