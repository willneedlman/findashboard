import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest'

// The failure this pins: update a book on the live site, open the app, and the
// book disappears from the app, the site and localhost at once.
//
// Portfolio Manager writes its state to localStorage on mount. A surface that
// mounts before the account's pull lands therefore persists an EMPTY book, the
// patched setItem queues it, and a second later that empty payload overwrites
// the account. Every other device then pulls the emptiness.

const store = new Map<string, string>()
// startAutoPush wraps setItem/removeItem. Each module reload wraps them AGAIN,
// so without restoring the originals every test the previous test's module
// instance keeps firing with its own state and the assertions measure the
// harness rather than the code.
const rawSet = (k: string, v: string) => { store.set(k, v) }
const rawRemove = (k: string) => { store.delete(k) }
const ls = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: rawSet,
  removeItem: rawRemove,
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
    dispatchEvent: (e: Event) => { listeners.get(e.type)?.forEach(fn => fn()); return true },
  },
  configurable: true,
})
class E { type: string; constructor(t: string) { this.type = t } }
Object.defineProperty(globalThis, 'Event', { value: E, configurable: true })

const BOOK = { portfolios: [{ id: 'p1', name: 'Real', holdings: [{ ticker: 'AAPL', shares: 30 }] }] }
const EMPTY = { portfolios: [], activeId: '' }

let puts: { body: Record<string, unknown> }[] = []
let getStatus = 200
let getData: Record<string, unknown> = {}

function installFetch() {
  puts = []
  globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      puts.push({ body: JSON.parse(String(init.body)).data })
      return { ok: true, status: 200 } as Response
    }
    return {
      ok: getStatus === 200,
      status: getStatus,
      json: async () => ({ data: getData }),
    } as Response
  }) as unknown as typeof fetch
}

async function load() {
  vi.resetModules()
  return await import('./accountSync')
}

describe('a device that has not read the account cannot write to it', () => {
  beforeEach(() => {
    store.clear(); listeners.clear()
    ls.setItem = rawSet; ls.removeItem = rawRemove
    getStatus = 200; getData = {}; installFetch(); vi.useFakeTimers()
  })
  afterEach(() => { vi.useRealTimers() })

  it('does not push a mount-time empty book before the pull lands', async () => {
    const m = await load()
    m.startAutoPush(() => ({ uid: 'u1', token: 't' }))
    // Portfolio Manager mounting: persists whatever it loaded, which is nothing.
    localStorage.setItem('pm-portfolios-v2', JSON.stringify(EMPTY))
    await vi.advanceTimersByTimeAsync(5000)
    expect(puts, 'an unread account must not be overwritten').toHaveLength(0)
  })

  it('pushes the real book once the pull has landed, not the empty one', async () => {
    getData = { 'pm-portfolios-v2': BOOK }
    const m = await load()
    m.startAutoPush(() => ({ uid: 'u1', token: 't' }))
    localStorage.setItem('pm-portfolios-v2', JSON.stringify(EMPTY))   // mount-time default
    await m.sync('u1', 't')                                            // pull arrives
    await vi.advanceTimersByTimeAsync(5000)

    // The local copy is the account's book...
    expect(JSON.parse(localStorage.getItem('pm-portfolios-v2')!)).toEqual(BOOK)
    // ...and anything that did go up carried the book, never the emptiness.
    for (const p of puts) {
      if ('pm-portfolios-v2' in p.body) expect(p.body['pm-portfolios-v2']).toEqual(BOOK)
    }
  })

  it('a refused session never pushes at all', async () => {
    getStatus = 401
    const m = await load()
    m.startAutoPush(() => ({ uid: 'u1', token: 'stale' }))
    const ok = await m.sync('u1', 'stale')
    expect(ok).toBe(false)
    expect(m.sessionWasRefused()).toBe(true)
    localStorage.setItem('pm-portfolios-v2', JSON.stringify(EMPTY))
    await vi.advanceTimersByTimeAsync(5000)
    expect(puts).toHaveLength(0)
  })

  it('a refusal is distinguishable from a clean logout', async () => {
    getData = { 'pm-portfolios-v2': BOOK }
    const m = await load()
    await m.sync('u1', 't')
    expect(m.sessionWasRefused()).toBe(false)
  })

  it('logging out stops the account being written to again', async () => {
    getData = { 'pm-portfolios-v2': BOOK }
    const m = await load()
    m.startAutoPush(() => ({ uid: 'u1', token: 't' }))
    await m.sync('u1', 't')
    m.reset()                                   // what logout calls
    localStorage.setItem('pm-portfolios-v2', JSON.stringify(EMPTY))
    await vi.advanceTimersByTimeAsync(5000)
    expect(puts.some(p => 'pm-portfolios-v2' in p.body && !(p.body['pm-portfolios-v2'] as { portfolios: unknown[] }).portfolios.length)).toBe(false)
  })
})
