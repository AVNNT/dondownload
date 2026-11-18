#!/usr/bin/env node
// Regenerates the README screenshots from the renderer-only fixture preview.
//
// 1. Starts `vite --config vite.preview.config.ts` (no Electron) on a free port.
// 2. Drives a real headless Chromium over a small CDP client (the Playwright
//    Chromium build already on disk, or DONDOWNLOAD_CHROME_PATH). The fixture
//    API is a normal browser-side module, so this only needs a browser.
// 3. Clicks, types and right-clicks the real UI (no DOM shortcuts that skip
//    React handlers), waits for fonts and animations, captures the six README
//    shots plus the extension popup, and checks the page for error banners.
// 4. Stops the server and the browser on every exit path.
//
// Usage: npm run screenshots [-- --only=main,selection]

import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(SCRIPT_DIR, '..')
const OUT_DIR = path.join(ROOT, 'docs', 'screenshots')
const EXTENSION_DIR = path.join(ROOT, 'extension')
const VITE_CONFIG = path.join(ROOT, 'vite.preview.config.ts')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
// options
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2)
const onlyArg = argv.find((arg) => arg.startsWith('--only='))
const ONLY = onlyArg
  ? new Set(
      onlyArg
        .slice('--only='.length)
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name.length > 0)
    )
  : null

function wanted(name) {
  return ONLY === null || ONLY.has(name)
}

