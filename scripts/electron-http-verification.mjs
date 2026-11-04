#!/usr/bin/env node
/** Real packaged Electron HTTP verification against small public fixtures. */
import { createHash } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const appPath = path.join(root, 'dist', 'win-unpacked', 'DonDownload.exe')
const runDir = path.join(root, 'artifacts', 'test-runs', `electron-http-${new Date().toISOString().replace(/[:.]/g, '-')}`)
const userData = path.join(runDir, 'user-data')
const downloadDir = path.join(userData, 'smoke-downloads')
const screenshotDir = path.join(runDir, 'screenshots')
const cdpPort = 19342
const redirectUrl = 'https://github.com/github/gitignore/raw/refs/heads/main/Global/Windows.gitignore'
const rangeUrl = 'https://proof.ovh.net/files/1Mb.dat'
const notFoundUrl = 'https://raw.githubusercontent.com/github/gitignore/refs/heads/main/Global/DonDownload-verification-file-that-does-not-exist'
const expectedRedirectName = 'Windows.gitignore'
const expectedRangeName = '1Mb.dat'
const maxFixtureBytes = 1024 * 1024
const startedAt = new Date().toISOString()

await mkdir(screenshotDir, { recursive: true })

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.nextId = 1
    this.pending = new Map()
    this.listeners = new Map()
    this.ws.addEventListener('message', event => {
      const message = JSON.parse(event.data.toString())
      if (message.id) {
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result)
        return
      }
      for (const listener of this.listeners.get(message.method) ?? []) listener(message.params)
    })
  }
  async ready() {
    if (this.ws.readyState === WebSocket.OPEN) return
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true })
      this.ws.addEventListener('error', reject, { once: true })
    })
  }
  command(method, params = {}) {
    const id = this.nextId++
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP command timed out: ${method}`))
      }, 20_000)
      this.pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value) },
        reject: error => { clearTimeout(timer); reject(error) }
      })
    })
  }
  on(method, callback) {
    const listeners = this.listeners.get(method) ?? []
    listeners.push(callback)
    this.listeners.set(method, listeners)
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
    const result = await this.command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
    const target = path.join(screenshotDir, name)
    await writeFile(target, Buffer.from(result.data, 'base64'))
    return target
  }
  close() { try { this.ws.close() } catch {} }
}

let appProcess = null
let cdp = null
let traceComplete
const checks = []

function record(name, data) {
  checks.push({ name, ...data })
  console.log(`${name}: ${JSON.stringify(data)}`)
}

const sleep = ms => delay(ms)

async function waitFor(read, predicate, timeoutMs, label) {
  const end = Date.now() + timeoutMs
  let last
  while (Date.now() < end) {
    last = await read()
    if (predicate(last)) return last
    await sleep(200)
  }
  throw new Error(`${label} timed out; last=${JSON.stringify(last)}`)
}

async function setInput(selector, value) {
  const found = await cdp.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)})
    if (!element) return false
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(element, ${JSON.stringify(String(value))})
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })()`)
  if (!found) throw new Error(`Input not found: ${selector}`)
}

