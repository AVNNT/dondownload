/**
 * Benchmark 4 — production bundle size from `out/`.
 *
 * `bench/run.mjs` runs `npm run build` before this file, so the numbers always
 * describe the current source. Raw bytes are on-disk sizes; gzip bytes are
 * `zlib.gzipSync(level: 9)` per file, summed per bundle group.
 *
 * electron-vite does not emit a Rollup stats/visualizer file by default. When a
 * stats file is present it is reported; otherwise the largest emitted chunks
 * are listed instead, and `statsFile` stays null.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { it } from 'vitest'
import { REPO_ROOT, writePartial } from './lib/common'

const OUT_DIR = path.join(REPO_ROOT, 'out')

interface FileMetric {
  file: string
  rawBytes: number
  gzipBytes: number
}

function walk(directory: string): string[] {
  if (!existsSync(directory)) return []
  const files: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...walk(fullPath))
    } else if (entry.isFile()) {
      files.push(fullPath)
    }
  }
  return files
}

function metric(file: string): FileMetric {
  const raw = readFileSync(file)
  return {
    file: path.relative(REPO_ROOT, file).replaceAll(path.sep, '/'),
    rawBytes: raw.byteLength,
    gzipBytes: gzipSync(raw, { level: 9 }).byteLength
  }
}

function bundleGroup(directory: string, extensions: readonly string[]): {
  files: FileMetric[]
  rawBytes: number
  gzipBytes: number
} {
  const files = walk(directory)
    .filter((file) => extensions.some((extension) => file.endsWith(extension)))
    .map(metric)
    .sort((left, right) => right.rawBytes - left.rawBytes)
  return {
    files,
    rawBytes: files.reduce((total, file) => total + file.rawBytes, 0),
    gzipBytes: files.reduce((total, file) => total + file.gzipBytes, 0)
  }
}

it('startup: main and renderer bundle sizes from out/', () => {
  if (!existsSync(OUT_DIR)) {
    throw new Error(
      'bench: out/ is missing. Run `npm run build` (bench/run.mjs does this automatically).'
    )
  }

  const main = bundleGroup(path.join(OUT_DIR, 'main'), ['.js', '.cjs', '.mjs'])
  const preload = bundleGroup(path.join(OUT_DIR, 'preload'), [
    '.js',
    '.cjs',
    '.mjs'
  ])
  const rendererJs = bundleGroup(path.join(OUT_DIR, 'renderer'), ['.js', '.mjs'])
  const rendererCss = bundleGroup(path.join(OUT_DIR, 'renderer'), ['.css'])

  if (main.files.length === 0) {
    throw new Error('bench: no main bundle was found in out/main')
  }
  if (rendererJs.files.length === 0) {
    throw new Error('bench: no renderer bundle was found in out/renderer')
  }

  const statsCandidates = [
    path.join(OUT_DIR, 'stats.json'),
    path.join(OUT_DIR, 'stats.html'),
    path.join(OUT_DIR, 'bundle-stats.json'),
    path.join(OUT_DIR, 'renderer', 'stats.html')
  ]
  const statsPath = statsCandidates.find((candidate) => existsSync(candidate))

  const largestChunks = [...main.files, ...preload.files, ...rendererJs.files, ...rendererCss.files]
    .sort((left, right) => right.rawBytes - left.rawBytes)
    .slice(0, 10)

  writePartial('startup', {
    id: 'startup',
    title: 'Startup bundles',
    main,
    preload,
    rendererJs,
    rendererCss,
    rendererTotal: {
      rawBytes: rendererJs.rawBytes + rendererCss.rawBytes,
      gzipBytes: rendererJs.gzipBytes + rendererCss.gzipBytes
    },
    largestChunks,
    statsFile: statsPath === undefined ? null : metric(statsPath)
  })
})