// ---------------------------------------------------------------------------
// Chromium discovery (newest Playwright build, unless overridden)
// ---------------------------------------------------------------------------
function playwrightChromiumRoots() {
  const roots = []
  if (process.env.LOCALAPPDATA) {
    roots.push(path.join(process.env.LOCALAPPDATA, 'ms-playwright'))
  }
  roots.push(path.join(os.homedir(), '.cache', 'ms-playwright'))
  roots.push(path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright'))
  return roots
}

function findChrome() {
  const override = process.env.DONDOWNLOAD_CHROME_PATH
  if (override) {
    if (!fs.existsSync(override)) {
      throw new Error(`DONDOWNLOAD_CHROME_PATH does not exist: ${override}`)
    }
    return override
  }

  const candidates = []
  for (const root of playwrightChromiumRoots()) {
    let entries
    try {
      entries = fs.readdirSync(root)
    } catch {
      continue
    }
    for (const entry of entries) {
      const match = /^chromium-(\d+)$/.exec(entry)
      if (!match) continue
      const version = Number(match[1])
      for (const exe of [
        path.join(root, entry, 'chrome-win64', 'chrome.exe'),
        path.join(root, entry, 'chrome-win', 'chrome.exe'),
        path.join(root, entry, 'chrome-linux', 'chrome'),
        path.join(root, entry, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium')
      ]) {
        if (fs.existsSync(exe)) candidates.push({ version, exe })
      }
    }
  }

  candidates.sort((left, right) => right.version - left.version)
  if (candidates.length > 0) return candidates[0].exe
  throw new Error(
    'No Playwright Chromium found. Install one (npx playwright install chromium) ' +
      'or set DONDOWNLOAD_CHROME_PATH to a Chromium/Chrome executable.'
  )
}

// ---------------------------------------------------------------------------
// minimal CDP client
// ---------------------------------------------------------------------------
class Cdp {
  constructor(wsUrl) {
    this.nextId = 0
    this.pending = new Map()
    this.ws = new WebSocket(wsUrl)
    this.ws.addEventListener('message', (event) => {
      let msg
      try {
        msg = JSON.parse(event.data)
      } catch {
        return
      }
      if (msg.id && this.pending.has(msg.id)) {
        const pending = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        clearTimeout(pending.timer)
        if (msg.error) pending.reject(new Error(JSON.stringify(msg.error)))
        else pending.resolve(msg.result)
      }
    })
  }

  static async connect(wsUrl) {
    const cdp = new Cdp(wsUrl)
    await new Promise((resolve, reject) => {
      cdp.ws.addEventListener('open', resolve, { once: true })
      cdp.ws.addEventListener('error', () => reject(new Error('CDP websocket failed')), {
        once: true
      })
    })
    return cdp
  }

  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP ${method} timed out`))
      }, 30000)
      this.pending.set(id, { resolve, reject, timer })
      const payload = { id, method, params }
      if (sessionId) payload.sessionId = sessionId
      this.ws.send(JSON.stringify(payload))
    })
  }

  close() {
    try {
      this.ws.close()
    } catch {
      /* already closed */
    }
  }
}

function killTree(pid) {
  if (!pid) return
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      process.kill(-pid, 'SIGKILL')
    }
  } catch {
    try {
      process.kill(pid)
    } catch {
      /* already gone */
    }
  }
}

/** Launches headless Chromium; with `extension` it loads the real extension. */
async function launchBrowser(chrome, { extension = false } = {}) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-shots-'))
  const extensionArgs = extension
    ? [
        `--load-extension=${EXTENSION_DIR}`,
        `--disable-extensions-except=${EXTENSION_DIR}`,
        '--enable-unsafe-extension-debugging'
      ]
    : []
  const proc = spawn(
    chrome,
    [
      // The README images must be reproducible, so they do not depend on
      // whatever fonts happen to be installed: local fonts are blocked and the
      // renderer falls back to Chromium's bundled metric-compatible faces.
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-local-fonts',
      // Windows display scaling must not leak into "1 CSS px = 1 image px".
      '--force-device-scale-factor=1',
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      '--disable-background-networking',
      '--disable-component-update',
      '--force-color-profile=srgb',
      ...extensionArgs,
      'about:blank'
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  )
  proc.stderr.on('data', () => {})

  let port = null
  let browserPath = null
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (proc.exitCode !== null) throw new Error('Chromium exited during startup')
    try {
      const lines = fs
        .readFileSync(path.join(userDataDir, 'DevToolsActivePort'), 'utf8')
        .split('\n')
      const candidate = Number(lines[0])
      const wsPath = lines[1] && lines[1].trim()
      if (candidate && wsPath) {
        const response = await fetch(`http://127.0.0.1:${candidate}/json/version`)
        if (response.ok) {
          port = candidate
          browserPath = wsPath
          break
        }
      }
    } catch {
      /* still starting */
    }
    await sleep(100)
  }
  if (!port) throw new Error('Chromium did not expose a DevTools port')

  const cdp = await Cdp.connect(`ws://127.0.0.1:${port}${browserPath}`)
  const close = async () => {
    try {
      await Promise.race([cdp.send('Browser.close'), sleep(2000)])
    } catch {
      /* closing */
    }
    cdp.close()
    await sleep(200)
    killTree(proc.pid)
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true })
    } catch {
      /* temp dir cleanup is best effort */
    }
  }
  return { cdp, close }
}

// ---------------------------------------------------------------------------
// vite preview server
// ---------------------------------------------------------------------------
function hasNpmCiModules() {
  const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')
  return fs.existsSync(viteBin)
}

async function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

async function waitForServer(url, child) {
  const deadline = Date.now() + 90000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`vite exited early with code ${child.exitCode}`)
    }
    try {
      // Any HTTP answer (even a 404 while Vite optimizes dependencies and
      // reloads) proves the server is listening; keep polling for real HTML.
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      /* not listening yet */
    }
    await sleep(250)
  }
  throw new Error(`vite preview did not answer on ${url}`)
}

