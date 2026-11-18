import type { Batch } from './batches'
import { parseBatch } from './batches'
import {
  MAX_MEDIA_LABEL_LENGTH,
  isMediaOutputFormat,
  type MediaOutputFormat
} from './media'
import { ValidationError, normalizeHttpUrl } from './validation'

/**
 * Phase 1 Smart Link Scanner contract.
 *
 * A scan session is ephemeral and keyed by an opaque ID. The renderer only ever
 * sees that ID, bounded display text, a hostname and safe status values. Source
 * URLs, cookies, request headers, file paths and raw provider metadata stay in
 * the main process and never cross IPC or the native bridge.
 *
 * Starting or updating a scan can never queue anything. A download is created
 * only by an explicit `scan:queue-selection` call carrying item IDs.
 */

export const SCAN_CATEGORIES = [
  'video',
  'audio',
  'image',
  'document',
  'archive',
  'script',
  'other',
  'page'
] as const
export type ScanCategory = (typeof SCAN_CATEGORIES)[number]

/** `page` is a web page, never a file and never queueable. */
export const SCAN_QUEUEABLE_CATEGORIES = SCAN_CATEGORIES.filter(
  (category) => category !== 'page'
)

export const SCAN_ITEM_KINDS = ['file', 'page-link'] as const
export type ScanItemKind = (typeof SCAN_ITEM_KINDS)[number]

export const SCAN_ITEM_STATUSES = [
  'found',
  'probing',
  'ready',
  'signin',
  'protected',
  'unavailable',
  'tool-unavailable',
  /**
   * A likely video page whose player cannot be read automatically (for
   * example a Cloudflare challenge or an unsupported embed host). The card is
   * visible so the user can open it in their browser, but it is never
   * queueable and never treated as a direct file.
   */
  'browser-only'
] as const
export type ScanItemStatus = (typeof SCAN_ITEM_STATUSES)[number]

export const SCAN_SESSION_STATUSES = [
  'scanning',
  'done',
  'cancelled',
  'limited',
  'failed'
] as const
export type ScanSessionStatus = (typeof SCAN_SESSION_STATUSES)[number]

export const SCAN_ORIGINS = ['paste', 'extension'] as const
export type ScanOrigin = (typeof SCAN_ORIGINS)[number]

export const MAX_SCAN_ITEMS = 1000
/**
 * One explicit selection may queue a whole page of images, so the cap matches
 * the item cap instead of the older 500.
 */
export const MAX_SCAN_SELECTION = 1000
export const MAX_SCAN_HTML_BYTES = 5 * 1024 * 1024
export const MAX_SCAN_NAME_LENGTH = 240
export const MAX_SCAN_AUTHOR_LENGTH = 80
export const MAX_SCAN_HOST_LENGTH = 255
export const MAX_SCAN_MESSAGE_LENGTH = 400
export const MAX_SCAN_PROBES = 200
export const MAX_SCAN_CONCURRENT_ITEMS = 4
/** Phase 2: per-session yt-dlp metadata analyses. */
export const MAX_SCAN_VIDEO_ANALYSES = 15
export const MAX_SCAN_VIDEO_ANALYSIS_CONCURRENCY = 2
/** Plain page links shown in the collapsed "Other links" group. */
export const MAX_SCAN_OTHER_LINKS = 50
/**
 * Phase 2: pages the scanner may fetch itself (includes the pasted page).
 *
 * A forum topic is read completely through its own post JSON, so following is
 * limited to pages linked directly from those posts, one level deep. The cap
 * stays small so a topic scan cannot drift into suggested/related topics or
 * other user/category listings.
 */
export const MAX_SCAN_FOLLOW_PAGES = 10
export const MAX_SCAN_FOLLOW_DEPTH = 1
/** Most URLs accepted by one multi-topic paste. */
export const MAX_SCAN_URLS = 10
export const MAX_SCAN_FOLLOW_PER_HOST = 2
export const SCAN_SESSION_BUDGET_MS = 75_000
export const MAX_SCAN_VIDEO_FORMATS = 40
export const MAX_SCAN_RESOLUTION_LENGTH = 32

const OPAQUE_MEDIA_FORMAT_ID = /^[A-Za-z0-9_-]{1,128}$/
const MEDIA_CONTAINER = /^[a-z0-9][a-z0-9._+-]{0,31}$/

/**
 * Renderer-safe subset of one resolved media option. It deliberately carries
 * no format URL, selector, header or raw provider metadata; the opaque option
 * ID is the only token accepted by the queue path.
 */
export interface ScanVideoFormat {
  optionId: string
  kind: 'video' | 'audio'
  label: string
  container: string
  width: number | null
  height: number | null
  sizeBytes: number | null
  sizeIsEstimate: boolean
  outputFormats: MediaOutputFormat[]
}

/**
 * Renderer-safe score bucket for a script-set/video match. Raw similarity
 * floats stay in the main process.
 */
export const SCAN_MATCH_BUCKETS = ['strong', 'likely', 'weak', 'none'] as const
export type ScanMatchBucket = (typeof SCAN_MATCH_BUCKETS)[number]

export const MAX_SCAN_SCRIPT_AXES = 24
export const MAX_SCAN_SCRIPT_VARIANTS = 24
export const MAX_SCAN_SCRIPT_SET_ID_LENGTH = 300

export interface ScanScriptFile {
  /** Opaque scan item ID of the original funscript download. */
  id: string
  /** Original uploaded file name. */
  filename: string
  /** Canonical axis token, or null for the main stroke. */
  axis: string | null
  variant: string | null
  isMain: boolean
  /**
   * Planned on-disk name for the current (default) match, or null when the
   * set is not matched to a resolved video. Never a path.
   */
  targetName: string | null
}

export interface ScanScriptConflict {
  axis: string | null
  variant: string | null
  /** Scan item IDs that map to the same axis + variant. */
  fileIds: string[]
}

/**
 * One grouped `.funscript` set in a scan. Files, original names and planned
 * names only: a source URL, directory or full path never appears here.
 */
export interface ScanScriptSet {
  /** Stable set ID derived from the normalized base and post number. */
  id: string
  /** Display base with axis and variant tokens removed. */
  base: string
  postNumber: number | null
  /** Non-main axes present, in first-seen order. */
  axes: string[]
  /** Variant tokens present, in first-seen order. */
  variants: string[]
  /** True when the set has axes but no main-stroke script at all. */
  missingMain: boolean
  conflicts: ScanScriptConflict[]
  /** Resolved video item this set matches, or null. */
  matchedVideoItemId: string | null
  /** True when two or more videos are equally plausible; the user must pick. */
  ambiguous: boolean
  matchBucket: ScanMatchBucket
  files: ScanScriptFile[]
}

