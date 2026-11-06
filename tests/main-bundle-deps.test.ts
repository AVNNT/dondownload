import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const viteConfig = readFileSync(
  new URL('../electron.vite.config.ts', import.meta.url),
  'utf8'
).replace(/\r\n/g, '\n')

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
) as { dependencies?: Record<string, string> }

// Renderer-only packages are bundled by Vite for the renderer and never
// required from the main process, so they do not need to be excluded.
const RENDERER_ONLY = new Set(['react', 'react-dom'])

/**
 * Return the source of the `main:` block of the electron-vite config. The
 * block ends at the next top-level key (`preload:`), which keeps the check
 * from matching the preload plugin.
 */
function mainBlock(source: string): string {
  const start = source.search(/^[ \t]+main:[ \t]*\{?[ \t]*$/m)
  expect(start, 'main config block exists').toBeGreaterThanOrEqual(0)
  const rest = source.slice(start)
  const end = rest.search(/^[ \t]+preload:[ \t]*\{?[ \t]*$/m)
  return end < 0 ? rest : rest.slice(0, end)
}

/** Packages listed in the main build's externalizeDepsPlugin exclude array. */
function mainExcludes(): string[] {
  const match = mainBlock(viteConfig).match(
    /externalizeDepsPlugin\(\s*\{\s*exclude:\s*\[([^\]]*)\]\s*\}?\s*\)/
  )
  if (!match) return []
  return [...(match[1] as string).matchAll(/['"]([^'"]+)['"]/g)].map(
    (item) => item[1] as string
  )
}

describe('main bundle runtime dependencies', () => {
  it('bundles every main runtime dependency instead of externalizing it', () => {
    const dependencies = Object.keys(packageJson.dependencies ?? {}).filter(
      (name) => !RENDERER_ONLY.has(name)
    )
    expect(dependencies.length, 'package.json has main dependencies').toBeGreaterThan(0)

    const excluded = mainExcludes()
    for (const name of dependencies) {
      expect(excluded, `${name} is bundled into out/main`).toContain(name)
    }
  })

  it('bundles htmlparser2 into main', () => {
    expect(mainExcludes()).toContain('htmlparser2')
  })
})
