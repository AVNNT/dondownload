// Pure, DOM-free decisions for the optional video overlay. This file is loaded
// as a classic content script before overlay.js in the same isolated world, so
// it exposes its API on globalThis instead of using ES module exports.
//
// It never reads a video source, network request, duration, quality or playback
// state. It only decides whether a VIDEO element is large and visible enough
// for a small UI button.

;(function () {
  'use strict'

  var BUTTON_SIZE = 30
  var EDGE_INSET = 8
  var PANEL_GAP = 6
  var MIN_VIDEO_WIDTH = 120
  var MIN_VIDEO_HEIGHT = 68
  var PANEL_WIDTH = 292
  var PANEL_HEIGHT_ESTIMATE = 258
  var SHORTCUT_LABEL = 'Alt+Shift+D'
  var MEDIA_SIZE_UNKNOWN = 'Size unknown'

  function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value)
  }

  function validViewport(viewport) {
    if (!viewport || typeof viewport !== 'object') return null
    var width = viewport.width
    var height = viewport.height
    if (!isFiniteNumber(width) || !isFiniteNumber(height)) return null
    if (width <= 0 || height <= 0) return null
    return { width: width, height: height }
  }

  /**
   * Decide whether a candidate is a usable, visible video. `candidate` is a
   * plain description so this can be tested without a DOM:
   * { tagName, isConnected, hidden, rect, styles? }
   */
  function evaluateVideoCandidate(candidate, viewport) {
    var view = validViewport(viewport)
    if (!view) return { usable: false, reason: 'no-viewport' }
    if (!candidate || typeof candidate !== 'object') {
      return { usable: false, reason: 'no-element' }
    }
    if (String(candidate.tagName || '').toUpperCase() !== 'VIDEO') {
      return { usable: false, reason: 'not-video' }
    }
    if (candidate.isConnected === false) {
      return { usable: false, reason: 'disconnected' }
    }
    if (candidate.hidden === true) return { usable: false, reason: 'hidden' }

    var styles = candidate.styles
    if (styles && typeof styles === 'object') {
      if (styles.display === 'none') return { usable: false, reason: 'display-none' }
      if (styles.visibility === 'hidden' || styles.visibility === 'collapse') {
        return { usable: false, reason: 'visibility-hidden' }
      }
      if (typeof styles.opacity === 'string' && Number(styles.opacity) === 0) {
        return { usable: false, reason: 'transparent' }
      }
    }

    var rect = candidate.rect
    if (!rect || typeof rect !== 'object') return { usable: false, reason: 'no-rect' }

    var left = rect.left
    var top = rect.top
    var width = rect.width
    var height = rect.height
    if (![left, top, width, height].every(isFiniteNumber)) {
      return { usable: false, reason: 'invalid-rect' }
    }
    if (width < MIN_VIDEO_WIDTH || height < MIN_VIDEO_HEIGHT) {
      return { usable: false, reason: 'too-small' }
    }

    var right = left + width
    var bottom = top + height
    var overlapsViewport =
      right > EDGE_INSET &&
      bottom > EDGE_INSET &&
      left < view.width - EDGE_INSET &&
      top < view.height - EDGE_INSET
    if (!overlapsViewport) return { usable: false, reason: 'offscreen' }

    return {
      usable: true,
      reason: 'ok',
      visibleRect: {
        left: Math.max(left, 0),
        top: Math.max(top, 0),
        right: Math.min(right, view.width),
        bottom: Math.min(bottom, view.height)
      }
    }
  }

  /** Find the nearest VIDEO in an event path (supports open shadow roots). */
  function findVideoInPath(path) {
    if (!Array.isArray(path)) return null
    for (var index = 0; index < path.length; index += 1) {
      var node = path[index]
      if (node && String(node.tagName || '').toUpperCase() === 'VIDEO') return node
    }
    return null
  }

  function clamp(value, minimum, maximum) {
    return Math.min(Math.max(value, minimum), maximum)
  }

  /** Small button anchored to the top-right corner of the video. */
  function placeTrigger(rect, viewport) {
    var view = validViewport(viewport)
    if (!view || !rect) return null
    var maxLeft = Math.max(EDGE_INSET, view.width - BUTTON_SIZE - EDGE_INSET)
    var maxTop = Math.max(EDGE_INSET, view.height - BUTTON_SIZE - EDGE_INSET)
    var left = clamp(rect.left + rect.width - BUTTON_SIZE - EDGE_INSET, EDGE_INSET, maxLeft)
    var top = clamp(rect.top + EDGE_INSET, EDGE_INSET, maxTop)
    return { left: left, top: top, width: BUTTON_SIZE, height: BUTTON_SIZE }
  }

  /**
   * Place the expandable panel near the trigger, preferring below and flipping
   * above when needed, always clamped inside the visual viewport.
   */
  function placePanel(trigger, viewport, panelSize) {
    var view = validViewport(viewport)
    if (!view || !trigger) return null
    if (!isFiniteNumber(trigger.left) || !isFiniteNumber(trigger.top)) return null

    var width = panelSize && isFiniteNumber(panelSize.width) ? panelSize.width : PANEL_WIDTH
    var height =
      panelSize && isFiniteNumber(panelSize.height) && panelSize.height > 0
        ? panelSize.height
        : PANEL_HEIGHT_ESTIMATE

    var availableWidth = Math.max(0, view.width - EDGE_INSET * 2)
    width = Math.min(width, availableWidth)
    if (width <= 0) return null

    var below = trigger.top + BUTTON_SIZE + PANEL_GAP
    var fitsBelow = below + height <= view.height - EDGE_INSET
    var above = trigger.top - PANEL_GAP - height
    var placement = fitsBelow ? 'below' : 'above'
    var top = fitsBelow ? below : above
    var maxTop = Math.max(EDGE_INSET, view.height - height - EDGE_INSET)
    top = clamp(top, EDGE_INSET, maxTop)

    var left = trigger.left + BUTTON_SIZE - width
    var maxLeft = Math.max(EDGE_INSET, view.width - width - EDGE_INSET)
    left = clamp(left, EDGE_INSET, maxLeft)

    return { left: left, top: top, width: width, placement: placement }
  }

  /** Observer helper: drop an active video once it is disconnected. */
  function nextActiveVideo(activeVideo) {
    if (!activeVideo) return null
    if (activeVideo.isConnected === false) return null
    return activeVideo
  }

  /** Keyboard typing guard for the overlay shortcut. */
  function isTypingTarget(target) {
    if (!target || typeof target !== 'object') return false
    var tag = String(target.tagName || '').toUpperCase()
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
    return target.isContentEditable === true
  }

  function isOverlayShortcut(event) {
    if (!event || typeof event !== 'object') return false
    if (event.ctrlKey === true || event.metaKey === true) return false
    if (event.altKey !== true || event.shiftKey !== true) return false
    var code = typeof event.code === 'string' ? event.code : ''
    var key = typeof event.key === 'string' ? event.key.toLowerCase() : ''
    return code === 'KeyD' || key === 'd'
  }

  var OPAQUE_MEDIA_ID = /^[A-Za-z0-9_-]{1,128}$/
  var MEDIA_OUTPUT_FORMATS = ['auto', 'mp4', 'mkv', 'webm']

  function isNonEmptyText(value, maximum) {
    return (
      typeof value === 'string' &&
      value.trim().length > 0 &&
      value.length <= maximum
    )
  }

  function nullableInteger(value, minimum, maximum) {
    if (value === null) return null
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) return null
    if (value < minimum || value > maximum) return null
    return value
  }

  function nullableNumber(value, minimum, maximum) {
    if (value === null) return null
    if (typeof value !== 'number' || !Number.isFinite(value)) return null
    if (value < minimum || value > maximum) return null
    return value
  }

  function safeOption(option) {
    if (!option || typeof option !== 'object') return null
    if (option.kind !== 'video' && option.kind !== 'audio') return null
    if (typeof option.optionId !== 'string' || !OPAQUE_MEDIA_ID.test(option.optionId)) {
      return null
    }
    if (!isNonEmptyText(option.label, 240)) return null
    if (!isNonEmptyText(option.container, 32)) return null
    var outputFormats
    if (Array.isArray(option.outputFormats) && option.outputFormats.length > 0) {
      outputFormats = []
      for (var outputIndex = 0; outputIndex < option.outputFormats.length; outputIndex += 1) {
        var outputFormat = option.outputFormats[outputIndex]
        if (
          MEDIA_OUTPUT_FORMATS.indexOf(outputFormat) === -1 ||
          outputFormats.indexOf(outputFormat) !== -1
        ) {
          outputFormats = undefined
          break
        }
        outputFormats.push(outputFormat)
      }
    }
    var formatIds
    if (Array.isArray(option.formatIds) && option.formatIds.length >= 1 && option.formatIds.length <= 2) {
      formatIds = option.formatIds.slice()
      for (var formatIdIndex = 0; formatIdIndex < formatIds.length; formatIdIndex += 1) {
        if (typeof formatIds[formatIdIndex] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(formatIds[formatIdIndex])) {
          formatIds = undefined
          break
        }
      }
    }
    var outputSizes
    if (option.outputSizes && typeof option.outputSizes === 'object' && !Array.isArray(option.outputSizes)) {
      outputSizes = Object.create(null)
      var sizeKeys = Object.keys(option.outputSizes)
      if (sizeKeys.length > 4) outputSizes = undefined
      for (var sizeIndex = 0; outputSizes && sizeIndex < sizeKeys.length; sizeIndex += 1) {
        var formatKey = sizeKeys[sizeIndex]
        var rawSize = option.outputSizes[formatKey]
        if (
          MEDIA_OUTPUT_FORMATS.indexOf(formatKey) === -1 ||
          !rawSize ||
          typeof rawSize !== 'object' ||
          (rawSize.bytes !== null && nullableInteger(rawSize.bytes, 0, Number.MAX_SAFE_INTEGER) === null) ||
          typeof rawSize.isEstimate !== 'boolean'
        ) {
          outputSizes = undefined
          break
        }
        outputSizes[formatKey] = {
          bytes: rawSize.bytes === null ? null : rawSize.bytes,
          isEstimate: rawSize.isEstimate
        }
      }
    }
    return {
      kind: option.kind,
      optionId: option.optionId,
      label: option.label,
      container: option.container,
      width: nullableInteger(option.width, 1, 65535),
      height: nullableInteger(option.height, 1, 65535),
      fps: nullableNumber(option.fps, 0, 1000),
      videoCodec: isNonEmptyText(option.videoCodec, 64) ? option.videoCodec : null,
      audioCodec: isNonEmptyText(option.audioCodec, 64) ? option.audioCodec : null,
      hasAudio: option.hasAudio === true,
      requiresMerge: option.requiresMerge === true,
      hdr: option.hdr === true,
      filesizeBytes: nullableInteger(option.filesizeBytes, 0, Number.MAX_SAFE_INTEGER),
      // Display-only metadata already reported by yt-dlp. `estimatedBytes` is
      // the best available size (exact or approximate); it is never computed
      // in the browser.
      estimatedBytes: nullableInteger(
        option.estimatedBytes,
        0,
        Number.MAX_SAFE_INTEGER
      ),
      sizeIsEstimate: option.sizeIsEstimate === true,
      outputFormats: outputFormats,
      outputSizes: outputSizes,
      formatIds: formatIds
    }
  }

  /**
   * Build a safe display view from a verified analysis. Only response fields
   * are used; the overlay never invents a quality, format or identifier.
   */
  function mediaView(analysis) {
    if (!analysis || typeof analysis !== 'object') return null
    if (
      typeof analysis.analysisId !== 'string' ||
      !OPAQUE_MEDIA_ID.test(analysis.analysisId)
    ) {
      return null
    }
    if (!isNonEmptyText(analysis.title, 500)) return null
    if (!Array.isArray(analysis.options)) return null

    var options = []
    var byId = Object.create(null)
    for (var index = 0; index < analysis.options.length; index += 1) {
      var option = safeOption(analysis.options[index])
      if (!option) continue
      if (byId[option.optionId]) continue
      byId[option.optionId] = option
      options.push(option)
    }

    function referencedKind(value, expectedKind) {
      if (typeof value !== 'string' || !OPAQUE_MEDIA_ID.test(value)) return null
      var referenced = byId[value]
      if (!referenced || referenced.kind !== expectedKind) return null
      return value
    }

    var videoOptions = []
    var audioOptions = []
    for (var optionIndex = 0; optionIndex < options.length; optionIndex += 1) {
      if (options[optionIndex].kind === 'video') videoOptions.push(options[optionIndex])
      else audioOptions.push(options[optionIndex])
    }

    return {
      analysisId: analysis.analysisId,
      title: analysis.title,
      durationSeconds: nullableNumber(
        analysis.durationSeconds,
        0,
        Number.MAX_SAFE_INTEGER
      ),
      options: options,
      videoOptions: videoOptions,
      audioOptions: audioOptions,
      bestVideoOptionId: referencedKind(analysis.bestVideoOptionId, 'video'),
      bestAudioOptionId: referencedKind(analysis.bestAudioOptionId, 'audio')
    }
  }

  function optionById(view, optionId) {
    if (!view || typeof optionId !== 'string') return null
    for (var index = 0; index < view.options.length; index += 1) {
      if (view.options[index].optionId === optionId) return view.options[index]
    }
    return null
  }

  /**
   * Same quality model as the desktop Media tab: every verified height,
   * highest first, plus the best audio-only option. There is no 1080p ceiling.
   */
  function mediaQualityChoices(view) {
    if (!view || !Array.isArray(view.videoOptions)) return []
    var best = optionById(view, view.bestVideoOptionId)
    var byHeight = Object.create(null)
    var heights = []
    for (var index = 0; index < view.videoOptions.length; index += 1) {
      var option = view.videoOptions[index]
      if (option.hasAudio !== true || typeof option.height !== 'number') continue
      if (byHeight[option.height]) continue
      byHeight[option.height] = option
      heights.push(option.height)
    }
    if (
      best &&
      typeof best.height === 'number' &&
      byHeight[best.height]
    ) {
      byHeight[best.height] = best
    }
    heights.sort(function (left, right) {
      return right - left
    })

    var choices = []
    for (var heightIndex = 0; heightIndex < heights.length; heightIndex += 1) {
      var height = heights[heightIndex]
      var heightOption = byHeight[height]
      var isBest = best ? heightOption.optionId === best.optionId : false
      choices.push({
        option: heightOption,
        label: (isBest ? 'Best available · ' : '') + height + 'p',
        best: isBest
      })
    }
    if (best && typeof best.height !== 'number') {
      choices.unshift({ option: best, label: 'Best', best: true })
    }
    var audio = optionById(view, view.bestAudioOptionId)
    if (audio && audio.kind === 'audio') {
      choices.push({ option: audio, label: 'Audio only', best: false })
    }
    return choices
  }

  function outputFormatsForOption(option) {
    if (
      option &&
      Array.isArray(option.outputFormats) &&
      option.outputFormats.length > 0
    ) {
      return option.outputFormats.slice()
    }
    // Older payloads have no verified pairing/FFmpeg list; keep only Auto.
    return ['auto']
  }

  function normalizeOutputFormat(option, requested) {
    var formats = outputFormatsForOption(option)
    return formats.indexOf(requested) === -1 ? 'auto' : requested
  }

  function mediaOutputFormatLabel(format) {
    if (format === 'mp4') return 'MP4'
    if (format === 'mkv') return 'MKV'
    if (format === 'webm') return 'WebM'
    return 'Auto (recommended)'
  }

  function formatBytes(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      return ''
    }
    var units = ['B', 'KB', 'MB', 'GB', 'TB']
    var scaled = value
    var unit = 0
    while (scaled >= 1024 && unit < units.length - 1) {
      scaled /= 1024
      unit += 1
    }
    var decimals = unit === 0 ? 0 : scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2
    return scaled.toFixed(decimals) + ' ' + units[unit]
  }

  /** Render only sizes yt-dlp already reported. Never invent an estimate. */
  function formatMediaSize(bytes, estimate) {
    if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) {
      return MEDIA_SIZE_UNKNOWN
    }
    var formatted = formatBytes(bytes)
    return estimate === true ? '~' + formatted + ' estimated' : formatted
  }

  /** Best available size: exact, approximate, or summed merged streams. */
  function mediaSize(option, outputFormat) {
    if (!option || typeof option !== 'object') return null
    var outputSize =
      outputFormat && option.outputSizes && option.outputSizes[outputFormat]
    if (outputSize) {
      return { bytes: outputSize.bytes, isEstimate: outputSize.isEstimate }
    }
    if (typeof option.estimatedBytes === 'number' && option.estimatedBytes > 0) {
      return { bytes: option.estimatedBytes, isEstimate: option.sizeIsEstimate === true }
    }
    if (typeof option.filesizeBytes === 'number' && option.filesizeBytes > 0) {
      return { bytes: option.filesizeBytes, isEstimate: false }
    }
    return { bytes: null, isEstimate: false }
  }

  /** Visible size label for one verified option, including unknown sizes. */
  function describeMediaSize(option, outputFormat) {
    if (!option || typeof option !== 'object') return MEDIA_SIZE_UNKNOWN
    var size = mediaSize(option, outputFormat)
    return formatMediaSize(size.bytes, size.isEstimate)
  }

  /** Format details without the size, so the UI can show the size separately. */
  function describeMediaDetails(option) {
    if (!option || typeof option !== 'object') return ''
    var parts = []
    if (typeof option.height === 'number') parts.push(option.height + 'p')
    else if (typeof option.width === 'number') parts.push(option.width + 'px wide')
    if (typeof option.container === 'string' && option.container.length > 0) {
      parts.push(option.container.toUpperCase())
    }
    if (typeof option.fps === 'number' && option.fps > 0) {
      parts.push(Math.round(option.fps) + ' fps')
    }
    if (option.hdr === true) parts.push('HDR')
    if (option.kind === 'video' && option.hasAudio === true) parts.push('with audio')
    if (option.requiresMerge === true) parts.push('merged')
    if (Array.isArray(option.formatIds) && option.formatIds.length > 0) {
      parts.push('yt-dlp ' + option.formatIds.join('+'))
    }
    return parts.join(' · ')
  }

  /** Complete option description, retained for callers that need one line. */
  function describeMediaOption(option) {
    if (!option || typeof option !== 'object') return ''
    var details = describeMediaDetails(option)
    var size = describeMediaSize(option)
    return details ? details + ' · ' + size : size
  }

  function mediaErrorMessage(error, fallback) {
    if (
      error &&
      typeof error.message === 'string' &&
      error.message.trim().length > 0
    ) {
      return error.message.trim()
    }
    return fallback
  }

  /**
   * Turn a verified error code into a short, actionable instruction. The
   * desktop app intentionally sends stable codes with general messages, so the
   * next step has to live here rather than in native/security code.
   */
  function describeMediaError(error, fallback) {
    var code = error && typeof error.code === 'string' ? error.code : ''
    var message = mediaErrorMessage(error, fallback)

    var hints = {
      APP_NOT_RUNNING: 'Start DonDownload (the tray icon is enough), then try again.',
      APP_UNAVAILABLE: 'Start DonDownload (the tray icon is enough), then try again.',
      NATIVE_RESPONSE_INVALID:
        'Reload this page and try again. If it keeps happening, update DonDownload.',
      MEDIA_REQUEST_FAILED: 'Reload this page, then try again.',
      INVALID_SENDER: 'Reload this page, then enable the overlay again from the DonDownload popup.',
      ORIGIN_MISMATCH: 'Reload this page, then enable the overlay again from the DonDownload popup.',
      PERMISSION_REQUIRED:
        'Enable the overlay for this site again from the DonDownload popup.',
      OVERLAY_NOT_REGISTERED:
        'Reload this page, then enable the overlay again from the DonDownload popup.',
      TAB_NOT_ASSOCIATED:
        'Reload this page, then enable the overlay again from the DonDownload popup.',
      INVALID_MEDIA_OPTION: 'Analyze this page again, then pick an option.',
      MEDIA_ANALYSIS_EXPIRED: 'Analyze this page again, then pick an option.',
      MEDIA_ANALYSIS_NOT_FOUND: 'Analyze this page again, then pick an option.',
      MEDIA_ANALYSIS_MISMATCH: 'Analyze this page again, then pick an option.',
      MEDIA_OPTION_INVALID: 'Analyze this page again, then pick an option.',
      MEDIA_OUTPUT_FORMAT_UNSUPPORTED:
        'This stream cannot be remuxed to that container without transcoding. Choose Auto or another available format.',
      MEDIA_DUPLICATE_JOB: 'This option is already queued in DonDownload.',
      MEDIA_TOOL_UNAVAILABLE:
        'Open DonDownload and check that yt-dlp is available, then try again.',
      MEDIA_ANALYSIS_TIMEOUT: 'Try again, or open this page directly in DonDownload.',
      MEDIA_UNSUPPORTED_PLAYLIST:
        'Open a single video page instead of a playlist or collection.',
      MEDIA_UNSUPPORTED_LIVE: 'Live streams are not supported by DonDownload.',
      MEDIA_UNSUPPORTED_MEDIA:
        'This page does not expose a supported video that DonDownload can download.',
      MEDIA_TARGET_NOT_PUBLIC:
        'Local and private network addresses are not supported by DonDownload.',
      MEDIA_TARGET_UNRESOLVED: 'Check the connection to this site, then try again.',
      MEDIA_SIZE_CAP_EXCEEDED:
        'The size limit in DonDownload is too small for this option.',
      MEDIA_MERGE_UNAVAILABLE:
        'DonDownload could not merge these video and audio streams on this system.',
      MEDIA_OUTPUT_UNAVAILABLE:
        'DonDownload could not write the output file. Check the download folder.'
    }

    // Error codes cross the native messaging boundary; don't let inherited
    // object properties such as "constructor" or "toString" act as hints.
    var hint = Object.prototype.hasOwnProperty.call(hints, code) ? hints[code] : null
    if (!hint || message.toLowerCase().indexOf(hint.toLowerCase()) !== -1) {
      return message
    }
    return message + ' ' + hint
  }

  function formatDuration(seconds) {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
      return ''
    }
    var total = Math.round(seconds)
    var hours = Math.floor(total / 3600)
    var minutes = Math.floor((total % 3600) / 60)
    var remaining = total % 60
    if (hours > 0) {
      return hours + ':' + String(minutes).padStart(2, '0') + ':' + String(remaining).padStart(2, '0')
    }
    return minutes + ':' + String(remaining).padStart(2, '0')
  }

  /** Initial, truthful panel copy for the media milestone. */
  function initialMediaState() {
    return Object.freeze({
      title: 'Video options for this page',
      detail:
        'Open this capture panel to ask DonDownload about the page. Only the page address from the browser is used; the video source, cookies and player state are never read. Reported file sizes come from yt-dlp metadata and may be estimates or unknown.',
      actionLabel: 'Analyze this page',
      analyzingLabel: 'Analyzing…',
      optionsHint:
        'Options and reported sizes come from a verified analysis. Nothing is captured or downloaded until you choose one.',
      disableLabel: 'Turn off overlay on this site',
      shortcutLabel: SHORTCUT_LABEL
    })
  }

  /**
   * Retained for the pre-media fallback path. The live overlay uses
   * initialMediaState and only shows verified response options.
   */
  function unavailableState() {
    return Object.freeze({
      title: 'Video download is not available in this milestone.',
      detail:
        'DonDownload does not detect formats, resolutions or qualities, does not read media source URLs, and does not bypass DRM or access restrictions.',
      actionLabel: 'Download video (unavailable)',
      optionsHint:
        "Use the DonDownload toolbar button to send this page's HTTP(S) address. Manual page capture is unchanged.",
      disableLabel: 'Turn off overlay on this site',
      shortcutLabel: SHORTCUT_LABEL
    })
  }

  var api = Object.freeze({
    BUTTON_SIZE: BUTTON_SIZE,
    EDGE_INSET: EDGE_INSET,
    MIN_VIDEO_WIDTH: MIN_VIDEO_WIDTH,
    MIN_VIDEO_HEIGHT: MIN_VIDEO_HEIGHT,
    SHORTCUT_LABEL: SHORTCUT_LABEL,
    MEDIA_SIZE_UNKNOWN: MEDIA_SIZE_UNKNOWN,
    evaluateVideoCandidate: evaluateVideoCandidate,
    findVideoInPath: findVideoInPath,
    placeTrigger: placeTrigger,
    placePanel: placePanel,
    nextActiveVideo: nextActiveVideo,
    isTypingTarget: isTypingTarget,
    isOverlayShortcut: isOverlayShortcut,
    initialMediaState: initialMediaState,
    mediaView: mediaView,
    mediaQualityChoices: mediaQualityChoices,
    outputFormatsForOption: outputFormatsForOption,
    normalizeOutputFormat: normalizeOutputFormat,
    mediaOutputFormatLabel: mediaOutputFormatLabel,
    formatMediaSize: formatMediaSize,
    describeMediaDetails: describeMediaDetails,
    describeMediaSize: describeMediaSize,
    describeMediaOption: describeMediaOption,
    describeMediaError: describeMediaError,
    formatDuration: formatDuration,
    unavailableState: unavailableState
  })

  if (typeof module === 'object' && module && module.exports) {
    module.exports = api
  }
  if (typeof globalThis !== 'undefined') {
    globalThis.DonDownloadOverlayCore = api
  }
})()
