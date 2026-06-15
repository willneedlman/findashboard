// Account-scoped persistence: mirrors the user's saved data (portfolios, journal,
// alerts, dashboard, watchlist, custom strategies, nav favorites, theme prefs) to
// the server so it follows the account across devices, browsers, and IPs.
//
// How it works:
//  - sync() on login/app-load pulls the account's stored data into localStorage
//    (server wins for keys it has) and seeds the server with any local-only keys,
//    so nothing is lost in either direction.
//  - startAutoPush() patches localStorage.setItem/removeItem so any later change to
//    an allowlisted key is debounce-pushed to the account.
//
// Device-specific keys (the session token, notification-permission flags) are NOT
// in the allowlist and never leave the device. The single shared ft-portfolio blob
// keeps its own existing sync (portfolio_json) and is excluded here to avoid two
// writers. Theme/font prefs live inside the per-user ft-users blob (not their own
// localStorage keys), so they aren't synced here.

const ALLOWLIST = [
  'pm-portfolios-v2',              // Portfolio Manager (multi-portfolio)
  'ft-trade-journal',              // Trade Journal
  'alerts',                        // Price Alerts
  'finance-terminal-dashboard-v3', // Dashboard layout
  'watchlist',                     // Watchlist
  'fdb_custom_strategies',         // Custom strategies
  'ft_nav_favorites',              // Pinned nav items
]
const ALLOW = new Set(ALLOWLIST)

let installed = false
let suppress = false   // true while hydrating, so writes don't echo back as pushes
let pushTimer: ReturnType<typeof setTimeout> | null = null
const dirty = new Set<string>()
let getAuth: (() => { uid: string | null; token: string | null }) = () => ({ uid: null, token: null })

function headers(token: string): Record<string, string> {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'x-session-token': token }
}

function readLocal(key: string): unknown | undefined {
  const raw = localStorage.getItem(key)
  if (raw === null) return undefined
  try { return JSON.parse(raw) } catch { return raw }
}

/** Pull the account's data into localStorage (server wins for its keys) and seed
 *  the server with any local-only keys. Returns true if localStorage changed, so
 *  the caller can reload once to let mounted pages re-read the hydrated data. */
export async function sync(userId: string, token: string): Promise<boolean> {
  let serverData: Record<string, unknown> = {}
  try {
    const res = await fetch(`/api/users/appdata/${userId}`, { headers: headers(token) })
    if (!res.ok) return false
    serverData = ((await res.json()).data ?? {}) as Record<string, unknown>
  } catch {
    return false
  }

  let changed = false
  suppress = true
  try {
    for (const key of ALLOWLIST) {
      if (key in serverData) {
        const incoming = JSON.stringify(serverData[key])
        if (localStorage.getItem(key) !== incoming) {
          localStorage.setItem(key, incoming)
          changed = true
        }
      }
    }
  } finally {
    suppress = false
  }

  // Seed the account from this device for keys the server doesn't have yet.
  const seed: Record<string, unknown> = {}
  for (const key of ALLOWLIST) {
    if (!(key in serverData)) {
      const v = readLocal(key)
      if (v !== undefined) seed[key] = v
    }
  }
  if (Object.keys(seed).length) {
    try {
      const res = await fetch('/api/users/appdata', {
        method: 'PUT', headers: headers(token),
        body: JSON.stringify({ user_id: userId, data: seed }),
      })
      if (!res.ok) throw new Error('seed failed')
    } catch {
      // Seed didn't land — queue the keys so auto-push retries instead of
      // silently dropping this device's existing data.
      for (const key of Object.keys(seed)) dirty.add(key)
      schedule()
    }
  }
  return changed
}

/** Cancel any pending push and forget queued changes. Call on user switch so one
 *  account's edits can never flush under another account's token. */
export function reset() {
  if (pushTimer) { clearTimeout(pushTimer); pushTimer = null }
  dirty.clear()
}

/** Wipe this device's local copy of every synced key. Call on logout / user
 *  switch so the next user never inherits (or re-uploads) the previous user's
 *  data. The server copy is the source of truth and is re-pulled on next login. */
export function clearLocal() {
  suppress = true
  try { for (const key of ALLOWLIST) localStorage.removeItem(key) } finally { suppress = false }
}

function flush() {
  const { uid, token } = getAuth()
  if (!uid || !token || dirty.size === 0) return
  const data: Record<string, unknown> = {}
  for (const key of dirty) {
    const raw = localStorage.getItem(key)
    data[key] = raw === null ? null : readLocal(key)   // null = delete server-side
  }
  dirty.clear()
  fetch('/api/users/appdata', {
    method: 'PUT', headers: headers(token),
    body: JSON.stringify({ user_id: uid, data }),
  }).catch(() => { /* will re-push on the next change */ })
}

function schedule() {
  if (pushTimer) clearTimeout(pushTimer)
  pushTimer = setTimeout(flush, 1500)
}

/** Patch localStorage so allowlisted writes auto-push to the account (debounced).
 *  Idempotent; the auth getter lets it always use the current user/token. */
export function startAutoPush(auth: () => { uid: string | null; token: string | null }) {
  getAuth = auth
  if (installed) return
  installed = true
  const origSet = localStorage.setItem.bind(localStorage)
  const origRemove = localStorage.removeItem.bind(localStorage)
  localStorage.setItem = (key: string, value: string) => {
    origSet(key, value)
    if (!suppress && ALLOW.has(key) && getAuth().uid) { dirty.add(key); schedule() }
  }
  localStorage.removeItem = (key: string) => {
    origRemove(key)
    if (!suppress && ALLOW.has(key) && getAuth().uid) { dirty.add(key); schedule() }
  }
}
