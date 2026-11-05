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

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import dns from 'node:dns/promises'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(SCRIPT_DIR, '..')
const EXTENSION_DIR = path.join(ROOT, 'extension')
const FFMPEG = path.join(ROOT, 'build', 'vendor', 'ffmpeg', 'ffmpeg.exe')
const ARIA2 = path.join(ROOT, 'build', 'vendor', 'aria2', 'aria2c.exe')
const CHROME =
  process.env.DONDOWNLOAD_CHROME_PATH ||
  path.join(process.env.LOCALAPPDATA || '', 'ms-playwright', 'chromium-1248', 'chrome-win64', 'chrome.exe')
const NATIVE_MODE = process.argv.includes('--native')
const NATIVE_HOST_NAME = 'com.dondownload.bridge'
// Chromium-branded builds read this exact per-user key. Only this key is
// written, and only after proving it did not exist.
const CHROMIUM_REG_KEY = `HKCU\\Software\\Chromium\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`
// The user's real Helium registration. It is read once for an identity check
// and is never written, modified or deleted.
const HELIUM_REG_KEY = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`

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

async function launchChromium({ userDataDir, extensionPath, label, extraArgs = [], env = {} }) {
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
  const proc = spawn(CHROME, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env }
  })
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

function makeDeterministicBytes(size, seed) {
  const buffer = Buffer.allocUnsafe(size)
  let state = seed
  for (let index = 0; index < size; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    buffer[index] = state & 0xff
  }
  return buffer
}

function makeFileBin() {
  return makeDeterministicBytes(2 * 1024 * 1024, 0x12345678)
}

function makeSecureBin() {
  return makeDeterministicBytes(512 * 1024, 0x9abcdef0)
}

function localIpv4Address() {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address
    }
  }
  return null
}

async function resolveNativeFixtureHost() {
  const address = localIpv4Address()
  if (address === null) return null
  // A single-label machine name resolves through Node and Chromium but not
  // through aria2's c-ares resolver. nip.io maps a dashed IPv4 name back to the
  // same address for every resolver, so the app's own aria2 can fetch the
  // fixture while all policy checks still run.
  const hostname = `${address.replace(/\./g, '-')}.nip.io`
  try {
    const resolved = await dns.lookup(hostname, { all: true, family: 4 })
    if (!resolved.some((entry) => entry.address === address)) return null
  } catch {
    return null
  }
  return { hostname, address }
}

async function startFixtureServer({ clip, clip720 }) {
  const fileBin = makeFileBin()
  const secureBin = makeSecureBin()
  const log = []
  let hitRanges = 0
  const nativeHost = NATIVE_MODE ? await resolveNativeFixtureHost() : null

  const handleRequest = (req, res) => {
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
      cookie: req.headers.cookie || null,
      userAgent: req.headers['user-agent'] || null,
      at: Date.now()
    })

    const sendBuffer = (buffer, contentType, extraHeaders = {}, options = {}) => {
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
      if (req.method === 'HEAD') {
        res.end()
        return
      }
      if (options.slow !== true) {
        res.end(buffer)
        return
      }
      // A slow full response keeps the browser download in progress long
      // enough to observe the durable receipt and the subsequent cancellation.
      let offset = 0
      const step = 64 * 1024
      let timer = null
      const stop = () => {
        if (timer !== null) {
          clearInterval(timer)
          timer = null
        }
      }
      res.on('close', stop)
      timer = setInterval(() => {
        if (res.destroyed || res.writableEnded) {
          stop()
          return
        }
        const end = Math.min(offset + step, buffer.length)
        res.write(buffer.subarray(offset, end))
        offset = end
        if (offset >= buffer.length) {
          stop()
          res.end()
        }
      }, 60)
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
    if (parsed.pathname === '/handoff.bin') {
      sendBuffer(
        fileBin,
        'application/octet-stream',
        {
          'content-disposition': 'attachment; filename="handoff.bin"',
          'cache-control': 'no-store'
        },
        { slow: true }
      )
      return
    }
    if (parsed.pathname === '/secure.bin') {
      const cookie = typeof req.headers.cookie === 'string' ? req.headers.cookie : ''
      if (!/(?:^|;\s*)auth=1(?:;|$)/.test(cookie)) {
        res.writeHead(401, {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
          'content-length': '23'
        })
        res.end('authentication required')
        return
      }
      sendBuffer(secureBin, 'application/octet-stream', {
        'content-disposition': 'attachment; filename="secure.bin"',
        'cache-control': 'no-store'
      })
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  }

  const server = http.createServer(handleRequest)
  const nativeServer = nativeHost === null ? null : http.createServer(handleRequest)

  const listen = (instance, addressValue) =>
    new Promise((resolve, reject) => {
      instance.once('error', reject)
      instance.listen(0, addressValue, () => {
        instance.off('error', reject)
        resolve(instance.address().port)
      })
    })

  const port = await listen(server, '127.0.0.1')
  const nativePort =
    nativeServer === null
      ? null
      : await listen(nativeServer, nativeHost.address)

  return {
    origin: `http://127.0.0.1:${port}`,
    nativeOrigin:
      nativeServer === null
        ? null
        : `http://${nativeHost.hostname}:${nativePort}`,
    nativeHost,
    fileBin,
    fileBinSha256: crypto.createHash('sha256').update(fileBin).digest('hex'),
    secureBinBytes: secureBin.length,
    secureBinSha256: crypto.createHash('sha256').update(secureBin).digest('hex'),
    log,
    rangeHits: () => hitRanges,
    close: async () => {
      await Promise.all([
        new Promise((done) => server.close(() => done())),
        nativeServer === null
          ? Promise.resolve()
          : new Promise((done) => nativeServer.close(() => done()))
      ])
    }
  }
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
// native messaging / isolated app helpers (--native only)
// ---------------------------------------------------------------------------

