/**
 * Pure aggregation helpers for the memory benchmark harness.
 *
 * `bench/memory.mjs` launches the app several times and gets one JSON report
 * per run from `src/main/memoryBench/runner.ts`. These functions turn those
 * reports into per-phase medians and a printable table; they touch no
 * processes or files so `tests/memory-bench-summary.test.ts` can cover them.
 */

/** Mirrors the groups produced by `src/main/memoryBench/metrics.ts`. */
export const MEMORY_GROUPS = ['main', 'gpu', 'renderer', 'utility', 'other']

/** Stable table order; unexpected phases follow in first-seen order. */
export const MEMORY_PHASE_ORDER = [
  'window-open-idle',
  'hidden-to-tray',
  'shown-again'
]

/**
 * Accept either a bare array of phase results or a full report object, so an
 * older/newer runner cannot break the harness.
 */
export function parsePhaseResults(payload) {
  if (Array.isArray(payload)) return payload
  if (payload !== null && typeof payload === 'object') {
    if (Array.isArray(payload.phases)) return payload.phases
  }
  return []
}

/** Standard median: average of the two middle values for an even count. */
export function median(values) {
  const numbers = []
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) numbers.push(value)
  }
  if (numbers.length === 0) return null
  numbers.sort((left, right) => left - right)
  const middle = Math.floor(numbers.length / 2)
  if (numbers.length % 2 === 1) return numbers[middle]
  return (numbers[middle - 1] + numbers[middle]) / 2
}

/** One-decimal megabytes, or an em dash when a value is unavailable. */
export function formatMegabytes(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  return `${value.toFixed(1)} MB`
}

/**
 * Collapse several runs into one summary per phase. Every group is present so
 * the table columns never shift between phases or runs.
 */
export function summarizeRuns(reports) {
  const byPhase = new Map()
  for (const report of reports) {
    for (const result of parsePhaseResults(report)) {
      if (result === null || typeof result !== 'object') continue
      const phase = result.phase
      if (typeof phase !== 'string' || phase.length === 0) continue
      const results = byPhase.get(phase) ?? []
      results.push(result)
      byPhase.set(phase, results)
    }
  }

  const phases = MEMORY_PHASE_ORDER.filter((phase) => byPhase.has(phase))
  for (const phase of byPhase.keys()) {
    if (!phases.includes(phase)) phases.push(phase)
  }

  return phases.map((phase) => {
    const results = byPhase.get(phase) ?? []
    const groups = {}
    for (const group of MEMORY_GROUPS) {
      groups[group] = median(
        results.map((result) => result.totalsByGroup?.[group])
      )
    }
    return {
      phase,
      runs: results.length,
      total: median(results.map((result) => result.total)),
      processes: median(results.map((result) => result.processes)),
      groups
    }
  })
}

function pad(value, width, align = 'left') {
  return align === 'right' ? value.padStart(width) : value.padEnd(width)
}

/** Render the per-phase median table printed by `npm run bench:memory`. */
export function formatTable(summary) {
  const columns = [
    { title: 'phase', key: 'phase', width: 18 },
    { title: 'runs', key: 'runs', width: 5, align: 'right' },
    { title: 'total', key: 'total', width: 10, align: 'right' },
    ...MEMORY_GROUPS.map((group) => ({
      title: group,
      key: group,
      width: 10,
      align: 'right'
    }))
  ]

  const cell = (entry, column) => {
    if (column.key === 'phase') return entry.phase
    if (column.key === 'runs') return String(entry.runs)
    if (column.key === 'total') return formatMegabytes(entry.total)
    return formatMegabytes(entry.groups[column.key])
  }

  const lines = [
    columns.map((column) => pad(column.title, column.width, column.align)).join('  ')
  ]
  for (const entry of summary) {
    lines.push(
      columns
        .map((column) => pad(cell(entry, column), column.width, column.align))
        .join('  ')
    )
  }
  return lines.join('\n')
}
