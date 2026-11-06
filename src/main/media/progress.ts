/**
 * yt-dlp progress parsing for one download. The tracker owns the line buffers,
 * per-stream byte/speed state, merge and DRM markers and the size-cap check; it
 * reports only through the engine's emit/terminate callbacks.
 */
import { isMergingLine, parseProgressLine } from './args'
import { looksLikeDrmError, looksLikeMaxFilesizeError } from './analysis'

export interface MediaDownloadProgress {
  status: 'downloading' | 'merging'
  completedBytes: number
  totalBytes: number | null
  speedBps: number
  filePath: string | null
}

export interface DownloadProgressTrackerOptions {
  /** Analysis estimate, used until every stream reports a real total. */
  expectedTotal: number | null
  expectedStreamCount: number
  maxBytes: number | null
  emit: (
    status: 'downloading' | 'merging',
    completedBytes: number,
    totalBytes: number | null,
    speedBps: number,
    filePath: string | null
  ) => void
  /** Called once when streamed bytes first exceed the per-job size limit. */
  onSizeCapExceeded: () => void
}

export interface DownloadProgressSnapshot {
  completed: number
  total: number | null
  speed: number
}

export interface DownloadProgressTracker {
  readonly merging: boolean
  readonly drmDetected: boolean
  readonly sizeCapExceeded: boolean
  snapshot(): DownloadProgressSnapshot
  handleStdoutText(text: string): void
  handleStderrText(text: string): void
  /** Flush both buffers when the child closes. */
  flush(): void
}

export function createDownloadProgressTracker(
  options: DownloadProgressTrackerOptions
): DownloadProgressTracker {
  const { expectedTotal, expectedStreamCount, maxBytes, emit, onSizeCapExceeded } =
    options

  let stdoutRemainder = ''
  let stderrRemainder = ''
  let mergingSeen = false
  let sizeCapExceeded = false
  let drmDetected = false
  const streams = new Map<
    string,
    { completed: number; total: number | null; speed: number }
  >()

  const snapshot = (): DownloadProgressSnapshot => {
    let completed = 0
    let total = 0
    let speed = 0
    let totalKnown = true
    for (const stream of streams.values()) {
      completed += stream.completed
      speed += stream.speed
      if (stream.total === null) totalKnown = false
      else total += stream.total
    }
    let resolvedTotal = streams.size > 0 && totalKnown ? total : null
    if (expectedTotal !== null && expectedTotal > 0) {
      if (resolvedTotal === null) {
        resolvedTotal = expectedTotal
      } else if (streams.size < expectedStreamCount && resolvedTotal < expectedTotal) {
        resolvedTotal = expectedTotal
      }
    }
    return { completed, total: resolvedTotal, speed }
  }

  const emitSnapshot = (
    status: 'downloading' | 'merging',
    filePath: string | null
  ): void => {
    const currentSnapshot = snapshot()
    emit(
      status,
      currentSnapshot.completed,
      currentSnapshot.total,
      currentSnapshot.speed,
      filePath
    )
  }

  const markMerging = (): void => {
    if (mergingSeen) return
    mergingSeen = true
    emitSnapshot('merging', null)
  }

  const handleStdoutLine = (line: string): void => {
    // yt-dlp writes post-processing markers such as `[Merger] Merging
    // formats into ...` to stdout (older releases used stderr).
    if (isMergingLine(line)) markMerging()
    if (looksLikeDrmError(line)) drmDetected = true
    if (looksLikeMaxFilesizeError(line)) sizeCapExceeded = true

    const progress = parseProgressLine(line)
    if (progress !== null) {
      const previous = streams.get(progress.streamId)
      // HLS/DASH fragment downloads often have no byte total. Estimate one
      // from the fragment position so the bar still advances, and replace it
      // as soon as yt-dlp reports a real total.
      const fragmentTotal =
        progress.totalBytes === null &&
        progress.fragmentIndex !== null &&
        progress.fragmentCount !== null &&
        progress.fragmentIndex > 0 &&
        progress.fragmentCount > 0
          ? Math.round(
              (progress.completedBytes * progress.fragmentCount) /
                progress.fragmentIndex
            )
          : null
      streams.set(progress.streamId, {
        completed: progress.completedBytes,
        total:
          progress.totalBytes ??
          (fragmentTotal !== null && Number.isSafeInteger(fragmentTotal)
            ? fragmentTotal
            : previous?.total ?? null),
        speed: progress.speedBps
      })
      emitSnapshot(mergingSeen ? 'merging' : 'downloading', null)
      if (maxBytes !== null && snapshot().completed > maxBytes && !sizeCapExceeded) {
        sizeCapExceeded = true
        onSizeCapExceeded()
      }
    }
  }

  const handleStdoutText = (text: string): void => {
    stdoutRemainder += text
    let newline = stdoutRemainder.indexOf('\n')
    while (newline >= 0) {
      const line = stdoutRemainder.slice(0, newline).replace(/\r$/, '')
      stdoutRemainder = stdoutRemainder.slice(newline + 1)
      handleStdoutLine(line)
      newline = stdoutRemainder.indexOf('\n')
    }
    if (stdoutRemainder.length > 256 * 1024) {
      stdoutRemainder = stdoutRemainder.slice(-64 * 1024)
    }
  }

  const handleStderrText = (text: string): void => {
    stderrRemainder += text
    if (looksLikeDrmError(stderrRemainder)) drmDetected = true
    if (looksLikeMaxFilesizeError(stderrRemainder)) sizeCapExceeded = true
    const lines = stderrRemainder.split(/\r?\n/)
    stderrRemainder = lines.pop() ?? ''
    for (const line of lines) {
      if (isMergingLine(line)) {
        markMerging()
        break
      }
    }
    if (stderrRemainder.length > 16 * 1024) {
      stderrRemainder = stderrRemainder.slice(-4 * 1024)
    }
  }

  const flush = (): void => {
    if (stdoutRemainder.length > 0) {
      handleStdoutLine(stdoutRemainder.replace(/\r$/, ''))
      stdoutRemainder = ''
    }
    if (stderrRemainder.length > 0) {
      if (isMergingLine(stderrRemainder)) markMerging()
      stderrRemainder = ''
    }
  }

  return {
    get merging() {
      return mergingSeen
    },
    get drmDetected() {
      return drmDetected
    },
    get sizeCapExceeded() {
      return sizeCapExceeded
    },
    snapshot,
    handleStdoutText,
    handleStderrText,
    flush
  }
}
