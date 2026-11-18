import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { createLedger } from './ledger'
import {
  PRICE_TABLE_DATE,
  PRICE_USD_PER_MTOK_INPUT,
  decide,
  helperTokensOf,
  isHoldActive,
  isLevel,
  isManualChange,
  levelUnderHold,
  modelPrompt,
  parseCommandArg,
  parseModelAnswers,
  readSettings,
  scorePrompt,
} from './logic'
import type { Answers, Level, Mode, Score } from './logic'

const mode = atom({ plugin: 'effort-optimizer', key: 'mode' } as const, 'suggest')
const offer = atom({ plugin: 'effort-optimizer', key: 'offer' } as const, null)
const active = atom({ plugin: 'effort-optimizer', key: 'active' } as const, null)

// The validator follows `$` only into top-level function declarations, so every helper that
// touches the engine is one, and shares its state through this object.
type Ctx = {
  mode: Mode
  settings: ReturnType<typeof readSettings>
  /** Main-thread turns started so far (this session, reset by /clear). */
  turns: number
  /** The score of the prompt just submitted; consumed by the first step of its turn. */
  pick: Score | null
  /** The level this mod applies to every main-thread request, or null (the session's own level stands). */
  active: Level | null
  /** Turn number of the last switch, null before the first. */
  lastSwitchNo: number | null
  /** The level the engine asked for on the latest first step, before this mod rewrote it. */
  seen: Level | null
  /** The turn number on which the person's own level change was detected; null: none, or it expired. */
  manualAtTurn: number | null
  /** The model id the engine named on the latest first step; a change of it explains a change of default effort. */
  model: string | null
  /** The score behind the offer on screen, for its wording and the ledger. */
  offered: Score | null
  /** A main-thread turn is running (between its start and its completion). */
  inTurn: boolean
  /** A Switch accepted mid-turn: applied at the first request of the next turn, never to the rest of this one. */
  pending: Score | null
  ledger: ReturnType<typeof createLedger> | null
}

async function setActive($: EngineInterface, ctx: Ctx, level: Level | null) {
  ctx.active = level
  await update($, active, () => level)
}

async function setOffer($: EngineInterface, ctx: Ctx, score: Score | null) {
  ctx.offered = score
  await update($, offer, () => (score === null ? null : score.level))
}

async function setMode($: EngineInterface, ctx: Ctx, next: Mode) {
  ctx.mode = next
  await update($, mode, () => next)
  if (next === 'off') {
    await setActive($, ctx, null)
    await setOffer($, ctx, null)
    ctx.pick = null
    ctx.pending = null
  }
}

/** Records the switch: state, toast and one ledger `info` line (no savings claim: effort cost is not measurable). */
async function applySwitch($: EngineInterface, ctx: Ctx, score: Score, how: 'auto' | 'accepted') {
  const from = ctx.active ?? ctx.seen
  await setActive($, ctx, score.level)
  await setOffer($, ctx, null)
  ctx.lastSwitchNo = ctx.turns
  const why = score.reasons.length > 0 ? score.reasons.join(', ') : 'no special signals'
  $.ui.toast(`effort-optimizer: effort ${from ?? '?'} -> ${score.level} (${why})`, { timeoutMs: 6000 })
  const now = await $.clock.now()
  await ctx.ledger?.add({
    ts: new Date(now).toISOString(),
    kind: 'info',
    note: `effort ${from ?? 'unknown'} -> ${score.level} (${how}; ${why}); no savings claimed`,
  })
  await ctx.ledger?.flush(now)
}

