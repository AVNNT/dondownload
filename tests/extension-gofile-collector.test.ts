import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

interface CollectedFile {
  name: string
  size: number | null
  url: string
}

interface CollectedFolder {
  url: string
  name: string | null
}

interface Rows {
  files: CollectedFile[]
  folders: CollectedFolder[]
}

interface ShareResult {
  shareId: string | null
  status: 'ok' | 'empty' | 'not-found' | 'password' | 'premium' | 'timeout'
  files: CollectedFile[]
  folders: number
}

interface CollectorApi {
  MAX_FILES: number
  MAX_DEPTH: number
  WAIT_MS: number
  RUN_KEY: string
  isGofileHost: (hostname: unknown) => boolean
  shareIdFromUrl: (raw: unknown) => string | null
  isDownloadUrl: (raw: unknown) => boolean
  fileNameFromUrl: (raw: unknown) => string | null
  parseSizeText: (text: unknown) => number | null
  readRows: (doc: unknown, shareId: unknown) => Rows
  shareState: (doc: unknown) => ShareResult['status']
  waitForRows: (
    doc: unknown,
    win: unknown,
    shareId: unknown,
    options?: Record<string, unknown>
  ) => Promise<Rows>
  collectShare: (
    doc: unknown,
    win: unknown,
    options?: Record<string, unknown>
  ) => Promise<ShareResult>
  startRun: (doc: unknown, win: unknown, options?: Record<string, unknown>) => boolean
}

const SOURCE = readFileSync(
  path.join(process.cwd(), 'extension', 'gofile-collector.js'),
  'utf8'
)

const sandbox: Record<string, unknown> = { URL, Promise }
const collector = vm.runInNewContext(
  `${SOURCE}\n;globalThis.DonDownloadGofileCollector`,
  sandbox
) as CollectorApi

/* ------------------------------ fake page ------------------------------ */

interface FakeElement {
  tag: string
  attrs: Record<string, string>
  children: FakeElement[]
  parentNode: FakeElement | null
  textContent: string
  getAttribute: (name: string) => string | null
  click: () => void
}

function element(
  tag: string,
  attrs: Record<string, string> = {},
  children: FakeElement[] = [],
  text = ''
): FakeElement {
  const node: FakeElement = {
    tag,
    attrs,
    children: [],
    parentNode: null,
    textContent: '',
    getAttribute(name: string) {
      return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name]! : null
    },
    click() {
      // A no-op: the tests that follow folders inject `clickFolder` instead.
    }
  }
  for (const child of children) {
    child.parentNode = node
    node.children.push(child)
  }
  Object.defineProperty(node, 'textContent', {
    get() {
      const parts = [text]
      for (const child of node.children) parts.push(child.textContent)
      return parts.filter((part) => part.length > 0).join(' ')
    }
  })
  return node
}

function anchor(href: string, text = '', rowText = ''): FakeElement {
  const link = element('a', { href }, [], text)
  if (rowText.length === 0) return link
  return element('div', {}, [link, element('span', {}, [], rowText)])
}

function walk(node: FakeElement, visit: (element: FakeElement) => void): void {
  visit(node)
  for (const child of node.children) walk(child, visit)
}

function makeDocument(body: FakeElement, url: string) {
  return {
    URL: url,
    baseURI: url,
    body,
    querySelectorAll(selector: string): FakeElement[] {
      if (selector !== 'a[href]') return []
      const found: FakeElement[] = []
      walk(body, (node) => {
        if (node.tag === 'a' && node.getAttribute('href') !== null) found.push(node)
      })
      return found
    },
    querySelector(selector: string): FakeElement | null {
      if (selector !== 'input[type="password"]' && selector !== 'input[type=password]') {
        return null
      }
      let found: FakeElement | null = null
      walk(body, (node) => {
        if (found === null && node.tag === 'input' && node.getAttribute('type') === 'password') {
          found = node
        }
      })
      return found
    }
  }
}

interface FakeObserverInstance {
  fire: () => void
  disconnected: boolean
}

