import { promises as fs } from 'node:fs'
import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

export type SmokeCheckStatus = 'PASS' | 'FAIL'

export interface SmokeCheckResult {
  name: string
  status: SmokeCheckStatus
  detail: string
  durationMs: number
}

export interface SmokeEnvironmentInfo {
  appVersion: string
  electronVersion: string
  chromeVersion: string
  nodeVersion: string
  platform: string
  arch: string
  packaged: boolean
  userDataPath: string
  resourcesPath: string
}

export interface SmokeTestResult {
  schemaVersion: 1
  kind: 'dondownload-smoke-test'
  status: SmokeCheckStatus
  startedAt: string
  finishedAt: string
  durationMs: number
  pid: number
  environment: SmokeEnvironmentInfo
  checks: SmokeCheckResult[]
  logs: string[]
}

export function summarizeChecks(
  checks: readonly Pick<SmokeCheckResult, 'status'>[]
): SmokeCheckStatus {
  if (checks.length === 0) return 'FAIL'
  return checks.every((check) => check.status === 'PASS') ? 'PASS' : 'FAIL'
}

export function safeDetail(value: unknown, maximum = 500): string {
  const text =
    value instanceof Error
      ? value.message
      : typeof value === 'string'
        ? value
        : String(value)
  const cleaned = text
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (cleaned.length === 0) return 'no detail'
  return cleaned.slice(0, maximum)
}

export function createSmokeResult(input: {
  startedAt?: string
  environment: SmokeEnvironmentInfo
  checks: SmokeCheckResult[]
  logs: string[]
  now?: () => number
}): SmokeTestResult {
  const now = input.now ?? Date.now
  const finishedMs = now()
  const startedAt = input.startedAt ?? new Date(finishedMs).toISOString()
  const startedMs = Date.parse(startedAt)
  return {
    schemaVersion: 1,
    kind: 'dondownload-smoke-test',
    status: summarizeChecks(input.checks),
    startedAt,
    finishedAt: new Date(finishedMs).toISOString(),
    durationMs: Number.isFinite(startedMs)
      ? Math.max(0, finishedMs - startedMs)
      : 0,
    pid: process.pid,
    environment: input.environment,
    checks: input.checks,
    logs: input.logs
  }
}

export function serializeSmokeResult(result: SmokeTestResult): string {
  return `${JSON.stringify(result, null, 2)}\n`
}

export async function writeSmokeResult(
  resultPath: string,
  result: SmokeTestResult
): Promise<void> {
  await fs.mkdir(path.dirname(resultPath), { recursive: true })
  await fs.writeFile(resultPath, serializeSmokeResult(result), {
    encoding: 'utf8',
    mode: 0o600
  })
}

/** Used before Electron is ready, so the normal async path is unavailable. */
export function writeSmokeResultSync(
  resultPath: string,
  result: SmokeTestResult
): void {
  mkdirSync(path.dirname(resultPath), { recursive: true })
  writeFileSync(resultPath, serializeSmokeResult(result), {
    encoding: 'utf8',
    mode: 0o600
  })
}
