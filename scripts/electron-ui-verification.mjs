#!/usr/bin/env node
/**
 * Real packaged Electron UI verification. Launches the packaged app on an
 * isolated userData path, drives the renderer through CDP (not OS input), and
 * downloads a throttled loopback fixture through the real IPC, DownloadManager
 * and aria2 stack. The window must be visible for delta snapshots, so the
 * default run shows it; pass --headless only for static checks.
 *
 *   npm run build && npx electron-builder --win --dir --x64
 *   node scripts/electron-ui-verification.mjs
 */
import { createHash } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { mkdir, readFile, writeFile, stat, rm } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const appPath = path.join(root, 'dist', 'win-unpacked', 'DonDownload.exe')
const runDir = path.join(root, 'artifacts', 'test-runs', `electron-ui-${new Date().toISOString().replace(/[:.]/g, '-')}`)
const userData = path.join(runDir, 'user-data')
const downloadDir = path.join(userData, 'smoke-downloads')
const screenshotDir = path.join(runDir, 'screenshots')
const cdpPort = 19335
const startedAt = new Date().toISOString()
// A normal (non-smoke) launch downloads into the real Downloads/DonDownload
// folder, so a unique name avoids collisions and makes cleanup safe.
const fileName = `controlled-${startedAt.replace(/[:.]/g, '-')}.bin`
const fixturePath = `/${fileName}`
const fileSize = 16 * 1024 * 1024
const fixtureBytes = 64 * 1024
const fixtureDelayMs = 800

await mkdir(screenshotDir, { recursive: true })

function sleep(ms) { return delay(ms) }

