import type { Batch } from '@shared/batches'
import type { MediaAnalysis, MediaOutputFormat } from '@shared/media'
import { MAX_SCAN_MESSAGE_LENGTH } from '@shared/scanner'
import { imageFolderName } from '@shared/scanImages'
import type {
  ScanQueueResult,
  ScanQueueSelectionError,
  ScanQueueSelectionOutcome,
  ScanQueueSelectionsResult,
  ScanQueueSkip,
  ScanQueueVideoOption,
  ScanScriptPairingInput,
  ScanVideoFormat
} from '@shared/scanner'
import { ValidationError } from '@shared/validation'
import type { SniffedMediaInput } from '@shared/sniffedMedia'
import type { PublicTargetLookup } from '../net/publicTarget'
import { AppError } from '../errors'
import { probeScanItem, type ProbeScanItemFn } from './probe'
import { isMegaFileUrl } from './mega'
import { isPixeldrainFileUrl } from './pixeldrain'
import { isGofileDownloadUrl } from '@shared/gofile'
import type {
  ResolvedScriptPairing,
  ResolvedScanTarget,
  ScanSessionManager,
  ScanVideoMediaTarget
} from './session'

/**
 * Explicit queue path. Nothing here runs during scanning; it is reachable only
 * through `scan:queue-selection` with validated item IDs. Every selected item is
 * re-probed or revalidated immediately before it is handed to the batch
 * manager. `page` items are never queued.
 */

export interface ScanBatchTarget {
  url: string
  title: string
  filename?: string
  /**
   * The redirect-resolved target proven by the queue-time probe. Reusing it
   * lets DownloadManager keep the one-job Cookie only on the exact original
   * host, instead of sending it across a redirect.
   */
  resolvedUrl?: string
  requestHeaders?: {
    cookie?: string
    /**
     * Page URL of a direct media file found by the video page fallback. The
     * media host usually refuses a request without it.
     */
    referer?: string
  }
  /** Internal scan item ID used only to wire funscript pairings. */
  scanItemId?: string
  /**
   * Second URL the batch manager tries when this one fails with a 403/404.
   * Only images report one (Pinterest originals vs the 736x variant).
   */
  fallbackUrl?: string
}

/**
 * Internal video target. The opaque analysis/option pair was produced by a
 * fresh scan; it is memory-only and never crosses IPC.
 */
export interface ScanVideoBatchTarget {
  url: string
  title: string
  analysisId: string
  optionId: string
  outputFormat?: MediaOutputFormat
  cookie?: string
  /** Renderer-safe quality label, written into the queued row (no URL). */
  qualityLabel?: string
  /** Internal scan item ID used only to wire funscript pairings. */
  scanItemId?: string
}

/** Internal pairing descriptor; references scan item IDs, not paths. */
export interface ScanPairingBatchTarget {
  videoItemId: string
  setId: string
  scriptItemIds: string[]
  primaryVariant: string | null
  rename: boolean
}

export interface ScanBatchPort {
  createScanBatch(input: {
    title: string
    targets: readonly ScanBatchTarget[]
    /** Optional single folder below the download root for this batch. */
    subfolder?: string
  }): Promise<Batch>
  /**
   * Mixed scanner batch: verified direct files and resolved videos share one
   * parent batch so the renderer sees one result. Optional so simple phase-1
   * test doubles and alternative hosts remain valid.
   *
   * `streams` carries direct HLS/DASH manifests that the page fallback found.
   * They go through the media engine, exactly like a detected stream from the
   * browser overlay.
   */
  createScanMediaBatch?(input: {
    title: string
    files: readonly ScanBatchTarget[]
    videos: readonly ScanVideoBatchTarget[]
    streams?: readonly SniffedMediaInput[]
    pairings?: readonly ScanPairingBatchTarget[]
  }): Promise<Batch>
}

export interface ScanMediaJobsPort {
  analyzeMedia(input: unknown): Promise<MediaAnalysis>
}

export interface ScanQueueServiceOptions {
  sessions: ScanSessionManager
  batches: ScanBatchPort
  mediaJobs?: ScanMediaJobsPort
  lookup?: PublicTargetLookup
  concurrency?: number
  now?: () => number
  /** Injectable verifier for focused tests. */
  probeItem?: ProbeScanItemFn
}

