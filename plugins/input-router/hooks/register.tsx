import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ToolCallInput, ToolCallResult } from 'claude-code'

import { createLedger } from './ledger'
import {
  bashOutputOf,
  bashTarget,
  cleanNotes,
  commandTouchesInstructions,
  composeNote,
  decide,
  expiredResults,
  formatHandoff,
  costUsdEstimate,
  dollarScreenBefore,
  estimateHeadroomTokens,
  HELPER_INPUT_MAX,
  promptOverheadChars,
  HELPER_SYSTEM,
  helperPrompt,
  isAlwaysWhole,
  isExcluded,
  isMcpTool,
  MAX_NOTE_RATIO,
  mcpKey,
  mcpText,
  normalizePath,
  numberLines,
  readKey,
  readSettings,
  readTextOf,
  roundUsd,
  tokenCounts,
  savedResultName,
  toolLabel,
  wastedCostUsd,
  writtenPath,
} from './logic'
import type { Handoff, HelperUsage, ListedEntry, Settings } from './logic'
import {
  CMD_DESCRIPTION,
  CMD_FULL_ARMED,
  CMD_FULL_REFUSED,
  CMD_HINT,
  CMD_PANE_MISSING,
  CMD_PANE_OPEN,
  CMD_USAGE,
  ledgerNote,
  PANE_ARMED,
  PANE_EMPTY,
  PANE_TITLE,
  paneHead,
  wastedNote,
} from './strings'

const PANE = 'input-router'
const MAX_ROWS_KEPT = 200
/** How many recent hand-offs a repeat is matched against (covers a parallel batch of reads). */
const RECENT_KEYS = 16
/** The most expired copies one session start empties, so a huge backlog cannot stall it. */
const SWEEP_MAX = 500
/** The sweep stops after this long and leaves the rest for the next session (hook budget is 10 s). */
const SWEEP_BUDGET_MS = 4_000
/** Below HOME: the only folder the mod saves full copies to, and the only one it ever sweeps. */
const RESULTS_PARTS = ['.claude', 'claude-mods', 'input-router', 'results'] as const

// Change the shape tag when a hand-off's fields change: it declines what an earlier version stored.
const handoffs = atom({ plugin: 'input-router', key: 'handoffs' } as const, [] as Handoff[], { shape: 'handoffs-2' })
const isFullArmed = atom({ plugin: 'input-router', key: 'isFullArmed' } as const, false)

// Plain per-load bookkeeping. The validator follows `$` only into top-level function
// declarations, so the helpers below are those and take `ctx`.
type Ctx = {
  settings: Settings
  /** Files written or edited in the current main-thread turn. */
  written: Set<string>
  /** Requests that recently produced notes (any thread); the same request again passes whole, once. */
  recentKeys: string[]
  /** `/input-router full` armed for the next result that would be routed. */
  isFullArmed: boolean
  /** The current request text, per thread (`main` or an agent id), for the helper. */
  tasks: Map<string, string>
  ledger: ReturnType<typeof createLedger> | null
  isPaneOpened: boolean
}

type Source = {
  kind: 'file' | 'mcp' | 'bash'
  tool: string
  label: string
  /** What the pane and ledger show as the target; never a Bash command. */
  target: string
  /** Bash only: the command, for the helper. */
  command?: string
  text: string
  firstLine: number
  totalLines: number
  /** Request identity for the repeat rule; null for Bash (running a command again is not a re-read). */
  key: string | null
  isExcluded: boolean
  isAlwaysWhole: boolean
  isJustWritten: boolean
}

/** What a routed result looks like to the main model, or null to keep the original. */
type Rewrite = (note: string) => ToolCallResult

/**
 * Decides and, when routed, asks the helper. Any failure on the way returns `ran` itself,
 * the object core produced, so core uses its own messages verbatim.
 */
