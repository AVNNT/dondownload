// Gofile share extraction for "Scan this page".
//
// This file is injected into the user's own Gofile tab with
// chrome.scripting.executeScript (activeTab is enough; no host permission is
// added), so it is a classic content script: no imports, and its API lives on
// globalThis.
//
// The page https://gofile.io/d/<id> is a JavaScript application: the file rows,
// their sizes and the store<N>.gofile.io download links only exist after the
// app rendered them. The collector therefore waits for that render (bounded)
// and reads the rows from the live DOM.
//
// The real frontend renders a row with buttons, not anchors: the name cell is a
// `<button type="button" data-action="…">name</button>`, the download control is
// `<button type="button" data-action="download">`, and the only anchor in a row
// is a folder link `<a href="/d/<code>" data-action="navigate">`. The download
// URL is never in the DOM at all — manager.js creates a transient anchor,
// clicks it and removes it. So a row's URL can only be learned by letting the
// browser start that download and reading it back in the background, which is
// why `captureDownloads` clicks each row's download button in turn.
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
  var MAX_ROW_NODES = 400
  var MAX_ROW_TEXT = 400
  var MAX_PAGE_TEXT = 8000
  /** Pause between two download-button clicks, so each download is recorded. */
  var CLICK_DELAY_MS = 120
  /** Hard cap on the whole click pass; a huge share must never hang the scan. */
  var CAPTURE_BUDGET_MS = 20000
  var RUN_KEY = '__donDownloadGofileRun'
  var SHARE_ID = /^[A-Za-z0-9_-]{4,64}$/
  var SIZE_TEXT = /(\d+(?:[.,]\d+)?)\s*(B|KB|KIB|MB|MIB|GB|GIB|TB|TIB|K|M|G)(?![a-z0-9])/i
  var SIZE_ONLY = /^\s*(\d+(?:[.,]\d+)?)\s*(B|KB|KIB|MB|MIB|GB|GIB|TB|TIB|K|M|G)\s*$/i
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

  /** A cell that holds nothing but a size, so a name is never read as one. */
  function parseSizeOnly(text) {
    if (typeof text !== 'string') return null
    var match = SIZE_ONLY.exec(text)
    if (!match) return null
    return parseSizeText(match[0])
  }

  function textOf(node) {
    if (!node || typeof node.textContent !== 'string') return ''
    return node.textContent
  }

  function actionOf(node) {
    if (!node || typeof node.getAttribute !== 'function') return ''
    var value = node.getAttribute('data-action')
    return typeof value === 'string' ? value.trim().toLowerCase() : ''
  }

  function queryAll(doc, selector) {
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
    for (var index = 0; index < length && index < MAX_FILES * 4; index += 1) {
      list.push(found[index])
    }
    return list
  }

  /** Depth-first walk of the rendered children, bounded. */
  function walk(node, visit) {
    if (!node) return
    var children = node.children
    if (!children || typeof children.length !== 'number') return
    for (var index = 0; index < children.length; index += 1) {
      var child = children[index]
      if (!child) continue
      visit(child)
      walk(child, visit)
    }
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
   * The row container of one download button: the nearest ancestor that holds a
   * name cell. Bounded, so a row-less button cannot walk the whole document.
   */
  function rowFor(node) {
    var current = node && node.parentNode ? node.parentNode : null
    for (var depth = 0; depth < MAX_ANCESTOR_DEPTH && current; depth += 1) {
      if (nameInRow(current) !== null) return current
      current = current.parentNode
    }
    return node && node.parentNode ? node.parentNode : null
  }

  /**
   * The name cell of a row. The real frontend puts it in a button with its own
   * `data-action`, so that is read first; otherwise the first text-only leaf
   * that is not the download control and not a size cell is used.
   */
  function nameInRow(row) {
    if (!row) return null
    var actionName = null
    var leafName = null
    var visited = 0
    walk(row, function (node) {
      if (actionName !== null || visited >= MAX_ROW_NODES) return
      visited += 1
      var action = actionOf(node)
      if (action === 'download' || action === 'navigate') return
      var text = cleanName(textOf(node))
      if (text === null) return
      if (action.length > 0 && actionName === null) {
        actionName = text
        return
      }
      if (leafName !== null) return
      var children = node.children
      if (children && typeof children.length === 'number' && children.length > 0) return
      if (parseSizeOnly(text) !== null) return
      leafName = text
    })
    return actionName !== null ? actionName : leafName
  }

  /** The size the row shows, from a size-only cell first, then its text. */
  function sizeInRow(row) {
    if (!row) return null
    var exact = null
    var visited = 0
    walk(row, function (node) {
      if (exact !== null || visited >= MAX_ROW_NODES) return
      visited += 1
      var children = node.children
      if (children && typeof children.length === 'number' && children.length > 0) return
      var size = parseSizeOnly(textOf(node))
      if (size !== null) exact = size
    })
    if (exact !== null) return exact
    return parseSizeText(textOf(row).slice(0, MAX_ROW_TEXT))
  }

  function tagOf(node) {
    if (!node) return ''
    var tag = node.tagName || node.localName || node.tag || ''
    return typeof tag === 'string' ? tag.toLowerCase() : ''
  }

  /**
   * Read every rendered row, in document order. A row is a download button (the
   * real frontend) or, on a page that does render links, a Gofile download
   * anchor. `url` is null for a button row: the page never exposes that URL, so
   * the background fills it from the browser download the click produced.
   */
  function readRowElements(doc, shareId) {
    var files = []
    var folders = []
    var seenFiles = {}
    var seenFolders = {}
    if (!doc || typeof doc.querySelectorAll !== 'function') {
      return { files: files, folders: folders }
    }
    var base = pageUrl(doc, null)
    var body = doc.body ? doc.body : null
    if (body === null) return { files: files, folders: folders }

    walk(body, function (node) {
      if (files.length >= MAX_FILES) return
      if (typeof node.getAttribute !== 'function') return
      var action = actionOf(node)

      if (action === 'download') {
        var row = rowFor(node)
        var name = nameInRow(row)
        if (name === null) return
        var key = name.toLowerCase()
        if (seenFiles[key]) return
        seenFiles[key] = true
        files.push({ name: name, size: sizeInRow(row), url: null, node: node })
        return
      }

      if (tagOf(node) !== 'a') return
      var href = absoluteHref(node, base)
      if (href === null) return
      if (isDownloadUrl(href)) {
        if (seenFiles[href]) return
        seenFiles[href] = true
        var hrefName = fileNameFromUrl(href)
        if (hrefName === null) hrefName = nameInRow(rowFor(node))
        if (hrefName === null) hrefName = cleanName(textOf(node))
        if (hrefName === null) return
        files.push({
          name: hrefName,
          size: sizeInRow(rowFor(node)),
          url: href,
          node: node
        })
        return
      }
      if (href === base) return
      if (folders.length >= MAX_FOLDERS) return
      // A folder link the frontend renders is `/d/<folder code>` with its own
      // action; a plain anchor still has to name this same share.
      var isFolderLink = action === 'navigate' && isShareHost(hostOf(href))
      if (!isFolderLink && shareIdFromUrl(href) !== shareId) return
      if (seenFolders[href]) return
      seenFolders[href] = true
      folders.push({ url: href, name: cleanName(textOf(node)), node: node })
    })

    return { files: files, folders: folders }
  }

  function hostOf(raw) {
    try {
      return new URL(raw).hostname.toLowerCase()
    } catch {
      return ''
    }
  }

  /** The public row shape: the click target never leaves this file. */
  function publicRows(rows) {
    var files = []
    for (var index = 0; index < rows.files.length; index += 1) {
      var file = rows.files[index]
      files.push({ name: file.name, size: file.size, url: file.url })
    }
    var folders = []
    for (var folderIndex = 0; folderIndex < rows.folders.length; folderIndex += 1) {
      var folder = rows.folders[folderIndex]
      folders.push({ url: folder.url, name: folder.name })
    }
    return { files: files, folders: folders }
  }

  /** Read every rendered row, without the internal click targets. */
  function readRows(doc, shareId) {
    return publicRows(readRowElements(doc, shareId))
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

  function fileKey(file) {
    if (typeof file.url === 'string' && file.url.length > 0) return file.url
    return 'name:' + file.name.toLowerCase()
  }

  function mergeFiles(target, incoming) {
    var seen = {}
    var index
    for (index = 0; index < target.length; index += 1) seen[fileKey(target[index])] = true
    for (index = 0; index < incoming.length; index += 1) {
      var file = incoming[index]
      var key = fileKey(file)
      if (seen[key]) continue
      seen[key] = true
      target.push(file)
      if (target.length >= MAX_FILES) break
    }
    return target
  }

  function sleep(win, ms) {
    return new Promise(function (resolve) {
      if (win && typeof win.setTimeout === 'function') {
        win.setTimeout(resolve, ms)
        return
      }
      resolve()
    })
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
    var anchors = queryAll(doc, 'a[href]')
    var base = pageUrl(doc, null)
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
   * Click every row's download button in turn. The page creates the transfer
   * from a transient anchor, so this is the only way to learn a row's URL; the
   * background records each started download and cancels it. Bounded by the
   * file cap, the per-click pause and a total budget.
   */
  function clickDownloadRows(doc, win, options) {
    var settings = options && typeof options === 'object' ? options : {}
    var shareId = shareIdFromUrl(pageUrl(doc, win))
    var delay = typeof settings.clickDelayMs === 'number' && settings.clickDelayMs >= 0
      ? settings.clickDelayMs
      : CLICK_DELAY_MS
    var budget = typeof settings.captureBudgetMs === 'number' && settings.captureBudgetMs > 0
      ? settings.captureBudgetMs
      : CAPTURE_BUDGET_MS
    var rows = readRowElements(doc, shareId)
    var targets = []
    for (var index = 0; index < rows.files.length; index += 1) {
      var file = rows.files[index]
      if (file.url !== null) continue
      if (!file.node || typeof file.node.click !== 'function') continue
      targets.push(file.node)
      if (targets.length >= MAX_FILES) break
    }
    var started = Date.now()
    var next = 0

    function step() {
      if (next >= targets.length) return Promise.resolve(next)
      if (Date.now() - started >= budget) return Promise.resolve(next)
      var node = targets[next]
      next += 1
      try {
        node.click()
      } catch {
        // A detached row cannot be clicked; the next one still can.
      }
      return sleep(win, delay).then(step)
    }

    return step()
  }

  /**
   * Collect one share. Resolves with `{ shareId, status, files, folders }`:
   * `status` is `ok` when rows were read, otherwise the reason the page shows
   * (`empty`, `password`, `premium`, `not-found`, `timeout`). A file whose
   * download URL the page never exposed has `url: null`; the background fills
   * it from the browser download the click produced.
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
    }).then(function (result) {
      if (settings.captureDownloads !== true) return result
      if (result.status !== 'ok') return result
      return clickDownloadRows(doc, win, settings).then(function () {
        return result
      })
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
    CLICK_DELAY_MS: CLICK_DELAY_MS,
    CAPTURE_BUDGET_MS: CAPTURE_BUDGET_MS,
    RUN_KEY: RUN_KEY,
    isGofileHost: isGofileHost,
    shareIdFromUrl: shareIdFromUrl,
    isDownloadUrl: isDownloadUrl,
    fileNameFromUrl: fileNameFromUrl,
    parseSizeText: parseSizeText,
    readRows: readRows,
    shareState: shareState,
    waitForRows: waitForRows,
    clickDownloadRows: clickDownloadRows,
    collectShare: collectShare,
    startRun: startRun
  }
})()
