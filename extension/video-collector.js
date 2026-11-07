// Direct media extraction for "Scan this page" on a video page.
//
// This file is injected into the user's own video tab with
// chrome.scripting.executeScript (activeTab is enough; no host permission is
// added), so it is a classic content script: no imports, and its API lives on
// globalThis.
//
// Some video pages cannot be read by the desktop at all: hanime1.me has no
// yt-dlp extractor and sits behind Cloudflare, and Pornhub/Eporner answer an age
// gate, a geo block or a cookie wall. The user's real browser session already
// solved that, so this collector reads the media URLs the rendered page exposes
// (video/source elements, `currentSrc`, og:video, JSON-LD and the player config
// in inline scripts) and reports them to the extension, which forwards them
// through the existing scan bridge.
//
// Hard rules, enforced here and re-checked by the desktop:
//  - never run in the page's main world: this is an isolated content script;
//  - never read a cookie (the extension does that separately, once);
//  - never solve a challenge, bypass an age gate or click anything;
//  - only report absolute http(s) media URLs, capped and deduplicated.

;(function () {
  'use strict'

  var MAX_SOURCES = 24
  var WAIT_MS = 6000
  var POLL_MS = 200
  var MAX_LABEL_LENGTH = 80
  var MAX_TITLE_LENGTH = 300
  var MAX_SCRIPT_BYTES = 512 * 1024
  var RUN_KEY = '__donDownloadVideoRun'
  var MEDIA_PATH = /\.(m3u8|mpd|mp4|m4v|webm|mkv|mov)(?:$|[?#])/i
  // A URL is captured whole, up to the first delimiter, and only then
  // classified by its LAST path extension. Pornhub serves HLS as
  // `.../1080P_4000K_65036195.mp4/master.m3u8?h=…`, so a pattern that stops at
  // the first media extension would truncate it to a `.mp4` that is not the
  // media at all.
  var MEDIA_URL = /(?:https?:)?\/\/[^\s"'<>\\]+/gi
  var ROOT_RELATIVE_MEDIA_URL = /(?:^|["'(=\s])(\/[^\s"'<>\\]+)/gi
  /** Trailing punctuation a URL picks up from the text around it. */
  var URL_TRAILING = /[),.;\]}]+$/
  var QUALITY_KEYS =
    /["']?(?:label|quality|res|resolution|height|size)["']?\s*:\s*["']?([^"',}\]\n]{1,40})/gi
  var SIZE_ATTRIBUTE_AS_BYTES = 100000

  function cleanText(value, maximum) {
    if (typeof value !== 'string') return null
    var cleaned = value
      // eslint-disable-next-line no-control-regex -- rejecting control characters is the security intent
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (cleaned.length === 0) return null
    return cleaned.slice(0, maximum).trim()
  }

  /** Absolute http(s) URL, or null. */
  function normalizeUrl(value, base) {
    if (typeof value !== 'string') return null
    var raw = value.trim()
    if (raw.length === 0 || raw.length > 4096) return null
    if (raw.indexOf('data:') === 0 || raw.indexOf('blob:') === 0) return null
    if (raw.indexOf('javascript:') === 0) return null
    var parsed
    try {
      parsed = new URL(raw, base)
    } catch {
      return null
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    if (parsed.username || parsed.password) return null
    return parsed.href
  }

  /**
   * The media kind of a URL, from the LAST extension of its path. A URL that
   * only carries a media extension in an earlier segment
   * (`.../1080P_4000K_65036195.mp4/master.m3u8`) is an HLS manifest, not an
   * mp4, so the last segment alone decides.
   */
  function kindFromUrl(url) {
    var pathname
    try {
      pathname = new URL(url, 'https://placeholder.invalid/').pathname.toLowerCase()
    } catch {
      return null
    }
    var segments = pathname.split('/')
    var last = segments[segments.length - 1]
    var dot = last.lastIndexOf('.')
    if (dot === -1 || dot === last.length - 1) return null
    var extension = last.slice(dot + 1)
    if (extension === 'm3u8') return 'hls'
    if (extension === 'mpd') return 'dash'
    if (
      extension === 'mp4' ||
      extension === 'm4v' ||
      extension === 'webm' ||
      extension === 'mkv' ||
      extension === 'mov'
    ) {
      return 'file'
    }
    return null
  }

  function kindFromType(value) {
    if (typeof value !== 'string') return null
    var type = value.split(';')[0].trim().toLowerCase()
    if (type === 'application/vnd.apple.mpegurl' || type === 'application/x-mpegurl') {
      return 'hls'
    }
    if (type === 'application/dash+xml') return 'dash'
    if (/^video\/(mp4|webm|quicktime|x-matroska)$/.test(type)) return 'file'
    return null
  }

  function heightFromLabel(value) {
    if (typeof value !== 'string') return null
    var text = value.trim().toLowerCase()
    if (text.length === 0 || text.length > 40) return null
    if (/^\d{2,4}$/.test(text)) {
      var direct = Number(text)
      return direct >= 144 && direct <= 4320 ? direct : null
    }
    var explicit = /(\d{3,4})\s*p(?![a-z0-9])/.exec(text)
    if (explicit) {
      var height = Number(explicit[1])
      if (height >= 144 && height <= 4320) return height
    }
    var pair = /(\d{2,4})\s*[x×]\s*(\d{3,4})/.exec(text)
    if (pair) {
      var pairHeight = Number(pair[2])
      if (pairHeight >= 144 && pairHeight <= 4320) return pairHeight
    }
    if (/\b(4k|uhd)\b/.test(text)) return 2160
    if (/\b(full hd|fhd)\b/.test(text)) return 1080
    if (/\b(qhd|2k)\b/.test(text)) return 1440
    if (/\bhd\b/.test(text)) return 720
    if (/\bsd\b/.test(text)) return 480
    return null
  }

  function heightFromUrl(url) {
    var text = url.toLowerCase()
    var label = /(?:^|[^0-9])(\d{3,4})p(?:[^a-z0-9]|$)/.exec(text)
    if (label) {
      var height = Number(label[1])
      if (height >= 144 && height <= 4320) return height
    }
    var pair = /(?:^|[^0-9])(\d{3,4})x(\d{3,4})(?:[^0-9]|$)/.exec(text)
    if (pair) {
      var pairHeight = Number(pair[2])
      if (pairHeight >= 144 && pairHeight <= 4320) return pairHeight
    }
    var known = /(?:^|[^0-9])(2160|1440|1080|720|540|480|360|240)(?:[^0-9]|$)/.exec(text)
    return known ? Number(known[1]) : null
  }

  function pageUrlOf(doc, win) {
    if (win && win.location && typeof win.location.href === 'string') {
      return win.location.href
    }
    if (doc && typeof doc.URL === 'string' && doc.URL.length > 0) return doc.URL
    if (doc && typeof doc.baseURI === 'string') return doc.baseURI
    return ''
  }

  function each(doc, selector) {
    if (!doc || typeof doc.querySelectorAll !== 'function') return []
    var found
    try {
      found = doc.querySelectorAll(selector)
    } catch {
      return []
    }
    if (!found) return []
    var list = []
    var length = typeof found.length === 'number' ? found.length : 0
    for (var index = 0; index < length; index += 1) {
      if (found[index]) list.push(found[index])
    }
    return list
  }

  function attribute(node, name) {
    if (!node || typeof node.getAttribute !== 'function') return null
    var value
    try {
      value = node.getAttribute(name)
    } catch {
      return null
    }
    if (typeof value !== 'string') return null
    var trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
  }

  function childrenOf(node) {
    if (!node) return []
    if (typeof node.querySelectorAll === 'function') {
      return each(node, 'source')
    }
    return Array.isArray(node.children) ? node.children : []
  }

  function pushSource(list, seen, value, kindHint, label, width, height, sizeBytes, base) {
    var url = normalizeUrl(value, base)
    if (url === null) return
    var kind = kindFromUrl(url) || kindHint
    if (kind === null) return
    if (seen[url]) return
    seen[url] = true
    var entry = { url: url, kind: kind }
    var text = cleanText(label, MAX_LABEL_LENGTH)
    if (text !== null) entry.label = text
    if (typeof width === 'number' && width > 0) entry.width = width
    if (typeof height === 'number' && height > 0) entry.height = height
    if (typeof sizeBytes === 'number' && sizeBytes > 0) entry.sizeBytes = sizeBytes
    list.push(entry)
  }

  /** Media URLs a `<video>` or `<source>` element exposes. */
  function readMediaElement(list, seen, node, base) {
    var typeHint = kindFromType(attribute(node, 'type'))
    var label =
      attribute(node, 'label') ||
      attribute(node, 'res') ||
      attribute(node, 'resolution') ||
      attribute(node, 'quality') ||
      attribute(node, 'data-quality') ||
      attribute(node, 'data-res') ||
      attribute(node, 'data-resolution')
    var rawSize = attribute(node, 'size') || attribute(node, 'data-size')
    var numericSize = rawSize !== null && /^\d{1,15}$/.test(rawSize) ? Number(rawSize) : null
    var sizeBytes =
      numericSize !== null && numericSize >= SIZE_ATTRIBUTE_AS_BYTES ? numericSize : null
    var sizeLabel =
      numericSize !== null && numericSize < SIZE_ATTRIBUTE_AS_BYTES
        ? String(numericSize)
        : null
    var width = null
    var height = null
    var rawWidth = attribute(node, 'width')
    var rawHeight = attribute(node, 'height')
    if (rawWidth !== null && /^\d{2,5}$/.test(rawWidth)) width = Number(rawWidth)
    if (rawHeight !== null && /^\d{2,5}$/.test(rawHeight)) height = Number(rawHeight)
    // A `size="1080"` or `label="1080p"` attribute is a quality, not bytes, and
    // the player only sorts renditions by height.
    var textLabel = label || sizeLabel
    if (height === null) {
      var labelHeight = heightFromLabel(textLabel)
      if (labelHeight !== null) height = labelHeight
    }

    var tagName = typeof node.tagName === 'string' ? node.tagName.toLowerCase() : ''
    var candidates = []
    if (tagName === 'video') {
      if (typeof node.currentSrc === 'string' && node.currentSrc.length > 0) {
        candidates.push(node.currentSrc)
      }
    }
    var src = attribute(node, 'src') || attribute(node, 'data-src')
    if (src !== null) candidates.push(src)
    for (var index = 0; index < candidates.length; index += 1) {
      pushSource(
        list,
        seen,
        candidates[index],
        typeHint,
        textLabel,
        width,
        height === null ? heightFromUrl(candidates[index]) : height,
        sizeBytes,
        base
      )
    }
  }

  function readMeta(list, seen, doc, base) {
    var meta = { title: null, thumbnail: null, duration: null }
    var nodes = each(doc, 'meta')
    for (var index = 0; index < nodes.length; index += 1) {
      var node = nodes[index]
      var key = (attribute(node, 'property') || attribute(node, 'name') || '').toLowerCase()
      var content = attribute(node, 'content')
      if (content === null) continue
      if (key === 'og:title' || key === 'twitter:title') {
        if (meta.title === null) meta.title = cleanText(content, MAX_TITLE_LENGTH)
        continue
      }
      if (key === 'og:image' || key === 'og:image:url' || key === 'og:image:secure_url') {
        if (meta.thumbnail === null) meta.thumbnail = normalizeUrl(content, base)
        continue
      }
      if (key === 'og:video:duration' || key === 'video:duration') {
        var seconds = Number(content)
        if (isFinite(seconds) && seconds > 0 && meta.duration === null) {
          meta.duration = Math.floor(seconds)
        }
        continue
      }
      if (
        key === 'og:video' ||
        key === 'og:video:url' ||
        key === 'og:video:secure_url' ||
        key === 'twitter:player:stream'
      ) {
        pushSource(list, seen, content, null, null, null, null, null, base)
      }
    }
    return meta
  }

  function readJsonLd(list, seen, doc, base) {
    var nodes = each(doc, 'script')
    for (var index = 0; index < nodes.length; index += 1) {
      var node = nodes[index]
      var type = (attribute(node, 'type') || '').toLowerCase()
      if (type !== 'application/ld+json') continue
      var text = typeof node.textContent === 'string' ? node.textContent : ''
      if (text.length === 0 || text.length > 256 * 1024) continue
      var parsed
      try {
        parsed = JSON.parse(text)
      } catch {
        continue
      }
      visitJsonLd(parsed, 0, function (entry) {
        pushSource(
          list,
          seen,
          entry.url,
          null,
          entry.label,
          entry.width,
          entry.height,
          null,
          base
        )
      })
    }
  }

  function visitJsonLd(value, depth, visit) {
    if (depth > 6 || value === null || typeof value !== 'object') return
    if (Array.isArray(value)) {
      for (var index = 0; index < value.length; index += 1) {
        visitJsonLd(value[index], depth + 1, visit)
      }
      return
    }
    if (typeof value.contentUrl === 'string') {
      visit({
        url: value.contentUrl,
        label: typeof value.videoQuality === 'string' ? value.videoQuality : null,
        width: typeof value.width === 'number' ? Math.round(value.width) : null,
        height: typeof value.height === 'number' ? Math.round(value.height) : null
      })
    }
    for (var key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue
      if (typeof value[key] === 'object') visitJsonLd(value[key], depth + 1, visit)
    }
  }

  /** Player configuration in inline scripts (`sources`, `videoUrl`, mediaDefinitions). */
  function readInlineScripts(list, seen, doc, base) {
    var nodes = each(doc, 'script')
    var inspected = 0
    for (var index = 0; index < nodes.length; index += 1) {
      var node = nodes[index]
      var type = (attribute(node, 'type') || '').toLowerCase()
      if (type === 'application/ld+json') continue
      if (attribute(node, 'src') !== null) continue
      var text = typeof node.textContent === 'string' ? node.textContent : ''
      if (text.length === 0) continue
      if (inspected >= MAX_SCRIPT_BYTES) break
      inspected += text.length
      scanScript(text.slice(0, MAX_SCRIPT_BYTES), function (url, context, urlOffset) {
        var label = qualityFromContext(context, urlOffset)
        var height = heightFromLabel(label)
        pushSource(list, seen, url, null, label, null, height, null, base)
      })
    }
  }

  function scanScript(text, visit) {
    var normalized = text.replace(/\\\//g, '/')
    var seen = {}
    var match
    MEDIA_URL.lastIndex = 0
    while ((match = MEDIA_URL.exec(normalized)) !== null) {
      emit(match[0], match.index)
    }
    ROOT_RELATIVE_MEDIA_URL.lastIndex = 0
    while ((match = ROOT_RELATIVE_MEDIA_URL.exec(normalized)) !== null) {
      emit(match[1], match.index)
    }

    function emit(value, index) {
      if (typeof value !== 'string') return
      var url = value.replace(URL_TRAILING, '')
      if (url.length === 0 || url.length > 4096) return
      // The pattern now matches any URL, so a non-media one is dropped here.
      if (kindFromUrl(url) === null) return
      if (seen[index + ':' + url]) return
      seen[index + ':' + url] = true
      var start = Math.max(0, index - 420)
      var end = Math.min(normalized.length, index + url.length + 420)
      visit(url, normalized.slice(start, end), index - start)
    }
  }

  /**
   * The hint that describes this URL inside one player entry. A `sources` or
   * `mediaDefinitions` array holds several renditions, so the first label in the
   * context window belongs to the entry above; a hint after the URL wins and the
   * nearest one before it is the fallback.
   */
  function closestMatch(context, pattern, urlOffset) {
    var after = null
    var afterDistance = Infinity
    var before = null
    var beforeDistance = Infinity
    pattern.lastIndex = 0
    var match
    while ((match = pattern.exec(context)) !== null) {
      var index = match.index
      if (index >= urlOffset) {
        if (index - urlOffset < afterDistance) {
          after = match
          afterDistance = index - urlOffset
        }
      } else if (urlOffset - index < beforeDistance) {
        before = match
        beforeDistance = urlOffset - index
      }
    }
    return after || before
  }

  function qualityFromContext(context, urlOffset) {
    var hint = closestMatch(context, QUALITY_KEYS, urlOffset)
    if (hint) {
      var height = heightFromLabel(hint[1])
      if (height !== null) return height + 'p'
    }
    var inline = closestMatch(context, /(\d{3,4})\s*p(?:[^a-z0-9]|$)/gi, urlOffset)
    if (inline) {
      var inlineHeight = heightFromLabel(inline[1])
      if (inlineHeight !== null) return inlineHeight + 'p'
    }
    return null
  }

  function sortSources(sources) {
    var rank = { file: 0, hls: 1, dash: 2 }
    return sources.sort(function (left, right) {
      var leftHeight = left.height || 0
      var rightHeight = right.height || 0
      if (leftHeight !== rightHeight) return rightHeight - leftHeight
      return rank[left.kind] - rank[right.kind]
    })
  }

  /** Everything the rendered page exposes right now. */
  function readSources(doc, win) {
    var pageUrl = pageUrlOf(doc, win)
    var base = pageUrl.length > 0 ? pageUrl : undefined
    var list = []
    var seen = {}

    var videos = each(doc, 'video')
    for (var index = 0; index < videos.length; index += 1) {
      var video = videos[index]
      readMediaElement(list, seen, video, base)
      var sources = childrenOf(video)
      for (var child = 0; child < sources.length; child += 1) {
        readMediaElement(list, seen, sources[child], base)
      }
    }
    var standalone = each(doc, 'source')
    for (var sourceIndex = 0; sourceIndex < standalone.length; sourceIndex += 1) {
      readMediaElement(list, seen, standalone[sourceIndex], base)
    }

    var meta = readMeta(list, seen, doc, base)
    readJsonLd(list, seen, doc, base)
    readInlineScripts(list, seen, doc, base)

    var title = meta.title
    if (title === null && typeof doc.title === 'string') {
      title = cleanText(doc.title, MAX_TITLE_LENGTH)
    }

    return {
      pageUrl: pageUrl,
      title: title,
      thumbnailUrl: meta.thumbnail,
      durationSeconds: meta.duration,
      sources: sortSources(list).slice(0, MAX_SOURCES)
    }
  }

  /** True once the page shows a media URL a player actually attached. */
  function hasPlayableMedia(doc) {
    var videos = each(doc, 'video')
    for (var index = 0; index < videos.length; index += 1) {
      var video = videos[index]
      if (typeof video.currentSrc === 'string' && video.currentSrc.length > 0) {
        return true
      }
      if (attribute(video, 'src') !== null) return true
      if (childrenOf(video).length > 0) return true
    }
    return each(doc, 'source').length > 0
  }

  /**
   * True when the page has a player element at all. A page without one is not
   * a video page, so waiting for a player to attach would only delay the normal
   * page scan by the full timeout.
   */
  function hasPlayerElement(doc) {
    return each(doc, 'video').length > 0 || each(doc, 'source').length > 0
  }

  function delay(win, ms) {
    var schedule =
      win && typeof win.setTimeout === 'function' ? win.setTimeout : setTimeout
    return new Promise(function (resolve) {
      schedule(resolve, ms)
    })
  }

  /**
   * Wait (bounded) for the player to attach its media, then read the page. HLS
   * players set `currentSrc` only after their manifest request finished, so an
   * immediate read would report nothing. A page with no player element returns
   * at once: it is not a video page and must not delay the normal page scan.
   */
  async function collectVideo(doc, win, options) {
    var settings = options || {}
    var waitMs = typeof settings.waitMs === 'number' ? settings.waitMs : WAIT_MS
    var pollMs = typeof settings.pollMs === 'number' ? settings.pollMs : POLL_MS
    var deadline = Date.now() + Math.max(0, waitMs)
    var result = readSources(doc, win)
    while (
      result.sources.length === 0 &&
      hasPlayerElement(doc) &&
      !hasPlayableMedia(doc) &&
      Date.now() < deadline
    ) {
      await delay(win, pollMs)
      result = readSources(doc, win)
    }
    return result
  }

  function startRun(doc, win, options) {
    var run = { result: null }
    globalThis[RUN_KEY] = run
    collectVideo(doc, win, options)
      .then(function (result) {
        run.result = result
      })
      .catch(function () {
        run.result = { pageUrl: pageUrlOf(doc, win), title: null, sources: [] }
      })
    return true
  }

  globalThis.DonDownloadVideoCollector = {
    MAX_SOURCES: MAX_SOURCES,
    WAIT_MS: WAIT_MS,
    POLL_MS: POLL_MS,
    RUN_KEY: RUN_KEY,
    MEDIA_PATH: MEDIA_PATH,
    cleanText: cleanText,
    normalizeUrl: normalizeUrl,
    kindFromUrl: kindFromUrl,
    heightFromLabel: heightFromLabel,
    heightFromUrl: heightFromUrl,
    readSources: readSources,
    hasPlayableMedia: hasPlayableMedia,
    collectVideo: collectVideo,
    startRun: startRun
  }
})()
