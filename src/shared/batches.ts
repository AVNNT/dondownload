import { ValidationError, normalizeHttpUrl } from './validation'

/**
 * Shared, renderer-safe batch/collection contracts for Milestone 3B.
 *
 * Public DTOs never contain a source URL, disk path, credential, cookie,
 * request header, guest token, raw selector or provider-internal metadata.
 * Those values may exist only on the internal persistence records below, which
 * stay in the main process and are never sent over IPC or the native bridge.
 *
 * A batch is a parent container. Each item points at an existing media job or
 * download job through an opaque `childId`, or has `childId: null` while the
 * child has not been created yet. Items fail, retry and cancel independently;
 * the batch itself can be cancelled as a group.
 *
 * Playlists and Pixeldrain lists are first resolved into an ephemeral
 * `CollectionPreview`. The preview exposes only opaque preview/entry IDs,
 * bounded display text, positions and a safe availability code. A batch can
 * then be created from an explicit, bounded selection of preview entry IDs;
 * there is no implicit "select all" path.
 */

export const BATCH_KINDS = [
  'media-playlist',
  'pixeldrain-list',
  'direct-urls'
] as const
export type BatchKind = (typeof BATCH_KINDS)[number]

export const BATCH_STATUSES = [
  'queued',
  'running',
  'complete',
  'partial',
  'error',
  'cancelled',
  'interrupted'
] as const
export type BatchStatus = (typeof BATCH_STATUSES)[number]

/** Statuses that represent work a restart can no longer continue. */
export const BATCH_ACTIVE_STATUSES = ['queued', 'running'] as const

export const BATCH_ITEM_KINDS = ['media', 'download'] as const
export type BatchItemKind = (typeof BATCH_ITEM_KINDS)[number]

export const BATCH_ITEM_STATUSES = [
  'queued',
  'running',
  'complete',
  'error',
  'unavailable',
  'skipped',
  'cancelled',
  'interrupted'
] as const
export type BatchItemStatus = (typeof BATCH_ITEM_STATUSES)[number]

export const BATCH_ITEM_ACTIVE_STATUSES = ['queued', 'running'] as const

/**
 * Terminal item statuses that mean "not downloaded" without being a failure.
 * `unavailable` is decided by the provider preview; `skipped` is a deliberate
 * local decision (for example a selected entry that was filtered out safely).
 * Both count towards `BatchProgress.skippedItems` and never towards failures.
 */
export const BATCH_ITEM_SKIPPED_STATUSES = ['unavailable', 'skipped'] as const

export const MAX_BATCH_TITLE_LENGTH = 240
export const MAX_BATCH_LABEL_LENGTH = 240
export const MAX_BATCH_ERROR_LENGTH = 2000
export const MAX_BATCH_SOURCES = 500
export const MAX_BATCH_ITEMS = 5000

export function isBatchKind(value: unknown): value is BatchKind {
  return (
    typeof value === 'string' &&
    (BATCH_KINDS as readonly string[]).includes(value)
  )
}

export function isBatchStatus(value: unknown): value is BatchStatus {
  return (
    typeof value === 'string' &&
    (BATCH_STATUSES as readonly string[]).includes(value)
  )
}

export function isActiveBatchStatus(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    (BATCH_ACTIVE_STATUSES as readonly string[]).includes(value)
  )
}

export function isBatchItemKind(value: unknown): value is BatchItemKind {
  return (
    typeof value === 'string' &&
    (BATCH_ITEM_KINDS as readonly string[]).includes(value)
  )
}

export function isBatchItemStatus(value: unknown): value is BatchItemStatus {
  return (
    typeof value === 'string' &&
    (BATCH_ITEM_STATUSES as readonly string[]).includes(value)
  )
}

export function isActiveBatchItemStatus(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    (BATCH_ITEM_ACTIVE_STATUSES as readonly string[]).includes(value)
  )
}

export function isSkippedBatchItemStatus(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    (BATCH_ITEM_SKIPPED_STATUSES as readonly string[]).includes(value)
  )
}

export function isCollectionPreviewKind(
  value: unknown
): value is CollectionPreviewKind {
  return (
    typeof value === 'string' &&
    (COLLECTION_PREVIEW_KINDS as readonly string[]).includes(value)
  )
}