export interface ScanItem {
  /** Opaque session-local item ID; never a URL or selector. */
  id: string
  category: ScanCategory
  kind: ScanItemKind
  name: string
  /** Hostname only. The full URL is deliberately absent. */
  hostname: string
  sizeBytes: number | null
  /** True only after a bounded main-process probe observed the response. */
  verified: boolean
  status: ScanItemStatus
  /** Discourse post number when the item was found in a forum post. */
  postNumber: number | null
  /** Sanitized Discourse author display name. */
  author: string | null
  /** Phase 2 readiness: optional resolved media metadata. */
  durationSeconds?: number | null
  width?: number | null
  height?: number | null
  /** Already validated public HTTPS thumbnail, or null. */
  thumbnailUrl?: string | null
  /** Human-readable best resolution, for example `1080p`. */
  bestResolution?: string | null
  /** True when `sizeBytes` is an approximation or a merged-stream sum. */
  sizeIsEstimate?: boolean
  /** Renderer-safe format options for a resolved video page link. */
  formats?: ScanVideoFormat[]
  /** Option selected by default (normally the best video format). */
  bestOptionId?: string | null
  /** Short, safe explanation for sign-in/protected/unavailable states. */
  unavailableReason?: string | null
  /**
   * True while a browser-only card waits for the extension to hand off the
   * actual video from the page the user just opened. Main-only state exposed as
   * a boolean; the page URL itself never enters this DTO.
   */
  browserMatchPending?: boolean
  /**
   * Set when download/media history already has this exact source URL. The
   * scanner shows a badge and leaves the row unchecked by default; nothing is
   * blocked if the user deliberately ticks it again.
   */
  alreadyDownloaded?: {
    state: 'active' | 'finished'
    filename: string
    /** completedAt for a finished row, createdAt while active. */
    date: number
  } | null
}

export interface ScanCounters {
  found: number
  probing: number
  ready: number
  signin: number
  protected: number
  unavailable: number
  toolUnavailable: number
}

export interface ScanProgress {
  /** Number of pages/documents whose content has been requested. */
  fetchedPages: number
  /** All discovered items, including page links that are not queueable. */
  totalItems: number
  queueableItems: number
}

/**
 * Renderer-safe scan update. `items` contains new or changed items only;
 * `removedItemIds` lists items dropped by the item cap or dedupe. A client
 * merges updates into its own state.
 */
/**
 * What a session holds. `page` sessions discover content by fetching the page;
 * `images` sessions were filled by the browser extension with the images it
 * found on the live DOM, so the desktop only shows a picker; `gofile` sessions
 * were filled by the extension with the rows the user's own signed-in Gofile
 * tab rendered, so the desktop never fetches or scrapes Gofile itself.
 */
export const SCAN_SESSION_MODES = ['page', 'images', 'gofile'] as const
export type ScanSessionMode = (typeof SCAN_SESSION_MODES)[number]

export interface ScanSession {
  sessionId: string
  status: ScanSessionStatus
  origin: ScanOrigin
  /** Absent means `page`, so older snapshots and fixtures stay valid. */
  mode?: ScanSessionMode
  hostname: string
  /**
   * Safe topic/page title when one could be read (for example the Discourse
   * topic title). Never contains a URL or path.
   */
  title?: string | null
  /** Safe, user-facing status line. Never contains a URL or path. */
  message: string | null
  signinRequired: boolean
  counters: ScanCounters
  progress: ScanProgress
  items: ScanItem[]
  /**
   * Grouped funscript sets with their current match. Recomputed from the
   * current items on every snapshot, so a progressively resolved video updates
   * its match. Optional for older sessions and fixtures.
   */
  scriptSets?: ScanScriptSet[]
  removedItemIds: string[]
  revision: number
  updatedAt: number
}

export interface ScanStartInput {
  url: string
}

export interface ScanCancelInput {
  sessionId: string
}

/**
 * Optional per-video queue hints. The item ID must also appear in `itemIds`;
 * `optionId` is an opaque ID from a fresh scan item and is revalidated against
 * the analysis at queue time. Omitted options fall back to the item's best
 * format and the `auto` output container.
 */
export interface ScanQueueVideoOption {
  itemId: string
  optionId?: string
  outputFormat?: MediaOutputFormat
}

export interface ScanQueueSelectionInput {
  sessionId: string
  itemIds: string[]
  videoOptions?: ScanQueueVideoOption[]
  /** Explicit funscript pairings; every referenced item must also be selected. */
  pairings?: ScanScriptPairingInput[]
}

/**
 * One explicit funscript pairing. The user picked the video, the set and the
 * exact script files (axes) to download. `primaryVariant` is null when every
 * version keeps its variant suffix; otherwise that variant takes the canonical
 * name and the displaced plain file becomes `.original`.
 */
export interface ScanScriptPairingInput {
  videoItemId: string
  setId: string
  scriptItemIds: string[]
  primaryVariant: string | null
  rename: boolean
}

export interface ScanQueueSkip {
  itemId: string
  reason: string
}

export interface ScanQueueResult {
  /** Null when no selected item could be queued. */
  batch: Batch | null
  queuedItemIds: string[]
  skipped: ScanQueueSkip[]
}

/** Safe, renderer-facing reason a single topic selection was not queued. */
export interface ScanQueueSelectionError {
  code: string
  message: string
}

/**
 * Outcome of one topic inside a multi-selection queue request. A failure in one
 * topic never discards results from the topics that were queued.
 */
export type ScanQueueSelectionOutcome =
  | { sessionId: string; ok: true; value: ScanQueueResult }
  | { sessionId: string; ok: false; error: ScanQueueSelectionError }

const OPAQUE_ID = /^[A-Za-z0-9_-]{1,128}$/
// eslint-disable-next-line no-control-regex -- rejecting control characters is the security intent
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/
const UNSAFE_TEXT = /(?:\b[a-z][a-z0-9+.-]*:\/\/)|(?:[A-Za-z]:\\|\\\\[^\\])/i

function asPlainObject(
  value: unknown,
  subject = 'scan'
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError(`Invalid ${subject} payload.`)
  }
  return value as Record<string, unknown>
}

function exactKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
  subject = 'scan'
): void {
  for (const key of Object.keys(record)) {
    if (!required.includes(key) && !optional.includes(key)) {
      throw new ValidationError(
        `The ${subject} payload contains unsupported fields.`
      )
    }
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      throw new ValidationError(
        `The ${subject} payload is missing required fields.`
      )
    }
  }
}

