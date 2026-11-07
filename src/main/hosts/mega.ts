import { createDecipheriv, randomUUID } from 'node:crypto'
import {
  MAX_COLLECTION_ENTRY_TITLE_LENGTH,
  MAX_COLLECTION_TITLE_LENGTH,
  parseCollectionPreview,
  type CollectionEntry,
  type CollectionEntryErrorCode,
  type CollectionPreview
} from '@shared/batches'
import { isMegaHost } from '@shared/urlFragment'
import { sanitizeFilename } from '@shared/validation'

/**
 * Isolated, public-only MEGA adapter.
 *
 * Official public API surface used here (no login, no session, no Cookie):
 * - POST https://g.api.mega.co.nz/cs?id=<seq>            body `[{"a":"g",...}]`
 * - POST https://g.api.mega.co.nz/cs?id=<seq>&n=<folder> body `[{"a":"f",...}]`
 *
 * A public MEGA link carries its own AES key in the URL fragment, so the adapter
 * never needs an account: it derives the file key with `node:crypto`, asks the
 * API for a short-lived download URL and hands that URL to the existing aria2
 * engine. Nothing is decrypted here; `megaDecrypt.ts` streams the AES-CTR
 * post-processing step.
 *
 * The key material below is INTERNAL. It is returned to the main process only:
 * it is never part of a renderer DTO, never logged and never written into a
 * download URL. Callers must keep it in main-process memory.
 */

export const MEGA_API_ORIGIN = 'https://g.api.mega.co.nz'
/** Maximum files previewed from one public folder. */
export const MAX_MEGA_FOLDER_ENTRIES = 500
/** Hard safety bound for the raw node list of one folder response. */
const MAX_MEGA_FOLDER_NODES = 5_000
export const DEFAULT_MEGA_TIMEOUT_MS = 10_000
/** One bounded retry for a transient API refusal (-3/-4 or HTTP 429). */
export const MAX_MEGA_RATE_LIMIT_RETRIES = 1
export const MEGA_RATE_LIMIT_BACKOFF_MS = 200

const FILE_INFO_MAX_RESPONSE_BYTES = 256 * 1024
const FOLDER_MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const ERROR_BODY_MAX_RESPONSE_BYTES = 16 * 1024
const MAX_LINK_LENGTH = 512
const MAX_PROVIDER_FILE_NAME_LENGTH = 255
const MAX_PROVIDER_TITLE_LENGTH = 300
const MAX_NODE_ID_LENGTH = 32