function makeWindow(href: string, options: { observer?: boolean } = {}) {
  const instances: FakeObserverInstance[] = []
  class FakeMutationObserver {
    private readonly callback: () => void
    disconnected = false
    constructor(callback: () => void) {
      this.callback = callback
      instances.push(this)
    }
    observe(): void {
      // The test fires the observer explicitly.
    }
    disconnect(): void {
      this.disconnected = true
    }
    fire(): void {
      if (!this.disconnected) this.callback()
    }
  }
  const win: Record<string, unknown> = {
    location: { href },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval
  }
  if (options.observer === true) win.MutationObserver = FakeMutationObserver
  return { win, instances }
}

const SHARE_URL = 'https://gofile.io/d/AbCd1234'

function shareBody(rows: FakeElement[]): FakeElement {
  return element('div', {}, rows)
}

/* ------------------------------ pure helpers ------------------------------ */

describe('gofile collector URL and size helpers', () => {
  it('accepts only public share links', () => {
    expect(collector.shareIdFromUrl(SHARE_URL)).toBe('AbCd1234')
    expect(collector.shareIdFromUrl('https://www.gofile.io/d/AbCd1234/')).toBe(
      'AbCd1234'
    )
    expect(collector.shareIdFromUrl('https://gofile.io/f/AbCd1234')).toBeNull()
    // A folder link inside the same share still names that share.
    expect(collector.shareIdFromUrl('https://gofile.io/d/AbCd1234?folder=x')).toBe(
      'AbCd1234'
    )
    expect(collector.shareIdFromUrl('https://evil.example/d/AbCd1234')).toBeNull()
    expect(collector.shareIdFromUrl('http://gofile.io/d/AbCd1234')).toBeNull()
  })

  it('accepts only Gofile download links', () => {
    expect(
      collector.isDownloadUrl('https://store3.gofile.io/download/web/f1/Video.mp4')
    ).toBe(true)
    expect(
      collector.isDownloadUrl('https://gofile.io/download/web/f1/Video.mp4')
    ).toBe(true)
    // A foreign host, a lookalike domain, plain HTTP and a non-download path are
    // all rejected, so a spoofed row can never redirect the download.
    expect(
      collector.isDownloadUrl('https://evil.example/download/web/f1/Video.mp4')
    ).toBe(false)
    expect(
      collector.isDownloadUrl('https://gofile.io.evil.example/download/f1/a.mp4')
    ).toBe(false)
    expect(
      collector.isDownloadUrl('http://store3.gofile.io/download/web/f1/Video.mp4')
    ).toBe(false)
    expect(collector.isDownloadUrl('https://store3.gofile.io/api/f1/Video.mp4')).toBe(
      false
    )
  })

  it('reads the file name from the download path', () => {
    expect(
      collector.fileNameFromUrl(
        'https://store3.gofile.io/download/web/f1/My%20Video%20One.mp4'
      )
    ).toBe('My Video One.mp4')
  })

  it('parses the size text the page renders', () => {
    expect(collector.parseSizeText('1.4 GB')).toBe(Math.round(1.4 * 1024 ** 3))
    expect(collector.parseSizeText('12.5 MB')).toBe(Math.round(12.5 * 1024 ** 2))
    expect(collector.parseSizeText('900 KB')).toBe(900 * 1024)
    expect(collector.parseSizeText('no size here')).toBeNull()
  })
})

/* ------------------------------ DOM reading ------------------------------ */

