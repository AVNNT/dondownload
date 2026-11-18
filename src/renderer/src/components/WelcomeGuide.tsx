import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX
} from 'react'
import {
  WELCOME_RELEASES_URL,
  type BrowserEngine,
  type WelcomeBrowserInfo,
  type WelcomeInfo
} from '@shared/welcome'
import { Icon } from './Icon'
import { useWheelScrollLock } from '../lib/useWheelScrollLock'
import {
  WELCOME_STEP_LABELS,
  WELCOME_STEP_TITLES,
  connectionLabel,
  detectedSummary,
  sharedConnectionNote,
  tutorialButtonLabel,
  tutorialSteps,
  tutorialUrl
} from '../lib/welcome'

export interface WelcomeGuideProps {
  /** Called for Skip, Esc, the close button and Done. Persists "seen" upstream. */
  onClose: () => void
}

const BTN_PRIMARY =
  'inline-flex h-8 items-center justify-center gap-1.5 rounded-lg bg-accent-500 px-3 text-xs font-semibold text-on-accent transition hover:bg-accent-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-300 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400'
const BTN_GHOST =
  'inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-white/10 surface-card px-3 text-xs font-medium text-zinc-200 transition hover:border-accent-400/40 hover:text-accent-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-300 disabled:cursor-not-allowed disabled:opacity-60'
const BTN_LINK =
  'inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11.5px] font-semibold text-accent-300 transition hover:bg-accent-400/10 hover:text-accent-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-300'

function StepDots({ step }: { step: number }): JSX.Element {
  return (
    <div className="flex items-center gap-2" aria-hidden="true">
      {WELCOME_STEP_LABELS.map((label, index) => (
        <span
          key={label}
          className={`h-1.5 rounded-full transition-all ${
            index === step
              ? 'w-6 bg-accent-400'
              : index < step
                ? 'w-1.5 bg-accent-400/60'
                : 'w-1.5 bg-white/15'
          }`}
        />
      ))}
    </div>
  )
}

/**
 * First-start guide. Mounted only while open (App shows it once and Settings
 * can re-open it), so the browser probe and IPC call never run in the
 * background. Esc, Skip, the close button and Done all close the same way.
 */