async function startPreviewServer() {
  if (!hasNpmCiModules()) throw new Error('node_modules is missing; run npm ci first')
  const port = await findFreePort()
  // System node, not Electron's embedded runtime: the renderer build wants a
  // plain Vite process and no app window.
  const child = spawn(
    process.execPath,
    [
      path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'),
      '--config',
      VITE_CONFIG,
      '--port',
      String(port),
      '--strictPort',
      '--host',
      '127.0.0.1'
    ],
    {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, VITE_CONFIG_NATIVE_IGNORE_WARNING: 'true' }
    }
  )
  let log = ''
  const append = (chunk) => {
    log += chunk.toString()
    if (log.length > 20000) log = log.slice(-20000)
  }
  child.stdout.on('data', append)
  child.stderr.on('data', append)

  const url = `http://127.0.0.1:${port}/preview.html?screenshots`
  try {
    await waitForServer(url, child)
  } catch (error) {
    killTree(child.pid)
    throw new Error(`${error.message}\n--- vite output ---\n${log}`, { cause: error })
  }
  const stop = async () => {
    // `npm.cmd` spawns vite as a child, so close the whole tree.
    killTree(child.pid)
    await sleep(300)
  }
  return { url, baseUrl: `http://127.0.0.1:${port}`, stop }
}

// ---------------------------------------------------------------------------
// page driving
// ---------------------------------------------------------------------------
class Page {
  constructor(cdp, sessionId) {
    this.cdp = cdp
    this.sessionId = sessionId
  }

  send(method, params = {}) {
    return this.cdp.send(method, params, this.sessionId)
  }

  async evaluate(expression, { awaitPromise = true } = {}) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise
    })
    if (result.exceptionDetails) {
      const detail =
        result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        'evaluation failed'
      throw new Error(detail)
    }
    return result.result ? result.result.value : undefined
  }

  async waitFor(expression, label, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      let value
      try {
        value = await this.evaluate(`Boolean(${expression})`)
      } catch {
        value = false
      }
      if (value) return
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`)
      await sleep(100)
    }
  }

  async setViewport(width, height) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false
    })
  }

  /** Mirrors the Electron window zoom (`zoomFactorFor(interfaceSizePercent)`). */
  async setZoom(factor) {
    await this.send('Emulation.setPageScaleFactor', { pageScaleFactor: factor })
  }

  async center(selector) {
    const rect = await this.evaluate(
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)})
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
      })()`
    )
    if (!rect) throw new Error(`No element matches ${selector}`)
    return rect
  }

  async clickAt(x, y, { button = 'left', clickCount = 1, modifiers = 0 } = {}) {
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
      button: 'none'
    })
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button,
      clickCount,
      modifiers
    })
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button,
      clickCount,
      modifiers
    })
  }

  async click(selector, options) {
    const { x, y } = await this.center(selector)
    await this.clickAt(x, y, options)
  }

  async press(key, { code, keyCode, modifiers = 0, text } = {}) {
    const base = { key, code: code ?? key, windowsVirtualKeyCode: keyCode ?? 0, modifiers }
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(text ? { text } : {}) })
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key,
      code: base.code,
      windowsVirtualKeyCode: base.windowsVirtualKeyCode,
      modifiers
    })
  }

  async typeText(text) {
    await this.send('Input.insertText', { text })
  }

  /**
   * Waits for fonts, two animation frames, any running finite CSS animation
   * (opening popovers and dialogs) and a short settle pause. Infinite
   * animations (spinners, progress shimmer) are ignored.
   */
  async settle(extraMs = 250) {
    await this.evaluate(
      `(async () => {
        await document.fonts.ready
        const frames = () =>
          new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        await frames()
        const deadline = performance.now() + 2000
        while (performance.now() < deadline) {
          const running = document.getAnimations().filter((animation) => {
            if (animation.playState !== 'running') return false
            const end = animation.effect && animation.effect.getComputedTiming().endTime
            return typeof end === 'number' && Number.isFinite(end)
          })
          if (running.length === 0) break
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
        await frames()
        return true
      })()`
    )
    await sleep(extraMs)
  }

  /** Reports layout/assertion problems; with `outPath` also writes the PNG. */
  async inspect(outPath) {
    const problems = await this.evaluate(`(() => {
      const problems = []
      const alerts = Array.from(document.querySelectorAll('[role="alert"]'))
        .map((el) => el.textContent.trim())
        .filter((text) => text.length > 0)
      if (alerts.length > 0) problems.push('alerts: ' + alerts.join(' | '))
      if (document.querySelector('[aria-label="Fixture controls"]')) {
        problems.push('fixture controls overlay is visible')
      }
      const overflow = document.documentElement.scrollWidth > document.documentElement.clientWidth
      if (overflow) problems.push('horizontal overflow')
      const missing = Array.from(document.images)
        .filter((img) => !img.complete || img.naturalWidth === 0)
        .map((img) => img.currentSrc || img.src)
      if (missing.length > 0) problems.push('images not loaded: ' + missing.join(', '))
      return problems
    })()`)
    if (outPath !== undefined) {
      const { data } = await this.send('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: false
      })
      fs.writeFileSync(outPath, Buffer.from(data, 'base64'))
    }
    return problems
  }

  async capture(outPath) {
    await this.settle()
    return this.inspect(outPath)
  }
}

