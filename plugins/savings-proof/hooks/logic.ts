// Pure aggregation for savings-proof. No engine calls here: everything takes plain values so it
// can be tested directly. Input is the ledger line format in docs/ledger.md (v1); files are
// <mod>.<session-id>.jsonl (or legacy <mod>.jsonl) and the mod always comes from the line.

export const KINDS = ['tokens-avoided', 'cost-downgrade', 'cost-upgrade', 'cache-kept-warm', 'handoff', 'info'] as const
export type Kind = (typeof KINDS)[number]

export type Entry = {
  at: number // ms epoch
  mod: string
  session: string
  kind: Kind
  isInfo: boolean // `info` or an unknown kind: counted as an event, never as savings
  /** GROSS main-context tokens kept out (>= 0). Always 0 for `cost-upgrade` and `info`. */
  avoided: number
  /** Tokens the mod itself spent on helper calls (>= 0). Always 0 for `info`. */
  helper: number
  /** Net dollars, signed (may be negative; `cost-upgrade` is always <= 0). 0 when `hasUsd` is false. */
  usd: number
  /** True when the line carried a finite `costUsdEstimate` (never for `info`). */
  hasUsd: boolean
  note: string
}

/**
 * Three separate numbers, never merged into one token figure (docs/ledger.md): `avoided` and
 * `helper` are sums of non-negative token counts, `usd` the signed sum of `costUsdEstimate` over
 * only the lines that have one. `noUsd` counts the events with no dollar figure (not `info`
 * events, which carry no figures at all).
 */
export type Totals = { events: number; avoided: number; helper: number; usd: number; noUsd: number }
export type ModRow = Totals & { mod: string }
export type RecentRow = { at: number; mod: string; kind: string; avoided: number; helper: number; usd: number; hasUsd: boolean; note: string }

export type Summary = {
  now: number
  sessionId: string
  today: Totals
  session: Totals
  all: Totals
  perMod: ModRow[]
  recent: RecentRow[]
  /** Lines that could not be used (not JSON, not an object, no usable timestamp). */
  skipped: number
  /** Ledger files that could not be read. */
  unreadable: number
  /** Ledger files read (after the age cutoff). */
  files: number
  /** Ledger files skipped because they were last modified before the `ledgerDays` window. */
  oldFiles: number
  /** The window in days that was applied (0 = no limit). */
  ledgerDays: number
}

export const RECENT_COUNT = 10
export const MAX_NOTE = 160

const kinds: readonly string[] = KINDS

/** A finite number (any sign), else undefined. Ledger numbers are optional estimates. */
const finite = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/** A token count: finite and >= 0, else 0. A negative count is malformed (writers log it as cost), never netted. */
const count = (v: unknown): number => {
  const n = finite(v)
  return n !== undefined && n > 0 ? n : 0
}

/** The id as writers put it in file names and `session` fields: chars outside [A-Za-z0-9_-] become `_`, cap 80. */
export const sanitizeSession = (id: string): string => id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80)

const DAY_MS = 86_400_000

/** True when a file last modified at `mtimeMs` is older than the `ledgerDays` window (0 = never). */
export const isOld = (mtimeMs: number, now: number, ledgerDays: number): boolean =>
  ledgerDays > 0 && mtimeMs < now - ledgerDays * DAY_MS

/** `cost-upgrade` is a cost by definition: its dollars are taken as <= 0 whatever sign the writer used. */
const asCost = (kind: Kind, n: number): number => (kind === 'cost-upgrade' ? -Math.abs(n) || 0 : n)

