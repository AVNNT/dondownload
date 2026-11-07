import { describe, expect, it } from 'vitest'
import {
  TYPE_FOLDER_NAMES,
  filenameExtension,
  resolveDownloadDirectory,
  typeFolderDirectory,
  typeFolderForExtension,
  typeFolderForFilename
} from '../src/shared/typeFolders'

describe('type folder extension mapping', () => {
  it('maps every documented category extension', () => {
    const expected: Record<string, string> = {
      mp4: 'Video',
      mkv: 'Video',
      webm: 'Video',
      mov: 'Video',
      avi: 'Video',
      m4v: 'Video',
      ts: 'Video',
      flv: 'Video',
      wmv: 'Video',
      mp3: 'Audio',
      m4a: 'Audio',
      flac: 'Audio',
      wav: 'Audio',
      ogg: 'Audio',
      opus: 'Audio',
      aac: 'Audio',
      wma: 'Audio',
      jpg: 'Images',
      jpeg: 'Images',
      png: 'Images',
      gif: 'Images',
      webp: 'Images',
      avif: 'Images',
      heic: 'Images',
      bmp: 'Images',
      svg: 'Images',
      zip: 'Archives',
      rar: 'Archives',
      '7z': 'Archives',
      tar: 'Archives',
      gz: 'Archives',
      tgz: 'Archives',
      xz: 'Archives',
      bz2: 'Archives',
      zst: 'Archives',
      iso: 'Archives',
      pdf: 'Documents',
      doc: 'Documents',
      docx: 'Documents',
      xls: 'Documents',
      xlsx: 'Documents',
      ppt: 'Documents',
      pptx: 'Documents',
      txt: 'Documents',
      rtf: 'Documents',
      epub: 'Documents',
      md: 'Documents',
      csv: 'Documents',
      odt: 'Documents',
      exe: 'Programs',
      msi: 'Programs',
      msix: 'Programs',
      apk: 'Programs',
      dmg: 'Programs',
      appimage: 'Programs'
    }

    for (const [extension, folder] of Object.entries(expected)) {
      expect(TYPE_FOLDER_NAMES).toContain(folder)
      expect(typeFolderForExtension(extension)).toBe(folder)
      expect(typeFolderForFilename(`download.${extension}`)).toBe(folder)
    }
  })

  it('sends .funscript files to Video', () => {
    expect(typeFolderForExtension('funscript')).toBe('Video')
    expect(typeFolderForFilename('My Video.funscript')).toBe('Video')
  })

  it('is case-insensitive and accepts a leading dot', () => {
    expect(typeFolderForExtension('.MP4')).toBe('Video')
    expect(typeFolderForFilename('MOVIE.MKV')).toBe('Video')
  })

  it('leaves unknown, missing and dotless extensions unsorted', () => {
    for (const value of ['', 'bin', 'README', '.gitignore']) {
      expect(typeFolderForFilename(value)).toBeNull()
    }
    expect(typeFolderForFilename('archive.unknown')).toBeNull()
  })

  it('extracts extensions from URLs with query strings and fragments', () => {
    expect(filenameExtension('https://example.com/file.MP4?token=1')).toBe('mp4')
    expect(filenameExtension('https://example.com/file.tar.gz#part')).toBe('gz')
    expect(typeFolderForFilename('https://example.com/a/b/song.FLAC?x=1')).toBe(
      'Audio'
    )
  })

  it('joins folders without changing the base directory style', () => {
    expect(typeFolderDirectory('C:\\Downloads', 'Video')).toBe(
      'C:\\Downloads\\Video'
    )
    expect(typeFolderDirectory('C:\\Downloads\\', 'Video')).toBe(
      'C:\\Downloads\\Video'
    )
    expect(typeFolderDirectory('/home/user/Downloads', 'Audio')).toBe(
      '/home/user/Downloads/Audio'
    )
  })
})

describe('type folder directory resolution', () => {
  const base = 'C:\\Users\\PC\\Downloads'

  it('keeps the default directory when the setting is off', () => {
    expect(resolveDownloadDirectory(base, 'movie.mkv', false)).toBe(base)
    expect(resolveDownloadDirectory(base, 'song.flac', false)).toBe(base)
    expect(resolveDownloadDirectory(base, 'archive.zip', false)).toBe(base)
  })

  it('uses the type subfolder when the setting is on', () => {
    expect(resolveDownloadDirectory(base, 'movie.mkv', true)).toBe(
      `${base}\\Video`
    )
    expect(resolveDownloadDirectory(base, 'song.flac', true)).toBe(
      `${base}\\Audio`
    )
    expect(resolveDownloadDirectory(base, 'photo.PNG', true)).toBe(
      `${base}\\Images`
    )
    expect(resolveDownloadDirectory(base, 'archive.7z', true)).toBe(
      `${base}\\Archives`
    )
    expect(resolveDownloadDirectory(base, 'manual.pdf', true)).toBe(
      `${base}\\Documents`
    )
    expect(resolveDownloadDirectory(base, 'setup.exe', true)).toBe(
      `${base}\\Programs`
    )
  })

  it('sends funscripts to Video and leaves unknown types alone', () => {
    expect(resolveDownloadDirectory(base, 'scene.funscript', true)).toBe(
      `${base}\\Video`
    )
    expect(resolveDownloadDirectory(base, 'payload.bin', true)).toBe(base)
    expect(resolveDownloadDirectory(base, 'README', true)).toBe(base)
  })
})
