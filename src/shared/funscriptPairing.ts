import { sanitizeFilename } from './validation'

/**
 * Pure funscript pairing helpers.
 *
 * MultiFunPlayer, OpenFunscripter and XTPlayer only auto-load a script when it
 * sits next to the video and its name matches the video's name. Multi-axis sets
 * use `<video base>.<axis>.funscript`. These helpers parse arbitrary uploaded
 * names, group them into sets and plan safe renames onto a chosen video.
 *
 * No I/O, no Node APIs: this module is shared by the main process and the
 * renderer.
 */

export const FUNSCRIPT_EXTENSION = '.funscript'

export const CANONICAL_AXES = [
  'surge',
  'sway',
  'twist',
  'roll',
  'pitch',
  'vib'
] as const

export type CanonicalAxis = (typeof CANONICAL_AXES)[number]

/**
 * Canonical axis token. The six mapped axes above are stable lower-case
 * tokens; auxiliary axes (`valve`, `suck`, `A0`, `A1`) keep the spelling that
 * was uploaded. The main stroke axis is always represented as `null`.
 */
export type Axis = CanonicalAxis | (string & {})

export interface ParsedFunscriptName {
  /** Display base with axis and variant tokens removed. */
  base: string
  /** Canonical axis, or null for the main stroke / no axis token. */
  axis: Axis | null
  /** Raw axis token exactly as uploaded, or null when absent. */
  axisToken: string | null
  /** Normalized (lower-case) variant token, or null when absent. */
  variant: string | null
}

export interface ScriptFileInput {
  id: string
  filename: string
  postNumber?: number
}

export interface ScriptSetFile {
  fileId: string
  filename: string
  base: string
  axis: Axis | null
  axisToken: string | null
  variant: string | null
  /** True for files on the main stroke axis, including variant mains. */
  isMain: boolean
}

export interface ScriptConflict {
  axis: Axis | null
  variant: string | null
  fileIds: string[]
}

export interface ScriptSet {
  /** Deterministic id built from the normalized base and optional post. */
  id: string
  /** Display base taken from the first file in the set. */
  base: string
  normalizedBase: string
  postNumber: number | null
  files: ScriptSetFile[]
  /** Unique non-main axes in first-seen order. */
  axes: Axis[]
  /** Unique variants in first-seen order. */
  variants: string[]
  /** First vanilla main file, else the first variant main, else null. */
  mainFileId: string | null
  /** True when the set has axes but no main-stroke script at all. */
  missingMain: boolean
  /** Two or more files mapping to the same axis + variant. */
  conflicts: ScriptConflict[]
}

export interface VideoCandidate {
  id: string
  title: string
  filename?: string
  postNumber?: number
}

export interface SetVideoMatch {
  setId: string
  videoId: string | null
  score: number
  ambiguous: boolean
}

export interface RenameOptions {
  /** Variant promoted to the canonical names. Null keeps every variant. */
  primaryVariant: string | null
}

export interface RenamePlanEntry {
  fileId: string
  targetName: string
}

export class FunscriptPairingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FunscriptPairingError'
  }
}

export interface RenameCollision {
  targetName: string
  fileIds: string[]
}

export class FunscriptRenameCollisionError extends FunscriptPairingError {
  readonly collisions: RenameCollision[]

