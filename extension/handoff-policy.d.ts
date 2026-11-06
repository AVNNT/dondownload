export const HANDOFF_FILE_EXTENSIONS: readonly string[]
export const MEDIA_FILE_EXTENSIONS: readonly string[]
export const MANIFEST_OR_SEGMENT_EXTENSIONS: readonly string[]
export const DEFAULT_HANDOFF_MIN_BYTES: number

export function isHandoffFile(value: string | null | undefined): boolean
export function isMediaFile(value: string | null | undefined): boolean
export function isSegmentOrManifest(value: string | null | undefined): boolean
export function isPageOrManifestFile(value: string | null | undefined): boolean
export function looksLikeRealFile(
  pathname: string | null | undefined,
  filename: string | null | undefined,
  mime?: unknown
): boolean
export function originFromPageUrl(value: unknown): string | null
export function normalizeHandoffFile(
  rawUrl: unknown,
  rawFilename?: unknown,
  rawExpected?: { expectedBytes?: unknown; expectedContentType?: unknown },
  options?: { allowAnyFile?: boolean; requireMinimumBytes?: number }
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
  excludedOrigins?: string[],
  options?: { minBytes?: number }
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
