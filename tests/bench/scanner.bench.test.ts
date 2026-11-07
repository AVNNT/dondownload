import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PixeldrainListResolution } from '../../src/main/hosts/pixeldrain'
import type { MegaFolderResolution } from '../../src/main/hosts/mega'
import { classifyScanCandidate } from '../../src/main/scanner/classify'
import type { ProbeScanItemFn } from '../../src/main/scanner/probe'
import { probeScanCandidates } from '../../src/main/scanner/probe'
import { ScanSessionManager } from '../../src/main/scanner/session'
import { buildScanScriptSets, type PairingScanItem } from '../../src/shared/scriptSets'
import { matchSetsToVideos } from '../../src/shared/funscriptPairing'

/**
 * Scanner performance benchmark.
 *
 * This is deliberately outside `test:fast`: it runs a loopback fixture page with
 * 500 links, 2 s responses, Pixeldrain/MEGA metadata latency and duplicate
 * inputs, and prints one machine-readable JSON line per scenario.
 *
 *   npm run test:bench
 */

const PAGE_URL = 'https://forum.example/t/bench/123'
const PROBE_HOSTS = 6
const DETAIL_LINKS = 300
const REDIRECT_LINKS = 50
const DUPLICATE_LINKS = 20
const PIXELDRAIN_FILES = 60
const PIXELDRAIN_LISTS = 4
const MEGA_FILES = 40
const MEGA_FOLDERS = 4
const PLAIN_LINKS = 22
const SLOW_MS = 2_000
const PROVIDER_MS = 100

interface ProbeStats {
  active: number
  maxActive: number
  perHost: Map<string, number>
  maxPerHost: Map<string, number>
  requests: string[]
}

interface ProviderStats {
  active: number
  maxActive: number
  requests: number
}

function makeProbe(stats: ProbeStats): ProbeScanItemFn {
  return async (input) => {
    const host = new URL(input.url).hostname
    stats.requests.push(input.url)
    stats.active += 1
    stats.maxActive = Math.max(stats.maxActive, stats.active)
    const hostActive = (stats.perHost.get(host) ?? 0) + 1
    stats.perHost.set(host, hostActive)
    stats.maxPerHost.set(
      host,
      Math.max(stats.maxPerHost.get(host) ?? 0, hostActive)
    )
    try {
      await new Promise((resolve) => setTimeout(resolve, SLOW_MS))
      const contentType = input.url.endsWith('.mp4')
        ? 'video/mp4'
        : 'application/zip'
      return {
        status: 'ready' as const,
        verified: true,
        contentType,
        contentDisposition: null,
        sizeBytes: 2_048,
        finalUrl: input.url,
        classification: classifyScanCandidate({ url: input.url, contentType }),
        reason: null
      }
    } finally {
      stats.active -= 1
      stats.perHost.set(host, (stats.perHost.get(host) ?? 1) - 1)
    }
  }
}

function pageHtml(): string {
  const links: string[] = []
  for (let index = 0; index < DETAIL_LINKS; index += 1) {
    const host = `cdn${index % PROBE_HOSTS}.example`
    const extension = index % 4 === 0 ? 'mp4' : 'zip'
    links.push(
      `<a href="https://${host}/files/${index}.${extension}">file ${index}</a>`
    )
  }
  for (let index = 0; index < REDIRECT_LINKS; index += 1) {
    const host = `cdn${index % PROBE_HOSTS}.example`
    links.push(
      `<a href="https://${host}/r/${index}">redirect ${index}</a>`
    )
  }
  for (let index = 0; index < DUPLICATE_LINKS; index += 1) {
    const host = `cdn${index % PROBE_HOSTS}.example`
    links.push(
      `<a href="https://${host}/files/${index}.${index % 4 === 0 ? 'mp4' : 'zip'}?utm_source=dup">duplicate ${index}</a>`
    )
  }
  for (let index = 0; index < PIXELDRAIN_FILES; index += 1) {
    links.push(
      `<a href="https://pixeldrain.com/u/Pd${String(index).padStart(6, '0')}">pd ${index}</a>`
    )
  }
  for (let index = 0; index < PIXELDRAIN_LISTS; index += 1) {
    links.push(
      `<a href="https://pixeldrain.com/l/Pl${String(index).padStart(6, '0')}">list ${index}</a>`
    )
  }
  const megaFileKey = 'k'.repeat(43)
  const megaFolderKey = 'k'.repeat(22)
  for (let index = 0; index < MEGA_FILES; index += 1) {
    links.push(
      `<a href="https://mega.nz/file/Mf${String(index).padStart(6, '0')}#${megaFileKey}">mega ${index}</a>`
    )
  }
  for (let index = 0; index < MEGA_FOLDERS; index += 1) {
    links.push(
      `<a href="https://mega.nz/folder/Mg${String(index).padStart(6, '0')}#${megaFolderKey}">folder ${index}</a>`
    )
  }
  for (let index = 0; index < PLAIN_LINKS; index += 1) {
    links.push(`<a href="https://forum.example/post/${index}">post ${index}</a>`)
  }
  return `<html><body>${links.join('\n')}</body></html>`
}