const nativeRun = {
  attempted: false,
  chromiumKeyCreated: false,
  heliumBefore: null,
  heliumAfter: null,
  cleanupRecorded: false,
  app: null,
  db: null,
  hostExe: null,
  hostBuilt: false,
  manifestPath: null,
  userDataDir: null,
  downloadDir: null,
  page: null,
  appStderr: () => ''
}

function queryRegistryDefault(key) {
  const result = spawnSync('reg', ['query', key, '/ve'], {
    encoding: 'utf8',
    windowsHide: true
  })
  const output = `${result.stdout || ''}${result.stderr || ''}`
    .replace(/\r/g, '')
    .trim()
  return { exists: result.status === 0, status: result.status, output }
}

/**
 * A previous run that was hard-killed (no chance to run its finally/exit
 * handlers) can leave the temp Chromium registration behind. Remove it only
 * when it provably belongs to this harness: its value must point into an
 * os.tmpdir() `dondownload-extension-e2e-*` directory that no longer exists.
 * Anything else is left untouched and the native scenarios abort.
 */
function removeStaleHarnessRegistration() {
  const current = queryRegistryDefault(CHROMIUM_REG_KEY)
  if (!current.exists) return false
  const match = current.output.match(/REG_SZ\s+(.+\.json)\s*$/m)
  if (!match) return false
  const manifestPath = path.resolve(match[1].trim())
  const tmpRoot = path.resolve(os.tmpdir()) + path.sep
  const relative = manifestPath.startsWith(tmpRoot)
    ? manifestPath.slice(tmpRoot.length)
    : null
  if (relative === null || !/^dondownload-extension-e2e-[^\\/]+[\\/]/.test(relative)) {
    return false
  }
  const runDir = path.join(tmpRoot, relative.split(/[\\/]/)[0])
  if (fs.existsSync(runDir)) return false
  const removed = deleteChromiumRegistryKey()
  if (removed) {
    console.log(`[native] removed stale harness registration from a killed run: ${manifestPath}`)
  }
  return removed
}

function deleteChromiumRegistryKey() {
  spawnSync('reg', ['delete', CHROMIUM_REG_KEY, '/f'], {
    encoding: 'utf8',
    windowsHide: true
  })
  return !queryRegistryDefault(CHROMIUM_REG_KEY).exists
}

function finalizeNativeCleanup() {
  if (!nativeRun.attempted || nativeRun.cleanupRecorded) return
  nativeRun.cleanupRecorded = true

  const created = nativeRun.chromiumKeyCreated
  let removed = true
  if (created) {
    removed = deleteChromiumRegistryKey()
    if (removed) nativeRun.chromiumKeyCreated = false
    console.log(
      `[native] registry cleanup: ${removed ? 'removed' : 'NOT REMOVED'} ${CHROMIUM_REG_KEY}`
    )
  } else {
    console.log('[native] registry cleanup: no temporary Chromium key was written')
  }

  const keyGone = !queryRegistryDefault(CHROMIUM_REG_KEY).exists
  const helium = queryRegistryDefault(HELIUM_REG_KEY)
  nativeRun.heliumAfter = helium.exists ? helium.output : '<absent>'
  const heliumSame = nativeRun.heliumAfter === nativeRun.heliumBefore
  const ok = removed && keyGone && heliumSame
  record(
    'N5',
    'Temporary Chromium registration removed; Helium key byte-identical before/after',
    ok ? 'PASS' : 'FAIL',
    `chromiumKeyCreated=${created}; removed=${removed}; keyGone=${keyGone}; heliumBefore=${JSON.stringify(nativeRun.heliumBefore)}; heliumAfter=${JSON.stringify(nativeRun.heliumAfter)}; heliumSame=${heliumSame}; key=${CHROMIUM_REG_KEY}`
  )
}

// A last-resort synchronous cleanup for Ctrl+C or an abrupt exit. The normal
// path also verifies and records the result in finalizeNativeCleanup().
process.on('exit', () => {
  if (!nativeRun.chromiumKeyCreated) return
  try {
    execFileSync('reg', ['delete', CHROMIUM_REG_KEY, '/f'], {
      stdio: 'ignore',
      windowsHide: true
    })
    console.log(`[native] registry cleanup on exit: removed ${CHROMIUM_REG_KEY}`)
  } catch {
    console.error(`[native] registry cleanup on exit FAILED: ${CHROMIUM_REG_KEY}`)
  } finally {
    nativeRun.chromiumKeyCreated = false
  }
})

function resolveNativeHost(tempRoot) {
  const source = path.join(ROOT, 'native', 'NativeHost.cs')
  const checkedIn = path.join(ROOT, 'native', 'dondownload-native-host.exe')
  const stale =
    !fs.existsSync(checkedIn) ||
    !fs.existsSync(source) ||
    fs.statSync(checkedIn).mtimeMs < fs.statSync(source).mtimeMs
  if (!stale) return { exe: checkedIn, built: false }

  const output = path.join(tempRoot, 'native-host', 'dondownload-native-host.exe')
  execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(ROOT, 'scripts', 'build-native-host.ps1'),
      '-OutputPath',
      output
    ],
    { encoding: 'utf8', windowsHide: true, stdio: 'pipe' }
  )
  if (!fs.existsSync(output)) {
    throw new Error('the temporary native host build did not produce an executable')
  }
  return { exe: output, built: true }
}

