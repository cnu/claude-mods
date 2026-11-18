import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import {
  formatMoney,
  formatTokens,
  isOld,
  parseLedgerText,
  parseLine,
  parseSnapshot,
  readSettings,
  roundUsd,
  sanitizeSession,
  signature,
  startOfDay,
  statusText,
  summarize,
} from './logic'

const T0 = Date.parse('2026-11-17T12:00:00.000Z')
const UTC = 0 // tz offset used by the pure tests, so they do not depend on the machine's zone

const line = (o: Record<string, unknown>) =>
  JSON.stringify({ v: 1, ts: '2026-11-17T10:00:00.000Z', mod: 'a', session: 's1', kind: 'tokens-avoided', note: 'n', ...o })

const PANE = {
  plugin: 'savings-proof',
  component: 'Pane',
  requestId: 'savings',
  props: {
    title: 'Savings (estimated)',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

describe('parsing', () => {
  test('a good line parses: three separate numbers, only finite ones count', () => {
    const e = parseLine(line({ tokensAvoided: 1200, helperTokens: 300, costUsdEstimate: 0.5 }))
    expect(e).toMatchObject({ avoided: 1200, helper: 300, usd: 0.5, hasUsd: true, mod: 'a' })
    // dollars may be negative; token counts may not (a negative count is malformed: 0, never netted)
    const neg = parseLine(line({ tokensAvoided: -5, helperTokens: -7, costUsdEstimate: -0.25 }))
    expect(neg).toMatchObject({ avoided: 0, helper: 0, usd: -0.25, hasUsd: true })
    const bad = parseLine(line({ tokensAvoided: Number.NaN, helperTokens: '9', costUsdEstimate: 'x' }))
    expect(bad).toMatchObject({ avoided: 0, helper: 0, usd: 0, hasUsd: false })
    expect(parseLine(line({ tokensAvoided: null }))).toMatchObject({ avoided: 0, hasUsd: false })
  })

  test('a legacy line without helperTokens has helper 0; a line with only costUsdEstimate keeps its dollars', () => {
    expect(parseLine(line({ tokensAvoided: 900 }))).toMatchObject({ avoided: 900, helper: 0, usd: 0, hasUsd: false })
    expect(parseLine(line({ kind: 'cost-downgrade', costUsdEstimate: 0.12 }))).toMatchObject({ avoided: 0, helper: 0, usd: 0.12, hasUsd: true })
    expect(parseLine(line({ kind: 'cost-downgrade', costUsdEstimate: -0.01 }))).toMatchObject({ usd: -0.01, hasUsd: true })
    expect(parseLine(line({ costUsdEstimate: 0 }))).toMatchObject({ usd: 0, hasUsd: true }) // a real zero is a figure
  })

  test('corrupt, blank, non-object and undated lines are skipped, never thrown', () => {
    const text = [
      line({ tokensAvoided: 100 }),
      '',
      '{not json',
      '[1,2]',
      '"str"',
      'null',
      JSON.stringify({ ts: 'yesterday-ish', kind: 'info' }),
      JSON.stringify({ kind: 'info' }),
      line({ tokensAvoided: 50 }),
      '{"ts":"2026-11-17T10:00:00Z"', // truncated write
    ].join('\n')
    const r = parseLedgerText(text)
    expect(r.entries.length).toBe(2)
    expect(r.skipped).toBe(7)
  })

  test('only exact identical lines within one text are dropped', () => {
    const a = line({ tokensAvoided: 10 })
    const r = parseLedgerText([a, a, line({ tokensAvoided: 10, note: 'other' }), a, '{bad', '{bad'].join('\n'))
    expect(r.entries.length).toBe(2)
    expect(r.skipped).toBe(1)
    // the same line in two texts (two files) is kept both times
    expect(parseLedgerText(a).entries.length + parseLedgerText(a).entries.length).toBe(2)
  })

  test('info and unknown kinds count as events but never as savings', () => {
    expect(parseLine(line({ kind: 'info', tokensAvoided: 999, helperTokens: 5, costUsdEstimate: 9 }))).toMatchObject({ avoided: 0, helper: 0, usd: 0, hasUsd: false, isInfo: true })
    expect(parseLine(line({ kind: 'from-the-future', tokensAvoided: 999 }))).toMatchObject({ avoided: 0, isInfo: true })
  })

  test('cost-upgrade is a cost: its tokensAvoided is ignored and its dollars are never positive', () => {
    expect(parseLine(line({ kind: 'cost-upgrade', tokensAvoided: 800, costUsdEstimate: -0.02 }))).toMatchObject({ avoided: 0, usd: -0.02, hasUsd: true, isInfo: false, kind: 'cost-upgrade' })
    expect(parseLine(line({ kind: 'cost-upgrade', tokensAvoided: 800, costUsdEstimate: 0.02 }))).toMatchObject({ avoided: 0, usd: -0.02 })
    expect(parseLine(line({ kind: 'cost-upgrade', tokensAvoided: 800 }))).toMatchObject({ avoided: 0, usd: 0, hasUsd: false })
    expect(parseLine(line({ kind: 'cost-upgrade', helperTokens: 40 }))?.helper).toBe(40) // helper tokens are spent, so they stay
    expect(Object.is(parseLine(line({ kind: 'cost-upgrade' }))?.usd, 0)).toBe(true) // absent: 0, not -0
  })

  test('missing mod is "unknown" (never the file name); notes are flattened and cut', () => {
    const e = parseLine(line({ mod: undefined, note: `a\n${'x'.repeat(500)}` }))
    expect(e?.mod).toBe('unknown')
    expect(e?.note.length).toBeLessThanOrEqual(160)
    expect(e?.note.includes('\n')).toBe(false)
  })
})

describe('aggregation', () => {
  const entries = parseLedgerText(
    [
      line({ mod: 'input-router', session: 's1', tokensAvoided: 12000, costUsdEstimate: 0.036 }),
      line({ mod: 'input-router', session: 's2', tokensAvoided: 3000, ts: '2026-11-17T09:00:00.000Z' }),
      line({ mod: 'cache-clock', session: 's1', kind: 'cache-kept-warm', tokensAvoided: 1000, ts: '2026-11-16T23:59:59.000Z' }),
      line({ mod: 'cache-clock', session: 's1', kind: 'info', tokensAvoided: 77, note: 'just a note' }),
      '{broken',
    ].join('\n'),
  )

  test('today, this chat and per mod (legacy lines have helper 0 and some have no dollars)', () => {
    const s = summarize({ entries: entries.entries, now: T0, sessionId: 's1', tzOffsetMin: UTC, skipped: entries.skipped })
    expect(s.today).toEqual({ events: 3, avoided: 15000, helper: 0, usd: 0.036, noUsd: 1 }) // the info line is not "missing a $"
    expect(s.session).toEqual({ events: 3, avoided: 13000, helper: 0, usd: 0.036, noUsd: 1 })
    expect(s.all).toEqual({ events: 4, avoided: 16000, helper: 0, usd: 0.036, noUsd: 2 })
    expect(s.skipped).toBe(1)
    expect(s.perMod.map(r => [r.mod, r.events, r.avoided])).toEqual([
      ['input-router', 2, 15000],
      ['cache-clock', 2, 1000],
    ])
  })

  test('avoided, helper and dollars stay three separate sums; dollars are signed and only cover lines that have them', () => {
    const e = parseLedgerText(
      [
        line({ mod: 'good', tokensAvoided: 12000, helperTokens: 1500, costUsdEstimate: 0.03 }),
        line({ mod: 'good', tokensAvoided: 5000, helperTokens: 500, costUsdEstimate: 0.01, note: 'second' }),
        line({ mod: 'good', tokensAvoided: 300, note: 'legacy, no helper, no dollars' }),
        line({ mod: 'dollars-only', kind: 'cost-downgrade', costUsdEstimate: 0.2 }),
        line({ mod: 'costly', tokensAvoided: 100, helperTokens: 4000, costUsdEstimate: -0.002 }),
        line({ mod: 'costly', kind: 'cost-upgrade', tokensAvoided: 9999, costUsdEstimate: -0.05, note: 'opus' }),
        line({ mod: 'costly', kind: 'cost-upgrade', note: 'upgrade without numbers' }),
        line({ mod: 'costly', kind: 'info', tokensAvoided: 7, helperTokens: 7, costUsdEstimate: 7 }),
      ].join('\n'),
    ).entries
    const s = summarize({ entries: e, now: T0, sessionId: 's1', tzOffsetMin: UTC })
    expect(s.all.events).toBe(8)
    expect(s.all.avoided).toBe(12000 + 5000 + 300 + 100) // cost-upgrade's 9999 and the info 7 are not savings
    expect(s.all.helper).toBe(1500 + 500 + 4000)
    expect(Math.abs(s.all.usd - (0.03 + 0.01 + 0.2 - 0.002 - 0.05)) < 1e-9).toBe(true)
    expect(s.all.noUsd).toBe(2) // the legacy line and the cost-upgrade without a figure; info is not counted
    const row = (m: string) => s.perMod.find(r => r.mod === m)
    expect(row('good')).toMatchObject({ events: 3, avoided: 17300, helper: 2000, noUsd: 1 })
    expect(Math.abs((row('good')?.usd ?? 0) - 0.04) < 1e-9).toBe(true)
    expect(row('dollars-only')).toMatchObject({ events: 1, avoided: 0, helper: 0, usd: 0.2, noUsd: 0 })
    expect(row('costly')).toMatchObject({ events: 4, avoided: 100, helper: 4000, noUsd: 1 })
    expect(Math.abs((row('costly')?.usd ?? 0) - -0.052) < 1e-9).toBe(true) // negative dollars are kept, not clamped
    expect(s.perMod.map(r => r.mod)).toEqual(['good', 'costly', 'dollars-only'])
    expect(s.recent.find(r => r.note === 'second')).toMatchObject({ avoided: 5000, helper: 500, usd: 0.01, hasUsd: true })
  })

  test('the status text lists avoided, helper and signed dollars, and leaves out what is 0 or unknown', () => {
    const at = (lines: string[]) => summarize({ entries: parseLedgerText(lines.join('\n')).entries, now: T0, sessionId: '', tzOffsetMin: UTC })
    expect(statusText(at([line({ tokensAvoided: 12000, helperTokens: 1500, costUsdEstimate: 0.03 })]))).toBe('avoided ~12k, helper ~1.5k, ~$0.03 est. today')
    expect(statusText(at([line({ tokensAvoided: 12000 })]))).toBe('avoided ~12k est. today') // legacy line: no helper, no dollars
    expect(statusText(at([line({ kind: 'cost-downgrade', costUsdEstimate: 0.5 })]))).toBe('~$0.50 est. today') // dollars only
    expect(statusText(at([line({ helperTokens: 900, kind: 'cache-kept-warm' })]))).toBe('helper ~900 est. today')
    // a cost day: avoided is not invented, dollars are negative
    expect(statusText(at([line({ kind: 'cost-upgrade', tokensAvoided: 1300, costUsdEstimate: -0.04 })]))).toBe('~-$0.04 est. today')
    expect(statusText(at([line({ tokensAvoided: 100, costUsdEstimate: 0.01 }), line({ kind: 'cost-upgrade', costUsdEstimate: -0.01 })]))).toBe('avoided ~100 est. today') // dollars net to 0: omitted
    expect(statusText(at([line({ kind: 'info', tokensAvoided: 5 })]))).toBeUndefined()
    expect(statusText(at([line({ tokensAvoided: 12000, costUsdEstimate: 0.03 })]), 'inr', 90)).toBe('avoided ~12k, ~INR 2.70 est. today')
  })

  test('this chat matches the raw and the sanitised session id (and only those)', () => {
    expect(sanitizeSession('a b/c.d_e-F9')).toBe('a_b_c_d_e-F9')
    expect(sanitizeSession('x'.repeat(100))).toBe('x'.repeat(80))
    const raw = 'my chat/1'
    const e = parseLedgerText(
      [
        line({ session: raw, tokensAvoided: 1 }), // older line: raw id
        line({ session: 'my_chat_1', tokensAvoided: 10 }), // new line: sanitised id
        line({ session: 'my_chat_2', tokensAvoided: 100 }), // another chat
        line({ session: '', tokensAvoided: 1000 }),
      ].join('\n'),
    ).entries
    const s = summarize({ entries: e, now: T0, sessionId: raw, tzOffsetMin: UTC })
    expect([s.session.events, s.session.avoided]).toEqual([2, 11])
    // an id that needs no sanitising still matches itself, and the empty id still matches nothing
    expect(summarize({ entries: e, now: T0, sessionId: 'my_chat_2', tzOffsetMin: UTC }).session.avoided).toBe(100)
    expect(summarize({ entries: e, now: T0, sessionId: '', tzOffsetMin: UTC }).session.events).toBe(0)
  })

  test('ledgerDays drops lines older than the window by ts, and 0 means no limit', () => {
    const day = 86_400_000
    const at = (daysAgo: number) => new Date(T0 - daysAgo * day).toISOString()
    const e = parseLedgerText(
      [
        line({ ts: at(1), tokensAvoided: 1, mod: 'new' }),
        line({ ts: at(30), tokensAvoided: 10, mod: 'edge' }), // exactly on the cutoff: kept
        line({ ts: at(30.001), tokensAvoided: 100, mod: 'old' }),
        line({ ts: at(400), tokensAvoided: 1000, mod: 'old' }),
      ].join('\n'),
    ).entries
    const w = summarize({ entries: e, now: T0, sessionId: '', tzOffsetMin: UTC, ledgerDays: 30 })
    expect([w.all.events, w.all.avoided]).toEqual([2, 11])
    expect(w.perMod.map(r => r.mod).sort()).toEqual(['edge', 'new'])
    expect(w.ledgerDays).toBe(30)
    const none = summarize({ entries: e, now: T0, sessionId: '', tzOffsetMin: UTC, ledgerDays: 0 })
    expect(none.all.events).toBe(4)
    expect(summarize({ entries: e, now: T0, sessionId: '', tzOffsetMin: UTC }).all.events).toBe(4)
  })

  test('isOld compares a file mtime with the window', () => {
    const day = 86_400_000
    expect(isOld(T0 - 91 * day, T0, 90)).toBe(true)
    expect(isOld(T0 - 90 * day, T0, 90)).toBe(false)
    expect(isOld(T0 - 90 * day + 1, T0, 90)).toBe(false)
    expect(isOld(0, T0, 0)).toBe(false)
  })

  test('the day boundary follows the time zone', () => {
    // 23:30 UTC the day before is already "today" at UTC+1 (offset -60), not at UTC.
    const now = Date.parse('2026-11-17T12:00:00Z')
    expect(startOfDay(now, 0)).toBe(Date.parse('2026-11-17T00:00:00Z'))
    expect(startOfDay(now, -60)).toBe(Date.parse('2026-11-16T23:00:00Z'))
    const late = parseLedgerText(line({ ts: '2026-11-16T23:30:00Z', tokensAvoided: 10 })).entries
    expect(summarize({ entries: late, now, sessionId: '', tzOffsetMin: 0 }).today.events).toBe(0)
    expect(summarize({ entries: late, now, sessionId: '', tzOffsetMin: -60 }).today.events).toBe(1)
  })

  test('an empty session id matches no chat', () => {
    const e = parseLedgerText(line({ session: '' })).entries
    const s = summarize({ entries: e, now: T0, sessionId: '', tzOffsetMin: UTC })
    expect(s.session.events).toBe(0)
    expect(s.today.events).toBe(1)
  })

  test('a line dated more than a day ahead counts in no window; a later line the same day counts everywhere', () => {
    const e = parseLedgerText(
      [
        line({ ts: '2027-01-01T00:00:00Z', mod: 'far', tokensAvoided: 1 }),
        line({ ts: new Date(T0 + 86_400_000 + 1).toISOString(), mod: 'just-over', tokensAvoided: 2 }),
        line({ ts: new Date(T0 + 86_400_000).toISOString(), mod: 'edge', tokensAvoided: 4 }), // exactly a day ahead: kept, but tomorrow
        line({ ts: '2026-11-17T18:00:00Z', mod: 'later-today', tokensAvoided: 8 }), // same UTC day, after now
      ].join('\n'),
    ).entries
    const s = summarize({ entries: e, now: T0, sessionId: '', tzOffsetMin: UTC })
    expect(s.all.avoided).toBe(4 + 8)
    expect(s.today.avoided).toBe(8)
    expect(s.perMod.map(r => r.mod).sort()).toEqual(['edge', 'later-today'])
    expect(s.recent.map(r => r.mod).sort()).toEqual(['edge', 'later-today'])
    expect(s.skipped).toBe(0) // ignored, not malformed
  })

  test('parseSnapshot rejects a snapshot with any missing or non-finite figure', () => {
    const base = summarize({ entries: parseLedgerText(line({ tokensAvoided: 1, costUsdEstimate: 0.5 })).entries, now: T0, sessionId: 's1', tzOffsetMin: UTC })
    const clone = () => JSON.parse(JSON.stringify(base)) as Record<string, any>
    expect(parseSnapshot(JSON.stringify(base))).not.toBeNull()
    const drop = (f: (o: Record<string, any>) => void) => {
      const o = clone()
      f(o)
      return parseSnapshot(JSON.stringify(o))
    }
    for (const w of ['today', 'session', 'all'] as const) {
      for (const k of ['events', 'avoided', 'helper', 'usd', 'noUsd'] as const) {
        expect(drop(o => delete o[w][k])).toBeNull() // missing
        expect(drop(o => (o[w][k] = '1'))).toBeNull() // wrong type
        expect(drop(o => (o[w][k] = null))).toBeNull() // what NaN becomes in JSON
      }
    }
    for (const k of ['events', 'avoided', 'helper', 'usd', 'noUsd'] as const) {
      expect(drop(o => delete o.perMod[0][k])).toBeNull()
      expect(drop(o => (o.perMod[0][k] = null))).toBeNull()
    }
    expect(drop(o => delete o.perMod[0].mod)).toBeNull()
    for (const k of ['at', 'avoided', 'helper', 'usd'] as const) expect(drop(o => (o.recent[0][k] = null))).toBeNull()
    expect(drop(o => (o.recent[0].hasUsd = 1))).toBeNull()
    expect(drop(o => delete o.recent[0].note)).toBeNull()
    for (const k of ['now', 'skipped', 'unreadable', 'files', 'oldFiles', 'ledgerDays'] as const) expect(drop(o => delete o[k])).toBeNull()
    expect(drop(o => (o.sessionId = 5))).toBeNull()
    // the text form of a non-finite number is not valid JSON at all
    expect(parseSnapshot('{"today":{"events":NaN}}')).toBeNull()
    // and whatever passes can be shown without NaN
    expect(statusText({ ...base, today: { events: 1, avoided: 0, helper: 0, usd: Number.NaN, noUsd: 0 } })).toBeUndefined()
    expect(statusText({ ...base, today: { events: 1, avoided: Number.NaN, helper: Number.NaN, usd: Number.POSITIVE_INFINITY, noUsd: 0 } })).toBeUndefined()
  })

  test('the last 10 events, newest first, with notes', () => {
    const many = parseLedgerText(
      Array.from({ length: 15 }, (_, i) => line({ ts: new Date(T0 - i * 60_000).toISOString(), note: `n${i}` })).join('\n'),
    ).entries
    const s = summarize({ entries: many, now: T0, sessionId: 's1', tzOffsetMin: UTC })
    expect(s.recent.length).toBe(10)
    expect(s.recent[0]?.note).toBe('n0')
    expect(s.recent[9]?.note).toBe('n9')
  })

  test('no entries is an empty summary', () => {
    const s = summarize({ entries: [], now: T0, sessionId: 's1' })
    expect(s.all.events).toBe(0)
    expect(s.perMod).toEqual([])
    expect(statusText(s)).toBeUndefined()
  })
})

describe('formatting', () => {
  test('tokens and money are rounded and carry the estimate marker', () => {
    expect(formatTokens(950)).toBe('950')
    expect(formatTokens(12_000)).toBe('12k')
    expect(formatTokens(1234)).toBe('1.2k')
    expect(formatTokens(3_400_000)).toBe('3.4M')
    expect(formatMoney(0.036, 'USD')).toBe('~$0.04')
    expect(formatMoney(0.036, 'inr', 90)).toBe('~INR 3.24')
    expect(formatMoney(0, 'USD')).toBe('~$0.00')
    expect(formatMoney(1, 'CHF', Number.NaN)).toBe('~CHF 1.00')
    // negatives keep their sign
    expect(formatTokens(-1234)).toBe('-1.2k')
    expect(formatTokens(-950)).toBe('-950')
    expect(formatTokens(-12_000)).toBe('-12k')
    expect(formatMoney(-0.036, 'USD')).toBe('~-$0.04')
    // exact zero is $0.00 with no sign; tiny non-zero amounts say "under a cent", sign kept
    expect(formatMoney(-0, 'USD')).toBe('~$0.00')
    expect(formatMoney(-1e-17, 'USD')).toBe('~$0.00') // float leftover, not "~-$0.0000"
    expect(formatMoney(1e-17, 'USD')).toBe('~$0.00')
    expect(formatMoney(0.0004, 'USD')).toBe('~<$0.01')
    expect(formatMoney(-0.0001, 'USD')).toBe('~-<$0.01')
    expect(formatMoney(0.0004, 'inr', 90)).toBe('~INR 0.04')
    expect(formatMoney(-0.0001, 'inr', 10)).toBe('~-<INR 0.01')
    expect(formatMoney(Number.NaN, 'USD')).toBe('~$0.00')
    expect(formatMoney(-0.04, 'USD')).toBe('~-$0.04')
    expect(formatMoney(3.3, 'INR', 1, true)).toBe('~3.30')
    expect(formatMoney(-0.04, 'EUR', 1, true)).toBe('~-0.04')
    expect(roundUsd(0.1 + 0.2 - 0.3)).toBe(0)
    expect(Object.is(roundUsd(-1e-17), 0)).toBe(true) // never -0
  })

  test('summed dollars are rounded so float leftovers never reach the screen', () => {
    // 0.1 + 0.2 - 0.3 is 5.55e-17 in floating point; as a net it must be exactly 0
    const at = (lines: string[]) => summarize({ entries: parseLedgerText(lines.join('\n')).entries, now: T0, sessionId: '', tzOffsetMin: UTC })
    const s = at([
      line({ kind: 'cost-downgrade', costUsdEstimate: 0.1 }),
      line({ kind: 'cost-downgrade', costUsdEstimate: 0.2, note: 'b' }),
      line({ kind: 'cost-upgrade', costUsdEstimate: -0.3 }),
    ])
    expect(s.today.usd).toBe(0)
    expect(s.all.usd).toBe(0)
    expect(s.perMod[0]?.usd).toBe(0)
    expect(statusText(s)).toBeUndefined() // nothing else to show, and no "~$0.00" or "~-$0.0000"
    const neg = at([line({ kind: 'cost-upgrade', costUsdEstimate: -0.3 }), line({ kind: 'cost-downgrade', costUsdEstimate: 0.1, note: 'b' }), line({ kind: 'cost-downgrade', costUsdEstimate: 0.2, note: 'c' }), line({ kind: 'cost-upgrade', costUsdEstimate: -0.04, note: 'd' })])
    expect(neg.today.usd).toBe(-0.04)
    expect(statusText(neg)).toBe('~-$0.04 est. today')
  })

  test('status text, options and snapshot guard', () => {
    const s = summarize({ entries: parseLedgerText(line({ tokensAvoided: 12_000 })).entries, now: T0, sessionId: '', tzOffsetMin: UTC })
    expect(statusText(s)).toBe('avoided ~12k est. today')
    expect(readSettings({})).toEqual({ showStatus: false, currency: 'USD', unitsPerUsd: 1, ledgerDays: 90 })
    expect(readSettings({ showStatus: true, currency: ' eur ', unitsPerUsd: 0.9 })).toEqual({ showStatus: true, currency: 'eur', unitsPerUsd: 0.9, ledgerDays: 90 })
    expect(readSettings({ ledgerDays: 0 }).ledgerDays).toBe(0)
    expect(readSettings({ ledgerDays: 99_999 }).ledgerDays).toBe(3650)
    expect(readSettings({ ledgerDays: -4 }).ledgerDays).toBe(0)
    expect(parseSnapshot('')).toBeNull()
    expect(parseSnapshot('{oops')).toBeNull()
    expect(parseSnapshot('{"a":1}')).toBeNull()
    // a snapshot from before the three-number rule (net/gross, or no helper/noUsd) is declined, not drawn as NaN
    expect(parseSnapshot('{"today":{},"perMod":[],"recent":[],"all":{"events":1,"tokens":1,"usd":0}}')).toBeNull()
    expect(parseSnapshot('{"today":{},"perMod":[],"recent":[],"oldFiles":0,"all":{"events":1,"tokens":1,"usd":0,"gross":1,"spent":0}}')).toBeNull()
    expect(parseSnapshot(JSON.stringify(s))?.today.avoided).toBe(12_000)
    expect(parseSnapshot(JSON.stringify(s))).toEqual(s)
    expect(signature([{ name: 'b', size: 1, mtimeMs: 2 }, { name: 'a', size: 3, mtimeMs: 4 }])).toBe('a:3:4|b:1:2')
  })
})

// Everything beneath the plugin: the engine's answers, from memory.
type Rig = { clock: ReturnType<typeof mock.clock>; files: Record<string, string>; statuses: (string | undefined)[]; opened: number; reads: number; listing: boolean; mtimes: Record<string, number>; unreadable: string[]; sessionId: string }

const rig = (on: On, files: Record<string, string>, o: { noDir?: boolean } = {}): Rig => {
  const r: Rig = { clock: mock.clock(on, { now: T0 }), files, statuses: [], opened: 0, reads: 0, listing: !o.noDir, mtimes: {}, unreadable: [], sessionId: 's1' }
  mock.env(on, { HOME: '/home/t' })
  mock.store(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: r.sessionId }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => {
    r.opened += 1
    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({ value: [] }))
  on('ui.status', (_, e) => {
    r.statuses.push(e.text)
    return { value: undefined }
  })
  on('fs.list', (_, e) => {
    if (!r.listing || e.path !== '/home/t/.claude/claude-mods/ledger') throw new Error('ENOENT')
    return {
      value: Object.keys(r.files).map(path => ({
        name: path.split('/').pop() ?? '',
        kind: 'file',
        size: (r.files[path] ?? '').length,
        mtimeMs: r.mtimes[path] ?? T0,
        isLink: false,
      })),
    }
  })
  on('fs.read', (_, e) => {
    r.reads += 1
    if (r.unreadable.some(n => e.path.endsWith(n))) throw new Error('too large')
    const t = r.files[e.path]
    if (t === undefined) throw new Error('ENOENT')
    return { value: t }
  })
  return r
}

const DIR = '/home/t/.claude/claude-mods/ledger'
type Test$ = Parameters<Extract<Parameters<typeof test>[1], (...a: never[]) => unknown>>[0]
const runSavings = ($: Test$) =>
  $.command.run({
    command: 'savings',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  })
const START = { cwd: '/', surface: 'terminal', isInteractive: true } as const

describe('the pane', () => {
  test('a non-USD currency labels the figure by its code: "Est. INR ~3.24", not "Est. $ ~INR 3.24"', { options: { currency: 'inr', unitsPerUsd: 90 } }, async ($, on) => {
    rig(on, { [`${DIR}/a.jsonl`]: line({ tokensAvoided: 12000, helperTokens: 1500, costUsdEstimate: 0.036 }) })
    await $.session.start(START)
    await runSavings($)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await ui.find({ type: 'Text', text: /^Today:/ }))?.text).toMatch(/^Today: +1 events, Avoided 12k, Helper 1\.5k, Est\. INR ~3\.24$/)
    expect(await ui.find({ type: 'Text', text: /Est\. \$/ })).toBeFalsy()
    expect(await ui.find({ type: 'Text', text: /^Mod\s.*Est\. INR\s+No \$$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^a\s+1\s+12k\s+1\.5k\s+~3\.24\s+0$/ })).toBeTruthy()
    await ui.unmount()
  })

  test('shows totals, per-mod rows and recent notes, labelled as estimates, on every surface', async ($, on) => {
    rig(on, {
      [`${DIR}/input-router.jsonl`]: [
        line({ mod: 'input-router', tokensAvoided: 12000, helperTokens: 1500, costUsdEstimate: 0.036, note: 'summarised a big read' }),
        '{garbage',
      ].join('\n'),
      [`${DIR}/cache-clock.jsonl`]: line({ mod: 'cache-clock', kind: 'info', note: 'ping found cache cold' }),
    })
    await $.session.start(START)
    await runSavings($)
    for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect(await ui.find({ type: 'Text', text: /^Savings \(estimated\)$/ })).toBeTruthy()
      expect(await ui.find({ type: 'Text', text: /net/i })).toBeFalsy() // no net headline anywhere
      expect((await ui.find({ type: 'Text', text: /^Today:/ }))?.text).toMatch(/^Today: +2 events, Avoided 12k, Helper 1\.5k, Est\. \$ ~\$0\.04$/)
      expect((await ui.find({ type: 'Text', text: /^This chat:/ }))?.text).toMatch(/2 events/)
      expect(await ui.find({ type: 'Text', text: /input-router\s+1\s+12k\s+1\.5k\s+~\$0\.04\s+0$/ })).toBeTruthy()
      expect(await ui.find({ type: 'Text', text: /summarised a big read/ })).toBeTruthy()
      expect((await ui.find({ type: 'Text', text: /ping found cache cold/ }))?.text).toMatch(/info/)
      expect((await ui.find({ type: 'Text', text: /summarised a big read/ }))?.text).toMatch(/av 12k help 1\.5k ~\$0\.04 summarised/)
      expect(await ui.find({ type: 'Text', text: /1 bad line/ })).toBeTruthy()
      await ui.unmount()
    }
  })

  test('a narrow pane clamps the header and each per-mod row to its columns', async ($, on) => {
    rig(on, { [`${DIR}/a.jsonl`]: line({ mod: 'input-router', tokensAvoided: 12000, helperTokens: 1500, costUsdEstimate: 0.036 }) })
    await $.session.start(START)
    await runSavings($)
    const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 30 }, surface: 'terminal' })
    const header = await ui.find({ type: 'Text', text: /^Mod/ })
    const row = await ui.find({ type: 'Text', text: /^input-/ })
    expect(header).toBeTruthy()
    expect(row).toBeTruthy()
    expect((header?.text ?? '').length).toBeLessThanOrEqual(30)
    expect((row?.text ?? '').length).toBeLessThanOrEqual(30)
    await ui.unmount()
  })

  test('no ledger folder: "no data yet"', async ($, on) => {
    rig(on, {}, { noDir: true })
    await $.session.start(START)
    await runSavings($)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await ui.find({ type: 'Text', text: /no data yet/ })).toBeTruthy()
    await ui.unmount()
  })

  test('empty and all-corrupt files: "no data yet" and no throw', async ($, on) => {
    rig(on, { [`${DIR}/a.jsonl`]: '', [`${DIR}/b.jsonl`]: '{x\n\n[]\n' })
    await $.session.start(START)
    await runSavings($)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /no data yet/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /2 unreadable ledger line/ })).toBeTruthy()
    await ui.unmount()
  })

  test('a mounted pane shows a line that appears later, once the poll runs', { timeoutMs: 20_000 }, async ($, on) => {
    const r = rig(on, { [`${DIR}/a.jsonl`]: line({ mod: 'a', tokensAvoided: 1000, note: 'first' }) })
    const { clock } = r
    await $.session.start(START)
    await runSavings($)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await ui.find({ type: 'Text', text: /first/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /later line/ })).toBeFalsy()
    const reads = r.reads
    // Nothing changed on disk: the poll lists the folder but rereads nothing.
    await clock.advance(9000)
    await clock.settle()
    expect(r.reads).toBe(reads)
    r.files[`${DIR}/a.jsonl`] += `\n${line({ mod: 'a', tokensAvoided: 500, note: 'later line' })}`
    await clock.advance(9000)
    await clock.settle()
    expect(await ui.find({ type: 'Text', text: /later line/ })).toBeTruthy()
    await ui.unmount()
  })
})

