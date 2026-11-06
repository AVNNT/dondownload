import type { DownloadStatus } from '@shared/types'

export interface Aria2File {
  path: string
  length: number
  completedLength: number
}

export interface Aria2StatusSnapshot {
  gid: string
  status: string
  dir: string
  totalLength: number
  completedLength: number
  downloadSpeed: number
  errorCode: number
  errorMessage: string
  files: Aria2File[]
}

export interface RpcRequest {
  jsonrpc: '2.0'
  id: string
  method: string
  params: unknown[]
}

export type RpcParseResult =
  | { ok: true; result: unknown }
  | { ok: false; code: number; message: string }

export function buildRpcRequest(
  id: number,
  method: string,
  secret: string,
  params: unknown[] = []
): RpcRequest {
  return {
    jsonrpc: '2.0',
    id: String(id),
    method,
    params: [`token:${secret}`, ...params]
  }
}

/**
 * Parse the untrusted JSON-RPC envelope returned by aria2. Only the standard
 * result/error shape is accepted; anything else is reported as a protocol error.
 */
export function parseRpcResponse(payload: unknown): RpcParseResult {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, code: -1, message: 'Malformed response from aria2.' }
  }

  const record = payload as Record<string, unknown>
  if (record.error !== undefined && record.error !== null) {
    const error = record.error
    if (typeof error === 'object' && error !== null) {
      const errorRecord = error as Record<string, unknown>
      const code =
        typeof errorRecord.code === 'number' && Number.isFinite(errorRecord.code)
          ? errorRecord.code
          : -1
      const message =
        typeof errorRecord.message === 'string' && errorRecord.message.length > 0
          ? errorRecord.message
          : 'aria2 returned an unspecified error.'
      return { ok: false, code, message }
    }
    return { ok: false, code: -1, message: 'aria2 returned an invalid error.' }
  }

  if (!('result' in record)) {
    return { ok: false, code: -1, message: 'aria2 response did not contain a result.' }
  }

  return { ok: true, result: record.result }
}

function asNonNegativeNumber(value: unknown): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : 0
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
  }
  return 0
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * Validate and normalise aria2.tellStatus output before it reaches the
 * download manager or renderer.
 */
export function parseAria2Status(payload: unknown): Aria2StatusSnapshot {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('Malformed download status from aria2.')
  }

  const record = payload as Record<string, unknown>
  const gid = asString(record.gid)
  const status = asString(record.status)
  if (!/^[0-9a-f]{16}$/i.test(gid) || status.length === 0) {
    throw new Error('Incomplete download status from aria2.')
  }

  const rawFiles = Array.isArray(record.files) ? record.files : []
  const files: Aria2File[] = rawFiles.map((entry) => {
    const file =
      typeof entry === 'object' && entry !== null
        ? (entry as Record<string, unknown>)
        : {}
    return {
      path: asString(file.path),
      length: asNonNegativeNumber(file.length),
      completedLength: asNonNegativeNumber(file.completedLength)
    }
  })

  return {
    gid,
    status,
    dir: asString(record.dir),
    totalLength: asNonNegativeNumber(record.totalLength),
    completedLength: asNonNegativeNumber(record.completedLength),
    downloadSpeed: asNonNegativeNumber(record.downloadSpeed),
    errorCode: asNonNegativeNumber(record.errorCode),
    errorMessage: asString(record.errorMessage),
    files
  }
}

export function mapAria2Status(status: string): DownloadStatus {
  switch (status) {
    case 'active':
      return 'active'
    case 'waiting':
      return 'waiting'
    case 'paused':
      return 'paused'
    case 'complete':
      return 'complete'
    case 'error':
      return 'error'
    case 'removed':
      return 'error'
    default:
      return 'queued'
  }
}

/**
 * Raw aria2 messages that identify the real failure even when aria2 reports the
 * generic "unknown error" code (1). Matched case-insensitively.
 */
const MESSAGE_HINTS: ReadonlyArray<{ pattern: RegExp; errorCode: number }> = [
  { pattern: /\btimeout\b/i, errorCode: 2 },
  { pattern: /\bno uri available\b/i, errorCode: 22 },
  { pattern: /too slow/i, errorCode: 5 },
  { pattern: /connection.*(?:reset|refused|closed|aborted)|network/i, errorCode: 6 },
  { pattern: /not found|no such file/i, errorCode: 3 },
  { pattern: /unauthori[sz]ed|authentication|forbidden|\b401\b|\b403\b/i, errorCode: 24 },
  { pattern: /no space left/i, errorCode: 9 }
]

/**
 * Plain-language, actionable text for an aria2 error code. The raw aria2
 * message is deliberately not part of this text; it is kept separately as
 * technical detail on the download record.
 */
export function aria2ErrorHint(errorCode: number): string {
  switch (errorCode) {
    case 2:
      return 'The server stopped responding.'
    case 3:
    case 4:
      return "The file isn't on the server (anymore)."
    case 5:
      return 'The download got too slow and was stopped.'
    case 6:
      return 'The connection was interrupted.'
    case 9:
      return 'Not enough free disk space.'
    case 13:
      return 'A file with this name already exists. Choose a different name.'
    case 17:
      return 'Windows could not write the file. Check the folder permissions or free space.'
    case 18:
      return 'The download folder could not be created. Choose another folder.'
    case 19:
      return "Couldn't find that website. Check the address or your connection."
    case 22:
      return 'The server sent a broken response.'
    case 23:
      return 'The server redirected too many times.'
    case 24:
      return 'This file needs a sign-in.'
    default:
      return "The download couldn't finish."
  }
}

/**
 * The hint for a failure, preferring the raw message when aria2 reported the
 * generic "unknown error" code but the message names a known cause.
 */
export function aria2FailureHint(errorCode: number, errorMessage: string): string {
  if (errorCode === 0 || errorCode === 1) {
    const detail = errorMessage.trim()
    if (detail.length > 0) {
      for (const entry of MESSAGE_HINTS) {
        if (entry.pattern.test(detail)) return aria2ErrorHint(entry.errorCode)
      }
    }
  }
  return aria2ErrorHint(errorCode)
}

/** User-facing, plain-language failure text (without technical detail). */
export function describeAria2Failure(
  errorCode: number,
  errorMessage: string
): string {
  return aria2FailureHint(errorCode, errorMessage)
}

/**
 * Raw aria2 detail kept next to the friendly text so a user can copy it when
 * asking for help. Never shown in the row itself.
 */
export function aria2FailureDetail(
  errorCode: number,
  errorMessage: string
): string {
  const detail = errorMessage.trim()
  return detail.length > 0
    ? `aria2 code ${errorCode}: ${detail}`
    : `aria2 code ${errorCode}`
}