function opaqueId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !OPAQUE_ID.test(value)) {
    throw new ValidationError(`Invalid ${label} identifier.`)
  }
  return value
}

function booleanValue(record: Record<string, unknown>, key: string): boolean {
  const value = record[key]
  if (typeof value !== 'boolean') {
    throw new ValidationError('The scan payload contains an invalid flag.')
  }
  return value
}

function integerValue(
  record: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER
): number {
  const value = record[key]
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new ValidationError('The scan payload contains an invalid number.')
  }
  return value
}

function nullableIntegerValue(
  record: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER
): number | null {
  if (record[key] === null) return null
  return integerValue(record, key, minimum, maximum)
}

function safeDisplayText(
  value: unknown,
  maximum: number,
  label: string,
  allowEmpty = false
): string {
  if (typeof value !== 'string') {
    throw new ValidationError(`The ${label} is invalid.`)
  }
  if (
    (!allowEmpty && value.trim().length === 0) ||
    value.length > maximum ||
    CONTROL_CHARACTERS.test(value)
  ) {
    throw new ValidationError(`The ${label} is invalid.`)
  }
  return value
}

function safeMessage(value: unknown): string | null {
  if (value === null) return null
  const text = safeDisplayText(value, MAX_SCAN_MESSAGE_LENGTH, 'scan message')
  if (UNSAFE_TEXT.test(text)) {
    throw new ValidationError('The scan message contains unsafe text.')
  }
  return text
}

export function isScanCategory(value: unknown): value is ScanCategory {
  return (
    typeof value === 'string' &&
    (SCAN_CATEGORIES as readonly string[]).includes(value)
  )
}

export function isScanItemKind(value: unknown): value is ScanItemKind {
  return (
    typeof value === 'string' &&
    (SCAN_ITEM_KINDS as readonly string[]).includes(value)
  )
}

export function isScanItemStatus(value: unknown): value is ScanItemStatus {
  return (
    typeof value === 'string' &&
    (SCAN_ITEM_STATUSES as readonly string[]).includes(value)
  )
}

/**
 * A queueable item is either a verified direct file or a resolved video page
 * link. A page, sign-in requirement, DRM-protected video or unavailable item
 * is never queueable.
 */
export function isQueueableScanItem(
  item: Pick<ScanItem, 'category' | 'kind' | 'status'>
): boolean {
  if (item.category === 'page') return false
  if (item.kind === 'file') {
    // An unverified direct file stays selectable; queueing re-probes and
    // fails closed. A sign-in requirement never is.
    return item.status !== 'signin'
  }
  return (
    item.kind === 'page-link' &&
    item.category === 'video' &&
    item.status === 'ready'
  )
}

/**
 * A listed page link the user can explicitly re-check as a video page. Already
 * resolved video cards and non-link files are excluded.
 */
export function isMarkableAsVideoScanItem(
  item: Pick<ScanItem, 'category' | 'kind' | 'status'>
): boolean {
  return (
    item.kind === 'page-link' &&
    item.category !== 'video' &&
    (item.status === 'found' || item.status === 'probing')
  )
}

export function isScanSessionStatus(
  value: unknown
): value is ScanSessionStatus {
  return (
    typeof value === 'string' &&
    (SCAN_SESSION_STATUSES as readonly string[]).includes(value)
  )
}

export function isScanOrigin(value: unknown): value is ScanOrigin {
  return (
    typeof value === 'string' &&
    (SCAN_ORIGINS as readonly string[]).includes(value)
  )
}

export function parseScanSessionId(value: unknown): string {
  return opaqueId(value, 'scan session')
}

export function parseScanItemId(value: unknown): string {
  return opaqueId(value, 'scan item')
}

export function parseScanStartInput(value: unknown): ScanStartInput {
  const record = asPlainObject(value, 'scan start')
  exactKeys(record, ['url'], [], 'scan start')
  return { url: normalizeHttpUrl(record.url) }
}

export interface ScanStartManyInput {
  urls: string[]
}

/**
 * Parse the multi-URL textarea. Empty lines are ignored; URLs are normalized
 * and deduplicated, and only the first `maximum` survive. Invalid lines are
 * reported (display-only) instead of being silently dropped.
 */
export interface ParsedScanUrlList {
  urls: string[]
  duplicates: number
  invalid: string[]
  /** Deduplicated URLs beyond the cap, not scanned. */
  overLimit: number
}

export function parseScanUrlList(
  value: string,
  maximum = MAX_SCAN_URLS
): ParsedScanUrlList {
  const limit = Math.max(1, Math.min(maximum, MAX_SCAN_URLS))
  const urls: string[] = []
  const seen = new Set<string>()
  const invalid: string[] = []
  let duplicates = 0
  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0) continue
    try {
      const url = normalizeHttpUrl(line)
      if (seen.has(url)) {
        duplicates += 1
        continue
      }
      seen.add(url)
      urls.push(url)
    } catch {
      invalid.push(line.slice(0, MAX_SCAN_MESSAGE_LENGTH))
    }
  }
  const kept = urls.slice(0, limit)
  return {
    urls: kept,
    duplicates,
    invalid,
    overLimit: urls.length - kept.length
  }
}

export function parseScanStartManyInput(value: unknown): ScanStartManyInput {
  const record = asPlainObject(value, 'scan start many')
  exactKeys(record, ['urls'], [], 'scan start many')
  const raw = record.urls
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_SCAN_URLS) {
    throw new ValidationError(`Enter between 1 and ${MAX_SCAN_URLS} page URLs.`)
  }
  const urls: string[] = []
  for (const entry of raw) {
    const url = normalizeHttpUrl(entry)
    if (!urls.includes(url)) urls.push(url)
  }
  if (urls.length === 0) {
    throw new ValidationError('Enter at least one page URL.')
  }
  return { urls }
}

export interface ScanQueueSelectionsInput {
  selections: ScanQueueSelectionInput[]
}

/**
 * One click across several scan topics. Each nested selection is validated
 * exactly like a single-session selection; pairings can only reference items
 * from their own session because the service resolves them per session.
 */
export function parseScanQueueSelectionsInput(
  value: unknown
): ScanQueueSelectionsInput {
  const record = asPlainObject(value, 'scan selections')
  exactKeys(record, ['selections'], [], 'scan selections')
  const raw = record.selections
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_SCAN_URLS) {
    throw new ValidationError(
      `Select items from between 1 and ${MAX_SCAN_URLS} scans.`
    )
  }
  const selections = raw.map(parseScanQueueSelectionInput)
  const sessionIds = new Set<string>()
  for (const selection of selections) {
    if (sessionIds.has(selection.sessionId)) {
      throw new ValidationError('Duplicate scan session selection.')
    }
    sessionIds.add(selection.sessionId)
  }
  return { selections }
}

