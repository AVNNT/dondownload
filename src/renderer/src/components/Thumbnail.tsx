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
  fallback
}: {
  src?: string
  title: string
  fallback: ThumbnailFallback
}): JSX.Element {
  const [failed, setFailed] = useState(false)

  if (failed || src === undefined || src.length === 0) {
    return (
      <span
        className={`flex h-7 w-7 items-center justify-center rounded-md border border-white/10 bg-white/[0.03] ${fallback.accent}`}
      >
        <Icon name={fallback.icon} size={15} />
      </span>
    )
  }

  return (
    <img
      src={src}
      alt=""
      title={title}
      loading="lazy"
      referrerPolicy="no-referrer"
      draggable={false}
      onError={() => setFailed(true)}
      className="h-7 w-7 rounded-md border border-white/10 object-cover"
    />
  )
}
