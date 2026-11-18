import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DRIVE_ROOT_DESTINATION_MESSAGE,
  DownloadDestinationStore
} from '../src/main/downloads/destination'
import { AppError } from '../src/main/errors'

const tempDirs: string[] = []

async function makeFolder(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dondownload-destination-'))
  tempDirs.push(dir)
  return dir
}

/** The AppError a refused pick produced, so tests can read code and message. */
function refusal(pick: () => unknown): AppError {
  try {
    pick()
  } catch (error) {
    if (error instanceof AppError) return error
    throw error
  }
  throw new Error('expected the folder to be refused')
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

describe('chosen download folder store', () => {
  it('returns an opaque token and resolves it back to the folder', async () => {
    const folder = await makeFolder()
    const store = new DownloadDestinationStore()

    const choice = store.register(folder)

    expect(choice.path).toBe(path.resolve(folder))
    expect(choice.token).toMatch(/^[A-Za-z0-9_-]{16,128}$/)
    expect(choice.token).not.toContain(folder)
    expect(store.resolve(choice.token)).toBe(path.resolve(folder))
  })

  it('rejects missing, relative, UNC and non-directory targets', async () => {
    const store = new DownloadDestinationStore()
    const folder = await makeFolder()
    const file = path.join(folder, 'not-a-folder.txt')
    await writeFile(file, 'x')

    expect(() =>
      store.register(path.join(os.tmpdir(), 'missing-folder-xyz'))
    ).toThrow(AppError)
    expect(() => store.register('relative-folder')).toThrow(AppError)
    expect(() => store.register('\\\\server\\share')).toThrow(AppError)
    expect(() => store.register('\\\\?\\C:\\Windows')).toThrow(AppError)
    expect(() => store.register(file)).toThrow(AppError)
  })

  it('forgets a token whose folder stops being usable', async () => {
    const folder = await makeFolder()
    const store = new DownloadDestinationStore()
    const choice = store.register(folder)

    // A folder that vanished between picking and adding is never silently
    // replaced by the default download folder.
    await rm(folder, { recursive: true, force: true })
    expect(store.resolve(choice.token)).toBeNull()
    expect(store.resolve(choice.token)).toBeNull()
  })

  it('expires tokens and forgets a folder that disappeared', async () => {
    const folder = await makeFolder()
    let now = 1_000
    const store = new DownloadDestinationStore({
      now: () => now,
      ttlMs: 500
    })

    const choice = store.register(folder)
    expect(store.resolve(choice.token)).toBe(path.resolve(folder))

    now += 501
    expect(store.resolve(choice.token)).toBeNull()

    const second = store.register(folder)
    await rm(folder, { recursive: true, force: true })
    expect(store.resolve(second.token)).toBeNull()
  })

  it('rejects malformed tokens without touching the filesystem', () => {
    const store = new DownloadDestinationStore()
    expect(store.resolve('short')).toBeNull()
    expect(store.resolve('../escape')).toBeNull()
    expect(store.resolve('C:\\Windows\\System32')).toBeNull()
    expect(store.resolve(42)).toBeNull()
  })
})

describe('chosen download folder is never a whole drive', () => {
  it('refuses a drive root with the message the Add dialog shows', () => {
    const store = new DownloadDestinationStore()

    // File actions treat a drive root as untrusted, so a Save-to folder that is
    // the root itself is refused here instead of failing after the download.
    for (const root of ['C:\\', 'D:\\', path.parse(os.tmpdir()).root]) {
      const error = refusal(() => store.register(root))
      expect(error.code).toBe('DOWNLOAD_FOLDER_INVALID')
      expect(error.message).toBe(DRIVE_ROOT_DESTINATION_MESSAGE)
      expect(error.hint).toBe('Open the drive and choose a folder inside it.')
    }
    expect(DRIVE_ROOT_DESTINATION_MESSAGE).toBe(
      'Choose a folder, not a whole drive (for example D:\\Downloads).'
    )
  })

  it('accepts a folder on that drive, like D:\\Downloads', async () => {
    // A real subfolder of a drive root (the temp folder lives under one) is
    // the accepted shape; only the root itself is refused.
    const downloads = await makeFolder()
    const store = new DownloadDestinationStore()

    const choice = store.register(downloads)

    expect(choice.path).toBe(path.resolve(downloads))
    expect(store.resolve(choice.token)).toBe(path.resolve(downloads))
    expect(path.parse(choice.path).root).not.toBe(choice.path)
  })

  it('stops trusting a stored drive root and explains why', () => {
    const store = new DownloadDestinationStore()
    const folder = path.join(os.tmpdir(), 'dondownload-stored-root')
    // A token can only come from register(), which now refuses roots; this
    // covers an entry left by an older build.
    const internals = store as unknown as {
      destinations: Map<string, { directory: string; expiresAt: number }>
    }
    const token = 'b'.repeat(32)
    internals.destinations.set(token, {
      directory: path.parse(folder).root,
      expiresAt: Date.now() + 60_000
    })

    const error = refusal(() => store.resolve(token))
    expect(error.code).toBe('DOWNLOAD_FOLDER_INVALID')
    expect(error.message).toBe(DRIVE_ROOT_DESTINATION_MESSAGE)
    // The unusable entry is forgotten rather than trusted on a retry.
    expect(store.resolve(token)).toBeNull()
  })
})
