import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  preflightPublicResource,
  type PreflightConnectLookup
} from '../src/main/net/publicPreflight'
import type { PublicTargetLookup } from '../src/main/net/publicTarget'

interface SeenRequest {
  url: string
  method: string
  range: string | undefined
  authorization: string | undefined
  cookie: string | undefined
  referer: string | undefined
  userAgent: string | undefined
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
// The URL host stays public.example; only the test connection is mapped to the
// loopback fixture. Production uses the normal system resolver.
const connectLookup: PreflightConnectLookup = (_hostname, options, callback) => {
  if (options && options.all === true) {
    callback(null, [{ address: '127.0.0.1', family: 4 }])
    return
  }
  callback(null, '127.0.0.1', 4)
}

describe('bounded anonymous hand-off preflight', () => {
  it('uses opt-in browser headers but never sends a cookie to another host', async () => {
    const seen: SeenRequest[] = []
    const { port } = await listen((request, response) => {
      seen.push({
        url: request.url ?? '',
        method: request.method ?? '',
        range: request.headers.range,
        authorization: request.headers.authorization,
        cookie: request.headers.cookie,
        referer: request.headers.referer,
        userAgent: request.headers['user-agent']
      })
      if (request.url === '/same-host') {
        response.writeHead(302, { Location: '/file.zip' })
        response.end()
        return
      }
      if (request.url === '/other-host') {
        response.writeHead(302, {
          Location: `http://other.example:${port}/file.zip`
        })
        response.end()
        return
      }
      if (request.url === '/needs-login') {
        response.writeHead(401)
        response.end()
        return
      }
      response.writeHead(206, {
        'Content-Type': 'application/zip',
        'Content-Range': 'bytes 0-0/4',
        'Content-Length': '1'
      })
      response.end('P')
    })

    await preflightPublicResource(
      {
        url: `http://public.example:${port}/same-host`,
        requestHeaders: {
          referer: 'https://public.example/page',
          userAgent: 'BrowserAgent/1.0',
          cookie: 'auth=1'
        }
      },
      { lookup: publicLookup, connectLookup, timeoutMs: 5_000 }
    )
    expect(seen).toHaveLength(2)
    expect(seen[0]!.cookie).toBe('auth=1')
    expect(seen[1]!.cookie).toBe('auth=1')
    expect(seen[1]!.referer).toBe('https://public.example/page')
    expect(seen[1]!.userAgent).toBe('BrowserAgent/1.0')

    seen.length = 0
    // The User-Agent follows a same-site redirect, but a Cookie must not cross
    // hosts and the Referer does not leave the original host. The preflight
    // continues anonymously and reports the final URL so the download manager
    // can hand that target to aria2 without the cookie.
    const crossHost = await preflightPublicResource(
      {
        url: `http://public.example:${port}/other-host`,
        requestHeaders: {
          referer: 'https://public.example/page',
          userAgent: 'BrowserAgent/1.0',
          cookie: 'auth=1'
        }
      },
      { lookup: publicLookup, connectLookup, timeoutMs: 5_000 }
    )
    expect(crossHost.finalUrl).toBe(`http://other.example:${port}/file.zip`)
    expect(seen).toHaveLength(2)
    expect(seen[0]!.cookie).toBe('auth=1')
    expect(seen[0]!.referer).toBe('https://public.example/page')
    expect(seen[1]!.cookie).toBeUndefined()
    // The Referer names the original page, so it does not follow the hop.
    expect(seen[1]!.referer).toBeUndefined()
    expect(seen[1]!.userAgent).toBe('BrowserAgent/1.0')

    seen.length = 0
    await preflightPublicResource(
      {
        url: `http://public.example:${port}/other-host`,
        requestHeaders: {
          referer: 'https://public.example/page',
          userAgent: 'BrowserAgent/1.0'
        }
      },
      { lookup: publicLookup, connectLookup, timeoutMs: 5_000 }
    )
    expect(seen).toHaveLength(2)
    expect(seen[0]!.cookie).toBeUndefined()
    expect(seen[0]!.referer).toBe('https://public.example/page')
    expect(seen[1]!.cookie).toBeUndefined()
    expect(seen[1]!.referer).toBeUndefined()

    await expect(
      preflightPublicResource(
        { url: `http://public.example:${port}/needs-login` },
        { lookup: publicLookup, connectLookup, timeoutMs: 5_000 }
      )
    ).rejects.toMatchObject({ code: 'HANDOFF_NEEDS_LOGIN' })
  })

  it('proves the same small public resource with one anonymous range GET and never downloads the body', async () => {
    const seen: SeenRequest[] = []
    let completedBodies = 0
    const { port } = await listen((request, response) => {
      seen.push({
        url: request.url ?? '',
        method: request.method ?? '',
        range: request.headers.range,
        authorization: request.headers.authorization,
        cookie: request.headers.cookie,
        referer: request.headers.referer,
        userAgent: request.headers['user-agent']
      })
      if (request.url === '/redirect') {
        response.writeHead(302, { Location: '/file.zip' })
        response.end()
        return
      }
      if (request.url === '/ignore-range') {
        response.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Length': '4'
        })
        response.end('DATA')
        return
      }
      if (request.url === '/wrong-range') {
        response.writeHead(206, {
          'Content-Type': 'application/zip',
          'Content-Range': 'bytes 1-1/4',
          'Content-Length': '1'
        })
        response.end('A')
        return
      }
      if (request.url === '/file.zip') {
        response.writeHead(206, {
          'Content-Type': 'application/zip',
          'Content-Range': 'bytes 0-0/4',
          'Content-Length': '1'
        })
        response.end('P', () => {
          completedBodies += 1
        })
        return
      }
      response.writeHead(404)
      response.end()
    })

    const result = await preflightPublicResource(
      {
        url: `http://public.example:${port}/redirect`,
        expectedBytes: 4,
        expectedContentType: 'application/zip'
      },
      { lookup: publicLookup, connectLookup, timeoutMs: 5_000 }
    )

    expect(result).toMatchObject({
      status: 206,
      contentType: 'application/zip',
      totalBytes: 4,
      finalUrl: `http://public.example:${port}/file.zip`
    })
    expect(seen).toHaveLength(2)
    for (const request of seen) {
      expect(request.method).toBe('GET')
      expect(request.range).toBe('bytes=0-0')
      expect(request.authorization).toBeUndefined()
      expect(request.cookie).toBeUndefined()
      expect(request.referer).toBeUndefined()
    }
    // The response body is aborted/destroyed by the probe. Even if the fixture
    // finished its tiny write, the probe never read it as a download.
    expect(completedBodies).toBeLessThanOrEqual(1)

    await expect(
      preflightPublicResource(
        {
          url: `http://public.example:${port}/file.zip`,
          expectedBytes: 5,
          expectedContentType: 'application/zip'
        },
        { lookup: publicLookup, connectLookup, timeoutMs: 5_000 }
      )
    ).rejects.toMatchObject({ code: 'HANDOFF_PREFLIGHT_FAILED' })

    await expect(
      preflightPublicResource(
        {
          url: `http://public.example:${port}/file.zip`,
          expectedBytes: 4,
          expectedContentType: 'video/mp4'
        },
        { lookup: publicLookup, connectLookup, timeoutMs: 5_000 }
      )
    ).rejects.toMatchObject({ code: 'HANDOFF_PREFLIGHT_FAILED' })

    for (const path of ['/ignore-range', '/wrong-range']) {
      await expect(
        preflightPublicResource(
          { url: `http://public.example:${port}${path}` },
          { lookup: publicLookup, connectLookup, timeoutMs: 5_000 }
        )
      ).rejects.toMatchObject({ code: 'HANDOFF_PREFLIGHT_FAILED' })
    }
  })
})
