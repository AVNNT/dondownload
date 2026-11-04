import { randomUUID } from 'node:crypto'
import {
  MAX_COLLECTION_ENTRY_TITLE_LENGTH,
  MAX_COLLECTION_TITLE_LENGTH,
  parseCollectionPreview,
  type CollectionEntry,
  type CollectionEntryErrorCode,
  type CollectionPreview
} from '@shared/batches'
import { sanitizeFilename } from '@shared/validation'

/**
 * Isolated, public-only Pixeldrain adapter.
 *
 * Official API surface used here:
 * - GET https://pixeldrain.com/api/file/{id}/info
 * - GET https://pixeldrain.com/api/list/{id}
 * - GET https://pixeldrain.com/api/file/{id} (returned as a direct URL only)
 *
 * The adapter accepts only canonical public links (`/u/{id}` and `/l/{id}`),
 * reconstructs every request from the fixed Pixeldrain origin and never fetches
 * a caller-supplied URL. It performs no authentication, does not read cookies,
 * does not follow redirects and never attempts a CAPTCHA or hotlink bypass.
 *
 * A list is always resolved into an ephemeral, renderer-safe CollectionPreview
 * plus internal metadata keyed by the same opaque entry IDs. Nothing is queued.
 */

export const PIXELDRAIN_ORIGIN = 'https://pixeldrain.com'
export const PIXELDRAIN_API_BASE = `${PIXELDRAIN_ORIGIN}/api`

export const MAX_PIXELDRAIN_LIST_FILES = 500
export const DEFAULT_PIXELDRAIN_TIMEOUT_MS = 10_000

const FILE_INFO_MAX_RESPONSE_BYTES = 256 * 1024
const LIST_MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const ERROR_BODY_MAX_RESPONSE_BYTES = 16 * 1024
const MAX_LINK_LENGTH = 512
const MAX_PROVIDER_FILE_NAME_LENGTH = 255
const MAX_PROVIDER_MIME_TYPE_LENGTH = 255
const MAX_PROVIDER_TITLE_LENGTH = 300
const MAX_PROVIDER_AVAILABILITY_LENGTH = 128
const MAX_PROVIDER_ERROR_CODE_LENGTH = 64
const MAX_PROVIDER_ID_LENGTH = 32

const PIXELDRAIN_ID = /^[A-Za-z0-9_-]{4,32}$/
const PROVIDER_ERROR_CODE = /^[a-z0-9_]{1,64}$/
const PROVIDER_AVAILABILITY = /^[a-z0-9_]*$/
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

export const PIXELDRAIN_ERROR_CODES = [
  'PIXELDRAIN_INVALID_LINK',
  'PIXELDRAIN_NOT_FOUND',
  'PIXELDRAIN_PRIVATE',
  'PIXELDRAIN_UNAVAILABLE',
  'PIXELDRAIN_RATE_LIMITED',
  'PIXELDRAIN_CAPTCHA_REQUIRED',
  'PIXELDRAIN_HOTLINK_REQUIRED',
  'PIXELDRAIN_UNSUPPORTED',
  'PIXELDRAIN_SERVER_ERROR',
  'PIXELDRAIN_REDIRECT_REFUSED',
  'PIXELDRAIN_RESPONSE_TOO_LARGE',
  'PIXELDRAIN_INVALID_RESPONSE',
  'PIXELDRAIN_TOO_MANY_FILES',
  'PIXELDRAIN_TIMEOUT',
  'PIXELDRAIN_NETWORK_ERROR'
] as const
export type PixeldrainErrorCode = (typeof PIXELDRAIN_ERROR_CODES)[number]

/**
 * User-facing messages are fixed and intentionally contain no provider text,
 * URL, path, token or response detail.
 */
