import { randomUUID } from 'node:crypto'
import {
  MAX_SCAN_AUTHOR_LENGTH,
  MAX_SCAN_ITEMS,
  MAX_SCAN_MESSAGE_LENGTH,
  MAX_SCAN_NAME_LENGTH,
  MAX_SCAN_PROBES,
  type ScanCategory,
  type ScanCounters,
  type ScanItem,
  type ScanItemKind,
  type ScanOrigin,
  type ScanSession,
  type ScanSessionStatus
} from '@shared/scanner'
import { ValidationError, normalizeHttpUrl } from '@shared/validation'
import type { PublicTargetLookup } from '../net/publicTarget'
import { AppError } from '../errors'
import { classifyScanCandidate } from './classify'
import {
  extractCandidates,
  type ExtractedCandidate
} from './extract'
import {
  hasDiscourseGenerator,
  isDiscourseTopicUrl,
  scanDiscourseTopic,
  type TaggedCandidate
} from './extract/discourse'
import { hostnameOf, normalizeScanUrl } from './extract/url'
import {
  fetchScanPage,
  type ScanFetchInput,
  type ScanFetchOptions,
  type ScanFetchResult
} from './fetchPage'
import {
  probeScanCandidates,
  type ProbeScanItemFn,
  type ScanProbeResult
} from './probe'

/**
 * Ephemeral Smart Link Scanner sessions.
 *
 * Sessions are keyed by opaque IDs and hold source URLs and any one-job Cookie
 * only in memory. The public DTO never contains either. There is no queue call
 * in this module: extraction and probing can only observe.
 */

export const SCAN_SESSION_TTL_MS = 10 * 60_000
export const SCAN_UPDATE_THROTTLE_MS = 150
export const MAX_ACTIVE_SCANS = 2
const MAX_STORED_SCANS = 16

export type ScanPageFetcher = (
  input: ScanFetchInput,
  options?: ScanFetchOptions
) => Promise<ScanFetchResult>

export interface ScanSessionOptions {
  now?: () => number
  ttlMs?: number
  maxConcurrent?: number
  maxStored?: number
  newOpaqueId?: (prefix: 'scan' | 'item') => string
  fetchPage?: ScanPageFetcher
  lookup?: PublicTargetLookup
  probeCap?: number
  probeItem?: ProbeScanItemFn
  onUpdate: (session: ScanSession) => void
}

export interface StartScanOptions {
  origin?: ScanOrigin
  /** Extension-supplied Cookie for the exact initial host. Never persisted. */
  cookie?: string
}

export interface ResolvedScanTarget {
  itemId: string
  url: string
  name: string
  category: ScanCategory
  kind: ScanItemKind
  cookie?: string
  postNumber: number | null
  author: string | null
}

type ScanCandidate = ExtractedCandidate & {
  postNumber?: number | null
  author?: string | null
}

interface StoredScanItem extends ScanItem {
  /** Internal source URL. Never part of the public DTO. */
  url: string
}

interface StoredScanSession {
  id: string
  origin: ScanOrigin
  /** Initial page URL. Never part of the public DTO. */
  url: string
  hostname: string
  cookieHost: string | null
  cookie: string | null
  status: ScanSessionStatus
  message: string | null
  signinRequired: boolean
  items: Map<string, StoredScanItem>
  order: string[]
  revision: number
  updatedAt: number
  createdAt: number
  expiresAt: number
  fetchedPages: number
  limited: boolean
  controller: AbortController
  run: Promise<void> | null
  emitTimer: ReturnType<typeof setTimeout> | null
  lastEmitAt: number
  emitted: Map<string, string>
  removed: Set<string>
}

