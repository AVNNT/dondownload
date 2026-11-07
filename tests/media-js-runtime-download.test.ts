import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DENO_ARCHIVE_URL,
  DENO_CHECKSUM_URL,
  DENO_PINNED_VERSION,
  DENO_RETRY_AFTER_MS,
  createJsRuntime,
  needsJsRuntime
} from '../src/main/media/jsRuntime'
import type { UpdaterFetch, UpdaterHttpResponse } from '../src/main/media/updater'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))
  )
})

async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dondownload-jsruntime-'))
  roots.push(root)
  return root
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

function crc32(data: Uint8Array): number {
  let value = 0xffffffff
  for (const byte of data) {
    value = (CRC32_TABLE[(value ^ byte) & 0xff] as number) ^ (value >>> 8)
  }
  return (value ^ 0xffffffff) >>> 0
}

interface TestZipEntry {
  name: string
  data?: Uint8Array
  directory?: boolean
}

/** Build a stored (uncompressed) ZIP archive for tests. */
function buildZip(entries: TestZipEntry[]): Uint8Array {
  const encoder = new TextEncoder()
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0

  for (const entry of entries) {
    const name = encoder.encode(entry.name)
    const data = entry.directory ? new Uint8Array() : (entry.data ?? new Uint8Array())

    const local = new Uint8Array(30 + name.length + data.length)
    const localView = new DataView(local.buffer)
    localView.setUint32(0, 0x04034b50, true)
    localView.setUint16(4, 20, true)
    localView.setUint16(6, 0x800, true)
    localView.setUint16(8, 0, true)
    localView.setUint32(14, crc32(data), true)
    localView.setUint32(18, data.length, true)
    localView.setUint32(22, data.length, true)
    localView.setUint16(26, name.length, true)
    local.set(name, 30)
    local.set(data, 30 + name.length)
    locals.push(local)

    const central = new Uint8Array(46 + name.length)
    const centralView = new DataView(central.buffer)
    centralView.setUint32(0, 0x02014b50, true)
    centralView.setUint32(4, 20, true)
    centralView.setUint32(6, 20, true)
    centralView.setUint16(8, 0x800, true)
    centralView.setUint16(10, 0, true)
    centralView.setUint32(16, crc32(data), true)
    centralView.setUint32(20, data.length, true)
    centralView.setUint32(24, data.length, true)
    centralView.setUint16(28, name.length, true)
    centralView.setUint32(42, offset, true)
    central.set(name, 46)
    centrals.push(central)

    offset += local.length
  }

  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0)
  const eocd = new Uint8Array(22)
  const eocdView = new DataView(eocd.buffer)
  eocdView.setUint32(0, 0x06054b50, true)
  eocdView.setUint16(8, entries.length, true)
  eocdView.setUint16(10, entries.length, true)
  eocdView.setUint32(12, centralSize, true)
  eocdView.setUint32(16, offset, true)

  const archive = new Uint8Array(offset + centralSize + eocd.length)
  let cursor = 0
  for (const part of [...locals, ...centrals, eocd]) {
    archive.set(part, cursor)
    cursor += part.length
  }
  return archive
}

function denoArchive(): Uint8Array {
  const encoder = new TextEncoder()
  return buildZip([{ name: 'deno.exe', data: encoder.encode('verified deno') }])
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function response(
  status: number,
  body: Uint8Array,
  url: string
): UpdaterHttpResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'content-length' ? String(body.byteLength) : null
    },
    arrayBuffer: async () =>
      body.buffer.slice(
        body.byteOffset,
        body.byteOffset + body.byteLength
      ) as ArrayBuffer
  }
}

interface FakeNetwork {
  fetch: UpdaterFetch
  calls: string[]
}

function fakeNetwork(routes: {
  archive?: Uint8Array | number
  checksum?: Uint8Array | number
  fail?: boolean
}): FakeNetwork {
  const calls: string[] = []
  const fetchImpl: UpdaterFetch = async (url) => {
    calls.push(url)
    if (routes.fail === true) throw new Error('network down')
    const route =
      url === DENO_CHECKSUM_URL
        ? routes.checksum
        : url === DENO_ARCHIVE_URL
          ? routes.archive
          : undefined
    if (route === undefined) return response(404, new Uint8Array(), url)
    if (typeof route === 'number') {
      return response(route, new Uint8Array(), url)
    }
    return response(200, route, url)
  }
  return { fetch: fetchImpl, calls }
}

function checksumBody(archive: Uint8Array): Uint8Array {
  return new TextEncoder().encode(`${sha256(archive)}  deno.zip\n`)
}

