// Tiny all-sites bootstrap for the optional video overlay.
//
// The broad all-sites registration injects this file only. It does not create a
// shadow DOM, a MutationObserver, a ResizeObserver, a timer or a storage read.
// It waits for a real signal that this page uses a player (a video in the DOM,
// a media `play` event, or a pointer over a video/iframe) and then asks the
// service worker to load the full overlay files into this tab.
//
// The popup and the toolbar shortcut send `dondownload:overlay-ensure` first, so
// their existing messages are answered by the full overlay exactly as before.
// Once the full overlay is present this bootstrap removes its own listeners and
// every later message is handled by the overlay runtime.

;(function () {
  'use strict'

  var globalState = globalThis
  if (globalState.__dondownloadOverlayBootstrap) return
  globalState.__dondownloadOverlayBootstrap = true

  var ENSURE = 'dondownload:overlay-ensure'
  var TOGGLE = 'dondownload:overlay-toggle'
  var DISABLED = 'dondownload:overlay-disabled'
  var READY = 'dondownload:overlay-ready'
  // Signals that can tell us a video exists before any pointer reaches it.
  var MEDIA_EVENTS = ['play', 'playing', 'loadedmetadata']

  var loaded = false
  var loading = false
  var disabled = false
  var pendingTarget = null
  var waiters = []
  var listeners = []
  var runtimeListener = null

  function runtimeAvailable() {
    return Boolean(chrome && chrome.runtime)
  }

  /**
   * True once the full overlay has installed itself, no matter which path did
   * it (bootstrap ensure, popup enable, or a per-origin registration). The
   * bootstrap must then disappear so a toggle/message is not handled twice.
   */
  function fullOverlayActive() {
    var ns = globalThis.DonDownloadOverlay
    var runtime = globalThis.__dondownloadOverlayRuntime
    return Boolean(
      ns &&
        ns.started === true &&
        runtime &&
        runtime.active === true &&
        runtime.disabled !== true
    )
  }

  function stopIfFullOverlayActive() {
    if (!fullOverlayActive()) return false
    loaded = true
    finishWaiters()
    cleanup()
    return true
  }

  function on(target, type, listener) {
    if (!target || typeof target.addEventListener !== 'function') return
    target.addEventListener(type, listener, true)
    listeners.push(function () {
      try {
        target.removeEventListener(type, listener, true)
      } catch {
        // Best effort while tearing down.
      }
    })
  }

  function eventPath(event) {
    if (event && typeof event.composedPath === 'function') {
      var path = event.composedPath()
      if (Array.isArray(path)) return path
    }
    var nodes = []
    var node = event && event.target ? event.target : null
    while (node && nodes.length < 64) {
      nodes.push(node)
      node = node.parentNode || null
    }
    return nodes
  }

  function tagOf(node) {
    return node && typeof node.tagName === 'string'
      ? node.tagName.toUpperCase()
      : ''
  }

  function largeEnough(node, minimumWidth, minimumHeight) {
    if (!node || typeof node.getBoundingClientRect !== 'function') return true
    try {
      var rect = node.getBoundingClientRect()
      return rect.width >= minimumWidth && rect.height >= minimumHeight
    } catch {
      return true
    }
  }

  function findPlayer(path) {
    var iframe = null
    for (var index = 0; index < path.length; index += 1) {
      var tag = tagOf(path[index])
      // The same minimum sizes the full overlay uses, checked before any
      // injection: a 1×1 tracking video or an ad iframe never loads the
      // overlay files.
      if (tag === 'VIDEO' && largeEnough(path[index], 120, 68)) {
        return path[index]
      }
      if (
        tag === 'IFRAME' &&
        iframe === null &&
        largeEnough(path[index], 240, 135)
      ) {
        iframe = path[index]
      }
    }
    return iframe
  }

  function cleanup() {
    for (var index = 0; index < listeners.length; index += 1) {
      try {
        listeners[index]()
      } catch {
        // The page may already have removed the target.
      }
    }
    listeners = []
    if (
      runtimeListener &&
      runtimeAvailable() &&
      chrome.runtime.onMessage &&
      typeof chrome.runtime.onMessage.removeListener === 'function'
    ) {
      try {
        chrome.runtime.onMessage.removeListener(runtimeListener)
      } catch {
        // Best effort.
      }
    }
    runtimeListener = null
    waiters = []
  }

  function reveal() {
    var target = pendingTarget
    pendingTarget = null
    var ns = globalThis.DonDownloadOverlay
    if (!ns || ns.started !== true) return
    try {
      if (target && target.isConnected !== false && tagOf(target) === 'VIDEO') {
        ns.showFor(target)
        return
      }
      if (target && target.isConnected !== false && tagOf(target) === 'IFRAME') {
        ns.showForEmbed(target)
        return
      }
      ns.syncFloatingTrigger()
    } catch {
      // A broken reveal must never break the page; the overlay is loaded.
    }
  }

  function finishWaiters() {
    var queued = waiters
    waiters = []
    for (var index = 0; index < queued.length; index += 1) {
      try {
        queued[index]()
      } catch {
        // One failed waiter never blocks the rest.
      }
    }
  }

  function requestLoad(target) {
    if (disabled) return
    if (stopIfFullOverlayActive()) return
    if (target) pendingTarget = target
    if (loaded) {
      reveal()
      return
    }
    if (loading) return
    if (!runtimeAvailable() || typeof chrome.runtime.sendMessage !== 'function') {
      return
    }

    loading = true
    try {
      chrome.runtime.sendMessage(
        { type: ENSURE, origin: location.origin },
        function (response) {
          loading = false
          void (chrome.runtime && chrome.runtime.lastError)
          if (disabled) return
          if (!response || response.ok !== true) {
            var code =
              response && response.error && typeof response.error.code === 'string'
                ? response.error.code
                : ''
            // These are stable answers, not a transient failure: retrying on
            // every hover would just message the worker again.
            if (
              code === 'EXCLUDED' ||
              code === 'INVALID_ORIGIN' ||
              code === 'PERMISSION_REQUIRED'
            ) {
              disabled = true
            }
            finishWaiters()
            if (disabled) cleanup()
            return
          }
          loaded = true
          reveal()
          finishWaiters()
          cleanup()
        }
      )
    } catch {
      loading = false
    }
  }

  function handleMediaEvent(event) {
    if (disabled || loaded) return
    if (stopIfFullOverlayActive()) return
    var player = findPlayer(eventPath(event))
    if (player) requestLoad(player)
  }

  function handleRuntimeMessage(message, sender, sendResponse) {
    if (stopIfFullOverlayActive()) return false
    var respond = typeof sendResponse === 'function' ? sendResponse : function () {}
    if (!message || typeof message !== 'object') return false

    if (message.type === DISABLED && message.origin === location.origin) {
      disabled = true
      cleanup()
      return false
    }

    if (message.type === TOGGLE) {
      requestLoad(null)
      if (loaded) {
        var ns = globalThis.DonDownloadOverlay
        respond({ ok: Boolean(ns && ns.handleToggleCommand()) })
        return false
      }
      waiters.push(function () {
        if (!loaded) {
          respond({
            ok: false,
            error: {
              code: 'OVERLAY_NOT_READY',
              message: 'The overlay could not be loaded on this page.'
            }
          })
          return
        }
        var runtime = globalThis.DonDownloadOverlay
        respond({ ok: Boolean(runtime && runtime.handleToggleCommand()) })
      })
      return true
    }

    if (message.type === ENSURE) {
      requestLoad(null)
      if (loaded) {
        respond({ ok: true, ready: true })
        return false
      }
      waiters.push(function () {
        respond(
          loaded
            ? { ok: true, ready: true }
            : {
                ok: false,
                error: {
                  code: 'OVERLAY_NOT_READY',
                  message: 'The overlay could not be loaded on this page.'
                }
              }
        )
      })
      return true
    }

    // Every other message belongs to the full overlay. The popup always sends
    // ENSURE first, so by the time one of those arrives the runtime listener is
    // installed; before that there is no panel to update.
    return false
  }

  function announceReady() {
    if (!runtimeAvailable() || typeof chrome.runtime.sendMessage !== 'function') return
    try {
      chrome.runtime.sendMessage(
        { type: READY, origin: location.origin },
        function () {
          void (chrome.runtime && chrome.runtime.lastError)
        }
      )
    } catch {
      // Announcement is best effort.
    }
  }

  // A video already rendered before document_idle is the strongest signal that
  // this page uses the overlay. No scan is repeated later: added players are
  // found from their own media events or from a pointer over them.
  var existing = null
  try {
    var firstVideo = document.querySelector ? document.querySelector('video') : null
    if (firstVideo && largeEnough(firstVideo, 120, 68)) existing = firstVideo
  } catch {
    // A document that refuses the query starts with no existing player.
  }

  // A per-origin registration or an earlier explicit enable may already have
  // loaded the full overlay. In that case this bootstrap has nothing to do.
  if (stopIfFullOverlayActive()) return

  for (var index = 0; index < MEDIA_EVENTS.length; index += 1) {
    on(document, MEDIA_EVENTS[index], handleMediaEvent)
  }
  on(document, 'pointerover', handleMediaEvent)

  if (
    runtimeAvailable() &&
    chrome.runtime.onMessage &&
    typeof chrome.runtime.onMessage.addListener === 'function'
  ) {
    runtimeListener = handleRuntimeMessage
    try {
      chrome.runtime.onMessage.addListener(runtimeListener)
    } catch {
      runtimeListener = null
    }
  }

  announceReady()
  if (existing) requestLoad(existing)
})()