async function openPage(cdp, url, { width, height }) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  const page = new Page(cdp, sessionId)
  page.targetId = targetId
  await page.send('Page.enable')
  await page.setViewport(width, height)
  await page.send('Page.navigate', { url })
  await page.waitFor(
    `document.readyState === 'complete' && Boolean(document.querySelector('[data-row-key]'))`,
    `${url} to render the download list`,
    30000
  )
  await page.settle(400)
  return page
}

// ---------------------------------------------------------------------------
// selector helpers
// ---------------------------------------------------------------------------
const ACTIVE_ROW = '[data-row-key="download:preview-download-active"]'
const AUDIO_ROW = '[data-row-key="download:preview-download-audio-active"]'
const ADD_BUTTON = 'header button[title="Add (Ctrl+N)"]'

/** Real click on the row, then real keys where the UI expects them. */
async function focusRow(page, selector) {
  const { x, y } = await page.center(selector)
  await page.clickAt(x, y)
  await page.settle(150)
}

async function openAddDialog(page) {
  await page.click(ADD_BUTTON)
  await page.waitFor('document.querySelector(\'[role="dialog"] textarea#add-links\')', 'Add dialog')
  await page.settle(250)
}

// ---------------------------------------------------------------------------
// scenes
// ---------------------------------------------------------------------------
const WIDE = { width: 1280, height: 800 }
const NARROW = { width: 800, height: 600 }

const SCENES = [
  {
    name: 'main',
    file: 'main-1280x800.png',
    description: 'download list with the fixture downloads',
    async run(page) {
      await page.settle(600)
    }
  },
  {
    name: 'selection',
    file: 'selection-1280x800.png',
    description: 'multi-selection with the batch action bar',
    async run(page) {
      // Click the active download, shift-click its audio neighbour: a real
      // range selection through the row click handler.
      await focusRow(page, ACTIVE_ROW)
      const audio = await page.center(AUDIO_ROW)
      await page.clickAt(audio.x, audio.y, { modifiers: 8 }) // 8 = Shift
      await page.waitFor(
        `document.body.textContent.includes('2 selected')`,
        'the batch action bar'
      )
      // Shift-click also extends the browser's text selection; drop it.
      await page.evaluate('window.getSelection()?.removeAllRanges()')
    }
  },
  {
    name: 'details',
    file: 'details-1280x800.png',
    description: 'details pane open on an active download',
    async run(page) {
      await focusRow(page, ACTIVE_ROW)
      await page.press('Enter', { keyCode: 13, text: '\r' })
      await page.waitFor('document.querySelector(\'section[aria-label^="Details for"]\')', 'the details pane')
    }
  },
  {
    name: 'context-menu',
    file: 'context-menu-1280x800.png',
    description: 'right-click context menu on an active download',
    async run(page) {
      // A row near the top of the viewport keeps the whole menu on screen.
      const row = '[data-row-key="download:preview-download-active"]'
      await focusRow(page, row)
      const { x, y } = await page.center(row)
      await page.clickAt(x, y, { button: 'right' })
      await page.waitFor(
        'document.querySelector(\'[role="menu"]\')',
        'the row context menu'
      )
      // The menu animates in and is repositioned after its first layout.
      await sleep(500)
      const fits = await page.evaluate(
        `(() => {
          const menu = document.querySelector('[role="menu"]').getBoundingClientRect()
          return menu.top >= 0 && menu.bottom <= innerHeight && menu.left >= 0 && menu.right <= innerWidth
        })()`
      )
      if (!fits) throw new Error('the context menu is clipped by the window')
    }
  },
  {
    name: 'add-dialog',
    file: 'add-dialog-1280x800.png',
    description: 'Add dialog with a URL typed in',
    async run(page) {
      await openAddDialog(page)
      await page.click('textarea#add-links')
      await page.typeText('https://mirror.ubuntu.example/releases/ubuntu-24.04.1-desktop-amd64.iso')
      await page.waitFor(
        'document.querySelector(\'button[title="Add (Ctrl+N)"]\') && document.querySelector("#add-links").value.length > 10',
        'the typed URL'
      )
      // The direct-file row and its debounced size probe need a moment.
      await page.waitFor(
        'document.body.textContent.includes("ubuntu-24.04.1-desktop-amd64.iso")',
        'the parsed download row'
      )
      await page.settle(600)
    }
  },
  {
    name: 'narrow',
    file: 'narrow-800x600.png',
    description: '800x600 icon-rail layout',
    viewport: NARROW,
    async run(page) {
      await page.settle(600)
    }
  }
]