const MEGA_HOST_LINK = /^https:\/\/(?:www\.)?mega\.(?:nz|io|co\.nz)(?=[/?#]|$)/i
const MEGA_ID = /^[A-Za-z0-9_-]{6,16}$/
/**
 * A public file link key is 32 bytes of unpadded base64url (43 characters);
 * a public folder link key is 16 bytes (22 characters) and is used raw as an
 * AES-128 key.
 */
const MEGA_FILE_KEY = /^[A-Za-z0-9_-]{43}$/
const MEGA_FOLDER_KEY = /^[A-Za-z0-9_-]{22}$/
// eslint-disable-next-line no-control-regex -- rejecting control characters is the security intent here
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

export const MEGA_ERROR_CODES = [
  'MEGA_INVALID_LINK',
  'MEGA_NOT_FOUND',
  'MEGA_UNAVAILABLE',
  'MEGA_QUOTA_EXCEEDED',
  'MEGA_RATE_LIMITED',
  'MEGA_UNSUPPORTED',
  'MEGA_TOO_MANY_FILES',
  'MEGA_RESPONSE_TOO_LARGE',
  'MEGA_INVALID_RESPONSE',
  'MEGA_TIMEOUT',
  'MEGA_NETWORK_ERROR'
] as const
export type MegaErrorCode = (typeof MEGA_ERROR_CODES)[number]

/**
 * User-facing messages are fixed and intentionally contain no provider text,
 * URL, key or response detail.
 */
const MEGA_ERROR_MESSAGES: Record<MegaErrorCode, string> = {
  MEGA_INVALID_LINK: 'Enter a public MEGA file link or folder link.',
  MEGA_NOT_FOUND: 'This MEGA item could not be found. It may have been removed.',
  MEGA_UNAVAILABLE: 'This MEGA item is currently unavailable.',
  MEGA_QUOTA_EXCEEDED:
    'MEGA transfer quota for this network is exhausted. Try again later.',
  MEGA_RATE_LIMITED: 'MEGA rate-limited this network. Try again later.',
  MEGA_UNSUPPORTED: 'This MEGA link is not supported.',
  MEGA_TOO_MANY_FILES: `This MEGA folder has too many files to preview (maximum ${MAX_MEGA_FOLDER_ENTRIES}).`,
  MEGA_RESPONSE_TOO_LARGE: 'MEGA returned an unexpectedly large response.',
  MEGA_INVALID_RESPONSE: 'MEGA returned an unexpected response.',
  MEGA_TIMEOUT: 'The request to MEGA timed out.',
  MEGA_NETWORK_ERROR: 'Could not reach MEGA.'
}

export class MegaError extends Error {
  readonly code: MegaErrorCode
  /** HTTP status for diagnostics. Never shown as raw provider text. */
  readonly httpStatus: number | null
  /** Negative MEGA API result for diagnostics; never user-facing text. */
  readonly providerCode: string | null
  /** Seconds MEGA asked the client to wait, when the response provided it. */
  readonly waitSeconds: number | null

  constructor(
    code: MegaErrorCode,
    details: {
      httpStatus?: number | null
      providerCode?: string | null
      waitSeconds?: number | null
    } = {}
  ) {
    super(MEGA_ERROR_MESSAGES[code])
    this.name = 'MegaError'
    this.code = code
    this.httpStatus = details.httpStatus ?? null
    this.providerCode = details.providerCode ?? null
    this.waitSeconds = details.waitSeconds ?? null
  }
}

export function isMegaError(value: unknown): value is MegaError {
  return value instanceof MegaError
}

/**
 * Parsed public MEGA link. `sourceUrl` is the canonical form and contains the
 * key, so it is INTERNAL: it may be kept in main-process state but must never
 * reach the renderer or a log line.
 */
export type MegaLink =
  | { kind: 'file'; id: string; key: string; sourceUrl: string }
  | {
      kind: 'folder'
      id: string
      key: string
      /** Set for a `.../folder/<id>#<key>/file/<nodeId>` sub-file link. */
      subFileId: string | null
      sourceUrl: string
    }

/** Derived AES material of one MEGA file key. INTERNAL. */
export interface MegaFileKey {
  /** AES-128-CTR key: `k[0..3] XOR k[4..7]`. */
  aesKey: Buffer
  /** AES-128-CTR counter: `k[4..5]` followed by eight zero bytes. */
  iv: Buffer
  /** The 8-byte MEGA meta-MAC, kept for an optional integrity check. */
  metaMac: Buffer
}

export interface MegaRequestOptions {
  /** Injected for hermetic tests; defaults to the platform fetch. */
  fetch?: MegaFetch
  /** Request and bounded-body timeout. Defaults to 10 seconds. */
  timeoutMs?: number
  /**
   * Lower a response bound for tests. Values above the adapter's own bound
   * cannot raise it, so provider responses stay bounded.
   */
  maxResponseBytes?: number
}

export type MegaFetch = (input: string, init: RequestInit) => Promise<Response>

export interface MegaFileResolution {
  kind: 'file'
  /** Node or file ID used by the API. */
  fileId: string
  /** Owning folder for a folder sub-file link, or null for a `/file/` link. */
  folderId: string | null
  name: string
  size: number
  /** Short-lived signed download URL. Safe to hand to aria2, never persisted. */
  downloadUrl: string
  /** INTERNAL key material for the decryption step. */
  key: MegaFileKey
  /** Canonical public link including the key. INTERNAL. */
  sourceUrl: string
}

/**
 * INTERNAL folder entry, kept in main-process memory next to the public
 * preview. `sourceUrl` and `key` never cross IPC.
 */
export interface MegaFolderEntry {
  entryId: string
  position: number
  nodeId: string | null
  name: string
  size: number | null
  /** Canonical `folder#key/file/node` link, or null for a malformed node. */
  sourceUrl: string | null
  /** INTERNAL key material, or null for a malformed node. */
  key: MegaFileKey | null
  availability: 'available' | 'unavailable'
  errorCode: CollectionEntryErrorCode | null
  errorReason: string | null
}

export interface MegaFolderResolution {
  kind: 'folder'
  folderId: string
  title: string
  /** Canonical public folder link including the key. INTERNAL. */
  sourceUrl: string
  /** Renderer-safe preview. Always a preview; nothing is queued. */
  preview: CollectionPreview
  /** INTERNAL metadata keyed by the preview's opaque entry IDs. */
  entries: MegaFolderEntry[]
}

export type MegaResolution = MegaFileResolution | MegaFolderResolution

export interface MegaAdapter {
  parseLink(value: unknown): MegaLink
  resolveFile(
    value: unknown,
    options?: MegaRequestOptions
  ): Promise<MegaFileResolution>
  resolveFolder(
    value: unknown,
    options?: MegaRequestOptions
  ): Promise<MegaFolderResolution>
  resolveLink(
    value: unknown,
    options?: MegaRequestOptions
  ): Promise<MegaResolution>
}

/* ------------------------------- crypto ------------------------------- */

function invalidLink(): MegaError {
  return new MegaError('MEGA_INVALID_LINK')
}

function invalidResponse(): MegaError {
  return new MegaError('MEGA_INVALID_RESPONSE')
}

function tooManyFiles(): MegaError {
  return new MegaError('MEGA_TOO_MANY_FILES')
}

/** Decode unpadded base64url (MEGA mixes both alphabets in its own fields). */
function decodeBase64Url(value: string): Buffer {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '')
  const padding = normalized.length % 4
  if (padding === 1) throw invalidResponse()
  return Buffer.from(
    normalized + '='.repeat(padding === 0 ? 0 : 4 - padding),
    'base64'
  )
}

/** Decode a 32-byte public MEGA file key. Throws MEGA_INVALID_LINK when malformed. */
export function decodeMegaKey(value: string): Buffer {
  if (typeof value !== 'string' || !MEGA_FILE_KEY.test(value)) throw invalidLink()
  const decoded = decodeBase64Url(value)
  if (decoded.length !== 32) throw invalidLink()
  return decoded
}

/**
 * Decode a 16-byte public MEGA folder key. A folder key is used raw as an
 * AES-128 key, so it never goes through `deriveMegaFileKey`.
 */
export function decodeMegaFolderKey(value: string): Buffer {
  if (typeof value !== 'string' || !MEGA_FOLDER_KEY.test(value)) {
    throw invalidLink()
  }
  const decoded = decodeBase64Url(value)
  if (decoded.length !== 16) throw invalidLink()
  return decoded
}

/**
 * Derive the AES-128-CTR material from a 32-byte MEGA file key.
 *
 * The key is eight big-endian 32-bit words. The AES key is the first four words
 * XOR the last four, the counter is words 4 and 5 followed by eight zero bytes,
 * and words 6 and 7 are the meta-MAC.
 */
export function deriveMegaFileKey(fileKey: Buffer): MegaFileKey {
  if (fileKey.length !== 32) throw invalidLink()
  const words = new Uint32Array(8)
  for (let index = 0; index < 8; index += 1) {
    words[index] = fileKey.readUInt32BE(index * 4)
  }

  const aesKey = Buffer.alloc(16)
  for (let index = 0; index < 4; index += 1) {
    aesKey.writeUInt32BE((words[index]! ^ words[index + 4]!) >>> 0, index * 4)
  }

  const iv = Buffer.alloc(16)
  iv.writeUInt32BE(words[4]!, 0)
  iv.writeUInt32BE(words[5]!, 4)

  const metaMac = Buffer.alloc(8)
  metaMac.writeUInt32BE(words[6]!, 0)
  metaMac.writeUInt32BE(words[7]!, 4)

  return { aesKey, iv, metaMac }
}

/**
 * Decrypt a MEGA attribute block: AES-128-CBC with a zero IV, no padding, of
 * `MEGA{"n":"name",...}`. Trailing NUL padding is removed.
 */
export function decryptMegaAttributes(aesKey: Buffer, attributes: string): string {
  if (aesKey.length !== 16) throw invalidResponse()
  if (typeof attributes !== 'string' || attributes.length === 0) {
    throw invalidResponse()
  }
  const data = decodeBase64Url(attributes)
  if (data.length === 0 || data.length % 16 !== 0) throw invalidResponse()

  const decipher = createDecipheriv('aes-128-cbc', aesKey, Buffer.alloc(16))
  decipher.setAutoPadding(false)
  const plain = Buffer.concat([decipher.update(data), decipher.final()])
  // MEGA pads the JSON to the AES block size with NUL bytes.
  let end = plain.length
  while (end > 0 && plain[end - 1] === 0) end -= 1
  const text = plain.subarray(0, end).toString('utf8')
  if (!text.startsWith('MEGA')) throw invalidResponse()
  return text.slice(4)
}

/**
 * Decrypt one folder node key with the folder key.
 *
 * A node key is AES-128-ECB (no padding) over the whole field: 32 bytes for a
 * file node (the complete file key, both blocks) and 16 bytes for a subfolder
 * node (that folder's own key). Every block is decrypted, never only the first.
 */
export function decryptMegaNodeKey(
  folderKey: Buffer,
  nodeKey: Buffer
): Buffer {
  if (folderKey.length !== 16) throw invalidResponse()
  if (nodeKey.length === 0 || nodeKey.length % 16 !== 0) throw invalidResponse()
  const decipher = createDecipheriv('aes-128-ecb', folderKey, null)
  decipher.setAutoPadding(false)
  return Buffer.concat([decipher.update(nodeKey), decipher.final()])
}

/**
 * Candidate encrypted keys of one node `k` field.
 *
 * The field is `<handle>:<base64urlKey>`; a node shared with several owners
 * carries one such entry per owner, separated by `/`. The owning handle is not
 * needed to decrypt, so only the key part of each entry is kept.
 */
function nodeKeyCandidates(raw: string): Buffer[] {
  const candidates: Buffer[] = []
  for (const part of raw.split('/')) {
    const separator = part.indexOf(':')
    const encoded = separator === -1 ? part : part.slice(separator + 1)
    if (encoded.length === 0) continue
    let decoded: Buffer
    try {
      decoded = decodeBase64Url(encoded)
    } catch {
      continue
    }
    if (decoded.length === 0 || decoded.length % 16 !== 0) continue
    candidates.push(decoded)
  }
  return candidates
}

/* -------------------------------- links -------------------------------- */

function fileSourceUrl(id: string, key: string): string {
  return `https://mega.nz/file/${id}#${key}`
}

function folderSourceUrl(id: string, key: string, subFileId: string | null): string {
  const base = `https://mega.nz/folder/${id}#${key}`
  return subFileId === null ? base : `${base}/file/${subFileId}`
}

function isMegaId(value: unknown): value is string {
  return typeof value === 'string' && MEGA_ID.test(value)
}

function isMegaFileKey(value: unknown): value is string {
  return typeof value === 'string' && MEGA_FILE_KEY.test(value)
}

function isMegaFolderKey(value: unknown): value is string {
  return typeof value === 'string' && MEGA_FOLDER_KEY.test(value)
}

/**
 * Parse every public MEGA link form:
 * - `https://mega.nz/file/<id>#<key>`
 * - `https://mega.nz/embed/file/<id>#<key>`
 * - `https://mega.nz/folder/<id>#<key>`
 * - `https://mega.nz/folder/<id>#<key>/file/<nodeId>`
 * - legacy `https://mega.nz/#!<id>!<key>` and `https://mega.nz/#F!<id>!<key>`
 */
export function parseMegaLink(value: unknown): MegaLink {
  if (typeof value !== 'string') throw invalidLink()

  const raw = value.trim()
  if (
    raw.length === 0 ||
    raw.length > MAX_LINK_LENGTH ||
    CONTROL_CHARACTERS.test(raw)
  ) {
    throw invalidLink()
  }

  // Keep the authority exact: the WHATWG URL parser silently drops a default
  // `:443`, but a non-canonical authority is not an accepted public link form.
  if (!MEGA_HOST_LINK.test(raw)) throw invalidLink()

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw invalidLink()
  }

  if (parsed.protocol !== 'https:') throw invalidLink()
  if (parsed.username || parsed.password) throw invalidLink()
  if (!isMegaHost(parsed.hostname)) throw invalidLink()
  if (parsed.port !== '') throw invalidLink()
  if (parsed.search !== '') throw invalidLink()

  const fragment = parsed.hash.startsWith('#')
    ? parsed.hash.slice(1)
    : parsed.hash
  if (fragment.length === 0) throw invalidLink()

  // Legacy form: the whole link lives in the fragment.
  const legacy = /^(!|F!)([A-Za-z0-9_-]+)!([A-Za-z0-9_-]+)$/.exec(fragment)
  if (legacy !== null) {
    const [, marker, id, key] = legacy
    if (!isMegaId(id)) throw invalidLink()
    if (marker === '!') {
      if (!isMegaFileKey(key)) throw invalidLink()
      if (parsed.pathname !== '/' && parsed.pathname !== '') throw invalidLink()
      return { kind: 'file', id, key, sourceUrl: fileSourceUrl(id, key) }
    }
    if (!isMegaFolderKey(key)) throw invalidLink()
    return {
      kind: 'folder',
      id,
      key,
      subFileId: null,
      sourceUrl: folderSourceUrl(id, key, null)
    }
  }

  // Modern form: the key is the fragment, optionally followed by a sub-file.
  const subFile = /^([A-Za-z0-9_-]+)\/file\/([A-Za-z0-9_-]+)$/.exec(fragment)
  const key = subFile === null ? fragment : subFile[1] ?? ''
  const subFileId = subFile === null ? null : subFile[2] ?? null
  if (subFileId !== null && !isMegaId(subFileId)) throw invalidLink()

  const path = parsed.pathname.replace(/\/+$/, '')
  const fileMatch = /^\/(?:embed\/)?file\/([A-Za-z0-9_-]+)$/.exec(path)
  if (fileMatch !== null) {
    if (subFileId !== null) throw invalidLink()
    if (!isMegaFileKey(key)) throw invalidLink()
    const id = fileMatch[1]!
    if (!isMegaId(id)) throw invalidLink()
    return { kind: 'file', id, key, sourceUrl: fileSourceUrl(id, key) }
  }

  const folderMatch = /^\/folder\/([A-Za-z0-9_-]+)$/.exec(path)
  if (folderMatch !== null) {
    if (!isMegaFolderKey(key)) throw invalidLink()
    const id = folderMatch[1]!
    if (!isMegaId(id)) throw invalidLink()
    return {
      kind: 'folder',
      id,
      key,
      subFileId,
      sourceUrl: folderSourceUrl(id, key, subFileId)
    }
  }

  throw invalidLink()
}

