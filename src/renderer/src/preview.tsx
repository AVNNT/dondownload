import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'
import {
  createPreviewApi,
  type PreviewFixtureControls
} from './preview/fixtures'
import type { DonDownloadApi } from '@shared/types'

/**
 * The fixture API is created in the module body below, before React mounts, so
 * the automation effect can always reach it through this reference.
 */
let fixtureApi: (DonDownloadApi & PreviewFixtureControls) | null = null

/** Runs the ?state/?theme/?overflow screenshot automation once on mount. */
function Automation(): null {
  useEffect(() => {
    runPreviewAutomation()
    return undefined
  }, [])
  return null
}

/**
 * Dev-only browser entry. It renders the real application shell with an
 * in-memory `DonDownloadApi` adapter, so the desktop renderer can be inspected
 * in a normal browser without Electron or the preload bridge.
 *
 * `preview.html` is intentionally absent from the production rollup input; this
 * runtime guard is a second line of defence if it is ever opened accidentally.
 */

/**
 * Screenshot automation, driven by query parameters so headless browsers can
 * capture UI states without a driver: ?state=add|add-opts|add-links|batches|
 * cancel-menu|cancelled|clear-list|details|images|shortcuts|undo|welcome|
 * welcome-browser|welcome-tutorial|welcome-ready, optional ?theme=light|dark|
 * oled, and ?overflow=1 renders a badge with the horizontal-overflow metrics.
 */
function runPreviewAutomation(): void {
  // React StrictMode runs effects twice in dev; the automation must run once.
  const w = window as typeof window & { __previewAutomationRan?: boolean }
  if (w.__previewAutomationRan) return
  w.__previewAutomationRan = true
  const params = new URLSearchParams(window.location.search)
  const theme = params.get('theme')
  const applyTheme = (): void => {
    if (theme === 'light' || theme === 'dark' || theme === 'oled') {
      window.document.documentElement.dataset.theme = theme
    }
  }
  applyTheme()
  const state = params.get('state')
  if (state === null && theme === null && !params.has('overflow')) return

  const wait = (ms: number): Promise<void> =>
    new Promise((resolve) => window.setTimeout(resolve, ms))

  const clickByText = async (text: string, attempts = 20): Promise<boolean> => {
    for (let i = 0; i < attempts; i++) {
      const button = Array.from(
        window.document.querySelectorAll<HTMLButtonElement>('button')
      ).find((candidate) => candidate.textContent?.trim().startsWith(text))
      if (button) {
        button.click()
        return true
      }
      await wait(100)
    }
    return false
  }

  // The Add dialog is a lazily loaded chunk, so the textarea can appear after
  // the click that opens it. Wait for it the same way clickByText waits.
  const setTextarea = async (value: string, attempts = 20): Promise<boolean> => {
    for (let i = 0; i < attempts; i++) {
      const area = window.document.querySelector<HTMLTextAreaElement>(
        'textarea#add-links, textarea'
      )
      if (area !== null) {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          'value'
        )?.set
        setter?.call(area, value)
        area.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      }
      await wait(100)
    }
    return false
  }

  void (async () => {
    await wait(400)
    applyTheme()
    if (params.has('overflow')) {
      await wait(600)
      const doc = window.document.documentElement
      const badge = window.document.createElement('div')
      badge.style.cssText =
        'position:fixed;left:8px;top:8px;z-index:2000;background:#000;padding:4px 8px;border-radius:6px'
      badge.textContent = `overflow ${
        doc.scrollWidth > doc.clientWidth ? 'YES' : 'no'
      } scrollWidth=${doc.scrollWidth} clientWidth=${doc.clientWidth}`
      window.document.body.append(badge)
    }
    if (state === 'add' || state === 'add-opts' || state === 'add-links') {
      if (!(await clickByText('Add'))) return
      await wait(250)
      if (state === 'add-opts') {
        await setTextarea('https://example.com/files/ubuntu-24.04.1-desktop-amd64.iso')
        await wait(300)
        const details = window.document.querySelector('details')
        if (details !== null && !details.open) details.open = true
      }
      if (state === 'add-links') {
        await wait(200)
        await setTextarea(
          [
            'https://cdn.example.net/brand-assets-2026.7z',
            'https://www.youtube.com/watch?v=launch-keynote',
            'https://www.youtube.com/playlist?list=PL-demo-1'
          ].join('\n')
        )
      }
    }
    if (state === 'batches') {
      await clickByText('Batches')
    }
    if (state === 'shortcuts') {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: '?', shiftKey: true, bubbles: true })
      )
    }
    if (state === 'welcome') {
      // The fixture seeds welcomeGuideSeen=false for this state; the guide mounts
      // from the desktop-settings read right after the first render.
      await wait(600)
    }
    if (state === 'welcome-browser' || state === 'welcome-ready') {
      await wait(600)
      await clickByText('Next')
      await wait(350)
      if (state === 'welcome-ready') {
        await clickByText('Next')
        await wait(350)
      }
    }
    if (state === 'welcome-tutorial') {
      await wait(600)
      await clickByText('Next')
      await wait(350)
      await clickByText('Show me how')
      await wait(400)
    }
    if (state === 'done-chip') {
      await clickByText('Done')
    }
    if (state === 'clear-list') {
      // Opens the "Clear list" confirmation so the copy can be reviewed.
      await clickByText('Clear list')
    }
    if (state === 'dup') {
      if (!(await clickByText('Add'))) return
      await wait(250)
      await setTextarea('https://cdn.example.net/brand/brand-assets-2026.7z')
      await wait(300)
      await clickByText('Download')
    }
    if (state === 'dup-finished') {
      // Completed history notice: Open file / Show in folder / Download again.
      if (!(await clickByText('Add'))) return
      await wait(250)
      await setTextarea(
        'https://files.example.org/reports/quarterly-report-2026.pdf'
      )
      // Let the debounced duplicate check answer; do not click Download, so the
      // screenshot shows the safe default with nothing auto-started.
      await wait(900)
    }
    if (state === 'scan') {
      if (!(await clickByText('Add'))) return
      await wait(250)
      await setTextarea('https://forum.example.org/t/weekly-design-notes/4812')
      await wait(400)
      if (!(await clickByText('Scan'))) return
    }
    if (state === 'images') {
      // The picker sheet is the extension image flow: one session, thumbnails.
      fixtureApi?.openImageScanFixture()
      await wait(400)
    }
    if (state === 'details') {
      await wait(300)
      window.document
        .querySelector<HTMLElement>('[data-row-key]')
        ?.dispatchEvent(
          new MouseEvent('click', { bubbles: true, cancelable: true })
        )
    }
    if (state === 'cancel-menu') {
      // Open the context menu on the active download fixture row so the Cancel
      // action is visible in a screenshot.
      await wait(400)
      const row = window.document.querySelector<HTMLElement>(
        '[data-row-key="download:preview-download-active"]'
      )
      if (row !== null) {
        const rect = row.getBoundingClientRect()
        row.dispatchEvent(
          new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX: Math.round(rect.left + 120),
            clientY: Math.round(rect.top + 16)
          })
        )
      }
    }
    if (state === 'cancelled') {
      // Cancel the active fixture and select the resulting terminal row.
      await wait(400)
      await fixtureApi?.cancelDownload('preview-download-active')
      await wait(400)
      window.document
        .querySelector<HTMLElement>(
          '[data-row-key="download:preview-download-active"]'
        )
        ?.dispatchEvent(
          new MouseEvent('click', { bubbles: true, cancelable: true })
        )
    }
    if (state === 'undo') {
      // Remove the first row so the deferred-removal toast is visible.
      await wait(300)
      const row = window.document.querySelector<HTMLElement>('[data-row-key]')
      if (row === null) return
      row.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true })
      )
      await wait(150)
      row.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Delete',
          bubbles: true,
          cancelable: true
        })
      )
    }
  })()
}

