import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { PublicTargetLookup } from '../src/main/net/publicTarget'
import type { PreflightConnectLookup } from '../src/main/net/publicPreflight'
import { classifyScanCandidate } from '../src/main/scanner/classify'
import {
  ScanProbeCache,
  probeScanCandidates,
  probeScanItem,
  type ProbeScanItemFn
} from '../src/main/scanner/probe'
import {
  groupScriptSets,
  matchSetsToVideos,
  VIDEO_MATCH_AMBIGUITY_MARGIN,
  VIDEO_MATCH_THRESHOLD,
  SAME_POST_BONUS,
  type ScriptSet,
  type VideoCandidate
} from '../src/shared/funscriptPairing'

function resultFor(url: string) {
  const contentType = url.endsWith('.mp4') ? 'video/mp4' : 'application/zip'
  return {
    status: 'ready' as const,
    verified: true,
    contentType,
    contentDisposition: null,
    sizeBytes: 1,
    finalUrl: url,
    classification: classifyScanCandidate({ url, contentType }),
    reason: null
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('bounded parallel probing', () => {
  it('honours the global and per-host concurrency limits', async () => {
    const activeByHost = new Map<string, number>()
    let active = 0
    let maxActive = 0
    const maxByHost = new Map<string, number>()
    const hosts = ['a.example', 'b.example', 'c.example', 'd.example']
    const inputs = Array.from({ length: 64 }, (_value, index) => ({
      url: `https://${hosts[index % hosts.length]}/file-${index}.zip`
    }))
    const probe: ProbeScanItemFn = async (input) => {
      const host = new URL(input.url).hostname
      active += 1
      maxActive = Math.max(maxActive, active)
      const perHost = (activeByHost.get(host) ?? 0) + 1
      activeByHost.set(host, perHost)
      maxByHost.set(host, Math.max(maxByHost.get(host) ?? 0, perHost))
      try {
        await delay(5)
        return resultFor(input.url)
      } finally {
        active -= 1
        activeByHost.set(host, (activeByHost.get(host) ?? 1) - 1)
      }
    }

    await probeScanCandidates(inputs, {
      probe,
      concurrency: 8,
      perHostConcurrency: 3,
      onResult: () => undefined
    })

    expect(maxActive).toBeLessThanOrEqual(8)
    expect(maxActive).toBeGreaterThan(2)
    expect([...maxByHost.values()].every((value) => value <= 3)).toBe(true)
  })

  it('probes one normalized URL once and delivers every duplicate index', async () => {
    const calls: string[] = []
    const probe: ProbeScanItemFn = async (input) => {
      calls.push(input.url)
      await delay(5)
      return resultFor(input.url)
    }
    const inputs = Array.from({ length: 40 }, (_value, index) => ({
      url: `https://dedupe.example/file-${index % 10}.zip`
    }))
    const results: Array<{ index: number; size: number | null }> = []
    await probeScanCandidates(inputs, {
      probe,
      onResult: (index, result) => results.push({ index, size: result.sizeBytes })
    })

    expect(calls).toHaveLength(10)
    expect(results).toHaveLength(40)
    expect(new Set(results.map((entry) => entry.index)).size).toBe(40)
  })

  it('shares in-flight probes through the per-scan cache', async () => {
    let calls = 0
    const probe: ProbeScanItemFn = async (input) => {
      calls += 1
      await delay(10)
      return resultFor(input.url)
    }
    const cache = new ScanProbeCache()
    const inputs = Array.from({ length: 8 }, () => ({
      url: 'https://shared.example/file.zip'
    }))
    const callbacks: number[] = []
    await Promise.all([
      probeScanCandidates(inputs, {
        probe,
        cache,
        onResult: (index) => callbacks.push(index)
      }),
      probeScanCandidates(inputs, {
        probe,
        cache,
        onResult: (index) => callbacks.push(index)
      })
    ])

    expect(calls).toBe(1)
    expect(callbacks).toHaveLength(16)
  })

  it('stops dispatching and publishing when the scan is cancelled', async () => {
    const controller = new AbortController()
    let started = 0
    const probe: ProbeScanItemFn = async (input) => {
      started += 1
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 50)
        input.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer)
            resolve()
          },
          { once: true }
        )
      })
      return resultFor(input.url)
    }
    const published: number[] = []
    const inputs = Array.from({ length: 100 }, (_value, index) => ({
      url: `https://cancel.example/file-${index}.zip`,
      signal: controller.signal
    }))
    const pending = probeScanCandidates(inputs, {
      probe,
      signal: controller.signal,
      onResult: (index) => published.push(index)
    })
    controller.abort()
    await pending

    expect(started).toBeLessThan(inputs.length)
    expect(published).toEqual([])
  })
})

