import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CHROME_NATIVE_HOST_REGISTRY_KEY,
  EDGE_NATIVE_HOST_REGISTRY_KEY
} from '../src/shared/browserExtension'
import {
  DONDOWNLOAD_EXTENSION_ID
} from '../src/shared/extensionId'
import {
  createRegExeRegistry,
  nativeManifestPath,
  registerNativeHost,
  unregisterNativeHost,
  type ExecFileLike,
  type NativeHostRegistry,
  type RegistrationDependencies,
  type RegistrationFileSystem
} from '../src/main/nativeHost/registration'

const APP_DATA = 'C:\\Users\\test\\AppData\\Roaming'
const MANIFEST_PATH = nativeManifestPath(APP_DATA)
const EXTENSION_ORIGIN = `chrome-extension://${DONDOWNLOAD_EXTENSION_ID}/`
const VALID_ID = 'a'.repeat(32)
const ROOT = 'C:\\repo'
const RESOURCES = 'C:\\Program Files\\DonDownload\\resources'

class FakeRegistry implements NativeHostRegistry {
  readonly data = new Map<string, string>()
  readonly reads: string[] = []
  readonly writes: Array<{ key: string; value: string }> = []
  readonly removes: string[] = []
  failWriteKey: string | null = null
  failRemoveKey: string | null = null

  async readDefault(key: string): Promise<string | null> {
    this.reads.push(key)
    return this.data.get(key) ?? null
  }

  async writeDefault(key: string, value: string): Promise<void> {
    if (key === this.failWriteKey) throw new Error('Access is denied.')
    this.writes.push({ key, value })
    this.data.set(key, value)
  }

  async removeKey(key: string): Promise<void> {
    if (key === this.failRemoveKey) throw new Error('Access is denied.')
    this.removes.push(key)
    this.data.delete(key)
  }
}

class FakeFileSystem implements RegistrationFileSystem {
  readonly files = new Map<string, string>()
  readonly existingExecutables = new Set<string>()
  readonly writes: Array<{ path: string; contents: string }> = []
  readonly removed: string[] = []

  async readFile(filePath: string): Promise<string | null> {
    return this.files.get(filePath) ?? null
  }

  async writeFileAtomic(filePath: string, contents: string): Promise<void> {
    this.writes.push({ path: filePath, contents })
    this.files.set(filePath, contents)
  }

  async removeFile(filePath: string): Promise<void> {
    this.removed.push(filePath)
    this.files.delete(filePath)
  }

  async exists(filePath: string): Promise<boolean> {
    return this.files.has(filePath) || this.existingExecutables.has(filePath)
  }
}

function dependencies(overrides: Partial<RegistrationDependencies> = {}): {
  deps: RegistrationDependencies
  registry: FakeRegistry
  fs: FakeFileSystem
} {
  const registry = new FakeRegistry()
  const fs = new FakeFileSystem()
  return {
    registry,
    fs,
    deps: {
      appDataPath: APP_DATA,
      isPackaged: true,
      resourcesPath: RESOURCES,
      appPath: ROOT,
      execPath: 'C:\\Program Files\\DonDownload\\DonDownload.exe',
      registry,
      fileSystem: fs,
      platform: 'win32',
      ...overrides
    }
  }
}

function readManifest(fs: FakeFileSystem): {
  name: string
  description: string
  path: string
  type: string
  allowed_origins: string[]
} {
  const raw = fs.files.get(MANIFEST_PATH)
  if (raw === undefined) throw new Error('manifest was not written')
  return JSON.parse(raw) as ReturnType<typeof readManifest>
}

