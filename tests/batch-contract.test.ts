import { describe, expect, it } from 'vitest'
import {
  BATCH_ITEM_SKIPPED_STATUSES,
  BATCH_ITEM_STATUSES,
  BATCH_STATUSES,
  COLLECTION_ENTRY_ERROR_CODES,
  COLLECTION_PREVIEW_KINDS,
  MAX_COLLECTION_ENTRIES,
  MAX_COLLECTION_SELECTION,
  isActiveBatchItemStatus,
  isActiveBatchStatus,
  isCollectionEntryAvailability,
  isCollectionEntryErrorCode,
  isCollectionPreviewKind,
  isSkippedBatchItemStatus,
  normalizeBatchSourceUrl,
  parseAnalyzeCollectionInput,
  parseBatch,
  parseBatchId,
  parseBatchItem,
  parseBatchItemId,
  parseBatchItemTargetInput,
  parseBatchProgress,
  parseBatchTargetInput,
  parseCollectionEntry,
  parseCollectionEntryId,
  parseCollectionPreview,
  parseCollectionPreviewId,
  parseCreateBatchInput,
  parseCreateCollectionBatchInput,
  summarizeBatchItems,
  toPublicBatch,
  type BatchItemRecord,
  type BatchRecord
} from '../src/shared/batches'

const BATCH_ID = 'batch_0123456789abcdef'
const ITEM_ID = 'bitem_0123456789abcdef'
const SECOND_ITEM_ID = 'bitem_fedcba9876543210'
const CHILD_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'

function item(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ITEM_ID,
    batchId: BATCH_ID,
    position: 0,
    kind: 'media',
    status: 'complete',
    title: 'Example media',
    label: '1080p MP4',
    childId: CHILD_ID,
    completedBytes: 100,
    totalBytes: 100,
    errorMessage: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_100,
    completedAt: 1_700_000_000_100,
    ...overrides
  }
}

function secondItem(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return item({
    id: SECOND_ITEM_ID,
    position: 1,
    kind: 'download',
    status: 'error',
    title: 'Second item',
    label: 'archive.zip',
    childId: null,
    completedBytes: 50,
    totalBytes: 200,
    errorMessage: 'The remote file was not found.',
    completedAt: null,
    ...overrides
  })
}

function batch(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: BATCH_ID,
    kind: 'media-playlist',
    title: 'Example playlist',
    status: 'partial',
    progress: {
      totalItems: 2,
      completedItems: 1,
      failedItems: 1,
      skippedItems: 0,
      completedBytes: 150,
      totalBytes: 300
    },
    errorMessage: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_200,
    completedAt: 1_700_000_000_200,
    items: [secondItem(), item()],
    ...overrides
  }
}

function batchRecord(overrides: Partial<BatchRecord> = {}): BatchRecord {
  return {
    id: BATCH_ID,
    kind: 'media-playlist',
    title: 'Example playlist',
    status: 'partial',
    sourceUrl: 'https://example.com/playlist?list=abc',
    errorMessage: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_200,
    completedAt: 1_700_000_000_200,
    ...overrides
  }
}

function itemRecord(
  overrides: Partial<BatchItemRecord> = {}
): BatchItemRecord {
  return {
    id: ITEM_ID,
    batchId: BATCH_ID,
    position: 0,
    kind: 'media',
    status: 'complete',
    title: 'Example media',
    label: '1080p MP4',
    childId: CHILD_ID,
    completedBytes: 100,
    totalBytes: 100,
    errorMessage: null,
    sourceUrl: 'https://example.com/watch?v=abc',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_100,
    completedAt: 1_700_000_000_100,
    ...overrides
  }
}

const PREVIEW_ID = 'colprev_0123456789abcdef'
const ENTRY_ID = 'colentry_0123456789abcdef'
const SECOND_ENTRY_ID = 'colentry_fedcba9876543210'

function collectionEntry(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: ENTRY_ID,
    position: 0,
    title: 'First entry',
    availability: 'available',
    errorCode: null,
    errorReason: null,
    ...overrides
  }
}

