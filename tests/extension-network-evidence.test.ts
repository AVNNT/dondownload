import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import {
  MAX_EVIDENCE_PER_DOCUMENT,
  createNetworkEvidenceStore,
  evaluateResponseEvidence,
  evidenceForMessage,
  normalizeEvidenceUrl,
  type NetworkEvidence
} from '../extension/network-evidence'

interface CoreApi {
  evaluatePlaybackSource: (input: Record<string, unknown>) => Record<string, unknown>
  applyNetworkEvidence: (
    candidate: Record<string, unknown>,
    evidence: Partial<NetworkEvidence>
  ) => Record<string, unknown> | null
  addCapturedSource: (
    sources: Array<Record<string, unknown>>,
    candidate: Record<string, unknown>
  ) => Array<Record<string, unknown>>
}

const coreSource = readFileSync(
  path.join(process.cwd(), 'extension', 'overlay-core.js'),
  'utf8'
)

function loadCore(): CoreApi {
  return vm.runInNewContext(
    `${coreSource}\n;globalThis.DonDownloadOverlayCore`,
    { URL }
  ) as CoreApi
}

const core = loadCore()
const EXACT_URL = 'https://cdn.example/video/stream?id=1#t=2'

function response(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    url: EXACT_URL,
    statusCode: 206,
    method: 'GET',
    tabId: 7,
    frameId: 0,
    type: 'media',
    contentType: 'video/mp4; codecs="avc1"',
    contentRange: 'bytes 0-0/123456',
    contentLength: '1',
    contentEncoding: null,
    ...overrides
  }
}

describe('optional playback response evidence', () => {
  it('maps one exact complete-file response to the exact player, uses a trustworthy size, dedupes, and clears on navigation', () => {
    const observedAt = Date.now()
    const result = evaluateResponseEvidence(response(), observedAt)
    expect(result.ok).toBe(true)
    if (result.ok !== true) return

    const evidence = evidenceForMessage(result.evidence)
    expect(evidence).toMatchObject({
      url: 'https://cdn.example/video/stream?id=1',
      contentType: 'video/mp4',
      container: 'mp4',
      totalBytes: 123456,
      completeFile: true
    })
    if (evidence === null) return

    const candidate = core.evaluatePlaybackSource({
      currentSrc: EXACT_URL,
      paused: false,
      readyState: 4,
      ended: false,
      error: null,
      videoWidth: 1920,
      videoHeight: 1080
    })
    expect(candidate.kind).toBe('needs-evidence')

    // A different URL never applies, even if it is the only player.
    expect(core.applyNetworkEvidence(candidate, { ...evidence, url: 'https://cdn.example/other' })).toBeNull()

    const source = core.applyNetworkEvidence(candidate, evidence)
    expect(source).toMatchObject({
      kind: 'verified',
      url: 'https://cdn.example/video/stream?id=1',
      container: 'mp4',
      sizeBytes: 123456,
      qualityLabel: '1080p'
    })
    if (source === null) return

    const once = core.addCapturedSource([], source)
    const deduped = core.addCapturedSource(once, source)
    expect(deduped).toHaveLength(1)
    expect(deduped[0]).toMatchObject({ sizeBytes: 123456, current: true })
    let accumulated: Array<Record<string, unknown>> = []
    for (let index = 0; index < 8; index += 1) {
      accumulated = core.addCapturedSource(accumulated, {
        kind: 'verified',
        url: `https://cdn.example/quality-${index}.mp4`,
        filename: `quality-${index}.mp4`,
        container: 'mp4',
        width: 1920,
        height: 1080,
        qualityLabel: '1080p'
      })
    }
    expect(accumulated).toHaveLength(8)

    // Evidence is keyed by tab/frame/document and exact URL. Another document
    // and a top-frame navigation clear it; the same URL is never inferred.
    const store = createNetworkEvidenceStore({ now: () => observedAt })
    const identity = { tabId: 7, frameId: 0, documentId: 'document-a' }
    expect(store.record(response(), identity)).not.toBeNull()
    expect(
      store.get(identity, 'https://cdn.example/video/stream?id=1')
    ).not.toBeNull()
    expect(
      store.get(
        { tabId: 7, frameId: 0, documentId: 'document-b' },
        'https://cdn.example/video/stream?id=1'
      )
    ).toBeNull()
    expect(
      store.get(identity, 'https://cdn.example/video/stream?id=2')
    ).toBeNull()

    for (let index = 0; index < MAX_EVIDENCE_PER_DOCUMENT + 8; index += 1) {
      store.record(
        response({ url: `https://cdn.example/video/stream?id=${index}` }),
        identity
      )
    }
    expect(store.count()).toBe(1)
    expect(
      store.get(identity, 'https://cdn.example/video/stream?id=0')
    ).toBeNull()

    store.clearTab(7)
    expect(
      store.get(identity, 'https://cdn.example/video/stream?id=1')
    ).toBeNull()

    expect(normalizeEvidenceUrl('blob:https://example.com/abc')).toBeNull()
    expect(normalizeEvidenceUrl('https://cdn.example/video/stream#t=3')).toBe(
      'https://cdn.example/video/stream'
    )

    for (const rejected of [
      response({ type: 'xmlhttprequest' }),
      response({ contentType: 'application/vnd.apple.mpegurl' }),
      response({ url: 'https://cdn.example/live/index.m3u8' }),
      response({ url: 'https://cdn.example/seg/init.m4s' }),
      response({ contentRange: 'bytes 0-0/*' }),
      response({ contentRange: 'bytes 100-200/1000' }),
      response({ contentEncoding: 'gzip' }),
      response({ statusCode: 404 }),
      response({ url: 'https://cdn.example/stream.php' })
    ]) {
      expect(evaluateResponseEvidence(rejected).ok).toBe(false)
    }
  })
})
