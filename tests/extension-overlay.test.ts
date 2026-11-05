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
  MIN_IFRAME_WIDTH: number
  MIN_IFRAME_HEIGHT: number
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
  findIframeInPath: (path: unknown[]) => unknown
  evaluateIframeCandidate: (
    candidate: {
      tagName?: string
      isConnected?: boolean
      hidden?: boolean
      src?: string
      rect?: Rect
      styles?: { display?: string; visibility?: string; opacity?: string }
    },
    viewport: { width: number; height: number }
  ) => { usable: boolean; reason: string; url?: string }
  shouldOfferPageAnalysis: (
    sources: Array<{ url: string }>,
    unsupported: unknown
  ) => boolean
  optionById: (
    view: {
      options: Array<{ optionId: string; label: string }>
    } | null,
    optionId: unknown
  ) => { optionId: string; label: string } | null
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
    { URL }
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

  it('detects only large, visible, http(s) top-frame embeds', () => {
    const rect = { left: 100, top: 80, width: 640, height: 360 }
    const embedded = core.evaluateIframeCandidate(
      { tagName: 'IFRAME', isConnected: true, src: 'https://player.example/embed/1', rect },
      viewport
    )
    expect(embedded).toMatchObject({
      usable: true,
      url: 'https://player.example/embed/1'
    })

    for (const candidate of [
      { tagName: 'DIV', isConnected: true, src: 'https://player.example/embed/1', rect },
      { tagName: 'IFRAME', isConnected: false, src: 'https://player.example/embed/1', rect },
      { tagName: 'IFRAME', isConnected: true, hidden: true, src: 'https://player.example/embed/1', rect },
      { tagName: 'IFRAME', isConnected: true, src: 'blob:https://example.com/x', rect },
      { tagName: 'IFRAME', isConnected: true, src: 'data:text/html,x', rect },
      { tagName: 'IFRAME', isConnected: true, src: 'https://user:pw@player.example/e', rect },
      { tagName: 'IFRAME', isConnected: true, src: 'https://player.example/e', rect: { ...rect, width: core.MIN_IFRAME_WIDTH - 1 } },
      { tagName: 'IFRAME', isConnected: true, src: 'https://player.example/e', rect: { ...rect, height: core.MIN_IFRAME_HEIGHT - 1 } },
      {
        tagName: 'IFRAME',
        isConnected: true,
        src: 'https://player.example/e',
        rect,
        styles: { display: 'none' }
      },
      {
        tagName: 'IFRAME',
        isConnected: true,
        src: 'https://player.example/e',
        rect: { left: -2000, top: 0, width: 640, height: 360 }
      }
    ]) {
      expect(core.evaluateIframeCandidate(candidate, viewport).usable).toBe(false)
    }

    expect(
      core.findIframeInPath([{ tagName: 'DIV' }, { tagName: 'IFRAME' }])
    ).toEqual({ tagName: 'IFRAME' })
    expect(core.findIframeInPath([{ tagName: 'VIDEO' }])).toBeNull()
  })

  it('offers page analysis only when no progressive source was captured', () => {
    expect(core.shouldOfferPageAnalysis([], null)).toBe(true)
    expect(core.shouldOfferPageAnalysis([], { code: 'MANIFEST_STREAM' })).toBe(true)
    expect(
      core.shouldOfferPageAnalysis(
        [{ url: 'https://cdn.example/clip.mp4' }],
        { code: 'MANIFEST_STREAM' }
      )
    ).toBe(true)
    expect(
      core.shouldOfferPageAnalysis([{ url: 'https://cdn.example/clip.mp4' }], null)
    ).toBe(false)
  })

  it('pins an option identifier and never falls back to another quality', () => {
    const view = {
      options: [
        { optionId: 'option_1080', label: '1080p' },
        { optionId: 'option_720', label: '720p' }
      ]
    }
    expect(core.optionById(view, 'option_720')).toEqual(view.options[1])
    expect(core.optionById(view, 'option_missing')).toBeNull()
    expect(core.optionById(view, '')).toBeNull()
    expect(core.optionById(null, 'option_720')).toBeNull()
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
    expect(copy.detail).toMatch(/actually played/i)
    expect(copy.detail).toMatch(/never reads/i)
    expect(copy.actionLabel).toBe('Find qualities with DonDownload')

    const serialized = JSON.stringify(copy)
    for (const fabricated of ['1080p', '720p', '4K', 'MP4', 'audio only']) {
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
  currentSrc = ''
  src = ''
  paused = true
  readyState = 0
  ended = false
  error: unknown = null
  videoWidth = 0
  videoHeight = 0
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
  location: any
  host: FakeNode
  trigger: FakeNode
  panel: FakeNode
  sourceSection: FakeNode
  sourceList: FakeNode
  sourceEmpty: FakeNode
  analyzeButton: FakeNode
  embedAnalyzeButton: FakeNode
  mediaResults: FakeNode
  mediaTitle: FakeNode
  mediaMeta: FakeNode
  bestVideoButton: FakeNode
  bestAudioButton: FakeNode
  qualityFieldset: FakeNode
  qualityList: FakeNode
  advancedQualityList: FakeNode
  outputFormatControl: FakeNode
  outputFormatSelect: FakeNode
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
  dispatchRuntimeMessage: (message: any, respond?: (value: any) => void) => void
  runTimers: () => void
  flushMediaResponses: () => void
  findByClass: (className: string) => FakeNode | null
}

interface HarnessOptions {
  analyzeResponse?: any
  queueResponse?: any
  captureResponse?: any
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
      if (selector !== 'video' && selector !== 'iframe') return []
      return document.body.children.filter(
        (child: FakeNode) => child.tagName === selector.toUpperCase()
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
        if (
          message.type === 'dondownload:media-analyze' ||
          message.type === 'dondownload:media-analyze-embed'
        ) {
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
        if (message.type === 'dondownload:capture-queue') {
          const response = options.captureResponse ?? { ok: true }
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
    location: { origin: 'https://example.com', href: 'https://example.com/watch?v=1' },
    URL,
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
  const sourceSection = findByClass('sources')
  const sourceList = findByClass('source-list')
  const sourceEmpty = findByClass('source-empty')
  const analyzeButton = findByClass('action')
  const embedAnalyzeButton = findByClass('action secondary embed-analyze')
  const mediaResults = findByClass('media-results')
  const mediaTitle = findByClass('media-title')
  const mediaMeta = findByClass('media-meta')
  const bestVideoButton = findByClass('action best-video')
  const bestAudioButton = findByClass('action secondary best-audio')
  const qualityFieldset = findByClass('qualities')
  const qualityList = findByClass('quality-list')
  const advancedQualityList = findByClass('advanced-quality-list')
  const outputFormatControl = findByClass('output-format')
  const outputFormatSelect = findByClass('output-format-select')
  const queueSelectedButton = findByClass('action secondary queue-selected')
  const disableButton = findByClass('disable')
  const status = findByClass('status')
  if (
    !trigger ||
    !panel ||
    !sourceSection ||
    !sourceList ||
    !sourceEmpty ||
    !analyzeButton ||
    !embedAnalyzeButton ||
    !mediaResults ||
    !mediaTitle ||
    !mediaMeta ||
    !bestVideoButton ||
    !bestAudioButton ||
    !qualityFieldset ||
    !qualityList ||
    !advancedQualityList ||
    !outputFormatControl ||
    !outputFormatSelect ||
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
    location: sandbox.location,
    host,
    trigger,
    panel,
    sourceSection,
    sourceList,
    sourceEmpty,
    analyzeButton,
    embedAnalyzeButton,
    mediaResults,
    mediaTitle,
    mediaMeta,
    bestVideoButton,
    bestAudioButton,
    qualityFieldset,
    qualityList,
    advancedQualityList,
    outputFormatControl,
    outputFormatSelect,
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
    dispatchRuntimeMessage(message, respond) {
      for (const listener of [...runtimeListeners]) {
        ;(listener as any)(message, {}, respond)
      }
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

function playVideo(
  video: FakeNode,
  currentSrc: string,
  overrides: { paused?: boolean; readyState?: number; ended?: boolean; error?: unknown } = {}
): void {
  video.currentSrc = currentSrc
  video.paused = overrides.paused ?? false
  video.readyState = overrides.readyState ?? 4
  video.ended = overrides.ended ?? false
  video.error = overrides.error ?? null
  video.dispatch('playing', pointerEvent(video, [video]))
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
    expect(panelText).toMatch(/find qualities with dondownload/i)
    expect(panelText).toMatch(/detected from playback/i)
    expect(panelText).toMatch(/no progressive playback detected yet/i)
    // Explanatory copy names the handled streaming formats; it never shows a
    // fabricated resolution or a guessed option.
    expect(panelText).not.toMatch(/1080p|720p|4K/)

    // Opening the panel never invokes yt-dlp or any native call; it only shows
    // already observed playback sources for this exact player.
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

    // Only passive playback events are observed; playback is never controlled
    // and the video element itself is not modified.
    expect(Object.keys(harness.video.style)).toHaveLength(0)
    expect(Object.keys(harness.video.listeners).sort()).toEqual([
      'emptied',
      'ended',
      'loadeddata',
      'pause',
      'playing',
      'timeupdate'
    ])
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

  it('does not intercept a page Alt+Shift+D keydown from the DOM', () => {
    harness = createHarness()
    const input = new FakeNode('input')
    harness.document.body.appendChild(input)

    const shortcut = pointerEvent(harness.document.body, [harness.document.body], {
      altKey: true,
      shiftKey: true,
      code: 'KeyD',
      key: 'D'
    })
    harness.dispatchDocument('keydown', shortcut)
    expect(shortcut.defaultPrevented).toBe(false)
    expect(harness.host.hidden).toBe(true)

    // The browser command path is the supported shortcut; it arrives as an
    // extension runtime message, not as a page keydown.
    let toggled: any = null
    harness.dispatchRuntimeMessage(
      { type: 'dondownload:overlay-toggle' },
      (value: any) => {
        toggled = value
      }
    )
    expect(toggled).toEqual({ ok: true })
    expect(harness.host.hidden).toBe(false)
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

  it('toggles from the command and answers trusted popup source queries without page tab ids', () => {
    harness = createHarness()
    harness.video.currentSrc = 'https://cdn.example/movie-1080.mp4'
    harness.video.paused = false
    harness.video.readyState = 2
    harness.video.videoWidth = 1920
    harness.video.videoHeight = 1080

    // Persistent floating icon: no pointer hover, just a playing player.
    harness.mutationObserver.trigger()
    harness.video.dispatch('playing', pointerEvent(harness.video, [harness.video]))
    expect(harness.host.hidden).toBe(false)
    expect(harness.trigger.hidden).toBe(false)

    let toggled: any = null
    harness.dispatchRuntimeMessage(
      { type: 'dondownload:overlay-toggle' },
      (value: any) => {
        toggled = value
      }
    )
    expect(toggled).toEqual({ ok: true })
    expect(harness.panel.hidden).toBe(false)

    let queried: any = null
    harness.dispatchRuntimeMessage(
      { type: 'dondownload:capture-query' },
      (value: any) => {
        queried = value
      }
    )
    expect(queried).toMatchObject({
      ok: true,
      origin: 'https://example.com',
      sources: [
        {
          filename: 'movie-1080.mp4',
          container: 'mp4',
          qualityLabel: '1080p',
          current: true
        }
      ]
    })
    expect(JSON.stringify(queried.sources)).not.toContain('blob:')
    expect(JSON.stringify(queried.sources)).not.toContain('m3u8')

    let closed: any = null
    harness.dispatchRuntimeMessage(
      { type: 'dondownload:overlay-toggle' },
      (value: any) => {
        closed = value
      }
    )
    expect(closed).toEqual({ ok: true })
    expect(harness.panel.hidden).toBe(true)
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
  it('runs the explicit analyzer fallback once and renders verified response options', () => {
    harness = createHarness({
      analyzeResponse: { ok: true, analysis: fakeAnalysis() },
      deferMediaResponses: true
    })
    openPanel(harness)

    // The capture panel is detected-source-first and does not start yt-dlp.
    expect(
      harness.sentMessages.filter((message) =>
        String(message.type).startsWith('dondownload:media-')
      )
    ).toEqual([])

    harness.analyzeButton.dispatch(
      'click',
      pointerEvent(harness.analyzeButton, [harness.analyzeButton, harness.panel])
    )
    expect(
      harness.sentMessages.filter((message) =>
        String(message.type).startsWith('dondownload:media-')
      )
    ).toEqual([{ type: 'dondownload:media-analyze' }])
    expect(harness.analyzeButton.disabled).toBe(true)
    expect(harness.panel.getAttribute('aria-busy')).toBe('true')
    expect(harness.status.textContent).toMatch(/Analyzing this page/)
    expect(harness.mediaResults.hidden).toBe(true)

    // Reopening/clicking while the same analysis is in flight must not create
    // a second request.
    harness.analyzeButton.dispatch(
      'click',
      pointerEvent(harness.analyzeButton, [harness.analyzeButton, harness.panel])
    )
    expect(
      harness.sentMessages.filter(
        (message) => message.type === 'dondownload:media-analyze'
      )
    ).toHaveLength(1)

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

  it('accumulates exact-player sources, deduplicates quality switches and resets on navigation', () => {
    harness = createHarness()
    openPanel(harness)

    playVideo(
      harness.video,
      'https://cdn.example/media/movie-1080.mp4?token=one'
    )
    expect(collectByClass(harness.sourceList, 'source')).toHaveLength(1)
    expect(JSON.stringify(collectText(harness.sourceList))).toContain('movie-1080.mp4')

    playVideo(
      harness.video,
      'https://cdn.example/media/movie-720.mp4?token=two'
    )
    let rows = collectByClass(harness.sourceList, 'source')
    expect(rows).toHaveLength(2)
    expect(rows[0]?.getAttribute('data-current')).toBe('true')
    expect(JSON.stringify(collectText(rows[0]!))).toContain('movie-720.mp4')

    // 1080p -> 720p -> 1080p keeps one row per exact URL and moves the current
    // source back to the top instead of adding a duplicate.
    playVideo(
      harness.video,
      'https://cdn.example/media/movie-1080.mp4?token=one'
    )
    rows = collectByClass(harness.sourceList, 'source')
    expect(rows).toHaveLength(2)
    expect(rows[0]?.getAttribute('data-current')).toBe('true')
    expect(JSON.stringify(collectText(rows[0]!))).toContain('movie-1080.mp4')

    // A second player's source is never mixed into the active player's list.
    const secondVideo = new FakeNode('video')
    secondVideo.rect = { left: 700, top: 100, width: 400, height: 220 }
    harness.document.body.appendChild(secondVideo)
    harness.mutationObserver.trigger()
    playVideo(secondVideo, 'https://cdn.example/media/other.webm')
    expect(collectByClass(harness.sourceList, 'source')).toHaveLength(2)
    expect(JSON.stringify(collectText(harness.sourceList))).not.toContain('other.webm')

    pointerOver(secondVideo)
    harness.trigger.dispatch(
      'click',
      pointerEvent(harness.trigger, [harness.trigger, harness.host])
    )
    expect(collectByClass(harness.sourceList, 'source')).toHaveLength(1)
    expect(JSON.stringify(collectText(harness.sourceList))).toContain('other.webm')

    // SPA navigation invalidates every source from the previous page.
    harness.location.href = 'https://example.com/next'
    harness.dispatchWindow('popstate', {})
    expect(collectByClass(harness.sourceList, 'source')).toHaveLength(0)
    expect(harness.sourceEmpty.hidden).toBe(false)
  })

  it('marks blob/MSE and manifest playback unsupported and never guesses a file', () => {
    harness = createHarness()
    openPanel(harness)

    playVideo(harness.video, 'blob:https://example.com/4a2c')
    let rows = collectByClass(harness.sourceList, 'source')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.getAttribute('data-unsupported')).toBe('true')
    expect(JSON.stringify(collectText(rows[0]!))).toMatch(/segmented|Media Source/i)
    expect(collectByClass(harness.sourceList, 'source-action')).toHaveLength(0)

    playVideo(harness.video, 'https://cdn.example/live/index.m3u8')
    rows = collectByClass(harness.sourceList, 'source')
    expect(rows[0]?.getAttribute('data-unsupported')).toBe('true')
    expect(JSON.stringify(collectText(rows[0]!))).toMatch(/HLS or DASH/i)

    // A later real progressive source replaces the unsupported notice.
    playVideo(harness.video, 'https://cdn.example/video/clip.webm')
    rows = collectByClass(harness.sourceList, 'source')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.getAttribute('data-unsupported')).toBeNull()
    expect(collectByClass(harness.sourceList, 'source-action')).toHaveLength(1)
  })

  it('queues one detected source with its exact filename and closes with subtle feedback', () => {
    harness = createHarness({ captureResponse: { ok: true } })
    openPanel(harness)
    playVideo(
      harness.video,
      'https://cdn.example/media/clip.mp4?sig=abc'
    )

    const buttons = collectByClass(harness.sourceList, 'source-action')
    expect(buttons).toHaveLength(1)
    buttons[0]?.dispatch(
      'click',
      pointerEvent(buttons[0]!, [buttons[0]!, harness.sourceList, harness.panel])
    )

    expect(harness.sentMessages).toContainEqual({
      type: 'dondownload:capture-queue',
      url: 'https://cdn.example/media/clip.mp4?sig=abc',
      filename: 'clip.mp4'
    })
    expect(harness.panel.hidden).toBe(true)
    expect(harness.trigger.textContent).toBe('OK')
    expect(
      harness.sentMessages.filter((message) =>
        String(message.type).startsWith('dondownload:media-')
      )
    ).toEqual([])
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
    expect(labels).toHaveLength(3)
    expect(labels.map((label) => JSON.stringify(collectText(label))).join(' ')).toContain('1080p')
    expect(labels.map((label) => JSON.stringify(collectText(label))).join(' ')).toContain('720p')
    expect(labels.map((label) => JSON.stringify(collectText(label))).join(' ')).toContain('Audio only')
    expect(inputs.map((input) => input.name)).toEqual([
      'dondownload-simple-quality',
      'dondownload-simple-quality',
      'dondownload-simple-quality'
    ])
    expect(harness.qualityFieldset.children[0]?.textContent).toMatch(
      /Choose a quality/
    )

    const exactText = JSON.stringify(collectText(labels[0]!))
    const estimatedText = JSON.stringify(collectText(labels[1]!))
    expect(exactText).toContain('9.77 KB')
    expect(exactText).not.toContain('estimated')
    expect(estimatedText).toContain('~7.81 KB estimated')
    expect(collectByClass(harness.advancedQualityList, 'quality-option')).toHaveLength(3)
    expect(JSON.stringify(collectText(harness.advancedQualityList))).toContain('H.264')
  })

  it('offers every verified height and only compatible output formats', () => {
    const analysis = fakeAnalysis()
    analysis.options = [
      {
        kind: 'video',
        optionId: 'option_video_2160',
        label: '2160p MP4 - H.264 + AAC',
        container: 'mp4',
        width: 3840,
        height: 2160,
        fps: 30,
        videoCodec: 'avc1',
        audioCodec: 'mp4a',
        hasAudio: true,
        requiresMerge: true,
        filesizeBytes: null,
        estimatedBytes: 2_000,
        sizeIsEstimate: true,
        outputFormats: ['auto', 'mp4', 'mkv', 'webm']
      },
      {
        kind: 'video',
        optionId: 'option_video_1080',
        label: '1080p MP4 - H.264 + AAC',
        container: 'mp4',
        width: 1920,
        height: 1080,
        fps: 30,
        videoCodec: 'avc1',
        audioCodec: 'mp4a',
        hasAudio: true,
        requiresMerge: true,
        filesizeBytes: null,
        estimatedBytes: 1_000,
        sizeIsEstimate: true,
        outputFormats: ['auto', 'mkv']
      },
      fakeAnalysis().options[2]
    ]
    analysis.bestVideoOptionId = 'option_video_2160'
    harness = createHarness({
      analyzeResponse: { ok: true, analysis },
      queueResponse: {
        ok: true,
        job: fakeJob('option_video_2160', '2160p MP4 - H.264 + AAC')
      }
    })
    openPanel(harness)
    harness.analyzeButton.dispatch(
      'click',
      pointerEvent(harness.analyzeButton, [harness.analyzeButton, harness.panel])
    )

    const labels = collectByClass(harness.qualityList, 'quality-option')
    expect(labels).toHaveLength(3)
    const rendered = labels.map((label) => JSON.stringify(collectText(label))).join(' ')
    expect(rendered).toContain('2160p')
    expect(rendered).toContain('1080p')
    expect(rendered).toContain('Audio only')

    // Best is the default selection and supports every advertised container.
    expect(collectByClass(harness.qualityList, 'quality-input')[0]?.checked).toBe(true)
    harness.outputFormatSelect.value = 'webm'
    harness.outputFormatSelect.dispatch(
      'change',
      pointerEvent(harness.outputFormatSelect, [
        harness.outputFormatSelect,
        harness.panel
      ])
    )
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
      optionId: 'option_video_2160',
      outputFormat: 'webm'
    })

    // A lower height only supports Auto/MKV, so WebM must be disabled rather
    // than silently substituted.
    const second = labels[1]
    if (!second) throw new Error('expected a second quality option')
    clickQualityLabel(second)
    expect(harness.outputFormatSelect.value).toBe('auto')
    const webm = harness.outputFormatSelect.children.find(
      (child) => child.value === 'webm'
    )
    expect(webm?.disabled).toBe(true)
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

  it('keeps the simple audio-only choice available when no video is offered', () => {
    const analysis = fakeAnalysis()
    analysis.options = analysis.options.filter((option: any) => option.kind === 'audio')
    analysis.bestVideoOptionId = null
    harness = createHarness({ analyzeResponse: { ok: true, analysis } })
    openPanel(harness)
    harness.analyzeButton.dispatch(
      'click',
      pointerEvent(harness.analyzeButton, [harness.analyzeButton, harness.panel])
    )

    expect(harness.bestVideoButton.hidden).toBe(true)
    expect(harness.qualityFieldset.hidden).toBe(false)
    expect(collectByClass(harness.qualityList, 'quality-option')).toHaveLength(1)
    expect(JSON.stringify(collectText(harness.qualityList))).toContain('Audio only')
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
      optionId: BEST_VIDEO_ID,
      outputFormat: 'auto'
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
      optionId: BEST_AUDIO_ID,
      outputFormat: 'auto'
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
    expect(labels).toHaveLength(3)
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
    const advancedInputs = collectByClass(harness.advancedQualityList, 'quality-input')
    expect(
      advancedInputs.find((input) => (input as any).mediaOptionId === OTHER_VIDEO_ID)?.checked
    ).toBe(true)

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
      optionId: OTHER_VIDEO_ID,
      outputFormat: 'auto'
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

  it('offers analysis for blob/MSE and manifest playback and queues the exact verified option', () => {
    harness = createHarness({
      analyzeResponse: { ok: true, analysis: fakeAnalysis() },
      queueResponse: {
        ok: true,
        job: fakeJob(BEST_VIDEO_ID, '1080p MP4 - H.264 + AAC')
      }
    })
    openPanel(harness)
    expect(harness.analyzeButton.hidden).toBe(false)
    expect(harness.analyzeButton.textContent).toBe('Find qualities with DonDownload')

    playVideo(harness.video, 'blob:https://example.com/4a2c')
    expect(harness.analyzeButton.hidden).toBe(false)
    expect(harness.analyzeButton.textContent).toBe('Find qualities with DonDownload')

    playVideo(harness.video, 'https://cdn.example/live/index.m3u8')
    expect(harness.analyzeButton.hidden).toBe(false)

    harness.analyzeButton.dispatch(
      'click',
      pointerEvent(harness.analyzeButton, [harness.analyzeButton, harness.panel])
    )
    // The top page is analyzed by the trusted sender URL; the content script
    // never supplies a blob, manifest, segment or header value.
    expect(harness.sentMessages).toContainEqual({
      type: 'dondownload:media-analyze'
    })
    expect(
      harness.sentMessages.find(
        (message) => message.type === 'dondownload:media-analyze'
      )
    ).toEqual({ type: 'dondownload:media-analyze' })

    const rendered = JSON.stringify(collectText(harness.mediaResults))
    expect(rendered).toContain('1080p')
    expect(rendered).toContain('720p')
    expect(rendered).toContain('MP4')
    expect(rendered).toContain('merged')
    expect(rendered).toContain('9.77 KB')

    // Each verified option exposes one-click download and sends exactly the
    // option identifier the user picked.
    const queueButtons = collectByClass(harness.qualityList, 'source-action quality-queue')
    expect(queueButtons).toHaveLength(3)
    queueButtons[1]?.dispatch(
      'click',
      pointerEvent(queueButtons[1]!, [queueButtons[1]!, harness.qualityList, harness.panel])
    )
    expect(harness.sentMessages).toContainEqual({
      type: 'dondownload:media-queue',
      analysisId: ANALYSIS_ID,
      optionId: OTHER_VIDEO_ID,
      outputFormat: 'auto'
    })
  })

  it('shows Analyze this page again for an expired pinned option without substituting a quality', () => {
    harness = createHarness({
      analyzeResponse: { ok: true, analysis: fakeAnalysis() },
      queueResponse: {
        ok: false,
        error: {
          code: 'MEDIA_ANALYSIS_EXPIRED',
          message: 'The media details expired. Analyze the page again.'
        }
      }
    })
    openPanel(harness)
    playVideo(harness.video, 'blob:https://example.com/expired')
    harness.analyzeButton.dispatch(
      'click',
      pointerEvent(harness.analyzeButton, [harness.analyzeButton, harness.panel])
    )

    const labels = collectByClass(harness.qualityList, 'quality-option')
    const second = labels[1]
    if (!second) throw new Error('expected a second verified option')
    clickQualityLabel(second)
    harness.queueSelectedButton.dispatch(
      'click',
      pointerEvent(harness.queueSelectedButton, [harness.queueSelectedButton, harness.panel])
    )

    const queued = harness.sentMessages.filter(
      (message) => message.type === 'dondownload:media-queue'
    )
    expect(queued).toEqual([
      {
        type: 'dondownload:media-queue',
        analysisId: ANALYSIS_ID,
        optionId: OTHER_VIDEO_ID,
        outputFormat: 'auto'
      }
    ])
    expect(harness.status.textContent).toContain('Analyze this page again')
    expect(harness.status.className).toBe('status error')
    expect(harness.mediaResults.hidden).toBe(true)
    expect(harness.analyzeButton.hidden).toBe(false)
  })

  it('offers analysis for a visible cross-origin embed without injecting into it', () => {
    harness = createHarness({ analyzeResponse: { ok: true, analysis: fakeAnalysis() } })
    const iframe = new FakeNode('iframe')
    iframe.src = 'https://player.example/embed/abc?x=1#fragment'
    iframe.rect = { left: 300, top: 120, width: 640, height: 360 }
    harness.document.body.appendChild(iframe)

    harness.dispatchDocument(
      'pointerover',
      pointerEvent(iframe, [iframe, harness.document.body, harness.document.documentElement])
    )
    harness.trigger.dispatch(
      'click',
      pointerEvent(harness.trigger, [harness.trigger, harness.host])
    )

    expect(harness.panel.hidden).toBe(false)
    expect(harness.embedAnalyzeButton.hidden).toBe(false)
    expect(harness.embedAnalyzeButton.textContent).toBe(
      'Find qualities for embedded video'
    )
    expect(harness.analyzeButton.hidden).toBe(true)

    harness.embedAnalyzeButton.dispatch(
      'click',
      pointerEvent(harness.embedAnalyzeButton, [
        harness.embedAnalyzeButton,
        harness.panel
      ])
    )
    expect(harness.sentMessages).toContainEqual({
      type: 'dondownload:media-analyze-embed',
      embedUrl: 'https://player.example/embed/abc?x=1'
    })
    expect(
      harness.sentMessages.some(
        (message) => message.type === 'dondownload:media-analyze'
      )
    ).toBe(false)

    const rendered = JSON.stringify(collectText(harness.mediaResults))
    expect(rendered).toContain('1080p')
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

  it('observes only the playing element currentSrc and never sniffs network traffic or controls playback', () => {
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
      expect(source).not.toMatch(/\.srcObject\b/)
      expect(source).not.toMatch(/\bvideo\.src\b/)
      expect(source).not.toMatch(/captureStream/)
      expect(source).not.toMatch(/chrome\.downloads/)
      expect(source).not.toMatch(/webRequest/)
      expect(source).not.toMatch(/\bfetch\s*\(/)
      expect(source).not.toMatch(/document\.cookie/)
      expect(source).not.toMatch(/\.innerHTML\b/)
      expect(source).not.toMatch(/performance\.getEntries/)
      expect(source).not.toMatch(/Authorization|Cookie:/)
    }

    // The only source read is currentSrc, and only on real playback events.
    expect(uiSource).toContain('currentSrc')
    expect(uiSource).toContain("'playing'")
    expect(uiSource).toContain("'timeupdate'")
  })
})
