import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { createServer } from 'node:net'
import path from 'node:path'
import type { Aria2State } from '@shared/types'
import { AppError } from '../errors'
import { createNoopHost, type CoreHost } from '../host'
import { logDebug, logError, logInfo, logWarn } from '../logging'
import { buildAria2Args } from './args'
import { Aria2Client } from './client'
import { locateAria2c } from './locator'
import { lowerProcessPriority } from '../processPriority'

const START_TIMEOUT_MS = 12_000
const READY_POLL_INTERVAL_MS = 200

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (typeof address !== 'object' || address === null) {
        server.close()
        reject(new Error('Could not allocate a local RPC port.'))
        return
      }
      const port = address.port
      server.close((error) => {
        if (error) reject(error)
        else resolve(port)
      })
    })
  })
}

export class Aria2Service {
  private child: ChildProcess | null = null
  private client: Aria2Client | null = null
  private startPromise: Promise<Aria2Client> | null = null
  private startGeneration = 0
  private stopping = false
  private stderrTail = ''
  private state: Aria2State = {
    status: 'stopped',
    version: null,
    binaryPath: null,
    message: null,
    hint: null
  }

  onStateChange: (() => void) | null = null
  /**
   * Applied after aria2 answers but before this service reports `ready` (and
   * before `start()` resolves), so a persisted settings snapshot is in effect
   * for the first download. A failure aborts startup instead of running with a
   * silently different configuration.
   */
  onBeforeReady: ((client: Aria2Client) => Promise<void>) | null = null

  constructor(
    private readonly downloadDir: () => string,
    private readonly host: CoreHost = createNoopHost()
  ) {}

  getState(): Aria2State {
    return { ...this.state }
  }

  async start(): Promise<Aria2Client> {
    if (this.state.status === 'ready' && this.client) {
      return this.client
    }
    if (this.startPromise) {
      return this.startPromise
    }

    this.startPromise = this.doStart().finally(() => {
      this.startPromise = null
    })
    return this.startPromise
  }

  private setState(next: Aria2State): void {
    this.state = next
    this.onStateChange?.()
  }

  private async doStart(): Promise<Aria2Client> {
    const generation = ++this.startGeneration
    this.setState({
      status: 'starting',
      version: null,
      binaryPath: null,
      message: 'Locating and starting aria2…',
      hint: null
    })

    let binaryPath: string
    try {
      binaryPath = await locateAria2c(this.host)
    } catch (error) {
      const info =
        error instanceof AppError
          ? { message: error.message, hint: error.hint ?? null }
          : { message: 'aria2c could not be located.', hint: null }
      this.setState({
        status: 'unavailable',
        version: null,
        binaryPath: null,
        message: info.message,
        hint: info.hint
      })
      throw error
    }

    const downloadDir = this.downloadDir()
    try {
      await fs.mkdir(downloadDir, { recursive: true })
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'unknown error'
      const message = `The download folder could not be created: ${detail}`
      this.setState({
        status: 'error',
        version: null,
        binaryPath,
        message,
        hint: 'Check that the Downloads folder exists and is writable, then restart aria2.'
      })
      throw new AppError('DOWNLOAD_DIR_UNAVAILABLE', message)
    }

    if (generation !== this.startGeneration) {
      throw new AppError('ARIA2_STOPPED', 'aria2 startup was cancelled.')
    }

    let port: number
    try {
      port = await findFreePort()
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'unknown error'
      const message = `A local RPC port could not be allocated: ${detail}`
      this.setState({
        status: 'error',
        version: null,
        binaryPath,
        message,
        hint: 'Another local service may be blocking loopback ports. Retry aria2.'
      })
      throw new AppError('ARIA2_START_FAILED', message)
    }

    if (generation !== this.startGeneration) {
      throw new AppError('ARIA2_STOPPED', 'aria2 startup was cancelled.')
    }

    const secret = randomBytes(24).toString('hex')
    const args = buildAria2Args({ port, secret, downloadDir })

    if (generation !== this.startGeneration) {
      throw new AppError('ARIA2_STOPPED', 'aria2 startup was cancelled.')
    }

    this.stderrTail = ''
    this.stopping = false
    let spawnError: Error | null = null
    const getSpawnError = (): Error | null => spawnError

    // Arguments are passed as an array with shell disabled: URL and file name
    // values are never interpolated into a command line string.
    const child = spawn(binaryPath, args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe']
    })
    this.child = child
    lowerProcessPriority(child.pid)
    // Diagnostics only: the executable's name and the pid. The command line
    // carries the RPC secret and the download folder, so it is never logged.
    logInfo('aria2 started (pid %d) from %s', child.pid ?? -1, path.basename(binaryPath))

