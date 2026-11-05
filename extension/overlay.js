// Optional, per-site video overlay. Injected only after the user grants the
// exact origin from the extension popup or options page. The content script
// observes only an actual playing element's currentSrc after playback; it never
// reads request headers, cookies, MSE segments, resource timing or DRM data.

;(function () {
  'use strict'

  var core = globalThis.DonDownloadOverlayCore
  if (!core) return

  var existingRuntime = globalThis.__dondownloadOverlayRuntime
  if (existingRuntime && existingRuntime.active) return

  var copy = core.initialMediaState
    ? core.initialMediaState()
    : core.unavailableState()

  var MEDIA_ANALYZE = 'dondownload:media-analyze'
  var MEDIA_ANALYZE_EMBED = 'dondownload:media-analyze-embed'
  var MEDIA_QUEUE = 'dondownload:media-queue'
  var MEDIA_PAGE_ANALYZE = 'dondownload:media-page-analyze'
  var MEDIA_PAGE_QUEUE = 'dondownload:media-page-queue'
  var CAPTURE_QUEUE = 'dondownload:capture-queue'
  var NETWORK_EVIDENCE_REQUEST = 'dondownload:network-evidence-request'
  var NETWORK_EVIDENCE = 'dondownload:network-evidence'

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
    triggerOffset: null,
    drag: null,
    suppressTriggerClick: false,
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
      queueToken: 0
    }
  }

  globalThis.__dondownloadOverlayRuntime = state

  // Keep at most one passive listener set per media element across SPA
  // navigations; resetting the source list must not stack duplicate listeners.
  var observedVideos =
    typeof WeakSet === 'function' ? new WeakSet() : null
  // After an SPA URL change, a reused <video> can still report the previous
  // page's currentSrc for one tick. Suppress exactly that value once so it is
  // never re-added as if it belonged to the new page.
  var suppressedSources =
    typeof WeakMap === 'function' ? new WeakMap() : null

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
    '.action {',
    '  background: #f4f4f5;',
    '  border: 1px solid #f4f4f5;',
    '  border-radius: 7px;',
    '  color: #09090b;',
    '  cursor: pointer;',
    '  font: inherit;',
    '  font-size: 12px;',
    '  font-weight: 650;',
    '  padding: 8px 10px;',
    '  width: 100%;',
    '}',
    '.action:hover:not(:disabled) { background: #fff; }',
    '.action:disabled { cursor: not-allowed; opacity: 0.55; }',
    '.action.secondary {',
    '  background: transparent;',
    '  border-color: #3f3f46;',
    '  color: #e4e4e7;',
    '  font-weight: 500;',
    '  margin-top: 6px;',
    '}',
    '.action.secondary:hover:not(:disabled) { background: #18181b; }',
    '.sources { border-top: 1px solid #1f1f23; margin-top: 10px; padding-top: 9px; }',
    '.sources-title { color: #d4d4d8; font-size: 11px; font-weight: 650; margin: 0 0 6px; text-transform: uppercase; letter-spacing: 0.06em; }',
    '.source-list { display: grid; gap: 5px; }',
    '.source { align-items: center; background: #0b0b0c; border: 1px solid #2c2c2c; border-radius: 7px; display: flex; gap: 8px; padding: 6px 7px; }',
    '.source[data-current="true"] { border-color: #52525b; }',
    '.source-copy { min-width: 0; flex: 1; }',
    '.source-title { color: #f4f4f5; display: block; font-size: 11.5px; line-height: 1.35; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
    '.source-detail { color: #8b8b93; display: block; font-size: 10px; margin-top: 1px; }',
    '.source-action { background: #f4f4f5; border: 1px solid #f4f4f5; border-radius: 6px; color: #09090b; cursor: pointer; flex: none; font: inherit; font-size: 10.5px; font-weight: 650; padding: 5px 8px; }',
    '.source-action:hover:not(:disabled) { background: #fff; }',
    '.source-action:disabled { cursor: not-allowed; opacity: 0.55; }',
    '.source-empty { color: #8b8b93; font-size: 11px; line-height: 1.5; margin: 0; }',
    '.source[data-unsupported="true"] { border-color: #52525b; }',
    '.source[data-unsupported="true"] .source-title { color: #fca5a5; }',
    '.source[data-unsupported="true"] .source-detail { color: #a1a1aa; white-space: normal; }',
    '.media-results { margin-top: 10px; }',
    '.media-title { color: #fff; font-size: 12.5px; font-weight: 650; line-height: 1.4; margin: 0 0 3px; overflow-wrap: anywhere; }',
    '.media-meta { color: #a1a1aa; font-size: 11px; line-height: 1.45; margin: 0 0 8px; }',
    '.media-actions { display: grid; gap: 6px; }',
    '.qualities { border: 0; margin: 10px 0 0; padding: 0; }',
    '.qualities legend { color: #d4d4d8; font-size: 11.5px; font-weight: 650; padding: 0; }',
    '.quality-list, .advanced-quality-list { display: grid; gap: 4px; margin: 6px 0; }',
    '.quality-option {',
    '  align-items: flex-start;',
    '  background: #0b0b0c;',
    '  border: 1px solid #2c2c2c;',
    '  border-radius: 6px;',
    '  color: #e4e4e7;',
    '  cursor: pointer;',
    '  display: flex;',
    '  font-size: 11.5px;',
    '  gap: 7px;',
    '  line-height: 1.4;',
    '  padding: 6px 7px;',
    '}',
    '.quality-option:hover { border-color: #52525b; }',
    '.quality-option:focus-within { border-color: #fff; outline: 2px solid #fff; outline-offset: 2px; }',
    '.quality-option input { accent-color: #f4f4f5; margin: 2px 0 0; }',
    '.quality-copy { display: block; min-width: 0; overflow-wrap: anywhere; }',
    '.quality-detail { color: #8b8b93; display: block; font-size: 10.5px; margin-top: 1px; }',
    '.quality-size { color: #d4d4d8; display: block; font-size: 10.5px; font-variant-numeric: tabular-nums; margin-top: 1px; }',
    '.quality-size.unknown { color: #8b8b93; }',
    '.output-format { color: #d4d4d8; display: block; font-size: 11.5px; margin: 8px 0 0; }',
    '.output-format select {',
    '  background: #0b0b0c;',
    '  border: 1px solid #2c2c2c;',
    '  border-radius: 6px;',
    '  color: #f4f4f5;',
    '  display: block;',
    '  font: inherit;',
    '  font-size: 11.5px;',
    '  margin-top: 4px;',
    '  padding: 5px 6px;',
    '  width: 100%;',
    '}',
    '.advanced-qualities { border-top: 1px solid #1f1f23; margin-top: 10px; padding-top: 8px; }',
    '.advanced-qualities summary { color: #d4d4d8; cursor: pointer; font-size: 11px; font-weight: 600; }',
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
    '.status.info { color: #a1a1aa; }',
    '.status.success { color: #86efac; }',
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

  function iframeCandidateFor(iframe) {
    return {
      tagName: iframe.tagName,
      isConnected: iframe.isConnected,
      hidden: iframe.hidden,
      src: iframe.src,
      rect: iframe.getBoundingClientRect(),
      styles: readStyles(iframe)
    }
  }

  function usableEmbed(iframe) {
    return core.evaluateIframeCandidate(iframeCandidateFor(iframe), viewport())
  }

  function largestUsableEmbed() {
    if (typeof document.querySelectorAll !== 'function') return null
    var frames = document.querySelectorAll('iframe')
    var best = null
    var bestArea = 0
    for (var index = 0; index < frames.length; index += 1) {
      var frame = frames[index]
      var result = usableEmbed(frame)
      if (!result.usable) continue
      var rect = frame.getBoundingClientRect()
      var area = rect.width * rect.height
      if (area > bestArea) {
        bestArea = area
        best = frame
      }
    }
    return best
  }

  function hasPlayingTopFrameVideo() {
    return largestPlayingVideo() !== null
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
    head.appendChild(createElement('span', 'panel-badge', 'Media'))

    var analyzeButton = createElement('button', 'action', copy.actionLabel)
    analyzeButton.type = 'button'

    var embedAnalyzeButton = createElement(
      'button',
      'action secondary embed-analyze',
      copy.embedActionLabel || 'Find qualities for embedded video'
    )
    embedAnalyzeButton.type = 'button'
    embedAnalyzeButton.hidden = true

    var sourceSection = createElement('section', 'sources')
    sourceSection.appendChild(createElement('p', 'sources-title', 'Detected from playback'))
    var sourceList = createElement('div', 'source-list')
    var sourceEmpty = createElement(
      'p',
      'source-empty',
      'No progressive playback detected yet. Start playing this video.'
    )
    sourceSection.appendChild(sourceList)
    sourceSection.appendChild(sourceEmpty)

    var mediaResults = createElement('div', 'media-results')
    mediaResults.hidden = true

    var mediaTitle = createElement('p', 'media-title', '')
    var mediaMeta = createElement('p', 'media-meta', '')

    var mediaActions = createElement('div', 'media-actions')
    var bestVideoButton = createElement(
      'button',
      'action best-video',
      'Download best video + audio'
    )
    bestVideoButton.type = 'button'
    bestVideoButton.hidden = true

    var bestAudioButton = createElement(
      'button',
      'action secondary best-audio',
      'Download audio only'
    )
    bestAudioButton.type = 'button'
    bestAudioButton.hidden = true
    mediaActions.appendChild(bestVideoButton)
    mediaActions.appendChild(bestAudioButton)

    var simpleFieldset = createElement('fieldset', 'qualities')
    simpleFieldset.hidden = true
    simpleFieldset.appendChild(createElement('legend', '', 'Choose a quality'))
    var qualityList = createElement('div', 'quality-list')
    simpleFieldset.appendChild(qualityList)

    var advancedDetails = document.createElement('details')
    advancedDetails.className = 'advanced-qualities'
    advancedDetails.appendChild(createElement('summary', '', 'Advanced format options'))
    var qualityFieldset = createElement('fieldset', 'advanced-quality-fieldset')
    qualityFieldset.hidden = true
    qualityFieldset.appendChild(createElement('legend', '', 'All verified formats'))
    var advancedQualityList = createElement('div', 'advanced-quality-list')
    qualityFieldset.appendChild(advancedQualityList)
    var outputFormatControl = createElement('label', 'output-format', 'Output format')
    var outputFormatSelect = document.createElement('select')
    outputFormatSelect.className = 'output-format-select'
    ;['auto', 'mp4', 'mkv', 'webm'].forEach(function (format) {
      var outputOption = document.createElement('option')
      outputOption.value = format
      outputOption.textContent = core.mediaOutputFormatLabel(format)
      outputFormatSelect.appendChild(outputOption)
    })
    outputFormatControl.appendChild(outputFormatSelect)

    var queueSelectedButton = createElement(
      'button',
      'action secondary queue-selected',
      'Download selected quality'
    )
    queueSelectedButton.type = 'button'
    advancedDetails.appendChild(qualityFieldset)

    mediaResults.appendChild(mediaTitle)
    mediaResults.appendChild(mediaMeta)
    mediaResults.appendChild(mediaActions)
    mediaResults.appendChild(simpleFieldset)
    mediaResults.appendChild(outputFormatControl)
    mediaResults.appendChild(advancedDetails)
    mediaResults.appendChild(queueSelectedButton)

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

    var panelNotice = createElement('p', 'panel-notice', copy.title)
    var panelDetail = createElement('p', 'panel-detail', copy.detail)
    // The normal panel is detected-source-first. The old technical notice and
    // the explicit yt-dlp fallback stay available to older callers/tests but
    // are not shown to users; the fallback lives in the popup/options/Media tab.
    panelNotice.hidden = true
    panelDetail.hidden = true
    analyzeButton.hidden = true
    var fallbackOptions = options
    fallbackOptions.hidden = false

    panel.appendChild(head)
    panel.appendChild(panelNotice)
    panel.appendChild(panelDetail)
    panel.appendChild(sourceSection)
    panel.appendChild(analyzeButton)
    panel.appendChild(embedAnalyzeButton)
    panel.appendChild(mediaResults)
    panel.appendChild(options)
    panel.appendChild(status)
    panel.appendChild(
      createElement(
        'p',
        'shortcut',
        'Set a shortcut at ' + copy.shortcutLabel + '.'
      )
    )

    shadow.appendChild(trigger)
    shadow.appendChild(panel)

    var parent = document.fullscreenElement || document.documentElement
    parent.appendChild(host)

    state.host = host
    state.shadow = shadow
    state.trigger = trigger
    state.panel = panel
    state.sourceSection = sourceSection
    state.sourceList = sourceList
    state.sourceEmpty = sourceEmpty
    state.analyzeButton = analyzeButton
    state.embedAnalyzeButton = embedAnalyzeButton
    state.mediaResults = mediaResults
    state.mediaTitle = mediaTitle
    state.mediaMeta = mediaMeta
    state.bestVideoButton = bestVideoButton
    state.bestAudioButton = bestAudioButton
    state.qualityFieldset = qualityFieldset
    state.qualityList = qualityList
    state.simpleFieldset = simpleFieldset
    state.advancedQualityList = advancedQualityList
    state.outputFormatControl = outputFormatControl
    state.outputFormatSelect = outputFormatSelect
    state.queueSelectedButton = queueSelectedButton
    state.disableButton = disableButton
    state.status = status

    on(trigger, 'pointerdown', beginTriggerDrag)
    on(trigger, 'click', function (event) {
      stopPlayerEvent(event)
      if (state.suppressTriggerClick) {
        state.suppressTriggerClick = false
        return
      }
      togglePanel()
    })
    on(trigger, 'pointerenter', cancelHide)
    on(trigger, 'pointerleave', scheduleHide)
    on(document, 'pointermove', moveTriggerDrag, true)
    on(document, 'pointerup', endTriggerDrag, true)
    on(document, 'pointercancel', endTriggerDrag, true)

    on(panel, 'pointerdown', stopPointerEvent)
    // Isolate panel clicks from page player handlers without cancelling the
    // browser's native label/radio activation. Buttons still call
    // stopPlayerEvent explicitly.
    on(panel, 'click', stopPropagationOnly)
    on(panel, 'pointerenter', cancelHide)
    on(panel, 'pointerleave', scheduleHide)
    on(panel, 'keydown', function (event) {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      closePanel(true)
    })
    on(analyzeButton, 'click', function (event) {
      stopPlayerEvent(event)
      analyzePage()
    })
    on(embedAnalyzeButton, 'click', function (event) {
      stopPlayerEvent(event)
      analyzeEmbeddedPage()
    })
    on(bestVideoButton, 'click', function (event) {
      stopPlayerEvent(event)
      if (!state.media.analysis) return
      queueOption(state.media.analysis.bestVideoOptionId)
    })
    on(bestAudioButton, 'click', function (event) {
      stopPlayerEvent(event)
      if (!state.media.analysis) return
      queueOption(state.media.analysis.bestAudioOptionId)
    })
    on(queueSelectedButton, 'click', function (event) {
      stopPlayerEvent(event)
      queueOption(state.media.selectedOptionId)
    })
    on(outputFormatSelect, 'change', function (event) {
      stopPropagationOnly(event)
      state.media.outputFormat = outputFormatSelect.value
      updateOutputFormatControl()
    })
    on(disableButton, 'click', function (event) {
      stopPlayerEvent(event)
      disableSite()
    })
  }

  function stopPropagationOnly(event) {
    if (!event) return
    if (typeof event.stopPropagation === 'function') event.stopPropagation()
  }

  function stopPointerEvent(event) {
    // Do not preventDefault on pointerdown: that can suppress the follow-up
    // click event and make the overlay button feel dead.
    stopPropagationOnly(event)
  }

  function stopPlayerEvent(event) {
    if (!event) return
    stopPropagationOnly(event)
    if (typeof event.preventDefault === 'function') event.preventDefault()
  }

  function clampNumber(value, minimum, maximum) {
    return Math.min(Math.max(value, minimum), maximum)
  }

  function storageFor(area) {
    if (!chrome || !chrome.storage) return null
    return chrome.storage[area] || null
  }

  function installSettingsListener() {
    if (!chrome || !chrome.storage || !chrome.storage.onChanged) return
    if (typeof chrome.storage.onChanged.addListener !== 'function') return
    state.settingsListener = function (changes, area) {
      if (area !== 'local' || !changes || !changes.dondownloadCaptureSettings) return
      var settings = changes.dondownloadCaptureSettings.newValue
      state.floatingEnabled = !settings || settings.floatingTriggerEnabled !== false
      if (state.floatingEnabled) syncFloatingTrigger()
      else if (!state.panelOpen) hideNow()
    }
    chrome.storage.onChanged.addListener(state.settingsListener)
  }

  function restoreCaptureSettings() {
    var local = storageFor('local')
    if (!local || typeof local.get !== 'function') return
    try {
      local.get('dondownloadCaptureSettings', function (stored) {
        if (chrome && chrome.runtime && chrome.runtime.lastError) return
        var settings = stored && stored.dondownloadCaptureSettings
        state.floatingEnabled = !settings || settings.floatingTriggerEnabled !== false
        if (
          !state.floatingEnabled &&
          !state.panelOpen &&
          state.activeVideo &&
          !shouldKeepVisible()
        ) {
          hideNow()
        }
        if (state.floatingEnabled) syncFloatingTrigger()
      })
    } catch {
      // Default-on floating icon remains usable without storage.
    }
  }

  function restoreTriggerOffsets() {
    var local = storageFor('local')
    if (!local || typeof local.get !== 'function') return
    try {
      local.get('dondownloadTriggerOffsets', function (stored) {
        if (chrome && chrome.runtime && chrome.runtime.lastError) return
        var offsets = stored && stored.dondownloadTriggerOffsets
        if (!offsets || typeof offsets !== 'object') return
        var value = offsets[location.origin]
        if (!value || typeof value !== 'object') return
        if (
          typeof value.x !== 'number' ||
          typeof value.y !== 'number' ||
          !Number.isFinite(value.x) ||
          !Number.isFinite(value.y)
        ) {
          return
        }
        state.triggerOffset = {
          x: clampNumber(value.x, 0, 1),
          y: clampNumber(value.y, 0, 1)
        }
        position()
      })
    } catch {
      // A missing saved position only means the default placement is used.
    }
  }

  function saveTriggerOffset(offset) {
    state.triggerOffset = offset
    var local = storageFor('local')
    if (!local || typeof local.set !== 'function') return
    try {
      local.get('dondownloadTriggerOffsets', function (stored) {
        if (chrome && chrome.runtime && chrome.runtime.lastError) return
        var offsets =
          stored && stored.dondownloadTriggerOffsets &&
          typeof stored.dondownloadTriggerOffsets === 'object'
            ? Object.assign({}, stored.dondownloadTriggerOffsets)
            : {}
        offsets[location.origin] = offset
        local.set({ dondownloadTriggerOffsets: offsets }, function () {
          if (chrome && chrome.runtime && chrome.runtime.lastError) return
        })
      })
    } catch {
      // Position is a convenience; the icon still works with local memory.
    }
  }

  function beginTriggerDrag(event) {
    // Do not preventDefault: the follow-up click remains native and is
    // suppressed only when an actual drag occurred.
    stopPropagationOnly(event)
    if (!state.activeVideo) return
    state.suppressTriggerClick = false
    state.drag = {
      startX: typeof event.clientX === 'number' ? event.clientX : 0,
      startY: typeof event.clientY === 'number' ? event.clientY : 0,
      moved: false
    }
  }

  function moveTriggerDrag(event) {
    if (!state.drag || !state.activeVideo) return
    if (typeof event.clientX !== 'number' || typeof event.clientY !== 'number') return
    var dx = event.clientX - state.drag.startX
    var dy = event.clientY - state.drag.startY
    if (!state.drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return
    state.drag.moved = true
    state.suppressTriggerClick = true
    var rect = state.activeVideo.getBoundingClientRect()
    if (!rect || rect.width <= 0 || rect.height <= 0) return
    state.triggerOffset = {
      x: clampNumber((event.clientX - rect.left) / rect.width, 0, 1),
      y: clampNumber((event.clientY - rect.top) / rect.height, 0, 1)
    }
    position()
  }

  function endTriggerDrag() {
    if (!state.drag) return
    var moved = state.drag.moved
    state.drag = null
    if (moved && state.triggerOffset) saveTriggerOffset(state.triggerOffset)
  }

  function isPlayingVideo(video) {
    return Boolean(
      video &&
        video.paused === false &&
        typeof video.readyState === 'number' &&
        video.readyState >= 2 &&
        !video.error
    )
  }

  function largestPlayingVideo() {
    if (typeof document.querySelectorAll !== 'function') return null
    var videos = document.querySelectorAll('video')
    var best = null
    var bestArea = 0
    for (var index = 0; index < videos.length; index += 1) {
      var video = videos[index]
      if (!isPlayingVideo(video)) continue
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

  function triggerInput(video) {
    return {
      paused: video.paused,
      readyState: video.readyState,
      error: video.error || null,
      isConnected: video.isConnected
    }
  }

  /** Attached + large enough + (play requested or metadata loaded). */
  function isTriggerReady(video) {
    return Boolean(video && core.isTriggerReady(triggerInput(video)))
  }

  /**
   * Choose the largest video that is ready for the floating icon. This is much
   * earlier than "actually playing": `paused === false` already means play()
   * was requested, and readyState >= 1 means metadata is available.
   */
  function largestTriggerVideo() {
    if (typeof document.querySelectorAll !== 'function') return null
    var videos = document.querySelectorAll('video')
    var candidates = []
    for (var index = 0; index < videos.length; index += 1) {
      var video = videos[index]
      if (!isTriggerReady(video)) continue
      var result = usable(video)
      if (!result.usable) continue
      var rect = video.getBoundingClientRect()
      candidates.push({
        video: video,
        ready: true,
        usable: true,
        rect: { width: rect.width, height: rect.height }
      })
    }
    var best = core.largestTriggerCandidate(candidates)
    return best && best.video ? best.video : null
  }

  /**
   * A persistent floating icon follows the largest usable ready player, even
   * when the pointer is not hovering and even while the player is buffering or
   * paused. It never waits for a captured source.
   */
  function syncFloatingTrigger() {
    if (state.disabled || !state.floatingEnabled || state.panelOpen) return
    var video = largestTriggerVideo()
    if (!video) {
      // Do not hide a hover-shown player merely because it is paused or still
      // buffering; pointerleave already owns that case. Only a detached or
      // no-longer-usable element must disappear immediately.
      if (state.activeVideo && !usable(state.activeVideo).usable) hideNow()
      return
    }
    if (video !== state.activeVideo) showFor(video)
    else if (state.trigger && !state.trigger.hidden) position()
  }

  function shouldKeepVisible() {
    if (state.panelOpen) return true
    if (!state.activeVideo) return false
    return state.floatingEnabled && isTriggerReady(state.activeVideo)
  }

  /**
   * An event can arrive before the player has its final layout rectangle
   * (common on SPA players). A short best-effort burst re-checks the same
   * visible element without polling the media source or waiting for the next
   * `timeupdate`.
   */
  function scheduleTriggerBurst() {
    if (state.triggerBurst || state.disabled) return
    state.triggerBurst = true
    var attempts = 0
    var tick = function () {
      if (state.disabled) {
        state.triggerBurst = false
        return
      }
      attempts += 1
      syncFloatingTrigger()
      if (attempts >= 12 || state.panelOpen) {
        state.triggerBurst = false
        return
      }
      window.setTimeout(tick, 60)
    }
    window.setTimeout(tick, 60)
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

  function playerFor(video) {
    if (!video) return null
    for (var index = 0; index < state.capture.players.length; index += 1) {
      if (state.capture.players[index].video === video) return state.capture.players[index]
    }
    return null
  }

  function resetCaptureForNavigation() {
    state.capture.queueToken += 1
    state.capture.navigationUrl = location.href
    if (suppressedSources) {
      for (var playerIndex = 0; playerIndex < state.capture.players.length; playerIndex += 1) {
        var previous = state.capture.players[playerIndex]
        if (!previous || !previous.video) continue
        var previousSrc =
          typeof previous.video.currentSrc === 'string' ? previous.video.currentSrc : ''
        if (previousSrc.length > 0) suppressedSources.set(previous.video, previousSrc)
      }
    }
    releaseCapturePlayers()
    state.capture.players = []
    state.capture.buttons = []
    state.capture.rowCleanups = []
    state.capture.queuedUrls = []
    state.capture.queueing = false
    state.triggerOffset = null
    state.activeEmbed = null
    // A fallback analysis also belongs to the previous document/page. Clear it
    // so its opaque option IDs can never be applied to a new SPA page.
    state.media.token += 1
    state.media.queueToken += 1
    state.media.status = 'idle'
    state.media.queuedOptionIds = []
    resetPrefetchForNavigation()
    resetMediaResults()
    if (state.analyzeButton) {
      state.analyzeButton.hidden = true
      state.analyzeButton.textContent = copy.actionLabel
      state.analyzeButton.disabled = false
    }
    if (state.embedAnalyzeButton) {
      state.embedAnalyzeButton.hidden = true
      state.embedAnalyzeButton.disabled = false
    }
    setMediaStatus('', '')
    hideNow()
    renderCapturedSources()
    restoreTriggerOffsets()
    installSourceObservers()
    // The reused player may already be playing for the new page. Show the icon
    // immediately and let the debounced prefetch start for the new URL.
    syncFloatingTrigger()
    schedulePrefetch()
  }

  function releaseCapturePlayers() {
    for (var pIndex = 0; pIndex < state.capture.players.length; pIndex += 1) {
      var player = state.capture.players[pIndex]
      if (!player) continue
      if (observedVideos && player.video) observedVideos.delete(player.video)
      var cleanups = player.cleanups || []
      for (var cIndex = 0; cIndex < cleanups.length; cIndex += 1) {
        try {
          cleanups[cIndex]()
        } catch {
          // The video may already be detached.
        }
      }
      player.cleanups = []
      player.video = null
      player.sources = []
      player.unsupported = null
    }
  }

  function pruneDisconnectedPlayers() {
    var kept = []
    for (var index = 0; index < state.capture.players.length; index += 1) {
      var player = state.capture.players[index]
      if (!player || !player.video || player.video.isConnected === false) {
        if (player) {
          if (observedVideos && player.video) observedVideos.delete(player.video)
          var cleanups = player.cleanups || []
          for (var cIndex = 0; cIndex < cleanups.length; cIndex += 1) {
            try {
              cleanups[cIndex]()
            } catch {
              // Best effort for a detached node.
            }
          }
        }
        continue
      }
      kept.push(player)
    }
    state.capture.players = kept
  }

  function maybeResetCaptureForNavigation() {
    if (state.capture.navigationUrl !== location.href) {
      resetCaptureForNavigation()
      return true
    }
    return false
  }

  function observePlayer(video) {
    if (!video || playerFor(video)) return
    var player = {
      video: video,
      sources: [],
      unsupported: null,
      playbackKind: 'none',
      lastSrc: '',
      listening: false,
      evidenceRequested: Object.create(null),
      cleanups: []
    }
    state.capture.players.push(player)
    if (observedVideos && observedVideos.has(video)) return
    if (observedVideos) observedVideos.add(video)
    player.listening = true

    function listen(type, listener) {
      if (typeof video.addEventListener !== 'function') return
      video.addEventListener(type, listener)
      player.cleanups.push(function () {
        if (typeof video.removeEventListener === 'function') {
          video.removeEventListener(type, listener)
        }
      })
    }

    var check = function () {
      observePlayback(video)
      if (state.floatingEnabled) {
        syncFloatingTrigger()
        if (!state.activeVideo || (state.trigger && state.trigger.hidden)) {
          scheduleTriggerBurst()
        }
      }
      schedulePrefetch()
    }
    // `play` and `loadedmetadata` arrive before the first rendered frame, so
    // the icon no longer waits for `playing`/`timeupdate`. The rest keep the
    // state accurate without polling the player.
    listen('play', check)
    listen('playing', check)
    listen('loadedmetadata', check)
    listen('loadeddata', check)
    listen('canplay', check)
    listen('timeupdate', check)
    listen('pause', check)
    listen('ended', check)
    listen('error', check)
    listen('durationchange', check)
    listen('emptied', function () {
      var current = playerFor(video)
      if (!current) return
      // A normal progressive quality switch emits `emptied` too. Keep the
      // accumulated exact URLs and their display labels; only the current
      // marker changes. Navigation/player removal owns clearing identities.
      current.lastSrc = ''
      current.sources = current.sources.map(function (source) {
        return Object.assign({}, source, { current: false })
      })
      current.unsupported = null
      current.playbackKind = 'none'
      if (video === state.activeVideo) renderCapturedSources()
    })
    // The player may already be attached, ready or playing when this script is
    // injected, and no future media event may fire soon enough. Check now.
    check()
  }

  function installSourceObservers() {
    if (typeof document.querySelectorAll !== 'function') return
    var videos = document.querySelectorAll('video')
    for (var index = 0; index < videos.length; index += 1) {
      observePlayer(videos[index])
    }
  }

  function playbackInput(video) {
    return {
      currentSrc: typeof video.currentSrc === 'string' ? video.currentSrc : '',
      paused: video.paused,
      readyState: video.readyState,
      ended: video.ended,
      error: video.error || null,
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight
    }
  }

  /**
   * Ask the background worker for exact response evidence for one exact URL.
   * The sender tab is derived by the worker; this message never carries a tab
   * id. There is no polling: media events trigger the request and the worker
   * also pushes the exact URL when headers arrive.
   */
  function requestNetworkEvidence(player, url, required) {
    if (!player || typeof url !== 'string' || url.length === 0) return
    if (player.evidenceRequested[url] === true) return
    player.evidenceRequested[url] = true

    sendRuntimeMessage(
      { type: NETWORK_EVIDENCE_REQUEST, url: url },
      function (response, runtimeError) {
        if (runtimeError || !response || response.ok !== true) {
          if (required) markEvidenceUnavailable(player, url, 'The response evidence request failed.')
          return
        }
        if (!response.evidence) {
          if (required) {
            markEvidenceUnavailable(
              player,
              url,
              'No complete-file response evidence was observed. Enable optional network observation and play this video again.'
            )
          }
          return
        }
        handleNetworkEvidence(url, response.evidence)
      }
    )
  }

  function markEvidenceUnavailable(player, url, message) {
    if (!player || !player.video) return
    var candidate = core.evaluatePlaybackSource(playbackInput(player.video))
    if (!candidate || candidate.url !== url) return
    player.unsupported = {
      code: 'NETWORK_EVIDENCE_UNAVAILABLE',
      message: message
    }
    if (player.video === state.activeVideo && state.panelOpen) renderCapturedSources()
  }

  function handleNetworkEvidence(url, evidence) {
    if (state.disabled || typeof url !== 'string' || !evidence) return
    if (evidence.url !== url || evidence.completeFile !== true) return
    var changed = false
    for (var index = 0; index < state.capture.players.length; index += 1) {
      var player = state.capture.players[index]
      if (!player || !player.video) continue
      var candidate = core.evaluatePlaybackSource(playbackInput(player.video))
      // Match the exact canonical currentSrc, not the raw string (which may
      // include a media fragment) and never a dimension or "only player" guess.
      if (!candidate || candidate.url !== url) continue
      var verified = core.applyNetworkEvidence(candidate, evidence)
      if (verified) {
        player.sources = core.addCapturedSource(player.sources, verified)
        player.unsupported = null
        changed = true
      }
    }
    if (changed && state.activeVideo && state.panelOpen) renderCapturedSources()
  }

  /**
   * Observe only the exact player's currentSrc after real playback. Dimensions
   * label a source only after its URL is proven; they never prove a source.
   */
  function observePlayback(video) {
    if (state.disabled || !video || maybeResetCaptureForNavigation()) return
    var player = playerFor(video)
    if (!player) return

    var currentSrc = typeof video.currentSrc === 'string' ? video.currentSrc : ''
    if (currentSrc.length === 0) return
    if (suppressedSources && suppressedSources.has(video)) {
      var suppressed = suppressedSources.get(video)
      suppressedSources.delete(video)
      if (currentSrc === suppressed) {
        player.lastSrc = currentSrc
        return
      }
    }
    if (currentSrc === player.lastSrc && player.sources.length > 0) {
      // Only skip a repeated URL when it was already classified from an
      // attached/playing state. A `loadeddata`/`durationchange` check can see
      // the new URL while the player is still paused; the later `playing`
      // event must re-evaluate and add it.
      if (player.playbackKind !== 'not-playing') return
    }
    player.lastSrc = currentSrc

    var result = core.evaluatePlaybackSource(playbackInput(video))
    player.playbackKind = result.kind

    if (result.kind === 'verified') {
      player.sources = core.addCapturedSource(player.sources, result)
      player.unsupported = null
      // Optional: enrich the already-proven progressive URL with an exact
      // total and response type. It is never required for an extensionful URL.
      requestNetworkEvidence(player, result.url, false)
    } else if (result.kind === 'needs-evidence') {
      // An extensionless URL is not a source yet. Wait for exact complete-file
      // response evidence; do not infer a container from a filename.
      requestNetworkEvidence(player, result.url, true)
      return
    } else if (result.kind === 'unsupported') {
      player.sources = player.sources.map(function (source) {
        return Object.assign({}, source, { current: false })
      })
      player.unsupported = result
    } else {
      return
    }

    if (video === state.activeVideo && state.panelOpen) renderCapturedSources()
    if (video === state.activeVideo) schedulePrefetch()
  }

  function pageUrlKey() {
    var href = typeof location.href === 'string' ? location.href : ''
    return href.split('#')[0]
  }

  function clearPrefetchTimer() {
    if (!state.prefetch.timer) return
    try {
      window.clearTimeout(state.prefetch.timer)
    } catch {
      // Timer cleanup is best effort.
    }
    state.prefetch.timer = 0
  }

  /**
   * Automatic page analysis is allowed only here: the content script itself is
   * injected only after the user enabled the overlay for this exact origin.
   * It never runs for an ordinary page the user did not opt in to.
   */
  function canAutoPrefetch() {
    if (state.disabled || state.activeEmbed) return false
    var video = state.activeVideo || largestTriggerVideo()
    if (!video) return false
    var player = playerFor(video)
    if (!player) return false
    if (core.isStreamingUnsupported(player.unsupported)) return true
    if (player.sources.length > 0) return false
    // An extensionless URL is waiting for exact response evidence, not for
    // yt-dlp; a verified progressive URL already has a one-click row.
    if (player.playbackKind === 'needs-evidence') return false
    if (player.playbackKind === 'verified') return false
    if (!isTriggerReady(video)) return false
    return (
      (typeof video.currentTime === 'number' && video.currentTime > 0) ||
      video.paused === false
    )
  }

  function resetPrefetchForNavigation() {
    clearPrefetchTimer()
    state.prefetch.token += 1
    state.prefetch.url = ''
    state.prefetch.status = 'idle'
    state.prefetch.startedAt = 0
    state.prefetch.expiresAt = 0
    state.prefetch.analysis = null
    state.prefetch.error = null
  }

  function prefetchView() {
    if (state.prefetch.status !== 'ready' || !state.prefetch.analysis) return null
    if (state.prefetch.expiresAt > 0 && state.prefetch.expiresAt <= Date.now()) {
      return null
    }
    return core.mediaView(state.prefetch.analysis)
  }

  /** The current verified view, reusing the cached prefetch instead of calling
   * yt-dlp again when the user opens the panel or the popup. */
  function currentAnalysisView() {
    if (state.media.analysis) return state.media.analysis
    var view = prefetchView()
    if (!view) return null
    state.media.analysis = view
    state.media.status = 'analyzed'
    return view
  }

  function adoptPrefetchResult() {
    var view = currentAnalysisView()
    if (!view) return false
    if (state.panelOpen) renderAnalysis(view)
    return true
  }

  function prefetchInFlight() {
    return (
      state.prefetch.status === 'analyzing' ||
      state.prefetch.status === 'debouncing'
    )
  }

  /** Debounce ~500 ms after the page URL settles, then analyze once. */
  function schedulePrefetch(delay) {
    if (!canAutoPrefetch()) {
      if (state.prefetch.status === 'debouncing') {
        clearPrefetchTimer()
        state.prefetch.url = ''
        state.prefetch.status = 'idle'
        state.prefetch.startedAt = 0
        if (state.panelOpen) renderCapturedSources()
      }
      return
    }
    var url = pageUrlKey()
    if (!url) return
    var decision = core.prefetchDecision(state.prefetch, {
      url: url,
      now: Date.now(),
      eligible: true
    })
    if (decision.action === 'reuse') {
      adoptPrefetchResult()
      return
    }
    if (decision.action === 'none') return
    if (decision.action === 'analyze') {
      startPrefetch(url, {})
      return
    }
    if (state.prefetch.status === 'debouncing' && state.prefetch.url === url) {
      return
    }

    clearPrefetchTimer()
    state.prefetch.url = url
    state.prefetch.status = 'debouncing'
    state.prefetch.startedAt = Date.now()
    state.prefetch.expiresAt = 0
    state.prefetch.analysis = null
    state.prefetch.error = null
    var wait =
      typeof delay === 'number' && delay >= 0
        ? delay
        : core.PREFETCH_DEBOUNCE_MS
    state.prefetch.timer = window.setTimeout(function () {
      state.prefetch.timer = 0
      if (
        state.disabled ||
        state.prefetch.status !== 'debouncing' ||
        state.prefetch.url !== url ||
        pageUrlKey() !== url
      ) {
        return
      }
      startPrefetch(url, {})
    }, wait)
    if (state.panelOpen) {
      setMediaStatus(copy.analyzingLabel, 'info')
      renderCapturedSources()
    }
  }

  /**
   * One in-flight analysis per tab, keyed by the settled page URL. The worker
   * still derives that URL from the trusted sender tab; this content script
   * only decides when to ask. Stale responses are dropped by token + URL.
   */
  function startPrefetch(url, options) {
    options = options || {}
    if (state.disabled) return false
    var targetUrl = url || pageUrlKey()
    if (!targetUrl) return false
    if (
      state.prefetch.status === 'analyzing' &&
      state.prefetch.url === targetUrl
    ) {
      return false
    }
    if (
      options.force !== true &&
      state.prefetch.status === 'ready' &&
      state.prefetch.url === targetUrl &&
      state.prefetch.expiresAt > Date.now()
    ) {
      return false
    }

    clearPrefetchTimer()
    var token = ++state.prefetch.token
    state.prefetch.url = targetUrl
    state.prefetch.status = 'analyzing'
    state.prefetch.startedAt = Date.now()
    state.prefetch.expiresAt = 0
    state.prefetch.analysis = null
    state.prefetch.error = null
    state.media.status = 'analyzing'
    resetMediaResults()
    if (state.analyzeButton) {
      state.analyzeButton.hidden = Boolean(state.activeEmbed)
      state.analyzeButton.textContent = copy.analyzingLabel
      state.analyzeButton.disabled = true
    }
    if (state.embedAnalyzeButton) {
      state.embedAnalyzeButton.hidden = !state.activeEmbed
      state.embedAnalyzeButton.textContent = copy.analyzingLabel
    }
    setMediaBusy(true)
    if (state.panelOpen) {
      setMediaStatus(options.analyzingText || copy.analyzingLabel, 'info')
    }

    sendRuntimeMessage({ type: MEDIA_ANALYZE }, function (response, runtimeError) {
      if (
        !core.prefetchResultApplies(state.prefetch, {
          url: targetUrl,
          token: token,
          now: Date.now()
        }) ||
        state.disabled ||
        pageUrlKey() !== targetUrl
      ) {
        return
      }
      if (state.analyzeButton) {
        state.analyzeButton.textContent = copy.actionLabel
        state.analyzeButton.disabled = false
      }
      if (state.embedAnalyzeButton) {
        state.embedAnalyzeButton.textContent = copy.embedActionLabel
      }
      setMediaBusy(false)

      if (runtimeError) {
        failPrefetch(
          { code: 'BACKGROUND_UNAVAILABLE', message: 'The DonDownload background worker did not respond.' },
          'The DonDownload background worker did not respond. Reload this page, then try again.'
        )
        return
      }
      if (!response || response.ok !== true || !response.analysis) {
        var fallback = 'The page could not be analyzed. Try again in a moment.'
        failPrefetch(
          response && response.error ? response.error : null,
          core.describeMediaError(response && response.error, fallback)
        )
        return
      }

      var view = core.mediaView(response.analysis)
      if (!view) {
        failPrefetch(
          { code: 'MEDIA_RESPONSE_INVALID', message: 'The analysis response was not valid.' },
          'The analysis response was not valid. Try again.'
        )
        return
      }

      state.prefetch.status = 'ready'
      state.prefetch.analysis = response.analysis
      state.prefetch.error = null
      state.prefetch.expiresAt =
        typeof response.analysis.expiresAt === 'number' &&
        Number.isFinite(response.analysis.expiresAt)
          ? response.analysis.expiresAt
          : Date.now() + core.PREFETCH_MAX_AGE_MS
      state.media.status = 'analyzed'
      state.media.analysis = view
      if (state.panelOpen) renderAnalysis(view)
    })
    return true
  }

  function failPrefetch(error, message) {
    state.prefetch.status = 'error'
    state.prefetch.error = error || null
    state.prefetch.analysis = null
    state.media.status = 'error'
    setMediaBusy(false)
    if (state.panelOpen) {
      setMediaStatus(message || copy.actionLabel, 'error')
      renderCapturedSources()
    }
  }

  function ensurePrefetchForPanel() {
    if (currentAnalysisView()) {
      adoptPrefetchResult()
      return
    }
    if (prefetchInFlight()) return
    if (state.prefetch.status === 'error') return
    schedulePrefetch(0)
  }

  function queryAnalysisStatus() {
    if (prefetchInFlight() || state.media.status === 'analyzing') return 'analyzing'
    if (state.media.analysis) return 'ready'
    if (state.prefetch.status === 'ready' && prefetchView()) return 'ready'
    if (state.prefetch.status === 'error' || state.media.status === 'error') {
      return 'error'
    }
    return 'idle'
  }

  function streamingForQuery() {
    // A visible top-frame embed is a player too. Its analysis is the separate
    // embed request, never an automatic top-page prefetch.
    if (state.activeEmbed && usableEmbed(state.activeEmbed).usable) {
      return {
        detected: true,
        embedded: true,
        code: 'EMBED_PLAYER',
        message: 'Embedded video detected. Find qualities for it in the panel.'
      }
    }
    var player = playerFor(state.activeVideo)
    if (!player) {
      for (var index = 0; index < state.capture.players.length; index += 1) {
        var candidate = state.capture.players[index]
        if (candidate && candidate.unsupported) {
          player = candidate
          break
        }
      }
    }
    if (player && player.unsupported) {
      return {
        detected: true,
        code: player.unsupported.code || 'STREAMING',
        message: player.unsupported.message || 'Streaming video detected.'
      }
    }
    return { detected: false }
  }

  function clearSourceList() {
    for (var cleanupIndex = 0; cleanupIndex < state.capture.rowCleanups.length; cleanupIndex += 1) {
      try {
        state.capture.rowCleanups[cleanupIndex]()
      } catch {
        // The row may already be detached.
      }
    }
    state.capture.rowCleanups = []
    if (!state.sourceList) return
    while (state.sourceList.children.length > 0) {
      state.sourceList.removeChild(state.sourceList.children[0])
    }
  }

  function renderCapturedSources() {
    if (!state.sourceSection || !state.sourceList) return
    clearSourceList()
    state.capture.buttons = []

    var player = playerFor(state.activeVideo)
    var sources = player ? player.sources : []
    var unsupported = player ? player.unsupported : null

    for (var index = 0; index < sources.length; index += 1) {
      appendCapturedSourceRow(sources[index])
    }

    if (unsupported) {
      var unsupportedRow = createElement('div', 'source')
      unsupportedRow.setAttribute('data-unsupported', 'true')
      var unsupportedCopy = createElement('span', 'source-copy')
      unsupportedCopy.appendChild(
        createElement('span', 'source-title', 'Streaming playback source')
      )
      unsupportedCopy.appendChild(
        createElement('span', 'source-detail', unsupported.message)
      )
      unsupportedRow.appendChild(unsupportedCopy)
      state.sourceList.appendChild(unsupportedRow)
    }

    if (state.sourceEmpty) {
      state.sourceEmpty.hidden = sources.length > 0 || unsupported !== null
      state.sourceEmpty.textContent = state.activeEmbed
        ? 'No top-frame video is playing. Find qualities for the embedded player below.'
        : 'No progressive playback detected yet. Start playing this video, or find verified qualities if it uses HLS, DASH or Media Source.'
    }

    // Progressive captured sources stay first and keep one-click download.
    // A cached background analysis is adopted immediately. While it is still
    // running the same action doubles as a disabled "Finding qualities…"
    // spinner; after a failure it stays available as the manual retry.
    var analyzing = prefetchInFlight()
    var cachedView = state.media.analysis || prefetchView()
    if (cachedView && !state.media.analysis) {
      state.media.analysis = cachedView
      state.media.status = 'analyzed'
    }
    var offerAnalysis =
      !cachedView && core.shouldOfferPageAnalysis(sources, unsupported)
    if (state.analyzeButton) {
      state.analyzeButton.hidden =
        (!offerAnalysis && !analyzing) || Boolean(state.activeEmbed)
      state.analyzeButton.textContent = analyzing ? copy.analyzingLabel : copy.actionLabel
      state.analyzeButton.disabled = analyzing
    }
    if (state.embedAnalyzeButton) {
      state.embedAnalyzeButton.hidden =
        !state.activeEmbed ||
        analyzing ||
        Boolean(cachedView) ||
        hasPlayingTopFrameVideo()
    }
    setCaptureBusy(state.capture.queueing)
  }

  function appendCapturedSourceRow(source) {
    var row = createElement('div', 'source')
    if (source.current) row.setAttribute('data-current', 'true')
    var copyNode = createElement('span', 'source-copy')
    copyNode.appendChild(
      createElement('span', 'source-title', source.filename)
    )
    var details = []
    if (source.qualityLabel) details.push(source.qualityLabel)
    details.push(String(source.container || '').toUpperCase())
    if (
      typeof source.sizeBytes === 'number' &&
      Number.isSafeInteger(source.sizeBytes) &&
      source.sizeBytes > 0 &&
      core.formatMediaSize
    ) {
      // Exact only because it came from a complete Content-Range total or an
      // identity Content-Length. Unknown stays unstated rather than guessed.
      details.push(core.formatMediaSize(source.sizeBytes, false))
    }
    if (source.current) details.push('current playback')
    copyNode.appendChild(
      createElement('span', 'source-detail', details.join(' · '))
    )
    row.appendChild(copyNode)

    var button = createElement('button', 'source-action', 'Download')
    button.type = 'button'
    var alreadyQueued = state.capture.queuedUrls.indexOf(source.url) !== -1
    if (alreadyQueued) {
      button.textContent = 'Added ✓'
      button.disabled = true
    } else {
      button.disabled = state.capture.queueing
    }
    var onClick = function (event) {
      stopPlayerEvent(event)
      queueCapturedSource(source)
    }
    if (typeof button.addEventListener === 'function') {
      button.addEventListener('click', onClick)
      state.capture.rowCleanups.push(function () {
        if (typeof button.removeEventListener === 'function') {
          button.removeEventListener('click', onClick)
        }
      })
    }
    row.appendChild(button)
    state.capture.buttons.push(button)
    state.sourceList.appendChild(row)
  }

  function setCaptureBusy(busy) {
    for (var index = 0; index < state.capture.buttons.length; index += 1) {
      var button = state.capture.buttons[index]
      if (!button) continue
      button.disabled = busy || button.textContent === 'Added ✓'
    }
  }

  function queueCapturedSource(source, done) {
    if (
      state.disabled ||
      state.capture.queueing ||
      !source ||
      state.capture.queuedUrls.indexOf(source.url) !== -1
    ) {
      if (typeof done === 'function') {
        done({ ok: false, error: { code: 'NOT_AVAILABLE', message: 'No source is available.' } })
      }
      return
    }
    var token = ++state.capture.queueToken
    state.capture.queueing = true
    setCaptureBusy(true)
    setMediaStatus('Adding ' + source.filename + '...', 'info')

    sendRuntimeMessage(
      {
        type: CAPTURE_QUEUE,
        url: source.url,
        filename: source.filename,
        ...(source.contentType === 'video/mp4' || source.contentType === 'video/webm'
          ? { contentType: source.contentType }
          : {}),
        ...(typeof source.sizeBytes === 'number' &&
        Number.isSafeInteger(source.sizeBytes) &&
        source.sizeBytes > 0
          ? { expectedBytes: source.sizeBytes }
          : {})
      },
      function (response, runtimeError) {
        if (token !== state.capture.queueToken || state.disabled) {
          if (typeof done === 'function') {
            done({ ok: false, error: { code: 'REQUEST_CANCELLED', message: 'The request was cancelled.' } })
          }
          return
        }
        state.capture.queueing = false
        setCaptureBusy(false)

        if (runtimeError) {
          setMediaStatus('The DonDownload background worker did not respond.', 'error')
          if (typeof done === 'function') {
            done({ ok: false, error: { code: 'BACKGROUND_UNAVAILABLE', message: 'The background worker did not respond.' } })
          }
          return
        }
        if (!response || response.ok !== true) {
          setMediaStatus(
            core.describeMediaError(
              response && response.error,
              'The captured source could not be queued.'
            ),
            'error'
          )
          if (typeof done === 'function') done(response || { ok: false })
          return
        }

        setMediaStatus('Added to DonDownload ✓ — downloading in the app', 'success')
        if (state.capture.queuedUrls.indexOf(source.url) === -1) {
          state.capture.queuedUrls.push(source.url)
        }
        closePanel(false)
        showAcceptedFeedback()
        if (typeof done === 'function') done({ ok: true })
      }
    )
  }

  function showAcceptedFeedback() {
    if (!state.trigger) return
    state.trigger.textContent = 'OK'
    window.setTimeout(function () {
      if (state.trigger) state.trigger.textContent = 'DD'
    }, 1200)
  }

  function clearQualityList() {
    ;[state.qualityList, state.advancedQualityList].forEach(function (list) {
      if (!list) return
      while (list.children.length > 0) list.removeChild(list.children[0])
    })
  }

  function resetMediaResults() {
    state.media.analysis = null
    state.media.selectedOptionId = null
    state.media.outputFormat = 'auto'
    state.media.queuedOptionIds = []
    if (state.mediaResults) state.mediaResults.hidden = true
    if (state.mediaTitle) state.mediaTitle.textContent = ''
    if (state.mediaMeta) state.mediaMeta.textContent = ''
    if (state.bestVideoButton) {
      state.bestVideoButton.hidden = true
      state.bestVideoButton.disabled = false
    }
    if (state.bestAudioButton) {
      state.bestAudioButton.hidden = true
      state.bestAudioButton.disabled = false
    }
    if (state.qualityFieldset) state.qualityFieldset.hidden = true
    if (state.simpleFieldset) state.simpleFieldset.hidden = true
    if (state.outputFormatControl) state.outputFormatControl.hidden = true
    if (state.outputFormatSelect) state.outputFormatSelect.value = 'auto'
    if (state.queueSelectedButton) state.queueSelectedButton.disabled = true
    clearQualityList()
  }

  function updateOutputFormatControl() {
    if (!state.outputFormatControl || !state.outputFormatSelect) return
    var option = optionById(state.media.analysis, state.media.selectedOptionId)
    if (!option) {
      state.outputFormatControl.hidden = true
      return
    }
    state.outputFormatControl.hidden = false
    var formats = core.outputFormatsForOption(option)
    state.media.outputFormat = core.normalizeOutputFormat(
      option,
      state.media.outputFormat
    )
    state.outputFormatSelect.value = state.media.outputFormat
    for (
      var index = 0;
      index < state.outputFormatSelect.children.length;
      index += 1
    ) {
      var outputOption = state.outputFormatSelect.children[index]
      if (!outputOption || typeof outputOption.value !== 'string') continue
      outputOption.disabled = formats.indexOf(outputOption.value) === -1
    }
    updateQualitySizeLabels()
  }

  function updateQualitySizeLabels() {
    ;[state.qualityList, state.advancedQualityList].forEach(function (list) {
      if (!list) return
      for (var index = 0; index < list.children.length; index += 1) {
        var input = list.children[index].children[0]
        if (!input || !input.mediaOption || !input.mediaSizeNode) continue
        var format =
          input.mediaOptionId === state.media.selectedOptionId
            ? state.media.outputFormat
            : 'auto'
        var sizeLabel = core.describeMediaSize(input.mediaOption, format)
        input.mediaSizeNode.textContent = sizeLabel
        input.mediaSizeNode.className =
          sizeLabel === core.MEDIA_SIZE_UNKNOWN
            ? 'quality-size unknown'
            : 'quality-size'
      }
    })
  }

  function optionIsQueued(optionId) {
    return core.isOptionQueued(state.media.queuedOptionIds, optionId)
  }

  function qualityRowQueued(row) {
    var input = row && row.children ? row.children[0] : null
    return Boolean(input && input.mediaOptionId && optionIsQueued(input.mediaOptionId))
  }

  function setMediaBusy(busy) {
    if (state.panel) state.panel.setAttribute('aria-busy', busy ? 'true' : 'false')
    var analyzing = prefetchInFlight()
    if (state.analyzeButton) {
      state.analyzeButton.disabled = busy || analyzing
    }
    if (state.embedAnalyzeButton) state.embedAnalyzeButton.disabled = busy
    if (state.outputFormatSelect) state.outputFormatSelect.disabled = busy
    ;[state.qualityList, state.advancedQualityList].forEach(function (list) {
      if (!list) return
      for (var index = 0; index < list.children.length; index += 1) {
        var row = list.children[index]
        var queued = qualityRowQueued(row)
        for (var childIndex = 0; childIndex < row.children.length; childIndex += 1) {
          var child = row.children[childIndex]
          if (child && child.className === 'source-action quality-queue') {
            child.textContent = queued ? 'Added ✓' : 'Download'
            child.disabled = busy || queued
          }
        }
      }
    })
    if (state.bestVideoButton) {
      state.bestVideoButton.disabled =
        busy ||
        Boolean(
          state.media.analysis &&
            optionIsQueued(state.media.analysis.bestVideoOptionId)
        )
    }
    if (state.bestAudioButton) {
      state.bestAudioButton.disabled =
        busy ||
        Boolean(
          state.media.analysis &&
            optionIsQueued(state.media.analysis.bestAudioOptionId)
        )
    }
    if (state.queueSelectedButton) {
      state.queueSelectedButton.disabled =
        busy || !state.media.selectedOptionId || optionIsQueued(state.media.selectedOptionId)
    }
    ;[state.qualityList, state.advancedQualityList].forEach(function (list) {
      if (!list) return
      for (var index = 0; index < list.children.length; index += 1) {
        var input = list.children[index].children[0]
        if (input) input.disabled = busy
      }
    })
  }

  function renderQualityOptions(view, pinnedOptionId) {
    clearQualityList()
    if (!state.qualityFieldset || !state.qualityList || !state.advancedQualityList) return

    if (view.options.length === 0) {
      state.qualityFieldset.hidden = true
      if (state.simpleFieldset) state.simpleFieldset.hidden = true
      return
    }
    state.qualityFieldset.hidden = false
    var simpleChoices = core.mediaQualityChoices(view)
    if (state.simpleFieldset) state.simpleFieldset.hidden = simpleChoices.length === 0

    var initialId =
      typeof pinnedOptionId === 'string' && core.optionById(view, pinnedOptionId)
        ? pinnedOptionId
        : view.bestVideoOptionId !== null
          ? view.bestVideoOptionId
          : view.bestAudioOptionId !== null
            ? view.bestAudioOptionId
            : view.options[0].optionId
    state.media.selectedOptionId = initialId

    function appendOption(list, option, displayLabel, includeDetails, radioName, directQueue) {
      var label = createElement('label', 'quality-option')
      var input = createElement('input', 'quality-input')
      input.type = 'radio'
      input.name = radioName
      input.value = option.optionId
      input.mediaOptionId = option.optionId
      input.mediaOption = option
      input.checked = option.optionId === initialId
      label.appendChild(input)

      var copyNode = createElement('span', 'quality-copy')
      copyNode.appendChild(createElement('span', '', displayLabel || option.label))
      var detail = includeDetails ? core.describeMediaDetails(option) : ''
      if (detail) copyNode.appendChild(createElement('span', 'quality-detail', detail))
      var sizeLabel = core.describeMediaSize(option)
      var sizeNode = createElement(
        'span',
        sizeLabel === core.MEDIA_SIZE_UNKNOWN ? 'quality-size unknown' : 'quality-size',
        sizeLabel
      )
      input.mediaSizeNode = sizeNode
      copyNode.appendChild(sizeNode)
      label.appendChild(copyNode)

      if (directQueue) {
        // One click queues exactly this verified option; the radio row remains
        // available for the advanced format picker below.
        var queued = core.isOptionQueued(
          state.media.queuedOptionIds,
          option.optionId
        )
        var queueButton = createElement(
          'button',
          'source-action quality-queue',
          queued ? 'Added ✓' : 'Download'
        )
        queueButton.type = 'button'
        queueButton.disabled = queued || state.media.status === 'queueing'
        var queueClick = function (event) {
          stopPlayerEvent(event)
          queueOption(option.optionId)
        }
        if (typeof queueButton.addEventListener === 'function') {
          queueButton.addEventListener('click', queueClick)
        }
        label.appendChild(queueButton)
      }

      list.appendChild(label)
      bindQualityOption(input, option)
    }

    simpleChoices.forEach(function (choice) {
      appendOption(
        state.qualityList,
        choice.option,
        choice.label,
        true,
        'dondownload-simple-quality',
        true
      )
    })

    view.options.forEach(function (option) {
      appendOption(state.advancedQualityList, option, null, true, 'dondownload-advanced-quality')
    })

    if (state.queueSelectedButton) {
      state.queueSelectedButton.disabled = core.isOptionQueued(
        state.media.queuedOptionIds,
        state.media.selectedOptionId
      )
    }
    updateOutputFormatControl()
  }

  function bindQualityOption(input, option) {
    on(input, 'change', function () {
      if (!input.checked) return
      state.media.selectedOptionId = option.optionId
      ;[state.qualityList, state.advancedQualityList].forEach(function (list) {
        if (!list) return
        for (var index = 0; index < list.children.length; index += 1) {
          var other = list.children[index].children[0]
          if (other && other !== input && other.mediaOptionId) {
            other.checked = other.mediaOptionId === option.optionId
          }
        }
      })
      if (state.queueSelectedButton) state.queueSelectedButton.disabled = false
      updateOutputFormatControl()
    })
  }

  function renderAnalysis(view) {
    var previousAnalysisId =
      state.media.analysis && state.media.analysis.analysisId
    var previousOptionId = state.media.selectedOptionId
    state.media.analysis = view
    if (state.analyzeButton) state.analyzeButton.hidden = true
    if (state.embedAnalyzeButton) state.embedAnalyzeButton.hidden = true
    if (!state.mediaResults) return
    state.mediaResults.hidden = false
    if (state.mediaTitle) state.mediaTitle.textContent = view.title

    var meta = []
    var duration = core.formatDuration(view.durationSeconds)
    if (duration) meta.push('Duration ' + duration)
    meta.push(
      String(view.videoOptions.length) +
        (view.videoOptions.length === 1 ? ' video option' : ' video options')
    )
    if (view.audioOptions.length > 0) {
      meta.push(
        String(view.audioOptions.length) +
          (view.audioOptions.length === 1 ? ' audio option' : ' audio options')
      )
    }
    if (state.mediaMeta) state.mediaMeta.textContent = meta.join(' · ')

    if (state.bestVideoButton) {
      var bestVideoOption = optionById(view, view.bestVideoOptionId)
      state.bestVideoButton.hidden = view.bestVideoOptionId === null
      state.bestVideoButton.textContent = bestVideoOption
        ? 'Best quality · ' + core.describeMediaSize(bestVideoOption)
        : 'Best quality'
      state.bestVideoButton.title = bestVideoOption ? bestVideoOption.label : 'Best quality'
    }
    if (state.bestAudioButton) {
      state.bestAudioButton.hidden = view.bestAudioOptionId === null
      var bestAudioOption = optionById(view, view.bestAudioOptionId)
      state.bestAudioButton.textContent = bestAudioOption
        ? 'Download audio-only: ' + bestAudioOption.label + ' · ' + core.describeMediaSize(bestAudioOption)
        : 'Download audio only'
    }
    // A cached/refresh render keeps the user's exact pinned option: it is only
    // preserved when it belongs to the same analysisId and still validates.
    renderQualityOptions(
      view,
      previousAnalysisId === view.analysisId ? previousOptionId : null
    )
    setMediaBusy(false)
    setMediaStatus(
      'Analysis ready. Sizes are reported by yt-dlp; choose an option to queue.',
      'info'
    )
  }

  function analyzePage() {
    // The worker derives the analyzed URL from the trusted sender tab. The
    // content script never supplies a blob:, manifest, segment, cookie or
    // header value here. This is the explicit retry path; a cached/ready
    // prefetch is shown instead of asking yt-dlp a second time.
    if (currentAnalysisView()) {
      adoptPrefetchResult()
      return
    }
    startPrefetch(pageUrlKey(), {
      force: true,
      analyzingText: 'Analyzing this page…'
    })
  }

  function analyzeEmbeddedPage() {
    if (!state.activeEmbed) return
    var result = usableEmbed(state.activeEmbed)
    if (!result.usable) {
      setMediaStatus(
        'That embedded player is no longer usable. Reload the page and try again.',
        'error'
      )
      return
    }
    // A separate analyze request for the visible top-frame embed src. It is
    // still authorized by the exact-origin sender check and the desktop app
    // revalidates the public target before yt-dlp runs.
    runAnalysis(
      { type: MEDIA_ANALYZE_EMBED, embedUrl: result.url },
      'Analyzing embedded video…'
    )
  }

  function runAnalysis(message, analyzingText) {
    if (state.disabled) return
    if (
      state.media.status === 'analyzing' ||
      state.media.status === 'queueing' ||
      state.media.status === 'analyzed' ||
      state.media.status === 'queued'
    ) {
      return
    }

    var token = ++state.media.token
    state.media.status = 'analyzing'
    resetMediaResults()
    if (state.analyzeButton) {
      state.analyzeButton.hidden = Boolean(state.activeEmbed)
      state.analyzeButton.textContent = copy.analyzingLabel
    }
    if (state.embedAnalyzeButton) {
      state.embedAnalyzeButton.hidden = !state.activeEmbed
      state.embedAnalyzeButton.textContent = copy.analyzingLabel
    }
    setMediaBusy(true)
    setMediaStatus(analyzingText || 'Analyzing…', 'info')

    sendRuntimeMessage(message, function (response, runtimeError) {
      if (token !== state.media.token || state.disabled) return
      if (state.analyzeButton) state.analyzeButton.textContent = copy.actionLabel
      if (state.embedAnalyzeButton) {
        state.embedAnalyzeButton.textContent = copy.embedActionLabel
      }
      setMediaBusy(false)

      if (runtimeError) {
        state.media.status = 'error'
        setMediaStatus(
          'The DonDownload background worker did not respond. Reload this page, then try again.',
          'error'
        )
        renderCapturedSources()
        return
      }
      if (!response || response.ok !== true || !response.analysis) {
        state.media.status = 'error'
        setMediaStatus(
          core.describeMediaError(
            response && response.error,
            'The page could not be analyzed. Try again in a moment.'
          ),
          'error'
        )
        renderCapturedSources()
        return
      }

      var view = core.mediaView(response.analysis)
      if (!view) {
        state.media.status = 'error'
        setMediaStatus('The analysis response was not valid. Try again.', 'error')
        renderCapturedSources()
        return
      }

      state.media.status = 'analyzed'
      renderAnalysis(view)
    })
  }

  function optionById(view, optionId) {
    if (!view || typeof optionId !== 'string') return null
    for (var index = 0; index < view.options.length; index += 1) {
      if (view.options[index].optionId === optionId) return view.options[index]
    }
    return null
  }

  function isStaleAnalysisError(error) {
    var code = error && typeof error.code === 'string' ? error.code : ''
    return (
      code === 'MEDIA_ANALYSIS_EXPIRED' ||
      code === 'MEDIA_ANALYSIS_NOT_FOUND' ||
      code === 'MEDIA_ANALYSIS_MISMATCH' ||
      code === 'MEDIA_OPTION_INVALID' ||
      code === 'INVALID_MEDIA_OPTION'
    )
  }

  function queueOption(optionId, done) {
    function finish(result) {
      if (typeof done === 'function') done(result)
    }
    if (state.disabled) return finish({ ok: false })
    if (state.media.status === 'analyzing') return finish({ ok: false })
    if (state.media.status === 'queueing') return finish({ ok: false })
    if (!state.media.analysis) return finish({ ok: false })

    var analysis = state.media.analysis
    // Pin the exact verified option the user picked. A missing identifier is a
    // hard error; never fall back to the best/last option.
    var option = core.optionById(analysis, optionId)
    if (!option) {
      state.media.status = 'error'
      setMediaStatus(
        core.describeMediaError(
          { code: 'MEDIA_OPTION_INVALID', message: 'The selected option is not available.' },
          'The selected option is not available. Analyze this page again.'
        ),
        'error'
      )
      finish({
        ok: false,
        error: { code: 'MEDIA_OPTION_INVALID', message: 'The selected option is not available.' }
      })
      return
    }
    if (optionIsQueued(option.optionId)) {
      setMediaStatus('Already added to DonDownload ✓', 'success')
      finish({ ok: false, error: { code: 'MEDIA_DUPLICATE_JOB', message: 'This option is already queued.' } })
      return
    }

    var token = ++state.media.queueToken
    state.media.status = 'queueing'
    setMediaBusy(true)
    setMediaStatus('Queueing ' + option.label + '…', 'info')

    sendRuntimeMessage(
      {
        type: MEDIA_QUEUE,
        analysisId: analysis.analysisId,
        optionId: option.optionId,
        outputFormat: core.normalizeOutputFormat(
          option,
          state.media.outputFormat
        )
      },
      function (response, runtimeError) {
        if (token !== state.media.queueToken || state.disabled) return
        if (runtimeError) {
          setMediaBusy(false)
          state.media.status = 'error'
          setMediaStatus(
            'The DonDownload background worker did not respond. Reload this page, then try again.',
            'error'
          )
          finish({
            ok: false,
            error: { code: 'BACKGROUND_UNAVAILABLE', message: 'The background worker did not respond.' }
          })
          return
        }
        if (!response || response.ok !== true || !response.job) {
          setMediaBusy(false)
          state.media.status = 'error'
          setMediaStatus(
            core.describeMediaError(
              response && response.error,
              'The download could not be queued. Analyze this page again.'
            ),
            'error'
          )
          // An expired or no-longer-valid pinned option is never replaced by
          // another quality. Clear the stale choice and offer a fresh analysis.
          if (isStaleAnalysisError(response && response.error)) {
            state.media.queuedOptionIds = []
            state.prefetch.status = 'error'
            state.prefetch.analysis = null
            state.prefetch.expiresAt = 0
            state.prefetch.error = response && response.error ? response.error : null
            resetMediaResults()
            renderCapturedSources()
          }
          finish(response || { ok: false })
          return
        }

        state.media.status = 'queued'
        state.media.queuedOptionIds = core.markOptionQueued(
          state.media.queuedOptionIds,
          option.optionId
        )
        // Re-apply busy state only after recording the exact option, so this
        // row shows its confirmation and cannot be queued twice.
        setMediaBusy(false)
        setMediaStatus('Added to DonDownload ✓ — downloading in the app', 'success')
        finish({ ok: true, job: response.job })
      }
    )
  }

  function cancelHide() {
    if (!state.hideTimer) return
    window.clearTimeout(state.hideTimer)
    state.hideTimer = 0
  }

  function scheduleHide() {
    if (state.panelOpen || shouldKeepVisible()) return
    cancelHide()
    state.hideTimer = window.setTimeout(function () {
      state.hideTimer = 0
      if (state.panelOpen || shouldKeepVisible()) return
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
    if (state.activeEmbed) closePanel(false)
    state.activeEmbed = null
    state.activeVideo = video
    observePlayer(video)
    observeVideoSize(video)
    renderCapturedSources()
    schedulePrefetch()
    cancelHide()
    state.host.hidden = false
    state.trigger.hidden = false
    position()
  }

  /**
   * Show the overlay for a visible top-frame embed. This never injects into the
   * iframe: only its rectangle and http(s) src are read so the worker can run
   * the existing page analysis against that embed URL as a separate request.
   */
  function showForEmbed(iframe) {
    if (state.disabled || !iframe) return
    ensureUi()
    if (!state.host) return
    if (!usableEmbed(iframe).usable) return
    if (hasPlayingTopFrameVideo()) return

    if (state.activeVideo || (state.activeEmbed && state.activeEmbed !== iframe)) {
      closePanel(false)
    }
    // An analysis belongs to the previously attached player/page target. Never
    // let its opaque options be queued for a different embed, and never keep a
    // top-page prefetch in flight while the embed analysis runs (one analysis
    // at a time per tab).
    if (
      state.media.analysis ||
      state.media.status === 'analyzing' ||
      state.prefetch.status !== 'idle'
    ) {
      state.media.token += 1
      state.media.queueToken += 1
      state.media.status = 'idle'
      resetMediaResults()
      resetPrefetchForNavigation()
    }
    state.activeVideo = null
    state.activeEmbed = iframe
    observeVideoSize(iframe)
    renderCapturedSources()
    cancelHide()
    state.host.hidden = false
    state.trigger.hidden = false
    position()
  }

  function hideNow() {
    cancelHide()
    if (state.panelOpen) closePanel(false)
    state.activeVideo = null
    state.activeEmbed = null
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
    // Cached options appear immediately; otherwise the debounced background
    // analysis starts now and the same button becomes the "Finding qualities…"
    // spinner. This never runs yt-dlp twice for the same settled page URL.
    ensurePrefetchForPanel()
    renderCapturedSources()
    if (prefetchInFlight() && state.status && !state.status.textContent) {
      setMediaStatus(copy.analyzingLabel, 'info')
    }
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
    var target = state.activeVideo || state.activeEmbed
    if (state.disabled || !target || !state.trigger || state.trigger.hidden) {
      return
    }

    var result = state.activeVideo ? usable(state.activeVideo) : usableEmbed(target)
    if (!result.usable) {
      hideNow()
      return
    }

    var rect = target.getBoundingClientRect()
    var triggerRect
    if (
      state.triggerOffset &&
      typeof state.triggerOffset.x === 'number' &&
      typeof state.triggerOffset.y === 'number' &&
      rect.width > 0 &&
      rect.height > 0
    ) {
      var maxLeft = Math.max(0, (window.innerWidth || document.documentElement.clientWidth || 0) - 30 - 8)
      var maxTop = Math.max(0, (window.innerHeight || document.documentElement.clientHeight || 0) - 30 - 8)
      triggerRect = {
        left: clampNumber(rect.left + state.triggerOffset.x * rect.width, 8, maxLeft),
        top: clampNumber(rect.top + state.triggerOffset.y * rect.height, 8, maxTop)
      }
    } else {
      triggerRect = core.placeTrigger(rect, viewport())
    }
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
      maybeResetCaptureForNavigation()
      pruneDisconnectedPlayers()
      installSourceObservers()
      syncFloatingTrigger()
      if (state.activeEmbed) {
        if (
          state.activeEmbed.isConnected === false ||
          !usableEmbed(state.activeEmbed).usable
        ) {
          hideNow()
          return
        }
        scheduleReposition()
        return
      }
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
    clearPrefetchTimer()
    if (state.navigationTimer) {
      try {
        window.clearInterval(state.navigationTimer)
      } catch {
        // Best effort.
      }
      state.navigationTimer = 0
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
    releaseCapturePlayers()
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

  function handlePointerOver(event) {
    if (state.disabled) return
    if (pathIncludesOverlay(event)) {
      cancelHide()
      return
    }
    var path = eventPath(event)
    var video = core.findVideoInPath(path)
    if (video) {
      if (video === state.activeVideo) {
        cancelHide()
        return
      }
      showFor(video)
      return
    }

    var iframe = core.findIframeInPath(path)
    if (!iframe) return
    if (iframe === state.activeEmbed) {
      cancelHide()
      return
    }
    // Embedded players are only offered when no top-frame video is playing.
    if (hasPlayingTopFrameVideo()) return
    if (usableEmbed(iframe).usable) showForEmbed(iframe)
  }

  function handlePointerOut(event) {
    if (state.disabled) return
    var path = eventPath(event)
    if (state.activeEmbed) {
      var iframe = core.findIframeInPath(path)
      if (iframe !== state.activeEmbed) return
    } else if (state.activeVideo) {
      var video = core.findVideoInPath(path)
      if (video !== state.activeVideo) return
    } else {
      return
    }
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

  function handleToggleCommand() {
    if (state.disabled) return false
    if (state.panelOpen) {
      closePanel(true)
      return true
    }
    var video =
      (state.activeVideo && usable(state.activeVideo).usable
        ? state.activeVideo
        : null) ||
      largestPlayingVideo() ||
      largestUsableVideo()
    if (video) {
      showFor(video)
    } else {
      var iframe =
        (state.activeEmbed && usableEmbed(state.activeEmbed).usable
          ? state.activeEmbed
          : null) || largestUsableEmbed()
      if (!iframe) return false
      showForEmbed(iframe)
    }
    openPanel()
    if (state.trigger) state.trigger.focus()
    return true
  }

  function handleSpaNavigation() {
    if (!maybeResetCaptureForNavigation()) {
      syncFloatingTrigger()
      schedulePrefetch()
    }
  }

  function installListeners() {
    on(document, 'pointerover', handlePointerOver, true)
    on(document, 'pointerout', handlePointerOut, true)
    on(document, 'pointerdown', handleDocumentPointerDown, true)
    on(document, 'fullscreenchange', handleFullscreenChange, true)
    on(window, 'popstate', handleSpaNavigation)
    on(window, 'hashchange', handleSpaNavigation)
    on(window, 'pageshow', handleSpaNavigation)
    // YouTube and similar SPA players reuse the same <video> element and only
    // change the URL. These events reset the icon/source/analysis state for the
    // new page without a reload.
    on(document, 'yt-navigate-finish', handleSpaNavigation)
    on(window, 'yt-navigate-finish', handleSpaNavigation)
    on(document, 'yt-page-data-updated', handleSpaNavigation)
    on(document, 'visibilitychange', function () {
      if (!document.hidden) {
        syncFloatingTrigger()
        schedulePrefetch()
      }
    })
    on(window, 'scroll', scheduleReposition, { capture: true, passive: true })
    on(window, 'resize', scheduleReposition, { passive: true })
    if (window.visualViewport) {
      on(window.visualViewport, 'resize', scheduleReposition, { passive: true })
      on(window.visualViewport, 'scroll', scheduleReposition, { passive: true })
    }
    // Content scripts cannot observe the page's own history.pushState calls
    // across the isolated world. A cheap URL check catches those SPA moves even
    // when no event reaches this script.
    if (typeof window.setInterval === 'function') {
      state.navigationTimer = window.setInterval(function () {
        maybeResetCaptureForNavigation()
      }, 500)
      state.cleanup.push(function () {
        if (state.navigationTimer) {
          window.clearInterval(state.navigationTimer)
          state.navigationTimer = 0
        }
      })
    }
  }

  function querySourceList() {
    var player = playerFor(state.activeVideo)
    if (!player) {
      var playing = largestPlayingVideo() || largestTriggerVideo()
      player = playing ? playerFor(playing) : null
    }
    if (!player) return []
    return player.sources.map(function (source) {
      return {
        url: source.url,
        filename: source.filename,
        container: source.container,
        qualityLabel: source.qualityLabel || null,
        current: source.current === true
      }
    })
  }

  function captureQueryResponse(streaming) {
    return {
      ok: true,
      origin: location.origin,
      url: pageUrlKey(),
      sources: querySourceList(),
      streaming: streaming || streamingForQuery(),
      analysis: currentAnalysisView(),
      status: queryAnalysisStatus(),
      queuedOptionIds: state.media.queuedOptionIds.slice()
    }
  }

  function downloadQueriedSource(url, done) {
    var player = playerFor(state.activeVideo)
    if (!player) {
      var playing = largestPlayingVideo()
      player = playing ? playerFor(playing) : null
    }
    if (!player || typeof url !== 'string') {
      done({ ok: false, error: { code: 'CAPTURE_NOT_FOUND', message: 'That source is no longer available.' } })
      return
    }
    for (var index = 0; index < player.sources.length; index += 1) {
      if (player.sources[index] && player.sources[index].url === url) {
        queueCapturedSource(player.sources[index], done)
        return
      }
    }
    done({ ok: false, error: { code: 'CAPTURE_NOT_FOUND', message: 'That source is no longer available.' } })
  }

  function installRuntimeListener() {
    if (!chrome || !chrome.runtime || !chrome.runtime.onMessage) return
    if (typeof chrome.runtime.onMessage.addListener !== 'function') return
    state.runtimeListener = function (message, sender, sendResponse) {
      var respond = typeof sendResponse === 'function' ? sendResponse : function () {}
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
        respond({ ok: handleToggleCommand() })
        return false
      }
      if (message && message.type === 'dondownload:capture-query') {
        // A streaming player seen by the popup reuses the same debounced
        // background analysis. Opening the popup therefore never triggers a
        // second yt-dlp run when one is already cached or in flight. An embed
        // uses its own explicit embed analysis instead.
        var streaming = streamingForQuery()
        if (streaming.detected && streaming.embedded !== true) {
          schedulePrefetch(0)
        }
        respond(captureQueryResponse(streaming))
        return false
      }
      if (message && message.type === MEDIA_PAGE_ANALYZE) {
        if (currentAnalysisView()) {
          respond({ ok: true, status: 'ready', analysis: currentAnalysisView() })
          return false
        }
        if (state.activeEmbed) {
          analyzeEmbeddedPage()
          respond({ ok: true, status: 'analyzing' })
          return false
        }
        if (!prefetchInFlight()) {
          // Explicit retry from the popup. The worker still derives the URL
          // from the trusted sender tab; the popup never supplies one.
          startPrefetch(pageUrlKey(), {
            force: true,
            analyzingText: 'Finding qualities…'
          })
        }
        respond({ ok: true, status: 'analyzing' })
        return false
      }
      if (message && message.type === MEDIA_PAGE_QUEUE) {
        var popupView = currentAnalysisView()
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
        if (optionIsQueued(message.optionId)) {
          respond({
            ok: false,
            error: { code: 'MEDIA_DUPLICATE_JOB', message: 'This option is already queued.' }
          })
          return false
        }
        queueOption(message.optionId, respond)
        return true
      }
      if (message && message.type === 'dondownload:capture-download') {
        downloadQueriedSource(message.url, respond)
        return true
      }
      if (message && message.type === NETWORK_EVIDENCE) {
        if (typeof message.url === 'string') {
          handleNetworkEvidence(message.url, message.evidence)
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

  try {
    ensureUi()
    installListeners()
    observeMutations()
    installSourceObservers()
    installRuntimeListener()
    installSettingsListener()
    restoreCaptureSettings()
    restoreTriggerOffsets()
    announceReady()
  } catch {
    // Fail closed: a broken overlay must never interfere with the page player.
    state.disabled = true
  }
})()
