import type { EngineInterface, Register, ToolCallResult } from 'claude-code'

import { addEntry, flushLedger, loadLedger, newLedger } from './ledger'
import type { Ledger } from './ledger'
import {
  assembleBrief,
  buildCondensed,
  callKey,
  CONDENSE_SYSTEM,
  condensedAvoided,
  costUsd,
  condenseEstimate,
  condensePrompt,
  helperSpend,
  oneLine,
  RESEARCH_READ_SHARE,
  researchAvoided,
  focusOf,
  parsePlan,
  PLAN_SYSTEM,
  planPrompt,
  readSettings,
  shouldCondense,
  USAGE,
  briefPrompt,
  BRIEF_SYSTEM,
  checkUrl,
  fetchPrompt,
  finishBrief,
  PAGES_PER_WORKER,
  PERMISSION_HINT,
  pickUrls,
} from './logic'
import type { Settings, Source, WorkerOutcome } from './logic'

const PLUGIN = 'research-router'
const COMMAND = 'research-router'
const FAILED = 'research-router: the research job failed and added nothing; try again, or search directly.'

// Per-load bookkeeping shared by the hooks. The engine's validator follows `$` only into top-level
// function declarations, so the helpers below are those and take `ctx`.
type Ctx = {
  settings: Settings
  ledger: Ledger
  /** Calls condensed this session: an identical repeat passes through whole (the escape hatch). */
  condensedKeys: Set<string>
}

type WebTool = 'WebFetch' | 'WebSearch'

/**
 * Runs after the tool answered. Returns `r` itself (core's own messages, untouched) on every path
 * but a successful, clearly shorter condensation.
 */
async function afterWeb(
  $: EngineInterface,
  ctx: Ctx,
  tool: WebTool,
  e: Readonly<Record<string, unknown>> & { agentId?: string },
  r: ToolCallResult<WebTool>,
  callerPlugin: string,
): Promise<ToolCallResult<WebTool>> {
  // Only the main model's own calls (raised by the engine) are condensed. A subagent's results never
  // reach the main chat, another plugin's call is that plugin's business, and this mod's own research
  // workers want the pages as they are: all pass through.
  if (e.agentId !== undefined || callerPlugin !== 'engine') return r
  if (r.deny !== undefined || r.isError === true) return r
  const original = r.text
  if (typeof original !== 'string' || !shouldCondense(original.length, ctx.settings.minChars)) return r
  const record: unknown = r.result
  if (typeof record !== 'object' || record === null) return r

  const key = callKey(tool, e)
  if (ctx.condensedKeys.has(key)) {
    ctx.condensedKeys.delete(key)
    return r
  }

  // A record of an unexpected shape is left alone before any helper tokens are spent on it.
  if (rewrite(tool, record, '') === null) return r
  // What is delivered beside the condensed text: a search keeps each hit's title and URL.
  const extra = tool === 'WebSearch' ? JSON.stringify(searchHits(record)).length : 0
  const prompt = condensePrompt(focusOf(tool, e), original, original.length)
  const sent = CONDENSE_SYSTEM.length + prompt.length
  // Skipped when it would keep nothing out, or when its estimated dollar net is negative (the helper
  // would cost more at its price than the main model saves at its own).
  const main = await mainModel($)
  if (!condenseEstimate(original.length, sent, extra, main, ctx.settings.helperModel).isWorthIt) return r

  let reply
  try {
    reply = await $.model.complete({
      model: ctx.settings.helperModel,
      system: CONDENSE_SYSTEM,
      prompt,
      maxTokens: 2048,
      timeoutMs: ctx.settings.timeoutMs,
    })
  } catch {
    await logLoss($, ctx, tool, helperSpend(undefined, sent), 'the helper call failed', main)
    return r
  }
  const spent = helperSpend(reply, sent)
  if (!reply.isAnswered) {
    await logLoss($, ctx, tool, spent, `the helper gave no text: ${reply.reason}`, main)
    return r
  }
  const short = buildCondensed({ tool, original, helperText: reply.text, model: ctx.settings.helperModel, extraChars: extra })
  if (short === null) {
    await logLoss($, ctx, tool, spent, 'the helper text was not clearly shorter', main)
    return r
  }

  const result = rewrite(tool, record, short)
  if (result === null) {
    await logLoss($, ctx, tool, spent, 'unexpected result shape', main)
    return r
  }

  ctx.condensedKeys.add(key)
  const delivered = short.length + extra
  const avoided = condensedAvoided(original.length, delivered)
  await addEntry($, ctx.ledger, {
    kind: 'tokens-avoided',
    tokensAvoided: avoided,
    ...savings(ctx, avoided, spent, main),
    note: `${tool} result condensed from ${original.length} to ${delivered} chars delivered; ${priceNote(ctx, main)}`,
  })
  const out = { result } as ToolCallResult<WebTool>
  return r.context !== undefined ? ({ ...out, context: r.context } as ToolCallResult<WebTool>) : out
}

