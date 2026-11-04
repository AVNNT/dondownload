import { promises as fs } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { AppError } from '../errors'

const ARIA2_MISSING_HINT =
  'Install aria2 (for example: winget install aria2.aria2), place aria2c.exe in vendor/aria2/, or set DONDOWNLOAD_ARIA2_PATH. aria2 is GPL-2.0-or-later software and is not bundled with DonDownload.'

async function isFile(candidate: string): Promise<boolean> {
  try {
    const stat = await fs.stat(candidate)
    return stat.isFile()
  } catch {
    return false
  }
}

async function pathCandidates(): Promise<string[]> {
  const names =
    process.platform === 'win32' ? ['aria2c.exe', 'aria2c'] : ['aria2c']
  const entries = (process.env.PATH ?? '')
    .split(path.delimiter)
    .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
    .filter((entry) => entry.length > 0)

  const candidates: string[] = []
  for (const dir of entries) {
    for (const name of names) {
      candidates.push(path.join(dir, name))
    }
  }
  return candidates
}

/**
 * Locate aria2c without invoking a shell. The explicit override wins, then a
 * local vendor directory, then PATH. Binaries are never downloaded at runtime.
 */
export async function locateAria2c(): Promise<string> {
  const override = process.env.DONDOWNLOAD_ARIA2_PATH?.trim()
  const candidates: string[] = []

  if (override) {
    const resolved = path.isAbsolute(override)
      ? override
      : path.resolve(process.cwd(), override)
    if (await isFile(resolved)) {
      return resolved
    }
    throw new AppError(
      'ARIA2_NOT_FOUND',
      `DONDOWNLOAD_ARIA2_PATH points to a missing file: ${resolved}`,
      ARIA2_MISSING_HINT
    )
  }

  if (app.isPackaged) {
    candidates.push(path.join(process.resourcesPath, 'vendor', 'aria2', 'aria2c.exe'))
  }
  candidates.push(
    path.join(app.getAppPath(), 'vendor', 'aria2', 'aria2c.exe'),
    path.join(app.getAppPath(), 'vendor', 'aria2', 'aria2c')
  )
  candidates.push(...(await pathCandidates()))

  for (const candidate of candidates) {
    if (await isFile(candidate)) {
      return candidate
    }
  }

  throw new AppError('ARIA2_NOT_FOUND', 'aria2c was not found on this computer.', ARIA2_MISSING_HINT)
}
