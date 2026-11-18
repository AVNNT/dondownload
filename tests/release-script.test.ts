import { spawnSync } from 'node:child_process'
import { generateKeyPairSync, verify } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { extractZipArchive } from '../src/main/media/updater'
import {
  AMO_SIGNATURE_ENTRIES,
  WEB_EXT_VERSION,
  amoSignArguments,
  amoSignEnvironment,
  buildReleaseAssetList,
  createZipArchive,
  crc32,
  extractChangelogSection,
  extensionAssetNames,
  findAmoSignatureEntry,
  installerAssetName,
  installerBlockmapAssetName,
  isChecksummedAssetName,
  isExtensionPackageFile,
  listZipEntryNames,
  planAmoSigning,
  readAmoCredentials,
  releaseTag,
  releaseTagMatchesVersion,
  renderThirdPartySourcesText,
  selectChecksumFiles,
  selectExtensionFiles
} from '../scripts/release-lib.mjs'

const VERSION = '1.3.1'

const tempDirs: string[] = []

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

describe('release asset names', () => {
  it('matches the electron-builder artifactName and the updater pattern', () => {
    expect(installerAssetName(VERSION)).toBe(
      'DonDownload-1.3.1-x64-setup.exe'
    )
    expect(installerBlockmapAssetName(VERSION)).toBe(
      'DonDownload-1.3.1-x64-setup.exe.blockmap'
    )
    expect(releaseTag(VERSION)).toBe('v1.3.1')
    expect(extensionAssetNames(VERSION)).toEqual({
      chromium: 'dondownload-extension-chromium-1.3.1.zip',
      firefox: 'dondownload-extension-firefox-1.3.1.xpi'
    })
  })

  it('rejects versions that are not a release semver', () => {
    for (const invalid of ['1.0', 'v1.0.0', '', '1.0.0.0', null]) {
      expect(() => releaseTag(invalid as unknown as string)).toThrow()
    }
    expect(releaseTag('1.0.0-beta.1')).toBe('v1.0.0-beta.1')
  })

  it('builds the uploaded asset list in a stable order', () => {
    expect(buildReleaseAssetList({ version: VERSION })).toEqual([
      'DonDownload-1.3.1-x64-setup.exe',
      'dondownload-extension-chromium-1.3.1.zip',
      'dondownload-extension-firefox-1.3.1.xpi',
      'SHA256SUMS.txt',
      'SHA256SUMS.txt.sig',
      'THIRD-PARTY-SOURCES.txt'
    ])
  })

  it('matches the electron-builder artifactName template', async () => {
    const builderConfig = await readFile(
      path.join(process.cwd(), 'electron-builder.yml'),
      'utf8'
    )
    const template = 'DonDownload-${version}-${arch}-setup.${ext}'
    expect(builderConfig).toContain(`artifactName: ${template}`)
    expect(
      template
        .replace('${version}', VERSION)
        .replace('${arch}', 'x64')
        .replace('${ext}', 'exe')
    ).toBe(installerAssetName(VERSION))
  })

  it('includes the optional blockmap and source archives', () => {    const assets = buildReleaseAssetList({
      version: VERSION,
      hasBlockmap: true,
      sourceArchives: ['aria2-1.37.0.tar.bz2']
    })
    expect(assets).toContain('DonDownload-1.3.1-x64-setup.exe.blockmap')
    expect(assets[assets.length - 1]).toBe('aria2-1.37.0.tar.bz2')
    expect(assets).toHaveLength(8)
  })
})