function collectionPreview(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: PREVIEW_ID,
    kind: 'playlist',
    title: 'Example playlist',
    entryCount: 2,
    availableCount: 1,
    unavailableCount: 1,
    entries: [
      collectionEntry(),
      collectionEntry({
        id: SECOND_ENTRY_ID,
        position: 1,
        title: 'Removed entry',
        availability: 'unavailable',
        errorCode: 'removed',
        errorReason: 'The entry was removed by its provider.'
      })
    ],
    ...overrides
  }
}

describe('batch public schema', () => {
  it('parses a batch and normalizes item order by position', () => {
    const parsed = parseBatch(batch())

    expect(parsed.id).toBe(BATCH_ID)
    expect(parsed.kind).toBe('media-playlist')
    expect(parsed.status).toBe('partial')
    expect(parsed.items.map((entry) => entry.position)).toEqual([0, 1])
    expect(parsed.progress).toEqual({
      totalItems: 2,
      completedItems: 1,
      failedItems: 1,
      skippedItems: 0,
      completedBytes: 150,
      totalBytes: 300
    })
  })

  it('accepts every stable batch and item status', () => {
    for (const status of BATCH_STATUSES) {
      expect(parseBatch(batch({ status })).status).toBe(status)
    }
    for (const status of BATCH_ITEM_STATUSES) {
      expect(
        parseBatchItem(
          item(
            isSkippedBatchItemStatus(status)
              ? { status, completedBytes: 0, totalBytes: null }
              : { status }
          )
        ).status
      ).toBe(status)
    }
    expect(() => parseBatch(batch({ status: 'paused' }))).toThrow()
    expect(() => parseBatchItem(item({ status: 'paused' }))).toThrow()
    expect(() =>
      parseBatchItem(
        item({ status: 'skipped', completedBytes: 1, totalBytes: 1 })
      )
    ).toThrow(/byte progress/)
  })

  it('represents skipped and unavailable items without counting them as failures', () => {
    const parsed = parseBatch(
      batch({
        status: 'partial',
        progress: {
          totalItems: 2,
          completedItems: 1,
          failedItems: 0,
          skippedItems: 1,
          completedBytes: 100,
          totalBytes: 100
        },
        items: [
          item(),
          item({
            id: SECOND_ITEM_ID,
            position: 1,
            status: 'unavailable',
            completedBytes: 0,
            totalBytes: null,
            errorMessage: 'The entry is unavailable.'
          })
        ]
      })
    )

    expect(parsed.items[1]?.status).toBe('unavailable')
    expect(parsed.progress).toMatchObject({
      completedItems: 1,
      failedItems: 0,
      skippedItems: 1
    })
  })

  it('rejects progress that disagrees with item state', () => {
    expect(() =>
      parseBatch(
        batch({
          progress: {
            totalItems: 2,
            completedItems: 0,
            failedItems: 1,
            skippedItems: 0,
            completedBytes: 150,
            totalBytes: 300
          }
        })
      )
    ).toThrow(/progress/)
    expect(() =>
      parseBatch(
        batch({
          progress: {
            totalItems: 1,
            completedItems: 1,
            failedItems: 0,
            skippedItems: 0,
            completedBytes: 150,
            totalBytes: 300
          }
        })
      )
    ).toThrow(/progress/)
  })

  it('rejects duplicate/mismatched item identity and duplicate positions', () => {
    expect(() =>
      parseBatch(batch({ items: [item(), item({ id: SECOND_ITEM_ID })] }))
    ).toThrow(/Duplicate batch item position/)
    expect(() =>
      parseBatch(
        batch({
          items: [item(), item({ position: 1 })]
        })
      )
    ).toThrow(/Duplicate batch item identifier/)
    expect(() =>
      parseBatch(batch({ items: [item({ batchId: 'batch_other' })] }))
    ).toThrow(/different batch/)
  })

  it('rejects public fields that could leak a URL, path or secret', () => {
    for (const extra of [
      { sourceUrl: 'https://example.com/secret' },
      { url: 'https://example.com/secret' },
      { dir: 'C:\\Downloads' },
      { filePath: 'C:\\Downloads\\out.mp4' },
      { token: 'guest-token' },
      { cookie: 'SID=1' },
      { headers: { Cookie: 'SID=1' } },
      { selector: 'bestvideo+bestaudio' }
    ]) {
      expect(() => parseBatchItem(item(extra))).toThrow(/unsupported fields/)
    }

    for (const extra of [
      { sourceUrl: 'https://pixeldrain.com/l/abc' },
      { dir: 'C:\\Downloads' },
      { token: 'guest-token' }
    ]) {
      expect(() => parseBatch(batch(extra))).toThrow(/unsupported fields/)
    }
  })

  it('rejects malformed IDs, numbers and text', () => {
    expect(() => parseBatchId('../not-a-batch')).toThrow()
    expect(() => parseBatchId('')).toThrow()
    expect(() => parseBatchId('x'.repeat(129))).toThrow()
    expect(() => parseBatchItemId('has space')).toThrow()
    expect(() => parseBatchItem(item({ childId: '../job' }))).toThrow()
    expect(() => parseBatchItem(item({ position: -1 }))).toThrow()
    expect(() => parseBatchItem(item({ completedBytes: 1.5 }))).toThrow()
    expect(() => parseBatchItem(item({ title: '   ' }))).toThrow()
    expect(() => parseBatchItem(item({ errorMessage: 'x'.repeat(2001) }))).toThrow()
  })

  it('rejects unknown batch kinds', () => {
    expect(() => parseBatch(batch({ kind: 'torrent' }))).toThrow(/kind/)
    expect(() => parseBatchItem(item({ kind: 'torrent' }))).toThrow(/kind/)
  })
})

