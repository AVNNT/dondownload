import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { shell } from 'electron'
import {
  type AddDownloadInput,
  type AppSnapshot,
  type Aria2State,
  type DownloadItem,
  type DownloadStatus
} from '@shared/types'
import { MAX_DOWNLOAD_ATTEMPTS, canRetry } from '@shared/policy'
import {
  guessFilenameFromUrl,
  normalizeHttpUrl,
  parseAddDownloadInput,
  parseAria2Gid,
  parseDownloadId,
  sanitizeFilename
} from '@shared/validation'
import type { Aria2Client } from '../aria2/client'
import {
  describeAria2Failure,
  mapAria2Status,
  parseAria2Status,
  type Aria2StatusSnapshot
} from '../aria2/rpc'
import type { Aria2Service } from '../aria2/service'
import type { DownloadDatabase } from '../db/database'
import { AppError } from '../errors'
import { INTERRUPTED_MESSAGE, decideStartupRecovery } from './recovery'

const POLL_INTERVAL_MS = 1_000
/** Progress is flushed at most this often; critical transitions write at once. */
const PROGRESS_PERSIST_INTERVAL_MS = 2_500

/**
 * A URL may only be added again after its previous record reached a terminal
 * state or was removed. Paused is deliberately included: pausing does not mean
 * the user wants a second copy.
 */
const UNFINISHED_STATUSES: ReadonlySet<DownloadStatus> = new Set<DownloadStatus>([
  'queued',
  'active',
  'waiting',
  'paused'
])

function etaFor(status: Aria2StatusSnapshot): number | null {
  if (status.downloadSpeed <= 0 || status.totalLength <= 0) return null
  const remaining = status.totalLength - status.completedLength
  if (remaining <= 0) return 0
  return Math.ceil(remaining / status.downloadSpeed)
}

function isInsideDirectory(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return (
    relative.length > 0 &&
    !relative.startsWith('..') &&
    !path.isAbsolute(relative)
  )
}

function isGidNotFound(error: unknown): boolean {
  return (
    error instanceof AppError &&
    error.code === 'ARIA2_RPC_ERROR' &&
    /not found/i.test(error.message)
  )
}

export class DownloadManager {
  private readonly records = new Map<string, DownloadItem>()
  private readonly explicitFilenames = new Map<string, string>()
  private readonly dirtyIds = new Set<string>()
  /**
   * Synchronous reservations close the check-then-add race: the duplicate test
   * and reservation happen before the first await, so two concurrent adds for
   * the same canonical URL cannot both reach aria2.
   */
  private readonly pendingAddUrls = new Map<string, number>()
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private polling = false
  private reconciling = false
  private lastPublished: string | null = null
  private persistenceErrorLogged = false
  private database: DownloadDatabase | null

  constructor(
    private readonly aria2: Aria2Service,
    private readonly downloadDir: string,
    private readonly onUpdate: (snapshot: AppSnapshot) => void,
    database: DownloadDatabase | null = null
  ) {
    this.database = database
    this.loadPersistedDownloads()
  }

  getSnapshot(): AppSnapshot {
    const aria2: Aria2State = this.aria2.getState()
    const downloads = [...this.records.values()].sort(
      (left, right) => right.createdAt - left.createdAt
    )
    return { aria2, downloads }
  }

  publish(force = false): void {
    const snapshot = this.getSnapshot()
    const serialized = JSON.stringify(snapshot)
    if (!force && serialized === this.lastPublished) {
      return
    }
    this.lastPublished = serialized
    this.onUpdate(snapshot)
  }

  /**
   * Reconcile persisted state with a (usually freshly started) aria2 process.
   * Only transfers that aria2 still tracks are reattached. In-flight records
   * from a previous process become `interrupted`, while manually paused records
   * remain paused. This is intentionally not an automatic re-download.
   */
  async reconcileDownloads(): Promise<void> {
    if (this.reconciling) return
    this.reconciling = true

    try {
      const candidates = [...this.records.values()].filter(
        (record) => record.status !== 'complete' && record.status !== 'error'
      )
      const client = this.aria2.getReadyClient()

      for (const record of candidates) {
        if (!this.records.has(record.id)) continue

        let tracked: Aria2StatusSnapshot | null = null
        if (client) {
          try {
            tracked = parseAria2Status(
              await client.call<unknown>('aria2.tellStatus', [record.gid])
            )
          } catch {
            // A missing GID (the normal case after an app restart) or any
            // transient RPC failure is handled conservatively below.
            tracked = null
          }
        }

        const outcome = decideStartupRecovery(record.status, tracked !== null)
        if (outcome === 'reattach' && tracked) {
          this.applyStatus(record, tracked)
        } else if (outcome === 'interrupt') {
          this.updateRecord(record, {
            status: 'interrupted',
            speedBps: 0,
            etaSeconds: null,
            errorMessage: INTERRUPTED_MESSAGE
          })
          this.persistNow(record)
        }
        // keep-paused deliberately leaves the stored paused record alone, even
        // when aria2 still tracks the GID: reattaching would apply aria2's
        // active/waiting status and silently unpause the download.
        // keep-terminal likewise preserves completed/failed/interrupted state.
      }

      this.lastPublished = null
      this.publish(true)
    } finally {
      this.reconciling = false
    }

    this.ensurePolling()
    this.stopPollingIfIdle()
  }

