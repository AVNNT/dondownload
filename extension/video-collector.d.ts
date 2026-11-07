export const MAX_SOURCES: number
export const WAIT_MS: number
export const POLL_MS: number
export const RUN_KEY: string
export const MEDIA_PATH: RegExp

export interface VideoCollectedSource {
  url: string
  kind: 'file' | 'hls' | 'dash'
  label?: string
  width?: number
  height?: number
  sizeBytes?: number
}

export interface VideoCollectedMedia {
  pageUrl: string
  title: string | null
  thumbnailUrl?: string | null
  durationSeconds?: number | null
  sources: VideoCollectedSource[]
}

export interface VideoCollectOptions {
  waitMs?: number
  pollMs?: number
}

export interface VideoCollectorApi {
  MAX_SOURCES: number
  WAIT_MS: number
  POLL_MS: number
  RUN_KEY: string
  MEDIA_PATH: RegExp
  cleanText: (value: unknown, maximum: number) => string | null
  normalizeUrl: (value: unknown, base?: string) => string | null
  kindFromUrl: (url: string) => 'file' | 'hls' | 'dash' | null
  heightFromLabel: (value: unknown) => number | null
  heightFromUrl: (url: string) => number | null
  readSources: (doc: unknown, win: unknown) => VideoCollectedMedia
  hasPlayableMedia: (doc: unknown) => boolean
  collectVideo: (
    doc: unknown,
    win: unknown,
    options?: VideoCollectOptions
  ) => Promise<VideoCollectedMedia>
  startRun: (
    doc: unknown,
    win: unknown,
    options?: VideoCollectOptions
  ) => boolean
}
