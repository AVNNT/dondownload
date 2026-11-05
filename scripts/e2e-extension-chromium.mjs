#!/usr/bin/env node
// Non-visible real-Chromium end-to-end check for the MV3 extension.
//
// Only already-installed tooling is used:
//   - Playwright's Chromium build (%LOCALAPPDATA%\ms-playwright\chromium-1248)
//   - the repository's FFmpeg (build/vendor/ffmpeg/ffmpeg.exe)
//   - Node built-ins (http, crypto, child_process, global WebSocket)
//
// Nothing is installed, no real browser profile is touched, the native
// messaging host is never registered and every file lives in a fresh temp dir.
//
// The interactive chrome.permissions.request() bubble does not work in
// headless Chromium: the callback is never invoked and chrome.permissions never
// changes (verified by scenario 2a). The remaining scenarios therefore run the
// same extension sources from a temp copy whose manifest declares the optional
// permissions as required for the loopback fixture origin only. This is
// reported explicitly in the result table; it is not presented as the real
// grant flow.

import { execFileSync, spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(SCRIPT_DIR, '..')
const EXTENSION_DIR = path.join(ROOT, 'extension')
const FFMPEG = path.join(ROOT, 'build', 'vendor', 'ffmpeg', 'ffmpeg.exe')
const CHROME =
  process.env.DONDOWNLOAD_CHROME_PATH ||
  path.join(process.env.LOCALAPPDATA || '', 'ms-playwright', 'chromium-1248', 'chrome-win64', 'chrome.exe')

const EXTENSION_NAME = 'DonDownload Capture'
const HANDOFF_STATE_KEY = 'dondownloadHandoffState'
const CAPTURE_SETTINGS_KEY = 'dondownloadCaptureSettings'
const OPTIONS_TARGET_KEY = 'dondownloadOptionsTarget'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
// results
// ---------------------------------------------------------------------------

const results = []

function record(id, title, status, evidence) {
  results.push({ id, title, status, evidence })
  const line = `[${status}] ${id} ${title}`
  console.log(line)
  if (evidence) console.log(`        ${String(evidence).replace(/\n/g, '\n        ')}`)
}

async function scenario(id, title, run) {
  try {
    const outcome = await run()
    if (!outcome) {
      record(id, title, 'FAIL', 'scenario returned no outcome')
      return
    }
    record(id, title, outcome.status, outcome.evidence)
  } catch (error) {
    record(id, title, 'FAIL', `unexpected error: ${error && error.message ? error.message : String(error)}`)
  }
}

// ---------------------------------------------------------------------------
// CDP client
// ---------------------------------------------------------------------------

class CdpConnection {
  constructor(wsUrl, label) {
    this.label = label
    this.nextId = 0
    this.pending = new Map()
    this.events = []
    this.ws = new WebSocket(wsUrl)
    this.closed = false
    this.sessionToTarget = new Map()
    this.targetToSession = new Map()
    this.ws.addEventListener('message', (event) => {
      let message
      try {
        message = JSON.parse(event.data)
      } catch {
        return
      }
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id)
        this.pending.delete(message.id)
        clearTimeout(pending.timer)
        if (message.error) pending.reject(new Error(JSON.stringify(message.error)))
        else pending.resolve(message.result)
        return
      }
      if (message.method) {
        this.events.push(message)
        if (message.method === 'Target.attachedToTarget') {
          const info = message.params
          this.sessionToTarget.set(info.sessionId, info.targetInfo.targetId)
          this.targetToSession.set(info.targetInfo.targetId, info.sessionId)
          // Enable domains immediately for every auto-attached target so early
          // worker/page errors are observable.
          if (info.targetInfo.type === 'service_worker' || info.targetInfo.type === 'page' || info.targetInfo.type === 'iframe') {
            void this.send('Runtime.enable', {}, info.sessionId).catch(() => undefined)
            void this.send('Log.enable', {}, info.sessionId).catch(() => undefined)
          }
        }
      }
    })
  }

  static async connect(wsUrl, label) {
    const connection = new CdpConnection(wsUrl, label)
    await new Promise((resolve, reject) => {
      connection.ws.addEventListener('open', resolve, { once: true })
      connection.ws.addEventListener('error', () => reject(new Error(`${label}: WebSocket connection failed`)), { once: true })
    })
    return connection
  }

  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error(`${this.label}: connection closed`))
    return new Promise((resolve, reject) => {
      const id = ++this.nextId
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${this.label}: CDP ${method} timed out`))
      }, 30000)
      this.pending.set(id, { resolve, reject, timer })
      const payload = { id, method, params }
      if (sessionId) payload.sessionId = sessionId
      try {
        this.ws.send(JSON.stringify(payload))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  async attach(targetId) {
    if (this.targetToSession.has(targetId)) return this.targetToSession.get(targetId)
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true })
    this.sessionToTarget.set(sessionId, targetId)
    this.targetToSession.set(targetId, sessionId)
    await this.send('Runtime.enable', {}, sessionId).catch(() => undefined)
    await this.send('Log.enable', {}, sessionId).catch(() => undefined)
    return sessionId
  }

  async evaluate(sessionId, expression, { userGesture = true, awaitPromise = true } = {}) {
    const result = await this.send(
      'Runtime.evaluate',
      { expression, awaitPromise, returnByValue: true, userGesture },
      sessionId
    )
    if (result.exceptionDetails) {
      const description =
        (result.exceptionDetails.exception && result.exceptionDetails.exception.description) ||
        result.exceptionDetails.text ||
        'evaluation failed'
      throw new Error(description)
    }
    return result.result ? result.result.value : undefined
  }

  async targets() {
    const { targetInfos } = await this.send('Target.getTargets')
    return targetInfos
  }

  close() {
    this.closed = true
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error(`${this.label}: connection closed`))
    }
    this.pending.clear()
    try {
      this.ws.close()
    } catch {
      // ignore
    }
  }
}

function errorEventsFor(connection, sessionId) {
  return connection.events.filter((event) => {
    if (sessionId && event.sessionId !== sessionId) return false
    if (event.method === 'Runtime.exceptionThrown') return true
    if (event.method === 'Runtime.consoleAPICalled') {
      return event.params.type === 'error' || event.params.type === 'assert'
    }
    if (event.method === 'Log.entryAdded') {
      return event.params.entry && event.params.entry.level === 'error'
    }
    return false
  })
}

function describeErrors(connection, sessionId) {
  return errorEventsFor(connection, sessionId).map((event) => {
    if (event.method === 'Runtime.exceptionThrown') {
      const details = event.params.exceptionDetails
      return `exception: ${(details.exception && details.exception.description) || details.text}`
    }
    if (event.method === 'Runtime.consoleAPICalled') {
      return `console.${event.params.type}: ${(event.params.args || [])
        .map((arg) => arg.value || arg.description || '')
        .join(' ')}`
    }
    return `log.${event.params.entry.level}: ${event.params.entry.text}`
  })
}

// ---------------------------------------------------------------------------
// browser process
// ---------------------------------------------------------------------------

function killTree(pid) {
  if (!pid) return
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  } catch {
    try {
      process.kill(pid)
    } catch {
      // already gone
    }
  }
}

async function launchChromium({ userDataDir, extensionPath, label, extraArgs = [] }) {
  const portFile = path.join(userDataDir, 'DevToolsActivePort')
  fs.mkdirSync(userDataDir, { recursive: true })
  try {
    fs.rmSync(portFile, { force: true })
  } catch {
    // ignore
  }
  const stderr = []
  const args = [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-background-networking',
    '--disable-component-update',
    '--metrics-recording-only',
    '--mute-audio',
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=1024,768',
    `--load-extension=${extensionPath}`,
    `--disable-extensions-except=${extensionPath}`,
    '--enable-unsafe-extension-debugging',
    ...extraArgs,
    'about:blank'
  ]
  const proc = spawn(CHROME, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  proc.stderr.on('data', (chunk) => {
    const text = String(chunk)
    stderr.push(text)
    if (stderr.length > 200) stderr.shift()
  })
  proc.on('exit', () => {
    // The DevTools endpoint is gone; further sends fail fast.
  })

  let devPort = null
  let browserPath = null
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (proc.exitCode !== null) throw new Error(`${label}: Chromium exited early`)
    try {
      const lines = fs.readFileSync(portFile, 'utf8').split('\n')
      const candidatePort = Number(lines[0])
      const candidatePath = lines[1] && lines[1].trim()
      if (candidatePort && candidatePath) {
        const response = await fetch(`http://127.0.0.1:${candidatePort}/json/version`)
        if (response.ok) {
          devPort = candidatePort
          browserPath = candidatePath
          break
        }
      }
    } catch {
      // still starting
    }
    await sleep(100)
  }
  if (!devPort) {
    killTree(proc.pid)
    throw new Error(`${label}: DevToolsActivePort was not usable. stderr=${stderr.join('').slice(-2000)}`)
  }

  const connection = await CdpConnection.connect(`ws://127.0.0.1:${devPort}${browserPath}`, label)
  try {
    await connection.send('Target.setDiscoverTargets', { discover: true })
    await connection.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true
    })
  } catch {
    // Auto-attach is best effort; manual attaches below still work.
  }

  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    try {
      await Promise.race([
        connection.send('Browser.close'),
        sleep(2000)
      ])
    } catch {
      // ignore
    }
    connection.close()
    await sleep(300)
    killTree(proc.pid)
    await sleep(300)
  }
  return { proc, connection, close, stderr }
}

