import { describe, expect, it } from 'vitest'
import {
  BATCH_ITEM_STATUSES,
  BATCH_STATUSES,
  isActiveBatchItemStatus,
  isActiveBatchStatus,
  normalizeBatchSourceUrl,
  parseBatch,
  parseBatchId,
  parseBatchItem,
  parseBatchItemId,
  parseBatchItemTargetInput,
  parseBatchProgress,
  parseBatchTargetInput,
  parseCreateBatchInput,
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
      completedBytes: 150,
      totalBytes: 300
    })
  })

  it('accepts every stable batch and item status', () => {
    for (const status of BATCH_STATUSES) {
      expect(parseBatch(batch({ status })).status).toBe(status)
    }
    for (const status of BATCH_ITEM_STATUSES) {
      expect(parseBatchItem(item({ status })).status).toBe(status)
    }
    expect(() => parseBatch(batch({ status: 'paused' }))).toThrow()
    expect(() => parseBatchItem(item({ status: 'paused' }))).toThrow()
  })

  it('rejects progress that disagrees with item state', () => {
    expect(() =>
      parseBatch(
        batch({
          progress: {
            totalItems: 2,
            completedItems: 0,
            failedItems: 1,
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

describe('batch aggregate helpers', () => {
  it('summarizes independent item states without inventing totals', () => {
    const complete = parseBatchItem(item())
    const failed = parseBatchItem(secondItem())

    expect(summarizeBatchItems([complete, failed])).toEqual({
      totalItems: 2,
      completedItems: 1,
      failedItems: 1,
      completedBytes: 150,
      totalBytes: 300
    })
    expect(summarizeBatchItems([])).toEqual({
      totalItems: 0,
      completedItems: 0,
      failedItems: 0,
      completedBytes: 0,
      totalBytes: 0
    })
    expect(
      summarizeBatchItems([complete, parseBatchItem(secondItem({ totalBytes: null }))])
    ).toMatchObject({ totalBytes: null })
  })

  it('parses and bounds aggregate progress', () => {
    expect(
      parseBatchProgress({
        totalItems: 2,
        completedItems: 1,
        failedItems: 1,
        completedBytes: 0,
        totalBytes: null
      })
    ).toEqual({
      totalItems: 2,
      completedItems: 1,
      failedItems: 1,
      completedBytes: 0,
      totalBytes: null
    })
    expect(() =>
      parseBatchProgress({
        totalItems: 1,
        completedItems: 2,
        failedItems: 0,
        completedBytes: 0,
        totalBytes: 0
      })
    ).toThrow()
    expect(() =>
      parseBatchProgress({
        totalItems: 1,
        completedItems: 1,
        failedItems: 1,
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
