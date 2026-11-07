import { ValidationError, normalizeHttpUrl, parseDownloadRequestHeaders } from './validation'
import {
  GOFILE_SHARE_ID_PATTERN,
  MAX_GOFILE_FILES,
  MAX_GOFILE_NAME_LENGTH,
  MAX_GOFILE_SIZE_BYTES,
  isGofileDownloadUrl,
  isGofileShareStatus,
  type GofileShareStatus
} from './gofile'

/**
 * Strict browser-extension -> native-host -> desktop message for "Scan this
 * page with DonDownload". The only optional extra is the exact-host Cookie the
 * user already opted into for that origin. It is never persisted.
 */
export const SCAN_PAGE_CHANNEL = 'scan-page'
export const SCAN_PAGE_ROUTE = '/scan-page'

/**
 * Strict browser-extension -> native-host -> desktop message for a Gofile share
 * the user opened in their own browser.
 *
 * The extension read the rendered rows from that tab, so the desktop never
 * fetches `gofile.io`, never calls `api.gofile.io` and never creates a guest
 * account. Every download URL must be HTTPS on `gofile.io` or a `store<N>`
 * host, the list is capped, and the optional `accountToken` Cookie is the same
 * one-shot, never-persisted value the other browser scans use.
 */
export const SCAN_GOFILE_CHANNEL = 'scan-gofile'
export const SCAN_GOFILE_ROUTE = '/scan-gofile'
/**
 * 500 files with a 240 character name and a full download URL stay well below
 * this. The Windows native host mirrors the same cap in C#.
 */
export const MAX_SCAN_GOFILE_BODY_BYTES = 512 * 1024

export interface ScanGofileFile {
  name: string
  /** Exact byte size when the page showed one, otherwise null. */
  size: number | null
  url: string
}

/**
 * A rendered row whose download URL the page never exposed. The real gofile.io
 * frontend builds the download from a transient anchor, so a row can stay
 * without a URL; it is still reported so the desktop can show it as an
 * unavailable card instead of hiding the file.
 */
export interface ScanGofileRow {
  name: string
  size: number | null
}

export interface ScanGofileRequest {
  type: typeof SCAN_GOFILE_CHANNEL
  shareId: string
  status: GofileShareStatus
  files: ScanGofileFile[]
  unavailable?: ScanGofileRow[]
  cookie?: string
}

export interface ScanPageRequest {
  type: typeof SCAN_PAGE_CHANNEL
  url: string
  cookie?: string
}

function asPlainObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError('Invalid scan request.')
  }
  return value as Record<string, unknown>
}

