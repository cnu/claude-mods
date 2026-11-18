import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { effectiveState, enabledFromSettings, isEnabledValue, openCommands, parseEnabled, parseInstalled, parseManifest, splitId, withEnabled } from './logic'

const PANE = {
  plugin: 'mods',
  component: 'Pane',
  requestId: 'mods',
  props: {
    title: 'Mods',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const RECORD = JSON.stringify({
  version: 2,
  plugins: {
    'alpha@market': [
      { scope: 'project', installPath: '/p/alpha-proj', version: '0.9.0' },
      { scope: 'user', installPath: '/p/alpha', version: '1.0.0' },
    ],
    'beta@market': [{ scope: 'user', installPath: '/p/beta', version: '2.0.0' }],
    'mods@mine': [{ scope: 'user', installPath: '/p/mods', version: '0.1.0' }],
    'broken@market': [{ scope: 'user' }],
  },
})
const SETTINGS = JSON.stringify({ theme: 'dark', enabledPlugins: { 'alpha@market': true, 'beta@market': false } }, null, 2)

describe('parser', () => {
  test('reads the installed-plugins record', async () => {
    const { entries, error } = parseInstalled(RECORD)
    expect(error).toBe(null)
    expect(entries.map(e => e.id)).toEqual(['alpha@market', 'beta@market', 'mods@mine'])
    // user scope wins over project scope
    expect(entries[0]!).toEqual({ id: 'alpha@market', name: 'alpha', marketplace: 'market', scope: 'user', installPath: '/p/alpha', version: '1.0.0' })
  })
  test('survives garbage and odd shapes', async () => {
    expect(parseInstalled('not json').error).toMatch(/not valid JSON/)
    expect(parseInstalled('[]').entries).toEqual([])
    expect(parseInstalled('{"plugins":[]}').error).toMatch(/no "plugins"/)
    const old = parseInstalled('{"plugins":{"x@y":{"installPath":"/x","version":"3"}}}')
    expect(old.entries[0]?.installPath).toBe('/x')
    expect(parseInstalled('{"plugins":{"x@y":[null,5,"s"]}}').entries).toEqual([])
  })
  test('splits ids on the last at-sign', async () => {
    expect(splitId('a@b@c')).toEqual({ name: 'a@b', marketplace: 'c' })
    expect(splitId('solo')).toEqual({ name: 'solo', marketplace: '' })
  })
  test('manifest and enabled map', async () => {
    expect(parseManifest('{"name":"n","version":"1","description":"d"}')).toEqual({ name: 'n', version: '1', description: 'd' })
    expect(parseManifest('{{')).toEqual({})
    expect(parseEnabled(SETTINGS)).toEqual({ 'alpha@market': true, 'beta@market': false })
    expect(parseEnabled('')).toEqual({})
    expect(isEnabledValue(true)).toBe(true)
    expect(isEnabledValue(false)).toBe(false)
    expect(isEnabledValue(undefined)).toBe(false)
    expect(isEnabledValue(['v'])).toBe(true)
  })
  test('withEnabled changes one key and refuses damaged files', async () => {
    const r = withEnabled(SETTINGS, 'beta@market', true)
    if (!r.ok) throw new Error('should be ok')
    expect(JSON.parse(r.text)).toEqual({ theme: 'dark', enabledPlugins: { 'alpha@market': true, 'beta@market': true } })
    const fresh = withEnabled(null, 'x@y', false)
    expect(fresh.ok && JSON.parse(fresh.text)).toEqual({ enabledPlugins: { 'x@y': false } })
    // an existing but empty file is not "missing": refuse
    expect(withEnabled('', 'x@y', true).ok).toBe(false)
    expect(withEnabled('  \n', 'x@y', true).ok).toBe(false)
    expect(withEnabled('{oops', 'x@y', true).ok).toBe(false)
    expect(withEnabled('[]', 'x@y', true).ok).toBe(false)
    expect(withEnabled('{"enabledPlugins":[1]}', 'x@y', true).ok).toBe(false)
  })
  test('open commands: own plugin only, pane-like only', async () => {
    const cmds = [
      { name: 'alpha', description: 'x', plugin: 'alpha' },
      { name: 'alpha-log', description: 'Show the log in a pane', plugin: 'alpha' },
      { name: 'alpha-run', description: 'Runs it', plugin: 'alpha' },
      { name: 'other', description: 'open pane', plugin: 'beta' },
    ]
    expect(openCommands('alpha', cmds)).toEqual(['alpha', 'alpha-log'])
    expect(openCommands('none', cmds)).toEqual([])
    // a command whose description mentions arguments is not offered
    const withArgs = [
      { name: 'alpha', description: 'Open the pane for <name>', plugin: 'alpha' },
      { name: 'alpha-log', description: 'Show the log pane', plugin: 'alpha' },
    ]
    expect(openCommands('alpha', withArgs)).toEqual(['alpha-log'])
  })
  test('effective state: local beats project beats user', async () => {
    const m = (user: object, project: object, local: object) => effectiveState('a@m', { user, project, local } as never)
    expect(m({ 'a@m': true }, {}, {})).toMatchObject({ enabled: true, winner: 'user', note: '', overridden: false })
    expect(m({ 'a@m': true }, { 'a@m': false }, {})).toMatchObject({ enabled: false, winner: 'project', note: 'off in project settings', overridden: true })
    expect(m({}, { 'a@m': true }, {})).toMatchObject({ enabled: true, note: 'on in project settings' })
    expect(m({ 'a@m': false }, { 'a@m': true }, { 'a@m': false })).toMatchObject({ enabled: false, winner: 'local', note: 'off in local settings' })
    expect(m({}, {}, {})).toMatchObject({ enabled: false, winner: 'none' })
  })
  test('effective state: managed policy is the highest scope, then the flag', async () => {
    const m = (maps: object) => effectiveState('a@m', { user: {}, project: {}, local: {}, ...maps } as never)
    expect(m({ user: { 'a@m': true }, policy: { 'a@m': false } })).toMatchObject({ enabled: false, winner: 'policy', note: 'off in managed policy settings', overridden: true })
    expect(m({ local: { 'a@m': true }, flag: { 'a@m': false } })).toMatchObject({ enabled: false, winner: 'flag' })
    expect(m({ flag: { 'a@m': false }, policy: { 'a@m': true } })).toMatchObject({ enabled: true, winner: 'policy' })
    // a policy that does not mention the mod changes nothing; an unreadable policy is simply left out
    expect(m({ user: { 'a@m': true }, policy: {} })).toMatchObject({ enabled: true, winner: 'user' })
    expect(enabledFromSettings({ enabledPlugins: { 'a@m': true } })).toEqual({ 'a@m': true })
    expect(enabledFromSettings(undefined)).toEqual({})
    expect(enabledFromSettings({ enabledPlugins: [1] })).toEqual({})
  })
})

type Rig = {
  writes: { path: string; text: string }[]
  ran: string[]
  opened: number
  files: Record<string, string>
  /** Paths that exist but whose read throws (permission error, not ENOENT). */
  unreadable: Set<string>
  /** Writes to a path containing one of these strings throw. */
  failWrite: string[]
  existsFails: boolean
  /** What `$.settings.read({source})` answers per source; `policy: 'throw'` makes that read fail. */
  sources: { policy: Record<string, unknown> | 'throw'; flag: Record<string, unknown> | 'throw' }
}

const rig = (on: On, files: Record<string, string> = {}): Rig => {
  const r: Rig = {
    writes: [],
    ran: [],
    opened: 0,
    unreadable: new Set(),
    failWrite: [],
    existsFails: false,
    sources: { policy: {}, flag: {} },
    files: {
      '/home/t/.claude/plugins/installed_plugins.json': RECORD,
      '/home/t/.claude/settings.json': SETTINGS,
      '/p/alpha/.claude-plugin/plugin.json': '{"name":"alpha","version":"1.0.1","description":"Alpha does things"}',
      '/p/beta/.claude-plugin/plugin.json': '{"name":"beta","description":"Beta thing"}',
      '/p/mods/.claude-plugin/plugin.json': '{"name":"mods","description":"Self"}',
      ...files,
    },
    }
  mock.env(on, { HOME: '/home/t' })
  mock.store(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: '/proj' }))
  on('clock.now', () => ({ value: 1_700_000_000_000 }))
  on('fs.exists', (_, e) => {
    if (r.existsFails) throw new Error('EIO')
    return { value: r.files[e.path] !== undefined || r.unreadable.has(e.path) }
  })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('command.list', () => ({
    value: [
      { name: 'alpha', description: 'Opens the alpha pane', source: 'plugin', plugin: 'alpha' },
      { name: 'beta-x', description: 'Does work', source: 'plugin', plugin: 'beta' },
    ],
  }))
  on('command.run', (_, e) => {
    r.ran.push(e.command)
    return { text: 'ok' }
  })
  on('ui.open', () => {
    r.opened += 1
    return { value: { isPlaced: true } }
  })
  on('fs.read', (_, e) => {
    if (r.unreadable.has(e.path)) throw new Error('EACCES: permission denied')
    const t = r.files[e.path]
    if (t === undefined) throw new Error('ENOENT')
    return { value: t }
  })
  on('settings.read', (_, e) => {
    const src = e.source === 'policy' || e.source === 'flag' ? r.sources[e.source] : {}
    if (src === 'throw') throw new Error('settings not readable')
    return { value: src }
  })
  on('fs.write', (_, e) => {
    if (r.failWrite.some(f => e.path.includes(f))) throw new Error('EROFS')
    r.writes.push({ path: e.path, text: e.text })
    r.files[e.path] = e.text
    return { value: undefined }
  })
  return r
}

