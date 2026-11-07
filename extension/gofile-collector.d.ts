export const MAX_FILES: number
export const MAX_DEPTH: number
export const WAIT_MS: number
export const RUN_KEY: string

export interface GofileCollectedFile {
  name: string
  size: number | null
  url: string
}

export interface GofileCollectedFolder {
  url: string
  name: string | null
}

export interface GofileRows {
  files: GofileCollectedFile[]
  folders: GofileCollectedFolder[]
}

export interface GofileShareResult {
  shareId: string | null
  status: 'ok' | 'empty' | 'not-found' | 'password' | 'premium' | 'timeout'
  files: GofileCollectedFile[]
  folders: number
}

export interface GofileCollectOptions {
  waitMs?: number
  folderWaitMs?: number
  pollMs?: number
  minFiles?: number
  followFolders?: boolean
  clickFolder?: (anchor: unknown) => void
}

export interface GofileCollectorApi {
  MAX_FILES: number
  MAX_DEPTH: number
  WAIT_MS: number
  RUN_KEY: string
  isGofileHost: (hostname: unknown) => boolean
  shareIdFromUrl: (raw: unknown) => string | null
  isDownloadUrl: (raw: unknown) => boolean
  fileNameFromUrl: (raw: unknown) => string | null
  parseSizeText: (text: unknown) => number | null
  readRows: (doc: unknown, shareId: unknown) => GofileRows
  shareState: (doc: unknown) => GofileShareResult['status']
  waitForRows: (
    doc: unknown,
    win: unknown,
    shareId: unknown,
    options?: GofileCollectOptions
  ) => Promise<GofileRows>
  collectShare: (
    doc: unknown,
    win: unknown,
    options?: GofileCollectOptions
  ) => Promise<GofileShareResult>
  startRun: (
    doc: unknown,
    win: unknown,
    options?: GofileCollectOptions
  ) => boolean
}
