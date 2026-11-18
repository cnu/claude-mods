import type { EngineInterface } from 'claude-code'

// Writer for ~/.claude/claude-mods/ledger/cache-clock.<session-id>.jsonl (contract: docs/ledger.md in the repo).
// $.fs has no append, so entries live in memory and the whole file is written back, batched.

export type LedgerKind = 'tokens-avoided' | 'cost-downgrade' | 'cost-upgrade' | 'cache-kept-warm' | 'handoff' | 'info'

export type LedgerEntry = {
  v: 1
  ts: string
  mod: 'cache-clock'
  session: string
  kind: LedgerKind
  tokensAvoided?: number
  /** Tokens the mod itself spent (a keep-warm ping: cache read + cache write + input + output), >= 0. Never netted into tokensAvoided. */
  helperTokens?: number
  costUsdEstimate?: number
  note: string
}

/** Longest session id part of a file name (docs/ledger.md). */
export const SESSION_FILE_MAX = 80

/** This mod's file for one session. Every character outside [A-Za-z0-9_-] becomes `_` (so no dots), capped at 80. */
export const sanitiseSessionId = (sessionId: string): string => sessionId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, SESSION_FILE_MAX)

export const ledgerPath = (home: string, sessionId: string): string =>
  `${home}/.claude/claude-mods/ledger/cache-clock.${sanitiseSessionId(sessionId)}.jsonl`

export const LEDGER_MAX_LINES = 5000
export const FLUSH_EVERY_MS = 5000

/** True for a JSON object (not null, an array or a scalar) with a string `mod`. */
const isLedgerLine = (line: string): boolean => {
  try {
    const v: unknown = JSON.parse(line)
    return typeof v === 'object' && v !== null && !Array.isArray(v) && typeof (v as { mod?: unknown }).mod === 'string'
  } catch {
    return false
  }
}

/** Parses a ledger file, dropping blank, corrupt or non-object lines, and keeps the newest `max`. */
export const parseLedger = (text: string, max = LEDGER_MAX_LINES): string[] =>
  text
    .split('\n')
    .filter(line => line.trim() !== '' && isLedgerLine(line))
    .slice(-max)

export function createLedger($: EngineInterface) {
  let lines: string[] = []
  let path: string | null = null
  let sessionId: string | null = null
  let isDirty = false
  let lastFlushAt = 0

  /**
   * Reads this session's file once. Without HOME or a session id the ledger is off. A missing file
   * starts empty; any other read error turns the ledger off, so history is never overwritten.
   */
  async function load(id: string | null) {
    sessionId = id
    path = null
    lines = []
    isDirty = false
    const home = await $.env.get('HOME').catch(() => undefined)
    if (!home || !id) return
    const file = ledgerPath(home, id)
    try {
      const text = await $.fs.read(file)
      if (typeof text !== 'string') return
      lines = parseLedger(text)
    } catch {
      const isMissing = await $.fs.exists(file).then(yes => !yes, () => false)
      if (!isMissing) return
    }
    path = file
  }

  async function write(now: number, isForced: boolean) {
    if (path === null || !isDirty) return
    if (!isForced && now - lastFlushAt < FLUSH_EVERY_MS) return
    lastFlushAt = now
    isDirty = false
    try {
      await $.fs.write(path, `${lines.join('\n')}\n`)
    } catch {
      isDirty = true
    }
  }

  /** The caller already holds the current id (a ping): switch files if it is new, old file written first. */
  async function use(id: string, now: number) {
    if (id === sessionId) return
    await write(now, true)
    await load(id)
  }

  return {
    load,
    use,
    add(entry: Omit<LedgerEntry, 'v' | 'mod'>) {
      if (path === null) return
      // `session` is always the sanitised id of the file this line is written to (docs/ledger.md), whatever the caller passed.
      lines.push(JSON.stringify({ v: 1, ...entry, mod: 'cache-clock', session: sanitiseSessionId(sessionId ?? entry.session) }))
      if (lines.length > LEDGER_MAX_LINES) lines = lines.slice(-LEDGER_MAX_LINES)
      isDirty = true
    },
    /** Re-resolves the session id first (/clear gives a new one and no session.start), then writes. */
    async flush(now: number, isForced = false) {
      if (!isDirty || (!isForced && now - lastFlushAt < FLUSH_EVERY_MS)) return
      const id = await $.session.id().then(v => v, () => sessionId)
      if (id !== sessionId) {
        await write(now, true)
        await load(id || null)
        return
      }
      await write(now, isForced)
    },
    size: () => lines.length,
  }
}
