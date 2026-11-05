import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'
import { createPreviewApi } from './preview/fixtures'

/**
 * Dev-only browser entry. It renders the real application shell with an
 * in-memory `DonDownloadApi` adapter, so the desktop renderer can be inspected
 * in a normal browser without Electron or the preload bridge.
 *
 * `preview.html` is intentionally absent from the production rollup input; this
 * runtime guard is a second line of defence if it is ever opened accidentally.
 */
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
      <>
        <App />
        <FixtureControls />
      </>
    </StrictMode>
  )
}
