#!/usr/bin/env node
/**
 * Local download-performance benchmark for DonDownload's aria2 launch profile.
 *
 * It serves deterministic payloads from loopback-only HTTP fixtures that honour
 * Range requests and cap each TCP connection at a configurable rate. No public
 * URL, user download folder or user data is touched: every file lives in a
 * fresh OS temp directory and is removed before exit.
 *
 * The script compares the previous hard-coded `--split=8` ceiling with the
 * maximum configurable per-host connection value (16). Actual connections still
 * remain bounded by `--max-connection-per-server`, which defaults to 4 and is
 * also enforced at runtime by the persisted settings.
 *
 * Usage:
 *   node scripts/aria2-benchmark.mjs
 *   node scripts/aria2-benchmark.mjs --runs=3 --only=large-128MiB-16conn
 *   $env:ARIA2_BENCHMARK_BINARY = 'C:\tools\aria2c.exe'; node scripts/aria2-benchmark.mjs
 */

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'

const MB = 1024 * 1024
const SPLITS = [8, 16]
const DEFAULT_RUNS = 2

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function parseArgs(argv) {
  const options = { runs: DEFAULT_RUNS, only: null }
  for (const entry of argv) {
    if (entry.startsWith('--runs=')) {
      const value = Number(entry.slice('--runs='.length))
      if (Number.isSafeInteger(value) && value > 0) options.runs = value
    } else if (entry.startsWith('--only=')) {
      options.only = entry.slice('--only='.length).split(',').filter(Boolean)
    } else if (entry === '--help' || entry === '-h') {
      options.help = true
    }
  }
  return options
}

function resolveBinary() {
  const override =
    process.env.ARIA2_BENCHMARK_BINARY || process.env.DONDOWNLOAD_ARIA2_PATH
  if (override) {
    return path.resolve(override)
  }

  const repo = path.resolve(import.meta.dirname, '..')
  const vendor = path.join(repo, 'vendor', 'aria2', 'aria2c.exe')
  try {
    if (spawnSync(vendor, ['--version']).status === 0) return vendor
  } catch {
    // Fall through to PATH.
  }

  const found = spawnSync(process.platform === 'win32' ? 'where' : 'which', [
    process.platform === 'win32' ? 'aria2c.exe' : 'aria2c'
  ])
  if (found.status === 0) {
    const first = found.stdout.toString().split(/\r?\n/).find(Boolean)
    if (first) return first.trim()
  }

  throw new Error(
    'aria2c was not found. Set ARIA2_BENCHMARK_BINARY or DONDOWNLOAD_ARIA2_PATH.'
  )
}

function buildPayload(size, seed) {
  const payload = Buffer.allocUnsafe(size)
  for (let index = 0; index < size; index += 1) {
    payload[index] = (index * 31 + seed) & 0xff
  }
  return payload
}

