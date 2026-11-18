import type { EngineInterface } from 'claude-code'

import { isMissingFile, sessionFileId } from './logic'

// Writer for ~/.claude/claude-mods/ledger/handoff.<session-id>.jsonl (contract: docs/ledger.md in the repo).
// $.fs has no append, so entries live in memory and the whole file is written back, batched.

export type LedgerKind = 'tokens-avoided' | 'cost-downgrade' | 'cost-upgrade' | 'cache-kept-warm' | 'handoff' | 'info'

export type LedgerEntry = {
  v: 1
  ts: string
  mod: 'handoff'
  session: string
  kind: LedgerKind
  tokensAvoided?: number
  /** Tokens the handoff model call spent (reported usage, else a ceil(chars/4) estimate). */
  helperTokens?: number
  /** Negative: the call's cost in USD, only when the session model's price and the reported usage are both known. */
  costUsdEstimate?: number
  note: string
}

export const LEDGER_MAX_LINES = 5000
export const FLUSH_EVERY_MS = 5000

/** Parses a ledger file: keeps only lines that are JSON objects (not null, arrays or scalars) with a string `mod`, newest `max`. */
export const parseLedger = (text: string, max = LEDGER_MAX_LINES): string[] =>
  text
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

/**
 * Reads a text file for a writer that will write it back whole. Returns '' when the file is not there (an ENOENT, or
 * `$.fs.exists` says no) and null for any other failure, so the caller can skip the write instead of wiping history.
 */
export async function readExisting($: EngineInterface, path: string): Promise<string | null> {
  try {
    return await $.fs.read(path)
  } catch (err) {
    if (isMissingFile(err)) return ''
    try {
      return (await $.fs.exists(path)) ? null : ''
    } catch {
      return null
    }
  }
}

export function createLedger($: EngineInterface) {
  let lines: string[] = []
  let path: string | null = null
  let sessionId = ''
  let isDirty = false
  let lastFlushAt = 0

  async function flush(now: number, isForced = false) {
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

  return {
    /**
     * Points the ledger at this session's file and reads it once. A changed session id (after /clear)
     * first writes the old file out. Without HOME or a usable session id the ledger stays off.
     */
    async use(session: string) {
      const id = sessionFileId(session)
      if (id === sessionId && path !== null) return
      await flush(0, true)
      path = null
      lines = []
      isDirty = false
      sessionId = id
      const home = await $.env.get('HOME')
      if (!home || id === '') return
      path = `${home}/.claude/claude-mods/ledger/handoff.${id}.jsonl`
      // A missing file starts empty. Any other read error turns the ledger off: writing would wipe history.
      const text = await readExisting($, path)
      if (text === null) path = null
      else lines = parseLedger(text)
    },
    add(entry: Omit<LedgerEntry, 'v' | 'mod'>) {
      if (path === null) return
      lines.push(JSON.stringify({ v: 1, mod: 'handoff', ...entry, session: sessionId }))
      if (lines.length > LEDGER_MAX_LINES) lines = lines.slice(-LEDGER_MAX_LINES)
      isDirty = true
    },
    flush,
    size: () => lines.length,
  }
}
