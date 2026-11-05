import type {
  MediaFormatOption,
  MediaOutputFormat,
  MediaOutputSize
} from '@shared/media'
import {
  MAX_MEDIA_LABEL_LENGTH,
  MAX_MEDIA_OPTIONS,
  MAX_MEDIA_TITLE_LENGTH
} from '@shared/media'
import {
  isMp4AudioCodec,
  isMp4Container,
  isMp4VideoCodec,
  isWebmAudioCodec,
  isWebmContainer,
  isWebmVideoCodec
} from '@shared/mediaOutput'

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

/**
 * HLS playlist protocols are downloaded through yt-dlp's fragment path or,
 * historically, FFmpeg. Direct HTTP/DASH streams are a single connection per
 * format and report progress reliably, so equally good formats prefer them.
 */
function protocolPreference(protocol: string): number {
  return protocol === 'm3u8' || protocol === 'm3u8_native' ? 1 : 0
}

/** One server-resolved output choice for an option. */
export interface InternalOutputChoice {
  outputFormat: MediaOutputFormat
  /** Actual yt-dlp format IDs, also exposed in the advanced metadata details. */
  formatIds: string[]
  /** Non-null only when yt-dlp/FFmpeg must merge separate streams. */
  mergeOutputFormat: string | null
  /** Non-null only for a single-stream remux target. */
  remuxOutputFormat: string | null
  /** Expected final container/extension. */
  outputExt: string
}

/** Internal selection state; only the public advanced-detail IDs are exposed. */
export interface InternalMediaOption {
  dto: MediaFormatOption
  choices: Map<MediaOutputFormat, InternalOutputChoice>
}

export interface BuiltMediaAnalysis {
  title: string
  thumbnailUrl: string | null
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
  /** yt-dlp transport protocol, for example `https` or `m3u8_native`. */
  protocol: string
  videoCodec: string | null
  audioCodec: string | null
  width: number | null
  height: number | null
  fps: number | null
  filesize: number | null
  filesizeApprox: number | null
  tbr: number
  vbr: number
  abr: number
  hdr: boolean
  kind: 'muxed' | 'video' | 'audio'
}

interface DisplaySize {
  bytes: number | null
  isEstimate: boolean
}

interface VideoDraft {
  dto: Omit<MediaFormatOption, 'optionId'>
  choices: Map<MediaOutputFormat, InternalOutputChoice>
  sortHeight: number
  sortWidth: number
  sortFps: number
  sortBitrate: number
  sortFilesize: number
  /** Lower is preferred: 0 for https/DASH segments, 1 for HLS playlists. */
  sortProtocol: number
  dedupeKey: string
}

interface AudioDraft {
  dto: Omit<MediaFormatOption, 'optionId'>
  choices: Map<MediaOutputFormat, InternalOutputChoice>
  sortBitrate: number
  sortFilesize: number
  sortProtocol: number
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

/**
 * Best available size, in descending confidence:
 *   1. yt-dlp's exact `filesize`;
 *   2. yt-dlp's `filesize_approx`;
 *   3. a safe bitrate x duration estimate from the same metadata.
 *
 * The bitrate fallback is only used when both reported sizes are absent and
 * both values are positive finite numbers. It is still labelled as an
 * estimate and never exposed as `filesizeBytes`.
 */
function displaySize(
  descriptor: FormatDescriptor,
  durationSeconds: number | null
): DisplaySize {
  if (descriptor.filesize !== null) {
    return { bytes: descriptor.filesize, isEstimate: false }
  }
  if (descriptor.filesizeApprox !== null) {
    return { bytes: descriptor.filesizeApprox, isEstimate: true }
  }
  if (durationSeconds === null || durationSeconds <= 0) {
    return { bytes: null, isEstimate: false }
  }

  const bitrate =
    descriptor.kind === 'audio'
      ? descriptor.abr || descriptor.tbr
      : descriptor.tbr || descriptor.vbr
  if (!Number.isFinite(bitrate) || bitrate <= 0) {
    return { bytes: null, isEstimate: false }
  }

  const bytes = Math.round((bitrate * 1000 * durationSeconds) / 8)
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    return { bytes: null, isEstimate: false }
  }
  return { bytes, isEstimate: true }
}

/**
 * A merged output needs both streams. If either stream has no usable size the
 * merged total is unknown; never sum only the known half. Any sum is still an
 * estimate because the container/merge overhead is not part of the stream
 * metadata.
 */
