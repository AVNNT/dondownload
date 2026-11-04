// Optional, per-site video overlay. Injected only after the user grants the
// exact origin from the extension popup. This is a UI affordance only: it does
// not extract, sniff, decode or download media, and it never reads video
// source URLs or playback state.

;(function () {
  'use strict'

  var core = globalThis.DonDownloadOverlayCore
  if (!core) return

  var existingRuntime = globalThis.__dondownloadOverlayRuntime
  if (existingRuntime && existingRuntime.active) return

  var copy = core.unavailableState()

  var state = {
    active: true,
    disabled: false,
    disabling: false,
    host: null,
    shadow: null,
    trigger: null,
    panel: null,
    disableButton: null,
    status: null,
    activeVideo: null,
    panelOpen: false,
    hideTimer: 0,
    repositionPending: false,
    mutationObserver: null,
    resizeObserver: null,
    runtimeListener: null,
    cleanup: []
  }

  globalThis.__dondownloadOverlayRuntime = state

  var STYLES = [
    ':host { all: initial; }',
    '[hidden] { display: none !important; }',
    '.trigger {',
    '  position: fixed;',
    '  align-items: center;',
    '  justify-content: center;',
    '  width: 30px;',
    '  height: 30px;',
    '  margin: 0;',
    '  padding: 0;',
    '  border: 1px solid #3a3a3a;',
    '  border-radius: 8px;',
    '  background: #000;',
    '  color: #fff;',
    '  cursor: pointer;',
    '  display: flex;',
    '  font: 700 10px/1 "Segoe UI", system-ui, sans-serif;',
    '  letter-spacing: 0.04em;',
    '  opacity: 0.94;',
    '  pointer-events: auto;',
    '  transition: opacity 120ms ease, border-color 120ms ease;',
    '  user-select: none;',
    '}',
    '.trigger:hover, .trigger:focus-visible {',
    '  border-color: #fff;',
    '  opacity: 1;',
    '  outline: 2px solid #fff;',
    '  outline-offset: 2px;',
    '}',
    '.panel {',
    '  position: fixed;',
    '  width: 292px;',
    '  max-height: calc(100vh - 16px);',
    '  overflow: auto;',
    '  padding: 14px;',
    '  border: 1px solid #2c2c2c;',
    '  border-radius: 10px;',
    '  background: #000;',
    '  color: #f4f4f5;',
    '  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.78);',
    '  box-sizing: border-box;',
    '  color-scheme: dark;',
    '  font: 12px/1.5 "Segoe UI", system-ui, sans-serif;',
    '  pointer-events: auto;',
    '  text-align: left;',
    '}',
    '.panel:focus { outline: 2px solid #fff; outline-offset: 2px; }',
    '.panel-head {',
    '  align-items: center;',
    '  display: flex;',
    '  gap: 8px;',
    '  justify-content: space-between;',
    '  margin-bottom: 10px;',
    '}',
    '.panel-title { color: #fff; font-size: 13px; font-weight: 700; letter-spacing: 0.01em; }',
    '.panel-badge {',
    '  border: 1px solid #3a3a3a;',
    '  border-radius: 999px;',
    '  color: #a1a1aa;',
    '  font-size: 9px;',
    '  letter-spacing: 0.08em;',
    '  padding: 2px 7px;',
    '  text-transform: uppercase;',
    '}',
    '.panel-notice { color: #fff; font-size: 12.5px; font-weight: 650; line-height: 1.45; margin: 0 0 8px; }',
    '.panel-detail { color: #a1a1aa; font-size: 11.5px; line-height: 1.55; margin: 0 0 12px; }',
    '.unavailable {',
    '  background: #0b0b0c;',
    '  border: 1px solid #2c2c2c;',
    '  border-radius: 7px;',
    '  color: #71717a;',
    '  cursor: not-allowed;',
    '  font: inherit;',
    '  font-size: 12px;',
    '  padding: 8px 10px;',
    '  width: 100%;',
    '}',
    '.options { border-top: 1px solid #1f1f23; margin-top: 12px; padding-top: 10px; }',
    '.options summary { color: #d4d4d8; cursor: pointer; font-size: 11.5px; font-weight: 650; }',
    '.options-hint { color: #8b8b93; font-size: 11px; line-height: 1.5; margin: 8px 0; }',
    '.disable {',
    '  background: transparent;',
    '  border: 1px solid #3f3f46;',
    '  border-radius: 7px;',
    '  color: #e4e4e7;',
    '  cursor: pointer;',
    '  font: inherit;',
    '  font-size: 11.5px;',
    '  padding: 7px 9px;',
    '  width: 100%;',
    '}',
    '.disable:hover:not(:disabled) { background: #18181b; }',
    '.disable:disabled { cursor: not-allowed; opacity: 0.5; }',
    '.shortcut { color: #71717a; font-size: 10.5px; margin: 10px 0 0; }',
    '.status { color: #fca5a5; font-size: 11px; line-height: 1.45; margin: 8px 0 0; }',
    '.status:empty { display: none; }',
    '@media (prefers-reduced-motion: reduce) {',
    '  .trigger { transition: none !important; }',
    '  .panel { animation: none !important; }',
    '}'
  ].join('\n')

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

  function candidateFor(video) {
    return {
      tagName: video.tagName,
      isConnected: video.isConnected,
      hidden: video.hidden,
      rect: video.getBoundingClientRect(),
      styles: readStyles(video)
    }
  }

  function usable(video) {
    return core.evaluateVideoCandidate(candidateFor(video), viewport())
  }

  function eventPath(event) {
    if (event && typeof event.composedPath === 'function') {
      var path = event.composedPath()
      return Array.isArray(path) ? path : []
    }
    return event && event.target ? [event.target] : []
  }

  function pathIncludesOverlay(event) {
    if (!state.host) return false
    return eventPath(event).indexOf(state.host) !== -1
  }

  function ensureUi() {
    if (state.host || state.disabled) return

    var host = document.createElement('div')
    host.id = 'dondownload-overlay-host'
    host.setAttribute('data-dondownload-overlay', '')
    host.style.position = 'fixed'
    host.style.left = '0'
    host.style.top = '0'
    host.style.width = '0'
    host.style.height = '0'
    host.style.zIndex = '2147483647'
    host.hidden = true

    var shadow = host.attachShadow({ mode: 'open' })

    var style = document.createElement('style')
    style.textContent = STYLES
    shadow.appendChild(style)

    var trigger = createElement('button', 'trigger', 'DD')
    trigger.type = 'button'
    trigger.hidden = true
    trigger.setAttribute('title', 'DonDownload video options (' + copy.shortcutLabel + ')')
    trigger.setAttribute('aria-label', 'DonDownload video options')
    trigger.setAttribute('aria-haspopup', 'dialog')
    trigger.setAttribute('aria-expanded', 'false')

    var panel = createElement('div', 'panel')
    panel.hidden = true
    panel.tabIndex = -1
    panel.setAttribute('role', 'dialog')
    panel.setAttribute('aria-label', 'DonDownload video options')

    var head = createElement('div', 'panel-head')
    head.appendChild(createElement('strong', 'panel-title', 'DonDownload'))
    head.appendChild(createElement('span', 'panel-badge', 'UI only'))

    var action = createElement('button', 'unavailable', copy.actionLabel)
    action.type = 'button'
    action.disabled = true
    action.setAttribute('aria-disabled', 'true')

    var options = document.createElement('details')
    options.className = 'options'
    options.appendChild(createElement('summary', '', 'Options'))
    options.appendChild(createElement('p', 'options-hint', copy.optionsHint))

    var disableButton = createElement('button', 'disable', copy.disableLabel)
    disableButton.type = 'button'
    options.appendChild(disableButton)

    var status = createElement('p', 'status', '')
    status.setAttribute('role', 'status')
    status.setAttribute('aria-live', 'polite')

    panel.appendChild(head)
    panel.appendChild(createElement('p', 'panel-notice', copy.title))
    panel.appendChild(createElement('p', 'panel-detail', copy.detail))
    panel.appendChild(action)
    panel.appendChild(options)
    panel.appendChild(status)
    panel.appendChild(
      createElement('p', 'shortcut', 'Keyboard: ' + copy.shortcutLabel + ' shows this button.')
    )

    shadow.appendChild(trigger)
    shadow.appendChild(panel)

    var parent = document.fullscreenElement || document.documentElement
    parent.appendChild(host)

    state.host = host
    state.shadow = shadow
    state.trigger = trigger
    state.panel = panel
    state.disableButton = disableButton
    state.status = status

    on(trigger, 'pointerdown', stopPointerEvent)
    on(trigger, 'click', function (event) {
      stopPlayerEvent(event)
      togglePanel()
    })
    on(trigger, 'pointerenter', cancelHide)
    on(trigger, 'pointerleave', scheduleHide)

    on(panel, 'pointerdown', stopPointerEvent)
    on(panel, 'click', stopPlayerEvent)
    on(panel, 'pointerenter', cancelHide)
    on(panel, 'pointerleave', scheduleHide)
    on(panel, 'keydown', function (event) {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      closePanel(true)
    })
    on(disableButton, 'click', function (event) {
      stopPlayerEvent(event)
      disableSite()
    })
  }

  function stopPointerEvent(event) {
    // Do not preventDefault on pointerdown: that can suppress the follow-up
    // click event and make the overlay button feel dead.
    if (!event) return
    if (typeof event.stopPropagation === 'function') event.stopPropagation()
  }

  function stopPlayerEvent(event) {
    if (!event) return
    if (typeof event.stopPropagation === 'function') event.stopPropagation()
    if (typeof event.preventDefault === 'function') event.preventDefault()
  }

  function cancelHide() {
    if (!state.hideTimer) return
    window.clearTimeout(state.hideTimer)
    state.hideTimer = 0
  }

  function scheduleHide() {
    if (state.panelOpen) return
    cancelHide()
    state.hideTimer = window.setTimeout(function () {
      state.hideTimer = 0
      if (state.panelOpen) return
      hideNow()
    }, 320)
  }

  function showFor(video) {
    if (state.disabled || !video) return
    ensureUi()
    if (!state.host) return

    var result = usable(video)
    if (!result.usable) {
      if (video === state.activeVideo) hideNow()
      return
    }

    if (state.activeVideo && state.activeVideo !== video) closePanel(false)
    state.activeVideo = video
    observeVideoSize(video)
    cancelHide()
    state.host.hidden = false
    state.trigger.hidden = false
    position()
  }

  function hideNow() {
    cancelHide()
    if (state.panelOpen) closePanel(false)
    state.activeVideo = null
    if (state.resizeObserver) state.resizeObserver.disconnect()
    if (state.trigger) state.trigger.hidden = true
    if (state.host) state.host.hidden = true
  }

  function togglePanel() {
    if (state.panelOpen) {
      closePanel(true)
    } else {
      openPanel()
    }
  }

  function openPanel() {
    if (!state.panel || !state.trigger || state.trigger.hidden) return
    cancelHide()
    state.panel.hidden = false
    state.panelOpen = true
    state.trigger.setAttribute('aria-expanded', 'true')
    position()
    if (typeof state.panel.focus === 'function') {
      try {
        state.panel.focus({ preventScroll: true })
      } catch {
        state.panel.focus()
      }
    }
  }

  function closePanel(refocusTrigger) {
    if (!state.panel) return
    var wasOpen = state.panelOpen
    state.panelOpen = false
    state.panel.hidden = true
    if (state.trigger) state.trigger.setAttribute('aria-expanded', 'false')
    if (wasOpen && refocusTrigger && state.trigger && !state.trigger.hidden) {
      try {
        state.trigger.focus({ preventScroll: true })
      } catch {
        state.trigger.focus()
      }
    }
  }

  function position() {
    if (state.disabled || !state.activeVideo || !state.trigger || state.trigger.hidden) {
      return
    }

    var result = usable(state.activeVideo)
    if (!result.usable) {
      hideNow()
      return
    }

    var triggerRect = core.placeTrigger(state.activeVideo.getBoundingClientRect(), viewport())
    if (!triggerRect) {
      hideNow()
      return
    }
    state.trigger.style.left = triggerRect.left + 'px'
    state.trigger.style.top = triggerRect.top + 'px'

    if (!state.panelOpen || !state.panel) return
    var panelRect = state.panel.getBoundingClientRect()
    var panelPlacement = core.placePanel(triggerRect, viewport(), {
      width: panelRect.width,
      height: panelRect.height
    })
    if (!panelPlacement) return
    state.panel.style.left = panelPlacement.left + 'px'
    state.panel.style.top = panelPlacement.top + 'px'
    state.panel.style.width = panelPlacement.width + 'px'
    state.panel.setAttribute('data-placement', panelPlacement.placement)
  }

  function scheduleReposition() {
    if (state.repositionPending) return
    state.repositionPending = true
    var run = function () {
      state.repositionPending = false
      position()
    }
    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(run)
    } else {
      window.setTimeout(run, 16)
    }
  }

  function observeVideoSize(video) {
    if (typeof ResizeObserver !== 'function') return
    if (!state.resizeObserver) {
      state.resizeObserver = new ResizeObserver(scheduleReposition)
    }
    state.resizeObserver.disconnect()
    state.resizeObserver.observe(video)
  }

  function observeMutations() {
    if (typeof MutationObserver !== 'function' || !document.documentElement) return
    state.mutationObserver = new MutationObserver(function () {
      if (!state.activeVideo) return
      var next = core.nextActiveVideo(state.activeVideo)
      if (!next) {
        hideNow()
        return
      }
      scheduleReposition()
    })
    state.mutationObserver.observe(document.documentElement, {
      childList: true,
      subtree: true
    })
  }

  function largestUsableVideo() {
    if (typeof document.querySelectorAll !== 'function') return null
    var videos = document.querySelectorAll('video')
    var best = null
    var bestArea = 0
    for (var index = 0; index < videos.length; index += 1) {
      var video = videos[index]
      var result = usable(video)
      if (!result.usable) continue
      var rect = video.getBoundingClientRect()
      var area = rect.width * rect.height
      if (area > bestArea) {
        bestArea = area
        best = video
      }
    }
    return best
  }

  function disableSite() {
    if (state.disabled || state.disabling) return
    state.disabling = true
    if (state.disableButton) state.disableButton.disabled = true
    if (state.status) {
      state.status.textContent = 'Turning off the overlay for this site…'
    }

    try {
      chrome.runtime.sendMessage(
        {
          type: 'dondownload:overlay-disable-site',
          origin: location.origin
        },
        function (response) {
          var runtimeError = chrome.runtime && chrome.runtime.lastError
          if (runtimeError || !response || response.ok !== true) {
            state.disabling = false
            if (state.disableButton) state.disableButton.disabled = false
            if (state.status) {
              state.status.textContent =
                'The overlay could not be turned off. Reload the page and try again.'
            }
            return
          }
          teardown()
        }
      )
    } catch {
      state.disabling = false
      if (state.disableButton) state.disableButton.disabled = false
      if (state.status) {
        state.status.textContent =
          'The overlay could not be turned off. Reload the page and try again.'
      }
    }
  }

  function teardown() {
    if (!state.active) return
    state.disabled = true
    state.active = false
    cancelHide()
    if (state.mutationObserver) state.mutationObserver.disconnect()
    if (state.resizeObserver) state.resizeObserver.disconnect()
    if (
      state.runtimeListener &&
      chrome &&
      chrome.runtime &&
      chrome.runtime.onMessage &&
      typeof chrome.runtime.onMessage.removeListener === 'function'
    ) {
      chrome.runtime.onMessage.removeListener(state.runtimeListener)
    }
    state.runtimeListener = null
    for (var index = 0; index < state.cleanup.length; index += 1) {
      try {
        state.cleanup[index]()
      } catch {
        // Cleanup is best effort; the overlay is being removed anyway.
      }
    }
    state.cleanup = []
    state.activeVideo = null
    state.panelOpen = false
    if (state.host && state.host.parentNode) state.host.parentNode.removeChild(state.host)
    state.host = null
    state.shadow = null
    state.trigger = null
    state.panel = null
    state.disableButton = null
    state.status = null
    if (globalThis.__dondownloadOverlayRuntime === state) {
      globalThis.__dondownloadOverlayRuntime = null
    }
  }

  function handlePointerOver(event) {
    if (state.disabled) return
    if (pathIncludesOverlay(event)) {
      cancelHide()
      return
    }
    var video = core.findVideoInPath(eventPath(event))
    if (!video) return
    if (video === state.activeVideo) {
      cancelHide()
      return
    }
    showFor(video)
  }

  function handlePointerOut(event) {
    if (state.disabled || !state.activeVideo) return
    var video = core.findVideoInPath(eventPath(event))
    if (video !== state.activeVideo) return
    var related = event.relatedTarget
    if (related && state.host && (related === state.host || state.host.contains(related))) {
      cancelHide()
      return
    }
    scheduleHide()
  }

  function handleDocumentPointerDown(event) {
    if (!state.panelOpen || pathIncludesOverlay(event)) return
    closePanel(false)
  }

  function handleFullscreenChange() {
    if (!state.host) return
    var parent = document.fullscreenElement || document.documentElement
    if (state.host.parentNode !== parent) parent.appendChild(state.host)
    scheduleReposition()
  }

  function handleKeydown(event) {
    if (state.disabled || event.defaultPrevented) return
    if (!core.isOverlayShortcut(event)) return
    if (core.isTypingTarget(event.target)) return
    var video = largestUsableVideo()
    if (!video) return
    event.preventDefault()
    event.stopPropagation()
    showFor(video)
    if (state.trigger) state.trigger.focus()
  }

  function installListeners() {
    on(document, 'pointerover', handlePointerOver, true)
    on(document, 'pointerout', handlePointerOut, true)
    on(document, 'pointerdown', handleDocumentPointerDown, true)
    on(document, 'fullscreenchange', handleFullscreenChange, true)
    on(document, 'keydown', handleKeydown, true)
    on(window, 'scroll', scheduleReposition, { capture: true, passive: true })
    on(window, 'resize', scheduleReposition, { passive: true })
    if (window.visualViewport) {
      on(window.visualViewport, 'resize', scheduleReposition, { passive: true })
      on(window.visualViewport, 'scroll', scheduleReposition, { passive: true })
    }
  }

  function installRuntimeListener() {
    if (!chrome || !chrome.runtime || !chrome.runtime.onMessage) return
    if (typeof chrome.runtime.onMessage.addListener !== 'function') return
    state.runtimeListener = function (message) {
      // An external revoke sends this to tracked tabs. Only the exact origin
      // that was revoked may tear down; a reused/stale tab id is harmless.
      if (
        message &&
        message.type === 'dondownload:overlay-disabled' &&
        message.origin === location.origin
      ) {
        teardown()
      }
      return false
    }
    chrome.runtime.onMessage.addListener(state.runtimeListener)
  }

  // Announce this document so the worker can remember the tab for teardown
  // when the user revokes the origin outside the popup. If the grant is already
  // gone, the worker sends the disabled message straight back.
  function announceReady() {
    if (!chrome || !chrome.runtime) return
    if (typeof chrome.runtime.sendMessage !== 'function') return
    try {
      chrome.runtime.sendMessage(
        { type: 'dondownload:overlay-ready', origin: location.origin },
        function () {
          // Read lastError so a closed channel is not reported as unchecked.
          if (chrome.runtime) void chrome.runtime.lastError
        }
      )
    } catch {
      // Announcement is best effort; the overlay itself is already installed.
    }
  }

  try {
    ensureUi()
    installListeners()
    observeMutations()
    installRuntimeListener()
    announceReady()
  } catch {
    // Fail closed: a broken overlay must never interfere with the page player.
    state.disabled = true
  }
})()