/** Alias with an explicit URL-oriented name. */
export function parseMegaUrl(value: unknown): MegaLink {
  return parseMegaLink(value)
}

/* ------------------------------ transport ------------------------------ */

let requestSequence = 1

function nextSequence(): number {
  const value = requestSequence
  requestSequence = requestSequence >= Number.MAX_SAFE_INTEGER ? 1 : value + 1
  return value
}

function normalizeTimeout(value: number | undefined): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.min(Math.floor(value), 60_000)
  }
  return DEFAULT_MEGA_TIMEOUT_MS
}

function responseByteLimit(
  defaultLimit: number,
  options: MegaRequestOptions
): number {
  const override = options.maxResponseBytes
  if (
    typeof override === 'number' &&
    Number.isSafeInteger(override) &&
    override > 0
  ) {
    return Math.min(defaultLimit, override)
  }
  return defaultLimit
}

function apiUrl(folderId: string | null): string {
  const base = `${MEGA_API_ORIGIN}/cs?id=${nextSequence()}`
  return folderId === null ? base : `${base}&n=${encodeURIComponent(folderId)}`
}

function waitSecondsFrom(response: Response): number | null {
  for (const header of ['x-mega-wait', 'retry-after']) {
    const raw = response.headers.get(header)
    if (raw === null) continue
    const seconds = Number(raw.trim())
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.min(Math.ceil(seconds), 3_600)
    }
  }
  return null
}