function hash(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function parseRange(header, totalLength) {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return 'invalid'
  const rawStart = match[1] ?? ''
  const rawEnd = match[2] ?? ''
  if (rawStart === '' && rawEnd === '') return 'invalid'

  let start
  let end
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

function createSocketThrottle() {
  const states = new WeakMap()
  return async function take(socket, bytes, bytesPerSecond) {
    if (!bytesPerSecond) return
    let state = states.get(socket)
    if (!state) {
      state = { allowedAt: Date.now(), chain: Promise.resolve() }
      states.set(socket, state)
    }
    const run = state.chain.then(async () => {
      const now = Date.now()
      if (state.allowedAt < now) state.allowedAt = now
      const readyAt = state.allowedAt
      const wait = readyAt - Date.now()
      if (wait > 0) await delay(wait)
      state.allowedAt = readyAt + (bytes / bytesPerSecond) * 1000
    })
    state.chain = run.catch(() => undefined)
    await run
  }
}

async function startFixture(payload, host, options) {
  const throttle = createSocketThrottle()
  const stats = {
    connections: 0,
    requests: 0,
    rangeRequests: 0,
    rangedStarts: [],
    bytesServed: 0,
    active: 0,
    maxActive: 0
  }
  const sockets = new Set()

  const server = createServer((request, response) => {
    response.on('error', () => undefined)
    stats.requests += 1

    const range = parseRange(request.headers.range, payload.length)
    if (range === 'invalid') {
      response.writeHead(416, {
        'content-range': `bytes */${payload.length}`
      })
      response.end()
      return
    }
    if (range) {
      stats.rangeRequests += 1
      stats.rangedStarts.push(range.start)
    }

    const start = range?.start ?? 0
    const end = range?.end ?? payload.length - 1
    const headers = {
      'content-type': 'application/octet-stream',
      'content-length': end - start + 1,
      'accept-ranges': 'bytes',
      'content-disposition': `attachment; filename="bench.bin"`
    }
    if (range) {
      headers['content-range'] = `bytes ${start}-${end}/${payload.length}`
    }

    void (async () => {
      if (options.requestLatencyMs > 0) await delay(options.requestLatencyMs)
      if (response.destroyed || response.writableEnded) return
      response.writeHead(range ? 206 : 200, headers)
      if (request.method === 'HEAD') {
        response.end()
        return
      }

      const slice = payload.subarray(start, end + 1)
      stats.active += 1
      stats.maxActive = Math.max(stats.maxActive, stats.active)
      let finished = false
      const finish = () => {
        if (finished) return
        finished = true
        stats.active -= 1
      }
      response.once('close', finish)
      response.once('finish', finish)

      const chunkSize = 2 * MB
      for (let offset = 0; offset < slice.length; offset += chunkSize) {
        if (response.destroyed || response.writableEnded) return
        const chunk = slice.subarray(
          offset,
          Math.min(offset + chunkSize, slice.length)
        )
        await throttle(
          response.socket,
          chunk.length,
          options.perSocketBytesPerSecond
        )
        if (!response.write(chunk)) {
          await new Promise((resolve) => {
            const done = () => {
              response.removeListener('drain', done)
              response.removeListener('close', done)
              response.removeListener('error', done)
              resolve()
            }
            response.once('drain', done)
            response.once('close', done)
            response.once('error', done)
          })
        }
        stats.bytesServed += chunk.length
      }
      if (!response.destroyed && !response.writableEnded) response.end()
    })().catch(() => {
      if (!response.destroyed) response.destroy()
    })
  })

  server.on('connection', (socket) => {
    stats.connections += 1
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, resolve)
  })
  const port = server.address().port

  return {
    url: `http://${host}:${port}/bench.bin`,
    stats,
    reset() {
      stats.connections = 0
      stats.requests = 0
      stats.rangeRequests = 0
      stats.rangedStarts = []
      stats.bytesServed = 0
      stats.maxActive = 0
    },
    async close() {
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(resolve))
    }
  }
}