export interface ScanQueueSelectionsResult {
  results: ScanQueueSelectionOutcome[]
}


export function parseScanCancelInput(value: unknown): ScanCancelInput {
  const record = asPlainObject(value, 'scan cancel')
  exactKeys(record, ['sessionId'], [], 'scan cancel')
  return { sessionId: parseScanSessionId(record.sessionId) }
}

/** Explicit "This is a video" action. Only opaque IDs cross IPC. */
export interface ScanMarkAsVideoInput {
  sessionId: string
  itemId: string
}

export function parseScanMarkAsVideoInput(
  value: unknown
): ScanMarkAsVideoInput {
  const record = asPlainObject(value, 'scan mark as video')
  exactKeys(record, ['sessionId', 'itemId'], [], 'scan mark as video')
  return {
    sessionId: parseScanSessionId(record.sessionId),
    itemId: parseScanItemId(record.itemId)
  }
}

export function parseScanQueueSelectionInput(
  value: unknown
): ScanQueueSelectionInput {
  const record = asPlainObject(value, 'scan selection')
  exactKeys(
    record,
    ['sessionId', 'itemIds'],
    ['videoOptions', 'pairings'],
    'scan selection'
  )

  const sessionId = parseScanSessionId(record.sessionId)
  const raw = record.itemIds
  if (
    !Array.isArray(raw) ||
    raw.length === 0 ||
    raw.length > MAX_SCAN_SELECTION
  ) {
    throw new ValidationError(
      `Select between 1 and ${MAX_SCAN_SELECTION} scan items.`
    )
  }
  const itemIds = raw.map(parseScanItemId)
  if (new Set(itemIds).size !== itemIds.length) {
    throw new ValidationError('Duplicate scan item identifier.')
  }

  let videoOptions: ScanQueueVideoOption[] | undefined
  if (Object.prototype.hasOwnProperty.call(record, 'videoOptions')) {
    const rawOptions = record.videoOptions
    if (
      !Array.isArray(rawOptions) ||
      rawOptions.length > MAX_SCAN_SELECTION
    ) {
      throw new ValidationError('The scan video options are invalid.')
    }
    const selected = new Set(itemIds)
    const seen = new Set<string>()
    videoOptions = rawOptions.map((entry) => {
      const option = asPlainObject(entry, 'scan video option')
      exactKeys(
        option,
        ['itemId'],
        ['optionId', 'outputFormat'],
        'scan video option'
      )
      const itemId = parseScanItemId(option.itemId)
      if (!selected.has(itemId)) {
        throw new ValidationError(
          'A scan video option does not belong to the selection.'
        )
      }
      if (seen.has(itemId)) {
        throw new ValidationError('Duplicate scan video option identifier.')
      }
      seen.add(itemId)

      let optionId: string | undefined
      if (Object.prototype.hasOwnProperty.call(option, 'optionId')) {
        const value = option.optionId
        if (
          typeof value !== 'string' ||
          !OPAQUE_MEDIA_FORMAT_ID.test(value)
        ) {
          throw new ValidationError('Invalid scan video option identifier.')
        }
        optionId = value
      }

      let outputFormat: MediaOutputFormat | undefined
      if (Object.prototype.hasOwnProperty.call(option, 'outputFormat')) {
        if (!isMediaOutputFormat(option.outputFormat)) {
          throw new ValidationError('Choose a supported output format.')
        }
        outputFormat = option.outputFormat
      }

      return {
        itemId,
        ...(optionId === undefined ? {} : { optionId }),
        ...(outputFormat === undefined ? {} : { outputFormat })
      }
    })
  }

  let pairings: ScanScriptPairingInput[] | undefined
  if (Object.prototype.hasOwnProperty.call(record, 'pairings')) {
    const rawPairings = record.pairings
    if (
      !Array.isArray(rawPairings) ||
      rawPairings.length > MAX_SCAN_SELECTION
    ) {
      throw new ValidationError('The scan script pairings are invalid.')
    }
    const selected = new Set(itemIds)
    const seenVideos = new Set<string>()
    const seenSets = new Set<string>()
    const claimedScripts = new Set<string>()
    pairings = rawPairings.map((entry) => {
      const pairing = asPlainObject(entry, 'scan script pairing')
      exactKeys(
        pairing,
        [
          'videoItemId',
          'setId',
          'scriptItemIds',
          'primaryVariant',
          'rename'
        ],
        [],
        'scan script pairing'
      )
      const videoItemId = parseScanItemId(pairing.videoItemId)
      if (!selected.has(videoItemId)) {
        throw new ValidationError(
          'A scan script pairing video does not belong to the selection.'
        )
      }
      if (seenVideos.has(videoItemId)) {
        throw new ValidationError('Duplicate scan script pairing video.')
      }
      seenVideos.add(videoItemId)

      const setId = scriptSetId(pairing.setId)
      if (seenSets.has(setId)) {
        throw new ValidationError('Duplicate scan script pairing set.')
      }
      seenSets.add(setId)

      const rawScripts = pairing.scriptItemIds
      if (
        !Array.isArray(rawScripts) ||
        rawScripts.length === 0 ||
        rawScripts.length > MAX_SCAN_SELECTION
      ) {
        throw new ValidationError('A scan script pairing has no scripts.')
      }
      const scriptItemIds = rawScripts.map(parseScanItemId)
      if (new Set(scriptItemIds).size !== scriptItemIds.length) {
        throw new ValidationError('Duplicate scan script item identifier.')
      }
      for (const scriptId of scriptItemIds) {
        if (!selected.has(scriptId)) {
          throw new ValidationError(
            'A scan script pairing file does not belong to the selection.'
          )
        }
        if (claimedScripts.has(scriptId)) {
          throw new ValidationError(
            'A scan script cannot belong to two pairings.'
          )
        }
        claimedScripts.add(scriptId)
      }

      let primaryVariant: string | null
      if (pairing.primaryVariant === null) {
        primaryVariant = null
      } else {
        primaryVariant = safeDisplayText(
          pairing.primaryVariant,
          32,
          'scan script primary variant'
        ).toLowerCase()
      }

      return {
        videoItemId,
        setId,
        scriptItemIds,
        primaryVariant,
        rename: booleanValue(pairing, 'rename')
      }
    })
  }

  return {
    sessionId,
    itemIds,
    ...(videoOptions === undefined ? {} : { videoOptions }),
    ...(pairings === undefined ? {} : { pairings })
  }
}

