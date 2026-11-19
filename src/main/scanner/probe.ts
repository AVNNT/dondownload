import {
  Agent as HttpAgent,
  request as httpRequest,
  type ClientRequest
} from 'node:http'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import { isCookieHopSafe } from '../net/cookieScope'
import {
  resolvePublicTargetAddresses,
  type PublicTargetLookup
} from '../net/publicTarget'
import {
  PREFLIGHT_MAX_REDIRECTS,
  PREFLIGHT_TIMEOUT_MS,
  preflightPublicResource,
  type PreflightConnectLookup
} from '../net/publicPreflight'
import {
  classifyScanCandidate,
  filenameFromContentDisposition,
  type ClassifiedScanCandidate
} from './classify'
import { hostnameOf, normalizeScanUrl } from './extract/url'
import type { ScanItemStatus } from '@shared/scanner'

/**
 * Bounded, lazy verification of discovered candidates. It reuses the existing
 * public-resource preflight (one-byte range GET, revalidated redirects, pinned
 * public addresses) and never downloads a body.
 *
 * Performance-critical additions:
 *  - a global and a per-host concurrency bound (a page must not hammer one CDN);
 *  - one probe per normalized URL per scan, with in-flight promise sharing;
 *  - a short-lived per-scan result cache;
 *  - keep-alive sockets and a HEAD probe before the range GET, with a GET
 *    fallback whenever HEAD is not allowed or does not prove the file.
 */

export const SCAN_PROBE_CONCURRENCY = 8
export const SCAN_PROBE_HOST_CONCURRENCY = 3
export const SCAN_PROBE_CAP = 200
export const SCAN_PROBE_CACHE_TTL_MS = 30_000
const SCAN_PROBE_CACHE_MAX_ENTRIES = 512
const SCAN_PROBE_USER_AGENT = 'DonDownload/1.3.2'

const HTTP_AGENT = new HttpAgent({
  keepAlive: true,
  maxSockets: SCAN_PROBE_CONCURRENCY * 2
})
const HTTPS_AGENT = new HttpsAgent({
  keepAlive: true,
  maxSockets: SCAN_PROBE_CONCURRENCY * 2
})

export interface ScanProbeOptions {
  lookup?: PublicTargetLookup
  /** Injected for hermetic tests; production pins the resolved addresses. */
  connectLookup?: PreflightConnectLookup
  timeoutMs?: number
}

export type ProbeScanItemFn = (
  input: ScanProbeInput,
  options?: ScanProbeOptions
) => Promise<ScanProbeResult>

export interface ScanProbeInput {
  url: string
  cookie?: string
  signal?: AbortSignal
}

export interface ScanProbeResult {
  status: ScanItemStatus
  verified: boolean
  contentType: string | null
  contentDisposition: string | null
  sizeBytes: number | null
  /**
   * The redirect-resolved target the preflight actually verified. The explicit
   * queue path reuses it so aria2 is never handed the original URL with a
   * one-job Cookie that would follow a cross-host redirect.
   */
  finalUrl: string | null
  classification: ClassifiedScanCandidate
  reason: string | null
}

/** Short-lived, per-scan probe cache with in-flight promise sharing. */
export class ScanProbeCache {
  private readonly values = new Map<
    string,
    { result: ScanProbeResult; expiresAt: number }
  >()
  private readonly inflight = new Map<string, Promise<ScanProbeResult>>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = SCAN_PROBE_CACHE_TTL_MS,
    private readonly maxEntries: number = SCAN_PROBE_CACHE_MAX_ENTRIES
  ) {}

  run(
    key: string,
    factory: () => Promise<ScanProbeResult>
  ): Promise<ScanProbeResult> {
    const cached = this.values.get(key)
    if (cached !== undefined) {
      if (cached.expiresAt > this.now()) return Promise.resolve(cached.result)
      this.values.delete(key)
    }
    const pending = this.inflight.get(key)
    if (pending !== undefined) return pending

    const promise = factory().then(
      (result) => {
        this.inflight.delete(key)
        this.values.set(key, {
          result,
          expiresAt: this.now() + this.ttlMs
        })
        while (this.values.size > this.maxEntries) {
          const oldest = this.values.keys().next()
          if (oldest.done === true) break
          this.values.delete(oldest.value)
        }
        return result
      },
      (error: unknown) => {
        this.inflight.delete(key)
        throw error
      }
    )
    this.inflight.set(key, promise)
    return promise
  }
}