function writeNativeManifest(manifestPath, hostExe, extensionId) {
  const manifest = {
    name: NATIVE_HOST_NAME,
    description: 'DonDownload native messaging bridge (isolated E2E fixture)',
    path: hostExe,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`]
  }
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true })
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return manifest
}

function registerChromiumHost(manifestPath) {
  const before = queryRegistryDefault(CHROMIUM_REG_KEY)
  if (before.exists) {
    throw new Error(
      `${CHROMIUM_REG_KEY} already exists; refusing to overwrite it. Native scenarios aborted.`
    )
  }
  const result = spawnSync(
    'reg',
    [
      'add',
      CHROMIUM_REG_KEY,
      '/ve',
      '/t',
      'REG_SZ',
      '/d',
      manifestPath,
      '/f'
    ],
    { encoding: 'utf8', windowsHide: true }
  )
  if (result.status !== 0) {
    throw new Error(
      `reg add failed for ${CHROMIUM_REG_KEY}: ${`${result.stdout || ''}${result.stderr || ''}`.trim()}`
    )
  }
  const after = queryRegistryDefault(CHROMIUM_REG_KEY)
  if (!after.exists || !after.output.includes(manifestPath)) {
    throw new Error(`registration verification failed: ${after.output}`)
  }
  nativeRun.chromiumKeyCreated = true
  return after
}

function resolveElectronExecutable(tempRoot) {
  const installed = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
  if (fs.existsSync(installed)) return installed

  const packagePath = path.join(ROOT, 'node_modules', 'electron', 'package.json')
  if (!fs.existsSync(packagePath)) {
    throw new Error('node_modules/electron is not installed')
  }
  const { version } = JSON.parse(fs.readFileSync(packagePath, 'utf8'))
  const cacheRoot = path.join(process.env.LOCALAPPDATA || '', 'electron', 'Cache')
  const archiveName = `electron-v${version}-win32-x64.zip`
  const candidates = []
  const walk = (directory) => {
    let entries = []
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(target)
      else if (entry.name === archiveName) candidates.push(target)
    }
  }
  walk(cacheRoot)
  if (candidates.length === 0) {
    throw new Error(
      `Electron ${version} is not installed and ${archiveName} is not in ${cacheRoot}`
    )
  }
  const target = path.join(tempRoot, 'electron-dist')
  const executable = path.join(target, 'electron.exe')
  if (!fs.existsSync(executable)) {
    fs.mkdirSync(target, { recursive: true })
    // Extract the already-cached archive; nothing is downloaded or installed.
    execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Expand-Archive -LiteralPath ${JSON.stringify(candidates[0])} -DestinationPath ${JSON.stringify(target)} -Force`
      ],
      { stdio: 'pipe', windowsHide: true }
    )
  }
  if (!fs.existsSync(executable)) {
    throw new Error(`the cached Electron archive did not contain ${executable}`)
  }
  return executable
}

async function startIsolatedApp({
  userDataDir,
  statePath,
  tempRoot,
  fixtureHost,
  fixtureAddress
}) {
  const electronExe = resolveElectronExecutable(tempRoot)
  if (!fs.existsSync(ARIA2)) {
    throw new Error(`aria2 binary not found: ${ARIA2}`)
  }
  fs.mkdirSync(userDataDir, { recursive: true })
  let stderr = ''
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  env.DONDOWNLOAD_SMOKE_TEST = '1'
  env.DONDOWNLOAD_INTERACTIVE_SMOKE = '1'
  env.DONDOWNLOAD_INTERACTIVE_BRIDGE = '1'
  env.DONDOWNLOAD_SMOKE_FIXTURE_HOST = fixtureHost
  env.DONDOWNLOAD_SMOKE_FIXTURE_ADDRESS = fixtureAddress
  // A globally routable placeholder keeps the production public-target check
  // in force; the injected preflight pins the real connection to the fixture.
  env.DONDOWNLOAD_SMOKE_FIXTURE_PUBLIC_ADDRESS = '93.184.216.34'
  env.DONDOWNLOAD_ARIA2_PATH = ARIA2

  const proc = spawn(
    electronExe,
    [ROOT, '--smoke-test', `--user-data-dir=${userDataDir}`, '--disable-gpu'],
    {
      cwd: ROOT,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )
  proc.stdout.on('data', (chunk) => {
    stderr += String(chunk)
  })
  proc.stderr.on('data', (chunk) => {
    stderr += String(chunk)
    if (stderr.length > 200_000) stderr = stderr.slice(-200_000)
  })

  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(
        `the isolated app exited early (${proc.exitCode}): ${stderr.slice(-4000)}`
      )
    }
    if (fs.existsSync(statePath) && /INTERACTIVE_READY/.test(stderr)) {
      return { proc, stderr: () => stderr }
    }
    await sleep(150)
  }
  killTree(proc.pid)
  throw new Error(`the isolated app did not become ready: ${stderr.slice(-4000)}`)
}

