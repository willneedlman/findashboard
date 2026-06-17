// Most-recently-opened tools, by canonical route. Drives the "Jump Back In"
// row on Home. Stored locally only — no server round-trip.

const KEY = 'ft_recents'
const MAX = 8

export function recordRecent(route: string) {
  try {
    const cur: string[] = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    const next = [route, ...cur.filter(r => r !== route)].slice(0, MAX)
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch { /* quota / private mode — recents are best-effort */ }
}

export function getRecents(): string[] {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '[]') } catch { return [] }
}