/** One ledger line to an Entry, or null for a line we cannot use. Never throws. */
export function parseLine(line: string): Entry | null {
  if (line.trim() === '') return null
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const at = typeof o.ts === 'string' ? Date.parse(o.ts) : NaN
  if (!Number.isFinite(at)) return null
  const kind = typeof o.kind === 'string' && kinds.includes(o.kind) ? (o.kind as Kind) : 'info'
  const isInfo = kind === 'info'
  const note = typeof o.note === 'string' ? o.note.replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE) : ''
  const usd = isInfo ? undefined : finite(o.costUsdEstimate)
  return {
    at,
    mod: typeof o.mod === 'string' && o.mod.trim() !== '' ? o.mod.trim() : 'unknown',
    session: typeof o.session === 'string' ? o.session : '',
    kind,
    isInfo,
    // `cost-upgrade` counts as cost, never as saving: its tokensAvoided (if any) is ignored.
    avoided: isInfo || kind === 'cost-upgrade' ? 0 : count(o.tokensAvoided),
    helper: isInfo ? 0 : count(o.helperTokens),
    usd: usd === undefined ? 0 : asCost(kind, usd),
    hasUsd: usd !== undefined,
    note,
  }
}

/**
 * One file's text to entries plus the count of lines skipped as unusable (blank lines are not
 * counted). The mod comes from each line's `mod` field, never from the file name. A line that is
 * byte-for-byte identical to an earlier line of the SAME text is dropped silently (a retried
 * write); nothing is ever de-duplicated across files.
 */
export function parseLedgerText(text: string): { entries: Entry[]; skipped: number } {
  const entries: Entry[] = []
  const seen = new Set<string>()
  let skipped = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '' || seen.has(line)) continue
    seen.add(line)
    const e = parseLine(line)
    if (e === null) skipped += 1
    else entries.push(e)
  }
  return { entries, skipped }
}

/** ms epoch of local midnight for `now`. `tzOffsetMin` is `Date#getTimezoneOffset()` (minutes behind UTC). */
export function startOfDay(now: number, tzOffsetMin = new Date(now).getTimezoneOffset()): number {
  const shift = tzOffsetMin * 60_000
  return Math.floor((now - shift) / 86_400_000) * 86_400_000 + shift
}

const empty = (): Totals => ({ events: 0, avoided: 0, helper: 0, usd: 0, noUsd: 0 })
/** Dollars to 6 decimals, never -0: float leftovers (0.1 + 0.2 - 0.3) must not survive a sum. */
export const roundUsd = (n: number): number => Math.round(n * 1e6) / 1e6 + 0

const add = (t: Totals, e: Entry) => {
  t.events += 1
  t.avoided += e.avoided
  t.helper += e.helper
  t.usd = roundUsd(t.usd + e.usd)
  if (!e.hasUsd && !e.isInfo) t.noUsd += 1
}

export type SummarizeInput = {
  entries: readonly Entry[]
  now: number
  sessionId: string
  tzOffsetMin?: number
  skipped?: number
  unreadable?: number
  files?: number
  /** Files skipped by the caller as older than the window. */
  oldFiles?: number
  /** Window in days; 0 or absent = no limit. Lines whose `ts` is older are ignored. */
  ledgerDays?: number
}

/**
 * Today (local day), this chat (a line whose `session` equals the raw OR the sanitised current
 * id; none when the id is empty), all time, one row per mod (all time, most tokens avoided first)
 * and the newest RECENT_COUNT events. The three figures are never merged; dollars are a signed sum.
 * Lines older than `ledgerDays` (by `ts`) are ignored. So is a line dated more than a day ahead
 * of `now` (a bad clock or a typo): it counts in no window. A line dated later the same local day
 * is within that allowance and counts everywhere, today included.
 */
