#!/usr/bin/env node
/**
 * Real packaged Electron verification for the day's merged features that only
 * had unit tests:
 *
 *   1. duplicate warning (and its setting),
 *   2. "Save to" per-download destination (add, restart, Open/Show in folder),
 *   3. the tray menu (items, enable/disable, Pause all through the real manager),
 *   4. "Copy diagnostics" (version present, secrets redacted),
 *   5. a completion-toast Open/Show activation.
 *
 * Everything runs against the built app in the isolated smoke/E2E mode:
 * `DONDOWNLOAD_SMOKE_TEST=1` gives an isolated userData/download folder,
 * `DONDOWNLOAD_INTERACTIVE_SMOKE=1` keeps the production renderer/preload/IPC
 * alive for CDP, and the window stays hidden and offscreen. The extra hooks in
 * `src/main/smoke/featuresVerification.ts` require
 * `DONDOWNLOAD_FEATURES_VERIFY=1` on top of smoke mode, so a normal desktop run
 * can never expose them. Nothing here opens a window, focuses the app or calls
 * the real shell: Open / Show in folder are recorded by a verification host.
 *
 *   npm run build && npx electron-builder --win --dir --x64
 *   npm run verify:features
 */
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { mkdir, readFile, stat, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const appPath = path.join(root, 'dist', 'win-unpacked', 'DonDownload.exe')
const runDir = path.join(
  root,
  'artifacts',
  'test-runs',
  `electron-features-${new Date().toISOString().replace(/[:.]/g, '-')}`
)
const userData = path.join(runDir, 'user-data')
const chosenDir = path.join(runDir, 'chosen-folder')
const defaultDownloadDir = path.join(userData, 'smoke-downloads')
const rendererPort = 19355
const inspectorPort = 19356
const startedAt = new Date().toISOString()
const HOOK = 'globalThis.__dondownloadFeaturesVerify'
const SECRET_MARKER = 'VERIFYSECRET9f3a1c'

const fixtures = [
  {
    route: '/features-dup.bin',
    name: 'features-dup.bin',
    bytes: 512 * 1024,
    chunkBytes: 64 * 1024,
    delayMs: 0
  },
  {
    route: '/features-saveto.bin',
    name: 'features-saveto.bin',
    bytes: 512 * 1024,
    chunkBytes: 64 * 1024,
    delayMs: 0
  },
  {
    route: '/features-slow.bin',
    name: 'features-slow.bin',
    bytes: 8 * 1024 * 1024,
    chunkBytes: 32 * 1024,
    delayMs: 900
  },
  {
    route: '/features-unknown-token.bin',
    name: 'features-unknown-token.bin',
    bytes: 1024,
    chunkBytes: 1024,
    delayMs: 0
  }
]

await mkdir(runDir, { recursive: true })
await mkdir(chosenDir, { recursive: true })

const sleep = ms => delay(ms)

const fixtureServer = createServer(async (request, response) => {
  const queryIndex = (request.url ?? '').indexOf('?')
  const route =
    queryIndex >= 0 ? (request.url ?? '').slice(0, queryIndex) : request.url ?? ''
  const fixture = fixtures.find(entry => entry.route === route)
  if (!fixture) {
    response.writeHead(404).end('not found')
    return
  }
  const range = /^bytes=(\d+)-(\d*)$/i.exec(request.headers.range ?? '')
  const start = range ? Number(range[1]) : 0
  const end = range?.[2]
    ? Math.min(Number(range[2]), fixture.bytes - 1)
    : fixture.bytes - 1
  const length = Math.max(0, end - start + 1)
  response.writeHead(range ? 206 : 200, {
    'accept-ranges': 'bytes',
    'content-length': String(length),
    'content-type': 'application/octet-stream',
    'content-disposition': `attachment; filename="${fixture.name}"`,
    ...(range ? { 'content-range': `bytes ${start}-${end}/${fixture.bytes}` } : {})
  })
  async function* chunks() {
    for (let offset = start; offset <= end; offset += fixture.chunkBytes) {
      if (response.destroyed) return
      const count = Math.min(fixture.chunkBytes, end - offset + 1)
      const chunk = Buffer.allocUnsafe(count)
      for (let index = 0; index < count; index += 1) {
        chunk[index] = (offset + index) % 251
      }
      yield chunk
      if (fixture.delayMs > 0) await sleep(fixture.delayMs)
    }
  }
  Readable.from(chunks()).pipe(response)
})
await new Promise((resolve, reject) => {
  fixtureServer.once('error', reject)
  fixtureServer.listen(0, '127.0.0.1', resolve)
})
const fixturePort = fixtureServer.address().port
function fixtureUrl(route) {
  return `http://127.0.0.1:${fixturePort}${route}`
}

/* ------------------------------------------------------------------------- *
 * CDP client (works for both the renderer page and the main-process inspector)
 * ------------------------------------------------------------------------- */

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
        if (!waiter) return
        this.pending.delete(message.id)
        message.error
          ? waiter.reject(new Error(message.error.message))
          : waiter.resolve(message.result)
        return
      }
      for (const listener of this.listeners.get(message.method) ?? []) {
        listener(message.params)
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
  command(method, params = {}) {
    const id = this.nextId++
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP command timed out: ${method}`))
      }, 20_000)
      this.pending.set(id, {
        resolve: value => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: error => {
          clearTimeout(timer)
          reject(error)
        }
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
    if (result.exceptionDetails) {
      const detail =
        result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text
      throw new Error(detail)
    }
    return result.result?.value
  }
  close() {
    try {
      this.ws.close()
    } catch {}
  }
}

let appProcess = null
let renderer = null
let mainInspector = null
const checks = []
let appVersion = null

function record(id, title, status, detail, durationMs) {
  checks.push({ id, title, status, detail, durationMs })
  const line = `${status} ${id}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`
  if (status === 'PASS') console.log(line)
  else console.error(line)
}

async function check(id, title, run) {
  const start = Date.now()
  try {
    const detail = await run()
    record(id, title, 'PASS', detail, Date.now() - start)
    return true
  } catch (error) {
    const detail =
      error instanceof Error ? error.stack ?? error.message : String(error)
    record(id, title, 'FAIL', detail, Date.now() - start)
    return false
  }
}

async function waitFor(read, predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await read()
    if (predicate(last)) return last
    await sleep(200)
  }
  throw new Error(`${label} timed out; last=${JSON.stringify(last)}`)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/** Windows paths may come back from aria2 with either separator. */
function samePath(left, right) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
}

function sameDirOfFile(filePath, directory) {
  return samePath(path.dirname(filePath), directory)
}

/* ------------------------------------------------------------------------- *
 * App lifecycle
 * ------------------------------------------------------------------------- */

function appEnvironment() {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  for (const name of [
    'DONDOWNLOAD_ARIA2_PATH',
    'DONDOWNLOAD_YTDLP_PATH',
    'DONDOWNLOAD_FFMPEG_PATH',
    'DONDOWNLOAD_FFPROBE_PATH',
    'DONDOWNLOAD_DENO_PATH'
  ]) {
    delete env[name]
  }
  env.DONDOWNLOAD_SMOKE_TEST = '1'
  env.DONDOWNLOAD_INTERACTIVE_SMOKE = '1'
  env.DONDOWNLOAD_SMOKE_RESULT_PATH = path.join(userData, 'smoke-result.json')
  // The extra main-process hooks exist only with this opt-in on top of smoke.
  env.DONDOWNLOAD_FEATURES_VERIFY = '1'
  return env
}

async function startApp() {
  appProcess = spawn(
    appPath,
    [
      '--smoke-test',
      '--headless',
      `--user-data-dir=${userData}`,
      `--remote-debugging-port=${rendererPort}`,
      '--remote-debugging-address=127.0.0.1',
      `--inspect=127.0.0.1:${inspectorPort}`
    ],
    {
      cwd: path.dirname(appPath),
      env: appEnvironment(),
      // windowsHide keeps the BrowserWindow out of the foreground; smoke also
      // creates it with show:false and offscreen rendering.
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe']
    }
  )
  appProcess.stderr.on('data', chunk => {
    const text = chunk.toString()
    if (/INTERACTIVE_READY|ERROR|FAIL|Error/.test(text)) process.stderr.write(text)
  })

  const target = await waitFor(
    async () => {
      try {
        const response = await fetch(
          `http://127.0.0.1:${rendererPort}/json/list`
        )
        if (!response.ok) return null
        return (
          (await response.json()).find(
            entry => entry.type === 'page' && entry.webSocketDebuggerUrl
          ) ?? null
        )
      } catch {
        return null
      }
    },
    value => value !== null,
    45_000,
    'renderer CDP target'
  )
  renderer = new Cdp(target.webSocketDebuggerUrl)
  await renderer.ready()
  await renderer.command('Page.enable')
  await renderer.command('Runtime.enable')

  const ready = await waitFor(
    () =>
      renderer.evaluate(`({
        title: document.title,
        rendered: !!document.querySelector('#root')?.children.length,
        preload: typeof window.donDownload?.getSnapshot === 'function'
      })`),
    value => value?.rendered && value?.preload,
    30_000,
    'production renderer/preload'
  )

  const inspectorTarget = await waitFor(
    async () => {
      try {
        const response = await fetch(
          `http://127.0.0.1:${inspectorPort}/json/list`
        )
        if (!response.ok) return null
        return (
          (await response.json()).find(
            entry => entry.webSocketDebuggerUrl && entry.type !== 'page'
          ) ?? null
        )
      } catch {
        return null
      }
    },
    value => value !== null,
    30_000,
    'main-process inspector target'
  )
  mainInspector = new Cdp(inspectorTarget.webSocketDebuggerUrl)
  await mainInspector.ready()

  const hooks = await waitFor(
    () => mainEvaluate(`typeof ${HOOK}`),
    value => value === 'object',
    20_000,
    'features-verification hooks'
  )
  assert(hooks === 'object', 'features-verification hooks are missing')

  await waitFor(
    () =>
      renderer.evaluate(
        `window.donDownload.getSnapshot().then(result => result.ok && result.value.aria2.status === 'ready')`
      ),
    Boolean,
    30_000,
    'aria2 ready'
  )

  const hookState = await hookCall(
    'return { appVersion: h.appVersion, window: h.windowState() }'
  )
  appVersion = hookState.appVersion
  assert(
    hookState.window.visible === false,
    'the verification window must not be visible'
  )
  assert(
    hookState.window.focused === false,
    'the verification window must not be focused'
  )
  assert(
    hookState.window.offscreen === true,
    'the verification window must use offscreen rendering'
  )
  record(
    'app-startup',
    'Real packaged app started hidden/offscreen',
    'PASS',
    { ...ready, userData, appVersion, window: hookState.window },
    0
  )
  return ready
}

