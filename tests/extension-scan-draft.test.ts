import { describe, expect, it } from 'vitest'
import {
  MAX_SCAN_DRAFT_LENGTH,
  SCAN_DRAFT_KEY,
  appendScanTabUrl,
  clearScanDraft,
  readScanDraft,
  saveScanDraft
} from '../extension/scan-draft.js'

function area() {
  const data: Record<string, unknown> = {}
  return {
    data,
    get: async (key: string) => (key in data ? { [key]: data[key] } : {}),
    set: async (items: Record<string, unknown>) => {
      Object.assign(data, items)
    },
    remove: async (key: string) => {
      delete data[key]
    }
  }
}

function chromeMock() {
  const session = area()
  return {
    session,
    api: { storage: { session } }
  }
}

const PAGE = 'https://forum.example/t/topic/1'

describe('scan links draft storage', () => {
  it('saves and restores the raw textarea text', async () => {
    const mock = chromeMock()
    const draft = `${PAGE}\nhttps://forum.example/t/topic/2`
    expect(await saveScanDraft(mock.api, draft)).toBe(true)
    expect(mock.session.data[SCAN_DRAFT_KEY]).toBe(draft)
    expect(await readScanDraft(mock.api)).toBe(draft)
  })

  it('caps the stored text at the maximum length', async () => {
    const mock = chromeMock()
    const long = 'x'.repeat(MAX_SCAN_DRAFT_LENGTH + 500)
    expect(await saveScanDraft(mock.api, long)).toBe(true)
    const stored = mock.session.data[SCAN_DRAFT_KEY] as string
    expect(stored).toHaveLength(MAX_SCAN_DRAFT_LENGTH)
    expect(await readScanDraft(mock.api)).toHaveLength(MAX_SCAN_DRAFT_LENGTH)
  })

  it('treats an empty save as a removal', async () => {
    const mock = chromeMock()
    await saveScanDraft(mock.api, PAGE)
    expect(await saveScanDraft(mock.api, '')).toBe(true)
    expect(SCAN_DRAFT_KEY in mock.session.data).toBe(false)
    expect(await readScanDraft(mock.api)).toBe('')
  })

  it('clears the draft', async () => {
    const mock = chromeMock()
    await saveScanDraft(mock.api, PAGE)
    expect(await clearScanDraft(mock.api)).toBe(true)
    expect(await readScanDraft(mock.api)).toBe('')
  })

  it('degrades to no persistence when storage.session is missing', async () => {
    const api = { storage: {} }
    expect(await readScanDraft(api)).toBe('')
    expect(await saveScanDraft(api, PAGE)).toBe(false)
    expect(await clearScanDraft(api)).toBe(false)
    expect(await readScanDraft(undefined)).toBe('')
  })

  it('does not throw when the storage call rejects', async () => {
    const api = {
      storage: {
        session: {
          get: async () => {
            throw new Error('unavailable')
          },
          set: async () => {
            throw new Error('unavailable')
          },
          remove: async () => {
            throw new Error('unavailable')
          }
        }
      }
    }
    expect(await readScanDraft(api)).toBe('')
    expect(await saveScanDraft(api, PAGE)).toBe(false)
    expect(await clearScanDraft(api)).toBe(false)
  })
})

describe('append the active tab to the scan list', () => {
  it('appends a supported URL on its own line', () => {
    expect(appendScanTabUrl('', PAGE)).toEqual({
      text: PAGE,
      added: true,
      reason: 'added'
    })
    expect(appendScanTabUrl(`${PAGE}\n`, 'https://forum.example/t/topic/2')).toEqual({
      text: `${PAGE}\nhttps://forum.example/t/topic/2`,
      added: true,
      reason: 'added'
    })
  })

  it('rejects unsupported URLs and leaves the list untouched', () => {
    for (const unsupported of [
      'ftp://files.example/a',
      'javascript:alert(1)',
      'not a url',
      '',
      42
    ]) {
      expect(appendScanTabUrl(PAGE, unsupported)).toEqual({
        text: PAGE,
        added: false,
        reason: 'unsupported'
      })
    }
  })

  it('ignores a URL that is already in the list', () => {
    // The same URL after normalization (scheme case and fragment).
    const existing = `${PAGE}\nhttps://forum.example/t/topic/2`
    expect(
      appendScanTabUrl(existing, `${PAGE.replace('https://', 'HTTPS://')}#comment`)
    ).toEqual({ text: existing, added: false, reason: 'duplicate' })
  })

  it('stops at the 10-link cap', () => {
    const urls = Array.from(
      { length: 10 },
      (_value, index) => `https://forum.example/t/topic-${index}`
    )
    const existing = urls.join('\n')
    expect(appendScanTabUrl(existing, 'https://forum.example/t/one-more')).toEqual({
      text: existing,
      added: false,
      reason: 'limit'
    })
  })

  it('respects a smaller maximum when asked', () => {
    expect(appendScanTabUrl(PAGE, 'https://forum.example/t/topic/2', 1)).toEqual({
      text: PAGE,
      added: false,
      reason: 'limit'
    })
  })
})
