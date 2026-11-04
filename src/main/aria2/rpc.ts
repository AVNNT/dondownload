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

export function aria2ErrorHint(errorCode: number): string {
  switch (errorCode) {
    case 3:
    case 4:
      return 'The server could not find the file. Check the URL or try again later.'
    case 5:
      return 'The download was too slow and aria2 stopped it. Try again or use another source.'
    case 6:
      return 'A network error interrupted the download. Check your connection and retry.'
    case 9:
      return 'There is not enough free disk space for this download.'
    case 13:
      return 'A file with this name already exists. Choose a different file name.'
    case 17:
      return 'Windows could not write the file. Check the download folder permissions or free space.'
    case 18:
      return 'The download folder could not be created. Choose another folder or check permissions.'
    case 19:
      return 'The host name could not be resolved. Check the URL and your internet connection.'
    case 22:
      return 'The server returned an invalid HTTP response.'
    case 23:
      return 'The server redirected too many times.'
    case 24:
      return 'The server rejected the request because authentication is required.'
    default:
      return 'aria2 could not complete this download.'
  }
}

export function describeAria2Failure(
  errorCode: number,
  errorMessage: string
): string {
  const detail = errorMessage.trim()
  const hint = aria2ErrorHint(errorCode)
  if (detail.length > 0) {
    return `${hint} (${detail})`
  }
  return `${hint} (aria2 code ${errorCode})`
}
