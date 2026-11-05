export const HANDOFF_FILE_EXTENSIONS: readonly string[]
export const MEDIA_FILE_EXTENSIONS: readonly string[]

export function isHandoffFile(value: string | null | undefined): boolean
export function isMediaFile(value: string | null | undefined): boolean
export function isSegmentOrManifest(value: string | null | undefined): boolean
export function originFromPageUrl(value: unknown): string | null
export function normalizeHandoffFile(
  rawUrl: unknown,
  rawFilename?: unknown,
  rawExpected?: { expectedBytes?: unknown; expectedContentType?: unknown }
):
  | {
      ok: true
      url: string
      filename?: string
      expectedBytes?: number
      expectedContentType?: string
    }
  | { ok: false; code: string; message: string }
export function automaticHandoffCandidate(
  item: unknown,
  excludedOrigins?: string[]
):
  | {
      ok: true
      url: string
      filename?: string
      expectedBytes?: number
      expectedContentType?: string
      origin: string
    }
  | { ok: false; reason: string }
