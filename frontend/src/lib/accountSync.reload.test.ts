import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest'

// Opening a tool reloaded the page about once a second.
//
// sync() reloads when the pull changed anything locally, on the assumption that
// hydration leaves local equal to server so it cannot repeat. That held for the
// original allowlist. It stopped holding when keys the app REWRITES ON MOUNT
// joined it: opening a tool records it in ft_recents, which now differs from
// the server copy, so the next pull overwrites it, reports a change, and
// reloads, and the freshly mounted page records it again.

const store = new Map<string, string>()
const rawSet = (k: string, v: string) => { store.set(k, v) }
const rawRemove = (k: string) => { store.delete(k) }
const ls = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: rawSet, removeItem: rawRemove,
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() { return store.size },
}
Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true })
const listeners = new Map<string, Set<() => void>>()
Object.defineProperty(globalThis, 'window', {
  value: {
    localStorage: ls,
    addEventListener: (t: string, fn: () => void) => {
      if (!listeners.has(t)) listeners.set(t, new Set()); listeners.get(t)!.add(fn)
    },
    removeEventListener: (t: string, fn: () => void) => listeners.get(t)?.delete(fn),
    dispatchEvent: (e: Event) => { listeners.get(e.type)?.forEach(f => f()); return true },
  },
  configurable: true,
})
class E { type: string; constructor(t: string) { this.type = t } }
Object.defineProperty(globalThis, 'Event', { value: E, configurable: true })

function mockFetch(serverData: Record<string, unknown>) {
  globalThis.fetch = vi.fn(async (_u: string, init?: RequestInit) => {
    if (init?.method === 'PUT') return { ok: true, status: 200 } as Response
    return { ok: true, status: 200, json: async () => ({ data: serverData }) } as Response
  }) as unknown as typeof fetch
}

describe('a pull does not put the page in a reload loop', () => {
  beforeEach(() => { store.clear(); listeners.clear(); ls.setItem = rawSet; ls.removeItem = rawRemove })
  afterEach(() => vi.restoreAllMocks())

  it('reports view state separately from saved work', async () => {
    vi.resetModules()
    // The server holds an older recents list; this device just recorded a visit.
    mockFetch({ ft_recents: ['/older'], 'pm-portfolios-v2': { portfolios: [] } })
    localStorage.setItem('ft_recents', JSON.stringify(['/fundamental-overlay']))
    localStorage.setItem('pm-portfolios-v2', JSON.stringify({ portfolios: [] }))
    const m = await import('./accountSync')
    const changed = await m.sync('u1', 't')

    // The pull did change something, but only a recents list.
    expect(Array.isArray(changed)).toBe(true)
    expect(changed).toContain('ft_recents')
    // Nothing a mounted page needs re-read from disk changed, so the caller has
    // a basis to not reload. That is the difference between a settling sync and
    // a page that reloads every second.
    expect(m.worthReloading(changed as string[])).toBe(false)
  })

  it('still reloads when the account brings work this device did not have', async () => {
    vi.resetModules()
    mockFetch({ 'pm-portfolios-v2': { portfolios: [{ id: 'p', name: 'Real' }] } })
    const m = await import('./accountSync')
    const changed = await m.sync('u1', 't') as string[]
    expect(changed).toContain('pm-portfolios-v2')
    expect(m.worthReloading(changed)).toBe(true)
  })
})