function classifyFromProbe(
  input: ScanProbeInput,
  response: {
    contentType: string
    contentDisposition: string | null
  } | null
): ClassifiedScanCandidate {
  return classifyScanCandidate({
    url: input.url,
    ...(response === null
      ? {}
      : {
          contentType: response.contentType,
          contentDisposition: response.contentDisposition
        })
  })
}

function cancelledResult(input: ScanProbeInput): ScanProbeResult {
  return {
    status: 'found',
    verified: false,
    contentType: null,
    contentDisposition: null,
    sizeBytes: null,
    finalUrl: null,
    classification: classifyFromProbe(input, null),
    reason: 'The scan was cancelled.'
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
  return 'SCAN_PROBE_FAILED'
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted
}

function normalizeContentType(
  value: string | string[] | undefined
): string | null {
  if (typeof value !== 'string') return null
  const mediaType = value.split(';')[0]?.trim().toLowerCase() ?? ''
  return mediaType.length > 0 ? mediaType : null
}

function isPageOrManifest(contentType: string): boolean {
  return (
    contentType === 'application/vnd.apple.mpegurl' ||
    contentType === 'application/x-mpegurl' ||
    contentType === 'application/mpegurl' ||
    contentType === 'application/dash+xml' ||
    contentType === 'text/html' ||
    contentType === 'application/xhtml+xml'
  )
}

function normalizeEncoding(value: string | string[] | undefined): string | null {
  if (typeof value !== 'string') return null
  const encoding = value.split(',')[0]?.trim().toLowerCase() ?? ''
  return encoding.length > 0 ? encoding : null
}

interface HeadHeaders {
  status: number
  contentType: string | null
  contentDisposition: string | null
  contentRange: string | null
  contentLength: string | null
  contentEncoding: string | null
}

function parseTotal(response: HeadHeaders): number | null {
  if (response.status === 206) {
    if (response.contentRange === null) return null
    const match = /^bytes\s+(\d{1,20})-(\d{1,20})\/(\d{1,20})$/i.exec(
      response.contentRange.trim()
    )
    if (!match) return null
    const start = Number(match[1])
    const end = Number(match[2])
    const total = Number(match[3])
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      !Number.isSafeInteger(total) ||
      start !== 0 ||
      end !== 0 ||
      total <= 0
    ) {
      return null
    }
    return total
  }
  if (
    response.contentLength === null ||
    !/^\d{1,20}$/.test(response.contentLength.trim())
  ) {
    return null
  }
  const total = Number(response.contentLength.trim())
  return Number.isSafeInteger(total) && total > 0 ? total : null
}

interface HeadSuccess {
  contentType: string
  contentDisposition: string | null
  sizeBytes: number
  finalUrl: string
}

type HeadOutcome =
  | { type: 'result'; result: HeadSuccess }
  | { type: 'fallback' }
  | { type: 'aborted' }

function pinResolvedAddresses(
  addresses: readonly { address: string; family: number }[]
): PreflightConnectLookup {
  return (_hostname, lookupOptions, callback) => {
    if (addresses.length === 0) {
      callback(
        Object.assign(new Error('No public address is available.'), {
          code: 'ENOTFOUND'
        }),
        '',
        0
      )
      return
    }
    if (lookupOptions && lookupOptions.all === true) {
      callback(
        null,
        addresses.map(({ address, family }) => ({ address, family }))
      )
      return
    }
    const first = addresses[0]!
    callback(null, first.address, first.family)
  }
}

type HeadOnce =
  | { redirect: string; status: number }
  | ({ headers: HeadHeaders })

