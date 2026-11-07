import {
  isMegaError,
  parseMegaLink,
  type MegaAdapter,
  type MegaFileResolution,
  type MegaFolderResolution,
  type MegaLink
} from '../hosts/mega'

/**
 * MEGA resolution for the Smart Link Scanner.
 *
 * A public MEGA link is a JavaScript application page, so the generic probe can
 * never prove the file behind it. The scanner therefore asks the public MEGA
 * adapter for the real name and size, and expands a folder link into one card
 * per file so videos and `.funscript` files classify and pair exactly like a
 * normal direct file.
 *
 * Requests are deduped by provider ID, capped per session and run with bounded
 * concurrency. Nothing is retried here, no Cookie is ever sent and a provider
 * failure only marks the affected card. The decryption key never leaves the
 * main process: only the card's name, size and category are published.
 */

export const SCAN_MEGA_CONCURRENCY = 4
export const MAX_SCAN_MEGA_REQUESTS = 60

/** The public adapter surface the scanner needs; injected for hermetic tests. */
export type ScanMegaPort = Pick<MegaAdapter, 'resolveFile' | 'resolveFolder'>

export interface ScanMegaTarget {
  kind: 'file' | 'folder'
  /**
   * Dedupe key: the file ID, the folder ID, or `<folderId>/<nodeId>` for a
   * folder sub-file link.
   */
  id: string
  /** Canonical public link including the key. INTERNAL: never published. */
  url: string
}

export type ScanMegaOutcome =
  | { type: 'file'; id: string; resolution: MegaFileResolution }
  | { type: 'folder'; id: string; resolution: MegaFolderResolution }
  | {
      type: 'error'
      kind: 'file' | 'folder'
      id: string
      /** Stable provider/error code for diagnostics, never user-facing text. */
      code: string | null
      /** Fixed, safe explanation shown on the card. */
      reason: string
    }

export interface ResolveMegaTargetsOptions {
  port: ScanMegaPort
  signal?: AbortSignal
  /** Stop taking new targets, for example when the session budget is spent. */
  shouldStop?: () => boolean
  cap?: number
  concurrency?: number
  /** Called as each target finishes. The caller owns throttled publication. */
  onResult: (index: number, outcome: ScanMegaOutcome) => void
}

const UNREACHABLE_REASON = 'MEGA could not be reached.'

/** Canonical MEGA link for a URL, or null when it is not one. */
export function megaLinkOf(raw: string): MegaLink | null {
  try {
    return parseMegaLink(raw)
  } catch {
    return null
  }
}

/**
 * Scan target for a URL, or null when it is not a public MEGA link. A plain
 * folder link is a folder target; a `/file/` link and a folder sub-file link are
 * single-file targets.
 */
export function megaTargetOf(raw: string): ScanMegaTarget | null {
  const link = megaLinkOf(raw)
  if (link === null) return null
  if (link.kind === 'file') {
    return { kind: 'file', id: link.id, url: link.sourceUrl }
  }
  if (link.subFileId === null) {
    return { kind: 'folder', id: link.id, url: link.sourceUrl }
  }
  return {
    kind: 'file',
    id: `${link.id}/${link.subFileId}`,
    url: link.sourceUrl
  }
}

/** True for a MEGA link that resolves to one downloadable file. */
export function isMegaFileUrl(raw: string): boolean {
  return megaTargetOf(raw)?.kind === 'file'
}

function failureFor(error: unknown): { reason: string; code: string | null } {
  if (isMegaError(error)) {
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
export async function resolveMegaTargets(
  targets: readonly ScanMegaTarget[],
  options: ResolveMegaTargetsOptions
): Promise<void> {
  const cap = Math.max(
    0,
    Math.min(options.cap ?? MAX_SCAN_MEGA_REQUESTS, MAX_SCAN_MEGA_REQUESTS)
  )
  const limit = Math.max(
    1,
    Math.min(options.concurrency ?? SCAN_MEGA_CONCURRENCY, SCAN_MEGA_CONCURRENCY)
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
        let outcome: ScanMegaOutcome
        try {
          outcome =
            target.kind === 'file'
              ? {
                  type: 'file',
                  id: target.id,
                  resolution: await options.port.resolveFile(target.url)
                }
              : {
                  type: 'folder',
                  id: target.id,
                  resolution: await options.port.resolveFolder(target.url)
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
