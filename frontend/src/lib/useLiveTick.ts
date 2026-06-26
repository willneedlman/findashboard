import { useEffect } from 'react'
import type { RefObject } from 'react'
import type { ISeriesApi, Time } from 'lightweight-charts'

interface LiveCandle { time: Time | number | string; open: number; high: number; low: number; close: number }

const isCrypto = (t: string) => /-USD$/.test(t.toUpperCase())
// Binance.US public websocket (no key) for sub-second crypto. The browser connects
// directly, so geo is the user's, not the server's. Override with VITE_BINANCE_WS.
const BINANCE_WS = (import.meta as { env?: Record<string, string> }).env?.VITE_BINANCE_WS || 'wss://stream.binance.us:9443'

// Live price for the paper chart. The forming candle is refreshed between the
// slower full-candle fetches (/ohlcv, ~1/min).
//
// Two cadences, because calling series.update() faster than ~4s destabilises
// lightweight-charts on this chart (it spams "Value is null" and stops drawing):
//   - the visible price (onPrice -> header / spot) ticks at the data rate:
//     sub-second for crypto via the Binance websocket, 1s via REST, 4s otherwise;
//   - the candlestick body is updated on a safe 4s timer from the latest price.
// So crypto's number ticks live while the bar stays render-stable. Gated on
// `enabled` (market live).
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
    let latest: number | null = null

    const onTick = (p: number) => { if (p > 0) { latest = p; onPrice?.(p) } }

    // Candlestick body: update the forming bar at a render-safe rate.
    const updateCandle = () => {
      const last = latest
      const cs = candlesRef.current
      const series = candleRef.current
      if (last == null || !(last > 0) || !cs?.length || !series) return
      const b = cs[cs.length - 1]
      // Skip if the price is far from the last candle's close — candlesRef still
      // holds the previous symbol's data (a ticker switch mid-load).
      if (b.close > 0 && Math.abs(last - b.close) / b.close > 0.25) return
      try {
        series.update({ time: b.time as Time, open: b.open, high: Math.max(b.high, last), low: Math.min(b.low, last), close: last })
      } catch { /* time out of sync mid candle-reload; the next full fetch re-syncs */ }
    }
    const candleId = window.setInterval(updateCandle, 4000)

    // Price source: REST baseline (1s crypto / 4s otherwise) feeds the fast number.
    const poll = async () => {
      try {
        const r = await fetch(`/api/market/live-quote?ticker=${encodeURIComponent(ticker)}`)
        if (!alive || !r.ok) return
        const last = (await r.json()).last
        if (typeof last === 'number') onTick(last)
      } catch { /* transient; next tick retries */ }
    }
    const pollId = window.setInterval(poll, isCrypto(ticker) ? 1000 : 4000)
    poll()

    // Crypto: Binance websocket for sub-second number updates.
    let ws: WebSocket | null = null
    let wsClosed = false
    if (isCrypto(ticker)) {
      const pair = ticker.toUpperCase().slice(0, -4).toLowerCase() + 'usdt'   // BTC-USD -> btcusdt
      const connect = () => {
        if (wsClosed) return
        try {
          ws = new WebSocket(`${BINANCE_WS}/ws/${pair}@trade`)
          ws.onmessage = e => { try { const p = parseFloat(JSON.parse(e.data).p); if (p > 0) onTick(p) } catch { /* ignore */ } }
          ws.onclose = () => { if (!wsClosed) window.setTimeout(connect, 3000) }   // auto-reconnect
          ws.onerror = () => { try { ws?.close() } catch { /* ignore */ } }
        } catch { /* ws blocked — REST still updates the number */ }
      }
      connect()
    }

    return () => {
      alive = false
      window.clearInterval(candleId)
      window.clearInterval(pollId)
      wsClosed = true
      try { ws?.close() } catch { /* ignore */ }
    }
  }, [ticker, enabled]) // eslint-disable-line react-hooks/exhaustive-deps
}
