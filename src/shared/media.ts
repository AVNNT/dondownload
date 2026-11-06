import { ValidationError } from './validation'

/**
 * Shared, renderer-safe media contracts for Milestone 3A.
 *
 * Nothing in this file may contain a page/source URL, disk path, request
 * headers, cookies, credentials, raw yt-dlp selectors or raw yt-dlp metadata.
 * Those values belong only to the internal persistence record below, which is
 * never sent over IPC.
 */

export const MEDIA_FORMAT_KINDS = ['video', 'audio'] as const
export type MediaFormatKind = (typeof MEDIA_FORMAT_KINDS)[number]

/**
 * User-selectable output container. `auto` keeps yt-dlp's natural container;
 * the others are remux/merge targets only and never imply transcoding.
 */
export const MEDIA_OUTPUT_FORMATS = ['auto', 'mp4', 'mkv', 'webm'] as const
export type MediaOutputFormat = (typeof MEDIA_OUTPUT_FORMATS)[number]

export interface MediaOutputSize {
  bytes: number | null
  isEstimate: boolean
}

export function isMediaOutputFormat(value: unknown): value is MediaOutputFormat {
  return (
    typeof value === 'string' &&
    (MEDIA_OUTPUT_FORMATS as readonly string[]).includes(value)
  )
}

export const MEDIA_JOB_STATUSES = [
  'queued',
  'analyzing',
  'downloading',
  'merging',
  'paused',
  'complete',
  'error',
  'cancelled',
  'interrupted'
] as const
export type MediaJobStatus = (typeof MEDIA_JOB_STATUSES)[number]

/** Statuses that represent work a restart can no longer continue. */
export const MEDIA_ACTIVE_JOB_STATUSES = [
  'queued',
  'analyzing',
  'downloading',
  'merging'
] as const

export function isMediaJobStatus(value: unknown): value is MediaJobStatus {
  return (
    typeof value === 'string' &&
    (MEDIA_JOB_STATUSES as readonly string[]).includes(value)
  )
}

export function isActiveMediaJobStatus(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    (MEDIA_ACTIVE_JOB_STATUSES as readonly string[]).includes(value)
  )
}

export const MEDIA_TOOL_STATUSES = [
  'stopped',
  'starting',
  'ready',
  'unavailable',
  'error'
] as const
export type MediaToolStatus = (typeof MEDIA_TOOL_STATUSES)[number]

export const MAX_MEDIA_URL_LENGTH = 4096
export const MAX_MEDIA_TITLE_LENGTH = 500
export const MAX_MEDIA_LABEL_LENGTH = 240
export const MAX_MEDIA_ERROR_LENGTH = 2000
export const MAX_MEDIA_OPTIONS = 200
export const MAX_MEDIA_JOBS = 10_000
/** One-job Cookie header bound shared by IPC, bridge and native host. */
export const MAX_MEDIA_COOKIE_LENGTH = 8192

export interface MediaFormatOption {
  kind: MediaFormatKind
  /** Opaque server-generated queue ID; the only accepted selection token. */
  optionId: string
  /** Server-generated, human-readable description for display only. */
  label: string
  container: string
  /** Resolution of the primary stream; null when unknown/not applicable. */
  width: number | null
  height: number | null
  fps: number | null
  videoCodec: string | null
  audioCodec: string | null
  /** Whether the produced output for this option includes audio. */
  hasAudio: boolean
  /** True when yt-dlp/ffmpeg must combine separate streams. */
  requiresMerge: boolean
  /** HDR transfer/range metadata is reported for the selected video stream. */
  hdr?: boolean
  /** Only a verified size is exposed here; unverified estimates stay null. */
  filesizeBytes: number | null
  /**
   * Best available size for display: exact `filesize`, fallback
   * `filesize_approx`, or the sum of both streams for a merged output.
   * Null when reported sizes are absent and no safe estimate is available.
   */
  estimatedBytes?: number | null
  /**
   * True when `estimatedBytes` is an approximation or a merged-stream sum
   * rather than an exact single-file size.
   */
  sizeIsEstimate?: boolean
  /**
   * Containers this exact option can produce without transcoding, including
   * `auto`. New analyses always send this; older payloads may omit it.
   */
  outputFormats?: MediaOutputFormat[]
  /** Size for each container selection when its stream pairing differs. */
  outputSizes?: Partial<Record<MediaOutputFormat, MediaOutputSize>>
  /** Original yt-dlp IDs used by the default Auto stream selection. */
  formatIds?: string[]
}

