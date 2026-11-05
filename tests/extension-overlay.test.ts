import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

interface Rect {
  left: number
  top: number
  width: number
  height: number
}

interface CoreApi {
  BUTTON_SIZE: number
  EDGE_INSET: number
  SHORTCUT_LABEL: string
  MEDIA_SIZE_UNKNOWN: string
  evaluateVideoCandidate: (
    candidate: {
      tagName?: string
      isConnected?: boolean
      hidden?: boolean
      rect?: Rect
      styles?: { display?: string; visibility?: string; opacity?: string }
    },
    viewport: { width: number; height: number }
  ) => { usable: boolean; reason: string }
  findVideoInPath: (path: unknown[]) => unknown
  placeTrigger: (
    rect: Rect,
    viewport: { width: number; height: number }
  ) => { left: number; top: number; width: number; height: number } | null
  placePanel: (
    trigger: { left: number; top: number },
    viewport: { width: number; height: number },
    panelSize?: { width?: number; height?: number }
  ) => { left: number; top: number; width: number; placement: string } | null
  nextActiveVideo: (video: unknown) => unknown
  isTypingTarget: (target: unknown) => boolean
  isOverlayShortcut: (event: unknown) => boolean
  initialMediaState: () => {
    title: string
    detail: string
    actionLabel: string
    analyzingLabel: string
    optionsHint: string
    disableLabel: string
    shortcutLabel: string
  }
  mediaView: (analysis: unknown) => {
    analysisId: string
    title: string
    durationSeconds: number | null
    options: Array<{
      kind: 'video' | 'audio'
      optionId: string
      label: string
      container: string
      width: number | null
      height: number | null
      filesizeBytes: number | null
      estimatedBytes: number | null
      sizeIsEstimate: boolean
    }>
    videoOptions: Array<{ optionId: string; label: string; kind: 'video' }>
    audioOptions: Array<{ optionId: string; label: string; kind: 'audio' }>
    bestVideoOptionId: string | null
    bestAudioOptionId: string | null
  } | null
  formatMediaSize: (bytes: unknown, estimate?: boolean) => string
  describeMediaDetails: (option: unknown) => string
  describeMediaSize: (option: unknown) => string
  describeMediaOption: (option: unknown) => string
  describeMediaError: (error: unknown, fallback?: string) => string
  formatDuration: (seconds: unknown) => string
  unavailableState: () => {
    title: string
    detail: string
    actionLabel: string
    optionsHint: string
    disableLabel: string
    shortcutLabel: string
  }
}

const extensionDir = path.join(process.cwd(), 'extension')
const coreSource = readFileSync(path.join(extensionDir, 'overlay-core.js'), 'utf8')
const uiSource = readFileSync(path.join(extensionDir, 'overlay.js'), 'utf8')

function loadCore(): CoreApi {
  const value = vm.runInNewContext(
    `${coreSource}\n;globalThis.DonDownloadOverlayCore`,
    Object.create(null)
  ) as CoreApi
  return value
}

const core = loadCore()
const viewport = { width: 1280, height: 720 }

