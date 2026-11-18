import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  openDownloadDatabase,
  SCHEMA_VERSION
} from '../src/main/db/database'
import {
  DEFAULT_INTERFACE_SIZE,
  INTERFACE_SIZES,
  defaultDesktopSettings,
  nextInterfaceSize,
  parseDesktopSettings,
  parseInterfaceSize,
  zoomFactorFor
} from '../src/shared/desktopSettings'
import { shouldAutoResumeOnStartup } from '../src/main/downloads/recovery'
import { checkDeleteTarget } from '../src/main/downloads/deleteFile'
import { MAX_CLIPBOARD_URL_LENGTH, detectClipboardUrl } from '../src/main/clipboard/filter'
import { decideCompletionNotification } from '../src/main/notifications/decide'
import type { MediaJobRecord } from '../src/shared/media'
import {
  loginItemSettings,
  shouldManageLoginItem
} from '../src/main/desktop/loginItem'

describe('desktop settings contract', () => {
  it('uses privacy-safe and startup defaults', () => {
    const settings = defaultDesktopSettings()
    expect(settings).toEqual({
      resumeInterruptedOnStartup: true,
      showNotifications: false,
      watchClipboard: false,
      launchAtLogin: false,
      exitToTrayStubWhenIdle: true,
      warnAboutDuplicates: true,
      welcomeGuideSeen: false,
      interfaceSizePercent: 100
    })
    expect(DEFAULT_INTERFACE_SIZE).toBe(100)
    expect(INTERFACE_SIZES).toEqual([90, 100, 110, 125])
    expect(parseDesktopSettings(settings)).toEqual(settings)
  })

  it('rejects unsupported zoom levels and malformed payloads', () => {
    for (const size of INTERFACE_SIZES) {
      expect(parseInterfaceSize(size)).toBe(size)
      expect(zoomFactorFor(size)).toBe(size / 100)
    }
    for (const size of [0, 50, 95, 105, 126, 100.5, '100', null]) {
      expect(() => parseInterfaceSize(size)).toThrow(/Invalid interface size/)
    }
    expect(() =>
      parseDesktopSettings({ ...defaultDesktopSettings(), extra: true })
    ).toThrow(/unsupported fields/)
    expect(() =>
      parseDesktopSettings({
        ...defaultDesktopSettings(),
        interfaceSizePercent: 105
      })
    ).toThrow(/Invalid interface size/)
    expect(() =>
      parseDesktopSettings({
        ...defaultDesktopSettings(),
        watchClipboard: 'yes' as never
      })
    ).toThrow(/invalid flag/)
  })

  it('steps Ctrl zoom levels and clamps or resets exactly', () => {
    expect(nextInterfaceSize(100, 1)).toBe(110)
    expect(nextInterfaceSize(100, -1)).toBe(90)
    expect(nextInterfaceSize(125, 1)).toBe(125)
    expect(nextInterfaceSize(90, -1)).toBe(90)
    expect(nextInterfaceSize(110, 0)).toBe(100)
  })

  it('applies the login item only for a packaged Windows build', () => {
    expect(
      shouldManageLoginItem({ isPackaged: true, platform: 'win32' })
    ).toBe(true)
    expect(
      shouldManageLoginItem({ isPackaged: false, platform: 'win32' })
    ).toBe(false)
    expect(
      shouldManageLoginItem({ isPackaged: true, platform: 'darwin' })
    ).toBe(false)
    expect(loginItemSettings('C:\\Apps\\DonDownload.exe', true)).toEqual({
      openAtLogin: true,
      path: 'C:\\Apps\\DonDownload.exe',
      args: ['--hidden']
    })
  })
})

