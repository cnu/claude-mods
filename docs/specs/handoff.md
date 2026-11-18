# handoff

**Goal:** when a chat gets huge, carry the useful state into a fresh chat so
the person stops paying to re-read a giant history.

## Behaviour
1. Watch context size after each turn. At `thresholdTokens` (default 250,000)
   show a toast and a band offering "Refresh". Offer once per threshold
   crossing; "Not now" snoozes for `snoozeTurns` turns.
2. `/refresh` (slash command) also starts it on demand.
3. Refresh steps, shown as a pane/band with a progress bar per step:
   save a draft of the request first -> ask the model (one fork/complete call)
   to write a handoff note: goal, decisions made, files touched, open tasks,
   exact next step, anything the new chat must not forget -> write it to disk
   -> offer "Copy note", "Open note path", and "Clear and continue with it" (destructive: needs a second confirm press within ~10 s and the note verified on disk first).
4. Always write the handoff to `~/.claude/handoffs/claude-mods-<timestamp>.md` (the `claude-mods-` prefix keeps our files distinguishable from any other tool's in that folder), and append
   one line per run to `~/.claude/handoffs/handoff.<session-id>.log` (per session, no shared-file races; with no session id write no log at all and toast that logging is off) (time, session id,
   tokens before, result). Save the draft before calling the model so a failure
   loses nothing.
5. If the model call fails, say so, keep the draft, never lose the run.
6. Ledger: write a `handoff` entry with tokens before the refresh; its `session` field is the sanitised session id, as in the file name.

## Options
`thresholdTokens`, `snoozeTurns`, `maxHandoffChars`.
