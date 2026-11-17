import { describe, expect, it } from 'vitest'
import {
  groupForProcessType,
  sampleProcessMetrics
} from '../src/main/memoryBench/metrics'

describe('memory bench process grouping', () => {
  it('maps Electron process types to user-facing groups', () => {
    expect(groupForProcessType('Browser')).toBe('main')
    expect(groupForProcessType('GPU')).toBe('gpu')
    expect(groupForProcessType('Tab')).toBe('renderer')
    expect(groupForProcessType('Utility')).toBe('utility')
    expect(groupForProcessType('Zygote')).toBe('other')
  })

  it('converts kilobytes to bytes and totals each group', () => {
    const sample = sampleProcessMetrics([
      { pid: 1, type: 'Browser', memory: { workingSetSize: 1000, privateBytes: 800 } },
      { pid: 2, type: 'Tab', memory: { workingSetSize: 500, privateBytes: 400 } },
      { pid: 3, type: 'Tab', memory: { workingSetSize: 250 } },
      { pid: 4, type: 'GPU' }
    ])
    const renderer = sample.groups.find((group) => group.group === 'renderer')
    expect(renderer).toEqual({
      group: 'renderer',
      processes: 2,
      workingSetBytes: 750 * 1024,
      privateBytes: 400 * 1024
    })
    expect(sample.groups.map((group) => group.group)).toEqual([
      'main',
      'gpu',
      'renderer',
      'utility',
      'other'
    ])
    expect(sample.total).toEqual({
      processes: 4,
      workingSetBytes: 1750 * 1024,
      privateBytes: 1200 * 1024
    })
  })
})
