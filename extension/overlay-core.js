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
      filesizeBytes: nullableInteger(option.filesizeBytes, 0, Number.MAX_SAFE_INTEGER)
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

  function formatBytes(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return ''
    if (value < 1024) return value + ' B'
    if (value < 1024 * 1024) return Math.round(value / 1024) + ' KB'
    if (value < 1024 * 1024 * 1024) {
      return (Math.round(value / (1024 * 1024) * 10) / 10) + ' MB'
    }
    return (Math.round(value / (1024 * 1024 * 1024) * 10) / 10) + ' GB'
  }

  function describeMediaOption(option) {
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
    if (option.kind === 'video' && option.hasAudio === true) parts.push('with audio')
    if (option.requiresMerge === true) parts.push('merged')
    var size = formatBytes(option.filesizeBytes)
    if (size) parts.push(size)
    return parts.join(' · ')
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
        'Choose Analyze to ask DonDownload about this page. Only the page address from the browser is used; the video source, cookies and player state are never read.',
      actionLabel: 'Analyze this page',
      analyzingLabel: 'Analyzing…',
      optionsHint:
        'Options come from a verified analysis. Nothing is captured or downloaded until you choose one.',
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
    evaluateVideoCandidate: evaluateVideoCandidate,
    findVideoInPath: findVideoInPath,
    placeTrigger: placeTrigger,
    placePanel: placePanel,
    nextActiveVideo: nextActiveVideo,
    isTypingTarget: isTypingTarget,
    isOverlayShortcut: isOverlayShortcut,
    initialMediaState: initialMediaState,
    mediaView: mediaView,
    describeMediaOption: describeMediaOption,
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
