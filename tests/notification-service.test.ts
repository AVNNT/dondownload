import { beforeEach, describe, expect, it } from 'vitest'
import type { AppSnapshot, DownloadItem } from '../src/shared/types'
import type { MediaJob, MediaSnapshot } from '../src/shared/media'
import type { NotificationActivation } from '../src/shared/notifications'
import type { HostNotificationOptions } from '../src/main/host'

import { createTestHost } from './fakes/host'
import { CompletionNotificationService } from '../src/main/notifications/service'

const shown: HostNotificationOptions[] = []

const NOW = Date.UTC(2026, 10, 4, 12, 0, 0)

function download(id: string, status: DownloadItem['status']): DownloadItem {
  return {
    id,
    gid: id,
    url: `https://example.com/${id}.bin`,
    filename: `${id}.bin`,
    dir: 'C:\\Downloads',
    filePath: null,
    status,
    totalBytes: 1_000,
    completedBytes: 0,
    speedBps: 0,
    etaSeconds: null,
    errorMessage: null,
    attempts: 1,
    maxAttempts: 3,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null
  }
}

function media(id: string, status: MediaJob['status']): MediaJob {
  return {
    id,
    analysisId: 'analysis',
    optionId: 'option',
    kind: 'video',
    title: `${id}.mp4`,
    label: '1080p',
    status,
    completedBytes: 0,
    totalBytes: 1_000,
    speedBps: 0,
    errorMessage: null,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null
  }
}

function downloads(...rows: DownloadItem[]): AppSnapshot {
  return {
    aria2: {
      status: 'ready',
      version: 'test',
      binaryPath: null,
      message: null,
      hint: null
    },
    downloads: rows
  }
}

function mediaSnapshot(...rows: MediaJob[]): MediaSnapshot {
  return {
    tool: { status: 'ready', version: 'test', message: null, hint: null },
    jobs: rows
  }
}

function service(
  platform: NodeJS.Platform = 'linux'
): CompletionNotificationService {
  return new CompletionNotificationService({
    host: createTestHost({
      isNotificationSupported: () => true,
      createNotification: (options) => {
        shown.push(options)
        return {
          // Click handling is irrelevant to transition tracking.
          on: () => undefined,
          onAction: () => undefined,
          show: () => undefined
        }
      }
    }),
    isEnabled: () => true,
    isSupported: () => true,
    platform
  })
}

beforeEach(() => {
  shown.length = 0
})

describe('completion notifications track non-terminal transitions only', () => {
  it('notifies once when a download reaches complete', () => {
    const notifications = service()
    notifications.observeDownloads(downloads(download('a', 'queued')))
    expect(shown).toHaveLength(0)

    notifications.observeDownloads(downloads(download('a', 'active')))
    expect(shown).toHaveLength(0)

    notifications.observeDownloads(downloads(download('a', 'complete')))
    expect(shown).toEqual([
      { title: 'Download complete', body: 'a.bin' }
    ])

    // A terminal row is not remembered, so later publishes stay silent.
    notifications.observeDownloads(downloads(download('a', 'complete')))
    notifications.observeDownloads(downloads(download('a', 'complete')))
    expect(shown).toHaveLength(1)
  })

  it('never announces history that is first seen as complete', () => {
    const notifications = service()
    notifications.observeDownloads(
      downloads(download('old', 'complete'), download('failed', 'error'))
    )
    expect(shown).toHaveLength(0)
  })

  it('announces a media failure once', () => {
    const notifications = service()
    notifications.observeMedia(mediaSnapshot(media('m', 'downloading')))
    notifications.observeMedia(mediaSnapshot(media('m', 'error')))
    notifications.observeMedia(mediaSnapshot(media('m', 'error')))
    expect(shown).toEqual([
      { title: 'Media download failed', body: 'm.mp4' }
    ])
  })

  it('keeps only non-terminal rows in its maps after a large terminal history', () => {
    const notifications = service()
    const history = Array.from({ length: 10_000 }, (_value, index) =>
      download(`history-${index}`, 'complete')
    )
    notifications.observeDownloads(downloads(...history))
    notifications.observeDownloads(downloads(download('live', 'active'), ...history))
    notifications.observeDownloads(downloads(download('live', 'complete'), ...history))

    expect(shown).toHaveLength(1)
    const internals = notifications as unknown as {
      downloadStatuses: Map<string, string>
    }
    expect(internals.downloadStatuses.size).toBe(0)
  })

  it('forgets a removed non-terminal row before it can be re-added', () => {
    const notifications = service()
    notifications.observeDownloads(downloads(download('a', 'queued')))
    notifications.observeDownloads(downloads())
    notifications.observeDownloads(downloads(download('a', 'complete')))
    expect(shown).toHaveLength(0)

    // A fresh row with the same id (after removal) is a baseline again.
    notifications.observeDownloads(downloads())
    notifications.observeDownloads(downloads(download('a', 'queued')))
    notifications.observeDownloads(downloads(download('a', 'complete')))
    expect(shown).toHaveLength(1)
  })
})