describe('auto-resume startup selection', () => {
  const base = {
    resumeEnabled: true,
    blockReason: null,
    completedBytes: 1_024,
    attempts: 1,
    maxAttempts: 3
  } as const

  it('selects only interrupted jobs with partial data and budget left', () => {
    expect(
      shouldAutoResumeOnStartup({ ...base, status: 'interrupted' })
    ).toBe(true)
    expect(
      shouldAutoResumeOnStartup({
        ...base,
        status: 'interrupted',
        completedBytes: 0
      })
    ).toBe(false)
    expect(
      shouldAutoResumeOnStartup({
        ...base,
        status: 'interrupted',
        attempts: 3
      })
    ).toBe(false)
    expect(
      shouldAutoResumeOnStartup({
        ...base,
        status: 'interrupted',
        blockReason: 'allowed-hours'
      })
    ).toBe(false)
    expect(
      shouldAutoResumeOnStartup({
        ...base,
        status: 'interrupted',
        resumeEnabled: false
      })
    ).toBe(false)
  })

  it('never auto-resumes a paused user-stop or any non-interrupted state', () => {
    for (const status of [
      'paused',
      'queued',
      'active',
      'waiting',
      'complete',
      'error'
    ] as const) {
      expect(shouldAutoResumeOnStartup({ ...base, status })).toBe(false)
    }
  })
})

describe('clipboard URL filter', () => {
  const url = 'https://example.com/files/report.pdf'

  it('accepts one changed http(s) URL', () => {
    expect(detectClipboardUrl(url, null)).toBe(url)
    expect(detectClipboardUrl(`  ${url}\n`, null)).toBe(url)
    expect(detectClipboardUrl('http://example.com/a.zip', url)).toBe(
      'http://example.com/a.zip'
    )
  })

  it('rejects multi-line, non-http, oversized, unchanged and self-copied text', () => {
    expect(detectClipboardUrl(`${url}\nsecond line`, null)).toBeNull()
    expect(detectClipboardUrl(`copy ${url}`, null)).toBeNull()
    expect(detectClipboardUrl('ftp://example.com/file.zip', null)).toBeNull()
    expect(detectClipboardUrl('file:///C:/secret.txt', null)).toBeNull()
    expect(detectClipboardUrl('javascript:alert(1)', null)).toBeNull()
    expect(
      detectClipboardUrl(`https://example.com/${'a'.repeat(MAX_CLIPBOARD_URL_LENGTH)}`, null)
    ).toBeNull()
    expect(detectClipboardUrl(url, url)).toBeNull()
    expect(detectClipboardUrl(url, null, (candidate) => candidate === url)).toBeNull()
    expect(
      detectClipboardUrl('https://user:secret@example.com/file.zip', null)
    ).toBeNull()
  })
})

describe('delete-file safety checks', () => {
  const root = path.resolve('C:\\Users\\Test\\Downloads\\DonDownload')
  const inside = path.join(root, 'file.zip')

  it('accepts the exact recorded file inside the recorded directory', () => {
    expect(
      checkDeleteTarget({
        root,
        filePath: inside,
        finished: true,
        entry: { isFile: true, isSymbolicLink: false }
      })
    ).toEqual({ ok: true })
  })

  it('refuses an unfinished job', () => {
    expect(
      checkDeleteTarget({
        root,
        filePath: inside,
        finished: false,
        entry: { isFile: true, isSymbolicLink: false }
      })
    ).toEqual({ ok: false, problem: 'not-finished' })
  })

  it('refuses a path outside the job output directory', () => {
    expect(
      checkDeleteTarget({
        root,
        filePath: path.resolve('C:\\Users\\Test\\Downloads\\Elsewhere\\file.zip'),
        finished: true,
        entry: { isFile: true, isSymbolicLink: false }
      })
    ).toEqual({ ok: false, problem: 'outside-directory' })
    expect(
      checkDeleteTarget({
        root,
        filePath: root,
        finished: true,
        entry: { isFile: false, isSymbolicLink: false }
      })
    ).toEqual({ ok: false, problem: 'outside-directory' })
  })

  it('refuses a symbolic link even when it points inside the directory', () => {
    expect(
      checkDeleteTarget({
        root,
        filePath: inside,
        finished: true,
        entry: { isFile: true, isSymbolicLink: true }
      })
    ).toEqual({ ok: false, problem: 'symbolic-link' })
  })

  it('refuses a missing path or non-file entry', () => {
    expect(
      checkDeleteTarget({
        root,
        filePath: null,
        finished: true,
        entry: null
      })
    ).toEqual({ ok: false, problem: 'missing-path' })
    expect(
      checkDeleteTarget({ root, filePath: inside, finished: true, entry: null })
    ).toEqual({ ok: false, problem: 'missing' })
    expect(
      checkDeleteTarget({
        root,
        filePath: inside,
        finished: true,
        entry: { isFile: false, isSymbolicLink: false }
      })
    ).toEqual({ ok: false, problem: 'not-a-file' })
  })
})