describe('gofile collector DOM reading', () => {
  it('reads name, size and download href from the rendered rows', () => {
    const body = shareBody([
      anchor(
        'https://store3.gofile.io/download/web/f1/Fancam%2001.mp4',
        'Fancam 01.mp4',
        '1.4 GB'
      ),
      anchor(
        'https://store1.gofile.io/download/web/f2/Fancam%2001.funscript',
        'Fancam 01.funscript',
        '12.5 MB'
      )
    ])
    const doc = makeDocument(body, SHARE_URL)
    const rows = collector.readRows(doc, 'AbCd1234')

    expect(rows.files).toEqual([
      {
        name: 'Fancam 01.mp4',
        size: Math.round(1.4 * 1024 ** 3),
        url: 'https://store3.gofile.io/download/web/f1/Fancam%2001.mp4'
      },
      {
        name: 'Fancam 01.funscript',
        size: Math.round(12.5 * 1024 ** 2),
        url: 'https://store1.gofile.io/download/web/f2/Fancam%2001.funscript'
      }
    ])
  })

  it('ignores download links that are not on Gofile', () => {
    const body = shareBody([
      anchor('https://evil.example/download/web/f1/Video.mp4', 'Video.mp4', '1 MB'),
      anchor('https://store3.gofile.io/download/web/f2/Real.mp4', 'Real.mp4', '2 MB')
    ])
    const rows = collector.readRows(makeDocument(body, SHARE_URL), 'AbCd1234')
    expect(rows.files.map((file) => file.name)).toEqual(['Real.mp4'])
  })

  it('reports rendered subfolder links of the same share only', () => {
    const body = shareBody([
      anchor('https://store3.gofile.io/download/web/f2/Real.mp4', 'Real.mp4', '2 MB'),
      anchor('https://gofile.io/d/AbCd1234?folder=folder-1', 'Season 1'),
      anchor('https://gofile.io/d/Other999?folder=folder-2', 'Other share')
    ])
    const rows = collector.readRows(makeDocument(body, SHARE_URL), 'AbCd1234')
    expect(rows.folders).toEqual([
      { url: 'https://gofile.io/d/AbCd1234?folder=folder-1', name: 'Season 1' }
    ])
  })
})

/* ------------------------------ share state ------------------------------ */

describe('gofile collector share state', () => {
  it('reports a password protected share', () => {
    const body = element('div', {}, [element('input', { type: 'password' })], '')
    expect(collector.shareState(makeDocument(body, SHARE_URL))).toBe('password')
  })

  it('reports a premium-only share', () => {
    const body = element('div', {}, [], 'This content is available for premium users only.')
    expect(collector.shareState(makeDocument(body, SHARE_URL))).toBe('premium')
  })

  it('reports a share that no longer exists', () => {
    const body = element('div', {}, [], 'This share does not exist or has been removed.')
    expect(collector.shareState(makeDocument(body, SHARE_URL))).toBe('not-found')
  })

  it('reports an empty share', () => {
    const body = element('div', {}, [], 'Nothing here yet')
    expect(collector.shareState(makeDocument(body, SHARE_URL))).toBe('empty')
  })
})

/* ------------------------------ collection ------------------------------ */

