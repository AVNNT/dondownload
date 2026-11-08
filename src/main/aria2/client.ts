import { AppError } from '../errors'
import {
  buildMulticallRequest,
  buildRpcRequest,
  parseRpcResponse,
  parseRpcSubCalls
} from './rpc'

interface Aria2Version {
  version: string
  enabledFeatures: string[]
}

export class Aria2Client {
  private nextRequestId = 1

  constructor(
    private readonly port: number,
    private readonly secret: string
  ) {}

  private get endpoint(): string {
    return `http://127.0.0.1:${this.port}/jsonrpc`
  }

  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    const body =
      method === 'system.multicall'
        ? buildMulticallRequest(
            this.nextRequestId++,
            this.secret,
            parseRpcSubCalls(params[0])
          )
        : buildRpcRequest(this.nextRequestId++, method, this.secret, params)

    let response: Response
    try {
      response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8_000)
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'connection failed'
      throw new AppError(
        'ARIA2_UNREACHABLE',
        `Could not reach the local aria2 process: ${detail}`,
        'Use Retry aria2 in the top bar, or check that the aria2 process is still running.'
      )
    }

    let text: string
    try {
      text = await response.text()
    } catch {
      throw new AppError('ARIA2_UNREACHABLE', 'Could not read the response from aria2.')
    }

    if (text.length > 10_000_000) {
      throw new AppError('ARIA2_RPC_ERROR', 'aria2 returned an unexpectedly large response.')
    }

    // aria2 reports JSON-RPC failures (for example an unknown GID) as HTTP 400
    // with a JSON error body. The message is the only way to tell a lost
    // transfer apart from a transport problem, so parse the body even when the
    // HTTP status is an error, and fall back to the status only if it is not
    // JSON.
    let payload: unknown
    try {
      payload = JSON.parse(text)
    } catch {
      throw new AppError(
        'ARIA2_RPC_ERROR',
        response.ok
          ? 'aria2 returned malformed JSON.'
          : `aria2 RPC failed with HTTP ${response.status}.`
      )
    }

    const parsed = parseRpcResponse(payload)
    if (!parsed.ok) {
      throw new AppError('ARIA2_RPC_ERROR', parsed.message)
    }
    if (!response.ok) {
      throw new AppError('ARIA2_RPC_ERROR', `aria2 RPC failed with HTTP ${response.status}.`)
    }

    return parsed.result as T
  }

  async getVersion(): Promise<Aria2Version> {
    const version = await this.call<Record<string, unknown>>('aria2.getVersion')
    return {
      version: typeof version.version === 'string' ? version.version : 'unknown',
      enabledFeatures: Array.isArray(version.enabledFeatures)
        ? version.enabledFeatures.filter(
            (feature): feature is string => typeof feature === 'string'
          )
        : []
    }
  }
}
