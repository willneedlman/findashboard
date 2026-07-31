import { describe, expect, it } from 'vitest'
import { parseChartDirective, parseOverlays, parseWindow } from './researchDirective'

describe('resolving a planner directive', () => {
  it('reads the example the planner is told to write', () => {
    const got = parseChartDirective('chart it against SPY with 50 and 200 day moving averages and RSI', ['NVDA'])
    expect(got.indicators.map(i => i.label)).toEqual(['SMA 50', 'SMA 200', 'RSI 14'])
    expect(got.overlays).toEqual(['SPY'])
  })

  it('keeps one phrase from swallowing several periods', () => {
    expect(parseChartDirective('add 20, 50 and 200 day SMAs').indicators.map(i => i.period))
      .toEqual([20, 50, 200])
  })

  it('does not let the generic moving-average rule eat the exponential one', () => {
    const got = parseChartDirective('overlay a 21 day exponential moving average')
    expect(got.indicators).toEqual([{ kind: 'ema', period: 21, label: 'EMA 21' }])
  })

  it('defaults a period when none is given', () => {
    expect(parseChartDirective('show RSI').indicators[0]).toEqual({ kind: 'rsi', period: 14, label: 'RSI 14' })
    expect(parseChartDirective('add bollinger bands').indicators[0].period).toBe(20)
  })

  it('never overlays the subject on itself', () => {
    expect(parseChartDirective('chart NVDA against SPY and QQQ', ['NVDA']).overlays).toEqual(['SPY', 'QQQ'])
  })

  it('does not mistake instruction words for tickers', () => {
    expect(parseOverlays('CHART IT WITH THE 50 DAY MOVING AVERAGE AND RSI')).toEqual([])
  })

  it('rejects nonsense periods rather than charting them', () => {
    expect(parseChartDirective('add a 9999 day moving average').indicators[0].period).toBe(50)
    expect(parseChartDirective('add a 1 day moving average').indicators[0].period).toBe(50)
  })

  it('degrades to the default view when nothing resolves', () => {
    for (const d of ['', undefined, 'make it look really compelling', 'do something clever']) {
      const got = parseChartDirective(d)
      expect(got.indicators).toEqual([])
      expect(got.overlays).toEqual([])
    }
  })

  it('detects an indexing instruction', () => {
    expect(parseChartDirective('index all names to 100 at the start of the lookback').indexed).toBe(true)
    expect(parseChartDirective('chart the price').indexed).toBe(false)
  })

  it('reads a rolling window, falling back when absent or absurd', () => {
    expect(parseWindow('use a 90 day rolling window against the benchmark')).toBe(90)
    expect(parseWindow('use a rolling window')).toBe(90)
    expect(parseWindow('use a 900 day window')).toBe(90)
    expect(parseWindow('use a 30 day window', 60)).toBe(30)
  })

  it('caps how much one directive can add', () => {
    const got = parseChartDirective('sma 10 sma 20 sma 30 sma 40 sma 50 sma 60 sma 70 rsi macd vwap')
    expect(got.indicators.length).toBeLessThanOrEqual(6)
  })
})
