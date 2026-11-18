// Pure helpers for the mods pane. No engine calls, so every piece is testable.

export type Installed = {
  id: string
  name: string
  marketplace: string
  scope: string
  installPath: string
  version: string
}

export type Manifest = { name?: string; version?: string; description?: string }

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** 'name@market' -> { name, marketplace }. The marketplace is everything after the last '@'. */
export function splitId(id: string): { name: string; marketplace: string } {
  const at = id.lastIndexOf('@')
  if (at <= 0) return { name: id, marketplace: '' }
  return { name: id.slice(0, at), marketplace: id.slice(at + 1) }
}

const SCOPE_RANK: Record<string, number> = { user: 0, local: 1, project: 2, managed: 3 }

/**
 * Reads the text of the installed-plugins record:
 * `{ version, plugins: { "<name>@<marketplace>": [{ scope, installPath, version }] } }`.
 * Never throws. A plugin installed in several scopes yields one entry (user scope first).
 * An older object-shaped value (no array) is accepted too. Entries without an install path are skipped.
 */
export function parseInstalled(text: string): { entries: Installed[]; error: string | null } {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return { entries: [], error: 'The installed-plugins record is not valid JSON.' }
  }
  if (!isObject(data) || !isObject(data.plugins)) {
    return { entries: [], error: 'The installed-plugins record has no "plugins" object.' }
  }
  const entries: Installed[] = []
  for (const id of Object.keys(data.plugins).sort()) {
    const raw = data.plugins[id]
    const installs = (Array.isArray(raw) ? raw : [raw]).filter(isObject)
    const usable = installs.filter(i => str(i.installPath) !== '')
    if (usable.length === 0) continue
    const best = [...usable].sort(
      (a, b) => (SCOPE_RANK[str(a.scope)] ?? 9) - (SCOPE_RANK[str(b.scope)] ?? 9),
    )[0]
    if (best === undefined) continue
    const { name, marketplace } = splitId(id)
    entries.push({
      id,
      name,
      marketplace,
      scope: str(best.scope) || 'user',
      installPath: str(best.installPath),
      version: str(best.version),
    })
  }
  return { entries, error: null }
}

/** Reads a plugin.json. Never throws; unreadable text gives an empty manifest. */
export function parseManifest(text: string): Manifest {
  try {
    const data: unknown = JSON.parse(text)
    if (!isObject(data)) return {}
    return { name: str(data.name) || undefined, version: str(data.version) || undefined, description: str(data.description) || undefined }
  } catch {
    return {}
  }
}

/** enabledPlugins values: true is on; false or absent is off; a non-empty list (a pinned form) counts as on. */
export function isEnabledValue(v: unknown): boolean {
  if (v === true) return true
  if (Array.isArray(v)) return v.length > 0
  return false
}

/** The `enabledPlugins` map out of the text of a settings file; empty when missing or unreadable. */
export function parseEnabled(settingsText: string): Record<string, unknown> {
  try {
    const data: unknown = JSON.parse(settingsText)
    if (isObject(data) && isObject(data.enabledPlugins)) return data.enabledPlugins
  } catch {
    /* fall through */
  }
  return {}
}

/**
 * The new text of a settings file with `enabledPlugins[id]` set to `value`, every other key untouched
 * (key order kept, 2-space indent, trailing newline).
 *
 * `settingsText` is the text that was actually read, or `null` only when the file is CONFIRMED missing
 * (then a fresh file is made). Anything else that is not a JSON object, an empty existing file included,
 * is refused with a reason, so a damaged or half-read file is never overwritten.
 */
export function withEnabled(
  settingsText: string | null,
  id: string,
  value: boolean,
): { ok: true; text: string } | { ok: false; reason: string } {
  let data: unknown = {}
  if (settingsText !== null) {
    try {
      data = JSON.parse(settingsText)
    } catch {
      return { ok: false, reason: 'settings.json is not valid JSON; left untouched.' }
    }
  }
  if (!isObject(data)) return { ok: false, reason: 'settings.json is not a JSON object; left untouched.' }
  const current = data.enabledPlugins
  if (current !== undefined && !isObject(current)) {
    return { ok: false, reason: 'enabledPlugins in settings.json is not an object; left untouched.' }
  }
  const next = { ...data, enabledPlugins: { ...(current ?? {}), [id]: value } }
  return { ok: true, text: JSON.stringify(next, null, 2) + '\n' }
}

