// Entry point and runtime glue for the optional per-site video overlay.
// Loaded last, after overlay-core.js and the runtime/UI/quality/capture files.
// It installs the runtime message listener and starts the overlay, and still
// fails closed: a broken overlay never interferes with the page player.
;(function () {
  'use strict'

  var ns = globalThis.DonDownloadOverlay
  if (!ns || ns.started) return
  ns.started = true

  var state = ns.state

  function teardown() {
    if (!state.active) return
    state.disabled = true
    state.active = false
    ns.cancelHide()
    ns.clearPrefetchTimer()
    if (state.navigationTimer) {
      try {
        window.clearInterval(state.navigationTimer)
      } catch {
        // Best effort.
      }
      state.navigationTimer = 0
    }
    if (state.mutationTimer) {
      try {
        window.clearTimeout(state.mutationTimer)
      } catch {
        // Best effort.
      }
      state.mutationTimer = 0
    }
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
    if (
      state.settingsListener &&
      chrome &&
      chrome.storage &&
      chrome.storage.onChanged &&
      typeof chrome.storage.onChanged.removeListener === 'function'
    ) {
      chrome.storage.onChanged.removeListener(state.settingsListener)
    }
    state.settingsListener = null
    for (var index = 0; index < state.cleanup.length; index += 1) {
      try {
        state.cleanup[index]()
      } catch {
        // Cleanup is best effort; the overlay is being removed anyway.
      }
    }
    state.cleanup = []
    state.activeVideo = null
    state.activeEmbed = null
    state.panelOpen = false
    ns.releaseCapturePlayers()
    state.capture.players = []
    state.capture.buttons = []
    state.capture.rowCleanups = []
    state.capture.queueing = false
    state.capture.queueToken += 1
    state.media.token += 1
    state.media.queueToken += 1
    if (state.host && state.host.parentNode) state.host.parentNode.removeChild(state.host)
    state.host = null
    state.shadow = null
    state.trigger = null
    state.panel = null
    state.sniffedSection = null
    state.sniffedList = null
    state.sniffedEmpty = null
    state.sourceSection = null
    state.sourceList = null
    state.sourceEmpty = null
    state.analyzeButton = null
    state.embedAnalyzeButton = null
    state.mediaResults = null
    state.mediaTitle = null
    state.mediaMeta = null
    state.bestVideoButton = null
    state.bestAudioButton = null
    state.qualityFieldset = null
    state.qualityList = null
    state.simpleFieldset = null
    state.advancedQualityList = null
    state.outputFormatControl = null
    state.outputFormatSelect = null
    state.queueSelectedButton = null
    state.disableButton = null
    state.status = null
    if (globalThis.__dondownloadOverlayRuntime === state) {
      globalThis.__dondownloadOverlayRuntime = null
    }
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


  /**
   * All-sites mode injects this script into every http(s) page, so a page the
   * user excluded must never show the overlay. The exclusion list is a user
   * setting, so it is checked here at runtime and again whenever it changes.
   */
  function isExcludedSite(settings) {
    if (!settings || !Array.isArray(settings.excludedOrigins)) return false
    return settings.excludedOrigins.indexOf(location.origin) !== -1
  }


  function applyExclusions(settings) {
    if (isExcludedSite(settings)) {
      if (!state.disabled) teardown()
      return
    }
    if (state.disabled) {
      // The site was excluded and is no longer: a reload re-runs this script.
      return
    }
    state.floatingEnabled = !settings || settings.floatingTriggerEnabled !== false
    if (state.floatingEnabled) ns.syncFloatingTrigger()
  }


  function installRuntimeListener() {
    if (!chrome || !chrome.runtime || !chrome.runtime.onMessage) return
    if (typeof chrome.runtime.onMessage.addListener !== 'function') return
    state.runtimeListener = function (message, sender, sendResponse) {
      var respond = typeof sendResponse === 'function' ? sendResponse : function () {}
      // The all-sites bootstrap sends the popup/shortcut through this once. A
      // full overlay answers immediately; a torn-down one fails closed.
      if (message && message.type === 'dondownload:overlay-ensure') {
        if (state.disabled || state.active !== true) {
          respond({
            ok: false,
            error: {
              code: 'OVERLAY_NOT_READY',
              message: 'The overlay is not available on this page.'
            }
          })
          return false
        }
        respond({ ok: true, ready: true })
        return false
      }
      // An external revoke sends this to tracked tabs. Only the exact origin
      // that was revoked may tear down; a reused/stale tab id is harmless.
      if (
        message &&
        message.type === 'dondownload:overlay-disabled' &&
        message.origin === location.origin
      ) {
        teardown()
      }
      if (message && message.type === 'dondownload:overlay-toggle') {
        respond({ ok: ns.handleToggleCommand() })
        return false
      }
      if (message && message.type === 'dondownload:capture-query') {
        // A streaming player seen by the popup reuses the same debounced
        // background analysis. Opening the popup therefore never triggers a
        // second yt-dlp run when one is already cached or in flight. An embed
        // uses its own explicit embed analysis instead.
        var streaming = ns.streamingForQuery()
        if (streaming.detected && streaming.embedded !== true) {
          ns.schedulePrefetch(0)
        }
        respond(ns.captureQueryResponse(streaming))
        return false
      }
      if (message && message.type === ns.MEDIA_PAGE_ANALYZE) {
        if (ns.currentAnalysisView()) {
          respond({ ok: true, status: 'ready', analysis: ns.currentAnalysisView() })
          return false
        }
        if (state.activeEmbed) {
          ns.analyzeEmbeddedPage()
          respond({ ok: true, status: 'analyzing' })
          return false
        }
        if (!ns.prefetchInFlight()) {
          // Explicit retry from the popup. The worker still derives the URL
          // from the trusted sender tab; the popup never supplies one.
          ns.startPrefetch(ns.pageUrlKey(), {
            force: true,
            analyzingText: 'Finding qualities…'
          })
        }
        respond({ ok: true, status: 'analyzing' })
        return false
      }
      if (message && message.type === ns.MEDIA_PAGE_QUEUE) {
        var popupView = ns.currentAnalysisView()
        if (
          !popupView ||
          !message ||
          message.analysisId !== popupView.analysisId ||
          typeof message.optionId !== 'string'
        ) {
          respond({
            ok: false,
            error: {
              code: 'MEDIA_ANALYSIS_MISMATCH',
              message: 'That analysis is no longer current. Find qualities again.'
            }
          })
          return false
        }
        if (ns.optionIsQueued(message.optionId)) {
          respond({
            ok: false,
            error: { code: 'MEDIA_DUPLICATE_JOB', message: 'This option is already queued.' }
          })
          return false
        }
        ns.queueOption(message.optionId, respond)
        return true
      }
      if (message && message.type === 'dondownload:capture-download') {
        ns.downloadQueriedSource(message.url, respond)
        return true
      }
      if (message && message.type === ns.SNIFFED_CHANGED) {
        if (state.panelOpen) ns.refreshSniffedMedia()
        return false
      }
      if (message && message.type === ns.NETWORK_EVIDENCE) {
        if (typeof message.url === 'string') {
          ns.handleNetworkEvidence(message.url, message.evidence)
        }
        return false
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

  ns.isExcludedSite = isExcludedSite
  ns.applyExclusions = applyExclusions
  ns.teardown = teardown
  ns.disableSite = disableSite
  ns.installRuntimeListener = installRuntimeListener
  ns.announceReady = announceReady

  try {
    ns.ensureUi()
    ns.installListeners()
    ns.observeMutations()
    ns.installSourceObservers()
    installRuntimeListener()
    ns.installSettingsListener()
    ns.restoreCaptureSettings()
    ns.clearLegacyTriggerOffsets()
    // An excluded site never shows the overlay, even when all-sites mode
    // injected this script into it.
    try {
      var local = ns.storageFor('local')
      if (local && typeof local.get === 'function') {
        local.get('dondownloadCaptureSettings', function (stored) {
          if (chrome && chrome.runtime && chrome.runtime.lastError) return
          var settings = stored && stored.dondownloadCaptureSettings
          if (isExcludedSite(settings)) {
            teardown()
            return
          }
          ns.applyExclusions(settings)
        })
      }
    } catch {
      // Without settings the overlay stays on; the worker still skips it.
    }
    announceReady()
  } catch {
    // Fail closed: a broken overlay must never interfere with the page player.
    state.disabled = true
  }
})()
