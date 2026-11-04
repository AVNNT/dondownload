#!/usr/bin/env node
/**
 * Safe, opt-in smoke test for a packaged/unpacked DonDownload production app.
 *
 * It starts the real Electron app against a fresh isolated userData directory,
 * asks the app for machine-readable PASS/FAIL details, and kills only the
 * process tree it created. It never installs, never opens the normal profile,
 * never uses OS input and never starts the browser bridge/tray/visible window.
 */
import { spawn } from 'node:child_process'
import { promises as fs, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(scriptDirectory, '..')
const SMOKE_ENV = 'DONDOWNLOAD_SMOKE_TEST'
const SMOKE_RESULT_ENV = 'DONDOWNLOAD_SMOKE_RESULT_PATH'
const TOOL_OVERRIDE_ENV = [
  'DONDOWNLOAD_ARIA2_PATH',
  'DONDOWNLOAD_YTDLP_PATH',
  'DONDOWNLOAD_FFMPEG_PATH',
  'DONDOWNLOAD_FFPROBE_PATH',
  'DONDOWNLOAD_DENO_PATH'
]
const DEFAULT_TIMEOUT_MS = 120_000

function usage() {
  console.log(`Usage: node scripts/smoke-test.mjs [options]

Options:
  --app <path>            Packaged/unpacked DonDownload executable to run.
                          Defaults to dist/win-unpacked/DonDownload.exe when present,
                          otherwise node_modules/electron/dist/electron.exe with the
                          built out/ app.
  --user-data-dir <path>  Use this directory instead of a fresh temp directory.
                          It must be new/empty and is never deleted automatically.
  --keep                  Keep the generated temporary userData directory.
  --timeout-ms <ms>       Bounded wall-clock timeout (default ${DEFAULT_TIMEOUT_MS}).
  --allow-tool-overrides  Keep DONDOWNLOAD_*_PATH tool overrides. By default they
                          are removed so bundled resources are exercised.
  --help                  Show this help.

Exit code 0 means the app reported PASS and exited normally. Any failure or
timeout is non-zero. The app writes smoke-result.json inside its isolated
userData directory; this script also prints the full result JSON.`)
}

function parseArguments(argv) {
  const options = {
    app: null,
    userDataDir: null,
    keep: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    allowToolOverrides: false
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const readValue = () => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${argument} requires a value.`)
      }
      index += 1
      return value
    }

    if (argument === '--help' || argument === '-h') {
      usage()
      process.exit(0)
    } else if (argument === '--app') {
      options.app = readValue()
    } else if (argument === '--user-data-dir') {
      options.userDataDir = readValue()
    } else if (argument === '--timeout-ms') {
      const timeout = Number(readValue())
      if (!Number.isInteger(timeout) || timeout < 5_000 || timeout > 600_000) {
        throw new Error('--timeout-ms must be between 5000 and 600000.')
      }
      options.timeoutMs = timeout
    } else if (argument === '--keep') {
      options.keep = true
    } else if (argument === '--allow-tool-overrides') {
      options.allowToolOverrides = true
    } else {
      throw new Error(`Unknown argument: ${argument}`)
    }
  }

  return options
}

async function resolveApplication(requestedApp) {
  if (requestedApp) {
    const resolved = path.resolve(requestedApp)
    await fs.access(resolved)
    return {
      executable: resolved,
      cwd: path.dirname(resolved),
      appArguments: [],
      kind: 'packaged-or-custom'
    }
  }

  const unpacked = path.join(
    repositoryRoot,
    'dist',
    'win-unpacked',
    'DonDownload.exe'
  )
  if (existsSync(unpacked)) {
    return {
      executable: unpacked,
      cwd: path.dirname(unpacked),
      appArguments: [],
      kind: 'unpacked-package'
    }
  }

  const electron = path.join(
    repositoryRoot,
    'node_modules',
    'electron',
    'dist',
    'electron.exe'
  )
  const builtMain = path.join(repositoryRoot, 'out', 'main', 'index.js')
  if (existsSync(electron) && existsSync(builtMain)) {
    return {
      executable: electron,
      cwd: repositoryRoot,
      appArguments: [repositoryRoot],
      kind: 'source-production-build'
    }
  }

  throw new Error(
    'No production app was found. Run "npm run build" and create an unpacked package ' +
      '(for example: npx electron-builder --win --x64 --dir), or pass --app <exe>.'
  )
}

async function createUserDataDirectory(requested) {
  if (requested) {
    const resolved = path.resolve(requested)
    if (existsSync(resolved)) {
      const entries = await fs.readdir(resolved)
      if (entries.length > 0) {
        throw new Error(
          `--user-data-dir must be a new or empty directory: ${resolved}`
        )
      }
    } else {
      await fs.mkdir(resolved, { recursive: true })
    }
    return { directory: resolved, temporary: false }
  }

  return {
    directory: await fs.mkdtemp(
      path.join(os.tmpdir(), 'dondownload-smoke-')
    ),
    temporary: true
  }
}

function killOwnChildTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const pid = child.pid
  if (typeof pid !== 'number' || pid <= 0) {
    try {
      child.kill()
    } catch {
      // The process may already be gone.
    }
    return
  }

  if (process.platform === 'win32') {
    // Fixed arguments, no shell, and only the PID this script created.
    try {
      const killer = spawn(
        'taskkill',
        ['/pid', String(pid), '/T', '/F'],
        { shell: false, windowsHide: true, stdio: 'ignore' }
      )
      killer.on('error', () => {
        try {
          child.kill()
        } catch {
          // The process may already be gone.
        }
      })
    } catch {
      try {
        child.kill()
      } catch {
        // The process may already be gone.
      }
    }
  } else {
    try {
      child.kill('SIGKILL')
    } catch {
      // The process may already be gone.
    }
  }
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode })
  }
  return new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }))
    child.once('error', () => resolve({ code: null, signal: null }))
  })
}

async function readResult(resultPath) {
  try {
    const text = await fs.readFile(resultPath, 'utf8')
    return JSON.parse(text)
  } catch {
    return null
  }
}

function printSummary(result, fallback) {
  const value = result ?? fallback
  console.log(`SMOKE ${value.status ?? 'FAIL'}`)
  for (const check of value.checks ?? []) {
    console.log(
      `  ${check.status} ${check.name}: ${check.detail ?? 'no detail'}`
    )
  }
  console.log(JSON.stringify(value, null, 2))
}

async function main() {
  let options
  try {
    options = parseArguments(process.argv.slice(2))
    const application = await resolveApplication(options.app)
    const userData = await createUserDataDirectory(options.userDataDir)
    const resultPath = path.join(userData.directory, 'smoke-result.json')

    const environment = { ...process.env }
    delete environment.ELECTRON_RUN_AS_NODE
    if (!options.allowToolOverrides) {
      for (const key of TOOL_OVERRIDE_ENV) delete environment[key]
    }
    environment[SMOKE_ENV] = '1'
    environment[SMOKE_RESULT_ENV] = resultPath

    const childArguments = [
      ...application.appArguments,
      '--smoke-test',
      `--user-data-dir=${userData.directory}`
    ]

    console.log(`SMOKE launching ${application.kind}: ${application.executable}`)
    console.log(`SMOKE userData: ${userData.directory}`)

    const child = spawn(application.executable, childArguments, {
      cwd: application.cwd,
      env: environment,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    const stdout = []
    const stderr = []
    let spawnError = null
    child.once('error', (error) => {
      spawnError = error instanceof Error ? error.message : String(error)
    })
    child.stdout?.on('data', (chunk) => stdout.push(Buffer.from(chunk)))
    child.stderr?.on('data', (chunk) => stderr.push(Buffer.from(chunk)))

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      console.error(
        `SMOKE timeout after ${options.timeoutMs} ms; terminating only the process tree started by this script.`
      )
      killOwnChildTree(child)
    }, options.timeoutMs)

    const exit = await waitForExit(child)
    clearTimeout(timer)

    const result = await readResult(resultPath)
    const stdoutText = Buffer.concat(stdout).toString('utf8').trim()
    const stderrText = Buffer.concat(stderr).toString('utf8').trim()

    if (result === null) {
      const fallback = {
        status: 'FAIL',
        checks: [
          {
            name: 'harness.result-file',
            status: 'FAIL',
            detail: timedOut
              ? 'The smoke test timed out before writing its result file.'
              : 'The app exited without writing its result file.',
            durationMs: 0
          }
        ],
        process: {
          exitCode: exit.code,
          signal: exit.signal,
          timedOut,
          spawnError
        },
        standardOutput: stdoutText.slice(-8_000),
        standardError: stderrText.slice(-8_000),
        note: 'No smoke-result.json was produced; see stderr for app logs.'
      }
      printSummary(null, fallback)
      if (userData.temporary) {
        console.error(`SMOKE kept failed userData: ${userData.directory}`)
      }
      process.exitCode = 1
      return
    }

    printSummary(result, null)
    console.log(
      `SMOKE process exit=${exit.code ?? 'null'} signal=${exit.signal ?? 'none'} timeout=${timedOut}`
    )
    if (stderrText.length > 0) {
      console.log('SMOKE application stderr (tail):')
      console.log(stderrText.slice(-8_000))
    }

    const passed =
      !timedOut && result.status === 'PASS' && exit.code === 0
    if (passed && userData.temporary && !options.keep) {
      await fs.rm(userData.directory, { recursive: true, force: true })
      console.log('SMOKE removed temporary userData after PASS')
    } else {
      console.log(`SMOKE userData kept for inspection: ${userData.directory}`)
    }

    process.exitCode = passed ? 0 : 1
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    console.error(`SMOKE FAIL harness: ${detail}`)
    process.exitCode = 1
  }
}

await main()
