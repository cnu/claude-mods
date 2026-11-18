import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import {
  FALLBACK_TTL_MS,
  formatClock,
  leadMs,
  mergeDetected,
  readSettings,
  remainingMs,
  resolveTtl,
  shouldPing,
  ttlFromLabel,
  ttlFromResume,
} from './logic'
import { ledgerPath, parseLedger, sanitiseSessionId } from './ledger'

const MIN = 60_000
const T0 = 1_700_000_000_000

const BAND = {
  plugin: 'cache-clock',
  component: 'AbovePrompt',
  requestId: 'cache-clock',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

type Rig = {
  clock: ReturnType<typeof mock.clock>
  forks: number
  toasts: string[]
  writes: { path: string; text: string }[]
  sid: string
}

// Everything beneath the plugin: the engine's answers, from memory.
const rig = (
  on: On,
  o: { tokens?: number; commands?: { name: string; plugin?: string }[]; fork?: 'warm' | 'cold' | 'none' | 'error'; files?: Record<string, string>; readError?: boolean } = {},
): Rig => {
  const r: Rig = { clock: mock.clock(on, { now: T0 }), forks: 0, toasts: [], writes: [], sid: 'sess-1' }
  let tokens = o.tokens ?? 200_000
  mock.env(on, { HOME: '/home/t' })
  mock.store(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('classic.SessionStart', () => ({}))
  on('classic.PreModelSwitch', () => ({}))
  on('classic.PostModelSwitch', () => ({}))
  on('session.id', () => ({ value: r.sid }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('session.usage', () => ({
    value: { startedAt: T0, context: { tokens, window: 1_000_000 }, rateLimits: [] },
  }))
  on('model.fork', () => {
    r.forks += 1
    if (o.fork === 'error') {
      return { value: { isAnswered: false, reason: 'api-error', status: 500, error: 'server_error', usage: zero() } }
    }
    // warm: the cache served the prefix. cold: it lapsed and the fork re-wrote it. none: neither happened.
    const usage =
      o.fork === 'cold'
        ? { ...zero(), cache_creation_input_tokens: 190_000, input_tokens: 7, output_tokens: 3 }
        : o.fork === 'none'
          ? zero()
          : { ...zero(), cache_read_input_tokens: 190_000, input_tokens: 7, output_tokens: 3 }
    return { value: { isAnswered: true, text: 'ok', usage } }
  })
  on('command.list', () => ({
    value: (o.commands ?? []).map(c => ({ description: '', source: 'plugin', ...c })),
  }))
  on('ui.toast', (_, e) => {
    r.toasts.push(e.text)
    return { value: undefined }
  })
  on('fs.read', (_, e) => {
    if (o.readError) throw new Error('EACCES: permission denied')
    const text = o.files?.[e.path]
    if (text === undefined) throw new Error('ENOENT: no such file')
    return { value: text }
  })
  on('fs.exists', (_, e) => ({ value: o.readError === true || o.files?.[e.path] !== undefined }))
  on('fs.write', (_, e) => {
    r.writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  return Object.assign(r, { setTokens: (n: number) => (tokens = n) })
}

const zero = () => ({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })

describe('pure countdown logic', () => {
  test('formats and clamps', () => {
    expect(formatClock(42 * MIN + 10_000)).toBe('42:10')
    expect(formatClock(60 * MIN)).toBe('60:00')
    expect(formatClock(1)).toBe('0:01')
    expect(formatClock(0)).toBe('0:00')
    expect(remainingMs(T0, 60 * MIN, T0 + 18 * MIN)).toBe(42 * MIN)
    expect(remainingMs(T0, 60 * MIN, T0 + 61 * MIN)).toBe(0)
    expect(remainingMs(T0, 60 * MIN, T0 - 5 * MIN)).toBe(60 * MIN) // clock ran backwards
  })

  test('defaults match the spec and bad values fall back', () => {
    expect(readSettings({})).toEqual({
      ttlMs: 0, // 0 = detect
      minTokens: 20_000,
      handoffTokens: 150_000,
      maxPings: 6,
      keepWarmDefault: false,
    })
    expect(readSettings({ ttlMinutes: 0, maxPings: -1, minTokens: 'x' }).ttlMs).toBe(0)
    expect(readSettings({ ttlMinutes: -3 }).ttlMs).toBe(0)
    expect(readSettings({ ttlMinutes: 'x' }).ttlMs).toBe(0)
    expect(readSettings({ ttlMinutes: 5 }).ttlMs).toBe(5 * MIN)
    expect(leadMs(5 * MIN)).toBe(30_000)
    expect(leadMs(60 * MIN)).toBe(60_000)
  })

  test('shouldPing only inside the lead window, under the cap', () => {
    const settings = readSettings({ ttlMinutes: 5, maxPings: 2 })
    const base = { ttlMs: 5 * MIN, keepWarm: true, lastAt: T0, tokens: 100_000, pings: 0, failures: 0, isWorking: false, isInFlight: false, settings }
    expect(shouldPing({ ...base, now: T0 + 2 * MIN })).toBe(false)
    expect(shouldPing({ ...base, now: T0 + 4.6 * MIN })).toBe(true)
    expect(shouldPing({ ...base, now: T0 + 5 * MIN })).toBe(false) // already cold
    expect(shouldPing({ ...base, now: T0 + 4.6 * MIN, pings: 2 })).toBe(false)
    expect(shouldPing({ ...base, now: T0 + 4.6 * MIN, keepWarm: false })).toBe(false)
    expect(shouldPing({ ...base, now: T0 + 4.6 * MIN, isWorking: true })).toBe(false)
    expect(shouldPing({ ...base, now: T0 + 4.6 * MIN, tokens: 100 })).toBe(false)
    expect(shouldPing({ ...base, now: T0 + 4.6 * MIN, failures: 2 })).toBe(false)
  })

  test('lifetime: option, then detection, then 5 minutes', () => {
    expect(ttlFromLabel('5m')).toBe(5 * MIN)
    expect(ttlFromLabel('1h')).toBe(60 * MIN)
    expect(ttlFromLabel('2h')).toBeNull()
    expect(ttlFromLabel(undefined)).toBeNull()
    expect(FALLBACK_TTL_MS).toBe(5 * MIN)
    expect(resolveTtl(0, null)).toEqual({ ms: 5 * MIN, source: 'assumed' })
    expect(resolveTtl(0, { ms: 60 * MIN, source: 'model-switch' })).toEqual({ ms: 60 * MIN, source: 'model-switch' })
    expect(resolveTtl(10 * MIN, { ms: 60 * MIN, source: 'model-switch' })).toEqual({ ms: 10 * MIN, source: 'option' })
  })

  test('lifetime inferred from a resume only when the engine verdict is informative', () => {
    expect(ttlFromResume(18 * 60, false)).toBe(60 * MIN) // still warm after 18 min: not the 5m cache
    expect(ttlFromResume(18 * 60, true)).toBe(5 * MIN) // expired inside the hour: the 5m cache
    expect(ttlFromResume(2 * 60, false)).toBeNull() // warm after 2 min fits both
    expect(ttlFromResume(2 * 3600, true)).toBeNull() // expired after 2 h fits both
    expect(ttlFromResume(18 * 60, undefined)).toBeNull()
    expect(ttlFromResume(undefined, true)).toBeNull()
    const a = { ms: 5 * MIN, source: 'resume' } as const
    const b = { ms: 60 * MIN, source: 'model-switch' } as const
    expect(mergeDetected(null, a)).toEqual(a)
    expect(mergeDetected(b, a)).toEqual(b) // a switch reading is not overwritten by a guess
    expect(mergeDetected(a, b)).toEqual(b)
    expect(mergeDetected(a, null)).toEqual(a)
  })

  test('ledger path is per mod and per session', () => {
    expect(ledgerPath('/h', 'abc-1')).toBe('/h/.claude/claude-mods/ledger/cache-clock.abc-1.jsonl')
    // No dots survive, so no leading-dot or `..` tricks.
    expect(ledgerPath('/h', '../x/y')).toBe('/h/.claude/claude-mods/ledger/cache-clock.___x_y.jsonl')
    expect(ledgerPath('/h', 'a.b')).toBe('/h/.claude/claude-mods/ledger/cache-clock.a_b.jsonl')
    const long = ledgerPath('/h', 'x'.repeat(200))
    expect(long).toBe(`/h/.claude/claude-mods/ledger/cache-clock.${'x'.repeat(80)}.jsonl`)
  })

  test('ledger parsing drops junk and caps the length', () => {
    const text = ['{"mod":"a"}', '', 'not json', '{"mod":"b"}', '{"mod":"c"}'].join('\n')
    expect(parseLedger(text)).toEqual(['{"mod":"a"}', '{"mod":"b"}', '{"mod":"c"}'])
    expect(parseLedger(text, 2)).toEqual(['{"mod":"b"}', '{"mod":"c"}'])
  })

  test('ledger parsing keeps only JSON objects with a string mod', () => {
    const text = ['null', '[1]', '3', '"s"', '{"a":1}', '{"mod":5}', '{"mod":"x"}'].join('\n')
    expect(parseLedger(text)).toEqual(['{"mod":"x"}'])
  })
})

const turn = async ($: any, clock: ReturnType<typeof mock.clock>) => {
  await $.turn.start({ text: 'hi', turnId: 't' })
  await $.turn.complete({ answer: 'done', durationMs: 10, isAborted: false, turnId: 't', reason: 'answer' })
  await clock.settle()
}

describe('the band', () => {
  test('counts down, goes cold, and is hidden for small or new chats', { options: { ttlMinutes: 60 }, timeoutMs: 30_000 }, async ($, on) => {
    const r = rig(on)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...BAND, surface })
      // No turn yet: the mod draws nothing, so the engine's own text shows.
      expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
      await ui.unmount()
    }

    await turn($, r.clock)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect((await ui.find({ type: 'Text', text: /cache warm/ }))?.text).toBe('cache warm 60:00')

    await r.clock.advance(17 * MIN + 50_000)
    expect((await ui.find({ type: 'Text', text: /cache warm/ }))?.text).toBe('cache warm 42:10')

    await r.clock.advance(43 * MIN)
    expect((await ui.find({ type: 'Text', text: /cache/ }))?.text).toBe('cache cold')
    await ui.unmount()
  })

  test('hidden below minTokens', async ($, on) => {
    const r = rig(on, { tokens: 5_000 })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await turn($, r.clock)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /cache warm/ })).toBeUndefined()
    expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
    await ui.unmount()
  })

  test('a 5 minute ttl is honoured', { options: { ttlMinutes: 5 } }, async ($, on) => {
    const r = rig(on)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await turn($, r.clock)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await r.clock.advance(MIN)
    expect((await ui.find({ type: 'Text', text: /cache/ }))?.text).toBe('cache warm 4:00')
    await r.clock.advance(4 * MIN)
    expect((await ui.find({ type: 'Text', text: /cache/ }))?.text).toBe('cache cold')
    await ui.unmount()
  })
})