const fixtureServer = createServer(async (request, response) => {
  if (request.url !== fixturePath) {
    response.writeHead(404).end('not found')
    return
  }
  const range = /^bytes=(\d+)-(\d*)$/i.exec(request.headers.range ?? '')
  const start = range ? Number(range[1]) : 0
  const end = range?.[2] ? Math.min(Number(range[2]), fileSize - 1) : fileSize - 1
  const length = Math.max(0, end - start + 1)
  response.writeHead(range ? 206 : 200, {
    'accept-ranges': 'bytes',
    'content-length': String(length),
    'content-type': 'application/octet-stream',
    'content-disposition': `attachment; filename="${fileName}"`,
    ...(range ? { 'content-range': `bytes ${start}-${end}/${fileSize}` } : {})
  })
  async function* chunks() {
    for (let offset = start; offset <= end; offset += fixtureBytes) {
      if (response.destroyed) return
      const count = Math.min(fixtureBytes, end - offset + 1)
      const chunk = Buffer.allocUnsafe(count)
      for (let index = 0; index < count; index += 1) {
        chunk[index] = (offset + index) % 251
      }
      yield chunk
      await sleep(fixtureDelayMs)
    }
  }
  Readable.from(chunks()).pipe(response)
})
await new Promise((resolve, reject) => {
  fixtureServer.once('error', reject)
  fixtureServer.listen(0, '127.0.0.1', resolve)
})
const fixtureAddress = fixtureServer.address()
const fixtureUrl = `http://127.0.0.1:${fixtureAddress.port}${fixturePath}`

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.nextId = 1
    this.pending = new Map()
    this.listeners = new Map()
    this.ws.addEventListener('message', event => {
      const message = JSON.parse(event.data.toString())
      if (message.id) {
        const waiter = this.pending.get(message.id)
        if (waiter) {
          this.pending.delete(message.id)
          message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result)
        }
      } else {
        for (const listener of this.listeners.get(message.method) ?? []) listener(message.params)
      }
    })
  }
  async ready() {
    if (this.ws.readyState === WebSocket.OPEN) return
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true })
      this.ws.addEventListener('error', reject, { once: true })
    })
  }
  on(method, listener) {
    const current = this.listeners.get(method) ?? []
    current.push(listener)
    this.listeners.set(method, current)
  }
  command(method, params = {}) {
    const id = this.nextId++
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP command timed out: ${method}`))
      }, 15_000)
      this.pending.set(id, {
        resolve: value => { clearTimeout(timeout); resolve(value) },
        reject: error => { clearTimeout(timeout); reject(error) }
      })
    })
  }
  async evaluate(expression) {
    const result = await this.command('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true
    })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
    return result.result?.value
  }
  async screenshot(name) {
    const result = await this.command('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true
    })
    const target = path.join(screenshotDir, name)
    await writeFile(target, Buffer.from(result.data, 'base64'))
    return target
  }
  close() { try { this.ws.close() } catch {} }
}

let appProcess = null
let cdp = null
const results = []
let rpcInfo = null

function record(name, details) {
  results.push({ name, ...details })
  console.log(`${name}: ${JSON.stringify(details)}`)
}

// Delta snapshots are suppressed while the window is hidden, so the live UI
// checks need a visible window. Pass --headless only for static checks on a
// machine without a desktop (progress/pause checks will not run there).
const VISIBLE = !process.argv.includes('--headless')

function appEnvironment() {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  if (VISIBLE) {
    // A normal launch (not the smoke harness) is the only way to get a visible
    // window, and the delta publishers deliberately send nothing while hidden.
    delete env.DONDOWNLOAD_SMOKE_TEST
    delete env.DONDOWNLOAD_INTERACTIVE_SMOKE
    delete env.DONDOWNLOAD_SMOKE_RESULT_PATH
  } else {
    env.DONDOWNLOAD_SMOKE_TEST = '1'
    env.DONDOWNLOAD_INTERACTIVE_SMOKE = '1'
    env.DONDOWNLOAD_SMOKE_RESULT_PATH = path.join(userData, 'smoke-result.json')
  }
  for (const name of ['DONDOWNLOAD_ARIA2_PATH', 'DONDOWNLOAD_YTDLP_PATH', 'DONDOWNLOAD_FFMPEG_PATH', 'DONDOWNLOAD_FFPROBE_PATH', 'DONDOWNLOAD_DENO_PATH']) delete env[name]
  return env
}

async function startApp() {
  appProcess = spawn(appPath, [
    `--user-data-dir=${userData}`,
    `--remote-debugging-port=${cdpPort}`,
    '--remote-debugging-address=127.0.0.1',
    ...(VISIBLE ? [] : ['--smoke-test', '--headless'])
  ], {
    cwd: path.dirname(appPath),
    env: appEnvironment(),
    // windowsHide also keeps BrowserWindow.isVisible() false on Windows, which
    // suppresses every delta snapshot; the visible mode must not set it.
    windowsHide: !VISIBLE,
    stdio: ['ignore', 'ignore', 'pipe']
  })
  appProcess.stderr.on('data', chunk => {
    const line = chunk.toString()
    if (/INTERACTIVE_READY|ERROR|FAIL/i.test(line)) process.stderr.write(line)
  })
  const endpoint = `http://127.0.0.1:${cdpPort}/json/list`
  let target
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    if (appProcess.exitCode !== null) throw new Error(`Electron exited early: ${appProcess.exitCode}`)
    try {
      const response = await fetch(endpoint)
      if (response.ok) {
        const targets = await response.json()
        target = targets.find(entry => entry.type === 'page' && entry.webSocketDebuggerUrl)
        if (target) break
      }
    } catch {}
    await sleep(150)
  }
  if (!target) throw new Error('Could not attach to the real Electron renderer through CDP.')
  cdp = new Cdp(target.webSocketDebuggerUrl)
  await cdp.ready()
  await cdp.command('Page.enable')
  await cdp.command('Runtime.enable')
  const ready = await waitFor(async () => cdp.evaluate(`({
    title: document.title,
    rendered: !!document.querySelector('#root')?.children.length,
    preload: typeof window.donDownload?.getSnapshot === 'function',
    snapshot: window.donDownload ? null : 'preload-missing'
  })`), value => value?.rendered && value?.preload, 30_000)
  record('actual-electron-startup', { title: ready.title, renderer: ready.rendered, preloadApi: ready.preload, windowVisible: false })
  return cdp
}

async function stopApp() {
  cdp?.close()
  cdp = null
  if (!appProcess || appProcess.exitCode !== null) return
  const pid = appProcess.pid
  execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  await new Promise(resolve => appProcess.once('exit', resolve))
  appProcess = null
}

async function waitFor(read, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await read()
    if (predicate(last)) return last
    await sleep(200)
  }
  throw new Error(`Timed out waiting for condition; last=${JSON.stringify(last)}`)
}