const container = document.getElementById('root')
if (!container) {
  throw new Error('Root element was not found.')
}

if (!import.meta.env.DEV) {
  container.textContent =
    'The DonDownload fixture preview is only available in development.'
} else {
  document.documentElement.dataset.preview = 'fixtures'
  const previewParams = new URLSearchParams(window.location.search)
  const previewApi = createPreviewApi({
    welcomeGuideSeen: !previewParams.get('state')?.startsWith('welcome')
  })
  fixtureApi = previewApi
  window.donDownload = previewApi

  function FixtureControls() {
    const [message, setMessage] = useState('Simulation only · no real transfer')
    return (
      <aside
        aria-label="Fixture controls"
        style={{
          position: 'fixed',
          right: 12,
          bottom: 12,
          zIndex: 1000,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          maxWidth: 'calc(100vw - 24px)',
          padding: '8px 10px',
          border: '1px solid #d97706',
          borderRadius: 8,
          background: '#1c1917',
          color: '#fef3c7',
          fontSize: 12
        }}
      >
        <span role="status">{message}</span>
        <button type="button" onClick={() => setMessage(previewApi.advanceDownloadFixture())}>
          Advance simulated transfer
        </button>
      </aside>
    )
  }

  createRoot(container).render(
    <StrictMode>
      <App />
      {/* `?screenshots` hides the fixture controls for README captures. */}
      {new URLSearchParams(window.location.search).has('screenshots') ? null : <FixtureControls />}
      <Automation />
    </StrictMode>
  )
}
