import type {
  MediaFormatKind,
  MediaFormatOption,
  MediaOutputFormat
} from './media'
import { MEDIA_OUTPUT_FORMATS } from './media'

/**
 * Output-container compatibility for the media UI and the engine.
 *
 * These helpers never transcode. A format is offered only when the selected
 * streams or single muxed stream can be remuxed/merged into that container.
 * Callers must reject an unsupported request instead of substituting a
 * different container or quality.
 */

export interface MediaOutputSource {
  kind: MediaFormatKind
  container: string
  videoCodec: string | null
  audioCodec: string | null
}

const MP4_CONTAINERS = new Set(['mp4', 'm4a', 'm4v', 'mov'])
const WEBM_CONTAINERS = new Set(['webm', 'weba', 'opus'])
const MP4_VIDEO_CODEC = /^(?:avc|h264|hev|hvc|h265|av01|mp4v|mpeg4|vp0?9)/i
const WEBM_VIDEO_CODEC = /^(?:vp8|vp9|av01)/i
const MP4_AUDIO_CODEC = /^(?:aac|mp4a|mp3|ac-3|ec-3|alac|opus)/i
const WEBM_AUDIO_CODEC = /^(?:opus|vorbis)/i

function codec(value: string | null): string {
  return value === null ? '' : value.trim()
}

export function isMp4VideoCodec(value: string | null): boolean {
  return MP4_VIDEO_CODEC.test(codec(value))
}

export function isWebmVideoCodec(value: string | null): boolean {
  return WEBM_VIDEO_CODEC.test(codec(value))
}

export function isMp4AudioCodec(value: string | null): boolean {
  return value === null ? false : MP4_AUDIO_CODEC.test(codec(value))
}

export function isWebmAudioCodec(value: string | null): boolean {
  return value === null ? false : WEBM_AUDIO_CODEC.test(codec(value))
}

export function isMp4Container(value: string): boolean {
  return MP4_CONTAINERS.has(value.toLowerCase())
}

export function isWebmContainer(value: string): boolean {
  return WEBM_CONTAINERS.has(value.toLowerCase())
}

export function mediaOutputFormatLabel(format: MediaOutputFormat): string {
  switch (format) {
    case 'auto':
      return 'Auto'
    case 'mp4':
      return 'MP4'
    case 'mkv':
      return 'MKV'
    case 'webm':
      return 'WebM'
  }
}

/**
 * Every explicit target is a remux/merge target. `auto` keeps the natural
 * container reported by yt-dlp and therefore never post-processes a single
 * muxed stream.
 */
export function isOutputFormatCompatible(
  source: MediaOutputSource,
  format: MediaOutputFormat
): boolean {
  if (format === 'auto') return true
  if (format === 'mkv') return true

  if (source.kind === 'audio') {
    if (format === 'mp4') return isMp4AudioCodec(source.audioCodec)
    return isWebmAudioCodec(source.audioCodec)
  }

  if (format === 'mp4') {
    return (
      isMp4VideoCodec(source.videoCodec) &&
      isMp4AudioCodec(source.audioCodec)
    )
  }
  return (
    isWebmVideoCodec(source.videoCodec) &&
    isWebmAudioCodec(source.audioCodec)
  )
}

export function compatibleMediaOutputFormats(
  source: MediaOutputSource
): MediaOutputFormat[] {
  return MEDIA_OUTPUT_FORMATS.filter((format) =>
    isOutputFormatCompatible(source, format)
  )
}

/** Final extension for a remux/merge target. */
export function mediaOutputExtension(
  kind: MediaFormatKind,
  naturalContainer: string,
  format: MediaOutputFormat
): string {
  if (format === 'auto') return naturalContainer
  if (kind === 'audio') {
    if (format === 'mp4') return 'm4a'
    if (format === 'mkv') return 'mka'
    return 'webm'
  }
  return format
}

/**
 * Compatibility fallback for older payloads that do not carry
 * `outputFormats`. New analyses always expose the server-authoritative list.
 */
export function mediaOutputFormatsForOption(
  option: Pick<
    MediaFormatOption,
    'kind' | 'container' | 'videoCodec' | 'audioCodec' | 'outputFormats'
  >
): MediaOutputFormat[] {
  if (Array.isArray(option.outputFormats) && option.outputFormats.length > 0) {
    return [...option.outputFormats]
  }
  return compatibleMediaOutputFormats(option)
}
