#!/usr/bin/env node
// Headless Chromium screenshots of the Phase 6 extension UI.
// Reuses the Playwright Chromium build (already present) and a small CDP
// client. Loads the real extension so chrome.* exists, stubs a "found" popup
// state, and serves a local page that injects the overlay content scripts so
// the trigger and panel render. Saves PNGs to .redesign-shots/phase6/.

import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(SCRIPT_DIR, '..')
const EXTENSION_DIR = path.join(ROOT, 'extension')
const OUT_DIR = path.join(ROOT, '.redesign-shots', 'phase6')

const CHROME =
  process.env.DONDOWNLOAD_CHROME_PATH ||
  path.join(
    process.env.LOCALAPPDATA || '',
    'ms-playwright',
    'chromium-1248',
    'chrome-win64',
    'chrome.exe'
  )

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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
        const p = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        clearTimeout(p.timer)
        msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result)
      }
    })
  }

  static async connect(wsUrl) {
    const cdp = new Cdp(wsUrl)
    await new Promise((resolve, reject) => {
      cdp.ws.addEventListener('open', resolve, { once: true })
      cdp.ws.addEventListener('error', () => reject(new Error('ws connect failed')), {
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
        reject(new Error(`CDP ${method} timeout`))
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
      /* ignore */
    }
  }
}

function killTree(pid) {
  if (!pid) return
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  } catch {
    try {
      process.kill(pid)
    } catch {
      /* gone */
    }
  }
}

async function launch() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-redesign-'))
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
    '--window-size=1280,900',
    `--load-extension=${EXTENSION_DIR}`,
    `--disable-extensions-except=${EXTENSION_DIR}`,
    '--enable-unsafe-extension-debugging',
    'about:blank'
  ]
  const proc = spawn(CHROME, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  proc.stderr.on('data', () => {})

  let devPort = null
  let browserPath = null
  for (let i = 0; i < 200; i += 1) {
    if (proc.exitCode !== null) throw new Error('chromium exited early')
    try {
      const lines = fs.readFileSync(path.join(userDataDir, 'DevToolsActivePort'), 'utf8').split('\n')
      const candidate = Number(lines[0])
      const bp = lines[1] && lines[1].trim()
      if (candidate && bp) {
        const r = await fetch(`http://127.0.0.1:${candidate}/json/version`)
        if (r.ok) {
          devPort = candidate
          browserPath = bp
          break
        }
      }
    } catch {
      /* still starting */
    }
    await sleep(100)
  }
  if (!devPort) throw new Error('no devtools port')
  const cdp = await Cdp.connect(`ws://127.0.0.1:${devPort}${browserPath}`)
  try {
    await cdp.send('Target.setDiscoverTargets', { discover: true })
    await cdp.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true
    })
  } catch {
    /* best effort */
  }
  const close = async () => {
    try {
      await Promise.race([cdp.send('Browser.close'), sleep(2000)])
    } catch {
      /* ignore */
    }
    cdp.close()
    await sleep(200)
    killTree(proc.pid)
  }
  return { proc, cdp, close, userDataDir }
}

async function findExtensionId(cdp) {
  const deadline = Date.now() + 12000
  for (;;) {
    const { targetInfos } = await cdp.send('Target.getTargets')
    for (const t of targetInfos) {
      if (t.type !== 'service_worker' || !t.url.startsWith('chrome-extension://')) continue
      try {
        const a = await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true })
        const r = await cdp.send(
          'Runtime.evaluate',
          {
            expression: 'chrome.runtime && chrome.runtime.getManifest ? chrome.runtime.getManifest().name : ""',
            returnByValue: true
          },
          a.sessionId
        )
        if (r.result && r.result.value === 'DonDownload Capture') {
          return new URL(t.url).host
        }
      } catch {
        /* not ours */
      }
    }
    // Fall back to the CDP Extensions domain (needs --enable-unsafe-extension-debugging).
    try {
      const loaded = await cdp.send('Extensions.loadUnpacked', { path: EXTENSION_DIR })
      if (loaded && loaded.id) return loaded.id
    } catch {
      /* keep waiting */
    }
    if (Date.now() > deadline) break
    await sleep(150)
  }
  throw new Error('DonDownload service worker not found')
}