// ---------------------------------------------------------------------------
// extension popup
// ---------------------------------------------------------------------------
async function extensionId(cdp) {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    const { targetInfos } = await cdp.send('Target.getTargets')
    const ids = targetInfos
      .filter((target) => target.url.startsWith('chrome-extension://'))
      .map((target) => new URL(target.url).host)
    if (ids.length > 0) return ids[0]
    await sleep(150)
  }
  return null
}

const POPUP_STUB = `(() => {
  const found = {
    ok: true,
    sources: [
      {
        url: 'https://cdn.example.com/media/blender-4.2-release-notes.mp4',
        filename: 'blender-4.2-release-notes.mp4',
        qualityLabel: '1080p',
        current: true
      }
    ],
    streaming: { detected: true },
    analysis: {
      analysisId: 'analysis0000000000000001',
      title: 'Blender 4.2 release notes walkthrough',
      options: [
        { kind: 'video', optionId: 'opt000000000000000001', label: '1080p', container: 'mp4', height: 1080, hasAudio: true, estimatedBytes: 671088640 },
        { kind: 'video', optionId: 'opt000000000000000002', label: '720p', container: 'mp4', height: 720, hasAudio: true, estimatedBytes: 325058560 }
      ]
    },
    status: 'ready',
    queuedOptionIds: []
  }
  if (chrome.runtime && chrome.runtime.sendNativeMessage) {
    const original = chrome.runtime.sendNativeMessage
    chrome.runtime.sendNativeMessage = (host, message, callback) => {
      if (message && message.type === 'probe') {
        if (typeof callback === 'function') return callback({ ok: true, operation: 'probe' })
        return Promise.resolve({ ok: true, operation: 'probe' })
      }
      return original.call(chrome.runtime, host, message, callback)
    }
  }
  chrome.tabs.query = (_query, callback) => {
    const tabs = [{ id: 1, url: 'https://www.blender.org/download/releases/4-2/' }]
    if (typeof callback === 'function') return callback(tabs)
    return Promise.resolve(tabs)
  }
  chrome.tabs.sendMessage = (_tabId, message, callback) => {
    const answer =
      message && message.type === 'dondownload:capture-query' ? found : { ok: true }
    if (typeof callback === 'function') return callback(answer)
    return Promise.resolve(answer)
  }
  if (chrome.permissions) chrome.permissions.contains = (_p, callback) => callback(true)
  const originalSend = chrome.runtime.sendMessage
  chrome.runtime.sendMessage = (message, callback) => {
    if (message && String(message.type).includes('sniffed-query')) {
      const empty = { ok: true, media: [] }
      if (typeof callback === 'function') return callback(empty)
      return Promise.resolve(empty)
    }
    return originalSend.call(chrome.runtime, message, callback)
  }
})()`

