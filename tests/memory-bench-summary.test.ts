import { describe, expect, it } from 'vitest'
import {
  formatMegabytes,
  formatTable,
  median,
  parsePhaseResults,
  summarizeRuns
} from '../bench/lib/memory-stats.mjs'

function fakePhase(
  phase: string,
  total: number,
  groups: Record<string, number> = {}
) {
  return {
    phase,
    total,
    processes: 4,
    totalsByGroup: {
      main: total / 2,
      gpu: 0,
      renderer: total / 4,
      utility: 0,
      other: 0,
      ...groups
    }
  }
}

describe('memory bench summary', () => {
  it('computes a median for odd and even counts', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 3, 2])).toBe(2.5)
    expect(median([7])).toBe(7)
  })

  it('ignores missing or non-finite values and reports an empty count', () => {
    expect(median([])).toBeNull()
    expect(median([Number.NaN, 10, null, undefined, 20])).toBe(15)
  })

  it('formats megabytes with one decimal', () => {
    expect(formatMegabytes(312.44)).toBe('312.4 MB')
    expect(formatMegabytes(0)).toBe('0.0 MB')
    expect(formatMegabytes(null)).toBe('—')
    expect(formatMegabytes(Number.NaN)).toBe('—')
  })

  it('accepts either a phase array or a report object', () => {
    const phases = [fakePhase('window-open-idle', 100)]
    expect(parsePhaseResults(phases)).toEqual(phases)
    expect(parsePhaseResults({ phases })).toEqual(phases)
    expect(parsePhaseResults({ generatedAt: 'now' })).toEqual([])
    expect(parsePhaseResults(null)).toEqual([])
  })

  it('medians each phase across runs in a stable order', () => {
    const runs = [
      {
        phases: [
          fakePhase('window-open-idle', 100),
          fakePhase('hidden-to-tray', 40)
        ]
      },
      {
        phases: [
          fakePhase('window-open-idle', 200),
          fakePhase('hidden-to-tray', 60),
          fakePhase('custom-phase', 10)
        ]
      },
      {
        phases: [
          fakePhase('window-open-idle', 300),
          { phase: 'broken', totalsByGroup: {} }
        ]
      }
    ]

    const summary = summarizeRuns(runs)

    expect(summary.map((entry) => entry.phase)).toEqual([
      'window-open-idle',
      'hidden-to-tray',
      'custom-phase',
      'broken'
    ])
    expect(summary.map((entry) => entry.runs)).toEqual([3, 2, 1, 1])
    const idle = summary[0]
    expect(idle?.total).toBe(200)
    expect(idle?.processes).toBe(4)
    expect(idle?.groups).toEqual({
      main: 100,
      gpu: 0,
      renderer: 50,
      utility: 0,
      other: 0
    })
    expect(summary[3]?.total).toBeNull()
  })

  it('renders a per-phase median table', () => {
    const summary = summarizeRuns([
      { phases: [fakePhase('window-open-idle', 100)] },
      { phases: [fakePhase('window-open-idle', 300)] }
    ])
    const table = formatTable(summary)
    const lines = table.split('\n')

    expect(lines[0]).toContain('phase')
    expect(lines[0]).toContain('total')
    expect(lines[0]).toContain('renderer')
    expect(lines[1]).toContain('window-open-idle')
    expect(lines[1]).toContain('200.0 MB')
    expect(lines.length).toBe(2)
  })
})
