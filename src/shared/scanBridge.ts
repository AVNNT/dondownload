import { ValidationError, normalizeHttpUrl, parseDownloadRequestHeaders } from './validation'

/**
 * Strict browser-extension -> native-host -> desktop message for "Scan this
 * page with DonDownload". The only optional extra is the exact-host Cookie the
 * user already opted into for that origin. It is never persisted.
 */
export const SCAN_PAGE_CHANNEL = 'scan-page'
export const SCAN_PAGE_ROUTE = '/scan-page'

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
