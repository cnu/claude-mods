import type { EngineInterface } from 'claude-code'

// Writer for ~/.claude/claude-mods/ledger/model-router.<session-id>.jsonl (contract: docs/ledger.md in the repo).
// One file per session, written only by this mod. $.fs has no append, so entries are kept in memory
// and the whole file is written back, batched.

export type LedgerEntry = {
  v: 1
  ts: string
  mod: 'model-router'
  session: string
  kind: 'cost-downgrade' | 'cost-upgrade' | 'info'
  /** Net of the mod's own spend. Negative when the mod cost more than it saved. Absent on `cost-upgrade` lines. */
  tokensAvoided?: number
  /** Tokens the mod itself spent on the classifier call (>= 0), never netted into tokensAvoided. Absent when no classifier call ran. */
  helperTokens?: number
  costUsdEstimate?: number
  note: string
}

export const LEDGER_MAX_LINES = 5000
export const FLUSH_EVERY_MS = 5000

/** True for a line that is a JSON object (not null, an array or a scalar) with a string `mod`. */
const isLedgerLine = (line: string): boolean => {
  try {
    const v: unknown = JSON.parse(line)
    return typeof v === 'object' && v !== null && !Array.isArray(v) && typeof (v as { mod?: unknown }).mod === 'string'
  } catch {
    return false
  }
}

/** Keeps the newest `max` JSON-object lines (with a string `mod`) of a ledger file. */
export const parseLedger = (text: string, max = LEDGER_MAX_LINES): string[] =>
  text
    .split('\n')
    .filter(line => line.trim() !== '' && isLedgerLine(line))
    .slice(-max)

export type Ledger = {
  /** The open file, or null while the ledger is off. */
  path: string | null
  /** The SANITISED session id (the same value as in the file name; '' while off); written into every line. */
  session: string
  /** The raw id last resolved, or null before the first look; a different id means /clear (or a new session). */
  seenId: string | null
  lines: string[]
  isDirty: boolean
  lastFlushAt: number
  /** Serialises every ledger operation, so parallel spawns never race a file switch. */
  chain: Promise<void>
}

export const newLedger = (): Ledger => ({
  path: null,
  session: '',
  seenId: null,
  lines: [],
  isDirty: false,
  lastFlushAt: 0,
  chain: Promise.resolve(),
})

/** The file-name form of a session id: every character outside [A-Za-z0-9_-] becomes `_` (so no dots), at most 80 long. */
export const safeSessionId = (id: string): string => id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80)

async function writeNow($: EngineInterface, l: Ledger): Promise<void> {
  if (l.path === null || !l.isDirty) return
  l.isDirty = false
  try {
    await $.fs.write(l.path, `${l.lines.join('\n')}\n`)
  } catch {
    l.isDirty = true
  }
}

/**
 * Makes the open file the current session's. After /clear the id changes with no session.start: the old
 * file is written first, then the new one is read once. A missing file starts empty; any other read error
 * turns the ledger off for that session (writing would wipe history). No HOME or no session id: off.
 */
async function syncLedger($: EngineInterface, l: Ledger): Promise<void> {
  const home = await $.env.get('HOME')
  const raw: unknown = await $.session.id()
  const id = typeof raw === 'string' ? raw : ''
  const key = `${home ?? ''}\n${id}`
  if (l.seenId === key) return
  await writeNow($, l)
  l.seenId = key
  l.path = null
  l.session = ''
  l.lines = []
  l.isDirty = false
  const safe = safeSessionId(id)
  if (!home || safe === '') return
  const path = `${home}/.claude/claude-mods/ledger/model-router.${safe}.jsonl`
  try {
    l.lines = (await $.fs.exists(path)) ? parseLedger(await $.fs.read(path)) : []
    l.path = path
    l.session = safe
  } catch {
    l.lines = []
  }
}

async function runLedger(
  $: EngineInterface,
  l: Ledger,
  entry: Omit<LedgerEntry, 'v' | 'mod' | 'session'> | null,
  now: number,
  isForced: boolean,
): Promise<void> {
  try {
    await syncLedger($, l)
    if (l.path === null) return
    if (entry !== null) {
      l.lines.push(JSON.stringify({ v: 1, mod: 'model-router', session: l.session, ...entry }))
      if (l.lines.length > LEDGER_MAX_LINES) l.lines = l.lines.slice(-LEDGER_MAX_LINES)
      l.isDirty = true
    }
    if (!l.isDirty) return
    if (!isForced && now - l.lastFlushAt < FLUSH_EVERY_MS) return
    l.lastFlushAt = now
    await writeNow($, l)
  } catch {
    // The ledger is best effort and never affects a spawn.
  }
}

/**
 * Adds an entry (or null to only flush), after re-resolving the session id so a /clear switches files.
 * Writes at most every FLUSH_EVERY_MS unless forced. Never throws; operations run one at a time.
 */
export function ledgerWrite(
  $: EngineInterface,
  l: Ledger,
  entry: Omit<LedgerEntry, 'v' | 'mod' | 'session'> | null,
  now: number,
  isForced = false,
): Promise<void> {
  const task = l.chain.then(() => runLedger($, l, entry, now, isForced))
  l.chain = task
  return task
}
