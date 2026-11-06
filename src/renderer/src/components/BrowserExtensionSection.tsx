import { useEffect, useState, type JSX } from 'react'
import type {
  BrowserExtensionBrowserStatus,
  BrowserExtensionStatus
} from '@shared/browserExtension'
import { Icon } from './Icon'

const BTN_PRIMARY =
  'inline-flex h-8 items-center justify-center gap-1.5 rounded-lg bg-accent-500 px-3 text-xs font-semibold text-on-accent transition hover:bg-accent-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-300 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400'
const BTN_GHOST =
  'inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-white/10 surface-card px-3 text-xs font-medium text-zinc-200 transition hover:border-accent-400/40 hover:text-accent-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-300 disabled:cursor-not-allowed disabled:opacity-60'

function browserLabel(browser: BrowserExtensionBrowserStatus): string {
  if (browser.browser === 'Chrome') return 'Chrome'
  if (browser.browser === 'Helium') return 'Helium'
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
      aria-labelledby="browser-extension-heading"
      className="mt-8"
    >
      <div className="mb-3">
        <h2
          id="browser-extension-heading"
          className="text-base font-semibold text-zinc-100"
        >
          Browser extension
        </h2>
        <p className="mt-0.5 text-xs leading-5 text-zinc-400">
          Lets you download videos and files straight from your browser.
        </p>
      </div>

      {status === null ? (
        <p
          role={error ? 'alert' : undefined}
          className={`text-xs ${error ? 'text-red-400' : 'text-zinc-500'}`}
        >
          {error ?? 'Checking the browser connection…'}
        </p>
      ) : (
        <>
          <div className="rounded-xl border border-white/10 surface-card divide-y divide-white/[0.07]">
            {status.browsers.map((browser) => (
              <div
                key={browser.browser}
                className="flex min-h-[54px] items-center gap-3 px-4 py-3"
              >
                <span className="min-w-0 flex-1 font-semibold text-zinc-100">
                  {browserLabel(browser)}
                  {browser.browser === 'Helium' ? (
                    <span className="block text-xs font-normal text-zinc-500">
                      Uses the Chrome connection
                    </span>
                  ) : null}
                </span>
                <ConnectionPill registered={browser.registered} />
              </div>
            ))}
            <div className="flex min-h-[62px] flex-wrap items-center gap-3 px-4 py-3.5">
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-zinc-100">
                  Install in another browser
                </p>
                <p className="mt-0.5 text-xs leading-4 text-zinc-500">
                  Load the extension folder with Developer mode on.
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => void openFolder()}
                  className={BTN_PRIMARY}
                >
                  <Icon name="folder" size={15} />
                  Open folder
                </button>
                <button
                  type="button"
                  onClick={() => void repair()}
                  disabled={busy}
                  className={BTN_GHOST}
                >
                  {busy ? 'Repairing…' : 'Repair connection'}
                </button>
              </div>
            </div>
          </div>

          <div className="mt-4 rounded-xl border border-white/10 surface-card divide-y divide-white/[0.07]">
            <div className="flex items-center gap-3 px-4 py-3 text-xs">
              <dt className="shrink-0 text-zinc-500">Native host</dt>
              <dd className="min-w-0 flex-1 break-all font-mono text-zinc-400">
                {status.hostPath}
              </dd>
            </div>
            <div className="flex items-center gap-3 px-4 py-3 text-xs">
              <dt className="shrink-0 text-zinc-500">Allowed origin</dt>
              <dd className="min-w-0 flex-1 break-all font-mono text-zinc-400">
                {status.allowedOrigins.join(', ')}
              </dd>
            </div>
            <div className="flex items-center gap-3 px-4 py-3 text-xs">
              <dt className="shrink-0 text-zinc-500">Extension folder</dt>
              <dd className="min-w-0 flex-1">
                <code className="block break-all font-mono text-zinc-400">
                  {status.extensionFolder}
                </code>
                <button
                  type="button"
                  onClick={() => void copyPath()}
                  className="mt-1.5 inline-flex h-7 items-center rounded-md border border-white/10 surface-card px-2 text-[11px] font-medium text-zinc-300 transition hover:border-white/20 hover:text-zinc-100"
                >
                  Copy path
                </button>
              </dd>
            </div>
            <div className="px-4 py-3.5">
              <ol className="list-decimal space-y-1 pl-5 text-xs leading-5 text-zinc-400">
                <li>
                  Open <code className="text-zinc-300">helium://extensions</code>{' '}
                  or <code className="text-zinc-300">chrome://extensions</code>.
                </li>
                <li>Turn on Developer mode.</li>
                <li>
                  Choose <strong>Load unpacked</strong> and select the folder
                  above. The extension keeps the same fixed ID.
                </li>
              </ol>
            </div>
            {status.lastError ? (
              <div className="px-4 py-3">
                <p role="alert" className="text-xs text-red-400">
                  {status.lastError}
                </p>
              </div>
            ) : null}
          </div>

          {message ? (
            <p
              role="status"
              aria-live="polite"
              className="mt-2 text-xs text-emerald-400"
            >
              {message}
            </p>
          ) : null}
        </>
      )}

      {status !== null && error ? (
        <p role="alert" className="mt-2 text-xs text-red-400">
          {error}
        </p>
      ) : null}
    </section>
  )
}

function ConnectionPill({ registered }: { registered: boolean }): JSX.Element {
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-[11px] font-semibold ${
        registered ? 'text-emerald-400' : 'text-amber-400'
      }`}
    >
      <span
        aria-hidden="true"
        className={`h-[7px] w-[7px] rounded-full ${
          registered ? 'bg-emerald-400' : 'bg-amber-400'
        }`}
      />
      {registered ? 'Connected' : 'Needs repair'}
    </span>
  )
}