const PIXELDRAIN_ERROR_MESSAGES: Record<PixeldrainErrorCode, string> = {
  PIXELDRAIN_INVALID_LINK:
    'Enter a public Pixeldrain file link or list link.',
  PIXELDRAIN_NOT_FOUND:
    'This Pixeldrain item could not be found. It may have been removed.',
  PIXELDRAIN_PRIVATE: 'This Pixeldrain item is not publicly available.',
  PIXELDRAIN_UNAVAILABLE: 'This Pixeldrain item is currently unavailable.',
  PIXELDRAIN_RATE_LIMITED:
    'Pixeldrain rate-limited this network. Try again later.',
  PIXELDRAIN_CAPTCHA_REQUIRED:
    'Pixeldrain requires a CAPTCHA on its website for this item. DonDownload does not bypass CAPTCHAs.',
  PIXELDRAIN_HOTLINK_REQUIRED:
    'Pixeldrain blocks hotlinked downloads for this item. It cannot be downloaded without a Pixeldrain Premium account.',
  PIXELDRAIN_UNSUPPORTED: 'This Pixeldrain link is not supported.',
  PIXELDRAIN_SERVER_ERROR:
    'Pixeldrain reported a server error. Try again later.',
  PIXELDRAIN_REDIRECT_REFUSED:
    'Pixeldrain returned an unexpected redirect, which was refused.',
  PIXELDRAIN_RESPONSE_TOO_LARGE:
    'Pixeldrain returned an unexpectedly large response.',
  PIXELDRAIN_INVALID_RESPONSE: 'Pixeldrain returned an unexpected response.',
  PIXELDRAIN_TOO_MANY_FILES: `This Pixeldrain list has too many files to preview (maximum ${MAX_PIXELDRAIN_LIST_FILES}).`,
  PIXELDRAIN_TIMEOUT: 'The request to Pixeldrain timed out.',
  PIXELDRAIN_NETWORK_ERROR: 'Could not reach Pixeldrain.'
}

export class PixeldrainError extends Error {
  readonly code: PixeldrainErrorCode
  /** HTTP status for diagnostics. Never shown as raw provider text. */
  readonly httpStatus: number | null
  /** Stable provider error code for diagnostics; never user-facing text. */
  readonly providerCode: string | null

  constructor(
    code: PixeldrainErrorCode,
    details: { httpStatus?: number | null; providerCode?: string | null } = {}
  ) {
    super(PIXELDRAIN_ERROR_MESSAGES[code])
    this.name = 'PixeldrainError'
    this.code = code
    this.httpStatus = details.httpStatus ?? null
    this.providerCode = details.providerCode ?? null
  }
}

export function isPixeldrainError(value: unknown): value is PixeldrainError {
  return value instanceof PixeldrainError
}

export type PixeldrainLink =
  | { kind: 'file'; id: string; sourceUrl: string }
  | { kind: 'list'; id: string; sourceUrl: string }

export interface PixeldrainRequestOptions {
  /** Injected for hermetic tests; defaults to the platform fetch. */
  fetch?: PixeldrainFetch
  /** Request and bounded-body timeout. Defaults to 10 seconds. */
  timeoutMs?: number
  /**
   * Lower a response bound for tests. Values above the adapter's own bound
   * cannot raise it, so provider responses stay bounded.
   */
  maxResponseBytes?: number
}

export type PixeldrainFetch = (
  input: string,
  init: RequestInit
) => Promise<Response>

export interface PixeldrainFileResolution {
  kind: 'file'
  fileId: string
  name: string
  size: number
  mimeType: string | null
  /** Canonical public link. INTERNAL: never send this to the renderer. */
  sourceUrl: string
  /**
   * Ordinary documented raw download endpoint. Returning this URL preserves
   * aria2's normal Range/resume behavior; no custom transfer is involved.
   */
  downloadUrl: string
}

interface PixeldrainFileInfo {
  id: string
  name: string
  size: number
  mimeType: string | null
  availability: string
  canDownload: boolean | null
  providerCode: string | null
}

/**
 * INTERNAL list entry. It is kept in main-process memory next to the public
 * preview and is never sent over IPC or the native bridge.
 */
