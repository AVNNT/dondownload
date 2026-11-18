import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

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
      const found: FakeElement[] = []
      const collect = (predicate: (node: FakeElement) => boolean): FakeElement[] => {
        found.length = 0
        walk(body, (node) => {
          if (predicate(node)) found.push(node)
        })
        return found
      }
      if (selector === 'a[href]') {
        return collect((node) => node.tag === 'a' && node.getAttribute('href') !== null)
      }
      if (selector === '.fm-row[data-type]') {
        return collect(
          (node) =>
            (node.getAttribute('class') ?? '').split(/\s+/).includes('fm-row') &&
            node.getAttribute('data-type') !== null
        )
      }
      const actionMatch = /^\[data-action="([^"]+)"\]$/.exec(selector)
      if (actionMatch) {
        return collect((node) => node.getAttribute('data-action') === actionMatch[1])
      }
      return []
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

/**
 * One file row exactly as the real gofile.io frontend renders it
 * (`div.fm-row[data-type="file"]`): a `[data-action="toggle-select"]` control, a
 * `[data-action="open-file"]` cell whose own text is the name followed by the
 * timestamp and the size, then `[data-action="preview"]`,
 * `[data-action="download"]` and `[data-action="item-menu"]` controls. There is
 * no download URL anywhere in the DOM.
 */
function fileRow(
  name: string,
  size: string,
  options: { onClick?: () => void; date?: string; rowId?: string } = {}
): { row: FakeElement; download: FakeElement; nameCell: FakeElement } {
  const toggle = element(
    'button',
    { type: 'button', 'data-action': 'toggle-select', 'aria-label': `Select ${name}` },
    [],
    ''
  )
  const nameText = element('p', { class: 'truncate text-sm font-medium text-white' }, [], name)
  const dateCell = element(
    'span',
    { class: 'inline-flex items-center gap-1' },
    [],
    options.date ?? 'Nov 7, 2026, 11:17 AM'
  )
  const sizeCell = element('span', {}, [], size)
  const meta = element('p', { class: 'mt-0.5 flex flex-wrap' }, [dateCell, sizeCell])
  const nameCell = element(
    'button',
    { type: 'button', 'data-action': 'open-file', class: 'flex min-w-0 flex-1' },
    [
      element('span', { 'aria-hidden': 'true' }, [
        element('span', { class: 'relative inline-flex' }, [])
      ]),
      element('div', { class: 'min-w-0 flex-1' }, [nameText, meta])
    ]
  )
  const preview = element(
    'button',
    { type: 'button', 'data-action': 'preview' },
    [],
    'Preview'
  )
  const download = element(
    'button',
    { type: 'button', 'data-action': 'download', title: 'Download' },
    [],
    'Download'
  )
  if (options.onClick) download.click = options.onClick
  const menu = element(
    'button',
    { type: 'button', 'data-action': 'item-menu', 'aria-label': `Actions for ${name}` },
    [],
    ''
  )
  const row = element(
    'div',
    {
      class: 'fm-row group/row relative flex items-start',
      'data-id': options.rowId ?? `row-${name}`,
      'data-type': 'file'
    },
    [toggle, nameCell, element('div', { class: 'flex shrink-0' }, [preview, download, menu])]
  )
  return { row, download, nameCell }
}

/** A folder row: `div.fm-row[data-type="folder"]` with one navigate link. */
function folderRow(code: string, name: string): FakeElement {
  const link = element('a', { href: `/d/${code}`, 'data-action': 'navigate' }, [], name)
  return element('div', { class: 'fm-row', 'data-type': 'folder' }, [link])
}

/** The breadcrumb / "Go to parent folder" control, outside every row. */
function parentLink(code: string): FakeElement {
  const link = element(
    'a',
    { href: `/d/${code}`, 'data-action': 'navigate' },
    [],
    'Go to parent folder'
  )
  return element('div', { class: 'fm-breadcrumb' }, [link])
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

  it('reports rendered subfolder rows of the same share only', () => {
    const body = shareBody([
      fileRow('Real.mp4', '2 MB').row,
      folderRow('Folder01', 'Season 1'),
      // A folder row naming this very listing is the parent, not a subfolder.
      folderRow('AbCd1234', 'This share'),
      // The breadcrumb / parent control is a navigate link outside every row.
      parentLink('AbCd1234')
    ])
    const rows = collector.readRows(makeDocument(body, SHARE_URL), 'AbCd1234')
    expect(rows.folders).toEqual([
      { url: 'https://gofile.io/d/Folder01', name: 'Season 1' }
    ])
  })
})

