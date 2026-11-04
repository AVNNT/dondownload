import { beforeEach, describe, expect, it, vi } from 'vitest'

type InvokeHandler = (
  event: unknown,
  ...args: unknown[]
) => Promise<{ ok: boolean; value?: unknown; error?: { code: string; message: string } }>

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, InvokeHandler>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: InvokeHandler) => {
      handlers.set(channel, handler)
    }
  },
  shell: { showItemInFolder: vi.fn() }
}))

import { IPC } from '../src/shared/ipc'
import {
  parseBatch,
  parseCollectionPreview,
  type Batch,
  type CollectionPreview
} from '../src/shared/batches'
import type { Aria2Service } from '../src/main/aria2/service'
import type { BatchManager } from '../src/main/batches/manager'
import type { DownloadManager } from '../src/main/downloads/manager'
import { registerIpc } from '../src/main/ipc'
import type { MediaJobsManager } from '../src/main/mediaJobs/manager'
import type {
  BatchSnapshot,
  SmartBatchSubmitResult
} from '../src/shared/types'

const BATCH_CHANNELS = [
  IPC.analyzeBatchCollection,
  IPC.submitSmartBatch,
  IPC.createCollectionBatch,
  IPC.getBatchSnapshot,
  IPC.getBatch,
  IPC.cancelBatchItem,
  IPC.cancelBatch,
  IPC.retryBatchItem,
  IPC.removeBatch,
  IPC.openBatchSource
]

const NOW = Date.UTC(2026, 3, 2, 8, 0, 0)

function batchFixture(): Batch {
  return parseBatch({
    id: 'batch_0123456789abcdef',
    kind: 'direct-urls',
    title: 'Example batch',
    status: 'queued',
    progress: {
      totalItems: 1,
      completedItems: 0,
      failedItems: 0,
      skippedItems: 0,
      completedBytes: 0,
      totalBytes: null
    },
    errorMessage: null,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
    items: [
      {
        id: 'bitem_0123456789abcdef',
        batchId: 'batch_0123456789abcdef',
        position: 0,
        kind: 'download',
        status: 'queued',
        title: 'sample.zip',
        label: 'Direct download',
        childId: null,
        completedBytes: 0,
        totalBytes: null,
        errorMessage: null,
        createdAt: NOW,
        updatedAt: NOW,
        completedAt: null
      }
    ]
  })
}

function previewFixture(): CollectionPreview {
  return parseCollectionPreview({
    id: 'colprev_0123456789abcdef',
    kind: 'playlist',
    title: 'Example playlist',
    entryCount: 1,
    availableCount: 1,
    unavailableCount: 0,
    entries: [
      {
        id: 'colentry_0123456789abcdef',
        position: 0,
        title: 'First entry',
        availability: 'available',
        errorCode: null,
        errorReason: null
      }
    ]
  })
}

function createBatchManager() {
  const batch = batchFixture()
  const preview = previewFixture()
  const snapshot: BatchSnapshot = { batches: [batch] }
  const smart: SmartBatchSubmitResult = {
    batch,
    previews: [preview],
    entries: [
      {
        index: 0,
        outcome: 'batch-item',
        batchId: batch.id,
        itemId: batch.items[0]?.id ?? null,
        previewId: null,
        code: null,
        message: null
      }
    ]
  }
  return {
    batch,
    preview,
    snapshot,
    smart,
    analyzeCollection: vi.fn(async (_input: unknown) => preview),
    submitSmartBatch: vi.fn(async (_input: unknown) => smart),
    createCollectionBatch: vi.fn(async (_input: unknown) => batch),
    getBatchSnapshot: vi.fn(() => snapshot),
    getBatch: vi.fn((_batchId: unknown) => batch),
    cancelBatchItem: vi.fn(async (_input: unknown) => snapshot),
    cancelBatch: vi.fn(async (_input: unknown) => snapshot),
    retryBatchItem: vi.fn(async (_input: unknown) => snapshot),
    removeBatch: vi.fn(async (_input: unknown) => snapshot),
    openBatchSource: vi.fn(async (_input: unknown) => null)
  }
}

type FakeBatchManager = ReturnType<typeof createBatchManager>

interface FakeWindow {
  window: {
    isDestroyed: () => boolean
    webContents: {
      mainFrame: { url: string }
      getURL: () => string
    }
  }
  frame: { url: string }
  webContents: {
    mainFrame: { url: string }
    getURL: () => string
  }
}

function createWindow(): FakeWindow {
  const frame = { url: 'app://dondownload/index.html' }
  const webContents = {
    mainFrame: frame,
    getURL: () => frame.url
  }
  const window = {
    isDestroyed: () => false,
    webContents
  }
  return { window, frame, webContents }
}

function register(batches?: FakeBatchManager, windowOverride?: FakeWindow) {
  const fakeWindow = windowOverride ?? createWindow()
  const context = {
    manager: {} as DownloadManager,
    aria2: {} as Aria2Service,
    mediaJobs: {} as MediaJobsManager,
    batches: batches as unknown as BatchManager | undefined,
    getWindow: () => fakeWindow.window as never
  }
  registerIpc(context)
  return fakeWindow
}

function handler(channel: string): InvokeHandler {
  const registered = handlers.get(channel)
  if (!registered) throw new Error(`No handler registered for ${channel}.`)
  return registered
}

function trustedEvent(fakeWindow: FakeWindow): unknown {
  return {
    sender: fakeWindow.webContents,
    senderFrame: fakeWindow.frame
  }
}

beforeEach(() => {
  handlers.clear()
})

