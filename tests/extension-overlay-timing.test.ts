import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import {
  captureViewModel,
  formatOptionDetail,
  optionQueueKey
} from '../extension/capture-view'

interface CoreApi {
  PREFETCH_DEBOUNCE_MS: number
  isTriggerReady: (input: unknown) => boolean
  largestTriggerCandidate: (candidates: unknown) => { video?: unknown } | null
  prefetchDecision: (
    previous: unknown,
    input: unknown
  ) => { action: string; reason: string }
  prefetchResultApplies: (previous: unknown, input: unknown) => boolean
  isStreamingUnsupported: (unsupported: unknown) => boolean
  isOptionQueued: (queued: unknown, optionId: unknown) => boolean
  markOptionQueued: (queued: unknown, optionId: unknown) => string[]
}

const coreSource = readFileSync(
  path.join(process.cwd(), 'extension', 'overlay-core.js'),
  'utf8'
)
const core = vm.runInNewContext(
  `${coreSource}\n;globalThis.DonDownloadOverlayCore`,
  { URL }
) as CoreApi

describe('floating icon readiness', () => {
  it('shows for a play() request or loaded metadata, not only a rendered frame', () => {
    // play() was called even before a frame is decoded.
    expect(core.isTriggerReady({ paused: false, readyState: 0 })).toBe(true)
    expect(core.isTriggerReady({ paused: false, readyState: 1 })).toBe(true)
    // Paused but metadata is available (user paused immediately or at inject).
    expect(core.isTriggerReady({ paused: true, readyState: 1 })).toBe(true)
    expect(core.isTriggerReady({ paused: true, readyState: 4 })).toBe(true)
  })

  it('does not show for an empty, errored or detached player', () => {
    expect(core.isTriggerReady({ paused: true, readyState: 0 })).toBe(false)
    expect(core.isTriggerReady({ paused: false, readyState: 4, error: {} })).toBe(false)
    expect(
      core.isTriggerReady({ paused: false, readyState: 4, isConnected: false })
    ).toBe(false)
    expect(core.isTriggerReady(null)).toBe(false)
  })

  it('picks the largest ready candidate and ignores unready/small ones', () => {
    const best = core.largestTriggerCandidate([
      { video: 'unready', ready: false, rect: { width: 1920, height: 1080 } },
      { video: 'small', ready: true, rect: { width: 320, height: 180 } },
      { video: 'large', ready: true, rect: { width: 1280, height: 720 } },
      { video: 'unusable', ready: true, usable: false, rect: { width: 1920, height: 1080 } }
    ])
    expect(best?.video).toBe('large')
    expect(core.largestTriggerCandidate([])).toBeNull()
  })
})

describe('background analysis prefetch policy', () => {
  const now = 1_800_000_000_000
  const url = 'https://video.example/watch?v=1'

  it('debounces a new page and is disabled when not eligible', () => {
    expect(
      core.prefetchDecision(null, { url, now, eligible: true })
    ).toEqual({ action: 'debounce', reason: 'new' })
    expect(
      core.prefetchDecision({ url, status: 'idle' }, { url, now, eligible: true })
    ).toEqual({ action: 'debounce', reason: 'idle' })
    expect(
      core.prefetchDecision(null, { url, now, eligible: false })
    ).toEqual({ action: 'none', reason: 'not-eligible' })
    expect(core.PREFETCH_DEBOUNCE_MS).toBe(500)
  })

  it('allows exactly one in-flight analysis per tab URL', () => {
    expect(
      core.prefetchDecision(
        { url, status: 'analyzing' },
        { url, now, eligible: true }
      )
    ).toEqual({ action: 'none', reason: 'in-flight' })
    expect(
      core.prefetchDecision(
        { url, status: 'debouncing' },
        { url, now, eligible: true }
      )
    ).toEqual({ action: 'none', reason: 'in-flight' })
    // A different URL is a new page: debounce it rather than reusing old data.
    expect(
      core.prefetchDecision(
        { url: 'https://video.example/watch?v=old', status: 'ready', expiresAt: now + 1000 },
        { url, now, eligible: true }
      )
    ).toEqual({ action: 'debounce', reason: 'url-changed' })
  })

  it('reuses the cached result until expiry and never auto-retries a failure', () => {
    expect(
      core.prefetchDecision(
        { url, status: 'ready', expiresAt: now + 60_000 },
        { url, now, eligible: true }
      )
    ).toEqual({ action: 'reuse', reason: 'cached' })
    expect(
      core.prefetchDecision(
        { url, status: 'ready', expiresAt: now },
        { url, now, eligible: true }
      )
    ).toEqual({ action: 'analyze', reason: 'expired' })
    expect(
      core.prefetchDecision(
        { url, status: 'error' },
        { url, now, eligible: true }
      )
    ).toEqual({ action: 'none', reason: 'failed' })
  })

  it('ignores responses that belong to an older URL or token', () => {
    const previous = { url, status: 'analyzing', token: 7, startedAt: now }
    expect(
      core.prefetchResultApplies(previous, { url, token: 7, now: now + 1000 })
    ).toBe(true)
    expect(
      core.prefetchResultApplies(previous, { url, token: 6, now: now + 1000 })
    ).toBe(false)
    expect(
      core.prefetchResultApplies(previous, {
        url: 'https://video.example/watch?v=2',
        token: 7,
        now: now + 1000
      })
    ).toBe(false)
    expect(
      core.prefetchResultApplies(previous, {
        url,
        token: 7,
        now: now + 11 * 60_000
      })
    ).toBe(false)
  })
})

