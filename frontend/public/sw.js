/* Alphatape service worker — instant repeat loads.
 *
 * Strategy, aligned with the server's Cache-Control policy (backend/main.py):
 *   /assets/*     content-hashed + `immutable` → cache-first. The filename
 *                 changes on every deploy, so a cached entry is never stale; the
 *                 repeat load skips the network entirely (the "instant" win).
 *   navigations   the SPA HTML shell is served `no-cache` so deploys are picked
 *                 up → network-first, falling back to the cached shell only when
 *                 offline. Never cache-first here, or a deploy can't roll out.
 *   /api/*        network-only (never touched) — auth'd and time-sensitive.
 *   cross-origin  ignored (Google Fonts etc. use the browser HTTP cache).
 *
 * Bump CACHE_VERSION to drop old runtime caches on the next activate.
 */
const CACHE_VERSION = 'v1'
const ASSET_CACHE = `at-assets-${CACHE_VERSION}`
const SHELL_CACHE = `at-shell-${CACHE_VERSION}`
const KEEP = new Set([ASSET_CACHE, SHELL_CACHE])

self.addEventListener('install', () => {
  // Activate the new worker immediately; activate() prunes stale caches.
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys()
    await Promise.all(keys.filter((k) => !KEEP.has(k)).map((k) => caches.delete(k)))
    await self.clients.claim()
  })())
})

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName)
  const hit = await cache.match(request)
  if (hit) return hit
  const res = await fetch(request)
  if (res && res.ok) cache.put(request, res.clone())
  return res
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName)
  try {
    const res = await fetch(request)
    if (res && res.ok) cache.put(request, res.clone())
    return res
  } catch (err) {
    const cached = (await cache.match(request)) || (await cache.match('/app')) || (await cache.match('/'))
    if (cached) return cached
    throw err
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return   // cross-origin: browser cache
  if (url.pathname.startsWith('/api/')) return       // never cache the API

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(request, ASSET_CACHE))
    return
  }
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, SHELL_CACHE))
  }
})
