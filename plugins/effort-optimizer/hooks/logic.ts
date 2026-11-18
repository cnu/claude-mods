// Pure helpers: no engine calls, so tests and the hooks share one source of truth.

export type Level = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type Mode = 'suggest' | 'auto' | 'off'

export const LEVELS: readonly Level[] = ['low', 'medium', 'high', 'xhigh', 'max']

export const isLevel = (v: unknown): v is Level => typeof v === 'string' && (LEVELS as readonly string[]).includes(v)
export const isMode = (v: unknown): v is Mode => v === 'suggest' || v === 'auto' || v === 'off'

export type Settings = {
  mode: Mode
  useModel: boolean
  cooldownTurns: number
  respectManual: boolean
  /** Main-thread turns a manual level is respected for; 0 = until /clear. */
  manualHoldTurns: number
}

/** Options as the engine hands them, with the spec's defaults; bad values fall back. */
export const readSettings = (o: Readonly<Record<string, unknown>>): Settings => ({
  mode: isMode(o.mode) ? o.mode : 'suggest',
  useModel: o.useModel === true,
  cooldownTurns:
    typeof o.cooldownTurns === 'number' && Number.isFinite(o.cooldownTurns) && o.cooldownTurns >= 1
      ? Math.floor(o.cooldownTurns)
      : 2,
  respectManual: o.respectManual !== false,
  manualHoldTurns:
    typeof o.manualHoldTurns === 'number' && Number.isFinite(o.manualHoldTurns) && o.manualHoldTurns >= 0
      ? Math.floor(o.manualHoldTurns)
      : 10,
})

/** The four questions of the spec. */
export type Answers = {
  /** (a) a lookup, rename or mechanical edit */
  mechanical: boolean
  /** (b) needs multi-step planning */
  planning: boolean
  /** (c) unfamiliar or ambiguous code or domain */
  unfamiliar: boolean
  /** (d) a wrong answer is expensive: data loss, production, security */
  costly: boolean
}

/**
 * The spec's mapping. Only (a) -> low; none -> medium; (b) or (c) -> high;
 * (b) and (c), or (d) -> xhigh. `max` is never picked: it is left to the person.
 * (a) together with (b) or (c) is not "only (a)", so it falls to high.
 */
export const levelFor = (a: Answers): Level => {
  if (a.costly || (a.planning && a.unfamiliar)) return 'xhigh'
  if (a.planning || a.unfamiliar) return 'high'
  if (a.mechanical) return 'low'
  return 'medium'
}

const has = (text: string, re: RegExp): boolean => re.test(text)

