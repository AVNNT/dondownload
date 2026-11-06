import { describe, expect, it } from 'vitest'
import {
  MAX_SCAN_URLS,
  parseScanStartManyInput,
  parseScanUrlList
} from '../src/shared/scanner'
import {
  MAX_ACTIVE_SCANS,
  ScanSessionManager,
  type ScanPageFetcher
} from '../src/main/scanner/session'

const LINKS = Array.from(
  { length: MAX_SCAN_URLS + 3 },
  (_value, index) => `https://forum.example/t/topic-${index}/${1000 + index}`
)

function emptyPage(url: string) {
  return {
    finalUrl: url,
    status: 200,
    contentType: 'text/html',
    contentDisposition: null,
    body: '<html><body><p>No links here.</p></body></html>',
    bytes: 48
  }
}

describe('scan URL list parsing', () => {
  it('parses one URL per line, deduplicates and limits to MAX_SCAN_URLS', () => {
    const text = [
      LINKS[0],
      '',
      `  ${LINKS[1]}  `,
      // Same URL after normalization.
      LINKS[0]?.replace('https://', 'HTTPS://'),
      'not a url',
      ...LINKS.slice(2)
    ].join('\n')

    const parsed = parseScanUrlList(text)
    expect(parsed.urls).toHaveLength(MAX_SCAN_URLS)
    expect(new Set(parsed.urls).size).toBe(parsed.urls.length)
    expect(parsed.duplicates).toBe(1)
    expect(parsed.invalid).toEqual(['not a url'])
    expect(parsed.overLimit).toBe(3)
    expect(MAX_SCAN_URLS).toBe(10)
  })

  it('validates multi-start IPC input with exact keys', () => {
    expect(parseScanStartManyInput({ urls: LINKS.slice(0, 2) })).toEqual({
      urls: LINKS.slice(0, 2)
    })
    expect(() => parseScanStartManyInput({ urls: [] })).toThrow()
    expect(() =>
      parseScanStartManyInput({ urls: LINKS.slice(0, MAX_SCAN_URLS + 1) })
    ).toThrow()
    expect(() =>
      parseScanStartManyInput({
        urls: [LINKS[0]],
        extra: true
      } as never)
    ).toThrow(/unsupported fields/i)
  })
})

describe('multi-topic scan sessions', () => {
  it('queues topics beyond MAX_ACTIVE_SCANS and keeps at most two running', async () => {
    let active = 0
    let maximum = 0
    const fetcher: ScanPageFetcher = async (input) => {
      active += 1
      maximum = Math.max(maximum, active)
      await new Promise((resolve) => setTimeout(resolve, 15))
      active -= 1
      return emptyPage(input.url)
    }
    const updates: string[] = []
    const sessions = new ScanSessionManager({
      fetchPage: fetcher,
      onUpdate: (session) => updates.push(session.sessionId)
    })

    const urls = LINKS.slice(0, 4)
    const started = sessions.startMany(urls)
    expect(started).toHaveLength(4)
    expect(started[0]?.status).toBe('scanning')
    expect(started[1]?.status).toBe('scanning')
    // The third and fourth are real sessions waiting for a slot.
    expect(started[2]?.message).toMatch(/waiting/i)
    expect(started[2]?.progress.fetchedPages).toBe(0)
    expect(started[3]?.progress.fetchedPages).toBe(0)

    await Promise.all(
      started.map((session) => sessions.waitForScan(session.sessionId))
    )
    for (const session of started) {
      expect(sessions.getSession(session.sessionId).status).toBe('done')
    }
    expect(maximum).toBeLessThanOrEqual(MAX_ACTIVE_SCANS)
    expect(updates.length).toBeGreaterThan(0)
  })
})
