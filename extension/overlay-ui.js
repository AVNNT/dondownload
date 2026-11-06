;(function () {
  'use strict'

  var ns = globalThis.DonDownloadOverlay
  if (!ns || ns.started) return

  var state = ns.state
  var core = ns.core
  var copy = ns.copy

  var STYLES = [
    ':host { all: initial; }',
    ':host { box-sizing: border-box; font-family: "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif; font-size: 12px; line-height: 1.45; }',
    '[hidden] { display: none !important; }',
    '.trigger {',
    '  position: fixed;',
    '  align-items: center;',
    '  justify-content: center;',
    '  width: 30px;',
    '  height: 30px;',
    '  margin: 0;',
    '  padding: 0;',
    '  border: 1px solid rgba(255, 255, 255, 0.18);',
    '  border-radius: 999px;',
    '  background: rgba(0, 0, 0, 0.82);',
    '  color: #fff;',
    '  cursor: pointer;',
    '  display: flex;',
    '  font: 700 10px/1 "Segoe UI", system-ui, sans-serif;',
    '  letter-spacing: 0.04em;',
    '  opacity: 0.94;',
    '  pointer-events: auto;',
    '  backdrop-filter: blur(8px);',
    '  -webkit-backdrop-filter: blur(8px);',
    '  transition: opacity 120ms ease, border-color 120ms ease, background 120ms ease;',
    '  user-select: none;',
    '}',
    '.trigger:hover, .trigger:focus-visible {',
    '  border-color: #60a5fa;',
    '  background: #3b82f6;',
    '  opacity: 1;',
    '  outline: 2px solid rgba(96, 165, 250, 0.6);',
    '  outline-offset: 2px;',
    '}',
    '.panel {',
    '  position: fixed;',
    '  width: 292px;',
    '  max-height: calc(100vh - 16px);',
    '  overflow: auto;',
    '  padding: 14px;',
    '  border: 1px solid rgba(255, 255, 255, 0.1);',
    '  border-radius: 8px;',
    '  background: #0a0a0a;',
    '  color: #f5f5f5;',
    '  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.7);',
    '  box-sizing: border-box;',
    '  color-scheme: dark;',
    '  font: 12px/1.5 "Segoe UI", system-ui, sans-serif;',
    '  pointer-events: auto;',
    '  text-align: left;',
    '  outline: none;',
    '}',
    '.panel-head {',
    '  align-items: center;',
    '  display: flex;',
    '  gap: 8px;',
    '  justify-content: space-between;',
    '  margin-bottom: 10px;',
    '}',
    '.panel-title { color: #f5f5f5; font-size: 13px; font-weight: 700; letter-spacing: 0.01em; display: inline-flex; align-items: center; gap: 7px; }',
    '.panel-title::before { content: ""; width: 16px; height: 16px; border-radius: 5px; background: #3b82f6; flex: none; }',
    '.panel-badge {',
    '  border: 1px solid rgba(96, 165, 250, 0.4);',
    '  border-radius: 999px;',
    '  color: #60a5fa;',
    '  font-size: 9px;',
    '  letter-spacing: 0.08em;',
    '  padding: 2px 7px;',
    '  text-transform: uppercase;',
    '}',
    '.panel-notice { color: #fff; font-size: 12.5px; font-weight: 650; line-height: 1.45; margin: 0 0 8px; }',
    '.panel-detail { color: #a1a1aa; font-size: 11.5px; line-height: 1.55; margin: 0 0 12px; }',
    '.action {',
    '  background: #3b82f6;',
    '  border: 1px solid #3b82f6;',
    '  border-radius: 8px;',
    '  color: #fff;',
    '  cursor: pointer;',
    '  font: inherit;',
    '  font-size: 12px;',
    '  font-weight: 650;',
    '  padding: 8px 10px;',
    '  width: 100%;',
    '}',
    '.action:hover:not(:disabled) { background: #60a5fa; border-color: #60a5fa; }',
    '.action:disabled { cursor: not-allowed; opacity: 0.55; }',
    '.action.secondary {',
    '  background: transparent;',
    '  border-color: #2b2b2b;',
    '  color: #a8a8a8;',
    '  font-weight: 500;',
    '  margin-top: 6px;',
    '}',
    '.action.secondary:hover:not(:disabled) { background: #141414; border-color: #3b82f6; color: #f5f5f5; }',
    '.sources { border-top: 1px solid #1f1f23; margin-top: 10px; padding-top: 9px; }',
    '.sources-title { color: #d4d4d8; font-size: 11px; font-weight: 650; margin: 0 0 6px; text-transform: uppercase; letter-spacing: 0.06em; }',
    '.source-list, .sniffed-list { display: grid; gap: 5px; }',
    '.source { align-items: center; background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 8px; display: flex; gap: 8px; padding: 9px 11px; }',
    '.source[data-current="true"] { border-color: rgba(59, 130, 246, 0.4); }',
    '.source:hover { border-color: rgba(255, 255, 255, 0.18); }',
    '.source-copy { min-width: 0; flex: 1; }',
    '.source-title { color: #f5f5f5; display: block; font-size: 11.5px; line-height: 1.35; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
    '.source-detail { color: #858585; display: block; font-size: 10px; margin-top: 1px; }',
    '.source-action { background: #3b82f6; border: 1px solid #3b82f6; border-radius: 8px; color: #fff; cursor: pointer; flex: none; font: inherit; font-size: 10.5px; font-weight: 650; padding: 6px 9px; }',
    '.source-action:hover:not(:disabled) { background: #60a5fa; border-color: #60a5fa; }',
    '.source-action:disabled { cursor: not-allowed; opacity: 0.55; }',
    '.source-empty, .sniffed-empty { color: #858585; font-size: 11px; line-height: 1.5; margin: 0; }',
    '.source[data-unsupported="true"] { border-color: #2b2b2b; }',
    '.source[data-unsupported="true"] .source-title { color: #f87171; }',
    '.source[data-unsupported="true"] .source-detail { color: #a8a8a8; white-space: normal; }',
    '.media-results { margin-top: 10px; }',
    '.media-title { color: #fff; font-size: 12.5px; font-weight: 650; line-height: 1.4; margin: 0 0 3px; overflow-wrap: anywhere; }',
    '.media-meta { color: #a1a1aa; font-size: 11px; line-height: 1.45; margin: 0 0 8px; }',
    '.media-actions { display: grid; gap: 6px; }',
    '.qualities { border: 0; margin: 10px 0 0; padding: 0; }',
    '.qualities legend { color: #d4d4d8; font-size: 11.5px; font-weight: 650; padding: 0; }',
    '.quality-list, .advanced-quality-list { display: grid; gap: 4px; margin: 6px 0; }',
    '.quality-option {',
    '  align-items: center;',
    '  background: rgba(255, 255, 255, 0.03);',
    '  border: 1px solid rgba(255, 255, 255, 0.08);',
    '  border-radius: 8px;',
    '  color: #f5f5f5;',
    '  cursor: pointer;',
    '  display: flex;',
    '  font-size: 12.5px;',
    '  gap: 10px;',
    '  line-height: 1.4;',
    '  padding: 9px 11px;',
    '  transition: background 120ms ease, border-color 120ms ease;',
    '}',
    '.quality-option:hover { background: rgba(255, 255, 255, 0.06); border-color: rgba(255, 255, 255, 0.18); }',
    '.quality-option:focus-within { border-color: #3b82f6; }',
    '.quality-option input { appearance: none; -webkit-appearance: none; width: 14px; height: 14px; border-radius: 50%; border: 1.5px solid #858585; margin: 0; flex: none; }',
    '.quality-option input:checked { border: 4px solid #3b82f6; }',
    '.quality-copy { display: block; min-width: 0; overflow-wrap: anywhere; flex: 1; }',
    '.quality-detail { color: #858585; display: block; font-size: 10.5px; margin-top: 1px; }',
    '.quality-size { color: #a8a8a8; display: block; font-size: 10.5px; font-variant-numeric: tabular-nums; margin-top: 1px; }',
    '.quality-size.unknown { color: #858585; }',
    '.output-format { color: #a8a8a8; display: block; font-size: 11.5px; margin: 8px 0 0; }',
    '.output-format select {',
    '  background: #0a0a0a;',
    '  border: 1px solid #1c1c1c;',
    '  border-radius: 8px;',
    '  color: #f5f5f5;',
    '  display: block;',
    '  font: inherit;',
    '  font-size: 11.5px;',
    '  margin-top: 4px;',
    '  padding: 6px 8px;',
    '  width: 100%;',
    '}',
    '.advanced-qualities { border-top: 1px solid #1f1f23; margin-top: 10px; padding-top: 8px; }',
    '.advanced-qualities summary { color: #d4d4d8; cursor: pointer; font-size: 11px; font-weight: 600; }',
    '.options { border-top: 1px solid #1f1f23; margin-top: 12px; padding-top: 10px; }',
    '.options summary { color: #d4d4d8; cursor: pointer; font-size: 11.5px; font-weight: 650; }',
    '.options-hint { color: #8b8b93; font-size: 11px; line-height: 1.5; margin: 8px 0; }',
    '.disable {',
    '  background: transparent;',
    '  border: 1px solid #2b2b2b;',
    '  border-radius: 8px;',
    '  color: #a8a8a8;',
    '  cursor: pointer;',
    '  font: inherit;',
    '  font-size: 11.5px;',
    '  padding: 7px 9px;',
    '  width: 100%;',
    '}',
    '.disable:hover:not(:disabled) { background: #141414; border-color: #f87171; color: #f87171; }',
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

  function usable(video) {
    return core.evaluateVideoCandidate(ns.candidateFor(video), ns.viewport())
  }


  function iframeCandidateFor(iframe) {
    return {
      tagName: iframe.tagName,
      isConnected: iframe.isConnected,
      hidden: iframe.hidden,
      src: iframe.src,
      rect: iframe.getBoundingClientRect(),
      styles: ns.readStyles(iframe)
    }
  }


  function usableEmbed(iframe) {
    return core.evaluateIframeCandidate(iframeCandidateFor(iframe), ns.viewport())
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
    return ns.largestPlayingVideo() !== null
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

    var trigger = ns.createElement('button', 'trigger', 'DD')
    trigger.type = 'button'
    trigger.hidden = true
    trigger.setAttribute('title', 'DonDownload video options (' + copy.shortcutLabel + ')')
    trigger.setAttribute('aria-label', 'DonDownload video options')
    trigger.setAttribute('aria-haspopup', 'dialog')
    trigger.setAttribute('aria-expanded', 'false')

    var panel = ns.createElement('div', 'panel')
    panel.hidden = true
    panel.tabIndex = -1
    panel.setAttribute('role', 'dialog')
    panel.setAttribute('aria-label', 'DonDownload video options')

    var head = ns.createElement('div', 'panel-head')
    head.appendChild(ns.createElement('strong', 'panel-title', 'DonDownload'))
    head.appendChild(ns.createElement('span', 'panel-badge', 'Media'))

    var analyzeButton = ns.createElement('button', 'action', copy.actionLabel)
    analyzeButton.type = 'button'

    var embedAnalyzeButton = ns.createElement(
      'button',
      'action secondary embed-analyze',
      copy.embedActionLabel || 'Find qualities for embedded video'
    )
    embedAnalyzeButton.type = 'button'
    embedAnalyzeButton.hidden = true

    var sniffedSection = ns.createElement('section', 'sources sniffed')
    sniffedSection.appendChild(
      ns.createElement('p', 'sources-title', 'Detected media on this tab')
    )
    var sniffedList = ns.createElement('div', 'sniffed-list')
    var sniffedEmpty = ns.createElement(
      'p',
      'sniffed-empty',
      'Play or open media on this enabled site. Detected files, HLS and DASH streams appear here.'
    )
    sniffedSection.appendChild(sniffedList)
    sniffedSection.appendChild(sniffedEmpty)

    var sourceSection = ns.createElement('section', 'sources')
    sourceSection.appendChild(ns.createElement('p', 'sources-title', 'Detected from playback'))
    var sourceList = ns.createElement('div', 'source-list')
    var sourceEmpty = ns.createElement(
      'p',
      'source-empty',
      'No progressive playback detected yet. Start playing this video.'
    )
    sourceSection.appendChild(sourceList)
    sourceSection.appendChild(sourceEmpty)

    var mediaResults = ns.createElement('div', 'media-results')
    mediaResults.hidden = true

    var mediaTitle = ns.createElement('p', 'media-title', '')
    var mediaMeta = ns.createElement('p', 'media-meta', '')

    var mediaActions = ns.createElement('div', 'media-actions')
    var bestVideoButton = ns.createElement(
      'button',
      'action best-video',
      'Download best video + audio'
    )
    bestVideoButton.type = 'button'
    bestVideoButton.hidden = true

    var bestAudioButton = ns.createElement(
      'button',
      'action secondary best-audio',
      'Download audio only'
    )
    bestAudioButton.type = 'button'
    bestAudioButton.hidden = true
    mediaActions.appendChild(bestVideoButton)
    mediaActions.appendChild(bestAudioButton)

    var simpleFieldset = ns.createElement('fieldset', 'qualities')
    simpleFieldset.hidden = true
    simpleFieldset.appendChild(ns.createElement('legend', '', 'Choose a quality'))
    var qualityList = ns.createElement('div', 'quality-list')
    simpleFieldset.appendChild(qualityList)

    var advancedDetails = document.createElement('details')
    advancedDetails.className = 'advanced-qualities'
    advancedDetails.appendChild(ns.createElement('summary', '', 'Advanced format options'))
    var qualityFieldset = ns.createElement('fieldset', 'advanced-quality-fieldset')
    qualityFieldset.hidden = true
    qualityFieldset.appendChild(ns.createElement('legend', '', 'All verified formats'))
    var advancedQualityList = ns.createElement('div', 'advanced-quality-list')
    qualityFieldset.appendChild(advancedQualityList)
    var outputFormatControl = ns.createElement('label', 'output-format', 'Output format')
    var outputFormatSelect = document.createElement('select')
    outputFormatSelect.className = 'output-format-select'
    ;['auto', 'mp4', 'mkv', 'webm'].forEach(function (format) {
      var outputOption = document.createElement('option')
      outputOption.value = format
      outputOption.textContent = core.mediaOutputFormatLabel(format)
      outputFormatSelect.appendChild(outputOption)
    })
    outputFormatControl.appendChild(outputFormatSelect)

    var queueSelectedButton = ns.createElement(
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
    options.appendChild(ns.createElement('summary', '', 'Options'))
    options.appendChild(ns.createElement('p', 'options-hint', copy.optionsHint))

    var disableButton = ns.createElement('button', 'disable', copy.disableLabel)
    disableButton.type = 'button'
    options.appendChild(disableButton)

    var status = ns.createElement('p', 'status', '')
    status.setAttribute('role', 'status')
    status.setAttribute('aria-live', 'polite')

    var panelNotice = ns.createElement('p', 'panel-notice', copy.title)
    var panelDetail = ns.createElement('p', 'panel-detail', copy.detail)
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
    panel.appendChild(sniffedSection)
    panel.appendChild(sourceSection)
    panel.appendChild(analyzeButton)
    panel.appendChild(embedAnalyzeButton)
    panel.appendChild(mediaResults)
    panel.appendChild(options)
    panel.appendChild(status)
    panel.appendChild(
      ns.createElement(
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
    state.sniffedSection = sniffedSection
    state.sniffedList = sniffedList
    state.sniffedEmpty = sniffedEmpty
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

    ns.on(trigger, 'pointerdown', stopPointerEvent)
    ns.on(trigger, 'click', function (event) {
      stopPlayerEvent(event)
      togglePanel()
    })
    ns.on(trigger, 'pointerenter', cancelHide)
    ns.on(trigger, 'pointerleave', scheduleHide)

    ns.on(panel, 'pointerdown', stopPointerEvent)
    // Isolate panel clicks from page player handlers without cancelling the
    // browser's native label/radio activation. Buttons still call
    // stopPlayerEvent explicitly.
    ns.on(panel, 'click', stopPropagationOnly)
    ns.on(panel, 'pointerenter', cancelHide)
    ns.on(panel, 'pointerleave', scheduleHide)
    ns.on(panel, 'keydown', function (event) {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      closePanel(true)
    })
    ns.on(analyzeButton, 'click', function (event) {
      stopPlayerEvent(event)
      ns.analyzePage()
    })
    ns.on(embedAnalyzeButton, 'click', function (event) {
      stopPlayerEvent(event)
      ns.analyzeEmbeddedPage()
    })
    ns.on(bestVideoButton, 'click', function (event) {
      stopPlayerEvent(event)
      if (!state.media.analysis) return
      ns.queueOption(state.media.analysis.bestVideoOptionId)
    })
    ns.on(bestAudioButton, 'click', function (event) {
      stopPlayerEvent(event)
      if (!state.media.analysis) return
      ns.queueOption(state.media.analysis.bestAudioOptionId)
    })
    ns.on(queueSelectedButton, 'click', function (event) {
      stopPlayerEvent(event)
      ns.queueOption(state.media.selectedOptionId)
    })
    ns.on(outputFormatSelect, 'change', function (event) {
      stopPropagationOnly(event)
      state.media.outputFormat = outputFormatSelect.value
      ns.updateOutputFormatControl()
    })
    ns.on(disableButton, 'click', function (event) {
      stopPlayerEvent(event)
      ns.disableSite()
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


  function installSettingsListener() {
    if (!chrome || !chrome.storage || !chrome.storage.onChanged) return
    if (typeof chrome.storage.onChanged.addListener !== 'function') return
    state.settingsListener = function (changes, area) {
      if (area !== 'local' || !changes || !changes.dondownloadCaptureSettings) return
      var settings = changes.dondownloadCaptureSettings.newValue
      // Excluding this site (or re-including it) is handled by the entry
      // script, which owns teardown.
      if (ns.isExcludedSite && ns.isExcludedSite(settings)) {
        if (ns.applyExclusions) ns.applyExclusions(settings)
        return
      }
      state.floatingEnabled = !settings || settings.floatingTriggerEnabled !== false
      if (state.floatingEnabled) syncFloatingTrigger()
      else if (!state.panelOpen) hideNow()
    }
    chrome.storage.onChanged.addListener(state.settingsListener)
  }


  function restoreCaptureSettings() {
    var local = ns.storageFor('local')
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


  /**
   * Older builds let the floating icon be dragged and saved its position per
   * site. The icon is fixed now, so remove any saved position once; otherwise
   * a previously dragged icon would stay stuck where it was dropped.
   */
  function clearLegacyTriggerOffsets() {
    var local = ns.storageFor('local')
    if (!local || typeof local.remove !== 'function') return
    try {
      local.remove('dondownloadTriggerOffsets', function () {
        if (chrome && chrome.runtime && chrome.runtime.lastError) return
      })
    } catch {
      // Nothing saved, or storage unavailable: the default placement is used.
    }
  }


  function syncFloatingTrigger() {
    if (state.disabled || !state.floatingEnabled || state.panelOpen) return
    var video = ns.largestTriggerVideo()
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
    return state.floatingEnabled && ns.isTriggerReady(state.activeVideo)
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
    ns.observePlayer(video)
    observeVideoSize(video)
    ns.renderCapturedSources()
    ns.schedulePrefetch()
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
      ns.resetMediaResults()
      ns.resetPrefetchForNavigation()
    }
    state.activeVideo = null
    state.activeEmbed = iframe
    observeVideoSize(iframe)
    ns.renderCapturedSources()
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
    ns.ensurePrefetchForPanel()
    ns.refreshSniffedMedia()
    ns.renderCapturedSources()
    if (ns.prefetchInFlight() && state.status && !state.status.textContent) {
      ns.setMediaStatus(copy.analyzingLabel, 'info')
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

    var rect = state.activeVideo ? ns.rectFor(state.activeVideo) : target.getBoundingClientRect()
    var triggerRect = core.placeTrigger(rect, ns.viewport())
    if (!triggerRect) {
      hideNow()
      return
    }
    state.trigger.style.left = triggerRect.left + 'px'
    state.trigger.style.top = triggerRect.top + 'px'

    if (!state.panelOpen || !state.panel) return
    var panelRect = state.panel.getBoundingClientRect()
    var panelPlacement = core.placePanel(triggerRect, ns.viewport(), {
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
      ns.maybeResetCaptureForNavigation()
      ns.pruneDisconnectedPlayers()
      ns.installSourceObservers()
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
      var rect = ns.rectFor(video)
      var area = rect.width * rect.height
      if (area > bestArea) {
        bestArea = area
        best = video
      }
    }
    return best
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
      ns.largestPlayingVideo() ||
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
    if (!ns.maybeResetCaptureForNavigation()) {
      syncFloatingTrigger()
      ns.schedulePrefetch()
    }
  }


  function installListeners() {
    ns.on(document, 'pointerover', handlePointerOver, true)
    ns.on(document, 'pointerout', handlePointerOut, true)
    ns.on(document, 'pointerdown', handleDocumentPointerDown, true)
    ns.on(document, 'fullscreenchange', handleFullscreenChange, true)
    ns.on(window, 'popstate', handleSpaNavigation)
    ns.on(window, 'hashchange', handleSpaNavigation)
    ns.on(window, 'pageshow', handleSpaNavigation)
    // YouTube and similar SPA players reuse the same <video> element and only
    // change the URL. These events reset the icon/source/analysis state for the
    // new page without a reload.
    ns.on(document, 'yt-navigate-finish', handleSpaNavigation)
    ns.on(window, 'yt-navigate-finish', handleSpaNavigation)
    ns.on(document, 'yt-page-data-updated', handleSpaNavigation)
    ns.on(document, 'visibilitychange', function () {
      if (!document.hidden) {
        syncFloatingTrigger()
        ns.schedulePrefetch()
      }
    })
    ns.on(window, 'scroll', scheduleReposition, { capture: true, passive: true })
    ns.on(window, 'resize', scheduleReposition, { passive: true })
    if (window.visualViewport) {
      ns.on(window.visualViewport, 'resize', scheduleReposition, { passive: true })
      ns.on(window.visualViewport, 'scroll', scheduleReposition, { passive: true })
    }
    // Content scripts cannot observe the page's own history.pushState calls
    // across the isolated world. A cheap URL check catches those SPA moves even
    // when no event reaches this script.
    if (typeof window.setInterval === 'function') {
      state.navigationTimer = window.setInterval(function () {
        ns.maybeResetCaptureForNavigation()
      }, 500)
      state.cleanup.push(function () {
        if (state.navigationTimer) {
          window.clearInterval(state.navigationTimer)
          state.navigationTimer = 0
        }
      })
    }
  }


  ns.usable = usable
  ns.iframeCandidateFor = iframeCandidateFor
  ns.usableEmbed = usableEmbed
  ns.largestUsableEmbed = largestUsableEmbed
  ns.hasPlayingTopFrameVideo = hasPlayingTopFrameVideo
  ns.eventPath = eventPath
  ns.pathIncludesOverlay = pathIncludesOverlay
  ns.ensureUi = ensureUi
  ns.stopPropagationOnly = stopPropagationOnly
  ns.stopPointerEvent = stopPointerEvent
  ns.stopPlayerEvent = stopPlayerEvent
  ns.installSettingsListener = installSettingsListener
  ns.restoreCaptureSettings = restoreCaptureSettings
  ns.clearLegacyTriggerOffsets = clearLegacyTriggerOffsets
  ns.syncFloatingTrigger = syncFloatingTrigger
  ns.shouldKeepVisible = shouldKeepVisible
  ns.scheduleTriggerBurst = scheduleTriggerBurst
  ns.cancelHide = cancelHide
  ns.scheduleHide = scheduleHide
  ns.showFor = showFor
  ns.showForEmbed = showForEmbed
  ns.hideNow = hideNow
  ns.togglePanel = togglePanel
  ns.openPanel = openPanel
  ns.closePanel = closePanel
  ns.position = position
  ns.scheduleReposition = scheduleReposition
  ns.observeVideoSize = observeVideoSize
  ns.observeMutations = observeMutations
  ns.largestUsableVideo = largestUsableVideo
  ns.handlePointerOver = handlePointerOver
  ns.handlePointerOut = handlePointerOut
  ns.handleDocumentPointerDown = handleDocumentPointerDown
  ns.handleFullscreenChange = handleFullscreenChange
  ns.handleToggleCommand = handleToggleCommand
  ns.handleSpaNavigation = handleSpaNavigation
  ns.installListeners = installListeners
})()
