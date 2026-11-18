import type { EngineInterface } from 'claude-code'

// Writer for ~/.claude/claude-mods/ledger/research-router.<session-id>.jsonl (contract: docs/ledger.md
// in the repo). One file per session, so no other session or mod writes it. $.fs has no append, so
// the session's lines live in memory and the whole file is written back, batched: at most once every
// FLUSH_EVERY_MS while entries arrive, and at `session.end`. No session id (or no HOME) means no ledger.

export const LEDGER_MOD = 'research-router'
export const LEDGER_MAX_LINES = 5000
/** Entries are written back at most this often (the first entry of a session file is written at once). */
export const FLUSH_EVERY_MS = 5000

export type LedgerEntry = {
  v: 1
  ts: string
  mod: typeof LEDGER_MOD
  session: string
  kind: 'tokens-avoided' | 'cost-upgrade' | 'info'
  /** Gross main-context tokens kept out (>= 0). */
  tokensAvoided?: number
  /** Tokens this mod's own helper calls spent (>= 0). */
  helperTokens?: number
  /** Net in USD at list input prices; may be negative; absent when a price is unknown. */
  costUsdEstimate?: number
  note: string
}

export type Ledger = {
  /** The ledger folder, or null when it is off (no HOME). */
  dir: string | null
  /** The (safe) session whose file `lines` holds, or null before the first entry. */
  session: string | null
  /** That session's file, or null when it could not be read (its entries are then dropped). */
  path: string | null
  lines: string[]
  /** Every entry and flush runs after the one before, so reads, writes and session switches never interleave. */
  queue: Promise<void>
  isDirty: boolean
  /** Clock time of the last write attempt for this file, or null when none yet. */
  lastWriteAt: number | null
}

export const newLedger = (): Ledger => ({ dir: null, session: null, path: null, lines: [], queue: Promise.resolve(), isDirty: false, lastWriteAt: null })

/**
 * A session id made safe for a file name: every character outside `[A-Za-z0-9_-]` becomes `_` (so no
 * dots), at most 80. Null when there is no id: the ledger is then off, never a shared file.
 */
export function safeSessionId(id: unknown): string | null {
  if (typeof id !== 'string') return null
  const s = id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80)
  return s === '' ? null : s
}

/** The session's file, or null when there is no usable session id. */
export function ledgerPath(dir: string, session: string): string | null {
  const id = safeSessionId(session)
  return id === null ? null : `${dir}/${LEDGER_MOD}.${id}.jsonl`
}

/** Parses a ledger file, keeping only lines that are JSON objects with a string `mod`, and the newest `max`. */
export function parseLedger(text: string, max = LEDGER_MAX_LINES): string[] {
  return text
    .split('\n')
    .filter(line => {
      if (line.trim() === '') return false
      try {
        const v: unknown = JSON.parse(line)
        return typeof v === 'object' && v !== null && !Array.isArray(v) && typeof (v as { mod?: unknown }).mod === 'string'
      } catch {
        return false
      }
    })
    .slice(-max)
}

/** Finds the ledger folder once. Without HOME the ledger stays off. The file is chosen at the first entry. */
export async function loadLedger($: EngineInterface, ledger: Ledger) {
  try {
    const home = await $.env.get('HOME')
    ledger.dir = home ? `${home}/.claude/claude-mods/ledger` : null
  } catch {
    ledger.dir = null
  }
}

/** The current session's safe id, or null when the engine has none (or fails to say). */
async function currentSession($: EngineInterface): Promise<string | null> {
  try {
    return safeSessionId(await $.session.id())
  } catch {
    return null
  }
}

async function nowOrNull($: EngineInterface): Promise<number | null> {
  try {
    const t = await $.clock.now()
    return Number.isFinite(t) ? t : null
  } catch {
    return null
  }
}

/**
 * Points the ledger at `session`'s file, reading it once so a resumed session keeps its lines. A
 * missing file starts empty. Any other read failure leaves that session's ledger off rather than
 * overwriting what it could not read.
 */
async function openSession($: EngineInterface, ledger: Ledger, session: string) {
  if (ledger.dir === null || ledger.session === session) return
  ledger.session = session
  ledger.path = ledgerPath(ledger.dir, session)
  ledger.isDirty = false
  ledger.lastWriteAt = null
  ledger.lines = []
  if (ledger.path === null) return
  try {
    ledger.lines = (await $.fs.exists(ledger.path)) ? parseLedger(await $.fs.read(ledger.path)) : []
  } catch {
    ledger.lines = []
    ledger.path = null
  }
}

async function write($: EngineInterface, ledger: Ledger, at: number | null) {
  if (ledger.path === null || !ledger.isDirty) return
  ledger.lastWriteAt = at
  try {
    ledger.isDirty = false
    await $.fs.write(ledger.path, `${ledger.lines.join('\n')}\n`)
  } catch {
    // Best effort: kept dirty and tried again at a later entry or flush.
    ledger.isDirty = true
  }
}

/** After /clear the session id changes with no session.start: write the old file, then open the new one. */
async function follow($: EngineInterface, ledger: Ledger, session: string, at: number | null) {
  if (ledger.session === session) return
  await write($, ledger, at)
  await openSession($, ledger, session)
}

async function add($: EngineInterface, ledger: Ledger, entry: Omit<LedgerEntry, 'v' | 'mod' | 'ts' | 'session'>) {
  if (ledger.dir === null) return
  // No session id or no time: the entry is dropped (never filed under a shared name or a made-up date).
  const session = await currentSession($)
  if (session === null) return
  const now = await nowOrNull($)
  if (now === null) return
  await follow($, ledger, session, now)
  if (ledger.path === null) return
  const line: LedgerEntry = { v: 1, ts: new Date(now).toISOString(), mod: LEDGER_MOD, session, ...entry }
  ledger.lines.push(JSON.stringify(line))
  if (ledger.lines.length > LEDGER_MAX_LINES) ledger.lines = ledger.lines.slice(-LEDGER_MAX_LINES)
  ledger.isDirty = true
  if (ledger.lastWriteAt === null || now - ledger.lastWriteAt >= FLUSH_EVERY_MS) await write($, ledger, now)
}

/** Adds one entry to the current session's file (written back in batches), after any entry still in flight. */
export function addEntry($: EngineInterface, ledger: Ledger, entry: Omit<LedgerEntry, 'v' | 'mod' | 'ts' | 'session'>): Promise<void> {
  ledger.queue = ledger.queue.then(() => add($, ledger, entry)).catch(() => {})
  return ledger.queue
}

/** Writes anything still unwritten, after any entry in flight, first re-resolving the session id (/clear). */
export function flushLedger($: EngineInterface, ledger: Ledger): Promise<void> {
  ledger.queue = ledger.queue
    .then(async () => {
      if (ledger.dir === null) return
      const at = await nowOrNull($)
      const session = await currentSession($)
      if (session !== null) await follow($, ledger, session, at)
      await write($, ledger, at)
    })
    .catch(() => {})
  return ledger.queue
}
