import type {
  MediaFormatOption
} from '@shared/media'
import {
  MAX_MEDIA_LABEL_LENGTH,
  MAX_MEDIA_OPTIONS,
  MAX_MEDIA_TITLE_LENGTH
} from '@shared/media'

const CONTAINER = /^[a-z0-9][a-z0-9._+-]{0,31}$/
const SAFE_FORMAT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const HTTP_STREAM_PROTOCOLS = new Set([
  'http',
  'https',
  'm3u8',
  'm3u8_native',
  'http_dash_segments',
  'https_dash_segments'
])

/** Internal side of an option. Raw format IDs never leave this object. */
export interface InternalMediaOption {
  dto: MediaFormatOption
  /** Format IDs used to build the fixed `--format` selector. */
  formatIds: string[]
  /** Non-null only when yt-dlp/FFmpeg must merge separate streams. */
  mergeOutputFormat: string | null
  /** Expected final container/extension. */
  outputExt: string
}

export interface BuiltMediaAnalysis {
  title: string
  durationSeconds: number | null
  options: InternalMediaOption[]
  bestVideoOptionId: string | null
  bestAudioOptionId: string | null
}

export type MediaInfoRejection = 'playlist' | 'live' | 'unsupported'

export class MediaInfoError extends Error {
  constructor(readonly reason: MediaInfoRejection) {
    super(
      reason === 'playlist'
        ? 'Playlists and collections are not supported.'
        : reason === 'live'
          ? 'Live streams are not supported.'
          : 'No downloadable video or audio formats were found.'
    )
    this.name = 'MediaInfoError'
  }
}

export interface BuildMediaAnalysisOptions {
  /** Merged options are only produced when FFmpeg was verified. */
  ffmpegAvailable: boolean
  newOptionId: () => string
}

interface FormatDescriptor {
  formatId: string
  ext: string
  videoCodec: string | null
  audioCodec: string | null
  width: number | null
  height: number | null
  fps: number | null
  filesize: number | null
  tbr: number
  abr: number
  kind: 'muxed' | 'video' | 'audio'
}

interface VideoDraft {
  dto: Omit<MediaFormatOption, 'optionId'>
  formatIds: string[]
  mergeOutputFormat: string | null
  outputExt: string
  sortHeight: number
  sortWidth: number
  sortFps: number
  sortBitrate: number
  sortFilesize: number
  dedupeKey: string
}

interface AudioDraft {
  dto: Omit<MediaFormatOption, 'optionId'>
  formatIds: string[]
  outputExt: string
  sortBitrate: number
  sortFilesize: number
  dedupeKey: string
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  return value as Record<string, unknown>
}

function cleanText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const cleaned = value
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned.length === 0 ? null : cleaned
}

function cleanCodec(value: unknown): string | null {
  const text = cleanText(value)
  if (text === null) return null
  if (text.toLowerCase() === 'none') return null
  return text.slice(0, 64)
}

function cleanContainer(value: unknown): string | null {
  const text = cleanText(value)
  if (text === null) return null
  const lower = text.toLowerCase()
  return CONTAINER.test(lower) ? lower : null
}

function cleanFormatId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return SAFE_FORMAT_ID.test(value) ? value : null
}

function safeInteger(
  value: unknown,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER
): number | null {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    return null
  }
  return value
}

function finitePositive(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number | null {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value <= 0 ||
    value > maximum
  ) {
    return null
  }
  return value
}

function finiteNonNegative(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return 0
  }
  return value
}

function formatTitle(value: unknown): string {
  const text = cleanText(value) ?? 'Untitled media'
  return text.slice(0, MAX_MEDIA_TITLE_LENGTH)
}

function formatDuration(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return null
  }
  return Math.min(value, Number.MAX_SAFE_INTEGER)
}

function truncateLabel(value: string): string {
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  if (clean.length === 0) return 'Media'
  return clean.slice(0, MAX_MEDIA_LABEL_LENGTH)
}

function describeFormat(raw: unknown): FormatDescriptor | null {
  const record = asRecord(raw)
  if (!record) return null

  if (record.has_drm === true || record.drm === true) return null

  const formatId = cleanFormatId(record.format_id)
  if (formatId === null) return null

  const formatNote =
    typeof record.format_note === 'string'
      ? record.format_note.toLowerCase()
      : ''
  if (formatId.toLowerCase().startsWith('sb') || formatNote.includes('storyboard')) {
    return null
  }

  const protocol =
    typeof record.protocol === 'string' ? record.protocol.toLowerCase() : ''
  if (!HTTP_STREAM_PROTOCOLS.has(protocol)) return null

  const ext = cleanContainer(record.ext)
  if (ext === null) return null

  const videoCodec = cleanCodec(record.vcodec)
  const audioCodec = cleanCodec(record.acodec)
  const width = safeInteger(record.width, 1, 65_535)
  const height = safeInteger(record.height, 1, 65_535)
  const fps = finitePositive(record.fps, 1_000)
  const filesize = safeInteger(record.filesize, 1)
  const tbr = finiteNonNegative(record.tbr)
  const abr = finiteNonNegative(record.abr)

  const hasVideo = videoCodec !== null && (width !== null || height !== null)
  const hasAudio = audioCodec !== null

  if (!hasVideo && !hasAudio) return null

  return {
    formatId,
    ext,
    videoCodec,
    audioCodec,
    width,
    height,
    fps,
    filesize,
    tbr,
    abr,
    kind: hasVideo ? (hasAudio ? 'muxed' : 'video') : 'audio'
  }
}

