import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { shell } from 'electron'
import {
  type AddDownloadInput,
  type AppSnapshot,
  type Aria2State,
  type DownloadBlockReason,
  type DownloadItem,
  type DownloadRequestHeaders,
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
import { resolveDownloadDirectory } from '@shared/typeFolders'
import {
  guessFilenameFromUrl,
  normalizeHttpUrl,
  parseAddDownloadInput,
  parseAria2Gid,
  parseDownloadId,
  parseDownloadIds,
  sanitizeFilename
} from '@shared/validation'
import type { Aria2Client } from '../aria2/client'
import {
  buildPollPlan,
  buildTellStatusCalls,
  readPollBatch,
  type Aria2PollOutcome
} from '../aria2/poll'
import {
  aria2FailureDetail,
  describeAria2Failure,
  mapAria2Status,
  parseAria2Status,
  type Aria2StatusSnapshot
} from '../aria2/rpc'
import type { Aria2Service } from '../aria2/service'
import type { DownloadDatabase } from '../db/database'
import { AppError } from '../errors'
import { isCookieHopSafe } from '../net/cookieScope'
import { preflightPublicResource } from '../net/publicPreflight'
import { isUnsafeLocalPath } from '../scanner/manualMatch'
import type { PickedVideoFolder } from '../scanner/manualMatch'
import {
  checkDeleteTarget,
  deleteTargetError,
  type DeleteTargetEntry
} from './deleteFile'
import {
  INTERRUPTED_MESSAGE,
  NEEDS_LOGIN_MESSAGE,
  decideStartupRecovery,
  shouldAutoResumeOnStartup
} from './recovery'
import { planAutoRetry } from './autoRetry'
import {
  PerHostConnectionMemory,
  effectivePerHostConnections,
  hostKeyFromUrl,
  nextLowerConnectionCount,
  planHostBackoff,
  refusalKind
} from './perHostConnections'
import { nextPollDelay } from './pollInterval'

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

/** One entry of a `system.multicall` result. */
type Aria2BatchResult =
  | { ok: true; value: unknown }
  | { ok: false; error: AppError }

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
  /**
   * Desktop preference "Resume interrupted downloads on startup". Defaults to
   * false for narrow tests; production wires the persisted value.
   */
  autoResume?: () => boolean
  /**
   * Redirect resolution for a one-job browser Cookie. The default runs the
   * bounded public preflight; focused tests inject a deterministic resolver.
   */
  resolveCookieTarget?: CookieTargetResolver
  /**
   * Resolve a short-lived manual pairing folder token to the file the user
   * picked. Main-only; a raw renderer path is never accepted.
   */
  resolvePairingFolder?: (token: string) => PickedVideoFolder | null
}

export interface CookieTargetResolutionInput {
  /** The original URL the browser Cookie was captured for. */
  url: string
  cookie: string
  referer?: string
  userAgent?: string
  /** A target already resolved by a trusted caller (probe/hand-off). */
  resolvedUrl?: string
}

export type CookieTargetResolver = (
  input: CookieTargetResolutionInput
) => Promise<{ finalUrl: string }>

/**
 * Production resolver: reuses a caller's verified final URL when present,
 * otherwise performs the same bounded public preflight as the hand-off path.
 * `allowMedia` is required because the scanner can queue media containers.
 */
const defaultResolveCookieTarget: CookieTargetResolver = async (input) => {
  if (input.resolvedUrl !== undefined) {
    return { finalUrl: input.resolvedUrl }
  }
  const result = await preflightPublicResource({
    url: input.url,
    allowMedia: true,
    requestHeaders: {
      cookie: input.cookie,
      ...(input.referer === undefined ? {} : { referer: input.referer }),
      ...(input.userAgent === undefined ? {} : { userAgent: input.userAgent })
    }
  })
  return { finalUrl: result.finalUrl }
}

/** A receipt is returned only after the strict SQLite write was verified. */
export interface DurableHandoffAcceptance {
  downloadId: string
  persistedAt: number
}

