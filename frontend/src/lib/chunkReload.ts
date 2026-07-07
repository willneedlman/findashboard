import { lazy, type ComponentType } from 'react'

// A new deploy rotates the content-hashed chunk filenames, so a tab still
// running the previous index.html requests assets that no longer exist. This
// shows up as a dynamic-import failure the moment the user navigates to a tool
// whose chunk has not been loaded yet (the classic "switch tabs after idle"
// error). Reload once to pull the fresh manifest.

const RELOAD_KEY = 'at-chunk-reload-at'

export function isChunkLoadError(error: unknown): boolean {
  const e = error as { name?: string; message?: string } | null
  const msg = e?.message || ''
  return (
    e?.name === 'ChunkLoadError' ||
    /failed to fetch dynamically imported module|importing a module script failed|error loading dynamically imported module|dynamically imported module/i.test(msg)
  )
}

// Reload at most once per 10s window so a genuinely-unreachable asset (rollback,
// CDN miss) surfaces a real error instead of a reload storm.
export function reloadForChunkError(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) || 0)
    if (Date.now() - last > 10_000) {
      sessionStorage.setItem(RELOAD_KEY, String(Date.now()))
      window.location.reload()
      return true
    }
  } catch { /* sessionStorage unavailable */ }
  return false
}

// Drop-in for React.lazy that recovers from stale-chunk failures at the import
// site: on a chunk error it triggers the one-shot reload and returns a
// never-resolving promise, so Suspense keeps showing its normal fallback
// (spinner) until the page reloads — no error card flash. Non-chunk errors and
// reloads suppressed by the guard fall through to the ErrorBoundary.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors React.lazy's own constraint; ComponentType<unknown> rejects components with props
export function lazyWithReload<T extends ComponentType<any>>(
  factory: () => Promise<{ default: T }>,
) {
  return lazy(() =>
    factory().catch((err) => {
      if (isChunkLoadError(err) && reloadForChunkError()) {
        return new Promise<{ default: T }>(() => { /* hold Suspense until reload */ })
      }
      throw err
    }),
  )
}
