import { useMemo, useState, type JSX } from 'react'
import { isQueueableScanItem, type ScanItem, type ScanSession } from '@shared/scanner'
import type { AppErrorInfo } from '@shared/types'
import { Icon } from './Icon'
import {
  pruneImageSelection,
  selectAllImages,
  selectNoImages,
  selectedImageIds,
  shiftClickImage,
  toggleImage
} from './imageSelection'

interface ScanImagePickerProps {
  session: ScanSession
  disabled?: boolean
  onClose: () => void
}

/**
 * Image mode of the scan sheet.
 *
 * The extension already walked the live page, so there is nothing to discover
 * here: this is only a picker. Nothing is selected up front, so the user picks
 * the tiles they want (click to toggle, Shift+click for a range) and nothing
 * downloads until they click "Download N images", which queues one batch into a
 * folder named after the page. Thumbnails are the small/fallback URL the
 * extension reported; the full image is what gets downloaded.
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
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [anchorId, setAnchorId] = useState<string | null>(null)
  const [queuing, setQueuing] = useState(false)
  const [error, setError] = useState<AppErrorInfo | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [failed, setFailed] = useState<Set<string>>(new Set())

  // Items can disappear when the session is revised, so ids that are no longer
  // in the list are dropped on read. New items are never added: the selection
  // only ever holds ids the user clicked.
  const activeSelected = useMemo(
    () => pruneImageSelection(items, selected),
    [items, selected]
  )

  const selectedIds = useMemo(
    () => selectedImageIds(items, activeSelected),
    [items, activeSelected]
  )
  const selectedCount = selectedIds.length

  const toggle = (id: string, shiftKey: boolean): void => {
    if (shiftKey) {
      setSelected((current) =>
        shiftClickImage(items, pruneImageSelection(items, current), anchorId, id)
      )
      if (anchorId === null) setAnchorId(id)
      return
    }
    setSelected((current) =>
      toggleImage(items, pruneImageSelection(items, current), id)
    )
    setAnchorId(id)
  }

  const selectAll = (): void => {
    setSelected(selectAllImages(items))
    setAnchorId(items[0]?.id ?? null)
  }
  const selectNone = (): void => {
    setSelected(selectNoImages())
    setAnchorId(null)
  }

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
                selected={activeSelected.has(item.id)}
                failed={failed.has(item.id)}
                disabled={disabled || queuing}
                onToggle={(shiftKey) => toggle(item.id, shiftKey)}
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
          {selectedCount === 0
            ? 'Click images to select them (Shift+click for a range)'
            : `${selectedCount} selected`}
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
  /** `shiftKey` comes from the click, so the picker can extend a range. */
  onToggle: (shiftKey: boolean) => void
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
    <button
      type="button"
      onClick={(event) => onToggle(event.shiftKey)}
      disabled={disabled}
      aria-pressed={selected}
      aria-label={`${selected ? 'Deselect' : 'Select'} ${item.name}`}
      className={`group relative flex w-full cursor-pointer flex-col overflow-hidden rounded-xl border bg-white/[0.03] text-left transition ${
        selected
          ? 'border-accent-500 ring-2 ring-accent-400/60'
          : 'border-white/10 hover:border-white/20'
      } ${disabled ? 'cursor-default opacity-60' : ''}`}
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
            className={`h-full w-full object-cover transition ${
              selected ? '' : 'opacity-70 group-hover:opacity-100'
            }`}
          />
        )}
        <span
          aria-hidden="true"
          className={`absolute left-1.5 top-1.5 grid h-5 w-5 place-items-center rounded-full border transition ${
            selected
              ? 'border-accent-400 bg-accent-500 text-on-accent'
              : 'border-white/40 bg-black/50 text-transparent'
          }`}
        >
          <Icon name="check" size={12} strokeWidth={2.6} />
        </span>
      </span>
      <span className="flex items-center gap-1 px-1.5 py-1">
        <span
          className={`min-w-0 flex-1 truncate text-[11.5px] ${
            selected ? 'text-zinc-200' : 'text-zinc-400'
          }`}
          title={item.name}
        >
          {item.name}
        </span>
        {size !== null ? (
          <span className="shrink-0 text-[10.5px] text-zinc-500">{size}</span>
        ) : null}
      </span>
    </button>
  )
}