describe('batch input parsing', () => {
  it('normalizes direct URL batches and strips fragments', () => {
    expect(
      parseCreateBatchInput({
        kind: 'direct-urls',
        title: 'Files',
        sources: [
          ' https://example.com/a.zip#part ',
          'http://example.com/b.zip'
        ]
      })
    ).toEqual({
      kind: 'direct-urls',
      title: 'Files',
      sources: ['https://example.com/a.zip', 'http://example.com/b.zip']
    })
  })

  it('requires exactly one source for playlist and Pixeldrain list kinds', () => {
    expect(
      parseCreateBatchInput({
        kind: 'pixeldrain-list',
        title: 'Pixeldrain list',
        sources: ['https://pixeldrain.com/l/abc']
      })
    ).toEqual({
      kind: 'pixeldrain-list',
      title: 'Pixeldrain list',
      sources: ['https://pixeldrain.com/l/abc']
    })

    expect(() =>
      parseCreateBatchInput({
        kind: 'media-playlist',
        title: 'Playlist',
        sources: ['https://example.com/a', 'https://example.com/b']
      })
    ).toThrow(/exactly one/)
  })

  it('rejects credentials, non-web URLs, empty lists and oversized lists', () => {
    expect(() =>
      normalizeBatchSourceUrl('https://user:secret@example.com/list')
    ).toThrow(/credentials/)
    expect(() => normalizeBatchSourceUrl('file:///C:/secret.txt')).toThrow()
    expect(() =>
      parseCreateBatchInput({
        kind: 'direct-urls',
        title: 'Files',
        sources: []
      })
    ).toThrow()
    expect(() =>
      parseCreateBatchInput({
        kind: 'direct-urls',
        title: 'Files',
        sources: Array.from({ length: 501 }, (_, index) => `https://example.com/${index}`)
      })
    ).toThrow(/500/)
  })

  it('rejects extra input fields and non-text titles', () => {
    expect(() =>
      parseCreateBatchInput({
        kind: 'direct-urls',
        title: 'Files',
        sources: ['https://example.com/a'],
        cookie: 'SID=1'
      })
    ).toThrow(/unsupported fields/)
    expect(() =>
      parseCreateBatchInput({
        kind: 'direct-urls',
        title: '   ',
        sources: ['https://example.com/a']
      })
    ).toThrow()
    expect(() =>
      parseCreateBatchInput({
        kind: 'torrent',
        title: 'Files',
        sources: ['https://example.com/a']
      })
    ).toThrow(/kind/)
  })

  it('parses strict group and item targets', () => {
    expect(parseBatchTargetInput({ batchId: BATCH_ID })).toEqual({
      batchId: BATCH_ID
    })
    expect(
      parseBatchItemTargetInput({ batchId: BATCH_ID, itemId: ITEM_ID })
    ).toEqual({ batchId: BATCH_ID, itemId: ITEM_ID })

    expect(() => parseBatchTargetInput({ batchId: BATCH_ID, force: true })).toThrow(
      /unsupported fields/
    )
    expect(() =>
      parseBatchItemTargetInput({
        batchId: BATCH_ID,
        itemId: ITEM_ID,
        url: 'https://example.com/x'
      })
    ).toThrow(/unsupported fields/)
  })
})

