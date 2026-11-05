import {
  parseAnalyzeMediaInput,
  parseMediaAnalysis,
  parseMediaJob,
  parseMediaJobId,
  parseMediaQueueInput,
  type AnalyzeMediaInput,
  type MediaAnalysis,
  type MediaJob,
  type MediaOutputFormat,
  type MediaQueueInput
} from './media'
import type { SniffedMediaInput } from './sniffedMedia'
import { ValidationError } from './validation'

/**
 * Strict native-bridge contract for Milestone 3A media operations.
 *
 * The existing `queue-download` operation, its version, and its
 * `/queue-download` route are intentionally untouched in `nativeBridge.ts`.
 * These operations travel over the same authenticated loopback listener and
 * bearer token when Worker C wires them up.
 */

export const MEDIA_NATIVE_OPERATIONS = [
  'analyze-media',
  'queue-media',
  'media-status',
  'cancel-media'
] as const
export type MediaNativeOperation = (typeof MEDIA_NATIVE_OPERATIONS)[number]

export const MEDIA_BRIDGE_ROUTES = {
  analyze: '/analyze-media',
  queue: '/queue-media',
  status: '/media-status',
  cancel: '/cancel-media'
} as const
export type MediaBridgeRoute =
  (typeof MEDIA_BRIDGE_ROUTES)[keyof typeof MEDIA_BRIDGE_ROUTES]

export const MEDIA_BRIDGE_ROUTE_OPERATIONS: Readonly<
  Record<MediaBridgeRoute, MediaNativeOperation>
> = {
  [MEDIA_BRIDGE_ROUTES.analyze]: 'analyze-media',
  [MEDIA_BRIDGE_ROUTES.queue]: 'queue-media',
  [MEDIA_BRIDGE_ROUTES.status]: 'media-status',
  [MEDIA_BRIDGE_ROUTES.cancel]: 'cancel-media'
}

/** A browser -> native-host message for one media operation. */
export type NativeMediaRequest =
  | { type: 'analyze-media'; url: string }
  | {
      type: 'queue-media'
      analysisId: string
      optionId: string
      force?: true
      outputFormat?: MediaOutputFormat
    }
  | { type: 'media-status'; jobId: string }
  | { type: 'cancel-media'; jobId: string }

/** The native host -> desktop loopback request body. */
export interface MediaAnalyzeRequest {
  url: string
}

export type MediaQueueRequest = MediaQueueInput

export interface MediaStatusRequest {
  jobId: string
}

export interface MediaCancelRequest {
  jobId: string
}

export interface MediaBridgeError {
  code: string
  message: string
}

export type MediaBridgeResponse =
  | { ok: true; operation: 'analyze-media'; analysis: MediaAnalysis }
  | { ok: true; operation: 'queue-media'; job: MediaJob }
  | { ok: true; operation: 'media-status'; job: MediaJob }
  | { ok: true; operation: 'cancel-media'; job: MediaJob }
  | { ok: false; error: MediaBridgeError }

/**
 * Capabilities the loopback server exposes to the native host. Worker C wires
 * an implementation of this interface into `nativeBridge/server.ts`.
 */
export interface MediaBridgeTarget {
  analyzeMedia(input: AnalyzeMediaInput): Promise<MediaAnalysis>
  queueMedia(input: MediaQueueInput): Promise<MediaJob>
  getMediaStatus(jobId: string): Promise<MediaJob>
  cancelMedia(jobId: string): Promise<MediaJob>
  /**
   * Additive NDM-style stream download. The input has already been validated
   * by `parseSniffedMediaInput` in the bridge; the manager creates a normal
   * media job so progress/status use the existing media UI.
   */
  queueSniffedMedia?(input: SniffedMediaInput): Promise<MediaJob>
}

const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,63}$/
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

function asPlainObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError('Invalid media bridge payload.')
  }
  return value as Record<string, unknown>
}

function exactKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): void {
  for (const key of Object.keys(record)) {
    if (!required.includes(key) && !optional.includes(key)) {
      throw new ValidationError('The media bridge payload contains unsupported fields.')
    }
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      throw new ValidationError('The media bridge payload is missing required fields.')
    }
  }
}

function readForce(record: Record<string, unknown>): boolean {
  if (!Object.prototype.hasOwnProperty.call(record, 'force')) return false
  if (typeof record.force !== 'boolean') {
    throw new ValidationError('The force option must be true or false.')
  }
  return record.force
}