async function clickButton(label) {
  const clicked = await cdp.evaluate(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find(item => item.innerText.trim() === ${JSON.stringify(label)} && !item.disabled)
    button?.click()
    return Boolean(button)
  })()`)
  if (!clicked) throw new Error(`Enabled button not found: ${label}`)
}

async function snapshot() {
  return cdp.evaluate('window.donDownload.getSnapshot()')
}

async function findFiles(directory) {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) result.push(...await findFiles(target))
    else result.push(target)
  }
  return result
}

async function startApp() {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  for (const name of ['DONDOWNLOAD_ARIA2_PATH', 'DONDOWNLOAD_YTDLP_PATH', 'DONDOWNLOAD_FFMPEG_PATH', 'DONDOWNLOAD_FFPROBE_PATH', 'DONDOWNLOAD_DENO_PATH']) delete env[name]
  env.DONDOWNLOAD_SMOKE_TEST = '1'
  env.DONDOWNLOAD_INTERACTIVE_SMOKE = '1'
  env.DONDOWNLOAD_SMOKE_RESULT_PATH = path.join(userData, 'smoke-result.json')
  appProcess = spawn(appPath, [
    '--smoke-test', `--user-data-dir=${userData}`,
    `--remote-debugging-port=${cdpPort}`, '--remote-debugging-address=127.0.0.1', '--headless'
  ], { cwd: path.dirname(appPath), env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
  appProcess.stderr.on('data', chunk => {
    const text = chunk.toString()
    if (/INTERACTIVE_READY|ERROR|FAIL/i.test(text)) process.stderr.write(text)
  })
  const target = await waitFor(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`)
      if (!response.ok) return null
      return (await response.json()).find(item => item.type === 'page' && item.webSocketDebuggerUrl) ?? null
    } catch { return null }
  }, value => value !== null, 45_000, 'Electron CDP target')
  cdp = new Cdp(target.webSocketDebuggerUrl)
  await cdp.ready()
  await cdp.command('Page.enable')
  await cdp.command('Runtime.enable')
  const ready = await waitFor(
    () => cdp.evaluate(`({title:document.title,rendered:!!document.querySelector('#root')?.children.length,preload:typeof window.donDownload?.getSnapshot==='function'})`),
    value => value?.rendered && value?.preload,
    30_000,
    'Production renderer/preload'
  )
  record('production-electron-startup', { ...ready, windowVisible: false, userData })
  let resolveTrace
  const trace = new Promise(resolve => { resolveTrace = resolve })
  cdp.on('Tracing.tracingComplete', resolveTrace)
  traceComplete = trace
  await cdp.command('Tracing.start', { categories: 'devtools.timeline,blink.user_timing,v8.execute', transferMode: 'ReturnAsStream' })
}

async function stopApp() {
  cdp?.close()
  cdp = null
  if (!appProcess || appProcess.exitCode !== null) return
  execFileSync('taskkill', ['/pid', String(appProcess.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  await new Promise(resolve => appProcess.once('exit', resolve))
  appProcess = null
}

async function saveTrace() {
  await cdp.command('Tracing.end')
  const complete = await Promise.race([traceComplete, sleep(20_000).then(() => { throw new Error('Trace flush timeout') })])
  let data = ''
  let eof = false
  while (!eof) {
    const part = await cdp.command('IO.read', { handle: complete.stream, size: 1024 * 1024 })
    data += part.base64Encoded ? Buffer.from(part.data, 'base64').toString('utf8') : part.data
    eof = part.eof
  }
  await cdp.command('IO.close', { handle: complete.stream })
  const tracePath = path.join(runDir, 'renderer-trace.json')
  await writeFile(tracePath, data)
  record('renderer-trace', { path: tracePath, bytes: (await stat(tracePath)).size })
}

async function downloadState(filename) {
  return cdp.evaluate(`(() => {
    const item = window.__lastSnapshot?.downloads?.find(value => value.filename === ${JSON.stringify(filename)})
    const card = [...document.querySelectorAll('article')].find(value => value.querySelector('h3')?.innerText.trim() === ${JSON.stringify(filename)})
    const bar = card?.querySelector('[role="progressbar"]')
    return {item: item ?? null, text: card?.innerText ?? '', percent: Number(bar?.getAttribute('aria-valuenow') ?? 0)}
  })()`)
}

async function waitDownload(filename, predicate, timeoutMs, label) {
  return waitFor(async () => {
    const api = await snapshot()
    if (!api.ok) return { error: api.error }
    await cdp.evaluate(`window.__lastSnapshot = ${JSON.stringify(api.value)}`)
    return downloadState(filename)
  }, value => predicate(value), timeoutMs, label)
}

async function addUrl(url, filename = '', speedMiB = '') {
  await setInput('#download-url', url)
  if (filename) await setInput('#download-filename', filename)
  if (speedMiB) {
    const details = await cdp.evaluate(`(() => {
      const summary = [...document.querySelectorAll('summary')].find(item => item.innerText.includes('Schedule & limits'))
      if (summary && !summary.parentElement.open) summary.parentElement.open = true
      return Boolean(summary)
    })()`)
    if (!details) throw new Error('Quick Add limits disclosure was not found.')
    await setInput('input[aria-label="Download speed limit in MiB per second"]', speedMiB)
  }
  await clickButton('Add download')
}

async function preflight(url, requireRange = false) {
  const response = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error(`Fixture preflight failed for ${url}: HTTP ${response.status}`)
  const length = Number(response.headers.get('content-length'))
  const acceptsRanges = /bytes/i.test(response.headers.get('accept-ranges') ?? '')
  if (!Number.isSafeInteger(length) || length <= 0 || length > maxFixtureBytes) throw new Error(`Fixture exceeds bound or has unknown size: ${length}`)
  if (requireRange && !acceptsRanges) throw new Error(`Fixture does not advertise Range support: ${url}`)
  const bodyResponse = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20_000) })
  if (!bodyResponse.ok) throw new Error(`Fixture body check failed: HTTP ${bodyResponse.status}`)
  const bytes = Buffer.from(await bodyResponse.arrayBuffer())
  if (bytes.length <= 0 || bytes.length > maxFixtureBytes) throw new Error(`Fixture body exceeds bound or is empty: ${bytes.length}`)
  return { finalUrl: bodyResponse.url, bytes: bytes.length, declaredLength: length, acceptsRanges, sha256: createHash('sha256').update(bytes).digest('hex') }
}

