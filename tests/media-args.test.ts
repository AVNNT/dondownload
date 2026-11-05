import { describe, expect, it } from 'vitest'
import {
  CONCURRENT_FRAGMENTS,
  PROGRESS_TEMPLATE,
  buildAnalyzeArgs,
  buildDownloadArgs,
  parseProgressLine
} from '../src/main/media/args'

const sourceUrl = 'https://example.com/watch?v=1'

function args(overrides: {
  mergeOutputFormat: string | null
  remuxOutputFormat?: string | null
  ffmpegLocation?: string | null
}): string[] {
  return buildDownloadArgs({
    sourceUrl,
    formatSelector: overrides.mergeOutputFormat === null ? '22' : '137+140',
    outputTemplate: 'video.%(ext)s',
    mergeOutputFormat: overrides.mergeOutputFormat,
    remuxOutputFormat: overrides.remuxOutputFormat ?? null,
    ffmpegLocation: overrides.ffmpegLocation ?? null
  })
}

describe('buildDownloadArgs HLS and fragment downloads', () => {
  it('keeps FFmpeg for merging but uses the native fragment downloader', () => {
    const merged = args({
      mergeOutputFormat: 'mkv',
      ffmpegLocation: 'C:\\tools\\ffmpeg.exe'
    })

    expect(merged).toContain('--merge-output-format')
    expect(merged).toContain('--ffmpeg-location')
    expect(merged).not.toContain('--hls-prefer-ffmpeg')
    expect(merged[merged.indexOf('--concurrent-fragments') + 1]).toBe(
      String(CONCURRENT_FRAGMENTS)
    )
    expect(merged[merged.length - 2]).toBe('--')
    expect(merged[merged.length - 1]).toBe(sourceUrl)
  })

  it('adds remux only for an explicit compatible container change', () => {
    const direct = args({ mergeOutputFormat: null })

    expect(direct).not.toContain('--merge-output-format')
    expect(direct).not.toContain('--hls-prefer-ffmpeg')
    expect(direct).not.toContain('--remux-video')
    expect(direct[direct.indexOf('--concurrent-fragments') + 1]).toBe(
      String(CONCURRENT_FRAGMENTS)
    )

    const remuxed = args({
      mergeOutputFormat: null,
      remuxOutputFormat: 'mkv',
      ffmpegLocation: 'C:\\tools\\ffmpeg.exe'
    })
    expect(remuxed).toContain('--remux-video')
    expect(remuxed[remuxed.indexOf('--remux-video') + 1]).toBe('mkv')
    expect(remuxed).toContain('--ffmpeg-location')
    expect(remuxed).not.toContain('--merge-output-format')
    expect(remuxed[remuxed.length - 2]).toBe('--')
    expect(remuxed[remuxed.length - 1]).toBe(sourceUrl)
  })
})

describe('build*Args impersonation', () => {
  it('adds the verified Chrome target before the fixed arguments', () => {
    const analyze = buildAnalyzeArgs(sourceUrl, null, true)
    expect(analyze.slice(0, 2)).toEqual(['--impersonate', 'chrome'])
    expect(analyze[analyze.length - 2]).toBe('--')

    const download = buildDownloadArgs({
      sourceUrl,
      formatSelector: '22',
      outputTemplate: 'video.%(ext)s',
      mergeOutputFormat: null,
      remuxOutputFormat: null,
      ffmpegLocation: null,
      impersonate: true
    })
    expect(download.slice(0, 2)).toEqual(['--impersonate', 'chrome'])
    expect(download[download.length - 2]).toBe('--')
  })

  it('omits the flag when support was not verified', () => {
    expect(buildAnalyzeArgs(sourceUrl)).not.toContain('--impersonate')
    expect(args({ mergeOutputFormat: null })).not.toContain('--impersonate')
  })
})

describe('parseProgressLine', () => {
  it('parses byte totals, estimates and fragment position', () => {
    expect(
      parseProgressLine(
        'DONDOWNLOAD_PROGRESS|10|NA|800|12.5|137|3|10'
      )
    ).toEqual({
      completedBytes: 10,
      totalBytes: 800,
      speedBps: 12,
      streamId: '137',
      fragmentIndex: 3,
      fragmentCount: 10
    })
  })

  it('parses fragment-only records without any byte total', () => {
    expect(
      parseProgressLine('DONDOWNLOAD_PROGRESS|5000|NA|NA|1000|628|5|20')
    ).toEqual({
      completedBytes: 5000,
      totalBytes: null,
      speedBps: 1000,
      streamId: '628',
      fragmentIndex: 5,
      fragmentCount: 20
    })
  })

  it('accepts the original six-column shape for compatibility', () => {
    expect(parseProgressLine('DONDOWNLOAD_PROGRESS|10|NA|NA|NA|NA')).toEqual({
      completedBytes: 10,
      totalBytes: null,
      speedBps: 0,
      streamId: 'stream',
      fragmentIndex: null,
      fragmentCount: null
    })
  })

  it('rejects malformed progress records', () => {
    expect(parseProgressLine('DONDOWNLOAD_PROGRESS|NA|1|1|1|1')).toBeNull()
    expect(parseProgressLine('not progress')).toBeNull()
  })

  it('includes fragment fields in the template', () => {
    expect(PROGRESS_TEMPLATE).toContain('%(progress.fragment_index)s')
    expect(PROGRESS_TEMPLATE).toContain('%(progress.fragment_count)s')
  })
})
