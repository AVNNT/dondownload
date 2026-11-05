// Optional, per-site video overlay. Injected only after the user grants the
// exact origin from the extension popup. The content script never reads video
// source URLs, cookies or playback state. It asks the background worker to
// analyze the trusted tab URL on an explicit click and renders only verified
// analysis options returned by the native bridge.

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
  var MEDIA_QUEUE = 'dondownload:media-queue'

  var state = {
    active: true,
    disabled: false,
    disabling: false,
    host: null,
    shadow: null,
    trigger: null,
    panel: null,
    analyzeButton: null,
    mediaResults: null,
    mediaTitle: null,
    mediaMeta: null,
    bestVideoButton: null,
    bestAudioButton: null,
    qualityFieldset: null,
    qualityList: null,
    simpleFieldset: null,
    advancedQualityList: null,
    queueSelectedButton: null,
    disableButton: null,
    status: null,
    activeVideo: null,
    panelOpen: false,
    hideTimer: 0,
    repositionPending: false,
    mutationObserver: null,
    resizeObserver: null,
    runtimeListener: null,
    cleanup: [],
    media: {
      token: 0,
      queueToken: 0,
      status: 'idle',
      analysis: null,
      selectedOptionId: null
    }
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

    panel.appendChild(head)
    panel.appendChild(createElement('p', 'panel-notice', copy.title))
    panel.appendChild(createElement('p', 'panel-detail', copy.detail))
    panel.appendChild(analyzeButton)
    panel.appendChild(mediaResults)
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
    state.analyzeButton = analyzeButton
    state.mediaResults = mediaResults
    state.mediaTitle = mediaTitle
    state.mediaMeta = mediaMeta
    state.bestVideoButton = bestVideoButton
    state.bestAudioButton = bestAudioButton
    state.qualityFieldset = qualityFieldset
    state.qualityList = qualityList
    state.simpleFieldset = simpleFieldset
    state.advancedQualityList = advancedQualityList
    state.queueSelectedButton = queueSelectedButton
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

  function clearQualityList() {
    ;[state.qualityList, state.advancedQualityList].forEach(function (list) {
      if (!list) return
      while (list.children.length > 0) list.removeChild(list.children[0])
    })
  }

  function resetMediaResults() {
    state.media.analysis = null
    state.media.selectedOptionId = null
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
    if (state.queueSelectedButton) state.queueSelectedButton.disabled = true
    clearQualityList()
  }

  function setMediaBusy(busy) {
    if (state.panel) state.panel.setAttribute('aria-busy', busy ? 'true' : 'false')
    if (state.analyzeButton) state.analyzeButton.disabled = busy
    if (state.bestVideoButton) state.bestVideoButton.disabled = busy
    if (state.bestAudioButton) state.bestAudioButton.disabled = busy
    if (state.queueSelectedButton) {
      state.queueSelectedButton.disabled = busy || !state.media.selectedOptionId
    }
    ;[state.qualityList, state.advancedQualityList].forEach(function (list) {
      if (!list) return
      for (var index = 0; index < list.children.length; index += 1) {
        var input = list.children[index].children[0]
        if (input) input.disabled = busy
      }
    })
  }

  function renderQualityOptions(view) {
    clearQualityList()
    if (!state.qualityFieldset || !state.qualityList || !state.advancedQualityList) return

    if (view.options.length === 0) {
      state.qualityFieldset.hidden = true
      if (state.simpleFieldset) state.simpleFieldset.hidden = true
      return
    }
    state.qualityFieldset.hidden = false
    if (state.simpleFieldset) {
      state.simpleFieldset.hidden = view.videoOptions.length === 0 && view.audioOptions.length === 0
    }

    var initialId =
      view.bestVideoOptionId !== null
        ? view.bestVideoOptionId
        : view.bestAudioOptionId !== null
          ? view.bestAudioOptionId
          : view.options[0].optionId
    state.media.selectedOptionId = initialId

    function appendOption(list, option, displayLabel, includeDetails, radioName) {
      var label = createElement('label', 'quality-option')
      var input = createElement('input', 'quality-input')
      input.type = 'radio'
      input.name = radioName
      input.value = option.optionId
      input.mediaOptionId = option.optionId
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
      copyNode.appendChild(sizeNode)
      label.appendChild(copyNode)
      list.appendChild(label)
      bindQualityOption(input, option)
    }

    ;[1080, 720, 480, 360].forEach(function (height) {
      var option = view.videoOptions.find(function (candidate) {
        return candidate.hasAudio && candidate.height === height
      })
      if (option) {
        appendOption(
          state.qualityList,
          option,
          height + 'p',
          false,
          'dondownload-simple-quality'
        )
      }
    })
    var audioOption = optionById(view, view.bestAudioOptionId)
    if (audioOption) appendOption(state.qualityList, audioOption, 'Audio only', false, 'dondownload-simple-quality')

    view.options.forEach(function (option) {
      appendOption(state.advancedQualityList, option, null, true, 'dondownload-advanced-quality')
    })

    if (state.queueSelectedButton) state.queueSelectedButton.disabled = false
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
    })
  }

  function renderAnalysis(view) {
    state.media.analysis = view
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
    renderQualityOptions(view)
    setMediaBusy(false)
    setMediaStatus(
      'Analysis ready. Sizes are reported by yt-dlp; choose an option to queue.',
      'info'
    )
  }

  function analyzePage() {
    if (state.disabled || !state.analyzeButton) return
    if (state.media.status === 'analyzing' || state.media.status === 'queueing') return

    var token = ++state.media.token
    state.media.status = 'analyzing'
    resetMediaResults()
    state.analyzeButton.textContent = copy.analyzingLabel
    setMediaBusy(true)
    setMediaStatus('Analyzing this page…', 'info')

    sendRuntimeMessage({ type: MEDIA_ANALYZE }, function (response, runtimeError) {
      if (token !== state.media.token || state.disabled) return
      state.analyzeButton.textContent = copy.actionLabel
      setMediaBusy(false)

      if (runtimeError) {
        state.media.status = 'error'
        setMediaStatus(
          'The DonDownload background worker did not respond. Reload this page, then try again.',
          'error'
        )
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
        return
      }

      var view = core.mediaView(response.analysis)
      if (!view) {
        state.media.status = 'error'
        setMediaStatus('The analysis response was not valid. Try again.', 'error')
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

  function queueOption(optionId) {
    if (state.disabled || state.media.status === 'analyzing') return
    if (state.media.status === 'queueing') return
    if (!state.media.analysis) return

    var analysis = state.media.analysis
    var option = optionById(analysis, optionId)
    if (!option) {
      setMediaStatus('The selected option is not available. Analyze the page again.', 'error')
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
        optionId: option.optionId
      },
      function (response, runtimeError) {
        if (token !== state.media.queueToken || state.disabled) return
        setMediaBusy(false)

        if (runtimeError) {
          state.media.status = 'error'
          setMediaStatus(
            'The DonDownload background worker did not respond. Reload this page, then try again.',
            'error'
          )
          return
        }
        if (!response || response.ok !== true || !response.job) {
          state.media.status = 'error'
          setMediaStatus(
            core.describeMediaError(
              response && response.error,
              'The download could not be queued. Analyze the page again.'
            ),
            'error'
          )
          return
        }

        state.media.status = 'queued'
        var jobLabel =
          typeof response.job.label === 'string' && response.job.label.length > 0
            ? response.job.label
            : option.label
        setMediaStatus('Queued: ' + jobLabel, 'success')
      }
    )
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
    state.media.token += 1
    state.media.queueToken += 1
    if (state.host && state.host.parentNode) state.host.parentNode.removeChild(state.host)
    state.host = null
    state.shadow = null
    state.trigger = null
    state.panel = null
    state.analyzeButton = null
    state.mediaResults = null
    state.mediaTitle = null
    state.mediaMeta = null
    state.bestVideoButton = null
    state.bestAudioButton = null
    state.qualityFieldset = null
    state.qualityList = null
    state.simpleFieldset = null
    state.advancedQualityList = null
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
