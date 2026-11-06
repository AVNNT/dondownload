;(function () {
  'use strict'

  var ns = globalThis.DonDownloadOverlay
  if (!ns || ns.started) return

  var state = ns.state
  var core = ns.core
  var copy = ns.copy

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
    var video = state.activeVideo || ns.largestTriggerVideo()
    if (!video) return false
    var player = ns.playerFor(video)
    if (!player) return false
    if (core.isStreamingUnsupported(player.unsupported)) return true
    if (player.sources.length > 0) return false
    // An extensionless URL is waiting for exact response evidence, not for
    // yt-dlp; a verified progressive URL already has a one-click row.
    if (player.playbackKind === 'needs-evidence') return false
    if (player.playbackKind === 'verified') return false
    if (!ns.isTriggerReady(video)) return false
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
        if (state.panelOpen) ns.renderCapturedSources()
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
      ns.setMediaStatus(copy.analyzingLabel, 'info')
      ns.renderCapturedSources()
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
      ns.setMediaStatus(options.analyzingText || copy.analyzingLabel, 'info')
    }

    ns.sendRuntimeMessage({ type: ns.MEDIA_ANALYZE }, function (response, runtimeError) {
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
      ns.setMediaStatus(message || copy.actionLabel, 'error')
      ns.renderCapturedSources()
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
    if (state.activeEmbed && ns.usableEmbed(state.activeEmbed).usable) {
      return {
        detected: true,
        embedded: true,
        code: 'EMBED_PLAYER',
        message: 'Embedded video detected. Find qualities for it in the panel.'
      }
    }
    var player = ns.playerFor(state.activeVideo)
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
      var label = ns.createElement('label', 'quality-option')
      var input = ns.createElement('input', 'quality-input')
      input.type = 'radio'
      input.name = radioName
      input.value = option.optionId
      input.mediaOptionId = option.optionId
      input.mediaOption = option
      input.checked = option.optionId === initialId
      label.appendChild(input)

      var copyNode = ns.createElement('span', 'quality-copy')
      copyNode.appendChild(ns.createElement('span', '', displayLabel || option.label))
      var detail = includeDetails ? core.describeMediaDetails(option) : ''
      if (detail) copyNode.appendChild(ns.createElement('span', 'quality-detail', detail))
      var sizeLabel = core.describeMediaSize(option)
      var sizeNode = ns.createElement(
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
        var queueButton = ns.createElement(
          'button',
          'source-action quality-queue',
          queued ? 'Added ✓' : 'Download'
        )
        queueButton.type = 'button'
        queueButton.disabled = queued || state.media.status === 'queueing'
        var queueClick = function (event) {
          ns.stopPlayerEvent(event)
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
    ns.on(input, 'change', function () {
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
    ns.setMediaStatus(
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
    var result = ns.usableEmbed(state.activeEmbed)
    if (!result.usable) {
      ns.setMediaStatus(
        'That embedded player is no longer usable. Reload the page and try again.',
        'error'
      )
      return
    }
    // A separate analyze request for the visible top-frame embed src. It is
    // still authorized by the exact-origin sender check and the desktop app
    // revalidates the public target before yt-dlp runs.
    runAnalysis(
      { type: ns.MEDIA_ANALYZE_EMBED, embedUrl: result.url },
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
    ns.setMediaStatus(analyzingText || 'Analyzing…', 'info')

    ns.sendRuntimeMessage(message, function (response, runtimeError) {
      if (token !== state.media.token || state.disabled) return
      if (state.analyzeButton) state.analyzeButton.textContent = copy.actionLabel
      if (state.embedAnalyzeButton) {
        state.embedAnalyzeButton.textContent = copy.embedActionLabel
      }
      setMediaBusy(false)

      if (runtimeError) {
        state.media.status = 'error'
        ns.setMediaStatus(
          'The DonDownload background worker did not respond. Reload this page, then try again.',
          'error'
        )
        ns.renderCapturedSources()
        return
      }
      if (!response || response.ok !== true || !response.analysis) {
        state.media.status = 'error'
        ns.setMediaStatus(
          core.describeMediaError(
            response && response.error,
            'The page could not be analyzed. Try again in a moment.'
          ),
          'error'
        )
        ns.renderCapturedSources()
        return
      }

      var view = core.mediaView(response.analysis)
      if (!view) {
        state.media.status = 'error'
        ns.setMediaStatus('The analysis response was not valid. Try again.', 'error')
        ns.renderCapturedSources()
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
      ns.setMediaStatus(
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
      ns.setMediaStatus('Already added to DonDownload ✓', 'success')
      finish({ ok: false, error: { code: 'MEDIA_DUPLICATE_JOB', message: 'This option is already queued.' } })
      return
    }

    var token = ++state.media.queueToken
    state.media.status = 'queueing'
    setMediaBusy(true)
    ns.setMediaStatus('Queueing ' + option.label + '…', 'info')

    ns.sendRuntimeMessage(
      {
        type: ns.MEDIA_QUEUE,
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
          ns.setMediaStatus(
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
          ns.setMediaStatus(
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
            ns.renderCapturedSources()
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
        ns.setMediaStatus('Added to DonDownload ✓ — downloading in the app', 'success')
        finish({ ok: true, job: response.job })
      }
    )
  }


  ns.pageUrlKey = pageUrlKey
  ns.clearPrefetchTimer = clearPrefetchTimer
  ns.canAutoPrefetch = canAutoPrefetch
  ns.resetPrefetchForNavigation = resetPrefetchForNavigation
  ns.prefetchView = prefetchView
  ns.currentAnalysisView = currentAnalysisView
  ns.adoptPrefetchResult = adoptPrefetchResult
  ns.prefetchInFlight = prefetchInFlight
  ns.schedulePrefetch = schedulePrefetch
  ns.startPrefetch = startPrefetch
  ns.failPrefetch = failPrefetch
  ns.ensurePrefetchForPanel = ensurePrefetchForPanel
  ns.queryAnalysisStatus = queryAnalysisStatus
  ns.streamingForQuery = streamingForQuery
  ns.clearQualityList = clearQualityList
  ns.resetMediaResults = resetMediaResults
  ns.updateOutputFormatControl = updateOutputFormatControl
  ns.updateQualitySizeLabels = updateQualitySizeLabels
  ns.optionIsQueued = optionIsQueued
  ns.qualityRowQueued = qualityRowQueued
  ns.setMediaBusy = setMediaBusy
  ns.renderQualityOptions = renderQualityOptions
  ns.bindQualityOption = bindQualityOption
  ns.renderAnalysis = renderAnalysis
  ns.analyzePage = analyzePage
  ns.analyzeEmbeddedPage = analyzeEmbeddedPage
  ns.runAnalysis = runAnalysis
  ns.optionById = optionById
  ns.isStaleAnalysisError = isStaleAnalysisError
  ns.queueOption = queueOption
})()
