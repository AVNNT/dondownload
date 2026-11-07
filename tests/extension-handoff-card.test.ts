import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  HANDOFF_CARD_MESSAGE_TYPES,
  HANDOFF_CARD_POLL_MS,
  MAX_HANDED_OFF_DOWNLOAD_IDS,
  forgetHandedOffDownloadsForTests,
  handoffCardInjected,
  handoffCardPayload,
  handleHandoffCardMessage,
  hasHandedOffDownload,
  injectHandoffCard,
  rememberHandedOffDownload,
  showHandoffCard
} from '../extension/handoff-card.js'

const DOWNLOAD_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
const OTHER_ID = '0f8fad5b-d9cb-469f-a165-70867728950e'
const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop'

interface FakeNode {
  tagName: string
  id: string
  className: string
  textContent: string
  title: string
  style: Record<string, string>
  parentNode: FakeNode | null
  childNodes: FakeNode[]
  firstChild: FakeNode | null
  readonly isConnected: boolean
  attributes: Record<string, string>
  listeners: Record<string, Array<() => void>>
  appendChild(child: FakeNode): FakeNode
  insertBefore(child: FakeNode, reference: FakeNode | null): FakeNode
  removeChild(child: FakeNode): FakeNode
  setAttribute(name: string, value: string): void
  addEventListener(type: string, listener: () => void): void
  attachShadow(init: { mode: string }): FakeNode
}

function createNode(tagName: string): FakeNode {
  const node: FakeNode = {
    tagName,
    id: '',
    className: '',
    textContent: '',
    title: '',
    style: {},
    parentNode: null,
    childNodes: [],
    attributes: {},
    listeners: {},
    get firstChild(): FakeNode | null {
      return node.childNodes[0] ?? null
    },
    get isConnected(): boolean {
      let current: FakeNode | null = node
      while (current !== null) {
        if (current === documentElement) return true
        current = current.parentNode
      }
      return false
    },
    appendChild(child: FakeNode): FakeNode {
      child.parentNode = node
      node.childNodes.push(child)
      return child
    },
    insertBefore(child: FakeNode, reference: FakeNode | null): FakeNode {
      child.parentNode = node
      const index = reference === null ? -1 : node.childNodes.indexOf(reference)
      if (index < 0) node.childNodes.unshift(child)
      else node.childNodes.splice(index, 0, child)
      return child
    },
    removeChild(child: FakeNode): FakeNode {
      const index = node.childNodes.indexOf(child)
      if (index >= 0) node.childNodes.splice(index, 1)
      child.parentNode = null
      return child
    },
    setAttribute(name: string, value: string): void {
      node.attributes[name] = value
    },
    addEventListener(type: string, listener: () => void): void {
      node.listeners[type] = [...(node.listeners[type] ?? []), listener]
    },
    attachShadow(): FakeNode {
      const shadow = createNode('#shadow-root')
      shadow.parentNode = node
      node.childNodes.push(shadow)
      return shadow
    }
  }
  return node
}

let documentElement: FakeNode

function createFakeDocument(): FakeNode {
  documentElement = createNode('html')
  const doc = {
    documentElement,
    hidden: false,
    listeners: {} as Record<string, Array<() => void>>,
    createElement: (tagName: string): FakeNode => createNode(tagName),
    addEventListener(type: string, listener: () => void) {
      doc.listeners[type] = [...(doc.listeners[type] ?? []), listener]
    },
    removeEventListener(type: string, listener: () => void) {
      doc.listeners[type] = (doc.listeners[type] ?? []).filter(
        (entry) => entry !== listener
      )
    },
    dispatch(type: string) {
      for (const listener of doc.listeners[type] ?? []) listener()
    }
  }
  ;(globalThis as any).document = doc
  return documentElement
}

function hasClass(node: FakeNode, className: string): boolean {
  return node.className.split(/\s+/).includes(className)
}

