import path from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

const benchDirectory = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(benchDirectory, '..')

/**
 * Benchmarks are deliberately outside `tests/`, so `npm run test:fast` never
 * picks them up. `npm run bench` invokes this config explicitly.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': path.join(repositoryRoot, 'src/shared')
    }
  },
  test: {
    root: repositoryRoot,
    include: ['bench/**/*.bench.{ts,tsx}'],
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 120_000,
    silent: true,
    sequence: { concurrent: false }
  }
})