/**
 * Chosen scripts for a browser-only video. All values are opaque scan IDs or
 * bounded display tokens; no URL, path or header is accepted.
 */
export interface ScanBrowserScriptSelection {
  setId: string
  scriptItemIds: string[]
  primaryVariant: string | null
  rename: boolean
}

export interface ScanOpenInBrowserInput {
  sessionId: string
  itemId: string
  /**
   * Optional explicit script choice. When present, main remembers a pending
   * pairing for this card's page until the extension hands off the video.
   */
  pairing?: ScanBrowserScriptSelection
}

export interface ScanManualMatchInput extends ScanBrowserScriptSelection {
  sessionId: string
  /** Video card, or null when the user starts from a script-set row. */
  videoItemId: string | null
}

/** Renderer-safe result of a manual file match. Never contains a path. */
export interface ScanManualMatchResult {
  batchId: string
  /** Display filename of the video the user picked. */
  filename: string
}

function browserScriptSelection(
  value: unknown,
  subject: string
): ScanBrowserScriptSelection {
  const record = asPlainObject(value, subject)
  exactKeys(
    record,
    ['setId', 'scriptItemIds', 'primaryVariant', 'rename'],
    [],
    subject
  )
  const setId = scriptSetId(record.setId)
  const rawScripts = record.scriptItemIds
  if (
    !Array.isArray(rawScripts) ||
    rawScripts.length === 0 ||
    rawScripts.length > MAX_SCAN_SELECTION
  ) {
    throw new ValidationError(`The ${subject} has no scripts.`)
  }
  const scriptItemIds = rawScripts.map(parseScanItemId)
  if (new Set(scriptItemIds).size !== scriptItemIds.length) {
    throw new ValidationError('Duplicate scan script item identifier.')
  }
  let primaryVariant: string | null
  if (record.primaryVariant === null) {
    primaryVariant = null
  } else {
    primaryVariant = safeDisplayText(
      record.primaryVariant,
      32,
      `${subject} primary variant`
    ).toLowerCase()
  }
  return {
    setId,
    scriptItemIds,
    primaryVariant,
    rename: booleanValue(record, 'rename')
  }
}

export function parseScanOpenInBrowserInput(
  value: unknown
): ScanOpenInBrowserInput {
  const record = asPlainObject(value, 'scan open in browser')
  exactKeys(
    record,
    ['sessionId', 'itemId'],
    ['pairing'],
    'scan open in browser'
  )
  return {
    sessionId: parseScanSessionId(record.sessionId),
    itemId: parseScanItemId(record.itemId),
    ...(record.pairing === undefined
      ? {}
      : {
          pairing: browserScriptSelection(
            record.pairing,
            'scan open in browser pairing'
          )
        })
  }
}

export function parseScanManualMatchInput(
  value: unknown
): ScanManualMatchInput {
  const record = asPlainObject(value, 'scan manual match')
  exactKeys(
    record,
    ['sessionId', 'videoItemId', 'setId', 'scriptItemIds', 'primaryVariant', 'rename'],
    [],
    'scan manual match'
  )
  const selection = browserScriptSelection(
    {
      setId: record.setId,
      scriptItemIds: record.scriptItemIds,
      primaryVariant: record.primaryVariant,
      rename: record.rename
    },
    'scan manual match'
  )
  return {
    sessionId: parseScanSessionId(record.sessionId),
    videoItemId:
      record.videoItemId === null
        ? null
        : parseScanItemId(record.videoItemId),
    ...selection
  }
}

export function parseScanCounters(value: unknown): ScanCounters {
  const record = asPlainObject(value, 'scan counters')
  exactKeys(
    record,
    [
      'found',
      'probing',
      'ready',
      'signin',
      'protected',
      'unavailable',
      'toolUnavailable'
    ],
    [],
    'scan counters'
  )
  return {
    found: integerValue(record, 'found', 0, MAX_SCAN_ITEMS),
    probing: integerValue(record, 'probing', 0, MAX_SCAN_ITEMS),
    ready: integerValue(record, 'ready', 0, MAX_SCAN_ITEMS),
    signin: integerValue(record, 'signin', 0, MAX_SCAN_ITEMS),
    protected: integerValue(record, 'protected', 0, MAX_SCAN_ITEMS),
    unavailable: integerValue(record, 'unavailable', 0, MAX_SCAN_ITEMS),
    toolUnavailable: integerValue(record, 'toolUnavailable', 0, MAX_SCAN_ITEMS)
  }
}

export function parseScanProgress(value: unknown): ScanProgress {
  const record = asPlainObject(value, 'scan progress')
  exactKeys(
    record,
    ['fetchedPages', 'totalItems', 'queueableItems'],
    [],
    'scan progress'
  )
  const totalItems = integerValue(
    record,
    'totalItems',
    0,
    MAX_SCAN_ITEMS
  )
  const queueableItems = integerValue(
    record,
    'queueableItems',
    0,
    totalItems
  )
  return {
    fetchedPages: integerValue(record, 'fetchedPages', 0, 10_000),
    totalItems,
    queueableItems
  }
}

function nullableThumbnailUrl(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 2048 ||
    CONTROL_CHARACTERS.test(value)
  ) {
    throw new ValidationError('The scan thumbnail URL is invalid.')
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new ValidationError('The scan thumbnail URL is invalid.')
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.hostname.length === 0
  ) {
    throw new ValidationError('The scan thumbnail URL is invalid.')
  }
  return parsed.href
}

