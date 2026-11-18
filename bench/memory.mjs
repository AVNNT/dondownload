#!/usr/bin/env node
/**
 * Reproducible RAM benchmark for DonDownload.
 *
 *   npm run bench:memory              # build if stale, 3 runs, median table
 *   npm run bench:memory -- --runs 5  # more runs
 *   BENCH_MEMORY_SKIP_BUILD=1 npm run bench:memory
 *
 * Each run launches the built app with the real renderer and tray against a
 * fresh temporary userData directory. `DONDOWNLOAD_MEMORY_BENCH` makes the main
 * process sample `app.getAppMetrics()` in three phases (window open and idle,
 * hidden to tray, shown again), write JSON, and quit. This script medians the
 * phases across runs, prints the table and appends it to `bench/results/`.
 *
 * The absolute numbers are machine-specific; compare runs on the same machine.
 */
import { spawn, spawnSync } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import {
  formatMegabytes,
  formatTable,
  summarizeRuns
} from './lib/memory-stats.mjs'

const benchDirectory = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(benchDirectory, '..')
const resultsDirectory = path.join(benchDirectory, 'results')
const builtMain = path.join(repositoryRoot, 'out', 'main', 'index.js')
const MEMORY_BENCH_ENV = 'DONDOWNLOAD_MEMORY_BENCH'
const DEFAULT_RUNS = 3
const DEFAULT_TIMEOUT_MS = 180_000

function usage() {
  console.log(`Usage: node bench/memory.mjs [options]

Options:
  --runs <n>          Number of app launches to median (default ${DEFAULT_RUNS}).
  --timeout-ms <ms>   Per-run wall-clock timeout (default ${DEFAULT_TIMEOUT_MS}).
  --skip-build        Reuse the existing out/ directory.
  --keep              Keep each run's temporary userData directory.
  --help              Show this help.

The app is launched three times by default; each launch measures:
  window-open-idle   window visible and idle after a 10 s settle
  hidden-to-tray     close-to-tray path (renderer destroyed) after 10 s
  shown-again        window restored from the tray after 10 s`)
}

function parseArguments(argv) {
  const options = {
    runs: DEFAULT_RUNS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    skipBuild: process.env.BENCH_MEMORY_SKIP_BUILD === '1',
    keep: false
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
    } else if (argument === '--runs') {
      const runs = Number(readValue())
      if (!Number.isInteger(runs) || runs < 1 || runs > 20) {
        throw new Error('--runs must be an integer between 1 and 20.')
      }
      options.runs = runs
    } else if (argument === '--timeout-ms') {
      const timeout = Number(readValue())
      if (!Number.isInteger(timeout) || timeout < 30_000 || timeout > 600_000) {
        throw new Error('--timeout-ms must be between 30000 and 600000.')
      }
      options.timeoutMs = timeout
    } else if (argument === '--skip-build') {
      options.skipBuild = true
    } else if (argument === '--keep') {
      options.keep = true
    } else {
      throw new Error(`Unknown argument: ${argument}`)
    }
  }

  return options
}

function newestSourceMtime(directory) {
  let newest = 0
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestSourceMtime(entryPath))
    } else if (entry.isFile()) {
      newest = Math.max(newest, statSync(entryPath).mtimeMs)
    }
  }
  return newest
}

/** Build when out/ is missing or older than the source it bundles. */
function buildIfNeeded(options) {
  if (options.skipBuild) {
    console.log('bench:memory reusing existing out/ (--skip-build)')
    return
  }

  const sourceRoots = ['src', 'electron.vite.config.ts', 'package.json']
  let newestSource = 0
  for (const root of sourceRoots) {
    const resolved = path.join(repositoryRoot, root)
    if (!existsSync(resolved)) continue
    const stats = statSync(resolved)
    newestSource = Math.max(
      newestSource,
      stats.isDirectory() ? newestSourceMtime(resolved) : stats.mtimeMs
    )
  }

  const builtAt = existsSync(builtMain) ? statSync(builtMain).mtimeMs : 0
  if (builtAt > 0 && builtAt >= newestSource) {
    console.log('bench:memory out/ is current; skipping build')
    return
  }

  console.log('bench:memory building current source…')
  const build = spawnSync('npm run build', {
    cwd: repositoryRoot,
    shell: true,
    stdio: 'inherit'
  })
  if (build.error) throw build.error
  if (build.status !== 0) {
    throw new Error(`npm run build failed with exit code ${build.status}.`)
  }
}

