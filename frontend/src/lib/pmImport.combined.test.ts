import { describe, expect, it, beforeEach } from 'vitest'
import { combinedOverviewBook, readActivePortfolioContext, readPMBooks, COMBINED_BOOK_ID } from './pmImport'

const store = new Map<string, string>()
const ls = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, v) },
  removeItem: (k: string) => { store.delete(k) },
  clear: () => { store.clear() },
  key: () => null,
  get length() { return store.size },
}
Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true })

const port = (id: string, name: string, holdings: { ticker: string; shares: number; avgCost: number }[]) =>
  ({ id, name, holdings, cash: [], options: [], futures: [] })

function seed(portfolios: unknown[], overviewIds?: string[]) {
  store.set('pm-portfolios-v2', JSON.stringify({ portfolios, activeId: (portfolios[0] as any)?.id, overviewIds }))
}

describe('combined overview book', () => {
  beforeEach(() => store.clear())

  it('returns null with fewer than two portfolios', () => {
    seed([port('a', 'A', [{ ticker: 'AAPL', shares: 10, avgCost: 100 }])])
    expect(combinedOverviewBook()).toBeNull()
    expect(readPMBooks().map(b => b.id)).toEqual(['a'])   // no synthetic book
  })

  it('aggregates all portfolios when no explicit selection', () => {
    seed([
      port('a', 'A', [{ ticker: 'AAPL', shares: 10, avgCost: 100 }]),
      port('b', 'B', [{ ticker: 'AAPL', shares: 5, avgCost: 130 }, { ticker: 'MSFT', shares: 4, avgCost: 200 }]),
    ])
    const c = combinedOverviewBook()!
    expect(c.id).toBe(COMBINED_BOOK_ID)
    expect(c.name).toBe('Combined · 2 portfolios')
    const aapl = c.holdings.find(h => h.ticker === 'AAPL')!
    expect(aapl.shares).toBe(15)
    expect(aapl.avgCost).toBeCloseTo((10 * 100 + 5 * 130) / 15)   // share-weighted
    expect(c.holdings.find(h => h.ticker === 'MSFT')!.shares).toBe(4)
  })

  it('prepends the combined book in readPMBooks', () => {
    seed([
      port('a', 'A', [{ ticker: 'AAPL', shares: 10, avgCost: 100 }]),
      port('b', 'B', [{ ticker: 'MSFT', shares: 4, avgCost: 200 }]),
    ])
    const ids = readPMBooks().map(b => b.id)
    expect(ids[0]).toBe(COMBINED_BOOK_ID)
    expect(ids.slice(1)).toEqual(['a', 'b'])
  })

  it('honors an explicit 2+ overview selection', () => {
    seed([
      port('a', 'A', [{ ticker: 'AAPL', shares: 10, avgCost: 100 }]),
      port('b', 'B', [{ ticker: 'MSFT', shares: 4, avgCost: 200 }]),
      port('c', 'C', [{ ticker: 'NVDA', shares: 2, avgCost: 500 }]),
    ], ['a', 'c'])
    const c = combinedOverviewBook()!
    expect(c.name).toBe('Combined · 2 portfolios')
    expect(c.holdings.map(h => h.ticker).sort()).toEqual(['AAPL', 'NVDA'])   // B excluded
  })

  it('falls back to all when the selection is a single portfolio', () => {
    seed([
      port('a', 'A', [{ ticker: 'AAPL', shares: 10, avgCost: 100 }]),
      port('b', 'B', [{ ticker: 'MSFT', shares: 4, avgCost: 200 }]),
    ], ['a'])
    expect(combinedOverviewBook()!.holdings.map(h => h.ticker).sort()).toEqual(['AAPL', 'MSFT'])
  })

  it('publishes the explicit terminal-wide active selection', () => {
    seed([
      port('a', 'Long-term', [{ ticker: 'AAPL', shares: 10, avgCost: 100 }]),
      port('b', 'Trading', [{ ticker: 'MSFT', shares: 4, avgCost: 200 }]),
    ], ['b'])
    const active = readActivePortfolioContext()
    expect(active.name).toBe('Trading')
    expect(active.portfolioIds).toEqual(['b'])
    expect(active.holdings.map(h => h.ticker)).toEqual(['MSFT'])
    expect(active.isCombined).toBe(false)
  })

  it('publishes complete option positions for automated report research', () => {
    seed([{
      ...port('a', 'Options', [{ ticker: 'AAPL', shares: 10, avgCost: 100 }]),
      options: [{
        id: 'opt-1', underlying: 'NVDA', name: 'Long Call',
        legs: [{ type: 'call', side: 'long', strike: 200, expiry: '2026-09-18', contracts: 2, avgPremium: 12 }],
      }],
    }])

    const active = readActivePortfolioContext()

    expect(active.optionsCount).toBe(1)
    expect(active.optionPositions?.[0]).toMatchObject({ underlying: 'NVDA', name: 'Long Call' })
  })

  it('merges the terminal-wide context when several books are selected', () => {
    seed([
      port('a', 'A', [{ ticker: 'AAPL', shares: 10, avgCost: 100 }]),
      port('b', 'B', [{ ticker: 'AAPL', shares: 5, avgCost: 130 }]),
    ], ['a', 'b'])
    const active = readActivePortfolioContext()
    expect(active.id).toBe(COMBINED_BOOK_ID)
    expect(active.isCombined).toBe(true)
    expect(active.holdings[0].shares).toBe(15)
  })
})
