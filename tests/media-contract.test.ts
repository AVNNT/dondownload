import { describe, expect, it } from 'vitest'
import {
  MEDIA_JOB_STATUSES,
  normalizeMediaSourceUrl,
  parseAnalyzeMediaInput,
  parseMediaAnalysis,
  parseMediaFormatOption,
  parseMediaJob,
  parseMediaQueueInput,
  parseMediaSnapshot,
  parseMediaToolState
} from '../src/shared/media'
import {
  MEDIA_BRIDGE_ROUTES,
  parseMediaAnalyzeRequest,
  parseMediaBridgeResponse,
  parseMediaCancelRequest,
  parseMediaQueueRequest,
  parseMediaStatusRequest,
  parseNativeMediaRequest
} from '../src/shared/mediaBridge'

const ANALYSIS_ID = 'analysis_0123456789abcdef'
const VIDEO_OPTION_ID = 'option_video_0123456789'
const AUDIO_OPTION_ID = 'option_audio_0123456789'
const JOB_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'

function videoOption(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'video',
    optionId: VIDEO_OPTION_ID,
    label: '1080p MP4 - H.264 + AAC',
    container: 'mp4',
    width: 1920,
    height: 1080,
    fps: 30,
    videoCodec: 'avc1',
    audioCodec: 'mp4a',
    hasAudio: true,
    requiresMerge: true,
    filesizeBytes: 10_000,
    ...overrides
  }
}

function audioOption(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'audio',
    optionId: AUDIO_OPTION_ID,
    label: 'Audio only - Opus',
    container: 'opus',
    width: null,
    height: null,
    fps: null,
    videoCodec: null,
    audioCodec: 'opus',
    hasAudio: true,
    requiresMerge: false,
    filesizeBytes: null,
    ...overrides
  }
}

function analysis(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    analysisId: ANALYSIS_ID,
    title: 'Example media',
    durationSeconds: 91.5,
    options: [videoOption(), audioOption()],
    bestVideoOptionId: VIDEO_OPTION_ID,
    bestAudioOptionId: AUDIO_OPTION_ID,
    expiresAt: 1_800_000_000_000,
    ...overrides
  }
}

function job(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: JOB_ID,
    analysisId: ANALYSIS_ID,
    optionId: VIDEO_OPTION_ID,
    kind: 'video',
    title: 'Example media',
    label: '1080p MP4 - H.264 + AAC',
    status: 'downloading',
    completedBytes: 512,
    totalBytes: 1024,
    speedBps: 64,
    errorMessage: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_100,
    completedAt: null,
    ...overrides
  }
}

