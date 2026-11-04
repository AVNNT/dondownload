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