export interface MediaAnalysis {
  /** Opaque server-generated identifier tied to one fresh analysis. */
  analysisId: string
  title: string
  /** Public HTTPS thumbnail URL, or null when no safe thumbnail is available. */
  thumbnailUrl?: string | null
  durationSeconds: number | null
  options: MediaFormatOption[]
  /** Real video+audio output; may be a merge of separate streams. */
  bestVideoOptionId: string | null
  /** An actual audio-only stream. */
  bestAudioOptionId: string | null
  /** Unix epoch milliseconds after which the analysis is rejected. */
  expiresAt: number
}

export interface MediaJob {
  id: string
  analysisId: string
  optionId: string
  kind: MediaFormatKind
  /** Safe page title captured from analysis for useful download cards. */
  title: string
  label: string
  status: MediaJobStatus
  completedBytes: number
  totalBytes: number | null
  speedBps: number
  errorMessage: string | null
  createdAt: number
  updatedAt: number
  completedAt: number | null
  /**
   * Optional renderer hint only. The current backend does not persist a job
   * thumbnail, so live rows normally fall back to a category icon. Preview
   * fixtures use it to demonstrate the thumbnail treatment.
   */
  thumbnailUrl?: string | null
}

export interface MediaToolState {
  status: MediaToolStatus
  version: string | null
  message: string | null
  hint: string | null
}

export interface MediaSnapshot {
  tool: MediaToolState
  jobs: MediaJob[]
}

export interface AnalyzeMediaInput {
  /** Page URL. Normalized to http(s), without userinfo or fragment. */
  url: string
  /**
   * One-job Cookie header, present only when the user opted this exact origin
   * into browser cookies. Never persisted, logged or echoed.
   */
  cookie?: string
}

export interface MediaQueueInput {
  analysisId: string
  optionId: string
  /** Explicit user action only, for a deliberate second copy. */
  force?: true
  /** Optional hard maximum final output size in bytes; internal persistence only. */
  maxBytes?: number | null
  /** Requested output container; omitted means `auto`. */
  outputFormat?: MediaOutputFormat
  /** Must match the analysis' cookie use; memory-only. */
  cookie?: string
}

/**
 * INTERNAL persistence shape. It must never cross IPC or the native bridge.
 * `sourceUrl` is retained solely so a future worker can recover display data;
 * cookies, headers, raw metadata and yt-dlp commands are never persisted.
 */
export interface MediaJobRecord {
  id: string
  sourceUrl: string
  analysisId: string
  optionId: string
  kind: MediaFormatKind
  title: string
  label: string
  status: MediaJobStatus
  completedBytes: number
  totalBytes: number | null
  errorMessage: string | null
  /** Output directory needed for recovery. Not exposed through MediaJob. */
  dir: string
  /** Final output path needed for recovery. Not exposed through MediaJob. */
  filePath: string | null
  maxBytes?: number | null
  /** In-memory queue choice; persisted rows without it mean `auto`. */
  outputFormat?: MediaOutputFormat
  createdAt: number
  updatedAt: number
  completedAt: number | null
}

const OPAQUE_MEDIA_ID = /^[A-Za-z0-9_-]{1,128}$/
const CONTAINER = /^[a-z0-9][a-z0-9._+-]{0,31}$/
// eslint-disable-next-line no-control-regex -- rejecting control characters is the security intent here
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

function asPlainObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError('Invalid media payload.')
  }
  return value as Record<string, unknown>
}

function exactKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): void {
  for (const key of Object.keys(record)) {
    if (!required.includes(key) && !optional.includes(key)) {
      throw new ValidationError('The media payload contains unsupported fields.')
    }
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      throw new ValidationError('The media payload is missing required fields.')
    }
  }
}

function textValue(
  record: Record<string, unknown>,
  key: string,
  maximum: number
): string {
  const value = record[key]
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > maximum ||
    CONTROL_CHARACTERS.test(value)
  ) {
    throw new ValidationError('The media payload contains an invalid text field.')
  }
  return value
}

function nullableTextValue(
  record: Record<string, unknown>,
  key: string,
  maximum: number
): string | null {
  const value = record[key]
  if (value === null) return null
  return textValue(record, key, maximum)
}

function nullableHttpsUrl(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (
    typeof value !== 'string' ||
    value.length > 2048 ||
    CONTROL_CHARACTERS.test(value)
  ) {
    throw new ValidationError('The media thumbnail URL is invalid.')
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new ValidationError('The media thumbnail URL is invalid.')
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.hostname.length === 0
  ) {
    throw new ValidationError('The media thumbnail URL is invalid.')
  }
  return parsed.href
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
    throw new ValidationError('The media payload contains an invalid number.')
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

function finiteNumberValue(
  record: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number
): number {
  const value = record[key]
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new ValidationError('The media payload contains an invalid number.')
  }
  return value
}

function nullableFiniteNumberValue(
  record: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number
): number | null {
  if (record[key] === null) return null
  return finiteNumberValue(record, key, minimum, maximum)
}

function booleanValue(record: Record<string, unknown>, key: string): boolean {
  const value = record[key]
  if (typeof value !== 'boolean') {
    throw new ValidationError('The media payload contains an invalid flag.')
  }
  return value
}

function arrayValue(
  record: Record<string, unknown>,
  key: string,
  maximum: number
): unknown[] {
  const value = record[key]
  if (!Array.isArray(value) || value.length > maximum) {
    throw new ValidationError('The media payload contains an invalid list.')
  }
  return value
}

function opaqueId(value: unknown): string {
  if (typeof value !== 'string' || !OPAQUE_MEDIA_ID.test(value)) {
    throw new ValidationError('Invalid opaque media identifier.')
  }
  return value
}

export function parseMediaAnalysisId(value: unknown): string {
  return opaqueId(value)
}

export function parseMediaOptionId(value: unknown): string {
  return opaqueId(value)
}

export function parseMediaJobId(value: unknown): string {
  if (typeof value !== 'string' || !OPAQUE_MEDIA_ID.test(value)) {
    throw new ValidationError('Invalid media job identifier.')
  }
  return value
}

/** Accept ordinary web page URLs; credential-bearing URLs are rejected. */
export function normalizeMediaSourceUrl(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ValidationError('Enter a media page URL.')
  }

  const raw = value.trim()
  if (raw.length === 0) {
    throw new ValidationError('Enter a media page URL.')
  }
  if (raw.length > MAX_MEDIA_URL_LENGTH) {
    throw new ValidationError('The URL is too long (maximum 4096 characters).')
  }
  if (CONTROL_CHARACTERS.test(raw)) {
    throw new ValidationError('The URL contains unsupported control characters.')
  }

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new ValidationError('That does not look like a valid URL.')
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ValidationError('Only http:// and https:// URLs are supported.')
  }
  if (!parsed.hostname) {
    throw new ValidationError('The URL must include a host name.')
  }
  if (parsed.username || parsed.password) {
    throw new ValidationError('URLs containing credentials are not supported.')
  }
  parsed.hash = ''

  if (parsed.href.length > MAX_MEDIA_URL_LENGTH) {
    throw new ValidationError('The URL is too long (maximum 4096 characters).')
  }

  return parsed.href
}

