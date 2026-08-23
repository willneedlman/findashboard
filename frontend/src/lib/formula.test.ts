import { describe, it, expect } from 'vitest'
import { compile, evaluate, series, lexicon, resultUnit, token } from './formula'

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
    expect(compile('revenue ebitda').error).toMatch(/missing operator/)
    expect(compile('revenue $ 2').error).toMatch(/unexpected character/)
  })

  it('rejects a field the dataset does not have', () => {
    const lex = lexicon([{ key: 'revenue', label: 'Revenue' }, { key: 'ebitda', label: 'EBITDA' }])
    expect(compile('revenue / ebitda', lex).ok).toBe(true)
    expect(compile('revenue / madeUpThing', lex).error).toMatch(/is not a field/)
  })

  it('names the field a near miss probably meant', () => {
    const lex = lexicon([{ key: 'revenue', label: 'Revenue' }, { key: 'netIncome', label: 'Net income' }])
    expect(compile('revenu / 2', lex).error).toMatch(/Did you mean Revenue\?/)
  })
})

// The interface calls a field "Share price" everywhere, so that has to be what
// the box accepts. Requiring `sharePrice` made it a guessing game.
describe('lexicon', () => {
  const FIELDS = [
    { key: 'sharePrice', label: 'Share price' },
    { key: 'netIncome', label: 'Net income' },
    { key: 'epsdiluted', label: 'EPS (diluted)' },
    { key: 'revenue', label: 'Revenue' },
    { key: 'costOfRevenue', label: 'Cost of revenue' },
  ]
  const lex = lexicon(FIELDS, { earnings: 'netIncome', eps: 'epsdiluted', cogs: 'costOfRevenue' })
  const P = { sharePrice: 250, netIncome: 100e9, epsdiluted: 6.25, revenue: 400e9, costOfRevenue: 220e9 }

  it('reads a multi-word label as one field', () => {
    expect(compile('share price / net income', lex).vars).toEqual(['sharePrice', 'netIncome'])
    expect(evaluate('share price / net income', P, lex)).toBeCloseTo(250 / 100e9, 12)
  })

  it('reads trade shorthand', () => {
    expect(evaluate('share price / earnings', { ...P, netIncome: 25 }, lex)).toBe(10)
    expect(evaluate('revenue - cogs', P, lex)).toBe(180e9)
  })

  it('still takes the raw keys a saved formula holds', () => {
    expect(evaluate('(revenue - costOfRevenue) / revenue', P, lex)).toBeCloseTo(0.45, 12)
  })

  it('takes the longest phrase, not the first word', () => {
    // "share price" must not tokenise as "share" followed by "price".
    expect(compile('share price', lex).vars).toEqual(['sharePrice'])
  })

  it('rejects a bare word that only exists inside a phrase', () => {
    expect(compile('share * 2', lex).error).toMatch(/is not a field/)
  })

  it('writes a label the box can actually parse', () => {
    expect(token('EPS (diluted)')).toBe('eps diluted')
    expect(compile(token('EPS (diluted)'), lex).vars).toEqual(['epsdiluted'])
    expect(compile(token('Share price'), lex).vars).toEqual(['sharePrice'])
  })

  it('flags two fields dragged in with no operator between them, by label', () => {
    expect(compile('share price net income', lex).error).toBe('missing operator before "Net income"')
  })
})

