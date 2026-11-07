export const MAX_FILES: number
export const MAX_DEPTH: number
export const WAIT_MS: number
export const CLICK_DELAY_MS: number
export const CAPTURE_BUDGET_MS: number
export const RUN_KEY: string

export interface GofileCollectedFile {
  name: string
  size: number | null
  /** Null for a row whose download URL the page never exposed. */
  url: string | null
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
  /** Click every row's download button so the background can capture its URL. */
  captureDownloads?: boolean
  clickDelayMs?: number
  captureBudgetMs?: number
}

export interface GofileCollectorApi {
  MAX_FILES: number
  MAX_DEPTH: number
  WAIT_MS: number
  CLICK_DELAY_MS: number
  CAPTURE_BUDGET_MS: number
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
  clickDownloadRows: (
    doc: unknown,
    win: unknown,
    options?: GofileCollectOptions
  ) => Promise<number>
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
