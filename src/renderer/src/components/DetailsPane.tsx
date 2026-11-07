import { formatBytes } from '@shared/format'
import {
  CHECKSUM_ALGORITHM_LABELS,
  parseExpectedHash,
  type ChecksumProgress,
  type ChecksumResult
} from '@shared/checksum'
import { useEffect, useRef, useState, type JSX } from 'react'
import type { StatusTone, UnifiedRow } from '../lib/unified'
import { CATEGORY_LABELS } from '../lib/unified'
import { progressLine, shortDateTime } from '../lib/rowProgress'
import { useNowUntil } from '../lib/useNow'
import { canOpenRow, canShowRow } from '../lib/actions'
import { CATEGORY_ACCENT, CATEGORY_ICON, Icon, type IconName } from './Icon'

const PILL_TONE: Record<StatusTone, string> = {
  active: 'border-accent-400/30 bg-accent-400/10 text-accent-300',
  queued: 'border-white/10 bg-white/[0.04] text-zinc-300',
  paused: 'border-zinc-600/70 bg-zinc-800/60 text-zinc-300',
  complete: 'border-emerald-400/20 bg-emerald-400/[0.07] text-emerald-300',
  warning: 'border-amber-400/25 bg-amber-400/10 text-amber-300',
  failed: 'border-red-400/30 bg-red-400/10 text-red-300'
}

const PILL_DOT: Record<StatusTone, string> = {
  active: 'bg-accent-400',
  queued: 'bg-zinc-500',
  paused: 'bg-zinc-400',
  complete: 'bg-emerald-400',
  warning: 'bg-amber-400',
  failed: 'bg-red-400'
}

export function DetailsPane({
  row,
  onClose,
  onOpen,
  onShowInFolder,
  onCopyLink
}: {
  row: UnifiedRow
  onClose: () => void
  onOpen: (row: UnifiedRow) => void
  onShowInFolder: (row: UnifiedRow) => void
  onCopyLink: (row: UnifiedRow) => void
}): JSX.Element {
  const openable = canOpenRow(row)
  const showable = canShowRow(row)
  // Keep the retry countdown live, and only run a timer while one is pending.
  const now = useNowUntil(1_000, [row.retryAt])

  return (
    <section
      aria-label={`Details for ${row.title}`}
      className="mt-3 shrink-0 overflow-hidden rounded-xl border border-white/10 surface-card"
    >
      <div className="flex items-center gap-2.5 border-b border-white/[0.07] px-3 py-2.5">
        <span
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-white/10 bg-white/[0.03] ${CATEGORY_ACCENT[row.category]}`}
        >
          <Icon name={CATEGORY_ICON[row.category]} size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <p
            className="truncate text-[13px] font-semibold text-zinc-100"
            title={row.title}
          >
            {row.title}
          </p>
          <p className="truncate text-[11px] text-zinc-500">
            {row.source === 'media' ? 'Media job' : 'Direct download'} ·{' '}
            {CATEGORY_LABELS[row.category]}
          </p>
        </div>
        <StatusPill label={row.statusLabel} tone={row.statusTone} />
        {openable ? (
          <button
            type="button"
            onClick={() => onOpen(row)}
            aria-label={`Open ${row.title}`}
            title="Open file"
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-500 transition hover:bg-white/5 hover:text-zinc-200"
          >
            <Icon name="external" size={14} />
          </button>
        ) : null}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close details"
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-500 transition hover:bg-white/5 hover:text-zinc-200"
        >
          <Icon name="x" size={14} />
        </button>
      </div>

      <div className="flex flex-col gap-1.5 px-3 py-2.5 text-[11.5px] text-zinc-400">
        <p className="tabular-nums">{progressLine(row, now)}</p>
        {row.media ? (
          <p className="truncate" title={row.media.label}>
            {row.media.label}
          </p>
        ) : null}
        {row.url ? (
          <div className="flex min-w-0 items-center gap-2">
            <Icon name="link" size={13} className="shrink-0 text-zinc-600" />
            <span className="truncate" title={row.url}>
              {row.url}
            </span>
            <IconAction
              icon="copy"
              label="Copy link"
              onClick={() => onCopyLink(row)}
            />
          </div>
        ) : null}
        {row.filePath ? (
          <div className="flex min-w-0 items-center gap-2">
            {showable ? (
              <Icon
                name="folder"
                size={13}
                className="shrink-0 text-zinc-600"
              />
            ) : null}
            <span className="truncate" title={row.filePath}>
              {row.filePath}
            </span>
            {showable ? (
              <IconAction
                icon="folder"
                label="Show in folder"
                onClick={() => onShowInFolder(row)}
              />
            ) : null}
          </div>
        ) : null}
        {row.attempts !== null && row.attempts > 1 ? (
          <p>
            Retried {row.attempts - 1} {row.attempts - 1 === 1 ? 'time' : 'times'}
          </p>
        ) : null}
        {row.source === 'download' &&
        row.download?.status === 'complete' &&
        row.filePath !== null ? (
          <ChecksumSection key={row.download.id} row={row} />
        ) : null}
      </div>

      {row.errorMessage ? (
        <div className="mx-3 mb-2.5">
          <p
            role="alert"
            className="rounded-lg border border-red-400/20 bg-red-400/5 px-2.5 py-1.5 text-[11px] leading-5 text-red-300"
          >
            {row.errorMessage}
          </p>
          {row.errorDetail ? (
            <p className="mt-1 px-1 text-[10.5px] leading-4 text-zinc-500">
              <span className="font-semibold uppercase tracking-wide">
                Technical details
              </span>
              {': '}
              <span className="select-text" title={row.errorDetail}>
                {row.errorDetail}
              </span>
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

function StatusPill({
  label,
  tone
}: {
  label: string
  tone: StatusTone
}): JSX.Element {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${PILL_TONE[tone]}`}
    >
      <span
        aria-hidden="true"
        className={`h-1.5 w-1.5 rounded-full ${PILL_DOT[tone]} ${tone === 'active' ? 'animate-pulse' : ''}`}
      />
      {label}
    </span>
  )
}

