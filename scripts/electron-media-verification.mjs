#!/usr/bin/env node
/**
 * One-shot real packaged Electron media workflow. It uses the production
 * renderer/preload/IPC and bundled media tools, never a browser profile or
 * cookies. Exactly one anonymous CC-BY media URL is analyzed and one explicitly
 * selected 144p video option is downloaded. No provider-limit retries.
 */
import { createHash } from 'node:crypto'
import { spawn, execFileSync, spawnSync } from 'node:child_process'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const appPath = path.join(root, 'dist', 'win-unpacked', 'DonDownload.exe')
const runDir = path.join(root, 'artifacts', 'test-runs', `electron-media-${new Date().toISOString().replace(/[:.]/g, '-')}`)
const userData = path.join(runDir, 'user-data')
const mediaDir = path.join(userData, 'smoke-downloads', 'Media')
const screenshotDir = path.join(runDir, 'screenshots')
const cdpPort = 19341
const fixtureUrl = 'https://www.youtube.com/watch?v=Z4C82eyhwgU'
const maxTransferBytes = 25 * 1024 * 1024
const maxDurationSeconds = 180
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
  on(method, callback) {
    const listeners = this.listeners.get(method) ?? []
    listeners.push(callback)
    this.listeners.set(method, listeners)
  }
  command(method, params = {}) {
    const id = this.nextId++
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP command timed out: ${method}`))
      }, 20_000)
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
let finishTrace = null
const checks = []

function record(name, detail) {
  checks.push({ name, ...detail })
  console.log(`${name}: ${JSON.stringify(detail)}`)
}

function sleep(ms) { return delay(ms) }

async function waitFor(read, predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await read()
    if (predicate(last)) return last
    await sleep(250)
  }
  throw new Error(`${label} timed out; last=${JSON.stringify(last)}`)
}

async function setInput(selector, value) {
  const found = await cdp.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)})
    if (!element) return false
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(element, ${JSON.stringify(value)})
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })()`)
  if (!found) throw new Error(`Input not found: ${selector}`)
}