export function WelcomeGuide({ onClose }: WelcomeGuideProps): JSX.Element {
  const backdropRef = useRef<HTMLDivElement | null>(null)
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const [step, setStep] = useState(0)
  const [info, setInfo] = useState<WelcomeInfo | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [tutorial, setTutorial] = useState<{
    browserId: string
    engine: BrowserEngine
  } | null>(null)

  useWheelScrollLock(backdropRef)

  useEffect(() => {
    dialogRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    let cancelled = false
    void window.donDownload
      .getWelcomeInfo()
      .then((result) => {
        if (cancelled) return
        if (result.ok) setInfo(result.value)
        else setLoadError(result.error.message)
      })
      .catch(() => {
        if (!cancelled) setLoadError('The browser list could not be loaded.')
      })
    return () => {
      cancelled = true
    }
  }, [])

  const copy = useCallback(async (text: string): Promise<void> => {
    setNotice(null)
    const result = await window.donDownload.copyText(text)
    setNotice(result.ok ? `Copied ${text}` : 'That address could not be copied.')
  }, [])

  const openReleases = useCallback(async (): Promise<void> => {
    setNotice(null)
    const result = await window.donDownload.openWelcomeReleases()
    if (!result.ok) setNotice(result.error.message)
  }, [])

  const openExtensionFolder = useCallback(async (): Promise<void> => {
    setNotice(null)
    const result = await window.donDownload.openBrowserExtensionFolder()
    if (!result.ok) {
      setNotice(
        'The extension folder could not be opened. Use the releases page instead.'
      )
    }
  }, [])

  const showTutorial = useCallback(
    async (browser: WelcomeBrowserInfo): Promise<void> => {
      setTutorial({ browserId: browser.id, engine: browser.engine })
      if (browser.engine === 'chromium' && info?.extensionBundled !== false) {
        await openExtensionFolder()
      } else {
        // Without a bundled folder (or for Firefox/Zen) the releases page is
        // the only place to get the extension.
        await openReleases()
      }
    },
    [info?.extensionBundled, openExtensionFolder, openReleases]
  )

  const tutorialBrowser = tutorial
    ? (info?.browsers.find((browser) => browser.id === tutorial.browserId) ??
      null)
    : null
  const tutorialEngine = tutorial?.engine ?? 'chromium'
  const tutorialAddress = tutorialUrl(tutorialEngine)

  return (
    <div
      ref={backdropRef}
      className="no-drag fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto overscroll-contain bg-[rgb(0_0_0_/_0.6)] p-4 pt-[8vh]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="welcome-guide-title"
        aria-describedby="welcome-guide-subtitle"
        tabIndex={-1}
        className="flex max-h-[84vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-white/10 bg-[var(--surface-app)] shadow-2xl shadow-black/70 outline-none"
      >
        <div className="flex items-center gap-2 border-b border-white/[0.07] px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2
              id="welcome-guide-title"
              className="text-sm font-semibold text-zinc-100"
            >
              Welcome to DonDownload
            </h2>
            <p
              id="welcome-guide-subtitle"
              className="mt-0.5 text-[11px] text-zinc-500"
            >
              Three quick things before your first download.
            </p>
          </div>
          <StepDots step={step} />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close the welcome guide"
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 text-zinc-400 transition hover:bg-white/5 hover:text-zinc-200 outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
          >
            <Icon name="x" size={15} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4">
          <p className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
            Step {step + 1} of {WELCOME_STEP_LABELS.length} ·{' '}
            {WELCOME_STEP_TITLES[step]}
          </p>

          {step === 0 ? (
            <section aria-labelledby="welcome-downloads-heading">
              <div className="flex items-start gap-3 rounded-xl border border-white/10 surface-card p-4">
                <span
                  aria-hidden="true"
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-400/10 text-accent-300"
                >
                  <Icon name="folder" size={18} />
                </span>
                <div className="min-w-0 flex-1">
                  <h3
                    id="welcome-downloads-heading"
                    className="text-[13px] font-semibold text-zinc-100"
                  >
                    Downloads land here
                  </h3>
                  <code className="mt-1.5 block break-all rounded-lg border border-white/10 bg-black/20 px-2.5 py-2 font-mono text-[11.5px] leading-5 text-zinc-300">
                    {info?.downloadDir ?? 'Loading the download folder…'}
                  </code>
                  <p className="mt-2 text-xs leading-5 text-zinc-400">
                    Pick a different folder for any individual download in the
                    Add dialog. Finished files stay where they were saved.
                  </p>
                </div>
              </div>
              <p className="mt-3 text-xs leading-5 text-zinc-500">
                Nothing starts automatically: every link waits for you to
                confirm it.
              </p>
            </section>
          ) : null}

          {step === 1 ? (
            <section aria-labelledby="welcome-browsers-heading">
              <h3
                id="welcome-browsers-heading"
                className="text-[13px] font-semibold text-zinc-100"
              >
                Send downloads straight from your browser
              </h3>
              <p className="mt-1 text-xs leading-5 text-zinc-400">
                Load the DonDownload extension once. The status below is the
                same connection state as Settings → Browser extension.
              </p>

              {loadError !== null ? (
                <p role="alert" className="mt-3 text-xs text-red-400">
                  {loadError}
                </p>
              ) : info === null ? (
                <p className="mt-3 text-xs text-zinc-500">
                  Checking installed browsers…
                </p>
              ) : (
                <>
                  <p className="mt-3 text-[11px] text-zinc-500">
                    {detectedSummary(info.browsers)}
                  </p>
                  <ul className="mt-2 divide-y divide-white/[0.07] overflow-hidden rounded-xl border border-white/10 surface-card">
                    {info.browsers.map((browser) => {
                      const note = sharedConnectionNote(browser)
                      return (
                        <li
                          key={browser.id}
                          className="flex flex-wrap items-center gap-2 px-3.5 py-2.5"
                        >
                          <div className="min-w-0 flex-1">
                            <p className="text-[12.5px] font-semibold text-zinc-100">
                              {browser.label}
                            </p>
                            <p className="mt-0.5 text-[11px] text-zinc-500">
                              {note ??
                                (browser.engine === 'chromium'
                                  ? 'Chromium extension'
                                  : 'Firefox add-on')}
                            </p>
                          </div>
                          <span
                            className={`inline-flex items-center gap-1.5 text-[11px] font-semibold ${
                              browser.connected
                                ? 'text-emerald-400'
                                : 'text-amber-400'
                            }`}
                          >
                            <span
                              aria-hidden="true"
                              className={`h-[7px] w-[7px] rounded-full ${
                                browser.connected
                                  ? 'bg-emerald-400'
                                  : 'bg-amber-400'
                              }`}
                            />
                            {connectionLabel(browser.connected)}
                          </span>
                          <button
                            type="button"
                            onClick={() => void showTutorial(browser)}
                            aria-expanded={tutorial?.browserId === browser.id}
                            className={BTN_GHOST}
                          >
                            {tutorialButtonLabel(browser.engine)}
                          </button>
                        </li>
                      )
                    })}
                  </ul>

                  {info.browsers.length === 0 ? (
                    <p className="mt-2 text-xs leading-5 text-zinc-500">
                      No supported browser was found in the usual install
                      folders. You can still load the extension by hand from the
                      releases page.
                    </p>
                  ) : null}

                  {tutorial !== null ? (
                    <div className="mt-3 rounded-xl border border-accent-400/25 bg-accent-400/[0.06] p-3.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <h4 className="min-w-0 flex-1 text-[12.5px] font-semibold text-zinc-100">
                          {tutorialBrowser?.label ?? 'Load the extension'}
                        </h4>
                        <code className="rounded border border-white/10 bg-black/20 px-1.5 py-0.5 font-mono text-[10.5px] text-zinc-400">
                          {tutorialAddress}
                        </code>
                        <button
                          type="button"
                          onClick={() => void copy(tutorialAddress)}
                          className="inline-flex h-7 items-center gap-1 rounded-md border border-white/10 surface-card px-2 text-[11px] font-medium text-zinc-300 transition hover:border-white/20 hover:text-zinc-100"
                        >
                          <Icon name="copy" size={12} />
                          Copy
                        </button>
                      </div>
                      <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-xs leading-5 text-zinc-400">
                        {tutorialSteps(tutorialEngine).map((guideStep) => (
                          <li key={guideStep.label}>
                            <span className="font-semibold text-zinc-200">
                              {guideStep.label}
                            </span>
                            <span className="block text-[11.5px] leading-5 text-zinc-500">
                              {guideStep.detail}
                            </span>
                          </li>
                        ))}
                      </ol>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => void openExtensionFolder()}
                          className={BTN_GHOST}
                        >
                          <Icon name="folder" size={14} />
                          Open extension folder
                        </button>
                        <button
                          type="button"
                          onClick={() => void openReleases()}
                          className={BTN_LINK}
                        >
                          <Icon name="external" size={13} />
                          Get it from GitHub
                        </button>
                      </div>
                      {tutorialEngine === 'chromium' ? (
                        <p className="mt-2 text-[11px] leading-4 text-zinc-500">
                          A browser cannot be opened at {tutorialAddress} from
                          outside, so copy it and paste it into the address bar.
                        </p>
                      ) : null}
                    </div>
                  ) : null}

                  {notice !== null ? (
                    <p
                      role="status"
                      aria-live="polite"
                      className="mt-2 text-[11px] text-zinc-400"
                    >
                      {notice}
                    </p>
                  ) : null}
                </>
              )}

              <p className="mt-3 text-[11px] leading-4 text-zinc-500">
                Extension updates ship with the app and the latest{' '}
                <a
                  href={WELCOME_RELEASES_URL}
                  onClick={(event) => {
                    event.preventDefault()
                    void openReleases()
                  }}
                  className="text-accent-300 underline-offset-2 hover:underline"
                >
                  GitHub release
                </a>
                .
              </p>
            </section>
          ) : null}

          {step === 2 ? (
            <section aria-labelledby="welcome-tips-heading">
              <h3
                id="welcome-tips-heading"
                className="text-[13px] font-semibold text-zinc-100"
              >
                A few shortcuts worth knowing
              </h3>
              <ul className="mt-2 space-y-2">
                <li className="flex items-start gap-3 rounded-xl border border-white/10 surface-card px-3.5 py-2.5">
                  <kbd className="mt-0.5 rounded border border-white/10 bg-black/20 px-1.5 py-0.5 font-mono text-[10.5px] text-zinc-300">
                    Ctrl V
                  </kbd>
                  <span className="text-xs leading-5 text-zinc-400">
                    Paste a link anywhere in the app to add it. Ctrl+N opens the
                    same Add dialog.
                  </span>
                </li>
                <li className="flex items-start gap-3 rounded-xl border border-white/10 surface-card px-3.5 py-2.5">
                  <span
                    aria-hidden="true"
                    className="mt-0.5 text-accent-300"
                  >
                    <Icon name="download" size={15} />
                  </span>
                  <span className="text-xs leading-5 text-zinc-400">
                    Closing the window keeps downloads running in the tray.
                    Quit from the tray menu when you want to stop.
                  </span>
                </li>
                <li className="flex items-start gap-3 rounded-xl border border-white/10 surface-card px-3.5 py-2.5">
                  <span
                    aria-hidden="true"
                    className="mt-0.5 text-accent-300"
                  >
                    <Icon name="gauge" size={15} />
                  </span>
                  <span className="text-xs leading-5 text-zinc-400">
                    "Free memory when idle in the tray" keeps the app tiny while
                    nothing is downloading.
                  </span>
                </li>
                <li className="flex items-start gap-3 rounded-xl border border-white/10 surface-card px-3.5 py-2.5">
                  <span
                    aria-hidden="true"
                    className="mt-0.5 text-accent-300"
                  >
                    <Icon name="settings" size={15} />
                  </span>
                  <span className="text-xs leading-5 text-zinc-400">
                    Settings → Getting started can replay this guide at any
                    time.
                  </span>
                </li>
              </ul>
            </section>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-white/[0.07] px-4 py-3">
          <button type="button" onClick={onClose} className={BTN_GHOST}>
            Skip guide
          </button>
          <span className="flex-1" />
          {step > 0 ? (
            <button
              type="button"
              onClick={() => {
                setNotice(null)
                setStep((current) => Math.max(0, current - 1))
              }}
              className={BTN_GHOST}
            >
              <Icon name="chevron-left" size={14} />
              Back
            </button>
          ) : null}
          {step < WELCOME_STEP_LABELS.length - 1 ? (
            <button
              type="button"
              onClick={() => {
                setNotice(null)
                setStep((current) => current + 1)
              }}
              className={BTN_PRIMARY}
            >
              Next
              <Icon name="chevron-right" size={14} />
            </button>
          ) : (
            <button type="button" onClick={onClose} className={BTN_PRIMARY}>
              <Icon name="check" size={15} />
              Start downloading
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
