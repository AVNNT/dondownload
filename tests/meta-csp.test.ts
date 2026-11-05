import { describe, expect, it } from 'vitest'
import electronViteConfig from '../electron.vite.config'

type TransformIndexHtml = (
  html: string,
  context: Record<string, unknown>
) => unknown

interface RendererPlugin {
  name?: string
  transformIndexHtml?:
    | TransformIndexHtml
    | { handler: TransformIndexHtml }
}

interface GeneratedMetaTag {
  tag: string
  attrs?: Record<string, string>
  injectTo?: string
}

interface GeneratedHtml {
  html: string
  tags?: GeneratedMetaTag[]
}

const PRODUCTION_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
]

const DEVELOPMENT_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "connect-src 'self' ws://localhost:* http://localhost:* ws://127.0.0.1:* http://127.0.0.1:*",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
]

function generatedMetaCsp(server: boolean): GeneratedHtml {
  const renderer = (
    electronViteConfig as {
      renderer?: { plugins?: RendererPlugin[] }
    }
  ).renderer
  const plugin = renderer?.plugins?.find(
    (candidate) => candidate?.name === 'dondownload-csp'
  )
  expect(plugin, 'renderer CSP plugin is configured').toBeDefined()

  const hook = plugin?.transformIndexHtml
  const transform = typeof hook === 'function' ? hook : hook?.handler
  expect(typeof transform).toBe('function')

  return transform!('<!doctype html><html></html>', {
    path: '/index.html',
    filename: 'index.html',
    server: server ? ({} as never) : undefined,
    bundle: null,
    chunk: null
  }) as GeneratedHtml
}

function metaCsp(server: boolean): string {
  const result = generatedMetaCsp(server)
  const meta = result.tags?.find(
    (tag) =>
      tag.tag === 'meta' &&
      tag.attrs?.['http-equiv'] === 'Content-Security-Policy'
  )
  expect(meta, 'meta CSP tag is generated').toBeDefined()
  expect(meta?.injectTo).toBe('head-prepend')
  const content = meta?.attrs?.content
  if (typeof content !== 'string') {
    throw new Error('generated meta CSP tag has no content attribute')
  }
  return content
}

function directives(policy: string): string[] {
  return policy
    .split(';')
    .map((directive) => directive.trim())
    .filter((directive) => directive.length > 0)
}

describe('generated meta Content Security Policy', () => {
  it('omits frame-ancestors, which is ignored in a meta element', () => {
    const production = metaCsp(false)
    const development = metaCsp(true)

    expect(production).not.toMatch(/frame-ancestors/i)
    expect(development).not.toMatch(/frame-ancestors/i)
    expect(directives(production)).not.toContain("frame-ancestors 'none'")
    expect(directives(development)).not.toContain("frame-ancestors 'none'")
  })

  it('retains every effective production directive', () => {
    expect(directives(metaCsp(false))).toEqual(PRODUCTION_DIRECTIVES)
  })

  it('retains every effective development directive', () => {
    expect(directives(metaCsp(true))).toEqual(DEVELOPMENT_DIRECTIVES)
  })
})
