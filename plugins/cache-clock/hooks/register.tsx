import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { createLedger } from './ledger'
import {
  formatClock,
  isBandVisible,
  isHandoffCommand,
  isRefresh,
  MAX_PING_FAILURES,
  mergeDetected,
  readSettings,
  remainingMs,
  resolveTtl,
  seedFromResume,
  shouldOfferHandoff,
  shouldPing,
  ttlFromLabel,
  ttlFromResume,
} from './logic'
import type { Settings } from './logic'

const lastTurnAt = atom({ plugin: 'cache-clock', key: 'lastTurnAt' } as const, null as number | null)
const tokens = atom({ plugin: 'cache-clock', key: 'tokens' } as const, 0)
const keepWarm = atom({ plugin: 'cache-clock', key: 'keepWarm' } as const, false)
const pings = atom({ plugin: 'cache-clock', key: 'pings' } as const, 0)
const tickAt = atom({ plugin: 'cache-clock', key: 'tickAt' } as const, 0)
// The lifetime read from the API (a model-switch hook input or a resume), or null: see resolveTtl.
const detectedTtl = atom(
  { plugin: 'cache-clock', key: 'detectedTtl' } as const,
  null as { ms: number; source: 'model-switch' | 'resume' } | null,
)
const handoffCommand = atom({ plugin: 'cache-clock', key: 'handoffCommand' } as const, null as string | null)

// A cheap prompt: the fork answers over the session's own cached transcript, so the cost is
// the cache read plus a few output tokens. Asking for haste in the prompt (not `effort`) keeps
// the cached prefix valid on every model: see ModelForkRequest.effort in the types.
const PING_PROMPT = 'Cache keep-alive. You have no tools here. Reply with exactly the word ok and nothing else.'

// Plain per-load bookkeeping that the hooks and the timer share. The engine's validator follows
// `$` only into top-level function declarations, so the helpers below are those and take `ctx`.
type Ctx = {
  settings: Settings
  isWorking: boolean
  isInFlight: boolean
  failures: number
  wasCold: boolean
  isOfferToasted: boolean
  isColdToastDone: boolean
  ledger: ReturnType<typeof createLedger> | null
}

async function resetStretch($: EngineInterface, ctx: Ctx, at: number) {
  ctx.failures = 0
  ctx.wasCold = false
  ctx.isOfferToasted = false
  ctx.isColdToastDone = false
  await update($, pings, () => 0)
  await update($, tickAt, () => at)
}

// The lifetime in force right now: the option, else what was detected, else 5 minutes.
async function currentTtl($: EngineInterface, ctx: Ctx) {
  return resolveTtl(ctx.settings.ttlMs, await read($, detectedTtl))
}

