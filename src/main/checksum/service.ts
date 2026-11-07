import { createHash } from 'node:crypto'
import { createReadStream, type ReadStream } from 'node:fs'
import {
  parseExpectedHash,
  type ChecksumAlgorithm,
  type ChecksumProgress,
  type ChecksumResult
} from '@shared/checksum'
import { parseDownloadId } from '@shared/validation'
import { AppError } from '../errors'

/** Read in bounded chunks so even huge files never land in memory at once. */
const READ_CHUNK_BYTES = 1024 * 1024
/** About four progress events per second. */
const DEFAULT_PROGRESS_INTERVAL_MS = 250

/** The main process's own recorded output for one completed download. */
export interface ChecksumTarget {
  downloadId: string
  filePath: string
  filename: string
  sizeBytes: number
}

export interface ChecksumServiceOptions {
  /**
   * Resolves a renderer-supplied id to the download's own recorded path. The
   * renderer can never provide a path, so this is the only path source.
   */
  resolveTarget: (downloadId: unknown) => Promise<ChecksumTarget>
  /** Persist the last result for the download row. */
  saveResult: (downloadId: string, result: ChecksumResult) => void
  /** Send a throttled progress event to the renderer. */
  onProgress: (progress: ChecksumProgress) => void
  now?: () => number
  progressIntervalMs?: number
}

interface ActiveJob {
  stream: ReadStream
  cancelled: boolean
}

interface ChecksumRequest {
  downloadId: string
  expectedHash?: string
}

function readRequest(input: unknown): ChecksumRequest {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new AppError(
      'CHECKSUM_INVALID_REQUEST',
      'That checksum request is not valid.'
    )
  }
  const record = input as Record<string, unknown>
  const downloadId = parseDownloadId(record.downloadId)
  if (
    record.expectedHash !== undefined &&
    typeof record.expectedHash !== 'string'
  ) {
    throw new AppError(
      'CHECKSUM_INVALID_REQUEST',
      'That checksum request is not valid.'
    )
  }
  return {
    downloadId,
    ...(record.expectedHash === undefined
      ? {}
      : { expectedHash: record.expectedHash })
  }
}

/**
 * Streams one file hash per download at a time. The job is cancellable, emits
 * throttled progress and persists only the final result.
 */
export class ChecksumService {
  private readonly jobs = new Map<string, ActiveJob>()
  private readonly now: () => number
  private readonly progressIntervalMs: number

  constructor(private readonly options: ChecksumServiceOptions) {
    this.now = options.now ?? Date.now
    this.progressIntervalMs =
      options.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS
  }

  /** Verify an expected digest pasted by the user. */
  async verify(input: unknown): Promise<ChecksumResult> {
    const request = readRequest(input)
    const expected = parseExpectedHash(request.expectedHash)
    if (expected === null) {
      throw new AppError(
        'CHECKSUM_INVALID_HASH',
        'Enter a valid MD5, SHA-1, SHA-256 or SHA-512 hex hash.',
        'Expected hashes are 32, 40, 64 or 128 hex characters.'
      )
    }
    return this.run(request.downloadId, expected.algorithm, expected.hash)
  }

  /** Compute the SHA-256 digest with no expected value. */
  async compute(input: unknown): Promise<ChecksumResult> {
    const request = readRequest(input)
    return this.run(request.downloadId, 'sha256', null)
  }

  /** Cancel an in-flight job. A missing job is a harmless no-op. */
  cancel(input: unknown): void {
    const request = readRequest(input)
    const job = this.jobs.get(request.downloadId)
    if (job === undefined) return
    job.cancelled = true
    job.stream.destroy()
  }

  private async run(
    downloadId: string,
    algorithm: ChecksumAlgorithm,
    expected: string | null
  ): Promise<ChecksumResult> {
    const target = await this.options.resolveTarget(downloadId)
    if (this.jobs.has(target.downloadId)) {
      throw new AppError(
        'CHECKSUM_BUSY',
        'A checksum is already being computed for this download.'
      )
    }
    return this.hashTarget(target, algorithm, expected)
  }

  private hashTarget(
    target: ChecksumTarget,
    algorithm: ChecksumAlgorithm,
    expected: string | null
  ): Promise<ChecksumResult> {
    return new Promise<ChecksumResult>((resolve, reject) => {
      const hash = createHash(algorithm)
      const stream = createReadStream(target.filePath, {
        highWaterMark: READ_CHUNK_BYTES
      })
      const job: ActiveJob = { stream, cancelled: false }
      this.jobs.set(target.downloadId, job)

      let hashedBytes = 0
      let lastEmitAt = Number.NEGATIVE_INFINITY
      let settled = false

      const emitProgress = (force: boolean): void => {
        const now = this.now()
        if (!force && now - lastEmitAt < this.progressIntervalMs) return
        lastEmitAt = now
        this.options.onProgress({
          downloadId: target.downloadId,
          hashedBytes,
          totalBytes: target.sizeBytes
        })
      }

      const settle = (error?: AppError, result?: ChecksumResult): void => {
        if (settled) return
        settled = true
        this.jobs.delete(target.downloadId)
        if (error !== undefined) {
          reject(error)
          return
        }
        resolve(result as ChecksumResult)
      }

      emitProgress(true)

      stream.on('data', (chunk: Buffer | string) => {
        const bytes =
          typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length
        hashedBytes += bytes
        hash.update(chunk)
        emitProgress(false)
      })

      stream.on('error', () => {
        settle(
          new AppError(
            'CHECKSUM_READ_FAILED',
            'The file could not be read for checksum verification.',
            'It may have been moved or deleted.'
          )
        )
      })

      stream.on('end', () => {
        if (job.cancelled) {
          settle(new AppError('CHECKSUM_CANCELLED', 'Checksum cancelled.'))
          return
        }
        const computed = hash.digest('hex')
        const result: ChecksumResult = {
          algorithm,
          ok: expected === null ? null : computed === expected,
          computed,
          checkedAt: this.now()
        }
        emitProgress(true)
        this.options.saveResult(target.downloadId, result)
        settle(undefined, result)
      })

      stream.on('close', () => {
        if (!settled) {
          settle(new AppError('CHECKSUM_CANCELLED', 'Checksum cancelled.'))
        }
      })
    })
  }
}