describe('video detection and placement policy', () => {
  it('accepts only visible, connected, large enough VIDEO elements', () => {
    const rect = { left: 100, top: 80, width: 640, height: 360 }
    expect(
      core.evaluateVideoCandidate({ tagName: 'VIDEO', isConnected: true, rect }, viewport)
        .usable
    ).toBe(true)

    for (const candidate of [
      { tagName: 'DIV', isConnected: true, rect },
      { tagName: 'VIDEO', isConnected: false, rect },
      { tagName: 'VIDEO', isConnected: true, hidden: true, rect },
      {
        tagName: 'VIDEO',
        isConnected: true,
        rect,
        styles: { display: 'none' }
      },
      {
        tagName: 'VIDEO',
        isConnected: true,
        rect,
        styles: { visibility: 'hidden' }
      },
      {
        tagName: 'VIDEO',
        isConnected: true,
        rect,
        styles: { opacity: '0' }
      },
      { tagName: 'VIDEO', isConnected: true, rect: { ...rect, width: 80 } },
      { tagName: 'VIDEO', isConnected: true, rect: { ...rect, height: 40 } },
      {
        tagName: 'VIDEO',
        isConnected: true,
        rect: { left: -2000, top: 0, width: 640, height: 360 }
      },
      { tagName: 'VIDEO', isConnected: true, rect: { left: 0, top: 0, width: 0, height: 0 } }
    ]) {
      expect(core.evaluateVideoCandidate(candidate, viewport).usable).toBe(false)
    }
  })

  it('finds a VIDEO through an event path without touching media sources', () => {
    const video = { tagName: 'VIDEO' }
    expect(core.findVideoInPath([{ tagName: 'SPAN' }, video])).toBe(video)
    expect(core.findVideoInPath([{ tagName: 'DIV' }])).toBeNull()
    expect(core.findVideoInPath([])).toBeNull()
  })

  it('places the button at the video top-right and clamps it into the viewport', () => {
    expect(
      core.placeTrigger({ left: 100, top: 100, width: 640, height: 360 }, viewport)
    ).toEqual({ left: 702, top: 108, width: 30, height: 30 })

    const clamped = core.placeTrigger(
      { left: 1000, top: 0, width: 400, height: 300 },
      viewport
    )
    expect(clamped).toEqual({ left: 1242, top: 8, width: 30, height: 30 })

    expect(core.placeTrigger({ left: 0, top: 0, width: 10, height: 10 }, viewport)).toEqual({
      left: 8,
      top: 8,
      width: 30,
      height: 30
    })
  })

  it('places the expandable panel below or above and clamps it inside the viewport', () => {
    const panelSize = { width: 292, height: 258 }
    expect(core.placePanel({ left: 700, top: 100 }, viewport, panelSize)).toEqual({
      left: 438,
      top: 136,
      width: 292,
      placement: 'below'
    })
    expect(core.placePanel({ left: 700, top: 600 }, viewport, panelSize)).toEqual({
      left: 438,
      top: 336,
      width: 292,
      placement: 'above'
    })
    expect(
      core.placePanel({ left: 20, top: 100 }, { width: 250, height: 400 }, panelSize)
    ).toEqual({ left: 8, top: 8, width: 234, placement: 'above' })
  })

  it('drops a disconnected active video so the observer can hide the overlay', () => {
    const connected = { isConnected: true }
    const removed = { isConnected: false }
    expect(core.nextActiveVideo(connected)).toBe(connected)
    expect(core.nextActiveVideo(removed)).toBeNull()
    expect(core.nextActiveVideo(null)).toBeNull()
  })

  it('ignores the shortcut while typing and accepts only Alt+Shift+D', () => {
    expect(core.isOverlayShortcut({ altKey: true, shiftKey: true, code: 'KeyD' })).toBe(true)
    expect(
      core.isOverlayShortcut({ altKey: true, shiftKey: true, key: 'D' })
    ).toBe(true)
    expect(
      core.isOverlayShortcut({ altKey: false, shiftKey: true, code: 'KeyD' })
    ).toBe(false)
    expect(core.isOverlayShortcut({ altKey: true, shiftKey: true, code: 'KeyP' })).toBe(
      false
    )
    expect(
      core.isOverlayShortcut({
        altKey: true,
        shiftKey: true,
        ctrlKey: true,
        code: 'KeyD'
      })
    ).toBe(false)

    expect(core.isTypingTarget({ tagName: 'INPUT' })).toBe(true)
    expect(core.isTypingTarget({ tagName: 'TEXTAREA' })).toBe(true)
    expect(core.isTypingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true)
    expect(core.isTypingTarget({ tagName: 'VIDEO' })).toBe(false)
  })

  it('starts with truthful media copy and never fabricates an option', () => {
    const copy = core.initialMediaState()
    expect(copy.title).toMatch(/video options/i)
    expect(copy.detail).toMatch(/page address/i)
    expect(copy.detail).toMatch(/never read/i)
    expect(copy.actionLabel).toMatch(/analyze/i)

    const serialized = JSON.stringify(copy)
    for (const fabricated of ['1080p', '720p', '4K', 'MP4', 'HLS', 'DASH', 'audio only']) {
      expect(serialized).not.toContain(fabricated)
    }

    expect(core.mediaView(null)).toBeNull()
    const invalidOption = core.mediaView({
      analysisId: 'analysis_1',
      title: 'x',
      options: [{ kind: 'video' }]
    })
    expect(invalidOption?.options).toEqual([])
    expect(invalidOption?.bestVideoOptionId).toBeNull()
  })

  it('builds a safe view only from verified analysis fields', () => {
    const view = core.mediaView({
      analysisId: 'analysis_1',
      title: 'Verified title',
      durationSeconds: 91.5,
      options: [
        {
          kind: 'video',
          optionId: 'option_video_1',
          label: '1080p MP4 - H.264 + AAC',
          container: 'mp4',
          width: 1920,
          height: 1080,
          fps: 30,
          videoCodec: 'avc1',
          audioCodec: 'mp4a',
          hasAudio: true,
          requiresMerge: true,
          filesizeBytes: 10_000
        },
        {
          kind: 'audio',
          optionId: 'option_audio_1',
          label: 'Audio only - Opus',
          container: 'opus',
          width: null,
          height: null,
          fps: null,
          videoCodec: null,
          audioCodec: 'opus',
          hasAudio: true,
          requiresMerge: false,
          filesizeBytes: null
        }
      ],
      bestVideoOptionId: 'option_video_1',
      bestAudioOptionId: 'option_audio_1',
      expiresAt: 1
    })

    expect(view?.title).toBe('Verified title')
    expect(view?.videoOptions).toHaveLength(1)
    expect(view?.audioOptions).toHaveLength(1)
    expect(view?.bestVideoOptionId).toBe('option_video_1')
    expect(view?.bestAudioOptionId).toBe('option_audio_1')
    expect(core.describeMediaOption(view?.videoOptions[0])).toContain('1080p')
    expect(core.formatDuration(91.5)).toBe('1:32')

    const unsafe = core.mediaView({
      analysisId: 'analysis_1',
      title: 'Verified title',
      options: [
        {
          kind: 'video',
          optionId: 'https://page.example/raw-selector',
          label: 'x',
          container: 'mp4'
        }
      ],
      bestVideoOptionId: 'https://page.example/raw-selector',
      bestAudioOptionId: null
    })
    expect(unsafe?.options).toEqual([])
    expect(unsafe?.bestVideoOptionId).toBeNull()
  })

  it('shows yt-dlp-reported sizes, estimate labels and unknown sizes', () => {
    expect(core.formatMediaSize(null)).toBe('Size unknown')
    expect(core.formatMediaSize(0)).toBe('Size unknown')
    expect(core.formatMediaSize(1024 * 1024)).toBe('1.00 MB')
    expect(core.formatMediaSize(1024 * 1024, true)).toBe('~1.00 MB estimated')
    expect(core.describeMediaSize({ estimatedBytes: 0, filesizeBytes: 1024 })).toBe(
      '1.00 KB'
    )
    expect(core.describeMediaSize({ estimatedBytes: null, filesizeBytes: null })).toBe(
      'Size unknown'
    )

    const view = core.mediaView({
      analysisId: 'analysis_1',
      title: 'Verified title',
      options: [
        {
          kind: 'video',
          optionId: 'option_exact',
          label: '1080p MP4',
          container: 'mp4',
          width: 1920,
          height: 1080,
          fps: 30,
          videoCodec: 'avc1',
          audioCodec: 'mp4a',
          hasAudio: true,
          requiresMerge: false,
          filesizeBytes: 1024 * 1024,
          estimatedBytes: 1024 * 1024,
          sizeIsEstimate: false
        },
        {
          kind: 'video',
          optionId: 'option_estimate',
          label: '720p MP4',
          container: 'mp4',
          width: 1280,
          height: 720,
          fps: 30,
          videoCodec: 'avc1',
          audioCodec: 'mp4a',
          hasAudio: true,
          requiresMerge: true,
          filesizeBytes: null,
          estimatedBytes: Math.round(1.5 * 1024 * 1024),
          sizeIsEstimate: true
        },
        {
          kind: 'video',
          optionId: 'option_legacy',
          label: '480p MP4',
          container: 'mp4',
          width: 854,
          height: 480,
          fps: 30,
          videoCodec: 'avc1',
          audioCodec: 'mp4a',
          hasAudio: true,
          requiresMerge: false,
          filesizeBytes: 512 * 1024
        },
        {
          kind: 'audio',
          optionId: 'option_audio_unknown',
          label: 'Audio only',
          container: 'opus',
          width: null,
          height: null,
          fps: null,
          videoCodec: null,
          audioCodec: 'opus',
          hasAudio: true,
          requiresMerge: false,
          filesizeBytes: null,
          estimatedBytes: null,
          sizeIsEstimate: false
        }
      ],
      bestVideoOptionId: 'option_estimate',
      bestAudioOptionId: 'option_audio_unknown'
    })

    expect(view?.options[0]?.estimatedBytes).toBe(1024 * 1024)
    expect(view?.options[0]?.sizeIsEstimate).toBe(false)
    expect(view?.options[1]?.estimatedBytes).toBe(Math.round(1.5 * 1024 * 1024))
    expect(view?.options[1]?.sizeIsEstimate).toBe(true)
    expect(core.describeMediaSize(view?.videoOptions[0])).toBe('1.00 MB')
    expect(core.describeMediaSize(view?.videoOptions[1])).toBe('~1.50 MB estimated')
    // Older payloads without estimatedBytes still show their exact size.
    expect(core.describeMediaSize(view?.videoOptions[2])).toBe('512 KB')
    // A missing size is stated plainly, never replaced by an invented value.
    expect(core.describeMediaSize(view?.audioOptions[0])).toBe('Size unknown')
    expect(core.describeMediaOption(view?.videoOptions[0])).toContain('1080p · MP4')
    expect(core.describeMediaOption(view?.videoOptions[0])).toContain('1.00 MB')
    expect(core.describeMediaOption(null)).toBe('')
  })

  it('adds an actionable next step to stable media error codes', () => {
    expect(
      core.describeMediaError(
        { code: 'MEDIA_TOOL_UNAVAILABLE', message: 'yt-dlp could not be started.' },
        'Fallback'
      )
    ).toContain('yt-dlp is available')
    expect(
      core.describeMediaError(
        { code: 'MEDIA_ANALYSIS_EXPIRED', message: 'Analysis expired.' },
        'Fallback'
      )
    ).toContain('Analyze this page again')
    expect(
      core.describeMediaError(
        { code: 'PERMISSION_REQUIRED', message: 'Site access is not granted.' },
        'Fallback'
      )
    ).toContain('DonDownload popup')
    expect(
      core.describeMediaError(
        { code: 'APP_NOT_RUNNING', message: 'DonDownload is not running.' },
        'Fallback'
      )
    ).toContain('Start DonDownload')
    expect(
      core.describeMediaError({ code: 'SOMETHING_ELSE', message: 'Nope.' }, 'Fallback')
    ).toBe('Nope.')
    expect(
      core.describeMediaError({ code: 'constructor', message: 'Unexpected error.' }, 'Fallback')
    ).toBe('Unexpected error.')
    expect(core.describeMediaError(null, 'Fallback')).toBe('Fallback')
  })
})