async function ping($: EngineInterface, ctx: Ctx) {
  ctx.isInFlight = true
  try {
    const r = await $.model.fork({ prompt: PING_PROMPT })
    const at = await $.clock.now()
    // An answered fork that neither read nor wrote any cache did not refresh anything: a failure.
    if (r.isAnswered && r.usage.cache_read_input_tokens + r.usage.cache_creation_input_tokens > 0) {
      ctx.failures = 0
      ctx.wasCold = false
      await update($, lastTurnAt, () => at)
      await update($, pings, n => n + 1)
      await update($, tickAt, () => at)
      const cached = r.usage.cache_read_input_tokens
      // Tokens the ping itself used: everything its reported usage counts, never negative or fractional.
      const u = r.usage
      const helperTokens = [u.cache_read_input_tokens, u.cache_creation_input_tokens, u.input_tokens, u.output_tokens].reduce(
        (sum, n) => sum + (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0),
        0,
      )
      const sessionId = await $.session.id()
      await ctx.ledger?.use(sessionId, at)
      // No `tokensAvoided` and no dollar figure: the API does not report this model's prices, so
      // no net saving can be computed. The note holds plain facts only (docs/ledger.md, honest numbers).
      const count = await read($, pings)
      ctx.ledger?.add({
        ts: new Date(at).toISOString(),
        session: sessionId,
        kind: 'cache-kept-warm',
        helperTokens,
        note:
          cached === 0
            ? `keep-warm ping ${count} of this idle stretch found the cache already cold; it wrote ${r.usage.cache_creation_input_tokens} tokens`
            : `keep-warm ping ${count} of this idle stretch re-read ${cached} cached tokens; the ping itself cost tokens, saving only if you return before expiry`,
      })
      if (cached === 0 && !ctx.isColdToastDone) {
        ctx.isColdToastDone = true
        const { source } = await currentTtl($, ctx)
        $.ui.toast(
          source === 'option'
            ? 'cache-clock: the ping found the cache already cold; is ttlMinutes longer than your host keeps it?'
            : 'cache-clock: the ping found the cache already cold, so it lasts less than the lifetime shown; set ttlMinutes to override it',
        )
      }
      return
    }
    ctx.failures += 1
    if (ctx.failures >= MAX_PING_FAILURES) {
      await update($, keepWarm, () => false)
      $.ui.toast(`cache-clock: keep warm switched off after ${ctx.failures} failed pings (${r.isAnswered ? 'no cache activity' : r.reason})`)
    }
  } catch {
    ctx.failures += 1
    if (ctx.failures >= MAX_PING_FAILURES) await update($, keepWarm, () => false)
  } finally {
    ctx.isInFlight = false
  }
}

// One tick a second. It redraws (writes tickAt) only while the band is visible and the
// countdown moves, plus once at the moment the cache goes cold.
async function tick($: EngineInterface, ctx: Ctx) {
  const { settings } = ctx
  const now = await $.clock.now()
  const lastAt = await read($, lastTurnAt)
  if (lastAt === null) return
  const ttl = (await currentTtl($, ctx)).ms
  const tok = await read($, tokens)

  const wantsPing = shouldPing({
    keepWarm: await read($, keepWarm),
    lastAt,
    tokens: tok,
    pings: await read($, pings),
    failures: ctx.failures,
    isWorking: ctx.isWorking,
    isInFlight: ctx.isInFlight,
    now,
    ttlMs: ttl,
    settings,
  })
  if (wantsPing) await ping($, ctx)

  // The ping may have reset the clock: read it again before drawing or going cold.
  const at = (await read($, lastTurnAt)) ?? lastAt
  const left = remainingMs(at, ttl, now)
  if (isBandVisible(at, tok, settings.minTokens) && (left > 0 || !ctx.wasCold)) {
    await update($, tickAt, () => now)
  }

  if (left === 0 && !ctx.wasCold) {
    ctx.wasCold = true
    if (shouldOfferHandoff(at, tok, now, ttl, settings)) {
      const cmd = (await $.command.list()).filter(isHandoffCommand)
        .sort((a, b) => Number(isRefresh(b.name)) - Number(isRefresh(a.name)))[0]
      await update($, handoffCommand, () => cmd?.name ?? null)
      if (!cmd && !ctx.isOfferToasted) {
        ctx.isOfferToasted = true
        $.ui.toast('cache-clock: cache is cold and this chat is big, so start a fresh chat with a handoff summary to save tokens', {
          timeoutMs: 8000,
        })
      }
    }
  }
  await ctx.ledger?.flush(now)
}

