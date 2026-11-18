import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import {
  canSwitch,
  decide,
  heuristicAnswers,
  isHoldActive,
  isManualChange,
  helperTokensOf,
  isUpgrade,
  levelFor,
  levelUnderHold,
  modelPrompt,
  parseCommandArg,
  parseModelAnswers,
  readSettings,
  scorePrompt,
} from './logic'
import type { Answers, PickInput } from './logic'
import { parseLedger, sanitizeSessionId } from './ledger'

const T0 = 1_700_000_000_000

const none: Answers = { mechanical: false, planning: false, unfamiliar: false, costly: false }

describe('the four-question scoring', () => {
  test('maps answers to levels as the spec says', () => {
    expect(levelFor({ ...none, mechanical: true })).toBe('low')
    expect(levelFor(none)).toBe('medium')
    expect(levelFor({ ...none, planning: true })).toBe('high')
    expect(levelFor({ ...none, unfamiliar: true })).toBe('high')
    expect(levelFor({ ...none, planning: true, unfamiliar: true })).toBe('xhigh')
    expect(levelFor({ ...none, costly: true })).toBe('xhigh')
    // (a) only wins `low` when it stands alone.
    expect(levelFor({ ...none, mechanical: true, planning: true })).toBe('high')
    expect(levelFor({ ...none, mechanical: true, costly: true })).toBe('xhigh')
  })

  test('never picks max', () => {
    const all = [true, false]
    for (const mechanical of all)
      for (const planning of all)
        for (const unfamiliar of all)
          for (const costly of all) expect(levelFor({ mechanical, planning, unfamiliar, costly })).not.toBe('max')
  })

  test('reads prompts', () => {
    expect(scorePrompt('rename the variable foo to bar in utils.ts').level).toBe('low')
    expect(scorePrompt('where is the config loaded?').level).toBe('low')
    expect(scorePrompt('Add a dark mode toggle to the settings page').level).toBe('medium')
    expect(scorePrompt('Plan and refactor the billing module across all services').answers.planning).toBe(true)
    expect(scorePrompt('Why does the test fail only sometimes? I am not sure where to look').level).toBe('high')
    expect(scorePrompt('Investigate this flaky test and design a migration plan for the legacy auth service').level).toBe('xhigh')
    expect(scorePrompt('Drop the users table in production').level).toBe('xhigh')
    expect(scorePrompt('rotate the API key secrets').answers.costly).toBe(true)
  })

  test('debugging questions are never a plain lookup', () => {
    for (const p of [
      'find the cause of the crash',
      'why is the checkout test failing',
      "why's the worker failing on startup",
      'what is causing the memory leak in the worker',
      'find out why the build breaks',
      'locate the culprit for the segfault',
      'what was the cause of the outage',
      'the api keeps crashing, find it',
    ]) {
      expect(scorePrompt(p).level).not.toBe('low')
      expect(scorePrompt(p).answers.mechanical).toBe(false)
    }
    // Plain lookups stay low.
    for (const p of ['find the file that defines parseConfig', 'list the failing tests', 'show the README', 'where is the config loaded?'])
      expect(scorePrompt(p).level).toBe('low')
  })

  test('a long prompt counts as planning; a long edit request is not mechanical', () => {
    const long = 'Please update the handling of the form. '.repeat(30)
    expect(heuristicAnswers(long).planning).toBe(true)
    expect(heuristicAnswers(`rename ${'x'.repeat(300)}`).mechanical).toBe(false)
  })

  test('the small model can add a yes but not make something mechanical', () => {
    const rules = scorePrompt('rename foo to bar')
    expect(rules.level).toBe('low')
    expect(scorePrompt('rename foo to bar', { ...none, planning: true, mechanical: true }).level).toBe('high')
    expect(scorePrompt('what changed here', { ...none, mechanical: false }).answers.mechanical).toBe(false)
  })

  test('parses the small model reply, and rejects anything else', () => {
    expect(parseModelAnswers('{"mechanical":true,"planning":false,"unfamiliar":false,"costly":false}')).toEqual({
      ...none,
      mechanical: true,
    })
    expect(parseModelAnswers('Sure! ```json\n{"mechanical":false,"planning":true,"unfamiliar":true,"costly":false}\n```')).toMatchObject({
      planning: true,
      unfamiliar: true,
    })
    expect(parseModelAnswers('no idea')).toBeNull()
    expect(parseModelAnswers('{"mechanical":"yes"}')).toBeNull()
    expect(parseModelAnswers('{broken')).toBeNull()
  })
})