function mergedDisplaySize(
  video: FormatDescriptor,
  audio: FormatDescriptor,
  durationSeconds: number | null
): DisplaySize {
  const videoSize = displaySize(video, durationSeconds)
  const audioSize = displaySize(audio, durationSeconds)
  if (videoSize.bytes === null || audioSize.bytes === null) {
    return { bytes: null, isEstimate: false }
  }
  const bytes = videoSize.bytes + audioSize.bytes
  if (!Number.isSafeInteger(bytes)) {
    return { bytes: null, isEstimate: false }
  }
  return { bytes, isEstimate: true }
}

function videoOutputSizes(
  choices: Map<MediaOutputFormat, InternalOutputChoice>,
  video: FormatDescriptor,
  audioDescriptors: FormatDescriptor[],
  durationSeconds: number | null
): Partial<Record<MediaOutputFormat, MediaOutputSize>> {
  const sizes: Partial<Record<MediaOutputFormat, MediaOutputSize>> = {}
  for (const [format, choice] of choices) {
    let size: DisplaySize
    if (choice.formatIds.length > 1) {
      const audio = audioDescriptors.find(
        (candidate) => candidate.formatId === choice.formatIds[1]
      )
      size = audio
        ? mergedDisplaySize(video, audio, durationSeconds)
        : { bytes: null, isEstimate: false }
    } else {
      size = displaySize(video, durationSeconds)
    }
    sizes[format] = { bytes: size.bytes, isEstimate: size.isEstimate }
  }
  return sizes
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
  const filesizeApprox = safeInteger(record.filesize_approx, 1)
  const tbr = finiteNonNegative(record.tbr)
  const vbr = finiteNonNegative(record.vbr)
  const abr = finiteNonNegative(record.abr)
  const dynamicRange =
    typeof record.dynamic_range === 'string'
      ? record.dynamic_range.toLowerCase()
      : ''
  const colorTransfer =
    typeof record.color_transfer === 'string'
      ? record.color_transfer.toLowerCase()
      : ''
  const hdr =
    (dynamicRange !== '' && dynamicRange !== 'sdr') ||
    colorTransfer === 'smpte2084' ||
    colorTransfer === 'arib-std-b67'

  const hasVideo = videoCodec !== null && (width !== null || height !== null)
  const hasAudio = audioCodec !== null

  if (!hasVideo && !hasAudio) return null

  return {
    formatId,
    ext,
    protocol,
    videoCodec,
    audioCodec,
    width,
    height,
    fps,
    filesize,
    filesizeApprox,
    tbr,
    vbr,
    abr,
    hdr,
    kind: hasVideo ? (hasAudio ? 'muxed' : 'video') : 'audio'
  }
}

function resolutionLabel(height: number | null, width: number | null, fps: number | null): string {
  const base = height !== null ? `${height}p` : width !== null ? `${width}px` : 'Video'
  if (fps === null || fps < 50) return base
  return `${base}${Math.round(fps)}`
}

function mergeContainer(videoExt: string, audioExt: string): string {
  if (isMp4Container(videoExt) && isMp4Container(audioExt)) return 'mp4'
  if (isWebmContainer(videoExt) && isWebmContainer(audioExt)) return 'webm'
  return 'mkv'
}

function outputFormatsOf(
  choices: Map<MediaOutputFormat, InternalOutputChoice>
): MediaOutputFormat[] {
  return (['auto', 'mp4', 'mkv', 'webm'] as const).filter((format) =>
    choices.has(format)
  )
}

function muxedOutputChoices(
  descriptor: FormatDescriptor,
  ffmpegAvailable: boolean
): Map<MediaOutputFormat, InternalOutputChoice> {
  const choices = new Map<MediaOutputFormat, InternalOutputChoice>()
  const natural = descriptor.ext
  choices.set('auto', {
    outputFormat: 'auto',
    formatIds: [descriptor.formatId],
    mergeOutputFormat: null,
    remuxOutputFormat: null,
    outputExt: natural
  })

  if (
    isMp4VideoCodec(descriptor.videoCodec) &&
    isMp4AudioCodec(descriptor.audioCodec)
  ) {
    if (natural === 'mp4' || ffmpegAvailable) choices.set('mp4', {
      outputFormat: 'mp4',
      formatIds: [descriptor.formatId],
      mergeOutputFormat: null,
      remuxOutputFormat: natural === 'mp4' ? null : 'mp4',
      outputExt: 'mp4'
    })
  }
  if (
    isWebmVideoCodec(descriptor.videoCodec) &&
    isWebmAudioCodec(descriptor.audioCodec)
  ) {
    if (natural === 'webm' || ffmpegAvailable) choices.set('webm', {
      outputFormat: 'webm',
      formatIds: [descriptor.formatId],
      mergeOutputFormat: null,
      remuxOutputFormat: natural === 'webm' ? null : 'webm',
      outputExt: 'webm'
    })
  }

  if (natural === 'mkv' || ffmpegAvailable) choices.set('mkv', {
    outputFormat: 'mkv',
    formatIds: [descriptor.formatId],
    mergeOutputFormat: null,
    remuxOutputFormat: natural === 'mkv' ? null : 'mkv',
    outputExt: 'mkv'
  })
  return choices
}

