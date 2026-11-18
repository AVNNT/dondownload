// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/// <reference path="../src/renderer/src/env.d.ts" />
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddDownloadInput, ApiResult, AppSnapshot } from '../src/shared/types'
import type { DownloadFolderChoice } from '../src/shared/downloadDestination'
import { AddDialog } from '../src/renderer/src/components/AddDialog'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

const EMPTY_SNAPSHOT: AppSnapshot = {
  aria2: {
    status: 'stopped',
    version: null,
    binaryPath: null,
    message: null,
    hint: null
  },
  downloads: []
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  ;(window as unknown as { donDownload: unknown }).donDownload = {
    probeUrlSize: async () => ({ ok: true, value: { sizeBytes: null } })
  }
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === label
  )
  if (!found) throw new Error(`No button labelled ${label}`)
  return found as HTMLButtonElement
}

describe('AddDialog save-to expiry', () => {
  it('keeps the chosen folder and shows a clear error instead of falling back', async () => {
    const token = 'a'.repeat(32)
    const choice: DownloadFolderChoice = {
      token,
      path: 'D:\\Picked Folder'
    }
    const onAdd = vi.fn(
      async (
        _input: AddDownloadInput
      ): Promise<ApiResult<AppSnapshot>> => ({
        ok: false,
        error: {
          code: 'DOWNLOAD_FOLDER_EXPIRED',
          message: 'The chosen download folder is no longer available.',
          hint: 'Choose the folder again.'
        }
      })
    )

    await act(async () => {
      root.render(
        <AddDialog
          tab="direct"
          initialUrl="https://example.com/file.zip"
          onClose={() => undefined}
          onAdd={onAdd}
          onChooseFolder={async () => ({ ok: true, value: choice })}
          onScanOpen={() => undefined}
          onAnalyze={async () => ({
            ok: false,
            error: { code: 'UNUSED', message: 'unused' }
          })}
          onQueue={async () => ({ ok: false, error: { code: 'UNUSED', message: 'unused' } })}
        />
      )
    })

    await act(async () => {
      button('Change').click()
    })
    expect(container.textContent).toContain('D:\\Picked Folder')

    await act(async () => {
      button('Download').click()
    })

    const firstInput = onAdd.mock.calls[0]?.[0]
    expect(firstInput?.destinationToken).toBe(token)
    const alerts = [...container.querySelectorAll('[role="alert"]')].map(
      (element) => element.textContent ?? ''
    )
    expect(alerts.some((text) => text.includes('Choose the folder again'))).toBe(
      true
    )
    // The expired selection is kept: the next attempt is refused again rather
    // than silently using the default folder.
    expect(container.textContent).toContain('D:\\Picked Folder')

    await act(async () => {
      button('Download').click()
    })
    expect(onAdd).toHaveBeenCalledTimes(2)
    expect(onAdd.mock.calls[1]?.[0]?.destinationToken).toBe(token)
  })
})
