import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { shell } from 'electron'
import {
  type AppSnapshot,
  type Aria2State,
  type DownloadBlockReason,
  type DownloadItem,
  type DownloadStatus
} from '@shared/types'
import { MAX_DOWNLOAD_ATTEMPTS, canRetry } from '@shared/policy'
import {
  defaultDownloadControls,
  defaultDownloadSettings,
  type DownloadControls,
  type DownloadSettings
} from '@shared/settings'
import { evaluateStart, isAllowedAt } from '@shared/schedule'
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

/**
 * Narrow port used by the media-job manager so queued media starts are driven
 * by this manager's existing policy timer instead of a second scheduler.
 */
export interface DownloadPolicyMediaPort {
  hasPendingPolicyWork(): boolean
  pumpPolicy(now: number): void | Promise<void>
}

export interface DownloadManagerOptions {
  /** Injectable clock for deterministic tests. */
  now?: () => number
  /** Runtime settings (allowed hours are read fresh on every policy pass). */
  settings?: () => DownloadSettings
}

/** A receipt is returned only after the strict SQLite write was verified. */
export interface DurableHandoffAcceptance {
  downloadId: string
  persistedAt: number
}

export class DownloadManager {
  private readonly records = new Map<string, DownloadItem>()
  private readonly explicitFilenames = new Map<string, string>()
  private readonly controls = new Map<string, DownloadControls>()
  private readonly blockReasons = new Map<string, DownloadBlockReason | null>()
  /**
   * An explicit Start Now/Resume/Retry is a one-process user override. It is
   * deliberately not persisted: after a restart the normal schedule and
   * allowed-hours policy apply again (and active work becomes interrupted).
   */
  private readonly startNowIds = new Set<string>()
  private readonly submittingIds = new Set<string>()
  private readonly now: () => number
  private settingsProvider: () => DownloadSettings
  private mediaPolicy: DownloadPolicyMediaPort | null = null
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
    database: DownloadDatabase | null = null,
    options: DownloadManagerOptions = {}
  ) {
    this.database = database
    this.now = options.now ?? Date.now
    this.settingsProvider =
      options.settings ?? (() => defaultDownloadSettings())
    this.loadPersistedDownloads()
  }

  /** Wired after the media manager exists; keeps a single policy timer. */
  setMediaPolicyPort(port: DownloadPolicyMediaPort | null): void {
    this.mediaPolicy = port
    this.ensurePolling()
  }

  getSnapshot(): AppSnapshot {
    const aria2: Aria2State = this.aria2.getState()
    const downloads = [...this.records.values()]
      .sort((left, right) => right.createdAt - left.createdAt)
      .map((record) => this.toPublicItem(record))
    return { aria2, downloads }
  }

  private toPublicItem(record: DownloadItem): DownloadItem {
    const controls = this.controls.get(record.id) ?? defaultDownloadControls()
    return {
      ...record,
      scheduledAt: controls.scheduledAt,
      speedLimitBps: controls.speedLimitBps,
      connections: controls.connections,
      blockReason: this.blockReasons.get(record.id) ?? null
    }
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

        const blockReason = this.blockReasons.get(record.id) ?? null
        let tracked: Aria2StatusSnapshot | null = null
        // An unavailable service is not evidence that an in-flight GID was
        // lost. Keep the persisted row intact until aria2 is ready to answer.
        if (record.gid !== '' && client === null) continue
        if (client && record.gid !== '') {
          try {
            tracked = parseAria2Status(
              await client.call<unknown>('aria2.tellStatus', [record.gid])
            )
          } catch (error) {
            // Only aria2's explicit missing-GID response proves the transfer
            // is no longer tracked. A transport/server error is ambiguous;
            // preserve the old state so Retry cannot create a duplicate.
            if (!isGidNotFound(error)) continue
            tracked = null
          }
        }

        // A persisted policy hold is not an interrupted transfer and is not a
        // user pause. Keep it waiting across a restart; the existing policy
        // pass below starts it when the schedule/allowed-hours permit.
        if (record.status === 'waiting' && blockReason !== null) {
          if (tracked && tracked.status === 'paused') {
            // The same aria2 process still holds the policy-paused GID. Keep
            // the hold (and the GID) so a user pause cannot be inferred and so
            // the next window can unpause it.
            this.updateRecord(record, {
              status: 'waiting',
              speedBps: 0,
              etaSeconds: null
            })
            this.setBlockReason(record, blockReason)
            this.persistNow(record)
          } else if (tracked) {
            this.applyStatus(record, tracked)
          } else {
            this.updateRecord(record, {
              gid: '',
              speedBps: 0,
              etaSeconds: null
            })
            const decision = evaluateStart(
              this.settingsProvider(),
              this.controls.get(record.id)?.scheduledAt ?? null,
              this.now()
            )
            this.setBlockReason(record, decision.reason)
            this.persistNow(record)
          }
          continue
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
          this.setBlockReason(record, null)
          this.persistNow(record)
        }
        // keep-paused deliberately leaves the stored paused record alone, even
        // when aria2 still tracks the GID: reattaching would apply aria2's
        // active/waiting status and silently unpause the download.
        // keep-terminal likewise preserves completed/failed/interrupted state.
      }

      await this.pumpPolicy(client)
      this.lastPublished = null
      this.publish(true)
    } finally {
      this.reconciling = false
    }

    this.ensurePolling()
    this.stopPollingIfIdle()
  }

  async add(rawInput: unknown): Promise<AppSnapshot> {
    await this.addInternal(rawInput, false)
    return this.getSnapshot()
  }

  /**
   * Additive automatic browser hand-off. Success means the download row was
   * written with SQLite FULL durability and read back. Any failure removes the
   * local record and, when this method already handed a job to aria2, removes
   * that job too. The caller must keep the browser's own transfer running.
   */
  async addDurable(rawInput: unknown): Promise<DurableHandoffAcceptance> {
    const record = await this.addInternal(rawInput, true)
    return {
      downloadId: record.id,
      persistedAt: record.updatedAt
    }
  }

  private async addInternal(
    rawInput: unknown,
    durable: boolean
  ): Promise<DownloadItem> {
    // Validate before starting aria2 or touching the disk. Both the IPC Quick
    // Add path and the native browser bridge call this method, so the duplicate
    // policy exists in exactly one place.
    const input = parseAddDownloadInput(rawInput)
    const force = input.force === true

    if (durable && this.database === null) {
      throw new AppError(
        'PERSISTENCE_UNAVAILABLE',
        'DonDownload cannot guarantee this hand-off because download history is unavailable.',
        'The browser download was left running.'
      )
    }

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
    let id: string | null = null
    let gid = ''
    let client: Aria2Client | null = null
    try {
      const controls = input.controls ?? defaultDownloadControls()
      const now = this.now()
      const decision = evaluateStart(
        this.settingsProvider(),
        controls.scheduledAt,
        now
      )

      id = randomUUID()
      if (decision.allowed) {
        // Only a job that may start now is handed to aria2. Blocked jobs stay
        // in DonDownload as `waiting` and are submitted by the same policy
        // timer later, so aria2 cannot start them outside the window.
        client = await this.aria2.getClient()
        await this.ensureDownloadDirectory()
        gid = await this.addUri(client, input.url, input.filename, controls)
      }

      const record: DownloadItem = {
        id,
        gid,
        url: input.url,
        filename: input.filename ?? guessFilenameFromUrl(input.url),
        dir: this.downloadDir,
        filePath: null,
        status: decision.allowed ? 'queued' : 'waiting',
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
      this.controls.set(id, controls)
      this.blockReasons.set(id, decision.reason)
      if (input.filename) {
        this.explicitFilenames.set(id, input.filename)
      }

      if (durable) {
        try {
          this.database!.saveDurable({
            record,
            explicitFilename: this.explicitFilenames.get(id) ?? null
          })
          this.dirtyIds.delete(id)
        } catch {
          throw new AppError(
            'DURABLE_PERSISTENCE_FAILED',
            'DonDownload could not durably save this hand-off.',
            'The browser download was left running.'
          )
        }
      } else {
        this.persistNow(record)
      }
      this.persistDownloadControls(record)
      this.persistBlockReason(record)
      this.lastPublished = null
      this.publish(true)
      this.ensurePolling()
      return record
    } catch (error) {
      if (durable && id !== null) {
        await this.rollbackDurableAdd(id, gid, client)
      }
      throw error
    } finally {
      this.releasePendingUrl(input.url)
    }
  }

  /**
   * Remove the uncertain local row and any aria2 job it created. Best effort:
   * the browser hand-off still fails closed even if aria2 has already dropped
   * the GID, and the next policy pass cannot start a removed record.
   */
  private async rollbackDurableAdd(
    id: string,
    gid: string,
    client: Aria2Client | null
  ): Promise<void> {
    if (gid !== '' && client !== null) {
      await this.removeFromAria2(client, gid)
    }
    this.records.delete(id)
    this.explicitFilenames.delete(id)
    this.controls.delete(id)
    this.blockReasons.delete(id)
    this.startNowIds.delete(id)
    this.submittingIds.delete(id)
    this.dirtyIds.delete(id)
    if (this.database) {
      try {
        this.database.delete(id)
      } catch (error) {
        this.logPersistenceError('could not be rolled back', error)
      }
    }
    this.lastPublished = null
    this.publish(true)
  }

  async pause(rawId: unknown): Promise<AppSnapshot> {
    const record = this.getRecord(rawId)
    if (record.status === 'complete') {
      throw new AppError('DOWNLOAD_COMPLETE', 'This download has already completed.')
    }
    if (record.status === 'paused') {
      return this.getSnapshot()
    }

    if (record.gid !== '') {
      // A policy-paused waiting job is already paused in aria2. Taking a user
      // pause must not call aria2.pause again; only the local status changes so
      // the next allowed window cannot auto-unpause it.
      if (this.blockReasons.get(record.id) !== 'allowed-hours') {
        const client = await this.aria2.getClient()
        try {
          await client.call('aria2.pause', [record.gid])
        } catch (error) {
          throw this.wrapRpcError(error, 'The download could not be paused.')
        }
      }
    }

    this.startNowIds.delete(record.id)
    this.updateRecord(record, { status: 'paused', speedBps: 0, etaSeconds: null })
    this.setBlockReason(record, null)
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

    // Resume is an explicit user action, so it starts now even when the
    // original schedule or allowed-hours window would hold a fresh job back.
    this.startNowIds.add(record.id)
    const client = await this.aria2.getClient()

    if (record.gid === '') {
      await this.ensureDownloadDirectory()
      await this.submitWaiting(client, record, true)
    } else {
      try {
        await client.call('aria2.unpause', [record.gid])
        this.updateRecord(record, {
          status: 'waiting',
          errorMessage: null,
          completedAt: null
        })
        this.setBlockReason(record, null)
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
    }

    this.persistNow(record)
    this.persistBlockReason(record)
    this.publish()
    this.ensurePolling()
    return this.getSnapshot()
  }

  /**
   * Explicit override for a scheduled or allowed-hours-blocked waiting job.
   * It hands the job to aria2 immediately and keeps it exempt from the policy
   * pause for this process. A user pause still wins afterwards.
   */
  async startNow(rawId: unknown): Promise<AppSnapshot> {
    const record = this.getRecord(rawId)
    if (record.status === 'complete') {
      throw new AppError('DOWNLOAD_COMPLETE', 'This download has already completed.')
    }
    if (record.status !== 'waiting' && record.status !== 'paused') {
      throw new AppError(
        'DOWNLOAD_NOT_WAITING',
        'Only a waiting or paused download can be started now.'
      )
    }

    this.startNowIds.add(record.id)
    const client = await this.aria2.getClient()

    if (record.gid === '') {
      await this.ensureDownloadDirectory()
      await this.submitWaiting(client, record, true)
    } else {
      try {
        await client.call('aria2.unpause', [record.gid])
        this.updateRecord(record, {
          status: 'waiting',
          speedBps: 0,
          etaSeconds: null,
          errorMessage: null,
          completedAt: null
        })
        this.setBlockReason(record, null)
      } catch (error) {
        if (!isGidNotFound(error)) {
          throw this.wrapRpcError(error, 'The download could not be started.')
        }
        await this.resumeFromHistory(client, record)
      }
    }

    this.persistNow(record)
    this.persistBlockReason(record)
    this.publish(true)
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

    // Retry is explicit and must not be immediately re-blocked by schedule or
    // allowed hours. It keeps the stored controls for the next restart.
    this.startNowIds.add(record.id)
    const explicitFilename = this.explicitFilenames.get(record.id)
    const gid = await this.addUri(
      client,
      record.url,
      explicitFilename,
      this.controls.get(record.id) ?? defaultDownloadControls()
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
    this.setBlockReason(record, null)
    this.persistNow(record)
    this.persistBlockReason(record)
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
    this.controls.delete(record.id)
    this.blockReasons.delete(record.id)
    this.startNowIds.delete(record.id)
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

  /**
   * Run one policy pass without waiting for the interval. Settings changes use
   * this so a newly closed/opened allowed-hours window takes effect promptly.
   */
  async refreshPolicy(): Promise<void> {
    this.lastPublished = null
    this.ensurePolling()
    await this.poll()
    this.publish(true)
  }

  private setBlockReason(
    record: DownloadItem,
    reason: DownloadBlockReason | null,
    persist = true
  ): void {
    const current = this.blockReasons.get(record.id) ?? null
    if (current === reason) return
    this.blockReasons.set(record.id, reason)
    if (persist) this.persistBlockReason(record)
  }

  private persistBlockReason(record: DownloadItem): void {
    if (!this.database) return
    try {
      this.database.saveDownloadBlockReason(
        record.id,
        this.blockReasons.get(record.id) ?? null
      )
    } catch (error) {
      this.logPersistenceError('policy state could not be saved', error)
    }
  }

  private persistDownloadControls(record: DownloadItem): void {
    if (!this.database) return
    try {
      this.database.saveDownloadControls(
        record.id,
        this.controls.get(record.id) ?? defaultDownloadControls()
      )
    } catch (error) {
      this.logPersistenceError('controls could not be saved', error)
    }
  }

  private controlsOf(record: DownloadItem): DownloadControls {
    return this.controls.get(record.id) ?? defaultDownloadControls()
  }

  /** Hand one waiting record to aria2, keeping its per-download options. */
  private async submitWaiting(
    client: Aria2Client,
    record: DownloadItem,
    propagateError = false
  ): Promise<void> {
    if (this.submittingIds.has(record.id)) return
    this.submittingIds.add(record.id)
    try {
      await this.ensureDownloadDirectory()
      const gid = await this.addUri(
        client,
        record.url,
        this.explicitFilenames.get(record.id),
        this.controlsOf(record)
      )
      this.updateRecord(record, {
        gid,
        status: 'queued',
        speedBps: 0,
        etaSeconds: null,
        errorMessage: null,
        filePath: null,
        completedAt: null
      })
      this.setBlockReason(record, null)
      this.persistNow(record)
      this.persistDownloadControls(record)
    } catch (error) {
      if (propagateError) throw error
      this.updateRecord(record, {
        status: 'error',
        speedBps: 0,
        etaSeconds: null,
        errorMessage:
          error instanceof AppError
            ? error.message
            : 'The scheduled download could not be started.'
      })
      this.setBlockReason(record, null)
      this.persistNow(record)
    } finally {
      this.submittingIds.delete(record.id)
    }
  }

  /**
   * Apply schedule and allowed-hours policy using the existing poll timer. It
   * is the only scheduler: blocked jobs are never handed to aria2, submitted
   * waiting jobs are paused when the allowed window closes, and active jobs are
   * deliberately left alone so they can finish.
   */
  private async pumpPolicy(
    client: Aria2Client | null = this.aria2.getReadyClient()
  ): Promise<void> {
    const now = this.now()
    const settings = this.settingsProvider()
    const allowedNow = isAllowedAt(settings, now)

    if (client) {
      if (!allowedNow) {
        for (const record of this.records.values()) {
          if (!this.records.has(record.id)) continue
          if (record.gid === '') continue
          if (this.startNowIds.has(record.id)) continue
          if (record.status !== 'queued' && record.status !== 'waiting') {
            continue
          }
          if (this.blockReasons.get(record.id) === 'allowed-hours') continue

          // Check the live aria2 status first: an already active transfer must
          // continue when the window closes.
          let active = false
          try {
            const tracked = parseAria2Status(
              await client.call<unknown>('aria2.tellStatus', [record.gid])
            )
            if (
              tracked.status === 'active' ||
              tracked.status === 'complete' ||
              tracked.status === 'error'
            ) {
              this.applyStatus(record, tracked)
              active = true
            }
          } catch (error) {
            if (isGidNotFound(error)) {
              this.updateRecord(record, {
                gid: '',
                status: 'waiting',
                speedBps: 0,
                etaSeconds: null
              })
              this.setBlockReason(record, 'allowed-hours')
              this.persistNow(record)
            }
            continue
          }
          if (active) continue

          try {
            await client.call('aria2.pause', [record.gid])
            this.updateRecord(record, {
              status: 'waiting',
              speedBps: 0,
              etaSeconds: null
            })
            this.setBlockReason(record, 'allowed-hours')
            this.persistNow(record)
          } catch {
            // A missing GID is handled on the next policy pass; the record
            // stays waiting and is never silently dropped.
          }
        }
      } else {
        // The window opened again. Only policy-paused waiting rows are
        // unpaused; a user pause uses status `paused` and is never touched.
        for (const record of this.records.values()) {
          if (!this.records.has(record.id)) continue
          if (record.status !== 'waiting') continue
          if (record.gid === '') continue
          if (this.startNowIds.has(record.id)) continue
          if (this.blockReasons.get(record.id) !== 'allowed-hours') continue

          try {
            await client.call('aria2.unpause', [record.gid])
            this.setBlockReason(record, null)
            this.persistNow(record)
          } catch (error) {
            if (isGidNotFound(error)) {
              this.updateRecord(record, {
                gid: '',
                speedBps: 0,
                etaSeconds: null
              })
              this.setBlockReason(record, null)
              this.persistNow(record)
            }
            // Other failures stay waiting and are retried by the next pass.
          }
        }
      }
    }

    // Submit waiting records that were never handed to aria2. Start Now
    // bypasses both the schedule and allowed hours for this process only.
    for (const record of this.records.values()) {
      if (!this.records.has(record.id)) continue
      if (record.status !== 'waiting' || record.gid !== '') continue
      if (this.submittingIds.has(record.id)) continue

      const override = this.startNowIds.has(record.id)
      const decision = override
        ? { allowed: true, reason: null }
        : evaluateStart(settings, this.controlsOf(record).scheduledAt, now)
      if (!decision.allowed) {
        if (this.blockReasons.get(record.id) !== decision.reason) {
          this.setBlockReason(record, decision.reason)
          this.persistNow(record)
        }
        continue
      }

      let readyClient = client
      if (!readyClient) {
        try {
          readyClient = await this.aria2.getClient()
        } catch {
          continue
        }
        client = readyClient
      }
      await this.submitWaiting(readyClient, record)
    }

    if (this.mediaPolicy) {
      try {
        await this.mediaPolicy.pumpPolicy(now)
      } catch {
        // Media policy failures must not break download scheduling.
      }
    }
  }

  private hasDueStartCandidate(): boolean {
    const now = this.now()
    const settings = this.settingsProvider()
    for (const record of this.records.values()) {
      if (record.status !== 'waiting' || record.gid !== '') continue
      if (this.startNowIds.has(record.id)) return true
      if (
        evaluateStart(settings, this.controlsOf(record).scheduledAt, now).allowed
      ) {
        return true
      }
    }
    return false
  }

  private loadPersistedDownloads(): void {
    if (!this.database) return
    try {
      for (const stored of this.database.loadAll()) {
        this.records.set(stored.record.id, stored.record)
        if (stored.explicitFilename) {
          this.explicitFilenames.set(stored.record.id, stored.explicitFilename)
        }
        this.controls.set(stored.record.id, {
          scheduledAt: stored.scheduledAt,
          speedLimitBps: stored.speedLimitBps,
          connections: stored.connections
        })
        this.blockReasons.set(stored.record.id, stored.blockReason)
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
      record.url,
      explicitFilename,
      this.controls.get(record.id) ?? defaultDownloadControls()
    )

    this.updateRecord(record, {
      gid,
      status: 'waiting',
      speedBps: 0,
      etaSeconds: null,
      errorMessage: null,
      completedAt: null
    })
    this.setBlockReason(record, null)
  }

  private async addUri(
    client: Aria2Client,
    rawUrl: string,
    explicitFilename: string | undefined,
    controls: DownloadControls
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

    // Per-download aria2 options. When `connections` is null aria2 inherits the
    // global --max-connection-per-server value, so a later global settings edit
    // is not frozen into every existing transfer. An explicit per-download
    // connection count sets both `split` and `max-connection-per-server`.
    if (controls.connections !== null) {
      const value = String(controls.connections)
      options.split = value
      options['max-connection-per-server'] = value
    }
    if (controls.speedLimitBps !== null) {
      options['max-download-limit'] = String(controls.speedLimitBps)
    }

    // Re-validate even for records loaded from SQLite; the database is not a
    // trusted source for URL schemes if it was modified outside the app.
    const url = normalizeHttpUrl(rawUrl)

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
    Object.assign(record, patch, { updatedAt: this.now() })
  }

  private applyStatus(record: DownloadItem, rawStatus: unknown): void {
    const status = parseAria2Status(rawStatus)
    const nextStatus = mapAria2Status(status.status)

    // A policy pause is represented as `waiting`, not as a user pause. If
    // aria2 briefly reports the paused GID, keep the policy state until the
    // policy pass explicitly unpauses it.
    if (
      status.status === 'paused' &&
      record.status === 'waiting' &&
      this.blockReasons.get(record.id) === 'allowed-hours'
    ) {
      return
    }

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
      patch.completedAt = this.now()
    } else if (nextStatus !== 'complete' && record.completedAt !== null) {
      patch.completedAt = null
    }

    if (Object.keys(patch).length > 0) {
      this.updateRecord(record, patch)
      // Any status observed here is not policy-blocked: policy-blocked waiting
      // rows are skipped by the caller or guarded above.
      if (this.blockReasons.get(record.id) !== null) {
        this.setBlockReason(record, null)
      }
      if (nextStatus === 'complete' || nextStatus === 'error') {
        this.startNowIds.delete(record.id)
      }
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
      !this.hasPendingWork()
    ) {
      return
    }
    this.pollTimer = setInterval(() => {
      void this.poll()
    }, POLL_INTERVAL_MS)
  }

  private stopPollingIfIdle(): void {
    if (this.pollTimer !== null && !this.hasPendingWork()) {
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

  private hasPendingWork(): boolean {
    return (
      this.hasPendingDownloads() ||
      (this.mediaPolicy?.hasPendingPolicyWork() ?? false)
    )
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
      const mediaPending = this.mediaPolicy?.hasPendingPolicyWork() ?? false

      if (pending.length === 0 && !mediaPending) {
        this.stopPollingIfIdle()
        return
      }

      // Pending transfers never restart aria2 implicitly: the user gets an
      // explicit "Retry aria2" action. A scheduled job that has actually come
      // due is different: the user already asked for it to start, so the
      // policy pass may start aria2 to honour that schedule.
      let client = this.aria2.getReadyClient()
      if (!client && this.hasDueStartCandidate()) {
        try {
          client = await this.aria2.getClient()
        } catch {
          this.publish()
          return
        }
      }

      if (client) {
        for (const record of pending) {
          if (!this.records.has(record.id)) continue
          // Not yet submitted; the policy pass below owns it.
          if (record.gid === '') continue
          // Policy-paused rows stay waiting until the next window.
          if (this.blockReasons.get(record.id) === 'allowed-hours') continue
          try {
            const status = await client.call<unknown>('aria2.tellStatus', [
              record.gid
            ])
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
              this.setBlockReason(record, null)
              this.persistNow(record)
            }
          }
        }
      }

      // Run the single policy timer after observing current statuses so an
      // active transfer is known to be active before the window closes.
      await this.pumpPolicy(client)

      this.publish()
      this.stopPollingIfIdle()
    } finally {
      this.polling = false
    }
  }
}