describe('native messaging auto-registration', () => {
  it('writes a fresh manifest with only the fixed exact origin and both keys', async () => {
    const { deps, registry, fs } = dependencies()

    const status = await registerNativeHost(deps)

    expect(status.registered).toBe(true)
    expect(status.lastError).toBeNull()
    expect(status.hostPath).toBe(
      path.join(RESOURCES, 'native', 'dondownload-native-host.exe')
    )
    expect(status.allowedOrigins).toEqual([EXTENSION_ORIGIN])
    expect(status.browsers).toEqual([
      expect.objectContaining({ browser: 'Chrome', registered: true }),
      expect.objectContaining({ browser: 'Helium', registered: true }),
      expect.objectContaining({ browser: 'Edge', registered: true })
    ])

    const manifest = readManifest(fs)
    expect(manifest.path.endsWith('dondownload-native-host.exe')).toBe(true)
    expect(manifest.allowed_origins).toEqual([EXTENSION_ORIGIN])
    expect(manifest.allowed_origins.join(',')).not.toContain('*')
    expect(registry.writes).toEqual([
      { key: CHROME_NATIVE_HOST_REGISTRY_KEY, value: MANIFEST_PATH },
      { key: EDGE_NATIVE_HOST_REGISTRY_KEY, value: MANIFEST_PATH }
    ])
  })

  it('keeps existing valid origins and drops invalid or wildcard entries', async () => {
    const { deps, fs } = dependencies()
    const existingHost = path.join(ROOT, 'native', 'dondownload-native-host.exe')
    fs.existingExecutables.add(existingHost)
    fs.files.set(
      MANIFEST_PATH,
      JSON.stringify({
        name: 'com.dondownload.bridge',
        path: existingHost,
        allowed_origins: [
          `chrome-extension://${VALID_ID}/`,
          '*',
          'chrome-extension://not-an-id/',
          `chrome-extension://${VALID_ID}/`,
          'https://example.com/'
        ]
      })
    )

    const status = await registerNativeHost(deps)
    const manifest = readManifest(fs)

    expect(manifest.path).toBe(existingHost)
    expect(manifest.allowed_origins).toEqual([
      `chrome-extension://${VALID_ID}/`,
      EXTENSION_ORIGIN
    ])
    expect(status.allowedOrigins).toEqual(manifest.allowed_origins)
    expect(manifest.allowed_origins).not.toContain('*')
  })

  it('does not rewrite the manifest or registry on a second identical run', async () => {
    const { deps, registry, fs } = dependencies()

    await registerNativeHost(deps)
    const firstWriteCount = fs.writes.length
    const firstRegistryWriteCount = registry.writes.length

    const second = await registerNativeHost(deps)

    expect(second.registered).toBe(true)
    expect(fs.writes).toHaveLength(firstWriteCount)
    expect(registry.writes).toHaveLength(firstRegistryWriteCount)
  })

  it('falls back to the app executable when the existing path is missing or not the host', async () => {
    for (const existingPath of [
      'C:\\old\\not-the-host.exe',
      path.join(ROOT, 'native', 'dondownload-native-host.exe')
    ]) {
      const { deps, fs } = dependencies()
      fs.files.set(
        MANIFEST_PATH,
        JSON.stringify({
          path: existingPath,
          allowed_origins: [EXTENSION_ORIGIN]
        })
      )

      const status = await registerNativeHost(deps)
      expect(status.hostPath).toBe(
        path.join(RESOURCES, 'native', 'dondownload-native-host.exe')
      )
    }
  })

  it('uses the repository executable in the dev app', async () => {
    const { deps } = dependencies({ isPackaged: false })
    const status = await registerNativeHost(deps)
    expect(status.hostPath).toBe(
      path.join(ROOT, 'native', 'dondownload-native-host.exe')
    )
  })

  it('surfaces a reg.exe write failure as status instead of throwing', async () => {
    const { deps, registry } = dependencies()
    registry.failWriteKey = EDGE_NATIVE_HOST_REGISTRY_KEY

    const status = await registerNativeHost(deps)

    expect(status.registered).toBe(false)
    expect(status.lastError).toContain('Access is denied')
    expect(
      status.browsers.find((browser) => browser.browser === 'Edge')?.registered
    ).toBe(false)
  })
})