export function isCollectionEntryAvailability(
  value: unknown
): value is CollectionEntryAvailability {
  return (
    typeof value === 'string' &&
    (COLLECTION_ENTRY_AVAILABILITIES as readonly string[]).includes(value)
  )
}

export function isCollectionEntryErrorCode(
  value: unknown
): value is CollectionEntryErrorCode {
  return (
    typeof value === 'string' &&
    (COLLECTION_ENTRY_ERROR_CODES as readonly string[]).includes(value)
  )
}

/** Aggregate progress derived from items, never from provider guesses. */
export interface BatchProgress {
  totalItems: number
  completedItems: number
  failedItems: number
  /** Items with status `unavailable` or `skipped`; never counted as failed. */
  skippedItems: number
  /** Sum of verified item bytes; skipped/unavailable items contribute nothing. */
  completedBytes: number
  /** Null when any non-skipped item still has an unknown total. */
  totalBytes: number | null
}

/** Renderer-safe item. Contains no URL, path, token, header or selector. */
export interface BatchItem {
  id: string
  batchId: string
  /** Stable display/retry order inside the parent batch. */
  position: number
  kind: BatchItemKind
  status: BatchItemStatus
  title: string
  label: string
  /** Opaque existing media-job or download-job id, or null before creation. */
  childId: string | null
  completedBytes: number
  totalBytes: number | null
  /** Independent per-item failure text; never shared across siblings. */
  errorMessage: string | null
  createdAt: number
  updatedAt: number
  completedAt: number | null
}

/** Renderer-safe parent batch with its items and aggregate progress. */
export interface Batch {
  id: string
  kind: BatchKind
  title: string
  status: BatchStatus
  progress: BatchProgress
  errorMessage: string | null
  createdAt: number
  updatedAt: number
  completedAt: number | null
  items: BatchItem[]
}

/**
 * INTERNAL persistence shape. Must never cross IPC or the native bridge.
 * `sourceUrl` is the normalized source reference needed for a later retry; no
 * cookies, headers, tokens, selectors or raw provider metadata are stored.
 */
export interface BatchRecord {
  id: string
  kind: BatchKind
  title: string
  status: BatchStatus
  sourceUrl: string | null
  /** Selection policy retained internally so failed children retry identically. */
  mediaQuality?: BatchMediaQuality | null
  maxBytesPerItem?: number | null
  errorMessage: string | null
  createdAt: number
  updatedAt: number
  completedAt: number | null
}

/** INTERNAL persistence shape for one child; never sent over IPC. */
export interface BatchItemRecord {
  id: string
  batchId: string
  position: number
  kind: BatchItemKind
  status: BatchItemStatus
  title: string
  label: string
  childId: string | null
  completedBytes: number
  totalBytes: number | null
  errorMessage: string | null
  sourceUrl: string | null
  createdAt: number
  updatedAt: number
  completedAt: number | null
}

/** Strict batch creation input. `sources` are normalized HTTP(S) URLs. */
export interface CreateBatchInput {
  kind: BatchKind
  title: string
  sources: string[]
}

/** Strict target for individual item retry/cancel actions. */
export interface BatchItemTargetInput {
  batchId: string
  itemId: string
}

/** Strict target for a group cancel. */
export interface BatchTargetInput {
  batchId: string
}

/* ------------------------------------------------------------------------- *
 * Collection selection previews
 * ------------------------------------------------------------------------- */

export const COLLECTION_PREVIEW_KINDS = [
  'playlist',
  'pixeldrain-list'
] as const
export type CollectionPreviewKind = (typeof COLLECTION_PREVIEW_KINDS)[number]

export const COLLECTION_ENTRY_AVAILABILITIES = [
  'available',
  'unavailable'
] as const
export type CollectionEntryAvailability =
  (typeof COLLECTION_ENTRY_AVAILABILITIES)[number]

/**
 * Stable, renderer-safe reasons for an unavailable preview entry. Provider
 * error text is never forwarded; a producer must map it to one of these codes.
 */
export const COLLECTION_ENTRY_ERROR_CODES = [
  'unavailable',
  'private',
  'removed',
  'region-restricted',
  'age-restricted',
  'members-only',
  'unsupported',
  'too-large',
  'unknown'
] as const
export type CollectionEntryErrorCode =
  (typeof COLLECTION_ENTRY_ERROR_CODES)[number]