interface FakeRect extends Rect {
  right?: number
  bottom?: number
}

type Listener = (event: any) => void

let activeDocument: any

class FakeNode {
  tagName: string
  parentNode: FakeNode | null = null
  children: FakeNode[] = []
  style: Record<string, string> = {}
  attributes: Record<string, string> = {}
  listeners: Record<string, Listener[]> = {}
  hidden = false
  disabled = false
  checked = false
  value = ''
  name = ''
  textContent = ''
  className = ''
  id = ''
  type = ''
  tabIndex = 0
  isContentEditable = false
  shadowRoot: FakeShadowRoot | null = null
  rect: FakeRect = { left: 0, top: 0, width: 0, height: 0 }
  computed: { display?: string; visibility?: string; opacity?: string } = {
    display: 'block',
    visibility: 'visible',
    opacity: '1'
  }

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase()
  }

  get isConnected(): boolean {
    let node: FakeNode | null = this
    while (node) {
      if (node === activeDocument.documentElement) return true
      node = node.parentNode
    }
    return false
  }

  appendChild(child: FakeNode): FakeNode {
    child.parentNode = this
    this.children.push(child)
    return child
  }

  removeChild(child: FakeNode): FakeNode {
    const index = this.children.indexOf(child)
    if (index !== -1) this.children.splice(index, 1)
    child.parentNode = null
    return child
  }

  remove(): void {
    if (this.parentNode) this.parentNode.removeChild(this)
  }

  attachShadow(options: { mode: string }): FakeShadowRoot {
    this.shadowRoot = new FakeShadowRoot(options.mode)
    return this.shadowRoot
  }

  addEventListener(type: string, listener: Listener): void {
    if (!this.listeners[type]) this.listeners[type] = []
    this.listeners[type].push(listener)
  }

  removeEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners[type]
    if (!listeners) return
    const index = listeners.indexOf(listener)
    if (index !== -1) listeners.splice(index, 1)
  }

  dispatch(type: string, event: any): void {
    for (const listener of this.listeners[type] ?? []) listener(event)
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = String(value)
  }

  getAttribute(name: string): string | null {
    return Object.prototype.hasOwnProperty.call(this.attributes, name)
      ? (this.attributes[name] ?? null)
      : null
  }

  removeAttribute(name: string): void {
    delete this.attributes[name]
  }

  contains(node: FakeNode | null): boolean {
    if (!node) return false
    if (node === this) return true
    return this.children.some((child) => child.contains(node))
  }

  focus(): void {
    activeDocument.activeElement = this
  }

  getBoundingClientRect(): FakeRect {
    return {
      ...this.rect,
      right: this.rect.left + this.rect.width,
      bottom: this.rect.top + this.rect.height
    }
  }
}

class FakeShadowRoot {
  mode: string
  children: FakeNode[] = []

  constructor(mode: string) {
    this.mode = mode
  }

  appendChild(child: FakeNode): FakeNode {
    child.parentNode = activeDocument.documentElement
    this.children.push(child)
    return child
  }
}

