import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const script = path.join(process.cwd(), 'scripts', 'register-native-host.ps1')
const hostPath = path.join(process.cwd(), 'native', 'dondownload-native-host.exe')
const available =
  process.platform === 'win32' && existsSync(script) && existsSync(hostPath)
const describeWindows = available ? describe : describe.skip

interface Manifest {
  name: string
  description: string
  path: string
  type: string
  allowed_origins: string[]
}

interface RegistrationPlan {
  mode: 'register' | 'unregister'
  hostPath: string
  manifestPath: string
  browsers: Array<{
    browser: string
    registryKey: string
    sharesKeyWith: string[]
    note: string
  }>
}

const chromeCompatibleKey =
  'HKCU:\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.dondownload.bridge'
const edgeKey =
  'HKCU:\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.dondownload.bridge'

function runScript(args: string[]): {
  status: number | null
  stdout: string
  stderr: string
} {
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      script,
      ...args
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 20_000
    }
  )
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? ''
  }
}

describeWindows('native host registration manifest', () => {
  it('writes an exact allowed_origins entry and an executable path', () => {
    const id = 'abcdefghijklmnopabcdefghijklmnop'
    const result = runScript([
      '-PrintManifest',
      '-ExtensionId',
      id,
      '-HostPath',
      hostPath
    ])

    expect(result.status).toBe(0)
    const manifest = JSON.parse(result.stdout) as Manifest
    expect(manifest.name).toBe('com.dondownload.bridge')
    expect(manifest.type).toBe('stdio')
    expect(manifest.path).toBe(hostPath)
    expect(manifest.path.endsWith('.exe')).toBe(true)
    expect(manifest.allowed_origins).toEqual([`chrome-extension://${id}/`])
    expect(manifest.allowed_origins.join(',')).not.toContain('*')
  })

  it('defaults to the fixed extension ID when none is passed', () => {
    const result = runScript(['-PrintManifest', '-HostPath', hostPath])

    expect(result.status).toBe(0)
    const manifest = JSON.parse(result.stdout) as Manifest
    expect(manifest.allowed_origins).toEqual([
      'chrome-extension://mikinloaillialkiannpcejdbmfbljhm/'
    ])
  })

  it('supports separate exact Chrome and Edge extension IDs', () => {
    const first = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const second = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    const result = runScript([
      '-PrintManifest',
      '-ExtensionId',
      `${first},${second}`,
      '-HostPath',
      hostPath
    ])

    expect(result.status).toBe(0)
    const manifest = JSON.parse(result.stdout) as Manifest
    expect(manifest.allowed_origins).toEqual([
      `chrome-extension://${first}/`,
      `chrome-extension://${second}/`
    ])
  })

  it('maps explicit Helium registration to the verified Chrome-compatible key', () => {
    const result = runScript([
      '-PrintRegistration',
      '-Browser',
      'Helium',
      '-ExtensionId',
      'efakbfgkcnfjpomeejapmhpaihompngo',
      '-HostPath',
      hostPath
    ])

    expect(result.status).toBe(0)
    const plan = JSON.parse(result.stdout) as RegistrationPlan
    expect(plan.mode).toBe('register')
    expect(plan.hostPath).toBe(hostPath)
    expect(plan.browsers).toHaveLength(1)
    expect(plan.browsers[0]).toMatchObject({
      browser: 'Helium',
      registryKey: chromeCompatibleKey,
      sharesKeyWith: ['Chrome']
    })
    expect(JSON.stringify(plan)).not.toContain('Helium\\NativeMessagingHosts')
  })

  it('uses the same Chrome-compatible key when unregistering Helium', () => {
    const result = runScript([
      '-PrintRegistration',
      '-Unregister',
      '-Browser',
      'Helium'
    ])

    expect(result.status).toBe(0)
    const plan = JSON.parse(result.stdout) as RegistrationPlan
    expect(plan.mode).toBe('unregister')
    expect(plan.browsers).toEqual([
      expect.objectContaining({
        browser: 'Helium',
        registryKey: chromeCompatibleKey
      })
    ])
  })

  it('preserves the Chrome and Edge keys and both-browser selection', () => {
    const chrome = JSON.parse(
      runScript(['-PrintRegistration', '-Browser', 'Chrome']).stdout
    ) as RegistrationPlan
    const edge = JSON.parse(
      runScript(['-PrintRegistration', '-Browser', 'Edge']).stdout
    ) as RegistrationPlan
    const both = JSON.parse(
      runScript(['-PrintRegistration', '-Browser', 'Both']).stdout
    ) as RegistrationPlan

    expect(chrome.browsers).toEqual([
      expect.objectContaining({ browser: 'Chrome', registryKey: chromeCompatibleKey })
    ])
    expect(edge.browsers).toEqual([
      expect.objectContaining({ browser: 'Edge', registryKey: edgeKey })
    ])
    expect(both.browsers.map((target) => target.browser)).toEqual([
      'Chrome',
      'Edge'
    ])
  })

  it('prints an exact allowed origin for the verified Helium extension ID', () => {
    const id = 'efakbfgkcnfjpomeejapmhpaihompngo'
    const result = runScript([
      '-PrintManifest',
      '-ExtensionId',
      id,
      '-HostPath',
      hostPath
    ])

    expect(result.status).toBe(0)
    const manifest = JSON.parse(result.stdout) as Manifest
    expect(manifest.allowed_origins).toEqual([`chrome-extension://${id}/`])
  })

  it('rejects an unknown browser selection', () => {
    const result = runScript([
      '-PrintRegistration',
      '-Browser',
      'HeliumSpecific',
      '-ExtensionId',
      'efakbfgkcnfjpomeejapmhpaihompngo',
      '-HostPath',
      hostPath
    ])

    expect(result.status).not.toBe(0)
  })

  it.each([
    ['wildcard', '*'],
    ['short id', 'abc123'],
    ['non-alphabet characters', 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'],
    ['origin instead of id', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/']
  ])('rejects an invalid %s extension ID', (_label, id) => {
    const result = runScript(['-PrintManifest', '-ExtensionId', id, '-HostPath', hostPath])
    expect(result.status).not.toBe(0)
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/invalid extension id/i)
  })

  it('rejects a non-executable manifest path', () => {
    const result = runScript([
      '-PrintManifest',
      '-ExtensionId',
      'abcdefghijklmnopabcdefghijklmnop',
      '-HostPath',
      path.join(process.cwd(), 'README.md')
    ])
    expect(result.status).not.toBe(0)
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/must be a real \.exe/i)
  })
})