async function findExtensionWorker(browser, { timeoutMs = 15000 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const targets = await browser.connection.targets().catch(() => [])
    for (const target of targets.filter((item) => item.type === 'service_worker')) {
      let sessionId
      try {
        sessionId = await browser.connection.attach(target.targetId)
        const name = await browser.connection.evaluate(
          sessionId,
          'chrome.runtime && chrome.runtime.getManifest && chrome.runtime.getManifest().name',
          { userGesture: false }
        )
        if (name === EXTENSION_NAME) {
          return { id: new URL(target.url).host, targetId: target.targetId, sessionId }
        }
      } catch {
        // Component/built-in worker; keep looking.
      }
    }
    await sleep(100)
  }
  throw new Error('The DonDownload service worker target did not appear')
}

async function ensureWorkerAttached(browser, extId) {
  const targets = await browser.connection.targets().catch(() => [])
  const target = targets.find(
    (item) => item.type === 'service_worker' && item.url === `chrome-extension://${extId}/background.js`
  )
  if (!target) return null
  try {
    return await browser.connection.attach(target.targetId)
  } catch {
    return null
  }
}

async function openExtensionPage(browser, extId, file, { waitMs = 10000 } = {}) {
  const { targetId } = await browser.connection.send('Target.createTarget', {
    url: `chrome-extension://${extId}/${file}`
  })
  const sessionId = await browser.connection.attach(targetId)
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    try {
      const ready = await browser.connection.evaluate(
        sessionId,
        'document.readyState === "complete" && typeof chrome !== "undefined" && !!chrome.permissions',
        { userGesture: false }
      )
      if (ready) return { targetId, sessionId }
    } catch {
      // still loading
    }
    await sleep(100)
  }
  throw new Error(`${file} did not become ready`)
}

async function createPage(browser, url) {
  const { targetId } = await browser.connection.send('Target.createTarget', { url })
  const sessionId = await browser.connection.attach(targetId)
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    try {
      const ready = await browser.connection.evaluate(sessionId, 'document.readyState', {
        userGesture: false
      })
      if (ready === 'complete') return { targetId, sessionId }
    } catch {
      // still loading
    }
    await sleep(100)
  }
  throw new Error(`page ${url} did not load`)
}

