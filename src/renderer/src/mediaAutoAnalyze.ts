import type { MediaAnalysis } from '@shared/media'
import { normalizeMediaSourceUrl } from '@shared/media'
import type { ApiResult } from '@shared/types'

/**
 * Debounced, URL-driven media analysis for the Media tab.
 *
 * The user never has to press Analyze. Every distinct normalized URL is
 * requested at most once per debounce window, and a response for an older URL
 * can never be delivered after a newer request has started. Analysis only
 * returns metadata: this controller has no queue path, so it can never start a
 * download by itself.
 */
export interface MediaAutoAnalyzerOptions {
  analyze: (url: string) => Promise<ApiResult<MediaAnalysis>>
  onResult?: (result: ApiResult<MediaAnalysis>, url: string) => void
  onRejected?: (error: unknown, url: string) => void
  delayMs?: number
  normalize?: (value: string) => string
}

export interface MediaAutoAnalyzer {
  update(rawUrl: string): void
  cancel(): void
}

export const MEDIA_AUTO_ANALYZE_DELAY_MS = 450

export function createMediaAutoAnalyzer(
  options: MediaAutoAnalyzerOptions
): MediaAutoAnalyzer {
  const delayMs = options.delayMs ?? MEDIA_AUTO_ANALYZE_DELAY_MS
  const normalize = options.normalize ?? normalizeMediaSourceUrl

  let timer: ReturnType<typeof setTimeout> | null = null
  let sequence = 0
  let lastUrl: string | null = null
  let pendingUrl: string | null = null

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    pendingUrl = null
  }

  const cancel = (): void => {
    clearTimer()
    sequence += 1
    lastUrl = null
  }

  const update = (rawUrl: string): void => {
    const raw = rawUrl.trim()
    if (raw.length === 0) {
      cancel()
      return
    }

    let url: string
    try {
      url = normalize(raw)
    } catch {
      // Incomplete/invalid text is not a request. It also cannot belong to the
      // pending/in-flight URL, so ignore any older response.
      clearTimer()
      sequence += 1
      return
    }

    if (url === lastUrl || url === pendingUrl) return
    clearTimer()
    // A different URL makes the previous request stale. If the user later
    // returns to it, it must be requested again instead of reusing a result
    // that has already been discarded.
    lastUrl = null
    pendingUrl = url
    const current = ++sequence
    timer = setTimeout(() => {
      timer = null
      pendingUrl = null
      lastUrl = url
      void options
        .analyze(url)
        .then((result) => {
          if (current !== sequence) return
          options.onResult?.(result, url)
        })
        .catch((error: unknown) => {
          if (current !== sequence) return
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