describe('three figures, windows and session ids in the pane', () => {
  const DAY = 86_400_000
  test('a cost-upgrade is a cost: negative dollars, its tokens never counted as avoided', async ($, on) => {
    rig(on, {
      [`${DIR}/good.jsonl`]: line({ mod: 'good', tokensAvoided: 5000, note: 'big win' }),
      [`${DIR}/costly.jsonl`]: [
        line({ mod: 'costly', tokensAvoided: 300, note: 'small win' }),
        line({ mod: 'costly', kind: 'cost-upgrade', tokensAvoided: -2000, costUsdEstimate: -0.04, note: 'went to a stronger model' }),
      ].join('\n'),
    })
    await $.session.start(START)
    await runSavings($)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await ui.find({ type: 'Text', text: /costly\s+2\s+300\s+0\s+~-\$0\.04\s+1$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /good\s+1\s+5k\s+0\s+~\$0\.00\s+1$/ })).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /^Today:/ }))?.text).toMatch(/3 events, Avoided 5\.3k, Helper 0, Est\. \$ ~-\$0\.04 \(2 no \$\)/)
    expect(await ui.find({ type: 'Text', text: /went to a stronger model/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /costly\s+av 0 help 0 ~-\$0\.04 went to/ })).toBeTruthy()
    await ui.unmount()
  })

  test('files older than ledgerDays are skipped unread and counted in the footer', async ($, on) => {
    const r = rig(on, {
      [`${DIR}/fresh.jsonl`]: line({ mod: 'fresh', tokensAvoided: 100 }),
      [`${DIR}/stale.jsonl`]: line({ mod: 'stale', tokensAvoided: 900 }),
      [`${DIR}/ancient.jsonl`]: line({ mod: 'ancient', tokensAvoided: 900 }),
    })
    r.mtimes[`${DIR}/stale.jsonl`] = T0 - 91 * DAY
    r.mtimes[`${DIR}/ancient.jsonl`] = T0 - 500 * DAY
    await $.session.start(START)
    await runSavings($)
    expect(r.reads).toBe(1)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await ui.find({ type: 'Text', text: /fresh\s+1/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /stale|ancient/ })).toBeFalsy()
    expect(await ui.find({ type: 'Text', text: /last 90 day\(s\); 2 older file\(s\) skipped/ })).toBeTruthy()
    await ui.unmount()
  })

  test('ledgerDays 0 reads every file whatever its age', { options: { ledgerDays: 0 } }, async ($, on) => {
    const r = rig(on, { [`${DIR}/stale.jsonl`]: line({ mod: 'stale', tokensAvoided: 900, ts: '2020-01-01T00:00:00Z' }) })
    r.mtimes[`${DIR}/stale.jsonl`] = 1
    await $.session.start(START)
    await runSavings($)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await ui.find({ type: 'Text', text: /stale\s+1\s+900\s+0\s+~\$0\.00\s+1$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /no age limit/ })).toBeTruthy()
    await ui.unmount()
  })

  test('a fresh file still drops its lines older than the window', { options: { ledgerDays: 7 } }, async ($, on) => {
    rig(on, {
      [`${DIR}/a.jsonl`]: [
        line({ mod: 'a', tokensAvoided: 50, ts: new Date(T0 - 2 * DAY).toISOString() }),
        line({ mod: 'a', tokensAvoided: 5000, ts: new Date(T0 - 40 * DAY).toISOString(), note: 'ancient line' }),
      ].join('\n'),
    })
    await $.session.start(START)
    await runSavings($)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await ui.find({ type: 'Text', text: /^a\s+1\s+50\s+0/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /ancient line/ })).toBeFalsy()
    await ui.unmount()
  })

  test('this chat counts a line carrying either the raw or the sanitised session id', async ($, on) => {
    // The rig's session.id answers "s1"; override with an id that sanitising changes.
    const r = rig(on, {
      [`${DIR}/a.jsonl`]: [
        line({ mod: 'a', session: 'my chat/1', tokensAvoided: 1, note: 'raw' }),
        line({ mod: 'a', session: 'my_chat_1', tokensAvoided: 20, note: 'sanitised' }),
        line({ mod: 'a', session: 'other', tokensAvoided: 300, note: 'other chat' }),
      ].join('\n'),
    })
    r.sessionId = 'my chat/1'
    await $.session.start(START)
    await runSavings($)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await ui.find({ type: 'Text', text: /^This chat:/ }))?.text).toMatch(/2 events, Avoided 21,/)
    await ui.unmount()
  })
})