describe('keep warm', () => {
  test('does nothing while off, even as the cache lapses', { timeoutMs: 30_000 }, async ($, on) => {
    const r = rig(on)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await turn($, r.clock)
    await r.clock.advance(90 * MIN)
    expect(r.forks).toBe(0)
  })

  test('pings before expiry, resets the clock, stops at maxPings, logs each ping',
    { options: { ttlMinutes: 5, maxPings: 2 }, timeoutMs: 20_000 }, async ($, on) => {
    const r = rig(on)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await turn($, r.clock)

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect((await ui.find({ key: 'keep-warm' }))?.text).toBe('Keep warm: off')
    await ui.press({ key: 'keep-warm' })
    expect((await ui.find({ key: 'keep-warm' }))?.text).toBe('Keep warm: on (0/2)')

    // The lead for a 5 minute ttl is 30 s: nothing at 4:00, one ping once 4:30 is passed.
    await r.clock.advance(4 * MIN)
    expect(r.forks).toBe(0)
    await r.clock.advance(40_000)
    expect(r.forks).toBe(1)
    // The ping reset the clock: a minute later the cache still shows warm.
    await r.clock.advance(MIN)
    expect((await ui.find({ type: 'Text', text: /cache/ }))?.text).toMatch(/^cache warm [34]:\d\d$/)

    // Idle for a long time: the cap of 2 holds, then the cache goes cold.
    await r.clock.advance(30 * MIN)
    expect(r.forks).toBe(2)
    expect((await ui.find({ key: 'keep-warm' }))?.text).toBe('Keep warm: on (2/2)')
    expect((await ui.find({ type: 'Text', text: /cache/ }))?.text).toBe('cache cold')

    await $.session.end({ reason: 'other', sessionId: 'sess-1', resume: { id: 'sess-1' } })
    const w = r.writes.at(-1)
    expect(w?.path).toBe('/home/t/.claude/claude-mods/ledger/cache-clock.sess-1.jsonl')
    const rows = (w?.text ?? '').trim().split('\n').map(l => JSON.parse(l))
    expect(rows.length).toBe(2)
    expect(rows[0]).toMatchObject({ v: 1, mod: 'cache-clock', kind: 'cache-kept-warm', session: 'sess-1' })
    expect(typeof rows[0].ts).toBe('string')
    // Honest numbers: a ping costs tokens and the API reports no price, so no row claims a saving.
    for (const row of rows) {
      expect('tokensAvoided' in row).toBe(false)
      expect('costUsdEstimate' in row).toBe(false)
    }
    // helperTokens: the ping's own usage, all four counts (190000 read + 7 input + 3 output).
    for (const row of rows) expect(row.helperTokens).toBe(190_010)
    expect(rows[0].note).toMatch(/ping 1 of this idle stretch re-read 190000 cached tokens/)
    expect(rows[1].note).toMatch(/ping 2 of this idle stretch/)
    await ui.unmount()
  })

  test('a new turn starts a new idle stretch with a fresh ping count',
    { options: { ttlMinutes: 5, maxPings: 1 }, timeoutMs: 20_000 }, async ($, on) => {
    const r = rig(on)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await turn($, r.clock)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await ui.press({ key: 'keep-warm' })
    await r.clock.advance(30 * MIN)
    expect(r.forks).toBe(1)
    await turn($, r.clock)
    await r.clock.advance(5 * MIN)
    expect(r.forks).toBe(2)
    await ui.unmount()
  })

  test('no ping while a turn is running', { options: { ttlMinutes: 5 } }, async ($, on) => {
    const r = rig(on)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await turn($, r.clock)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await ui.press({ key: 'keep-warm' })
    await $.turn.start({ text: 'again', turnId: 't2' })
    await r.clock.advance(4 * MIN + 45_000)
    expect(r.forks).toBe(0)
    await ui.unmount()
  })

  test('two failed pings switch keep warm off', { timeoutMs: 30_000 }, async ($, on) => {
    const r = rig(on, { fork: 'error' })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await turn($, r.clock)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await ui.press({ key: 'keep-warm' })
    await r.clock.advance(59 * MIN + 5_000)
    await r.clock.advance(5_000)
    expect(r.forks).toBe(2)
    expect((await ui.find({ key: 'keep-warm' }))?.text).toBe('Keep warm: off')
    expect(r.toasts.some(t => /switched off/.test(t))).toBe(true)
    await ui.unmount()
  })

  test('a ping that finds the cache cold says so once and logs no tokens avoided', { timeoutMs: 30_000 }, async ($, on) => {
    const r = rig(on, { fork: 'cold' })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await turn($, r.clock)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await ui.press({ key: 'keep-warm' })
    await r.clock.advance(59 * MIN + 10_000)
    expect(r.toasts.filter(t => /already cold/.test(t)).length).toBe(1)
    await $.session.end({ reason: 'other', sessionId: 'sess-1', resume: { id: 'sess-1' } })
    const row = JSON.parse((r.writes.at(-1)?.text ?? '').trim().split('\n')[0] ?? '{}')
    expect('tokensAvoided' in row).toBe(false)
    expect(row.note).toMatch(/already cold/)
    expect(row.helperTokens).toBe(190_010) // 190000 written + 7 input + 3 output
    expect('costUsdEstimate' in row).toBe(false)
    await ui.unmount()
  })
  test('a ping that neither reads nor writes cache does not reset the clock', { options: { ttlMinutes: 5 } }, async ($, on) => {
    const r = rig(on, { fork: 'none' })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await turn($, r.clock)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await ui.press({ key: 'keep-warm' })
    await r.clock.advance(4 * MIN + 40_000)
    expect(r.forks).toBeGreaterThan(0)
    await r.clock.advance(MIN)
    expect((await ui.find({ type: 'Text', text: /cache/ }))?.text).toBe('cache cold')
    await ui.unmount()
  })

  test('a resumed session starts the clock from the age the engine reports', { options: { ttlMinutes: 60 } }, async ($, on) => {
    const r = rig(on)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 18 * 60, context_tokens: 120_000 })
    await r.clock.settle()
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect((await ui.find({ type: 'Text', text: /cache/ }))?.text).toBe('cache warm 42:00')
    await ui.unmount()
  })
})

