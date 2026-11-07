#!/usr/bin/env node
/**
 * DonDownload benchmark runner.
 *
 *   npm run bench
 *
 * Builds the current source (so bundle sizes and main-process code are fresh),
 * runs benchmarks 1–4 through Vitest and prints a compact table. The structured
 * baseline is written to `bench/results/latest.json`.
 *
 * Set BENCH_SKIP_BUILD=1 to reuse an existing `out/` directory.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const benchDirectory = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(benchDirectory, '..')
const resultsDirectory = path.join(benchDirectory, 'results')
const partialDirectory = path.join(resultsDirectory, 'partial')
const vitestCli = path.join(repositoryRoot, 'node_modules', 'vitest', 'vitest.mjs')

const numberFormat = new Intl.NumberFormat('en-US')

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    stdio: 'inherit'
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

/** npm is a .cmd shim on Windows, so scripts go through one shell string. */
function runNpm(script) {
  const result = spawnSync(`npm run ${script}`, {
    cwd: repositoryRoot,
    stdio: 'inherit',
    shell: true
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function formatBytes(bytes) {
  const sign = bytes < 0 ? '-' : ''
  const value = Math.abs(bytes)
  if (value < 1024) return `${sign}${value} B`
  if (value < 1024 * 1024) return `${sign}${(value / 1024).toFixed(1)} KiB`
  return `${sign}${(value / (1024 * 1024)).toFixed(2)} MiB`
}

function formatMs(value) {
  if (value > 0 && value < 0.01) return `${(value * 1000).toFixed(1)} µs`
  return `${Number(value).toFixed(2)} ms`
}

function label(text, width = 40) {
  return `  ${text.padEnd(width)}`
}

function row(name, value, width = 40) {
  return `${label(name, width)}${value}`
}

function line(name, value) {
  process.stdout.write(`${row(name, value)}\n`)
}

function readPartial(id) {
  const file = path.join(partialDirectory, `${id}.json`)
  if (!existsSync(file)) {
    throw new Error(
      `bench: missing ${path.relative(repositoryRoot, file)}. Vitest did not finish benchmark "${id}".`
    )
  }
  return JSON.parse(readFileSync(file, 'utf8'))
}

function printDatabase(result) {
  process.stdout.write('\nDATABASE (real DownloadDatabase, temporary SQLite file)\n')
  line(
    `Insert ${numberFormat.format(result.insert.rows)} history rows`,
    `${formatMs(result.insert.totalMs)} (${result.insert.perRowMs.toFixed(3)} ms/row, ${numberFormat.format(result.insert.rowsPerSecond)} rows/s)`
  )
  line(
    `Progress tick (${result.progress.activeDownloads} active, ${result.progress.simulatedSeconds} s)`,
    `p50 ${formatMs(result.progress.tickMs.p50)}  p95 ${formatMs(result.progress.tickMs.p95)}  max ${formatMs(result.progress.tickMs.max)}`
  )
  line(
    'Progress writes',
    `${numberFormat.format(result.progress.rowUpdates)} row updates · ${result.progress.flushes} flushes · ${numberFormat.format(result.progress.sqliteRowWrites)} SQLite row writes`
  )
  for (const [name, query] of Object.entries(result.queries)) {
    line(
      `${name}()`,
      `p50 ${formatMs(query.p50)}  min ${formatMs(query.min)} (${query.iterations} runs)`
    )
  }
}

function printProgress(result) {
  process.stdout.write('\nPROGRESS PIPELINE (real DownloadManager, fake aria2 RPC transport)\n')
  for (const entry of result.results) {
    line(
      `${entry.activeDownloads} active downloads`,
      `CPU p50 ${formatMs(entry.tickMs.p50)}  p95 ${formatMs(entry.tickMs.p95)} · IPC ${formatBytes(entry.ipcBytes.p50)}/tick · JSON ${formatBytes(entry.jsonBytes.p50)} · encode ${formatMs(entry.ipcEncodeMs.p50)}`
    )
  }
}

function printRenderer(result) {
  process.stdout.write('\nRENDERER (real DownloadTable in jsdom, 720 px viewport)\n')
  for (const entry of result.cases) {
    line(
      `${numberFormat.format(entry.rows)} rows · mount`,
      `${formatMs(entry.mount.wallMs)} (${formatMs(entry.mount.profilerMs)} React) · ${entry.mount.commits} commit(s) · ${entry.mount.rowRenders} row renders`
    )
    line(
      `${numberFormat.format(entry.rows)} rows · ${entry.updates.updates} updates`,
      `${entry.updates.commits} commits · ${formatMs(entry.updates.totalRenderMs)} React · ${entry.updates.rowRendersPerUpdate.p50} rows re-rendered/update (p95 ${entry.updates.rowRendersPerUpdate.p95})`
    )
  }
}

function printStartup(result) {
  process.stdout.write('\nSTARTUP BUNDLES (fresh npm run build)\n')
  line('main', `${formatBytes(result.main.rawBytes)} raw · ${formatBytes(result.main.gzipBytes)} gzip`)
  if (result.preload.files.length > 0) {
    line('preload', `${formatBytes(result.preload.rawBytes)} raw · ${formatBytes(result.preload.gzipBytes)} gzip`)
  }
  line('renderer JS', `${formatBytes(result.rendererJs.rawBytes)} raw · ${formatBytes(result.rendererJs.gzipBytes)} gzip`)
  line('renderer CSS', `${formatBytes(result.rendererCss.rawBytes)} raw · ${formatBytes(result.rendererCss.gzipBytes)} gzip`)
  line('renderer total', `${formatBytes(result.rendererTotal.rawBytes)} raw · ${formatBytes(result.rendererTotal.gzipBytes)} gzip`)
  const largest = result.largestChunks[0]
  if (largest !== undefined) {
    line('largest chunk', `${largest.file} · ${formatBytes(largest.rawBytes)} raw · ${formatBytes(largest.gzipBytes)} gzip`)
  }
  line(
    'module stats file',
    result.statsFile === null
      ? 'not emitted (electron-vite default)'
      : `${result.statsFile.file} · ${formatBytes(result.statsFile.rawBytes)}`
  )
}

function main() {
  if (process.env.BENCH_SKIP_BUILD === '1') {
    process.stdout.write('bench: reusing existing out/ (BENCH_SKIP_BUILD=1)\n')
  } else {
    process.stdout.write('bench: building current source…\n')
    runNpm('build')
  }

  if (!existsSync(vitestCli)) {
    throw new Error(`bench: Vitest CLI not found at ${vitestCli}. Run npm install.`)
  }

  rmSync(partialDirectory, { recursive: true, force: true })

  run(process.execPath, [
    vitestCli,
    'run',
    '--config',
    path.join(benchDirectory, 'vitest.config.mts'),
    '--reporter=dot'
  ])

  const results = {
    generatedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpu: os.cpus()[0]?.model ?? 'unknown',
      cores: os.cpus().length,
      totalMemoryGiB:
        Math.round((os.totalmem() / (1024 * 1024 * 1024)) * 10) / 10
    },
    results: {
      db: readPartial('db'),
      progress: readPartial('progress'),
      renderer: readPartial('renderer'),
      startup: readPartial('startup')
    }
  }

  const latestFile = path.join(resultsDirectory, 'latest.json')
  writeFileSync(latestFile, `${JSON.stringify(results, null, 2)}\n`, 'utf8')

  const environment = results.environment
  process.stdout.write(
    `\nDonDownload performance baseline — ${results.generatedAt}\n`
  )
  process.stdout.write(
    `Node ${environment.node} · ${environment.platform} ${environment.arch} · ${environment.cpu} (${environment.cores} cores, ${environment.totalMemoryGiB} GiB)\n`
  )

  printDatabase(results.results.db)
  printProgress(results.results.progress)
  printRenderer(results.results.renderer)
  printStartup(results.results.startup)

  process.stdout.write(
    `\nWrote ${path.relative(process.cwd(), latestFile)} (structured baseline)\n`
  )
}

try {
  main()
} catch (error) {
  process.stderr.write(
    `bench failed: ${error instanceof Error ? error.message : String(error)}\n`
  )
  process.exit(1)
}