/* --------------------------- real button-shaped rows --------------------------- */

describe('gofile collector on the real button-shaped frontend', () => {
  it('reads name and size from a download-button row with no URL', () => {
    const body = shareBody([
      fileRow('Fancam 01.mp4', '1.4 GB').row,
      fileRow('Fancam 01.funscript', '12.5 MB').row
    ])
    const rows = collector.readRows(makeDocument(body, SHARE_URL), 'AbCd1234')

    expect(rows.files).toEqual([
      { name: 'Fancam 01.mp4', size: Math.round(1.4 * 1024 ** 3), url: null },
      {
        name: 'Fancam 01.funscript',
        size: Math.round(12.5 * 1024 ** 2),
        url: null
      }
    ])
  })

  it('never takes the name from a preview or download control', () => {
    const body = shareBody([fileRow('Real name.mp4', '14044 B').row])
    const rows = collector.readRows(makeDocument(body, SHARE_URL), 'AbCd1234')
    expect(rows.files.map((file) => file.name)).toEqual(['Real name.mp4'])
    expect(rows.files[0]?.size).toBe(14044)
  })

  it('reads the name from the open-file cell, never its timestamp or size', () => {
    // The real cell text is "name Nov 7, 2026, 11:17 AM 52.0 B".
    const body = shareBody([
      fileRow('dondownload-e2e-clip.funscript', '52.0 B').row,
      fileRow('dondownload-e2e-clip.mp4', '14.0 KB').row
    ])
    const rows = collector.readRows(makeDocument(body, SHARE_URL), 'AbCd1234')
    expect(rows.files).toEqual([
      { name: 'dondownload-e2e-clip.funscript', size: 52, url: null },
      { name: 'dondownload-e2e-clip.mp4', size: 14 * 1024, url: null }
    ])
  })

  it('reads the name from a plain cell when the name is not a button', () => {
    const nameCell = element('span', { class: 'fm-row-name' }, [], 'Plain name.mkv')
    const download = element('button', { 'data-action': 'download' }, [], 'Download')
    const row = element('div', { class: 'fm-row', 'data-type': 'file' }, [
      nameCell,
      element('div', {}, [], '900 KB'),
      element('button', { 'data-action': 'preview' }, [], 'Preview'),
      download
    ])
    const rows = collector.readRows(
      makeDocument(shareBody([row]), SHARE_URL),
      'AbCd1234'
    )
    expect(rows.files).toEqual([{ name: 'Plain name.mkv', size: 900 * 1024, url: null }])
  })

  it('reads a folder link rendered as a navigate anchor inside a folder row', () => {
    const body = shareBody([
      fileRow('Root.mp4', '1 MB').row,
      folderRow('Folder01', 'Season 1')
    ])
    const rows = collector.readRows(makeDocument(body, SHARE_URL), 'AbCd1234')

    expect(rows.files.map((file) => file.name)).toEqual(['Root.mp4'])
    expect(rows.folders).toEqual([
      { url: 'https://gofile.io/d/Folder01', name: 'Season 1' }
    ])
  })

  it('keeps two rows that share a name when their sizes differ', () => {
    const body = shareBody([
      fileRow('clip.mp4', '14044 B', { rowId: 'a' }).row,
      fileRow('clip.mp4', '99 MB', { rowId: 'b' }).row
    ])
    const rows = collector.readRows(makeDocument(body, SHARE_URL), 'AbCd1234')
    expect(rows.files.map((file) => file.size)).toEqual([14044, 99 * 1024 * 1024])
  })

  it('reads one row once, whatever the frontend re-renders', () => {
    const body = shareBody([
      fileRow('clip.mp4', '14044 B', { rowId: 'same' }).row,
      fileRow('clip.mp4', '14044 B', { rowId: 'same' }).row
    ])
    const rows = collector.readRows(makeDocument(body, SHARE_URL), 'AbCd1234')
    expect(rows.files).toHaveLength(1)
  })

  it('clicks every download button once when a capture is requested', async () => {
    const clicks: string[] = []
    const body = shareBody([
      fileRow('A.mp4', '1 MB', { onClick: () => clicks.push('A.mp4') }).row,
      fileRow('B.mp4', '2 MB', { onClick: () => clicks.push('B.mp4') }).row
    ])
    const doc = makeDocument(body, SHARE_URL)
    const { win } = makeWindow(SHARE_URL)

    const result = await collector.collectShare(doc, win, {
      waitMs: 200,
      captureDownloads: true,
      clickDelayMs: 1
    })

    expect(clicks).toEqual(['A.mp4', 'B.mp4'])
    expect(result.status).toBe('ok')
    expect(result.files.map((file) => file.url)).toEqual([null, null])
  })

  it('does not click a row whose download URL the page already exposed', async () => {
    const clicks: string[] = []
    // A page that renders real download anchors exposes the URL directly.
    const body = shareBody([
      anchor('https://store3.gofile.io/download/web/f1/Linked.mp4', 'Linked.mp4', '1 MB')
    ])
    const doc = makeDocument(body, SHARE_URL)
    const { win } = makeWindow(SHARE_URL)

    const result = await collector.collectShare(doc, win, {
      waitMs: 200,
      captureDownloads: true,
      clickDelayMs: 1
    })

    expect(clicks).toEqual([])
    expect(result.files).toEqual([
      {
        name: 'Linked.mp4',
        size: 1024 * 1024,
        url: 'https://store3.gofile.io/download/web/f1/Linked.mp4'
      }
    ])
  })

  it('never clicks anything without a capture request', async () => {
    const clicks: string[] = []
    const body = shareBody([
      fileRow('A.mp4', '1 MB', { onClick: () => clicks.push('A.mp4') }).row
    ])
    const doc = makeDocument(body, SHARE_URL)
    const { win } = makeWindow(SHARE_URL)
    await collector.collectShare(doc, win, { waitMs: 200 })
    expect(clicks).toEqual([])
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

  it('follows rendered subfolder rows two levels deep and stops there', async () => {
    const root = shareBody([
      fileRow('Root.mp4', '1 MB').row,
      folderRow('FolderOne', 'Folder one'),
      // The parent/breadcrumb control is never followed.
      parentLink('AbCd1234')
    ])
    const doc = makeDocument(root, SHARE_URL)
    const { win } = makeWindow(SHARE_URL)
    const clicked: string[] = []
    const restored: string[] = []

    const result = await collector.collectShare(doc, win, {
      waitMs: 200,
      folderWaitMs: 200,
      pollMs: 5,
      restoreStart: (url: string) => {
        restored.push(url)
        ;(win.location as { href: string }).href = url
        root.children = [
          fileRow('Root.mp4', '1 MB').row,
          folderRow('FolderOne', 'Folder one')
        ]
      },
      clickFolder: (target: unknown) => {
        const href = (target as FakeElement).getAttribute('href') ?? ''
        clicked.push(href)
        // The page navigates its own client-side route when a folder is opened.
        ;(win.location as { href: string }).href = `https://gofile.io${href}`
        if (href.endsWith('FolderOne')) {
          root.children = [
            fileRow('One-A.mp4', '1 MB').row,
            fileRow('One-B.mp4', '1 MB').row,
            folderRow('FolderTwo', 'Folder two')
          ]
        } else if (href.endsWith('FolderTwo')) {
          root.children = [
            fileRow('Two-A.mp4', '1 MB').row,
            folderRow('FolderThree', 'Folder three')
          ]
        } else {
          root.children = [fileRow('Deep.mp4', '1 MB').row]
        }
      }
    })

    expect(clicked).toEqual(['/d/FolderOne', '/d/FolderTwo'])
    expect(restored).toEqual([SHARE_URL])
    expect(result.status).toBe('ok')
    expect(result.files.map((file) => file.name)).toEqual([
      'Root.mp4',
      'One-A.mp4',
      'One-B.mp4',
      'Two-A.mp4'
    ])
  })

  it('never follows the parent-folder link and never leaves the share', async () => {
    const root = shareBody([
      fileRow('Root.mp4', '1 MB').row,
      parentLink('AbCd1234')
    ])
    const doc = makeDocument(root, SHARE_URL)
    const { win } = makeWindow(SHARE_URL)
    const clicked: string[] = []

    const result = await collector.collectShare(doc, win, {
      waitMs: 200,
      folderWaitMs: 200,
      pollMs: 5,
      clickFolder: (target: unknown) => {
        clicked.push((target as FakeElement).getAttribute('href') ?? '')
      }
    })

    expect(clicked).toEqual([])
    expect(result.folders).toBe(0)
    expect(result.files.map((file) => file.name)).toEqual(['Root.mp4'])
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
    // Poll until the collector's own deadline elapses; never assume a fixed
    // number of 5 ms slices is enough on a loaded machine.
    await vi.waitFor(() => expect(run.done).toBe(true))
    expect(run.result?.files).toHaveLength(1)
  })
})
