import type { EngineInterface } from 'claude-code'

// Writer for ~/.claude/claude-mods/ledger/effort-optimizer.<session-id>.jsonl (contract: docs/ledger.md in the repo).
// $.fs has no append, so entries live in memory and the whole file is written back, batched.

export type LedgerKind = 'tokens-avoided' | 'cost-downgrade' | 'cost-upgrade' | 'cache-kept-warm' | 'handoff' | 'info'

export type LedgerEntry = {
  v: 1
  ts: string
  mod: 'effort-optimizer'
  session: string
  kind: LedgerKind
  tokensAvoided?: number
  /** Tokens this mod itself spent on a helper call (>= 0). */
  helperTokens?: number
  costUsdEstimate?: number
  note: string
}

export const LEDGER_MAX_LINES = 5000
export const FLUSH_EVERY_MS = 5000

/** The file-name form of a session id: every character outside [A-Za-z0-9_-] becomes `_` (no dots), at most 80 long. */
export const sanitizeSessionId = (id: string): string => id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80)

/** True for a line that is a JSON object (not null, an array or a scalar) with a string `mod`. */
const isLedgerLine = (line: string): boolean => {
  try {
    const v: unknown = JSON.parse(line)
    return typeof v === 'object' && v !== null && !Array.isArray(v) && typeof (v as { mod?: unknown }).mod === 'string'
  } catch {
    return false
  }
}

/** Parses a ledger file, keeping only JSON-object lines with a string `mod`, and the newest `max`. */
export const parseLedger = (text: string, max = LEDGER_MAX_LINES): string[] =>
  text
    .split('\n')
    .filter(line => line.trim() !== '' && isLedgerLine(line))
    .slice(-max)

export function createLedger($: EngineInterface) {
  let dir: string | null = null
  /** The raw id of the session the lines belong to; null before the first look. */
  let sessionId: string | null = null
  let path: string | null = null
  let lines: string[] = []
  let isDirty = false
  let lastFlushAt = 0

  const writeNow = async () => {
    if (path === null || !isDirty) return
    isDirty = false
    try {
      await $.fs.write(path, `${lines.join('\n')}\n`)
    } catch {
      isDirty = true
    }
  }

  /** The current session id, or '' when there is none (the ledger is then off). */
  const resolveId = async (): Promise<string> => {
    try {
      const id: unknown = await $.session.id()
      return typeof id === 'string' ? id : ''
    } catch {
      return ''
    }
  }

  /**
   * Makes the open file the current session's. After /clear the id changes with no session.start: the
   * old file is written first, then the new one is read once. A missing file starts empty; any other
   * read error turns the ledger off for that session (never overwrite what could not be read).
   */
  const sync = async () => {
    if (dir === null) return
    const id = await resolveId()
    if (id === sessionId) return
    await writeNow()
    sessionId = id
    path = null
    lines = []
    isDirty = false
    const safe = sanitizeSessionId(id)
    if (safe === '') return
    const next = `${dir}/effort-optimizer.${safe}.jsonl`
    try {
      lines = (await $.fs.exists(next)) ? parseLedger(await $.fs.read(next)) : []
      path = next
    } catch {
      lines = []
    }
  }

  return {
    /** Finds HOME and opens the session's file. Without HOME or a session id the ledger stays off. Never throws. */
    async load() {
      try {
        const home = await $.env.get('HOME')
        dir = home ? `${home}/.claude/claude-mods/ledger` : null
        await sync()
      } catch {
        path = null
      }
    },
    async add(entry: Omit<LedgerEntry, 'v' | 'mod' | 'session'>) {
      try {
        await sync()
        if (path === null || sessionId === null) return
        lines.push(JSON.stringify({ v: 1, mod: 'effort-optimizer', session: sanitizeSessionId(sessionId), ...entry }))
        if (lines.length > LEDGER_MAX_LINES) lines = lines.slice(-LEDGER_MAX_LINES)
        isDirty = true
      } catch {
        // The ledger is best effort.
      }
    },
    async flush(now: number, isForced = false) {
      try {
        await sync()
        if (path === null || !isDirty) return
        if (!isForced && now - lastFlushAt < FLUSH_EVERY_MS) return
        lastFlushAt = now
        await writeNow()
      } catch {
        // The ledger is best effort.
      }
    },
    size: () => lines.length,
  }
}