export function parseScanVideoFormat(value: unknown): ScanVideoFormat {
  const record = asPlainObject(value, 'scan video format')
  exactKeys(
    record,
    [
      'optionId',
      'kind',
      'label',
      'container',
      'width',
      'height',
      'sizeBytes',
      'sizeIsEstimate',
      'outputFormats'
    ],
    [],
    'scan video format'
  )

  const optionId = record.optionId
  if (
    typeof optionId !== 'string' ||
    !OPAQUE_MEDIA_FORMAT_ID.test(optionId)
  ) {
    throw new ValidationError('Invalid scan video option identifier.')
  }
  const kind = record.kind
  if (kind !== 'video' && kind !== 'audio') {
    throw new ValidationError('Unknown scan video format kind.')
  }
  const container = record.container
  if (typeof container !== 'string' || !MEDIA_CONTAINER.test(container)) {
    throw new ValidationError('Invalid scan video container.')
  }
  const rawOutputFormats = record.outputFormats
  if (
    !Array.isArray(rawOutputFormats) ||
    rawOutputFormats.length === 0 ||
    rawOutputFormats.length > 4
  ) {
    throw new ValidationError('Invalid scan video output formats.')
  }
  const outputFormats: MediaOutputFormat[] = []
  for (const entry of rawOutputFormats) {
    if (!isMediaOutputFormat(entry) || outputFormats.includes(entry)) {
      throw new ValidationError('Invalid scan video output formats.')
    }
    outputFormats.push(entry)
  }

  return {
    optionId,
    kind,
    label: safeDisplayText(
      record.label,
      MAX_MEDIA_LABEL_LENGTH,
      'scan video label'
    ),
    container,
    width: nullableIntegerValue(record, 'width', 1, 65_535),
    height: nullableIntegerValue(record, 'height', 1, 65_535),
    sizeBytes: nullableIntegerValue(record, 'sizeBytes', 0),
    sizeIsEstimate: booleanValue(record, 'sizeIsEstimate'),
    outputFormats
  }
}

export function isScanMatchBucket(value: unknown): value is ScanMatchBucket {
  return (
    typeof value === 'string' &&
    (SCAN_MATCH_BUCKETS as readonly string[]).includes(value)
  )
}

// eslint-disable-next-line no-control-regex -- rejecting control characters is the security intent
const SCRIPT_SET_ID = /^set:[^\s\u0000-\u001f\u007f/\\]{1,300}$/u

function scriptSetId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > MAX_SCAN_SCRIPT_SET_ID_LENGTH ||
    !SCRIPT_SET_ID.test(value)
  ) {
    throw new ValidationError('Invalid scan script set identifier.')
  }
  return value
}

function scriptTargetName(value: unknown): string | null {
  if (value === null) return null
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > MAX_SCAN_NAME_LENGTH ||
    CONTROL_CHARACTERS.test(value) ||
    /[/\\]/.test(value)
  ) {
    throw new ValidationError('Invalid scan script target name.')
  }
  return value
}

function scriptAxis(value: unknown): string | null {
  if (value === null) return null
  return safeDisplayText(value, 32, 'scan script axis')
}

function scriptVariant(value: unknown): string | null {
  if (value === null) return null
  return safeDisplayText(value, 32, 'scan script variant')
}

function scriptTokenList(
  value: unknown,
  label: string,
  maximum: number
): string[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new ValidationError(`The scan script ${label} are invalid.`)
  }
  const seen = new Set<string>()
  return value.map((entry) => {
    const token = safeDisplayText(entry, 32, `scan script ${label}`)
    const key = token.toLowerCase()
    if (seen.has(key)) {
      throw new ValidationError(`The scan script ${label} are invalid.`)
    }
    seen.add(key)
    return token
  })
}

export function parseScanScriptFile(value: unknown): ScanScriptFile {
  const record = asPlainObject(value, 'scan script file')
  exactKeys(
    record,
    ['id', 'filename', 'axis', 'variant', 'isMain', 'targetName'],
    [],
    'scan script file'
  )
  const filename = safeDisplayText(
    record.filename,
    MAX_SCAN_NAME_LENGTH,
    'scan script file name'
  )
  if (!/\.funscript$/iu.test(filename)) {
    throw new ValidationError('Invalid scan script file name.')
  }
  const axis = scriptAxis(record.axis)
  const isMain = booleanValue(record, 'isMain')
  if (isMain !== (axis === null)) {
    throw new ValidationError('Invalid scan script main-axis flag.')
  }
  return {
    id: parseScanItemId(record.id),
    filename,
    axis,
    variant: scriptVariant(record.variant),
    isMain,
    targetName: scriptTargetName(record.targetName)
  }
}

export function parseScanScriptSet(value: unknown): ScanScriptSet {
  const record = asPlainObject(value, 'scan script set')
  exactKeys(
    record,
    [
      'id',
      'base',
      'postNumber',
      'axes',
      'variants',
      'missingMain',
      'conflicts',
      'matchedVideoItemId',
      'ambiguous',
      'matchBucket',
      'files'
    ],
    [],
    'scan script set'
  )

  const rawFiles = record.files
  if (
    !Array.isArray(rawFiles) ||
    rawFiles.length === 0 ||
    rawFiles.length > MAX_SCAN_ITEMS
  ) {
    throw new ValidationError('The scan script set has an invalid file list.')
  }
  const files = rawFiles.map(parseScanScriptFile)
  const fileIds = new Set<string>()
  for (const file of files) {
    if (fileIds.has(file.id)) {
      throw new ValidationError('Duplicate scan script file identifier.')
    }
    fileIds.add(file.id)
  }

  const rawConflicts = record.conflicts
  if (!Array.isArray(rawConflicts) || rawConflicts.length > files.length) {
    throw new ValidationError('The scan script set has invalid conflicts.')
  }
  const conflicts: ScanScriptConflict[] = rawConflicts.map((entry) => {
    const conflict = asPlainObject(entry, 'scan script conflict')
    exactKeys(
      conflict,
      ['axis', 'variant', 'fileIds'],
      [],
      'scan script conflict'
    )
    const rawIds = conflict.fileIds
    if (!Array.isArray(rawIds) || rawIds.length < 2) {
      throw new ValidationError('The scan script conflict is invalid.')
    }
    const ids = rawIds.map(parseScanItemId)
    if (new Set(ids).size !== ids.length || ids.some((id) => !fileIds.has(id))) {
      throw new ValidationError('The scan script conflict is invalid.')
    }
    return {
      axis: scriptAxis(conflict.axis),
      variant: scriptVariant(conflict.variant),
      fileIds: ids
    }
  })

  if (!isScanMatchBucket(record.matchBucket)) {
    throw new ValidationError('Unknown scan script match bucket.')
  }

  return {
    id: scriptSetId(record.id),
    base: safeDisplayText(
      record.base,
      MAX_SCAN_NAME_LENGTH,
      'scan script base'
    ),
    postNumber: nullableIntegerValue(record, 'postNumber', 1, 1_000_000),
    axes: scriptTokenList(record.axes, 'axes', MAX_SCAN_SCRIPT_AXES),
    variants: scriptTokenList(
      record.variants,
      'variants',
      MAX_SCAN_SCRIPT_VARIANTS
    ),
    missingMain: booleanValue(record, 'missingMain'),
    conflicts,
    matchedVideoItemId:
      record.matchedVideoItemId === null
        ? null
        : parseScanItemId(record.matchedVideoItemId),
    ambiguous: booleanValue(record, 'ambiguous'),
    matchBucket: record.matchBucket,
    files
  }
}

