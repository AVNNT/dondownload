import { describe, expect, it } from 'vitest'
import {
  MAX_SNIFFED_PER_TAB,
  canonicalMediaUrl,
  classifyMediaResponse,
  createMediaSnifferStore,
  formatBadgeCount,
  normalizeSniffedQueueMessage,
  parseHlsMaster,
  sniffedEntryForMessage,
  sniffedFilename
} from '../extension/media-sniffer'

const NOW = 1_800_000_000_000

function observe(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    url: 'https://media.example/video/clip.mp4',
    statusCode: 200,
    contentType: 'video/mp4',
    contentLength: String(300 * 1024),
    contentRange: null,
    ...overrides
  }
}

function classified(overrides: Record<string, unknown> = {}) {
  const result = classifyMediaResponse(observe(overrides), NOW)
  if (!result || 'segment' in result) throw new Error('not a media entry')
  return result.entry
}

describe('media response classification', () => {
  it('classifies a progressive video by Content-Type and size', () => {
    const entry = classified()
    expect(entry).toMatchObject({
      kind: 'file',
      contentType: 'video/mp4',
      sizeBytes: 300 * 1024,
      audioOnly: false,
      sourceHost: 'media.example'
    })
  })

  it('classifies audio by extension/type and accepts an unknown size', () => {
    const entry = classified({
      url: 'https://media.example/song.mp3',
      contentType: 'audio/mpeg',
      contentLength: null
    })
    expect(entry).toMatchObject({
      kind: 'file',
      audioOnly: true,
      sizeBytes: null,
      extension: 'mp3'
    })
  })

  it('recognises HLS and DASH manifests', () => {
    const hls = classified({
      url: 'https://media.example/master.m3u8',
      contentType: 'application/vnd.apple.mpegurl',
      contentLength: null
    })
    expect(hls.kind).toBe('hls')
    const dash = classified({
      url: 'https://media.example/manifest.mpd',
      contentType: 'application/dash+xml',
      contentLength: null
    })
    expect(dash.kind).toBe('dash')
  })

  it('ignores tiny known media, ads/trackers and YouTube videoplayback', () => {
    expect(
      classifyMediaResponse(
        observe({ contentLength: String(50 * 1024) }),
        NOW
      )
    ).toBeNull()
    expect(
      classifyMediaResponse(
        observe({ url: 'https://doubleclick.net/ad.mp4' }),
        NOW
      )
    ).toBeNull()
    expect(
      classifyMediaResponse(
        observe({
          url: 'https://rr1---sn-abc.googlevideo.com/videoplayback?id=1'
        }),
        NOW
      )
    ).toBeNull()
  })

  it('suppresses HLS/DASH segments instead of listing them', () => {
    const segment = classifyMediaResponse(
      observe({
        url: 'https://media.example/hls/seg-1.ts',
        contentType: 'video/mp2t',
        contentLength: null
      }),
      NOW
    )
    expect(segment).toMatchObject({ segment: true, sourceHost: 'media.example' })
    const fragment = classifyMediaResponse(
      observe({
        url: 'https://media.example/hls/frag-1.m4s',
        contentType: 'video/iso.segment',
        contentLength: null
      }),
      NOW
    )
    expect(fragment).toMatchObject({ segment: true })
  })
})

