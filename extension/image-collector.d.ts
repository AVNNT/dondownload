/**
 * Types for the injected image collector. The script is a classic content
 * script (no imports), so it publishes its API on
 * `globalThis.DonDownloadImageCollector`.
 */
export interface CollectedImage {
  url: string
  fallbackUrl?: string
  width?: number
  height?: number
  alt?: string
}

export interface SrcsetCandidate {
  url: string
  width: number
  density: number
}

export interface MergeResult {
  images: CollectedImage[]
  added: number
}

export interface ImageRun {
  stop: () => void
  send: () => void
  count: () => number
}

export interface ImageCollectorApi {
  MAX_IMAGES: number
  MIN_IMAGE_EDGE: number
  PROGRESS_MESSAGE: string
  READY_MESSAGE: string
  isPinterestHost: (hostname: unknown) => boolean
  parseSrcset: (value: unknown) => SrcsetCandidate[]
  pickLargestSrcset: (value: unknown) => string | null
  pinterestOriginal: (raw: unknown) => string | null
  pinterestFallback: (raw: unknown) => string | null
  imageIdentity: (raw: unknown) => string | null
  isAvatarUrl: (raw: unknown) => boolean
  isSkippableUrl: (raw: unknown) => boolean
  isDecorativeImage: (image: unknown) => boolean
  toEntry: (raw: unknown, baseUrl?: string) => CollectedImage | null
  mergeImages: (
    existing: readonly CollectedImage[],
    incoming: readonly CollectedImage[],
    limit?: number
  ) => MergeResult
  collectFromDocument: (doc: unknown, win?: unknown) => CollectedImage[]
  pageTitle: (doc: unknown) => string
  startRun: (
    doc: unknown,
    win: unknown,
    options?: { maxImages?: number; intervalMs?: number }
  ) => ImageRun
}
