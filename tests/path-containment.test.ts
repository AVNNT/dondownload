import { describe, expect, it } from 'vitest'
import { checkDeleteTarget } from '../src/main/downloads/deleteFile'
import {
  isFileSystemRoot,
  isPathInside,
  safeContainmentRoot
} from '../src/main/pathContainment'

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