describe('grouping, range collapse and per-tab reset', () => {
  it('collapses range requests that differ only by range bookkeeping params', () => {
    const store = createMediaSnifferStore({ now: () => NOW })
    store.record(
      7,
      'https://page.example/watch',
      'Page',
      classified({ url: 'https://cdn.example/v.mp4?range=0-100&id=1' }),
      null,
      NOW
    )
    store.record(
      7,
      'https://page.example/watch',
      'Page',
      classified({
        url: 'https://cdn.example/v.mp4?range=100-200&rn=2&rbuf=1&id=1',
        statusCode: 206,
        contentRange: 'bytes 100-199/300000',
        contentLength: '100'
      }),
      null,
      NOW + 1
    )
    expect(store.count(7)).toBe(1)
    const entry = store.list(7)[0]!
    expect(entry.url).toContain('id=1')
    expect(entry.url).not.toContain('range=')
    expect(entry.sizeBytes).toBe(300_000)
  })

  it('keeps one master entry and suppresses its variants in either order', () => {
    const masterText = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360',
      'low/index.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720',
      'high/index.m3u8'
    ].join('\n')
    const master = parseHlsMaster(masterText, 'https://cdn.example/hls/master.m3u8')
    expect(master.isMaster).toBe(true)
    expect(master.variants.map((variant) => variant.label)).toEqual([
      '720p',
      '360p'
    ])

    // A variant arrives before the master.
    const store = createMediaSnifferStore({ now: () => NOW })
    store.record(
      3,
      'https://page.example/watch',
      'Page',
      classified({
        url: 'https://cdn.example/hls/high/index.m3u8',
        contentType: 'application/vnd.apple.mpegurl',
        contentLength: null
      }),
      { isMaster: false, isMediaPlaylist: true, variants: [] },
      NOW
    )
    store.record(
      3,
      'https://page.example/watch',
      'Page',
      classified({
        url: 'https://cdn.example/hls/master.m3u8',
        contentType: 'application/vnd.apple.mpegurl',
        contentLength: null
      }),
      master,
      NOW + 1
    )
    expect(store.count(3)).toBe(1)
    expect(store.list(3)[0]!.variants).toHaveLength(2)

    // A late variant no longer creates a second row.
    store.record(
      3,
      'https://page.example/watch',
      'Page',
      classified({
        url: 'https://cdn.example/hls/low/index.m3u8',
        contentType: 'application/vnd.apple.mpegurl',
        contentLength: null
      }),
      { isMaster: false, isMediaPlaylist: true, variants: [] },
      NOW + 2
    )
    expect(store.count(3)).toBe(1)
  })

  it('marks a manifest active when a segment is observed without listing it', () => {
    const store = createMediaSnifferStore({ now: () => NOW })
    store.record(
      4,
      'https://page.example/watch',
      'Page',
      classified({
        url: 'https://cdn.example/hls/master.m3u8',
        contentType: 'application/vnd.apple.mpegurl',
        contentLength: null
      }),
      { isMaster: false, isMediaPlaylist: false, variants: [] },
      NOW
    )
    expect(store.list(4)[0]!.active).toBe(true)
    store.markSegment(4, 'cdn.example', NOW + 5)
    expect(store.list(4)[0]!.lastSeenAt).toBe(NOW + 5)
  })

  it('clears a tab on navigation but keeps entries seen after an SPA change', () => {
    const store = createMediaSnifferStore({ now: () => NOW })
    store.record(
      9,
      'https://page.example/one',
      'One',
      classified({ url: 'https://cdn.example/one.mp4' }),
      null,
      NOW
    )
    store.record(
      9,
      'https://page.example/two',
      'Two',
      classified({ url: 'https://cdn.example/two.mp4' }),
      null,
      NOW + 10
    )
    store.clearBefore(9, NOW + 5)
    expect(store.count(9)).toBe(1)
    expect(store.list(9)[0]!.url).toContain('two.mp4')
    store.clearTab(9)
    expect(store.count(9)).toBe(0)
  })

  it('caps the per-tab list and exposes bounded message rows', () => {
    const store = createMediaSnifferStore({ now: () => NOW })
    for (let index = 0; index < MAX_SNIFFED_PER_TAB + 10; index += 1) {
      store.record(
        11,
        'https://page.example/watch',
        'Page',
        classified({
          url: `https://cdn.example/clip-${index}.mp4?range=${index}`
        }),
        null,
        NOW + index
      )
    }
    expect(store.count(11)).toBe(MAX_SNIFFED_PER_TAB)
    const row = sniffedEntryForMessage(store.list(11)[0]!)
    expect(row).not.toBeNull()
    expect(row && row.kind).toBe('file')
    expect(JSON.stringify(row)).not.toContain('page.example/watch')
  })
})

describe('badge and filename helpers', () => {
  it('formats the detected-media badge count', () => {
    expect(formatBadgeCount(0)).toBe('')
    expect(formatBadgeCount(1)).toBe('1')
    expect(formatBadgeCount(99)).toBe('99')
    expect(formatBadgeCount(100)).toBe('99+')
  })

  it('builds a title-based filename with the real extension', () => {
    const entry = classified({ url: 'https://media.example/abc123.mp4' })
    entry.title = 'My: video? "demo"'
    expect(sniffedFilename(entry)).toBe('My_ video_ _demo_.mp4')
    const hls = classified({
      url: 'https://media.example/master.m3u8',
      contentType: 'application/vnd.apple.mpegurl',
      contentLength: null
    })
    hls.title = 'Show episode'
    expect(sniffedFilename(hls)).toBe('Show episode.mp4')
  })

  it('canonicalises only the documented range parameters', () => {
    expect(
      canonicalMediaUrl('https://cdn.example/v.mp4?range=1&rn=2&rbuf=3&id=9')
    ).toBe('https://cdn.example/v.mp4?id=9')
  })

  it('validates the queue message and optional pinned variant', () => {
    expect(
      normalizeSniffedQueueMessage({
        type: 'dondownload:sniffed-queue',
        tabId: 3,
        url: 'https://cdn.example/master.m3u8',
        variantUrl: 'https://cdn.example/high.m3u8'
      })
    ).toMatchObject({ ok: true, tabId: 3 })
    expect(
      normalizeSniffedQueueMessage({
        type: 'dondownload:sniffed-queue',
        url: 'file:///etc/passwd'
      }).ok
    ).toBe(false)
  })
})