export function parseMediaFormatOption(value: unknown): MediaFormatOption {
  const record = asPlainObject(value)
  exactKeys(
    record,
    [
      'kind',
      'optionId',
      'label',
      'container',
      'width',
      'height',
      'fps',
      'videoCodec',
      'audioCodec',
      'hasAudio',
      'requiresMerge',
      'filesizeBytes'
    ],
    [
      'estimatedBytes',
      'sizeIsEstimate',
      'outputFormats',
      'outputSizes',
      'formatIds',
      'hdr'
    ]
  )

  const kind = record.kind
  if (kind !== 'video' && kind !== 'audio') {
    throw new ValidationError('Unknown media format kind.')
  }

  const container = record.container
  if (typeof container !== 'string' || !CONTAINER.test(container)) {
    throw new ValidationError('Invalid media container.')
  }

  const option: MediaFormatOption = {
    kind,
    optionId: parseMediaOptionId(record.optionId),
    label: textValue(record, 'label', MAX_MEDIA_LABEL_LENGTH),
    container,
    width: nullableIntegerValue(record, 'width', 1, 65_535),
    height: nullableIntegerValue(record, 'height', 1, 65_535),
    fps: nullableFiniteNumberValue(record, 'fps', 0, 1_000),
    videoCodec: nullableTextValue(record, 'videoCodec', 64),
    audioCodec: nullableTextValue(record, 'audioCodec', 64),
    hasAudio: booleanValue(record, 'hasAudio'),
    requiresMerge: booleanValue(record, 'requiresMerge'),
    hdr: record.hdr === undefined ? false : booleanValue(record, 'hdr'),
    filesizeBytes: nullableIntegerValue(record, 'filesizeBytes', 0),
    estimatedBytes:
      record.estimatedBytes === undefined
        ? null
        : nullableIntegerValue(record, 'estimatedBytes', 0),
    sizeIsEstimate:
      record.sizeIsEstimate === undefined
        ? false
        : booleanValue(record, 'sizeIsEstimate')
  }

  if (kind === 'video' && !option.hasAudio) {
    throw new ValidationError('A video option must produce video with audio.')
  }
  if (kind === 'audio' && (!option.hasAudio || option.videoCodec !== null)) {
    throw new ValidationError('An audio option must not contain video.')
  }

  if (record.outputFormats !== undefined) {
    if (
      !Array.isArray(record.outputFormats) ||
      record.outputFormats.length === 0 ||
      record.outputFormats.length > MEDIA_OUTPUT_FORMATS.length
    ) {
      throw new ValidationError('Invalid media output formats.')
    }
    const outputFormats: MediaOutputFormat[] = []
    for (const value of record.outputFormats) {
      if (!isMediaOutputFormat(value) || outputFormats.includes(value)) {
        throw new ValidationError('Invalid media output formats.')
      }
      outputFormats.push(value)
    }
    option.outputFormats = outputFormats
  }

  if (record.outputSizes !== undefined) {
    const sizes = asPlainObject(record.outputSizes)
    const outputSizes: Partial<Record<MediaOutputFormat, MediaOutputSize>> = {}
    for (const [format, rawSize] of Object.entries(sizes)) {
      if (!isMediaOutputFormat(format)) {
        throw new ValidationError('Invalid per-format media size.')
      }
      const size = asPlainObject(rawSize)
      exactKeys(size, ['bytes', 'isEstimate'])
      outputSizes[format] = {
        bytes: nullableIntegerValue(size, 'bytes', 0),
        isEstimate: booleanValue(size, 'isEstimate')
      }
    }
    option.outputSizes = outputSizes
  }

  if (record.formatIds !== undefined) {
    if (
      !Array.isArray(record.formatIds) ||
      record.formatIds.length < 1 ||
      record.formatIds.length > 2 ||
      record.formatIds.some(
        (id) =>
          typeof id !== 'string' ||
          !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)
      )
    ) {
      throw new ValidationError('Invalid source format identifiers.')
    }
    option.formatIds = [...record.formatIds] as string[]
  }

  return option
}