export interface PixeldrainResolvedListEntry {
  /** Opaque preview-local ID; also the ID used by CollectionEntry. */
  entryId: string
  position: number
  fileId: string | null
  name: string
  size: number | null
  mimeType: string | null
  /** Canonical public link, or null when the provider entry is malformed. */
  sourceUrl: string | null
  /** Raw endpoint only for available entries; unavailable entries are null. */
  downloadUrl: string | null
  availability: 'available' | 'unavailable'
  errorCode: CollectionEntryErrorCode | null
  errorReason: string | null
}

export interface PixeldrainListResolution {
  kind: 'list'
  listId: string
  title: string
  /** Canonical public list link. INTERNAL: never send this to the renderer. */
  sourceUrl: string
  /** Renderer-safe preview. Always a preview; nothing is queued. */
  preview: CollectionPreview
  /** INTERNAL metadata keyed by the preview's opaque entry IDs. */
  entries: PixeldrainResolvedListEntry[]
}

export type PixeldrainResolution =
  | PixeldrainFileResolution
  | PixeldrainListResolution

export interface PixeldrainAdapter {
  parseLink(value: unknown): PixeldrainLink
  resolveFile(
    value: unknown,
    options?: PixeldrainRequestOptions
  ): Promise<PixeldrainFileResolution>
  resolveList(
    value: unknown,
    options?: PixeldrainRequestOptions
  ): Promise<PixeldrainListResolution>
  resolveLink(
    value: unknown,
    options?: PixeldrainRequestOptions
  ): Promise<PixeldrainResolution>
}

interface ProviderUnavailable {
  entryCode: CollectionEntryErrorCode
  reason: string
  errorCode: PixeldrainErrorCode
}

const CAPTCHA_PROVIDER_CODES = new Set([
  'file_rate_limited_captcha_required',
  'virus_detected_captcha_required',
  'ip_download_limited_captcha_required',
  'server_overload_captcha_required',
  'recaptcha_failed'
])

const UNAVAILABLE_PROVIDER: ProviderUnavailable = {
  entryCode: 'unavailable',
  reason: 'Pixeldrain reports this file as unavailable.',
  errorCode: 'PIXELDRAIN_UNAVAILABLE'
}

const REMOVED_PROVIDER: ProviderUnavailable = {
  entryCode: 'removed',
  reason: 'This file was removed from Pixeldrain.',
  errorCode: 'PIXELDRAIN_NOT_FOUND'
}

const PROVIDER_CODE_CLASSIFICATIONS: Record<string, ProviderUnavailable> = {
  not_found: REMOVED_PROVIDER,
  list_file_not_found: REMOVED_PROVIDER,
  unavailable_for_legal_reasons: {
    entryCode: 'removed',
    reason: 'This file was removed from Pixeldrain for legal reasons.',
    errorCode: 'PIXELDRAIN_UNAVAILABLE'
  },
  file_rate_limited_captcha_required: {
    entryCode: 'unsupported',
    reason: 'Pixeldrain requires a CAPTCHA on its website for this file.',
    errorCode: 'PIXELDRAIN_CAPTCHA_REQUIRED'
  },
  virus_detected_captcha_required: {
    entryCode: 'unsupported',
    reason: 'Pixeldrain requires a CAPTCHA because this file was flagged.',
    errorCode: 'PIXELDRAIN_CAPTCHA_REQUIRED'
  },
  ip_download_limited_captcha_required: {
    entryCode: 'unsupported',
    reason:
      'Pixeldrain requires a CAPTCHA after too many downloads from this network.',
    errorCode: 'PIXELDRAIN_CAPTCHA_REQUIRED'
  },
  server_overload_captcha_required: {
    entryCode: 'unsupported',
    reason:
      'Pixeldrain requires a CAPTCHA while its servers are overloaded.',
    errorCode: 'PIXELDRAIN_CAPTCHA_REQUIRED'
  },
  recaptcha_failed: {
    entryCode: 'unsupported',
    reason: 'Pixeldrain could not verify its CAPTCHA response.',
    errorCode: 'PIXELDRAIN_CAPTCHA_REQUIRED'
  },
  hotlink_detected: {
    entryCode: 'unsupported',
    reason: 'Pixeldrain blocks hotlinked downloads for this file.',
    errorCode: 'PIXELDRAIN_HOTLINK_REQUIRED'
  },
  max_concurrent_downloads: {
    entryCode: 'unavailable',
    reason: 'Pixeldrain reached its concurrent download limit.',
    errorCode: 'PIXELDRAIN_UNAVAILABLE'
  },
  transfer_limit_exceeded: {
    entryCode: 'unavailable',
    reason: 'Pixeldrain reached its free transfer limit.',
    errorCode: 'PIXELDRAIN_UNAVAILABLE'
  },
  download_limit_exceeded: {
    entryCode: 'unavailable',
    reason: 'Pixeldrain reached its free download limit.',
    errorCode: 'PIXELDRAIN_UNAVAILABLE'
  },
  authentication_required: {
    entryCode: 'private',
    reason: 'This file is not publicly available.',
    errorCode: 'PIXELDRAIN_PRIVATE'
  },
  authentication_failed: {
    entryCode: 'private',
    reason: 'This file is not publicly available.',
    errorCode: 'PIXELDRAIN_PRIVATE'
  },
  forbidden: {
    entryCode: 'private',
    reason: 'This file is not publicly available.',
    errorCode: 'PIXELDRAIN_PRIVATE'
  }
}

