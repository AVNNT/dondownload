import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { MediaInfoError, applyProbedHeights, buildMediaAnalysis, resolutionProbeTargets } from '../src/main/media/formats'

function optionIds(): () => string {
  let next = 0
  return () => `option-${(next += 1)}`
}

function format(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    ext: 'mp4',
    protocol: 'https',
    url: 'https://cdn.example.com/media',
    ...overrides
  }
}

function fixture(name: string): Record<string, unknown> {
  const raw = readFileSync(
    path.join(process.cwd(), 'tests', 'fixtures', 'ytdlp-json', name),
    'utf8'
  )
  return JSON.parse(raw) as Record<string, unknown>
}

function analyze(name: string, ffmpegAvailable = true) {
  return buildMediaAnalysis(fixture(name), {
    ffmpegAvailable,
    newOptionId: optionIds()
  })
}

describe('real quality labels', () => {
  function analyzeFormats(formats: Record<string, unknown>[]) {
    return buildMediaAnalysis(
      {
        title: 'Quality labels',
        formats
      },
      { ffmpegAvailable: false, newOptionId: optionIds() }
    )
  }

  it('reads a resolution hint from format_note, format id and the stream URL', () => {
    const fromNote = analyzeFormats([
      format({
        format_id: '1',
        format_note: '1080p',
        vcodec: 'avc1',
        acodec: 'mp4a'
      })
    ])
    expect(fromNote.options[0]?.dto.label).toContain('1080p MP4')

    const fromId = analyzeFormats([
      format({
        format_id: 'hls-720',
        vcodec: 'avc1',
        acodec: 'mp4a'
      })
    ])
    expect(fromId.options[0]?.dto.label).toContain('720p MP4')

    const fromUrl = analyzeFormats([
      format({
        format_id: '1',
        url: 'https://cdn.example.com/movie-1080.mp4',
        vcodec: 'avc1',
        acodec: 'mp4a'
      })
    ])
    expect(fromUrl.options[0]?.dto.label).toContain('1080p MP4')
  })

  it('reads a resolution out of a 640x360 resolution string', () => {
    const analysis = analyzeFormats([
      format({
        format_id: '1',
        resolution: '640x360',
        vcodec: 'avc1',
        acodec: 'mp4a'
      })
    ])
    expect(analysis.options[0]?.dto.label).toContain('360p MP4')
  })

  it('never shows a raw format id as quality and uses a friendly fallback', () => {
    const analysis = analyzeFormats([
      format({
        format_id: '1',
        vcodec: 'avc1',
        acodec: 'mp4a'
      })
    ])
    const label = analysis.options[0]?.dto.label ?? ''
    expect(label).toContain('Source quality (MP4)')
    expect(label).not.toContain('Quality 1')
    expect(label).not.toMatch(/\bQuality\b/)
  })

  it('uses a bitrate hint so two unknown renditions stay distinguishable', () => {
    const analysis = analyzeFormats([
      format({
        format_id: '1',
        url: 'https://cdn.example.com/a.mp4',
        vcodec: 'avc1',
        acodec: 'mp4a',
        tbr: 4200
      }),
      format({
        format_id: '2',
        url: 'https://cdn.example.com/b.mp4',
        vcodec: 'avc1',
        acodec: 'mp4a',
        tbr: 1400
      })
    ])
    const labels = analysis.options.map((option) => option.dto.label)
    expect(labels).toHaveLength(2)
    expect(labels[0]).toContain('Source quality (MP4) · 4200 kbps')
    expect(labels[1]).toContain('Source quality (MP4) · 1400 kbps')
  })

  it('probes only unknown direct formats and merges a learned height', () => {
    const raw = {
      title: 'Probe',
      formats: [
        format({
          format_id: '1',
          url: 'https://cdn.example.com/unknown.mp4',
          vcodec: 'avc1',
          acodec: 'mp4a'
        }),
        format({
          format_id: 'hls',
          protocol: 'm3u8_native',
          url: 'https://cdn.example.com/unknown.m3u8',
          vcodec: 'avc1',
          acodec: 'mp4a'
        }),
        format({
          format_id: 'known',
          width: 1280,
          height: 720,
          vcodec: 'avc1',
          acodec: 'mp4a'
        })
      ]
    }
    const built = buildMediaAnalysis(raw, {
      ffmpegAvailable: true,
      newOptionId: optionIds()
    })
    const targets = resolutionProbeTargets(built, raw)
    // The known format needs no probe; the HLS playlist is never header-probed.
    expect(targets).toEqual([
      { formatId: '1', url: 'https://cdn.example.com/unknown.mp4' }
    ])

    const refined = buildMediaAnalysis(
      applyProbedHeights(raw, new Map([['1', 1080]])),
      { ffmpegAvailable: true, newOptionId: optionIds() }
    )
    expect(
      refined.options.find((option) => option.dto.formatIds?.[0] === '1')?.dto
        .label
    ).toContain('1080p MP4')
  })
})