async function stopApp() {
  renderer?.close()
  mainInspector?.close()
  renderer = null
  mainInspector = null
  if (!appProcess || appProcess.exitCode !== null) {
    appProcess = null
    return
  }
  execFileSync('taskkill', ['/pid', String(appProcess.pid), '/T', '/F'], {
    windowsHide: true,
    stdio: 'ignore'
  })
  await new Promise(resolve => appProcess.once('exit', resolve))
  appProcess = null
}

/** Best-effort sweep: never leave an aria2/yt-dlp child of this run behind. */
async function killLeftoverChildren() {
  const escaped = userData.replace(/'/g, "''")
  const script = [
    `$marker = '${escaped}'`,
    '$all = Get-CimInstance Win32_Process',
    "$targets = $all | Where-Object { $_.CommandLine -like \"*$marker*\" -and $_.Name -match '^(DonDownload|aria2c|yt-dlp|ffmpeg|ffprobe|deno)' }",
    'foreach ($p in $targets) { try { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue } catch {} }'
  ].join('; ')
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
      windowsHide: true,
      stdio: 'ignore',
      timeout: 20_000
    })
  } catch {
    // Cleanup is best effort; the taskkill tree above is the primary path.
  }
}

/* ------------------------------------------------------------------------- *
 * Main-process hooks
 * ------------------------------------------------------------------------- */