  constructor(collisions: RenameCollision[]) {
    super(
      `Funscript rename plan has ${collisions.length} target name collision(s).`
    )
    this.name = 'FunscriptRenameCollisionError'
    this.collisions = collisions
  }
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/** Aliases that mean "main stroke" and therefore produce no suffix. */
const MAIN_AXIS_ALIASES = new Set(['stroke', 'l0', 'updown', 'main'])

/** Recognized aliases whose canonical output is a lower-case token. */
const CANONICAL_AXIS_ALIASES: Readonly<Record<string, CanonicalAxis>> = {
  surge: 'surge',
  l1: 'surge',
  sway: 'sway',
  l2: 'sway',
  twist: 'twist',
  r0: 'twist',
  roll: 'roll',
  r1: 'roll',
  pitch: 'pitch',
  r2: 'pitch',
  vib: 'vib',
  v0: 'vib'
}

/**
 * Recognized auxiliary axes. They are axes, but there is no cross-device
 * canonical spelling, so the uploaded token is preserved verbatim.
 */
const PRESERVED_AXIS_ALIASES = new Set(['valve', 'suck', 'a0', 'a1'])

/**
 * Variant vocabulary. Only these words (and the numeric patterns below) are
 * peeled as variants, so ordinary dotted titles such as `Some.Name.roll` keep
 * `Some.Name` as their base.
 */
const VARIANT_WORDS = new Set([
  'hard',
  'soft',
  'halfspeed',
  'half',
  'slow',
  'fast',
  'normal',
  'standard',
  'alternate',
  'alt',
  'easy',
  'gentle',
  'extreme',
  'intense',
  'medium',
  'low',
  'high',
  'light',
  'heavy',
  'custom'
])

const VARIANT_PATTERN =
  /^(?:v\d+|ver(?:sion)?\d*|rev\d+|take\d+|part\d+|alt\d*|edit\d*)$/u

function leafName(value: string): string {
  const slash = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'))
  return slash >= 0 ? value.slice(slash + 1) : value
}

/**
 * True when the file name ends in `.funscript` (case-insensitive) and has a
 * non-empty stem. Path separators are tolerated and never treated as base
 * text.
 */
export function isFunscriptFilename(filename: string): boolean {
  if (typeof filename !== 'string') return false
  const leaf = leafName(filename.trim()).trim()
  return (
    leaf.length > FUNSCRIPT_EXTENSION.length &&
    leaf.toLowerCase().endsWith(FUNSCRIPT_EXTENSION)
  )
}

/**
 * Resolve an axis token. Returns `undefined` when the token is not an axis,
 * `null` for the main stroke axis, and the canonical/preserved token
 * otherwise.
 */
function parseAxisToken(token: string): Axis | null | undefined {
  const trimmed = token.trim()
  if (trimmed.length === 0) return undefined
  const key = trimmed.toLowerCase()
  if (MAIN_AXIS_ALIASES.has(key)) return null
  const canonical = CANONICAL_AXIS_ALIASES[key]
  if (canonical !== undefined) return canonical
  if (PRESERVED_AXIS_ALIASES.has(key)) return trimmed
  return undefined
}

function normalizeVariantToken(token: string): string {
  return token
    .trim()
    .replace(/^\((.*)\)$/u, '$1')
    .trim()
    .toLowerCase()
    .replace(/\s+/gu, '-')
}

function isVariantToken(token: string): boolean {
  const trimmed = token.trim()
  if (trimmed.length === 0) return false
  // An axis word is never a variant, even in a variant-looking position.
  if (parseAxisToken(trimmed) !== undefined) return false
  const key = trimmed.toLowerCase()
  return VARIANT_WORDS.has(key) || VARIANT_PATTERN.test(key)
}

function trimBase(value: string): string {
  return value.trim().replace(/[.\s_-]+$/u, '').trim()
}

/**
 * Peel a variant expressed on the base itself:
 *   `Name (hard)`, `Name_hard`, `Name-hard`, `Name v2`, `Name-v2`.
 * Only recognized variant tokens are peeled.
 */
function extractSuffixVariant(
  base: string
): { base: string; variant: string } | null {
  const parenthesized =
    /^(?<head>.*?)\s*\(\s*(?<inner>[\p{L}][\p{L}\p{N}]*)\s*\)\s*$/u.exec(base)
  if (parenthesized) {
    const head = trimBase(parenthesized.groups?.head ?? '')
    const inner = parenthesized.groups?.inner ?? ''
    if (head.length > 0 && isVariantToken(inner)) {
      return { base: head, variant: normalizeVariantToken(inner) }
    }
  }

  const separated =
    /^(?<head>.*\S)\s*[_-]\s*(?<inner>[\p{L}][\p{L}\p{N}]*)\s*$/u.exec(base)
  if (separated) {
    const head = trimBase(separated.groups?.head ?? '')
    const inner = separated.groups?.inner ?? ''
    if (head.length > 0 && isVariantToken(inner)) {
      return { base: head, variant: normalizeVariantToken(inner) }
    }
  }

  const spaced = /^(?<head>.*\S)\s+(?<inner>v\d+)\s*$/iu.exec(base)
  if (spaced) {
    const head = trimBase(spaced.groups?.head ?? '')
    const inner = spaced.groups?.inner ?? ''
    if (head.length > 0 && isVariantToken(inner)) {
      return { base: head, variant: normalizeVariantToken(inner) }
    }
  }

  return null
}

/**
 * Parse a funscript file name.
 *
 * Supported forms (case-insensitive):
 * - `Base.funscript` — main stroke / combined multi-axis file.
 * - `Base.axis.funscript` — `axis` is the last dot segment.
 * - `Base.variant.axis.funscript` — variant immediately before the axis.
 * - `Base.funscript` with a variant suffix on the base: `Base (hard)`,
 *   `Base_hard`, `Base-hard`, `Base v2`.
 *
 * Axis aliases map as documented on `Axis`; unknown tokens are NOT invented as
 * axes. Unknown words are only peeled as variants when they match the variant
 * vocabulary, so dotted base names (`S01.E02.1080p`) survive unchanged.
 * The axis must be the final dot-separated token; `Base.axis.variant` is not
 * treated as a variant axis.
 */
export function parseFunscriptName(
  filename: string
): ParsedFunscriptName | null {
  if (typeof filename !== 'string' || !isFunscriptFilename(filename)) {
    return null
  }

  const leaf = leafName(filename.trim()).trim()
  const stem = leaf.slice(0, leaf.length - FUNSCRIPT_EXTENSION.length).trim()
  if (stem.length === 0) return null

  const parts = stem.split('.')
  while (parts.length > 0) {
    const last = parts[parts.length - 1]
    if (last === undefined || last.trim().length > 0) break
    parts.pop()
  }
  if (parts.length === 0) return null

  let axis: Axis | null = null
  let axisToken: string | null = null
  let axisFound = false
  let variant: string | null = null

  // An axis or variant only counts when a base remains before it.
  if (parts.length >= 2) {
    const last = parts[parts.length - 1]
    const candidate = last === undefined ? '' : last.trim()
    const resolved = parseAxisToken(candidate)
    if (resolved !== undefined) {
      axis = resolved
      axisToken = candidate
      axisFound = true
      parts.pop()
    } else if (isVariantToken(candidate)) {
      variant = normalizeVariantToken(candidate)
      parts.pop()
    }
  }

  // `Base.variant.axis`: peel one variant token that precedes the axis.
  if (axisFound && variant === null && parts.length >= 2) {
    const last = parts[parts.length - 1]
    const candidate = last === undefined ? '' : last.trim()
    if (isVariantToken(candidate)) {
      variant = normalizeVariantToken(candidate)
      parts.pop()
    }
  }

  let base = trimBase(parts.join('.'))
  if (base.length === 0) return null

  if (variant === null) {
    const suffix = extractSuffixVariant(base)
    if (suffix !== null) {
      base = suffix.base
      variant = suffix.variant
    }
  }

  if (base.length === 0) return null

  return { base, axis, axisToken, variant }
}

// ---------------------------------------------------------------------------
// Normalization and similarity
// ---------------------------------------------------------------------------

const RESOLUTION_TAG =
  /^(?:\d{3,4}[pi]|[248]k|uhd|fhd|hd|hdr\d*|sdr|dv|dolbyvision|\d{2,3}fps|[xh]26[45]|hevc|av1|vp9|aac|ac3|eac3|dts|opus|webrip|web|bluray|blurayrip|brrip|bdrip|dvdrip|hdtv|remux|proper|repack)$/u

const STOP_WORDS = new Set([
  'fancam',
  'fancams',
  'official',
  'video',
  'mv',
  'musicvideo',
  'the',
  'a',
  'an',
  'of',
  'and',
  'feat',
  'ft',
  'full',
  'dl',
  'script',
  'funscript',
  'funscripts'
])

function rawTokens(value: string): string[] {
  let text = value.normalize('NFKC')
  text = text.replace(/([\p{Ll}])([\p{Lu}])/gu, '$1 $2')
  text = text.replace(/([\p{Lu}]+)([\p{Lu}][\p{Ll}])/gu, '$1 $2')
  text = text.normalize('NFKD').replace(/\p{M}+/gu, '')
  text = text.toLowerCase()
  text = text.replace(/['\u2019`\u00b4]/gu, '')
  text = text.replace(/&/gu, ' and ')
  text = text.replace(/[^\p{L}\p{N}]+/gu, ' ')
  return text.split(/\s+/u).filter((token) => token.length > 0)
}

function tokenizeName(value: string): string[] {
  const tokens: string[] = []
  for (const token of rawTokens(value)) {
    if (STOP_WORDS.has(token)) continue
    if (RESOLUTION_TAG.test(token)) continue
    tokens.push(token)
  }
  return tokens
}

function uniqueTokens(tokens: readonly string[]): string[] {
  return [...new Set(tokens)]
}

/**
 * Normalized grouping key. Case, punctuation, separators, brackets, resolution
 * tags and camel-case boundaries are all ignored; the result is a space-joined
 * token list.
 */
export function normalizeScriptBase(base: string): string {
  const tokens = uniqueTokens(tokenizeName(base))
  if (tokens.length > 0) return tokens.join(' ')
  return base
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .trim()
}

function bigramDice(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) return 0
  if (a === b) return 1
  if (a.length < 2 || b.length < 2) return 0

  const counts = new Map<string, number>()
  for (let index = 0; index < a.length - 1; index += 1) {
    const gram = a.slice(index, index + 2)
    counts.set(gram, (counts.get(gram) ?? 0) + 1)
  }

  let common = 0
  for (let index = 0; index < b.length - 1; index += 1) {
    const gram = b.slice(index, index + 2)
    const remaining = counts.get(gram) ?? 0
    if (remaining > 0) {
      common += 1
      counts.set(gram, remaining - 1)
    }
  }

  return (2 * common) / (a.length - 1 + (b.length - 1))
}

function similarity(aTokens: readonly string[], bTokens: readonly string[]): number {
  const a = uniqueTokens(aTokens)
  const b = uniqueTokens(bTokens)
  if (a.length === 0 || b.length === 0) return 0

  const bSet = new Set(b)
  let intersection = 0
  for (const token of new Set(a)) {
    if (bSet.has(token)) intersection += 1
  }

  const containment = intersection / Math.min(a.length, b.length)
  const union = a.length + b.length - intersection
  const jaccard = union === 0 ? 0 : intersection / union
  const dice = bigramDice(a.join(''), b.join(''))
  return 0.5 * containment + 0.3 * jaccard + 0.2 * dice
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

function normalizePost(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null
}

function setIdFor(normalizedBase: string, postNumber: number | null): string {
  const slug = normalizedBase.trim().replace(/\s+/gu, '-') || 'unnamed'
  return postNumber === null ? `set:${slug}` : `set:${slug}@${postNumber}`
}

interface ParsedEntry {
  input: ScriptFileInput
  parsed: ParsedFunscriptName
}

function buildSet(
  normalizedBase: string,
  postNumber: number | null,
  entries: readonly ParsedEntry[]
): ScriptSet {
  const files: ScriptSetFile[] = entries.map((entry) => ({
    fileId: entry.input.id,
    filename: entry.input.filename,
    base: entry.parsed.base,
    axis: entry.parsed.axis,
    axisToken: entry.parsed.axisToken,
    variant: entry.parsed.variant,
    isMain: entry.parsed.axis === null
  }))

  const axes: Axis[] = []
  const axisKeys = new Set<string>()
  const variants: string[] = []
  const variantKeys = new Set<string>()
  const mainFiles: ScriptSetFile[] = []
  const conflictByKey = new Map<string, ScriptConflict>()

  for (const file of files) {
    if (file.axis !== null) {
      const key = file.axis.toLowerCase()
      if (!axisKeys.has(key)) {
        axisKeys.add(key)
        axes.push(file.axis)
      }
    } else {
      mainFiles.push(file)
    }

    if (file.variant !== null && !variantKeys.has(file.variant)) {
      variantKeys.add(file.variant)
      variants.push(file.variant)
    }

    const conflictKey = `${(file.axis ?? 'main').toLowerCase()}\u0000${
      file.variant ?? ''
    }`
    const existing = conflictByKey.get(conflictKey)
    if (existing !== undefined) {
      existing.fileIds.push(file.fileId)
    } else {
      conflictByKey.set(conflictKey, {
        axis: file.axis,
        variant: file.variant,
        fileIds: [file.fileId]
      })
    }
  }

  const preferredMain =
    mainFiles.find((file) => file.variant === null) ?? mainFiles[0]
  const conflicts = [...conflictByKey.values()].filter(
    (conflict) => conflict.fileIds.length > 1
  )

  return {
    id: setIdFor(normalizedBase, postNumber),
    base: files[0]?.base ?? normalizedBase,
    normalizedBase,
    postNumber,
    files,
    axes,
    variants,
    mainFileId: preferredMain?.fileId ?? null,
    missingMain: axes.length > 0 && mainFiles.length === 0,
    conflicts
  }
}

/**
 * Group funscript files into per-video sets.
 *
 * - Grouping uses `normalizeScriptBase` (case/punctuation/bracket/space
 *   insensitive, camel-case aware).
 * - A base seen in more than one defined post is split per post; files with no
 *   post form their own set. When only one post is defined, all files join it.
 * - Non-funscript files are ignored.
 * - Two files mapping to the same axis + variant are recorded in `conflicts`.
 */
export function groupScriptSets(
  files: readonly ScriptFileInput[]
): ScriptSet[] {
  const byBase = new Map<string, ParsedEntry[]>()

  for (const input of files) {
    const parsed = parseFunscriptName(input.filename)
    if (parsed === null) continue
    const normalizedBase = normalizeScriptBase(parsed.base)
    const bucket = byBase.get(normalizedBase)
    if (bucket === undefined) byBase.set(normalizedBase, [{ input, parsed }])
    else bucket.push({ input, parsed })
  }

  const sets: ScriptSet[] = []
  for (const [normalizedBase, entries] of byBase) {
    const posts = [
      ...new Set(
        entries
          .map((entry) => normalizePost(entry.input.postNumber))
          .filter((post): post is number => post !== null)
      )
    ]

    if (posts.length <= 1) {
      sets.push(buildSet(normalizedBase, posts[0] ?? null, entries))
      continue
    }

    const byPost = new Map<number | null, ParsedEntry[]>()
    for (const entry of entries) {
      const post = normalizePost(entry.input.postNumber)
      const bucket = byPost.get(post)
      if (bucket === undefined) byPost.set(post, [entry])
      else bucket.push(entry)
    }
    for (const [post, bucket] of byPost) {
      sets.push(buildSet(normalizedBase, post, bucket))
    }
  }

  return sets
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/** Minimum score before a video is considered a real match. */
export const VIDEO_MATCH_THRESHOLD = 0.45

/** Top-two gap below which a match is reported as ambiguous instead of forced. */
export const VIDEO_MATCH_AMBIGUITY_MARGIN = 0.06

/** Same-post score bonus; the post is strong evidence when names are similar. */
export const SAME_POST_BONUS = 0.12

function stripLastExtension(filename: string): string {
  const value = leafName(filename).trim()
  const lastDot = value.lastIndexOf('.')
  if (lastDot <= 0) return value
  return value.slice(0, lastDot).trim()
}

function scoreVideo(
  set: ScriptSet,
  video: VideoCandidate,
  setTokens: readonly string[]
): number {
  let score = 0
  const names = [video.title]
  if (video.filename !== undefined) names.push(stripLastExtension(video.filename))

  for (const name of names) {
    if (typeof name !== 'string' || name.trim().length === 0) continue
    score = Math.max(
      score,
      similarity(setTokens, tokenizeName(name))
    )
  }

  const setPost = normalizePost(set.postNumber ?? undefined)
  const videoPost = normalizePost(video.postNumber)
  if (setPost !== null && videoPost !== null && setPost === videoPost) {
    score = Math.min(1, score + SAME_POST_BONUS)
  }

  return score
}

function roundScore(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

/**
 * Match script sets to candidate videos.
 *
 * Names are normalized (case, punctuation, brackets, resolution/fps tags,
 * camel-case boundaries) before token overlap and bigram similarity are
 * combined. A same-post match adds a bonus. A score below
 * `VIDEO_MATCH_THRESHOLD` yields `videoId: null`; if the top two candidates are
 * within `VIDEO_MATCH_AMBIGUITY_MARGIN` the result is marked ambiguous and no
 * video is forced.
 */
export function matchSetsToVideos(
  sets: readonly ScriptSet[],
  videos: readonly VideoCandidate[]
): SetVideoMatch[] {
  return sets.map((set) => {
    const setTokens = tokenizeName(set.base)
    const ranked = videos
      .map((video, index) => ({
        video,
        index,
        score: scoreVideo(set, video, setTokens)
      }))
      .sort((left, right) => right.score - left.score || left.index - right.index)

    const top = ranked[0]
    if (top === undefined || top.score < VIDEO_MATCH_THRESHOLD) {
      return {
        setId: set.id,
        videoId: null,
        score: top === undefined ? 0 : roundScore(top.score),
        ambiguous: false
      }
    }

    const second = ranked[1]
    if (
      second !== undefined &&
      top.score - second.score < VIDEO_MATCH_AMBIGUITY_MARGIN
    ) {
      return {
        setId: set.id,
        videoId: null,
        score: roundScore(top.score),
        ambiguous: true
      }
    }

    return {
      setId: set.id,
      videoId: top.video.id,
      score: roundScore(top.score),
      ambiguous: false
    }
  })
}

// ---------------------------------------------------------------------------
// Rename planning
// ---------------------------------------------------------------------------

/**
 * Plan target names for one set.
 *
 * - Main stroke: `<videoBase>.funscript`.
 * - Axis: `<videoBase>.<axis>.funscript`.
 * - Non-primary variant: `<videoBase>.<variant>.funscript`.
 * - Non-primary variant axis: `<videoBase>.<variant>.<axis>.funscript`.
 * - The variant equal to `primaryVariant` is promoted to the canonical name;
 *   an un-suffixed file on an axis it covers becomes
 *   `<videoBase>.original[.<axis>].funscript`.
 * - A combined single multi-axis file is just `<videoBase>.funscript`.
 * - Main is never synthesized: only existing files are planned.
 * - Every target runs through `sanitizeFilename`; duplicate targets (compared
 *   case-insensitively) throw `FunscriptRenameCollisionError`.
 */
/** Suffix for an un-suffixed file displaced by a promoted variant. */
export const ORIGINAL_VARIANT_LABEL = 'original'

export function planRenames(
  set: ScriptSet,
  videoFilename: string,
  opts: RenameOptions
): RenamePlanEntry[] {
  if (typeof videoFilename !== 'string' || videoFilename.trim().length === 0) {
    throw new FunscriptPairingError(
      'A video file name is required to plan funscript renames.'
    )
  }

  const videoBase = stripLastExtension(videoFilename)
  if (videoBase.length === 0) {
    throw new FunscriptPairingError(
      'The video file name has no usable base name.'
    )
  }

  const primaryVariant =
    opts.primaryVariant === null
      ? null
      : opts.primaryVariant.trim().toLowerCase() || null

  const plan: RenamePlanEntry[] = []
  const byTarget = new Map<string, RenameCollision>()

  // Axes (main = '') that the promoted variant covers. An un-suffixed file on
  // one of those axes would collide with the promoted name, so it is kept as
  // the `original` alternate instead of failing the whole plan.
  const promotedAxes = new Set<string>()
  if (primaryVariant !== null) {
    for (const file of set.files) {
      if (file.variant !== null && file.variant.toLowerCase() === primaryVariant) {
        promotedAxes.add((file.axis ?? '').toLowerCase())
      }
    }
  }

  for (const file of set.files) {
    const variantIsPrimary =
      file.variant !== null &&
      primaryVariant !== null &&
      file.variant.toLowerCase() === primaryVariant

    const segments = [videoBase]
    if (file.variant !== null && !variantIsPrimary) {
      segments.push(file.variant)
    } else if (
      file.variant === null &&
      promotedAxes.has((file.axis ?? '').toLowerCase())
    ) {
      segments.push(ORIGINAL_VARIANT_LABEL)
    }
    if (file.axis !== null) {
      segments.push(file.axis)
    }

    let targetName: string
    try {
      targetName = sanitizeFilename(`${segments.join('.')}.funscript`)
    } catch {
      throw new FunscriptPairingError(
        `Cannot build a safe funscript file name for "${file.filename}".`
      )
    }

    plan.push({ fileId: file.fileId, targetName })

    const key = targetName.toLowerCase()
    const existing = byTarget.get(key)
    if (existing !== undefined) existing.fileIds.push(file.fileId)
    else byTarget.set(key, { targetName, fileIds: [file.fileId] })
  }

  const collisions = [...byTarget.values()].filter(
    (collision) => collision.fileIds.length > 1
  )
  if (collisions.length > 0) {
    throw new FunscriptRenameCollisionError(collisions)
  }

  return plan
}