export function summarize(input: SummarizeInput): Summary {
  const { now, sessionId } = input
  const ledgerDays = input.ledgerDays ?? 0
  const cutoff = ledgerDays > 0 ? now - ledgerDays * DAY_MS : Number.NEGATIVE_INFINITY
  const entries = input.entries.filter(e => e.at >= cutoff && e.at <= now + DAY_MS)
  const mine = new Set([sessionId, sanitizeSession(sessionId)])
  const dayStart = startOfDay(now, input.tzOffsetMin)
  const dayEnd = dayStart + 86_400_000
  const today = empty()
  const session = empty()
  const all = empty()
  const byMod = new Map<string, ModRow>()
  for (const e of entries) {
    add(all, e)
    if (e.at >= dayStart && e.at < dayEnd) add(today, e)
    if (sessionId !== '' && mine.has(e.session)) add(session, e)
    let row = byMod.get(e.mod)
    if (row === undefined) {
      row = { mod: e.mod, ...empty() }
      byMod.set(e.mod, row)
    }
    add(row, e)
  }
  const perMod = [...byMod.values()].sort((a, b) => b.avoided - a.avoided || b.usd - a.usd || a.mod.localeCompare(b.mod))
  const recent = [...entries]
    .sort((a, b) => b.at - a.at)
    .slice(0, RECENT_COUNT)
    .map(e => ({ at: e.at, mod: e.mod, kind: e.kind, avoided: e.avoided, helper: e.helper, usd: e.usd, hasUsd: e.hasUsd, note: e.note }))
  return {
    now,
    sessionId,
    today,
    session,
    all,
    perMod,
    recent,
    skipped: input.skipped ?? 0,
    unreadable: input.unreadable ?? 0,
    files: input.files ?? 0,
    oldFiles: input.oldFiles ?? 0,
    ledgerDays,
  }
}

/** True when there is nothing to show: no usable line in any file. */
export const isEmpty = (s: Summary): boolean => s.all.events === 0