const LEDGER_DIR = '/home/t/.claude/claude-mods/ledger/'
const keepWarmOnce = async ($: any, r: Rig, ui: any) => {
  await ui.press({ key: 'keep-warm' })
  await r.clock.advance(4 * MIN + 40_000)
}

describe('ledger rules', () => {
  const o = { options: { ttlMinutes: 5 }, timeoutMs: 20_000 }

  test('a missing file starts empty and is written', o, async ($, on) => {
    const r = rig(on)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await turn($, r.clock)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await keepWarmOnce($, r, ui)
    await $.session.end({ reason: 'other', sessionId: 'sess-1', resume: { id: 'sess-1' } })
    expect(r.writes.at(-1)?.path).toBe(`${LEDGER_DIR}cache-clock.sess-1.jsonl`)
    await ui.unmount()
  })

  test('a read error that is not "missing" turns the ledger off and never overwrites', o, async ($, on) => {
    const r = rig(on, { readError: true })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await turn($, r.clock)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await keepWarmOnce($, r, ui)
    expect(r.forks).toBe(1)
    await $.session.end({ reason: 'other', sessionId: 'sess-1', resume: { id: 'sess-1' } })
    expect(r.writes.length).toBe(0)
    await ui.unmount()
  })

  test('no session id means the ledger is off', o, async ($, on) => {
    const r = rig(on)
    r.sid = ''
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await turn($, r.clock)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await keepWarmOnce($, r, ui)
    expect(r.forks).toBe(1)
    await $.session.end({ reason: 'other', sessionId: '', resume: { id: '' } })
    expect(r.writes.length).toBe(0)
    await ui.unmount()
  })

  test('existing history is kept; null and non-object lines are dropped', o, async ($, on) => {
    const file = `${LEDGER_DIR}cache-clock.sess-1.jsonl`
    const r = rig(on, { files: { [file]: ['null', '{"mod":"cache-clock","note":"old"}', '[1]'].join('\n') } })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await turn($, r.clock)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await keepWarmOnce($, r, ui)
    await $.session.end({ reason: 'other', sessionId: 'sess-1', resume: { id: 'sess-1' } })
    const rows = (r.writes.at(-1)?.text ?? '').trim().split('\n').map(l => JSON.parse(l))
    expect(rows.length).toBe(2)
    expect(rows[0].note).toBe('old')
    await ui.unmount()
  })

  test('/clear: the old file is written first, later lines go to the new session file', o, async ($, on) => {
    const r = rig(on)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await turn($, r.clock)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await keepWarmOnce($, r, ui)
    expect(r.forks).toBe(1)
    r.sid = 'sess-2'
    await $.session.end({ reason: 'clear', sessionId: 'sess-1', resume: { id: 'sess-1' } })
    const first = r.writes.at(-1)
    expect(first?.path).toBe(`${LEDGER_DIR}cache-clock.sess-1.jsonl`)
    expect(JSON.parse((first?.text ?? '').trim().split('\n')[0] ?? '{}').session).toBe('sess-1')
    await turn($, r.clock)
    await r.clock.advance(4 * MIN + 40_000)
    await $.session.end({ reason: 'other', sessionId: 'sess-2', resume: { id: 'sess-2' } })
    const last = r.writes.at(-1)
    expect(last?.path).toBe(`${LEDGER_DIR}cache-clock.sess-2.jsonl`)
    expect(JSON.parse((last?.text ?? '').trim().split('\n')[0] ?? '{}').session).toBe('sess-2')
    await ui.unmount()
  })
})

