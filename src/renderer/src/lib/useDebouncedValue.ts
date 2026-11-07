import { useEffect, useState } from 'react'

/**
 * Delay a fast-changing value (the search box) before it reaches the list.
 *
 * Filtering and sorting 10,000 rows on every keystroke makes the input feel
 * laggy, so the input keeps its own immediate value while the list follows the
 * last value that survived the delay. The timer is restarted while the user is
 * still typing and cancelled on unmount.
 */
export function useDebouncedValue<T>(value: T, delayMs = 120): T {
  const [debounced, setDebounced] = useState(value)

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])

  return debounced
}
