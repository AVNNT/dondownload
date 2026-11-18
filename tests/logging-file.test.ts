import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_LOG_FILES,
  createFileLogger,
  createNodeLogFileSystem,
  rotatedName,
  timestamp,
  type LogFileSystem
} from '../src/main/logging/fileLogger'

let directory: string

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dondownload-logs-'))
})

afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true })
})

async function readLogs(): Promise<string[]> {
  const names = await fs.readdir(directory)
  return names.sort()
}

describe('log rotation', () => {
  it('rotates at the limit and keeps exactly three files', async () => {
    const logger = createFileLogger({
      directory,
      maxBytes: 4_096,
      files: DEFAULT_LOG_FILES,
      level: 'info',
      flushIntervalMs: 60_000,
      fileSystem: createNodeLogFileSystem()
    })

    // Each line is ~60 bytes; 400 lines is far more than one 4 KiB file.
    for (let index = 0; index < 400; index += 1) {
      logger.info('entry number %d', index)
    }
    await logger.flush()
    await logger.close()

    const names = await readLogs()
    expect(names).toEqual(['main.1.log', 'main.2.log', 'main.log'])
    for (const name of names) {
      const size = (await fs.stat(path.join(directory, name))).size
      expect(size).toBeLessThanOrEqual(4_096)
    }
    // The newest entries are in the active file.
    const active = await fs.readFile(path.join(directory, 'main.log'), 'utf8')
    expect(active).toContain('entry number 399')
  })

  it('renames older generations instead of overwriting them', async () => {
    await fs.writeFile(path.join(directory, 'main.log'), 'active-1\n'.repeat(500))
    await fs.writeFile(path.join(directory, 'main.1.log'), 'older-1\n')

    const logger = createFileLogger({
      directory,
      maxBytes: 4_096,
      files: 3,
      level: 'info',
      fileSystem: createNodeLogFileSystem()
    })
    // The active file is over the limit, so this record rotates first.
    logger.info('fresh record')
    await logger.flush()
    await logger.close()

    expect(await readFileText('main.2.log')).toContain('older-1')
    expect(await readFileText('main.1.log')).toContain('active-1')
    expect(await readFileText('main.log')).toContain('fresh record')
  })

  it('drops the oldest file when a fourth generation would be needed', async () => {
    await fs.writeFile(path.join(directory, 'main.log'), 'active-1\n'.repeat(500))
    await fs.writeFile(path.join(directory, 'main.1.log'), 'gen-1\n')
    await fs.writeFile(path.join(directory, 'main.2.log'), 'gen-2\n')

    const logger = createFileLogger({
      directory,
      maxBytes: 4_096,
      files: 3,
      level: 'info',
      fileSystem: createNodeLogFileSystem()
    })
    logger.info('fresh record')
    await logger.flush()
    await logger.close()

    expect(await readLogs()).toEqual(['main.1.log', 'main.2.log', 'main.log'])
    // gen-2 was the oldest and is gone; gen-1 and active-1 each moved up.
    expect(await readFileText('main.2.log')).toContain('gen-1')
    expect(await readFileText('main.1.log')).toContain('active-1')
  })
})

async function readFileText(name: string): Promise<string> {
  return fs.readFile(path.join(directory, name), 'utf8')
}

describe('buffering and cost', () => {
  it('writes nothing until a flush', async () => {
    const logger = createFileLogger({
      directory,
      level: 'info',
      flushIntervalMs: 60_000,
      fileSystem: createNodeLogFileSystem()
    })
    logger.info('buffered only')
    expect(logger.bufferedLines).toBe(1)
    expect(await readLogs()).toEqual([])
    await logger.flush()
    expect((await readFileText('main.log')).trim()).toContain('buffered only')
    await logger.close()
  })

  it('flushes early when the buffer is full instead of growing', async () => {
    const logger = createFileLogger({
      directory,
      level: 'info',
      maxBufferedLines: 2,
      flushIntervalMs: 60_000,
      fileSystem: createNodeLogFileSystem()
    })
    logger.info('one')
    logger.info('two')
    await logger.flush()
    expect(logger.bufferedLines).toBe(0)
    await logger.close()
    const text = await readFileText('main.log')
    expect(text).toContain('one')
    expect(text).toContain('two')
  })
})


describe('privacy', () => {
  it('redacts URLs and profile paths before anything reaches the file', async () => {
    const logger = createFileLogger({
      directory,
      level: 'info',
      flushIntervalMs: 60_000,
      redactOptions: { userPaths: ['C:\\Users\\Ada'] },
      fileSystem: createNodeLogFileSystem()
    })
    logger.error('failed https://example.com/private/file.zip?token=abc')
    logger.warn('could not read C:\\Users\\Ada\\Downloads\\secret.mp4')
    logger.info('Cookie: SID=abc; CSRF=xyz')
    await logger.close()

    const text = await readFileText('main.log')
    expect(text).toContain('https://example.com/')
    expect(text).not.toContain('private/file.zip')
    expect(text).not.toContain('token=abc')
    expect(text).toContain('%USERPROFILE%')
    expect(text).not.toContain('Ada\\Downloads')
    expect(text).toContain('Cookie: [redacted]')
    expect(text).not.toContain('CSRF=xyz')
  })
})

describe('failure handling', () => {
  it('never throws when the file system fails, and reports once per flush', async () => {
    const failing: LogFileSystem = {
      mkdir: async () => undefined,
      append: async () => {
        throw new Error('EACCES: C:\\Users\\Ada\\AppData')
      },
      rename: async () => undefined,
      rm: async () => undefined,
      stat: async () => ({ size: 0 })
    }
    const onWriteError = vi.fn()
    const logger = createFileLogger({
      directory,
      level: 'info',
      flushIntervalMs: 60_000,
      fileSystem: failing,
      onWriteError
    })
    logger.info('will not be written')
    await expect(logger.close()).resolves.toBeUndefined()
    expect(onWriteError).toHaveBeenCalledTimes(1)
    // The reported detail is the redacted error line, never raw arguments.
    expect(String(onWriteError.mock.calls[0]?.[0])).not.toContain('will not be')
  })

  it('keeps the recent tail for diagnostics', async () => {
    const logger = createFileLogger({
      directory,
      level: 'debug',
      flushIntervalMs: 60_000,
      fileSystem: createNodeLogFileSystem()
    })
    for (let index = 0; index < 150; index += 1) logger.info('line %d', index)
    const tail = logger.tail(100)
    expect(tail).toHaveLength(100)
    expect(tail[tail.length - 1]).toContain('line 149')
    expect(tail[0]).toContain('line 50')
    await logger.close()
  })
})

describe('helpers', () => {
  it('names generations after the extension', () => {
    expect(rotatedName('main.log', 1)).toBe('main.1.log')
    expect(rotatedName('main.log', 2)).toBe('main.2.log')
    expect(rotatedName('stub', 1)).toBe('stub.1')
  })

  it('stamps UTC records with millisecond precision', () => {
    expect(timestamp(new Date('2026-11-18T15:04:05.123Z'))).toBe(
      '2026-11-18T15:04:05.123Z'
    )
  })
})
