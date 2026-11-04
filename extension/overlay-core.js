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

  /**
   * The only statements this milestone may make about media downloads. There
   * are deliberately no format or quality choices here.
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
    unavailableState: unavailableState
  })

  if (typeof module === 'object' && module && module.exports) {
    module.exports = api
  }
  if (typeof globalThis !== 'undefined') {
    globalThis.DonDownloadOverlayCore = api
  }
})()
