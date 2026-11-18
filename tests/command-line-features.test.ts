import { describe, expect, it } from 'vitest'
import { mergeFeatureList } from '../src/main/commandLine/features'

describe('mergeFeatureList', () => {
  it('returns the additions when nothing was set', () => {
    expect(mergeFeatureList(undefined, ['NetworkServiceInProcess2'])).toBe(
      'NetworkServiceInProcess2'
    )
  })

  it('keeps existing features instead of overwriting them', () => {
    expect(
      mergeFeatureList('Foo,Bar', ['NetworkServiceInProcess2'])
    ).toBe('Foo,Bar,NetworkServiceInProcess2')
  })

  it('treats a blank existing value as empty', () => {
    expect(mergeFeatureList('', ['A'])).toBe('A')
    expect(mergeFeatureList('  ', ['A'])).toBe('A')
  })

  it('drops duplicates so the switch stays short', () => {
    expect(mergeFeatureList('A,B', ['B', 'A', 'C'])).toBe('A,B,C')
  })

  it('trims whitespace and ignores empty entries', () => {
    expect(mergeFeatureList(' A , ,B ', [' C ', ''])).toBe('A,B,C')
  })

  it('returns an empty string when there is nothing to merge', () => {
    expect(mergeFeatureList(undefined, [])).toBe('')
  })
})