  async add(rawInput: unknown): Promise<AppSnapshot> {
    // Validate before starting aria2 or touching the disk. Both the IPC Quick
    // Add path and the native browser bridge call this method, so the duplicate
    // policy exists in exactly one place.
    const input = parseAddDownloadInput(rawInput)
    const force = input.force === true

    if (!force) {
      if (
        this.pendingAddUrls.has(input.url) ||
        this.findUnfinishedDownload(input.url)
      ) {
        throw this.duplicateDownloadError()
      }
    }

    // Reserve the canonical URL before any await. A second non-forced add sees
    // this reservation and is rejected even while the first aria2.addUri is
    // still in flight.
    this.reservePendingUrl(input.url)
    try {
      const client = await this.aria2.getClient()
      await this.ensureDownloadDirectory()

      const now = Date.now()
      const id = randomUUID()
      const gid = await this.addUri(client, input, input.filename)

      const record: DownloadItem = {
        id,
        gid,
        url: input.url,
        filename: input.filename ?? guessFilenameFromUrl(input.url),
        dir: this.downloadDir,
        filePath: null,
        status: 'queued',
        totalBytes: 0,
        completedBytes: 0,
        speedBps: 0,
        etaSeconds: null,
        errorMessage: null,
        attempts: 1,
        maxAttempts: MAX_DOWNLOAD_ATTEMPTS,
        createdAt: now,
        updatedAt: now,
        completedAt: null
      }

      this.records.set(id, record)
      if (input.filename) {
        this.explicitFilenames.set(id, input.filename)
      }

      this.persistNow(record)
      this.lastPublished = null
      this.publish(true)
      this.ensurePolling()
      return this.getSnapshot()
    } finally {
      this.releasePendingUrl(input.url)
    }
  }

  async pause(rawId: unknown): Promise<AppSnapshot> {
    const record = this.getRecord(rawId)
    if (record.status === 'complete') {
      throw new AppError('DOWNLOAD_COMPLETE', 'This download has already completed.')
    }
    if (record.status === 'paused') {
      return this.getSnapshot()
    }

    const client = await this.aria2.getClient()
    try {
      await client.call('aria2.pause', [record.gid])
    } catch (error) {
      throw this.wrapRpcError(error, 'The download could not be paused.')
    }

    this.updateRecord(record, { status: 'paused', speedBps: 0, etaSeconds: null })
    this.persistNow(record)
    this.publish()
    this.stopPollingIfIdle()
    return this.getSnapshot()
  }

  async resume(rawId: unknown): Promise<AppSnapshot> {
    const record = this.getRecord(rawId)
    if (record.status === 'complete') {
      throw new AppError('DOWNLOAD_COMPLETE', 'This download has already completed.')
    }

    const client = await this.aria2.getClient()
    try {
      await client.call('aria2.unpause', [record.gid])
      this.updateRecord(record, {
        status: 'waiting',
        errorMessage: null,
        completedAt: null
      })
    } catch (error) {
      if (!isGidNotFound(error)) {
        throw this.wrapRpcError(error, 'The download could not be resumed.')
      }
      // aria2 cannot reattach a paused GID across a process restart. The user
      // explicitly chose Resume, so re-add with continuation enabled. aria2's
      // global --continue/--allow-overwrite=false/--auto-file-renaming settings
      // keep any partial file and never overwrite an existing one.
      await this.resumeFromHistory(client, record)
    }

    this.persistNow(record)
    this.publish()
    this.ensurePolling()
    return this.getSnapshot()
  }

