export const HANDOFF_CARD_MESSAGE_TYPES: {
  readonly STATUS: string
  readonly SHOW: string
}
export const MAX_HANDED_OFF_DOWNLOAD_IDS: number
export const MAX_HANDOFF_CARDS: number
export const HANDOFF_CARD_POLL_MS: number
export const HANDOFF_CARD_MAX_POLL_MS: number
export const HANDOFF_CARD_DONE_HIDE_MS: number
export const HANDOFF_CARD_GIVE_UP_HIDE_MS: number
export const HANDOFF_CARD_MAX_FAILURES: number
export const MAX_HANDOFF_CARD_FILENAME_LENGTH: number
export const HANDED_OFF_DOWNLOADS_STORAGE_KEY: string

export interface HandoffCardPayload {
  downloadId: string
  filename: string
}

export interface HandoffCardFailure {
  ok: false
  error: { code: string; message: string }
}

export function rememberHandedOffDownload(
  downloadId: unknown,
  chromeApi?: unknown
): boolean
export function settleHandedOffDownloads(chromeApi?: unknown): Promise<void>
export function hasHandedOffDownload(
  downloadId: unknown,
  chromeApi?: unknown
): Promise<boolean>
export function forgetHandedOffDownloadsForTests(
  chromeApi?: unknown
): Promise<void>
export function resetHandedOffDownloadsMemoryForTests(): void
export function handoffCardPayload(
  receipt: unknown,
  rawFilename: unknown
): HandoffCardPayload | null
export function handoffCardInjected(payload: unknown): boolean
export function injectHandoffCard(
  chromeApi: unknown,
  tabId: number,
  payload: HandoffCardPayload
): Promise<boolean>
export function showHandoffCard(
  chromeApi: unknown,
  settings: { handoffNotifications?: boolean } | null | undefined,
  item: { filename?: unknown } | null | undefined,
  receipt: unknown
): Promise<boolean>
export function handleHandoffCardMessage(
  chromeApi: unknown,
  message: unknown,
  sender: { id?: string } | null | undefined
): Promise<unknown>
