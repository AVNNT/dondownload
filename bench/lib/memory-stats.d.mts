export type MemoryGroupName =
  | 'main'
  | 'gpu'
  | 'renderer'
  | 'utility'
  | 'other'

export interface PhaseResultLike {
  phase: string
  total?: number
  processes?: number
  totalsByGroup?: Partial<Record<MemoryGroupName, number>>
}

export interface PhaseSummary {
  phase: string
  runs: number
  total: number | null
  processes: number | null
  groups: Record<MemoryGroupName, number | null>
}

export const MEMORY_GROUPS: readonly MemoryGroupName[]
export const MEMORY_PHASE_ORDER: readonly string[]
export function parsePhaseResults(payload: unknown): PhaseResultLike[]
export function median(values: readonly unknown[]): number | null
export function formatMegabytes(value: unknown): string
export function summarizeRuns(reports: readonly unknown[]): PhaseSummary[]
export function formatTable(summary: readonly PhaseSummary[]): string