describe('collection preview contracts', () => {
  it('parses and orders available and unavailable entries independently', () => {
    const parsed = parseCollectionPreview(
      collectionPreview({
        entries: [
          collectionEntry({
            id: SECOND_ENTRY_ID,
            position: 1,
            title: 'Removed entry',
            availability: 'unavailable',
            errorCode: 'removed',
            errorReason: 'The entry was removed by its provider.'
          }),
          collectionEntry()
        ]
      })
    )

    expect(parsed.id).toBe(PREVIEW_ID)
    expect(parsed.kind).toBe('playlist')
    expect(parsed.entryCount).toBe(2)
    expect(parsed.availableCount).toBe(1)
    expect(parsed.unavailableCount).toBe(1)
    expect(parsed.entries.map((entry) => entry.id)).toEqual([
      ENTRY_ID,
      SECOND_ENTRY_ID
    ])
    expect(parsed.entries[0]).toMatchObject({
      availability: 'available',
      errorCode: null,
      errorReason: null
    })
    expect(parsed.entries[1]).toMatchObject({
      availability: 'unavailable',
      errorCode: 'removed',
      errorReason: 'The entry was removed by its provider.'
    })
  })

  it('accepts every stable preview kind and safe error code', () => {
    for (const kind of COLLECTION_PREVIEW_KINDS) {
      expect(isCollectionPreviewKind(kind)).toBe(true)
      expect(parseCollectionPreview(collectionPreview({ kind })).kind).toBe(kind)
    }
    for (const errorCode of COLLECTION_ENTRY_ERROR_CODES) {
      expect(isCollectionEntryErrorCode(errorCode)).toBe(true)
      expect(
        parseCollectionEntry(
          collectionEntry({
            availability: 'unavailable',
            errorCode,
            errorReason: null
          })
        ).errorCode
      ).toBe(errorCode)
    }
    expect(isCollectionPreviewKind('album')).toBe(false)
    expect(isCollectionEntryAvailability('maybe')).toBe(false)
    expect(isCollectionEntryErrorCode('raw-selector')).toBe(false)
    expect(() =>
      parseCollectionPreview(collectionPreview({ kind: 'album' }))
    ).toThrow(/kind/)
  })

  it('rejects public fields that could leak URLs, paths, selectors or secrets', () => {
    for (const extra of [
      { url: 'https://example.com/secret' },
      { sourceUrl: 'https://example.com/secret' },
      { path: 'C:\\Downloads\\out.mp4' },
      { filePath: 'C:\\Downloads\\out.mp4' },
      { dir: 'C:\\Downloads' },
      { selector: 'bestvideo+bestaudio' },
      { token: 'guest-token' },
      { cookie: 'SID=1' },
      { headers: { Cookie: 'SID=1' } },
      { raw: { id: 'provider-entry' } },
      { providerData: { formats: [] } }
    ]) {
      expect(() => parseCollectionEntry(collectionEntry(extra))).toThrow(
        /unsupported fields/
      )
      expect(() => parseCollectionPreview(collectionPreview(extra))).toThrow(
        /unsupported fields/
      )
    }
  })

  it('requires safe error metadata only for unavailable entries', () => {
    expect(() =>
      parseCollectionEntry(collectionEntry({ errorCode: 'removed' }))
    ).toThrow(/available/)
    expect(() =>
      parseCollectionEntry(collectionEntry({ errorReason: 'Not available.' }))
    ).toThrow(/available/)
    expect(() =>
      parseCollectionEntry(
        collectionEntry({ availability: 'unavailable', errorCode: null })
      )
    ).toThrow(/requires/)
    expect(() =>
      parseCollectionEntry(collectionEntry({ availability: 'unknown' }))
    ).toThrow(/availability/)

    for (const errorReason of [
      'See https://example.com/private',
      'C:\\Downloads\\private.mp4',
      '\\\\server\\share\\private.mp4'
    ]) {
      expect(() =>
        parseCollectionEntry(
          collectionEntry({
            availability: 'unavailable',
            errorCode: 'unknown',
            errorReason
          })
        )
      ).toThrow(/unsafe error reason/)
    }
  })

  it('rejects inconsistent counts, duplicate identity and out-of-range positions', () => {
    expect(() =>
      parseCollectionPreview(collectionPreview({ entryCount: 3 }))
    ).toThrow(/entry count/)
    expect(() =>
      parseCollectionPreview(
        collectionPreview({ availableCount: 2, unavailableCount: 0 })
      )
    ).toThrow(/availability counts/)
    expect(() =>
      parseCollectionPreview(
        collectionPreview({
          entries: [collectionEntry(), collectionEntry({ position: 1 })]
        })
      )
    ).toThrow(/Duplicate collection entry identifier/)
    expect(() =>
      parseCollectionPreview(
        collectionPreview({
          entries: [
            collectionEntry(),
            collectionEntry({ id: SECOND_ENTRY_ID, position: 0 })
          ]
        })
      )
    ).toThrow(/Duplicate collection entry position/)
    expect(() =>
      parseCollectionPreview(
        collectionPreview({
          entryCount: 1,
          availableCount: 1,
          unavailableCount: 0,
          entries: [collectionEntry({ position: 1 })]
        })
      )
    ).toThrow(/out of range/)
    expect(() =>
      parseCollectionPreview(
        collectionPreview({
          entryCount: MAX_COLLECTION_ENTRIES + 1,
          availableCount: MAX_COLLECTION_ENTRIES + 1,
          unavailableCount: 0,
          entries: Array.from(
            { length: MAX_COLLECTION_ENTRIES + 1 },
            (_, index) =>
              collectionEntry({
                id: `colentry_${index}`,
                position: index
              })
          )
        })
      )
    ).toThrow(/invalid entry list/)
  })

  it('rejects malformed preview/entry IDs and text', () => {
    expect(() => parseCollectionPreviewId('../preview')).toThrow()
    expect(() => parseCollectionPreviewId('')).toThrow()
    expect(() => parseCollectionEntryId('has space')).toThrow()
    expect(() =>
      parseCollectionEntry(collectionEntry({ title: '   ' }))
    ).toThrow()
    expect(() =>
      parseCollectionEntry(collectionEntry({ position: -1 }))
    ).toThrow()
    expect(() =>
      parseCollectionEntry(collectionEntry({ errorCode: 'raw-selector' }))
    ).toThrow(/error code/)
  })
})