async function clickButton(label) {
  const found = await cdp.evaluate(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find(item => item.innerText.trim() === ${JSON.stringify(label)} && !item.disabled)
    button?.click()
    return Boolean(button)
  })()`)
  if (!found) throw new Error(`Enabled button not found: ${label}`)
}

async function clickPage(label) {
  const found = await cdp.evaluate(`(() => {
    const button = [...document.querySelectorAll('nav[aria-label="Sections"] button')]
      .find(item => item.innerText.trim() === ${JSON.stringify(label)})
    button?.click()
    return Boolean(button)
  })()`)
  if (!found) throw new Error(`Navigation button not found: ${label}`)
  await waitFor(
    () => cdp.evaluate(`document.querySelector('nav[aria-label="Sections"] [aria-current="page"]')?.innerText.trim()`),
    value => value === label,
    10_000,
    `Navigation to ${label}`
  )
  await cdp.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  await sleep(200)
}

async function startTrace() {
  let resolveComplete
  const complete = new Promise(resolve => { resolveComplete = resolve })
  cdp.on('Tracing.tracingComplete', resolveComplete)
  await cdp.command('Tracing.start', {
    categories: 'devtools.timeline,blink.user_timing,v8.execute',
    transferMode: 'ReturnAsStream'
  })
  return async () => {
    await cdp.command('Tracing.end')
    const done = await Promise.race([
      complete,
      sleep(20_000).then(() => { throw new Error('Renderer trace did not flush.') })
    ])
    if (!done.stream) throw new Error('Renderer trace stream was not returned.')
    const chunks = []
    let eof = false
    while (!eof) {
      const result = await cdp.command('IO.read', { handle: done.stream, size: 1024 * 1024 })
      chunks.push(result.base64Encoded ? Buffer.from(result.data, 'base64') : Buffer.from(result.data))
      eof = result.eof
    }
    await cdp.command('IO.close', { handle: done.stream })
    const tracePath = path.join(runDir, 'renderer-trace.json')
    await writeFile(tracePath, Buffer.concat(chunks))
    return { path: tracePath, bytes: (await stat(tracePath)).size }
  }
}

async function startApp() {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  for (const name of [
    'DONDOWNLOAD_ARIA2_PATH', 'DONDOWNLOAD_YTDLP_PATH', 'DONDOWNLOAD_FFMPEG_PATH',
    'DONDOWNLOAD_FFPROBE_PATH', 'DONDOWNLOAD_DENO_PATH'
  ]) delete env[name]
  env.DONDOWNLOAD_SMOKE_TEST = '1'
  env.DONDOWNLOAD_INTERACTIVE_SMOKE = '1'
  env.DONDOWNLOAD_SMOKE_RESULT_PATH = path.join(userData, 'smoke-result.json')
  appProcess = spawn(appPath, [
    '--smoke-test',
    `--user-data-dir=${userData}`,
    `--remote-debugging-port=${cdpPort}`,
    '--remote-debugging-address=127.0.0.1',
    '--headless'
  ], {
    cwd: path.dirname(appPath),
    env,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe']
  })
  appProcess.stderr.on('data', chunk => {
    const line = chunk.toString()
    if (/INTERACTIVE_READY|ERROR|FAIL/i.test(line)) process.stderr.write(line)
  })
  const endpoint = `http://127.0.0.1:${cdpPort}/json/list`
  const target = await waitFor(async () => {
    try {
      const response = await fetch(endpoint)
      if (!response.ok) return null
      return (await response.json()).find(entry => entry.type === 'page' && entry.webSocketDebuggerUrl) ?? null
    } catch { return null }
  }, value => value !== null, 45_000, 'Electron CDP target')
  cdp = new Cdp(target.webSocketDebuggerUrl)
  await cdp.ready()
  await cdp.command('Page.enable')
  await cdp.command('Runtime.enable')
  const ready = await waitFor(
    () => cdp.evaluate(`({title:document.title,rendered:!!document.querySelector('#root')?.children.length,preload:typeof window.donDownload?.getMediaSnapshot==='function'})`),
    value => value?.rendered && value?.preload,
    30_000,
    'Production renderer/preload'
  )
  record('production-electron-startup', { ...ready, windowVisible: false, userData })
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

async function findFiles(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await findFiles(full))
    else files.push(full)
  }
  return files
}

async function snapshot() {
  return cdp.evaluate('window.donDownload.getMediaSnapshot()')
}