/** Map a negative MEGA API result to a typed error. */
function apiFailure(code: number, httpStatus: number | null = null): MegaError {
  const details = { httpStatus, providerCode: String(code) }
  if (code === -2 || code === -9) return new MegaError('MEGA_NOT_FOUND', details)
  if (code === -17) return new MegaError('MEGA_QUOTA_EXCEEDED', details)
  if (code === -3 || code === -4) return new MegaError('MEGA_RATE_LIMITED', details)
  if (code === -6 || code === -11 || code === -14 || code === -16) {
    return new MegaError('MEGA_UNAVAILABLE', details)
  }
  return new MegaError('MEGA_UNSUPPORTED', details)
}

function httpFailure(status: number, waitSeconds: number | null): MegaError {
  const details = { httpStatus: status, waitSeconds }
  if (status === 509) return new MegaError('MEGA_QUOTA_EXCEEDED', details)
  if (status === 429) return new MegaError('MEGA_RATE_LIMITED', details)
  if (status === 404) return new MegaError('MEGA_NOT_FOUND', details)
  if (status === 403 || status === 451) {
    return new MegaError('MEGA_UNAVAILABLE', details)
  }
  if (status >= 500) return new MegaError('MEGA_UNAVAILABLE', details)
  return new MegaError('MEGA_UNSUPPORTED', details)
}

