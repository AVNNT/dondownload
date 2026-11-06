import { describe, expect, it } from 'vitest'
import type {
  ScanItem,
  ScanScriptFile,
  ScanScriptSet,
  ScanSession
} from '../src/shared/scanner'
import { MAX_SCAN_SELECTION } from '../src/shared/scanner'
import { parseScanQueueSelectionsInput } from '../src/shared/scanner'
import {
  bestScriptSetForVideo,
  buildScanBulkSelection,
  buildScanPreSelection,
  bulkSelectionItemCount
} from '../src/shared/scanSelection'

function item(overrides: Partial<ScanItem> & Pick<ScanItem, 'id' | 'name'>): ScanItem {
  return {
    category: 'video',
    kind: 'page-link',
    hostname: 'example.com',
    sizeBytes: null,
    verified: true,
    status: 'ready',
    postNumber: 1,
    author: null,
    ...overrides
  }
}

function script(id: string, name = `${id}.funscript`): ScanItem {
  return item({
    id,
    name,
    category: 'script',
    kind: 'file',
    hostname: 'forum.example',
    sizeBytes: 100
  })
}

function scriptFile(id: string, axis: string | null = null): ScanScriptFile {
  return {
    id,
    filename: `${id}.funscript`,
    axis,
    variant: null,
    isMain: axis === null,
    targetName: null
  }
}

function set(
  id: string,
  files: ScanScriptFile[],
  overrides: Partial<ScanScriptSet> = {}
): ScanScriptSet {
  return {
    id: `set:${id}`,
    base: id,
    postNumber: 1,
    axes: files.flatMap((file) => (file.axis === null ? [] : [file.axis])),
    variants: [],
    missingMain: false,
    conflicts: [],
    matchedVideoItemId: null,
    ambiguous: false,
    matchBucket: 'strong',
    files,
    ...overrides
  }
}

function session(
  sessionId: string,
  items: ScanItem[],
  scriptSets: ScanScriptSet[]
): Pick<ScanSession, 'sessionId' | 'items' | 'scriptSets'> {
  return { sessionId, items, scriptSets }
}

describe('scan pre-selection', () => {
  it('ticks videos with their best matching script set and standalone sets', () => {
    const videoA = item({
      id: 'video-a',
      name: 'Fancam 01',
      formats: [
        {
          optionId: 'best-a',
          kind: 'video',
          label: '1080p MP4',
          container: 'mp4',
          width: 1920,
          height: 1080,
          sizeBytes: null,
          sizeIsEstimate: false,
          outputFormats: ['auto']
        },
        {
          optionId: '720-a',
          kind: 'video',
          label: '720p MP4',
          container: 'mp4',
          width: 1280,
          height: 720,
          sizeBytes: null,
          sizeIsEstimate: false,
          outputFormats: ['auto']
        }
      ],
      bestOptionId: 'best-a'
    })
    const videoB = item({ id: 'video-b', name: 'Fancam 02' })
    const browserOnly = item({
      id: 'video-browser',
      name: 'Hanime1 page',
      status: 'browser-only'
    })
    const items = [
      videoA,
      videoB,
      browserOnly,
      script('a-main'),
      script('a-roll', 'Fancam 01.roll.funscript'),
      script('b-main'),
      script('ambiguous-main')
    ]
    const sets = [
      set('a-weak', [scriptFile('a-weak-main')], {
        matchedVideoItemId: 'video-a',
        matchBucket: 'weak'
      }),
      set('a-strong', [scriptFile('a-main'), scriptFile('a-roll', 'roll')], {
        matchedVideoItemId: 'video-a',
        matchBucket: 'strong'
      }),
      set('b-standalone', [scriptFile('b-main')]),
      set('ambiguous', [scriptFile('ambiguous-main')], {
        matchedVideoItemId: 'video-b',
        ambiguous: true
      })
    ]

    const pre = buildScanPreSelection(session('scan_a', items, sets))

    expect(pre.itemIds.sort()).toEqual(
      ['a-main', 'a-roll', 'b-main', 'video-a'].sort()
    )
    expect(pre.videoCount).toBe(1)
    expect(pre.scriptCount).toBe(3)
    expect(pre.overLimit).toBe(false)
    expect(pre.videoOptions).toEqual([
      { itemId: 'video-a', optionId: 'best-a' }
    ])
    expect(pre.pairings).toEqual([
      {
        videoItemId: 'video-a',
        setId: 'set:a-strong',
        scriptItemIds: ['a-main', 'a-roll'],
        primaryVariant: null,
        rename: true
      }
    ])
    // Browser-only and ambiguous cards stay unticked.
    expect(pre.itemIds).not.toContain('video-browser')
    expect(pre.itemIds).not.toContain('ambiguous-main')
    // The weak set lost to the strong set by the existing match bucket.
    expect(pre.itemIds).not.toContain('a-weak-main')
  })

  it('caps the automatic selection and reports the overflow', () => {
    const files = Array.from({ length: MAX_SCAN_SELECTION + 25 }, (_value, index) =>
      scriptFile(`s-${index}`)
    )
    const items = files.map((file) => script(file.id))
    const pre = buildScanPreSelection(
      session('scan_many', items, [set('huge', files)])
    )

    expect(pre.itemIds).toHaveLength(MAX_SCAN_SELECTION)
    expect(pre.total).toBe(MAX_SCAN_SELECTION + 25)
    expect(pre.overLimit).toBe(true)
  })

  it('returns the highest-scoring set for one video', () => {
    const sets = [
      set('likely', [scriptFile('l')], {
        matchedVideoItemId: 'v',
        matchBucket: 'likely'
      }),
      set('strong', [scriptFile('s')], {
        matchedVideoItemId: 'v',
        matchBucket: 'strong'
      }),
      set('none', [scriptFile('n')], {
        matchedVideoItemId: 'v',
        matchBucket: 'none'
      })
    ]
    expect(bestScriptSetForVideo('v', sets)?.id).toBe('set:strong')
  })
})

