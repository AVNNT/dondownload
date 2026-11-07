import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  GOFILE_CAPTURE_MAX_DOWNLOADS,
  armGofileCapture,
  captureGofileDownload,
  disarmGofileCapture,
  installGofileCaptureListeners,
  isArmedGofileDownload,
  isGofileCaptureArmed,
  isGofileHostUrl,
  readGofileCapture,
  recordGofileCapture,
  resetGofileCaptureForTests,
  resetGofileCaptureListenersForTests
} from '../extension/gofile-capture'

const SHARE_URL = 'https://gofile.io/d/AbCd1234'
const DOWNLOAD_URL = 'https://store3.gofile.io/download/web/f1/Fancam%2001.mp4'

interface FakeDownloads {
  cancelled: number[]
  erased: number[]
}

function fakeChrome(): { chrome: Record<string, unknown>; calls: FakeDownloads } {
  const calls: FakeDownloads = { cancelled: [], erased: [] }
  const chrome = {
    runtime: { lastError: undefined },
    downloads: {
      cancel(id: number, callback: () => void) {
        calls.cancelled.push(id)
        callback()
      },
      erase(query: { id: number }, callback: () => void) {
        calls.erased.push(query.id)
        callback()
      }
    }
  }
  return { chrome, calls }
}

function downloadItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 41,
    url: DOWNLOAD_URL,
    finalUrl: DOWNLOAD_URL,
    filename: 'Fancam 01.mp4',
    referrer: SHARE_URL,
    state: 'in_progress',
    danger: 'safe',
    ...overrides
  }
}

beforeEach(() => {
  resetGofileCaptureForTests()
})

afterEach(() => {
  resetGofileCaptureForTests()
  vi.useRealTimers()
})

describe('Gofile capture window', () => {
  it('arms and disarms', () => {
    expect(isGofileCaptureArmed()).toBe(false)
    armGofileCapture({ tabId: 7, pageUrl: SHARE_URL })
    expect(isGofileCaptureArmed()).toBe(true)
    disarmGofileCapture()
    expect(isGofileCaptureArmed()).toBe(false)
  })

  it('closes itself after the timeout', () => {
    vi.useFakeTimers()
    armGofileCapture({ tabId: 7, pageUrl: SHARE_URL, timeoutMs: 1_000 })
    expect(isGofileCaptureArmed()).toBe(true)
    vi.advanceTimersByTime(999)
    expect(isGofileCaptureArmed()).toBe(true)
    vi.advanceTimersByTime(1)
    expect(isGofileCaptureArmed()).toBe(false)
  })

  it('accepts only gofile.io and its subdomains', () => {
    expect(isGofileHostUrl('https://gofile.io/d/x')).toBe(true)
    expect(isGofileHostUrl('https://store3.gofile.io/download/web/f1/a.mp4')).toBe(true)
    expect(isGofileHostUrl('https://gofile.io.evil.example/download/f1/a.mp4')).toBe(false)
    expect(isGofileHostUrl('https://evil.example/download/f1/a.mp4')).toBe(false)
    expect(isGofileHostUrl('')).toBe(false)
  })

  it('ignores a download while it is not armed', () => {
    const { chrome, calls } = fakeChrome()
    expect(captureGofileDownload(chrome, downloadItem())).toBe(false)
    expect(calls.cancelled).toEqual([])
  })

  it('records the URL and file name, then cancels and erases the download', () => {
    vi.useFakeTimers()
    const { chrome, calls } = fakeChrome()
    armGofileCapture({ tabId: 7, pageUrl: SHARE_URL })

    expect(captureGofileDownload(chrome, downloadItem())).toBe(true)
    // Nothing is written: the cancel starts immediately.
    expect(calls.cancelled).toEqual([41])
    vi.advanceTimersByTime(1_000)
    expect(calls.erased).toEqual([41])
    expect(readGofileCapture().downloads).toEqual([
      { url: DOWNLOAD_URL, filename: 'Fancam 01.mp4' }
    ])
  })

  it('rejects a foreign host, another tab and another referrer', () => {
    const { chrome, calls } = fakeChrome()
    armGofileCapture({ tabId: 7, pageUrl: SHARE_URL })

    expect(
      captureGofileDownload(
        chrome,
        downloadItem({
          url: 'https://evil.example/download/f1/a.mp4',
          finalUrl: 'https://evil.example/download/f1/a.mp4'
        })
      )
    ).toBe(false)
    expect(captureGofileDownload(chrome, downloadItem({ tabId: 9 }))).toBe(false)
    expect(
      captureGofileDownload(
        chrome,
        downloadItem({ referrer: 'https://forum.example/thread/1' })
      )
    ).toBe(false)
    expect(calls.cancelled).toEqual([])
    // The armed tab's own download is still captured.
    expect(captureGofileDownload(chrome, downloadItem({ tabId: 7 }))).toBe(true)
  })

  it('records one download once, even when the browser reports it twice', () => {
    const { chrome, calls } = fakeChrome()
    armGofileCapture({ tabId: 7, pageUrl: SHARE_URL })
    expect(captureGofileDownload(chrome, downloadItem())).toBe(true)
    expect(captureGofileDownload(chrome, downloadItem())).toBe(true)
    expect(readGofileCapture().downloads).toHaveLength(1)
    expect(calls.cancelled).toEqual([41])
  })

  it('stops recording at the download cap', () => {
    armGofileCapture({ tabId: 7, pageUrl: SHARE_URL })
    for (let index = 0; index < GOFILE_CAPTURE_MAX_DOWNLOADS + 5; index += 1) {
      recordGofileCapture(downloadItem({ id: index + 1 }))
    }
    expect(readGofileCapture().downloads).toHaveLength(GOFILE_CAPTURE_MAX_DOWNLOADS)
  })

  it('forgets everything when the window closes', () => {
    const { chrome } = fakeChrome()
    armGofileCapture({ tabId: 7, pageUrl: SHARE_URL })
    captureGofileDownload(chrome, downloadItem())
    disarmGofileCapture()
    expect(readGofileCapture()).toEqual({ armed: false, downloads: [] })
    expect(isArmedGofileDownload(downloadItem())).toBe(false)
  })
})