export const MAX_COLLECTION_TITLE_LENGTH = 240
export const MAX_COLLECTION_ENTRY_TITLE_LENGTH = 240
export const MAX_COLLECTION_ERROR_REASON_LENGTH = 240
export const MAX_COLLECTION_ENTRIES = 5000
/** A batch can be created from at most this many explicitly selected entries. */
export const MAX_COLLECTION_SELECTION = 500
export const BATCH_MEDIA_QUALITIES = [
  'best',
  '1080p',
  '720p',
  '480p',
  '360p',
  'audio-only'
] as const
export type BatchMediaQuality = (typeof BATCH_MEDIA_QUALITIES)[number]

export interface CollectionEntryQuality {
  quality: BatchMediaQuality
  /** Null when yt-dlp does not report an exact verified byte count. */
  estimatedBytes: number | null
}

export interface CollectionSelectionAvailability {
  previewId: string
  entries: Array<{
    entryId: string
    title: string
    qualities: CollectionEntryQuality[]
  }>
}

/** Renderer-safe preview entry. Contains no URL, path, selector or provider data. */
export interface CollectionEntry {
  /** Opaque preview-local entry ID; never a provider URL or selector. */
  id: string
  /** Stable display order inside the preview. */
  position: number
  title: string
  availability: CollectionEntryAvailability
  /** Present only when unavailable; null for an available entry. */
  errorCode: CollectionEntryErrorCode | null
  /** Short, safe explanation; never a raw provider error or URL. */
  errorReason: string | null
}

/**
 * Renderer-safe, ephemeral selection preview for a playlist or Pixeldrain list.
 * The renderer sends back only `id` plus explicitly selected entry IDs.
 */
export interface CollectionPreview {
  /** Opaque server-generated ID tied to one fresh preview. */
  id: string
  kind: CollectionPreviewKind
  title: string
  entryCount: number
  availableCount: number
  unavailableCount: number
  entries: CollectionEntry[]
}

/** Strict input for analyzing a playlist or Pixeldrain list source URL. */
export interface AnalyzeCollectionInput {
  url: string
}

/**
 * Strict input for creating a batch from a preview. Selection is always
 * explicit: there is no implicit "all entries" form.
 */
export interface CreateCollectionBatchInput {
  previewId: string
  selectedEntryIds: string[]
  /** Optional playlist-only policy; omitted means best video/unlimited. */
  mediaQuality?: BatchMediaQuality
  maxBytesPerItem?: number | null
}

const OPAQUE_ID = /^[A-Za-z0-9_-]{1,128}$/
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/
/** Reject URL- and path-shaped text from a supposedly safe error reason. */
const UNSAFE_REASON_TEXT = /(?:\b[a-z][a-z0-9+.-]*:\/\/)|(?:[A-Za-z]:\\|\\\\[^\\])/i

function asPlainObject(
  value: unknown,
  subject = 'batch'
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError(`Invalid ${subject} payload.`)
  }
  return value as Record<string, unknown>
}

function exactKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
  subject = 'batch'
): void {
  for (const key of Object.keys(record)) {
    if (!required.includes(key) && !optional.includes(key)) {
      throw new ValidationError(
        `The ${subject} payload contains unsupported fields.`
      )
    }
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      throw new ValidationError(
        `The ${subject} payload is missing required fields.`
      )
    }
  }
}

function textValue(
  record: Record<string, unknown>,
  key: string,
  maximum: number,
  subject = 'batch'
): string {
  const value = record[key]
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > maximum ||
    CONTROL_CHARACTERS.test(value)
  ) {
    throw new ValidationError(
      `The ${subject} payload contains an invalid text field.`
    )
  }
  return value
}

function nullableTextValue(
  record: Record<string, unknown>,
  key: string,
  maximum: number,
  subject = 'batch'
): string | null {
  const value = record[key]
  if (value === null) return null
  return textValue(record, key, maximum, subject)
}

function integerValue(
  record: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
  subject = 'batch'
): number {
  const value = record[key]
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new ValidationError(
      `The ${subject} payload contains an invalid number.`
    )
  }
  return value
}

function nullableIntegerValue(
  record: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
  subject = 'batch'
): number | null {
  if (record[key] === null) return null
  return integerValue(record, key, minimum, maximum, subject)
}

function opaqueId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !OPAQUE_ID.test(value)) {
    throw new ValidationError(`Invalid ${label} identifier.`)
  }
  return value
}

