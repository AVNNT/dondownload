import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { fetchScanPage, type ScanFetchConnectLookup } from '../src/main/scanner/fetchPage'
import type { PublicTargetLookup } from '../src/main/net/publicTarget'

interface SeenRequest {
  url: string
  cookie: string | undefined
}

const servers: Server[] = []

async function listen(
  handler: Parameters<typeof createServer>[1]
): Promise<{ server: Server; port: number }> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, port: (server.address() as AddressInfo).port }
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

const publicLookup: PublicTargetLookup = async () => [
  { address: '93.184.216.34', family: 4 }
]

const privateLookup: PublicTargetLookup = async (hostname) =>
  hostname === 'private.example'
    ? [{ address: '127.0.0.1', family: 4 }]
    : [{ address: '93.184.216.34', family: 4 }]

const connectLookup: ScanFetchConnectLookup = (_hostname, options, callback) => {
  if (options && options.all === true) {
    callback(null, [{ address: '127.0.0.1', family: 4 }])
    return
  }
  callback(null, '127.0.0.1', 4)
}

describe('bounded scanner page fetch', () => {
  it('never forwards an exact-host cookie to a different redirect host', async () => {
    const seen: SeenRequest[] = []
    const { port } = await listen((request, response) => {
      seen.push({ url: request.url ?? '', cookie: request.headers.cookie })
      if (request.url === '/start') {
        response.writeHead(302, {
          Location: `http://other.example:${port}/file`
        })
        response.end()
        return
      }
      response.writeHead(200, { 'Content-Type': 'text/html' })
      response.end('<html>other host</html>')
    })

    await expect(
      fetchScanPage(
        {
          url: `http://public.example:${port}/start`,
          cookie: 'auth=1',
          accept: 'html'
        },
        { lookup: publicLookup, connectLookup }
      )
    ).rejects.toMatchObject({ code: 'SCAN_COOKIE_REDIRECT' })

    expect(seen).toHaveLength(1)
    expect(seen[0]?.cookie).toBe('auth=1')
  })

  it('revalidates every redirect hop and blocks a private-IP target', async () => {
    const seen: SeenRequest[] = []
    const { port } = await listen((request, response) => {
      seen.push({ url: request.url ?? '', cookie: request.headers.cookie })
      if (request.url === '/start') {
        response.writeHead(302, {
          Location: `http://private.example:${port}/file`
        })
        response.end()
        return
      }
      response.writeHead(200, { 'Content-Type': 'text/html' })
      response.end('<html>private</html>')
    })

    await expect(
      fetchScanPage(
        { url: `http://public.example:${port}/start`, accept: 'html' },
        { lookup: privateLookup, connectLookup }
      )
    ).rejects.toMatchObject({ code: 'SCAN_TARGET_NOT_PUBLIC' })

    expect(seen).toHaveLength(1)
  })

  it('caps the HTML body and rejects non-HTML responses', async () => {
    const { port } = await listen((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html' })
      response.end(`<html>${'a'.repeat(2048)}</html>`)
    })

    await expect(
      fetchScanPage(
        {
          url: `http://public.example:${port}/big`,
          accept: 'html',
          maxBytes: 100
        },
        { lookup: publicLookup, connectLookup }
      )
    ).rejects.toMatchObject({ code: 'SCAN_PAGE_TOO_LARGE' })

    const second = await listen((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end('{"ok":true}')
    })
    await expect(
      fetchScanPage(
        {
          url: `http://public.example:${second.port}/json`,
          accept: 'html'
        },
        { lookup: publicLookup, connectLookup }
      )
    ).rejects.toMatchObject({ code: 'SCAN_FETCH_TYPE' })
  })

  it('returns JSON only when explicitly requested', async () => {
    const { port } = await listen((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end('{"ok":true}')
    })
    const result = await fetchScanPage(
      { url: `http://public.example:${port}/api`, accept: 'json' },
      { lookup: publicLookup, connectLookup }
    )
    expect(result.body).toBe('{"ok":true}')
    expect(result.contentType).toBe('application/json')
  })
})
