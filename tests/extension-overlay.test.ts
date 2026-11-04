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

  it('states truthfully that media download and format choices are unavailable', () => {
    const copy = core.unavailableState()
    expect(copy.title).toMatch(/not available/i)
    expect(copy.detail).toMatch(/does not detect formats/i)
    expect(copy.detail).toMatch(/does not read media source URLs/i)
    expect(copy.detail).toMatch(/DRM/i)
    expect(copy.actionLabel).toMatch(/unavailable/i)

    const serialized = JSON.stringify(copy)
    for (const fabricated of [
      '1080p',
      '720p',
      '480p',
      '4K',
      'MP4',
      'WebM',
      'HLS',
      'DASH',
      'best quality',
      'audio only'
    ]) {
      expect(serialized).not.toContain(fabricated)
    }
    expect(serialized).not.toMatch(/"quality"\s*:/)
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
  disableButton: FakeNode
  video: FakeNode
  sentMessages: any[]
  mutationObserver: FakeMutationObserver
  resizeObserver: FakeResizeObserver
  timers: Array<() => void>
  dispatchDocument: (type: string, event: any) => void
  dispatchWindow: (type: string, event: any) => void
  dispatchRuntimeMessage: (message: any) => void
  runTimers: () => void
  findByClass: (className: string) => FakeNode | null
}

function createHarness(): Harness {
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
  const chrome = {
    runtime: {
      lastError: undefined,
      sendMessage(message: any, callback?: (response: any) => void) {
        sentMessages.push(message)
        if (callback) callback({ ok: true })
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
  const disableButton = findByClass('disable')
  if (!trigger || !panel || !disableButton) {
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
    disableButton,
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

    const panelText = JSON.stringify(
      collectText(harness.panel)
    )
    expect(panelText).toMatch(/not available/i)
    expect(panelText).toMatch(/does not detect formats/i)
    expect(panelText).not.toMatch(/1080p|720p|4K|MP4|HLS|DASH/)

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
    for (const source of [uiSource, coreSource]) {
      expect(source).not.toMatch(/\.play\s*\(/)
      expect(source).not.toMatch(/\.pause\s*\(/)
      expect(source).not.toMatch(/\.currentSrc\b/)
      expect(source).not.toMatch(/\.srcObject\b/)
      expect(source).not.toMatch(/\bvideo\.src\b/)
      expect(source).not.toMatch(/captureStream/)
      expect(source).not.toMatch(/chrome\.downloads/)
      expect(source).not.toMatch(/webRequest/)
      expect(source).not.toMatch(/\bfetch\s*\(/)
    }
  })
})
