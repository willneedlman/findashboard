// Account-scoped persistence: mirrors the user's saved data to the server so it
// follows the account across devices, browsers, the desktop app, and dev.
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
  'ft-portfolio-manager',          // Portfolio Manager equities
  'pm-options-v1',                 // Portfolio Manager options book
  'pm-futures-v1',                 // Portfolio Manager futures book
  'pmPortfolioName',               // Which book is open
  'pm-live-sparks',                // Live board sparkline choices
  'alerts',                        // Price Alerts
  'finance-terminal-dashboard-v3', // Dashboard layout
  'watchlist',                     // Watchlist
  'fdb_custom_strategies',         // Custom strategies
  'ft_nav_favorites',              // Pinned nav items
  'pe_wl',                         // Portfolio Earnings watchlist
  'fdb_report_creator_v1',         // Report Creator projects and clips
  'fdb_screener_saved_screens_v1', // Saved screens
  'ft_custom_metrics_v1',          // Formulas built in Fundamental Overlay
  'ft_recents',                    // Recently opened tools
  'ft_recent_tickers',             // Recently searched tickers
  'ft_cusip_recents',              // Recent CUSIP lookups
  'gm-favorites',                  // Global Markets favourites
  'unifiedOverlay2',               // Asset Overlay layout
  'flowsCockpit',                  // Flows map layout
  'ft_cusip_layout',               // CUSIP layout
  'screenerRailCollapsed',         // Screener rail state
  'mv-driver-view',                // Multiples driver view
  'ft_fundamental_groups_v1',      // Fundamental Overlay open groups
  'cs_main_height',                // Chart Studio pane height
  'cs_lane_heights',               // Chart Studio lane heights
  'ft_link_on',                    // Ticker linking toggle
]
// Keys whose name carries an id, so they cannot be listed one by one.
const ALLOW_PREFIXES = ['paper-overlays-', 'paper-chart-overlays-']
const ALLOW = new Set(ALLOWLIST)

/** Whether a key follows the account. Deliberately excluded: the session token,
 *  notification-permission flags, one-shot handoffs between tools, and the
 *  ft-portfolio blob, which has its own portfolio_json sync and must not have
 *  two writers. */
export function isSynced(key: string): boolean {
  return ALLOW.has(key) || ALLOW_PREFIXES.some(p => key.startsWith(p))
}

/** Local keys that sync but are not in the fixed list (the prefixed ones). */
function localPrefixed(): string[] {
  const out: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (k && ALLOW_PREFIXES.some(p => k.startsWith(p))) out.push(k)
  }
  return out
}

/** Device-only, deliberately not in the allowlist: when THIS browser last
 *  pushed is a fact about the browser, not about the account. */
export const LAST_SYNC_KEY = 'ft_last_sync'
export const SYNC_EVENT = 'ft:account-synced'

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
    // A token this server has never issued is not a transient failure. It is what
    // you get pointing a session at a different backend, which now happens every
    // time dev switches between the local API and production, and retrying it
    // just fills the console with 401s while the app looks half signed in.
    if (res.status === 401 || res.status === 403) {
      window.dispatchEvent(new Event('ft:session-rejected'))
      return false
    }
    if (!res.ok) return false
    serverData = ((await res.json()).data ?? {}) as Record<string, unknown>
  } catch {
    return false
  }

  let changed = false
  suppress = true
  try {
    for (const key of Object.keys(serverData)) {
      if (!isSynced(key)) continue
      const incoming = JSON.stringify(serverData[key])
      if (localStorage.getItem(key) !== incoming) {
        localStorage.setItem(key, incoming)
        changed = true
      }
    }
  } finally {
    suppress = false
  }

  // Seed the account from this device for keys the server doesn't have yet.
  const seed: Record<string, unknown> = {}
  for (const key of [...ALLOWLIST, ...localPrefixed()]) {
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
  try { localStorage.setItem(LAST_SYNC_KEY, new Date().toISOString()) } catch { /* quota */ }
  window.dispatchEvent(new Event(SYNC_EVENT))
  if (changed) window.dispatchEvent(new Event('ft:portfolio-context'))
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
  try { for (const key of [...ALLOWLIST, ...localPrefixed()]) localStorage.removeItem(key) } finally { suppress = false }
  window.dispatchEvent(new Event('ft:portfolio-context'))
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
  }).then(res => {
    // Something has to say the data left this browser. Without it, saving while
    // signed out looks identical to saving while signed in, and the difference
    // only shows up on the next device.
    if (res.ok) {
      try { localStorage.setItem(LAST_SYNC_KEY, new Date().toISOString()) } catch { /* quota */ }
      window.dispatchEvent(new Event(SYNC_EVENT))
    }
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
    if (!suppress && isSynced(key) && getAuth().uid) { dirty.add(key); schedule() }
  }
  localStorage.removeItem = (key: string) => {
    origRemove(key)
    if (!suppress && isSynced(key) && getAuth().uid) { dirty.add(key); schedule() }
  }
}
