import { describe, expect, it } from 'vitest'
import type { BrowserExtensionStatus } from '../src/shared/browserExtension'
import type { DetectedBrowser } from '../src/main/browsers/detect'
import { buildWelcomeInfo } from '../src/main/welcome/info'

function detected(
  id: DetectedBrowser['id'],
  connectionRow: DetectedBrowser['connectionRow']
): DetectedBrowser {
  return {
    id,
    label: id,
    engine: id === 'firefox' || id === 'zen' ? 'gecko' : 'chromium',
    connectionRow,
    executablePath: `C:\\Browsers\\${id}.exe`
  }
}

function extension(
  registered: Record<'Chrome' | 'Edge' | 'Helium' | 'Firefox', boolean>
): BrowserExtensionStatus {
  const rows: BrowserExtensionStatus['browsers'] = (
    ['Chrome', 'Helium', 'Edge', 'Firefox'] as const
  ).map((browser) => ({
    browser,
    registered: registered[browser],
    registryKey: `HKCU\\Software\\${browser}`,
    shared: browser === 'Helium'
  }))
  return {
    registered: Object.values(registered).every(Boolean),
    browsers: rows,
    hostPath: 'C:\\host.exe',
    manifestPath: 'C:\\manifest.json',
    allowedOrigins: ['chrome-extension://abc/'],
    firefoxManifestPath: 'C:\\firefox.json',
    firefoxAddonId: 'addon@example',
    allowedExtensions: ['addon@example'],
    extensionFolder: 'C:\\extension',
    extensionId: 'abcdefghijklmnop',
    lastError: null
  }
}

describe('first-start browser status', () => {
  it('maps forks to the registration row that serves them', () => {
    const info = buildWelcomeInfo({
      downloadDir: 'C:\\Downloads\\DonDownload',
      browsers: [
        detected('chrome', 'Chrome'),
        detected('brave', 'Chrome'),
        detected('firefox', 'Firefox'),
        detected('zen', 'Firefox')
      ],
      extension: extension({
        Chrome: true,
        Helium: false,
        Edge: false,
        Firefox: false
      })
    })

    expect(info.downloadDir).toBe('C:\\Downloads\\DonDownload')
    expect(info.extensionBundled).toBe(true)
    expect(info.browsers.map((browser) => [browser.id, browser.connected])).toEqual(
      [
        ['chrome', true],
        ['brave', true],
        ['firefox', false],
        ['zen', false]
      ]
    )
    expect(info.browsers[1]?.connectionRow).toBe('Chrome')
    expect(info.browsers[3]?.connectionRow).toBe('Firefox')
  })

  it('reports every browser as unconnected without a registrar', () => {
    const info = buildWelcomeInfo({
      downloadDir: 'C:\\Downloads',
      browsers: [detected('chrome', 'Chrome')],
      extension: null
    })
    expect(info.browsers[0]?.connected).toBe(false)
    expect(info.extensionBundled).toBe(false)
  })

  it('keeps an empty list empty', () => {
    const info = buildWelcomeInfo({
      downloadDir: 'C:\\Downloads',
      browsers: [],
      extension: extension({
        Chrome: true,
        Helium: true,
        Edge: true,
        Firefox: true
      })
    })
    expect(info.browsers).toEqual([])
  })
})
