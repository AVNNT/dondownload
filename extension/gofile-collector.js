// Gofile share extraction for "Scan this page".
//
// This file is injected into the user's own Gofile tab with
// chrome.scripting.executeScript (activeTab is enough; no host permission is
// added), so it is a classic content script: no imports, and its API lives on
// globalThis.
//
// The page https://gofile.io/d/<id> is a JavaScript application: the file rows,
// their sizes and the store<N>.gofile.io download links only exist after the
// app rendered them. The collector therefore waits for that render (bounded),
// reads the rows from the live DOM, and reports them to the extension, which
// forwards them through the existing scan bridge.
//
// Hard rules, enforced here and re-checked by the desktop:
//  - never call api.gofile.io, never read localStorage/sessionStorage tokens,
//    never create or use a guest account;
//  - never read a cookie (the extension does that separately, once);
//  - never run in the page's main world: this is an isolated content script;
//  - only report download links on gofile.io or *.gofile.io.

;(function () {
  'use strict'

  var MAX_FILES = 500
  var MAX_DEPTH = 2
  var MAX_NAME_LENGTH = 240
  var MAX_FOLDERS = 10
  var WAIT_MS = 15000
  var FOLDER_WAIT_MS = 5000
  var POLL_MS = 200
  var MAX_ANCESTOR_DEPTH = 6
  var MAX_ROW_TEXT = 400
  var MAX_PAGE_TEXT = 8000
  var RUN_KEY = '__donDownloadGofileRun'
  var SHARE_ID = /^[A-Za-z0-9_-]{4,64}$/
  var SIZE_TEXT = /(\d+(?:[.,]\d+)?)\s*(B|KB|KIB|MB|MIB|GB|GIB|TB|TIB|K|M|G)(?![a-z0-9])/i
  var UNIT_BYTES = {
    B: 1,
    K: 1024,
    KB: 1024,
    KIB: 1024,
    M: 1024 * 1024,
    MB: 1024 * 1024,
    MIB: 1024 * 1024,
    G: 1024 * 1024 * 1024,
    GB: 1024 * 1024 * 1024,
    GIB: 1024 * 1024 * 1024,
    T: 1024 * 1024 * 1024 * 1024,
    TB: 1024 * 1024 * 1024 * 1024,
    TIB: 1024 * 1024 * 1024 * 1024
  }

  function isGofileHost(hostname) {
    if (typeof hostname !== 'string') return false
    var host = hostname.toLowerCase()
    if (host === 'gofile.io' || host === 'www.gofile.io') return true
    return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.gofile\.io$/.test(host)
  }

  function isShareHost(hostname) {
    if (typeof hostname !== 'string') return false
    var host = hostname.toLowerCase()
    return host === 'gofile.io' || host === 'www.gofile.io'
  }

  /** Page URL the collector is looking at. */
  function pageUrl(doc, win) {
    if (win && win.location && typeof win.location.href === 'string') {
      return win.location.href
    }
    if (doc && typeof doc.URL === 'string' && doc.URL.length > 0) return doc.URL
    if (doc && typeof doc.baseURI === 'string') return doc.baseURI
    return ''
  }

  /** `https://gofile.io/d/<id>` -> `<id>`, anything else -> null. */
  function shareIdFromUrl(raw) {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > 4096) return null
    var parsed
    try {
      parsed = new URL(raw)
    } catch {
      return null
    }
    if (parsed.protocol !== 'https:') return null
    if (parsed.username || parsed.password) return null
    if (!isShareHost(parsed.hostname)) return null
    var match = /^\/d\/([^/]+)\/?$/.exec(parsed.pathname)
    if (!match) return null
    return SHARE_ID.test(match[1]) ? match[1] : null
  }

  /** A download link the rendered page exposed, on Gofile only. */
  function isDownloadUrl(raw) {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > 4096) return false
    var parsed
    try {
      parsed = new URL(raw)
    } catch {
      return false
    }
    if (parsed.protocol !== 'https:') return false
    if (parsed.username || parsed.password) return false
    if (!isGofileHost(parsed.hostname)) return false
    return /^\/download\//.test(parsed.pathname)
  }

  /** The last path segment is the file name Gofile itself serves. */
  function fileNameFromUrl(raw) {
    var parsed
    try {
      parsed = new URL(raw)
    } catch {
      return null
    }
    var segments = parsed.pathname.split('/').filter(function (part) {
      return part.length > 0
    })
    if (segments.length === 0) return null
    var last = segments[segments.length - 1]
    var decoded = last
    try {
      decoded = decodeURIComponent(last)
    } catch {
      decoded = last
    }
    return cleanName(decoded)
  }

  function cleanName(value) {
    if (typeof value !== 'string') return null
    var cleaned = value
      // eslint-disable-next-line no-control-regex -- rejecting control characters is the security intent
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (cleaned.length === 0) return null
    return cleaned.slice(0, MAX_NAME_LENGTH).trim()
  }

  /** `1.4 GB` -> bytes. Unknown or absent text stays null. */
  function parseSizeText(text) {
    if (typeof text !== 'string') return null
    var match = SIZE_TEXT.exec(text)
    if (!match) return null
    var value = parseFloat(match[1].replace(',', '.'))
    if (!isFinite(value) || value <= 0) return null
    var unit = UNIT_BYTES[match[2].toUpperCase()]
    if (!unit) return null
    return Math.round(value * unit)
  }

  function textOf(node) {
    if (!node || typeof node.textContent !== 'string') return ''
    return node.textContent
  }

  /** The nearest ancestor row text that carries a size, bounded and cheap. */
  function sizeForAnchor(anchor) {
    var node = anchor
    for (var depth = 0; depth < MAX_ANCESTOR_DEPTH; depth += 1) {
      if (!node) return null
      var text = textOf(node).slice(0, MAX_ROW_TEXT)
      if (text.length > 0) {
        var size = parseSizeText(text)
        if (size !== null) return size
      }
      node = node.parentNode
    }
    return null
  }

  function absoluteHref(anchor, base) {
    var raw = anchor && typeof anchor.getAttribute === 'function' ? anchor.getAttribute('href') : null
    if (typeof raw !== 'string' || raw.length === 0) {
      raw = anchor && typeof anchor.href === 'string' ? anchor.href : null
    }
    if (typeof raw !== 'string' || raw.length === 0) return null
    try {
      return new URL(raw, base).href
    } catch {
      return null
    }
  }

  /**
   * Read every rendered row. Files are the download links; folders are the
   * same-share links the page rendered (they are followed by `collectShare`
   * only when asked to).
   */
  function readRows(doc, shareId) {
    var files = []
    var folders = []
    var seenFiles = {}
    var seenFolders = {}
    if (!doc || typeof doc.querySelectorAll !== 'function') {
      return { files: files, folders: folders }
    }
    var base = pageUrl(doc, null)
    var anchors = doc.querySelectorAll('a[href]')
    for (var index = 0; index < anchors.length; index += 1) {
      var anchor = anchors[index]
      var href = absoluteHref(anchor, base)
      if (href === null) continue
      if (isDownloadUrl(href)) {
        if (seenFiles[href]) continue
        seenFiles[href] = true
        var name = fileNameFromUrl(href)
        if (name === null) name = cleanName(textOf(anchor))
        if (name === null) continue
        files.push({ name: name, size: sizeForAnchor(anchor), url: href })
        if (files.length >= MAX_FILES) break
        continue
      }
      if (shareIdFromUrl(href) !== shareId) continue
      if (href === base) continue
      if (seenFolders[href]) continue
      seenFolders[href] = true
      folders.push({ url: href, name: cleanName(textOf(anchor)) })
    }
    return { files: files, folders: folders }
  }

  /**
   * Why a share rendered no rows. Only text the page itself shows is used, so
   * the desktop can display the reason without guessing.
   */
  function shareState(doc) {
    var text = ''
    if (doc && doc.body) text = textOf(doc.body).slice(0, MAX_PAGE_TEXT)
    if (typeof doc.querySelector === 'function') {
      if (doc.querySelector('input[type="password"]')) return 'password'
      if (doc.querySelector('input[type=password]')) return 'password'
    }
    if (/password/i.test(text)) return 'password'
    if (/\bpremium\b/i.test(text)) return 'premium'
    if (/(not found|does not exist|no longer available|has been removed|invalid link)/i.test(text)) {
      return 'not-found'
    }
    return 'empty'
  }

  function mergeFiles(target, incoming) {
    var seen = {}
    var index
    for (index = 0; index < target.length; index += 1) seen[target[index].url] = true
    for (index = 0; index < incoming.length; index += 1) {
      var file = incoming[index]
      if (seen[file.url]) continue
      seen[file.url] = true
      target.push(file)
      if (target.length >= MAX_FILES) break
    }
    return target
  }

  /**
   * Wait until at least `minFiles` rows are rendered, or the bounded wait ends.
   * A MutationObserver is used when the page provides one; otherwise the same
   * promise resolves from a poll, so both paths behave identically.
   */
  function waitForRows(doc, win, shareId, options) {
    var waitMs = options && typeof options.waitMs === 'number' ? options.waitMs : WAIT_MS
    var minFiles = options && typeof options.minFiles === 'number' ? options.minFiles : 1
    var pollMs = options && typeof options.pollMs === 'number' ? options.pollMs : POLL_MS

    return new Promise(function (resolve) {
      var settled = false
      var timer = null
      var pollTimer = null
      var observer = null

      function cleanup() {
        if (timer !== null && win && typeof win.clearTimeout === 'function') {
          win.clearTimeout(timer)
        }
        if (pollTimer !== null && win && typeof win.clearTimeout === 'function') {
          win.clearTimeout(pollTimer)
        }
        if (observer && typeof observer.disconnect === 'function') observer.disconnect()
        timer = null
        pollTimer = null
        observer = null
      }

      function finish(rows) {
        if (settled) return
        settled = true
        cleanup()
        resolve(rows)
      }

      function check() {
        var rows = readRows(doc, shareId)
        if (rows.files.length >= minFiles) finish(rows)
        return rows
      }

      var initial = check()
      if (settled) return

      if (win && typeof win.setTimeout === 'function') {
        timer = win.setTimeout(function () {
          finish(readRows(doc, shareId))
        }, waitMs)
      } else {
        finish(initial)
        return
      }

      if (win && typeof win.MutationObserver === 'function') {
        try {
          observer = new win.MutationObserver(function () {
            check()
          })
          var target = doc && doc.body ? doc.body : doc
          if (target && typeof observer.observe === 'function') {
            observer.observe(target, { childList: true, subtree: true, characterData: true })
          }
        } catch {
          observer = null
        }
      }
      if (observer === null && typeof win.setInterval === 'function') {
        pollTimer = win.setInterval(function () {
          check()
        }, pollMs)
      }
    })
  }

  function clickFolder(anchor, options) {
    if (options && typeof options.clickFolder === 'function') {
      return Promise.resolve(options.clickFolder(anchor))
    }
    return Promise.resolve().then(function () {
      if (anchor && typeof anchor.click === 'function') anchor.click()
    })
  }

  /** Find the rendered anchor for one folder link. */
  function anchorForFolder(doc, url) {
    if (!doc || typeof doc.querySelectorAll !== 'function') return null
    var base = pageUrl(doc, null)
    var anchors = doc.querySelectorAll('a[href]')
    for (var index = 0; index < anchors.length; index += 1) {
      if (absoluteHref(anchors[index], base) === url) return anchors[index]
    }
    return null
  }

  /**
   * Follow the rendered subfolder links inside the same share, depth-capped, so
   * a nested share lists its files in one scan. Nothing is typed or fetched:
   * the page's own rendered links are clicked.
   */
  function followFolders(doc, win, shareId, files, folders, options) {
    var queue = folders.slice(0, MAX_FOLDERS)
    var visited = {}
    var depth = 0

    function step() {
      if (files.length >= MAX_FILES) return Promise.resolve()
      if (depth >= MAX_DEPTH || queue.length === 0) return Promise.resolve()
      var folder = queue.shift()
      if (!folder || visited[folder.url]) return step()
      visited[folder.url] = true
      var anchor = anchorForFolder(doc, folder.url)
      if (anchor === null) return step()
      depth += 1
      return clickFolder(anchor, options)
        .then(function () {
          return waitForRows(doc, win, shareId, {
            waitMs: options && typeof options.folderWaitMs === 'number'
              ? options.folderWaitMs
              : FOLDER_WAIT_MS,
            minFiles: files.length + 1,
            pollMs: options && typeof options.pollMs === 'number' ? options.pollMs : POLL_MS
          })
        })
        .then(function (rows) {
          mergeFiles(files, rows.files)
          for (var index = 0; index < rows.folders.length; index += 1) {
            var candidate = rows.folders[index]
            if (visited[candidate.url]) continue
            queue.push(candidate)
          }
          return step()
        })
    }

    return step()
  }

  /**
   * Collect one share. Resolves with `{ shareId, status, files, folders }`:
   * `status` is `ok` when files were read, otherwise the reason the page shows
   * (`empty`, `password`, `premium`, `not-found`, `timeout`).
   */
  function collectShare(doc, win, options) {
    var settings = options && typeof options === 'object' ? options : {}
    var shareId = shareIdFromUrl(pageUrl(doc, win))
    if (shareId === null) {
      return Promise.resolve({
        shareId: null,
        status: 'not-found',
        files: [],
        folders: 0
      })
    }

    return waitForRows(doc, win, shareId, settings).then(function (rows) {
      var files = mergeFiles([], rows.files)
      if (files.length === 0) {
        return {
          shareId: shareId,
          status: shareState(doc),
          files: [],
          folders: rows.folders.length
        }
      }
      if (settings.followFolders === false || rows.folders.length === 0) {
        return {
          shareId: shareId,
          status: 'ok',
          files: files,
          folders: rows.folders.length
        }
      }
      return followFolders(doc, win, shareId, files, rows.folders, settings).then(
        function () {
          return {
            shareId: shareId,
            status: 'ok',
            files: files,
            folders: rows.folders.length
          }
        }
      )
    })
  }

  /**
   * Start a run whose result the popup polls. Keeping the promise result on a
   * global means a closed popup never loses the extraction, and the popup does
   * not depend on executeScript awaiting a promise.
   */
  function startRun(doc, win, options) {
    var run = { done: false, result: null }
    globalThis[RUN_KEY] = run
    collectShare(doc, win, options).then(
      function (result) {
        run.result = result
        run.done = true
      },
      function () {
        run.result = { shareId: null, status: 'timeout', files: [], folders: 0 }
        run.done = true
      }
    )
    return true
  }

  globalThis.DonDownloadGofileCollector = {
    MAX_FILES: MAX_FILES,
    MAX_DEPTH: MAX_DEPTH,
    WAIT_MS: WAIT_MS,
    RUN_KEY: RUN_KEY,
    isGofileHost: isGofileHost,
    shareIdFromUrl: shareIdFromUrl,
    isDownloadUrl: isDownloadUrl,
    fileNameFromUrl: fileNameFromUrl,
    parseSizeText: parseSizeText,
    readRows: readRows,
    shareState: shareState,
    waitForRows: waitForRows,
    collectShare: collectShare,
    startRun: startRun
  }
})()