class FakeMutationObserver {
  callback: () => void
  observed: { target: unknown; options: unknown } | null = null
  disconnected = false

  constructor(callback: () => void) {
    this.callback = callback
  }

  observe(target: unknown, options: unknown): void {
    this.observed = { target, options }
  }

  disconnect(): void {
    this.disconnected = true
  }

  trigger(): void {
    this.callback()
  }
}

class FakeResizeObserver {
  callback: () => void
  targets: unknown[] = []
  disconnected = false

  constructor(callback: () => void) {
    this.callback = callback
  }

  observe(target: unknown): void {
    this.targets.push(target)
  }

  disconnect(): void {
    this.targets = []
    this.disconnected = true
  }
}

interface Harness {
  document: any
  window: any
  host: FakeNode
  trigger: FakeNode
  panel: FakeNode
  analyzeButton: FakeNode
  mediaResults: FakeNode
  mediaTitle: FakeNode
  mediaMeta: FakeNode
  bestVideoButton: FakeNode
  bestAudioButton: FakeNode
  qualityFieldset: FakeNode
  qualityList: FakeNode
  queueSelectedButton: FakeNode
  disableButton: FakeNode
  status: FakeNode
  video: FakeNode
  sentMessages: any[]
  mutationObserver: FakeMutationObserver
  resizeObserver: FakeResizeObserver
  timers: Array<() => void>
  dispatchDocument: (type: string, event: any) => void
  dispatchWindow: (type: string, event: any) => void
  dispatchRuntimeMessage: (message: any) => void
  runTimers: () => void
  flushMediaResponses: () => void
  findByClass: (className: string) => FakeNode | null
}

interface HarnessOptions {
  analyzeResponse?: any
  queueResponse?: any
  deferMediaResponses?: boolean
}

function createHarness(options: HarnessOptions = {}): Harness {
  const document: any = {
    documentElement: new FakeNode('html'),
    body: new FakeNode('body'),
    fullscreenElement: null,
    activeElement: null,
    listeners: {} as Record<string, Listener[]>,
    createElement(tag: string) {
      return new FakeNode(tag)
    },
    addEventListener(type: string, listener: Listener) {
      if (!this.listeners[type]) this.listeners[type] = []
      this.listeners[type].push(listener)
    },
    removeEventListener(type: string, listener: Listener) {
      const listeners = this.listeners[type]
      if (!listeners) return
      const index = listeners.indexOf(listener)
      if (index !== -1) listeners.splice(index, 1)
    },
    dispatch(type: string, event: any) {
      for (const listener of this.listeners[type] ?? []) listener(event)
    },
    querySelectorAll(selector: string) {
      if (selector !== 'video') return []
      return document.body.children.filter(
        (child: FakeNode) => child.tagName === 'VIDEO'
      )
    }
  }
  activeDocument = document
  document.documentElement.clientWidth = 1280
  document.documentElement.clientHeight = 720
  document.documentElement.appendChild(document.body)

  const timers: Array<() => void> = []
  const window: any = {
    innerWidth: 1280,
    innerHeight: 720,
    listeners: {} as Record<string, Listener[]>,
    addEventListener(type: string, listener: Listener) {
      if (!this.listeners[type]) this.listeners[type] = []
      this.listeners[type].push(listener)
    },
    removeEventListener(type: string, listener: Listener) {
      const listeners = this.listeners[type]
      if (!listeners) return
      const index = listeners.indexOf(listener)
      if (index !== -1) listeners.splice(index, 1)
    },
    dispatch(type: string, event: any) {
      for (const listener of this.listeners[type] ?? []) listener(event)
    },
    requestAnimationFrame(callback: () => void) {
      callback()
      return 1
    },
    setTimeout(callback: () => void) {
      timers.push(callback)
      return timers.length
    },
    clearTimeout() {
      // Timers are flushed explicitly by the test; nothing to cancel here.
    }
  }

  const sentMessages: any[] = []
  const runtimeListeners: Listener[] = []
  const pendingMediaResponses: Array<() => void> = []
  const chrome = {
    runtime: {
      lastError: undefined,
      sendMessage(message: any, callback?: (response: any) => void) {
        sentMessages.push(message)
        if (!callback) return
        if (message.type === 'dondownload:media-analyze') {
          const response =
            options.analyzeResponse ?? {
              ok: false,
              error: { code: 'NATIVE_HOST_FAILED', message: 'Native helper unavailable.' }
            }
          if (options.deferMediaResponses) {
            pendingMediaResponses.push(() => callback(response))
          } else {
            callback(response)
          }
          return
        }
        if (message.type === 'dondownload:media-queue') {
          const response =
            options.queueResponse ?? {
              ok: false,
              error: { code: 'NATIVE_HOST_FAILED', message: 'Native helper unavailable.' }
            }
          if (options.deferMediaResponses) {
            pendingMediaResponses.push(() => callback(response))
          } else {
            callback(response)
          }
          return
        }
        callback({ ok: true })
      },
      onMessage: {
        addListener(listener: Listener) {
          runtimeListeners.push(listener)
        },
        removeListener(listener: Listener) {
          const index = runtimeListeners.indexOf(listener)
          if (index !== -1) runtimeListeners.splice(index, 1)
        }
      }
    }
  }

  const mutationObservers: FakeMutationObserver[] = []
  const resizeObservers: FakeResizeObserver[] = []

  const sandbox: Record<string, any> = {
    console,
    document,
    window,
    location: { origin: 'https://example.com' },
    chrome,
    getComputedStyle(node: FakeNode) {
      return node.computed
    },
    MutationObserver: class extends FakeMutationObserver {
      constructor(callback: () => void) {
        super(callback)
        mutationObservers.push(this)
      }
    },
    ResizeObserver: class extends FakeResizeObserver {
      constructor(callback: () => void) {
        super(callback)
        resizeObservers.push(this)
      }
    },
    setTimeout: window.setTimeout,
    clearTimeout: window.clearTimeout
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(coreSource, sandbox)
  vm.runInContext(uiSource, sandbox)

  const host = document.documentElement.children.find(
    (child: FakeNode) => child.id === 'dondownload-overlay-host'
  )
  if (!host || !host.shadowRoot) throw new Error('overlay host was not created')

  function findByClassIn(node: FakeNode, className: string): FakeNode | null {
    if (node.className === className) return node
    for (const child of node.children) {
      const found = findByClassIn(child, className)
      if (found) return found
    }
    if (node.shadowRoot) {
      for (const child of node.shadowRoot.children) {
        const found = findByClassIn(child, className)
        if (found) return found
      }
    }
    return null
  }

  const findByClass = (className: string): FakeNode | null =>
    findByClassIn(host, className)
  const trigger = findByClass('trigger')
  const panel = findByClass('panel')
  const analyzeButton = findByClass('action')
  const mediaResults = findByClass('media-results')
  const mediaTitle = findByClass('media-title')
  const mediaMeta = findByClass('media-meta')
  const bestVideoButton = findByClass('action best-video')
  const bestAudioButton = findByClass('action secondary best-audio')
  const qualityFieldset = findByClass('qualities')
  const qualityList = findByClass('quality-list')
  const queueSelectedButton = findByClass('action secondary queue-selected')
  const disableButton = findByClass('disable')
  const status = findByClass('status')
  if (
    !trigger ||
    !panel ||
    !analyzeButton ||
    !mediaResults ||
    !mediaTitle ||
    !mediaMeta ||
    !bestVideoButton ||
    !bestAudioButton ||
    !qualityFieldset ||
    !qualityList ||
    !queueSelectedButton ||
    !disableButton ||
    !status
  ) {
    throw new Error('overlay controls were not created')
  }
  panel.rect = { left: 0, top: 0, width: 292, height: 258 }

  const video = new FakeNode('video')
  video.rect = { left: 100, top: 100, width: 640, height: 360 }
  document.body.appendChild(video)

  const mutationObserver = mutationObservers[0]
  if (!mutationObserver) {
    throw new Error('mutation observer was not created')
  }

  return {
    document,
    window,
    host,
    trigger,
    panel,
    analyzeButton,
    mediaResults,
    mediaTitle,
    mediaMeta,
    bestVideoButton,
    bestAudioButton,
    qualityFieldset,
    qualityList,
    queueSelectedButton,
    disableButton,
    status,
    video,
    sentMessages,
    mutationObserver,
    get resizeObserver() {
      return resizeObservers[0] as FakeResizeObserver
    },
    timers,
    dispatchDocument(type, event) {
      document.dispatch(type, event)
    },
    dispatchWindow(type, event) {
      window.dispatch(type, event)
    },
    dispatchRuntimeMessage(message) {
      for (const listener of [...runtimeListeners]) listener(message)
    },
    runTimers() {
      const pending = timers.splice(0, timers.length)
      for (const timer of pending) timer()
    },
    flushMediaResponses() {
      const pending = pendingMediaResponses.splice(0, pendingMediaResponses.length)
      for (const respond of pending) respond()
    },
    findByClass
  }
}

function pointerEvent(target: FakeNode, path: unknown[], extra: any = {}): any {
  return {
    target,
    relatedTarget: null,
    composedPath: () => path,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true
    },
    stopPropagation() {
      this.propagationStopped = true
    },
    ...extra
  }
}

