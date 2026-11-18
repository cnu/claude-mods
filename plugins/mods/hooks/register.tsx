import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import {
  oneLine,
  openCommands,
  parseEnabled,
  parseInstalled,
  parseManifest,
  readSettings,
  effectiveState,
  enabledFromSettings,
  withEnabled,
} from './logic'
import type { SettingsRead } from './logic'

const PANE = 'mods'

type Row = {
  id: string
  name: string
  marketplace: string
  version: string
  description: string
  scope: string
  installPath: string
  isEnabled: boolean
  scopeNote: string
  isOverridden: boolean
  pending: boolean | null
  openCommands: string[]
  isSelf: boolean
}

// Atom refs are literal objects; change the shape tag when a row's fields change.
const rows = atom({ plugin: 'mods', key: 'rows' } as const, [], { shape: 'rows-2' })
const notice = atom({ plugin: 'mods', key: 'notice' } as const, '')
// Path of the backup written this session ('' = none yet): the user settings file is backed up once before the first change.
const backedUp = atom({ plugin: 'mods', key: 'backedUp' } as const, '')
// True only when the last load could read managed policy settings through the settings API.
const managedReadable = atom({ plugin: 'mods', key: 'managedReadable' } as const, false)

const MANAGED_HIDDEN = 'managed policy settings are not visible to this mod'
const MANAGED_SENTENCE = 'Managed policy settings are not visible to this mod'

// One settings source through the engine's settings API, or null when it cannot be read.
async function readSource($: EngineInterface, source: 'policy' | 'flag'): Promise<Record<string, unknown> | null> {
  try {
    return enabledFromSettings(await $.settings.read({ source }))
  } catch {
    return null
  }
}

// Where this person's Claude config lives: CLAUDE_CONFIG_DIR when set, else ~/.claude.
async function configDir($: EngineInterface): Promise<string> {
  const custom = await $.env.get('CLAUDE_CONFIG_DIR')
  if (custom) return custom
  const home = (await $.env.get('HOME')) ?? ''
  return `${home}/.claude`
}

async function readText($: EngineInterface, path: string): Promise<string | null> {
  try {
    const text = await $.fs.read(path)
    return typeof text === 'string' ? text : null
  } catch {
    return null
  }
}

function readSettingsAt($: EngineInterface, path: string): Promise<SettingsRead> {
  return readSettings(p => $.fs.exists(p), p => $.fs.read(p), path)
}

function enabledOf(r: SettingsRead): Record<string, unknown> {
  return r.kind === 'ok' ? parseEnabled(r.text) : {}
}

// The session's project root, or null when it cannot be had.
async function projectRoot($: EngineInterface): Promise<string | null> {
  try {
    const root = await $.session.root()
    return typeof root === 'string' && root !== '' ? root : null
  } catch {
    return null
  }
}

// Read-only. Builds the list from the installed-plugins record, each manifest and the user's settings file.
async function load($: EngineInterface): Promise<void> {
  const dir = await configDir($)
  const recordText = await readText($, `${dir}/plugins/installed_plugins.json`)
  if (recordText === null) {
    await update($, rows, () => [])
    await update($, notice, () => `No installed-plugins record found at ${dir}/plugins/installed_plugins.json.`)
    return
  }
  const { entries, error } = parseInstalled(recordText)
  const warnings: string[] = []
  const userRead = await readSettingsAt($, `${dir}/settings.json`)
  if (userRead.kind === 'failed') warnings.push(`Could not read ${dir}/settings.json (${userRead.why}); on/off states may be wrong.`)
  const projectDir = await projectRoot($)
  const projRead = projectDir === null ? ({ kind: 'missing' } as SettingsRead) : await readSettingsAt($, `${projectDir}/.claude/settings.json`)
  const localRead = projectDir === null ? ({ kind: 'missing' } as SettingsRead) : await readSettingsAt($, `${projectDir}/.claude/settings.local.json`)
  if (projRead.kind === 'failed' || localRead.kind === 'failed') {
    warnings.push('Could not read the project or local settings file; a project override may not be shown.')
  }
  const policy = await readSource($, 'policy')
  const flag = await readSource($, 'flag')
  if (policy === null) warnings.push(`${MANAGED_SENTENCE}; a managed policy may override what is shown.`)
  if (flag === null) warnings.push('Could not read the --settings flag source; an override from it may not be shown.')
  await update($, managedReadable, () => policy !== null)
  const maps = {
    user: enabledOf(userRead),
    project: enabledOf(projRead),
    local: enabledOf(localRead),
    ...(flag === null ? {} : { flag }),
    ...(policy === null ? {} : { policy }),
  }
  let commands: { name: string; description: string; plugin?: string }[] = []
  try {
    commands = await $.command.list()
  } catch {
    commands = []
  }
  const list: Row[] = []
  for (const e of entries) {
    const manifestText = await readText($, `${e.installPath}/.claude-plugin/plugin.json`)
    const m = manifestText === null ? {} : parseManifest(manifestText)
    const st = effectiveState(e.id, maps)
    const isEnabled = st.enabled
    list.push({
      id: e.id,
      name: e.name,
      marketplace: e.marketplace,
      version: m.version ?? e.version,
      description: m.description ?? (manifestText === null ? '(manifest not readable)' : ''),
      scope: e.scope,
      installPath: e.installPath,
      isEnabled,
      scopeNote: st.note,
      isOverridden: st.overridden,
      pending: null,
      openCommands: isEnabled ? openCommands(e.name, commands) : [],
      isSelf: e.name === 'mods',
    })
  }
  await update($, rows, () => list)
  await update($, notice, () => [error ?? `${list.length} installed. Nothing is changed until you press a button.`, ...warnings].join(' '))
}