async function openDownloadsDatabase(dbPath, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    if (fs.existsSync(dbPath)) {
      let db = null
      try {
        db = new DatabaseSync(dbPath, { readOnly: true })
        db.exec('PRAGMA busy_timeout = 2000')
        db.prepare('SELECT count(*) AS count FROM downloads').get()
        return db
      } catch (error) {
        lastError = error
        try {
          db?.close()
        } catch {
          // ignore
        }
      }
    }
    await sleep(100)
  }
  throw new Error(
    `the isolated app database did not become readable: ${lastError instanceof Error ? lastError.message : String(lastError)}`
  )
}

function readDownloadRows(db) {
  try {
    return db
      .prepare(
        'SELECT id, url, filename, status, file_path, dir, total_bytes, completed_bytes, created_at, updated_at FROM downloads ORDER BY created_at'
      )
      .all()
  } catch {
    return []
  }
}

async function waitForValue(read, predicate, timeoutMs, label, intervalMs = 25) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    try {
      last = await read()
      if (predicate(last)) return last
    } catch (error) {
      last = { error: error instanceof Error ? error.message : String(error) }
    }
    await sleep(intervalMs)
  }
  throw new Error(`${label} timed out; last=${JSON.stringify(last)}`)
}

async function searchDownloads(browser, optionsSession) {
  return browser.connection.evaluate(
    optionsSession,
    'new Promise((resolve) => chrome.downloads.search({}, (items) => resolve(items || [])))',
    { userGesture: false }
  )
}

async function ensureHandoffEnabled(browser, optionsSession) {
  const stored = await readStorage(browser, optionsSession, 'local', CAPTURE_SETTINGS_KEY)
  let setting = stored && stored[CAPTURE_SETTINGS_KEY]
  if (setting && setting.automaticFileHandoff === true) return setting
  await browser.connection.evaluate(
    optionsSession,
    `(() => {
      const checkbox = document.getElementById('automatic-handoff')
      if (checkbox && !checkbox.checked) checkbox.click()
      return Boolean(checkbox)
    })()`,
    { userGesture: true }
  )
  return waitForValue(
    () => readStorage(browser, optionsSession, 'local', CAPTURE_SETTINGS_KEY),
    (value) => value && value[CAPTURE_SETTINGS_KEY] && value[CAPTURE_SETTINGS_KEY].automaticFileHandoff === true,
    5000,
    'automaticFileHandoff setting'
  ).then((value) => value[CAPTURE_SETTINGS_KEY])
}

async function installDownloadEventLog(browser, optionsSession) {
  await browser.connection.evaluate(
    optionsSession,
    `(() => {
      globalThis.__ddDownloadEvents = []
      if (!globalThis.__ddDownloadListener) {
        globalThis.__ddDownloadListener = (delta) => {
          globalThis.__ddDownloadEvents.push({
            id: delta.id,
            state: delta.state ? delta.state.current : null,
            error: delta.error ? delta.error.current : null,
            at: Date.now()
          })
        }
        chrome.downloads.onChanged.addListener(globalThis.__ddDownloadListener)
      }
      return true
    })()`,
    { userGesture: false }
  )
}

async function readDownloadEvents(browser, optionsSession) {
  return browser.connection.evaluate(
    optionsSession,
    'globalThis.__ddDownloadEvents || []',
    { userGesture: false }
  )
}

function hashFile(filePath) {
  const bytes = fs.readFileSync(filePath)
  return {
    bytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex')
  }
}

async function waitForCompletedAppDownload(db, url, timeoutMs = 60_000) {
  const row = await waitForValue(
    () => readDownloadRows(db).find((entry) => entry.url === url && entry.status === 'complete') || null,
    (match) => match !== null,
    timeoutMs,
    `app download completion for ${url}`,
    50
  )
  const filePath = row.file_path || path.join(row.dir, row.filename)
  await waitForValue(
    () => fs.existsSync(filePath),
    (exists) => exists === true,
    10_000,
    `downloaded file ${filePath}`
  )
  return { row, filePath, hash: hashFile(filePath) }
}

