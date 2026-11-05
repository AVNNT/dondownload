import { describe, expect, it } from 'vitest'
import { buildDownloadArgs } from '../src/main/media/args'

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

describe('buildDownloadArgs HLS preference', () => {
  it('prefers FFmpeg for HLS only when a merge output format is selected', () => {
    const merged = args({
      mergeOutputFormat: 'mkv',
      ffmpegLocation: 'C:\\tools\\ffmpeg.exe'
    })

    expect(merged).toContain('--merge-output-format')
    expect(merged).toContain('--hls-prefer-ffmpeg')
    expect(merged.indexOf('--hls-prefer-ffmpeg')).toBeLessThan(
      merged.indexOf('--ffmpeg-location')
    )
    expect(merged[merged.length - 2]).toBe('--')
    expect(merged[merged.length - 1]).toBe(sourceUrl)
  })

  it('adds remux only for an explicit compatible container change', () => {
    const direct = args({ mergeOutputFormat: null })

    expect(direct).not.toContain('--merge-output-format')
    expect(direct).not.toContain('--hls-prefer-ffmpeg')
    expect(direct).not.toContain('--remux-video')

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