describe('many ledger files', () => {
  const S1 = 'sess-1'
  const S2 = 'sess-2'
  const files = (): Record<string, string> => ({
    [`${DIR}/input-router.${S1}.jsonl`]: [
      line({ mod: 'input-router', session: S1, tokensAvoided: 1000, note: 'ir one' }),
      line({ mod: 'input-router', session: S1, tokensAvoided: 1000, note: 'ir one' }), // exact repeat: dropped
    ].join('\n'),
    [`${DIR}/input-router.${S2}.jsonl`]: line({ mod: 'input-router', session: S2, tokensAvoided: 2000, note: 'ir two' }),
    // legacy name, and the same text as the S2 line above's twin in another file: kept (no cross-file dedupe)
    [`${DIR}/input-router.jsonl`]: line({ mod: 'input-router', session: S2, tokensAvoided: 2000, note: 'ir two' }),
    // one file, two mods; the file name says "mixed" but nothing is taken from it
    [`${DIR}/mixed.${S1}.jsonl`]: [
      line({ mod: 'cache-clock', session: S1, kind: 'cache-kept-warm', tokensAvoided: 300, note: 'cc' }),
      line({ mod: 'model-router', session: S1, kind: 'cost-downgrade', costUsdEstimate: 0.5, note: 'mr' }),
    ].join('\n'),
    [`${DIR}/broken.${S1}.jsonl`]: '{nope\n\u0000\u0000garbage\n[1]',
  })

  test('globs every file, takes the mod from each line, scopes "this chat" by the session field', async ($, on) => {
    rig(on, files()) // session.id answers 's1', so use a session id that matches nothing first
    await $.session.start(START)
    await runSavings($)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    // all time: ir 1000+2000+2000 over 3 files (no dollars), cc 300, mr 0 tokens but $0.50
    expect(await ui.find({ type: 'Text', text: /input-router\s+3\s+5k\s+0\s+~\$0\.00\s+3$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /cache-clock\s+1\s+300\s+0\s+~\$0\.00\s+1$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /model-router\s+1\s+0\s+0\s+~\$0\.50\s+0$/ })).toBeTruthy()
    // no row is named after a file
    expect(await ui.find({ type: 'Text', text: /mixed|broken/ })).toBeFalsy()
    expect(await ui.find({ type: 'Text', text: /3 bad line\(s\) skipped, 0 file/ })).toBeTruthy()
    await ui.unmount()
  })

  test('"this chat" matches the line session, not the file it sits in', async ($, on) => {
    const f = files()
    // A line for session s1 inside a file named for another session.
    f[`${DIR}/input-router.${S2}.jsonl`] += `\n${line({ mod: 'input-router', session: 's1', tokensAvoided: 40, note: 'stray' })}`
    rig(on, f) // current session id is 's1'
    await $.session.start(START)
    await runSavings($)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    // s1 lines: cc, mr, stray (the S1-named ledgers use the session 'sess-1', which is not 's1')
    expect((await ui.find({ type: 'Text', text: /^This chat:/ }))?.text).toMatch(/1 events?, Avoided 40,/)
    await ui.unmount()
  })

  test('a poll rereads only the files whose size or mtime changed', { timeoutMs: 20_000 }, async ($, on) => {
    const f = files()
    const r = rig(on, f)
    await $.session.start(START)
    await runSavings($)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(r.reads).toBe(5)
    await r.clock.advance(9000)
    await r.clock.settle()
    expect(r.reads).toBe(5)
    // same size, new mtime on one file: only that file is read again
    r.mtimes[`${DIR}/input-router.jsonl`] = T0 + 99
    await r.clock.advance(9000)
    await r.clock.settle()
    expect(r.reads).toBe(6)
    // grow one file and add a new session file: two reads, the rest come from the cache
    f[`${DIR}/mixed.${S1}.jsonl`] += `\n${line({ mod: 'cache-clock', session: S1, tokensAvoided: 700, note: 'grown' })}`
    f[`${DIR}/new-mod.sess-3.jsonl`] = line({ mod: 'new-mod', session: 'sess-3', tokensAvoided: 5, note: 'fresh' })
    await r.clock.advance(9000)
    await r.clock.settle()
    expect(r.reads).toBe(8)
    expect(await ui.find({ type: 'Text', text: /cache-clock\s+2\s+1k\s+0/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /new-mod\s+1\s+5\s+0/ })).toBeTruthy()
    // a deleted file leaves the totals
    delete f[`${DIR}/new-mod.sess-3.jsonl`]
    await r.clock.advance(9000)
    await r.clock.settle()
    expect(await ui.find({ type: 'Text', text: /new-mod/ })).toBeFalsy()
    await ui.unmount()
  })

  test('an unreadable file counts as unreadable and does not hide the others', async ($, on) => {
    const f = files()
    const r = rig(on, f)
    // listed but unreadable (for example over the read limit)
    r.files[`${DIR}/huge.sess-9.jsonl`] = 'x'
    r.unreadable.push('huge.sess-9.jsonl')
    await $.session.start(START)
    await runSavings($)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await ui.find({ type: 'Text', text: /input-router\s+3/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /1 file\(s\) unreadable|1 unreadable file/ })).toBeTruthy()
    await ui.unmount()
  })
})