async function route($: EngineInterface, ctx: Ctx, e: ToolCallInput, ran: ToolCallResult): Promise<ToolCallResult> {
  if (ran.deny !== undefined || ran.isError === true) return ran
  const { settings } = ctx
  const input = e as unknown as Record<string, unknown>
  const tool = String(e.tool)

  let source: Source
  let rewrite: Rewrite
  if (tool === 'Read') {
    const file = readTextOf(ran.result)
    if (file === null) return ran
    const path = typeof input.file_path === 'string' ? input.file_path : file.filePath
    const norm = normalizePath(path)
    source = {
      kind: 'file',
      tool,
      label: file.filePath,
      target: file.filePath,
      text: file.content,
      firstLine: file.startLine,
      totalLines: file.totalLines,
      key: readKey(path, input.offset, input.limit),
      isExcluded: isExcluded(norm, settings.excludeGlobs),
      isAlwaysWhole: isAlwaysWhole(norm, settings.alwaysWholeGlobs) || isAlwaysWhole(normalizePath(file.filePath), settings.alwaysWholeGlobs),
      isJustWritten: ctx.written.has(norm) || ctx.written.has(normalizePath(file.filePath)),
    }
    const original = ran.result as Record<string, unknown>
    rewrite = note => {
      const result = {
        ...original,
        file: { ...(original.file as object), content: note, numLines: note.split('\n').length, startLine: 1 },
      }
      return withContext(result, ran)
    }
  } else if (isMcpTool(tool)) {
    const got = mcpText(ran.result)
    if (got === null) return ran
    source = {
      kind: 'mcp',
      tool,
      label: tool,
      target: tool,
      text: got.text,
      firstLine: 1,
      totalLines: got.text.split('\n').length,
      key: mcpKey(input),
      isExcluded: isExcluded(tool, settings.excludeGlobs),
      isAlwaysWhole: false,
      isJustWritten: false,
    }
    rewrite = note => withContext(got.shape === 'string' ? note : [{ type: 'text', text: note }], ran)
  } else if (tool === 'Bash' && settings.routeBash) {
    // A failed command arrives as isError and was returned above; bashOutputOf refuses anything
    // that is not a plain finished result. Only stdout is replaced: stderr stays exactly as it was.
    const out = bashOutputOf(ran.result, ran.text)
    if (out === null) return ran
    const command = typeof input.command === 'string' ? input.command : ''
    source = {
      kind: 'bash',
      tool,
      label: 'stdout',
      target: bashTarget(command),
      command,
      text: out.stdout,
      firstLine: 1,
      totalLines: out.stdout.split('\n').length,
      key: null,
      isExcluded: isExcluded(tool, settings.excludeGlobs),
      isAlwaysWhole: commandTouchesInstructions(command, settings.alwaysWholeGlobs),
      isJustWritten: false,
    }
    const original = ran.result as Record<string, unknown>
    rewrite = note => withContext({ ...original, stdout: note }, ran)
  } else {
    return ran
  }

  // The helper's fixed per-call cost, for the screens below and for the token counts afterwards.
  const task = ctx.tasks.get(typeof input.agentId === 'string' ? input.agentId : 'main') ?? ctx.tasks.get('main') ?? ''
  const promptArgs = {
    kind: source.kind,
    label: source.label,
    command: source.command,
    task,
    totalLines: source.text.split('\n').length,
    firstLine: source.firstLine,
    maxNoteChars: settings.maxNoteChars,
  }
  const overheadChars = promptOverheadChars(promptArgs)

  // The session's model prices the main-context tokens of the MAIN loop only. A subagent's tool call
  // is routed too, but the API does not expose the subagent's model (AgentInfo has no model field),
  // so its main-context price is unknown: no dollar screen and no avoided-token dollar figure.
  const isSubagent = typeof input.agentId === 'string' && input.agentId !== ''
  let mainModel = ''
  if (!isSubagent) {
    try {
      mainModel = await $.session.model()
    } catch {
      mainModel = '' // unknown (or an error) means no dollar figure
    }
  }

  // Decided and spent with no await in between, so parallel calls cannot both use "full".
  const decision = decide({
    size: source.text.length,
    minChars: settings.minChars,
    isFullOnce: ctx.isFullArmed,
    isJustWritten: source.isJustWritten,
    isRepeatOfNotes: source.key !== null && ctx.recentKeys.includes(source.key),
    isExcluded: source.isExcluded,
    isAlwaysWhole: source.isAlwaysWhole,
    estHeadroomTokens: estimateHeadroomTokens(source.text.length, overheadChars),
    estSavingUsd: dollarScreenBefore({
      sourceChars: source.text.length,
      overheadChars,
      mainModel,
      helperModel: settings.helperModel,
      routeWhenSamePrice: settings.routeWhenSamePrice,
    }),
    minSavingUsd: settings.minEstimatedSavingUsd,
    // A Read's full copy is the file itself; MCP and Bash need a saved copy.
    canKeepCopy: source.kind === 'file' || settings.saveFullCopies,
  })
  if (!decision.route) {
    if (decision.why === 'repeat') ctx.recentKeys = ctx.recentKeys.filter(k => k !== source.key)
    if (decision.consumesFull) {
      ctx.isFullArmed = false
      await showArmed($, false)
    }
    return ran
  }

  // An MCP result needs a place for its full text; it is written only once the notes are in hand,
  // so a failed hand-off leaves no copy behind.
  let fullPath = source.label
  if (source.kind !== 'file') {
    const path = await resultPath($, source.tool, String(input.tool_use_id ?? ''))
    if (path === null) return ran
    fullPath = path
  }

  const numbered = numberLines(source.text, source.firstLine)
  const answer = await $.model.complete({
    model: settings.helperModel,
    system: HELPER_SYSTEM,
    prompt: helperPrompt({ ...promptArgs, numbered }),
    maxTokens: Math.min(16_000, Math.ceil(settings.maxNoteChars / 3) + 64),
    timeoutMs: settings.timeoutMs,
  })
  // From here the helper was called: a result that is then left whole is a wasted call and is logged
  // (`cost-upgrade`). Only the first branch can have spent nothing (an unanswered call that reported no usage).
  const wastedArgs = {
    source,
    isAnswered: answer.isAnswered,
    usage: answer.usage,
    replyChars: answer.isAnswered ? answer.text.length : 0,
    helperInputChars: Math.min(numbered.length, HELPER_INPUT_MAX),
    overheadChars,
    helperModel: settings.helperModel,
    isSubagent,
  }
  if (!answer.isAnswered) {
    await recordWasted($, ctx, { ...wastedArgs, reason: `no answer: ${answer.reason}` })
    return ran
  }
  const notes = cleanNotes(answer.text, settings.maxNoteChars)
  if (notes === '') {
    await recordWasted($, ctx, { ...wastedArgs, reason: 'empty notes' })
    return ran
  }

  const lineCount = source.text.split('\n').length
  const note = composeNote({
    kind: source.kind,
    label: source.label,
    fullPath,
    model: settings.helperModel,
    notes,
    inChars: source.text.length,
    firstLine: source.firstLine,
    lineCount,
    totalLines: source.totalLines,
    isHelperInputCut: numbered.length > HELPER_INPUT_MAX,
  })
  if (note.length >= source.text.length * MAX_NOTE_RATIO) {
    await recordWasted($, ctx, { ...wastedArgs, reason: 'notes not smaller than 60% of the source' })
    return ran
  }

  if (source.kind !== 'file') {
    try {
      await $.fs.write(fullPath, source.text)
    } catch {
      await recordWasted($, ctx, { ...wastedArgs, reason: 'full copy could not be saved' })
      return ran
    }
  }

  const counts = tokenCounts({
    sourceChars: source.text.length,
    digestChars: note.length,
    helperInputChars: Math.min(numbered.length, HELPER_INPUT_MAX),
    helperOutputChars: answer.text.length,
    promptOverheadChars: overheadChars,
    usage: answer.usage,
  })
  const out = rewrite(note)
  const key = source.key
  if (key !== null) ctx.recentKeys = [...ctx.recentKeys.filter(k => k !== key), key].slice(-RECENT_KEYS)
  await record($, ctx, {
    at: Date.now(),
    tool: toolLabel(source.tool),
    target: source.target,
    inChars: source.text.length,
    outChars: note.length,
    tokensAvoided: counts.avoided,
    helperTokens: counts.helper,
    costUsd: costUsdEstimate(counts.avoided, counts.helper, mainModel, settings.helperModel),
    mainModel,
    helperModel: settings.helperModel,
    isSubagent,
  })
  return out
}