function startSampler(pid) {
  if (process.platform !== 'win32') return { stop: async () => null }
  const child = spawn(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; while ($p -and -not $p.HasExited) { Write-Output ("{0},{1}" -f $p.CPU, $p.WorkingSet64); Start-Sleep -Milliseconds 200; $p.Refresh() }`
    ],
    { windowsHide: true }
  )
  const samples = []
  let buffer = ''
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString()
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const [cpu, workingSet] = line.split(',').map(Number)
      if (Number.isFinite(cpu) && Number.isFinite(workingSet)) {
        samples.push({ cpu, workingSet })
      }
    }
  })
  return {
    stop: async () => {
      try {
        child.kill()
      } catch {
        // Sampler is best effort.
      }
      if (samples.length === 0) return null
      return {
        cpuSeconds: samples.at(-1).cpu,
        peakWorkingSetMb: Math.max(...samples.map((s) => s.workingSet)) / MB
      }
    }
  }
}

function baseArguments(root, split, maxConnections) {
  return [
    '--no-conf=true',
    `--dir=${root}`,
    '--continue=true',
    '--max-concurrent-downloads=3',
    `--max-connection-per-server=${maxConnections}`,
    '--max-overall-download-limit=0',
    `--split=${split}`,
    '--min-split-size=1M',
    '--file-allocation=none',
    '--allow-overwrite=false',
    '--auto-file-renaming=true',
    '--check-certificate=true',
    '--max-tries=3',
    '--retry-wait=2',
    '--connect-timeout=15',
    '--timeout=60',
    '--summary-interval=0',
    '--console-log-level=warn',
    '--download-result=hide',
    '--user-agent=DonDownload/1.0.0'
  ]
}

function writeInputFile(root, entries) {
  const lines = []
  for (const entry of entries) {
    lines.push(entry.url, `  out=${entry.out}`, `  dir=${root}`, '')
  }
  return fs.writeFile(path.join(root, 'input.txt'), lines.join('\n'), 'utf8')
}

async function runScenario(binary, name, config, split, runIndex) {
  const root = config.root
  const fixtures = config.fixtures
  const entries = []
  for (let index = 0; index < config.entries.length; index += 1) {
    const entry = config.entries[index]
    entries.push({
      url: fixtures[entry.fixture].url,
      out: `${name}-${split}-${runIndex}-${index}.bin`
    })
  }
  await writeInputFile(root, entries)

  for (const fixture of fixtures) fixture.reset()
  const args = [
    ...baseArguments(root, split, config.maxConnections),
    `--input-file=${path.join(root, 'input.txt')}`
  ]
  const childStarted = process.hrtime.bigint()
  const result = await new Promise((resolve) => {
    const child = spawn(binary, args, {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe']
    })
    const sampler = startSampler(child.pid)
    let stderr = ''
    let settled = false
    const finish = async (code) => {
      if (settled) return
      settled = true
      const elapsedMs = Number(process.hrtime.bigint() - childStarted) / 1e6
      const sample = await sampler.stop()
      resolve({ code, elapsedMs, stderr, sample })
    }
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.once('error', (error) => {
      stderr += String(error)
      void finish(-1)
    })
    child.once('exit', (code) => {
      void finish(code)
    })
    const timer = setTimeout(() => {
      child.kill()
      void finish(-2)
    }, 120_000)
    timer.unref?.()
  })

  let bytes = 0
  let ok = result.code === 0
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    const file = path.join(root, entry.out)
    const stat = await fs.stat(file).catch(() => null)
    const expected = config.expectedHashes[index]
    if (!stat || stat.size !== config.expectedSizes[index]) ok = false
    else {
      const digest = hash(await fs.readFile(file))
      if (digest !== expected) ok = false
      bytes += stat.size
    }
    await fs.rm(file, { force: true })
    await fs.rm(`${file}.aria2`, { force: true })
  }

  const connections = fixtures.reduce(
    (sum, fixture) => sum + fixture.stats.connections,
    0
  )
  const maxActive = Math.max(...fixtures.map((fixture) => fixture.stats.maxActive))
  return {
    ok,
    elapsedMs: result.elapsedMs,
    throughputMbps: bytes / MB / (result.elapsedMs / 1000),
    bytes,
    connections,
    maxActive,
    requests: fixtures.reduce((sum, fixture) => sum + fixture.stats.requests, 0),
    rangeRequests: fixtures.reduce(
      (sum, fixture) => sum + fixture.stats.rangeRequests,
      0
    ),
    cpuSeconds: result.sample?.cpuSeconds ?? null,
    peakWorkingSetMb: result.sample?.peakWorkingSetMb ?? null,
    stderr: result.stderr
  }
}

function median(values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)]
}

async function benchmarkScenario(binary, name, config, split, runs) {
  const results = []
  for (let run = 0; run < runs; run += 1) {
    const result = await runScenario(binary, name, config, split, run)
    if (!result.ok) {
      console.error(
        `FAIL ${name} split=${split} run=${run}: code/stderr=${result.stderr.slice(-400)}`
      )
    }
    results.push(result)
  }
  const okResults = results.filter((result) => result.ok)
  return {
    split,
    ok: okResults.length === results.length,
    runs: results.length,
    elapsedMs: median(okResults.map((result) => result.elapsedMs)),
    throughputMbps: median(okResults.map((result) => result.throughputMbps)),
    connections: median(okResults.map((result) => result.connections)),
    maxActive: median(okResults.map((result) => result.maxActive)),
    requests: median(okResults.map((result) => result.requests)),
    rangeRequests: median(okResults.map((result) => result.rangeRequests)),
    cpuSeconds: median(
      okResults.filter((result) => result.cpuSeconds !== null).map((r) => r.cpuSeconds)
    ),
    peakWorkingSetMb: median(
      okResults
        .filter((result) => result.peakWorkingSetMb !== null)
        .map((r) => r.peakWorkingSetMb)
    )
  }
}

async function rpc(port, secret, method, params = []) {
  const response = await fetch(`http://127.0.0.1:${port}/jsonrpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'bench',
      method,
      params: [`token:${secret}`, ...params]
    })
  })
  const payload = await response.json()
  if (payload.error) throw new Error(payload.error.message)
  return payload.result
}

