// Strict, extension-side validation for the media bridge DTOs. The desktop
// app and the native host validate first; this copy makes the content script
// and service worker fail closed on a malformed or unexpected response before
// anything reaches the overlay. It intentionally mirrors the frozen contract
// in src/shared/mediaBridge.ts without importing TypeScript.

export const MAX_MEDIA_TITLE_LENGTH = 500
export const MAX_MEDIA_LABEL_LENGTH = 240
export const MAX_MEDIA_ERROR_LENGTH = 2000
export const MAX_MEDIA_OPTIONS = 200

const OPAQUE_MEDIA_ID = /^[A-Za-z0-9_-]{1,128}$/
const CONTAINER = /^[a-z0-9][a-z0-9._+-]{0,31}$/
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,63}$/
const JOB_STATUSES = new Set([
  'queued',
  'analyzing',
  'downloading',
  'merging',
  'complete',
  'error',
  'cancelled',
  'interrupted'
])

function fail(message) {
  throw new Error(message)
}

function asPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('Invalid media bridge payload.')
  }
  return value
}

function exactKeys(record, required, optional = []) {
  for (const key of Object.keys(record)) {
    if (!required.includes(key) && !optional.includes(key)) {
      fail('The media bridge payload contains unsupported fields.')
    }
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      fail('The media bridge payload is missing required fields.')
    }
  }
}

function textValue(record, key, maximum) {
  const value = record[key]
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > maximum ||
    CONTROL_CHARACTERS.test(value)
  ) {
    fail('The media bridge payload contains an invalid text field.')
  }
  return value
}

function nullableTextValue(record, key, maximum) {
  if (record[key] === null) return null
  return textValue(record, key, maximum)
}

function integerValue(record, key, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  const value = record[key]
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    fail('The media bridge payload contains an invalid number.')
  }
  return value
}

function nullableIntegerValue(record, key, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  if (record[key] === null) return null
  return integerValue(record, key, minimum, maximum)
}

function finiteNumberValue(record, key, minimum, maximum) {
  const value = record[key]
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    fail('The media bridge payload contains an invalid number.')
  }
  return value
}

function nullableFiniteNumberValue(record, key, minimum, maximum) {
  if (record[key] === null) return null
  return finiteNumberValue(record, key, minimum, maximum)
}

function booleanValue(record, key) {
  const value = record[key]
  if (typeof value !== 'boolean') {
    fail('The media bridge payload contains an invalid flag.')
  }
  return value
}

function opaqueId(value, label) {
  if (typeof value !== 'string' || !OPAQUE_MEDIA_ID.test(value)) {
    fail(`Invalid ${label}.`)
  }
  return value
}

export function isOpaqueMediaId(value) {
  return typeof value === 'string' && OPAQUE_MEDIA_ID.test(value)
}

export function parseMediaFormatOption(value) {
  const record = asPlainObject(value)
  exactKeys(
    record,
    [
      'kind',
      'optionId',
      'label',
      'container',
      'width',
      'height',
      'fps',
      'videoCodec',
      'audioCodec',
      'hasAudio',
      'requiresMerge',
      'filesizeBytes'
    ],
    ['estimatedBytes', 'sizeIsEstimate']
  )

  const kind = record.kind
  if (kind !== 'video' && kind !== 'audio') {
    fail('Unknown media format kind.')
  }

  const container = record.container
  if (typeof container !== 'string' || !CONTAINER.test(container)) {
    fail('Invalid media container.')
  }

  const option = {
    kind,
    optionId: opaqueId(record.optionId, 'media option identifier'),
    label: textValue(record, 'label', MAX_MEDIA_LABEL_LENGTH),
    container,
    width: nullableIntegerValue(record, 'width', 1, 65_535),
    height: nullableIntegerValue(record, 'height', 1, 65_535),
    fps: nullableFiniteNumberValue(record, 'fps', 0, 1_000),
    videoCodec: nullableTextValue(record, 'videoCodec', 64),
    audioCodec: nullableTextValue(record, 'audioCodec', 64),
    hasAudio: booleanValue(record, 'hasAudio'),
    requiresMerge: booleanValue(record, 'requiresMerge'),
    filesizeBytes: nullableIntegerValue(record, 'filesizeBytes', 0),
    estimatedBytes:
      record.estimatedBytes === undefined
        ? null
        : nullableIntegerValue(record, 'estimatedBytes', 0),
    sizeIsEstimate:
      record.sizeIsEstimate === undefined
        ? false
        : booleanValue(record, 'sizeIsEstimate')
  }

  if (kind === 'video' && !option.hasAudio) {
    fail('A video option must produce video with audio.')
  }
  if (kind === 'audio' && (!option.hasAudio || option.videoCodec !== null)) {
    fail('An audio option must not contain video.')
  }
  return option
}

