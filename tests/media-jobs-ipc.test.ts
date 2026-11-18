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
import type {
  MediaAnalysis,
  MediaJob,
  MediaSnapshot
} from '../src/shared/media'
import type { Aria2Service } from '../src/main/aria2/service'
import type { DownloadManager } from '../src/main/downloads/manager'
import { registerIpc } from '../src/main/ipc'
import type { MediaJobsManager } from '../src/main/mediaJobs/manager'

const MEDIA_CHANNELS = [
  IPC.analyzeMedia,
  IPC.queueMedia,
  IPC.getMediaSnapshot,
  IPC.getMediaJob,
  IPC.cancelMedia,
  IPC.removeMedia,
  IPC.showMediaInFolder
]

function mediaAnalysis(): MediaAnalysis {
  return {
    analysisId: 'analysis_0123456789abcdef',
    title: 'Example media',
    durationSeconds: 120,
    options: [
      {
        kind: 'video',
        optionId: 'option_video_0123456789',
        label: '1080p MP4',
        container: 'mp4',
        width: 1920,
        height: 1080,
        fps: 30,
        videoCodec: 'h264',
        audioCodec: 'aac',
        hasAudio: true,
        requiresMerge: true,
        filesizeBytes: 1_000
      }
    ],
    bestVideoOptionId: 'option_video_0123456789',
    bestAudioOptionId: null,
    expiresAt: Date.now() + 60_000
  }
}

function mediaJob(): MediaJob {
  const now = Date.UTC(2026, 2, 4, 5, 6, 7)
  return {
    id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
    analysisId: 'analysis_0123456789abcdef',
    optionId: 'option_video_0123456789',
    kind: 'video',
    title: 'Example media',
    label: '1080p MP4',
    status: 'queued',
    completedBytes: 0,
    totalBytes: 1_000,
    speedBps: 0,
    errorMessage: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null
  }
}

function mediaSnapshot(): MediaSnapshot {
  return {
    tool: {
      status: 'ready',
      version: 'test-engine',
      message: null,
      hint: null
    },
    jobs: [mediaJob()]
  }
}

function createMediaManager() {
  const analysis = mediaAnalysis()
  const job = mediaJob()
  const snapshot = mediaSnapshot()
  return {
    analysis,
    job,
    snapshot,
    analyzeMedia: vi.fn(async (_input: unknown) => analysis),
    queueMedia: vi.fn(async (_input: unknown) => job),
    getMediaSnapshot: vi.fn(() => snapshot),
    getMediaJob: vi.fn((_jobId: unknown) => job),
    getMediaStatus: vi.fn(async (_jobId: unknown) => job),
    cancelMedia: vi.fn(async (_jobId: unknown) => job),
    removeMedia: vi.fn(async (_jobId: unknown) => snapshot),
    showMediaInFolder: vi.fn(async (_jobId: unknown) => null),
    refreshToolState: vi.fn(async () => snapshot.tool)
  }
}

type FakeMediaManager = ReturnType<typeof createMediaManager>

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

