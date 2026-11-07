import {
  isPixeldrainError,
  parsePixeldrainLink,
  type PixeldrainAdapter,
  type PixeldrainFileResolution,
  type PixeldrainLink,
  type PixeldrainListResolution
} from '../hosts/pixeldrain'

/**
 * Pixeldrain resolution for the Smart Link Scanner.
 *
 * A `/u/<id>` link is an HTML page, so the generic probe can never prove the
 * file behind it. The scanner therefore asks the existing public metadata
 * adapter for the real name, size and content type, and expands a `/l/<id>`
 * list into one card per file. Requests are deduped by provider ID, capped per
 * session and run with bounded concurrency. Nothing is retried, no Cookie is
 * ever sent and a provider failure only marks the affected card.
 */

export const SCAN_PIXELDRAIN_CONCURRENCY = 2
export const MAX_SCAN_PIXELDRAIN_REQUESTS = 60

/** The public adapter surface the scanner needs; injected for hermetic tests. */
export type ScanPixeldrainPort = Pick<
  PixeldrainAdapter,
  'resolveFile' | 'resolveList'
>

export interface ScanPixeldrainTarget {
  kind: 'file' | 'list'
  id: string
  /** Canonical public link; also the URL the queue path keeps. */
  url: string
}

export type ScanPixeldrainOutcome =
  | { type: 'file'; id: string; resolution: PixeldrainFileResolution }
  | { type: 'list'; id: string; resolution: PixeldrainListResolution }
  | {
      type: 'error'
      kind: 'file' | 'list'
      id: string
      /** Stable provider/error code for diagnostics, never user-facing text. */
      code: string | null
      /** Fixed, safe explanation shown on the card. */
      reason: string
    }

export interface ResolvePixeldrainTargetsOptions {
  port: ScanPixeldrainPort
  signal?: AbortSignal
  /** Stop taking new targets, for example when the session budget is spent. */
  shouldStop?: () => boolean
  cap?: number
  concurrency?: number
  /** Called as each target finishes. The caller owns throttled publication. */
  onResult: (index: number, outcome: ScanPixeldrainOutcome) => void
}

const UNREACHABLE_REASON = 'Pixeldrain could not be reached.'

/** Canonical Pixeldrain link for a URL, or null when it is not one. */
export function pixeldrainLinkOf(raw: string): PixeldrainLink | null {
  try {
    return parsePixeldrainLink(raw)
  } catch {
    return null
  }
}

/** True for a canonical public `/u/<id>` file link. */
export function isPixeldrainFileUrl(raw: string): boolean {
  return pixeldrainLinkOf(raw)?.kind === 'file'
}

function failureFor(error: unknown): { reason: string; code: string | null } {
  if (isPixeldrainError(error)) {
    return { reason: error.message, code: error.code }
  }
  const code =
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : null
  return { reason: UNREACHABLE_REASON, code }
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted
}

/**
 * Resolve targets with bounded parallelism. A provider failure becomes a
 * per-card outcome; the scan itself never fails here. Targets beyond the cap
 * are left untouched so the caller can keep them unresolved.
 */
export async function resolvePixeldrainTargets(
  targets: readonly ScanPixeldrainTarget[],
  options: ResolvePixeldrainTargetsOptions
): Promise<void> {
  const cap = Math.max(
    0,
    Math.min(
      options.cap ?? MAX_SCAN_PIXELDRAIN_REQUESTS,
      MAX_SCAN_PIXELDRAIN_REQUESTS
    )
  )
  const limit = Math.max(
    1,
    Math.min(
      options.concurrency ?? SCAN_PIXELDRAIN_CONCURRENCY,
      SCAN_PIXELDRAIN_CONCURRENCY
    )
  )
  const queue = targets.slice(0, cap)
  let cursor = 0

  const runners = Array.from(
    { length: Math.min(limit, queue.length) },
    async () => {
      for (;;) {
        if (isAborted(options.signal)) return
        if (options.shouldStop?.() === true) return
        const index = cursor
        cursor += 1
        if (index >= queue.length) return
        const target = queue[index]!
        let outcome: ScanPixeldrainOutcome
        try {
          outcome =
            target.kind === 'file'
              ? {
                  type: 'file',
                  id: target.id,
                  resolution: await options.port.resolveFile(target.url)
                }
              : {
                  type: 'list',
                  id: target.id,
                  resolution: await options.port.resolveList(target.url)
                }
        } catch (error) {
          outcome = {
            type: 'error',
            kind: target.kind,
            id: target.id,
            ...failureFor(error)
          }
        }
        if (isAborted(options.signal)) return
        options.onResult(index, outcome)
      }
    }
  )

  await Promise.all(runners)
}
