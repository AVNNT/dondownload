import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const extractedResources = process.env.DONDOWNLOAD_EXTRACTED_RESOURCES?.trim()
const runPackagedResources = extractedResources ? describe : describe.skip

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getAppPath: () => process.cwd()
  }
}))

import { locateAria2c } from '../src/main/aria2/locator'
import { locateMediaTool } from '../src/main/media/locator'

runPackagedResources('extracted packaged resource discovery', () => {
  const originalResourcesPath = Object.getOwnPropertyDescriptor(
    process,
    'resourcesPath'
  )
  const originalAria2Override = process.env.DONDOWNLOAD_ARIA2_PATH
  const originalPath = process.env.PATH

  beforeAll(() => {
    Object.defineProperty(process, 'resourcesPath', {
      configurable: true,
      value: extractedResources
    })
    delete process.env.DONDOWNLOAD_ARIA2_PATH
    process.env.PATH = ''
  })

  afterAll(() => {
    if (originalResourcesPath) {
      Object.defineProperty(process, 'resourcesPath', originalResourcesPath)
    } else {
      Reflect.deleteProperty(process, 'resourcesPath')
    }
    if (originalAria2Override === undefined) {
      delete process.env.DONDOWNLOAD_ARIA2_PATH
    } else {
      process.env.DONDOWNLOAD_ARIA2_PATH = originalAria2Override
    }
    if (originalPath === undefined) {
      delete process.env.PATH
    } else {
      process.env.PATH = originalPath
    }
  })

  it('resolves all packaged tools from the extracted resources tree', async () => {
    const resources = extractedResources as string
    const expected = {
      aria2: path.join(resources, 'vendor', 'aria2', 'aria2c.exe'),
      ytdlp: path.join(resources, 'vendor', 'yt-dlp', 'yt-dlp.exe'),
      ffmpeg: path.join(resources, 'vendor', 'ffmpeg', 'ffmpeg.exe'),
      deno: path.join(resources, 'vendor', 'deno', 'deno.exe')
    }

    await expect(locateAria2c()).resolves.toBe(expected.aria2)
    for (const tool of ['ytdlp', 'ffmpeg', 'deno'] as const) {
      await expect(
        locateMediaTool(tool, {
          env: { PATH: '' },
          platform: 'win32',
          cwd: process.cwd()
        })
      ).resolves.toMatchObject({
        path: expected[tool],
        explicit: false,
        missingExplicit: false
      })
    }
  })
})
