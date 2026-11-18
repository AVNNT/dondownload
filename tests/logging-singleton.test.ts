import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  closeLogger,
  configureLogger,
  debugLoggingEnabled,
  defaultUserPaths,
  getLogger,
  logDebug,
  logError,
  logInfo,
  recentLogLines,
  setLoggerForTests
} from '../src/main/logging'

let directory: string

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dondownload-singleton-'))
})

afterEach(async () => {
  await closeLogger()
  setLoggerForTests(null)
  await fs.rm(directory, { recursive: true, force: true })
})

describe('debug logging switch', () => {
  it('is off unless DONDOWNLOAD_DEBUG_LOG=1', () => {
    expect(debugLoggingEnabled({})).toBe(false)
    expect(debugLoggingEnabled({ DONDOWNLOAD_DEBUG_LOG: 'true' })).toBe(false)
    expect(debugLoggingEnabled({ DONDOWNLOAD_DEBUG_LOG: '1' })).toBe(true)
  })
})

describe('user paths', () => {
  it('covers the profile, its app data and the temp folder, deduplicated', () => {
    const paths = defaultUserPaths('C:\\Users\\Ada', {
      USERPROFILE: 'C:\\Users\\Ada',
      APPDATA: 'C:\\Users\\Ada\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\Ada\\AppData\\Local',
      TEMP: 'C:\\Users\\Ada\\AppData\\Local\\Temp'
    })
    const normalized = paths.map((entry) => entry.toLowerCase())
    // The profile is listed once even when the environment repeats it.
    expect(normalized.filter((entry) => entry === 'c:\\users\\ada')).toHaveLength(1)
    // The temp folder is first so it is rewritten before its parent.
    expect(normalized[0]).toBe('c:\\users\\ada\\appdata\\local\\temp')
    expect(normalized).toContain('c:\\users\\ada')
    expect(normalized).toContain('c:\\users\\ada\\appdata\\local\\temp')
  })
})

describe('configured logger', () => {
  it('writes redacted lines and serves the diagnostics tail', async () => {
    configureLogger({
      directory,
      level: 'info',
      userPaths: ['C:\\Users\\Ada']
    })
    logInfo('started from C:\\Users\\Ada\\Downloads')
    logError('link failed https://example.com/x/y?token=abc')
    logDebug('not written at info level')
    expect(getLogger()?.enabled('debug')).toBe(false)

    const tail = recentLogLines(100)
    expect(tail).toHaveLength(2)
    expect(tail[0]).toContain('%USERPROFILE%\\Downloads')
    expect(tail[1]).toContain('https://example.com/')

    await closeLogger()
    const written = await fs.readFile(path.join(directory, 'main.log'), 'utf8')
    expect(written).toContain('started from')
    expect(written).toContain('%USERPROFILE%\\Downloads')
    expect(written).not.toContain('token=abc')
    expect(written).not.toContain('not written')
    expect(recentLogLines(10)).toEqual([])
  })

  it('is a cheap no-op before configuration', () => {
    setLoggerForTests(null)
    expect(() => {
      logInfo('before start')
      logError('before start')
    }).not.toThrow()
    expect(recentLogLines(10)).toEqual([])
    expect(getLogger()).toBeNull()
  })
})
