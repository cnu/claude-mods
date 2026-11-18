import type { AgentSpawnInput, EngineInterface, Register } from 'claude-code'

import { ledgerWrite, newLedger } from './ledger'
import type { Ledger } from './ledger'
import {
  CLASSIFIER_MAX_TOKENS,
  CLASSIFIER_MODEL,
  CLASSIFIER_SYSTEM,
  agentTypeSkip,
  baselineOf,
  classifierSpend,
  decide,
  estimateSavingUsd,
  roundUsd,
  modelRank,
  parseClassification,
  readSettings,
  summarize,
  wrapTask,
} from './logic'
import type { Classification, ClassifierSpend, Decision, Settings } from './logic'

// Per-load bookkeeping. The validator follows `$` only into top-level function
// declarations, so the helpers below are those and take `ctx`.
type Ctx = {
  settings: Settings
  ledger: Ledger
}

/** Why a spawn is passed through without asking the classifier, or null to classify it. */
export function skipReason(e: AgentSpawnInput, s: Settings): string | null {
  if (e.model !== undefined && e.model.trim() !== '') return 'explicit-model'
  if (e.fork) return 'fork'
  // A workflow agent's prompt may be a fixed placeholder and its content is the script's: not ours to judge.
  if (e.workflow !== undefined) return 'workflow'
  if (e.resume !== undefined) return 'resume'
  if (e.prompt.trim() === '') return 'empty-prompt'
  // An agent definition may pin its own model, which this hook cannot see: only listed types are routed.
  return agentTypeSkip(e.subagentType, s)
}

/**
 * Asks the classifier. Any failure (refused request, API error, timeout, empty or
 * malformed reply) resolves null, which leaves the spawn unchanged. `spend` is what the
 * call cost (reported usage, else ceil(chars/4)); null when the request was refused outright.
 */
async function classify(
  $: EngineInterface,
  ctx: Ctx,
  task: string,
): Promise<{ c: Classification | null; failure: string; spend: ClassifierSpend | null }> {
  const prompt = wrapTask(task)
  const promptChars = CLASSIFIER_SYSTEM.length + prompt.length
  try {
    const r = await $.model.complete({
      model: CLASSIFIER_MODEL,
      system: CLASSIFIER_SYSTEM,
      prompt,
      maxTokens: CLASSIFIER_MAX_TOKENS,
      effort: 'low',
      timeoutMs: ctx.settings.classifyTimeoutMs,
    })
    const spend = classifierSpend(promptChars, r.isAnswered ? r.text.length : 0, r.usage)
    if (!r.isAnswered) return { c: null, failure: r.reason === 'aborted' ? 'timeout' : r.reason, spend }
    const c = parseClassification(r.text)
    return c === null ? { c: null, failure: 'bad-json', spend } : { c, failure: '', spend }
  } catch {
    return { c: null, failure: 'classifier-refused', spend: null }
  }
}