/** The session's main model, or null when the engine cannot say (the dollar estimate is then omitted). */
async function mainModel($: EngineInterface): Promise<string | null> {
  try {
    const m = await $.session.model()
    return typeof m === 'string' && m !== '' ? m : null
  } catch {
    return null
  }
}

/** `helperTokens` and, when both prices are known, `costUsdEstimate` for a ledger line. */
function savings(ctx: Ctx, avoided: number, spent: number, main: string | null): { helperTokens: number; costUsdEstimate?: number } {
  const usd = costUsd(avoided, spent, main, ctx.settings.helperModel)
  return usd === null ? { helperTokens: spent } : { helperTokens: spent, costUsdEstimate: usd }
}

/** The models and the assumption behind the dollar figure, for the ledger note (no content, no URLs). */
function priceNote(ctx: Ctx, main: string | null): string {
  return (
    `USD = avoided tokens at ${oneLine(main ?? 'unknown', 60)} list input price minus helper tokens at ${oneLine(ctx.settings.helperModel, 60)} ` +
    'list input price (prices of 2026-11-03, no caching; omitted when a price is unknown).'
  )
}

/**
 * A helper call whose text was not used still cost its tokens: a `cost-upgrade` line with no
 * `tokensAvoided` (docs/ledger.md). Nothing is logged when nothing was spent.
 */
async function logLoss($: EngineInterface, ctx: Ctx, tool: WebTool, spent: number, why: string, main: string | null) {
  if (spent <= 0) return
  await addEntry($, ctx.ledger, {
    kind: 'cost-upgrade',
    ...savings(ctx, 0, spent, main),
    note: `${tool} result kept whole (${why}), so the helper call kept nothing out; ${priceNote(ctx, main)}`,
  })
}

/** The tool's record with the condensed text in place of the bulky part; null when the shape is unexpected. */
function rewrite(tool: WebTool, record: object, short: string): object | null {
  if (tool === 'WebFetch') {
    const rec = record as { result?: unknown }
    if (typeof rec.result !== 'string') return null
    return { ...record, result: short }
  }
  const rec = record as { results?: unknown }
  if (!Array.isArray(rec.results)) return null
  return { ...record, results: [short, ...searchHits(record)] }
}

/** A search record's hit blocks with only each hit's title and URL (the page text dropped). */
function searchHits(record: object): { tool_use_id: string; content: { title: string; url: string }[] }[] {
  const rec = record as { results?: unknown }
  if (!Array.isArray(rec.results)) return []
  return rec.results.flatMap(item => {
    if (typeof item !== 'object' || item === null) return []
    const block = item as { tool_use_id?: unknown; content?: unknown }
    if (typeof block.tool_use_id !== 'string' || !Array.isArray(block.content)) return []
    const content = block.content.flatMap(h => {
      const hit = h as { title?: unknown; url?: unknown }
      return typeof hit?.title === 'string' && typeof hit.url === 'string' ? [{ title: hit.title, url: hit.url }] : []
    })
    return [{ tool_use_id: block.tool_use_id, content }]
  })
}

const why = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 200)

// ---- /research-router ----
//
// Every web call the command makes is put to the session's own permission decision first
// (`$.tool.check`), because `$.tool.call` alone opens no dialog. `allow` runs, `deny` is skipped, and
// the calls that would `ask` are put to the person in ONE dialog per phase (searches, then pages).
// Page links come from search results, so before any check they must also pass `checkUrl` (http(s),
// public host, not on blockedHosts).