describe('the status line', () => {
  test('off by default: nothing is pinned', async ($, on) => {
    const r = rig(on, { [`${DIR}/a.jsonl`]: line({ tokensAvoided: 12000 }) })
    await $.session.start(START)
    await runSavings($)
    expect(r.statuses.filter(s => s !== undefined)).toEqual([])
  })

  test('showStatus on: pins "avoided ~12k, helper ~1.5k, ~$0.03 est. today"', { options: { showStatus: true } }, async ($, on) => {
    const r = rig(on, { [`${DIR}/a.jsonl`]: line({ tokensAvoided: 12000, helperTokens: 1500, costUsdEstimate: 0.03 }) })
    await $.session.start(START)
    await runSavings($)
    expect(r.statuses.at(-1)).toBe('avoided ~12k, helper ~1.5k, ~$0.03 est. today')
  })

  test('a legacy line pins only what it has; a cost-upgrade day pins negative dollars, never avoided', { options: { showStatus: true } }, async ($, on) => {
    const r = rig(on, {
      [`${DIR}/a.jsonl`]: [line({ tokensAvoided: 200 }), line({ kind: 'cost-upgrade', tokensAvoided: 1400, costUsdEstimate: -0.04, note: 'opus' })].join('\n'),
    })
    await $.session.start(START)
    await runSavings($)
    expect(r.statuses.at(-1)).toBe('avoided ~200, ~-$0.04 est. today')
  })

  test('ledgerDays out of range fails the load', { options: { ledgerDays: 4000 } }, async ($, on) => {
    rig(on, {})
    await expect($.session.start(START)).rejects.toThrow(/at most/)
  })

  test('a bad option fails the load', { options: { unitsPerUsd: 0 } }, async ($, on) => {
    rig(on, {})
    await expect($.session.start(START)).rejects.toThrow(/at least/)
  })
})
