// Pure presentation model for the toolbar popup. It only consumes the safe,
// already-verified fields returned by the overlay content script; it never
// creates a quality, a URL or a source label of its own.

const SOURCE_LABELS = {
  SEGMENTED_MEDIA: 'Streaming video detected',
  MANIFEST_STREAM: 'Streaming video detected',
  NOT_PROGRESSIVE: 'Streaming video detected',
  EMBED_PLAYER: 'Embedded video detected'
}

export function formatBytes(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return ''
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let scaled = value
  let unit = 0
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024
    unit += 1
  }
  const decimals = unit === 0 ? 0 : scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2
  return `${scaled.toFixed(decimals)} ${units[unit]}`
}

export function formatOptionDetail(option) {
  if (!option || typeof option !== 'object') return ''
  const parts = []
  if (typeof option.height === 'number') parts.push(`${option.height}p`)
  else if (typeof option.width === 'number') parts.push(`${option.width}px wide`)
  if (typeof option.container === 'string' && option.container.length > 0) {
    parts.push(option.container.toUpperCase())
  }
  if (typeof option.fps === 'number' && option.fps > 0) {
    parts.push(`${Math.round(option.fps)} fps`)
  }
  if (option.hdr === true) parts.push('HDR')
  if (option.requiresMerge === true) parts.push('merged')
  const bytes =
    typeof option.estimatedBytes === 'number' && option.estimatedBytes > 0
      ? option.estimatedBytes
      : typeof option.filesizeBytes === 'number' && option.filesizeBytes > 0
        ? option.filesizeBytes
        : null
  if (bytes !== null) {
    const formatted = formatBytes(bytes)
    if (formatted) {
      parts.push(
        option.sizeIsEstimate === true ? `~${formatted} estimated` : formatted
      )
    }
  }
  return parts.join(' · ')
}

export function optionQueueKey(analysisId, optionId) {
  if (typeof analysisId !== 'string' || typeof optionId !== 'string') return ''
  if (analysisId.length === 0 || optionId.length === 0) return ''
  return `${analysisId}:${optionId}`
}

export function captureViewModel(response) {
  const raw = response && typeof response === 'object' ? response : {}
  const sources = Array.isArray(raw.sources) ? raw.sources : []
  const streaming =
    raw.streaming && typeof raw.streaming === 'object'
      ? raw.streaming
      : { detected: false }
  const analysis =
    raw.analysis &&
    typeof raw.analysis === 'object' &&
    typeof raw.analysis.analysisId === 'string' &&
    Array.isArray(raw.analysis.options)
      ? raw.analysis
      : null
  const status = typeof raw.status === 'string' ? raw.status : 'idle'
  const queuedOptionIds = Array.isArray(raw.queuedOptionIds)
    ? raw.queuedOptionIds.filter((value) => typeof value === 'string')
    : []

  const streamingDetected = streaming.detected === true || analysis !== null
  const mode = streamingDetected
    ? 'streaming'
    : sources.length > 0
      ? 'progressive'
      : 'empty'

  const analyzing = status === 'analyzing'
  const failed = status === 'error'
  const code = typeof streaming.code === 'string' ? streaming.code : ''

  return {
    mode,
    streaming,
    streamingDetected,
    analysis,
    options: analysis ? analysis.options : [],
    status,
    analyzing,
    failed,
    queuedOptionIds,
    detectedLabel:
      mode === 'streaming'
        ? SOURCE_LABELS[code] || 'Streaming video detected'
        : mode === 'progressive'
          ? `${sources.length} source${sources.length === 1 ? '' : 's'}`
          : 'Nothing detected',
    detail:
      typeof streaming.message === 'string' && streaming.message.length > 0
        ? streaming.message
        : null,
    showFindAction:
      mode === 'empty' || (mode === 'streaming' && !analysis && !analyzing),
    showAnalysis: Boolean(analysis) && mode === 'streaming'
  }
}
