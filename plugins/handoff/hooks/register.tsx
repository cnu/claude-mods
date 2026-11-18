import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { createLedger, readExisting } from './ledger'
import {
  afterTurn,
  appendLog,
  bar,
  buildDraft,
  buildPrompt,
  clampNote,
  CONFIRM_WINDOW_MS,
  dismissOffer,
  estimateTokens,
  FRESH_OFFER,
  freshChatPrompt,
  handoffPaths,
  helperCost,
  reportedTokens,
  isNoteOnDisk,
  logLine,
  sessionFileId,
  neutralizeWrapper,
  noteFile,
  readSettings,
  stepStatus,
  STEPS,
  timestampName,
} from './logic'
import type { HelperCost, Msg, OfferState, Settings } from './logic'

const tokens = atom({ plugin: 'handoff', key: 'tokens' } as const, 0)
const phase = atom({ plugin: 'handoff', key: 'phase' } as const, 'idle')
const step = atom({ plugin: 'handoff', key: 'step' } as const, 0)
const message = atom({ plugin: 'handoff', key: 'message' } as const, '')
const notePath = atom({ plugin: 'handoff', key: 'notePath' } as const, '')
// True while "Clear and continue with it" waits for its second press.
const confirming = atom({ plugin: 'handoff', key: 'confirming' } as const, false)

// The slash command is /refresh (the name the spec gives). If registering it is refused (a built-in), /handoff.
const COMMAND_NAMES = ['refresh', 'handoff'] as const

// Plain per-load bookkeeping that the hooks and the press handlers share. The engine's validator
// follows `$` only into top-level function declarations, so the helpers below are those and take `ctx`.
type Ctx = {
  settings: Settings
  offer: OfferState
  isRunning: boolean
  /** The note (or, after a failed model call, the draft) of the last run; kept in memory for Copy. */
  note: string
  isDraftOnly: boolean
  commandName: string | null
  ledger: ReturnType<typeof createLedger> | null
  /** Clock time until which a second press of the clear button counts; 0 when not armed. */
  armedUntil: number
  confirmTimer: { cancel: () => void } | null
}

async function setPhase($: EngineInterface, p: string, s: number, text: string) {
  await update($, phase, () => p)
  await update($, step, () => s)
  await update($, message, () => text)
}

/** The main loop's model id, or undefined when it cannot be read (then the ledger gets no dollar figure). */
async function sessionModel($: EngineInterface): Promise<string | undefined> {
  try {
    return await $.session.model()
  } catch {
    return undefined
  }
}

async function failRun($: EngineInterface, s: number, text: string) {
  await setPhase($, 'failed', s, text)
  return text
}

async function appendRunLog($: EngineInterface, path: string, at: number, session: string, before: number, result: string) {
  // Only a missing log starts empty; any other read error skips the write rather than wiping the history.
  const existing = await readExisting($, path)
  if (existing === null) return
  await $.fs.write(path, appendLog(existing, logLine(at, session, before, result)))
}