export type SettingsRead = { kind: 'ok'; text: string } | { kind: 'missing' } | { kind: 'failed'; why: string }

/**
 * Reads one settings file, telling "confirmed missing" from "read failed". `exists` and `read` are the
 * file API's calls. Only an `exists` answer of false is "missing"; a throw from either, or a non-text
 * result, is "failed" and must never be treated as an empty file.
 */
export async function readSettings(
  exists: (path: string) => Promise<boolean>,
  read: (path: string) => Promise<unknown>,
  path: string,
): Promise<SettingsRead> {
  let there: boolean
  try {
    there = await exists(path)
  } catch (err) {
    return { kind: 'failed', why: errText(err) }
  }
  if (!there) return { kind: 'missing' }
  try {
    const text = await read(path)
    return typeof text === 'string' ? { kind: 'ok', text } : { kind: 'failed', why: 'the file did not come back as text' }
  } catch (err) {
    return { kind: 'failed', why: errText(err) }
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export type Scope = 'user' | 'project' | 'local' | 'flag' | 'policy'
const SCOPE_WORD: Record<Scope, string> = {
  user: 'user settings',
  project: 'project settings',
  local: 'local settings',
  flag: 'the --settings flag',
  policy: 'managed policy settings',
}

/**
 * Which scope's `enabledPlugins` entry decides a mod. Managed policy beats the --settings flag beats
 * local beats project beats user. `flag` and `policy` are optional: a caller that could not read a
 * scope leaves it out, and then that scope is simply not considered (the caller must say so). `note` is
 * empty when the user setting decides or nothing sets it; otherwise it says where the effective value
 * comes from, e.g. "off in project settings". `overridden` is true when a higher scope has an entry
 * that the user-settings toggle cannot beat.
 */
export function effectiveState(
  id: string,
  maps: {
    user: Record<string, unknown>
    project: Record<string, unknown>
    local: Record<string, unknown>
    flag?: Record<string, unknown>
    policy?: Record<string, unknown>
  },
): { enabled: boolean; winner: Scope | 'none'; note: string; overridden: boolean } {
  let winner: Scope | 'none' = 'none'
  for (const s of ['policy', 'flag', 'local', 'project', 'user'] as const) {
    const m = maps[s]
    if (m !== undefined && id in m) {
      winner = s
      break
    }
  }
  if (winner === 'none') return { enabled: false, winner, note: '', overridden: false }
  const enabled = isEnabledValue(maps[winner]![id])
  const overridden = winner !== 'user'
  const note = overridden ? `${enabled ? 'on' : 'off'} in ${SCOPE_WORD[winner]}` : ''
  return { enabled, winner, note, overridden }
}

/**
 * The `enabledPlugins` map out of a settings object as `$.settings.read` returns it. Anything that is not
 * an object with an object `enabledPlugins` gives an empty map.
 */
export function enabledFromSettings(settings: unknown): Record<string, unknown> {
  if (typeof settings !== 'object' || settings === null) return {}
  const ep = (settings as { enabledPlugins?: unknown }).enabledPlugins
  return typeof ep === 'object' && ep !== null && !Array.isArray(ep) ? (ep as Record<string, unknown>) : {}
}

const OPENS_PANE = /\b(pane|panel|dashboard|window|viewer|view|open|show|board|list)\b/i
// The command list carries no argument metadata, so a description that mentions arguments is taken as "needs args".
const NEEDS_ARGS = /<[^>]+>|\[[^\]]+\]|\bargs?\b|\barguments?\b|\bparameters?\b/i

/**
 * Of the slash commands a mod registered, the ones that plausibly open its own pane with no arguments:
 * the command named like the mod, or one whose description speaks of a pane, panel, window and so on.
 * A command whose description mentions arguments is left out. A heuristic: the command list gives name,
 * description, source and plugin only, so neither "draws a pane" nor "needs no args" can be confirmed.
 */
export function openCommands(modName: string, commands: { name: string; description: string; plugin?: string }[]): string[] {
  const own = commands.filter(c => c.plugin === modName && c.name !== 'mods' && !NEEDS_ARGS.test(c.description))
  return own.filter(c => c.name === modName || OPENS_PANE.test(c.description)).map(c => c.name)
}

export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : flat.slice(0, Math.max(0, max - 3)) + '...'
}
