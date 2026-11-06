export const SCAN_DRAFT_KEY: string
export const MAX_SCAN_DRAFT_LENGTH: number

export type AppendScanTabReason =
  | 'added'
  | 'duplicate'
  | 'limit'
  | 'unsupported'

export interface AppendScanTabResult {
  text: string
  added: boolean
  reason: AppendScanTabReason
}

export function readScanDraft(chromeApi: unknown): Promise<string>
export function saveScanDraft(
  chromeApi: unknown,
  value: unknown
): Promise<boolean>
export function clearScanDraft(chromeApi: unknown): Promise<boolean>
export function appendScanTabUrl(
  value: unknown,
  rawUrl: unknown,
  maximum?: number
): AppendScanTabResult