async function setInput(selector, value) {
  const serialized = JSON.stringify(String(value))
  const found = await cdp.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)})
    if (!element) return false
    const prototype = element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value').set
    setter.call(element, ${serialized})
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })()`)
  if (!found) throw new Error(`Could not find input: ${selector}`)
}

async function clickButton(label, scopeSelector = 'body') {
  const clicked = await cdp.evaluate(`(() => {
    const root = document.querySelector(${JSON.stringify(scopeSelector)})
    const button = [...(root ?? document).querySelectorAll('button')]
      .find(item => item.innerText.trim() === ${JSON.stringify(label)} && !item.disabled)
    if (!button) return false
    button.click()
    return true
  })()`)
  if (!clicked) throw new Error(`Could not click enabled button: ${label}`)
}

async function clickAriaLabel(label) {
  const selector = `button[aria-label="${label}"]`
  const clicked = await cdp.evaluate(`(() => {
    const button = document.querySelector(${JSON.stringify(selector)})
    if (!button || button.disabled) return false
    button.click()
    return true
  })()`)
  if (!clicked) throw new Error(`Could not click button with aria-label: ${label}`)
}

async function openSettings() {
  await clickAriaLabel('Settings')
  await waitFor(
    () => cdp.evaluate(`document.querySelector('#settings-heading')?.innerText ?? ''`),
    text => typeof text === 'string' && text.length > 0
  )
  await cdp.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  await sleep(200)
}

async function backToDownloads() {
  const clicked = await cdp.evaluate(`(() => {
    const button = document.querySelector('button[title="Back to downloads"]')
    if (!button) return false
    button.click()
    return true
  })()`)
  if (!clicked) throw new Error('Could not click Back to downloads')
  await waitFor(
    () => cdp.evaluate(`document.querySelector('button[aria-label="Settings"]')?.getAttribute('aria-current') ?? null`),
    value => value === null
  )
  await cdp.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  await sleep(200)
}

async function scrollCardIntoView() {
  const found = await cdp.evaluate(`(() => {
    const row = [...document.querySelectorAll('div[role="row"]')]
      .find(item => item.querySelector('p')?.innerText.trim() === ${JSON.stringify(fileName)})
    row?.scrollIntoView({ block: 'center', behavior: 'instant' })
    return Boolean(row)
  })()`)
  if (!found) throw new Error('Could not scroll the real download row into view.')
}

async function scrollSettingsIntoView() {
  await cdp.evaluate(`document.querySelector('#settings-heading')?.scrollIntoView({ block: 'start', behavior: 'instant' })`)
}

async function cardState() {
  return cdp.evaluate(`(() => {
    const row = [...document.querySelectorAll('div[role="row"]')]
      .find(item => item.querySelector('p')?.innerText.trim() === ${JSON.stringify(fileName)})
    if (!row) return null
    const text = row.innerText
    const percent = Number((text.match(/(\\d+)%/) || [0, '0'])[1])
    return { text, percent }
  })()`)
}

function readAria2Args() {
  const appPid = appProcess.pid
  const ps = `$all = Get-CimInstance Win32_Process; $ids = [System.Collections.Generic.HashSet[int]]::new(); [void]$ids.Add(${appPid}); $changed = $true; while ($changed) { $changed = $false; foreach ($p in $all) { if ($ids.Contains([int]$p.ParentProcessId) -and $ids.Add([int]$p.ProcessId)) { $changed = $true } } }; $all | Where-Object { $ids.Contains([int]$_.ProcessId) -and $_.Name -match '^aria2c(.exe)?$' } | Select-Object -First 1 -ExpandProperty CommandLine`
  const commandLine = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true }).trim()
  const port = /--rpc-listen-port=(\d+)/.exec(commandLine)?.[1]
  const secret = /--rpc-secret=([^\s]+)/.exec(commandLine)?.[1]
  if (!port || !secret) throw new Error('Could not locate this app session\'s aria2 RPC endpoint.')
  return { port: Number(port), secret }
}

async function getAria2Limit() {
  if (!rpcInfo) rpcInfo = readAria2Args()
  const response = await fetch(`http://127.0.0.1:${rpcInfo.port}/jsonrpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'gui-check', method: 'aria2.getGlobalOption', params: [`token:${rpcInfo.secret}`] })
  })
  const payload = await response.json()
  if (payload.error) throw new Error('aria2.getGlobalOption failed.')
  return payload.result['max-overall-download-limit']
}

async function startRendererTrace() {
  let resolveTrace
  const completed = new Promise(resolve => { resolveTrace = resolve })
  cdp.on('Tracing.tracingComplete', resolveTrace)
  await cdp.command('Tracing.start', {
    categories: 'devtools.timeline,blink.user_timing,v8.execute',
    transferMode: 'ReturnAsStream'
  })
  return async () => {
    await cdp.command('Tracing.end')
    const result = await Promise.race([
      completed,
      sleep(15_000).then(() => { throw new Error('Renderer trace did not flush.') })
    ])
    if (!result.stream) throw new Error('Renderer trace did not return a stream.')
    let trace = ''
    let eof = false
    while (!eof) {
      const chunk = await cdp.command('IO.read', { handle: result.stream, size: 1024 * 1024 })
      trace += chunk.base64Encoded ? Buffer.from(chunk.data, 'base64').toString('utf8') : chunk.data
      eof = chunk.eof
    }
    await cdp.command('IO.close', { handle: result.stream })
    const target = path.join(runDir, 'renderer-trace.json')
    await writeFile(target, trace)
    return { path: target, bytes: Buffer.byteLength(trace) }
  }
}