async function pageEvaluate(page, expression, options) {
  return page.browser.connection.evaluate(page.sessionId, expression, options)
}

// ---------------------------------------------------------------------------
// fixture server
// ---------------------------------------------------------------------------

function makeFileBin() {
  const size = 2 * 1024 * 1024
  const buffer = Buffer.allocUnsafe(size)
  let state = 0x12345678
  for (let index = 0; index < size; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    buffer[index] = state & 0xff
  }
  return buffer
}

function startFixtureServer({ clip, clip720 }) {
  const fileBin = makeFileBin()
  const log = []
  let hitRanges = 0

  const server = http.createServer((req, res) => {
    let parsed
    try {
      parsed = new URL(req.url, 'http://127.0.0.1')
    } catch {
      res.writeHead(400)
      res.end()
      return
    }
    log.push({
      method: req.method,
      path: parsed.pathname + parsed.search,
      range: req.headers.range || null,
      at: Date.now()
    })

    const sendBuffer = (buffer, contentType, extraHeaders = {}) => {
      const range = req.headers.range
      if (range) {
        const match = /^bytes=(\d+)-(\d*)$/.exec(range.trim())
        if (match) {
          hitRanges += 1
          const start = Number(match[1])
          const end = match[2] ? Number(match[2]) : buffer.length - 1
          if (start >= buffer.length || end < start) {
            res.writeHead(416, { 'content-range': `bytes */${buffer.length}` })
            res.end()
            return
          }
          res.writeHead(206, {
            'content-type': contentType,
            'accept-ranges': 'bytes',
            'content-range': `bytes ${start}-${end}/${buffer.length}`,
            'content-length': end - start + 1,
            ...extraHeaders
          })
          res.end(req.method === 'HEAD' ? undefined : buffer.subarray(start, end + 1))
          return
        }
      }
      res.writeHead(200, {
        'content-type': contentType,
        'accept-ranges': 'bytes',
        'content-length': buffer.length,
        ...extraHeaders
      })
      res.end(req.method === 'HEAD' ? undefined : buffer)
    }

    if (parsed.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(
        '<!doctype html><meta charset="utf-8"><title>fixture</title>' +
          '<body style="margin:0;background:#111">' +
          '<video id="p" src="/clip.mp4" width="640" height="360" muted autoplay loop playsinline></video>' +
          '</body>'
      )
      return
    }
    if (parsed.pathname === '/extensionless') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(
        '<!doctype html><meta charset="utf-8"><title>fixture-media</title>' +
          '<body style="margin:0;background:#111">' +
          '<video id="p" width="640" height="360" muted loop playsinline></video>' +
          '</body>'
      )
      return
    }
    if (parsed.pathname === '/clip.mp4') {
      sendBuffer(clip, 'video/mp4')
      return
    }
    if (parsed.pathname === '/clip-720.mp4') {
      sendBuffer(clip720, 'video/mp4')
      return
    }
    if (parsed.pathname === '/media') {
      sendBuffer(clip, 'video/mp4')
      return
    }
    if (parsed.pathname === '/file.bin') {
      sendBuffer(fileBin, 'application/octet-stream', {
        'content-disposition': 'attachment; filename="file.bin"',
        'cache-control': 'no-store'
      })
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        origin: `http://127.0.0.1:${port}`,
        fileBin,
        fileBinSha256: crypto.createHash('sha256').update(fileBin).digest('hex'),
        log,
        rangeHits: () => hitRanges,
        close: () => new Promise((done) => server.close(() => done()))
      })
    })
  })
}