let harness: Harness

function pointerOver(video: FakeNode): any {
  const event = pointerEvent(video, [video, harness.document.body, harness.document.documentElement])
  harness.dispatchDocument('pointerover', event)
  return event
}

const ANALYSIS_ID = 'analysis_0123456789abcdef'
const BEST_VIDEO_ID = 'option_video_best'
const OTHER_VIDEO_ID = 'option_video_other'
const BEST_AUDIO_ID = 'option_audio_best'

function fakeAnalysis(): any {
  return {
    analysisId: ANALYSIS_ID,
    title: 'Verified example media',
    durationSeconds: 91.5,
    options: [
      {
        kind: 'video',
        optionId: BEST_VIDEO_ID,
        label: '1080p MP4 - H.264 + AAC',
        container: 'mp4',
        width: 1920,
        height: 1080,
        fps: 30,
        videoCodec: 'avc1',
        audioCodec: 'mp4a',
        hasAudio: true,
        requiresMerge: true,
        filesizeBytes: 10_000,
        estimatedBytes: 10_000,
        sizeIsEstimate: false
      },
      {
        kind: 'video',
        optionId: OTHER_VIDEO_ID,
        label: '720p MP4 - H.264 + AAC',
        container: 'mp4',
        width: 1280,
        height: 720,
        fps: 30,
        videoCodec: 'avc1',
        audioCodec: 'mp4a',
        hasAudio: true,
        requiresMerge: true,
        filesizeBytes: null,
        estimatedBytes: 8_000,
        sizeIsEstimate: true
      },
      {
        kind: 'audio',
        optionId: BEST_AUDIO_ID,
        label: 'Audio only - Opus',
        container: 'opus',
        width: null,
        height: null,
        fps: null,
        videoCodec: null,
        audioCodec: 'opus',
        hasAudio: true,
        requiresMerge: false,
        filesizeBytes: null,
        estimatedBytes: null,
        sizeIsEstimate: false
      }
    ],
    bestVideoOptionId: BEST_VIDEO_ID,
    bestAudioOptionId: BEST_AUDIO_ID,
    expiresAt: 1_800_000_000_000
  }
}

function fakeJob(optionId: string, label: string): any {
  return {
    id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
    analysisId: ANALYSIS_ID,
    optionId,
    kind: 'video',
    title: 'Verified example media',
    label,
    status: 'queued',
    completedBytes: 0,
    totalBytes: null,
    speedBps: 0,
    errorMessage: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    completedAt: null
  }
}

function openPanel(target: Harness): void {
  pointerOver(target.video)
  target.trigger.dispatch(
    'click',
    pointerEvent(target.trigger, [target.trigger, target.host])
  )
}