function resolveElectronExecutable() {
  const require = createRequire(import.meta.url)
  let executable
  try {
    executable = require('electron')
  } catch {
    executable = null
  }
  if (typeof executable === 'string' && existsSync(executable)) {
    return executable
  }
  throw new Error(
    'The Electron binary was not found. Run npm install (and npm run build).'
  )
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
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        shell: false,
        windowsHide: true,
        stdio: 'ignore'
      }).on('error', () => {
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

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function formatRunLine(index, report) {
  const parts = (report?.phases ?? []).map(
    (phase) => `${phase.phase} ${formatMegabytes(phase.total)}`
  )
  return `bench:memory run ${index}: ${parts.join(' · ')}`
}

async function runOnce({ index, executable, timeoutMs, keep }) {
  const userData = path.join(
    os.tmpdir(),
    `dondownload-memory-bench-${process.pid}-${index}`
  )
  rmSync(userData, { recursive: true, force: true })
  mkdirSync(userData, { recursive: true })
  const outPath = path.join(userData, 'memory-bench.json')

  const environment = { ...process.env }
  delete environment.ELECTRON_RUN_AS_NODE
  environment[MEMORY_BENCH_ENV] = outPath
  // A parent bench session must not silently reuse smoke/bench configuration.
  delete environment.DONDOWNLOAD_SMOKE_TEST
  delete environment.DONDOWNLOAD_SMOKE_RESULT_PATH
  delete environment.DONDOWNLOAD_INTERACTIVE_SMOKE

  console.log(`bench:memory run ${index} starting (userData: ${userData})`)
  const child = spawn(
    executable,
    [repositoryRoot, `--user-data-dir=${userData}`],
    {
      cwd: repositoryRoot,
      env: environment,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )

  const output = []
  let spawnError = null
  child.once('error', (error) => {
    spawnError = error instanceof Error ? error.message : String(error)
  })
  child.stdout?.on('data', (chunk) => {
    output.push(Buffer.from(chunk))
  })
  child.stderr?.on('data', (chunk) => {
    const text = Buffer.from(chunk).toString('utf8')
    output.push(Buffer.from(chunk))
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith('[dondownload-memory-bench]')) console.log(line)
    }
  })

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    console.error(
      `bench:memory run ${index} timed out after ${timeoutMs} ms; terminating only its process tree.`
    )
    killOwnChildTree(child)
  }, timeoutMs)

  const exit = await waitForExit(child)
  clearTimeout(timer)

  const report = readJson(outPath)
  const failed =
    spawnError !== null ||
    timedOut ||
    report === null ||
    !Array.isArray(report.phases) ||
    report.phases.length === 0

  if (failed) {
    console.error(
      `bench:memory run ${index} produced no usable report (exit=${exit.code ?? 'null'}, timeout=${timedOut}).`
    )
    if (spawnError !== null) console.error(`bench:memory spawn error: ${spawnError}`)
    const tail = Buffer.concat(output).toString('utf8').trim().slice(-4_000)
    if (tail.length > 0) {
      console.error('bench:memory application stderr (tail):')
      console.error(tail)
    }
    console.error(`bench:memory kept failed userData: ${userData}`)
    return { ok: false, report: null, userData }
  }

  console.log(formatRunLine(index, report))
  if (keep) {
    console.log(`bench:memory kept userData: ${userData}`)
  } else {
    rmSync(userData, { recursive: true, force: true })
  }
  return { ok: true, report, userData }
}

function writeResults({ runs, summary, requestedRuns }) {
  mkdirSync(resultsDirectory, { recursive: true })
  const generatedAt = new Date().toISOString()
  const environment = {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpu: os.cpus()[0]?.model ?? 'unknown',
    cores: os.cpus().length,
    totalMemoryGiB:
      Math.round((os.totalmem() / (1024 * 1024 * 1024)) * 10) / 10,
    electron: runs.find((run) => run.report?.electron)?.report?.electron ?? 'unknown',
    gpu: process.env.DONDOWNLOAD_GPU === '1' ? 'hardware' : 'software',
    launcher: 'source-production-build'
  }

  const latestFile = path.join(resultsDirectory, 'memory-latest.json')
  writeFileSync(
    latestFile,
    `${JSON.stringify(
      {
        generatedAt,
        environment,
        requestedRuns,
        completedRuns: runs.filter((run) => run.ok).length,
        phases: summary,
        runs: runs.map((run, index) => ({
          run: index + 1,
          ok: run.ok,
          phases: run.report?.phases ?? []
        }))
      },
      null,
      2
    )}\n`,
    'utf8'
  )

  const historyFile = path.join(resultsDirectory, 'memory-history.jsonl')
  appendFileSync(
    historyFile,
    `${JSON.stringify({ generatedAt, environment, phases: summary })}\n`,
    'utf8'
  )

  return { latestFile, historyFile }
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  buildIfNeeded(options)
  if (!existsSync(builtMain)) {
    throw new Error(
      `The built app is missing at ${builtMain}. Run npm run build.`
    )
  }
  const executable = resolveElectronExecutable()

  const runs = []
  for (let index = 1; index <= options.runs; index += 1) {
    runs.push(
      await runOnce({
        index,
        executable,
        timeoutMs: options.timeoutMs,
        keep: options.keep
      })
    )
  }

  const successful = runs.filter((run) => run.ok)
  if (successful.length === 0) {
    throw new Error('Every memory benchmark run failed; see the logs above.')
  }

  const summary = summarizeRuns(successful.map((run) => run.report))
  const { latestFile, historyFile } = writeResults({
    runs,
    summary,
    requestedRuns: options.runs
  })

  const cpu = os.cpus()[0]?.model ?? 'unknown'
  console.log('')
  console.log(
    `DonDownload memory benchmark — ${successful.length}/${options.runs} runs · ${process.platform} ${process.arch} · ${cpu}`
  )
  console.log(
    `Electron ${runs.find((run) => run.report?.electron)?.report?.electron ?? 'unknown'} · GPU ${process.env.DONDOWNLOAD_GPU === '1' ? 'hardware' : 'software'} · values are median working-set MB (MiB)`
  )
  console.log('')
  console.log(formatTable(summary))
  console.log('')
  console.log(`Wrote ${path.relative(process.cwd(), latestFile)} (structured baseline)`)
  console.log(`Appended ${path.relative(process.cwd(), historyFile)} (history)`)
  process.exitCode = successful.length === options.runs ? 0 : 1
}

try {
  await main()
} catch (error) {
  console.error(
    `bench:memory failed: ${error instanceof Error ? error.message : String(error)}`
  )
  process.exitCode = 1
}
