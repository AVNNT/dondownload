import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * Benchmark-only config. Kept separate from `vitest.config.ts` so the default
 * `test` / `test:fast` runs never pick up the multi-gigabyte loopback
 * downloads. Run it with `npm run bench:throughput`.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, '../../src/shared')
    }
  },
  test: {
    environment: 'node',
    include: ['tests/bench/**/*.bench.ts'],
    testTimeout: 15 * 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    // The benchmark reports through console.log; let it reach the terminal.
    disableConsoleIntercept: true
  }
})