function invalidLink(): PixeldrainError {
  return new PixeldrainError('PIXELDRAIN_INVALID_LINK')
}

function invalidResponse(): PixeldrainError {
  return new PixeldrainError('PIXELDRAIN_INVALID_RESPONSE')
}

function tooManyFiles(): PixeldrainError {
  return new PixeldrainError('PIXELDRAIN_TOO_MANY_FILES')
}

function fileSourceUrl(id: string): string {
  return `${PIXELDRAIN_ORIGIN}/u/${id}`
}

function listSourceUrl(id: string): string {
  return `${PIXELDRAIN_ORIGIN}/l/${id}`
}

function fileDownloadUrl(id: string): string {
  return `${PIXELDRAIN_API_BASE}/file/${id}`
}

function fileInfoApiUrl(id: string): string {
  return `${PIXELDRAIN_API_BASE}/file/${id}/info`
}

function listApiUrl(id: string): string {
  return `${PIXELDRAIN_API_BASE}/list/${id}`
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireObject(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) throw invalidResponse()
  return value
}

function optionalBoolean(
  record: Record<string, unknown>,
  key: string
): boolean | null {
  const value = record[key]
  if (value === undefined || value === null) return null
  if (typeof value !== 'boolean') throw invalidResponse()
  return value
}

function providerErrorCode(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_PROVIDER_ERROR_CODE_LENGTH ||
    !PROVIDER_ERROR_CODE.test(value)
  ) {
    return null
  }
  return value
}

function providerErrorCodeFromRecord(
  record: Record<string, unknown>
): string | null {
  return providerErrorCode(record.value)
}

function parseProviderId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > MAX_PROVIDER_ID_LENGTH ||
    !PIXELDRAIN_ID.test(value)
  ) {
    throw invalidResponse()
  }
  return value
}

function parseOptionalProviderId(value: unknown): string | null {
  if (value === undefined || value === null) return null
  return parseProviderId(value)
}

function parseSize(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw invalidResponse()
  }
  return value
}

function parseOptionalSize(value: unknown): number | null {
  if (value === undefined || value === null) return null
  return parseSize(value)
}

function parseCount(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw invalidResponse()
  }
  return value
}

function parseProviderFileName(value: unknown): string {
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

function parseOptionalProviderFileName(value: unknown): string | null {
  if (value === undefined || value === null) return null
  return parseProviderFileName(value)
}

function parseMimeType(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (
    typeof value !== 'string' ||
    value.length > MAX_PROVIDER_MIME_TYPE_LENGTH ||
    CONTROL_CHARACTERS.test(value)
  ) {
    throw invalidResponse()
  }
  return value.length === 0 ? null : value
}

function parseAvailability(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (
    typeof value !== 'string' ||
    value.length > MAX_PROVIDER_AVAILABILITY_LENGTH ||
    !PROVIDER_AVAILABILITY.test(value)
  ) {
    throw invalidResponse()
  }
  return value
}

function safeDisplayText(value: string, maximumLength: number): string {
  const cleaned = value
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return Array.from(cleaned).slice(0, maximumLength).join('').trim()
}

function parseListTitle(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_PROVIDER_TITLE_LENGTH) {
    throw invalidResponse()
  }
  const title = safeDisplayText(value, MAX_COLLECTION_TITLE_LENGTH)
  return title.length === 0 ? 'Pixeldrain list' : title
}