export class DownloadManager {
  private readonly records = new Map<string, DownloadItem>()
  private readonly explicitFilenames = new Map<string, string>()
  /**
   * One-job Referer/User-Agent/Cookie values. Deliberately memory-only: a
   * restart cannot recover them, so cookies never touch disk.
   */
  private readonly requestHeaders = new Map<string, DownloadRequestHeaders>()
  /**
   * Redirect-resolved aria2 targets for cookie jobs. The original URL stays on
   * the record for duplicate detection and display, while aria2 receives the
   * verified final URL so a one-job Cookie is never replayed through a redirect.
   */
  private readonly resolvedUrls = new Map<string, string>()
  /**
   * The exact original host a retained Cookie belongs to. addUri refuses to
   * emit a Cookie header unless the target host matches this value.
   */
  private readonly cookieHosts = new Map<string, string>()
  /**
   * IDs queued with an opt-in browser Cookie. Only the boolean is persisted so
   * a restart can fail honestly; the Cookie itself never touches disk.
   */
  private readonly needsLoginIds = new Set<string>()
  private readonly controls = new Map<string, DownloadControls>()
  private readonly blockReasons = new Map<string, DownloadBlockReason | null>()
  /**
   * An explicit Start Now/Resume/Retry is a one-process user override. It is
   * deliberately not persisted: after a restart the normal schedule and
   * allowed-hours policy apply again (and active work becomes interrupted).
   */
  private readonly startNowIds = new Set<string>()
  /** Records downloaded into a validated user-chosen pairing folder token. */
  private readonly pairingFileIds = new Set<string>()
  private readonly submittingIds = new Set<string>()
  private readonly now: () => number
  private readonly autoResumeProvider: () => boolean
  private readonly resolveCookieTarget: CookieTargetResolver
  private readonly resolvePairingFolder:
    | ((token: string) => PickedVideoFolder | null)
    | null
  private settingsProvider: () => DownloadSettings
  private mediaPolicy: DownloadPolicyMediaPort | null = null
  private readonly dirtyIds = new Set<string>()
  /**
   * Synchronous reservations close the check-then-add race: the duplicate test
   * and reservation happen before the first await, so two concurrent adds for
   * the same canonical URL cannot both reach aria2.
   */
  private readonly pendingAddUrls = new Map<string, number>()
  /**
   * One automatic retry per failure, capped per record. Memory-only: after a
   * restart the ordinary attempt budget and startup recovery apply instead.
   */
  private readonly autoRetriesUsed = new Map<string, number>()
  private readonly autoRetryTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >()
  /** Epoch ms when the pending automatic retry of a record will start. */
  private readonly autoRetryDeadlines = new Map<string, number>()
  /**
   * Reduced connections per host after a server refused parallel connections.
   * Memory-only and host-keyed: no URL, header or cookie is kept, and the TTL
   * lets a recovered server use the user's setting again.
   */
  private readonly perHostConnections = new PerHostConnectionMemory({
    now: () => this.now()
  })
  /** Refused/reset socket failures seen per host, for the storm threshold. */
  private readonly hostStormCounts = new Map<string, number>()
  /**
   * Last values written to SQLite per record. A poll tick can dirty a row
   * without its persisted columns changing; comparing this signature skips
   * those rows instead of rewriting identical data.
   */
  private readonly persistedSignatures = new Map<string, string>()
  private pollTimer: ReturnType<typeof setTimeout> | null = null
  /** Delay of the pending poll timer, so a fast wake can shorten a slow one. */
  private scheduledPollDelay: number | null = null
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private polling = false
  private reconciling = false
  /** Last global active count seen, used only to pick the next poll interval. */
  private lastGlobalActive = 0
  /**
   * Snapshot revision. Every mutation that changes published data bumps it, so
   * `publish()` never has to serialize the full history to detect a change.
   */
  private revision = 0
  private publishedRevision = 0
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
    this.autoResumeProvider = options.autoResume ?? (() => false)
    this.resolveCookieTarget =
      options.resolveCookieTarget ?? defaultResolveCookieTarget
    this.resolvePairingFolder = options.resolvePairingFolder ?? null
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
      blockReason: this.blockReasons.get(record.id) ?? null,
      retryAt: this.autoRetryDeadlines.get(record.id) ?? null
    }
  }

  publish(force = false): void {
    if (!force && this.revision === this.publishedRevision) return
    this.publishedRevision = this.revision
    this.onUpdate(this.getSnapshot())
  }

  /** Mark the published snapshot stale; the next `publish()` sends it. */
  private markSnapshotDirty(): void {
    this.revision += 1
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

        // The browser Cookie was memory-only. A restart cannot replay the
        // authenticated request, so fail with a clear message and never fall
        // back to an anonymous re-download.
        if (this.needsLoginIds.has(record.id)) {
          this.updateRecord(record, {
            gid: '',
            status: 'error',
            speedBps: 0,
            etaSeconds: null,
            errorMessage: NEEDS_LOGIN_MESSAGE
          })
          this.setBlockReason(record, null)
          this.persistNow(record)
          continue
        }

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

      // Automatic resume is deliberately narrow: only recovery-interrupted
      // rows with partial data, an intact retry budget and the desktop
      // preference enabled. It reuses the exact explicit Retry path, so any
      // partial file is continued by aria2 instead of downloaded again.
      if (client !== null && this.autoResumeProvider()) {
        for (const record of [...this.records.values()]) {
          if (!this.records.has(record.id)) continue
          if (
            !shouldAutoResumeOnStartup({
              resumeEnabled: true,
              status: record.status,
              blockReason: this.blockReasons.get(record.id) ?? null,
              completedBytes: record.completedBytes,
              attempts: record.attempts,
              maxAttempts: record.maxAttempts,
              needsLogin: this.needsLoginIds.has(record.id)
            })
          ) {
            continue
          }
          try {
            await this.retry(record.id)
          } catch {
            // Keep the interrupted row and its partial file when aria2 or the
            // network refuses the automatic retry. The user can retry again.
          }
        }
      }

      await this.pumpPolicy(client)
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
   * Internal scanner path: download one file into an explicit folder inside the
   * normal download root. Used only for funscripts that must sit next to their
   * video so the post-download rename stays in place. Never reachable from IPC
   * or the browser bridge.
   */
  async addScanFile(rawInput: unknown, directory: string): Promise<AppSnapshot> {
    await this.addInternal(rawInput, false, directory)
    return this.getSnapshot()
  }

  /**
   * Download one script into the folder of a video the user picked in the
   * native dialog. The token is resolved here; no raw path crosses IPC. The
   * folder must exist, be a plain local directory and belong to that exact
   * file. This narrow exception is the only way a download may start outside
   * the normal download root.
   */
  async addPairingFile(rawInput: unknown, token: string): Promise<AppSnapshot> {
    const picked = this.resolvePairingFolder?.(token) ?? null
    if (
      picked === null ||
      isUnsafeLocalPath(picked.filePath) ||
      isUnsafeLocalPath(picked.directory) ||
      path.dirname(path.resolve(picked.filePath)) !== path.resolve(picked.directory)
    ) {
      throw new AppError(
        'PAIR_FOLDER_UNAVAILABLE',
        'The chosen video folder is no longer available. Choose the video again.'
      )
    }
    const stat = await fs.stat(picked.directory).catch(() => null)
    if (stat === null) {
      throw new AppError(
        'PAIR_FOLDER_UNAVAILABLE',
        'The chosen video folder no longer exists. Choose the video again.'
      )
    }
    if (!stat.isDirectory()) {
      throw new AppError(
        'PAIR_FOLDER_UNAVAILABLE',
        'The chosen video folder is not a folder.'
      )
    }
    const record = await this.addInternal(rawInput, false, picked.directory, {
      allowOutsideRoot: true
    })
    this.pairingFileIds.add(record.id)
    return this.getSnapshot()
  }

  /** Final path of a completed download, for the scanner rename step. */
  getFilePath(id: string): string | null {
    const record = this.records.get(id)
    return record && record.status === 'complete' ? record.filePath : null
  }

  /**
   * One public item by exact id, or null. A cheap alternative to building the
   * whole snapshot when a caller only needs a single child record.
   */
  getItem(id: string): DownloadItem | null {
    const record = this.records.get(id)
    return record ? this.toPublicItem(record) : null
  }

  /**
   * Keep a completed child's record pointing at a script that was renamed in
   * place. The path must still be inside the download root.
   */
  adoptRenamedFile(id: string, filePath: string): void {
    if (!this.isInsideDownloadRoot(filePath)) return
    this.adoptRecordFile(id, filePath)
  }

  /**
   * Update a completed pairing script after a rename inside the exact folder of
   * the user-picked video. The token must still resolve to that folder.
   */
  adoptRenamedFileInFolder(
    id: string,
    filePath: string,
    token: string
  ): void {
    const picked = this.resolvePairingFolder?.(token) ?? null
    if (picked === null) return
    if (!isInsideDirectory(picked.directory, filePath)) return
    this.adoptRecordFile(id, filePath)
  }

  private adoptRecordFile(id: string, filePath: string): void {
    const record = this.records.get(id)
    if (!record || record.status !== 'complete') return
    record.filePath = filePath
    record.filename = path.basename(filePath)
    record.updatedAt = this.now()
    this.persistNow(record)
    this.publish(true)
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
    durable: boolean,
    directory?: string,
    options: { allowOutsideRoot?: boolean } = {}
  ): Promise<DownloadItem> {
    // Validate before starting aria2 or touching the disk. Both the IPC Quick
    // Add path and the native browser bridge call this method, so the duplicate
    // policy exists in exactly one place.
    const input = parseAddDownloadInput(rawInput)
    const force = input.force === true
    // The default directory is sorted per file type only when the user opts in
    // and did not pick a custom folder for this download. Custom folders are
    // always honoured exactly as before.
    const requestedDirectory =
      directory === undefined ? this.downloadDir : path.resolve(directory)
    if (
      options.allowOutsideRoot !== true &&
      !this.isInsideDownloadRoot(requestedDirectory)
    ) {
      throw new AppError(
        'DOWNLOAD_DIR_UNAVAILABLE',
        'The script download folder is not inside the download folder.'
      )
    }

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
      // A one-job Cookie is only handed to aria2 after its redirect chain is
      // resolved and the final target still matches the exact original host and
      // scheme. This runs before the job is created so an unresolved or unsafe
      // target fails closed with no aria2 job and no partial record.
      const target = await this.resolveDownloadTarget(input)

      const outputDirectory =
        directory === undefined
          ? resolveDownloadDirectory(
              this.downloadDir,
              input.filename ?? guessFilenameFromUrl(target.url),
              this.settingsProvider().sortDownloadsByType
            )
          : requestedDirectory
      if (
        options.allowOutsideRoot !== true &&
        !this.isInsideDownloadRoot(outputDirectory)
      ) {
        throw new AppError(
          'DOWNLOAD_DIR_UNAVAILABLE',
          'The download folder is invalid.'
        )
      }

      const controls = input.controls ?? defaultDownloadControls()
      const now = this.now()
      const decision = evaluateStart(
        this.settingsProvider(),
        controls.scheduledAt,
        now
      )

      id = randomUUID()
      let finalFilename = input.filename
      if (decision.allowed) {
        // Only a job that may start now is handed to aria2. Blocked jobs stay
        // in DonDownload as `waiting` and are submitted by the same policy
        // timer later, so aria2 cannot start them outside the window.
        client = await this.aria2.getClient()
        await this.ensureDownloadDirectory(outputDirectory)
        if (finalFilename !== undefined) {
          finalFilename = await this.uniqueDownloadFilename(
            finalFilename,
            outputDirectory
          )
        }
        gid = await this.addUri(
          client,
          target.url,
          finalFilename,
          controls,
          target.requestHeaders,
          target.cookieHost,
          outputDirectory,
          options.allowOutsideRoot === true
        )
      }

      const record: DownloadItem = {
        id,
        gid,
        url: input.url,
        filename: finalFilename ?? guessFilenameFromUrl(input.url),
        dir: outputDirectory,
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
      if (finalFilename) {
        this.explicitFilenames.set(id, finalFilename)
      }
      if (target.url !== input.url) {
        this.resolvedUrls.set(id, target.url)
      }
      if (target.requestHeaders) {
        this.requestHeaders.set(id, target.requestHeaders)
        if (target.requestHeaders.cookie !== undefined) {
          this.needsLoginIds.add(id)
        }
      }
      if (target.cookieHost !== undefined) {
        this.cookieHosts.set(id, target.cookieHost)
      }

      if (durable) {
        try {
          const entry = this.saveEntry(record)
          this.database!.saveDurable(entry)
          this.persistedSignatures.set(id, this.signatureOf(entry))
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
    this.clearAutoRetry(id)
    this.autoRetriesUsed.delete(id)
    this.records.delete(id)
    this.explicitFilenames.delete(id)
    this.requestHeaders.delete(id)
    this.resolvedUrls.delete(id)
    this.cookieHosts.delete(id)
    this.needsLoginIds.delete(id)
    this.controls.delete(id)
    this.blockReasons.delete(id)
    this.startNowIds.delete(id)
    this.submittingIds.delete(id)
    this.pairingFileIds.delete(id)
    this.dirtyIds.delete(id)
    this.persistedSignatures.delete(id)
    if (this.database) {
      try {
        this.database.delete(id)
      } catch (error) {
        this.logPersistenceError('could not be rolled back', error)
      }
    }
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
    this.clearAutoRetry(record.id)
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
    this.clearAutoRetry(record.id)
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

    this.clearAutoRetry(record.id)
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
    // An explicit retry replaces any scheduled automatic retry.
    this.clearAutoRetry(record.id)
    await this.restartDownload(record, record.status === 'interrupted', false)
    return this.getSnapshot()
  }

  /**
   * Shared body of the explicit Retry action and the automatic retry. A retry
   * re-adds the job with aria2's global --continue so any partial file is
   * resumed rather than downloaded again.
   */
  private async restartDownload(
    record: DownloadItem,
    interruptedRecovery: boolean,
    automatic: boolean
  ): Promise<void> {
    if (
      this.needsLoginIds.has(record.id) &&
      !this.requestHeaders.has(record.id)
    ) {
      throw new AppError(
        'HANDOFF_NEEDS_BROWSER_LOGIN',
        NEEDS_LOGIN_MESSAGE,
        'Click the same link in the browser so DonDownload can use your login again.'
      )
    }
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
    await this.ensureDownloadDirectory(record.dir)
    const explicitFilename = this.explicitFilenames.get(record.id)
    const gid = await this.addUri(
      client,
      this.resolvedUrls.get(record.id) ?? record.url,
      explicitFilename,
      this.controls.get(record.id) ?? defaultDownloadControls(),
      this.requestHeaders.get(record.id),
      this.cookieHosts.get(record.id),
      record.dir,
      this.pairingFileIds.has(record.id)
    )

    this.updateRecord(record, {
      gid,
      status: 'queued',
      completedBytes: 0,
      speedBps: 0,
      etaSeconds: null,
      errorMessage: null,
      errorDetail: null,
      filePath: null,
      attempts: interruptedRecovery ? record.attempts : record.attempts + 1,
      completedAt: null
    })
    this.setBlockReason(record, null)
    this.persistNow(record)
    this.persistBlockReason(record)
    this.publish(true)
    this.ensurePolling()
    if (automatic) {
      this.autoRetriesUsed.set(
        record.id,
        (this.autoRetriesUsed.get(record.id) ?? 0) + 1
      )
    }
  }

  async remove(rawId: unknown): Promise<AppSnapshot> {
    const record = this.getRecord(rawId)
    const client =
      this.aria2.getState().status === 'ready' ? await this.aria2.getClient() : null
    if (client) {
      await this.removeFromAria2(client, record.gid)
    }

    this.forgetRecord(record.id)
    this.removePersisted(record.id)
    this.stopPollingIfIdle()
    this.publish(true)
    return this.getSnapshot()
  }

  /**
   * Remove many list entries at once — the "Clear list" path.
   *
   * Downloaded files are never touched: only the history rows go. Ids the
   * backend no longer knows are skipped so a stale snapshot cannot fail the
   * whole clear, and the rows are deleted in one database transaction followed
   * by a single publish.
   */
  async removeMany(rawIds: unknown): Promise<AppSnapshot> {
    const ids = parseDownloadIds(rawIds)
    if (ids.length === 0) return this.getSnapshot()

    const client =
      this.aria2.getState().status === 'ready' ? await this.aria2.getClient() : null
    const removed: string[] = []
    for (const id of ids) {
      const record = this.records.get(id)
      if (!record) continue
      if (client) {
        await this.removeFromAria2(client, record.gid)
      }
      this.forgetRecord(record.id)
      removed.push(record.id)
    }
    if (removed.length === 0) return this.getSnapshot()

    this.removePersistedMany(removed)
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

  /**
   * Open a completed download with the OS default application. The renderer
   * sends only the opaque download id; the trusted, persisted path is resolved
   * and re-validated here against the configured download directory.
   */
  async openFile(rawId: unknown): Promise<null> {
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

    const failure = await shell.openPath(record.filePath)
    if (failure.length > 0) {
      throw new AppError(
        'FILE_OPEN_FAILED',
        'The downloaded file could not be opened.',
        failure
      )
    }
    return null
  }

  /**
   * Move the exact recorded output of a finished download to the Recycle Bin,
   * then remove its history row. The path is re-validated against the job's own
   * recorded directory, `lstat` refuses a symlink, and nothing is ever deleted
   * with an unlink/rm.
   */
  async deleteFile(rawId: unknown): Promise<AppSnapshot> {
    const record = this.getRecord(rawId)
    let entry: DeleteTargetEntry | null = null
    if (record.filePath !== null) {
      try {
        const stat = await fs.lstat(record.filePath)
        entry = { isFile: stat.isFile(), isSymbolicLink: stat.isSymbolicLink() }
      } catch {
        entry = null
      }
    }

    const check = checkDeleteTarget({
      root: record.dir,
      filePath: record.filePath,
      finished: record.status === 'complete',
      entry
    })
    if (!check.ok) {
      const info = deleteTargetError(check.problem)
      throw new AppError(info.code, info.message, info.hint)
    }

    try {
      await shell.trashItem(record.filePath as string)
    } catch {
      throw new AppError(
        'FILE_DELETE_FAILED',
        'The file could not be moved to the Recycle Bin.',
        'The download history entry was kept.'
      )
    }

    return this.remove(record.id)
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
      clearTimeout(this.pollTimer)
      this.pollTimer = null
      this.scheduledPollDelay = null
    }
    for (const id of [...this.autoRetryTimers.keys()]) {
      this.clearAutoRetry(id)
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
    this.markSnapshotDirty()
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
      await this.ensureDownloadDirectory(record.dir)
      const gid = await this.addUri(
        client,
        this.resolvedUrls.get(record.id) ?? record.url,
        this.explicitFilenames.get(record.id),
        this.controlsOf(record),
        this.requestHeaders.get(record.id),
        this.cookieHosts.get(record.id),
        record.dir,
        this.pairingFileIds.has(record.id)
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
            : 'The scheduled download could not be started.',
        errorDetail: null
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
        if (stored.needsLogin) this.needsLoginIds.add(stored.record.id)
        // The row already matches the loaded values, so the first flush does
        // not rewrite it merely because the record exists in memory.
        this.persistedSignatures.set(
          stored.record.id,
          this.signatureOf({
            record: stored.record,
            explicitFilename: stored.explicitFilename,
            needsLogin: stored.needsLogin
          })
        )
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

  private isInsideDownloadRoot(candidate: string): boolean {
    const root = path.resolve(this.downloadDir)
    const relative = path.relative(root, path.resolve(candidate))
    return (
      relative === '' ||
      (!relative.startsWith('..') && !path.isAbsolute(relative))
    )
  }

  private async ensureDownloadDirectory(
    directory: string = this.downloadDir
  ): Promise<void> {
    try {
      await fs.mkdir(directory, { recursive: true })
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
    if (
      this.needsLoginIds.has(record.id) &&
      !this.requestHeaders.has(record.id)
    ) {
      throw new AppError('HANDOFF_NEEDS_BROWSER_LOGIN', NEEDS_LOGIN_MESSAGE)
    }
    await this.ensureDownloadDirectory(record.dir)
    const explicitFilename = this.explicitFilenames.get(record.id)
    const gid = await this.addUri(
      client,
      this.resolvedUrls.get(record.id) ?? record.url,
      explicitFilename,
      this.controls.get(record.id) ?? defaultDownloadControls(),
      this.requestHeaders.get(record.id),
      this.cookieHosts.get(record.id),
      record.dir,
      this.pairingFileIds.has(record.id)
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

  /**
   * Explicit filenames (including detected media) use the same " (2)" collision
   * convention as the media engine instead of aria2's ".1" suffix. Both a file
   * on disk and another unfinished record with the same name are considered.
   */
  private async uniqueDownloadFilename(
    value: string,
    directory: string = this.downloadDir
  ): Promise<string> {
    const sanitized = sanitizeFilename(value)
    const extension = path.extname(sanitized)
    const base =
      extension.length > 0
        ? sanitized.slice(0, -extension.length)
        : sanitized
    for (let index = 1; index <= 1_000; index += 1) {
      const candidate =
        index === 1 ? sanitized : `${base} (${index})${extension}`
      const exists = await fs
        .access(path.join(directory, candidate))
        .then(() => true, () => false)
      if (exists) continue
      let active = false
      for (const record of this.records.values()) {
        if (
          record.filename === candidate &&
          UNFINISHED_STATUSES.has(record.status)
        ) {
          active = true
          break
        }
      }
      if (!active) return candidate
    }
    return sanitized
  }

  /**
   * Resolve the redirect chain of a Cookie-bearing job before aria2 sees it.
   * aria2 replays custom `header` values on every request, including redirects,
   * so a browser session Cookie must be scoped to the exact original host and
   * scheme. Callers such as the scanner probe and the hand-off preflight already
   * resolved the chain and pass `resolvedUrl`; a direct caller without that
   * value gets the same bounded public preflight here. Any failure propagates,
   * so no aria2 job is created for an unresolved Cookie URL.
   */
  private async resolveDownloadTarget(input: AddDownloadInput): Promise<{
    url: string
    requestHeaders?: DownloadRequestHeaders
    cookieHost?: string
  }> {
    const cookie = input.requestHeaders?.cookie
    if (cookie === undefined) {
      return {
        url: input.url,
        ...(input.requestHeaders === undefined
          ? {}
          : { requestHeaders: input.requestHeaders })
      }
    }

    const original = new URL(input.url)
    const resolved = await this.resolveCookieTarget({
      url: input.url,
      cookie,
      ...(input.requestHeaders?.referer === undefined
        ? {}
        : { referer: input.requestHeaders.referer }),
      ...(input.requestHeaders?.userAgent === undefined
        ? {}
        : { userAgent: input.requestHeaders.userAgent }),
      ...(input.resolvedUrl === undefined
        ? {}
        : { resolvedUrl: input.resolvedUrl })
    })

    let final: URL
    try {
      final = new URL(resolved.finalUrl)
    } catch {
      throw new AppError(
        'HANDOFF_PREFLIGHT_FAILED',
        'The resolved download URL is not valid.'
      )
    }
    if (
      (final.protocol !== 'http:' && final.protocol !== 'https:') ||
      final.username !== '' ||
      final.password !== ''
    ) {
      throw new AppError(
        'HANDOFF_PREFLIGHT_FAILED',
        'The resolved download URL is not safe.'
      )
    }

    if (isCookieHopSafe(original, final)) {
      return {
        url: final.href,
        requestHeaders: input.requestHeaders,
        cookieHost: original.host
      }
    }

    // Cross-host or HTTPS -> HTTP: the final target works anonymously by
    // definition of the verified redirect chain. Drop only the Cookie and keep
    // harmless same-job browser context.
    const { cookie: _dropped, ...rest } =
      input.requestHeaders as DownloadRequestHeaders
    return {
      url: final.href,
      ...(Object.keys(rest).length === 0 ? {} : { requestHeaders: rest })
    }
  }

  private async addUri(
    client: Aria2Client,
    rawUrl: string,
    explicitFilename: string | undefined,
    controls: DownloadControls,
    headers?: DownloadRequestHeaders,
    cookieHost?: string,
    directory: string = this.downloadDir,
    allowOutsideRoot = false
  ): Promise<string> {
    // Re-validate even for records loaded from SQLite; the database is not a
    // trusted source for URL schemes if it was modified outside the app.
    const url = normalizeHttpUrl(rawUrl)
    const outputDirectory = path.resolve(directory)
    if (!allowOutsideRoot && !this.isInsideDownloadRoot(outputDirectory)) {
      throw new AppError(
        'DOWNLOAD_DIR_UNAVAILABLE',
        'The download folder is invalid.'
      )
    }
    const options: Record<string, string | string[]> = {
      dir: outputDirectory,
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
    if (headers) {
      // Referer is a first-class aria2 option; the browser UA replaces the
      // generic DonDownload UA for this one job. A Cookie header, when the user
      // opted in, is passed only in the request and never persisted.
      if (headers.referer !== undefined) options.referer = headers.referer
      if (headers.userAgent !== undefined) {
        options['user-agent'] = headers.userAgent
      }
      if (headers.cookie !== undefined) {
        // Defence in depth: the Cookie may only be emitted for the exact host
        // the resolver approved. Every caller (initial add, policy submit,
        // retry, history resume) passes that host, so a future caller cannot
        // bypass the redirect check by supplying raw headers.
        if (cookieHost === undefined || new URL(url).host !== cookieHost) {
          throw new AppError(
            'DOWNLOAD_COOKIE_HOST_UNRESOLVED',
            'The browser login cookie was not resolved to its original host, so it was not sent.'
          )
        }
        options.header = [`Cookie: ${headers.cookie}`]
      }
    }

    // Per-download aria2 options. The effective connection count is the user's
    // setting (or an explicit per-download choice), lowered by a remembered
    // back-off for this host. `split` follows that same value so aria2 never
    // splits into more pieces than the connections actually in use. While no
    // back-off and no explicit choice apply, the options stay unset so aria2
    // keeps following the live global setting.
    const host = hostKeyFromUrl(url)
    const remembered = host === null ? null : this.perHostConnections.get(host)
    const effectiveConnections = effectivePerHostConnections({
      setting: this.settingsProvider().perHostConnections,
      perDownload: controls.connections,
      remembered
    })
    if (controls.connections !== null || remembered !== null) {
      const value = String(effectiveConnections)
      options.split = value
      options['max-connection-per-server'] = value
    }
    if (controls.speedLimitBps !== null) {
      options['max-download-limit'] = String(controls.speedLimitBps)
    }

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

  private clearAutoRetry(id: string): void {
    const timer = this.autoRetryTimers.get(id)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.autoRetryTimers.delete(id)
    }
    if (this.autoRetryDeadlines.delete(id)) this.markSnapshotDirty()
  }

  /**
   * Lower the connections for the failed download's host when aria2 reports a
   * refused parallel connection (429/503, "too many connections", or a
   * repeated connection refused/reset). Only that host is affected, the value
   * walks 16 -> 8 -> 4 -> 1, and it never exceeds the user's setting. Returns
   * the refusal kind so the caller can retry the job with the lower value.
   */
  private applyPerHostBackoff(
    record: DownloadItem,
    errorCode: number,
    errorMessage: string
  ): 'limit' | 'storm' | null {
    const host = hostKeyFromUrl(
      this.resolvedUrls.get(record.id) ?? record.url
    )
    if (host === null) return null

    const failure = { errorCode, errorMessage }
    const stormCount =
      refusalKind(failure) === 'storm'
        ? (this.hostStormCounts.get(host) ?? 0) + 1
        : 0
    this.hostStormCounts.set(host, stormCount)

    const plan = planHostBackoff({ failure, stormCount })
    if (!plan.reduce) return plan.kind

    // An explicit per-download choice is the ceiling for this job; otherwise
    // the user's setting is.
    const ceiling =
      this.controls.get(record.id)?.connections ??
      this.settingsProvider().perHostConnections
    const current = this.perHostConnections.get(host) ?? ceiling
    const next = nextLowerConnectionCount(current, ceiling)
    if (next < current) this.perHostConnections.remember(host, next)
    return plan.kind
  }

  /**
   * Schedule one automatic retry for a transient aria2 failure. The row keeps
   * its `error` status while it waits (so nothing else tries to resume it) but
   * carries a retry deadline the UI shows as "Retrying in Ns…". Non-transient
   * failures, exhausted budgets, paused/removed rows and login-lost hand-offs
   * are never retried automatically. A connection refusal is retried even when
   * aria2's code is not otherwise transient, because the retry uses the lower
   * per-host connection count.
   */
  private scheduleAutoRetry(
    record: DownloadItem,
    errorCode: number,
    errorMessage: string,
    connectionRefusal: 'limit' | 'storm' | null = null
  ): void {
    const delay = planAutoRetry({
      errorCode,
      errorMessage,
      attempts: record.attempts,
      maxAttempts: record.maxAttempts,
      autoRetriesUsed: this.autoRetriesUsed.get(record.id) ?? 0,
      connectionRefusal: connectionRefusal !== null
    })
    if (delay === null) return
    if (
      this.needsLoginIds.has(record.id) &&
      !this.requestHeaders.has(record.id)
    ) {
      return
    }

    this.clearAutoRetry(record.id)
    this.autoRetryDeadlines.set(record.id, this.now() + delay)
    this.markSnapshotDirty()
    const timer = setTimeout(() => {
      this.autoRetryTimers.delete(record.id)
      this.autoRetryDeadlines.delete(record.id)
      void this.runAutoRetry(record.id)
    }, delay)
    // A pending retry must not keep the main process alive by itself.
    timer.unref?.()
    this.autoRetryTimers.set(record.id, timer)
  }

  private async runAutoRetry(id: string): Promise<void> {
    const record = this.records.get(id)
    // Removed, paused, resumed or already restarted meanwhile: do nothing.
    if (!record || record.status !== 'error') {
      this.autoRetryDeadlines.delete(id)
      return
    }
    try {
      await this.restartDownload(record, false, true)
    } catch {
      // The automatic retry could not be handed to aria2. Keep the failure
      // visible; the user can still retry explicitly.
      this.autoRetryDeadlines.delete(id)
      this.publish(true)
    }
  }

  private updateRecord(
    record: DownloadItem,
    patch: Partial<DownloadItem>
  ): void {
    Object.assign(record, patch, { updatedAt: this.now() })
    this.markSnapshotDirty()
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
    const errorDetail =
      nextStatus === 'error'
        ? aria2FailureDetail(status.errorCode, status.errorMessage)
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
    if ((record.errorDetail ?? null) !== errorDetail) patch.errorDetail = errorDetail
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
      if (nextStatus === 'error' && statusChanged) {
        // A server that refuses parallel connections gets fewer connections
        // for its host only, then one automatic retry per failure.
        const refusal = this.applyPerHostBackoff(
          record,
          status.errorCode,
          status.errorMessage
        )
        this.scheduleAutoRetry(
          record,
          status.errorCode,
          status.errorMessage,
          refusal
        )
      } else if (nextStatus !== 'error') {
        this.clearAutoRetry(record.id)
      }
      if (statusChanged || nextStatus === 'complete' || nextStatus === 'error') {
        this.persistNow(record)
      } else {
        this.markDirty(record)
      }
    }
  }

  private saveEntry(record: DownloadItem): {
    record: DownloadItem
    explicitFilename: string | null
    needsLogin: boolean
  } {
    return {
      record,
      explicitFilename: this.explicitFilenames.get(record.id) ?? null,
      needsLogin: this.needsLoginIds.has(record.id)
    }
  }

  /**
   * Values that actually reach SQLite. `updatedAt` is intentionally excluded:
   * a tick can touch it without changing persisted content, and rewriting an
   * identical row only creates WAL churn.
   */
  private signatureOf(entry: {
    record: DownloadItem
    explicitFilename: string | null
    needsLogin?: boolean
  }): string {
    const record = entry.record
    return JSON.stringify([
      record.gid,
      record.url,
      record.filename,
      entry.explicitFilename,
      record.dir,
      record.filePath,
      record.status,
      record.totalBytes,
      record.completedBytes,
      record.errorMessage,
      record.errorDetail ?? null,
      record.attempts,
      record.maxAttempts,
      record.createdAt,
      record.completedAt,
      entry.needsLogin === true
    ])
  }

  private persistNow(record: DownloadItem): void {
    if (!this.database) return
    const entry = this.saveEntry(record)
    const signature = this.signatureOf(entry)
    if (this.persistedSignatures.get(record.id) === signature) {
      this.dirtyIds.delete(record.id)
      return
    }
    try {
      this.database.save(entry)
      this.persistedSignatures.set(record.id, signature)
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

  private removePersistedMany(ids: readonly string[]): void {
    if (!this.database || ids.length === 0) return
    try {
      this.database.deleteMany(ids)
    } catch (error) {
      this.logPersistenceError('could not be removed', error)
    }
  }

  /** Drop every in-memory trace of one record. Files on disk are untouched. */
  private forgetRecord(id: string): void {
    this.clearAutoRetry(id)
    this.autoRetriesUsed.delete(id)
    this.records.delete(id)
    this.explicitFilenames.delete(id)
    this.requestHeaders.delete(id)
    this.resolvedUrls.delete(id)
    this.cookieHosts.delete(id)
    this.needsLoginIds.delete(id)
    this.controls.delete(id)
    this.blockReasons.delete(id)
    this.startNowIds.delete(id)
    this.pairingFileIds.delete(id)
    this.dirtyIds.delete(id)
    this.persistedSignatures.delete(id)
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
        entries.push(this.saveEntry(record))
      } else {
        this.dirtyIds.delete(id)
      }
    }

    // All rows whose persisted values changed go through ONE transaction per
    // interval; rows touched by a tick but byte-identical are dropped here.
    const changed = entries.filter(
      (entry) =>
        this.persistedSignatures.get(entry.record.id) !==
        this.signatureOf(entry)
    )
    if (changed.length === 0) {
      for (const id of ids) this.dirtyIds.delete(id)
      return
    }

    try {
      this.database.saveMany(changed)
      for (const entry of changed) {
        this.persistedSignatures.set(
          entry.record.id,
          this.signatureOf(entry)
        )
      }
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
    if (this.reconciling) return
    const delay = this.nextPollDelay()
    if (delay === null) {
      this.stopPollingIfIdle()
      return
    }
    if (this.pollTimer === null) {
      this.scheduleNextPoll()
      return
    }
    // Add/resume/start-now must not wait out a slow idle timer: shorten the
    // pending wait when faster observation is now warranted.
    if (this.scheduledPollDelay !== null && delay < this.scheduledPollDelay) {
      clearTimeout(this.pollTimer)
      this.pollTimer = null
      this.scheduledPollDelay = null
      this.scheduleNextPoll()
    }
  }

  private stopPollingIfIdle(): void {
    if (this.pollTimer !== null && this.nextPollDelay() === null) {
      clearTimeout(this.pollTimer)
      this.pollTimer = null
      this.scheduledPollDelay = null
    }
  }

  /**
   * True while any download is queued, waiting for the policy gate or actively
   * transferring. Paused, completed and failed rows do not count.
   */
  hasPendingDownloads(): boolean {
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

  /**
   * A transfer (or media work) is making progress, so poll at the fast cadence.
   * aria2's global counters also count, because an orphaned aria2 job can still
   * be running after its local record finished.
   */
  private hasActiveWork(): boolean {
    for (const record of this.records.values()) {
      if (record.status === 'queued' || record.status === 'active') return true
    }
    if (this.mediaPolicy?.hasPendingPolicyWork() ?? false) return true
    // The global counter only matters while local work remains. Without this
    // guard a stale "active" count would keep a one-second timer alive after
    // the last row completed.
    return this.hasPendingWork() && this.lastGlobalActive > 0
  }

  private nextPollDelay(): number | null {
    return nextPollDelay({
      hasActiveWork: this.hasActiveWork(),
      hasPendingWork: this.hasPendingWork()
    })
  }

  private scheduleNextPoll(): void {
    if (this.pollTimer !== null) return
    const delay = this.nextPollDelay()
    if (delay === null) return
    this.scheduledPollDelay = delay
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null
      this.scheduledPollDelay = null
      void this.poll()
    }, delay)
    // A poll timer must not be the reason the main process stays alive.
    this.pollTimer.unref?.()
  }

  private reschedulePolling(): void {
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer)
      this.pollTimer = null
    }
    this.scheduledPollDelay = null
    if (this.reconciling) return
    this.scheduleNextPoll()
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
        this.lastGlobalActive = 0
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
        const observed = pending.filter(
          (record) =>
            this.records.has(record.id) &&
            // Not yet submitted; the policy pass below owns it.
            record.gid !== '' &&
            // Policy-paused rows stay waiting until the next window.
            this.blockReasons.get(record.id) !== 'allowed-hours'
        )
        await this.observeDownloads(client, observed)
      }

      // Run the single policy timer after observing current statuses so an
      // active transfer is known to be active before the window closes.
      await this.pumpPolicy(client)

      this.publish()
    } finally {
      this.polling = false
      this.reschedulePolling()
    }
  }

  /**
   * Observe every pending GID with one `system.multicall` per tick.
   *
   * The batch asks aria2 for its active (and, while the local queue can still
   * be waiting, waiting) lists with an explicit `keys` array instead of doing
   * one `tellStatus` round trip per GID and transferring every field. Only the
   * few GIDs that disappeared from both lists need a bounded `tellStatus`
   * fallback, which is where completion and error are normally detected.
   *
   * aria2's WebSocket notifications are not used: this client is HTTP JSON-RPC
   * only, so the poll remains the completion signal (fast while work is
   * active, slow while idle).
   */
  private async observeDownloads(
    client: Aria2Client,
    observed: readonly DownloadItem[]
  ): Promise<void> {
    if (observed.length === 0) return

    const plan = buildPollPlan({
      // An active-only tick cannot move back into aria2's waiting queue, so
      // skip that sub-call entirely.
      includeWaiting: observed.some(
        (record) => record.status !== 'active'
      ),
      includeGlobalStat: true
    })

    let outcome: Aria2PollOutcome
    try {
      const raw = await client.call<unknown>('system.multicall', [plan.calls])
      outcome = readPollBatch(plan, raw)
    } catch {
      // A transport failure is ambiguous: keep every local record untouched
      // and let the next tick retry, exactly like the old per-GID failure.
      return
    }

    this.lastGlobalActive = outcome.globalActive ?? 0

    const missing: DownloadItem[] = []
    for (const record of observed) {
      if (!this.records.has(record.id)) continue
      const raw = outcome.statuses.get(record.gid)
      if (raw !== undefined) {
        this.applyStatus(record, raw)
        continue
      }
      // Not in the active/waiting lists: it either stopped between ticks or
      // aria2 no longer tracks the GID. Resolve it exactly, not by pulling the
      // whole stopped history.
      missing.push(record)
    }

    if (missing.length === 0) return
    const results = await this.tellStatusBatch(client, missing)
    for (let index = 0; index < missing.length; index += 1) {
      const record = missing[index]
      if (record === undefined || !this.records.has(record.id)) continue
      const result = results[index]
      if (result === undefined) continue
      if (result.ok) {
        this.applyStatus(record, result.value)
        continue
      }
      if (isGidNotFound(result.error)) {
        this.updateRecord(record, {
          // A vanished aria2 GID is a stopped transfer, not a failed
          // attempt. Keep the partial file/retry budget and expose the
          // explicit interrupted recovery action to the user.
          status: 'interrupted',
          speedBps: 0,
          etaSeconds: null,
          errorMessage: INTERRUPTED_MESSAGE,
          errorDetail: null
        })
        this.setBlockReason(record, null)
        this.persistNow(record)
      }
    }
  }

  /**
   * One `system.multicall` for every unresolved GID instead of one round trip
   * each. Per-entry faults come back in place so the caller keeps the same
   * per-record handling as a single `aria2.tellStatus` failure; a failed batch
   * reports a non-fatal fault for every entry.
   */
  private async tellStatusBatch(
    client: Aria2Client,
    records: readonly DownloadItem[]
  ): Promise<Aria2BatchResult[]> {
    if (records.length === 0) return []

    const calls = buildTellStatusCalls(records.map((record) => record.gid))

    let raw: unknown
    try {
      raw = await client.call<unknown>('system.multicall', [calls])
    } catch (error) {
      const fault =
        error instanceof AppError
          ? error
          : new AppError('ARIA2_RPC_ERROR', 'The aria2 status batch failed.')
      return records.map(() => ({ ok: false, error: fault }))
    }

    const entries = Array.isArray(raw) ? raw : []
    return records.map((_record, index) => {
      const entry = entries[index]
      // aria2 wraps a successful sub-call result in a one-element array and
      // reports a fault as { code, message } in the same slot.
      if (Array.isArray(entry)) {
        return { ok: true, value: entry[0] }
      }
      const fault =
        typeof entry === 'object' && entry !== null
          ? (entry as Record<string, unknown>)
          : {}
      const message =
        typeof fault.message === 'string' && fault.message.length > 0
          ? fault.message
          : 'aria2 returned no status for this transfer.'
      return { ok: false, error: new AppError('ARIA2_RPC_ERROR', message) }
    })
  }
}