interface SeenRequest {
  method: string
  range: string | undefined
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

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

const publicLookup: PublicTargetLookup = async () => [
  { address: '93.184.216.34', family: 4 }
]
const connectLookup: PreflightConnectLookup = (_hostname, options, callback) => {
  if (options && options.all === true) {
    callback(null, [{ address: '127.0.0.1', family: 4 }])
    return
  }
  callback(null, '127.0.0.1', 4)
}

describe('probe HEAD before GET', () => {
  it('uses one keep-alive HEAD request when the server proves the file', async () => {
    const seen: SeenRequest[] = []
    const { port } = await listen((request, response) => {
      seen.push({ method: request.method ?? '', range: request.headers.range })
      response.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Length': '1234'
      })
      response.end()
    })

    const result = await probeScanItem(
      { url: `http://public.example:${port}/file.zip` },
      { lookup: publicLookup, connectLookup }
    )

    expect(result.status).toBe('ready')
    expect(result.verified).toBe(true)
    expect(result.sizeBytes).toBe(1234)
    expect(seen).toEqual([{ method: 'HEAD', range: undefined }])
  })

  it('falls back to the bounded range GET when HEAD is not allowed', async () => {
    const seen: SeenRequest[] = []
    const { port } = await listen((request, response) => {
      seen.push({ method: request.method ?? '', range: request.headers.range })
      if (request.method === 'HEAD') {
        response.writeHead(405)
        response.end()
        return
      }
      response.writeHead(206, {
        'Content-Type': 'application/zip',
        'Content-Range': 'bytes 0-0/4321'
      })
      response.end()
    })

    const result = await probeScanItem(
      { url: `http://public.example:${port}/file.zip` },
      { lookup: publicLookup, connectLookup }
    )

    expect(result.status).toBe('ready')
    expect(result.sizeBytes).toBe(4321)
    expect(seen.map((entry) => entry.method)).toEqual(['HEAD', 'GET'])
    expect(seen[1]?.range).toBe('bytes=0-0')
  })

