import { describe, expect, it } from 'vitest'
import {
  PersistenceErrorLogger,
  PERSISTENCE_ERROR_LOG_INTERVAL_MS
} from '../src/main/logging/persistenceErrors'

function capture(): { log: (label: string, clock: { now: number }) => PersistenceErrorLogger; lines: string[] } {
  const lines: string[] = []
  const log = (label: string, clock: { now: number }): PersistenceErrorLogger =>
    new PersistenceErrorLogger(
      label,
      () => clock.now,
      PERSISTENCE_ERROR_LOG_INTERVAL_MS,
      (message) => lines.push(message)
    )
  return { log, lines }
}

describe('persistence error logging', () => {
  it('logs the first failure, then suppresses repeats inside the window', () => {
    const { log, lines } = capture()
    const clock = { now: 1_000 }
    const errors = log('Download history', clock)

    errors.failed('could not be saved: disk full')
    errors.failed('could not be saved: disk full')
    errors.failed('could not be saved: disk full')
    expect(lines).toEqual(['Download history could not be saved: disk full.'])

    // Still inside the window: the store stays broken silently.
    clock.now += PERSISTENCE_ERROR_LOG_INTERVAL_MS / 2
    errors.failed('could not be saved: disk full')
    expect(lines).toHaveLength(1)

    // A full window later a repeated failure is visible again, including how
    // many attempts were skipped, unlike the old once-per-process latch.
    clock.now += PERSISTENCE_ERROR_LOG_INTERVAL_MS
    errors.failed('could not be saved: disk full')
    expect(lines).toHaveLength(2)
    expect(lines[1]).toBe(
      'Download history could not be saved: disk full. (3 earlier failures not logged)'
    )
  })

  it('logs immediately again after a successful persist', () => {
    const { log, lines } = capture()
    const clock = { now: 1_000 }
    const errors = log('Batch history', clock)

    errors.failed('could not be saved')
    errors.succeeded()
    errors.failed('could not be saved')
    expect(lines).toHaveLength(2)

    // A recovered store that breaks again is reported at once.
    clock.now += PERSISTENCE_ERROR_LOG_INTERVAL_MS * 10
    errors.succeeded()
    errors.failed('could not be removed')
    expect(lines).toEqual([
      'Batch history could not be saved.',
      'Batch history could not be saved.',
      'Batch history could not be removed.'
    ])
  })
})