const YES = 'Yes'
const NO = 'No'

type Verdict = { decision: 'allow' | 'ask' | 'deny'; reason?: string }

/** The session's verdict for one call, without running it. A check that fails counts as a deny. */
async function checkCall($: EngineInterface, tool: WebTool, input: Record<string, unknown>): Promise<Verdict> {
  try {
    const r = await $.tool.check({ tool, input })
    if (r.decision === 'allow' || r.decision === 'ask' || r.decision === 'deny') {
      return r.reason !== undefined ? { decision: r.decision, reason: r.reason } : { decision: r.decision }
    }
  } catch {}
  return { decision: 'deny', reason: 'the permission check could not run' }
}

/** One question to the person. Only an exact "Yes" approves; a dismissal, free text or no one to ask is a no. */
async function askPerson($: EngineInterface, question: string): Promise<boolean> {
  try {
    return (await $.ui.ask(question, { options: [YES, NO], header: 'Research' })) === YES
  } catch {
    return false
  }
}

// Every item is named: the person approves exactly what the question lists.
const listOf = (items: readonly string[], max = 50) =>
  items.length > max ? `${items.slice(0, max).join(', ')} and ${items.length - max} more` : items.join(', ')

type Searched = { part: string; text: string; record: unknown } | { part: string; why: string; stopped?: true }

async function runSearch($: EngineInterface, part: string, input: { query: string }): Promise<Searched> {
  let search: ToolCallResult<'WebSearch'>
  try {
    // No `mode`: the 2.1.321 declarations require it but the 2.1.326 CLI's WebSearch schema has no
    // such field, so the input is passed untyped with only the fields both agree on.
    search = (await $.tool.call({ tool: 'WebSearch', ...input } as never)) as ToolCallResult<'WebSearch'>
  } catch (err) {
    return { part, why: `the search could not run (${why(err)})` }
  }
  if (search.deny !== undefined) return { part, why: `the search was refused (${search.deny.slice(0, 200)})`, stopped: true }
  if (search.isError === true) return { part, why: 'the search failed' }
  return { part, text: typeof search.text === 'string' ? search.text : '', record: search.result }
}

/** Phase 1: every part's search, checked, with one dialog for those the session would ask about. */
async function searchAll($: EngineInterface, parts: readonly string[]): Promise<{ results: Searched[]; stopped: boolean }> {
  const inputs = parts.map(p => ({ query: p.slice(0, 500) }))
  const verdicts = await Promise.all(inputs.map(i => checkCall($, 'WebSearch', i)))
  const asked = inputs.filter((_, i) => verdicts[i]!.decision === 'ask')
  const approved =
    asked.length > 0 &&
    (await askPerson(
      $,
      `/research-router wants to run ${asked.length} web search${asked.length === 1 ? '' : 'es'}: ${listOf(asked.map(i => JSON.stringify(i.query.slice(0, 120))))}. Allow?`,
    ))
  let stopped = false
  const results = await Promise.all(
    parts.map(async (part, i): Promise<Searched> => {
      const v = verdicts[i]!
      if (v.decision === 'deny') {
        stopped = true
        return { part, why: `the search was refused by your permission settings${v.reason ? ` (${v.reason.slice(0, 200)})` : ''}`, stopped: true }
      }
      if (v.decision === 'ask' && !approved) {
        stopped = true
        return { part, why: 'the search was not approved', stopped: true }
      }
      const r = await runSearch($, part, inputs[i]!)
      if ('stopped' in r) stopped = true
      return r
    }),
  )
  return { results, stopped }
}

type Planned = { part: string; urls: string[]; notRead: string[] }

/** The links one search gives that may be read: in rank order, passing `checkUrl`, at most PAGES_PER_WORKER. */
function plannedPages(ctx: Ctx, part: string, record: unknown): Planned {
  const urls: string[] = []
  const notRead: string[] = []
  for (const raw of pickUrls(record, 50)) {
    if (urls.length >= PAGES_PER_WORKER) break
    const v = checkUrl(raw, ctx.settings.blockedHosts)
    if (!v.ok) notRead.push(`${v.host}: ${v.why}`)
    else if (!urls.includes(v.url)) urls.push(v.url)
  }
  return { part, urls, notRead }
}

