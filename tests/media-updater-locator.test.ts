import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  listManagedYtdlpVersions,
  locateMediaTool,
  readBundledYtdlpVersion
} from '../src/main/media/locator'

const tempDirs: string[] = []

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

async function makeRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dondownload-locator-'))
  tempDirs.push(dir)
  return dir
}

async function writeFileAt(filePath: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, 'binary')
}

async function writeBundled(
  root: string,
  version: string
): Promise<string> {
  const bundled = path.join(root, 'vendor', 'yt-dlp', 'yt-dlp.exe')
  await writeFileAt(bundled)
  await writeFile(
    path.join(root, 'vendor', 'manifest.json'),
    JSON.stringify({ tools: [{ name: 'yt-dlp', version }] })
  )
  return bundled
}

async function writeManaged(
  managedDir: string,
  version: string
): Promise<string> {
  const filePath = path.join(managedDir, version, 'yt-dlp.exe')
  await writeFileAt(filePath)
  return filePath
}

const BASE_OPTIONS = { env: { PATH: '' }, platform: 'win32' as const }

describe('managed yt-dlp locator preference', () => {
  it('prefers the newest managed version newer than the bundled one', async () => {
    const root = await makeRoot()
    await writeBundled(root, '2026.10.26')
    const managedDir = path.join(root, 'userData', 'tools', 'yt-dlp')
    const sameVersion = await writeManaged(managedDir, '2026.10.26')
    const newest = await writeManaged(managedDir, '2026.11.05')
    await writeManaged(managedDir, '2026.10.30')

    const location = await locateMediaTool('ytdlp', {
      ...BASE_OPTIONS,
      cwd: root,
      managedToolsDir: managedDir
    })

    expect(location).toMatchObject({
      path: newest,
      explicit: false,
      missingExplicit: false,
      source: 'managed'
    })
    expect(location.path).not.toBe(sameVersion)
  })

  it('falls back to the bundled executable when managed copies are not newer', async () => {
    const root = await makeRoot()
    const bundled = await writeBundled(root, '2026.10.26')
    const managedDir = path.join(root, 'userData', 'tools', 'yt-dlp')
    await writeManaged(managedDir, '2026.10.26')
    await writeManaged(managedDir, '2026.10.25')

    const location = await locateMediaTool('ytdlp', {
      ...BASE_OPTIONS,
      cwd: root,
      managedToolsDir: managedDir
    })

    expect(location.path).toBe(bundled)
    expect(location.source).toBe('bundled')
  })

  it('keeps an explicit environment override above managed and bundled copies', async () => {
    const root = await makeRoot()
    await writeBundled(root, '2026.10.26')
    const managedDir = path.join(root, 'userData', 'tools', 'yt-dlp')
    await writeManaged(managedDir, '2026.11.05')
    const override = path.join(root, 'custom', 'yt-dlp.exe')
    await writeFileAt(override)

    const location = await locateMediaTool('ytdlp', {
      ...BASE_OPTIONS,
      cwd: root,
      env: { PATH: '', DONDOWNLOAD_YTDLP_PATH: override },
      managedToolsDir: managedDir
    })

    expect(location).toMatchObject({
      path: override,
      explicit: true,
      source: 'explicit'
    })
  })

  it('uses managed copies when no bundled version is available', async () => {
    const root = await makeRoot()
    const managedDir = path.join(root, 'userData', 'tools', 'yt-dlp')
    const managed = await writeManaged(managedDir, '2026.11.05')

    const location = await locateMediaTool('ytdlp', {
      ...BASE_OPTIONS,
      cwd: root,
      managedToolsDir: managedDir
    })

    expect(location.path).toBe(managed)
  })

  it('ignores malformed managed directories and non-files', async () => {
    const root = await makeRoot()
    const bundled = await writeBundled(root, '2026.10.26')
    const managedDir = path.join(root, 'userData', 'tools', 'yt-dlp')
    await mkdir(path.join(managedDir, 'latest'), { recursive: true })
    await writeFile(path.join(managedDir, 'latest', 'yt-dlp.exe'), 'binary')
    await mkdir(path.join(managedDir, '2026.11.05'), { recursive: true })

    expect(await listManagedYtdlpVersions(managedDir, 'win32')).toEqual([])
    const location = await locateMediaTool('ytdlp', {
      ...BASE_OPTIONS,
      cwd: root,
      managedToolsDir: managedDir
    })
    expect(location.path).toBe(bundled)
  })

  it('reads the bundled version from the staged vendor manifest', async () => {
    const root = await makeRoot()
    await writeBundled(root, '2026.10.26')
    await expect(readBundledYtdlpVersion(root)).resolves.toBe('2026.10.26')
  })

  it('resolves both one-folder and legacy one-file managed layouts', async () => {
    const root = await makeRoot()
    const bundled = await writeBundled(root, '2026.10.26')
    // The bundled layout is now the official one-folder build.
    await writeFileAt(
      path.join(root, 'vendor', 'yt-dlp', '_internal', 'python313.dll')
    )

    const managedDir = path.join(root, 'userData', 'tools', 'yt-dlp')
    // New onedir managed version.
    const onedir = await writeManaged(managedDir, '2026.11.05')
    await writeFileAt(
      path.join(managedDir, '2026.11.05', '_internal', 'python313.dll')
    )

    const location = await locateMediaTool('ytdlp', {
      ...BASE_OPTIONS,
      cwd: root,
      managedToolsDir: managedDir
    })
    expect(location).toMatchObject({ path: onedir, source: 'managed' })

    // Without a newer managed version the one-folder bundled exe wins.
    const fallbackRoot = await makeRoot()
    const fallbackBundled = await writeBundled(fallbackRoot, '2026.10.26')
    await writeFileAt(
      path.join(fallbackRoot, 'vendor', 'yt-dlp', '_internal', 'python313.dll')
    )
    const fallbackManaged = path.join(
      fallbackRoot,
      'userData',
      'tools',
      'yt-dlp'
    )
    await writeManaged(fallbackManaged, '2026.10.26')
    const fallback = await locateMediaTool('ytdlp', {
      ...BASE_OPTIONS,
      cwd: fallbackRoot,
      managedToolsDir: fallbackManaged
    })
    expect(fallback.path).toBe(fallbackBundled)
    expect(bundled).not.toBe(onedir)
  })
})
