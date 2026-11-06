#!/usr/bin/env node
/** Real packaged batch lifecycle against controlled loopback HTTP + aria2. */
import { createHash } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const appPath = process.env.DONDOWNLOAD_PACKAGED_APP || path.join(root, 'artifacts', 'packaged-verification', 'win-unpacked', 'DonDownload.exe')
const runDir = path.join(root, 'artifacts', 'test-runs', `electron-batch-lifecycle-${new Date().toISOString().replace(/[:.]/g, '-')}`)
const userData = path.join(runDir, 'user-data')
const downloadDir = path.join(userData, 'smoke-downloads')
const screenshotDir = path.join(runDir, 'screenshots')
const cdpPort = 19344
const MAX_BYTES = 16 * 1024 * 1024
const FAST_BYTES = buildPayload(512 * 1024, 11)
const RETRY_BYTES = buildPayload(256 * 1024, 71)
const SLOW_BYTES = buildPayload(8 * 1024 * 1024, 29)
const GROUP_BYTES = buildPayload(4 * 1024 * 1024, 43)
const checks = []
const fixtureLog = []
let retryAllowed = false
let server
let appProcess
let cdp
let baseUrl

await mkdir(screenshotDir, { recursive: true })
await mkdir(downloadDir, { recursive: true })
const sentinelPath = path.join(downloadDir, 'preserve-existing.bin')
const sentinel = Buffer.from('pre-existing user data must survive batch operations\n')
await writeFile(sentinelPath, sentinel)

function buildPayload(size, seed) {
  const bytes = Buffer.allocUnsafe(size)
  for (let index = 0; index < size; index += 1) bytes[index] = (index * 31 + seed) & 0xff
  return bytes
}

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex') }
function record(name, details) { checks.push({ name, ...details }); console.log(`${name}: ${JSON.stringify(details)}`) }
const sleep = ms => delay(ms)

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.id = 1
    this.pending = new Map()
    this.ws.addEventListener('message', event => {
      const message = JSON.parse(event.data.toString())
      if (!message.id) return
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result)
    })
  }
  ready() {
    if (this.ws.readyState === WebSocket.OPEN) return Promise.resolve()
    return new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true })
      this.ws.addEventListener('error', reject, { once: true })
    })
  }
  command(method, params = {}) {
    const id = this.id++
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)) }, 20_000)
      this.pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value) },
        reject: error => { clearTimeout(timer); reject(error) }
      })
    })
  }
  async evaluate(expression) {
    const result = await this.command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
    return result.result?.value
  }
  async shot(name) {
    const result = await this.command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
    const target = path.join(screenshotDir, name)
    await writeFile(target, Buffer.from(result.data, 'base64'))
    return target
  }
  close() { try { this.ws.close() } catch {} }
}

async function serveSlow(response, body) {
  response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': body.length, 'accept-ranges': 'none' })
  const chunkBytes = 32 * 1024
  for (let offset = 0; offset < body.length && !response.destroyed; offset += chunkBytes) {
    if (!response.write(body.subarray(offset, Math.min(offset + chunkBytes, body.length)))) {
      await new Promise(resolve => response.once('drain', resolve))
    }
    await sleep(40)
  }
  if (!response.destroyed) response.end()
}

async function startServer() {
  const slowBodies = new Map([
    ['/individual-cancel.bin', SLOW_BYTES],
    ['/group-a.bin', GROUP_BYTES],
    ['/group-b.bin', GROUP_BYTES]
  ])
  server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    fixtureLog.push({ method: request.method, pathname, at: new Date().toISOString() })
    if (pathname === '/retry.bin' && !retryAllowed) {
      response.writeHead(404, { 'content-length': '0', 'cache-control': 'no-store' })
      response.end()
      return
    }
    if (request.method === 'HEAD') {
      const known = pathname === '/retry.bin' || pathname === '/complete.bin' || slowBodies.has(pathname)
      response.writeHead(known ? 200 : 404, { 'content-length': String(pathname === '/complete.bin' ? FAST_BYTES.length : pathname === '/retry.bin' ? RETRY_BYTES.length : slowBodies.get(pathname)?.length ?? 0) })
      response.end()
      return
    }
    if (pathname === '/retry.bin') {
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': RETRY_BYTES.length, 'content-disposition': 'attachment; filename="retry.bin"' })
      response.end(RETRY_BYTES)
      return
    }
    if (pathname === '/complete.bin') {
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': FAST_BYTES.length, 'content-disposition': 'attachment; filename="complete.bin"' })
      response.end(FAST_BYTES)
      return
    }
    const slowBody = slowBodies.get(pathname)
    if (slowBody) { await serveSlow(response, slowBody); return }
    response.writeHead(404, { 'content-length': '0' })
    response.end()
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  baseUrl = `http://127.0.0.1:${server.address().port}`
}