function pixeldrainPort(stats: ProviderStats) {
  const entry = (listId: string, index: number) => ({
    entryId: `${listId}-${index}`,
    position: index,
    fileId: `Lf${listId}-${index}`,
    name: `List ${listId} file ${index}.mp4`,
    size: 1_000,
    mimeType: 'video/mp4',
    sourceUrl: `https://pixeldrain.com/u/Lf${listId}-${index}`,
    downloadUrl: `https://pixeldrain.com/api/file/Lf${listId}-${index}?download`,
    availability: 'available' as const,
    errorCode: null,
    errorReason: null
  })
  return {
    async resolveFile(url: string) {
      stats.requests += 1
      stats.active += 1
      stats.maxActive = Math.max(stats.maxActive, stats.active)
      try {
        await new Promise((resolve) => setTimeout(resolve, PROVIDER_MS))
        const id = new URL(url).pathname.split('/').pop() ?? 'unknown'
        return {
          kind: 'file' as const,
          fileId: id,
          name: `Pixeldrain ${id}.mp4`,
          size: 1_000,
          mimeType: 'video/mp4',
          sourceUrl: url,
          downloadUrl: `https://pixeldrain.com/api/file/${id}?download`
        }
      } finally {
        stats.active -= 1
      }
    },
    async resolveList(url: string): Promise<PixeldrainListResolution> {
      stats.requests += 1
      stats.active += 1
      stats.maxActive = Math.max(stats.maxActive, stats.active)
      try {
        await new Promise((resolve) => setTimeout(resolve, PROVIDER_MS))
        const id = new URL(url).pathname.split('/').pop() ?? 'unknown'
        const entries = Array.from({ length: 5 }, (_value, index) =>
          entry(id, index)
        )
        return {
          kind: 'list' as const,
          listId: id,
          title: `List ${id}`,
          sourceUrl: url,
          preview: {
            id: `preview-${id}`,
            kind: 'pixeldrain-list',
            title: `List ${id}`,
            entryCount: entries.length,
            availableCount: entries.length,
            unavailableCount: 0,
            entries: entries.map((item) => ({
              id: item.entryId,
              position: item.position,
              title: item.name,
              availability: 'available' as const,
              errorCode: null,
              errorReason: null
            }))
          },
          entries
        }
      } finally {
        stats.active -= 1
      }
    }
  }
}

