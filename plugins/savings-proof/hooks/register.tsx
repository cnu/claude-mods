import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import {
  formatMoney,
  moneyLabel,
  formatTime,
  formatTokens,
  isEmpty,
  isOld,
  parseLedgerText,
  parseSnapshot,
  readSettings,
  signature,
  statusText,
  summarize,
} from './logic'
import type { Entry, RecentRow, Settings, Summary, Totals } from './logic'

const PANE = 'savings'
const POLL_MS = 4000
const LEDGER_DIR = '.claude/claude-mods/ledger'

// The summary is kept as JSON text so it survives a reload and needs no inline object type in
// the state contract. Change the tag when the Summary fields change: it declines older text.
const snapshot = atom({ plugin: 'savings-proof', key: 'snapshot' } as const, '', { shape: 'snapshot-3' })
const refreshedAt = atom({ plugin: 'savings-proof', key: 'refreshedAt' } as const, 0)

// Per-load bookkeeping. A hot reload drops the timer with the module, so it is plain here and
// the hooks below re-arm it when the pane is still up.
type Parsed = { size: number; mtimeMs: number; entries: Entry[]; skipped: number; unreadable: number }
type Ctx = {
  settings: Settings
  lastSig: string | null
  /** Parsed result per ledger file name, valid while its size and mtime are unchanged. */
  cache: Map<string, Parsed>
  stop: (() => void) | null
}

async function readLedger($: EngineInterface) {
  const home = await $.env.get('HOME')
  if (!home) return null
  const dir = `${home}/${LEDGER_DIR}`
  let listing: Awaited<ReturnType<typeof $.fs.list>> = []
  try {
    listing = await $.fs.list(dir)
  } catch {
    listing = [] // no ledger folder yet: "no data yet"
  }
  const files = listing.filter(f => f.kind === 'file' && f.name.endsWith('.jsonl'))
  return { dir, files }
}

/**
 * Rereads the ledger and, when a file changed (or `isForced`), rebuilds the snapshot atom and the
 * status line. Cheap when nothing changed: one directory listing.
 */
async function refresh($: EngineInterface, ctx: Ctx, isForced: boolean) {
  const found = await readLedger($)
  const now = await $.clock.now()
  const sig = found === null ? 'no-home' : signature(found.files)
  if (!isForced && sig === ctx.lastSig) return
  ctx.lastSig = sig

  // A forced refresh (the /savings command) rereads everything; a poll rereads only the files
  // whose size or mtime moved. Files are read independently: no entry is shared or de-duplicated
  // across them, and each line carries its own `mod`.
  if (isForced) ctx.cache.clear()
  const entries: Entry[] = []
  let skipped = 0
  let unreadable = 0
  const live = new Set<string>()
  let oldFiles = 0
  for (const f of found?.files ?? []) {
    // A file last modified before the window holds only lines older than it: skip it unread.
    if (isOld(f.mtimeMs, now, ctx.settings.ledgerDays)) {
      oldFiles += 1
      continue
    }
    live.add(f.name)
    let p = ctx.cache.get(f.name)
    if (p === undefined || p.size !== f.size || p.mtimeMs !== f.mtimeMs) {
      p = { size: f.size, mtimeMs: f.mtimeMs, entries: [], skipped: 0, unreadable: 0 }
      try {
        const text = await $.fs.read(`${found?.dir}/${f.name}`)
        const parsed = parseLedgerText(typeof text === 'string' ? text : '')
        p.entries = parsed.entries
        p.skipped = parsed.skipped
      } catch {
        p.unreadable = 1 // missing again, or over the 4 MiB read limit
      }
      ctx.cache.set(f.name, p)
    }
    entries.push(...p.entries)
    skipped += p.skipped
    unreadable += p.unreadable
  }
  for (const name of [...ctx.cache.keys()]) if (!live.has(name)) ctx.cache.delete(name)
  const summary = summarize({
    entries,
    now,
    sessionId: await $.session.id(),
    skipped,
    unreadable,
    files: (found?.files.length ?? 0) - oldFiles,
    oldFiles,
    ledgerDays: ctx.settings.ledgerDays,
  })
  await update($, snapshot, () => JSON.stringify(summary))
  await update($, refreshedAt, () => now)
  $.ui.status(ctx.settings.showStatus ? statusText(summary, ctx.settings.currency, ctx.settings.unitsPerUsd) : undefined)
}