/**
 * A helper call whose digest was not used: logs a `cost-upgrade` line (no `tokensAvoided`, a negative
 * dollar figure when the helper's price is known) and adds a pane row. An unanswered call that
 * reported no usage spent nothing the API tells us about (an aborted or refused completion reports
 * zeros), so it is not logged.
 */
async function recordWasted(
  $: EngineInterface,
  ctx: Ctx,
  a: {
    source: Source
    reason: string
    isAnswered: boolean
    usage: HelperUsage | undefined
    replyChars: number
    helperInputChars: number
    overheadChars: number
    helperModel: string
    isSubagent: boolean
  },
) {
  const reported = Object.values(a.usage ?? {}).some(v => typeof v === 'number' && v > 0)
  if (!a.isAnswered && !reported) return
  const counts = tokenCounts({
    sourceChars: a.source.text.length,
    digestChars: a.source.text.length,
    helperInputChars: a.helperInputChars,
    helperOutputChars: a.replyChars,
    promptOverheadChars: a.overheadChars,
    usage: a.usage,
  })
  await record($, ctx, {
    at: Date.now(),
    tool: toolLabel(a.source.tool),
    target: a.source.target,
    inChars: a.source.text.length,
    outChars: a.source.text.length,
    tokensAvoided: 0,
    helperTokens: counts.helper,
    costUsd: wastedCostUsd(counts.helper, a.helperModel),
    mainModel: '',
    helperModel: a.helperModel,
    wasted: a.reason,
    isSubagent: a.isSubagent,
  })
}