function IconAction({
  icon,
  label,
  onClick
}: {
  icon: IconName
  label: string
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-zinc-500 transition hover:bg-white/5 hover:text-zinc-200"
    >
      <Icon name={icon} size={13} />
    </button>
  )
}

/**
 * Streaming checksum verification for one completed direct download. Only the
 * opaque download id crosses IPC; the main process resolves the recorded path.
 */
function ChecksumSection({ row }: { row: UnifiedRow }): JSX.Element {
  const downloadId = row.download?.id ?? ''
  const stored = row.download?.checksum ?? null
  const [expected, setExpected] = useState('')
  const [busy, setBusy] = useState<'verify' | 'compute' | null>(null)
  const [progress, setProgress] = useState<ChecksumProgress | null>(null)
  const [localResult, setLocalResult] = useState<ChecksumResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const unsubscribe = window.donDownload.onChecksumProgress((next) => {
      if (next.downloadId === downloadId) setProgress(next)
    })
    return unsubscribe
  }, [downloadId])

  useEffect(
    () => () => {
      if (copyTimer.current !== null) clearTimeout(copyTimer.current)
    },
    []
  )

  const parsed = parseExpectedHash(expected)
  const invalid = expected.trim().length > 0 && parsed === null
  const busyNow = busy !== null
  const result = localResult ?? stored
  const totalBytes = progress?.totalBytes ?? 0
  const percent =
    progress !== null && totalBytes > 0
      ? Math.min(100, Math.round((progress.hashedBytes / totalBytes) * 100))
      : null

  const copy = (value: string): void => {
    void window.donDownload.copyText(value).then((response) => {
      if (!response.ok) return
      setCopied(true)
      if (copyTimer.current !== null) clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => setCopied(false), 1_500)
    })
  }

  const verify = async (): Promise<void> => {
    if (parsed === null || busyNow) return
    setBusy('verify')
    setError(null)
    setLocalResult(null)
    setProgress(null)
    const response = await window.donDownload.verifyChecksum(
      downloadId,
      parsed.hash
    )
    setBusy(null)
    if (!response.ok) {
      if (response.error.code !== 'CHECKSUM_CANCELLED') {
        setError(response.error.message)
      }
      return
    }
    setLocalResult(response.value)
  }

  const compute = async (): Promise<void> => {
    if (busyNow) return
    setBusy('compute')
    setError(null)
    setLocalResult(null)
    setProgress(null)
    const response = await window.donDownload.computeChecksum(downloadId)
    setBusy(null)
    if (!response.ok) {
      if (response.error.code !== 'CHECKSUM_CANCELLED') {
        setError(response.error.message)
      }
      return
    }
    setLocalResult(response.value)
  }

  return (
    <div className="mt-2 border-t border-white/[0.07] pt-2">
      <p className="text-[10.5px] font-semibold uppercase tracking-wide text-zinc-500">
        Checksum
      </p>
      <div className="mt-1.5 flex min-w-0 items-center gap-1.5">
        <input
          value={expected}
          onChange={(event) => {
            setExpected(event.target.value)
            setError(null)
          }}
          disabled={busyNow}
          aria-label="Expected hash"
          aria-invalid={invalid}
          placeholder="Expected hash"
          spellCheck={false}
          autoComplete="off"
          className={`h-7 min-w-0 flex-1 rounded-md border bg-black/20 px-2 font-mono text-[11px] text-zinc-200 outline-none placeholder:font-sans placeholder:text-zinc-600 disabled:opacity-60 ${
            invalid
              ? 'border-red-400/50'
              : 'border-white/10 focus:border-accent-400/50'
          }`}
        />
        <button
          type="button"
          onClick={() => void verify()}
          disabled={busyNow || parsed === null}
          className="h-7 shrink-0 rounded-md border border-white/10 bg-white/[0.04] px-2.5 text-[11px] font-semibold text-zinc-200 transition hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-40"
        >
          Verify
        </button>
      </div>
      {invalid ? (
        <p role="alert" className="mt-1 text-[10.5px] leading-4 text-red-300">
          Enter 32 (MD5), 40 (SHA-1), 64 (SHA-256) or 128 (SHA-512) hex
          characters.
        </p>
      ) : parsed !== null ? (
        <p className="mt-1 text-[10.5px] text-zinc-500">
          {CHECKSUM_ALGORITHM_LABELS[parsed.algorithm]} detected
        </p>
      ) : null}

      <div className="mt-1.5 flex min-w-0 items-center gap-1.5">
        <button
          type="button"
          onClick={() => void compute()}
          disabled={busyNow}
          className="h-7 shrink-0 rounded-md border border-white/10 bg-white/[0.04] px-2.5 text-[11px] font-semibold text-zinc-200 transition hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-40"
        >
          Compute SHA-256
        </button>
        {busyNow ? (
          <button
            type="button"
            onClick={() => void window.donDownload.cancelChecksum(downloadId)}
            className="h-7 shrink-0 rounded-md px-2 text-[11px] text-zinc-400 transition hover:bg-white/5 hover:text-zinc-200"
          >
            Cancel
          </button>
        ) : null}
      </div>

      {busyNow ? (
        <p className="mt-1 text-[10.5px] text-zinc-500" aria-live="polite">
          {progress === null
            ? 'Hashing…'
            : percent === null
              ? `Hashing… ${formatBytes(progress.hashedBytes)}`
              : `Hashing… ${percent}%`}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-1 text-[10.5px] leading-4 text-red-300">
          {error}
        </p>
      ) : null}
      {result ? (
        <div className="mt-1.5 min-w-0">
          <p className="flex min-w-0 items-center gap-1.5">
            <span className="font-semibold text-zinc-300">
              {CHECKSUM_ALGORITHM_LABELS[result.algorithm]}
            </span>
            {result.ok === null ? (
              <span className="text-zinc-500">Computed</span>
            ) : result.ok ? (
              <span className="font-semibold text-emerald-300">Match</span>
            ) : (
              <span className="font-semibold text-red-300">Mismatch</span>
            )}
            <span className="ml-auto shrink-0 text-[10px] text-zinc-600">
              {shortDateTime(result.checkedAt)}
            </span>
          </p>
          <div className="mt-0.5 flex min-w-0 items-start gap-1">
            <code className="min-w-0 flex-1 break-all text-[10.5px] leading-4 text-zinc-400 select-text">
              {result.computed}
            </code>
            <IconAction
              icon="copy"
              label={copied ? 'Copied' : 'Copy checksum'}
              onClick={() => copy(result.computed)}
            />
          </div>
        </div>
      ) : null}
    </div>
  )
}