function startPoll($: EngineInterface, ctx: Ctx) {
  if (ctx.stop !== null) return
  const timer = $.clock.every(POLL_MS, () => {
    refresh($, ctx, false).catch(() => {})
  })
  ctx.stop = () => timer.cancel()
}

function stopPoll(ctx: Ctx) {
  ctx.stop?.()
  ctx.stop = null
}

/** After a reload the pane can still be up while the timer is gone: re-arm it. */
async function rearm($: EngineInterface, ctx: Ctx) {
  if (ctx.stop !== null) return
  const panes = await $.ui.panes()
  if (panes.some(p => p.id === PANE)) startPoll($, ctx)
}

const fit = (text: string, width: number) => (text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}~`)
const pad = (text: string, width: number) => fit(text, width).padEnd(width)
const padLeft = (text: string, width: number) => fit(text, width).padStart(width)

/** The three separate numbers side by side. Dollars are signed and cover only events that have a figure. */
function figures(t: Totals, s: Settings) {
  const noUsd = t.noUsd > 0 ? ` (${t.noUsd} no $)` : ''
  return `Avoided ${formatTokens(t.avoided)}, Helper ${formatTokens(t.helper)}, ${estLabel(s)} ${labelledMoney(t.usd, s)}${noUsd}`
}

/** `Est. $` for USD, `Est. INR` for another currency: the label follows the currency. */
const estLabel = (s: Settings) => `Est. ${moneyLabel(s.currency)}`

/** Money under an `Est.` label: USD keeps its `$` in the figure (`~$0.04`), others do not repeat the code (`~3.3`). */
const labelledMoney = (usd: number, s: Settings) => formatMoney(usd, s.currency, s.unitsPerUsd, moneyLabel(s.currency) !== '$')

/** One recent event's figures: `av 12k help 1.5k ~$0.04` (a part is `-` when the line has none). */
function recentFigures(r: RecentRow, s: Settings) {
  const usd = r.hasUsd ? formatMoney(r.usd, s.currency, s.unitsPerUsd) : '-'
  return `av ${formatTokens(r.avoided)} help ${formatTokens(r.helper)} ${usd}`
}

/** The window line for the footer: what the age cutoff did. */
function windowNote(s: Summary): string {
  if (s.ledgerDays <= 0) return 'Window: no age limit.'
  return `Window: last ${s.ledgerDays} day(s); ${s.oldFiles} older file(s) skipped.`
}

export const register: Register = (on, options) => {
  const ctx: Ctx = { settings: readSettings(options), lastSig: null, cache: new Map(), stop: null }
  const { settings } = ctx

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'savings', description: 'Show what the other mods saved (estimates) in a pane' })
    // Status line only: the pane's own poll runs while the pane is open.
    if (settings.showStatus) refresh($, ctx, true).catch(() => {})
    await rearm($, ctx)
    return next(e)
  })

  on('command.run', { command: 'savings' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Savings (estimated)' })
    await refresh($, ctx, true)
    startPoll($, ctx)
    return { text: 'Savings pane opened (all figures are estimates).' }
  })

  // The status line follows new ledger lines at the end of each turn (no timer while the pane is shut).
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      if (settings.showStatus) await refresh($, ctx, false).catch(() => {})
      await rearm($, ctx)
    }
    return next(e)
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) stopPoll(ctx)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    stopPoll(ctx)
    ctx.lastSig = null // a /clear changes the session id: the next refresh must rebuild "this chat"
    ctx.cache.clear()
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const text = await read($, snapshot)
    await read($, refreshedAt) // subscribes this drawing to each refresh
    const { Box, Text } = $.ui.resolve(e)
    const cols = Math.max(24, e.props.bodyColumns)
    const s: Summary | null = parseSnapshot(text)

    const rule = '─'.repeat(Math.min(cols, 60))

    if (s === null || isEmpty(s)) {
      return (
        <Box flexDirection="column">
          <Text>
            <Text bold color="claude">Savings</Text>
            <Text dimColor> (estimated)</Text>
          </Text>
          <Text dimColor>{rule}</Text>
          <Text dimColor>no data yet</Text>
          <Text dimColor>The other mods write their ledger under ~/.claude/claude-mods/ledger/ once they have saved something.</Text>
          {s !== null && s.skipped > 0 ? <Text dimColor>{`${s.skipped} unreadable ledger line(s) skipped.`}</Text> : null}
          {s !== null && s.ledgerDays > 0 ? <Text dimColor>{fit(windowNote(s), 200)}</Text> : null}
        </Box>
      )
    }

    // Column widths from the pane width: mod name takes what is left.
    const wEv = 6
    const wTok = 8
    const wUsd = 11
    const wNo = 5
    const wMod = Math.max(8, Math.min(24, cols - wEv - wTok * 2 - wUsd - wNo - 5))

    const usdColor = (usd: number) => (usd < 0 ? 'error' : usd > 0 ? 'success' : undefined)

    return (
      <Box flexDirection="column">
        <Text>
          <Text bold color="claude">Savings</Text>
          <Text dimColor> (estimated)</Text>
        </Text>
        <Text dimColor>{rule}</Text>
        <Text bold>{fit(`Today:     ${s.today.events} events, ${figures(s.today, settings)}`, cols)}</Text>
        <Text>{fit(`This chat: ${s.session.events} events, ${figures(s.session, settings)}`, cols)}</Text>
        <Text dimColor>{fit(`All time:  ${s.all.events} events, ${figures(s.all, settings)}`, cols)}</Text>
        <Text> </Text>
        <Text bold color="suggestion">{fit(`${pad('Mod', wMod)} ${padLeft('Events', wEv)} ${padLeft('Avoided', wTok)} ${padLeft('Helper', wTok)} ${padLeft(estLabel(settings), wUsd)} ${padLeft('No $', wNo)}`, cols)}</Text>
        <Text dimColor>{rule}</Text>
        {s.perMod.map(r => {
          const plain = `${pad(r.mod, wMod)} ${padLeft(String(r.events), wEv)} ${padLeft(formatTokens(r.avoided), wTok)} ${padLeft(formatTokens(r.helper), wTok)} ${padLeft(labelledMoney(r.usd, settings), wUsd)} ${padLeft(String(r.noUsd), wNo)}`
          // A pane narrower than the full row gets one plain clamped string (nested spans cannot be cut).
          if (cols < plain.length) return <Text>{fit(plain, cols)}</Text>
          return (
            <Text>
              <Text bold>{pad(r.mod, wMod)}</Text>
              {` ${padLeft(String(r.events), wEv)} `}
              <Text color="success">{padLeft(formatTokens(r.avoided), wTok)}</Text>
              {` ${padLeft(formatTokens(r.helper), wTok)} `}
              <Text color={usdColor(r.usd)}>{padLeft(labelledMoney(r.usd, settings), wUsd)}</Text>
              {` ${padLeft(String(r.noUsd), wNo)}`}
            </Text>
          )
        })}
        <Text dimColor>{fit('Rows cover the whole ledger window. Est. is a signed sum over events with a dollar figure; No $ counts the rest. Tokens and dollars are kept separate.', cols)}</Text>
        <Text> </Text>
        <Text bold color="suggestion">{`Last ${s.recent.length} events`}</Text>
        <Text dimColor>{rule}</Text>
        {s.recent.map(r => (
          <Text dimColor={r.kind === 'info'}>
            {fit(
              `${formatTime(r.at)} ${pad(r.mod, 12)} ${r.kind === 'info' ? 'info' : recentFigures(r, settings)} ${r.note}`,
              cols,
            )}
          </Text>
        ))}
        {s.skipped > 0 || s.unreadable > 0 ? (
          <Text dimColor>{`${s.skipped} bad line(s) skipped, ${s.unreadable} file(s) unreadable.`}</Text>
        ) : null}
        <Text dimColor>{fit(windowNote(s), cols)}</Text>
        <Text dimColor>{fit('Refreshes about every 4 s while open.', cols)}</Text>
      </Box>
    )
  })
}