  async retry(rawId: unknown): Promise<AppSnapshot> {
    const record = this.getRecord(rawId)
    if (record.status !== 'error' && record.status !== 'interrupted') {
      throw new AppError(
        'DOWNLOAD_NOT_FAILED',
        'Only interrupted or failed downloads can be retried.'
      )
    }
    const interruptedRecovery = record.status === 'interrupted'
    if (!interruptedRecovery && !canRetry(record.attempts, record.maxAttempts)) {
      throw new AppError(
        'RETRY_LIMIT_REACHED',
        `This download has already used all ${record.maxAttempts} attempts.`,
        'Check the URL and network connection, then add the download again.'
      )
    }

    const client = await this.aria2.getClient()
    await this.removeFromAria2(client, record.gid)

    const explicitFilename = this.explicitFilenames.get(record.id)
    const gid = await this.addUri(
      client,
      {
        url: record.url,
        ...(explicitFilename ? { filename: explicitFilename } : {})
      },
      explicitFilename
    )

    this.updateRecord(record, {
      gid,
      status: 'queued',
      completedBytes: 0,
      speedBps: 0,
      etaSeconds: null,
      errorMessage: null,
      filePath: null,
      attempts: interruptedRecovery ? record.attempts : record.attempts + 1,
      completedAt: null
    })
    this.persistNow(record)
    this.publish(true)
    this.ensurePolling()
    return this.getSnapshot()
  }

  async remove(rawId: unknown): Promise<AppSnapshot> {
    const record = this.getRecord(rawId)
    const client =
      this.aria2.getState().status === 'ready' ? await this.aria2.getClient() : null
    if (client) {
      await this.removeFromAria2(client, record.gid)
    }

    this.records.delete(record.id)
    this.explicitFilenames.delete(record.id)
    this.dirtyIds.delete(record.id)
    this.removePersisted(record.id)
    this.stopPollingIfIdle()
    this.publish(true)
    return this.getSnapshot()
  }

  async showInFolder(rawId: unknown): Promise<null> {
    const record = this.getRecord(rawId)
    if (record.status !== 'complete' || !record.filePath) {
      throw new AppError('FILE_NOT_READY', 'The file is not ready yet.')
    }
    if (!isInsideDirectory(this.downloadDir, record.filePath)) {
      throw new AppError(
        'FILE_OUTSIDE_DOWNLOAD_DIR',
        'The reported file is outside the configured download folder.'
      )
    }

    try {
      await fs.access(record.filePath)
    } catch {
      throw new AppError(
        'FILE_MISSING',
        'The downloaded file is no longer on disk.',
        'It may have been moved or deleted.'
      )
    }

    shell.showItemInFolder(record.filePath)
    return null
  }

  /** Flush bounded progress snapshots. Call before closing the database. */
  flushPersistence(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    this.flushPending()
  }

  close(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    this.flushPersistence()
    if (this.database) {
      try {
        this.database.close()
      } catch (error) {
        this.logPersistenceError('could not be closed', error)
      }
      this.database = null
    }
  }

  private loadPersistedDownloads(): void {
    if (!this.database) return
    try {
      for (const stored of this.database.loadAll()) {
        this.records.set(stored.record.id, stored.record)
        if (stored.explicitFilename) {
          this.explicitFilenames.set(stored.record.id, stored.explicitFilename)
        }
      }
    } catch (error) {
      this.logPersistenceError('could not be loaded', error)
    }
  }

  private reservePendingUrl(url: string): void {
    this.pendingAddUrls.set(url, (this.pendingAddUrls.get(url) ?? 0) + 1)
  }

  private releasePendingUrl(url: string): void {
    const remaining = (this.pendingAddUrls.get(url) ?? 1) - 1
    if (remaining <= 0) {
      this.pendingAddUrls.delete(url)
    } else {
      this.pendingAddUrls.set(url, remaining)
    }
  }

  /**
   * Conservative exact-match policy: compare the already-normalized http(s)
   * URL only. No domain, path or file-name heuristics are applied.
   */
  private findUnfinishedDownload(url: string): DownloadItem | null {
    for (const record of this.records.values()) {
      if (!UNFINISHED_STATUSES.has(record.status)) continue

      let recordUrl: string
      try {
        recordUrl = normalizeHttpUrl(record.url)
      } catch {
        // A tampered database row is not a trustworthy duplicate match.
        continue
      }
      if (recordUrl === url) return record
    }
    return null
  }

  private duplicateDownloadError(): AppError {
    return new AppError(
      'DUPLICATE_DOWNLOAD',
      'This URL is already queued or downloading in DonDownload.',
      'Use Download again only if you deliberately want a second copy.'
    )
  }

  private getRecord(rawId: unknown): DownloadItem {
    const id = parseDownloadId(rawId)
    const record = this.records.get(id)
    if (!record) {
      throw new AppError('DOWNLOAD_NOT_FOUND', 'That download no longer exists.')
    }
    return record
  }

