import { useEffect, useRef, type JSX } from 'react'

export interface ConfirmRequest {
  title: string
  message: string
  confirmLabel: string
  onConfirm: () => void
}

export function ConfirmDialog({
  request,
  onClose
}: {
  request: ConfirmRequest
  onClose: () => void
}): JSX.Element {
  const confirmRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    confirmRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/65 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-message"
        className="w-full max-w-sm rounded-xl border border-white/10 bg-[var(--surface-card)] p-4 shadow-2xl shadow-black/70"
      >
        <h2 id="confirm-title" className="text-sm font-semibold text-zinc-100">
          {request.title}
        </h2>
        <p
          id="confirm-message"
          className="mt-1.5 text-xs leading-5 text-zinc-400"
        >
          {request.message}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-8 rounded-lg border border-white/10 px-3 text-[11px] font-medium text-zinc-300 transition hover:bg-white/5"
          >
            Cancel
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={() => {
              request.onConfirm()
              onClose()
            }}
            className="h-8 rounded-lg bg-red-400 px-3 text-[11px] font-semibold text-red-950 transition hover:bg-red-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-300"
          >
            {request.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