describe('media format DRM detection', () => {
  it('rejects a metadata set whose every rendition is DRM-protected', () => {
    expect(() =>
      buildMediaAnalysis(
        {
          title: 'DRM video',
          formats: [
            format({
              format_id: 'hls-720',
              vcodec: 'avc1',
              acodec: 'mp4a',
              width: 1280,
              height: 720,
              has_drm: true
            }),
            format({
              format_id: 'hls-1080',
              vcodec: 'avc1',
              acodec: 'mp4a',
              width: 1920,
              height: 1080,
              has_drm: true
            })
          ]
        },
        { ffmpegAvailable: true, newOptionId: optionIds() }
      )
    ).toThrowError(MediaInfoError)
    try {
      buildMediaAnalysis(
        { formats: [format({ format_id: '1', has_drm: true })] },
        { ffmpegAvailable: true, newOptionId: optionIds() }
      )
    } catch (error) {
      expect((error as MediaInfoError).reason).toBe('drm')
    }
  })

  it('still offers the non-DRM renditions of a mixed response', () => {
    const analysis = buildMediaAnalysis(
      {
        title: 'Mixed video',
        formats: [
          format({ format_id: '1', has_drm: true, vcodec: 'avc1', acodec: 'mp4a' }),
          format({
            format_id: '2',
            ext: 'mp4',
            vcodec: 'avc1',
            acodec: 'mp4a',
            width: 640,
            height: 360
          })
        ]
      },
      { ffmpegAvailable: true, newOptionId: optionIds() }
    )
    expect(analysis.options.length).toBeGreaterThan(0)
    expect(
      analysis.options.some((option) => option.dto.formatIds?.includes('1'))
    ).toBe(false)
  })
})