const SWITCH = {
  from_model: 'a',
  to_model: 'b',
  requested_model: 'b',
  source: 'command',
  context_tokens: 100_000,
  prompt_cache_warm: true,
  estimated_cache_write_usd: 1,
  pricing: 'default',
} as const

const shown = async (ui: any) => (await ui.find({ type: 'Text', text: /cache/ }))?.text

describe('cache lifetime', () => {
  test('nothing detected: assumes 5 minutes', async ($, on) => {
    const r = rig(on)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await turn($, r.clock)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await shown(ui)).toBe('cache warm 5:00')
    await r.clock.advance(5 * MIN)
    expect(await shown(ui)).toBe('cache cold')
    await ui.unmount()
  })

  test('a model switch that states cache_ttl 1h sets a 60 minute clock', async ($, on) => {
    const r = rig(on)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.classic.PostModelSwitch({ ...SWITCH, cache_ttl: '1h' })
    await turn($, r.clock)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await shown(ui)).toBe('cache warm 60:00')
    await r.clock.advance(6 * MIN)
    expect(await shown(ui)).toBe('cache warm 54:00')
    await ui.unmount()
  })

  test('the pre-switch input counts too, and 5m reads as 5 minutes', async ($, on) => {
    const r = rig(on)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.classic.PreModelSwitch({ ...SWITCH, cache_ttl: '1h' })
    await turn($, r.clock)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await shown(ui)).toBe('cache warm 60:00')
    await $.classic.PreModelSwitch({ ...SWITCH, cache_ttl: '5m' })
    await r.clock.advance(MIN)
    expect(await shown(ui)).toBe('cache warm 4:00')
    await ui.unmount()
  })

  test('an unknown cache_ttl is ignored', async ($, on) => {
    const r = rig(on)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.classic.PostModelSwitch({ ...SWITCH, cache_ttl: '24h' as never })
    await turn($, r.clock)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await shown(ui)).toBe('cache warm 5:00')
    await ui.unmount()
  })

  test('ttlMinutes overrides what was detected', { options: { ttlMinutes: 10 } }, async ($, on) => {
    const r = rig(on)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.classic.PostModelSwitch({ ...SWITCH, cache_ttl: '1h' })
    await turn($, r.clock)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await shown(ui)).toBe('cache warm 10:00')
    await ui.unmount()
  })

  test('a resume the engine calls still warm after 18 minutes means the 1h cache', async ($, on) => {
    const r = rig(on)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.classic.SessionStart({
      source: 'resume', seconds_since_last_response: 18 * 60, context_tokens: 120_000, prompt_cache_likely_expired: false,
    })
    await r.clock.settle()
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await shown(ui)).toBe('cache warm 42:00')
    await ui.unmount()
  })

  test('a resume the engine calls expired inside the hour means the 5m cache', async ($, on) => {
    const r = rig(on)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.classic.SessionStart({
      source: 'resume', seconds_since_last_response: 18 * 60, context_tokens: 120_000, prompt_cache_likely_expired: true,
    })
    await r.clock.settle()
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await shown(ui)).toBe('cache cold')
    await ui.unmount()
  })

  test('a resume with no verdict falls back to 5 minutes; a switch reading beats a resume guess', async ($, on) => {
    const r = rig(on)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 2 * 60, context_tokens: 120_000 })
    await r.clock.settle()
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await shown(ui)).toBe('cache warm 3:00')
    await $.classic.PostModelSwitch({ ...SWITCH, cache_ttl: '1h' })
    await $.classic.SessionStart({
      source: 'resume', seconds_since_last_response: 18 * 60, context_tokens: 120_000, prompt_cache_likely_expired: true,
    })
    await r.clock.settle()
    expect(await shown(ui)).toBe('cache warm 42:00')
    await ui.unmount()
  })

  test('the ledger file is per session and each line names the mod', { options: { ttlMinutes: 5 } }, async ($, on) => {
    const r = rig(on)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await turn($, r.clock)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await ui.press({ key: 'keep-warm' })
    await r.clock.advance(4 * MIN + 40_000)
    await $.session.end({ reason: 'other', sessionId: 'sess-1', resume: { id: 'sess-1' } })
    const w = r.writes.at(-1)
    expect(w?.path).toBe('/home/t/.claude/claude-mods/ledger/cache-clock.sess-1.jsonl')
    for (const l of (w?.text ?? '').trim().split('\n')) expect(JSON.parse(l)).toMatchObject({ mod: 'cache-clock', session: 'sess-1' })
    await ui.unmount()
  })

  test('a hostile session id gives line.session equal to the file-name id', { options: { ttlMinutes: 5 } }, async ($, on) => {
    const hostile = '../a b/é.c'
    const r = rig(on)
    r.sid = hostile
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await turn($, r.clock)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await ui.press({ key: 'keep-warm' })
    await r.clock.advance(4 * MIN + 40_000)
    await $.session.end({ reason: 'other', sessionId: hostile, resume: { id: hostile } })
    const w = r.writes.at(-1)
    const fileId = (w?.path ?? '').match(/cache-clock\.(.*)\.jsonl$/)?.[1]
    expect(fileId).toBe(sanitiseSessionId(hostile))
    expect(fileId).toBe('___a_b___c')
    const lines = (w?.text ?? '').trim().split('\n')
    expect(lines.length).toBeGreaterThan(0)
    for (const l of lines) expect(JSON.parse(l).session).toBe(fileId)
    await ui.unmount()
  })
})

