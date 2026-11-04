import { ValidationError, normalizeHttpUrl } from './validation'

/**
 * Constants shared by the desktop bridge and its focused tests. The Windows
 * native messaging executable mirrors these limits in C#; it cannot import
 * TypeScript, so keep the two definitions in sync.
 */
export const NATIVE_BRIDGE_APP = 'DonDownload'
export const NATIVE_BRIDGE_VERSION = 1
export const NATIVE_HOST_NAME = 'com.dondownload.bridge'
export const NATIVE_BRIDGE_CHANNEL = 'queue-download'
export const NATIVE_BRIDGE_STATE_FILE = 'native-bridge.json'

/** Chrome's native messaging limit is 1 MiB per message. */
export const MAX_NATIVE_FRAME_BYTES = 1024 * 1024
/** The loopback HTTP body is much smaller than a native frame on purpose. */
export const MAX_BRIDGE_BODY_BYTES = 16 * 1024
export const MAX_BRIDGE_TOKEN_LENGTH = 64

const TOKEN_PATTERN = /^[0-9a-f]{64}$/

export interface NativeBridgeEndpoint {
  app: typeof NATIVE_BRIDGE_APP
  version: typeof NATIVE_BRIDGE_VERSION
  port: number
  token: string
  pid: number
  startedAt: number
}

export interface NativeQueueDownloadMessage {
  type: typeof NATIVE_BRIDGE_CHANNEL
  url: string
  /** Explicit user action only: add a second copy of an unfinished URL. */
  force?: true
}

export interface QueueDownloadRequest {
  url: string
  /** Explicit user action only: add a second copy of an unfinished URL. */
  force?: true
}

function asPlainObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError('Invalid bridge request.')
  }
  return value as Record<string, unknown>
}

function hasExactKeys(
  record: Record<string, unknown>,
  expected: readonly string[]
): boolean {
  const keys = Object.keys(record)
  if (keys.length !== expected.length) return false
  return expected.every((key) => Object.prototype.hasOwnProperty.call(record, key))
}

/**
 * The force field is a narrow boolean opt-in, never a command or a path/file
 * name extension. Absent or false simply means normal duplicate prevention.
 */
function readOptionalForce(record: Record<string, unknown>): boolean {
  if (!Object.prototype.hasOwnProperty.call(record, 'force')) return false
  if (typeof record.force !== 'boolean') {
    throw new ValidationError('The force option must be true or false.')
  }
  return record.force
}

/**
 * The browser -> native-host message. There is exactly one supported
 * operation and no command, path, file name or filesystem fields.
 */
export function parseNativeQueueMessage(value: unknown): NativeQueueDownloadMessage {
  const record = asPlainObject(value)
  const force = readOptionalForce(record)
  if (
    !hasExactKeys(record, ['type', 'url']) &&
    !hasExactKeys(record, ['type', 'url', 'force'])
  ) {
    throw new ValidationError('Invalid bridge message.')
  }
  if (record.type !== NATIVE_BRIDGE_CHANNEL) {
    throw new ValidationError('Unsupported bridge operation.')
  }
  return {
    type: NATIVE_BRIDGE_CHANNEL,
    url: normalizeHttpUrl(record.url),
    ...(force ? { force: true as const } : {})
  }
}

/**
 * The native host -> desktop loopback endpoint body. It intentionally carries
 * only the URL and the optional explicit-repeat flag; the desktop app chooses
 * the download directory and file name.
 */
export function parseQueueDownloadRequest(value: unknown): QueueDownloadRequest {
  const record = asPlainObject(value)
  const force = readOptionalForce(record)
  if (!hasExactKeys(record, ['url']) && !hasExactKeys(record, ['url', 'force'])) {
    throw new ValidationError('Invalid bridge request.')
  }
  return {
    url: normalizeHttpUrl(record.url),
    ...(force ? { force: true as const } : {})
  }
}

export function parseNativeBridgeEndpoint(value: unknown): NativeBridgeEndpoint {
  const record = asPlainObject(value)
  if (record.app !== NATIVE_BRIDGE_APP) {
    throw new ValidationError('The bridge endpoint belongs to another application.')
  }
  if (record.version !== NATIVE_BRIDGE_VERSION) {
    throw new ValidationError('Unsupported bridge endpoint version.')
  }

  const port = record.port
  if (
    typeof port !== 'number' ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new ValidationError('Invalid bridge port.')
  }

  if (
    typeof record.token !== 'string' ||
    record.token.length > MAX_BRIDGE_TOKEN_LENGTH ||
    !TOKEN_PATTERN.test(record.token)
  ) {
    throw new ValidationError('Invalid bridge token.')
  }

  for (const field of ['pid', 'startedAt'] as const) {
    const candidate = record[field]
    if (
      typeof candidate !== 'number' ||
      !Number.isFinite(candidate) ||
      candidate <= 0
    ) {
      throw new ValidationError('Invalid bridge endpoint metadata.')
    }
  }

  return {
    app: NATIVE_BRIDGE_APP,
    version: NATIVE_BRIDGE_VERSION,
    port,
    token: record.token,
    pid: record.pid as number,
    startedAt: record.startedAt as number
  }
}
