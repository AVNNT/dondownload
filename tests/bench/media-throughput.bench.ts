/**
 * Local yt-dlp HLS fragment-concurrency benchmark.
 *
 * Generates a 100-fragment HLS stream with FFmpeg once, serves it from a
 * loopback HTTP server that adds a fixed delay to every request (simulating a
 * remote segment CDN), and downloads it through the production argument
 * builder with different `--concurrent-fragments` values.
 *
 * This is a benchmark, not a correctness test: it only runs with
 * `BENCH_SCENARIO=media` and is excluded from `npm test` / `test:fast`.
 *
 * Run:
 *   $env:BENCH_SCENARIO = 'media'; npm run bench:throughput
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { createServer } from 'node:http'
import { type Socket } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { buildDownloadArgs, parseProgressLine } from '../../src/main/media/args'

const scenario = process.env.BENCH_SCENARIO ?? 'all'
const rounds = Math.max(1, Number(process.env.BENCH_RUNS ?? '3'))
const requestLatencyMs = Math.max(0, Number(process.env.BENCH_HLS_LATENCY_MS ?? '80'))
const fragmentCount = Math.max(10, Number(process.env.BENCH_HLS_FRAGMENTS ?? '100'))
const fragmentSeconds = 1
const concurrentValues = (process.env.BENCH_HLS_CONCURRENCY ?? '1,4,8,12')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isSafeInteger(value) && value > 0)

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function resolveTool(
  envName: string,
  binary: string
): string {
  const override = process.env[envName]?.trim()
  if (override) return path.resolve(override)
  const where = spawnSync(process.platform === 'win32' ? 'where' : 'which', [
    binary
  ])
  if (where.status === 0) {
    const first = where.stdout
      .toString()
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0)
    if (first) return first
  }
  throw new Error(`${binary} was not found; set ${envName}.`)
}

interface StaticFixture {
  url: string
  close: () => Promise<void>
}

async function startStaticFixture(
  root: string,
  latencyMs: number
): Promise<StaticFixture> {
  const sockets = new Set<Socket>()
  const server = createServer((request, response) => {
    response.on('error', () => undefined)
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    const file = path.join(root, pathname.replace(/^\/+/, ''))
    if (!file.startsWith(root)) {
      response.writeHead(403)
      response.end()
      return
    }
    void (async () => {
      if (latencyMs > 0) await delay(latencyMs)
      const body = await fs.readFile(file).catch(() => null)
      if (body === null) {
        response.writeHead(404)
        response.end()
        return
      }
      response.writeHead(200, {
        'content-type': pathname.endsWith('.m3u8')
          ? 'application/vnd.apple.mpegurl'
          : 'video/mp2t',
        'content-length': body.length
      })
      if (request.method === 'HEAD') {
        response.end()
        return
      }
      response.end(body)
    })().catch(() => {
      if (!response.destroyed) response.destroy()
    })
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (typeof address !== 'object' || address === null) {
    throw new Error('Static benchmark server did not start.')
  }
  return {
    url: `http://127.0.0.1:${address.port}/index.m3u8`,
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

/** Samples yt-dlp's CPU/RAM while it runs; the process exits on completion. */
function startCpuSampler(pid: number | undefined): { stop: () => CpuSample | null } {
  if (process.platform !== 'win32' || pid === undefined) {
    return { stop: () => null }
  }
  const child = spawn(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; while ($p -and -not $p.HasExited) { Write-Output ("{0},{1}" -f $p.CPU, $p.WorkingSet64); Start-Sleep -Milliseconds 50; $p.Refresh() }`
    ],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
  )
  const samples: CpuSample[] = []
  let buffer = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString()
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const [cpu, workingSet] = line.split(',').map(Number)
      if (
        cpu !== undefined &&
        workingSet !== undefined &&
        Number.isFinite(cpu) &&
        Number.isFinite(workingSet)
      ) {
        samples.push({ cpuSeconds: cpu, peakWorkingSetMb: workingSet / 1024 / 1024 })
      }
    }
  })
  return {
    stop: () => {
      try {
        child.kill()
      } catch {
        // Best effort.
      }
      if (samples.length === 0) return null
      return {
        cpuSeconds: Math.max(...samples.map((sample) => sample.cpuSeconds)),
        peakWorkingSetMb: Math.max(
          ...samples.map((sample) => sample.peakWorkingSetMb)
        )
      }
    }
  }
}

function withConcurrency(args: string[], value: number): string[] {
  const index = args.indexOf('--concurrent-fragments')
  if (index < 0) return args
  return [
    ...args.slice(0, index),
    '--concurrent-fragments',
    String(value),
    ...args.slice(index + 2)
  ]
}

async function runDownload(input: {
  ytdlp: string
  ffmpeg: string
  url: string
  outputDir: string
  concurrency: number
}): Promise<{
  ok: boolean
  error: string
  elapsedMs: number
  downloadMs: number | null
  cpuSeconds: number | null
  peakWorkingSetMb: number | null
}> {
  const outputTemplate = path.join(input.outputDir, `out-%(id)s.%(ext)s`)
  const base = buildDownloadArgs({
    sourceUrl: input.url,
    formatSelector: 'best',
    outputTemplate,
    mergeOutputFormat: null,
    remuxOutputFormat: null,
    ffmpegLocation: null
  })
  const args = withConcurrency(base, input.concurrency)
  // The production builder only passes --ffmpeg-location for merge/remux; the
  // native HLS downloader still needs FFmpeg to stitch fragments.
  args.splice(args.length - 2, 0, '--ffmpeg-location', input.ffmpeg)
  args.splice(args.length - 2, 0, '--paths', `home:${input.outputDir}`)

  const state: { child: ChildProcess | null } = { child: null }
  const sampler = { current: null as ReturnType<typeof startCpuSampler> | null }
  let firstProgressAt: number | null = null
  let lastProgressAt: number | null = null
  try {
    const startedAt = performance.now()
    const result = await new Promise<{ code: number | null; stderr: string }>(
      (resolve) => {
        state.child = spawn(input.ytdlp, args, {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe']
        })
        sampler.current = startCpuSampler(state.child.pid)
        let stderr = ''
        let stdoutRemainder = ''
        state.child.stdout?.on('data', (chunk: Buffer) => {
          stdoutRemainder += chunk.toString()
          const lines = stdoutRemainder.split(/\r?\n/)
          stdoutRemainder = lines.pop() ?? ''
          for (const line of lines) {
            if (parseProgressLine(line) === null) continue
            const now = performance.now()
            if (firstProgressAt === null) firstProgressAt = now
            lastProgressAt = now
          }
        })
        state.child.stderr?.on('data', (chunk: Buffer) => {
          stderr = (stderr + chunk.toString()).slice(-2000)
        })
        state.child.once('error', (error) => {
          resolve({ code: -1, stderr: String(error) })
        })
        state.child.once('exit', (code) => resolve({ code, stderr }))
      }
    )
    const elapsedMs = performance.now() - startedAt
    const downloadMs =
      firstProgressAt !== null && lastProgressAt !== null
        ? lastProgressAt - firstProgressAt
        : null
    const sample = sampler.current?.stop() ?? null

    const files = await fs.readdir(input.outputDir).catch(() => [] as string[])
    const produced = files.some(
      (file) =>
        !file.endsWith('.part') &&
        !file.endsWith('.m3u8') &&
        !file.endsWith('.ytdl') &&
        !/Frag|temp/i.test(file)
    )
    if (result.code !== 0 || !produced) {
      return {
        ok: false,
        error: result.stderr || `exit ${result.code}; produced=${produced}`,
        elapsedMs,
        downloadMs,
        cpuSeconds: sample?.cpuSeconds ?? null,
        peakWorkingSetMb: sample?.peakWorkingSetMb ?? null
      }
    }
    return {
      ok: true,
      error: '',
      elapsedMs,
      downloadMs,
      cpuSeconds: sample?.cpuSeconds ?? null,
      peakWorkingSetMb: sample?.peakWorkingSetMb ?? null
    }
  } finally {
    if (state.child && state.child.exitCode === null) state.child.kill()
    for (const file of await fs.readdir(input.outputDir).catch(() => [] as string[])) {
      await fs.rm(path.join(input.outputDir, file), {
        recursive: true,
        force: true
      })
    }
  }
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)] ?? null
}

const tempDirs: string[] = []

afterAll(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
})

describe.skipIf(scenario !== 'media')('yt-dlp HLS fragment concurrency', () => {
  it(
    'measures --concurrent-fragments against a latency-bound segment server',
    async () => {
      const ytdlp = resolveTool('YTDLP_BENCH_BINARY', 'yt-dlp.exe')
      const ffmpeg = resolveTool('FFMPEG_BENCH_BINARY', 'ffmpeg.exe')
      const root = await fs.mkdtemp(
        path.join(os.tmpdir(), 'dondownload-bench-media-')
      )
      tempDirs.push(root)
      const hlsDir = path.join(root, 'hls')
      const outDir = path.join(root, 'out')
      await fs.mkdir(hlsDir)
      await fs.mkdir(outDir)

      console.log(
        `yt-dlp: ${ytdlp}\nffmpeg: ${ffmpeg}\n` +
          `generating ${fragmentCount} HLS fragments...`
      )
      const generated = spawnSync(
        ffmpeg,
        [
          '-y',
          '-hide_banner',
          '-loglevel',
          'error',
          '-f',
          'lavfi',
          '-i',
          'testsrc2=size=160x120:rate=10',
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=1000:sample_rate=44100',
          '-t',
          String(fragmentCount * fragmentSeconds),
          '-c:v',
          'libx264',
          '-preset',
          'ultrafast',
          '-pix_fmt',
          'yuv420p',
          '-g',
          '10',
          '-c:a',
          'aac',
          '-b:a',
          '48k',
          '-f',
          'hls',
          '-hls_time',
          String(fragmentSeconds),
          '-hls_list_size',
          '0',
          '-hls_segment_filename',
          path.join(hlsDir, 'seg%03d.ts'),
          path.join(hlsDir, 'index.m3u8')
        ],
        { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }
      )
      if (generated.status !== 0) {
        throw new Error(
          `ffmpeg HLS generation failed: ${generated.stderr?.toString() ?? ''}`
        )
      }
      const playlist = await fs.readFile(path.join(hlsDir, 'index.m3u8'), 'utf8')
      const segments = playlist
        .split(/\r?\n/)
        .filter((line) => line.endsWith('.ts')).length
      console.log(
        `playlist has ${segments} segments; ` +
          `${requestLatencyMs}ms per HTTP request; ${rounds} round(s)`
      )

      const fixture = await startStaticFixture(hlsDir, requestLatencyMs)
      const results = new Map<number, number[]>()
      const download = new Map<number, number[]>()
      const cpu = new Map<number, number[]>()
      try {
        for (let round = 0; round < rounds; round += 1) {
          const order = [...concurrentValues]
          if (round % 2 === 1) order.reverse()
          for (const concurrency of order) {
            const result = await runDownload({
              ytdlp,
              ffmpeg,
              url: fixture.url,
              outputDir: outDir,
              concurrency
            })
            if (!result.ok) {
              console.error(
                `  FAIL -N ${concurrency} round ${round}: ${result.error}`
              )
              continue
            }
            results.set(concurrency, [
              ...(results.get(concurrency) ?? []),
              result.elapsedMs
            ])
            if (result.downloadMs !== null) {
              download.set(concurrency, [
                ...(download.get(concurrency) ?? []),
                result.downloadMs
              ])
            }
            if (result.cpuSeconds !== null) {
              cpu.set(concurrency, [
                ...(cpu.get(concurrency) ?? []),
                result.cpuSeconds
              ])
            }
          }
        }
      } finally {
        await fixture.close()
      }

      console.log(
        `\n### HLS fragment concurrency (${requestLatencyMs}ms-class request latency)`
      )
      console.log(
        'fragments'.padEnd(12) +
          'ok'.padEnd(5) +
          'download'.padEnd(12) +
          'speedup'.padEnd(10) +
          'total'.padEnd(10) +
          'yt-dlp CPU'
      )
      const baseline = median(download.get(concurrentValues[0] ?? 1) ?? [])
      for (const concurrency of concurrentValues) {
        const downloadMs = median(download.get(concurrency) ?? [])
        const elapsed = median(results.get(concurrency) ?? [])
        const cpuSeconds = median(cpu.get(concurrency) ?? [])
        console.log(
          String(concurrency).padEnd(12) +
            String((results.get(concurrency)?.length ?? 0) > 0).padEnd(5) +
            (downloadMs === null ? 'n/a' : `${downloadMs.toFixed(0)}ms`).padEnd(12) +
            (baseline !== null && downloadMs !== null
              ? `${(baseline / downloadMs).toFixed(2)}x`.padEnd(10)
              : 'n/a'.padEnd(10)) +
            (elapsed === null ? 'n/a' : `${elapsed.toFixed(0)}ms`).padEnd(10) +
            (cpuSeconds === null ? 'n/a' : `${cpuSeconds.toFixed(2)}s`)
        )
      }

      expect(
        concurrentValues.some(
          (concurrency) => (results.get(concurrency)?.length ?? 0) > 0
        )
      ).toBe(true)
    },
    15 * 60_000
  )
})