const openPane = async ($: Engine, surface: 'terminal' | 'desktop') => {
  await $.session.start({ cwd: '/', surface, isInteractive: true })
  await $.command.run({
    command: 'mods',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  })
  return $.ui.mount({ ...PANE, surface })
}

describe('the pane', () => {
  test('lists mods with version, description and state, and writes nothing on its own', async ($, on) => {
    const r = rig(on)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await openPane($, surface)
      expect(await ui.find({ type: 'Text', text: /^alpha 1\.0\.1$/ })).toBeTruthy()
      expect(await ui.find({ type: 'Text', text: /\(market\)/ })).toBeTruthy()
      expect(await ui.find({ type: 'Text', text: /^ enabled$/ })).toBeTruthy()
      expect(await ui.find({ type: 'Text', text: /Alpha does things/ })).toBeTruthy()
      expect(await ui.find({ type: 'Text', text: /^beta 2\.0\.0$/ })).toBeTruthy()
      expect(await ui.find({ type: 'Text', text: /^ disabled$/ })).toBeTruthy()
      expect(await ui.find({ type: 'Text', text: /restart/ })).toBeTruthy()
      // broken record entry (no install path) is skipped, the mods mod has no toggle
      expect(await ui.find({ key: 'toggle-mods@mine' })).toBeFalsy()
      expect(await ui.find({ key: 'toggle-broken@market' })).toBeFalsy()
      // Open button only for the enabled mod with a pane-like command
      const openBtn = await ui.find({ key: 'open-alpha@market-alpha' })
      expect(openBtn).toBeTruthy()
      expect(await ui.find({ type: 'Button', text: /Open \/alpha \(runs it with no arguments\)/ })).toBeTruthy()
      expect(await ui.find({ key: 'open-beta@market-beta-x' })).toBeFalsy()
      await ui.unmount()
    }
    expect(r.writes).toEqual([])
  })

  test('the toggle writes the settings file once, only on press, and says restart', async ($, on) => {
    const r = rig(on)
    const ui = await openPane($, 'terminal')
    expect(r.writes.length).toBe(0)
    await ui.press({ key: 'toggle-beta@market' })
    // first a backup copy, then the settings file
    expect(r.writes.length).toBe(2)
    expect(r.writes[1]!.path).toBe('/home/t/.claude/settings.json')
    expect(JSON.parse(r.writes[1]!.text)).toEqual({
      theme: 'dark',
      enabledPlugins: { 'alpha@market': true, 'beta@market': true },
    })
    expect(await ui.find({ type: 'Text', text: /user setting now on, read after restart/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /was changed to on/ })).toBeTruthy()
    await ui.press({ key: 'toggle-beta@market' })
    // the second press in the same session adds no second backup
    expect(r.writes.length).toBe(3)
    expect(JSON.parse(r.writes[2]!.text).enabledPlugins['beta@market']).toBe(false)
    await ui.unmount()
  })

  test('a failed read of an existing settings file refuses and writes nothing', async ($, on) => {
    const r = rig(on)
    r.unreadable.add('/home/t/.claude/settings.json')
    delete r.files['/home/t/.claude/settings.json']
    const ui = await openPane($, 'terminal')
    await ui.press({ key: 'toggle-beta@market' })
    expect(r.writes).toEqual([])
    expect(await ui.find({ type: 'Text', text: /could not read .*settings\.json.*nothing was written/ })).toBeTruthy()
    await ui.unmount()
  })

  test('a failing exists check also refuses', async ($, on) => {
    const r = rig(on)
    r.existsFails = true
    const ui = await openPane($, 'terminal')
    await ui.press({ key: 'toggle-beta@market' })
    expect(r.writes).toEqual([])
    await ui.unmount()
  })

  test('an empty existing settings file is refused, not rewritten', async ($, on) => {
    const r = rig(on, { '/home/t/.claude/settings.json': '' })
    const ui = await openPane($, 'terminal')
    await ui.press({ key: 'toggle-beta@market' })
    expect(r.writes).toEqual([])
    await ui.unmount()
  })

  test('a confirmed-missing settings file is created, with no backup', async ($, on) => {
    const r = rig(on)
    delete r.files['/home/t/.claude/settings.json']
    const ui = await openPane($, 'terminal')
    await ui.press({ key: 'toggle-beta@market' })
    expect(r.writes.length).toBe(1)
    expect(r.writes[0]!.path).toBe('/home/t/.claude/settings.json')
    expect(JSON.parse(r.writes[0]!.text)).toEqual({ enabledPlugins: { 'beta@market': true } })
    await ui.unmount()
  })

  test('the first change writes a timestamped backup of the old text first', async ($, on) => {
    const r = rig(on)
    const ui = await openPane($, 'terminal')
    await ui.press({ key: 'toggle-beta@market' })
    expect(r.writes[0]!.path).toMatch(/^\/home\/t\/\.claude\/settings\.json\.mods-backup-2023-11-14T/)
    expect(r.writes[0]!.text).toBe(SETTINGS)
    expect(await ui.find({ type: 'Text', text: /A copy of the old file is at/ })).toBeTruthy()
    await ui.unmount()
  })

  test('if the backup cannot be written the change is refused: no backup, no write, clear notice', async ($, on) => {
    const r = rig(on)
    r.failWrite.push('.mods-backup')
    const ui = await openPane($, 'terminal')
    await ui.press({ key: 'toggle-beta@market' })
    expect(r.writes).toEqual([])
    expect(r.files['/home/t/.claude/settings.json']).toBe(SETTINGS)
    expect(await ui.find({ type: 'Text', text: /could not write a backup copy.*nothing was changed.*allowWithoutBackup/ })).toBeTruthy()
    // the row did not flip to "pending"
    expect(await ui.find({ type: 'Text', text: /read after restart/ })).toBeFalsy()
    await ui.unmount()
  })

  test('allowWithoutBackup: true lets the change through when the backup fails, and says so', { options: { allowWithoutBackup: true } }, async ($, on) => {
    const r = rig(on)
    r.failWrite.push('.mods-backup')
    const ui = await openPane($, 'terminal')
    await ui.press({ key: 'toggle-beta@market' })
    expect(r.writes.length).toBe(1)
    expect(r.writes[0]!.path).toBe('/home/t/.claude/settings.json')
    expect(await ui.find({ type: 'Text', text: /allowWithoutBackup is on, so the change went ahead without one/ })).toBeTruthy()
    await ui.unmount()
  })

  test('allowWithoutBackup: true does not skip a backup that can be written', { options: { allowWithoutBackup: true } }, async ($, on) => {
    const r = rig(on)
    const ui = await openPane($, 'terminal')
    await ui.press({ key: 'toggle-beta@market' })
    expect(r.writes.length).toBe(2)
    expect(r.writes[0]!.path).toMatch(/\.mods-backup-/)
    await ui.unmount()
  })

  test('managed policy settings that can be read decide the state and block the toggle claim', async ($, on) => {
    const r = rig(on)
    r.sources.policy = { enabledPlugins: { 'alpha@market': false } }
    const ui = await openPane($, 'terminal')
    expect(await ui.find({ type: 'Text', text: /^ disabled \(off in managed policy settings\)$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /not visible to this mod/ })).toBeFalsy()
    await ui.press({ key: 'toggle-alpha@market' })
    expect(await ui.find({ type: 'Text', text: /managed policy settings, and that wins over user settings/ })).toBeTruthy()
    // a policy entry is never shown as a pending change
    expect(await ui.find({ type: 'Text', text: /read after restart/ })).toBeFalsy()
    await ui.unmount()
  })

  test('managed policy settings that cannot be read: standing line, and no claim the toggle took effect', async ($, on) => {
    const r = rig(on)
    r.sources.policy = 'throw'
    const ui = await openPane($, 'terminal')
    expect(await ui.find({ type: 'Text', text: /managed policy settings are not visible to this mod/ })).toBeTruthy()
    await ui.press({ key: 'toggle-beta@market' })
    // the standing line stays, and the notice says only that the user setting was changed
    expect(await ui.find({ type: 'Text', text: /managed policy settings are not visible to this mod/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /The user setting for beta@market was changed to on/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /cannot say whether a policy overrides it/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /set to on in|took effect|enabled after restart/ })).toBeFalsy()
    await ui.unmount()
  })

  test('a damaged file gets no backup and no change', async ($, on) => {
    const r = rig(on, { '/home/t/.claude/settings.json': '{"enabledPlugins": [' })
    const ui = await openPane($, 'terminal')
    await ui.press({ key: 'toggle-beta@market' })
    expect(r.writes).toEqual([])
    await ui.unmount()
  })

  test('project and local settings show where an override comes from', async ($, on) => {
    const r = rig(on, {
      '/proj/.claude/settings.json': JSON.stringify({ enabledPlugins: { 'alpha@market': false, 'beta@market': true } }),
      '/proj/.claude/settings.local.json': JSON.stringify({ enabledPlugins: { 'beta@market': false } }),
    })
    const ui = await openPane($, 'terminal')
    expect(await ui.find({ type: 'Text', text: /^ disabled \(off in project settings\)$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^ disabled \(off in local settings\)$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /wins over user settings/ })).toBeTruthy()
    // an override disabled alpha, so it gets no Open button
    expect(await ui.find({ key: 'open-alpha@market-alpha' })).toBeFalsy()
    expect(r.writes).toEqual([])
    // toggling still edits user settings only, and says the override wins
    await ui.press({ key: 'toggle-alpha@market' })
    expect(r.writes.map(w => w.path).every(p => p.startsWith('/home/t/.claude/'))).toBe(true)
    expect(await ui.find({ type: 'Text', text: /off in project settings, and that wins/ })).toBeTruthy()
    await ui.unmount()
  })

  test('a project-scope enable shows as enabled', async ($, on) => {
    rig(on, { '/proj/.claude/settings.json': JSON.stringify({ enabledPlugins: { 'beta@market': true } }) })
    const ui = await openPane($, 'terminal')
    expect(await ui.find({ type: 'Text', text: /^ enabled \(on in project settings\)$/ })).toBeTruthy()
    await ui.unmount()
  })

  test('a damaged settings file is never overwritten', async ($, on) => {
    const r = rig(on, { '/home/t/.claude/settings.json': '{broken' })
    const ui = await openPane($, 'terminal')
    await ui.press({ key: 'toggle-beta@market' })
    expect(r.writes).toEqual([])
    expect(await ui.find({ type: 'Text', text: /not valid JSON/ })).toBeTruthy()
    await ui.unmount()
  })

  test('Open runs the mod command', async ($, on) => {
    const r = rig(on)
    const ui = await openPane($, 'terminal')
    await ui.press({ key: 'open-alpha@market-alpha' })
    expect(r.ran).toEqual(['alpha'])
    expect(await ui.find({ type: 'Text', text: /Ran \/alpha with no arguments/ })).toBeTruthy()
    expect(r.writes).toEqual([])
    await ui.unmount()
  })

  test('a missing record shows a plain message', async ($, on) => {
    const r = rig(on)
    delete r.files['/home/t/.claude/plugins/installed_plugins.json']
    const ui = await openPane($, 'terminal')
    expect(await ui.find({ type: 'Text', text: /No installed-plugins record/ })).toBeTruthy()
    await ui.unmount()
  })
})