function bestAudioForOutput(
  audioDescriptors: FormatDescriptor[],
  format: MediaOutputFormat
): FormatDescriptor | null {
  if (format === 'auto' || format === 'mkv') {
    return audioDescriptors[0] ?? null
  }
  if (format === 'mp4') {
    return (
      audioDescriptors.find((audio) => isMp4AudioCodec(audio.audioCodec)) ??
      null
    )
  }
  return (
    audioDescriptors.find((audio) => isWebmAudioCodec(audio.audioCodec)) ?? null
  )
}

/** Real video+audio pairs for every output container the streams support. */
function mergedOutputChoices(
  descriptor: FormatDescriptor,
  audioDescriptors: FormatDescriptor[]
): Map<MediaOutputFormat, InternalOutputChoice> {
  const choices = new Map<MediaOutputFormat, InternalOutputChoice>()
  const autoAudio = bestAudioForOutput(audioDescriptors, 'auto')
  if (autoAudio === null) return choices

  const add = (
    format: MediaOutputFormat,
    audio: FormatDescriptor | null,
    container: string
  ): void => {
    if (audio === null) return
    choices.set(format, {
      outputFormat: format,
      formatIds: [descriptor.formatId, audio.formatId],
      mergeOutputFormat: container,
      remuxOutputFormat: null,
      outputExt: container
    })
  }

  add('auto', autoAudio, mergeContainer(descriptor.ext, autoAudio.ext))
  add('mkv', bestAudioForOutput(audioDescriptors, 'mkv'), 'mkv')
  if (isMp4VideoCodec(descriptor.videoCodec)) {
    add('mp4', bestAudioForOutput(audioDescriptors, 'mp4'), 'mp4')
  }
  if (isWebmVideoCodec(descriptor.videoCodec)) {
    add('webm', bestAudioForOutput(audioDescriptors, 'webm'), 'webm')
  }
  return choices
}

function audioOutputChoices(
  descriptor: FormatDescriptor
): Map<MediaOutputFormat, InternalOutputChoice> {
  const choices = new Map<MediaOutputFormat, InternalOutputChoice>()
  const natural = descriptor.ext
  choices.set('auto', {
    outputFormat: 'auto',
    formatIds: [descriptor.formatId],
    mergeOutputFormat: null,
    remuxOutputFormat: null,
    outputExt: natural
  })

  const addNatural = (format: MediaOutputFormat, ext: string): void => {
    if (natural !== ext) return
    choices.set(format, {
      outputFormat: format,
      formatIds: [descriptor.formatId],
      mergeOutputFormat: null,
      remuxOutputFormat: null,
      outputExt: ext
    })
  }

  if (isMp4AudioCodec(descriptor.audioCodec)) {
    addNatural('mp4', 'm4a')
  }
  addNatural('mkv', 'mka')
  if (isWebmAudioCodec(descriptor.audioCodec)) {
    addNatural('webm', 'webm')
  }
  return choices
}

function compareAudio(a: AudioDraft, b: AudioDraft): number {
  return (
    b.sortBitrate - a.sortBitrate ||
    a.sortProtocol - b.sortProtocol ||
    b.sortFilesize - a.sortFilesize ||
    a.dto.container.localeCompare(b.dto.container)
  )
}