function filesInDirectory(directory) {
  try {
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
  } catch {
    return []
  }
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
      if (nativeRun.db) {
        nativeRun.db.close()
        nativeRun.db = null
      }
    } catch {
      // ignore
    }
    try {
      if (nativeRun.app) {
        killTree(nativeRun.app.proc.pid)
        nativeRun.app = null
        await sleep(500)
      }
    } catch {
      // ignore
    }
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
    try {
      finalizeNativeCleanup()
    } catch (error) {
      console.error(
        `[native] registry cleanup verification failed: ${error instanceof Error ? error.message : String(error)}`
      )
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
    const { origin, nativeOrigin } = server
    const originPattern = `${origin}/*`
    const nativeOriginPattern =
      nativeOrigin === null ? null : `${nativeOrigin}/*`
    record(
      '0',
      'Fixtures ready (local HTTP + generated MP4 + 2 MiB attachment)',
      'PASS',
      `origin=${origin}; nativeFixtureOrigin=${nativeOrigin ?? '<unavailable>'}; clip.mp4=${clipBytes}B; clip-720.mp4=${clip720Bytes}B; file.bin=${server.fileBin.length}B sha256=${server.fileBinSha256}; handoff.bin=${server.fileBin.length}B (slow); secure.bin=${server.secureBinBytes}B sha256=${server.secureBinSha256} (cookie-only)`
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
    harnessManifest.host_permissions =
      nativeOriginPattern === null
        ? [originPattern]
        : [originPattern, nativeOriginPattern]
    delete harnessManifest.optional_permissions
    delete harnessManifest.optional_host_permissions
    fs.writeFileSync(path.join(harnessDir, 'manifest.json'), `${JSON.stringify(harnessManifest, null, 2)}\n`)

    browserB = await launchChromium({
      userDataDir: path.join(tempRoot, 'profile-harness'),
      extensionPath: harnessDir,
      label: 'harness',
      env: NATIVE_MODE
        ? {
            DONDOWNLOAD_BRIDGE_STATE: path.join(tempRoot, 'app-user-data', 'native-bridge.json')
          }
        : {}
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
      const expectedOrigins =
        nativeOriginPattern === null
          ? [originPattern]
          : [originPattern, nativeOriginPattern]
      const originsExact =
        origins.length === expectedOrigins.length &&
        expectedOrigins.every((pattern) => origins.includes(pattern))
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
        evidence: `getAll origins=${JSON.stringify(origins)} (expected=${JSON.stringify(expectedOrigins)} exact=${originsExact}); downloads API=${downloads}; webRequest API=${webRequest}; options target shown=${pointed}; site-state="${siteState}"; enable=${JSON.stringify(enableResponse.response || enableResponse)}; registrations=${JSON.stringify(registrations)}; overlay host/shadow/trigger=${host.host}/${host.shadow}/${host.trigger}; tabs=${JSON.stringify(tabsSnapshot)}`
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

    // ------------------------------------------------------------------
    // Phase C: native messaging against an isolated dev app (--native)
    // ------------------------------------------------------------------
    if (!NATIVE_MODE) {
      record(
        'N',
        'Native messaging scenarios (N1-N4) not requested',
        'INFO',
        'Run npm run test:extension:chromium:native (--native) for the temporary HKCU registration, isolated app and native-messaging paths.'
      )
    } else {
      nativeRun.attempted = true
      const heliumSnapshot = queryRegistryDefault(HELIUM_REG_KEY)
      nativeRun.heliumBefore = heliumSnapshot.exists ? heliumSnapshot.output : '<absent>'
      nativeRun.heliumAfter = nativeRun.heliumBefore

      let setupError = null
      try {
        if (nativeOrigin === null || server.nativeHost === null) {
          throw new Error(
            'no non-internal IPv4 address with a host name that resolves to it is available for the native fixture'
          )
        }
        removeStaleHarnessRegistration()
        if (queryRegistryDefault(CHROMIUM_REG_KEY).exists) {
          throw new Error(
            `${CHROMIUM_REG_KEY} already exists; refusing to overwrite it, so the native scenarios were aborted.`
          )
        }
        const host = resolveNativeHost(tempRoot)
        nativeRun.hostExe = host.exe
        nativeRun.hostBuilt = host.built
        const manifestPath = path.join(
          tempRoot,
          'native-manifest',
          `${NATIVE_HOST_NAME}.json`
        )
        nativeRun.manifestPath = manifestPath
        const manifest = writeNativeManifest(manifestPath, host.exe, workerB.id)
        const registration = registerChromiumHost(manifestPath)
        const userDataDir = path.join(tempRoot, 'app-user-data')
        const statePath = path.join(userDataDir, 'native-bridge.json')
        nativeRun.userDataDir = userDataDir
        nativeRun.downloadDir = path.join(userDataDir, 'smoke-downloads')
        nativeRun.app = await startIsolatedApp({
          userDataDir,
          statePath,
          tempRoot,
          fixtureHost: server.nativeHost.hostname,
          fixtureAddress: server.nativeHost.address
        })
        nativeRun.appStderr = nativeRun.app.stderr
        nativeRun.db = await openDownloadsDatabase(
          path.join(userDataDir, 'downloads.sqlite3')
        )

        // Open the same fixture through the resolved host name. A literal IP
        // would be rejected by the production target policy before any lookup.
        const nativePage = await createPage(browserB, `${nativeOrigin}/`)
        nativePage.browser = browserB
        const nativeTab = await waitForValue(
          () => tabIdForOrigin(browserB, optionsB.sessionId, nativeOrigin),
          (value) => typeof value === 'number',
          8000,
          'native fixture tab visible to the extension',
          100
        ).catch(async () => {
          const tabs = await browserB.connection.evaluate(
            optionsB.sessionId,
            'new Promise((resolve) => chrome.tabs.query({}, (items) => resolve(items.map((tab) => ({ id: tab.id, url: tab.url, status: tab.status })))))',
            { userGesture: false }
          )
          throw new Error(
            `the native fixture tab was not visible to the extension; tabs=${JSON.stringify(tabs)}`
          )
        })
        await browserB.connection.send('Target.activateTarget', {
          targetId: nativePage.targetId
        })
        const nativeEnable = await enableOverlayForTab(
          browserB,
          optionsB.sessionId,
          nativeOrigin,
          nativeTab
        )
        const nativeOverlay = await waitForOverlayHost(nativePage)
        await waitForVideoPlaying(nativePage)
        await waitForCapturedSources(
          browserB,
          optionsB.sessionId,
          nativeTab,
          (list) =>
            list.some(
              (item) =>
                typeof item.url === 'string' &&
                item.url.endsWith('/clip.mp4')
            )
        )
        nativeRun.page = nativePage
        record(
          'N0',
          'Isolated dev app and temporary Chromium registration ready',
          'PASS',
          `extensionId=${workerB.id}; allowed_origins=${JSON.stringify(manifest.allowed_origins)}; host=${host.exe} (tempBuild=${host.built}); manifest=${manifestPath}; key=${CHROMIUM_REG_KEY}; userData=${userDataDir}; downloadDir=${nativeRun.downloadDir}; state=${statePath}; nativeFixtureOrigin=${nativeOrigin} (${server.nativeHost.hostname} -> ${server.nativeHost.address}); overlayEnable=${JSON.stringify(nativeEnable)}; overlay=${JSON.stringify(nativeOverlay)}; heliumBefore=${JSON.stringify(nativeRun.heliumBefore)}; appLog=${JSON.stringify(nativeRun.appStderr().slice(-1200))}`
        )
      } catch (error) {
        setupError = error
        record(
          'N0',
          'Isolated dev app and temporary Chromium registration ready',
          'FAIL',
          error instanceof Error ? error.message : String(error)
        )
      }

      const blocked = (title) => ({
        status: 'NOT-RUNNABLE',
        evidence: `native setup did not complete: ${setupError instanceof Error ? setupError.message : String(setupError)}`
      })

      await scenario('N1', 'Native probe from the extension reaches the isolated app', async () => {
        if (setupError) return blocked()
        const probeUrl = `${nativeOrigin}/probe-missing.bin`
        const started = Date.now()
        const probe = await browserB.connection.evaluate(
          optionsB.sessionId,
          `new Promise((resolve) => chrome.runtime.sendNativeMessage(${JSON.stringify(NATIVE_HOST_NAME)}, {
            type: 'handoff-download',
            url: ${JSON.stringify(probeUrl)},
            filename: 'probe-missing.bin'
          }, (response) => resolve({
            response: response || null,
            error: chrome.runtime.lastError && chrome.runtime.lastError.message
          })))`,
          { userGesture: false }
        )
        const latencyMs = Date.now() - started
        const code =
          probe &&
          probe.response &&
          probe.response.error &&
          probe.response.error.code
        const rows = readDownloadRows(nativeRun.db)
        const queued = rows.some((row) => row.url === probeUrl)
        const appLog = nativeRun.appStderr()
        const appSawIt = /Durable hand-off preflight rejected \(HANDOFF_PREFLIGHT_FAILED\)/.test(appLog)
        const ok =
          !probe.error &&
          probe.response &&
          probe.response.ok === false &&
          code === 'HANDOFF_PREFLIGHT_FAILED' &&
          appSawIt &&
          !queued
        return {
          status: ok ? 'PASS' : 'FAIL',
          evidence: `native message=${JSON.stringify(probe)}; latency=${latencyMs} ms; app logged the preflight rejection=${appSawIt}; queued=${queued}; probeUrl=${probeUrl}`
        }
      })

      await scenario('N2', 'One-click overlay queue reaches the app and downloads the exact clip', async () => {
        if (setupError) return blocked()
        await browserB.connection.send('Target.activateTarget', {
          targetId: nativeRun.page.targetId
        })
        await waitForVideoPlaying(nativeRun.page)
        const clipUrl = `${nativeOrigin}/clip.mp4`
        const clipSha256 = crypto
          .createHash('sha256')
          .update(clip)
          .digest('hex')
        const clickResult = await pageEvaluate(
          nativeRun.page,
          `new Promise((resolve) => {
            const host = document.getElementById('dondownload-overlay-host')
            const shadow = host && host.shadowRoot
            const trigger = shadow && shadow.querySelector('.trigger')
            const panel = shadow && shadow.querySelector('.panel')
            if (panel && panel.hidden && trigger) trigger.click()
            const rows = shadow ? Array.from(shadow.querySelectorAll('.source-list .source')) : []
            const row = rows.find((entry) => {
              const title = entry.querySelector('.source-title')
              return title && title.textContent && title.textContent.indexOf('clip.mp4') !== -1
            })
            if (!row) {
              resolve({ ok: false, error: 'row-not-found', rows: rows.map((entry) => entry.textContent) })
              return
            }
            const button = row.querySelector('.source-action')
            if (!button) {
              resolve({ ok: false, error: 'button-not-found' })
              return
            }
            const status = shadow.querySelector('.status')
            const started = performance.now()
            button.click()
            const deadline = started + 25000
            const timer = setInterval(() => {
              const text = status ? status.textContent : ''
              const elapsed = performance.now() - started
              if (text === 'Added to DonDownload') {
                clearInterval(timer)
                resolve({ ok: true, latencyMs: Math.round(elapsed), status: text })
              } else if (text && text.indexOf('Adding ') !== 0) {
                clearInterval(timer)
                resolve({ ok: false, latencyMs: Math.round(elapsed), status: text })
              } else if (performance.now() > deadline) {
                clearInterval(timer)
                resolve({ ok: false, timeout: true, status: text })
              }
            }, 10)
          })`,
          { userGesture: true }
        )
        const clickStartedAt = Date.now()
        const rowFound = await waitForValue(
          () => readDownloadRows(nativeRun.db).find((entry) => entry.url === clipUrl) || null,
          (match) => match !== null,
          15000,
          'app row for the captured clip',
          20
        )
        const rowObservedAfterMs = Date.now() - clickStartedAt
        const completed = await waitForCompletedAppDownload(
          nativeRun.db,
          clipUrl,
          60000
        )
        const hashOk = completed.hash.sha256 === clipSha256
        const sizeOk = completed.hash.bytes === clip.length
        const exactUrl = completed.row.url === clipUrl
        const ok =
          clickResult.ok === true &&
          typeof clickResult.latencyMs === 'number' &&
          rowFound &&
          exactUrl &&
          completed.row.filename === 'clip.mp4' &&
          hashOk &&
          sizeOk &&
          completed.row.status === 'complete'
        return {
          status: ok ? 'PASS' : 'FAIL',
          evidence: `click=${JSON.stringify(clickResult)} (click-to-accepted ${clickResult.latencyMs} ms); db row first observed ${rowObservedAfterMs} ms after click; row=${JSON.stringify({ id: rowFound.id, url: rowFound.url, filename: rowFound.filename, status: completed.row.status, total: completed.row.total_bytes, dir: completed.row.dir })}; file=${completed.filePath} (${completed.hash.bytes}B); sha256=${completed.hash.sha256} expected=${clipSha256} match=${hashOk}; exactUrl=${exactUrl}`
        }
      })

      await scenario('N3', 'Hand-off success: durable app acceptance, then browser cancel, same bytes', async () => {
        if (setupError) return blocked()
        const setting = await ensureHandoffEnabled(browserB, optionsB.sessionId)
        const browserDownloadDir = path.join(tempRoot, 'downloads-handoff')
        fs.mkdirSync(browserDownloadDir, { recursive: true })
        await installDownloadEventLog(browserB, optionsB.sessionId)
        await browserB.connection.send('Browser.setDownloadBehavior', {
          behavior: 'allow',
          downloadPath: browserDownloadDir,
          eventsEnabled: true
        })
        const handoffUrl = `${nativeOrigin}/handoff.bin`
        const beforeRows = readDownloadRows(nativeRun.db)
        if (beforeRows.some((row) => row.url === handoffUrl)) {
          throw new Error('the hand-off fixture was already queued before this scenario')
        }

        const downloadPage = await createPage(browserB, handoffUrl)
        downloadPage.browser = browserB
        const item = await waitForValue(
          () =>
            searchDownloads(browserB, optionsB.sessionId).then(
              (items) =>
                items.find(
                  (candidate) =>
                    typeof candidate.url === 'string' &&
                    candidate.url.endsWith('/handoff.bin')
                ) || null
            ),
          (match) => match !== null,
          20000,
          'browser download item for handoff.bin',
          50
        )
        const itemId = item.id
        const rowFound = await waitForValue(
          () =>
            readDownloadRows(nativeRun.db).find(
              (entry) => entry.url === handoffUrl
            ) || null,
          (match) => match !== null,
          20000,
          'durable app row for handoff.bin',
          10
        )
        const dbObservedAt = Date.now()
        const terminal = await waitForValue(
          () =>
            searchDownloads(browserB, optionsB.sessionId).then(
              (items) =>
                items.find(
                  (candidate) =>
                    candidate.id === itemId &&
                    (candidate.state === 'interrupted' ||
                      candidate.state === 'complete')
                ) || null
            ),
          (match) => match !== null,
          25000,
          'browser download terminal state',
          50
        )
        const terminalObservedAt = Date.now()
        const events = await readDownloadEvents(browserB, optionsB.sessionId)
        const ownEvents = events.filter((event) => event.id === itemId)
        const stateEvents = ownEvents.filter(
          (event) => event.state === 'interrupted' || event.state === 'complete'
        )
        const terminalEvent = stateEvents[stateEvents.length - 1] || null
        const completed = await waitForCompletedAppDownload(
          nativeRun.db,
          handoffUrl,
          60000
        )
        const sessionState = await readStorage(
          browserB,
          optionsB.sessionId,
          'session',
          HANDOFF_STATE_KEY
        )
        const processed =
          sessionState &&
          sessionState[HANDOFF_STATE_KEY] &&
          sessionState[HANDOFF_STATE_KEY].processed
        const pending =
          sessionState &&
          sessionState[HANDOFF_STATE_KEY] &&
          sessionState[HANDOFF_STATE_KEY].pending
        const files = filesInDirectory(browserDownloadDir)
        const finalBrowserFile = files.includes('handoff.bin')
        const hashOk = completed.hash.sha256 === server.fileBinSha256
        const cancelled =
          terminal.state === 'interrupted' &&
          /cancel/i.test(terminal.error || '')
        const completedInBrowser = terminal.state === 'complete'
        const cancelAt = terminalEvent ? terminalEvent.at : terminalObservedAt
        // The row timestamp is written before the durable SQLite commit that
        // produces the receipt the extension waits for. A cancel at/after that
        // time therefore cannot have happened before acceptance.
        const acceptedBeforeCancel =
          completed.row.created_at <= cancelAt &&
          dbObservedAt <= terminalObservedAt
        const ok =
          setting.automaticFileHandoff === true &&
          cancelled &&
          !completedInBrowser &&
          acceptedBeforeCancel &&
          hashOk &&
          !finalBrowserFile &&
          Array.isArray(processed) &&
          processed.includes(itemId) &&
          Array.isArray(pending) &&
          pending.length === 0
        return {
          status: ok ? 'PASS' : 'FAIL',
          evidence: `setting=${JSON.stringify({ automaticFileHandoff: setting.automaticFileHandoff })}; browser item=${JSON.stringify({ id: itemId, state: terminal.state, error: terminal.error, totalBytes: terminal.totalBytes, bytesReceived: terminal.bytesReceived })}; state events=${JSON.stringify(stateEvents)}; app row=${JSON.stringify({ id: rowFound.id, created_at: completed.row.created_at, status: completed.row.status, total: completed.row.total_bytes })}; db observed at=${dbObservedAt}; terminal observed at=${terminalObservedAt}; accepted before cancel=${acceptedBeforeCancel}; app file=${completed.filePath} (${completed.hash.bytes}B) sha256=${completed.hash.sha256} expected=${server.fileBinSha256} match=${hashOk}; browser download dir files=${JSON.stringify(files)}; final browser file present=${finalBrowserFile}; handoff processed=${JSON.stringify(processed)} pending=${JSON.stringify(pending)}`
        }
      })

      await scenario('N4', 'Hand-off refusal: auth-only fixture completes in the browser and is not queued', async () => {
        if (setupError) return blocked()
        const setting = await ensureHandoffEnabled(browserB, optionsB.sessionId)
        const browserDownloadDir = path.join(tempRoot, 'downloads-refused')
        fs.mkdirSync(browserDownloadDir, { recursive: true })
        await installDownloadEventLog(browserB, optionsB.sessionId)
        await browserB.connection.send('Browser.setDownloadBehavior', {
          behavior: 'allow',
          downloadPath: browserDownloadDir,
          eventsEnabled: true
        })
        // The browser has the session cookie; the app's anonymous preflight
        // deliberately does not, so it must reject this target.
        const cookie = await pageEvaluate(
          nativeRun.page,
          `(() => {
            document.cookie = 'auth=1; path=/'
            return document.cookie
          })()`,
          { userGesture: false }
        )
        const secureUrl = `${nativeOrigin}/secure.bin`
        const stderrBefore = nativeRun.appStderr().length
        const downloadPage = await createPage(browserB, secureUrl)
        downloadPage.browser = browserB
        const item = await waitForValue(
          () =>
            searchDownloads(browserB, optionsB.sessionId).then(
              (items) =>
                items.find(
                  (candidate) =>
                    typeof candidate.url === 'string' &&
                    candidate.url.endsWith('/secure.bin')
                ) || null
            ),
          (match) => match !== null,
          20000,
          'browser download item for secure.bin',
          50
        )
        const itemId = item.id
        const complete = await waitForValue(
          () =>
            searchDownloads(browserB, optionsB.sessionId).then(
              (items) =>
                items.find(
                  (candidate) =>
                    candidate.id === itemId && candidate.state === 'complete'
                ) || null
            ),
          (match) => match !== null,
          30000,
          'browser download completion for secure.bin',
          50
        )
        const hash = hashFile(complete.filename)
        // The browser can finish before the desktop's bounded anonymous probe
        // returns, so wait for that exact request before judging the refusal.
        const anonymousPreflight = await waitForValue(
          () =>
            server.log.filter(
              (entry) =>
                entry.path === '/secure.bin' &&
                !entry.cookie &&
                typeof entry.range === 'string' &&
                entry.range.startsWith('bytes=0-0')
            ),
          (hits) => (hits.length > 0 ? hits : null),
          12000,
          'anonymous secure.bin preflight',
          100
        ).catch(() => [])
        await sleep(2500)
        const secureHits = server.log.filter(
          (entry) => entry.path === '/secure.bin'
        )
        const authenticatedBrowser = secureHits.filter(
          (entry) => entry.cookie && /auth=1/.test(entry.cookie)
        )
        const rows = readDownloadRows(nativeRun.db)
        const appRow =
          rows.find((entry) => entry.url === secureUrl) || null
        const appFiles = filesInDirectory(nativeRun.downloadDir)
        const sessionState = await readStorage(
          browserB,
          optionsB.sessionId,
          'session',
          HANDOFF_STATE_KEY
        )
        const processed =
          sessionState &&
          sessionState[HANDOFF_STATE_KEY] &&
          sessionState[HANDOFF_STATE_KEY].processed
        const pending =
          sessionState &&
          sessionState[HANDOFF_STATE_KEY] &&
          sessionState[HANDOFF_STATE_KEY].pending
        const newAppLog = nativeRun.appStderr().slice(stderrBefore)
        const preflightRejected =
          /Durable hand-off preflight rejected \(HANDOFF_PREFLIGHT_FAILED\)/.test(
            newAppLog
          )
        const hashOk = hash.sha256 === server.secureBinSha256
        const ok =
          setting.automaticFileHandoff === true &&
          complete.state === 'complete' &&
          hashOk &&
          anonymousPreflight.length > 0 &&
          authenticatedBrowser.length > 0 &&
          preflightRejected &&
          appRow === null &&
          !appFiles.includes('secure.bin') &&
          Array.isArray(processed) &&
          processed.includes(itemId) &&
          Array.isArray(pending) &&
          pending.length === 0
        return {
          status: ok ? 'PASS' : 'FAIL',
          evidence: `cookie=${JSON.stringify(cookie)}; browser item=${JSON.stringify({ id: itemId, state: complete.state, totalBytes: complete.totalBytes, bytesReceived: complete.bytesReceived, filename: complete.filename })}; file (${hash.bytes}B) sha256=${hash.sha256} expected=${server.secureBinSha256} match=${hashOk}; secure requests=${JSON.stringify(secureHits)}; anonymous range probes=${JSON.stringify(anonymousPreflight)}; authenticated browser requests=${authenticatedBrowser.length}; app preflight rejection logged=${preflightRejected}; app log=${JSON.stringify(newAppLog.slice(-1200))}; app row=${JSON.stringify(appRow)}; app files=${JSON.stringify(appFiles)}; handoff processed=${JSON.stringify(processed)} pending=${JSON.stringify(pending)}`
        }
      })
    }
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
