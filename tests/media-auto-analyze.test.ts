import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiResult } from '../src/shared/types'
import type { MediaAnalysis } from '../src/shared/media'
import { createMediaAutoAnalyzer } from '../src/renderer/src/mediaAutoAnalyze'

function analysis(title: string): MediaAnalysis {
  return {
    analysisId: `analysis_${title}`,
    title,
    durationSeconds: 10,
    options: [],
    bestVideoOptionId: null,
    bestAudioOptionId: null,
    expiresAt: 1_800_000_000_000
  }
}

function ok(value: MediaAnalysis): ApiResult<MediaAnalysis> {
  return { ok: true, value }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('media auto-analysis', () => {
  it('debounces valid URLs, ignores duplicates and stale results, and never queues', async () => {
    vi.useFakeTimers()
    const calls: string[] = []
    const pending: Array<{
      url: string
      resolve: (value: ApiResult<MediaAnalysis>) => void
    }> = []
    const results: string[] = []

    const analyzer = createMediaAutoAnalyzer({
      delayMs: 400,
      analyze: (url) => {
        calls.push(url)
        return new Promise<ApiResult<MediaAnalysis>>((resolve) => {
          pending.push({ url, resolve })
        })
      },
      onResult: (result) => {
        if (result.ok) results.push(result.value.title)
      }
    })

    // Incomplete input is not a request and does not touch the network.
    analyzer.update('not a url')
    vi.advanceTimersByTime(1_000)
    expect(calls).toEqual([])

    analyzer.update('https://a.example/watch?v=1')
    vi.advanceTimersByTime(399)
    expect(calls).toEqual([])
    vi.advanceTimersByTime(1)
    expect(calls).toEqual(['https://a.example/watch?v=1'])

    // The same normalized URL is never requested twice.
    analyzer.update('https://a.example/watch?v=1#fragment')
    vi.advanceTimersByTime(1_000)
    expect(calls).toHaveLength(1)

    analyzer.update('https://b.example/watch?v=2')
    vi.advanceTimersByTime(400)
    expect(calls).toEqual([
      'https://a.example/watch?v=1',
      'https://b.example/watch?v=2'
    ])

    // B resolves first, then the older A result arrives. Only B may apply.
    pending[1]?.resolve(ok(analysis('B')))
    await Promise.resolve()
    pending[0]?.resolve(ok(analysis('A')))
    await Promise.resolve()
    expect(results).toEqual(['B'])

    // Invalid text clears the old result; returning to that URL analyzes again.
    analyzer.update('incomplete')
    analyzer.update('https://b.example/watch?v=2')
    vi.advanceTimersByTime(400)
    expect(calls).toHaveLength(3)
    pending[2]?.resolve(ok(analysis('B again')))
    await Promise.resolve()
    expect(results).toEqual(['B', 'B again'])

    // There is no queue callback in this controller: analysis alone can never
    // create a download.
    expect(Object.keys(analyzer).sort()).toEqual(['cancel', 'update'])
  })
})