// Every saved metric used to be typed as a ratio, so a formula that just adds
// two dollar figures got a ratio axis and ratio formatting.
describe('resultUnit', () => {
  const UNITS: Record<string, string> = {
    revenue: '$', costOfRevenue: '$', enterpriseValue: '$', sharePrice: '$/sh',
    epsdiluted: '$/sh', shares: 'sh',
  }
  const u = (expr: string) => resultUnit(expr, k => UNITS[k])

  it('keeps the unit through addition and subtraction', () => {
    expect(u('revenue - costOfRevenue')).toBe('$')
    expect(u('-revenue')).toBe('$')
  })

  it('cancels like units to a plain number', () => {
    expect(u('revenue / enterpriseValue')).toBe('x')
    expect(u('sharePrice / epsdiluted')).toBe('x')
  })

  it('does the per-share algebra', () => {
    expect(u('revenue / shares')).toBe('$/sh')
    expect(u('epsdiluted * shares')).toBe('$')
  })

  it('scales by a plain number without changing the unit', () => {
    expect(u('revenue * 2')).toBe('$')
    expect(u('revenue * 20%')).toBe('$')
  })

  it('refuses to name a unit it cannot work out', () => {
    expect(u('revenue + sharePrice')).toBeNull()   // dollars plus dollars-per-share
    expect(u('sharePrice / revenue')).toBeNull()   // per-share over whole-company
    expect(u('revenue * revenue')).toBeNull()      // dollars squared
    expect(u('unknownThing / 2')).toBeNull()
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


// Pinning a field to a fiscal year, so the two halves of a ratio can come from
// different years: price today over what FY2026 is expected to earn.
describe('fiscal-year pinning', () => {
  const lex = lexicon([
    { key: 'revenue', label: 'Revenue' },
    { key: 'epsEstimate', label: 'EPS (est)' },
    { key: 'enterpriseValue', label: 'Enterprise value' },
    { key: 'sharePrice', label: 'Share price' },
  ], { eps: 'epsEstimate' })
  const BY_YEAR = {
    2025: { revenue: 400e9, epsEstimate: 7.5, enterpriseValue: 4.0e12, sharePrice: 250 },
    2026: { revenue: 470e9, epsEstimate: 8.8, enterpriseValue: 4.6e12, sharePrice: 300 },
  }
  const row = { revenue: 300e9, epsEstimate: 6.0, enterpriseValue: 3e12, sharePrice: 200 }

  it('reads the pinned year rather than the row', () => {
    expect(evaluate('revenue fy2025', row, lex, BY_YEAR)).toBe(400e9)
    expect(evaluate('revenue fy26', row, lex, BY_YEAR)).toBe(470e9)
    expect(evaluate('revenue f25', row, lex, BY_YEAR)).toBe(400e9)
    expect(evaluate('revenue 2026', row, lex, BY_YEAR)).toBe(470e9)
  })

  it("mixes a pinned year with the row's own value", () => {
    // Price moves row by row; the earnings it is divided by do not.
    expect(evaluate('share price / eps fy26', row, lex, BY_YEAR))
      .toBeCloseTo(200 / 8.8, 8)
  })

  it('takes two different years in one expression', () => {
    expect(evaluate('revenue fy26 / revenue fy2025', row, lex, BY_YEAR))
      .toBeCloseTo(470 / 400, 8)
  })

  it("a year the data does not have is a gap, not the row's year", () => {
    expect(evaluate('revenue fy2019', row, lex, BY_YEAR)).toBeNull()
    expect(evaluate('revenue fy2019 / 2', row, lex, BY_YEAR)).toBeNull()
  })

  it('does not read a bare small number as a year', () => {
    // "revenue 2" is a missing operator, not FY2002.
    expect(compile('revenue 2', lex).error).toMatch(/missing operator/)
  })

  it('keeps the unit of the underlying field', () => {
    const units: Record<string, string> = { revenue: '$', enterpriseValue: '$', sharePrice: '$/sh' }
    expect(resultUnit('revenue fy25 / enterprise value', k => units[k], lex)).toBe('x')
    expect(resultUnit('revenue fy25 - revenue fy26', k => units[k], lex)).toBe('$')
  })

  it('validates the field half and names a near miss', () => {
    expect(compile('revenu fy25', lex).error).toMatch(/Did you mean Revenue\?/)
    expect(compile('revenue fy25', lex).ok).toBe(true)
  })
})
