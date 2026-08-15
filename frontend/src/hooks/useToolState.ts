import { useCallback, useEffect, useRef, useState } from 'react'

// Tool inputs that survive leaving the page and coming back.
//
// Most tools kept their inputs in plain useState with no persistence, so moving
// between them meant re-entering the same period, benchmark or threshold. The
// screener was the worst case: a 25-filter screen you had not explicitly saved
// was gone the moment you navigated away.
//
// sessionStorage, not localStorage: this is session context, not saved data. It
// should not outlive the tab or sync to the account, and lib/accountSync
// monkey-patches localStorage.setItem so anything written there becomes synced
// account data whether or not that was intended.

const PREFIX = 'ft_tool:'

function read<T>(key: string, fallback: T): T {
  try {
    const raw = sessionStorage.getItem(PREFIX + key)
    if (raw == null) return fallback
    const parsed = JSON.parse(raw)
    // Objects merge onto the defaults so a new field added to a tool since the
    // value was stored arrives with its default rather than undefined.
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
        fallback && typeof fallback === 'object' && !Array.isArray(fallback)) {
      return { ...fallback, ...parsed }
    }
    return parsed as T
  } catch {
    return fallback
  }
}

export function useToolState<T>(key: string, defaults: T): [T, (value: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => read(key, defaults))
  const keyRef = useRef(key)
  keyRef.current = key

  useEffect(() => {
    try {
      sessionStorage.setItem(PREFIX + keyRef.current, JSON.stringify(value))
    } catch {
      // Quota or a private-mode block. Losing persistence is not worth an error.
    }
  }, [value])

  const set = useCallback((next: T | ((prev: T) => T)) => setValue(next), [])
  return [value, set]
}

export function clearToolState(key: string) {
  try {
    sessionStorage.removeItem(PREFIX + key)
  } catch {
    // Same as above.
  }
}
