/**
 * Local aria2 throughput benchmark.
 *
 * Serves a 1 GiB deterministically generated file over loopback HTTP with
 * Range support and an optional per-socket byte rate cap (a "slow server"),
 * then downloads it through the *production* launch arguments returned by
 * `buildAria2Args` plus one candidate override at a time.
 *
 * Nothing here runs during `npm test` or `npm run test:fast`: the include in
 * `tests/bench/vitest.bench.config.ts` only matches `*.bench.ts`. Temps files
 * live in a fresh OS temp directory and every aria2 process is shut down and
 * every file removed before the test ends.
 *
 * Run:
 *   npm run bench:throughput
 *   $env:BENCH_SCENARIO = 'fast'; npm run bench:throughput
 *   $env:BENCH_RUNS = '3'; npm run bench:throughput
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as createNetServer, type Socket } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { buildAria2Args } from '../../src/main/aria2/args'
import { Aria2Client } from '../../src/main/aria2/client'
import { parseAria2Status } from '../../src/main/aria2/rpc'

const MB = 1024 * 1024

/** Environment overrides keep the default invocation short and repeatable. */
const scenario = process.env.BENCH_SCENARIO ?? 'all'
const runsPerVariant = Math.max(1, Number(process.env.BENCH_RUNS ?? '2'))
const variantFilter =
  process.env.BENCH_VARIANTS?.split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0) ?? null
const largeFileBytes = Math.max(64, Number(process.env.BENCH_SIZE_MB ?? '1024')) * MB
const throttledFileBytes = Math.max(
  64,
  Number(process.env.BENCH_THROTTLED_SIZE_MB ?? '512')
) * MB

const PATTERN_BYTES = 64 * 1024

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Deterministic, non-compressible-looking repeated pattern (served from RAM). */
function buildPattern(): Buffer {
  const pattern = Buffer.allocUnsafe(PATTERN_BYTES)
  let state = 0x12345678
  for (let index = 0; index < pattern.length; index += 1) {
    state = (state * 1664525 + 1013904223) >>> 0
    pattern[index] = (state >>> 16) & 0xff
  }
  return pattern
}

const PATTERN = buildPattern()

function aria2Binary(): string {
  const override =
    process.env.ARIA2_TEST_BINARY ??
    process.env.DONDOWNLOAD_ARIA2_PATH ??
    process.env.ARIA2_BENCHMARK_BINARY
  if (override) return path.resolve(override)
  // The benchmark is Windows-first; aria2c is on PATH in the verified setup.
  return process.platform === 'win32' ? 'aria2c.exe' : 'aria2c'
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (typeof address !== 'object' || address === null) {
        server.close()
        reject(new Error('No port available.'))
        return
      }
      const port = address.port
      server.close((error) => (error ? reject(error) : resolve(port)))
    })
  })
}

interface RangeRequest {
  start: number
  end: number
}

function parseRangeHeader(
  header: string | undefined,
  totalLength: number
): RangeRequest | null | 'invalid' {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return 'invalid'
  const rawStart = match[1] ?? ''
  const rawEnd = match[2] ?? ''
  if (rawStart === '' && rawEnd === '') return 'invalid'

  let start: number
  let end: number
  if (rawStart === '') {
    const suffixLength = Number(rawEnd)
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return 'invalid'
    start = Math.max(0, totalLength - suffixLength)
    end = totalLength - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? totalLength - 1 : Number(rawEnd)
  }

  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    start >= totalLength
  ) {
    return 'invalid'
  }
  return { start, end: Math.min(end, totalLength - 1) }
}

function waitForDrain(response: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    const finish = (): void => {
      response.removeListener('drain', finish)
      response.removeListener('close', finish)
      response.removeListener('error', finish)
      resolve()
    }
    response.once('drain', finish)
    response.once('close', finish)
    response.once('error', finish)
  })
}