/** A fresh answer (never `ran` spread: a leftover `ref` would make core use its own messages). */
function withContext(result: unknown, ran: ToolCallResult): ToolCallResult {
  return ran.context === undefined ? { result } : { result, context: ran.context }
}

/** Where an MCP result's full text will be saved, or null without HOME. */
async function resultPath($: EngineInterface, tool: string, id: string): Promise<string | null> {
  try {
    const home = await $.env.get('HOME')
    if (!home) return null
    return `${home}/${RESULTS_PARTS.join('/')}/${savedResultName(Date.now(), tool, id)}`
  } catch {
    return null
  }
}

/** Mirrors the "full" flag into the atom the pane reads; cosmetic, so it never throws. */
async function showArmed($: EngineInterface, value: boolean) {
  try {
    await update($, isFullArmed, () => value)
  } catch {
    // the pane is cosmetic
  }
}

/** Pane row, ledger line and the first pane opening. Never changes what the model receives. */
async function record($: EngineInterface, ctx: Ctx, h: Handoff) {
  try {
    await update($, handoffs, list => [...list, h].slice(-MAX_ROWS_KEPT))
  } catch {
    // the pane is cosmetic
  }
  try {
    // The ledger asks for the session id itself before each add and flush (a /clear switches files).
    ctx.ledger ??= createLedger($)
    const isWasted = h.wasted !== undefined
    await ctx.ledger.add({
      ts: new Date(h.at).toISOString(),
      kind: isWasted ? 'cost-upgrade' : 'tokens-avoided',
      ...(isWasted ? {} : { tokensAvoided: h.tokensAvoided }),
      helperTokens: h.helperTokens,
      ...(h.costUsd === null ? {} : { costUsdEstimate: h.costUsd }),
      note: isWasted
        ? wastedNote({
            tool: h.tool,
            target: h.target,
            inChars: h.inChars,
            helper: h.helperTokens,
            helperModel: h.helperModel,
            reason: h.wasted ?? '',
            isPriced: h.costUsd !== null,
          })
        : ledgerNote({
            tool: h.tool,
            target: h.target,
            inChars: h.inChars,
            outChars: h.outChars,
            avoided: h.tokensAvoided,
            helper: h.helperTokens,
            mainModel: h.mainModel,
            helperModel: h.helperModel,
            isPriced: h.costUsd !== null,
            isSubagent: h.isSubagent === true,
          }),
    })
    await ctx.ledger.flush(h.at)
  } catch {
    // the ledger is bookkeeping
  }
  if (!ctx.isPaneOpened) {
    ctx.isPaneOpened = true
    try {
      await $.ui.open({ id: PANE, title: PANE_TITLE })
    } catch {
      // no pane on this surface
    }
  }
}

async function resetSession($: EngineInterface, ctx: Ctx) {
  ctx.written.clear()
  ctx.recentKeys = []
  ctx.tasks.clear()
  ctx.isPaneOpened = false
  ctx.isFullArmed = false
  await showArmed($, false)
  try {
    await update($, handoffs, () => [])
  } catch {
    // the pane is cosmetic
  }
}

/**
 * Retention: empties this mod's saved full copies older than `retentionDays`. `$.fs` has no
 * delete, so an expired copy is overwritten with an empty file (a tombstone; size 0 is never
 * touched again). Only regular files named the way savedResultName names them, directly in
 * the results folder, are touched. Nothing is done when any folder from `claude-mods` down is a
 * symbolic link or not a folder, or when an entry is a link, resolves anywhere other than
 * itself, or was written again since it was listed. Never throws.
 */
async function sweepResults($: EngineInterface, ctx: Ctx, now: number): Promise<number> {
  if (!(ctx.settings.retentionDays > 0)) return 0
  let emptied = 0
  try {
    const home = await $.env.get('HOME')
    if (!home) return 0
    // .claude itself may be a link (dotfile setups); everything the mod owns below it may not.
    for (let i = 2; i <= RESULTS_PARTS.length; i++) {
      const st = await $.fs.stat(`${home}/${RESULTS_PARTS.slice(0, i).join('/')}`)
      if (st.isLink || st.kind !== 'dir') return 0
    }
    const dir = `${home}/${RESULTS_PARTS.join('/')}`
    const real = (await $.fs.stat(dir, { resolve: true })).realPath
    if (real === undefined) return 0
    const listed: ListedEntry[] = await $.fs.list(dir)
    const startedAt = Date.now()
    for (const name of expiredResults(listed, now, ctx.settings.retentionDays).slice(0, SWEEP_MAX)) {
      if (Date.now() - startedAt > SWEEP_BUDGET_MS) break
      const path = `${dir}/${name}`
      try {
        const st = await $.fs.stat(path, { resolve: true })
        const isSame = !st.isLink && st.kind === 'file' && st.realPath === `${real}/${name}`
        if (!isSame || expiredResults([{ name, kind: st.kind, size: st.size, mtimeMs: st.mtimeMs, isLink: st.isLink }], now, ctx.settings.retentionDays).length !== 1) continue
        await $.fs.write(path, '')
        emptied++
      } catch {
        // leave this one for the next session
      }
    }
  } catch {
    // missing folder (nothing saved yet) or no file system: nothing to sweep
  }
  return emptied
}

