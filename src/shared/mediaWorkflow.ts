import type {
  MediaAnalysis,
  MediaFormatOption,
  MediaOutputFormat
} from './media'

/**
 * One display/selection model shared by the desktop Media tab and the
 * extension overlay. It only reads the verified analysis DTO: it never invents
 * a quality, format or identifier and never queues anything by itself.
 */

export interface MediaQualityChoice {
  option: MediaFormatOption
  label: string
  best: boolean
}

function bestVideo(
  analysis: MediaAnalysis
): MediaFormatOption | null {
  if (analysis.bestVideoOptionId === null) return null
  return (
    analysis.options.find(
      (option) =>
        option.optionId === analysis.bestVideoOptionId &&
        option.kind === 'video' &&
        option.hasAudio
    ) ?? null
  )
}

function bestAudio(
  analysis: MediaAnalysis
): MediaFormatOption | null {
  if (analysis.bestAudioOptionId === null) return null
  return (
    analysis.options.find(
      (option) =>
        option.optionId === analysis.bestAudioOptionId &&
        option.kind === 'audio' &&
        option.hasAudio
    ) ?? null
  )
}

/**
 * Every available video height, highest first, plus the best audio-only
 * option. There is deliberately no 1080p ceiling: whatever yt-dlp reports is
 * offered, including 1440p/2160p and heights below 360p.
 */
export function mediaQualityChoices(
  analysis: MediaAnalysis
): MediaQualityChoice[] {
  const best = bestVideo(analysis)
  const videos = analysis.options.filter(
    (option) =>
      option.kind === 'video' && option.hasAudio && option.height !== null
  )
  const byHeight = new Map<number, MediaFormatOption>()
  for (const option of videos) {
    const height = option.height
    if (height === null || byHeight.has(height)) continue
    byHeight.set(height, option)
  }
  if (best !== null && best.height !== null && byHeight.has(best.height)) {
    byHeight.set(best.height, best)
  }

  const choices: MediaQualityChoice[] = [...byHeight.keys()]
    .sort((left, right) => right - left)
    .map((height) => {
      const option = byHeight.get(height) as MediaFormatOption
      return {
        option,
        label: `${height}p`,
        best: option.optionId === best?.optionId
      }
    })

  if (best !== null && best.height === null) {
    choices.unshift({ option: best, label: 'Best', best: true })
  }

  const audio = bestAudio(analysis)
  if (audio !== null) {
    choices.push({ option: audio, label: 'Audio only', best: false })
  }
  return choices
}

/** Best video first, then best audio, then the first verified option. */
export function defaultMediaQualityOptionId(
  analysis: MediaAnalysis
): string | null {
  const best = bestVideo(analysis)
  if (best !== null) return best.optionId
  const audio = bestAudio(analysis)
  if (audio !== null) return audio.optionId
  return analysis.options[0]?.optionId ?? null
}

export function outputFormatsForOption(
  option: MediaFormatOption | null,
  available: MediaOutputFormat[] = ['auto', 'mp4', 'mkv', 'webm']
): MediaOutputFormat[] {
  if (option === null) return ['auto']
  const formats =
    option.outputFormats !== undefined && option.outputFormats.length > 0
      ? option.outputFormats
      : ['auto']
  const filtered = available.filter((format) => formats.includes(format))
  return filtered.length > 0 ? filtered : ['auto']
}

/** Keep an explicit choice only when the option can produce it. */
export function normalizeOutputFormat(
  option: MediaFormatOption | null,
  requested: MediaOutputFormat
): MediaOutputFormat {
  if (option === null) return 'auto'
  return outputFormatsForOption(option).includes(requested)
    ? requested
    : 'auto'
}
