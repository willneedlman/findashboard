import { describe, it, expect } from 'vitest'
import { compile, evaluate, series } from './formula'

const AAPL = {
  revenue: 416_161e6, costOfRevenue: 220_998e6, capitalExpenditure: 12_700e6,
  enterpriseValue: 4_122_800e6, ebitda: 144_750e6, netDebt: 54_744e6, netIncome: 112_010e6,
}

describe('evaluate', () => {
  it('computes the multiple from the brief', () => {
    const v = evaluate('(revenue - costOfRevenue - capitalExpenditure) / enterpriseValue', AAPL)!
    expect(v).toBeCloseTo((416_161 - 220_998 - 12_700) / 4_122_800, 6)
  })

  it('honours precedence and parentheses', () => {
    expect(evaluate('2 + 3 * 4', {})).toBe(14)
    expect(evaluate('(2 + 3) * 4', {})).toBe(20)
    expect(evaluate('2 ^ 3 ^ 2', {})).toBe(512)     // right associative
  })

  it('handles unary minus anywhere it can legally appear', () => {
    expect(evaluate('-5', {})).toBe(-5)
    expect(evaluate('3 * -2', {})).toBe(-6)
    expect(evaluate('-(2 + 3)', {})).toBe(-5)
    expect(evaluate('10 - -5', {})).toBe(15)
  })

  it('reads a trailing percent as a fraction', () => {
    expect(evaluate('revenue * 20%', { revenue: 100 })).toBeCloseTo(20)
  })

  it('returns a GAP, never a zero, when an input is missing', () => {
    // A zero here would read as a real reported figure on the chart.
    expect(evaluate('revenue / ebitda', { revenue: 100, ebitda: null })).toBeNull()
    expect(evaluate('revenue / ebitda', { revenue: 100 })).toBeNull()
    expect(evaluate('revenue / ebitda', { revenue: 100, ebitda: NaN })).toBeNull()
  })

  it('treats division by zero as a gap rather than Infinity', () => {
    expect(evaluate('revenue / enterpriseValue', { revenue: 100, enterpriseValue: 0 })).toBeNull()
  })

  it('never executes anything', () => {
    // The expression is saved to localStorage, so it is untrusted input.
    for (const bad of ['constructor', 'process.exit(1)', 'alert(1)', '__proto__', 'a;b']) {
      expect(() => evaluate(bad, {})).not.toThrow()
    }
    expect(evaluate('constructor', {})).toBeNull()
  })
})

describe('compile', () => {
  it('reports the fields a formula uses, in order', () => {
    expect(compile('revenue / ebitda').vars).toEqual(['revenue', 'ebitda'])
    expect(compile('revenue - revenue').vars).toEqual(['revenue'])
  })

  it('rejects malformed input with a reason', () => {
    expect(compile('').error).toMatch(/empty/)
    expect(compile('(revenue').error).toMatch(/parenthes/)
    expect(compile('revenue)').error).toMatch(/parenthes/)
    expect(compile('revenue +').error).toMatch(/incomplete/)
    expect(compile('revenue ebitda').error).toMatch(/incomplete/)
    expect(compile('revenue $ 2').error).toMatch(/unexpected character/)
  })

  it('rejects a field the dataset does not have', () => {
    const known = new Set(['revenue', 'ebitda'])
    expect(compile('revenue / ebitda', known).ok).toBe(true)
    expect(compile('revenue / madeUpThing', known).error).toMatch(/unknown field/)
  })
})

describe('series', () => {
  it('keeps a gap in the years an input is missing', () => {
    const periods = [
      { revenue: 100, ebitda: 20 },
      { revenue: 120, ebitda: null },
      { revenue: 150, ebitda: 30 },
    ]
    expect(series('revenue / ebitda', periods)).toEqual([5, null, 5])
  })
})
