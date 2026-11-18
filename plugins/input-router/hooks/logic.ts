// Pure rules of input-router: no `$` here, so every rule is testable on its own.
// All wording lives in ./strings.

import {
  digestTruncated,
  FENCE_CLOSE,
  FENCE_OPEN,
  FENCE_STRIPPED,
  headLines,
  HELPER_SYSTEM,
  helperAsk,
  mcpLabel,
  NO_GOAL,
  paneRowTail,
  paneWastedTail,
  QUOTE,
  shellLabel,
  tailLines,
  TAG_CMD,
  TAG_GOAL,
  TAG_PAYLOAD,
  TRIM,
  usdLabel,
} from './strings'

export { HELPER_SYSTEM }

export type Settings = {
  minChars: number
  helperModel: string
  timeoutMs: number
  maxNoteChars: number
  excludeGlobs: string[]
  /** Paths that always pass through whole, on top of the built-in instruction-file rules. */
  alwaysWholeGlobs: string[]
  /** Opt-in: also route big Bash output. */
  routeBash: boolean
  /** Saved MCP/Bash full copies older than this many days are emptied at session start; 0 keeps them. */
  retentionDays: number
  /** Off: no full copies are written, so MCP and Bash results pass through whole. */
  saveFullCopies: boolean
  /** A result is not routed when the estimated dollar impact before the helper call (see `estimateSavingUsdBefore`) is below this. */
  minEstimatedSavingUsd: number
  /**
   * When the session model and the helper model have the same input price, the dollar screen is
   * bypassed (it would always come out negative: the helper reads the source at the same per-token
   * price as the main model would). Routing then pays off only when the digest is reused over many
   * later turns. False keeps the screen, so equal prices never route (unless `minEstimatedSavingUsd` is below 0).
   */
  routeWhenSamePrice: boolean
}

export const DEFAULTS: Settings = {
  minChars: 12_000,
  helperModel: 'haiku',
  timeoutMs: 20_000,
  maxNoteChars: 4_000,
  excludeGlobs: [],
  alwaysWholeGlobs: [],
  routeBash: false,
  retentionDays: 7,
  saveFullCopies: true,
  minEstimatedSavingUsd: 0,
  routeWhenSamePrice: true,
}

/** The most text one helper call is shown; the rest is reported as cut. */
export const HELPER_INPUT_MAX = 300_000
/** How much of a Bash command the helper is shown. */
export const COMMAND_MAX = 500
/** How much of the current request the helper sees. */
export const TASK_MAX = 2_000
/** Notes are only worth it when they are clearly smaller than what they replace. */
export const MAX_NOTE_RATIO = 0.6

const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback

/** Reads the plugin options, filling defaults and keeping each value usable. */
export function readSettings(options: Record<string, unknown> | undefined): Settings {
  const o = options ?? {}
  const model = typeof o.helperModel === 'string' && o.helperModel.trim() !== '' ? o.helperModel.trim() : DEFAULTS.helperModel
  const globs = typeof o.excludeGlobs === 'string' ? splitGlobs(o.excludeGlobs) : []
  return {
    minChars: Math.max(0, Math.floor(num(o.minChars, DEFAULTS.minChars))),
    helperModel: model,
    // $.model.complete takes a positive whole number of milliseconds.
    timeoutMs: Math.min(120_000, Math.max(1_000, Math.round(num(o.timeoutMs, DEFAULTS.timeoutMs)))),
    maxNoteChars: Math.min(20_000, Math.max(200, Math.floor(num(o.maxNoteChars, DEFAULTS.maxNoteChars)))),
    excludeGlobs: globs,
    alwaysWholeGlobs: typeof o.alwaysWholeGlobs === 'string' ? splitGlobs(o.alwaysWholeGlobs) : [],
    routeBash: o.routeBash === true,
    retentionDays: Math.min(3650, Math.max(0, Math.floor(num(o.retentionDays, DEFAULTS.retentionDays)))),
    saveFullCopies: o.saveFullCopies !== false,
    minEstimatedSavingUsd: Math.min(1_000, Math.max(-1_000, roundUsd(num(o.minEstimatedSavingUsd, DEFAULTS.minEstimatedSavingUsd)))),
    routeWhenSamePrice: o.routeWhenSamePrice !== false,
  }
}

