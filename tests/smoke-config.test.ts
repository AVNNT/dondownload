import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  SMOKE_ENV,
  SMOKE_RESULT_ENV,
  loadSmokeTestConfig,
  smokeTestEnabled
} from '../src/main/smoke/config'
import {
  createSmokeResult,
  summarizeChecks,
  type SmokeEnvironmentInfo
} from '../src/main/smoke/report'

const windows = path.win32
const defaultUserData = 'C:\\Users\\tester\\AppData\\Roaming\\DonDownload'
const isolatedUserData = 'C:\\Users\\tester\\AppData\\Local\\Temp\\dd-smoke-123'
const cwd = 'C:\\work\\DonDownload'

function config(
  argv: string[],
  env: NodeJS.ProcessEnv = {},
  platform: NodeJS.Platform = 'win32'
) {
  return loadSmokeTestConfig({
    argv,
    env,
    defaultUserDataPath: defaultUserData,
    cwd,
    platform
  })
}

const environment: SmokeEnvironmentInfo = {
  appVersion: '1.3.1',
  electronVersion: '45.2.2',
  chromeVersion: '140.0.0.0',
  nodeVersion: '24.19.0',
  platform: 'win32',
  arch: 'x64',
  packaged: true,
  userDataPath: isolatedUserData,
  resourcesPath: 'C:\\app\\resources'
}

describe('smoke-test opt-in configuration', () => {
  it('is disabled by default', () => {
    expect(smokeTestEnabled([], {})).toBe(false)
    expect(config([], {})).toEqual({ enabled: false })
    expect(
      config([`--user-data-dir=${isolatedUserData}`], {})
    ).toEqual({ enabled: false })
  })

  it('accepts the explicit environment flag and isolated userData directory', () => {
    const result = config(
      [`--user-data-dir=${isolatedUserData}`],
      { [SMOKE_ENV]: '1' }
    )

    expect(result).toMatchObject({
      enabled: true,
      ok: true,
      requestedBy: ['environment'],
      userDataDir: windows.resolve(isolatedUserData),
      resultPath: windows.join(isolatedUserData, 'smoke-result.json')
    })
  })

  it('accepts the explicit command-line flag and separate value form', () => {
    const result = config([
      '--smoke-test',
      '--user-data-dir',
      isolatedUserData
    ])

    expect(result).toMatchObject({
      enabled: true,
      ok: true,
      requestedBy: ['flag'],
      userDataDir: windows.resolve(isolatedUserData)
    })
  })

  it('refuses to start smoke mode without an isolated userData directory', () => {
    const result = config([], { [SMOKE_ENV]: '1' })

    expect(result).toMatchObject({
      enabled: true,
      ok: false,
      userDataDir: null,
      resultPath: null
    })
    if (result.enabled) {
      expect(result.errors.join(' ')).toContain('--user-data-dir is required')
    }
  })

  it('refuses a relative userData path', () => {
    const result = config(
      ['--smoke-test', '--user-data-dir', 'relative\\smoke'],
      {}
    )

    expect(result).toMatchObject({ enabled: true, ok: false })
    if (result.enabled) {
      expect(result.errors.join(' ')).toContain('must be an absolute path')
    }
  })

  it('refuses the normal Electron userData directory', () => {
    const result = config(
      ['--smoke-test', `--user-data-dir=${defaultUserData.toUpperCase()}`],
      {}
    )

    expect(result).toMatchObject({ enabled: true, ok: false })
    if (result.enabled) {
      expect(result.errors.join(' ')).toContain(
        'must not be the normal Electron userData directory'
      )
    }
  })

  it('refuses a result path outside the isolated userData directory', () => {
    const result = config(
      ['--smoke-test', `--user-data-dir=${isolatedUserData}`],
      {
        [SMOKE_RESULT_ENV]: 'C:\\Users\\tester\\Desktop\\smoke.json'
      }
    )

    expect(result).toMatchObject({ enabled: true, ok: false })
    if (result.enabled) {
      expect(result.errors.join(' ')).toContain(
        'must point inside --user-data-dir'
      )
    }
  })
})

describe('smoke-test machine-readable report', () => {
  it('only reports PASS when every check passed', () => {
    expect(summarizeChecks([])).toBe('FAIL')
    expect(
      summarizeChecks([{ status: 'PASS' }, { status: 'PASS' }])
    ).toBe('PASS')
    expect(
      summarizeChecks([{ status: 'PASS' }, { status: 'FAIL' }])
    ).toBe('FAIL')
  })

  it('serializes checks, environment and status deterministically', () => {
    const result = createSmokeResult({
      startedAt: '2026-11-04T00:00:00.000Z',
      now: () => Date.parse('2026-11-04T00:00:01.250Z'),
      environment,
      checks: [
        {
          name: 'electron.ready',
          status: 'PASS',
          detail: 'Electron 45.2.2',
          durationMs: 1
        }
      ],
      logs: ['started']
    })

    expect(result).toMatchObject({
      schemaVersion: 2,
      kind: 'dondownload-smoke-test',
      status: 'PASS',
      durationMs: 1_250,
      environment: {
        packaged: true,
        userDataPath: isolatedUserData
      }
    })
    expect(JSON.parse(JSON.stringify(result))).toEqual(result)
  })
})
