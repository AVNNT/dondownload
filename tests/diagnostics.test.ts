import { describe, expect, it } from 'vitest'
import { buildDiagnostics, DIAGNOSTICS_LOG_LINES } from '../src/main/diagnostics'
import { defaultDownloadSettings } from '../src/shared/settings'
import { defaultDesktopSettings } from '../src/shared/desktopSettings'

const PROFILE = 'C:\\Users\\Ada'
const URL = 'https://example.com/private/holiday-clip.mp4?token=abc123'
const FILE = `${PROFILE}\\Downloads\\holiday-clip.mp4`
const FOLDER = `${PROFILE}\\Downloads`
const USER_FOLDER = `${PROFILE}\\Downloads\\DonDownload`

function input(overrides: Partial<Parameters<typeof buildDiagnostics>[0]> = {}) {
  return {
    appVersion: '1.1.0',
    windowsVersion: 'Windows 11 Pro',
    windowsBuild: '10.0.22631',
    arch: 'x64',
    packaged: true,
    runtime: { electron: '45.2.2', chrome: '140.0.0.0', node: '22.20.0' },
    tools: {
      aria2: { version: '1.37.0', status: 'ready' },
      media: { version: 'yt-dlp 2024.11.18; ffmpeg 7.1', status: 'ready' }
    },
    downloadSettings: defaultDownloadSettings(),
    desktopSettings: defaultDesktopSettings(),
    dbSchemaVersion: 21,
    debugLogging: false,
    logLines: [],
    extension: null,
    appUpdate: null,
    ytdlpUpdate: null,
    ...overrides
  }
}

describe('diagnostics content', () => {
  it('includes every non-personal fact a maintainer needs', () => {
    const text = buildDiagnostics(input())
    expect(text).toContain('App version: 1.1.0')
    expect(text).toContain('Windows: Windows 11 Pro (build 10.0.22631, x64)')
    expect(text).toContain('Packaged build: yes')
    expect(text).toContain('Electron 45.2.2')
    expect(text).toContain('aria2: 1.37.0 (ready)')
    expect(text).toContain('yt-dlp 2024.11.18; ffmpeg 7.1 (ready)')
    expect(text).toContain(
      'Settings: parallel downloads 3, connections per server 16, theme oled'
    )
    expect(text).toContain('History database schema: 21')
    expect(text).toContain('Debug logging: off')
    expect(text).toContain('Idle tray hand-off: on')
    expect(text).toContain('clipboard watching off')
  })

  it('reports extension state per browser', () => {
    const text = buildDiagnostics(
      input({
        extension: {
          registered: false,
          browsers: [
            { browser: 'Chrome', registered: true, registryKey: 'k', shared: false },
            { browser: 'Helium', registered: true, registryKey: 'k', shared: true },
            { browser: 'Edge', registered: false, registryKey: 'k', shared: false },
            { browser: 'Firefox', registered: false, registryKey: 'k', shared: false }
          ],
          hostPath: FOLDER,
          manifestPath: FILE,
          allowedOrigins: [],
          firefoxManifestPath: FILE,
          firefoxAddonId: 'addon@example.com',
          allowedExtensions: [],
          extensionFolder: FOLDER,
          extensionId: 'abcdef',
          lastError: 'registry key missing'
        }
      })
    )
    expect(text).toContain(
      'Browser extension: incomplete; Chrome: connected, Helium: connected, Edge: not connected, Firefox: not connected (last error: registry key missing)'
    )
    expect(text).not.toContain(FOLDER)
    expect(text).not.toContain('abcdef')
  })

  it('describes missing tools without inventing a version', () => {
    const text = buildDiagnostics(
      input({
        tools: {
          aria2: { version: null, status: 'unavailable' },
          media: { version: null, status: 'error' }
        },
        dbSchemaVersion: null
      })
    )
    expect(text).toContain('aria2: not available (unavailable)')
    expect(text).toContain('Media tools: not available (error)')
    expect(text).toContain('History database schema: unavailable')
  })

  it('keeps only the newest log lines', () => {
    const logLines = Array.from({ length: 500 }, (_, index) => `line ${index}`)
    const text = buildDiagnostics(input({ logLines }))
    const tail = text.split('\n')
    expect(text).toContain(`line ${499}`)
    expect(text).toContain(`line ${500 - DIAGNOSTICS_LOG_LINES}`)
    expect(text).not.toContain('line 399\n')
    expect(text).toContain(`last ${DIAGNOSTICS_LOG_LINES} of 500 lines`)
    expect(tail.length).toBeGreaterThan(DIAGNOSTICS_LOG_LINES)
  })
})

describe('diagnostics privacy', () => {
  it('never leaks URLs, file names or user paths from any source', () => {
    // Fixture values deliberately carry every sensitive shape the app can
    // hold: a download URL with a token, a file path, a folder path, a Cookie
    // and an Authorization value. The builder must only ever emit redacted or
    // boolean/numeric facts.
    const poisoned = [
      `download ${URL} completed`,
      `saved ${FILE}`,
      `folder ${USER_FOLDER}`,
      'Cookie: SID=abc123; CSRF=xyz',
      'Authorization: Bearer abcdefghijklmnop',
      `${PROFILE}\\AppData\\Roaming\\dondownload\\downloads.sqlite3 failed`
    ]
    const text = buildDiagnostics(input({ logLines: poisoned }))

    expect(text).not.toContain('holiday-clip')
    expect(text).not.toContain('example.com/private')
    expect(text).not.toContain('token=abc123')
    expect(text).not.toContain('Ada')
    expect(text).not.toContain('CSRF')
    expect(text).not.toContain('abcdefghijklmnop')
    expect(text).not.toContain('downloads.sqlite3')
    // A bare private IPv4 or a path drive letter is also not useful here.
    expect(text).not.toMatch(/\b[A-Z]:\\/)
  })

  it('never includes settings, tool paths or history', () => {
    const text = buildDiagnostics(input())
    for (const forbidden of [
      'downloadDir',
      'ytdlpPath',
      'ffmpegPath',
      'installer',
      FILE
    ]) {
      expect(text).not.toContain(forbidden)
    }
  })
})