describe('cooldown, manual choice and decisions', () => {
  test('canSwitch honours the cooldown', () => {
    expect(canSwitch(1, null, 2)).toBe(true)
    expect(canSwitch(6, 5, 2)).toBe(false)
    expect(canSwitch(7, 5, 2)).toBe(true)
    expect(canSwitch(6, 5, 1)).toBe(true)
  })

  test('detects a level the person changed, not our own rewrite', () => {
    expect(isManualChange(null, 'high', null)).toBe(false) // the first look at the session
    expect(isManualChange('medium', 'medium', null)).toBe(false)
    expect(isManualChange('medium', 'high', null)).toBe(true)
    expect(isManualChange('medium', 'high', 'high')).toBe(false) // our own level standing
  })

  const base: PickInput = {
    mode: 'auto',
    pick: 'high',
    current: 'medium',
    turnNo: 3,
    lastSwitchNo: null,
    cooldownTurns: 2,
    isManual: false,
    respectManual: true,
    costly: false,
  }
  test('decide by mode', () => {
    expect(decide(base)).toBe('switch')
    expect(decide({ ...base, mode: 'suggest' })).toBe('offer')
    expect(decide({ ...base, mode: 'off' })).toBe('none')
    expect(decide({ ...base, pick: 'medium' })).toBe('none')
    // The cooldown holds back downgrades and lateral moves, in both modes...
    expect(decide({ ...base, pick: 'low', lastSwitchNo: 2 })).toBe('none')
    expect(decide({ ...base, pick: 'low', mode: 'suggest', lastSwitchNo: 2 })).toBe('none')
    // ...but never an upgrade.
    expect(decide({ ...base, lastSwitchNo: 2 })).toBe('switch')
    expect(decide({ ...base, mode: 'suggest', lastSwitchNo: 2 })).toBe('offer')
    expect(decide({ ...base, pick: 'xhigh', current: 'low', lastSwitchNo: 3 })).toBe('switch')
    expect(decide({ ...base, isManual: true })).toBe('none')
    expect(decide({ ...base, isManual: true, respectManual: false })).toBe('switch')
    expect(decide({ ...base, mode: 'suggest', isManual: true })).toBe('offer')
  })

  test('a manual choice holds for manualHoldTurns turns; 0 never expires', () => {
    expect(isHoldActive(null, 5, 10)).toBe(false)
    expect(isHoldActive(3, 3, 10)).toBe(true)
    expect(isHoldActive(3, 12, 10)).toBe(true) // the 10th turn counting the one it began on
    expect(isHoldActive(3, 13, 10)).toBe(false)
    expect(isHoldActive(3, 4, 1)).toBe(false)
    expect(isHoldActive(3, 9999, 0)).toBe(true)
  })

  test('a level change together with a model change is not manual', () => {
    expect(isManualChange('medium', 'high', null, true)).toBe(false)
    expect(isManualChange('medium', 'high', null, false)).toBe(true)
  })

  test('during a manual hold only a costly upgrade up to xhigh gets through', () => {
    const held: PickInput = { ...base, isManual: true, pick: 'xhigh', current: 'low', costly: true }
    expect(decide(held)).toBe('switch')
    expect(decide({ ...held, costly: false })).toBe('none') // a merely complex prompt waits
    expect(decide({ ...held, pick: 'low', current: 'high' })).toBe('none') // never down
    expect(decide({ ...held, pick: 'medium', current: 'medium' })).toBe('none')
    expect(decide({ ...held, pick: 'max' })).toBe('none') // never past xhigh
    expect(decide({ ...held, current: 'max' })).toBe('none') // pick below the person's max: that is down
    expect(decide({ ...held, mode: 'suggest' })).toBe('offer')
  })

  test('the hold caps a pick at xhigh only in auto mode with respectManual on', () => {
    const o = { mode: 'auto', respectManual: true, manualAtTurn: 3 } as const
    expect(levelUnderHold('max', o)).toBe('xhigh')
    expect(levelUnderHold('high', o)).toBe('high')
    expect(levelUnderHold('max', { ...o, respectManual: false })).toBe('max') // no hold at all
    expect(levelUnderHold('max', { ...o, mode: 'suggest' })).toBe('max') // suggest is unaffected
    expect(levelUnderHold('max', { ...o, manualAtTurn: null })).toBe('max') // no hold in force
  })

  test('helper tokens: reported usage if non-zero, else ceil(chars / 4)', () => {
    expect(helperTokensOf(120, 4000)).toBe(120)
    expect(helperTokensOf(0, 9)).toBe(3)
    expect(helperTokensOf(0, 0)).toBe(0)
  })

  test('isUpgrade ranks by level; an unknown current is not an upgrade', () => {
    expect(isUpgrade('high', 'low')).toBe(true)
    expect(isUpgrade('low', 'high')).toBe(false)
    expect(isUpgrade('high', 'high')).toBe(false)
    expect(isUpgrade('high', null)).toBe(false)
  })

  test('options and command arguments', () => {
    expect(readSettings({})).toEqual({ mode: 'suggest', useModel: false, cooldownTurns: 2, respectManual: true, manualHoldTurns: 10 })
    expect(readSettings({ mode: 'auto', cooldownTurns: 5, respectManual: false, useModel: true })).toEqual({
      mode: 'auto',
      useModel: true,
      cooldownTurns: 5,
      respectManual: false,
      manualHoldTurns: 10,
    })
    expect(readSettings({ manualHoldTurns: 0 }).manualHoldTurns).toBe(0)
    expect(readSettings({ manualHoldTurns: 3.9 }).manualHoldTurns).toBe(3)
    expect(readSettings({ manualHoldTurns: -1 }).manualHoldTurns).toBe(10)
    expect(readSettings({ manualHoldTurns: 'x' }).manualHoldTurns).toBe(10)
    expect(readSettings({ mode: 'bogus', cooldownTurns: 0 })).toMatchObject({ mode: 'suggest', cooldownTurns: 2 })
    expect(parseCommandArg('')).toBe('status')
    expect(parseCommandArg(' AUTO ')).toBe('auto')
    expect(parseCommandArg('on')).toBe('on')
    expect(parseCommandArg('nope')).toBeNull()
  })

  test('ledger parsing keeps only objects with a string mod, and caps the length', () => {
    expect(parseLedger('{"mod":"a"}\n\nnot json\n{"mod":"b"}\n{"mod":"c"}', 2)).toEqual(['{"mod":"b"}', '{"mod":"c"}'])
    expect(parseLedger('null\n[]\n[{"mod":"x"}]\n42\n"s"\n{"mod":7}\n{"a":1}\n{"mod":"ok"}')).toEqual(['{"mod":"ok"}'])
  })

  test('session ids are sanitised for the file name', () => {
    expect(sanitizeSessionId('abc-DEF_09')).toBe('abc-DEF_09')
    expect(sanitizeSessionId('../../etc/x.y')).toBe('______etc_x_y')
    expect(sanitizeSessionId('.hidden')).toBe('_hidden')
    expect(sanitizeSessionId('a'.repeat(200))).toHaveLength(80)
  })
})