function megaPort(stats: ProviderStats) {
  return {
    async resolveFile(url: string) {
      stats.requests += 1
      stats.active += 1
      stats.maxActive = Math.max(stats.maxActive, stats.active)
      try {
        await new Promise((resolve) => setTimeout(resolve, PROVIDER_MS))
        const id = new URL(url).pathname.split('/').pop() ?? 'unknown'
        return {
          kind: 'file' as const,
          fileId: id,
          folderId: null,
          name: `MEGA ${id}.mp4`,
          size: 2_000,
          downloadUrl: `https://gfs.example/${id}`,
          key: {
            aesKey: Buffer.alloc(16),
            iv: Buffer.alloc(16),
            metaMac: Buffer.alloc(8)
          },
          sourceUrl: url
        }
      } finally {
        stats.active -= 1
      }
    },
    async resolveFolder(url: string): Promise<MegaFolderResolution> {
      stats.requests += 1
      stats.active += 1
      stats.maxActive = Math.max(stats.maxActive, stats.active)
      try {
        await new Promise((resolve) => setTimeout(resolve, PROVIDER_MS))
        const id = new URL(url).pathname.split('/').pop() ?? 'unknown'
        const entries = Array.from({ length: 5 }, (_value, index) => ({
          entryId: `${id}-${index}`,
          position: index,
          nodeId: `Node${index}`,
          name: `MEGA ${id} file ${index}.mp4`,
          size: 2_000,
          sourceUrl: `https://mega.nz/file/${id}-${index}#${'k'.repeat(43)}`,
          key: {
            aesKey: Buffer.alloc(16),
            iv: Buffer.alloc(16),
            metaMac: Buffer.alloc(8)
          },
          availability: 'available' as const,
          errorCode: null,
          errorReason: null
        }))
        return {
          kind: 'folder' as const,
          folderId: id,
          title: `Folder ${id}`,
          sourceUrl: url,
          preview: {
            id: `preview-${id}`,
            kind: 'mega-folder',
            title: `Folder ${id}`,
            entryCount: entries.length,
            availableCount: entries.length,
            unavailableCount: 0,
            entries: entries.map((item) => ({
              id: item.entryId,
              position: item.position,
              title: item.name,
              availability: 'available' as const,
              errorCode: null,
              errorReason: null
            }))
          },
          entries
        }
      } finally {
        stats.active -= 1
      }
    }
  }
}

function duplicateCount(values: readonly string[]): number {
  const seen = new Set<string>()
  let duplicates = 0
  for (const value of values) {
    if (seen.has(value)) duplicates += 1
    else seen.add(value)
  }
  return duplicates
}

function pairingFixture(): PairingScanItem[] {
  const items: PairingScanItem[] = []
  for (let index = 0; index < 500; index += 1) {
    const base = `Fancam ${String(index % 200).padStart(3, '0')} Wonyoung`
    const axis = ['', 'surge', 'sway', 'twist'][index % 4]!
    items.push({
      id: `script-${index}`,
      name: `${base}${axis.length > 0 ? `.${axis}` : ''}.funscript`,
      category: 'script',
      kind: 'file',
      postNumber: Math.floor(index / 10) + 1,
      status: 'ready'
    })
  }
  for (let index = 0; index < 40; index += 1) {
    const base = `Fancam ${String(index).padStart(3, '0')} Wonyoung`
    items.push({
      id: `video-${index}`,
      name: `${base} 4K`,
      category: 'video',
      kind: 'page-link',
      postNumber: Math.floor(index / 10) + 1,
      status: 'ready'
    })
  }
  return items
}

const servers: Server[] = []

async function listen(
  handler: Parameters<typeof createServer>[1]
): Promise<{ server: Server; port: number }> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, port: (server.address() as AddressInfo).port }
}

beforeAll(async () => {
  // Nothing global to set up; each scenario owns its fixture.
})