const FULL_ORIGINS = new Set(['composer', 'bridge', 'sdk'])

export const register: Register = (on, options) => {
  const ctx: Ctx = {
    settings: readSettings(options as Record<string, unknown> | undefined),
    written: new Set(),
    recentKeys: [],
    isFullArmed: false,
    tasks: new Map(),
    ledger: null,
    isPaneOpened: false,
  }

  on('session.start', async ($, e, next) => {
    // A new session starts with an empty pane and nothing armed, whatever an earlier one stored.
    await resetSession($, ctx)
    try {
      await $.command.register({
        name: 'input-router',
        description: CMD_DESCRIPTION,
        argumentHint: CMD_HINT,
      })
    } catch {
      // the command is a convenience
    }
    // Last, and time-boxed, so a large backlog cannot cost the command or the hook budget.
    await sweepResults($, ctx, Date.now())
    return next(e)
  })

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) ctx.written.clear()
    // An empty text (a continuation) keeps the request the thread already has.
    if (e.text.trim() !== '') ctx.tasks.set(e.agentId ?? 'main', e.text)
    return next(e)
  })

  // Rewrites only after the tool ran; every failure returns core's own result. The .catch is
  // replay-safe: after `next` was called it hands back what core settled to, running nothing again.
  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const written = writtenPath(tool, e as unknown as Record<string, unknown>)
    if (written !== null) ctx.written.add(written)
    if (tool !== 'Read' && !isMcpTool(tool) && !(tool === 'Bash' && ctx.settings.routeBash)) return next(e)
    const ran = await next(e)
    try {
      return await route($, ctx, e, ran)
    } catch {
      return ran
    }
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'input-router' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'full') {
      if (!FULL_ORIGINS.has(e.origin.kind)) {
        return { text: CMD_FULL_REFUSED }
      }
      ctx.isFullArmed = true
      await showArmed($, true)
      return { text: CMD_FULL_ARMED }
    }
    if (arg !== '' && arg !== 'pane') {
      return { text: CMD_USAGE }
    }
    try {
      await $.ui.open({ id: PANE, title: PANE_TITLE })
    } catch {
      return { text: CMD_PANE_MISSING }
    }
    return { text: CMD_PANE_OPEN }
  })

  on('session.end', async ($, e, next) => {
    try {
      await ctx.ledger?.flush(Date.now(), true)
    } catch {
      // nothing to do
    }
    // The ledger re-resolves the session id on its next add or flush, so the session after a
    // /clear gets its own file.
    if (e.reason === 'clear') await resetSession($, ctx)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const list = await read($, handoffs)
    const armed = await read($, isFullArmed)
    const width = Math.max(30, e.props.bodyColumns)
    const room = Math.max(1, (e.viewport?.rows ?? 24) - 6)
    const wasted = list.filter(one => one.wasted !== undefined).length
    const avoided = list.reduce((sum, one) => sum + one.tokensAvoided, 0)
    const helper = list.reduce((sum, one) => sum + one.helperTokens, 0)
    const priced = list.filter(one => one.costUsd !== null)
    const usd = priced.length === 0 ? null : roundUsd(priced.reduce((sum, one) => sum + (one.costUsd ?? 0), 0))

    return (
      <Box flexDirection="column">
        <Text bold color="claude">{PANE_TITLE}</Text>
        <Text dimColor>{'\u2500'.repeat(Math.min(width, 60))}</Text>
        <Text bold>{paneHead(list.length - wasted, avoided, helper, usd, wasted)}</Text>
        {armed && ctx.isFullArmed ? <Text color="warning">{PANE_ARMED}</Text> : null}
        {list.length === 0 ? <Text dimColor>{PANE_EMPTY}</Text> : null}
        {list.slice(-room).map(one => (
          <Text>{formatHandoff(one, width)}</Text>
        ))}
      </Box>
    )
  })
}
