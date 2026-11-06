import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'
import { createPreviewApi } from './preview/fixtures'

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
 * details|shortcuts, optional ?theme=light|dark|oled, and ?overflow=1 renders
 * a badge with the horizontal-overflow metrics.
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

  const setTextarea = (value: string): boolean => {
    const area = window.document.querySelector<HTMLTextAreaElement>(
      'textarea#add-links, textarea'
    )
    if (area === null) return false
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value'
    )?.set
    setter?.call(area, value)
    area.dispatchEvent(new Event('input', { bubbles: true }))
    return true
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
        setTextarea('https://example.com/files/ubuntu-24.04.1-desktop-amd64.iso')
        await wait(300)
        const details = window.document.querySelector('details')
        if (details !== null && !details.open) details.open = true
      }
      if (state === 'add-links') {
        await wait(200)
        setTextarea(
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
    if (state === 'done-chip') {
      await clickByText('Done')
    }
    if (state === 'dup') {
      if (!(await clickByText('Add'))) return
      await wait(250)
      setTextarea('https://cdn.example.net/brand/brand-assets-2026.7z')
      await wait(300)
      await clickByText('Download')
    }
    if (state === 'scan') {
      if (!(await clickByText('Add'))) return
      await wait(250)
      setTextarea('https://forum.example.org/t/weekly-design-notes/4812')
      await wait(400)
      if (!(await clickByText('Scan'))) return
    }
    if (state === 'details') {
      await wait(300)
      window.document
        .querySelector<HTMLElement>('[data-row-key]')
        ?.dispatchEvent(
          new MouseEvent('click', { bubbles: true, cancelable: true })
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
  const previewApi = createPreviewApi()
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
      <FixtureControls />
      <Automation />
    </StrictMode>
  )
}