function analyzeFields(record: Record<string, unknown>): MediaAnalyzeRequest {
  return parseAnalyzeMediaInput({ url: record.url })
}

function queueFields(record: Record<string, unknown>): MediaQueueRequest {
  const force = readForce(record)
  return parseMediaQueueInput({
    analysisId: record.analysisId,
    optionId: record.optionId,
    ...(force ? { force } : {}),
    ...(record.outputFormat === undefined
      ? {}
      : { outputFormat: record.outputFormat })
  })
}

function statusFields(record: Record<string, unknown>): MediaStatusRequest {
  return { jobId: parseMediaJobId(record.jobId) }
}

/** Strict parser for the native-host -> desktop loopback bodies. */
export function parseMediaAnalyzeRequest(value: unknown): MediaAnalyzeRequest {
  const record = asPlainObject(value)
  exactKeys(record, ['url'])
  return analyzeFields(record)
}

export function parseMediaQueueRequest(value: unknown): MediaQueueRequest {
  const record = asPlainObject(value)
  exactKeys(record, ['analysisId', 'optionId'], ['force', 'outputFormat'])
  return queueFields(record)
}

export function parseMediaStatusRequest(value: unknown): MediaStatusRequest {
  const record = asPlainObject(value)
  exactKeys(record, ['jobId'])
  return statusFields(record)
}

export function parseMediaCancelRequest(value: unknown): MediaCancelRequest {
  const record = asPlainObject(value)
  exactKeys(record, ['jobId'])
  return statusFields(record)
}

/** Strict parser for the browser -> native-host message envelope. */
export function parseNativeMediaRequest(value: unknown): NativeMediaRequest {
  const record = asPlainObject(value)
  const type = record.type

  switch (type) {
    case 'analyze-media':
      exactKeys(record, ['type', 'url'])
      return { type, ...analyzeFields(record) }
    case 'queue-media':
      exactKeys(record, ['type', 'analysisId', 'optionId'], [
        'force',
        'outputFormat'
      ])
      return { type, ...queueFields(record) }
    case 'media-status':
      exactKeys(record, ['type', 'jobId'])
      return { type, ...statusFields(record) }
    case 'cancel-media':
      exactKeys(record, ['type', 'jobId'])
      return { type, ...statusFields(record) }
    default:
      throw new ValidationError('Unsupported media bridge operation.')
  }
}

function readBridgeError(value: unknown): MediaBridgeError {
  const record = asPlainObject(value)
  exactKeys(record, ['code', 'message'])
  const code = record.code
  const message = record.message
  if (
    typeof code !== 'string' ||
    !ERROR_CODE.test(code) ||
    typeof message !== 'string' ||
    message.trim().length === 0 ||
    message.length > 2000 ||
    CONTROL_CHARACTERS.test(message)
  ) {
    throw new ValidationError('Invalid media bridge error.')
  }
  return { code, message }
}

/** Strict parser for the desktop -> native-host response. */
export function parseMediaBridgeResponse(value: unknown): MediaBridgeResponse {
  const record = asPlainObject(value)
  if (record.ok === false) {
    exactKeys(record, ['ok', 'error'])
    return { ok: false, error: readBridgeError(record.error) }
  }
  if (record.ok !== true) {
    throw new ValidationError('Invalid media bridge response.')
  }

  switch (record.operation) {
    case 'analyze-media':
      exactKeys(record, ['ok', 'operation', 'analysis'])
      return {
        ok: true,
        operation: 'analyze-media',
        analysis: parseMediaAnalysis(record.analysis)
      }
    case 'queue-media':
      exactKeys(record, ['ok', 'operation', 'job'])
      return {
        ok: true,
        operation: 'queue-media',
        job: parseMediaJob(record.job)
      }
    case 'media-status':
      exactKeys(record, ['ok', 'operation', 'job'])
      return {
        ok: true,
        operation: 'media-status',
        job: parseMediaJob(record.job)
      }
    case 'cancel-media':
      exactKeys(record, ['ok', 'operation', 'job'])
      return {
        ok: true,
        operation: 'cancel-media',
        job: parseMediaJob(record.job)
      }
    default:
      throw new ValidationError('Unsupported media bridge response.')
  }
}