/** Logs one decision after the spawn settled. Never throws. */
async function record(
  $: EngineInterface,
  ctx: Ctx,
  e: AgentSpawnInput,
  c: Classification | null,
  d: Decision | null,
  status: string,
  actual: string | undefined,
  spend: ClassifierSpend | null,
) {
  try {
    const wouldHave = e.model ?? `${e.parentModel} (inherited; agent definition may differ)`
    const chosen = actual ?? d?.model ?? 'unchanged'
    const conf = c?.confidence === undefined ? 'n/a' : c.confidence.toFixed(2)
    const baseline = baselineOf(e.subagentType)
    const run = { inputTokens: ctx.settings.assumedInputTokens, outputTokens: ctx.settings.assumedOutputTokens }
    const clsUsd = spend?.usd ?? 0
    const clsTokens = spend === null ? 0 : spend.inputTokens + spend.outputTokens
    // helperTokens is written only when a classifier call actually ran (spend !== null); never negative.
    const helper = spend === null ? {} : { helperTokens: Math.max(0, clsTokens) }
    const clsNote =
      spend === null ? '' : `classifier-tokens: ${clsTokens} (${spend.source}, ~$${spend.usd.toFixed(6)} at ${CLASSIFIER_MODEL} price)`
    // Against the parent only when it is the agent's real baseline; otherwise no saving or cost is claimed.
    const saving = d?.model && baseline === 'parent' ? estimateSavingUsd(e.parentModel, actual ?? d.model, run) : null
    const costText =
      baseline === 'unknown'
        ? 'n/a (baseline unknown)'
        : saving === null
          ? 'n/a'
          : `${saving >= 0 ? 'saves' : 'adds'} ~$${Math.abs(saving).toFixed(4)} per typical run (rough)`
    $.ui.log(
      [
        `model-router: ${status}`,
        `task="${summarize(e.prompt)}"`,
        `type=${e.subagentType}`,
        `would-use=${wouldHave}`,
        `chosen=${chosen}`,
        `tier=${c?.tier ?? 'n/a'}`,
        `confidence=${conf}`,
        `cost=${costText}`,
        spend === null ? '' : `classifier-tokens=${clsTokens}`,
        c?.reason ? `classifier-reason="${c.reason}"` : '',
      ]
        .filter(Boolean)
        .join(' | '),
      // The debug log, not the transcript: a line per spawn would clutter the chat.
      { to: 'debug' },
    )

    if (ctx.settings.showDecisions) {
      const line =
        d?.model !== undefined
          ? `model-router: ${e.subagentType} -> ${chosen} (${c?.tier ?? '?'}, ${conf})`
          : `model-router: ${e.subagentType} unchanged (${status})`
      $.ui.toast(line)
    }

    // Ledger. Net, not gross: the classifier's own cost is subtracted from every estimate. A saving is
    // claimed only when the baseline is the parent's model and a cheaper model actually ran; a move to a
    // stronger model is logged as a negative cost. Without a decision line carrying it, the classifier's
    // cost is logged on its own, so every classified spawn is accounted for.
    const from = modelRank(e.parentModel)
    const to = modelRank(actual)
    const now = await $.clock.now()
    const ts = new Date(now).toISOString()
    const assumes = `assumes a ${run.inputTokens}/${run.outputTokens} token run`
    let isCovered = false
    if (baseline === 'parent' && d?.direction === 'downgrade' && from !== null && to !== null && to < from) {
      const est = estimateSavingUsd(e.parentModel, actual, run)
      if (est !== null) {
        const net = roundUsd(est - clsUsd)
        isCovered = true
        await ledgerWrite(
          $,
          ctx.ledger,
          {
            ts,
            kind: 'cost-downgrade',
            ...helper,
            costUsdEstimate: net,
            note: `subagent ${e.subagentType}: ${e.parentModel} -> ${actual} (tier ${c?.tier ?? '?'}, confidence ${conf}); gross saving ~$${est.toFixed(6)}, net of classifier ~$${net.toFixed(6)}${net < 0 ? ' (net negative)' : ''}; ${clsNote}; ${assumes}`,
          },
          now,
        )
      }
    } else if (baseline === 'parent' && d?.direction === 'upgrade' && from !== null && to !== null && to > from) {
      const est = estimateSavingUsd(e.parentModel, actual, run)
      if (est !== null) {
        const net = roundUsd(est - clsUsd)
        isCovered = true
        await ledgerWrite(
          $,
          ctx.ledger,
          {
            ts,
            kind: 'cost-upgrade',
            ...helper,
            costUsdEstimate: net,
            note: `subagent ${e.subagentType}: ${e.parentModel} -> ${actual} (tier ${c?.tier ?? '?'}, confidence ${conf}); extra cost ~$${Math.abs(est).toFixed(6)} plus classifier, net ~$${net.toFixed(6)}; ${clsNote}; ${assumes}`,
          },
          now,
        )
      }
    }
    if (!isCovered && spend !== null && clsTokens > 0) {
      const moved =
        d?.direction === 'upgrade' && baseline === 'unknown' && from !== null && to !== null && to > from
          ? `; moved up to ${actual} (its default model is unknown, so that extra cost is not estimated)`
          : ''
      await ledgerWrite(
        $,
        ctx.ledger,
        {
          ts,
          kind: 'cost-upgrade',
          ...helper,
          costUsdEstimate: -clsUsd,
          note: `classifier overhead on ${e.subagentType} (${status}${moved}); ${clsNote}`,
        },
        now,
      )
    }
    if (baseline === 'unknown' && d?.why === 'unknown-baseline') {
      await ledgerWrite(
        $,
        ctx.ledger,
        {
          ts,
          kind: 'info',
          note: `subagent ${e.subagentType}: kept (its default model is unknown, so no saving is claimed; tier ${c?.tier ?? '?'})`,
        },
        now,
      )
    } else if (ctx.settings.showDecisions && d !== null && d.model === undefined) {
      await ledgerWrite(
        $,
        ctx.ledger,
        { ts, kind: 'info', note: `subagent ${e.subagentType}: kept (${d.why}; tier ${c?.tier ?? '?'}, confidence ${conf})` },
        now,
      )
    }
  } catch {
    // Logging must never affect the spawn.
  }
}

async function route($: EngineInterface, ctx: Ctx, e: AgentSpawnInput, next: (e: AgentSpawnInput) => Promise<unknown>) {
  let c: Classification | null = null
  let d: Decision | null = null
  let status: string
  let input = e
  let spend: ClassifierSpend | null = null

  // Everything before `next` is guarded: any surprise passes the spawn through unchanged.
  try {
    const skip = skipReason(e, ctx.settings)
    if (skip !== null) {
      status = `passthrough (${skip})`
    } else {
      const got = await classify($, ctx, e.prompt)
      c = got.c
      spend = got.spend
      if (c === null) {
        status = `passthrough (${got.failure})`
      } else {
        d = decide(e.parentModel, c, ctx.settings, baselineOf(e.subagentType))
        status = d.model === undefined ? `kept (${d.why})` : d.direction
        if (d.model !== undefined) input = { ...e, model: d.model }
      }
    }
  } catch {
    c = null
    d = null
    input = e
    status = 'passthrough (router-error)'
  }

  const result = await next(input)

  const actual =
    typeof result === 'object' && result !== null && 'model' in result && typeof result.model === 'string'
      ? result.model
      : undefined
  const isDenied = typeof result === 'object' && result !== null && 'deny' in result
  await record($, ctx, e, c, d, isDenied ? `${status}; spawn denied` : status, actual, spend)
  return result
}

export const register: Register = (on, options) => {
  const ctx: Ctx = {
    settings: readSettings(options as Record<string, unknown> | undefined),
    ledger: newLedger(),
  }

  on('agent.spawn', async ($, e, next) => {
    const r = await route($, ctx, e, next as (e: AgentSpawnInput) => Promise<unknown>)
    return r as Awaited<ReturnType<typeof next>>
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    try {
      await ledgerWrite($, ctx.ledger, null, await $.clock.now(), true)
    } catch {
      // ignore
    }
    return next(e)
  })
}