/** `950`, `12k`, `1.2k`, `3.4M`. Always rounded: these are estimates. Negatives keep their sign. */
export function formatTokens(n: number): string {
  const r = Math.round(n)
  const v = Math.abs(r)
  const sign = r < 0 ? '-' : ''
  if (v < 1000) return `${sign}${v}`
  if (v < 10_000) return `${sign}${(v / 1000).toFixed(1).replace(/\.0$/, '')}k`
  if (v < 1_000_000) return `${sign}${Math.round(v / 1000)}k`
  return `${sign}${(v / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

const SYMBOLS: Readonly<Record<string, string>> = { USD: '$', EUR: 'EUR ', GBP: 'GBP ', INR: 'INR ', JPY: 'JPY ' }

/** The label for money columns and figures: `$` for USD, else the upper-case code (`INR`). */
export const moneyLabel = (currency: string): string => {
  const code = currency.trim().toUpperCase() || 'USD'
  return code === 'USD' ? '$' : code
}

/** True when a dollar sum is a real, non-zero amount (NaN and float leftovers are not). */
export const hasMoney = (usd: number): boolean => Number.isFinite(usd) && roundUsd(usd) !== 0

/**
 * `~$0.04`, `~INR 3.3`, `-` for a loss (`~-$0.04`): the dollar estimate times `unitsPerUsd`.
 * Exact zero (after rounding to 6 decimals) is `~$0.00`; a non-zero amount under 0.01 is `~<$0.01`
 * (`~-<$0.01` for a tiny loss). `bare` leaves the symbol off (`~3.3`) for a column already labelled.
 */
export function formatMoney(usd: number, currency: string, unitsPerUsd = 1, bare = false): string {
  const code = currency.trim().toUpperCase() || 'USD'
  const rate = Number.isFinite(unitsPerUsd) && unitsPerUsd > 0 ? unitsPerUsd : 1
  const label = bare ? '' : (SYMBOLS[code] ?? `${code} `)
  const base = Number.isFinite(usd) ? roundUsd(usd) : 0
  const value = Math.abs(base) * rate
  if (value === 0) return `~${label}0.00`
  const sign = base < 0 ? '-' : ''
  if (value < 0.01) return `~${sign}<${label}0.01`
  return `~${sign}${label}${value.toFixed(value < 100 ? 2 : 0)}`
}

/**
 * The status line from today's figures: `avoided ~12k, helper ~1.5k, ~$0.03 est. today`. A part
 * that is zero or unknown is left out; undefined when nothing is left (no line beats "0").
 * Dollars are signed (`~-$0.04`) and only include lines that carry a dollar figure.
 */
export function statusText(s: Summary, currency = 'USD', unitsPerUsd = 1): string | undefined {
  const t = s.today
  const parts: string[] = []
  if (Math.round(t.avoided) > 0) parts.push(`avoided ~${formatTokens(t.avoided)}`)
  if (Math.round(t.helper) > 0) parts.push(`helper ~${formatTokens(t.helper)}`)
  if (hasMoney(t.usd)) parts.push(formatMoney(t.usd, currency, unitsPerUsd))
  return parts.length === 0 ? undefined : `${parts.join(', ')} est. today`
}

/** `HH:MM` local, for the recent list. */
export function formatTime(at: number, tzOffsetMin = new Date(at).getTimezoneOffset()): string {
  const d = new Date(at - tzOffsetMin * 60_000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
}

export type Settings = { showStatus: boolean; currency: string; unitsPerUsd: number; ledgerDays: number }

export const LEDGER_DAYS_DEFAULT = 90
export const LEDGER_DAYS_MAX = 3650

/** Options as the engine hands them, with the manifest defaults. */
export const readSettings = (o: Readonly<Record<string, unknown>>): Settings => ({
  showStatus: o.showStatus === true,
  currency: typeof o.currency === 'string' && o.currency.trim() !== '' ? o.currency.trim() : 'USD',
  unitsPerUsd: typeof o.unitsPerUsd === 'number' && o.unitsPerUsd > 0 ? o.unitsPerUsd : 1,
  ledgerDays:
    typeof o.ledgerDays === 'number' && Number.isFinite(o.ledgerDays)
      ? Math.min(LEDGER_DAYS_MAX, Math.max(0, Math.floor(o.ledgerDays)))
      : LEDGER_DAYS_DEFAULT,
})

/** Cheap change detector for the poll: name, size and mtime of every ledger file. */
export const signature = (files: readonly { name: string; size: number; mtimeMs: number }[]): string =>
  files
    .map(f => `${f.name}:${f.size}:${f.mtimeMs}`)
    .sort()
    .join('|')

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isTotals = (v: unknown): v is Totals =>
  isObj(v) && isNum(v.events) && isNum(v.avoided) && isNum(v.helper) && isNum(v.usd) && isNum(v.noUsd)

/** Parses the stored snapshot; null for '' or anything that is not fully Summary-shaped (every figure finite). */
export function parseSnapshot(text: string): Summary | null {
  if (text === '') return null
  try {
    const v: unknown = JSON.parse(text)
    // A snapshot from before the three-number rule lacks fields: decline it rather than draw NaN.
    if (!isObj(v)) return null
    if (!isNum(v.now) || typeof v.sessionId !== 'string') return null
    if (!isNum(v.skipped) || !isNum(v.unreadable) || !isNum(v.files) || !isNum(v.oldFiles) || !isNum(v.ledgerDays)) return null
    if (!isTotals(v.today) || !isTotals(v.session) || !isTotals(v.all)) return null
    if (!Array.isArray(v.perMod) || !v.perMod.every(r => isTotals(r) && typeof (r as { mod?: unknown }).mod === 'string')) return null
    if (
      !Array.isArray(v.recent) ||
      !v.recent.every(
        r =>
          isObj(r) &&
          isNum(r.at) &&
          isNum(r.avoided) &&
          isNum(r.helper) &&
          isNum(r.usd) &&
          typeof r.mod === 'string' &&
          typeof r.kind === 'string' &&
          typeof r.hasUsd === 'boolean' &&
          typeof r.note === 'string',
      )
    )
      return null
    return v as unknown as Summary
  } catch {
    return null
  }
}
