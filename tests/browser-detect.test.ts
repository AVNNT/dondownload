import { describe, expect, it } from 'vitest'
import {
  WINDOWS_BROWSERS,
  detectInstalledBrowsers,
  expandWindowsPath
} from '../src/main/browsers/detect'

const ENV = {
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local'
}

function existing(...files: string[]): (candidate: string) => boolean {
  const set = new Set(files.map((file) => file.toLowerCase()))
  return (candidate) => set.has(candidate.toLowerCase())
}

describe('Windows browser detection', () => {
  it('finds each browser from its conventional install folder', () => {
    const found = detectInstalledBrowsers({
      platform: 'win32',
      env: ENV,
      fileExists: existing(
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Users\\tester\\AppData\\Local\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
        'C:\\Users\\tester\\AppData\\Local\\imput\\Helium\\Application\\chrome.exe',
        'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
        'C:\\Program Files\\Zen Browser\\zen.exe'
      )
    })

    expect(found.map((browser) => browser.id)).toEqual([
      'chrome',
      'edge',
      'brave',
      'helium',
      'firefox',
      'zen'
    ])
    expect(found[0]).toMatchObject({
      label: 'Chrome',
      engine: 'chromium',
      connectionRow: 'Chrome',
      executablePath:
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    })
    expect(found[4]).toMatchObject({ engine: 'gecko', connectionRow: 'Firefox' })
    expect(found[5]).toMatchObject({ engine: 'gecko', connectionRow: 'Firefox' })
  })

  it('reports nothing when no executable exists', () => {
    expect(
      detectInstalledBrowsers({
        platform: 'win32',
        env: ENV,
        fileExists: () => false
      })
    ).toEqual([])
  })

  it('skips a candidate whose environment variable is missing', () => {
    expect(
      detectInstalledBrowsers({
        platform: 'win32',
        env: { ProgramFiles: 'C:\\PF' },
        fileExists: (candidate) => {
          // Only the literal Program Files Chrome path may be probed.
          expect(candidate.startsWith('C:\\PF')).toBe(true)
          return candidate === 'C:\\PF\\Google\\Chrome\\Application\\chrome.exe'
        }
      }).map((browser) => browser.id)
    ).toEqual(['chrome'])
  })

  it('uses App Paths when the injected reader finds a custom install', () => {
    const found = detectInstalledBrowsers({
      platform: 'win32',
      env: ENV,
      fileExists: existing('D:\\Apps\\Firefox\\firefox.exe'),
      registry: {
        readAppPath: (executable) =>
          executable === 'firefox.exe' ? 'D:\\Apps\\Firefox\\firefox.exe' : null
      }
    })

    expect(found).toHaveLength(1)
    expect(found[0]?.executablePath).toBe('D:\\Apps\\Firefox\\firefox.exe')
  })

  it('ignores a registry value that does not exist on disk', () => {
    const found = detectInstalledBrowsers({
      platform: 'win32',
      env: ENV,
      fileExists: () => false,
      registry: { readAppPath: () => 'D:\\Missing\\chrome.exe' }
    })
    expect(found).toEqual([])
  })

  it('survives a registry reader that throws', () => {
    const found = detectInstalledBrowsers({
      platform: 'win32',
      env: ENV,
      fileExists: () => false,
      registry: {
        readAppPath: () => {
          throw new Error('no registry')
        }
      }
    })
    expect(found).toEqual([])
  })

  it('never detects on another platform', () => {
    let probes = 0
    const found = detectInstalledBrowsers({
      platform: 'linux',
      env: ENV,
      fileExists: () => {
        probes += 1
        return true
      }
    })
    expect(found).toEqual([])
    expect(probes).toBe(0)
  })

  it('expands variables case-insensitively and rejects incomplete paths', () => {
    expect(
      expandWindowsPath('%programfiles%\\Brave\\brave.exe', ENV)
    ).toBe('C:\\Program Files\\Brave\\brave.exe')
    expect(expandWindowsPath('%MISSING%\\chrome.exe', ENV)).toBeNull()
    expect(
      expandWindowsPath('%LOCALAPPDATA%\\Google\\Chrome\\chrome.exe', {
        LOCALAPPDATA: ''
      })
    ).toBeNull()
  })

  it('keeps the definition table free of duplicate ids', () => {
    const ids = WINDOWS_BROWSERS.map((browser) => browser.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
