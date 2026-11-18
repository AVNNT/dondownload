import { ValidationError } from './errors'
import { normalizeHttpUrl } from './validation'
import { keepsUrlFragment } from './urlFragment'

/**
 * Duplicate-detection contract shared by main and the renderer.
 *
 * A "duplicate" is an existing download (or media job) whose source URL
 * normalizes to the same value as the URL the user is about to add. History
 * matching is cheap and indexed: main stores exactly this normalized value in
 * its own SQLite column. Nothing here is persisted by the renderer.
 */

/**
 * Normalize an http(s) URL for duplicate comparison.
 *
 * Lowercases the scheme and host, removes the fragment and any default port,
 * and keeps the query string verbatim. The `URL` parser already lowercases the
 * scheme/host and drops `:80`/`:443`.
 *
 * A public MEGA link keeps its fragment: that fragment is the decryption key,
 * so two links that differ only there are different files. Dropping it made
 * two distinct MEGA downloads look identical. Every other host follows the
 * normal rule and loses tracking/anchor fragments.
 *
 * Returns null for anything that is not a usable http(s) URL instead of
 * throwing, so a repository lookup can never crash on a tampered row.
 */
export function normalizeDuplicateUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const raw = value.trim()
  if (raw.length === 0) return null

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (!parsed.hostname) return null
  // Embedded credentials are rejected by the add validator; a lookup must not
  // treat `https://user:pass@host/file` as the same resource as the clean URL.
  if (parsed.username || parsed.password) return null

  if (!keepsUrlFragment(parsed.hostname)) parsed.hash = ''
  return parsed.href
}

/** Validate one renderer-provided URL for a duplicate check. */
export function parseDuplicateCheckUrl(value: unknown): string {
  const normalized = normalizeDuplicateUrl(normalizeHttpUrl(value))
  if (normalized === null) {
    throw new ValidationError('That does not look like a valid URL.')
  }
  return normalized
}

export type DuplicateState = 'active' | 'finished'

/** One item kind the duplicate lookup can describe. */
export type DuplicateKind = 'download' | 'media'

/**
 * Renderer-safe duplicate warning. Contains no full path and no request
 * header: only the opaque job id, the display file name and a timestamp.
 */
export interface DuplicateWarning {
  kind: DuplicateKind
  /** `active` is queued/downloading; `finished` is a completed file. */
  state: DuplicateState
  id: string
  filename: string
  /** completedAt when finished, otherwise createdAt. Epoch milliseconds. */
  date: number
  /**
   * True only for a finished record whose recorded file still exists on disk.
   * The browser hand-off only skips a transfer when this is true.
   */
  fileExists: boolean
}