describe('overlay interaction in a minimal DOM', () => {
  it('shows a small button on video hover, opens an expandable truthful panel and never plays the video', () => {
    harness = createHarness()
    expect(harness.host.hidden).toBe(true)
    expect(harness.trigger.hidden).toBe(true)

    pointerOver(harness.video)
    expect(harness.host.hidden).toBe(false)
    expect(harness.trigger.hidden).toBe(false)
    expect(harness.trigger.style.left).toBe('702px')
    expect(harness.trigger.style.top).toBe('108px')
    expect(harness.resizeObserver.targets).toContain(harness.video)

    const pointerDown = pointerEvent(harness.trigger, [harness.trigger, harness.host])
    harness.trigger.dispatch('pointerdown', pointerDown)
    expect(pointerDown.propagationStopped).toBe(true)
    expect(pointerDown.defaultPrevented).toBe(false)

    const click = pointerEvent(harness.trigger, [harness.trigger, harness.host])
    harness.trigger.dispatch('click', click)
    expect(harness.panel.hidden).toBe(false)
    expect(harness.trigger.getAttribute('aria-expanded')).toBe('true')
    expect(click.propagationStopped).toBe(true)
    expect(click.defaultPrevented).toBe(true)

    const panelText = JSON.stringify(collectText(harness.panel))
    expect(panelText).toMatch(/video options for this page/i)
    expect(panelText).toMatch(/analyze this page/i)
    expect(panelText).toMatch(/page address/i)
    expect(panelText).not.toMatch(/1080p|720p|4K|HLS|DASH/)

    // Opening the panel is not an analysis. Only the explicit Analyze button
    // may ask the background worker for media information.
    expect(
      harness.sentMessages.filter((message) =>
        String(message.type).startsWith('dondownload:media-')
      )
    ).toEqual([])

    const escape = pointerEvent(harness.panel, [harness.panel, harness.host], {
      key: 'Escape'
    })
    harness.panel.dispatch('keydown', escape)
    expect(harness.panel.hidden).toBe(true)
    expect(harness.document.activeElement).toBe(harness.trigger)
    expect(escape.defaultPrevented).toBe(true)

    // No source, playback or network API was touched.
    expect(Object.keys(harness.video.style)).toHaveLength(0)
    expect(harness.video.listeners).toEqual({})
  })

  it('handles dynamically removed videos through the mutation observer', () => {
    harness = createHarness()
    pointerOver(harness.video)
    expect(harness.host.hidden).toBe(false)
    expect(harness.mutationObserver.observed?.target).toBe(
      harness.document.documentElement
    )

    harness.video.remove()
    harness.mutationObserver.trigger()
    expect(harness.host.hidden).toBe(true)
    expect(harness.trigger.hidden).toBe(true)
  })

  it('supports the Alt+Shift+D keyboard path and avoids it while typing', () => {
    harness = createHarness()
    const input = new FakeNode('input')
    harness.document.body.appendChild(input)

    const typingEvent = pointerEvent(input, [input, harness.document.body], {
      altKey: true,
      shiftKey: true,
      code: 'KeyD',
      key: 'd'
    })
    harness.dispatchDocument('keydown', typingEvent)
    expect(typingEvent.defaultPrevented).toBe(false)
    expect(harness.host.hidden).toBe(true)

    const shortcut = pointerEvent(harness.document.body, [harness.document.body], {
      altKey: true,
      shiftKey: true,
      code: 'KeyD',
      key: 'D'
    })
    harness.dispatchDocument('keydown', shortcut)
    expect(shortcut.defaultPrevented).toBe(true)
    expect(harness.host.hidden).toBe(false)
    expect(harness.document.activeElement).toBe(harness.trigger)
  })

  it('turns off through an explicit message and removes itself on the confirmed response', () => {
    harness = createHarness()
    pointerOver(harness.video)
    harness.trigger.dispatch('click', pointerEvent(harness.trigger, [harness.trigger]))
    expect(harness.panel.hidden).toBe(false)

    harness.disableButton.dispatch(
      'click',
      pointerEvent(harness.disableButton, [harness.disableButton, harness.panel])
    )

    expect(
      harness.sentMessages.filter(
        (message) => message.type === 'dondownload:overlay-disable-site'
      )
    ).toEqual([
      {
        type: 'dondownload:overlay-disable-site',
        origin: 'https://example.com'
      }
    ])
    expect(harness.host.parentNode).toBeNull()
  })

  it('announces readiness so the worker can track the tab for external revoke', () => {
    harness = createHarness()
    expect(harness.sentMessages).toContainEqual({
      type: 'dondownload:overlay-ready',
      origin: 'https://example.com'
    })
  })

  it('only tears down for a disabled message carrying the exact page origin', () => {
    harness = createHarness()
    pointerOver(harness.video)
    expect(harness.host.hidden).toBe(false)

    harness.dispatchRuntimeMessage({
      type: 'dondownload:overlay-disabled',
      origin: 'https://other.example'
    })
    expect(harness.host.parentNode).not.toBeNull()
    expect(harness.host.hidden).toBe(false)

    harness.dispatchRuntimeMessage({
      type: 'dondownload:overlay-disabled',
      origin: 'https://example.com'
    })
    expect(harness.host.parentNode).toBeNull()
  })
})

function collectText(node: FakeNode): string[] {
  const values: string[] = []
  if (node.textContent) values.push(node.textContent)
  for (const child of node.children) values.push(...collectText(child))
  return values
}

function collectByClass(node: FakeNode, className: string): FakeNode[] {
  const values: FakeNode[] = []
  if (node.className === className) values.push(node)
  for (const child of node.children) values.push(...collectByClass(child, className))
  return values
}

/**
 * Simulate a real click on a quality <label>: the click bubbles to the panel
 * and, unless a handler cancels it, the browser activates the nested radio and
 * fires a change event.
 */
function clickQualityLabel(label: FakeNode): any {
  const input = label.children.find((child) => child.tagName === 'INPUT')
  if (!input) throw new Error('expected a radio input inside the quality label')

  const click = pointerEvent(label, [label, harness.qualityList, harness.panel])
  label.dispatch('click', click)
  harness.qualityList.dispatch('click', click)
  harness.panel.dispatch('click', click)

  if (!click.defaultPrevented) {
    for (const other of collectByClass(harness.qualityList, 'quality-input')) {
      other.checked = other === input
    }
    input.dispatch('change', pointerEvent(input, [input, label, harness.panel]))
  }
  return click
}

