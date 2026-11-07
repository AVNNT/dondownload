import { randomUUID } from 'node:crypto'
import {
  MAX_SCAN_AUTHOR_LENGTH,
  MAX_SCAN_FOLLOW_DEPTH,
  MAX_SCAN_FOLLOW_PAGES,
  MAX_SCAN_ITEMS,
  MAX_SCAN_MESSAGE_LENGTH,
  MAX_SCAN_NAME_LENGTH,
  MAX_SCAN_OTHER_LINKS,
  MAX_SCAN_PROBES,
  MAX_SCAN_VIDEO_ANALYSES,
  SCAN_SESSION_BUDGET_MS,
  isQueueableScanItem,
  type ScanCategory,
  type ScanCounters,
  type ScanItem,
  type ScanItemKind,
  type ScanOrigin,
  type ScanScriptPairingInput,
  type ScanScriptSet,
  type ScanSession,
  type ScanSessionMode,
  type ScanSessionStatus,
  type ScanVideoFormat
} from '@shared/scanner'
import { ValidationError, normalizeHttpUrl } from '@shared/validation'
import {
  assertPublicTarget,
  type PublicTargetLookup
} from '../net/publicTarget'
import { AppError } from '../errors'
import {
  MAX_PIXELDRAIN_LIST_FILES,
  type PixeldrainFileResolution,
  type PixeldrainListResolution
} from '../hosts/pixeldrain'
import {
  MAX_MEGA_FOLDER_ENTRIES,
  type MegaFileResolution,
  type MegaFolderResolution
} from '../hosts/mega'
import {
  MAX_SCAN_MEGA_REQUESTS,
  megaTargetOf,
  resolveMegaTargets,
  type ScanMegaOutcome,
  type ScanMegaPort,
  type ScanMegaTarget
} from './mega'
import { classifyScanCandidate } from './classify'
import { isVideoHostVideoUrl } from './videoHosts'
import {
  extractCandidates,
  type ExtractedCandidate
} from './extract'
import {
  hasDiscourseGenerator,
  isDiscourseTopicUrl,
  scanDiscourseTopic,
  type DiscoursePageLink,
  type TaggedCandidate
} from './extract/discourse'
import { extractVideoMedia } from './extract/videoMedia'
import {
  MAX_SCAN_VIDEO_MEDIA_SOURCES,
  type ScanVideoMediaKind,
  type ScanVideoMediaSource,
  type ScanVideoRequest
} from '@shared/scanVideo'
import type { ScanImagesRequest } from '@shared/scanImages'
import type { ScanGofileRequest } from '@shared/scanBridge'
import {
  GOFILE_BROWSER_ONLY_REASON,
  GOFILE_SHARE_EMPTY_REASON,
  isGofileHostname,
  gofileStatusReason,
  type GofileShareStatus
} from '@shared/gofile'
import { gofileShareOf, normalizeGofileFiles } from './gofile'
import { hostnameOf, normalizeScanUrl, pathnameOf } from './extract/url'
import {
  fetchScanPage,
  type ScanFetchInput,
  type ScanFetchOptions,
  type ScanFetchResult
} from './fetchPage'
import {
  extractFollowCandidates,
  isForumNavigationUrl,
  scoreFollowLink
} from './follow'
import {
  probeScanCandidates,
  type ProbeScanItemFn,
  type ScanProbeResult
} from './probe'
import { ScanRobotsCache } from './robots'
import {
  MAX_SCAN_PIXELDRAIN_REQUESTS,
  pixeldrainLinkOf,
  resolvePixeldrainTargets,
  type ScanPixeldrainOutcome,
  type ScanPixeldrainPort,
  type ScanPixeldrainTarget
} from './pixeldrain'
import {
  BROWSER_ONLY_REASON,
  resolveVideoCandidates,
  safeThumbnail,
  videoIdentityForUrl,
  type ScanMediaAnalyzer,
  type VideoResolution
} from './videoResolver'
import {
  buildScanScriptSets,
  buildScriptSetSources,
  type PairingScanItem
} from './pairing'

/**
 * Ephemeral Smart Link Scanner sessions.
 *
 * Sessions are keyed by opaque IDs and hold source URLs and any one-job Cookie
 * only in memory. The public DTO never contains either. There is no queue call
 * in this module: extraction and probing can only observe.
 */

export const SCAN_SESSION_TTL_MS = 10 * 60_000
export const SCAN_UPDATE_THROTTLE_MS = 300
export const MAX_ACTIVE_SCANS = 2
const MAX_STORED_SCANS = 16

/**
 * A browser-only card keeps a pending pairing for this long. It is memory-only:
 * a restart simply forgets it and the extension hand-off behaves normally.
 */
export const BROWSER_MATCH_TTL_MS = 30 * 60_000

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
  /** Metadata-only media analysis; absent keeps video page links unresolved. */
  analyzeMedia?: ScanMediaAnalyzer
  /**
   * Public Pixeldrain metadata adapter. When present, a discovered `/u/<id>`
   * link is resolved to its real file name, size and content type, and a
   * `/l/<id>` list is expanded into one item per file.
   */
  pixeldrain?: ScanPixeldrainPort
  /**
   * Public MEGA adapter. When present, a discovered `/file/<id>#<key>` link is
   * resolved to its real file name and size, and a `/folder/<id>#<key>` link is
   * expanded into one item per file. The decryption key stays internal.
   */
  mega?: ScanMegaPort
  videoCap?: number
  followPages?: number
  followDepth?: number
  sessionBudgetMs?: number
  onUpdate: (session: ScanSession) => void
}

export interface StartScanOptions {
  origin?: ScanOrigin
  /** Extension-supplied Cookie for the exact initial host. Never persisted. */
  cookie?: string
}

export interface ResolvedVideoTarget {
  analysisId: string
  expiresAt: number
  formats: ScanVideoFormat[]
  bestOptionId: string | null
}

/**
 * One direct media source found by the page fallback or reported by the user's
 * own browser tab. The URL and the referer are internal: only the opaque
 * `optionId` and the display metadata reach the renderer.
 */
export interface ScanVideoMediaTargetSource {
  optionId: string
  url: string
  kind: ScanVideoMediaKind
  label: string
  width: number | null
  height: number | null
  sizeBytes: number | null
}

export interface ScanVideoMediaTarget {
  /** Page URL sent as Referer; the media itself is served from another host. */
  referer: string
  sources: ScanVideoMediaTargetSource[]
}

export interface ResolvedScanTarget {
  itemId: string
  url: string
  name: string
  category: ScanCategory
  kind: ScanItemKind
  cookie?: string
  /** Second URL tried only when `url` fails with a 403/404 (images). */
  fallbackUrl?: string
  postNumber: number | null
  author: string | null
  /** Present only for a resolved video page link. */
  video?: ResolvedVideoTarget
  /**
   * Present instead of `video` when the page fallback (or the user's browser
   * tab) produced direct media for a video yt-dlp could not read.
   */
  media?: ScanVideoMediaTarget
}

/** Internal funscript pairing after session membership and set checks. */
export interface ResolvedScriptPairing {
  videoItemId: string
  setId: string
  scriptItemIds: string[]
  primaryVariant: string | null
  rename: boolean
  scripts: Array<{
    itemId: string
    filename: string
    axis: string | null
    variant: string | null
  }>
}

/** One script resolved for a browser hand-off, with its exact-host cookie. */
export interface BrowserPairingScript {
  itemId: string
  url: string
  filename: string
  axis: string | null
  variant: string | null
  /** Only present when the script URL host equals the scan's cookie host. */
  cookie?: string
}

/**
 * Memory-only pairing remembered when the user opens a browser-only video.
 * The normalized page URL is the join key for the later extension hand-off.
 */
export interface PendingBrowserPairing {
  pageUrl: string
  origin: string
  sessionId: string
  videoItemId: string
  setId: string
  scriptItemIds: string[]
  primaryVariant: string | null
  rename: boolean
  videoTitle: string
  scripts: BrowserPairingScript[]
  expiresAt: number
}

type ScanCandidate = ExtractedCandidate & {
  postNumber?: number | null
  author?: string | null
  /** Followed video-path/embed/page: show it as a video page link. */
  videoHint?: boolean
}

interface StoredScanItem extends ScanItem {
  /** Internal source URL. Never part of the public DTO. */
  url: string
  /**
   * Second URL tried only when `url` fails with a 403/404. Pinterest originals
   * sometimes exist with a different extension, so the 736x variant is kept as
   * a fallback. Never part of the public DTO.
   */
  fallbackUrl: string | null
  /** Internal video identity used to merge repeated embeds. */
  videoIdentity: string | null
  /** Analysis association used by the explicit queue path. */
  videoAnalysis: ResolvedVideoTarget | null
  /**
   * Direct media the page (or the user's own browser tab) exposed when yt-dlp
   * could not resolve it. Memory-only: the URLs never leave this module.
   */
  videoMedia: ScanVideoMediaTarget | null
  /** True while a browser-only card has an armed hand-off pairing. */
  browserMatchPending: boolean
}

interface StoredScanSession {
  id: string
  origin: ScanOrigin
  mode: ScanSessionMode
  /** Initial page URL. Never part of the public DTO. */
  url: string
  hostname: string
  /** Safe topic/page title from the adapter, if any. */
  title: string | null
  cookieHost: string | null
  cookie: string | null
  /**
   * One-job Gofile `accountToken` Cookie reported by the extension for the
   * share the user opened. Gofile serves downloads from `store<N>.gofile.io`,
   * so it is kept apart from the exact-host `cookie` slot and is only ever
   * attached to a Gofile host. Never persisted, never published.
   */
  gofileCookie: string | null
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
  limitedMessage: string | null
  deadline: number
  /** yt-dlp analyses already started in this session (scan or manual mark). */
  videoAnalyses: number
  /** Items with an in-flight "This is a video" analysis. */
  videoResolving: Set<string>
  /** Plain page links added to the collapsed "Other links" group. */
  otherLinks: number
  controller: AbortController
  run: Promise<void> | null
  /** True once the run actually started; queued sessions wait for a slot. */
  started: boolean
  /** True once the run settled or the session was cancelled/expired. */
  settled: boolean
  waiters: Array<() => void>
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
    protected: 0,
    unavailable: 0,
    toolUnavailable: 0
  }
  for (const item of items) {
    if (item.status === 'found') counters.found += 1
    else if (item.status === 'probing') counters.probing += 1
    else if (item.status === 'ready') counters.ready += 1
    else if (item.status === 'signin') counters.signin += 1
    else if (item.status === 'protected') counters.protected += 1
    else if (item.status === 'unavailable') counters.unavailable += 1
    else if (item.status === 'tool-unavailable') counters.toolUnavailable += 1
  }
  return counters
}

function safeMessage(value: string): string {
  return Array.from(value)
    .slice(0, MAX_SCAN_MESSAGE_LENGTH)
    .join('')
    .trim()
}

/**
 * Display name for one collected image: the URL basename, decoded when it is
 * valid percent-encoding. The download filename is derived from the same URL by
 * the batch manager, so this is only the card label.
 */
