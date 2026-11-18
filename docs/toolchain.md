# Offline toolchain for mods

How to validate, type-check and test a Claude Code mod without loading it into
a live session. Verified on Claude Code 2.1.326 (the CLI) with the bundled authoring docs
written by 2.1.321 (they lag the CLI by a patch version; check the first line of
`claude-code.d.ts` against `claude --version` and re-copy if they differ), using `plugins/cache-clock` as the worked example. Run everything
from the repository root.

## 0. Where the API docs live

The engine unpacks them per version under a temp folder; the hash in the path
changes. Find it with:

    ls -d /tmp/claude-*/bundled-skills/*/*/plugin-authoring

It holds `reference.md` (the guide), `examples/` (`band.tsx`, `pane.tsx`,
`pane.test.tsx`, `tool-call.ts`) and `types/claude-code.d.ts` (about 23k lines,
the authority: grep it by name, never read it whole). Copy `claude-code.d.ts`
out; the folder is temporary and the glob can match several versions, so pick the
newest by hand:

    ls -dt /tmp/claude-*/bundled-skills/*/*/plugin-authoring | head -3
    mkdir -p .scratch/tc
    cp <that folder>/types/claude-code.d.ts .scratch/tc/

`.scratch/` is in `.gitignore`, so scratch files stay out of the plugin and the
repo.

## 1. Validate

    claude plugin validate plugins/cache-clock          # human report
    claude plugin validate plugins/cache-clock --json   # same, machine readable

Exit code 0 means "Validation passed". It reads the manifest and the hooks
module source and lists the hooks, `$` calls, env and state names it found. The
"Plugin directory checks" block (README, icon, install line) is advisory and
does not change the verdict; `--profile directory` makes it fail on those.

## 2. Type-check

The engine only writes `.claude-plugin/types/` into folders it hot-reloads, so
for an offline check keep the tsconfig outside the plugin.

Install TypeScript once into the scratch folder (5.4 or newer is required):

    mkdir -p .scratch/ts && (cd .scratch/ts && npm init -y >/dev/null && npm i typescript@5.9)

`.scratch/tc/tsconfig.json` (the header of `claude-code.d.ts` gives the options;
only `include` is ours):

    {
      "compilerOptions": {
        "target": "es2023", "lib": ["es2023"], "types": [],
        "module": "esnext", "moduleResolution": "bundler",
        "strict": true, "noUncheckedIndexedAccess": true,
        "noEmit": true, "skipLibCheck": true,
        "jsx": "react", "jsxFactory": "h", "jsxFragmentFactory": "Fragment"
      },
      "include": [
        "./claude-code.d.ts",
        "../../plugins/cache-clock/hooks",
        "../../plugins/cache-clock/types"
      ]
    }

Then:

    .scratch/ts/node_modules/.bin/tsc -p .scratch/tc/tsconfig.json

No output and exit 0 is a pass. To prove the check is live, `tsc ... --listFiles`
should list your files, or drop `const x: number = "a"` into a file under hooks/.
Add another plugin by adding its `hooks` and `types` folders to `include`. The
test files under `hooks/` are checked too, because `claude-code.d.ts` also
declares the `claude-code/testing` module.

## 3. Test

    claude plugin test plugins/cache-clock

It finds `*.test.ts` and `*.test.tsx` in subfolders (verified for `hooks/` and a
scratch `zz/`; we keep `hooks/register.test.tsx` beside the module). Import `describe`, `test`,
`expect`, `mock` from `claude-code/testing`. Output is bun-test style
(`(pass) name [ms]`, then counts). The default timeout is 5000 ms per test;
raise it with `test(name, { timeoutMs: 20_000, options: {...} }, body)`.

### How the test kit works (what we learned)

- `test(name, async ($, on) => ...)`: `$` is the real engine with your plugin
  loaded; `on` registers hooks that sit BENEATH every plugin, standing for the
  engine. Register them before the first `$` call. Anything your plugin calls on
  `$` that no beneath-hook answers throws, naming the event.
- A call on `$` is answered `{ value }`: `on('session.usage', () => ({ value: {...} }))`,
  `on('model.fork', () => ({ value: {...} }))`, `on('ui.toast', ...)`,
  `on('fs.write', (_, e) => ...)` (`e.path`, `e.text`). An event is answered by
  its own result: `on('session.start', (_, e) => ({ cwd: e.cwd }))`,
  `on('turn.complete', (_, e) => ({ text: e.answer }))`,
  `on('session.end', (_, e) => ({ sessionId: e.sessionId }))`,
  `on('turn.start', (_, e) => ({ turnId: e.turnId }))`.
- Raise events from the test with `$.session.start({...})`, `$.turn.start({...})`,
  `$.turn.complete({ answer, durationMs, isAborted, turnId, reason })`,
  `$.session.end({ reason, sessionId, resume: { id } })`.
- `mock.clock(on, { now })` returns `{ advance(ms), settle(), set(ms), now() }`.
  `$.clock.every/after/sleep` only fire when the test advances it. Each tick
  runs its handler before the next fires, so `advance(30 * 60_000)` with a 1 s
  `every` really runs 1,800 handlers: it is real work. Prefer small TTL options
  in tests (`{ options: { ttlMinutes: 5 } }`) over advancing a day.