describe('overlay media flow', () => {
  it('analyzes only on the explicit button and renders verified response options', () => {
    harness = createHarness({
      analyzeResponse: { ok: true, analysis: fakeAnalysis() },
      deferMediaResponses: true
    })
    openPanel(harness)

    expect(
      harness.sentMessages.filter((message) =>
        String(message.type).startsWith('dondownload:media-')
      )
    ).toEqual([])

    harness.analyzeButton.dispatch(
      'click',
      pointerEvent(harness.analyzeButton, [harness.analyzeButton, harness.panel])
    )

    expect(harness.sentMessages).toContainEqual({
      type: 'dondownload:media-analyze'
    })
    expect(harness.analyzeButton.disabled).toBe(true)
    expect(harness.panel.getAttribute('aria-busy')).toBe('true')
    expect(harness.status.textContent).toMatch(/Analyzing this page/)
    expect(harness.mediaResults.hidden).toBe(true)

    harness.flushMediaResponses()

    expect(harness.analyzeButton.disabled).toBe(false)
    expect(harness.panel.getAttribute('aria-busy')).toBe('false')
    expect(harness.mediaResults.hidden).toBe(false)
    expect(harness.mediaTitle.textContent).toBe('Verified example media')
    expect(harness.bestVideoButton.hidden).toBe(false)
    expect(harness.bestAudioButton.hidden).toBe(false)

    const rendered = JSON.stringify(collectText(harness.mediaResults))
    expect(rendered).toContain('1080p MP4 - H.264 + AAC')
    expect(rendered).toContain('720p MP4 - H.264 + AAC')
    expect(rendered).toContain('Audio only - Opus')
    expect(rendered).toContain('1080p · MP4')
    // Sizes come from the verified response. Exact values have no prefix, a
    // merged/approximate value is labelled, and missing metadata stays plain.
    expect(rendered).toContain('9.77 KB')
    expect(rendered).toContain('~7.81 KB estimated')
    expect(rendered).toContain('Size unknown')
    expect(harness.bestVideoButton.textContent).toContain('9.77 KB')
    expect(harness.bestAudioButton.textContent).toContain('Size unknown')
    expect(harness.status.textContent).toMatch(/Analysis ready/)
    expect(harness.status.textContent).toMatch(/reported by yt-dlp/i)
  })

  it('keeps each quality size visible and does not queue from analysis alone', () => {
    harness = createHarness({
      analyzeResponse: { ok: true, analysis: fakeAnalysis() }
    })
    openPanel(harness)
    harness.analyzeButton.dispatch(
      'click',
      pointerEvent(harness.analyzeButton, [harness.analyzeButton, harness.panel])
    )

    // Analysis is a choice step: it must never queue a download by itself.
    expect(
      harness.sentMessages.filter((message) => message.type === 'dondownload:media-queue')
    ).toEqual([])

    const labels = collectByClass(harness.qualityList, 'quality-option')
    const inputs = collectByClass(harness.qualityList, 'quality-input')
    expect(labels).toHaveLength(2)
    expect(inputs.map((input) => input.name)).toEqual([
      'dondownload-quality',
      'dondownload-quality'
    ])
    expect(harness.qualityFieldset.children[0]?.textContent).toMatch(
      /Choose a video quality/
    )

    const exactText = JSON.stringify(collectText(labels[0]!))
    const estimatedText = JSON.stringify(collectText(labels[1]!))
    expect(exactText).toContain('9.77 KB')
    expect(exactText).not.toContain('estimated')
    expect(estimatedText).toContain('~7.81 KB estimated')
  })

  it('states Size unknown for a video option without reported metadata', () => {
    const analysis = fakeAnalysis()
    analysis.options[0] = {
      ...analysis.options[0],
      filesizeBytes: null,
      estimatedBytes: null,
      sizeIsEstimate: false
    }
    harness = createHarness({ analyzeResponse: { ok: true, analysis } })
    openPanel(harness)
    harness.analyzeButton.dispatch(
      'click',
      pointerEvent(harness.analyzeButton, [harness.analyzeButton, harness.panel])
    )

    const rendered = JSON.stringify(collectText(harness.mediaResults))
    expect(rendered).toContain('Size unknown')
    expect(harness.bestVideoButton.textContent).toContain('Size unknown')
  })

  it('turns a native media tool failure into an actionable next step', () => {
    harness = createHarness({
      analyzeResponse: {
        ok: false,
        error: {
          code: 'MEDIA_TOOL_UNAVAILABLE',
          message: 'yt-dlp could not be started.'
        }
      }
    })
    openPanel(harness)
    harness.analyzeButton.dispatch(
      'click',
      pointerEvent(harness.analyzeButton, [harness.analyzeButton, harness.panel])
    )

    expect(harness.status.textContent).toContain('yt-dlp could not be started.')
    expect(harness.status.textContent).toContain('yt-dlp is available')
    expect(harness.status.className).toBe('status error')
    expect(harness.mediaResults.hidden).toBe(true)
  })

  it('queues the best video + audio option in one click', () => {
    harness = createHarness({
      analyzeResponse: { ok: true, analysis: fakeAnalysis() },
      queueResponse: {
        ok: true,
        job: fakeJob(BEST_VIDEO_ID, '1080p MP4 - H.264 + AAC')
      }
    })
    openPanel(harness)
    harness.analyzeButton.dispatch(
      'click',
      pointerEvent(harness.analyzeButton, [harness.analyzeButton, harness.panel])
    )

    harness.bestVideoButton.dispatch(
      'click',
      pointerEvent(harness.bestVideoButton, [harness.bestVideoButton, harness.panel])
    )

    expect(harness.sentMessages).toContainEqual({
      type: 'dondownload:media-queue',
      analysisId: ANALYSIS_ID,
      optionId: BEST_VIDEO_ID
    })
    expect(harness.status.textContent).toBe('Queued: 1080p MP4 - H.264 + AAC')
    expect(harness.status.className).toBe('status success')
  })

  it('queues an explicit audio-only option', () => {
    harness = createHarness({
      analyzeResponse: { ok: true, analysis: fakeAnalysis() },
      queueResponse: {
        ok: true,
        job: fakeJob(BEST_AUDIO_ID, 'Audio only - Opus')
      }
    })
    openPanel(harness)
    harness.analyzeButton.dispatch(
      'click',
      pointerEvent(harness.analyzeButton, [harness.analyzeButton, harness.panel])
    )

    harness.bestAudioButton.dispatch(
      'click',
      pointerEvent(harness.bestAudioButton, [harness.bestAudioButton, harness.panel])
    )

    expect(harness.sentMessages).toContainEqual({
      type: 'dondownload:media-queue',
      analysisId: ANALYSIS_ID,
      optionId: BEST_AUDIO_ID
    })
    expect(harness.status.textContent).toBe('Queued: Audio only - Opus')
  })

  it('queues a selectable quality chosen from the response only', () => {
    harness = createHarness({
      analyzeResponse: { ok: true, analysis: fakeAnalysis() },
      queueResponse: {
        ok: true,
        job: fakeJob(OTHER_VIDEO_ID, '720p MP4 - H.264 + AAC')
      }
    })
    openPanel(harness)
    harness.analyzeButton.dispatch(
      'click',
      pointerEvent(harness.analyzeButton, [harness.analyzeButton, harness.panel])
    )

    const labels = collectByClass(harness.qualityList, 'quality-option')
    expect(labels).toHaveLength(2)
    const inputs = collectByClass(harness.qualityList, 'quality-input')
    expect(inputs[0]?.checked).toBe(true)

    const secondLabel = labels[1]
    if (!secondLabel) throw new Error('expected a second quality option')
    const click = clickQualityLabel(secondLabel)

    // Panel-level isolation must not cancel the browser's label/radio
    // activation, or the change handler never runs.
    expect(click.defaultPrevented).toBe(false)
    expect(click.propagationStopped).toBe(true)
    expect(inputs[0]?.checked).toBe(false)
    expect(inputs[1]?.checked).toBe(true)

    harness.queueSelectedButton.dispatch(
      'click',
      pointerEvent(harness.queueSelectedButton, [
        harness.queueSelectedButton,
        harness.panel
      ])
    )

    expect(harness.sentMessages).toContainEqual({
      type: 'dondownload:media-queue',
      analysisId: ANALYSIS_ID,
      optionId: OTHER_VIDEO_ID
    })
    expect(harness.status.textContent).toBe('Queued: 720p MP4 - H.264 + AAC')
  })

  it('shows safe analysis and queue failures without inventing options', () => {
    harness = createHarness({
      analyzeResponse: {
        ok: false,
        error: { code: 'NATIVE_HOST_FAILED', message: 'Start DonDownload and try again.' }
      }
    })
    openPanel(harness)
    harness.analyzeButton.dispatch(
      'click',
      pointerEvent(harness.analyzeButton, [harness.analyzeButton, harness.panel])
    )

    expect(harness.mediaResults.hidden).toBe(true)
    expect(harness.status.textContent).toMatch(/Start DonDownload/)
    expect(harness.status.className).toBe('status error')

    harness = createHarness({
      analyzeResponse: { ok: true, analysis: { title: 'x', options: 'not-a-list' } }
    })
    openPanel(harness)
    harness.analyzeButton.dispatch(
      'click',
      pointerEvent(harness.analyzeButton, [harness.analyzeButton, harness.panel])
    )
    expect(harness.mediaResults.hidden).toBe(true)
    expect(harness.status.textContent).toMatch(/not valid/i)
  })

  it('shows a safe queue failure and keeps the verified options usable', () => {
    harness = createHarness({
      analyzeResponse: { ok: true, analysis: fakeAnalysis() },
      queueResponse: {
        ok: false,
        error: { code: 'DUPLICATE_DOWNLOAD', message: 'Already queued.' }
      }
    })
    openPanel(harness)
    harness.analyzeButton.dispatch(
      'click',
      pointerEvent(harness.analyzeButton, [harness.analyzeButton, harness.panel])
    )
    harness.bestVideoButton.dispatch(
      'click',
      pointerEvent(harness.bestVideoButton, [harness.bestVideoButton, harness.panel])
    )

    expect(harness.status.textContent).toBe('Already queued.')
    expect(harness.status.className).toBe('status error')
    expect(harness.bestVideoButton.disabled).toBe(false)
    expect(harness.mediaResults.hidden).toBe(false)
  })
})