describe('media public schema', () => {
  it('parses video, audio and merged options without exposing raw selectors', () => {
    const video = parseMediaFormatOption(videoOption())
    const audio = parseMediaFormatOption(audioOption())

    expect(video).toMatchObject({ kind: 'video', requiresMerge: true, hasAudio: true })
    expect(video.optionId).toBe(VIDEO_OPTION_ID)
    expect(audio).toMatchObject({ kind: 'audio', width: null, videoCodec: null })
    expect(audio.filesizeBytes).toBeNull()
  })

  it('rejects unknown/extra option fields and malformed values', () => {
    expect(() => parseMediaFormatOption(videoOption({ cookies: 'SID=1' }))).toThrow()
    expect(() => parseMediaFormatOption(videoOption({ kind: 'subtitle' }))).toThrow()
    expect(() => parseMediaFormatOption(videoOption({ container: 'MP4/../../x' }))).toThrow()
    expect(() => parseMediaFormatOption(videoOption({ filesizeBytes: -1 }))).toThrow()
    expect(() => parseMediaFormatOption(videoOption({ estimatedBytes: -1 }))).toThrow()
    expect(() => parseMediaFormatOption(videoOption({ sizeIsEstimate: 'yes' }))).toThrow()
    expect(() => parseMediaFormatOption(videoOption({ width: 1.5 }))).toThrow()
    expect(() => parseMediaFormatOption(videoOption({ hasAudio: false }))).toThrow(/audio/)
    expect(() => parseMediaFormatOption(audioOption({ videoCodec: 'avc1' }))).toThrow(/video/)
  })

  it('parses exact, approximate and unavailable display sizes', () => {
    const exact = parseMediaFormatOption(
      videoOption({ estimatedBytes: 10_000, sizeIsEstimate: false })
    )
    expect(exact.estimatedBytes).toBe(10_000)
    expect(exact.sizeIsEstimate).toBe(false)

    const approximate = parseMediaFormatOption(
      videoOption({ estimatedBytes: 12_000, sizeIsEstimate: true })
    )
    expect(approximate.estimatedBytes).toBe(12_000)
    expect(approximate.sizeIsEstimate).toBe(true)

    // Older/unknown payloads stay display-safe without inventing a size.
    const unavailable = parseMediaFormatOption(audioOption())
    expect(unavailable.estimatedBytes).toBeNull()
    expect(unavailable.sizeIsEstimate).toBe(false)
  })

  it('accepts only server-advertised output containers and queue choices', () => {
    const option = parseMediaFormatOption(
      videoOption({
        outputFormats: ['auto', 'mp4', 'mkv'],
        outputSizes: {
          auto: { bytes: 1_000, isEstimate: true },
          mp4: { bytes: 900, isEstimate: true }
        },
        formatIds: ['137', '140'],
        hdr: true
      })
    )
    expect(option.outputFormats).toEqual(['auto', 'mp4', 'mkv'])
    expect(option.outputSizes?.mp4).toEqual({ bytes: 900, isEstimate: true })
    expect(option.formatIds).toEqual(['137', '140'])
    expect(option.hdr).toBe(true)

    expect(() =>
      parseMediaFormatOption(videoOption({ outputFormats: ['mp4', 'mp4'] }))
    ).toThrow(/output formats/)
    expect(() =>
      parseMediaFormatOption(videoOption({ outputFormats: ['avi'] }))
    ).toThrow(/output formats/)
    expect(() =>
      parseMediaFormatOption(videoOption({ outputFormats: [] }))
    ).toThrow(/output formats/)

    expect(
      parseMediaQueueInput({
        analysisId: ANALYSIS_ID,
        optionId: VIDEO_OPTION_ID,
        outputFormat: 'webm'
      })
    ).toEqual({
      analysisId: ANALYSIS_ID,
      optionId: VIDEO_OPTION_ID,
      outputFormat: 'webm'
    })
    expect(() =>
      parseMediaQueueInput({
        analysisId: ANALYSIS_ID,
        optionId: VIDEO_OPTION_ID,
        outputFormat: 'avi'
      })
    ).toThrow(/output format/)
  })

  it('parses an analysis and enforces opaque best-option references', () => {
    const parsed = parseMediaAnalysis(analysis())

    expect(parsed.options).toHaveLength(2)
    expect(parsed.bestVideoOptionId).toBe(VIDEO_OPTION_ID)
    expect(parsed.bestAudioOptionId).toBe(AUDIO_OPTION_ID)

    expect(() =>
      parseMediaAnalysis(analysis({ bestVideoOptionId: AUDIO_OPTION_ID }))
    ).toThrow(/video with audio/)
    expect(() =>
      parseMediaAnalysis(analysis({ bestAudioOptionId: 'option_missing_0123456789' }))
    ).toThrow(/audio without video/)
    expect(() =>
      parseMediaAnalysis(analysis({ options: [videoOption(), videoOption()] }))
    ).toThrow(/Duplicate/)
  })

  it('rejects extra analysis fields and unverified/secret fields', () => {
    expect(() => parseMediaAnalysis(analysis({ url: 'https://example.com/watch' }))).toThrow()
    expect(() => parseMediaAnalysis(analysis({ cookies: [] }))).toThrow()
    expect(() => parseMediaAnalysis(analysis({ expiresAt: 0 }))).toThrow()
  })

  it('parses every lifecycle status and rejects unknown statuses', () => {
    for (const status of MEDIA_JOB_STATUSES) {
      expect(parseMediaJob(job({ status })).status).toBe(status)
    }
    expect(() => parseMediaJob(job({ status: 'paused' }))).toThrow()
  })

  it('never accepts a URL, disk path or yt-dlp selector on a public job', () => {
    expect(() => parseMediaJob(job({ url: 'https://example.com/watch' }))).toThrow()
    expect(() => parseMediaJob(job({ dir: 'C:\\Downloads' }))).toThrow()
    expect(() => parseMediaJob(job({ filePath: 'C:\\Downloads\\out.mp4' }))).toThrow()
    expect(() => parseMediaJob(job({ format: 'bestvideo+bestaudio' }))).toThrow()
    expect(() => parseMediaJob(job({ headers: { Cookie: 'x' } }))).toThrow()
  })

  it('parses tool state and a media snapshot', () => {
    const tool = parseMediaToolState({
      status: 'ready',
      version: '2026.01.01',
      message: null,
      hint: null
    })
    expect(tool.status).toBe('ready')

    const snapshot = parseMediaSnapshot({ tool, jobs: [job()] })
    expect(snapshot.jobs[0]?.id).toBe(JOB_ID)

    expect(() =>
      parseMediaSnapshot({ tool: { ...tool, extra: true }, jobs: [] })
    ).toThrow()
    expect(() =>
      parseMediaSnapshot({ tool, jobs: [job(), job()] })
    ).toThrow(/Duplicate/)
  })

  it('parses queue input from opaque IDs only and keeps force explicit', () => {
    expect(
      parseMediaQueueInput({ analysisId: ANALYSIS_ID, optionId: VIDEO_OPTION_ID })
    ).toEqual({ analysisId: ANALYSIS_ID, optionId: VIDEO_OPTION_ID })
    expect(parseMediaQueueInput({
      analysisId: ANALYSIS_ID,
      optionId: VIDEO_OPTION_ID,
      maxBytes: 25_000_000
    })).toEqual({ analysisId: ANALYSIS_ID, optionId: VIDEO_OPTION_ID, maxBytes: 25_000_000 })
    expect(
      parseMediaQueueInput({
        analysisId: ANALYSIS_ID,
        optionId: VIDEO_OPTION_ID,
        force: true
      })
    ).toEqual({ analysisId: ANALYSIS_ID, optionId: VIDEO_OPTION_ID, force: true })
    expect(
      parseMediaQueueInput({
        analysisId: ANALYSIS_ID,
        optionId: VIDEO_OPTION_ID,
        force: false
      })
    ).toEqual({ analysisId: ANALYSIS_ID, optionId: VIDEO_OPTION_ID })

    expect(() => parseMediaQueueInput({ analysisId: 'bestvideo+bestaudio', optionId: VIDEO_OPTION_ID })).toThrow()
    for (const maxBytes of [0, -1, 1.5, 100 * 1024 ** 3 + 1]) {
      expect(() => parseMediaQueueInput({ analysisId: ANALYSIS_ID, optionId: VIDEO_OPTION_ID, maxBytes })).toThrow()
    }
    expect(() =>
      parseMediaQueueInput({
        analysisId: ANALYSIS_ID,
        optionId: VIDEO_OPTION_ID,
        selector: 'bestvideo'
      })
    ).toThrow()
    expect(() =>
      parseMediaQueueInput({
        analysisId: ANALYSIS_ID,
        optionId: VIDEO_OPTION_ID,
        force: 'yes'
      })
    ).toThrow()
  })
})