function truncateEntryTitle(value: string): string {
  const title = Array.from(value)
    .slice(0, MAX_COLLECTION_ENTRY_TITLE_LENGTH)
    .join('')
    .trim()
  return title.length === 0 ? 'Unavailable file' : title
}

function assertSuccess(record: Record<string, unknown>, status: number): void {
  const success = record.success
  if (success === undefined) return
  if (typeof success !== 'boolean') throw invalidResponse()
  if (success) return
  throw httpFailure(status, providerErrorCodeFromRecord(record))
}

function classificationForProviderCode(
  code: string | null
): ProviderUnavailable {
  if (code === null) return UNAVAILABLE_PROVIDER
  return PROVIDER_CODE_CLASSIFICATIONS[code] ?? UNAVAILABLE_PROVIDER
}

function classifyAvailability(
  availability: string,
  canDownload: boolean | null
): ProviderUnavailable | null {
  if (availability.length > 0) {
    return classificationForProviderCode(availability)
  }
  if (canDownload === false) {
    return {
      entryCode: 'private',
      reason: 'This file is not publicly downloadable.',
      errorCode: 'PIXELDRAIN_PRIVATE'
    }
  }
  return null
}

function httpFailure(
  status: number,
  providerCode: string | null
): PixeldrainError {
  const details = { httpStatus: status, providerCode }

  if (status === 429 || providerCode === 'ip_rate_limit_reached') {
    return new PixeldrainError('PIXELDRAIN_RATE_LIMITED', details)
  }
  if (providerCode !== null && CAPTCHA_PROVIDER_CODES.has(providerCode)) {
    return new PixeldrainError('PIXELDRAIN_CAPTCHA_REQUIRED', details)
  }
  if (providerCode === 'hotlink_detected') {
    return new PixeldrainError('PIXELDRAIN_HOTLINK_REQUIRED', details)
  }
  if (status === 451 || providerCode === 'unavailable_for_legal_reasons') {
    return new PixeldrainError('PIXELDRAIN_UNAVAILABLE', details)
  }
  if (
    status === 404 ||
    providerCode === 'not_found' ||
    providerCode === 'list_file_not_found'
  ) {
    return new PixeldrainError('PIXELDRAIN_NOT_FOUND', details)
  }
  if (providerCode === 'too_many_files') {
    return new PixeldrainError('PIXELDRAIN_TOO_MANY_FILES', details)
  }
  if (
    providerCode === 'max_concurrent_downloads' ||
    providerCode === 'transfer_limit_exceeded' ||
    providerCode === 'download_limit_exceeded'
  ) {
    return new PixeldrainError('PIXELDRAIN_UNAVAILABLE', details)
  }
  if (
    status === 401 ||
    status === 403 ||
    providerCode === 'authentication_required' ||
    providerCode === 'authentication_failed' ||
    providerCode === 'forbidden'
  ) {
    return new PixeldrainError('PIXELDRAIN_PRIVATE', details)
  }
  if (status >= 500) {
    return new PixeldrainError('PIXELDRAIN_SERVER_ERROR', details)
  }
  return new PixeldrainError('PIXELDRAIN_UNSUPPORTED', details)
}

function normalizeTimeout(value: number | undefined): number {
  if (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0
  ) {
    return Math.min(Math.floor(value), 60_000)
  }
  return DEFAULT_PIXELDRAIN_TIMEOUT_MS
}

