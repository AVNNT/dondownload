import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { UrlSizeProbe } from '@shared/types'

export const URL_SIZE_TIMEOUT_MS = 5_000
const MAX_REDIRECTS = 5

/**
 * Bounded anonymous HEAD probe that reports a direct link's total bytes,
 * or null when the size cannot be known. Only http/https targets are
 * contacted; any error, timeout, non-2xx response or missing
 * content-length fails closed to null.
 */
export async function probeUrlSize(url: string): Promise<UrlSizeProbe> {
  let current: URL
  try {
    current = new URL(url)
  } catch {
    return { size: null }
  }
  if (current.protocol !== 'http:' && current.protocol !== 'https:') {
    return { size: null }
  }

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await requestHead(current)
    if (response === null) return { size: null }
    if (isRedirect(response.status)) {
      const location = headerString(response.headers.location)
      if (location === null) return { size: null }
      let next: URL
      try {
        next = new URL(location, current)
      } catch {
        return { size: null }
      }
      if (next.protocol !== 'http:' && next.protocol !== 'https:') {
        return { size: null }
      }
      current = next
      continue
    }
    if (response.status >= 200 && response.status < 300) {
      return { size: parseContentLength(response.headers['content-length']) }
    }
    return { size: null }
  }
  return { size: null }
}

function isRedirect(status: number): boolean {
  return (
    status === 301 ||
    status === 302 ||
    status === 303 ||
    status === 307 ||
    status === 308
  )
}

interface HeadResponse {
  status: number
  headers: Record<string, string | string[] | undefined>
}

function requestHead(target: URL): Promise<HeadResponse | null> {
  const sendRequest =
    target.protocol === 'https:' ? httpsRequest : httpRequest
  return new Promise((resolve) => {
    let settled = false
    const finish = (result: HeadResponse | null): void => {
      if (settled) return
      settled = true
      resolve(result)
    }
    let request: ReturnType<typeof httpRequest>
    try {
      request = sendRequest(target, { method: 'HEAD' }, (response) => {
        // Only the headers are of interest; close the socket immediately.
        response.destroy()
        finish({
          status: response.statusCode ?? 0,
          headers: response.headers
        })
      })
    } catch {
      finish(null)
      return
    }
    request.setTimeout(URL_SIZE_TIMEOUT_MS, () => {
      request.destroy()
      finish(null)
    })
    request.on('error', () => finish(null))
    request.end()
  })
}

function headerString(value: string | string[] | undefined): string | null {
  if (typeof value !== 'string' || value.length === 0) return null
  return value
}

function parseContentLength(
  value: string | string[] | undefined
): number | null {
  if (typeof value !== 'string') return null
  const size = Number(value)
  if (!Number.isSafeInteger(size) || size < 0) return null
  return size
}