describe('ledger across /clear', () => {
  test('a new session id after /clear writes to its own file', { options: { ttlMinutes: 5 }, timeoutMs: 20_000 }, async ($, on) => {
    const r = rig(on)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await turn($, r.clock)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await ui.press({ key: 'keep-warm' })
    await r.clock.advance(4 * MIN + 40_000)
    await $.session.end({ reason: 'clear', sessionId: 'sess-1', resume: { id: 'sess-1' } })
    r.sid = 'sess-2'
    await turn($, r.clock)
    await r.clock.advance(4 * MIN + 40_000)
    await $.session.end({ reason: 'other', sessionId: 'sess-2', resume: { id: 'sess-2' } })
    const byPath = (p: string) => r.writes.filter(w => w.path.endsWith(p)).at(-1)?.text ?? ''
    const one = byPath('cache-clock.sess-1.jsonl').trim().split('\n').filter(Boolean)
    const two = byPath('cache-clock.sess-2.jsonl').trim().split('\n').filter(Boolean)
    expect(one.length).toBeGreaterThan(0)
    expect(two.length).toBeGreaterThan(0)
    for (const l of one) expect(JSON.parse(l).session).toBe('sess-1')
    for (const l of two) expect(JSON.parse(l).session).toBe('sess-2')
    await ui.unmount()
  })
})

describe('handoff offer', () => {
  test('cold and big, with a handoff command: the band names it, no toast', { timeoutMs: 30_000 }, async ($, on) => {
    const r = rig(on, { commands: [{ name: 'refresh', plugin: 'handoff' }] })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await turn($, r.clock)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await r.clock.advance(61 * MIN)
    expect((await ui.find({ type: 'Text', text: /handoff/ }))?.text).toContain('(/refresh)')
    expect(r.toasts.length).toBe(0)
    await ui.unmount()
  })

  test('cold and big, no command: one toast', { timeoutMs: 30_000 }, async ($, on) => {
    const r = rig(on)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await turn($, r.clock)
    await r.clock.advance(125 * MIN)
    expect(r.toasts.filter(t => /handoff/.test(t)).length).toBe(1)
  })

  test('cold but under handoffTokens: no offer', { timeoutMs: 30_000 }, async ($, on) => {
    const r = rig(on, { tokens: 50_000 })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await turn($, r.clock)
    await r.clock.advance(125 * MIN)
    expect(r.toasts.length).toBe(0)
  })
})