function headOnce(
  url: string,
  input: ScanProbeInput,
  cookieOrigin: URL,
  connectLookup: PreflightConnectLookup,
  timeoutMs: number
): Promise<HeadOnce> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return Promise.reject(new Error('The probe URL is not valid.'))
  }
  const headers: Record<string, string> = {
    'User-Agent': SCAN_PROBE_USER_AGENT,
    'Accept-Encoding': 'identity'
  }
  if (input.cookie !== undefined && isCookieHopSafe(cookieOrigin, parsed)) {
    headers.Cookie = input.cookie
  }
  const client = parsed.protocol === 'https:' ? httpsRequest : httpRequest
  const agent = parsed.protocol === 'https:' ? HTTPS_AGENT : HTTP_AGENT

  return new Promise((resolve, reject) => {
    let settled = false
    let request!: ClientRequest
    const onAbort = (): void => {
      request.destroy(
        Object.assign(new Error('The scan was cancelled.'), {
          code: 'SCAN_CANCELLED'
        })
      )
    }
    const cleanup = (): void => {
      input.signal?.removeEventListener('abort', onAbort)
    }
    const finish = (value: HeadOnce): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }
    const fail = (error: unknown): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }

    try {
      request = client(
        {
          protocol: parsed.protocol,
          hostname: parsed.hostname,
          port: parsed.port || undefined,
          path: `${parsed.pathname}${parsed.search}`,
          method: 'HEAD',
          headers,
          agent,
          lookup: connectLookup as never
        },
        (response) => {
          const status = response.statusCode ?? 0
          const location = response.headers.location
          if (status >= 300 && status < 400 && typeof location === 'string') {
            response.resume()
            response.destroy()
            let next: string
            try {
              next = new URL(location, url).href
            } catch {
              fail(new Error('The redirect target is not valid.'))
              return
            }
            finish({ redirect: next, status })
            return
          }
          const snapshot: HeadHeaders = {
            status,
            contentType: normalizeContentType(
              response.headers['content-type']
            ),
            contentDisposition:
              typeof response.headers['content-disposition'] === 'string'
                ? response.headers['content-disposition']
                : null,
            contentRange:
              typeof response.headers['content-range'] === 'string'
                ? response.headers['content-range']
                : null,
            contentLength:
              typeof response.headers['content-length'] === 'string'
                ? response.headers['content-length']
                : null,
            contentEncoding: normalizeEncoding(
              response.headers['content-encoding']
            )
          }
          // A HEAD response has no body. Drain it so the keep-alive socket
          // returns to the pool instead of being torn down.
          response.resume()
          finish({ headers: snapshot })
        }
      )
    } catch (error) {
      fail(error)
      return
    }

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error('The probe did not answer in time.'))
    })
    request.on('error', (error) => fail(error))

    if (input.signal !== undefined) {
      if (input.signal.aborted) {
        onAbort()
        return
      }
      input.signal.addEventListener('abort', onAbort, { once: true })
    }
    request.end()
  })
}

/**
 * A HEAD probe that proves the same facts a range GET would prove. When the
 * server does not allow HEAD, omits its size or fails any check, the caller
 * falls back to the existing bounded range GET.
 */
async function probeHead(
  input: ScanProbeInput,
  options: ScanProbeOptions
): Promise<HeadOutcome> {
  const timeoutMs =
    Number.isSafeInteger(options.timeoutMs) && (options.timeoutMs ?? 0) > 0
      ? Math.min(options.timeoutMs ?? PREFLIGHT_TIMEOUT_MS, 60_000)
      : PREFLIGHT_TIMEOUT_MS

  let current: string
  try {
    current = new URL(input.url).href
  } catch {
    return { type: 'fallback' }
  }
  const cookieOrigin = new URL(current)

  for (let redirect = 0; redirect <= PREFLIGHT_MAX_REDIRECTS; redirect += 1) {
    if (isAborted(input.signal)) return { type: 'aborted' }
    let addresses
    try {
      addresses = await resolvePublicTargetAddresses(current, options.lookup)
    } catch {
      // The GET preflight owns the public-target classification and its error
      // messages, so let it produce the final result.
      return { type: 'fallback' }
    }
    const connectLookup =
      options.connectLookup ?? pinResolvedAddresses(addresses)

    let response
    try {
      response = await headOnce(
        current,
        input,
        cookieOrigin,
        connectLookup,
        timeoutMs
      )
    } catch (error) {
      if (isAborted(input.signal) || errorCode(error) === 'SCAN_CANCELLED') {
        return { type: 'aborted' }
      }
      return { type: 'fallback' }
    }

    if ('redirect' in response) {
      if (redirect === PREFLIGHT_MAX_REDIRECTS) return { type: 'fallback' }
      let next: URL
      try {
        next = new URL(response.redirect)
      } catch {
        return { type: 'fallback' }
      }
      if (
        next.protocol !== 'http:' &&
        next.protocol !== 'https:'
      ) {
        return { type: 'fallback' }
      }
      if (next.username || next.password) return { type: 'fallback' }
      current = next.href
      continue
    }

    const head = response.headers
    if (head.status !== 200 && head.status !== 206) {
      // Includes 403/404/405/501: the range GET owns the logged-out signal and
      // the exact fallback semantics.
      return { type: 'fallback' }
    }
    const contentType = head.contentType
    if (contentType === null || isPageOrManifest(contentType)) {
      return { type: 'fallback' }
    }
    if (
      head.contentEncoding !== null &&
      head.contentEncoding !== 'identity'
    ) {
      return { type: 'fallback' }
    }
    const sizeBytes = parseTotal(head)
    if (sizeBytes === null) return { type: 'fallback' }

    return {
      type: 'result',
      result: {
        contentType,
        contentDisposition: head.contentDisposition,
        sizeBytes,
        finalUrl: current
      }
    }
  }

  return { type: 'fallback' }
}