async function openTarget(cdp, url) {
  const { targetId } = await cdp.send('Target.createTarget', { url })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  await cdp.send('Page.enable', {}, sessionId)
  // Wait for the committed navigation to settle.
  const deadline = Date.now() + 15000
  for (;;) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${url}`)
    try {
      const state = await cdp.send(
        'Runtime.evaluate',
        { expression: '({ ready: document.readyState, href: location.href })', returnByValue: true },
        sessionId
      )
      const v = state.result && state.result.value
      if (v && v.ready === 'complete') break
    } catch {
      /* still loading */
    }
    await sleep(120)
  }
  return sessionId
}

async function screenshot(cdp, sessionId, outPath, { width, height }) {
  if (width || height) {
    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width, height, deviceScaleFactor: 1, mobile: false },
      sessionId
    )
  }
  const { data } = await cdp.send(
    'Page.captureScreenshot',
    { format: 'png', captureBeyondViewport: true, fromSurface: true },
    sessionId
  )
  fs.writeFileSync(outPath, Buffer.from(data, 'base64'))
}

async function contentSize(cdp, sessionId) {
  const m = await cdp.send('Page.getLayoutMetrics', {}, sessionId)
  const size = m.cssContentSize || m.contentSize || { width: 0, height: 0 }
  return { width: Math.ceil(size.width), height: Math.ceil(size.height) }
}

async function computed(cdp, sessionId, expr) {
  const r = await cdp.send(
    'Runtime.evaluate',
    { expression: expr, returnByValue: true },
    sessionId
  )
  return r.result ? r.result.value : undefined
}

// ---------------------------------------------------------------------------
// fixture HTTP server for the overlay page
// ---------------------------------------------------------------------------
function startServer() {
  const overlayFiles = [
    'overlay-core.js',
    'overlay-runtime.js',
    'overlay-ui.js',
    'overlay-qualities.js',
    'overlay-kvs.js',
    'overlay-capture.js',
    'overlay.js'
  ]
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost')
    if (u.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(
        '<!doctype html><meta charset="utf-8"><title>overlay fixture</title>' +
          '<body style="margin:0;background:#000;color:#fff;font:14px sans-serif">' +
          '<div style="padding:24px"><h1 style="font-size:20px;margin:0 0 14px">Sample clip for overlay screenshot</h1>' +
          '<div style="position:relative;width:960px;height:540px;background:#111;border-radius:4px;overflow:hidden">' +
          '<video id="v" width="960" height="540" style="display:block;width:100%;height:100%;object-fit:cover;background:#111" muted></video>' +
          '</div></div>' +
          '<script src="/overlay-core.js"></script>' +
          '<script src="/overlay-runtime.js"></script>' +
          '<script src="/overlay-ui.js"></script>' +
          '<script src="/overlay-qualities.js"></script>' +
          '<script src="/overlay-kvs.js"></script>' +
          '<script src="/overlay-capture.js"></script>' +
          '<script src="/overlay.js"></script>' +
          '<script>var ns=globalThis.DonDownloadOverlay;var v=document.getElementById("v");ns.showFor(v);ns.openPanel();</script>' +
          '</body>'
      )
      return
    }
    const file = overlayFiles.find((f) => u.pathname === `/${f}`)
    if (file) {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
      res.end(fs.readFileSync(path.join(EXTENSION_DIR, file), 'utf8'))
      return
    }
    res.writeHead(404)
    res.end()
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

// ---------------------------------------------------------------------------
// popup state stubs (injected before popup.js runs)
// ---------------------------------------------------------------------------
const CAPTURE_FOUND = `{
  ok: true,
  sources: [{ url: 'https://media.example.com/sample.mp4', filename: 'sample.mp4', qualityLabel: '720p', current: true }],
  streaming: { detected: true },
  analysis: {
    analysisId: 'analysis0000000000000001',
    title: 'Product launch keynote — full event with live Q&A',
    options: [
      { kind: 'video', optionId: 'opt000000000000000001', label: '1080p', container: 'mp4', height: 1080, hasAudio: true, estimatedBytes: 671088640 },
      { kind: 'video', optionId: 'opt000000000000000002', label: '720p', container: 'mp4', height: 720, hasAudio: true, estimatedBytes: 325058560 }
    ]
  },
  status: 'ready',
  queuedOptionIds: []
}`

const CAPTURE_EMPTY = `{
  ok: true,
  sources: [],
  streaming: { detected: false },
  status: 'idle',
  queuedOptionIds: []
}`

function popupStub(scene) {
  const offline = scene === 'offline'
  const empty = scene === 'empty'
  const links = scene === 'links'
  const login = scene === 'login'

  const native = offline
    ? `chrome.runtime.sendNativeMessage = (host, msg, cb) => {
        if (msg && msg.type === 'probe') return cb({ ok: false })
        cb({ ok: true, accepted: true })
      }`
    : `chrome.runtime.sendNativeMessage = (host, msg, cb) => {
        if (msg && msg.type === 'probe') return cb({ ok: true, operation: 'probe' })
        cb({ ok: true, accepted: true })
      }`

  const capture = empty ? CAPTURE_EMPTY : CAPTURE_FOUND

  const storage = links || login
    ? `(() => {
        if (chrome.storage && chrome.storage.session) {
          const data = {
            ${links ? `'dondownload:scan-links-draft': 'https://forum.example.com/t/weekly-design-notes/123\\nhttps://forum.example.com/t/launch-event/456\\nhttps://media.example.com/watch/keynote-2026'` : ''}
            ${links && login ? ',' : ''}
            ${login ? `'dondownloadHandoffNeedsLogin': { origin: 'https://media.example.com', host: 'media.example.com', at: ${Date.now()} }` : ''}
          }
          chrome.storage.session.get = (keys, cb) => {
            if (typeof cb === 'function') return cb(data)
            return Promise.resolve(data)
          }
        }
      })()`
    : ''

  return `(() => {
    ${native}
    chrome.tabs.query = (q, cb) => cb([{ id: 1, url: 'https://media.example.com/watch/keynote-2026' }])
    chrome.tabs.sendMessage = (tabId, msg, cb) => {
      if (msg && msg.type === 'dondownload:capture-query') {
        cb(${capture})
        return
      }
      cb({ ok: true })
    }
    if (chrome.permissions) chrome.permissions.contains = (p, cb) => cb(true)
    chrome.runtime.sendMessage = (msg, cb) => {
      if (msg && msg.type && String(msg.type).indexOf('sniffed-query') !== -1) {
        return cb({ ok: true, media: [] })
      }
      cb({ ok: true })
    }
    ${storage}
  })()`
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------
const report = []
const shot = (name) => path.join(OUT_DIR, `${name}.png`)

async function main() {
  fs.rmSync(OUT_DIR, { recursive: true, force: true })
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const server = await startServer()
  const port = server.address().port

  const browser = await launch()
  let exitCode = 0
  try {
    const extId = await findExtensionId(browser.cdp)
    console.log(`extension id: ${extId}`)

    let shotIndex = 0
    const nextName = (label) => {
      shotIndex += 1
      return `${String(shotIndex).padStart(2, '0')}-${label}`
    }

    async function waitReady(cdp, sessionId, label) {
      const deadline = Date.now() + 15000
      for (;;) {
        if (Date.now() > deadline) throw new Error(`${label} load timeout`)
        try {
          const r = await cdp.send(
            'Runtime.evaluate',
            { expression: 'document.readyState', returnByValue: true },
            sessionId
          )
          if (r.result && r.result.value === 'complete') break
        } catch {
          /* loading */
        }
        await sleep(120)
      }
    }

    const scrollWidths = []

    // popup — every state, dark then light
    {
      const POPUP_SCENES = [
        { id: 'found', name: 'found' },
        { id: 'empty', name: 'empty' },
        { id: 'offline', name: 'offline' },
        { id: 'links', name: 'links' },
        { id: 'login', name: 'login' }
      ]
      for (const theme of ['dark', 'light']) {
        for (const scene of POPUP_SCENES) {
          const { targetId } = await browser.cdp.send('Target.createTarget', {
            url: 'about:blank'
          })
          const { sessionId } = await browser.cdp.send('Target.attachToTarget', { targetId, flatten: true })
          await browser.cdp.send('Page.enable', {}, sessionId)
          await browser.cdp.send(
            'Page.addScriptToEvaluateOnNewDocument',
            { source: popupStub(scene.id) },
            sessionId
          )
          if (theme === 'light') {
            await browser.cdp.send(
              'Emulation.setEmulatedMedia',
              { features: [{ name: 'prefers-color-scheme', value: 'light' }] },
              sessionId
            )
          }
          await browser.cdp.send(
            'Page.navigate',
            { url: `chrome-extension://${extId}/popup.html` },
            sessionId
          )
          await waitReady(browser.cdp, sessionId, `popup ${scene.name} ${theme}`)
          await sleep(500) // allow async render + draft/needs-login restore
          // Pin the viewport to the popup width before measuring overflow.
          await browser.cdp.send(
            'Emulation.setDeviceMetricsOverride',
            { width: 380, height: 600, deviceScaleFactor: 1, mobile: false },
            sessionId
          )
          await sleep(80)
          const scrollWidth = await computed(
            browser.cdp,
            sessionId,
            'document.documentElement.scrollWidth'
          )
          const size = await contentSize(browser.cdp, sessionId)
          const h = Math.max(320, Math.min(1200, size.height + 8))
          const name = nextName(`popup-${scene.name}${theme === 'light' ? '-light' : ''}`)
          await screenshot(browser.cdp, sessionId, shot(name), { width: 380, height: h })
          scrollWidths.push({ scene: scene.name, theme, scrollWidth })
          report.push(`popup ${scene.name} (${theme}) scrollWidth: ${scrollWidth}`)
          if (scene.name === 'found' && theme === 'dark') {
            const acts = await computed(
              browser.cdp,
              sessionId,
              `(() => {
                const scan = document.getElementById('scan-page')
                const many = document.getElementById('scan-many')
                const summary = many && many.querySelector('summary')
                const label = document.getElementById('scan-page-label')
                return {
                  scanLabel: label ? label.textContent : null,
                  scanWidth: scan ? Math.round(scan.getBoundingClientRect().width) : null,
                  scanManyLabel: summary ? summary.textContent.trim() : null,
                  scanManyWidth: summary ? Math.round(summary.getBoundingClientRect().width) : null
                }
              })()`
            )
            report.push(`popup acts (found): ${JSON.stringify(acts)}`)
          }
        }
      }
    }

    // options — dark then light
    for (const theme of ['dark', 'light']) {
      const { targetId } = await browser.cdp.send('Target.createTarget', {
        url: 'about:blank'
      })
      const { sessionId } = await browser.cdp.send('Target.attachToTarget', { targetId, flatten: true })
      await browser.cdp.send('Page.enable', {}, sessionId)
      if (theme === 'light') {
        await browser.cdp.send(
          'Emulation.setEmulatedMedia',
          { features: [{ name: 'prefers-color-scheme', value: 'light' }] },
          sessionId
        )
      }
      await browser.cdp.send(
        'Page.navigate',
        { url: `chrome-extension://${extId}/options.html` },
        sessionId
      )
      await waitReady(browser.cdp, sessionId, `options ${theme}`)
      await sleep(600)
      const size = await contentSize(browser.cdp, sessionId)
      const name = nextName(`options${theme === 'light' ? '-light' : ''}`)
      await screenshot(browser.cdp, sessionId, shot(name), { width: 760, height: size.height })
      const bg = await computed(browser.cdp, sessionId, 'getComputedStyle(document.body).backgroundColor')
      report.push(`options (${theme}) body background: ${bg}`)
      if (theme === 'dark') {
        const hintStrong = await computed(
          browser.cdp,
          sessionId,
          `(() => {
            const row = document.getElementById('site-cookies')
            const hint = row && row.closest('.toggle-row').querySelector('.hint strong')
            if (!hint) return null
            return { text: hint.textContent, display: getComputedStyle(hint).display }
          })()`
        )
        report.push(`options hint strong display: ${JSON.stringify(hintStrong)}`)
      }
    }

    // welcome — connected state (native probe stubbed to succeed)
    {
      const { targetId } = await browser.cdp.send('Target.createTarget', {
        url: 'about:blank'
      })
      const { sessionId } = await browser.cdp.send('Target.attachToTarget', { targetId, flatten: true })
      await browser.cdp.send('Page.enable', {}, sessionId)
      await browser.cdp.send(
        'Page.addScriptToEvaluateOnNewDocument',
        {
          source: `(() => {
            chrome.runtime.sendNativeMessage = (host, msg, cb) => {
              if (msg && msg.type === 'probe') return cb({ ok: true, operation: 'probe' })
              cb({ ok: true, accepted: true })
            }
          })()`
        },
        sessionId
      )
      await browser.cdp.send(
        'Page.navigate',
        { url: `chrome-extension://${extId}/welcome.html` },
        sessionId
      )
      await waitReady(browser.cdp, sessionId, 'welcome')
      await sleep(700)
      const size = await contentSize(browser.cdp, sessionId)
      const name = nextName('welcome')
      await screenshot(browser.cdp, sessionId, shot(name), { width: 760, height: size.height })
      const conn = await computed(
        browser.cdp,
        sessionId,
        '({ className: (document.getElementById("connection")||{}).className, title: (document.getElementById("connection-title")||{}).textContent })'
      )
      report.push(`welcome connection: ${JSON.stringify(conn)}`)
    }

    // overlay fixture
    {
      const s = await openTarget(browser.cdp, `http://127.0.0.1:${port}/`)
      await sleep(600)
      const ready = await computed(
        browser.cdp,
        s,
        'Boolean(document.getElementById("dondownload-overlay-host") && document.getElementById("dondownload-overlay-host").shadowRoot && document.getElementById("dondownload-overlay-host").shadowRoot.querySelector(".trigger"))'
      )
      report.push(`overlay host/trigger present: ${ready}`)
      const panelStyle = await computed(
        browser.cdp,
        s,
        `(() => {
          const host = document.getElementById('dondownload-overlay-host')
          if (!host || !host.shadowRoot) return null
          const panel = host.shadowRoot.querySelector('.panel')
          if (!panel) return null
          const cs = getComputedStyle(panel)
          return { border: cs.border, outline: cs.outline, boxShadow: cs.boxShadow }
        })()`
      )
      report.push(`overlay panel style: ${JSON.stringify(panelStyle)}`)
      await screenshot(browser.cdp, s, shot(nextName('overlay')), { width: 1280, height: 800 })
    }

    report.push(
      `scrollWidth summary: ${scrollWidths
        .map((m) => `${m.scene}/${m.theme}=${m.scrollWidth}`)
        .join(' ')}`
    )
    const overflow = scrollWidths.filter((m) => m.scrollWidth > 380)
    if (overflow.length > 0) {
      report.push(`OVERFLOW: ${JSON.stringify(overflow)}`)
      console.error('popup horizontal overflow detected:', overflow)
      exitCode = 1
    }

    console.log('\n' + report.join('\n'))
    console.log('screenshots written to ' + OUT_DIR)
  } catch (error) {
    console.error('FAILED:', error && error.message ? error.message : error)
    exitCode = 1
  } finally {
    await browser.close()
    server.close()
  }
  process.exitCode = exitCode
}

void main()