/** The first request of a main-thread turn: the one place the engine's own level is seen, so decisions are made here. */
async function firstStep($: EngineInterface, ctx: Ctx, seen: Level | null, model: string) {
  const score = ctx.pick
  ctx.pick = null
  // A /model switch changes the engine's default effort too: not the person's doing.
  const modelChanged = ctx.model !== null && model !== ctx.model
  ctx.model = model
  if (isManualChange(ctx.seen, seen, ctx.active, modelChanged)) {
    // With respectManual off there is no hold at all: nothing is recorded, nothing capped.
    if (ctx.settings.respectManual) {
      ctx.manualAtTurn = ctx.turns
      // The person's own level wins: stop overriding it.
      if (ctx.active !== null) await setActive($, ctx, null)
    }
  } else if (!isHoldActive(ctx.manualAtTurn, ctx.turns, ctx.settings.manualHoldTurns)) {
    ctx.manualAtTurn = null // expired
  }
  ctx.seen = seen
  // A Switch pressed during the previous turn lands here, at a request boundary of this turn.
  if (ctx.pending !== null && seen !== null) {
    const queued = ctx.pending
    ctx.pending = null
    await applySwitch($, ctx, queued, 'accepted')
  }
  // A model that takes no effort has nothing to switch; no prompt scored (e.g. a plugin's own) nothing to decide.
  if (seen === null || score === null) return
  // While a manual hold stands in auto mode, an upgrade for a costly prompt is the only thing applied, and never
  // past xhigh. Suggest mode is never capped: the offer and the decision both see the uncapped pick.
  const held = ctx.manualAtTurn !== null
  const level = levelUnderHold(score.level, {
    mode: ctx.mode,
    respectManual: ctx.settings.respectManual,
    manualAtTurn: ctx.manualAtTurn,
  })
  const picked = level === score.level ? score : { ...score, level }
  const decision = decide({
    mode: ctx.mode,
    pick: picked.level,
    current: ctx.active ?? seen,
    turnNo: ctx.turns,
    lastSwitchNo: ctx.lastSwitchNo,
    cooldownTurns: ctx.settings.cooldownTurns,
    isManual: held,
    respectManual: ctx.settings.respectManual,
    costly: score.answers.costly,
  })
  if (decision === 'switch') await applySwitch($, ctx, picked, 'auto')
  else if (decision === 'offer') await setOffer($, ctx, score)
  else await setOffer($, ctx, null)
}

/**
 * The optional classifier call is helper cost, not a saving: one `cost-upgrade` line with `helperTokens`
 * (reported usage if non-zero, else ceil(chars / 4)) and a negative dollar estimate at haiku's input price.
 * No prompt text goes in the note. A failed ledger write never affects scoring.
 */
async function logHelperCall(
  $: EngineInterface,
  ctx: Ctx,
  chars: number,
  usage: { input_tokens: number; output_tokens: number } | null,
) {
  try {
    const helperTokens = helperTokensOf(usage === null ? 0 : usage.input_tokens + usage.output_tokens, chars)
    const now = await $.clock.now()
    await ctx.ledger?.add({
      ts: new Date(now).toISOString(),
      kind: 'cost-upgrade',
      helperTokens,
      costUsdEstimate: -((helperTokens * PRICE_USD_PER_MTOK_INPUT.haiku) / 1_000_000),
      note: `effort classifier call (haiku, all tokens priced as input at ${PRICE_USD_PER_MTOK_INPUT.haiku} USD/MTok as of ${PRICE_TABLE_DATE})`,
    })
    await ctx.ledger?.flush(now)
  } catch {
    // The ledger is best effort.
  }
}

/** Scores the submitted prompt: rules first, plus one small-model call when `useModel` is on. */
async function pickFor($: EngineInterface, ctx: Ctx, text: string): Promise<Score> {
  let model: Answers | null = null
  if (ctx.settings.useModel) {
    try {
      const prompt = modelPrompt(text)
      const r = await $.model.complete({
        model: 'haiku',
        prompt,
        maxTokens: 80,
        effort: 'low',
        timeoutMs: 8000,
      })
      if (r.isAnswered) model = parseModelAnswers(r.text)
      await logHelperCall($, ctx, prompt.length + (r.isAnswered ? r.text.length : 0), 'usage' in r ? r.usage : null)
    } catch {
      model = null
    }
  }
  return scorePrompt(text, model)
}

/**
 * Between turns the switch applies at once (the next request is a turn's first). During a running
 * turn it is queued for the next turn's first request: rewriting the remaining steps could change
 * the request prefix mid-turn and drop the prompt cache.
 */
async function acceptOffer($: EngineInterface, ctx: Ctx, isWorking: boolean) {
  const score = ctx.offered
  if (score === null) return
  if (ctx.inTurn || isWorking) {
    ctx.pending = score
    await setOffer($, ctx, null)
    $.ui.toast(`effort-optimizer: will switch to ${score.level} from your next prompt, not mid-turn (keeps the prompt cache)`, {
      timeoutMs: 6000,
    })
    return
  }
  await applySwitch($, ctx, score, 'accepted')
}

