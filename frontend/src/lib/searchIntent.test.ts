import { describe, it, expect } from 'vitest'
import { resolveIntents, extractTicker, intentUrl, INTENTS } from './searchIntent'

const top = (q: string) => resolveIntents(q)[0]

describe('extractTicker', () => {
  it('takes an explicitly capitalised symbol', () => {
    expect(extractTicker('AAPL implied volatility')).toBe('AAPL')
    expect(extractTicker('gamma exposure for NVDA')).toBe('NVDA')
  })

  it('does NOT treat a bare lowercase word as a ticker', () => {
    // The reported bug: typing a general query popped ticker shortcuts.
    for (const q of ['vol', 'chart', 'beta', 'gex', 'dcf', 'screen']) {
      expect(extractTicker(q)).toBeNull()
    }
  })

  it('does not pull a symbol out of ordinary search vocabulary', () => {
    expect(extractTicker('why is my portfolio down')).toBeNull()
    expect(extractTicker('what is priced in')).toBeNull()
  })

  it('still finds an unknown lowercase symbol', () => {
    expect(extractTicker('tsla seasonality')).toBe('TSLA')
    expect(extractTicker('aapl')).toBe('AAPL')
  })

  it('treats finance words shaped like symbols as words, not symbols', () => {
    for (const q of ['alpha', 'delta', 'yield', 'rates', 'bonds', 'cash']) {
      expect(extractTicker(q)).toBeNull()
    }
  })

  it('handles index and class symbols', () => {
    expect(extractTicker('^GSPC chart')).toBe('^GSPC')
    expect(extractTicker('BRK.B peers')).toBe('BRK.B')
  })
})

describe('resolveIntents', () => {
  it('routes a plain-language question to the tool that answers it', () => {
    expect(top('what is it worth').route).toBe('/master-valuation')
    expect(top('why is it dropping').route).toBe('/mover-radar')
    expect(top('unusual options flow').route).toBe('/options-scanner')
    expect(top('is the market open').route).toBe('/market-hours')
    expect(top('how risky is my portfolio').route).toBe('/portfolio-analysis')
  })

  it('prefers the more specific phrase', () => {
    expect(top('reverse dcf').route).toBe('/reverse-dcf')
    expect(top('dcf').route).toBe('/dcf')
    expect(top('implied volatility').route).toBe('/volatility-scanner')
  })

  it('carries the ticker to destinations that read one', () => {
    const m = top('AAPL implied volatility')
    expect(m.route).toBe('/volatility-scanner')
    expect(intentUrl(m)).toBe('/volatility-scanner?ticker=AAPL')
  })

  it('does not fabricate a ticker param for tools that ignore it', () => {
    const m = top('NVDA sector rotation')
    expect(m.route).toBe('/sector-rotation')
    expect(intentUrl(m)).toBe('/sector-rotation')
  })

  it('returns nothing for an empty or meaningless query', () => {
    expect(resolveIntents('')).toEqual([])
    expect(resolveIntents('   ')).toEqual([])
    expect(resolveIntents('zzzzqqq')).toEqual([])
  })

  it('every intent points at a real route', () => {
    for (const intent of INTENTS) {
      expect(intent.route.startsWith('/')).toBe(true)
      expect(intent.phrases.length).toBeGreaterThan(0)
    }
  })
})