describe('collection input parsing', () => {
  it('normalizes the analysis source URL and rejects unsafe or extra input', () => {
    expect(
      parseAnalyzeCollectionInput({
        url: ' https://example.com/list?x=1#fragment '
      })
    ).toEqual({ url: 'https://example.com/list?x=1' })
    expect(() =>
      parseAnalyzeCollectionInput({
        url: 'https://user:secret@example.com/list'
      })
    ).toThrow(/credentials/)
    expect(() =>
      parseAnalyzeCollectionInput({ url: 'file:///C:/list' })
    ).toThrow()
    expect(() =>
      parseAnalyzeCollectionInput({
        url: 'https://example.com/list',
        token: 'guest-token'
      })
    ).toThrow(/unsupported fields/)
  })

  it('requires explicit, unique and bounded selected entry IDs', () => {
    expect(
      parseCreateCollectionBatchInput({
        previewId: PREVIEW_ID,
        selectedEntryIds: [ENTRY_ID, SECOND_ENTRY_ID]
      })
    ).toEqual({
      previewId: PREVIEW_ID,
      selectedEntryIds: [ENTRY_ID, SECOND_ENTRY_ID]
    })

    expect(() =>
      parseCreateCollectionBatchInput({
        previewId: PREVIEW_ID,
        selectedEntryIds: []
      })
    ).toThrow(new RegExp(`between 1 and ${MAX_COLLECTION_SELECTION}`))
    expect(() =>
      parseCreateCollectionBatchInput({
        previewId: PREVIEW_ID,
        selectedEntryIds: [ENTRY_ID, ENTRY_ID]
      })
    ).toThrow(/Duplicate collection entry identifier/)
    expect(() =>
      parseCreateCollectionBatchInput({
        previewId: PREVIEW_ID,
        selectedEntryIds: [ENTRY_ID],
        all: true
      })
    ).toThrow(/unsupported fields/)
    expect(() =>
      parseCreateCollectionBatchInput({ previewId: PREVIEW_ID })
    ).toThrow(/missing required fields/)
    expect(() =>
      parseCreateCollectionBatchInput({
        previewId: '../preview',
        selectedEntryIds: [ENTRY_ID]
      })
    ).toThrow()
    expect(() =>
      parseCreateCollectionBatchInput({
        previewId: PREVIEW_ID,
        selectedEntryIds: ['has space']
      })
    ).toThrow()
    expect(() =>
      parseCreateCollectionBatchInput({
        previewId: PREVIEW_ID,
        selectedEntryIds: Array.from(
          { length: MAX_COLLECTION_SELECTION + 1 },
          (_, index) => `colentry_${index}`
        )
      })
    ).toThrow(new RegExp(`${MAX_COLLECTION_SELECTION}`))
    expect(
      parseCreateCollectionBatchInput({
        previewId: PREVIEW_ID,
        selectedEntryIds: Array.from(
          { length: MAX_COLLECTION_SELECTION },
          (_, index) => `colentry_${index}`
        )
      }).selectedEntryIds
    ).toHaveLength(MAX_COLLECTION_SELECTION)
  })
})