function find(node: FakeNode, className: string): FakeNode | null {
  if (hasClass(node, className)) return node
  for (const child of node.childNodes) {
    const found = find(child, className)
    if (found !== null) return found
  }
  return null
}

function findAll(node: FakeNode, className: string): FakeNode[] {
  const found: FakeNode[] = []
  if (hasClass(node, className)) found.push(node)
  for (const child of node.childNodes) found.push(...findAll(child, className))
  return found
}

function click(node: FakeNode): void {
  for (const listener of node.listeners.click ?? []) listener()
}

interface FakeChrome {
  chrome: any
  statusMessages: unknown[]
  showMessages: unknown[]
  nativeMessages: unknown[]
  response: unknown
  nativeResponse: unknown
}

function installFakeChrome(): FakeChrome {
  const fake: FakeChrome = {
    chrome: null,
    statusMessages: [],
    showMessages: [],
    nativeMessages: [],
    response: {
      ok: true,
      status: 'running',
      completedBytes: 1_200_000,
      totalBytes: 2_600_000,
      filename: 'report.zip'
    },
    nativeResponse: {
      ok: true,
      status: 'running',
      completedBytes: 1_200_000,
      totalBytes: 2_600_000,
      filename: 'report.zip'
    }
  }

  fake.chrome = {
    runtime: {
      id: EXTENSION_ID,
      lastError: undefined,
      sendMessage(message: any, callback?: (value: unknown) => void) {
        if (message && message.type === HANDOFF_CARD_MESSAGE_TYPES.SHOW) {
          fake.showMessages.push(message)
        } else {
          fake.statusMessages.push(message)
        }
        if (typeof callback === 'function') callback(fake.response)
      },
      sendNativeMessage(
        host: string,
        message: unknown,
        callback: (value: unknown) => void
      ) {
        fake.nativeMessages.push({ host, message })
        callback(fake.nativeResponse)
      }
    }
  }
  ;(globalThis as any).chrome = fake.chrome
  return fake
}

beforeEach(() => {
  vi.useFakeTimers()
  delete (globalThis as any).__donDownloadHandoffCards
  forgetHandedOffDownloadsForTests()
  createFakeDocument()
})

afterEach(() => {
  vi.useRealTimers()
  delete (globalThis as any).__donDownloadHandoffCards
  delete (globalThis as any).document
  delete (globalThis as any).chrome
  forgetHandedOffDownloadsForTests()
})

function card(): FakeNode | null {
  return find(documentElement, 'card')
}