describe('batch IPC registration', () => {
  it('adds every batch channel without replacing download or media channels', () => {
    register(createBatchManager())

    for (const channel of BATCH_CHANNELS) {
      expect(handlers.has(channel)).toBe(true)
    }
    expect(handlers.has(IPC.addDownload)).toBe(true)
    expect(handlers.has(IPC.analyzeMedia)).toBe(true)
    expect(handlers.has(IPC.getMediaSnapshot)).toBe(true)
  })

  it('returns a safe error when the batch manager is not wired yet', async () => {
    const fakeWindow = register(undefined)

    const result = await handler(IPC.getBatchSnapshot)(
      trustedEvent(fakeWindow)
    )

    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('BATCH_UNAVAILABLE')
  })
})

describe('batch IPC security and results', () => {
  it('routes trusted top-frame invocations to the manager', async () => {
    const batches = createBatchManager()
    const fakeWindow = register(batches)
    const event = trustedEvent(fakeWindow)

    const analyzed = await handler(IPC.analyzeBatchCollection)(event, {
      url: 'https://media.example/playlist?list=abc'
    })
    expect(analyzed).toEqual({ ok: true, value: batches.preview })
    expect(batches.analyzeCollection).toHaveBeenCalledWith({
      url: 'https://media.example/playlist?list=abc'
    })

    const submit = await handler(IPC.submitSmartBatch)(event, {
      urls: ['https://example.com/files/a.zip']
    })
    expect(submit).toEqual({ ok: true, value: batches.smart })
    expect(batches.submitSmartBatch).toHaveBeenCalledWith({
      urls: ['https://example.com/files/a.zip']
    })

    const created = await handler(IPC.createCollectionBatch)(event, {
      previewId: batches.preview.id,
      selectedEntryIds: [batches.preview.entries[0]?.id]
    })
    expect(created).toEqual({ ok: true, value: batches.batch })
    expect(batches.createCollectionBatch).toHaveBeenCalledWith({
      previewId: batches.preview.id,
      selectedEntryIds: [batches.preview.entries[0]?.id]
    })

    const snapshot = await handler(IPC.getBatchSnapshot)(event)
    expect(snapshot).toEqual({ ok: true, value: batches.snapshot })

    const one = await handler(IPC.getBatch)(event, batches.batch.id)
    expect(one).toEqual({ ok: true, value: batches.batch })

    const target = {
      batchId: batches.batch.id,
      itemId: batches.batch.items[0]?.id
    }
    const cancelledItem = await handler(IPC.cancelBatchItem)(event, target)
    expect(cancelledItem).toEqual({ ok: true, value: batches.snapshot })
    expect(batches.cancelBatchItem).toHaveBeenCalledWith(target)

    const cancelled = await handler(IPC.cancelBatch)(event, {
      batchId: batches.batch.id
    })
    expect(cancelled).toEqual({ ok: true, value: batches.snapshot })

    const retried = await handler(IPC.retryBatchItem)(event, target)
    expect(retried).toEqual({ ok: true, value: batches.snapshot })
    expect(batches.retryBatchItem).toHaveBeenCalledWith(target)

    const removed = await handler(IPC.removeBatch)(event, {
      batchId: batches.batch.id
    })
    expect(removed).toEqual({ ok: true, value: batches.snapshot })

    const opened = await handler(IPC.openBatchSource)(event, target)
    expect(opened).toEqual({ ok: true, value: null })
    expect(batches.openBatchSource).toHaveBeenCalledWith(target)
  })

  it('rejects a sender that is not the application window', async () => {
    const batches = createBatchManager()
    const fakeWindow = register(batches)

    const result = await handler(IPC.submitSmartBatch)(
      {
        sender: {},
        senderFrame: fakeWindow.frame
      },
      { urls: ['https://example.com/files/a.zip'] }
    )

    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('UNTRUSTED_SENDER')
    expect(batches.submitSmartBatch).not.toHaveBeenCalled()
  })

  it('rejects a sub-frame even when it shares the top-frame URL', async () => {
    const batches = createBatchManager()
    const fakeWindow = register(batches)

    const result = await handler(IPC.analyzeBatchCollection)(
      {
        sender: fakeWindow.webContents,
        senderFrame: { url: fakeWindow.frame.url }
      },
      { url: 'https://media.example/playlist?list=abc' }
    )

    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('UNTRUSTED_SENDER')
    expect(batches.analyzeCollection).not.toHaveBeenCalled()
  })

  it('rejects a top frame whose URL no longer matches the window', async () => {
    const batches = createBatchManager()
    const fakeWindow = register(batches)

    const result = await handler(IPC.cancelBatch)(
      {
        sender: fakeWindow.webContents,
        senderFrame: { url: 'https://evil.example/' }
      },
      { batchId: batches.batch.id }
    )

    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('UNTRUSTED_SENDER')
    expect(batches.cancelBatch).not.toHaveBeenCalled()
  })

  it('rejects every invocation when no application window exists', async () => {
    const batches = createBatchManager()
    registerIpc({
      manager: {} as DownloadManager,
      aria2: {} as Aria2Service,
      mediaJobs: {} as MediaJobsManager,
      batches: batches as unknown as BatchManager,
      getWindow: () => null
    })

    const result = await handler(IPC.getBatchSnapshot)({
      sender: {},
      senderFrame: { url: 'app://dondownload/index.html' }
    })

    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('UNTRUSTED_SENDER')
    expect(batches.getBatchSnapshot).not.toHaveBeenCalled()
  })
})