async function run() {
  if (!(await stat(appPath).catch(() => null))) throw new Error(`Packaged app missing: ${appPath}`)
  const serverAddress = fixtureServer.address()
  record('loopback-fixture', { url: fixtureUrl, bytes: fileSize, throttled: true, bind: serverAddress.address })

  await startApp()
  await waitFor(() => cdp.evaluate(`window.donDownload.getSnapshot().then(result => result.ok && result.value.aria2.status === 'ready')`), Boolean, 30_000)
  const initial = await cdp.evaluate(`window.donDownload.getSnapshot()`)
  if (!initial.ok || initial.value.downloads.length !== 0) throw new Error('Isolated app did not start with an empty download list.')
  const finishTrace = await startRendererTrace()

  await cdp.screenshot('01-quick-add.png')
  record('quick-add-screenshot', { path: path.join(screenshotDir, '01-quick-add.png'), actualElectron: true })

  await clickButton('Add')
  await waitFor(
    () => cdp.evaluate(`!!document.getElementById('add-links')`),
    Boolean
  )
  await setInput('#add-links', fixtureUrl)
  // The footer action turns into "Download" once the pasted URL is a direct file.
  await waitFor(
    () => cdp.evaluate(`[...document.querySelectorAll('button')].some(item => item.innerText.trim() === 'Download' && !item.disabled)`),
    Boolean
  )
  await clickButton('Download')
  let active = await waitFor(cardState, state => state && state.percent > 0, 20_000)
  await scrollCardIntoView()
  await cdp.screenshot('02-in-progress.png')
  record('real-download-progress', { filename: fileName, percent: active.percent, cardText: active.text.replace(/\s+/g, ' ').slice(0, 260), screenshot: path.join(screenshotDir, '02-in-progress.png') })

  await clickAriaLabel(`Pause ${fileName}`)
  const paused = await waitFor(cardState, state => state && state.text.toLowerCase().includes('paused'))
  await scrollCardIntoView()
  await cdp.screenshot('03-paused.png')
  record('pause-control', { status: 'paused', percent: paused.percent, screenshot: path.join(screenshotDir, '03-paused.png') })

  await clickAriaLabel(`Resume ${fileName}`)
  await waitFor(cardState, state => state && !state.text.toLowerCase().includes('paused'), 15_000)
  await waitFor(async () => cardState(), state => state && state.percent > paused.percent, 15_000)
  record('resume-control', { status: 'downloading', percentAfterResume: (await cardState()).percent })

  const completed = await waitFor(cardState, state => state && state.text.toLowerCase().includes('done'), 180_000)
  const completedSnapshot = await cdp.evaluate(`window.donDownload.getSnapshot()`)
  const completedItem = completedSnapshot.ok
    ? completedSnapshot.value.downloads.find(item => item.filename === fileName)
    : null
  if (!completedItem || typeof completedItem.filePath !== 'string') throw new Error(`Completed download has no file path: ${JSON.stringify(completedItem)}`)
  const outputPath = completedItem.filePath
  const output = await readFile(outputPath)
  if (output.length !== fileSize) throw new Error(`Output size mismatch: expected ${fileSize}, got ${output.length}`)
  const expected = createHash('sha256')
  for (let offset = 0; offset < fileSize; offset += fixtureBytes) {
    const part = Buffer.allocUnsafe(Math.min(fixtureBytes, fileSize - offset))
    for (let index = 0; index < part.length; index += 1) part[index] = (offset + index) % 251
    expected.update(part)
  }
  const hash = createHash('sha256').update(output).digest('hex')
  if (hash !== expected.digest('hex')) throw new Error('Downloaded output SHA-256 did not match the controlled fixture.')
  await scrollCardIntoView()
  await cdp.screenshot('06-completed.png')
  record('completed-output', { status: 'complete', percent: completed.percent, bytes: output.length, sha256: hash, path: outputPath, screenshot: path.join(screenshotDir, '06-completed.png') })
  const trace = await finishTrace()
  record('renderer-trace', trace)

  // Settings are checked after the transfer so a live speed-limit change cannot
  // interfere with the pause/resume timing.
  await openSettings()
  await scrollSettingsIntoView()
  await cdp.screenshot('04-settings-before-change.png')
  await setInput('input[aria-label="Global speed limit in MB per second"]', 0.262144)
  // Settings auto-save; wait for the saved status and the live aria2 limit.
  const saveMessage = await waitFor(
    () => cdp.evaluate(`[...document.querySelectorAll('[aria-labelledby="settings-heading"] [role="status"]')].map(node => node.innerText.trim()).find(text => text.includes('Saved')) ?? ''`),
    text => text.includes('Saved')
  )
  const liveLimit = await waitFor(getAria2Limit, value => value === '262144', 10_000)
  await cdp.screenshot('05-settings-saved.png')
  record('settings-live-engine', { uiMessage: saveMessage, aria2MaxOverallDownloadLimitBps: liveLimit, screenshot: path.join(screenshotDir, '05-settings-saved.png') })

  await backToDownloads()
  await clickAriaLabel('Batches')
  await waitFor(
    () => cdp.evaluate(`document.body.innerText.toLowerCase().includes('batch')`),
    Boolean
  )
  await cdp.screenshot('09-batches.png')
  record('batches-page-screenshot', { path: path.join(screenshotDir, '09-batches.png'), actualElectron: true })
  await backToDownloads()

  const savedSettings = await cdp.evaluate(`window.donDownload.getSettings()`)
  if (!savedSettings.ok || savedSettings.value.globalSpeedLimitBps !== 262144) throw new Error('Settings IPC snapshot does not contain the saved global speed limit.')

  await stopApp()
  rpcInfo = null
  await startApp()
  await waitFor(() => cdp.evaluate(`window.donDownload.getSnapshot().then(result => result.ok && result.value.aria2.status === 'ready')`), Boolean, 30_000)
  const persisted = await cdp.evaluate(`Promise.all([window.donDownload.getSnapshot(), window.donDownload.getSettings()])`)
  const persistedItem = persisted[0].value.downloads.find(item => item.filename === fileName)
  if (!persistedItem || persistedItem.status !== 'complete') throw new Error(`Completed item did not persist after relaunch: ${JSON.stringify(persistedItem)}`)
  if (!persisted[1].ok || persisted[1].value.globalSpeedLimitBps !== 262144) throw new Error('Settings did not persist after relaunch.')
  const relaunchedLimit = await getAria2Limit()
  if (relaunchedLimit !== '262144') throw new Error(`aria2 did not restore persisted global limit; got ${relaunchedLimit}`)
  await scrollCardIntoView()
  await cdp.screenshot('07-relaunched-persisted.png')
  record('relaunch-persistence', { downloadStatus: persistedItem.status, globalSpeedLimitBps: persisted[1].value.globalSpeedLimitBps, aria2RestoredLimitBps: relaunchedLimit, screenshot: path.join(screenshotDir, '07-relaunched-persisted.png') })
  // A normal launch downloads into the real Downloads folder; leave no artifact.
  await rm(outputPath, { force: true }).catch(() => undefined)

  await cdp.command('Emulation.setDeviceMetricsOverride', {
    width: 375,
    height: 820,
    deviceScaleFactor: 1,
    mobile: false
  })
  await cdp.screenshot('11-narrow-downloads.png')
  const narrowMetrics = await cdp.evaluate(`({ width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth, navWidth: document.querySelector('nav[aria-label="Sections"]')?.getBoundingClientRect().width })`)
  if (narrowMetrics.scrollWidth > narrowMetrics.width) throw new Error(`Narrow layout overflows horizontally: ${JSON.stringify(narrowMetrics)}`)
  record('narrow-layout', { ...narrowMetrics, screenshot: path.join(screenshotDir, '11-narrow-downloads.png') })
  await cdp.command('Emulation.clearDeviceMetricsOverride')

  const report = { status: 'PASS', startedAt, app: appPath, renderer: 'actual packaged Electron renderer + production preload + trusted IPC', fixtureUrl, fixtureBytes: fileSize, userData, downloadDir, screenshots: screenshotDir, checks: results }
  await writeFile(path.join(runDir, 'result.json'), JSON.stringify(report, null, 2))
  console.log(`UI_RESULT ${path.join(runDir, 'result.json')}`)
}

try {
  await run()
} catch (error) {
  const report = { status: 'FAIL', error: error instanceof Error ? error.stack ?? error.message : String(error), userData, downloadDir, screenshots: screenshotDir, checks: results }
  await writeFile(path.join(runDir, 'result.json'), JSON.stringify(report, null, 2)).catch(() => {})
  console.error(`UI_FAIL ${report.error}`)
  process.exitCode = 1
} finally {
  await stopApp().catch(error => console.error(`App cleanup warning: ${error.message}`))
  await new Promise(resolve => fixtureServer.close(resolve))
}