export function parseScanItem(value: unknown): ScanItem {
  const record = asPlainObject(value, 'scan item')
  exactKeys(
    record,
    [
      'id',
      'category',
      'kind',
      'name',
      'hostname',
      'sizeBytes',
      'verified',
      'status',
      'postNumber',
      'author'
    ],
    [
      'durationSeconds',
      'width',
      'height',
      'thumbnailUrl',
      'bestResolution',
      'sizeIsEstimate',
      'formats',
      'bestOptionId',
      'unavailableReason',
      'browserMatchPending'
    ],
    'scan item'
  )

  const category = record.category
  if (!isScanCategory(category)) {
    throw new ValidationError('Unknown scan category.')
  }
  const kind = record.kind
  if (!isScanItemKind(kind)) {
    throw new ValidationError('Unknown scan item kind.')
  }
  const status = record.status
  if (!isScanItemStatus(status)) {
    throw new ValidationError('Unknown scan item status.')
  }
  if (category === 'page' && kind !== 'page-link') {
    throw new ValidationError('A page item must be a page link.')
  }

  const hostname = safeDisplayText(
    record.hostname,
    MAX_SCAN_HOST_LENGTH,
    'scan hostname'
  )
  if (/[\s/@\\]/.test(hostname)) {
    throw new ValidationError('The scan hostname is invalid.')
  }

  let formats: ScanVideoFormat[] | undefined
  if (Object.prototype.hasOwnProperty.call(record, 'formats')) {
    const rawFormats = record.formats
    if (
      !Array.isArray(rawFormats) ||
      rawFormats.length > MAX_SCAN_VIDEO_FORMATS
    ) {
      throw new ValidationError('The scan video format list is invalid.')
    }
    formats = rawFormats.map(parseScanVideoFormat)
    const optionIds = new Set<string>()
    for (const format of formats) {
      if (optionIds.has(format.optionId)) {
        throw new ValidationError('Duplicate scan video option identifier.')
      }
      optionIds.add(format.optionId)
    }
  }

  let bestOptionId: string | null | undefined
  if (Object.prototype.hasOwnProperty.call(record, 'bestOptionId')) {
    if (record.bestOptionId === null) {
      bestOptionId = null
    } else {
      if (
        typeof record.bestOptionId !== 'string' ||
        !OPAQUE_MEDIA_FORMAT_ID.test(record.bestOptionId)
      ) {
        throw new ValidationError('Invalid scan video default option.')
      }
      bestOptionId = record.bestOptionId
      if (!formats?.some((format) => format.optionId === bestOptionId)) {
        throw new ValidationError(
          'The scan video default option does not belong to its formats.'
        )
      }
    }
  }

  return {
    id: parseScanItemId(record.id),
    category,
    kind,
    name: safeDisplayText(record.name, MAX_SCAN_NAME_LENGTH, 'scan item name'),
    hostname,
    sizeBytes: nullableIntegerValue(record, 'sizeBytes', 1),
    verified: booleanValue(record, 'verified'),
    status,
    postNumber: nullableIntegerValue(record, 'postNumber', 1, 1_000_000),
    author:
      record.author === null
        ? null
        : safeDisplayText(
            record.author,
            MAX_SCAN_AUTHOR_LENGTH,
            'scan author'
          ),
    ...(Object.prototype.hasOwnProperty.call(record, 'durationSeconds')
      ? { durationSeconds: nullableIntegerValue(record, 'durationSeconds', 0) }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(record, 'width')
      ? { width: nullableIntegerValue(record, 'width', 1, 100_000) }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(record, 'height')
      ? { height: nullableIntegerValue(record, 'height', 1, 100_000) }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(record, 'thumbnailUrl')
      ? { thumbnailUrl: nullableThumbnailUrl(record.thumbnailUrl) }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(record, 'bestResolution')
      ? {
          bestResolution:
            record.bestResolution === null
              ? null
              : safeDisplayText(
                  record.bestResolution,
                  MAX_SCAN_RESOLUTION_LENGTH,
                  'scan video resolution'
                )
        }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(record, 'sizeIsEstimate')
      ? { sizeIsEstimate: booleanValue(record, 'sizeIsEstimate') }
      : {}),
    ...(formats === undefined ? {} : { formats }),
    ...(bestOptionId === undefined ? {} : { bestOptionId }),
    ...(Object.prototype.hasOwnProperty.call(record, 'unavailableReason')
      ? { unavailableReason: safeMessage(record.unavailableReason) }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(record, 'browserMatchPending')
      ? { browserMatchPending: booleanValue(record, 'browserMatchPending') }
      : {})
  }
}

export function parseScanSession(value: unknown): ScanSession {
  const record = asPlainObject(value, 'scan session')
  exactKeys(
    record,
    [
      'sessionId',
      'status',
      'origin',
      'hostname',
      'message',
      'signinRequired',
      'counters',
      'progress',
      'items',
      'removedItemIds',
      'revision',
      'updatedAt'
    ],
    ['scriptSets', 'title', 'mode'],
    'scan session'
  )

  const status = record.status
  if (!isScanSessionStatus(status)) {
    throw new ValidationError('Unknown scan session status.')
  }
  const origin = record.origin
  if (!isScanOrigin(origin)) {
    throw new ValidationError('Unknown scan origin.')
  }
  let mode: ScanSessionMode | undefined
  if (Object.prototype.hasOwnProperty.call(record, 'mode')) {
    const rawMode = record.mode
    if (!SCAN_SESSION_MODES.includes(rawMode as ScanSessionMode)) {
      throw new ValidationError('Unknown scan session mode.')
    }
    mode = rawMode as ScanSessionMode
  }

  const rawItems = record.items
  if (!Array.isArray(rawItems) || rawItems.length > MAX_SCAN_ITEMS) {
    throw new ValidationError('The scan payload contains an invalid item list.')
  }
  const rawRemoved = record.removedItemIds
  if (!Array.isArray(rawRemoved) || rawRemoved.length > MAX_SCAN_ITEMS) {
    throw new ValidationError('The scan payload contains an invalid removed list.')
  }

  const items = rawItems.map(parseScanItem)
  const ids = new Set<string>()
  for (const item of items) {
    if (ids.has(item.id)) {
      throw new ValidationError('Duplicate scan item identifier.')
    }
    ids.add(item.id)
  }

  let scriptSets: ScanScriptSet[] | undefined
  if (Object.prototype.hasOwnProperty.call(record, 'scriptSets')) {
    const rawSets = record.scriptSets
    if (!Array.isArray(rawSets) || rawSets.length > MAX_SCAN_ITEMS) {
      throw new ValidationError('The scan payload contains an invalid script list.')
    }
    scriptSets = rawSets.map(parseScanScriptSet)
    const setIds = new Set<string>()
    for (const set of scriptSets) {
      if (setIds.has(set.id)) {
        throw new ValidationError('Duplicate scan script set identifier.')
      }
      setIds.add(set.id)
      for (const file of set.files) {
        if (!ids.has(file.id)) {
          throw new ValidationError(
            'A scan script file does not belong to this scan.'
          )
        }
      }
      if (
        set.matchedVideoItemId !== null &&
        !ids.has(set.matchedVideoItemId)
      ) {
        throw new ValidationError(
          'A scan script match does not belong to this scan.'
        )
      }
    }
  }

  return {
    sessionId: parseScanSessionId(record.sessionId),
    status,
    origin,
    ...(mode === undefined ? {} : { mode }),
    hostname: safeDisplayText(
      record.hostname,
      MAX_SCAN_HOST_LENGTH,
      'scan hostname'
    ),
    ...(Object.prototype.hasOwnProperty.call(record, 'title')
      ? {
          title:
            record.title === null
              ? null
              : safeDisplayText(
                  record.title,
                  MAX_SCAN_MESSAGE_LENGTH,
                  'scan title'
                )
        }
      : {}),
    message: safeMessage(record.message),
    signinRequired: booleanValue(record, 'signinRequired'),
    counters: parseScanCounters(record.counters),
    progress: parseScanProgress(record.progress),
    items,
    ...(scriptSets === undefined ? {} : { scriptSets }),
    removedItemIds: rawRemoved.map(parseScanItemId),
    revision: integerValue(record, 'revision', 0),
    updatedAt: integerValue(record, 'updatedAt', 1)
  }
}