describe('in-page hand-off card', () => {
  it('shows the file name and live progress, then hides itself when done', () => {
    const fake = installFakeChrome()
    expect(
      handoffCardInjected({ downloadId: DOWNLOAD_ID, filename: 'report.zip' })
    ).toBe(true)

    expect(find(documentElement, 'brand')?.textContent).toBe('DonDownload')
    expect(find(documentElement, 'title')?.textContent).toBe(
      'DonDownload is downloading'
    )
    expect(find(documentElement, 'name')?.textContent).toBe('report.zip')
    expect(find(documentElement, 'meta')?.textContent).toBe(
      '46% \u00b7 1.2 MB of 2.6 MB'
    )
    expect(fake.statusMessages).toEqual([
      { type: HANDOFF_CARD_MESSAGE_TYPES.STATUS, downloadId: DOWNLOAD_ID }
    ])

    // The card polls every two seconds while it is visible.
    vi.advanceTimersByTime(HANDOFF_CARD_POLL_MS)
    expect(fake.statusMessages).toHaveLength(2)

    fake.response = {
      ok: true,
      status: 'done',
      completedBytes: 2_600_000,
      totalBytes: 2_600_000,
      filename: 'report.zip'
    }
    vi.advanceTimersByTime(HANDOFF_CARD_POLL_MS)
    expect(find(documentElement, 'title')?.textContent).toBe('Downloaded')
    expect(find(documentElement, 'fill')?.className).toBe('fill done')
    expect(find(documentElement, 'fill')?.style.width).toBe('100%')

    // Polling stopped, and the card removes itself after six seconds.
    const sent = fake.statusMessages.length
    vi.advanceTimersByTime(5_000)
    expect(fake.statusMessages).toHaveLength(sent)
    expect(card()).not.toBeNull()
    vi.advanceTimersByTime(1_000)
    expect(card()).toBeNull()
  })

  it('pauses polling while the page is hidden and resumes when it is visible', () => {
    const fake = installFakeChrome()
    handoffCardInjected({ downloadId: DOWNLOAD_ID, filename: 'report.zip' })
    expect(fake.statusMessages).toHaveLength(1)

    const doc = (globalThis as any).document
    doc.hidden = true
    doc.dispatch('visibilitychange')
    vi.advanceTimersByTime(HANDOFF_CARD_POLL_MS * 3)
    expect(fake.statusMessages).toHaveLength(1)

    doc.hidden = false
    doc.dispatch('visibilitychange')
    expect(fake.statusMessages).toHaveLength(2)
    vi.advanceTimersByTime(HANDOFF_CARD_POLL_MS)
    expect(fake.statusMessages).toHaveLength(3)
  })

  it('says Starting… while the size is unknown', () => {
    const fake = installFakeChrome()
    fake.response = {
      ok: true,
      status: 'queued',
      completedBytes: 0,
      totalBytes: 0,
      filename: 'report.zip'
    }
    handoffCardInjected({ downloadId: DOWNLOAD_ID, filename: 'report.zip' })
    expect(find(documentElement, 'meta')?.textContent).toBe('Starting\u2026')
    expect(find(documentElement, 'fill')?.style.width).toBe('0%')
  })

  it('keeps a failed download on screen with a short safe message', () => {
    const fake = installFakeChrome()
    handoffCardInjected({ downloadId: DOWNLOAD_ID, filename: 'report.zip' })
    fake.response = {
      ok: true,
      status: 'error',
      completedBytes: 0,
      totalBytes: 2_600_000,
      filename: 'report.zip',
      errorMessage: 'Disk full'
    }
    vi.advanceTimersByTime(HANDOFF_CARD_POLL_MS)
    expect(find(documentElement, 'title')?.textContent).toBe('Download failed')
    expect(find(documentElement, 'meta')?.textContent).toBe('Disk full')
    const sent = fake.statusMessages.length
    vi.advanceTimersByTime(10 * 60 * 1_000)
    expect(fake.statusMessages).toHaveLength(sent)
    expect(card()).not.toBeNull()
  })

  it('stops polling after three consecutive bridge failures', () => {
    const fake = installFakeChrome()
    fake.response = {
      ok: false,
      error: { code: 'APP_NOT_RUNNING', message: 'DonDownload is not running.' }
    }
    handoffCardInjected({ downloadId: DOWNLOAD_ID, filename: 'report.zip' })
    vi.advanceTimersByTime(HANDOFF_CARD_POLL_MS)
    vi.advanceTimersByTime(HANDOFF_CARD_POLL_MS)
    expect(find(documentElement, 'meta')?.textContent).toBe(
      'Open DonDownload to see progress'
    )
    const sent = fake.statusMessages.length
    vi.advanceTimersByTime(10_000)
    expect(fake.statusMessages).toHaveLength(sent)
    expect(card()).not.toBeNull()
  })

  it('stacks at most three cards with the newest on top', () => {
    installFakeChrome()
    for (const name of ['one.zip', 'two.zip', 'three.zip', 'four.zip']) {
      handoffCardInjected({ downloadId: DOWNLOAD_ID, filename: name })
    }
    const cards = findAll(documentElement, 'card')
    expect(cards).toHaveLength(3)
    const stack = find(documentElement, 'stack')
    expect(stack?.childNodes.map((node) => node.className)).toEqual([
      'card',
      'card',
      'card'
    ])
    expect(find(cards[0]!, 'name')?.textContent).toBe('four.zip')
    expect(find(cards[2]!, 'name')?.textContent).toBe('two.zip')
  })

  it('closes on × and asks the desktop to show the row on Show', () => {
    const fake = installFakeChrome()
    handoffCardInjected({ downloadId: DOWNLOAD_ID, filename: 'report.zip' })
    click(find(documentElement, 'primary')!)
    expect(fake.showMessages).toEqual([
      { type: HANDOFF_CARD_MESSAGE_TYPES.SHOW, downloadId: DOWNLOAD_ID }
    ])
    click(find(documentElement, 'close')!)
    expect(card()).toBeNull()
  })

  it('refuses a payload without a download id', () => {
    installFakeChrome()
    expect(handoffCardInjected({})).toBe(false)
    expect(handoffCardInjected(null)).toBe(false)
    expect(card()).toBeNull()
  })
})

