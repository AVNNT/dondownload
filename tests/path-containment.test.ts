import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkDeleteTarget } from '../src/main/downloads/deleteFile'
import {
  isFileSystemRoot,
  isPathInside,
  isPathReallyInside,
  resolveRealPath,
  safeContainmentRoot
} from '../src/main/pathContainment'

const tempDirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dondownload-containment-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

describe('realpath containment', () => {
  it('accepts a real file inside the folder and rejects one outside', async () => {
    const base = await tempDir()
    const root = path.join(base, 'Downloads')
    const outside = path.join(base, 'Elsewhere')
    await mkdir(root, { recursive: true })
    await mkdir(outside, { recursive: true })
    const inside = path.join(root, 'file.zip')
    const escaping = path.join(outside, 'secret.zip')
    await writeFile(inside, 'x')
    await writeFile(escaping, 'x')

    await expect(isPathReallyInside(root, inside)).resolves.toBe(true)
    await expect(isPathReallyInside(root, escaping)).resolves.toBe(false)
  })

  it('refuses a file reached through a junction that leaves the folder', async () => {
    const base = await tempDir()
    const root = path.join(base, 'Downloads')
    const outside = path.join(base, 'Elsewhere')
    await mkdir(root, { recursive: true })
    await mkdir(outside, { recursive: true })
    await writeFile(path.join(outside, 'secret.zip'), 'x')
    const link = path.join(root, 'linked')
    try {
      // Windows needs junctions for directories without admin rights.
      await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
    } catch {
      // Creating links may be blocked on this machine; nothing to assert.
      return
    }

    const candidate = path.join(link, 'secret.zip')
    // The lexical rule alone would accept it.
    expect(isPathInside(root, candidate)).toBe(true)
    await expect(isPathReallyInside(root, candidate)).resolves.toBe(false)
  })

  it('resolves the nearest existing parent for a path that does not exist yet', async () => {
    const base = await tempDir()
    const root = path.join(base, 'Downloads')
    await mkdir(root, { recursive: true })
    const missing = path.join(root, 'nested', 'not-yet.zip')

    await expect(resolveRealPath(missing)).resolves.toBe(
      path.join(await resolveRealPath(root), 'nested', 'not-yet.zip')
    )
    await expect(isPathReallyInside(root, missing)).resolves.toBe(true)
    // Equal only names the folder itself, and that is still opt-in.
    await expect(isPathReallyInside(root, root)).resolves.toBe(false)
    await expect(
      isPathReallyInside(root, missing, { allowEqual: true })
    ).resolves.toBe(true)
  })
})

describe('isPathInside', () => {
  it('treats Windows paths case-insensitively', () => {
    expect(
      isPathInside(
        'C:\\Users\\Ada\\Downloads',
        'c:\\users\\ada\\downloads\\sub\\file.zip'
      )
    ).toBe(true)
    expect(
      isPathInside('c:\\users\\ada\\downloads', 'C:\\Users\\Ada\\Downloads')
    ).toBe(false)
    expect(
      isPathInside('c:\\users\\ada\\downloads', 'C:\\Users\\Ada\\Downloads', {
        allowEqual: true
      })
    ).toBe(true)
  })

  it('rejects parents and other drives but allows a ..-prefixed child', () => {
    expect(isPathInside('C:\\Downloads', 'C:\\Downloads\\..\\secret.zip')).toBe(
      false
    )
    expect(isPathInside('C:\\Downloads', 'D:\\Downloads\\file.zip')).toBe(false)
    expect(isPathInside('C:\\Downloads', 'C:\\Downloads\\..data\\file.zip')).toBe(
      true
    )
  })
})

describe('filesystem roots', () => {
  it('recognises only the root itself', () => {
    expect(isFileSystemRoot('C:\\')).toBe(true)
    expect(isFileSystemRoot('C:\\Windows')).toBe(false)
    expect(isFileSystemRoot('')).toBe(false)
  })

  it('falls back to the trusted root for a record that names a drive root', () => {
    const fallback = 'C:\\Users\\Ada\\Downloads'
    expect(safeContainmentRoot('C:\\', fallback)).toBe(fallback)
    expect(safeContainmentRoot('D:\\Media', fallback)).toBe('D:\\Media')
  })
})

describe('delete target policy with an untrusted root', () => {
  it('refuses a drive-root output folder even when the file is on that drive', () => {
    const check = checkDeleteTarget({
      root: 'C:\\',
      filePath: 'C:\\Windows\\System32\\config.ini',
      finished: true,
      entry: { isFile: true, isSymbolicLink: false }
    })
    expect(check).toEqual({ ok: false, problem: 'outside-directory' })
  })
})