async function run() {
  if (!(await stat(appPath).catch(() => null))) throw new Error(`Packaged app missing: ${appPath}`)
  const [redirectFixture, rangeFixture] = await Promise.all([
    preflight(redirectUrl),
    preflight(rangeUrl, true)
  ])
  record('public-fixture-preflight', {
    redirect: { initialUrl: redirectUrl, finalUrl: redirectFixture.finalUrl, bytes: redirectFixture.bytes, sha256: redirectFixture.sha256 },
    range: { url: rangeUrl, bytes: rangeFixture.bytes, acceptsRanges: rangeFixture.acceptsRanges, sha256: rangeFixture.sha256 }
  })
  await startApp()
  const initial = await snapshot()
  if (!initial.ok || initial.value.downloads.length !== 0) throw new Error('Isolated download list was not empty at startup.')

  await cdp.screenshot('01-quick-add.png')
  await addUrl(redirectUrl)
  const redirectDone = await waitDownload(expectedRedirectName, value => value?.item?.status === 'complete', 30_000, 'Redirected GitHub download')
  const redirectPath = path.join(downloadDir, expectedRedirectName)
  const redirectBytes = await readFile(redirectPath)
  const redirectHash = createHash('sha256').update(redirectBytes).digest('hex')
  if (redirectBytes.length !== redirectFixture.bytes || redirectHash !== redirectFixture.sha256) throw new Error('Redirected download did not match its preflight fixture bytes/hash.')
  await cdp.screenshot('02-redirect-complete.png')
  record('redirect-and-filename', { status: redirectDone.item.status, filename: expectedRedirectName, bytes: redirectBytes.length, sha256: redirectHash, finalUrl: redirectFixture.finalUrl, screenshot: path.join(screenshotDir, '02-redirect-complete.png') })

  // Completed records are not unfinished duplicates in the manager's policy;
  // an intentional re-download of an already-complete URL is accepted.
  await addUrl(redirectUrl)
  const afterCompletedRepeat = await waitFor(snapshot, value => value?.ok && value.value.downloads.length === 2 && value.value.downloads.filter(item => item.url === redirectUrl && item.status === 'complete').length === 2, 30_000, 'Completed URL re-download')
  const completedRepeats = afterCompletedRepeat.value.downloads.filter(item => item.url === redirectUrl && item.status === 'complete')
  if (completedRepeats.length !== 2) throw new Error(`Expected the completed URL to permit an intentional re-download; got ${completedRepeats.length} completed records.`)
  await cdp.screenshot('03-completed-repeat.png')
  record('completed-url-repeat', { result: 'allowed after completion', records: completedRepeats.length, filenames: completedRepeats.map(item => item.filename), screenshot: path.join(screenshotDir, '03-completed-repeat.png') })

  await addUrl(rangeUrl, '', '0.10')
  const active = await waitDownload(expectedRangeName, value => value?.item?.status === 'active' && value.percent > 0, 25_000, 'Range-capable active download')
  await cdp.screenshot('04-range-active.png')
  record('range-active-progress', { status: active.item.status, completedBytes: active.item.completedBytes, percent: active.percent, screenshot: path.join(screenshotDir, '04-range-active.png') })
  const countBeforeActiveRepeat = (await snapshot()).value.downloads.length
  await addUrl(rangeUrl)
  const duplicate = await waitFor(
    () => cdp.evaluate(`({text:document.body.innerText,again:[...document.querySelectorAll('button')].some(button=>button.innerText.includes('Download again'))})`),
    value => value.text.includes('already queued or downloading') && value.again,
    10_000,
    'Active URL duplicate confirmation'
  )
  const afterActiveRepeat = await snapshot()
  if (!afterActiveRepeat.ok || afterActiveRepeat.value.downloads.length !== countBeforeActiveRepeat) throw new Error('Active duplicate submission created a second download record.')
  await cdp.screenshot('05-active-duplicate-warning.png')
  record('active-duplicate-handling', { warning: true, noSecondTransfer: true, screenshot: path.join(screenshotDir, '05-active-duplicate-warning.png') })
  await clickButton('Pause')
  const paused = await waitDownload(expectedRangeName, value => value?.item?.status === 'paused', 10_000, 'Pause transition')
  await cdp.screenshot('06-range-paused.png')
  record('range-pause', { status: paused.item.status, completedBytes: paused.item.completedBytes, screenshot: path.join(screenshotDir, '06-range-paused.png') })
  await clickButton('Resume')
  const resumed = await waitDownload(expectedRangeName, value => value?.item?.status === 'active', 10_000, 'Resume transition')
  if (resumed.item.completedBytes < paused.item.completedBytes) throw new Error('Resume progress regressed below the paused offset.')
  const rangeComplete = await waitDownload(expectedRangeName, value => value?.item?.status === 'complete', 90_000, 'Range download completion')
  const rangePath = path.join(downloadDir, expectedRangeName)
  const rangeBytes = await readFile(rangePath)
  const rangeHash = createHash('sha256').update(rangeBytes).digest('hex')
  if (rangeBytes.length !== rangeFixture.bytes || rangeHash !== rangeFixture.sha256) throw new Error('Resumed download did not match its preflight fixture bytes/hash.')
  await cdp.screenshot('07-range-complete.png')
  record('range-resume-integrity', { status: rangeComplete.item.status, filename: expectedRangeName, bytes: rangeBytes.length, sha256: rangeHash, pausedAtBytes: paused.item.completedBytes, screenshot: path.join(screenshotDir, '07-range-complete.png') })

  await addUrl(notFoundUrl, 'missing-fixture.txt')
  const failed = await waitDownload('missing-fixture.txt', value => value?.item?.status === 'error', 45_000, 'Unavailable HTTP file error')
  if (!failed.item.errorMessage) throw new Error('Unavailable download showed error status without an actionable message.')
  await cdp.screenshot('08-http-error.png')
  record('http-404-error', { status: failed.item.status, message: failed.item.errorMessage, screenshot: path.join(screenshotDir, '08-http-error.png') })

  await cdp.command('Tracing.end')
  const trace = await Promise.race([traceComplete, sleep(20_000).then(() => { throw new Error('Renderer trace did not flush.') })])
  let traceText = ''
  let eof = false
  while (!eof) {
    const part = await cdp.command('IO.read', { handle: trace.stream, size: 1024 * 1024 })
    traceText += part.base64Encoded ? Buffer.from(part.data, 'base64').toString('utf8') : part.data
    eof = part.eof
  }
  await cdp.command('IO.close', { handle: trace.stream })
  const tracePath = path.join(runDir, 'renderer-trace.json')
  await writeFile(tracePath, traceText)
  record('renderer-trace', { path: tracePath, bytes: Buffer.byteLength(traceText) })

  const report = { status: 'PASS', startedAt, finishedAt: new Date().toISOString(), app: appPath, renderer: 'actual packaged Electron renderer + preload/IPC + aria2', fixtures: { redirectUrl, rangeUrl, notFoundUrl }, userData, downloadDir, screenshots: screenshotDir, checks }
  await writeFile(path.join(runDir, 'result.json'), JSON.stringify(report, null, 2))
  console.log(`HTTP_RESULT ${path.join(runDir, 'result.json')}`)
}

try {
  await run()
} catch (error) {
  if (cdp) {
    try { await cdp.screenshot('99-failure-state.png') } catch {}
    try { await cdp.command('Tracing.end') } catch {}
  }
  const report = { status: 'FAIL', startedAt, finishedAt: new Date().toISOString(), error: error instanceof Error ? error.stack ?? error.message : String(error), userData, downloadDir, screenshots: screenshotDir, checks }
  await writeFile(path.join(runDir, 'result.json'), JSON.stringify(report, null, 2)).catch(() => {})
  console.error(`HTTP_FAIL ${report.error}`)
  process.exitCode = 1
} finally {
  await stopApp().catch(error => console.error(`Electron cleanup warning: ${error.message}`))
}