function imageFilename(url: string): string {
  const pathname = pathnameOf(url)
  const base = pathname.slice(pathname.lastIndexOf('/') + 1)
  if (base.length === 0) return 'Image'
  try {
    return decodeURIComponent(base)
  } catch {
    return base
  }
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
  private readonly analyzeMedia: ScanMediaAnalyzer | undefined
  private readonly pixeldrain: ScanPixeldrainPort | undefined
  private readonly mega: ScanMegaPort | undefined
  private readonly videoCap: number
  private readonly followPages: number
  private readonly followDepth: number
  private readonly sessionBudgetMs: number
  private readonly onUpdate: (session: ScanSession) => void
  private readonly sessions = new Map<string, StoredScanSession>()
  /** Memory-only pending browser hand-offs, keyed by normalized page URL. */
  private readonly browserPairings = new Map<string, PendingBrowserPairing>()
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
    this.analyzeMedia = options.analyzeMedia
    this.pixeldrain = options.pixeldrain
    this.mega = options.mega
    this.videoCap = Math.max(
      0,
      Math.min(options.videoCap ?? MAX_SCAN_VIDEO_ANALYSES, MAX_SCAN_VIDEO_ANALYSES)
    )
    this.followPages = Math.max(
      1,
      Math.min(options.followPages ?? MAX_SCAN_FOLLOW_PAGES, MAX_SCAN_FOLLOW_PAGES)
    )
    this.followDepth = Math.max(
      0,
      Math.min(options.followDepth ?? MAX_SCAN_FOLLOW_DEPTH, MAX_SCAN_FOLLOW_DEPTH)
    )
    this.sessionBudgetMs =
      options.sessionBudgetMs !== undefined && options.sessionBudgetMs > 0
        ? Math.min(options.sessionBudgetMs, SCAN_SESSION_BUDGET_MS)
        : SCAN_SESSION_BUDGET_MS
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

    const session = this.createSession(url, options)
    this.begin(session)
    const initial = this.fullSnapshot(session)
    // The start response is the baseline; only later changes are published.
    for (const item of initial.items) {
      session.emitted.set(item.id, JSON.stringify(item))
    }
    return initial
  }

  /**
   * Start several independent topic scans. The first `MAX_ACTIVE_SCANS` run
   * immediately; the rest are real sessions queued behind them and start as
   * slots free. Every URL keeps its own cookie scope and its own pairing rules.
   */
  startMany(rawUrls: readonly unknown[], options: StartScanOptions = {}): ScanSession[] {
    this.assertOpen()
    if (!Array.isArray(rawUrls) || rawUrls.length === 0) {
      throw new ValidationError('Enter at least one page URL to scan.')
    }
    const urls: string[] = []
    for (const rawUrl of rawUrls) {
      let url: string
      try {
        url = normalizeHttpUrl(rawUrl)
      } catch (error) {
        if (error instanceof ValidationError) throw error
        throw new ValidationError('Enter a page URL to scan.')
      }
      if (!urls.includes(url)) urls.push(url)
    }
    if (urls.length === 0) {
      throw new ValidationError('Enter at least one page URL to scan.')
    }

    this.pruneExpired()
    const sessions = urls.map((url) => {
      const session = this.createSession(url, options)
      if (this.activeCount() < this.maxConcurrent) {
        this.begin(session)
      } else {
        session.message = 'Waiting for an active scan to finish.'
        this.publish(session, true)
      }
      return this.fullSnapshot(session)
    })
    return sessions
  }

  /**
   * Start an image session from the list the browser extension collected on the
   * live page. Nothing is fetched here: Pinterest boards are JS-rendered, so the
   * extension walked the DOM itself. Every URL was already validated by
   * `parseScanImagesRequest`; this only re-normalizes it and keeps the optional
   * fallback for the download retry.
   */
  startImages(input: ScanImagesRequest): ScanSession {
    this.assertOpen()
    const pageUrl = normalizeHttpUrl(input.pageUrl)

    this.pruneExpired()
    const session = this.createSession(pageUrl, {
      origin: 'extension',
      ...(input.cookie === undefined ? {} : { cookie: input.cookie })
    })
    session.mode = 'images'
    session.title = cleanText(input.pageTitle, MAX_SCAN_NAME_LENGTH)
    session.status = 'done'
    session.started = true
    session.settled = true
    session.message = null

    for (const image of input.images) {
      if (session.items.size >= MAX_SCAN_ITEMS) {
        session.limited = true
        break
      }
      let url: string
      try {
        url = normalizeScanUrl(image.url)
      } catch {
        continue
      }
      let fallbackUrl: string | null = null
      if (image.fallbackUrl !== undefined) {
        try {
          const candidate = normalizeScanUrl(image.fallbackUrl)
          if (candidate !== url) fallbackUrl = candidate
        } catch {
          fallbackUrl = null
        }
      }
      const id = this.newOpaqueId('item')
      const item: StoredScanItem = {
        id,
        category: 'image',
        kind: 'file',
        name: cleanText(imageFilename(url), MAX_SCAN_NAME_LENGTH),
        hostname: hostnameOf(url),
        sizeBytes: null,
        // The image was observed in the live DOM, so it is never re-fetched or
        // probed; the queue path skips its probe for the same reason.
        verified: false,
        status: 'ready',
        postNumber: null,
        author: null,
        url,
        fallbackUrl,
        videoIdentity: null,
        videoAnalysis: null,
        videoMedia: null,
        browserMatchPending: false,
        ...(image.width === undefined ? {} : { width: image.width }),
        ...(image.height === undefined ? {} : { height: image.height }),
        thumbnailUrl: fallbackUrl ?? url
      }
      session.items.set(id, item)
      session.order.push(id)
    }

    if (session.items.size === 0) {
      this.deleteSession(session.id)
      throw new ValidationError('No images were reported for that page.')
    }
    if (session.limited) {
      session.status = 'limited'
      session.message = safeMessage(
        `Only the first ${MAX_SCAN_ITEMS} images were kept.`
      )
    }

    this.touch(session)
    const initial = this.fullSnapshot(session)
    // The returned snapshot is the baseline; only later changes are published.
    for (const item of initial.items) {
      session.emitted.set(item.id, JSON.stringify(item))
    }
    return initial
  }

  /**
   * Fill a session from the rows the user's own signed-in Gofile tab rendered.
   *
   * Nothing is fetched here: the extension read the live DOM, so the desktop
   * only turns the reported files into normal cards. When a scan of a forum
   * topic (or any page) already shows a card for this exact share, the files
   * replace that card inside the same session so the rest of the scan — post
   * numbers, funscript sets and the batch the user is building — stays
   * together. Otherwise the share gets its own session.
   */
  startGofile(input: ScanGofileRequest): ScanSession {
    this.assertOpen()
    const share = gofileShareOf(`https://gofile.io/d/${input.shareId}`)
    if (share === null) {
      throw new ValidationError('The Gofile share identifier is invalid.')
    }
    this.pruneExpired()

    const files = normalizeGofileFiles(input.files)
    const reason = gofileStatusReason(input.status)

    const existing = this.sessionForGofileShare(share.id)
    if (existing !== null) {
      this.mergeGofileShare(existing, share.id, files, input.status, input.cookie)
      this.touch(existing)
      this.publish(existing, true)
      return this.fullSnapshot(existing)
    }

    const session = this.createSession(share.canonicalUrl, {
      origin: 'extension'
    })
    session.mode = 'gofile'
    session.status = 'done'
    session.started = true
    session.settled = true
    session.message = null
    session.gofileCookie =
      typeof input.cookie === 'string' && input.cookie.length > 0
        ? input.cookie
        : null

    if (files.length === 0) {
      // A share that could not be listed keeps one truthful card with the
      // fixed reason instead of an empty session.
      const id = this.newOpaqueId('item')
      session.items.set(id, {
        id,
        category: 'other',
        kind: 'page-link',
        name: `Gofile share ${share.id}`,
        hostname: 'gofile.io',
        sizeBytes: null,
        verified: false,
        status: 'unavailable',
        postNumber: null,
        author: null,
        url: share.canonicalUrl,
        fallbackUrl: null,
        videoIdentity: null,
        videoAnalysis: null,
        videoMedia: null,
        browserMatchPending: false,
        unavailableReason: reason ?? GOFILE_BROWSER_ONLY_REASON
      })
      session.order.push(id)
    } else {
      for (const file of files) {
        if (session.items.size >= MAX_SCAN_ITEMS) {
          session.limited = true
          break
        }
        const created = this.addResolvedFileItem(session, {
          url: file.url,
          name: file.name,
          size: file.size,
          mimeType: null,
          postNumber: null,
          author: null
        })
        if (created !== null) this.ensureGofileFileItem(created)
      }
      if (session.limited) {
        session.status = 'limited'
        session.message = safeMessage(
          `The scan reached the ${MAX_SCAN_ITEMS}-item limit. Narrow the page selection.`
        )
      }
    }

    this.touch(session)
    const initial = this.fullSnapshot(session)
    for (const item of initial.items) {
      session.emitted.set(item.id, JSON.stringify(item))
    }
    return initial
  }

  /** The live session that already shows a card for this exact share. */
  private sessionForGofileShare(shareId: string): StoredScanSession | null {
    for (const session of this.sessions.values()) {
      if (session.expiresAt <= this.now()) continue
      for (const item of session.items.values()) {
        if (gofileShareOf(item.url)?.id === shareId) return session
      }
    }
    return null
  }

  /**
   * Replace the share card of an existing session with one card per file. The
   * share's post number and author are inherited so funscript pairing keeps
   * working, and a file that was already listed is upgraded in place.
   */
  private mergeGofileShare(
    session: StoredScanSession,
    shareId: string,
    files: readonly { name: string; size: number | null; url: string }[],
    status: GofileShareStatus,
    cookie: string | undefined
  ): void {
    if (typeof cookie === 'string' && cookie.length > 0) {
      session.gofileCookie = cookie
    }
    const shareItems: StoredScanItem[] = []
    for (const item of session.items.values()) {
      if (gofileShareOf(item.url)?.id === shareId) shareItems.push(item)
    }
    const postNumber =
      shareItems.find((item) => item.postNumber !== null)?.postNumber ?? null
    const author = shareItems.find((item) => item.author !== null)?.author ?? null

    if (files.length === 0) {
      const reason = gofileStatusReason(status) ?? GOFILE_BROWSER_ONLY_REASON
      for (const item of shareItems) {
        item.status = 'unavailable'
        item.verified = false
        item.unavailableReason = reason
      }
      return
    }

    let added = 0
    for (const file of files) {
      const existing = [...session.items.values()].filter(
        (item) => item.url === file.url
      )
      if (existing.length > 0) {
        for (const item of existing) {
          this.applyResolvedFile(item, {
            name: file.name,
            size: file.size,
            mimeType: null
          })
          this.ensureGofileFileItem(item)
        }
        this.mergeResolvedItems(session, existing)
        added += 1
        continue
      }
      if (session.items.size >= MAX_SCAN_ITEMS) {
        session.limited = true
        break
      }
      const created = this.addResolvedFileItem(session, {
        url: file.url,
        name: file.name,
        size: file.size,
        mimeType: null,
        postNumber,
        author
      })
      if (created !== null) {
        this.ensureGofileFileItem(created)
        added += 1
      }
    }

    if (session.limited) {
      session.limitedMessage ??= `The scan reached the ${MAX_SCAN_ITEMS}-item limit. Narrow the page selection.`
    }
    // The share page itself is not downloadable; its files replace it.
    if (added > 0) {
      for (const item of shareItems) this.removeItem(session, item.id)
      return
    }
    for (const item of shareItems) {
      item.status = 'unavailable'
      item.unavailableReason = GOFILE_SHARE_EMPTY_REASON
    }
  }

  /**
   * A Gofile row is a real file even when its name carries no extension, so a
   * card that classified as a page link is kept as a file card instead of
   * disappearing into the "Other links" group.
   */
  private ensureGofileFileItem(item: StoredScanItem): void {
    if (item.kind === 'file') return
    item.kind = 'file'
    item.category = 'other'
    item.status = 'ready'
    item.verified = false
    item.unavailableReason = null
  }

  /**
   * Fill a video card from the media the user's own browser tab rendered.
   *
   * The extension reported the URLs of a video page it could read in the live
   * DOM, which is exactly what a Cloudflare challenge or an age gate denies the
   * app. When the page is already a browser-only card in a live session, that
   * card is upgraded in place so the rest of the scan (post numbers, funscript
   * sets, the batch the user is building) stays together. Otherwise the page
   * becomes its own one-card session. Nothing is fetched here and nothing is
   * queued.
   */
  async startVideoMedia(input: ScanVideoRequest): Promise<ScanSession> {
    this.assertOpen()
    let pageUrl: string
    try {
      pageUrl = normalizeScanUrl(input.pageUrl)
    } catch {
      throw new ValidationError('That video page link is not valid.')
    }
    this.pruneExpired()

    const existing = this.sessionForVideoPage(pageUrl)
    if (existing === null && !isVideoHostVideoUrl(pageUrl)) {
      // Not a single video page and no card is waiting for it: the extension
      // falls back to the normal page scan instead of creating a stray session.
      throw new AppError(
        'SCAN_VIDEO_NOT_A_VIDEO_PAGE',
        'This page is not a single video page.'
      )
    }
    if (existing !== null) {
      let upgraded = false
      for (const item of existing.items.values()) {
        if (item.url !== pageUrl) continue
        if (item.kind !== 'page-link' || item.category !== 'video') continue
        const applied = await this.applyVideoMediaSources(existing, item, {
          sources: input.sources,
          title: input.title ?? null,
          thumbnailUrl: null,
          durationSeconds: null,
          referer: pageUrl
        })
        upgraded = upgraded || applied
      }
      if (!upgraded && input.sources.length === 0) {
        for (const item of existing.items.values()) {
          if (item.url !== pageUrl) continue
          item.unavailableReason ??= BROWSER_ONLY_REASON
        }
      }
      this.touch(existing)
      this.publish(existing, true)
      return this.fullSnapshot(existing)
    }

    const session = this.createSession(pageUrl, {
      origin: 'extension',
      ...(input.cookie === undefined ? {} : { cookie: input.cookie })
    })
    session.status = 'done'
    session.started = true
    session.settled = true
    session.message = null
    if (input.title !== undefined) {
      session.title = cleanText(input.title, MAX_SCAN_NAME_LENGTH)
    }

    const id = this.newOpaqueId('item')
    const item: StoredScanItem = {
      id,
      category: 'video',
      kind: 'page-link',
      name: cleanText(input.title ?? hostnameOf(pageUrl), MAX_SCAN_NAME_LENGTH),
      hostname: hostnameOf(pageUrl),
      sizeBytes: null,
      verified: false,
      status: 'browser-only',
      postNumber: null,
      author: null,
      url: pageUrl,
      fallbackUrl: null,
      videoIdentity: videoIdentityForUrl(pageUrl),
      videoAnalysis: null,
      videoMedia: null,
      browserMatchPending: false,
      unavailableReason: BROWSER_ONLY_REASON
    }
    session.items.set(id, item)
    session.order.push(id)

    await this.applyVideoMediaSources(session, item, {
      sources: input.sources,
      title: input.title ?? null,
      thumbnailUrl: null,
      durationSeconds: null,
      referer: pageUrl
    })

    this.touch(session)
    const initial = this.fullSnapshot(session)
    for (const entry of initial.items) {
      session.emitted.set(entry.id, JSON.stringify(entry))
    }
    return initial
  }

  /** The live session that already shows a video card for this exact page. */
  private sessionForVideoPage(pageUrl: string): StoredScanSession | null {
    for (const session of this.sessions.values()) {
      if (session.expiresAt <= this.now()) continue
      for (const item of session.items.values()) {
        if (
          item.url === pageUrl &&
          item.kind === 'page-link' &&
          item.category === 'video'
        ) {
          return session
        }
      }
    }
    return null
  }

  private createSession(
    url: string,
    options: StartScanOptions
  ): StoredScanSession {
    const session: StoredScanSession = {
      id: this.newOpaqueId('scan'),
      origin: options.origin ?? 'paste',
      mode: 'page',
      url,
      hostname: hostnameOf(url),
      title: null,
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
      gofileCookie: null,
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
      limitedMessage: null,
      deadline: this.now() + this.sessionBudgetMs,
      videoAnalyses: 0,
      videoResolving: new Set<string>(),
      otherLinks: 0,
      controller: new AbortController(),
      run: null,
      started: false,
      settled: false,
      waiters: [],
      emitTimer: null,
      lastEmitAt: 0,
      emitted: new Map(),
      removed: new Set()
    }
    this.store(session)
    return session
  }

  /** Start one created session immediately and pump the queue when it ends. */
  private begin(session: StoredScanSession): void {
    if (session.started || this.closed) return
    session.started = true
    session.message = null
    // The queue wait must not consume the per-session time budget.
    session.deadline = this.now() + this.sessionBudgetMs
    const initial = this.fullSnapshot(session)
    for (const item of initial.items) {
      session.emitted.set(item.id, JSON.stringify(item))
    }
    session.run = this.run(session)
      .catch(() => undefined)
      .finally(() => {
        this.settle(session)
        this.pumpQueue()
      })
  }

  private pumpQueue(): void {
    if (this.closed) return
    for (const session of this.sessions.values()) {
      if (this.activeCount() >= this.maxConcurrent) return
      if (session.status !== 'scanning' || session.started) continue
      this.begin(session)
    }
  }

  private settle(session: StoredScanSession): void {
    session.settled = true
    const waiters = session.waiters.splice(0)
    for (const resolve of waiters) resolve()
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
    this.settle(session)
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
      const readyVideo =
        item.category === 'video' &&
        item.kind === 'page-link' &&
        item.status === 'ready' &&
        (item.videoAnalysis !== null || item.videoMedia !== null)
      if (item.category === 'page' || (item.kind === 'page-link' && !readyVideo)) {
        throw new AppError(
          'SCAN_PAGE_NOT_QUEUEABLE',
          'A web page cannot be queued as a file. Choose a file or video item instead.'
        )
      }
      if (
        item.status === 'unavailable' ||
        item.status === 'protected' ||
        item.status === 'tool-unavailable'
      ) {
        throw new AppError(
          'SCAN_ITEM_UNAVAILABLE',
          item.unavailableReason ??
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
        ...(item.fallbackUrl === null ? {} : { fallbackUrl: item.fallbackUrl }),
        postNumber: item.postNumber,
        author: item.author,
        ...(readyVideo && item.videoAnalysis !== null
          ? {
              video: {
                analysisId: item.videoAnalysis.analysisId,
                expiresAt: item.videoAnalysis.expiresAt,
                formats: item.videoAnalysis.formats,
                bestOptionId: item.videoAnalysis.bestOptionId
              }
            }
          : {}),
        ...(readyVideo && item.videoMedia !== null
          ? { media: item.videoMedia }
          : {})
      })
    }
    return targets
  }

  /**
   * Validate explicit funscript pairings against the live session. Every
   * referenced item must be in the caller's selection, every script must belong
   * to the named set, and the video must be a resolved video page link.
   */
  resolveScriptPairings(
    rawSessionId: unknown,
    rawPairings: readonly ScanScriptPairingInput[],
    selectedItemIds: readonly string[],
    options: { allowBrowserOnly?: boolean } = {}
  ): ResolvedScriptPairing[] {
    if (rawPairings.length === 0) return []
    const id = this.requireSessionId(rawSessionId)
    const session = this.requireSession(id)
    if (session.expiresAt <= this.now()) {
      this.deleteSession(id)
      throw new AppError(
        'SCAN_EXPIRED',
        'This scan has expired. Scan the page again.'
      )
    }

    const selected = new Set(selectedItemIds)
    const sources = buildScriptSetSources(this.pairingItems(session))
    const setById = new Map(sources.map((source) => [source.set.id, source.set]))
    const resolved: ResolvedScriptPairing[] = []
    const seenVideos = new Set<string>()
    const seenSets = new Set<string>()
    const claimedScripts = new Set<string>()

    for (const pairing of rawPairings) {
      const video = session.items.get(pairing.videoItemId)
      const readyVideo =
        video !== undefined &&
        video.category === 'video' &&
        video.kind === 'page-link' &&
        video.status === 'ready' &&
        (video.videoAnalysis !== null || video.videoMedia !== null)
      const browserOnlyVideo =
        video !== undefined &&
        options.allowBrowserOnly === true &&
        video.category === 'video' &&
        video.kind === 'page-link' &&
        video.status === 'browser-only'
      if (!video || (!readyVideo && !browserOnlyVideo)) {
        throw new AppError(
          'SCAN_PAIRING_INVALID',
          options.allowBrowserOnly === true
            ? 'A paired video is not a browser-only or resolved video in this scan.'
            : 'A paired video is not a resolved video in this scan.'
        )
      }
      if (!selected.has(pairing.videoItemId)) {
        throw new AppError(
          'SCAN_PAIRING_INVALID',
          'A paired video is not part of the selected items.'
        )
      }
      if (seenVideos.has(pairing.videoItemId)) {
        throw new AppError(
          'SCAN_PAIRING_INVALID',
          'The same video cannot be paired twice.'
        )
      }
      seenVideos.add(pairing.videoItemId)

      if (seenSets.has(pairing.setId)) {
        throw new AppError(
          'SCAN_PAIRING_INVALID',
          'The same script set cannot be paired twice.'
        )
      }
      seenSets.add(pairing.setId)

      const set = setById.get(pairing.setId)
      if (!set) {
        throw new AppError(
          'SCAN_PAIRING_INVALID',
          'That script set does not belong to this scan.'
        )
      }
      const setFiles = new Map(
        set.files.map((file) => [file.fileId, file])
      )
      const primaryVariant =
        pairing.primaryVariant === null
          ? null
          : pairing.primaryVariant.trim().toLowerCase() || null
      if (
        primaryVariant !== null &&
        !set.variants.some(
          (variant) => variant.toLowerCase() === primaryVariant
        )
      ) {
        throw new AppError(
          'SCAN_PAIRING_INVALID',
          'That script version does not belong to the paired set.'
        )
      }

      const scripts: ResolvedScriptPairing['scripts'] = []
      for (const scriptItemId of pairing.scriptItemIds) {
        const file = setFiles.get(scriptItemId)
        if (!file) {
          throw new AppError(
            'SCAN_PAIRING_INVALID',
            'A paired script does not belong to the chosen set.'
          )
        }
        if (!selected.has(scriptItemId)) {
          throw new AppError(
            'SCAN_PAIRING_INVALID',
            'A paired script is not part of the selected items.'
          )
        }
        const item = session.items.get(scriptItemId)
        if (
          !item ||
          item.category !== 'script' ||
          item.kind !== 'file' ||
          item.status === 'unavailable' ||
          item.status === 'protected'
        ) {
          throw new AppError(
            'SCAN_PAIRING_INVALID',
            'A paired script is not downloadable in this scan.'
          )
        }
        if (claimedScripts.has(scriptItemId)) {
          throw new AppError(
            'SCAN_PAIRING_INVALID',
            'A script cannot belong to two pairings.'
          )
        }
        claimedScripts.add(scriptItemId)
        scripts.push({
          itemId: scriptItemId,
          filename: file.filename,
          axis: file.axis,
          variant: file.variant
        })
      }
      if (scripts.length === 0) {
        throw new AppError(
          'SCAN_PAIRING_INVALID',
          'A script pairing must include at least one script.'
        )
      }

      resolved.push({
        videoItemId: pairing.videoItemId,
        setId: pairing.setId,
        scriptItemIds: [...pairing.scriptItemIds],
        primaryVariant,
        rename: pairing.rename,
        scripts
      })
    }

    return resolved
  }

  /**
   * Validate that a card may be opened in the user's browser and return the
   * internal URL. A browser-only video page link and a Gofile share card both
   * qualify: neither can be resolved without the user's own browser session.
   */
  openInBrowser(
    rawSessionId: unknown,
    rawItemId: unknown
  ): { url: string; pageUrl: string } {
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
    if (typeof rawItemId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(rawItemId)) {
      throw new ValidationError('Invalid scan item identifier.')
    }
    const item = session.items.get(rawItemId)
    const gofileShare =
      item === undefined ? null : gofileShareOf(item.url)
    const openable =
      item !== undefined &&
      item.status === 'browser-only' &&
      (gofileShare !== null ||
        (item.category === 'video' && item.kind === 'page-link'))
    if (!openable) {
      throw new AppError(
        'SCAN_ITEM_NOT_BROWSER_ONLY',
        'Only a card that needs your browser can be opened this way.'
      )
    }
    let pageUrl: string
    try {
      pageUrl =
        gofileShare === null ? normalizeScanUrl(item.url) : gofileShare.canonicalUrl
    } catch {
      throw new AppError('SCAN_ITEM_INVALID', 'That link is not valid.')
    }
    return { url: gofileShare === null ? item.url : gofileShare.canonicalUrl, pageUrl }
  }

  /**
   * Explicitly re-check a listed page link as a video page. The renderer sends
   * only opaque IDs; the stored URL is validated against the public-target
   * policy and resolved through the same bounded media analyzer as a scan.
   * This never queues a download.
   */
  async markAsVideo(
    rawSessionId: unknown,
    rawItemId: unknown
  ): Promise<ScanSession> {
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
    if (
      typeof rawItemId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(rawItemId)
    ) {
      throw new ValidationError('Invalid scan item identifier.')
    }
    const item = session.items.get(rawItemId)
    if (!item) {
      throw new AppError(
        'SCAN_ITEM_NOT_FOUND',
        'That link does not belong to this scan.'
      )
    }
    // Idempotent: an already converted card is never analysed again.
    if (item.kind === 'page-link' && item.category === 'video') {
      return this.fullSnapshot(session)
    }
    if (item.kind !== 'page-link') {
      throw new AppError(
        'SCAN_ITEM_NOT_A_LINK',
        'Only a link on the page can be marked as a video.'
      )
    }
    if (item.status !== 'found' && item.status !== 'probing') {
      throw new AppError(
        'SCAN_ITEM_NOT_MARKABLE',
        'That link cannot be checked as a video any more.'
      )
    }
    if (session.videoResolving.has(item.id)) {
      return this.fullSnapshot(session)
    }

    session.videoResolving.add(item.id)
    try {
      try {
        await assertPublicTarget(item.url, this.lookup)
      } catch {
        throw new AppError(
          'SCAN_TARGET_NOT_PUBLIC',
          'Only public web pages can be checked as videos.'
        )
      }
      if (this.analyzeMedia === undefined) {
        throw new AppError(
          'SCAN_VIDEO_UNAVAILABLE',
          'Checking video pages is not available.'
        )
      }
      if (session.videoAnalyses >= this.videoCap) {
        throw new AppError(
          'SCAN_VIDEO_LIMIT',
          `This scan already checked the maximum of ${this.videoCap} videos.`
        )
      }

      const current = session.items.get(item.id)
      if (!current) {
        throw new AppError(
          'SCAN_ITEM_NOT_FOUND',
          'That link does not belong to this scan.'
        )
      }
      current.category = 'video'
      current.kind = 'page-link'
      current.status = 'probing'
      current.verified = false
      current.sizeBytes = null
      current.sizeIsEstimate = false
      current.thumbnailUrl = null
      current.durationSeconds = null
      current.width = null
      current.height = null
      current.bestResolution = null
      current.formats = []
      current.bestOptionId = null
      current.unavailableReason = null
      current.videoAnalysis = null
      current.videoMedia = null
      current.videoIdentity ??= videoIdentityForUrl(current.url)
      session.videoAnalyses += 1
      this.touch(session)
      this.publish(session, true)

      await resolveVideoCandidates(
        [{ url: current.url, fallbackName: current.name }],
        {
          analyze: async (url, analyzeOptions) => {
            if (this.now() >= session.deadline) {
              session.limited = true
              session.limitedMessage ??=
                'The scan reached its time limit before every video could be resolved.'
              throw new AppError(
                'MEDIA_ANALYSIS_TIMEOUT',
                'The site took too long to analyze.'
              )
            }
            return this.analyzeMedia!(url, analyzeOptions)
          },
          cookieHost: session.cookieHost,
          cookie: session.cookie,
          signal: session.controller.signal,
          cap: 1,
          onResult: (_index, resolution) => {
            const live = session.items.get(current.id)
            if (!live) return
            this.applyVideoResolution(session, live, resolution)
          }
        }
      )

      // The explicit "check as video" path gets the same page fallback as a
      // scan, so a page yt-dlp cannot read still becomes a real download.
      const live = session.items.get(current.id)
      if (live && live.status === 'browser-only') {
        await this.applyPageFallback(session, live)
      }

      this.touch(session)
      this.publish(session, true)
      return this.fullSnapshot(session)
    } finally {
      session.videoResolving.delete(item.id)
    }
  }

  /**
   * Remember a chosen script pairing for a browser-only page. The extension
   * hand-off consumes it once when the same normalized page URL is detected.
   */
  armBrowserMatch(
    rawSessionId: unknown,
    rawItemId: unknown,
    pairing: ScanScriptPairingInput
  ): { pageUrl: string } {
    const opened = this.openInBrowser(rawSessionId, rawItemId)
    const session = this.requireSession(String(rawSessionId))
    const video = session.items.get(String(rawItemId))
    if (!video) {
      throw new AppError('SCAN_ITEM_NOT_FOUND', 'That video is not in this scan.')
    }
    const resolved = this.resolveScriptPairings(
      rawSessionId,
      [pairing],
      [video.id, ...pairing.scriptItemIds],
      { allowBrowserOnly: true }
    )
    const match = resolved[0]
    if (!match) {
      throw new AppError(
        'SCAN_PAIRING_INVALID',
        'That script pairing is not valid for this scan.'
      )
    }
    const scripts: BrowserPairingScript[] = []
    for (const script of match.scripts) {
      const item = session.items.get(script.itemId)
      if (!item) continue
      const cookie = this.cookieFor(session, item.url)
      scripts.push({
        itemId: script.itemId,
        url: item.url,
        filename: script.filename,
        axis: script.axis,
        variant: script.variant,
        ...(cookie === null ? {} : { cookie })
      })
    }
    if (scripts.length === 0) {
      throw new AppError(
        'SCAN_PAIRING_INVALID',
        'That script pairing has no downloadable scripts.'
      )
    }

    this.pruneBrowserPairings()
    this.browserPairings.set(opened.pageUrl, {
      pageUrl: opened.pageUrl,
      origin: new URL(opened.pageUrl).origin,
      sessionId: session.id,
      videoItemId: video.id,
      setId: match.setId,
      scriptItemIds: [...match.scriptItemIds],
      primaryVariant: match.primaryVariant,
      rename: match.rename,
      videoTitle: video.name,
      scripts,
      expiresAt: this.now() + BROWSER_MATCH_TTL_MS
    })
    video.browserMatchPending = true
    this.touch(session)
    this.publish(session, true)
    return { pageUrl: opened.pageUrl }
  }

  /**
   * Consume a pending browser pairing by exact normalized page URL. Returns
   * null when nothing matches (the normal hand-off path then stays unchanged).
   */
  consumeBrowserMatch(rawPageUrl: unknown): PendingBrowserPairing | null {
    if (typeof rawPageUrl !== 'string') return null
    let pageUrl: string
    try {
      pageUrl = normalizeScanUrl(rawPageUrl)
    } catch {
      return null
    }
    this.pruneBrowserPairings()
    const pending = this.browserPairings.get(pageUrl)
    if (!pending) return null
    try {
      if (new URL(pageUrl).origin !== pending.origin) return null
    } catch {
      return null
    }
    this.browserPairings.delete(pageUrl)
    const session = this.sessions.get(pending.sessionId)
    const item = session?.items.get(pending.videoItemId)
    if (item) {
      item.browserMatchPending = false
      if (session) {
        this.touch(session)
        this.publish(session, true)
      }
    }
    return pending
  }

  private pruneBrowserPairings(): void {
    const current = this.now()
    for (const [key, pending] of this.browserPairings) {
      if (pending.expiresAt > current) continue
      this.browserPairings.delete(key)
      const session = this.sessions.get(pending.sessionId)
      const item = session?.items.get(pending.videoItemId)
      if (item) item.browserMatchPending = false
    }
  }

  /**
   * Validate a manual "Match to video file…" script pick without any video
   * item. Used when the user starts from a script-set row as well as from a
   * browser-only card.
   */
  resolveManualScripts(
    rawSessionId: unknown,
    input: {
      setId: string
      scriptItemIds: readonly string[]
      primaryVariant: string | null
      rename: boolean
    }
  ): {
    setId: string
    base: string
    primaryVariant: string | null
    rename: boolean
    scripts: BrowserPairingScript[]
  } {
    const id = this.requireSessionId(rawSessionId)
    const session = this.requireSession(id)
    if (session.expiresAt <= this.now()) {
      this.deleteSession(id)
      throw new AppError(
        'SCAN_EXPIRED',
        'This scan has expired. Scan the page again.'
      )
    }
    const sources = buildScriptSetSources(this.pairingItems(session))
    const source = sources.find((entry) => entry.set.id === input.setId)
    if (!source) {
      throw new AppError(
        'SCAN_PAIRING_INVALID',
        'That script set does not belong to this scan.'
      )
    }
    const primaryVariant =
      input.primaryVariant === null
        ? null
        : input.primaryVariant.trim().toLowerCase() || null
    if (
      primaryVariant !== null &&
      !source.set.variants.some(
        (variant) => variant.toLowerCase() === primaryVariant
      )
    ) {
      throw new AppError(
        'SCAN_PAIRING_INVALID',
        'That script version does not belong to the chosen set.'
      )
    }
    const files = new Map(source.set.files.map((file) => [file.fileId, file]))
    const claimed = new Set<string>()
    const scripts: BrowserPairingScript[] = []
    for (const scriptItemId of input.scriptItemIds) {
      const file = files.get(scriptItemId)
      if (!file) {
        throw new AppError(
          'SCAN_PAIRING_INVALID',
          'A paired script does not belong to the chosen set.'
        )
      }
      if (claimed.has(scriptItemId)) {
        throw new AppError(
          'SCAN_PAIRING_INVALID',
          'A script cannot be chosen twice.'
        )
      }
      claimed.add(scriptItemId)
      const item = session.items.get(scriptItemId)
      if (
        !item ||
        item.category !== 'script' ||
        item.kind !== 'file' ||
        item.status === 'unavailable' ||
        item.status === 'protected'
      ) {
        throw new AppError(
          'SCAN_PAIRING_INVALID',
          'A paired script is not downloadable in this scan.'
        )
      }
      const cookie = this.cookieFor(session, item.url)
      scripts.push({
        itemId: scriptItemId,
        url: item.url,
        filename: file.filename,
        axis: file.axis,
        variant: file.variant,
        ...(cookie === null ? {} : { cookie })
      })
    }
    if (scripts.length === 0) {
      throw new AppError(
        'SCAN_PAIRING_INVALID',
        'A script pairing must include at least one script.'
      )
    }
    return {
      setId: source.set.id,
      base: source.set.base,
      primaryVariant,
      rename: input.rename,
      scripts
    }
  }

  /** Current script sets, recomputed from the live session items. */
  private scriptSetsFor(session: StoredScanSession): ScanScriptSet[] {
    return buildScanScriptSets(this.pairingItems(session))
  }

  private pairingItems(session: StoredScanSession): PairingScanItem[] {
    return session.order
      .map((id) => session.items.get(id))
      .filter((item): item is StoredScanItem => item !== undefined)
      .map((item) => ({
        id: item.id,
        name: item.name,
        category: item.category,
        kind: item.kind,
        postNumber: item.postNumber,
        status: item.status
      }))
  }

  /** Read-only snapshot for tests and focused orchestration. */
  getSession(rawSessionId: unknown): ScanSession {
    return this.fullSnapshot(this.requireSession(this.requireSessionId(rawSessionId)))
  }

  /** Resolves when the current scan run has settled. */
  async waitForScan(rawSessionId: unknown): Promise<void> {
    const session = this.requireSession(this.requireSessionId(rawSessionId))
    if (session.settled) return
    if (session.started && session.run !== null) {
      await session.run
      return
    }
    await new Promise<void>((resolve) => session.waiters.push(resolve))
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
      this.settle(session)
    }
    this.sessions.clear()
    this.browserPairings.clear()
  }

  private async run(session: StoredScanSession): Promise<void> {
    try {
      // A public MEGA link is the whole scan. The page behind it is a
      // JavaScript application with no discoverable links, so the link itself
      // becomes the single seed candidate and nothing is fetched.
      if (megaTargetOf(session.url) !== null) {
        this.addCandidate(session, {
          url: session.url,
          nameHint: null,
          downloadAttribute: false,
          isAttachment: false,
          fromScript: false,
          isEmbed: false,
          source: 'anchor'
        })
        session.updatedAt = this.now()
        this.publish(session, true)
      } else {
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

        const discourse = await this.tryDiscourse(session, page)
        const candidates: ScanCandidate[] =
          discourse?.candidates ??
          extractCandidates(page.body, page.finalUrl).map((candidate) => ({
            ...candidate,
            postNumber: null,
            author: null
          }))

        for (const candidate of candidates) {
          if (this.addCandidate(session, candidate) === 'limited') break
        }
        this.addOtherLinks(
          session,
          discourse === null
            ? this.contentPageLinks(session, page.body, page.finalUrl)
            : discourse.pageLinks
        )

        session.updatedAt = this.now()
        this.publish(session, true)

        if (session.controller.signal.aborted) return
        await this.followVideoPages(session, page)
        if (session.controller.signal.aborted) return
      }

      session.message =
        session.items.size === 0
          ? 'No downloadable content was found on that page.'
          : null

      await this.resolveMegaItems(session)
      if (session.controller.signal.aborted) return

      await this.resolvePixeldrainItems(session)
      if (session.controller.signal.aborted) return

      await this.probeItems(session)
      if (session.controller.signal.aborted) return

      await this.resolveVideoItems(session)
      if (session.controller.signal.aborted) return

      if (this.now() >= session.deadline) {
        session.limited = true
        session.limitedMessage ??=
          'The scan reached its time limit. Narrow the page selection and scan again.'
      }

      session.status =
        session.limited || session.items.size >= MAX_SCAN_ITEMS
          ? 'limited'
          : 'done'
      if (session.status === 'limited') {
        session.message = safeMessage(
          session.limitedMessage ??
            (session.items.size >= MAX_SCAN_ITEMS
              ? `The scan reached the ${MAX_SCAN_ITEMS}-item limit. Narrow the page selection.`
              : 'The scan reached a safety limit. Narrow the page selection.')
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
  ): Promise<{
    candidates: TaggedCandidate[]
    pageLinks: DiscoursePageLink[]
  } | null> {
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
      if (result.title !== null) {
        const title = safeTitleMessage(result.title)
        if (title !== null) {
          if (session.title === null) session.title = title
          if (session.message === null) session.message = title
        }
      }
      if (result.limited) session.limited = true
      return {
        candidates: result.candidates,
        pageLinks: result.pageLinks
      }
    } catch (error) {
      // A path-shaped URL on a non-Discourse site is a false positive. Only a
      // confirmed generator tag turns a failed API read into a needed login.
      if (hasDiscourseGenerator(page.body)) throw error
      return null
    }
  }

  /**
   * Plain page links in the scanned page's own content. Only the first
   * `MAX_SCAN_OTHER_LINKS` are kept and forum navigation on the scanned host is
   * skipped; a link elsewhere is ordinary content.
   */
  private contentPageLinks(
    session: StoredScanSession,
    html: string,
    pageUrl: string
  ): DiscoursePageLink[] {
    const links: DiscoursePageLink[] = []
    const current = (() => {
      try {
        return normalizeScanUrl(pageUrl)
      } catch {
        return pageUrl
      }
    })()
    for (const link of extractFollowCandidates(html, pageUrl)) {
      if (links.length >= MAX_SCAN_OTHER_LINKS) break
      if (link.isEmbed) continue
      let normalized: string
      try {
        normalized = normalizeScanUrl(link.url)
      } catch {
        continue
      }
      if (normalized === current) continue
      if (isForumNavigationUrl(normalized, session.hostname)) continue
      try {
        if (new URL(normalized).pathname === '/') continue
      } catch {
        continue
      }
      links.push({
        url: normalized,
        nameHint: link.nameHint,
        postNumber: null,
        author: null
      })
    }
    return links
  }

  /** Add page links without ever treating them as downloadable files. */
  private addOtherLinks(
    session: StoredScanSession,
    links: readonly DiscoursePageLink[]
  ): void {
    for (const link of links) {
      if (session.otherLinks >= MAX_SCAN_OTHER_LINKS) break
      const status = this.addCandidate(session, {
        url: link.url,
        nameHint: link.nameHint,
        downloadAttribute: false,
        isAttachment: false,
        fromScript: false,
        isEmbed: false,
        source: 'anchor',
        postNumber: link.postNumber,
        author: link.author
      })
      if (status === 'limited') break
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
    const identity = videoIdentityForUrl(normalized)
    for (const item of session.items.values()) {
      if (
        item.url === normalized ||
        (identity !== null && item.videoIdentity === identity)
      ) {
        if (
          item.postNumber === null &&
          typeof candidate.postNumber === 'number'
        ) {
          item.postNumber = candidate.postNumber
          item.author = candidate.author ?? null
        }
        if (
          candidate.videoHint === true &&
          item.kind === 'page-link' &&
          item.category === 'page'
        ) {
          item.category = 'video'
          if (item.videoIdentity === null) item.videoIdentity = identity
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
    const category: ScanCategory =
      candidate.videoHint === true && classification.kind === 'page-link'
        ? 'video'
        : classification.category
    // A Gofile share is a JavaScript application behind the user's own sign-in.
    // It is never fetched, probed or queued: the card only offers the browser,
    // and the extension later reports the rows that tab rendered.
    const gofileShare = gofileShareOf(normalized)
    const id = this.newOpaqueId('item')
    const item: StoredScanItem = {
      id,
      category: gofileShare === null ? category : 'other',
      kind: gofileShare === null ? classification.kind : 'page-link',
      name: cleanText(classification.name, MAX_SCAN_NAME_LENGTH),
      hostname: hostnameOf(normalized),
      sizeBytes: null,
      verified: false,
      status: gofileShare === null ? 'found' : 'browser-only',
      postNumber:
        typeof candidate.postNumber === 'number' ? candidate.postNumber : null,
      author:
        typeof candidate.author === 'string'
          ? cleanText(candidate.author, MAX_SCAN_AUTHOR_LENGTH)
          : null,
      url: normalized,
      fallbackUrl: null,
      videoIdentity: identity,
      videoAnalysis: null,
      videoMedia: null,
      browserMatchPending: false,
      ...(gofileShare === null
        ? {}
        : { unavailableReason: GOFILE_BROWSER_ONLY_REASON })
    }
    session.items.set(id, item)
    session.order.push(id)
    if (item.category === 'page' && item.kind === 'page-link') {
      session.otherLinks += 1
    }
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

  /**
   * Resolve discovered Pixeldrain links through the public metadata adapter so
   * a `/u/<id>` card gets its real name, size and category, and a `/l/<id>`
   * list becomes one card per file. Requests are deduped by provider ID,
   * capped per session and run with bounded concurrency. A provider failure
   * only marks the affected card; the scan itself keeps going.
   */
  private async resolvePixeldrainItems(
    session: StoredScanSession
  ): Promise<void> {
    if (this.pixeldrain === undefined) return

    const targets: ScanPixeldrainTarget[] = []
    const seen = new Set<string>()
    for (const id of session.order) {
      const item = session.items.get(id)
      if (!item || item.status !== 'found') continue
      const link = pixeldrainLinkOf(item.url)
      if (link === null) continue
      const key = `${link.kind}:${link.id}`
      if (seen.has(key)) continue
      seen.add(key)
      targets.push({ kind: link.kind, id: link.id, url: link.sourceUrl })
    }
    if (targets.length === 0) return

    const selected = targets.slice(0, MAX_SCAN_PIXELDRAIN_REQUESTS)
    for (const target of selected) {
      for (const item of this.pixeldrainItems(session, target.kind, target.id)) {
        item.status = 'probing'
      }
    }
    this.touch(session)
    this.publish(session, true)

    await resolvePixeldrainTargets(selected, {
      port: this.pixeldrain,
      signal: session.controller.signal,
      shouldStop: () => this.now() >= session.deadline,
      onResult: (_index, outcome) => {
        this.applyPixeldrainOutcome(session, outcome)
        this.touch(session)
        this.scheduleEmit(session)
      }
    })

    // A cancelled or timed-out request leaves its card unresolved instead of
    // spinning forever.
    for (const target of selected) {
      for (const item of this.pixeldrainItems(session, target.kind, target.id)) {
        if (item.status === 'probing') item.status = 'found'
      }
    }
    this.touch(session)
    this.publish(session, true)
  }

  /**
   * Resolve discovered MEGA links through the public adapter so a file card gets
   * its real name and size, and a folder becomes one card per file. Requests are
   * deduped by provider ID, capped per session and run with bounded concurrency.
   * A provider failure only marks the affected card; the scan itself keeps
   * going. The decryption key never leaves this method's input.
   */
  private async resolveMegaItems(session: StoredScanSession): Promise<void> {
    if (this.mega === undefined) return

    const targets: ScanMegaTarget[] = []
    const seen = new Set<string>()
    for (const id of session.order) {
      const item = session.items.get(id)
      if (!item || item.status !== 'found') continue
      const target = megaTargetOf(item.url)
      if (target === null) continue
      const key = `${target.kind}:${target.id}`
      if (seen.has(key)) continue
      seen.add(key)
      targets.push(target)
    }
    if (targets.length === 0) return

    const selected = targets.slice(0, MAX_SCAN_MEGA_REQUESTS)
    for (const target of selected) {
      for (const item of this.megaItems(session, target.kind, target.id)) {
        item.status = 'probing'
      }
    }
    this.touch(session)
    this.publish(session, true)

    await resolveMegaTargets(selected, {
      port: this.mega,
      signal: session.controller.signal,
      shouldStop: () => this.now() >= session.deadline,
      onResult: (_index, outcome) => {
        this.applyMegaOutcome(session, outcome)
        this.touch(session)
        this.scheduleEmit(session)
      }
    })

    // A cancelled or timed-out request leaves its card unresolved instead of
    // spinning forever.
    for (const target of selected) {
      for (const item of this.megaItems(session, target.kind, target.id)) {
        if (item.status === 'probing') item.status = 'found'
      }
    }
    this.touch(session)
    this.publish(session, true)
  }

  /** Every item that still points at one MEGA scan target. */
  private megaItems(
    session: StoredScanSession,
    kind: 'file' | 'folder',
    id: string
  ): StoredScanItem[] {
    const matches: StoredScanItem[] = []
    for (const item of session.items.values()) {
      const target = megaTargetOf(item.url)
      if (target !== null && target.kind === kind && target.id === id) {
        matches.push(item)
      }
    }
    return matches
  }

  private applyMegaOutcome(
    session: StoredScanSession,
    outcome: ScanMegaOutcome
  ): void {
    if (outcome.type === 'error') {
      for (const item of this.megaItems(session, outcome.kind, outcome.id)) {
        item.status = 'unavailable'
        item.verified = false
        item.unavailableReason = outcome.reason
      }
      return
    }
    if (outcome.type === 'file') {
      this.applyMegaFile(session, outcome.id, outcome.resolution)
      return
    }
    this.expandMegaFolder(session, outcome.resolution)
  }

  private applyMegaFile(
    session: StoredScanSession,
    id: string,
    resolution: MegaFileResolution
  ): void {
    const items = this.megaItems(session, 'file', id)
    for (const item of items) {
      // MEGA does not publish a content type, so the resolved name's extension
      // is what turns a card into a video, a script or an archive.
      this.applyResolvedFile(item, {
        name: resolution.name,
        size: resolution.size,
        mimeType: null
      })
    }
    this.mergeResolvedItems(session, items)
  }

  /**
   * Replace a folder card with one card per file. The folder's post number and
   * author are inherited so per-post funscript pairing still works, and a file
   * that was already found as its own link is upgraded in place instead of
   * being listed twice.
   */
  private expandMegaFolder(
    session: StoredScanSession,
    resolution: MegaFolderResolution
  ): void {
    const folderItems = this.megaItems(session, 'folder', resolution.folderId)
    const postNumber =
      folderItems.find((item) => item.postNumber !== null)?.postNumber ?? null
    const author = folderItems.find((item) => item.author !== null)?.author ?? null
    let expanded = 0
    let limited = false

    for (const entry of resolution.entries.slice(0, MAX_MEGA_FOLDER_ENTRIES)) {
      if (
        entry.availability !== 'available' ||
        entry.nodeId === null ||
        entry.sourceUrl === null
      ) {
        continue
      }
      const targetId = `${resolution.folderId}/${entry.nodeId}`
      const existing = this.megaItems(session, 'file', targetId)
      if (existing.length > 0) {
        for (const item of existing) {
          this.applyResolvedFile(item, {
            name: entry.name,
            size: entry.size,
            mimeType: null
          })
        }
        this.mergeResolvedItems(session, existing)
        expanded += 1
        continue
      }
      if (session.items.size >= MAX_SCAN_ITEMS) {
        limited = true
        break
      }
      const added = this.addResolvedFileItem(session, {
        url: entry.sourceUrl,
        name: entry.name,
        size: entry.size,
        mimeType: null,
        postNumber,
        author
      })
      if (added !== null) expanded += 1
    }

    if (limited) {
      session.limited = true
      session.limitedMessage ??= `The scan reached the ${MAX_SCAN_ITEMS}-item limit. Narrow the page selection.`
    }
    if (expanded === 0) {
      for (const item of folderItems) {
        item.status = 'unavailable'
        item.unavailableReason = 'This MEGA folder has no downloadable files.'
      }
      return
    }
    // The folder page itself is not downloadable; its files replace it.
    for (const item of folderItems) this.removeItem(session, item.id)
  }

  /** Every item that still points at one provider ID. */
  private pixeldrainItems(
    session: StoredScanSession,
    kind: 'file' | 'list',
    id: string
  ): StoredScanItem[] {
    const matches: StoredScanItem[] = []
    for (const item of session.items.values()) {
      const link = pixeldrainLinkOf(item.url)
      if (link !== null && link.kind === kind && link.id === id) {
        matches.push(item)
      }
    }
    return matches
  }

  private applyPixeldrainOutcome(
    session: StoredScanSession,
    outcome: ScanPixeldrainOutcome
  ): void {
    if (outcome.type === 'error') {
      for (const item of this.pixeldrainItems(session, outcome.kind, outcome.id)) {
        item.status = 'unavailable'
        item.verified = false
        item.unavailableReason = outcome.reason
      }
      return
    }
    if (outcome.type === 'file') {
      this.applyPixeldrainFile(session, outcome.resolution)
      return
    }
    this.expandPixeldrainList(session, outcome.resolution)
  }

  private applyPixeldrainFile(
    session: StoredScanSession,
    resolution: PixeldrainFileResolution
  ): void {
    const items = this.pixeldrainItems(session, 'file', resolution.fileId)
    for (const item of items) {
      this.applyResolvedFile(item, {
        name: resolution.name,
        size: resolution.size,
        mimeType: resolution.mimeType
      })
    }
    this.mergeResolvedItems(session, items)
  }

  /**
   * Collapse several cards that point at the same provider file (for example a
   * `/u/<id>` link and the same file inside a list) into the first one, keeping
   * any post context the kept card was missing.
   */
  private mergeResolvedItems(
    session: StoredScanSession,
    items: readonly StoredScanItem[]
  ): void {
    const keep = items[0]
    if (keep === undefined) return
    for (const duplicate of items.slice(1)) {
      if (keep.postNumber === null && duplicate.postNumber !== null) {
        keep.postNumber = duplicate.postNumber
        keep.author = duplicate.author
      }
      this.removeItem(session, duplicate.id)
    }
  }

  /**
   * Apply provider metadata to one card. The classification helpers are reused
   * with the resolved name and content type, so a `.funscript` becomes a script
   * and a video becomes a video exactly like a normal direct file.
   */
  private applyResolvedFile(
    item: StoredScanItem,
    resolved: { name: string; size: number | null; mimeType: string | null }
  ): void {
    const classification = classifyScanCandidate({
      url: item.url,
      nameHint: resolved.name,
      ...(resolved.mimeType === null ? {} : { contentType: resolved.mimeType })
    })
    item.category = classification.category
    item.kind = classification.kind
    item.name = cleanText(classification.name, MAX_SCAN_NAME_LENGTH)
    item.sizeBytes = resolved.size
    item.verified = classification.kind === 'file'
    item.status = classification.kind === 'file' ? 'ready' : 'found'
    item.unavailableReason = null
  }

  /**
   * Replace a list card with one card per available file. The list's post
   * number and author are inherited so per-post funscript pairing still works,
   * and a file that was already found as a `/u/` link is upgraded in place
   * instead of being listed twice.
   */
  private expandPixeldrainList(
    session: StoredScanSession,
    resolution: PixeldrainListResolution
  ): void {
    const listItems = this.pixeldrainItems(session, 'list', resolution.listId)
    const postNumber =
      listItems.find((item) => item.postNumber !== null)?.postNumber ?? null
    const author = listItems.find((item) => item.author !== null)?.author ?? null
    let expanded = 0
    let limited = false

    for (const entry of resolution.entries.slice(0, MAX_PIXELDRAIN_LIST_FILES)) {
      if (
        entry.availability !== 'available' ||
        entry.fileId === null ||
        entry.sourceUrl === null
      ) {
        continue
      }
      const existing = this.pixeldrainItems(session, 'file', entry.fileId)
      if (existing.length > 0) {
        for (const item of existing) {
          this.applyResolvedFile(item, entry)
        }
        this.mergeResolvedItems(session, existing)
        expanded += 1
        continue
      }
      if (session.items.size >= MAX_SCAN_ITEMS) {
        limited = true
        break
      }
      const added = this.addResolvedFileItem(session, {
        url: entry.sourceUrl,
        name: entry.name,
        size: entry.size,
        mimeType: entry.mimeType,
        postNumber,
        author
      })
      if (added !== null) expanded += 1
    }

    if (limited) {
      session.limited = true
      session.limitedMessage ??= `The scan reached the ${MAX_SCAN_ITEMS}-item limit. Narrow the page selection.`
    }
    if (expanded === 0) {
      for (const item of listItems) {
        item.status = 'unavailable'
        item.unavailableReason =
          'This Pixeldrain list has no downloadable files.'
      }
      return
    }
    // The list page itself is not downloadable; its files replace it.
    for (const item of listItems) this.removeItem(session, item.id)
  }

  private addResolvedFileItem(
    session: StoredScanSession,
    input: {
      url: string
      name: string
      size: number | null
      mimeType: string | null
      postNumber: number | null
      author: string | null
    }
  ): StoredScanItem | null {
    let normalized: string
    try {
      normalized = normalizeScanUrl(input.url)
    } catch {
      return null
    }
    const classification = classifyScanCandidate({
      url: normalized,
      nameHint: input.name,
      ...(input.mimeType === null ? {} : { contentType: input.mimeType })
    })
    const id = this.newOpaqueId('item')
    const item: StoredScanItem = {
      id,
      category: classification.category,
      kind: classification.kind,
      name: cleanText(classification.name, MAX_SCAN_NAME_LENGTH),
      hostname: hostnameOf(normalized),
      sizeBytes: input.size,
      verified: classification.kind === 'file',
      status: classification.kind === 'file' ? 'ready' : 'found',
      postNumber: input.postNumber,
      author: input.author,
      url: normalized,
      fallbackUrl: null,
      videoIdentity: videoIdentityForUrl(normalized),
      videoAnalysis: null,
      videoMedia: null,
      browserMatchPending: false
    }
    session.items.set(id, item)
    session.order.push(id)
    return item
  }

  private removeItem(session: StoredScanSession, itemId: string): void {
    const item = session.items.get(itemId)
    if (item === undefined) return
    session.items.delete(itemId)
    session.order = session.order.filter((id) => id !== itemId)
    if (item.category === 'page' && item.kind === 'page-link') {
      session.otherLinks = Math.max(0, session.otherLinks - 1)
    }
    session.removed.add(itemId)
  }

  /**
   * Follow a bounded number of video-looking pages one or two levels deep.
   * Robots.txt is honoured for every page the scanner follows itself; the
   * user's pasted URL was already fetched before this point.
   */
  private async followVideoPages(
    session: StoredScanSession,
    initial: ScanFetchResult
  ): Promise<void> {
    if (this.followDepth === 0) return

    const visited = new Set<string>()
    try {
      visited.add(normalizeScanUrl(initial.finalUrl))
    } catch {
      visited.add(initial.finalUrl)
    }

    interface PendingFollow {
      url: string
      depth: number
      score: number
      nameHint: string | null
      isEmbed: boolean
      videoHint: boolean
    }
    const pending: PendingFollow[] = []
    const knownIdentity = (url: string): boolean => {
      const identity = videoIdentityForUrl(url)
      if (identity === null) return false
      for (const item of session.items.values()) {
        if (item.videoIdentity === identity) return true
      }
      return false
    }
    const enqueue = (html: string, pageUrl: string, depth: number): void => {
      if (depth > this.followDepth) return
      for (const candidate of extractFollowCandidates(html, pageUrl)) {
        let normalized: string
        try {
          normalized = normalizeScanUrl(candidate.url)
        } catch {
          continue
        }
        if (visited.has(normalized) || knownIdentity(normalized)) continue
        const decision = scoreFollowLink({
          url: normalized,
          baseUrl: pageUrl,
          forumHost: session.hostname,
          isEmbed: candidate.isEmbed,
          rel: candidate.rel,
          text: candidate.text
        })
        if (decision === null) continue
        visited.add(normalized)
        pending.push({
          url: normalized,
          depth,
          score: decision.score,
          nameHint: candidate.nameHint,
          isEmbed: candidate.isEmbed,
          // A followed video path/embed is itself a video page link, even on a
          // host that phase 1 would otherwise classify as a generic page.
          videoHint: decision.reason !== 'video-text'
        })
      }
    }

    enqueue(initial.body, initial.finalUrl, 1)
    const robots = new ScanRobotsCache({
      fetchRobots: async (url, signal) => {
        try {
          const response = await this.fetchPage(
            {
              url,
              maxBytes: 64 * 1024,
              signal
            },
            this.lookup === undefined ? {} : { lookup: this.lookup }
          )
          return response.body
        } catch {
          return null
        }
      }
    })

    const signal = session.controller.signal
    while (pending.length > 0) {
      if (signal.aborted) return
      if (this.now() >= session.deadline) {
        session.limited = true
        session.limitedMessage ??=
          'The scan reached its time limit before every video page could be checked.'
        return
      }
      if (session.fetchedPages >= this.followPages) {
        session.limited = true
        session.limitedMessage ??= `The scan reached the ${this.followPages}-page safety limit. Narrow the page selection.`
        return
      }

      pending.sort((left, right) => right.score - left.score)
      const batch: PendingFollow[] = []
      const perHost = new Map<string, number>()
      const available = Math.max(0, this.followPages - session.fetchedPages)
      if (available === 0) {
        session.limited = true
        session.limitedMessage ??= `The scan reached the ${this.followPages}-page safety limit. Narrow the page selection.`
        return
      }
      for (
        let index = 0;
        index < pending.length && batch.length < Math.min(4, available);
      ) {
        const candidate = pending[index]!
        const host = hostnameOf(candidate.url)
        const active = perHost.get(host) ?? 0
        if (active >= 2) {
          index += 1
          continue
        }
        perHost.set(host, active + 1)
        batch.push(candidate)
        pending.splice(index, 1)
      }
      if (batch.length === 0) return

      await Promise.all(
        batch.map(async (candidate) => {
          if (signal.aborted || this.now() >= session.deadline) return
          let allowed: boolean
          try {
            allowed = await robots.allows(candidate.url, signal)
          } catch {
            allowed = true
          }
          if (!allowed || signal.aborted) return
          if (session.fetchedPages >= this.followPages) {
            session.limited = true
            session.limitedMessage ??= `The scan reached the ${this.followPages}-page safety limit. Narrow the page selection.`
            return
          }
          if (candidate.videoHint) {
            this.addCandidate(session, {
              url: candidate.url,
              nameHint: candidate.nameHint,
              downloadAttribute: false,
              isAttachment: false,
              fromScript: false,
              isEmbed: candidate.isEmbed,
              source: candidate.isEmbed ? 'embed' : 'anchor',
              postNumber: null,
              author: null,
              videoHint: true
            })
          }
          const cookie = this.cookieFor(session, candidate.url)
          let response: ScanFetchResult
          try {
            response = await this.fetchPage(
              {
                url: candidate.url,
                ...(cookie === null ? {} : { cookie }),
                accept: 'html',
                signal
              },
              this.lookup === undefined ? {} : { lookup: this.lookup }
            )
          } catch {
            // A followed page that fails, needs a login or is not HTML is a
            // discovery dead end, not a scan failure.
            return
          }
          if (signal.aborted) return
          session.fetchedPages += 1
          session.expiresAt = this.now() + this.ttlMs
          this.touch(session)

          const finalNormalized = (() => {
            try {
              return normalizeScanUrl(response.finalUrl)
            } catch {
              return response.finalUrl
            }
          })()
          visited.add(finalNormalized)
          if (candidate.depth < this.followDepth) {
            enqueue(response.body, response.finalUrl, candidate.depth + 1)
          }
          const extracted = extractCandidates(response.body, response.finalUrl)
          for (const entry of extracted) {
            if (
              this.addCandidate(session, {
                ...entry,
                postNumber: null,
                author: null
              }) === 'limited'
            ) {
              break
            }
          }
        })
      )
      session.updatedAt = this.now()
      this.publish(session, false)
    }
  }

  private applyVideoResolution(
    session: StoredScanSession,
    item: StoredScanItem,
    resolution: VideoResolution
  ): void {
    item.status = resolution.status
    item.verified = resolution.status === 'ready'
    if (resolution.title !== null) {
      item.name = cleanText(resolution.title, MAX_SCAN_NAME_LENGTH)
    }
    item.thumbnailUrl = resolution.thumbnailUrl
    item.durationSeconds = resolution.durationSeconds
    item.width = resolution.width
    item.height = resolution.height
    item.bestResolution = resolution.bestResolution
    item.sizeBytes = resolution.sizeBytes
    item.sizeIsEstimate = resolution.sizeIsEstimate
    item.formats = resolution.formats
    item.bestOptionId = resolution.bestOptionId
    item.unavailableReason = resolution.reason
    if (resolution.status === 'signin') session.signinRequired = true
    item.videoAnalysis =
      resolution.status === 'ready' &&
      resolution.analysisId !== null &&
      resolution.expiresAt !== null
        ? {
            analysisId: resolution.analysisId,
            expiresAt: resolution.expiresAt,
            formats: resolution.formats,
            bestOptionId: resolution.bestOptionId
          }
        : null
    // The engine's answer replaces any direct media a fallback found earlier.
    item.videoMedia = null
    this.touch(session)
    this.scheduleEmit(session)
  }

  /**
   * Fill browser-only video cards from the pages themselves.
   *
   * yt-dlp has no extractor for some video sites and is answered with a
   * Cloudflare challenge, an age gate or a geo block on others. Those pages
   * still name their media, so a bounded fetch (with the exact-host Cookie when
   * the user allowed it) gives real quality options instead of a dead card.
   */
  private async applyPageFallbacks(
    session: StoredScanSession,
    items: readonly StoredScanItem[]
  ): Promise<void> {
    const targets = items.filter((item) => item.status === 'browser-only')
    if (targets.length === 0) return
    let cursor = 0
    const runners = Array.from(
      { length: Math.min(2, targets.length) },
      async () => {
        for (;;) {
          const index = cursor
          cursor += 1
          if (index >= targets.length) return
          if (session.controller.signal.aborted) return
          if (this.now() >= session.deadline) return
          const target = targets[index]!
          const current = session.items.get(target.id)
          if (!current || current.status !== 'browser-only') continue
          try {
            await this.applyPageFallback(session, current)
          } catch (error) {
            if (isCancelled(error) || session.controller.signal.aborted) return
            // A fallback failure leaves the card exactly as it was.
          }
          if (session.controller.signal.aborted) return
          this.touch(session)
          this.scheduleEmit(session)
        }
      }
    )
    await Promise.all(runners)
  }

  /** One bounded page fetch plus direct-media extraction for one card. */
  private async applyPageFallback(
    session: StoredScanSession,
    item: StoredScanItem
  ): Promise<boolean> {
    const cookie = this.cookieFor(session, item.url)
    let page: ScanFetchResult
    try {
      page = await this.fetchPage(
        {
          url: item.url,
          ...(cookie === null ? {} : { cookie }),
          accept: 'html',
          signal: session.controller.signal
        },
        this.lookup === undefined ? {} : { lookup: this.lookup }
      )
    } catch {
      // A challenge, login wall or non-HTML answer keeps the card browser-only;
      // the user's own browser tab is the remaining path.
      return false
    }
    if (session.controller.signal.aborted) return false
    session.fetchedPages += 1
    this.touch(session)

    const extracted = extractVideoMedia(page.body, page.finalUrl)
    if (extracted.sources.length === 0) {
      if (extracted.blocked !== null) {
        item.unavailableReason = BROWSER_ONLY_REASON
      }
      return false
    }
    return this.applyVideoMediaSources(session, item, {
      sources: extracted.sources,
      title: extracted.title,
      thumbnailUrl: extracted.thumbnailUrl,
      durationSeconds: extracted.durationSeconds,
      referer: page.finalUrl
    })
  }

  /**
   * Turn validated direct media into renderer-safe formats for one card.
   *
   * Every URL is re-normalized and its host checked against the public-target
   * policy before it can reach a downloader; a private or unresolvable host is
   * dropped silently. The card only becomes `ready` when at least one source
   * survived, and only opaque option IDs are published.
   */
  private async applyVideoMediaSources(
    session: StoredScanSession,
    item: StoredScanItem,
    input: {
      sources: readonly ScanVideoMediaSource[]
      title: string | null
      thumbnailUrl: string | null
      durationSeconds: number | null
      referer: string
    }
  ): Promise<boolean> {
    if (input.sources.length === 0) return false

    // One lookup per distinct host: a page normally serves every rendition from
    // the same CDN, so this stays cheap and still fails closed.
    const hosts = new Map<string, string>()
    for (const source of input.sources) {
      if (hosts.size >= MAX_SCAN_VIDEO_MEDIA_SOURCES) break
      let hostname: string
      try {
        hostname = new URL(source.url).hostname
      } catch {
        continue
      }
      if (!hosts.has(hostname)) hosts.set(hostname, source.url)
    }
    const publicHosts = new Set<string>()
    for (const [hostname, sample] of hosts) {
      try {
        await assertPublicTarget(sample, this.lookup)
        publicHosts.add(hostname)
      } catch {
        // Private, loopback or unresolvable: never handed to a downloader.
      }
    }
    if (publicHosts.size === 0) return false

    const referer = (() => {
      try {
        return normalizeScanUrl(input.referer)
      } catch {
        return item.url
      }
    })()

    const formats: ScanVideoFormat[] = []
    const sources: ScanVideoMediaTargetSource[] = []
    for (const source of input.sources) {
      if (sources.length >= MAX_SCAN_VIDEO_MEDIA_SOURCES) break
      let hostname: string
      try {
        hostname = new URL(source.url).hostname
      } catch {
        continue
      }
      if (!publicHosts.has(hostname)) continue
      let url: string
      try {
        url = normalizeScanUrl(source.url)
      } catch {
        continue
      }
      const height = source.height ?? null
      const label = videoMediaLabel(source, height)
      const optionId = randomUUID().replace(/-/g, '')
      formats.push({
        optionId,
        kind: 'video',
        label,
        container: videoMediaContainer(source.kind),
        width: source.width ?? null,
        height,
        sizeBytes: source.sizeBytes ?? null,
        sizeIsEstimate: false,
        outputFormats: ['auto']
      })
      sources.push({
        optionId,
        url,
        kind: source.kind,
        label,
        width: source.width ?? null,
        height,
        sizeBytes: source.sizeBytes ?? null
      })
    }
    if (formats.length === 0) return false

    const bestFormat = formats[0]!
    const best = sources[0]!
    item.status = 'ready'
    item.verified = true
    item.unavailableReason = null
    item.videoAnalysis = null
    item.videoMedia = { referer, sources }
    item.formats = formats
    item.bestOptionId = bestFormat.optionId
    item.width = best.width
    item.height = best.height
    item.bestResolution = best.height === null ? null : `${best.height}p`
    item.sizeBytes = best.sizeBytes
    item.sizeIsEstimate = false
    item.durationSeconds = input.durationSeconds
    item.thumbnailUrl = safeThumbnail(input.thumbnailUrl)
    if (input.title !== null) {
      item.name = cleanText(input.title, MAX_SCAN_NAME_LENGTH)
    }
    this.touch(session)
    this.scheduleEmit(session)
    return true
  }

  /**
   * Resolve video page links through the media engine with bounded
   * concurrency. A missing yt-dlp becomes a per-item state and never fails the
   * whole scan.
   */
  private async resolveVideoItems(session: StoredScanSession): Promise<void> {
    if (this.analyzeMedia === undefined) return
    const targets = session.order
      .map((id) => session.items.get(id))
      .filter(
        (item): item is StoredScanItem =>
          item !== undefined &&
          item.kind === 'page-link' &&
          item.category === 'video' &&
          item.status === 'found'
      )
    if (targets.length === 0) return

    if (this.now() >= session.deadline) {
      session.limited = true
      session.limitedMessage ??=
        'The scan reached its time limit before videos could be resolved.'
      return
    }

    const remaining = Math.max(0, this.videoCap - session.videoAnalyses)
    if (remaining === 0) {
      if (targets.length > 0) {
        session.limited = true
        session.limitedMessage ??= `This scan resolved the first ${this.videoCap} videos. Narrow the page selection to resolve more.`
      }
      return
    }
    const selected = targets.slice(0, remaining)
    if (selected.length < targets.length) {
      session.limited = true
      session.limitedMessage ??= `The scan resolved the first ${this.videoCap} videos. Narrow the page selection to resolve more.`
    }
    session.videoAnalyses += selected.length
    for (const item of selected) item.status = 'probing'
    this.touch(session)
    this.publish(session, true)

    const toolState: { resolution: VideoResolution | null } = {
      resolution: null
    }
    await resolveVideoCandidates(
      selected.map((item) => ({
        url: item.url,
        fallbackName: item.name
      })),
      {
        analyze: async (url, analyzeOptions) => {
          if (this.now() >= session.deadline) {
            session.limited = true
            session.limitedMessage ??=
              'The scan reached its time limit before every video could be resolved.'
            throw new AppError(
              'MEDIA_ANALYSIS_TIMEOUT',
              'The site took too long to analyze.'
            )
          }
          return this.analyzeMedia!(url, analyzeOptions)
        },
        cookieHost: session.cookieHost,
        cookie: session.cookie,
        signal: session.controller.signal,
        cap: this.videoCap,
        onResult: (index, resolution) => {
          const item = selected[index]
          if (!item) return
          const current = session.items.get(item.id)
          if (!current) return
          this.applyVideoResolution(session, current, resolution)
          if (resolution.status === 'tool-unavailable') {
            toolState.resolution = resolution
          }
        }
      }
    )

    if (session.controller.signal.aborted) return

    if (toolState.resolution !== null) {
      const reason = toolState.resolution.reason
      for (const target of targets) {
        const current = session.items.get(target.id)
        if (
          !current ||
          (current.status !== 'found' && current.status !== 'probing')
        ) {
          continue
        }
        current.status = 'tool-unavailable'
        current.unavailableReason = reason
        current.verified = false
      }
      if (session.message === null) {
        session.message =
          'yt-dlp is not available. Install or update it, then scan the page again.'
      }
    }

    // A page yt-dlp could not read (no extractor, Cloudflare, an age gate) is
    // still worth one bounded app-side fetch: the page itself usually names its
    // media, which turns the card into a real download with quality options.
    await this.applyPageFallbacks(session, selected)
    if (session.controller.signal.aborted) return

    this.touch(session)
    this.publish(session, true)
  }

  /**
   * The one-job Cookie for a URL. The exact-host slot only ever leaves for its
   * own host; the Gofile slot only ever leaves for a Gofile host, because
   * Gofile serves downloads from `store<N>.gofile.io` while the cookie was read
   * for `gofile.io`.
   */
  private cookieFor(session: StoredScanSession, url: string): string | null {
    let host: string
    try {
      host = new URL(url).host
    } catch {
      return null
    }
    if (session.gofileCookie !== null && isGofileHostname(host)) {
      return session.gofileCookie
    }
    if (session.cookie === null || session.cookieHost === null) return null
    return host === session.cookieHost ? session.cookie : null
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
      author: item.author,
      ...(item.durationSeconds === undefined
        ? {}
        : { durationSeconds: item.durationSeconds }),
      ...(item.width === undefined ? {} : { width: item.width }),
      ...(item.height === undefined ? {} : { height: item.height }),
      ...(item.thumbnailUrl === undefined
        ? {}
        : { thumbnailUrl: item.thumbnailUrl }),
      ...(item.bestResolution === undefined
        ? {}
        : { bestResolution: item.bestResolution }),
      ...(item.sizeIsEstimate === undefined
        ? {}
        : { sizeIsEstimate: item.sizeIsEstimate }),
      ...(item.formats === undefined ? {} : { formats: item.formats }),
      ...(item.bestOptionId === undefined
        ? {}
        : { bestOptionId: item.bestOptionId }),
      ...(item.unavailableReason === undefined
        ? {}
        : { unavailableReason: item.unavailableReason }),
      ...(item.browserMatchPending ? { browserMatchPending: true } : {})
    }
  }

  private fullSnapshot(session: StoredScanSession): ScanSession {
    this.pruneBrowserPairings()
    const items = session.order
      .map((id) => session.items.get(id))
      .filter((item): item is StoredScanItem => item !== undefined)
      .map((item) => this.publicItem(item))
    return {
      sessionId: session.id,
      status: session.status,
      origin: session.origin,
      ...(session.mode === 'page' ? {} : { mode: session.mode }),
      hostname: session.hostname,
      ...(session.title === null ? {} : { title: session.title }),
      message: session.message,
      signinRequired: session.signinRequired,
      counters: countersFor(items),
      progress: {
        fetchedPages: session.fetchedPages,
        totalItems: items.length,
        queueableItems: items.filter(isQueueableScanItem).length
      },
      items,
      scriptSets: this.scriptSetsFor(session),
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
    this.pruneBrowserPairings()
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
      ...(session.mode === 'page' ? {} : { mode: session.mode }),
      hostname: session.hostname,
      ...(session.title === null ? {} : { title: session.title }),
      message: session.message,
      signinRequired: session.signinRequired,
      counters: countersFor(allPublic),
      progress: {
        fetchedPages: session.fetchedPages,
        totalItems: allPublic.length,
        queueableItems: allPublic.filter(isQueueableScanItem).length
      },
      items: changed,
      scriptSets: this.scriptSetsFor(session),
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
      if (session.status === 'scanning' && session.started) count += 1
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
    this.settle(session)
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
  if (code === 'SCAN_TARGET_UNRESOLVED') {
    return "Couldn't reach that site. Check the address or your internet connection."
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

/** Container shown for a direct media source; the downloader keeps it as-is. */
const VIDEO_MEDIA_CONTAINER: Record<ScanVideoMediaKind, string> = {
  file: 'mp4',
  hls: 'm3u8',
  dash: 'mpd'
}

const VIDEO_MEDIA_KIND_LABEL: Record<ScanVideoMediaKind, string> = {
  file: 'MP4',
  hls: 'HLS',
  dash: 'DASH'
}

function videoMediaContainer(kind: ScanVideoMediaKind): string {
  return VIDEO_MEDIA_CONTAINER[kind]
}

/**
 * Renderer-safe quality label, for example `1080p · MP4`. The player's own
 * label is only used when the page exposed no resolution.
 */
function videoMediaLabel(
  source: ScanVideoMediaSource,
  height: number | null
): string {
  const quality =
    height !== null ? `${height}p` : (source.label ?? null)
  const kind = VIDEO_MEDIA_KIND_LABEL[source.kind]
  return quality === null ? kind : `${quality} · ${kind}`
}