  private async ensureDownloadDirectory(): Promise<void> {
    try {
      await fs.mkdir(this.downloadDir, { recursive: true })
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'unknown error'
      throw new AppError(
        'DOWNLOAD_DIR_UNAVAILABLE',
        `The download folder could not be created: ${detail}`,
        'Check that the Downloads folder exists and is writable.'
      )
    }
  }

  private async resumeFromHistory(
    client: Aria2Client,
    record: DownloadItem
  ): Promise<void> {
    const explicitFilename = this.explicitFilenames.get(record.id)
    const gid = await this.addUri(
      client,
      {
        url: record.url,
        ...(explicitFilename ? { filename: explicitFilename } : {})
      },
      explicitFilename
    )

    this.updateRecord(record, {
      gid,
      status: 'waiting',
      speedBps: 0,
      etaSeconds: null,
      errorMessage: null,
      completedAt: null
    })
  }

  private async addUri(
    client: Aria2Client,
    input: AddDownloadInput,
    explicitFilename: string | undefined
  ): Promise<string> {
    const options: Record<string, string> = {
      dir: this.downloadDir,
      'max-tries': '3',
      'retry-wait': '2',
      'connect-timeout': '15',
      'timeout': '60',
      'auto-file-renaming': 'true',
      'allow-overwrite': 'false',
      'continue': 'true',
      'content-disposition-default-utf8': 'true',
      'user-agent': 'DonDownload/0.1.0'
    }
    if (explicitFilename) {
      options.out = sanitizeFilename(explicitFilename)
    }

    // Re-validate even for records loaded from SQLite; the database is not a
    // trusted source for URL schemes if it was modified outside the app.
    const url = normalizeHttpUrl(input.url)

    try {
      // aria2.addUri returns the new GID directly, not an object.
      const result = await client.call<unknown>('aria2.addUri', [
        [url],
        options
      ])
      return parseAria2Gid(result)
    } catch (error) {
      throw this.wrapRpcError(
        error,
        'aria2 refused to add this download.',
        'Check that the URL is reachable and that the download folder is writable.'
      )
    }
  }

  private wrapRpcError(
    error: unknown,
    fallbackMessage: string,
    hint?: string
  ): AppError {
    if (error instanceof AppError) {
      if (error.code === 'ARIA2_RPC_ERROR') {
        return new AppError(error.code, `${fallbackMessage} ${error.message}`, hint)
      }
      return error
    }
    const detail = error instanceof Error ? error.message : 'Unknown aria2 error.'
    return new AppError('ARIA2_RPC_ERROR', `${fallbackMessage} ${detail}`, hint)
  }

  private async removeFromAria2(client: Aria2Client, gid: string): Promise<void> {
    try {
      await client.call('aria2.forceRemove', [gid])
    } catch {
      // A completed or already stopped download cannot be force-removed.
    }
    try {
      await client.call('aria2.removeDownloadResult', [gid])
    } catch {
      // The result may not exist; the UI still removes its record.
    }
  }

  private updateRecord(
    record: DownloadItem,
    patch: Partial<DownloadItem>
  ): void {
    Object.assign(record, patch, { updatedAt: Date.now() })
  }

  private applyStatus(record: DownloadItem, rawStatus: unknown): void {
    const status = parseAria2Status(rawStatus)
    const nextStatus = mapAria2Status(status.status)
    const statusChanged = record.status !== nextStatus

    const reportedTotal = Math.max(
      status.totalLength,
      ...status.files.map((file) => file.length)
    )
    const totalBytes = reportedTotal > 0 ? reportedTotal : record.totalBytes
    const completedBytes =
      totalBytes > 0
        ? Math.min(status.completedLength, totalBytes)
        : status.completedLength
    const filePath =
      status.files.find((file) => file.path.length > 0)?.path ?? record.filePath
    const filename = filePath ? path.basename(filePath) : record.filename
    const speedBps = nextStatus === 'active' ? status.downloadSpeed : 0
    const etaSeconds =
      nextStatus === 'active'
        ? etaFor({ ...status, totalLength: totalBytes, completedLength: completedBytes })
        : null
    const errorMessage =
      nextStatus === 'error'
        ? describeAria2Failure(status.errorCode, status.errorMessage)
        : null

    const patch: Partial<DownloadItem> = {}
    if (record.status !== nextStatus) patch.status = nextStatus
    if (record.filename !== filename) patch.filename = filename
    if (record.filePath !== filePath) patch.filePath = filePath
    if (record.totalBytes !== totalBytes) patch.totalBytes = totalBytes
    if (record.completedBytes !== completedBytes) patch.completedBytes = completedBytes
    if (record.speedBps !== speedBps) patch.speedBps = speedBps
    if (record.etaSeconds !== etaSeconds) patch.etaSeconds = etaSeconds
    if (record.errorMessage !== errorMessage) patch.errorMessage = errorMessage
    if (nextStatus === 'complete' && record.completedAt === null) {
      patch.completedAt = Date.now()
    } else if (nextStatus !== 'complete' && record.completedAt !== null) {
      patch.completedAt = null
    }

    if (Object.keys(patch).length > 0) {
      this.updateRecord(record, patch)
      if (statusChanged || nextStatus === 'complete' || nextStatus === 'error') {
        this.persistNow(record)
      } else {
        this.markDirty(record)
      }
    }
  }