export function parseBatchId(value: unknown): string {
  return opaqueId(value, 'batch')
}

export function parseBatchItemId(value: unknown): string {
  return opaqueId(value, 'batch item')
}

/** Generic opaque child reference for an existing media or download job. */
export function parseBatchChildId(value: unknown): string {
  return opaqueId(value, 'child job')
}

/** Opaque server-generated collection preview ID. */
export function parseCollectionPreviewId(value: unknown): string {
  return opaqueId(value, 'collection preview')
}

/** Opaque preview-local collection entry ID. */
export function parseCollectionEntryId(value: unknown): string {
  return opaqueId(value, 'collection entry')
}

/** Normalize a retry source reference; credentials and fragments are removed. */
export function normalizeBatchSourceUrl(value: unknown): string {
  return normalizeHttpUrl(value)
}

function parseKind(value: unknown): BatchKind {
  if (!isBatchKind(value)) {
    throw new ValidationError('Unknown batch kind.')
  }
  return value
}

function parseItemKind(value: unknown): BatchItemKind {
  if (!isBatchItemKind(value)) {
    throw new ValidationError('Unknown batch item kind.')
  }
  return value
}

function parseStatus(value: unknown): BatchStatus {
  if (!isBatchStatus(value)) {
    throw new ValidationError('Unknown batch status.')
  }
  return value
}

function parseItemStatus(value: unknown): BatchItemStatus {
  if (!isBatchItemStatus(value)) {
    throw new ValidationError('Unknown batch item status.')
  }
  return value
}

function parseCollectionPreviewKind(value: unknown): CollectionPreviewKind {
  if (!isCollectionPreviewKind(value)) {
    throw new ValidationError('Unknown collection preview kind.')
  }
  return value
}

function parseCollectionEntryAvailability(
  value: unknown
): CollectionEntryAvailability {
  if (!isCollectionEntryAvailability(value)) {
    throw new ValidationError('Unknown collection entry availability.')
  }
  return value
}

function parseCollectionErrorCode(
  value: unknown
): CollectionEntryErrorCode {
  if (!isCollectionEntryErrorCode(value)) {
    throw new ValidationError('Unknown collection entry error code.')
  }
  return value
}

export function parseBatchProgress(value: unknown): BatchProgress {
  const record = asPlainObject(value)
  exactKeys(record, [
    'totalItems',
    'completedItems',
    'failedItems',
    'skippedItems',
    'completedBytes',
    'totalBytes'
  ])

  const totalItems = integerValue(record, 'totalItems', 0, MAX_BATCH_ITEMS)
  const completedItems = integerValue(record, 'completedItems', 0, totalItems)
  const failedItems = integerValue(record, 'failedItems', 0, totalItems)
  const skippedItems = integerValue(record, 'skippedItems', 0, totalItems)
  if (completedItems + failedItems + skippedItems > totalItems) {
    throw new ValidationError('Batch progress counts exceed the item total.')
  }

  return {
    totalItems,
    completedItems,
    failedItems,
    skippedItems,
    completedBytes: integerValue(record, 'completedBytes', 0),
    totalBytes: nullableIntegerValue(record, 'totalBytes', 0)
  }
}

export function parseBatchItem(value: unknown): BatchItem {
  const record = asPlainObject(value)
  exactKeys(record, [
    'id',
    'batchId',
    'position',
    'kind',
    'status',
    'title',
    'label',
    'childId',
    'completedBytes',
    'totalBytes',
    'errorMessage',
    'createdAt',
    'updatedAt',
    'completedAt'
  ])

  const status = parseItemStatus(record.status)
  const completedBytes = integerValue(record, 'completedBytes', 0)
  const totalBytes = nullableIntegerValue(record, 'totalBytes', 0)
  if (
    isSkippedBatchItemStatus(status) &&
    (completedBytes !== 0 || totalBytes !== null)
  ) {
    throw new ValidationError('A skipped batch item cannot carry byte progress.')
  }

  return {
    id: parseBatchItemId(record.id),
    batchId: parseBatchId(record.batchId),
    position: integerValue(record, 'position', 0, MAX_BATCH_ITEMS - 1),
    kind: parseItemKind(record.kind),
    status,
    title: textValue(record, 'title', MAX_BATCH_TITLE_LENGTH),
    label: textValue(record, 'label', MAX_BATCH_LABEL_LENGTH),
    childId:
      record.childId === null ? null : parseBatchChildId(record.childId),
    completedBytes,
    totalBytes,
    errorMessage: nullableTextValue(
      record,
      'errorMessage',
      MAX_BATCH_ERROR_LENGTH
    ),
    createdAt: integerValue(record, 'createdAt', 1),
    updatedAt: integerValue(record, 'updatedAt', 1),
    completedAt: nullableIntegerValue(record, 'completedAt', 1)
  }
}

