import type { Batch } from '@shared/batches'
import type {
  ScanQueueResult,
  ScanQueueSkip
} from '@shared/scanner'
import type { PublicTargetLookup } from '../net/publicTarget'
import { AppError } from '../errors'
import { probeScanItem, type ProbeScanItemFn } from './probe'
import type { ResolvedScanTarget, ScanSessionManager } from './session'

/**
 * Explicit queue path. Nothing here runs during scanning; it is reachable only
 * through `scan:queue-selection` with validated item IDs. Every selected item is
 * re-probed and revalidated immediately before it is handed to the batch
 * manager. `page` items are never queued.
 */

export interface ScanBatchTarget {
  url: string
  title: string
  filename?: string
  requestHeaders?: {
    cookie: string
  }
}

export interface ScanBatchPort {
  createScanBatch(input: {
    title: string
    targets: readonly ScanBatchTarget[]
  }): Promise<Batch>
}

export interface ScanQueueServiceOptions {
  sessions: ScanSessionManager
  batches: ScanBatchPort
  lookup?: PublicTargetLookup
  concurrency?: number
  /** Injectable verifier for focused tests. */
  probeItem?: ProbeScanItemFn
}

function cleanTitle(value: string): string {
  const cleaned = value
    .normalize('NFKC')
    // eslint-disable-next-line no-control-regex -- rejecting control characters is the security intent
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return Array.from(cleaned).slice(0, 240).join('') || 'Scanned page'
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  limit: number,
  worker: (value: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(values.length)
  let cursor = 0
  const runners = Array.from(
    { length: Math.min(limit, Math.max(1, values.length)) },
    async () => {
      for (;;) {
        const index = cursor
        cursor += 1
        if (index >= values.length) return
        results[index] = await worker(values[index]!)
      }
    }
  )
  await Promise.all(runners)
  return results
}

export class ScanQueueService {
  private readonly sessions: ScanSessionManager
  private readonly batches: ScanBatchPort
  private readonly lookup: PublicTargetLookup | undefined
  private readonly concurrency: number
  private readonly probeItem: ProbeScanItemFn | undefined

  constructor(options: ScanQueueServiceOptions) {
    this.sessions = options.sessions
    this.batches = options.batches
    this.lookup = options.lookup
    this.concurrency = Math.max(1, Math.min(options.concurrency ?? 4, 4))
    this.probeItem = options.probeItem
  }

  async queueSelection(
    rawSessionId: unknown,
    rawItemIds: readonly string[]
  ): Promise<ScanQueueResult> {
    const session = this.sessions.getSession(rawSessionId)
    const targets = this.sessions.resolveSelection(rawSessionId, rawItemIds)

    const resolved = await mapWithConcurrency(
      targets,
      this.concurrency,
      async (target: ResolvedScanTarget) => {
        const probe = await (this.probeItem ?? probeScanItem)(
          {
            url: target.url,
            ...(target.cookie === undefined ? {} : { cookie: target.cookie })
          },
          this.lookup === undefined ? {} : { lookup: this.lookup }
        )
        return { target, probe }
      }
    )

    const skipped: ScanQueueSkip[] = []
    const queueable: ScanBatchTarget[] = []
    const queuedItemIds: string[] = []

    for (const entry of resolved) {
      const { target, probe } = entry
      if (probe.classification.category === 'page') {
        skipped.push({
          itemId: target.itemId,
          reason: 'A web page cannot be queued as a file.'
        })
        continue
      }
      if (probe.status === 'signin') {
        skipped.push({
          itemId: target.itemId,
          reason: 'This file needs your browser sign-in.'
        })
        continue
      }
      if (probe.status !== 'ready' || !probe.verified) {
        skipped.push({
          itemId: target.itemId,
          reason: 'This file could not be verified at queue time.'
        })
        continue
      }

      queueable.push({
        url: target.url,
        title: cleanTitle(target.name),
        ...(target.name.length > 0 ? { filename: target.name } : {}),
        ...(target.cookie === undefined
          ? {}
          : { requestHeaders: { cookie: target.cookie } })
      })
      queuedItemIds.push(target.itemId)
    }

    if (queueable.length === 0) {
      throw new AppError(
        'SCAN_NOTHING_TO_QUEUE',
        skipped[0]?.reason ??
          'None of the selected items could be verified for download.'
      )
    }

    const batch = await this.batches.createScanBatch({
      title: `Scan: ${cleanTitle(session.hostname)}`,
      targets: queueable
    })

    return {
      batch,
      queuedItemIds,
      skipped
    }
  }
}