describe('hand-off card injection', () => {
  it('injects into the active tab of the last-focused window', async () => {
    const calls: unknown[] = []
    const chrome: any = {
      tabs: {
        async query(query: unknown) {
          expect(query).toEqual({ active: true, lastFocusedWindow: true })
          return [{ id: 7 }]
        }
      },
      scripting: {
        async executeScript(options: unknown) {
          calls.push(options)
          return []
        }
      }
    }
    const payload = handoffCardPayload(
      { downloadId: DOWNLOAD_ID, persistedAt: 1_800_000_000_000 },
      'C:\\Downloads\\report.zip'
    )
    expect(payload).toEqual({ downloadId: DOWNLOAD_ID, filename: 'report.zip' })
    expect(
      await showHandoffCard(
        chrome,
        { handoffNotifications: true },
        { filename: 'C:\\Downloads\\report.zip' },
        { downloadId: DOWNLOAD_ID, persistedAt: 1_800_000_000_000 }
      )
    ).toBe(true)
    expect(calls).toEqual([
      {
        target: { tabId: 7, allFrames: false },
        func: handoffCardInjected,
        args: [payload],
        world: 'ISOLATED'
      }
    ])
  })

  it('falls back silently when injection is impossible', async () => {
    const failing: any = {
      tabs: { async query() { return [{ id: 7 }] } },
      scripting: {
        async executeScript() {
          throw new Error('Cannot access a chrome:// URL')
        }
      }
    }
    expect(
      await showHandoffCard(
        failing,
        { handoffNotifications: true },
        { filename: 'report.zip' },
        { downloadId: DOWNLOAD_ID, persistedAt: 1 }
      )
    ).toBe(false)

    // No tabs/scripting API at all, a closed tab, and a malformed receipt all
    // resolve false instead of throwing into the hand-off path.
    expect(
      await showHandoffCard(
        {},
        { handoffNotifications: true },
        { filename: 'report.zip' },
        { downloadId: DOWNLOAD_ID, persistedAt: 1 }
      )
    ).toBe(false)
    expect(await injectHandoffCard({}, 7, { downloadId: DOWNLOAD_ID, filename: '' })).toBe(false)
    expect(
      await injectHandoffCard(failing, -1, { downloadId: DOWNLOAD_ID, filename: '' })
    ).toBe(false)
    expect(handoffCardPayload({ downloadId: 'nope' }, 'report.zip')).toBeNull()
    expect(handoffCardPayload(null, 'report.zip')).toBeNull()
  })

  it('does nothing at all when hand-off notifications are off', async () => {
    const calls: unknown[] = []
    const chrome: any = {
      tabs: { async query() { return [{ id: 7 }] } },
      scripting: { async executeScript(options: unknown) { calls.push(options) } }
    }
    expect(
      await showHandoffCard(
        chrome,
        { handoffNotifications: false },
        { filename: 'report.zip' },
        { downloadId: DOWNLOAD_ID, persistedAt: 1 }
      )
    ).toBe(false)
    expect(calls).toEqual([])
  })
})

