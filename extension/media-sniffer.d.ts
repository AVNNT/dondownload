export const MEDIA_SNIFFER_MESSAGE_TYPES: {
  readonly QUERY: string
  readonly QUEUE: string
  readonly CHANGED: string
}

export const MAX_SNIFFED_PER_TAB: number
export const MIN_MEDIA_BYTES: number
export const MAX_HLS_VARIANTS: number
export const MAX_HLS_TEXT_BYTES: number
export const MAX_MEDIA_URL_LENGTH: number

export interface SniffedHlsVariant {
  url: string
  width: number | null
  height: number | null
  bandwidth: number | null
  label: string | null
  name?: string | null
}

export interface SniffedMediaEntry {
  key: string
  url: string
  kind: 'file' | 'hls' | 'dash'
  contentType: string | null
  sizeBytes: number | null
  filename: string
  extension: string | null
  audioOnly: boolean
  sourceHost: string
  pageHost: string | null
  pageUrl: string | null
  title: string | null
  variants: SniffedHlsVariant[]
  active: boolean
  firstSeenAt: number
  lastSeenAt: number
}

export interface HlsManifestInfo {
  isMaster: boolean
  isMediaPlaylist: boolean
  variants: SniffedHlsVariant[]
}

export type ClassifiedMediaResponse =
  | {
      segment: true
      url: string
      key: string
      sourceHost: string
      observedAt: number
    }
  | { entry: SniffedMediaEntry }

export interface MediaSnifferStore {
  record(
    tabId: number,
    pageUrl: string,
    pageTitle: string | null,
    entry: SniffedMediaEntry,
    manifestInfo: HlsManifestInfo | null,
    at?: number
  ): SniffedMediaEntry | null
  markSegment(tabId: number, sourceHost: string | null, at?: number): boolean
  setPageTitle(tabId: number, pageTitle: string): void
  list(tabId: number): SniffedMediaEntry[]
  get(tabId: number, url: string): SniffedMediaEntry | null
  count(tabId: number): number
  clearTab(tabId: number): void
  clearBefore(tabId: number, timestamp: number): void
  clearAll(): void
}

export function normalizeMediaUrl(value: unknown): string | null
export function canonicalMediaUrl(value: unknown): string | null
export function mediaExtension(value: string): string | null
export function isAdvertisingHost(hostname: string): boolean
export function isGoogleVideoPlayback(value: string): boolean
export function parseContentRangeTotal(value: unknown): number | null
export function guessMediaExtension(
  url: string,
  contentType?: string | null
): string | null
export function classifyMediaResponse(
  input: Record<string, unknown>,
  now?: number
): ClassifiedMediaResponse | null
export function parseHlsMaster(text: string, baseUrl: string): HlsManifestInfo
export function createMediaSnifferStore(options?: {
  now?: () => number
  maximumPerTab?: number
}): MediaSnifferStore
export function installMediaSniffer(
  chromeApi: unknown,
  options?: Record<string, unknown>
): Record<string, unknown>
export function sniffedEntryForMessage(
  entry: SniffedMediaEntry
): Record<string, unknown> | null
export function sniffedFilename(
  entry: SniffedMediaEntry,
  variantUrl?: string | null
): string
export function formatBadgeCount(count: number): string
export function normalizeSniffedQueueMessage(value: unknown): {
  ok: boolean
  error?: { code: string; message: string }
  tabId?: number
  url?: string
  variantUrl?: string | null
}
