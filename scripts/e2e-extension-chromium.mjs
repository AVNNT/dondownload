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
// changes (verified by scenario 2a, including the command-line, automation-flag
// and CDP-only approaches listed in its evidence). The remaining scenarios
// therefore run the same extension sources from a temp copy whose manifest
// declares the optional permissions as required for the loopback fixture
// origin only. This is reported explicitly in the result table; it is not
// presented as the real grant flow.
//
// --browser=<path> runs the same checks against another Chromium-based build
// (npm run test:extension:helium) using a fresh temp profile. It never touches
// an already-running browser or a real profile.

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

/**
 * Copy the extension for a harness browser WITHOUT its pinned manifest "key".
 * The key gives the shipped extension a fixed ID that the user's real
 * native-messaging registration allows; a harness copy carrying it could reach
 * the user's real running app. Without the key the ID is derived from the temp
 * path, so only the harness's own temporary registration can ever match it.
 */
function copyIsolatedExtension(destination) {
  fs.cpSync(EXTENSION_DIR, destination, { recursive: true })
  const manifestPath = path.join(destination, 'manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  delete manifest.key
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}
const FFMPEG = path.join(ROOT, 'build', 'vendor', 'ffmpeg', 'ffmpeg.exe')
const FFPROBE = path.join(ROOT, 'build', 'vendor', 'ffmpeg', 'ffprobe.exe')
const ARIA2 = path.join(ROOT, 'build', 'vendor', 'aria2', 'aria2c.exe')

function browserArgument() {
  const prefix = '--browser='
  const match = process.argv.find((value) => value.startsWith(prefix))
  if (!match) return null
  const value = match.slice(prefix.length).trim()
  if (!value) return null
  if (/^helium$/i.test(value)) {
    return path.join(process.env.LOCALAPPDATA || '', 'imput', 'Helium', 'Application', 'chrome.exe')
  }
  return value
}

const BROWSER_ARG = browserArgument()
const CHROME =
  BROWSER_ARG ||
  process.env.DONDOWNLOAD_CHROME_PATH ||
  path.join(process.env.LOCALAPPDATA || '', 'ms-playwright', 'chromium-1248', 'chrome-win64', 'chrome.exe')
// Chromium-branded builds (Playwright's chromium-1248) and Helium share the
// same CDP surface but differ in native-messaging registry lookup and in how
// reliably they honour --load-extension.
const BROWSER_NAME = /helium/i.test(CHROME) ? 'Helium' : 'Chromium'
const NATIVE_MODE = process.argv.includes('--native')
// Opt-in real public sites. Requires the isolated app (--native), because the
// verified quality list and the one-click download are produced by yt-dlp in
// the desktop app. Never part of the default npm test commands.
const REAL_SITES = process.argv.includes('--real-sites')
const NATIVE_HOST_NAME = 'com.dondownload.bridge'
// Chromium-branded builds read this exact per-user key. Only this key is
// written, and only after proving it did not exist.
const CHROMIUM_REG_KEY = `HKCU\\Software\\Chromium\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`
// The user's real Helium registration. It is read once for an identity check
// and is never written, modified or deleted.
const HELIUM_REG_KEY = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`

const EXTENSION_NAME = 'DonDownload Capture'
const HANDOFF_STATE_KEY = 'dondownloadHandoffState'
const NEEDS_LOGIN_STATE_KEY = 'dondownloadHandoffNeedsLogin'
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

/**
 * Chromium honours --load-extension, but another Chromium-based build (Helium)
 * may ignore it. When the worker never appears, load the same directory through
 * the CDP Extensions domain (available with --enable-unsafe-extension-debugging)
 * and open an extension page so the MV3 worker starts.
 */
async function ensureExtensionLoaded(browser, extensionPath, label) {
  try {
    return await findExtensionWorker(browser, { timeoutMs: 8000 })
  } catch (initialError) {
    let extensionId = null
    try {
      const loaded = await browser.connection.send('Extensions.loadUnpacked', { path: extensionPath })
      extensionId = loaded && loaded.id
    } catch (loadError) {
      throw new Error(
        `${label}: service worker did not appear (${initialError.message}) and Extensions.loadUnpacked failed: ${loadError.message}`,
        { cause: loadError }
      )
    }
    if (!extensionId) {
      throw new Error(`${label}: Extensions.loadUnpacked returned no extension id`, {
        cause: initialError
      })
    }
    // An extension page is required to wake the MV3 service worker; it is kept
    // open for the rest of the run so the worker does not idle out.
    await browser.connection
      .send('Target.createTarget', { url: `chrome-extension://${extensionId}/options.html` })
      .catch(() => undefined)
    return findExtensionWorker(browser, { timeoutMs: 15000 })
  }
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

async function createPage(browser, url, { waitForCommit = true } = {}) {
  const { targetId } = await browser.connection.send('Target.createTarget', { url })
  const sessionId = await browser.connection.attach(targetId)
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    try {
      // A freshly created target can still be about:blank with a pending
      // navigation (Helium keeps that state for a couple of seconds), so the
      // committed URL must match before the page is considered ready. Download
      // URLs never commit a document, so callers can opt out of that check.
      const state = await browser.connection.evaluate(
        sessionId,
        '({ ready: document.readyState, href: location.href })',
        { userGesture: false }
      )
      if (
        state &&
        state.ready === 'complete' &&
        (!waitForCommit || state.href === url)
      ) {
        return { targetId, sessionId }
      }
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

const KVS_LICENSE = '$123456789012345'
const KVS_PRIMARY_TARGET = '0123456789abcdef0123456789abcdef'
const KVS_ALT_TARGET = 'fedcba9876543210fedcba9876543210'
const KVS_POSTER_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z9ZkAAAAASUVORK5CYII=',
  'base64'
)

function kvsLicenseToken(licenseCode) {
  const code = String(licenseCode).replace(/\$/g, '')
  const values = code.split('').map(Number)
  let modlicense = code.replace(/0/g, '1')
  const center = Math.floor(modlicense.length / 2)
  const front = Number.parseInt(modlicense.slice(0, center + 1), 10)
  const back = Number.parseInt(modlicense.slice(center), 10)
  modlicense = String(4 * Math.abs(front - back)).slice(0, center + 1)
  const token = []
  for (let index = 0; index < modlicense.length; index += 1) {
    for (let offset = 0; offset < 4; offset += 1) {
      token.push((values[index + offset] + Number(modlicense[index])) % 10)
    }
  }
  return token
}

function kvsPermutation(licenseCode) {
  const token = kvsLicenseToken(licenseCode)
  const indices = Array.from({ length: 32 }, (_value, index) => index)
  let accum = 0
  for (let source = 31; source >= 0; source -= 1) {
    accum += token[source]
    const destination = (source + accum) % 32
    const swap = indices[source]
    indices[source] = indices[destination]
    indices[destination] = swap
  }
  return indices
}

/** Build the obfuscated hash that decodes back to `target`. */
function kvsEncodeHash(target, licenseCode) {
  const indices = kvsPermutation(licenseCode)
  const encoded = new Array(32)
  for (let index = 0; index < 32; index += 1) {
    encoded[indices[index]] = target[index]
  }
  return encoded.join('')
}

function kvsFixtureHtml(origin, obfuscated) {
  const primaryHash = obfuscated
    ? kvsEncodeHash(KVS_PRIMARY_TARGET, KVS_LICENSE)
    : KVS_PRIMARY_TARGET
  const altHash = obfuscated
    ? kvsEncodeHash(KVS_ALT_TARGET, KVS_LICENSE)
    : KVS_ALT_TARGET
  const prefix = obfuscated ? 'function/0/' : ''
  const flashvars = {
    video_id: '1',
    license_code: KVS_LICENSE,
    video_url: `${prefix}${origin}/get_file/1/${primaryHash}/0/1/1.mp4/`,
    video_url_text: '480p',
    video_alt_url: `${prefix}${origin}/get_file/1/${altHash}/0/1/1_720p.mp4/`,
    video_alt_url_text: '720p',
    preview_url: `${origin}/poster.png`
  }
  return (
    '<!doctype html><meta charset="utf-8"><title>KVS fixture</title>' +
    '<body style="margin:0;background:#080808;color:#ddd;font:14px sans-serif">' +
    '<div id="kt_player" style="position:relative;width:640px;height:360px;margin:20px auto;background:#000;background-image:url(\'/poster.png\');background-size:cover">' +
    '<div class="kt_wrapper"><div class="video-holder" style="position:absolute;inset:0">' +
    '<button class="play-button" type="button" style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:4;width:84px;height:84px;border-radius:50%;border:0;background:rgba(255,255,255,.85);font-size:30px;cursor:pointer">▶</button>' +
    '<div id="kt_click_catcher" style="position:absolute;inset:0;z-index:5;background:transparent"></div>' +
    '</div></div></div>' +
    '<div id="kvs-debug" style="text-align:center;color:#555">KVS player v6 fixture</div>' +
    '<script src="/kt_player.js"></script>' +
    `<script>var flashvars = ${JSON.stringify(flashvars)}; kt_player('kt_player', '/kt_player.js', '100%', '100%', flashvars);</script>` +
    '</body>'
  )
}

const KVS_PLAYER_JS =
  "(function(){\n" +
  "  function kt_player(id, script, width, height, flashvars) {\n" +
  "    var root = document.getElementById(id)\n" +
  "    if (!root) return\n" +
  "    var holder = root.querySelector('.video-holder') || root\n" +
  "    var video = document.createElement('video')\n" +
  "    video.id = 'kvs-video'\n" +
  "    video.preload = 'none'\n" +
  "    video.playsInline = true\n" +
  "    video.muted = true\n" +
  "    video.setAttribute('style', 'width:100%;height:100%;display:block;background:#000;object-fit:contain')\n" +
  "    holder.insertBefore(video, holder.firstChild)\n" +
  "    root.__video = video\n" +
  "    root.__flashvars = flashvars\n" +
  "    root.addEventListener('click', function () {\n" +
  "      if (!video.getAttribute('src')) video.src = flashvars.video_url\n" +
  "      var played = video.play()\n" +
  "      if (played && played.catch) played.catch(function () {})\n" +
  "    }, false)\n" +
  "  }\n" +
  "  window.kt_player = kt_player\n" +
  "})()\n"

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

async function startFixtureServer({ clip, clip720, hlsRoot = null, audio = Buffer.alloc(0) }) {
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
      referer: req.headers.referer || null,
      at: Date.now(),
      status: null
    })
    const logRow = log[log.length - 1]
    res.once('finish', () => {
      logRow.status = res.statusCode
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
      const delay =
        Number.isSafeInteger(options.slowDelay) && options.slowDelay > 0
          ? options.slowDelay
          : 60
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
      }, delay)
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
    if (parsed.pathname === '/embed') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(
        '<!doctype html><meta charset="utf-8"><title>fixture-embed</title>' +
          '<body style="margin:0;background:#111">' +
          '<iframe id="e" width="560" height="315" ' +
          'src="https://www.youtube.com/embed/jNQXAC9IVRw" ' +
          'title="Embedded fixture video" frameborder="0" ' +
          'allow="accelerometer; autoplay; clipboard-write; encrypted-media; picture-in-picture" ' +
          'allowfullscreen></iframe>' +
          '</body>'
      )
      return
    }
    if (parsed.pathname === '/hls') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(
        '<!doctype html><meta charset="utf-8"><title>fixture-hls</title>' +
          '<body style="margin:0;background:#111">' +
          '<video id="p" src="/hls/master.m3u8" width="640" height="360" muted autoplay loop playsinline></video>' +
          '<script>(async function(){' +
          'const master=await fetch("/hls/master.m3u8");await master.text();' +
          'await fetch("/hls/high/index.m3u8");' +
          'await fetch("/hls/high/seg0.ts");' +
          '})().catch(function(){})</script>' +
          '</body>'
      )
      return
    }
    if (parsed.pathname === '/referer-hidden') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(
        '<!doctype html><meta charset="utf-8"><title>fixture-referer</title>' +
          '<body style="margin:0;background:#111">' +
          '<p style="color:#888">hidden referer-checked media</p>' +
          '<script>fetch("/hidden-referer.mp4").then(function(r){return r.arrayBuffer()}).catch(function(){})</script>' +
          '</body>'
      )
      return
    }
    if (parsed.pathname === '/audio') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(
        '<!doctype html><meta charset="utf-8"><title>fixture-audio</title>' +
          '<body style="margin:0;background:#111">' +
          '<audio id="p" src="/tone.mp3" controls autoplay loop></audio>' +
          '</body>'
      )
      return
    }
    if (parsed.pathname.startsWith('/hls/') && hlsRoot) {
      const relative = decodeURIComponent(parsed.pathname.slice('/hls/'.length))
      if (
        relative.length === 0 ||
        relative.includes('..') ||
        relative.includes('\\') ||
        path.isAbsolute(relative)
      ) {
        res.writeHead(404)
        res.end()
        return
      }
      const file = path.join(hlsRoot, relative)
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404)
        res.end()
        return
      }
      const extension = path.extname(file).toLowerCase()
      const contentType =
        extension === '.m3u8'
          ? 'application/vnd.apple.mpegurl'
          : extension === '.ts'
            ? 'video/mp2t'
            : 'application/octet-stream'
      sendBuffer(fs.readFileSync(file), contentType)
      return
    }
    if (parsed.pathname === '/hidden-referer.mp4') {
      const referer =
        typeof req.headers.referer === 'string' ? req.headers.referer : ''
      if (!/\/referer-hidden(?:[?#]|$)/.test(referer)) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('referer required')
        return
      }
      // Above the 100 KB detection threshold on purpose.
      sendBuffer(clip720, 'video/mp4')
      return
    }
    if (parsed.pathname === '/tone.mp3') {
      sendBuffer(audio, 'audio/mpeg')
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
    if (parsed.pathname === '/short/secure.bin') {
      res.writeHead(302, {
        location: '/secure.bin',
        'cache-control': 'no-store'
      })
      res.end()
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
      sendBuffer(
        secureBin,
        'application/octet-stream',
        {
          'content-disposition': 'attachment; filename="secure.bin"',
          'cache-control': 'no-store'
        },
        { slow: true, slowDelay: 120 }
      )
      return
    }
    if (
      parsed.pathname === '/kvs' ||
      parsed.pathname === '/kvs-obfuscated'
    ) {
      const origin = `http://${req.headers.host}`
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store'
      })
      res.end(kvsFixtureHtml(origin, parsed.pathname === '/kvs-obfuscated'))
      return
    }
    if (parsed.pathname === '/kt_player.js') {
      res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-store'
      })
      res.end(KVS_PLAYER_JS)
      return
    }
    if (parsed.pathname === '/poster.png') {
      res.writeHead(200, {
        'content-type': 'image/png',
        'content-length': KVS_POSTER_PNG.length,
        'cache-control': 'no-store'
      })
      res.end(KVS_POSTER_PNG)
      return
    }
    if (
      parsed.pathname.startsWith('/get_file/') &&
      parsed.pathname.endsWith('.mp4/')
    ) {
      const file = /_720p\.mp4\/$/.test(parsed.pathname)
        ? 'clip-720.mp4'
        : 'clip.mp4'
      res.writeHead(302, {
        location: `/remote_control.php?file=${encodeURIComponent(file)}&rnd=${Date.now()}`,
        'cache-control': 'no-store'
      })
      res.end()
      return
    }
    if (parsed.pathname === '/remote_control.php') {
      const file = parsed.searchParams.get('file')
      if (file === 'clip.mp4') {
        sendBuffer(clip, 'video/mp4', { 'cache-control': 'no-store' })
        return
      }
      if (file === 'clip-720.mp4') {
        sendBuffer(clip720, 'video/mp4', { 'cache-control': 'no-store' })
        return
      }
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
    clip,
    clipSha256: crypto.createHash('sha256').update(clip).digest('hex'),
    clip720Sha256: crypto.createHash('sha256').update(clip720).digest('hex'),
    hiddenRefererBytes: clip720.length,
    hiddenRefererSha256: crypto.createHash('sha256').update(clip720).digest('hex'),
    audioBytes: audio.length,
    audioSha256: crypto.createHash('sha256').update(audio).digest('hex'),
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

async function generateHls(ffmpegPath, source, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true })
  const playlist = path.join(targetDir, 'index.m3u8')
  await new Promise((resolve, reject) => {
    const proc = spawn(
      ffmpegPath,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        source,
        '-c',
        'copy',
        '-an',
        '-f',
        'hls',
        '-hls_time',
        '1',
        '-hls_playlist_type',
        'vod',
        '-hls_segment_filename',
        path.join(targetDir, 'seg%d.ts'),
        playlist
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
      else reject(new Error(`ffmpeg HLS exited ${code}: ${stderr.slice(-1000)}`))
    })
  })
  if (!fs.existsSync(playlist)) {
    throw new Error(`HLS playlist was not generated: ${playlist}`)
  }
}

