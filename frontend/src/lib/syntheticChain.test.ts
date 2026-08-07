import { describe, it, expect } from 'vitest'
import { syntheticChain, syntheticChains, syntheticExpiries, syntheticSpot } from './syntheticChain'

describe('syntheticChain', () => {
  it('is deterministic for the same ticker and expiry', () => {
    const a = syntheticChain('SPY', '2026-08-07')
    const b = syntheticChain('SPY', '2026-08-07')
    expect(a).toEqual(b)
  })

  it('gives different books to different expiries', () => {
    const a = syntheticChain('SPY', '2026-08-07')
    const b = syntheticChain('SPY', '2026-08-14')
    expect(a.calls.map(c => c.volume)).not.toEqual(b.calls.map(c => c.volume))
  })

  it('brackets spot with equal call and put ladders', () => {
    const c = syntheticChain('NVDA', '2026-08-07', 41)
    expect(c.calls).toHaveLength(41)
    expect(c.puts).toHaveLength(41)
    expect(Math.min(...c.calls.map(x => x.strike))).toBeLessThan(c.spot)
    expect(Math.max(...c.calls.map(x => x.strike))).toBeGreaterThan(c.spot)
  })

  it('quotes a positive spread with the bid under the ask', () => {
    const c = syntheticChain('AAPL', '2026-08-07')
    for (const x of [...c.calls, ...c.puts]) {
      expect(x.ask).toBeGreaterThan(x.bid)
      expect(x.bid).toBeGreaterThanOrEqual(0)
      expect(x.impliedVolatility).toBeGreaterThan(0)
      expect(x.openInterest).toBeGreaterThanOrEqual(0)
      expect(x.volume).toBeGreaterThanOrEqual(0)
    }
  })

  it('prices calls above intrinsic value', () => {
    const c = syntheticChain('SPY', '2026-08-14')
    for (const x of c.calls) {
      const intrinsic = Math.max(0, c.spot - x.strike)
      expect(x.ask).toBeGreaterThanOrEqual(intrinsic - 0.02)
    }
  })

  it('leaves contracts that clear the unusual screen', () => {
    // The demo is pointless if the flow pane is always empty.
    const cleared = syntheticChains('SPY', 3).flatMap(ch =>
      [...ch.calls, ...ch.puts].filter(x =>
        x.volume >= 300 && (x.openInterest > 0 ? x.volume / x.openInterest >= 1.5 : true)),
    )
    expect(cleared.length).toBeGreaterThan(0)
  })

  it('peaks open interest near the money', () => {
    const c = syntheticChain('SPY', '2026-08-21')
    const near = c.calls.filter(x => Math.abs(x.strike - c.spot) / c.spot < 0.02)
    const far = c.calls.filter(x => Math.abs(x.strike - c.spot) / c.spot > 0.08)
    const avg = (l: typeof near) => l.reduce((s, x) => s + x.openInterest, 0) / Math.max(1, l.length)
    expect(avg(near)).toBeGreaterThan(avg(far))
  })

  it('gives an unknown ticker a stable price instead of a default', () => {
    expect(syntheticSpot('ZZQQ')).toBe(syntheticSpot('ZZQQ'))
    expect(syntheticSpot('ZZQQ')).not.toBe(syntheticSpot('YYWW'))
    expect(syntheticSpot('SPY')).toBe(768)
  })

  it('returns weekday expiries in ascending order', () => {
    const exps = syntheticExpiries(6, new Date('2026-08-06T12:00:00'))
    expect(exps).toHaveLength(6)
    expect([...exps].sort()).toEqual(exps)
    for (const e of exps) {
      const day = new Date(`${e}T00:00:00`).getDay()
      expect(day).not.toBe(0)
      expect(day).not.toBe(6)
    }
  })
})