describe('batch aggregate helpers', () => {
  it('summarizes independent item states without inventing totals', () => {
    const complete = parseBatchItem(item())
    const failed = parseBatchItem(secondItem())

    expect(summarizeBatchItems([complete, failed])).toEqual({
      totalItems: 2,
      completedItems: 1,
      failedItems: 1,
      skippedItems: 0,
      completedBytes: 150,
      totalBytes: 300
    })
    expect(summarizeBatchItems([])).toEqual({
      totalItems: 0,
      completedItems: 0,
      failedItems: 0,
      skippedItems: 0,
      completedBytes: 0,
      totalBytes: 0
    })
    expect(
      summarizeBatchItems([complete, parseBatchItem(secondItem({ totalBytes: null }))])
    ).toMatchObject({ totalBytes: null })
  })

  it('keeps unavailable and skipped items independent from failures and bytes', () => {
    const complete = parseBatchItem(item())
    const unavailable = parseBatchItem(
      item({
        status: 'unavailable',
        completedBytes: 0,
        totalBytes: null,
        errorMessage: 'The entry is unavailable.'
      })
    )
    const skipped = parseBatchItem(
      secondItem({
        status: 'skipped',
        completedBytes: 0,
        totalBytes: null,
        errorMessage: null
      })
    )

    expect(summarizeBatchItems([complete, unavailable, skipped])).toEqual({
      totalItems: 3,
      completedItems: 1,
      failedItems: 0,
      skippedItems: 2,
      completedBytes: 100,
      totalBytes: 100
    })
    expect(BATCH_ITEM_SKIPPED_STATUSES.filter(isSkippedBatchItemStatus)).toEqual([
      'unavailable',
      'skipped'
    ])
    expect(isSkippedBatchItemStatus('error')).toBe(false)
  })

  it('parses and bounds aggregate progress', () => {
    expect(
      parseBatchProgress({
        totalItems: 2,
        completedItems: 1,
        failedItems: 1,
        skippedItems: 0,
        completedBytes: 0,
        totalBytes: null
      })
    ).toEqual({
      totalItems: 2,
      completedItems: 1,
      failedItems: 1,
      skippedItems: 0,
      completedBytes: 0,
      totalBytes: null
    })
    expect(
      parseBatchProgress({
        totalItems: 3,
        completedItems: 1,
        failedItems: 1,
        skippedItems: 1,
        completedBytes: 0,
        totalBytes: 0
      })
    ).toMatchObject({ skippedItems: 1 })
    expect(() =>
      parseBatchProgress({
        totalItems: 1,
        completedItems: 2,
        failedItems: 0,
        skippedItems: 0,
        completedBytes: 0,
        totalBytes: 0
      })
    ).toThrow()
    expect(() =>
      parseBatchProgress({
        totalItems: 1,
        completedItems: 1,
        failedItems: 1,
        skippedItems: 0,
        completedBytes: 0,
        totalBytes: 0
      })
    ).toThrow()
    expect(() =>
      parseBatchProgress({
        totalItems: 2,
        completedItems: 1,
        failedItems: 1,
        skippedItems: 1,
        completedBytes: 0,
        totalBytes: 0
      })
    ).toThrow()
  })

  it('reports active states used by interrupted recovery', () => {
    expect(BATCH_STATUSES.filter(isActiveBatchStatus)).toEqual([
      'queued',
      'running'
    ])
    expect(BATCH_ITEM_STATUSES.filter(isActiveBatchItemStatus)).toEqual([
      'queued',
      'running'
    ])
    expect(isActiveBatchStatus('interrupted')).toBe(false)
    expect(isActiveBatchItemStatus('cancelled')).toBe(false)
  })
})

