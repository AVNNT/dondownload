import { createNoopHost, type CoreHost } from '../../src/main/host'

/**
 * Inert core host for tests. Override only the shell actions a test observes;
 * no Electron module is needed because the core never imports it.
 */
export function createTestHost(overrides: Partial<CoreHost> = {}): CoreHost {
  return { ...createNoopHost(), ...overrides }
}
