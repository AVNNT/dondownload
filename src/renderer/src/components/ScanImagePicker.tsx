import { useMemo, useState, type JSX } from 'react'
import {
  MAX_SCAN_SELECTION,
  isQueueableScanItem,
  type ScanItem,
  type ScanSession
} from '@shared/scanner'
import type { AppErrorInfo } from '@shared/types'
import { Icon } from './Icon'

interface ScanImagePickerProps {
  session: ScanSession
  disabled?: boolean
  onClose: () => void
}

/**
 * Image mode of the scan sheet.
 *
 * The extension already walked the live page, so there is nothing to discover
 * here: this is only a picker. Nothing downloads until the user clicks
 * "Download N images", which queues one batch into a folder named after the
 * page. Thumbnails are the small/fallback URL the extension reported; the full
 * image is what gets downloaded.
 */
export function ScanImagePicker({
  session,
  disabled = false,
  onClose
}: ScanImagePickerProps): JSX.Element {
  const items = useMemo(
    () => session.items.filter((item) => isQueueableScanItem(item)),
    [session.items]
  )
  const [excluded, setExcluded] = useState<Set<string>>(new Set())
  const [queuing, setQueuing] = useState(false)
  const [error, setError] = useState<AppErrorInfo | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [failed, setFailed] = useState<Set<string>>(new Set())

  const selectedIds = useMemo(
    () =>
      items
        .filter((item) => !excluded.has(item.id))
        .slice(0, MAX_SCAN_SELECTION)
        .map((item) => item.id),
    [items, excluded]
  )
  const selectedCount = selectedIds.length

  const toggle = (id: string): void => {
    setExcluded((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectAll = (): void => setExcluded(new Set())
  const selectNone = (): void => setExcluded(new Set(items.map((item) => item.id)))

  const download = (): void => {
    if (queuing || disabled || selectedCount === 0) return
    setQueuing(true)
    setError(null)
    setNotice(null)
    void window.donDownload
      .queueScanSelection(session.sessionId, selectedIds)
      .then((result) => {
        setQueuing(false)
        if (!result.ok) {
          setError(result.error)
          return
        }
        const skipped =
          result.value.skipped.length > 0
            ? ` ${result.value.skipped.length} could not be queued.`
            : ''
        setNotice(
          `Queued ${result.value.queuedItemIds.length} image${
            result.value.queuedItemIds.length === 1 ? '' : 's'
          } in one batch.${skipped}`
        )
      })
      .catch((reason: unknown) => {
        setQueuing(false)
        setError({
          code: 'SCAN_QUEUE_FAILED',
          message:
            reason instanceof Error
              ? reason.message
              : 'The selected images could not be queued.'
        })
      })
  }

  const markFailed = (id: string): void => {
    setFailed((current) => {
      if (current.has(id)) return current
      const next = new Set(current)
      next.add(id)
      return next
    })
  }

  const pageTitle = session.title ?? session.hostname

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-semibold text-zinc-100" title={pageTitle}>
            {pageTitle}
          </p>
          <p className="text-[12px] text-zinc-500">
            {items.length} image{items.length === 1 ? '' : 's'} found on{' '}
            {session.hostname}
          </p>
        </div>
        <button
          type="button"
          onClick={selectAll}
          disabled={disabled || queuing || items.length === 0}
          className="rounded-lg border border-white/10 px-2.5 py-1.5 text-[12px] text-zinc-300 transition hover:bg-white/5 disabled:opacity-40"
        >
          Select all
        </button>
        <button
          type="button"
          onClick={selectNone}
          disabled={disabled || queuing || items.length === 0}
          className="rounded-lg border border-white/10 px-2.5 py-1.5 text-[12px] text-zinc-300 transition hover:bg-white/5 disabled:opacity-40"
        >
          Select none
        </button>
      </div>

      {items.length === 0 ? (
        <p className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-6 text-center text-[12.5px] text-zinc-500">
          No images were found on that page.
        </p>
      ) : (
        <ul
          aria-label="Images found on this page"
          className="grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-2"
        >
          {items.map((item) => (
            <li key={item.id}>
              <ImageTile
                item={item}
                selected={!excluded.has(item.id)}
                failed={failed.has(item.id)}
                disabled={disabled || queuing}
                onToggle={() => toggle(item.id)}
                onFail={() => markFailed(item.id)}
              />
            </li>
          ))}
        </ul>
      )}

      {error !== null ? (
        <p role="alert" className="text-[12.5px] text-red-300">
          {error.message}
        </p>
      ) : null}
      {notice !== null ? (
        <p role="status" className="text-[12.5px] text-emerald-300">
          {notice}
        </p>
      ) : null}

      <div className="flex items-center gap-2 border-t border-white/[0.07] pt-3">
        <span className="text-[12.5px] text-zinc-400">
          {selectedCount} selected
        </span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg border border-white/10 px-3 py-1.5 text-[12.5px] text-zinc-300 transition hover:bg-white/5"
        >
          Close
        </button>
        <button
          type="button"
          onClick={download}
          disabled={disabled || queuing || selectedCount === 0}
          className="rounded-lg bg-accent-600 px-3 py-1.5 text-[12.5px] font-semibold text-on-accent transition hover:bg-accent-500 disabled:opacity-40"
        >
          {queuing
            ? 'Queuing…'
            : `Download ${selectedCount} image${selectedCount === 1 ? '' : 's'}`}
        </button>
      </div>
    </div>
  )
}

interface ImageTileProps {
  item: ScanItem
  selected: boolean
  failed: boolean
  disabled: boolean
  onToggle: () => void
  onFail: () => void
}

function ImageTile({
  item,
  selected,
  failed,
  disabled,
  onToggle,
  onFail
}: ImageTileProps): JSX.Element {
  const thumbnail = item.thumbnailUrl ?? null
  const size =
    item.width !== undefined &&
    item.height !== undefined &&
    item.width !== null &&
    item.height !== null
      ? `${item.width}×${item.height}`
      : null

  return (
    <label
      className={`group relative flex cursor-pointer flex-col overflow-hidden rounded-xl border bg-white/[0.03] transition ${
        selected ? 'border-accent-500/70' : 'border-white/10 hover:border-white/20'
      } ${disabled ? 'opacity-60' : ''}`}
    >
      <span className="relative block aspect-square overflow-hidden bg-black/40">
        {thumbnail === null || failed ? (
          <span className="grid h-full w-full place-items-center text-zinc-500">
            <Icon name="image" size={20} />
          </span>
        ) : (
          <img
            src={thumbnail}
            alt=""
            title={item.name}
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            draggable={false}
            onError={onFail}
            className="h-full w-full object-cover"
          />
        )}
        <input
          type="checkbox"
          checked={selected}
          disabled={disabled}
          onChange={onToggle}
          aria-label={`Select ${item.name}`}
          className="absolute left-1.5 top-1.5 h-4 w-4 accent-accent-400"
        />
      </span>
      <span className="flex items-center gap-1 px-1.5 py-1">
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-zinc-400" title={item.name}>
          {item.name}
        </span>
        {size !== null ? (
          <span className="shrink-0 text-[10.5px] text-zinc-500">{size}</span>
        ) : null}
      </span>
    </label>
  )
}