function isRetryable(error: MegaError): boolean {
  return error.code === 'MEGA_RATE_LIMITED'
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function readBoundedText(
  response: Response,
  maximumBytes: number
): Promise<string> {
  const contentLength = response.headers.get('content-length')
  if (contentLength !== null && /^\d+$/.test(contentLength.trim())) {
    const declared = Number(contentLength)
    if (Number.isFinite(declared) && declared > maximumBytes) {
      throw new MegaError('MEGA_RESPONSE_TOO_LARGE')
    }
  }

  if (response.body === null) {
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > maximumBytes) {
      throw new MegaError('MEGA_RESPONSE_TOO_LARGE')
    }
    return text
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let total = 0
  let text = ''
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      total += chunk.value.byteLength
      if (total > maximumBytes) {
        try {
          await reader.cancel()
        } catch {
          // The body may already be closed by the aborting fetch.
        }
        throw new MegaError('MEGA_RESPONSE_TOO_LARGE')
      }
      text += decoder.decode(chunk.value, { stream: true })
    }
    text += decoder.decode()
    return text
  } finally {
    reader.releaseLock()
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * One bounded API round trip. The body is a fixed JSON array built by the
 * caller; the request never carries a Cookie, credentials or a referrer, and a
 * redirect is refused instead of followed.
 */
async function megaApiRequest(
  items: readonly unknown[],
  folderId: string | null,
  maximumBytes: number,
  options: MegaRequestOptions
): Promise<unknown> {
  const fetchImpl = options.fetch ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    throw new MegaError('MEGA_NETWORK_ERROR')
  }

  const controller = new AbortController()
  const timeoutMs = normalizeTimeout(options.timeoutMs)
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  try {
    let response: Response
    try {
      response = await fetchImpl(apiUrl(folderId), {
        method: 'POST',
        redirect: 'manual',
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json'
        },
        body: JSON.stringify(items),
        signal: controller.signal
      })
    } catch {
      if (timedOut) throw new MegaError('MEGA_TIMEOUT')
      throw new MegaError('MEGA_NETWORK_ERROR')
    }

    if (timedOut) throw new MegaError('MEGA_TIMEOUT')

    const responseWithType = response as Response & { type?: string }
    if (
      response.redirected ||
      (response.status >= 300 && response.status < 400) ||
      responseWithType.type === 'opaqueredirect'
    ) {
      throw new MegaError('MEGA_UNSUPPORTED', { httpStatus: response.status })
    }

    if (!response.ok) {
      // Consume (bounded) the error body so the socket is released, then map
      // the status. The body itself is never surfaced.
      await readBoundedText(
        response,
        Math.min(maximumBytes, ERROR_BODY_MAX_RESPONSE_BYTES)
      ).catch(() => '')
      throw httpFailure(response.status, waitSecondsFrom(response))
    }

    const text = await readBoundedText(response, maximumBytes)
    if (timedOut) throw new MegaError('MEGA_TIMEOUT')
    try {
      return JSON.parse(text)
    } catch {
      throw invalidResponse()
    }
  } catch (error) {
    if (error instanceof MegaError) throw error
    if (timedOut) throw new MegaError('MEGA_TIMEOUT')
    throw new MegaError('MEGA_NETWORK_ERROR')
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Run one API call and unwrap the single result object. MEGA answers with an
 * array whose first element is either the payload or a negative result code.
 */
async function megaApiCall(
  items: readonly unknown[],
  folderId: string | null,
  maximumBytes: number,
  options: MegaRequestOptions
): Promise<Record<string, unknown>> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const payload = await megaApiRequest(items, folderId, maximumBytes, options)
      if (!Array.isArray(payload) || payload.length === 0) throw invalidResponse()
      const first = payload[0]
      if (typeof first === 'number') {
        // A negative result is a typed refusal; a positive value is not a
        // documented response shape.
        if (!Number.isSafeInteger(first) || first >= 0) throw invalidResponse()
        throw apiFailure(first)
      }
      if (!isPlainObject(first)) throw invalidResponse()
      return first
    } catch (error) {
      if (
        error instanceof MegaError &&
        isRetryable(error) &&
        attempt < MAX_MEGA_RATE_LIMIT_RETRIES
      ) {
        await sleep(MEGA_RATE_LIMIT_BACKOFF_MS * (attempt + 1))
        continue
      }
      throw error
    }
  }
}