// One refresh: draft -> one model call -> note on disk. Never throws; returns the line to print.
// `isBusy`: the band's own "the model is working" flag (a typed /refresh waits for idle by itself).
async function runRefresh($: EngineInterface, ctx: Ctx, isBusy = false): Promise<string> {
  if (ctx.isRunning) return 'A refresh is already running.'
  if (isBusy) return 'The model is mid-turn: press Refresh again once it has finished.'
  ctx.isRunning = true
  await disarmClear($, ctx)
  let session = ''
  let before = 0
  let at = 0
  let logPath: string | null = null
  let result = 'failed: unknown'
  try {
    const home = await $.env.get('HOME')
    at = await $.clock.now()
    session = sessionFileId(await $.session.id())
    const { context } = await $.session.usage()
    before = context.tokens ?? (await read($, tokens))
    if (!home) {
      result = 'failed: HOME is not set'
      return await failRun($, 0, 'HOME is not set, so nothing can be saved. No model call was made.')
    }
    const paths = handoffPaths(home, timestampName(at), session)
    logPath = paths.log
    if (logPath === null) $.ui.toast('No session id, so this run is not logged. The note is still saved.')

    // 1. The draft, on disk before the model is asked.
    await setPhase($, 'running', 0, '')
    let draft = ''
    try {
      const msgs = (await $.session.messages()) as readonly Msg[]
      draft = buildDraft({ at, session, tokens: before, cwd: await $.session.cwd(), messages: msgs })
      await $.fs.write(paths.draft, draft)
    } catch (err) {
      result = 'failed: draft not saved'
      return await failRun($, 0, `Could not save the draft (${err instanceof Error ? err.message : 'write failed'}). No model call was made.`)
    }

    // 2. One model call over the session's own (cached) transcript.
    await setPhase($, 'running', 1, '')
    let body = ''
    let why = ''
    // What the call spent, for the ledger. Null when nothing was billed that we know of (a thrown error, or a refusal
    // that reported no usage such as nothing-to-fork).
    let spent: HelperCost | null = null
    let model: string | undefined
    try {
      const prompt = buildPrompt(ctx.settings.maxHandoffChars)
      const r = await $.model.fork({ prompt })
      // The fork re-reads the whole transcript: `before` tokens, plus the prompt (used only if no usage was reported).
      // `nothing-to-fork` carries no usage (nothing was sent), so only the other arms have it.
      const usage = 'usage' in r ? r.usage : undefined
      if (r.isAnswered || reportedTokens(usage) > 0) {
        model = await sessionModel($)
        spent = helperCost(usage,before + estimateTokens(prompt.length), r.isAnswered ? r.text.length : 0, model)
      }
      if (r.isAnswered && r.text.trim() !== '') body = clampNote(neutralizeWrapper(r.text), ctx.settings.maxHandoffChars)
      else why = r.isAnswered ? 'empty reply' : r.reason === 'api-error' ? `api-error ${r.status}` : r.reason
    } catch (err) {
      why = err instanceof Error ? err.message : 'model call failed'
    }
    // The ledger line (one per run, also when the note could not be written: the call was billed either way).
    const addLedger = async (text: string, outcome: string) => {
      try {
        await ctx.ledger?.use(session)
      } catch {
        // A ledger that cannot be pointed at a file stays off; the run goes on.
      }
      ctx.ledger?.add({
        ts: new Date(at).toISOString(),
        session,
        kind: 'handoff',
        ...(spent === null ? {} : { helperTokens: spent.helperTokens }),
        ...(spent?.costUsdEstimate === undefined ? {} : { costUsdEstimate: spent.costUsdEstimate }),
        note:
          `handoff ${outcome}; ${before} tokens before, note ~${estimateTokens(text.length)} tokens` +
          (spent === null
            ? '; the model call reported no usage, so no cost is logged'
            : `; cost of writing the note: ${spent.helperTokens} tokens on ${model ?? 'an unknown model'} (${spent.isReported ? 'reported usage' : 'estimated, ceil(chars/4)'}` +
              `${spent.costUsdEstimate === undefined ? '; no dollar figure' : ', priced at the input rate'})`),
      })
    }
    const isDraftOnly = body === ''

    // 3. The note to disk. After a failed call it is the draft, so the run still leaves a handoff.
    await setPhase($, isDraftOnly ? 'failed' : 'running', 2, '')
    const text = noteFile(isDraftOnly ? draft : body, { at, session, tokens: before, isDraftOnly, reason: why })
    try {
      await $.fs.write(paths.note, text)
    } catch (err) {
      result = 'failed: note not written'
      ctx.note = text
      ctx.isDraftOnly = true
      // The call was billed even though the note could not be saved.
      if (spent !== null) await addLedger(text, 'note not written')
      return await failRun($, 2, `Could not write ${paths.note} (${err instanceof Error ? err.message : 'write failed'}).`)
    }
    ctx.note = text
    ctx.isDraftOnly = isDraftOnly
    await update($, notePath, () => paths.note)

    result = isDraftOnly ? `failed: model call (${why}); draft kept` : 'ok'
    await addLedger(text, `${isDraftOnly ? 'draft only' : 'note'} written`)
    if (isDraftOnly) {
      await setPhase($, 'failed', 1, `The model call failed (${why}). The draft is kept at ${paths.draft} and copied into ${paths.note}.`)
      return `The model call failed (${why}). Draft kept: ${paths.note}`
    }
    await setPhase($, 'done', 3, `Saved to ${paths.note}`)
    return `Handoff note written to ${paths.note}`
  } catch (err) {
    result = `failed: ${err instanceof Error ? err.message : 'error'}`
    return await failRun($, 0, `The refresh stopped: ${err instanceof Error ? err.message : 'error'}.`)
  } finally {
    ctx.isRunning = false
    // The run is always logged, whichever way it ended.
    try {
      if (logPath !== null) await appendRunLog($, logPath, at, session, before, result)
      await ctx.ledger?.flush(at, true)
    } catch {
      // The log must never break the band.
    }
  }
}