async function run() {
  if (!(await stat(appPath).catch(() => null))) throw new Error(`Packaged app missing: ${appPath}`)
  await startApp()
  await clickPage('Media')
  await waitFor(
    snapshot,
    value => value?.ok && ['ready', 'unavailable', 'error'].includes(value.value.tool.status),
    45_000,
    'Media tool probe'
  )
  const toolState = (await snapshot()).value.tool
  if (toolState.status !== 'ready') {
    await cdp.screenshot('01-media-engine-error.png')
    throw new Error(`Media tools are not ready: ${toolState.status}: ${toolState.message ?? toolState.hint ?? 'no detail'}`)
  }
  record('media-tools-ready', { version: toolState.version })
  finishTrace = await startTrace()

  await cdp.screenshot('01-media-input.png')
  await setInput('#media-url', fixtureUrl)
  await clickButton('Analyze')
  const analysis = await waitFor(
    () => cdp.evaluate(`({title:document.querySelector('form h3')?.innerText ?? null, options:[...document.querySelectorAll('input[name="media-option"]')].map(input=>({checked:input.checked,text:input.closest('label')?.innerText.replace(/\\s+/g,' ').trim() ?? ''})), error:document.querySelector('form [role="alert"]')?.innerText ?? null, busy:document.querySelector('form button[type="submit"]')?.innerText.includes('Analyzing') ?? false})`),
    value => value && ((value.options?.length ?? 0) > 0 || value.error),
    180_000,
    'Anonymous yt-dlp analysis'
  )
  if (analysis.error || analysis.options.length === 0) {
    await cdp.screenshot('02-media-analysis-error.png')
    record('media-analysis-failed', { message: analysis.error ?? 'No selectable formats', screenshot: path.join(screenshotDir, '02-media-analysis-error.png') })
    throw new Error(`Media analysis failed: ${analysis.error ?? 'No selectable formats'}`)
  }
  await cdp.screenshot('02-media-analysis.png')
  const mergeOptions = analysis.options.filter(option => /144p/i.test(option.text) && /merged/i.test(option.text))
  if (mergeOptions.length === 0) {
    record('media-analysis-formats', { title: analysis.title, options: analysis.options.map(option => option.text), selection: 'No 144p merged video option' })
    throw new Error('The pinned small fixture did not offer the previously verified 144p merged option; refusing to select a different, unbounded format.')
  }
  if (analysis.title !== '"Caminandes 2: Gran Dillama" - Blender Animated Short') {
    throw new Error(`Fixture title changed; refusing to download: ${analysis.title}`)
  }
  record('media-analysis', { title: analysis.title, optionCount: analysis.options.length, selectedCandidate: mergeOptions[0].text, screenshot: path.join(screenshotDir, '02-media-analysis.png') })

  const selected = await cdp.evaluate(`(() => {
    const input = [...document.querySelectorAll('input[name="media-option"]')]
      .find(item => /144p/i.test(item.closest('label')?.innerText ?? '') && /merged/i.test(item.closest('label')?.innerText ?? ''))
    input?.click()
    return input ? {checked:input.checked,text:input.closest('label')?.innerText.replace(/\\s+/g,' ').trim()} : null
  })()`)
  if (!selected?.checked) throw new Error('Could not select the 144p merged video option in the real renderer.')
  await cdp.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  await cdp.screenshot('03-quality-selected.png')
  record('video-quality-selected', { option: selected.text, screenshot: path.join(screenshotDir, '03-quality-selected.png') })

  const beforeQueue = (await snapshot()).value.jobs.map(job => job.id)
  await clickButton('Download selected')
  const queued = await waitFor(snapshot, value => value?.ok && value.value.jobs.some(job => !beforeQueue.includes(job.id)), 15_000, 'Media job queued')
  const job = queued.value.jobs.find(item => !beforeQueue.includes(item.id))
  if (!job) throw new Error('Media job was not created by the selected option action.')
  record('media-job-queued', { title: job.title, label: job.label, status: job.status, jobId: job.id })

  let activeScreenshot = false
  const deadline = Date.now() + 300_000
  let finalJob = null
  while (Date.now() < deadline) {
    const current = await snapshot()
    if (!current.ok) throw new Error(`Media snapshot failed while downloading: ${current.error.message}`)
    finalJob = current.value.jobs.find(item => item.id === job.id) ?? null
    if (!finalJob) throw new Error('Queued media job disappeared from the real renderer snapshot.')
    if (finalJob.completedBytes > maxTransferBytes) {
      await cdp.evaluate(`window.donDownload.cancelMedia(${JSON.stringify(job.id)})`)
      throw new Error(`Transfer exceeded ${maxTransferBytes} bytes; cancellation requested.`)
    }
    if (!activeScreenshot && ['downloading', 'merging'].includes(finalJob.status)) {
      await cdp.screenshot('04-media-active.png')
      activeScreenshot = true
      record('media-active-progress', { status: finalJob.status, completedBytes: finalJob.completedBytes, totalBytes: finalJob.totalBytes, screenshot: path.join(screenshotDir, '04-media-active.png') })
    }
    if (finalJob.status === 'error') {
      await cdp.screenshot('05-media-job-error.png')
      record('media-job-failed', { title: finalJob.title, label: finalJob.label, status: finalJob.status, error: finalJob.errorMessage, screenshot: path.join(screenshotDir, '05-media-job-error.png') })
      throw new Error(`Media job failed: ${finalJob.errorMessage ?? 'no error message'}`)
    }
    if (finalJob.status === 'complete') break
    if (['cancelled', 'interrupted'].includes(finalJob.status)) throw new Error(`Media job ended ${finalJob.status}.`)
    await sleep(350)
  }
  if (finalJob?.status !== 'complete') throw new Error(`Media download exceeded ${maxDurationSeconds}s wall-clock limit; current=${finalJob?.status ?? 'missing'}`)
  if (!activeScreenshot) {
    await cdp.screenshot('04-media-active.png')
    record('media-active-progress', { note: 'The transfer completed before an active frame could be sampled; final state captured below.' })
  }
  await cdp.screenshot('05-media-completed.png')
  record('media-job-complete', { title: finalJob.title, label: finalJob.label, bytes: finalJob.completedBytes, screenshot: path.join(screenshotDir, '05-media-completed.png') })

  if (finalJob.completedBytes > maxTransferBytes) throw new Error(`Completed output exceeds the ${maxTransferBytes} byte cap.`)
  const files = (await findFiles(mediaDir)).filter(file => /\.(mp4|webm|mkv|m4v|mov)$/i.test(file) && !/\.part$/i.test(file))
  if (files.length !== 1) throw new Error(`Expected exactly one completed media output under isolated dir; found ${files.length}: ${JSON.stringify(files)}`)
  const outputPath = files[0]
  const output = await readFile(outputPath)
  if (output.length > maxTransferBytes) throw new Error(`Output file is ${output.length} bytes, over the ${maxTransferBytes} byte limit.`)

  const ffprobe = path.join(root, 'dist', 'win-unpacked', 'resources', 'vendor', 'ffmpeg', 'ffprobe.exe')
  const probe = spawnSync(ffprobe, [
    '-v', 'error', '-show_streams', '-show_format', '-of', 'json', outputPath
  ], { encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })
  if (probe.error || probe.status !== 0) throw new Error(`ffprobe failed: ${probe.error?.message ?? probe.stderr}`)
  const metadata = JSON.parse(probe.stdout)
  const streams = metadata.streams ?? []
  const video = streams.find(stream => stream.codec_type === 'video')
  const audio = streams.find(stream => stream.codec_type === 'audio')
  if (!video || !audio) throw new Error(`Merged video output is missing video/audio streams: ${JSON.stringify(streams.map(stream => stream.codec_type))}`)
  const hash = createHash('sha256').update(output).digest('hex')
  record('ffprobe-output-integrity', {
    path: outputPath,
    bytes: output.length,
    sha256: hash,
    container: metadata.format?.format_name,
    video: { codec: video.codec_name, width: video.width, height: video.height },
    audio: { codec: audio.codec_name, channels: audio.channels },
    ffprobeExitCode: probe.status
  })

  const savedJob = (await snapshot()).value.jobs.find(item => item.id === job.id)
  if (!savedJob || savedJob.status !== 'complete') throw new Error('Completed media job is not present in the renderer snapshot.')
  const trace = await finishTrace()
  finishTrace = null
  record('renderer-trace', trace)
  const report = {
    status: 'PASS',
    startedAt,
    finishedAt: new Date().toISOString(),
    app: appPath,
    renderer: 'actual packaged Electron renderer + production preload/IPC + yt-dlp/FFmpeg',
    sourceUrl: fixtureUrl,
    sourceLicense: 'CC-BY, official Blender Open Movies; pinned 147-second Caminandes entry',
    maxTransferBytes,
    userData,
    mediaDir,
    screenshots: screenshotDir,
    checks
  }
  await writeFile(path.join(runDir, 'result.json'), JSON.stringify(report, null, 2))
  console.log(`MEDIA_RESULT ${path.join(runDir, 'result.json')}`)
}

try {
  await run()
} catch (error) {
  if (cdp) {
    try {
      await cdp.screenshot('99-failure-state.png')
    } catch {}
  }
  if (finishTrace) {
    try {
      record('renderer-trace', await finishTrace())
      finishTrace = null
    } catch {}
  }
  const report = {
    status: 'FAIL',
    startedAt,
    finishedAt: new Date().toISOString(),
    error: error instanceof Error ? error.stack ?? error.message : String(error),
    userData,
    mediaDir,
    screenshots: screenshotDir,
    checks
  }
  await writeFile(path.join(runDir, 'result.json'), JSON.stringify(report, null, 2)).catch(() => {})
  console.error(`MEDIA_FAIL ${report.error}`)
  process.exitCode = 1
} finally {
  await stopApp().catch(error => console.error(`Electron cleanup warning: ${error.message}`))
}