export function parseMediaAnalysis(value: unknown): MediaAnalysis {
  const record = asPlainObject(value)
  exactKeys(
    record,
    [
      'analysisId',
      'title',
      'durationSeconds',
      'options',
      'bestVideoOptionId',
      'bestAudioOptionId',
      'expiresAt'
    ],
    ['thumbnailUrl']
  )

  const rawOptions = arrayValue(record, 'options', MAX_MEDIA_OPTIONS)
  const options = rawOptions.map(parseMediaFormatOption)
  const byId = new Map<string, MediaFormatOption>()
  for (const option of options) {
    if (byId.has(option.optionId)) {
      throw new ValidationError('Duplicate media option identifier.')
    }
    byId.set(option.optionId, option)
  }

  const bestVideoOptionId =
    record.bestVideoOptionId === null
      ? null
      : parseMediaOptionId(record.bestVideoOptionId)
  if (bestVideoOptionId !== null) {
    const option = byId.get(bestVideoOptionId)
    if (!option || option.kind !== 'video' || !option.hasAudio) {
      throw new ValidationError(
        'The best video option must produce video with audio.'
      )
    }
  }

  const bestAudioOptionId =
    record.bestAudioOptionId === null
      ? null
      : parseMediaOptionId(record.bestAudioOptionId)
  if (bestAudioOptionId !== null) {
    const option = byId.get(bestAudioOptionId)
    if (
      !option ||
      option.kind !== 'audio' ||
      !option.hasAudio ||
      option.videoCodec !== null
    ) {
      throw new ValidationError(
        'The best audio option must produce audio without video.'
      )
    }
  }

  return {
    analysisId: parseMediaAnalysisId(record.analysisId),
    title: textValue(record, 'title', MAX_MEDIA_TITLE_LENGTH),
    thumbnailUrl: nullableHttpsUrl(record.thumbnailUrl),
    durationSeconds: nullableFiniteNumberValue(
      record,
      'durationSeconds',
      0,
      Number.MAX_SAFE_INTEGER
    ),
    options,
    bestVideoOptionId,
    bestAudioOptionId,
    expiresAt: integerValue(record, 'expiresAt', 1)
  }
}

export function parseMediaJob(value: unknown): MediaJob {
  const record = asPlainObject(value)
  exactKeys(
    record,
    [
      'id',
      'analysisId',
      'optionId',
      'kind',
      'title',
      'label',
      'status',
      'completedBytes',
      'totalBytes',
      'speedBps',
      'errorMessage',
      'createdAt',
      'updatedAt',
      'completedAt'
    ],
    ['thumbnailUrl']
  )

  const kind = record.kind
  if (kind !== 'video' && kind !== 'audio') {
    throw new ValidationError('Unknown media format kind.')
  }
  if (!isMediaJobStatus(record.status)) {
    throw new ValidationError('Unknown media job status.')
  }

  return {
    id: parseMediaJobId(record.id),
    analysisId: parseMediaAnalysisId(record.analysisId),
    optionId: parseMediaOptionId(record.optionId),
    kind,
    title: textValue(record, 'title', MAX_MEDIA_TITLE_LENGTH),
    label: textValue(record, 'label', MAX_MEDIA_LABEL_LENGTH),
    status: record.status,
    completedBytes: integerValue(record, 'completedBytes', 0),
    totalBytes: nullableIntegerValue(record, 'totalBytes', 0),
    speedBps: finiteNumberValue(record, 'speedBps', 0, Number.MAX_SAFE_INTEGER),
    errorMessage: nullableTextValue(
      record,
      'errorMessage',
      MAX_MEDIA_ERROR_LENGTH
    ),
    createdAt: integerValue(record, 'createdAt', 1),
    updatedAt: integerValue(record, 'updatedAt', 1),
    completedAt: nullableIntegerValue(record, 'completedAt', 1),
    ...(record.thumbnailUrl === undefined
      ? {}
      : { thumbnailUrl: nullableHttpsUrl(record.thumbnailUrl) })
  }
}