function resolutionLabel(height: number | null, width: number | null, fps: number | null): string {
  const base = height !== null ? `${height}p` : width !== null ? `${width}px` : 'Video'
  if (fps === null || fps < 50) return base
  return `${base}${Math.round(fps)}`
}

function mergeContainer(videoExt: string, audioExt: string): string {
  const mp4Family = new Set(['mp4', 'm4a', 'm4v', 'mov'])
  const webmFamily = new Set(['webm', 'weba', 'opus'])
  if (mp4Family.has(videoExt) && mp4Family.has(audioExt)) return 'mp4'
  if (webmFamily.has(videoExt) && webmFamily.has(audioExt)) return 'webm'
  return 'mkv'
}

function compareAudio(a: AudioDraft, b: AudioDraft): number {
  return (
    b.sortBitrate - a.sortBitrate ||
    b.sortFilesize - a.sortFilesize ||
    a.dto.container.localeCompare(b.dto.container)
  )
}

function compareVideo(a: VideoDraft, b: VideoDraft): number {
  return (
    b.sortHeight - a.sortHeight ||
    b.sortWidth - a.sortWidth ||
    b.sortFps - a.sortFps ||
    b.sortBitrate - a.sortBitrate ||
    b.sortFilesize - a.sortFilesize ||
    (a.dto.requiresMerge === b.dto.requiresMerge
      ? 0
      : a.dto.requiresMerge
        ? 1
        : -1) ||
    a.dto.container.localeCompare(b.dto.container)
  )
}

function buildVideoDrafts(
  descriptors: FormatDescriptor[],
  bestAudio: FormatDescriptor | null,
  ffmpegAvailable: boolean
): VideoDraft[] {
  const drafts: VideoDraft[] = []

  for (const descriptor of descriptors) {
    if (descriptor.kind === 'audio') continue

    const videoCodec = descriptor.videoCodec ?? 'video'
    const resolution = resolutionLabel(
      descriptor.height,
      descriptor.width,
      descriptor.fps
    )

    if (descriptor.kind === 'muxed' && descriptor.audioCodec !== null) {
      const container = descriptor.ext
      drafts.push({
        dto: {
          kind: 'video',
          label: truncateLabel(
            `${resolution} ${container.toUpperCase()} · ${videoCodec} + ${descriptor.audioCodec}`
          ),
          container,
          width: descriptor.width,
          height: descriptor.height,
          fps: descriptor.fps,
          videoCodec,
          audioCodec: descriptor.audioCodec,
          hasAudio: true,
          requiresMerge: false,
          filesizeBytes: descriptor.filesize
        },
        formatIds: [descriptor.formatId],
        mergeOutputFormat: null,
        outputExt: container,
        sortHeight: descriptor.height ?? 0,
        sortWidth: descriptor.width ?? 0,
        sortFps: descriptor.fps ?? 0,
        sortBitrate: descriptor.tbr,
        sortFilesize: descriptor.filesize ?? 0,
        dedupeKey: [
          descriptor.height ?? 0,
          descriptor.width ?? 0,
          Math.round(descriptor.fps ?? 0),
          container,
          videoCodec,
          descriptor.audioCodec
        ].join('|')
      })
      continue
    }

    // A video-only stream is offered only as a real video+audio deliverable.
    if (!ffmpegAvailable || bestAudio === null || bestAudio.audioCodec === null) {
      continue
    }

    const container = mergeContainer(descriptor.ext, bestAudio.ext)
    drafts.push({
      dto: {
        kind: 'video',
        label: truncateLabel(
          `${resolution} ${container.toUpperCase()} · ${videoCodec} + ${bestAudio.audioCodec} (merged)`
        ),
        container,
        width: descriptor.width,
        height: descriptor.height,
        fps: descriptor.fps,
        videoCodec,
        audioCodec: bestAudio.audioCodec,
        hasAudio: true,
        requiresMerge: true,
        // The merged container size is not the sum of the two stream sizes.
        filesizeBytes: null
      },
      formatIds: [descriptor.formatId, bestAudio.formatId],
      mergeOutputFormat: container,
      outputExt: container,
      sortHeight: descriptor.height ?? 0,
      sortWidth: descriptor.width ?? 0,
      sortFps: descriptor.fps ?? 0,
      sortBitrate: descriptor.tbr,
      sortFilesize: descriptor.filesize ?? 0,
      dedupeKey: [
        descriptor.height ?? 0,
        descriptor.width ?? 0,
        Math.round(descriptor.fps ?? 0),
        container,
        videoCodec,
        bestAudio.audioCodec
      ].join('|')
    })
  }

  return drafts
}