export function parseScanPageRequest(value: unknown): ScanPageRequest {
  const record = asPlainObject(value)
  for (const key of Object.keys(record)) {
    if (key !== 'type' && key !== 'url' && key !== 'cookie') {
      throw new ValidationError('The scan request contains unsupported fields.')
    }
  }
  // The native host forwards `{ url, cookie? }` to the dedicated /scan-page
  // route, so the route itself names the operation. A `type`, when present,
  // must still be exactly `scan-page`.
  if (record.type !== undefined && record.type !== SCAN_PAGE_CHANNEL) {
    throw new ValidationError('Unsupported scan operation.')
  }
  const url = normalizeHttpUrl(record.url)
  if (record.cookie === undefined) {
    return { type: SCAN_PAGE_CHANNEL, url }
  }
  const headers = parseDownloadRequestHeaders({ cookie: record.cookie })
  if (headers.cookie === undefined) {
    throw new ValidationError('The scan cookie header is invalid.')
  }
  return { type: SCAN_PAGE_CHANNEL, url, cookie: headers.cookie }
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

function parseGofileFile(value: unknown): ScanGofileFile | null {
  const record = asPlainObject(value)
  for (const key of Object.keys(record)) {
    if (key !== 'name' && key !== 'size' && key !== 'url') {
      throw new ValidationError('A Gofile file entry contains unsupported fields.')
    }
  }
  const url = normalizeHttpUrl(record.url)
  // The rendered page may only point at Gofile itself. A foreign host in a
  // download href is rejected here, before it can reach the download manager.
  if (!isGofileDownloadUrl(url)) {
    throw new ValidationError('A Gofile download link is not on gofile.io.')
  }
  const name = boundedText(record.name, MAX_GOFILE_NAME_LENGTH)
  if (name === null) {
    throw new ValidationError('A Gofile file name is invalid.')
  }
  let size: number | null = null
  if (record.size !== undefined && record.size !== null) {
    if (
      typeof record.size !== 'number' ||
      !Number.isFinite(record.size) ||
      record.size <= 0 ||
      record.size > MAX_GOFILE_SIZE_BYTES
    ) {
      throw new ValidationError('A Gofile file size is invalid.')
    }
    size = Math.round(record.size)
  }
  return { name, size, url }
}

/**
 * Validate one rendered Gofile row that has no download URL. It carries a name
 * and an optional size and nothing else: there is no URL to validate.
 */
function parseGofileRow(value: unknown): ScanGofileRow | null {
  const record = asPlainObject(value)
  for (const key of Object.keys(record)) {
    if (key !== 'name' && key !== 'size') {
      throw new ValidationError('A Gofile row entry contains unsupported fields.')
    }
  }
  const name = boundedText(record.name, MAX_GOFILE_NAME_LENGTH)
  if (name === null) {
    throw new ValidationError('A Gofile file name is invalid.')
  }
  let size: number | null = null
  if (record.size !== undefined && record.size !== null) {
    if (
      typeof record.size !== 'number' ||
      !Number.isFinite(record.size) ||
      record.size <= 0 ||
      record.size > MAX_GOFILE_SIZE_BYTES
    ) {
      throw new ValidationError('A Gofile file size is invalid.')
    }
    size = Math.round(record.size)
  }
  return { name, size }
}

/**
 * Validate one extension-reported Gofile share. Files are deduplicated by URL
 * and capped, and a share that failed to render may report no files at all.
 */
export function parseScanGofileRequest(value: unknown): ScanGofileRequest {
  const record = asPlainObject(value)
  for (const key of Object.keys(record)) {
    if (
      key !== 'type' &&
      key !== 'shareId' &&
      key !== 'status' &&
      key !== 'files' &&
      key !== 'unavailable' &&
      key !== 'cookie'
    ) {
      throw new ValidationError('The Gofile scan request contains unsupported fields.')
    }
  }
  // The native host forwards `{ shareId, status, files, cookie? }` to the
  // dedicated /scan-gofile route, so the route names the operation. A `type`,
  // when present, must still be exactly `scan-gofile`.
  if (record.type !== undefined && record.type !== SCAN_GOFILE_CHANNEL) {
    throw new ValidationError('Unsupported scan operation.')
  }

  if (
    typeof record.shareId !== 'string' ||
    !GOFILE_SHARE_ID_PATTERN.test(record.shareId)
  ) {
    throw new ValidationError('The Gofile share identifier is invalid.')
  }
  if (!isGofileShareStatus(record.status)) {
    throw new ValidationError('The Gofile share status is invalid.')
  }

  const rawFiles = record.files
  if (!Array.isArray(rawFiles)) {
    throw new ValidationError('The Gofile file list is invalid.')
  }
  if (rawFiles.length > MAX_GOFILE_FILES) {
    throw new ValidationError(
      `A Gofile share can report at most ${MAX_GOFILE_FILES} files at once.`
    )
  }
  const seen = new Set<string>()
  const files: ScanGofileFile[] = []
  for (const rawFile of rawFiles) {
    const file = parseGofileFile(rawFile)
    if (file === null || seen.has(file.url)) continue
    seen.add(file.url)
    files.push(file)
  }

  const unavailable: ScanGofileRow[] = []
  if (record.unavailable !== undefined) {
    if (!Array.isArray(record.unavailable)) {
      throw new ValidationError('The Gofile row list is invalid.')
    }
    if (record.unavailable.length > MAX_GOFILE_FILES) {
      throw new ValidationError(
        `A Gofile share can report at most ${MAX_GOFILE_FILES} rows at once.`
      )
    }
    const seenNames = new Set<string>()
    for (const rawRow of record.unavailable) {
      const row = parseGofileRow(rawRow)
      if (row === null) continue
      const key = row.name.toLowerCase()
      if (seenNames.has(key)) continue
      seenNames.add(key)
      unavailable.push(row)
    }
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
    type: SCAN_GOFILE_CHANNEL,
    shareId: record.shareId,
    status: record.status,
    files,
    ...(unavailable.length === 0 ? {} : { unavailable }),
    ...(cookie === undefined ? {} : { cookie })
  }
}
