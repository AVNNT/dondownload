// Bulk image collection for "Download images on this page".
//
// This file is injected into the active tab with chrome.scripting.executeScript
// (activeTab is enough; no host permission is added), so it is a classic
// content script: no imports, and its API lives on globalThis. The pure URL
// helpers are unit-tested through that global.
//
// The collector walks the live DOM because the pages users care about (Pinterest
// boards, infinite galleries) render their images with JavaScript, so fetching
// the HTML server-side would find nothing. It never reads a cookie, never sends
// anything itself and never starts a download: it only reports a list of image
// URLs to the extension, which forwards them to the desktop picker.

;(function () {
  'use strict'

  var MAX_IMAGES = 1000
  var MAX_URL_LENGTH = 4096
  var MAX_ALT_LENGTH = 200
  var MAX_TITLE_LENGTH = 200
  // Icons, avatars and tracking pixels are smaller than this on both axes.
  var MIN_IMAGE_EDGE = 100
  // A single edge this thin is a rule, a divider or a 1x1 spacer, never a photo.
  var MIN_IMAGE_HARD_EDGE = 24
  var SCROLL_STEP_RATIO = 0.9
  var SCROLL_INTERVAL_MS = 700
  // Stop after this many rounds with no new image and no height growth.
  var IDLE_ROUNDS = 3
  var PROGRESS_MESSAGE = 'dondownload:images-progress'
  var READY_MESSAGE = 'dondownload:images-ready'
  var UI_HOST_ID = 'dondownload-image-run'

  var PINIMG_URL =
    /^https?:\/\/i\.pinimg\.com\/((?:\d+x\d+(?:_RS)?|\d+x|originals))\/([0-9a-f]{2})\/([0-9a-f]{2})\/([0-9a-f]{2})\/([^/?#]+)$/i
  var PINIMG_AVATAR = /\/75x75_RS\//i
  /**
   * Entries whose url was really seen on the page (an /originals/ URL in a
   * srcset) instead of synthesized from a thumbnail. Kept beside the entries
   * because the desktop rejects message entries with unknown fields.
   */
  var explicitOriginals = new WeakSet()

  function isPinterestHost(hostname) {
    if (typeof hostname !== 'string') return false
    var host = hostname.toLowerCase()
    return (
      host === 'pinimg.com' ||
      /\.pinimg\.com$/.test(host) ||
      /(?:^|\.)pinterest\.[a-z.]{2,}$/.test(host)
    )
  }

  function safeUrl(raw, baseUrl) {
    if (typeof raw !== 'string') return null
    var value = raw.trim()
    if (value.length === 0 || value.length > MAX_URL_LENGTH) return null
    // eslint-disable-next-line no-control-regex -- rejecting control characters is the security intent
    if (/[\u0000-\u001f\u007f]/.test(value)) return null
    var parsed
    try {
      parsed = baseUrl === undefined ? new URL(value) : new URL(value, baseUrl)
    } catch {
      return null
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    if (!parsed.hostname) return null
    if (parsed.username || parsed.password) return null
    parsed.hash = ''
    if (parsed.href.length > MAX_URL_LENGTH) return null
    return parsed.href
  }

  /** Parse a `srcset` attribute into its candidates. */
  function parseSrcset(value) {
    if (typeof value !== 'string') return []
    var candidates = []
    var parts = value.split(',')
    for (var index = 0; index < parts.length; index += 1) {
      var part = parts[index].trim()
      if (part.length === 0) continue
      var pieces = part.split(/\s+/)
      var url = pieces[0]
      var descriptor = pieces.length > 1 ? pieces[1].toLowerCase() : ''
      var width = 0
      var density = 0
      if (/^\d+w$/.test(descriptor)) width = parseInt(descriptor, 10)
      else if (/^\d+(?:\.\d+)?x$/.test(descriptor)) density = parseFloat(descriptor)
      candidates.push({ url: url, width: width, density: density })
    }
    return candidates
  }

  /**
   * Largest candidate of a `srcset`. Width descriptors win over density ones,
   * and a bare URL is kept as a last resort so a single-entry srcset still works.
   */
  function pickLargestSrcset(value) {
    var candidates = parseSrcset(value)
    if (candidates.length === 0) return null
    var best = null
    for (var index = 0; index < candidates.length; index += 1) {
      var candidate = candidates[index]
      if (best === null) {
        best = candidate
        continue
      }
      if (candidate.width !== best.width) {
        if (candidate.width > best.width) best = candidate
        continue
      }
      if (candidate.density > best.density) best = candidate
    }
    return best === null ? null : best.url
  }

  function pinimgParts(raw) {
    var url = safeUrl(raw)
    if (url === null) return null
    var match = PINIMG_URL.exec(url)
    if (!match) return null
    return {
      size: match[1],
      dir: match[2] + '/' + match[3] + '/' + match[4],
      file: match[5]
    }
  }

  /**
   * Pinterest serves one pin from several size folders of the same CDN path.
   * `/originals/` is the full-size upload, so it is what the user wants.
   */
  function pinterestOriginal(raw) {
    var parts = pinimgParts(raw)
    if (parts === null) return null
    if (parts.size.toLowerCase() === 'originals') return safeUrl(raw)
    return 'https://i.pinimg.com/originals/' + parts.dir + '/' + parts.file
  }

  /**
   * The 736x variant of a thumbnail. Originals occasionally exist with a
   * different extension than the thumbnail (a .png upload behind .jpg
   * thumbnails), so a fallback is never derived from an /originals/ URL: that
   * extension is exactly the one Pinterest does not serve for the sizes it
   * generates.
   */
  function pinterestFallback(raw) {
    var parts = pinimgParts(raw)
    if (parts === null) return null
    if (parts.size.toLowerCase() === 'originals') return null
    return 'https://i.pinimg.com/736x/' + parts.dir + '/' + parts.file
  }

  /** The upload hash without its extension: one pin, whatever the size folder. */
  function pinimgStem(file) {
    var dot = file.lastIndexOf('.')
    return dot > 0 ? file.slice(0, dot) : file
  }

  /** Ordering of the size folders, so the largest variant can be picked. */
  function pinimgSizeRank(size) {
    var value = String(size).toLowerCase()
    if (value === 'originals') return Number.MAX_SAFE_INTEGER
    var match = /^(\d+)x(\d*)/.exec(value)
    if (!match) return 0
    var width = parseInt(match[1], 10)
    var height = match[2].length > 0 ? parseInt(match[2], 10) : width
    return Math.max(width, height)
  }

  /**
   * One pin out of every variant of it that the page exposes.
   *
   * The url is an /originals/ URL that was really seen when the srcset has one
   * (only the page knows whether the upload is a .png behind .jpg thumbnails),
   * and is otherwise synthesized from the largest variant. The fallback is a
   * size variant that really exists: the 736x srcset candidate when the page
   * has one, else the largest thumbnail, which is already big enough to keep
   * as-is or is asked for as its 736x form.
   */
  function pinimgEntry(urls) {
    var best = null
    var explicit = null
    var seen736 = null
    for (var index = 0; index < urls.length; index += 1) {
      var parts = pinimgParts(urls[index])
      if (parts === null) continue
      var size = parts.size.toLowerCase()
      if (size === 'originals') {
        if (explicit === null) explicit = { url: urls[index], parts: parts }
        continue
      }
      if (size === '736x' && seen736 === null) seen736 = urls[index]
      if (best === null || pinimgSizeRank(size) > pinimgSizeRank(best.parts.size)) {
        best = { url: urls[index], parts: parts }
      }
    }
    if (explicit === null && best === null) return null
    var url =
      explicit === null
        ? 'https://i.pinimg.com/originals/' + best.parts.dir + '/' + best.parts.file
        : explicit.url
    var fallback = null
    if (seen736 !== null) {
      fallback = seen736
    } else if (best !== null) {
      var large = pinimgSizeRank(best.parts.size) >= 736
      var generated = /\.(?:jpe?g|webp)$/i.test(best.parts.file)
      fallback =
        large || !generated
          ? best.url
          : 'https://i.pinimg.com/736x/' + best.parts.dir + '/' + best.parts.file
    }
    if (fallback === url) fallback = null
    return { url: url, fallbackUrl: fallback, explicit: explicit !== null }
  }

  /**
   * Stable identity of one image, so size variants collapse into one entry. A
   * pin is keyed on its folder and hash without the extension, because the
   * /originals/ file of a pin can carry a different extension than its
   * thumbnails.
   */
  function imageIdentity(raw) {
    var url = safeUrl(raw)
    if (url === null) return null
    var parts = pinimgParts(url)
    if (parts !== null) return 'pin:' + parts.dir + '/' + pinimgStem(parts.file)
    return url
  }

  function isAvatarUrl(raw) {
    if (typeof raw !== 'string') return false
    if (PINIMG_AVATAR.test(raw)) return true
    return /\/(?:avatars?|profile[-_]?(?:pics?|images?))\//i.test(raw)
  }

  function isSkippableUrl(raw) {
    if (typeof raw !== 'string') return true
    var value = raw.trim().toLowerCase()
    if (value.length === 0) return true
    if (value.indexOf('data:') === 0) return true
    if (value.indexOf('blob:') === 0) return true
    if (value.indexOf('chrome-extension:') === 0) return true
    // SVG sprites and icon sheets are never a downloadable photo.
    if (/\.svg(?:[?#]|$)/i.test(value)) return true
    return false
  }

  /**
   * True for a tracking pixel, icon or avatar-sized image.
   *
   * Both edges have to be small for an icon (a 120x80 thumbnail is a photo, not
   * an icon), while one very thin edge is enough to spot rules, dividers and
   * 1x1 spacers.
   */
  function isDecorativeImage(image) {
    if (image === null || typeof image !== 'object') return true
    if (isSkippableUrl(image.url)) return true
    if (isAvatarUrl(image.url)) return true
    var width = typeof image.width === 'number' ? image.width : 0
    var height = typeof image.height === 'number' ? image.height : 0
    if (width > 0 && height > 0) {
      if (width < MIN_IMAGE_EDGE && height < MIN_IMAGE_EDGE) return true
      if (width < MIN_IMAGE_HARD_EDGE || height < MIN_IMAGE_HARD_EDGE) return true
    }
    return false
  }

  function cleanAlt(value) {
    if (typeof value !== 'string') return ''
    return value
      .normalize('NFKC')
      // eslint-disable-next-line no-control-regex -- rejecting control characters is the security intent
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_ALT_LENGTH)
  }

  /**
   * Normalize every URL one image element exposes into a single message entry.
   *
   * Pinterest serves one pin from several size folders, so an <img> whose
   * srcset lists 236x/474x/736x/originals is one picture, not four: the
   * variants collapse into one entry (see `pinimgEntry`).
   */
  function entryFromSources(sources, meta, baseUrl) {
    var info = meta === null || typeof meta !== 'object' ? {} : meta
    var list = Array.isArray(sources) ? sources : []
    var resolved = []
    var seen = Object.create(null)
    for (var index = 0; index < list.length; index += 1) {
      var url = safeUrl(list[index], baseUrl)
      if (url === null) continue
      if (isSkippableUrl(url) || isAvatarUrl(url)) continue
      if (seen[url] === true) continue
      seen[url] = true
      resolved.push(url)
    }
    if (resolved.length === 0) return null

    var pin = pinimgEntry(resolved)
    var target = pin === null ? resolved[0] : pin.url
    var fallback = pin === null ? null : pin.fallbackUrl
    var width = typeof info.width === 'number' && info.width > 0 ? Math.round(info.width) : 0
    var height = typeof info.height === 'number' && info.height > 0 ? Math.round(info.height) : 0
    if (isDecorativeImage({ url: target, width: width, height: height })) return null

    var entry = { url: target }
    if (fallback !== null) entry.fallbackUrl = fallback
    if (width > 0) entry.width = width
    if (height > 0) entry.height = height
    var alt = cleanAlt(info.alt)
    if (alt.length > 0) entry.alt = alt
    if (pin !== null && pin.explicit) explicitOriginals.add(entry)
    return entry
  }

  /**
   * Normalize one raw observation into the message entry. Pinterest images also
   * carry a real size variant as the fallback; every other image only carries
   * its own URL.
   */
  function toEntry(raw, baseUrl) {
    if (raw === null || typeof raw !== 'object') return null
    return entryFromSources([raw.url], raw, baseUrl)
  }

  function imageKey(entry) {
    return imageIdentity(entry.url) || entry.url
  }

  /**
   * A pin first seen as a thumbnail-only <img> gets a synthesized /originals/
   * URL; once the page renders the srcset, the original that was really seen
   * (with the upload's own extension) replaces it instead of being skipped.
   */
  function upgradeEntry(existing, incoming) {
    if (existing === incoming) return existing
    if (explicitOriginals.has(incoming) !== true) return existing
    if (existing.url === incoming.url) return existing
    var upgraded = { url: incoming.url }
    var fallback = incoming.fallbackUrl === undefined ? existing.fallbackUrl : incoming.fallbackUrl
    if (fallback !== undefined && fallback !== upgraded.url) upgraded.fallbackUrl = fallback
    var width = incoming.width === undefined ? existing.width : incoming.width
    if (width !== undefined) upgraded.width = width
    var height = incoming.height === undefined ? existing.height : incoming.height
    if (height !== undefined) upgraded.height = height
    var alt = incoming.alt === undefined ? existing.alt : incoming.alt
    if (alt !== undefined) upgraded.alt = alt
    explicitOriginals.add(upgraded)
    return upgraded
  }

  /**
   * Merge a batch of observations into the running list. Dedupe is by identity,
   * so the same pin at 236x and 736x counts once.
   */
  function mergeImages(existing, incoming, limit) {
    var maximum = typeof limit === 'number' && limit > 0 ? limit : MAX_IMAGES
    var images = Array.isArray(existing) ? existing.slice() : []
    var positions = Object.create(null)
    for (var index = 0; index < images.length; index += 1) {
      var existingKey = imageKey(images[index])
      if (positions[existingKey] === undefined) positions[existingKey] = index
    }
    var added = 0
    var list = Array.isArray(incoming) ? incoming : []
    for (var position = 0; position < list.length; position += 1) {
      var entry = list[position]
      if (entry === null || typeof entry !== 'object' || typeof entry.url !== 'string') {
        continue
      }
      var key = imageKey(entry)
      var at = positions[key]
      if (at !== undefined) {
        images[at] = upgradeEntry(images[at], entry)
        continue
      }
      if (images.length >= maximum) break
      positions[key] = images.length
      images.push(entry)
      added += 1
    }
    return { images: images, added: added }
  }

  /* --------------------------- DOM collection --------------------------- */

  function naturalSize(element) {
    var width = typeof element.naturalWidth === 'number' ? element.naturalWidth : 0
    var height = typeof element.naturalHeight === 'number' ? element.naturalHeight : 0
    if (width > 0 && height > 0) return { width: width, height: height }
    // A not-yet-decoded lazy image still has a rendered box, which is a good
    // enough size hint to drop icons.
    var rect = typeof element.getBoundingClientRect === 'function'
      ? element.getBoundingClientRect()
      : null
    return {
      width: rect === null ? 0 : Math.round(rect.width),
      height: rect === null ? 0 : Math.round(rect.height)
    }
  }

  function isHidden(element) {
    if (element === null || typeof element !== 'object') return false
    if (element.hidden === true) return true
    var style = element.getAttribute === undefined ? null : element.getAttribute('style')
    if (typeof style === 'string' && /display\s*:\s*none|visibility\s*:\s*hidden/i.test(style)) {
      return true
    }
    return false
  }

  function backgroundUrls(value) {
    if (typeof value !== 'string' || value.indexOf('url(') === -1) return []
    var urls = []
    var pattern = /url\((['"]?)([^'")]+)\1\)/g
    var match = pattern.exec(value)
    while (match !== null) {
      urls.push(match[2])
      match = pattern.exec(value)
    }
    return urls
  }

  /** Every `srcset` candidate, largest first. */
  function srcsetSources(value) {
    var sorted = parseSrcset(value).slice().sort(function (left, right) {
      if (left.width !== right.width) return right.width - left.width
      return right.density - left.density
    })
    var urls = []
    for (var index = 0; index < sorted.length; index += 1) urls.push(sorted[index].url)
    return urls
  }

  /**
   * One <img> is one image: its srcset candidates, currentSrc and src are
   * variants of the same picture, so they become a single entry.
   */
  function fromImgElement(element, baseUrl) {
    var sources = srcsetSources(element.getAttribute('srcset'))
    if (typeof element.currentSrc === 'string' && element.currentSrc.length > 0) {
      sources.push(element.currentSrc)
    }
    if (typeof element.src === 'string' && element.src.length > 0) {
      sources.push(element.src)
    }
    var size = naturalSize(element)
    return entryFromSources(
      sources,
      { width: size.width, height: size.height, alt: element.alt },
      baseUrl
    )
  }

  function fromPictureElement(picture, baseUrl) {
    var sources = []
    var list = picture.querySelectorAll('source[srcset]')
    for (var index = 0; index < list.length; index += 1) {
      var urls = srcsetSources(list[index].getAttribute('srcset'))
      for (var position = 0; position < urls.length; position += 1) sources.push(urls[position])
    }
    return sources.length === 0 ? null : entryFromSources(sources, {}, baseUrl)
  }

  /**
   * Collect every candidate image currently in the DOM. Background images are
   * read only from elements that carry an inline background declaration or a
   * data attribute, which keeps the pass cheap on very large pages.
   */
  function collectFromDocument(doc, win) {
    if (doc === null || typeof doc !== 'object') return []
    var baseUrl = typeof doc.baseURI === 'string' ? doc.baseURI : undefined
    var entries = []

    var images = doc.querySelectorAll('img')
    for (var index = 0; index < images.length; index += 1) {
      var image = images[index]
      if (isHidden(image)) continue
      var fromImg = fromImgElement(image, baseUrl)
      if (fromImg !== null) entries.push(fromImg)
    }

    var pictures = doc.querySelectorAll('picture')
    for (var pictureIndex = 0; pictureIndex < pictures.length; pictureIndex += 1) {
      var fromPicture = fromPictureElement(pictures[pictureIndex], baseUrl)
      if (fromPicture !== null) entries.push(fromPicture)
    }

    if (win !== null && typeof win === 'object' && typeof win.getComputedStyle === 'function') {
      var candidates = doc.querySelectorAll(
        '[style*="background"],[data-bg],[data-background-image]'
      )
      for (var candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
        var element = candidates[candidateIndex]
        if (isHidden(element)) continue
        var inline = element.getAttribute('data-bg') || element.getAttribute('data-background-image')
        var urls = backgroundUrls(inline)
        var computed = backgroundUrls(win.getComputedStyle(element).backgroundImage)
        for (var urlIndex = 0; urlIndex < computed.length; urlIndex += 1) {
          urls.push(computed[urlIndex])
        }
        var rect = typeof element.getBoundingClientRect === 'function'
          ? element.getBoundingClientRect()
          : { width: 0, height: 0 }
        for (var listIndex = 0; listIndex < urls.length; listIndex += 1) {
          var entry = toEntry(
            {
              url: urls[listIndex],
              width: Math.round(rect.width),
              height: Math.round(rect.height)
            },
            baseUrl
          )
          if (entry !== null) entries.push(entry)
        }
      }
    }

    return entries
  }

  function pageTitle(doc) {
    if (doc === null || typeof doc !== 'object') return ''
    var title = typeof doc.title === 'string' ? doc.title : ''
    return title
      .normalize('NFKC')
      // eslint-disable-next-line no-control-regex -- rejecting control characters is the security intent
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_TITLE_LENGTH)
  }

  /* ----------------------------- in-page run ---------------------------- */

  function createRunUi(doc, handlers) {
    var host = doc.createElement('div')
    host.id = UI_HOST_ID
    host.style.position = 'fixed'
    host.style.right = '16px'
    host.style.bottom = '16px'
    host.style.zIndex = '2147483647'
    var shadow = host.attachShadow({ mode: 'open' })
    shadow.innerHTML =
      '<style>' +
      ':host{all:initial}' +
      '.card{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:12px;' +
      'background:#111113;color:#f4f4f5;font:500 12px/1.4 system-ui,sans-serif;' +
      'box-shadow:0 10px 30px rgba(0,0,0,.45);border:1px solid rgba(255,255,255,.12)}' +
      'button{all:unset;cursor:pointer;padding:4px 9px;border-radius:8px;' +
      'border:1px solid rgba(255,255,255,.18);font:600 12px system-ui,sans-serif}' +
      'button.primary{background:#2563eb;border-color:#2563eb;color:#fff}' +
      'button[disabled]{opacity:.45;cursor:default}' +
      '.count{white-space:nowrap}' +
      '</style>' +
      '<div class="card"><span class="count">Counting images…</span>' +
      '<button class="primary" data-role="send" disabled>Send</button>' +
      '<button data-role="stop">Stop</button></div>'
    var count = shadow.querySelector('.count')
    var send = shadow.querySelector('[data-role="send"]')
    var stop = shadow.querySelector('[data-role="stop"]')
    send.addEventListener('click', handlers.send)
    stop.addEventListener('click', handlers.stop)
    doc.documentElement.appendChild(host)
    return {
      setCount: function (text) {
        count.textContent = text
      },
      setSendEnabled: function (enabled) {
        send.disabled = !enabled
      },
      setStopEnabled: function (enabled) {
        stop.disabled = !enabled
      },
      remove: function () {
        if (host.parentNode !== null) host.parentNode.removeChild(host)
      }
    }
  }

  function sendMessage(message) {
    try {
      if (typeof chrome === 'undefined' || chrome.runtime === undefined) return
      chrome.runtime.sendMessage(message, function () {
        // A closed popup has no receiver; the background worker still gets it.
        void chrome.runtime.lastError
      })
    } catch {
      // The extension context can be gone after a reload; the run simply stops.
    }
  }

  /**
   * Scroll the page while collecting, then hand the list to the extension.
   *
   * Stops on: the user clicking Stop, the page no longer growing for
   * IDLE_ROUNDS rounds, or MAX_IMAGES. Whatever ends the run, the list is sent
   * automatically when it holds at least one image; the Send button only exists
   * to send early while the page is still scrolling. The original scroll
   * position is always restored, and the run survives a closed popup because
   * the floating counter lives in the page.
   */
  function startRun(doc, win, options) {
    var settings = options === null || typeof options === 'object' ? options : {}
    var limit = typeof settings.maxImages === 'number' ? settings.maxImages : MAX_IMAGES
    var interval = typeof settings.intervalMs === 'number' ? settings.intervalMs : SCROLL_INTERVAL_MS
    var state = {
      images: [],
      stopped: false,
      sending: false,
      sent: false,
      idle: 0,
      lastHeight: 0,
      startScrollY: typeof win.scrollY === 'number' ? win.scrollY : 0,
      timer: null,
      ui: null
    }

    function refreshButtons() {
      if (state.ui === null) return
      state.ui.setStopEnabled(!state.stopped)
      state.ui.setSendEnabled(!state.sending && !state.sent && state.images.length > 0)
    }

    function report(text) {
      if (state.ui !== null) state.ui.setCount(text)
      refreshButtons()
      sendMessage({ type: PROGRESS_MESSAGE, count: state.images.length, text: text })
    }

    function stopScrolling(reason) {
      if (state.stopped) return
      state.stopped = true
      if (state.timer !== null) {
        win.clearTimeout(state.timer)
        state.timer = null
      }
      try {
        win.scrollTo({ top: state.startScrollY, behavior: 'auto' })
      } catch {
        win.scrollTo(0, state.startScrollY)
      }
      report(
        state.images.length === 0
          ? 'No images found'
          : state.images.length + ' images found' + (reason === 'limit' ? ' (limit)' : '')
      )
      // The run is over, so hand the list over without asking for a second
      // click. The Send button stays for sending early while it still scrolls.
      if (reason !== 'send' && state.images.length > 0) send()
    }

    function send() {
      if (state.sending || state.sent || state.images.length === 0) return
      state.sending = true
      stopScrolling('send')
      if (state.ui !== null) state.ui.setCount('Sending ' + state.images.length + ' images…')
      refreshButtons()
      var message = {
        type: READY_MESSAGE,
        pageUrl: typeof win.location === 'object' ? win.location.href : '',
        pageTitle: pageTitle(doc),
        images: state.images
      }
      try {
        chrome.runtime.sendMessage(message, function (response) {
          state.sending = false
          var ok = response !== undefined && response !== null && response.ok === true
          if (ok) state.sent = true
          if (state.ui !== null) {
            state.ui.setCount(
              ok
                ? 'Sent to DonDownload'
                : 'Could not send. Open DonDownload and try again.'
            )
          }
          refreshButtons()
        })
      } catch {
        state.sending = false
        if (state.ui !== null) state.ui.setCount('Could not send to DonDownload.')
        refreshButtons()
      }
    }

    function step() {
      if (state.stopped) return
      var collected = collectFromDocument(doc, win)
      var merged = mergeImages(state.images, collected, limit)
      state.images = merged.images
      if (state.images.length >= limit) {
        stopScrolling('limit')
        return
      }

      var height = Math.max(
        doc.documentElement === null || doc.documentElement === undefined
          ? 0
          : doc.documentElement.scrollHeight,
        doc.body === null || doc.body === undefined ? 0 : doc.body.scrollHeight
      )
      var grew = height > state.lastHeight
      state.lastHeight = height
      if (merged.added === 0 && !grew) state.idle += 1
      else state.idle = 0

      report(
        state.idle > 0
          ? state.images.length + ' images found…'
          : state.images.length + ' images found'
      )

      if (state.idle >= IDLE_ROUNDS) {
        stopScrolling('idle')
        return
      }

      var viewportHeight =
        typeof win.innerHeight === 'number' && win.innerHeight > 0 ? win.innerHeight : 800
      var next = (typeof win.scrollY === 'number' ? win.scrollY : 0) + viewportHeight * SCROLL_STEP_RATIO
      try {
        win.scrollTo({ top: next, behavior: 'auto' })
      } catch {
        win.scrollTo(0, next)
      }
      state.timer = win.setTimeout(step, interval)
    }

    state.ui = createRunUi(doc, { stop: function () { stopScrolling('user') }, send: send })
    report('Counting images…')
    step()

    return {
      stop: function () {
        stopScrolling('user')
      },
      send: send,
      count: function () {
        return state.images.length
      }
    }
  }

  globalThis.DonDownloadImageCollector = {
    MAX_IMAGES: MAX_IMAGES,
    MIN_IMAGE_EDGE: MIN_IMAGE_EDGE,
    PROGRESS_MESSAGE: PROGRESS_MESSAGE,
    READY_MESSAGE: READY_MESSAGE,
    isPinterestHost: isPinterestHost,
    parseSrcset: parseSrcset,
    pickLargestSrcset: pickLargestSrcset,
    pinterestOriginal: pinterestOriginal,
    pinterestFallback: pinterestFallback,
    imageIdentity: imageIdentity,
    isAvatarUrl: isAvatarUrl,
    isSkippableUrl: isSkippableUrl,
    isDecorativeImage: isDecorativeImage,
    toEntry: toEntry,
    mergeImages: mergeImages,
    collectFromDocument: collectFromDocument,
    pageTitle: pageTitle,
    startRun: startRun
  }
})()