describe('Deno runtime is downloaded on demand', () => {
  it('verifies the pinned archive and installs it atomically into userData', async () => {
    const root = await makeRoot()
    const userData = path.join(root, 'userData')
    const archive = denoArchive()
    const network = fakeNetwork({
      archive,
      checksum: checksumBody(archive)
    })

    const runtime = createJsRuntime({
      env: {},
      platform: 'win32',
      cwd: root,
      userDataPath: userData,
      fetchImpl: network.fetch
    })

    await expect(runtime.ensure()).resolves.toBe(
      path.join(userData, 'tools', 'deno', DENO_PINNED_VERSION, 'deno.exe')
    )
    await expect(
      fs.readFile(
        path.join(userData, 'tools', 'deno', DENO_PINNED_VERSION, 'deno.exe'),
        'utf8'
      )
    ).resolves.toBe('verified deno')

    // Only the two pinned release URLs are requested.
    expect(network.calls).toEqual([DENO_CHECKSUM_URL, DENO_ARCHIVE_URL])
    // The temporary staging directory is gone; only the version dir remains.
    const toolsDir = path.join(userData, 'tools', 'deno')
    await expect(fs.readdir(toolsDir)).resolves.toEqual([DENO_PINNED_VERSION])
    // A later call reuses the installed runtime without any network access.
    await expect(runtime.locate()).resolves.toBe(
      path.join(userData, 'tools', 'deno', DENO_PINNED_VERSION, 'deno.exe')
    )
    await expect(runtime.ensure()).resolves.toBe(
      path.join(userData, 'tools', 'deno', DENO_PINNED_VERSION, 'deno.exe')
    )
    expect(network.calls).toHaveLength(2)
  })

  it('refuses an archive whose SHA-256 does not match and never retries immediately', async () => {
    const root = await makeRoot()
    const userData = path.join(root, 'userData')
    const archive = denoArchive()
    const network = fakeNetwork({
      archive,
      checksum: new TextEncoder().encode(`${'a'.repeat(64)}  deno.zip\n`)
    })

    const runtime = createJsRuntime({
      env: {},
      platform: 'win32',
      cwd: root,
      userDataPath: userData,
      fetchImpl: network.fetch
    })

    await expect(runtime.ensure()).resolves.toBeNull()
    await expect(
      fs.stat(path.join(userData, 'tools', 'deno', DENO_PINNED_VERSION))
    ).rejects.toMatchObject({ code: 'ENOENT' })
    expect(network.calls).toEqual([DENO_CHECKSUM_URL, DENO_ARCHIVE_URL])

    // Inside the retry cooldown nothing is downloaded again.
    await expect(runtime.ensure()).resolves.toBeNull()
    expect(network.calls).toHaveLength(2)
  })

  it('retries after the cooldown elapses', async () => {
    const root = await makeRoot()
    const userData = path.join(root, 'userData')
    let clock = 1_000
    const network = fakeNetwork({ fail: true })

    const runtime = createJsRuntime({
      env: {},
      platform: 'win32',
      cwd: root,
      userDataPath: userData,
      fetchImpl: network.fetch,
      now: () => clock
    })

    await expect(runtime.ensure()).resolves.toBeNull()
    expect(network.calls).toHaveLength(1)
    clock += DENO_RETRY_AFTER_MS + 1
    await expect(runtime.ensure()).resolves.toBeNull()
    expect(network.calls).toHaveLength(2)
  })

  it('shares one download between concurrent callers', async () => {
    const root = await makeRoot()
    const userData = path.join(root, 'userData')
    const archive = denoArchive()
    const network = fakeNetwork({
      archive,
      checksum: checksumBody(archive)
    })

    const runtime = createJsRuntime({
      env: {},
      platform: 'win32',
      cwd: root,
      userDataPath: userData,
      fetchImpl: network.fetch
    })

    const results = await Promise.all([
      runtime.ensure(),
      runtime.ensure(),
      runtime.ensure()
    ])
    expect(new Set(results).size).toBe(1)
    expect(results[0]).not.toBeNull()
    expect(network.calls).toEqual([DENO_CHECKSUM_URL, DENO_ARCHIVE_URL])
  })

  it('uses an already installed runtime without any network access', async () => {
    const root = await makeRoot()
    const denoPath = path.join(root, 'vendor', 'deno', 'deno.exe')
    await fs.mkdir(path.dirname(denoPath), { recursive: true })
    await fs.writeFile(denoPath, 'fixture')
    const network = fakeNetwork({ fail: true })

    const runtime = createJsRuntime({
      env: {},
      platform: 'win32',
      cwd: root,
      userDataPath: path.join(root, 'userData'),
      fetchImpl: network.fetch
    })

    await expect(runtime.ensure()).resolves.toBe(denoPath)
    expect(network.calls).toHaveLength(0)
  })

  it('resolves to null instead of throwing when no runtime can be installed', async () => {
    const root = await makeRoot()
    const network = fakeNetwork({ fail: true })

    const runtime = createJsRuntime({
      env: {},
      platform: 'win32',
      cwd: root,
      userDataPath: null,
      fetchImpl: network.fetch
    })

    await expect(runtime.ensure()).resolves.toBeNull()
    expect(network.calls).toHaveLength(0)
  })
})

describe('needsJsRuntime', () => {
  it('is true only for YouTube origins', () => {
    for (const url of [
      'https://www.youtube.com/watch?v=abc',
      'https://youtube.com/watch?v=abc',
      'https://m.youtube.com/watch?v=abc',
      'https://music.youtube.com/watch?v=abc',
      'https://youtu.be/abc',
      'https://www.youtube-nocookie.com/embed/abc'
    ]) {
      expect(needsJsRuntime(url)).toBe(true)
    }
    for (const url of [
      'https://example.com/watch?v=abc',
      'https://notyoutube.com/watch?v=abc',
      'https://vimeo.com/12345',
      'not a url'
    ]) {
      expect(needsJsRuntime(url)).toBe(false)
    }
  })
})