export function parseMediaToolState(value: unknown): MediaToolState {
  const record = asPlainObject(value)
  exactKeys(record, ['status', 'version', 'message', 'hint'])
  const status = record.status
  if (
    typeof status !== 'string' ||
    !(MEDIA_TOOL_STATUSES as readonly string[]).includes(status)
  ) {
    throw new ValidationError('Unknown media tool status.')
  }
  return {
    status: status as MediaToolStatus,
    version: nullableTextValue(record, 'version', 100),
    message: nullableTextValue(record, 'message', MAX_MEDIA_ERROR_LENGTH),
    hint: nullableTextValue(record, 'hint', MAX_MEDIA_ERROR_LENGTH)
  }
}

export function parseMediaSnapshot(value: unknown): MediaSnapshot {
  const record = asPlainObject(value)
  exactKeys(record, ['tool', 'jobs'])
  const rawJobs = arrayValue(record, 'jobs', MAX_MEDIA_JOBS)
  const jobs = rawJobs.map(parseMediaJob)
  const ids = new Set<string>()
  for (const job of jobs) {
    if (ids.has(job.id)) {
      throw new ValidationError('Duplicate media job identifier.')
    }
    ids.add(job.id)
  }
  return {
    tool: parseMediaToolState(record.tool),
    jobs
  }
}

/**
 * Optional one-job Cookie header. The value is already flattened by the
 * extension; reject CR/LF, control characters and oversized payloads so it can
 * never become a second header or a persisted record.
 */
function optionalCookie(record: Record<string, unknown>): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(record, 'cookie')) return undefined
  const value = record.cookie
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > MAX_MEDIA_COOKIE_LENGTH ||
    CONTROL_CHARACTERS.test(value) ||
    /[\r\n]/.test(value)
  ) {
    throw new ValidationError('The browser cookie header is invalid.')
  }
  return value
}

export function parseAnalyzeMediaInput(value: unknown): AnalyzeMediaInput {
  const record = asPlainObject(value)
  exactKeys(record, ['url'], ['cookie'])
  const cookie = optionalCookie(record)
  return {
    url: normalizeMediaSourceUrl(record.url),
    ...(cookie === undefined ? {} : { cookie })
  }
}

export function parseMediaQueueInput(value: unknown): MediaQueueInput {
  const record = asPlainObject(value)
  exactKeys(record, ['analysisId', 'optionId'], [
    'force',
    'maxBytes',
    'outputFormat',
    'cookie'
  ])
  const cookie = optionalCookie(record)

  let force = false
  if (Object.prototype.hasOwnProperty.call(record, 'force')) {
    if (typeof record.force !== 'boolean') {
      throw new ValidationError('The force option must be true or false.')
    }
    force = record.force
  }

  let maxBytes: number | null | undefined
  if (Object.prototype.hasOwnProperty.call(record, 'maxBytes')) {
    if (record.maxBytes === null) maxBytes = null
    else maxBytes = integerValue(record, 'maxBytes', 1, 100 * 1024 ** 3)
  }

  let outputFormat: MediaOutputFormat | undefined
  if (Object.prototype.hasOwnProperty.call(record, 'outputFormat')) {
    if (!isMediaOutputFormat(record.outputFormat)) {
      throw new ValidationError('Choose a supported output format.')
    }
    outputFormat = record.outputFormat
  }

  return {
    analysisId: parseMediaAnalysisId(record.analysisId),
    optionId: parseMediaOptionId(record.optionId),
    ...(force ? { force: true as const } : {}),
    ...(maxBytes === undefined ? {} : { maxBytes }),
    ...(outputFormat === undefined ? {} : { outputFormat }),
    ...(cookie === undefined ? {} : { cookie })
  }
}
