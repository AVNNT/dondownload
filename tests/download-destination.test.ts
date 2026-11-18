import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DownloadDestinationStore } from '../src/main/downloads/destination'
import { AppError } from '../src/main/errors'

const tempDirs: string[] = []

async function makeFolder(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dondownload-destination-'))
  tempDirs.push(dir)
  return dir
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

  it('rejects missing or unsafe folders', () => {
    const store = new DownloadDestinationStore()

    expect(() => store.register(path.join(os.tmpdir(), 'missing-folder-xyz'))).toThrow(
      AppError
    )
    expect(() => store.register('relative-folder')).toThrow(AppError)
    expect(() => store.register('\\\\server\\share')).toThrow(AppError)
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
    expect(store.resolve(42)).toBeNull()
  })
})
