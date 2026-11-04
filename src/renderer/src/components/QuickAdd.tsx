import { useState, type FormEvent, type JSX } from 'react'
import type { AddDownloadInput, ApiResult, AppSnapshot } from '@shared/types'
import { normalizeHttpUrl, sanitizeFilename } from '@shared/validation'

interface QuickAddProps {
  disabled: boolean
  onAdd: (input: AddDownloadInput) => Promise<ApiResult<AppSnapshot>>
}

export function QuickAdd({ disabled, onAdd }: QuickAddProps): JSX.Element {
  const [url, setUrl] = useState('')
  const [filename, setFilename] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)
  const [duplicateInput, setDuplicateInput] = useState<AddDownloadInput | null>(
    null
  )

  function resetDuplicate(): void {
    setDuplicateInput(null)
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setLocalError(null)
    resetDuplicate()

    let input: AddDownloadInput
    try {
      const normalizedUrl = normalizeHttpUrl(url)
      const trimmedName = filename.trim()
      input =
        trimmedName.length > 0
          ? { url: normalizedUrl, filename: sanitizeFilename(trimmedName) }
          : { url: normalizedUrl }
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : 'Check the URL.')
      return
    }

    const result = await onAdd(input)
    if (result.ok) {
      setUrl('')
      setFilename('')
    } else if (result.error.code === 'DUPLICATE_DOWNLOAD') {
      // Keep the entered URL/name and make the intentional repeat explicit.
      setDuplicateInput(input)
    }
  }

  async function handleDownloadAgain(): Promise<void> {
    if (disabled || duplicateInput === null) return
    setLocalError(null)

    const result = await onAdd({ ...duplicateInput, force: true })
    if (result.ok) {
      setUrl('')
      setFilename('')
      setDuplicateInput(null)
    } else if (result.error.code === 'DUPLICATE_DOWNLOAD') {
      setDuplicateInput(duplicateInput)
    }
  }

  return (
    <form
      onSubmit={(event) => {
        void handleSubmit(event)
      }}
      className="rounded-2xl border border-white/10 bg-[#070707] p-3 sm:p-4"
    >
      <div className="flex flex-col gap-2 sm:flex-row">
        <label className="sr-only" htmlFor="download-url">
          Download URL
        </label>
        <input
          id="download-url"
          type="text"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          value={url}
          onChange={(event) => {
            setUrl(event.target.value)
            resetDuplicate()
          }}
          placeholder="https://example.com/file.zip"
          disabled={disabled}
          className="h-11 min-w-0 flex-1 rounded-xl border border-white/10 bg-black px-3.5 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none transition focus:border-emerald-400/60 focus:ring-2 focus:ring-emerald-400/15 disabled:opacity-50"
        />
        <label className="sr-only" htmlFor="download-filename">
          Custom file name (optional)
        </label>
        <input
          id="download-filename"
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={filename}
          onChange={(event) => {
            setFilename(event.target.value)
            resetDuplicate()
          }}
          placeholder="File name (optional)"
          disabled={disabled}
          className="h-11 min-w-0 rounded-xl border border-white/10 bg-black px-3.5 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none transition focus:border-emerald-400/60 focus:ring-2 focus:ring-emerald-400/15 disabled:opacity-50 sm:w-44 lg:w-52"
        />
        <button
          type="submit"
          disabled={disabled || url.trim().length === 0}
          className="h-11 shrink-0 rounded-xl bg-emerald-400 px-5 text-sm font-semibold text-black transition hover:bg-emerald-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
        >
          {disabled ? 'Adding…' : 'Add download'}
        </button>
      </div>
      {duplicateInput ? (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-400/25 bg-amber-400/5 px-3 py-2">
          <p className="text-[11px] leading-5 text-amber-200">
            This URL is already queued or downloading. The entered URL and name
            were kept.
          </p>
          <button
            type="button"
            onClick={() => {
              void handleDownloadAgain()
            }}
            disabled={disabled}
            className="h-8 shrink-0 rounded-lg border border-amber-300/30 px-3 text-[11px] font-semibold text-amber-100 transition hover:bg-amber-300/10 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Download again
          </button>
        </div>
      ) : null}
      <div className="flex items-start justify-between gap-3 px-1 pt-2">
        <p className="text-[11px] leading-5 text-zinc-600">
          Direct HTTP(S) links. Saved to Downloads\DonDownload.
        </p>
        {localError ? (
          <p role="alert" className="text-right text-[11px] leading-5 text-red-400">
            {localError}
          </p>
        ) : null}
      </div>
    </form>
  )
}