describe('media source URL normalization', () => {
  it('accepts http(s), rejects credentials, and strips fragments', () => {
    expect(() => normalizeMediaSourceUrl('https://user:secret@example.com/watch?v=1#part')).toThrow(
      /credentials/
    )
    expect(normalizeMediaSourceUrl('  http://example.com/a  ')).toBe('http://example.com/a')
    expect(parseAnalyzeMediaInput({ url: 'https://example.com/watch#x' })).toEqual({
      url: 'https://example.com/watch'
    })
  })

  it('rejects non-web, control-character and oversized URLs', () => {
    expect(() => normalizeMediaSourceUrl('file:///C:/secret.mp4')).toThrow()
    expect(() => normalizeMediaSourceUrl('javascript:alert(1)')).toThrow()
    expect(() => normalizeMediaSourceUrl('https://user@example.com/watch')).toThrow(/credentials/)
    expect(() => normalizeMediaSourceUrl('https://example.com/\u0000')).toThrow()
    expect(() => normalizeMediaSourceUrl(`https://example.com/${'a'.repeat(5000)}`)).toThrow()
  })
})

describe('media native bridge contract', () => {
  it('freezes default routes without changing queue-download', () => {
    expect(MEDIA_BRIDGE_ROUTES).toEqual({
      analyze: '/analyze-media',
      queue: '/queue-media',
      status: '/media-status',
      cancel: '/cancel-media'
    })
  })

  it('parses each strict native request', () => {
    expect(
      parseNativeMediaRequest({ type: 'analyze-media', url: 'https://example.com/v' })
    ).toEqual({ type: 'analyze-media', url: 'https://example.com/v' })
    expect(
      parseNativeMediaRequest({
        type: 'queue-media',
        analysisId: ANALYSIS_ID,
        optionId: VIDEO_OPTION_ID,
        force: true
      })
    ).toEqual({
      type: 'queue-media',
      analysisId: ANALYSIS_ID,
      optionId: VIDEO_OPTION_ID,
      force: true
    })
    expect(parseNativeMediaRequest({ type: 'media-status', jobId: JOB_ID })).toEqual({
      type: 'media-status',
      jobId: JOB_ID
    })
    expect(parseNativeMediaRequest({ type: 'cancel-media', jobId: JOB_ID })).toEqual({
      type: 'cancel-media',
      jobId: JOB_ID
    })
  })

  it('rejects unknown operations, extra fields and non-opaque identifiers', () => {
    expect(() =>
      parseNativeMediaRequest({ type: 'queue-download', url: 'https://example.com' })
    ).toThrow(/Unsupported/)
    expect(() =>
      parseNativeMediaRequest({
        type: 'analyze-media',
        url: 'https://example.com',
        dir: 'C:\\'
      })
    ).toThrow(/unsupported fields/)
    expect(() =>
      parseNativeMediaRequest({ type: 'media-status', jobId: '../not-a-job' })
    ).toThrow()
    expect(() =>
      parseNativeMediaRequest({ type: 'cancel-media', jobId: JOB_ID, force: true })
    ).toThrow(/unsupported fields/)
    expect(() =>
      parseMediaQueueRequest({ analysisId: ANALYSIS_ID, optionId: VIDEO_OPTION_ID, dir: 'x' })
    ).toThrow()
  })

  it('parses loopback request bodies', () => {
    expect(
      parseMediaAnalyzeRequest({
        url: 'https://example.com/v',
        cookie: 'session=abc'
      })
    ).toEqual({
      url: 'https://example.com/v',
      cookie: 'session=abc'
    })
    expect(() =>
      parseMediaAnalyzeRequest({
        url: 'https://example.com/v',
        cookie: 'a=b\r\nInjected: 1'
      })
    ).toThrow()
    expect(
      parseMediaQueueRequest({ analysisId: ANALYSIS_ID, optionId: AUDIO_OPTION_ID })
    ).toEqual({ analysisId: ANALYSIS_ID, optionId: AUDIO_OPTION_ID })
    expect(parseMediaStatusRequest({ jobId: JOB_ID })).toEqual({ jobId: JOB_ID })
    expect(parseMediaCancelRequest({ jobId: JOB_ID })).toEqual({ jobId: JOB_ID })
  })

  it('parses typed success and error responses', () => {
    const analyzeResponse = parseMediaBridgeResponse({
      ok: true,
      operation: 'analyze-media',
      analysis: analysis()
    })
    expect(analyzeResponse).toMatchObject({ ok: true, operation: 'analyze-media' })

    const queueResponse = parseMediaBridgeResponse({
      ok: true,
      operation: 'queue-media',
      job: job()
    })
    expect(queueResponse).toMatchObject({ ok: true, operation: 'queue-media' })

    expect(
      parseMediaBridgeResponse({
        ok: false,
        error: { code: 'MEDIA_ANALYSIS_EXPIRED', message: 'Analyze again.' }
      })
    ).toEqual({
      ok: false,
      error: { code: 'MEDIA_ANALYSIS_EXPIRED', message: 'Analyze again.' }
    })
  })

  it('rejects mismatched operations and extra response fields', () => {
    expect(() =>
      parseMediaBridgeResponse({
        ok: true,
        operation: 'queue-media',
        analysis: analysis()
      })
    ).toThrow()
    expect(() =>
      parseMediaBridgeResponse({
        ok: true,
        operation: 'analyze-media',
        analysis: analysis(),
        value: true
      })
    ).toThrow()
    expect(() =>
      parseMediaBridgeResponse({
        ok: false,
        error: { code: 'bad', message: 'x' }
      })
    ).toThrow()
  })
})