describe('media format protocol preference', () => {
  it('prefers direct HTTPS video over an equivalent HLS playlist', () => {
    const analysis = buildMediaAnalysis(
      {
        title: 'Example video',
        duration: 60,
        formats: [
          format({
            format_id: '628',
            vcodec: 'avc1.640032',
            acodec: 'none',
            width: 3840,
            height: 2160,
            fps: 60,
            protocol: 'm3u8_native'
          }),
          format({
            format_id: '313',
            vcodec: 'avc1.640032',
            acodec: 'none',
            width: 3840,
            height: 2160,
            fps: 60,
            protocol: 'https'
          }),
          format({
            format_id: '140',
            ext: 'm4a',
            vcodec: 'none',
            acodec: 'mp4a.40.2',
            abr: 128
          })
        ]
      },
      { ffmpegAvailable: true, newOptionId: optionIds() }
    )

    const video = analysis.options.find((option) => option.dto.kind === 'video')
    expect(video?.dto.formatIds).toEqual(['313', '140'])
    expect(video?.choices.get('auto')?.formatIds).toEqual(['313', '140'])
  })

  it('prefers direct HTTPS audio over an equivalent HLS playlist', () => {
    const analysis = buildMediaAnalysis(
      {
        title: 'Example audio',
        duration: 60,
        formats: [
          format({
            format_id: 'hls-audio',
            ext: 'm4a',
            vcodec: 'none',
            acodec: 'mp4a.40.2',
            abr: 128,
            protocol: 'm3u8'
          }),
          format({
            format_id: 'https-audio',
            ext: 'm4a',
            vcodec: 'none',
            acodec: 'mp4a.40.2',
            abr: 128,
            protocol: 'https'
          })
        ]
      },
      { ffmpegAvailable: false, newOptionId: optionIds() }
    )

    expect(analysis.options).toHaveLength(1)
    expect(analysis.options[0]?.dto.formatIds).toEqual(['https-audio'])
    expect(analysis.options[0]?.choices.get('auto')?.formatIds).toEqual([
      'https-audio'
    ])
  })

  it('keeps the selected option pinned to the exact format ID it advertises', () => {
    const analysis = buildMediaAnalysis(
      {
        title: 'Pinned formats',
        duration: 60,
        formats: [
          format({
            format_id: 'hls-only',
            vcodec: 'avc1.640032',
            acodec: 'none',
            width: 1280,
            height: 720,
            fps: 30,
            protocol: 'm3u8_native'
          }),
          format({
            format_id: 'audio',
            ext: 'm4a',
            vcodec: 'none',
            acodec: 'mp4a.40.2',
            abr: 128
          })
        ]
      },
      { ffmpegAvailable: true, newOptionId: optionIds() }
    )

    const video = analysis.options.find((option) => option.dto.kind === 'video')
    expect(video?.dto.formatIds).toEqual(['hls-only', 'audio'])
    expect(video?.choices.get('auto')?.formatIds).toEqual(['hls-only', 'audio'])
    expect(video?.choices.get('mp4')?.formatIds).toEqual(['hls-only', 'audio'])
  })
})

/**
 * Real extractor output from sites that omit `vcodec`/`acodec` (and sometimes
 * width/height) even though the formats download and play fine.
 */