  it('returns a cancelled result when the scan is aborted mid-probe', async () => {
    const { port } = await listen((_request, response) => {
      setTimeout(() => {
        response.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Length': '77'
        })
        response.end()
      }, 500)
    })
    const controller = new AbortController()
    const pending = probeScanItem(
      {
        url: `http://public.example:${port}/file.zip`,
        signal: controller.signal
      },
      { lookup: publicLookup, connectLookup }
    )
    controller.abort()
    const result = await pending
    expect(result.reason).toBe('The scan was cancelled.')
    expect(result.verified).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Pairing equivalence
// ---------------------------------------------------------------------------

const REFERENCE_RESOLUTION_TAG =
  /^(?:\d{3,4}[pi]|[248]k|uhd|fhd|hd|hdr\d*|sdr|dv|dolbyvision|\d{2,3}fps|[xh]26[45]|hevc|av1|vp9|aac|ac3|eac3|dts|opus|webrip|web|bluray|blurayrip|brrip|bdrip|dvdrip|hdtv|remux|proper|repack)$/u
const REFERENCE_STOP_WORDS = new Set([
  'fancam',
  'fancams',
  'official',
  'video',
  'mv',
  'musicvideo',
  'the',
  'a',
  'an',
  'of',
  'and',
  'feat',
  'ft',
  'full',
  'dl',
  'script',
  'funscript',
  'funscripts'
])

function referenceRawTokens(value: string): string[] {
  let text = value.normalize('NFKC')
  text = text.replace(/([\p{Ll}])([\p{Lu}])/gu, '$1 $2')
  text = text.replace(/([\p{Lu}]+)([\p{Lu}][\p{Ll}])/gu, '$1 $2')
  text = text.normalize('NFKD').replace(/\p{M}+/gu, '')
  text = text.toLowerCase()
  text = text.replace(/['\u2019`\u00b4]/gu, '')
  text = text.replace(/&/gu, ' and ')
  text = text.replace(/[^\p{L}\p{N}]+/gu, ' ')
  return text.split(/\s+/u).filter((token) => token.length > 0)
}

function referenceTokenize(value: string): string[] {
  return referenceRawTokens(value).filter(
    (token) =>
      !REFERENCE_STOP_WORDS.has(token) && !REFERENCE_RESOLUTION_TAG.test(token)
  )
}

function referenceUnique(tokens: readonly string[]): string[] {
  return [...new Set(tokens)]
}

function referenceBigramDice(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) return 0
  if (a === b) return 1
  if (a.length < 2 || b.length < 2) return 0
  const counts = new Map<string, number>()
  for (let index = 0; index < a.length - 1; index += 1) {
    const gram = a.slice(index, index + 2)
    counts.set(gram, (counts.get(gram) ?? 0) + 1)
  }
  let common = 0
  for (let index = 0; index < b.length - 1; index += 1) {
    const gram = b.slice(index, index + 2)
    const remaining = counts.get(gram) ?? 0
    if (remaining > 0) {
      common += 1
      counts.set(gram, remaining - 1)
    }
  }
  return (2 * common) / (a.length - 1 + (b.length - 1))
}

function referenceSimilarity(aTokens: readonly string[], bTokens: readonly string[]): number {
  const a = referenceUnique(aTokens)
  const b = referenceUnique(bTokens)
  if (a.length === 0 || b.length === 0) return 0
  const bSet = new Set(b)
  let intersection = 0
  for (const token of new Set(a)) if (bSet.has(token)) intersection += 1
  const containment = intersection / Math.min(a.length, b.length)
  const union = a.length + b.length - intersection
  const jaccard = union === 0 ? 0 : intersection / union
  const dice = referenceBigramDice(a.join(''), b.join(''))
  return 0.5 * containment + 0.3 * jaccard + 0.2 * dice
}

function referenceStripExtension(filename: string): string {
  const value = filename.trim()
  const lastDot = value.lastIndexOf('.')
  if (lastDot <= 0) return value
  return value.slice(0, lastDot).trim()
}

function referenceMatch(
  sets: readonly ScriptSet[],
  videos: readonly VideoCandidate[]
): Array<{ setId: string; videoId: string | null; score: number; ambiguous: boolean }> {
  return sets.map((set) => {
    const setTokens = referenceTokenize(set.base)
    const setPost =
      typeof set.postNumber === 'number' ? set.postNumber : null
    const ranked = videos
      .map((video, index) => {
        let score = 0
        const names = [video.title]
        if (video.filename !== undefined) {
          names.push(referenceStripExtension(video.filename))
        }
        for (const name of names) {
          if (typeof name !== 'string' || name.trim().length === 0) continue
          score = Math.max(score, referenceSimilarity(setTokens, referenceTokenize(name)))
        }
        const videoPost =
          typeof video.postNumber === 'number' ? video.postNumber : null
        if (setPost !== null && videoPost !== null && setPost === videoPost) {
          score = Math.min(1, score + SAME_POST_BONUS)
        }
        return { video, index, score }
      })
      .sort((left, right) => right.score - left.score || left.index - right.index)
    const top = ranked[0]
    const round = (value: number): number => Math.round(value * 10_000) / 10_000
    if (top === undefined || top.score < VIDEO_MATCH_THRESHOLD) {
      return {
        setId: set.id,
        videoId: null,
        score: top === undefined ? 0 : round(top.score),
        ambiguous: false
      }
    }
    const second = ranked[1]
    if (
      second !== undefined &&
      top.score - second.score < VIDEO_MATCH_AMBIGUITY_MARGIN
    ) {
      return {
        setId: set.id,
        videoId: null,
        score: round(top.score),
        ambiguous: true
      }
    }
    return {
      setId: set.id,
      videoId: top.video.id,
      score: round(top.score),
      ambiguous: false
    }
  })
}

function pairingFixture(): {
  sets: ScriptSet[]
  videos: VideoCandidate[]
} {
  const members = [
    'Wonyoung',
    'Yujin',
    'Rei',
    'Gaeul',
    'Liz',
    'Leeseo',
    'Mix',
    'Autumn',
    'Lily'
  ]
  const inputs: Array<{
    id: string
    filename: string
    postNumber?: number
  }> = Array.from({ length: 360 }, (_value, index) => ({
    id: `script-${index}`,
    filename: `LooksCanKill_${members[index % members.length]}.${
      ['', 'surge', 'sway', 'twist', 'roll'][index % 5]
    }.funscript`,
    postNumber: Math.floor(index / 12) + 1
  }))
  inputs.push(
    { id: 'weak-1', filename: 'Completely Unrelated Haptic Sequence.funscript' },
    { id: 'weak-2', filename: 'Chapter 01 Notes.funscript', postNumber: 99 },
    { id: 'variant-1', filename: 'LooksCanKill_Wonyoung.hard.funscript' },
    { id: 'variant-2', filename: 'LooksCanKill_Wonyoung (soft).funscript' }
  )
  const sets = groupScriptSets(inputs)
  const videos: VideoCandidate[] = members.map((member, index) => ({
    id: `video-${member.toLowerCase()}`,
    title: `IVE Looks Can Kill ${member} fancam 4K`,
    filename: `IVE Looks Can Kill ${member} fancam 2160p.mp4`,
    postNumber: Math.floor(index / 5) + 1
  }))
  videos.push(
    { id: 'video-weak', title: 'An entirely different upload' },
    {
      id: 'video-twin-a',
      title: 'IVE Looks Can Kill Wonyoung fancam 4K',
      postNumber: 7
    },
    {
      id: 'video-twin-b',
      title: 'IVE Looks Can Kill Wonyoung fancam 1080p',
      postNumber: 7
    }
  )
  return { sets, videos }
}

describe('funscript pairing equivalence', () => {
  it('matches the former full-matrix result on a large fixture', () => {
    const { sets, videos } = pairingFixture()
    expect(sets.length).toBeGreaterThan(250)
    expect(matchSetsToVideos(sets, videos)).toEqual(
      referenceMatch(sets, videos)
    )
  })
})