describe('gofile collector collection', () => {
  it('collects an already rendered share', async () => {
    const body = shareBody([
      anchor('https://store3.gofile.io/download/web/f1/A.mp4', 'A.mp4', '1 MB')
    ])
    const doc = makeDocument(body, SHARE_URL)
    const { win } = makeWindow(SHARE_URL)
    const result = await collector.collectShare(doc, win, { waitMs: 200 })

    expect(result.shareId).toBe('AbCd1234')
    expect(result.status).toBe('ok')
    expect(result.files.map((file) => file.name)).toEqual(['A.mp4'])
  })

  it('waits for a slow render through the observer', async () => {
    const body = shareBody([])
    const doc = makeDocument(body, SHARE_URL)
    const { win, instances } = makeWindow(SHARE_URL, { observer: true })

    const pending = collector.collectShare(doc, win, { waitMs: 2_000 })
    // The page renders its rows only after the collector started waiting.
    body.children.push(
      anchor('https://store3.gofile.io/download/web/f1/Late.mp4', 'Late.mp4', '3 MB')
    )
    for (const instance of instances) instance.fire()

    const result = await pending
    expect(result.status).toBe('ok')
    expect(result.files.map((file) => file.name)).toEqual(['Late.mp4'])
  })

  it('waits for a slow render by polling when there is no observer', async () => {
    const body = shareBody([])
    const doc = makeDocument(body, SHARE_URL)
    const { win } = makeWindow(SHARE_URL)

    const pending = collector.collectShare(doc, win, { waitMs: 2_000, pollMs: 10 })
    setTimeout(() => {
      body.children.push(
        anchor('https://store3.gofile.io/download/web/f1/Polled.mp4', 'Polled.mp4', '4 MB')
      )
    }, 20)

    const result = await pending
    expect(result.files.map((file) => file.name)).toEqual(['Polled.mp4'])
  })

  it('gives up after the bounded wait', async () => {
    const doc = makeDocument(shareBody([]), SHARE_URL)
    const { win } = makeWindow(SHARE_URL)
    const result = await collector.collectShare(doc, win, {
      waitMs: 20,
      pollMs: 5
    })
    expect(result.status).toBe('empty')
    expect(result.files).toEqual([])
  })

  it('reports a password prompt instead of files', async () => {
    const body = element(
      'div',
      {},
      [element('input', { type: 'password' })],
      'This share is password protected'
    )
    const doc = makeDocument(body, SHARE_URL)
    const { win } = makeWindow(SHARE_URL)
    const result = await collector.collectShare(doc, win, { waitMs: 20, pollMs: 5 })
    expect(result.status).toBe('password')
    expect(result.files).toEqual([])
  })

  it('is not a share page at all', async () => {
    const doc = makeDocument(shareBody([]), 'https://gofile.io/')
    const { win } = makeWindow('https://gofile.io/')
    const result = await collector.collectShare(doc, win, { waitMs: 20 })
    expect(result.shareId).toBeNull()
    expect(result.status).toBe('not-found')
  })

  it('follows rendered subfolders two levels deep and stops there', async () => {
    const root = shareBody([
      anchor('https://store3.gofile.io/download/web/f1/Root.mp4', 'Root.mp4', '1 MB'),
      anchor('https://gofile.io/d/AbCd1234?folder=one', 'Folder one')
    ])
    const doc = makeDocument(root, SHARE_URL)
    const { win } = makeWindow(SHARE_URL)
    const clicked: string[] = []

    const result = await collector.collectShare(doc, win, {
      waitMs: 200,
      folderWaitMs: 200,
      pollMs: 5,
      clickFolder: (target: unknown) => {
        const href = (target as FakeElement).getAttribute('href') ?? ''
        clicked.push(href)
        if (href.endsWith('folder=one')) {
          root.children = [
            anchor('https://store3.gofile.io/download/web/f2/One-A.mp4', 'One-A.mp4', '1 MB'),
            anchor('https://store3.gofile.io/download/web/f3/One-B.mp4', 'One-B.mp4', '1 MB'),
            anchor('https://gofile.io/d/AbCd1234?folder=two', 'Folder two')
          ]
        } else if (href.endsWith('folder=two')) {
          root.children = [
            anchor('https://store3.gofile.io/download/web/f4/Two-A.mp4', 'Two-A.mp4', '1 MB'),
            anchor('https://gofile.io/d/AbCd1234?folder=three', 'Folder three')
          ]
        } else {
          root.children = [
            anchor('https://store3.gofile.io/download/web/f5/Deep.mp4', 'Deep.mp4', '1 MB')
          ]
        }
      }
    })

    expect(clicked).toEqual([
      'https://gofile.io/d/AbCd1234?folder=one',
      'https://gofile.io/d/AbCd1234?folder=two'
    ])
    expect(result.status).toBe('ok')
    expect(result.files.map((file) => file.name)).toEqual([
      'Root.mp4',
      'One-A.mp4',
      'One-B.mp4',
      'Two-A.mp4'
    ])
  })

  it('caps the file list at 500 entries', async () => {
    const rows: FakeElement[] = []
    for (let index = 0; index < 600; index += 1) {
      rows.push(
        anchor(
          `https://store3.gofile.io/download/web/f${index}/File${index}.mp4`,
          `File${index}.mp4`,
          '1 MB'
        )
      )
    }
    const doc = makeDocument(shareBody(rows), SHARE_URL)
    const { win } = makeWindow(SHARE_URL)
    const result = await collector.collectShare(doc, win, { waitMs: 200 })
    expect(result.files).toHaveLength(collector.MAX_FILES)
  })

  it('keeps the run result on the global so a closed popup cannot lose it', async () => {
    const doc = makeDocument(
      shareBody([anchor('https://store3.gofile.io/download/web/f1/A.mp4', 'A.mp4', '1 MB')]),
      SHARE_URL
    )
    const { win } = makeWindow(SHARE_URL)
    expect(collector.startRun(doc, win, { waitMs: 50 })).toBe(true)
    const run = (sandbox as Record<string, unknown>)[collector.RUN_KEY] as {
      done: boolean
      result: ShareResult | null
    }
    expect(run).toBeDefined()
    for (let attempt = 0; attempt < 50 && !run.done; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(run.done).toBe(true)
    expect(run.result?.files).toHaveLength(1)
  })
})