describe('media formats with unknown codecs', () => {
  it('offers every Twitch clip variant, labelled by the short side', () => {
    const analysis = analyze('twitch-clip.json')

    expect(analysis.options.map((option) => option.dto.label)).toEqual([
      '1440p MP4',
      '1080p MP4',
      '1080p MP4',
      '720p MP4',
      '720p MP4',
      '480p MP4',
      '480p MP4',
      '360p MP4',
      '360p MP4'
    ])
    expect(analysis.options.map((option) => option.dto.formatIds)).toEqual([
      ['portrait-1440'],
      ['portrait-1080'],
      ['landscape-1080'],
      ['portrait-720'],
      ['landscape-720'],
      ['portrait-480'],
      ['landscape-480'],
      ['portrait-360'],
      ['landscape-360']
    ])
    for (const option of analysis.options) {
      expect(option.dto.kind).toBe('video')
      expect(option.dto.videoCodec).toBeNull()
      expect(option.dto.audioCodec).toBeNull()
      // An unknown acodec on a video format is assumed muxed.
      expect(option.dto.hasAudio).toBe(true)
    }
    expect(analysis.bestVideoOptionId).toBe(analysis.options[0]?.dto.optionId)
  })

  it('offers a Streamable mp4 and skips codec-specific remuxes', () => {
    const analysis = analyze('streamable.json')

    expect(analysis.options).toHaveLength(1)
    const option = analysis.options[0]!
    expect(option.dto.label).toBe('480p MP4')
    expect(option.dto.formatIds).toEqual(['mp4'])
    expect(option.dto.outputFormats).toEqual(['auto', 'mkv'])
    expect(option.choices.has('mp4')).toBe(false)
    expect(option.choices.has('webm')).toBe(false)
    expect(option.choices.get('auto')).toMatchObject({
      formatIds: ['mp4'],
      mergeOutputFormat: null,
      remuxOutputFormat: null,
      outputExt: 'mp4'
    })

    // Without FFmpeg the unknown codecs still leave the natural container.
    const withoutFfmpeg = analyze('streamable.json', false)
    expect(withoutFfmpeg.options[0]?.dto.outputFormats).toEqual(['auto'])
  })

  it('offers a Kick HLS clip with no codecs or dimensions', () => {
    const analysis = analyze('kick-clip.json')

    expect(analysis.options).toHaveLength(1)
    const option = analysis.options[0]!
    expect(option.dto.label).toBe('Source quality (MP4)')
    expect(option.dto.formatIds).toEqual(['0'])
    expect(option.dto.outputFormats).toEqual(['auto', 'mkv'])
    expect(option.dto.width).toBeNull()
    expect(option.dto.height).toBeNull()
  })

  it('orders Facebook sd/hd by resolution', () => {
    const analysis = analyze('facebook.json')

    expect(analysis.options.map((option) => option.dto.label)).toEqual([
      '720p MP4',
      '360p MP4'
    ])
    expect(analysis.options.map((option) => option.dto.formatIds)).toEqual([
      ['hd'],
      ['sd']
    ])
  })

  it('offers the archive.org 300p format', () => {
    const analysis = analyze('archive-org.json')

    expect(analysis.options).toHaveLength(1)
    expect(analysis.options[0]?.dto.label).toBe('300p MP4')
    expect(analysis.options[0]?.dto.formatIds).toEqual(['0'])
  })

  it('offers generic HTML5 embeds and keeps distinct untitled formats', () => {
    const analysis = analyze('html5-media-embed.json')

    expect(analysis.options.map((option) => option.dto.label)).toEqual([
      '320p MP4',
      'Source quality (MP4)',
      'Source quality (WEBM)'
    ])
    expect(analysis.options.map((option) => option.dto.formatIds)).toEqual([
      ['2'],
      ['0'],
      ['1']
    ])
  })

  it('labels portrait TikTok video with the short side', () => {
    const analysis = analyze('tiktok-portrait.json')

    expect(analysis.options).toHaveLength(1)
    const option = analysis.options[0]!
    expect(option.dto.label).toBe('720p MP4 · h264 + aac')
    expect(option.dto.width).toBe(720)
    expect(option.dto.height).toBe(1280)
    expect(option.dto.outputFormats).toEqual(['auto', 'mp4', 'mkv'])
    expect(option.dto.formatIds).toEqual(['h264_720p'])
  })

  it('excludes storyboards and silent formats, keeps audio-only formats', () => {
    const analysis = analyze('edge-cases.json')

    expect(analysis.options.map((option) => option.dto.label)).toEqual([
      '720p60 MP4',
      '360p WEBM',
      'Source quality (MP4)',
      'Audio only · M4A · mp4a.40.2 · 128 kbps',
      'Audio only · M4A · mp4a.40.2 · 64 kbps',
      'Audio only · M4A'
    ])

    const formatIds = analysis.options.flatMap(
      (option) => option.dto.formatIds ?? []
    )
    expect(formatIds).not.toContain('sb0')
    expect(formatIds).not.toContain('silent')

    const unknownAudio = analysis.options.find(
      (option) => option.dto.formatIds?.[0] === '251'
    )
    expect(unknownAudio?.dto.kind).toBe('audio')
    expect(unknownAudio?.dto.outputFormats).toEqual(['auto'])
    expect([...unknownAudio!.choices.keys()]).toEqual(['auto'])

    const m4a = analysis.options.find(
      (option) => option.dto.formatIds?.[0] === '140'
    )
    expect(m4a?.dto.outputFormats).toEqual(['auto', 'mp4'])
    expect(m4a?.choices.get('mp4')).toMatchObject({
      formatIds: ['140'],
      remuxOutputFormat: null,
      outputExt: 'm4a'
    })
  })

  it('keeps unknown-acodec video selection pinned to the exact format id', () => {
    const analysis = analyze('twitch-clip.json')
    const option = analysis.options.find(
      (candidate) => candidate.dto.formatIds?.[0] === 'portrait-720'
    )

    expect(option?.choices.get('auto')?.formatIds).toEqual(['portrait-720'])
    expect(option?.choices.get('mkv')?.formatIds).toEqual(['portrait-720'])
    expect(option?.choices.get('mkv')?.remuxOutputFormat).toBe('mkv')
  })
})
