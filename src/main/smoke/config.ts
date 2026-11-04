import path from 'node:path'

/**
 * Explicit, opt-in smoke-test configuration.
 *
 * The smoke path is disabled unless the environment variable or the command-
 * line flag is present. When enabled it additionally requires an explicit,
 * isolated `--user-data-dir` and only accepts a result file inside that
 * directory. Invalid configuration must fail before Electron reaches `ready`
 * so a normal desktop session can never be started accidentally.
 */

export const SMOKE_ENV = 'DONDOWNLOAD_SMOKE_TEST'
export const SMOKE_RESULT_ENV = 'DONDOWNLOAD_SMOKE_RESULT_PATH'
export const SMOKE_FLAG = '--smoke-test'
export const SMOKE_USER_DATA_FLAG = '--user-data-dir'
export const SMOKE_RESULT_FILENAME = 'smoke-result.json'

export interface SmokeTestConfigInput {
  argv: readonly string[]
  env: NodeJS.ProcessEnv
  /** Electron's default userData path, computed without applying the switch. */
  defaultUserDataPath: string
  platform?: NodeJS.Platform
  cwd?: string
}

export interface SmokeTestConfigEnabled {
  enabled: true
  /** False means the caller must exit before Electron `ready`. */
  ok: boolean
  errors: string[]
  requestedBy: string[]
  userDataDir: string | null
  resultPath: string | null
}

export interface SmokeTestConfigDisabled {
  enabled: false
}

export type SmokeTestConfig = SmokeTestConfigEnabled | SmokeTestConfigDisabled

function pathApi(platform: NodeJS.Platform): typeof path.win32 {
  return platform === 'win32' ? path.win32 : path.posix
}

function envEnabled(env: NodeJS.ProcessEnv): boolean {
  return env[SMOKE_ENV] === '1'
}

function flagEnabled(argv: readonly string[]): boolean {
  return argv.includes(SMOKE_FLAG)
}

function readUserDataDir(
  argv: readonly string[]
): string | null {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === undefined) continue
    if (argument === SMOKE_USER_DATA_FLAG) {
      const next = argv[index + 1]
      return next === undefined ? null : next
    }
    if (argument.startsWith(`${SMOKE_USER_DATA_FLAG}=`)) {
      return argument.slice(SMOKE_USER_DATA_FLAG.length + 1)
    }
  }
  return null
}

function isInside(directory: string, candidate: string, api: typeof path.win32): boolean {
  const relative = api.relative(directory, candidate)
  return (
    relative.length > 0 &&
    relative !== '..' &&
    !relative.startsWith(`..${api.sep}`) &&
    !api.isAbsolute(relative)
  )
}

function comparable(value: string, platform: NodeJS.Platform): string {
  const normalized = pathApi(platform).resolve(value)
  return platform === 'win32' ? normalized.toLowerCase() : normalized
}

export function smokeTestEnabled(
  argv: readonly string[],
  env: NodeJS.ProcessEnv
): boolean {
  return envEnabled(env) || flagEnabled(argv)
}

export function loadSmokeTestConfig(
  input: SmokeTestConfigInput
): SmokeTestConfig {
  const platform = input.platform ?? process.platform
  const api = pathApi(platform)

  if (!smokeTestEnabled(input.argv, input.env)) {
    return { enabled: false }
  }

  const requestedBy: string[] = []
  if (envEnabled(input.env)) requestedBy.push('environment')
  if (flagEnabled(input.argv)) requestedBy.push('flag')

  const errors: string[] = []
  const rawUserDataDir = readUserDataDir(input.argv)

  let userDataDir: string | null = null
  if (rawUserDataDir === null || rawUserDataDir.trim().length === 0) {
    errors.push(
      `${SMOKE_USER_DATA_FLAG} is required. Pass a new, isolated directory; the real userData directory is refused.`
    )
  } else {
    const raw = rawUserDataDir.trim().replace(/^"(.*)"$/, '$1')
    if (!api.isAbsolute(raw)) {
      errors.push(
        `${SMOKE_USER_DATA_FLAG} must be an absolute path so the isolated directory is unambiguous.`
      )
    } else {
      const resolved = api.resolve(raw)
      if (resolved === api.parse(resolved).root) {
        errors.push(`${SMOKE_USER_DATA_FLAG} must not be a filesystem root.`)
      } else if (
        comparable(resolved, platform) ===
        comparable(input.defaultUserDataPath, platform)
      ) {
        errors.push(
          `${SMOKE_USER_DATA_FLAG} must not be the normal Electron userData directory.`
        )
      } else {
        userDataDir = resolved
      }
    }
  }

  let resultPath: string | null = null
  if (userDataDir !== null) {
    const rawResult = input.env[SMOKE_RESULT_ENV]?.trim()
    if (rawResult !== undefined && rawResult.length > 0) {
      if (!api.isAbsolute(rawResult)) {
        errors.push(`${SMOKE_RESULT_ENV} must be an absolute path.`)
      } else {
        const resolved = api.resolve(rawResult)
        if (!isInside(userDataDir, resolved, api)) {
          errors.push(
            `${SMOKE_RESULT_ENV} must point inside ${SMOKE_USER_DATA_FLAG}.`
          )
        } else {
          resultPath = resolved
        }
      }
    } else {
      resultPath = api.join(userDataDir, SMOKE_RESULT_FILENAME)
    }
  }

  return {
    enabled: true,
    ok: errors.length === 0,
    errors,
    requestedBy,
    userDataDir,
    resultPath
  }
}