interface QueuedEntry {
  itemId: string
  file?: ScanBatchTarget
  video?: ScanVideoBatchTarget
  stream?: SniffedMediaInput
}

function cleanTitle(value: string): string {
  const cleaned = value
    .normalize('NFKC')
    // eslint-disable-next-line no-control-regex -- rejecting control characters is the security intent
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return Array.from(cleaned).slice(0, 240).join('') || 'Scanned page'
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  limit: number,
  worker: (value: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(values.length)
  let cursor = 0
  const runners = Array.from(
    { length: Math.min(limit, Math.max(1, values.length)) },
    async () => {
      for (;;) {
        const index = cursor
        cursor += 1
        if (index >= values.length) return
        results[index] = await worker(values[index]!)
      }
    }
  )
  await Promise.all(runners)
  return results
}

/**
 * True for a scan item that is a plain image reported by the extension. These
 * are downloaded without a queue-time probe.
 */
function isImageTarget(target: ResolvedScanTarget): boolean {
  return target.category === 'image' && target.kind === 'file'
}

/**
 * True for a canonical Pixeldrain file link. The page itself is HTML, so the
 * generic probe would read it as a web page and refuse the download. The batch
 * manager resolves the public file metadata (and fails closed) at queue time,
 * so the canonical link is handed over unchanged.
 */
function isPixeldrainTarget(target: ResolvedScanTarget): boolean {
  return target.kind === 'file' && isPixeldrainFileUrl(target.url)
}

/**
 * True for a public MEGA link that resolves to one file. The page behind it is
 * a JavaScript application, so the generic probe would read it as a web page and
 * refuse the download. The batch manager resolves the public metadata and the
 * short-lived download URL (and fails closed) at download time, so the canonical
 * link — including its key — is handed over unchanged and stays internal.
 */
function isMegaTarget(target: ResolvedScanTarget): boolean {
  return target.kind === 'file' && isMegaFileUrl(target.url)
}

/** A provider file link that the batch manager resolves itself. */
function isProviderFileTarget(target: ResolvedScanTarget): boolean {
  return isPixeldrainTarget(target) || isMegaTarget(target)
}

/**
 * True for a Gofile download URL the user's own browser tab rendered. The file
 * is served by `store<N>.gofile.io` and requires the `accountToken` Cookie the
 * extension read for `gofile.io`, so the probe is skipped (it would only repeat
 * the request) and the one-job Cookie travels with the exact same URL.
 */
function isGofileTarget(target: ResolvedScanTarget): boolean {
  return target.kind === 'file' && isGofileDownloadUrl(target.url)
}

/**
 * The app's own product token, like the bounded page fetch. A direct stream is
 * downloaded by the media engine, which adds its own defaults on top.
 */
const SCAN_MEDIA_USER_AGENT = 'DonDownload/1.3.2'

const MEDIA_EXTENSION = /\.(?:mp4|webm|mkv|mov|m4v|m3u8|mpd|ts)$/i

/**
 * Filename for a direct media file. The page title is what funscript pairing
 * matches on, so the URL's own basename is never used.
 */
function videoFilename(name: string, extension: string): string {
  const base = name.trim().replace(MEDIA_EXTENSION, '').trim()
  return `${base.length > 0 ? base : 'Video'}.${extension}`
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
  return ''
}

const UNSAFE_ERROR_TEXT =
  /(?:[a-z][a-z0-9+.-]*:\/\/)|(?:[A-Za-z]:\\|\\\\[^\\])/i

/**
 * Produce a renderer-safe per-topic failure. Internal error text is kept only
 * for our own AppError/ValidationError messages; any other failure gets a
 * generic message so a URL or path can never escape through this field.
 */
function safeQueueFailure(error: unknown): ScanQueueSelectionError {
  const fallback = 'The selected items could not be queued.'
  let code = errorCode(error) || 'SCAN_QUEUE_FAILED'
  let message = fallback
  if (error instanceof AppError || error instanceof ValidationError) {
    code = error.code
    message = error.message
  }
  if (UNSAFE_ERROR_TEXT.test(message)) message = fallback
  return {
    code,
    message: Array.from(message).slice(0, MAX_SCAN_MESSAGE_LENGTH).join('')
  }
}

function formatsSupport(
  format: ScanVideoFormat,
  outputFormat: MediaOutputFormat
): boolean {
  return outputFormat === 'auto' || format.outputFormats.includes(outputFormat)
}

function sameVisibleFormat(
  option: MediaAnalysis['options'][number],
  requested: ScanVideoFormat
): boolean {
  return (
    option.kind === requested.kind &&
    option.label === requested.label &&
    option.container === requested.container
  )
}

export class ScanQueueService {
  private readonly sessions: ScanSessionManager
  private readonly batches: ScanBatchPort
  private readonly mediaJobs: ScanMediaJobsPort | undefined
  private readonly lookup: PublicTargetLookup | undefined
  private readonly concurrency: number
  private readonly now: () => number
  private readonly probeItem: ProbeScanItemFn | undefined

  constructor(options: ScanQueueServiceOptions) {
    this.sessions = options.sessions
    this.batches = options.batches
    this.mediaJobs = options.mediaJobs
    this.lookup = options.lookup
    this.concurrency = Math.max(1, Math.min(options.concurrency ?? 4, 4))
    this.now = options.now ?? Date.now
    this.probeItem = options.probeItem
  }

  /**
   * Queue one explicit selection per topic in a single renderer click. Each
   * session is resolved independently, so a script pairing can only reference
   * items that belong to its own topic.
   */
  async queueSelections(
    selections: readonly {
      sessionId: string
      itemIds: readonly string[]
      videoOptions?: readonly ScanQueueVideoOption[]
      pairings?: readonly ScanScriptPairingInput[]
    }[]
  ): Promise<ScanQueueSelectionsResult> {
    const results: ScanQueueSelectionOutcome[] = []
    for (const selection of selections) {
      try {
        const value = await this.queueSelection(
          selection.sessionId,
          selection.itemIds,
          selection.videoOptions ?? [],
          selection.pairings ?? []
        )
        results.push({ sessionId: selection.sessionId, ok: true, value })
      } catch (error) {
        results.push({
          sessionId: selection.sessionId,
          ok: false,
          error: safeQueueFailure(error)
        })
      }
    }
    return { results }
  }

  async queueSelection(
    rawSessionId: unknown,
    rawItemIds: readonly string[],
    rawVideoOptions: readonly ScanQueueVideoOption[] = [],
    rawPairings: readonly ScanScriptPairingInput[] = []
  ): Promise<ScanQueueResult> {
    const session = this.sessions.getSession(rawSessionId)
    const targets = this.sessions.resolveSelection(rawSessionId, rawItemIds)
    const resolvedPairings = this.sessions.resolveScriptPairings(
      rawSessionId,
      rawPairings,
      rawItemIds
    )

    const byId = new Map(targets.map((target) => [target.itemId, target]))
    const requested = new Map<string, ScanQueueVideoOption>()
    for (const option of rawVideoOptions) {
      if (!byId.has(option.itemId)) {
        throw new AppError(
          'SCAN_OPTION_INVALID',
          'A video option does not belong to the selected items.'
        )
      }
      requested.set(option.itemId, option)
    }
    for (const target of targets) {
      const wanted = requested.get(target.itemId)
      if (wanted?.optionId === undefined) continue
      const known =
        target.video !== undefined
          ? target.video.formats.some(
              (format) => format.optionId === wanted.optionId
            )
          : target.media !== undefined
            ? target.media.sources.some(
                (source) => source.optionId === wanted.optionId
              )
            : true
      if (!known) {
        throw new AppError(
          'SCAN_OPTION_INVALID',
          'That video format does not belong to this scan. Scan the page again.'
        )
      }
    }

    const resolved = await mapWithConcurrency(
      targets,
      this.concurrency,
      async (target: ResolvedScanTarget) => {
        if (target.video !== undefined) {
          return { target, probe: null }
        }
        // Direct media from the page fallback was already validated (public
        // host, http(s)) when the card was built, so there is nothing to probe.
        if (target.media !== undefined) {
          return { target, probe: null }
        }
        // An image was observed in the live DOM by the extension, so there is
        // nothing to verify: probing a thousand images would only add requests
        // and would reject images behind a hot-link check.
        if (isImageTarget(target)) {
          return { target, probe: null }
        }
        if (isProviderFileTarget(target)) {
          return { target, probe: null }
        }
        if (isGofileTarget(target)) {
          return { target, probe: null }
        }
        const probe = await (this.probeItem ?? probeScanItem)(
          {
            url: target.url,
            ...(target.cookie === undefined ? {} : { cookie: target.cookie })
          },
          this.lookup === undefined ? {} : { lookup: this.lookup }
        )
        return { target, probe }
      }
    )

    const skipped: ScanQueueSkip[] = []
    const queued: QueuedEntry[] = []

    for (const entry of resolved) {
      const { target, probe } = entry
      if (target.media !== undefined) {
        try {
          const direct = this.resolveMediaTarget(
            target,
            target.media,
            requested.get(target.itemId)
          )
          queued.push({ itemId: target.itemId, ...direct })
        } catch (error) {
          skipped.push({
            itemId: target.itemId,
            reason:
              error instanceof AppError
                ? error.message
                : 'This video could not be revalidated for download.'
          })
        }
        continue
      }

      if (target.video !== undefined) {
        try {
          const video = await this.resolveVideoTarget(
            target,
            requested.get(target.itemId)
          )
          queued.push({ itemId: target.itemId, video })
        } catch (error) {
          skipped.push({
            itemId: target.itemId,
            reason:
              error instanceof AppError
                ? error.message
                : 'This video could not be revalidated for download.'
          })
        }
        continue
      }

      if (isImageTarget(target)) {
        queued.push({
          itemId: target.itemId,
          file: {
            url: target.url,
            title: cleanTitle(target.name),
            filename: target.name,
            scanItemId: target.itemId,
            ...(target.fallbackUrl === undefined
              ? {}
              : { fallbackUrl: target.fallbackUrl }),
            ...(target.cookie === undefined
              ? {}
              : { requestHeaders: { cookie: target.cookie } })
          }
        })
        continue
      }

      if (isProviderFileTarget(target)) {
        queued.push({
          itemId: target.itemId,
          file: {
            url: target.url,
            title: cleanTitle(target.name),
            ...(target.name.length > 0 ? { filename: target.name } : {}),
            scanItemId: target.itemId
          }
        })
        continue
      }

      if (isGofileTarget(target)) {
        // The rendered download URL is the final target, so it is handed over
        // as the resolved URL (no redirect to follow) and the one-job Cookie is
        // attached for this request only.
        queued.push({
          itemId: target.itemId,
          file: {
            url: target.url,
            title: cleanTitle(target.name),
            ...(target.name.length > 0 ? { filename: target.name } : {}),
            scanItemId: target.itemId,
            resolvedUrl: target.url,
            ...(target.cookie === undefined
              ? {}
              : { requestHeaders: { cookie: target.cookie } })
          }
        })
        continue
      }

      const pageProbe = probe
      if (pageProbe === null) continue
      if (pageProbe.classification.category === 'page') {
        skipped.push({
          itemId: target.itemId,
          reason: 'A web page cannot be queued as a file.'
        })
        continue
      }
      if (pageProbe.status === 'signin') {
        skipped.push({
          itemId: target.itemId,
          reason: 'This file needs your browser sign-in.'
        })
        continue
      }
      if (pageProbe.status !== 'ready' || !pageProbe.verified) {
        skipped.push({
          itemId: target.itemId,
          reason: 'This file could not be verified at queue time.'
        })
        continue
      }

      queued.push({
        itemId: target.itemId,
        file: {
          url: target.url,
          title: cleanTitle(target.name),
          ...(target.name.length > 0 ? { filename: target.name } : {}),
          scanItemId: target.itemId,
          ...(pageProbe.finalUrl === null ? {} : { resolvedUrl: pageProbe.finalUrl }),
          ...(target.cookie === undefined
            ? {}
            : { requestHeaders: { cookie: target.cookie } })
        }
      })
    }

    const files = queued.flatMap((entry) =>
      entry.file === undefined ? [] : [entry.file]
    )
    const videos = queued.flatMap((entry) =>
      entry.video === undefined ? [] : [entry.video]
    )
    const streams = queued.flatMap((entry) =>
      entry.stream === undefined ? [] : [entry.stream]
    )
    if (files.length === 0 && videos.length === 0 && streams.length === 0) {
      throw new AppError(
        'SCAN_NOTHING_TO_QUEUE',
        skipped[0]?.reason ??
          'None of the selected items could be verified for download.'
      )
    }

    const pageTitle = cleanTitle(session.title ?? session.hostname)
    const imageSession = session.mode === 'images'
    const title = `${imageSession ? 'Images' : 'Scan'}: ${pageTitle}`
    let batch: Batch
    if (videos.length > 0 || streams.length > 0) {
      if (typeof this.batches.createScanMediaBatch !== 'function') {
        throw new AppError(
          'SCAN_MEDIA_UNAVAILABLE',
          'Video downloads are not available in this build.'
        )
      }
      const queuedIds = new Set(queued.map((entry) => entry.itemId))
      const pairings = resolvedPairings
        .filter(
          (pairing) =>
            queuedIds.has(pairing.videoItemId) &&
            pairing.scriptItemIds.every((itemId) => queuedIds.has(itemId))
        )
        .map((pairing) => this.toBatchPairing(pairing))
      batch = await this.batches.createScanMediaBatch({
        title,
        files,
        videos,
        ...(streams.length === 0 ? {} : { streams }),
        ...(pairings.length === 0 ? {} : { pairings })
      })
    } else {
      batch = await this.batches.createScanBatch({
        title,
        targets: files,
        // One image batch lands in its own folder named after the page, so a
        // 500-image board never mixes with the normal download list.
        ...(imageSession ? { subfolder: imageFolderName(pageTitle) } : {})
      })
    }

    return {
      batch,
      queuedItemIds: queued.map((entry) => entry.itemId),
      skipped
    }
  }

  /**
   * Turn one direct media selection into a download target.
   *
   * A progressive file goes through the normal downloader with the page as
   * Referer; an HLS/DASH manifest goes through the media engine, which is the
   * path the browser overlay already uses for detected streams. The Cookie is
   * only ever attached when the media host is the page host that issued it.
   */
  private resolveMediaTarget(
    target: ResolvedScanTarget,
    media: ScanVideoMediaTarget,
    wanted: ScanQueueVideoOption | undefined
  ): { file?: ScanBatchTarget; stream?: SniffedMediaInput } {
    const source =
      media.sources.find((entry) => entry.optionId === wanted?.optionId) ??
      media.sources[0]
    if (source === undefined) {
      throw new AppError(
        'SCAN_OPTION_INVALID',
        'This video has no downloadable format. Scan the page again.'
      )
    }
    const outputFormat: MediaOutputFormat = wanted?.outputFormat ?? 'auto'
    if (outputFormat !== 'auto') {
      throw new AppError(
        'SCAN_OUTPUT_FORMAT_UNSUPPORTED',
        'This video format cannot produce the selected output container.'
      )
    }

    const title = cleanTitle(target.name)
    const cookie = this.mediaCookie(target, media, source.url)
    if (source.kind === 'file') {
      return {
        file: {
          url: source.url,
          title,
          filename: videoFilename(target.name, 'mp4'),
          scanItemId: target.itemId,
          requestHeaders: {
            referer: media.referer,
            ...(cookie === undefined ? {} : { cookie })
          }
        }
      }
    }
    return {
      stream: {
        url: source.url,
        pageUrl: media.referer,
        referer: media.referer,
        userAgent: SCAN_MEDIA_USER_AGENT,
        kind: source.kind === 'hls' ? 'hls' : 'dash',
        title,
        ...(cookie === undefined ? {} : { cookie })
      }
    }
  }

  /**
   * The page Cookie for a direct media URL, or undefined. A Cookie read for the
   * page origin is never sent to another host.
   */
  private mediaCookie(
    target: ResolvedScanTarget,
    media: ScanVideoMediaTarget,
    mediaUrl: string
  ): string | undefined {
    if (target.cookie === undefined) return undefined
    try {
      return new URL(mediaUrl).host === new URL(media.referer).host
        ? target.cookie
        : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Revalidate one video selection at queue time. A fresh analysis is reused
   * as-is; an expired analysis is re-run through the media manager and the
   * requested visible format is matched again by label/kind/container (its
   * opaque ID changes on every analysis).
   */
  private async resolveVideoTarget(
    target: ResolvedScanTarget,
    wanted: ScanQueueVideoOption | undefined
  ): Promise<ScanVideoBatchTarget> {
    const video = target.video
    if (video === undefined) {
      throw new AppError('SCAN_OPTION_INVALID', 'This item is not a video.')
    }
    if (this.mediaJobs === undefined) {
      throw new AppError(
        'SCAN_MEDIA_UNAVAILABLE',
        'Video downloads are not available.'
      )
    }

    const requestedFormat =
      video.formats.find((format) => format.optionId === wanted?.optionId) ??
      video.formats.find((format) => format.optionId === video.bestOptionId) ??
      video.formats[0]
    if (!requestedFormat) {
      throw new AppError(
        'SCAN_OPTION_INVALID',
        'This video has no downloadable format. Scan the page again.'
      )
    }
    const outputFormat: MediaOutputFormat = wanted?.outputFormat ?? 'auto'
    if (!formatsSupport(requestedFormat, outputFormat)) {
      throw new AppError(
        'SCAN_OUTPUT_FORMAT_UNSUPPORTED',
        'This video format cannot produce the selected output container.'
      )
    }

    if (this.now() < video.expiresAt) {
      return {
        url: target.url,
        title: cleanTitle(target.name),
        analysisId: video.analysisId,
        optionId: requestedFormat.optionId,
        qualityLabel: requestedFormat.label,
        scanItemId: target.itemId,
        ...(outputFormat === 'auto' ? {} : { outputFormat }),
        ...(target.cookie === undefined ? {} : { cookie: target.cookie })
      }
    }

    let analysis: MediaAnalysis
    try {
      analysis = await this.mediaJobs.analyzeMedia({
        url: target.url,
        ...(target.cookie === undefined ? {} : { cookie: target.cookie })
      })
    } catch (error) {
      throw new AppError(
        errorCode(error) === 'MEDIA_TOOL_UNAVAILABLE'
          ? 'MEDIA_TOOL_UNAVAILABLE'
          : 'SCAN_MEDIA_UNAVAILABLE',
        'This video could not be analyzed again before download.'
      )
    }

    const match =
      analysis.options.find(
        (option) => option.optionId === wanted?.optionId
      ) ??
      analysis.options.find((option) =>
        sameVisibleFormat(option, requestedFormat)
      ) ??
      analysis.options.find(
        (option) =>
          option.kind === requestedFormat.kind &&
          option.height === requestedFormat.height &&
          option.container === requestedFormat.container
      )
    if (!match) {
      throw new AppError(
        'SCAN_OPTION_INVALID',
        'That video format is no longer available. Scan the page again.'
      )
    }
    const freshOutputFormats =
      Array.isArray(match.outputFormats) && match.outputFormats.length > 0
        ? match.outputFormats
        : ['auto' as const]
    if (outputFormat !== 'auto' && !freshOutputFormats.includes(outputFormat)) {
      throw new AppError(
        'SCAN_OUTPUT_FORMAT_UNSUPPORTED',
        'This video format cannot produce the selected output container.'
      )
    }

    return {
      url: target.url,
      title: cleanTitle(target.name),
      analysisId: analysis.analysisId,
      optionId: match.optionId,
      qualityLabel: requestedFormat.label,
      scanItemId: target.itemId,
      ...(outputFormat === 'auto' ? {} : { outputFormat }),
      ...(target.cookie === undefined ? {} : { cookie: target.cookie })
    }
  }

  private toBatchPairing(pairing: ResolvedScriptPairing): ScanPairingBatchTarget {
    return {
      videoItemId: pairing.videoItemId,
      setId: pairing.setId,
      scriptItemIds: [...pairing.scriptItemIds],
      primaryVariant: pairing.primaryVariant,
      rename: pairing.rename
    }
  }
}