async function waitFor(read, predicate, timeoutMs, label) {
  const end = Date.now() + timeoutMs
  let last
  while (Date.now() < end) {
    last = await read()
    if (predicate(last)) return last
    await sleep(200)
  }
  throw new Error(`${label} timed out: ${JSON.stringify(last)}`)
}

async function startApp() {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  for (const key of ['DONDOWNLOAD_ARIA2_PATH', 'DONDOWNLOAD_YTDLP_PATH', 'DONDOWNLOAD_FFMPEG_PATH', 'DONDOWNLOAD_FFPROBE_PATH', 'DONDOWNLOAD_DENO_PATH']) delete env[key]
  env.DONDOWNLOAD_SMOKE_TEST = '1'
  env.DONDOWNLOAD_INTERACTIVE_SMOKE = '1'
  env.DONDOWNLOAD_SMOKE_RESULT_PATH = path.join(userData, 'smoke-result.json')
  appProcess = spawn(appPath, ['--smoke-test', `--user-data-dir=${userData}`, `--remote-debugging-port=${cdpPort}`, '--remote-debugging-address=127.0.0.1', '--headless'], { cwd: path.dirname(appPath), env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
  appProcess.stderr.on('data', chunk => {
    const text = chunk.toString()
    if (/INTERACTIVE_READY|ERROR|FAIL/i.test(text)) process.stderr.write(text)
  })
  const target = await waitFor(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`)
      return response.ok ? (await response.json()).find(item => item.type === 'page' && item.webSocketDebuggerUrl) : null
    } catch { return null }
  }, value => !!value, 45_000, 'Packaged Electron target')
  cdp = new Cdp(target.webSocketDebuggerUrl)
  await cdp.ready()
  await cdp.command('Page.enable')
  await cdp.command('Runtime.enable')
  const ready = await waitFor(() => cdp.evaluate(`({rendered:!!document.querySelector('#root')?.children.length,preload:typeof window.donDownload?.getBatchSnapshot==='function'})`), value => value?.rendered && value?.preload, 30_000, 'Packaged renderer/preload')
  await cdp.evaluate(`([...document.querySelectorAll('nav[aria-label="Sections"] button')].find(item=>item.innerText.trim()==='Batches'))?.click()`)
  await waitFor(() => cdp.evaluate(`!!document.querySelector('#batch-urls')`), Boolean, 15_000, 'Batches view')
  record('production-electron-startup', { ...ready, visible: false, userData, baseUrl })
}

async function stopApp() {
  cdp?.close()
  cdp = null
  if (!appProcess || appProcess.exitCode !== null) return
  execFileSync('taskkill', ['/pid', String(appProcess.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  await new Promise(resolve => appProcess.once('exit', resolve))
  appProcess = null
}

async function snapshot() { return cdp.evaluate('window.donDownload.getBatchSnapshot()') }
async function downloadSnapshot() { return cdp.evaluate('window.donDownload.getSnapshot()') }

async function submitUrls(urls) {
  const value = urls.join('\n')
  const set = await cdp.evaluate(`(() => {const input=document.querySelector('#batch-urls');if(!input)return false;const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;setter.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));return true})()`)
  if (!set) throw new Error('Batch URL input was not present.')
  const clicked = await cdp.evaluate(`(() => {const button=[...document.querySelectorAll('button')].find(item=>item.innerText.trim()==='Submit batch'&&!item.disabled);button?.click();return !!button})()`)
  if (!clicked) throw new Error('Enabled Submit batch button was not found.')
}

async function scopedClick(batchId, ariaLabel) {
  const clicked = await cdp.evaluate(`(() => {const card=document.querySelector(${JSON.stringify(`article[aria-labelledby="batch-${batchId}-title"]`)});const button=card?.querySelector(${JSON.stringify(`button[aria-label="${ariaLabel}"]`)});button?.click();return !!button&&!button.disabled})()`)
  if (!clicked) throw new Error(`Action ${ariaLabel} was not enabled in batch ${batchId}.`)
}

async function batchById(batchId) {
  const result = await snapshot()
  if (!result.ok) throw new Error(`Batch snapshot failed: ${result.error.message}`)
  return result.value.batches.find(batch => batch.id === batchId) ?? null
}

async function verifyFile(filePath, bytes, expectedHash, name) {
  const output = await readFile(filePath)
  const hash = sha256(output)
  if (output.length !== bytes.length || hash !== expectedHash) throw new Error(`${name} integrity mismatch: bytes=${output.length}, sha256=${hash}`)
  return { path: filePath, bytes: output.length, sha256: hash }
}

let firstBatchId
let retryItemId
let individualItemId
let retryFile
let goodFile
let individualPartial
let secondBatchId
let groupPartialFiles = []
let persistedStates = []

try {
  if (!(await stat(appPath).catch(() => null))) throw new Error(`Packaged app missing: ${appPath}`)
  await startServer()
  await startApp()
  const initial = await snapshot()
  if (!initial.ok || initial.value.batches.length) throw new Error('Expected clean isolated batch history.')

  await submitUrls([`${baseUrl}/retry.bin`, `${baseUrl}/complete.bin`, `${baseUrl}/individual-cancel.bin`])
  const created = await waitFor(snapshot, result => result?.ok && result.value.batches.length === 1 && result.value.batches[0].items.length === 3, 15_000, 'Three-item batch creation')
  const firstBatch = created.value.batches[0]
  firstBatchId = firstBatch.id
  retryItemId = firstBatch.items.find(item => item.title.includes('retry'))?.id
  individualItemId = firstBatch.items.find(item => item.title.includes('individual-cancel'))?.id
  if (!retryItemId || !individualItemId) throw new Error(`Batch item labels did not match fixture paths: ${JSON.stringify(firstBatch.items)}`)
  record('multi-url-batch-submitted', { batchId: firstBatchId, itemTitles: firstBatch.items.map(item => item.title), count: firstBatch.items.length })

  const progressed = await waitFor(async () => {
    const batch = await batchById(firstBatchId)
    if (!batch) return null
    if (batch.status === 'running' && batch.items.some(item => item.status === 'running' && item.completedBytes > 0)) {
      await cdp.shot('01-direct-batch-active-progress.png')
    }
    return batch
  }, batch => batch?.items.some(item => item.title.includes('retry') && item.status === 'error') && batch.items.some(item => item.title.includes('complete') && item.status === 'complete') && batch.items.some(item => item.title.includes('individual-cancel') && item.status === 'running' && item.completedBytes > 0), 60_000, 'Independent fail/complete/active children')
  await cdp.shot('01-direct-batch-active-progress.png')
  const activePartial = progressed
  const downloadsBeforeCancel = await downloadSnapshot()
  if (!downloadsBeforeCancel.ok) throw new Error('Download snapshot failed before individual cancellation.')
  const partialChild = downloadsBeforeCancel.value.downloads.find(item => item.id === activePartial.items.find(item => item.id === individualItemId)?.childId)
  if (!partialChild?.filePath) throw new Error(`Active individual-cancel child has no output path: ${JSON.stringify(partialChild)}`)
  await scopedClick(firstBatchId, 'Cancel individual-cancel.bin')
  const afterIndividualCancel = await waitFor(() => batchById(firstBatchId), batch => batch?.items.find(item => item.id === individualItemId)?.status === 'cancelled', 20_000, 'Individual child cancel')
  if (!['running', 'partial'].includes(afterIndividualCancel.status)) throw new Error(`Unexpected parent state after individual cancel: ${afterIndividualCancel.status}`)
  const individualStat = await stat(partialChild.filePath)
  individualPartial = { path: partialChild.filePath, bytes: individualStat.size, reportedBytes: partialChild.completedBytes, downloadStatus: partialChild.status }
  if (individualStat.size <= 0 || partialChild.completedBytes <= 0) throw new Error(`Individual cancel did not preserve downloaded partial data: ${JSON.stringify(individualPartial)}`)
  const individuallyPaused = await waitFor(async () => (await downloadSnapshot()).value?.downloads?.find(item => item.id === partialChild.id), item => item?.status === 'paused', 15_000, 'Direct child pause after individual cancellation')
  individualPartial.pausedChildStatus = individuallyPaused.status
  await waitFor(() => batchById(firstBatchId), batch => batch?.status === 'partial', 15_000, 'Partial parent aggregation')
  await cdp.shot('02-direct-batch-partial-failure.png')
  record('independent-failure-and-cancel',{batchStatus:'partial',items:(await batchById(firstBatchId)).items.map(item=>({title:item.title,status:item.status,completedBytes:item.completedBytes,error:item.errorMessage})),partialFile:individualPartial,screenshot:path.join(screenshotDir,'02-direct-batch-partial-failure.png')})

  const goodItem = afterIndividualCancel.items.find(item => item.title.includes('complete'))
  const goodChild = downloadsBeforeCancel.value.downloads.find(item => item.id === goodItem?.childId)
  if (!goodChild?.filePath) throw new Error('Completed direct child had no recorded file path.')
  const goodIntegrity = await verifyFile(goodChild.filePath, FAST_BYTES, sha256(FAST_BYTES), 'Independent success child')
  goodFile = goodIntegrity.path
  retryAllowed = true
  await scopedClick(firstBatchId, 'Retry retry.bin')
  const retried = await waitFor(() => batchById(firstBatchId), batch => batch?.items.find(item => item.id === retryItemId)?.status === 'complete', 45_000, 'Failed-item retry')
  const retryChild = (await downloadSnapshot()).value.downloads.find(item => item.id === retried.items.find(item => item.id === retryItemId)?.childId)
  if (!retryChild?.filePath) throw new Error('Retried child had no recorded file path.')
  const retryIntegrity = await verifyFile(retryChild.filePath, RETRY_BYTES, sha256(RETRY_BYTES), 'Retried child')
  retryFile = retryIntegrity.path
  if (retried.status !== 'partial') throw new Error(`Parent aggregation should remain partial due to the individually cancelled sibling, got ${retried.status}`)
  await cdp.shot('03-direct-batch-retried-completed.png')
  record('failed-item-retry',{batchStatus:retried.status,retriedItem:retried.items.find(item=>item.id===retryItemId),requestCount:fixtureLog.filter(item=>item.pathname==='/retry.bin').length,files:{good:goodIntegrity,retry:retryIntegrity},screenshot:path.join(screenshotDir,'03-direct-batch-retried-completed.png')})

  await submitUrls([`${baseUrl}/group-a.bin`, `${baseUrl}/group-b.bin`])
  const secondCreated = await waitFor(snapshot, result => result?.ok && result.value.batches.length === 2 && result.value.batches.some(batch => batch.items.length === 2), 15_000, 'Group-cancel batch creation')
  const secondBatch = secondCreated.value.batches.find(batch => batch.id !== firstBatchId)
  secondBatchId = secondBatch.id
  const groupActive = await waitFor(async () => {
    const batch = await batchById(secondBatchId)
    if (batch?.items.some(item => item.status === 'running' && item.completedBytes > 0)) await cdp.shot('04-group-batch-active.png')
    return batch
  }, batch => batch?.items.filter(item => item.status === 'running' && item.completedBytes > 0).length === 2, 40_000, 'Both group children active')
  const beforeGroupCancel = await downloadSnapshot()
  if (!beforeGroupCancel.ok) throw new Error('Download snapshot failed before group cancellation.')
  const groupChildIds = groupActive.items.map(item => item.childId).filter(Boolean)
  groupPartialFiles = beforeGroupCancel.value.downloads.filter(item => groupChildIds.includes(item.id)).map(item => ({ id: item.id, path: item.filePath, completedBytes: item.completedBytes, status: item.status }))
  if (groupPartialFiles.length !== 2 || groupPartialFiles.some(item => item.completedBytes <= 0 || !item.path)) throw new Error(`Expected two progressing group children before cancellation: ${JSON.stringify(groupPartialFiles)}`)
  await scopedClick(secondBatchId, 'Cancel batch Smart batch')
  const cancelled = await waitFor(() => batchById(secondBatchId), batch => batch?.status === 'cancelled' && batch.items.every(item => item.status === 'cancelled'), 20_000, 'Group cancel')
  const pausedGroupChildren = await waitFor(async () => {
    const state = await downloadSnapshot()
    return state.ok ? state.value.downloads.filter(item => groupChildIds.includes(item.id)) : []
  }, items => items.length === 2 && items.every(item => item.status === 'paused'), 15_000, 'Direct child pauses after group cancellation')
  for (const child of pausedGroupChildren) {
    const partial = groupPartialFiles.find(item => item.id === child.id)
    if (partial) partial.pausedChildStatus = child.status
  }
  for (const partial of groupPartialFiles) {
    const fileStat = await stat(partial.path)
    if (fileStat.size <= 0) throw new Error(`Group cancellation removed partial data: ${partial.path}`)
    partial.fileBytesAfterCancel = fileStat.size
  }
  await cdp.shot('05-direct-batch-group-cancelled.png')
  record('group-cancellation',{batchStatus:cancelled.status,itemStatuses:cancelled.items.map(item=>item.status),partialFiles:groupPartialFiles,screenshot:path.join(screenshotDir,'05-direct-batch-group-cancelled.png')})

  const preserved = await readFile(sentinelPath)
  if (!preserved.equals(sentinel)) throw new Error('Pre-existing file was changed or removed.')
  persistedStates = (await snapshot()).value.batches.map(batch => ({ id: batch.id, status: batch.status, items: batch.items.map(item => ({ id: item.id, status: item.status, childId: item.childId })) }))
  await stopApp()
  await startApp()
  const restarted = await waitFor(snapshot, result => result?.ok && result.value.batches.length === 2, 20_000, 'Batch history after app restart')
  const restartedDownloads = await downloadSnapshot()
  if (!restartedDownloads.ok) throw new Error('Download snapshot failed after restart.')
  for (const before of persistedStates) {
    const after = restarted.value.batches.find(batch => batch.id === before.id)
    if (!after || after.status !== before.status || before.items.some(item => after.items.find(child => child.id === item.id)?.status !== item.status)) {
      throw new Error(`Batch/child state changed across restart: before=${JSON.stringify(before)} after=${JSON.stringify(after)}`)
    }
  }
  if (!(await readFile(sentinelPath)).equals(sentinel)) throw new Error('Existing user-data sentinel did not survive restart.')
  for (const file of [goodFile, retryFile]) if (!(await stat(file)).isFile()) throw new Error(`Completed file missing after restart: ${file}`)
  for (const partial of [...groupPartialFiles, individualPartial]) if ((await stat(partial.path)).size <= 0) throw new Error(`Partial download data missing after restart: ${partial.path}`)
  for (const partial of [...groupPartialFiles, individualPartial]) {
    const child = restartedDownloads.value.downloads.find(item => item.filePath === partial.path)
    if (!child || child.status !== 'paused') throw new Error(`Cancelled child did not persist as paused across restart: ${JSON.stringify({ partial, child })}`)
    partial.statusAfterRestart = child.status
  }
  await cdp.shot('06-batches-after-restart.png')
  record('restart-persistence',{batchStates:restarted.value.batches.map(batch=>({id:batch.id,status:batch.status,items:batch.items.map(item=>({title:item.title,status:item.status}))})),completedFiles:[goodFile,retryFile],preservedSentinel:true,partialFileCount:groupPartialFiles.length+1,screenshot:path.join(screenshotDir,'06-batches-after-restart.png')})

  await writeFile(path.join(runDir,'fixture-requests.json'),JSON.stringify(fixtureLog,null,2))
  const report={status:'PASS',startedAt:new Date().toISOString(),finishedAt:new Date().toISOString(),app:appPath,renderer:'actual packaged Electron renderer + preload/IPC + bundled aria2 + isolated SQLite',baseUrl,fixtures:{retry:{requests:fixtureLog.filter(item=>item.pathname==='/retry.bin').length,bytes:RETRY_BYTES.length,sha256:sha256(RETRY_BYTES)},complete:{bytes:FAST_BYTES.length,sha256:sha256(FAST_BYTES)},individualCancel:{bytes:SLOW_BYTES.length},groupCancel:{bytes:GROUP_BYTES.length}},limits:{maxFixtureBytes:MAX_BYTES,allFixturesLoopback:true},userData,downloadDir,screenshots:screenshotDir,checks}
  await writeFile(path.join(runDir,'result.json'),JSON.stringify(report,null,2))
  console.log(`BATCH_LIFECYCLE_RESULT ${path.join(runDir,'result.json')}`)
} catch(error) {
  if(cdp) try { await cdp.shot('99-failure-state.png') } catch {}
  await writeFile(path.join(runDir,'fixture-requests.json'),JSON.stringify(fixtureLog,null,2)).catch(()=>{})
  const report={status:'FAIL',error:error instanceof Error?error.stack??error.message:String(error),userData,downloadDir,screenshots:screenshotDir,checks}
  await writeFile(path.join(runDir,'result.json'),JSON.stringify(report,null,2)).catch(()=>{})
  console.error(`BATCH_LIFECYCLE_FAIL ${report.error}`)
  process.exitCode=1
} finally {
  await stopApp().catch(error=>console.error(`Electron cleanup: ${error.message}`))
  if(server) await new Promise(resolve=>server.close(resolve))
}