/* ------------------------------ responses ------------------------------ */

function parseDownloadUrl(record: Record<string, unknown>): string {
  const raw = record.g
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 4_096) {
    throw invalidResponse()
  }
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw invalidResponse()
  }
  if (parsed.protocol !== 'https:') throw invalidResponse()
  if (parsed.username || parsed.password) throw invalidResponse()
  return parsed.href
}

function parseSize(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw invalidResponse()
  }
  return value
}

function safeDisplayText(value: string, maximumLength: number): string {
  const cleaned = value
    .normalize('NFKC')
    // eslint-disable-next-line no-control-regex -- rejecting control characters is the security intent here
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return Array.from(cleaned).slice(0, maximumLength).join('').trim()
}

function parseFileName(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_PROVIDER_FILE_NAME_LENGTH ||
    CONTROL_CHARACTERS.test(value)
  ) {
    throw invalidResponse()
  }
  try {
    return sanitizeFilename(value)
  } catch {
    throw invalidResponse()
  }
}

/** Decrypted `MEGA{"n":"name"}` attribute JSON of one file. */
function parseAttributeName(attributes: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(attributes)
  } catch {
    throw invalidResponse()
  }
  if (!isPlainObject(parsed)) throw invalidResponse()
  return parseFileName(parsed.n)
}

function truncateEntryTitle(value: string): string {
  const title = Array.from(value)
    .slice(0, MAX_COLLECTION_ENTRY_TITLE_LENGTH)
    .join('')
    .trim()
  return title.length === 0 ? 'Unavailable file' : title
}

function parseFolderTitle(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_PROVIDER_TITLE_LENGTH) {
    return 'MEGA folder'
  }
  const title = safeDisplayText(value, MAX_COLLECTION_TITLE_LENGTH)
  return title.length === 0 ? 'MEGA folder' : title
}

function newOpaquePreviewId(): string {
  return `colprev_${randomUUID().replace(/-/g, '')}`
}

function newOpaqueEntryId(): string {
  return `colentry_${randomUUID().replace(/-/g, '')}`
}

/* ------------------------------- folders ------------------------------- */

interface MegaNode {
  id: string
  /** Parent node handle, or null when the response omitted it. */
  parentId: string | null
  size: number
  /** 0 file, 1 folder, 2 root, 3 incoming share. */
  type: number
  attributes: string
  /** Raw `k` field: `<handle>:<base64urlKey>`, entries separated by `/`. */
  key: string | null
}

function parseNode(raw: unknown): MegaNode | null {
  if (!isPlainObject(raw)) return null
  const id = raw.h
  if (typeof id !== 'string' || id.length > MAX_NODE_ID_LENGTH || !MEGA_ID.test(id)) {
    return null
  }
  const type = typeof raw.t === 'number' ? raw.t : -1
  const size = typeof raw.s === 'number' && Number.isSafeInteger(raw.s) && raw.s >= 0
    ? raw.s
    : 0
  const attributes = typeof raw.a === 'string' ? raw.a : ''
  const key = typeof raw.k === 'string' && raw.k.length > 0 ? raw.k : null
  const parentId =
    typeof raw.p === 'string' &&
    raw.p.length <= MAX_NODE_ID_LENGTH &&
    MEGA_ID.test(raw.p)
      ? raw.p
      : null
  return { id, parentId, size, type, attributes, key }
}

/** One decrypted node: its own key plus its decrypted display name. */
interface DecryptedNode {
  /** AES-128-CTR material of a file node; null for a folder node. */
  fileKey: MegaFileKey | null
  /** Raw 16-byte key of a folder node; null for a file node. */
  folderKey: Buffer | null
  name: string
}

/**
 * Decrypt one node with its parent folder key.
 *
 * The node's own key is AES-128-ECB under the parent folder key: 32 bytes for a
 * file node, which become AES-128-CTR material through `deriveMegaFileKey`, and
 * 16 bytes for a subfolder node, which is that folder's raw AES-128 key. The
 * node's attributes are always decrypted with the node's own key, never with the
 * parent folder key. A `k` field may carry one entry per owning handle, so the
 * first entry whose key decrypts the attributes wins.
 */
