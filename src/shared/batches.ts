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
  'cancelled',
  'interrupted'
] as const
export type BatchItemStatus = (typeof BATCH_ITEM_STATUSES)[number]

export const BATCH_ITEM_ACTIVE_STATUSES = ['queued', 'running'] as const

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

/** Aggregate progress derived from items, never from provider guesses. */
export interface BatchProgress {
  totalItems: number
  completedItems: number
  failedItems: number
  /** Sum of verified item bytes; unknown bytes are not invented. */
  completedBytes: number
  /** Null when any non-cancelled item still has an unknown total. */
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

const OPAQUE_ID = /^[A-Za-z0-9_-]{1,128}$/
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

function asPlainObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError('Invalid batch payload.')
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
      throw new ValidationError(
        'The batch payload contains unsupported fields.'
      )
    }
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      throw new ValidationError('The batch payload is missing required fields.')
    }
  }
}

function textValue(
  record: Record<string, unknown>,
  key: string,
  maximum: number
): string {
  const value = record[key]
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > maximum ||
    CONTROL_CHARACTERS.test(value)
  ) {
    throw new ValidationError('The batch payload contains an invalid text field.')
  }
  return value
}

function nullableTextValue(
  record: Record<string, unknown>,
  key: string,
  maximum: number
): string | null {
  const value = record[key]
  if (value === null) return null
  return textValue(record, key, maximum)
}

function integerValue(
  record: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER
): number {
  const value = record[key]
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new ValidationError('The batch payload contains an invalid number.')
  }
  return value
}

function nullableIntegerValue(
  record: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER
): number | null {
  if (record[key] === null) return null
  return integerValue(record, key, minimum, maximum)
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

export function parseBatchProgress(value: unknown): BatchProgress {
  const record = asPlainObject(value)
  exactKeys(record, [
    'totalItems',
    'completedItems',
    'failedItems',
    'completedBytes',
    'totalBytes'
  ])

  const totalItems = integerValue(record, 'totalItems', 0, MAX_BATCH_ITEMS)
  const completedItems = integerValue(record, 'completedItems', 0, totalItems)
  const failedItems = integerValue(record, 'failedItems', 0, totalItems)
  if (completedItems + failedItems > totalItems) {
    throw new ValidationError('Batch progress counts exceed the item total.')
  }

  return {
    totalItems,
    completedItems,
    failedItems,
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

  return {
    id: parseBatchItemId(record.id),
    batchId: parseBatchId(record.batchId),
    position: integerValue(record, 'position', 0, MAX_BATCH_ITEMS - 1),
    kind: parseItemKind(record.kind),
    status: parseItemStatus(record.status),
    title: textValue(record, 'title', MAX_BATCH_TITLE_LENGTH),
    label: textValue(record, 'label', MAX_BATCH_LABEL_LENGTH),
    childId:
      record.childId === null ? null : parseBatchChildId(record.childId),
    completedBytes: integerValue(record, 'completedBytes', 0),
    totalBytes: nullableIntegerValue(record, 'totalBytes', 0),
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

/** Aggregate item state without inventing unknown totals. */
export function summarizeBatchItems(
  items: readonly BatchItem[]
): BatchProgress {
  let completedItems = 0
  let failedItems = 0
  let completedBytes = 0
  let totalBytes = 0
  let totalUnknown = false

  for (const item of items) {
    if (item.status === 'complete') completedItems += 1
    if (item.status === 'error') failedItems += 1
    completedBytes += item.completedBytes
    if (item.totalBytes === null) totalUnknown = true
    else totalBytes += item.totalBytes
  }

  return {
    totalItems: items.length,
    completedItems,
    failedItems,
    completedBytes,
    totalBytes: totalUnknown ? null : totalBytes
  }
}

function sameProgress(left: BatchProgress, right: BatchProgress): boolean {
  return (
    left.totalItems === right.totalItems &&
    left.completedItems === right.completedItems &&
    left.failedItems === right.failedItems &&
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