function responseByteLimit(
  defaultLimit: number,
  options: PixeldrainRequestOptions
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

async function readBoundedText(
  response: Response,
  maximumBytes: number
): Promise<string> {
  const contentLength = response.headers.get('content-length')
  if (contentLength !== null && /^\d+$/.test(contentLength.trim())) {
    const declared = Number(contentLength)
    if (Number.isFinite(declared) && declared > maximumBytes) {
      throw new PixeldrainError('PIXELDRAIN_RESPONSE_TOO_LARGE')
    }
  }

  if (response.body === null) {
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > maximumBytes) {
      throw new PixeldrainError('PIXELDRAIN_RESPONSE_TOO_LARGE')
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
        throw new PixeldrainError('PIXELDRAIN_RESPONSE_TOO_LARGE')
      }
      text += decoder.decode(chunk.value, { stream: true })
    }
    text += decoder.decode()
    return text
  } finally {
    reader.releaseLock()
  }
}

async function readProviderErrorCode(
  response: Response,
  maximumBytes: number
): Promise<string | null> {
  try {
    const text = await readBoundedText(response, maximumBytes)
    const parsed: unknown = JSON.parse(text)
    if (!isPlainObject(parsed)) return null
    return providerErrorCodeFromRecord(parsed)
  } catch {
    return null
  }
}

function assertJsonContentType(response: Response): void {
  const contentType = response.headers.get('content-type')
  if (contentType === null) return
  if (!/^application\/json(?:\s*;|$)/i.test(contentType.trim())) {
    throw invalidResponse()
  }
}

async function requestJson(
  url: string,
  maximumBytes: number,
  options: PixeldrainRequestOptions
): Promise<Record<string, unknown>> {
  const fetchImpl = options.fetch ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    throw new PixeldrainError('PIXELDRAIN_NETWORK_ERROR')
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
      response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'manual',
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        headers: { accept: 'application/json' },
        signal: controller.signal
      })
    } catch {
      if (timedOut) {
        throw new PixeldrainError('PIXELDRAIN_TIMEOUT')
      }
      throw new PixeldrainError('PIXELDRAIN_NETWORK_ERROR')
    }

    if (timedOut) {
      throw new PixeldrainError('PIXELDRAIN_TIMEOUT')
    }

    const responseWithType = response as Response & { type?: string }
    if (
      response.redirected ||
      (response.status >= 300 && response.status < 400) ||
      responseWithType.type === 'opaqueredirect'
    ) {
      throw new PixeldrainError('PIXELDRAIN_REDIRECT_REFUSED', {
        httpStatus: response.status
      })
    }

    if (!response.ok) {
      const code = await readProviderErrorCode(
        response,
        Math.min(maximumBytes, ERROR_BODY_MAX_RESPONSE_BYTES)
      )
      if (timedOut) {
        throw new PixeldrainError('PIXELDRAIN_TIMEOUT')
      }
      throw httpFailure(response.status, code)
    }

    assertJsonContentType(response)
    const text = await readBoundedText(response, maximumBytes)
    if (timedOut) {
      throw new PixeldrainError('PIXELDRAIN_TIMEOUT')
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw invalidResponse()
    }
    const record = requireObject(parsed)
    assertSuccess(record, response.status)
    if (timedOut) {
      throw new PixeldrainError('PIXELDRAIN_TIMEOUT')
    }
    return record
  } catch (error) {
    if (error instanceof PixeldrainError) throw error
    if (timedOut) throw new PixeldrainError('PIXELDRAIN_TIMEOUT')
    throw new PixeldrainError('PIXELDRAIN_NETWORK_ERROR')
  } finally {
    clearTimeout(timer)
  }
}

function parseFileInfo(
  record: Record<string, unknown>,
  expectedId: string
): PixeldrainFileInfo {
  const id = parseProviderId(record.id)
  if (id !== expectedId) throw invalidResponse()

  return {
    id,
    name: parseProviderFileName(record.name),
    size: parseSize(record.size),
    mimeType: parseMimeType(record.mime_type),
    availability: parseAvailability(record.availability),
    canDownload: optionalBoolean(record, 'can_download'),
    providerCode: providerErrorCodeFromRecord(record)
  }
}