    child.once('error', (error) => {
      spawnError = error
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-4_000)
    })
    child.once('exit', (code) => {
      const isCurrent = this.child === child
      if (isCurrent) {
        this.child = null
        this.client = null
      }
      // Ignore exits from a process we intentionally stopped or replaced.
      if (this.stopping || !isCurrent) {
        logDebug('aria2 exited after a stop request (code %s)', String(code))
        return
      }
      logError('aria2 exited unexpectedly (code %s)', String(code))
      this.setState({
        status: 'error',
        version: this.state.version,
        binaryPath,
        message: `aria2 stopped unexpectedly${code === null ? '' : ` (exit code ${code})`}.`,
        hint: 'Use Retry aria2 in the top bar. Active downloads may need to be retried.'
      })
    })

    const client = new Aria2Client(port, secret)
    const deadline = Date.now() + START_TIMEOUT_MS
    let lastError: Error | null = null

    while (Date.now() < deadline) {
      if (getSpawnError() || child.exitCode !== null) {
        break
      }

      let version: { version: string }
      try {
        version = await client.getVersion()
      } catch (error) {
        lastError = error instanceof Error ? error : new Error('aria2 did not respond.')
        await delay(READY_POLL_INTERVAL_MS)
        continue
      }

      if (generation !== this.startGeneration) {
        child.kill()
        throw new AppError('ARIA2_STOPPED', 'aria2 startup was cancelled.')
      }

      // Apply persisted global settings before exposing a ready engine. This is
      // deliberately before both the state update and the start() resolution.
      try {
        await this.onBeforeReady?.(client)
      } catch {
        if (generation !== this.startGeneration) {
          child.kill()
          throw new AppError('ARIA2_STOPPED', 'aria2 startup was cancelled.')
        }
        this.child = null
        this.client = null
        if (child.exitCode === null) child.kill()
        const message =
          'aria2 started but the download settings could not be applied.'
        this.setState({
          status: 'error',
          version: version.version,
          binaryPath,
          message,
          hint: 'Use Retry aria2. If this continues, reset the download settings.'
        })
        throw new AppError('ARIA2_SETTINGS_FAILED', message, this.state.hint ?? undefined)
      }

      if (generation !== this.startGeneration) {
        child.kill()
        throw new AppError('ARIA2_STOPPED', 'aria2 startup was cancelled.')
      }

      this.client = client
      this.setState({
        status: 'ready',
        version: version.version,
        binaryPath,
        message: null,
        hint: null
      })
      logInfo('aria2 ready, version %s', version.version)
      return client
    }

    if (child.exitCode === null) {
      child.kill()
    }
    this.child = null
    this.client = null

    const detail = this.stderrTail
      .trim()
      .split(/\r?\n/)
      .slice(-2)
      .join(' ')
      .slice(0, 300)
    const reason =
      getSpawnError()?.message ||
      detail ||
      (lastError instanceof Error ? lastError.message : '')
    const message = reason
      ? `aria2 failed to start: ${reason}`
      : 'aria2 did not become ready in time.'

    if (generation !== this.startGeneration) {
      throw new AppError('ARIA2_STOPPED', 'aria2 startup was cancelled.')
    }

    this.setState({
      status: 'error',
      version: null,
      binaryPath,
      message,
      hint: 'Check that aria2c.exe runs from a terminal and that the download folder is writable, then restart aria2.'
    })
    // The reason may quote aria2's own stderr, which can name a file path;
    // logWarn redacts it. The cancel branch above already returned.
    logWarn('aria2 failed to start: %s', reason || message)
    throw new AppError('ARIA2_START_FAILED', message, this.state.hint ?? undefined)
  }

  async stop(): Promise<void> {
    this.startGeneration += 1
    this.stopping = true
    const client = this.client
    const child = this.child
    this.client = null
    this.child = null

    if (client) {
      try {
        await client.call('aria2.shutdown')
      } catch {
        // The process may already be gone; killing below is the fallback.
      }
    }

    if (child && child.exitCode === null) {
      child.kill()
    }

    this.setState({
      status: 'stopped',
      version: null,
      binaryPath: null,
      message: null,
      hint: null
    })
    this.stopping = false
  }

  async restart(): Promise<void> {
    await this.stop()
    await this.start()
  }

  /** Resolve the aria2 client, starting the process lazily if needed. */
  async getClient(): Promise<Aria2Client> {
    return this.start()
  }

  /** Use only an already-running client; never start aria2 as a side effect. */
  getReadyClient(): Aria2Client | null {
    return this.state.status === 'ready' ? this.client : null
  }
}

export function defaultDownloadDir(downloadsPath: string): string {
  return path.join(downloadsPath, 'DonDownload')
}