// A button's refresh: a refusal has no transcript line to land in, so it is toasted.
async function pressRefresh($: EngineInterface, ctx: Ctx, isBusy: boolean) {
  const out = await runRefresh($, ctx, isBusy)
  if (out === 'A refresh is already running.' || out.startsWith('The model is mid-turn')) $.ui.toast(out)
}

// The note as text: in memory, else (after a hot reload) from the file of the last run.
async function noteText($: EngineInterface, ctx: Ctx): Promise<string> {
  if (ctx.note !== '') return ctx.note
  const path = await read($, notePath)
  if (path === '') return ''
  try {
    return await $.fs.read(path)
  } catch {
    return ''
  }
}

async function copyNote($: EngineInterface, ctx: Ctx, surface: 'terminal' | 'desktop' | 'mobile' | 'vscode' | undefined) {
  const note = await noteText($, ctx)
  if (note === '') return
  const r = await $.ui.copy({ text: note, surface })
  $.ui.toast(r.isCopied ? 'Handoff note copied.' : `Could not copy (${r.reason}). It is saved on disk.`)
}

// Takes back the armed clear button: cancels the timer and redraws the label.
async function disarmClear($: EngineInterface, ctx: Ctx) {
  ctx.armedUntil = 0
  ctx.confirmTimer?.cancel()
  ctx.confirmTimer = null
  await update($, confirming, () => false)
}

// The note file as it is on disk right now, or '' when it is missing or unreadable.
async function readNoteFromDisk($: EngineInterface, path: string): Promise<string> {
  if (path === '') return ''
  try {
    return await $.fs.read(path)
  } catch {
    return ''
  }
}

// Toasts where the note is. Never touches the chat.
async function showNotePath($: EngineInterface) {
  const path = await read($, notePath)
  $.ui.toast(path === '' ? 'No note file was written yet.' : `Handoff note: ${path}`, { timeoutMs: 8000 })
}

