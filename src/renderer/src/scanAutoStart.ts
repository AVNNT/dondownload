import type { ApiResult } from '@shared/types'
import type { ScanSession } from '@shared/scanner'
import { normalizeHttpUrl } from '@shared/validation'

/**
 * Debounced, URL-driven page scanning for the Add dialog.
 *
 * This controller can only start and cancel scans. It has no queue method and
 * no reference to the queue API, so pasting a URL can never download anything.
 * Latest-wins sequencing guarantees an older response never replaces a newer
 * one.
 */
export interface ScanAutoStartOptions {
  start: (url: string) => Promise<ApiResult<ScanSession>>
  cancel: (sessionId: string) => Promise<ApiResult<ScanSession>>
  onResult?: (result: ApiResult<ScanSession>, url: string) => void
  onRejected?: (error: unknown, url: string) => void
  delayMs?: number
}

export interface ScanAutoStart {
  update(rawUrl: string): void
  cancel(): void
}

export const SCAN_AUTO_START_DELAY_MS = 450

export function createScanAutoStart(options: ScanAutoStartOptions): ScanAutoStart {
  const delayMs = options.delayMs ?? SCAN_AUTO_START_DELAY_MS

  let timer: ReturnType<typeof setTimeout> | null = null
  let sequence = 0
  let lastUrl: string | null = null
  let pendingUrl: string | null = null
  let activeSessionId: string | null = null

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    pendingUrl = null
  }

  const cancelActive = (): void => {
    const sessionId = activeSessionId
    activeSessionId = null
    if (sessionId === null) return
    void options.cancel(sessionId).catch(() => undefined)
  }

  const cancel = (): void => {
    clearTimer()
    sequence += 1
    lastUrl = null
    cancelActive()
  }

  const update = (rawUrl: string): void => {
    const raw = rawUrl.trim()
    if (raw.length === 0) {
      cancel()
      return
    }

    let url: string
    try {
      url = normalizeHttpUrl(raw)
    } catch {
      clearTimer()
      sequence += 1
      lastUrl = null
      cancelActive()
      return
    }

    if (url === lastUrl || url === pendingUrl) return
    clearTimer()
    lastUrl = null
    pendingUrl = url
    cancelActive()
    const current = ++sequence
    timer = setTimeout(() => {
      timer = null
      pendingUrl = null
      lastUrl = url
      void options
        .start(url)
        .then((result) => {
          if (current !== sequence) {
            // An update for this URL arrived while it was in flight. The newer
            // controller pass owns the visible session.
            if (result.ok) {
              void options.cancel(result.value.sessionId).catch(() => undefined)
            }
            return
          }
          if (!result.ok) lastUrl = null
          else activeSessionId = result.value.sessionId
          options.onResult?.(result, url)
        })
        .catch((error: unknown) => {
          if (current !== sequence) return
          lastUrl = null
          options.onRejected?.(error, url)
        })
    }, delayMs)
  }

  return {
    update,
    cancel(): void {
      cancel()
    }
  }
}