async function runCommand($: EngineInterface, ctx: Ctx, args: string): Promise<string> {
  const arg = parseCommandArg(args)
  if (arg === null) return 'Usage: /effort-optimizer on|off|auto|suggest'
  if (arg === 'status') {
    const level = ctx.active === null ? 'the session level' : ctx.active
    const queued = ctx.pending === null ? '' : `; ${ctx.pending.level} queued for your next prompt`
    const hold = ctx.settings.manualHoldTurns
    const left = ctx.manualAtTurn === null ? 0 : ctx.manualAtTurn + hold - ctx.turns
    const manual =
      ctx.manualAtTurn === null || !isHoldActive(ctx.manualAtTurn, ctx.turns, hold)
        ? ''
        : hold === 0
          ? '; you set a level yourself (kept until /clear)'
          : `; you set a level yourself (kept for ${left} more turn${left === 1 ? '' : 's'})`
    return `effort-optimizer: mode ${ctx.mode}; applying ${level}${queued}; cooldown ${ctx.settings.cooldownTurns} turns${manual}.`
  }
  const next: Mode = arg === 'on' ? (ctx.settings.mode === 'off' ? 'suggest' : ctx.settings.mode) : arg
  await setMode($, ctx, next)
  return `effort-optimizer: mode is now ${next}.`
}

export const register: Register = (on, options) => {
  const settings = readSettings(options)
  const ctx: Ctx = {
    mode: settings.mode,
    settings,
    turns: 0,
    pick: null,
    active: null,
    lastSwitchNo: null,
    seen: null,
    manualAtTurn: null,
    model: null,
    offered: null,
    inTurn: false,
    pending: null,
    ledger: null,
  }

  on('session.start', async ($, e, next) => {
    // Nothing here may stop the command from registering.
    try {
      ctx.ledger = createLedger($)
      await ctx.ledger.load()
    } catch {
      ctx.ledger = null
    }
    try {
      await update($, mode, () => ctx.mode)
    } catch {
      // The mode atom is only for the display.
    }
    await $.command.register({
      name: 'effort-optimizer',
      description: 'Set the effort optimizer mode: on, off, auto or suggest',
      argumentHint: '[on|off|auto|suggest]',
      immediate: true,
    })
    return next(e)
  })

  on('command.run', { command: 'effort-optimizer' }, async ($, e) => ({ text: await runCommand($, ctx, e.args) }))

  on('prompt.submit', async ($, e, next) => {
    if (ctx.mode !== 'off' && e.command === undefined && e.isMeta !== true && e.text.trim() !== '') {
      try {
        ctx.pick = await pickFor($, ctx, e.text)
      } catch {
        ctx.pick = null
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) {
      ctx.turns += 1
      ctx.inTurn = true
    }
    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined) ctx.inTurn = false
    return next(e)
  })

  // The one hook that can change a request's effort: a rewrite is not carried to later steps, so it is repeated on each.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined || ctx.mode === 'off') return yield* next(e)
    const seen = isLevel(e.effort) ? e.effort : null
    if (e.index === 0) {
      try {
        await firstStep($, ctx, seen, e.model)
      } catch {
        // A failed decision must never stop the request.
      }
    }
    if (ctx.active !== null && seen !== null && seen !== ctx.active) {
      return yield* next({ ...e, effort: ctx.active })
    }
    return yield* next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      ctx.turns = 0
      ctx.pick = null
      ctx.lastSwitchNo = null
      ctx.seen = null
      ctx.manualAtTurn = null
      ctx.model = null
      ctx.inTurn = false
      ctx.pending = null
      await setActive($, ctx, null)
      await setOffer($, ctx, null)
    }
    await ctx.ledger?.flush(await $.clock.now(), true)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const level = await read($, offer)
    if (e.props.hasSurvey || level === null || ctx.mode !== 'suggest') return next(e)
    const deferred = ctx.inTurn || e.props.isWorking
    const why = ctx.offered !== null && ctx.offered.reasons.length > 0 ? ctx.offered.reasons.join(', ') : 'no special signals'
    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box>
        <Text bold color="claude">Effort </Text>
        <Text dimColor>{`This prompt looks like: ${why}. `}</Text>
        <Button
          key="switch"
          label={deferred ? `Switch to ${level} from next prompt` : `Switch to ${level}`}
          onPress={() => acceptOffer($, ctx, deferred)}
        />
      </Box>
    )
  })
}