function decryptNode(
  node: MegaNode,
  parentFolderKey: Buffer
): DecryptedNode | null {
  if (node.key === null) return null
  const wantsFolderKey = node.type === 1
  let fallbackFolderKey: Buffer | null = null

  for (const candidate of nodeKeyCandidates(node.key)) {
    if (candidate.length !== (wantsFolderKey ? 16 : 32)) continue
    let key: Buffer
    try {
      key = decryptMegaNodeKey(parentFolderKey, candidate)
    } catch {
      continue
    }

    if (wantsFolderKey) {
      // A subfolder key is used raw; its attributes prove which entry is the
      // right one, but a folder without attributes still yields a usable key.
      try {
        return {
          fileKey: null,
          folderKey: key,
          name: parseAttributeName(decryptMegaAttributes(key, node.attributes))
        }
      } catch {
        fallbackFolderKey ??= key
        continue
      }
    }

    let fileKey: MegaFileKey
    try {
      fileKey = deriveMegaFileKey(key)
    } catch {
      continue
    }
    try {
      return {
        fileKey,
        folderKey: null,
        name: parseAttributeName(
          decryptMegaAttributes(fileKey.aesKey, node.attributes)
        )
      }
    } catch {
      continue
    }
  }

  return fallbackFolderKey === null
    ? null
    : { fileKey: null, folderKey: fallbackFolderKey, name: '' }
}

interface MegaFolderFile {
  node: MegaNode
  /** Null when no candidate key decrypted the node. */
  decrypted: DecryptedNode | null
}

interface MegaFolderListing {
  title: string
  /** File nodes in response order. Subfolders are keys, not entries. */
  files: MegaFolderFile[]
}

/**
 * Walk one folder listing and decrypt every node.
 *
 * A node key is encrypted with its parent folder's key, so a node can only be
 * opened once its parent folder is known; the response order is not guaranteed,
 * so the walk repeats until nothing new resolves. Subfolder nodes are never
 * entries: their key only unlocks that folder's own attributes and children.
 */
function buildFolderListing(
  folderId: string,
  folderKey: Buffer,
  rawNodes: readonly unknown[]
): MegaFolderListing {
  const nodes: MegaNode[] = []
  for (const raw of rawNodes) {
    const node = parseNode(raw)
    if (node !== null) nodes.push(node)
  }

  // Folder handle -> raw 16-byte key. The link key is the root folder's key and
  // is used raw both for the root attributes and for its direct children.
  const folderKeys = new Map<string, Buffer>()
  folderKeys.set(folderId, folderKey)

  let title = 'MEGA folder'
  for (const node of nodes) {
    if (node.type !== 2) continue
    folderKeys.set(node.id, folderKey)
    if (node.attributes.length === 0) continue
    try {
      title = parseAttributeName(
        decryptMegaAttributes(folderKey, node.attributes)
      )
    } catch {
      title = 'MEGA folder'
    }
  }

  const decrypted = new Map<string, DecryptedNode>()
  let pending = nodes.filter((node) => node.type === 0 || node.type === 1)
  while (pending.length > 0) {
    const unresolved: MegaNode[] = []
    let progressed = false
    for (const node of pending) {
      const parentKey =
        node.parentId === null ? undefined : folderKeys.get(node.parentId)
      if (parentKey === undefined) {
        unresolved.push(node)
        continue
      }
      const opened = decryptNode(node, parentKey)
      if (opened === null) {
        unresolved.push(node)
        continue
      }
      decrypted.set(node.id, opened)
      if (opened.folderKey !== null) folderKeys.set(node.id, opened.folderKey)
      progressed = true
    }
    if (!progressed) break
    pending = unresolved
  }

  const files = nodes
    .filter((node) => node.type === 0)
    .map((node) => ({ node, decrypted: decrypted.get(node.id) ?? null }))

  return { title: parseFolderTitle(title), files }
}

async function fetchFolderListing(
  folderId: string,
  folderKey: Buffer,
  options: MegaRequestOptions
): Promise<MegaFolderListing> {
  const record = await megaApiCall(
    [{ a: 'f', c: 1, r: 1, ca: 1 }],
    folderId,
    responseByteLimit(FOLDER_MAX_RESPONSE_BYTES, options),
    options
  )

  const rawNodes = record.f
  if (!Array.isArray(rawNodes)) throw invalidResponse()
  if (rawNodes.length > MAX_MEGA_FOLDER_NODES) throw tooManyFiles()

  return buildFolderListing(folderId, folderKey, rawNodes)
}

/** Build one download-ready entry from an already decrypted file node. */
function toFolderEntry(
  folderId: string,
  folderKeyText: string,
  file: MegaFolderFile,
  position: number
): MegaFolderEntry {
  const entryId = newOpaqueEntryId()
  const { node, decrypted } = file
  const unavailable = (reason: string): MegaFolderEntry => ({
    entryId,
    position,
    nodeId: node.id,
    name: `Unavailable file ${position + 1}`,
    size: node.size,
    sourceUrl: null,
    key: null,
    availability: 'unavailable',
    errorCode: 'unknown',
    errorReason: reason
  })

  if (node.key === null) return unavailable('This MEGA entry has no key.')
  if (decrypted === null || decrypted.fileKey === null) {
    return unavailable('This MEGA entry could not be decrypted.')
  }

  return {
    entryId,
    position,
    nodeId: node.id,
    name: truncateEntryTitle(decrypted.name),
    size: node.size,
    sourceUrl: folderSourceUrl(folderId, folderKeyText, node.id),
    key: decrypted.fileKey,
    availability: 'available',
    errorCode: null,
    errorReason: null
  }
}