describe('checksummed files', () => {
  it('hashes installers and extension packages only, installers first', () => {
    const selection = selectChecksumFiles([
      'SHA256SUMS.txt',
      'SHA256SUMS.txt.sig',
      'THIRD-PARTY-SOURCES.txt',
      'dondownload-extension-firefox-1.3.1.xpi',
      'DonDownload-1.3.1-x64-setup.exe.blockmap',
      'dondownload-extension-chromium-1.3.1.zip',
      'DonDownload-1.3.1-x64-setup.exe',
      'builder-debug.yml'
    ])
    expect(selection.installers).toEqual([
      'DonDownload-1.3.1-x64-setup.exe'
    ])
    expect(selection.extensions).toEqual([
      'dondownload-extension-chromium-1.3.1.zip',
      'dondownload-extension-firefox-1.3.1.xpi'
    ])
    expect(selection.all[0]).toBe('DonDownload-1.3.1-x64-setup.exe')
    expect(isChecksummedAssetName('builder-debug.yml')).toBe(false)
    expect(
      isChecksummedAssetName('dondownload-extension-firefox-1.3.1.xpi')
    ).toBe(true)
  })
})

describe('extension package contents', () => {
  it('keeps runtime files and drops declarations, tests and maps', () => {
    const selected = selectExtensionFiles([
      'manifest.json',
      'background.js',
      'bridge.d.ts',
      'bridge.js',
      'overlay.test.js',
      'icons/icon16.png',
      'icons\\icon32.png',
      'popup.css.map',
      'nested/.hidden',
      '../escape.js',
      '/absolute.js'
    ])
    expect(selected).toEqual([
      'background.js',
      'bridge.js',
      'icons/icon16.png',
      'icons/icon32.png',
      'manifest.json'
    ])
    expect(isExtensionPackageFile('bridge.d.ts')).toBe(false)
    expect(isExtensionPackageFile('icons/icon16.png')).toBe(true)
    expect(isExtensionPackageFile('../escape.js')).toBe(false)
  })
})

describe('zip writer', () => {
  it('packages the real extension directory with the manifest at the root', async () => {
    const extensionDir = path.join(process.cwd(), 'extension')
    const relativePaths: string[] = []

    async function walk(prefix: string): Promise<void> {
      const entries = await readdir(path.join(extensionDir, prefix), {
        withFileTypes: true
      })
      for (const entry of entries) {
        const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
        if (entry.isDirectory()) {
          await walk(relative)
        } else if (entry.isFile()) {
          relativePaths.push(relative)
        }
      }
    }
    await walk('')

    const selected = selectExtensionFiles(relativePaths)
    const zip = createZipArchive(
      await Promise.all(
        selected.map(async (relativePath) => ({
          path: relativePath,
          data: await readFile(
            path.join(extensionDir, ...relativePath.split('/'))
          )
        }))
      )
    )
    const names = extractZipArchive(zip).map((entry) =>
      entry.relativePath.replace(/\\/g, '/')
    )

    expect(names).toContain('manifest.json')
    expect(names).toContain('icons/icon128.png')
    expect(names).toContain('popup.css')
    expect(names.some((name) => name.endsWith('.d.ts'))).toBe(false)
    expect(names.some((name) => name.endsWith('.map'))).toBe(false)
    expect(names).not.toContain('bridge.d.ts')
  })

  it('produces a readable archive with the manifest at the root', () => {
    const files = [
      { path: 'manifest.json', data: Buffer.from('{"version":"1.3.1"}') },
      {
        path: 'icons/icon16.png',
        data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3])
      },
      { path: 'background.js', data: Buffer.from('console.log("hi")\n') }
    ]
    const zip = createZipArchive(files)
    const entries = extractZipArchive(zip)
    const byName = new Map(
      entries.map((entry) => [
        entry.relativePath.replace(/\\/g, '/'),
        entry
      ])
    )

    expect(new Set(byName.keys())).toEqual(
      new Set(['manifest.json', 'icons/icon16.png', 'background.js'])
    )
    for (const file of files) {
      expect(decode(byName.get(file.path)?.data as Uint8Array)).toBe(
        decode(file.data)
      )
    }
  })

  it('is deterministic and compresses repetitive content', () => {
    const payload = Buffer.from('a'.repeat(4096))
    const files = [{ path: 'a.txt', data: payload }]
    const first = createZipArchive(files)
    const second = createZipArchive([...files])
    expect(first.equals(second)).toBe(true)
    expect(first.byteLength).toBeLessThan(payload.byteLength)
  })

  it('rejects unsafe entry paths and computes a stable CRC-32', () => {
    expect(crc32(Buffer.from('hello'))).toBe(0x3610a686)
    for (const bad of ['../x', '/x', 'a\\b', 'a//b']) {
      expect(() =>
        createZipArchive([{ path: bad, data: Buffer.from('x') }])
      ).toThrow()
    }
  })
})

