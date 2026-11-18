import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const extensionDir = path.join(process.cwd(), 'extension')

/**
 * Firefox runs the same ES modules as a non-persistent event page. API calls
 * that exist only in Chromium would throw or silently do nothing there, so the
 * extension must not start using them without an explicit Firefox path.
 *
 * `chrome.*` itself is fine: Firefox implements the namespace and returns
 * promises when no callback is supplied.
 */
const CHROMIUM_ONLY_APIS = [
  'chrome.offscreen',
  'chrome.declarativeNetRequest',
  'chrome.runtime.getContexts',
  'chrome.sidePanel',
  'chrome.identity',
  'chrome.tabs.captureVisibleTab',
  'chrome.webRequest.filterResponseData',
  'chrome.downloads.onDeterminingFilename.download',
  'browser_action',
  'page_action'
]

async function extensionSources(): Promise<Array<{ name: string; text: string }>> {
  const entries = await readdir(extensionDir, { withFileTypes: true })
  const files = entries
    .filter((entry) => entry.isFile() && /\.(js|html)$/.test(entry.name))
    .map((entry) => entry.name)
  const sources = []
  for (const name of files) {
    sources.push({ name, text: await readFile(path.join(extensionDir, name), 'utf8') })
  }
  return sources
}

describe('Firefox extension compatibility', () => {
  it('does not call APIs that Firefox does not implement', async () => {
    const sources = await extensionSources()
    for (const api of CHROMIUM_ONLY_APIS) {
      for (const source of sources) {
        expect(
          source.text.includes(api),
          `${source.name} must not use ${api}`
        ).toBe(false)
      }
    }
  })

  it('keeps the onCreated fallback when onDeterminingFilename is unavailable', async () => {
    const handoff = await readFile(path.join(extensionDir, 'handoff.js'), 'utf8')

    // Firefox has no downloads.onDeterminingFilename. The listener setup must
    // feature-detect it, and onCreated must be registered independently.
    expect(handoff).toMatch(/const holdsFilenames =\s*downloads\.onDeterminingFilename/)
    expect(handoff).toMatch(/if \(holdsFilenames\) \{/)
    expect(handoff).toMatch(/const hasCreated = downloads\.onCreated/)
    expect(handoff).toMatch(/if \(hasCreated\) \{/)
  })

  it('detects the background context from either an event page or a worker', async () => {
    const bridge = await readFile(path.join(extensionDir, 'bridge.js'), 'utf8')
    // The native transport must not assume a service worker global.
    expect(bridge).toMatch(/typeof chrome === 'undefined'/)
  })
})