  private persistNow(record: DownloadItem): void {
    if (!this.database) return
    try {
      this.database.save({
        record,
        explicitFilename: this.explicitFilenames.get(record.id) ?? null
      })
      this.dirtyIds.delete(record.id)
    } catch (error) {
      this.logPersistenceError('could not be saved', error)
      this.markDirty(record)
    }
  }

  private removePersisted(id: string): void {
    if (!this.database) return
    try {
      this.database.delete(id)
    } catch (error) {
      this.logPersistenceError('could not be removed', error)
    }
  }

  private markDirty(record: DownloadItem): void {
    if (!this.database) return
    this.dirtyIds.add(record.id)
    this.scheduleFlush()
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null || !this.database) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flushPending()
    }, PROGRESS_PERSIST_INTERVAL_MS)
    // Do not keep the main process alive solely for a progress snapshot.
    this.flushTimer.unref?.()
  }

  private flushPending(): void {
    if (!this.database || this.dirtyIds.size === 0) return

    const ids = [...this.dirtyIds]
    const entries = []
    for (const id of ids) {
      const record = this.records.get(id)
      if (record) {
        entries.push({
          record,
          explicitFilename: this.explicitFilenames.get(id) ?? null
        })
      } else {
        this.dirtyIds.delete(id)
      }
    }
    if (entries.length === 0) return

    try {
      this.database.saveMany(entries)
      for (const id of ids) {
        this.dirtyIds.delete(id)
      }
    } catch (error) {
      this.logPersistenceError('could not be saved', error)
      this.scheduleFlush()
    }
  }

  private logPersistenceError(context: string, error: unknown): void {
    if (this.persistenceErrorLogged) return
    this.persistenceErrorLogged = true
    const detail = error instanceof Error ? error.message : 'unknown error'
    // Never include download URLs (or any payload) in logs.
    console.error(`Download history ${context}: ${detail}`)
  }

  private ensurePolling(): void {
    if (
      this.pollTimer !== null ||
      this.reconciling ||
      !this.hasPendingDownloads()
    ) {
      return
    }
    this.pollTimer = setInterval(() => {
      void this.poll()
    }, POLL_INTERVAL_MS)
  }

  private stopPollingIfIdle(): void {
    if (this.pollTimer !== null && !this.hasPendingDownloads()) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  private hasPendingDownloads(): boolean {
    for (const record of this.records.values()) {
      if (
        record.status === 'queued' ||
        record.status === 'active' ||
        record.status === 'waiting'
      ) {
        return true
      }
    }
    return false
  }

  private async poll(): Promise<void> {
    if (this.polling || this.reconciling) return
    this.polling = true

    try {
      const pending = [...this.records.values()].filter(
        (record) =>
          record.status === 'queued' ||
          record.status === 'active' ||
          record.status === 'waiting'
      )

      if (pending.length === 0) {
        this.stopPollingIfIdle()
        return
      }

      // Polling must never restart aria2 implicitly. The user gets an explicit
      // "Retry aria2" action, and pending cards remain visible while offline.
      const client = this.aria2.getReadyClient()
      if (!client) {
        this.publish()
        return
      }

      for (const record of pending) {
        if (!this.records.has(record.id)) continue
        try {
          const status = await client.call<unknown>('aria2.tellStatus', [record.gid])
          if (!this.records.has(record.id)) continue
          this.applyStatus(record, status)
        } catch (error) {
          if (
            error instanceof AppError &&
            error.code === 'ARIA2_RPC_ERROR' &&
            /not found/i.test(error.message)
          ) {
            this.updateRecord(record, {
              status: 'error',
              speedBps: 0,
              etaSeconds: null,
              errorMessage: 'aria2 is no longer tracking this download.'
            })
            this.persistNow(record)
          }
        }
      }

      this.publish()
      this.stopPollingIfIdle()
    } finally {
      this.polling = false
    }
  }
}
