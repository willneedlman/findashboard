import { describe, expect, it } from 'vitest'
import {
  buildOvernightUniverse, earningsCause, crossedGammaFlip, sortByAbsMove,
  type OvernightRow, type EarningsRow,
} from './overnightMoves'

describe('buildOvernightUniverse', () => {
  it('dedupes, uppercases, and prioritizes book over watchlist', () => {
    const out = buildOvernightUniverse(['nvda', 'AAPL'], ['aapl', 'msft'])
    expect(out).toEqual(['NVDA', 'AAPL', 'MSFT'])
  })

  it('caps the total universe size', () => {
    const book = Array.from({ length: 5 }, (_, i) => `B${i}`)
    const watch = Array.from({ length: 5 }, (_, i) => `W${i}`)
    expect(buildOvernightUniverse(book, watch, 7)).toHaveLength(7)
  })
})

describe('earningsCause', () => {
  const rows: EarningsRow[] = [
    { symbol: 'NFLX', date: '2026-07-19', hour: 'amc' },
    { symbol: 'AAPL', date: '2026-07-20', hour: 'bmo' },
    { symbol: 'MSFT', date: '2026-07-20', hour: 'amc' },
    { symbol: 'NVDA', date: '2026-07-22', hour: 'bmo' },
    { symbol: 'TSLA', date: '2026-08-01', hour: 'bmo' },
  ]
  const from = new Date('2026-07-20T12:00:00')

  it('flags a name that reported AMC yesterday', () => {
    expect(earningsCause('nflx', rows, from)).toEqual({ kind: 'reported-amc-yesterday' })
  })

  it('flags a name reporting BMO today', () => {
    expect(earningsCause('AAPL', rows, from)).toEqual({ kind: 'reports-bmo-today' })
  })

  it('flags a name reporting AMC today', () => {
    expect(earningsCause('MSFT', rows, from)).toEqual({ kind: 'reports-amc-today' })
  })

  it('flags a name reporting within the next few days', () => {
    expect(earningsCause('NVDA', rows, from)).toEqual({ kind: 'reports-soon', days: 2 })
  })

  it('returns null when earnings are too far out or the ticker is untracked', () => {
    expect(earningsCause('TSLA', rows, from)).toBeNull()
    expect(earningsCause('SPY', rows, from)).toBeNull()
  })
})

describe('crossedGammaFlip', () => {
  it('detects a cross from below to above the flip level', () => {
    expect(crossedGammaFlip(195, 205, 200)).toBe(true)
  })

  it('detects a cross from above to below the flip level', () => {
    expect(crossedGammaFlip(205, 195, 200)).toBe(true)
  })

  it('is false when price stays on the same side of the flip', () => {
    expect(crossedGammaFlip(202, 205, 200)).toBe(false)
  })

  it('is false when any input is missing', () => {
    expect(crossedGammaFlip(null, 205, 200)).toBe(false)
    expect(crossedGammaFlip(195, null, 200)).toBe(false)
    expect(crossedGammaFlip(195, 205, undefined)).toBe(false)
  })
})

describe('sortByAbsMove', () => {
  it('orders by absolute change, largest first, dropping rows with no move yet', () => {
    const rows: OvernightRow[] = [
      { ticker: 'A', priorClose: 100, last: 101, changePct: 1 },
      { ticker: 'B', priorClose: 100, last: 94, changePct: -6 },
      { ticker: 'C', priorClose: 100, last: 100, changePct: null },
      { ticker: 'D', priorClose: 100, last: 103, changePct: 3 },
    ]
    expect(sortByAbsMove(rows).map(r => r.ticker)).toEqual(['B', 'D', 'A'])
  })
})
