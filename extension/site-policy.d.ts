export const OVERLAY_SCRIPT_PREFIX: string
export const OVERLAY_CORE_FILE: string
export const OVERLAY_RUNTIME_FILE: string
export const OVERLAY_UI_FILE: string
export const OVERLAY_QUALITIES_FILE: string
export const OVERLAY_CAPTURE_FILE: string
export const OVERLAY_ENTRY_FILE: string
export const OVERLAY_SCRIPT_FILES: ReadonlyArray<string>

export const OVERLAY_MESSAGE_TYPES: Readonly<{
  ENABLE: string
  SYNC: string
  DISABLE: string
  DISABLE_SITE: string
  DISABLED: string
  READY: string
}>

export interface SupportedPage {
  url: string
  origin: string
}

export interface OverlayRegistration {
  id: string
  matches: string[]
  js: string[]
  runAt: 'document_idle' | 'document_start' | 'document_end'
  allFrames: boolean
  persistAcrossSessions: boolean
  world: 'ISOLATED' | 'MAIN'
}

export function parseSupportedPageUrl(value: unknown): SupportedPage | null
export function originFromUrl(value: unknown): string | null
export function originToMatchPattern(origin: unknown): string | null
export function matchPatternToOrigin(pattern: unknown): string | null
export function overlayScriptId(origin: unknown): string | null
export function overlayRegistrationForOrigin(origin: unknown): OverlayRegistration | null
export function hasExactOriginGrant(grantedOrigins: unknown, origin: unknown): boolean
export function overlayOriginFromRegistration(registration: unknown): string | null