describe('changelog section extraction', () => {
  const changelog = [
    '# Changelog',
    '',
    '## [Unreleased]',
    '',
    '- pending',
    '',
    '## [1.3.1] - 2026-11-18',
    '',
    '### Added',
    '',
    '- first public release',
    '',
    '## [0.1.0] - 2026-11-01',
    '',
    '- old',
    ''
  ].join('\n')

  it('returns the body of the requested version only', () => {
    expect(extractChangelogSection(changelog, '1.3.1')).toBe(
      '### Added\n\n- first public release\n'
    )
    expect(extractChangelogSection(changelog, '0.1.0')).toBe('- old\n')
  })

  it('returns null when the section is missing or empty', () => {
    expect(extractChangelogSection(changelog, '2.0.0')).toBeNull()
    expect(extractChangelogSection('## [1.3.1]\n\n## [0.9.0]\n', '1.3.1')).toBeNull()
  })
})

describe('release checksum script', () => {
  it('hashes installers and extension packages, then signs the exact file', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'dondownload-release-sums-')
    )
    tempDirs.push(directory)
    const scriptsDirectory = path.join(directory, 'scripts')
    const distDirectory = path.join(directory, 'dist')
    await mkdir(scriptsDirectory, { recursive: true })
    await mkdir(distDirectory, { recursive: true })
    for (const name of ['release-checksums.mjs', 'release-lib.mjs']) {
      await copyFile(
        path.join(process.cwd(), 'scripts', name),
        path.join(scriptsDirectory, name)
      )
    }

    const installer = installerAssetName(VERSION)
    const extension = extensionAssetNames(VERSION)
    const checksummed = [installer, extension.chromium, extension.firefox]
    for (const name of checksummed) {
      await writeFile(path.join(distDirectory, name), `payload:${name}`)
    }
    // Files that must not be hashed.
    await writeFile(
      path.join(distDirectory, 'THIRD-PARTY-SOURCES.txt'),
      'pointer'
    )
    await writeFile(
      path.join(distDirectory, `${installer}.blockmap`),
      'blockmap'
    )

    const keys = generateKeyPairSync('ed25519')
    const keyPath = path.join(directory, 'update-signing-key.pem')
    await writeFile(
      keyPath,
      keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    )

    const result = spawnSync(
      process.execPath,
      [path.join(scriptsDirectory, 'release-checksums.mjs')],
      {
        cwd: directory,
        encoding: 'utf8',
        env: {
          ...process.env,
          DONDOWNLOAD_UPDATE_SIGNING_KEY: keyPath
        }
      }
    )
    expect(result.stderr).not.toContain('failed')
    expect(result.status).toBe(0)

    const sumsPath = path.join(distDirectory, 'SHA256SUMS.txt')
    const sums = await readFile(sumsPath)
    const lines = decode(sums).trim().split('\n')
    expect(lines).toHaveLength(checksummed.length)
    expect(lines[0]).toMatch(
      /^[0-9a-f]{64} {2}DonDownload-1\.3\.1-x64-setup\.exe$/
    )
    expect(lines[1]).toContain(extension.chromium)
    expect(lines[2]).toContain(extension.firefox)

    const signature = await readFile(`${sumsPath}.sig`, 'utf8')
    expect(
      verify(
        null,
        sums,
        keys.publicKey,
        Buffer.from(signature.trim(), 'base64')
      )
    ).toBe(true)
  })
})

