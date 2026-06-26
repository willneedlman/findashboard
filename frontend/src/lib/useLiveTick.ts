import { useEffect } from 'react'
import type { RefObject } from 'react'
import type { ISeriesApi, Time } from 'lightweight-charts'

interface LiveCandle { time: Time | number | string; open: number; high: number; low: number; close: number }

// Overlay a near-real-time Tradier price on the forming (last) candle so the paper
// chart ticks every few seconds, in between the slower full-candle refreshes
// (/ohlcv is yfinance-backed, ~1/min). Only the last bar is mutated in place via
// series.update(); the next full fetch re-syncs its high/low. Gated on `enabled`
// (market live) so it doesn't poll Tradier when nothing is trading.
export function useLiveTick(
  ticker: string,
  enabled: boolean,
  candleRef: RefObject<ISeriesApi<'Candlestick'> | null>,
  candlesRef: RefObject<LiveCandle[]>,
  onPrice?: (p: number) => void,
) {
  useEffect(() => {
    if (!enabled || !ticker) return
    let alive = true
    const poll = async () => {
      try {
        const r = await fetch(`/api/market/live-quote?ticker=${encodeURIComponent(ticker)}`)
        if (!alive || !r.ok) return
        const last = (await r.json()).last
        const cs = candlesRef.current
        const series = candleRef.current
        if (typeof last !== 'number' || !cs?.length || !series) return
        const b = cs[cs.length - 1]
        series.update({ time: b.time as Time, open: b.open, high: Math.max(b.high, last), low: Math.min(b.low, last), close: last })
        onPrice?.(last)
      } catch { /* transient; next tick retries */ }
    }
    const id = window.setInterval(poll, 4000)
    poll()
    return () => { alive = false; window.clearInterval(id) }
  }, [ticker, enabled]) // eslint-disable-line react-hooks/exhaustive-deps
}