const zero = () => ({ model: 'opus', input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })

const ABOVE = {
  plugin: 'effort-optimizer',
  component: 'AbovePrompt',
  requestId: 'effort-optimizer',
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
  /** The effort the model request finally went out with, per step. */
  sent: (string | number | undefined)[]
  toasts: string[]
  writes: { path: string; text: string }[]
  /** The session's own level, as the engine asks for it on each step. */
  level: { value: string | undefined }
  /** The model the engine names on each step. */
  model: { value: string }
  completes: number
  commands: string[]
  /** The session id the engine reports; undefined makes `$.session.id()` throw. */
  sessionId: { value: string | undefined }
  /** Files by path; a path in `unreadable` exists but fails to read. */
  files: Map<string, string>
  unreadable: Set<string>
}

// Everything beneath the plugin: the engine's answers, from memory.
const rig = (on: On, o: { reply?: string; envThrows?: boolean; reportedInput?: number } = {}): Rig => {
  const r: Rig = {
    clock: mock.clock(on, { now: T0 }),
    sent: [],
    toasts: [],
    writes: [],
    level: { value: 'medium' },
    model: { value: 'opus' },
    completes: 0,
    commands: [],
    sessionId: { value: 'sess-1' },
    files: new Map(),
    unreadable: new Set(),
  }
  if (o.envThrows === true) {
    on('env.get', () => {
      throw new Error('env unavailable')
    })
  } else mock.env(on, { HOME: '/home/t' })
  mock.store(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => {
    if (r.sessionId.value === undefined) throw new Error('no session')
    return { value: r.sessionId.value }
  })
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('command.register', (_, e) => {
    r.commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('turn.step', async function* (_, e) {
    r.sent.push(e.effort)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: zero() }
  })
  on('model.complete', () => {
    r.completes += 1
    return { value: { isAnswered: true, text: o.reply ?? '{}', usage: { ...zero(), input_tokens: o.reportedInput ?? 0 } } }
  })
  on('ui.toast', (_, e) => {
    r.toasts.push(e.text)
    return { value: undefined }
  })
  on('fs.exists', (_, e) => ({ value: r.files.has(e.path) || r.unreadable.has(e.path) }))
  on('fs.read', (_, e) => {
    if (r.unreadable.has(e.path)) throw new Error('EACCES')
    return { value: r.files.get(e.path) ?? '' }
  })
  on('fs.write', (_, e) => {
    r.files.set(e.path, e.text)
    r.writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  return r
}

let n = 0
// Hosts stamp `origin` and `presentation` on a command run; a test reaches it as any.
const slash = ($: any, args: string) =>
  $.command.run({ command: 'effort-optimizer', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
// One turn: the prompt, the turn's start, its first model request at the session's level, its end.
const turn = async ($: any, r: Rig, text: string, steps = 1) => {
  const turnId = `t${(n += 1)}`
  await $.prompt.submit({ text })
  await $.turn.start({ text, turnId })
  for (let index = 0; index < steps; index += 1) {
    const stream = $.turn.step({ turnId, index, model: r.model.value, effort: r.level.value, messageCount: 1 + index })
    for (;;) {
      const step = await stream.next()
      if (step.done) break
    }
  }
  await $.turn.complete({ answer: 'done', durationMs: 10, isAborted: false, turnId, reason: 'answer' })
  await r.clock.settle()
}

const START = { cwd: '/', surface: 'terminal', isInteractive: true } as const

describe('suggest mode (default)', () => {
  test('offers a switch, leaves the request alone, applies it when pressed', async ($, on) => {
    const r = rig(on)
    await $.session.start(START)
    expect(r.commands).toEqual(['effort-optimizer'])

    await turn($, r, 'Investigate why the build is flaky and plan a migration of the legacy pipeline')
    expect(r.sent).toEqual(['medium']) // nothing changed by itself
    const ui = await $.ui.mount({ ...ABOVE, surface: 'terminal' })
    expect((await ui.find({ key: 'switch' }))?.text).toBe('Switch to xhigh')

    await ui.press({ key: 'switch' })
    expect(r.toasts.at(-1)).toMatch(/medium -> xhigh/)
    // The offer is gone, and the next request goes out at xhigh on every step.
    expect(await ui.find({ key: 'switch' })).toBeUndefined()
    await turn($, r, 'ok continue with that', 2)
    expect(r.sent.slice(1)).toEqual(['xhigh', 'xhigh'])
    await ui.unmount()
  })

  test('no offer when the pick equals the current level', async ($, on) => {
    const r = rig(on)
    await $.session.start(START)
    await turn($, r, 'Add a dark mode toggle to the settings page')
    const ui = await $.ui.mount({ ...ABOVE, surface: 'terminal' })
    expect(await ui.find({ key: 'switch' })).toBeUndefined()
    await ui.unmount()
  })

  test('no offer inside the cooldown', { options: { mode: 'auto', cooldownTurns: 3 } }, async ($, on) => {
    const r = rig(on)
    await $.session.start(START)
    await turn($, r, 'plan the redesign of the whole thing, step by step') // auto switch to high at turn 1
    await slash($, 'suggest')
    await turn($, r, 'rename foo to bar') // pick low, but cooling down
    const ui = await $.ui.mount({ ...ABOVE, surface: 'terminal' })
    expect(await ui.find({ key: 'switch' })).toBeUndefined()
    await ui.unmount()
  })
})

describe('auto mode', () => {
  test('switches by itself, toasts, and logs one info entry', { options: { mode: 'auto' } }, async ($, on) => {
    const r = rig(on)
    await $.session.start(START)
    await turn($, r, 'rename the variable foo to bar', 2)
    expect(r.sent).toEqual(['low', 'low']) // the rewrite is repeated on each step
    expect(r.toasts).toHaveLength(1)
    expect(r.toasts[0]).toMatch(/medium -> low/)

    await $.session.end({ reason: 'other', sessionId: 'sess-1', resume: { id: 'sess-1' } })
    const w = r.writes.at(-1)
    expect(w?.path).toBe('/home/t/.claude/claude-mods/ledger/effort-optimizer.sess-1.jsonl')
    const rows = (w?.text ?? '').trim().split('\n').map(l => JSON.parse(l))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ v: 1, mod: 'effort-optimizer', kind: 'info', session: 'sess-1' })
    expect(rows[0].tokensAvoided).toBeUndefined()
    expect(rows[0].note).not.toMatch(/rename the variable/) // never the prompt text
  })

  test('the cooldown holds back a downgrade', { options: { mode: 'auto', cooldownTurns: 2 } }, async ($, on) => {
    const r = rig(on)
    await $.session.start(START)
    await turn($, r, 'plan and design the new architecture step by step') // turn 1: high
    await turn($, r, 'rename foo to bar') // turn 2: low, but cooling down
    expect(r.sent).toEqual(['high', 'high'])
    await turn($, r, 'rename foo to bar') // turn 3: allowed
    expect(r.sent).toEqual(['high', 'high', 'low'])
    expect(r.toasts).toHaveLength(2)
  })

  test('the cooldown never blocks an upgrade', { options: { mode: 'auto', cooldownTurns: 5 } }, async ($, on) => {
    const r = rig(on)
    await $.session.start(START)
    await turn($, r, 'rename foo to bar') // turn 1: low
    await turn($, r, 'Drop the users table in production') // turn 2: xhigh at once, at its first step
    expect(r.sent).toEqual(['low', 'xhigh'])
    await turn($, r, 'rename foo to bar') // downgrade: cooling down since turn 2
    expect(r.sent.at(-1)).toBe('xhigh')
    expect(r.toasts).toHaveLength(2)
  })

  test('an upgrade is still offered inside the cooldown in suggest mode', { options: { mode: 'auto', cooldownTurns: 5 } }, async ($, on) => {
    const r = rig(on)
    await $.session.start(START)
    await turn($, r, 'rename foo to bar') // auto: low
    await slash($, 'suggest')
    await turn($, r, 'Drop the users table in production')
    const ui = await $.ui.mount({ ...ABOVE, surface: 'terminal' })
    expect((await ui.find({ key: 'switch' }))?.text).toBe('Switch to xhigh')
    await ui.unmount()
  })

  test('a level the person set wins; respectManual off lets the mod override it',
    { options: { mode: 'auto', cooldownTurns: 1 } }, async ($, on) => {
    const r = rig(on)
    await $.session.start(START)
    await turn($, r, 'rename foo to bar') // low applied; the engine still says medium
    r.level.value = 'max' // the person runs /effort max
    await turn($, r, 'rename foo to baz')
    expect(r.sent).toEqual(['low', 'max'])
    await turn($, r, 'rename foo to qux')
    expect(r.sent.at(-1)).toBe('max')
  })

  test('respectManual off overrides the person', { options: { mode: 'auto', respectManual: false, cooldownTurns: 1 } }, async ($, on) => {
    const r = rig(on)
    await $.session.start(START)
    await turn($, r, 'add a button')
    r.level.value = 'max'
    await turn($, r, 'rename foo to bar')
    expect(r.sent).toEqual(['medium', 'low'])
  })

  test('a manual choice expires after manualHoldTurns turns', { options: { mode: 'auto', cooldownTurns: 1, manualHoldTurns: 3 } }, async ($, on) => {
    const r = rig(on)
    await $.session.start(START)
    await turn($, r, 'add a button') // turn 1: medium, nothing to do
    r.level.value = 'high' // the person runs /effort high
    await turn($, r, 'rename foo to bar') // turn 2: detected, held
    await turn($, r, 'rename foo to bar') // turn 3: held
    await turn($, r, 'rename foo to bar') // turn 4: held (the hold is turns 2, 3 and 4)
    expect(r.sent).toEqual(['medium', 'high', 'high', 'high'])
    expect(await slash($, '')).toMatchObject({ text: expect.stringContaining('you set a level yourself') })
    await turn($, r, 'rename foo to bar') // turn 5: expired, so the downgrade goes through
    expect(r.sent.at(-1)).toBe('low')
    expect(await slash($, '')).not.toMatchObject({ text: expect.stringContaining('you set a level yourself') })
  })

  test('manualHoldTurns 0 never expires', { options: { mode: 'auto', cooldownTurns: 1, manualHoldTurns: 0 } }, async ($, on) => {
    const r = rig(on)
    await $.session.start(START)
    await turn($, r, 'add a button')
    r.level.value = 'high'
    for (let i = 0; i < 15; i += 1) await turn($, r, 'rename foo to bar')
    expect(new Set(r.sent.slice(1))).toEqual(new Set(['high']))
  })

  test('a new manual change restarts the hold', { options: { mode: 'auto', cooldownTurns: 1, manualHoldTurns: 2 } }, async ($, on) => {
    const r = rig(on)
    await $.session.start(START)
    await turn($, r, 'add a button')
    r.level.value = 'high'
    await turn($, r, 'rename foo to bar') // turn 2: held (turns 2 and 3)
    r.level.value = 'max'
    await turn($, r, 'rename foo to bar') // turn 3: another change: held from turn 3 (turns 3 and 4)
    await turn($, r, 'rename foo to bar') // turn 4: held
    expect(r.sent).toEqual(['medium', 'high', 'max', 'max'])
    await turn($, r, 'rename foo to bar') // turn 5: expired
    expect(r.sent.at(-1)).toBe('low')
  })

  test('a model switch that moves the default effort is not a manual choice', { options: { mode: 'auto', cooldownTurns: 1 } }, async ($, on) => {
    const r = rig(on)
    await $.session.start(START)
    await turn($, r, 'rename foo to bar') // low applied on opus (default medium)
    r.model.value = 'sonnet' // /model: the new model's own default is high
    r.level.value = 'high'
    await turn($, r, 'rename foo to bar')
    expect(r.sent).toEqual(['low', 'low']) // our level stands; nothing was taken for the person's
    expect(await slash($, '')).not.toMatchObject({ text: expect.stringContaining('you set a level yourself') })
    await turn($, r, 'plan and design the new architecture step by step, then check security')
    expect(r.sent.at(-1)).not.toBe('low') // so the mod still switches in auto mode
  })

  test('the same level change on an unchanged model is manual', { options: { mode: 'auto', cooldownTurns: 1 } }, async ($, on) => {
    const r = rig(on)
    await $.session.start(START)
    await turn($, r, 'rename foo to bar')
    r.level.value = 'high' // no model change this time
    await turn($, r, 'rename foo to bar')
    expect(r.sent).toEqual(['low', 'high'])
  })

  test('an upgrade for a costly prompt goes through a manual hold, never past xhigh', { options: { mode: 'auto', cooldownTurns: 1 } }, async ($, on) => {
    const r = rig(on)
    await $.session.start(START)
    await turn($, r, 'add a button') // medium
    r.level.value = 'low' // the person runs /effort low
    await turn($, r, 'plan and design the new architecture step by step') // held: a plain upgrade waits
    expect(r.sent).toEqual(['medium', 'low'])
    await turn($, r, 'Drop the users table in production') // costly: applied despite the hold
    expect(r.sent.at(-1)).toBe('xhigh')
    expect(r.toasts.at(-1)).toMatch(/low -> xhigh/)
  })

  test('a manual max is never lowered by a costly prompt', { options: { mode: 'auto', cooldownTurns: 1 } }, async ($, on) => {
    const r = rig(on)
    await $.session.start(START)
    await turn($, r, 'add a button')
    r.level.value = 'max'
    await turn($, r, 'Drop the users table in production')
    await turn($, r, 'Drop the users table in production')
    expect(r.sent).toEqual(['medium', 'max', 'max'])
    expect(r.toasts).toHaveLength(0)
  })

  test('no downgrade during a manual hold, even after an upgrade went through', { options: { mode: 'auto', cooldownTurns: 1 } }, async ($, on) => {
    const r = rig(on)
    await $.session.start(START)
    await turn($, r, 'add a button')
    r.level.value = 'high'
    await turn($, r, 'rename foo to bar') // held
    await turn($, r, 'Drop the users table in production') // upgrade high -> xhigh
    await turn($, r, 'rename foo to bar') // a downgrade: blocked
    await turn($, r, 'rename foo to bar')
    expect(r.sent).toEqual(['medium', 'high', 'xhigh', 'xhigh', 'xhigh'])
  })

  test('a subagent step is never rewritten', { options: { mode: 'auto' } }, async ($, on) => {
    const r = rig(on)
    await $.session.start(START)
    await turn($, r, 'rename foo to bar') // low applied on main
    const stream = $.turn.step({ turnId: 'sub', index: 0, model: 'opus', effort: 'medium', messageCount: 1, agentId: 'a1' })
    for (;;) if ((await stream.next()).done) break
    expect(r.sent).toEqual(['low', 'medium'])
  })

  test('leaves a model without effort alone', { options: { mode: 'auto' } }, async ($, on) => {
    const r = rig(on)
    await $.session.start(START)
    r.level.value = undefined
    await turn($, r, 'rename foo to bar')
    expect(r.sent).toEqual([undefined])
    expect(r.toasts).toHaveLength(0)
  })
})

describe('off mode, the command and the small model', () => {
  test('off does nothing at all', { options: { mode: 'off' } }, async ($, on) => {
    const r = rig(on)
    await $.session.start(START)
    await turn($, r, 'rename foo to bar')
    expect(r.sent).toEqual(['medium'])
    expect(r.toasts).toHaveLength(0)
    expect(r.completes).toBe(0)
  })

  test('/effort-optimizer changes the mode at runtime', async ($, on) => {
    const r = rig(on)
    await $.session.start(START)
    expect((await slash($, '')).text).toMatch(/mode suggest/)
    expect((await slash($, 'auto')).text).toMatch(/now auto/)
    await turn($, r, 'rename foo to bar')
    expect(r.sent).toEqual(['low'])
    expect((await slash($, 'off')).text).toMatch(/now off/)
    await turn($, r, 'add a button')
    expect(r.sent.at(-1)).toBe('medium') // switching off also stops applying our level
    expect((await slash($, 'on')).text).toMatch(/now suggest/)
    expect((await slash($, 'wat')).text).toMatch(/Usage/)
  })

  test('/clear resets the cooldown and our level', { options: { mode: 'auto', cooldownTurns: 5 } }, async ($, on) => {
    const r = rig(on)
    await $.session.start(START)
    await turn($, r, 'rename foo to bar')
    await $.session.end({ reason: 'clear', sessionId: 'sess-1', resume: { id: 'sess-1' } })
    await turn($, r, 'plan and design the new architecture step by step')
    expect(r.sent).toEqual(['low', 'high'])
  })

  test('useModel asks haiku once per prompt and merges its answers', { options: { mode: 'auto', useModel: true } }, async ($, on) => {
    const r = rig(on, { reply: '{"mechanical":false,"planning":true,"unfamiliar":true,"costly":false}' })
    await $.session.start(START)
    await turn($, r, 'add a button')
    expect(r.completes).toBe(1)
    expect(r.sent).toEqual(['xhigh'])
  })

  test('a useless model reply falls back to the rules', { options: { mode: 'auto', useModel: true } }, async ($, on) => {
    const r = rig(on, { reply: 'I cannot say' })
    await $.session.start(START)
    await turn($, r, 'rename foo to bar')
    expect(r.sent).toEqual(['low'])
  })

  test('the haiku call is logged as helper cost: cost-upgrade, helperTokens, negative dollars, no prompt text',
    { options: { mode: 'auto', useModel: true } }, async ($, on) => {
    const r = rig(on, { reply: '{"mechanical":true,"planning":false,"unfamiliar":false,"costly":false}' })
    await $.session.start(START)
    const text = 'rename secretword to other'
    await turn($, r, text)
    await $.session.end({ reason: 'other', sessionId: 'sess-1', resume: { id: 'sess-1' } })
    const rows = rowsOf(r, F1)
    const helper = rows.filter(x => x.kind === 'cost-upgrade')
    expect(helper).toHaveLength(1)
    expect(helper[0].helperTokens).toBe(Math.ceil((modelPrompt(text).length + '{"mechanical":true,"planning":false,"unfamiliar":false,"costly":false}'.length) / 4))
    expect(helper[0].costUsdEstimate).toBeLessThan(0)
    expect(Math.abs(helper[0].costUsdEstimate + (helper[0].helperTokens * 0.1) / 1_000_000)).toBeLessThan(1e-12)
    expect(helper[0].tokensAvoided).toBeUndefined()
    expect(helper[0].note).toMatch(/effort classifier call/)
    expect(helper[0].note).not.toMatch(/secretword/)
    // The switch itself is still an info line with no figures.
    expect(rows.filter(x => x.kind === 'info')).toHaveLength(1)
  })

  test('reported usage wins over the character estimate', { options: { mode: 'auto', useModel: true } }, async ($, on) => {
    const r = rig(on, { reportedInput: 500 })
    await $.session.start(START)
    await turn($, r, 'add a button')
    await $.session.end({ reason: 'other', sessionId: 'sess-1', resume: { id: 'sess-1' } })
    const helper = rowsOf(r, F1).filter(x => x.kind === 'cost-upgrade')
    expect(helper).toHaveLength(1)
    expect(helper[0].helperTokens).toBe(500)
    expect(Math.abs(helper[0].costUsdEstimate + 0.00005)).toBeLessThan(1e-12)
  })

  test('without useModel no helper line is logged', { options: { mode: 'auto' } }, async ($, on) => {
    const r = rig(on)
    await $.session.start(START)
    await turn($, r, 'rename foo to bar')
    await $.session.end({ reason: 'other', sessionId: 'sess-1', resume: { id: 'sess-1' } })
    expect(rowsOf(r, F1).filter(x => x.kind === 'cost-upgrade')).toHaveLength(0)
  })
})

describe('the manual hold by mode', () => {
  test('respectManual off: no hold at all, so the command shows none', { options: { mode: 'auto', respectManual: false, cooldownTurns: 1 } }, async ($, on) => {
    const r = rig(on)
    await $.session.start(START)
    await turn($, r, 'add a button')
    r.level.value = 'low' // the person changes the level
    await turn($, r, 'Drop the users table in production')
    expect(r.sent.at(-1)).toBe('xhigh')
    expect(await slash($, '')).not.toMatchObject({ text: expect.stringContaining('you set a level yourself') })
  })

  test('respectManual on: the same change is recorded as a hold', { options: { mode: 'auto', cooldownTurns: 1 } }, async ($, on) => {
    const r = rig(on)
    await $.session.start(START)
    await turn($, r, 'add a button')
    r.level.value = 'low'
    await turn($, r, 'add a button')
    expect(await slash($, '')).toMatchObject({ text: expect.stringContaining('you set a level yourself') })
  })

  test('suggest mode: a hold never suppresses an offer', async ($, on) => {
    const r = rig(on)
    await $.session.start(START)
    await turn($, r, 'add a button')
    r.level.value = 'low' // the person lowers the level: a hold is recorded
    await turn($, r, 'Drop the users table in production')
    expect(await slash($, '')).toMatchObject({ text: expect.stringContaining('you set a level yourself') })
    const ui = await $.ui.mount({ ...ABOVE, surface: 'terminal' })
    expect((await ui.find({ key: 'switch' }))?.text).toBe('Switch to xhigh')
    await ui.unmount()
  })
})

const begin = async ($: any, text: string) => {
  const turnId = `t${(n += 1)}`
  await $.prompt.submit({ text })
  await $.turn.start({ text, turnId })
  return turnId
}
const step = async ($: any, r: Rig, turnId: string, index: number) => {
  const stream = $.turn.step({ turnId, index, model: 'opus', effort: r.level.value, messageCount: 1 + index })
  for (;;) if ((await stream.next()).done) break
}
const finish = async ($: any, r: Rig, turnId: string) => {
  await $.turn.complete({ answer: 'done', durationMs: 10, isAborted: false, turnId, reason: 'answer' })
  await r.clock.settle()
}

describe('a Switch pressed during a running turn', () => {
  test('leaves the rest of the turn alone and applies from the next turn', async ($, on) => {
    const r = rig(on)
    await $.session.start(START)
    const t1 = await begin($, 'Investigate why the build is flaky and plan a migration of the legacy pipeline')
    await step($, r, t1, 0)
    const ui = await $.ui.mount({ ...ABOVE, surface: 'terminal' })
    expect((await ui.find({ key: 'switch' }))?.text).toBe('Switch to xhigh from next prompt')
    await ui.press({ key: 'switch' })
    expect(r.toasts.at(-1)).toMatch(/next prompt/)
    expect(await ui.find({ key: 'switch' })).toBeUndefined()
    await step($, r, t1, 1)
    await step($, r, t1, 2)
    expect(r.sent).toEqual(['medium', 'medium', 'medium']) // the running turn's later steps are not rewritten
    expect((await slash($, '')).text).toMatch(/xhigh queued/)
    await finish($, r, t1)
    await turn($, r, 'ok continue with that', 2)
    expect(r.sent.slice(3)).toEqual(['xhigh', 'xhigh'])
    expect(r.toasts.at(-1)).toMatch(/medium -> xhigh/)
    await ui.unmount()
  })

  test('an auto upgrade for a risky prompt applies at that turn\'s first step', { options: { mode: 'auto', cooldownTurns: 5 } }, async ($, on) => {
    const r = rig(on)
    await $.session.start(START)
    await turn($, r, 'rename foo to bar')
    const t = await begin($, 'Drop the users table in production')
    await step($, r, t, 0)
    await step($, r, t, 1)
    expect(r.sent.slice(1)).toEqual(['xhigh', 'xhigh'])
    await finish($, r, t)
  })

  test('/clear forgets a queued switch', async ($, on) => {
    const r = rig(on)
    await $.session.start(START)
    const t1 = await begin($, 'Investigate why the build is flaky and plan a migration of the legacy pipeline')
    await step($, r, t1, 0)
    const ui = await $.ui.mount({ ...ABOVE, surface: 'terminal' })
    await ui.press({ key: 'switch' })
    await $.session.end({ reason: 'clear', sessionId: 'sess-1', resume: { id: 'sess-1' } })
    await turn($, r, 'add a button')
    expect(r.sent.at(-1)).toBe('medium')
    await ui.unmount()
  })
})

const F1 = '/home/t/.claude/claude-mods/ledger/effort-optimizer.sess-1.jsonl'
const F2 = '/home/t/.claude/claude-mods/ledger/effort-optimizer.sess-2.jsonl'
const rowsOf = (r: Rig, path: string) =>
  (r.files.get(path) ?? '').split('\n').filter(l => l !== '').map(l => JSON.parse(l))

describe('the ledger rules', () => {
  test('after /clear the old file is flushed first, then the new session id gets its own file', { options: { mode: 'auto', cooldownTurns: 1 } }, async ($, on) => {
    const r = rig(on)
    r.files.set(F2, 'null\n[1]\n{"v":1,"mod":"effort-optimizer","kind":"info","note":"kept","session":"sess-2"}\nnot json')
    await $.session.start(START)
    await turn($, r, 'rename foo to bar') // written at once
    await turn($, r, 'plan and design the new architecture step by step') // second entry: inside the flush window
    expect(rowsOf(r, F1)).toHaveLength(1)
    r.sessionId.value = 'sess-2'
    await $.session.end({ reason: 'clear', sessionId: 'sess-1', resume: { id: 'sess-1' } })
    expect(rowsOf(r, F1)).toHaveLength(2) // the old file got its pending entry
    expect(r.files.get(F2)).toMatch(/not json/) // the new file is untouched until an entry is added
    await r.clock.advance(6000) // past the flush window, so the new entry is written now
    await turn($, r, 'rename foo to baz')
    const rows2 = r.files.get(F2)!.trim().split('\n')
    expect(rows2).toHaveLength(2) // junk dropped, the valid old line kept, one new entry
    expect(JSON.parse(rows2[1]!)).toMatchObject({ session: 'sess-2', mod: 'effort-optimizer' })
    expect(rowsOf(r, F1)).toHaveLength(2)
  })

  test('no session id: the ledger is off, the mod and the command still work', { options: { mode: 'auto' } }, async ($, on) => {
    const r = rig(on)
    r.sessionId.value = undefined
    await $.session.start(START)
    expect(r.commands).toEqual(['effort-optimizer'])
    await turn($, r, 'rename foo to bar')
    await $.session.end({ reason: 'other', sessionId: 'x', resume: { id: 'x' } })
    expect(r.sent).toEqual(['low'])
    expect(r.writes).toHaveLength(0) // never a shared `unknown` file
  })

  test('a read error other than missing turns the ledger off instead of overwriting', { options: { mode: 'auto' } }, async ($, on) => {
    const r = rig(on)
    r.unreadable.add(F1)
    await $.session.start(START)
    await turn($, r, 'rename foo to bar')
    await $.session.end({ reason: 'other', sessionId: 'sess-1', resume: { id: 'sess-1' } })
    expect(r.writes).toHaveLength(0)
    expect(r.sent).toEqual(['low'])
  })

  test('the session id is sanitised in the file name', { options: { mode: 'auto' } }, async ($, on) => {
    const r = rig(on)
    r.sessionId.value = '../a.b/c'
    await $.session.start(START)
    await turn($, r, 'rename foo to bar')
    expect(r.writes.map(w => w.path)).toEqual([`/home/t/.claude/claude-mods/ledger/effort-optimizer.${sanitizeSessionId('../a.b/c')}.jsonl`])
    expect(r.writes[0]!.path).not.toMatch(/\.\./)
    expect(r.writes[0]!.path.split('/').pop()).toBe('effort-optimizer.___a_b_c.jsonl')
  })
})

describe('the session field', () => {
  test('lines carry the sanitised id, the same value as the file name', { options: { mode: 'auto' } }, async ($, on) => {
    const r = rig(on)
    r.sessionId.value = '../a.b/c'
    await $.session.start(START)
    await turn($, r, 'rename foo to bar')
    const w = r.writes.at(-1)!
    const row = JSON.parse(w.text.trim().split('\n').at(-1)!)
    expect(row.session).toBe('___a_b_c')
    expect(w.path.endsWith(`.${row.session}.jsonl`)).toBe(true)
    expect(row.session).toBe(sanitizeSessionId('../a.b/c'))
  })
})

describe('session.start never throws', () => {
  test('the command is registered when the session id and HOME both fail', { options: { mode: 'auto' } }, async ($, on) => {
    const r = rig(on, { envThrows: true })
    r.sessionId.value = undefined
    await $.session.start(START)
    expect(r.commands).toEqual(['effort-optimizer'])
    await turn($, r, 'rename foo to bar')
    expect(r.sent).toEqual(['low'])
    expect(r.writes).toHaveLength(0)
  })

  test('the command is registered when reading the ledger throws', async ($, on) => {
    const r = rig(on)
    r.unreadable.add(F1)
    await $.session.start(START)
    expect(r.commands).toEqual(['effort-optimizer'])
  })
})