describe('release tag verification', () => {
  it('accepts only the exact v-prefixed tag for the version', () => {
    expect(releaseTagMatchesVersion('v1.0.0', '1.0.0')).toBe(true)
    expect(releaseTagMatchesVersion('v1.0.0-beta.1', '1.0.0-beta.1')).toBe(true)
    expect(releaseTagMatchesVersion('1.0.0', '1.0.0')).toBe(false)
    expect(releaseTagMatchesVersion('v1.0.1', '1.0.0')).toBe(false)
    expect(releaseTagMatchesVersion('v1.0.0', '1.0.1')).toBe(false)
    expect(releaseTagMatchesVersion('v1.0.0', '1.0')).toBe(false)
    expect(releaseTagMatchesVersion('', '1.0.0')).toBe(false)
    expect(
      releaseTagMatchesVersion(
        'v1.0.0',
        undefined as unknown as string
      )
    ).toBe(false)
  })
})

describe('release tag check script', () => {
  const script = path.join(process.cwd(), 'scripts', 'check-release-tag.mjs')
  const version = JSON.parse(
    readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')
  ).version as string

  it('accepts the exact v-prefixed package version', () => {
    const result = spawnSync(process.execPath, [script, `v${version}`], {
      encoding: 'utf8'
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain(
      `Release tag v${version} matches package.json version ${version}.`
    )
  })

  it('fails for a mismatched or missing tag', () => {
    const mismatched = spawnSync(process.execPath, [script, 'v0.0.0'], {
      encoding: 'utf8'
    })
    expect(mismatched.status).toBe(1)
    expect(mismatched.stderr).toContain('does not match')

    const missing = spawnSync(process.execPath, [script], {
      encoding: 'utf8'
    })
    expect(missing.status).toBe(1)
    expect(missing.stderr).toContain('(missing)')
  })
})

describe('vendor staging pins', () => {
  it('pins every downloaded archive to an official https URL and a SHA-256', async () => {
    const script = await readFile(
      path.join(process.cwd(), 'scripts', 'stage-vendor.ps1'),
      'utf8'
    )
    const urls = [...script.matchAll(/ArchiveUrl\s*=\s*'([^']+)'/g)].map(
      (match) => match[1] as string
    )
    const hashes = [...script.matchAll(/ArchiveSha256\s*=\s*'([^']+)'/g)].map(
      (match) => match[1] as string
    )

    // aria2, yt-dlp and FFmpeg are the only downloadable tools.
    expect(urls).toHaveLength(3)
    expect(hashes).toHaveLength(3)
    for (const url of urls) {
      expect(url).toMatch(/^https:\/\/(github\.com|www\.gyan\.dev)\//)
    }
    for (const hash of hashes) {
      expect(hash).toMatch(/^[0-9a-f]{64}$/)
    }
    expect(urls).toContain(
      'https://github.com/aria2/aria2/releases/download/release-1.37.0/aria2-1.37.0-win-64bit-build1.zip'
    )
    expect(urls).toContain(
      'https://github.com/GyanD/codexffmpeg/releases/download/9.0.2/ffmpeg-9.0.2-essentials_build.zip'
    )
    expect(urls).toContain(
      'https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/yt-dlp_win.zip'
    )
  })

  it('pins the real aria2 executable and rejects package-manager shims', async () => {
    const script = await readFile(
      path.join(process.cwd(), 'scripts', 'stage-vendor.ps1'),
      'utf8'
    )

    // Release 1.1.0 shipped the Chocolatey shim because the PATH lookup won
    // over the verified download. Both the file hash and the shim directories
    // are now guarded.
    expect(script).toContain(
      "ExpectedSha256       = 'be2099c214f63a3cb4954b09a0becd6e2e34660b886d4c898d260febfe9d70c2'"
    )
    expect(script).toContain('\\chocolatey\\bin\\')
    expect(script).toContain('\\scoop\\shims\\')
    expect(script).toContain('Test-StagedExecutable')
  })
})

describe('Mozilla (AMO) signing of the Firefox package', () => {
  const credentials = { apiKey: 'user:12345', apiSecret: 's3cret' }

  it('pins the web-ext version that can sign the package', () => {
    expect(WEB_EXT_VERSION).toBe('8.9.0')
    expect(AMO_SIGNATURE_ENTRIES).toEqual([
      'META-INF/mozilla.rsa',
      'META-INF/cose.sig'
    ])
  })

  it('reads both credentials from the environment and trims them', () => {
    expect(readAmoCredentials({})).toBeNull()
    expect(
      readAmoCredentials({
        AMO_JWT_ISSUER: ' user:12345 ',
        AMO_JWT_SECRET: 's3cret'
      })
    ).toEqual(credentials)
  })

  it('rejects a half-configured credential pair instead of shipping unsigned', () => {
    expect(() => readAmoCredentials({ AMO_JWT_ISSUER: 'user:1' })).toThrow(
      /AMO_JWT_SECRET/
    )
    expect(() => readAmoCredentials({ AMO_JWT_SECRET: 's3cret' })).toThrow(
      /AMO_JWT_ISSUER/
    )
  })

  it('signs only when both credentials are present', () => {
    expect(planAmoSigning({ credentials })).toEqual({
      action: 'sign',
      reason: 'credentials'
    })
    expect(
      planAmoSigning({ credentials, ci: true, publish: true }).action
    ).toBe('sign')
  })

  it('fails a publish run without credentials and skips a local dry run', () => {
    expect(() =>
      planAmoSigning({ credentials: null, ci: true, publish: true })
    ).toThrow(/AMO_JWT_ISSUER and AMO_JWT_SECRET/)
    expect(planAmoSigning({ credentials: null })).toEqual({
      action: 'skip',
      reason: 'missing-credentials'
    })
    expect(
      planAmoSigning({ credentials: null, ci: true, publish: false })
    ).toEqual({ action: 'skip', reason: 'missing-credentials' })
  })

  it('treats --skip-amo as an explicit unsigned build', () => {
    expect(
      planAmoSigning({
        credentials: null,
        skipAmo: true,
        ci: true,
        publish: true
      })
    ).toEqual({ action: 'skip', reason: 'skip-flag' })
    expect(() => planAmoSigning({ credentials, skipAmo: true })).toThrow(
      /--skip-amo/
    )
  })

  it('builds a pinned, secret-free web-ext command line', () => {
    const args = amoSignArguments({
      sourceDirectory: 'C:\\tmp dir\\source',
      artifactsDirectory: 'C:\\tmp dir\\artifacts'
    })
    const commandLine = args.join(' ')

    expect(args).toContain(`web-ext@${WEB_EXT_VERSION}`)
    expect(args).toContain('sign')
    expect(commandLine).toContain('--channel unlisted')
    expect(commandLine).toContain('--approval-timeout 900000')
    expect(commandLine).toContain('--no-input')
    expect(commandLine).not.toContain('--api-key')
    expect(commandLine).not.toContain('--api-secret')
    expect(commandLine).not.toContain(credentials.apiKey)
    expect(commandLine).not.toContain(credentials.apiSecret)
  })

  it('passes the credentials through the web-ext environment only', () => {
    const env = amoSignEnvironment(credentials, { PATH: 'C:\\Windows' })
    expect(env.WEB_EXT_API_KEY).toBe(credentials.apiKey)
    expect(env.WEB_EXT_API_SECRET).toBe(credentials.apiSecret)
    expect(env.PATH).toBe('C:\\Windows')
    expect(() =>
      amoSignEnvironment({ apiKey: '', apiSecret: '' })
    ).toThrow(/API key/)
  })

  it('finds the Mozilla signature in a signed package and not in an unsigned one', () => {
    const unsigned = createZipArchive([
      { path: 'manifest.json', data: Buffer.from('{}') }
    ])
    expect(listZipEntryNames(unsigned)).toEqual(['manifest.json'])
    expect(findAmoSignatureEntry(listZipEntryNames(unsigned))).toBeNull()

    const signed = createZipArchive([
      { path: 'manifest.json', data: Buffer.from('{}') },
      { path: 'META-INF/mozilla.rsa', data: Buffer.from([1, 2, 3]) }
    ])
    expect(listZipEntryNames(signed)).toEqual([
      'META-INF/mozilla.rsa',
      'manifest.json'
    ])
    expect(findAmoSignatureEntry(listZipEntryNames(signed))).toBe(
      'META-INF/mozilla.rsa'
    )

    const cose = createZipArchive([
      { path: 'META-INF/cose.sig', data: Buffer.from([4]) }
    ])
    expect(findAmoSignatureEntry(listZipEntryNames(cose))).toBe(
      'META-INF/cose.sig'
    )
  })

  it('signs the Firefox package before the checksums are written', async () => {
    const script = await readFile(
      path.join(process.cwd(), 'scripts', 'release.mjs'),
      'utf8'
    )
    const signIndex = script.indexOf(
      'await signFirefoxExtension(extensionBuild'
    )
    const checksumIndex = script.indexOf('\n  writeChecksums(signingKeyPath)')

    expect(signIndex).toBeGreaterThan(-1)
    expect(checksumIndex).toBeGreaterThan(signIndex)
    expect(script).toContain("'--skip-amo'")
    expect(script).not.toContain('--api-key')
    expect(script).toContain('amoSignEnvironment(credentials, process.env)')
  })

  it('passes the AMO secrets to the release step only', async () => {
    const workflow = await readFile(
      path.join(process.cwd(), '.github', 'workflows', 'release.yml'),
      'utf8'
    )
    expect(
      workflow.match(/AMO_JWT_ISSUER: \$\{\{ secrets\.AMO_JWT_ISSUER \}\}/g)
    ).toHaveLength(1)
    expect(
      workflow.match(/AMO_JWT_SECRET: \$\{\{ secrets\.AMO_JWT_SECRET \}\}/g)
    ).toHaveLength(1)
    expect(workflow).toContain(
      'UPDATE_SIGNING_KEY: ${{ secrets.UPDATE_SIGNING_KEY }}'
    )
    expect(workflow).toContain('node scripts/release.mjs --ci --publish')
  })
})

describe('third-party source pointer', () => {
  const components = [
    {
      name: 'aria2',
      version: '1.37.0',
      license: 'GPL-2.0-or-later',
      sourceUrl:
        'https://github.com/aria2/aria2/releases/download/release-1.37.0/aria2-1.37.0.tar.bz2',
      binary: 'resources/vendor/aria2/aria2c.exe',
      binaryUrl:
        'https://github.com/aria2/aria2/releases/download/release-1.37.0/aria2-1.37.0-win-64bit-build1.zip',
      binarySha256: 'b'.repeat(64)
    }
  ]

  it('lists the component version and upstream source', () => {
    const text = renderThirdPartySourcesText({
      version: VERSION,
      components
    })
    expect(text).toContain('DonDownload 1.3.1')
    expect(text).toContain('aria2 1.37.0')
    expect(text).toContain('GPL-2.0-or-later')
    expect(text).toContain('aria2-1.37.0.tar.bz2')
    expect(text).toContain(
      'Shipped binary download: https://github.com/aria2/aria2/releases/download/release-1.37.0/aria2-1.37.0-win-64bit-build1.zip'
    )
    expect(text).toContain(`SHA-256 ${'b'.repeat(64)}`)
    expect(text).toContain('No source archive was attached')
  })

  it('records the hashes of attached source archives', () => {
    const text = renderThirdPartySourcesText({
      version: VERSION,
      components,
      sourceArchives: [
        {
          name: 'aria2-1.37.0.tar.bz2',
          sizeBytes: 2_392_193,
          sha256: 'a'.repeat(64),
          sourceUrl: 'https://github.com/aria2/aria2'
        }
      ]
    })
    expect(text).toContain('aria2-1.37.0.tar.bz2 (2392193 bytes)')
    expect(text).toContain(`SHA-256: ${'a'.repeat(64)}`)
    expect(text).not.toContain('No source archive was attached')
  })
})