function collectionErrorReasonValue(
  record: Record<string, unknown>,
  key: string
): string | null {
  const value = nullableTextValue(
    record,
    key,
    MAX_COLLECTION_ERROR_REASON_LENGTH,
    'collection'
  )
  if (value !== null && UNSAFE_REASON_TEXT.test(value)) {
    throw new ValidationError(
      'The collection payload contains an unsafe error reason.'
    )
  }
  return value
}

export function parseCollectionEntry(value: unknown): CollectionEntry {
  const record = asPlainObject(value, 'collection')
  exactKeys(
    record,
    ['id', 'position', 'title', 'availability', 'errorCode', 'errorReason'],
    [],
    'collection'
  )

  const availability = parseCollectionEntryAvailability(record.availability)
  const errorCode =
    record.errorCode === null
      ? null
      : parseCollectionErrorCode(record.errorCode)
  const errorReason = collectionErrorReasonValue(record, 'errorReason')

  if (availability === 'available') {
    if (errorCode !== null || errorReason !== null) {
      throw new ValidationError(
        'An available collection entry cannot carry an error.'
      )
    }
  } else if (errorCode === null) {
    throw new ValidationError(
      'An unavailable collection entry requires a safe error code.'
    )
  }

  return {
    id: parseCollectionEntryId(record.id),
    position: integerValue(
      record,
      'position',
      0,
      MAX_COLLECTION_ENTRIES - 1,
      'collection'
    ),
    title: textValue(
      record,
      'title',
      MAX_COLLECTION_ENTRY_TITLE_LENGTH,
      'collection'
    ),
    availability,
    errorCode,
    errorReason
  }
}

export function parseCollectionPreview(value: unknown): CollectionPreview {
  const record = asPlainObject(value, 'collection')
  exactKeys(
    record,
    [
      'id',
      'kind',
      'title',
      'entryCount',
      'availableCount',
      'unavailableCount',
      'entries'
    ],
    [],
    'collection'
  )

  const id = parseCollectionPreviewId(record.id)
  const kind = parseCollectionPreviewKind(record.kind)
  const title = textValue(
    record,
    'title',
    MAX_COLLECTION_TITLE_LENGTH,
    'collection'
  )
  const rawEntries = record.entries
  if (!Array.isArray(rawEntries) || rawEntries.length > MAX_COLLECTION_ENTRIES) {
    throw new ValidationError(
      'The collection payload contains an invalid entry list.'
    )
  }

  const entryCount = integerValue(
    record,
    'entryCount',
    0,
    MAX_COLLECTION_ENTRIES,
    'collection'
  )
  if (entryCount !== rawEntries.length) {
    throw new ValidationError(
      'Collection preview entry count does not match its entries.'
    )
  }

  const availableCount = integerValue(
    record,
    'availableCount',
    0,
    entryCount,
    'collection'
  )
  const unavailableCount = integerValue(
    record,
    'unavailableCount',
    0,
    entryCount,
    'collection'
  )
  if (availableCount + unavailableCount !== entryCount) {
    throw new ValidationError(
      'Collection preview availability counts do not match the entry total.'
    )
  }

  const entries = rawEntries.map(parseCollectionEntry)
  const entryIds = new Set<string>()
  const positions = new Set<number>()
  let actualAvailable = 0
  let actualUnavailable = 0
  for (const entry of entries) {
    if (entryIds.has(entry.id)) {
      throw new ValidationError('Duplicate collection entry identifier.')
    }
    if (positions.has(entry.position)) {
      throw new ValidationError('Duplicate collection entry position.')
    }
    if (entry.position >= entryCount) {
      throw new ValidationError('Collection entry position is out of range.')
    }
    entryIds.add(entry.id)
    positions.add(entry.position)
    if (entry.availability === 'available') actualAvailable += 1
    else actualUnavailable += 1
  }
  if (
    actualAvailable !== availableCount ||
    actualUnavailable !== unavailableCount
  ) {
    throw new ValidationError(
      'Collection preview availability counts do not match its entries.'
    )
  }

  const ordered = [...entries].sort(
    (left, right) => left.position - right.position
  )

  return {
    id,
    kind,
    title,
    entryCount,
    availableCount,
    unavailableCount,
    entries: ordered
  }
}