async function captureExtensionPopup(cdp, outPath) {
  const id = await extensionId(cdp)
  if (!id) throw new Error('extension service worker not found')
  if (process.env.DD_DEBUG) {
    const targets = await cdp.send('Target.getTargets')
    console.log('targets:', targets.targetInfos.map((t) => `${t.type} ${t.url}`).join('\n  '))
    console.log(`extension id: ${id}`)
  }

  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  const page = new Page(cdp, sessionId)
  page.targetId = targetId
  await page.send('Page.enable')
  await page.setViewport(380, 900)
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: POPUP_STUB })
  await page.send('Page.navigate', { url: `chrome-extension://${id}/popup.html` })
  await page.waitFor('document.readyState === "complete"', 'the popup document', 20000)
  await page.settle(800)

  const size = await page.evaluate(`(() => {
    const doc = document.documentElement
    const body = document.body
    return {
      height: Math.min(1200, Math.max(doc.scrollHeight, body ? body.scrollHeight : 0) + 2),
      width: Math.max(doc.scrollWidth, body ? body.scrollWidth : 0)
    }
  })()`)
  const width = Math.max(380, Math.min(480, size.width))
  await page.setViewport(width, Math.max(320, size.height))
  await page.settle(400)
  const problems = await page.inspect()
  if (size.width > width) problems.push(`popup is ${size.width}px wide, wider than ${width}px`)
  try {
    await page.capture(outPath)
  } finally {
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {})
  }
  return { width, height: size.height, problems }
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------
async function main() {
  const started = Date.now()
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const chrome = findChrome()
  console.log(`Chromium: ${chrome}`)

  let server = null
  let browser = null
  let extensionBrowser = null
  let failed = false

  const report = (file, description, viewport, problems) => {
    if (problems.length > 0) {
      failed = true
      console.error(`  ${file}: ${problems.join('; ')}`)
    } else {
      console.log(`  ${file}  (${description}) ${viewport}`)
    }
  }

  try {
    if (SCENES.some((scene) => wanted(scene.name))) {
      server = await startPreviewServer()
      console.log(`Preview:  ${server.url}`)
      browser = await launchBrowser(chrome)

      for (const scene of SCENES) {
        if (!wanted(scene.name)) continue
        const viewport = scene.viewport ?? WIDE
        const page = await openPage(browser.cdp, server.url, viewport)
        try {
          await scene.run(page)
          const problems = await page.capture(path.join(OUT_DIR, scene.file))
          report(scene.file, scene.description, `${viewport.width}x${viewport.height}`, problems)
        } finally {
          await browser.cdp
            .send('Target.closeTarget', { targetId: page.targetId })
            .catch(() => {})
        }
      }
    }

    if (wanted('extension-popup')) {
      try {
        extensionBrowser = await launchBrowser(chrome, { extension: true })
        const popup = await captureExtensionPopup(
          extensionBrowser.cdp,
          path.join(OUT_DIR, 'extension-popup.png')
        )
        report('extension-popup.png', 'browser extension popup', `${popup.width}x${popup.height}`, popup.problems)
      } catch (error) {
        // The popup is a bonus shot: report it and keep the app screenshots.
        console.warn(`  extension-popup.png skipped: ${error.message}`)
      }
    }
  } finally {
    if (extensionBrowser) await extensionBrowser.close()
    if (browser) await browser.close()
    if (server) await server.stop()
  }

  console.log(`Done in ${((Date.now() - started) / 1000).toFixed(1)}s`)
  if (failed) {
    console.error('One or more screenshots had page problems (see above).')
    process.exitCode = 1
  }
}

void main().catch((error) => {
  console.error(`FAILED: ${error && error.message ? error.message : error}`)
  process.exitCode = 1
})
