import { describe, expect, it, beforeEach } from 'vitest'
import {
  getSavedStrategies, saveStrategy, deleteSavedStrategy, renameSavedStrategy, savedStrategyTicker,
} from './savedStrategies'
import type { Leg } from './shared'

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

const leg = (over: Partial<Leg> = {}): Leg => ({
  option_type: 'call', action: 'buy', K: 100, premium: 2, quantity: 1, ticker: 'SPY', expiry: '2026-09-18', ...over,
})

describe('saved-strategy library', () => {
  beforeEach(() => store.clear())

  it('starts empty', () => {
    expect(getSavedStrategies()).toEqual([])
  })

  it('saves a strategy and returns it newest-first', () => {
    saveStrategy('Bull Call', [leg(), leg({ action: 'sell', K: 110 })], { SPY: 105 })
    saveStrategy('Long Put', [leg({ option_type: 'put' })], {})
    const list = getSavedStrategies()
    expect(list).toHaveLength(2)
    expect(list[0].name).toBe('Long Put')       // newest first
    expect(list[1].name).toBe('Bull Call')
    expect(list[1].legs).toHaveLength(2)
    expect(list[1].spotOverrides).toEqual({ SPY: 105 })
    expect(list[1].id).toBeTruthy()
    expect(list[1].savedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('deep-clones legs so later mutation does not leak in', () => {
    const legs = [leg()]
    saveStrategy('Snapshot', legs, {})
    legs[0].K = 999
    expect(getSavedStrategies()[0].legs[0].K).toBe(100)
  })

  it('falls back to a name when blank', () => {
    saveStrategy('   ', [leg()], {})
    expect(getSavedStrategies()[0].name).toBe('Untitled strategy')
  })

  it('deletes by id', () => {
    const a = saveStrategy('A', [leg()], {})
    saveStrategy('B', [leg()], {})
    deleteSavedStrategy(a.id)
    const list = getSavedStrategies()
    expect(list).toHaveLength(1)
    expect(list[0].name).toBe('B')
  })

  it('renames by id, ignoring a blank name', () => {
    const a = saveStrategy('Old', [leg()], {})
    renameSavedStrategy(a.id, 'New')
    expect(getSavedStrategies()[0].name).toBe('New')
    renameSavedStrategy(a.id, '   ')
    expect(getSavedStrategies()[0].name).toBe('New')  // blank ignored
  })

  it('tolerates corrupt storage', () => {
    store.set('ft_saved_option_strategies_v1', '{not json')
    expect(getSavedStrategies()).toEqual([])
  })

  it('summarizes distinct tickers', () => {
    const s = saveStrategy('Spread', [leg({ ticker: 'SPY' }), leg({ ticker: 'QQQ' }), leg({ ticker: 'SPY' })], {})
    expect(savedStrategyTicker(s)).toBe('SPY/QQQ')
  })
})