function register(
  mediaJobs?: FakeMediaManager,
  windowOverride?: FakeWindow,
  downloadDestinations?: {
    choose: () => Promise<{ token: string; path: string } | null>
    resolve: (token: string) => string | null
  }
) {
  const fakeWindow = windowOverride ?? createWindow()
  const context = {
    manager: {} as DownloadManager,
    aria2: {} as Aria2Service,
    mediaJobs: mediaJobs as unknown as MediaJobsManager | undefined,
    ...(downloadDestinations === undefined ? {} : { downloadDestinations }),
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

describe('media IPC registration', () => {
  it('adds every media channel without replacing existing download channels', () => {
    register(createMediaManager())

    for (const channel of MEDIA_CHANNELS) {
      expect(handlers.has(channel)).toBe(true)
    }
    expect(handlers.has(IPC.addDownload)).toBe(true)
    expect(handlers.has(IPC.getSnapshot)).toBe(true)
  })

  it('returns a safe error when the media manager is not wired yet', async () => {
    const fakeWindow = register(undefined)

    const result = await handler(IPC.analyzeMedia)(
      trustedEvent(fakeWindow),
      { url: 'https://example.com/watch?v=1' }
    )

    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('MEDIA_UNAVAILABLE')
  })
})

describe('media IPC security and results', () => {
  it('routes trusted top-frame invocations to the manager', async () => {
    const media = createMediaManager()
    const fakeWindow = register(media)
    const event = trustedEvent(fakeWindow)

    const analyze = await handler(IPC.analyzeMedia)(event, {
      url: 'https://example.com/watch?v=1'
    })
    expect(analyze).toEqual({ ok: true, value: media.analysis })
    expect(media.analyzeMedia).toHaveBeenCalledWith({
      url: 'https://example.com/watch?v=1'
    })

    const queue = await handler(IPC.queueMedia)(event, {
      analysisId: media.analysis.analysisId,
      optionId: 'option_video_0123456789'
    })
    expect(queue).toEqual({ ok: true, value: media.snapshot })
    expect(media.queueMedia).toHaveBeenCalledWith({
      analysisId: media.analysis.analysisId,
      optionId: 'option_video_0123456789'
    })

    const snapshot = await handler(IPC.getMediaSnapshot)(event)
    expect(snapshot).toEqual({ ok: true, value: media.snapshot })

    const job = await handler(IPC.getMediaJob)(event, media.job.id)
    expect(job).toEqual({ ok: true, value: media.job })

    const cancelled = await handler(IPC.cancelMedia)(event, media.job.id)
    expect(cancelled).toEqual({ ok: true, value: media.snapshot })
    expect(media.cancelMedia).toHaveBeenCalledWith(media.job.id)

    const removed = await handler(IPC.removeMedia)(event, media.job.id)
    expect(removed).toEqual({ ok: true, value: media.snapshot })

    const shown = await handler(IPC.showMediaInFolder)(event, media.job.id)
    expect(shown).toEqual({ ok: true, value: null })
  })

  it('routes a chosen destination token to the media queue in main', async () => {
    const media = createMediaManager()
    const token = 'a'.repeat(32)
    const fakeWindow = register(media, undefined, {
      choose: vi.fn(async () => null),
      resolve: (value) => (value === token ? 'D:\\Chosen media' : null)
    })

    const result = await handler(IPC.queueMedia)(trustedEvent(fakeWindow), {
      analysisId: media.analysis.analysisId,
      optionId: 'option_video_0123456789',
      destinationToken: token
    })

    expect(result.ok).toBe(true)
    expect(media.queueMedia).toHaveBeenCalledWith(
      {
        analysisId: media.analysis.analysisId,
        optionId: 'option_video_0123456789',
        destinationToken: token
      },
      'D:\\Chosen media'
    )
  })

  it('reports an expired media folder instead of queueing into the default', async () => {
    const media = createMediaManager()
    const fakeWindow = register(media, undefined, {
      choose: vi.fn(async () => null),
      resolve: () => null
    })

    const result = await handler(IPC.queueMedia)(trustedEvent(fakeWindow), {
      analysisId: media.analysis.analysisId,
      optionId: 'option_video_0123456789',
      destinationToken: 'b'.repeat(32)
    })

    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('DOWNLOAD_FOLDER_EXPIRED')
    expect(media.queueMedia).not.toHaveBeenCalled()
  })

  it('rejects a sender that is not the application window', async () => {
    const media = createMediaManager()
    const fakeWindow = register(media)

    const result = await handler(IPC.queueMedia)(
      {
        sender: {},
        senderFrame: fakeWindow.frame
      },
      {
        analysisId: media.analysis.analysisId,
        optionId: 'option_video_0123456789'
      }
    )

    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('UNTRUSTED_SENDER')
    expect(media.queueMedia).not.toHaveBeenCalled()
  })

  it('rejects a sub-frame even when it shares the top-frame URL', async () => {
    const media = createMediaManager()
    const fakeWindow = register(media)

    const result = await handler(IPC.analyzeMedia)(
      {
        sender: fakeWindow.webContents,
        senderFrame: { url: fakeWindow.frame.url }
      },
      { url: 'https://example.com/watch?v=1' }
    )

    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('UNTRUSTED_SENDER')
    expect(media.analyzeMedia).not.toHaveBeenCalled()
  })

  it('rejects a top frame whose URL no longer matches the window', async () => {
    const media = createMediaManager()
    const fakeWindow = register(media)

    const result = await handler(IPC.cancelMedia)(
      {
        sender: fakeWindow.webContents,
        senderFrame: { url: 'https://evil.example/' }
      },
      media.job.id
    )

    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('UNTRUSTED_SENDER')
    expect(media.cancelMedia).not.toHaveBeenCalled()
  })

  it('rejects every invocation when no application window exists', async () => {
    const media = createMediaManager()
    registerIpc({
      manager: {} as DownloadManager,
      aria2: {} as Aria2Service,
      mediaJobs: media as unknown as MediaJobsManager,
      getWindow: () => null
    })

    const result = await handler(IPC.analyzeMedia)(
      { sender: {}, senderFrame: { url: 'app://dondownload/index.html' } },
      { url: 'https://example.com/watch?v=1' }
    )

    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('UNTRUSTED_SENDER')
    expect(media.analyzeMedia).not.toHaveBeenCalled()
  })
})