/** Fixed-size chunks from the repeating pattern; no allocation per byte. */
async function writeGenerated(
  response: ServerResponse,
  start: number,
  length: number,
  bytesPerSecond: number
): Promise<void> {
  const chunkBytes = PATTERN_BYTES
  let position = start
  let remaining = length
  // Token bucket: first chunk is sent immediately, later chunks are paced so
  // the long-run rate matches bytesPerSecond on this one socket.
  let nextAllowedAt = performance.now()

  while (remaining > 0) {
    if (response.destroyed || response.writableEnded) return
    const patternOffset = position % PATTERN_BYTES
    const take = Math.min(chunkBytes, PATTERN_BYTES - patternOffset, remaining)

    if (bytesPerSecond > 0) {
      const now = performance.now()
      if (nextAllowedAt < now) nextAllowedAt = now
      const wait = nextAllowedAt - now
      if (wait > 0) await delay(wait)
      nextAllowedAt += (take / bytesPerSecond) * 1000
    }

    if (!response.write(PATTERN.subarray(patternOffset, patternOffset + take))) {
      await waitForDrain(response)
    }
    position += take
    remaining -= take
  }

  if (!response.destroyed && !response.writableEnded) response.end()
}

interface Fixture {
  url: string
  stats: {
    connections: number
    requests: number
    rangeRequests: number
    maxActive: number
  }
  close: () => Promise<void>
}

