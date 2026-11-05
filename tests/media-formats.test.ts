import { describe, expect, it } from 'vitest'
import { buildMediaAnalysis } from '../src/main/media/formats'

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