export function parseMediaAnalysis(value) {
  const record = asPlainObject(value)
  exactKeys(record, [
    'analysisId',
    'title',
    'durationSeconds',
    'options',
    'bestVideoOptionId',
    'bestAudioOptionId',
    'expiresAt'
  ])

  if (!Array.isArray(record.options) || record.options.length > MAX_MEDIA_OPTIONS) {
    fail('The media bridge payload contains an invalid list.')
  }
  const options = record.options.map(parseMediaFormatOption)
  const byId = new Map()
  for (const option of options) {
    if (byId.has(option.optionId)) {
      fail('Duplicate media option identifier.')
    }
    byId.set(option.optionId, option)
  }

  const bestVideoOptionId =
    record.bestVideoOptionId === null
      ? null
      : opaqueId(record.bestVideoOptionId, 'best video option identifier')
  if (bestVideoOptionId !== null) {
    const option = byId.get(bestVideoOptionId)
    if (!option || option.kind !== 'video' || !option.hasAudio) {
      fail('The best video option is not a video option.')
    }
  }

  const bestAudioOptionId =
    record.bestAudioOptionId === null
      ? null
      : opaqueId(record.bestAudioOptionId, 'best audio option identifier')
  if (bestAudioOptionId !== null) {
    const option = byId.get(bestAudioOptionId)
    if (
      !option ||
      option.kind !== 'audio' ||
      !option.hasAudio ||
      option.videoCodec !== null
    ) {
      fail('The best audio option is not an audio option.')
    }
  }

  return {
    analysisId: opaqueId(record.analysisId, 'media analysis identifier'),
    title: textValue(record, 'title', MAX_MEDIA_TITLE_LENGTH),
    durationSeconds: nullableFiniteNumberValue(
      record,
      'durationSeconds',
      0,
      Number.MAX_SAFE_INTEGER
    ),
    options,
    bestVideoOptionId,
    bestAudioOptionId,
    expiresAt: integerValue(record, 'expiresAt', 1)
  }
}

export function parseMediaJob(value) {
  const record = asPlainObject(value)
  exactKeys(record, [
    'id',
    'analysisId',
    'optionId',
    'kind',
    'title',
    'label',
    'status',
    'completedBytes',
    'totalBytes',
    'speedBps',
    'errorMessage',
    'createdAt',
    'updatedAt',
    'completedAt'
  ])

  const kind = record.kind
  if (kind !== 'video' && kind !== 'audio') {
    fail('Unknown media format kind.')
  }
  if (typeof record.status !== 'string' || !JOB_STATUSES.has(record.status)) {
    fail('Unknown media job status.')
  }

  return {
    id: opaqueId(record.id, 'media job identifier'),
    analysisId: opaqueId(record.analysisId, 'media analysis identifier'),
    optionId: opaqueId(record.optionId, 'media option identifier'),
    kind,
    title: textValue(record, 'title', MAX_MEDIA_TITLE_LENGTH),
    label: textValue(record, 'label', MAX_MEDIA_LABEL_LENGTH),
    status: record.status,
    completedBytes: integerValue(record, 'completedBytes', 0),
    totalBytes: nullableIntegerValue(record, 'totalBytes', 0),
    speedBps: finiteNumberValue(record, 'speedBps', 0, Number.MAX_SAFE_INTEGER),
    errorMessage: nullableTextValue(record, 'errorMessage', MAX_MEDIA_ERROR_LENGTH),
    createdAt: integerValue(record, 'createdAt', 1),
    updatedAt: integerValue(record, 'updatedAt', 1),
    completedAt: nullableIntegerValue(record, 'completedAt', 1)
  }
}

function readBridgeError(value) {
  const record = asPlainObject(value)
  exactKeys(record, ['code', 'message'])
  const code = record.code
  const message = record.message
  if (
    typeof code !== 'string' ||
    !ERROR_CODE.test(code) ||
    typeof message !== 'string' ||
    message.trim().length === 0 ||
    message.length > MAX_MEDIA_ERROR_LENGTH ||
    CONTROL_CHARACTERS.test(message)
  ) {
    fail('Invalid media bridge error.')
  }
  return { code, message }
}

export function parseMediaBridgeResponse(value) {
  const record = asPlainObject(value)
  if (record.ok === false) {
    exactKeys(record, ['ok', 'error'])
    return { ok: false, error: readBridgeError(record.error) }
  }
  if (record.ok !== true) {
    fail('Invalid media bridge response.')
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
      fail('Unsupported media bridge response.')
  }
}