const MECHANICAL = [
  /\brename\b/,
  /\btypo\b/,
  /\bwhat('s| is| does)\b/,
  /\bwhere (is|are|does)\b/,
  /\b(find|locate|show|list|print|open|read|cat|grep|search for)\b/, // a debugging prompt is excluded in heuristicAnswers
  /\b(bump|reformat|format|lint|sort|indent|add an? (import|comment|log))\b/,
  /\bchange\b.{1,60}\bto\b/,
  /\b(replace|swap)\b.{1,60}\b(with|for)\b/,
  /\bfix (the |a )?(typo|spelling|whitespace)/,
]
const PLANNING = [
  /\b(plan|design|architect(ure)?|roadmap|strategy|trade-?offs?)\b/,
  /\b(refactor|restructure|redesign|rewrite|migrate|migration|overhaul)\b/,
  /\b(implement|build|create|add)\b.{1,80}\b(feature|system|service|pipeline|module|workflow|endpoint|api)\b/,
  /\bstep[- ]by[- ]step\b/,
  /\b(first|then|after that|finally)\b.*\b(then|after that|finally|and then)\b/,
  /\bacross (all |the |many |multiple )?(files|modules|services|repos?|packages)\b/,
  /^\s*(\d+[.)]|[-*])\s+\S/m,
]
const UNFAMILIAR = [
  /\b(debug|diagnose|investigate|root cause|figure out|work out|track down)\b/,
  /\bwhy ?(is|'s|does|do|are|did|won'?t|isn'?t|doesn'?t)\b/,
  /\b(why|how come)\b.{0,60}\b(fail(s|ing|ed)?|crash(es|ed|ing)?|broken|breaks?|hangs?|hanging|throws?|not working|doesn'?t work)\b/,
  /\b(cause|culprit) (of|for|behind)\b|\bwhat('s| is| was) (the )?(cause|reason|culprit|problem|issue)\b|\b(causing|caused by)\b/,
  /\b(crash(es|ed|ing)?|segfaults?|stack ?trace|deadlock|memory leak|regression)\b|\b(is|are|keeps?|started|stopped) (failing|crashing|breaking|hanging)\b/,
  /\b(intermittent|flaky|race condition|heisenbug|sometimes fails|only sometimes)\b/,
  /\b(not sure|unsure|no idea|unclear|ambiguous|i don'?t know|don'?t understand|confus)/,
  /\b(legacy|unfamiliar|new to me|unknown codebase|undocumented)\b/,
  /\bwhat('s| is) (going on|wrong|happening)\b/,
]
const COSTLY = [
  /\b(production|prod)\b/,
  /\b(drop|truncate|delete|wipe|purge)\b.{0,40}\b(table|database|db|data|bucket|volume|branch|records?|users?)\b/,
  /\brm -rf\b|\bforce[- ]push\b|\bgit reset --hard\b/,
  /\b(credentials?|secrets?|api[- ]keys?|tokens?|passwords?|private key)\b/,
  /\b(security|vulnerabilit(y|ies)|auth(entication|orization)?|encryption|permissions?)\b/,
  /\b(payments?|billing|invoice|refund|charge customers?|money)\b/,
  /\b(deploy|release|rollback|hotfix)\b.{0,30}\b(prod|production|live)\b/,
  /\b(data loss|irreversible|can'?t undo|backup)\b/,
]

const anyOf = (text: string, res: readonly RegExp[]): boolean => res.some(re => has(text, re))

export type Score = { answers: Answers; level: Level; reasons: string[] }

/**
 * Answers the four questions from the prompt text alone (no engine call).
 * Heuristic and cheap: keywords plus length. A long prompt reads as planning
 * work, a very short one without such words as mechanical.
 */
export const heuristicAnswers = (text: string): Answers => {
  const t = text.toLowerCase().trim()
  const length = t.length
  const planning = anyOf(t, PLANNING) || length > 700
  const unfamiliar = anyOf(t, UNFAMILIAR)
  const costly = anyOf(t, COSTLY)
  // A short prompt (up to 200 chars) that names a mechanical verb is a lookup or small edit,
  // unless it is a debugging question ("find the cause of the crash"): that is not a plain lookup.
  const mechanical = length > 0 && length <= 200 && !unfamiliar && anyOf(t, MECHANICAL)
  return { mechanical, planning, unfamiliar, costly }
}

/** Combines two answer sets: a "yes" from either side stands, except (a) which needs both to agree. */
export const mergeAnswers = (rules: Answers, model: Answers | null): Answers =>
  model === null
    ? rules
    : {
        mechanical: rules.mechanical && model.mechanical,
        planning: rules.planning || model.planning,
        unfamiliar: rules.unfamiliar || model.unfamiliar,
        costly: rules.costly || model.costly,
      }

const REASON_NAMES: readonly [keyof Answers, string][] = [
  ['mechanical', 'lookup or mechanical edit'],
  ['planning', 'multi-step planning'],
  ['unfamiliar', 'unfamiliar or ambiguous'],
  ['costly', 'expensive if wrong'],
]

/** The four-question scoring: text (and optional small-model answers) in, answers, level and reasons out. */
export const scorePrompt = (text: string, model: Answers | null = null): Score => {
  const answers = mergeAnswers(heuristicAnswers(text), model)
  return {
    answers,
    level: levelFor(answers),
    reasons: REASON_NAMES.filter(([k]) => answers[k]).map(([, name]) => name),
  }
}

/** The one-message ask sent to the small model when `useModel` is on. */
export const modelPrompt = (text: string): string =>
  [
    'Answer four yes/no questions about the task below. Reply with ONLY a JSON object',
    '{"mechanical":bool,"planning":bool,"unfamiliar":bool,"costly":bool} and nothing else.',
    'mechanical: a lookup, rename or mechanical edit. planning: needs multi-step planning.',
    'unfamiliar: the code or domain is unfamiliar or the request is ambiguous.',
    'costly: a wrong answer is expensive (data loss, production, security).',
    '',
    'Task:',
    text.slice(0, 2000),
  ].join('\n')

/** Reads the small model's reply; null when it is not the expected JSON (the rules then stand alone). */
export const parseModelAnswers = (reply: string): Answers | null => {
  const m = /\{[^{}]*\}/.exec(reply)
  if (m === null) return null
  try {
    const o: unknown = JSON.parse(m[0])
    if (typeof o !== 'object' || o === null) return null
    const r = o as Record<string, unknown>
    const keys = ['mechanical', 'planning', 'unfamiliar', 'costly'] as const
    if (!keys.every(k => typeof r[k] === 'boolean')) return null
    return {
      mechanical: r.mechanical === true,
      planning: r.planning === true,
      unfamiliar: r.unfamiliar === true,
      costly: r.costly === true,
    }
  } catch {
    return null
  }
}

/**
 * Cooldown, for downgrades and lateral moves only (an upgrade is never held back: see `decide`).
 * `turnNo` is the number of the turn about to run (1 for the first),
 * `lastSwitchNo` the turn the last switch was made for (null: never switched).
 * With cooldownTurns 2, a switch for turn 5 allows the next one for turn 7.
 */
export const canSwitch = (turnNo: number, lastSwitchNo: number | null, cooldownTurns: number): boolean =>
  lastSwitchNo === null || turnNo - lastSwitchNo >= cooldownTurns

/**
 * Whether a manual choice made on turn `manualAtTurn` still holds on turn `turnNo`. It holds for
 * `holdTurns` turns counting the one it was detected on; `holdTurns` 0 never expires. Null: no manual choice.
 */
export const isHoldActive = (manualAtTurn: number | null, turnNo: number, holdTurns: number): boolean =>
  manualAtTurn !== null && (holdTurns === 0 || turnNo - manualAtTurn < holdTurns)

/** The highest level an upgrade may reach while a manual hold is active: `max` stays the person's. */
export const HOLD_CAP: Level = 'xhigh'

/** True when `level` is above the hold cap. */
export const isAboveHoldCap = (level: Level): boolean => LEVELS.indexOf(level) > LEVELS.indexOf(HOLD_CAP)

/**
 * The level to act on for `pick`. Only `auto` mode, with `respectManual` on and a manual hold in force
 * (`manualAtTurn` set), caps it at `HOLD_CAP`. In `suggest` mode, or with `respectManual` off, the pick is
 * returned as is, so an offer and a decision always see the same level.
 */
export const levelUnderHold = (
  pick: Level,
  o: { mode: Mode; respectManual: boolean; manualAtTurn: number | null },
): Level => (o.mode === 'auto' && o.respectManual && o.manualAtTurn !== null && isAboveHoldCap(pick) ? HOLD_CAP : pick)

/** Input prices in USD per million tokens, as of 2026-11-17 (a dated copy; the ledger cost figure is an estimate). */
export const PRICE_USD_PER_MTOK_INPUT = { haiku: 0.1, sonnet: 2, opus: 4, fable: 8 } as const
export const PRICE_TABLE_DATE = '2026-11-17'

/** Tokens of one helper call: the reported usage if non-zero, else ceil(chars / 4) of what was sent and received. */
export const helperTokensOf = (reported: number, chars: number): number => (reported > 0 ? reported : Math.ceil(chars / 4))

/**
 * Whether the person changed the level themselves. `seen` is the level the
 * engine asked for on the last step (before this mod rewrote it); `last` the one
 * before; `applied` what this mod last sent. A change to a level this mod itself
 * is sending is not counted (on models that take effort per message, a rewrite
 * can stand into the next step). A change that arrives together with a model change (`modelChanged`)
 * is not counted either: the engine's default effort differs per model, so the move says nothing about
 * the person. The cost: an effort change made in the very same turn boundary as a model switch is missed.
 */
export const isManualChange = (
  last: Level | null,
  seen: Level | null,
  applied: Level | null,
  modelChanged = false,
): boolean => !modelChanged && last !== null && seen !== null && seen !== last && seen !== applied

export type PickInput = {
  mode: Mode
  pick: Level
  /** What the session runs at now: this mod's own level if active, else the engine's. Null when not yet known. */
  current: Level | null
  turnNo: number
  lastSwitchNo: number | null
  cooldownTurns: number
  /** A manual hold is active (see `isHoldActive`). */
  isManual: boolean
  respectManual: boolean
  /** Question (d): a wrong answer is expensive. Only such a pick may upgrade through a manual hold. */
  costly: boolean
}

export type Decision = 'none' | 'offer' | 'switch'

/** True when the pick is a higher level than the current one (unknown current: not an upgrade). */
export const isUpgrade = (pick: Level, current: Level | null): boolean =>
  current !== null && LEVELS.indexOf(pick) > LEVELS.indexOf(current)

/**
 * What to do about a pick, per mode, cooldown and manual choice. The cooldown only throttles
 * downgrades and lateral moves: a riskier prompt than the active level (dropping a prod table at
 * the previous prompt's `low`) is switched or offered at once, in both modes. A manual hold blocks
 * `auto` switches, with one exception: an upgrade for a costly prompt, up to `xhigh` (never `max`, never down).
 */
export const decide = (i: PickInput): Decision => {
  if (i.mode === 'off') return 'none'
  if (i.pick === i.current) return 'none'
  if (!isUpgrade(i.pick, i.current) && !canSwitch(i.turnNo, i.lastSwitchNo, i.cooldownTurns)) return 'none'
  if (i.mode === 'suggest') return 'offer'
  if (i.isManual && i.respectManual) {
    return i.costly && isUpgrade(i.pick, i.current) && !isAboveHoldCap(i.pick) ? 'switch' : 'none'
  }
  return 'switch'
}

/** Parses `/effort-optimizer <arg>`: `on` (the configured mode, or suggest if that is off), off, auto, suggest; empty shows status. */
export const parseCommandArg = (args: string): Mode | 'on' | 'status' | null => {
  const a = args.trim().toLowerCase()
  if (a === '') return 'status'
  if (a === 'on' || a === 'off' || a === 'auto' || a === 'suggest') return a
  return null
}