- `mock.env(on, { HOME: '/home/t' })`, `mock.store(on)`, `mock.session(on)`.
- UI: `const ui = await $.ui.mount({ plugin, surface, component, requestId, props })`,
  then `ui.find({ type: 'Text', text: /re/ })`, `ui.find({ key })`,
  `await ui.press({ key })`, `ui.unmount()`. `find` returns `{ text }`. State-atom
  changes (`update`) redraw a mounted drawing; clock advances that change an atom
  the render read are reflected on the next `find`. A `Text` has no `key`, find
  it by words. The props for `AbovePrompt` are declared in `claude-code.d.ts`
  (grep `AbovePrompt: {`): `hasSurvey`, `isCollapsed`, `isWorking`, `maxRows`,
  `bodyColumns`, `scroll`, `view`. Register `on('ui.render', ...)` beneath to see "the mod drew nothing"
  (the engine's own text shows instead).
- Plugin options: `test(name, { options: { ttlMinutes: 5 } }, body)`. Manifest
  defaults fill in what you leave out. Options are validated against `userConfig`
  at load, so a bad one fails the load: `ttlMinutes: 500` against `max: 120` gave
  "must be at most 120", and a string gave "must be a number" (verified).
  `title`, `min`, `max`, `default` and `type` are all honoured.
- A classic hook event needs a beneath answer too: `on('classic.SessionStart', () => ({}))`,
  raised with `$.classic.SessionStart({ source: 'resume', ... })`.
- `claude plugin test` runs a whole file in about 16 s here. The mock clock runs
  each 1 s tick for real, so an advance of 60 minutes is ~3 s: give such tests
  `timeoutMs`.
- Mutation check: temporarily break a rule and confirm tests fail; ours did
  (removing the `maxPings` guard failed 3 tests).

## 4. Gotchas hit while writing cache-clock

1. **The validator follows `$` only into top-level function declarations.**
   `$` passed to an arrow function defined inside `register`, to an imported
   `const f = ($) => ...`, or a callback variable is rejected ("`$` is passed to
   ... which is not a function declared at the top of this file"). Use
   `function name($: EngineInterface, ...) {}` at module top level, or in an
   imported file, and pass state in an argument object. `export function`
   declarations in a separate file are fine (`hooks/ledger.ts`).
2. **Atom refs must be literal.** `atom({ plugin: 'x', key: 'y' } as const, init)`
   written inline; a helper `ref(key)` is refused.
3. **State typing is parsed from source text.** `types/index.d.ts` must contain
   `declare module 'claude-code' { interface PluginState { 'plugin-name': { key: Type; ... } } }`
   with the keys written inline; a type alias for the inner object is not followed
   ("cache-clock.x is not declared"). Our file has no top-level import/export and tsc
   accepts it (the ambient declaration merges with the engine's).
4. `plugin.json` has `"types": "./types/index.d.ts"` (as the brief said). The
   authoring guide describes that field for plugins that add a noun to `$`; for a
   state-only plugin like this one the validator prints the informational note
   "types ... declares on $: nothing (no EngineInterface member)" and then lists
   the state keys it found. Removing the field changed nothing in the validator
   output (it still found the file by its path), so we kept it as documented.
5. **`userConfig`** takes `{ type, title, description, default, min, max }` per
   key (`type`: number, string, boolean); the engine enforces type, min and max
   at load. Values arrive in `register(on, options)` as numbers/booleans.
6. **Summarising hook.** In this setup an input-router hook rewrites big file
   reads and command output into model-written notes (anything over about 100
   lines or 2,000 tokens). Read the 23k-line `claude-code.d.ts` with `grep -n`
   plus `sed -n 'A,Bp' | cut -c1-150` over ranges under 60 lines. A grep that
   matches nothing makes `sed -n "${N}p"` print the whole file when `$N` is
   empty: guard with `[ -n "$N" ]`.
7. **Hook budget and timers.** `$.clock.every` started from `session.start`
   outlives the hook. A `/clear` raises `session.end` with `reason: 'clear'` and
   no `session.start`, so reset state in `session.end` rather than expecting a
   fresh start. `turn.complete` also fires for subagent runs (`e.agentId` set);
   skip those for main-thread bookkeeping.
8. **`classic.SessionStart`** carries `seconds_since_last_response`,
   `context_tokens` and `prompt_cache_likely_expired` on resume/fork starts, and
   the model-switch inputs carry `cache_ttl` and `prompt_cache_warm`: the only
   places the API states cache facts. **`$.model.fork` and effort.** Passing an `effort` different from the
   session's can rewrite the whole cache on some models; leave it out and ask
   for haste in the prompt instead. Fork results include `usage.cache_read_input_tokens`,
   which tells you whether the ping really hit the cache. `nothing-to-fork`
   before the first turn and after `/clear`.
9. No `tsc` on PATH by default; the repo-local install above avoids a global
   one. TypeScript 7.x found in other projects was not used.
10. **Not covered offline:** real rendering (colors, layout), the real engine
    cache behaviour, the actual `handoff` command name, and whether `AbovePrompt`
    redraws at 1 Hz in a live terminal. Load with `claude --plugin-dir` in a
    scratch session when you are allowed to.
