import { useEffect, useRef, type JSX } from 'react'
import type { ScanSession } from '@shared/scanner'
import { ScanPanel } from './ScanPanel'
import { Icon } from './Icon'
import { useWheelScrollLock } from '../lib/useWheelScrollLock'

interface ScanSheetProps {
  /** Prefilled page URL, used when the sheet opens from the Add dialog. */
  url: string
  /** Extension-created sessions shown together in one multi-topic view. */
  sessions?: readonly ScanSession[] | null
  disabled?: boolean
  onClose: () => void
}

/**
 * Right-hand scan surface from the redesign: a 780px sheet over a dimmed scrim.
 * It owns only the outer shell (header, close button, scrim); the scan content
 * and its draft state stay inside <ScanPanel/>, which is left untouched so the
 * parallel restyle task can keep editing it independently.
 */
export function ScanSheet({
  url,
  sessions = null,
  disabled = false,
  onClose
}: ScanSheetProps): JSX.Element {
  const sheetRef = useRef<HTMLDivElement | null>(null)
  useWheelScrollLock(sheetRef)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      ref={sheetRef}
      role="dialog"
      aria-modal="true"
      aria-label="Scan pages"
      className="fixed inset-0 z-50"
    >
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-[rgb(0_0_0_/_0.55)]"
        onMouseDown={onClose}
      />
      <div className="absolute inset-y-0 right-0 flex w-full max-w-[780px] flex-col border-l border-white/10 bg-[var(--surface-app)] shadow-2xl shadow-black/60">
        <div className="flex shrink-0 items-center gap-2.5 border-b border-white/[0.07] px-5 py-4 pr-[calc(2rem+100vw-env(titlebar-area-x,0px)-env(titlebar-area-width,100vw))]">
          <div className="min-w-0 flex-1">
            <h1 className="text-base font-semibold text-zinc-100">Scan pages</h1>
            <p className="text-[12.5px] text-zinc-500">
              Nothing downloads until you click Download
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close scan panel"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/10 text-zinc-400 transition hover:bg-white/5 hover:text-zinc-200"
          >
            <Icon name="x" size={15} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
          <ScanPanel
            initialUrl={url}
            initialSessions={sessions}
            disabled={disabled}
            embedded
          />
        </div>
      </div>
    </div>
  )
}