export async function probeScanItem(
  input: ScanProbeInput,
  options: ScanProbeOptions = {}
): Promise<ScanProbeResult> {
  if (isAborted(input.signal)) return cancelledResult(input)

  const head = await probeHead(input, options)
  if (head.type === 'aborted') return cancelledResult(input)
  if (head.type === 'result') {
    const classification = classifyFromProbe(input, head.result)
    return {
      status: classification.category === 'page' ? 'found' : 'ready',
      verified: classification.category !== 'page',
      contentType: head.result.contentType,
      contentDisposition: head.result.contentDisposition,
      sizeBytes: head.result.sizeBytes,
      finalUrl: head.result.finalUrl,
      classification,
      reason: null
    }
  }

  const preflightInput = {
    url: input.url,
    allowMedia: true,
    ...(input.cookie === undefined
      ? {}
      : {
          requestHeaders: {
            cookie: input.cookie
          }
        })
  }

  try {
    const result = await preflightPublicResource(preflightInput, {
      lookup: options.lookup,
      ...(options.connectLookup === undefined
        ? {}
        : { connectLookup: options.connectLookup }),
      ...(options.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.timeoutMs })
    })
    const classification = classifyFromProbe(input, result)
    return {
      status: classification.category === 'page' ? 'found' : 'ready',
      verified: classification.category !== 'page',
      contentType: result.contentType,
      contentDisposition: result.contentDisposition,
      sizeBytes: result.totalBytes,
      finalUrl: result.finalUrl,
      classification,
      reason: null
    }
  } catch (error) {
    if (isAborted(input.signal) || errorCode(error) === 'SCAN_CANCELLED') {
      return cancelledResult(input)
    }
    const code = errorCode(error)
    if (code === 'HANDOFF_NEEDS_LOGIN') {
      return {
        status: 'signin',
        verified: false,
        contentType: null,
        contentDisposition: null,
        sizeBytes: null,
        finalUrl: null,
        classification: classifyFromProbe(input, null),
        reason: 'This file needs your browser sign-in.'
      }
    }
    // A generic range/protocol failure is not proof that the file is gone.
    // Keep it selectable but unverified; queueing re-probes and fails closed.
    return {
      status: 'found',
      verified: false,
      contentType: null,
      contentDisposition: null,
      sizeBytes: null,
      finalUrl: null,
      classification: classifyFromProbe(input, null),
      reason: null
    }
  }
}

export interface ProbeScanCandidatesOptions {
  lookup?: PublicTargetLookup
  connectLookup?: PreflightConnectLookup
  signal?: AbortSignal
  cap?: number
  concurrency?: number
  /** Maximum simultaneous probes against one hostname. */
  perHostConcurrency?: number
  /** Per-scan cache; sharing it across calls also shares in-flight probes. */
  cache?: ScanProbeCache
  /** Injectable verifier for focused tests. */
  probe?: ProbeScanItemFn
  /** Called as each item finishes. The caller owns throttled publication. */
  onResult: (
    index: number,
    result: ScanProbeResult
  ) => void
}

interface ProbeTask {
  key: string
  input: ScanProbeInput
  indices: number[]
}

/**
 * Probe candidates with a global and per-host concurrency bound. Identical
 * normalized URLs are probed once and every occurrence receives the result.
 * Items beyond the per-session cap are left unverified instead of creating
 * unbounded outbound requests.
 */
