import type { EngineInterface } from 'claude-code'

// Writer for ~/.claude/claude-mods/ledger/input-router.<session-id>.jsonl, one file per session
// (contract and writer rules: docs/ledger.md in the repo). The legacy input-router.jsonl is
// neither read nor written. $.fs has no append, so entries live in memory and the whole file
// is written back, batched.

export type LedgerEntry = {
  v: 1
  ts: string
  mod: 'input-router'
  session: string
  /** `tokens-avoided`: a digest was used. `cost-upgrade`: a helper call whose digest was thrown away (nothing avoided). */
  kind: 'tokens-avoided' | 'cost-upgrade'
  /** Gross main-context tokens kept out (>= 0); omitted for `cost-upgrade`. */
  tokensAvoided?: number
  /** Tokens the helper model spent (>= 0). */
  helperTokens: number
  /**
   * `tokens-avoided`: avoided * main input price - helper * helper input price; omitted when a price is unknown.
   * `cost-upgrade`: -helper * helper input price (negative); omitted when the helper's price is unknown.
   */
  costUsdEstimate?: number
  note: string
}

export const LEDGER_MAX_LINES = 5000
export const FLUSH_EVERY_MS = 5000

/** True for a ledger line worth keeping: a JSON object (not null, an array or a scalar) with a string `mod`. */
export function isLedgerLine(line: string): boolean {
  if (line.trim() === '') return false
  try {
    const v: unknown = JSON.parse(line)
    return v !== null && typeof v === 'object' && !Array.isArray(v) && typeof (v as { mod?: unknown }).mod === 'string'
  } catch {
    return false
  }
}

/** Parses a ledger file, dropping blank, corrupt and non-object lines, and keeps the newest `max`. */
export const parseLedger = (text: string, max = LEDGER_MAX_LINES): string[] =>
  text.split('\n').filter(isLedgerLine).slice(-max)

/** The session id as a file-name part: every character outside `[A-Za-z0-9_-]` becomes `_`, at most 80. */
export const safeSessionId = (id: string): string => id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80)

/** File name of a session's ledger, or null when there is no session id (the ledger is then off). */
export const ledgerFileName = (session: string): string | null =>
  session === '' ? null : `input-router.${safeSessionId(session)}.jsonl`

/** The current session id, or '' when the engine has none. */
export async function currentSessionId($: EngineInterface): Promise<string> {
  try {
    const id = await $.session.id()
    return typeof id === 'string' ? id : ''
  } catch {
    return ''
  }
}

/**
 * One ledger that follows the session: before each add and each flush it asks the engine for
 * the session id, and when the file name changed (a `/clear`) it writes the old file's pending
 * lines first, then loads the new one. A missing file starts empty; any other read failure
 * turns the ledger off for that session, so history is never overwritten.
 */
export function createLedger($: EngineInterface) {
  let file: string | null = null
  let path: string | null = null
  let lines: string[] = []
  let isDirty = false
  let lastFlushAt = 0
  // add and flush run one at a time, so parallel hand-offs cannot interleave inside a file switch.
  let queue: Promise<unknown> = Promise.resolve()
  function serial<T>(job: () => Promise<T>): Promise<T> {
    const run = queue.then(job)
    queue = run.catch(() => undefined)
    return run
  }

  async function write(): Promise<void> {
    if (path === null || !isDirty) return
    isDirty = false
    try {
      await $.fs.write(path, `${lines.join('\n')}\n`)
    } catch {
      isDirty = true
    }
  }

  /** Points the ledger at the current session's file, writing the previous file's pending lines first. */
  async function follow(session: string): Promise<void> {
    const name = ledgerFileName(session)
    if (name === file) return
    // Best effort: if this write fails, the old session's pending lines are dropped (its file is never wiped).
    await write()
    file = name
    path = null
    lines = []
    isDirty = false
    lastFlushAt = 0
    if (name === null) return
    let home: string | undefined
    try {
      home = await $.env.get('HOME')
    } catch {
      home = undefined
    }
    if (!home) return
    const target = `${home}/.claude/claude-mods/ledger/${name}`
    try {
      lines = parseLedger(await $.fs.read(target))
    } catch {
      let isMissing = false
      try {
        isMissing = (await $.fs.exists(target)) === false
      } catch {
        isMissing = false
      }
      if (!isMissing) return // present but unreadable, or unknown: off for this session, never overwritten
      lines = []
    }
    path = target
  }

  return {
    /** Adds one entry to the current session's file (nothing when the ledger is off). */
    add(entry: Pick<LedgerEntry, 'ts' | 'tokensAvoided' | 'helperTokens' | 'costUsdEstimate' | 'note'> & { kind?: LedgerEntry['kind'] }): Promise<void> {
      return serial(async () => {
        const session = await currentSessionId($)
        await follow(session)
        if (path === null) return
        const full: LedgerEntry = { v: 1, ts: entry.ts, mod: 'input-router', session: safeSessionId(session), kind: entry.kind ?? 'tokens-avoided', ...(entry.tokensAvoided === undefined ? {} : { tokensAvoided: entry.tokensAvoided }), helperTokens: entry.helperTokens, ...(entry.costUsdEstimate === undefined ? {} : { costUsdEstimate: entry.costUsdEstimate }), note: entry.note }
        lines.push(JSON.stringify(full))
        if (lines.length > LEDGER_MAX_LINES) lines = lines.slice(-LEDGER_MAX_LINES)
        isDirty = true
      })
    },
    /**
     * Re-resolves the session (switching files after a `/clear`), then writes when dirty and
     * the last write is FLUSH_EVERY_MS old, or always when forced.
     */
    flush(now: number, isForced = false): Promise<void> {
      return serial(async () => {
        await follow(await currentSessionId($))
        if (path === null || !isDirty) return
        if (!isForced && now - lastFlushAt < FLUSH_EVERY_MS) return
        lastFlushAt = now
        await write()
      })
    },
    isDirty: () => isDirty,
    size: () => lines.length,
    fileName: () => file,
    isOn: () => path !== null,
  }
}