describe('Windows completion toast actions', () => {
  interface Captured {
    options: HostNotificationOptions
    click: (() => void) | null
    action: ((index: number) => void) | null
  }

  function windowsService(): {
    notifications: CompletionNotificationService
    captured: Captured[]
    activations: Array<[string, string, NotificationActivation]>
  } {
    const captured: Captured[] = []
    const activations: Array<[string, string, NotificationActivation]> = []
    const notifications = new CompletionNotificationService({
      host: createTestHost({
        isNotificationSupported: () => true,
        createNotification: (options) => {
          const entry: Captured = { options, click: null, action: null }
          captured.push(entry)
          return {
            on: (_event, listener) => {
              entry.click = listener
            },
            onAction: (listener) => {
              entry.action = listener
            },
            show: () => undefined
          }
        }
      }),
      isEnabled: () => true,
      isSupported: () => true,
      platform: 'win32',
      onActivate: (kind, id, action) => {
        activations.push([kind, id, action])
      }
    })
    return { notifications, captured, activations }
  }

  it('adds Open / Show in folder buttons to a completed download toast', () => {
    const { notifications, captured } = windowsService()
    notifications.observeDownloads(downloads(download('a', 'active')))
    notifications.observeDownloads(downloads(download('a', 'complete')))

    expect(captured).toHaveLength(1)
    const options = captured[0]?.options
    expect(options?.title).toBe('Download complete')
    expect(options?.id).toMatch(/^[a-z0-9]+$/)
    expect(options?.toastXml).toContain('content="Open"')
    expect(options?.toastXml).toContain('content="Show in folder"')
    expect(options?.toastXml).toContain(`tag=${options?.id}`)
  })

  it('maps a body click and both buttons to opaque-id activations', () => {
    const { notifications, captured, activations } = windowsService()
    notifications.observeDownloads(downloads(download('job-1', 'active')))
    notifications.observeDownloads(downloads(download('job-1', 'complete')))

    captured[0]?.click?.()
    captured[0]?.action?.(0)
    captured[0]?.action?.(1)
    captured[0]?.action?.(99)

    expect(activations).toEqual([
      ['download', 'job-1', 'activate'],
      ['download', 'job-1', 'open'],
      ['download', 'job-1', 'show'],
      // An unknown index falls back to revealing the row, never opening it.
      ['download', 'job-1', 'activate']
    ])
  })

  it('leaves failure toasts without file actions', () => {
    const { notifications, captured } = windowsService()
    notifications.observeDownloads(downloads(download('bad', 'active')))
    notifications.observeDownloads(downloads(download('bad', 'error')))

    expect(captured).toHaveLength(1)
    expect(captured[0]?.options.toastXml).toBeUndefined()
    expect(captured[0]?.options.id).toBeUndefined()
    expect(captured[0]?.action).toBeNull()
  })

  it('keeps the plain notification outside Windows', () => {
    const notifications = service('linux')
    notifications.observeDownloads(downloads(download('a', 'active')))
    notifications.observeDownloads(downloads(download('a', 'complete')))
    expect(shown[0]?.toastXml).toBeUndefined()
    expect(shown[0]?.id).toBeUndefined()
  })
})