export const register: Register = (on, options) => {
  const ctx: Ctx = {
    settings: readSettings(options),
    isWorking: false,
    isInFlight: false,
    failures: 0,
    wasCold: false,
    isOfferToasted: false,
    isColdToastDone: false,
    ledger: null,
  }
  const { settings } = ctx

  on('session.start', async ($, e, next) => {
    ctx.ledger = createLedger($)
    await ctx.ledger.load(await $.session.id().catch(() => null))
    if (settings.keepWarmDefault) await update($, keepWarm, () => true)
    $.clock.every(1000, () => {
      tick($, ctx).catch(() => {})
    })
    return next(e)
  })

  // On a resume the engine reports how long ago the last response was: start the clock from that,
  // so a resumed chat does not show nothing until your first message.
  on('classic.SessionStart', async ($, e, next) => {
    // A failure here must not break the session start: the clock just stays unseeded.
    await (async () => {
      const seed = seedFromResume(await $.clock.now(), e.seconds_since_last_response, e.context_tokens)
      if (seed !== null && (e.source === 'resume' || e.source === 'fork')) {
        const guess = ttlFromResume(e.seconds_since_last_response, e.prompt_cache_likely_expired)
        if (guess !== null) await update($, detectedTtl, d => mergeDetected(d, { ms: guess, source: 'resume' }))
        await update($, lastTurnAt, () => seed.lastAt)
        await update($, tokens, () => seed.tokens)
      }
    })().catch(() => {})
    return next(e)
  })

  // The only inputs that state the lifetime outright: `cache_ttl` ('5m' | '1h') on both
  // model-switch hooks. They fire on a model change, so the reading arrives late or never.
  on('classic.PreModelSwitch', async ($, e, next) => {
    // A failure here must not break the model switch: the lifetime just stays as it was.
    const ms = ttlFromLabel(e.cache_ttl)
    if (ms !== null) await update($, detectedTtl, d => mergeDetected(d, { ms, source: 'model-switch' })).catch(() => {})
    return next(e)
  })

  on('classic.PostModelSwitch', async ($, e, next) => {
    // A failure here must not break the model switch: the lifetime just stays as it was.
    const ms = ttlFromLabel(e.cache_ttl)
    if (ms !== null) await update($, detectedTtl, d => mergeDetected(d, { ms, source: 'model-switch' })).catch(() => {})
    return next(e)
  })

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) ctx.isWorking = true
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    ctx.isWorking = false
    // An error that carried no usage made no request: it did not touch the cache.
    if (e.reason !== 'error' || e.usage !== undefined) {
      const now = await $.clock.now()
      const { context } = await $.session.usage()
      await update($, lastTurnAt, () => now)
      await update($, tokens, () => context.tokens ?? 0)
      await resetStretch($, ctx, now)
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      ctx.isWorking = false
      await update($, lastTurnAt, () => null)
      await update($, tokens, () => 0)
      await update($, handoffCommand, () => null)
      await resetStretch($, ctx, 0)
    }
    await ctx.ledger?.flush(await $.clock.now(), true).catch(() => {})
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const lastAt = await read($, lastTurnAt)
    const tok = await read($, tokens)
    await read($, tickAt) // subscribes this drawing to the once-a-second tick
    if (e.props.hasSurvey || lastAt === null || !isBandVisible(lastAt, tok, settings.minTokens)) {
      return next(e)
    }

    const now = await $.clock.now()
    const ttl = resolveTtl(settings.ttlMs, await read($, detectedTtl)).ms
    const left = remainingMs(lastAt, ttl, now)
    const isWarm = left > 0
    const isOn = await read($, keepWarm)
    const done = await read($, pings)
    const cmd = await read($, handoffCommand)
    const { Box, Button, Text } = $.ui.resolve(e)
    const hasOffer = shouldOfferHandoff(lastAt, tok, now, ttl, settings)

    return (
      <Box flexDirection="column">
        <Box>
          <Text color={isWarm ? (left < 60_000 ? 'warning' : 'success') : 'error'}>
            {isWarm ? `cache warm ${formatClock(left)}` : 'cache cold'}
          </Text>
          <Text dimColor>{` (${Math.round(tok / 1000)}k tokens) `}</Text>
          <Button
            key="keep-warm"
            label={isOn ? `Keep warm: on (${done}/${settings.maxPings})` : 'Keep warm: off'}
            onPress={() => update($, keepWarm, v => !v)}
          />
        </Box>
        {hasOffer ? (
          <Text color="warning">
            {cmd
              ? `Cold and big: start a fresh chat with a handoff summary (/${cmd}).`
              : 'Cold and big: consider a fresh chat with a handoff summary (no handoff command found).'}
          </Text>
        ) : null}
      </Box>
    )
  })
}
