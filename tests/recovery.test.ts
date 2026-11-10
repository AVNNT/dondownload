import { describe, expect, it } from 'vitest'
import type { DownloadStatus } from '../src/shared/types'
import {
  INTERRUPTED_MESSAGE,
  NEEDS_LOGIN_MESSAGE,
  decideStartupRecovery,
  shouldAutoResumeOnStartup
} from '../src/main/downloads/recovery'

describe('startup recovery policy', () => {
  it.each<[DownloadStatus, boolean, string]>([
    ['active', true, 'reattach'],
    ['queued', true, 'reattach'],
    ['waiting', true, 'reattach'],
    ['paused', true, 'keep-paused'],
    ['interrupted', true, 'reattach'],
    ['active', false, 'interrupt'],
    ['queued', false, 'interrupt'],
    ['waiting', false, 'interrupt'],
    ['paused', false, 'keep-paused'],
    ['complete', false, 'keep-terminal'],
    ['error', false, 'keep-terminal'],
    ['cancelled', true, 'keep-terminal'],
    ['cancelled', false, 'keep-terminal'],
    ['interrupted', false, 'keep-terminal']
  ])(
    'decides %s with aria2 tracking %s -> %s',
    (status, tracked, expected) => {
      expect(decideStartupRecovery(status, tracked)).toBe(expected)
    }
  )

  it('never auto-resumes or auto-deletes a manually paused transfer', () => {
    expect(decideStartupRecovery('paused', false)).toBe('keep-paused')
    expect(decideStartupRecovery('paused', true)).toBe('keep-paused')
  })

  it('keeps a paused transfer paused even when aria2 reports it as active or waiting', () => {
    // Paused is a persisted user intent, so tracking alone must never win.
    expect(decideStartupRecovery('paused', true)).toBe('keep-paused')
    expect(decideStartupRecovery('paused', false)).toBe('keep-paused')
  })

  it('describes interrupted downloads as needing user action and keeping data', () => {
    expect(INTERRUPTED_MESSAGE).toMatch(/interrupted/i)
    expect(INTERRUPTED_MESSAGE).toMatch(/partial file is kept/i)
    expect(INTERRUPTED_MESSAGE).toMatch(/retry/i)
  })

  it('never auto-resumes a job whose browser cookie is gone after restart', () => {
    const base = {
      resumeEnabled: true,
      status: 'interrupted' as DownloadStatus,
      blockReason: null,
      completedBytes: 1024,
      attempts: 1,
      maxAttempts: 3
    }
    expect(shouldAutoResumeOnStartup(base)).toBe(true)
    expect(shouldAutoResumeOnStartup({ ...base, needsLogin: true })).toBe(false)
    expect(NEEDS_LOGIN_MESSAGE).toMatch(/browser login again/i)
  })
})
