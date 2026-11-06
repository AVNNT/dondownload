import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { normalizeCapturedSource } from '../extension/bridge'
import { capturedSourceExtension, parseCapturedSourceInput } from '../src/shared/capturedSource'
import {
  handoffFileExtension,
  parseDurableHandoffInput
} from '../src/shared/durableHandoff'

const extensionDir = path.join(process.cwd(), 'extension')

interface KvsApi {
  parseKvsFlashvars: (source: unknown) => Record<string, string>
  kvsLicenseToken: (licenseCode: unknown) => number[] | null
  kvsDecodeUrl: (videoUrl: unknown, licenseCode: unknown) => string | null
  sourcesFromFlashvars: (
    flashvars: Record<string, string>,
    pageUrl: string
  ) => Array<{ url: string; qualityLabel: string | null }>
}

function loadKvs(): KvsApi {
  const coreSource = readFileSync(
    path.join(extensionDir, 'overlay-core.js'),
    'utf8'
  )
  const kvsSource = readFileSync(
    path.join(extensionDir, 'overlay-kvs.js'),
    'utf8'
  )
  const context = vm.createContext({ URL, Number, String, Object, Math, parseInt })
  vm.runInContext(coreSource, context)
  vm.runInContext(kvsSource, context)
  const api = vm.runInContext(
    'globalThis.DonDownloadOverlay',
    context
  ) as KvsApi
  return api
}

const kvs = loadKvs()

function referenceLicenseToken(licenseCode: string): number[] {
  const code = licenseCode.replace(/\$/g, '')
  const values = code.split('').map(Number)
  let modlicense = code.replace(/0/g, '1')
  const center = Math.floor(modlicense.length / 2)
  const fronthalf = Number.parseInt(modlicense.slice(0, center + 1), 10)
  const backhalf = Number.parseInt(modlicense.slice(center), 10)
  modlicense = String(4 * Math.abs(fronthalf - backhalf)).slice(0, center + 1)
  const token: number[] = []
  for (let index = 0; index < modlicense.length; index += 1) {
    for (let offset = 0; offset < 4; offset += 1) {
      token.push((values[index + offset]! + Number(modlicense[index])) % 10)
    }
  }
  return token
}

function referenceDecodeHash(token: number[], hash: string): string {
  const indices = Array.from({ length: 32 }, (_value, index) => index)
  let accum = 0
  for (let source = 31; source >= 0; source -= 1) {
    accum += token[source]!
    const destination = (source + accum) % 32
    const swap = indices[source]!
    indices[source] = indices[destination]!
    indices[destination] = swap
  }
  return indices.map((index) => hash[index]).join('')
}

describe('KVS flashvars parser', () => {
  it('reads single-quoted and double-quoted flashvars with alt qualities', () => {
    const parsed = kvs.parseKvsFlashvars(`
      <script>
        var flashvars = {
          video_id: '1',
          license_code: '$123456789012345',
          video_url: '/get_file/1/aaa/0/1/1.mp4/',
          video_url_text: '480p',
          "video_alt_url": "/get_file/1/bbb/0/1/1_720p.mp4/",
          "video_alt_url_text": "720p",
          preview_url: 'https://cdn.example/poster.jpg',
        };
        kt_player('kt_player', '/kt_player.js', '100%', '100%', flashvars);
      </script>
    `)
    expect(parsed.video_url).toBe('/get_file/1/aaa/0/1/1.mp4/')
    expect(parsed.video_url_text).toBe('480p')
    expect(parsed.video_alt_url).toBe('/get_file/1/bbb/0/1/1_720p.mp4/')
    expect(parsed.video_alt_url_text).toBe('720p')
    expect(parsed.license_code).toBe('$123456789012345')
  })

  it('keeps a primary URL with no alt entry and ignores junk scripts', () => {
    const parsed = kvs.parseKvsFlashvars(`
      var flashvars = { video_url: "https://example.com/get_file/1/x/0/1/1.mp4/" }
    `)
    expect(parsed).toEqual({
      video_url: 'https://example.com/get_file/1/x/0/1/1.mp4/'
    })
    expect(kvs.parseKvsFlashvars('there is no flashvars here')).toEqual({})
    expect(kvs.parseKvsFlashvars('var flashvars = { broken: ')).toEqual({})
  })
})

describe('KVS URL decode', () => {
  const license = '$123456789012345'
  const hash = '0123456789abcdef0123456789abcdef'

  it('matches an independently implemented license-token and permutation', () => {
    const token = kvs.kvsLicenseToken(license)
    expect(token).toEqual(referenceLicenseToken(license))
    expect(token).toHaveLength(32)

    const decoded = referenceDecodeHash(token!, hash)
    // Derived with the documented yt-dlp algorithm above.
    expect(decoded).toBe('8fbaa6be645f258710dd39c40c7e2193')

    const url = `function/0/https://example.com/get_file/1/${hash}/0/1/1.mp4/`
    expect(kvs.kvsDecodeUrl(url, license)).toBe(
      `https://example.com/get_file/1/${decoded}/0/1/1.mp4/`
    )
    expect(kvs.kvsDecodeUrl(url, null)).toBeNull()
    expect(kvs.kvsDecodeUrl('https://example.com/plain.mp4', license)).toBe(
      'https://example.com/plain.mp4'
    )
  })

  it('rejects a decoded host outside the page origin and its subdomains', () => {
    const page = 'https://example.com/video/1/'
    const sources = kvs.sourcesFromFlashvars(
      {
        video_url: 'https://cdn.example.com/get_file/1/a/0/1/1.mp4/',
        video_url_text: '480p',
        video_alt_url: 'https://example.com/get_file/1/b/0/1/1_720p.mp4/',
        video_alt_url_text: '720p',
        video_alt_url2: 'https://evil.com/get_file/1/c/0/1/1_1080p.mp4/',
        video_alt_url2_text: '1080p',
        video_alt_url3: 'https://notexample.com/get_file/1/d/0/1/1.mp4/'
      },
      page
    )
    expect(sources.map((source) => source.qualityLabel)).toEqual(['480p', '720p'])
    expect(sources.every((source) => !source.url.includes('evil'))).toBe(true)
  })
})

describe('trailing-slash path extensions', () => {
  it('treats /1.mp4/ as an mp4 path', () => {
    expect(capturedSourceExtension('/get_file/1/a/0/1/1.mp4/')).toBe('mp4')
    const normalized = normalizeCapturedSource(
      'https://example.com/get_file/1/a/0/1/1_720p.mp4/',
      '1_720p.mp4'
    )
    expect(normalized.ok).toBe(true)
    expect(
      parseCapturedSourceInput({
        url: 'https://example.com/get_file/1/a/0/1/1_720p.mp4/'
      })
    ).toMatchObject({ url: 'https://example.com/get_file/1/a/0/1/1_720p.mp4/' })
  })

  it('accepts a trailing slash for the hand-off filename too', () => {
    expect(handoffFileExtension('/uploads/short-url/abc.funscript')).toBe(
      'funscript'
    )
    expect(
      parseDurableHandoffInput({
        url: 'https://example.com/uploads/short-url/abc.funscript/'
      })
    ).toMatchObject({ url: 'https://example.com/uploads/short-url/abc.funscript/' })
  })
})