async function generateAudio(ffmpegPath, output) {
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
        'sine=frequency=440:duration=8',
        '-c:a',
        'libmp3lame',
        '-b:a',
        '192k',
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
      else reject(new Error(`ffmpeg audio exited ${code}: ${stderr.slice(-1000)}`))
    })
  })
  const stat = fs.statSync(output)
  if (stat.size < 100 * 1024) {
    throw new Error(`generated audio is below the detection threshold: ${stat.size} bytes`)
  }
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

async function tabIdForUrl(browser, optionsSession, url) {
  return browser.connection.evaluate(
    optionsSession,
    `new Promise((resolve) => chrome.tabs.query({}, (tabs) => {
      const match = tabs.find((tab) => typeof tab.url === 'string' && (tab.url === ${JSON.stringify(url)} || tab.url.startsWith(${JSON.stringify(url + '?')})))
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

async function querySniffed(browser, optionsSession, tabId) {
  return browser.connection.evaluate(
    optionsSession,
    `new Promise((resolve) => chrome.runtime.sendMessage({ type: 'dondownload:sniffed-query', tabId: ${tabId} }, (value) => resolve({
      response: value,
      error: chrome.runtime.lastError && chrome.runtime.lastError.message
    })))`,
    { userGesture: false }
  )
}

async function waitForSniffed(
  browser,
  optionsSession,
  tabId,
  predicate,
  timeoutMs = 20000
) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    try {
      last = await querySniffed(browser, optionsSession, tabId)
      if (
        last &&
        last.response &&
        Array.isArray(last.response.media) &&
        predicate(last.response.media)
      ) {
        return last.response.media
      }
    } catch {
      // Worker may still be starting.
    }
    await sleep(200)
  }
  throw new Error(`sniffed media did not satisfy predicate: ${JSON.stringify(last)}`)
}

async function queueSniffed(browser, optionsSession, tabId, url, variantUrl) {
  return browser.connection.evaluate(
    optionsSession,
    `new Promise((resolve) => chrome.runtime.sendMessage({
      type: 'dondownload:sniffed-queue',
      tabId: ${tabId},
      url: ${JSON.stringify(url)},
      ${variantUrl ? `variantUrl: ${JSON.stringify(variantUrl)},` : ''}
    }, (value) => resolve({
      response: value,
      error: chrome.runtime.lastError && chrome.runtime.lastError.message
    })))`,
    { userGesture: true }
  )
}

async function navigatePage(page, url, timeoutMs = 15000) {
  await page.browser.connection.send(
    'Page.navigate',
    { url },
    page.sessionId
  )
  return waitForValue(
    () =>
      pageEvaluate(
        page,
        '({ ready: document.readyState, href: location.href })',
        { userGesture: false }
      ),
    (state) =>
      state && state.ready === 'complete' && state.href === url,
    timeoutMs,
    `navigation to ${url}`,
    100
  )
}

async function badgeText(browser, optionsSession, tabId) {
  return browser.connection.evaluate(
    optionsSession,
    `new Promise((resolve) => chrome.action.getBadgeText({ tabId: ${tabId} }, (value) => resolve(value)))`,
    { userGesture: false }
  )
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
  heliumProbe: null,
  notRunnable: false,
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
  // Real-site runs must keep the production public-target policy untouched, so
  // the loopback fixture whitelist is omitted unless a fixture host was given.
  delete env.DONDOWNLOAD_SMOKE_FIXTURE_HOST
  delete env.DONDOWNLOAD_SMOKE_FIXTURE_ADDRESS
  delete env.DONDOWNLOAD_SMOKE_FIXTURE_PUBLIC_ADDRESS
  if (fixtureHost && fixtureAddress) {
    env.DONDOWNLOAD_SMOKE_FIXTURE_HOST = fixtureHost
    env.DONDOWNLOAD_SMOKE_FIXTURE_ADDRESS = fixtureAddress
    // A globally routable placeholder keeps the production public-target check
    // in force; the injected preflight pins the real connection to the fixture.
    env.DONDOWNLOAD_SMOKE_FIXTURE_PUBLIC_ADDRESS = '93.184.216.34'
  }
  env.DONDOWNLOAD_ARIA2_PATH = ARIA2
  // The repository keeps its binaries under build/vendor; point the isolated
  // app at them explicitly instead of relying on a staged vendor/ directory.
  env.DONDOWNLOAD_YTDLP_PATH = path.join(ROOT, 'build', 'vendor', 'yt-dlp', 'yt-dlp.exe')
  env.DONDOWNLOAD_FFMPEG_PATH = FFMPEG
  env.DONDOWNLOAD_DENO_PATH = path.join(ROOT, 'build', 'vendor', 'deno', 'deno.exe')

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
  // Turn takeover on through the real Allow button. One user gesture asks for
  // downloads, cookies and the host permission together.
  await browser.connection.evaluate(
    optionsSession,
    `(() => {
      const button = document.getElementById('request-downloads')
      if (button && !button.hidden) button.click()
      const checkbox = document.getElementById('automatic-handoff')
      if (checkbox && !checkbox.disabled && !checkbox.checked) checkbox.click()
      return true
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

async function enableCookieOptInForOrigin(browser, optionsSession, origin) {
  const stored = await readStorage(browser, optionsSession, 'local', CAPTURE_SETTINGS_KEY)
  const settings =
    stored && stored[CAPTURE_SETTINGS_KEY]
      ? { ...stored[CAPTURE_SETTINGS_KEY] }
      : {}
  const origins = Array.isArray(settings.cookieOptInOrigins)
    ? settings.cookieOptInOrigins.slice()
    : []
  if (!origins.includes(origin)) origins.push(origin)
  settings.cookieOptInOrigins = origins
  settings.automaticFileHandoff = true
  await browser.connection.evaluate(
    optionsSession,
    `chrome.storage.local.set({ ${JSON.stringify(CAPTURE_SETTINGS_KEY)}: ${JSON.stringify(settings)} })`,
    { userGesture: false }
  )
  return waitForValue(
    () => readStorage(browser, optionsSession, 'local', CAPTURE_SETTINGS_KEY),
    (value) =>
      value &&
      value[CAPTURE_SETTINGS_KEY] &&
      Array.isArray(value[CAPTURE_SETTINGS_KEY].cookieOptInOrigins) &&
      value[CAPTURE_SETTINGS_KEY].cookieOptInOrigins.includes(origin),
    5000,
    'cookie opt-in setting'
  )
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
// real public sites (--real-sites; opt-in, network required)
// ---------------------------------------------------------------------------

const REAL_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36'
const REAL_VIDEO_URL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw'
const REAL_VIDEO_TITLE = 'Me at the zoo'
const REAL_PROGRESSIVE_PAGE = 'https://www.w3schools.com/html/html5_video.asp'
const REAL_PROGRESSIVE_MP4 = 'https://www.w3schools.com/html/mov_bbb.mp4'
const REAL_ICON_BUDGET_MS = 1500

const timings = []

function recordTiming(label, ms, note) {
  timings.push({ label, ms, note: note || '' })
}

function realProbeSource() {
  return `(() => {
    if (window.top !== window) return
    if (window.__ddRealProbe) return
    const probe = {
      startedAt: performance.now(),
      tVisible: null,
      tPlay: null,
      tIcon: null,
      paused: null,
      readyState: null,
      currentTime: null,
      videoWidth: null,
      videoHeight: null,
      href: location.href,
      nav: []
    }
    window.__ddRealProbe = probe
    const visible = (el) => {
      if (!el) return false
      const rect = el.getBoundingClientRect()
      if (rect.width < 2 || rect.height < 2) return false
      const style = getComputedStyle(el)
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'
    }
    const iconVisible = () => {
      const host = document.getElementById('dondownload-overlay-host')
      const shadow = host && host.shadowRoot
      const trigger = shadow && shadow.querySelector('.trigger')
      return Boolean(trigger && !trigger.hidden && visible(trigger))
    }
    const largestVideo = () => {
      let best = null
      let area = 0
      const videos = Array.from(document.querySelectorAll('video'))
      for (const video of videos) {
        if (!visible(video)) continue
        const rect = video.getBoundingClientRect()
        const value = rect.width * rect.height
        if (value > area) {
          area = value
          best = video
        }
      }
      return best
    }
    setInterval(() => {
      if (location.href !== probe.href) {
        probe.nav.push({ at: performance.now(), from: probe.href, to: location.href })
        probe.href = location.href
        probe.tVisible = null
        probe.tPlay = null
        probe.tIcon = null
      }
      const video = largestVideo()
      if (video) {
        probe.readyState = video.readyState
        probe.paused = video.paused
        probe.currentTime = video.currentTime
        probe.videoWidth = video.videoWidth
        probe.videoHeight = video.videoHeight
        if (probe.tVisible === null && video.readyState >= 2) {
          probe.tVisible = performance.now()
        }
        if (
          probe.tPlay === null &&
          probe.tVisible !== null &&
          !video.paused &&
          video.readyState >= 2 &&
          (video.currentTime > 0.05 || video.readyState >= 3)
        ) {
          probe.tPlay = performance.now()
        }
      }
      if (probe.tVisible !== null && probe.tIcon === null && iconVisible()) {
        probe.tIcon = performance.now()
      }
    }, 20)
  })()`
}

async function createRealPage(browser, url) {
  const { targetId } = await browser.connection.send('Target.createTarget', { url: 'about:blank' })
  const sessionId = await browser.connection.attach(targetId)
  await browser.connection.send('Page.enable', {}, sessionId).catch(() => undefined)
  await browser.connection.send('Network.enable', {}, sessionId).catch(() => undefined)
  await browser.connection
    .send(
      'Network.setUserAgentOverride',
      { userAgent: REAL_UA, acceptLanguage: 'en-US,en' },
      sessionId
    )
    .catch(() => undefined)
  await browser.connection
    .send('Page.addScriptToEvaluateOnNewDocument', { source: realProbeSource() }, sessionId)
    .catch(() => undefined)
  await browser.connection.send('Page.navigate', { url }, sessionId)
  const page = { targetId, sessionId, browser }
  const deadline = Date.now() + 45000
  while (Date.now() < deadline) {
    try {
      const state = await pageEvaluate(page, '({ ready: document.readyState, href: location.href })', {
        userGesture: false
      })
      if (state && state.ready === 'complete' && state.href.startsWith('http')) return page
    } catch {
      // still navigating
    }
    await sleep(150)
  }
  return page
}

async function readPageState(page) {
  return pageEvaluate(
    page,
    `(() => ({
      href: location.href,
      ready: document.readyState,
      title: document.title,
      text: document.body ? String(document.body.innerText || '').slice(0, 600) : ''
    }))()`,
    { userGesture: false }
  ).catch(() => null)
}

async function clickConsent(browser, page) {
  return pageEvaluate(
    page,
    `(() => {
      const nodes = Array.from(document.querySelectorAll('button, [role="button"], a'))
      const text = (node) => String(node.innerText || node.textContent || '').replace(/\\s+/g, ' ').trim()
      const reject = nodes.find((node) => /^(reject all|reject|decline all|no thanks)$/i.test(text(node)))
      const accept = nodes.find((node) => /^(accept all|i agree|agree to all)$/i.test(text(node)))
      const target = reject || accept
      if (!target) return { clicked: false, labels: nodes.slice(0, 24).map(text).filter(Boolean) }
      target.click()
      return { clicked: true, label: text(target), kind: reject ? 'reject' : 'accept' }
    })()`,
    { userGesture: true }
  )
}

/**
 * Follow consent/redirect hops on a real page. Every click happens inside the
 * fresh temporary profile through CDP; nothing is read from the user's browser.
 */
async function settleRealPage(browser, page, predicate, timeoutMs, _label) {
  const deadline = Date.now() + timeoutMs
  let last = null
  let consentClicks = 0
  while (Date.now() < deadline) {
    last = await readPageState(page)
    if (last && last.ready === 'complete' && predicate(last)) {
      return { ok: true, state: last, consentClicks }
    }
    const consentish =
      last &&
      (/consent\.youtube\.com/i.test(last.href) ||
        /before you continue/i.test(last.title || '') ||
        /before you continue/i.test(last.text || ''))
    if (consentish) {
      const click = await clickConsent(browser, page).catch(() => null)
      if (click && click.clicked) {
        consentClicks += 1
        await sleep(1500)
        continue
      }
    }
    await sleep(250)
  }
  return { ok: false, state: last, consentClicks }
}

async function tabIdForUrlFragment(browser, optionsSession, fragment) {
  return browser.connection.evaluate(
    optionsSession,
    `new Promise((resolve) => chrome.tabs.query({}, (tabs) => {
      const match = tabs.find((tab) => typeof tab.url === 'string' && tab.url.indexOf(${JSON.stringify(fragment)}) !== -1)
      resolve(match ? match.id : null)
    }))`,
    { userGesture: false }
  )
}

async function ensureRealVideoPlaying(page, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await pageEvaluate(
      page,
      `(() => {
        const videos = Array.from(document.querySelectorAll('video')).filter((video) => {
          const rect = video.getBoundingClientRect()
          return rect.width >= 100 && rect.height >= 80
        })
        const video = videos.sort((left, right) => {
          const a = left.getBoundingClientRect()
          const b = right.getBoundingClientRect()
          return b.width * b.height - a.width * a.height
        })[0]
        if (!video) return { present: false, href: location.href, title: document.title }
        video.muted = true
        if (video.paused && video.readyState >= 2) video.play().catch(() => undefined)
        return {
          present: true,
          readyState: video.readyState,
          paused: video.paused,
          currentTime: video.currentTime,
          duration: video.duration,
          width: video.videoWidth,
          height: video.videoHeight,
          error: video.error ? video.error.code + ':' + video.error.message : null
        }
      })()`,
      { userGesture: true }
    ).catch(() => null)
    if (last && last.present && last.readyState >= 2 && !last.error) return last
    await sleep(250)
  }
  return last || { present: false }
}

async function readProbe(page) {
  return pageEvaluate(page, 'window.__ddRealProbe || null', { userGesture: false }).catch(() => null)
}

async function readOverlayState(page) {
  return pageEvaluate(
    page,
    `(() => {
      const host = document.getElementById('dondownload-overlay-host')
      const shadow = host && host.shadowRoot
      const trigger = shadow && shadow.querySelector('.trigger')
      const panel = shadow && shadow.querySelector('.panel')
      const visible = (el) => {
        if (!el || el.hidden) return false
        const rect = el.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0
      }
      const rows = shadow
        ? Array.from(shadow.querySelectorAll('.quality-list .quality-option, .advanced-quality-list .quality-option')).map((row) => {
            const label = String(row.textContent || '').replace(/\\s+/g, ' ').trim()
            const heightMatch = /(\\d{2,5})p/.exec(label)
            return {
              label,
              optionId: null,
              kind: /audio only/i.test(label) ? 'audio' : 'video',
              height: heightMatch ? Number(heightMatch[1]) : null,
              hasAudio: /with audio|\\+/.test(label),
              estimatedBytes: null
            }
          })
        : []
      const sourceRows = shadow
        ? Array.from(shadow.querySelectorAll('.source-list .source')).map((row) => String(row.innerText || '').replace(/\\s+/g, ' ').trim())
        : []
      const analyze = shadow && shadow.querySelector('.analyze')
      const embed = shadow && shadow.querySelector('.embed-analyze')
      return {
        host: Boolean(host),
        shadow: Boolean(shadow),
        triggerVisible: visible(trigger),
        triggerHidden: trigger ? trigger.hidden : null,
        panelHidden: panel ? panel.hidden : null,
        qualityRows: rows,
        sourceRows,
        status: shadow && shadow.querySelector('.status') ? shadow.querySelector('.status').textContent : '',
        analyzeHidden: analyze ? analyze.hidden : null,
        analyzeText: analyze ? analyze.textContent : null,
        embedHidden: embed ? embed.hidden : null,
        embedText: embed ? embed.textContent : null
      }
    })()`,
    { userGesture: false }
  )
}

async function openOverlayPanel(page) {
  await pageEvaluate(
    page,
    `(() => {
      const host = document.getElementById('dondownload-overlay-host')
      const trigger = host && host.shadowRoot && host.shadowRoot.querySelector('.trigger')
      if (trigger && !trigger.hidden) trigger.click()
      return true
    })()`,
    { userGesture: true }
  )
  return readOverlayState(page)
}

/** Open popup.html as the harness does for options, but target a real tab. */
async function openPopupForTab(browser, extensionId, page) {
  const { targetId } = await browser.connection.send('Target.createTarget', {
    url: `chrome-extension://${extensionId}/popup.html`
  })
  const sessionId = await browser.connection.attach(targetId)
  const popup = { targetId, sessionId, browser }
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    try {
      const ready = await browser.connection.evaluate(
        sessionId,
        'document.readyState === "complete" && !!document.getElementById("detected-state")',
        { userGesture: false }
      )
      if (ready) break
    } catch {
      // still loading
    }
    await sleep(150)
  }
  // A real action popup is not a tab. Activate the measured tab and reload the
  // extension page so chrome.tabs.query({active:true}) resolves it, then keep
  // the popup page as an inactive tab for observation.
  await browser.connection.send('Target.activateTarget', { targetId: page.targetId }).catch(() => undefined)
  await browser.connection.send('Page.reload', {}, sessionId).catch(() => undefined)
  const expected = await pageEvaluate(page, 'location.href', { userGesture: false })
  const readyDeadline = Date.now() + 20000
  while (Date.now() < readyDeadline) {
    try {
      const state = await browser.connection.evaluate(
        sessionId,
        `(() => ({
          pageUrl: document.getElementById('page-url') ? document.getElementById('page-url').textContent : '',
          detected: document.getElementById('detected-state') ? document.getElementById('detected-state').textContent : '',
          rows: Array.from(document.querySelectorAll('#capture-list .capture-row')).map((row) => String(row.innerText || '').replace(/\\s+/g, ' ').trim()),
          emptyHidden: document.getElementById('capture-empty') ? document.getElementById('capture-empty').hidden : null,
          findHidden: document.getElementById('find-qualities') ? document.getElementById('find-qualities').hidden : null,
          status: document.getElementById('status') ? document.getElementById('status').textContent : ''
        }))()`,
        { userGesture: false }
      )
      if (state && state.pageUrl && expected && state.pageUrl.indexOf('youtube.com/watch') !== -1) {
        return { popup, state, expected }
      }
    } catch {
      // reloading
    }
    await sleep(250)
  }
  return { popup, state: null, expected }
}

function ffprobeOutput(filePath) {
  const result = spawnSync(
    FFPROBE,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath],
    { encoding: 'utf8', windowsHide: true }
  )
  if (result.status !== 0) {
    return { ok: false, error: `${result.status}: ${String(result.stderr || '').slice(-400)}` }
  }
  try {
    const parsed = JSON.parse(result.stdout)
    const streams = Array.isArray(parsed.streams) ? parsed.streams : []
    return {
      ok: true,
      duration: parsed.format ? Number(parsed.format.duration) : null,
      size: parsed.format ? Number(parsed.format.size) : null,
      videoStreams: streams.filter((stream) => stream.codec_type === 'video').length,
      audioStreams: streams.filter((stream) => stream.codec_type === 'audio').length,
      videoCodec: (streams.find((stream) => stream.codec_type === 'video') || {}).codec_name || null
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function readMediaJobRows(db) {
  try {
    return db
      .prepare(
        'SELECT id, source_url, analysis_id, option_id, kind, title, label, status, completed_bytes, total_bytes, error_message, dir, file_path, created_at, updated_at FROM media_jobs ORDER BY created_at DESC, updated_at DESC'
      )
      .all()
  } catch {
    return []
  }
}

async function watchMediaJob(db, sourceUrl, timeoutMs = 180000) {
  const samples = []
  let lastKey = ''
  let final = null
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const row = readMediaJobRows(db).find((entry) => entry.source_url === sourceUrl)
    if (row) {
      const key = `${row.status}:${row.completed_bytes}:${row.file_path || ''}`
      if (key !== lastKey) {
        lastKey = key
        samples.push({ ...row })
      }
      if (['complete', 'error', 'cancelled', 'interrupted'].includes(row.status)) {
        final = row
        break
      }
    }
    await sleep(50)
  }
  if (final === null) {
    final = readMediaJobRows(db).find((entry) => entry.source_url === sourceUrl) || null
  }
  return { samples, final }
}

async function watchDownloadRow(db, url, timeoutMs = 120000) {
  return waitForValue(
    () => readDownloadRows(db).find((entry) => entry.url === url) || null,
    (row) => row !== null && ['complete', 'error', 'cancelled', 'interrupted'].includes(row.status),
    timeoutMs,
    `download row for ${url}`,
    50
  )
}

async function queueSmallestQualityOnPage(page) {
  const state = await readOverlayState(page)
  if (state.panelHidden !== false) await openOverlayPanel(page)
  const result = await pageEvaluate(
    page,
    `(() => {
      const host = document.getElementById('dondownload-overlay-host')
      const shadow = host && host.shadowRoot
      if (!shadow) return { ok: false, error: 'overlay-missing' }
      const rows = Array.from(shadow.querySelectorAll('.quality-list .quality-option, .advanced-quality-list .quality-option'))
      const candidates = []
      for (const row of rows) {
        const label = String(row.textContent || '').replace(/\\s+/g, ' ').trim()
        const heightMatch = /(\\d{2,5})p/.exec(label)
        if (!heightMatch || /audio only/i.test(label)) continue
        candidates.push({ row, label, height: Number(heightMatch[1]) })
      }
      candidates.sort((left, right) => left.height - right.height)
      const pick = candidates[0]
      if (!pick) {
        return {
          ok: false,
          error: 'no-video-options',
          rows: rows.map((row) => String(row.textContent || '').replace(/\\s+/g, ' ').trim())
        }
      }
      const button = pick.row.querySelector('.quality-queue')
      if (!button) return { ok: false, error: 'queue-button-missing' }
      const status = shadow.querySelector('.status')
      const started = performance.now()
      button.click()
      return {
        ok: true,
        label: pick.label,
        option: {
          height: pick.height,
          kind: 'video'
        },
        clickStartedAt: started,
        statusBefore: status ? status.textContent : ''
      }
    })()`,
    { userGesture: true }
  )
  if (!result || result.ok !== true) return result
  const accepted = await waitForValue(
    () => pageEvaluate(page, `(() => {
      const host = document.getElementById('dondownload-overlay-host')
      const shadow = host && host.shadowRoot
      const status = shadow && shadow.querySelector('.status')
      return { text: status ? status.textContent : '' }
    })()`, { userGesture: false }),
    (value) =>
      Boolean(
        value &&
          (/Added to DonDownload/i.test(value.text) || /already/i.test(value.text))
      ),
    2500,
    'overlay queue confirmation',
    50
  ).catch((error) => ({ text: `timeout: ${error.message}` }))
  return { ...result, accepted }
}

async function runRealSites({ tempRoot }) {
  record(
    'R0',
    'Real-site mode is opt-in and requires the isolated app',
    REAL_SITES && NATIVE_MODE ? 'PASS' : 'FAIL',
    `browser=${BROWSER_NAME} (${CHROME}); native=${NATIVE_MODE}; realSites=${REAL_SITES}; profile=${path.join(tempRoot, 'profile-real-sites')}`
  )

  // Anonymous direct fetch is the byte reference for R3. It shares nothing with
  // the browser profile or the app.
  let reference = null
  try {
    const response = await fetch(REAL_PROGRESSIVE_MP4, {
      redirect: 'follow',
      headers: { 'user-agent': REAL_UA }
    })
    const bytes = Buffer.from(await response.arrayBuffer())
    reference = {
      status: response.status,
      bytes: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex')
    }
  } catch (error) {
    reference = { error: error instanceof Error ? error.message : String(error) }
  }

  const clipPath = path.join(tempRoot, 'media', 'real-clip.mp4')
  const clipBytes = await generateClip(FFMPEG, clipPath, { width: 320, height: 180 })
  const clip = fs.readFileSync(clipPath)
  const server = await startFixtureServer({ clip, clip720: clip })
  record(
    'R0b',
    'Cross-origin embed fixture and anonymous byte reference ready',
    reference && reference.sha256 ? 'PASS' : 'NOT-RUNNABLE',
    `embedFixture=${server.origin}/embed; clip=${clipBytes}B; progressiveReference=${JSON.stringify(reference)}`
  )

  const harnessDir = path.join(tempRoot, 'extension-real-sites')
  const harnessManifest = copyIsolatedExtension(harnessDir)
  harnessManifest.permissions = [...new Set([...(harnessManifest.permissions || []), 'downloads', 'webRequest'])]
  harnessManifest.host_permissions = [
    `${server.origin}/*`,
    'https://www.youtube.com/*',
    'https://www.w3schools.com/*'
  ]
  delete harnessManifest.optional_permissions
  delete harnessManifest.optional_host_permissions
  fs.writeFileSync(path.join(harnessDir, 'manifest.json'), `${JSON.stringify(harnessManifest, null, 2)}\n`)
  record(
    'R0c',
    'Harness manifest predeclares only the three measured origins',
    'INFO',
    `host_permissions=${JSON.stringify(harnessManifest.host_permissions)}; the extension source files are byte-identical`
  )

  const userDataDir = path.join(tempRoot, 'real-app-user-data')
  const statePath = path.join(userDataDir, 'native-bridge.json')
  const downloadDir = path.join(userDataDir, 'smoke-downloads')
  const browser = await launchChromium({
    userDataDir: path.join(tempRoot, 'profile-real-sites'),
    extensionPath: harnessDir,
    label: 'real-sites',
    env: { DONDOWNLOAD_BRIDGE_STATE: statePath }
  })
  let db = null
  let app = null
  try {
    const worker = await ensureExtensionLoaded(browser, harnessDir, 'real-sites')
    const options = await openExtensionPage(browser, worker.id, 'options.html')
    await sleep(500)

    // Native messaging registration is identical to --native: only the
    // temporary Chromium key is written, only after proving it is absent.
    const heliumSnapshot = queryRegistryDefault(HELIUM_REG_KEY)
    nativeRun.attempted = true
    nativeRun.heliumBefore = heliumSnapshot.exists ? heliumSnapshot.output : '<absent>'
    nativeRun.heliumAfter = nativeRun.heliumBefore
    let setupError = null
    try {
      removeStaleHarnessRegistration()
      if (queryRegistryDefault(CHROMIUM_REG_KEY).exists) {
        throw new Error(`${CHROMIUM_REG_KEY} already exists; refusing to overwrite it.`)
      }
      const host = resolveNativeHost(tempRoot)
      nativeRun.hostExe = host.exe
      nativeRun.hostBuilt = host.built
      const manifestPath = path.join(tempRoot, 'native-manifest-real', `${NATIVE_HOST_NAME}.json`)
      nativeRun.manifestPath = manifestPath
      writeNativeManifest(manifestPath, host.exe, worker.id)
      registerChromiumHost(manifestPath)
      if (BROWSER_NAME === 'Helium') {
        const probe = await browser.connection.evaluate(
          options.sessionId,
          `Promise.race([
            new Promise((resolve) => chrome.runtime.sendNativeMessage(${JSON.stringify(NATIVE_HOST_NAME)}, { type: 'helium-registry-probe' }, (response) => resolve({
              response: response || null,
              error: chrome.runtime.lastError && chrome.runtime.lastError.message
            }))),
            new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 8000))
          ])`,
          { userGesture: false }
        )
        nativeRun.heliumProbe = probe
        const code = probe && probe.response && probe.response.error && probe.response.error.code
        if (code !== 'UNSUPPORTED_OPERATION') nativeRun.notRunnable = true
        if (code !== 'UNSUPPORTED_OPERATION') {
          throw new Error(`Helium did not resolve the temporary Chromium registration: ${JSON.stringify(probe)}`)
        }
      }
      nativeRun.userDataDir = userDataDir
      nativeRun.downloadDir = downloadDir
      app = await startIsolatedApp({
        userDataDir,
        statePath,
        tempRoot,
        fixtureHost: null,
        fixtureAddress: null
      })
      nativeRun.app = app
      nativeRun.appStderr = app.stderr
      db = await openDownloadsDatabase(path.join(userDataDir, 'downloads.sqlite3'))
      nativeRun.db = db
      record(
        'R0d',
        'Isolated app, temporary native registration and database ready',
        'PASS',
        `extensionId=${worker.id}; host=${host.exe} (tempBuild=${host.built}); key=${CHROMIUM_REG_KEY}; userData=${userDataDir}; downloadDir=${downloadDir}; appLog=${JSON.stringify(app.stderr().slice(-800))}`
      )
    } catch (error) {
      setupError = error
      record(
        'R0d',
        'Isolated app, temporary native registration and database ready',
        nativeRun.notRunnable ? 'NOT-RUNNABLE' : 'FAIL',
        error instanceof Error ? error.message : String(error)
      )
    }

    const blocked = () => ({
      status: 'NOT-RUNNABLE',
      evidence: `native setup did not complete: ${setupError instanceof Error ? setupError.message : String(setupError)}`
    })

    // ------------------------------------------------------------------
    // R1 + R2: YouTube watch page
    // ------------------------------------------------------------------
    let ytPage = null
    let ytTab = null
    let analysis = null

    await scenario('R1a', 'YouTube floating icon appears within 1500 ms of the video', async () => {
      if (setupError) return blocked()
      ytPage = await createRealPage(browser, 'https://www.youtube.com/')
      const settledHome = await settleRealPage(
        browser,
        ytPage,
        (state) => /^https:\/\/www\.youtube\.com\//.test(state.href),
        45000,
        'youtube home'
      )
      if (!settledHome.ok) {
        return {
          status: 'NOT-RUNNABLE',
          evidence: `YouTube did not finish loading its home page (consent/network). state=${JSON.stringify(settledHome.state)}; consentClicks=${settledHome.consentClicks}`
        }
      }
      ytTab = await waitForValue(
        () => tabIdForUrlFragment(browser, options.sessionId, 'https://www.youtube.com/'),
        (value) => typeof value === 'number',
        15000,
        'YouTube tab visible to the extension',
        100
      )
      await enableOverlayForTab(browser, options.sessionId, 'https://www.youtube.com', ytTab)
      await browser.connection
        .send('Page.navigate', { url: REAL_VIDEO_URL }, ytPage.sessionId)
        .catch(() => undefined)
      const settled = await settleRealPage(
        browser,
        ytPage,
        (state) => /youtube\.com\/watch\?v=jNQXAC9IVRw/.test(state.href),
        60000,
        'youtube watch'
      )
      if (!settled.ok) {
        return {
          status: 'NOT-RUNNABLE',
          evidence: `YouTube watch page did not load (consent/network/anti-bot). state=${JSON.stringify(settled.state)}; consentClicks=${settled.consentClicks}`
        }
      }
      await browser.connection.send('Target.activateTarget', { targetId: ytPage.targetId })
      const video = await ensureRealVideoPlaying(ytPage)
      if (!video || video.present !== true) {
        return {
          status: 'NOT-RUNNABLE',
          evidence: `YouTube did not render a playable <video> in this headless profile (anti-bot or region gate). state=${JSON.stringify(await readPageState(ytPage))}`
        }
      }
      const probe = await waitForValue(
        () => readProbe(ytPage),
        (value) => value !== null && typeof value.tVisible === 'number',
        30000,
        'in-page video visibility probe',
        100
      )
      const icon = await waitForValue(
        () => readProbe(ytPage),
        (value) => value !== null && typeof value.tIcon === 'number',
        10000,
        'floating icon visibility',
        50
      ).catch(() => null)
      if (!icon) {
        return {
          status: 'FAIL',
          evidence: `floating icon never became visible. video=${JSON.stringify(video)}; probe=${JSON.stringify(probe)}; overlay=${JSON.stringify(await readOverlayState(ytPage))}`
        }
      }
      const ms = Math.round(icon.tIcon - icon.tVisible)
      recordTiming('R1a icon vs video visible', ms, 'budget 1500 ms')
      const ok = ms >= 0 && ms <= REAL_ICON_BUDGET_MS
      analysis = { tVisible: icon.tVisible, tIcon: icon.tIcon }
      return {
        status: ok ? 'PASS' : 'FAIL',
        evidence: `video=${JSON.stringify(video)}; videoVisibleAt=${Math.round(icon.tVisible)}ms (page clock); iconVisibleAt=${Math.round(icon.tIcon)}ms; delta=${ms} ms (budget ${REAL_ICON_BUDGET_MS}); playAt=${icon.tPlay === null ? null : Math.round(icon.tPlay)}; iconPresentNow=${(await readOverlayState(ytPage)).triggerVisible}`
      }
    })

    await scenario('R1b', 'YouTube prefetch fills the overlay panel without "Find qualities"', async () => {
      if (setupError) return blocked()
      if (!ytPage) return { status: 'NOT-RUNNABLE', evidence: 'R1a did not open the watch page' }
      const opened = await openOverlayPanel(ytPage)
      const panelOpenedAt = Date.now()
      const firstIcon = analysis && typeof analysis.tIcon === 'number' ? analysis.tIcon : null
      const ready = await waitForValue(
        () => readOverlayState(ytPage),
        (state) =>
          Array.isArray(state.qualityRows) &&
          state.qualityRows.some((row) => typeof row.height === 'number'),
        25000,
        'prefetched quality rows',
        250
      ).catch(() => null)
      if (!ready) {
        return {
          status: 'FAIL',
          evidence: `no quality rows appeared within 25 s and no Find qualities button was clicked. panel=${JSON.stringify(opened)}; now=${JSON.stringify(await readOverlayState(ytPage))}; status=${JSON.stringify(await readOverlayState(ytPage)).status}`
        }
      }
      const ms = Date.now() - panelOpenedAt
      recordTiming('R1b options after panel open', ms, `${ready.qualityRows.length} rows`)
      analysis = { ...analysis, rows: ready.qualityRows, tOptions: firstIcon === null ? null : ms }
      return {
        status: 'PASS',
        evidence: `panelOpen=${JSON.stringify({ panelHidden: opened.panelHidden, analyzeHidden: opened.analyzeHidden, analyzeText: opened.analyzeText })}; waited=${ms} ms after opening the panel (within 25 s); rows=${JSON.stringify(ready.qualityRows)}; sourceRows=${JSON.stringify(ready.sourceRows)}; status="${ready.status}"; analyzeClicked=false`
      }
    })

    await scenario('R1c', 'YouTube popup shows "Streaming video detected" with options', async () => {
      if (setupError) return blocked()
      if (!ytPage) return { status: 'NOT-RUNNABLE', evidence: 'R1a did not open the watch page' }
      const opened = await openPopupForTab(browser, worker.id, ytPage)
      if (!opened.state) {
        return {
          status: 'FAIL',
          evidence: `popup did not resolve the YouTube tab; expected=${opened.expected}`
        }
      }
      const ready = await waitForValue(
        () =>
          browser.connection.evaluate(
            opened.popup.sessionId,
            `(() => ({
              detected: document.getElementById('detected-state').textContent,
              rows: Array.from(document.querySelectorAll('#capture-list .capture-row')).map((row) => String(row.innerText || '').replace(/\\s+/g, ' ').trim()),
              emptyHidden: document.getElementById('capture-empty').hidden,
              emptyText: document.getElementById('capture-empty').textContent,
              findHidden: document.getElementById('find-qualities').hidden,
              pageUrl: document.getElementById('page-url').textContent
            }))()`,
            { userGesture: false }
          ),
        (state) =>
          state &&
          state.detected === 'Streaming video detected' &&
          Array.isArray(state.rows) &&
          state.rows.length > 0,
        25000,
        'popup streaming detection',
        250
      ).catch(() => null)
      const finalState =
        ready ||
        (await browser.connection.evaluate(
          opened.popup.sessionId,
          `(() => ({
            detected: document.getElementById('detected-state').textContent,
            rows: Array.from(document.querySelectorAll('#capture-list .capture-row')).map((row) => String(row.innerText || '').replace(/\\s+/g, ' ').trim()),
            emptyHidden: document.getElementById('capture-empty').hidden,
            emptyText: document.getElementById('capture-empty').textContent,
            findHidden: document.getElementById('find-qualities').hidden,
            pageUrl: document.getElementById('page-url').textContent
          }))()`,
          { userGesture: false }
        ))
      const ok =
        finalState &&
        finalState.detected === 'Streaming video detected' &&
        Array.isArray(finalState.rows) &&
        finalState.rows.length > 0 &&
        !/Nothing detected/i.test(finalState.detected)
      return {
        status: ok ? 'PASS' : 'FAIL',
        evidence: `popupPageUrl="${finalState.pageUrl}"; detected="${finalState.detected}"; rows=${JSON.stringify(finalState.rows)}; emptyHidden=${finalState.emptyHidden}; empty="${finalState.emptyText}"; findQualitiesHidden=${finalState.findHidden}`
      }
    })

    await scenario('R2', 'One-click smallest YouTube quality: progress, filename, playback, staging', async () => {
      if (setupError) return blocked()
      if (!ytPage || !db) return { status: 'NOT-RUNNABLE', evidence: 'R1a/app setup did not complete' }
      await browser.connection.send('Target.activateTarget', { targetId: ytPage.targetId })
      const queued = await queueSmallestQualityOnPage(ytPage)
      if (!queued || queued.ok !== true) {
        return {
          status: 'FAIL',
          evidence: `the smallest-quality row could not be queued: ${JSON.stringify(queued)}; panel=${JSON.stringify(await readOverlayState(ytPage))}`
        }
      }
      // Capture the job id as soon as it exists, then sample the app's own IPC
      // status (the same data the renderer draws) rather than only the
      // throttled SQLite writes.
      const rowSeen = await waitForValue(
        () => readMediaJobRows(db).find((entry) => entry.source_url === REAL_VIDEO_URL) || null,
        (row) => row !== null,
        30000,
        'media job row',
        20
      ).catch(() => null)
      const ipcSamples = []
      let ipcFinal = null
      if (rowSeen) {
        const ipcDeadline = Date.now() + 180000
        let lastKey = ''
        const dbRow = () => readMediaJobRows(db).find((entry) => entry.id === rowSeen.id) || null
        while (Date.now() < ipcDeadline) {
          const status = await browser.connection.evaluate(
            options.sessionId,
            `new Promise((resolve) => chrome.runtime.sendNativeMessage(${JSON.stringify(NATIVE_HOST_NAME)}, { type: 'media-status', jobId: ${JSON.stringify(rowSeen.id)} }, (response) => resolve({
              response: response || null,
              error: chrome.runtime.lastError && chrome.runtime.lastError.message
            })))`,
            { userGesture: false }
          ).catch(() => null)
          const job = status && status.response && status.response.job ? status.response.job : null
          if (job) {
            const key = `${job.status}:${job.completedBytes}:${job.totalBytes}`
            if (key !== lastKey) {
              lastKey = key
              ipcSamples.push(job)
            }
            if (['complete', 'error', 'cancelled', 'interrupted'].includes(job.status)) {
              ipcFinal = job
              break
            }
          } else {
            const row = dbRow()
            if (row && ['complete', 'error', 'cancelled', 'interrupted'].includes(row.status)) break
          }
          await sleep(60)
        }
      }
      const watched = await watchMediaJob(db, REAL_VIDEO_URL, 180000)
      const final = watched.final || (ipcFinal
        ? {
            id: ipcFinal.id,
            status: ipcFinal.status,
            title: ipcFinal.title,
            label: ipcFinal.label,
            completed_bytes: ipcFinal.completedBytes,
            total_bytes: ipcFinal.totalBytes,
            dir: ipcFinal.dir,
            file_path: ipcFinal.filePath
          }
        : null)
      if (!final) {
        return {
          status: 'FAIL',
          evidence: `no media job row was persisted. click=${JSON.stringify(queued)}; ipcSamples=${JSON.stringify(ipcSamples)}; appLog=${JSON.stringify((app ? app.stderr() : '').slice(-2500))}`
        }
      }
      const filePath = final.file_path || (final.dir ? path.join(final.dir, 'unknown') : null)
      const fileExists = Boolean(filePath && fs.existsSync(filePath))
      const hash = fileExists ? hashFile(filePath) : null
      const base = filePath ? path.basename(filePath) : ''
      const stem = base.replace(/\.[^.]+$/, '')
      const probe = fileExists ? ffprobeOutput(filePath) : null
      const stagingLeft = final.dir
        ? fs
            .readdirSync(final.dir, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && entry.name.startsWith('.dondownload-'))
            .map((entry) => entry.name)
        : []
      const combined = [
        ...ipcSamples.map((row) => ({ status: row.status, completed_bytes: row.completedBytes, total_bytes: row.totalBytes, source: 'ipc' })),
        ...watched.samples.map((row) => ({ status: row.status, completed_bytes: row.completed_bytes, total_bytes: row.total_bytes, source: 'db' }))
      ]
      const stages = combined.map((row) => row.status)
      const progressObserved = combined.some(
        (row) =>
          (row.status === 'downloading' || row.status === 'merging') &&
          row.completed_bytes > 0
      )
      const mergingSeen = combined.some((row) => row.status === 'merging')
      const startingSeen = stages.includes('queued') || stages.includes('downloading')
      const progressUpdates = combined.filter(
        (row) => row.status === 'downloading' || row.status === 'merging'
      ).length
      const duration = probe && probe.ok ? probe.duration : null
      const durationOk = typeof duration === 'number' && duration >= 17.5 && duration <= 21
      const ok =
        final.status === 'complete' &&
        fileExists &&
        stem === REAL_VIDEO_TITLE &&
        !/[[\]{}]/.test(base) &&
        progressObserved &&
        progressUpdates > 0 &&
        probe &&
        probe.ok &&
        probe.videoStreams >= 1 &&
        durationOk &&
        stagingLeft.length === 0 &&
        queued.option &&
        queued.option.height ===
          Math.min(
            ...(analysis && Array.isArray(analysis.rows)
              ? analysis.rows.filter((row) => typeof row.height === 'number').map((row) => row.height)
              : [queued.option.height])
          )
      return {
        status: ok ? 'PASS' : 'FAIL',
        evidence: `clicked=${JSON.stringify({ label: queued.label, option: queued.option, accepted: queued.accepted })}; job=${JSON.stringify({ id: final.id, status: final.status, title: final.title, label: final.label, completed: final.completed_bytes, total: final.total_bytes, dir: final.dir, file: final.file_path })}; ipcSamples=${JSON.stringify(ipcSamples.map((row) => ({ status: row.status, bytes: row.completedBytes, total: row.totalBytes })))}; dbSamples=${JSON.stringify(watched.samples.map((row) => ({ status: row.status, bytes: row.completed_bytes, total: row.total_bytes })))}; progressUpdates=${progressUpdates}; progressObserved=${progressObserved}; startingPhase=${startingSeen}; mergingPhase=${mergingSeen}; file=${filePath} (${hash ? hash.bytes : 0}B); name="${base}" stem="${stem}" expected="${REAL_VIDEO_TITLE}"; ffprobe=${JSON.stringify(probe)}; stagingDirsLeft=${JSON.stringify(stagingLeft)}; stagedStatuses=${JSON.stringify(stages)}`
      }
    })

    await scenario('R1d', 'YouTube SPA navigation resets icon and options to the new video', async () => {
      if (setupError) return blocked()
      if (!ytPage) return { status: 'NOT-RUNNABLE', evidence: 'R1a did not open the watch page' }
      await browser.connection.send('Target.activateTarget', { targetId: ytPage.targetId })
      await sleep(500)
      const before = await readOverlayState(ytPage)
      const beforeCapture = await queryCapturedSources(browser, options.sessionId, ytTab).catch(() => null)
      const beforeAnalysisId =
        beforeCapture && beforeCapture.response && beforeCapture.response.analysis
          ? beforeCapture.response.analysis.analysisId
          : null
      const beforeHref = await pageEvaluate(ytPage, 'location.href', { userGesture: false })
      const spaStartedAt = Date.now()
      const clicked = await pageEvaluate(
        ytPage,
        `(() => {
          const current = new URL(location.href).searchParams.get('v')
          const links = Array.from(document.querySelectorAll('a[href*="/watch?v="]'))
          const pick = links.find((link) => {
            try {
              const url = new URL(link.href, location.href)
              const id = url.searchParams.get('v')
              return url.hostname.endsWith('youtube.com') && id && id !== current
            } catch {
              return false
            }
          })
          if (!pick) return { clicked: false, candidates: links.length }
          const href = pick.href
          pick.click()
          return { clicked: true, href }
        })()`,
        { userGesture: true }
      )
      if (!clicked || clicked.clicked !== true) {
        return {
          status: 'NOT-RUNNABLE',
          evidence: `no in-page related-video link was available to drive SPA navigation; links=${JSON.stringify(clicked)}; href=${beforeHref}`
        }
      }
      const changed = await waitForValue(
        () => pageEvaluate(ytPage, '({ href: location.href, probe: window.__ddRealProbe || null })', { userGesture: false }),
        (value) => value && value.href !== beforeHref && !value.href.includes('jNQXAC9IVRw'),
        45000,
        'SPA URL change',
        250
      ).catch(() => null)
      if (!changed) {
        return { status: 'NOT-RUNNABLE', evidence: `YouTube did not complete the in-page navigation within 45 s; clicked=${JSON.stringify(clicked)}; href=${beforeHref}` }
      }
      await ensureRealVideoPlaying(ytPage, 20000).catch(() => null)
      const videoAfter = await pageEvaluate(
        ytPage,
        `(() => {
          const videos = Array.from(document.querySelectorAll('video'))
          return videos.map((video) => ({
            readyState: video.readyState,
            paused: video.paused,
            duration: video.duration,
            width: video.videoWidth,
            height: video.videoHeight,
            src: String(video.currentSrc || '').slice(0, 120)
          }))
        })()`,
        { userGesture: false }
      ).catch(() => null)
      const autoDeadline = Date.now() + 20000
      let autoCapture = null
      let autoReadyAt = null
      while (Date.now() < autoDeadline) {
        const value = await queryCapturedSources(browser, options.sessionId, ytTab).catch(() => null)
        const response = value && value.response ? value.response : null
        if (response) {
          autoCapture = {
            status: response.status,
            streaming: response.streaming,
            analysisId: response.analysis ? response.analysis.analysisId : null,
            title: response.analysis ? response.analysis.title : null,
            options: response.analysis && Array.isArray(response.analysis.options) ? response.analysis.options.length : 0,
            url: response.url
          }
          if (response.analysis && response.analysis.analysisId !== beforeAnalysisId) {
            autoReadyAt = Date.now() - spaStartedAt
            break
          }
          if (response.status === 'error') break
        }
        await sleep(250)
      }
      const autoPrefetchReady = autoReadyAt !== null
      await openOverlayPanel(ytPage)
      const resetState = await waitForValue(
        () => readOverlayState(ytPage),
        (state) =>
          state.triggerVisible === true &&
          Array.isArray(state.qualityRows) &&
          state.qualityRows.length > 0,
        30000,
        'new video options after SPA navigation',
        250
      ).catch(() => null)
      const afterHref = await pageEvaluate(ytPage, 'location.href', { userGesture: false })
      const afterProbe = await readProbe(ytPage)
      const afterCapture = await queryCapturedSources(browser, options.sessionId, ytTab).catch(() => null)
      const afterAnalysisId =
        afterCapture && afterCapture.response && afterCapture.response.analysis
          ? afterCapture.response.analysis.analysisId
          : null
      const newId = new URL(afterHref).searchParams.get('v')
      const beforeId = new URL(beforeHref).searchParams.get('v')
      const navRecorded = Boolean(
        afterProbe && Array.isArray(afterProbe.nav) && afterProbe.nav.length > 0
      )
      const optionsChanged =
        resetState &&
        Array.isArray(resetState.qualityRows) &&
        resetState.qualityRows.length > 0
      const ok =
        newId &&
        beforeId &&
        newId !== beforeId &&
        resetState &&
        resetState.triggerVisible === true &&
        optionsChanged &&
        navRecorded &&
        afterAnalysisId !== null &&
        afterAnalysisId !== beforeAnalysisId
      recordTiming(
        'R1d SPA reset to options',
        Date.now() - spaStartedAt,
        `newId=${newId}; autoPrefetch=${autoPrefetchReady ? `${autoReadyAt}ms` : 'did not start before the panel opened'}`
      )
      return {
        status: ok ? 'PASS' : 'FAIL',
        evidence: `before=${beforeHref} (v=${beforeId}, rows=${before.qualityRows.length}, analysisId=${beforeAnalysisId}); after=${afterHref} (v=${newId}, analysisId=${afterAnalysisId}); clicked=${JSON.stringify(clicked)}; videosAfter=${JSON.stringify(videoAfter)}; probeNavigations=${JSON.stringify(afterProbe && afterProbe.nav)}; autoPrefetchReady=${autoPrefetchReady} at ${autoReadyAt} ms; autoCapture=${JSON.stringify(autoCapture)}; afterOverlay=${JSON.stringify({ triggerVisible: resetState && resetState.triggerVisible, rows: resetState && resetState.qualityRows, status: resetState && resetState.status, panelHidden: resetState && resetState.panelHidden })}; overlayNow=${JSON.stringify(await readOverlayState(ytPage))}; pageNow=${JSON.stringify(await readPageState(ytPage))}; beforeOptions=${JSON.stringify(before.qualityRows.map((row) => row.label))}`
      }
    })

    // ------------------------------------------------------------------
    // R3: one plain progressive <video> site
    // ------------------------------------------------------------------
    await scenario('R3', 'Plain progressive video: capture, one-click queue, bytes match direct fetch', async () => {
      if (setupError) return blocked()
      if (!db) return blocked()
      if (!reference || !reference.sha256) {
        return { status: 'NOT-RUNNABLE', evidence: `the direct anonymous fetch failed: ${JSON.stringify(reference)}` }
      }
      const page = await createRealPage(browser, REAL_PROGRESSIVE_PAGE)
      // The demo video sits low on the w3schools page; a taller viewport keeps
      // it inside the real visibility rule instead of scrolling a fixed page.
      await browser.connection
        .send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 1400, deviceScaleFactor: 1, mobile: false }, page.sessionId)
        .catch(() => undefined)
      const settled = await settleRealPage(
        browser,
        page,
        (state) => /w3schools\.com\/html\/html5_video\.asp/.test(state.href),
        45000,
        'w3schools video page'
      )
      if (!settled.ok) {
        return { status: 'NOT-RUNNABLE', evidence: `the progressive page did not load: ${JSON.stringify(settled.state)}` }
      }
      const tabId = await waitForValue(
        () => tabIdForUrlFragment(browser, options.sessionId, 'w3schools.com/html/html5_video.asp'),
        (value) => typeof value === 'number',
        15000,
        'w3schools tab',
        100
      )
      await browser.connection.send('Target.activateTarget', { targetId: page.targetId })
      await enableOverlayForTab(browser, options.sessionId, 'https://www.w3schools.com', tabId)
      await pageEvaluate(
        page,
        `(() => {
          const video = document.querySelector('video')
          if (video) video.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
          return true
        })()`,
        { userGesture: false }
      )
      await sleep(800)
      const videoBox = await pageEvaluate(
        page,
        `(() => {
          const video = document.querySelector('video')
          if (!video) return null
          const rect = video.getBoundingClientRect()
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, width: rect.width, height: rect.height, top: rect.top, left: rect.left }
        })()`,
        { userGesture: false }
      )
      if (videoBox) {
        await browser.connection
          .send(
            'Input.dispatchMouseEvent',
            { type: 'mousePressed', x: Math.round(videoBox.x), y: Math.round(videoBox.y), button: 'left', clickCount: 1 },
            page.sessionId
          )
          .catch(() => undefined)
        await browser.connection
          .send(
            'Input.dispatchMouseEvent',
            { type: 'mouseReleased', x: Math.round(videoBox.x), y: Math.round(videoBox.y), button: 'left', clickCount: 1 },
            page.sessionId
          )
          .catch(() => undefined)
      }
      const playing = await pageEvaluate(
        page,
        `(async () => {
          const video = document.querySelector('video')
          if (!video) return { ok: false }
          video.muted = true
          video.loop = true
          let playResult = null
          try {
            await video.play()
            playResult = 'ok'
          } catch (error) {
            playResult = error && error.name ? error.name + ':' + error.message : String(error)
          }
          return { ok: true, src: video.currentSrc || (video.querySelector('source') && video.querySelector('source').src), playResult, paused: video.paused, readyState: video.readyState }
        })()`,
        { userGesture: true }
      )
      const capturedDeadline = Date.now() + 30000
      let captured = null
      let lastCapture = null
      while (Date.now() < capturedDeadline) {
        lastCapture = await queryCapturedSources(browser, options.sessionId, tabId).catch((error) => ({
          error: error instanceof Error ? error.message : String(error)
        }))
        if (
          lastCapture &&
          lastCapture.response &&
          Array.isArray(lastCapture.response.sources) &&
          lastCapture.response.sources.some(
            (source) => typeof source.url === 'string' && source.url.includes('mov_bbb.mp4')
          )
        ) {
          captured = lastCapture
          break
        }
        await sleep(250)
      }
      const videoState = await pageEvaluate(
        page,
        `(() => {
          const video = document.querySelector('video')
          if (!video) return { present: false }
          return {
            present: true,
            readyState: video.readyState,
            paused: video.paused,
            currentSrc: video.currentSrc,
            width: video.videoWidth,
            height: video.videoHeight,
            duration: video.duration
          }
        })()`,
        { userGesture: false }
      ).catch(() => null)
      if (!captured) {
        const diagnostic = await browser.connection.evaluate(
          options.sessionId,
          `new Promise((resolve) => chrome.scripting.executeScript({
            target: { tabId: ${tabId} },
            func: () => {
              const state = globalThis.__dondownloadOverlayRuntime
              const video = document.querySelector('video')
              const rect = video ? video.getBoundingClientRect() : null
              if (!state) return { runtime: false, video: video ? { paused: video.paused, readyState: video.readyState, src: video.currentSrc } : null }
              return {
                runtime: true,
                disabled: state.disabled,
                floatingEnabled: state.floatingEnabled,
                activeVideo: Boolean(state.activeVideo),
                activeEmbed: Boolean(state.activeEmbed),
                players: (state.capture && state.capture.players ? state.capture.players : []).map((player) => ({
                  hasVideo: Boolean(player.video),
                  sources: (player.sources || []).map((source) => source.url),
                  unsupported: player.unsupported ? player.unsupported.code : null,
                  playbackKind: player.playbackKind
                })),
                video: video ? {
                  paused: video.paused,
                  readyState: video.readyState,
                  currentSrc: video.currentSrc,
                  rect: rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : null
                } : null
              }
            }
          }, (results) => resolve({
            result: results && results[0] ? results[0].result : null,
            error: chrome.runtime.lastError && chrome.runtime.lastError.message
          })))`,
          { userGesture: false }
        ).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }))
        return {
          status: 'FAIL',
          evidence: `the progressive source was not captured. playing=${JSON.stringify(playing)}; tabId=${tabId}; video=${JSON.stringify(videoState)}; lastCapture=${JSON.stringify(lastCapture)}; overlay=${JSON.stringify(await readOverlayState(page))}; contentScriptState=${JSON.stringify(diagnostic)}; appLog=${JSON.stringify((app ? app.stderr() : '').slice(-1200))}`
        }
      }
      await openOverlayPanel(page)
      const click = await pageEvaluate(
        page,
        `(() => {
          const host = document.getElementById('dondownload-overlay-host')
          const shadow = host && host.shadowRoot
          if (!shadow) return { ok: false, error: 'no-overlay' }
          const rows = Array.from(shadow.querySelectorAll('.source-list .source'))
          const row = rows.find((entry) => String(entry.innerText || '').includes('mov_bbb.mp4'))
          if (!row) return { ok: false, error: 'no-row', rows: rows.map((entry) => String(entry.innerText || '')) }
          const button = row.querySelector('.source-action')
          if (!button) return { ok: false, error: 'no-button' }
          button.click()
          return { ok: true }
        })()`,
        { userGesture: true }
      )
      if (!click || click.ok !== true) {
        return { status: 'FAIL', evidence: `the captured row could not be clicked: ${JSON.stringify(click)}` }
      }
      const row = await watchDownloadRow(db, REAL_PROGRESSIVE_MP4, 120000)
      const filePath = row.file_path || (row.dir ? path.join(row.dir, row.filename) : null)
      const exists = Boolean(filePath && fs.existsSync(filePath))
      const hash = exists ? hashFile(filePath) : null
      const ok =
        row.status === 'complete' &&
        exists &&
        hash.sha256 === reference.sha256 &&
        hash.bytes === reference.bytes
      return {
        status: ok ? 'PASS' : 'FAIL',
        evidence: `captured=${JSON.stringify(captured.response.sources.filter((source) => source.url.includes('mov_bbb.mp4')))}; overlayClick=${JSON.stringify(click)}; appRow=${JSON.stringify({ id: row.id, url: row.url, status: row.status, filename: row.filename, total: row.total_bytes, completed: row.completed_bytes })}; file=${filePath} (${hash ? hash.bytes : 0}B); sha256=${hash ? hash.sha256 : null} expected=${reference.sha256} directStatus=${reference.status} directBytes=${reference.bytes}`
      }
    })

    // ------------------------------------------------------------------
    // R4: cross-origin embed
    // ------------------------------------------------------------------
    await scenario('R4', 'Cross-origin YouTube embed: "Find qualities for embedded video" yields options', async () => {
      if (setupError) return blocked()
      const page = await createRealPage(browser, `${server.origin}/embed`)
      const tabId = await waitForValue(
        () => tabIdForUrlFragment(browser, options.sessionId, `${server.origin}/embed`),
        (value) => typeof value === 'number',
        15000,
        'embed fixture tab',
        100
      )
      await browser.connection.send('Target.activateTarget', { targetId: page.targetId })
      await enableOverlayForTab(browser, options.sessionId, server.origin, tabId)
      await sleep(1000)
      // A real pointer move over the iframe rectangle is the same path a user
      // takes; the fallback uses the extension's keyboard-command entry point.
      await browser.connection
        .send(
          'Input.dispatchMouseEvent',
          { type: 'mouseMoved', x: 12, y: 12, button: 'none' },
          page.sessionId
        )
        .catch(() => undefined)
      let embedState = await waitForValue(
        () => readOverlayState(page),
        (state) => state.triggerVisible === true && state.embedHidden === false,
        8000,
        'embedded player overlay',
        200
      ).catch(() => null)
      if (!embedState) {
        await browser.connection.evaluate(
          options.sessionId,
          `new Promise((resolve) => chrome.tabs.sendMessage(${tabId}, { type: 'dondownload:overlay-toggle' }, (value) => resolve({
            response: value,
            error: chrome.runtime.lastError && chrome.runtime.lastError.message
          })))`,
          { userGesture: true }
        )
        await sleep(500)
        embedState = await waitForValue(
          () => readOverlayState(page),
          (state) => state.triggerVisible === true && state.embedHidden === false,
          8000,
          'embedded player overlay after toggle',
          200
        ).catch(() => null)
      }
      if (!embedState) {
        return {
          status: 'FAIL',
          evidence: `the embedded player was not offered. overlay=${JSON.stringify(await readOverlayState(page))}`
        }
      }
      await openOverlayPanel(page)
      const before = await readOverlayState(page)
      const embedStartedAt = Date.now()
      const clicked = await pageEvaluate(
        page,
        `(() => {
          const host = document.getElementById('dondownload-overlay-host')
          const shadow = host && host.shadowRoot
          const button = shadow && shadow.querySelector('.embed-analyze')
          if (!button || button.hidden) return { ok: false, hidden: button ? button.hidden : null }
          button.click()
          return { ok: true, text: button.textContent }
        })()`,
        { userGesture: true }
      )
      if (!clicked || clicked.ok !== true) {
        return { status: 'FAIL', evidence: `the embedded qualities button was missing: ${JSON.stringify(clicked)}; overlay=${JSON.stringify(before)}` }
      }
      const ready = await waitForValue(
        () => readOverlayState(page),
        (state) => Array.isArray(state.qualityRows) && state.qualityRows.some((row) => typeof row.height === 'number'),
        90000,
        'embedded quality options',
        250
      ).catch(() => null)
      if (!ready) {
        return {
          status: 'FAIL',
          evidence: `embedded analysis produced no options. button=${JSON.stringify(clicked)}; overlay=${JSON.stringify(await readOverlayState(page))}; appLog=${JSON.stringify((app ? app.stderr() : '').slice(-2500))}`
        }
      }
      recordTiming('R4 embed options', Date.now() - embedStartedAt, `${ready.qualityRows.length} rows`)
      return {
        status: 'PASS',
        evidence: `button="${clicked.text}"; embedSelection=${JSON.stringify({ hidden: before.embedHidden })}; rows=${JSON.stringify(ready.qualityRows)}; status="${ready.status}"`
      }
    })
  } finally {
    try {
      if (db) db.close()
    } catch {
      // ignore
    }
    try {
      if (nativeRun.app) {
        killTree(nativeRun.app.proc.pid)
        nativeRun.app = null
      }
    } catch {
      // ignore
    }
    try {
      await browser.close()
    } catch {
      // ignore
    }
    try {
      await server.close()
    } catch {
      // ignore
    }
    try {
      finalizeNativeCleanup()
    } catch (error) {
      console.error(
        `[real-sites] registry cleanup verification failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }
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
      record('0', `${BROWSER_NAME} available`, 'FAIL', `not found: ${CHROME}`)
      return
    }
    if (!fs.existsSync(FFMPEG)) {
      record('0', 'FFmpeg available', 'FAIL', `not found: ${FFMPEG}`)
      return
    }

    if (REAL_SITES) {
      if (!NATIVE_MODE) {
        record(
          '0',
          'Real-site mode needs the isolated app',
          'FAIL',
          '--real-sites requires --native: verified qualities and one-click downloads are produced by yt-dlp in the isolated desktop app.'
        )
        return
      }
      await runRealSites({ tempRoot, downloadsDir })
      return
    }

    const clipPath = path.join(mediaDir, 'clip.mp4')
    const clip720Path = path.join(mediaDir, 'clip-720.mp4')
    const clipBytes = await generateClip(FFMPEG, clipPath, { width: 640, height: 360 })
    const clip720Bytes = await generateClip(FFMPEG, clip720Path, { width: 1280, height: 720 })
    const clip = fs.readFileSync(clipPath)
    const clip720 = fs.readFileSync(clip720Path)
    const hlsRoot = path.join(mediaDir, 'hls')
    await generateHls(FFMPEG, clipPath, path.join(hlsRoot, 'low'))
    await generateHls(FFMPEG, clip720Path, path.join(hlsRoot, 'high'))
    fs.writeFileSync(
      path.join(hlsRoot, 'master.m3u8'),
      [
        '#EXTM3U',
        '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360',
        'low/index.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720',
        'high/index.m3u8',
        ''
      ].join('\n'),
      'utf8'
    )
    const audioPath = path.join(mediaDir, 'tone.mp3')
    await generateAudio(FFMPEG, audioPath)
    const audio = fs.readFileSync(audioPath)
    server = await startFixtureServer({ clip, clip720, hlsRoot, audio })
    const { origin, nativeOrigin } = server
    const originPattern = `${origin}/*`
    const nativeOriginPattern =
      nativeOrigin === null ? null : `${nativeOrigin}/*`
    record(
      '0',
      'Fixtures ready (local HTTP + generated MP4 + 2 MiB attachment)',
      'PASS',
      `origin=${origin}; nativeFixtureOrigin=${nativeOrigin ?? '<unavailable>'}; browser=${BROWSER_NAME} (${CHROME}); clip.mp4=${clipBytes}B; clip-720.mp4=${clip720Bytes}B; file.bin=${server.fileBin.length}B sha256=${server.fileBinSha256}; handoff.bin=${server.fileBin.length}B (slow); secure.bin=${server.secureBinBytes}B sha256=${server.secureBinSha256} (cookie-only)`
    )

    // ------------------------------------------------------------------
    // Phase A: the real, unmodified extension code from ./extension. Only the
    // pinned manifest key is dropped, so this browser cannot reach the user's
    // real app through the fixed extension ID.
    // ------------------------------------------------------------------
    const realCopyDir = path.join(tempRoot, 'extension-real')
    copyIsolatedExtension(realCopyDir)
    browserA = await launchChromium({
      userDataDir: path.join(tempRoot, 'profile-real'),
      extensionPath: realCopyDir,
      label: 'real'
    })
    const workerA = await ensureExtensionLoaded(browserA, realCopyDir, 'real')
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
      // The real request must come from an active extension page with a CDP
      // user gesture. The tab is activated explicitly; without a browser UI the
      // headless build still cannot present the extension permission bubble.
      await browserA.connection
        .send('Target.activateTarget', { targetId: optionsA.targetId })
        .catch(() => undefined)
      await browserA.connection.send('Page.bringToFront', {}, optionsA.sessionId).catch(() => undefined)
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
          evidence:
            `chrome.permissions.request never called back in 6 s (headless ${BROWSER_NAME} has no extension permission bubble), so nothing was granted. ` +
            `before=${JSON.stringify(before)}; after=${JSON.stringify(after)}; requested=${originPattern}; ` +
            'attempts tried: (1) scanned chrome.dll for a permission/auto-confirm/accept switch: none exists — the only auto-accept switches are --auto-accept-camera-and-microphone-capture, --auto-accept-this-tab-capture and --auto-accept-browser-signin-for-tests, and ExtensionInstallPrompt::AutoConfirmPromptIfEnabled is an in-process browser-test hook with no command line; ' +
            '(2) real unmodified extension with an activated options tab and CDP userGesture, also with --enable-automation and with --silent-debugger-extension-api: callback never fires in either build; ' +
            '(3) CDP-only grant: the Extensions domain (--enable-unsafe-extension-debugging) exposes loadUnpacked/uninstall/getExtensions/storage only and Browser.grantPermissions covers web permissions, not optional extension host permissions'
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
    const harnessManifest = copyIsolatedExtension(harnessDir)
    harnessManifest.permissions = [...new Set([...(harnessManifest.permissions || []), 'downloads', 'webRequest', 'cookies'])]
    harnessManifest.host_permissions =
      nativeOriginPattern === null
        ? [originPattern]
        : [
            originPattern,
            nativeOriginPattern,
            // Chromium's cookies.getAll host-permission check does not match a
            // port-bearing match pattern in the harness build; the real
            // production grants are port-less public origins. The port-less
            // fixture pattern keeps the cookie API test faithful.
            `http://${new URL(nativeOrigin).hostname}/*`
          ]
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
    const workerB = await ensureExtensionLoaded(browserB, harnessDir, 'harness')
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
          : [
              originPattern,
              nativeOriginPattern,
              `http://${new URL(nativeOrigin).hostname}/*`
            ]
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

    await scenario('3c', 'HLS master is sniffed as one entry with pickable variants and badge count', async () => {
      const page = await createPage(browserB, `${origin}/hls`)
      page.browser = browserB
      let hlsTab = null
      try {
        hlsTab = await waitForValue(
          () => tabIdForUrl(browserB, optionsB.sessionId, `${origin}/hls`),
          (value) => value !== null,
          10000,
          'HLS fixture tab'
        )
      } catch (error) {
        const tabs = await browserB.connection.evaluate(
          optionsB.sessionId,
          'new Promise((resolve) => chrome.tabs.query({}, (value) => resolve(value.map((tab) => ({ id: tab.id, url: tab.url, active: tab.active })))))',
          { userGesture: false }
        )
        throw new Error(`${error.message}; tabs=${JSON.stringify(tabs)}`, {
          cause: error
        })
      }
      const tab = hlsTab
      await browserB.connection.send('Target.activateTarget', { targetId: page.targetId })
      const enable = await enableOverlayForTab(browserB, optionsB.sessionId, origin, tab)
      // The page's first HLS fetches happened before the tab was opted in.
      // Reload with the grant already in place so the sniffer observes them.
      await browserB.connection.send('Page.reload', {}, page.sessionId)
      await sleep(400)
      const media = await waitForSniffed(
        browserB,
        optionsB.sessionId,
        tab,
        (list) =>
          list.some(
            (entry) =>
              entry.kind === 'hls' &&
              Array.isArray(entry.variants) &&
              entry.variants.length >= 2
          )
      )
      const hls = media.find((entry) => entry.kind === 'hls')
      const segmentsHidden = !media.some(
        (entry) =>
          /\.(?:ts|m4s)(?:\?|$)/i.test(entry.url) ||
          /index\.m3u8(?:\?|$)/i.test(entry.url)
      )
      const badge = await badgeText(browserB, optionsB.sessionId, tab)
      const host = await waitForOverlayHost(page)
      await pageEvaluate(
        page,
        `(() => {
          const host = document.getElementById('dondownload-overlay-host')
          const trigger = host && host.shadowRoot && host.shadowRoot.querySelector('.trigger')
          if (!trigger) return false
          trigger.hidden = false
          trigger.click()
          return true
        })()`,
        { userGesture: true }
      )
      let panelText = ''
      try {
        panelText = await waitForValue(
          () =>
            pageEvaluate(
              page,
              `(() => {
                const host = document.getElementById('dondownload-overlay-host')
                const panel = host && host.shadowRoot && host.shadowRoot.querySelector('.panel')
                return panel && !panel.hidden ? panel.textContent || '' : ''
              })()`,
              { userGesture: false }
            ),
          (text) => typeof text === 'string' && text.includes('Detected media on this tab') && text.includes('720p'),
          10000,
          'overlay sniffed HLS rows'
        )
      } catch {
        panelText = ''
      }
      const ok =
        enable &&
        enable.response &&
        enable.response.ok === true &&
        Boolean(hls) &&
        segmentsHidden &&
        /^[1-9]/.test(String(badge || '')) &&
        host.host &&
        panelText.includes('720p')
      await browserB.connection
        .send('Target.closeTarget', { targetId: page.targetId })
        .catch(() => undefined)
      return {
        status: ok ? 'PASS' : 'FAIL',
        evidence: `enable=${JSON.stringify(enable && enable.response)}; media=${JSON.stringify(media.map((entry) => ({ url: entry.url, kind: entry.kind, variants: entry.variants, size: entry.sizeBytes })))}; segmentsHidden=${segmentsHidden}; badge=${JSON.stringify(badge)}; overlay=${JSON.stringify(host)}; panelText=${JSON.stringify(panelText.slice(0, 900))}`
      }
    })

    await scenario('3d', 'Referer-protected hidden MP4 is detected without listing unrelated rows', async () => {
      const page = await createPage(browserB, `${origin}/referer-hidden`)
      page.browser = browserB
      const tab = await waitForValue(
        () => tabIdForUrl(browserB, optionsB.sessionId, `${origin}/referer-hidden`),
        (value) => value !== null,
        10000,
        'referer fixture tab'
      )
      await browserB.connection.send('Target.activateTarget', { targetId: page.targetId })
      await enableOverlayForTab(browserB, optionsB.sessionId, origin, tab)
      await browserB.connection.send('Page.reload', {}, page.sessionId)
      await sleep(400)
      let media = []
      try {
        media = await waitForSniffed(
          browserB,
          optionsB.sessionId,
          tab,
          (list) => list.some((entry) => /\/hidden-referer\.mp4$/.test(entry.url))
        )
      } catch {
        media = []
      }
      const entry = media.find((candidate) => /\/hidden-referer\.mp4$/.test(candidate.url))
      const logHits = server.log.filter((row) => row.path === '/hidden-referer.mp4')
      await browserB.connection
        .send('Target.closeTarget', { targetId: page.targetId })
        .catch(() => undefined)
      return {
        status:
          entry &&
          entry.kind === 'file' &&
          entry.sizeBytes === server.hiddenRefererBytes &&
          logHits.length > 0
            ? 'PASS'
            : 'FAIL',
        evidence: `media=${JSON.stringify(media)}; entry=${JSON.stringify(entry)}; serverHits=${JSON.stringify(logHits)}; clipBytes=${server.hiddenRefererBytes}`
      }
    })

    await scenario('3e', 'MP3 audio is detected above the small-file threshold', async () => {
      const page = await createPage(browserB, `${origin}/audio`)
      page.browser = browserB
      const tab = await waitForValue(
        () => tabIdForUrl(browserB, optionsB.sessionId, `${origin}/audio`),
        (value) => value !== null,
        10000,
        'audio fixture tab'
      )
      await browserB.connection.send('Target.activateTarget', { targetId: page.targetId })
      await enableOverlayForTab(browserB, optionsB.sessionId, origin, tab)
      await browserB.connection.send('Page.reload', {}, page.sessionId)
      await sleep(400)
      const media = await waitForSniffed(
        browserB,
        optionsB.sessionId,
        tab,
        (list) => list.some((entry) => /\/tone\.mp3$/.test(entry.url))
      )
      const entry = media.find((candidate) => /\/tone\.mp3$/.test(candidate.url))
      await browserB.connection
        .send('Target.closeTarget', { targetId: page.targetId })
        .catch(() => undefined)
      return {
        status:
          entry &&
          entry.kind === 'file' &&
          entry.sizeBytes === server.audioBytes &&
          entry.audioOnly === true
            ? 'PASS'
            : 'FAIL',
        evidence: `media=${JSON.stringify(media)}; audioBytes=${server.audioBytes}; sha256=${server.audioSha256}`
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
      const downloadPage = await createPage(browserB, `${origin}/file.bin`, { waitForCommit: false })
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
        registerChromiumHost(manifestPath)
        // Chromium-branded builds read HKCU\Software\Chromium. Helium is built
        // from Chromium but may resolve a different registry root; probe the
        // temporary key before spending time on the isolated app. An unsupported
        // operation still proves the host process was launched (the manifest and
        // executable were found), while a missing key fails with
        // "Specified native messaging host not found".
        if (BROWSER_NAME === 'Helium') {
          const probe = await browserB.connection.evaluate(
            optionsB.sessionId,
            `Promise.race([
              new Promise((resolve) => chrome.runtime.sendNativeMessage(${JSON.stringify(NATIVE_HOST_NAME)}, { type: 'helium-registry-probe' }, (response) => resolve({
                response: response || null,
                error: chrome.runtime.lastError && chrome.runtime.lastError.message
              }))),
              new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 8000))
            ])`,
            { userGesture: false }
          )
          nativeRun.heliumProbe = probe
          const probeCode =
            probe && probe.response && probe.response.error && probe.response.error.code
          if (probeCode !== 'UNSUPPORTED_OPERATION') {
            nativeRun.notRunnable = true
            throw new Error(
              `Helium did not resolve the temporary ${CHROMIUM_REG_KEY} registration, so its native-messaging scenarios cannot run against a key this harness may write. probe=${JSON.stringify(probe)}; key=${CHROMIUM_REG_KEY}; the real ${HELIUM_REG_KEY} key is not written.`
            )
          }
        }
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
          () => tabIdForUrl(browserB, optionsB.sessionId, `${nativeOrigin}/`),
          (value) => typeof value === 'number',
          15000,
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
        nativeRun.tabId = nativeTab
        record(
          'N0',
          'Isolated dev app and temporary Chromium registration ready',
          'PASS',
          `extensionId=${workerB.id}; browser=${BROWSER_NAME}; allowed_origins=${JSON.stringify(manifest.allowed_origins)}; host=${host.exe} (tempBuild=${host.built}); manifest=${manifestPath}; key=${CHROMIUM_REG_KEY}; heliumProbe=${JSON.stringify(nativeRun.heliumProbe)}; userData=${userDataDir}; downloadDir=${nativeRun.downloadDir}; state=${statePath}; nativeFixtureOrigin=${nativeOrigin} (${server.nativeHost.hostname} -> ${server.nativeHost.address}); overlayEnable=${JSON.stringify(nativeEnable)}; overlay=${JSON.stringify(nativeOverlay)}; heliumBefore=${JSON.stringify(nativeRun.heliumBefore)}; appLog=${JSON.stringify(nativeRun.appStderr().slice(-1200))}`
        )
      } catch (error) {
        setupError = error
        record(
          'N0',
          'Isolated dev app and temporary Chromium registration ready',
          nativeRun.notRunnable ? 'NOT-RUNNABLE' : 'FAIL',
          error instanceof Error ? error.message : String(error)
        )
      }

      const blocked = () => ({
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
        const appSawIt = /Durable hand-off preflight rejected \(HANDOFF_NEEDS_LOGIN\)/.test(appLog)
        const ok =
          !probe.error &&
          probe.response &&
          probe.response.ok === false &&
          code === 'HANDOFF_NEEDS_LOGIN' &&
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
              if (text && text.indexOf('Added to DonDownload') === 0) {
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

        const downloadPage = await createPage(browserB, handoffUrl, { waitForCommit: false })
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

      await scenario('N4', 'Browser login hand-off: cookies for the download URL are used and the browser copy is cancelled', async () => {
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
        // The browser has the session cookie. Takeover reads the cookies for
        // exactly this download URL without a per-site opt-in, so the app's
        // preflight uses the same login and the file is taken over.
        await browserB.connection.evaluate(
          optionsB.sessionId,
          `(async () => {
            const base = { url: ${JSON.stringify(`${nativeOrigin}/`)}, path: '/', expirationDate: Math.floor(Date.now() / 1000) + 3600 }
            await chrome.cookies.set({ ...base, name: 'auth', value: '1' })
            return 'auth=1'
          })()`,
          { userGesture: false }
        )
        const cookie = 'auth=1'
        const secureUrl = `${nativeOrigin}/secure.bin`
        const logStart = server.log.length
        const stderrBefore = nativeRun.appStderr().length
        const beforeRowIds = new Set(readDownloadRows(nativeRun.db).map((entry) => entry.id))
        const downloadPage = await createPage(browserB, secureUrl, { waitForCommit: false })
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
        const rowFound = await waitForValue(
          () =>
            readDownloadRows(nativeRun.db).find(
              (entry) => !beforeRowIds.has(entry.id) && entry.url === secureUrl
            ) || null,
          (match) => match !== null,
          20000,
          'durable app row for secure.bin',
          10
        ).catch(() => null)
        if (rowFound === null) {
          const debugHits = server.log.slice(logStart)
          const debugState = await readStorage(
            browserB,
            optionsB.sessionId,
            'session',
            HANDOFF_STATE_KEY
          )
          return {
            status: 'FAIL',
            evidence: `no app row; cookie=${JSON.stringify(cookie)}; server hits=${JSON.stringify(debugHits)}; handoff state=${JSON.stringify(debugState)}; app log=${JSON.stringify(nativeRun.appStderr().slice(-2000))}`
          }
        }
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
          'browser download terminal state for secure.bin',
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
          rowFound.url,
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
        const newAppLog = nativeRun.appStderr().slice(stderrBefore)
        const authenticatedPreflight = server.log
          .slice(logStart)
          .filter(
            (entry) =>
              entry.path === '/secure.bin' &&
              typeof entry.cookie === 'string' &&
              /auth=1/.test(entry.cookie) &&
              typeof entry.range === 'string' &&
              entry.range.startsWith('bytes=0-0')
          )
        const files = filesInDirectory(browserDownloadDir)
        const finalBrowserFile = files.includes('secure.bin')
        const hashOk = completed.hash.sha256 === server.secureBinSha256
        const cancelled =
          terminal.state === 'interrupted' &&
          /cancel/i.test(terminal.error || '')
        const acceptedBeforeCancel =
          completed.row.created_at <=
            (terminalEvent ? terminalEvent.at : terminalObservedAt) &&
          dbObservedAt <= terminalObservedAt
        const ok =
          setting.automaticFileHandoff === true &&
          completed.row.status === 'complete' &&
          hashOk &&
          completed.filePath !== null &&
          cancelled &&
          !finalBrowserFile &&
          acceptedBeforeCancel &&
          authenticatedPreflight.length > 0 &&
          Array.isArray(processed) &&
          processed.includes(itemId) &&
          Array.isArray(pending) &&
          pending.length === 0
        return {
          status: ok ? 'PASS' : 'FAIL',
          evidence: `setting=${JSON.stringify({ automaticFileHandoff: setting.automaticFileHandoff })}; cookie=${JSON.stringify(cookie)}; browser item=${JSON.stringify({ id: itemId, state: terminal.state, error: terminal.error, totalBytes: terminal.totalBytes, bytesReceived: terminal.bytesReceived })}; app row=${JSON.stringify({ id: rowFound.id, url: completed.row.url, filename: completed.row.filename, created_at: completed.row.created_at, status: completed.row.status, total: completed.row.total_bytes })}; accepted before cancel=${acceptedBeforeCancel}; app file=${completed.filePath} (${completed.hash.bytes}B) sha256=${completed.hash.sha256} expected=${server.secureBinSha256} match=${hashOk}; authenticated preflights=${JSON.stringify(authenticatedPreflight)}; browser download dir files=${JSON.stringify(files)}; final browser file present=${finalBrowserFile}; app log=${JSON.stringify(newAppLog.slice(-1200))}; handoff processed=${JSON.stringify(processed)} pending=${JSON.stringify(pending)}`
        }
      })

      await scenario('N4b', 'Hand-off refusal: a login wall without cookies stays in the browser', async () => {
        if (setupError) return blocked()
        const setting = await ensureHandoffEnabled(browserB, optionsB.sessionId)
        const browserDownloadDir = path.join(tempRoot, 'downloads-refused-anonymous')
        fs.mkdirSync(browserDownloadDir, { recursive: true })
        await installDownloadEventLog(browserB, optionsB.sessionId)
        await browserB.connection.send('Browser.setDownloadBehavior', {
          behavior: 'allow',
          downloadPath: browserDownloadDir,
          eventsEnabled: true
        })
        // The browser has the session cookie but the extension cannot read it
        // (no cookies grant), so the app's preflight is anonymous and must
        // reject this target while the browser download keeps running.
        await browserB.connection.evaluate(
          optionsB.sessionId,
          `(async () => {
            const base = { url: ${JSON.stringify(`${nativeOrigin}/`)}, path: '/', expirationDate: Math.floor(Date.now() / 1000) + 3600 }
            await chrome.cookies.set({ ...base, name: 'auth', value: '1' })
            return 'auth=1'
          })()`,
          { userGesture: false }
        )
        const cookie = 'auth=1'
        await browserB.connection.evaluate(
          optionsB.sessionId,
          `new Promise((resolve) => chrome.permissions.remove({ permissions: ['cookies'] }, () => resolve(chrome.runtime.lastError && chrome.runtime.lastError.message)))`,
          { userGesture: true }
        )
        const secureUrl = `${nativeOrigin}/secure.bin`
        const stderrBefore = nativeRun.appStderr().length
        const downloadPage = await createPage(browserB, secureUrl, { waitForCommit: false })
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
          /Durable hand-off preflight rejected \(HANDOFF_NEEDS_LOGIN\)/.test(
            newAppLog
          )
        const needsLoginStored = await readStorage(
          browserB,
          optionsB.sessionId,
          'session',
          NEEDS_LOGIN_STATE_KEY
        )
        const needsLoginState =
          needsLoginStored && needsLoginStored[NEEDS_LOGIN_STATE_KEY]
        const expectedHost = new URL(nativeOrigin).host
        const popupView = await browserB.connection.evaluate(
          optionsB.sessionId,
          `(async () => {
            const module = await import(chrome.runtime.getURL('capture-settings.js'))
            const state = await module.readNeedsLoginState(chrome)
            return { state, copy: state ? module.needsLoginCopy(state.host) : null }
          })()`,
          { userGesture: false }
        )
        const badge = await browserB.connection.evaluate(
          optionsB.sessionId,
          'new Promise((resolve) => chrome.action.getBadgeText({}, (value) => resolve(value)))',
          { userGesture: false }
        )
        const loginStateOk =
          needsLoginState &&
          needsLoginState.origin === nativeOrigin &&
          needsLoginState.host === expectedHost
        const popupOk =
          popupView &&
          popupView.state &&
          popupView.copy &&
          popupView.copy.message.includes(expectedHost) &&
          popupView.copy.button.includes(expectedHost)
        const hashOk = hash.sha256 === server.secureBinSha256
        const ok =
          setting.automaticFileHandoff === true &&
          complete.state === 'complete' &&
          hashOk &&
          anonymousPreflight.length > 0 &&
          authenticatedBrowser.length > 0 &&
          preflightRejected &&
          loginStateOk &&
          popupOk &&
          appRow === null &&
          !appFiles.includes('secure.bin') &&
          Array.isArray(processed) &&
          processed.includes(itemId) &&
          Array.isArray(pending) &&
          pending.length === 0
        return {
          status: ok ? 'PASS' : 'FAIL',
          evidence: `cookie=${JSON.stringify(cookie)}; browser item=${JSON.stringify({ id: itemId, state: complete.state, totalBytes: complete.totalBytes, bytesReceived: complete.bytesReceived, filename: complete.filename })}; file (${hash.bytes}B) sha256=${hash.sha256} expected=${server.secureBinSha256} match=${hashOk}; secure requests=${JSON.stringify(secureHits)}; anonymous range probes=${JSON.stringify(anonymousPreflight)}; authenticated browser requests=${authenticatedBrowser.length}; app preflight rejection logged=${preflightRejected}; needsLogin=${JSON.stringify(needsLoginState)} expectedHost=${expectedHost}; popup=${JSON.stringify(popupView)}; badge=${JSON.stringify(badge)}; app log=${JSON.stringify(newAppLog.slice(-1200))}; app row=${JSON.stringify(appRow)}; app files=${JSON.stringify(appFiles)}; handoff processed=${JSON.stringify(processed)} pending=${JSON.stringify(pending)}`
        }
      })

      await scenario('N8', 'Opted-in login hand-off downloads through the app and cancels only after acceptance', async () => {
        if (setupError) return blocked()
        const setting = await ensureHandoffEnabled(browserB, optionsB.sessionId)
        await enableCookieOptInForOrigin(
          browserB,
          optionsB.sessionId,
          nativeOrigin
        )
        // The browser has the session. Set it through the cookies API so the
        // extension reads a real browser store rather than page DOM state.
        const cookie = await browserB.connection.evaluate(
          optionsB.sessionId,
          `(async () => {
            const base = { url: ${JSON.stringify(`${nativeOrigin}/`)}, path: '/', expirationDate: Math.floor(Date.now() / 1000) + 3600 }
            await chrome.cookies.set({ ...base, name: 'auth', value: '1' })
            await chrome.cookies.set({ ...base, name: 'ddsecret', value: 'supersecretvalue' })
            return 'auth=1; ddsecret=supersecretvalue'
          })()`,
          { userGesture: false }
        )
        const browserDownloadDir = path.join(tempRoot, 'downloads-auth')
        fs.mkdirSync(browserDownloadDir, { recursive: true })
        await installDownloadEventLog(browserB, optionsB.sessionId)
        await browserB.connection.send('Browser.setDownloadBehavior', {
          behavior: 'allow',
          downloadPath: browserDownloadDir,
          eventsEnabled: true
        })
        const secureUrl = `${nativeOrigin}/short/secure.bin`
        const cookieProbe = await browserB.connection.evaluate(
          optionsB.sessionId,
          `(async () => {
            const module = await import(chrome.runtime.getURL('capture-settings.js'))
            return {
              header: await module.readCookieHeaderForOrigins(chrome, ${JSON.stringify(`${nativeOrigin}/secure.bin`)}, [${JSON.stringify(nativeOrigin)}]),
              cookiesPermission: await chrome.permissions.contains({ permissions: ['cookies'] })
            }
          })()`,
          { userGesture: false }
        )
        const logStart = server.log.length
        const beforeItems = await searchDownloads(browserB, optionsB.sessionId)
        const beforeItemIds = new Set(beforeItems.map((entry) => entry.id))
        const beforeRowIds = new Set(readDownloadRows(nativeRun.db).map((entry) => entry.id))
        const downloadPage = await createPage(browserB, secureUrl, {
          waitForCommit: false
        })
        downloadPage.browser = browserB
        const item = await waitForValue(
          async () => {
            const items = await searchDownloads(browserB, optionsB.sessionId)
            return (
              items.find(
                (candidate) =>
                  !beforeItemIds.has(candidate.id) &&
                  /\/secure\.bin(?:[?#]|$)/.test(
                    `${candidate.url || ''} ${candidate.finalUrl || ''}`
                  )
              ) || null
            )
          },
          (match) => match !== null,
          20000,
          'browser download item for the authenticated secure.bin',
          50
        )
        const itemId = item.id
        const rowFound = await waitForValue(
          () =>
            readDownloadRows(nativeRun.db).find(
              (entry) =>
                !beforeRowIds.has(entry.id) &&
                /\/secure\.bin(?:[?#]|$)/.test(entry.url)
            ) || null,
          (match) => match !== null,
          20000,
          'durable app row for the authenticated secure.bin',
          10
        ).catch(() => null)
        if (rowFound === null) {
          const debugHits = server.log.slice(logStart)
          const debugState = await readStorage(
            browserB,
            optionsB.sessionId,
            'session',
            HANDOFF_STATE_KEY
          )
          return {
            status: 'FAIL',
            evidence: `no app row; cookie=${JSON.stringify(cookie)}; cookieProbe=${JSON.stringify(cookieProbe)}; server hits=${JSON.stringify(debugHits)}; handoff state=${JSON.stringify(debugState)}; app log=${JSON.stringify(nativeRun.appStderr().slice(-2000))}; settings=${JSON.stringify(await readStorage(browserB, optionsB.sessionId, 'local', CAPTURE_SETTINGS_KEY))}`
          }
        }
        const dbObservedAt = Date.now()
        const terminal = await waitForValue(
          async () => {
            const items = await searchDownloads(browserB, optionsB.sessionId)
            return (
              items.find(
                (candidate) =>
                  candidate.id === itemId &&
                  (candidate.state === 'interrupted' ||
                    candidate.state === 'complete')
              ) || null
            )
          },
          (match) => match !== null,
          25000,
          'browser download terminal state for the authenticated secure.bin',
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
          rowFound.url,
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
        const newAppLog = nativeRun.appStderr()
        const authenticatedPreflight = server.log
          .slice(logStart)
          .filter(
            (entry) =>
              entry.path === '/secure.bin' &&
              typeof entry.cookie === 'string' &&
              /auth=1/.test(entry.cookie) &&
              typeof entry.range === 'string' &&
              entry.range.startsWith('bytes=0-0')
          )
        const browserRequests = server.log
          .slice(logStart)
          .filter(
            (entry) =>
              entry.path === '/secure.bin' &&
              typeof entry.cookie === 'string' &&
              /auth=1/.test(entry.cookie)
          )
        let persistedText = ''
        for (const name of ['downloads.sqlite3', 'downloads.sqlite3-wal']) {
          try {
            persistedText += fs
              .readFileSync(path.join(nativeRun.userDataDir, name))
              .toString('latin1')
          } catch {
            // WAL may already be checkpointed.
          }
        }
        const cookieLeaked =
          newAppLog.includes('supersecretvalue') ||
          persistedText.includes('supersecretvalue')
        const hashOk = completed.hash.sha256 === server.secureBinSha256
        const cancelled =
          terminal.state === 'interrupted' &&
          /cancel/i.test(terminal.error || '')
        const acceptedBeforeCancel =
          completed.row.created_at <=
            (terminalEvent ? terminalEvent.at : terminalObservedAt) &&
          dbObservedAt <= terminalObservedAt
        const ok =
          setting.automaticFileHandoff === true &&
          rowFound.url.endsWith('/secure.bin') &&
          completed.row.status === 'complete' &&
          hashOk &&
          completed.filePath !== null &&
          cancelled &&
          acceptedBeforeCancel &&
          authenticatedPreflight.length > 0 &&
          browserRequests.length > 0 &&
          !cookieLeaked &&
          Array.isArray(processed) &&
          processed.includes(itemId) &&
          Array.isArray(pending) &&
          pending.length === 0
        const evidence = `setting=${JSON.stringify({ automaticFileHandoff: setting.automaticFileHandoff })}; cookieProbe=${JSON.stringify(cookieProbe)}; cookie=${JSON.stringify(cookie)}; browser item=${JSON.stringify({ id: itemId, state: terminal.state, error: terminal.error, totalBytes: terminal.totalBytes, bytesReceived: terminal.bytesReceived })}; state events=${JSON.stringify(stateEvents)}; app row=${JSON.stringify({ id: rowFound.id, url: completed.row.url, filename: completed.row.filename, created_at: completed.row.created_at, status: completed.row.status, total: completed.row.total_bytes })}; db observed at=${dbObservedAt}; terminal observed at=${terminalObservedAt}; accepted before cancel=${acceptedBeforeCancel}; app file=${completed.filePath} (${completed.hash.bytes}B) sha256=${completed.hash.sha256} expected=${server.secureBinSha256} match=${hashOk}; authenticated preflights=${JSON.stringify(authenticatedPreflight)}; cookie-bearing secure requests=${browserRequests.length}; cookie leaked to log/db=${cookieLeaked}; app log=${JSON.stringify(newAppLog.slice(-1200))}; handoff processed=${JSON.stringify(processed)} pending=${JSON.stringify(pending)}`
        return {
          status: ok ? 'PASS' : 'FAIL',
          evidence
        }
      })

      await scenario('K1', 'KVS icon appears before play and one-click 720p downloads through the app', async () => {
        if (setupError) return blocked()
        const page = nativeRun.page
        const tab = nativeRun.tabId
        await browserB.connection.send('Target.activateTarget', { targetId: page.targetId })
        await navigatePage(page, `${nativeOrigin}/kvs`)
        const readyAt = Date.now()
        const overlay = await waitForValue(
          () =>
            pageEvaluate(
              page,
              `(() => {
                const host = document.getElementById('dondownload-overlay-host')
                const shadow = host && host.shadowRoot
                const trigger = shadow && shadow.querySelector('.trigger')
                return { host: Boolean(host), trigger: Boolean(trigger), hidden: trigger ? trigger.hidden : null }
              })()`,
              { userGesture: false }
            ),
          (state) => state && state.host && state.trigger && state.hidden === false,
          1000,
          'KVS floating icon before play',
          25
        )
        const iconMs = Date.now() - readyAt
        const sources = await waitForCapturedSources(
          browserB,
          optionsB.sessionId,
          tab,
          (list) =>
            list.some((entry) => entry.qualityLabel === '480p') &&
            list.some((entry) => entry.qualityLabel === '720p')
        )
        const primary = sources.find((entry) => entry.qualityLabel === '480p')
        const alt = sources.find((entry) => entry.qualityLabel === '720p')
        const panel = await pageEvaluate(
          page,
          `(() => {
            const host = document.getElementById('dondownload-overlay-host')
            const shadow = host && host.shadowRoot
            const trigger = shadow && shadow.querySelector('.trigger')
            const panel = shadow && shadow.querySelector('.panel')
            if (panel && panel.hidden && trigger) trigger.click()
            const rows = shadow ? Array.from(shadow.querySelectorAll('.source-list .source')) : []
            return rows.map((entry) => entry.textContent)
          })()`,
          { userGesture: true }
        )
        const clickResult = await pageEvaluate(
          page,
          `new Promise((resolve) => {
            const host = document.getElementById('dondownload-overlay-host')
            const shadow = host && host.shadowRoot
            const panel = shadow && shadow.querySelector('.panel')
            const trigger = shadow && shadow.querySelector('.trigger')
            if (panel && panel.hidden && trigger) trigger.click()
            const rows = shadow ? Array.from(shadow.querySelectorAll('.source-list .source')) : []
            const row = rows.find((entry) => /720p/.test(entry.textContent || ''))
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
            const deadline = started + 30000
            const timer = setInterval(() => {
              const text = status ? status.textContent : ''
              if (text && text.indexOf('Added to DonDownload') === 0) {
                clearInterval(timer)
                resolve({ ok: true, latencyMs: Math.round(performance.now() - started), status: text })
              } else if (text && text.indexOf('Adding ') !== 0) {
                clearInterval(timer)
                resolve({ ok: false, latencyMs: Math.round(performance.now() - started), status: text })
              } else if (performance.now() > deadline) {
                clearInterval(timer)
                resolve({ ok: false, timeout: true, status: text })
              }
            }, 10)
          })`,
          { userGesture: true }
        )
        const completed = await waitForCompletedAppDownload(
          nativeRun.db,
          alt.url,
          90000
        )
        const hashOk = completed.hash.sha256 === server.clip720Sha256
        const bytesOk = completed.hash.bytes === clip720.length
        const refererHits = server.log.filter(
          (entry) =>
            /\/remote_control\.php/.test(entry.path) &&
            typeof entry.referer === 'string' &&
            /\/kvs(?:[?#]|$)/.test(entry.referer)
        )
        const ok =
          overlay &&
          iconMs <= 1000 &&
          Array.isArray(panel) &&
          panel.some((text) => /480p/.test(text)) &&
          panel.some((text) => /720p/.test(text)) &&
          primary &&
          alt &&
          /\/1\.mp4\/$/.test(primary.url) &&
          /\/1_720p\.mp4\/$/.test(alt.url) &&
          clickResult.ok === true &&
          completed.row.status === 'complete' &&
          hashOk &&
          bytesOk &&
          refererHits.length > 0
        return {
          status: ok ? 'PASS' : 'FAIL',
          evidence: `icon visible in ${iconMs} ms; sources=${JSON.stringify(sources.map((entry) => ({ url: entry.url, qualityLabel: entry.qualityLabel })))}; panel=${JSON.stringify(panel)}; click=${JSON.stringify(clickResult)}; app row=${JSON.stringify({ id: completed.row.id, url: completed.row.url, filename: completed.row.filename, status: completed.row.status, total: completed.row.total_bytes })}; file=${completed.filePath} (${completed.hash.bytes}B) sha256=${completed.hash.sha256} expected=${server.clip720Sha256} match=${hashOk}; refererHits=${JSON.stringify(refererHits.slice(-3))}`
        }
      })

      await scenario('K2', 'KVS function/0 obfuscation decodes to the real qualities', async () => {
        if (setupError) return blocked()
        const page = nativeRun.page
        const tab = nativeRun.tabId
        await browserB.connection.send('Target.activateTarget', { targetId: page.targetId })
        await navigatePage(page, `${nativeOrigin}/kvs-obfuscated`)
        await waitForOverlayHost(page)
        const sources = await waitForCapturedSources(
          browserB,
          optionsB.sessionId,
          tab,
          (list) =>
            list.some((entry) => entry.qualityLabel === '480p') &&
            list.some((entry) => entry.qualityLabel === '720p')
        )
        const primary = sources.find((entry) => entry.qualityLabel === '480p')
        const alt = sources.find((entry) => entry.qualityLabel === '720p')
        const expectedPrimary = `${nativeOrigin}/get_file/1/${KVS_PRIMARY_TARGET}/0/1/1.mp4/`
        const expectedAlt = `${nativeOrigin}/get_file/1/${KVS_ALT_TARGET}/0/1/1_720p.mp4/`
        const ok =
          primary &&
          alt &&
          primary.url === expectedPrimary &&
          alt.url === expectedAlt
        return {
          status: ok ? 'PASS' : 'FAIL',
          evidence: `sources=${JSON.stringify(sources.map((entry) => ({ url: entry.url, qualityLabel: entry.qualityLabel })))}; expectedPrimary=${expectedPrimary}; expectedAlt=${expectedAlt}`
        }
      })

      await scenario('K3', 'KVS playback lists the .mp4/ source once without duplicates', async () => {
        if (setupError) return blocked()
        const page = nativeRun.page
        const tab = nativeRun.tabId
        await browserB.connection.send('Target.activateTarget', { targetId: page.targetId })
        await navigatePage(page, `${nativeOrigin}/kvs`)
        await waitForOverlayHost(page)
        await pageEvaluate(
          page,
          `(() => {
            const button = document.querySelector('#kt_player .play-button')
            if (button) button.click()
            return true
          })()`,
          { userGesture: true }
        )
        const media = await waitForSniffed(
          browserB,
          optionsB.sessionId,
          tab,
          (list) =>
            list.some(
              (entry) =>
                /\/get_file\/.+\.mp4\/$/.test(entry.url) &&
                entry.kind === 'file'
            )
        ).catch(async (error) => {
          const pageState = await pageEvaluate(
            page,
            `(() => {
              const video = document.getElementById('kvs-video')
              return video ? { src: video.getAttribute('src'), currentSrc: video.currentSrc, paused: video.paused, readyState: video.readyState, error: video.error && video.error.code } : null
            })()`,
            { userGesture: false }
          )
          throw new Error(
            `KVS playback was not sniffed: ${error instanceof Error ? error.message : String(error)}; page=${JSON.stringify(pageState)}; serverHits=${JSON.stringify(server.log.filter((entry) => /get_file|remote_control/.test(entry.path)).slice(-10))}`
          )
        })
        const matches = media.filter((entry) =>
          /\/get_file\/.+\.mp4\/$/.test(entry.url)
        )
        const exact = matches[0]
        const duplicateRows = media.filter(
          (entry) => exact && entry.url === exact.url
        )
        const uniqueUrls = new Set(media.map((entry) => entry.url))
        const ok =
          matches.length === 1 &&
          duplicateRows.length === 1 &&
          uniqueUrls.size === media.length &&
          exact &&
          /\/1\.mp4\/$/.test(exact.url)
        return {
          status: ok ? 'PASS' : 'FAIL',
          evidence: `media=${JSON.stringify(media.map((entry) => ({ url: entry.url, kind: entry.kind, filename: entry.filename, sizeBytes: entry.sizeBytes })))}; matching=${matches.length}; rowsWithExactUrl=${duplicateRows.length}; uniqueUrls=${uniqueUrls.size}/${media.length}`
        }
      })

      await scenario('N6', 'Referer-protected detected MP4 downloads through the app with matching SHA-256', async () => {
        if (setupError) return blocked()
        const page = nativeRun.page
        const tab = nativeRun.tabId
        await browserB.connection.send('Target.activateTarget', { targetId: page.targetId })
        // Reuse the already opted-in native fixture tab instead of creating a
        // new one; this keeps Helium's tab list small and avoids a redundant
        // tab-id lookup. The overlay grant is per origin and already active.
        await navigatePage(page, `${nativeOrigin}/referer-hidden`)
        const media = await waitForSniffed(
          browserB,
          optionsB.sessionId,
          tab,
          (list) => list.some((entry) => /\/hidden-referer\.mp4$/.test(entry.url))
        )
        const entry = media.find((candidate) => /\/hidden-referer\.mp4$/.test(candidate.url))
        if (!entry) throw new Error('the hidden referer MP4 was not detected')
        const queued = await queueSniffed(
          browserB,
          optionsB.sessionId,
          tab,
          entry.url
        )
        const completed = await waitForCompletedAppDownload(nativeRun.db, entry.url, 90000)
        const hashOk = completed.hash.sha256 === server.hiddenRefererSha256
        const bytesOk = completed.hash.bytes === server.hiddenRefererBytes
        const refererHits = server.log.filter(
          (row) =>
            row.path === '/hidden-referer.mp4' &&
            typeof row.referer === 'string' &&
            /\/referer-hidden(?:[?#]|$)/.test(row.referer)
        )
        const ok =
          queued &&
          queued.response &&
          queued.response.ok === true &&
          hashOk &&
          bytesOk &&
          refererHits.length > 0
        return {
          status: ok ? 'PASS' : 'FAIL',
          evidence: `queued=${JSON.stringify(queued)}; row=${JSON.stringify({ id: completed.row.id, status: completed.row.status, url: completed.row.url, file: completed.filePath })}; bytes=${completed.hash.bytes} sha256=${completed.hash.sha256} expected=${server.hiddenRefererSha256} match=${hashOk}; refererHits=${JSON.stringify(refererHits)}`
        }
      })

      await scenario('N7', 'Detected HLS variant downloads as a media job with duration and progress', async () => {
        if (setupError) return blocked()
        const page = nativeRun.page
        const tab = nativeRun.tabId
        await browserB.connection.send('Target.activateTarget', { targetId: page.targetId })
        await navigatePage(page, `${nativeOrigin}/hls`)
        const media = await waitForSniffed(
          browserB,
          optionsB.sessionId,
          tab,
          (list) =>
            list.some(
              (entry) =>
                entry.kind === 'hls' &&
                Array.isArray(entry.variants) &&
                entry.variants.some((variant) => variant.height === 720)
            )
        )
        const hls = media.find(
          (entry) =>
            entry.kind === 'hls' &&
            Array.isArray(entry.variants) &&
            entry.variants.some((variant) => variant.height === 720)
        )
        const variant = hls && hls.variants.find((entry) => entry.height === 720)
        if (!hls || !variant) throw new Error('the HLS master or 720p variant was not detected')
        const queued = await queueSniffed(
          browserB,
          optionsB.sessionId,
          tab,
          hls.url,
          variant.url
        )
        const row = await waitForValue(
          () =>
            readMediaJobRows(nativeRun.db).find(
              (entry) =>
                entry.source_url === variant.url && entry.status === 'complete'
            ) || null,
          (match) => match !== null,
          120000,
          'completed HLS media job',
          100
        )
        const filePath = row.file_path || path.join(row.dir, `${row.title}.mp4`)
        const exists = fs.existsSync(filePath)
        const hash = exists ? hashFile(filePath) : null
        const probe = exists ? ffprobeOutput(filePath) : null
        const duration = probe && probe.ok ? probe.duration : null
        const durationOk =
          typeof duration === 'number' && duration >= 1 && duration <= 5
        const ok =
          queued &&
          queued.response &&
          queued.response.ok === true &&
          exists &&
          hash &&
          hash.bytes > 10_000 &&
          durationOk &&
          row.completed_bytes > 0
        return {
          status: ok ? 'PASS' : 'FAIL',
          evidence: `queued=${JSON.stringify(queued)}; variant=${JSON.stringify(variant)}; job=${JSON.stringify({ id: row.id, status: row.status, title: row.title, label: row.label, completed: row.completed_bytes, total: row.total_bytes, dir: row.dir, file: row.file_path })}; file=${filePath} (${hash ? hash.bytes : 0}B); ffprobe=${JSON.stringify(probe)}; durationOk=${durationOk}`
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
  if (timings.length > 0) {
    console.log('Real-site timings')
    const labelWidth = Math.max(8, ...timings.map((item) => item.label.length))
    console.log(`${'Check'.padEnd(labelWidth)}  ${'ms'.padStart(8)}  Note`)
    console.log(`${'-'.repeat(labelWidth)}  ${'-'.repeat(8)}  ${'-'.repeat(16)}`)
    for (const item of timings) {
      console.log(
        `${item.label.padEnd(labelWidth)}  ${String(Math.round(item.ms)).padStart(8)}  ${item.note}`
      )
    }
    console.log('')
  }
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