function compareVideo(a: VideoDraft, b: VideoDraft): number {
  return (
    b.sortHeight - a.sortHeight ||
    b.sortWidth - a.sortWidth ||
    b.sortFps - a.sortFps ||
    // Same resolution/fps: prefer the direct HTTP/DASH transport before
    // bitrate and size, so deduplication keeps the progress-reporting format.
    a.sortProtocol - b.sortProtocol ||
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
  audioDescriptors: FormatDescriptor[],
  durationSeconds: number | null,
  ffmpegAvailable: boolean
): VideoDraft[] {
  const drafts: VideoDraft[] = []
  const bestAudio = audioDescriptors[0] ?? null

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
      const size = displaySize(descriptor, durationSeconds)
      const choices = muxedOutputChoices(descriptor, ffmpegAvailable)
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
          hdr: descriptor.hdr,
          filesizeBytes: descriptor.filesize,
          estimatedBytes: size.bytes,
          sizeIsEstimate: size.isEstimate,
          outputFormats: outputFormatsOf(choices),
          outputSizes: videoOutputSizes(choices, descriptor, [], durationSeconds),
          formatIds: choices.get('auto')?.formatIds
        },
        choices,
        sortHeight: descriptor.height ?? 0,
        sortWidth: descriptor.width ?? 0,
        sortFps: descriptor.fps ?? 0,
        sortBitrate: descriptor.tbr,
        sortFilesize: size.bytes ?? 0,
        sortProtocol: protocolPreference(descriptor.protocol),
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

    const choices = mergedOutputChoices(descriptor, audioDescriptors)
    const autoChoice = choices.get('auto')
    if (autoChoice === undefined) continue

    const autoAudio =
      audioDescriptors.find(
        (audio) => autoChoice.formatIds[1] === audio.formatId
      ) ?? bestAudio
    const container = autoChoice.outputExt
    const size = mergedDisplaySize(descriptor, autoAudio, durationSeconds)
    drafts.push({
      dto: {
        kind: 'video',
        label: truncateLabel(
          `${resolution} ${container.toUpperCase()} · ${videoCodec} + ${autoAudio.audioCodec} (merged)`
        ),
        container,
        width: descriptor.width,
        height: descriptor.height,
        fps: descriptor.fps,
        videoCodec,
        audioCodec: autoAudio.audioCodec,
        hasAudio: true,
        requiresMerge: true,
        hdr: descriptor.hdr,
        // No exact merged file size is verified; estimatedBytes is only the
        // sum of the two stream sizes/estimates.
        filesizeBytes: null,
        estimatedBytes: size.bytes,
        // Any merged total is an estimate even when both streams are exact.
        sizeIsEstimate: size.bytes !== null,
        outputFormats: outputFormatsOf(choices),
        outputSizes: videoOutputSizes(
          choices,
          descriptor,
          audioDescriptors,
          durationSeconds
        ),
        formatIds: autoChoice.formatIds
      },
      choices,
      sortHeight: descriptor.height ?? 0,
      sortWidth: descriptor.width ?? 0,
      sortFps: descriptor.fps ?? 0,
      sortBitrate: descriptor.tbr,
      sortFilesize: size.bytes ?? 0,
      sortProtocol: protocolPreference(descriptor.protocol),
      dedupeKey: [
        descriptor.height ?? 0,
        descriptor.width ?? 0,
        Math.round(descriptor.fps ?? 0),
        container,
        videoCodec,
        autoAudio.audioCodec
      ].join('|')
    })
  }

  return drafts
}

function buildAudioDrafts(
  descriptors: FormatDescriptor[],
  durationSeconds: number | null
): AudioDraft[] {
  const drafts: AudioDraft[] = []

  for (const descriptor of descriptors) {
    if (descriptor.kind !== 'audio' || descriptor.audioCodec === null) continue

    const container = descriptor.ext
    const size = displaySize(descriptor, durationSeconds)
    const choices = audioOutputChoices(descriptor)
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
        hdr: false,
        filesizeBytes: descriptor.filesize,
        estimatedBytes: size.bytes,
        sizeIsEstimate: size.isEstimate,
        outputFormats: outputFormatsOf(choices),
        outputSizes: Object.fromEntries(
          [...choices.keys()].map((format) => [format, size])
        ),
        formatIds: choices.get('auto')?.formatIds
      },
      choices,
      sortBitrate: descriptor.abr || descriptor.tbr,
      sortFilesize: size.bytes ?? 0,
      sortProtocol: protocolPreference(descriptor.protocol),
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

  const durationSeconds = formatDuration(info.duration)
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

  const videoDrafts = dedupeAndSort(
    buildVideoDrafts(
      descriptors,
      audioDescriptors,
      durationSeconds,
      options.ffmpegAvailable
    ),
    compareVideo
  ).slice(0, 150)

  const audioDrafts = dedupeAndSort(
    buildAudioDrafts(audioDescriptors, durationSeconds),
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
      choices: draft.choices
    })
  })

  audioDrafts.forEach((draft, index) => {
    const optionId =
      index === 0 && bestAudioOptionId !== null
        ? bestAudioOptionId
        : nextOptionId()
    internalOptions.push({
      dto: { ...draft.dto, optionId },
      choices: draft.choices
    })
  })

  if (internalOptions.length > MAX_MEDIA_OPTIONS) {
    internalOptions.length = MAX_MEDIA_OPTIONS
  }

  return {
    title: formatTitle(info.title),
    thumbnailUrl:
      typeof info.thumbnail === 'string' ? info.thumbnail : null,
    durationSeconds: formatDuration(info.duration),
    options: internalOptions,
    bestVideoOptionId,
    bestAudioOptionId
  }
}