describe('Gofile capture versus the automatic hand-off', () => {
  it('takes priority while armed and leaves the hand-off alone afterwards', async () => {
    const { chrome } = fakeChrome()
    // The background's wrapper: a captured download never reaches the hand-off.
    const handoff = vi.fn(async () => 'left-running')
    const onCreated = (item: unknown) => {
      if (captureGofileDownload(chrome, item)) return 'captured'
      return handoff()
    }

    armGofileCapture({ tabId: 7, pageUrl: SHARE_URL })
    expect(onCreated(downloadItem())).toBe('captured')
    expect(handoff).not.toHaveBeenCalled()

    disarmGofileCapture()
    await expect(onCreated(downloadItem({ id: 42 }))).resolves.toBe('left-running')
    expect(handoff).toHaveBeenCalledTimes(1)
  })
})

describe('Gofile capture listeners', () => {
  /** A browser whose downloads API exposes the two events the capture needs. */
  function fakeEventChrome() {
    const calls = { cancelled: [] as number[], erased: [] as number[] }
    let created: ((item: unknown) => void) | null = null
    let changed: ((delta: unknown) => void) | null = null
    const chrome = {
      runtime: { lastError: undefined },
      downloads: {
        onCreated: {
          addListener(listener: (item: unknown) => void) {
            created = listener
          }
        },
        onChanged: {
          addListener(listener: (delta: unknown) => void) {
            changed = listener
          }
        },
        cancel(id: number, callback: () => void) {
          calls.cancelled.push(id)
          callback()
        },
        erase(query: { id: number }, callback: () => void) {
          calls.erased.push(query.id)
          callback()
        }
      }
    }
    return {
      chrome,
      calls,
      fireCreated: (item: unknown) => created?.(item),
      fireChanged: (delta: unknown) => changed?.(delta),
      registered: () => created !== null && changed !== null
    }
  }

  afterEach(() => {
    resetGofileCaptureListenersForTests()
  })

  it('listens on onCreated without any onDeterminingFilename', () => {
    resetGofileCaptureListenersForTests()
    const fake = fakeEventChrome()
    expect(installGofileCaptureListeners(fake.chrome)).toBe(true)
    expect(fake.registered()).toBe(true)
    // A second call adds no second listener.
    expect(installGofileCaptureListeners(fake.chrome)).toBe(true)
  })

  it('records and cancels a download the created event reports', () => {
    vi.useFakeTimers()
    resetGofileCaptureListenersForTests()
    const fake = fakeEventChrome()
    installGofileCaptureListeners(fake.chrome)
    armGofileCapture({ tabId: 7, pageUrl: SHARE_URL })

    fake.fireCreated(downloadItem())
    expect(fake.calls.cancelled).toEqual([41])
    vi.advanceTimersByTime(1_000)
    expect(fake.calls.erased).toEqual([41])
    expect(readGofileCapture().downloads).toEqual([
      { url: DOWNLOAD_URL, filename: 'Fancam 01.mp4' }
    ])
  })

  it('folds the final URL and file name an onChanged delta reports', () => {
    resetGofileCaptureListenersForTests()
    const fake = fakeEventChrome()
    installGofileCaptureListeners(fake.chrome)
    armGofileCapture({ tabId: 7, pageUrl: SHARE_URL })
    // The created event reports the URL but no decided file name yet.
    fake.fireCreated(downloadItem({ filename: '' }))
    expect(readGofileCapture().downloads).toEqual([{ url: DOWNLOAD_URL, filename: null }])

    fake.fireChanged({
      id: 41,
      finalUrl: { current: 'https://store1.gofile.io/download/web/f9/Fancam%2001.mp4' },
      filename: { current: 'C:\\Temp\\Fancam 01.mp4' }
    })
    expect(readGofileCapture().downloads).toEqual([
      {
        url: 'https://store1.gofile.io/download/web/f9/Fancam%2001.mp4',
        filename: 'Fancam 01.mp4'
      }
    ])
  })

  it('never lets a delta pull a foreign URL into the record', () => {
    resetGofileCaptureListenersForTests()
    const fake = fakeEventChrome()
    installGofileCaptureListeners(fake.chrome)
    armGofileCapture({ tabId: 7, pageUrl: SHARE_URL })
    fake.fireCreated(downloadItem())
    fake.fireChanged({ id: 41, finalUrl: { current: 'https://evil.example/f1/a.mp4' } })
    expect(readGofileCapture().downloads).toEqual([
      { url: DOWNLOAD_URL, filename: 'Fancam 01.mp4' }
    ])
  })

  it('ignores a delta for a download it never recorded', () => {
    resetGofileCaptureListenersForTests()
    const fake = fakeEventChrome()
    installGofileCaptureListeners(fake.chrome)
    armGofileCapture({ tabId: 7, pageUrl: SHARE_URL })
    fake.fireChanged({ id: 77, finalUrl: { current: DOWNLOAD_URL } })
    expect(readGofileCapture().downloads).toEqual([])
  })
})
