export const FIREFOX_HOLD_FIRST_ID: number
export const DOWNLOAD_MEDIA_TYPES: readonly string[]

export interface WebRequestResponseDetails {
  url?: unknown
  method?: unknown
  statusCode?: unknown
  tabId?: unknown
  type?: unknown
  responseHeaders?: unknown
  originUrl?: unknown
  documentUrl?: unknown
}

export interface SyntheticDownloadItem {
  id: number
  url: string
  finalUrl: string
  filename: string
  mime: string
  totalBytes: number
  state: 'in_progress'
  danger: 'safe'
  paused: false
  referrer: string
}

export function mediaTypeOf(value: unknown): string
export function isAttachmentDisposition(value: unknown): boolean
export function parseContentDispositionFilename(value: unknown): string | null
export function sanitizeBasename(value: unknown): string
export function filenameFromUrl(value: unknown): string
export function isDownloadResponse(details: WebRequestResponseDetails | null): boolean
export function buildSyntheticDownloadItem(
  details: WebRequestResponseDetails | null,
  id: number
): SyntheticDownloadItem | null
export function nextSyntheticDownloadId(): number
export function installFirefoxDownloadHold(chromeApi: unknown): Promise<boolean>
export function resetFirefoxDownloadHoldForTests(): void