describe('overlay source guardrails', () => {
  it('uses Shadow DOM, observers, reduced motion and propagation guards', () => {
    expect(uiSource).toContain('attachShadow')
    expect(uiSource).toContain('MutationObserver')
    expect(uiSource).toContain('ResizeObserver')
    expect(uiSource).toContain('prefers-reduced-motion')
    expect(uiSource).toContain('stopPropagation')
    expect(uiSource).toContain('fullscreenchange')
    expect(uiSource).toContain('pointer-events: auto')
  })

  it('never reads media sources, sniffs network traffic or controls playback', () => {
    const bridgeSource = readFileSync(path.join(extensionDir, 'bridge.js'), 'utf8')
    const mediaBridgeSource = readFileSync(
      path.join(extensionDir, 'media-bridge.js'),
      'utf8'
    )
    const mediaContractSource = readFileSync(
      path.join(extensionDir, 'media-contract.js'),
      'utf8'
    )

    for (const source of [
      uiSource,
      coreSource,
      bridgeSource,
      mediaBridgeSource,
      mediaContractSource
    ]) {
      expect(source).not.toMatch(/\.play\s*\(/)
      expect(source).not.toMatch(/\.pause\s*\(/)
      expect(source).not.toMatch(/\.currentSrc\b/)
      expect(source).not.toMatch(/\.srcObject\b/)
      expect(source).not.toMatch(/\bvideo\.src\b/)
      expect(source).not.toMatch(/captureStream/)
      expect(source).not.toMatch(/chrome\.downloads/)
      expect(source).not.toMatch(/webRequest/)
      expect(source).not.toMatch(/\bfetch\s*\(/)
      expect(source).not.toMatch(/document\.cookie/)
      expect(source).not.toMatch(/\.innerHTML\b/)
    }
  })
})
