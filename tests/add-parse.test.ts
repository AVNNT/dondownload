import { describe, expect, it } from 'vitest'
import {
  addPlanSummary,
  classifyAddUrl,
  filenameFromUrl,
  isBatchInput,
  parseAddInput
} from '../src/renderer/src/lib/addParse'

describe('add dialog link parsing', () => {
  it('classifies direct files, media pages and other pages', () => {
    expect(classifyAddUrl('https://example.com/files/setup.zip')).toBe('file')
    expect(
      classifyAddUrl('https://www.pixeldrain.com/u/AbCd1234')
    ).toBe('file')
    expect(classifyAddUrl('https://youtube.com/watch?v=abc')).toBe('media')
    expect(classifyAddUrl('https://forum.example.org/t/topic/4812')).toBe(
      'page'
    )
  })

  it('defaults unknown file extensions to a direct file', () => {
    expect(classifyAddUrl('https://proof.ovh.net/files/1Mb.dat')).toBe('file')
    expect(classifyAddUrl('https://cdn.example.net/assets/blob.bin')).toBe(
      'file'
    )
    expect(classifyAddUrl('https://example.com/x/archive.tar.gz')).toBe('file')
  })

  it('keeps extensionless and web-page links as pages', () => {
    expect(classifyAddUrl('https://example.com/download?file=setup.zip')).toBe(
      'page'
    )
    expect(classifyAddUrl('https://example.com/files/index.php')).toBe('page')
    expect(classifyAddUrl('https://example.com/files/list.asp')).toBe('page')
    expect(classifyAddUrl('https://example.com/blog/post.aspx')).toBe('page')
    expect(classifyAddUrl('https://example.com/blog/post')).toBe('page')
  })

  it('keeps web-page links in the parsed plan as pages with both actions', () => {
    const parsed = parseAddInput('https://example.com/files/index.php')
    expect(parsed.links[0]?.kind).toBe('page')
    expect(addPlanSummary(parsed)).toEqual({ downloadCount: 0, scanCount: 1 })
  })

  it('parses one link per line, ignoring blanks and duplicates', () => {
    const parsed = parseAddInput(
      [
        'https://example.com/a.zip',
        '',
        '   ',
        'https://example.com/a.zip',
        'https://youtube.com/watch?v=abc'
      ].join('\n')
    )
    expect(parsed.links.map((link) => link.url)).toEqual([
      'https://example.com/a.zip',
      'https://youtube.com/watch?v=abc'
    ])
    expect(parsed.invalid).toEqual([])
    expect(isBatchInput(parsed)).toBe(true)
  })

  it('keeps unparsable lines as explicit invalid entries', () => {
    const parsed = parseAddInput('not a link\nhttps://example.com/a.zip')
    expect(parsed.invalid).toEqual(['not a link'])
    expect(parsed.links.map((link) => link.url)).toEqual([
      'https://example.com/a.zip'
    ])
    expect(isBatchInput(parsed)).toBe(false)
  })

  it('splits the footer action plan between downloads and scans', () => {
    const parsed = parseAddInput(
      [
        'https://example.com/a.zip',
        'https://example.com/b.zip',
        'https://forum.example.org/t/topic/4812'
      ].join('\n')
    )
    expect(addPlanSummary(parsed)).toEqual({ downloadCount: 2, scanCount: 1 })
  })

  it('derives display names from URL paths', () => {
    expect(filenameFromUrl('https://example.com/dir/brand-assets.7z')).toBe(
      'brand-assets.7z'
    )
    expect(filenameFromUrl('https://example.com/watch/launch')).toBe('launch')
    expect(filenameFromUrl('https://example.com')).toBe('example.com')
  })
})
