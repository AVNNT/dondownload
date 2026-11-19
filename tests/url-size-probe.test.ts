import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { probeUrlSize } from '../src/main/net/urlSize'
import type { PublicTargetLookup } from '../src/main/net/publicTarget'

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

// The URL host stays a public example; only the test connection is mapped to
// the loopback fixture. Production pins the addresses the guard resolved.
const publicLookup: PublicTargetLookup = async () => [
  { address: '93.184.216.34', family: 4 }
]
const connectLookup = (
  _hostname: string,
  _options: { family?: number; all?: boolean },
  callback: (
    error: NodeJS.ErrnoException | null,
    address: string | ReadonlyArray<{ address: string; family: number }>,
    family?: number
  ) => void
): void => {
  callback(null, [{ address: '127.0.0.1', family: 4 }])
}

describe('bounded URL size probe public-target policy', () => {
  it('uses the real guard by default and refuses a loopback URL', async () => {
    // No injected lookup: this is the production path.
    await expect(probeUrlSize('http://127.0.0.1:9/secret')).resolves.toEqual({
      size: null
    })
    await expect(probeUrlSize('http://localhost:9/secret')).resolves.toEqual({
      size: null
    })
  })

  it('rejects a local or private initial URL without contacting it', async () => {
    for (const url of [
      'http://127.0.0.1:9/secret',
      'http://localhost:9/secret',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.5/file.iso',
      'http://192.168.1.1/file.iso',
      'http://[::1]/file.zip'
    ]) {
      await expect(
        probeUrlSize(url, { lookup: publicLookup, connectLookup })
      ).resolves.toEqual({ size: null })
    }
  })

  it('rejects a redirect hop that lands on a private target', async () => {
    const seen: string[] = []
    const { port } = await listen((request, response) => {
      seen.push(request.url ?? '')
      response.writeHead(302, {
        Location: 'http://169.254.169.254/latest/meta-data/iam/'
      })
      response.end()
    })

    const probe = await probeUrlSize(
      `http://files.public.example:${port}/start`,
      { lookup: publicLookup, connectLookup }
    )

    expect(probe).toEqual({ size: null })
    // The first hop is allowed; the metadata hop never gets a connection.
    expect(seen).toEqual(['/start'])
  })

  it('rejects a redirect hop to another private address only after validating it', async () => {
    const seen: string[] = []
    const { port } = await listen((request, response) => {
      seen.push(request.url ?? '')
      response.writeHead(302, { Location: 'http://10.0.0.9/admin' })
      response.end()
    })

    const lookup = async (hostname: string) => {
      if (hostname === 'files.public.example') {
        return [{ address: '93.184.216.34', family: 4 }]
      }
      throw Object.assign(new Error('not resolved'), {
        code: 'MEDIA_TARGET_NOT_PUBLIC'
      })
    }

    await expect(
      probeUrlSize(`http://files.public.example:${port}/start`, {
        lookup: lookup as unknown as PublicTargetLookup,
        connectLookup
      })
    ).resolves.toEqual({ size: null })
    expect(seen).toEqual(['/start'])
  })

  it('reports the size of the final public hop', async () => {
    const { port } = await listen((request, response) => {
      if (request.url === '/start') {
        response.writeHead(302, { Location: '/file.zip' })
        response.end()
        return
      }
      response.writeHead(200, { 'Content-Length': '4096' })
      response.end()
    })

    await expect(
      probeUrlSize(`http://files.public.example:${port}/start`, {
        lookup: publicLookup,
        connectLookup
      })
    ).resolves.toEqual({ size: 4096 })
  })

  it('does not send a credentialed URL to any target', async () => {
    const seen: string[] = []
    const { port } = await listen((request, response) => {
      seen.push(request.url ?? '')
      response.writeHead(200, { 'Content-Length': '1' })
      response.end()
    })

    await expect(
      probeUrlSize(
        `http://user:pass@files.public.example:${port}/file.zip`,
        { lookup: publicLookup, connectLookup }
      )
    ).resolves.toEqual({ size: null })
    expect(seen).toHaveLength(0)
  })
})
