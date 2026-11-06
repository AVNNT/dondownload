import { useEffect, useState, type JSX } from 'react'
import type {
  BrowserExtensionBrowserStatus,
  BrowserExtensionStatus
} from '@shared/browserExtension'

function browserLabel(browser: BrowserExtensionBrowserStatus): string {
  if (browser.browser === 'Chrome') return 'Chrome'
  if (browser.browser === 'Helium') return 'Helium (shares Chrome’s key)'
  return 'Edge'
}

export function BrowserExtensionSection(): JSX.Element {
  const [status, setStatus] = useState<BrowserExtensionStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    void window.donDownload.getBrowserExtensionStatus().then((result) => {
      if (cancelled) return
      if (result.ok) setStatus(result.value)
      else setError(result.error.message)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const repair = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      const result = await window.donDownload.repairBrowserExtension()
      if (!result.ok) {
        setError(result.error.message)
        return
      }
      setStatus(result.value)
      setMessage(
        result.value.registered
          ? 'Browser connection repaired.'
          : 'Repair ran, but at least one browser key still needs attention.'
      )
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'The browser connection could not be repaired.'
      )
    } finally {
      setBusy(false)
    }
  }

  const openFolder = async (): Promise<void> => {
    setError(null)
    const result = await window.donDownload.openBrowserExtensionFolder()
    if (!result.ok) setError(result.error.message)
  }

  const copyPath = async (): Promise<void> => {
    setError(null)
    setMessage(null)
    const result = await window.donDownload.copyBrowserExtensionFolderPath()
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    setMessage('Extension folder path copied.')
  }

  return (
    <section
      className="mt-4 rounded-xl border border-white/10 surface-card p-3 sm:p-4"
      aria-labelledby="browser-extension-heading"
    >
      <div className="mb-3">
        <h2
          id="browser-extension-heading"
          className="text-[11px] font-medium uppercase tracking-[0.16em] text-zinc-400"
        >
          Browser extension
        </h2>
        <p className="mt-1 text-xs leading-5 text-zinc-400">
          DonDownload registers its native messaging bridge automatically for
          the current Windows user. No registration script or manual extension
          ID is needed.
        </p>
      </div>

      {status === null ? (
        <p
          role={error ? 'alert' : undefined}
          className={`text-xs ${error ? 'text-red-300' : 'text-zinc-500'}`}
        >
          {error ?? 'Checking the browser connection…'}
        </p>
      ) : (
        <div className="space-y-3">
          <ul className="grid gap-1.5">
            {status.browsers.map((browser) => (
              <li
                key={browser.browser}
                className="flex items-center justify-between gap-2 rounded-lg border border-white/5 surface-soft px-2.5 py-2"
              >
                <span className="flex min-w-0 items-center gap-2 text-xs text-zinc-300">
                  <span
                    aria-hidden="true"
                    className={`h-2 w-2 shrink-0 rounded-full ${
                      browser.registered ? 'bg-emerald-400' : 'bg-amber-400'
                    }`}
                  />
                  <span className="truncate">{browserLabel(browser)}</span>
                </span>
                <span
                  className={`shrink-0 text-[10px] font-medium uppercase tracking-[0.08em] ${
                    browser.registered ? 'text-emerald-300' : 'text-amber-300'
                  }`}
                >
                  {browser.registered ? 'Connected' : 'Needs repair'}
                </span>
              </li>
            ))}
          </ul>

          <dl className="grid gap-1 text-[10px] leading-4 text-zinc-400">
            <div className="flex gap-1">
              <dt className="shrink-0 text-zinc-500">Native host:</dt>
              <dd className="min-w-0 break-all font-mono text-zinc-300">
                {status.hostPath}
              </dd>
            </div>
            <div className="flex gap-1">
              <dt className="shrink-0 text-zinc-500">Allowed origin:</dt>
              <dd className="min-w-0 break-all font-mono text-zinc-300">
                {status.allowedOrigins.join(', ')}
              </dd>
            </div>
          </dl>

          {status.lastError ? (
            <p role="alert" className="text-xs text-red-300">
              {status.lastError}
            </p>
          ) : null}

          <div className="rounded-lg border border-white/10 surface-soft px-2.5 py-2">
            <p className="text-[10px] font-medium uppercase tracking-[0.08em] text-zinc-500">
              Extension folder
            </p>
            <code className="mt-1 block break-all font-mono text-[11px] text-zinc-300">
              {status.extensionFolder}
            </code>
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void openFolder()}
                className="min-h-8 rounded-lg border border-white/10 surface-card px-3 text-[11px] font-medium text-zinc-200 transition hover:border-emerald-400/40 hover:text-emerald-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300"
              >
                Open folder
              </button>
              <button
                type="button"
                onClick={() => void copyPath()}
                className="min-h-8 rounded-lg border border-white/10 surface-card px-3 text-[11px] font-medium text-zinc-200 transition hover:border-emerald-400/40 hover:text-emerald-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300"
              >
                Copy path
              </button>
            </div>
          </div>

          <ol className="list-decimal space-y-1 pl-5 text-[11px] leading-5 text-zinc-300">
            <li>
              Open <code className="text-zinc-200">helium://extensions</code> or{' '}
              <code className="text-zinc-200">chrome://extensions</code>.
            </li>
            <li>Turn on Developer mode.</li>
            <li>
              Choose <strong>Load unpacked</strong> and select the folder above.
              The extension keeps the same fixed ID.
            </li>
          </ol>

          <div className="flex flex-wrap items-center gap-2 border-t border-white/5 pt-3">
            <button
              type="button"
              onClick={() => void repair()}
              disabled={busy}
              className="min-h-9 rounded-lg bg-emerald-400 px-4 text-xs font-semibold text-emerald-950 transition hover:bg-emerald-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
            >
              {busy ? 'Repairing…' : 'Repair browser connection'}
            </button>
            {message ? (
              <span role="status" aria-live="polite" className="text-xs text-emerald-300">
                {message}
              </span>
            ) : null}
          </div>
        </div>
      )}

      {status !== null && error ? (
        <p role="alert" className="mt-2 text-xs text-red-300">
          {error}
        </p>
      ) : null}
    </section>
  )
}