function assertFileAvailable(info: PixeldrainFileInfo): void {
  const unavailable = classifyAvailability(info.availability, info.canDownload)
  if (unavailable !== null) {
    throw new PixeldrainError(unavailable.errorCode, {
      providerCode: info.providerCode
    })
  }
}

function parseListFile(
  raw: unknown,
  position: number
): PixeldrainResolvedListEntry {
  const record = requireObject(raw)
  const success = optionalBoolean(record, 'success')

  if (success === false) {
    const fileId = parseOptionalProviderId(record.id)
    const name =
      parseOptionalProviderFileName(record.name) ??
      `Unavailable file ${position + 1}`
    const size = parseOptionalSize(record.size)
    const mimeType = parseMimeType(record.mime_type)
    const unavailable = classificationForProviderCode(
      providerErrorCodeFromRecord(record)
    )
    const entryId = newOpaqueEntryId()
    return {
      entryId,
      position,
      fileId,
      name: truncateEntryTitle(name),
      size,
      mimeType,
      sourceUrl: fileId === null ? null : fileSourceUrl(fileId),
      downloadUrl: null,
      availability: 'unavailable',
      errorCode: unavailable.entryCode,
      errorReason: unavailable.reason
    }
  }

  const fileId = parseProviderId(record.id)
  const name = parseProviderFileName(record.name)
  const size = parseSize(record.size)
  const mimeType = parseMimeType(record.mime_type)
  const availability = parseAvailability(record.availability)
  const canDownload = optionalBoolean(record, 'can_download')
  const unavailable = classifyAvailability(availability, canDownload)
  const entryId = newOpaqueEntryId()

  if (unavailable !== null) {
    return {
      entryId,
      position,
      fileId,
      name: truncateEntryTitle(name),
      size,
      mimeType,
      sourceUrl: fileSourceUrl(fileId),
      downloadUrl: null,
      availability: 'unavailable',
      errorCode: unavailable.entryCode,
      errorReason: unavailable.reason
    }
  }

  return {
    entryId,
    position,
    fileId,
    name: truncateEntryTitle(name),
    size,
    mimeType,
    sourceUrl: fileSourceUrl(fileId),
    downloadUrl: fileDownloadUrl(fileId),
    availability: 'available',
    errorCode: null,
    errorReason: null
  }
}

function newOpaquePreviewId(): string {
  return `colprev_${randomUUID().replace(/-/g, '')}`
}

function newOpaqueEntryId(): string {
  return `colentry_${randomUUID().replace(/-/g, '')}`
}

function buildPreview(
  listTitle: string,
  entries: readonly PixeldrainResolvedListEntry[]
): CollectionPreview {
  const publicEntries: CollectionEntry[] = entries.map((entry) => ({
    id: entry.entryId,
    position: entry.position,
    title:
      entry.availability === 'available'
        ? truncateEntryTitle(entry.name)
        : truncateEntryTitle(entry.name || `Unavailable file ${entry.position + 1}`),
    availability: entry.availability,
    errorCode: entry.errorCode,
    errorReason: entry.errorReason
  }))
  const availableCount = publicEntries.filter(
    (entry) => entry.availability === 'available'
  ).length

  return parseCollectionPreview({
    id: newOpaquePreviewId(),
    kind: 'pixeldrain-list',
    title: listTitle,
    entryCount: publicEntries.length,
    availableCount,
    unavailableCount: publicEntries.length - availableCount,
    entries: publicEntries
  })
}

/** Parse only the two canonical public Pixeldrain link forms. */
export function parsePixeldrainLink(value: unknown): PixeldrainLink {
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
  if (!/^https:\/\/pixeldrain\.com(?=\/|$)/i.test(raw)) throw invalidLink()

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw invalidLink()
  }

  if (parsed.protocol !== 'https:') throw invalidLink()
  if (parsed.username || parsed.password) throw invalidLink()
  if (parsed.hostname !== 'pixeldrain.com') throw invalidLink()
  if (parsed.port !== '') throw invalidLink()
  if (parsed.search !== '' || parsed.hash !== '') throw invalidLink()

  const match = /^\/(u|l)\/([^/]+)\/?$/.exec(parsed.pathname)
  if (match === null) throw invalidLink()

  const kind = match[1] === 'u' ? 'file' : 'list'
  const id = match[2] ?? ''
  if (!PIXELDRAIN_ID.test(id)) throw invalidLink()

  return kind === 'file'
    ? { kind, id, sourceUrl: fileSourceUrl(id) }
    : { kind, id, sourceUrl: listSourceUrl(id) }
}

