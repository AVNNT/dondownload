// Shared state, message types and small helpers for the optional per-site
// video overlay. Loaded as a classic content script after overlay-core.js and
// before the UI, quality and capture files, all in the same isolated world.
// The namespace guard makes a second injection a no-op.

;(function () {
  'use strict'

  var existingRuntime = globalThis.__dondownloadOverlayRuntime
  if (existingRuntime && existingRuntime.active) return

  var core = globalThis.DonDownloadOverlayCore
  if (!core) return

  var ns = globalThis.DonDownloadOverlay || (globalThis.DonDownloadOverlay = {})
  if (ns.started) return
  ns.started = false
  ns.core = core

  var copy = core.initialMediaState
    ? core.initialMediaState()
    : core.unavailableState()
  ns.copy = copy

  var MEDIA_ANALYZE = 'dondownload:media-analyze'
  var MEDIA_ANALYZE_EMBED = 'dondownload:media-analyze-embed'
  var MEDIA_QUEUE = 'dondownload:media-queue'
  var MEDIA_PAGE_ANALYZE = 'dondownload:media-page-analyze'
  var MEDIA_PAGE_QUEUE = 'dondownload:media-page-queue'
  var CAPTURE_QUEUE = 'dondownload:capture-queue'
  var NETWORK_EVIDENCE_REQUEST = 'dondownload:network-evidence-request'
  var NETWORK_EVIDENCE = 'dondownload:network-evidence'
  var SNIFFED_QUERY = 'dondownload:sniffed-query'
  var SNIFFED_QUEUE = 'dondownload:sniffed-queue'
  var SNIFFED_CHANGED = 'dondownload:sniffed-changed'

  ns.MEDIA_ANALYZE = MEDIA_ANALYZE
  ns.MEDIA_ANALYZE_EMBED = MEDIA_ANALYZE_EMBED
  ns.MEDIA_QUEUE = MEDIA_QUEUE
  ns.MEDIA_PAGE_ANALYZE = MEDIA_PAGE_ANALYZE
  ns.MEDIA_PAGE_QUEUE = MEDIA_PAGE_QUEUE
  ns.CAPTURE_QUEUE = CAPTURE_QUEUE
  ns.NETWORK_EVIDENCE_REQUEST = NETWORK_EVIDENCE_REQUEST
  ns.NETWORK_EVIDENCE = NETWORK_EVIDENCE
  ns.SNIFFED_QUERY = SNIFFED_QUERY
  ns.SNIFFED_QUEUE = SNIFFED_QUEUE
  ns.SNIFFED_CHANGED = SNIFFED_CHANGED

  var state = {
    active: true,
    disabled: false,
    disabling: false,
    host: null,
    shadow: null,
    trigger: null,
    panel: null,
    analyzeButton: null,
    embedAnalyzeButton: null,
    sniffedSection: null,
    sniffedList: null,
    sniffedEmpty: null,
    sourceSection: null,
    sourceList: null,
    sourceEmpty: null,
    mediaResults: null,
    mediaTitle: null,
    mediaMeta: null,
    bestVideoButton: null,
    bestAudioButton: null,
    qualityFieldset: null,
    qualityList: null,
    simpleFieldset: null,
    advancedQualityList: null,
    outputFormatSelect: null,
    outputFormatControl: null,
    queueSelectedButton: null,
    disableButton: null,
    status: null,
    activeVideo: null,
    activeEmbed: null,
    panelOpen: false,
    hideTimer: 0,
    repositionPending: false,
    triggerBurst: false,
    floatingEnabled: true,
    settingsListener: null,
    mutationObserver: null,
    resizeObserver: null,
    runtimeListener: null,
    navigationTimer: 0,
    cleanup: [],
    media: {
      token: 0,
      queueToken: 0,
      status: 'idle',
      analysis: null,
      selectedOptionId: null,
      outputFormat: 'auto',
      queuedOptionIds: []
    },
    prefetch: {
      url: '',
      status: 'idle',
      token: 0,
      timer: 0,
      startedAt: 0,
      expiresAt: 0,
      analysis: null,
      error: null
    },
    capture: {
      navigationUrl: location.href,
      players: [],
      buttons: [],
      rowCleanups: [],
      queuedUrls: [],
      queueing: false,
      queueToken: 0,
      sniffed: [],
      sniffedQueued: [],
      sniffedRowCleanups: [],
      sniffedButtons: [],
      sniffedToken: 0
    }
  }

  globalThis.__dondownloadOverlayRuntime = state
  ns.state = state

  // Keep at most one passive listener set per media element across SPA
  // navigations; resetting the source list must not stack duplicate listeners.
  var observedVideos =
    typeof WeakSet === 'function' ? new WeakSet() : null
  ns.observedVideos = observedVideos
  // After an SPA URL change, a reused <video> can still report the previous
  // page's currentSrc for one tick. Suppress exactly that value once so it is
  // never re-added as if it belonged to the new page.
  var suppressedSources =
    typeof WeakMap === 'function' ? new WeakMap() : null
  ns.suppressedSources = suppressedSources

  function createElement(tag, className, text) {
    var node = document.createElement(tag)
    if (className) node.className = className
    if (typeof text === 'string') node.textContent = text
    return node
  }


  function on(target, type, listener, options) {
    if (!target || typeof target.addEventListener !== 'function') return
    target.addEventListener(type, listener, options)
    state.cleanup.push(function () {
      if (typeof target.removeEventListener === 'function') {
        target.removeEventListener(type, listener, options)
      }
    })
  }


  function viewport() {
    var width = window.innerWidth || document.documentElement.clientWidth || 0
    var height = window.innerHeight || document.documentElement.clientHeight || 0
    return { width: width, height: height }
  }


  function readStyles(video) {
    if (typeof getComputedStyle !== 'function') return null
    var computed = getComputedStyle(video)
    if (!computed) return null
    return {
      display: computed.display,
      visibility: computed.visibility,
      opacity: computed.opacity
    }
  }


  function rectFor(element) {
    var rect = element.getBoundingClientRect()
    var tag = String(element.tagName || '').toUpperCase()
    if (tag !== 'VIDEO') return rect
    var hasSource =
      typeof element.currentSrc === 'string' && element.currentSrc.length > 0
    // A KVS-style player can create the video with no source and zero inline
    // size until play. Its visible wrapper is the real player surface, and a
    // transparent click-catcher may hide the video from pointer hit-testing.
    if (
      !hasSource &&
      element.readyState === 0 &&
      (rect.width < 120 || rect.height < 68)
    ) {
      var node = element.parentElement
      while (node && node !== document.documentElement) {
        var candidate = node.getBoundingClientRect()
        if (candidate.width >= 120 && candidate.height >= 68) return candidate
        node = node.parentElement
      }
    }
    return rect
  }


  function candidateFor(video) {
    return {
      tagName: video.tagName,
      isConnected: video.isConnected,
      hidden: video.hidden,
      rect: rectFor(video),
      styles: readStyles(video)
    }
  }


  function clampNumber(value, minimum, maximum) {
    return Math.min(Math.max(value, minimum), maximum)
  }


  function storageFor(area) {
    if (!chrome || !chrome.storage) return null
    return chrome.storage[area] || null
  }


  function setMediaStatus(text, kind) {
    if (!state.status) return
    state.status.textContent = text || ''
    state.status.className = kind ? 'status ' + kind : 'status'
  }


  function sendRuntimeMessage(message, callback) {
    if (!chrome || !chrome.runtime || typeof chrome.runtime.sendMessage !== 'function') {
      callback(null, { message: 'The DonDownload background worker is unavailable.' })
      return
    }
    try {
      chrome.runtime.sendMessage(message, function (response) {
        var runtimeError = chrome.runtime && chrome.runtime.lastError
        callback(response, runtimeError)
      })
    } catch (error) {
      callback(null, error)
    }
  }


  ns.createElement = createElement
  ns.on = on
  ns.viewport = viewport
  ns.readStyles = readStyles
  ns.candidateFor = candidateFor
  ns.rectFor = rectFor
  ns.clampNumber = clampNumber
  ns.storageFor = storageFor
  ns.setMediaStatus = setMediaStatus
  ns.sendRuntimeMessage = sendRuntimeMessage
})()
