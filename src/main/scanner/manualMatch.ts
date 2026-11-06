import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import path from 'node:path'
import type { Batch } from '@shared/batches'
import type {
  ScanManualMatchInput,
  ScanManualMatchResult
} from '@shared/scanner'
import { AppError } from '../errors'
import type { ScanSessionManager } from './session'

/**
 * Manual "Match to video file…" support.
 *
 * A native open-file dialog returns a raw path exactly once. That path stays in
 * this main-process store behind a short-lived opaque token; IPC and the batch
 * manager only ever see the token. Directory validation is deliberately narrow:
 * an absolute existing file, not a UNC/device path, and renamable only inside
 * its own folder.
 */

export const MANUAL_MATCH_TTL_MS = 30 * 60_000
const MAX_STORED_PICKS = 32
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/

export interface PickedVideo {
  token: string
  filePath: string
  directory: string
  filename: string
  expiresAt: number
}

export interface PickedVideoFolder {
  filePath: string
  directory: string
  filename: string
}

export function isUnsafeLocalPath(value: string): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    return true
  }
  // UNC, extended-length and Windows device paths.
  if (/^[\\/]{2}/.test(value)) return true
  if (/^\\\\[.?]\\/.test(value)) return true
  if (/^\/\/[.?]\//.test(value)) return true
  if (!path.isAbsolute(value)) return true
  return false
}

function fileIsUsable(filePath: string): boolean {
  if (isUnsafeLocalPath(filePath)) return false
  try {
    return statSync(filePath).isFile()
  } catch {
    return false
  }
}

export interface ManualMatchStoreOptions {
  now?: () => number
  ttlMs?: number
  maxEntries?: number
}

export class ManualMatchStore {
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly maxEntries: number
  private readonly picks = new Map<string, PickedVideo>()

  constructor(options: ManualMatchStoreOptions = {}) {
    this.now = options.now ?? Date.now
    this.ttlMs = options.ttlMs ?? MANUAL_MATCH_TTL_MS
    this.maxEntries = Math.max(1, options.maxEntries ?? MAX_STORED_PICKS)
  }

  /** Register a file the user just picked. Throws for unsafe/missing paths. */
  register(filePath: string): PickedVideo {
    this.prune()
    if (isUnsafeLocalPath(filePath) || !fileIsUsable(filePath)) {
      throw new AppError(
        'PAIR_FILE_INVALID',
        'That video file cannot be used. Pick a local video file.'
      )
    }
    const resolved = path.resolve(filePath)
    const directory = path.dirname(resolved)
    if (isUnsafeLocalPath(directory)) {
      throw new AppError(
        'PAIR_FOLDER_INVALID',
        'That video is in a folder DonDownload cannot use.'
      )
    }
    const picked: PickedVideo = {
      token: randomUUID().replace(/-/g, ''),
      filePath: resolved,
      directory,
      filename: path.basename(resolved),
      expiresAt: this.now() + this.ttlMs
    }
    this.picks.set(picked.token, picked)
    while (this.picks.size > this.maxEntries) {
      const oldest = this.picks.keys().next().value
      if (oldest === undefined) break
      this.picks.delete(oldest)
    }
    return picked
  }

  /** Resolve a token, re-checking the file still exists and is safe. */
  resolve(token: string): PickedVideo | null {
    this.prune()
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return null
    const picked = this.picks.get(token)
    if (!picked) return null
    if (!fileIsUsable(picked.filePath)) {
      this.picks.delete(token)
      return null
    }
    return picked
  }

  resolveFolder(token: string): PickedVideoFolder | null {
    const picked = this.resolve(token)
    return picked === null
      ? null
      : {
          filePath: picked.filePath,
          directory: picked.directory,
          filename: picked.filename
        }
  }

  invalidate(token: string): void {
    this.picks.delete(token)
  }

  private prune(): void {
    const current = this.now()
    for (const [token, picked] of this.picks) {
      if (picked.expiresAt <= current) this.picks.delete(token)
    }
  }
}

export interface ManualMatchBatchesPort {
  createManualMatchBatch(input: {
    title: string
    scripts: readonly {
      url: string
      title: string
      filename: string
      requestHeaders?: { cookie: string }
      scanItemId: string
    }[]
    pairing: {
      setId: string
      scriptItemIds: string[]
      primaryVariant: string | null
      rename: boolean
    }
    folderToken: string
  }): Promise<Batch>
}

export type PickVideoFile = () => Promise<string | null>

export interface ManualMatchServiceOptions {
  sessions: ScanSessionManager
  batches: ManualMatchBatchesPort
  store: ManualMatchStore
  pickFile: PickVideoFile
}

export class ManualMatchService {
  private readonly sessions: ScanSessionManager
  private readonly batches: ManualMatchBatchesPort
  private readonly store: ManualMatchStore
  private readonly pickFile: PickVideoFile

  constructor(options: ManualMatchServiceOptions) {
    this.sessions = options.sessions
    this.batches = options.batches
    this.store = options.store
    this.pickFile = options.pickFile
  }

  /**
   * Validate the chosen scripts against the live scan, ask main for a local
   * video file, then queue the scripts into that file's folder. Returns null
   * when the user cancels the dialog.
   */
  async match(
    input: ScanManualMatchInput
  ): Promise<ScanManualMatchResult | null> {
    const session = this.sessions.getSession(input.sessionId)
    if (input.videoItemId !== null) {
      const video = session.items.find((item) => item.id === input.videoItemId)
      if (
        !video ||
        video.category !== 'video' ||
        video.kind !== 'page-link'
      ) {
        throw new AppError(
          'SCAN_PAIRING_INVALID',
          'That video card does not belong to this scan.'
        )
      }
    }
    const resolved = this.sessions.resolveManualScripts(input.sessionId, {
      setId: input.setId,
      scriptItemIds: input.scriptItemIds,
      primaryVariant: input.primaryVariant,
      rename: input.rename
    })

    const pickedPath = await this.pickFile()
    if (pickedPath === null) return null
    const picked = this.store.register(pickedPath)
    try {
      const batch = await this.batches.createManualMatchBatch({
        title: `Scan: ${resolved.base}`,
        scripts: resolved.scripts.map((script) => ({
          url: script.url,
          title: script.filename,
          filename: script.filename,
          ...(script.cookie === undefined
            ? {}
            : { requestHeaders: { cookie: script.cookie } }),
          scanItemId: script.itemId
        })),
        pairing: {
          setId: resolved.setId,
          scriptItemIds: resolved.scripts.map((script) => script.itemId),
          primaryVariant: resolved.primaryVariant,
          rename: resolved.rename
        },
        folderToken: picked.token
      })
      return { batchId: batch.id, filename: picked.filename }
    } catch (error) {
      this.store.invalidate(picked.token)
      throw error
    }
  }
}