/** Aggregate item state without inventing unknown totals. */
export function summarizeBatchItems(
  items: readonly BatchItem[]
): BatchProgress {
  let completedItems = 0
  let failedItems = 0
  let skippedItems = 0
  let completedBytes = 0
  let totalBytes = 0
  let totalUnknown = false

  for (const item of items) {
    if (item.status === 'complete') completedItems += 1
    if (item.status === 'error') failedItems += 1
    if (isSkippedBatchItemStatus(item.status)) {
      skippedItems += 1
      // A skipped/unavailable item never downloaded anything and must not make
      // the whole batch's byte total unknown.
      continue
    }
    completedBytes += item.completedBytes
    if (item.totalBytes === null) totalUnknown = true
    else totalBytes += item.totalBytes
  }

  return {
    totalItems: items.length,
    completedItems,
    failedItems,
    skippedItems,
    completedBytes,
    totalBytes: totalUnknown ? null : totalBytes
  }
}

function sameProgress(left: BatchProgress, right: BatchProgress): boolean {
  return (
    left.totalItems === right.totalItems &&
    left.completedItems === right.completedItems &&
    left.failedItems === right.failedItems &&
    left.skippedItems === right.skippedItems &&
    left.completedBytes === right.completedBytes &&
    left.totalBytes === right.totalBytes
  )
}

export function parseBatch(value: unknown): Batch {
  const record = asPlainObject(value)
  exactKeys(record, [
    'id',
    'kind',
    'title',
    'status',
    'progress',
    'errorMessage',
    'createdAt',
    'updatedAt',
    'completedAt',
    'items'
  ])

  const id = parseBatchId(record.id)
  const rawItems = record.items
  if (!Array.isArray(rawItems) || rawItems.length > MAX_BATCH_ITEMS) {
    throw new ValidationError('The batch payload contains an invalid item list.')
  }

  const items = rawItems.map(parseBatchItem)
  const itemIds = new Set<string>()
  const positions = new Set<number>()
  for (const item of items) {
    if (item.batchId !== id) {
      throw new ValidationError('A batch item belongs to a different batch.')
    }
    if (itemIds.has(item.id)) {
      throw new ValidationError('Duplicate batch item identifier.')
    }
    if (positions.has(item.position)) {
      throw new ValidationError('Duplicate batch item position.')
    }
    itemIds.add(item.id)
    positions.add(item.position)
  }

  const ordered = [...items].sort((left, right) => left.position - right.position)
  const progress = parseBatchProgress(record.progress)
  if (!sameProgress(progress, summarizeBatchItems(ordered))) {
    throw new ValidationError('Batch progress does not match its items.')
  }

  return {
    id,
    kind: parseKind(record.kind),
    title: textValue(record, 'title', MAX_BATCH_TITLE_LENGTH),
    status: parseStatus(record.status),
    progress,
    errorMessage: nullableTextValue(
      record,
      'errorMessage',
      MAX_BATCH_ERROR_LENGTH
    ),
    createdAt: integerValue(record, 'createdAt', 1),
    updatedAt: integerValue(record, 'updatedAt', 1),
    completedAt: nullableIntegerValue(record, 'completedAt', 1),
    items: ordered
  }
}

function toPublicItem(item: BatchItemRecord): BatchItem {
  return {
    id: item.id,
    batchId: item.batchId,
    position: item.position,
    kind: item.kind,
    status: item.status,
    title: item.title,
    label: item.label,
    childId: item.childId,
    completedBytes: item.completedBytes,
    totalBytes: item.totalBytes,
    errorMessage: item.errorMessage,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    completedAt: item.completedAt
  }
}

/**
 * Convert internal persistence records into the safe public DTO. `sourceUrl`
 * and any future internal field are dropped by construction.
 */
