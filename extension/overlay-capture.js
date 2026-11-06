;(function () {
  'use strict'

  var ns = globalThis.DonDownloadOverlay
  if (!ns || ns.started) return

  var state = ns.state
  var core = ns.core
  var copy = ns.copy
  var observedVideos = ns.observedVideos
  var suppressedSources = ns.suppressedSources

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
      var result = ns.usable(video)
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
      var result = ns.usable(video)
      if (!result.usable) continue
      var rect = ns.rectFor(video)
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
    state.capture.sniffed = []
    state.capture.sniffedQueued = []
    state.capture.sniffedRowCleanups = []
    state.capture.sniffedButtons = []
    state.capture.sniffedToken += 1
    state.capture.queueing = false
    state.activeEmbed = null
    // A fallback analysis also belongs to the previous document/page. Clear it
    // so its opaque option IDs can never be applied to a new SPA page.
    state.media.token += 1
    state.media.queueToken += 1
    state.media.status = 'idle'
    state.media.queuedOptionIds = []
    ns.resetPrefetchForNavigation()
    ns.resetMediaResults()
    if (state.analyzeButton) {
      state.analyzeButton.hidden = true
      state.analyzeButton.textContent = copy.actionLabel
      state.analyzeButton.disabled = false
    }
    if (state.embedAnalyzeButton) {
      state.embedAnalyzeButton.hidden = true
      state.embedAnalyzeButton.disabled = false
    }
    ns.setMediaStatus('', '')
    ns.hideNow()
    renderCapturedSources()
    installSourceObservers()
    // The reused player may already be playing for the new page. Show the icon
    // immediately and let the debounced prefetch start for the new URL.
    ns.syncFloatingTrigger()
    ns.schedulePrefetch()
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
    // KVS declares its progressive qualities in inline flashvars before play.
    // Attach them to this player immediately so the icon and rows are ready.
    if (ns.applyKvsSources && ns.applyKvsSources(player, document, location.href)) {
      if (video === state.activeVideo) renderCapturedSources()
    }
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
        ns.syncFloatingTrigger()
        if (!state.activeVideo || (state.trigger && state.trigger.hidden)) {
          ns.scheduleTriggerBurst()
        }
      }
      ns.schedulePrefetch()
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

    ns.sendRuntimeMessage(
      { type: ns.NETWORK_EVIDENCE_REQUEST, url: url },
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
    if (video === state.activeVideo) ns.schedulePrefetch()
  }


  function clearSniffedList() {
    for (var cleanupIndex = 0; cleanupIndex < state.capture.sniffedRowCleanups.length; cleanupIndex += 1) {
      try {
        state.capture.sniffedRowCleanups[cleanupIndex]()
      } catch {
        // The row may already be detached.
      }
    }
    state.capture.sniffedRowCleanups = []
    state.capture.sniffedButtons = []
    if (!state.sniffedList) return
    while (state.sniffedList.children.length > 0) {
      state.sniffedList.removeChild(state.sniffedList.children[0])
    }
  }


  function sniffedQueueKey(entry, variant) {
    return (entry.key || entry.url) + '|' + (variant ? variant.url : 'auto')
  }


  function sniffedQuality(entry, variant) {
    if (variant) {
      if (typeof variant.label === 'string' && variant.label.length > 0) {
        return variant.label
      }
      if (typeof variant.height === 'number' && variant.height > 0) {
        return variant.height + 'p'
      }
    }
    if (entry.kind === 'hls') return 'HLS quality unknown'
    if (entry.kind === 'dash') return 'DASH quality unknown'
    return null
  }


  function refreshSniffedMedia() {
    var token = ++state.capture.sniffedToken
    ns.sendRuntimeMessage({ type: ns.SNIFFED_QUERY }, function (response, runtimeError) {
      if (token !== state.capture.sniffedToken || state.disabled) return
      if (runtimeError || !response || response.ok !== true) {
        state.capture.sniffed = []
      } else {
        state.capture.sniffed = Array.isArray(response.media)
          ? response.media
          : []
      }
      if (state.panelOpen) renderCapturedSources()
    })
  }


  function appendSniffedRow(entry, variant) {
    var row = ns.createElement('div', 'source')
    row.setAttribute('data-sniffed', 'true')
    var copyNode = ns.createElement('span', 'source-copy')
    var title =
      typeof entry.title === 'string' && entry.title.length > 0
        ? entry.title
        : typeof entry.filename === 'string'
          ? entry.filename
          : 'Detected media'
    copyNode.appendChild(ns.createElement('span', 'source-title', title))
    var details = []
    if (entry.kind === 'hls') details.push('HLS')
    else if (entry.kind === 'dash') details.push('DASH')
    else {
      var match = /\.([a-z0-9]{2,5})$/i.exec(
        typeof entry.filename === 'string' ? entry.filename : ''
      )
      details.push(match ? match[1].toUpperCase() : 'FILE')
    }
    var quality = sniffedQuality(entry, variant)
    if (quality) details.push(quality)
    if (typeof entry.sizeBytes === 'number' && entry.sizeBytes > 0 && core.formatMediaSize) {
      details.push(core.formatMediaSize(entry.sizeBytes, false))
    }
    if (typeof entry.sourceHost === 'string' && entry.sourceHost.length > 0) {
      details.push(entry.sourceHost)
    }
    copyNode.appendChild(ns.createElement('span', 'source-detail', details.join(' · ')))
    row.appendChild(copyNode)

    var button = ns.createElement('button', 'source-action', 'Download')
    button.type = 'button'
    var key = sniffedQueueKey(entry, variant)
    if (state.capture.sniffedQueued.indexOf(key) !== -1) {
      button.textContent = 'Added ✓'
      button.disabled = true
    } else {
      button.disabled = state.capture.queueing
    }
    var onClick = function (event) {
      ns.stopPlayerEvent(event)
      queueSniffedMedia(entry, variant, key, button)
    }
    if (typeof button.addEventListener === 'function') {
      button.addEventListener('click', onClick)
      state.capture.sniffedRowCleanups.push(function () {
        if (typeof button.removeEventListener === 'function') {
          button.removeEventListener('click', onClick)
        }
      })
    }
    row.appendChild(button)
    state.capture.sniffedButtons.push(button)
    state.sniffedList.appendChild(row)
  }


  function renderSniffedMedia() {
    if (!state.sniffedSection || !state.sniffedList) return 0
    clearSniffedList()
    var entries = Array.isArray(state.capture.sniffed) ? state.capture.sniffed : []
    var rows = 0
    for (var index = 0; index < entries.length; index += 1) {
      var entry = entries[index]
      if (!entry || typeof entry !== 'object') continue
      var variants =
        Array.isArray(entry.variants) && entry.variants.length > 0
          ? entry.variants
          : [null]
      for (var variantIndex = 0; variantIndex < variants.length; variantIndex += 1) {
        appendSniffedRow(entry, variants[variantIndex])
        rows += 1
      }
    }
    if (state.sniffedEmpty) state.sniffedEmpty.hidden = rows > 0
    return rows
  }


  function queueSniffedMedia(entry, variant, key, button) {
    if (
      state.disabled ||
      state.capture.queueing ||
      !entry ||
      state.capture.sniffedQueued.indexOf(key) !== -1
    ) {
      return
    }
    state.capture.queueing = true
    setCaptureBusy(true)
    button.disabled = true
    button.textContent = 'Adding…'
    ns.setMediaStatus('Adding detected media…', 'info')

    ns.sendRuntimeMessage(
      {
        type: ns.SNIFFED_QUEUE,
        url: entry.url,
        ...(variant ? { variantUrl: variant.url } : {})
      },
      function (response, runtimeError) {
        state.capture.queueing = false
        setCaptureBusy(false)
        if (runtimeError) {
          button.textContent = 'Download'
          ns.setMediaStatus('The DonDownload background worker did not respond.', 'error')
          return
        }
        if (!response || response.ok !== true) {
          button.textContent = 'Download'
          ns.setMediaStatus(
            core.describeMediaError(
              response && response.error,
              'The detected media could not be queued.'
            ),
            'error'
          )
          return
        }
        if (state.capture.sniffedQueued.indexOf(key) === -1) {
          state.capture.sniffedQueued.push(key)
        }
        button.textContent = 'Added ✓'
        button.disabled = true
        ns.setMediaStatus('Added to DonDownload ✓ — downloading in the app', 'success')
        ns.closePanel(false)
        showAcceptedFeedback()
      }
    )
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
    renderSniffedMedia()
    state.capture.buttons = []

    var player = playerFor(state.activeVideo)
    var sources = player ? player.sources : []
    var unsupported = player ? player.unsupported : null

    for (var index = 0; index < sources.length; index += 1) {
      appendCapturedSourceRow(sources[index])
    }

    if (unsupported) {
      var unsupportedRow = ns.createElement('div', 'source')
      unsupportedRow.setAttribute('data-unsupported', 'true')
      var unsupportedCopy = ns.createElement('span', 'source-copy')
      unsupportedCopy.appendChild(
        ns.createElement('span', 'source-title', 'Streaming playback source')
      )
      unsupportedCopy.appendChild(
        ns.createElement('span', 'source-detail', unsupported.message)
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
    var analyzing = ns.prefetchInFlight()
    var cachedView = state.media.analysis || ns.prefetchView()
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
        ns.hasPlayingTopFrameVideo()
    }
    setCaptureBusy(state.capture.queueing)
  }


  function appendCapturedSourceRow(source) {
    var row = ns.createElement('div', 'source')
    if (source.current) row.setAttribute('data-current', 'true')
    var copyNode = ns.createElement('span', 'source-copy')
    copyNode.appendChild(
      ns.createElement('span', 'source-title', source.filename)
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
      ns.createElement('span', 'source-detail', details.join(' · '))
    )
    row.appendChild(copyNode)

    var button = ns.createElement('button', 'source-action', 'Download')
    button.type = 'button'
    var alreadyQueued = state.capture.queuedUrls.indexOf(source.url) !== -1
    if (alreadyQueued) {
      button.textContent = 'Added ✓'
      button.disabled = true
    } else {
      button.disabled = state.capture.queueing
    }
    var onClick = function (event) {
      ns.stopPlayerEvent(event)
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
    for (var sniffedIndex = 0; sniffedIndex < state.capture.sniffedButtons.length; sniffedIndex += 1) {
      var sniffedButton = state.capture.sniffedButtons[sniffedIndex]
      if (!sniffedButton) continue
      sniffedButton.disabled = busy || sniffedButton.textContent === 'Added ✓'
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
    ns.setMediaStatus('Adding ' + source.filename + '...', 'info')

    ns.sendRuntimeMessage(
      {
        type: ns.CAPTURE_QUEUE,
        url: source.url,
        filename: source.filename,
        ...(source.contentType === 'video/mp4' || source.contentType === 'video/webm'
          ? { contentType: source.contentType }
          : {}),
        ...(typeof source.sizeBytes === 'number' &&
        Number.isSafeInteger(source.sizeBytes) &&
        source.sizeBytes > 0
          ? { expectedBytes: source.sizeBytes }
          : {}),
        ...(source.usePageHeaders === true ? { usePageHeaders: true } : {})
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
          ns.setMediaStatus('The DonDownload background worker did not respond.', 'error')
          if (typeof done === 'function') {
            done({ ok: false, error: { code: 'BACKGROUND_UNAVAILABLE', message: 'The background worker did not respond.' } })
          }
          return
        }
        if (!response || response.ok !== true) {
          ns.setMediaStatus(
            core.describeMediaError(
              response && response.error,
              'The captured source could not be queued.'
            ),
            'error'
          )
          if (typeof done === 'function') done(response || { ok: false })
          return
        }

        ns.setMediaStatus('Added to DonDownload ✓ — downloading in the app', 'success')
        if (state.capture.queuedUrls.indexOf(source.url) === -1) {
          state.capture.queuedUrls.push(source.url)
        }
        ns.closePanel(false)
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
        current: source.current === true,
        ...(source.usePageHeaders === true ? { usePageHeaders: true } : {})
      }
    })
  }


  function captureQueryResponse(streaming) {
    return {
      ok: true,
      origin: location.origin,
      url: ns.pageUrlKey(),
      sources: querySourceList(),
      streaming: streaming || ns.streamingForQuery(),
      analysis: ns.currentAnalysisView(),
      status: ns.queryAnalysisStatus(),
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


  ns.isPlayingVideo = isPlayingVideo
  ns.largestPlayingVideo = largestPlayingVideo
  ns.triggerInput = triggerInput
  ns.isTriggerReady = isTriggerReady
  ns.largestTriggerVideo = largestTriggerVideo
  ns.playerFor = playerFor
  ns.resetCaptureForNavigation = resetCaptureForNavigation
  ns.releaseCapturePlayers = releaseCapturePlayers
  ns.pruneDisconnectedPlayers = pruneDisconnectedPlayers
  ns.maybeResetCaptureForNavigation = maybeResetCaptureForNavigation
  ns.observePlayer = observePlayer
  ns.installSourceObservers = installSourceObservers
  ns.playbackInput = playbackInput
  ns.requestNetworkEvidence = requestNetworkEvidence
  ns.markEvidenceUnavailable = markEvidenceUnavailable
  ns.handleNetworkEvidence = handleNetworkEvidence
  ns.observePlayback = observePlayback
  ns.clearSniffedList = clearSniffedList
  ns.sniffedQueueKey = sniffedQueueKey
  ns.sniffedQuality = sniffedQuality
  ns.refreshSniffedMedia = refreshSniffedMedia
  ns.appendSniffedRow = appendSniffedRow
  ns.renderSniffedMedia = renderSniffedMedia
  ns.queueSniffedMedia = queueSniffedMedia
  ns.clearSourceList = clearSourceList
  ns.renderCapturedSources = renderCapturedSources
  ns.appendCapturedSourceRow = appendCapturedSourceRow
  ns.setCaptureBusy = setCaptureBusy
  ns.queueCapturedSource = queueCapturedSource
  ns.showAcceptedFeedback = showAcceptedFeedback
  ns.querySourceList = querySourceList
  ns.captureQueryResponse = captureQueryResponse
  ns.downloadQueriedSource = downloadQueriedSource
})()
