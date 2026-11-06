import { describe, expect, it } from 'vitest'
import {
  AUTO_RETRY_BACKOFF_MS,
  TRANSIENT_ARIA2_CODES,
  autoRetryDelayMs,
  autoRetryStatusText,
  isTransientAria2Failure,
  planAutoRetry
} from '../src/main/downloads/autoRetry'

describe('transient aria2 failures', () => {
  it.each([1, 2, 5, 6, 22])('treats aria2 code %i as transient', (code) => {
    expect(TRANSIENT_ARIA2_CODES.has(code)).toBe(true)
    expect(isTransientAria2Failure(code)).toBe(true)
  })

  it.each([0, 3, 4, 9, 13, 17, 18, 19, 23, 24, 999])(
    'never retries aria2 code %i automatically',
    (code) => {
      expect(isTransientAria2Failure(code)).toBe(false)
    }
  )

  it('treats an HTTP 5xx reported in the message as transient', () => {
    expect(isTransientAria2Failure(1, 'The response status is 503')).toBe(true)
    expect(isTransientAria2Failure(3, 'The response status is 503')).toBe(true)
    expect(isTransientAria2Failure(3, 'The response status is 404')).toBe(false)
  })
})

describe('automatic retry schedule', () => {
  it('waits 3 s for the first automatic retry and 10 s for the next', () => {
    expect(AUTO_RETRY_BACKOFF_MS).toEqual([3_000, 10_000])
    expect(autoRetryDelayMs(0)).toBe(3_000)
    expect(autoRetryDelayMs(1)).toBe(10_000)
    expect(autoRetryDelayMs(2)).toBeNull()
    expect(autoRetryDelayMs(-1)).toBeNull()
  })

  it('plans a retry for a transient failure with budget left', () => {
    expect(
      planAutoRetry({
        errorCode: 6,
        attempts: 1,
        maxAttempts: 3,
        autoRetriesUsed: 0
      })
    ).toBe(3_000)
    expect(
      planAutoRetry({
        errorCode: 2,
        attempts: 2,
        maxAttempts: 3,
        autoRetriesUsed: 1
      })
    ).toBe(10_000)
  })

  it('stops once the attempt budget or the auto-retry cap is used up', () => {
    expect(
      planAutoRetry({
        errorCode: 6,
        attempts: 3,
        maxAttempts: 3,
        autoRetriesUsed: 0
      })
    ).toBeNull()
    expect(
      planAutoRetry({
        errorCode: 6,
        attempts: 1,
        maxAttempts: 3,
        autoRetriesUsed: 2
      })
    ).toBeNull()
  })

  it.each([3, 4, 9, 13, 17, 18, 19, 24])(
    'never plans a retry for aria2 code %i',
    (errorCode) => {
      expect(
        planAutoRetry({
          errorCode,
          attempts: 1,
          maxAttempts: 3,
          autoRetriesUsed: 0
        })
      ).toBeNull()
    }
  )

  it('describes the waiting state', () => {
    expect(autoRetryStatusText(3)).toBe('Retrying in 3s…')
    expect(autoRetryStatusText(0.2)).toBe('Retrying in 1s…')
    expect(autoRetryStatusText(-5)).toBe('Retrying in 0s…')
  })
})