/** Alias with an explicit URL-oriented name. */
export function parsePixeldrainUrl(value: unknown): PixeldrainLink {
  return parsePixeldrainLink(value)
}

/**
 * Resolve public metadata for a single file. The file body is never fetched;
 * only the documented info endpoint is requested, and an ordinary raw endpoint
 * URL is returned for a later aria2 download.
 */
export async function resolvePixeldrainFile(
  value: unknown,
  options: PixeldrainRequestOptions = {}
): Promise<PixeldrainFileResolution> {
  const link = parsePixeldrainLink(value)
  if (link.kind !== 'file') throw invalidLink()

  const record = await requestJson(
    fileInfoApiUrl(link.id),
    responseByteLimit(FILE_INFO_MAX_RESPONSE_BYTES, options),
    options
  )
  const info = parseFileInfo(record, link.id)
  assertFileAvailable(info)

  return {
    kind: 'file',
    fileId: info.id,
    name: info.name,
    size: info.size,
    mimeType: info.mimeType,
    sourceUrl: fileSourceUrl(info.id),
    downloadUrl: fileDownloadUrl(info.id)
  }
}

/**
 * Resolve a public list into internal entries plus a renderer-safe preview.
 * This function never creates a batch and never queues any entry.
 */
export async function resolvePixeldrainList(
  value: unknown,
  options: PixeldrainRequestOptions = {}
): Promise<PixeldrainListResolution> {
  const link = parsePixeldrainLink(value)
  if (link.kind !== 'list') throw invalidLink()

  const record = await requestJson(
    listApiUrl(link.id),
    responseByteLimit(LIST_MAX_RESPONSE_BYTES, options),
    options
  )

  const listId = parseProviderId(record.id)
  if (listId !== link.id) throw invalidResponse()

  const title = parseListTitle(record.title)
  const fileCount = parseCount(record.file_count)
  if (fileCount > MAX_PIXELDRAIN_LIST_FILES) {
    throw tooManyFiles()
  }

  const rawFiles = record.files
  if (!Array.isArray(rawFiles)) throw invalidResponse()
  if (rawFiles.length > MAX_PIXELDRAIN_LIST_FILES) throw tooManyFiles()
  if (rawFiles.length !== fileCount) throw invalidResponse()

  const entries = rawFiles.map((raw, position) => parseListFile(raw, position))
  const entryIds = new Set<string>()
  for (const entry of entries) {
    if (entryIds.has(entry.entryId)) throw invalidResponse()
    entryIds.add(entry.entryId)
  }

  const preview = buildPreview(title, entries)

  return {
    kind: 'list',
    listId,
    title,
    sourceUrl: listSourceUrl(listId),
    preview,
    entries
  }
}

/** Resolve a canonical public link based on its parsed kind. */
export async function resolvePixeldrainLink(
  value: unknown,
  options: PixeldrainRequestOptions = {}
): Promise<PixeldrainResolution> {
  const link = parsePixeldrainLink(value)
  return link.kind === 'file'
    ? resolvePixeldrainFile(link.sourceUrl, options)
    : resolvePixeldrainList(link.sourceUrl, options)
}

/** Create an adapter with shared fetch/timeout defaults for later integration. */
export function createPixeldrainAdapter(
  defaults: PixeldrainRequestOptions = {}
): PixeldrainAdapter {
  return {
    parseLink: parsePixeldrainLink,
    resolveFile: (value, options) =>
      resolvePixeldrainFile(value, { ...defaults, ...options }),
    resolveList: (value, options) =>
      resolvePixeldrainList(value, { ...defaults, ...options }),
    resolveLink: (value, options) =>
      resolvePixeldrainLink(value, { ...defaults, ...options })
  }
}
