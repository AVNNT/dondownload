import { ValidationError, normalizeHttpUrl, parseDownloadRequestHeaders } from './validation'

/**
 * Strict browser-extension -> native-host -> desktop message for "Download
 * images on this page".
 *
 * The extension already walked the live DOM (including Pinterest's JS-rendered
 * boards), so the desktop never fetches the page itself: it only validates the
 * reported URLs and opens the image picker. Every URL is http(s), credential
 * free and length bounded; the list is deduplicated and capped.
 */
export const SCAN_IMAGES_CHANNEL = 'scan-images'
export const SCAN_IMAGES_ROUTE = '/scan-images'

/** Hard cap on images reported by one page walk. */
export const MAX_SCAN_IMAGES = 1000
/**
 * A full page walk is far larger than any other bridge body: 1000 entries with
 * an originals URL, a 736x fallback, dimensions and a 200 character
 * description reach roughly 300 KB. The `/scan-images` route therefore accepts
 * up to one native-messaging frame (1 MiB) while every other route keeps the
 * much smaller default. The Windows native host mirrors this limit in C#.
 */
export const MAX_SCAN_IMAGES_BODY_BYTES = 1024 * 1024
export const MAX_SCAN_IMAGE_ALT_LENGTH = 200
export const MAX_SCAN_PAGE_TITLE_LENGTH = 200
/** Longest folder name the desktop derives from the page title. */
export const MAX_IMAGE_FOLDER_LENGTH = 80
const MAX_IMAGE_DIMENSION = 100_000

export interface ScanImageEntry {
  /** The URL that is downloaded (Pinterest: the `/originals/` variant). */
  url: string
  /**
   * Used only when `url` fails with a 403/404. Pinterest originals sometimes
   * have a different extension, so the extension also reports the 736x URL.
   */
  fallbackUrl?: string
  width?: number
  height?: number
  alt?: string
}

export interface ScanImagesRequest {
  type: typeof SCAN_IMAGES_CHANNEL
  pageUrl: string
  pageTitle: string
  images: ScanImageEntry[]
  cookie?: string
}

function asPlainObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError('Invalid image scan request.')
  }
  return value as Record<string, unknown>
}

function cleanText(value: string, maximum: number): string {
  const cleaned = value
    .normalize('NFKC')
    // eslint-disable-next-line no-control-regex -- rejecting control characters is the security intent
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return Array.from(cleaned).slice(0, maximum).join('').trim()
}

function parseDimension(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ValidationError('An image size is invalid.')
  }
  const rounded = Math.round(value)
  if (rounded < 0 || rounded > MAX_IMAGE_DIMENSION) {
    throw new ValidationError('An image size is invalid.')
  }
  return rounded
}

function parseImageEntry(value: unknown): ScanImageEntry {
  const record = asPlainObject(value)
  for (const key of Object.keys(record)) {
    if (
      key !== 'url' &&
      key !== 'fallbackUrl' &&
      key !== 'width' &&
      key !== 'height' &&
      key !== 'alt'
    ) {
      throw new ValidationError('An image entry contains unsupported fields.')
    }
  }
  const url = normalizeHttpUrl(record.url)
  const fallbackUrl =
    record.fallbackUrl === undefined ? undefined : normalizeHttpUrl(record.fallbackUrl)
  const width = parseDimension(record.width)
  const height = parseDimension(record.height)
  let alt: string | undefined
  if (record.alt !== undefined) {
    if (typeof record.alt !== 'string') {
      throw new ValidationError('An image description is invalid.')
    }
    const cleaned = cleanText(record.alt, MAX_SCAN_IMAGE_ALT_LENGTH)
    if (cleaned.length > 0) alt = cleaned
  }
  return {
    url,
    ...(fallbackUrl === undefined || fallbackUrl === url ? {} : { fallbackUrl }),
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
    ...(alt === undefined ? {} : { alt })
  }
}

export function parseScanImagesRequest(value: unknown): ScanImagesRequest {
  const record = asPlainObject(value)
  for (const key of Object.keys(record)) {
    if (
      key !== 'type' &&
      key !== 'pageUrl' &&
      key !== 'pageTitle' &&
      key !== 'images' &&
      key !== 'cookie'
    ) {
      throw new ValidationError('The image scan request contains unsupported fields.')
    }
  }
  // The native host forwards `{ pageUrl, pageTitle, images, cookie? }` to the
  // dedicated /scan-images route, so the route itself names the operation. A
  // `type`, when present, must still be exactly `scan-images`.
  if (record.type !== undefined && record.type !== SCAN_IMAGES_CHANNEL) {
    throw new ValidationError('Unsupported scan operation.')
  }

  const pageUrl = normalizeHttpUrl(record.pageUrl)
  if (typeof record.pageTitle !== 'string') {
    throw new ValidationError('The page title is invalid.')
  }
  const pageTitle = cleanText(record.pageTitle, MAX_SCAN_PAGE_TITLE_LENGTH)

  const rawImages = record.images
  if (!Array.isArray(rawImages) || rawImages.length === 0) {
    throw new ValidationError('No images were reported for that page.')
  }
  if (rawImages.length > MAX_SCAN_IMAGES) {
    throw new ValidationError(
      `A page can report at most ${MAX_SCAN_IMAGES} images at once.`
    )
  }

  const seen = new Set<string>()
  const images: ScanImageEntry[] = []
  for (const rawImage of rawImages) {
    const image = parseImageEntry(rawImage)
    if (seen.has(image.url)) continue
    seen.add(image.url)
    images.push(image)
  }
  if (images.length === 0) {
    throw new ValidationError('No images were reported for that page.')
  }

  let cookie: string | undefined
  if (record.cookie !== undefined) {
    const headers = parseDownloadRequestHeaders({ cookie: record.cookie })
    if (headers.cookie === undefined) {
      throw new ValidationError('The scan cookie header is invalid.')
    }
    cookie = headers.cookie
  }

  return {
    type: SCAN_IMAGES_CHANNEL,
    pageUrl,
    pageTitle: pageTitle.length === 0 ? 'Untitled page' : pageTitle,
    images,
    ...(cookie === undefined ? {} : { cookie })
  }
}

const WINDOWS_RESERVED = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9'
])

/**
 * Folder name for one image batch. The page title is user-visible text, so it
 * is reduced to a single safe path segment: no separators, no reserved device
 * names, no trailing dots or spaces, and a bounded length.
 */
export function imageFolderName(pageTitle: string): string {
  const cleaned = cleanText(pageTitle, MAX_IMAGE_FOLDER_LENGTH * 2)
    // eslint-disable-next-line no-control-regex -- rejecting control characters is the security intent
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const bounded = Array.from(cleaned)
    .slice(0, MAX_IMAGE_FOLDER_LENGTH)
    .join('')
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '')
  if (bounded.length === 0) return 'Images'
  if (WINDOWS_RESERVED.has(bounded.toLowerCase())) return `_${bounded}`
  return bounded
}