describe('public conversion', () => {
  it('drops internal source references and keeps only public keys', () => {
    const publicBatch = toPublicBatch(batchRecord(), [
      itemRecord({ position: 1 }),
      itemRecord({
        id: SECOND_ITEM_ID,
        position: 0,
        sourceUrl: null,
        status: 'error',
        childId: null,
        completedBytes: 50,
        totalBytes: 200,
        errorMessage: 'The remote file was not found.',
        completedAt: null
      })
    ])

    expect(publicBatch.items.map((entry) => entry.position)).toEqual([0, 1])
    expect(publicBatch.progress).toEqual({
      totalItems: 2,
      completedItems: 1,
      failedItems: 1,
      skippedItems: 0,
      completedBytes: 150,
      totalBytes: 300
    })

    expect(Object.keys(publicBatch).sort()).toEqual([
      'completedAt',
      'createdAt',
      'errorMessage',
      'id',
      'items',
      'kind',
      'progress',
      'status',
      'title',
      'updatedAt'
    ])
    expect(Object.keys(publicBatch.items[0] ?? {}).sort()).toEqual([
      'batchId',
      'childId',
      'completedAt',
      'completedBytes',
      'createdAt',
      'errorMessage',
      'id',
      'kind',
      'label',
      'position',
      'status',
      'title',
      'totalBytes',
      'updatedAt'
    ])
    expect(JSON.stringify(publicBatch)).not.toContain('example.com')
  })

  it('rejects an item from a different batch during conversion', () => {
    expect(() =>
      toPublicBatch(batchRecord(), [itemRecord({ batchId: 'batch_other' })])
    ).toThrow(/different batch/)
  })
})