async function startDaemon(binary, root, split, maxConnections) {
  const net = await import('node:net')
  const port = await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const value = server.address().port
      server.close(() => resolve(value))
    })
  })
  const secret = `bench-${split}-${Date.now()}`
  const child = spawn(
    binary,
    [
      ...baseArguments(root, split, maxConnections),
      '--enable-rpc=true',
      '--rpc-listen-all=false',
      `--rpc-listen-port=${port}`,
      `--rpc-secret=${secret}`,
      '--rpc-allow-origin-all=false'
    ],
    { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }
  )
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    try {
      await rpc(port, secret, 'aria2.getVersion')
      return { child, port, secret }
    } catch {
      await delay(100)
    }
  }
  child.kill()
  throw new Error('aria2 RPC did not become ready.')
}

async function waitForStatus(port, secret, gid, predicate, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await rpc(port, secret, 'aria2.tellStatus', [gid])
    if (predicate(last)) return last
    await delay(100)
  }
  throw new Error(`Timed out waiting for status: ${JSON.stringify(last)}`)
}

async function runResume(
  binary,
  fixture,
  payload,
  root,
  firstSplit,
  secondSplit,
  maxConnections
) {
  const filename = `resume-${firstSplit}-${secondSplit}.bin`
  const file = path.join(root, filename)
  await fs.rm(file, { force: true })
  await fs.rm(`${file}.aria2`, { force: true })
  fixture.reset()

  const first = await startDaemon(binary, root, firstSplit, maxConnections)
  try {
    const gid = await rpc(first.port, first.secret, 'aria2.addUri', [
      [fixture.url],
      { dir: root, out: filename, continue: 'true' }
    ])
    await waitForStatus(
      first.port,
      first.secret,
      gid,
      (status) =>
        status.status === 'active' &&
        Number(status.completedLength) > 4 * MB &&
        Number(status.completedLength) < payload.length,
      60_000
    )
    await rpc(first.port, first.secret, 'aria2.pause', [gid])
    const paused = await waitForStatus(
      first.port,
      first.secret,
      gid,
      (status) => status.status === 'paused',
      15_000
    )
    await delay(400)
    const partialSize = (await fs.stat(file).catch(() => ({ size: 0 }))).size
    const controlFile = await fs
      .stat(`${file}.aria2`)
      .then(() => true)
      .catch(() => false)
    await rpc(first.port, first.secret, 'aria2.shutdown').catch(() => undefined)
    await new Promise((resolve) => {
      if (first.child.exitCode !== null) resolve()
      else first.child.once('exit', resolve)
    })
    if (paused.completedLength === 0) throw new Error('Resume made no progress.')

    const firstBytes = fixture.stats.bytesServed
    fixture.reset()
    const second = await startDaemon(binary, root, secondSplit, maxConnections)
    try {
      const gid2 = await rpc(second.port, second.secret, 'aria2.addUri', [
        [fixture.url],
        { dir: root, out: filename, continue: 'true' }
      ])
      const completed = await waitForStatus(
        second.port,
        second.secret,
        gid2,
        (status) =>
          status.status === 'complete' || status.status === 'error',
        120_000
      )
      const secondBytes = fixture.stats.bytesServed
      const secondRanges = [...fixture.stats.rangedStarts]
      const downloaded = await fs.readFile(file)
      return {
        firstSplit,
        secondSplit,
        ok:
          completed.status === 'complete' &&
          downloaded.length === payload.length &&
          hash(downloaded) === hash(payload),
        partialBytes: paused.completedLength,
        partialFileSize: partialSize,
        controlFile,
        firstRunBytes: firstBytes,
        resumeBytes: secondBytes,
        resumeRangesWithOffset: secondRanges.filter((start) => start > 0).length,
        rangeRequests: secondRanges.length
      }
    } finally {
      await rpc(second.port, second.secret, 'aria2.shutdown').catch(() => undefined)
      await new Promise((resolve) => {
        if (second.child.exitCode !== null) resolve()
        else second.child.once('exit', resolve)
      })
    }
  } finally {
    await fs.rm(file, { force: true })
    await fs.rm(`${file}.aria2`, { force: true })
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(
      'Usage: node scripts/aria2-benchmark.mjs [--runs=N] [--only=scenario,...]'
    )
    return
  }

  const binary = resolveBinary()
  const version = spawnSync(binary, ['--version']).stdout.toString()
  console.log(version.split(/\r?\n/)[0])
  console.log(`binary: ${binary}`)

  const payloads = new Map()
  for (const sizeMb of [0.5, 32, 64, 128]) {
    payloads.set(sizeMb, buildPayload(Math.round(sizeMb * MB), sizeMb * 17))
  }

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dondownload-bench-'))
  const scenarios = []
  const hosts = ['127.0.0.1', '127.0.0.2', '127.0.0.3']

  async function addScenario(config) {
    const fixtures = []
    const entries = []
    const expectedHashes = []
    const expectedSizes = []
    for (const [index, origin] of config.origins.entries()) {
      const payload = payloads.get(origin.sizeMb)
      const fixture = await startFixture(payload, hosts[index], {
        perSocketBytesPerSecond: origin.perSocketBytesPerSecond,
        requestLatencyMs: config.requestLatencyMs ?? 10
      })
      fixtures.push(fixture)
      for (let copy = 0; copy < origin.count; copy += 1) {
        entries.push({ fixture: index })
        expectedHashes.push(hash(payload))
        expectedSizes.push(payload.length)
      }
    }
    scenarios.push({
      name: config.name,
      config: {
        root,
        fixtures,
        entries,
        expectedHashes,
        expectedSizes,
        maxConnections: config.maxConnections
      }
    })
  }

  await addScenario({
    name: 'small-512KiB-4conn',
    maxConnections: 4,
    origins: [
      { sizeMb: 0.5, count: 1, perSocketBytesPerSecond: 32 * MB }
    ]
  })
  await addScenario({
    name: 'large-64MiB-1conn',
    maxConnections: 1,
    origins: [
      { sizeMb: 64, count: 1, perSocketBytesPerSecond: 32 * MB }
    ]
  })
  await addScenario({
    name: 'large-64MiB-4conn',
    maxConnections: 4,
    origins: [
      { sizeMb: 64, count: 1, perSocketBytesPerSecond: 32 * MB }
    ]
  })
  await addScenario({
    name: 'large-128MiB-16conn',
    maxConnections: 16,
    origins: [
      { sizeMb: 128, count: 1, perSocketBytesPerSecond: 8 * MB }
    ]
  })
  await addScenario({
    name: 'two-origins-64MiB-16conn',
    maxConnections: 16,
    origins: [
      { sizeMb: 64, count: 1, perSocketBytesPerSecond: 8 * MB },
      { sizeMb: 64, count: 1, perSocketBytesPerSecond: 8 * MB }
    ]
  })
  await addScenario({
    name: 'three-origins-32MiB-4conn',
    maxConnections: 4,
    origins: [
      { sizeMb: 32, count: 1, perSocketBytesPerSecond: 16 * MB },
      { sizeMb: 32, count: 1, perSocketBytesPerSecond: 16 * MB },
      { sizeMb: 32, count: 1, perSocketBytesPerSecond: 16 * MB }
    ]
  })

  const selected = options.only
    ? scenarios.filter((scenario) => options.only.includes(scenario.name))
    : scenarios

  console.log(
    `runs=${options.runs} per-socket rates are fixture caps; latency=10ms\n`
  )
  const report = []
  try {
    for (const scenario of selected) {
      const rows = []
      for (const split of SPLITS) {
        const row = await benchmarkScenario(
          binary,
          scenario.name,
          scenario.config,
          split,
          options.runs
        )
        rows.push(row)
        report.push({ scenario: scenario.name, ...row })
        console.log(
          `${scenario.name.padEnd(30)} split=${String(split).padEnd(2)} ` +
            `ok=${row.ok} elapsed=${row.elapsedMs?.toFixed(1)}ms ` +
            `throughput=${row.throughputMbps?.toFixed(1)}MiB/s ` +
            `connections=${row.connections} maxActive=${row.maxActive} ` +
            `requests=${row.requests} ranges=${row.rangeRequests} ` +
            `cpu=${row.cpuSeconds ?? 'n/a'}s ` +
            `ram=${row.peakWorkingSetMb?.toFixed(1) ?? 'n/a'}MiB`
        )
      }
      if (rows.length === 2 && rows[0].ok && rows[1].ok) {
        const gain = rows[0].elapsedMs / rows[1].elapsedMs
        console.log(
          `  -> split=16 vs split=8 elapsed improvement: ${gain.toFixed(2)}x\n`
        )
      }
    }

    if (!options.only || options.only.includes('resume')) {
      const resumeFixture = await startFixture(payloads.get(64), hosts[0], {
        perSocketBytesPerSecond: 8 * MB,
        requestLatencyMs: 10
      })
      try {
        for (const [firstSplit, secondSplit] of [
          [8, 8],
          [16, 16],
          [8, 16],
          [16, 8]
        ]) {
          const result = await runResume(
            binary,
            resumeFixture,
            payloads.get(64),
            root,
            firstSplit,
            secondSplit,
            16
          )
          report.push({ scenario: 'resume-64MiB-16conn', ...result })
          console.log(
            `resume-64MiB-16conn ${firstSplit}->${secondSplit} ok=${result.ok} ` +
              `partial=${(result.partialBytes / MB).toFixed(1)}MiB ` +
              `control=${result.controlFile} ` +
              `resumeBytes=${(result.resumeBytes / MB).toFixed(1)}MiB ` +
              `offsetRanges=${result.resumeRangesWithOffset}/${result.rangeRequests}`
          )
        }
      } finally {
        await resumeFixture.close()
      }
    }
  } finally {
    for (const scenario of scenarios) {
      for (const fixture of scenario.config.fixtures) {
        await fixture.close().catch(() => undefined)
      }
    }
    await fs.rm(root, { recursive: true, force: true })
  }

  const failures = report.filter((entry) => entry.ok === false)
  if (failures.length > 0) {
    console.error(`\n${failures.length} benchmark run(s) failed.`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