export const splitGlobs = (text: string): string[] =>
  text
    .split(/[,\n]/)
    .map(s => s.trim())
    .filter(s => s !== '')

/** Turns a glob into a RegExp: `**` any depth, `*` within one segment, `?` one character. */
export function globToRegExp(glob: string): RegExp {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++
        if (glob[i + 1] === '/') {
          i++
          out += '(?:.*/)?'
        } else {
          out += '.*'
        }
      } else {
        out += '[^/]*'
      }
    } else if (c === '?') {
      out += '[^/]'
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${out}$`)
}

/**
 * True when `target` (a file path or an MCP tool name) matches one of the globs.
 * A glob without a slash also matches a path's last segment (`*.lock` hits `/a/b/x.lock`).
 */
export function isExcluded(target: string, globs: readonly string[]): boolean {
  const base = target.slice(target.lastIndexOf('/') + 1)
  return globs.some(g => {
    const re = globToRegExp(g)
    return re.test(target) || (!g.includes('/') && re.test(base))
  })
}


// ---------- instruction files: never summarised ----------

/** File names that are instructions wherever they sit. Case-sensitive, whole name. */
const INSTRUCTION_NAMES = new Set(['CLAUDE.md', 'CLAUDE.local.md', 'SKILL.md', 'MEMORY.md'])

/** The path's segments: empty and `.` dropped, so `//`, `/./` and a trailing `/` do not matter. `..` is kept. */
const segmentsOf = (p: string): string[] => p.split('/').filter(s => s !== '' && s !== '.')

/**
 * The one directory under `.claude/` that is not instructions: where this mod saves full MCP
 * and Bash results (`<home>/.claude/claude-mods/input-router/results/`). Applies only when the
 * path has a single `.claude` segment, no `..` and an ordinary file name, so it cannot be
 * used to smuggle `.claude/skills/...` past the rule.
 */
function isSavedResult(segs: readonly string[], claudeAt: number[]): boolean {
  const at = claudeAt[0]
  if (claudeAt.length !== 1 || at === undefined || segs.includes('..')) return false
  return segs[at + 1] === 'claude-mods' && segs[at + 2] === 'input-router' && segs[at + 3] === 'results' && segs.length > at + 4
}

/**
 * True when `path` is an instruction file that must never be summarised. Matches by whole
 * path segment, case-sensitively, never by substring:
 *  - the file name is exactly CLAUDE.md, CLAUDE.local.md, SKILL.md or MEMORY.md, at any depth;
 *  - any directory segment is exactly `.claude` (so every skill, command, agent, rule,
 *    settings*.json and memory file under it), except this mod's own saved results.
 * `claude.md`, `XCLAUDE.md`, `SKILL.md.bak`, `.claude-plugin/` and `my.claude/` do not match.
 * `..` is not resolved: a path that mentions `.claude/` before a `..` still counts (fails safe).
 */
export function isInstructionPath(path: string): boolean {
  const segs = segmentsOf(path)
  const name = segs[segs.length - 1]
  if (name === undefined) return false
  if (INSTRUCTION_NAMES.has(name)) return true
  const claudeAt: number[] = []
  for (let i = 0; i < segs.length - 1; i++) if (segs[i] === '.claude') claudeAt.push(i)
  if (claudeAt.length === 0) return false
  return !isSavedResult(segs, claudeAt)
}

/** One path segment against one glob segment: `*` any run, `?` one character, the rest literal. */
function segmentMatches(glob: string, seg: string): boolean {
  if (glob === '*') return true
  let re = ''
  for (const c of glob) re += c === '*' ? '[^/]*' : c === '?' ? '[^/]' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${re}$`).test(seg)
}

function segmentsMatch(g: readonly string[], gi: number, s: readonly string[], si: number): boolean {
  if (gi === g.length) return si === s.length
  const part = g[gi] as string
  if (part === '**') {
    for (let k = si; k <= s.length; k++) if (segmentsMatch(g, gi + 1, s, k)) return true
    return false
  }
  const seg = s[si]
  return seg !== undefined && segmentMatches(part, seg) && segmentsMatch(g, gi + 1, s, si + 1)
}

/**
 * True when `path` matches one of the user's `alwaysWholeGlobs`. Case-sensitive and segment
 * aware: `*` and `?` never cross a `/`, and `**` as a whole segment covers zero or more
 * directories. A glob without `/` is a file name (`*.lock`); a glob with `/` is matched
 * against the whole path, so start it with `**` to match at any depth (`**` + `/prompts/*.md`).
 * A leading `/` is not significant. A glob ending in `/**` covers everything below a folder.
 */
export function matchesAlwaysWhole(path: string, globs: readonly string[]): boolean {
  const segs = segmentsOf(path)
  if (segs.length === 0) return false
  return globs.some(glob => {
    const g = glob.trim()
    if (g === '') return false
    const gs = segmentsOf(g)
    if (gs.length === 0) return false
    if (!g.includes('/')) return segmentMatches(g, segs[segs.length - 1] as string)
    return segmentsMatch(gs, 0, segs, 0)
  })
}

/** The one question the router asks: must this path come back whole? */
export const isAlwaysWhole = (path: string, globs: readonly string[]): boolean =>
  isInstructionPath(path) || matchesAlwaysWhole(path, globs)

/**
 * Best-effort guard for Bash: true when a word of the command looks like an instruction file
 * (the same rules as above, or any `.claude` word, as in `cd .claude && cat settings.json`).
 * It reads words, not shell: a name built by a variable or a subshell is not seen.
 */
export function commandTouchesInstructions(command: string, globs: readonly string[]): boolean {
  return command
    .split(/[\s'"`;&|<>()=,{}]+/)
    .filter(w => w !== '')
    .some(w => isAlwaysWhole(w, globs) || segmentsOf(w).includes('.claude'))
}

/** Collapses `//` and `/./` so the same file compares equal. */
export function normalizePath(p: string): string {
  let out = p.replace(/\/{2,}/g, '/').replace(/\/\.(?=\/|$)/g, '')
  if (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1)
  return out === '' ? '/' : out
}

const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

/** The file a write or edit tool call touches, or null for any other call. */
export function writtenPath(tool: string, input: Record<string, unknown>): string | null {
  if (!EDIT_TOOLS.has(tool)) return null
  const p = input.file_path ?? input.notebook_path
  return typeof p === 'string' && p !== '' ? normalizePath(p) : null
}

export const isMcpTool = (tool: string): boolean => tool.startsWith('mcp__')

/** The identity of a request, for "the same read again right after the notes". */
export function readKey(path: string, offset: unknown, limit: unknown): string {
  const n = (v: unknown) => (typeof v === 'number' ? String(v) : '')
  return `read:${normalizePath(path)}:${n(offset)}:${n(limit)}`
}

/** Same for an MCP call: its tool and arguments (the reserved keys left out). Kept in memory only. */
export function mcpKey(input: Record<string, unknown>): string {
  const args: Record<string, unknown> = {}
  for (const k of Object.keys(input).sort()) {
    if (k === 'tool' || k === 'tool_use_id' || k === 'agentId' || k === 'requestMeta' || k === 'consent') continue
    args[k] = input[k]
  }
  let json = ''
  try {
    json = JSON.stringify(args)
  } catch {
    json = String(Math.random()) // unserialisable: never equal, so never a repeat
  }
  return `mcp:${String(input.tool)}:${json}`
}

/**
 * The text of an MCP result when it is a shape we know how to give back: a string, or a
 * list of text blocks only. Anything else (images, resources, objects) is null: pass through.
 */
export function mcpText(result: unknown): { text: string; shape: 'string' | 'blocks' } | null {
  if (typeof result === 'string') return { text: result, shape: 'string' }
  if (!Array.isArray(result) || result.length === 0) return null
  const parts: string[] = []
  for (const b of result) {
    if (b === null || typeof b !== 'object') return null
    const block = b as { type?: unknown; text?: unknown }
    if (block.type !== 'text' || typeof block.text !== 'string') return null
    parts.push(block.text)
  }
  return { text: parts.join('\n'), shape: 'blocks' }
}

export type ReadTextFile = {
  filePath: string
  content: string
  numLines: number
  startLine: number
  totalLines: number
}

/**
 * The file part of a Read result when it is plain text. Images, PDFs, notebooks and
 * Artifact sources (the engine handles those itself) are null: pass through.
 */
export function readTextOf(result: unknown): ReadTextFile | null {
  if (result === null || typeof result !== 'object') return null
  const r = result as { type?: unknown; file?: unknown; artifactRead?: unknown }
  if (r.type !== 'text' || r.artifactRead !== undefined) return null
  const f = r.file as Partial<ReadTextFile> | null | undefined
  if (!f || typeof f.content !== 'string' || typeof f.filePath !== 'string') return null
  const numLines = typeof f.numLines === 'number' ? f.numLines : f.content.split('\n').length
  return {
    filePath: f.filePath,
    content: f.content,
    numLines,
    startLine: typeof f.startLine === 'number' ? f.startLine : 1,
    totalLines: typeof f.totalLines === 'number' ? f.totalLines : numLines,
  }
}


/** Result fields that mean "not a plain finished command": any of them present and the result passes. */
const BASH_UNUSUAL = [
  'backgroundTaskId',
  'backgroundedByUser',
  'backgroundedByTurnAbort',
  'backgroundedToDeliverMessage',
  'timedOutAfterMs',
  'isImage',
  'rawOutputPath',
  'persistedOutputPath',
  'persistedOutputSize',
  'structuredContent',
  'returnCodeInterpretation',
  'tailInputPath',
  'memoryLimitNote',
  'triggeredNote',
  'backgroundCwdHint',
] as const

/**
 * The standard output of a Bash result that is safe to route, or null to pass through. The
 * result record carries no exit code, so this is fail-closed: it must be a finished
 * (not interrupted, not backgrounded, not timed out) plain result with none of the fields
 * above, and the text the model reads must not announce a non-zero exit. A command that
 * the engine reports as failed arrives as `isError` and never gets here.
 */
export function bashOutputOf(result: unknown, modelText?: string): { stdout: string; stderr: string } | null {
  if (result === null || typeof result !== 'object') return null
  const r = result as Record<string, unknown>
  if (typeof r.stdout !== 'string' || r.interrupted !== false) return null
  if (r.stderr !== undefined && typeof r.stderr !== 'string') return null
  for (const k of BASH_UNUSUAL) if (r[k] !== undefined && r[k] !== false) return null
  if (typeof modelText === 'string' && /(^|\n)Exit code (?!0\b)\d+/.test(modelText)) return null
  return { stdout: r.stdout, stderr: typeof r.stderr === 'string' ? r.stderr : '' }
}

/**
 * What the pane and ledger call a Bash call: the program name only. The command itself can
 * hold secrets (tokens in a header, a password in a URL), so it is never logged.
 */
export function bashTarget(command: string): string {
  const first = command.trim().split(/\s+/).find(w => !w.includes('='))
  const name = first?.slice(first.lastIndexOf('/') + 1) ?? ''
  return shellLabel(/^[A-Za-z0-9._+-]{1,40}$/.test(name) ? name : null)
}

export type RouteCheck = {
  size: number
  minChars: number
  isFullOnce: boolean
  isJustWritten: boolean
  isRepeatOfNotes: boolean
  isExcluded: boolean
  /** An instruction file or a user's alwaysWholeGlobs match: never summarised. */
  isAlwaysWhole?: boolean
  /** False when the result needs a saved full copy and copies are turned off (`saveFullCopies`). */
  canKeepCopy?: boolean
  /** `estimateHeadroomTokens` for this result: the crude overhead guard, a result below 0 is not routed. */
  estHeadroomTokens?: number
  /** `estimateSavingUsdBefore` for this result (null when a price is unknown: no check); with `minSavingUsd`, a result below it is not routed. */
  estSavingUsd?: number | null
  minSavingUsd?: number
}

export type RouteDecision =
  | { route: true }
  | { route: false; why: 'small' | 'full' | 'written' | 'repeat' | 'excluded' | 'whole' | 'nocopy' | 'overhead' | 'cost'; consumesFull: boolean }

/**
 * Whether a result goes to the helper. The order matters: a small result never uses up
 * `/input-router full`, which is spent only on a result that would otherwise be routed.
 */
export function decide(c: RouteCheck): RouteDecision {
  if (c.size <= c.minChars) return { route: false, why: 'small', consumesFull: false }
  if (c.isAlwaysWhole === true) return { route: false, why: 'whole', consumesFull: false }
  if (c.isExcluded) return { route: false, why: 'excluded', consumesFull: false }
  if (c.isJustWritten) return { route: false, why: 'written', consumesFull: false }
  if (c.isRepeatOfNotes) return { route: false, why: 'repeat', consumesFull: false }
  if (c.canKeepCopy === false) return { route: false, why: 'nocopy', consumesFull: false }
  // Before the full check: a result that would not be routed anyway never uses up `/input-router full`.
  if (c.estHeadroomTokens !== undefined && c.estHeadroomTokens < 0) return { route: false, why: 'overhead', consumesFull: false }
  if (c.estSavingUsd != null && c.estSavingUsd < (c.minSavingUsd ?? 0)) return { route: false, why: 'cost', consumesFull: false }
  if (c.isFullOnce) return { route: false, why: 'full', consumesFull: true }
  return { route: true }
}

/** Prefixes each line with its number, from `start`, so the helper can cite lines. */
export function numberLines(text: string, start = 1): string {
  return text
    .split('\n')
    .map((line, i) => `${start + i}\t${line}`)
    .join('\n')
}

export const estimateTokens = (chars: number): number => Math.ceil(Math.max(0, chars) / 4)

/**
 * Characters the helper is sent besides the payload itself: the system text and the prompt frame
 * (goal, origin, budget, tags). Measured with an empty payload.
 */
export function promptOverheadChars(a: Omit<HelperPromptArgs, 'numbered'>): number {
  return HELPER_SYSTEM.length + helperPrompt({ ...a, numbered: '' }).length
}

/**
 * Screen before the helper call, deliberately crude: the source's tokens minus twice the fixed
 * per-call overhead. Negative means the source is smaller than about 2x that overhead. It does not
 * model the helper reading the source; `tokenCounts` and `costUsdEstimate` after the call are what is logged.
 */
export const estimateHeadroomTokens =(sourceChars: number, overheadChars: number): number =>
  estimateTokens(sourceChars) - 2 * estimateTokens(overheadChars)

/**
 * USD per million INPUT tokens by model family. Copied from plugins/model-router/hooks/logic.ts
 * (claude-api skill table, cached 2026-11-03: Haiku 5.5, Sonnet 5.5, Opus 5.5, Fable 5.2). Older ids
 * in a family are priced as the current one: this feeds an estimate only. Refresh the date when the
 * table is re-checked.
 */
const INPUT_PRICE_PER_MTOK: Record<'haiku' | 'sonnet' | 'opus' | 'fable', number> = {
  haiku: 0.1,
  sonnet: 2,
  opus: 4,
  fable: 8,
}

/** List input price in USD per million tokens of an alias (`haiku`) or a full id, or null when unknown. */
export function inputPriceUsd(model: string | undefined | null): number | null {
  if (!model) return null
  const m = model.toLowerCase()
  if (m.includes('haiku')) return INPUT_PRICE_PER_MTOK.haiku
  if (m.includes('sonnet')) return INPUT_PRICE_PER_MTOK.sonnet
  if (m.includes('opus')) return INPUT_PRICE_PER_MTOK.opus
  if (m.includes('fable') || m.includes('mythos')) return INPUT_PRICE_PER_MTOK.fable
  return null
}

/** Rounds to 6 decimals. */
export const roundUsd = (n: number): number => Math.round(n * 1_000_000) / 1_000_000

/**
 * `avoided * mainModelInputPrice - helper * helperModelInputPrice` in USD (may be negative), or null
 * when either model's price is unknown (the ledger then omits `costUsdEstimate`).
 */
export function costUsdEstimate(avoidedTokens: number, helperTokens: number, mainModel: string | undefined | null, helperModel: string | undefined | null): number | null {
  const main = inputPriceUsd(mainModel)
  const help = inputPriceUsd(helperModel)
  if (main === null || help === null) return null
  return roundUsd((avoidedTokens * main - helperTokens * help) / 1_000_000)
}

/**
 * Dollar estimate before the helper call: avoided = the whole source's tokens (the digest is
 * ignored, which is optimistic), helper = the payload shown to the helper (capped at HELPER_INPUT_MAX)
 * plus the fixed overhead, input side only. Negative whenever the helper's price is not below the main
 * model's, so equal prices always give a negative figure (see `dollarScreenBefore`, which decides
 * whether the screen applies). Null when a price is unknown.
 */
export function estimateSavingUsdBefore(sourceChars: number, overheadChars: number, mainModel: string | undefined | null, helperModel: string | undefined | null): number | null {
  return costUsdEstimate(estimateTokens(sourceChars), estimateTokens(Math.min(sourceChars, HELPER_INPUT_MAX) + overheadChars), mainModel, helperModel)
}

/**
 * The dollar figure the pre-call screen compares with `minEstimatedSavingUsd`, or null for "no
 * screen": a price is unknown (a subagent's model is not exposed: pass null as `mainModel`), or
 * both prices are equal and `routeWhenSamePrice` is on. With equal prices the estimate is always
 * negative (the helper reads at least as many tokens as the main model would, at the same price), so
 * the screen would block every result; whether routing then pays depends on how often the digest is
 * re-read in later turns, which cannot be known here.
 */
export function dollarScreenBefore(a: {
  sourceChars: number
  overheadChars: number
  mainModel: string | undefined | null
  helperModel: string | undefined | null
  routeWhenSamePrice: boolean
}): number | null {
  const main = inputPriceUsd(a.mainModel)
  const help = inputPriceUsd(a.helperModel)
  if (main === null || help === null) return null
  if (main === help && a.routeWhenSamePrice) return null
  return estimateSavingUsdBefore(a.sourceChars, a.overheadChars, a.mainModel, a.helperModel)
}

/**
 * Dollar cost of a helper call whose digest was thrown away (`cost-upgrade`): `-helper * helperPrice`
 * (negative, or 0 for no tokens). It needs only the helper's price, so it is known for subagent
 * calls too. Null when the helper model's price is unknown.
 */
export function wastedCostUsd(helperTokens: number, helperModel: string | undefined | null): number | null {
  const help = inputPriceUsd(helperModel)
  if (help === null) return null
  const usd = roundUsd((helperTokens * help) / 1_000_000)
  return usd === 0 ? 0 : -usd
}

/** The usage a model call reports (every count is present; a count the response left out is 0). */
export type HelperUsage = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

export type TokenCountArgs = {
  sourceChars: number
  digestChars: number
  /** Payload characters the helper was shown (after the HELPER_INPUT_MAX cut). */
  helperInputChars: number
  helperOutputChars: number
  promptOverheadChars: number
  usage?: HelperUsage | null
}

/** The two token counts of one hand-off. They are never netted: they are different models' tokens. */
export type TokenCounts = { avoided: number; helper: number }

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.ceil(v) : 0)

/**
 * `avoided`: gross tokens kept out of the main model, ceil((source - digest)/4), never below 0.
 * `helper`: what the helper cost (not subtracted from `avoided`). Its cost is the usage the API reported (all input kinds plus output), or, for a side
 * it did not report, ceil((payload + overhead)/4) for input and ceil(output/4) for output; with
 * no usage at all it is ceil((input + output + overhead)/4).
 */
export function tokenCounts(a: TokenCountArgs): TokenCounts {
  const avoided = estimateTokens(a.sourceChars - a.digestChars)
  const u = a.usage ?? {}
  const usedIn = count(u.input_tokens) + count(u.cache_read_input_tokens) + count(u.cache_creation_input_tokens)
  const usedOut = count(u.output_tokens)
  const helper =
    usedIn === 0 && usedOut === 0
      ? estimateTokens(a.helperInputChars + a.helperOutputChars + a.promptOverheadChars)
      : (usedIn > 0 ? usedIn : estimateTokens(a.helperInputChars + a.promptOverheadChars)) +
        (usedOut > 0 ? usedOut : estimateTokens(a.helperOutputChars))
  return { avoided, helper }
}

export type HelperPromptArgs = {
  kind: 'file' | 'mcp' | 'bash'
  label: string
  /** Bash only: the command that produced the output (data, shown to the helper only). */
  command?: string
  task: string
  numbered: string
  totalLines: number
  firstLine: number
  maxNoteChars: number
}

/** The user message for the helper. The content is cut at HELPER_INPUT_MAX and the cut is stated. */
export function helperPrompt(a: HelperPromptArgs): string {
  const isCut = a.numbered.length > HELPER_INPUT_MAX
  const body = isCut ? a.numbered.slice(0, HELPER_INPUT_MAX) : a.numbered
  return helperAsk({
    kind: a.kind,
    label: oneLine(a.label),
    goal: escapeTags(a.task.trim() === '' ? NO_GOAL : a.task.trim().slice(0, TASK_MAX)),
    command: escapeTags(oneLine((a.command ?? '').slice(0, COMMAND_MAX))),
    firstLine: a.firstLine,
    totalLines: a.totalLines,
    shownChars: isCut ? HELPER_INPUT_MAX : null,
    budget: a.maxNoteChars,
    body: escapeTags(body),
  })
}

const CLOSING_TAG = new RegExp(`<\\s*/\\s*(${TAG_GOAL}|${TAG_CMD}|${TAG_PAYLOAD})\\s*>`, 'gi')

/** Keeps data from closing the prompt's own tags early. */
export const escapeTags = (text: string): string => text.replace(CLOSING_TAG, '</$1_>')

/** One line, no control characters: a file name or tool name cannot add lines of its own. */
export const oneLine = (text: string): string => text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '?')

/** Every character a reader might take as a line break: the digest is split on all of them before quoting. */
const ANY_BREAK = /\r\n|[\n\r\u000b\u000c\u0085\u2028\u2029]/

/** Cleans the helper's reply: no delimiter forgery, capped length. Empty string means "no notes". */
export function cleanNotes(text: string, maxNoteChars: number): string {
  let t = text.split(FENCE_OPEN).join(FENCE_STRIPPED).split(FENCE_CLOSE).join(FENCE_STRIPPED).trim()
  if (t.length > maxNoteChars) t = `${t.slice(0, maxNoteChars).trimEnd()}\n${digestTruncated(maxNoteChars)}`
  return t
}

export type NoteArgs = {
  kind: 'file' | 'mcp' | 'bash'
  /** File path read, or MCP tool name. */
  label: string
  /** Where the full text is: the file itself, or the saved MCP result. */
  fullPath: string
  model: string
  notes: string
  inChars: number
  firstLine: number
  lineCount: number
  totalLines: number
  /** True when the helper was shown only the first HELPER_INPUT_MAX characters. */
  isHelperInputCut?: boolean
}

/**
 * The text the main model reads in place of the result. Everything outside the
 * fences is written here, never by the helper; every line of the helper's notes
 * carries the QUOTE prefix, so a pointer or a header key the content smuggles into
 * the notes shows as quoted helper text, never as one of the mod's own lines.
 * Every interpolated value is one-lined, so a label cannot add a header line.
 */
export function composeNote(a: NoteArgs): string {
  const last = a.firstLine + a.lineCount - 1
  const quoted = a.notes
    .split(ANY_BREAK)
    .map(line => `${QUOTE}${line}`)
    .join('\n')
  const midpoint = Math.max(a.firstLine, Math.floor((a.firstLine + last) / 2))
  return [
    ...headLines({
      kind: a.kind,
      label: oneLine(a.label),
      model: oneLine(a.model),
      inChars: a.inChars,
      firstLine: a.firstLine,
      lastLine: last,
      lineCount: a.lineCount,
      totalLines: a.totalLines,
      helperSawChars: a.isHelperInputCut ? HELPER_INPUT_MAX : null,
    }),
    FENCE_OPEN,
    quoted,
    FENCE_CLOSE,
    ...tailLines(a.kind, oneLine(a.fullPath), midpoint),
  ].join('\n')
}

/** File name for a saved MCP result: time, tool, and the call id, all path-safe. */
export function savedResultName(at: number, tool: string, id: string): string {
  const stamp = new Date(at).toISOString().replace(/[:.]/g, '-')
  const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 60)
  return `${stamp}-${safe(tool)}-${safe(id) || 'call'}.txt`
}

/** Exactly the names savedResultName produces: nothing else in the folder is ever touched. */
const OWN_RESULT_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[A-Za-z0-9_-]{0,60}-[A-Za-z0-9_-]{1,60}\.txt$/

export const isOwnResultName = (name: string): boolean => OWN_RESULT_NAME.test(name)

export const DAY_MS = 86_400_000

/** One `$.fs.list` entry, as the sweep needs it. */
export type ListedEntry = { name: string; kind: 'file' | 'dir' | 'other'; size: number; mtimeMs: number; isLink: boolean }

/**
 * Names in the results folder whose copy has expired: a regular file (not a link) this mod
 * named, not already emptied, last written more than `retentionDays` days before `now`.
 * `retentionDays` 0 keeps everything.
 */
export function expiredResults(entries: readonly ListedEntry[], now: number, retentionDays: number): string[] {
  if (!(retentionDays > 0)) return []
  const cutoff = now - retentionDays * DAY_MS
  return entries
    .filter(e => e.kind === 'file' && !e.isLink && e.size > 0 && e.mtimeMs > 0 && e.mtimeMs < cutoff && isOwnResultName(e.name))
    .map(e => e.name)
}

export type Handoff = {
  at: number
  tool: string
  target: string
  inChars: number
  outChars: number
  /** Gross main-context tokens kept out, ceil((in - out)/4); never negative, never reduced by the helper. */
  tokensAvoided: number
  /** What the helper call cost, in tokens (reported usage, else the estimate). */
  helperTokens: number
  /** `costUsdEstimate`, or null when a model price is unknown. */
  costUsd: number | null
  /** The session model and the helper model the price used (ids only). */
  mainModel: string
  helperModel: string
  /**
   * Set (to a short reason, no content) when the helper was called but its digest was not used, so
   * the original went through whole: a wasted call (`cost-upgrade`). Then `tokensAvoided` is 0.
   */
  wasted?: string
  /** The call came from a subagent: the main model's price does not apply and is unknown. */
  isSubagent?: boolean
}

/** One pane row: tool, target, size in, size out, estimated tokens avoided (or the reason a call was wasted). */
export function formatHandoff(h: Handoff, width: number): string {
  const k = (n: number) => (Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
  const tail =
    h.wasted === undefined
      ? paneRowTail(k(h.inChars), k(h.outChars), k(h.tokensAvoided), k(h.helperTokens), usdLabel(h.costUsd))
      : paneWastedTail(h.wasted, k(h.inChars), k(h.helperTokens), usdLabel(h.costUsd))
  const head = `${h.tool} `
  const room = Math.max(8, width - head.length - tail.length)
  const target = h.target.length > room ? `${TRIM}${h.target.slice(-(room - TRIM.length))}` : h.target
  return `${head}${target}${tail}`
}

/** What the pane calls a tool: `Read`, or `mcp server/tool` for an MCP name. */
export function toolLabel(tool: string): string {
  if (!isMcpTool(tool)) return tool
  const parts = tool.split('__')
  return mcpLabel(parts[1] ?? '?', parts.slice(2).join('__') || '?')
}