export async function probeScanCandidates(
  inputs: readonly ScanProbeInput[],
  options: ProbeScanCandidatesOptions
): Promise<void> {
  const cap = Math.max(0, Math.min(options.cap ?? SCAN_PROBE_CAP, SCAN_PROBE_CAP))
  const limit = Math.max(
    1,
    Math.min(options.concurrency ?? SCAN_PROBE_CONCURRENCY, SCAN_PROBE_CONCURRENCY)
  )
  const perHost = Math.max(
    1,
    Math.min(
      options.perHostConcurrency ?? SCAN_PROBE_HOST_CONCURRENCY,
      SCAN_PROBE_HOST_CONCURRENCY
    )
  )
  const targets = inputs.slice(0, cap)
  const runProbe = options.probe ?? probeScanItem
  const cache = options.cache ?? new ScanProbeCache()

  // Deduplicate by normalized URL while keeping every caller index so the
  // published result lands on every item that referenced it.
  const tasksByKey = new Map<string, ProbeTask>()
  const order: ProbeTask[] = []
  for (let index = 0; index < targets.length; index += 1) {
    const input = targets[index]!
    let key = input.url
    try {
      key = normalizeScanUrl(input.url)
    } catch {
      // Keep the raw value; probeScanItem will classify it as invalid.
    }
    const existing = tasksByKey.get(key)
    if (existing !== undefined) {
      existing.indices.push(index)
      continue
    }
    const task: ProbeTask = { key, input, indices: [index] }
    tasksByKey.set(key, task)
    order.push(task)
  }

  if (order.length === 0) return

  const queueByHost = new Map<string, ProbeTask[]>()
  for (const task of order) {
    const host = hostnameOf(task.input.url) || ''
    const queue = queueByHost.get(host)
    if (queue === undefined) queueByHost.set(host, [task])
    else queue.push(task)
  }
  const hosts = [...queueByHost.keys()]
  const activeByHost = new Map<string, number>()

  let active = 0
  let remaining = order.length
  let nextHost = 0
  let closed = false
  let resolveDone: () => void = () => undefined
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })

  const finishTask = (): void => {
    remaining -= 1
    if (remaining <= 0) resolveDone()
  }

  const onAbort = (): void => {
    closed = true
    for (const queue of queueByHost.values()) queue.length = 0
    if (active === 0) resolveDone()
  }
  if (options.signal !== undefined) {
    if (options.signal.aborted) onAbort()
    else options.signal.addEventListener('abort', onAbort, { once: true })
  }

  const runTask = async (task: ProbeTask, host: string): Promise<void> => {
    let result: ScanProbeResult
    try {
      result = await cache.run(task.key, () =>
        runProbe(task.input, {
          ...(options.lookup === undefined ? {} : { lookup: options.lookup }),
          ...(options.connectLookup === undefined
            ? {}
            : { connectLookup: options.connectLookup })
        })
      )
    } catch {
      // probeScanItem never rejects; an injected probe may. Treat it as an
      // unverified finding instead of breaking the whole scan.
      result = {
        status: 'found',
        verified: false,
        contentType: null,
        contentDisposition: null,
        sizeBytes: null,
        finalUrl: null,
        classification: classifyScanCandidate({ url: task.input.url }),
        reason: null
      }
    } finally {
      active -= 1
      activeByHost.set(host, Math.max(0, (activeByHost.get(host) ?? 1) - 1))
    }
    if (!closed && !isAborted(options.signal)) {
      for (const index of task.indices) options.onResult(index, result)
    }
    finishTask()
    if (closed) {
      if (active === 0) resolveDone()
    } else {
      pump()
    }
  }

  function pump(): void {
    if (closed) return
    if (isAborted(options.signal)) {
      onAbort()
      return
    }
    while (active < limit) {
      let dispatched = false
      for (let offset = 0; offset < hosts.length; offset += 1) {
        const hostIndex = (nextHost + offset) % hosts.length
        const host = hosts[hostIndex]!
        const queue = queueByHost.get(host)
        if (queue === undefined || queue.length === 0) continue
        if ((activeByHost.get(host) ?? 0) >= perHost) continue
        const task = queue.shift()!
        active += 1
        activeByHost.set(host, (activeByHost.get(host) ?? 0) + 1)
        nextHost = (hostIndex + 1) % hosts.length
        dispatched = true
        void runTask(task, host)
        break
      }
      if (!dispatched) break
    }
  }

  pump()
  await done
  options.signal?.removeEventListener('abort', onAbort)
}

/** Exported for focused tests without a network request. */
export const scanProbeInternals = {
  filenameFromContentDisposition
}
