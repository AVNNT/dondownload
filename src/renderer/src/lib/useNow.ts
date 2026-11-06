import { useEffect, useState } from 'react'

/**
 * Current clock reading that re-renders the caller on a fixed interval.
 *
 * The interval only runs while `enabled` is true, so callers can gate it on
 * something cheap such as "a visible row is waiting for an automatic retry".
 * While disabled the hook keeps the last reading and schedules no timer.
 */
export function useNow(intervalMs: number, enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!enabled) return
    // Refresh immediately so a newly enabled tick starts from the real clock
    // instead of whatever reading was left over from a previous run.
    /* eslint-disable-next-line react-hooks/set-state-in-effect -- a newly enabled tick must start from the real clock */
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs, enabled])

  return now
}

/**
 * Clock reading that ticks every `intervalMs` while at least one deadline is
 * still in the future. No timer runs when there is nothing to count down.
 */
export function useNowUntil(
  intervalMs: number,
  deadlines: readonly (number | null)[]
): number {
  const [now] = useState(() => Date.now())
  // The deadline set only changes when a snapshot arrives, so the interval is
  // not torn down on every tick.
  const pending = deadlines.some(
    (deadline) => deadline !== null && Number.isFinite(deadline) && deadline > now
  )
  return useNow(intervalMs, pending)
}
