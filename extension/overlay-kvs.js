// KVS (Kernel Video Sharing) player adapter for the opt-in overlay.
//
// The isolated world cannot read page JavaScript variables, but an inline
// <script> element's text is part of the DOM. KVS pages declare
// `var flashvars = {...}` there, including progressive `video_url` and
// `video_alt_url*` URLs (sometimes obfuscated as `function/0/<url>`).
//
// This file only turns that declarative data into candidates for the existing
// per-player source list. It never starts playback, reads network requests or
// guesses a URL: every candidate must be http(s), pass the KVS decode, and be
// on the page's own host or a subdomain of it.

;(function () {
  'use strict'

  var ns = globalThis.DonDownloadOverlay || (globalThis.DonDownloadOverlay = {})
  var MAX_SCRIPT_TEXT = 512 * 1024

  function unescapeJsString(value) {
    return String(value || '').replace(
      /\\(u[0-9a-f]{4}|x[0-9a-f]{2}|.)/gi,
      function (match, escaped) {
        if (escaped.charAt(0) === 'u' && escaped.length === 5) {
          return String.fromCharCode(parseInt(escaped.slice(1), 16))
        }
        if (escaped.charAt(0) === 'x' && escaped.length === 3) {
          return String.fromCharCode(parseInt(escaped.slice(1), 16))
        }
        return escaped
      }
    )
  }

  /** Return the balanced `{...}` object literal after `flashvars =`. */
  function extractFlashvarsObject(text) {
    if (typeof text !== 'string') return null
    var bounded = text.slice(0, MAX_SCRIPT_TEXT)
    var start = /\bflashvars\s*=\s*\{/.exec(bounded)
    if (!start) return null
    var open = bounded.indexOf('{', start.index)
    if (open < 0) return null
    var depth = 0
    var quote = ''
    for (var index = open; index < bounded.length; index += 1) {
      var character = bounded.charAt(index)
      if (quote !== '') {
        if (character === '\\') {
          index += 1
          continue
        }
        if (character === quote) quote = ''
        continue
      }
      if (character === "'" || character === '"') {
        quote = character
        continue
      }
      if (character === '{') depth += 1
      else if (character === '}') {
        depth -= 1
        if (depth === 0) return bounded.slice(open, index + 1)
      }
    }
    return null
  }

  /** Parse the flat string/number keys used by a KVS flashvars object. */
  function parseKvsFlashvars(source) {
    var text =
      typeof source === 'string' ? extractFlashvarsObject(source) : null
    if (text === null) return {}
    var result = {}
    var pair =
      /(?:^|[,{\s])(?:([A-Za-z_$][\w$]*)|'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)")\s*:/g
    var match
    while ((match = pair.exec(text)) !== null) {
      var key = match[1] || unescapeJsString(match[2] || match[3] || '')
      if (!/^(?:video_(?:url|alt_url\d*)(?:_text)?|license_code|preview_url|video_id)$/.test(key)) {
        continue
      }
      var cursor = pair.lastIndex
      while (cursor < text.length && /\s/.test(text.charAt(cursor))) cursor += 1
      var character = text.charAt(cursor)
      var value = null
      if (character === "'" || character === '"') {
        var end = cursor + 1
        while (end < text.length) {
          if (text.charAt(end) === '\\') {
            end += 2
            continue
          }
          if (text.charAt(end) === character) break
          end += 1
        }
        value = unescapeJsString(text.slice(cursor + 1, end))
        pair.lastIndex = end + 1
      } else if (character === '{' || character === '[') {
        // Nested values are irrelevant to a URL; skip the balanced value.
        var open = character
        var close = character === '{' ? '}' : ']'
        var depth = 0
        var quote = ''
        var scan = cursor
        for (; scan < text.length; scan += 1) {
          var current = text.charAt(scan)
          if (quote !== '') {
            if (current === '\\') {
              scan += 1
              continue
            }
            if (current === quote) quote = ''
            continue
          }
          if (current === "'" || current === '"') {
            quote = current
            continue
          }
          if (current === open) depth += 1
          else if (current === close) {
            depth -= 1
            if (depth === 0) break
          }
        }
        pair.lastIndex = scan + 1
      } else {
        var stop = cursor
        while (stop < text.length && text.charAt(stop) !== ',' && text.charAt(stop) !== '}') {
          stop += 1
        }
        value = unescapeJsString(text.slice(cursor, stop).trim())
        pair.lastIndex = stop
      }
      if (value !== null && value.length <= 4096) result[key] = value
    }
    return result
  }

  /**
   * yt-dlp's documented KVS license-token sequence. Kept separate so a test
   * can cross-check it with an independent implementation.
   */
  function kvsLicenseToken(licenseCode) {
    var code = String(licenseCode || '').replace(/\$/g, '')
    if (!/^\d+$/.test(code) || code.length < 2) return null
    var values = code.split('').map(Number)
    var modlicense = code.replace(/0/g, '1')
    var center = Math.floor(modlicense.length / 2)
    var front = parseInt(modlicense.slice(0, center + 1), 10)
    var back = parseInt(modlicense.slice(center), 10)
    if (!Number.isFinite(front) || !Number.isFinite(back)) return null
    modlicense = String(4 * Math.abs(front - back)).slice(0, center + 1)
    var token = []
    for (var index = 0; index < modlicense.length; index += 1) {
      var current = Number(modlicense.charAt(index))
      for (var offset = 0; offset < 4; offset += 1) {
        token.push((values[index + offset] + current) % 10)
      }
    }
    return token
  }

  /** Decode `function/0/<url>` exactly like yt-dlp's _kvs_get_real_url. */
  function kvsDecodeUrl(videoUrl, licenseCode) {
    if (typeof videoUrl !== 'string') return null
    if (videoUrl.indexOf('function/0/') !== 0) return videoUrl
    var token = kvsLicenseToken(licenseCode)
    if (token === null || token.length < 32) return null
    var rest = videoUrl.slice('function/0/'.length)
    var parsed
    try {
      parsed = new URL(rest)
    } catch {
      return null
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    if (!parsed.hostname || parsed.username || parsed.password) return null
    var parts = parsed.pathname.split('/')
    if (parts.length < 4) return null
    var segment = parts[3] || ''
    var hash = segment.slice(0, 32)
    if (hash.length !== 32) return null
    var indices = []
    for (var index = 0; index < 32; index += 1) indices.push(index)
    var accum = 0
    for (var source = 31; source >= 0; source -= 1) {
      accum += token[source]
      var destination = (source + accum) % 32
      var swap = indices[source]
      indices[source] = indices[destination]
      indices[destination] = swap
    }
    var decodedHash = ''
    for (var hashIndex = 0; hashIndex < 32; hashIndex += 1) {
      decodedHash += hash.charAt(indices[hashIndex])
    }
    parts[3] = decodedHash + segment.slice(32)
    parsed.pathname = parts.join('/')
    return parsed.href
  }

  function hostAllowed(host, pageHost) {
    return host === pageHost || host.endsWith('.' + pageHost)
  }

  function basenameForPath(pathname) {
    try {
      var segment = String(pathname || '')
        .replace(/\/+$/, '')
        .split('/')
        .filter(Boolean)
        .pop()
      return decodeURIComponent(segment || '')
    } catch {
      return ''
    }
  }

  function qualityLabelFor(key, flashvars, url) {
    var text = flashvars[key + '_text']
    if (typeof text === 'string' && /^\d{2,5}p$/.test(text)) return text
    var match = /(?:^|[_-])(\d{3,5})p(?:[._-]|$)/i.exec(url)
    return match ? match[1] + 'p' : null
  }

  /**
   * Turn flashvars into progressive candidates for one page. Only http(s)
   * URLs on the page host (or a subdomain) survive.
   */
  function sourcesFromFlashvars(flashvars, pageUrl) {
    var page
    try {
      page = new URL(pageUrl)
    } catch {
      return []
    }
    if (page.protocol !== 'http:' && page.protocol !== 'https:') return []
    if (!flashvars || typeof flashvars !== 'object') return []
    var keys = Object.keys(flashvars).filter(function (key) {
      return /^video_(?:url|alt_url\d*)$/.test(key)
    })
    keys.sort(function (left, right) {
      if (left === 'video_url') return -1
      if (right === 'video_url') return 1
      return left.localeCompare(right)
    })
    var seen = Object.create(null)
    var result = []
    for (var index = 0; index < keys.length; index += 1) {
      var key = keys[index]
      var raw = flashvars[key]
      if (typeof raw !== 'string' || raw.indexOf('/get_file/') === -1) continue
      var decoded = kvsDecodeUrl(raw, flashvars.license_code)
      if (decoded === null) continue
      var resolved
      try {
        resolved = new URL(decoded, pageUrl)
      } catch {
        continue
      }
      if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') continue
      if (!resolved.hostname || resolved.username || resolved.password) continue
      if (!hostAllowed(resolved.hostname.toLowerCase(), page.hostname.toLowerCase())) {
        continue
      }
      var url = resolved.href.replace(/#.*$/, '')
      if (seen[url] === true) continue
      seen[url] = true
      var filename = basenameForPath(resolved.pathname)
      result.push({
        kind: 'verified',
        url: url,
        container: /\.webm\/?$/i.test(resolved.pathname) ? 'webm' : 'mp4',
        filename: (filename || 'video.mp4').slice(0, 180),
        qualityLabel: qualityLabelFor(key, flashvars, resolved.href),
        width: null,
        height: null,
        usePageHeaders: true
      })
      if (result.length >= 16) break
    }
    return result
  }

  function scriptTexts(doc) {
    if (!doc || typeof doc.querySelectorAll !== 'function') return []
    var scripts
    try {
      scripts = doc.querySelectorAll('script')
    } catch {
      return []
    }
    var texts = []
    for (var index = 0; index < scripts.length; index += 1) {
      var text = scripts[index] && scripts[index].textContent
      if (typeof text === 'string' && text.indexOf('flashvars') !== -1) {
        texts.push(text)
      }
    }
    return texts
  }

  function isKvsDocument(doc) {
    if (!doc) return false
    try {
      if (doc.getElementById && doc.getElementById('kt_player')) return true
    } catch {
      return false
    }
    var scripts = scriptTexts(doc)
    for (var index = 0; index < scripts.length; index += 1) {
      if (scripts[index].indexOf('kt_player(') !== -1) return true
    }
    return false
  }

  function collectKvsSources(doc, pageUrl) {
    if (!isKvsDocument(doc)) return []
    var scripts = scriptTexts(doc)
    for (var index = 0; index < scripts.length; index += 1) {
      var flashvars = parseKvsFlashvars(scripts[index])
      var sources = sourcesFromFlashvars(flashvars, pageUrl)
      if (sources.length > 0) return sources
    }
    return []
  }

  /**
   * Attach KVS qualities to an existing player record. Called when the overlay
   * first sees the video, before play, so the icon and quality rows are ready.
   */
  function applyKvsSources(player, doc, pageUrl) {
    if (!player || player.kvsApplied === true) return false
    player.kvsApplied = true
    if (!ns.core || typeof ns.core.addCapturedSource !== 'function') return false
    var candidates = collectKvsSources(doc, pageUrl)
    if (candidates.length === 0) return false
    var sources = Array.isArray(player.sources) ? player.sources : []
    for (var index = 0; index < candidates.length; index += 1) {
      sources = ns.core.addCapturedSource(sources, candidates[index])
    }
    player.sources = sources
    return true
  }

  ns.parseKvsFlashvars = parseKvsFlashvars
  ns.kvsLicenseToken = kvsLicenseToken
  ns.kvsDecodeUrl = kvsDecodeUrl
  ns.sourcesFromFlashvars = sourcesFromFlashvars
  ns.collectKvsSources = collectKvsSources
  ns.applyKvsSources = applyKvsSources
})()