function buildAudioDrafts(descriptors: FormatDescriptor[]): AudioDraft[] {
  const drafts: AudioDraft[] = []

  for (const descriptor of descriptors) {
    if (descriptor.kind !== 'audio' || descriptor.audioCodec === null) continue

    const container = descriptor.ext
    drafts.push({
      dto: {
        kind: 'audio',
        label: truncateLabel(
          `Audio only · ${container.toUpperCase()} · ${descriptor.audioCodec}` +
            (descriptor.abr >= 1
              ? ` · ${Math.round(descriptor.abr)} kbps`
              : '')
        ),
        container,
        width: null,
        height: null,
        fps: null,
        videoCodec: null,
        audioCodec: descriptor.audioCodec,
        hasAudio: true,
        requiresMerge: false,
        filesizeBytes: descriptor.filesize
      },
      formatIds: [descriptor.formatId],
      outputExt: container,
      sortBitrate: descriptor.abr || descriptor.tbr,
      sortFilesize: descriptor.filesize ?? 0,
      dedupeKey: [
        descriptor.audioCodec,
        container,
        Math.round(descriptor.abr || descriptor.tbr)
      ].join('|')
    })
  }

  return drafts
}

function dedupeAndSort<T extends { dedupeKey: string }>(
  drafts: T[],
  compare: (a: T, b: T) => number
): T[] {
  const sorted = [...drafts].sort(compare)
  const seen = new Set<string>()
  const result: T[] = []
  for (const draft of sorted) {
    if (seen.has(draft.dedupeKey)) continue
    seen.add(draft.dedupeKey)
    result.push(draft)
  }
  return result
}

/**
 * Convert a yt-dlp JSON metadata object into public, opaque options.
 *
 * Only verified HTTP(S) streams with a known codec and container are exposed.
 * Video-only streams are paired with a real audio-only stream and exposed only
 * when FFmpeg is available. A pure video-only stream is never an option and a
 * silent stream is never the best video deliverable.
 */
export function buildMediaAnalysis(
  rawInfo: unknown,
  options: BuildMediaAnalysisOptions
): BuiltMediaAnalysis {
  const info = asRecord(rawInfo)
  if (!info) throw new MediaInfoError('unsupported')

  if (Array.isArray(info.entries) || info._type === 'playlist') {
    throw new MediaInfoError('playlist')
  }
  if (info.is_live === true) {
    throw new MediaInfoError('live')
  }

  const rawFormats = Array.isArray(info.formats) ? info.formats : []
  const descriptors: FormatDescriptor[] = []
  for (const rawFormat of rawFormats) {
    const descriptor = describeFormat(rawFormat)
    if (descriptor) descriptors.push(descriptor)
  }

  const audioDescriptors = descriptors.filter(
    (descriptor) => descriptor.kind === 'audio'
  )
  // Highest audio bitrate first; the first entry is the best audio stream.
  audioDescriptors.sort(
    (a, b) =>
      b.abr - a.abr ||
      b.tbr - a.tbr ||
      (b.filesize ?? 0) - (a.filesize ?? 0)
  )
  const bestAudio = audioDescriptors[0] ?? null

  const videoDrafts = dedupeAndSort(
    buildVideoDrafts(descriptors, bestAudio, options.ffmpegAvailable),
    compareVideo
  ).slice(0, 150)

  const audioDrafts = dedupeAndSort(
    buildAudioDrafts(audioDescriptors),
    compareAudio
  ).slice(0, 49)

  if (videoDrafts.length === 0 && audioDrafts.length === 0) {
    throw new MediaInfoError('unsupported')
  }

  const usedIds = new Set<string>()
  const nextOptionId = (): string => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const id = options.newOptionId()
      if (!usedIds.has(id)) {
        usedIds.add(id)
        return id
      }
    }
    throw new MediaInfoError('unsupported')
  }

  const internalOptions: InternalMediaOption[] = []
  const bestVideoOptionId = videoDrafts[0]
    ? nextOptionId()
    : null
  const bestAudioOptionId = audioDrafts[0] ? nextOptionId() : null

  videoDrafts.forEach((draft, index) => {
    const optionId =
      index === 0 && bestVideoOptionId !== null
        ? bestVideoOptionId
        : nextOptionId()
    internalOptions.push({
      dto: { ...draft.dto, optionId },
      formatIds: draft.formatIds,
      mergeOutputFormat: draft.mergeOutputFormat,
      outputExt: draft.outputExt
    })
  })

  audioDrafts.forEach((draft, index) => {
    const optionId =
      index === 0 && bestAudioOptionId !== null
        ? bestAudioOptionId
        : nextOptionId()
    internalOptions.push({
      dto: { ...draft.dto, optionId },
      formatIds: draft.formatIds,
      mergeOutputFormat: null,
      outputExt: draft.outputExt
    })
  })

  if (internalOptions.length > MAX_MEDIA_OPTIONS) {
    internalOptions.length = MAX_MEDIA_OPTIONS
  }

  return {
    title: formatTitle(info.title),
    durationSeconds: formatDuration(info.duration),
    options: internalOptions,
    bestVideoOptionId,
    bestAudioOptionId
  }
}
