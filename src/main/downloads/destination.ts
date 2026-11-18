import { randomUUID } from 'node:crypto'
import { accessSync, constants as fsConstants, statSync } from 'node:fs'
import path from 'node:path'
import {
  isDownloadDestinationToken,
  type DownloadFolderChoice
} from '@shared/downloadDestination'
import { AppError } from '../errors'
import { isUnsafeLocalPath } from '../scanner/manualMatch'

/**
 * Main-only store for folders the user picked in the native "Save to" dialog.
 *
 * The dialog returns a raw path exactly once. That path stays here behind a
 * short-lived opaque token, so the renderer never sends an arbitrary directory
 * with a download request. A token is honoured only while its folder is an
 * absolute local directory that still exists and is writable.
 */

export const DOWNLOAD_DESTINATION_TTL_MS = 30 * 60_000
const MAX_STORED_DESTINATIONS = 16

interface StoredDestination {
  directory: string
  expiresAt: number
}

export interface DownloadDestinationStoreOptions {
  now?: () => number
  ttlMs?: number
  maxEntries?: number
}

function usableDirectory(directory: string): boolean {
  // Absolute local paths only: no UNC, device or extended-length paths, and no
  // relative input whose meaning would depend on the process working directory.
  if (isUnsafeLocalPath(directory)) return false
  try {
    if (!statSync(directory).isDirectory()) return false
    accessSync(directory, fsConstants.W_OK)
    return true
  } catch {
    return false
  }
}

export class DownloadDestinationStore {
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly maxEntries: number
  private readonly destinations = new Map<string, StoredDestination>()

  constructor(options: DownloadDestinationStoreOptions = {}) {
    this.now = options.now ?? Date.now
    this.ttlMs = options.ttlMs ?? DOWNLOAD_DESTINATION_TTL_MS
    this.maxEntries = Math.max(1, options.maxEntries ?? MAX_STORED_DESTINATIONS)
  }

  /** Register a folder the user just picked. Throws for unsafe/unusable paths. */
  register(directory: string): DownloadFolderChoice {
    this.prune()
    // `path.resolve` only canonicalizes an already-absolute path here; a
    // relative input must never be silently anchored to the process cwd.
    const resolved =
      typeof directory === 'string' && !isUnsafeLocalPath(directory)
        ? path.resolve(directory)
        : null
    if (resolved === null || !usableDirectory(resolved)) {
      throw new AppError(
        'DOWNLOAD_FOLDER_INVALID',
        'That download folder cannot be used.',
        'Pick an existing, writable local folder.'
      )
    }
    const token = randomUUID().replace(/-/g, '')
    this.destinations.set(token, {
      directory: resolved,
      expiresAt: this.now() + this.ttlMs
    })
    while (this.destinations.size > this.maxEntries) {
      const oldest = this.destinations.keys().next().value
      if (oldest === undefined) break
      this.destinations.delete(oldest)
    }
    return { token, path: resolved }
  }

  /**
   * Resolve a token, re-checking that the folder is still an existing writable
   * directory. Anything unusable forgets the token instead of falling back to
   * another folder.
   */
  resolve(token: unknown): string | null {
    this.prune()
    if (!isDownloadDestinationToken(token)) return null
    const stored = this.destinations.get(token)
    if (!stored) return null
    if (!usableDirectory(stored.directory)) {
      this.destinations.delete(token)
      return null
    }
    return stored.directory
  }

  private prune(): void {
    const current = this.now()
    for (const [token, stored] of this.destinations) {
      if (stored.expiresAt <= current) this.destinations.delete(token)
    }
  }
}