async function startFixture(options: {
  fileBytes: number
  perSocketBytesPerSecond: number
}): Promise<Fixture> {
  const sockets = new Set<Socket>()
  const stats = {
    connections: 0,
    requests: 0,
    rangeRequests: 0,
    maxActive: 0
  }
  let active = 0

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    response.on('error', () => undefined)
    stats.requests += 1

    const range = parseRangeHeader(request.headers.range, options.fileBytes)
    if (range === 'invalid') {
      response.writeHead(416, { 'content-range': `bytes */${options.fileBytes}` })
      response.end()
      return
    }
    if (range) stats.rangeRequests += 1

    const start = range?.start ?? 0
    const end = range?.end ?? options.fileBytes - 1
    const headers: Record<string, string | number> = {
      'content-type': 'application/octet-stream',
      'content-length': end - start + 1,
      'accept-ranges': 'bytes',
      'content-disposition': 'attachment; filename="bench.bin"'
    }
    if (range) {
      headers['content-range'] = `bytes ${start}-${end}/${options.fileBytes}`
    }

    response.writeHead(range ? 206 : 200, headers)
    if (request.method === 'HEAD') {
      response.end()
      return
    }

    active += 1
    stats.maxActive = Math.max(stats.maxActive, active)
    let finished = false
    const finish = (): void => {
      if (finished) return
      finished = true
      active -= 1
    }
    response.once('close', finish)
    response.once('finish', finish)

    void writeGenerated(
      response,
      start,
      end - start + 1,
      options.perSocketBytesPerSecond
    ).catch(() => {
      if (!response.destroyed) response.destroy()
    })
  })

  server.on('connection', (socket) => {
    stats.connections += 1
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (typeof address !== 'object' || address === null) {
    throw new Error('HTTP benchmark server did not start.')
  }

  return {
    url: `http://127.0.0.1:${address.port}/bench.bin`,
    stats,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      server.closeAllConnections?.()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}

interface CpuSample {
  cpuSeconds: number
  peakWorkingSetMb: number
}

/**
 * Total CPU time and working set of the aria2 process. Queried after the
 * download completes, while the RPC daemon is still alive, so PowerShell's
 * own startup cannot hide the sample on short runs.
 */
function queryProcessUsage(pid: number | undefined): Promise<CpuSample | null> {
  if (process.platform !== 'win32' || pid === undefined) {
    return Promise.resolve(null)
  }
  return new Promise((resolve) => {
    const child = spawn(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { Write-Output $p.CPU; Write-Output $p.WorkingSet64 }`
      ],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
    )
    let output = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    const timer = setTimeout(() => {
      child.kill()
      resolve(null)
    }, 10_000)
    child.once('exit', () => {
      clearTimeout(timer)
      const [cpu, workingSet] = output
        .trim()
        .split(/\r?\n/)
        .map((line) => Number(line.trim()))
      if (
        cpu === undefined ||
        workingSet === undefined ||
        !Number.isFinite(cpu) ||
        !Number.isFinite(workingSet)
      ) {
        resolve(null)
        return
      }
      resolve({ cpuSeconds: cpu, peakWorkingSetMb: workingSet / MB })
    })
  })
}

function withOverrides(
  base: string[],
  overrides: Record<string, string>
): string[] {
  const names = Object.keys(overrides)
  const kept = base.filter(
    (argument) => !names.some((name) => argument.startsWith(`--${name}=`))
  )
  return [
    ...kept,
    ...Object.entries(overrides).map(([name, value]) => `--${name}=${value}`)
  ]
}

interface Variant {
  name: string
  overrides: Record<string, string>
}

interface RunResult {
  ok: boolean
  error: string
  elapsedMs: number
  ttfbMs: number | null
  throughputMib: number
  cpuSeconds: number | null
  peakWorkingSetMb: number | null
  connections: number
  maxActive: number
  requests: number
  bytes: number
}

async function downloadOnce(
  binary: string,
  fixture: Fixture,
  fileBytes: number,
  variant: Variant,
  downloadDir: string,
  runIndex: number
): Promise<RunResult> {
  const out = `${variant.name.replace(/[^a-z0-9-]/gi, '_')}-${runIndex}.bin`
  const outputPath = path.join(downloadDir, out)
  await fs.rm(outputPath, { force: true })
  await fs.rm(`${outputPath}.aria2`, { force: true })
  fixture.stats.connections = 0
  fixture.stats.requests = 0
  fixture.stats.rangeRequests = 0
  fixture.stats.maxActive = 0

  const port = await findFreePort()
  const secret = `bench-${Date.now()}-${runIndex}`
  const args = withOverrides(
    buildAria2Args({ port, secret, downloadDir }),
    variant.overrides
  )
  let child: ChildProcess | null = null
  let stderr = ''
  const client = new Aria2Client(port, secret)

  try {
    child = spawn(binary, args, {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe']
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2000)
    })

    const readyDeadline = Date.now() + 15_000
    let ready = false
    while (Date.now() < readyDeadline) {
      try {
        await client.getVersion()
        ready = true
        break
      } catch {
        await delay(50)
      }
    }
    if (!ready) {
      throw new Error('aria2 RPC did not become ready.')
    }

    const startedAt = performance.now()
    const gid = await client.call<string>('aria2.addUri', [
      [fixture.url],
      { dir: downloadDir, out, 'max-tries': '1', 'retry-wait': '0' }
    ])

    let ttfbMs: number | null = null
    let status: ReturnType<typeof parseAria2Status> | null = null
    const deadline = performance.now() + 300_000
    while (performance.now() < deadline) {
      status = parseAria2Status(await client.call<unknown>('aria2.tellStatus', [gid]))
      if (ttfbMs === null && status.completedLength > 0) {
        ttfbMs = performance.now() - startedAt
      }
      if (status.status === 'complete' || status.status === 'error') break
      await delay(20)
    }
    const elapsedMs = performance.now() - startedAt

    if (status === null || status.status !== 'complete') {
      throw new Error(
        `aria2 did not complete: ${status?.status ?? 'no status'} ` +
          `${status?.errorCode ?? ''} ${status?.errorMessage ?? stderr}`
      )
    }

    const stat = await fs.stat(outputPath)
    if (stat.size !== fileBytes) {
      throw new Error(`Wrong output size: ${stat.size} !== ${fileBytes}`)
    }

    const sample = await queryProcessUsage(child.pid)

    return {
      ok: true,
      error: '',
      elapsedMs,
      ttfbMs,
      throughputMib: fileBytes / MB / (elapsedMs / 1000),
      cpuSeconds: sample?.cpuSeconds ?? null,
      peakWorkingSetMb: sample?.peakWorkingSetMb ?? null,
      connections: fixture.stats.connections,
      maxActive: fixture.stats.maxActive,
      requests: fixture.stats.requests,
      bytes: stat.size
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      elapsedMs: 0,
      ttfbMs: null,
      throughputMib: 0,
      cpuSeconds: null,
      peakWorkingSetMb: null,
      connections: fixture.stats.connections,
      maxActive: fixture.stats.maxActive,
      requests: fixture.stats.requests,
      bytes: 0
    }
  } finally {
    try {
      await client.call('aria2.shutdown')
    } catch {
      // aria2 may already be gone.
    }
    if (child) {
      if (child.exitCode === null) {
        await Promise.race([
          new Promise<void>((resolve) => child?.once('exit', () => resolve())),
          delay(2_000)
        ])
      }
      if (child.exitCode === null) child.kill()
    }
    await fs.rm(outputPath, { force: true }).catch(() => undefined)
    await fs.rm(`${outputPath}.aria2`, { force: true }).catch(() => undefined)
  }
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[middle] ?? null
  const left = sorted[middle - 1]
  const right = sorted[middle]
  return left === undefined || right === undefined ? null : (left + right) / 2
}

interface VariantSummary {
  name: string
  ok: boolean
  runs: number
  elapsedMs: number | null
  ttfbMs: number | null
  throughputMib: number | null
  cpuSeconds: number | null
  peakWorkingSetMb: number | null
  maxActive: number | null
  requests: number | null
}

function summarize(name: string, results: RunResult[]): VariantSummary {
  const ok = results.filter((result) => result.ok)
  return {
    name,
    ok: ok.length === results.length,
    runs: results.length,
    elapsedMs: median(ok.map((result) => result.elapsedMs)),
    ttfbMs: median(
      ok
        .map((result) => result.ttfbMs)
        .filter((value): value is number => value !== null)
    ),
    throughputMib: median(ok.map((result) => result.throughputMib)),
    cpuSeconds: median(
      ok
        .map((result) => result.cpuSeconds)
        .filter((value): value is number => value !== null)
    ),
    peakWorkingSetMb: median(
      ok
        .map((result) => result.peakWorkingSetMb)
        .filter((value): value is number => value !== null)
    ),
    maxActive: median(ok.map((result) => result.maxActive)),
    requests: median(ok.map((result) => result.requests))
  }
}

/**
 * Run every variant once per round, rotating the order each round so a cold
 * page-cache / writeback advantage is not permanently assigned to the first
 * variant in the list.
 */
async function runMatrix(
  binary: string,
  fixture: Fixture,
  fileBytes: number,
  variants: Variant[],
  downloadDir: string,
  rounds: number
): Promise<VariantSummary[]> {
  const results = new Map<string, RunResult[]>(
    variants.map((variant) => [variant.name, []])
  )
  for (let round = 0; round < rounds; round += 1) {
    const offset = (round * 3) % variants.length
    const order = [...variants.slice(offset), ...variants.slice(0, offset)]
    for (const variant of order) {
      const result = await downloadOnce(
        binary,
        fixture,
        fileBytes,
        variant,
        downloadDir,
        round
      )
      results.get(variant.name)?.push(result)
      if (!result.ok) {
        console.error(`  FAIL ${variant.name} round ${round}: ${result.error}`)
      }
    }
  }
  return variants.map((variant) =>
    summarize(variant.name, results.get(variant.name) ?? [])
  )
}

function printSummary(title: string, rows: VariantSummary[]): void {
  console.log(`\n### ${title}`)
  console.log(
    'variant'.padEnd(22) +
      'ok'.padEnd(5) +
      'MiB/s'.padEnd(10) +
      'elapsed'.padEnd(12) +
      'TTFB'.padEnd(10) +
      'aria2 CPU'.padEnd(12) +
      'peak RAM'.padEnd(11) +
      'maxActive'
  )
  for (const row of rows) {
    console.log(
      row.name.padEnd(22) +
        String(row.ok).padEnd(5) +
        (row.throughputMib?.toFixed(1) ?? 'n/a').padEnd(10) +
        (row.elapsedMs === null ? 'n/a' : `${row.elapsedMs.toFixed(0)}ms`).padEnd(12) +
        (row.ttfbMs === null ? 'n/a' : `${row.ttfbMs.toFixed(0)}ms`).padEnd(10) +
        (row.cpuSeconds === null ? 'n/a' : `${row.cpuSeconds.toFixed(2)}s`).padEnd(12) +
        (row.peakWorkingSetMb === null
          ? 'n/a'
          : `${row.peakWorkingSetMb.toFixed(1)}MiB`).padEnd(11) +
        String(row.maxActive ?? 'n/a')
    )
  }
}

function selectVariants(variants: Variant[]): Variant[] {
  if (variantFilter === null) return variants
  return variants.filter((variant) => variantFilter.includes(variant.name))
}

function fastVariants(): Variant[] {
  return [
    { name: 'baseline', overrides: {} },
    { name: 'falloc', overrides: { 'file-allocation': 'falloc' } },
    { name: 'prealloc', overrides: { 'file-allocation': 'prealloc' } },
    {
      name: 'inorder',
      overrides: { 'stream-piece-selector': 'inorder' }
    },
    {
      name: 'inorder+dc0',
      overrides: { 'stream-piece-selector': 'inorder', 'disk-cache': '0' }
    },
    {
      name: 'inorder+dc32',
      overrides: { 'stream-piece-selector': 'inorder', 'disk-cache': '32M' }
    },
    {
      name: 'dc32+falloc',
      overrides: { 'file-allocation': 'falloc', 'disk-cache': '32M' }
    },
    {
      name: 'dc64+falloc',
      overrides: { 'file-allocation': 'falloc', 'disk-cache': '64M' }
    },
    {
      name: 'minsplit4m+falloc',
      overrides: { 'file-allocation': 'falloc', 'min-split-size': '4M' }
    },
    {
      name: 'minsplit20m+falloc',
      overrides: { 'file-allocation': 'falloc', 'min-split-size': '20M' }
    },
    {
      name: 'pipelining+falloc',
      overrides: {
        'file-allocation': 'falloc',
        'enable-http-pipelining': 'true'
      }
    },
    {
      name: 'inorder+falloc',
      overrides: {
        'file-allocation': 'falloc',
        'stream-piece-selector': 'inorder'
      }
    },
    {
      name: 'optimize-off+falloc',
      overrides: {
        'file-allocation': 'falloc',
        'optimize-concurrent-downloads': 'false'
      }
    },
    {
      name: 'piece4m+falloc',
      overrides: { 'file-allocation': 'falloc', 'piece-length': '4M' }
    }
  ]
}

function throttledVariants(): Variant[] {
  return [
    { name: 'baseline', overrides: {} },
    { name: 'inorder', overrides: { 'stream-piece-selector': 'inorder' } },
    {
      name: 'inorder+dc0',
      overrides: { 'stream-piece-selector': 'inorder', 'disk-cache': '0' }
    },
    { name: 'falloc', overrides: { 'file-allocation': 'falloc' } },
    {
      name: 'dc64+falloc',
      overrides: { 'file-allocation': 'falloc', 'disk-cache': '64M' }
    },
    {
      name: 'minsplit4m+falloc',
      overrides: { 'file-allocation': 'falloc', 'min-split-size': '4M' }
    },
    {
      name: 'minsplit20m+falloc',
      overrides: { 'file-allocation': 'falloc', 'min-split-size': '20M' }
    },
    {
      name: 'split8+falloc',
      overrides: {
        'file-allocation': 'falloc',
        split: '8',
        'max-connection-per-server': '8'
      }
    }
  ]
}

const tempDirs: string[] = []

afterAll(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
})

describe.skipIf(scenario === 'media')('aria2 loopback throughput benchmark', () => {
  it(
    'measures the launch profile and candidate overrides',
    async () => {
      const binary = aria2Binary()
      const downloadDir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'dondownload-bench-throughput-')
      )
      tempDirs.push(downloadDir)
      const version = spawn(binary, ['--version'], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore']
      })
      let versionText = ''
      version.stdout?.on('data', (chunk: Buffer) => {
        versionText += chunk.toString()
      })
      await new Promise<void>((resolve) => version.once('exit', () => resolve()))
      console.log(
        `${versionText.split(/\r?\n/)[0] ?? 'aria2'} | binary: ${binary}`
      )

      if (scenario === 'all' || scenario === 'fast') {
        const fixture = await startFixture({
          fileBytes: largeFileBytes,
          perSocketBytesPerSecond: 0
        })
        try {
          console.log(
            `\nfast loopback: ${largeFileBytes / MB}MiB file, unlimited, ` +
              `${runsPerVariant} run(s) per variant`
          )
          const rows = await runMatrix(
            binary,
            fixture,
            largeFileBytes,
            selectVariants(fastVariants()),
            downloadDir,
            runsPerVariant
          )
          printSummary('fast loopback (no per-socket cap)', rows)
          expect(rows.length).toBeGreaterThan(0)
          expect(rows.every((row) => row.ok)).toBe(true)
        } finally {
          await fixture.close()
        }
      }

      if (scenario === 'all' || scenario === 'throttled') {
        const rate = 8 * MB
        const fixture = await startFixture({
          fileBytes: throttledFileBytes,
          perSocketBytesPerSecond: rate
        })
        try {
          console.log(
            `\nslow-server loopback: ${throttledFileBytes / MB}MiB file, ` +
              `8MiB/s per socket, ${runsPerVariant} run(s) per variant`
          )
          const rows = await runMatrix(
            binary,
            fixture,
            throttledFileBytes,
            selectVariants(throttledVariants()),
            downloadDir,
            runsPerVariant
          )
          printSummary('slow-server loopback (8MiB/s per socket)', rows)
          expect(rows.length).toBeGreaterThan(0)
          expect(rows.every((row) => row.ok)).toBe(true)
        } finally {
          await fixture.close()
        }
      }
    },
    15 * 60_000
  )
})
