import { StrictMode } from 'react'
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
  window.donDownload = createPreviewApi()
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>
  )
}