describe('streaming detection and queue feedback helpers', () => {
  it('treats blob/MSE, manifest and non-progressive sources as streaming', () => {
    expect(core.isStreamingUnsupported({ code: 'SEGMENTED_MEDIA' })).toBe(true)
    expect(core.isStreamingUnsupported({ code: 'MANIFEST_STREAM' })).toBe(true)
    expect(core.isStreamingUnsupported({ code: 'NOT_PROGRESSIVE' })).toBe(true)
    expect(core.isStreamingUnsupported({ code: 'PLAYBACK_ERROR' })).toBe(false)
    expect(core.isStreamingUnsupported(null)).toBe(false)
  })

  it('marks an exact option as queued once', () => {
    let queued: string[] = []
    expect(core.isOptionQueued(queued, 'option_1')).toBe(false)
    queued = core.markOptionQueued(queued, 'option_1')
    expect(queued).toEqual(['option_1'])
    expect(core.isOptionQueued(queued, 'option_1')).toBe(true)
    expect(core.markOptionQueued(queued, 'option_1')).toEqual(['option_1'])
    expect(core.isOptionQueued(queued, 'option_2')).toBe(false)
  })
})

describe('popup capture view', () => {
  const analysis = {
    analysisId: 'analysis_1',
    title: 'Verified video',
    options: [
      {
        kind: 'video' as const,
        optionId: 'option_1080',
        label: '1080p MP4',
        container: 'mp4',
        width: 1920,
        height: 1080,
        fps: 30,
        requiresMerge: true,
        estimatedBytes: 1024 * 1024,
        sizeIsEstimate: false
      }
    ]
  }

  it('shows streaming detection and verified options instead of the old copy', () => {
    const model = captureViewModel({
      sources: [],
      streaming: { detected: true, code: 'SEGMENTED_MEDIA', message: 'Media Source' },
      analysis,
      status: 'ready'
    })
    expect(model.mode).toBe('streaming')
    expect(model.detectedLabel).toBe('Streaming video detected')
    expect(model.showAnalysis).toBe(true)
    expect(model.showFindAction).toBe(false)
    expect(model.options).toHaveLength(1)
  })

  it('shows a finding state, then a retry after failure', () => {
    const running = captureViewModel({
      sources: [],
      streaming: { detected: true, code: 'MANIFEST_STREAM' },
      status: 'analyzing'
    })
    expect(running.analyzing).toBe(true)
    expect(running.showFindAction).toBe(false)

    const failed = captureViewModel({
      sources: [],
      streaming: { detected: true, code: 'MANIFEST_STREAM' },
      status: 'error'
    })
    expect(failed.failed).toBe(true)
    expect(failed.showFindAction).toBe(true)
  })

  it('keeps progressive sources and nothing-detected distinct', () => {
    const embedded = captureViewModel({
      sources: [],
      streaming: { detected: true, code: 'EMBED_PLAYER', embedded: true },
      status: 'idle'
    })
    expect(embedded.mode).toBe('streaming')
    expect(embedded.detectedLabel).toBe('Embedded video detected')
    expect(embedded.showFindAction).toBe(true)

    const progressive = captureViewModel({
      sources: [
        {
          url: 'https://cdn.example/clip.mp4',
          filename: 'clip.mp4',
          qualityLabel: '360p',
          current: true
        }
      ],
      streaming: { detected: false },
      status: 'idle'
    })
    expect(progressive.mode).toBe('progressive')
    expect(progressive.detectedLabel).toBe('1 source')

    const empty = captureViewModel({ sources: [], status: 'idle' })
    expect(empty.mode).toBe('empty')
    expect(empty.detectedLabel).toBe('Nothing detected')
    expect(empty.showFindAction).toBe(true)
  })

  it('formats verified sizes and keys queue feedback by analysis + option', () => {
    expect(formatOptionDetail(analysis.options[0])).toContain('1080p · MP4')
    expect(formatOptionDetail(analysis.options[0])).toContain('1.00 MB')
    expect(formatOptionDetail(analysis.options[0])).toContain('merged')
    expect(optionQueueKey('analysis_1', 'option_1080')).toBe(
      'analysis_1:option_1080'
    )
    expect(optionQueueKey('', 'option_1080')).toBe('')
  })
})
