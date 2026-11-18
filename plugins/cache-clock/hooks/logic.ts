// Pure helpers: no engine calls, so tests and the hooks share one source of truth.

export type Settings = {
  /** The user's override in ms; 0 means detect the lifetime (see resolveTtl). */
  ttlMs: number
  minTokens: number
  handoffTokens: number
  maxPings: number
  keepWarmDefault: boolean
}

export const MAX_PING_FAILURES = 2

const MIN_MS = 60_000
/** The short cache lifetime: assumed whenever nothing says otherwise (the safe, short guess). */
export const FALLBACK_TTL_MS = 5 * MIN_MS
const LONG_TTL_MS = 60 * MIN_MS

export type TtlSource = 'option' | 'model-switch' | 'resume' | 'assumed'

/** The `cache_ttl` label the model-switch hook inputs carry, as ms; null for anything else. */
export const ttlFromLabel = (label: unknown): number | null =>
  label === '5m' ? FALLBACK_TTL_MS : label === '1h' ? LONG_TTL_MS : null

/**
 * A lifetime inferred from a resume's `seconds_since_last_response` and the engine's own
 * `prompt_cache_likely_expired` verdict. Only 5m and 1h exist, so: still warm after more than 5
 * minutes means 1h; judged expired inside the hour means 5m. Anything else says nothing.
 */
export const ttlFromResume = (secondsSince: unknown, isExpired: unknown): number | null => {
  if (typeof secondsSince !== 'number' || !Number.isFinite(secondsSince) || typeof isExpired !== 'boolean') return null
  if (!isExpired && secondsSince * 1000 > FALLBACK_TTL_MS) return LONG_TTL_MS
  if (isExpired && secondsSince >= 0 && secondsSince * 1000 <= LONG_TTL_MS) return FALLBACK_TTL_MS
  return null
}

/** The lifetime in force: the option when set, else what was detected, else 5 minutes. */
export const resolveTtl = (
  override: number,
  detected: { ms: number; source: 'model-switch' | 'resume' } | null,
): { ms: number; source: TtlSource } =>
  override > 0
    ? { ms: override, source: 'option' }
    : detected !== null
      ? detected
      : { ms: FALLBACK_TTL_MS, source: 'assumed' }

/** A model-switch reading always wins; a resume inference only fills a gap. */
export const mergeDetected = (
  current: { ms: number; source: 'model-switch' | 'resume' } | null,
  next: { ms: number; source: 'model-switch' | 'resume' } | null,
): { ms: number; source: 'model-switch' | 'resume' } | null =>
  next === null ? current : current !== null && current.source === 'model-switch' && next.source === 'resume' ? current : next

const num = (v: unknown, fallback: number, min: number): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= min ? v : fallback

/** Options as the engine hands them (numbers when set, absent when not), with the spec's defaults. */
export const readSettings = (o: Readonly<Record<string, unknown>>): Settings => ({
  ttlMs: num(o.ttlMinutes, 0, 0) * MIN_MS,
  minTokens: num(o.minTokens, 20_000, 0),
  handoffTokens: num(o.handoffTokens, 150_000, 0),
  maxPings: Math.floor(num(o.maxPings, 6, 0)),
  keepWarmDefault: o.keepWarmDefault === true,
})

/** Milliseconds of warm cache left; 0 once cold. Infinity-safe: a clock that ran backwards reads as a full ttl. */
export const remainingMs = (lastAt: number, ttlMs: number, now: number): number =>
  Math.max(0, Math.min(ttlMs, lastAt + ttlMs - now))

/** `m:ss`, rounding up so the band never shows 0:00 while the cache is still warm. */
export const formatClock = (ms: number): string => {
  const total = Math.ceil(Math.max(0, ms) / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${s < 10 ? '0' : ''}${s}`
}

/** The band shows after the first turn, once the chat is big enough to matter. */
export const isBandVisible = (lastAt: number | null, tokens: number, minTokens: number): boolean =>
  lastAt !== null && tokens >= minTokens

/** How long before expiry a ping goes out: a tenth of the ttl, between 15 s and 60 s. */
export const leadMs = (ttlMs: number): number => Math.min(60_000, Math.max(15_000, ttlMs / 10))

export type PingInput = {
  /** The lifetime in force, from resolveTtl. */
  ttlMs: number
  keepWarm: boolean
  lastAt: number | null
  tokens: number
  pings: number
  failures: number
  isWorking: boolean
  isInFlight: boolean
  now: number
  settings: Settings
}

/** Ping only while the cache is still warm and about to lapse: a ping into a cold cache pays the full write. */
export const shouldPing = (i: PingInput): boolean => {
  if (!i.keepWarm || i.lastAt === null || i.isWorking || i.isInFlight) return false
  if (i.pings >= i.settings.maxPings || i.failures >= MAX_PING_FAILURES) return false
  if (i.tokens < i.settings.minTokens) return false
  const left = remainingMs(i.lastAt, i.ttlMs, i.now)
  return left > 0 && left <= leadMs(i.ttlMs)
}

export const shouldOfferHandoff = (
  lastAt: number | null,
  tokens: number,
  now: number,
  ttlMs: number,
  s: Settings,
): boolean => lastAt !== null && remainingMs(lastAt, ttlMs, now) === 0 && tokens >= s.handoffTokens

/** Token estimate when no count is at hand, per docs/ledger.md. */
export const estimateTokens = (chars: number): number => Math.ceil(chars / 4)

export const isRefresh = (name: string): boolean => name === 'refresh' || name.endsWith(':refresh')

/** The handoff mod's command (its spec names it /refresh): anything its plugin registered, or one named handoff. */
export const isHandoffCommand = (c: { name: string; plugin?: string }): boolean =>
  c.plugin === 'handoff' || c.name === 'handoff'

/** Seconds-since-last-response and context size as a resume reports them, to ms epoch and tokens. */
export const seedFromResume = (
  now: number,
  secondsSince: number | undefined,
  contextTokens: number | undefined,
): { lastAt: number; tokens: number } | null =>
  secondsSince === undefined || contextTokens === undefined || secondsSince < 0
    ? null
    : { lastAt: now - secondsSince * 1000, tokens: contextTokens }
