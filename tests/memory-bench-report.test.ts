import { describe, expect, it } from 'vitest'
import { sampleProcessMetrics } from '../src/main/memoryBench/metrics'
import {
  MEMORY_BENCH_OUT_ENV,
  createPhaseResult,
  memoryBenchOutPath,
  toMegabytes
} from '../src/main/memoryBench/report'

describe('memory bench report', () => {
  it('converts bytes to one-decimal megabytes', () => {
    expect(toMegabytes(0)).toBe(0)
    expect(toMegabytes(-5)).toBe(0)
    expect(toMegabytes(Number.NaN)).toBe(0)
    expect(toMegabytes(1024 * 1024)).toBe(1)
    expect(toMegabytes(1.5 * 1024 * 1024)).toBe(1.5)
    expect(toMegabytes(12.34 * 1024 * 1024)).toBe(12.3)
  })

  it('builds a phase result with every group present', () => {
    const sample = sampleProcessMetrics([
      { pid: 1, type: 'Browser', memory: { workingSetSize: 2048 } },
      { pid: 2, type: 'Tab', memory: { workingSetSize: 1024 } }
    ])
    const result = createPhaseResult(
      'hidden-to-tray',
      sample,
      '2026-01-02T03:04:05.000Z'
    )
    expect(result).toEqual({
      phase: 'hidden-to-tray',
      totalsByGroup: { main: 2, gpu: 0, renderer: 1, utility: 0, other: 0 },
      total: 3,
      processes: 2,
      timestamp: '2026-01-02T03:04:05.000Z'
    })
  })

  it('reads the outfile path from the environment and ignores blanks', () => {
    expect(memoryBenchOutPath({})).toBeNull()
    expect(memoryBenchOutPath({ [MEMORY_BENCH_OUT_ENV]: '' })).toBeNull()
    expect(memoryBenchOutPath({ [MEMORY_BENCH_OUT_ENV]: '   ' })).toBeNull()
    expect(
      memoryBenchOutPath({ [MEMORY_BENCH_OUT_ENV]: ' C:\\tmp\\bench.json ' })
    ).toBe('C:\\tmp\\bench.json')
  })
})