async function generateClip(ffmpegPath, output, { width, height }) {
  await new Promise((resolve, reject) => {
    const proc = spawn(
      ffmpegPath,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        `testsrc2=size=${width}x${height}:rate=25:duration=2`,
        '-c:v',
        'libx264',
        '-profile:v',
        'baseline',
        '-pix_fmt',
        'yuv420p',
        '-crf',
        '32',
        '-an',
        '-movflags',
        '+faststart',
        output
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    )
    let stderr = ''
    proc.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    proc.on('error', reject)
    proc.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-1000)}`))
    })
  })
  const stat = fs.statSync(output)
  if (stat.size < 1000) throw new Error(`generated clip is too small: ${stat.size} bytes`)
  return stat.size
}

// ---------------------------------------------------------------------------
// extension page helpers
// ---------------------------------------------------------------------------

async function getAllPermissions(browser, sessionId) {
  return browser.connection.evaluate(
    sessionId,
    'new Promise((resolve) => chrome.permissions.getAll((value) => resolve(value)))',
    { userGesture: false }
  )
}

async function readStorage(browser, sessionId, area, keys) {
  return browser.connection.evaluate(
    sessionId,
    `new Promise((resolve) => chrome.storage.${area}.get(${JSON.stringify(keys)}, (value) => resolve(value)))`,
    { userGesture: false }
  )
}

async function tabIdForOrigin(browser, optionsSession, origin) {
  return browser.connection.evaluate(
    optionsSession,
    `new Promise((resolve) => chrome.tabs.query({}, (tabs) => {
      const match = tabs.find((tab) => typeof tab.url === 'string' && tab.url.startsWith(${JSON.stringify(origin + '/')}))
      resolve(match ? match.id : null)
    }))`,
    { userGesture: false }
  )
}

async function pointOptionsAt(browser, optionsSession, tabId, origin) {
  await browser.connection.evaluate(
    optionsSession,
    `new Promise((resolve) => chrome.storage.session.set({
      ${JSON.stringify(OPTIONS_TARGET_KEY)}: { tabId: ${tabId}, origin: ${JSON.stringify(origin)} }
    }, () => resolve(true)))`,
    { userGesture: false }
  )
  await browser.connection.send('Page.reload', {}, optionsSession)
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    try {
      const target = await browser.connection.evaluate(
        optionsSession,
        'document.getElementById("site-target") && document.getElementById("site-target").textContent',
        { userGesture: false }
      )
      if (target === origin) return true
    } catch {
      // reloading
    }
    await sleep(100)
  }
  return false
}

async function enableOverlayForTab(browser, optionsSession, origin, tabId) {
  const response = await browser.connection.evaluate(
    optionsSession,
    `new Promise((resolve) => chrome.runtime.sendMessage({
      type: 'dondownload:overlay-enable',
      origin: ${JSON.stringify(origin)},
      tabId: ${tabId}
    }, (value) => resolve({
      response: value,
      error: chrome.runtime.lastError && chrome.runtime.lastError.message
    })))`,
    { userGesture: true }
  )
  return response
}

async function queryCapturedSources(browser, optionsSession, tabId) {
  return browser.connection.evaluate(
    optionsSession,
    `new Promise((resolve) => chrome.tabs.sendMessage(${tabId}, { type: 'dondownload:capture-query' }, (value) => resolve({
      response: value,
      error: chrome.runtime.lastError && chrome.runtime.lastError.message
    })))`,
    { userGesture: false }
  )
}

async function waitForCapturedSources(browser, optionsSession, tabId, predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    try {
      last = await queryCapturedSources(browser, optionsSession, tabId)
      if (last && last.response && Array.isArray(last.response.sources) && predicate(last.response.sources)) {
        return last.response.sources
      }
    } catch {
      // the content script may still be starting
    }
    await sleep(250)
  }
  throw new Error(`captured sources did not satisfy predicate: ${JSON.stringify(last)}`)
}

async function waitForVideoPlaying(page, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    try {
      last = await pageEvaluate(
        page,
        `(() => {
          const v = document.getElementById('p')
          return v ? {
            readyState: v.readyState,
            paused: v.paused,
            ended: v.ended,
            error: v.error && (v.error.code + ':' + v.error.message),
            currentSrc: v.currentSrc,
            width: v.videoWidth,
            height: v.videoHeight
          } : null
        })()`,
        { userGesture: false }
      )
      if (last && last.readyState >= 2 && !last.paused && !last.error) return last
      if (last && last.readyState >= 2 && last.paused && !last.ended && !last.error) {
        // A backgrounded headless tab can have its play() deferred; nudge it.
        await pageEvaluate(page, "document.getElementById('p').play().catch(() => {})", {
          userGesture: true
        })
      }
    } catch {
      // still loading
    }
    await sleep(150)
  }
  throw new Error(`video did not play: ${JSON.stringify(last)}`)
}

async function waitForOverlayHost(page, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const state = await pageEvaluate(
        page,
        `(() => {
          const host = document.getElementById('dondownload-overlay-host')
          const shadow = host && host.shadowRoot
          const trigger = shadow && shadow.querySelector('.trigger')
          return {
            host: Boolean(host),
            shadow: Boolean(shadow),
            trigger: Boolean(trigger),
            triggerHidden: trigger ? trigger.hidden : null,
            hostConnected: host ? host.isConnected : false
          }
        })()`,
        { userGesture: false }
      )
      if (state.host && state.shadow && state.trigger) return state
    } catch {
      // still injecting
    }
    await sleep(150)
  }
  return { host: false, shadow: false, trigger: false }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dondownload-extension-e2e-'))
  const downloadsDir = path.join(tempRoot, 'downloads')
  const mediaDir = path.join(tempRoot, 'media')
  fs.mkdirSync(downloadsDir, { recursive: true })
  fs.mkdirSync(mediaDir, { recursive: true })

  let server = null
  let browserA = null
  let browserB = null

  const cleanup = async () => {
    try {
      if (browserA) await browserA.close()
    } catch {
      // ignore
    }
    try {
      if (browserB) await browserB.close()
    } catch {
      // ignore
    }
    try {
      if (server) await server.close()
    } catch {
      // ignore
    }
    if (!process.env.DONDOWNLOAD_E2E_KEEP) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
          break
        } catch {
          await sleep(300)
        }
      }
    } else {
      console.log(`kept temp dir: ${tempRoot}`)
    }
  }

  process.on('SIGINT', async () => {
    await cleanup()
    process.exit(130)
  })

  try {
    if (!fs.existsSync(CHROME)) {
      record('0', 'Chromium available', 'FAIL', `not found: ${CHROME}`)
      return
    }
    if (!fs.existsSync(FFMPEG)) {
      record('0', 'FFmpeg available', 'FAIL', `not found: ${FFMPEG}`)
      return
    }

    const clipPath = path.join(mediaDir, 'clip.mp4')
    const clip720Path = path.join(mediaDir, 'clip-720.mp4')
    const clipBytes = await generateClip(FFMPEG, clipPath, { width: 640, height: 360 })
    const clip720Bytes = await generateClip(FFMPEG, clip720Path, { width: 1280, height: 720 })
    const clip = fs.readFileSync(clipPath)
    const clip720 = fs.readFileSync(clip720Path)
    server = await startFixtureServer({ clip, clip720 })
    const { origin } = server
    const originPattern = `${origin}/*`
    record(
      '0',
      'Fixtures ready (local HTTP + generated MP4 + 2 MiB attachment)',
      'PASS',
      `origin=${origin}; clip.mp4=${clipBytes}B; clip-720.mp4=${clip720Bytes}B; file.bin=${server.fileBin.length}B sha256=${server.fileBinSha256}`
    )

    // ------------------------------------------------------------------
    // Phase A: the real, unmodified extension from ./extension
    // ------------------------------------------------------------------
    browserA = await launchChromium({
      userDataDir: path.join(tempRoot, 'profile-real'),
      extensionPath: EXTENSION_DIR,
      label: 'real'
    })
    const workerA = await findExtensionWorker(browserA)
    const optionsA = await openExtensionPage(browserA, workerA.id, 'options.html')
    await sleep(700)

    await scenario('1', 'Service worker starts; no uncaught worker/options errors', async () => {
      const version = await browserA.connection.evaluate(
        workerA.sessionId,
        'chrome.runtime.getManifest().version',
        { userGesture: false }
      )
      const workerErrors = describeErrors(browserA.connection, workerA.sessionId)
      const optionsErrors = describeErrors(browserA.connection, optionsA.sessionId)
      const optionsReady = await browserA.connection.evaluate(
        optionsA.sessionId,
        'document.readyState === "complete" && !!document.getElementById("automatic-handoff")',
        { userGesture: false }
      )
      const status = workerErrors.length === 0 && optionsErrors.length === 0 && version === '0.3.0' && optionsReady
      return {
        status: status ? 'PASS' : 'FAIL',
        evidence: `worker target present; manifest version=${version}; options ready=${optionsReady}; worker errors=${workerErrors.length}; options errors=${optionsErrors.length}` +
          (workerErrors.length ? `\n${workerErrors.join('\n')}` : '') +
          (optionsErrors.length ? `\n${optionsErrors.join('\n')}` : '')
      }
    })

    await scenario('6', 'options.html renders; shortcut setting present', async () => {
      const info = await browserA.connection.evaluate(
        optionsA.sessionId,
        `(() => ({
          title: document.title,
          heading: document.getElementById('shortcut-heading') ? document.getElementById('shortcut-heading').textContent : null,
          shortcutText: (document.body.innerText.match(/chrome:\\/\\/extensions\\/shortcuts/) || [null])[0],
          commands: chrome.runtime.getManifest().commands,
          optionsUi: Boolean(document.getElementById('automatic-handoff'))
        }))()`,
        { userGesture: false }
      )
      const errors = describeErrors(browserA.connection, optionsA.sessionId)
      const ok =
        info.title === 'DonDownload Capture settings' &&
        info.heading === 'Keyboard shortcut' &&
        info.shortcutText === 'chrome://extensions/shortcuts' &&
        info.commands &&
        info.commands['toggle-overlay'] &&
        errors.length === 0
      return {
        status: ok ? 'PASS' : 'FAIL',
        evidence: `title=${info.title}; heading=${info.heading}; shortcut=${info.shortcutText}; toggle-overlay command=${Boolean(info.commands && info.commands['toggle-overlay'])}; console errors=${errors.length}`
      }
    })

    await scenario('2a', 'Optional host permission through the real options-page gesture', async () => {
      const before = await getAllPermissions(browserA, optionsA.sessionId)
      const result = await browserA.connection.evaluate(
        optionsA.sessionId,
        `Promise.race([
          new Promise((resolve) => chrome.permissions.request({ origins: [${JSON.stringify(originPattern)}] }, (granted) => resolve({
            granted,
            error: chrome.runtime.lastError && chrome.runtime.lastError.message
          }))),
          new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 6000))
        ])`,
        { userGesture: true }
      )
      const after = await getAllPermissions(browserA, optionsA.sessionId)
      if (result && result.timeout === true) {
        return {
          status: 'NOT-RUNNABLE',
          evidence: `chrome.permissions.request never called back in 6 s (headless Chromium has no extension permission bubble), so nothing was granted. before=${JSON.stringify(before)}; after=${JSON.stringify(after)}; requested=${originPattern}`
        }
      }
      if (result && result.granted === true) {
        return {
          status: 'PASS',
          evidence: `granted=${originPattern}; getAll=${JSON.stringify(after)}`
        }
      }
      return {
        status: 'FAIL',
        evidence: `permission request returned ${JSON.stringify(result)}; getAll=${JSON.stringify(after)}`
      }
    })

    record(
      '2b-note',
      'Harness manifest for scenarios 2b-5',
      'INFO',
      'The temp extension copy declares only the fixture origin as a required host permission and downloads/webRequest as required API permissions. The extension source files are byte-identical.'
    )

    // ------------------------------------------------------------------
    // Phase B: same sources, harness manifest grants the exact fixture origin
    // ------------------------------------------------------------------
    const harnessDir = path.join(tempRoot, 'extension-harness')
    fs.cpSync(EXTENSION_DIR, harnessDir, { recursive: true })
    const harnessManifest = JSON.parse(fs.readFileSync(path.join(harnessDir, 'manifest.json'), 'utf8'))
    harnessManifest.permissions = [...new Set([...(harnessManifest.permissions || []), 'downloads', 'webRequest'])]
    harnessManifest.host_permissions = [originPattern]
    delete harnessManifest.optional_permissions
    delete harnessManifest.optional_host_permissions
    fs.writeFileSync(path.join(harnessDir, 'manifest.json'), `${JSON.stringify(harnessManifest, null, 2)}\n`)

    browserB = await launchChromium({
      userDataDir: path.join(tempRoot, 'profile-harness'),
      extensionPath: harnessDir,
      label: 'harness'
    })
    const workerB = await findExtensionWorker(browserB)
    const optionsB = await openExtensionPage(browserB, workerB.id, 'options.html')
    await sleep(700)

    let fixtureTab = null
    let fixturePage = null

    await scenario('2b', 'Exact-origin grant + options-page site flow enables and injects overlay', async () => {
      const permissions = await getAllPermissions(browserB, optionsB.sessionId)
      const origins = Array.isArray(permissions.origins) ? permissions.origins : []
      const apis = Array.isArray(permissions.permissions) ? permissions.permissions : []
      const originsExact = origins.length === 1 && origins[0] === originPattern
      const downloads = apis.includes('downloads')
      const webRequest = apis.includes('webRequest')

      const page = await createPage(browserB, `${origin}/`)
      page.browser = browserB
      fixturePage = page
      const tabsSnapshot = await browserB.connection.evaluate(
        optionsB.sessionId,
        'new Promise((resolve) => chrome.tabs.query({}, (tabs) => resolve(tabs.map((tab) => ({ id: tab.id, url: tab.url, active: tab.active })))))',
        { userGesture: false }
      )
      fixtureTab = await tabIdForOrigin(browserB, optionsB.sessionId, origin)
      const pointed = await pointOptionsAt(browserB, optionsB.sessionId, fixtureTab, origin)
      await browserB.connection.send('Target.activateTarget', { targetId: page.targetId })
      const deadline = Date.now() + 15000
      let siteState = ''
      let siteGranted = false
      while (Date.now() < deadline) {
        siteState = await browserB.connection.evaluate(
          optionsB.sessionId,
          'document.getElementById("site-state").textContent',
          { userGesture: false }
        ).catch(() => '')
        if (siteState === 'Overlay on') break
        await sleep(200)
      }
      const enableResponse = await enableOverlayForTab(browserB, optionsB.sessionId, origin, fixtureTab)
      const registrations = await browserB.connection.evaluate(
        optionsB.sessionId,
        'new Promise((resolve) => chrome.scripting.getRegisteredContentScripts((scripts) => resolve(scripts.map((script) => ({ id: script.id, matches: script.matches, js: script.js })))))',
        { userGesture: false }
      )
      const host = await waitForOverlayHost(fixturePage)
      const responseOk =
        enableResponse &&
        enableResponse.response &&
        enableResponse.response.ok === true &&
        enableResponse.response.granted === true &&
        enableResponse.response.registered === true &&
        enableResponse.response.injected === true
      siteGranted = siteState === 'Overlay on'
      const ok = originsExact && downloads && webRequest && pointed && (siteGranted || responseOk) && host.host && host.shadow && host.trigger
      return {
        status: ok ? 'PASS' : 'FAIL',
        evidence: `getAll origins=${JSON.stringify(origins)} (exact=${originsExact}); downloads API=${downloads}; webRequest API=${webRequest}; options target shown=${pointed}; site-state="${siteState}"; enable=${JSON.stringify(enableResponse.response || enableResponse)}; registrations=${JSON.stringify(registrations)}; overlay host/shadow/trigger=${host.host}/${host.shadow}/${host.trigger}; tabs=${JSON.stringify(tabsSnapshot)}`
      }
    })

    await scenario('3', 'MP4 playback captures a progressive source and injects the floating overlay', async () => {
      await browserB.connection.send('Target.activateTarget', { targetId: fixturePage.targetId })
      const video = await waitForVideoPlaying(fixturePage)
      const host = await waitForOverlayHost(fixturePage)
      const dom = await pageEvaluate(
        fixturePage,
        `(() => {
          const host = document.getElementById('dondownload-overlay-host')
          const shadow = host && host.shadowRoot
          const trigger = shadow && shadow.querySelector('.trigger')
          const panel = shadow && shadow.querySelector('.panel')
          return {
            host: Boolean(host),
            shadow: Boolean(shadow),
            trigger: Boolean(trigger),
            triggerHidden: trigger ? trigger.hidden : null,
            triggerText: trigger ? trigger.textContent : null,
            panel: Boolean(panel),
            ariaExpanded: trigger ? trigger.getAttribute('aria-expanded') : null
          }
        })()`,
        { userGesture: false }
      )
      // Open the panel through the real in-page click path.
      await pageEvaluate(
        fixturePage,
        `(() => {
          const host = document.getElementById('dondownload-overlay-host')
          const trigger = host && host.shadowRoot && host.shadowRoot.querySelector('.trigger')
          if (trigger) trigger.click()
          return true
        })()`,
        { userGesture: true }
      )
      await sleep(500)
      const panelText = await pageEvaluate(
        fixturePage,
        `(() => {
          const host = document.getElementById('dondownload-overlay-host')
          const shadow = host && host.shadowRoot
          const panel = shadow && shadow.querySelector('.panel')
          const rows = shadow ? Array.from(shadow.querySelectorAll('.source-list .source')).map((row) => row.innerText) : []
          return { panelHidden: panel ? panel.hidden : null, rows }
        })()`,
        { userGesture: false }
      )
      const sources = await waitForCapturedSources(
        browserB,
        optionsB.sessionId,
        fixtureTab,
        (list) => list.some((item) => typeof item.url === 'string' && item.url.endsWith('/clip.mp4'))
      )
      const primary = sources.find((item) => item.url.endsWith('/clip.mp4'))
      const ok =
        video.readyState >= 2 &&
        !video.paused &&
        video.height === 360 &&
        host.host &&
        host.shadow &&
        host.trigger &&
        dom.triggerHidden === false &&
        primary &&
        primary.current === true &&
        primary.container === 'mp4' &&
        primary.qualityLabel === '360p'
      return {
        status: ok ? 'PASS' : 'FAIL',
        evidence: `video=${JSON.stringify(video)}; DOM=${JSON.stringify(dom)}; panel=${JSON.stringify(panelText)}; sources=${JSON.stringify(sources)}; http range responses=${server.rangeHits()}`
      }
    })

    await scenario('3b', 'Extensionless /media?id=1 captured through exact webRequest evidence', async () => {
      // Enable optional network observation through the real options checkbox.
      const clickResult = await browserB.connection.evaluate(
        optionsB.sessionId,
        `(() => {
          const checkbox = document.getElementById('network-observation')
          const before = { disabled: checkbox.disabled, checked: checkbox.checked }
          if (checkbox.disabled) return { before, clicked: false }
          checkbox.click()
          return { before, clicked: true }
        })()`,
        { userGesture: true }
      )
      const settingsDeadline = Date.now() + 5000
      let networkSetting = null
      while (Date.now() < settingsDeadline) {
        const stored = await readStorage(browserB, optionsB.sessionId, 'local', CAPTURE_SETTINGS_KEY)
        networkSetting = stored && stored[CAPTURE_SETTINGS_KEY]
        if (networkSetting && networkSetting.networkObservation === true) break
        await sleep(150)
      }

      const mediaPage = await createPage(browserB, `${origin}/extensionless`)
      mediaPage.browser = browserB
      const realMediaTab = await browserB.connection.evaluate(
        optionsB.sessionId,
        `new Promise((resolve) => chrome.tabs.query({}, (tabs) => {
          const exact = tabs.filter((tab) => typeof tab.url === 'string' && tab.url.startsWith(${JSON.stringify(origin + '/extensionless')}))
          resolve(exact.length > 0 ? exact[exact.length - 1].id : null)
        }))`,
        { userGesture: false }
      )
      const tabForMedia = realMediaTab
      if (tabForMedia === null) throw new Error('the extensionless fixture tab was not visible to the extension')
      await browserB.connection.send('Target.activateTarget', { targetId: mediaPage.targetId })
      await enableOverlayForTab(browserB, optionsB.sessionId, origin, tabForMedia)
      await waitForOverlayHost(mediaPage)
      const injected = await pageEvaluate(
        mediaPage,
        `(() => {
          const host = document.getElementById('dondownload-overlay-host')
          const v = document.getElementById('p')
          v.src = '/media?id=1'
          v.load()
          v.play().catch(() => {})
          return { host: Boolean(host), shadow: Boolean(host && host.shadowRoot) }
        })()`,
        { userGesture: true }
      )
      await waitForVideoPlaying(mediaPage)
      let sources = []
      let lastError = null
      const deadline = Date.now() + 15000
      while (Date.now() < deadline) {
        const value = await queryCapturedSources(browserB, optionsB.sessionId, tabForMedia).catch((error) => {
          lastError = error.message
          return null
        })
        if (value && value.response && Array.isArray(value.response.sources)) {
          sources = value.response.sources
          if (sources.some((item) => typeof item.url === 'string' && item.url.endsWith('/media?id=1'))) break
        }
        await sleep(250)
      }
      const captured = sources.find((item) => item.url.endsWith('/media?id=1'))
      const mediaHits = server.log.filter((entry) => entry.path === '/media?id=1')
      const ok =
        clickResult.clicked &&
        networkSetting &&
        networkSetting.networkObservation === true &&
        injected.host &&
        injected.shadow &&
        captured &&
        captured.container === 'mp4' &&
        captured.qualityLabel === '360p' &&
        mediaHits.some((entry) => typeof entry.range === 'string' && entry.range.startsWith('bytes=0-'))
      return {
        status: ok ? 'PASS' : 'FAIL',
        evidence: `network checkbox=${JSON.stringify(clickResult)}; setting=${JSON.stringify(networkSetting && { networkObservation: networkSetting.networkObservation })}; injected=${JSON.stringify(injected)}; media requests=${JSON.stringify(mediaHits)}; captured=${JSON.stringify(captured)}; sources=${JSON.stringify(sources)}${lastError ? `; last error=${lastError}` : ''}`
      }
    })

    await scenario('4', 'Quality accumulation keeps both sources for the same player', async () => {
      await browserB.connection.send('Target.activateTarget', { targetId: fixturePage.targetId })
      await pageEvaluate(
        fixturePage,
        `(() => {
          const v = document.getElementById('p')
          v.muted = true
          v.loop = true
          v.src = '/clip-720.mp4'
          v.load()
          v.play().catch(() => {})
          return true
        })()`,
        { userGesture: true }
      )
      await waitForVideoPlaying(fixturePage)
      const sources = await waitForCapturedSources(
        browserB,
        optionsB.sessionId,
        fixtureTab,
        (list) =>
          list.some((item) => item.url.endsWith('/clip.mp4')) &&
          list.some((item) => item.url.endsWith('/clip-720.mp4'))
      )
      const first = sources.find((item) => item.url.endsWith('/clip.mp4'))
      const second = sources.find((item) => item.url.endsWith('/clip-720.mp4'))
      await sleep(500)
      const after = await queryCapturedSources(browserB, optionsB.sessionId, fixtureTab)
      const rows = await pageEvaluate(
        fixturePage,
        `(() => {
          const host = document.getElementById('dondownload-overlay-host')
          const shadow = host && host.shadowRoot
          return shadow ? Array.from(shadow.querySelectorAll('.source-list .source')).map((row) => row.innerText) : []
        })()`,
        { userGesture: false }
      )
      const ok =
        first &&
        second &&
        second.current === true &&
        first.current === false &&
        first.qualityLabel === '360p' &&
        second.qualityLabel === '720p' &&
        after.response.sources.length === 2 &&
        rows.some((text) => text.includes('clip.mp4')) &&
        rows.some((text) => text.includes('clip-720.mp4'))
      return {
        status: ok ? 'PASS' : 'FAIL',
        evidence: `sources=${JSON.stringify(after.response.sources)}; panel rows=${JSON.stringify(rows)}`
      }
    })

    await scenario('5', 'No native host: hand-off leaves the browser download running and bytes match', async () => {
      // Enable automatic hand-off through the real options checkbox.
      const handoffClick = await browserB.connection.evaluate(
        optionsB.sessionId,
        `(() => {
          const checkbox = document.getElementById('automatic-handoff')
          const before = { disabled: checkbox.disabled, checked: checkbox.checked }
          if (checkbox.disabled) return { before, clicked: false }
          checkbox.click()
          return { before, clicked: true }
        })()`,
        { userGesture: true }
      )
      const settingsDeadline = Date.now() + 5000
      let handoffSetting = null
      while (Date.now() < settingsDeadline) {
        const stored = await readStorage(browserB, optionsB.sessionId, 'local', CAPTURE_SETTINGS_KEY)
        handoffSetting = stored && stored[CAPTURE_SETTINGS_KEY]
        if (handoffSetting && handoffSetting.automaticFileHandoff === true) break
        await sleep(150)
      }

      const nativeProbe = await browserB.connection.evaluate(
        optionsB.sessionId,
        `new Promise((resolve) => chrome.runtime.sendNativeMessage('com.dondownload.bridge', { type: 'queue-download', url: 'http://127.0.0.1/x.bin' }, () => {
          resolve({ error: chrome.runtime.lastError && chrome.runtime.lastError.message })
        }))`,
        { userGesture: false }
      )

      await browserB.connection.send('Browser.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: downloadsDir,
        eventsEnabled: true
      })
      const downloadPage = await createPage(browserB, `${origin}/file.bin`)
      downloadPage.browser = browserB

      const downloadDeadline = Date.now() + 30000
      let items = []
      let item = null
      let filePath = null
      let fileHash = null
      let fileSize = null
      while (Date.now() < downloadDeadline) {
        items = await browserB.connection.evaluate(
          optionsB.sessionId,
          'new Promise((resolve) => chrome.downloads.search({}, (value) => resolve(value)))',
          { userGesture: false }
        )
        item = items.find((candidate) => typeof candidate.filename === 'string' && candidate.filename.toLowerCase().endsWith('file.bin'))
        if (item && item.state === 'complete' && item.filename && fs.existsSync(item.filename)) {
          filePath = item.filename
          const bytes = fs.readFileSync(filePath)
          fileSize = bytes.length
          fileHash = crypto.createHash('sha256').update(bytes).digest('hex')
          break
        }
        await sleep(250)
      }

      const sessionState = await readStorage(browserB, optionsB.sessionId, 'session', HANDOFF_STATE_KEY)
      const processed = sessionState && sessionState[HANDOFF_STATE_KEY] && sessionState[HANDOFF_STATE_KEY].processed
      const pending = sessionState && sessionState[HANDOFF_STATE_KEY] && sessionState[HANDOFF_STATE_KEY].pending
      const hashOk = fileHash === server.fileBinSha256
      const completed = item && item.state === 'complete'
      const attempted = Array.isArray(processed) && item && processed.includes(item.id)
      const ok =
        handoffClick.clicked &&
        handoffSetting &&
        handoffSetting.automaticFileHandoff === true &&
        nativeProbe &&
        /not found|forbidden|not installed|denied/i.test(nativeProbe.error || '') &&
        completed &&
        hashOk &&
        attempted &&
        Array.isArray(pending) &&
        pending.length === 0
      return {
        status: ok ? 'PASS' : 'FAIL',
        evidence: `options click=${JSON.stringify(handoffClick)}; setting=${JSON.stringify(handoffSetting && { automaticFileHandoff: handoffSetting.automaticFileHandoff })}; native probe=${JSON.stringify(nativeProbe)}; download=${JSON.stringify(item && { id: item.id, state: item.state, totalBytes: item.totalBytes, bytesReceived: item.bytesReceived, error: item.error })}; file=${filePath} (${fileSize}B); sha256=${fileHash} expected=${server.fileBinSha256} match=${hashOk}; handoff state processed=${JSON.stringify(processed)} pending=${JSON.stringify(pending)}`
      }
    })

    await scenario('1b', 'Harness worker stayed free of uncaught errors during the full run', async () => {
      const workerSession = await ensureWorkerAttached(browserB, workerB.id)
      const errors = workerSession ? describeErrors(browserB.connection, workerSession) : ['worker target missing after run']
      const optionsErrors = describeErrors(browserB.connection, optionsB.sessionId)
      const ok = errors.length === 0 && optionsErrors.length === 0
      return {
        status: ok ? 'PASS' : 'FAIL',
        evidence: `worker errors=${errors.length}; options errors=${optionsErrors.length}` +
          (errors.length ? `\n${errors.join('\n')}` : '') +
          (optionsErrors.length ? `\n${optionsErrors.join('\n')}` : '')
      }
    })
  } finally {
    await cleanup()
  }
}

// ---------------------------------------------------------------------------
// table + exit code
// ---------------------------------------------------------------------------

function printTable() {
  const rows = results.map((item) => ({
    Scenario: item.id,
    Result: item.status,
    Check: item.title,
    Evidence: item.evidence
  }))
  const widths = {
    Scenario: Math.max(8, ...rows.map((row) => row.Scenario.length)),
    Result: Math.max(6, ...rows.map((row) => row.Result.length)),
    Check: Math.min(48, Math.max(6, ...rows.map((row) => row.Check.length)))
  }
  const pad = (value, width) => value + ' '.repeat(Math.max(0, width - value.length))
  console.log('')
  console.log(`${pad('Scenario', widths.Scenario)}  ${pad('Result', widths.Result)}  Check`)
  console.log(`${'-'.repeat(widths.Scenario)}  ${'-'.repeat(widths.Result)}  ${'-'.repeat(widths.Check)}`)
  for (const row of rows) {
    console.log(`${pad(row.Scenario, widths.Scenario)}  ${pad(row.Result, widths.Result)}  ${row.Check}`)
  }
  console.log('')
  const failures = results.filter((item) => item.status === 'FAIL')
  const blocked = results.filter((item) => item.status === 'NOT-RUNNABLE')
  console.log(
    `Summary: ${results.filter((item) => item.status === 'PASS').length} PASS, ${failures.length} FAIL, ${blocked.length} NOT-RUNNABLE`
  )
  return failures.length
}

try {
  await main()
} catch (error) {
  record('FATAL', 'Harness failure', 'FAIL', error && error.stack ? error.stack : String(error))
}
const failureCount = printTable()
process.exit(failureCount > 0 ? 1 : 0)