describe('completion notification decision', () => {
  const base = {
    enabled: true,
    supported: true,
    kind: 'download' as const,
    previousStatus: 'active',
    nextStatus: 'complete',
    title: 'archive.zip'
  }

  it('announces completion and failure with a safe title', () => {
    expect(decideCompletionNotification(base)).toEqual({
      notify: true,
      title: 'Download complete',
      body: 'archive.zip'
    })
    expect(
      decideCompletionNotification({
        ...base,
        kind: 'media',
        previousStatus: 'downloading',
        nextStatus: 'error',
        title: 'Example video'
      })
    ).toEqual({
      notify: true,
      title: 'Media download failed',
      body: 'Example video'
    })
  })

  it('is silent when disabled, unsupported, unchanged or user-cancelled', () => {
    expect(
      decideCompletionNotification({ ...base, enabled: false }).notify
    ).toBe(false)
    expect(
      decideCompletionNotification({ ...base, supported: false }).notify
    ).toBe(false)
    expect(
      decideCompletionNotification({ ...base, previousStatus: 'complete' }).notify
    ).toBe(false)
    expect(
      decideCompletionNotification({
        ...base,
        kind: 'media',
        previousStatus: 'downloading',
        nextStatus: 'cancelled'
      }).notify
    ).toBe(false)
    expect(
      decideCompletionNotification({ ...base, cancelledByUser: true }).notify
    ).toBe(false)
    expect(
      decideCompletionNotification({
        ...base,
        previousStatus: 'downloading',
        nextStatus: 'paused'
      }).notify
    ).toBe(false)
  })
})

describe('desktop settings persistence and paused media migration', () => {
  it('round-trips desktop settings and accepts the new paused media status', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'dondownload-desktop-'))
    const database = openDownloadDatabase(path.join(dir, 'downloads.sqlite3'))
    try {
      expect(database.schemaVersion).toBe(SCHEMA_VERSION)
      expect(SCHEMA_VERSION).toBe(23)
      expect(database.loadDesktopSettings()).toEqual(defaultDesktopSettings())

      const next = {
        resumeInterruptedOnStartup: false,
        showNotifications: false,
        watchClipboard: true,
        launchAtLogin: true,
        exitToTrayStubWhenIdle: false,
        warnAboutDuplicates: false,
        welcomeGuideSeen: true,
        interfaceSizePercent: 125 as const
      }
      database.saveDesktopSettings(next)
      expect(database.loadDesktopSettings()).toEqual(next)

      const record: MediaJobRecord = {
        id: 'paused-media-job',
        sourceUrl: 'https://example.com/watch?v=abc',
        analysisId: 'analysis_0123456789abcdef',
        optionId: 'option_video_0123456789',
        kind: 'video',
        title: 'Paused media',
        label: '1080p',
        status: 'paused',
        completedBytes: 100,
        totalBytes: 1_000,
        errorMessage: null,
        dir: path.join(dir, 'Media'),
        filePath: null,
        createdAt: 1,
        updatedAt: 2,
        completedAt: null
      }
      database.saveMediaJob(record)
      expect(database.loadMediaJobs()).toEqual([record])
    } finally {
      database.close()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
