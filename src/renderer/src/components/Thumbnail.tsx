import { useState, type JSX } from 'react'
import { Icon, type IconName } from './Icon'

export interface ThumbnailFallback {
  icon: IconName
  accent: string
}

/**
 * Lazy, no-referrer media thumbnail with a category-icon fallback. The live
 * media-job DTO does not persist a thumbnail yet, so most live rows use the
 * fallback; fixture/preview rows can exercise the image path.
 */
export function Thumbnail({
  src,
  title,
  fallback,
  size = 'sm'
}: {
  src?: string
  title: string
  fallback: ThumbnailFallback
  /** `card` is the larger 16:9 video-card treatment; `row` is the 40px list cell. */
  size?: 'sm' | 'row' | 'card'
}): JSX.Element {
  const [failed, setFailed] = useState(false)
  const box =
    size === 'card'
      ? 'h-14 w-24 rounded-lg'
      : size === 'row'
        ? 'h-10 w-10 rounded-lg'
        : 'h-7 w-7 rounded-md'

  if (failed || src === undefined || src.length === 0) {
    return (
      <span
        className={`flex shrink-0 items-center justify-center border border-white/10 bg-white/[0.03] ${box} ${fallback.accent}`}
      >
        <Icon name={fallback.icon} size={size === 'card' ? 22 : size === 'row' ? 18 : 15} />
      </span>
    )
  }

  return (
    <img
      src={src}
      alt=""
      title={title}
      // The virtualised list only mounts rows inside the window, so lazy
      // loading never queues an off-screen thumbnail. Async decoding keeps a
      // decoded image from blocking the row's first paint.
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      draggable={false}
      onError={() => setFailed(true)}
      className={`shrink-0 border border-white/10 object-cover ${box}`}
    />
  )
}
