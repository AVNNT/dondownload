import { spawn as nodeSpawn } from 'node:child_process'

/**
 * The small child-process surface the engine needs. Tests inject a fake that
 * implements only these members.
 */
export interface MediaProcess {
  readonly pid?: number
  readonly stdout: NodeJS.ReadableStream | null
  readonly stderr: NodeJS.ReadableStream | null
  on(event: string, listener: (...args: any[]) => void): unknown
  kill(signal?: NodeJS.Signals): boolean
  unref?(): void
}

export type MediaStdio = 'ignore' | ['ignore', 'pipe', 'pipe']

export interface MediaSpawnOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  shell: false
  windowsHide: boolean
  stdio: MediaStdio
}

export type MediaSpawn = (
  command: string,
  args: readonly string[],
  options: MediaSpawnOptions
) => MediaProcess

export const defaultMediaSpawn: MediaSpawn = (command, args, options) =>
  nodeSpawn(command, args, options) as unknown as MediaProcess

/**
 * Terminate a yt-dlp process and its ffmpeg children.
 *
 * On Windows a plain `child.kill()` leaves a separately spawned ffmpeg process
 * alive, so the tree is terminated with the system `taskkill` utility. The
 * command and arguments are fixed, no shell is used, and `taskkill` is only
 * used for the PID of the child this engine created.
 */
export function terminateProcessTree(
  child: MediaProcess,
  platform: NodeJS.Platform,
  spawn: MediaSpawn,
  env: NodeJS.ProcessEnv
): void {
  const pid = child.pid
  if (platform === 'win32' && typeof pid === 'number' && pid > 0) {
    let killer: MediaProcess | null = null
    try {
      killer = spawn(
        'taskkill',
        ['/pid', String(pid), '/T', '/F'],
        { env, shell: false, windowsHide: true, stdio: 'ignore' }
      )
      killer.on('error', () => {
        // taskkill itself failed; fall back to terminating the parent.
        try {
          child.kill()
        } catch {
          // The process may already have exited.
        }
      })
      killer.unref?.()
    } catch {
      killer = null
    }

    if (killer !== null) {
      // Do not call child.kill() immediately: that could terminate yt-dlp
      // before taskkill can enumerate and kill its ffmpeg children.
      const fallback = setTimeout(() => {
        try {
          child.kill()
        } catch {
          // The process may already have exited.
        }
      }, 2_000)
      fallback.unref?.()
      child.on('close', () => clearTimeout(fallback))
      return
    }
  }

  try {
    child.kill()
  } catch {
    // The process may already have exited.
  }

  if (platform !== 'win32') {
    const hardKill = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // The process may already have exited.
      }
    }, 2_000)
    hardKill.unref?.()
    child.on('close', () => clearTimeout(hardKill))
  }
}

export interface CapturedProcessOptions {
  spawn: MediaSpawn
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  cwd?: string
  timeoutMs: number
  maxOutputBytes: number
}

export interface CapturedProcessResult {
  code: number | null
  stdout: string
  stderr: string
}

export class ProcessTimeoutError extends Error {
  constructor() {
    super('The process did not finish in time.')
    this.name = 'ProcessTimeoutError'
  }
}

export class ProcessStartError extends Error {
  constructor() {
    super('The process could not be started.')
    this.name = 'ProcessStartError'
  }
}

export class ProcessOutputError extends Error {
  constructor() {
    super('The process returned too much output.')
    this.name = 'ProcessOutputError'
  }
}

/**
 * Run a bounded, captured subprocess. Error details deliberately omit the
 * command, arguments and streams because they may contain a URL or path.
 */
export function runCapturedProcess(
  command: string,
  args: readonly string[],
  options: CapturedProcessOptions
): Promise<CapturedProcessResult> {
  return new Promise<CapturedProcessResult>((resolve, reject) => {
    let child: MediaProcess
    try {
      child = options.spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch {
      reject(new ProcessStartError())
      return
    }

    let stdout = ''
    let stderr = ''
    let outputBytes = 0
    let settled = false
    let timer: NodeJS.Timeout | null = null

    const finish = (): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
    }

    const fail = (error: Error): void => {
      if (settled) return
      finish()
      reject(error)
    }

    const append = (target: 'stdout' | 'stderr', chunk: unknown): void => {
      if (settled) return
      const text = typeof chunk === 'string' ? chunk : String(chunk)
      outputBytes += text.length
      if (outputBytes > options.maxOutputBytes) {
        terminateProcessTree(child, options.platform, options.spawn, options.env)
        fail(new ProcessOutputError())
        return
      }
      if (target === 'stdout') stdout += text
      else stderr += text
    }

    child.stdout?.on('data', (chunk: unknown) => append('stdout', chunk))
    child.stderr?.on('data', (chunk: unknown) => append('stderr', chunk))
    child.on('error', () => fail(new ProcessStartError()))
    child.on('close', (code: number | null) => {
      if (settled) return
      finish()
      resolve({ code, stdout, stderr })
    })

    if (options.timeoutMs > 0) {
      timer = setTimeout(() => {
        terminateProcessTree(child, options.platform, options.spawn, options.env)
        fail(new ProcessTimeoutError())
      }, options.timeoutMs)
    }
  })
}