function buildPreview(
  title: string,
  entries: readonly MegaFolderEntry[]
): CollectionPreview {
  const publicEntries: CollectionEntry[] = entries.map((entry) => ({
    id: entry.entryId,
    position: entry.position,
    title: truncateEntryTitle(entry.name),
    availability: entry.availability,
    errorCode: entry.errorCode,
    errorReason: entry.errorReason
  }))
  const availableCount = publicEntries.filter(
    (entry) => entry.availability === 'available'
  ).length

  return parseCollectionPreview({
    id: newOpaquePreviewId(),
    kind: 'mega-folder',
    title,
    entryCount: publicEntries.length,
    availableCount,
    unavailableCount: publicEntries.length - availableCount,
    entries: publicEntries
  })
}

/* ------------------------------ resolution ------------------------------ */

/**
 * Resolve public metadata and a short-lived download URL for one file.
 *
 * A `/file/<id>#<key>` link is one API call. A folder sub-file link needs the
 * folder listing first, because the node's own key is encrypted with the folder
 * key. The file body is never fetched here.
 */
export async function resolveMegaFile(
  value: unknown,
  options: MegaRequestOptions = {}
): Promise<MegaFileResolution> {
  const link = parseMegaLink(value)

  if (link.kind === 'file') {
    const key = deriveMegaFileKey(decodeMegaKey(link.key))
    const record = await megaApiCall(
      [{ a: 'g', g: 1, ssl: 2, p: link.id }],
      null,
      responseByteLimit(FILE_INFO_MAX_RESPONSE_BYTES, options),
      options
    )
    const downloadUrl = parseDownloadUrl(record)
    const size = parseSize(record.s)
    const attributes = typeof record.at === 'string' ? record.at : ''
    const name = parseAttributeName(decryptMegaAttributes(key.aesKey, attributes))
    return {
      kind: 'file',
      fileId: link.id,
      folderId: null,
      name,
      size,
      downloadUrl,
      key,
      sourceUrl: link.sourceUrl
    }
  }

  if (link.subFileId === null) throw invalidLink()

  // A folder key is 16 bytes and is used raw as the AES-128 folder key.
  const folderKey = decodeMegaFolderKey(link.key)
  const { files } = await fetchFolderListing(link.id, folderKey, options)
  const file = files.find((candidate) => candidate.node.id === link.subFileId)
  if (file === undefined) throw new MegaError('MEGA_NOT_FOUND')
  if (file.decrypted === null || file.decrypted.fileKey === null) {
    throw new MegaError('MEGA_UNAVAILABLE')
  }
  const key = file.decrypted.fileKey
  const name = file.decrypted.name

  const record = await megaApiCall(
    [{ a: 'g', g: 1, ssl: 2, n: file.node.id }],
    link.id,
    responseByteLimit(FILE_INFO_MAX_RESPONSE_BYTES, options),
    options
  )
  const downloadUrl = parseDownloadUrl(record)
  const size =
    typeof record.s === 'number' ? parseSize(record.s) : file.node.size

  return {
    kind: 'file',
    fileId: file.node.id,
    folderId: link.id,
    name,
    size,
    downloadUrl,
    key,
    sourceUrl: link.sourceUrl
  }
}

/**
 * Resolve a public folder into internal entries plus a renderer-safe preview.
 * Only plain files are listed; subfolders are walked for their keys but never
 * become entries, because a public link has no path selector. Nothing is queued
 * and nothing is downloaded here.
 */
export async function resolveMegaFolder(
  value: unknown,
  options: MegaRequestOptions = {}
): Promise<MegaFolderResolution> {
  const link = parseMegaLink(value)
  if (link.kind !== 'folder' || link.subFileId !== null) throw invalidLink()

  const folderKey = decodeMegaFolderKey(link.key)
  const { title, files } = await fetchFolderListing(link.id, folderKey, options)

  if (files.length > MAX_MEGA_FOLDER_ENTRIES) throw tooManyFiles()

  const entries: MegaFolderEntry[] = files.map((file, position) =>
    toFolderEntry(link.id, link.key, file, position)
  )

  return {
    kind: 'folder',
    folderId: link.id,
    title,
    sourceUrl: link.sourceUrl,
    preview: buildPreview(title, entries),
    entries
  }
}

/** Resolve a canonical public link based on its parsed kind. */
export async function resolveMegaLink(
  value: unknown,
  options: MegaRequestOptions = {}
): Promise<MegaResolution> {
  const link = parseMegaLink(value)
  return link.kind === 'folder' && link.subFileId === null
    ? resolveMegaFolder(link.sourceUrl, options)
    : resolveMegaFile(link.sourceUrl, options)
}

/** Create an adapter with shared fetch/timeout defaults. */
export function createMegaAdapter(
  defaults: MegaRequestOptions = {}
): MegaAdapter {
  return {
    parseLink: parseMegaLink,
    resolveFile: (value, options) =>
      resolveMegaFile(value, { ...defaults, ...options }),
    resolveFolder: (value, options) =>
      resolveMegaFolder(value, { ...defaults, ...options }),
    resolveLink: (value, options) =>
      resolveMegaLink(value, { ...defaults, ...options })
  }
}