describe('bulk download payload', () => {
  it('validates one strict nested selection per session', () => {
    const parsed = parseScanQueueSelectionsInput({
      selections: [
        {
          sessionId: 'scan_a',
          itemIds: ['item_a', 'script_a'],
          videoOptions: [{ itemId: 'item_a', optionId: 'opt_a' }],
          pairings: [
            {
              videoItemId: 'item_a',
              setId: 'set:a',
              scriptItemIds: ['script_a'],
              primaryVariant: null,
              rename: true
            }
          ]
        }
      ]
    })
    expect(parsed.selections).toHaveLength(1)
    expect(() =>
      parseScanQueueSelectionsInput({
        selections: [
          { sessionId: 'scan_a', itemIds: ['item_a'] },
          { sessionId: 'scan_a', itemIds: ['item_b'] }
        ]
      })
    ).toThrow(/duplicate/i)
    expect(() =>
      parseScanQueueSelectionsInput({
        selections: [{ sessionId: 'scan_a', itemIds: ['item_a'], extra: 1 }]
      } as never)
    ).toThrow(/unsupported fields/i)
  })

  it('keeps every pairing inside its own topic', () => {
    const videoA = item({ id: 'a-video', name: 'Topic A video' })
    const videoB = item({ id: 'b-video', name: 'Topic B video' })
    const topicA = session(
      'scan_a',
      [videoA, script('a-main')],
      [set('a', [scriptFile('a-main')], { matchedVideoItemId: 'a-video' })]
    )
    const topicB = session(
      'scan_b',
      [videoB, script('b-main')],
      [set('b', [scriptFile('b-main')], { matchedVideoItemId: 'b-video' })]
    )

    const payload = buildScanBulkSelection([topicA, topicB], {
      selectedItemIds: new Set([
        'a-video',
        'a-main',
        'b-video',
        'b-main'
      ])
    })

    expect(payload).toHaveLength(2)
    expect(bulkSelectionItemCount(payload)).toBe(4)
    const bySession = new Map(payload.map((entry) => [entry.sessionId, entry]))
    expect(bySession.get('scan_a')?.pairings).toEqual([
      {
        videoItemId: 'a-video',
        setId: 'set:a',
        scriptItemIds: ['a-main'],
        primaryVariant: null,
        rename: true
      }
    ])
    expect(bySession.get('scan_b')?.pairings).toEqual([
      {
        videoItemId: 'b-video',
        setId: 'set:b',
        scriptItemIds: ['b-main'],
        primaryVariant: null,
        rename: true
      }
    ])
    // No script crosses into the other topic.
    expect(bySession.get('scan_a')?.pairings[0]?.scriptItemIds).not.toContain(
      'b-main'
    )
    expect(bySession.get('scan_b')?.pairings[0]?.scriptItemIds).not.toContain(
      'a-main'
    )
  })

  it('honours explicit quality/set/file choices and never pairs across topics', () => {
    const videoA = item({
      id: 'a-video',
      name: 'Topic A video',
      formats: [
        {
          optionId: '720-a',
          kind: 'video',
          label: '720p MP4',
          container: 'mp4',
          width: 1280,
          height: 720,
          sizeBytes: null,
          sizeIsEstimate: false,
          outputFormats: ['auto']
        }
      ],
      bestOptionId: '720-a'
    })
    const topicA = session(
      'scan_a',
      [videoA, script('a-main')],
      [
        set('a', [scriptFile('a-main')], {
          matchedVideoItemId: 'a-video',
          variants: ['alt']
        })
      ]
    )
    const topicB = session('scan_b', [script('b-main')], [])

    const payload = buildScanBulkSelection([topicA, topicB], {
      // The B script is ticked, but its video is not, so it must not pair.
      selectedItemIds: new Set(['a-video', 'a-main', 'b-main']),
      videoOptionIds: { 'a-video': '720-a' },
      setChoiceByVideo: { 'a-video': 'set:a' },
      scriptFileIdsBySet: { 'set:a': ['a-main'] },
      primaryVariantBySet: { 'set:a': 'alt' },
      renameBySet: { 'set:a': false }
    })

    expect(payload.map((entry) => entry.sessionId)).toEqual([
      'scan_a',
      'scan_b'
    ])
    expect(payload[0]?.videoOptions).toEqual([
      { itemId: 'a-video', optionId: '720-a' }
    ])
    expect(payload[0]?.pairings[0]).toMatchObject({
      videoItemId: 'a-video',
      setId: 'set:a',
      scriptItemIds: ['a-main'],
      primaryVariant: 'alt',
      rename: false
    })
    expect(payload[1]?.pairings).toEqual([])
    // A ticked script without a video in its topic stays standalone.
    expect(payload[1]?.itemIds).toEqual(['b-main'])
  })
})