describe('service worker card messages', () => {
  it('only answers its own content scripts about ids it handed off', async () => {
    const fake = installFakeChrome()
    const own = { id: EXTENSION_ID, tab: { id: 3 } }
    const message = {
      type: HANDOFF_CARD_MESSAGE_TYPES.STATUS,
      downloadId: DOWNLOAD_ID
    }

    // Before the id is remembered, nothing is answered.
    await expect(
      handleHandoffCardMessage(fake.chrome, message, own)
    ).resolves.toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    expect(fake.nativeMessages).toEqual([])

    expect(rememberHandedOffDownload(DOWNLOAD_ID)).toBe(true)
    expect(hasHandedOffDownload(DOWNLOAD_ID)).toBe(true)
    await expect(
      handleHandoffCardMessage(fake.chrome, message, own)
    ).resolves.toMatchObject({
      ok: true,
      status: 'running',
      completedBytes: 1_200_000,
      totalBytes: 2_600_000,
      filename: 'report.zip'
    })
    expect(fake.nativeMessages).toEqual([
      {
        host: 'com.dondownload.bridge',
        message: { type: 'download-status', downloadId: DOWNLOAD_ID }
      }
    ])

    // A foreign sender, a missing sender and a page-supplied id are rejected.
    await expect(
      handleHandoffCardMessage(fake.chrome, message, { id: 'other-extension' })
    ).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_SENDER' } })
    await expect(
      handleHandoffCardMessage(fake.chrome, message, null)
    ).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_SENDER' } })
    await expect(
      handleHandoffCardMessage(
        fake.chrome,
        { ...message, downloadId: OTHER_ID },
        own
      )
    ).resolves.toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    await expect(
      handleHandoffCardMessage(
        fake.chrome,
        { ...message, downloadId: 'not-a-uuid' },
        own
      )
    ).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_MESSAGE' } })
    expect(fake.nativeMessages).toHaveLength(1)

    // A message this worker does not own is not handled at all.
    await expect(
      handleHandoffCardMessage(fake.chrome, { type: 'other' }, own)
    ).resolves.toBeNull()
  })

  it('forwards a Show request for a remembered download only', async () => {
    const fake = installFakeChrome()
    fake.nativeResponse = { ok: true, shown: true }
    const own = { id: EXTENSION_ID, tab: { id: 3 } }
    rememberHandedOffDownload(DOWNLOAD_ID)

    await expect(
      handleHandoffCardMessage(
        fake.chrome,
        { type: HANDOFF_CARD_MESSAGE_TYPES.SHOW, downloadId: DOWNLOAD_ID },
        own
      )
    ).resolves.toEqual({ ok: true })
    expect(fake.nativeMessages).toEqual([
      {
        host: 'com.dondownload.bridge',
        message: { type: 'show-download', downloadId: DOWNLOAD_ID }
      }
    ])

    await expect(
      handleHandoffCardMessage(
        fake.chrome,
        { type: HANDOFF_CARD_MESSAGE_TYPES.SHOW, downloadId: OTHER_ID },
        own
      )
    ).resolves.toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  })

  it('keeps the session id set bounded and memory-only', () => {
    for (let index = 0; index < MAX_HANDED_OFF_DOWNLOAD_IDS + 5; index += 1) {
      const id = `f47ac10b-58cc-4372-a567-${String(index).padStart(12, '0')}`
      expect(rememberHandedOffDownload(id)).toBe(true)
    }
    expect(hasHandedOffDownload('f47ac10b-58cc-4372-a567-000000000000')).toBe(
      false
    )
    expect(
      hasHandedOffDownload(
        `f47ac10b-58cc-4372-a567-${String(
          MAX_HANDED_OFF_DOWNLOAD_IDS + 4
        ).padStart(12, '0')}`
      )
    ).toBe(true)
    expect(rememberHandedOffDownload('not-a-uuid')).toBe(false)
    expect(rememberHandedOffDownload(42)).toBe(false)
  })
})