export function parseScanQueueResult(value: unknown): ScanQueueResult {
  const record = asPlainObject(value, 'scan queue result')
  exactKeys(
    record,
    ['batch', 'queuedItemIds', 'skipped'],
    [],
    'scan queue result'
  )

  const rawQueued = record.queuedItemIds
  if (!Array.isArray(rawQueued) || rawQueued.length > MAX_SCAN_SELECTION) {
    throw new ValidationError('The scan queue result contains an invalid selection.')
  }
  const rawSkipped = record.skipped
  if (!Array.isArray(rawSkipped) || rawSkipped.length > MAX_SCAN_SELECTION) {
    throw new ValidationError('The scan queue result contains invalid skips.')
  }

  const skipped = rawSkipped.map((entry) => {
    const skip = asPlainObject(entry, 'scan skip')
    exactKeys(skip, ['itemId', 'reason'], [], 'scan skip')
    return {
      itemId: parseScanItemId(skip.itemId),
      reason: safeDisplayText(skip.reason, MAX_SCAN_MESSAGE_LENGTH, 'scan skip reason')
    }
  })

  return {
    batch: record.batch === null ? null : parseBatch(record.batch),
    queuedItemIds: rawQueued.map(parseScanItemId),
    skipped
  }
}

export function parseScanQueueSelectionOutcome(
  value: unknown
): ScanQueueSelectionOutcome {
  const record = asPlainObject(value, 'scan queue outcome')
  const sessionId = parseScanSessionId(record.sessionId)
  if (record.ok === true) {
    exactKeys(
      record,
      ['sessionId', 'ok', 'value'],
      [],
      'scan queue outcome'
    )
    return {
      sessionId,
      ok: true,
      value: parseScanQueueResult(record.value)
    }
  }
  if (record.ok === false) {
    exactKeys(
      record,
      ['sessionId', 'ok', 'error'],
      [],
      'scan queue outcome'
    )
    const error = asPlainObject(record.error, 'scan queue error')
    exactKeys(error, ['code', 'message'], [], 'scan queue error')
    const message = safeMessage(error.message)
    if (message === null) {
      throw new ValidationError('The scan queue error message is invalid.')
    }
    return {
      sessionId,
      ok: false,
      error: {
        code: safeDisplayText(
          error.code,
          MAX_SCAN_MESSAGE_LENGTH,
          'scan queue error code'
        ),
        message
      }
    }
  }
  throw new ValidationError('The scan queue outcome is invalid.')
}

export function parseScanQueueSelectionsResult(
  value: unknown
): ScanQueueSelectionsResult {
  const record = asPlainObject(value, 'scan queue results')
  exactKeys(record, ['results'], [], 'scan queue results')
  const raw = record.results
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_SCAN_URLS) {
    throw new ValidationError('The scan queue results are invalid.')
  }
  return { results: raw.map(parseScanQueueSelectionOutcome) }
}

const DIRECT_FILE_EXTENSIONS = new Set([
  'mp4',
  'webm',
  'm4v',
  'mkv',
  'mov',
  'avi',
  'wmv',
  'flv',
  'ogv',
  'mpeg',
  'mpg',
  '3gp',
  'ts',
  'mp3',
  'm4a',
  'aac',
  'wav',
  'flac',
  'ogg',
  'oga',
  'opus',
  'wma',
  'aiff',
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'avif',
  'bmp',
  'tif',
  'tiff',
  'heic',
  'heif',
  'funscript',
  'pdf',
  'doc',
  'docx',
  'odt',
  'rtf',
  'txt',
  'md',
  'csv',
  'xls',
  'xlsx',
  'ods',
  'ppt',
  'pptx',
  'odp',
  'epub',
  'json',
  'xml',
  'log',
  'srt',
  'vtt',
  'zip',
  'rar',
  '7z',
  'tar',
  'gz',
  'tgz',
  'bz2',
  'xz',
  'zst',
  'iso',
  'img',
  'dmg',
  'm3u8',
  'mpd'
])

/**
 * Renderer-side heuristic for the Add dialog: an obvious direct file should
 * keep using Quick Add. Any other HTTP(S) page can start a scan. This is only
 * a UI hint; the main process validates everything again.
 */
export function isObviousDirectFileUrl(value: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  const trimmed = parsed.pathname.replace(/\/+$/, '')
  const match = /\.([a-z0-9]{1,12})$/i.exec(trimmed)
  if (match && DIRECT_FILE_EXTENSIONS.has(match[1]!.toLowerCase())) {
    return true
  }
  return (
    (parsed.hostname === 'pixeldrain.com' ||
      parsed.hostname === 'www.pixeldrain.com') &&
    /^\/u\/[A-Za-z0-9_-]{4,}$/.test(parsed.pathname)
  )
}
