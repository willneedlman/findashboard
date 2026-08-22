import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest'

// A synced account arrived with its first book renamed "Default".
//
// Portfolio Manager fabricates {id:'default', name:'Default'} when nothing is
// stored, and its persist effect used to write that on mount. On a device where
// the account pull lands first, the placeholder overwrote the real books, and
// the reload that follows a successful pull then read the placeholder back.
//
// This drives the sequence rather than the component: what matters is that a
// mount-time write cannot land on top of hydrated data.

const store = new Map<string, string>()
const rawSet = (k: string, v: string) => { store.set(k, v) }
const ls = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: rawSet,
  removeItem: (k: string) => { store.delete(k) },
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() { return store.size },
}
Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true })

const KEY = 'pm-portfolios-v2'
const ACCOUNT = {
  activeId: 'p-real',
  portfolios: [
    { id: 'p-real', name: 'Core Book', holdings: [{ ticker: 'AAPL', shares: 30 }] },
    { id: 'p-spec', name: 'Speculative', holdings: [{ ticker: 'NVDA', shares: 5 }] },
  ],
}
const PLACEHOLDER = { activeId: 'default', portfolios: [{ id: 'default', name: 'Default', holdings: [] }] }

/** The persist effect, as it now behaves: nothing on the first run. */
function persistEffect(mounted: { current: boolean }, state: unknown) {
  if (!mounted.current) { mounted.current = true; return }
  localStorage.setItem(KEY, JSON.stringify(state))
}

const names = () => JSON.parse(localStorage.getItem(KEY)!).portfolios.map((p: { name: string }) => p.name)

describe('a hydrated account survives Portfolio Manager mounting', () => {
  beforeEach(() => { store.clear() })

  it('keeps the account names when the pull lands before the page mounts', () => {
    localStorage.setItem(KEY, JSON.stringify(ACCOUNT))   // the pull
    persistEffect({ current: false }, PLACEHOLDER)       // the page mounts with its placeholder
    expect(names()).toEqual(['Core Book', 'Speculative'])
  })

  it('still persists a real edit', () => {
    localStorage.setItem(KEY, JSON.stringify(ACCOUNT))
    const mounted = { current: false }
    persistEffect(mounted, ACCOUNT)                      // mount, writes nothing
    const renamed = { ...ACCOUNT, portfolios: [{ ...ACCOUNT.portfolios[0], name: 'Renamed' }, ACCOUNT.portfolios[1]] }
    persistEffect(mounted, renamed)                      // the user renames one
    expect(names()).toEqual(['Renamed', 'Speculative'])
  })

  it('a first-time device with nothing stored writes nothing on mount', () => {
    persistEffect({ current: false }, PLACEHOLDER)
    // No phantom book on disk means nothing for a later pull to fight with, and
    // nothing for the account to be seeded from.
    expect(localStorage.getItem(KEY)).toBeNull()
  })
})