// "Clear and continue with it" is destructive, so it takes two presses. The first checks the note file is on
// disk and arms the button for CONFIRM_WINDOW_MS; the second checks the file again and only then clears the
// chat and sends the note as the first message of the fresh one. Nothing is cleared unless the file is there.
async function startFresh($: EngineInterface, ctx: Ctx, surface: 'terminal' | 'desktop' | 'mobile' | 'vscode' | undefined) {
  const path = await read($, notePath)
  const onDisk = await readNoteFromDisk($, path)
  if (!isNoteOnDisk(onDisk, ctx.note)) {
    await disarmClear($, ctx)
    $.ui.toast(
      path === ''
        ? 'The note was not written to disk, so the chat is not cleared. Use Copy note.'
        : `The note file is missing, empty or changed (${path}), so the chat is not cleared. Use Copy note.`,
      { timeoutMs: 8000 },
    )
    return
  }
  const now = await $.clock.now()
  if (ctx.armedUntil === 0 || now > ctx.armedUntil) {
    await disarmClear($, ctx)
    ctx.armedUntil = now + CONFIRM_WINDOW_MS
    await update($, confirming, () => true)
    ctx.confirmTimer = $.clock.after(CONFIRM_WINDOW_MS, () => disarmClear($, ctx))
    $.ui.toast(`This clears the current chat. Press the button again within ${CONFIRM_WINDOW_MS / 1000} s to confirm. The note is at ${path}.`, {
      timeoutMs: CONFIRM_WINDOW_MS,
    })
    return
  }
  await disarmClear($, ctx)
  const text = freshChatPrompt(onDisk)
  const cleared = (await $.command.list()).some(c => c.name === 'clear')
  try {
    if (!cleared) throw new Error('no /clear command')
    await $.command.run({ command: 'clear' })
    // /clear raises session.end, which resets this too; do it here so the band never outlives the old chat.
    ctx.offer = FRESH_OFFER
    ctx.note = ''
    await update($, tokens, () => 0)
    await update($, notePath, () => '')
    await setPhase($, 'idle', 0, '')
    $.ui.toast(`Chat cleared. The note is still at ${path}.`)
    const sent = await $.prompt.submit({ text })
    if ('drop' in sent) throw new Error('the first message was dropped by a hook')
  } catch (err) {
    const r = await $.ui.copy({ text, surface })
    $.ui.toast(
      `Could not continue in a fresh chat (${err instanceof Error ? err.message : 'failed'}). ${r.isCopied ? 'The note is on the clipboard: paste it into the next chat.' : `Use the note on disk: ${path}`}`,
      { timeoutMs: 8000 },
    )
  }
}

async function dismissBand($: EngineInterface, ctx: Ctx) {
  await disarmClear($, ctx)
  await setPhase($, 'idle', 0, '')
}

async function declineOffer($: EngineInterface, ctx: Ctx) {
  ctx.offer = dismissOffer(ctx.settings)
  await setPhase($, 'idle', 0, '')
}

