import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ScanSession } from '../src/shared/scanner'
import { createScanAutoStart } from '../src/renderer/src/scanAutoStart'

function session(id: string, origin: 'paste' | 'extension' = 'paste'): ScanSession {
  return {
    sessionId: id,
    status: 'scanning',
    origin,
    hostname: 'forum.example',
    message: null,
    signinRequired: false,
    counters: { found: 0, probing: 0, ready: 0, signin: 0, unavailable: 0 },
    progress: { fetchedPages: 0, totalItems: 0, queueableItems: 0 },
    items: [],
    removedItemIds: [],
    revision: 0,
    updatedAt: 1
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('scan auto-start controller', () => {
  it('has no queue path at all', () => {
    const controller = createScanAutoStart({
      start: async () => ({ ok: true, value: session('scan_1') }),
      cancel: async () => ({ ok: true, value: session('scan_1') })
    })
    expect(Object.keys(controller).sort()).toEqual(['cancel', 'update'])
    controller.cancel()
  })

  it('debounces and starts only the latest URL', async () => {
    vi.useFakeTimers()
    const started: string[] = []
    const cancelled: string[] = []
    const controller = createScanAutoStart({
      delayMs: 20,
      start: async (url) => {
        started.push(url)
        return { ok: true, value: session(`scan_${started.length}`) }
      },
      cancel: async (id) => {
        cancelled.push(id)
        return { ok: true, value: session(id) }
      }
    })

    controller.update('https://forum.example/one')
    controller.update('https://forum.example/two')
    controller.update('https://forum.example/two#post')
    await vi.advanceTimersByTimeAsync(30)

    expect(started).toEqual(['https://forum.example/two'])
    expect(cancelled).toEqual([])
  })

  it('cancels the previous session when the URL changes', async () => {
    vi.useFakeTimers()
    const cancelled: string[] = []
    const controller = createScanAutoStart({
      delayMs: 10,
      start: async (url) => ({
        ok: true,
        value: session(url.endsWith('one') ? 'scan_one' : 'scan_two')
      }),
      cancel: async (id) => {
        cancelled.push(id)
        return { ok: true, value: session(id) }
      }
    })

    controller.update('https://forum.example/one')
    await vi.advanceTimersByTimeAsync(15)
    controller.update('https://forum.example/two')
    await vi.advanceTimersByTimeAsync(15)
    expect(cancelled).toEqual(['scan_one'])
  })
})
