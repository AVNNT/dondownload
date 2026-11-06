import {
  preflightPublicResource,
  type PublicResourcePreflightInput
} from '../net/publicPreflight'
import type { PublicTargetLookup } from '../net/publicTarget'
import {
  classifyScanCandidate,
  filenameFromContentDisposition,
  type ClassifiedScanCandidate
} from './classify'
import type { ScanItemStatus } from '@shared/scanner'

/**
 * Bounded, lazy verification of discovered candidates. It reuses the existing
 * public-resource preflight (one-byte range GET, revalidated redirects, pinned
 * public addresses) and never downloads a body.
 */

export const SCAN_PROBE_CONCURRENCY = 4
export const SCAN_PROBE_CAP = 200

export type ProbeScanItemFn = (
  input: ScanProbeInput,
  options?: { lookup?: PublicTargetLookup }
) => Promise<ScanProbeResult>

export interface ScanProbeInput {
  url: string
  cookie?: string
  signal?: AbortSignal
}

export interface ScanProbeResult {
  status: ScanItemStatus
  verified: boolean
  contentType: string | null
  contentDisposition: string | null
  sizeBytes: number | null
  classification: ClassifiedScanCandidate
  reason: string | null
}

function classifyFromProbe(
  input: ScanProbeInput,
  response: {
    contentType: string
    contentDisposition: string | null
  } | null
): ClassifiedScanCandidate {
  return classifyScanCandidate({
    url: input.url,
    ...(response === null
      ? {}
      : {
          contentType: response.contentType,
          contentDisposition: response.contentDisposition
        })
  })
}

function errorCode(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
  ) {
    return (error as { code: string }).code
  }
  return 'SCAN_PROBE_FAILED'
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted
}

export async function probeScanItem(
  input: ScanProbeInput,
  options: { lookup?: PublicTargetLookup } = {}
): Promise<ScanProbeResult> {
  if (isAborted(input.signal)) {
    return {
      status: 'found',
      verified: false,
      contentType: null,
      contentDisposition: null,
      sizeBytes: null,
      classification: classifyFromProbe(input, null),
      reason: 'The scan was cancelled.'
    }
  }

  const preflightInput: PublicResourcePreflightInput = {
    url: input.url,
    allowMedia: true,
    ...(input.cookie === undefined
      ? {}
      : {
          requestHeaders: {
            cookie: input.cookie
          }
        })
  }

  try {
    const result = await preflightPublicResource(preflightInput, {
      lookup: options.lookup
    })
    const classification = classifyFromProbe(input, result)
    return {
      status: classification.category === 'page' ? 'found' : 'ready',
      verified: classification.category !== 'page',
      contentType: result.contentType,
      contentDisposition: result.contentDisposition,
      sizeBytes: result.totalBytes,
      classification,
      reason: null
    }
  } catch (error) {
    const code = errorCode(error)
    if (code === 'HANDOFF_NEEDS_LOGIN') {
      return {
        status: 'signin',
        verified: false,
        contentType: null,
        contentDisposition: null,
        sizeBytes: null,
        classification: classifyFromProbe(input, null),
        reason: 'This file needs your browser sign-in.'
      }
    }
    // A generic range/protocol failure is not proof that the file is gone.
    // Keep it selectable but unverified; queueing re-probes and fails closed.
    return {
      status: 'found',
      verified: false,
      contentType: null,
      contentDisposition: null,
      sizeBytes: null,
      classification: classifyFromProbe(input, null),
      reason: null
    }
  }
}

export interface ProbeScanCandidatesOptions {
  lookup?: PublicTargetLookup
  signal?: AbortSignal
  cap?: number
  concurrency?: number
  /** Injectable verifier for focused tests. */
  probe?: ProbeScanItemFn
  /** Called as each item finishes. The caller owns throttled publication. */
  onResult: (
    index: number,
    result: ScanProbeResult
  ) => void
}

/**
 * Probe candidates in bounded parallel batches. Items beyond the per-session
 * cap are left unverified instead of creating unbounded outbound requests.
 */
export async function probeScanCandidates(
  inputs: readonly ScanProbeInput[],
  options: ProbeScanCandidatesOptions
): Promise<void> {
  const cap = Math.max(0, Math.min(options.cap ?? SCAN_PROBE_CAP, SCAN_PROBE_CAP))
  const limit = Math.max(
    1,
    Math.min(options.concurrency ?? SCAN_PROBE_CONCURRENCY, SCAN_PROBE_CONCURRENCY)
  )
  const targets = inputs.slice(0, cap)
  let cursor = 0
  const runProbe = options.probe ?? probeScanItem

  const runners = Array.from({ length: Math.min(limit, targets.length) }, async () => {
    for (;;) {
      if (isAborted(options.signal)) return
      const index = cursor
      cursor += 1
      if (index >= targets.length) return
      const result = await runProbe(targets[index]!, {
        lookup: options.lookup
      })
      if (isAborted(options.signal)) return
      options.onResult(index, result)
    }
  })
  await Promise.all(runners)
}

/** Exported for focused tests without a network request. */
export const scanProbeInternals = {
  filenameFromContentDisposition
}