export const register: Register = (on, options) => {
  const ctx: Ctx = {
    settings: readSettings(options),
    offer: FRESH_OFFER,
    isRunning: false,
    note: '',
    isDraftOnly: false,
    commandName: null,
    ledger: null,
    armedUntil: 0,
    confirmTimer: null,
  }
  const { settings } = ctx

  on('session.start', async ($, e, next) => {
    ctx.ledger = createLedger($)
    try {
      await ctx.ledger.use(await $.session.id())
    } catch {
      // No session id yet: the ledger is pointed at a file on the first refresh.
    }
    for (const name of COMMAND_NAMES) {
      try {
        await $.command.register({
          name,
          description: 'Write a handoff note for this chat and carry it into a fresh one',
        })
        ctx.commandName = name
        break
      } catch {
        // The name is taken (a built-in refuses it): try the next.
      }
    }
    return next(e)
  })

  // A resumed or forked chat: remember its size. The offer waits for the first turn, when a fork has a transcript to read.
  on('classic.SessionStart', async ($, e, next) => {
    if ((e.source === 'resume' || e.source === 'fork') && typeof e.context_tokens === 'number') {
      await update($, tokens, () => e.context_tokens ?? 0)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    // An error that carried no usage made no request: the size did not change.
    if (e.reason !== 'error' || e.usage !== undefined) {
      const { context } = await $.session.usage()
      const size = context.tokens ?? 0
      await update($, tokens, () => size)
      await considerOffer($, ctx, size)
    }
    await ctx.ledger?.flush(await $.clock.now())
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      ctx.offer = FRESH_OFFER
      ctx.note = ''
      ctx.isDraftOnly = false
      await update($, tokens, () => 0)
      await setPhase($, 'idle', 0, '')
      await update($, notePath, () => '')
      await disarmClear($, ctx)
    }
    await ctx.ledger?.flush(await $.clock.now(), true)
    return next(e)
  })

  // Only the name this plugin registered: if /handoff belongs to another plugin, leave it alone.
  on('command.run', { command: [...COMMAND_NAMES] }, async ($, e, next) => {
    if (e.command !== ctx.commandName) return next(e)
    return { text: await runRefresh($, ctx) }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const p = await read($, phase)
    if (e.props.hasSurvey || p === 'idle') return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const size = await read($, tokens)

    if (p === 'offer') {
      return (
        <Box flexDirection="column">
          <Text color="yellow">{`This chat holds ${Math.round(size / 1000)}k tokens (offer threshold ${Math.round(settings.thresholdTokens / 1000)}k). Carry it into a fresh chat?`}</Text>
          <Box>
            <Button key="refresh" label="Refresh" onPress={() => pressRefresh($, ctx, e.props.isWorking)} />
            <Text>{' '}</Text>
            <Button key="not-now" label="Not now" onPress={() => declineOffer($, ctx)} />
          </Box>
        </Box>
      )
    }

    const s = await read($, step)
    const text = await read($, message)
    const path = await read($, notePath)
    const isConfirming = await read($, confirming)
    const isEnded = p === 'done' || p === 'failed'
    const hasNote = path !== '' || ctx.note !== ''

    return (
      <Box flexDirection="column">
        <Text bold>{`Refresh: handoff (${Math.round(size / 1000)}k tokens before)`}</Text>
        {STEPS.map((label, i) => {
          const st = stepStatus(i, p, s)
          return (
            <Text color={st === 'failed' ? 'red' : st === 'done' ? 'green' : undefined} dimColor={st === 'pending'}>
              {`${bar(st)} ${label}`}
            </Text>
          )
        })}
        {text !== '' ? <Text dimColor={p === 'done'} color={p === 'failed' ? 'red' : undefined}>{text}</Text> : null}
        {isEnded ? (
          <Box>
            {hasNote ? (
              <Button key="copy" label={ctx.isDraftOnly ? 'Copy draft' : 'Copy note'} onPress={press => copyNote($, ctx, press.surface)} />
            ) : null}
            {path !== '' ? <Text>{' '}</Text> : null}
            {path !== '' ? <Button key="path" label="Open note path" onPress={() => showNotePath($)} /> : null}
            {path !== '' ? <Text>{' '}</Text> : null}
            {path !== '' ? (
              <Button
                key="fresh"
                label={isConfirming ? 'Press again to clear this chat' : 'Clear and continue with it'}
                onPress={press => startFresh($, ctx, press.surface)}
              />
            ) : null}
            {p === 'failed' ? <Text>{' '}</Text> : null}
            {p === 'failed' ? <Button key="retry" label="Retry" onPress={() => pressRefresh($, ctx, e.props.isWorking)} /> : null}
            <Text>{' '}</Text>
            <Button key="dismiss" label="Dismiss" onPress={() => dismissBand($, ctx)} />
          </Box>
        ) : null}
      </Box>
    )
  })
}

// After a turn (or a resume): offer once per crossing, with a toast and the band.
async function considerOffer($: EngineInterface, ctx: Ctx, size: number) {
  const r = afterTurn(ctx.offer, size, ctx.settings)
  ctx.offer = r.state
  const p = await read($, phase)
  if (size < ctx.settings.thresholdTokens && p === 'offer') await setPhase($, 'idle', 0, '')
  // Never replace a finished run's buttons (done or failed) with a new offer.
  if (!r.offer || ctx.isRunning || p === 'running' || p === 'done' || p === 'failed') return
  await setPhase($, 'offer', 0, '')
  const cmd = ctx.commandName ? ` (or /${ctx.commandName})` : ''
  $.ui.toast(`This chat holds ${Math.round(size / 1000)}k tokens. Refresh into a fresh chat with a handoff note?${cmd}`, {
    timeoutMs: 8000,
  })
}
