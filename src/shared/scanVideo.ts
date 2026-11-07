import {
  ValidationError,
  normalizeHttpUrl,
  parseDownloadRequestHeaders
} from './validation'

/**
 * Strict browser-extension -> native-host -> desktop message for a video page
 * the user opened in their own browser.
 *
 * Some video pages cannot be read by the app at all: `hanime1.me/watch?v=…` has
 * no yt-dlp extractor and sits behind Cloudflare, and Pornhub/Eporner answer an
 * age gate, geo block or cookie wall. The user's real browser session already
 * solved that, so the extension reads the media URLs the rendered page exposes
 * (video/source elements, `currentSrc`, player configs) in its isolated world
 * and reports them here.
 *
 * The desktop re-validates everything: every URL must be public HTTP(S), the
 * list is capped and deduplicated, and the optional one-shot Cookie is the same
 * exact-origin value the other browser scans use. Nothing is fetched from the
 * extension's report and nothing is queued from here.
 */
export const SCAN_VIDEO_CHANNEL = 'scan-video'
export const SCAN_VIDEO_ROUTE = '/scan-video'

/** One page rarely exposes more than a handful of renditions. */
export const MAX_SCAN_VIDEO_MEDIA_SOURCES = 24
export const MAX_SCAN_VIDEO_MEDIA_LABEL_LENGTH = 80
export const MAX_SCAN_VIDEO_MEDIA_TITLE_LENGTH = 300
export const MAX_SCAN_VIDEO_MEDIA_DIMENSION = 100_000
/** 10 TB is far above any real video and keeps the size a sane number. */
export const MAX_SCAN_VIDEO_MEDIA_BYTES = 10_000_000_000_000
/** 24 sources with a 4 KiB URL stay well below this. */
export const MAX_SCAN_VIDEO_BODY_BYTES = 256 * 1024

/**
 * `file` is a progressive container (mp4/webm) that the normal downloader
 * takes; `hls`/`dash` are manifests that the media engine downloads.
 */
export const SCAN_VIDEO_MEDIA_KINDS = ['file', 'hls', 'dash'] as const
export type ScanVideoMediaKind = (typeof SCAN_VIDEO_MEDIA_KINDS)[number]

export interface ScanVideoMediaSource {
  url: string
  kind: ScanVideoMediaKind
  /** Player label such as `1080p` or `Full HD`, already bounded. */
  label?: string
  width?: number
  height?: number
  sizeBytes?: number
}

export interface ScanVideoRequest {
  type: typeof SCAN_VIDEO_CHANNEL
  pageUrl: string
  title?: string
  sources: ScanVideoMediaSource[]
  cookie?: string
}

export function isScanVideoMediaKind(value: unknown): value is ScanVideoMediaKind {
  return (
    typeof value === 'string' &&
    (SCAN_VIDEO_MEDIA_KINDS as readonly string[]).includes(value)
  )
}

function asPlainObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError('Invalid video scan request.')
  }
  return value as Record<string, unknown>
}

function boundedText(value: unknown, maximum: number): string | null {
  if (typeof value !== 'string') return null
  const cleaned = value
    .normalize('NFKC')
    // eslint-disable-next-line no-control-regex -- rejecting control characters is the security intent
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (cleaned.length === 0) return null
  return Array.from(cleaned).slice(0, maximum).join('').trim()
}

function readDimension(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value <= 0 ||
    value > MAX_SCAN_VIDEO_MEDIA_DIMENSION
  ) {
    throw new ValidationError('A video size is invalid.')
  }
  return Math.round(value)
}

function parseSource(value: unknown): ScanVideoMediaSource {
  const record = asPlainObject(value)
  for (const key of Object.keys(record)) {
    if (
      key !== 'url' &&
      key !== 'kind' &&
      key !== 'label' &&
      key !== 'width' &&
      key !== 'height' &&
      key !== 'sizeBytes'
    ) {
      throw new ValidationError('A video source contains unsupported fields.')
    }
  }
  const url = normalizeHttpUrl(record.url)
  if (!isScanVideoMediaKind(record.kind)) {
    throw new ValidationError('A video source kind is unsupported.')
  }
  const label = boundedText(record.label, MAX_SCAN_VIDEO_MEDIA_LABEL_LENGTH)
  const width = readDimension(record.width)
  const height = readDimension(record.height)
  let sizeBytes: number | undefined
  if (record.sizeBytes !== undefined && record.sizeBytes !== null) {
    if (
      typeof record.sizeBytes !== 'number' ||
      !Number.isFinite(record.sizeBytes) ||
      record.sizeBytes <= 0 ||
      record.sizeBytes > MAX_SCAN_VIDEO_MEDIA_BYTES
    ) {
      throw new ValidationError('A video source size is invalid.')
    }
    sizeBytes = Math.round(record.sizeBytes)
  }
  return {
    url,
    kind: record.kind,
    ...(label === null ? {} : { label }),
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
    ...(sizeBytes === undefined ? {} : { sizeBytes })
  }
}

/**
 * Validate one extension-reported video page. Sources are deduplicated by URL
 * and capped; a page that exposed nothing may report an empty list so the
 * desktop can keep the card browser-only with a truthful reason.
 */
export function parseScanVideoRequest(value: unknown): ScanVideoRequest {
  const record = asPlainObject(value)
  for (const key of Object.keys(record)) {
    if (
      key !== 'type' &&
      key !== 'pageUrl' &&
      key !== 'title' &&
      key !== 'sources' &&
      key !== 'cookie'
    ) {
      throw new ValidationError('The video scan request contains unsupported fields.')
    }
  }
  // The native host forwards `{ pageUrl, title?, sources, cookie? }` to the
  // dedicated /scan-video route, so the route itself names the operation. A
  // `type`, when present, must still be exactly `scan-video`.
  if (record.type !== undefined && record.type !== SCAN_VIDEO_CHANNEL) {
    throw new ValidationError('Unsupported scan operation.')
  }

  const pageUrl = normalizeHttpUrl(record.pageUrl)
  const rawSources = record.sources
  if (!Array.isArray(rawSources)) {
    throw new ValidationError('The video source list is invalid.')
  }
  if (rawSources.length > MAX_SCAN_VIDEO_MEDIA_SOURCES) {
    throw new ValidationError(
      `A video page can report at most ${MAX_SCAN_VIDEO_MEDIA_SOURCES} sources at once.`
    )
  }
  const seen = new Set<string>()
  const sources: ScanVideoMediaSource[] = []
  for (const rawSource of rawSources) {
    const source = parseSource(rawSource)
    if (seen.has(source.url)) continue
    seen.add(source.url)
    sources.push(source)
  }

  const title = boundedText(record.title, MAX_SCAN_VIDEO_MEDIA_TITLE_LENGTH)

  let cookie: string | undefined
  if (record.cookie !== undefined) {
    const headers = parseDownloadRequestHeaders({ cookie: record.cookie })
    if (headers.cookie === undefined) {
      throw new ValidationError('The scan cookie header is invalid.')
    }
    cookie = headers.cookie
  }

  return {
    type: SCAN_VIDEO_CHANNEL,
    pageUrl,
    ...(title === null ? {} : { title }),
    sources,
    ...(cookie === undefined ? {} : { cookie })
  }
}
