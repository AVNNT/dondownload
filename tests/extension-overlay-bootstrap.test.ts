import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

const bootstrapSource = readFileSync(
  path.join(process.cwd(), 'extension', 'overlay-bootstrap.js'),
  'utf8'
)

type Listener = (event?: any, sender?: unknown, respond?: (value: unknown) => void) => unknown

interface Harness {
  sandbox: Record<string, any>
  sent: Array<{ message: any; callback?: (response: any) => void }>
  documentListeners: Map<string, Listener[]>
  runtimeListeners: Listener[]
  shown: unknown[]
  runs: { sync: number; toggle: number }
  respondEnsure(response: any): void
}

function createHarness(options: { video?: unknown; fullActive?: boolean } = {}): Harness {
  const sent: Harness['sent'] = []
  const documentListeners = new Map<string, Listener[]>()
  const runtimeListeners: Listener[] = []
  const shown: unknown[] = []
  const runs = { sync: 0, toggle: 0 }

  const document = {
    querySelector(selector: string) {
      expect(selector).toBe('video')
      return options.video ?? null
    },
    addEventListener(type: string, listener: Listener) {
      const list = documentListeners.get(type) ?? []
      list.push(listener)
      documentListeners.set(type, list)
    },
    removeEventListener(type: string, listener: Listener) {
      const list = documentListeners.get(type) ?? []
      const index = list.indexOf(listener)
      if (index >= 0) list.splice(index, 1)
    }
  }

  const chrome = {
    runtime: {
      lastError: undefined,
      sendMessage(message: any, callback?: (response: any) => void) {
        sent.push({ message, callback })
      },
      onMessage: {
        addListener(listener: Listener) {
          runtimeListeners.push(listener)
        },
        removeListener(listener: Listener) {
          const index = runtimeListeners.indexOf(listener)
          if (index >= 0) runtimeListeners.splice(index, 1)
        }
      }
    }
  }

  const sandbox: Record<string, any> = {
    document,
    chrome,
    location: { origin: 'https://example.com' },
    console
  }
  sandbox.globalThis = sandbox
  if (options.fullActive === true) {
    sandbox.__dondownloadOverlayRuntime = { active: true, disabled: false }
  }
  sandbox.DonDownloadOverlay = {
    started: true,
    showFor(video: unknown) {
      shown.push(video)
    },
    showForEmbed(frame: unknown) {
      shown.push(frame)
    },
    syncFloatingTrigger() {
      runs.sync += 1
    },
    handleToggleCommand() {
      runs.toggle += 1
      return true
    }
  }
  vm.createContext(sandbox)
  vm.runInContext(bootstrapSource, sandbox)

  return {
    sandbox,
    sent,
    documentListeners,
    runtimeListeners,
    shown,
    runs,
    respondEnsure(response: any) {
      const ensure = sent.find((entry) => entry.message.type === 'dondownload:overlay-ensure')
      if (!ensure || !ensure.callback) throw new Error('no ensure request was sent')
      ensure.callback(response)
    }
  }
}

function dispatch(documentListeners: Map<string, Listener[]>, type: string, event: any) {
  for (const listener of [...(documentListeners.get(type) ?? [])]) listener(event)
}

describe('all-sites overlay bootstrap', () => {
  it('stays inert on a page without a player: one script, no observers, no DOM', () => {
    const harness = createHarness()
    // Only the ready announcement crossed the worker boundary.
    expect(harness.sent.map((entry) => entry.message.type)).toEqual([
      'dondownload:overlay-ready'
    ])
    expect(harness.documentListeners.get('pointerover')).toHaveLength(1)
    expect(harness.documentListeners.get('play')).toHaveLength(1)
    expect(harness.documentListeners.get('playing')).toHaveLength(1)
    expect(harness.documentListeners.get('loadedmetadata')).toHaveLength(1)
    expect(harness.runtimeListeners).toHaveLength(1)
    expect(harness.shown).toHaveLength(0)
  })

  it('loads the full overlay from a hover over a player', () => {
    const harness = createHarness()
    const video = { tagName: 'VIDEO', isConnected: true }
    dispatch(harness.documentListeners, 'pointerover', {
      target: video,
      composedPath: () => [video]
    })
    expect(harness.runtimeListeners).toHaveLength(1)

    expect(
      harness.sent.some((entry) => entry.message.type === 'dondownload:overlay-ensure')
    ).toBe(true)
    harness.respondEnsure({ ok: true, ready: true })

    expect(harness.shown).toEqual([video])
    // Its own listeners are gone; the full runtime owns every later event.
    expect(harness.documentListeners.get('pointerover')).toHaveLength(0)
    expect(harness.runtimeListeners).toHaveLength(0)
  })

  it('replies to a popup ensure only after the full overlay is installed', () => {
    const harness = createHarness()
    const responses: unknown[] = []
    const listener = harness.runtimeListeners[0]
    if (!listener) throw new Error('bootstrap did not install a runtime listener')
    listener(
      { type: 'dondownload:overlay-ensure' },
      {},
      (value: unknown) => responses.push(value)
    )
    expect(responses).toHaveLength(0)

    harness.respondEnsure({ ok: true, ready: true })
    expect(responses).toEqual([{ ok: true, ready: true }])
    expect(harness.runs.sync).toBe(1)
  })

  it('does nothing when the full overlay is already installed', () => {
    const harness = createHarness({ fullActive: true })
    expect(harness.sent).toHaveLength(0)
    expect(harness.documentListeners.get('pointerover')).toBeUndefined()
    expect(harness.runtimeListeners).toHaveLength(0)
  })

  it('stops permanently for an excluded origin', () => {
    const harness = createHarness()
    const video = { tagName: 'VIDEO', isConnected: true }
    dispatch(harness.documentListeners, 'pointerover', {
      target: video,
      composedPath: () => [video]
    })
    harness.respondEnsure({
      ok: false,
      error: { code: 'EXCLUDED', message: 'off' }
    })
    expect(harness.shown).toHaveLength(0)
    expect(harness.documentListeners.get('pointerover')).toHaveLength(0)
  })
})