describe('native messaging uninstall cleanup', () => {
  const installDir = 'C:\\Program Files\\DonDownload'
  const execPath = path.join(installDir, 'DonDownload.exe')

  function seeded(pathValue: string): {
    deps: RegistrationDependencies
    registry: FakeRegistry
    fs: FakeFileSystem
  } {
    const { deps, registry, fs } = dependencies({ execPath })
    fs.files.set(
      MANIFEST_PATH,
      JSON.stringify({
        name: 'com.dondownload.bridge',
        path: pathValue,
        allowed_origins: [EXTENSION_ORIGIN]
      })
    )
    registry.data.set(CHROME_NATIVE_HOST_REGISTRY_KEY, MANIFEST_PATH)
    registry.data.set(EDGE_NATIVE_HOST_REGISTRY_KEY, MANIFEST_PATH)
    return { deps, registry, fs }
  }

  it('removes both keys and the manifest when the path is inside the install dir', async () => {
    const { deps, registry, fs } = seeded(
      path.join(installDir, 'native', 'dondownload-native-host.exe')
    )

    const result = await unregisterNativeHost(deps)

    expect(result).toEqual({ removed: true, reason: 'removed', lastError: null })
    expect(registry.removes).toEqual([
      CHROME_NATIVE_HOST_REGISTRY_KEY,
      EDGE_NATIVE_HOST_REGISTRY_KEY
    ])
    expect(fs.removed).toEqual([MANIFEST_PATH])
    expect(registry.data.size).toBe(0)
  })

  it('leaves a dev registration and both keys alone when the path is outside the install dir', async () => {
    const { deps, registry, fs } = seeded(
      path.join(ROOT, 'native', 'dondownload-native-host.exe')
    )

    const result = await unregisterNativeHost(deps)

    expect(result.removed).toBe(false)
    expect(result.reason).toBe('outside-install-dir')
    expect(registry.removes).toEqual([])
    expect(fs.removed).toEqual([])
    expect(fs.files.has(MANIFEST_PATH)).toBe(true)
  })

  it('does nothing when no manifest exists', async () => {
    const { deps, registry, fs } = dependencies({ execPath })
    const result = await unregisterNativeHost(deps)
    expect(result.reason).toBe('no-manifest')
    expect(registry.removes).toEqual([])
    expect(fs.removed).toEqual([])
  })
})

describe('reg.exe adapter', () => {
  function fakeExec(
    responses: Array<{ error: Error | null; stdout?: string; stderr?: string }>
  ): { calls: Array<{ file: string; args: readonly string[] }>; exec: ExecFileLike } {
    const calls: Array<{ file: string; args: readonly string[] }> = []
    let index = 0
    const exec: ExecFileLike = (file, args, _options, callback) => {
      calls.push({ file, args })
      const response = responses[index] ?? { error: null, stdout: '' }
      index += 1
      callback(response.error, response.stdout ?? '', response.stderr ?? '')
    }
    return { calls, exec }
  }

  it('reads and writes the default value using argument arrays and no shell', async () => {
    const { calls, exec } = fakeExec([
      {
        error: null,
        stdout: `${CHROME_NATIVE_HOST_REGISTRY_KEY}\r\n    (Default)    REG_SZ    ${MANIFEST_PATH}\r\n`
      },
      { error: null, stdout: 'The operation completed successfully.\r\n' }
    ])
    const registry = createRegExeRegistry(exec)

    expect(await registry.readDefault(CHROME_NATIVE_HOST_REGISTRY_KEY)).toBe(
      MANIFEST_PATH
    )
    await registry.writeDefault(CHROME_NATIVE_HOST_REGISTRY_KEY, MANIFEST_PATH)

    expect(calls[0]).toEqual({
      file: 'reg.exe',
      args: ['query', CHROME_NATIVE_HOST_REGISTRY_KEY, '/ve']
    })
    expect(calls[1]).toEqual({
      file: 'reg.exe',
      args: [
        'add',
        CHROME_NATIVE_HOST_REGISTRY_KEY,
        '/ve',
        '/t',
        'REG_SZ',
        '/d',
        MANIFEST_PATH,
        '/f'
      ]
    })
  })
})
