import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const builderConfig = readFileSync(
  new URL('../electron-builder.yml', import.meta.url),
  'utf8'
)

/**
 * Return the raw indented body of a top-level YAML mapping key, without the
 * key line. Comments and blank lines are kept; the block ends at the next
 * top-level key.
 */
function mappingBody(source: string, key: string): string | null {
  const lines = source.split(/\r?\n/)
  const start = lines.findIndex((line) => line === `${key}:`)
  if (start < 0) return null

  const body: string[] = []
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] as string
    if (line.length > 0 && !/^[ \t]/.test(line)) break
    body.push(line)
  }
  return body.join('\n')
}

function scalar(body: string, key: string): string | null {
  const match = body.match(
    new RegExp(`^[ \\t]+${key}:[ \\t]*(\\S+)[ \\t]*$`, 'm')
  )
  return match?.[1] ?? null
}

describe('packaged Electron fuses', () => {
  it('disables runAsNode so a second launch cannot exit as a Node process', () => {
    const fuses = mappingBody(builderConfig, 'electronFuses')
    expect(fuses, 'electronFuses is configured').not.toBeNull()
    expect(scalar(fuses as string, 'runAsNode')).toBe('false')
  })
})

describe('packaged native helpers', () => {
  const extraResources = mappingBody(builderConfig, 'extraResources') ?? ''

  it('ships the tray stub beside the native messaging host', () => {
    expect(extraResources).toContain('from: native/dondownload-native-host.exe')
    expect(extraResources).toContain('to: native/dondownload-native-host.exe')
    // The idle app hands its tray icon to this stub before quitting, so it must
    // land in resources/native/ next to the host.
    expect(extraResources).toContain('from: native/dondownload-tray.exe')
    expect(extraResources).toContain('to: native/dondownload-tray.exe')
  })

  it('builds the tray stub with the native host before packaging', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    ) as { scripts: Record<string, string> }

    expect(manifest.scripts['build:tray-stub']).toContain('build-tray-stub.ps1')
    expect(manifest.scripts['build:installer']).toContain('build:tray-stub')
    expect(manifest.scripts['build:installer']).toContain('build:native-host')
  })
})