afterAll(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

describe('scanner performance benchmark', () => {
  it('500-link page with mixed providers and slow hosts', async () => {
    const stats: ProbeStats = {
      active: 0,
      maxActive: 0,
      perHost: new Map(),
      maxPerHost: new Map(),
      requests: []
    }
    const pixeldrainStats: ProviderStats = { active: 0, maxActive: 0, requests: 0 }
    const megaStats: ProviderStats = { active: 0, maxActive: 0, requests: 0 }
    await listen((request, response) => {
      // The probe fixture only exercises the bounded request scheduler; the
      // probe double above owns latency and result classification.
      response.writeHead(200, {
        'Content-Type': request.url?.endsWith('.mp4') ? 'video/mp4' : 'application/zip',
        'Content-Length': '2048',
        'Accept-Ranges': 'bytes'
      })
      response.end()
    })
    const body = pageHtml()
    const sessions = new ScanSessionManager({
      fetchPage: async () => ({
        finalUrl: PAGE_URL,
        status: 200,
        contentType: 'text/html',
        contentDisposition: null,
        body,
        bytes: Buffer.byteLength(body)
      }),
      followDepth: 0,
      probeItem: makeProbe(stats),
      pixeldrain: pixeldrainPort(pixeldrainStats),
      mega: megaPort(megaStats),
      onUpdate: () => undefined
    })
    const start = performance.now()
    const started = sessions.start(PAGE_URL)
    await sessions.waitForScan(started.sessionId)
    const elapsed = performance.now() - start
    const session = sessions.getSession(started.sessionId)
    sessions.close()
    const perHost = [...stats.maxPerHost.entries()].sort((left, right) =>
      left[0].localeCompare(right[0])
    )
    const result = {
      scenario: 'full-scan-500',
      links: 500,
      items: session.items.length,
      status: session.status,
      totalMs: Math.round(elapsed),
      probeRequests: stats.requests.length,
      duplicateProbeRequests: duplicateCount(stats.requests),
      maxConcurrentProbes: stats.maxActive,
      perHostMax: Object.fromEntries(perHost),
      pixeldrainRequests: pixeldrainStats.requests,
      pixeldrainMaxConcurrent: pixeldrainStats.maxActive,
      megaRequests: megaStats.requests,
      megaMaxConcurrent: megaStats.maxActive
    }
    console.log(`SCANNER_BENCH ${JSON.stringify(result)}`)
    expect(session.items.length).toBeGreaterThan(0)
  }, 600_000)

  it('deduplicates repeated probe inputs', async () => {
    const stats: ProbeStats = {
      active: 0,
      maxActive: 0,
      perHost: new Map(),
      maxPerHost: new Map(),
      requests: []
    }
    const index: number[] = []
    const inputs = Array.from({ length: 100 }, (_value, position) => ({
      url: `https://dedupe.example/file-${position % 50}.zip`,
      signal: undefined
    }))
    const start = performance.now()
    await probeScanCandidates(inputs, {
      probe: makeProbe(stats),
      onResult: (position) => index.push(position)
    })
    const elapsed = performance.now() - start
    const result = {
      scenario: 'duplicate-inputs',
      inputs: inputs.length,
      uniqueUrls: 50,
      probeRequests: stats.requests.length,
      duplicateProbeRequests: duplicateCount(stats.requests),
      resultCallbacks: index.length,
      totalMs: Math.round(elapsed),
      maxConcurrentProbes: stats.maxActive
    }
    console.log(`SCANNER_BENCH ${JSON.stringify(result)}`)
    expect(index.length).toBeGreaterThan(0)
  }, 120_000)

  it('pairs 500 scripts with 40 videos', () => {
    const items = pairingFixture()
    const start = performance.now()
    let setCount = 0
    let matched = 0
    for (let run = 0; run < 5; run += 1) {
      const sets = buildScanScriptSets(items)
      setCount = sets.length
      matched = sets.filter((set) => set.matchedVideoItemId !== null).length
    }
    const elapsed = performance.now() - start
    const result = {
      scenario: 'pairing-500x40',
      scriptItems: items.filter((item) => item.category === 'script').length,
      videoItems: items.filter((item) => item.category === 'video').length,
      sets: setCount,
      matched,
      runs: 5,
      totalMs: Math.round(elapsed),
      perRunMs: Math.round((elapsed / 5) * 10) / 10
    }
    console.log(`SCANNER_BENCH ${JSON.stringify(result)}`)
    expect(setCount).toBeGreaterThan(0)
  })

  it('matches a synthetic 500x40 pairing matrix directly', () => {
    const items = pairingFixture()
    const sets = buildScanScriptSets(items)
    const videos = items
      .filter((item) => item.category === 'video')
      .map((item) => ({
        id: item.id,
        title: item.name,
        ...(item.postNumber === null ? {} : { postNumber: item.postNumber })
      }))
    // buildScanScriptSets already includes matching; this measurement isolates
    // the matcher itself on the same shapes.
    const rawSets = sets.map((set) => ({
      id: set.id,
      base: set.base,
      normalizedBase: set.base,
      postNumber: set.postNumber,
      files: [],
      axes: [],
      variants: [],
      mainFileId: null,
      missingMain: false,
      conflicts: []
    }))
    const start = performance.now()
    let matched = 0
    for (let run = 0; run < 10; run += 1) {
      matched = matchSetsToVideos(rawSets, videos).filter(
        (match) => match.videoId !== null
      ).length
    }
    const elapsed = performance.now() - start
    console.log(
      `SCANNER_BENCH ${JSON.stringify({
        scenario: 'match-500x40',
        sets: rawSets.length,
        videos: videos.length,
        matched,
        runs: 10,
        totalMs: Math.round(elapsed),
        perRunMs: Math.round((elapsed / 10) * 10) / 10
      })}`
    )
    expect(rawSets.length).toBeGreaterThan(0)
  })
})
