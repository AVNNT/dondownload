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
  // An embedded player must be large enough to be an intentional video
  // surface, not a tracking pixel, social widget or ad slot.
  var MIN_IFRAME_WIDTH = 240
  var MIN_IFRAME_HEIGHT = 135
  var PANEL_WIDTH = 292
  var PANEL_HEIGHT_ESTIMATE = 258
  // Firefox opens the command editor from the add-on manager instead of the
  // Chromium extensions page. The injected UI must not send Firefox users to a
  // chrome:// URL, which does not exist there.
  var IS_FIREFOX =
    typeof navigator !== 'undefined' &&
    typeof navigator.userAgent === 'string' &&
    /Firefox\//.test(navigator.userAgent)
  var SHORTCUT_LABEL = IS_FIREFOX
    ? 'about:addons > Manage Extension Shortcuts'
    : 'chrome://extensions/shortcuts'
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

  function toBox(rect) {
    if (!rect || typeof rect !== 'object') return null
    var left = rect.left
    var top = rect.top
    var width = rect.width
    var height = rect.height
    if (![left, top, width, height].every(isFiniteNumber)) return null
    return { left: left, top: top, width: width, height: height }
  }

  function boxArea(box) {
    if (!box) return 0
    return Math.max(0, box.width) * Math.max(0, box.height)
  }

  /**
   * Intersect two plain rects. Returns null when they do not overlap, so an
   * empty intersection is never mistaken for a zero-size anchor.
   */
  function intersectRects(first, second) {
    var a = toBox(first)
    var b = toBox(second)
    if (!a || !b) return null
    var left = Math.max(a.left, b.left)
    var top = Math.max(a.top, b.top)
    var right = Math.min(a.left + a.width, b.left + b.width)
    var bottom = Math.min(a.top + a.height, b.top + b.height)
    if (!(right > left) || !(bottom > top)) return null
    return { left: left, top: top, width: right - left, height: bottom - top }
  }

  function viewportRect(viewport) {
    var view = validViewport(viewport)
    if (!view) return null
    return { left: 0, top: 0, width: view.width, height: view.height }
  }

  /**
   * The visible part of a video: its rect intersected with every clipping
   * ancestor (nearest first, as `clipRects`) and with the viewport.
   *
   * Some players (YouTube before playback) report a video rect that is shifted
   * far above the visible player while the player container clips it away. When
   * the intersection is empty or tiny but a clipping ancestor is itself large
   * and visible, that ancestor is the real player surface and becomes the
   * anchor. A fully offscreen video still yields null.
   *
   * input: { rect, clipRects?, viewport }
   * result: { anchor, source: 'video' | 'container' | 'none', visible }
   */
  function chooseAnchor(input) {
    var view = validViewport(input && input.viewport)
    if (!view) return { anchor: null, source: 'none', visible: null }
    var rect = toBox(input && input.rect)
    if (!rect) return { anchor: null, source: 'none', visible: null }

    var viewBox = viewportRect(view)
    var visible = intersectRects(rect, viewBox)
    var clips = Array.isArray(input.clipRects) ? input.clipRects : []
    var containers = []
    for (var index = 0; index < clips.length; index += 1) {
      var clip = toBox(clips[index])
      if (!clip) continue
      containers.push(clip)
      visible = visible ? intersectRects(visible, clip) : null
    }

    if (visible && visible.width >= MIN_VIDEO_WIDTH && visible.height >= MIN_VIDEO_HEIGHT) {
      return { anchor: visible, source: 'video', visible: visible }
    }

    var fallback = null
    for (var containerIndex = 0; containerIndex < containers.length; containerIndex += 1) {
      var candidate = intersectRects(containers[containerIndex], viewBox)
      if (!candidate) continue
      if (candidate.width < MIN_VIDEO_WIDTH || candidate.height < MIN_VIDEO_HEIGHT) continue
      if (boxArea(candidate) > boxArea(fallback)) fallback = candidate
    }
    if (fallback) return { anchor: fallback, source: 'container', visible: fallback }
    return { anchor: null, source: 'none', visible: visible }
  }

  /**
   * Decide whether a candidate is a usable, visible video. `candidate` is a
   * plain description so this can be tested without a DOM:
   * { tagName, isConnected, hidden, rect, clipRects?, styles? }
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

    // A video clipped to nothing is offscreen even when its raw rect overlaps
    // the viewport; a shifted video whose visible player container is large
    // still counts as usable, anchored to that container.
    var chosen = chooseAnchor({
      rect: rect,
      clipRects: candidate.clipRects,
      viewport: view
    })
    if (!chosen.anchor) {
      return {
        usable: false,
        reason: chosen.visible ? 'offscreen' : 'clipped',
        anchorRect: null
      }
    }

    return {
      usable: true,
      reason: 'ok',
      anchorRect: chosen.anchor,
      anchorSource: chosen.source,
      visibleRect: {
        left: chosen.anchor.left,
        top: chosen.anchor.top,
        right: chosen.anchor.left + chosen.anchor.width,
        bottom: chosen.anchor.top + chosen.anchor.height
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

  /** Find the nearest IFRAME in an event path (supports open shadow roots). */
  function findIframeInPath(path) {
    if (!Array.isArray(path)) return null
    for (var index = 0; index < path.length; index += 1) {
      var node = path[index]
      if (node && String(node.tagName || '').toUpperCase() === 'IFRAME') return node
    }
    return null
  }

  /**
   * Decide whether a top-frame IFRAME looks like a visible embedded video
   * player. The frame itself is only inspected from the top frame; nothing is
   * injected into it and no cross-origin document is read.
   */
  function evaluateIframeCandidate(candidate, viewport) {
    var view = validViewport(viewport)
    if (!view) return { usable: false, reason: 'no-viewport' }
    if (!candidate || typeof candidate !== 'object') {
      return { usable: false, reason: 'no-element' }
    }
    if (String(candidate.tagName || '').toUpperCase() !== 'IFRAME') {
      return { usable: false, reason: 'not-iframe' }
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

    var url = normalizeCapturedSourceUrl(candidate.src)
    if (url === null) return { usable: false, reason: 'invalid-src' }

    var rect = candidate.rect
    if (!rect || typeof rect !== 'object') return { usable: false, reason: 'no-rect' }

    var left = rect.left
    var top = rect.top
    var width = rect.width
    var height = rect.height
    if (![left, top, width, height].every(isFiniteNumber)) {
      return { usable: false, reason: 'invalid-rect' }
    }
    if (width < MIN_IFRAME_WIDTH || height < MIN_IFRAME_HEIGHT) {
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
      url: url,
      visibleRect: {
        left: Math.max(left, 0),
        top: Math.max(top, 0),
        right: Math.min(right, view.width),
        bottom: Math.min(bottom, view.height)
      }
    }
  }

  function clamp(value, minimum, maximum) {
    return Math.min(Math.max(value, minimum), maximum)
  }

  /** Small button anchored to the top-left corner of the visible video. */
  function placeTrigger(rect, viewport) {
    var view = validViewport(viewport)
    if (!view || !rect) return null
    var maxLeft = Math.max(EDGE_INSET, view.width - BUTTON_SIZE - EDGE_INSET)
    var maxTop = Math.max(EDGE_INSET, view.height - BUTTON_SIZE - EDGE_INSET)
    var left = clamp(rect.left + EDGE_INSET, EDGE_INSET, maxLeft)
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

  /**
   * The floating trigger should appear for any visible, attached player, not
   * only after play or metadata. KVS v6 creates a `preload="none"` video with
   * no src until the user presses play, and a transparent click-catcher can
   * cover it; the large visible element is still a real player surface.
   * Neither playback state nor dimensions ever prove a downloadable source.
   */
  function isTriggerReady(input) {
    if (!input || typeof input !== 'object') return false
    if (input.error) return false
    if (input.isConnected === false) return false
    return true
  }

  /**
   * Pick the largest ready candidate from plain descriptions. The overlay passes
   * one entry per usable VIDEO element; keeping the choice here makes the
   * timing/state rule testable without a DOM.
   */
  function largestTriggerCandidate(candidates) {
    if (!Array.isArray(candidates)) return null
    var best = null
    var bestArea = 0
    for (var index = 0; index < candidates.length; index += 1) {
      var candidate = candidates[index]
      if (!candidate || candidate.ready !== true || candidate.usable === false) {
        continue
      }
      var rect = candidate.rect
      if (!rect || typeof rect !== 'object') continue
      if (!isFiniteNumber(rect.width) || !isFiniteNumber(rect.height)) continue
      var area = rect.width * rect.height
      if (area <= 0 || area <= bestArea) continue
      bestArea = area
      best = candidate
    }
    return best
  }

  var PREFETCH_DEBOUNCE_MS = 500
  var PREFETCH_MAX_AGE_MS = 10 * 60 * 1000

  /**
   * Decide what the background page-analysis prefetch should do for one exact
   * page URL. Only the opted-in overlay calls this. A cached analysis is reused
   * until its reported expiry; a failed analysis is never retried
   * automatically (the manual action remains the retry).
   *
   * previous: { url, status, expiresAt, token, startedAt } or null
   * input: { url, now, eligible }
   */
  function prefetchDecision(previous, input) {
    if (!input || input.eligible !== true) {
      return { action: 'none', reason: 'not-eligible' }
    }
    if (typeof input.url !== 'string' || input.url.length === 0) {
      return { action: 'none', reason: 'no-url' }
    }
    var now = isFiniteNumber(input.now) ? input.now : Date.now()
    if (!previous || typeof previous !== 'object') {
      return { action: 'debounce', reason: 'new' }
    }
    if (previous.url !== input.url) {
      return { action: 'debounce', reason: 'url-changed' }
    }
    if (previous.status === 'analyzing' || previous.status === 'debouncing') {
      return { action: 'none', reason: 'in-flight' }
    }
    if (previous.status === 'ready') {
      if (isFiniteNumber(previous.expiresAt) && previous.expiresAt > now) {
        return { action: 'reuse', reason: 'cached' }
      }
      return { action: 'analyze', reason: 'expired' }
    }
    if (previous.status === 'error') {
      return { action: 'none', reason: 'failed' }
    }
    return { action: 'debounce', reason: 'idle' }
  }

  /**
   * Ignore a response from an older request, a different URL, or after the
   * overlay/SPA navigation already advanced the token.
   */
  function prefetchResultApplies(previous, input) {
    if (!previous || !input) return false
    if (previous.status !== 'analyzing') return false
    if (typeof previous.url !== 'string' || previous.url !== input.url) return false
    if (previous.token !== input.token) return false
    if (
      isFiniteNumber(input.now) &&
      isFiniteNumber(previous.startedAt) &&
      input.now - previous.startedAt > PREFETCH_MAX_AGE_MS
    ) {
      return false
    }
    return true
  }

  /** True for the playback kinds that only page analysis can resolve. */
  function isStreamingUnsupported(unsupported) {
    if (!unsupported || typeof unsupported !== 'object') return false
    return (
      unsupported.code === 'SEGMENTED_MEDIA' ||
      unsupported.code === 'MANIFEST_STREAM' ||
      unsupported.code === 'NOT_PROGRESSIVE'
    )
  }

  /** Queue feedback: one exact option per analysis may be queued once. */
  function isOptionQueued(queuedOptionIds, optionId) {
    if (!Array.isArray(queuedOptionIds) || typeof optionId !== 'string') return false
    return queuedOptionIds.indexOf(optionId) !== -1
  }

  function markOptionQueued(queuedOptionIds, optionId) {
    var clean = Array.isArray(queuedOptionIds) ? queuedOptionIds.slice() : []
    if (typeof optionId !== 'string' || optionId.length === 0) return clean
    if (clean.indexOf(optionId) === -1) clean.push(optionId)
    return clean.slice(-100)
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

  // Progressive capture: only an actual playing media element's currentSrc is
  // observed. Request headers, cookies, DRM data and MSE segment requests are
  // never read. A blob:/manifest source is reported as explicitly unsupported
  // because the exact downloadable representation cannot be proven.
  var PROGRESSIVE_EXTENSIONS = ['mp4', 'webm', 'm4v', 'mov', 'ogv', 'mkv']
  var MANIFEST_EXTENSIONS = ['m3u8', 'mpd']
  var MAX_CAPTURED_SOURCES_PER_PLAYER = 32

  function pathExtension(value) {
    var trimmed = String(value || '').trim().replace(/\/+$/, '')
    var match = /\.([a-z0-9]{2,5})$/i.exec(trimmed)
    return match ? match[1].toLowerCase() : null
  }

  /** Validate a captured source URL. Returns null when it is not http(s). */
  function normalizeCapturedSourceUrl(value) {
    if (typeof value !== 'string') return null
    var raw = value.trim()
    if (raw.length === 0 || raw.length > 4096) return null
    // eslint-disable-next-line no-control-regex -- rejecting control characters is the security intent here
    if (/[\u0000-\u001f\u007f]/.test(raw)) return null

    var parsed
    try {
      parsed = new URL(raw)
    } catch {
      return null
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    if (!parsed.hostname || parsed.username || parsed.password) return null
    parsed.hash = ''
    return parsed.href
  }

  function decodedBasename(pathname) {
    try {
      var segment = String(pathname || '').split('/').filter(Boolean).pop() || ''
      return decodeURIComponent(segment)
    } catch {
      return ''
    }
  }

  function capturedSourceFilename(url, container) {
    var parsed
    try {
      parsed = new URL(url)
    } catch {
      return 'video.' + container
    }
    var base = decodedBasename(parsed.pathname)
      // eslint-disable-next-line no-control-regex -- rejecting control characters is the security intent here
      .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^[. ]+|[. ]+$/g, '')
    if (base.length === 0) return 'video.' + container
    if (pathExtension(base) !== null) return base.slice(0, 180)
    var suffix = '.' + container
    return (base.slice(0, Math.max(1, 180 - suffix.length)) + suffix)
  }

  /**
   * Display-only quality label from the playing element's decoded dimensions.
   * This is called only after an exact downloadable currentSrc was already
   * proven; dimensions are never used as source proof.
   */
  function qualityLabelForDimensions(width, height) {
    if (
      typeof height !== 'number' ||
      !Number.isFinite(height) ||
      height <= 0 ||
      height > 100000
    ) {
      return null
    }
    return Math.round(height) + 'p'
  }

  /**
   * Classify one media element's current playback source. Dimensions, segment
   * URLs and resource timing are deliberately not used as proof.
   *
   * input: { currentSrc, paused, readyState, ended, error, videoWidth, videoHeight }
   * result: { kind: 'none' | 'not-playing' | 'unsupported' | 'verified', ... }
   */
  function evaluatePlaybackSource(input) {
    if (!input || typeof input !== 'object') return { kind: 'none' }
    var raw = typeof input.currentSrc === 'string' ? input.currentSrc.trim() : ''
    if (raw.length === 0) return { kind: 'none' }

    if (/^blob:/i.test(raw)) {
      return {
        kind: 'unsupported',
        code: 'SEGMENTED_MEDIA',
        message:
          'This player uses Media Source playback. Find qualities with DonDownload to analyze the page and choose a verified format.'
      }
    }

    var url = normalizeCapturedSourceUrl(raw)
    if (url === null) {
      return {
        kind: 'unsupported',
        code: 'UNSUPPORTED_URL',
        message: 'This playback source is not a public HTTP(S) media URL.'
      }
    }

    var extension = pathExtension(new URL(url).pathname)
    if (extension !== null && MANIFEST_EXTENSIONS.indexOf(extension) !== -1) {
      return {
        kind: 'unsupported',
        code: 'MANIFEST_STREAM',
        message:
          'This HLS or DASH stream is handled by analysis. Find qualities with DonDownload to choose a verified format.'
      }
    }
    if (extension !== null && PROGRESSIVE_EXTENSIONS.indexOf(extension) === -1) {
      return {
        kind: 'unsupported',
        code: 'NOT_PROGRESSIVE',
        message:
          'This source is not a recognized progressive MP4 or WebM file. Find qualities with DonDownload to analyze the page instead.'
      }
    }

    if (input.error) {
      return {
        kind: 'unsupported',
        code: 'PLAYBACK_ERROR',
        message: 'The player reported an error for this source.'
      }
    }
    if (input.paused !== false || typeof input.readyState !== 'number' || input.readyState < 2) {
      return { kind: 'not-playing' }
    }

    var width =
      typeof input.videoWidth === 'number' && input.videoWidth > 0
        ? Math.round(input.videoWidth)
        : null
    var height =
      typeof input.videoHeight === 'number' && input.videoHeight > 0
        ? Math.round(input.videoHeight)
        : null
    var qualityLabel = qualityLabelForDimensions(
      input.videoWidth,
      input.videoHeight
    )

    // An extensionless URL is not guessed from a filename or dimensions. The
    // caller requests exact response evidence and only then builds a source.
    if (extension === null) {
      return {
        kind: 'needs-evidence',
        url: url,
        currentSrc: raw,
        width: width,
        height: height,
        qualityLabel: qualityLabel
      }
    }

    return {
      kind: 'verified',
      url: url,
      container: extension,
      filename: capturedSourceFilename(url, extension),
      currentSrc: raw,
      width: width,
      height: height,
      qualityLabel: qualityLabel
    }
  }

  /**
   * Apply exact response evidence to a candidate for the same currentSrc.
   * The evidence must prove the same URL and a complete total. Extensionless
   * sources additionally require an exact video/mp4 or video/webm type. Width
   * and height are used only for the display label after this proof.
   */
  function applyNetworkEvidence(candidate, evidence) {
    if (!candidate || !evidence) return null
    if (candidate.kind !== 'verified' && candidate.kind !== 'needs-evidence') {
      return null
    }
    if (typeof candidate.url !== 'string' || evidence.url !== candidate.url) {
      return null
    }
    if (evidence.completeFile !== true) return null
    if (
      typeof evidence.totalBytes !== 'number' ||
      !Number.isSafeInteger(evidence.totalBytes) ||
      evidence.totalBytes <= 0
    ) {
      return null
    }

    var container = candidate.container
    if (candidate.kind === 'needs-evidence') {
      if (evidence.contentType === 'video/mp4') container = 'mp4'
      else if (evidence.contentType === 'video/webm') container = 'webm'
      else return null
    }
    if (
      typeof container !== 'string' ||
      PROGRESSIVE_EXTENSIONS.indexOf(container) === -1
    ) {
      return null
    }

    return {
      kind: 'verified',
      url: candidate.url,
      container: container,
      filename: capturedSourceFilename(candidate.url, container),
      currentSrc: candidate.currentSrc,
      width: candidate.width,
      height: candidate.height,
      qualityLabel: candidate.qualityLabel,
      sizeBytes: evidence.totalBytes,
      contentType:
        evidence.contentType === 'video/mp4' || evidence.contentType === 'video/webm'
          ? evidence.contentType
          : null,
      networkEvidence: true
    }
  }

  /**
   * Accumulate per-player sources without duplicates. Replaying an earlier
   * source moves it back to the current position (for example 1080p -> 720p ->
   * 1080p) and keeps a single row for that exact URL.
   */
  function addCapturedSource(sources, candidate) {
    if (!candidate || candidate.kind !== 'verified') return Array.isArray(sources) ? sources.slice() : []
    if (typeof candidate.url !== 'string') return Array.isArray(sources) ? sources.slice() : []

    var next = []
    var previous = Array.isArray(sources) ? sources : []
    next.push({
      url: candidate.url,
      filename: candidate.filename,
      container: candidate.container,
      width: candidate.width,
      height: candidate.height,
      qualityLabel: candidate.qualityLabel,
      sizeBytes:
        typeof candidate.sizeBytes === 'number' &&
        Number.isSafeInteger(candidate.sizeBytes) &&
        candidate.sizeBytes > 0
          ? candidate.sizeBytes
          : null,
      contentType:
        candidate.contentType === 'video/mp4' || candidate.contentType === 'video/webm'
          ? candidate.contentType
          : null,
      ...(candidate.usePageHeaders === true ? { usePageHeaders: true } : {}),
      current: true
    })
    for (var index = 0; index < previous.length; index += 1) {
      var entry = previous[index]
      if (!entry || entry.url === candidate.url) continue
      next.push({
        url: entry.url,
        filename: entry.filename,
        container: entry.container,
        width: entry.width,
        height: entry.height,
        qualityLabel: entry.qualityLabel,
        sizeBytes:
          typeof entry.sizeBytes === 'number' &&
          Number.isSafeInteger(entry.sizeBytes) &&
          entry.sizeBytes > 0
            ? entry.sizeBytes
            : null,
        contentType:
          entry.contentType === 'video/mp4' || entry.contentType === 'video/webm'
            ? entry.contentType
            : null,
        ...(entry.usePageHeaders === true ? { usePageHeaders: true } : {}),
        current: false
      })
      if (next.length >= MAX_CAPTURED_SOURCES_PER_PLAYER) break
    }
    return next
  }

  function currentCapturedSource(sources) {
    if (!Array.isArray(sources) || sources.length === 0) return null
    for (var index = 0; index < sources.length; index += 1) {
      if (sources[index] && sources[index].current === true) return sources[index]
    }
    return sources[0] || null
  }

  /**
   * The explicit analysis action is offered exactly when there is no verified
   * progressive source for the attached player (blob/MSE, a manifest or no
   * playback at all). Progressive sources always stay first and keep their
   * one-click behaviour.
   */
  function shouldOfferPageAnalysis(sources, unsupported) {
    if (!Array.isArray(sources) || sources.length === 0) return true
    return Boolean(unsupported)
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
      MEDIA_UNSUPPORTED_LIVE:
        'This is a live stream. Download it after it ends (as a VOD).',
      MEDIA_UNSUPPORTED_MEDIA:
        'This page does not expose a supported video that DonDownload can download.',
      MEDIA_DRM_PROTECTED:
        "This video is DRM-protected and can't be downloaded.",
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
        'Progressive files this exact player actually played appear first. On sites where you enabled the overlay, DonDownload may analyze this page in the background when a player uses HLS, DASH or Media Source, so verified qualities are ready when you open this panel. It never reads request headers, cookies or DRM data.',
      actionLabel: 'Find qualities with DonDownload',
      analyzingLabel: 'Finding qualities…',
      embedActionLabel: 'Find qualities for embedded video',
      optionsHint:
        'Nothing is downloaded until you choose a source or a verified option.',
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

  /**
   * True only when a MutationObserver batch can change what the overlay shows.
   *
   * The observer watches the whole document for childList changes, but a busy
   * page also rewrites unrelated text, ads, tickers and analytics nodes. The
   * overlay only cares about a player appearing or leaving. `records` is
   * omitted by older test doubles, in which case the pass is kept (fail open).
   */
  function mutationRecordsAreRelevant(records) {
    if (!Array.isArray(records) || records.length === 0) return true
    for (var index = 0; index < records.length; index += 1) {
      var record = records[index]
      if (!record || record.type !== 'childList') continue
      if (nodeListHasPlayer(record.addedNodes)) return true
      if (nodeListHasPlayer(record.removedNodes)) return true
    }
    return false
  }

  function nodeListHasPlayer(nodes) {
    if (!nodes || typeof nodes.length !== 'number') return false
    for (var index = 0; index < nodes.length; index += 1) {
      if (nodeHasPlayer(nodes[index])) return true
    }
    return false
  }

  function nodeHasPlayer(node) {
    if (!node) return false
    var tag = typeof node.tagName === 'string' ? node.tagName.toUpperCase() : ''
    if (tag === 'VIDEO' || tag === 'IFRAME' || tag === 'SOURCE') return true
    if (typeof node.querySelector !== 'function') return false
    try {
      return node.querySelector('video, iframe, source') !== null
    } catch {
      return false
    }
  }

  var api = Object.freeze({
    BUTTON_SIZE: BUTTON_SIZE,
    EDGE_INSET: EDGE_INSET,
    MIN_VIDEO_WIDTH: MIN_VIDEO_WIDTH,
    MIN_VIDEO_HEIGHT: MIN_VIDEO_HEIGHT,
    MIN_IFRAME_WIDTH: MIN_IFRAME_WIDTH,
    MIN_IFRAME_HEIGHT: MIN_IFRAME_HEIGHT,
    SHORTCUT_LABEL: SHORTCUT_LABEL,
    MEDIA_SIZE_UNKNOWN: MEDIA_SIZE_UNKNOWN,
    evaluateVideoCandidate: evaluateVideoCandidate,
    intersectRects: intersectRects,
    chooseAnchor: chooseAnchor,
    findVideoInPath: findVideoInPath,
    evaluateIframeCandidate: evaluateIframeCandidate,
    findIframeInPath: findIframeInPath,
    placeTrigger: placeTrigger,
    placePanel: placePanel,
    nextActiveVideo: nextActiveVideo,
    mutationRecordsAreRelevant: mutationRecordsAreRelevant,
    isTriggerReady: isTriggerReady,
    largestTriggerCandidate: largestTriggerCandidate,
    prefetchDecision: prefetchDecision,
    prefetchResultApplies: prefetchResultApplies,
    isStreamingUnsupported: isStreamingUnsupported,
    isOptionQueued: isOptionQueued,
    markOptionQueued: markOptionQueued,
    PREFETCH_DEBOUNCE_MS: PREFETCH_DEBOUNCE_MS,
    PREFETCH_MAX_AGE_MS: PREFETCH_MAX_AGE_MS,
    isTypingTarget: isTypingTarget,
    isOverlayShortcut: isOverlayShortcut,
    initialMediaState: initialMediaState,
    normalizeCapturedSourceUrl: normalizeCapturedSourceUrl,
    capturedSourceFilename: capturedSourceFilename,
    evaluatePlaybackSource: evaluatePlaybackSource,
    applyNetworkEvidence: applyNetworkEvidence,
    addCapturedSource: addCapturedSource,
    currentCapturedSource: currentCapturedSource,
    shouldOfferPageAnalysis: shouldOfferPageAnalysis,
    optionById: optionById,
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

  /* eslint-disable no-undef -- overlay-core.js also exports through CommonJS when loaded by Node tests */
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api
  }
  /* eslint-enable no-undef */
  if (typeof globalThis !== 'undefined') {
    globalThis.DonDownloadOverlayCore = api
  }
})()
