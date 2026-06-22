// Most-recently-viewed tickers from the global search. Local only, best-effort.

const KEY = 'ft_recent_tickers'
const MAX = 6

export function recordRecentTicker(sym: string) {
  if (!sym) return
  try {
    const cur: string[] = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    const next = [sym, ...cur.filter(s => s !== sym)].slice(0, MAX)
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch { /* quota / private mode — best-effort */ }
}

export function getRecentTickers(): string[] {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '[]') } catch { return [] }
}