export function toPublicBatch(
  record: BatchRecord,
  items: readonly BatchItemRecord[]
): Batch {
  const ordered = [...items].sort(
    (left, right) => left.position - right.position
  )
  for (const item of ordered) {
    if (item.batchId !== record.id) {
      throw new ValidationError('A batch item belongs to a different batch.')
    }
  }
  const publicItems = ordered.map(toPublicItem)

  return {
    id: record.id,
    kind: record.kind,
    title: record.title,
    status: record.status,
    progress: summarizeBatchItems(publicItems),
    errorMessage: record.errorMessage,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    completedAt: record.completedAt,
    items: publicItems
  }
}

export function parseCreateBatchInput(value: unknown): CreateBatchInput {
  const record = asPlainObject(value)
  exactKeys(record, ['kind', 'title', 'sources'])

  const kind = parseKind(record.kind)
  const title = textValue(record, 'title', MAX_BATCH_TITLE_LENGTH)

  const rawSources = record.sources
  if (
    !Array.isArray(rawSources) ||
    rawSources.length === 0 ||
    rawSources.length > MAX_BATCH_SOURCES
  ) {
    throw new ValidationError(
      `Provide between 1 and ${MAX_BATCH_SOURCES} batch sources.`
    )
  }

  const sources = rawSources.map(normalizeBatchSourceUrl)
  if (kind !== 'direct-urls' && sources.length !== 1) {
    throw new ValidationError('This batch kind accepts exactly one source URL.')
  }

  return { kind, title, sources }
}

export function parseBatchTargetInput(value: unknown): BatchTargetInput {
  const record = asPlainObject(value)
  exactKeys(record, ['batchId'])
  return { batchId: parseBatchId(record.batchId) }
}

export function parseBatchItemTargetInput(
  value: unknown
): BatchItemTargetInput {
  const record = asPlainObject(value)
  exactKeys(record, ['batchId', 'itemId'])
  return {
    batchId: parseBatchId(record.batchId),
    itemId: parseBatchItemId(record.itemId)
  }
}

/** Parse an explicit playlist/Pixeldrain-list analysis request. */
export function parseAnalyzeCollectionInput(
  value: unknown
): AnalyzeCollectionInput {
  const record = asPlainObject(value, 'collection analysis')
  exactKeys(record, ['url'], [], 'collection analysis')
  return { url: normalizeHttpUrl(record.url) }
}

/**
 * Parse an explicit selection from a collection preview. An empty list is
 * rejected, duplicates are rejected and at most `MAX_COLLECTION_SELECTION`
 * entries are accepted. There is intentionally no "all" field.
 */
export function parseCreateCollectionBatchInput(
  value: unknown
): CreateCollectionBatchInput {
  const record = asPlainObject(value, 'collection selection')
  exactKeys(
    record,
    ['previewId', 'selectedEntryIds'],
    ['mediaQuality', 'maxBytesPerItem'],
    'collection selection'
  )

  const previewId = parseCollectionPreviewId(record.previewId)
  const rawIds = record.selectedEntryIds
  if (
    !Array.isArray(rawIds) ||
    rawIds.length === 0 ||
    rawIds.length > MAX_COLLECTION_SELECTION
  ) {
    throw new ValidationError(
      `Select between 1 and ${MAX_COLLECTION_SELECTION} collection entries.`
    )
  }

  const selectedEntryIds = rawIds.map(parseCollectionEntryId)
  if (new Set(selectedEntryIds).size !== selectedEntryIds.length) {
    throw new ValidationError('Duplicate collection entry identifier.')
  }

  let mediaQuality: BatchMediaQuality | undefined
  if (record.mediaQuality !== undefined) {
    if (
      typeof record.mediaQuality !== 'string' ||
      !(BATCH_MEDIA_QUALITIES as readonly string[]).includes(record.mediaQuality)
    ) {
      throw new ValidationError('Choose a supported playlist media quality.')
    }
    mediaQuality = record.mediaQuality as BatchMediaQuality
  }

  let maxBytesPerItem: number | null | undefined
  if (Object.prototype.hasOwnProperty.call(record, 'maxBytesPerItem')) {
    if (record.maxBytesPerItem === null) {
      maxBytesPerItem = null
    } else {
      maxBytesPerItem = integerValue(record, 'maxBytesPerItem', 1, 100 * 1024 ** 3, 'collection selection')
    }
  }

  return {
    previewId,
    selectedEntryIds,
    ...(mediaQuality === undefined ? {} : { mediaQuality }),
    ...(maxBytesPerItem === undefined ? {} : { maxBytesPerItem })
  }
}