async function mainEvaluate(expression) {
  const result = await mainInspector.command('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  })
  if (result.exceptionDetails) {
    const detail =
      result.exceptionDetails.exception?.description ??
      result.exceptionDetails.text
    throw new Error(`main evaluation failed: ${detail}`)
  }
  return result.result?.value
}

/** Run `body` inside an IIFE with `h` bound to the verification hooks. */
async function hookCall(body) {
  return mainEvaluate(`(() => { const h = ${HOOK}; ${body} })()`)
}

async function buildTrayMenu(clipboardText) {
  return hookCall(
    `const p = h.tray(); return p.build(${JSON.stringify(clipboardText)})`
  )
}

async function invokeTray(indexPath) {
  return hookCall(
    `const p = h.tray(); return p.invoke(${JSON.stringify(indexPath)})`
  )
}

async function hostCalls() {
  return hookCall('return h.hostCalls()')
}

async function clearHostCalls() {
  return hookCall('h.clearHostCalls(); return true')
}

/* ------------------------------------------------------------------------- *
 * Renderer helpers
 * ------------------------------------------------------------------------- */

async function setInput(selector, value) {
  const serialized = JSON.stringify(String(value))
  const found = await renderer.evaluate(`(() => {
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
  const clicked = await renderer.evaluate(`(() => {
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
  const clicked = await renderer.evaluate(`(() => {
    const button = document.querySelector(${JSON.stringify(selector)})
    if (!button || button.disabled) return false
    button.click()
    return true
  })()`)
  if (!clicked) throw new Error(`Could not click button with aria-label: ${label}`)
}

async function snapshot() {
  const result = await renderer.evaluate('window.donDownload.getSnapshot()')
  if (!result?.ok) throw new Error(`snapshot failed: ${JSON.stringify(result)}`)
  return result.value
}

async function waitForDownload(filename, predicate, timeoutMs, label) {
  return waitFor(
    async () => {
      const current = await snapshot()
      return current.downloads.find(item => item.filename === filename) ?? null
    },
    value => value !== null && predicate(value),
    timeoutMs,
    label
  )
}

async function openAddDialog() {
  if (await renderer.evaluate(`!!document.getElementById('add-links')`)) return
  await clickButton('Add')
  await waitFor(
    () => renderer.evaluate(`!!document.getElementById('add-links')`),
    Boolean,
    15_000,
    'Add dialog'
  )
}

async function submitDialogUrl(url) {
  await openAddDialog()
  await setInput('#add-links', url)
  await waitFor(
    () =>
      renderer.evaluate(
        `[...document.querySelectorAll('button')].some(item => item.innerText.trim() === 'Download' && !item.disabled)`
      ),
    Boolean,
    20_000,
    'Download footer action'
  )
  await clickButton('Download')
}

async function closeAddDialog() {
  const open = await renderer.evaluate(`!!document.getElementById('add-links')`)
  if (!open) return
  await clickAriaLabel('Close Add download dialog')
  await waitFor(
    () => renderer.evaluate(`!document.getElementById('add-links')`),
    Boolean,
    10_000,
    'Add dialog close'
  )
}

async function duplicateNotice() {
  return renderer.evaluate(`(() => {
    const nodes = [...document.querySelectorAll('[role="status"]')]
    const node = nodes.find(item => item.innerText.includes('Already'))
    if (!node) return null
    return {
      text: node.innerText.replace(/\\s+/g, ' ').trim(),
      buttons: [...node.querySelectorAll('button')].map(item => item.innerText.trim())
    }
  })()`)
}

async function openSettingsPage() {
  await clickAriaLabel('Settings')
  await waitFor(
    () => renderer.evaluate(`document.querySelector('#settings-heading')?.innerText ?? ''`),
    text => typeof text === 'string' && text.length > 0,
    15_000,
    'Settings heading'
  )
  await renderer.evaluate(
    `document.querySelector('#settings-heading')?.scrollIntoView({ block: 'start', behavior: 'instant' })`
  )
  await sleep(200)
}

/* ------------------------------------------------------------------------- *
 * Checks
 * ------------------------------------------------------------------------- */

async function checkDuplicateWarning() {
  const dupUrl = fixtureUrl('/features-dup.bin')
  const fragmentUrl = `${dupUrl}#section-2`
  await submitDialogUrl(dupUrl)
  await waitForDownload(
    'features-dup.bin',
    item => item.status === 'complete',
    120_000,
    'duplicate fixture download'
  )

  await openAddDialog()
  await setInput('#add-links', dupUrl)
  const notice = await waitFor(
    duplicateNotice,
    value => value !== null,
    15_000,
    'duplicate notice'
  )
  assert(
    notice.text.includes('Already downloaded on'),
    `duplicate notice text was unexpected: ${notice.text}`
  )
  assert(
    notice.text.includes('features-dup.bin'),
    `duplicate notice did not name the finished file: ${notice.text}`
  )
  for (const action of ['Open file', 'Show in folder', 'Download again']) {
    assert(
      notice.buttons.includes(action),
      `duplicate notice is missing the ${action} action: ${notice.buttons.join(', ')}`
    )
  }

  // The advisory IPC and the visible notice agree for a fragment-only variant:
  // normalization drops the fragment, so it is the same resource.
  await setInput('#add-links', fragmentUrl)
  const fragmentNotice = await waitFor(
    duplicateNotice,
    value => value !== null && value.text.includes('Already downloaded on'),
    15_000,
    'fragment duplicate notice'
  )
  const fragmentIpc = await renderer.evaluate(
    `window.donDownload.checkDuplicate(${JSON.stringify(fragmentUrl)})`
  )
  assert(fragmentIpc?.ok === true, 'checkDuplicate IPC failed for the fragment URL')
  assert(
    fragmentIpc.value !== null && fragmentIpc.value.state === 'finished',
    `fragment variant was not reported as a finished duplicate: ${JSON.stringify(fragmentIpc)}`
  )

  // A trailing slash is a different path (normalization keeps it), so it must
  // not be collapsed into the finished record. Reported, not asserted as same.
  const trailingSlashIpc = await renderer.evaluate(
    `window.donDownload.checkDuplicate(${JSON.stringify(`${dupUrl}/`)})`
  )
  assert(trailingSlashIpc?.ok === true, 'checkDuplicate IPC failed for the slash URL')

  // Turning "Warn about duplicates" off must silence both the IPC and the UI.
  const desktop = await renderer.evaluate('window.donDownload.getDesktopSettings()')
  assert(desktop?.ok === true, 'getDesktopSettings failed')
  assert(
    desktop.value.warnAboutDuplicates === true,
    'duplicate warnings should be on by default'
  )
  const updated = await renderer.evaluate(
    `window.donDownload.updateDesktopSettings(${JSON.stringify({
      ...desktop.value,
      warnAboutDuplicates: false
    })})`
  )
  assert(updated?.ok === true, 'updateDesktopSettings failed')
  assert(
    updated.value.warnAboutDuplicates === false,
    'the setting did not save as off'
  )
  const silencedIpc = await renderer.evaluate(
    `window.donDownload.checkDuplicate(${JSON.stringify(dupUrl)})`
  )
  assert(silencedIpc?.ok === true, 'checkDuplicate IPC failed with warnings off')
  assert(
    silencedIpc.value === null,
    `duplicate IPC still warned with the setting off: ${JSON.stringify(silencedIpc.value)}`
  )
  await setInput('#add-links', '')
  await setInput('#add-links', dupUrl)
  await sleep(1_200)
  const silencedNotice = await duplicateNotice()
  assert(
    silencedNotice === null,
    `the inline duplicate notice still appeared with warnings off: ${JSON.stringify(silencedNotice)}`
  )

  await closeAddDialog()
  return {
    warningShown: notice.text,
    actions: notice.buttons,
    fragmentVariant: fragmentNotice.text,
    fragmentIpcState: fragmentIpc.value.state,
    trailingSlashIsDistinctRecord: trailingSlashIpc.value === null,
    disabledSetting: {
      ipc: silencedIpc.value,
      inlineNotice: silencedNotice
    }
  }
}

async function checkSaveToDestination() {
  const savedName = 'features-saveto.bin'
  const savedUrl = fixtureUrl('/features-saveto.bin')

  const invalid = {}
  for (const [key, candidate] of Object.entries({
    missingFolder: path.join(runDir, 'folder-that-does-not-exist'),
    relativePath: 'relative-folder',
    uncPath: '\\\\server\\share',
    extendedPath: '\\\\?\\C:\\Windows',
    // A whole drive is refused so file actions never have to reject the
    // download a moment after it was saved.
    driveRoot: path.parse(runDir).root
  })) {
    const result = await hookCall(
      `return h.registerDestination(${JSON.stringify(candidate)})`
    )
    invalid[key] = result
    assert(
      result.ok === false && result.code === 'DOWNLOAD_FOLDER_INVALID',
      `${key} was not refused by main: ${JSON.stringify(result)}`
    )
  }

  const registration = await hookCall(
    `return h.registerDestination(${JSON.stringify(chosenDir)})`
  )
  assert(
    registration.ok === true,
    `the chosen folder was refused: ${JSON.stringify(registration)}`
  )

  const added = await renderer.evaluate(
    `window.donDownload.addDownload(${JSON.stringify({
      url: savedUrl,
      destinationToken: registration.token
    })})`
  )
  assert(added?.ok === true, `addDownload to a chosen folder failed: ${JSON.stringify(added)}`)
  const target = await waitForDownload(
    savedName,
    item => item.status === 'complete',
    120_000,
    'save-to download completion'
  )
  assert(
    samePath(target.dir, registration.path),
    `download dir ${target.dir} is not the chosen folder ${registration.path}`
  )
  assert(
    typeof target.filePath === 'string' &&
      sameDirOfFile(target.filePath, chosenDir),
    `file path ${target.filePath} is not inside the chosen folder`
  )
  const chosenBytes = await readFile(target.filePath)
  assert(chosenBytes.length === fixtures[1].bytes, 'save-to file size mismatch')
  const defaultPath = path.join(defaultDownloadDir, savedName)
  const defaultStat = await stat(defaultPath).catch(() => null)
  assert(defaultStat === null, `the file also appeared in the default folder: ${defaultPath}`)

  await clearHostCalls()
  const opened = await renderer.evaluate(
    `window.donDownload.openFile(${JSON.stringify(target.id)})`
  )
  assert(opened?.ok === true, `openFile failed: ${JSON.stringify(opened)}`)
  const openCall = await waitFor(
    async () => (await hostCalls()).find(call => call.method === 'openPath') ?? null,
    value => value !== null,
    10_000,
    'recorded Open call'
  )
  assert(
    samePath(openCall.target, target.filePath),
    `Open targeted ${openCall.target}, expected ${target.filePath}`
  )

  const shown = await renderer.evaluate(
    `window.donDownload.showInFolder(${JSON.stringify(target.id)})`
  )
  assert(shown?.ok === true, `showInFolder failed: ${JSON.stringify(shown)}`)
  const showCall = await waitFor(
    async () =>
      (await hostCalls()).find(call => call.method === 'showItemInFolder') ?? null,
    value => value !== null,
    10_000,
    'recorded Show in folder call'
  )
  assert(
    samePath(showCall.target, target.filePath),
    `Show in folder targeted ${showCall.target}, expected ${target.filePath}`
  )

  // An expired/unknown token must be refused by the real IPC layer and must not
  // silently fall back to the default download folder.
  const unknownToken = 'a'.repeat(32)
  const rejected = await renderer.evaluate(
    `window.donDownload.addDownload(${JSON.stringify({
      url: fixtureUrl('/features-unknown-token.bin'),
      destinationToken: unknownToken
    })})`
  )
  assert(rejected?.ok === false, 'an unknown destination token was accepted')
  assert(
    rejected.error?.code === 'DOWNLOAD_FOLDER_EXPIRED',
    `unknown token produced the wrong error: ${JSON.stringify(rejected.error)}`
  )

  // Restart the real app against the same userData: the association and the
  // resolved paths must survive.
  await stopApp()
  await startApp()
  const persisted = await waitForDownload(
    savedName,
    item => item.status === 'complete',
    30_000,
    'persisted save-to row after restart'
  )
  assert(
    samePath(persisted.dir, chosenDir),
    `after restart dir is ${persisted.dir}, expected ${path.resolve(chosenDir)}`
  )
  assert(
    samePath(persisted.filePath, target.filePath),
    `after restart filePath is ${persisted.filePath}, expected ${target.filePath}`
  )

  await clearHostCalls()
  const reopened = await renderer.evaluate(
    `window.donDownload.openFile(${JSON.stringify(persisted.id)})`
  )
  assert(reopened?.ok === true, `openFile after restart failed: ${JSON.stringify(reopened)}`)
  const reopenedCall = await waitFor(
    async () => (await hostCalls()).find(call => call.method === 'openPath') ?? null,
    value => value !== null,
    10_000,
    'recorded Open call after restart'
  )
  assert(
    sameDirOfFile(reopenedCall.target, chosenDir),
    `Open after restart targeted ${reopenedCall.target}`
  )

  return {
    chosenFolder: registration.path,
    filePath: target.filePath,
    openTarget: openCall.target,
    showTarget: showCall.target,
    invalidDestinations: Object.fromEntries(
      Object.entries(invalid).map(([key, value]) => [key, value.code])
    ),
    unknownToken: rejected.error.code,
    afterRestart: {
      dir: persisted.dir,
      filePath: persisted.filePath,
      openTarget: reopenedCall.target
    }
  }
}

async function checkTrayMenu() {
  const saved = await snapshot()
  const savedItem = saved.downloads.find(item => item.filename === 'features-saveto.bin')
  assert(savedItem !== undefined, 'the save-to row is missing before the tray check')

  const idle = await buildTrayMenu(null)
  assert(
    idle.state.statusLine === 'Nothing downloading',
    `idle status line was ${idle.state.statusLine}`
  )
  const idlePause = idle.items[2]
  assert(
    idlePause?.label === 'Resume all' && idlePause?.enabled === false,
    `idle pause/resume item was ${JSON.stringify(idlePause)}`
  )
  assert(idle.items[0]?.enabled === false, 'the status line must be disabled')
  assert(idle.items[0]?.clickable === false, 'the status line must not be clickable')

  const speed = idle.items.find(item => item.label === 'Speed limit')
  assert(speed !== undefined, 'the tray menu has no Speed limit item')
  const presetLabels = (speed.submenu ?? []).map(item => item.label)
  for (const label of ['Unlimited', '512 KB/s', '1 MB/s', '2 MB/s', '5 MB/s', '10 MB/s']) {
    assert(presetLabels.includes(label), `speed limit preset ${label} is missing`)
  }
  const checkedPresets = (speed.submenu ?? []).filter(item => item.checked === true)
  assert(checkedPresets.length === 1, `expected exactly one checked preset, got ${checkedPresets.length}`)

  const recent = idle.items.find(item => item.label === 'Recent')
  assert(recent !== undefined, 'the tray menu has no Recent item')
  const recentLabels = (recent.submenu ?? [])
    .filter(item => item.type !== 'separator')
    .map(item => item.label)
  assert(
    recentLabels.includes('features-saveto.bin'),
    `Recent does not list the finished download: ${recentLabels.join(', ')}`
  )
  assert(
    recentLabels.includes('Show in folder'),
    'Recent has no Show in folder action'
  )

  const clipboardIndex = idle.items.findIndex(
    item => item.label === 'Add from clipboard'
  )
  assert(clipboardIndex >= 0, 'the tray menu has no Add from clipboard item')
  assert(
    idle.items[clipboardIndex].enabled === false,
    'Add from clipboard should be disabled without a clipboard URL'
  )
  const withClipboard = await buildTrayMenu('https://example.com/from-clipboard.bin')
  assert(
    withClipboard.items[clipboardIndex].enabled === true,
    'Add from clipboard should be enabled with a validated clipboard URL'
  )

  // Press it through the real handler: the renderer must show the clipboard
  // banner for exactly that URL. No desktop surface is touched.
  const clipboardUrl = 'https://example.com/from-clipboard.bin'
  const pressed = await invokeTray([clipboardIndex])
  assert(pressed.invoked === true, `Add from clipboard was not invoked: ${JSON.stringify(pressed)}`)
  await waitFor(
    () =>
      renderer.evaluate(`(() => {
        const text = document.body.innerText
        return text.includes('Link on clipboard') && text.includes(${JSON.stringify(clipboardUrl)})
      })()`),
    Boolean,
    15_000,
    'clipboard banner from the tray'
  )
  await clickButton('Ignore')

  // One active transfer: "Pause all" must be enabled and must really pause it.
  const slowUrl = fixtureUrl('/features-slow.bin')
  const slowAdd = await renderer.evaluate(
    `window.donDownload.addDownload(${JSON.stringify({ url: slowUrl })})`
  )
  assert(slowAdd?.ok === true, `adding the slow fixture failed: ${JSON.stringify(slowAdd)}`)
  const active = await waitForDownload(
    'features-slow.bin',
    item => item.status === 'active' && item.completedBytes > 0,
    45_000,
    'active slow download'
  )
  const busy = await buildTrayMenu(null)
  assert(
    busy.state.statusLine.startsWith('1 downloading'),
    `active status line was ${busy.state.statusLine}`
  )
  assert(busy.state.canPauseAll === true, 'canPauseAll was false with an active download')
  const busyPause = busy.items[2]
  assert(
    busyPause?.label === 'Pause all' && busyPause?.enabled === true,
    `active pause item was ${JSON.stringify(busyPause)}`
  )
  assert(
    (busy.items[0]?.label ?? '').length > 0,
    'the active status line is empty'
  )

  const pauseResult = await invokeTray([2])
  assert(pauseResult.invoked === true, `Pause all was not invoked: ${JSON.stringify(pauseResult)}`)
  const paused = await waitForDownload(
    'features-slow.bin',
    item => item.status === 'paused',
    20_000,
    'tray Pause all'
  )
  const pausedMenu = await buildTrayMenu(null)
  assert(
    pausedMenu.items[2]?.label === 'Resume all' && pausedMenu.items[2]?.enabled === true,
    `paused menu pause item was ${JSON.stringify(pausedMenu.items[2])}`
  )
  const resumeResult = await invokeTray([2])
  assert(resumeResult.invoked === true, 'Resume all was not invoked')
  await waitForDownload(
    'features-slow.bin',
    item => item.status === 'active' || item.status === 'complete',
    20_000,
    'tray Resume all'
  )
  await renderer.evaluate(
    `window.donDownload.cancelDownload(${JSON.stringify(active.id)})`
  )
  await waitForDownload(
    'features-slow.bin',
    item => item.status === 'cancelled',
    20_000,
    'slow fixture cancel'
  )

  return {
    idle: {
      statusLine: idle.state.statusLine,
      pauseItem: idle.items[2],
      speedPresets: presetLabels,
      checkedPreset: checkedPresets[0]?.label,
      recent: recentLabels,
      addFromClipboard: idle.items[clipboardIndex]?.enabled
    },
    active: {
      statusLine: busy.state.statusLine,
      pauseItem: busyPause,
      pausedByTray: paused.status,
      resumedByTray: true
    },
    addFromClipboardPressed: clipboardUrl
  }
}

async function checkDiagnostics() {
  const planted = `api_key=${SECRET_MARKER} token=${SECRET_MARKER} https://example.com/private?token=${SECRET_MARKER}`
  await hookCall(`h.probeLog(${JSON.stringify(planted)}); return true`)

  const result = await renderer.evaluate('window.donDownload.getDiagnostics()')
  assert(result?.ok === true, `getDiagnostics failed: ${JSON.stringify(result)}`)
  const text = result.value
  assert(typeof text === 'string' && text.length > 0, 'diagnostics text was empty')
  assert(
    text.includes(`App version: ${appVersion}`),
    `diagnostics does not name the app version ${appVersion}`
  )
  assert(
    !text.includes(SECRET_MARKER),
    'diagnostics leaked the planted API key/token'
  )
  assert(
    !/(?:token|secret|password|api_key|apikey)=(?!\[redacted\])/i.test(text),
    'diagnostics contains an unredacted credential assignment'
  )
  assert(
    !text.includes(chosenDir),
    'diagnostics leaked the chosen download folder path'
  )

  await openSettingsPage()
  const helpSection = await renderer.evaluate(`(() => {
    const buttons = [...document.querySelectorAll('button')]
    const copy = buttons.find(item => item.innerText.trim() === 'Copy diagnostics')
    return {
      present: copy !== undefined && !copy.disabled,
      helpTitlePresent: document.body.innerText.includes('Help & diagnostics'),
      openLogFolder: buttons.some(item => item.innerText.trim() === 'Open log folder')
    }
  })()`)
  assert(helpSection.helpTitlePresent, 'the Help & diagnostics section is missing')
  assert(helpSection.present, 'the Copy diagnostics button is missing or disabled')

  return {
    appVersionLine: `App version: ${appVersion}`,
    bytes: text.length,
    leakedSecret: false,
    leakedChosenFolder: false,
    settingsUi: helpSection,
    clipboardWriteSkipped:
      'the button was not clicked so the real clipboard was left untouched; the text was read from the same IPC result'
  }
}

async function checkNotificationActivation() {
  const current = await snapshot()
  const item = current.downloads.find(
    download =>
      download.filename === 'features-saveto.bin' && download.status === 'complete'
  )
  assert(item !== undefined, 'no completed save-to download for the toast check')

  await clearHostCalls()
  await hookCall(
    `h.notificationActivate('download', ${JSON.stringify(item.id)}, 'open'); return true`
  )
  const openCall = await waitFor(
    async () => (await hostCalls()).find(call => call.method === 'openPath') ?? null,
    value => value !== null,
    15_000,
    'toast Open activation'
  )
  assert(
    samePath(openCall.target, item.filePath),
    `toast Open targeted ${openCall.target}, expected ${item.filePath}`
  )
  assert(
    sameDirOfFile(openCall.target, chosenDir),
    'toast Open resolved outside the chosen folder'
  )

  await clearHostCalls()
  await hookCall(
    `h.notificationActivate('download', ${JSON.stringify(item.id)}, 'show'); return true`
  )
  const showCall = await waitFor(
    async () =>
      (await hostCalls()).find(call => call.method === 'showItemInFolder') ?? null,
    value => value !== null,
    15_000,
    'toast Show-in-folder activation'
  )
  assert(
    samePath(showCall.target, item.filePath),
    `toast Show in folder targeted ${showCall.target}, expected ${item.filePath}`
  )

  await clearHostCalls()
  await hookCall(
    `h.notificationActivate('download', ${JSON.stringify(item.id)}, 'activate'); return true`
  )
  await sleep(700)
  const revealOnlyCalls = await hostCalls()
  assert(
    revealOnlyCalls.length === 0,
    `a body click must only reveal the row, but opened: ${JSON.stringify(revealOnlyCalls)}`
  )

  return {
    openTarget: openCall.target,
    showTarget: showCall.target,
    bodyClickShellCalls: revealOnlyCalls.length,
    activationPath:
      'Windows toast XML action → onActivate → revealRow/notificationAction IPC → renderer openFile/showInFolder → DownloadManager → host (recorded)'
  }
}

/* ------------------------------------------------------------------------- *
 * Run
 * ------------------------------------------------------------------------- */

try {
  if (!(await stat(appPath).catch(() => null))) {
    throw new Error(`Packaged app missing: ${appPath}`)
  }
  record(
    'loopback-fixture',
    'Loopback fixture server',
    'PASS',
    { port: fixturePort, files: fixtures.map(entry => entry.name) },
    0
  )
  await startApp()

  const duplicatePassed = await check(
    'duplicate-warning',
    'Renderer duplicate warning and its setting',
    checkDuplicateWarning
  )
  const saveToPassed = await check(
    'save-to-destination',
    'Save to: chosen folder, restart, Open/Show in folder, invalid refusals',
    checkSaveToDestination
  )

  // The save-to check restarts the app; the remaining checks need it running.
  if (!appProcess || appProcess.exitCode !== null) await startApp()

  const trayPassed = await check(
    'tray-menu',
    'Tray menu items, enablement and Pause all',
    checkTrayMenu
  )
  const diagnosticsPassed = await check(
    'diagnostics',
    'Copy diagnostics text: version present, secrets redacted',
    checkDiagnostics
  )
  const notificationPassed = await check(
    'notification-activation',
    'Completion-toast Open/Show resolves the recorded path',
    checkNotificationActivation
  )

  const failed = checks.filter(entry => entry.status === 'FAIL')
  const report = {
    status: failed.length === 0 ? 'PASS' : 'FAIL',
    startedAt,
    finishedAt: new Date().toISOString(),
    app: appPath,
    appVersion,
    mode: 'packaged Electron, smoke + interactive + features-verify hooks, hidden offscreen window',
    renderer: 'production renderer + preload + trusted IPC + DownloadManager + aria2',
    userData,
    chosenDir,
    checks: {
      duplicateWarning: duplicatePassed,
      saveToDestination: saveToPassed,
      trayMenu: trayPassed,
      diagnostics: diagnosticsPassed,
      notificationActivation: notificationPassed
    },
    results: checks
  }
  await writeFile(path.join(runDir, 'result.json'), JSON.stringify(report, null, 2))
  console.log(`FEATURES_RESULT ${path.join(runDir, 'result.json')}`)
  if (failed.length > 0) process.exitCode = 1
} catch (error) {
  const detail =
    error instanceof Error ? error.stack ?? error.message : String(error)
  const report = {
    status: 'FAIL',
    startedAt,
    finishedAt: new Date().toISOString(),
    app: appPath,
    error: detail,
    userData,
    chosenDir,
    results: checks
  }
  await writeFile(path.join(runDir, 'result.json'), JSON.stringify(report, null, 2)).catch(
    () => {}
  )
  console.error(`FEATURES_FAIL ${detail}`)
  process.exitCode = 1
} finally {
  await stopApp().catch(error => console.error(`App cleanup warning: ${error.message}`))
  await killLeftoverChildren()
  await new Promise(resolve => fixtureServer.close(resolve))
  // Keep the downloaded fixtures out of the report directory's default folder.
  await rm(path.join(defaultDownloadDir, 'features-dup.bin'), { force: true }).catch(
    () => {}
  )
}
