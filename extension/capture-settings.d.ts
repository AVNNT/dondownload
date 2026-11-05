export const CAPTURE_SETTINGS_KEY: string
export const HANDOFF_STATE_KEY: string
export const OPTIONS_TARGET_KEY: string
export const MAX_HANDOFF_IDS: number
export const MAX_EXCLUDED_ORIGINS: number

export interface CaptureSettings {
  floatingTriggerEnabled: boolean
  automaticFileHandoff: boolean
  handoffNotifications: boolean
  excludedOrigins: string[]
}

export interface HandoffState {
  processed: number[]
  pending: number[]
}

export const DEFAULT_CAPTURE_SETTINGS: Readonly<CaptureSettings>

export function normalizeCaptureSettings(value: unknown): CaptureSettings
export function readCaptureSettings(chromeApi: unknown): Promise<CaptureSettings>
export function writeCaptureSettings(
  chromeApi: unknown,
  value: Partial<CaptureSettings>
): Promise<boolean>
export function readHandoffState(chromeApi: unknown): Promise<HandoffState>
export function normalizeHandoffState(value: unknown): HandoffState
export function claimHandoffDownload(
  chromeApi: unknown,
  downloadId: number
): Promise<{ ok: true } | { ok: false; reason: string }>
export function finishHandoffDownload(
  chromeApi: unknown,
  downloadId: number
): Promise<boolean>
export function rememberOptionsTarget(
  chromeApi: unknown,
  target: { tabId: number; origin: string }
): Promise<boolean>
export function readOptionsTarget(
  chromeApi: unknown
): Promise<{ tabId: number; origin: string } | null>