/** Phase 2: every planned page, checked, with one dialog naming the hosts the session would ask about. */
async function fetchAll($: EngineInterface, planned: readonly Planned[]): Promise<{ pages: Source[][]; stopped: boolean }> {
  const calls = planned.flatMap((p, pi) => p.urls.map(url => ({ pi, url, input: { url, prompt: fetchPrompt(p.part) } })))
  const verdicts = await Promise.all(calls.map(c => checkCall($, 'WebFetch', c.input)))
  const askedHosts = [...new Set(calls.filter((_, i) => verdicts[i]!.decision === 'ask').map(c => new URL(c.url).hostname))]
  const asked = calls.filter((_, i) => verdicts[i]!.decision === 'ask').length
  const approved =
    asked > 0 &&
    (await askPerson(
      $,
      `/research-router wants to read ${asked} page${asked === 1 ? '' : 's'} from its search results, on ${listOf(askedHosts)}. These links come from the web, not from you. Allow?`,
    ))
  let stopped = false
  const read = await Promise.all(
    calls.map(async (c, i): Promise<Source | null> => {
      const v = verdicts[i]!
      const host = new URL(c.url).hostname
      if (v.decision === 'deny' || (v.decision === 'ask' && !approved)) {
        stopped = true
        planned[c.pi]!.notRead.push(`${host}: ${v.decision === 'deny' ? 'refused by your permission settings' : 'not approved'}`)
        return null
      }
      try {
        const r = await $.tool.call({ tool: 'WebFetch', ...c.input })
        if (r.deny !== undefined) {
          stopped = true
          planned[c.pi]!.notRead.push(`${host}: refused (${r.deny.slice(0, 120)})`)
          return null
        }
        if (r.isError === true || typeof r.text !== 'string' || r.text.trim() === '') {
          planned[c.pi]!.notRead.push(`${host}: the page could not be read`)
          return null
        }
        return { url: c.url, text: r.text }
      } catch {
        planned[c.pi]!.notRead.push(`${host}: the page could not be read`)
        return null
      }
    }),
  )
  const pages = planned.map((_, pi) => read.filter((s, i): s is Source => s !== null && calls[i]!.pi === pi))
  return { pages, stopped }
}

/** Phase 3: one brief per part from its search text and the pages read. */
async function writeBrief(
  $: EngineInterface,
  ctx: Ctx,
  question: string,
  part: string,
  searchText: string,
  read: readonly Source[],
): Promise<WorkerOutcome & { spent: number }> {
  const sources: Source[] = searchText.trim() !== '' ? [{ url: `search: ${part.slice(0, 200)}`, text: searchText }, ...read] : [...read]
  if (sources.length === 0) return { part, brief: null, why: 'the search found nothing to read', spent: 0 }
  const prompt = briefPrompt(part, question, sources)
  const sent = BRIEF_SYSTEM.length + prompt.length
  let reply
  try {
    reply = await $.model.complete({
      model: ctx.settings.helperModel,
      system: BRIEF_SYSTEM,
      prompt,
      maxTokens: 1024,
      timeoutMs: ctx.settings.timeoutMs,
    })
  } catch (err) {
    return { part, brief: null, why: `the helper model could not run (${why(err)})`, spent: helperSpend(undefined, sent) }
  }
  const spent = helperSpend(reply, sent)
  if (!reply.isAnswered) return { part, brief: null, why: `the helper model gave no brief (${reply.reason})`, spent }
  const brief = finishBrief(reply.text, read.map(p => p.url))
  return brief === null ? { part, brief: null, why: 'the helper model gave an empty brief', spent } : { part, brief, spent }
}

/** The parts to research, and the tokens the planner spent (0 when it did not run). */
async function planParts($: EngineInterface, ctx: Ctx, question: string): Promise<{ parts: string[]; spent: number }> {
  if (ctx.settings.maxWorkers <= 1) return { parts: [question], spent: 0 }
  const prompt = planPrompt(question, ctx.settings.maxWorkers)
  const sent = PLAN_SYSTEM.length + prompt.length
  try {
    const r = await $.model.complete({
      model: ctx.settings.helperModel,
      system: PLAN_SYSTEM,
      prompt,
      maxTokens: 512,
      timeoutMs: ctx.settings.timeoutMs,
    })
    return { parts: parsePlan(r.isAnswered ? r.text : null, question, ctx.settings.maxWorkers), spent: helperSpend(r, sent) }
  } catch {
    return { parts: [question], spent: helperSpend(undefined, sent) }
  }
}

