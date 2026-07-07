// Single owner of the pe_wl read/toggle contract: uppercase, deduped string
// array. The key syncs across devices via the accountSync allowlist, so every
// writer must go through here (CorporateHub keeps its richer add/remove flow
// with URL mirroring but writes the same shape).

const KEY = 'pe_wl'

export function readWatchlist(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]')
    return Array.isArray(v)
      ? [...new Set(v.filter((x): x is string => typeof x === 'string').map(s => s.trim().toUpperCase()))]
      : []
  } catch { return [] }
}

export function toggleWatchlist(sym: string): string[] {
  const s = sym.trim().toUpperCase()
  const cur = readWatchlist()
  const next = cur.includes(s) ? cur.filter(t => t !== s) : [...cur, s]
  try { localStorage.setItem(KEY, JSON.stringify(next)) } catch { /* quota */ }
  return next
}