function newId(prefix: 'scan' | 'item'): string {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`
}

function cleanText(value: string, maximum: number): string {
  const cleaned = value
    .normalize('NFKC')
    // eslint-disable-next-line no-control-regex -- rejecting control characters is the security intent
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const bounded = Array.from(cleaned).slice(0, maximum).join('').trim()
  return bounded.length > 0 ? bounded : 'Untitled'
}

function countersFor(items: readonly ScanItem[]): ScanCounters {
  const counters: ScanCounters = {
    found: 0,
    probing: 0,
    ready: 0,
    signin: 0,
    unavailable: 0
  }
  for (const item of items) {
    if (item.status === 'found') counters.found += 1
    else if (item.status === 'probing') counters.probing += 1
    else if (item.status === 'ready') counters.ready += 1
    else if (item.status === 'signin') counters.signin += 1
    else if (item.status === 'unavailable') counters.unavailable += 1
  }
  return counters
}

function safeMessage(value: string): string {
  return Array.from(value)
    .slice(0, MAX_SCAN_MESSAGE_LENGTH)
    .join('')
    .trim()
}

function safeTitleMessage(value: string): string | null {
  const text = safeMessage(value)
  if (text.length === 0) return null
  if (/(?:https?|file):\/\//i.test(text) || /[A-Za-z]:\\/.test(text)) {
    return null
  }
  return text
}

export class ScanSessionManager {
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly maxConcurrent: number
  private readonly maxStored: number
  private readonly newOpaqueId: (prefix: 'scan' | 'item') => string
  private readonly fetchPage: ScanPageFetcher
  private readonly lookup: PublicTargetLookup | undefined
  private readonly probeCap: number
  private readonly probeItem: ProbeScanItemFn | undefined
  private readonly onUpdate: (session: ScanSession) => void
  private readonly sessions = new Map<string, StoredScanSession>()
  private closed = false

  constructor(options: ScanSessionOptions) {
    this.now = options.now ?? Date.now
    this.ttlMs = options.ttlMs ?? SCAN_SESSION_TTL_MS
    this.maxConcurrent = options.maxConcurrent ?? MAX_ACTIVE_SCANS
    this.maxStored = options.maxStored ?? MAX_STORED_SCANS
    this.newOpaqueId = options.newOpaqueId ?? newId
    this.fetchPage = options.fetchPage ?? fetchScanPage
    this.lookup = options.lookup
    this.probeCap = Math.min(
      options.probeCap ?? MAX_SCAN_PROBES,
      MAX_SCAN_PROBES
    )
    this.probeItem = options.probeItem
    this.onUpdate = options.onUpdate
  }

  /**
   * Start a scan and return the empty initial session immediately. Results are
   * published progressively through `onUpdate`. This method has no queue path.
   */
  start(rawUrl: unknown, options: StartScanOptions = {}): ScanSession {
    this.assertOpen()
    let url: string
    try {
      url = normalizeHttpUrl(rawUrl)
    } catch (error) {
      if (error instanceof ValidationError) throw error
      throw new ValidationError('Enter a page URL to scan.')
    }

    this.pruneExpired()
    if (this.activeCount() >= this.maxConcurrent) {
      throw new AppError(
        'SCAN_LIMIT',
        'Two page scans are already running. Wait for one to finish or cancel it.'
      )
    }

    const session: StoredScanSession = {
      id: this.newOpaqueId('scan'),
      origin: options.origin ?? 'paste',
      url,
      hostname: hostnameOf(url),
      cookieHost: (() => {
        try {
          return new URL(url).host
        } catch {
          return null
        }
      })(),
      cookie:
        typeof options.cookie === 'string' && options.cookie.length > 0
          ? options.cookie
          : null,
      status: 'scanning',
      message: null,
      signinRequired: false,
      items: new Map(),
      order: [],
      revision: 0,
      updatedAt: this.now(),
      createdAt: this.now(),
      expiresAt: this.now() + this.ttlMs,
      fetchedPages: 0,
      limited: false,
      controller: new AbortController(),
      run: null,
      emitTimer: null,
      lastEmitAt: 0,
      emitted: new Map(),
      removed: new Set()
    }

    this.store(session)
    const initial = this.fullSnapshot(session)
    // The start response is the baseline; only later changes are published.
    for (const item of initial.items) {
      session.emitted.set(item.id, JSON.stringify(item))
    }
    session.run = this.run(session).catch(() => undefined)
    return initial
  }

  cancel(rawSessionId: unknown): ScanSession {
    this.assertOpen()
    const id = this.requireSessionId(rawSessionId)
    const session = this.requireSession(id)
    if (
      session.status === 'done' ||
      session.status === 'cancelled' ||
      session.status === 'limited' ||
      session.status === 'failed'
    ) {
      return this.fullSnapshot(session)
    }
    session.controller.abort()
    session.status = 'cancelled'
    session.message = 'The scan was cancelled.'
    session.updatedAt = this.now()
    this.publish(session, true)
    return this.fullSnapshot(session)
  }

  /** Resolve an explicit renderer selection to internal, validated targets. */
  resolveSelection(
    rawSessionId: unknown,
    rawItemIds: readonly string[]
  ): ResolvedScanTarget[] {
    this.assertOpen()
    const id = this.requireSessionId(rawSessionId)
    const session = this.requireSession(id)
    if (session.expiresAt <= this.now()) {
      this.deleteSession(id)
      throw new AppError(
        'SCAN_EXPIRED',
        'This scan has expired. Scan the page again.'
      )
    }
    if (new Set(rawItemIds).size !== rawItemIds.length) {
      throw new ValidationError('Duplicate scan item identifier.')
    }

    const targets: ResolvedScanTarget[] = []
    for (const itemId of rawItemIds) {
      const item = session.items.get(itemId)
      if (!item) {
        throw new AppError(
          'SCAN_ITEM_NOT_FOUND',
          'The selected item does not belong to this scan.'
        )
      }
      if (item.category === 'page' || item.kind === 'page-link') {
        throw new AppError(
          'SCAN_PAGE_NOT_QUEUEABLE',
          'A web page cannot be queued as a file. Choose a file item instead.'
        )
      }
      if (item.status === 'unavailable') {
        throw new AppError(
          'SCAN_ITEM_UNAVAILABLE',
          'The selected item is no longer available.'
        )
      }
      const cookie = this.cookieFor(session, item.url)
      targets.push({
        itemId,
        url: item.url,
        name: item.name,
        category: item.category,
        kind: item.kind,
        ...(cookie === null ? {} : { cookie }),
        postNumber: item.postNumber,
        author: item.author
      })
    }
    return targets
  }

  /** Read-only snapshot for tests and focused orchestration. */
  getSession(rawSessionId: unknown): ScanSession {
    return this.fullSnapshot(this.requireSession(this.requireSessionId(rawSessionId)))
  }

  /** Resolves when the current scan run has settled. */
  async waitForScan(rawSessionId: unknown): Promise<void> {
    const session = this.requireSession(this.requireSessionId(rawSessionId))
    if (session.run !== null) await session.run
  }

  hasActiveScans(): boolean {
    return this.activeCount() > 0
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const session of this.sessions.values()) {
      try {
        session.controller.abort()
      } catch {
        // Already settled.
      }
      if (session.emitTimer !== null) {
        clearTimeout(session.emitTimer)
        session.emitTimer = null
      }
    }
    this.sessions.clear()
  }

  private async run(session: StoredScanSession): Promise<void> {
    try {
      const page = await this.fetchPage(
        {
          url: session.url,
          ...(session.cookie === null ? {} : { cookie: session.cookie }),
          accept: 'html',
          signal: session.controller.signal
        },
        this.lookup === undefined ? {} : { lookup: this.lookup }
      )
      if (session.controller.signal.aborted) return
      session.fetchedPages += 1
      session.url = page.finalUrl
      session.hostname = hostnameOf(page.finalUrl)
      session.expiresAt = this.now() + this.ttlMs
      this.touch(session)

      const discourseCandidates = await this.tryDiscourse(session, page)
      const candidates: ScanCandidate[] =
        discourseCandidates ??
        extractCandidates(page.body, page.finalUrl).map((candidate) => ({
          ...candidate,
          postNumber: null,
          author: null
        }))

      for (const candidate of candidates) {
        if (this.addCandidate(session, candidate) === 'limited') break
      }

      session.message =
        session.items.size === 0
          ? 'No downloadable content was found on that page.'
          : null
      session.updatedAt = this.now()
      this.publish(session, true)

      if (session.controller.signal.aborted) return
      await this.probeItems(session)
      if (session.controller.signal.aborted) return

      session.status =
        session.limited || session.items.size >= MAX_SCAN_ITEMS
          ? 'limited'
          : 'done'
      if (session.status === 'limited') {
        session.message = safeMessage(
          `The scan reached the ${MAX_SCAN_ITEMS}-item limit. Narrow the page selection.`
        )
      }
      session.updatedAt = this.now()
      this.publish(session, true)
    } catch (error) {
      if (session.controller.signal.aborted || isCancelled(error)) {
        if (session.status !== 'cancelled') {
          session.status = 'cancelled'
          session.message = 'The scan was cancelled.'
          session.updatedAt = this.now()
          this.publish(session, true)
        }
        return
      }
      const code = errorCode(error)
      if (code === 'SCAN_NEEDS_LOGIN') {
        session.signinRequired = true
        session.message = safeMessage(
          session.origin === 'extension'
            ? 'This page still needs a browser sign-in. Make sure you are signed in in that tab and allow cookies for this site.'
            : 'This page needs a browser sign-in. Use "Scan this page" from the DonDownload browser extension after allowing cookies for this site.'
        )
        session.status = 'done'
        session.updatedAt = this.now()
        this.publish(session, true)
        return
      }
      session.status = 'failed'
      session.message = safeMessage(safeFailureMessage(error))
      session.updatedAt = this.now()
      this.publish(session, true)
    }
  }

  private async tryDiscourse(
    session: StoredScanSession,
    page: ScanFetchResult
  ): Promise<TaggedCandidate[] | null> {
    const pathProbe = isDiscourseTopicUrl(page.finalUrl)
    if (!hasDiscourseGenerator(page.body) && !pathProbe) return null

    try {
      const result = await scanDiscourseTopic({
        pageUrl: page.finalUrl,
        html: page.body,
        allowApiProbe: pathProbe,
        signal: session.controller.signal,
        fetcher: async (url, accept, signal) => {
          const response = await this.fetchPage(
            {
              url,
              ...(this.cookieFor(session, url) === null
                ? {}
                : { cookie: this.cookieFor(session, url) as string }),
              accept,
              signal
            },
            this.lookup === undefined ? {} : { lookup: this.lookup }
          )
          session.fetchedPages += 1
          return { body: response.body, finalUrl: response.finalUrl }
        }
      })
      if (!result.detected) return null
      if (
        result.candidates.length === 0 &&
        !hasDiscourseGenerator(page.body)
      ) {
        // A topic-shaped URL on a non-Discourse site must not hide the normal
        // generic extraction results.
        return null
      }
      if (result.title !== null && session.message === null) {
        const title = safeTitleMessage(result.title)
        if (title !== null) session.message = title
      }
      if (result.limited) session.limited = true
      return result.candidates
    } catch (error) {
      // A path-shaped URL on a non-Discourse site is a false positive. Only a
      // confirmed generator tag turns a failed API read into a needed login.
      if (hasDiscourseGenerator(page.body)) throw error
      return null
    }
  }

  private addCandidate(
    session: StoredScanSession,
    candidate: ScanCandidate
  ): 'added' | 'duplicate' | 'limited' {
    let normalized: string
    try {
      normalized = normalizeScanUrl(candidate.url)
    } catch {
      return 'duplicate'
    }
    for (const item of session.items.values()) {
      if (item.url === normalized) {
        if (
          item.postNumber === null &&
          typeof candidate.postNumber === 'number'
        ) {
          item.postNumber = candidate.postNumber
          item.author = candidate.author ?? null
        }
        return 'duplicate'
      }
    }
    if (session.items.size >= MAX_SCAN_ITEMS) {
      session.limited = true
      return 'limited'
    }

    const classification = classifyScanCandidate({
      url: normalized,
      nameHint: candidate.nameHint,
      downloadAttribute: candidate.downloadAttribute,
      isAttachment: candidate.isAttachment,
      fromScript: candidate.fromScript,
      isEmbed: candidate.isEmbed
    })
    const id = this.newOpaqueId('item')
    const item: StoredScanItem = {
      id,
      category: classification.category,
      kind: classification.kind,
      name: cleanText(classification.name, MAX_SCAN_NAME_LENGTH),
      hostname: hostnameOf(normalized),
      sizeBytes: null,
      verified: false,
      status: 'found',
      postNumber:
        typeof candidate.postNumber === 'number' ? candidate.postNumber : null,
      author:
        typeof candidate.author === 'string'
          ? cleanText(candidate.author, MAX_SCAN_AUTHOR_LENGTH)
          : null,
      url: normalized
    }
    session.items.set(id, item)
    session.order.push(id)
    return 'added'
  }

  private async probeItems(session: StoredScanSession): Promise<void> {
    const targets = session.order
      .map((id) => session.items.get(id))
      .filter(
        (item): item is StoredScanItem =>
          item !== undefined &&
          item.kind === 'file' &&
          item.category !== 'page' &&
          item.status !== 'ready' &&
          item.status !== 'signin' &&
          item.status !== 'unavailable'
      )
      .slice(0, this.probeCap)
    if (targets.length === 0) return

    for (const item of targets) item.status = 'probing'
    this.touch(session)
    this.publish(session, true)

    const inputs = targets.map((item) => {
      const cookie = this.cookieFor(session, item.url)
      return {
        url: item.url,
        ...(cookie === null ? {} : { cookie }),
        signal: session.controller.signal
      }
    })

    await probeScanCandidates(inputs, {
      ...(this.lookup === undefined ? {} : { lookup: this.lookup }),
      signal: session.controller.signal,
      cap: this.probeCap,
      ...(this.probeItem === undefined ? {} : { probe: this.probeItem }),
      onResult: (index, result: ScanProbeResult) => {
        const target = targets[index]
        if (!target) return
        const current = session.items.get(target.id)
        if (!current) return
        current.category = result.classification.category
        current.kind = result.classification.kind
        current.name = cleanText(
          result.classification.name,
          MAX_SCAN_NAME_LENGTH
        )
        current.status = result.status
        current.verified = result.verified
        current.sizeBytes = result.sizeBytes
        if (result.status === 'signin') session.signinRequired = true
        this.touch(session)
        this.scheduleEmit(session)
      }
    })
  }

  private cookieFor(session: StoredScanSession, url: string): string | null {
    if (session.cookie === null || session.cookieHost === null) return null
    try {
      return new URL(url).host === session.cookieHost ? session.cookie : null
    } catch {
      return null
    }
  }

  private touch(session: StoredScanSession): void {
    session.updatedAt = this.now()
    session.expiresAt = this.now() + this.ttlMs
  }

  private publicItem(item: StoredScanItem): ScanItem {
    return {
      id: item.id,
      category: item.category,
      kind: item.kind,
      name: item.name,
      hostname: item.hostname,
      sizeBytes: item.sizeBytes,
      verified: item.verified,
      status: item.status,
      postNumber: item.postNumber,
      author: item.author
    }
  }

  private fullSnapshot(session: StoredScanSession): ScanSession {
    const items = session.order
      .map((id) => session.items.get(id))
      .filter((item): item is StoredScanItem => item !== undefined)
      .map((item) => this.publicItem(item))
    return {
      sessionId: session.id,
      status: session.status,
      origin: session.origin,
      hostname: session.hostname,
      message: session.message,
      signinRequired: session.signinRequired,
      counters: countersFor(items),
      progress: {
        fetchedPages: session.fetchedPages,
        totalItems: items.length,
        queueableItems: items.filter(
          (item) => item.category !== 'page' && item.kind === 'file'
        ).length
      },
      items,
      removedItemIds: [...session.removed],
      revision: session.revision,
      updatedAt: session.updatedAt
    }
  }

  private scheduleEmit(session: StoredScanSession): void {
    if (this.closed || session.emitTimer !== null) return
    const elapsed = this.now() - session.lastEmitAt
    const delay = Math.max(0, SCAN_UPDATE_THROTTLE_MS - elapsed)
    session.emitTimer = setTimeout(() => {
      session.emitTimer = null
      this.publish(session, false)
    }, delay)
    session.emitTimer.unref?.()
  }

  private publish(session: StoredScanSession, force: boolean): void {
    if (this.closed) return
    if (!force) {
      const elapsed = this.now() - session.lastEmitAt
      if (elapsed < SCAN_UPDATE_THROTTLE_MS) {
        this.scheduleEmit(session)
        return
      }
    }
    if (session.emitTimer !== null) {
      clearTimeout(session.emitTimer)
      session.emitTimer = null
    }

    const items = session.order
      .map((id) => session.items.get(id))
      .filter((item): item is StoredScanItem => item !== undefined)
    const changed: ScanItem[] = []
    const nextEmitted = new Map<string, string>()
    for (const stored of items) {
      const item = this.publicItem(stored)
      const serialized = JSON.stringify(item)
      nextEmitted.set(item.id, serialized)
      if (session.emitted.get(item.id) !== serialized) changed.push(item)
    }
    const removed = [...session.removed].filter(
      (id) => session.emitted.has(id)
    )
    session.emitted = nextEmitted
    session.removed.clear()

    const allPublic = items.map((item) => this.publicItem(item))
    const snapshot: ScanSession = {
      sessionId: session.id,
      status: session.status,
      origin: session.origin,
      hostname: session.hostname,
      message: session.message,
      signinRequired: session.signinRequired,
      counters: countersFor(allPublic),
      progress: {
        fetchedPages: session.fetchedPages,
        totalItems: allPublic.length,
        queueableItems: allPublic.filter(
          (item) => item.category !== 'page' && item.kind === 'file'
        ).length
      },
      items: changed,
      removedItemIds: removed,
      revision: session.revision + 1,
      updatedAt: session.updatedAt
    }
    session.revision += 1
    session.lastEmitAt = this.now()
    try {
      this.onUpdate(snapshot)
    } catch {
      // A closing renderer must never break scanning.
    }
  }

  private store(session: StoredScanSession): void {
    this.sessions.set(session.id, session)
    while (this.sessions.size > this.maxStored) {
      const oldest = [...this.sessions.values()].sort(
        (left, right) => left.createdAt - right.createdAt
      )[0]
      if (!oldest) break
      this.deleteSession(oldest.id)
    }
  }

  private activeCount(): number {
    let count = 0
    for (const session of this.sessions.values()) {
      if (session.status === 'scanning') count += 1
    }
    return count
  }

  private pruneExpired(): void {
    const current = this.now()
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= current) this.deleteSession(id)
    }
  }

  private deleteSession(id: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    try {
      session.controller.abort()
    } catch {
      // Already settled.
    }
    if (session.emitTimer !== null) {
      clearTimeout(session.emitTimer)
      session.emitTimer = null
    }
    this.sessions.delete(id)
  }

  private requireSessionId(value: unknown): string {
    if (
      typeof value !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(value)
    ) {
      throw new ValidationError('Invalid scan session identifier.')
    }
    return value
  }

  private requireSession(id: string): StoredScanSession {
    this.pruneExpired()
    const session = this.sessions.get(id)
    if (!session) {
      throw new AppError('SCAN_NOT_FOUND', 'Scan the page again.')
    }
    return session
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new AppError('SCAN_UNAVAILABLE', 'The scanner is shutting down.')
    }
  }
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
  return 'SCAN_FAILED'
}

function isCancelled(error: unknown): boolean {
  return errorCode(error) === 'SCAN_CANCELLED'
}

function safeFailureMessage(error: unknown): string {
  const code = errorCode(error)
  if (code === 'SCAN_FETCH_TIMEOUT') return 'The page did not answer in time.'
  if (code === 'SCAN_PAGE_TOO_LARGE') {
    return 'That page is too large to scan safely.'
  }
  if (code === 'SCAN_TARGET_NOT_PUBLIC') {
    return 'Local and private network pages cannot be scanned.'
  }
  if (code === 'SCAN_FETCH_TYPE') {
    return 'That link is not an HTML page. Add a direct file link instead.'
  }
  if (code === 'SCAN_FETCH_REDIRECT') {
    return 'The page redirected too many times.'
  }
  if (code === 'SCAN_COOKIE_REDIRECT') {
    return 'The signed-in page redirected to a different host, so it was not scanned with cookies.'
  }
  return 'The page could not be scanned. It may be unavailable or require a sign-in.'
}