async function research($: EngineInterface, ctx: Ctx, question: string): Promise<string> {
  const plan = await planParts($, ctx, question)
  const searched = await searchAll($, plan.parts)
  const planned = searched.results.map(s => ('why' in s ? { part: s.part, urls: [], notRead: [] } : plannedPages(ctx, s.part, s.record)))
  const fetched = await fetchAll($, planned)
  const outcomes = await Promise.all(
    searched.results.map(async (s, i): Promise<WorkerOutcome & { readChars: number; spent: number }> => {
      if ('why' in s) return { part: s.part, brief: null, why: s.why, readChars: 0, spent: 0 }
      const read = fetched.pages[i] ?? []
      const readChars = s.text.length + read.reduce((n, p) => n + p.text.length, 0)
      const o = await writeBrief($, ctx, question, s.part, s.text, read)
      const notRead = planned[i]!.notRead
      return { ...o, ...(notRead.length > 0 ? { notRead } : {}), readChars }
    }),
  )
  const brief = assembleBrief(question, outcomes, searched.stopped || fetched.stopped ? PERMISSION_HINT : undefined)
  // Only workers that delivered a brief kept their reading out of the main chat.
  const read = outcomes.reduce((s, o) => s + (o.brief !== null ? o.readChars : 0), 0)
  const spent = plan.spent + outcomes.reduce((s, o) => s + o.spent, 0)
  // A run where no worker answered kept nothing out of the main chat: only its cost (and the
  // failure text it delivered) count.
  const isAnswered = outcomes.some(o => o.brief !== null)
  const avoided = researchAvoided(isAnswered ? read : 0, brief.length)
  const main = await mainModel($)
  const note =
    `/research-router: ${outcomes.length} worker(s), ${read} chars read by workers that answered (${RESEARCH_READ_SHARE * 100}% counted), ` +
    `${brief.length}-char brief; ${priceNote(ctx, main)}`
  if (avoided > 0) await addEntry($, ctx.ledger, { kind: 'tokens-avoided', tokensAvoided: avoided, ...savings(ctx, avoided, spent, main), note })
  else if (spent > 0) await addEntry($, ctx.ledger, { kind: 'cost-upgrade', ...savings(ctx, 0, spent, main), note })
  else await addEntry($, ctx.ledger, { kind: 'info', note })
  return brief
}

async function start($: EngineInterface, ctx: Ctx) {
  await loadLedger($, ctx.ledger)
  try {
    await $.command.register({
      name: COMMAND,
      description: 'Research a question on the web with a cheap model; only the brief, with sources, enters this chat.',
      argumentHint: '<question>',
    })
  } catch {}
}

export const register: Register = (on, options) => {
  const ctx: Ctx = {
    settings: readSettings(options),
    ledger: newLedger(),
    condensedKeys: new Set(),
  }

  on('session.start', async ($, e, next) => {
    await start($, ctx)
    return next(e)
  })

  // Each hook calls the tool first; any failure in the condensing step falls back to that result.
  on('tool.call', { tool: 'WebFetch' }, async ($, e, next) => {
    const r = await next(e)
    try {
      return await afterWeb($, ctx, 'WebFetch', e, r, next.origin.plugin)
    } catch {
      return r
    }
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'WebSearch' }, async ($, e, next) => {
    const r = await next(e)
    try {
      return await afterWeb($, ctx, 'WebSearch', e, r, next.origin.plugin)
    } catch {
      return r
    }
  }).catch(($, e, next) => next(e))

  on('command.run', { command: COMMAND }, async ($, e) => {
    const question = e.args.trim()
    if (question === '') return { text: USAGE }
    try {
      return { text: await research($, ctx, question) }
    } catch {
      return { text: FAILED }
    }
  }).catch(() => ({ text: FAILED }))

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') ctx.condensedKeys.clear()
    // Always asked: the flush re-resolves the session id first, so a /clear switches files.
    try {
      await flushLedger($, ctx.ledger)
    } catch {}
    return next(e)
  })
}