// Runs only from a button press. Writes the user's settings file; takes effect after a restart.
async function toggle($: EngineInterface, args: { id: string; want: boolean; allowWithoutBackup: boolean }): Promise<void> {
  const dir = await configDir($)
  const path = `${dir}/settings.json`
  // Only a confirmed-missing file may be created fresh; a failed read of an existing file refuses and writes nothing.
  const got = await readSettingsAt($, path)
  if (got.kind === 'failed') {
    await update($, notice, () => `${args.id}: could not read ${path} (${got.why}); nothing was written. Try again or edit it by hand.`)
    return
  }
  const text = got.kind === 'ok' ? got.text : null
  const next = withEnabled(text, args.id, args.want)
  if (!next.ok) {
    await update($, notice, () => `${args.id}: ${next.reason}`)
    return
  }
  // Backup once per session, before the first change, from the text that was read (an absent file has nothing to save).
  let backupNote = ''
  if (text !== null && (await read($, backedUp)) === '') {
    const stamp = await stampNow($)
    const bak = `${path}.mods-backup-${stamp}`
    try {
      await $.fs.write(bak, text)
      await update($, backedUp, () => bak)
      backupNote = ` A copy of the old file is at ${bak}.`
    } catch (err) {
      if (!args.allowWithoutBackup) {
        const why = err instanceof Error ? err.message : String(err)
        await update(
          $,
          notice,
          () =>
            `${args.id}: could not write a backup copy of ${path} (${why}); nothing was changed. Fix the cause and try again, or set the mods option allowWithoutBackup to true to accept changes without a backup.`,
        )
        return
      }
      backupNote = ' No backup copy could be written; allowWithoutBackup is on, so the change went ahead without one.'
    }
  }
  try {
    await $.fs.write(path, next.text)
  } catch {
    await update($, notice, () => `${args.id}: could not write ${path}; nothing changed.${backupNote}`)
    return
  }
  const row = (await read($, rows)).find(r => r.id === args.id)
  const overrideNote = row?.isOverridden
    ? ` But it is ${row.scopeNote}, and that wins over user settings, so this change will not show until that entry is removed.`
    : ''
  const hiddenNote = (await read($, managedReadable)) ? '' : ` ${MANAGED_SENTENCE}, so this cannot say whether a policy overrides it.`
  await update($, rows, list => list.map(r => (r.id === args.id && !r.isOverridden ? { ...r, pending: args.want } : r)))
  await update(
    $,
    notice,
    () =>
      `The user setting for ${args.id} was changed to ${args.want ? 'on' : 'off'} in ${path}. It is saved for every chat, not this chat only, and is read at the next start of Claude Code; whether it then wins depends on higher scopes (project, local, flag, managed policy).${overrideNote}${hiddenNote}${backupNote}`,
  )
}

async function stampNow($: EngineInterface): Promise<string> {
  try {
    return new Date(await $.clock.now()).toISOString().replace(/[:.]/g, '-')
  } catch {
    return 'copy'
  }
}

async function open($: EngineInterface, args: { command: string }): Promise<void> {
  try {
    await $.command.run({ command: args.command })
    await update($, notice, () => `Ran /${args.command} with no arguments.`)
  } catch {
    await update($, notice, () => `Could not run /${args.command} (it was run with no arguments).`)
  }
}

export const register: Register = (on, options) => {
  const allowWithoutBackup = (options as Record<string, unknown> | undefined)?.allowWithoutBackup === true

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'mods', description: 'See installed mods and switch them on or off' })
    return next(e)
  })

  on('command.run', { command: 'mods' }, async $ => {
    await load($)
    await $.ui.open({ id: PANE, title: 'Mods' })
    return { text: 'Mods pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const list = await read($, rows)
    const line = await read($, notice)
    const seesManaged = await read($, managedReadable)

    return (
      <Box flexDirection="column">
        <Text dimColor>
          On/off edits the enabled-plugins setting in your settings file (no per-chat toggle exists). A change loads after a restart.
        </Text>
        {!seesManaged && <Text dimColor>{`Note: ${MANAGED_HIDDEN}; states below ignore any managed policy.`}</Text>}
        {list.length === 0 && <Text dimColor>No mods listed.</Text>}
        {list.map(r => (
          <Box key={r.id} flexDirection="column">
            <Text>
              {r.name} {r.version} - {r.pending === null ? (r.isEnabled ? 'enabled' : 'disabled') : `user setting now ${r.pending ? 'on' : 'off'}, read after restart`}
              {r.scopeNote !== '' ? ` (${r.scopeNote})` : ''}
              {r.marketplace ? ` (${r.marketplace})` : ''}
            </Text>
            {r.description !== '' && <Text dimColor>{oneLine(r.description, 110)}</Text>}
            {r.isOverridden && (
              <Text dimColor>{`${r.scopeNote}: that wins over user settings. The button below edits user settings only.`}</Text>
            )}
            {r.isSelf ? (
              <Text dimColor>This is the mods mod; switch it off by hand if you need to.</Text>
            ) : (
              <Button key={`toggle-${r.id}`} onPress={() => toggle($, { id: r.id, want: !(r.pending ?? r.isEnabled), allowWithoutBackup })}>
                {r.pending ?? r.isEnabled ? 'Turn off' : 'Turn on'}
              </Button>
            )}
            {r.openCommands.map(c => (
              <Button key={`open-${r.id}-${c}`} onPress={() => open($, { command: c })}>
                {`Open /${c} (runs it with no arguments)`}
              </Button>
            ))}
          </Box>
        ))}
        <Button key="refresh" onPress={() => load($)}>
          Refresh
        </Button>
        {line !== '' && <Text dimColor>{line}</Text>}
      </Box>
    )
  })
}
