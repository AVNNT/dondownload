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
