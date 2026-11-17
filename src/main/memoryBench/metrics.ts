/**
 * Per-process memory sampling for the memory benchmark.
 *
 * `app.getAppMetrics()` returns one entry per Chromium process with sizes in
 * kilobytes. The benchmark groups them the way a user reads the Task Manager:
 * the main (browser) process, the GPU process, renderer tabs and utilities.
 * Everything here is pure so the grouping can be unit tested without Electron.
 */

export type MemoryProcessGroup =
  | 'main'
  | 'gpu'
  | 'renderer'
  | 'utility'
  | 'other'

/** The subset of Electron's `ProcessMetric` this module reads. */
export interface ProcessMetricLike {
  pid: number
  type: string
  /** Electron reports a human name for utility processes. */
  name?: string
  memory?: {
    workingSetSize?: number
    peakWorkingSetSize?: number
    privateBytes?: number
  }
}

export interface MemoryProcessSample {
  pid: number
  /** Electron's raw process type, for example `Browser`, `Tab` or `GPU`. */
  type: string
  group: MemoryProcessGroup
  workingSetBytes: number
  privateBytes: number
}

export interface MemoryGroupTotals {
  group: MemoryProcessGroup
  processes: number
  workingSetBytes: number
  privateBytes: number
}

export interface MemorySample {
  processes: MemoryProcessSample[]
  /** Every group is present, so the JSON shape does not depend on the run. */
  groups: MemoryGroupTotals[]
  total: {
    processes: number
    workingSetBytes: number
    privateBytes: number
  }
}

/** Electron's `ProcessMetric.type` values, mapped to a user-facing group. */
const GROUP_BY_TYPE: Readonly<Record<string, MemoryProcessGroup>> = {
  Browser: 'main',
  GPU: 'gpu',
  Tab: 'renderer',
  Utility: 'utility'
}

const GROUP_ORDER: readonly MemoryProcessGroup[] = [
  'main',
  'gpu',
  'renderer',
  'utility',
  'other'
]

/** Electron's memory figures are kilobytes; every reported size is bytes. */
const KIB = 1024

export function groupForProcessType(type: string): MemoryProcessGroup {
  return GROUP_BY_TYPE[type] ?? 'other'
}

function bytes(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value * KIB)
    : 0
}

/** Convert one `getAppMetrics()` result into grouped byte totals. */
export function sampleProcessMetrics(
  metrics: readonly ProcessMetricLike[]
): MemorySample {
  const processes: MemoryProcessSample[] = metrics.map((metric) => ({
    pid: metric.pid,
    type: metric.type,
    group: groupForProcessType(metric.type),
    workingSetBytes: bytes(metric.memory?.workingSetSize),
    privateBytes: bytes(metric.memory?.privateBytes)
  }))

  const groups: MemoryGroupTotals[] = GROUP_ORDER.map((group) => {
    const members = processes.filter((process) => process.group === group)
    return {
      group,
      processes: members.length,
      workingSetBytes: members.reduce(
        (total, process) => total + process.workingSetBytes,
        0
      ),
      privateBytes: members.reduce(
        (total, process) => total + process.privateBytes,
        0
      )
    }
  })

  return {
    processes,
    groups,
    total: {
      processes: processes.length,
      workingSetBytes: processes.reduce(
        (total, process) => total + process.workingSetBytes,
        0
      ),
      privateBytes: processes.reduce(
        (total, process) => total + process.privateBytes,
        0
      )
    }
  }
}
