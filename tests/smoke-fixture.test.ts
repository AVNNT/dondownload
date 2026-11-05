import http from 'node:http'
import { describe, expect, it } from 'vitest'
import {
  createSmokeFixtureLookup,
  createSmokeFixturePreflight
} from '../src/main/smoke/smokeFixture'
import type { PublicTargetLookup } from '../src/main/net/publicTarget'
import { publicPreflightInternals } from '../src/main/net/publicPreflight'

const publicAddress = [{ address: '93.184.216.34', family: 4 }]

function fallbackSpy(): {
  lookup: PublicTargetLookup
  calls: string[]
} {
  const calls: string[] = []
  return {
    calls,
    lookup: async (hostname) => {
      calls.push(hostname)
      return publicAddress
    }
  }
}

const fixture = {
  hostname: 'Fixture.Example',
  address: '192.168.0.10',
  publicAddress: '93.184.216.34',
  family: 4
}

describe('createSmokeFixtureLookup', () => {
  it('reports the declared public address only for the exact fixture host', async () => {
    const spy = fallbackSpy()
    const lookup = createSmokeFixtureLookup([fixture], spy.lookup)

    await expect(lookup('fixture.example', { all: true, verbatim: true })).resolves.toEqual([
      { address: '93.184.216.34', family: 4 }
    ])
    await expect(lookup('other.example', { all: true, verbatim: true })).resolves.toEqual(
      publicAddress
    )
    expect(spy.calls).toEqual(['other.example'])
  })

  it('delegates every host to the real policy when the allowlist is empty', async () => {
    const spy = fallbackSpy()
    const lookup = createSmokeFixtureLookup([], spy.lookup)

    await lookup('127.0.0.1', { all: true, verbatim: true })
    expect(spy.calls).toEqual(['127.0.0.1'])
  })
})

describe('createSmokeFixturePreflight', () => {
  it('keeps the production response validation (range, size and type)', () => {
    // The wrapper must not replace validateResponse; a wrong total is still
    // rejected exactly as in production.
    expect(() =>
      publicPreflightInternals.validateResponse(
        { url: 'http://fixture.example/file.bin', expectedBytes: 10 },
        {
          status: 206,
          contentType: 'application/octet-stream',
          contentRange: 'bytes 0-0/11',
          contentLength: '1',
          contentEncoding: null,
          redirect: null
        }
      )
    ).toThrow(/size does not match/)
  })

  it('runs the real preflight against the pinned local fixture', async () => {
    const server = http.createServer((request, response) => {
      if (request.headers.range === 'bytes=0-0') {
        response.writeHead(206, {
          'content-type': 'application/octet-stream',
          'content-range': 'bytes 0-0/4',
          'content-length': '1'
        })
        response.end(Buffer.from([1]))
        return
      }
      response.writeHead(416)
      response.end()
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('the fixture server did not report a TCP address')
    }
    const port = address.port
    try {
      const preflight = createSmokeFixturePreflight([
        {
          hostname: 'fixture.example',
          address: '127.0.0.1',
          publicAddress: '93.184.216.34',
          family: 4
        }
      ])
      const result = await preflight({
        url: `http://fixture.example:${port}/file.bin`,
        expectedBytes: 4,
        expectedContentType: 'application/octet-stream'
      })
      expect(result.totalBytes).toBe(4)
      expect(result.finalUrl).toBe(`http://fixture.example:${port}/file.bin`)
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
})
