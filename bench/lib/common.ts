/**
 * Shared helpers for the DonDownload benchmark suite.
 *
 * Everything here is intentionally dependency-free: the benchmarks run through
 * Vitest (for TypeScript and `@shared` alias resolution) but only use Node and
 * the app's own modules.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DownloadItem, DownloadStatus } from '../../src/shared/types'
import type { DownloadSaveEntry } from '../../src/main/db/database'

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url))

/** `bench/` */
export const BENCH_DIR = path.resolve(LIB_DIR, '..')
/** Repository root. */
export const REPO_ROOT = path.resolve(BENCH_DIR, '..')
export const RESULTS_DIR = path.join(BENCH_DIR, 'results')

/** Write one benchmark's structured result for `bench/run.mjs` to merge. */
export function writePartial(id: string, payload: unknown): void {
  const dir = path.join(RESULTS_DIR, 'partial')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    path.join(dir, `${id}.json`),
    `${JSON.stringify(payload, null, 2)}\n`,
    'utf8'
  )
}

/** Nearest-rank percentile. Values are sorted in place on a copy. */
export function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const rank = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(fraction * sorted.length) - 1)
  )
  return sorted[rank] ?? 0
}

export function round(value: number, digits = 2): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

export function stats(
  values: readonly number[],
  digits = 2
): {
  count: number
  min: number
  p50: number
  p95: number
  max: number
  sum: number
} {
  return {
    count: values.length,
    min: round(Math.min(...values), digits),
    p50: round(percentile(values, 0.5), digits),
    p95: round(percentile(values, 0.95), digits),
    max: round(Math.max(...values), digits),
    sum: round(values.reduce((total, value) => total + value, 0))
  }
}

/** A deterministic UUID-shaped id so rows stay comparable between runs. */
function uuid(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
}

function gid(index: number): string {
  return index.toString(16).padStart(16, '0')
}

const MIB = 1024 * 1024

export interface DownloadEntryOptions {
  status?: DownloadStatus
  completedBytes?: number
  totalBytes?: number
  createdAt?: number
}

/**
 * One realistic download row. Deterministic ids, mixed file types and a host
 * in the URL keep serialization and formatting costs representative.
 */
export function makeDownloadEntry(
  index: number,
  options: DownloadEntryOptions = {}
): DownloadSaveEntry {
  const createdAt = options.createdAt ?? 1_760_000_000_000 + index * 1_000
  const totalBytes = options.totalBytes ?? 400 * MIB
  const record: DownloadItem = {
    id: uuid(index),
    gid: gid(index + 1),
    url: `https://cdn${index % 7}.example.com/files/archive-${index}.zip`,
    filename: `archive-${index}.zip`,
    dir: 'C:\\Users\\bench\\Downloads\\DonDownload',
    filePath: null,
    status: options.status ?? 'complete',
    totalBytes,
    completedBytes: options.completedBytes ?? totalBytes,
    speedBps: 0,
    etaSeconds: null,
    errorMessage: null,
    errorDetail: null,
    attempts: 1,
    maxAttempts: 3,
    createdAt,
    updatedAt: createdAt + 60_000,
    completedAt: createdAt + 60_000,
    scheduledAt: null,
    speedLimitBps: null,
    connections: 16,
    blockReason: null,
    retryAt: null
  }
  return { record, explicitFilename: null }
}
